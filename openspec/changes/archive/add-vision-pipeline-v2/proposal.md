# add-vision-pipeline-v2 — 抠图管线 v2（精度语义/指令可观测/参数化/工作台 Dialog/掩膜质量门）

## Why（原始需求——Owner 2026-10-03 晚批量定调，逐条归档）

生产实证（三天使图 round2）：tree_refine 补的节点以**纯中文 prompt** 送 SAM3.1（文本编码器英文为主）→ 右发掩膜泄漏成 95×288 全身条带/中发 1% 空膜/左翅收缩；agent 对病态掩膜**零感知**（工具返回纯文本数值面，预览图是「人看轨」）；「画布」图层被特殊化（不可选/不可抠图，非树根）；精度（maskMaxSide 降分辨率）语义疑似泄漏进产物（子图层掩膜非原分辨率）；工作台抠图无参数/预览/命名能力。

Owner 原话要点：
1. 图层命名仍由 Agent 决定（中文 OK）；**抠图指令英文为主**（中文仅限语义内容字面，如「图中的“你好”二字」）——已先行修复（英文 prompt 改造，另行提交）
2. **图层新属性：抠图指令**（segmentPrompt——该图层基于什么指令被抠出；破坏性更新，需重跑抠图流程补字段）
3. **精度语义**：原图分辨率全程保持——「原图原样送 SAM 推理（请求侧不降）→macmini 服务端推理后把返回掩膜降采样省带宽→daemon 桥边界最近邻升回原图分辨率」→以此 mask 抠图层→递归继续基于高分辨率——子图层永远尽量高清（措辞勘误 R1 P2-2：初稿「降分辨率只发生在 SAM 请求侧」与实现对齐后收敛为返回掩膜侧语义，见 design.md D2）
4. **精度参数化**：MCP 工具暴露 precision 参数；配置值=参考+默认；Agent 看效果差+时间允许时可自行调参重试（更高精度）
5. **工作台抠图 Dialog**：点击抠图→弹窗（展示目标图层+输入指令+调参数+**预览结果**）→满意后确认落地+落地前自定义图层名。架构预埋：Dialog=任务详情形态，未来抠图任务队列+多任务并发+计算服务微服务化拆分（不只单机）
6. 画布=所有图层 parent 根节点，形态与普通图层一致（可选/可发起抠图）——treeView 重做一并落地（Codex 执行中）
7. （诊断补充）**掩膜质量门+视觉回流**：几何先验（宽高比/填充率/与父节点高度比）拒收病态掩膜逼重试；掩膜预览图回流 agent（多模态反馈）——「Agent 看没看 SAM 产出的图」当前答案是没有，v2 要有

## What Changes

### 能力增量（spec 面）
- **vision/segment**：
  - prompt 英文为主（翻译确定性缓存+失败降级中文+warning）
  - `segmentPrompt` 记录进图层节点（ObjectNode schema 增可选字段——破坏性：新树有/旧树无；迁移=重跑抠图流程补字段，不静默伪造）
  - 图像字节原样送线（请求侧不降采样）；macmini 服务端按 maskMaxSide 把返回掩膜降采样省带宽，daemon 桥边界最近邻**上采样回 imagePx 原分辨率**后落树（D2）
  - `precision` 参数透传（MCP 工具参数；缺省取图像处理配置——参考+默认语义）
  - 掩膜合理性门：宽高比/填充率/父高占比先验→病态拒收（typed warning+回流 agent 决策重试/降级）
  - 掩膜预览回流：细分产物预览以多模态结果面回 agent（工具结果带图——dsh 工具面图像载荷通道）
- **workbench**：
  - treeView 重做：画布=树根（普通节点形态：可选/可抠图/可折叠），滚动锚定结构级解决
  - 抠图 Dialog：目标图层预览+指令输入+参数（精度/迭代）+结果预览+满意落地+落地前图层命名——任务详情形态（预埋队列并发扩展）
- **queue（架构预埋，本 change 只埋接口不做实现）**：抠图任务描述结构（target/prompt/params/status/preview）——Dialog 消费同构结构，未来换真队列/微服务不动 UI 面

### In Scope / Out of Scope
- In：上述全部的 daemon 管线+contracts schema+工作台 UI；三天使图回归验收（右发/中发/左翅三个病态掩膜为验收用例）
- Out（后置）：微服务拆分本体、抠图队列真实现、批量历史树补字段工具（另立小 change）

## Impact

- contracts：ObjectNode 增 `segmentPrompt?`（可选——旧树兼容）；segment 工具参数面增 precision
- daemon：segment-loop/tool（prompt 构造已先行/上采样/质量门/预览回流）、llm-route（翻译通道）
- rhinestone-studio：WorkbenchLayerPanel（Codex 重做中）、新抠图 Dialog 组件、任务描述 store
- 风险：上采样改变掩膜字节→账本 reqHash 变化（旧 checkpoint 回放 miss=多实跑一次，可接受）；预览回流增加 LLM 多模态 token 成本（可开关）
