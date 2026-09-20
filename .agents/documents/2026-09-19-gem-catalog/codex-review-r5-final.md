# R6 实现终审

评审基线：当前 HEAD `94e3cd3`，工作树净。范围为 `add-gem-catalog-and-sizes`、`rename-and-expert-workbench`、`add-lab-drill-params-and-blueprint`、`studio-layers`，以及 `add-project-files` 的 1.4/2.6/2.7 尾部。

证据口径：五个 change 的 `openspec validate --strict` 均通过；用户提供的收官 receipt 为 `pnpm test` 132/132 files、1559 passed + 1 skip、`pnpm check` 0、`pnpm build` EXIT=0。独立聚焦复跑为 5 个文件 142/142 通过（studio interactions、gemFields、projectFile、labFile、gemshape）。一次误带 `-- --run` 的全量调用实际跑到 132 files，出现 `templateSheet` 与 `templatesStore` 两个异步/时序失败；随后聚焦复跑全绿，故不把该次抖动当作本轮契约回归，但归档仍应保留全量重跑 receipt。

## 结论

总评：**NO-GO（实现归档暂缓）**。四个核心 change 中，engine/W0、replay/handoff、stage 生命周期和专家工作台主体已达到可交付质量；但 `studio-layers` 的“送精修”路径仍未消费联合 `exportGate`，与规范要求的四路共同硬阻断直接冲突。与此同时，`.gemdoc`、`.gemgen`、`.gemshape` 的手写解析器允许 `shapeId: 'custom'` 缺少 `assetId`，绕过已冻结的 custom 身份契约。这两个问题在归档前必须修复并补边界测试。

## 阻塞问题

### P0-1：送精修绕过联合 exportGate

规范和 `studio-layers/tasks.md:37,65` 明确要求 SVG/BOM/PNG/送精修四路共同硬阻断。实际 `StudioStatusBar.svelte:96` 的 `canSendToEdit` 只有 `result && !result.error`，`requestSendToEdit`（:98-105）与 `performSendToEdit`（:117-131）直接构造 handoff 并切换到 edit；两个按钮（:397、:419）也只绑定 `!canSendToEdit`。相比之下 `blocked`（:64）正确绑定了 SVG/BOM/PNG，`exportSink.svelte.ts:32-48` 也消费 `getExportCheck().exportable`。现有 `studio.interactions.test.ts:395-403` 甚至固定断言违规时送精修仍可达，正好证明了这一偏差。

可验证修复：让送精修按钮和 `performSendToEdit` 在 `!check.ready || !check.exportable` 时禁用/短路，并覆盖移动、桌面和直接调用三面；将交互断言改为违规硬阻断，补一条合规路径仍可 handoff 的测试。验收：注入 spacing/mask/missing-asset 及跨层 inter 违规时，四个按钮均不可触发且不生成 `ManualEditHandoff`；修复后四路均可用。未完成前 `studio-layers` 不能 GO。

### P1-1：持久化 parser 未执行 custom assetId 强制

`GemSpecSnapshotSchema`、`GemSchema`、`EditGemSchema` 已在 `engine/spec.ts:173-264` 强制 custom 必带非空 `assetId`，`exportGate.ts:102-119` 也有 typed invalid 阻断；但三个文件层 parser 没有同样的反向检查：`projectFile.ts:911-944` 的 `parseGemdocGem`、`labFile.ts:768-792` 的 `parseGemSpecSnapshot`、`gemshapeFile.ts:384-411` 的 `parseGemSpecSnapshotRecord` 均只把 `assetId` 当可选字符串返回。这样 malformed `.gemdoc`/`.gemgen`/校准快照可先成功装载，直到后续 engine/exportGate 才失败，违反“脏输入 typed reject”和 custom 身份链在持久化边界闭合的意图。

可验证修复：抽出/复用 `customAssetIdMissing` 的 parser 级 typed error（路径分别为 `gems[i].assetId`、`gemSpecs[i].assetId`、`calibration.refSpecSnapshot.assetId`），补三种格式的缺失/空串拒读 fixture，并验证合法 builtin 不受影响。验收：上述 parser 在 load/round-trip 入口即拒绝，错误不被静默降级或延迟到导出门。

## 各 change 终审

