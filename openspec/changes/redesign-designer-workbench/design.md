# design — redesign-designer-workbench（设计师工作台全面重写）

> 规范性来源（冲突时以先者为准）：
> 1. Owner 定调原话（2026-09-21，proposal Why 逐字落档）——定位重述与界面方向不可评审掉
> 2. Owner 七项裁决 + 封存稿需求全集（2026-09-20/21，本 change proposal §What）
> 3. improve-paving-workbench design §0 D8（二级图层模型复用于设计师工作台的注记）与 §6（v3 债登记）
> 4. 现状源码（2026-09-21 实测，`源码文件:行号`）
>
> 本设计的关键裁决均标注〔裁断〕+ 可推翻性；Owner 已定方向（七裁决+定调）处只做执行细化不重开。

## 0. 定位宣言

Owner 原话（2026-09-21）：

> 「总体来说，设计师工作台 已经从『基于图层+算法的排钻』，到了『能对每一颗钻进行微调』的工作。所以鼠标、快捷键，都要全部重新适配设计。整体的界面要和PS更加接近。」

### 0.1 一句话定位

**设计师工作台 = 逐钻微调的设计台**：每一颗钻是一等公民（选择/拖移/旋转/改径/改色/改形均为画布直接操纵）；图层是**内容的组织**（不是参数的编排）；算法是**显式调用的工具**（不是默认入口）。

### 0.2 与排钻工作台的分工边界

| 维度 | 排钻工作台 | 设计师工作台（本 change） |
|---|---|---|
| 心智 | 图层 + 算法批量排钻 | 逐钻自由微调 |
| 真源 | 参数（layers[] 参数工程，.gemproj 重放） | 钻对象（EditDocument.gems，.gemdoc 烘焙文档） |
| 图层语义 | 层 = 参数编排单元（块成员 + 策略/规格/密度四件） | 层 = 内容组织单元（成员钻，层不持规格——规格逐钻持有） |
| 二级结构 | 区块（#No）二级图层、继承开关、mask | **无范围（mask）概念、无自动填充**（Owner 定调） |
| 算法地位 | 主工作方式 | 显式工具（智能排布，弹参数小窗） |
| 隐藏层口径 | 隐藏仍参与计算/统计/导出（PRODUCT_MODEL 硬规则 9） | **隐藏层不导出**（导出前显式提示，见 §4.4——PS 心智分叉，登记升版） |
| 起步 | 选图→分块→排布管线 | 空白起步（参考底图 + 零颗钻） |

**送精修通道不变**：排钻工作台 →（烘焙快照 handoff v2）→ 设计师工作台；设计师成果不回流排钻管线（PRODUCT_MODEL 硬规则 3 保持）。

## 1. 界面架构（类 PS 四区 + 顶/底栏）

### 1.1 桌面四区布局

