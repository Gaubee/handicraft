# Design: add-workbench-pro（v2——吸收 Codex 预评审 4.2/10 的三缺口重写；波 2a 增补附录 D-2/D-3+§4 三层化）

评审来源：Codex 大地三（2026-09-26，herdr w77）；证据锚点均带文件行号（评审原文）。本轮 design 逐项闭合：契约与数据模型（0.4/3）→补齐 §1；交互与性能验收（0.8/2）→补齐 §4；可靠性与测试门禁（0.6/2）→补齐 §5。另吸收走查实证 bug：真识别预览产物空（1888 颗未渲染——唯一色 4）。
波 2a（2026-09-26，同日）：§1 契约层冻结落地（contracts workbench-pro 段=真源）；§4 改三层性能门+receipt 规范；新增附录 D-2（盲点裁定 12 条）与 D-3（undo 四域状态机+交错示例）——Codex 二轮 CONDITIONAL-GO 放行条件逐条对应。

## §0 复用红线（评审技术风险[6]）

**不另写第二套 viewport/keymap/touch**：复用/抽取 rhinestone-studio 现有 `designer/viewport.svelte.ts`、`designer/keymap.ts`（V=选择/H=平移/Z=缩放——已冻结，波 2 快捷键表以此为真源对齐，proposal 里「V=平移」作废）、`designer/touchGestures.ts`。工作台画布交互=designer 同款基建的参数化复用。

## §1 契约与数据模型（P0 前置——先冻结后实现）

### RPC 新面（daemon 最小集）

- `layer.reorder {taskId, nodeId, newParentId, index}`——树重排（父变更+序位；环路必拒；assignments/gems 跟随产块节点集收敛——同 setStrategy 既有语义）
- `layer.delete {taskId, nodeId}`——删子树（评审：删除子树及 assignments/gems 处置——assignments 收敛重算+版本入史）
- `layer.mask.patch {taskId, nodeId, ops: brushStroke[]}`——最小遮罩编辑（P0 含编辑后重算闭环——评审：无编辑不能称 PS 级）：笔刷增/删（include/exclude 半径+坐标序列）→ 服务端 mask 重写+effectiveMm/tightBBox 重算+版本入史+可选重算指派
- `tree.revert` 前端客户端补齐（评审：后端有前端无——Ctrl+Z 域见 §2）

### 数据模型

- 图层视图态（显隐/折叠/锁定）**服务端持久化**（评审：hiddenNodes 本地态重载丢失——store.svelte.ts:167-175）——task 级 view-state 小工件（JSON blob；版本化=**独立 revision 单调链**（D-2⑦ 精确化——不入 tree_versions）
- **undo 域分层**（评审：mask 编辑/重排/服务端树回退会混成多 undo 域）：undo 栈按操作域分（tree-structure/tree-view/mask-edit/strategy-param），每域独立游标；Ctrl+Z=当前域回退+跨域提示；tree.revert 只服务 tree-structure 域——四域状态机+交错示例冻结于**附录 D-3**
- 4096 run 上限：mask 行程编码超限时**返回 incomplete+显式 UI 告警**（评审：静默截断=所见非所得）——incomplete **禁止导出**（exportGate 阻断，D-2③）
- ppm 不可推导（回退 2）：状态栏显示「ppm 未知」而非假读数
- **波 2a 契约冻结已落地**（2026-09-26）：三写 RPC（layer.reorder/layer.delete/layer.mask.patch）+view.state.set+task.detail 扩面（viewState/maskEdits/exportGate）的 zod 契约真源=contracts `workbench.ts` workbench-pro 段（jsdoc 即语义规范）；daemon 端点骨架+v7 迁移（tree_versions cause 六值+mask_edit_states）+行为测试固化（CAS/锁定/状态机/门）同波交付——本节上文为意图描述，**与契约冲突处以契约为准**。

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

## §4 性能门（三层冻结——2d 脚本 scripts/perf-gate.ts 出 receipt；可执行验收条款）

场景基座：M1 MacBook 本机（Chrome 稳定版，硬件加速开）；素材三档 1k/10k/100k gems × mask 两档 1K²/4K²；**冷缓存**=全新浏览器 profile 首开，**热缓存**=同会话关闭工作台后二次载入（LRU 计入）。

- **第一层·首帧门**（task.detail 装配→画布首帧**稳定**——骨架位不算稳定，点阵+框线到位）：
  - 1k/10k gems：冷 <500ms / 热 <200ms；100k gems：冷 <1.5s / 热 <600ms
  - blob mask 异步读不阻塞首帧（§3 骨架位——渐进呈现，首帧门只算到位部分）
