# R2 终审：专家工作台/尺寸体系 × Studio 图层化重构

日期：2026-09-19
范围：两份 v1.1 设计稿、`gpu-research.md`、`add-project-files` 当前 design/spec/tasks、现有 TypeScript/Svelte 源码与独立测试。

## 结论先行

两稿已经把 R1 的主要设计缺陷改写成可执行的契约、验收矩阵和五段门序；GPU 结论也已与确定性要求一致。但这仍是“契约修订稿”，不是已经实现的功能规范：当前源码仍是 v1、单层、单规格、单策略重放，四个格式的 `formatVersion` 仍为 1，`layers[]`/`GemSpecSnapshot`/`PhysicalCanvas`/`exportGate` 均未落地。

终审结论：

- **允许 change 立项，允许启动 W0 v2 contract gate。**
- **不允许直接进入 W1/W2 业务实现切片。** 先关闭下列 P0 合流缺口，并把同步修改实际写回 `add-project-files` 的 design/spec/tasks。
- 终局状态：`CONDITIONAL GO / W0-GATE-ONLY`；若“进入实现切片”包括业务实现，结论为 `NEEDS-WORK`。

## 独立证据

### 文档状态

- 图层稿 §I.2 明确把 P0-1、2、3、4、6、7 标为“契约已落稿/待实现”，P0-5 标为“待执行”，P0-8 只有 GPU 设计处置；见 `studio-layers.md:634-645`。
- 专家稿 §I.2 同样把 P0-1、2、4、6、7 标为“待实现”，P0-3 仍待 W3 试产回填，P0-5 的 gate 宿主仍待拍板；见 `expert-workbench-and-sizes.md:539-550`。
- 五段门序的顺序本身自洽：v2 contract → engine → replay/handoff → studio → add-project-files 归档同步；见 `studio-layers.md:542-548`。但该顺序尚未变成各 change 的实际 DAG/任务状态。

### 源码状态

- `projectFile.ts` 仍声明 `.gemproj/.gemdoc` 当前版本为 1，`GemprojFile` 仍是顶层 `physics{ss,...}`、`overrides`、`activeStrategy`；见 `rhinestone-studio/src/lib/persistence/projectFile.ts:49-55,194-225`。
- `labFile.ts` 的 `.gemtpl/.gemgen` 仍为 v1；迁移表仅是空注册骨架。
- `gemprojReplay.ts` 仍读取 `file.physics`、`file.overrides`、`file.activeStrategy`，执行单一 `gridFromSs` 和单策略布局；见 `rhinestone-studio/src/lib/edit/gemprojReplay.ts:160-213`。
- `Gem`/`GridSpec`、`validate`、`conflict`、`export`、五策略 layout 仍按单一直径/单 `pitch` 工作；`PreviewRenderInput` 仍是单 `result/grid/mode`。
- `PIXELS_PER_MM = 2.5` 仍在 `studio.svelte.ts`、`gemprojReplay.ts`、`quickLayout.ts` 各自定义；`quickLayout.ts:64-69` 可直接核验。
- `add-project-files/tasks.md` 的 2.1–2.7 全部未勾选，原 `design.md/spec` 仍保留 v1 文字（例如 2.1 的“参数集本身零改动”、2.2 的单图重放）；见 `openspec/changes/add-project-files/tasks.md:41-49`。

### 独立测试