```
┌────────────────────────────────────────────────────────────────────────┐
│ 顶部文档栏  [▦] 设计 · 未命名 ●未保存 │ 智能排布… │ ⌘Z ⌘⇧Z │ 保存 ⌘S ▾ │
├────┬─────────────────────────────────────────────────────┬─────────────┤
│ 竖 │                                                     │ 属性面板     │
│ 排 │                                                     │ 空态/单选/N选│
│ 工 │                                                     ├─────────────┤
│ 具 │                                                     │ 图层面板     │
│ 栏 │                画布（居中，参考底层 + 钻石层）          │ 参考底层 ▾  │
│    │      选择框 · 变换手柄 · 笔刷光标 · 吸附格位高亮        │ 图层 2 👁🔒 │
│ V  │                                                     │ 图层 1 👁    │
│ B  │                                                     │ [＋新建]    │
│ E  │                                                     │             │
│ H  │                                                     │             │
│ Z  │                                                     │             │
├────┴─────────────────────────────────────────────────────┴─────────────┤
│ 底部状态栏  画幅 210×297mm · 缺省锚 │ 100% ▾ │ 1,248 钻 · 含 2 隐藏 │ ⚠间距 3 │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 各区内容规格

**竖排工具栏（左，56px icon 列）**——Owner 点名「工具栏应该竖排」。工具集按产品裁剪为五项（PS 工具箱的子集，吸管/钢笔/文字等不纳入——贴钻域无此对象）：

| 工具 | 键 | 图标语义 | 行为 |
|---|---|---|---|
| 选择 | V | 箭头 | 单选/框选/拖移/变换手柄（§2） |
| 画笔 | B | 笔 | 按当前规格落钻（§6） |
| 橡皮 | E | 橡皮 | 命中即删（§6） |
| 抓手 | H | 手 | 拖拽平移视图（空格临时切换，随时可用） |
| 缩放 | Z | 放大镜 | 点击放大 / Alt+点击缩小 / 拖框放大区域 |

- 栏底（或顶栏）非模态开关：**吸附**（格位/自由两态，写交互态真源）；工具栏 tooltip 标注快捷键（`选择 (V)`）。
- 〔裁断〕吸管不进首版：颜色与规格走规格选择器/色板（有限集合），画布取色→最近色板色的匹配成本与验证成本不匹配首版价值，登记 P2。
- 〔裁断〕「智能排布」**不占工具栏位**：它是命令（弹参数小窗、一次执行、不改变后续画布手势），非模态工具——按 PS 惯例命令按钮放顶部文档栏、带省略号「智能排布…」。可推翻（Owner 可改放工具栏第六项）。

**画布（居中）**：参考底层（三源合成，§4.2）+ 钻石层（按层序合成）+ 交互反馈层（选择框/手柄/光标/吸附高亮/右键菜单锚点）。缩放平移复用现状「光标锚缩放」经验（EditCanvas 既有实现重写但行为规格继承）。空态（无文档）= 空态引导页（§5.1）。

**右侧面板列（上属性/下图层，可折叠）**：
- **属性面板** = 选中对象的属性（PS Inspector 语义），三态：空态（引导文案）/ 单选（全字段：规格码/形/直径 mm/旋转°/色/所属图层）/ N 选（公共字段 + 混合值「—」）。批量写 = 单 undo 组（现状 beginStroke/endStroke 组机制复用）。它不是管线参数面板—— PRODUCT_MODEL 硬规则 6 的修订口径见 §5.3。
- **图层面板** = 参考底层特殊行（钉底）+ 钻石层行列表（§4）。

**顶部文档栏**：模块标识 + 文档名 + 未保存徽标（●）｜智能排布… ｜撤销/重做按钮（与 ⌘Z 同源）｜保存/另存菜单（守卫三分法 §5.4）。

**底部状态栏**：画幅读数（mm + 锚来源，点击弹画幅设置 popover——裁决 6「不强制弹窗」）｜缩放比（点击回 100%/适配）｜钻数（含隐藏口径「含 N 隐藏」）｜当前规格码读数（R10/SQ35 人读）｜间距 warning 徽标（派生消费 validateEditable，导出硬阻断语义不变）。

### 1.3 命名与落点（新交互层目录）

〔裁断〕新域命名：`src/components/Designer/`（视图与组件）+ `src/lib/designer/`（交互态 store 与手势层），随 R0 改名一次到位；`src/lib/edit/` 生命周期/渲染契约文件原地复用（§7）。可推翻（Owner 可要求续用 Edit 命名）。

### 1.4 移动端降级（R8 切片）

- **底部工具条**（横滚 icon 条）：选择/画笔/橡皮/撤销/重做 + 吸附开关；抓手/缩放不占位——触摸直接双指手势。
- **右面板 → 抽屉**：底部滑出抽屉，内含「属性 / 图层」分段控件（Segmented）；画幅/缩放读数合并入顶栏第二行。
- **触摸手势映射**：单指 = 当前工具行为；双指捏合 = 缩放、双指拖 = 平移；长按 = 右键上下文菜单；无 hover 态（tooltip → 长按显示）。
- 桌面先行：R2-R6 只保桌面可用；移动端布局断点与抽屉交互集中在 R8，不提前铺开。

## 2. 指针交互清单（逐手势）

证据基线：现状画布仅「点选命中 + 滚轮锚缩放 + 平移」（EditCanvas 814 行，tap→queryCircle 命中，`components/Edit/EditCanvas.svelte`）；本节为全面重设计的**完整目标规格**。通用约束：所有对象手势只在「选择工具或画笔工具」下按工具分派；锁定层的钻不可选中/不可编辑（可显示，§4.3）；进行中手势可 Esc 取消（不产生 undo 组）。

| # | 手势 | 对象/上下文 | 行为 | 约束与吸附语义 |
|---|---|---|---|---|
| P1 | 单击 | 钻（选择工具） | 选中该钻（替换现选集）；显示变换手柄（§2.1） | 点落在锁定层钻上 = 不选中（视为空白）；吸附开关不影响选择 |
| P2 | 单击 | 空白 | 清空选集、收起手柄 | — |
| P3 | Shift+单击 | 钻 | 加选/减选（toggle） | 与 P1 同锁定约束 |
| P4 | 拖拽（框选） | 空白起 | marquee 矩形，松手收集相交钻入选集 | 仅收集**未锁定**层的钻；Shift 拖 = 并入现选集；矩形与钻的相交判据 = 钻外接圆（复用 selection.gemIntersectsRect 几何，命中查询走 spatialIndex） |
| P5 | 拖拽 | 钻（命中点起） | 移动选集（单选或多选成组移动） | 松手才写 patch（拖拽中是预览读数，一个 undo 组）；**Shift = 轴约束**（按初始拖向锁定水平/垂直）；**Alt 按下起拖 = 复制选集并拖副本**（PS 惯例，副本 id 走 `m-` 自增）；吸附 = 开时落点吸附六方格位（hexSnap，按当前规格 pitch），关时自由落点；间距冲突不阻断移动（warning 徽标口径，导出门才硬阻断） |
| P6 | 拖拽 | 旋转手柄 | 绕钻心旋转（单选） | 实时°读数气泡；**Shift = 15° 步进**；圆钻（round）旋转无效——手柄隐藏旋转柄（改径柄保留） |
| P7 | 拖拽 | 直径手柄 | 连续改钻直径（单选） | 实时 mm 读数气泡；连续值不强制吸附档位（规格体系逐钻自由，档位入口 = 规格选择器）；最小直径 = 当前形最小可生物理径（engine spec 域校验） |
| P8 | 双击 | 钻 | 属性面板定位：滚动到对应字段并高亮 | 〔裁断〕非模态（属性面板常驻右侧，双击 = 快速到达）；可推翻为「打开规格选择 popover」 |
| P9 | 双击 | 空白 | 视图切换：100% ⇄ 适配画幅 | 画布导航语义（高频实用） |
| P10 | 滚轮 | 画布 | 以光标为锚缩放 | 行为规格继承现状；缩放档位 10%-1600% |
| P11 | 空格按住 + 拖 / 中键拖 | 任意位置 | 平移视图（空格 = 临时抓手，松开回原工具） | 工具无关、随时可用 |
| P12 | 拖拽 | 抓手工具 / 缩放工具 | 抓手 = 平移；缩放工具拖框 = 放大该区域，Alt+点击 = 缩小一档 | 缩放工具单击 = 放大一档（PS 惯例） |
| P13 | 右键 | 选中钻（单选/多选） | 上下文菜单（§2.2 选中态树） | 菜单命令与快捷键/面板同源（同命令总线） |
| P14 | 右键 | 空白 | 上下文菜单（§2.2 空态树） | — |
| P15 | 点击 | 图层面板行 | 选中层（当前层 = 新钻落点/智能排布落点）；层内钻不因选层被选中 | 单击层名区 = 选层；双击层名 = 重命名（PS 惯例） |
| P16 | 拖拽 | 图层面板行 | 层排序（改变 z 序/渲染序） | 参考底层钉底不可拖；层序只影响渲染与导出合成序，不重排钻数组（真源序稳定，undo 可恢复） |
| P17 | 点击 | 眼睛 / 锁图标 | 显隐 / 锁定切换 | **Alt+点眼睛 = 孤立显示该层**（其余全隐藏，再按恢复——PS 惯例） |

### 2.1 变换手柄形态（单选）

```
        ○ ←—— 旋转柄（距钻心 2×半径的延伸杆顶端）
        │
   ◇ ── ● ── ◇      ● = 钻（选中环高亮）
        │            ◇ = 直径柄（四向，拖拽改直径）
        ◇
