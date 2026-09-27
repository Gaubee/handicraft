# add-workbench-pro v3 整改复核

## 结论

**NEEDS-WORK；综合 7.6/10（上轮 9.0，下降 1.4）。**

本轮确实落地了 Owner 要求的三栏工作台、右侧策略与钻选择器、历史 dock、三种预览模式，以及 journey 基线播种。契约、daemon、studio 的主体路径和红线保持良好，独立测试也大面积通过。但当前仍有两个会影响 Owner 反馈闭环的前端 P1 时序问题，daemon typecheck 还有确定的编译失败；journey 播种的跨进程幂等、双工件校验和错误可观测性也没有达到生产级收口。

## 阻塞问题

### P1-1 历史面刷新存在丢刷新和串任务风险

证据：`rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1430-1441` 在 `treeHistory.loading` 时直接返回。结构写入后的 `noteStructureWrite()` 只在历史 dock 打开时触发拉取（`:1232-1237`）。因此首个 `tree.history` 请求尚未完成时发生 rename/reorder/revert，写后刷新会被吞掉，dock 继续显示旧链。该请求也没有捕获 `taskId`/请求序号，快速换任务时迟到响应可以覆盖新任务历史。

修复建议：为 history 请求保存 `taskId + seq`，响应只接受仍匹配当前任务和序号的结果；loading 期间设置 `pending/dirty`，在 `finally` 自动执行一次最新请求。为“写后刷新”和“换任务”各加一个延迟响应回归测试。

### P1-2 previewMode 快速切换失败时会丢失最后意图

证据：`store.svelte.ts:520-525` 先修改全局 `previewMode`，再把 `syncViewState` 排入串行队列；队列执行体在 `:452-456` 读取可变的全局值，失败时在 `:459-468` 无条件回滚调用时的旧值。连续 rendered→holes→numbered，若第一笔 RPC 失败，第一笔回滚会把全局值改回 rendered，排队的第二笔随后读取到错误值，最终 numbered 意图丢失。

修复建议：每次写入捕获 `requestedMode` 和 generation；请求体使用捕获值，失败仅在当前 generation 仍是该请求时回滚，并保留队列中最新意图。补充连续切换、首笔失败、第二笔成功/失败的测试，并明确模式是否进入 view undo（当前不进入任何 undo 域）。

### P1-3 daemon typecheck 当前失败

独立执行 `pnpm --filter @handicraft/daemon typecheck` 失败：`daemon/scripts/walkthrough-v3-seed.ts:63` 的 `PROFILE as const` 产生只读 `bands`，不能赋给 `StoneService.createStone` 要求的可变数组类型。该错误位于本轮 v3 走查脚本，但会使 daemon 类型门失败，必须修复后才能称为可发布。

修复建议：将脚本常量改为满足目标可变类型的显式注解/拷贝（不要用只读断言直接传入），重新跑 daemon typecheck 与全量测试。

### P1-4 若要求滚动升级，协议组合不兼容

`TaskDetailResponse.stoneCandidates` 在 `contracts/src/workbench.ts:166-185` 变为必填且顶层 strict。旧 daemon→新前端缺字段会整包 parse 失败；新 daemon→旧前端的未知字段也会被旧 strict schema 拒绝。新 studio 每次 `view.state.set` 无条件发送 `previewMode`（`store.svelte.ts:452-456`），旧 daemon 的 strict `ViewStateSetInput` 同样会拒绝该键；旧前端读取含 `previewMode` 的新 view-state 工件时也可能被旧 strict schema 拒绝。旧 daemon 还不能读取 v8 的 `journey` cause。

这不是单波次锁步发布的代码阻塞，但若部署采用滚动升级则是发布阻塞。修复路径二选一：传输层做版本/能力协商并对缺省字段归一；或明确原子锁步升级，在发布门中禁止混合版本，并补充旧/新组合测试。

## 重要但非立即阻塞

### journey 播种的并发和快照完整性

- `daemon/src/kernel/workbench.ts:392-406` 在事务外 SELECT 链尾，只比较 `tree_blob_ref`，随后 `recordTreeVersion()` 才在事务内 `MAX(version)+1`。两个 daemon/process 可同时看到同一旧尾并插入相同 seed；内容等价但历史版本数和 undo 游标会重复增长，故不是严格幂等。应把“读尾、比较双工件、插入”放入同一写事务，或增加内容对 `(treeBlobRef, previewBlobRef)` 的原子幂等约束/冲突重试。现有 `daemon/tests/workbench-pro-v3.test.ts:207-230` 只有串行重复读取，没有并发测试。
- 同一处只调用 `loadTree()`，没有校验 `currentPreviewBlobRef` 可读；缺 preview 时仍可能播种坏历史，直到 revert 才暴露。seed 前应对 tree 与 preview 都做可读性校验，并覆盖缺失 preview 的测试。
- `catch {}`（`:397-409`）会把 fence、工件损坏、SQLite busy、约束错误和程序错误全部吞掉。建议只吞可预期的工件/fence错误，其余记录日志/指标并上抛或返回可观测错误。
- RPC 先扫描帧得到 refs，再调用内核（`daemon/src/rpc.ts:1329-1334`）；两步之间若电流树推进，可能播种过时引用。可在 seed 前重新读取最新帧引用，或加 current-ref CAS。

