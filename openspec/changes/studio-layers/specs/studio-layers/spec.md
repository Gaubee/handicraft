# 排钻设计页图层化能力（studio-layers）Delta

## ADDED Requirements

### Requirement: 图层数据模型与分区不变量
排钻设计的块 MUST 组织为图层（块的命名分组容器，每层独立持有策略、物理四件（specKey/gapMm/density/relax）与块级覆写四表）；分区不变量 MUST 运行时守卫：恰一层持有 `blockIds:'rest'`（兜底哨兵）、每个启用块 MUST 恰属一层（显式层互斥、并集 ⊆ 当前块集）、背景层 MUST NOT 参与排布/统计/导出；序列化面 MUST 投影为 W0 冻结的 `LayerRecord`（本 change 不重定义）；重分块（k/seed 变更）MUST 为原子 `segment.opts` 操作——新块自动落入兜底层、显式层成员清空但层配置保留（空层保留）、各层悬空覆写键 MUST 逐层清理并计数提示（不静默）；撤销 `segment.opts` MUST 经引擎确定性重建旧块归属。
#### Scenario: 进页默认现状效果
- **WHEN** 载入来源图并分块完成
- **THEN** 存在单一兜底层「图层 1」持有全部块（默认 hybrid / round-ss10 / gap 0.4 / 密度 100% / 松弛关），默认全选并自动排布——与图层化前的单层默认效果等价（由兼容性测试证明，见下）
#### Scenario: 重分块重置归属
- **WHEN** 用户修改分块参数 k 或 seed
- **THEN** 新块全部落入兜底层，显式层成为空层但配置保留，悬空块覆写被清理并以「N 项块覆写失效已移除」横幅计数提示
#### Scenario: 撤销跨越重分块
- **WHEN** 用户在重分块后执行撤销回到旧 k/seed
- **THEN** 引擎确定性重生成旧块 id，后续块引用操作重新生效，对应 stale 诊断条目消失

### Requirement: 层级计算单元与兼容性
层 MUST 为唯一计算单元：`computeLayer` 单一入口（P0 单 worker 逐层串行、逐层渐进落地、逐层错误隔离——单层失败只污染该层结果）；「默认全选 = 图层化前效果」MUST 以旧五策略循环实现为 oracle 证明（单 rest 层同参时钻位/警告/剔除逐位相等），兼容性矩阵 MUST 覆盖结果缓存（未触碰层保留可用）、进度单位（segment 1 + N 层）、取消（ComputeAbortedError 身份与迟到结果丢弃）、run 号作废、错误隔离、重算期间旧结果保留六项；证明完成前 MUST NOT 切换任何计算实现切片。
#### Scenario: 逐位等价主断言
- **WHEN** 单兜底层以与旧实现相同的 image/blocks/grid/density/relax/seed 计算任一策略
- **THEN** computeLayer 输出与旧五策略循环该策略子轮的 gems/warnings/dropped 逐位相等（旧输出以固定 fixture 固化）
#### Scenario: 单层失败隔离
- **WHEN** 某层计算抛出引擎错误
- **THEN** 仅该层结果进入 error 态（层行红点 + title），其它层结果与统计不受影响
#### Scenario: 切策略即重算
- **WHEN** 用户在层配置卡切换某层策略
- **THEN** 该层进入重算队列，重算落地前旧结果保持可见（渐进落地，画布不闪空）——五策略并行秒切缓存废除为显式登记的方向性变更

### Requirement: 多选与批量配置
图层选择 MUST 为有序选择集（selectionOrder：单击重置/Cmd 追加/Shift 范围/Cmd+A 全选普通层），锚点层 = selectionOrder[0] = **最早选中的层**（多选 >1 时行首显示 ①②③ 徽标）；多选配置比较 MUST 为字段级（策略/物理四件/覆写逐字段）：全部相等显示「N 层 · 配置相同」+ 共同值，任一不等 MUST 显示「N 层配置不同 · 以 ①层名 为基准」且字段一律预填锚点层值（MUST NOT 显示混合值）；混合态下触碰任一配置控件 MUST 将该字段写入全部选中普通层，且 MUST 记为单个 `layer.config` 操作（一次撤销恢复全部选中层原值）；背景层可被选中（调源/透明度）但批量物理写入对其无效。
#### Scenario: 混合配置基准预填
- **WHEN** 用户加选三个配置互不相同的层
- **THEN** 检查器横幅「3 层配置不同 · 以 ①最早选中层名 为基准」，策略/规格/gap/密度/松弛各字段预填锚点层值
#### Scenario: 批量写入整体撤销
- **WHEN** 混合态下用户修改规格滑杆后执行一次撤销
- **THEN** 全部选中普通层的该字段恢复各自原值（单 op 语义）
#### Scenario: 空层参与多选
- **WHEN** 多选集合含重分块后的空层
- **THEN** 空层可被批量写入并进入脏层队列（计算时产出 0 钻），选择序与锚点语义不变

