# 排钻设计页图层化重构 PM 稿 R1 · Codex 设计评审

日期：2026-09-19
评审主体：`.agents/documents/2026-09-19-studio-layers/studio-layers.md`
交叉依据：当前 `rhinestone-studio/src`、`openspec/changes/add-project-files`、`add-manual-edit-mode`、`PRODUCT_MODEL.md`、`TERMS.md`，以及上一轮 `.agents/documents/2026-09-19-expert-workbench-and-sizes/codex-review-r1.md`。
结论性质：只以源码和冻结契约为证据；PM 自评 `SHIP` 不作为实现证据。当前工作树已有用户改动未触碰。

## 结论

**评分：4.9/10。结论：NEEDS-WORK；暂不能作为 `studio-layers` change 的规范性实现基础。**

图层作为块集分区容器、左侧确定性选中、观察态显隐、命令式历史和一次 v2 合流，产品方向成立；`rest` 也有成为迁移哨兵的价值。但稿件把多个“目标契约”写成了已闭合的等价关系，和当前真实边界不符：

1. 当前引擎 `Gem`/`GridSpec`/`validate`/`conflict`/`export` 仍是单一 SS 圆钻模型；层内 `baseSpec`、逐钻快照、混合径 pairwise 没有可实现的公共类型和导出 API。
2. `computeLayer` 的“默认全选=现状效果”没有证明字段、结果缓存、进度、取消和错误隔离等价；现状是一次 segment 后五策略逐一计算，且 activeResult/导出只看一个策略。
3. 跨层约束不是“分区互斥即永不重叠”。必须在全层结果上统一 pairwise，且 `exportCheck`/SVG/BOM/送精修都必须消费同一联合门。
4. “v1 不存块 id，所以 `rest` 使迁移纯函数”表述错误：v1 的 `overrides` 四表键就是引擎块 id（`projectFile.ts:210-215`）。`rest` 仍能避免为了迁移重跑分块，但必须定义悬空覆写清理、未知层/重复块和重分块语义。
5. 两稿合流未登记 `gemprojReplay`、`buildManualEditHandoff`、`PreviewRenderInput`、资产库 pin/CAS、SVG/BOM 等完整消费面；`add-project-files` 2.1–2.5 尚未实现，移交若不同时改 spec/tasks 会断链。

## 1. §G 16 项裁决

