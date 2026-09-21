# Proposal: add-designer-selection-paths — 设计师工作台选区与路径（预留，未立项实施）

> **状态：预留占位**——Owner 2026-09-21 裁决：「智能排布这个功能，应该基于选区来实现……首先你要支持选区功能……这个功能意味着和"路径"功能有关系，你得先引入路径功能，因为路径功能意味着要能编辑路径。所以我真不建议你在这个版本加入这个功能，你可以预留一个 change，后续再做。」

## Why

智能排布的正确形态是基于**选区**（在哪个区域排、排什么），而选区在本产品里本质是**路径**（可编辑的矢量轮廓）。跳过路径/选区直接做全图智能排布（已按 Owner 裁决在 rework-designer-manual-rhinestone 中退役）是本末倒置。

## What Changes（未来实施时展开）

1. 路径功能：钢笔式路径绘制与编辑（锚点/手柄/增删改，PS 交互惯例）
2. 选区：路径 → 选区（闭合路径围域），选区的加减交并（修饰键族）
3. 基于选区的智能排布：在选区内以选定规格落子（复用已冻结的 `smartLayoutGemsFromImage` 钻数组内核改造为选区输入），落当前层、避碰、结果报数
4. 选区与图层/笔刷的协作（选区内落子约束等）

## Impact（未来）

- `lib/designer/` 新增 paths/selections 模块族；DesignerCanvas 路径编辑态；工具栏新工具（钢笔 P）
- `rework-designer-manual-rhinestone` 退役的智能排布入口按本 change 能力重新引入

（本 change 仅占位；specs delta 在正式立项时补齐。）
