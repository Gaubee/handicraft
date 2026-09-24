# W4.2 实现评审 R2：定向修复复核

## 开头自检

- 评审工作目录：`pwd=/Users/kzf/Pictures/贴钻-backend`，通过。
- 评审目标快照：`HEAD=d48c671`（以 `git show d48c671` 固定；目标提交为本轮证据源）。
- 祖先关系：`f920458` 是 `d48c671` 祖先；`d48c671` 也是当前 live HEAD `d095b15` 祖先，均由 `git merge-base --is-ancestor` 返回 0 证实。
- 当前 live HEAD 已被外部提交推进到 `d095b15`（仅新增 `add-subject-sam-pipeline` OpenSpec 文档，非本轮改动）；因此不把 live HEAD 冒充为目标快照，也未回退该外部提交。
- 固定范围：`git diff f920458..d48c671`，12 文件，`+791/-141`；`rhinestone-studio/` 与 `contracts/` 零触碰。
- 写报告前工作树除既有外部提交外无未提交改动；本文件是本轮唯一写入。写入后预期仅新增本报告，不改源代码。
- `git diff --check f920458..d48c671`：通过。

## 结论

**GO，9.0/10；相对 R1 5.0/10，+4.0。**

R1 的四个 P1 与一个 P2 已由目标提交中的源码、真实持久化/重启路径和聚焦测试闭合。P1-3 选择“单一提交协议”（`withinCommit` + SQLite savepoint）接受：数据库可见性、operation 结算和 bundle 结果行处于同一提交边界，失败时行、引用、task 回链和物理目录均回收；但文件发布仍位于 SQLite 事务外，硬崩语义依靠启动孤儿扫描间接收敛，不能表述为跨介质 ACID。另有一个不影响 attempt 唯一性、但违反冻结契约的 P2：同 `retryRequestId` 重接管时传入 `costConfirmed=false` 仍被接受。

## P0

无。

## P1：五项定向修复

### P1-1：owner/task 绑定 —— PASS，已闭合

- `daemon/src/capability/studio.ts:200-226` 的 `requireAgentTask` 从任务行取得 `owner_id`；`requireOwnedResource` 交叉校验 `resourceId` 所属 owner 与任务 owner，不匹配即拒绝。
- `studio.projects`/`studio.templates` 在 `studio.ts:229-305` 使用 `WHERE owner_id = ?`；`studio.export-dryrun`/`studio.bom` 在 `studio.ts:397-494` 先过资源归属交叉校验。
- MCP 投影 `daemon/src/capability/mcp.ts:56-75` 直接复制同一 Zod shape；`principal='agent'` 仅表示授权等级，taskId 是声明的 bearer 身份路径，没有绕过资源 owner 检查。
- `daemon/tests/approval-isolation.test.ts:80-168` 的两用户两资源探针实质断言：B enumerate 不含 A 资源/模板，B 使用 A `resourceId` 的 dryrun/BOM 均拒绝，四工具缺 taskId 均 schema 失败。

裁定：R1 跨用户泄露已消除；按冻结的 taskId 身份模型通过。

### P1-2：成对恢复与同键重接管 —— PASS，主修复闭合

- `daemon/src/capability/authorization.ts:602-627` 启动扫描将 approved_ops 的 claimed/running 以及 attempts 的非终态收敛为 unknown，并按父 proposal 补齐 op 收敛，消除“op=approved + attempt=unknown + 已消费 grant”的死锁。
- `authorization.ts:497-536` 对已有 `retryRequestId` 做 owner/session/proposal 绑定；unknown attempt 重新置 claimed、父 op 重新 arm 为 approved、续期并写 transcript，返回原 attempt，不新建。
- `authorization.ts:408-436` 首次/重试执行分别建立或接管 attempt；`authorization.ts:447-468` 的结算同时覆盖 running 与 claimed attempt。
- `daemon/tests/approval-retry.test.ts:292-360` 真实关闭 DB、重开同一 DATA_ROOT、启动收敛、同键重放并执行 generate：同一 attemptId、无新 attempt，执行成功；provider 计费/调用次数按幂等与非幂等分支如实呈现。该文件本轮独立 `7/7`。

裁定：R1 的“确认后、执行前重启永久卡死”已修复并由真实关库重开探针闭合。

### P1-3：export 单事务协议 —— PASS，选型③接受

