# 专家工作台与尺寸钻形体系 · Codex 设计评审 R1

日期：2026-09-19  
范围：`.agents/documents/2026-09-19-expert-workbench-and-sizes/expert-workbench-and-sizes.md`，`add-project-files` / `add-manual-edit-mode` 冻结契约，`PRODUCT_MODEL.md`、`TERMS.md`，以及 `rhinestone-studio/src` 当前源码。  
结论性质：设计评审，不把 PM 自评或文档中的“已就位”当作实现证据。

## 结论

**评分：5.6/10。结论：NEEDS-WORK / 暂不能作为三个 change 的规范性基础直接进入实现切片。**

产品方向成立：尺寸是跨三页的缺口，专家工作台应拥有钻级属性与编排能力，成品模式需要把物理画幅与钻清单带入生成任务，`.gemshape` 与模板分离也符合概念边界。

但当前稿件仍有四个会直接破坏闭环的缺口：

1. `GridSpec` 仍是 SS 圆钻模型，`Gem`/`EditGem` 仍无 `shapeId`/`diameterMm`，布局、交接和持久化没有一套可实现的 `BaseSpec`/`GemSpecSnapshot` 契约（源码：`engine/types.ts:68-119`、`engine/grid.ts:10-47`、`edit.svelte.ts:54-68`）。
2. 双请求可以满足现有客户端的 `n:1` 约束，但不能保证第二张蓝图与第一张效果图是同一排布；当前方案只保证“两个提示词”，不保证语义配对。
3. `declaredPhysical` 没有贯通 `gemgen -> studio/gemprojReplay -> ManualEditHandoff/EditDocument -> quickLayout`；当前三处确实各自固定 `2.5`，且交接类型没有物理画幅字段（`studio.svelte.ts:56`、`gemprojReplay.ts:40-47,166`、`quickLayout.ts:64-69,168`、`edit.svelte.ts:54-68`）。
4. v2 时机判断反了：`add-project-files` 的 studio 生命周期/保存路径仍未实现，而当前四类 parser/serializer 都固定 v1。等它归档后再 bump，会让 2.x 先写 v1，再被迫重写。

独立基线验证：在 `rhinestone-studio` 执行 `pnpm test`，66 个测试文件中 64 个通过、860/864 通过，4 个失败（`edit/undo.test.ts` 1 个超时；`lab/openIntentFlow.test.ts` 3 个断言失败）；大量 jsdom canvas 警告不是失败原因。该结果不能作为本设计的新契约已闭合的证据。

## 12 项议题裁决

