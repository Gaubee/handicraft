# 排钻设计页图层化重构 · 产品级设计

> 版本：v1.1（2026-09-19，修订稿；Codex R1 4.9/10 NEEDS-WORK 已处置，见 §I——16 议题裁决与 P0-1~8 全部落档）
> 最高约束：Owner 需求原文（2026-09-19，见 §0.1）——本文一切裁决与其冲突处以原文为准并显式标注。
> 姊妹稿纪律沿用：`.agents/documents/2026-09-19-expert-workbench-and-sizes/expert-workbench-and-sizes.md`（**v1.1**，已按其 R1 修订）的「PM 立场为工作裁决、Codex 裁决前对应切片不实现」原则。**R1 已裁决**（2026-09-19，同目录 `codex-review-r1.md`，4.9/10 NEEDS-WORK）：被推翻/收紧/纠偏的立场已在正文以 [R1 推翻/收紧/纠偏] 标注并改写，终局落档 §I；§G 保留 v1 立场存档并加 [R1] 标注。
> 证据分级标注：〔源码〕= 源码符号一手；〔Owner〕= 用户一手原话；〔行业〕= 公开检索（中置信，注来源）；〔判断〕= PM 推断（注置信度）。
> 本文不产出视觉 token（OJO 赛道留待方向拍板后另出简报）。GPU：调研已回结论（同目录 `gpu-research.md`）——**GPU 仅预览加速器、落盘/导出/重放恒 CPU 精算**；§C.6 引用其结论并冻结接口契约（[R1·P0-8] 处置）。
> 名实对齐说明（任务书要求核查）：Owner 列举的「CVT 点画」与源码零出入——`computeCore.ts` 的 `STRATEGY_LABELS.cvt = 'CVT 点画'`（〔源码〕），五策略映射 1:1：六方抽稀=`hex-thin`、六方变距=`hex-pitch`、泊松盘=`poisson`、语义混合=`hybrid`、CVT 点画=`cvt`。下文一律用源码符号。

---

## 0. 决策框架

### 0.1 Owner 需求原文（逐字）

> 「转化工作台这里也需要进行重构：
> 1. 引入图层概念，因为有些时候鼠标不能正确选中图层。这样就可以从图层列表中直接选中。并且也可以实现隐藏部分图层方便观察
> > 图层面板在左侧
> 2. 支持同时选中多个图层，同时进行算法排布
> 3. 左下角这个工具条废除掉，整合到图层的选中编辑中。也就是说六方抽稀、六方变距、泊松盘、语义混合、CVT 点画这些按钮现在属于某个图层，和物理参数这里也是，属于某一个图层。底部工具栏就只剩下左下角的统计和右下角的导出
> 4. 因为每个图层都有独立的配置，所以如果多选图层，并且这些图层的配置不一样，那么要明确提示：配置不同。并且属性面板的值都滞空（提供默认值），方便用户基于默认值进行修改。默认值使用第一个选中的（注意不是排列在前面，是最早选中的）那个图层
>
> 也就是说，原本很多对整个页面做的排钻算法，现在只针对图层。要达到现在的效果，只需要在页面一进来的时候，默认是全选图层，然后进行排钻计算。
>
> 1. 选中的图层，变成完全不透明，非选中的默认透明度是80%。这个不可调。
> 2. 背景是一个独立的图层，默认50%的透明度，这个可以调
> 3. 有历史操作记录面板，支持撤销重放（但是不记录结果，所以每次都会重新计算）
> 4. 有些算法是非常成熟的的，可以考虑转译成WEBGPU/WEBGL，可以考虑用 GPU.js 来开发。如果能在网络上找到成熟的高性能的实现，可以调研一下」

### 0.2 需求解构（Owner 原文 → 任务 → 归属）

| # | Owner 语句片段 | 解构出的任务 | 归属 |
|---|---|---|---|
| R1 | 「引入图层概念，因为有些时候鼠标不能正确选中图层…从图层列表中直接选中」 | 图层数据模型 + 列表确定性选中（画布逐像素命中 `blockIndexAt` 不可靠的兜底） | §A / §B.2 |
| R2 | 「隐藏部分图层方便观察」「图层面板在左侧」 | 层可见性（观察态）+ 左侧面板 | §A.4 / §B.1 |
| R3 | 「支持同时选中多个图层，同时进行算法排布」 | 有序多选 + 批量配置写入 + 逐层排布 | §A.5 / §C.2 |
| R4 | 「左下角这个工具条废除掉，整合到图层的选中编辑中…属于某个图层」 | 五策略 + 物理参数从页面级降为层级；StrategyFilmStrip 废除 | §B.1 / §B.3 |
| R5 | 「底部工具栏就只剩下左下角的统计和右下角的导出」 | 状态条收窄为统计 + 导出 | §B.5 |
| R6 | 「配置不一样…明确提示：配置不同。属性面板的值都滞空（提供默认值）」 | 混合配置态语义 + 基准值预填 | §A.5 |
| R7 | 「默认值使用第一个选中的（注意不是排列在前面，是最早选中的）」 | 选择序（selectionOrder）与锚点层（anchor）显式建模 | §A.5 |
| R8 | 「原本对整个页面做的排钻算法，现在只针对图层」「页面一进来…默认是全选图层，然后进行排布计算」 | 计算单元从页面 → 层；进页默认全选 = 现状效果（**待证契约**：compatibility test 以旧实现为 oracle，[R1 推翻·议题 8]） | §C.4 |
| R9 | 「选中的图层…完全不透明，非选中的默认透明度是80%。这个不可调」 | 层渲染透明度固定二值（选中 1.0 / 非选中 0.8） | §B.6 |
| R10 | 「背景是一个独立的图层，默认50%的透明度，这个可以调」 | 背景层（特殊层：不参与排布，透明度可调）+ previewMode 三模式收编裁决 | §A.4 / §B.7 |
| R11 | 「有历史操作记录面板，支持撤销重放（但是不记录结果…重新计算）」 | 命令重放式历史（结果永不存档，参数态 fold） | §D |
| R12 | 「可以考虑转译成WEBGPU/WEBGL…GPU.js…调研一下」 | GPU = 预览加速器定位（gpu-research.md 结论）+ `computeLayer` 接口契约冻结（capability-labeled + CPU 回退） | §C.6 |

### 0.3 现状证据底座（〔源码〕符号清单，裁决的地基）

- **store 状态**（`src/lib/stores/studio.svelte.ts`）：模块级 `$state`——`blocks: Block[]`（k 色聚类连通域）、块级覆写四表 `disabledIds/densityOverrides/typeOverrides/colorOverrides`（键 = 引擎块 id，重分块后 `pruneStaleOverrides` 清悬空）、全局物理 `globalDensity/ss/gapMm/relax`、`palette`、**单选** `selectedBlockId`、`activeStrategy`、`previewMode('gems'|'painting'|'reference')`、`overlayOpacity(默认 0.5)`、`results: Record<StrategyId, StrategyResult|null>`（**五策略全算**）。
- **计算链**：`scheduleSegment(300ms) → runSegment(strategies:[]) → scheduleLayout(300ms) → runLayouts()`——逐策略子轮、渐进落地、run 号作废迟到结果、`cancelCompute` 显式取消、`computeProgress {done,total,label}`。
- **五区布局**（`StudioView.svelte` + redesign-studio-layout 冻结）：上下文条 h-10（来源/预览三模式+透明度/取景）/ [画布 flex | 检查器 320px] / **StrategyFilmStrip h-14（左下策略胶片带，`setActiveStrategy` 唯一写入点，「对比」占位禁用）** / 状态条 h-12（统计 + 校验 + BOM + 导出 + 送精修）。
- **画布命中**（`BlockCanvas.svelte blockIndexAt`）：逐像素查 label 图 `l.label[iy*W+ix]`，无容差——细块/边界像素/被钻覆盖区命中失败，即 Owner 痛点技术本质。
- **撤销先例**（`edit.svelte.ts`）：`UNDO_GROUP_BUDGET = 100` 组预算、stroke 合组、新操作清空 redo、撤销栈永不序列化。
- **gemproj v1 契约**（add-project-files design §1.1）：`segment{k,seed}` / `overrides{disabled,density,type,color}`（**键 = 引擎块 id**，〔源码〕`projectFile.ts` `GemprojFile.overrides` 头注——[R1·议题 2] 事实纠偏的锚点）/ `physics{ss,gapMm,globalDensity,relax}` / `palette` / `activeStrategy`；**永不入文件**：results、previewMode/overlayOpacity、selectedBlockId。2.x 生命周期切片（保存/打开/上下文条重写）**未实现**（〔源码〕tasks.md 2.1–2.7 全未勾选）。
- **姊妹稿**（expert-workbench-and-sizes **v1.1**，已按其 R1 修订）：§A GemSpec（形×尺寸规格；v1.1 冻结 `BaseSpec`/`GemSpecSnapshot{specKey,ordinal,…}`/`GridSpec = 派生几何上下文`/`PhysicalCanvas` 契约）、§D 排钻影响（P0-1「检查器 physics 区 = 整图单一 baseSpec」——待本轮合流覆盖为层级，§E.2）、§G 议题 4（layout 五策略不动，单一 pitch）。

### 0.4 总裁决（一句话版）

1. **图层 = 块集分区的命名容器 + 独立排布配置**：每个启用块恰属一层（分区不变量）；层的配置面 = 策略（五选一）+ 物理四件（specKey（→BaseSpec）/gapMm/密度/relax）+ 块级覆写（层内块）；自由绘制区/掩码区明确不进 P0（§A.1）。
2. **兜底层哨兵解决「默认层」与迁移**：恰有一层持有 `blockIds:'rest'`（未显式分配的块自动落入）；进页面 = 单兜底层「图层 1」+ 默认全选 + 自动排布 = 现状效果（**待证契约**，compatibility test 以旧实现为 oracle，§C.4）；[R1 纠偏·议题 2] `rest` 的迁移价值 = **避免为迁移重跑分块**（v1 `overrides` 四表键本就是引擎块 id，「v1 不存块 id」是 v1 稿事实错误）——打开/重放分块后仍需逐层 `pruneStaleOverrides` + 悬空键计数提示（§E.1）。
3. **五策略与物理全部降层**：StrategyFilmStrip 废除；策略唯一写入点 = 选中层配置的策略字段（单真源纪律平移，宿主更换）；底部只剩统计（左）+ 导出（右）（§B）。
4. **多选 = 有序选择集 + 锚点 = 最早选中**：配置不同 → 「配置不同」横幅 + 字段预填锚点值（不显示混合值），任何写入落到全部选中层（§A.5）。
5. **渲染三分**：选中层 100% / 非选中层 80%（固定常量）/ 背景层 50% 起步可调；previewMode 三模式收编为背景层的「源」选择（无/数字油画/参考原图）——上下文条预览控件废除（§B.7，显式覆盖 redesign-studio-layout 冻结面）。
6. **历史 = 命令重放，结果永不记录**：`baseSnapshot + ops[]` 纯 fold；撤销/重做 = 截断 + 重折 + 脏层重算；依赖引擎确定性（seed 固定）；上限 100 组 + 参数态压实（§D）。
7. **计算 = 层即单元**：`computeLayer` 单一入口（接口冻结，GPU 为 capability-labeled 预览加速位，§C.6）；P0 单 worker 逐层串行（渐进落地平移）；**[R1 推翻·议题 9] 跨层间距 ≠ 「分区互斥即永不重叠」**——全层结果 concat 后统一 pairwise（唯一 helper `requiredCenterDistancePx(a,b)` + `maxCellPx`，px 单位）；`exportGate` 为 SVG/BOM/PNG/送精修共同前置，违规导出硬阻断（§C.3）。
8. **gemproj v2 与 GemSpec 一次 bump 合流**：`physics/overrides/activeStrategy → layers[]`（每层 spec/物理/策略/块集）；**层 physics 引用 canonical `specKey`，输出/编辑钻物化 `GemSpecSnapshot`**（BOM/SVG/迁移以快照身份，[R1·合流缺口 1]）；add-project-files 2.x 移交本重构——[R1 收紧·P0-5] 移交必须在归档前同步修改原 change 的 design/spec/tasks，不能只在本文声明（§E.3）。
9. **策略对比降 P2**：对比视图 = 对选中层临时批量算五策略缩略（不产生层、不落文档）；「复制层做对比」否决（破坏分区不变量 + 幻影碰撞）（§C.5）。
10. **观察态不入档不入历史**：层可见性/背景源与透明度/层块选择/历史栈 = 会话瞬态（gemproj「永不入文件」清单扩编；与 gemdoc layers 入档的差异显式登记为议题）（§A.4 / §D.2）。

