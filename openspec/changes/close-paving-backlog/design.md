# Design：排钻算法清账

> R1 评审修订版。P0-1（star 现状失实→原位升级）/P0-2（物料身份门）/P1-1（门混径化）/
> P1-3（workbench 透传）/P1-4（lumaB64+核替换）/P1-5（specs delta+锚点仓内化）全落。

## 0. 缺口→方案映射总览（仓内可验证承接记录）

| Owner 提法 | 方案 | 形态 |
|---|---|---|
| D8 星射四参数+F1 凹形截断 | T1 geometry star 原位升级 | 既有变体增强（不开新族） |
| B6/E2/F4 多尺寸混排 | T2 `gapFill` 执行层模式 | 正交叠加（指派字段+补隙趟+门/物料双改造） |
| C1/C2 沿路径+B3 边框 | T3 `along-path` 策略 | 新策略族（**第八值**），outline 模式承接边框 |
| F2 直线取向场 | T4 straight_line 布点核替换 | 既有策略增强 |
| D17 钻形搭配 | T5 design prompt 指引表 | prompt/文档面 |
| B5 高光贴 | texture-fill `polarity=bright-dense` | **已覆盖**（映射承接） |
| D10 OpenCV | sandbox `geo.*` 帮助库 | **已覆盖**（Owner 裁决形态） |
| D12 艺术家风格 | styleId 接口位已预留 | Owner 明示「后话」不欠 |

## 1. T1 geometry star 原位升级

**现状（R1 纠偏后的真实现状）**：geometry.ts:314-331 star 变体=从 innerRadius 沿每条射线以间距 s 步进布钻到 **rMax（统一）**+掩膜过滤；参数 rays/innerRadiusRatio/rotationDeg；圆心=掩膜质心；稀疏度=density 推导。design prompt 已暴露（design.ts:313-317）。

四项增量（Owner 四参数补全+F1 改进落案）：

1. **r(θ) 边界调制**：逐角 bin 掩膜最大半径+循环平滑（**径向签名独立导出件**——从 flower.ts:58 `radialSignatureAndPetals` 提为模块级共享导出，circularSmooth 随迁；**不进 GeometryHelpers 注入面**（避免沙箱 geo.* API 扩容）；flower 改引共享件，其 :211-233 扇区二次消费的返回形状**不变**——行为零变更绿门）。射线步进上界=min(r(θ_射线)×0.98, rMax)——凹口射线收短，**不再穿出再穿入布岛点**。
2. **rays 缺省峰数自动检测**：径向签名去均值峰数=星角数（同 flower petals 检测先例）；显式 rays 覆写仍优先。
3. **centerOffsetPx?: {x,y}**：圆心=质心+偏移（LLM/用户微调面）；**质心落掩码外退路=最大内切圆心近似（新写**——粗网格采样掩膜内点取最大清亮半径者，O(grid) 工程近似；geometry helpers 现无此函数，R1 纠偏）。
4. **sparseness: float [0.2,5] default 1**：沿射线步长=characteristicSpacingPx×sparseness（显式倍数，与 density 通道正交——density 推导 s 基准不变）。

星心钻（<s 区一枚圆钻）与可读下限守卫**沿用现状**（MIN_READABLE_GEMS=3 全族统一——geometry.ts:260；旧值 24 已 2026-10-01 走查 P1 废止，**勿在断言里复活 24**）。角度=放射向内联（compassRotationDeg 同式——**无注册表可接**，R1-P2-7 纠偏：各策略内联选方向是现状）。

## 2. T2 多尺寸混排（gapFill 执行层模式）

**为何非新策略族**：「打底+补隙」可叠加到任意铺法——包装成族会 7×混排组合爆炸；执行层正交让任意策略打底天然成立。

### 2.1 契约（contracts）
```ts
gapFill?: {
  stoneRef: string;     // 补隙钻引用——必须同时列入该节点 stones（见 2.4）
  minGapRatio: number;  // [1.0,3.0] default 1.0
}
```
- superRefine 增规则：gapFill 与 exclusion（不产钻）/free-code（沙箱自管钻）组合=typed 拒；gapFill.stoneRef 必须 ∈ stones[].resourceId。
- 旧数据兼容：strict object 可选键——无新键 parse 恒过（读回面 design.ts:1171 防御性终验无炸点）。

