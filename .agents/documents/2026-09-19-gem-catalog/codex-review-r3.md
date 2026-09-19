# R3 立项评审

评审基线：当前 HEAD `8e172d2`；只评文档可实施性与契约正确性，不以尚未实现本身扣分。三项 strict OpenSpec 校验均通过；未运行全量测试。

## 题①：add-gem-catalog-and-sizes Owner 裁决快审

### 结论

**NO-GO（W0 暂不能开工）**，`7.3/10`（R2 基线 `8.0/10`）。

Owner 的入库方向已经基本自洽：`.gemshape` 是唯一目录格式，`sys-shapes` seed 为 create-only，engine 仅保留迁移所需的 `SS_TABLE/specKey` bootstrap；迁移仍是纯函数，不读 IDB。`workflowMode` 在四件套中只剩退役、迁移和跨 change 说明语境，`rhinestone-studio/src` 无命中。`specKey` canonical、`refSpecId` 独立豁免、vectorPath 优先导出和六条 gate 的总体方向也正确。但 W0 parser/schema 仍有两个会改变实现和验收结果的歧义。

### 阻塞问题 P0

1. **`texture` 必填与 vector-only 设计互相矛盾。** `design.md:150-155` 将 `texture` 写成必填，同时 `design.md:153,173` 又允许 `vectorPath` 与 `texture` 二选一；六条 gate 的 `design.md:166-169` 还默认从 dataUrl 解码宽高、alpha bounds 和 fit。实现者无法唯一决定 vector-only seed 是合法输入，或必须伪造贴图才能过 gate。

   可验证修复：二选一并写入 schema/spec 与 fixture：
   - 将 `texture` 改为可选，冻结 vector-only 分支的非空归一化 path、单位框、几何 bounds、物理宽高/比例校验，并注明六条贴图 gate 哪些不适用；或
   - 明确所有 `.gemshape` 必须携带 texture，`vectorPath` 只是可选的渲染加速字段。

   验收：schema 类型与 parser 拒绝面一致；texture-only、vector-only、both 三类 fixture，以及对应坏输入/seed round-trip 均有 typed-error/成功断言。

2. **`specKey` 不可变与“可编辑资产 blobKey 换绑豁免”边界未冻结。** `design.md:187` 声称目录漂移不影响旧文档；但 `design.md:267,293` 和 spec `:48` 又允许 gemshape 可换绑保存，`GemSpecSnapshot`（`design.md:76-89`）只物化 `assetId`，没有 `vectorPath/texture` 快照。若换绑内容改变轮廓、贴图或 physical，同一 `assetId/specKey` 的旧文档输出会漂移，违反快照稳定语义。

   可验证修复：明确同一 specKey/assetId 的换绑仅允许不改变规格身份、几何和物理语义的内容；任何 shape/vectorPath/texture/physical 改动必须另建新资产/新 specKey（或把渲染所需快照完整物化进文档）。同时冻结 seed 只读、custom 另存和 CAS 换绑的判定字段。

   验收：换绑内容不变的成功 fixture；改变轮廓、贴图或 physical 的操作被拒绝或生成新 asset/specKey；旧文档在目录更新后逐位保持原快照；missing 四态仍按 `resolved/soft-deleted/blob-missing/wrong-kind-invalid` 阻断导出。

### 非阻塞建议

- `specKey?` 在文件 schema 中可选、seed 又必填、custom 由 ingest 派生，建议补一张 parser 条件矩阵，明确 v1 输入、seed、custom ingest 三处的必填时点。
- `design.md:170-175` 的 reference 校准已经兼容 `refSpecId`/`refSpecSnapshot`，应在 vector-only 修订后明确“不可重新校准但可审计”的路径不依赖贴图 alpha。
- W0 只验收 schema/纯函数和 typed error，PhysicalCanvas 运行时接线仍由 replay/handoff gate 承担；当前边界没有把未实现写成已完成。

### 评分依据

四格式 v2、迁移 bootstrap、canonical identity、workflowMode 退役和 gate 门序均比 R1 稳定，故保留 7 分以上；但上述两个 P0 会使 W0 parser 与资产稳定性无法唯一验收，不能沿用 R2 的 8.0 或给 GO。

## 题②：rename-and-expert-workbench 首评

### 结论

**NO-GO**，`6.4/10`。

