# 设计师工作台全面重写（redesign-designer-workbench）

> 状态：**ACTIVE（升格实现 change，2026-09-21）**——Owner 已确认七问裁决并给定调（见 Why），封存稿升格为完整实现 change。原封存稿（2026-09-20）的背景与偏差溯源全文见 git 历史，本稿保留摘要。

## Why

### Owner 定调（2026-09-21 原话，最高优先）

> 「总体来说，设计师工作台 已经从『基于图层+算法的排钻』，到了『能对每一颗钻进行微调』的工作。所以鼠标、快捷键，都要全部重新适配设计。整体的界面要和PS更加接近。比如工具栏，应该竖排。还有，你的建议我基本采纳，你按照我的思路来撰写change。」

定位重述：设计师工作台不再是「算法结果的查看器」，而是**逐钻微调的设计台**——每一颗钻是一等公民：单选、框选、拖移、旋转、改径、改色、改形，全部以画布直接操纵 + PS 惯例快捷键完成；算法（排布）降位为显式调用的工具。界面整体贴近 Photoshop：**竖排工具栏**、画布居中、右侧面板列、顶部文档栏、底部状态栏。

### 偏差溯源（摘要）

add-project-files 3.3 曾将「基于图片直接创建项目文件」解读为「选图即自动快速排稿」并经 Codex GO，但该默认行为从未经 Owner 确认；「空白画布」被降级 P1——方向反了。本 change 以裁决 2（空白起步）纠正此偏差。教训入档：**默认行为变更必须回 Owner 确认**。

### 命名沿革

手动编辑 → 专家工作台（rename-and-expert-workbench，已落地）→ **设计师工作台**（Owner 2026-09-20 定名，本 change R0 切片落码与升版术语表）。

## What Changes

### 七项裁决（Owner 确认采纳，2026-09-21）

1. **图层模型 = A 完整版**：参考底层（原图描摹，透明度可调可关）+ 任意多钻石层（建层/命名/显隐/锁定/排序/**合并**/成组移动）。合并 = 两层钻并入目标层，规格混合自然共存（层不持有规格属性，规格逐钻持有）。**无范围（mask）概念、不支持自动填充**（Owner 前次定调保留——区别于排钻工作台的区块语义）。
2. **空白起步**：新建/选图 = 画布只有参考底图，绝不自动生成钻。「智能排布」（原快速排稿）为显式工具按钮——点击弹参数小窗、结果落当前图层。
3. **旧 .gemdoc 兼容**：已有文档（含自动排稿产物）可打开继续编辑（迁移：旧固定四层 → 参考底层 + 图层 1）。
4. **旋转/缩放交互**：选中钻出现**变换手柄**（拖拽旋转 + 拖拽改直径）+ 属性面板数字输入 + 快捷键步进，三通道并存。
5. **快捷键 = PS 惯例**：V 选择 / B 画笔 / E 橡皮 / H 抓手 / Z 缩放 / ⌘Z ⌘⇧Z 撤销重做 / Delete 删除 / 方向键微移 / Shift 约束 / Alt 拖拽复制等（完整键位表见 design §3）。
6. **画幅**：新建默认锚定参考图尺寸（缺省锚 pixelsPerMm=2.5），状态栏可改（不强制弹窗）。
7. **重写策略 = 交互层全新重写 + 契约层复用**：视图/画布/交互态全新落码（旧组件不复用；纯函数契约与测试地基可迁移）；复用 engine 几何/校验/导出门、.gemshape 目录与校准、documentService、持久化/素材库/送精修 handoff v2、1500+ 测试地基（符号级边界见 design §7；R1 评审后 persistence/services 各有一处例外开窗，见 Impact）。

### 本次新增重点（Owner 2026-09-21 明示）

- **鼠标交互全面重设计**：单选/框选/拖移/变换手柄/滚轮缩放/空格或中键平移/双击/右键上下文菜单——完整指针交互清单见 design §2。
- **快捷键全面适配**：工具切换/编辑/变换/撤销/删除/复制/对齐分布/图层操作分组键位表见 design §3。
- **界面贴近 PS**：**竖排工具栏**（左侧 icon 列：选择/画笔/橡皮/抓手/缩放，按产品裁剪）+ 画布居中 + 右侧面板列（属性 + 图层）+ 顶部文档栏 + 底部状态栏（画幅读数/缩放比/钻数/规格）。移动端降级方案（底部工具条 + 抽屉面板）见 design §1.4。

## Impact

- **重写（新目录；旧组件不复用，纯函数契约与测试地基可迁移）**：`src/lib/components/views/EditView.svelte` 与 `src/components/Edit/` 的交互层组件（EditCanvas/EditToolbar/EditLayersPanel/EditPropertiesPanel/EditStatusBar/workbench.svelte.ts 等，退役清单见 design §7.4）→ 新 `src/components/Designer/` + `src/lib/designer/`（命名建议见 design §7.1）。
- **演进扩展（同一 store 演化，保测试地基）**：`src/lib/stores/edit.svelte.ts` 文档模型——固定四层 LayerState → 参考底层（每源独立 {visible, opacity}）+ 多钻石层（含可选 opacity）+ DesignerGem（= engine EditGem + layerId，store/persistence 域扩展类型；gemdoc schema v2→v3 + 旧档迁移）；patch 三原子/undo 组/selection API 语义保留。
- **改造（API 扩展，内核不动）**：`src/lib/edit/quickLayout.ts`（快速排稿 → 智能排布工具的计算内核复用：产物模式从「整文档替换」改为「钻数组并入当前图层」）；`src/components/Edit/editKeyboard.ts` 键分派（重写为完整键位表，保留三档微移语义）。
- **冻结复用（零改动；R1 评审后两处例外开窗）**：`src/lib/engine/*`（edit.ts 边界函数/geometry/exportGate/layout——**零改动维持**）、`src/lib/edit/gemdocLifecycle.svelte.ts` / `documentStatus.svelte.ts` / `gemprojReplay.ts` / `renderPlan.ts` / `spatialIndex.ts`、校准向导（CalibrationWizard + calibration.ts）、送精修 handoff v2；**例外开窗一（R1-P0-1）**：`src/lib/persistence/projectFile.ts` 的 gemdoc v3 schema/v2→v3 迁移为本 change 切片 1.x 所有（唯一序列化出口地位不变；v2→v3 单向版本门；v2 输入不得原样回写），其余 persistence 零改动；**例外开窗二（R1-P0-2）**：`src/lib/services/documentService.ts` 新增 `projectVisibleGems(doc)` 可见层投影，作为 SVG/BOM/PNG/preflight 的唯一钻集来源（隐藏层不导出的 owner；engine exportGate 零改动），其余 service 编排零改动。
- **触发改名切片（R0，先行）**：专家工作台 → 设计师工作台（桌面 Tab/移动短名「设计」/toast/引导/测试断言全库 grep）；TERMS v4→**v5**（TERMS 已被先行占位 change 升至 v4，本 R0 为追加词条升 v5）+ PRODUCT_MODEL v5→v6 升版：词条改名、「快速排稿→智能排布」术语更名、**硬规则 6（编辑器不暴露排钻参数）与硬规则 9（隐藏层仍导出）的分模块口径修订登记**（分歧点见 design §4.4/§5.3）。
- **显式不做**：mask/自动填充（无范围概念）；多选包围盒缩放（P2 登记）；画布取色吸管（P2 登记——规格与颜色走规格选择器/色板）；专家成果回流排钻管线（PRODUCT_MODEL 硬规则 3 不变）；排钻工作台的二级图层/继承开关（其 v3 债与本 change 无阻塞关系，见 design §9）。