- **第二层·交互帧门**（稳定后连续交互 P95；平移/滚轮锚定缩放/图层树滚动/显隐切换各 ≥30 次采样）：
  - 10k gems 三交互 P95 <100ms；100k gems P95 <250ms
  - mask overlay 叠加（选中层蒙版高亮+半透明填充）：1K² 层 P95 <16ms（不掉帧）；4K² 层 P95 <50ms
- **第三层·后台解码门**（不阻塞第二层交互帧的前提下）：
  - 1K²/4K² mask 解码（LRU by blobRef+revision）<50ms/层；100 层批量解码全部就绪 <2s（骨架→就绪渐进）
  - 坏/缺 mask：单层错误徽标呈现 <16ms 且不炸整画布（§3 降级线——maskOverlayOf try/catch）
- **内存门**：100k gems 会话 **浏览器 tab 级 RSS** 增量 <500MB——测量口径=Chrome Task Manager 该 tab 行（非进程组）；`performance.memory` 仅作过程采样佐证；冷/热各测一次（热含 LRU 常驻）
- **receipt 规范**（2d 脚本产出，验收=按条款可复跑）：JSON receipt 逐条记录 场景×层×指标（P50/P95/max+样本数）+环境指纹（机型/浏览器版本/分辨率/加速态/冷热）+逐条 pass/fail；receipt 样例归档本 change 目录；**超门=回炉不降门**——门数值调整须 Owner 批准并记 design 变更

## §5 测试矩阵（评审测试行闭合）

blob/inline 坏 mask 容错/1K²/4K² mask/万级十万级 gems/命中坐标精确/并发操作冲突（双面板同任务）/断网重试/401 自愈恢复/a11y 树遍历/触控基础——jsdom 单测+perf 脚本+真浏览器走查三层。

## §6 波次重划（按依赖序）

- 波 2a：契约冻结（§1 RPC+数据模型——已落地：contracts workbench-pro 段+daemon 骨架+v7 迁移+行为测试）+基建复用面**标记**（§0 红线即标记——designer 实抽取挪 2c 并行冲突避让：W10 前端子代理正在 rhinestone-studio 工作）+文档同步（§4 三层门/D-2/D-3/proposal/tasks/spec delta）
- 波 2b：遮罩可视化+最小编辑+重算闭环（P0 表遮罩行）+预览产物空 bug 修复（真识别 1888 颗渲染）
- 波 2c：图层管理 P0+快捷键命令总线+鼠标 P0+状态栏+undo 域
- 波 2d：性能门+测试矩阵+全链走查（编辑 mask→重算→撤销→刷新→导出）

每波结束 Codex 复核轮（herdr 大地三）；连续两轮评分提升 <1 则升级日曜三 由 Codex 主导实现。

## 附录 D-2 盲点裁定（波 2a 冻结——Codex 二轮评审盲点表逐条裁定，Owner 已确认）

1. **羽化=P1 延期**：P0 mask 恒二值（0/1——引擎 Mask2D 同构不变量不动）；alpha/距离场羽化留**契约接口位注释**（contracts BrushStrokeSchema jsdoc「羽化 P1 接口位：featherPx 显式契约变更扩展」——不在 P0 二值面偷开通道）。
2. **blob mask 全链归波 2b**：拉取/缓存（LRU by blobRef+revision）/加载态/坏数据态/编辑回写=2b 首项实现；本波（2a）已冻结其契约字段（Mask2DRef blob 态既有+maskEditStatus/编辑回写经 layer.mask.patch 两态通吃——契约面无 2b 阻塞物）。
3. **4096 incomplete=禁止导出**：行程超限的 mask **如实持久化**（所见即所得——不静默截断），但 exportGate 必阻（blocker 'mask-incomplete'）+UI 显式告警，直到编辑收敛回限内。无客户端豁免口（门只增不减）。
4. **根/画布节点不可删**：layer.delete 对 parent===null typed 拒（'root-protected'——单根树结构锚）；同理不可 reorder。**父层显隐传递=P1**：子层继承视觉态（前端渲染聚合）但**不写子层 view-state**（服务端工件保持最小真源——继承是渲染语义不是数据语义）。
5. **多选/批量降 P1**（proposal 原文修正——proposal.md 已同步）：P0 图层操作单目标；Shift/Ctrl 多选、批量显隐/删除/重排=P1 批次（契约面 ops 单目标形状已为批量留自然扩展位=多次单目标调用）。
6. **SVG 框线+Canvas 点阵混合渲染**（§3 >10k 阈值切换）：坐标/命中/选中同步=2c 实现时**按 designer/viewport.svelte.ts 既有坐标系**（画布 px 坐标系——与 daemon 笔刷 BrushPoint 同一坐标真源；不另立第二坐标系——§0 红线）。
7. **view-state 版本化=独立 revision 链**（本波精确化 §1 原文「操作历史入版本」）：view.state.set 每 write revision+1+previousBlobRef 内容寻址回溯链；**不入 tree_versions**（tree-view 域 undo 沿本链——与 tree-structure 域解耦，见 D-3）。
8. **幂等语义=CAS 拒面携带电流指针**（不引入独立幂等键）：三写 RPC 均「基线+意图」确定性函数（同基线同产物——内容寻址）；成功后同 expectedTreeBlobRef 重试必被 cas-mismatch 拒（**无重复副作用**），错误面携带 currentTreeBlobRef——客户端比对自己上次响应的 treeBlobRef 即可区分「已生效」（放弃重试）与「他写」（刷新重放）。独立幂等键表=过度工程（写路径本就单用户主权面+版本链天然防双写）。
9. **空收敛 plan 边界=2b 裁定**：layer.delete 收敛后指派为空（全删指派节点）不落新 plan（StrategyPlan min(1) 内核契约不动）——gems=null 如实返回；空 plan 工件事表示（sentinel 或降 min(0)）2b 连导出面一并裁决。
10. **锁定语义精化**：locked 节点 mask.patch/reorder 必拒、delete 本体或含它的子树必拒；**移动锁定节点的祖先=reorder 放行**（整树搬运保子树完整≠编辑锁定节点本体——与 delete 的破坏性差异）。
11. **mask incomplete 是编辑面状态**：树节点工件（object-tree.json）不携带 incomplete 标记——真源=mask_edit_states（task.detail.maskEdits 面）；导出门按该面计算（管线原生 mask 无编辑留痕=不阻断——4096 约束是编辑面契约非存储面约束）。
12. **exportGate 第三因子 mask-recompute-error**：重算失败（状态机 error）与 stale 同属「编辑结果不可信」类，但单列以求可诊断（评审条件 #4 字面=前两因子，第三因子为完备闭包——枚举冻结三值）。

