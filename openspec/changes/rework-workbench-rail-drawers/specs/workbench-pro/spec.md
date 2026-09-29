# workbench-pro 增量：PS 式轨道 Drawer

> 增量 requirement 挂 workbench-pro 能力域（任务详情工作台表现层）；基线见 add-workbench-pro/rework-layer-model/rework-layer-ps-panel 归档。

### Requirement: 轨道工具条与 Drawer 面板

任务详情中段 SHALL 为 左工具条｜画布区｜右工具条 三段骨架（工具条常驻竖排 w-11 级，PS 同款不收起）。左工具条 SHALL 含画布工具组（选择/平移/缩放/笔刷——命令总线单源不变）+「图层」开合按钮；右工具条 SHALL 含「属性」「历史」「快捷键帮助」按钮。图层/属性/历史面板 SHALL 以非模态覆盖式 Drawer 呈现（`backdrop-blur`+半透明底+滑出过渡），Drawer 开时不遮断画布交互，工具条 z 序恒高于 Drawer。

#### Scenario: 轨道交互

- **when** 点击左条「图层」按钮 → 左 Drawer 滑出（WorkbenchLayerPanel 在场）；再点收起
- **when** 右侧「属性」「历史」同时请求展开 → 互斥（同侧至多一个）
- **when** 画布在 Drawer 下方区域 → 平移/缩放/命中仍可用

### Requirement: 响应式开合语义

容器宽度 SHALL 驱动 Drawer 缺省态：≥42rem 双 Drawer 缺省展开；<42rem 自动收起。用户手动开合 SHALL 在同档宽度内记忆；宽度跌破断点 SHALL 强制收起并清除记忆（回 auto），升回断点恢复缺省展开。紧凑形态（<32rem）SHALL 保留画布+选中层摘要+策略直改条，面板全部经 Drawer（全宽 max-w-80）。底部历史 dock SHALL 退役（内容迁入右 Drawer，组件内部零改动）。

#### Scenario: 断点行为

- **when** 容器从 45rem 缩到 38rem → 双 Drawer 自动收起；用户手动再开图层 → 记忆；再缩到 30rem → 强制收起+清记忆+紧凑摘要条在场
- **when** 容器从 30rem 升到 45rem → 恢复缺省双展开