| # | 裁决 | 理由与真实证据 | 替代方案/成本 |
|---|---|---|---|
| 1 | **推翻（保留双请求机制，推翻可靠性结论）** | 现有 `generateImage` 和 `editImage` 强制 `n:1`（`api/client.ts:289-301,341-361`），所以两次独立请求与既有 wire 契约兼容；但两个独立随机生成请求没有共享 latent/坐标，第二次只读到“蓝图 prompt”，无法证明它复现第一次的钻位。§C.3 的“形状+色+比例为主通道”只能降低人审成本，不能把蓝图变成同一设计的可靠施工稿。W3 尚未有实证。 | P0 采用“效果图请求 -> 把效果图作为输入的 `/images/edits` 蓝图请求”，并在 UI/档案标记“人审参照、非 BOM 数据源”；仍保留图例必需。成本：增加第二请求的图片上传与失败状态。若 Owner 要求机器级同排布，另立高成本结构化布局输出 + 本地 renderer change，不能用 prompt 声称达成。 |
| 2 | **支持（需补稳定身份契约）** | 规格码正交于颜色，符合 BOM 的 `spec × color` 语义；但当前稿没有冻结“清单第几号”的持久化映射，且 `custom-<assetId>` 与同尺寸不同自定义资产的 BOM 区分规则未落地。`Gem` 不能只靠浮点 `diameterMm` 反推稳定码。 | 冻结 `SpecSnapshot {specKey, ordinal, shapeId, sizeLabel, diameterMm, widthMm?, heightMm?, assetId?}`；每次 run/gemgen 保存 ordinal→specKey 映射；BOM key 使用 canonical snapshot（至少含 assetId），不要由显示码反推。成本：增加快照字段与 v2 round-trip 测试。 |
| 3 | **支持（但 `.gemshape` 必须先补 schema gate）** | 位图内嵌 + 内置 path 同源是合理的 P0 边界，圆包络也是可验证的保守近似；当前源码没有任何 `shapeId`/`diameterMm`/`.gemshape` 实现（`rg` 无命中），因此这是设计方向而非已闭合契约。 | 先冻结图片解码/尺寸校验与 missing 行为，再做 renderer；自定义资产缺失时不能静默把 `shapeId='custom'` 画成普通圆并继续导出。成本：schema/parser、SVG/Canvas golden tests。 |
| 4 | **推翻“pairwise + layout 不动即可闭环”的表述** | 圆包络判据 `dist >= (di+dj)/2 + gap` 对以最大径包住形状的模型是正确且保守的；若 `cellPx=(maxDiameterMm+gapMm)*pixelsPerMm`，3×3 查询也能覆盖阈值邻居。可是当前 `validate`/`validateEditable`/`resolveGreedy` 全部按单一 `pitch`（`validate.ts:17-40`、`edit.ts:53-76,130-147`、`conflict.ts:27-45`），布局及 `relax`/Poisson 也按单一 pitch（`layout/index.ts:28-72`）。只改列出的四处而不定义 mixed-size 输入边界，会让“选块策略填充/修复”在混合文档上先产出不合规集合。 | P0 仍可保留五策略的单一 `baseSpec` 生成算法，但明确：布局输入只接受单 spec；编辑文档的校验/修复使用 pairwise；任何布局/relax 结果进入文档后强制跑 pairwise gate，违规时不得自动宣称合规。cell 单位必须是 px，增加不同尺寸、跨 cell 边界、gap/容差和 20k 数据测试。成本：统一几何 helper + 少量适配，不必在 P0 做多径六方布局。 |
| 5 | **推翻 PM 的“归档后再启动”时序** | `projectFile.ts` 与 `labFile.ts` 当前支持版本均为 v1，迁移表为空（`projectFile.ts:52-55,119-151`；`labFile.ts:38-41,112-145`）。更关键的是 `add-project-files/tasks.md:41-53` 的 2.x studio 生命周期/保存路径仍未闭合，源码中也找不到 `saveGemproj`/studio 项目 serializer 接线。若等归档，2.x 会先按 v1 写入，随后 add-gem-catalog 必须改保存 API、类型和测试，形成确定性返工。 | 现在先做一个“v2 contract gate”：冻结四格式 v2 类型、迁移入口、`BaseSpec`/物理锚字段；2.x 暂停 v1 写路径或直接消费该 gate。完整迁移实现仍可在 add-project-files 归档后进入独立 change，避免重开业务议题。成本：一次小范围契约同步；远低于归档后改 serializer、UI 保存和 round-trip 测试。 |
| 6 | **推翻 P0/P1 边界中的旋转降级** | 形状集包含 drop/heart/marquise 等非圆形；PM 同时要求 P0 渲染 `rotationDeg`，却把属性编辑列为 P1。用户可以选到朝向错误的异形钻，却没有 P0 的修正入口，`EditGemFields` 当前也只有 `x/y/colorId`（`edit.svelte.ts:126`）。这不是纯增强，而是“选择形状”能力的不完整。 | P0 将旋转作为属性面板的数值/步进编辑（旋转手柄、路径切向对齐仍 P1）；`rotationDeg` 与渲染、SVG、undo 一起冻结。阵列/路径工具保持 P1。成本：一个字段控件与测试，不改变布局算法。 |
| 7 | **推翻“物理锚三件套已贯通”的结论** | 公式 `pixelsPerMm = canvasWidthPx / widthMm` 本身正确，但当前 handoff/document 只有 `GridSpec`，没有 `declaredPhysical`（`edit.svelte.ts:54-68,87-111`）；studio handoff 直接复制固定 grid（`studio.svelte.ts:977-995`），replay/quick layout 直接用 2.5。`gemprojReplay` 还有 `dimsMismatch`（`gemprojReplay.ts:158-166`），说明文件记录尺寸与实际降采样尺寸可能不同，不能盲用文件 width。 | 冻结 `PhysicalCanvas {widthMm,heightMm,anchorSource:'declared'|'default'}`，在 gemgen provenance、送排钻 handoff、gemproj v2 和 gemdoc 中明确承载；锚定实际交接 canvas（降采样后的 `image.width`），校验宽高比例、正数和缺失回退；quickLayout 明确 `default=2.5`。加 replay→handoff→save/load 的 px/mm 不变量测试。成本：扩展两种文档和 handoff 类型，收编三处常量。 |
| 8 | **支持（需拆任务子状态）** | 蓝图失败不拖死效果图符合配额与可恢复性；但现有 `LabTask` 只有一个 `status`、一个 `assetId`、一个 `imageUrl`（`lab.svelte.ts:97-140`），无法表达 effect/blueprint 各自重试、归档、取消与画廊投影。 | 将任务冻结为 `effect`/`blueprint` 两个子任务状态（各自 requestId, status, assetId, error, retryCount），父任务只作派生汇总；gemgen 明确两个图的键序和部分失败语义。成本：任务持久化/画廊测试扩展，换取可单图重试。 |
| 9 | **支持 run 级层级，推翻字段复用** | run 级开关符合“结构化中间稿/成品设计”是一次请求意图；但现有 `RunMode = 'generate'|'edit'` 代表 API 请求类型（`lab.svelte.ts:97-100`），gemgen provenance 也使用同名 `mode`（`labFile.ts:201-224`）。直接引入 `mode='structured'|'product'` 会把 endpoint 语义和产品工作流语义混在同一字段。 | 冻结 `requestMode: 'generate'|'edit'` 与 `workflowMode: 'structured'|'product'` 两个字段；`gemContext` 只在 product 注入，且任务/档案快照完整记录。把 `size` 从自由字符串升级为 `{widthPx,heightPx}`，物理尺寸单独结构化。成本：一次类型改名和迁移，不增加用户操作。 |
| 10 | **支持（新格式正确，但不能以草案直接切片）** | 自定义钻是可复用物理资产，塞进 gemtpl 会混淆模板与素材；第五种 `ProjectKind` 与 `sys-shapes` 方向成立。 | 在 `projectTypes.ts`、MIME、AssetNode、导入路由、素材库 seed、RightSheet、parser/migration、引用 pin/GC 矩阵中一次性冻结 `.gemshape`。缺失资产应有 typed missing 状态；模板/文档引用需定义删除后的可读性。成本：跨资产库的一个完整 vertical slice。 |
| 11 | **支持不改“送精修”** | 这是动作语义，不是模块名；保留可避免把 `.gemdoc`/handoff 变成无意义的 churn。需要改的是用户可见模块名、TERMS 禁用词和旧文案的全量一致性，而不是动作动词本身。 | 在 rename change 内用 grep + UI 断言确认“专家工作台”与“送精修”组合不歧义；不改文件格式名。成本低。 |
| 12 | **推翻硬上限 8** | 8 只是 PM 对蓝图可读性的判断，不是 Owner 约束；固定上限会拒绝真实项目的多规格 BOM，且生成模型数字可靠性并未因 8 而得到证明。 | 允许配置上限（建议默认 8、超过时显示可读性警告），图例分页/分组并把蓝图视为人审参照；若供应商/模型有硬限制，再由模型能力配置限制。成本：一个 warning 和图例布局，不牺牲数据表达。 |

