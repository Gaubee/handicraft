# Codex 复核 R3（终审）— add-vision-pipeline-v2（2026-10-04）

- 复核人：Codex（gpt-6.1-sol xhigh，herdr agent codex-vision-v2）
- 对象：622c824（R2 残留便宜项修复）+ f3f1e25（add-segment-trial-voucher 立项草案）
- 评分：**7.3/10**（R1 6.8 → R2 7.1 → R3 7.3）

## 闭合判定

- **P2-1 闭合**：cropBitsOf 对试跑子层与落地子层分别逐字节比较同一最终互斥掩膜，覆盖 inline/blob 解码路径
- **P2-3 闭合**：trialing/landing 忽略外点、preview-ready 可关；新增外点 pointerdown 测试，studio 定点 8/8
- **D2 未完全闭合（P2→已修）**：tasks.md:8/:15 残留「请求侧降采样」混写——**终审后已修**（3c92b5d：原图透传+桥参数 maskMaxSide 生效）

## R2 两 P1 承接判定

f3f1e25 对两个 R2 P1 的**转移成立**：凭证方案覆盖树/图像/目标/有效请求指纹/掩膜引用，CAS 方案覆盖树发布竞态。但仅是 proposal，未实现。后续验收还应补充：prompt/target/precision 漂移、凭证重放/跨任务/TTL、掩膜引用回收、所有树写者统一 CAS、冲突方不得发布 artifact/version 等负例。

## 终审结论（原文）

> 可以按「本 change 运行时验收完成、两个 P1 明确 deferred」放行 add-vision-pipeline-v2 归档；add-segment-trial-voucher 立项承接成立，但在其实现和完整验收完成前不能宣称两个 P1 已闭合。

## 处置记录（MainAgent）

- 3c92b5d 修 tasks.md 措辞残留（R3 指出的最后一处）
- add-vision-pipeline-v2 归档；add-segment-trial-voucher 留活跃 changes 待排期
- 评分曲线：6.8 → 7.1 → 7.3（P1 架构项 deferred 承接后终审放行）
