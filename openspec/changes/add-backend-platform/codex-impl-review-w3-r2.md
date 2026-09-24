# add-backend-platform W3 实现评审 R2

## 开头自检

- `pwd=/Users/kzf/Pictures/贴钻-backend`：通过。
- `HEAD=bb520b1d4ed9b50abaacb473095dec62d3f7ead3`：通过。
- `4cb22bc` 是 `bb520b1` 祖先，`bb520b1` 是当前 `HEAD` 祖先：通过。
- 写报告前工作树干净；写入后仅新增本报告，未修改 R1 冻结报告或源码：通过。
- 评审范围固定为 `git diff 4cb22bc..bb520b1`；R1 冻结证据为 `codex-impl-review-w3.md`，未修改。

## 结论

**NO-GO，6.0/10（相对 R1 的 4.8/10 上升 1.2 分，但未达到 GO 门槛）。**

P1-2、P1-3、P1-4、P2-1、P2-2 的声明性修复在源码和新增回归中基本成立；P1-1 仍未闭合：分享包在进入回收 `try` 前的物理发布异常会留下无 DB 行的 blob/半成品目录，且 writer fence 不把 `task.status='cancelled'` 视为不可写。两者均直接违反 design §6.5 writer CAS/孤儿回收要求，故保留 P1，不能 GO。

## P0

未发现 P0。没有立即导致任意代码执行、全局服务不可用或不可逆全局数据破坏的证据。

## P1

### P1-1 产物 writer fence：部分修复，仍未闭合

已确认的修复：

- 单点 fence 在 `daemon/src/writer-fence.ts:23-44`；帧 writer 改用它（`daemon/src/jobs/service.ts:275-281`）。
- 分享包事务内重新校验，再原子提交 blob 行、result 行、result 引用和 task 回链（`daemon/src/share.ts:101-124`）；事务失败后的回收/outbox 在 `daemon/src/share.ts:125-182`。
- engine export 在 PNG/分享发布前检查取消（`daemon/src/jobs/engine.ts:185-249`），并以 `ArtifactFenceError` 静默收敛（`daemon/src/jobs/engine.ts:50-68`）。
- 独立复跑 `daemon/tests/sessions-clear.test.ts`：25/25 通过；其中 runner 过 gate→clear→恢复、afterMark 拒绝、commit 注入失败+权限恢复均通过。

未闭合证据：

1. `daemon/src/share.ts:78-99` 的 `stage()` 三次调用和 `publishBundleDir()` 在 `try` 之前。独立探针注入第二次 `stage()` 失败，观察到 `blobRows=0` 但 `blobs/` 留有第一份已 rename 文件，且 outbox=0；注入 `results/` 非目录使 `mkdirSync` 失败，观察到三份 staged blob 文件仍在、无 outbox。也就是说物理发布前半段失败不进入 `reclaimPublished()`，不满足 design §6.5:184、187 的 staging/孤儿回收闭合。
2. `daemon/src/writer-fence.ts:27-33` 的 `taskWriterAllowed()` 只检查 task 行存在及 session active，不检查 task status；`daemon/src/jobs/engine.ts:136-156`（pave）和 `:171-178`（validate）在产物写入前也没有取消检查。独立探针：普通 task `cancel()` 后状态为 `cancelled`，调用 `putTaskArtifact()` 仍成功，结果为 `allowed=true, blobs=1`。这使取消但尚存 task 行的迟到 runner 仍能写产物。

**裁定：P1-1 未闭合（P1，阻 GO）。** 修复需把 stage/目录发布纳入统一异常回收边界并持久化失败清单，且 fence 明确拒绝 cancelled/non-active task；补对应探针/回归。

### P1-2 outbox settled 门：闭合

- `SessionService.clear()` 仅在 `sessionOutboxSettled()` 为真时收尾，否则返回 `{ok:true,status:'clearing'}`（`daemon/src/sessions/service.ts:181-197`）。
- recover/maintenance 均调用 `convergeClearingSessions()`，只在无 pending/failed 条目时 `finishClearing()`（`:256-303`）。
- `removeFile()` 移除 `existsSync` 预检，NUL 等真实 unlink 错误会记 failed（`daemon/src/sessions/outbox.ts:117-127`）。
- 独立回归覆盖在线 NUL 和崩溃重启两条路径，`sessions-clear.test.ts` 通过；错误态保持 clearing，修复路径后 maintenance/recover 收敛 cleared。

**裁定：P1-2 闭合。**

### P1-3 acquireSessionBlobRef / task artifact fence：闭合；偏离 A 接受

