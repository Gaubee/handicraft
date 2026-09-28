# 提案：工作台表现层——羽化/缩略双模式/grid 控件（Owner 第六轮反馈 3/4/5）

## Why
Owner：①抠图效果不理想（羽化被 2a 轮 P1 延期+半像素错位——方案未篡改，是延期代价到账）；②缩略图 trim 不完全支持——要 PS 式空间位置/trim 双模式（平衡 parent-child 空间关系展示与小图层可读性），开关放 treeView-headerBar 替换无产品价值的「蒙版」开关；③「孔洞/编号/成钻」与「背景透明度」浮动控件改单容器 grid 编排——响应式窄空间自然上下 stack（现在重叠）。

## What Changes（Codex 意图报告 D/E 裁定）
1. **羽化（纯前端渲染层软化）**：二值 mask 派生边界距离场→3-5 源图像素单调 alpha（外 0/内 255/边界带渐变）；主画布与 LayerCutoutThumb 共用同一软化结果；先定位图像/mask/CanvasView 实际偏移再修半像素（不机械位移）；二值 mask/engine/BOM/导出契约不动。
2. **缩略双模式**：headerBar「蒙版」checkbox 替换为 trim/ps segmented——trim=内容 bbox contain（现状）；ps=整画布坐标放回（保留空间关系）。组行 trim=子层并集/ps=整画布合成；模式为观察态（view-state 域非树结构域）。showMasks 退役为 dev-only 诊断。
3. **grid overlay**：画布 overlay 单定位根+CSS grid/container query——宽空间两行控件并排/窄空间上下 stack；minmax(0,1fr)；控件互不遮挡不遮画布。

## Impact
- studio：cutout 软化+双模式缩略+WorkbenchCanvasStage overlay 重构。不动：engine/契约/v5 叶子产钻语义。
