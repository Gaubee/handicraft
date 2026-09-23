# add-backend-platform Codex Review R5

- 基线：`1dc1430`；目标：`ea9ba03`（当前 HEAD）。环境确认在 `/Users/kzf/Pictures/贴钻`；复核命令为 `git diff 1dc1430..ea9ba03 -- openspec/changes/add-backend-platform/`。评审聚焦 R4 两项 P1 与两项非阻塞修订，不把文档闭合等同于实现验收。
- 结论：**NO-GO / NEEDS-WORK，8.6/10**；相对 R4 **+0.3**。blob 删除/上传 TOCTOU 的设计缺口已闭合，R4 两项 P2 已闭合；但非幂等 provider 的新尝试没有冻结授权/API/attempt 身份，仍是 P1。
- 验证：`openspec validate add-backend-platform --strict` 通过；`git diff --check 1dc1430..ea9ba03 -- openspec/changes/add-backend-platform/` 通过。当前 diff 只改 OpenSpec 文档，没有实现代码或运行时测试证据。

## R4 项逐项复核

| R4 项 | 状态 | 证据与判断 |
|---|---|---|
| P1-1 provider 重试分支与 operation 恢复 | **部分闭合，仍阻塞** | design §3.6:104-108、spec:62、68-70 已明确 provider 幂等分支、非幂等分支不承诺唯一远端结果，并规定启动将遗留 `claimed/running` 收敛为 `unknown`；tasks:35 增对应 fixture 与恢复测试。剩余 P1：非幂等分支说“用户确认重试创建新的远端尝试”，但既有唯一 `proposalId` operation、已消费的一次性 grant 与唯一授权 API 尚无可执行衔接。详见 P1-1。 |
| P1-2 blob 删除与同 hash 上传 TOCTOU | **已闭（设计契约）** | design §6.5:178、spec:47、tasks:29 为每行使用 `<sha256>.<rowGen>` 新物理路径；旧行 unlink 只作用旧代，CAS 后/unlink 前 barrier 测试覆盖新上传。按当前冻结语义，新行文件不会被旧行删除。仍建议明确 `rowGen` 不复用，列为 P2。 |
| P2-1 `approved_ops` DB 映射及唯一键 | **已闭** | design:40 明列 `approved_ops` 且 proposalId 唯一；tasks:16 将 operation 表纳入 W1.2 DDL。 |
| P2-2 PNG 两类资产错误分别验收 | **已闭** | tasks:23 已拆成 custom 缺 assetId 的 `CustomAssetIdMissingError` 语义和资产未解析的独立 `PNG_ASSET_UNRESOLVED` 断言。 |

## Standards

未发现硬性编码风格违规；本轮 diff 仅涉及 OpenSpec 文档，`git diff --check` 通过。

## Spec

### P1-1 新远端尝试没有授权路径或身份

design §3.5:73-88 冻结的会话 API 只有 `session.answer {sessionId, requestId, approved}`；§3.6:99-101 规定 grant 绑定 proposal 并一次性消费；§3.6:104-106 又规定 `proposalId` 是 `approved_ops` 唯一幂等键，同时允许用户确认后创建新的非幂等 provider 尝试。当前没有定义用户通过哪个 API/命令表达这次新付费尝试，也没有新的 attemptId/attemptNo、父 operation 关系或新尝试如何获得一次性授权。

实现只能在两个不安全/不可用分支间猜测：复用旧 proposalId 会命中已消费 grant/既有 operation 去重，无法表达“明确批准另一笔可能计费的请求”；创建新 proposalId 则缺少重新绑定原 operation、资源版本和用户确认的契约。该授权边界未冻结，阻塞 GO。

**可验证修复：**冻结一个 owner-authenticated retry 动作，绑定原 operation、task/user、预期 `unknown` 状态及显式费用确认；为每次尝试分配持久唯一 `attemptId`，定义 attempt 与 proposal/approved_ops 的关系，并明确这次用户确认如何授权而不复用已消费 grant。支持幂等 provider 的重试复用远端 idempotency key；非幂等 provider 的重试必须是新 attempt，并在并发重复点击时通过 attemptId 本地幂等。测试未授权/跨用户重试必拒、旧 grant 重放必拒、同一确认并发只产生一个 attempt、用户再次确认才产生下一 attempt，以及重启后 attempt 归属和提示稳定。

### P2-1 rowGen 唯一性与文件崩溃恢复未冻结

design:178 的结构性保证依赖新旧 `rowGen` 不相同且旧 outbox 永远引用旧代路径，但文档没有规定 generation 如何持久分配或何时可回收。若实现复用 generation，迟到的旧 unlink 仍可能命中新路径；新行文件发布后 DB 提交失败也可能留下无法由行/outbox 定位的孤儿文件。

**可验证修复：**将 `rowGen` 定义为持久、不复用的 row primary key/UUID，并把完整旧代路径持久化在 outbox；冻结 staging→原子发布→DB 状态确认的顺序与启动孤儿回收。增加旧行物理清理后重启、同 sha256 新建行与旧 outbox 重放测试，以及文件写成功/DB 提交失败的恢复断言。

## 质量评价

| 维度 | 分数 | 依据 |
|---|---:|---|
| R4 修订响应度 | 9.2/10 | 两项 P2 收口；provider 结果分支/启动恢复落入 spec 与任务，代际路径覆盖原 TOCTOU。 |
| 文档交叉一致性 | 8.8/10 | DB、PNG 与 blob 代际描述已同步；授权一次性 grant 与新的付费 attempt 仍缺操作契约。 |
| 可实现/可验收性 | 8.3/10 | provider 与 blob barrier 测试具体；retry endpoint/attempt 身份和 rowGen 恢复尚未定义。 |
| 安全与生命周期 | 8.1/10 | 旧 grant 防重放保留，但未知结果后的新计费尝试还没有明确授权边界。 |

**综合 8.6/10，NO-GO / NEEDS-WORK（相对 R4 +0.3）**。主要进步是旧 blob unlink 无法命中新代路径，且 R4 两个 P2 已有设计和任务验收；本轮唯一阻塞是新增远端尝试无法在现有一次性授权与 proposal 幂等模型下被明确授权、区分和去重。冻结用户重试命令及 attempt 账本后再评 GO。

轴结论：Standards 0 项（无硬违规）；Spec 2 项（最重 P1：非幂等 provider 重试缺少授权与 attempt 身份，另有 P2 rowGen 持久唯一性未冻结）。