### 候选钻面范围需继续锁定

`projectStoneCandidates()` 使用 `stone_index` 的共享读投影（`daemon/src/kernel/strategies/design.ts:276-289`），而不是按 task owner 过滤。既有 D-1 语义明确共享库可读，因此不能直接判定跨租户泄漏；但应补双 owner 回归，证明共享读是有意契约，同时确认 activeSet 仍严格 owner 校验（`:294-303`）。投影失败在 `rpc.ts:1187-1204` 静默降级为空数组，建议至少记录可观测原因，区分“无库存”和“数据库/投影故障”。

### 选择器空选与真源分叉

`WorkbenchInspector.svelte:122-134` 允许用户把已有钻全部取消，但 `store.svelte.ts:944-968` 只在 `stoneIdx.length > 0` 时发送字段并更新本地 stones；空数组会被当成“继承旧钻”。界面显示“已选 0”，应用后真源仍保留旧钻。应禁止空选应用并提示，或明确定义清空语义并让 RPC/本地投影一致。

### 三模式性能护栏并未限制主体 DOM

`StrategyCanvas.svelte:206-231,234-248,252-280` 三个分支都逐颗创建 SVG circle；≤2000 只限制 rendered 高光，≤300 只限制 numbered 逐孔文字。超过阈值仍会创建全部主体节点，100k 点阵仍可能造成 DOM、布局和内存压力；numbered 还按半径条件跳过部分 ≤300 标号（`:268`）。建议用 2,001/301/大工件真实浏览器测帧时、DOM 和内存，必要时做分块/虚拟化，并明确“超过 300 只显示分组徽标”是产品降级而非逐孔编号。

### v8 迁移回归缺口

`daemon/src/db/schema.ts:355-377` 的 v8 重建逻辑方向正确，但现有 `daemon/src/db.test.ts:132-159` 仍是 v7/六值测试，v3 setup 直接创建最新版数据库。应增加真实 v7 数据库迁移到 v8、既有六值无损、journey 可插入、重复 migrate 幂等的测试。

## 红线核查

- `engine/`：5 个提交无改动。
- CanvasKit：工作台仍通过 `$lib/canvaskit.js` 的视口/坐标转换，未绕过单源；`WorkbenchCanvasStage` 与 brush overlay 使用同一映射。
- undo：`journey` 归 tree-structure，`mask-patch` 归 mask-edit，view-state 仍独立；`undoDomains.svelte.ts`、`canvaskit.ts`、BrushLayer 未被本轮改动。预览模式本身不进入 undo，需在产品语义中明确。

## 独立验证

本地针对当前 HEAD `1dc5e1a`，未修改既有工作区文件（仅保留原有 `openspec/changes/add-workbench-pro/perf-receipt-20260927.json`）：

| 门 | 结果 |
|---|---:|
| contracts 聚焦/全量 | 11 文件，170/170 通过；typecheck 通过 |
| daemon v3 聚焦 | 5/5 通过 |
| daemon 全量（排除 E2E） | 65 文件，856/856 通过 |
| daemon typecheck | **失败**：`walkthrough-v3-seed.ts:63` |
| studio v3 聚焦 | 13/13 通过 |
| studio 2c 聚焦 | 27/27 通过 |
| studio 全量 | 198 文件，2436 通过，1 跳过 |
| studio svelte-check | 0 errors，0 warnings |
| studio `perf:gate` | 本轮未运行；真实浏览器大点阵验收仍需 Owner/发布环境补做 |
| `git diff --check 853e67f^ 1dc5e1a` | 通过 |

Vitest/jsdom 输出了既有 `HTMLCanvasElement.getContext()` 未实现提示；这不影响上述组件断言，但不能替代真实浏览器的大点阵视觉/性能验收。Owner 提供的 9 张截图、14/14 CDP 断言和跨 daemon 重启保持 numbered 的证据支持三栏布局、模式持久化和基本交互；这些证据与本地 jsdom/源码验证分开计入，仍不能覆盖上述前端时序和真实浏览器性能问题。

## 实现质量评价与评分依据