---

## §A 图层数据模型

### A.1 图层是什么：块集分区 + 每层配置

**内容单元裁决：图层 = 块（Block）的命名分组，分区不变量 = 每个启用块恰属一层。** 证据链：

- 〔源码〕块已是引擎排布的参与单元（`effectiveBlocks` 送 layout、`densitySpec` 按块 id、`typeOverrides` 按块）——图层 = 块的分组，引擎面零新增概念；
- 〔Owner〕「鼠标不能正确选中图层」的痛点对象就是块命中（`blockIndexAt` 逐像素查表，无容差）——Owner 口中「图层」的现状所指即块；图层列表给确定性选中；
- 〔Owner〕「隐藏部分图层方便观察」——隐藏一组块；
- 〔判断·高置信〕区域掩码/自由绘制区需要新引擎几何原语（mask 并差运算、绘制工具），是 P2+ 独立轨道；P0 用块集即可兑现 Owner 全部列点。

**反证备案**：若 Owner 后续要「背景区 SS16 平铺 + 主体马眼勾勒」这类跨块区域策略，P0 表达 = 按块分组进层（块粒度已够）；真自由区域（任意形状不依赖分块）到需求出现时作为「掩码成员类型」扩展层模型（`blockIds: string[] | 'rest'` 的成员类型泛化），不推翻本轮结构。

**PS 图层语义对照表（P0/P1 分层）：**

| PS 语义 | 本模型对应 | P0/P1 | 说明 |
|---|---|---|---|
| 新建图层 | 空层 / 从选中块「移入新图层」 | **P0** | 两条创建路径（§A.2） |
| 重命名 | 双击层名 | **P0** | 默认名「图层 N」自增 |
| 合并 | 多选层 → 合并（配置取锚点层） | **P0** | 与多选编辑语义同构（§A.5） |
| 删除 | 删除层（层内块随层移除出设计） | **P0** | 确认 Dialog（§A.2）；兜底层不可删 |
| 显示/隐藏（眼睛） | 层可见性 | **P0** | 观察态，不影响计算/导出（§A.4） |
| 拖拽排序 | 层重排序 | **P1** | z 序仅影响半透明合成视觉与 P1 剔除仲裁优先级（C.3），纯装饰——几何合规由统一 pairwise 保证而非层序（[R1·议题 9 纠偏]，排序不得改变几何或 BOM 顺序） |
| 锁定 | 层锁 | **P1** | 防误编辑强化；P0 无编辑性破坏路径（层的破坏操作都有确认） |
| 复制图层 | **否决（P0）** | — | 破坏分区不变量：两层引用同块 → 同区双份钻 → 幻影碰撞；对比诉求走 §C.5 |

### A.2 图层生命周期操作（Entity / Ownership / Lifecycle / State / Configuration boundary 五问）

- **Entity**：`LayerRecord { id, name, blockIds, strategy, physics, overrides }`（schema 见 §E.1）；层 id 由 store 侧自增（`L1…`），**不随重分块死亡**（引擎块 id 才会）。
- **Ownership**：层属于排钻项目（gemproj）；块属于层（分区）；块级覆写住在所属层的 `overrides` 内（键仍为引擎块 id）。
- **Lifecycle**：
  - 创建：①「+ 新建图层」→ 空层（继承当前锚点层配置为初始值〔判断·中高置信〕：新建层多半是想「跟当前调好的参数差不多再微调」）；②选中若干块 →「移入新图层」→ 新层含这些块（从原层移出）。
  - 合并：多选 ≥2 层 →「合并图层」→ 块集并集落入锚点层，其余层删除；配置冲突取锚点层（「最早选中」语义贯穿，§A.5）。
  - 删除：确认 Dialog「层内 N 块将随层移出设计（不再参与排布/统计/导出）」；**兜底层不可删除**（总有容器接住未分配块）。
  - 重分块（k/seed 变更，破坏性沿用 `SegmentPanel` 警示；[R1 收紧·议题 3] 定性为**原子 `segment.opts` op**，撤销语义见 §D.2）：新块 id 全新生成 → **所有新块自动落入兜底层**（'rest' 哨兵自然实现）；显式 `blockIds` 层的成员 ∩ 新块 = ∅ → **空层保留**（配置在、块没了——PS 空图层心智）；**旧 override 计数与提示**：重分块后各层 `overrides` 的悬空键由 `pruneStaleOverrides`（按层执行）清点删除，横幅报告「N 项块覆写失效已移除」——不静默；警示文案升级为「重分块将重置图层分配与块覆写」。P1 可选增强：按代表色就近迁移启发式（opt-in，默认关）。
- **State**：`computing`（排布中，行内 spinner）/ `stale`（配置已改待重算，行内 ～ 角标）/ `error`（该层计算失败，红点 + title）/ `empty`（无块）——每层独立，互不拖垮（沿用单策略错误隔离精神）。
- **Configuration boundary**：层配置面 = `strategy`（五选一）+ `physics{ specKey, gapMm, density, relax }` + 层内块覆写。**不属于层**的：分块参数 k/seed（整图）、色板（项目级资产，颜色映射是块属性）、pixelsPerMm / declaredPhysical（整图物理锚，姊妹稿 §A.3）、来源图与参考原图。

### A.3 默认图层与「进页面 = 现状效果」

裁决：**分块后不自动按色/按连通域爆层**。进页面 = 单一兜底层「图层 1」（`blockIds:'rest'`）持有全部块，配置 = 现默认值（`strategy:'hybrid'`——即现 `activeStrategy` 缺省、SS10/gap0.4/密度100%/松弛关），**默认全选该层并自动排布**。反对「自动按 k 色成层」：几十个连通域自动成层 = 列表爆炸 + 违反 Owner 自己声明的「页面一进来默认全选=现状效果」（自动多层的「全选」聚合效果 ≠ 现状单参数效果——分色层各自的默认配置虽然可设为相同，但层间独立性让「改一处」不再全效，心智骤变）。〔判断·高置信〕按色一键分层的诉求真实存在，作为 P1 动作（「按色分入新层」按钮），不是自动行为。

### A.4 背景层（特殊层）与观察态

- **背景层 = 特殊层**：固定位于列表最底（分隔线之下）、不可删除/不可重命名/不参与排布与统计；持有「源」选择（`'none' | 'painting' | 'reference'`）与透明度（默认 0.5，可调 0–1）。
- **源语义迁移**（对现 previewMode 三模式的收编，详见 §B.7）：`'gems'` ⇔ 源=无（纯钻）；`'painting'` ⇔ 源=数字油画；`'reference'` ⇔ 源=参考原图（仅有参考图时可选）。**默认源 = 数字油画、可见、50%**——这是 Owner 字面（「背景…默认50%的透明度」隐含背景进场可见），对现状默认 `previewMode='gems'` 是一处 Owner 授权的默认值变更，显式登记。〔判断·中置信〕数字油画（k 色平涂）比参考原图（原始照片）更适合作钻下衬底——现状 'painting' 模式即此用途。
- **观察态族**：层可见性、背景源与透明度、层选择、块选择、取景、hover——**不入 gemproj、不入历史**（gemproj「永不入文件」清单扩编）。[R1 收紧·议题 5] 跨设备取舍显式化：**打开 .gemproj 恢复默认观察态**（全部层可见、背景默认源/50%）并明确提示「不恢复上次观察布局」；gemdoc 则烘焙文档保留最终显示层（四层显隐/透明度 = 文档态）。差异（gemproj 会话观察态 vs gemdoc 文档态）必须在 PRODUCT_MODEL/TERMS、preview 语义与保存/打开测试中**显式说明**（[R1·合流缺口 10]），不能只在 TERMS 口头区分。
- **隐藏 ≠ 排除（名义化契约，[R1 收紧·议题 4]）**：「隐藏仍计算/统计/导出」是本模型的**显式命名语义**，不是未加区分的默认：隐藏是纯观察态，画布渲染省略该层，但该层照常进入排布队列、联合 pairwise、统计口径与导出物；状态条常驻全设计口径数字并附「含 k 隐藏层」标注（B.5）；**未来若要「只导出可见层」，必须另设显式导出命令**（如「导出可见层」菜单项），禁止复用眼睛开关改变导出口径（暗数据损失路径）。议题 4 备案。

### A.5 多选与「配置不同」（锚点 = 最早选中）

- **有序选择集**：`selectionOrder: layerId[]`（点击单选=重置为 [id]；Cmd/Ctrl+点击=尾部追加；Shift+点击=列表范围替换；Cmd+A=全选普通层——背景层可被选入（为调源/透明度），但「全选排布」类批量写人对背景层的物理字段无效（只读））。
- **锚点层（anchor）= selectionOrder[0] = 最早选中的层**（Owner 明示「不是排列在前面，是最早选中的」）。层列表多选时锚点带选择序徽标 ①②③…（仅多选 >1 时显示），检查器横幅「以 ①主图案 为基准」。
- **配置一致 vs 不同**：全部选中层的配置面逐字段相等 → 横幅「N 层 · 配置相同」，字段显示共同值；任一字段不等 → 横幅「N 层配置不同 · 以 ①层名 为基准」，**字段一律预填锚点层值（不显示混合值）**。「滞空」的落地义 = 不呈现「当前值」假象——空值会逼用户从零猜数，预填基准值 + 明示基准来源才满足 Owner 括号里的「提供默认值，方便用户基于默认值进行修改」。〔判断·高置信，微形态留议题 12 备选（真空白占位、聚焦才填）〕
- **写入语义（[R1 收紧·议题 12] 冻结提交语义）**：混合检测器 = **字段级**（strategy/物理四件/覆写逐字段比较，非整层 blob 比较）；混合态下触碰任何配置控件 = 该字段（或整个配置面板的「应用」单元，按控件提交语义）**写入全部选中普通层**；每次写入即触发各层脏标记与重算（§C）。**批量写入 = 单个 `layer.config` op**（撤销一次恢复全部选中层原值，组语义 §D.2）。测试面冻结：不同策略/spec/gap/relax/overrides 的混合组合 + 空层选中态。
- **画布 ↔ 层选择联动**：画布点选块（命中成功时）= 选中该块 + **隐式单选其所属层**（两级选择：层选择驱动检查器配置面；块选择驱动块级覆写 `BlockDetail`）。命中失败（空像素）不改变任何选择——层列表与块列表是确定性兜底（Owner 痛点的结构性修复）。

### A.6 块级覆写的归属

块级四覆写（`disabledIds/densityOverrides/typeOverrides/colorOverrides`）**随块住进所属层的 `overrides`**，键仍为引擎块 id。全局密度语义消失，由「层密度（层内未覆写块的缺省）+ 块覆写」两级取代（`getBlockDensity` 的回落目标从 globalDensity 改为所属层 density）。色板仍为项目级（`mapColors` 输入全项目一份；颜色覆写按块键住在层内）。序列化时各层 overrides 只含本层块 id——分区不变量保证无跨层键。

### A.7 内存类型草案（契约 gate 冻结目标，非实现）

```ts
interface LayerState {
  id: string                       // 'L1'…（store 自增，重分块存活）
  name: string
  blockIds: string[] | 'rest'      // 'rest' = 兜底哨兵：未显式分配的块自动落入；恰一层可持有（不变量）
  strategy: StrategyId             // 五选一（hex-thin/hex-pitch/poisson/hybrid/cvt）
  physics: {
    // [R1·P0-1/合流缺口 1] 层规格引用 canonical specKey（姊妹稿 v1.1 GemSpecSnapshot 契约）——
    // builtin 确定性解析（round-ss10 等）；custom 经 assetId 解析（missing = typed 态，禁静默降级）；
    // GridSpec 由 specKey → BaseSpec 派生（gridFromSpec；姊妹稿 v1.1「GridSpec = 派生几何上下文」）
    specKey: string
    gapMm: number
    density: number                // 层内未覆写块的缺省密度（原 globalDensity 的层级化）
    relax: { boundary: boolean; repulsion: boolean }
  }
  overrides: {
    disabled: Record<string, true>
    density: Record<string, number>
    type: Record<string, BlockType>
    color: Record<string, string>
  }                                // 仅本层块 id（分区不变量保证无跨层键；序列化前按层 pruneStale）
  visible: boolean                 // 观察态（不入档）
}
// [R1·合流缺口 1] 输出/编辑钻物化不可变 GemSpecSnapshot（姊妹稿 v1.1 契约）：
//   { specKey, ordinal, shapeId, sizeLabel, diameterMm, widthMm?, heightMm?, assetId? } + 逐钻 rotationDeg
// BOM 键 = canonical specKey × colorId（不由显示码/浮点径反推资产）；SVG 逐钻按快照渲染；
// 四格式迁移以快照身份——一律不得以浮点径或显示 ordinal 反推。
// 结果（不入档，重算产物）：perLayerResults: Record<layerId, StrategyResult | null>
```