- `acquireSessionBlobRef()` 在同一 DB transaction 内先读 session 状态，再 `put` 和登记引用（`daemon/src/sessions/service.ts:441-466`）；clearing/cleared/行缺失原子拒绝。
- `putTaskArtifact()` 以 task fence 包住任务产物 blob 写（`daemon/src/jobs/service.ts:327-345`）；engine 的 layout/verdict 写入已改经该入口（`daemon/src/jobs/engine.ts:148-178`）。
- 独立回归覆盖 cleared 迟到、clearing afterMark 窗口和 clear 后 engine artifact，均无 active blob/ref 残留。

**偏离 A 裁定：接受（边界外/W4 接线约束，不阻当前 GO 门）。** `daemon/src/rpc.ts:147-157` 的 `assets.upload` 没有 `sessionId`，只产生无会话归属的原始 blob，不写 `session_blob_refs`；因此结构上不能复活 cleared session 的会话引用。代码注释已明确 W4 followup 附件必须改走 `acquireSessionBlobRef()`。但该裸 blob 的 owner-domain GC 仍是风险，见“新风险①”。

**裁定：P1-3 闭合（在偏离 A 的明确边界内）。**

### P1-4 Mock session.result 确定性选择：闭合

- mock 引入 contracts 的 `selectSessionResult()`（`rhinestone-studio/src/lib/agentApi/mock.ts:9-15,220-238`）。
- `MockTask.completedAt` 在完成时由注入时钟记录（`:27-38,263-271`）；fixture 完成时间可从 done 帧派生（`:70-79`）。
- 独立 mock 测试覆盖逆序完成及同 `completedAt` 的 taskId tie（`agentApi.mock.test.ts:157-203`），contracts 纯函数也通过。

**裁定：P1-4 闭合。**

## P2

无新增阻断性 P2。R1 的 P2-1/P2-2 均已修复并有独立证据；仍有非阻断测试覆盖缺口列入“新风险⑤”。

### P2-1 placeholder：闭合

`SessionStream.svelte:130-136` 已改为“描述你的贴钻需求”，删除了不存在的上传暗示；`agentFace.test.ts` 通过。

**裁定：P2-1 闭合。**

### P2-2 RPC schema 守门与首连重连：闭合（测试覆盖有边界）

- 四个 mutation 经统一 `call()` 并分别 parse contracts schema（`rhinestone-studio/src/lib/agentApi/rpc.ts:187-218`）。
- 首连 error catch 会转入 `scheduleReconnect()`，状态回到 closed；退避 500ms 起、15s 封顶、attempts 封顶 16，成功归零（`:135-180`）。
- FakeWebSocket 真实 oRPC 线协议测试覆盖漂移拒绝、首连失败状态序列、恢复往返和失败风暴封顶（`agentApi.rpc.test.ts:104-210`）；独立复跑 26/26 通过。
- store 在 clear 后不会重新打开 clearing 会话（`store.svelte.ts:274-294`）；连接断线横幅/徽标走查在 `agentFace.test.ts:142-197`，通过。

**裁定：P2-2 闭合。** connect-catch 与 close 事件重叠缺少专门直接测试，列为新风险⑤，不改变本项当前实现裁定。

## 偏离裁定

### 偏离 A：`assets.upload` 不加 session fence

接受。该 endpoint 的契约仅是 `filename + dataBase64 → blobRef`（`contracts/src/tasks.ts:51-66`），没有 sessionId，也不登记 `session_blob_refs`；把它强行纳入 session fence 会改变 W2 输入面语义。W4 附件/会话归属上传必须改用 fenced helper，裸 blob 的生命周期由 owner GC 补齐。

### 偏离 B：clear 失败态返回 `ok:true,status:'clearing'`

接受其“受理”语义。`SessionClearOutputSchema` 明确以 `status` 区分完成和待重试（`contracts/src/session.ts:121-133`）；当前实现不再把 failed outbox 伪装为 `cleared`，调用方可据 status 判断真相。保留 W4.4 集成断言，确保 UI/消费方不只看 `ok`（新风险②）。

## 新风险定级

