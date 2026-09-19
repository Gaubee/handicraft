# CVT 点画路径 CPU 优化研发报告（gem-catalog 切片 1.5 研发前置）

日期：2026-09-20（研发代理执行，主会话归档）
环境：本机 Node 24；实验代码与快照在 /tmp/cvt-rd/（复现命令见文末）；仓库 src/ 零改动。
参考实现：同目录 `cvt-opt-reference.ts`（路线 a，flags 可开关）。

## 1. 基线与热点（1024²，SS10@2.5px/mm，pitch 8px，k=8，seed=1，density=1）

合成四类图（high=828 块数字油画式高细节 / low=5 块大平坦 / solid=单块 / motif=白底悬浮图形）。基线取同进程 round-robin min（机器有后台负载，单次 wall-clock 波动 ±40%）：

| 1024² | layout(cvt) 基线 | gems | 主热点 |
|---|---|---|---|
| high | 15.3–25.4 s（安静 min 15.3s；冷跑 25.4s） | 17,384 | repairSpacing |
| low | 16.0 s | 17,429 | repairSpacing |
| motif | 13.2 s | 17,429 | repairSpacing |
| solid | 3.6 s | 17,428 | 像素累加 |
| high + relax 双钩子 | 17.5 s | 9,315 | repairSpacing |

插桩分段占比（插桩副本与引擎原版 JSON.stringify 逐位相等）：

| 分段 | high (19.9s) | low (18.3s) | solid (6.0s) |
|---|---|---|---|
| **repairSpacing（Lloyd 内 5 次 + 终局 1 次）** | **15.53 s (78%)** | **14.27 s (78%)** | 2.22 s (37%) |
| — 其中 pairs() SpatialIndex 重建 | 15.02 s | 14.06 s | 2.21 s |
| — 其中 Gauss-Seidel 解算 | 0.51 s | 0.21 s | 0.02 s |
| 像素累加（50 轮 × 105 万 px del.find） | 2.80 s (14%) | 2.87 s (16%) | 2.87 s (48%) |
| Delaunay 重建 / 质心循环 | 0.46 / 0.48 s | 0.57 / 0.55 s | 0.41 / 0.40 s |

**对 gpu-research 假设的修正**：repairSpacing 确认是热点，但机制不同——不是「轮数太多可早停」，而是**每轮全量重建 Map 版 SpatialIndex 的常数成本**（约 1500 轮 × ~10ms/轮 @17.4k 站点；解算本身仅占 repair 的 3-4%）。6 次 repair 调用中 5-6 次打满 250 轮上限且每轮 movedWrites>0（high 全程 883 万次写、440 万对）——真实迭代过程，非定点空转。像素累加是第二热点；**medianColor 不在 CVT 路径**（属 segment，全流程 0.5s 中的 24.6%）。

## 2. 三条路线 A/B（逐位验证 = JSON.stringify(全量 Gems) 与引擎 layout() 输出比对）

| 路线 | 变体 | 1024² 实测（min） | 逐位相等 | 加速比 |
|---|---|---|---|---|
| **a. 同序定容网格 + 扁平 pair 缓冲**（推荐） | repairSpacing.pairs() 与 applyRepulsion.violatingPairs 的 Map+spread 索引 → 两遍计数 Int32 网格（cell 同为 pitch、3×3 同扫描序、桶内同插入序、pair 追加序 = 原列表序 → Gauss-Seidel 顺序不变） | high 15.3→5.26 s；low 16.0→5.37；motif 13.2→4.80；solid 3.6→2.96；high+relax 17.5→6.97 | ✅ 全部 BIT-IDENTICAL（快照 1.4–1.5MB，含 512² 共 12+ 组合） | **2.90–3.2×**（relax 组合 4.30×）；repair 相位单独 4.9–5.2×，repulsion 4.4× |
| a'. 轮数复诊（早停/跳轮） | 每轮零位移即 break | — | ❌ 概念性否决：noMoveRounds=0，每轮真实位移，输出是轮数函数，跳轮必改输出 | 不可用 |
| b. medianColor 计数化 | Map<值,计数> 排序定位中位（偶数长度保持 (v1+v2)/2 表达式） | segment 494→376 ms | ✅ Block[] BIT-IDENTICAL | segment 1.32×；对 CVT 目标收益≈0（不在路径上） |
| c1. 像素表 pixelList+densMap | 掩码像素光栅序 Int32 表 + Float64 密度表 | high 20.99→19.06 s（更慢） | ✅ BIT-IDENTICAL | **0.88–1.02×（负收益）** |
| c2. inlineFind（d3 find 逐语句内联） | 单态化 typed 数组 + v*v 替代 Math.pow | 微基准 104 vs 107 ms | ✅ BIT-IDENTICAL | ~1.0×（无收益） |
| c'. Math.hypot→sqrt(dx²+dy²) | — | — | ❌ 24M 样本 9M 处 ULP 差异，一票否决 | 不可用 |