---

## §B 交互与布局

### B.1 新布局（五区 → 四区 + 左列；胶片带废除）

```
桌面 lg+（固定视口，无主区滚动——redesign-studio-layout 不变量沿用）
┌──────────────────────────────────────────────────────────────────────────────┬──────────────┐
│ 上下文条 h-10：[▪] 项目名 ●未保存 [保存▾]      │ 取景: 适应  +−  N%            │   （右列）    │
├─────────────┬──────────────────────────────────────────────────────────┬──────┴─────────────┤
│ 左列 260px   │                                                          │ 检查器 320px        │
│ ┌图层│历史┐ │                                                          │ ┌────────────────┐ │
│ │⤺ ⤻     │ │                                                          │ │①②③·配置不同    │ │
│ │👁①主图案 │ │                       画布（常驻舞台）                    │ │以①主图案为基准  │ │
│ │  2,341钻 │ │   选中层 100% · 非选中层 80%（固定）                      │ │策略[语义混合▾]  │ │
│ │👁②背景细节│ │   背景 50%（可调）                                       │ │规格[SS10▾]      │ │
│ │     812  │ │                                                          │ │gap ▬▬●▬ 0.40mm  │ │
│ │👁③轮廓线  │ │   选中块：强高亮（块级覆写用）                            │ │密度 ▬●▬▬ 100%   │ │
│ │      96  │ │                                                          │ │松弛 ○边界 ○斥力  │ │
│ │─────────│ │                                                          │ └────────────────┘ │
│ │👁 背景 50%│ │                                                          │ 选中块详情（常驻）   │
│ └[+ 新建层]─┘ │                                                          │ 折叠：块列表(选中层)/ │
│              │                                                          │ 色板 / 分块参数      │
├─────────────┴──────────────────────────────────────────────────────────┴────────────────────┤
│ 状态条 h-12：共 3,249 钻 · 3 层 · ✓间距合规 · BOM…▾ ◷计算中 2/3 [取消]   [SVG][BOM][PNG][✎送精修]│
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- 左列头部双 tab（图层 | 历史）+ 撤销/重做小按钮（⤺⤻，两 tab 常见）——Owner 明示底部「只剩下统计和导出」，撤销主入口归历史面板与 ⌘Z/⌘⇧Z。
- 左列宽度 260px〔判断·中置信，可走查微调〕；`min-h-0/min-w-0` 链与「画布常驻、答案常驻」不变量原样沿用（redesign-studio-layout §1 冻结精神平移）。
- StrategyFilmStrip（h-14）整区废除；策略/物理收进检查器层配置卡（B.3）。

### B.2 图层面板（左侧）交互细节

- **行结构**：`[眼睛] [层名（双击重命名）] [钻数 mono] [状态点（◷计算中 / ～待重算 / ！失败）]`；多选时行首追加选择序徽标 ①②③。
- **选择**：单击=单选；Cmd/Ctrl=加选（追加选择序）；Shift=范围；Cmd+A=全选普通层；点背景层行=单选背景层（检查器切换为源+透明度面板）。键盘：↑↓ 移动单选，Space 切换眼睛。
- **行尾菜单（⋯）**：重命名 / 合并到…（多选时）/ 删除层（兜底层删项禁用）/ 移入层的块（P1 拖拽块行到层行）。
- **底部动作**：`[+ 新建图层]`。
- **背景层行**：分隔线之下钉底；`[眼睛] 背景 [数字油画 · 50%]`；选中后检查器出源 Select（无/数字油画/参考原图）+ 透明度滑杆（0–100，默认 50）+ 只读说明「背景层不参与排布与统计」。
- **空层**：钻数位显示「空」+ title 提示（重分块后成员已重置，见 A.2）。

### B.3 检查器改版（Inspector）

置顶常驻 = **选中层配置卡**（对齐现「选中块详情置顶」纪律——上版「点了没反应」裁决不回退）：

1. **横幅区**：单选 = 层名；多选一致 = 「N 层 · 配置相同」；多选不一致 = 「N 层配置不同 · 以 ①层名 为基准」（Owner 原话「配置不同」作为文案锚点）。
2. **策略 Select**（五选一，中文名用 `STRATEGY_LABELS`）：**全应用唯一策略写入点**（胶片带 `setActiveStrategy` 唯一写入点纪律的宿主迁移）。
3. **物理组**：基础规格 Select（P0 圆钻 SS 档；异形待 GemSpec 基础层，字段已按 specKey→BaseSpec 落位，A.7）+ gap 滑杆 + 层密度滑杆 + 松弛双开关（边界/斥力——间距违规修复就近直达的目标层，见 B.5）。
4. 滑杆乐观 UI + 300ms trailing 提交（`CommitOpts.immediate` 语义平移，提交即层脏标记）。
5. **选中块详情**（`BlockDetail` 沿用）：作用于当前块选择；含「移入图层 ▸」动作（目标层菜单）。
6. **折叠组**：块列表（**只列选中层的块**；覆写交互沿用）→ 色板 → 分块参数（k/seed 全局；破坏性警示文案升级，A.2）。

背景层选中时 1–5 区替换为「背景面板」（源 + 透明度 + 只读说明），块详情/折叠组隐藏。

### B.4 上下文条

保留但瘦身：项目身份区 + 保存/菜单（add-project-files §3 规划位，2.x 移交后落）+ 取景控制（适应/+−/N%，转发协议沿用）。**废除**：预览三模式分段控件 + 透明度滑杆（迁往背景层配置，B.7）。移动端折两行不变。

### B.5 状态条（统计 + 导出 + 进度）

- 左（统计，Owner「左下角的统计」）：`共 N 钻`（唯一大数字位，全设计口径 = Σ 各层结果，**含隐藏层**——A.4 名义化契约）· `M 层 · 含 k 隐藏层`（附注，仅当有隐藏层）· 间距合规徽标（联合 pairwise 校验，C.3）· BOM 前 3 色 …▾。
- 右（导出，Owner「右下角的导出」）：SVG / BOM CSV / PNG / 送精修；导出门 = `exportGate`（全层 concat 统一 pairwise 的联合口径，[R1·P0-2] 命名收编——旧 `exportCheck` 单 activeResult 语义退役，C.3）与 busy 语义沿用。
- 违规态：红徽标 + 违规清单 ▾（**按层分组**，标注层间对/层内）+ [边界松弛][斥力修复] 写入**违规涉及的层**（多选批量语义复用 A.5）。
- worker 进度徽标 + [取消] 保留在状态条（`computeProgress` 聚合语义见 C.7）。

### B.6 画布与渲染语义

- **合成序（自下而上）**：白底 → 背景图（源非无且可见，bgOpacity）→ 各普通层（可见者，按列表序）→ 选中块强高亮。
- **透明度常量**：`SELECTED_LAYER_OPACITY = 1.0`、`DESELECTED_LAYER_OPACITY = 0.8`（Owner：不可调——UI 不提供任何调节面）；`BACKGROUND_OPACITY_DEFAULT = 0.5`（可调）。
- **选中层视觉**：选中层的块描边高亮（轻量，复用现 hover/选中渲染路径）；非选中层 80% 提供视觉退隐。〔判断〕块互斥分区下无遮挡冲突，80% 退隐只与背景发生视觉混合，语义干净。
- **两级选择**：层选择（左列表/画布隐式）+ 块选择（画布点选/块列表行）。[R1 收紧·议题 13] 画布命中容差从「P1 乐观」改判 **P1 入口验收门**：P0 兜底 = 图层列表 + 块列表 + 键盘（↑↓ 单选移动/Space 眼睛，B.2）——确定性选中成立，但**列表不修复画布直觉路径**（现 `blockIndexAt` 逐像素精确命中、无容差，细块/被钻覆盖区仍点不中）；**P1 硬门** = 最近块/距离场容差命中（覆盖边界块、被钻覆盖区、缩放档位、空白点击四类测试），不随「列表已兜底」结案；Owner 走查若判定画布点选为主路径 → 升 P0（§I.4 未决项 1）。

### B.7 previewMode 三模式收编（裁决 + 显式覆盖声明）

裁决：**previewMode 全局态废除，收编为背景层「源」字段**（A.4）。上下文条的三模式分段控件与全局透明度滑杆废除；`previewRender.ts` 纯函数签名同步演进。**[R1 收紧·合流缺口 5] 新签名冻结**（v1 只写「覆盖签名」未冻结输入形状，现补）：

```ts
interface PreviewRenderInput {
  background: {                                        // 背景特殊层（唯一可调透明度层）
    source: 'none' | 'painting' | 'reference'
    opacity: number                                    // 0–1（默认 0.5）
    painting?: EngineImage | null                      // 数字油画底图（现 painting 字段语义）
    referenceBitmap?: ImageBitmap | HTMLImageElement | null
  }
  layers: Array<{                                      // 普通层；列表序 = 合成序（自下而上）
    id: string
    visible: boolean
    selected: boolean                                  // 选中层 alpha 1.0 / 非选中 0.8（固定常量）
    result: StrategyResult | null                      // 逐层结果（含逐钻 GemSpecSnapshot → 形状渲染）
  }>
  palette: Palette
  blocks: Block[]
  size: { width: number; height: number }              // CSS 像素 + dpr（沿用）
  dpr: number
}
```

（`mode/overlayOpacity/grid` 单值入口废除；逐钻形状经层结果的物化快照渲染，不再依赖全局 grid。）

**显式覆盖**：redesign-studio-layout §2 冻结的 `PreviewRenderInput` 签名（Codex-R1-B9 签名冻结）被本变更覆盖——纯函数边界纪律（无组件状态/Image 生命周期）**沿用不变**。**旧 golden 迁移**：每张旧三模式 golden 补一张「等价映射」新签名卡，渲染结果必须逐字节相等（`gems` ⇔ `background.source='none'`；`painting` ⇔ `source='painting'`、opacity=旧 overlayOpacity；单 rest 层 ⇔ `layers=[单层 selected]`）；迁移期新旧输入并存于测试、生产仅新签名——**缺旧 golden 迁移不得切实现切片**。理由：三模式本质是「钻下面的衬底是什么」——图层模型下衬底=背景层属性，全局态与层级属性双宿主 = 一个概念两个真源（PRODUCT_MODEL 硬规则 2），必须归一。

### B.8 移动端映射（同构）

上下文条折两行（含「图层」「历史」抽屉入口）；画布 flex-1；左列/检查器 = bottom sheet（沿现参数抽屉先例：图层抽屉 / 层配置与检查器抽屉）；状态条导出收进「导出▾」菜单。策略切换在层配置抽屉内（胶片带横滑位废除）。层多选在移动端 = 长按进入多选模式（chips 式）。〔判断·中置信〕移动端排钻以单层调整为主，多选频次低，长按门槛合理。

### B.9 状态矩阵（八态沿用 + 四态新增）

| 态 | 触发 | 呈现 | 出口 |
|---|---|---|---|
| 空态（无图） | 进页无 handoff/无项目 | 沿用 add-project-files §3 空态；左列显示灰置位（「载入来源图后分块成层」） | 载入即走 |
| 载入解码/分块中 | handoff/上传/打开 | skeleton + 进度；层列表 skeleton | 自动 |
| 层排布中 | 配置提交/进页自动 | 层行 ◷ + 状态条进度 N/M + 画布**保留旧结果**（渐进落地平移：新层结果落地即替换） | 完成/取消 |
| 单选层 | 列表/画布隐式 | 检查器 = 该层配置 | — |
| 多选·配置相同 | 加选 | 横幅「配置相同」+ 共同值 | 编辑=写全部 |
| **多选·配置不同** | 加选 | 横幅「配置不同 · 以①层为基准」+ 锚点预填 | 编辑=写全部 |
| **隐藏层观察** | 眼睛切换 | 画布省略该层；计算/统计/导出不变（A.4 名义化契约）；状态条「含 k 隐藏层」附注 | 眼睛切回 |
| **背景层选中** | 点背景行 | 检查器 = 源 + 透明度 + 只读说明 | — |
| **历史重放中** | 撤销/重做/回跳 | 作废在途轮 → refold → 脏层重算进度 | 完成 |
| 间距违规 | 联合校验 | 红徽标 + 分层清单 + 修复写入涉事层 | 修复/接受 |
| 来源缺失 | 打开项目资产丢失 | 沿用 add-project-files §3 错误卡；左列禁用占位 | 重绑 |
| 计算失败（层级） | 单层引擎错误 | 层行 ！ + title；**其它层不受累**（错误隔离平移）；导出门按联合口径关 | 改参重试 |

### B.10 与 redesign-studio-layout / add-project-files 的继承-覆盖登记（显式覆盖声明）

| 旧契约条目 | 处置 | 说明 |
|---|---|---|
| redesign-studio-layout §1 五区拓扑（胶片带 h-14 区） | **覆盖** | → 四区 + 左列（B.1）；「画布常驻/答案常驻/主区零滚动」不变量沿用 |
| §1 「策略单真源：胶片带 chip 唯一写入点」 | **覆盖（纪律平移）** | 唯一写入点 = 选中层配置的策略字段；状态条仍只读回显（合计策略信息入 BOM/摘要） |
| §1 「对比是模式不是家具」+ CompareOverlay 规划 | **移交 P2** | 对比视图语义重立（§C.5）；StrategyFilmStrip 组件废除，其 hover 浮卡资产随 P2 重估 |
| §2 `PreviewRenderInput` 签名冻结 | **覆盖（边界纪律沿用）** | B.7；新签名冻结 + 旧 golden 等价映射迁移 |
| §2 组件拓扑（StrategyFilmStrip/CompareOverlay 行） | **作废** | 新拓扑：LayerPanel（新建）/ Inspector 改版 / StudioContextBar 瘦身 / StudioStatusBar 收窄 |
| §3 状态矩阵八态 / §4 移动端形态 / §6 验证护栏 | **沿用+扩** | B.8/B.9；真浏览器三档 viewport 硬承诺沿用（新增左列可见性断言） |
| add-project-files §1.1 gemproj 参数全集 | **覆盖（v2）** | §E.1；「永不入文件」清单扩：层可见性/背景源与透明度/层块选择/历史栈 |
| add-project-files §3 「画布/检查器/胶片带结构不变」「2.5 检查器/胶片带禁用占位」 | **覆盖** | 胶片带废除；2.x 时序裁决见 §E.3 |
| 姊妹稿 §D P0-1（检查器 physics 区 = 整图单一 baseSpec） | **覆盖（契约沿用）** | 规格宿主项目级 → 层级（specKey 引用 + 快照物化，[R1·合流缺口 1]，§A.7/§E.2） |
| 姊妹稿 §D P0-2/3/4（pairwise / BOM spec×color / SVG 多形 / declaredPhysical） | **沿用** | 全局 engine 语义；跨层联合校验正是 pairwise 升级的第一个消费者（C.3） |
| 姊妹稿 §G 议题 4（layout 五策略不动、单一 pitch） | **沿用（粒度=层）** | 每层仍以自己的规格（specKey→BaseSpec）单一 pitch 排布；跨层混合径由全层统一 pairwise 校验兜底（C.3） |

---

## §C 计算模型

### C.1 层即计算单元：computeLayer 单一入口

```
computeLayer(layer: LayerConfig, blocks: Block[], image: EngineImage,
             onResult: (r: StrategyResult) => void, run: number): ComputeHandle
