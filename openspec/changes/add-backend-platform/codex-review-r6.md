# add-backend-platform Codex Review R6

- 基线：`ea9ba03`；目标：`b335ef0`（当前 HEAD）。环境自检确认目录 `/Users/kzf/Pictures/贴钻`，HEAD 为 `b335ef0`。按要求核对 `git diff ea9ba03..b335ef0 -- openspec/changes/add-backend-platform/`。
- 结论：**NO-GO / NEEDS-WORK，8.8/10**；相对 R5 **+0.2**。R5 的 rowGen 持久性 P2 已闭；R5 的重试授权入口及 attempt 身份问题大幅收敛，但缺少客户端确认幂等身份，重放可能产生新的计费 attempt，仍为 P1。另发现 attempts 持久表未进入 DB 映射/DDL 清单，列为 P2。
- 验证：`openspec validate add-backend-platform --strict` 通过（`Change 'add-backend-platform' is valid`）；`git diff --check ea9ba03..b335ef0 -- openspec/changes/add-backend-platform/` 通过。本次差异仅改 OpenSpec 文档，不包含运行时代码或测试实现；报告结论是设计/验收契约评审，不代表功能已实现。

## R5 项逐项复核

| R5 项 | 状态 | 证据与判断 |
|---|---|---|
| P1 重试授权与 attempt 身份 | **部分闭合，仍阻塞** | [design.md](/Users/kzf/Pictures/贴钻/openspec/changes/add-backend-platform/design.md:82) 冻结 owner 认证 `session.retry`，§3.6:110 定义 unknown/归属校验、费用确认、不复用已消费 grant、CAS 重验、attemptId/attemptNo/idemKey 和单 active attempt；[spec.md](/Users/kzf/Pictures/贴钻/openspec/changes/add-backend-platform/specs/backend-platform/spec.md:64) 同步 MUST，[tasks.md](/Users/kzf/Pictures/贴钻/openspec/changes/add-backend-platform/tasks.md:37) 加入越权、并发、重启测试。但 retry 请求没有客户端提供且持久化的确认幂等键，`attemptId` 是服务端响应才分配，不能识别响应丢失后的原请求重放；见 P1-1。 |
| P2 rowGen 持久性 | **已闭合（设计契约）** | design §6.5:178 将 rowGen 冻结为持久、永不复用的行主键 UUID，outbox 保存完整旧代路径，发布顺序为 staging→原子 rename→DB 行提交，并要求启动回收；spec:49 与 tasks:31 同步，任务增加重启/旧 outbox 重放及提交失败孤儿回收测试。旧代 unlink 命中新代路径的顾虑已由持久代际路径解决。 |

## Standards

未发现硬性规范违规或可单独报告的 Fowler smell。差异只修改 OpenSpec 文档；仓库内未发现额外的 `AGENTS.md`、`CONTRIBUTING.md` 或编码规范文件，`git diff --check` 通过。attempt 重放问题属于 Spec/API 契约，不是编码风格问题。

## Spec

### P1-1 重试确认缺少请求级幂等身份

design §3.5:82 与 §3.6:110、spec:64 冻结的输入仅为 `{sessionId, proposalId, costConfirmed}`，输出才含服务端生成的 `{attemptId, attemptNo}`。文档要求“同确认并发只产生一个 attempt，下一 attempt 需用户再次确认”，但没有字段或持久记录定义“同一确认”的身份。

具体失败序列：服务端收到确认并创建 attempt，响应在网络中丢失；用户端以相同参数重试请求。若 attempt 仍 active，服务端可返回现有 attempt；但若首次 attempt 已因远端结果不可知而收敛为 `unknown`，该相同请求与用户有意进行下一次确认在当前 wire 契约上完全相同。服务端无法同时做到“原请求重放返回原 attempt”与“新的确认创建下一 attempt”。对不支持幂等键的 provider，重放可被误当新付费重试，造成重复远端调用/计费。`attemptId` 作为响应字段无法解决首次响应未抵达客户端时的去重。

**可验证修复：**在 `session.retry` 请求中加入客户端生成的 `retryRequestId`（或等价确认幂等键），并将其与 owner、session、proposal、cost confirmation 和创建的 attempt 持久关联且设唯一约束。相同 key 重放必须永远返回同一 attempt，即使该 attempt 已变成 `unknown`；用户有意再次承担费用时必须生成新 key 并再次明确确认。验收覆盖响应丢失后首次 attempt 已变 `unknown` 再重放仍不创建第二 attempt、同 key 并发/重启仍收敛同一 attempt、新 key 才能创建下一 attempt，以及跨 owner/session/proposal 复用 key 必拒。

### P2-1 attempts 持久账本未进入 DB 映射与 DDL 验收

design §3.6:110 和 spec:64 要求持久 `attempts` 账本，W0.1/W4.2 也要求 schema、恢复与重启测试；但 design §2 DB 映射表:42 只列出新增的 `patch_history`、`grants`、`approved_ops` 三表，[tasks.md](/Users/kzf/Pictures/贴钻/openspec/changes/add-backend-platform/tasks.md:18) 的 W1.2 DDL 同样只列这三表，未列 `attempts` 或其等价持久结构。因而架构映射、初始 DDL 验收和 attempt 状态机之间不一致，持久化约束缺少明确迁移落点。

**可验证修复：**将 `attempts` 纳入 design §2 表映射，并在 W1.2 或 W4.2 明确 DDL/迁移验收；至少冻结 `attemptId` 主键、`proposalId + attemptNo` 唯一性、retryRequestId 唯一性、provider 幂等键、状态及父 operation 关联。迁移测试需断言重启后 attempt、重试幂等映射与 owner/task 归属仍可查询。

## 质量评价

| 维度 | 分数 | 依据 |
|---|---:|---|
| R5 修订响应度 | 9.1/10 | owner 重试授权、父 operation 绑定、CAS 和 attempt 账本均已同步 design/spec/tasks；请求重放身份仍缺失。rowGen 分配与恢复缺口已闭。 |
| 文档交叉一致性 | 8.5/10 | retry 语义跨三文档大体同步；attempts 持久表缺失于 DB 映射和 DDL 清单。 |
| 可实现/可验收性 | 8.7/10 | 新增并发/重启/恢复验收较具体；需补 request idempotency key 与 DDL 落点。 |
| 安全与生命周期 | 8.7/10 | 明确禁止复用 grant、校验 owner/task 和 revision；重放仍可扩大计费副作用。rowGen 恢复顺序及孤儿回收已有测试要求。 |

**综合 8.8/10，NO-GO / NEEDS-WORK（相对 R5 +0.2）**。主要提升来自 retry 授权和账本契约已成形、rowGen P2 已闭；分数仍受一个可导致重复付费的 P1 请求重放歧义和一个 P2 持久层映射遗漏限制。补入 retry 请求级幂等身份并同步 attempts 表/迁移后，重新复审。

轴结论：Standards 0 项；Spec 2 项（P1：确认重放可创建新计费 attempt；P2：attempts 表/DDL 映射缺失）。
