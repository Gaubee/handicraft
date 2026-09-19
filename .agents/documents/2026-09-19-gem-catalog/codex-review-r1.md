# add-gem-catalog-and-sizes R1 立项评审

评审对象：当前 HEAD `f375985`（包含 `dae2fa9` 的四件套与日期修正）。
范围：`proposal.md`、`design.md`、`tasks.md`、`specs/gem-catalog/spec.md`，并与 R2 终审、`add-project-files` 三件套及当前 `rhinestone-studio` 源码交叉核对。

## 结论

**CONDITIONAL GO / W0-GATE-ONLY。**

这四件套已经把 R2 的 gate 宿主、五段门序、canonical `specKey`、三参 helper、per-layer `specKey`/物化快照和 2.x serializer 硬依赖落到了可执行文档中，足以进入 W0 contract-gate 的准备工作；但当前文字不能作为“无条件通过 W0”的规范基础。`tasks.md:26` 把 engine/replay 行为测试混入“零业务实现”的 W0 验收，且 `add-project-files` spec 仍同时保留 v1 normative baseline，与本 change 的四格式 v2 MUST 形成双真源。两项修正完成前，不得宣布 W0 完成，也不得开工任何 2.x serializer、engine 之后的 replay/studio 切片。

五段顺序本身与 R2 一致：contract → engine → replay/handoff → studio → add-project-files 归档同步（`design.md:12-18`、`openspec/changes/add-project-files/design.md:173-186`）；“任何 2.x serializer 先过 W0”也已在 `design.md:37-41` 与 `openspec/changes/add-project-files/design.md:191-193` 写成硬门，问题在于 v1/v2 spec 的 normative 文本尚未同步收敛。

当前源码仍是文档所描述的 v1 状态：`Gem`/`EditGem` 没有规格字段（`rhinestone-studio/src/lib/engine/types.ts:68-91`），`GridSpec` 仍带 `ss`（同文件 `:111-154`），BOM 仍按颜色并消费 `g.ss`（`rhinestone-studio/src/lib/engine/export.ts:89-103`），四格式版本仍为 1（`rhinestone-studio/src/lib/persistence/projectFile.ts:51-56`、`labFile.ts:37-41`），`ENGINE_VERSION` 仍为 1（`rhinestone-studio/src/lib/engine/version.ts:16`）。这些是待实现内容，不作为本轮扣分项。

## 阻塞问题 P0

### P0-1：W0 验收字面上依赖后续 engine gate

证据：W0 被定义为“类型 + typed error + 迁移入口 + fixture，零业务实现”（`design.md:52`、`tasks.md:18`）；但 `tasks.md:26` 的 0.7 原文要求“跨层 mixed-size/旋转/边界测试全部通过”。这些测试依赖 `requiredCenterDistancePx`、`maxCellPx`、mixed-size `validate`/`conflict`/`exportGate`，实际被排在 engine gate `tasks.md:30-36`，并且跨层结果组织属于 R2 的 replay/studio gate。按当前 DAG，W0 在 engine 尚未实现时不可能通过自身验收，违背 R2 的 `W0-GATE-ONLY` 门序（R2 终审 `codex-review-r2.md:12-14,40-48,98-104`）。

可验证修复：

- 将 0.7 拆为“W0 contract receipt”和“最终合流 receipt”：W0 只验收 TypeScript/canonical identity、精确 helper 签名、四格式 v1 fixture/round-trip/向前拒读/typed error、`.gemshape` 六条 gate、PhysicalCanvas px/mm 不变量；
- 将跨层 mixed-size/旋转/边界行为测试保留在 `1.7`/replay gate，并在最终合流门逐字引用 R2 P0-1 原文；
- 验收时证明 2.x serializer 的首个写入路径仅在 W0 receipt 通过后出现，且不存在 v1 新写路径。

### P0-2：`add-project-files` spec 与本 change 的 v1/v2 双真源仍未消歧