- `pnpm exec vitest run src/tests/lab/openIntentFlow.test.ts`：17/17 通过。
- `pnpm exec vitest run src/tests/edit/undo.test.ts`：13/13 通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test`：66 files，863/864 通过；唯一失败为既有 `src/tests/lab/gemgenArchive.test.ts` 的归档补偿断言（`persistedTasks()[0].assetId` 为 `undefined`）。因此 `c0637a3` 的 openIntentFlow 修复已被独立复跑确认，但全量基线仍未绿，不能宣称 P0-8 完全闭合。

## 一、Studio layers P0-1～8 闭合表

| P0 | R2 终审状态 | 证据/判断 | 必须补的可验证修复 |
|---|---|---|---|
| 1 v2 公共规格/物理锚 | **设计部分闭合，实施未闭合** | 已引用 `BaseSpec/GemSpecSnapshot/PhysicalCanvas`，但类型、迁移、round-trip 均待实现；`LayerRecord.physics` 的快照内联方式仍待 gate 冻结（`studio-layers.md:638,660-662`）。 | 在 W0 产出唯一类型模块、四格式 v2 schema、v1 fixture 迁移和 identity/byte-round-trip 测试；冻结 per-layer `specKey` 与快照承载位置。 |
| 2 pairwise/cell/exportGate | **未闭合（另有签名冲突）** | 图层稿写 `requiredCenterDistancePx(a,b)`，专家稿写 `requiredCenterDistancePx(a,b,grid)`；图层稿只说“以实现签名为准”，没有裁决（`studio-layers.md:639,663`）。源码没有 mixed-size helper/exportGate。 | 统一签名、单位和 `maxCellPx` 公式；实现全层 concat 的 pairwise、保存 warning/导出 hard block；补大小径、跨 cell、边界 gap、旋转、20k 测试。 |
| 3 computeLayer 等价性 | **契约闭合，实施未闭合** | 已定义单 rest 层 oracle、进度、取消、run 作废、错误隔离、旧结果保留矩阵（`studio-layers.md:640`），但源码仍只有 `runLayouts`。 | 先实现 compatibility harness：旧单层输出逐位等于新入口；覆盖 progress 1+N、取消 reject identity、stale run、per-layer error、重算期间旧结果。 |
| 4 gemprojReplay layers[] | **未闭合** | 六步 replay 链已写清，但当前 replay 仍是整图 v1 单策略（源码证据如上；设计见 `studio-layers.md:641,495-503`）。 | 迁移 v1 fixture → v2 `layers[]`，逐层重放后联合校验/导出/handoff；与旧 replay 的钻位、颜色、悬空覆写逐位相等。 |
| 5 四格式迁移/移交 | **未闭合，P0** | 文档要求归档前同步修改 add-project-files，但当前原 change 未同步、tasks 2.1–2.7 全未勾选（`studio-layers.md:642`）。 | 在任一 2.x serializer 开工前，实际更新原 change 的 design/spec/tasks，删除 v1 2.1–2.5，登记 2.6/2.7 依赖和 handoff/replay/asset-pin 验收。 |
| 6 history fold/stale/compaction | **契约闭合，实施未闭合** | `{state,diagnostics}`、稳定排序、灰显 stale、100 组压实边界/hash、跨重分块属性测试已落档（`studio-layers.md:643`）。 | 实现 reducer/fold/compaction；证明压实前后 state+diagnostics 相等，undo/redo 跨 `segment.opts` 后旧 op 可诊断且不静默改写。 |
| 7 消费面矩阵 | **设计闭合，消费未闭合** | §E.6 已列预览、胶片带废除、统计、导出、handoff、replay、asset pin、gemdoc 和常量收编（`studio-layers.md:507-525`），但每项仍无实现/测试核销。 | 按矩阵逐项落测试并 grep 清除死 API；特别登记 `gemprojReplay`、`PreviewRenderInput`、`buildActiveSvg/Bom`、`buildManualEditHandoff` 的新签名。 |
| 8 GPU 确定性 | **设计闭合，实施未闭合** | `gpu-research.md` 证明 CVT 是唯一明显热点、GPU 不保证逐位确定，因此仅 capability-labeled preview，落盘/导出/重放恒 CPU，差异自动回退；图层稿 §C.6 已吸收。 | 先保留 CPU oracle；实现 backend/version/capability 记录、同 fixture 差异判定和 fallback 测试。GPU preview 试点可另作 P1，不得改变 run/cancel/onResult 语义。 |

## 二、专家工作台与尺寸稿 P0-1～8 闭合表

| P0 | R2 终审状态 | 证据/判断 | 必须补的可验证修复 |
|---|---|---|---|
| 1 BaseSpec/GemSpecSnapshot/GridSpec | **设计部分闭合，实施未闭合** | 字段与 canonical 快照已写，但仍同时出现 `GemSpec.specId` 与 `GemSpecSnapshot.specKey`；源码没有这些类型。 | 把 `specKey` 定为唯一持久身份；`specId` 只能作为明确标注的旧名/内存别名，禁止进入 BOM、四格式、handoff。补 identity/round-trip。 |
| 2 pairwise | **未闭合（P0）** | 专家稿签名为 `requiredCenterDistancePx(a,b,grid)`，图层稿为二参；当前引擎只有单 `GridSpec.pitch`。保存 warning/导出阻断是设计要求，尚未实现。 | 采用单一签名并冻结 `grid`/`pixelsPerMm` 来源；实现 helper、spatial hash 和 exportGate，全链消费同一判据。 |
| 3 蓝图可靠性 | **设计闭合，实证未闭合** | “携带效果图的 `/images/edits` + 人审参照、非 BOM 数据源”已正确兼容既有 n:1 单图契约；但 W3 试产错误率仍待回填，机器级同排布被正确降为独立 change。 | 完成 3–5 批试产并记录 effect/blueprint request、失败率和人工确认结果；在未有结构化布局证据前禁止蓝图驱动 BOM。 |
| 4 物理锚 | **契约闭合，实施未闭合** | `PhysicalCanvas`、实际降采样 image.width、`dimsMismatch`、gemgen→handoff→EditDocument/gemdoc 已统一表述（`expert-workbench-and-sizes.md:546`），但源码仍三处 2.5 副本。 | 收编单一 `pixelsPerMm` 出口；让 gemprojReplay/quickLayout/handoff/gemdoc 同吃 `PhysicalCanvas`，补 px/mm 不变量和尺寸不匹配测试。 |
| 5 v2 时机 | **原则闭合，执行未闭合** | “2.x 前先 v2 contract gate、v1 不成写入真源”是正确的时序裁决；但 gate 宿主仍待拍板（`expert-workbench-and-sizes.md:547,570-571`）。 | 指定 add-gem-catalog W0 或独立 micro-change 为唯一 gate 宿主；在其完成前禁止 add-project-files 2.x 写入代码开工。 |
| 6 .gemshape schema | **契约闭合，实施未闭合** | 解码宽高、上限、alpha bounds、fit、校准悬空、missing typed 六条已覆盖（`expert-workbench-and-sizes.md:114-121`）。 | 建 `.gemshape` parser、MIME/字节/像素上限、typed errors、refSpecId/refSpecSnapshot 解析；补 projectTypes/MIME/导入/pin-GC 的八面测试。 |
| 7 lab mode/size | **契约闭合，实施未闭合** | `requestMode` 与 `workflowMode` 已分离，size 已改为 `{widthPx,heightPx}`；当前 `LabSettings.form.size` 仍为自由字符串。 | 新旧字段只读迁移，禁止写回旧字符串；补 gemtpl/gemgen v2 round-trip 与 endpoint/workflow 独立性测试。 |
| 8 基线/新契约测试 | **旧红灯已部分修复，整体未闭合** | `openIntentFlow` 与 `undo` focused tests 已绿；全量仍 863/864，`gemgenArchive` 失败；所有新契约 typed tests 尚未存在。 | 修复/解释 `gemgenArchive` 失败并恢复全量绿；然后补三 change W0 typed contract、migration、pairwise、PhysicalCanvas、blueprint 状态测试。 |

## 三、两稿合流一致性终验

### 已一致的部分

1. **一次 v2 bump** 是合理的：四格式尚未有 v2 写入真源，layers 与 GemSpec 都会改变 `physics` 宿主；一次 bump 可避免连续迁移链 churn。
2. **`GemSpecSnapshot` 物化 + `specKey` 引用** 适合四格式 v2：层配置引用 canonical `specKey`，输出钻携带不可变快照，BOM/SVG 不从浮点直径或显示 ordinal 反推。
3. **`PhysicalCanvas` 语义一致**：整图画幅锚与层物理参数分离，`pixelsPerMm` 应由实际降采样 canvas 宽 ÷ `widthMm` 派生；此链贯通 gemgen → replay/handoff → gemdoc。
4. **跨层 pairwise 口径一致**：分区互斥只是成员归属不变量，不是几何不重叠证明；最终必须 concat 全层结果，统一 pairwise，并让 SVG/BOM/PNG/handoff 共用 export gate。碰撞源至少包括：跨层不同径、同层布局边界、nudge/手动移动、改径/旋转、重放版本漂移、覆写/重分块 stale、导入外部 gemdoc、层显隐误读、GPU 预览差异被误落盘。
5. **GPU 结论一致**：CPU 是确定性 oracle，GPU 只做标注的预览加速，落盘/导出/重放不接受 GPU 结果。

### 尚未一致、必须在 W0 解决的部分

1. **`requiredCenterDistancePx` 签名漂移（P0）**：二参版无法表达 `pixelsPerMm/gapMm` 来源，三参版又可能把 `grid` 与逐钻物理尺寸混淆。建议冻结为：

   ```ts
   requiredCenterDistancePx(a: GemSpecSnapshot, b: GemSpecSnapshot, grid: GridSpec): number
   ```

   并同时冻结 `maxCellPx` 的输入为同一 px 量纲；若采用 `pixelsPerMm`/`gapMm` 直接传参，必须两稿同时替换，不能保留别名。

2. **`specId`/`specKey` 命名漂移（P0）**：专家稿 §A.1.3 仍定义 `GemSpec.specId`，而两稿合流使用 `specKey`。必须宣布 `specKey` 为唯一 canonical identity，并在类型、序列化、BOM、`gemContext`、handoff 中 grep 清零持久化 `specId`。

3. **`.gemproj` 宿主字段冲突（P0）**：专家稿格式表仍写顶层 `physics.baseSpec`；图层稿的 `GemprojFileV2` 要求 `layers[].physics.specKey`。合流后的 v2 应删除单一顶层 baseSpec，改为每层 `specKey`，整图只保留 `PhysicalCanvas` 等画幅级字段；catalog/snapshot 的内联或引用策略必须在 contract gate 定稿。

4. **五段门序的责任归属未落盘（P0）**：两稿仍把 gate 宿主/跨 change 排期留给 Owner。可执行方案是：add-gem-catalog W0（或单独 micro-change）唯一承接 contract gate；任何 add-project-files 2.x serializer 之前必须通过该 gate；归档前将移交同步写回原 change 三件套。

5. **add-project-files 移交边界尚未产生真实变更**：2.1–2.5 移交本 change、2.6/2.7 留原 change 的边界本身可行，不会断链；但必须把依赖写入原 tasks：2.6 依赖 Studio 全部 StudioOp dirty 触发，2.7 依赖四格式 v2 parser/openIntent。否则仍存在双真源。

6. **消费面矩阵尚未核销**：图层稿已登记 `gemprojReplay`、`PreviewRenderInput`、导出、handoff、asset pin、gemdoc，但当前实现没有 `layers[]` 消费者。该矩阵只能作为实现清单，不能当作覆盖证据。

## 四、残余阻塞问题与修复验收

### P0-1：公共身份与 helper 签名未唯一化

修复：在 v2 contract gate 单独提交 `BaseSpec/GemSpecSnapshot/PhysicalCanvas/requiredCenterDistancePx/maxCellPx` 类型；删除 `specId` 持久化别名和二/三参并存。验收：TypeScript 编译、全库 grep 只有 canonical 名称、跨层 mixed-size/旋转/边界测试全部通过。

### P0-2：四格式 v2 与 `.gemshape` 仍只有文档

修复：实现 project/lab migration registry 的 v1→v2 fixture，加入 `.gemshape` parser/typed errors、缺失资产状态和导入/pin-GC。验收：四格式 byte-round-trip、向前拒读、损坏/超限/悬空 ref 拒绝、missing 不得静默导出。

### P0-3：replay/handoff/export 仍是单层 v1

修复：engine gate 完成逐钻 spec、pairwise/exportGate；随后 replay/handoff gate 改为六步 layers[] 链。验收：v1 fixture 迁移后与旧 replay 逐位相等；多层导出包含隐藏层且违规硬阻断；BOM 使用 `specKey×colorId`。

### P0-4：add-project-files 双真源与 2.x 时序

修复：在 2.x 开工前实际修改 `openspec/changes/add-project-files/design.md`、`specs/project-files/spec.md`、`tasks.md`，删除旧 v1 2.1–2.5，登记移交、2.6/2.7 依赖和新增验收。验收：strict OpenSpec 检查、任务 DAG 无孤儿边、serializer 首次写入即 v2。

### P0-5：全量基线仍红

修复：定位 `gemgenArchive.test.ts:332` 的终态持久化缺失；保持 openIntent focused green 后重跑全量 `pnpm test`，并保存当次 receipt。验收：66/66 files、864/864 tests，且无未解释的 canvas 警告被误报为失败。

### P0-6：新契约没有运行时证据

修复：为 computeLayer、history fold、PhysicalCanvas、blueprint 子任务状态、GPU CPU oracle 建立 W0/W1 测试；不要把设计稿中的“待实现”状态改写为完成。验收：每个 P0 在矩阵中有源码符号、测试文件、通过 receipt 三元组。

## 五、非阻塞建议

- 先把 `studio.svelte.ts` 拆成 `layers`、`history`、`computeQueue` 子模块，避免图层/历史/队列继续堆入单一 `$state` 文件。
- 收编三处 2.5 常量后再补 `SS24` 目录项；SS24 不阻塞 v2 gate，但需伴随 ENGINE_VERSION 纪律说明。
- 统一“层参数”与“画幅物理锚”文案，避免 UI/TERMS 中两个“物理”混用。
- Owner 尚未拍板的画布命中容差、GPU preview 试点、蓝图机器级同排布，应继续保持 P1/独立 change，不阻塞当前 contract gate。
- history 100 组上限应在测试中按“压实前后 state+diagnostics 等价”验证，而不是只断言数组长度。

## 六、评分与最终放行

| 对象 | 评分 | 依据 |
|---|---:|---|
| `studio-layers.md` v1.1 | **6.4/10** | 图层不变量、rest、联合 pairwise、历史诊断、消费矩阵和 GPU 处置已成体系；但 helper/身份/宿主仍漂移，且所有关键实现与测试待做。 |
| `expert-workbench-and-sizes.md` v1.1 | **6.5/10** | 蓝图两请求降级、人审边界、物理锚、.gemshape 六条 gate、v2 前置时序均明显改善；但 W3 实证、v2 类型/迁移、pairwise、常量收编和全量基线未闭合。 |
| 两稿合流方案 | **6.1/10** | 五段门序方向正确，能作为跨 change 依赖图；但当前仍有 P0 签名/宿主/责任归属冲突，原 change 未同步，源码与新契约尚未接线。 |

**最终结论：`CONDITIONAL GO / W0-GATE-ONLY`。** 两稿可以进入 change 立项，并以 v2 contract gate 作为第一实现单元；在 P0-1～P0-6 的可编译类型、迁移 fixture、engine/replay/export/handoff 测试、add-project-files 同步和全量绿门完成前，不得宣称两稿已闭合，也不得直接切入业务 UI/图层实现。
