# design — add-vision-pipeline-v2

## 数据流（v2 目标态）

```
S2 语义识图（LLM，英文 hint 随元素产出）
   │
S3-S5 迭代抠图循环（每节点）：
   ├─ prompt 构造：hint(英) ─┐
   │   无 hint ─→ LLM 翻译 objectName→英（进程缓存，温度0；失败降级中文+warning）
   │                        ▼
   │              英文为主 text prompt（中文仅内容字面）
   ├─ 精度：maskMaxSide 仅作用于 SAM 请求（原图过大→请求侧降采样）
   ├─ SAM3.1（macmini 桥）
   ├─ 结果掩膜 ─→ 上采样回 imagePx 原分辨率 ─→ 质量门：
   │      宽高比先验（细长类）/ 填充率下限 / 父节点高度占比
   │      ├─ 病态 → warning 回流 agent（携带预览图）→ agent 决策：换措辞重试/调精度/降级
   │      └─ 通过 → 落树（ObjectNode + segmentPrompt=本次指令 原文）
   └─ 循环直至停止判据
   │
工作台抠图（人工主权面，同管线）：
   点击图层「抠图」→ Dialog（任务描述结构）：
     [目标图层预览] [指令输入] [精度/迭代参数] → 试跑 → [结果预览]
     → 满意 → 命名图层 → 落地（父图层内新增子层，原层不动）
   画布=树根：可选/可抠图（同路径）
```

## 关键决策

### D1 prompt 英文为主（先行已修）
翻译层在 prompt 构造处（循环外逐节点一次）；确定性=进程 Map 缓存+温度 0；失败降级现中文 prompt+warning（可观测不阻塞）。账本取舍：译文跨进程不一致→reqHash miss→多实跑一次（记 warning）；同进程内稳定。

### D2 精度语义：请求侧降/结果侧升
- 请求：图像 bytes 降采样至 maskMaxSide（现有）——仅请求
- 结果：SAM 掩膜（请求分辨率）→ 最近邻上采样回 imagePx → 落树/预览/排钻全用原分辨率
- 递归细分天然基于原分辨率图层（v1 疑似把低分辨率带进子层——验收时用掩膜尺寸==imagePx 断言纠正）

### D3 precision 参数化
- contracts：segment 工具入参增 `precision?: { maskMaxSide?: number; confThreshold?: number }`
- 缺省=图像处理配置（参考+默认）；agent 可按效果自调（工具描述写明调参建议语义）
- 账本：参数入 reqHash（不同精度=不同请求，天然不串）

### D4 segmentPrompt 字段（破坏性，显式迁移）
- ObjectNode 增 `segmentPrompt?: string`（旧树无字段=兼容；不伪造）
- 新抠图必写；历史树补字段=重跑抠图流程（另立工具/脚本，Out of Scope 本体）
- 工作台图层行显示该指令（可观测：它基于什么指令被抠出）

### D5 掩膜质量门（几何先验）
- 门参数（可配置）：填充率 ≥5%；细长结构（hair/lineage 类）宽高比 ∈[0.5,2] 宽容带或高度 ≤父节点 90%；全类：与父掩膜 IoU 上限（防「整片父」泄漏——右发案例 IoU 会过高）
- 拒收≠丢弃：typed warning+预览回流，agent 决策重试（英文换措辞/调精度/拆分提示）
- 预览回流：工具结果面附预览 blobRef+多模态通道（dsh 工具图像载荷——LLM 真看图；token 成本开关）

### D6 工作台抠图 Dialog=任务详情形态
- 任务描述结构（store 单源）：`{taskId?, targetNodeId, prompt, params, status, resultMaskRef?, previewRef?, decidedName?}`
- Dialog 消费该结构：试跑→预览→命名→落地；本 change 单任务同步，队列化时 UI 面零改（结构已预埋）
- 落地语义：父层内新增子层（`tree_refine` 同链），父层原掩膜/名称不动——画布同权

## 验收口径（三天使图）
1. 右发：宽高比回正常带（~0.5-1.5）、不覆盖全身；金钻不流下身体
2. 中发：填充率 >5%（或 agent 显式披露不可抠+工作台手调路径演示）
3. 左翅：掩膜回收翅形（对比 v1 收缩）
4. 所有新节点掩膜尺寸==imagePx（400×400 帧内 bbox 掩膜不降分辨率）
5. 每节点 segmentPrompt 在工作台可见
6. 工作台对画布发起抠图→Dialog 全流程→子层落地
7. agent 收到病态掩膜时能看见预览图并自主重试（转录证据）
