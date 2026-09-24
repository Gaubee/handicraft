# add-backend-platform W3 实现评审

评审范围：`git diff 4abf7c9..c784dbf`，当前 `HEAD=c784dbf`；重点核对 design §6.5 session.clear 状态机/并发栅栏、§3.5 Agent 主面、§6.6 测试分类、前端纪律与引擎零改动。

环境祖先断言通过：`pwd=/Users/kzf/Pictures/贴钻-backend`；HEAD 为 `c784dbf`；`4abf7c9 9e492d1 ae4fe9f 9a07524 c784dbf` 均为祖先；评审前工作树干净。除本报告外未修改文件。

## 结论

**NO-GO，4.8/10。** 4 项 P1 均真实存在，且至少 2 项 P2；因此不满足“P1 全闭且无新 P1”的 GO 门槛。上一会话的“4×P1”口径成立，但其单一 P2 口径偏窄：本轮还发现 RPC mutation 输出未做运行时 schema 守门和首连失败不进入重连状态。

## P0

未发现 P0（无立即导致数据破坏、任意代码执行或全局服务不可用的证据）。

## P1

### P1-1 产物 writer 未进入 session/task fence，clear 后会产生孤儿产物

证据：帧入口 `daemon/src/jobs/service.ts:249-285` 只有 `emitFrame()` 检查 task 存在且 session 为 `active`；引擎导出在 `daemon/src/jobs/engine.ts:174-223` 通过 `createShareBundle()` 写产物。`daemon/src/share.ts:56-83` 先 `blobs.put` 三次、创建并写入 bundle 目录，`85-100` 再插入 result/ref 并回链 task，全程没有 session 状态/CAS 检查，也没有使用 `AbortSignal`。

真实交错：runner 已通过 gate 后暂停；`session.clear` 在 `sessions/service.ts:190-217` 提交 `clearing`、取消/drain 并随后收尾删除 task；runner 恢复进入 `engine.ts:210`。此时 artifact 帧会被 `emitFrame` 丢弃，但 share 的 blob/目录写入发生在 fence 外。独立探针在 clear 后调用同一 share 入口：`createResult` 以 task FK 失败，但此前已经留下 3 个 `active/ref_count=1` blob 和结果 bundle 目录。若 task 尚未被删除，share 还可能在 `clearing` 后提交 result，随后 clear 将其 `task_id` 解链为 `NULL`；虽有独立 TTL，却仍绕过了 session writer fence。两类交错都违反 design §6.5:182-184 “帧/产物 writer 每次写入同事务校验”。

可验证修复：统一引入 session-scoped artifact commit API，在同一 SQLite 事务内 CAS 校验 `session.status='active'`、task 归属/存在，再提交 blob 引用、bundle/result 和 task 回链；事务外文件发布失败必须进入持久 outbox。runner 在每个外部/异步副作用前检查取消信号，补 clear-after-gate 的 result/blob/bundle 竞态测试。

### P1-2 outbox unlink 失败仍无条件完成 clear

证据：`daemon/src/sessions/outbox.ts:57-89` 失败只调用 `failOutboxEntry()`；`daemon/src/sessions/service.ts:178-186` 无视 `processAll()` 返回的 `failed`，直接调用 `finishClearing()`；`220-232` 删除 task、保留 failed outbox 并置 `cleared`。

真实复现：在 `afterMark` 将任务目录 outbox 路径改为仍在 `DATA_ROOT` 内但含 NUL 的非法路径，`processEntry()` 捕获删除异常并标记 `failed`；输出仍为 `clear() => {ok:true}`、session=`cleared`、task 已删除，同时 outbox=`failed`。因此用户不可见的 cleared 状态会掩盖仍未删除的文件；真实 unlink 失败时若进程不再运行 maintenance/recover，泄漏长期存在。现有 `sessions-clear.test.ts` 只断言成功路径的 pending=0，没有失败删除回归。

