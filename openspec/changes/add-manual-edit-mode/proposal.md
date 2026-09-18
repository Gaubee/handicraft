<!--
Orthogonal intents (max 5):
1. [2026-09-19 Owner] 新增第三模块「手动编辑」：面向贴钻艺术家的笔刷/选区/算法工具精修层。
2. [2026-09-19 Owner] 业内软件参考优先（Silhouette/Hotfix Era/十字绣编辑器），PS 图层范式兜底。
3. [2026-09-19 Process] PM 研究 × Codex 讨论定稿；敏捷工作流在当前目录迭代。
4. [2026-09-19 Scope] 精修/再创作层为主（对 AI 中间稿与工作台排钻结果的手工精修），从零创作与 Multi-Dec 推迟。
-->

## Why

现有两段式管线（实验室生成中间稿 → 工作台参数化排钻）的末端缺口：AI 生成不可能一次满意，工作台参数是全局粗调——二者之间缺少"艺术家亲手改"的精修层。业内调研（design 文档 §1）证实：数字油画生成器市场"生成强、编辑弱"，贴钻专业软件（Silhouette Rhinestone 面板等）有编辑能力但只吃矢量路径、不吃照片中间稿。**深度精修正是本产品差异化位**。

## What Changes

- 新增第三 Tab「手动编辑」：入口为工作台「送精修」，显式 ManualEditHandoff 交接（gems/blocks/palette/grid/宽高/底图快照——不复用图片 handoff）
- **烘焙原则**：进入编辑即深拷贝快照，编辑文档内 `Gem[]`（含 origin: layout|manual 区分）成为唯一真源，工作台参数改动不回流（对标 Silhouette Release Rhinestones 的单向释放）
- 固定语义四层（参考/中间稿/分块只读/钻面）+ 显隐透明度；不做 PS 自由图层树；颜色过滤仅渲染语义
- P0 工具箱：画钻笔刷（六方 snap+连线）/ 擦除 / 单选改色 / **选块策略填充**（只替换来源钻、保手工钻）/ patch 撤销栈（stroke 组+预算）/ 冲突高亮 + **显式可撤销的一键修复** / SVG/BOM 导出（spacing 硬门）
- 引擎出口按需渐进：P0 仅 `resolveConflicts`（带 removed 明细报告）；`blockFromMask`/`layoutAlongPath` 延至 P1 契局冻结时
- P1：套索/魔棒任意选区（走同管线）、沿路径排钻、颜色分组过滤视图；P2：从零创作、Multi-Dec 多 SS 混排、对称/模板库

### Non-goals

- 不做自由图层树与多 SS 混排（P2 实证再议）
- 不做从零创作主线（P2）
- 不改动实验室/工作台既有行为（工作台仍是参数真源，编辑分块层只读）

## Capabilities

- `manual-edit` —— 手动编辑器：快照烘焙、四层视图、P0 工具箱、撤销栈、冲突修复与导出