### Requirement: 观察态与渲染三分
层可见性、背景源与透明度、层/块选择、历史栈 MUST 为纯会话观察态——不入 .gemproj、不入历史（.gemdoc 烘焙文档仍记录最终显示层，文档态与工程态分界 MUST 在词条与文案中显式区分）；打开工程 MUST 恢复默认观察态（全部层可见、背景默认源/50%）并单次提示不恢复上次观察布局；层渲染透明度 MUST 三分：选中层 1.0 / 非选中层 0.8（固定常量，UI MUST NOT 提供调节面）/ 背景层默认 0.5 可调；全局 previewMode 三模式 MUST 收编为背景层「源」字段（无/数字油画/参考原图），上下文条预览控件废除；隐藏层 MUST 仍参与计算、统计与导出（隐藏 ≠ 排除为显式命名语义），状态条 MUST 附「含 k 隐藏层」标注，「只导出可见层」MUST NOT 复用眼睛开关实现。
#### Scenario: 隐藏层仍导出
- **WHEN** 用户隐藏某层后导出 SVG/BOM
- **THEN** 导出物包含该层钻位（全设计口径），状态条显示「含 1 隐藏层」附注
#### Scenario: 打开恢复默认观察态
- **WHEN** 打开一个此前隐藏过多层的 .gemproj
- **THEN** 全部层可见、背景为默认源 50%，并提示观察布局不随工程保存
#### Scenario: 背景层透明度可调
- **WHEN** 用户选中背景层调节透明度滑杆
- **THEN** 仅背景合成透明度变化（0–1），普通层仍按选中 1.0/非选中 0.8 固定渲染

### Requirement: 命令重放历史
排钻设计历史 MUST 为命令重放模型：`fold(baseSnapshot, ops[]) → {state, diagnostics}` 纯函数，操作集 = 八类 StudioOp（layer.create/delete/merge/rename/moveBlocks/config、block.override、palette.edit、segment.opts）；计算结果 MUST NEVER 入栈（撤销/重做 = 截断 + 重折 + 层配置差分重算，未触碰层结果缓存继续有效）；失效操作（如重分块后指向已死块 id 的 op）MUST 进入确定性诊断流（稳定 code/path 排序）并在历史面板只读灰显「已失效」——MUST NOT 静默吞除或重写为有效操作；历史上限 100 组，超限压实 MUST 记录被压实 op 边界与压实后 state hash（跨压实边界 undo/redo 等价可验证）；历史栈 MUST NEVER 序列化（.gemproj 存 fold 终态，打开 = 新 base 历史清空）；⌘Z/⌘⇧Z 与面板按钮 MUST 同源（同一 reducer 入口）；同 base + 同 ops 流 MUST 折出同 state 且同 diagnostics（属性测试义务）。
#### Scenario: 撤销即重放
- **WHEN** 用户撤销一次批量配置操作
- **THEN** op 截断后全量重折，仅配置变化的层进入重算队列，其余层沿用结果缓存
#### Scenario: 失效操作可解释
- **WHEN** 重放路径上存在块引用已死块 id 的操作
- **THEN** 该操作在历史面板灰显「已失效」并携带诊断条目（code/opIndex/blockId），重放不中断
#### Scenario: 压实边界等价
- **WHEN** 历史超 100 组触发最旧操作压实进 baseSnapshot
- **THEN** 同操作流在压实前后折出相同 state 与 diagnostics（state hash 断言）

### Requirement: 联合校验与导出门
层间几何合规 MUST NOT 依赖分区互斥假设：全部层结果（含隐藏层）concat 后 MUST 统一过 engine 冻结判据（`requiredCenterDistancePx(a,b,grid)` 圆包络 + `maxCellPx` cell，单位恒 px）与 `exportGate`；`exportGate` MUST 为 SVG/BOM CSV/PNG/送精修的共同前置——存在 spacing/mask/missing-asset 违规即硬阻断（不产出导出物），保存允许 warning；违规清单 MUST 按层对分组呈现（层内违规/层间违规）且确定性排序；层内布局终局（含 relax 位移产物）MUST 随 concat 同门受检；间距违规修复动作（边界松弛/斥力修复）MUST 写入违规涉及的层；八类碰撞源（相邻块边界/各层独立 layout/不同径 gap/repulsion 位移/重分块归属变化/专家回流文档/malformed import 第二道防线/未来手工钻）MUST 各有测试用例。
#### Scenario: 跨层间距违规阻断导出
- **WHEN** 两个不同规格的层各自合规但 concat 后存在跨层中心距不足的钻对
- **THEN** exportGate 报告层间违规（按层对分组），SVG/BOM/PNG/送精修全部阻断直至修复
#### Scenario: 修复写入涉事层
- **WHEN** 用户对层间违规清单执行「边界松弛」
- **THEN** 松弛开关仅写入违规涉及的层（多选批量单 op 语义），触发对应层重算
#### Scenario: 隐藏层参与校验
- **WHEN** 被隐藏层与可见层存在间距违规
- **THEN** 违规仍被报告且导出被阻断（隐藏是观察态，不改变合规口径）