```

- 旋转柄仅非 round 形显示（round 旋转无意义）；四直径柄仅显示两项（水平/垂直）避免与旋转柄视觉冲突——〔裁断〕把手布局可在实现期按视觉评审微调，交互语义（旋转/改径分离）冻结。
- **多选不显示变换手柄**〔裁断〕：多选变换 = 对齐分布（右键/面板）+ 批量改规格（属性面板）；多选包围盒整体缩放涉及 SS 离散档位语义模糊，登记 P2。可推翻。
- 数字输入通道：属性面板旋转°/直径 mm 字段 + 快捷键步进（§3）——三通道写同一 update patch 面（单 undo 组语义按通道会话合组）。

### 2.2 右键上下文菜单树

```
选中态（≥1 颗）：
  复制 ⌘C / 剪切 ⌘X / 粘贴 ⌘V（原位偏移一格，PS 惯例）
  删除 Delete（确认弹窗——全局纪律：删除=确认）
  ── 对齐 ▸（≥2）：左/右/上/下/水平居中/垂直居中
  ── 分布 ▸（≥3）：水平等距/垂直等距
  ── 移入图层 ▸：层列表（当前层标记；锁定/隐藏层禁用）
  ── 改规格 ▸：最近使用规格 + 「更多…」（规格选择器）
空态（未选中）：
  粘贴 ⌘V / 智能排布… / 画幅设置… / 适配画幅 / 100%
