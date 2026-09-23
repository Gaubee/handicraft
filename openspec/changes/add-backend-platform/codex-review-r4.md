# add-backend-platform Codex Review R4

- 基线：`91cf57c`；目标：`1dc1430`（当前 HEAD）。实际复核 `git diff 91cf57c..1dc1430 -- openspec/changes/add-backend-platform/`；diff 触及 R3 报告、design、spec、tasks。本报告只评审 R3 指定修订及本轮发现，不代表后续实现已经完成。
- 结论：**NO-GO / NEEDS-WORK，8.3/10**；相对 R3 **+0.2**。两项 P1 均仍未闭合，因此不能 GO。四项 R3 P2 中三项闭合，PNG 两种错误的设计区分已补、但 W2.3 测试任务未冻结为两个独立断言；另有一处 DB 映射摘要遗漏 `approved_ops`。
- 验证：`openspec validate add-backend-platform --strict` 通过；`git diff --check 91cf57c..1dc1430 -- openspec/changes/add-backend-platform/` 通过。change 内容为设计/spec/tasks 文档，未运行实现测试。对照现有引擎源码确认 `exportGate()` 的 `{ok, violations}` 返回形态及 `CustomAssetIdMissingError` 的缺少 assetId 语义。

## R3 项逐项复核

| R3 项 | 状态 | 证据与判断 |
|---|---|---|
| P1-1 approved operation 状态机、外部副作用及撤销 | **部分闭合，仍阻塞** | design §3.6:102 与 spec:60 已把 operation 持久化、proposalId 本地幂等、外部 unknown 和三族补偿拆开；tasks:33 也列了故障/重试测试。但 spec:68 仍称不支持 provider 幂等键时，用户重试可“以 proposalId 幂等收敛至唯一结果”，与 design:102 明言重试可能重复计费、不保证外部恰好一次矛盾。详见 P1-1。 |
| P1-2 clear 并发栅栏及 blob 回收 | **部分闭合，仍阻塞** | design §6.5:155、170-175 和 spec:45、55-57 已加 tombstone、拒新请求、worker/writer fence、deleting 与同 hash 重传场景；但 unlink 前 CAS 事务提交后到事务外 unlink 前仍有 TOCTOU 窗口，不能保证不删并发上传的新文件。详见 P1-2。 |
| P2-1 §4 降级四态汇总 | **已闭** | design:110 与 §6.4:143-145 均为四态：off、缺包/坏包解析失败、boot throw、正常。 |
| P2-2 exportGate API 口径 | **已闭** | design:62 改为 `exportGate()` 返回 `ExportGateVerdict {ok, violations}`，并明确 `isExportable(warnings)` 是独立函数；与现有 `rhinestone-studio/src/lib/engine/exportGate.ts:95-98` 一致。 |
| P2-3 PNG 资产错误类型区分 | **部分闭合** | design:137 明确缺 assetId 对齐 `CustomAssetIdMissingError`，资产未解析用独立 `PNG_ASSET_UNRESOLVED`，语义与引擎 `spec.ts:48-55` 的 typed error 边界相符。但 tasks:21 仍只写一个笼统的“缺失资产错误分支”，未要求分别断言两类错误/code，验收门不足以防止实现合并错误语义。 |
| P2-4 tombstone 留存矩阵 | **已闭** | design:155、165 与 spec:45 均一致规定保留 `cleared` tombstone、列表过滤、重复 clear 幂等、默认 24h 后物理清理。 |

## 阻塞问题

### P1-1 unknown generate 重试仍被写成唯一结果

design:102 已诚实规定：provider 不支持幂等键时，远端可能已接受而本地只能记为 unknown；重试可能重复计费，外部恰好一次不作保证。但 spec:68 又规定用户裁决重试后按 proposalId 幂等收敛至唯一结果。proposalId 只能去重本地 operation 记录，不能撤销或识别非幂等 provider 已接受的远端请求；两处不能同时成立。此外进程在 crash 时无法自行落库 `unknown`，文档只枚举 `claimed/running/unknown`，没有定义启动恢复如何识别遗留 `claimed/running` 并收敛；若无恢复规则，该 operation 可能永久卡住而不呈现 spec 要求的 unknown。