### 2.2 执行（design.ts 执行段，base 趟产钻后）
1. fill 径 d_f=**assignment.stones 内查** gapFill.stoneRef（查无=superRefine 已拒，执行段防御再拒）；base 径不动（nodeDiameterMmOf 取 max——fill 小钻入 stones 不影响 base 径）。
2. 候选=block 掩码内网格（步长 d_f×1.2）；逐候选对**本节点全部已有钻**（base+已放 fill）判中心距（px）≥ `gateRequiredPairPx(d_i, d_f, ppm)×minGapRatio`——**单源引 sandbox/gate.ts 门公式**（=((a+b)/2+gap)×ppm×0.999、mm 入 px 出、EXPORT_GATE_GRID_GAP_MM=0——minGapRatio=1 缺省时与导出门**逐位同式**，ratio 为线性收紧因子）。O(n×m) 网格分桶降 O(n+m)（数百钻级工程必要）。
3. fill 钻角度=最近 base 钻角度；diameterMm=d_f 落 KernelGem（逐钻直径字段本有）。
4. **节点内校验门混径化（R1-P1-1，咽喉）**：design.ts:1307-1311 `validateGemPlacement(gems, {minPx: gateRequiredPairPx(d_b,d_b,ppm)})` 单径标量门会系统性误剔 fill 钻——改造为 **per-pair 模式**（门=gateRequiredPairPx(q.diameterMm, g.diameterMm, ppm)，keep-earlier 剔除语义不变）。跨节点门 `validateCrossNodeGemSpacing`（gate.ts:137）**已逐对混径**不受影响（补隙钻与邻节点重叠走既有剔除+warning=已知取舍注记：补隙趟判距只对本节点，跨节点由该门兜底）。
5. 密度语义：gapFill 不吃 densityPerCm2（base 已消费）；补隙量由几何空隙自然决定（「能塞多少塞多少」=Owner「补隙」原语义）。

### 2.3 物料身份门（R1-P0-2，不做此件混排死在导出层）
现状 task-layout.ts:105-123 `materialIdentityOf`：stones 恰 1→取之；≥2→按 gem.colorId↔pick.colorHex 匹配——内核 colorId 恒 ''（registry.ts:52 冻结）→恒零命中→ambiguous→**节点 gems 全拒收**（不进 task-layout=无导出/无 BOM/无渲染）。
**规则改造**：stones ≥2 且 gem.colorId 为空时，**按 gem.diameterMm↔stone sizeMm 唯一匹配**（|Δ|≤0.05mm 容差；唯一命中=取之；零命中或多义=拒如旧）。单 stones 路径不动。BOM 分组（task-export.ts:331 按 stoneRef×diameterMm）在此门修通后自动双行。

### 2.4 workbench 直改透传（R1-P1-3）
workbench.ts:624-632 直改路径重建 assignment 是**白名单构造**（无 gapFill）——用户微调一次密度 gapFill 无声消失。**透传保留**（先例=旁边 stoneIdx 继承 :608-616）：白名单补 gapFill 字段透传。

### 2.5 design prompt
指派说明补：「节点可携 gapFill 混排（客户 3mm+10mm 场景——大钻打底后小钻补隙）；补隙钻须同时列入该节点 stones 候选」。

## 3. T3 along-path（沿路径策略，唯一新枚举）

- **参数**：`pathSource: 'outline'|'custom'`（缺省 outline）；`outlineInsetPx?`（缺省 0.5×钻径——边框钻心不压边）；`pathPts?`（custom 必填，画布坐标折线）；`spacing?`（缺省=characteristicSpacingPx）；`closed?`（缺省 false；outline 恒 true）；`fallbackEngineStrategy`（registry 先例缺省位）。
- **布点**：**等弧长重采样直接消费 `ctx.geometry.resampleOpen/resampleClosed`（geometry.ts:96-128 既有共享件，沙箱同面）**——soft_curve 内嵌等弧长与骨架分支耦合（soft_curve.ts:334-366），**不提取不动**（R1-P2-1）。重采样后步进布点+掩码过滤+`enforceMinSpacing(gemDiameterPx×0.999)`（四策略同式单源先例）+首尾钻守卫（≥2=MIN_READABLE_GEMS 同款）。
- **outline 边界提取**：掩码最大连通域外边界游走（moore 邻域——geometry helpers 增 `boundaryTrace`）；内缩=边界点沿内向法线平移 inset（简化实现，自交由判距门吸收+warning 留痕）。
- **角度**：路径切线内联（soft_curve 切线先例同式）。
- **B3 承接**：边框花环=along-path(outline)+框内 flower/几何组合即达（映射表 §0）。