```

- 对齐/分布复用 alignDistribute.buildAlignChanges/buildDistributeChanges（纯函数原地复用）；「移入图层」语义吸取排钻侧移入 BUG 教训（improve-paving §1）：归属真源 + 标签同步当前层 + 单 op 撤销。

## 3. 键位表（完整，分组；⌘ = Ctrl/Win 键双写）

现状仅 Esc/方向键三档/⌘Z（editKeyboard.ts 86 行）；本表为全面适配目标。通用纪律：输入控件聚焦时一律放行（isEditableTarget 现状语义保留）；工具单键在无修饰键时生效；所有命令与菜单/面板按钮同源（同命令总线，禁第二实现）。

### 3.1 工具切换

| 键 | 命令 |
|---|---|
| V | 选择工具 |
| B | 画笔工具 |
| E | 橡皮工具 |
| H | 抓手工具 |
| Z | 缩放工具 |
| 空格（按住） | 临时抓手（松开还原） |

### 3.2 编辑

| 键 | 命令 |
|---|---|
| ⌘Z / ⌘⇧Z（⌘Y） | 撤销 / 重做 |
| ⌘C / ⌘X / ⌘V | 复制 / 剪切 / 粘贴（粘贴 = 原位偏移一格；重复粘贴累进偏移——PS 惯例） |
| Delete / Backspace | 删除选中（确认弹窗，全局纪律） |
| ⌘D / Esc | 取消选择 |
| Alt+拖拽 | 复制并拖移副本（§2 P5） |

### 3.3 变换与微移

| 键 | 命令 |
|---|---|
| 方向键 | 微移选中 1px |
| ⇧+方向键 | 微移一格（当前规格 pitch） |
| Alt+方向键 | 微移 0.1mm（精调档；⇧Alt 并按取精调——现状三档语义保留） |
| [ / ] | 逆 / 顺时针旋转 15°；加 ⇧ = 5° 细档〔裁断：旋转占用 [ ]（PS 中 [ ] 是笔刷大小，但本产品笔刷大小 = 钻规格直径，由规格选择器承载，无独立笔刷大小键位——[ ] 让渡给旋转〕 |
| ⌘A | 全选当前层钻（非全文档——当前层语义优先，避免跨锁定/隐藏层误选） |

### 3.4 视图导航

| 键 | 命令 |
|---|---|
| ⌘+ / ⌘- | 放大 / 缩小一档（以画布中心为锚） |
| ⌘0 / ⌘1 | 适配画幅 / 100% |
| Tab | 折叠/展开右侧面板列〔裁断〕（PS 的 Tab 隐藏全部面板；本产品面板列承载属性与图层两源，全隐成本高，取折叠折中） |

### 3.5 图层操作

| 键 | 命令 |
|---|---|
| ⌘⇧N | 新建图层 |
| ⌘E | 向下合并（当前层并入下一可见未锁层） |
| ⌘[ / ⌘] | 当前层下移 / 上移一层（z 序） |
| ⌘⇧[ / ⌘⇧] | 当前层置底 / 置顶 |
| Alt+点眼睛 | 孤立显示该层（§2 P17） |
| 双击层名 | 重命名（同 §2 P15） |

### 3.6 文档

| 键 | 命令 |
|---|---|
| ⌘S / ⌘⇧S | 保存 / 另存为（守卫三分法 §5.4） |

### 3.7 键位帮助

「?」键（Shift+/）或顶栏「⌨」按钮 → 键位速查面板（单页全表；新用户可发现性——类 PS 工具 tooltip + 快捷键体系的低成本补全）。

## 4. 图层系统（裁决 1：A 完整版）

### 4.1 数据模型（gemdoc schema v2 → v3）

```
EditDocument（v3 演化——edit.svelte.ts:93 现状 v2 演进，非推倒）:
  gems: EditGem[]                     // 真源不变；**新增 layerId: string**（归属字段，见下）
  layers: GemLayerRecord[]            // 替换 Record<EditLayerKey, LayerState>（:102 固定四层退役）
  underlay: ReferenceUnderlay         // 参考底层（特殊层，§4.2）
  physicalCanvas / palette / grid / width / height / provenance / 身份字段 …（不变）

GemLayerRecord:
  id: string                          // 'L1'… 稳定 id（undo/排序不漂移）
  name: string                        // 「图层 1」递增命名，可重命名
  visible: boolean                    // 渲染开关（导出口径见 §4.4）
  locked: boolean                     // 锁定：钻不可选中/编辑（可显示）
  // 数组序 = z 序：末位最上（渲染后画、导出后合成）；重排序 = 数组序变更 op

ReferenceUnderlay（钉底特殊层，不可删/不可排序/无锁定）:
  sources: { painting?: EngineImage; referenceAssetId?: string; blocksOverlay?: Block[] }
    // 三源开关：数字油画快照（送精修带来）/ 参考原图（空白起步选图）/ 分块描线（旧档兼容）
  visible: boolean; opacity: 0…1      // 总开关 + 透明度（「透明度可调可关」裁决原文）