- `daemon/src/share.ts:89-140` 先完成 staged blob 与 bundle 目录发布，再进入单一 SQLite transaction；事务内重新 fence，提交 blob 行、result 行、result 引用和 task 回链，并在这些行写入后调用 `withinCommit`。
- `daemon/src/capability/studio.ts:776-784` 将 `approvals.settleExternal()` 挂入 `withinCommit`；`authorization.ts:447-468` 内部 nested transaction 使用 SQLite savepoint，并把 op 与 claimed/running attempt 一并结算。
- `share.ts:138-142,164-196` 的异常路径回收 staged 文件和 bundle 目录，必要时进入持久 outbox；启动 `daemon/src/sessions/service.ts:260-278,346-383` 清扫无 result 行的孤儿 blob/result 目录。
- `daemon/tests/approval-tools.test.ts:431-501` 注入 settle 失败，断言 `results=0`、bundle 目录为 0；真实关库重开后 op=unknown，同键 retry 只产生一个 resultId/bundle，attempt 终态为 succeeded，同键重放不再发布。该探针通过；相关 share/session 清理回归通过。

选型裁定：接受“单一提交协议”。它结构性消除了旧的“bundle 已提交、settle 未提交”同步异常窗口，且 savepoint 异常会让整个 SQLite 事务回滚。边界必须保留：`publishBundleDir()` 的文件系统写入仍在数据库事务外；本轮探针是同步异常注入，不是 SIGKILL。若进程硬崩于物理发布和 DB commit 之间，正确性依赖重启 `sweepOrphanResultDirs()`/blob orphan sweep，而非跨介质原子提交。该限制不阻止 W4.2 GO，但应作为协议说明和后续硬崩 E2E 范围记录。

### P1-4：shape-assets 四处同源 —— PASS，已闭合

- `daemon/src/shape-assets.ts:1-99` 抽出 `.gemshape` blob 解析、gate 三值状态、SVG/BOM resolver、PNG `resolveAsset`。
- `daemon/src/capability/studio.ts:941-1004` 的导出路径在 gate、SVG、BOM、PNG 四处使用同源 resolver；有效 `vectorPath+texture` 不再恒定 `missing-asset`，悬空 assetId 保持显式拒绝。
- `daemon/tests/approval-tools.test.ts:504-590` 使用真实 `.gemshape` fixture：dryrun 通过，SVG 含 vector path 且无 `data-missing`，BOM 含 custom 资产规格且无“资产缺失”，PNG 可解码且存在不透明像素；悬空 assetId 返回 `missing-asset`。

裁定：Agent dryrun/export 资产链路闭合，未发现 fallback 静默画圆或只修 gate 未修产物的残留。

### P2-1：undo 显式 group 绑定 —— PASS，已闭合

- `daemon/src/capability/undo.ts:51-62` 对显式 group 的每一条 history 行逐行断言 `resource_id` 与 `owner_id`，任一不符即拒绝；校验发生在加载/重写当前文档之前。
- `daemon/tests/approval-tools.test.ts:592-637` 覆盖跨资源 group、跨 owner group 必拒且 revision 不变，并以本资源自有 group 正向回退作对照。

裁定：R1 的 group 跨资源/跨 owner 逆变换风险已消除。`studio.undo` 的 human-ui 无调用者身份仍是登记的 W4.3 产品/权限 backlog，不是本 P2-1 group 绑定回归。

## 残余 P2

### 同 retryRequestId 重接管接受 `costConfirmed=false`

- 冻结契约 `openspec/changes/add-backend-platform/design.md:84,112` 明确 `costConfirmed=false` 必须拒绝，并要求 retry 确认载荷绑定。
- 当前 `daemon/src/capability/authorization.ts:497-536` 先命中已有 `retryRequestId` 幂等分支，再进入新键分支的 `:539-555` 费用确认检查；因此 unknown attempt 同键重接管时传 `false` 仍返回原 attempt，并将其 re-arm 为 claimed/op approved。
- 独立反证结果：同键 `false` 返回原 attemptNo（2）、attempt 数不增加，状态为 `claimed`、op 为 `approved`。它没有重复计费或新建 attempt，但不满足“false 必拒”的字面契约，也没有绑定重放请求的确认载荷。

