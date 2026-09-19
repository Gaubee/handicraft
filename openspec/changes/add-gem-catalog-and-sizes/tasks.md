<!--
Orthogonal intents (max 4):
1. [2026-09-19 Contract] [R2 终审 W0-GATE-ONLY 授权范围，与 design §0.1/§1.7 一致]：
     0.x（W0 v2 contract gate，零业务实现——任意 add-project-files 2.x serializer 开工前的硬前置，R2 P0-4）
       -> 1.x（engine gate，可整体并行于 2.3 之外的实现面；1.5 的 CVT 优化独占——性能敏感，不与其他引擎改动并行）
       -> 2.1 / 2.3 / 2.4（内置规格 seed 目录 / 四格式迁移完整实现 / 常量收编切换——三者可并行，均只消费冻结类型）
       -> 2.2（.gemshape 八面 vertical slice；硬前置 = 0.4 + add-project-files 1.1 AssetProject 实现可用，未落地则顺延）
       -> 3.x（收尾 gate：全量绿门 + 评审）
   约束：并行实现代理上限 2；全量 pnpm test/check/build 绿门串行执行；W0 验收 = R1 P0-1 修订后的 contract receipt（0.7，
   R2 P0-1 前两项验收分句 + P0-2 全文），行为测试分句在 1.7/3.2 最终合流门逐字引用收口。
2. [2026-09-19 Data] canonical 类型唯一化 = specKey 唯一持久身份；specId 持久化别名与二/三参 helper 并存
   在 W0 grep 清零；四格式 v2 迁移 fixture 全 vitest 证明（byte-round-trip/向前拒读/脏输入）。
3. [2026-09-19 Engine] 混合径 pairwise/exportGate/BOM 新键/SVG 逐钻 = engine gate；布局五策略不动（单 spec 输入）；
   CPU deterministic oracle 不动摇；CVT 优化输出逐位不变（不 bump）；GPU 不进 P0。
4. [2026-09-19 Process] 本 change 不做：图层化/专家工作台 UI/蓝图双任务/replay-handoff-export 层化消费（design §0.2）；
   两项工作默认待 Owner 批准可推翻（design §0.4）；每步绿门 pnpm test + svelte-check + build。
-->

## 0. W0 v2 contract gate（第一实现单元；类型 + typed error + 迁移入口 + fixture，零业务实现）