- 功能覆盖：三栏、历史 dock、候选钻选择器、服务端 previewMode、journey 基线均已接线，较上轮有明显进展。
- 代码结构：契约、RPC、内核和 UI 接口边界清楚；坐标单源和 undo 分域保持，测试命名及注释较完整。
- 生产完整性扣分：typecheck 红灯；历史刷新和模式写队列存在 P1；journey 并发/双工件/错误分类不足；跨版本组合没有明确发布门；三模式性能证据不足。

**建议修复顺序：** 先修 daemon typecheck、history 请求 token/pending、previewMode generation；再决定锁步升级或兼容传输；随后补 journey 原子幂等/双工件校验、v8 迁移测试、空选语义和 2,001/301 浏览器性能验收。完成这些后再复评，才有条件回到 9 分以上。

---

# 二轮复评：修复轮

复核基线为当前 HEAD `3789598`，逐笔检查 `bde0fea` 与 `3789598` 的实际 diff，并独立重跑本轮门禁。上轮报告中的结论和证据保留在上方；本节只记录修复轮复评。

## 二轮结论

**Owner 验收：GO；综合 8.9/10（上轮 7.6，+1.3）。**

上轮两个 P1 时序问题、daemon typecheck 阻塞和 B3 回退树缓存问题均已由源码和新增回归测试闭合。journey 播种已把“读尾—比较—版本号—插入”放进 `BEGIN IMMEDIATE` 事务，双工件可读性校验和异常日志也已补齐。按用户指定的原子锁步升级策略，上一轮 P1-4 不再要求本轮增加协商代码，但发布门必须真正禁止混合版本。

当前没有发现新的 v3 P1/P0 阻塞。保留的都是 P2 质量/测试完整性问题，见下文；它们不阻止 Owner 验收，但不应被提交说明中的“并发/全绿”表述掩盖。

## 逐项裁定

### A. historySeq + pending：已闭合

`store.svelte.ts:1482-1507` 在请求发起时捕获 `reqTaskId` 和递增 `historySeq`，成功/失败落地前同时校验两者；换任务的迟到响应不能污染新任务。`treeHistory.loading` 时不再丢弃拉取意图，而是设置 `historyPending`，`finally` 自动补拉（`:1483-1505`）。

新增 F2 测试覆盖两条关键窗口：首个 history 在途时 rename，旧快照先返回、补拉后落新链；任务 A 迟到响应在任务 B 已装载后到达，不改变 B 的历史（`workbench.v3.test.ts:317-383`）。这覆盖了上轮指出的“写后刷新在途”和“换任务”时序。实现上，旧请求的 `finally` 可能在新任务请求期间触发一次额外补拉，但只会产生冗余请求，不会落地错误历史。

### B. previewMode 代次：已闭合

`store.svelte.ts:461-507,557-563` 现在捕获请求体 `requestedPreviewMode` 和 `previewModeSeq`，队列执行不再读取可变全局值；失败回滚只有在 `previewModeGen === previewModeSeq` 时才生效。于是第二笔已成功后，第一笔迟到失败不会再回滚第二笔模式；第二笔仍负责把最终意图写透。F4 回归明确断言首笔请求携带 holes、第二笔携带 numbered、最终本地和服务端均为 numbered（`workbench.v3.test.ts:424-451`）。

代价仍是预览模式不进入任何 undo 域，这是明确产品语义，不属于本轮缺陷。

### C. B3 回退树刷新：已闭合；mask-patch 不应置结构 dirty

`nodesDirtySinceLoad` 在 `store.svelte.ts:163-169,1270-1277` 对 split、rename、reorder、delete、revert 的结构写统一置位；`loadWorkbench(refresh)` 完成后清零，`treeUnchanged` 还要求 `!nodesDirtySinceLoad`（`:288-308`）。`confirmTreeRevert` 在刷新前额外置位（`:1534-1549`），覆盖 ref 回拨窗口。

mask-patch 没有遗漏：它属于 `mask-edit` undo 域，提交后立即调用 `loadWorkbench(refresh:true)`，由服务端 tree ref/节点内容全量读回并清零 dirty（`:1217-1224`），不应再调用 `noteStructureWrite()`，否则会错误推动 tree-structure undo。F3 内容寻址 spy 回归确认回退后图层名恢复为“帽子”，不是本地 rename 后的“魔术帽”（`workbench.v3.test.ts:385-421`）。

### D. journey 事务化：实现闭合，测试并发边界需如实标注

`daemon/src/kernel/workbench.ts:1575-1613` 的 `seedJourneyBaseline()` 使用 `this.deps.db.transaction(...)` 后调用 `commit.immediate()`；读链尾、比较、取 `MAX(version)`、插入和 stale 标记均在 callback 内。因此 `better-sqlite3` 的同步 API 下，事务确实覆盖了上轮指出的读—比—插全窗，第二个连接只能在第一个 immediate 事务提交后读取链尾，重复 seed 返回而不插第二行。