c1 负收益原因：segment() 给每个像素分配聚类标签（白背景也是块），labelMap 覆盖率恒 1.0，跳过分支永不触发；只有用户删除背景块后可能受益，默认管线无意义。

## 3. 推荐方案与达标预估

**推荐：仅路线 a**。生产落地约 ±120 行，集中在 cvt.ts / relax.ts 两个函数内部，算法语义、轮数、解算顺序零变化，不 bump ENGINE_VERSION。参考实现 `cvt-opt-reference.ts`。

- 本机 1024² 四类图 + relax 最坏情形：**4.8–7.0 s，全部 <10 s**，快照逐位相等。
- 对 gpu-research 43.1 s 基线的预估：其测量与本机冷跑（25.4s）同量级、约为安静基线 2×（负载/冷启动）。结构外推：43 s 中 repair 占 ~78% → 优化后 43×(0.22+0.78/5.2)≈**16 s**（若 43 s 为安静可复现值）；按本机安静基线同构折算（21–25 s）→ **5.3–6.6 s**。**落地时用调研稿原始合成图复测一次**；若确需再压，残余空间在 repair 解算循环（cur 转 Float64Array、labelAt 查表化，预估再省 10-20%）——像素累加层（2.1-2.5 s 地板）在逐位约束下已冻结（find 调用序列与浮点累加次序不可动）。

## 4. 负结果清单（逐位相等约束下的死路，均有数据）

1. repair 轮数早停/跳轮：每轮真实位移，输出=轮数函数。
2. pixelList/densMap：labelMap 覆盖率恒 1.0，0.88–1.02×。
3. inlineFind：d3-delaunay find 在 V8 已近最优，持平。
4. hypot→sqrt：9M/24M ULP 差异。
5. medianColor 计数化：可行且逐位安全（1.32×），但不在 CVT 路径；segment 真正热点是 Felzenszwalb DT（40.7%）。
6. 降采样/增量 Delaunay/像素归属替换：任何改动像素归属或累加次序即破坏浮点逐位相等，结构上必然否决。

## 5. 复现（/tmp/cvt-rd/，Node 24 原生 type-stripping + 自写扩展名 resolver）

```bash
cd /tmp/cvt-rd   # node_modules → rhinestone-studio/node_modules（symlink 已建）
node --import ./register.mjs bench/baseline.ts high 1024 1   # 基线+快照落盘 out/
node --import ./register.mjs bench/instr.ts high 1024        # 分段耗时+逐位比对
node --import ./register.mjs bench/ab2.ts high 1024 1        # 全变体 A/B（RELAX=1 开钩子）
node --import ./register.mjs bench/seg-ab.ts high 1024       # 路线 b
node --import ./register.mjs bench/relax-split.ts high 1024  # relax 各钩子分段
```

关键文件：variants/cvt-opt.ts（推荐方案，本报告同目录有拷贝）、variants/cvt-instr.ts（插桩）、out/baseline-*.json（逐位快照）。