| # | 裁决 | 真实证据与理由 | 可验证替代方案 | 成本/影响 |
|---|---|---|---|---|
| 1 | **支持（边界收紧）** | `Block` 已是 layout 输入，`BlockCanvas.blockIndexAt` 在 `BlockCanvas.svelte:422-429` 逐像素命中，列表确实能补确定性选中。块集分区足以兑现当前 Owner 痛点；不能宣称能表达任意自由掩码。 | 冻结 `LayerRecord` 的成员不变量：启用块恰属一层、背景层不入计算；自由区域另立 mask/member type change。导入时拒绝重复块、未知块和多 `rest`。 | P0 只扩 store/UI/序列化；未来自由区需新几何与编辑工具，不能偷塞本 change。 |
| 2 | **支持（推翻原论证措辞）** | `rest` 对“未显式分配的新块”是稳定兜底；但 v1 `overrides` 已含 block-id 键（`projectFile.ts:210-215`），不能说 v1 完全不存块 id。 | v1→v2 纯函数只搬运顶层参数到唯一 `rest` 层；打开/重放分块后执行 `pruneStaleOverrides`，未知键计数并提示。冻结恰一 `rest`、显式层去重、空显式层保留配置、删除/合并后的归属规则。 | 低于显式全量清单迁移；需要 parser 校验与迁移测试，不能省略。 |
| 3 | **支持（需定义回退）** | 当前 `runSegment` 在 `studio.svelte.ts:601-633` 产生全新块 id，随后 `pruneStaleOverrides:652-658` 清悬空覆写；这支持“新块进 rest、显式层置空保留配置”。 | 明确重分块为原子 `segment.opts`：旧显式层成员清空但层配置保留；新块只落唯一 rest；旧 block override 计数/提示；撤销回旧 k/seed 时用旧 op 流重建并重新应用仍存在的块键。 | 中等：层迁移 reducer、prune 结果摘要和撤销测试。 |
| 4 | **支持（但必须改名义）** | 隐藏是观察态，Owner 没有要求排除；当前 `StudioStatusBar` 已按 active result 统计，隐藏语义尚未存在。 | “隐藏仍计算/统计/导出”与 UI 预览显隐分离；状态条显示“含隐藏层”，导出前显示全层口径；若未来要只导出可见层，另设明确命令而非复用眼睛开关。 | 低到中：渲染计划、统计文案、导出测试。 |
| 5 | **支持（需补跨设备取舍）** | `projectFile.ts:22-26` 当前把 previewMode/overlayOpacity/selectedBlockId 排除；会话瞬态方向一致。但 `.gemdoc` 的四层显隐/透明度是文档态（`projectFile.ts:268-273`），两者不能只在 TERMS 口头区分。 | gemproj 不入可见性/背景源/选择/历史；gemdoc 烘焙文档保留最终显示层；打开工程恢复默认观察态并明确提示。`PreviewRenderInput` 改版须有旧 golden。 | 低到中；文档态/工程态双套测试。 |
| 6 | **支持（前置 gate）** | 上一轮裁决 P0-5 要求 v2 contract gate 先于 add-project-files 2.x。当前 `projectFile.ts:52-55`、`labFile.ts:38-41` 仍均 v1，迁移表为空。一次 bump 可避免 physics 宿主搬两次。 | 先冻结公共 `BaseSpec`/`GemSpecSnapshot`/`PhysicalCanvas`/迁移接口；GemSpec 与 layers 同一 v2，但 `gemproj/gemdoc` 各自 schema 变化必须分别 round-trip。 | 中等一次契约同步；远低于先写 v1 保存路径再返工。 |
| 7 | **支持原则，反对当前移交落法** | `add-project-files/tasks.md:43-47` 的 2.1–2.5 均未完成，2.6/2.7 也未完成；当前源码没有 `saveGemproj` 接线，仍是 v1 parser。移交本身与上一轮 gate 一致，但只在 layers 文档声明会断链。 | add-project-files 归档前同步修改 design/spec/tasks：明确 2.1–2.5 由 studio-layers 承担、删除原 change 的旧 v1 骨架；保留 2.6/2.7 但把 dirty 触发集、四格式导入和 project lease 依赖列为 DAG。新增 `handoff`/`gemprojReplay`/asset pin 的验收条款。 | 中到高：两个 change 的文档/任务重切；不做会确定性返工或漏接。 |
| 8 | **推翻“已等价”结论，支持串行调度方向** | 现状 `studio.svelte.ts:823-900` 是一次快照后五策略循环，进度 `1+i / 6`，每策略独立结果/错误；`computeClient.ts:120-151` 取消立即 reject，迟到消息丢弃。新 `computeLayer` 每层单策略改变结果缓存和进度单位，不能仅靠段落断言等价。 | 冻结 compatibility test：单 rest 层、同 image/blocks/grid/density/relax/seed 时，`computeLayer` 输出逐位等于旧 activeStrategy 子轮；验证结果保留、层错误隔离、取消后 `run` 作废、空层/脏层进度（segment 1 + N layers）和重算顺序。 | 高：store 状态重构和一组 worker/取消/进度测试；不证明就不能切 P0。 |
| 9 | **支持 P0 联合校验，推翻“分区互斥=永不重叠/只边界风险”** | 当前 `validate.ts:17-41` 和 `conflict.ts:27-55` 只接受单一 `pitch`；`layout/index.ts:28-71`、`relax.ts:79-99,147-180` 也按单 pitch。跨层风险包括：相邻块边界、各层独立 layout、不同径/gap、boundary/repulsion 位移、重分块归属、专家改层/改径/改形、malformed import/重复块、未来手工钻。 | 统一 `requiredCenterDistancePx(a,b)` + `maxCellPx`（px 单位）helper；圆包络下 `dist >= (d_i+d_j)/2+gap` 是保守且正确的判据，cell 取 `maxDiameterPx+gapPx` 后 3×3 邻域足以覆盖所有阈值邻居，但这只保证检索不漏，不保证分区结果几何合规。所有层结果 concat 后按层对报告 spacing/mask，`exportCheck`、SVG/BOM、handoff 共用同一 `exportGate`。P0 报告不自动剔除；导出硬阻断与上轮 gemspec P0-2 对齐。 | 高：引擎几何 helper、联合报告、导出和混合径测试；是 P0 blocker。 |
| 10 | **支持方向，需消费面清单** | `StudioView.svelte:105-106` 仍挂 `StrategyFilmStrip`，组件在 `StrategyFilmStrip.svelte:102-157` 负责五策略结果和缓存切换；去除它会改变预览/测试/移动端。 | 先列废除清单：组件、`getResults`/`activeStrategy` API、hover `drawPreview`、导出文件名、现有交互测试；P0 切策略重算，P2 临时五策略比较不写层。 | 中：UI 与测试删改；不能只改布局稿。 |
| 11 | **支持（需检查快捷键）** | edit 页已有 100 组预算先例；当前 studio 无历史面板/命令栈，左列双 tab 不直接冲突 Owner 底部约束。 | 冻结 Ctrl/Cmd-Z/Shift-Z 与按钮同源、面板跳转是否回放、跨 tab focus 和空历史状态；不把 edit snapshot 栈强行复用 studio fold。 | 中：新命令 reducer、键盘与 UI 测试。 |
| 12 | **支持（须冻结提交语义）** | Owner 的“滞空+默认值”有文字张力；锚点最早选中可实现。当前 store 没有 selectionOrder/多层写入。 | 字段级 mixed detector；显示“配置不同，以①层为基准”，预填锚点值；控件触碰一次写全部选中层，批量作为一个 op，撤销恢复所有原值。测试不同策略/spec/gap/relax/overrides 和空层。 | 中：选择 reducer、表单状态和批量 undo。 |
| 13 | **推翻 P1 过于乐观，至少升为 P1 入口验收门** | `BlockCanvas.svelte:422-429,511-517` 是精确像素命中，无容差；列表能兜底但不能修复画布直觉路径。 | P0 先保证列表/键盘确定性；P1 必须实现最近块/距离场容差并覆盖边界、钻覆盖、缩放和空白点击测试；若 Owner 走查把命中视为主路径，则升 P0。 | 中：距离场或最近块索引；交互风险不应隐去。 |
| 14 | **支持** | 当前 `studio.svelte.ts:956-958` 文件名强绑定 `-${activeStrategy}`，层模型没有单一主策略。 | 改为 `${baseName}.${ext}`；同名下载覆盖/浏览器行为由导出层测试冻结；摘要中带层/策略信息。 | 低：命名 helper 与测试。 |
| 15 | **支持但需限制容错** | `pruneStaleOverrides` 只是删除悬空键；把历史 stale op 静默 no-op 可能让重放“看似确定”但语义已丢。`segment.opts` 回退后块 id 是否再次出现也未证明。 | fold 返回 `{state, staleOps[]}`，stale op 只读灰显且进入 deterministic diagnostics；不要把 stale op 重新写成有效操作。跨重分块撤销做属性测试：同 base+ops 同 state+diagnostics；100 组压实保存 state hash，undo/redo 边界测试。 | 高：历史 reducer、诊断结构和 compaction 测试；不宜只写一句“容错”。 |
| 16 | **支持方向，需沿用现有 sheet 语义** | 当前 `StudioView.svelte:112-140` 已有移动端 bottom sheet 参数抽屉；长按多选尚不存在。 | layer panel 作为 bottom sheet 同构宿主；长按进入多选模式，短点单选，Esc/拖动关闭不丢选择；安全区、焦点、滚动和层数 1/几十层测试。 | 中：触摸状态机和移动端走查。 |

