# design — add-sam-playbook

> 前置实证：桥协议（sam-bridge/PROTOCOL.md）现成支持 text/box/boxNegative 组合与纯 box；points 线上 UNSUPPORTED（SAM3.1 `Prompt` 类无 append_points，`SequenceGeometryEncoder` 有 points 配置位）。daemon 契约已有 `geometric{points[{x,y,label}]}` 形态（设计于早期、线上收 UNSUPPORTED typed 拒）。点提示 spike（macmini）与研究（官方语料）并行进行中，D4 方案以 spike 结论为准落定。

## D1 实例枚举（玩法①）

- `SegmentOneInput` 增 `instances?: 'best' | 'all'`（缺省 best=现状语义零变化）
- `'all'`：桥响应全部实例逐个落子层——每实例独立掩膜/质量门/预览回流/兄弟互斥消解；命名=`childNameForHint + 序号`（如「星星 3」）；segmentPrompt 记原文+`[instance-N]` 后缀
- MCP 工具描述教法：「需要逐个同款对象（六颗星星/每朵花）时用 instances=all；要整片区域用缺省」
- 循环链（subject.segment 工具）同步暴露（loop 消费面同改）

## D2 排除区 excludeBox（玩法②——**spike 纠偏 2026-10-04**）

> spike 实测线上 boxNegative **无空间排除语义**（负点收缩 0.15-0.18%≈噪声级；负框反涨 +233px；脸上负框把检出压到阈值下=陷阱）。协议矩阵的 ✅ 只验了「掩码非空」。**不透传不暴露 boxNegative。**

- text prompt 契约增 `excludeBox?: NodeBBox`：**桥响应后的确定性像素减法**（返回掩膜在矩形内像素清零，再走归一化/质量门/预览/落地）——纯 daemon 后处理，精确可靠
- excludeBox 入 reqHash；dryRun/确认回放幂等保持
- 质量门泄漏类告警文案追加「可用 excludeBox 排除泄漏区重试」
- Dialog：试跑预览图上拖画排除区（红色虚线叠加）→ 重试跑
- MCP 描述教法：「掩膜泄漏到无关区域时，把泄漏区坐标作 excludeBox 重试」

## D3 纯 box（玩法③）

- text prompt 的 `text` 放宽为 optional，superRefine「text 与 box 至少一项」（线上协议本语义）
- 纯 box 无 hint：命名缺省「框选区域」；segmentPrompt 记 `box[x,y,w,h]` 语义串
- Dialog：目标层预览上拖画正框（无指令模式）→ 试跑

## D4 点提示（玩法④——**spike 裁定：macmini 原生点包装**）

> spike 否决微框近似（4/8/16/32px 全尺寸失效——微框语义=「框住的小物体本身」而非「点下的实例」，IoU≈0）；实证 f16 权重点编码器全在、原生点 15+ 次推理机械可行。

- macmini 服务：`Prompt.append_points`（append_boxes 镜像）+ processor `add_point_prompt` + `prompt.points:[{x,y,label}]`（像素坐标服务内归一化）+ **topK 候选全给**（score/maskPx/box/containsPoints）
- daemon 桥层（T1 落地后接）：geometric points→wire points 透传；**候选筛选=含全部正点∧不含负点→score 最高**；单点常部件级→多正点拉全实例
- **负点=软先验不承诺排除**（实证）——工具描述如实标注；排除需求走 D2 excludeBox
- Dialog 点选交互（点击=include）；MCP 教法：「掩膜差一点/多一点时用点微调；多正点拉全实例；排除区域用 excludeBox」

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