R/A/C/S 四轨的 Owner“同步推进”裁决切片基本忠实：改名、架构、组件、service 四轨标为零 v2 契约依赖；D 轨在 `tasks.md:60-69` 明确依赖 W0、engine 与 `.gemshape`/replay gate。改名清单覆盖桌面/移动 Tab、toast、error、handoff 文案、注释、测试断言，TERMS v2 与 PRODUCT_MODEL v4 也有独立任务；C 轨消费现有 `EditGemFields`/`GridSpec`，S 轨先用 SS_TABLE mock，二者“不依赖 v2 类型”的自称基本成立。

### 阻塞问题 P0

1. **A 轨 handoff 拆分与 studio-layers replay/handoff ownership 冲突。** `tasks.md:39-40`、`design.md:105-110` 把 `buildManualEditHandoff`、`loadFromHandoff` 和 gemdoc lifecycle 直接搬入 `editHandoff.svelte.ts`/`gemdocLifecycle.svelte.ts`，并以“公共 API 不变、零行为变化”验收；而 studio-layers 已冻结 `buildManualEditHandoff` 必须改为各层 concat、逐钻 `GemSpecSnapshot`、`PhysicalCanvas`，且 `ManualEditHandoff`/`EditDocument` 与 round-trip 属于 replay/handoff gate（`studio-layers.md:494-501,518-524,542-548`）。当前“冲突时串行” prose（`design.md:101-113`）没有排除这两个函数，也没有文件级 owner、adapter 或交接锁。

   可验证修复：将 handoff 载荷构造、`ManualEditHandoff` 类型、`loadFromHandoff` 的 v2 消费和 gemdoc round-trip 明确移出 A 轨，归 studio-layers replay/handoff gate；A 轨最多移动薄 wrapper 并保留 root re-export。若必须先移动，先冻结 adapter：A 轨只搬文件和旧 API，studio-layers 是唯一修改 payload 的 owner，并在 tasks 增加文件级 ownership、依赖边和 adapter round-trip 验收。

   验收：A 轨任务不再直接改 handoff payload/EditorDocument schema；`rg`/import 面证明唯一 owner；旧 API re-export 编译通过；studio-layers gate 完成后有逐层 handoff identity/round-trip 测试，且没有双写路径。

### 非阻塞建议

- 将“studio-layers 未立项窗口相撞时串行”升级为明确的交接表（文件、符号、owner、允许的先行改动），避免仅靠 prose 解释冲突。
- `documentService` 虽保持 store 为真源，但应在任务中声明不得复制 handoff/document payload，避免与 A 轨和 replay gate 形成隐性第二实现。
- R 轨清单与禁改项（“送精修”、`.gemdoc`、app 名）完整；版本升版和 grep receipt 留到实现验收即可，不构成当前阻塞。

### 评分依据

改名覆盖面、并行 DAG 和 D 轨硬前置清楚，C/S 轨可先行性较强；扣分集中在 A 轨把未来必改的 handoff 载荷纳入“零行为变化”拆分，导致 studio-layers 尚未立项时仍无法安全开工。

## 题③：add-lab-drill-params-and-blueprint 首评

### 结论

**NO-GO**，`6.8/10`。

Owner 重定义已忠实落档：没有双模式；`drillParams` 与 `blueprint` 是模板级正交高级选项；`workflowMode` 退役而 `requestMode` 保留；蓝图 beta、非 BOM、人审参照；生命周期 stage 树先行；策略 B 串行默认、策略 A 并行默认关闭。提示词 service、stage 算法、TemplateEditor 三轨可先行，4.x 接线轨硬依赖 gem-catalog W0。十项自由裁断均有对应设计落点，但持久化恢复契约尚未闭合。

### 阻塞问题 P0

1. **刷新时 pending/running stage 的持久化与恢复语义缺失。** 当前源码 `taskStore.ts:28,69-105,159-160,223-256` 只有 `success/error/cancelled`，`restoreTask` 也只接受终态；新设计 `design.md:296` 又只写 `stages?: PersistedStageMeta[]（终态 stage 全量）`，但 spec `spec.md:48-50` 要求“刷新后 stage 状态随 PersistedTaskMeta 恢复”，而 stage 契约包含 `pending/running/success/error/cancelled/skipped`。文档没有规定刷新发生在主图运行中、蓝图等待中、蓝图运行中时如何处理 controller、requestId、重排、补偿归档和幂等性。

   可验证修复：明确一种并写进 spec/design/tasks 的策略，例如持久化 pending/running，hydrate 后将 running 转为 cancelled 或 pending/requeue（不复用旧 controller，重派发生成新 requestId）；或明确活动 stage 不落账本、刷新统一视为中断并要求用户重试。无论选哪种，都要冻结 stage 快照、drillParams/blueprint、materialAssetIds、requestId/assetId 的保存/恢复边界。

   验收：刷新 fixture 覆盖 main pending/running、main success+blueprint pending/running、失败后重试、legacy 无 stages；验证不会重复归档、不会复用旧 requestId、重试级联和 `reconcileUnarchivedResults` 幂等；配额降级不得丢 stage 快照。

