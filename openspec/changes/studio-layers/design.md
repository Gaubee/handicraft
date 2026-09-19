# Design: 排钻设计页图层化重构（③ replay/handoff gate + ④ studio gate）

> 规范性来源（冲突时按序以先者为准）：
> - Owner 需求原文（2026-09-19 十二列点，逐字见 `.agents/documents/2026-09-19-studio-layers/studio-layers.md` §0.1——本文一切裁决与其冲突处以原文为准并显式标注）
> - 同文件设计稿 **v1.1**（两轮评审处置完毕：R1 4.9 十六裁决 + P0-1~8 全落档；R2 合流终审 `CONDITIONAL GO / W0-GATE-ONLY`，图层稿 6.4/10——§A~§I 为本 change 的第一规范性来源，本文只做 change 层的切片化与现状对齐，不重复论证已裁决事项）
> - `codex-review-r2.md` §四 P0-3/P0-6（本方责任）、§三-1/3/4（签名/宿主/责任归属定案）
> - 已落库契约：`openspec/changes/add-gem-catalog-and-sizes/{design,tasks}.md`（W0 receipt = rhinestone-studio `d37b2a4→7790b69`；engine gate receipt = `7f162d3→23bd262`，逐切片 `7f162d3`/`d2e66b0`/`2fddfcd`/`065890b`/`c0fa5cc`/`23bd262`）
> - `openspec/changes/rename-and-expert-workbench/design.md` §2.2 文件级 ownership 交接表（handoff/gemdoc payload 符号 owner = 本 change replay/handoff gate）；`openspec/changes/add-project-files/design.md` §3/§10（2.1–2.5 移交输入 + 五段门序）
>
> 所有「现状」断言带 `源码文件:行号`（2026-09-20 源码树实测，A 轨拆分后的当前形态）。本 change 不宣称任何未实现内容为已完成。

## 0. 定位与门序

### 0.1 五段合流门序中的位置

```
① v2 contract gate（add-gem-catalog W0，已落库 d37b2a4→7790b69）
② engine gate（add-gem-catalog 1.x，已落库 7f162d3→23bd262；ENGINE_VERSION=2）
③ replay/handoff gate（本 change §1）     ← 本 change 第一实现单元
④ studio gate（本 change §2）             ← 本 change 第二实现单元
⑤ add-project-files 归档同步（原 change 收尾；本 change 只做依赖边就绪通知）
```

R2 §六：③④段完成前不得宣称两稿闭合；③段解锁 rename-and-expert-workbench 5.7/5.9，④段的 StudioOp 全集解锁 add-project-files 2.6 收口。

### 0.2 显式不做（其他 change 所有 / 显式降级）

| 不做项 | 归属/状态 |
|---|---|
| canonical 类型（BaseSpec/GemSpecSnapshot/PhysicalCanvas/LayerRecord）、四格式 v2 迁移链、`requiredCenterDistancePx`/`maxCellPx`/`exportGate` 判据与门 | ①②段已落库——**本 change 只消费不重定义**（引用上方提交号） |
| gem-catalog 2.x 资产化收尾（2.2 .gemshape 八面 vertical slice / 2.3 迁移链完整实现 / 2.4 常量收编切换；2.1 seed 已见 `4e03ed6`） | add-gem-catalog-and-sizes |
| add-project-files 2.6（守卫三分法实现）/ 2.7（App 全局导入） | 留守原 change——本 change 交付其依赖（§0.3） |
| rename-and-expert-workbench 5.9（handoff/gemdoc payload v2 消费**接线**） | 该 change D 轨——硬前置 = 本 change ③段验收完成（payload 首个修改点在本 change） |
| GPU 计算路径 | **不进 P0**（§2.9；capability-labeled P1 试点待 Owner 立项，CPU 恒 oracle——engine gate 已定） |
| 自由绘制区/掩码成员类型、画布距离场容差命中、策略对比视图、跨层混合径布局算法 | P1/P2（图层稿 §A.1 反证备案、§B.6 P1 硬门、§C.5、姊妹稿 §G-4） |

### 0.3 跨 change 依赖规则（硬前置写死）

1. **对上（消费）**：一切层计算/校验/序列化消费 ①②段产物——`LayerRecord`（`persistence/projectFile.ts:232`）、gemproj v2 parser（`:1048/:1059`，含分区不变量拒绝面：零/多 rest、跨层重复块拒收）、`gridFromSpec`（`engine/grid.ts:53`）、`requiredCenterDistancePx`/`maxCellPx`（`engine/geometry.ts:52/:66`）、`exportGate`（`engine/exportGate.ts:93`）、`pixelsPerMmFromCanvas`（`engine/spec.ts:234`）、逐钻规格物化字段（Gem 必含 `shapeId/diameterMm`，engine gate 1.4）。
2. **对下（解锁）**：
   - **add-project-files 2.6**：其 dirty 触发全集 = 本 change **StudioOp 全集**（§2.2 八类 op 落地后 2.6 可收口——其 tasks.md 2.6 行显式登记「不得以 v1 参数集为终态口径」）。本 change 交付 `isStudioDirty()` 读取器（§2.8）。
   - **add-project-files 2.7**：其 gemproj 路由的端到端消费者 = 本 change 打开重放链路（§2.8）；导入 parse 面已就绪（W0）。
   - **rename-and-expert-workbench 5.7/5.9**：PhysicalCanvas 贯通 EditDocument（§1.4）后 5.7 读数可接真值；③段验收后 5.9 可在 `editHandoff.svelte.ts`/`gemdocLifecycle.svelte.ts` 做 payload 首个后续修改（此前 A 轨只维护薄 wrapper——其 design §2.2 交接表）。
