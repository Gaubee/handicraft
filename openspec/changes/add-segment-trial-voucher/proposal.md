# add-segment-trial-voucher

## 为什么

add-vision-pipeline-v2 的 Codex R2 复核（7.1/10，2026-10-04，见 `../add-vision-pipeline-v2/codex-review-r2.md`）确认了两个架构级残留 P1。它们不在该变更的验收口径内（口径 1-7 已全 PASS），但都是「用户确认的结果与实际落地不符」或「并发写树丢更新」的真实风险面，且与 Owner 对 D6 的任务队列/微服务拆分愿景同向——服务端试跑凭证正是「Dialog=任务详情、确认=消费任务结果」形态的正确地基。

## 是什么

1. **服务端试跑凭证（trial voucher）**
   - 现状：确认（dryRun=false）只做可选 `trialTreeBlobRef` 入口比较；不绑定指令/目标/有效精度/掩膜身份。tuner 每请求实时读配置——试跑与确认之间配置漂移会改 reqHash 触发**静默新桥调**，UI 不告知「落地非所见预览」；账本掩膜 blob 失效时 segment-one 摘条目重跑，同样无感知。
   - 方案：dryRun 生成服务端凭证（绑定 tree/imageBlobRef/targetNodeId/生效 reqHash/掩膜 blobRef），确认请求携带凭证 id 只消费对应结果；任何失效（配置漂移/掩膜回收/树推进）返回 typed `trial-stale`/`trial-expired`，UI 提示重新试跑。旧直拆调用保留独立语义。
2. **树发布 CAS（TOCTOU 收口）**
   - 现状：`segmentOneSplit` 入口树校验通过后 SAM 桥调用在途（60-120s）期间，其它写者（agent 会话/另一工作台）可推进树；返回后细分仍基于旧树持久化并发布 artifact，`recordTreeVersion` 无基树 CAS——最后写者覆盖，先写者的子层丢失。
   - 方案：树发布前以基线引用做原子 CAS（或同 task 树写串行化队列）；冲突时拒绝发布，typed `tree-conflict` 让 UI 刷新重试跑。

## 不做什么

- 不改质量门阈值/预览通道/precision 语义（已验收）。
- 不实现多任务并行抠图队列本身（凭证是其地基，队列形态另立 change）。

## 验收口径（草案）

- 试跑后改 SAM 配置再确认 → typed stale 拒绝+UI 提示重试跑（而非静默新桥调）
- 试跑后账本掩膜 blob 被回收再确认 → 同上
- 桥在途期间并发树写 → 后发布者收 tree-conflict，树不丢更新（构造并发测试）
- 全部 typed 拒均有 schema 测试；旧客户端（不带凭证）行为兼容