评分变化总表：`add-gem-catalog-and-sizes` **8.5（R5 8.2，+0.3）**；`rename-and-expert-workbench` **8.6（R5 8.0，+0.6）**；`add-lab-drill-params-and-blueprint` **8.4（R5 7.8，+0.6）**；`studio-layers` **7.2（R5 8.1，-0.9）**；`add-project-files` 尾部 **8.3（本轮无同口径 R5 基线）**。增量实现带来明显提升，但 studio 的 P0 和共享 parser P1 使总评仍为 NO-GO。

### 1. add-gem-catalog-and-sizes

**8.5/10（R5 8.2，+0.3），CONDITIONAL GO。** W0、engine、2.x 资产化和 custom assetId 五面贯通基本成立。`specKey` 链条可从 `gemCatalogService.ts:7-15,148-173` 的 sys-shapes 真源，经 `replayLayers.ts:5-11,95-112` 注入解析，到 `gemprojReplay.ts:267-277` 逐钻物化，再进入 BOM/文档快照；`PIXELS_PER_MM` 已在 `engine/spec.ts:275` 单源化。`.gemshape` texture 必备/vector-only 拒收、seed create-only、内容不可变和四态 missing 证据存在，独立 `gemshape`/`gemFields`/`projectFile` 聚焦测试通过。

条件是 P1-1 parser 拒读闭合，以及任务 `3.1/3.2` 仍未勾选。后者是归档状态同步问题，不应以“实现已存在”代替收口 receipt。

### 2. rename-and-expert-workbench

**8.6/10（R5 8.0，+0.6），CONDITIONAL GO。** R/A/C/S/D 结构和 D 轨 5.1/5.2/5.4/5.5、5.7/5.9 的实现证据充分：属性描述符收窄、documentService 默认 `gemshapeRefResolver`（:315-330）、PhysicalCanvas 在 `gemdocLifecycle.svelte.ts:306-359` 装载并在 :178-208 序列化、brushEngine :54-71 拒绝 custom 无 assetId，且服务/属性/物理读数/brush 聚焦测试通过。A 轨为 re-export 薄 wrapper，payload 构造权已由 studio-layers 接管，未发现第二 payload 构造点。

剩余风险为 P1-1 解析器边界，以及 `tasks.md` 的 C/D/收尾项（例如 3.1-3.6、5.1-5.8、6.1/6.2）仍显示未勾选，和本轮“全轨实现”叙述不一致；应在归档前用实际 receipt 更新，不要依赖提交说明代替任务状态。

### 3. add-lab-drill-params-and-blueprint

**8.4/10（R5 7.8，+0.6），CONDITIONAL GO。** Owner 重定义已落实为正交 `drillParams`/`blueprint`，`workflowMode` 仅留退役/迁移语境，`requestMode` 保留。stage 状态机与持久化边界集中于 `lab/stages.ts`，4.x 接线在 `lab.svelte.ts:1566-1647,1736-1751,1842-1874,2143-2213`；主图 success 自动先归档单图，blueprint 终态自动归档双图，两档并存，串行依赖与重试新 `requestId` 均有实现和测试。stagePipeline/stageMatrix 聚焦证据覆盖四象限×两策略、刷新中断、missing fail-fast、附图顺序、蓝图纯净性。

条件是 P1-1 对 `gemgen.gemSpecs` parser 的缺失 custom assetId 拒读，以及 `stages.ts:590-593` 恢复 `materialAssetIds` 只过滤不去重的 P2。另有 0.x/3.x/5.x 任务项未勾选，需同步归档状态。

### 4. studio-layers

**7.2/10（R5 8.1，-0.9），NO-GO。** ③段 replay/handoff 和 ④段主体实现质量高：`computeLayer` oracle harness、`gemprojReplay` 六步链、层内/层间联合 gate、隐藏层参与、PhysicalCanvas handoff→EditDocument→gemdoc、history fold/stale/压实、观察态不入档、四区 UI 和 dirty 生命周期均有源码与测试证据；`jointGate.ts:132-147` 的两级判定和 `projectPersistence.svelte.ts:423-501` 的打开恢复链与规范对齐。

但 P0-1 未闭合：状态条注释（`StudioStatusBar.svelte:3-6`）和任务（`studio-layers/tasks.md:37,65`）声称送精修同样受 exportGate 前置，实际路径没有检查 `getExportCheck().exportable`，测试还把违规送精修定义为允许。这是用户可绕过硬门的直接契约缺口，故不能作为本周期实现收官。