3. **payload 修改权接管声明**：`ManualEditHandoff`（`stores/edit.svelte.ts:46`）、`buildManualEditHandoff`（`studio/editHandoff.svelte.ts:43`）、`loadFromHandoff`（`edit/gemdocLifecycle.svelte.ts:102`）、`EditDocument`（`edit.svelte.ts:79`）的唯一修改 owner 自本 change ③段起 = studio-layers；接管动作 = 薄 wrapper 换真（§1.4），消费接线仍留 expert 5.9。

### 0.4 文件交叠排序（与在途 change 的并行纪律；并行代理上限 2）

| 交叠文件 | 他方切片 | 本方切片 | 排序规则 |
|---|---|---|---|
| `persistence/projectFile.ts` | gem-catalog 2.3（迁移链完整实现/round-trip 家族） | §1.5 删 `deriveLegacyGemprojView`（:916-935）v1 读面 | **同一文件写入型全局串行**：2.3 先行则本方 rebase 其上；本方先行则 2.3 顺延——任一顺序下「读面删除」必须在 §1.5 replay v2 验收同切片内完成（W0 偏离登记的既定收口条件） |
| `services/gemCatalogService.ts`（接口）+ sys-shapes 目录 | expert 5.3（规格选择器）/5.6（真源切换） | §2.4 层配置卡规格 Select | 本方**只消费接口不建目录**：数据源恒经 `GemCatalogService`（真源状态随 expert 5.6：mock 或 sys-shapes，对本方透明）；禁止 studio 侧第二目录真源 |
| `persistence/labFile.ts` / AssetsView 导入路由 | gem-catalog 2.2（第五格式 vertical slice）、add-project-files 2.7 | 零直接交叠 | 仅登记：本方打开链路消费四格式 v2 parser，不触 labFile/导入路由 |
| `stores/edit.svelte.ts` / `edit/gemdocLifecycle.svelte.ts` | expert D 轨 5.1-5.8（在途，落点 components/Edit/* 与 services/*） | §1.4 payload 扩字段（edit 根类型 + gemdocLifecycle 装配） | 无文件冲突（D 轨在途产物不触这两文件的 payload 域）；本方改动前核对 expert A 轨 2.6「无 payload 第二修改点」收据仍成立（改动后唯一修改点即本方 §1.4） |
| `components/Studio/*`（含 gemPaint） | 无他方切片（expert 组件轨在 components/Edit/*） | §2.6/§2.7 全域 | 本方独占；`gemPaint.ts:32` `gemRadiusPx(grid)` 过渡重载迁移归本方（engine gate 1.3 偏离登记既定） |

### 0.5 两项工作默认（Owner 未正式拍板，待 Owner 批准可推翻）

1. **观察态 = 纯会话态**：层可见性/层与块选择/背景源与透明度/历史栈不入 .gemproj、不入历史；打开工程恢复默认观察态（全部层可见、背景默认源/50%）并单次提示「不恢复上次观察布局」；.gemdoc 烘焙文档仍记录最终显示层（四层文档态，`projectFile.ts:809` 既有语义不动）；TERMS/PRODUCT_MODEL 分词「层参数 vs 画幅物理锚」（§3）。推翻后果：需在 gemproj v2 追加观察态键位 + 打开恢复链路 + 既有「永不入文件」清单回改（v2 schema 再动一次）。
2. **混合配置 = 预填最早选中层值**：多选层配置不同 → 横幅「N 层配置不同 · 以 ①层名 为基准」+ 字段一律预填锚点（selectionOrder[0]）值，不显示混合值；触碰任一配置控件 = 该字段写入全部选中普通层 = **单个 `layer.config` op**（一次撤销恢复全部原值）。推翻后果：改「真空白占位、聚焦才填」（Owner「滞空」字面解，图层稿议题 12 备选——多一次点击/猜值成本）。

### 0.6 Owner 未决项登记（不阻塞③④段开工，随切片走查回收）

| # | 未决项 | 现行口径 |
|---|---|---|
| 1 | 画布命中容差是否升 P0（图层稿 §I.4-1） | P1 入口验收门；P0 兜底 = 图层列表 + 块列表 + 键盘（§2.7） |
| 2 | 混合配置「滞空」形态复核（§0.5-2） | 预填锚点值（工作默认二） |
| 3 | GPU 预览试点立项（§I.4-4） | 不立项；P0 只留接口预留位（§2.9） |

---

## 1. replay/handoff gate（③段：replay/handoff/export 层化 + 物理锚贯通）

### 1.1 computeLayer 单一入口与兼容性证明（harness 先行，一切层计算消费的共同前置）

- **入口裁决**：`computeLayer` 落 `src/lib/studio/computeLayer.ts`，为 **lib 层编排函数**（非 worker 新协议）：内部复用既有 `runCompute({image, segmentOpts, strategies:[layer.strategy], layoutOpts, grid, blocks})` 单请求形状（`workers/computeClient.ts` 协议零改动），封装「层配置快照 → 单策略子轮」的映射。图层稿 §C.1 草案签名（`computeLayer(layer, blocks, image, onResult, run)`）的**契约语义**（快照/run 号作废/取消/渐进落地）逐条保留，字面签名以实现为准（与 §I.4「helper 签名以实现为准」同纪律）。
- **兼容性 harness（R2 §一 P0-3 / 图层稿 §C.4，证明前计算实现切片不切）**：
  - 主断言：单 rest 层（= 全部块）+ 同 image/blocks/grid/density/relax/seed 时，`computeLayer` 输出的 gems/warnings/dropped 与**旧 `runLayouts` 对该 strategy 的子轮逐位相等**——oracle = 现行 `stores/studio.svelte.ts:649-729` 五策略循环（:667 起逐策略子轮），旧输出以固定 fixture 固化（oracle 在 2.3 store 切换前采集）。
  - 全矩阵六项：① 结果缓存——未触碰层结果在其它层重算期间保留可用；② 进度单位——segment 1 单元 + N 层（旧 `1+i/6`，:671-675）；③ 取消——`cancelCompute` 后在途层轮 abort、reject 身份（`ComputeAbortedError`）与迟到结果丢弃语义同旧（:619-645）；④ run 作废——取消后新参数触发的 run 使旧 run 迟到结果不落地；⑤ 错误隔离——单层失败只污染该层结果 error 字段；⑥ 重算期间旧结果保留（渐进落地平移，计算中画布不闪空）。
- **退役面差异（Owner 授权、显式登记非回归）**：五策略并行缓存与秒切废除——切策略 = 该层重算（旧结果保持可见直到新结果落地）。

### 1.2 replay 层模型内核（纯函数，jsdom 可测）

- **specKey 解析（可注入 resolver）**：`resolveSpecForKey(specKey) → BaseSpec | typed error`——builtin 走 engine bootstrap（`ROUND_SS_BOOTSTRAP` / `builtinSpecKey` 规则，`engine/spec.ts:91-103`）；custom（`custom-<assetId>`）经注入的目录解析器（生产 = 素材库 .gemshape 真源；测试 = 内存 stub）；missing = typed 态（`resolved/soft-deleted/blob-missing/wrong-kind` 镜像 `ShapeAssetRefState`，`exportGate.ts:47`），**禁静默降级圆钻**。replay 保持 lib 纯度，不直接 import assetStore。
- **层成员解析**：解析唯一 rest + 显式层 → rest 成员 = 分块结果 − 显式层并集；显式层 blockIds 与新块集做差，未知键不拒收（parser 已定）而由**逐层 `pruneStaleOverrides` 清点**（悬空覆写键计数上浮，调用方单次提示——现状 v1 同口径 `gemprojReplay.ts:179-186` 的层级化）。
- **每层派生**：`effectiveBlocks`（disabled 过滤 + type 覆写，按层；`stores/studio.svelte.ts:160-165` 逻辑平移）、density 两级回落（块覆写 ?? 层 density——`getBlockDensity` :186-188 的回落目标从 globalDensity 改为所属层）、`grid = gridFromSpec(BaseSpec, layer.gapMm, pixelsPerMm)`（每层独立 grid；`gridFromSs` 降位特例不再被 replay 使用——现状 `:166` 是最后消费方之一）。
- **pixelsPerMm 来源**：`pixelsPerMmFromCanvas(image.width, file.physicalCanvas)`（`engine/spec.ts:234`——锚定实际降采样 canvas 宽；缺席 = default 2.5 显式）。replay 本地副本 `PIXELS_PER_MM`（`gemprojReplay.ts:41`）切换为 engine 出口（与 gem-catalog 2.4 收编协同——本方消费面先行切换不受 2.4 时序阻塞，2.4 完成后三处副本断言即闭合）。

### 1.3 联合 pairwise 与 exportGate 消费接线（engine 判据的层序组织）

- **[R1·议题 9 推翻原断言]** 分区互斥 ≠ 几何不重叠。P0 = **全层结果 concat 后统一过 `exportGate`**（`engine/exportGate.ts:93`——spatial hash cell = `maxCellPx`、判据 `requiredCenterDistancePx×0.999`，单位恒 px；engine gate 已交付判据与门，本 change 做**层序组织与消费接线**）。
- **八源碰撞清单（测试面逐条覆盖，R1 #9 原文）**：① 相邻块边界两层钻各贴共同边界；② 各层独立 layout 层间无协调；③ 不同径 gap（层 A 大钻层 B 小钻所需中心距不同）；④ boundary-repulsion 位移把钻推出掩码边界；⑤ 重分块归属变化（新块落 rest/显式层后与旧层产物交错）；⑥ 专家工作台改层/改径/改形后回流的 gemdoc；⑦ malformed import / 重复块 / 多余 rest（parser 拒绝面之外的第二道防线）；⑧ 未来手工钻。
- **违规清单按层对分组（studio 侧聚合，不改 engine 签名）**：`exportGate` 输出平面 violations（kind 秩 + gemIds 字典序），studio 侧按 `gemId → 层归属` 映射聚合为「层内违规（层名）/ 层间违规（层 A × 层 B）」分组呈现（§2.7 状态条违规清单 ▾）。
- **导出四路共同前置硬阻断**：SVG / BOM CSV / PNG / 送精修全部先过全层 `exportGate`（违规 = 不产出导出物）；保存允许 warning。隐藏层**包含在 concat 集内**（§2.5 名义化契约）。
- **层内布局终局同门**：每层单策略产物（含 relax 位移）随 concat 一并受检——「检索不漏 ≠ 分区结果几何合规」（R2 §一 P0-2 原文）。

### 1.4 handoff payload v2：修改权接管（A 轨薄 wrapper 换真）与物理锚贯通

- **`ManualEditHandoff` v2**（`stores/edit.svelte.ts:46` 类型真源处扩展；`studio/editHandoff.svelte.ts:43` 构造函数换真）：
  - `gems` = 各层 concat，每钻物化规格字段（Gem 已必含 `shapeId/diameterMm`，engine gate 1.4 的 `makeGem` 源头戳；rotationDeg/assetId 随附）——不再单 `activeResult`；
  - `blocks` = 各层 effectiveBlocks 并集（深拷贝纪律沿用 `copyBlockForHandoff`）；
  - `grid` 保留为参考网格（画幅级）+ 逐钻规格字段即物理真源（单 grid 不再是唯一径源）；
  - **+ `physicalCanvas: PhysicalCanvas`**（`engine/spec.ts:71`；缺席回退 default 显式——构造方写入 `anchorSource:'default'`）；
  - `sourceSummary` 层语法：`N 层 · 共 X 钻 · 主规格 …`（现单值语法「策略 · 密度 · SS · N 钻」失效——`editHandoff.svelte.ts:31-35`）。
- **`loadFromHandoff` v2 消费**（`edit/gemdocLifecycle.svelte.ts:102`）：payload 的 `physicalCanvas` 进入 `EditDocument`（+字段）；v1 形态载荷（无该键）= default 锚（向后兼容 quickLayout `edit/quickLayout.ts` 既有装配，直到其同步补锚——默认补 default 不破坏同参同出）。
- **gemdoc round-trip**：`EditDocument.physicalCanvas` → serializeGemdoc `physicalCanvas?`（v2 schema 位已冻结 `projectFile.ts:336`）→ parse 回读字节等价；`.gemdoc` 四层文档态与 gemproj 会话观察态的分界按 §0.5-1（文档态照旧入档，观察态不新增键位）。
- **round-trip/identity 测试归本段验收**（R2 §四 P0-3：「多层导出包含隐藏层且违规硬阻断；BOM 使用 `specKey×colorId`」——BOM 新键 engine 侧已证，本段证多层接线路径）。

### 1.5 gemprojReplay v2 六步链与 v1 fixture 逐位相等

六步链（图层稿 §E.5 / P0-4 冻结，逐字执行）：

1. segment 一次（全局单轮 k/seed，空轮取块——现状段一 `:170-174` 保留）；
2. 解析唯一 rest + 显式层 → 各层成员（rest = 分块结果 − 显式层并集）；
3. 每层派生 effectiveBlocks / density（层 density + 块覆写两级回落）/ grid（`gridFromSpec` 按层 specKey）；
4. 逐层 `computeLayer`（`LAYOUT_SEED=1` 同 seed 纪律，`gemprojReplay.ts:45`）；
5. 全层 concat → 统一 pairwise / `exportGate`；
6. handoff 携带逐钻规格快照 + `PhysicalCanvas`（`pixelsPerMm = 实际降采样 canvas 宽 ÷ widthMm`，dimsMismatch 以实测为准——现状 `:158` 语义升级）。

- **验收主断言**：v1 fixture 经 W0 迁移（`projectFile.ts:1286-1310`）为 v2 后，六步链输出与**旧 replay 路径**（现行 `replayGemproj` :146-244 经 v1 派生读面）逐位相等——钻位/颜色/悬空覆写清点逐项对照；单 rest 层 ⇔ 旧整图单策略。
- **v1 兼容读面退役**：`deriveLegacyGemprojView`（`projectFile.ts:916-935`，W0 偏离登记「engine/replay gate 迁移后删除」）随本切片删除；`GemprojFile` 的 deprecated `physics/activeStrategy/overrides` 派生字段一并移除；`gemprojReplay.ts:166/:179-198/:202-213` 的 v1 消费点全部改写为 layers[] 消费。
- **逐层进度与取消**：`onProgress` 阶段事件带层名（`层「N」排布中…`）；AbortSignal 作废全部在途层轮（`ComputeAbortedError` 身份不变）。

### 1.6 ③段验收（receipt）

- R2 §四 P0-3 全文验收：「v1 fixture 迁移后与旧 replay 逐位相等；多层导出包含隐藏层且违规硬阻断；BOM 使用 `specKey×colorId`」（隐藏层枚举 = 本段 studio 侧组织；判据/门 = engine 已证）。
- R2 §四 P0-6（本方分项）：`computeLayer`（§1.1 harness 六项矩阵）、`PhysicalCanvas`（贯通 handoff/EditDocument/gemdoc round-trip）的运行时证据三元组（源码符号 + 测试文件 + 通过 receipt）。
- expert A 轨 2.6「无 payload 第二修改点」收据在本段接管后重核（唯一修改点 = 本 change；5.9 解锁通知）。

---

## 2. studio gate（④段：图层 store / 历史 / 渲染 / UI / 项目生命周期）

### 2.1 图层数据模型：LayerState reducer + rest 哨兵 + 重分块语义

- **内存类型**（store 域，`src/lib/studio/layers.svelte.ts`；序列化面 `LayerRecord` 已由 W0 冻结——store↔record 的映射是纯投影）：沿图层稿 §A.7 草案落地 `LayerState { id, name, blockIds: string[] | 'rest', strategy, physics{specKey,gapMm,density,relax}, overrides 四表, visible }`；层 id store 自增 `L1…`，不随重分块死亡。
- **不变量（运行时守卫）**：恰一层持 `'rest'`；启用块恰属一层（显式层 blockIds 互斥、并集 ⊆ 当前块集）；背景层不入计算（§2.5）；序列化前按层 pruneStale。
- **生命周期操作**（`layer.create`（空层，继承锚点层配置初始值）/ `layer.delete`（确认 Dialog；兜底层不可删）/ `layer.merge`（块集并集入锚点层）/ `layer.rename` / `layer.moveBlocks`）——PS 语义对照表与「复制图层否决」沿图层稿 §A.1 不复述。
- **重分块语义**（[R1·议题 3]）：`setSegK/setSegSeed`（`stores/studio.svelte.ts:403-415`）改写为原子 `segment.opts` op；新块 id 全新生成（现状 `runSegment` :427-476 即如此）→ 全部落兜底层；显式层成员 ∩ 新块 = ∅ → **空层保留**（配置在、块没了）；**逐层** `pruneStaleOverrides`（现状 :478-484 全局四表 → 按层执行）清悬空键并计数横幅「N 项块覆写失效已移除」；警示文案升级「重分块将重置图层分配与块覆写」；撤销 `segment.opts` 回旧 k/seed 由引擎确定性重生成旧块 id（§2.2 属性测试）。
- **默认进页 = 现状效果**：分块后不自动爆层；单兜底层「图层 1」+ 默认配置（`strategy:'hybrid'` / round-ss10 / gap0.4 / 密度100% / 松弛关）+ 默认全选 + 自动排布——等价性由 §1.1 compatibility harness 证明（待证契约，非已闭合）。
- **块级覆写归属**：四覆写表随块住进所属层 `overrides`；`getBlockDensity` 回落目标 globalDensity → 所属层 density；全局密度语义退役（`setGlobalDensity` :529-533 移为锚点层写入）；色板仍项目级。

### 2.2 history：StudioOp 全集 + fold + stale 诊断 + 压实（`src/lib/studio/history.svelte.ts`）

- **StudioOp 八类**（图层稿 §D.2 冻结）：`layer.create / layer.delete / layer.merge / layer.rename / layer.moveBlocks / layer.config（layerIds[], patch, prev[]——多选批量 = 单 op）/ block.override / palette.edit / segment.opts`。**dirty 触发全集 = 一切 StudioOp**（add-project-files 2.6 依赖边）。
- **fold 契约**：`fold(baseSnapshot, ops[]) → { state, diagnostics }` 纯函数；diagnostics = 稳定 code/path 排序的只读记录（如 `{code:'stale-block-ref', opIndex, blockId}`）；**stale op 不删除、不重写为有效操作**——「重放确定」= 参数确定 + 诊断可查（[R1·P0-6]）。
- **撤销/重做 = 截断 + 重折 + 层配置差分重算**；结果永不入栈（ops 只含参数/结构变更）；未触碰层结果缓存继续有效。⌘Z/⌘⇧Z 与面板按钮同源（同一 reducer 入口）；空历史态显式空状态。
- **上限与压实**：100 组（`UNDO_GROUP_BUDGET=100` 先例，`edit.svelte.ts`）；新操作清 redo；超限把最旧 ops fold 进 baseSnapshot 并**记录被压实 op 边界（起止 index）与压实后 state hash**——跨压实边界 undo/redo 等价性可验证。历史栈永不序列化（gemproj 存 fold 终态；打开文件 = 新 base、历史清空）。
- **属性测试**：同 base + 同 ops 流 ⇒ 同 state **且同 diagnostics**（跨重分块 undo/redo 路径全覆盖 + 撤销后新操作清 redo）；「同 state」以 state hash 断言（含层结构/配置/覆写/色板/分块参数的规范序序列化）。
- **不入历史**（瞬态族 = §2.5 观察态全集 + 取景/hover/进度/取消）；换图/参考图变更 = 新 base 会话级重置（守卫走 add-project-files §3 三按钮，沿 2.8 移交面）。

### 2.3 computeQueue：逐层调度（`src/lib/studio/computeQueue.svelte.ts`）

- 脏层追踪：配置提交（debounce/immediate 双轨，`CommitOpts` :205-207 语义平移）标记 `dirtyLayerIds`，300ms 窗口合并一批。
- **P0 单 worker 逐层串行**：复用 `runCompute` module worker；逐层渐进落地、逐层错误隔离（单层失败只污染该层结果——现状单策略隔离 :704-716 的层级化）；进度聚合 `{done: 1+完成层数, total: 1+脏层数, label:'层「名」排布中…'}`；`cancelCompute` 作废全部在途层轮 + 清队列。
- store 根收缩：`stores/studio.svelte.ts`（821 行）的模块状态/派生量/读取器族（:107-341）中图层/历史/队列域迁入三子模块（$state 宿主纪律 `.svelte.ts`；单向依赖禁循环；根做聚合 re-export——沿 A 轨 2.1-2.6 先例与 adapter 验收面）；五策略 `results`/`activeStrategy`/`runLayouts` 退役（compatibility oracle fixture 先行固化）。`previewMode/overlayOpacity`（:134-135）随 §2.5 收编退役。

### 2.4 多选与「配置不同」（工作默认二）

- 有序选择集 `selectionOrder: layerId[]`（单击=重置 [id]；Cmd/Ctrl=尾部追加；Shift=范围替换；Cmd+A=全选普通层）；**锚点 = selectionOrder[0] = 最早选中层**（Owner 原话「不是排列在前面，是最早选中的」）；多选 >1 时行首选择序徽标 ①②③。
- 字段级混合检测器（strategy/物理四件/覆写逐字段比较，非整层 blob）：全等 → 「N 层 · 配置相同」+ 共同值；任一不等 → 「N 层配置不同 · 以 ①层名 为基准」+ **字段一律预填锚点值**（不显示混合值）。
- 写入语义：混合态下触碰任何配置控件 = 该字段写入全部选中普通层 = 单个 `layer.config` op（撤销一次恢复全部原值）；每次写入触发各层脏标记与重算。背景层可被选入（调源/透明度）但批量物理写入对其无效（只读）。
- 测试面冻结：不同策略/spec/gap/relax/overrides 的混合组合 + 空层选中态。
- 画布 ↔ 层选择联动：画布点选块（命中成功时）= 选中该块 + 隐式单选其所属层（两级选择：层选择驱动检查器配置面；块选择驱动 BlockDetail 覆写面）；命中失败不改变任何选择——列表确定性兜底即 Owner 痛点的结构性修复（画布容差命中 = P1 硬门，§0.6-1）。

### 2.5 观察态与渲染三分、背景层收编 previewMode（工作默认一）

- **观察态族**（不入档 §0.5-1、不入历史 §2.2）：层可见性、背景源与透明度、层选择、块选择、取景、hover。打开 .gemproj 恢复默认观察态（全层可见、背景=数字油画/50%）+ 单次提示。
- **背景层 = 特殊层**：钉底、不可删/不可重命名/不参与排布统计导出；持有源 `'none' | 'painting' | 'reference'` 与透明度（默认 0.5 可调 0–1）。**previewMode 三模式收编**：`'gems'⇔源无 / 'painting'⇔数字油画 / 'reference'⇔参考原图`；上下文条三模式分段控件 + 全局透明度滑杆废除（`StudioContextBar.svelte:19-21/:57/:101` 消费点迁移）；默认源 = 数字油画（对现状 `previewMode='gems'` 是一处 Owner 授权的默认值变更，显式登记）。
- **渲染三分常量**：`SELECTED_LAYER_OPACITY = 1.0`、`DESELECTED_LAYER_OPACITY = 0.8`（固定，UI 不提供调节面）、`BACKGROUND_OPACITY_DEFAULT = 0.5`（可调）；合成序：白底 → 背景图（源非无且可见）→ 各普通层（可见者按列表序）→ 选中块强高亮。
- **隐藏 ≠ 排除（名义化契约）**：隐藏是纯观察态——渲染省略该层，但照常进入排布队列、联合 pairwise、统计口径与导出物；状态条常驻全设计口径 + 「含 k 隐藏层」附注；「只导出可见层」若未来要做必须另设显式导出命令，禁止复用眼睛开关。

### 2.6 PreviewRenderInput 层化与旧 golden 等价迁移

- 新签名冻结（图层稿 §B.7）：`PreviewRenderInput { background: {source, opacity, painting?, referenceBitmap?}, layers: Array<{id, visible, selected, result}>, palette, blocks, size, dpr }`——`mode/overlayOpacity/grid/result` 单值入口废除；逐钻形状经层结果物化快照渲染（`gemPaint.ts:32` `gemRadiusPx(grid)` 过渡重载迁 `gemRadiusPx(gem, grid)` 逐钻签名——engine gate 1.3 偏离登记的既定收口，归本方文件域）。
- **旧 golden 等价映射（缺迁移不得切实现切片）**：每张旧三模式 golden（`src/tests/studio/previewRender.test.ts`）补一张等价映射新签名卡，渲染结果逐字节相等（`gems ⇔ background.source='none'`；`painting ⇔ source='painting'`+旧 overlayOpacity；单 rest 层 ⇔ `layers=[单层 selected]`）；迁移期新旧输入并存于测试、生产仅新签名。`pickCanvasLayers`（`previewRender.ts:129`）同步层化（BlockCanvas 分派面，:214 消费）。

### 2.7 UI 拓扑：四区 + 左列、面板族、废除清单、移动端

- **布局**（覆盖 redesign-studio-layout 五区冻结面——「画布常驻/答案常驻/主区零滚动/min-h-0 链」不变量沿用）：上下文条 h-10（项目身份+保存/菜单+取景——2.8 落）/ [左列 260px | 画布 flex | 检查器 320px] / 状态条 h-12。`StudioView.svelte`（`src/lib/components/views/StudioView.svelte:3` 头注五区拓扑）改四区；**StrategyFilmStrip 整区废除**（:106 挂载点、`StrategyFilmStrip.svelte` 192 行删除）。
- **左列双 tab（图层|历史）**：图层面板行结构 `[眼睛][层名双击重命名][钻数 mono][状态点 ◷/～/！/空]` + 选择序徽标 + 行尾菜单（重命名/合并/删除[兜底层禁用]）+ `[+ 新建图层]` + 背景层钉底行；键盘 ↑↓ 单选移动 / Space 切眼睛；历史面板 = 倒序列表（图标+摘要+组合并展示）+ ⤺⤻ + 深度计数；空历史态显式空状态。
- **检查器改版**：置顶常驻 = 选中层配置卡（横幅区[单选层名/配置相同/配置不同·锚点基准] + 策略 Select 五选一（`STRATEGY_LABELS` 中文名）——**全应用唯一策略写入点**（胶片带 `setActiveStrategy` 唯一写入点纪律宿主迁移，`stores/studio.svelte.ts:554-556` 退役）+ 物理组（规格 Select 数据源 = `GemCatalogService` 接口（§0.4）/ gap 滑杆 / 层密度滑杆 / 松弛双开关）+ 滑杆乐观 UI + 300ms trailing 提交）；选中块详情沿用 + 「移入图层 ▸」；折叠组（块列表[只列选中层块]/色板/分块参数[破坏性警示升级]）；背景层选中时 1–5 区替换为源+透明度+只读说明。
- **上下文条瘦身**：项目身份区 + 保存/菜单 + 取景控制保留；预览三模式分段控件 + 透明度滑杆废除（§2.5）；移动端折两行。
- **状态条收窄**：左 = `共 N 钻`（Σ 层结果，含隐藏层）+ `M 层 · 含 k 隐藏层` + 联合校验徽标 + BOM 前 3 色 ▾；右 = SVG/BOM CSV/PNG/送精修（`exportGate` 前置 + busy 语义沿用）；违规态红徽标 + 分层分组清单 ▾ + [边界松弛][斥力修复]写入违规涉及层（多选批量语义复用 §2.4）；worker 进度徽标 + [取消] 保留。
- **StrategyFilmStrip 废除清单（死 API grep 清零为验收）**：组件 + `setActiveStrategy` API + `results` 五策略缓存 + hover `drawPreview` 浮卡资产（迁 P2 对比视图或删除，不留死 API）+ `exportFileName` 的 `-${activeStrategy}` 后缀（`studio/exportSink.svelte.ts:52-54` → `${baseName}.${ext}`，同名覆盖/PNG 入库命名/下载行为测试冻结）+ 交互测试更新。
- **移动端同构**：上下文条折两行（图层/历史抽屉入口）；画布 flex-1；左列/检查器 = bottom sheet（沿现参数抽屉先例）；层多选 = 长按进入多选模式；导出收「导出▾」菜单。
- **状态矩阵**：八态沿用 + 四态新增（多选·配置不同 / 隐藏层观察 / 背景层选中 / 历史重放中）——图层稿 §B.9 全表沿用作测试清单；真浏览器三档 viewport 硬承诺沿用 + 新增左列可见性断言。

### 2.8 项目生命周期（承接 add-project-files 2.1–2.5 移交）与 dirty 全集

`src/lib/studio/projectPersistence.svelte.ts` 承接（其 design §3 UX 契约为移交输入）：

1. **序列化挂接**：saveGemproj v2 = fold 终态（层/配置/色板/分块参数 + source/reference + `physicalCanvas?`）→ `serializeGemproj`（W0 已备）→ 库内 ingest/换绑（复用 add-project-files 1.2 写路径与 lease/CAS）；导出磁盘 = embedded 烘焙。serializer 首写即 v2（R2 P0-4 硬门，W0 receipt ⑥ 已证当前无 v1 写路径）。
2. **打开链路**：素材库双击/openIntent → `openProject` lease + pin source/reference（机制归原 change 1.3，本方消费）→ parse v2（v1 经迁移入口）→ 段一 segment + 段二逐层重放（§1.5 六步链同源复用）→ 恢复默认观察态 + 提示；`engineVersion` 不等 → 黄色横幅 + 覆写存活清点（复用逐层 prune 计数）。
3. **上下文条重写**：项目名 + ●未保存 + [保存▾]（另存为/导出项目文件/关闭项目）+ ⌘S；首次保存弹命名（默认 = 来源图名去扩展名）。
4. **导出双路径**：库内（换绑）与磁盘导出（含 .gemproj 导出）；导出不清 dirty。
5. **空态与来源缺失**：空态（无图）沿 add-project-files §3（最近 ≤4）；来源缺失 = 画布错误卡「来源图已缺失——参数完好，重新绑定即可重放」+ [重新绑定][导出参数文件] + 检查器/层列表禁用占位。
6. **dirty 全集与 `isStudioDirty()`**：一切 StudioOp 置 dirty（undo 不清——沿 edit store 先例 `edit.svelte.ts:15`；保存清；导出不清）；`isStudioDirty()` 为 add-project-files 2.6（切 Tab 不弹/beforeunload/三按钮守卫）的唯一依赖读取器——**2.6 实现归原 change，本 change 交付读取器 + StudioOp 全集后通知其收口**；2.7 的 gemproj 路由随本段打开链路获得端到端消费者。

### 2.9 GPU：接口预留，不进 P0

- engine gate 已定（`ENGINE_VERSION=2` 恒描述 CPU 引擎；gpu-research：WGSL 浮点重结合致跨设备逐位复现不可得）：**CPU 恒 oracle，GPU 仅预览加速器（P1 试点 = CVT preview-only kernel，待 Owner 立项）**。
- 本 change 义务仅一项：`computeLayer` 接口契约冻结为 GPU 预留位——GPU/worker/主线程都是其内部实现细节，store 契约（快照/run 号作废/取消/渐进落地）零改动；不写任何 GPU 代码、不改 `run/cancel/onResult` 协议。capability-labeled + backend/version 记录 + 差异自动回退 CPU 等五条（图层稿 §C.6）随 P1 试点立项再切片。

### 2.10 ④段验收（receipt）

- **消费面迁移矩阵核销**（图层稿 §E.6 全表 + 本 change 新增行——「矩阵缺项不得进入实现切片」）：`PreviewRenderInput`/StrategyFilmStrip 族/`blockIndexAt`（P0 兜底+P1 门登记）/`StudioStatusBar` 全层统计/`buildActiveSvg/Bom` 全层接线/`buildManualEditHandoff` v2/`gemprojReplay` v2/`exportFileName`/`runLayouts`→`computeLayer`/asset pin 消费/gemdoc 烘焙分界/`PIXELS_PER_MM` 副本切换——每行「源码符号 + 测试文件 + 通过 receipt」三元组；死 API grep 清零（`StrategyFilmStrip`/`setActiveStrategy`/`getPreviewMode`/`getOverlayOpacity`/`previewMode` 等）。
- 消费端到端 jsdom 走查：载入 → 默认全选自动排布 → 建层/移块 → 多选混合配置批量写 → 撤销跨重分块 → 隐藏层导出口径 → 送精修 v2 载入。

---

## 3. PRODUCT_MODEL v4→v5 / TERMS v2→v3 联动（收尾切片执行）

- PRODUCT_MODEL：对象树「排钻设计 · 项目」行扩为「来源 + 分块参数 + 图层[] + 色板」+ 新增「排钻设计 · 图层 = 块集分区容器（策略/物理/覆写随层走）」；**真源表改两行增一行**：「排钻策略选择」真源从「排钻设计胶片带/对比模式选中项」→「图层配置字段（检查器层配置卡）」（现表即旧宿主——本 change 落地时同步）；新增「图层结构与配置 | studio store layers（→ .gemproj layers[]）| 左侧图层面板」；硬规则增观察态边界注记（gemproj 会话观察态 vs gemdoc 文档态）。
- TERMS：新增词条**图层**（块的命名分组与独立排布配置容器；禁用词：分组、分区）、**背景层**（承载数字油画/参考原图的特殊图层，不参与排布；禁用词：底图层）、**历史**（操作记录与撤销重放面板；禁用词：撤销历史、操作日志）；「排钻项目」词条补 layers 描述；**「层参数 vs 画幅物理锚」分词注记**（层物理 = spec/gap/密度/松弛；画幅 = pixelsPerMm/PhysicalCanvas——两个「物理」不得混用，UI 文案与检查器分组同口径）。

## 4. 测试策略

- **③段**：computeLayer compatibility harness（oracle fixture 逐位相等 + 六项矩阵）；replay 层内核（rest 展开/显式并集/悬空计数/两级密度/per-layer grid）；联合 pairwise 八源逐条 + 隐藏层包含 + 硬阻断；handoff identity/round-trip（逐钻快照 + PhysicalCanvas）；v1 fixture 迁移后与旧 replay 逐位相等（钻位/颜色/清点三项对照）。
- **④段**：reducer 不变量（恰一 rest/互斥/并集⊆块集）+ 重分块语义（空层保留/计数横幅/撤销回旧块 id）；fold 属性测试（同 base+ops ⇒ 同 state+diagnostics + 压实边界等价）；多选混合面冻结矩阵；观察态不入档断言（save→load 字节面）+ 打开恢复默认提示；PreviewRenderInput golden 等价迁移 + 新签名基准；消费面矩阵逐行核销 + 死 API grep 清零；四区布局三档 viewport + 移动端 sheet 走查。
- **基线**：全量 `pnpm test`/`pnpm check`/`pnpm build` 绿门串行；既有护栏（studio pipeline/interactions、edit 族、app.smoke）随消费面迁移联动更新，禁止无断言改动的静默通过。

## 5. 议题与未决

| # | 议题 | 状态 |
|---|---|---|
| 1 | 画布命中容差升 P0 与否 | 待 Owner 走查（§0.6-1；P1 硬门已立） |
| 2 | 混合配置「滞空」字面解 | 工作默认二（§0.5-2）待 Owner 复核 |
| 3 | GPU 预览试点立项 | 待 Owner（§2.9 只留接口位） |
| 4 | quickLayout 是否补 PhysicalCanvas（default 锚） | 随 §1.4 落 default 兼容；其显式补键归 expert/gem-catalog 后续，不阻塞 |
| 5 | projectFile.ts 删读面与 gem-catalog 2.3 的先后 | §0.4 串行规则（谁先动谁定基线，另一方 rebase） |