## 附录 D-3 undo 四域状态机（波 2a 冻结——评审「多 undo 域混栈」缺口闭合）

**域划分**（操作→域→版本载体）：

| 域 | 操作 | 版本载体 | 回退机制 |
|---|---|---|---|
| tree-structure | segment-one / rename / reorder / delete / revert | tree_versions（cause 五值） | tree.revert 整树快照回放 |
| mask-edit | mask-patch | tree_versions（cause=mask-patch）+mask_edit_states | 域内精确逆：取前驱快照同节点 mask 面替换（结构面不动） |
| tree-view | 显隐/折叠/锁定 | view-state revision 链（D-2⑦） | previousBlobRef 上一版工件整体回放 |
| strategy-param | layer.strategy.set | strategy-plan 工件帧流 | 重放上一版 plan（帧流倒数第二个 plan 帧）+execute |

**共同不变量**：每域独立游标（redo=游标前进重放本域操作）；Ctrl+Z 路由到**当前焦点域**（画布 mask 编辑态→mask-edit；图层树→tree-structure；策略卡→strategy-param；显隐/折叠/锁定操作后→tree-view）；本域栈空→提示「本域已无可回退」，**不自动跨域回退**（跨域=用户显式切换上下文）；structure 域回退经 tree.revert 时 UI 预览**如实列出一并回退的他域中间操作**（单一快照链语义透明化）。

**交错操作示例**（冻结语义——mask 域回退不动 strategy 域）：

```
t1 拆层「帽子」            → tree_versions v1 cause=segment-one（structure 域栈: [v1]）
t2 笔刷扩帽檐              → v2 cause=mask-patch（mask 域栈: [v2]；mask_edit_states n-hat ready）
t3 帽子密度 2.3→2.0        → strategy-plan 帧流（param 域栈: [plan-密度2.0]；不占 tree 版本）
t4 帽子移到画布根下        → v3 cause=reorder（structure 域栈: [v1, v3]）

此刻在画布 mask 编辑态按 Ctrl+Z（mask-edit 域回退 t2）：
  取 v2 的直接前驱快照 v1 中 n-hat 的 {mask,bbox,effectiveMm} → 替换当前树同节点
  （t4 的新父位保留——结构面不动；t3 的密度 2.0 保留——param 域独立）
  → 落 v4 cause=mask-patch「撤销笔刷」（mask 域栈: [v2]→游标回退；历史只增不删）

再切到图层树按 Ctrl+Z（structure 域回退 t4）：
  tree.revert 到 structure 域上一版本 v1——UI 预览提示「将一并回到 v1 时刻的
  遮罩与重排（mask 域 t2 撤销痕一并消失）」；用户确认后电流树=v1 快照
  （t3 的 plan 帧不受 revert 影响——param 域栈仍可独立回退）
```

**实现波次**：域游标与 Ctrl+Z 路由=2c（命令总线）；tree.revert/版本链/view-state 链/plan 帧流四载体=2a 已冻结可用；mask 域精确逆（前驱快照节点面替换）=2c 在 workbench 增补（契约形状沿 mask-patch 复用，不新开 RPC）。