可验证修复：`processAll()` 返回失败或仍有 pending 时不得进入事务②；会话保持 `clearing`，由启动/维护重试成功后再 finish。若产品必须对调用方返回成功，应返回明确的“清理中”状态而不是 `{ok:true}`，并增加权限/IO 失败后重试收敛测试。

### P1-3 会话 blob writer 无 fence，cleared 会话可复活引用并永久泄漏

证据：`daemon/src/sessions/service.ts:417-425` 的 `acquireSessionBlobRef()` 先 `blobs.put()` 再无条件 `addSessionBlobRef()`；`daemon/src/db/blobs.ts:83-106`/`119-132` 只按 hash/status 操作，不校验 session。该 helper 是未来 followup/附件/产物会复用的会话 writer 入口；当前 assets/engine 也直接调用 `blobs.put`（`daemon/src/rpc.ts:147-155`、`daemon/src/jobs/engine.ts:139-146`）。

真实复现：先 `sessions.clear()`，再调用 `acquireSessionBlobRef()`，session 已是 `cleared`，但数据库出现 `blobs.status=active, ref_count=1` 和一条新的 `session_blob_refs`；clear 不会再次撤销该引用，物理文件永久保留。该行为直接违反 §6.5 writer fence，即使帧 fence 测试全绿也不能证明 blob/产物闭合。

可验证修复：所有会话归属写入必须使用同一事务 API，先 CAS `active` 再 put/引用登记；清理后拒绝。对文件发布与 DB 提交采用 staging/outbox 恢复协议，并补“clear 后迟到上传/附件”测试。

### P1-4 Mock session.result 违反冻结的确定性选择

契约 `openspec/changes/add-backend-platform/design.md:84-87` 和 contracts `contracts/src/session.ts:213-237` 冻结为 `completedAt` 最大，平局取 `taskId` 大者。服务端实现 `daemon/src/sessions/service.ts:366-375` 正确调用 `selectSessionResult()`；但 W3 mock `rhinestone-studio/src/lib/agentApi/mock.ts:216-220` 对动态已完成任务仅按 `task.id` 比较，完全忽略完成时间。`MockTask` (`mock.ts:26-36`) 也没有 `completedAt` 字段。

真实复现：task A 先创建、task B 后创建，但 B 先完成、A 后完成；按契约应返回 A，独立探针实际返回了较大字典序 taskId 的 B。W3.1 明确“按 W0.1 冻结契约开发，mock 与 W4 共用真源”，所以这不是仅测试实现细节；现有测试只有单动态任务，未覆盖逆序完成。

可验证修复：给 mock task/fixture 补 `completedAt`，完成时记录；调用 contracts 的 `selectSessionResult()`，增加两个 task 逆序完成及同时间 taskId tie 测试。

## P2

### P2-1 Agent composer 暗示不存在的上传能力

`rhinestone-studio/src/lib/components/agent/SessionStream.svelte:130-145` 的 placeholder 写“可上传图片后引用”，但该面只有 textarea+发送按钮；`rhinestone-studio/src/lib/agentApi/types.ts:45-50` 与 `mock.ts:132-149` 的 followup 只接受 text，RPC `rhinestone-studio/src/lib/agentApi/rpc.ts:181-184` 也不传 `attachments`。要么删除提示，要么接入上传 picker、blobRef 及对应测试。当前是 UI 契约误导，不是后端 P1。

### P2-2 RPC mutation 输出绕过 contracts runtime parse；首连失败不触发重连