证据：`openspec/changes/add-project-files/specs/project-files/spec.md:7` 明确写“本 delta 冻结 v1 基线与格式边界”，其设计仍给出 `formatVersion:1`、顶层 `physics{ss,...}` 与 `activeStrategy`（`openspec/changes/add-project-files/design.md:9-14`）；本 change 则在 `specs/gem-catalog/spec.md:38-45` 强制四格式 1→2，且在 `design.md:129-136` 把 `.gemproj` 改为 `layers[].physics.specKey`。`add-project-files/design.md:176-193` 只登记了移交与时序，未将其 spec delta 改成“历史 v1 输入/兼容基线、v2 唯一写入真源”。实现者仍可从两份 ADDED Requirements 得到互斥要求。

可验证修复：在 `add-project-files` spec 明确 v1 条款仅表示迁移输入/历史兼容，v2 schema 与首写路径唯一由本 change W0 + studio-layers 承接；补一条 supersedes/owner 声明和 v1→v2 场景。随后 `openspec validate --strict`、serializer 写路径 grep（首写只允许 v2）及无孤儿 DAG 检查必须同时通过。

## 非阻塞建议

1. `design.md:99-101` 的“`specId` 全部清零”应明确是独立身份字段/持久化别名的 exact-key 规则；同一文档 `:149-150` 与 spec delta `:57-63` 仍使用校准来源 `refSpecId`。R2 原稿也明确要求解析 `refSpecId/refSpecSnapshot`（`codex-review-r2.md:62`），所以应写成“禁止 `specId` 身份字段，允许且单独定义 `refSpecId` 校准引用”，或统一改名为 `refSpecKey`，并给出带边界的 grep 断言。
2. `specs/gem-catalog/spec.md:29-36` 说 PhysicalCanvas 进入“四格式 v2 schema”，但 `design.md:131-134` 只在 `.gemproj`、`.gemdoc`、`.gemgen` 列出 `physicalCanvas`，`.gemtpl` 没有。应明确 `.gemtpl` 不承载画幅锚，或补字段、迁移默认值和 fixture。
3. `design.md:131` 的“可选内联快照缓存键”没有字段名、版本、解析优先级或失效行为，而 `LayerRecord` 只有 `physics.specKey`（上游图层稿 `studio-layers.md:453-460`）。建议 W0 直接冻结“层配置只存 `specKey`，输出/编辑结果物化 `GemSpecSnapshot`”，删除未定义的缓存键；若保留则补完整 schema 与 parser 拒绝面。
4. `.gemshape` 的弱引用方向正确，但 `design.md:252`/`tasks.md:41` 只写“missing 四态”，未列状态名、软删/硬清/编辑 pin 的转移矩阵。应至少列出 resolved、soft-deleted、blob-missing、wrong-kind/invalid 等具体态，并为每态写导出行为；这不阻塞 W0 类型冻结，但阻塞 2.2 vertical slice 验收。
5. `proposal.md:6`、`design.md:99` 所称“全库 rg 零命中”只能对源码树成立；当前 change 与上游文档本身大量出现这些词。改为“`rhinestone-studio/src` 与 serializer/runtime surfaces 无命中”。`design.md:211`、`tasks.md:33` 的 `edit.svelte.ts:126` 也应补全为 `rhinestone-studio/src/lib/stores/edit.svelte.ts:126`。
6. `PhysicalCanvas` runtime 接线划给 replay/handoff/studio 的边界（`design.md:168-170`）与 R2 一致；应在 W0 receipt 中只验证 schema/纯函数，不把当前未接线误写成完成。

## 轻量验证与现状核对

- `openspec validate add-gem-catalog-and-sizes --strict`：通过。
- `rhinestone-studio` 内 `pnpm check`：`svelte-check` 0 errors / 0 warnings。
- 聚焦 `pnpm exec vitest run src/tests/lab/gemgenArchive.test.ts`：1 file、10/10 tests 通过；有 jsdom `HTMLCanvasElement.getContext()` 未实现提示，不能替代全量 receipt。
- `c930a01` 的 `whenIdle`/归档竞态修复可以作为基线债已处理的代码证据；但 R2 要求的 66/66 files、864/864 tests receipt 仍未落档，按 `tasks.md:47` 留在 3.1，不能提前宣称全量绿门。
- 当前源码行号抽查与文档基本一致：`projectFile.ts:51-56,113-128,194-225`、`labFile.ts:37-41,106-121`、`edit/gemprojReplay.ts:158-213`、`stores/studio.svelte.ts:55-62`、`edit/quickLayout.ts:64-69` 均仍是 v1/三处 2.5 副本事实。未实现本身不计为缺陷。