## 阻塞问题清单

### P0-1：`BaseSpec`、`GridSpec`、`GemSpecSnapshot` 没有统一可实现契约

设计稿把 `.gemproj.physics` 从 `ss` 换成 `baseSpec`，但当前 `GridSpec` 仍只有 `ss/pitchMm/rowAngleDeg/pixelsPerMm`，`gridFromSs` 也只接受 SS（`engine/types.ts:110-119`、`engine/grid.ts:35-47`）。这使方形/水滴基础规格无法进入布局、重放和 `ManualEditHandoff`。同时，物化 `shapeId+diameterMm+assetId` 不能稳定重建自定义 spec 或蓝图 ordinal。

可验证修复：先冻结 `BaseSpec`（形状、尺寸标签、物理宽高、gap）与 `GemSpecSnapshot`（稳定 specKey/ordinal/assetId），明确 `GridSpec` 是从 base spec 派生的几何上下文；为四格式 v2、`toEditGem/fromEditGem`、BOM 和 serializer 加 round-trip/identity 测试。没有该 gate，三个 change 不应切 W1。

### P0-2：pairwise 几何的单位、覆盖面和保存后状态未定义

PM 的圆包络公式可证明保守，但“cell=max diameter+gap”若直接传 mm 会与当前像素坐标 `SpatialIndex` 错单位；所有现有校验/冲突代码仍使用单一 pitch。设计也没有写明：编辑后允许保存违规文档还是自动修复、重新加载是否重算 warning、选块填充是否先 pairwise gate。