## 2. 阻塞问题（P0）

### P0-1：v2 公共规格与物理锚未冻结

`engine/types.ts:68-119` 仍只有 `Gem {id,x,y,colorId,blockId}`、单一 `GridSpec {ss,pitchMm,rowAngleDeg,pixelsPerMm}`；`edit.svelte.ts:54-68` 的 `ManualEditHandoff` 也没有 `declaredPhysical`/逐钻规格。PM 的 `LayerState.physics.baseSpec` 不能直接进入布局、编辑文档或 BOM。

**修复验收：**先冻结 `BaseSpec`（shape/size/widthMm/heightMm）、`GemSpecSnapshot`（稳定 `specKey`/ordinal/shapeId/sizeLabel/diameterMm/assetId/rotation`）和 `PhysicalCanvas`（widthMm/heightMm/anchorSource）；`Gem`、`EditGem`、`GridSpec`、handoff、gemproj/gemdoc、BOM/SVG 均有 round-trip/identity 测试。

### P0-2：pairwise 单位、cell 和导出门没有一条真源

`validate.ts:17-41`、`conflict.ts:27-55`、`layout/index.ts:58-71` 均按单 pitch；`SpatialIndex` 是 px cell；PM 的 “max diameter + gap” 若误传 mm 会漏邻居。当前 `studio.svelte.ts:242-248` 只对 `activeResult` 调 `validate`，不能覆盖多层。

**修复验收：**实现唯一 `requiredCenterDistancePx`/`maxCellPx`，以逐钻快照计算；联合结果按层对报告，层内布局终局也跑同 helper；`exportGate` 是 SVG/BOM/PNG/handoff 的共同前置；导出遇 spacing/mask 违规必须阻断。测试大/小径、跨 cell、边界 gap、旋转形状、20k 钻。

### P0-3：`computeLayer` 兼容性未证明

旧路径在 `studio.svelte.ts:823-900` 复用一组 `blocksNow/gridNow/densityNow/relaxNow`，逐策略计算五个缓存结果；新稿改成逐层单策略和层级结果，但没有定义结果缓存、阶段进度、取消、迟到、错误隔离和空层的兼容矩阵。

**修复验收：**保留旧实现作为测试 oracle（或固定 fixture），证明单 rest 层对每个 strategy 的 gems/warnings/dropped/id 逐位相等；验证 `segment→N layer` 进度、取消 reject 身份、run generation、错误只污染对应层、旧结果在重算期间是否保留。

### P0-4：`gemprojReplay` 未登记/设计为消费 `layers[]`

`gemprojReplay.ts:160-213` 读取 `file.physics`、`file.overrides`、`file.activeStrategy`，按整图单策略重放；这正是图层模型的关键消费者，但 §B.10/E.5 只泛称“打开重放”，没有写出逐层重放、rest 展开、联合校验、结果合并和层级 provenance。

**修复验收：**v2 replay：segment 一次→解析唯一 rest/显式层→每层派生 effectiveBlocks/density/grid→逐层 `computeLayer`→联合 pairwise/exportGate→handoff 带逐钻 spec 与 PhysicalCanvas；v1 fixture 迁移后与旧 replay 结果相等。

### P0-5：四格式迁移和 add-project-files 移交未形成可执行 DAG

`projectFile.ts:52-55,119-151`、`labFile.ts:38-41,112-145` 仍 v1/空迁移链；`tasks.md:43-49` 的 2.1–2.7 全未完成。仅在本文写“移交 2.1–2.5”不会修改原 spec 的 v1 参数全集，也没有 2.6/2.7 对新 dirty、lease、导入路由的依赖声明。

**修复验收：**在任意 2.x 实现前提交 v2 contract gate：四格式版本表、v1→v2 纯迁移、坏输入/未来版本、round-trip fixtures；同步更新 add-project-files design/spec/tasks 和归档记录；保留 2.6/2.7 的 dirty/四格式 DAG 并加入 layers/replay 消费面。

### P0-6：历史 fold 的 stale、重分块和 compaction 语义不闭合

§D 说 stale op no-op、又说撤销 `segment.opts` 后旧块引用重新有效，但没有定义 diagnostics、op 身份、baseSnapshot 压实后的 undo 边界。若静默丢操作，重放“确定”只剩参数确定，不再是用户可解释确定。

**修复验收：**纯函数 `fold(base, ops) -> {state, diagnostics}`；diagnostics 以稳定 code/path 排序；100 组 compaction 记录 state hash 和被压实边界；测试跨重分块 undo/redo、stale move/override、撤销后新操作清 redo、重放不记结果。

### P0-7：消费面覆盖不完整

必须同时改：`PreviewRenderInput`（`previewRender.ts:21-39`，当前仍是单 `result/grid/mode`）、`BlockCanvas`/`StrategyFilmStrip`/`StudioView`、`StudioStatusBar`；`buildActiveSvg/Bom`（`studio.svelte.ts:937-954`）、`buildManualEditHandoff:977-995`、`gemprojReplay`、asset library project pin/CAS、`.gemdoc` 层模型。稿件只登记了五区和签名名义覆盖，未给每个调用方迁移/测试责任。

**修复验收：**建立“旧符号→新入口→测试”矩阵，至少覆盖 UI 预览、五策略废除、隐藏层渲染、联合统计、导出门、送精修、gemproj 打开/保存、asset pin、gemdoc 烘焙；矩阵缺项不得进入实现切片。

### P0-8：GPU 候选接口还没有确定性可执行证明

§C.6 口头冻结 `computeLayer` 和 seed，但 GPU 浮点归约、并发顺序、设备差异可能改变钻位；这会直接破坏 §D 历史重放和同 seed 逐位承诺。接口标注不等于确定性契约。

**修复验收：**GPU 只能作为 capability-labeled implementation；同 fixture CPU/GPU 对比必须定义“逐位相同”或明确 canonical CPU fallback；记录 backend/version，发现差异自动回退 CPU；GPU 候选不改变 `run/cancel/onResult` 协议。

## 3. 非阻塞建议

- 将 `PIXELS_PER_MM`、`SEGMENT_GEM_DIAMETER_PX` 和 `minAreaFor` 收到 engine/physical helper；当前三处常量重复在 `studio.svelte.ts:56`、`gemprojReplay.ts:40-47`、`quickLayout.ts:64-69`。
- `studio.svelte.ts` 已超过 1,000 行且同时承载载入、覆写、调度、预览、导出、handoff；按稿件 §H-2 拆 `layers/history/computeQueue/projectPersistence`，否则正交意图纪律会失真。
- `GemSpecSnapshot` 应物化 `shapeId/diameterMm/assetId`，但 BOM 主键使用 canonical `specKey` 快照；不能仅用浮点径或显示 ordinal 反推资产。
- `.gemshape` 仍需真实图片解码宽高/MIME/字节和 alpha bounds 校验；物理与贴图纵横比不一致时冻结 fit/拒绝策略；`refSpecId` 必须可解析或带 snapshot，缺失资产必须 typed missing，禁止静默圆形降级导出。
- `StrategyFilmStrip` 的 hover `drawPreview` 在废除后要么迁到 P2 CompareOverlay，要么删除对应 renderer/test，不能留死 API。
- 导出文件名去策略后缀可以落地，但同时冻结同名覆盖、PNG 入库名和下载测试。
- 层排序只影响半透明视觉；若隐藏层仍参与导出，列表排序不能改变几何或 BOM 顺序，输出排序需独立确定性规则。
- 画布命中容差即使不升 P0，也应作为 P1 走查硬门，而不是仅以层列表兜底结案。
- `PRODUCT_MODEL`/`TERMS` 需把“层参数”与“画幅物理锚”分词；`gemproj` 会话态与 `gemdoc` 文档态要在 UI 文案、导出和跨设备说明中一致。

## 4. 两稿合流审查

### 一致处

- 图层稿的 per-layer `baseSpec` 与上一轮 gemspec 需要的形状/尺寸能力方向一致；一次 v2 bump 方向与上一轮 P0-5（v2 contract gate 先于 add-project-files 2.x）一致。
- pairwise 作为导出硬门、BOM 按规格×颜色聚合、SVG 按逐钻规格渲染，和上一轮 gemspec P0-2/P0-4 方向一致。
- `rest` 可使 v1 顶层参数迁移不需要为每层重建分块；但不能抹掉 v1 overrides 的块键清理事实。

### 冲突/缺口

1. **规格模型缺口。** layers §A.7 只有 `{shapeId,sizeLabel,diameterMm}`，没有上一轮要求的稳定 `specKey/ordinal/widthMm/heightMm/assetId/rotation`，也没有 `GridSpec` 从 `BaseSpec` 派生的统一入口。Gem 物化快照字段和 spec 引用二选一未裁决；本评审裁决：层配置引用 canonical `specKey`，但每个输出/编辑钻必须物化不可变 `GemSpecSnapshot`（含 `shapeId/diameterMm/assetId` 等），BOM/SVG/四格式迁移都以快照身份而非浮点径或显示 ordinal 反推。
2. **物理锚缺口。** layers 把 `pixelsPerMm/declaredPhysical` 排除在层配置外，却只在概念上沿用姊妹稿；`gemprojReplay` 与 `quickLayout` 仍各自固定 `2.5`，handoff/EditDocument 无物理字段。必须把 `PhysicalCanvas` 贯通 gemgen → handoff → gemdoc/replay，且用实际降采样 canvas 尺寸，不能盲信源图尺寸。
3. **重放消费缺口。** `gemprojReplay.ts:160-213` 是整图 v1 replay，layers §B.10 没有将它列为 `layers[]` 必改消费者；打开 `.gemproj` 后仍会丢层配置。
4. **导出/交接缺口。** 当前 `buildActiveSvg/Bom` 只接受一个 `LayoutResult/GridSpec`，`buildManualEditHandoff` 只复制 `activeResult` 和一个 grid；隐藏层、逐层结果、联合 pairwise、BOM spec×color 尚未接线。
5. **预览契约缺口。** 当前 `PreviewRenderInput` 是单 `result`、单 `grid`、三模式全局预览；B.7 只写“覆盖签名”未冻结新输入（层序、visible、选中 alpha、背景特殊层、逐钻形状）。需同步更新 BlockCanvas、状态条、P2 hover/对比测试。
6. **资产库与生命周期缺口。** `add-project-files` 规定 gemproj 打开要 pin source/reference、保存走 CAS/lease；layers 的 2.1–2.5 移交没有将 `openProject/closeProject/updateProjectAsset` 和 dirty 触发全集写入依赖图。另有 `add-manual-edit-mode` §3 工具表的画布/笔刷/spacing 入口被 B.4 覆盖，必须同步登记 `ManualEditHandoff`、`EditDocument`、编辑器工具状态和测试责任，不能只改 Studio 检查器。
7. **add-project-files 边界缺口。** “2.1–2.5 移交、2.6/2.7 留原 change”原则正确，但 2.6 依赖新 Studio dirty/层操作，2.7 依赖四格式 parser 与 openIntent；若原 spec 不删旧 v1 条款，将产生两套真源。必须在归档前完成迁移记录和 tasks DAG，而非只在 PM 稿登记。
8. **`.gemshape` 缺口。** 上一轮已指出贴图真实尺寸、alpha bounds、纵横比、`refSpecId` 悬空和 missing 行为；layers 一次 bump 没有把该 schema gate 纳入切片前置。
9. **GPU/确定性缺口。** layers 要求同 seed 逐位重放，GPU 调研接口没有 backend/version、差异判定和 CPU fallback；这和历史纯 fold 的确定性承诺不完整相容。
10. **观察态边界缺口。** gemproj 不入背景源/透明度而 gemdoc 入四层文档态是可接受的分层，但必须在 `PRODUCT_MODEL/TERMS`、preview、保存/打开测试中显式说明，避免用户认为工程文件会恢复观察布局。

### 合流门

只有在以下顺序落地后，三 change 才能进入实现切片：

1. v2 contract gate：`BaseSpec`、`GemSpecSnapshot`、`PhysicalCanvas`、四格式版本/迁移、`.gemshape` parser 及错误形态。
2. engine gate：pairwise helper、mixed-size validate/conflict/exportGate、SVG/BOM 逐钻 spec、CPU deterministic oracle。
3. replay/handoff gate：`gemprojReplay` layers[]、联合结果、物理锚、ManualEditHandoff/EditDocument/gemdoc round-trip。
4. studio gate：Layer reducer/rest/reblock、computeLayer compatibility、history fold/compaction、PreviewRenderInput 与所有消费面。
5. add-project-files 归档同步：原 change 的 2.1–2.5 旧 v1 文字删除，2.6/2.7 依赖补齐，导入/资产 pin/CAS 测试纳入责任矩阵。

## 5. 规范性结论与放行条件

这份稿件可作为产品方向和切片讨论的输入，**不能作为 `studio-layers` change 的规范性基础直接开工**。最低放行条件：P0-1～P0-8 全部转成可编译类型、迁移 fixture、联合导出门、replay/handoff 测试和 CPU/GPU 确定性证据；并把两稿合流矩阵同步回 openspec，而非只停在 `.agents/documents`。

本轮没有把上一轮 `pnpm test` 的旧失败数字当作新证据，也未修改源码；报告只依据当前文件快照和上述符号核验。
