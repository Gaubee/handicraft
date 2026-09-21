# Design: rework-designer-manual-rhinestone — 设计师工作台第二轮：手动排钻专注版

## 0. 依据与证据

- Owner 2026-09-21 试用五点原话（proposal.md 落档）——本设计的最高裁决源。
- 9.2b 走查中断前证据：/tmp/vision-walk2/ 20 张截图（设计师面 A1-A6 段；11b/18b 两处 retry 暗示橡皮与 Alt 复制存在摩擦，实现批自查）。
- 事实基线：`.gemshape` texture 必备（gem-catalog R3/R4 冻结纪律，含内置五形 seed——每规格都有钻石素材图 dataUrl）；`CatalogSpec` 是元数据面，纹理经资产层（assetStore/parseGemshape → `GemshapeFile.texture`）取用；DesignerCanvas 现为 `ctx.arc` 几何符号渲染，纹理从未接入。
- 数据模型基线：钻 x/y 按相对参考图像素存储（gemproj/handoff/quickLayout 同源），`grid.pixelsPerMm` 仅锚定物理换算——**尺寸与位置天然解耦**，本 change 将其冻结为测试红线。

## 1. 水钻贴图渲染与状态反馈（点 1+2）

### 1.1 sprite 烘焙管线

```
gemCatalog.resolveSpec(specKey) → assetId/seed → parseGemshape → texture.dataUrl
  → Image 解码 → 离屏烘焙三态帧（规格直径 × dpr 栅格化）：
     normal   ：贴图 + 柔和投影（ctx.shadowColor rgba(0,0,0,.35) blur≈r·0.4 offsetY≈r·0.15）
     hover    ：投影增强 + 亮度微升（叠 rgba(255,255,255,.10)）
     selected : 外发光描边（shadowColor 主蓝 blur≈r·0.6 双 pass）+ 投影
  → spriteCache：键 = specKey + dpr + state（+ colorId 若着色，见裁断 1.2）；LRU 上限 256；missing-asset 回退几何符号 + 既有 brushError 通道
```

- 渲染循环 `ctx.arc` 全部替换为 `drawImage(sprite)`（命中/框选预览/拖移 ghost 同步换肤）；单次 drawImage + 零逐钻 filter 计算，性能预算：1000 钻 @60fps（jsdom 不可测真帧率，以「渲染 op 全走 sprite cache、零 arc 路径」断言 + 真浏览器走查目测）。
- 导出面（SVG 矢量/BOM/PNG renderer）**零改动**——贴图仅画布视觉层；PNG renderer 接线本 change 不扩（走查门后再议）。

### 1.2 着色裁断〔可推翻〕

`colorId`（色板色）与贴图的关系两案：
- **A（默认）multiply 着色**：离屏 texture → `globalCompositeOperation='multiply'` 铺色 → `destination-in` 回贴 alpha——保留高光/阴影层次，色板色作用于材质。
- B（条件触发）：实现批先查 sys-shapes seed 纹理实体——**若 seed 纹理本身即分色彩色素材图**（每规格自带颜色），则 colorId 仅作用于选中高亮/BOM，贴图原样渲染（着色管线保留为 custom 资产后路）。
判据落 design 附录：取样 ≥3 个 seed .gemshape 的 texture 视觉性质（程序化直方图判彩色/中性）后定案，收据进 tasks。

#### 附录：裁断 1.2 取样收据（R2.1 执行，2026-09-21）

- **取样对象**：五形 seed 贴图全集（`GEMSHAPE_SEEDS` 内嵌 PNG——round 64×64 / square 64×64 / drop 49×70 / heart 63×62 / marquise 40×80，共 5 张 ≥ 3 张要求）。
- **方法**：PNG 逐像素解码（zlib inflate + unfilter），对 alpha>0 像素统计 HSL 饱和度 / RGB 色度（max−min，byte 域）/ 明度域 / 色相族（一次性脚本，输出不进库）。
- **判据数字**（五形一致，逐形偏差 < 0.01）：

  | 指标 | round | square | drop | heart | marquise | 彩色判读参照 |
  |---|---|---|---|---|---|---|
  | 不透明像素 | 2984 | 3844 | 2122 | 2551 | 1772 | — |
  | 平均 HSL 饱和度 | 0.217 | 0.218 | 0.210 | 0.222 | 0.215 | 彩色素材 ≈0.5+ |
  | 最大 HSL 饱和度 | 0.297 | 0.297 | 0.278 | 0.297 | 0.282 | 彩色素材 ≈0.9+ |
  | 饱和度 >0.30 占比 | 0% | 0% | 0% | 0% | 0% | 彩色素材显著非零 |
  | 最大 RGB 色度 | 18/255 | 18/255 | 18/255 | 18/255 | 18/255 | 彩色素材 100+ |
  | 明度范围 | .81–.93 | .81–.93 | .81–.93 | .81–.93 | .81–.93 | — |
  | 平均色相 | 227° | 227° | 227° | 227° | 227° | 单一冷色调族 |