可验证修复：冻结一个唯一 `requiredCenterDistancePx(a,b,grid)` 和 `maxCellPx` helper；覆盖 `validateEditable`、`resolveConflicts`、布局终局、relax/repair 的 mixed-size 测试；保存允许 warning 但导出必须阻断，并在 load/改径后立即重算 warning。测试应包含大钻/小钻、恰跨 cell、边界 gap、旋转异形和 20k 钻。

### P0-3：蓝图不是同一设计的可验证副本

两次 n:1 请求在协议上可行，但独立随机出图没有共同布局数据；当前 prompt 也没有把第一张效果图作为第二次请求输入。若把蓝图送排钻，用户会得到“视觉上像一对但钻位不同”的错误生产依据。

可验证修复：默认第二次请求必须携带效果图并使用 `/images/edits`；档案记录 `effectRequestId`/`blueprintRequestId` 和失败原因；送排钻入口显式要求人工确认，禁止把蓝图当 BOM 数据源。若验收标准要求逐钻一致，增加结构化布局来源与本地渲染 change，不接受 prompt-only 证据。

### P0-4：物理锚没有贯穿重放链

当前三个 2.5 副本与交接缺字段是源码事实（`studio.svelte.ts:56,162`、`gemprojReplay.ts:40-47,166`、`quickLayout.ts:64-69,168`、`ManualEditHandoff` 无 physical 字段）。如果用原图尺寸而不是实际降采样 canvas，`dimsMismatch` 路径会产生错误 px/mm；如果只把值放进 gemgen provenance，送排钻和专家工作台看不到它。

可验证修复：`gemgen -> handoff -> EditDocument/gemdoc` 全链路保存 `PhysicalCanvas`；replay 使用实际 `image.width` 计算，默认路径显式标记 `default`; 测试 2048→1024 降采样、非正方形画幅、缺失/错误声明和保存再加载后的钻径像素值。

### P0-5：v2 时序会让 add-project-files 2.x 返工

当前 parser 版本常量/接口仍 v1 且 migration map 为空；add-project-files 的 2.x 保存生命周期未落地。PM 方案“归档后紧随 bump”无法避免先实现 v1 serializer 的事实。

可验证修复：在 2.x 开工前落一个只含 v2 contract 的前置 gate（四格式字段、MIME、迁移入口、测试夹具）；2.x serializer 直接消费 v2 类型。完整迁移实现可以仍由 add-gem-catalog change 承担，但不能让 v1 成为新的写入真源。