双工件可读性校验在进入事务前完成（`:394-409`），这对内容寻址不可变 blob 足够防止把坏快照写入历史；缺 preview 的回归也已通过。未预期的非 `TaskWorkbenchError` 会 `console.warn`，不再无声吞掉 SQLite/程序错误。

但新增测试名称虽为“并发播种”，实际是同一 Vitest 线程中先调用连接 A、再调用连接 B（`daemon/tests/workbench-pro-v3.test.ts:265-313`），没有 worker/process 级重叠持锁。它验证了双连接的提交后幂等结果，不能独立证明锁竞争下的等待/`SQLITE_BUSY` 行为。代码级 `BEGIN IMMEDIATE` 设计是正确的；若要把“并发”作为强证据，应补 worker 或子进程同步屏障测试。

## 残留 P2

1. **幂等键仍只比较 tree ref。** `seedJourneyBaseline()` 的最新链查询只选 `tree_blob_ref`（`:1580-1584`）。同一树内容但 preview ref 发生变化时不会播种新双工件快照。若产品把 tree+preview 视为一个历史版本，应改为同时比较两个 ref，或使用 `(treeBlobRef, previewBlobRef)` 内容对作为幂等键，并补回归。
2. **TaskWorkbenchError 捕获范围仍偏宽。** `treeHistory` 对所有 `TaskWorkbenchError` 静默跳过（`:410-415`），包括未来新增的非工件错误类型。当前已比 `catch {}` 好，但建议按 `kind` 白名单静默，仅对 `tree-missing/tree-invalid/fence` 保持读面降级，其余记录并上抛。
3. **v8 迁移仍缺真实旧库升级测试。** 当前 daemon 全量通过，但 `db.test.ts` 仍主要覆盖 v7/六值；应增加 v7 数据库实际迁移到 v8、历史行无损、journey 可插、重复 migrate 幂等的测试。
4. **studio 全量门存在一次非确定性失败。** 首次默认全量为 `197 passed / 1 failed / 1 skipped`，失败位于未改动的 `src/tests/lab/templatesStore.test.ts`；单文件重跑 `19/19`，第二次默认全量 `198 passed / 2441 passed / 1 skipped`。本轮 v3 聚焦没有失败，但 CI 应修复该共享状态/并发不稳定性，避免把偶发绿当稳定绿。
5. **浏览器/大点阵性能证据仍属于 Owner 走查证据。** 工作区存在 9 张重出截图；用户提供的 16/16 CDP 走查包含回退后“帽子”断言。本人本轮没有再次启动真实服务浏览器走查；jsdom 只能证明 DOM/状态断言，不能替代 2,001/301 或 100k 点阵帧时和内存测量。

## 锁步升级决策

接受本轮“不写协商代码”的决策，前提是发布系统把 contracts、daemon、studio 作为同一不可拆分版本发布，并在滚动部署/回滚策略中禁止新旧混合。否则上轮 P1-4 的 strict schema 组合风险仍然成立。该策略与当前代码的破坏性协议演进一致，但必须落成发布检查，而不能只写在评审说明中。

## 二轮独立实跑

| 门 | 本轮结果 |
|---|---:|
| contracts 全量 | 11 文件，170/170 通过 |
| contracts typecheck | 通过 |
| daemon v3 聚焦 | 7/7 通过（含事务并发/缺 preview） |
| daemon 全量（排除 E2E） | 65 文件，858/858 通过 |
| daemon typecheck | 通过 |
| studio v3 聚焦 | 18/18 通过 |
| studio 全量首次 | 197 文件通过，1 个未改动模板测试失败，1 跳过 |
| 未改动模板测试单跑 | 19/19 通过 |
| studio 全量复跑 | 198 文件，2441 通过，1 跳过 |
| studio svelte-check | 0 errors，0 warnings |
| studio build | 通过；Vite 仅报告既有大 chunk warning |
| studio `perf:gate` | 未运行；本机 swap 已用约 8.5GB，且本轮已有完整 studio 全量测试，避免叠加重量级门；浏览器走查性能证据仍采用 Owner 提供的 16/16 记录 |
| `git diff --check 853e67f^ 3789598` | 通过 |

jsdom 仍输出 `HTMLCanvasElement.getContext()` 未实现提示；不影响本轮断言结果。`engine/`、CanvasKit 单源和 undo 分域在修复提交中没有改动。工作区仍只保留原有 `openspec/changes/add-workbench-pro/perf-receipt-20260927.json` 修改。

**放行意见：** 放行 Owner 验收；生产发布按锁步版本门执行，并把上列 P2（tree+preview 幂等键、迁移回归、全量测试稳定性、真实大点阵性能）登记为后续收口项。
