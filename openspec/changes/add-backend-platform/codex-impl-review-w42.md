# W4.2 实现评审：授权桥、approved_ops、session.retry、撤销三族与工具面

## 开头自检

- `pwd=/Users/kzf/Pictures/贴钻-backend`：通过。
- `HEAD=625201e0d2048657d3d53c4b98c904f08fd73e1c`：通过。
- `faa4db9` 与 `625201e` 均为当前 HEAD 的祖先：通过（`merge-base --is-ancestor` 返回 0）。
- 评审范围：`git diff faa4db9..625201e`，17 个文件，`+3617/-55`；`rhinestone-studio/` 与 `contracts/` 未触碰：通过。
- 写报告前工作树无改动；本文件是本次唯一写入。
- `git diff --check faa4db9..625201e`：通过。

## 结论

**NO-GO，5.0/10。**

授权桥的核心事务、patch 本地恰好一次、digest 稳定摘要、六路拒绝矩阵、固定真实引擎 fixture、两类 provider 的 unknown/retry 账本和三族撤销测试均有实质实现；但工具面存在跨用户资源读取，retry 存在“确认后、执行前重启”永久卡死，export 不满足规范要求的本地恰好一次，且有效 custom shape 无法由 Agent 工具导出。这些问题触及授权隔离、可恢复性和用户产物正确性，不能以当前测试绿门放行。

## P0

无 P0；当前最高级别为 P1。

## P1

### P1-1 工具只读面没有调用者/任务 owner 绑定，存在跨用户资源泄露

证据：

- `daemon/src/capability/studio.ts:224-228` 的 `studio.projects` 查询全表 `resources`，没有 `owner_id` 条件。
- `daemon/src/capability/studio.ts:259-263` 的 `studio.templates` 同样全表查询。
- `daemon/src/capability/studio.ts:386-390` 的 `studio.export-dryrun` 由 `resourceId` 反查 owner 后直接读取，不要求调用 task 与资源 owner 相同；`taskId` 还是可选的。
- `daemon/src/capability/studio.ts:446-450` 的 `studio.bom` 同样按资源 owner 直接读取。
- `daemon/src/capability/mcp.ts:28-64` 将所有 MCP 请求固定成无用户身份的 `MCP_PRINCIPAL='agent'`。
- 对照冻结契约：`openspec/changes/add-backend-platform/design.md:42` 要求多账户互不可见。

独立探针在同一数据库创建两个用户及各自资源后，以第二个用户的 Agent/MCP 工具面调用 `studio.projects`，返回了第一个用户资源；这不是测试名问题，而是实际查询结果。`requireAgentTask()`（`studio.ts:194-205`）只校验任务存在、类型，未为只读资源查询提供调用者身份。

影响：任一 Agent 可枚举其他用户工程、模板、BOM，并可对已知 `resourceId` 做导出预检；违反账户隔离，定 P1，阻 GO。修复需要把 principal/user/session 绑定贯穿 MCP/能力调用，并在所有资源读面使用 owner 条件或任务 owner 交叉校验。

### P1-2 session.retry 在“确认后、执行前重启”场景永久卡死

证据：

- `daemon/src/capability/authorization.ts:532-545` 的 `retry()` 创建 `attempt state='claimed'`，并把 op 从 `unknown` 重置为 `approved`。
- `daemon/src/capability/authorization.ts:568-579` 的 `recoverNonTerminal()` 只扫描原本的 `claimed/running`，把 attempt 置 `unknown`，但不会把该 op 重新 arm；此时 op 已是 `approved`。
- `daemon/src/capability/authorization.ts:318-329` 的执行消费路径在 grant 已消费且不存在 active attempt 时返回 `grant-consumed`。

独立持久化探针：`session.retry` 后关闭并重开同一 DATA_ROOT，启动恢复得到 `op=approved, attempt#2=unknown`；同一 `retryRequestId` 重放按设计返回原 attempt，但随后 `studio.generate{proposalId}` 执行失败为 `grant-consumed`，不能执行也不能通过同键恢复。现有 `approval-retry.test.ts:254-280` 只断言重启后返回同一 attempt，没有把该 attempt 再送入执行入口，因此遗漏了故障。

影响：用户已明确确认重试但 daemon 恰在执行前崩溃时，确认被持久化却不可执行，且旧 grant 已消费；只能人工重新发起 proposal，违反 `design.md:112` 的“同键重启收敛同一 attempt”。定 P1，阻 GO。恢复逻辑必须让 op/attempt 成对收敛，并允许同一 retry key 重新接管该 attempt。

### P1-3 export 不是本地恰好一次，崩溃窗口会产生重复分享包

证据：

- `daemon/src/capability/studio.ts:737-750` 先调用 `runLayoutExport()` 创建并提交 bundle/result，再调用 `approvals.settleExternal()` 更新 `approved_ops`。
- `daemon/src/share.ts:105-127` 的 `createShareBundle()` 在独立 SQLite 事务中提交 result、引用和 task 回链；与 `approved_ops` 结算不是同一事务。
- `daemon/src/capability/authorization.ts:459-462` 的结算只把 active attempt 从 `running` 转终态；而 `session.retry` 为任意 unknown op 新建的是 `claimed` attempt，export retry 后该 attempt 会残留 `claimed`。
- 冻结规范明确写成 `design.md:109-114`：“export 无外部副作用（本地 bundle），按本地恰好一次处理”。

