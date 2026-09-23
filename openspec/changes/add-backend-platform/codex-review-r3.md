# add-backend-platform Codex Review R3

- 基线：`ec55400`；目标：`91cf57c`（当前 HEAD）。按要求复核 `git diff ec55400..91cf57c -- openspec/changes/add-backend-platform/`，并对照当前 engine 的实际 Zod/API 形态核验契约。diff 包含新增的 R2 评审记录及 design/spec/tasks 修订；proposal 无本轮改动。
- 结论：**NEEDS-WORK，8.1/10**；相对 R2 **+1.4**。B1、B3、B4、B5、B7、B8 的核心缺口已闭，排布契约和降级/PNG/清理设计明显更可验收。仍有两个 P1：外部副作用的 exactly-once/撤销语义，以及 clear 与活跃 worker/内容寻址 blob 的竞态尚未冻结。
- 验证：`openspec validate add-backend-platform --strict` 通过；`git diff --check ec55400..91cf57c -- openspec/changes/add-backend-platform/` 通过。目标 change 仍是文档/任务，没有运行应用实现测试；本轮结论只评文档契约质量。

## R2 B1-B8 逐项复核

| R2 项 | 状态 | 核验 |
|---|---|---|
| B1 多 task replay/result | **已闭** | design §3.5 将 replay 游标显式定为 `{sessionId, taskId, afterSeq}`；session.get 列 task/lastSeq；session.result 的完成时间与 tie-break 规则确定，task.result 有显式 not_found；W0.1 增双 task 独立 seq 与结果选择测试。 |
| B2 grant 全工具面/内部关联/CAS | **部分闭合** | §3.6 已覆盖 patch-apply/generate/export、grant 不出载荷、proposalId 服务端消费、baseRevision CAS 和相应拒绝测试。剩余问题见 P1-1：同事务消费 grant 不等于外部图像 API exactly-once，generate/export 的副作用恢复与撤销也未定义。 |
| B3 排布参数引擎真源 | **已闭（主缺口）** | 策略五值含 cvt、density `(0,1]`/逐块 Record、gapMm、seed/relax、blocks-only region 和 dropped 语义，均对齐 `types.ts`、`layout/index.ts`；adapter 等价 fixture 与非法值测试进入 W0.2。另有 P2 API 命名不准确，见下文。 |
| B4 四态 Agent 降级 | **已闭** | §6.4/W4.1 明列 DSH off、缺包/坏包独立模块解析测试、boot throw、正常态；明确 boot throw 不替代解析失败，并覆盖主 HTTP 可 LAN、MCP 不可 LAN。 |
| B5 Node PNG 形状保真 | **已闭（契约边界）** | §6.3/W2.3 冻结 builtin 五形、custom BlobStore 资产、旋转/透明及缺失资产拒绝，并要求 Node fixture 覆盖各类形状与错误分支。实现尚无证据，归后续验收。 |
| B6 跨介质 clear | **部分闭合** | §3.5/W0.1 纳入 clear；§6.5/spec 定义 clearing/outbox/unlink/replay、result→blob 独立引用和每 result TTL。仍缺活动任务与新 blob 引用的并发栅栏，见 P1-2；步骤还存在 status/delete 表述冲突，见 P2。 |
| B7 MCP loopback/LAN | **已闭** | design §2/§6.4、spec 和 W4.1 均规定独立 loopback listener 专用端口；主 HTTP 的 LAN 监听不影响 MCP，并冻结 IPv4/IPv6/mapped 拒绝测试。 |
| B8 实现零改动/测试可改 | **已闭** | design §6 与 spec 将零改动限定为既有实现，明确允许按 §6.6 更新测试文件；`app.globalImport.test.ts` 双模式改动有任务项。 |

## 阻塞问题

### P1-1 Mutation 授权消费不能单独保证外部 exactly-once，也没有定义撤销范围

design §3.6:96-101 把 `generate` 与 `export` 纳入同一 grant 流程，并要求“恰好一次”；第 3 步只规定在数据库事务内标记 grant consumed。若进程在远端图像 API 已接受生成后、写回本地结果前崩溃，本地无法判断副作用是否发生；消费 grant 的事务不能与远端 API 调用原子提交。重试可能重复生成，不重试则可能把成功操作永久记成失败。现有 ComputeProvider 的幂等键（design §5）并未明确用于图像 API，也未覆盖不支持幂等键的 provider。

同一段的 patch_history/undo 只定义逆序回退 patch op，但 spec:55、59 对全部 approved-mutation 描述批准组撤销；生成任务与导出分享不是可直接逆序回放的 patch。当前契约无法判断“撤销整组”是否包含取消生成、删除产物、revoke 分享，或仅适用于 patch。