### 5. add-project-files 尾部

**8.3/10，CONDITIONAL GO（随 studio P0 解锁）。** 1.4 type-aware 素材库、2.6 dirty/guard 三分法、2.7 四格式全局导入均已在源码和聚焦测试落地：`guard.svelte.ts:52-82` 统一保存/不保存/取消，`StudioView.svelte` beforeunload 与 intent 接线，`App.svelte:103-149` 文件 input/drop 识别、交叉校验和路由。其 2.6/2.7 依赖的 studio lifecycle 已实现，但 studio 的送精修门缺口会影响跨 change 端到端收口。

任务 `4.7/5.2/5.3` 仍未勾选，虽然 1.4/2.6/2.7 收据已在任务注记中写出；归档前应明确这些是移交、浏览器走查未纳入本轮，还是补勾选/补证据。

## 跨 change 契约检查

- **specKey 身份链：通过（parser 边界除外）。** sys-shapes seed → `GemCatalogService` → replay 注入 resolver → 层结果逐钻 `shapeId/diameterMm/assetId` → `gemSpecIdentityOf` BOM → gemdoc/gemgen 快照均可追踪；未发现 `specId` exact-key 身份字段，`refSpecId` 仅存在于 calibration 引用语境。
- **PhysicalCanvas：通过。** lab/replay 物化、handoff 携带、`loadFromHandoff`/`loadFromGemdoc` default 锚补齐、gemdoc round-trip 与 physical readout 测试形成闭环。
- **exportGate 四消费面：不通过。** SVG/BOM 在 `exportSink.svelte.ts:32-48`，PNG 在 `StudioStatusBar.svelte:176-213`，但送精修在 `:117-128` 绕过；这是 P0-1。
- **死代码/双真源：大体通过。** `StrategyFilmStrip.svelte` 已删除，`PIXELS_PER_MM` 仅 engine 定义；`workflowMode` 只残留迁移/退役注释和类型测试语境。`activeStrategy`/`previewMode` 的残留主要是 v1 迁移或背景观察桥，不构成当前写入真源。

## 遗留风险

### P1

1. P0-1 修复后需补送精修 blocked/allowed 双向测试，并验证移动端菜单与直接函数调用不能绕过按钮状态。
2. P1-1 三个 parser 统一 custom assetId typed reject；同时检查 `serialize→parse` 错误路径不会产生半载荷。
3. 各 change `tasks.md` 仍有大量未勾选收尾项（特别是 gem-catalog 3.x、studio 3.2/3.3、expert/lab 5.x、project-files 4.7/5.2/5.3）。这不是源码缺失的直接证明，但会使“全轨已收官”无法从 OpenSpec 状态独立验收。

### P2

1. `lab/stages.ts:590-593` 恢复 `materialAssetIds` 未用 `Set` 去重；建议补脏账本 fixture，避免重复附图/配额计算偏差。
2. 全量 receipt 的首次两红应继续保持低负载复跑记录，避免把时序抖动误判为稳定绿门；本轮聚焦测试未复现这两项。
3. 浏览器/1 万钻 60fps/完整用户走查属于供应 receipt 或历史任务说明，未在本次源码审查中独立重跑，不应单独作为本报告的实现证明。

## 周期质量结论

本周期已完成从 W0 contract、engine gate、资产目录、replay/handoff、专家工作台、实验室 stage 生命周期到 studio 图层 UI 的主要实现闭环，代码和测试组织明显达到可维护交付线。收官仍被一个真实用户路径的硬门绕过和三个 parser 的边界契约缺口卡住；修复并补齐任务状态/边界测试后，再将总评提升为 GO 是合理的。

## R7 快审（P0-1 / P1-1 / P2-1）

评审边界：只核 R6 指定的三个修订，不重开其他已接受结论。当前 HEAD 为 `e6e587c`；独立聚焦复跑 `src/tests/studio/studio.interactions.test.ts`、`projectFile.test.ts`、`labFile.test.ts`、`gemshape.test.ts`、`stages.persist.test.ts` 共 5 文件、164/164 通过；`pnpm check` 为 0 错误、0 警告。Vitest 输出的 jsdom `HTMLCanvasElement.getContext` 提示是既有测试环境告警，未导致失败。

