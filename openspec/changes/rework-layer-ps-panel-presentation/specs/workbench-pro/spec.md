## ADDED Requirements

### Requirement: 抠图边缘软化（第六轮反馈 3）
前端渲染 SHALL 对二值 mask 派生边界距离场软化（3-5 源图像素单调 alpha）——主画布/叶缩略/组缩略共用同一软化结果； SHALL 修正图像/mask/视口半像素错位。二值 mask/engine/BOM/导出契约 SHALL 不变。

#### Scenario: 边缘质量
- **when** 3px/5px 两档 fixture → 边缘连续渐变无硬阶梯无 halo；几何/钻数/导出零变化

### Requirement: 缩略双模式（第六轮反馈 4）
treeView-headerBar SHALL 提供 trim/ps 双模式开关（替换「蒙版」产品开关——退役为 dev-only）：trim=内容 contain；ps=整画布坐标放回保留空间关系。模式 SHALL 属 view-state 观察态。

#### Scenario: 双模式
- **when** 切换模式 → 同一 32×32 格可区分两形态；小层 trim 可读/ps 位置正确；节点 id/fx/钻数据不变

### Requirement: 画布观察控件 grid 编排（第六轮反馈 5）
预览模式与背景透明度控件 SHALL 同一 grid 容器编排（禁各自 absolute）——窄容器自然上下 stack，互不重叠不遮画布。

#### Scenario: 响应式
- **when** 宽/中/窄三宽度 → 控件不重叠不溢出；点击/拖动事件命中正确