```

- 输入 = 层配置快照 + 该层 effectiveBlocks（启用过滤+类型覆写，`effectiveBlocks` 派生逻辑按层重写）+ 图像；输出 = 该层单策略结果（渐进落地协议沿用：结果即落地、run 号作废迟到结果）。
- **接口冻结即 GPU 预留位**（C.6）：GPU/WebWorker/主线程 fallback 都是 `computeLayer` 内部实现细节，store 契约（快照/run/取消/渐进落地）不变。
- **[R1 推翻·议题 8/P0-3] 「默认全选 = 现状效果」在本接口上是待证契约，不是已闭合等价**：现状 `runLayouts` 是一次快照后五策略循环（每策略独立结果/错误、进度 `1+i/6`）；新模型逐层单策略改变结果缓存与进度单位——等价性必须由 §C.4 的 compatibility test（旧实现为 oracle）证明，**证明前 P0 计算切片不切实现**。
- 现 `runLayouts` 的五策略循环退役：层模型下每轮只算该层的 `strategy`（五策略并行计算随胶片带一起退役，C.5）。

### C.2 多选「同时排布」= 批量配置写入 + 逐层排队

Owner 语义拆解：「同时选中多个图层，同时进行算法排布」= ①多选层；②对锚点基准配置做一次编辑（或直接触发重算）；③所有选中层按各自配置排队计算。不存在「跨层联合布局算法」——层间几何关系由**全层统一 pairwise 后置校验**约束（C.3；[R1 推翻「互斥即不重叠」]，详见该节碰撞源全清单）。

- **脏层追踪**：配置提交（debounce/immediate 双轨沿用）标记 `dirtyLayerIds`；300ms 窗口内多次提交合并为一批。
- **调度 P0：单 worker 逐层串行**（`runCompute` module worker 沿用，逐层子轮、逐层渐进落地、逐层错误隔离）；进度聚合 `computeProgress = { done: 已完成层数, total: 脏层数, label: '层「主图案」排布中…' }`。P1：层并发（worker 池 / GPU），见 C.6。
- **取消**：`cancelCompute` 作废全部在途层轮 + 清队列（语义平移）；取消后参数改动照常触发新轮。

### C.3 跨层间距：全层统一 pairwise + exportGate 硬阻断

**[R1 推翻原断言·议题 9] 「分区互斥 ⇒ 层间钻位永不重叠、风险仅剩相邻边界间距不足」不成立。** 块分区只约束「块的归属」，不约束几何——现引擎 `validate`/`conflict`/`layout`/`relax` 均按单 pitch 设计，各层独立排布的终局完全可能在层间制造间距违规甚至物理重叠。

- **碰撞源全清单**（联合校验的敌情面，逐条覆盖）：① 相邻块边界——两层钻各贴共同块边界；② 各层独立 layout——每层用自己的 spec/gap/策略排布，层间无协调；③ 不同径 gap——层 A 大钻层 B 小钻，所需中心距不同；④ boundary-repulsion 位移——松弛把钻推出块掩码边界；⑤ 重分块归属变化——新块落 rest/显式层后与旧层产物交错；⑥ 专家工作台改层/改径/改形后回流的文档；⑦ malformed import / 重复块 / 多余 rest（parser 拒绝面之外的第二道防线）；⑧ 未来手工钻。
- **P0 = 全层结果 concat 后统一 pairwise**：唯一 helper **`requiredCenterDistancePx(a, b)`**（圆包络判据 `dist ≥ (d_i+d_j)/2 + gap`，mm→px 换算只在 helper 内发生——**单位恒 px**）+ spatial hash cell = **`maxCellPx`**（px 单位，max diameter + gap）——姊妹稿 v1.1 P0-2 契约的消费侧；3×3 邻域在 cell 取 max 后保证检索不漏，但**检索不漏 ≠ 分区结果几何合规**。**层内布局终局也跑同一 helper**（单层内五策略/relax 产物同样过 gate）。间距不足的钻**不自动剔除**，报告为违规清单（**按层对分组**：层内违规 / 层间违规）；修复动作 = 对涉事层开松弛/调密度/调 gap（B.5）。
- **exportGate = SVG/BOM/PNG/送精修共同前置（[R1·P0-2]，对齐姊妹稿 gemspec P0-2）**：联合校验存在 spacing/mask 违规 ⇒ 导出与 handoff **硬阻断**；保存允许 warning（文档可存）。测试面：大/小径混合、恰跨 cell 边界、边界 gap、旋转异形（圆包络不变性）、20k 钻、多层数×层对组合。
- **P1 = 跨层冲突消解**：后置 `enforceMinDistance` 式剔除（`dropped` 计数入层结果；「后布的让先布的」需要层序仲裁——以列表序为优先级）。〔判断·中高置信〕P0 报告制 + 硬阻断足以守住物理正确性；自动剔除跨层钻的语义争议（删谁的钻）大于收益。
- **每层独立 grid**：`gridFromSpec` 按层 specKey 派生（姊妹稿 v1.1「GridSpec = 派生几何上下文」）；联合校验/BOM/导出消费逐钻物化 GemSpecSnapshot 的 `diameterMm`（pairwise 升级的前置依赖，见 §E.2 时序）。

### C.4 「默认全选 = 现状效果」：待证契约（compatibility test，[R1 推翻·议题 8/P0-3]）

v1 稿把等价写成段落断言（「逐字段相同 ⇒ 同图同出」）——**不成立为证**：现状 `runLayouts` 是一次快照后五策略循环（每策略独立结果/错误、进度 `1+i/6`、取消即 reject 且迟到消息丢弃）；新模型逐层单策略，结果缓存、进度单位、取消路径全部换轴。**改写为待证契约**：以旧实现为 oracle 冻结 compatibility test，契约证明前 P0 计算切片不切实现。

- **逐位等价（主断言）**：单 rest 层（= 全部块）+ 同 image/blocks/grid/density/relax/seed 时，`computeLayer` 输出的 gems/warnings/dropped/id 与旧 `runLayouts` 对该 strategy 的子轮**逐位相等**（旧输出以固定 fixture 固化）。
- **全矩阵（不只钻位）**：① 结果缓存——未触碰层的结果在其它层重算期间保留可用；② 进度单位——segment 1 单位 + N 层（旧为 1 + 五策略 `1+i/6`）；③ 取消——`cancelCompute` 后在途层轮 abort、reject 身份（`ComputeAbortedError`）与迟到结果丢弃语义同旧；④ run 作废——取消后新参数触发的 run 使旧 run 的迟到结果不落地；⑤ 错误隔离——单层失败只污染该层结果（error 字段），其它层不受累；⑥ 重算期间旧结果保留（渐进落地平移——计算中画布不闪空）。
- **退役面差异（Owner 授权、显式登记，非回归）**：其余四策略的并行缓存与胶片带切换废除；策略切换从「秒切缓存」变为「切换即该层重算（渐进落地期间旧结果保持可见）」。〔判断·高置信〕该差异是 Owner 明示的方向性变更。

### C.5 策略对比的承接（胶片带对比语义去向）

多策略对比曾是核心卖点（redesign-studio-layout「对比是模式不是家具」、CompareOverlay 规划、未实现的占位按钮）。图层化后单层单策略，裁决：

1. **P0 无专门对比面**：切策略 = 检查器 Select 一下 + 该层重算（渐进落地 + 旧结果保持，缓解等待焦虑）；「计算中保留旧结果」纪律是 P0 的体验底线。
2. **P2 对比视图**：对选中层临时批量算五策略缩略卡（复用 `previewRender` 浮卡资产与「点卡=采用该策略并退出」动线）——**临时计算，不产生层、不写文档**；hover `drawPreview` 浮卡资产迁入此处或删除（**不留死 API**，renderer/test 同步处理——废除清单见 §E.6 矩阵）。
3. **否决「复制层做对比」**：破坏分区不变量（同块双份钻、幻影碰撞、BOM 翻倍），且对比后要手工清理副本。〔判断·高置信〕

### C.6 GPU：capability-labeled 预览加速器（[R1·P0-8] 接口修订；结论引自 gpu-research.md）

调研已出结论（同目录 `gpu-research.md`，2026-09-19）：**GPU 只能作为预览/交互探索加速器；落盘/导出/重放一律 CPU 引擎精算**——WGSL §15.7 明确允许浮点重结合/融合、不指定舍入模式（除法 2.5 ULP），跨设备逐位复现在规范层面不可得，与「同 seed 逐位重放」正面冲突。v1 稿的候选度表按主观印象标注（hex/poisson 标「高」等），与调研结论相反，**全部作废**，改引调研报告 §8 的标注：

| 算法/阶段 | gpuCandidate | 依据（gpu-research §） |
|---|---|---|
| segment.kmeans-assign | preview-only | §4：有成熟 WebGPU 实现，浮点不可复现 |
| segment.connected-components | future-integer | §4：GPU CCL 成熟但需整数化重写 |
| segment.distance-transform | future-integer | §4：JFA 整数化可确定，但近似 ≠ 精确 EDT |
| segment.median-color / 排序类 | none | §6：CPU 微优化即可 |
| layout.cvt（Lloyd + 修复） | **preview-only（唯一 P1 试点）** | §1/§4/§7：43s@1024² 全五策略唯一数量级热点，预估 10–30× |
| layout.poisson | none | §4：串行 RNG 语义根本冲突 |
| layout.hex-thin / hex-pitch / hybrid | none | §6：CPU 已够（54–207ms） |
| mapColors / validate | none | §4 末行 |
| 层间并行（worker 池） | 另行评估 | §8 末注：GPU 试点挂在层计算调度器之后、复用 `ComputeProgress` 上报通道 |

**接口契约（冻结，[R1·P0-8] 处置）**：

1. **capability-labeled implementation**：GPU 实现以能力位标注，不是默认路径——`computeWorker` 启动时探测 `navigator.gpu?.requestAdapter()`（DedicatedWorker 内合法），能力位上报主线程；GPU 模块一律 Worker 内动态 `import()` 懒加载（主包零增重）；生产路径原生 WebGPU 手写 WGSL（GPU.js 仅 spike 工具，640KB 且无确定性控制项）；不做 WebGL compute 后备（回退链 = WebGPU → CPU）。
2. **backend/version 记录**：每次 GPU 路径执行记录 adapter/backend 与版本（诊断面；不进入结果身份与 `ENGINE_VERSION`——后者永远描述 CPU 引擎）。
3. **同 fixture CPU/GPU 差异判定**：预览路径允许 GPU 结果与 CPU 存在差异（仅用于交互反馈，如 CVT 密度/seed 调参的即时视觉反馈）；任何进入文档/导出/重放的数据**恒为 CPU 引擎精算**（「应用/保存/导出」触发 CPU 重算——gpu-research 路线 A）。
4. **发现差异自动回退 CPU**：若某 GPU 路径声称确定性（未来整数化路线）但同 fixture 对比发现差异，自动回退 CPU 并上报诊断；**确定性优先于速度**。
5. **不改 `run`/`cancel`/`onResult` 协议**：GPU/WebWorker/主线程都是 `computeLayer` 内部实现细节，store 契约（快照/run 号作废/取消/渐进落地）零改动——§D 历史重放的确定性根基因此不动摇。

### C.7 进度 / 取消 / 与 computeProgress 的交互

- 进度聚合单位 = 层（`done/total` = segment 1 单元 + 完成层数/脏层数；label 带层名）——旧口径为 segment 1 + 五策略（`1+i/6`），单位换轴是 §C.4 compatibility test 的矩阵项之一。分块（segment）仍是全局前置单轮，沿用现有阶段态形状。
- 取消按钮：作废全部在途层轮（`cancelPending` 语义按层集合重写）；重放/换图/重分块触发时自动作废在途（§D.4）。

---

## §D 历史面板（撤销 = 重放，结果不记录）

### D.1 重放模型

```
fold(baseSnapshot, ops[]) → { state, diagnostics }   // [R1 收紧·P0-6] 纯函数返回值带确定性诊断流
// baseSnapshot = 进页/打开文件时的参数态（层结构/配置/色板/分块参数；不含任何结果）
undo = 截断末位 op → refold → 脏层差分 → 重算
redo = 重附 op → refold → 重算
```

- **结果永不入栈**（Owner 明示「不记录结果，所以每次都会重新计算」）：ops 只含参数/结构变更；refold 后与当前态做层配置差分，只有配置变化的层进入重算（未触碰层的结果缓存继续有效——重算成本被差分收窄）。
- **diagnostics 契约（[R1 收紧·P0-6]）**：diagnostics 为按稳定 code/path 排序的只读记录（如 `{code:'stale-block-ref', opIndex, blockId}`）。stale op **不删除、不重写为有效操作**——「重放确定」= 参数确定 + 诊断可查的用户可解释确定，不是静默吞操作后的表面确定。
- **确定性根基**：引擎 seeded 确定性（`LAYOUT_SEED`/`segSeed`）+ 纯 fold ⇒ 同一 op 流必得同参数态。`ENGINE_VERSION` 漂移 ⇒ 重放结果可能漂移（横幅诚实性纪律沿用，add-project-files §1.1）。
- **历史栈永不序列化**（gemdoc「撤销栈永不序列化」纪律平移）：gemproj 存 fold 终态（层/配置/色板/分块），不存 op 流；打开文件 = 新 base、历史清空。

### D.2 操作清单（什么算一个操作）

```ts
type StudioOp =
  | { t:'layer.create',  name, seedConfig }                       // 空层 / 移入新层（含块集）
  | { t:'layer.delete',  layerId }                                // 兜底层不可删（UI 已挡）
  | { t:'layer.merge',   intoLayerId, fromLayerIds[] }            // 配置取锚点（重放时同样成立）
  | { t:'layer.rename',  layerId, name }
  | { t:'layer.moveBlocks', blockIds[], toLayerId }
  | { t:'layer.config',  layerIds[], patch, prev[] }              // 策略/物理/密度/松弛/spec；多选批量 = 单 op 多层
  | { t:'block.override', patch（按 blockId 的 density/type/color/enabled）}
  | { t:'palette.edit',  upsert|remove|add }
  | { t:'segment.opts',  { k, seed } }                            // 重分块（破坏性：层归属重置进重放语义）
