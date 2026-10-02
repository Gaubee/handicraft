# 提案：段循环断点续跑（291 段超窗根治）

## Why

Owner 挂账最大痛点（知识图谱 2026-10-02 §7.4）：**291 段全分解超窗**——单任务 3.8h 纯串行 SAM，超窗即全部作废。

三重杀窗实证（现状代码锚点）：

1. **看门狗静默杀**：`FOLLOWUP_TIMEOUT_MS` 缺省 30min，`onWatchdogFire` 只认 artifact/工具成功/审批为真进展（kernel/index.ts `watchdogFrameProgress`）；段循环是**单次工具调用内的长静默**——进行中零帧，连续窗口无进展即 `failByTask`。
2. **MCP 超时切断**：`MCP_TOOL_CALL_TIMEOUT_MS` 缺省 20min（boot.ts，P1-1 从 10min 提到 20min），到点 agent 侧放弃等待，daemon 侧循环成孤儿。
3. **重试驱逐→从零**：agent 报错重调 `subject.segment`，P1-1 孤儿驱逐（segment-tool.ts `inflightLoops`）abort 旧循环——已跑几十分钟的段全部丢弃，每次重试都从零开始。

三窗叠加的净效果：**任何需要 >20min 逐段分解的图，永远不可能完成**。

而续跑的地基其实已在：
- 段循环是**确定性状态机**（segment-loop.ts 头注：「同 deps 脚本 ⇒ 同请求序同产物，确定性测试覆盖」）——同输入重放必产生同请求序；
- 桥层 `materialize`（sam-bridge.ts:1223）**每个成功响应的掩码已经逐次物化成任务域 blob**（内容寻址+fence）；
- 缺的只是「请求→响应」的**可回放索引**与续跑装配。

## What Changes

核心思路：**断点账本（ledger）+ 回放适配器 + 时间切片**——不动纯状态机（segment-loop.ts 零改或近零改），全部装配在工具层适配器。

1. **T1 断点账本+回放适配器**：新 `segment-ledger.ts`——账本 `DATA_ROOT/segment-ledgers/<fp>.jsonl`（fp=循环内容指纹：imageBlobRef+imagePx+canvasCm+elements 规范化）；执行器 segment 适配器先按 reqHash（tuned 请求规范化哈希）查账本，命中=直接从 blob 读掩码返回（零桥调用），未命中=真桥调用后追记账本行（maskBlobRef 复用桥已物化的 blob）。同参数重调=确定性回放到断点后继续。
2. **T2 时间切片**：`SEGMENT_TOOL_SLICE_MS`（缺省 10min，<20min MCP 窗留余量）——适配器在实跑桥边界检查预算，到点=**正常返回** `status:'checkpointed'`（携带 banked/replayed/live 计数与续跑指令），不是错误、不进熔断计数；agent 链式再调直至 `status:'done'`。
3. **T3 进度帧+看门狗口径**：适配器实跑段逐段发 `progress` 帧、回放每片一帧汇总（contracts 既有 kind，前端已渲染；现生产 emitter 仅 job 族、看门狗 agent-only）；`watchdogFrameProgress` 把 progress 帧计为真进展（机器验证进展——掩码已落 blob 才发帧）。切片内看门狗持续重臂；桥队列长等待期仍可能被杀——**杀而不死**：账本保留，重调即续跑，进度单调不减。
4. **T4 跨任务语义+GC**：账本按内容指纹全局键控+**reqHash 投影剔 taskId**（请求锚点含 taskId，不剔则 followup/steer 新 task 条目全 miss——R1-P0-1）；跨任务同图同清单续跑在原会话存活期内成立（mask blob 挂原任务 fence；清会话后自愈重跑）；boot 时 mtime GC（`SEGMENT_LEDGER_GC_DAYS` 缺省 14d），blob 缺失自愈（回放 miss→重请求→新行）。

## Impact

- daemon：
  - 新 `src/kernel/vision/segment-ledger.ts`（账本读写/指纹/reqHash 投影/GC）；
  - `src/kernel/vision/segment-tool.ts`（适配器回放+切片+进度帧+checkpointed 结果面+时钟注入+工具描述更新）；
  - `src/kernel/index.ts`（`watchdogFrameProgress` 增 progress 帧=真进展，导出纯函数）；
  - kernel boot 接账本 GC。
- contracts：微改 3 行——`AGENT_FRAME_KINDS` 增列 `'progress'`（运行时 union 本含、前端已渲染，值域文档对齐）+ 交集注释与 frame.test.ts 守卫同步；progress payload 既有 `{text?, ratio?}` 够用。
- studio：零改（活动时间线已渲染 progress 帧）。
- 不动：`segment-loop.ts` 状态机（零改——SliceBudgetExhausted 经 cause 链在工具层收口）、engine/ 红线、SAM 桥协议。
- 语义变化（破坏性，无兼容层）：`SubjectSegmentOutcome` 变判别联合 `status:'done'|'checkpointed'`——工具结果是 agent 叙事面，无结构化消费方。