- **结论：中性** → **方案 A（multiply 着色）执行**。seed 贴图为高明度银白渐变剪影（微冷蓝 227° 色偏、色度 ≤18/255 ≈ 7%、零高饱和像素）——材质底色中性，colorId multiply 作用于材质（保留高光/阴影层次）；colorId 空/查无色 = 未映射色，贴图原样银白渲染。着色烘进 sprite 帧（渲染循环零逐钻 filter），cache 键含 colorId 维度（§1.1 键契约 + 直径 px 量纲完备化）。

## 2. 尺寸动态安全与可发现性（点 3 下半）

- **红线（测试冻结）**：任何尺寸变更面——规格选择器批量改规格、直径柄、⌘T 缩放、（未来）其它——MUST NOT 移动钻位、MUST NOT 触发重吸附/重排；x/y 恒相对参考图像素。新增 invariant 测试：改尺寸前后全钻 (x,y) 逐位相等。
- **可发现性**（Owner 未找到规格配置 = 实锤失败）：
  - 画笔工具光标 = **钻形 footprint 预览**（空心圆盘 Ø=当前规格直径 + 中心点；随规格切换即时变化）——替换现状小十字/圆点；
  - 笔刷直径调节即时反映在光标（[ ] /滚轮+Alt，见 §4）；
  - 状态栏规格码常显（既有）+ 顶栏规格选择器入口视觉强化（图标+规格码双显）。

## 3. PS 交互对齐（点 3 上半）

### 3.1 ⌘T 自由变换态（新核心）

- ⌘T 进入变换态：单选/多选均出**包围盒**（**推翻 redesign 裁断「多选不显示变换手柄」**——Owner 亲验不舒服 + PS 参照系：PS 多选图层/选区同样有自由变换框）；Enter 确认 / Esc 取消；进行中工具手势让位。
- 手柄：四角柄=缩放（=批量改尺寸，落 §2 红线——位置不动）、外柄=旋转；Shift=等比/15° 步进；顶栏实时读数（mm/°）。
- 落笔单 patch 单 undo 组（含整组尺寸/角度字段）；与既有单选旋转/直径柄关系：**单选专用柄退役**，统一进 ⌘T（少一套手柄系统，交互归一）。
- 旋转角规格：round 形旋转无效语义保持（变换态中 round 缩放有效、旋转不产生视觉差但仍记录？——裁断：round 旋转值恒 0，旋转柄对 round-only 选集禁用）。

### 3.2 选择/多选/批量 PS 惯例补齐

- **Alt+框选=从选区减去**（现状缺口；Shift+框选=并入既有）；Alt+拖钻=复制保持（PS 一致）。
- 框选全程实时高亮 + 命中数读数（轻量：marquee 角落计数）。
- 批量操作族：对齐/分布（既有）、⌘T 批量尺寸/旋转（新）、批量改规格（既有 apply-spec）、批量删除（既有确认门）。
- 钢笔式键鼠协作贯穿确认：Esc=取消进行中（笔迹/手势/变换态）、Enter=确认、Backspace=删除、⌘Z=整组撤销——全表落 §3.5 对齐表并进速查面板。

### 3.3 键位重映射裁断〔可推翻，Owner 否决即回退〕