### P0-6：`.gemshape` schema 不能防坏图、比例漂移和悬空校准

草案只声明 `texture.width/height` 与 `physical.widthMm/heightMm`，没有验证 dataUrl 解码后的真实尺寸、MIME/字节/像素上限，也没有规定物理宽高与贴图纵横比不一致时是裁剪、contain 还是拒绝。`calibration.mode='reference'` 时 `refSpecId` 是可选的，既可悬空又没有参考规格快照；“主径 px”也没有定义是整张贴图还是 alpha 内容 bounds。

可验证修复：parser 解码并校验实际宽高、允许 MIME、最大字节/像素、非空 alpha bounds；冻结 `fit`/物理 bounds 语义；reference 模式要求可解析 `refSpecId` 或内嵌 `refSpecSnapshot`，并在参考规格删除后保持可审计但不可重新校准。missing custom asset 必须 visible/typed，不得静默圆形降级后导出。

### P0-7：实验室新模式与现有 `LabTask.mode` 冲突

现有 `mode` 是 generate/edit endpoint 语义，新增 structured/product 若复用将破坏重试、归档和旧 gemgen 解析；`form.size` 仍是自由字符串并通过正则兜底（`lab.svelte.ts:83,162,191-203,707-714`）。

可验证修复：拆分 `requestMode`/`workflowMode`，给 `LabTask`、`.gemgen`、会话持久化和迁移测试补齐；把像素尺寸和物理画幅变成结构对象，保留 v1 字符串迁移只读兼容。

### P0-8：现有基线未绿，新增契约没有测试落点

本轮独立 `pnpm test` 已有 4 个失败，且 `rg` 显示新 shape/size/physical 符号尚未进入源码。不能把旧测试通过数当成三 change 的验收证据。

可验证修复：先修复/隔离现有 4 个失败，再为四格式 v1→v2、混合尺寸校验、蓝图双阶段、锚点重放、`.gemshape` 脏输入和缺失资产各加 typed contract tests；最后再做 Owner 端到端浏览器走查。

## 非阻塞建议

- 收编 `PIXELS_PER_MM` 到 engine/grid 单一出口；当前重复定义是稿件 §H-1 已指出的真实维护摩擦。
- SS_KEYS 当前缺 `SS24`（`engine/types.ts:12-25`）；可在目录 change 中补齐，但不应替代自定义 mm 能力，也不应阻塞本轮 contract gate。
- `8` 种改为默认值/可读性警告；legend 应支持分页或按形状分组。
- TERMS 中“工作台”禁用词的上下文语义应改成结构化规则，避免“排钻设计”与“专家工作台”的合法复用继续依赖人工解释。
- P0 先做 1k/10k/20k 异形路径与贴图渲染 benchmark；PM 只给任务草案，没有真实帧率证据。
- 蓝图失败/重试、missing custom asset、旧模板引用被删除、旧 gemgen 无 blueprint 四种状态都应在画廊和导入测试中显式展示。
- add-manual-edit-mode 的“画钻笔刷 snap 六方格位”被本稿覆盖，归档前必须把覆盖登记同步到正式 spec，避免 design 与 spec 分叉（PM §B.4/§H-3）。

## 三个 change 的放行条件

1. **add-gem-catalog-and-sizes**：先完成 P0-1、P0-2、P0-4、P0-6 的 contract gate，再实现 engine 与四格式迁移；不接受只扩字段、不扩 `GridSpec`/handoff 的切片。
2. **rename-and-expert-workbench**：依赖基础层稳定后实现；旋转属性提升 P0，编辑器保存/导出必须消费 pairwise warning。
3. **lab-dual-mode-and-blueprint**：依赖 P0-3、P0-7 和双阶段任务 schema；双图只能作为人审参照，直到有结构化布局证据。

在这些条件完成前，本稿适合继续做契约修订和交互原型，不适合作为三个 change 的规范性实现基线。