### Requirement: gemproj v2 打开与逐层重放
打开 .gemproj（v1 经 W0 迁移入口读入）MUST 执行六步逐层重放链：segment 单轮 → 唯一 rest 与显式层成员解析（rest = 分块结果 − 显式层并集）→ 每层派生 effectiveBlocks/两级密度回落/`gridFromSpec` 按层 specKey → 逐层 computeLayer（同 seed 纪律）→ 全层 concat 联合校验 → 载荷携带逐钻规格快照与 PhysicalCanvas；层 specKey 解析 MUST builtin 走 engine bootstrap、custom 走目录注入（missing = typed 态，MUST NOT 静默降级圆钻）；悬空覆写键 MUST 逐层清点提示；v1 fixture 迁移为 v2 后重放输出 MUST 与旧整图单策略重放逐位相等（钻位/颜色/悬空清点）；v1 兼容派生读面（deriveLegacyGemprojView）MUST 随 v2 消费落地删除。
#### Scenario: 层配置不丢失
- **WHEN** 打开含多个显式层（各自策略/规格）的 .gemproj
- **THEN** 每层按自身配置重放，层结构/配置/覆写完整恢复（对照旧实现丢层配置的缺陷）
#### Scenario: v1 旧档逐位相等
- **WHEN** v1 fixture 经迁移入口转 v2 后走六步链
- **THEN** 钻位、颜色映射、悬空覆写清点与迁移前旧 replay 路径逐位相等
#### Scenario: 自定义规格缺失
- **WHEN** 层引用的 custom specKey 目录解析为非 resolved 态
- **THEN** 打开链路以 typed 错误呈现 missing（不静默按圆钻排布）

### Requirement: 送精修交接与物理锚贯通
`ManualEditHandoff` MUST 携带各层 concat 的钻集（每钻物化 shapeId/diameterMm 等规格字段）、各层 effectiveBlocks 并集、层语法 sourceSummary（「N 层 · 共 X 钻 · 主规格 …」）与 `PhysicalCanvas`；`pixelsPerMm` MUST 锚定实际降采样 canvas 像素宽（`实际宽 ÷ widthMm`，缺席回退 default 2.5 显式）；`loadFromHandoff` v2 MUST 将物理锚贯通 `EditDocument` 并经 gemdoc round-trip 字节等价保持；无锚旧载荷（quickLayout）MUST 以 default 锚兼容；该 payload 的唯一修改 owner = 本 change（A 轨薄 wrapper 换真），消费接线解锁前 MUST NOT 出现第二修改点。
#### Scenario: 多层送精修
- **WHEN** 三个层（不同规格）完成后点击送精修
- **THEN** 专家工作台收到的文档含全部层钻位（逐钻规格物化）、物理画幅锚与层语法摘要
#### Scenario: 物理锚 round-trip
- **WHEN** handoff 载荷经 loadFromHandoff → 保存 .gemdoc → 重新打开
- **THEN** physicalCanvas（declared/default 两态）字节等价保持，画幅读数与 px/mm 换算一致

### Requirement: 排钻设计页布局与策略单真源
排钻设计页 MUST 为四区 + 左列拓扑（上下文条/[左列 260px | 画布 | 检查器 320px]/状态条；「画布常驻/答案常驻/主区零滚动」不变量沿用）：左列 MUST 为双 tab（图层|历史）面板（撤销/重做入口归此与快捷键，状态条不含）；策略选择的唯一写入点 MUST 为选中层配置卡的策略字段（StrategyFilmStrip 胶片带整区废除——组件、setActiveStrategy API、五策略结果缓存、hover 浮卡资产不留死 API）；底部状态条 MUST 只保留左端统计（共 N 钻/层数/含隐藏层/合规徽标/BOM 摘要）与右端导出（SVG/BOM/PNG/送精修）+ 进度与取消；上下文条预览三模式与透明度控件 MUST 废除（迁背景层配置）；导出文件名 MUST 为 `${baseName}.${ext}`（去策略后缀），同名覆盖与 PNG 入库命名行为 MUST 有冻结测试；移动端 MUST 同构（bottom sheet 图层/历史抽屉、长按多选）。
#### Scenario: 策略单真源迁移
- **WHEN** 用户在检查器层配置卡切换策略
- **THEN** 写入该层 strategy 字段（全应用唯一写入点），状态条只读回显统计——胶片带与五策略秒切不再存在
#### Scenario: 底部只剩统计与导出
- **WHEN** 桌面端查看排钻设计页底部
- **THEN** 状态条左端为全设计统计（含隐藏层附注）、右端为四个导出动作与进度/取消，无任何策略或参数控件
#### Scenario: 死 API 清零
- **WHEN** 全库检索 StrategyFilmStrip / setActiveStrategy / previewMode / overlayOpacity 导出面
- **THEN** 零命中（废除清单执行完毕，浮卡资产迁 P2 或删除）