在 bundle 已提交、`settleExternal` 尚未提交的进程崩溃窗口，启动恢复会把 op 置 `unknown`；用户 retry 会再次发布第二个 bundle。首个 bundle 只能依赖 `resultTtlDays`（`share.ts:115-117`，默认 7 天）回收，不能恢复 exactly-once，也不能保证用户只看到一个结果。当前 export 测试（`approval-tools.test.ts:253-280`）只覆盖成功和撤销，没有故障注入/重启/重复 bundle 断言。

影响：重复分享链接和重复产物引用，且 retry 账本状态不闭合。定 P1，阻 GO。至少需要以 proposalId 幂等绑定 result、把发布/结算设计成可恢复的单一提交协议，或在恢复时发现已发布 result 后收敛到同一结果；同时补充崩溃探针。

### P1-4 有效 custom shape 在 Agent export 路径被错误判为缺失资产

证据：

- `daemon/src/capability/studio.ts:392-395` 的 `studio.export-dryrun` 将 `resolveShapeAsset` 固定为 `() => null`。
- `daemon/src/capability/studio.ts:907-911` 的 `runLayoutExport()` 同样固定返回 null。
- `daemon/src/capability/studio.ts:928-935` 的 PNG 渲染没有传 `resolveAsset`。
- 正确的资产解析链已存在于 `daemon/src/jobs/engine.ts:268-334`（从 `shapeAssets` 取 blob、解析 `.gemshape`、同时供 gate/SVG/PNG 使用）。
- 规范要求 custom 形由 BlobStore 解析渲染，且禁止静默替代：`design.md:147-149`。

因此 `LayoutDocument.shapeAssets` 含有效 `assetId` 时，dry-run gate 仍得到 `missing-asset`，真正 export 也无法生成 SVG/PNG；这不是缺失资产错误分支，而是有效资产永远不可达。定 P1，阻 GO。应复用 jobs/engine 的 resolver 语义并在 gate、SVG、PNG 三处使用同源解析器。

## P2

### P2-1 studio.undo.patch 未校验 history group 的 resource/owner

证据：

- `daemon/src/capability/undo.ts:49-53` 按显式 `group` 直接读取 `listPatchHistoryOfGroup()`，该查询只按 `patch_group`。
- `daemon/src/capability/undo.ts:81-103` 随后用当前 `resourceId/ownerId` 重写文档和写入新 history，没有断言 history 行的 `resource_id`、`owner_id` 与输入一致。
- `daemon/src/capability/studio.ts:786-805` 的 human-ui undo 从资源行取得 owner，但没有调用者身份参数；`studio.undo` 的 agent 预检也只是 capability 层通用 proposal 检查。

显式传入另一资源的 group 可能读取错误资源的历史，再把逆变换应用到当前资源；无 group 时默认最近组则不触发该路径。定 P2，加固项，但应在 W4.3 前修复并增加跨资源/跨 owner 探针。

## 审查面逐项裁定

