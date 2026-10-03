# Codex 复核 R2 — add-vision-pipeline-v2（2026-10-04）

- 复核人：Codex（herdr codex 复核；R1 修复批 2f72b34/c3e09f3 之后）
- 对象：c3e09f3（评审固定基线）+ 变更文档
- 评分：**7.1/10**（R1 6.8，+0.3）
- 与 R1 对比：P2-1 互斥后预览、P2-3 忙碌锁窗、P2-5 precision 草稿、附带原型污染四项闭合；P1/P2-2 部分闭合；新识别 P1-A/P1-B 两项架构级加固面。

## R1 项闭合判定

- **P2-1 互斥后预览=实现闭合**：finalChildBits 单源——质量门/试跑图/Agent 特写/落树同用互斥后最终形态
- **P2-3 忙碌锁窗=代码闭合**：Escape 有测；外点（pointerdown outside/interactOutside）无测
- **P2-5 precision 草稿=闭合**
- **附带原型污染（mock spy 原型链）=闭合**
- **P1=部分闭合**：客户端快照+服务端 trialTreeBlobRef 入口校验在，但未绑定指令/精度/掩膜身份
- **P2-2 D2=部分闭合**：正文已正；流程图+proposal 残留旧措辞

## 新阻塞问题

### P1-A 确认未绑定试跑确切请求与掩膜凭证
- 服务端守卫只比可选 `trialTreeBlobRef`；缺省（旧调用方/空字段）跳过校验
- tuner 实时读配置致 reqHash 漂移会静默新桥调而 UI 不告知
- 修复建议：dryRun 生成服务端试跑凭证（绑定 tree/image/目标/reqHash/掩膜引用），确认只消费对应结果，失效返回 typed stale/expired

### P1-B 树守卫 TOCTOU
- SAM 桥调用在途期间树可被其它写推进；segmentOne 返回后仍基于旧树持久化发布，`recordTreeVersion` 无基树 CAS
- 修复建议：发布前原子 CAS，或同 task 树写串行化

## P2 / P3

- **P2**：D2 术语未全局收敛（design 流程图+proposal 残留「请求侧降采样」旧措辞）
- **P3**：P2-1 测试未证明子层字节同源（落地子层只比 bbox/置位数）

> 处置记录（MainAgent，2026-10-04 收尾修复批）：
> - **本修复批**：P2 措辞全局收敛（design.md 流程图改「原图原样送线→服务端缩掩膜省带宽→桥边界升回 imagePx」；proposal.md Owner 要点 3+What Changes 两处同步，附勘误标记；mask-resample.ts 头注/segment-one.test.ts T1 注释残留措辞一并收敛）+ P3 字节比较（segment-one.test.ts 部分重叠用例补试跑子层与落地子层对预期裁剪掩膜的逐字节比较——对齐试跑预览 PNG 字节级深度）+ 外点测试（workbench.segmentDialog.test.ts 补 trialing 态 Dialog 外 pointerdown 不关窗、preview-ready 后外点可关）
> - **P1-A/P1-B=立后续 change `add-segment-trial-voucher`**（Owner 视域内架构加固——试跑凭证绑定+树 CAS/写串行化，与任务队列/微服务拆分 D6 愿景同向）