```

- **合并规则**：同一目标 + 同一字段的连续滑杆提交（300ms debounce 窗口链）合并为一个 op（`groupId`，面板显示为一行）——`CommitOpts` 提交边界即 op 边界。多选批量编辑 = 一个 op（撤销一次恢复全部选中层原值）。
- **不入历史**（瞬态，与「不入档」清单同源）：层选择/块选择、层可见性、背景源与透明度、取景、hover、进度与取消。换图/参考图变更不入历史（换图 = 新 base 的会话级重置，守卫走 add-project-files §3 破坏性三按钮，沿用）。
- **失效容错（[R1 收紧·议题 15/P0-6]）**：`segment.opts` 之后的块引用 op 在 refold 中可能指向已死块 id（例如撤销路径上的中间态）——apply 时进 `{state, diagnostics}`（stale 诊断条目，稳定 code/path 排序），历史面板**只读灰显「已失效」，不删除 op、不重写为有效操作**（v1 稿「容错为 no-op」措辞作废——静默 no-op 会让重放「看似确定」但语义已丢）。撤销 `segment.opts` 本身 = 回到旧 k/seed → 引擎确定性重生成旧块 id → 后续 op 重新有效、对应诊断条目消失。〔判断·高置信〕这是重放模型对「重分块破坏性」的最优解：不设历史屏障，撤销可自由跨越重分块。**属性测试**：同 base + 同 ops 流 ⇒ 同 state **且同 diagnostics**（跨重分块 undo/redo 路径全覆盖；撤销后新操作清 redo 一并断言）。

### D.3 上限与压实

- 上限 **100 组**（`UNDO_GROUP_BUDGET=100` 先例）；新操作清空 redo（标准语义）。
- **压实（compaction，[R1 收紧·P0-6]）**：超限时把最旧 ops fold 进 `baseSnapshot`；**压实必须记录被压实的 op 边界（起止 index）与压实后 baseSnapshot 的 state hash**——undo/redo 跨压实边界的等价性可验证（同 op 流在压实前后折出同 state）。参数态轻量（层配置 + 覆写记录 + 色板，KB 级），压实廉价；**结果不参与**（永不存档，重放纪律不动摇——重放不记结果是 fold 身份的排除项）。

### D.4 与 computeProgress / 取消 / 重分块的交互

- 撤销/重做/历史回跳触发时：先作废在途层轮（`cancelPending` 按层集合），再 refold，再差分重算——进度徽标表达「重放中 → N/M 层重算」。
- 重分块 op（`segment.opts`）在重放链中 = 一次全局 segment 重跑（分块是全局单轮，C.7）+ 层归属重置（新块落兜底层）。
- 历史回跳（点面板中任意条目 = truncate 到该处）= 多次 undo 的原子化，实现同源，P1 开放（P0 = 步进 + 面板可视化）。

### D.5 面板 UI 与位置

- 左列 tab 2「历史」：倒序列表（最新在上），每行 = 图标 + 摘要（「层·主图案 → 策略 改为泊松盘」「移入 3 块 → 轮廓线」）+ 组合并展示；顶部撤销/重做按钮 + 深度计数（`getUndoDepths` 形状沿用精神）。
- 位置裁决：左列双 tab（图层|历史）——结构（图层）与时间（历史）同居左列，检查器保持纯属性宿主；状态条不设撤销位（Owner：底部只剩统计与导出）。〔判断·中高置信〕议题 11 备案。**[R1 收紧·议题 11] 快捷键与面板语义冻结**：Ctrl/Cmd-Z / Shift-Cmd-Z 与面板按钮**同源**（同一 reducer 入口）；面板条目点击跳转 = truncate 回跳（与多次 undo 原子同源，P1）；跨 tab（图层⇄历史）focus 不丢层选择；空历史态显式空状态（非空白面板）。
- 与 edit 页撤销栈的关系：机制同族（组预算/清 redo/不入档），但 edit 是**快照差分栈**（`UndoGroup` 逆操作），studio 是**命令重放**——不强行共用实现；共用的是纪律（预算/瞬态排除/永不序列化）。〔判断〕重放模型的代价（每次全 refold + 差分重算）在参数态轻量的 studio 是划算的，在钻位重Thousands 的 edit 是灾难——分道是正确的。

---

## §E 与 GemSpec / add-project-files 的合流

### E.1 gemproj v2 schema（PM 立场草案，契约 gate 冻结）

```ts
interface GemprojFileV2 {
  kind: 'gemproj'; formatVersion: 2
  appVersion; engineVersion; createdAt; savedAt; name
  source: GemprojSource                          // 沿用 v1 双形态（asset/embedded），不动
  segment: { k: number; seed: number }           // 全局（整图分块）
  layers: LayerRecord[]                          // ≥1；恰一层 blockIds='rest'
  palette: Palette                               // 项目级
  reference?: { assetId: string; name: string }  // 沿用
}
interface LayerRecord {
  id: string; name: string
  blockIds: string[] | 'rest'                    // 恰一层 'rest'；显式层 blockIds 去重（重复块 = parser 拒收）
  strategy: StrategyId
  physics: { specKey; gapMm; density; relax }    // [R1·合流缺口 1] canonical specKey（快照是否内联随 v2 contract gate 冻结回填，§I.4）
  overrides: { disabled; density; type; color }  // 仅本层块 id
}
// 永不入文件：perLayerResults、层可见性、背景源与透明度、层/块选择、历史栈
```

- **v1→v2 迁移（纯函数）**：`layers = [{ id:'L1', name:'图层 1', blockIds:'rest', strategy: old.activeStrategy, physics:{ specKey: round-<old.ss>（SS_TABLE 派生 canonical 键）, gapMm, density: old.globalDensity, relax }, overrides: old.overrides }]`——[R1 纠偏·议题 2] **v1 的 `overrides` 四表键本就是引擎块 id**（〔源码〕`projectFile.ts` `GemprojFile.overrides` 头注「键 = 引擎块 id」；gemprojReplay 悬空键清点同证），v1 稿「v1 文件不存块 id」是**事实错误**。`rest` 哨兵的决定性价值重述 = **迁移无需重跑分块**：块归属交给打开后的重放解析（rest 兜底接住全部新块），迁移函数不必替每层显式列块 id（那将迫使迁移跑 segment，纯函数性破灭）。round-trip 字节等价测试纪律沿用（add-project-files §1.3）。
- **打开/重放时的悬空覆写清理**：分块完成后**逐层**执行 `pruneStaleOverrides`（按层），未知键（不属于任何新块 id）删除并**计数提示**（「N 项块覆写失效已移除」横幅——add-project-files 2.2 同口径）；v1 迁移进来的单层 overrides 同样过此清理。
- **parser 拒绝面（分区不变量的序列化侧守卫，[R1·议题 1/2]）**：恰一 `rest`（零/多 rest = typed error 拒收）；显式层 `blockIds` 重复 = 拒收；跨层重复块 = 拒收；未知块 id 不在打开时拒收（分块后 prune + 计数），但**计数必须暴露**（诊断可见，不静默）。
- `activeStrategy` / `physics` / `overrides` 三键从 v1 顶层消失（分别化入 layers[].strategy / physics / overrides）。

### E.2 与 GemSpec（姊妹稿）的合流：一次 bump（PM 立场）

- **冲突点与合流裁决（[R1·合流缺口 1/2]）**：姊妹稿 §D P0-1 的「整图单一 baseSpec」被本轮覆盖为**规格 per layer**；姊妹稿 **v1.1** 已冻结的契约直接消费、不另立：`BaseSpec{shapeId,sizeLabel,diameterMm,widthMm?,heightMm?,assetId?}`、`GemSpecSnapshot{specKey,ordinal,…}`、`GridSpec = 由 BaseSpec 派生的几何上下文`（`gridFromSs` 降位圆钻特例）。**层配置引用 canonical `specKey`；每个输出/编辑钻物化不可变 `GemSpecSnapshot`（含 widthMm/heightMm/assetId，逐钻另有 rotationDeg）**——BOM 键 = specKey×colorId（canonical，不由显示码/浮点径反推）、SVG 逐钻按快照渲染、四格式迁移以快照身份（§A.7）。**物理锚（合流缺口 2）**：`PhysicalCanvas{widthMm,heightMm,anchorSource}` 贯通 gemgen → handoff → gemdoc/replay，`pixelsPerMm = 实际降采样 canvas 宽 ÷ widthMm`（gemprojReplay/quickLayout 的 2.5 常量收编 engine 单一出口）——本稿只消费不重定义。
- **PM 立场：formatVersion 一次 bump（v2 同时携带 GemSpec 字段 + layers[]）**。理由：两者都尚未开工（姊妹稿裁决「等 add-project-files 归档后启动」）、都改 `physics` 宿主——分两次 bump = physics 字段搬家两次 + 迁移链两截 + gemproj schema 连续 churn。反对案（两次 bump，每次独立验证迁移）在「同波次、同一人实现、round-trip 测试齐备」前提下收益不抵成本。〔判断·高置信〕
- **切片依赖序（[R1 收紧] 以五段合流门序为准，§E.7）**：v2 contract gate（BaseSpec/GemSpecSnapshot/PhysicalCanvas/四格式版本迁移/.gemshape gate）→ engine gate（pairwise helper/mixed-size validate·conflict·exportGate/SVG·BOM 逐钻 spec/CPU deterministic oracle）→ replay/handoff gate → studio gate（图层 store/UI 在此落）→ add-project-files 归档同步。**跨层联合校验（C.3）以 engine gate 的 pairwise helper 为硬前置**。
- 姊妹稿 §G 议题 4（layout 单一 pitch 不动）在图层模型下**仍成立且粒度细化**：每层一个规格单一 pitch；跨层混合径布局（多径嵌套六方）维持 P1+ 研究级定位。

### E.3 add-project-files 2.x 的时序裁决（移交；[R1 收紧·P0-5/议题 7] 落法改写）

- **PM 立场（维持）：2.x（studio store 项目态/打开链路/上下文条重写/空态守卫）整体移交本重构 change，以 v2 schema 直接实现**。理由：2.x 尚未实现（〔源码〕tasks.md 2.1–2.7 全未勾选）；若先按 v1 落地（2.1 序列化挂接 `physics/overrides/activeStrategy` 顶层键），本重构立即重写同一批序列化/打开代码并追加 v1→v2 迁移——纯浪费轮次。且 2.3「上下文条重写」与本轮 B.4 瘦身是同一次重写，分两轮必然打架。
- **[R1 收紧] 移交不能只在本文档声明——必须在 add-project-files 归档前同步修改其 design/spec/tasks**（只在 PM 稿登记 = 两套真源断链）：
  1. **design/spec 同步修改**：删除/改写 2.1–2.5 的旧 v1 条款（「参数集零改动」「复用既有重放」等表述对 v2 失效），登记「2.1–2.5 移交 studio-layers change」（「修文对齐」先例）；
  2. **tasks DAG**：2.1–2.5 五片（序列化挂接/打开重放/上下文条重写/导出双路径/空态与禁用占位——2.4 的 serializeGemproj 与 buildManualEditHandoff 均随层模型改写）标注移交与 v2 口径；**2.6 守卫三分法/2.7 全局导入留原 change**，但其依赖边必须显式登记：2.6 依赖新 Studio dirty 触发全集（一切 StudioOp：图层结构/配置/覆写/色板/分块）、2.7 依赖四格式 parser（含 v2 gemproj layers）与 openIntent 路由；
  3. **新增验收条款**（原 change 缺，随移交补入）：handoff（层模型 `buildManualEditHandoff`）round-trip、gemprojReplay v2（layers[] 消费，P0-4）、asset pin（openProject pin source/reference assetId——机制归原 change 1.3，layers/replay 消费面登记依赖边）；
  4. **时序**：遵五段合流门序（§E.7）——2.x serializer 直接消费 v2 contract gate 产物，v1 不成为写入真源（姊妹稿 v1.1 P0-5 同裁）。
- 守卫/dirty 语义沿用 add-project-files §3 冻结：切 Tab 不弹、beforeunload、三按钮；**dirty 触发全集扩编**：图层结构/配置/覆写/色板/分块变更（即一切 StudioOp）。

### E.4 PRODUCT_MODEL v4 / TERMS v2 联动

- 对象树：`排钻设计 · 项目（.gemproj）= 参数工程（来源 + 分块参数 + 图层[] + 色板）`；图层行新增：`排钻设计 · 图层 = 块集分区容器（策略/物理/覆写随层走）`。
- 单一真源表改两行、增一行：「排钻策略选择」真源从「胶片带/对比模式选中项」→ **「图层配置字段（检查器层配置卡）」**；新增「图层结构与配置 | studio store layers（→ .gemproj layers[]）| 左侧图层面板」。
- TERMS 新词条：**图层**（排钻设计中块的命名分组与独立排布配置容器；禁用词：分组、分区）、**背景层**（承载数字油画/参考原图的特殊图层，不参与排布；禁用词：底图层）、**历史**（排钻设计的操作记录与撤销重放面板；禁用词：撤销历史、操作日志）。「物理」词条需要消歧注记：层物理（spec/gap/密度/松弛）vs 整图物理（pixelsPerMm/画幅）——§H 摩擦 6。[R1·合流缺口 10/非阻塞建议] 「层参数」与「画幅物理锚」在 PRODUCT_MODEL/TERMS **分词**；**gemproj 会话观察态 vs gemdoc 文档态**的差异在 UI 文案、导出说明与跨设备提示中一致呈现（A.4），并在保存/打开测试中断言（打开工程恢复默认观察态 + 提示）。

### E.5 下游影响（导出 / 送精修 / BOM / 文件名 / gemprojReplay）

- **导出**：SVG/BOM/PNG 消费**全部层结果的并集**（含隐藏层，A.4 名义化契约）；BOM 聚合键 = **canonical `specKey × colorId`**（[R1·合流缺口 1] 姊妹稿 v1.1 口径，层间同规格自然合并；不由显示码反推）；SVG 多形渲染按逐钻物化 GemSpecSnapshot。**导出门 = `exportGate`（全层 concat 统一 pairwise，C.3）——SVG/BOM/PNG/送精修共同前置，违规硬阻断**（[R1·P0-2] 对齐姊妹稿 gemspec P0-2：保存允许 warning、导出必须阻断）。
- **送精修**：`buildManualEditHandoff` 载荷**随层模型改写**（[R1·P0-4/合流缺口 4] 收紧 v1 稿「载荷形状零变化」表述——现实现只复制 `activeResult` + 单 `grid`，不满足层模型）：`gems` = 各层 concat、每钻物化 GemSpecSnapshot（含 widthMm/heightMm/assetId + 逐钻 rotationDeg）；`blocks` = 各层 effectiveBlocks 并集；`grid` → 参考网格 + 逐钻 spec 字段（姊妹稿 v1.1 A.2）；**+ `physicalCanvas`（PhysicalCanvas）随载荷贯通**（合流缺口 2）；`sourceSummary` = `N 层 · 共 X 钻 · 主规格 …`（原「策略 · 密度」单值语法失效）。round-trip/identity 测试归 replay/handoff gate（§E.7 门序 3）。
- **[R1·P0-4/合流缺口 3] `gemprojReplay` 登记为 `layers[]` 必改消费者**：现实现（`gemprojReplay.ts`）按整图 v1 重放（消费 `file.physics`/`file.overrides`/`file.activeStrategy`，单策略）——打开 v2 .gemproj 会丢层配置。**v2 replay 链冻结（六步）**：
  1. segment 一次（全局单轮，k/seed）；
  2. 解析唯一 rest + 显式层 → 各层成员（rest = 分块结果 − 显式层并集）；
  3. 每层派生 effectiveBlocks（disabled/type 过滤）/density（层 density + 块覆写两级回落）/grid（`gridFromSpec` 按层 specKey）；
  4. 逐层 `computeLayer`（同 seed 纪律）；
  5. 全层 concat → 统一 pairwise / `exportGate`；
  6. handoff/结果携带逐钻 spec（GemSpecSnapshot）与 PhysicalCanvas（`pixelsPerMm = 实际降采样 canvas 宽 ÷ widthMm`，dimsMismatch 以实测为准）。

  **验收测试**：v1 fixture 迁移为 v2 后，与旧 replay 输出**相等**（单 rest 层 ⇔ 旧整图单策略：钻位/颜色/悬空清点逐位对照）。
- **导出文件名（[R1·议题 14 支持 + 收紧]）**：`${baseName}.${ext}`——去掉 `-${activeStrategy}` 后缀（现 `exportFileName` 强绑 activeStrategy，层模型无单一主策略）；**覆盖行为测试冻结**：同名下载的浏览器覆盖行为、PNG 入库命名与下载测试一并冻结（不以「去后缀」结案）；层/策略信息移入导出摘要。
- **统计**：`共 N 钻 = Σ 层钻数`；层行钻数 = 该层结果计数（无结果/空层 = 0/空）。

### E.6 消费面迁移矩阵（[R1·P0-7]：旧符号 → 新入口 → 测试责任）

R1 指出稿件只登记了五区与签名的名义覆盖，未给每个调用方的迁移/测试责任。本矩阵是放行前置——**矩阵缺项不得进入实现切片**：

| 旧符号（〔源码〕） | 新入口 | 测试责任 |
|---|---|---|
| `PreviewRenderInput{result,grid,mode,overlayOpacity}`（`previewRender.ts`） | B.7 冻结新签名（background/layers/逐钻形状） | 旧 golden 等价映射迁移（逐字节相等）+ 新签名基准重立 |
| `StrategyFilmStrip` 组件 + `setActiveStrategy` 唯一写入点 + `results` 五策略缓存 + hover `drawPreview` 浮卡 | 检查器策略 Select（层配置字段）；hover 浮卡资产迁 P2 CompareOverlay 或删除（**不留死 API**——renderer/test 同步处理） | 五策略废除断言、交互测试更新、死 API grep 清零 |
| `blockIndexAt` 逐像素精确命中（`BlockCanvas`） | 列表/键盘 P0 兜底 + P1 距离场容差（B.6） | 边界块/被钻覆盖/缩放档位/空白点击四类 |
| `StudioStatusBar`（按 active result 统计） | 全层联合统计 + 「含 k 隐藏层」+ 联合校验徽标 | 统计口径（含隐藏层）测试 |
| `buildActiveSvg/buildActiveBom`（单 `LayoutResult` + 单 `GridSpec`） | 全层 concat + 逐钻 spec + `exportGate` 前置 | 多层导出、违规阻断、BOM specKey×color |
| `buildManualEditHandoff`（`activeResult` + 单 grid） | 各层 concat + 逐钻 GemSpecSnapshot + PhysicalCanvas + 层语法 sourceSummary（E.5） | handoff round-trip/identity |
| `gemprojReplay.ts`（整图 v1 replay） | v2 逐层 replay 六步链（E.5/P0-4） | v1 fixture 迁移后与旧 replay 相等 |
| `exportFileName`（`-${activeStrategy}` 后缀） | `${baseName}.${ext}` | 同名覆盖/PNG 入库命名/下载行为冻结 |
| `runLayouts` 五策略循环（store 调度） | `computeLayer` 逐层调度（C.1/C.2） | §C.4 compatibility test 全矩阵 |
| asset pin/lease（add-project-files 1.3 `openProject/closeProject/updateProjectAsset`） | 机制沿用原 change；layers/replay 消费面登记依赖边（打开 pin source/reference、关闭放行） | pin 期间软删/硬清被拒、关闭后放行 + layers 消费断言 |
| `.gemdoc` 烘焙（`serializeGemdoc` + 四层文档态） | gemdoc 层模型（文档态显隐）与 gemproj 观察态分界（A.4） | 文档态/工程态双套保存打开测试 |
| `ManualEditHandoff`/`EditDocument`/编辑器工具状态（add-manual-edit-mode §3） | handoff 扩展消费（逐钻 spec/PhysicalCanvas）；工具表被 B.4 覆盖处同步登记（含 add-manual-edit-mode §3 画布/笔刷/spacing 入口） | round-trip + 工具行为回归 |
| `PIXELS_PER_MM`/`SEGMENT_GEM_DIAMETER_PX`/`minAreaFor` 三处重复常量 | 收编 engine/physical helper 单一出口（R1 非阻塞建议，gpu-research §7-P0 同向） | 常量单源断言（replay/quickLayout/studio 同值） |

### E.7 两稿合流矩阵（[R1 §4] 十条缺口 + 五段合流门序）

| # | 缺口（R1 命名） | 落档裁决 | 位置 |
|---|---|---|---|
| 1 | 规格模型 | 层配置引用 canonical `specKey`；输出/编辑钻物化 `GemSpecSnapshot`（widthMm/heightMm/assetId + 逐钻 rotationDeg）；GridSpec 从 BaseSpec 派生统一入口；BOM/SVG/迁移以快照身份，不由浮点径/显示 ordinal 反推 | §A.7、§E.2 |
| 2 | 物理锚 | `PhysicalCanvas` 贯通 gemgen→handoff→gemdoc/replay；锚定**实际降采样 canvas 宽**（dimsMismatch 以实测为准）；2.5 三副本收编 engine 单一出口 | §E.2（消费姊妹稿 v1.1 §A.3）、§E.5 |
| 3 | 重放消费 | `gemprojReplay` = `layers[]` 必改消费者（v2 六步链 + v1 fixture 相等测试） | §E.5 |
| 4 | 导出/交接 | `buildActiveSvg/Bom`/`buildManualEditHandoff` 全层接线 + BOM specKey×color + `exportGate` 共同前置 | §E.5、§C.3 |
| 5 | 预览契约 | `PreviewRenderInput` 新签名冻结（层序/visible/选中 alpha/背景特殊层/逐钻形状）+ 旧 golden 迁移 | §B.7 |
| 6 | 资产库与生命周期 | gemproj 打开 pin source/reference、保存 CAS/lease 依赖入 DAG；`openProject/closeProject/updateProjectAsset` + dirty 触发全集 + ManualEditHandoff/EditDocument/编辑器工具登记 | §E.3、§E.6 |
| 7 | add-project-files 边界 | 归档前同步修改 design/spec/tasks：删旧 v1 条款、2.6/2.7 补 dirty/lease/导入依赖 DAG、迁移记录与 tasks DAG | §E.3 |
| 8 | `.gemshape` 缺口 | schema gate（姊妹稿 v1.1 P0-6 六条：解码校验/上限/alpha bounds/fit 语义/校准悬空/missing typed）纳入门序第 1 段前置 | §E.7 门序 1（引用，不在本 change 重复定义） |
| 9 | GPU/确定性 | capability-labeled + backend/version + 同 fixture 差异判定 + 自动回退 CPU + CPU deterministic oracle；GPU 仅预览、落盘恒 CPU | §C.6 |
| 10 | 观察态边界 | gemproj 不入观察态 vs gemdoc 入四层文档态：PRODUCT_MODEL/TERMS、preview、保存/打开测试显式说明 + 打开恢复默认观察态提示 | §A.4、§E.4 |

**五段合流门序（三 change 进入实现切片的唯一顺序，R1 §4 原文）**：

1. **v2 contract gate**：`BaseSpec`、`GemSpecSnapshot`、`PhysicalCanvas`、四格式版本/迁移、`.gemshape` parser 及错误形态；
2. **engine gate**：pairwise helper、mixed-size validate/conflict/`exportGate`、SVG/BOM 逐钻 spec、CPU deterministic oracle；
3. **replay/handoff gate**：`gemprojReplay` layers[]、联合结果、物理锚、ManualEditHandoff/EditDocument/gemdoc round-trip；
4. **studio gate**：Layer reducer/rest/reblock、`computeLayer` compatibility、history fold/compaction、`PreviewRenderInput` 与所有消费面（§E.6 矩阵）；
5. **add-project-files 归档同步**：原 change 的 2.1–2.5 旧 v1 文字删除，2.6/2.7 依赖补齐，导入/资产 pin/CAS 测试纳入责任矩阵。

---

## §F 记分卡（本设计稿自评）

```
Product coherence:   9/10  图层进入对象树/真源表（策略真源宿主迁移显式登记）；与 GemSpec/add-project-files 的冲突全部显式覆盖并给合流时序
Journey continuity:  8/10  进页=现状效果等价论证闭合；多选→基准→批量写→逐层反馈链完整；
                          策略对比旅程降级为 P2（Owner 授权方向），P0「切策略即重算」的等待焦虑靠渐进落地缓解——留走查验证
