# 提案：PS 图层面板完整复刻+父层产钻语义修复（v5——Owner 第五轮验收反馈）

## Why

Owner 真机验收（v4 数据）反馈：
1. **概念模型定调（权威）**：图层=PS 图层；**钻=图层的特效修饰**（如 PS 的 fx）——钻不是树的独立节点。左侧 TreeView 应**完全复刻 Photoshop 的图层控制**。
2. **严重 bug——排钻嵌套**：图层嵌套时排钻也嵌套。数据面实锤：父层「小丑」159 颗与子层「小丑·部分1」150 颗坐标基本完全重叠（155/159 落在子层钻 20px 内）——两套钻叠排。根因=producesBlockOf 判定「叶子 || drillWorthy」允许中间节点产钻（design.ts:352）。Owner 裁定：**图层拆成子图层后只有子图层能套钻，父级不能**。
3. **图层缩略图大面积白**：图层应有对应视图（抠图内容）——绝大多数行显示白图（根因待 vision 判读定案后并入本 change）。

## What Changes

- **语义**：producesBlockOf 恒=叶子（中间节点不论 drillWorthy 不产钻不产块）。daemon 侧（design.ts+tree-to-blocks 同构面）同步；已有父层指派数据的迁移（execute 跳过+读面降级标注）。
- **PS 图层面板复刻（左栏重写）**：
  - 排序=**顶部最上层**（PS 方向；当前树序父先子后=底部在上，反转）
  - 行=眼睛/缩略图（真实抠图内容）/名称/（选中高亮蓝）；组行（有 children）带展开三角
  - **钻=fx 徽标**：有钻布局的叶子行显示效果图标（行内，不占树行）；点徽标=右栏钻详情
  - 双击名称重命名；底部操作条（PS 式：拆分/删除/新建组）
  - 父层（组）无策略指派入口（Inspector/紧凑态同步——组不套钻）
- **缩略图白图修复**（根因待定案：可能是抠图合成的真数据兼容问题/mask 极浅层/渲染 bug）。
- **demo/种子映射**：父层不指派（小丑→不产钻；producing 断言同步）。

## Impact
- daemon：design.ts producesBlockOf+execute 校验面（父层指派 typed 拒）+demo 脚本。
- studio：WorkbenchLayerPanel 重写（PS 式）+LayerItem fx 徽标+缩略图修复+Inspector 组无指派门。
- 不动：engine/ 红线（树转块同构在 daemon 侧）；canvaskit/undo 四域/契约（除必要的校验面）。