**可验证修复：**将 spec:68 改为分支语义：支持幂等键的 provider 重试/查询复用同一键并收敛同一远端 job/result；不支持时，原 operation 保持 unknown，用户确认重试可创建新的远端尝试且可能再次计费，不承诺唯一远端结果。冻结启动恢复：非终态 `claimed/running` 如何按 op 类型转为 `unknown`、幂等恢复或人工裁决，并定义 `failed` 与 `unknown` 的判定边界。增加两种 provider fixture 的崩溃后重启与重试断言，验证持久状态、远端调用次数和用户可见结果，另覆盖启动时遗留 operation 收敛。

### P1-2 blob CAS 检查与 unlink 未被同一并发栅栏覆盖

design:164、172 和 spec:45 的顺序是事务内 CAS 确认该 sha256 只剩 deleting 行，随后在事务外 unlink。CAS 提交与 unlink 之间，另一个会话可按新行上传/发布相同 sha256 的内容；旧清理 worker 随后仍会删除共享内容寻址路径，新引用留下悬空文件引用。spec:55-57 当前测试描述了 outbox pending 时同 hash 重传，却没有冻结这个更窄的交错，因此“不得丢文件/不得悬空”尚未由协议推出。

**可验证修复：**让上传发布与删除按 blob key 共用一个跨文件系统操作的 lease/锁，或使用 generation-specific 不可变物理路径并令旧代 unlink 无法命中新代文件；仅在 DB 事务中重验唯一性不够。增加确定性 barrier 测试：暂停 cleanup 于 CAS 提交后、unlink 前，上传并确认同 sha256 新引用可读，再恢复旧 unlink，断言新引用文件仍可读且计数/行状态一致；另测崩溃恢复释放 lease/续跑。

## 非阻塞一致性项

- **新 P2：DB 映射摘要漏列 `approved_ops`。** design §2 映射表:38 仍只写新增 `patch_history` 与 `grants`，但 §3.6:102 明定 `approved_ops` 持久表，tasks:14 也要求建表。更新映射表使 schema 盘点与迁移任务一致，并在 W1.2 DDL 验收列出该表及唯一 proposalId 约束。
- PNG 错误拆分的设计已正确，但 tasks:21 应分别列出“custom 缺 assetId → CustomAssetIdMissingError 语义”与“资产未解析 → PNG_ASSET_UNRESOLVED” fixture/code 断言。

## 质量评价

| 维度 | 分数 | 依据 |
|---|---:|---|
| R3 修订响应度 | 8.8/10 | operation 状态机、分族补偿和会话清理 fencing 已显著具体化；仍有重试承诺自相矛盾及文件系统竞态。 |
| 文档交叉一致性 | 8.2/10 | 四态、exportGate、tombstone 口径一致；spec 重试结果冲突，DB 表映射与 tasks 漏同步。 |
| 可实现/可验收性 | 8.0/10 | 故障测试覆盖更实，但未支持幂等 provider 的重试语义和 CAS→unlink 交错都欠缺可满足契约。 |
| 安全与生命周期 | 8.2/10 | 授权与撤销边界、clear writer fence 有进展；持久副作用与共享 blob 删除仍有高风险窗口。 |

**综合 8.3/10，NO-GO / NEEDS-WORK（相对 R3 +0.2）**。加分来自撤销族拆分、clear/tombstone 约束与三项 P2 文案收口；未给 GO 的决定性理由是 spec 仍承诺非幂等远端重试唯一结果，且 blob 删除 CAS 没有覆盖 CAS 提交到 unlink 的竞争窗口。先关闭两项 P1，再补齐 PNG 双错误测试门和 `approved_ops` 映射。