定级：**P2，W4.3/W4.2 follow-up 必修**。修复应在已有键分支前校验 `costConfirmed`，并持久化/比较确认载荷摘要；在修复前不应把 retry API 描述为对任意重放载荷均严格拒绝。由于同键不创建新 attempt、不会增加远端调用，现有 P1-2 恢复与 exactly-once 结论不被推翻，整体仍 GO。

### 其他已登记问题

- generate preview 当前是费用/参数单 blob 而非真正视觉 before/after：P2，W4.3 产品 backlog。
- pave-preview 的 blobRef 全局可读性：P2，W4.3 评估项；不属于本轮五项闭合面。
- `studio.undo` human-ui 当前没有调用者身份参数：P2/边界外，W4.3 权限与产品入口 backlog。
- typert-loader 仍有已解释的 optional codec warning：非功能性阻塞；本轮测试均通过并显式输出 warning。

## 审查面与冻结面

- `consumeForExecution`：`authorization.ts:272-355` 在同一 SQLite transaction 内完成 task/user/tool/digest 四绑定、grant 消费、revision CAS、approved→claimed；条件更新保证并发二次 claim 拒绝。裁定 PASS。
- `canonicalJson`/`digestOf`：`authorization.ts:99-127` 递归排序对象键、保留数组顺序、过滤 undefined 后 SHA-256；持久 payload 重算摘要。当前 Zod 输入下未见绕过；数值语义仍沿用 JS JSON 表示，应在后续契约中显式化。裁定 PASS（有契约增强项）。
- approved_ops 六态、attempt 账本、recover：源码与 `approval-retry` 重启探针闭合；幂等 provider 复用 idemKey，非幂等 provider 新键并如实提示可能再次计费。裁定 PASS，除上述 costConfirmed 重放残余。
- patch-apply 本地恰好一次：`studio.ts:581-637` 将 consume、history、真值重写和 succeeded 更新纳入一个事务；固定 fixture 与审批桥回归通过。裁定 PASS。
- 固定 fixture：`approval-tools.test.ts:137-217` 走真实 `segment→layout→mapColors` 引擎链，断言同参确定、density 单调、dropped 呈现、非法输入拒绝和未批准真值不变。裁定 PASS。
- 工具面十工具、四参数、熔断分桶：`studio.ts:229-868` 与 MCP 投影注册全量覆盖；任务失败按 taskId 分桶。裁定 PASS。
- W4.1/W3 冻结面：W4.1 e2e `8/8`（含 off/missing/error/ready、MCP listener 时序与 LAN 隔离）；W3 clear/writer fence 回归通过。未见本轮授权桥接线回归。

## 独立验证记录

- `pnpm -C daemon exec vitest run tests/approval-isolation.test.ts`：1/1。
- `pnpm -C daemon exec vitest run tests/approval-retry.test.ts`：7/7。
- `pnpm -C daemon exec vitest run tests/approval-tools.test.ts`：15/15。
- `pnpm -C daemon exec vitest run tests/mcp.test.ts`：9/9。
- 聚焦授权/工具/MCP/kernel/share/session 回归：8 files，86/86。
- `pnpm -C daemon exec vitest run tests/e2e-smoke.test.ts tests/e2e-full.test.ts tests/e2e-kernel.test.ts`：3 files，8/8。
- `pnpm -C daemon exec vitest run`：31 files，250/250。
- `pnpm -C daemon exec tsc --noEmit`：通过；`pnpm -C contracts exec tsc --noEmit`：通过。
- `pnpm -C contracts test`：39/39。
- `pnpm -C daemon run smoke:engine`：通过，输出与既有基线逐字一致。
- `openspec validate add-backend-platform --strict`：通过（`Change 'add-backend-platform' is valid`）。
- `git diff --check f920458..d48c671`：通过。
- 所有 kernel/live boot 测试均可见既知 `typert-loader` optional codec warning；warning 未转为测试失败，也未被静默吞掉。

## 最终裁定

**W4.2 整体 GO（9.0/10；R1 5.0/10，+4.0）。**

五条定向修复线均已通过源码与聚焦探针：owner 隔离、成对恢复/同键重接管、export withinCommit 单事务、shape-assets 四处同源、undo group 绑定。选型③接受；保留文件系统与 SQLite 跨介质硬崩证据边界，以及同 retryRequestId 的 `costConfirmed=false` 残余 P2，交由后续修复，不阻断本轮 W4.2 代码闭合。