IA integrity:        9/10  策略/物理单真源（层配置字段）；观察态与文档态分界清晰（含 gemdoc 差异显式登记）；兜底层哨兵消除「默认层」歧义
Interaction clarity: 8/10  混合配置「配置不同+锚点基准」语义确定；两级选择（层/块）边界清楚；锚点徽标①②③需走查确认可发现性
State visibility:    9/10  层行状态点（计算中/待重算/失败/空）+ 状态条聚合进度 + 违规按层分组 + 「k 层隐藏」附注
Visual quality:      —     本文不评（无视觉产出；透明度三分与合成序是语义契约，非视觉 token）
VERDICT: SHIP（作为 PM 立场稿；§G 议表 Codex 裁决前对应切片不实现）
发布会截图测试: 能——「左侧图层列表选中『主图案』层（①②③多选徽标、其余层 80% 退隐），检查器显示
              『3 层配置不同 · 以①主图案为基准』+ 策略下拉 + SS 规格」——一图讲清图层化+批量排布两大新能力。
```

> v1.1 注：上表为 v1 自评存档。Codex R1 复核 **4.9/10 NEEDS-WORK**（§I）——其中「Journey continuity」的「进页=现状效果等价论证闭合」已被 [R1·议题 8] 推翻为**待证契约**（§C.4），「Product coherence」的迁移论证含 [R1·议题 2] 事实纠偏（§E.1）；放行以 §I.3 放行条件为准，自评不作为实现基线凭据。

---

## §G 给 Codex 的议题清单（附 PM 立场；v1 存档 + [R1] 裁决标注）

> v1.1 注：R1 已裁决（§I.1）。本表 PM 立场为 v1 存档，被推翻/收紧/纠偏处以 [R1] 标注并给出 v1.1 立场；终局以 §I 为准。

| # | 议题 | PM 立场 | 备选/反对案 |
|---|---|---|---|
| 1 | 图层内容单元 | [R1 支持·边界收紧] 块集分区（分区不变量；引擎零新概念）；掩码/自由绘制区 P2+ 作成员类型扩展——R1 补冻结成员不变量（启用块恰属一层、背景层不入计算）与导入拒绝面（重复块/未知块/多 rest） | 自由绘制区进 P0（反对：引擎新几何原语 + 工具集，阻塞 Owner 列点兑现） |
| 2 | 兜底层 `'rest'` 哨兵 | [R1 纠偏论证措辞] 采用：恰一层持有；新块自动落入；价值 = **避免为迁移重跑分块**（非「v1 不存块 id」——v1 overrides 四表键即引擎块 id）；补悬空覆写清理 + 未知键计数提示（§E.1） | 显式 blockIds 全量清单（反对：迁移需跑分块，纯函数性破灭；重分块重置需特判） |
| 3 | 重分块后层归属 | [R1 支持·需定义回退] 新块落兜底层；显式层置空保留配置；`segment.opts` 原子 op；旧 override 计数/提示；撤销回旧 k/seed 由 op 流重建（属性测试，§A.2/§D.2） | 按代表色启发式迁移（P1 opt-in 增强，不作默认——错迁比空层更难察觉） |
| 4 | 隐藏层与导出/统计口径 | [R1 支持·须改名义] 全设计口径**名义化**：「隐藏仍计算/统计/导出」为显式命名语义 + 状态条「含 k 隐藏层」+ 只导出可见层须另设显式命令（§A.4） | WYSIWYG 口径（反对：隐藏是观察手段，导出随之缺层 = 暗数据损失） |
| 5 | 观察态是否入 gemproj | [R1 支持·补跨设备取舍] 不入（会话瞬态）；打开恢复默认观察态并提示；gemdoc 文档态差异显式登记；PreviewRenderInput 改版须有旧 golden（§A.4/§B.7） | 跟随 gemdoc 先例入档（一致性论；代价：换设备丢观察态的抱怨换为文件噪声） |
| 6 | formatVersion bump 策略 | [R1 支持·前置 gate] 与 GemSpec 一次 bump（v2 同携 layers[] + specKey）；v2 contract gate 先于 add-project-files 2.x（§E.2/§E.7 门序 1） | 分两次（反对：physics 宿主搬两次家、迁移链两截） |
| 7 | add-project-files 2.x 时序 | [R1 支持原则·反对原移交落法] 2.1–2.5 移交本 change 以 v2 直接实现——**必须在归档前同步修改原 change 的 design/spec/tasks**（删旧 v1 条款、2.6/2.7 补 dirty/lease/导入依赖 DAG、补验收条款），不能只在本文档声明（§E.3） | 原 change 按 v1 落地再迁移（反对：同一批序列化代码写两遍） |
| 8 | P0 计算调度 | [R1 支持串行·推翻「已等价」] 单 worker 逐层串行（渐进落地/错误隔离平移）；「默认全选=现状效果」改**待证契约**——compatibility test 全矩阵，证明前不切 P0（§C.1/§C.4） | P0 即并发（反对：取消/作废语义复杂化先行，收益未证实） |
| 9 | 跨层间距 P0 | [R1 推翻「分区互斥=永不重叠/仅边界风险」] 全层 concat 统一 pairwise（唯一 helper + maxCellPx，px 单位）+ 碰撞源全清单（八源）+ exportGate 共同前置硬阻断（§C.3） | P0 即跨层 enforceMinDistance 剔除（反对：删谁的钻语义争议 > 收益） |
| 10 | 策略对比承接 | [R1 支持方向·需消费面清单] P0 无对比面（切策略即重算 + 渐进落地）；P2 对比视图（临时算不落层）；废除清单落 §E.6（组件/API/hover drawPreview/文件名/交互测试） | 层复制对比（反对：破坏分区 + 幻影碰撞 + BOM 翻倍）；保留胶片带（反对：Owner 明示废除） |
| 11 | 历史面板位置 | [R1 支持·检查快捷键] 左列双 tab（图层\|历史）+ ⌘Z/⌘⇧Z 与按钮同源；冻结面板跳转回放、跨 tab focus、空历史态（§D.5） | 状态条或检查器内（反对：Owner 明示底部只剩统计+导出；检查器是属性宿主不该长历史） |
| 12 | 混合配置字段形态 | [R1 支持·冻结提交语义] 预填锚点值 + 「配置不同 · 以①层为基准」横幅；字段级 mixed detector；批量写入 = 单 op；测试面冻结（§A.5） | 真空白占位、聚焦才显默认（Owner「滞空」字面解；代价：每次编辑多一次点击/猜值） |
| 13 | 画布命中容差修复 | [R1 收紧·升为 P1 入口验收门] 列表/键盘 P0 兜底；最近块/距离场容差 = **P1 硬门**（边界/覆盖/缩放/空白四类测试）；Owner 走查若视画布为主路径则升 P0（§B.6/§I.4） | 升 P0（待 Owner 走查裁决，未决） |
| 14 | 导出文件名 | [R1 支持] `${baseName}.${ext}` 去 activeStrategy 后缀 + **覆盖行为测试冻结**（同名覆盖/PNG 入库命名/下载测试，§E.5） | 主策略后缀（反对：层模型下「主策略」无定义） |
| 15 | 撤销跨重分块 | [R1 支持·限制容错] `fold(base,ops) → {state, diagnostics}`；stale op 只读灰显入诊断、不重写；压实记 state hash 与 op 边界；跨重分块撤销属性测试（同 base+ops ⇒ 同 state+diagnostics）（§D.1–D.3） | 历史屏障（重分块后不可再撤销；反对：重放模型本可优雅跨越，屏障是自废武功） |
| 16 | 移动端图层面板 | [R1 支持·沿现有 sheet 语义] bottom sheet 同构宿主（现参数抽屉先例）+ 长按多选/短点单选/Esc 与拖动关闭不丢选择；层数 1/几十层测试（§B.8） | 横滑 chips 层条（反对：层是容器不是模式切换，chips 语义错位） |

---

## §H 摩擦反馈（一手文件/源码的不清晰与不适配处）

1. **「CVT 点画」名实差未发生**：任务书预警 Owner 列名可能与源码有出入——实测 `computeCore.ts STRATEGY_LABELS.cvt = 'CVT 点画'`，与 Owner 列举逐字一致，映射 1:1，零修正。任务书的预警措辞（「现仓库五策略为…+一策略」）反而与源码五中文名清单不完全同形，建议后续任务书直接引用 `STRATEGY_LABELS` 快照避免二次转写失真。
2. **studio.svelte.ts 已 1092 行、模块级 `$state` 单文件**：图层 + 历史重放 + 逐层计算队列入内必爆「Orthogonal intents (max 5)」头注纪律。建议本 change 把 store 拆为 `studio/layers` / `studio/history` / `studio/computeQueue` 子模块（`edit.svelte.ts` 已是同量级单文件，同样接近极限）——否则 intents 头注将名存实亡。
3. **冻结签名缺乏「解冻流程」**：redesign-studio-layout 将 `PreviewRenderInput` 签名为 Codex-R1 冻结契约，本轮必须演进（B.7）。openspec 对「冻结面被后续 change 覆盖」只有事实登记（覆盖声明表），没有流程化机制（谁批准、基准测试如何重立）。本文以「边界纪律沿用 + 基准同步重立」自律，建议 openspec 增补覆盖声明标准动作。
4. **未归档 change 的二次覆盖已三例**：add-manual-edit-mode（被姊妹稿覆盖笔刷行）、add-project-files §3「胶片带结构不变」（被本轮覆盖）、redesign-studio-layout（被本轮覆盖五区拓扑）。「未实现先被覆盖」说明规划波次快于归档节奏——建议归档前增加一次「规划漂移核对」轻量门，避免 specs 同步积压。
5. **Owner 用语内部张力**：「属性面板的值都滞空」与「（提供默认值）」字面矛盾——本文解构为「不显示混合值 + 预填锚点基准值」（§A.5，议题 12 备选字面解）。建议 Owner 复核该条解构。
6. **「物理」词汇在图层模型下分裂**：层物理（spec（specKey→BaseSpec）/gap/密度/松弛）vs 整图物理（pixelsPerMm/declaredPhysical 画幅）。TERMS 需要消歧词条（E.4），否则 UI 文案与检查器分组将混用两个「物理」。姊妹稿 §A.3 已埋下整图物理概念，两稿合流时建议统一命名（如「层参数」vs「画幅」）。
7. **previewMode 收编后 hover 浮卡失去宿主语义**：StrategyFilmStrip 废除后，`drawPreview` 的浮卡消费方只剩 P2 对比视图——`previewRender.ts` 在 P0 期间的主消费方变为画布/导出预览。签名演进（B.7）应一次到位（背景源+层可见度+层透明度），避免 P2 再改一次。[R1·议题 10 收紧：浮卡资产迁 P2 或删除，不留死 API——废除清单见 §E.6]
8. **[R1 后新增] add-project-files tasks 2.1–2.7 当前全部未实现（〔源码〕勾选状态）**：移交裁决（§E.3）的事实前提；若归档前任何 2.x 被实现，移交面与 v2 contract gate 时序需重核（姊妹稿 v1.1 §I.5-2 的 Owner 拍板项与此联动）。

---

## §I Codex R1 落档（v1.1 处置记录）

> 评审输入：同目录 `codex-review-r1.md`（2026-09-19）。评分 **4.9/10 NEEDS-WORK**——「暂不能作为 studio-layers change 的规范性实现基础」。本节为逐条处置落档；处置状态如实标注（已改写 / 契约已落稿待实现 / 待回填），不以自评替代验证。

### I.1 16 议题裁决 → 落档位置

| # | 裁决（一句话） | 落档位置 |
|---|---|---|
| 1 | 支持（边界收紧）：冻结 LayerRecord 成员不变量（启用块恰属一层/背景层不入计算）；导入拒绝重复块/未知块/多 rest；自由掩码另立 mask/member type change | §A.1、§A.7、§E.1 |
| 2 | 支持但推翻论证措辞：v1 overrides 四表键即引擎块 id（projectFile.ts）；rest 价值 = 避免为迁移重跑分块；补悬空清理 + 计数提示/恰一 rest/重复块拒绝/重分块语义 | §0.4-2、§E.1 |
| 3 | 支持（需定义回退）：`segment.opts` 原子 op；显式层成员清空保留配置；旧 override 计数/提示；撤销回旧 k/seed 由 op 流重建 | §A.2、§D.2 |
| 4 | 支持（须改名义）：「隐藏仍计算/统计/导出」名义化 + 状态条「含隐藏层」+ 只导出可见层另设显式命令 | §A.4、§B.5 |
| 5 | 支持（补跨设备取舍）：gemproj 不入观察态、打开恢复默认观察态并提示；gemdoc 文档态差异显式化；PreviewRenderInput 旧 golden | §A.4、§B.7、§E.4 |
| 6 | 支持（前置 gate）：一次 bump + v2 contract gate 先于 add-project-files 2.x | §E.2、§E.7 门序 1 |
| 7 | 支持原则、反对原移交落法：归档前同步修改 add-project-files design/spec/tasks + 依赖 DAG + 验收条款 | §E.3 |
| 8 | 推翻「已等价」、支持串行调度方向：compatibility test（旧实现为 oracle）全矩阵；证明前 P0 计算切片不切 | §C.1、§C.4、§C.7 |
| 9 | 推翻「分区互斥=永不重叠/仅边界风险」：全层 concat 统一 pairwise（唯一 helper + maxCellPx，px）；碰撞源全清单（八源）；exportGate 共同前置硬阻断 | §C.3、§E.5 |
| 10 | 支持方向、需消费面清单：废除清单（组件/API/hover drawPreview/文件名/交互测试）落消费面矩阵 | §C.5、§E.6 |
| 11 | 支持（检查快捷键）：⌘Z/⇧⌘Z 与按钮同源、面板跳转回放、跨 tab focus、空历史态冻结 | §D.5 |
| 12 | 支持（须冻结提交语义）：字段级 mixed detector + 预填锚点 + 批量单 op + 测试面 | §A.5 |
| 13 | 推翻 P1 乐观：升 **P1 入口验收门**（列表/键盘 P0 兜底；最近块/距离场容差 P1 硬门；Owner 走查可升 P0） | §B.6 |
| 14 | 支持：去 activeStrategy 后缀 + 覆盖行为测试冻结（同名覆盖/PNG 入库命名/下载） | §E.5 |
| 15 | 支持但限制容错：`fold → {state, diagnostics}`；stale op 只读灰显入诊断不重写；压实记 state hash 与边界；跨重分块撤销属性测试 | §D.1–D.3 |
| 16 | 支持方向、沿用现有 sheet 语义：bottom sheet 同构 + 长按多选/短点单选 + 关闭不丢选择 + 层数 1/几十层测试 | §B.8 |

### I.2 P0 阻塞 → 处置对照

| P0 | 处置要点 | 修订位置 | 状态 |
|---|---|---|---|
| P0-1 v2 公共规格与物理锚未冻结 | 消费姊妹稿 v1.1 冻结契约（BaseSpec/GemSpecSnapshot/PhysicalCanvas）；LayerRecord.physics 引用 canonical specKey；输出/编辑钻物化 GemSpecSnapshot（widthMm/heightMm/assetId + 逐钻 rotationDeg） | §A.7、§E.2 | 契约已落稿；类型 + round-trip/identity 测试冻结归 v2 contract gate（**待实现**；字段名以 gate 产物回填，§I.4） |
| P0-2 pairwise 单位/cell/导出门无真源 | 全层 concat 统一 pairwise；唯一 `requiredCenterDistancePx(a,b)` + `maxCellPx`（px 单位）；exportGate 为 SVG/BOM/PNG/handoff 共同前置、违规硬阻断；层内布局终局同 helper；测试面（大小径/跨 cell/边界 gap/旋转/20k） | §C.3、§E.5 | 契约已落稿（**待实现**） |
| P0-3 `computeLayer` 兼容性未证明 | compatibility test：旧实现为 oracle（单 rest 层同参逐位相等）+ 全矩阵（结果缓存/进度 segment 1+N/取消 reject 身份/run 作废/错误只污染对应层/重算期间旧结果保留） | §C.1、§C.4 | 契约已落稿（**待实现**；证明前 P0 计算切片不切） |
| P0-4 `gemprojReplay` 未登记 layers[] | 登记为必改消费者；v2 replay 六步链（segment→rest/显式层→每层 effectiveBlocks/density/grid→逐层 computeLayer→联合 pairwise/exportGate→handoff 逐钻 spec+PhysicalCanvas）；v1 fixture 迁移后与旧 replay 相等测试 | §E.5 | 契约已落稿（**待实现**） |
| P0-5 四格式迁移与移交无可执行 DAG | 移交落法改写：归档前同步修改 add-project-files design/spec/tasks（删旧 v1 条款、2.6/2.7 补 dirty/lease/导入依赖 DAG）；补 handoff/gemprojReplay/asset pin 验收条款；2.x 消费 v2 gate 产物 | §E.3 | 已落稿（**待执行**——对原 change 三件套的实际修改动作在归档前完成） |
| P0-6 历史 fold 的 stale/重分块/compaction 不闭合 | `fold(base,ops) → {state, diagnostics}`（稳定 code/path 排序）；stale op 只读灰显入诊断、不重写；100 组压实记 state hash 与 op 边界；跨重分块撤销属性测试（同 base+ops ⇒ 同 state+diagnostics） | §D.1–D.3 | 契约已落稿（**待实现**） |
| P0-7 消费面覆盖不完整 | 「旧符号 → 新入口 → 测试」矩阵（UI 预览/五策略废除/隐藏层渲染/联合统计/导出门/送精修/gemproj 打开保存/asset pin/gemdoc 烘焙/handoff/常量收编）；**矩阵缺项不得进入实现切片** | §E.6 | 矩阵已落稿（**待随实现逐项核销**） |
| P0-8 GPU 确定性无可执行证明 | capability-labeled implementation + backend/version 记录 + 同 fixture CPU/GPU 差异判定（预览允许差异、产出恒 CPU 精算）+ 发现差异自动回退 CPU + 不改 run/cancel/onResult 协议；引用 gpu-research.md（WGSL 逐位不可复现/路线 A） | §C.6 | 已改写（调研结论已回填；P1 预览试点立项待 Owner，§I.4） |

### I.3 五段合流门序与放行条件

门序 = §E.7（v2 contract gate → engine gate → replay/handoff gate → studio gate → add-project-files 归档同步）。**放行条件（R1 §5 原文）**：P0-1～P0-8 全部转成可编译类型、迁移 fixture、联合导出门、replay/handoff 测试和 CPU/GPU 确定性证据；并把两稿合流矩阵（§E.7）同步回 openspec（specs/tasks），而非只停在 `.agents/documents`。在这些条件完成前，本稿只作契约修订与交互原型基线，不作为 studio-layers change 的规范性实现基线。

### I.4 未决项（Owner 拍板 ×4 + 依赖 gemspec v1.1 的回填点）

**Owner 四项拍板**（当前状态均为「待拍板」）：

1. **画布命中是否升 P0**（议题 13）：P1 入口验收门已立（§B.6）；Owner 走查若判定画布点选为主路径 → 最近块/距离场容差提前进 P0 切片。
2. **混合配置「滞空」解构复核**（§A.5/§H-5）：本文解构为「不显示混合值 + 预填锚点基准值」，与 Owner 字面「滞空（提供默认值）」存在形态张力，需 Owner 复核确认（议题 12 备选字面解仍备案）。
3. **合流门宿主与跨 change 排期**（与姊妹稿 v1.1 §I.5-2 为同一裁决）：v2 contract gate 落在 add-gem-catalog W0 提前启动、还是独立前置 micro-change；add-project-files 2.x（已移交本 change）在门序中的插队位置与原 change 冻结任务的范围调整。
4. **GPU 预览试点是否立项**（gpu-research 路线 A 的 P1 试点）：CVT preview-only kernel（原生 WebGPU、Worker 内懒加载、交互反馈专用，应用/保存/导出触发 CPU 精算）；不立项则 GPU 面收敛为 P0 架构预留（能力位探测 + 懒加载骨架）。

**依赖姊妹稿 v1.1 冻结契约的回填点**（gate 产物落地后核对字段名/签名后回填本文）：

- `BaseSpec`/`GemSpecSnapshot`/`PhysicalCanvas` 类型冻结（add-gem-catalog W0）→ §A.7/§E.1/§E.2 的 `specKey` 表达与「gemproj 是否内联快照」细节；
- 唯一 helper 签名（engine gate）→ §C.3 本稿写 `requiredCenterDistancePx(a,b)`，姊妹稿 v1.1 写 `requiredCenterDistancePx(a,b,grid)`——**以实现签名为准统一**（两稿合流时消除参数表分歧）；
- `.gemshape` schema gate 六条（姊妹稿 v1.1 P0-6）→ §E.7 门序第 1 段的引用项（本 change 不重复定义）；
- 姊妹稿 §D 末备注 / §I.5-3 期待本稿裁决后回填「每层 baseSpec × GemSpec」合流细节——本稿 §E.2 已给裁决（specKey 引用 + 快照物化），**姊妹稿侧回填待其下一次修订**（不属本文档动作）。