## 评分

**7.1 / 10。** 相比 R2 终审三项 `studio-layers 6.4`、`expert-workbench-and-sizes 6.5`、两稿合流 6.1（`codex-review-r2.md:130-138`），本 change 已实质解决了 R2 最关键的宿主归属、三参 helper、`specKey` canonical identity、per-layer schema 方向和 2.x 硬依赖，故上调；但 W0/engine 验收边界和 add-project-files v1/v2 双真源仍是规范级阻塞，另外 PhysicalCanvas 覆盖范围、校准 ID 命名和 LayerRecord 快照承载仍需收紧，因此不能评为 GO 或超过约 7 分的可直接开工规范。

## 13 项自由裁断逐项表态

| # | 裁断 | 结论 | 评审口径 |
|---:|---|---|---|
| 1 | `rotationDeg` 放入 `GemSpecSnapshot`，但不进入身份 | **支持** | 作为物化输出/逐钻字段；不进入 `specKey` 或 BOM 聚合键，`Gem`/`EditGem` 同步承载；圆钻缺省，异形可编辑（`design.md:69-82,200-214`）。 |
| 2 | `requiredCenterDistancePx` 冻结为 `(a,b,grid)` 三参 | **支持** | 与 R2 P0-2 建议一致；`grid.gapMm` 与 `grid.pixelsPerMm` 是唯一单位来源，禁止二参/四参别名（`design.md:108-123`）。 |
| 3 | `GridSpec` v2 派生化并新增 `gapMm` | **支持** | `BaseSpec → GridSpec`，`{pitchMm,gapMm,rowAngleDeg,pixelsPerMm}`；`gapMm` 是 pairwise/maxCellPx 单一真源（`design.md:102-105`）。 |
| 4 | 移除 `GridSpec.ss` 并登记旧消费者 | **支持，需补齐清单** | `buildBom` 的 `g.ss`、`ProjectSummary.ss` 已点名；还应把 `stores/edit.svelte.ts:514` 等摘要构造列入迁移矩阵，旧 v1 fixture 只在迁移入口读取 `ss`。 |
| 5 | `.gemproj` v2 层配置只存 `specKey`，输出钻物化快照 | **支持，收紧表述** | 与 R2 §三-3 一致；删除顶层单一 `baseSpec`。`design.md:131` 的“可选内联快照缓存键”未定义，应删除或冻结完整 schema。 |
| 6 | W0 冻结 `LayerRecord` 类型，reducer/store/UI 归 studio-layers | **支持** | W0 只冻结类型、`rest` 不变量和 parser 拒绝面；实现宿主边界清楚（`design.md:136`、上游 `studio-layers.md:453-460`）。 |
| 7 | `PhysicalCanvas` schema/纯函数归本 change，runtime 接线划出 | **支持** | 本 change 验证 schema、实际降采样宽、default 2.5 与 `dimsMismatch`；handoff/replay/edit 接线由 replay/handoff/studio gate 承担（`design.md:166-170`）。 |
| 8 | `ENGINE_VERSION` 随 validate/conflict/export 语义变更从 1→2 | **支持** | 这是语义 bump，不以“旧输出仍可运行”掩盖版本变化；需写入 `version.ts` 并验证横幅（`design.md:216-225`）。 |
| 9 | 输出不变的 CVT 优化/SS24 补档不 bump，单规格逐位护栏双保险 | **支持** | 优化前后同参快照逐位相等，单规格 v1/v2 钻位逐位相等；SS24 仅在常量收编后补档并留下纪律注释（`design.md:219,224,238-240`）。 |
| 10 | helper 在 W0 冻结，实际 pairwise/validate/exportGate 在 engine gate 实现 | **支持，但需修 0.7** | 责任分段正确；当前 0.7 把行为测试提前成 W0 gate，必须按 P0-1 拆 receipt（`tasks.md:20-36`）。 |
| 11 | `.gemshape` 引用弱引用、编辑校准期间 pin、删除后 missing typed/导出阻断 | **支持，需列四态矩阵** | 弱引用不阻止软删/回收，硬清由既有 blob GC；pin 只保护编辑中的校准参考，不能把文档引用误升级为硬 pin（`design.md:242-253`）。 |
| 12 | CVT 优化作为独占切片，不与其他 engine 改动并行 | **支持** | `tasks.md:4-6,34` 的独占约束合理；必须保留 CPU oracle、输出逐位与 `<10s @1024²` 的同一 receipt。 |
| 13 | `gemgenArchive` 竞态按 c930a01 计为已修复，全量 receipt 归 3.1 | **支持** | 聚焦复跑 10/10 支持修复方向，但不等于全量绿；`tasks.md:47` 保留 receipt 欠缺与 3.1 收尾门是正确的，不应把聚焦绿写成全量完成。 |