```

- **归属方向裁断**：`gem.layerId` 持归属（对象模型——钻是真源，层是组织视图），与排钻侧「LayerRecord.blockIds 持成员」（参数模型——块是输入）方向相反。理由：设计师台增删钻高频，gem 持归属免去层成员集维护；增删层 = 改 gems 的 layerId 批量 patch。两域模型互不复制（D8「复用」复用的是**概念**（树/显隐/锁定/排序/合并语义）与 UI 形态，非数据结构）。
- z 序与真源序分离：`gems[]` 数组序稳定（undo/序列化友好），渲染/导出序 = 按 layers z 序过滤分组派生（纯函数，同排钻「层排序不改变几何与 BOM 顺序」纪律的精神：面板序只影响视觉合成，不重写真源）。

### 4.2 参考底层（underlay）

- 三源可并存可各自开关（旧档 painting+reference 常并存）；总透明度滑杆 + 总显隐（图层面板钉底行展开）。
- 空白起步：选图 → underlay.sources.referenceAssetId = 所选资产，painting 无，blocks 无；画幅锚定（§5.2）。
- 「原图描摹」工作流：参考底图透明度调低 → 照着画钻——这是空白起步的核心使用场景，underlay 透明度必须实时可调（复用现状 setLayerOpacity 语义迁移）。

### 4.3 锁定 / 显隐 / 排序 / 成组移动 / 合并

| 操作 | 语义 | undo |
|---|---|---|
| 锁定层 | 层内钻不可选中/编辑/擦除命中跳过；可显示可隐藏 | 层属性 op |
| 隐藏层 | 不渲染；状态栏「含 N 隐藏」口径统计；导出排除（§4.4） | 层属性 op |
| 排序 | 拖拽/⌘[ ]改 z 序；渲染序派生重算 | 数组序 op（可撤销） |
| 成组移动 | 选中跨层多颗 → P5 拖移各自 layerId 不变（成组移动 = 选集语义，非临时编组） | 单 patch 组 |
| 移入图层 | 右键菜单/面板：选中钻 layerId 批量改写；菜单标签标当前层；禁用态按真实归属 | 单 patch 组 |
| **合并（⌘E/菜单）** | 当前层全部钻 layerId 改写为目标层 id，源层记录删除；**规格混合自然共存**（层无规格属性，无需调和）；目标层 = 下一可见未锁层（⌘E）或面板指定层（拖层到层/菜单） | 单 op（一次撤销恢复源层与全部归属） |
| 删除层 | 层内钻随层删除；**确认弹窗**（含钻数提示——「删除图层 N（含 128 颗钻）？」）；最后剩余一层不可删（保底，空文档可零层） | 单 op |

### 4.4 隐藏层导出口径（与排钻分叉点——登记升版）

- **设计师工作台：隐藏层不参与导出/统计明细（BOM/钻数明细），状态栏总量按「含 N 隐藏」口径显示**；导出（SVG/BOM/PNG）前若存在隐藏层，确认文案显式注明「不含 N 个隐藏层」——**显式裁剪，非隐式**。
- 与 PRODUCT_MODEL 硬规则 9（排钻：隐藏仍导出）分叉：排钻的层是参数编排单元（隐藏=观察态，生产并集不变）；设计师的层是内容组织（隐藏=不产出，PS 心智）。**本分叉在 R0 切片随 PRODUCT_MODEL v6 升版登记为分模块口径**。可推翻（若 Owner 要两台统一口径，改回「隐藏仍导出+提示」，实现面不变）。

## 5. 文档与入口（裁决 2/3/6）

### 5.1 空白起步流（纠偏 add-project-files 3.3）

空态页（现状 `views/EditView.svelte` 空态重写）三入口：

```
[ 选图新建 ]（主按钮）—— 素材库选图/上传 → 画布 = 参考底图 + 0 颗钻（绝不动算法）
[ 空白新建 ]（次按钮）—— 无参考图空文档，缺省画幅 200×200mm（〔裁断〕占位缺省，状态栏可改；标注可调）
[ 打开 ]—— 素材库 .gemdoc（旧档迁移 §5.5）/ .gemproj（重放为烘焙文档，现状 gemprojReplay 复用）+ 最近列表
```

- **选图后绝不自动生成钻**（偏差纠正的硬规则；spec 有独立 scenario）。文档名缺省「设计 · 未命名」，首次保存可改名。
- 旧「快速排稿」入口（现状 EditView:185 startQuickLayout 选图即跑）**退役**。

### 5.2 画幅锚定（裁决 6）

- 选图新建：physicalCanvas = default 锚（图像 px 尺寸 ÷ 缺省 2.5 px/mm；anchorSource='default' 显式——沿用 quickLayout 的缺省锚语义）。
- 状态栏画幅读数点击 → 画幅设置 popover：宽/高 mm 直输 + px/mm + 锚来源标识（declared/default）；改为 declared。不强制新建时弹窗。
- 导出物理正确性走 physicalCanvas（mm 贯穿），engine export 口径不变。

### 5.3 智能排布工具（原快速排稿工具化）

```
入口：顶部文档栏「智能排布…」按钮（无参考底图时禁用 + tooltip「需要参考底图」——工具输入=底图）
小窗参数：策略（五策略 Select）· 基础规格（目录档）· 间距 gapMm · 密度 %
执行：quickLayout 计算链复用（decode→segment→layout worker）——API 改造：产物从「整文档 ManualEditHandoff」
      改为「钻数组（EditGem[]，规格物化）」；进度/取消（AbortSignal）语义保留