- [ ] 0.1 canonical 类型唯一化（单独提交）：`BaseSpec` / `GemSpecSnapshot{specKey,ordinal,shapeId,sizeLabel,diameterMm,widthMm?,heightMm?,assetId?,rotationDeg?}` / `PhysicalCanvas{widthMm,heightMm,anchorSource}` / `GemSpec`（内存条目）唯一类型模块；`GridSpec` v2 派生化（+`gapMm`、移除 `ss` 语义、`gridFromSpec` 新入口、`gridFromSs` 降位圆钻特例）；rotationDeg 非身份显式注释；vitest：类型编译 + 旧 GridSpec 消费者（buildBom `g.ss`、ProjectSummary.ss、stores/edit.svelte.ts:514 摘要构造——R1 裁断 4 补登）迁移清单登记
- [ ] 0.2 唯一几何 helper 冻结：`requiredCenterDistancePx(a: GemSpecSnapshot, b: GemSpecSnapshot, grid: GridSpec): number` + `maxCellPx(specs, grid)`（单位恒 px，mm→px 换算只在 helper 内；R2 §三-1 定案签名）；vitest：helper 契约测试（等径=pitch 等价、大小径包络、maxCellPx ≥ 任意对所需距离）+ 全库唯一调用面断言
- [ ] 0.3 四格式 v2 版本表 + 迁移入口：`PROJECTFILE_FORMAT_VERSIONS`/`LABFILE_FORMAT_VERSIONS` bump 至 2（projectFile.ts:51-56 / labFile.ts:37-41）；注册 v1→v2 迁移入口（纯函数，gemproj 单 rest 层 / gemdoc 补 round+查表直径 / gemtpl 补 drillParams/blueprint 正交键（缺席=两开关关——Owner 2026-09-20 裁决二，键形消费规范源=add-lab-drill-params-and-blueprint）+gemSpecIds / gemgen 拆 requestMode（endpoint）+drillParams/blueprint 正交快照+可选 blueprint/gemSpecs/physicalCanvas 键位）；LayerRecord 类型定义冻结（宿主实现归 studio-layers）；vitest：每格式 v1 fixture 迁移演练 + v2 save→load→save 字节等价 + 向前拒读 + 脏输入 typed error
- [ ] 0.4 `.gemshape` schema gate 六条（先于 renderer；出处 gemspec R1 P0-6）：parser 冻结——解码后实际宽高不符拒收 / MIME·字节·像素上限 / alpha bounds 非空（主径取 alpha bounds）/ fit 纵横比超容差拒绝 / reference 校准 refSpecId 可解析或内嵌 refSpecSnapshot / missing 资产 typed 禁静默降级导出；**texture 必备 + vectorPath 可选加速（R3 P0-1 修复冻结：vector-only 非法——typed error 拒收；并存导出优先矢量）**；`ProjectKind`+`PROJECT_MIME` 第五值；vitest：六条各一坏输入用例 + **fixture 矩阵（texture-only / both 两类合法输入 round-trip + vector-only 坏输入 typed error 拒收断言）** + 校准烘焙函数（direct/reference 两模式）
- [ ] 0.5 物理锚契约 + 常量单源出口：`pixelsPerMmFromCanvas(canvasWidthPx, canvas|undefined)` 签名冻结（锚定实际降采样 image.width；缺失/非法回退 2.5 且 `anchorSource:'default'` 显式；dimsMismatch 以实测为准）；engine 单一出口 `PIXELS_PER_MM` 常量定义（三处副本切换归 2.4）；vitest：px/mm 不变量（2048→1024 降采样、非正方形、缺失回退）
- [ ] 0.6 目录资产 schema 冻结 + 迁移 bootstrap 表（Owner 2026-09-20 裁决一）：`.gemshape` schema 增 `vectorPath?`（归一化 SVG path，单位框 0..1——可选渲染加速字段：贴图必备、vector-only 非法 typed error 拒收、并存导出优先 vectorPath——R3 P0-1）/`specKey?`（canonical 身份键——三处必填时点条件矩阵见 design §1.4：seed 必填如 round-ss10，v1 文件输入与 custom ingest 可缺席、按 custom-<assetId> 派生——R3 非阻塞 1）；seed 数据形状（形 id/短码/中文名/贴图必备+可选 vectorPath/物理宽高）+ P0 五形（round/square/drop/heart/marquise）+ 身份不可变纪律（specKey 创建后不可变、seed 只读、改物理=另存副本；**`.gemshape` 内容不可变——不参与 blobKey 换绑，任何内容变更=另存新资产（新 assetId/新 specKey）——R3 P0-2**）；engine 迁移 bootstrap 表（SS_TABLE 直径查表 + specKey 生成规则 round-ss10/square-3.5——非目录真源）；vitest：specKey 确定性 + path 归一化（单位框）+ seed 幂等 create-only（`ast-shape-${specKey}` 节点存在即跳过含软删）+ **texture-only/both 合法 fixture 与 vector-only 拒收断言（与 0.4 fixture 矩阵同源）**
- [ ] 0.7 **W0 contract receipt（R1 P0-1 修订：只验收契约面）**——① TypeScript 编译 + canonical 名称 grep（`specId` 身份字段/持久化别名清零；`refSpecId` 为独立校准引用字段、单独定义不计入禁令）；② helper 签名冻结（`requiredCenterDistancePx(a,b,grid)` 三参唯一 + `maxCellPx`，无二参/别名并存）；③ 四格式 v1 fixture 迁移演练 + v2 byte-round-trip + 向前拒读 + 脏输入 typed error；④ `.gemshape` 六条 gate 坏输入用例 + texture 必备/vector-only 拒收（0.4 fixture 矩阵）；⑤ PhysicalCanvas px/mm 不变量（**仅 schema/纯函数层，运行时接线不在 W0 验收面**）；⑥ serializer 首写证明：2.x 首个写入路径仅在 W0 receipt 通过后出现且不存在 v1 新写路径（写路径 grep）。R2 §四 P0-1 原文中「跨层 mixed-size/旋转/边界测试全部通过」依赖 engine/replay 实现——**移至 1.7 与最终合流门（3.2）收口，W0 不验收行为测试**；P0-2 验收原文（byte-round-trip/向前拒读/损坏·超限·悬空 ref 拒绝/missing 不得静默导出）与 gemspec R1 放行条件 1（「不接受只扩字段、不扩 `GridSpec`/handoff 的切片」）整条属本 receipt

