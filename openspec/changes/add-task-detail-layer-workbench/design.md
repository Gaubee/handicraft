# Design: add-task-detail-layer-workbench

## 架构决策（D-1 策略生效方式——Owner 未及时应答，按推荐项裁定，2026-09-26）

**人类在工作台改贴钻策略=直接生效**（立即重算点阵，所见即所得）。依据：
- Owner 原话「人类可以在图层管理这里主动拆分图层，达到和 agent 一样的效果」——延伸到策略面即人类操作直接产出结果
- 排钻工作台=人类主权面（设计师主导）；Agent 对话场景保持提案→批准铁律不变（两场景各自独立入口）
- 审计需求由操作历史（tree 版本化+策略变更记录）承载，不靠审批链
- 后果：需要人类直调的 strategy 重算 RPC（复用 execute 的执行真身，跳过 proposal/consumeForExecution 授权段——走登录态+owner 审计，同 D-1 的共享写授权模型）

## 核心契约（实现波冻结面）

### task.detail（RPC GET）

```
GET /rpc task.detail {taskId} →
  { task: {id, title, status, createdAt}
  , session: {id, title}
  , baseImage: {blobRef, widthPx, heightPx, canvasCm}
  , tree: {blobRef, nodes: ObjectNode[]（含 mask inline）}
  , assignments: StrategyAssignment[]（当前生效）
  , gems: {blobRef, count, excludedRegions: n}
  , preview: {blobRef}（叠加预览 PNG）
  }
```

### segmentOne（内核原子——Agent 工具面与人类 RPC 共用）

```
segmentOne {taskId, nodeId, hint（文本提示）} →
  { children: ObjectNode[]（新子节点+mask）
  , treeBlobRef（更新后）, previewBlobRef, warnings[] }
```
- 实现：runSegmentLoop 的单步化（maxIterations=1+指定根节点+提示透传）；SAM 请求沿共享 SamBridge
- 人类面 RPC：layer.split {taskId, nodeId, hint} → 直调 segmentOne+tree-persist+owner 审计
- Agent 面：subject.segment 保持（整循环）；后续可在 prompt 层引导 agent 逐步用（不强制改）

### strategy.recalculate（人类直调 RPC——D-1 直接生效）

```
layer.strategy.set {taskId, nodeId, strategyKind, params, stoneIdx[], densityPerCm2} →
  { gems: {blobRef, count}, preview: {blobRef} }（单节点重算+全图预览重渲）
```
- 复用 execute 的逐节点 apply 真身（引擎校验门照走）；跳过 proposal 授权段

### tree 操作

- layer.rename {taskId, nodeId, objectName}（直接生效+历史记录）
- tree.history {taskId} → 版本列表；tree.revert {taskId, version}（撤销重做首版=revert）

## 前端结构

- 任务详情入口：SessionStream 任务卡+帧流 done 卡加「打开任务详情」→ studio 视图带 task 上下文（view store 扩展 studioTaskId）
- 排钻工作台重构：`src/lib/components/studio/taskWorkbench/`（TaskWorkbenchView：左 LayerPanel 可编辑版+右 StrategyCanvas 复用+下 ParamsPanel 复用）
- 旧 Block/Layer/Palette 面板：归档为「引擎实验」子入口（保留旧能力对照，不移除——零风险处置）
- agentApi 层：taskDetail/layerSplit/layerStrategySet/layerRename/treeHistory RPC 客户端+mock 双通道

## 验证策略

- 契约 zod schema 单测；segmentOne mock 桥单测+真桥 opt-in 冒烟（macmini 恢复后）
- jsdom 工作台交互测试（拆层流/策略直改流/撤销流）
- E2E 走查：装载小丑任务详情→人类拆「帽子」→改小丑策略→点阵刷新→vision 判读
