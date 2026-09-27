# 提案：图层模型 PS 化重构（v4——Owner 真机验收三轮反馈）

## Why

Owner v3 验收后三条方向性反馈：

1. **任务详情与工作台割裂**：详情应是工作台的紧凑形态（容器查询自适应），不是另一个轻量面板。
2. **纹理优先缺省被偏离**：texture-fill 是绝大部分场景的通用解（Owner 与我们刻意打磨的布局哲学）；规整族（hex/几何）只在「画面硬朗+填充区接近纯色」时作为低成本解。demo 映射 6/12 geometry 是过度规整化。
3. **图层数据模型根本性误解**：拆分图层=**遮罩**。遮罩 ⊕ 原图 = 真正的图层（带 alpha 的抠图层），与背景（原图）叠加；图层的 children 里有钻的布局层（有钻才有）。当前实现把 boxPx 矩形条框+常驻文字标签当图层视觉——是调试可视化不是图层。主视图要 PS 化：少即是多，边界/标注只在 hover/选中时出现，用交互解决问题。

## What Changes

- **渲染语义层（核心）**：新增抠图层合成管线——每图层 `原图 bbox 区域 destination-in mask` → 带 alpha 的图层位图（内容寻址缓存）；主画布=背景层（原图可隐藏）+ 图层抠图叠加（树序=绘制序=z 序）+ 钻子层（随图层显隐传递）。
- **主视图 PS 化**：移除常驻 bbox 条框/标签/组徽标；hover=图层边界+微亮；选中=边界+名称+右栏联动；无焦点=纯净画面（图+钻）。
- **treeView 对齐**：图层行缩略图=抠图层缩略渲染（替换同色色块）；钻布局显示为图层的虚拟子行（规格+颗数——assignments 真源派生，不进引擎树）。
- **容器查询工作台**：TaskWorkbenchView 外层容器查询；agent 任务详情（TaskDetailPanel）直接挂工作台紧凑形态（窄容器=迷你画布+图层列表+关键操作；全屏=完整三栏）；移动 sheet 同构。
- **纹理优先缺省**：demo 映射回归（高帽/绒球/鼻/手→texture-fill；条纹上衣保留 straight-line）；Inspector 策略推荐与引导按决策树表达（通用→texture-fill；硬朗+纯色→规整族）。

## Impact

- rhinestone-studio：taskWorkbench 渲染管线重构+StrategyCanvas 图层化渲染+treeView+AgentView 详情紧凑形态；maskBits 旁新增抠图层 LRU。
- contracts：无破坏性变更（视图模型层派生；ObjectNode.mask/bbox/children 契约已足）。
- daemon：不动（策略缺省属前端推荐与 demo 脚本；引擎五策略不变——纹理=texture-fill 既有）。
- 不动：引擎红线/三通道/undo 分域/版本链。
