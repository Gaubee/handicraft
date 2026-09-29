# 提案：任务详情 PS 式轨道 Drawer 化——左右竖工具条+开合面板（Owner 指令 2026-09-29）

## Why

Owner：任务详情左右两栏应改成 Drawer 模式（backdrop-filter-blur），屏幕宽度不够时自动收起、用户可手动展开。类似 PS：左右两缘各一排竖装工具条，工具条上的功能按钮点击展开对应面板。左侧已有竖工具条（选择/平移/缩放/笔刷——WorkbenchCanvasStage 内），只需加「图层」开关按钮；右侧同理新增右工具条。

现状缺口：完整形态（≥32rem 容器）的左图层栏（w-64）与右属性栏是 flex 流内联固定栏——窄容器下挤压画布而非收起；无覆盖式 Drawer 形态；右缘无工具条；历史 dock 固定在底部。

## What Changes

1. **左右面板 Drawer 化**：WorkbenchLayerPanel（左）与 WorkbenchInspector（右）从内联栏改为画布区 overlay Drawer——absolute 定位、`bg-background/85 backdrop-blur-md`、滑出过渡、非模态（画布仍可交互）。
2. **左工具条扩展**：现有画布工具（选择/平移/缩放/笔刷）保持并提升为左 rail 常驻竖条（w-11），末尾加分隔线+「图层」开关按钮（开合左 Drawer）。
3. **新增右工具条**：右缘对称竖条——「属性」（开合 Inspector Drawer）、「历史」（开合历史 Drawer——WorkbenchHistoryDock 内容迁入，底部 dock 退役）、「快捷键帮助」。
4. **响应式开合语义**：容器 `@2xl`（42rem）为轨道断点——≥42rem 缺省双 Drawer 展开；<42rem 自动收起。用户点击工具条按钮手动开合（同档宽度内记忆）；宽度跌破断点强制收起并清记忆，升回断点恢复缺省展开。
5. **紧凑形态适配**（<32rem）：中段改为 画布+双 rail 结构；图层列表从固定 38% 高度区改为左 Drawer 内；选中层摘要+策略直改保留。

## Impact

- studio：TaskWorkbenchView 中段布局重构、新 WorkbenchRail（左右两实例）+Drawer 容器、WorkbenchCanvasStage 工具条外提、WorkbenchHistoryDock 迁移。不动：store/commands 命令总线语义、presence/快捷键、WorkbenchLayerPanel/WorkbenchInspector/WorkbenchHistoryDock 组件内部、engine/契约。