1. **assets.upload 裸 blob 无释放路径：W4 backlog，边界外本轮 GO 门。** `daemon/src/rpc.ts:147-157` 不建立 owner/ref ledger；长期使用会产生 GC 缺口。与 P1-3 的会话引用安全不同，需在 W4 附件/资源生命周期设计中补齐。
2. **clear 失败态 `ok:true` 消费方若只读 ok 会误判：W4 backlog，不阻当前实现。** 契约已有 status；`store.svelte.ts:280-289` 已避免重新打开 clearing 会话，但产品集成仍需显式断言 clearing UI/提示。
3. **`results/<publicId>` 孤儿目录无启动清扫：W4 backlog；与 P1-1 物理发布异常合并后可能扩大残留。** `sweepOrphanBlobFiles()` 仅扫 `blobs/`（`daemon/src/sessions/service.ts:320-340`），不扫描 `results/`；design §6.5:184,187 的“无孤儿文件遗漏”尚未全覆盖。
4. **share 事务回滚后内联回收失败依赖 recover：W4 backlog/边界防御。** `reclaimPublished()` 有 outbox 兜底（`daemon/src/share.ts:145-182`），但 outbox 入队本身失败时仅记录日志，正式结果目录缺少独立启动扫描；不新增当前 P1 之外的结论。
5. **重连“connect catch 与 close 重叠”无直接测试：测试覆盖缺口，W4 backlog，不阻实现。** 现有单轨守卫和失败风暴测试证明定时器不繁殖，但没有专门交错时序断言。
6. **clear 打断 export 无中断原因帧：边界外/UI cosmetic，W4 backlog。** `ArtifactFenceError` 静默收敛符合本轮“无 error 帧污染”目标；若产品需要可见原因，应在 W4 UI 语义另行设计。

## 独立门禁与证据口径

独立复跑结果：

- `pnpm -C contracts exec vitest run`：39/39 通过。
- `pnpm -C contracts run typecheck`：通过。
- `pnpm -C daemon test`：21 files，173/173 通过；新增 `sessions-clear.test.ts` 单文件 25/25 通过。协调方供给的 176/176 未在当前 checkout 重现，故不冒充独立结果。
- `pnpm -C daemon run typecheck`：通过。
- `pnpm -C daemon run test:e2e`：2 files，3/3 通过。
- `pnpm -C daemon run smoke:engine`：PASS，`gemCount=68,dropped=0,svgBytes=3040,bomBytes=103`，与 R1 基线逐字一致。
- `pnpm -C rhinestone-studio exec vitest run src/tests/agent/agentApi.mock.test.ts src/tests/agent/agentApi.rpc.test.ts src/tests/agent/agentFace.test.ts`：3 files，26/26 通过。
- `pnpm -C rhinestone-studio test`：170 files，2081 passed，1 skipped（2082 tests）；jsdom 产生既有 `HTMLCanvasElement.getContext()` 未实现告警，无失败。
- `pnpm -C rhinestone-studio run check`：0 errors，0 warnings。
- `git diff --check 4cb22bc..bb520b1`：通过。
- `git diff --name-only 4cb22bc..bb520b1 -- rhinestone-studio/src/lib/engine`：空，引擎零改动成立。
- `pnpm exec openspec validate add-backend-platform --strict`：**未验证**；本机命中 vite-plus wrapper，报 `VP_BYPASS is set but no system 'openspec' found in PATH`。协调方声明的 strict 通过未作为本地独立门禁。

## Standards 轴补充

未发现硬性仓库标准违规，`git diff --check` 通过，未引入 `any`/`@ts-nocheck`。仅记录不阻断的判断性 Fowler smell：`writer-fence.ts:25-41` 查询逻辑轻度重复；`share.ts:71-129` 聚合 staging/发布/事务/outbox 回收；`sessions/service.ts:181-196,287-305,444-466` 同时承载 clear/recovery/result/ref 变化。跨介质协议使后两项有合理性。

## 评分与最终裁定

| 维度 | 评分 | 依据 |
|---|---:|---|
| §6.5 状态机/跨介质清理 | 5.0/10 | P1-2/3 关闭，P1-1 仍有发布异常和 cancelled task writer 漏洞，results 孤儿扫描也缺失 |
| §3.5 Agent 主面/契约 | 7.5/10 | mock 选择、RPC schema、首连重连和 UI 状态均有源码/测试证据；B 偏离需 W4 集成断言 |
| §6.6 测试分类/前端纪律 | 8.8/10 | 默认/旗标双模式、placeholder、断线 UI 和全量回归通过；重连交错测试缺口 |
| 独立证据完整度 | 8.2/10 | 核心门禁和新增探针大多复跑通过；OpenSpec strict 不可用；daemon 本地计数为 173 而非供给的 176 |
| **综合** | **6.0/10** | 相对 R1 4.8 提升 1.2；仍有 P1，故 NO-GO |

**最终结论：NO-GO。** 先修复 P1-1 的异常发布回收边界与 cancelled-task fence，再补 results 孤儿扫描/重连交错测试和 W4 status/GC 集成证据，之后重新进行 R2/R3 复核。
