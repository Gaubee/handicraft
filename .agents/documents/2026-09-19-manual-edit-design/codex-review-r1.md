# Codex 设计评审 · 第一轮（gpt-5.6-terra xhigh，2026-09-19，11m26s）

> 评审对象：manual-edit-design.md（PM 研究稿）+ openspec change add-manual-edit-mode 草稿 + 引擎源码。
> 综合评分：5.5/10 NEEDS-WORK。以下为 Codex 原文（从 pane 提取，命令噪音已去除）。

# 设计评审结论

裁决：NEEDS-WORK，5.5/10。

产品定位和“参数化生成 → 手工精修”的方向成立，但当前草稿还不能直接进入实现：handoff' 数据契约、手工钻位的归属语义、冲突修复的破坏性行为、导出校验边界，以及任务顺序都未闭合。

## 五个议题

### 1. 入口形态：第三 Tab + handoff'

结论：有条件同意。

第三 Tab 符合现有应用结构，但当前实现只有 'lab' | 'studio' 两个视图状态（rhinestone-studio/src/lib/stores/view.svelte.ts:7-17），现有 handoff 只传图片、文件名和参考图（rhinestone-studio/src/lib/stores/
handoff.svelte.ts:13-30），不能承载 LayoutResult、blocks、palette、grid、图像尺寸和来源参数。

替代方案：

- 新建显式 EditDocument/ManualEditHandoff 类型，不复用仅传图片的 handoff。
- 交接内容必须包含 gems、blocks、palette、grid、width、height、来源策略和参数摘要。
- 编辑文档进入后独立持有快照；第三 Tab 只是入口，不应成为第二个隐式状态源。
- 在实现前先验证：工作台切换参数、再次送精修、离开再返回、刷新或无 handoff 进入时的生命周期。

PM 方案的“第三 Tab”可以保留，但“复用现有 handoff 模式”不足以实现设计稿 §3.1 的快照语义。

### 2. 图层粒度：固定四层 + 颜色过滤

结论：同意。

固定的 reference / painting / blocks / gems 四层比自由图层树更符合当前扁平 Gem[] 引擎和导出模型。现有导出按颜色分组，而不是按物理图层导出（rhinestone-studio/src/lib/engine/export.ts:56-84）；引擎类型也
没有多层钻面概念（rhinestone-studio/src/lib/engine/types.ts:68-75）。

但必须补两点：

1. painting 和 reference 在设计稿中写成“引用共享”，这与“进入编辑后完全隔离”相矛盾。应明确它们是不可变资源快照，还是共享可变对象。
2. “颜色过滤”必须明确只是渲染/编辑过滤，不得改变 Gem[] 的归属、导出或 BOM 语义。

多 SS 混排可以延后，不应在 P0 引入物理多层。

### 3. 钻位对象 vs 栅格

结论：同意对象模型，但反对当前 blockId 语义。

Gem[] 能直接支持单颗编辑、BOM 和现有导出/校验，比栅格路线合理。当前引擎的 Gem 必须有 id/x/y/colorId/blockId（types.ts:68-75），但设计稿同时要求：

- blockId 仅作为来源参考；
- 手工移动、自由放置；
- 继续调用 validate(gems, grid, blocks)。

这三者不一致。validate 会把钻心移出所属块掩码视为 mask 违规（validate.ts:86-107），而 isExportable 会因此阻断导出（validate.ts:112-115）。自由新增钻位还没有合法的 blockId 来源。

替代方案：

- 将 blockId 明确为“来源块”，不再代表当前几何必须位于该块。
- 引入 regionId/可选编辑区域，或为手工新增钻使用 blockId: null。
- 校验拆成“物理间距校验”和“生成区域归属校验”；只有仍受区域约束的钻才做 mask 校验。
- 为手工新增钻建立独立、单调递增且不与 layout 重编号冲突的 ID 策略。现有 layout 会把输出 ID 重新编号（layout/index.ts:64-71），不能直接沿用作编辑器 ID。

### 4. 引擎三出口

结论：反对按现稿一次性冻结三出口；同意纯函数进入引擎的方向。

现有引擎公共面确实适合承载纯函数（engine/index.ts:40-44），但三个 API 的契约尚未达到可实现程度：

- layoutAlongPath 的 Pt 未在公共类型中定义；返回 Gem[] 却没有 blockId、ID、边界和冲突策略的完整语义。
- resolveConflicts(gems, grid) 直接暴露内部 enforceMinDistanceCounted（layout/common.ts:136-179），本质是按输入顺序丢钻，不是“修复”。对用户手工成果默认删除是破坏性操作，且没有保留/移动策略。
- blockFromMask(mask, attrs) 的 Block 必填字段很多：label、bbox、areaPx、widthPx、suggested 等（types.ts:53-65），“attrs”不足以冻结契约。

替代顺序：