## 1. engine gate（第二实现单元）

- [ ] 1.1 pairwise 实现：`requiredCenterDistancePx`/`maxCellPx` 落地；`SpatialIndex` cell 从 pitch → maxCellPx（ops.ts:199 / spatialIndex.ts:15-16 消费面）；vitest：恰跨 cell 边界邻域检索不漏
- [ ] 1.2 校验/冲突混合径化：`validate`（validate.ts:17-40）/`validateEditable`（edit.ts:53-76）/`resolveConflicts→resolveGreedy`（edit.ts:130-137 / conflict.ts:27-45）单一 pitch → 逐对 helper；布局五策略/relax 输入仍单 spec（产物入文档强制 pairwise gate）；`exportGate` 纯函数（SVG/BOM/PNG/送精修共同前置；保存 warning、导出硬阻断）；vitest：大小径混合/边界 gap/旋转异形圆包络不变性/20k 钻/违规清单确定性排序
- [ ] 1.3 导出升级：`buildSvg` 逐钻规格渲染（round circle 快路径保留、异形 path 缩放、自定义 `<image>`；`gemRadiusPx(grid)`→`gemRadiusPx(gem, grid)`，grid.ts:46-48）；`buildBom` 聚合键 `colorId` → `specKey×colorId`，表头 `规格,形状,尺寸,色名,hex,数量`（export.ts:89-103 改造）；vitest：三渲染路径 golden + BOM 新键（同规格不同自定义资产 assetId 区分行 + 合计行）
- [ ] 1.4 `Gem`/`EditGem` 字段落地：shapeId/diameterMm/rotationDeg?/assetId?（types.ts:68-91）+ zod 公共契约面同步 + `EditGemFields` 白名单扩展（rhinestone-studio/src/lib/stores/edit.svelte.ts:126，x/y/colorId → +shapeId/diameterMm/rotationDeg）；vitest：round-trip + v1 缺省补 round
- [ ] 1.5 CPU oracle + CVT 性能 P0（独占切片，不与其他引擎改动并行）：同参快照确定性断言；CPU CVT 优化（repairSpacing 轮数/早停、像素累加降采样/增量 Delaunay、medianColor 计数化）目标 43s→<10s @1024² **输出逐位不变**（gpu-research.md §7 P0-1 基线 43.1s）；vitest：优化前后同参快照逐位相等 + 计时基准（阈值 <10s）
- [ ] 1.6 `ENGINE_VERSION` 1→2（validate/conflict/export 语义变更；version.ts:16）：gemproj 序列化自动携带新值 + 重放漂移横幅语义核对；护栏：单规格圆钻文档 v1/v2 引擎钻位逐位不变对比测试
- [ ] 1.7 **engine gate 验收（出处标注）**——R2 §四 P0-3（engine 部分）：「engine gate 完成逐钻 spec、pairwise/exportGate……多层导出包含隐藏层且违规硬阻断；BOM 使用 `specKey×colorId`」（多层导出接线归 studio-layers，判据/门在本切片证明）；R2 §一 P0-2：「统一签名、单位和 `maxCellPx` 公式；实现全层 concat 的 pairwise、保存 warning/导出 hard block；补大小径、跨 cell、边界 gap、旋转、20k 测试」；**R2 §四 P0-1 行为分句（R1 P0-1 移入）：「跨层 mixed-size/旋转/边界测试全部通过」在本切片收口**（单层行为测试 + 判据证明；跨层 concat 组织与 replay 联合验收归 replay/handoff gate）；gpu-research §7 P0-1：43s→<10s 零输出变化