| 键 | 现绑定 | 新绑定 | 依据 |
|---|---|---|---|
| `[` `]` | 旋转 ±15°（⇧=5°） | **笔刷直径 -/+**（画笔/橡皮工具下；⇧=粗档） | PS 笔刷惯例；点 5 引入笔刷尺寸语义后 [ ] 让渡成立（原让渡裁决的前提「无笔刷大小语义」已被本 change 推翻） |
| `⌘[` `⌘]` | 层排序（保留） | 层排序（不变） | — |
| 旋转 ±15° | `[` `]` | **⌥[` `⌥]`（快捷细旋转保留）+ ⌘T 主通道** | 旋转不再失快捷，主交互归 ⌘T |
| ⌘T | 无 | 自由变换态 | PS 惯例核心 |

### 3.5 交互对齐表（design 交付物，实现批落码后回填测试映射）

〔R4.2 回填：测试映射列 = 各行绑定的测试文件/用例族（2026-09-21 实现批）。〕

| 操作 | PS 惯例 | 本产品绑定 | 状态 | 测试映射 |
|---|---|---|---|---|
| 框选 | 左拖空白 | 空白起拖 | 既有 | gestures.select.test.ts（P4 框选族） |
| 框选命中数读数 | — | marquee 角落轻量计数 | 新（R4.2） | gestures.select.test.ts（P4 框选实时命中数读数） |
| 加选/减选 | Shift 框/Alt 框 | Shift 框（既有）/ **Alt 框（新）** | 补 | gestures.select.test.ts（P4 Shift 框选并入 / **P4 Alt+框选减选**——spec Scenario 6−2=4） |
| 点选加减 | Shift 点 | Shift 点 | 既有 | gestures.select.test.ts（P3） |
| 拖移/复制 | 拖 / Alt+拖 | 拖 / Alt+拖 | 既有 | gestures.move.test.ts（含 Alt 复制；与 Alt 框选互斥 = 空白/钻上起拖分武装） |
| 变换（缩放/旋转） | ⌘T | ⌘T（新，多选含） | 新（R4.1） | transformMode.test.ts（角柄缩放/外柄旋转/复合/取消 + §2 红线 invariant）；transformHandles.test.ts（变换盒形态矩阵 + 单选柄退役收据） |
| 笔刷大小 | [ ] | [ ]（新让渡） | 新（R3.2） | keymapCommands.test.ts（[ / ] 笔刷直径键）；brushFlow.test.ts |
| 删除 | Backspace | Backspace（单颗直删/批量确认） | 既有 | keymapCommands.test.ts（Delete 族） |
| 取消/确认 | Esc / Enter | Esc / Enter（变换态新接） | 扩（R4.1） | transformMode.test.ts（Enter 确认单组/Esc 零 patch/拖拽中取消）；transformHandles.test.ts（工具键让位） |
| 撤销/重做 | ⌘Z/⌘⇧Z | 同 | 既有 | keymapCommands.test.ts（⌘Y 重做） |

## 4. 笔刷流量·面积落子（点 5）

### 4.1 笔刷模型

- **footprint = 圆盘**（直径=笔刷直径 mm，默认=当前规格直径；可调大于单钻——大笔刷一次扫出一条多钻宽带）；
- **流量 %**（0-100，默认 100）：格位保留概率（密度抽稀——studio S1 蓝噪/概率语义复用为客户端简化概率即可）。

### 4.2 落子算法（面积语义）

```
吸附开（默认）：
  六方格位格（pitch=当前规格 pitch，锚=格位锚钻回算既有）
  pointer move → 笔刷圆盘扫过的**新增格位集**（增量结算：上次圆盘 ∪ 新圆盘的差集）
  → 流量抽稀（概率）→ 碰撞检查（spatialIndex 既有钻 + 本笔迹批内同判）
  → 通过者落子（单 stroke 单 undo 组既有）
吸附关：
  沿笔迹中心线 pitch 间隔（现状模式）+ 圆盘碰撞检查（笔刷直径参与判距）
```

- 橡皮同模型：footprint 圆盘内**批量**擦除（替换现状单点 hitGem——PS 橡皮也是笔刷）；锁定/隐藏层跳过既有。
- 「笔刷不是一个点」的验收锚：一次拖动覆盖面积内按格位/间隔铺满（非中心线单列），宽带笔刷（直径>2×钻径）一次扫出多列。

### 4.3 笔刷设定 UI〔裁断：读数点击 popover，与画幅 popover 同族〕

- 状态栏/顶栏「笔刷 Ø mm · 流量 %」读数 → 点击弹 popover（直径 input+流量滑杆）；[ ]（画笔/橡皮下）即调直径，光标即时反映（§2）。

## 5. 智能排布退役（点 4）

- **移除**：DocBar「智能排布…」按钮、右键菜单项、`open-smart-layout` 命令、SmartLayoutPanel 组件、`smartLayoutUnderlayReady` 的 UI 消费、对应 UI 测试；TERMS/速查表同步。
- **保留冻结**：`smartLayoutGemsFromImage`（7.1 钻数组内核）+ smartLayout.svelte.ts 编排 + 内核测试零改动——归 `add-designer-selection-paths` 复用资产；收据：UI 面零引用 grep + 内核面零 diff。
- redesign-designer-workbench 的 7.1/7.2 任务标记 superseded 注记（不改已勾历史，加行注）。

## 6. 任务域界与依赖

- R1 退役（DocBar/ContextMenu/commands/SmartLayoutPanel）∥ R2 贴图渲染（Canvas 渲染循环+sprite 管线）——文件不重叠，首批并行。
- R3 笔刷流量（brushEngine/brushGesture/Canvas 笔刷事件+光标）→ R4 ⌘T+键位重映射+选择补齐（Canvas 手势/keymap/handles）——两者均重触 Canvas，**串行**。
- R5 收尾绿门（全族+check+build+护栏收据+速查/术语同步）。

## 7. 护栏

- engine/**、persistence/**、services/** 零 diff（gemCatalog/parseGemshape 只消费；sprite 烘焙属 designer 域新模块）。
- documentService 投影/导出链零改动；quickLayout 内核零改动。
- 既有测试零断言改动（新增断言独立成文件；确需显式更新逐条注明——预期：[ ] 旋转键位测试随 §3.3 重映射显式更新、brush 点落子测试随 §4 面积语义显式更新）。