`rhinestone-studio/src/lib/agentApi/rpc.ts:164-166` 提供统一 `call()` schema 守门，但 `181-199` 的 `followup/answer/cancel/clear` 直接返回 RPC 响应，未使用已有的 `SessionFollowupOutputSchema`、`SessionAnswerOutputSchema`、`SessionCancelOutputSchema`、`SessionClearOutputSchema`。恶意/漂移服务端响应可穿过 façade，违背 `types.ts:1-6` 对读面契约收敛的声明。另 `rpc.ts:126-156` 首次 `WebSocket` error 只 reject，`scheduleReconnect()` 仅挂在 open 后的 close 事件；daemon 初次不可达时状态可能卡在 `connecting`，UI 不显示断线且不自动重试。分别补 schema 解析和首连失败状态/有界重连测试。

## §3.5 / §6.6 / 纪律核对

- §3.5 主面形态基本符合：`AgentView.svelte:50-99` 提供会话侧栏/流；`App.svelte:172-261` 默认 Agent，开发者旗标才挂旧三工作台；审批、取消、清空、结果/分享和 loading 状态均有 UI。`session.retry` 已在 contracts/daemon schema 路由中定义（`contracts/src/session.ts:128-147`、`daemon/src/rpc.ts:296-299`），但 W3 façade 的 `AgentApi`、Mock、Rpc client 完全没有 retry 方法；由于 endpoint 明确后移 W4.2，本报告将其记为 W4 接线风险，不重复升为新增 P1。
- §6.6 如实：`agentFace.test.ts:81-139` 覆盖默认无旗标 Agent/BYOK 隐藏，`146-199` 覆盖显式旗标旧三工作台；`app.smoke.test.ts:32-37` 明确开旗标跑 UI-only，`app.globalImport.test.ts` 有双模式导入断言。未发现静默 skip 或按旗标过滤测试。
- 引擎零改动成立：`git diff --name-only 4abf7c9..c784dbf` 无 `rhinestone-studio/src/lib/engine` 路径。
- 规格路径更正成立：本轮真实要求位于 `openspec/changes/add-backend-platform/design.md` §3.5/§6.5/§6.6 与 `tasks.md` W3.1-W3.3；仓库没有 `spec.md`。因此应引用 design/tasks，而不是把不存在的 `spec.md` 当作实现证据。

## 独立门禁

- `pnpm -C contracts exec vitest run`：4 files，**39/39 passed**。
- `pnpm -C daemon exec vitest run`：23 files，**168/168 passed**（包含 W3 sessions/RPC 测试）。
- `pnpm -C rhinestone-studio exec vitest run`：169 files，**2073 passed，1 skipped/2074**；有 jsdom `HTMLCanvasElement.getContext()` 未实现告警，但无失败。
- `pnpm -C daemon run test:e2e`：2 files，**3/3 passed**。
- `pnpm -C daemon run smoke:engine`：**PASS**（`gemCount=68,dropped=0,svgBytes=3040,bomBytes=103`）。
- `git diff --check 4abf7c9..c784dbf`：通过。
- `pnpm exec openspec validate add-backend-platform --strict`：**未验证**；`openspec` 解析到 vite-plus wrapper，但 wrapper 报告 `VP_BYPASS is set but no system 'openspec' found in PATH`，未实际运行 validator。不能把该门禁记为通过。

## 质量评价与修复优先级

| 维度 | 评价 |
|---|---:|
| §6.5 状态机/崩溃恢复 | 4.0/10：帧 fence、rowGen/barrier 测试扎实，但真实产物/blob writer 和失败 outbox 收尾未闭 |
| §3.5 主面/契约 | 6.5/10：UI 骨架和帧/审批旅程完整，mock 结果选择错误，retry façade 漏字段 |
| §6.6 分类/前端纪律 | 8.5/10：双模式断言如实，旧 UI 未静默跳过，提示和 RPC 守门有 P2 |
| 独立证据 | 8.0/10：三包门禁和引擎 smoke 绿，但 strict OpenSpec validator 不可用 |

**综合 4.8/10，NO-GO。** 优先修复 P1-1/P1-2/P1-3 的 writer/clear 一致性与 P1-4 的确定性选择；修复后必须新增上述失败/迟到交错回归，再重新跑三包门禁。 
