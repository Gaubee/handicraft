## ADDED Requirements

### Requirement: 图层即遮罩的渲染模型（v4）

工作台渲染 SHALL 以「图层=mask ⊕ 原图的抠图层」为语义：背景层（原图，可隐藏）与各图层抠图按树序（=z 序，父先子后）叠加；图层隐藏 SHALL 使其钻布局（虚拟子层，assignments 派生）与树后代渲染一并隐藏。主画布常驻元素 SHALL 仅含图层内容与钻渲染——bbox 条框/文字标签/组徽标 SHALL 仅在 hover（细虚线+提亮）或选中（实线+名称标签+右栏联动）时出现。

#### Scenario: 抠图与显隐

- **when** 隐藏背景层仅显示某图层 → 画布呈现该图层的真实抠图内容（原图区域 × mask）
- **when** 隐藏有钻布局的图层 → 其钻渲染一并消失（子层传递）

#### Scenario: 少即是多交互

- **when** 无 hover/选中 → 画布零条框零常驻文字（纯图层+钻）
- **when** 选中图层 → bbox 实线描边+名称标签+右栏联动（hover 仅细虚线提亮）

### Requirement: 容器查询工作台（详情=工作台紧凑形态）

工作台 SHALL 为容器自适应单一组件（container-type+断点）：窄容器（agent 详情右栏/移动 sheet）呈现紧凑形态（迷你画布+图层列表+选中层摘要+关键操作），宽容器呈现完整三栏。任务详情面板 SHALL 直接挂载紧凑形态（同 store 会话）；「打开完整工作台」=纯放大，无状态迁移。

#### Scenario: 三形态一致

- **when** 同一任务在右栏/全屏/移动 sheet 打开 → 同一工作台组件按容器尺寸呈现对应形态（图层操作三处等价）

### Requirement: 纹理优先缺省（v4）

策略推荐 SHALL 以 texture-fill 为通用缺省（绝大部分场景）；规整族（straight-line/geometry 等）SHALL 仅在「画面硬朗且填充区接近纯色」时作为低成本解推荐。演示数据映射与策略设计引导 SHALL 遵循该决策树。

#### Scenario: 推荐排序

- **when** 无明确硬朗/纯色信号 → Inspector 策略推荐首项=texture-fill
- **when** 填充区接近纯色且画面硬朗 → 规整族作为低成本解出现在推荐中
