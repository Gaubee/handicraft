# Design: add-workbench-pro（v2——吸收 Codex 预评审 4.2/10 的三缺口重写）

评审来源：Codex 大地三（2026-09-26，herdr w77）；证据锚点均带文件行号（评审原文）。本轮 design 逐项闭合：契约与数据模型（0.4/3）→补齐 §1；交互与性能验收（0.8/2）→补齐 §4；可靠性与测试门禁（0.6/2）→补齐 §5。另吸收走查实证 bug：真识别预览产物空（1888 颗未渲染——唯一色 4）。

## §0 复用红线（评审技术风险[6]）

**不另写第二套 viewport/keymap/touch**：复用/抽取 rhinestone-studio 现有 `designer/viewport.svelte.ts`、`designer/keymap.ts`（V=选择/H=平移/Z=缩放——已冻结，波 2 快捷键表以此为真源对齐，proposal 里「V=平移」作废）、`designer/touchGestures.ts`。工作台画布交互=designer 同款基建的参数化复用。

## §1 契约与数据模型（P0 前置——先冻结后实现）

### RPC 新面（daemon 最小集）

- `layer.reorder {taskId, nodeId, newParentId, index}`——树重排（父变更+序位；环路必拒；assignments/gems 跟随产块节点集收敛——同 setStrategy 既有语义）
- `layer.delete {taskId, nodeId}`——删子树（评审：删除子树及 assignments/gems 处置——assignments 收敛重算+版本入史）
- `layer.mask.patch {taskId, nodeId, ops: brushStroke[]}`——最小遮罩编辑（P0 含编辑后重算闭环——评审：无编辑不能称 PS 级）：笔刷增/删（include/exclude 半径+坐标序列）→ 服务端 mask 重写+effectiveMm/tightBBox 重算+版本入史+可选重算指派
- `tree.revert` 前端客户端补齐（评审：后端有前端无——Ctrl+Z 域见 §2）

### 数据模型

- 图层视图态（显隐/折叠/锁定）**服务端持久化**（评审：hiddenNodes 本地态重载丢失——store.svelte.ts:167-175）——task 级 view-state 小工件（JSON blob，操作历史入版本）
- **undo 域分层**（评审：mask 编辑/重排/服务端树回退会混成多 undo 域）：undo 栈按操作域分（tree-structure/tree-view/mask-edit/strategy-param），每域独立游标；Ctrl+Z=当前域回退+跨域提示；tree.revert 只服务 tree-structure 域
- 4096 run 上限：mask 行程编码超限时**返回 incomplete+显式 UI 告警**（评审：静默截断=所见非所得）
- ppm 不可推导（回退 2）：状态栏显示「ppm 未知」而非假读数

## §2 交互规格（P0 范围冻结——评审优先级表）

| 域 | P0（本波必做） | P1（次波） |
|---|---|---|
| 遮罩 | inline/blob 双态可见+选中层高亮+轮廓/完整性标识+**笔刷最小编辑+编辑后重算闭环** | 羽化/反选/套索/布尔 |
| 图层 | 显隐/锁定/折叠/重排/删除+事务历史+并发版本冻结 | 建/复制/合并/分组/孤立/opacity/blend/父层显隐传递 |
| 键盘 | 命令总线+双平台 Cmd/Ctrl undo/redo+Delete/F2/Esc+IME/输入框焦点保护 | 完整 PS 键表+? 帮助面板+undo group 合并 |
| 鼠标 | 滚轮锚定缩放/空格+中键平移/fit/100%/层命中+hover | 框选加减/右键菜单/触摸笔 |
| 状态栏 | px↔mm 坐标/ppm/zoom/选中层/dirty/降级告警 | 层尺寸统计/可定制指标 |
| 可靠性 | SAM 拆层进度+取消+幂等重试+401 自愈后状态恢复 | 丢响应补偿 |

- 快捷键真源=designer/keymap.ts（V 选择/H 平移/Z 缩放）；命令面板/菜单/按钮同源（命令总线单点定义）
- a11y：图层树 role=tree/treeitem+roving focus+键盘重排+44px 命中区+缩略图非颜色替代（评审盲点表）

## §3 渲染与性能（评审技术风险[1-3]闭合）

- **投影缓存**：gems/boxes/masks 投影从 $derived 链抽纯函数+memo（输入=树+指派+视图态；变更域级失效——评审：每次状态变化全重建 store.svelte.ts:237-285）
- mask 解码缓存（LRU by blobRef+revision）；blob mask 异步读不阻塞首帧（骨架位）
- 单层坏 mask：maskOverlayOf try/catch 降级为该层错误徽标（评审：炸整画布不可接受）
- SVG 节点数预算：点阵>10k 时切 canvas 混合渲染（位图打点+SVG 框线）——阈值实测定

## §4 性能门（两档冻结——评审建议执行顺序[4]）

- P95 帧时延门：10k gems 初渲/平移/缩放各 <100ms；100k gems <250ms（M1 MacBook 本机）
- 1K²/4K² mask 解码+叠加 <50ms/层
- 内存：100k gems 会话 RSS 增量 <500MB
- 超门=回炉（不降门）——测试脚本入库 scripts/perf-gate.ts

## §5 测试矩阵（评审测试行闭合）

blob/inline 坏 mask 容错/1K²/4K² mask/万级十万级 gems/命中坐标精确/并发操作冲突（双面板同任务）/断网重试/401 自愈恢复/a11y 树遍历/触控基础——jsdom 单测+perf 脚本+真浏览器走查三层。

## §6 波次重划（按依赖序）

- 波 2a：契约冻结（§1 RPC+数据模型）+designer 基建抽取（viewport/keymap 复用面）——先行可评审产物
- 波 2b：遮罩可视化+最小编辑+重算闭环（P0 表遮罩行）+预览产物空 bug 修复（真识别 1888 颗渲染）
- 波 2c：图层管理 P0+快捷键命令总线+鼠标 P0+状态栏+undo 域
- 波 2d：性能门+测试矩阵+全链走查（编辑 mask→重算→撤销→刷新→导出）

每波结束 Codex 复核轮（herdr 大地三）；连续两轮评分提升 <1 则升级日曜三 由 Codex 主导实现。