**可验证修复：**将 mutation 统一建模为持久 operation（proposalId 唯一幂等键，状态至少包括 approved/claimed/running/succeeded/failed/unknown），先原子 claim，再将稳定幂等键传给支持幂等的 provider，保存结果并让重试返回同一结果。对不支持幂等的图像 API，明确降为 at-most-once/unknown 并提供人工核对，不能承诺 exactly-once。分别冻结 patch undo、generate cancel/产物清理、export revoke/bundle 清理的补偿语义；或把“撤销批准组”严格限定为可逆的 patch 操作。测试进程在 provider 前后崩溃、响应丢失重试、同 proposal 并发调用及撤销各 mutation 的最终状态。

### P1-2 clear 未阻止活跃写入，outbox unlink 可能删掉新引用的 blob

design §6.5:161-165 的清理事务将 session 标记 `clearing`、撤销私有 blob 引用并登记 ref_count 将归零的文件，之后事务外 unlink。契约没有规定 clearing 后 followup/answer 是否拒绝、活跃 agent task 如何取消/等待/栅栏，也没有要求帧/产物 writer 在提交前检查 session 状态。于是清理登记 outbox 后仍可能有 worker 追加帧或写资源；事务②删 task 后仍可能产生孤儿文件。

同样，引用归零文件进入 outbox 后、unlink 前，其他 session 可能复用同一个内容 hash 并把 blob ref_count 加回去；outbox 仍会 unlink 该文件，导致新资源悬空。共享 result 引用独立这一改动没有解决普通 blob 的并发重新引用。

**可验证修复：**在事务①将 session 切到 clearing 后，原子拒绝新 followup/answer，并取消或 drain 所有运行中 agent task；为 task writer 加 generation/CAS fence，所有帧、产物写入在同一事务验证 session/task 仍可写。零引用 blob 进入 `deleting`/带 generation 的状态并阻止新引用，或在 unlink 前以锁/CAS 重验引用数；只有 unlink 成功后才删除 blob 行并释放重建。增加 clear 对活跃 task 的竞态测试，以及另一个 session 在 outbox pending 时重新上传相同 sha256 的并发测试，断言无迟到帧、无悬空引用、无丢 blob。

## P2 收口项

- design §4:108 仍称“降级三态 E2E”，但 §6.4:143 和 tasks W4.1:31 已是四态；更新汇总句，避免任务清单与实施顺序产生不同预期。
- design §3.4:61 写 `exportGate isExportable=false`，真实 API `exportGate()` 返回 `ExportGateVerdict { ok, violations }`；`isExportable(warnings)` 是 `validate.ts` 的独立函数。改用 `exportGate().ok === false` 或准确描述调用链，并在 adapter fixture 中断言真实出口。
- design §6.3:135 将“资产缺失”与 `CustomAssetIdMissingError` 并列。源码该错误只覆盖 custom 缺少 assetId；assetId 存在但资产未解析由 exportGate 的 `missing-asset` violation 表达。PNG 可新增 typed error，但应冻结独立错误 code，避免误称复用同一错误语义。
- design §6.5:163 同时写“删除会话行”和“session.status='cleared'”；同一行若被删除就无法再写状态。明确保留 cleared tombstone（并给 TTL/清理策略）或先记 cleared 再删除，并规定重复 clear 的 not_found/幂等返回。

## 质量评价

| 维度 | 分数 | 依据 |
|---|---:|---|
| R2 问题响应度 | 9.0/10 | B1-B8 都有明确修订落点；排布和权限方案开始逐字段、逐故障态可验证。 |
| 文档交叉一致性 | 8.0/10 | 主规格同步完整；仍有三态/四态、clear 行状态及 exportGate API 名称不一致。 |
| 契约可实现性 | 7.8/10 | 会话、adapter、PNG 与恢复测试变得具体；外部 mutation exactly-once 和活跃清理隔离仍有系统边界缺口。 |
| 安全与生命周期 | 7.5/10 | 服务端 grant 与 revision CAS、MCP 独立监听显著增强；副作用补偿及 blob 回收并发仍需裁决。 |

**综合 8.1/10，NEEDS-WORK（较 R2 +1.4）**。加分来自 B1、B3–B5、B7、B8 的闭合和 B6 的 outbox 化；未给 GO 是因为 generate/export 的“恰好一次/撤销”无法由 grant 消费事务单独保证，且 clear 期间 worker/blob 并发会破坏其一致性承诺。先关闭两个 P1，再修正 P2 文案和 API 细节。严格 OpenSpec 校验通过，但不改变该结论。