### 非阻塞建议

- `design.md:290-296` 将 blueprint `error/cancelled/skipped` 终态立即归档，而 spec `:85-86` 用“用户不再重试即归档”叙述；统一自动归档触发条件，避免实现者误解为等待用户动作。
- `skipped` 在 stage 状态机中是独立终态，但 provenance 表又将其压成 `cancelled` 语义（`design.md:291`）；冻结“内部状态保留、档案投影压缩”的有意映射及错误码。
- `tasks.md:27` 的 0.4-④ 在当前 HEAD 已可判定通过：add-gem-catalog §1.3 已是正交键版本，且三件套 strict validate 通过；`design.md:391` 仍把该事项写成“主会话执行”的未决状态，建议改为 CLOSED/已验证，避免把已完成修订写成待办。该文案债不阻塞 A/B/C 先行。
- 三并行轨的边界正确；`PersistedTaskMeta`、lab store 接线和归档链属于 4.x，不能因当前源码仍为单请求模型而扣实现分，但必须把上面的刷新策略补进该轨验收。

### 评分依据

正交高级选项、素材注入策略、蓝图两策略、缺失 fail-fast、stage 级并发/重试和最小画廊面均已具体化；持久化状态恢复是跨刷新、重试、归档的基础契约，当前未定义使生命周期不能完整实现，因此暂不具备可开工的完整规范。

### 十项自由裁断逐项表态

| # | 裁断 | 表态 | 核对 |
|---:|---|---|---|
| 1 | 素材注入策略 | 支持 | 内置形只描述注入；自定义 `.gemshape` 作为附图，并按角色声明加入提示词。 |
| 2 | `enabled=false` 键形保留 | 支持 | 关闭不丢清单/physical/refs，四象限合法。 |
| 3 | `requestId` 本地生成 | 支持 | 每次 dispatch 使用 `crypto.randomUUID`，retry 必须新 id。 |
| 4 | 归档时点 | 支持，需统一文字 | main success 且 blueprint 未启用或已终态即可归档；失败/取消无图但落 provenance，需消除“用户不再重试”歧义。 |
| 5 | 主图纯净性 | 支持 | 主图 prompt 不含蓝图要求，蓝图要求只进入 blueprint stage。 |
| 6 | 并发预算 | 支持 | 按 stage/request 计，`MAX_CONCURRENCY=4`，数值与单 stage 现状等价。 |
| 7 | missing fail-fast | 支持 | 发起时 specKey 解析失败即 typed 中文错误；编辑器只警告，不静默降级。 |
| 8 | 素材附图顺序 | 支持 | `[案例,参考,...素材,...蓝图参考]`，素材去重、软上限 4、超出警告。 |
| 9 | 蓝图无清单 | 支持 | 退化为无编号纯转换，不伪造 BOM/编号来源。 |
| 10 | 画廊最小子态 | 支持 | 只增加展开位蓝图缩略/失败/重试状态，收起卡和既有主图投影不重构。 |

## 轻量验证记录

- `openspec validate add-gem-catalog-and-sizes --strict`：通过。
- `openspec validate rename-and-expert-workbench --strict`：通过。
- `openspec validate add-lab-drill-params-and-blueprint --strict`：通过。
- `rg -n 'workflowMode' rhinestone-studio/src`：无命中；四件套中的命中均为退役/迁移/跨 change 说明语境。
- 未运行全量 `pnpm test`/`pnpm check`/`pnpm build`；本报告不把未实现或未跑全量门误写为已完成。

## R4 快审：R3 P0 修订复验

复验基线：`ade0d76`。本节只核 R3 三题 P0 修订是否闭合，不重新展开非 P0 全面评审。

### 题① gem-catalog

**结论：GO（W0 可开工）**，`8.2/10`（R3 `7.3/10`）。