## R2 快审（fc88751）

### 结论

**GO（W0-GATE-ONLY）**。R1 的两项 P0 修订均已闭合，规范现在足以允许 W0 contract gate 开工；GO 不代表 W0、engine、replay 或 serializer 已实现/已验收。

### P0 闭合核对

- **P0-1 W0 验收拆分：已闭合。** `tasks.md:19-27` 将 0.7 收敛为六项 contract receipt：TypeScript/canonical exact-key grep（`refSpecId` 独立豁免）、三参 helper 唯一签名、四格式迁移/round-trip/向前拒读/typed error、`.gemshape` 六条坏输入、PhysicalCanvas schema/纯函数，以及 serializer 首写证明与 v1 新写路径清零。`tasks.md:37` 将跨层 mixed-size/旋转/边界行为移到 engine/replay 收口，`tasks.md:49` 和 `design.md:176-185` 保留最终合流验收；`design.md:37-41`、`add-project-files/design.md:191-196` 仍把任意 2.x serializer 首写置于 W0 之后的硬依赖。因此 W0 不再依赖后续 engine 行为实现。
- **P0-2 双真源消歧：已闭合。** `add-project-files/specs/project-files/spec.md:7-10` 与 `design.md:9` 明确 v1（`formatVersion:1`、`physics{ss,...}`、`activeStrategy`）仅为迁移输入/历史兼容基线，v1→v2 读入口由本 change W0 承接，本 change 不产生 v1 新写入；v2 schema/首写唯一归 add-gem-catalog W0 + studio-layers，并新增 v1 文件读入场景。其余 v1 字段命中均处于该兼容注释或迁移上下文，未发现互斥的 v1 写入要求。

### 非阻塞项

`tasks.md:9-10`、`design.md:180,185` 将 R2 P0-1 描述为“前两句/第三句”，而上游原文是修复句加验收句，所谓第三项是验收句内的第三个逗号分句。建议改称“前两项/第三项验收分句”，以保持可追溯措辞精确；不影响 W0 门序或开工条件。serializer 首写证明仍应在实施时以 receipt、写路径 grep 和提交顺序证据落档，本轮不把它误判为已完成。

### 轻量验证与评分

- `openspec validate add-gem-catalog-and-sizes --strict`：通过。
- `openspec validate add-project-files --strict`：通过。
- `git diff --check f8a3d78..fc88751`：通过。
- `rg -n '"specId"|\bspecId\s*:' rhinestone-studio/src`：无命中；现有源码仍为 v1、W0 尚未实现，按评审边界不扣分。
- 未运行全量测试；全量 66/66 files、864/864 tests receipt 仍由 3.1 留待实现收口。

**8.0 / 10（相对 R1 7.1 上调 0.9）。** 上调来自两个规范级阻塞已消除、W0/engine/replay 五段门序与 owner/依赖重新可执行；仍保留少量引用措辞精度债和未实现的全量 receipt。相较 R2 终审三项 `studio-layers 6.4`、`expert-workbench-and-sizes 6.5`、两稿合流 6.1，本 change 已把其关键 contract 宿主、首写时序和双真源边界落到可开工的 W0 文档，但评分仍不等同于实现完成度。