落点：**当前图层**（结果钻 origin='manual'、layerId=当前层）；一个 undo 组（整体可撤销）
冲突：与既有钻间距冲突的结果钻丢弃并在小窗结果行报数（「并入 1,204 颗，跳过 56 颗冲突」——显式，不静默）
```

- **PRODUCT_MODEL 硬规则 6 修订登记**（R0 升版）：原「编辑器不暴露排钻参数面板」修订为「编辑器不以排钻参数为工作方式；算法工具（智能排布）显式调用时允许其自有的参数小窗」——Owner 裁决 2 已确认此形态，规则随裁决修订。
- 术语更名：「快速排稿」→「智能排布」（TERMS 词条随 R0 更新，旧词入禁用映射）。

### 5.4 保存 / 另存 / 守卫三分法（复用）

- 复用 gemdocLifecycle（saveGemdoc/saveGemdocAs/buildGemdocExport/loadFromGemdoc/closeEditDocument）+ documentService 编排 + 守卫三分法（保存/放弃/取消）——零行为变化。
- schema 升版：保存 = gemdoc v3（多图层）；打开 v2 旧档 → 内存迁移 → 保存即升 v3（单向，不回写 v2）。

### 5.5 旧档兼容（裁决 3）

| 旧档内容 | 迁移映射 |
|---|---|
| gems[]（含自动排稿产物） | 全部入新层「图层 1」，layerId='L1'；origin/blockedId 原值保留（语义只读） |
| layers.painting/reference/blocks（固定四层） | 坍缩为 underlay 三源开关（§4.2）——信息无损，心智从「四层平铺」改「参考组+钻层」 |
| physicalCanvas/palette/grid/身份 | 原值直传 |

- 迁移在打开时内存完成（loadFromGemdoc 装载后一次 patch 化迁移，进 undo 可回看但不重复执行）；round-trip 测试义务见 §8。
- 旧档打开 toast 一次性提示「已从旧版格式升级，保存后为新格式」。

## 6. 笔刷与规格

### 6.1 画笔 / 橡皮

- **画笔（B）**：按**当前规格**落钻——pointerdown 起笔 → move 连线等弧长补钻 → up 收笔（现状 brushEngine 手势与物化内核复用：makeBrushGem/resolveBrushSpec/冲突拒画闪红/落钻永不自产 spacing 违规判据全部保留）；新钻 layerId = 当前层、origin='manual'。
- 当前规格跟随：笔刷规格态 = 规格选择器写入真源（brushSpec——显式覆盖；null = 文档基准派生，现状语义保留）。
- **橡皮（E）**：命中即删；**跳过锁定层与隐藏层钻**（新语义——锁定层保护擦除，PS 图层锁定的核心价值）。
- 吸附开关（格位 grid / 自由 free）：格位 = 当前规格 pitch 六方格位（hexSnapPoint 复用，pitch 随规格重算）；自由 = 落点原样。开关作用于**落钻/拖移落点**（§2 P5 同源），不作用于直径。
- 一个 stroke = 一个 undo 组；单 stroke >2000 钻拒绝执行（MAX_STROKE_GEMS 防巨型 patch，现状纪律保留）。

### 6.2 规格选择器

- 顶部文档栏（或属性面板联动位）「当前规格」选择器：形（内置五形 + 自定义形资产）× 尺寸档（目录档位）+ 色板色——写 brushSpec 真源；选中已有钻时 = 改选中钻规格（批量 = 单 undo 组）。
- 数据源 = gemCatalogService（sys-shapes .gemshape 资产真源，零改动复用）；规格码（R10/SQ35）人读展示。
- 笔刷面 custom 形限制（BrushSpecShapeError，workbench.svelte.ts:29 现状契约）**放宽**：custom 形已带 assetId（校准入库产物），笔刷物化可携带——R5 实现时以「custom 必带 assetId」为判据替换「内置五形白名单」判据。〔裁断〕现契约是 R5-P1 时期的保守面，校准链路已闭环后无保留必要；可推翻（保守起见首版笔刷仍限内置形，custom 仅属性面板改写）。

### 6.3 校准向导（复用）

- CalibrationWizard 三步向导（选贴图 → 物理尺寸 direct/reference 二选一 → 命名入库）+ calibration.ts 纯函数族原地复用（.gemshape 目录与校准链路零改动）；入口 = 规格选择器「+ 自定义形…」。

## 7. 重写架构（裁决 7：交互层全新重写 + 契约层复用）

### 7.1 重写边界三分类

```
① 全新重写（不看旧实现——新目录）：
   src/components/Designer/*（视图组件）+ src/lib/designer/*（交互态 store + 手势层 + 命令总线）
   含：DesignerView / DesignerToolbar（竖排）/ DesignerCanvas / DesignerPropertiesPanel /
       DesignerLayersPanel / DesignerStatusBar / DesignerDocBar / ContextMenu / TransformHandles /
       SmartLayoutPanel（智能排布小窗）/ ShortcutsHelp
   src/lib/designer/：
       workbench.svelte.ts（工具/吸附/当前层/指针读数真源——新写，语义扩自旧 workbench）
       gestures.ts（pointer 事件序列 → 手势意图纯函数：§2 清单的可测决策核）
       commands.ts（命令总线：菜单/快捷键/面板按钮同源写入口）
       keymap.ts（§3 键位表分派——扩自 editKeyboard 三档微移语义）

② 演进扩展（同文件演化，保测试地基）：
   src/lib/stores/edit.svelte.ts——文档模型 v2→v3（§4.1：LayerState 四层 → GemLayerRecord[] + underlay；
       EditGem + layerId）；patch 三原子 / undo 组机制 / selection API / UNDO_GROUP_BUDGET /
       MAX_STROKE_GEMS / MANUAL_ID_PREFIX 语义全部保留（edit 族测试是 1500+ 地基的组成）
   src/lib/edit/quickLayout.ts——API 扩展（整文档产物 → 钻数组产物模式；计算内核/默认参数冻结不动）
   src/lib/edit/gemdocLifecycle.svelte.ts——装载迁移钩子 + v3 序列化（守卫/lease/换绑语义不动）

③ 冻结复用（零改动，验收面）：
   engine 全域（edit.ts 边界函数 toEditGem/fromEditGem/validateEditable/isExportableEditable/
       resolveConflicts、geometry/requiredCenterDistancePx、exportGate、layout、segment、spec/catalog）
   services（documentService/gemCatalogService/generationService 接口位）
   lib/edit：documentStatus / gemprojReplay / renderPlan / spatialIndex / replayLayers
   persistence 全域（assetStore/gemshapeFile/handoffImage/projectFile/taskStore）
   校准向导（CalibrationWizard.svelte + calibration.ts）· 素材库 · 送精修 handoff v2 · computeClient/worker
```

- **「交互层全新重写」边界解读**〔裁断〕：重写 = 视图组件、画布、指针/键盘交互态；**文档 store 是契约层**（其 patch/undo 语义有测试地基与 handoff/gemdoc 消费方），采「schema 演进」而非推倒。若实现期发现 LayerState 四层与 gems 真源耦合超出预估（评估：selection/undo/序列化三消费面，均可局部替换），允许整文件重写但**公共 API 面与测试断言语义必须等价保留**（adapter 验收同 rename-and-expert-workbench §2.3-3 口径）。
- 依赖方向单向：`Designer → designer store → edit store（文档真源）→ engine/persistence/services`；designer 域禁止直写 gems（一律经命令总线 → edit store patch 面，保 undo 单点）。

### 7.2 命令总线（同源纪律）

菜单（§2.2）/ 键位（§3）/ 面板按钮全部收敛到 `commands.ts` 单一入口（`executeCommand(cmd, payload)`）；undo 组策略在命令层声明（stroke 组/按键会话组/单 op 组）。禁第二实现 = PRODUCT_MODEL「一个概念两个写入点 = 结构性失败」纪律的交互层落地。

### 7.3 与排钻图层模型的复用关系（D8 落地口径）

复用 = **UI 形态与操作语义**（树列表/显隐/锁定/拖排/合并菜单/钉底特殊行）+「面板序不改真源序」纪律；**不复用数据结构**（blockIds 成员制 vs layerId 归属制，§4.1 理由）。两域组件不共享代码（域间共享走 engine 公共面）——排钻 LayerPanel 的 HTML5 DnD 排序实现可作参考实现，不抽公共组件（避免两域耦合，各自演化）。

### 7.4 旧交互层退役清单

| 现文件 | 处置 |
|---|---|
| `src/components/Edit/EditCanvas.svelte`（814 行） | **退役** → DesignerCanvas 重写（四层合成/锚缩放/点选的经验规格继承，代码不看旧实现） |
| `src/components/Edit/EditToolbar.svelte`（105，横排） | **退役** → DesignerToolbar（竖排五工具 + 吸附开关） |
| `src/components/Edit/EditLayersPanel.svelte`（56，固定四层） | **退役** → DesignerLayersPanel（§4 模型） |
| `src/components/Edit/EditPropertiesPanel.svelte`（194） | **退役** → DesignerPropertiesPanel（三态 + 图层/规格字段） |
| `src/components/Edit/EditStatusBar.svelte`（81） | **退役** → DesignerStatusBar（画幅 popover/缩放比/含隐藏口径/规格码） |
| `src/components/Edit/workbench.svelte.ts`（161） | **退役** → lib/designer/workbench.svelte.ts（新增当前层/指针读数；brushSpec 语义迁移） |
| `src/components/Edit/editKeyboard.ts`（86） | **退役** → lib/designer/keymap.ts（nudgeStepPx/isEditableTarget 纯函数**迁移保留**——语义与测试断言随迁） |
| `src/components/Edit/selection.ts` / `brushGesture.ts` / `gemCommands.ts` / `nudgeSession.ts` | **迁移**至 lib/designer/（纯函数，测试随迁；语义不变） |
| `src/components/Edit/hexSnap.ts` / `alignDistribute.ts` / `properties.ts` | **迁移**（properties.ts 字段注册表扩 layerId/规格字段） |
| `src/components/Edit/brushEngine.ts`（201） | **迁移 + 改造**（物化带 layerId；custom 形判据 §6.2；冲突判据内核不动） |
| `src/components/Edit/CalibrationWizard.svelte` / `calibration.ts` | **保留原地**（复用；仅入口接线改 Designer 规格选择器） |
| `src/lib/components/views/EditView.svelte` | **退役** → DesignerView（空态三入口/无自动排稿/顶底栏装配） |
| `src/App.svelte`（:173/:287 Tab） | 改名 + 路由值接 DesignerView（R0/R1） |
| `src/lib/edit/*`（7 文件） / `src/lib/stores/edit.svelte.ts` / services / persistence / engine | **留**（§7.1 ②③） |

- 退役收据：`rg -l "components/Edit" src` 归零（迁移文件除外——按新路径）；死 API grep 清零（同 improve-paving §1 BlockList 退役口径）。

## 8. 测试策略

- **交互测试（jsdom 指针序列）**：gestures.ts 纯函数化使 §2 清单逐行可测——pointerdown/move/up 序列 → 意图断言（P4 框选收集跳锁定层 / P5 Shift 轴约束 + Alt 复制 id 自增 / P6-7 手柄读数与写 patch / P13-14 菜单树态）；命令总线单源断言（键位/菜单/按钮三入口同一命令）；undo 组策略（stroke 组 / nudge 500ms 会话组 / 合并单 op）。
- **兼容测试（旧档）**：v2 gemdoc fixture（含自动排稿产物 + 固定四层）→ 打开迁移断言（图层 1 归属 / underlay 三源）→ 保存 v3 → v3 round-trip 字节等价；v2 只读路径不再产出（保存必 v3）断言。
- **字节级护栏（engine 面不动）**：`git diff --stat src/lib/engine` 零行（本 change 全程）；engine 族测试零改动；quickLayout 同参同出快照（计算内核不动收据）；documentService/gemdocLifecycle 既有测试零断言改动（守卫三分法行为等价）。
- **回归面**：tests/edit 全族 + app.smoke + 交接面（lifecycle/editUnbound/editReferenceAsset）+ assets 族（校准入口接线）；R0 后改名 grep 收据（§R0 任务内）。
- **走查义务**：R2/R4 完成后按 §2/§4 逐行人工走查（journey-first：触发→入口→执行→反馈→撤销全链），记分卡自评（coherence/journey/IA/state 四核心维度 ≥7 才过切片门）。

## 9. 关联债（无阻塞关系，登记备查）

- improve-paving-workbench §6 v3 登记项与本 change 无阻塞：① 排钻 gemproj v2 值域 (0,1]（密度 0 持久化）——排钻侧 .gemproj 契约，本 change 不触 gemproj schema；② 块级独立配置 overrides.config 会话态（不入档）——排钻二级图层域，本 change 无二级图层。两债主会话另行裁决，不得塞入本 change 范围。
- 本 change 自身登记的 P2（不阻塞收尾）：多选包围盒缩放（§2.1）、画布取色吸管（§1.2）、历史面板游标跳转（improve-paving §6-3 同族）。
- PRODUCT_MODEL v6 / TERMS v4 升版（R0 承载）：改名 + 智能排布术语 + 硬规则 6/9 分模块口径（§4.4/§5.3）。