- **P0-1 已闭合。** `design.md:150-155,173`、`spec.md:10-12,56-60` 和 `tasks.md:0.4,0.6,0.7` 统一为 `texture` 必备、`vectorPath` 可选渲染加速；vector-only 明确 typed error 拒收；texture-only/both 合法 fixture 与 vector-only 坏输入均进入 W0 receipt。六条 gate 不再存在 vector-only 豁免分支，schema、spec、tasks 验收口径一致。
- **P0-2 已闭合。** `design.md:187,267,270`、`spec.md:48` 和 `tasks.md:0.6,2.2` 明确 `.gemshape` 内容不可变；`texture/vectorPath/physical/calibration/specKey` 任一变更必须另存新 `assetId/specKey`，不走 blobKey 换绑；就地编辑仅允许元数据改名。由 `GemSpecSnapshot`/assetId 引用的旧文档不会因目录资产换绑而漂移。
- `specKey` 三处必填时点与 reference 审计不依赖后续 alpha 的补充矩阵已落档；`workflowMode` 仍仅为退役/迁移说明语境，未发现新的活动写入要求。

因此 W0 的 parser/schema 与资产身份均已有唯一可验收解释；实现尚未发生不影响本次“能否开工”判定。

### 题② rename-and-expert-workbench

**结论：GO（R/A/C/S 四并行轨可开工）**，`8.3/10`（R3 `6.4/10`）。

- **handoff ownership P0 已闭合。** `design.md:105-125` 与 `tasks.md:38-48` 建立文件/符号/owner/允许先行改动四列交接表：`buildManualEditHandoff`、`ManualEditHandoff`、`loadFromHandoff`、`EditDocument`/gemdoc schema 与 round-trip 的唯一修改 owner 是 studio-layers replay/handoff gate；A 轨涉 payload 文件只能搬移并保留 root re-export 薄 wrapper，禁止改 payload/schema。
- **依赖边已落死。** `tasks.md:7-14,52-55,83` 将 v2 payload 消费拆到 D 轨 5.9，硬前置为 studio-layers replay/handoff gate；2.6 明确 re-export 编译、既有测试零变化、payload 符号语义面 diff 为零及无第二修改点；`documentService` 也声明不复制 payload。R/A/C/S 可在不消费 v2 类型或 gate 产物的前提下先行，D 轨仍按硬前置等待。

未发现 R3 handoff ownership P0 的残留矛盾；四并行轨的开工判定成立。

### 题③ add-lab-drill-params-and-blueprint

**结论：GO（三并行轨可开工）**，`8.1/10`（R3 `6.8/10`）。

- **刷新持久化 P0 已闭合。** `design.md:298-306`、`spec.md:40,48-53`、`tasks.md:40` 三处一致冻结 terminal-only：pending/running 不落账本，刷新视为活动 stage 中断丢弃，不恢复 controller；终态 stage 恢复 `requestId/assetId` 与 drillParams/blueprint/materialAssetIds；重试生成新 requestId；main success 且蓝图中断显示“蓝图已中断，可重试”。legacy 无 stages 的只读合成仍保留。
- **归档/幂等 P0 已闭合。** `design.md:285-305,341-346`、`spec.md:82-92`、`tasks.md:53` 统一为自动双档：main success 即单图档，blueprint 终态自动生成双图完整档，两档并存；失败/取消/skipped 的 provenance 投影、双档分别判重、配额降级不得丢终态快照均有明确规则。刷新中断后的蓝图重试从 main 归档字节取输入，不依赖用户先执行归档。
- **跨 change 核对门已闭合。** `design.md:401` 将 `add-gem-catalog §1.3` 正交键修订和 `0.4-④` 标为已验证通过；tasks 的 4.x 硬前置与当前状态一致。

因此 service/算法/组件三并行轨可开工，4.x 接线轨仍正确等待 gem-catalog W0；未发现 R3 生命周期 P0 的残留契约缺口。

### R4 轻量验证

- `openspec validate add-gem-catalog-and-sizes --strict`：通过。
- `openspec validate rename-and-expert-workbench --strict`：通过。
- `openspec validate add-lab-drill-params-and-blueprint --strict`：通过。
- `rg -n 'workflowMode' rhinestone-studio/src`：无命中；文档命中均为退役/迁移/跨 change 语境。
- 未运行全量测试；本节 GO 仅表示相应并行/contract gate 可按冻结契约开工，不代表实现或收尾绿门已完成。
