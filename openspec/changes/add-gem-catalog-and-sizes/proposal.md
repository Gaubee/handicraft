# 尺寸与钻形目录 + v2 契约（add-gem-catalog-and-sizes）

## Why

- Owner 定性（2026-09-19 原话）：三页「不论哪个页面…都没有考虑过尺寸的问题。没有尺寸，那么生成的图就会有问题」。源码事实：全引擎只有像素轨——`Gem` 无形状/尺寸字段（`src/lib/engine/types.ts:68-75`，`EditGem` 同 `types.ts:79-91`），校验/冲突/导出全部按单一 `pitch` 工作（`engine/validate.ts:17-40`、`engine/edit.ts:53-76`、`engine/conflict.ts:27-45`、`engine/export.ts:36`），px↔mm 换算系数 `PIXELS_PER_MM=2.5` 在三处重复硬编码（`stores/studio.svelte.ts:56`、`edit/gemprojReplay.ts:41`、`edit/quickLayout.ts:65`）。
- 全库无任何 `shapeId`/`diameterMm`/`specKey`/`specId` 符号（rg 实测 2026-09-18 零命中）——「选择钻形与尺寸 + 自定义钻形」当前不可表达。
- Codex 两轮评审（专家稿 R1 5.6/10 → 修订 v1.1；合流 R2 终审）定案：**v2 契约 gate（canonical 类型唯一化 + 迁移 fixture）是第一个实现单元**，终局 `CONDITIONAL GO / W0-GATE-ONLY`（`.agents/documents/2026-09-19-studio-layers/codex-review-r2.md` §六）；且任何 add-project-files 2.x serializer 开工前必须先过该 gate（R2 §四 P0-4），否则 2.x 按 v1 写入 = 确定性返工。
- 四格式 parser 现状全部 v1 且迁移表为空（`persistence/projectFile.ts:51-56,113-128`、`persistence/labFile.ts:37-41,106-121`）——迁移注册基建在而迁移链未填，正是 gate 先行的窗口。

## What Changes

- **W0 v2 contract gate（第一实现单元，零业务实现）**：canonical 类型唯一化——`BaseSpec`、`GemSpecSnapshot{specKey,ordinal,shapeId,sizeLabel,diameterMm,widthMm?,heightMm?,assetId?,rotationDeg?}`、`PhysicalCanvas{widthMm,heightMm,anchorSource:'declared'|'default'}`；唯一 helper `requiredCenterDistancePx(a,b,grid)` 与 `maxCellPx`（单位恒 px）；删除 `specId` 持久化别名与二/三参并存。四格式（.gemproj/.gemdoc/.gemtpl/.gemgen）v2 版本表 + v1→v2 迁移入口 + round-trip fixture + 向前拒读 + 坏输入 typed error。`.gemshape` 新格式 parser 的 schema gate（六条：真实解码宽高 / MIME·字节·像素上限 / 非空 alpha bounds / fit·物理 bounds 语义 / reference 校准可解析 / missing 资产 typed 禁静默降级导出）。验收逐条照抄 R2 P0-1/P0-2 原文（见 design §1.7）。
- **engine gate（第二实现单元）**：mixed-size pairwise（圆包络 `dist ≥ (d_i+d_j)/2 + gap`，cell = `maxDiameter+gap` px）；`validate`/`validateEditable`/`resolveConflicts`/`exportGate` 混合径化（保存允许 warning、导出硬阻断）；BOM 聚合键 `specKey × colorId`；SVG 逐钻规格渲染（圆钻 circle 快路径 / 异形 path / 自定义 `<image>`）；CPU deterministic oracle；性能 P0 = CPU CVT 优化 43s→<10s 零输出变化（依据 `gpu-research.md` §7）。**GPU 不进 P0**：WebGPU 预览为 P1 试点（capability-labeled + CPU fallback，落盘/导出/重放恒 CPU 精算）。
- **目录与自定义钻形资产化**：内置形（圆/方/水滴/心/马眼，P0）= engine 常量（`engine/shapes.ts`，不入库不序列化，随 ENGINE_VERSION 语义演进）；自定义钻形 = `.gemshape` 第五种 ProjectKind 资产（sys-shapes 系统目录、RightSheet 编辑、导入路由、引用 pin/GC、删除后 missing typed 状态）；`PIXELS_PER_MM` 三处副本收编 engine 单一出口；SS24 补档（不阻塞 gate，随 ENGINE_VERSION 纪律说明）。
- **不做（显式边界）**：图层化（studio-layers）、专家工作台 UI（rename-and-expert-workbench）、蓝图双任务（lab-dual-mode）、replay/handoff/export 层化消费（studio-layers 的 replay/handoff gate 段）。

## Impact

- 新建：`engine/shapes.ts`（内置形常量）、`.gemshape` 序列化/parser（projectFile/labFile 同族纪律）
- 扩展：`engine/types.ts`（Gem/EditGem/GridSpec v2 + zod）、`engine/grid.ts`（gridFromSpec/gemRadiusPx 逐钻化）、`engine/validate.ts`/`edit.ts`/`conflict.ts`/`export.ts`（混合径化）、`persistence/projectFile.ts`/`labFile.ts`（v2 版本表+迁移链填充）、`persistence/projectTypes.ts`（ProjectKind/MIME 五值）、assetStore（sys-shapes 目录 + gemshape 资产）、App 全局导入路由（第五格式）
- 引擎：`ENGINE_VERSION` 预期 1→2（validate/conflict/export 语义变更，横幅诚实性前提；`engine/version.ts:16` 现值 1）
- 依赖关系：W0 是 add-project-files 2.x serializer 与 studio-layers engine 消费面的**共同硬前置**（R2 P0-4）；本 change 消费 add-project-files 已冻结的迁移注册骨架（projectFile.ts:113-128 / labFile.ts:106-121）与 AssetProject 契约（projectTypes.ts）；`.gemshape` 资产化切片依赖 AssetProject 实现（add-project-files 1.1）可用，未落地则该切片顺延（不阻塞 W0/engine gate）