## 2. 目录与资产化实现（第三波）

- [ ] 2.1 内置规格 seed 落地：sys-shapes 下按 `ast-shape-${specKey}` 幂等 seed（P0 五形 round/square/drop/heart/marquise × 圆形 SS 档 / 异形 mm 档，含贴图（必备）+ 可选 vectorPath 数据 + 物理宽高——裁决一与 R3 P0-1 口径，目录真源为素材库资产、engine 仅留迁移 bootstrap，见 design §1.6/§3.1）；**SS24 补档 = 新增一条 seed 条目**（SS_KEYS 现缺，types.ts:12-25；同参同出不 bump，随 ENGINE_VERSION 纪律注释登记，R2 非阻塞建议）；vitest：seed 幂等（含软删跳过）+ 目录枚举确定性 + SS24≈5.3mm 入 seed + 既有档位数值零变化
- [ ] 2.2 `.gemshape` 八面 vertical slice（硬前置 0.4 + add-project-files 1.1；gemspec R1 议题 10「一次性冻结」）：projectTypes 第五值 / AssetNode 接线（**内容不可变——同 gemgen 纪律，不参与 blobKey 换绑（R3 P0-2）；编辑=另存自定义副本，节点改名等元数据可改**）/ App 导入路由（ingest→素材库定位）/ sys-shapes 系统目录 seed（插「模板」与「生成结果」之间）/ RightSheet 编辑器（去使用·去编辑两 canonical handler；**编辑器=查看+另存副本入口，无就地改内容（design §3.2 面 5）**；seed 资产只读，编辑=另存为自定义——design §1.6 身份纪律）/ serialize-parse + 迁移 / 引用 pin-GC 矩阵（弱引用 missing 四态 + 编辑期 pin 校准参考 + 硬清走既有 GC + 删除后 missing typed + 导出阻断）/ 校准向导数据面；vitest：seed 幂等 / ingest+另存副本（内容不可变——断言无 blobKey 换绑入口/换绑路径为零） / missing 四态 / 导出阻断（gate 6 端到端）
- [ ] 2.3 四格式 v1→v2 迁移完整实现：迁移链填充（复用注册骨架 projectFile.ts:113-128 / labFile.ts:106-121）+ 全量 round-trip 家族（含 gemproj overrides 块键搬运 / gemdoc m- 前缀手工钻 / gemgen provenance.mode 旧档只读映射）；vitest：五格式（含 .gemshape v1 起步）byte-round-trip 矩阵 + 迁移链断环拒绝
- [ ] 2.4 常量收编切换：三处 `PIXELS_PER_MM` 副本（studio.svelte.ts:56 / gemprojReplay.ts:41 / quickLayout.ts:65）→ import engine 单一出口；quickLayout 显式 default 标注；vitest：常量单源断言（三消费方同值）+ 行为零变化（同参快照）

## 3. 收尾 gate

- [ ] 3.1 全量绿门：`pnpm test`/`pnpm check`/`pnpm build` 全绿；既有基线债处置——~~`gemgenArchive.test.ts` 终态持久化竞态~~ **已于 2026-09-19 修复（c930a01：whenIdle 排干归档链，archiveDepth 计数器；solo 8/8 + 兄弟 33 绿）**；R2 §四 P0-5 验收「66/66 files、864/864 tests」的全量 receipt 仍欠，留低负载窗口补跑后在此登记
- [ ] 3.2 Codex 评审 → 修订 → 归档候选；**最终合流门（R1 P0-1）：逐字引用 R2 §四 P0-1 全文收口**——「验收：TypeScript 编译、全库 grep 只有 canonical 名称、跨层 mixed-size/旋转/边界测试全部通过」（前两项验收分句=W0 receipt、第三项验收分句=engine gate 1.7 + replay 联合），与 R2 §四 P0-2 验收原文、gemspec R1 放行条件 1 一并逐条复核 + 消费面矩阵（studio-layers §E.6）中本 change 责任行的测试符号核对