### ① studio-layers：GO

**最终判定：GO（判定面 = P0 闭合且 exportGate 四消费面齐）；评分 8.9/10（R6 7.2，+1.7）。**

- `studio.svelte.ts:297-319` 的联合 `jointCheck` 仍是唯一门源；`StudioStatusBar.svelte:64,101` 以同一 `blocked = !check.ready || !check.exportable` 驱动 SVG/BOM/PNG 与送精修按钮，桌面和移动菜单均为禁用态。
- `StudioStatusBar.svelte:135-154` 的 `performSendToEdit` 在构造 handoff 前再次读取 `getExportCheck()`；不 ready 或不可导出时关闭确认/菜单、发出事实+首项违规+恢复动作 toast，并提前返回。因此确认键或其他直接调用不能产生 handoff，也不能切换到 edit。
- 四面消费核销：SVG/BOM 经 `exportSink.svelte.ts:35-48`，PNG 经 `StudioStatusBar.svelte:204-206` 的 `blocked`，送精修经上述二次短路；联合判据仍由 `jointGate` 调 engine `exportGate`。新增交互测试 `studio.interactions.test.ts:399-505` 覆盖违规四键、确认键直调、合规放行和移动菜单。

没有发现新的 P0。按钮的禁用提示在送精修入口提供 `title`，SVG/BOM/PNG 保持既有状态条导出提示；这与任务/spec 的硬阻断契约一致。

### ② P1-1 / P2-1 闭合

**P1-1：闭合。** `engine/spec.ts:41` 的 `customAssetIdMissing` 被三个 parser 统一调用，且均在非空字符串 coercion 前执行：`projectFile.ts:925`（`gems[i].assetId`）、`labFile.ts:775`（`gemSpecs[i].assetId`）、`gemshapeFile.ts:395`（`calibration.refSpecSnapshot.assetId`）。三类 serializer 都先完成同一解析校验，再进入 `JSON.stringify`，坏输入不会产生半载荷。三族测试覆盖 custom 缺席、空串、serializer 脏值拒绝、合法 custom round-trip 和 builtin 零回归。

**P2-1：闭合。** `lab/stages.ts:590-596` 以 `filter(typeof string && length > 0)` 后套 `Set`，保持首见序；`stages.persist.test.ts:207-218` 对重复 id、非字符串项和空串的脏账本 fixture 断言结果为 `['ast-9', 'ast-7']`，且 specs/physical 快照不受影响。

### ③ 周期总评（四个核心 change + add-project-files 尾部）

| change | R6 | R7 结论 | 变化依据 |
|---|---:|---|---|
| add-gem-catalog-and-sizes | 8.5 | **8.9 / GO（实现面）** | 三 parser custom 身份边界闭合；W0/engine/2.x 与既有全量 receipt 保持一致。 |
| rename-and-expert-workbench | 8.6 | **8.8 / CONDITIONAL GO** | 共享 `.gemdoc` parser P1 已闭合；本轮未重审其余 D 轨/浏览器验收项。 |
| add-lab-drill-params-and-blueprint | 8.4 | **8.8 / CONDITIONAL GO** | `.gemgen` parser P1 与 stage 账本去重 P2 均闭合；其余收尾 receipt 不在本轮范围。 |
| studio-layers | 7.2 | **8.9 / GO（实现面）** | 送精修不再绕过联合 `exportGate`，四消费面和直接调用防线均有测试。 |
| add-project-files 尾部 | 8.3 | **8.7 / CONDITIONAL GO** | 依赖的 studio P0 已解除；既有 4.7/5.3 Owner 浏览器走查仍按原登记待验收。 |

周期实现结论：**GO（源码契约与聚焦回归门已收口）**。归档状态仍保留为 **CONDITIONAL**，原因是本轮未重开且当前任务中仍显式保留的 Owner 浏览器走查/部分 change 收尾勾选（例如 studio `3.3`、expert D 轨收尾、project-files `4.7/5.3`）；这些是证据收尾风险，不是本轮发现的运行时 P0。遗留 P2 仅为全量 receipt 的低负载复跑记录维护和 jsdom canvas 告警治理，不影响上述三项修订闭合。