1. P0 只抽出并测试一个明确的 resolveConflicts，要求返回被删除对象、原因和确定性保留策略。
2. blockFromMask 在 P1 套索/魔棒确定需要后再进入公共面。
3. layoutAlongPath 延后到路径工具实现前，先冻结 Pt、颜色、来源区域、越界和既有钻冲突语义。
4. 所有新出口必须从 engine/index.ts 导出，并与现有 layout 共享同一校验/冲突实现。

当前 tasks.md 把三出口放在工具实现之后（tasks.md:19-28），其中 3.4 已依赖尚不存在的 resolveConflicts，顺序错误。

### 5. 导出门

结论：同意 spacing 硬门；反对“一键修复 = 默认丢钻”的隐含语义。

现有 isExportable 已明确阻断 spacing 和 mask，允许 island 警告继续导出（validate.ts:112-115）。因此 P0 继续阻断 spacing 是一致的，也不建议首发加入“强制导出”逃生舱。

但必须先解决：

- 手工新增/移动钻的 mask 语义；
- 一键修复是移动、删除还是按优先级保留；
- 修复后被删除的钻如何进入 undo patch；
- island 是否只是提示，还是也需要在导出前要求确认。

另外，设计稿调用 exportSvg/exportBom，但现有 API 需要 LayoutResult、GridSpec，SVG 还需要 width/height/palette（export.ts:13-23, 105-114）。EditDoc 当前没有明确保存图像尺寸，不能直接完成导出。

## 阻塞问题

1. 快照契约未闭合
工作台的 activeResult 和导出状态都只存在 studio.svelte.ts 内部（studio.svelte.ts:192-214, 745-762）；现有 handoff 不传钻位。第三 Tab 设计还缺真实的数据交接和返回策略。

2. 烘焙后的色板编辑语义缺失
删除色板颜色后，现有 SVG 会回退到块色或灰色（export.ts:66-74），BOM 会使用“未映射”回退（export.ts:96-99）。必须定义：删除颜色是禁止、批量改色、保留孤儿颜色，还是允许降级导出。

3. 选块填充会误删手工成果
设计稿规定“删除该块旧钻，再加入新钻”（manual-edit-design.md §4.2）。如果用户已移动、补画或改色但仍保留同一 blockId，局部重排会把这些手工钻一并删除。必须建立“来源钻”和“手工钻”的区分，或让局部重排只替
换明确选中的生成集合。

4. 撤销栈规格不可验收
“100 步或 50MB”没有定义内存计算、超限裁剪、redo 清空、失败回滚、跨操作事务和超大 stroke 的行为。笔刷一次可能产生数百/数千个 Gem，必须先定义预算和 patch 压缩方式。

5. LOD/性能没有可验证实现路径
当前 paintGems 每次渲染遍历全部钻位（components/Studio/gemPaint.ts:20-38），现有对比画布也会在状态变化时全量重绘（CompareGrid.svelte:142-160）。仅写“1 万钻 60fps、LOD 两档”不足以证明可行，需要先做
1k/10k/20k 基准和脏区/分块渲染方案。

6. 冲突修复无法保证导出可用
resolveConflicts 只能处理间距；它不能修复 mask 违规、孤岛语义或无效 blockId。因此“修复后 isExportable=true”（tasks.md:23-24）不是当前 API 能保证的性质。

## 实现顺序修订

现有 tracer bullet“快照 → 画钻 → 导出”方向正确，但 P0 夹带了局部策略重排、冲突修复和三出口，范围过大，且任务依赖顺序错误。

建议调整为：

1. 先冻结契约与不变量
EditDocument、handoff payload、ID 策略、颜色删除语义、手工钻区域语义、两类 validate、导出所需尺寸。

2. 先做引擎最小闭环
实现并测试可逆的 add/remove/update、空间索引、spacing 校验和明确的冲突报告；暂不做 layoutAlongPath。

3. 实现第三 Tab + 快照载入
覆盖送精修、空态、离开确认、再次覆盖、工作台参数变化不回流。

4. 实现只读画布和性能基线
先验证 1 万钻渲染、缩放、平移和选中命中，再接笔刷。

5. 实现画钻、擦除、单选、改色、撤销/重做
这是第一个真正可验收的 tracer bullet：
快照 → 单颗/笔刷编辑 → undo/redo → validate → SVG/BOM。

6. 再实现选块策略填充
先冻结“替换哪些钻”和块外既有钻的冲突处理，不要直接按 blockId 全量删除。

7. 最后接导出门和一键修复
一键修复必须是显式、可撤销、可解释的操作。

8. P1 再加入 blockFromMask、layoutAlongPath、套索/魔棒和密度笔刷。

## 评分

5.5/10，NEEDS-WORK。

- 产品定位与竞品抽象：较强；
- 固定层和对象模型方向：合理；
- 现有引擎契合度：部分成立；
- 数据交接、编辑归属、冲突修复、色板语义：未闭合；
- P0 范围和任务依赖：过宽且顺序错误。

当前不建议直接按 tasks.md 开工，应先修订数据契约、校验模型和局部重排语义。未运行测试；本结论基于当前源码和设计文档静态核对。




