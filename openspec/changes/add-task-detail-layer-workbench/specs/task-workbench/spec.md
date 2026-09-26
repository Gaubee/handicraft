# task-workbench 能力增量（add-task-detail-layer-workbench）

## ADDED Requirements

### Requirement: 任务详情动线（Agent 会话→排钻工作台）

Agent 会话的 done 帧卡 SHALL 提供「打开任务详情」入口，进入以该任务为上下文的排钻工作台视图；工作台数据 SHALL 由 task.detail RPC 组装（task/session 行+原图锚（scene-analysis 工件）+图层树+当前指派+gems+预览——六面各自可空，管线未跑到的面=null/[]）。

#### Scenario: 装载四态

- **when** 工作台打开且任务存在 → 显示标题/状态/gems 计数+图层树+画布+策略卡
- **when** 任务无图层树（管线未跑到识图）→ 图层面显示指引「先在 Agent 会话完成识图抠图」
- **when** 任务不存在/跨用户 → typed 拒（NOT_FOUND/FORBIDDEN）
- **when** RPC 失败 → 错误态可重试

#### Scenario: task.detail 数据组装口径

合法集口径与 tasks.artifact 同源（帧流 latest-by-name ∪ 任务域工件）；原图锚从 scene-analysis 工件取（imageBlobRef+imagePx+canvasCm）。

### Requirement: 人类拆层（原子双消费面——与 Agent 共用 segmentOne）

图层管理面选中图层+输入文本提示时系统 SHALL 调 layer.split RPC（登录态+owner 审计版本入史）执行 segmentOne 原子单步细分（text+box 组合提示锚定父节点外接框——PROTOCOL §4；沿共享 SamBridge；父∩子位与+碎片清理+兄弟互斥）→ 子层入树+预览双轨落档+artifact 帧；UI 自动选中新子层；失败态驻留可重试；零检出显式反馈（toast）。

#### Scenario: segmentOne 单步原子

- **when** 选中节点+提示 → 恰一次 SAM segment（非整循环）+树更新+双工件+帧
- **when** 目标节点不在当前树 → typed 拒 node-not-found（提示刷新）
- **when** 桥不可达/失败 → typed 上抛（不静默降级——人类「拆这一层」意图明确）
- **when** 零检出（交集空/被兄弟吞没）→ children=[]+warnings 如实返回

### Requirement: 策略直改（D-1 直接生效）

工作台策略卡改参数/密度/策略族 →「应用」SHALL 直调 layer.strategy.set RPC（不走提案审批——人类主权面），registry 参数校验+引擎校验门 MUST 照走 → 单节点指派替换+execute 真身重算 → gems/预览刷新（钻数联动）。stoneIdx 缺省时继承该节点既有指派的钻（参数微调不强迫重选钻）；指派集收敛到当前树产块节点（树漂移处置）。

#### Scenario: 直接生效语义

- **when** 改 rays/密度并应用 → 指派行立即更新+全图 gems 重算（计数变化可见）
- **when** params 非法 → typed 拒 params-invalid（字段级信息）
- **when** 非 exclusion 指派且无 stoneIdx 且无可继承 → typed 拒 stone-invalid

### Requirement: 图层树操作与版本史

图层重命名 SHALL inline 编辑直接生效；tree.history SHALL 返回版本链（人类操作入史+电流指针如实反映 Agent 链外写）；tree.revert 回退到指定版本。

#### Scenario: 版本审计

- **when** 拆层/改名/直改 → tree_versions 入史（cause+detail+actor）
- **when** Agent 整循环写树 → 不入版本表（零触碰 subject.segment 红线）——审计走帧流 artifact 帧，电流指针单独解析如实反映
