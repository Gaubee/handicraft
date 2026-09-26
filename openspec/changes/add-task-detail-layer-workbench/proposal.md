# Proposal: add-task-detail-layer-workbench

## Why

Owner 定调（2026-09-26）：Agent 主攻两件事——①切图遮罩成图层（SAM 抠图）②给每个图层贴钻策略。**任务详情本质上要展示的就是「排钻工作台」**，而当前排钻工作台是早期纯前端版本（本地 k-means 分块+密度滑杆+四算法对比），与内核的 ObjectTree/mask/SAM 图层模型完全脱节——没有任务详情视图、没有图层管理、人类无法主动操作图层。

核心愿景=**功能原子化的双消费面**：SAM 抠图等原子能力既被 Agent 消费（MCP 工具，对话驱动），也被图层管理界面消费（人类主动拆分图层，达到和 Agent 一样的效果；未来还可修改遮罩）。前后端配合驱动，不再是纯前端。

## What Changes

### 1. 任务详情动线（新视图=排钻工作台重构）

- Agent 会话流/任务卡→「打开任务详情」→进入该任务的排钻工作台（前后端驱动）
- 数据组装 RPC：task.detail（task→原图 blobRef+ObjectTree+策略指派+gems+预览，从 daemon 载入）
- 工作台=图层管理+贴钻策略两区（替代旧 Block/Layer/Segment/Palette 纯前端面板；旧引擎演示面归档为「引擎实验」入口或移除——design 定）

### 2. 图层管理面（人类主动操作——与 Agent 同一后端原子）

- 图层树：显隐/选中/重命名；mask 画布叠加可视化（框线+半透明蒙版）
- **人类主动抠图**：选中图层→输入文本提示（如「把帽子拆出来」）→调后端 segment 原子（人类直调 RPC 面，不经 Agent 对话）→产生子图层入树（与 Agent 跑 subject.segment 的产出同构：tree 更新+mask+预览）
- 后端原子抽取：内核已有的 runSegmentLoop/persistTreeWithPreview 之上抽「单次细分」细粒度原子（segmentOne：指定节点+提示→子节点），Agent 工具面与人类 RPC 面共用
- 撤销/重做（tree 版本化——tree-persist 已有持久基建，补操作历史）
- （后续波）人类修改遮罩：笔刷/橡皮编辑 mask→回写 tree

### 3. 贴钻策略面（两层编辑铁律保持）

- 每层策略卡：策略族+参数表单+钻与密度（复用策略设计器 ParamsForm 投影）
- 人类调整→「生成调整指令注入对话」（铁律：Agent 重新提案→批准）；已批准指派的重新执行走既有 execute 面
- 排钻结果画布：点阵渲染（复用 StrategyCanvas 三层：原图+框线+点阵）

### 4. 设计决策点（design.md 冻结前需 Owner 拍板）

- **图层操作直接生效 vs 走审批**：Owner 表述「人类主动拆分图层达到和 Agent 一样的效果」→ 本 proposal 按「图层结构操作（拆分/重命名/显隐）直接生效，贴钻策略调整走两层铁律」处理；若策略也想直改需明确开口
- 旧排钻工作台的去留（归档为实验入口 / 直接移除）
- 人类抠图的认证面：走既有登录态+RPC（与 stonesAdmin 同模式）还是复用任务 owner 审计

## Impact

- daemon：task.detail RPC+segmentOne 原子+人类直调 RPC 面（认证/审计挂 owner）+tree 操作（重命名/撤销基建）
- rhinestone-studio：排钻工作台重构（图层管理+策略面+画布）；任务详情动线（AgentView/SessionStream 加入口）
- contracts：task.detail 响应契约+segmentOne 入出参
- 复用：StrategyCanvas/ParamsForm/LayerTree（策略设计器组件迁移复用）、tree-persist、SshSamTransport、授权桥
- 依赖：macmini 恢复前人类抠图真跑受限（mock 桥可开发；SAM 原子接口不变）