1. **consumeForExecution 四绑定、摘要自洽、CAS、原子 claim：基本 PASS。** `authorization.ts:272-355` 在 SQLite 事务中校验 task/user/tool、重算 digest、校验 grant、revision CAS，再 `approved→claimed`；失败返回会回滚消费。并发 claim 有条件更新和 partial unique index（`db/approvals.ts:135-175`）。但执行入口的调用者身份来自任务行，工具面读取路径仍未建立同等 owner 边界。
2. **digestOf/canonicalJson：PASS（当前口径）。** `authorization.ts:99-128` 递归排序对象键、保留数组顺序、过滤 undefined，并以固定 `{tool,resourceId,baseRevision,payload}` 计算 SHA-256；持久化 payload 会重算并拒绝篡改。数值语义沿用 JavaScript `JSON.stringify`（如 `-0`/非有限值归一化），当前 Zod 输入与持久化 JSON 没有可利用绕过证据，仍应把数值规范写成显式契约。
3. **approved_ops 六态与启动收敛：PARTIAL。** 表约束和 `claimApprovedOp()` 正确（`db/schema.ts:133-175`）；首次 generate 的 `claimed→running` 与 provider 崩溃后 unknown 有实测。retry 后重启的 op/attempt 不成对收敛，见 P1-2。
4. **patch-apply 本地恰好一次：PASS。** `studio.ts:552-608` 将 consume、history、真值重写、succeeded 更新放在同一 SQLite 事务；`approval-bridge.test.ts:128-164` 与重放断言验证 grant 消费、revision 和 history。
5. **export 恰好一次与两事务窗口：NO-GO。** `studio.ts:747-750` 与 `share.ts:105-127` 存在 bundle/result 已提交而 op 未结算的崩溃窗口；TTL 只是回收，不是去重或收敛。
6. **retry 幂等矩阵与 unknown：PARTIAL/NO-GO。** `approval-retry.test.ts` 实测 provider 幂等/非幂等、费用确认、跨归属键、同键重复与普通重启回放；但没有验证 retry armed 后重启再执行，P1-2 说明该漏项。
7. **撤销三族：PARTIAL。** 测试覆盖 patch 整组逆序、generate 完成/在途补偿、export revoke（`approval-tools.test.ts:252-344`）；patch 显式 group 的资源/owner 绑定缺失，见 P2-1。
8. **固定 fixture：PASS。** `approval-tools.test.ts:137-217` 通过真实 `rhinestone-studio/engine` 的 `segment→layout→mapColors` 管线，断言同参确定、density 单调、dropped 呈现、非法输入和未批准真值不变。
9. **工具面十工具、四参数、熔断分桶：PARTIAL。** 十工具注册及 MCP 名称投影有测试（`approval-tools.test.ts:346-390`），`pave-preview` 传递 strategy/density/gap/seed/relax（`studio.ts:282-347`），熔断按 task bucket（`studio.ts:110-181`、`kernel/index.ts:95-105`）。但资源读面 owner 缺失（P1-1），custom export 解析断裂（P1-4）。
10. **W4.1 冻结面：PASS（本轮聚焦回归）。** `tests/kernel.test.ts`/`kernel-live.test.ts` 覆盖 off/missing/boot-error/ready、MCP 投影和工具注册；`kernel/index.ts:256-268` 保留 10s 有界栅栏。运行中出现 typert-loader codec warning，但测试通过，warning 不应当被写成零噪声。
11. **W3 冻结面：PASS（本轮聚焦回归）。** `tests/sessions-rpc.test.ts` 覆盖 clearing 原子拒、clear/replay/result；writer fence 与 tasks/session 帧路径未见回归。W4.2 新代码仍需补充授权 op 与 session.clear 的交叉竞态测试。
12. **MCP loopback/token：PASS（已有 E2E 证据）。** 独立 listener、token 401 和非 loopback 不可达的 E2E 断言存在；这不能抵消 MCP 请求没有用户 owner 身份的问题。

## 登记的四项未修问题定级

1. **generate preview 为费用单 blob（双 blobRef 占位）：P2 / W4.3 backlog。** `studio.ts:641-658` 与 `export-dryrun:403-416` 用同一 canonical cost sheet 作为 before/after；对无视觉副作用的费用/参数预览可接受，但不构成真正视觉 preview。应在 W4.3 产品旅程补充明确的费用确认/提示语和前后语义。
2. **export claim 后崩溃窗口：P1 / 阻 GO。** 不是单纯观测缺口；会产生第二个 bundle，且 retry attempt 可能停留 claimed。见 P1-3。
3. **retry 提示帧与事务非原子：P2 / W4.3 backlog。** `authorization.ts:551-555` 在 retry 事务成功后再 emit transcript；帧丢失不会改变 attempt 的 owner/状态，重放仍可通过持久 `retryRequestId` 找回同一 attempt，因此不是当前阻 GO 的一致性漏洞；需补“响应/帧丢失后的 UI 重放”验收。
4. **studio.undo 未对 agent 面提供提案工具：边界外 / W4.3 backlog。** 当前定义明确写 human-ui 直调（`studio.ts:770-774`），而冻结清单只要求 patch-apply/generate/export 三个 approved-mutation；若 W4.3 要求 Agent 自主撤销，再单独增加 proposal+approval 入口，不应把当前缺口误报为 W4.2 授权桥缺陷。

## 独立验证记录

本轮聚焦执行：

- `pnpm -C daemon exec vitest run tests/approval-bridge.test.ts`：11/11。
- `pnpm -C daemon exec vitest run tests/approval-retry.test.ts`：6/6。
- `pnpm -C daemon exec vitest run tests/approval-tools.test.ts`：11/11。
- `pnpm -C daemon exec vitest run tests/sessions-rpc.test.ts tests/kernel.test.ts`：24/24；有已知 typert-loader warning，未影响通过。
- `pnpm -C daemon exec vitest run`：30 个文件、244/244；有已知 typert-loader warning，未影响通过。
- `pnpm -C daemon exec tsc --noEmit`：通过。
- `pnpm -C contracts exec tsc --noEmit`：通过。
- `git diff --check faa4db9..625201e`：通过。
- daemon 全量 244/244 为本轮独立重跑；E2E 8/8、contracts 39/39 与双 typecheck 的其余 receipt 作为 supplied evidence 记录，不把未在本轮重跑的项目冒充独立结果。
- `pnpm exec openspec validate add-backend-platform --strict`：**未验证**；当前环境报 `VP_BYPASS is set but no system 'openspec' found in PATH`。

在 P1-1/P1-2/P1-3/P1-4 修复并补齐跨用户、确认后重启执行、export 崩溃收敛、custom shape 真资产导出探针前，不应将 W4.2 标为 GO。
