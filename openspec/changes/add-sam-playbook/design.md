# design — add-sam-playbook

> 前置实证：桥协议（sam-bridge/PROTOCOL.md）现成支持 text/box/boxNegative 组合与纯 box；points 线上 UNSUPPORTED（SAM3.1 `Prompt` 类无 append_points，`SequenceGeometryEncoder` 有 points 配置位）。daemon 契约已有 `geometric{points[{x,y,label}]}` 形态（设计于早期、线上收 UNSUPPORTED typed 拒）。点提示 spike（macmini）与研究（官方语料）并行进行中，D4 方案以 spike 结论为准落定。

## D1 实例枚举（玩法①）

- `SegmentOneInput` 增 `instances?: 'best' | 'all'`（缺省 best=现状语义零变化）
- `'all'`：桥响应全部实例逐个落子层——每实例独立掩膜/质量门/预览回流/兄弟互斥消解；命名=`childNameForHint + 序号`（如「星星 3」）；segmentPrompt 记原文+`[instance-N]` 后缀
- MCP 工具描述教法：「需要逐个同款对象（六颗星星/每朵花）时用 instances=all；要整片区域用缺省」
- 循环链（subject.segment 工具）同步暴露（loop 消费面同改）

## D2 负例框（玩法②）

- text prompt 契约增 `boxNegative?: NodeBBox`（与 box 可组可单）；桥透传（线上协议现成）
- 质量门联动：`mask-parent-iou`/泄漏类告警文案追加「可用 boxNegative 排除泄漏区重试」指引
- Dialog：试跑预览图上拖画负框（叠加红色虚线渲染）→ 重试跑
- MCP 描述教法：「掩膜泄漏到无关区域时，把泄漏区坐标作 boxNegative 重试」

## D3 纯 box（玩法③）

- text prompt 的 `text` 放宽为 optional，superRefine「text 与 box 至少一项」（线上协议本语义）
- 纯 box 无 hint：命名缺省「框选区域」；segmentPrompt 记 `box[x,y,w,h]` 语义串
- Dialog：目标层预览上拖画正框（无指令模式）→ 试跑

## D4 点提示（玩法④——方案随 spike 落定）

- 候选 A（优先）：**桥 wire 映射层微框近似**——points→以点为中心的微框（尺寸取 spike 实证值，正/负 label→box/boxNegative），服务零改造
- 候选 B：macmini 服务包装底层 points 配置位（若库面实证有可用路径且效果显著优于 A）
- 契约面 `geometric{points}` 已存在不动；Dialog 点选交互（点击=include/shift 点击=exclude）
- MCP 描述教法：「掩膜差一点/多一点时，用点提示微调（include/exclude 点）」

## D5 MCP 工具升级 + skills/知识库

- `subject.segment`/`layer.split` 工具描述升级：新参数说明+**浓缩策略指引**（计数词陷阱/背景反选/部位拆分/负框修漏/实例枚举/点微调——每条一句话+失败信号对应解法）
- 知识库新组 **「SAM 提示词策略」**（DATA_ROOT/knowledge/，kb_list/kb_get 现有书架模型零改动）：
  - `index.md` 组说明
  - `计数与实例.md`（计数词失效模式→instances=all/逐部位）
  - `背景反选.md`（Owner 战例：三天使→background 剔除+反选；适用条件）
  - `部位拆分与层级.md`（整人→头/发/袍/翅的拆分策略）
  - `负框与点微调.md`（泄漏排除/边缘微调）
  - `措辞规律.md`（研究条目：官方语料+社区实证——带来源 URL）
  - `失败信号对照表.md`（告警 reason ↔ 建议动作——与质量门 reason 枚举对齐）
- 工具描述里指名引导：「分件遇阻先 kb_list『SAM 提示词策略』组」

## D6 迭代循环协议（Codex 审查驱动）

- **基线**：iter-0 = T6b 存档（v36 树+已知短板清单）
- **每轮**：新匿名会话（不覆盖历史）→ 同图三天使 → 固定验收指令（分件完整性/逐星/右头冠/翅膀——文字冻结在 tasks.md）→ Agent 自主用新工具+KB → 导出分享包
- **存档** `experiments/sam-playbook-20261004/iter-N/`：会话/任务 id、分享链接、树统计（节点/掩膜指标/质量门 warnings）、agent 关键转录（提示词决策点）、Codex 审查全文、本轮 skills/KB 调整 diff
- **审查**：Codex（大地三）逐轮审——分件质量（对照验收指令）/工具与 KB 使用证据/较上轮变化；输出评分+「满意/不满意」明确判定
- **满意线**：Codex 原文「满意」+无 P1+评分≥9；不满意→调 skills/KB（只动知识面）→ 下一轮
- **出循环条件**：Codex 判定问题在管线代码→暂停循环，单独修复后从当前轮重开（存档续编号）
- 轮数护栏：≤5 轮（超出即升级 Owner 裁决方向问题）

## 风险与边界

- points 微框若 spike 证伪（效果差）→ ④降级为「Dialog 点选转微框仅 UI 面」或挂账披露，不硬上
- instances='all' 在密集同款场景（满天星）可能爆节点数——上限护栏（如单次 ≤24 实例，超限 typed warning+截断明示）
- 迭代循环消耗生产 LLM/SAM 资源——每轮预算：单会话 ≤90min