## 4. T4 直线取向场（straight_line 布点核替换）

**R1-P1-4 纠偏：这不是扩参级改造，是布点核替换**——现状=straight_line.ts:118-153 全局 PCA 平行线扫描；gradient-field=**seed+方向场步进延伸弯曲折线族**。

- 参数：`orientation: 'global-pca'（缺省，现状逐位不变）| 'gradient-field'`；`lineSpacingMm?`（弯曲模式法向分离间距——缺省=characteristicSpacingPx 对应 mm；平行线的轴向间距语义在弯曲模式不复用）；**`lumaB64?`**（亮度注入通道——texture_fill.ts:18-21 同款；**无 luma 退化为掩膜形状流**，张量场=模糊掩膜梯度——「曲面贴合」原始诉求依赖真实纹理，luma 缺席时 warning 提示降级语义）。
- **张量计算共享**：texture_fill `orientationField`（:203-299）已导出解耦（签名吃 TextureFillParams 但只用 lumaB64——改签名仅一处调用点 :791）——**提取共享件**（params 窄化为显式入参）；提取成本高则独立镜像同口径（两处 O(w×h) 张量标注互为镜像）。
- **线族延伸**：独立 RK 步进追踪（texture flow 的全域流线 BFS 语义不同——R1-P2-3；不共享追踪器）。种子=法向等距线排布，逐点沿局部主方向步进，曲率突变断线。
- 判距/掩码/角度（切线=局部取向）照既有。

## 5. T5 钻形搭配指引（design prompt）

指引表（**只含 Owner 原话出处规则**）：

| 铺法/部位 | 搭配 | 出处 |
|---|---|---|
| 花瓣区 | drop 泪滴形（径向对齐——花角度函数已备） | owner-directive L84 |
| 花心 | round 圆钻、径大于花瓣钻 | owner-directive L84 |
| 其余 | 候选集按形状语义就近，无硬规则 | —— |

落点：design.ts stones 候选集段+knowledge-base 文档；不改 schema（StonePick 已带 shape/diameter）。验收=设计冒烟花形节点指派搭配倾向判读。

## 6. 风险与边界

| 风险 | 处置 |
|---|---|
| KernelStrategyKind 八值扩容的运行时漏 | daemon REGISTRY/STRATEGY_FAMILY_GUIDES=Record（tsc 兜）；studio **STRATEGY_KIND_ORDER 是普通数组无类型完备性**（paramsSchema.ts:225——两处下拉数据源 TaskWorkbenchView:418/WorkbenchInspector:87）——**点名必改**+workbench.v4-strategy-defaults.test.ts 七值断言同步；WorkbenchInspector REGULAR_FAMILY 推荐组硬编码不含新值=下拉仍在只是不进推荐组，首版注记 |
| gapFill 大图 O(n×m) | 网格分桶；容量门既有 typed 拒 |
| 物料混径匹配的 sizeMm 数据质量 | mofang sizeMm 数据治理是更早挂账——容差 0.05mm+多义拒（不猜）；数据治理另案 |
| 边界追踪/内缩自交（T3） | 简化内缩+判距门吸收+warning 留痕 |
| star 升级动 flower 共享件 | flower 既有测试逐位绿门；radialSignatureAndPetals 返回形状不变 |
| orientationField 提取动 texture_fill | 既有测试逐位绿门；提取失败回退独立镜像 |
| 新策略 LLM 不指派 | design prompt 策略清单同步八值+适用面一句（清单面既有） |

## 7. 明确不做（台账存疑项裁定）

- 旧前端手动编辑线 P1/P2 其余件（套索/魔棒/颜色分组视图/从零创作/对称/模板库/笔刷流量）——旧线功能，当前主线=Agent+两层编辑；如 Owner 要另立 change。
- 艺术家风格多版本（D12「后话」）、方格网格（实证裁定六方）、Python 沙箱（已裁决 JS）、多色空间一致性（Owner「不是很理解」非承诺）。
