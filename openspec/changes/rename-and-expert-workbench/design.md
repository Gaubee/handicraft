# Design: 改名联动 + 专家工作台（四并行轨 + W0 后依赖轨）

> 规范性来源（冲突时按序以先者为准）：
> - Owner 裁决原文（2026-09-20 并行推进 + 2026-09-19 专家工作台需求原文，见专家稿 §0.1）
> - `.agents/documents/2026-09-19-expert-workbench-and-sizes/expert-workbench-and-sizes.md`（v1.1，下称「专家稿」；§B 专家工作台、§B.1 改名联动表）
> - `.agents/documents/2026-09-19-studio-layers/codex-review-r2.md`（R2 终审；§五 非阻塞建议「拆子模块」、§一/二 P0 闭合表）
> - `openspec/changes/add-gem-catalog-and-sizes/{proposal,design,tasks}.md`（W0/engine gate 硬前置）
> - `openspec/changes/add-project-files/design.md` §5/§10（改名移交与五段门序）
>
> 所有「现状」断言带 `源码文件:行号`（2026-09-20 源码树实测）。本 change 不宣称任何未实现内容为已完成。
>
> **口径修订登记（2026-09-20，主会话指令）**：专家稿 §A.1.1「内置形 = engine 常量，不入库、不序列化」的表述将被主会话修订为「**内置形以 .gemshape 资产入库 seed（sys-shapes）+ engine 仅留迁移 bootstrap 查表**」。本文凡涉及钻目录真源处**一律采入库口径**；该修订的正式落档由主会话在 add-gem-catalog-and-sizes 执行，本文引用处以入库口径书写。

## 0. 定位与门序

### 0.1 Owner 并行裁决（原文落档）

> 「rename-and-expert-workbench 这个理论上是可以做一些同步推进的。组件的开发、service 的开发（前端 service 的封装）、架构的开发等等」（2026-09-20）

裁决解构：本 change 内部**四轨并行**（改名/架构/组件/service，代理上限 2）+ **依赖轨排后**（消费 add-gem-catalog W0 类型与 engine gate 行为的切片）。这修改了专家稿 §E.2 原波次（原 W1 改名 → W2 工具集 → W3 钻形库 → W4 评审 的串行链）：改名与「不依赖 v2 类型的骨架/交互/接口」不必等基础层；**逐钻规格编辑等仍守 R2 五段门序**——专家稿 §I.3-2 放行条件原文「依赖基础层稳定后实现」对依赖轨继续有效，不因并行轨放宽。

### 0.2 与五段门序的关系

```
① v2 contract gate（add-gem-catalog W0）──┐
② engine gate（add-gem-catalog 1.x）─────┤
                                          ├──▶ ⑤ 本 change 依赖轨（5.x）──▶ ⑥ 收尾绿门+评审
③ replay/handoff gate（studio-layers）────┤     （5.7 物理读数另需 ③ 的贯通）
④ studio gate（studio-layers）────────────┘
本 change 并行轨（1.x 改名 / 2.x 架构 / 3.x 组件 / 4.x service）：不消费 ①-④ 任何产物，随时可启
```

- 并行轨的「零 v2 契约消费」自证：改名只动字符串与词条；架构轨只搬既有代码域；组件轨的交互（选择/框选/笔刷手势/属性面板框架/nudge/对齐分布）只消费 `EditGem` 现有字段（`x/y/colorId`，`edit.svelte.ts:126` EditGemFields 现状）与现行 `GridSpec`（`pitchMm/rowAngleDeg/pixelsPerMm`）；service 轨 W0 前用内存 mock。
- 依赖轨硬前置逐条标注（§5）；其中「保存/导出 pairwise warning 消费」是专家稿 §I.3-2 放行条件的原文义务（「编辑器保存/导出必须消费 pairwise warning」），不可裁撤。

### 0.3 显式不做（其他 change 所有）

| 不做项 | 归属 |
|---|---|
| 图层化（LayerRecord/rest 哨兵/computeLayer/历史 fold/PreviewRenderInput）、排钻设计页项目生命周期（原 add-project-files 2.1-2.5） | studio-layers |
| 实验室高级选项（水钻参数 + 蓝图）与生图生命周期（含蓝图第二请求的任务状态） | 姊妹 change add-lab-drill-params-and-blueprint（主会话定名，其 proposal 已落档；专家稿 §E.1 原名 lab-dual-mode-and-blueprint 的范围按此名承接——其「双模式/workflowMode」框架已被 Owner 2026-09-20 推翻为正交高级选项口径，本 change 引用一律从新口径） |
| 尺寸/规格数据契约本体（BaseSpec/GemSpecSnapshot/PhysicalCanvas/四格式 v2/.gemshape parser） | add-gem-catalog-and-sizes W0/engine gate |
| 「送精修」措辞、.gemdoc/「精修项目」命名、app 名「贴钻工作台」（`App.svelte:70`） | 已生效工作默认，不改（专家稿 §B.1 / gemspec R1 议题 11） |

### 0.4 钻目录真源口径（入库口径，全文有效）

- **W0 后真源** = 素材库 `sys-shapes` 系统目录中的 `.gemshape` 资产（**含内置形 seed**——内置五形 × 档位以 .gemshape 资产形式 seed 入库，用户可见可管理）；engine 侧仅保留**迁移 bootstrap 查表**（旧文档迁移时的规格补默认查表），不是运行时目录真源。
- 本 change service 轨的 mock（§4.2）从 `SS_TABLE`（`engine/grid.ts:11`）派生 round×SS 十二档——这是引擎既有常量，不依赖 W0；W0 后真源切换目标即上述 sys-shapes 资产。
- 该口径推翻专家稿 §A.1.2 目录树中「内置规格 = engine 常量，代码层真源」的表述；正式修订归主会话在 add-gem-catalog-and-sizes 落档（见头部登记）。

---

## 1. 改名批（R 轨：独立可先行，零依赖）

### 1.1 措辞联动表（现状 → 新值；rg 2026-09-20 实测定位）

| # | 位置 | 现值 | 新值 | 证据（file:line） |
|---|---|---|---|---|
| 1 | 桌面 Tab（studio） | 转化工作台 | **排钻设计** | `App.svelte:78` |
| 2 | 桌面 Tab（edit） | 手动编辑 | **专家工作台** | `App.svelte:79` |
| 3 | 移动 Tab（studio） | 工作台（泛称，违 TERMS v1 禁用词） | **排钻** | `App.svelte:156` |
| 4 | 移动 Tab（edit） | 手动编辑（4 字过长） | **专家**（2 字短名，沿「排钻」先例——专家稿 §B.1） | `App.svelte:168` |
| 5 | 动作按钮 | 送转化 | **送排钻** | `components/Lab/PreviewDialog.svelte:180` |
| 6 | toast 成功 | 已送入转化工作台 | **已送入排钻设计** | `stores/gallery.svelte.ts:496`、`stores/lab.svelte.ts:1294` |
| 7 | error 文案 | 送转化失败：… | **送排钻失败：…** | `stores/lab.svelte.ts:1285`、`:1297` |
| 8 | 来源缺失提示 | 「…请回实验室重新送转化。」 | **重新送排钻** | `stores/studio.svelte.ts:485` |
| 9 | 预览 title | 「先上传/送转化带过参考原图」 | **送排钻** | `components/Studio/StudioContextBar.svelte:176` |
| 10 | 送精修成功 toast | 已送入手动编辑（烘焙快照，与工作台参数隔离） | **已送入专家工作台（烘焙快照，与排钻设计参数隔离）**〔判断：模块名必须换；后半句「工作台」泛指在新命名体系下歧义（「专家工作台」也是工作台），顺带改为「排钻设计」消歧〕 | `components/Studio/StudioStatusBar.svelte:121` |
| 11 | 注释/头注 | 送转化、转化工作台、手动编辑 等旧词 | 同步换新词（含 handoff 语义注释） | `App.svelte:9/:40/:51`、`stores/handoff.svelte.ts:2`、`stores/view.svelte.ts:4-5`、`stores/toast.svelte.ts:2`、`stores/studio.svelte.ts:469`、`views/LabView.svelte:242`、`views/StudioView.svelte:29/:108` |
| 12 | 测试断言 | 断言中的旧词（Tab 名/toast 文案/引导行） | 同步换新词 | 11 个测试文件（§1.4 清单） |

**不改清单（显式）**：「送精修」动作与全部相关文案（`StudioStatusBar.svelte:82-427`、`edit.svelte.ts` 注释链）；「精修项目」/.gemdoc 文件格式名；编辑页空态引导「去排钻设计送精修」（`EditView.svelte:609`——**已是目标词**，现状即新词先行证据）；app 名「贴钻工作台」（`App.svelte:70`）；副标题 Rhinestone Studio。

### 1.2 移动端现状勘定

专家稿 §B.1 写「移动端 Tab 手动编辑（4 字过长，移动端现值待查证）」——本设计勘定：移动端 edit Tab 现值即「手动编辑」（`App.svelte:168`），4 字；移动端 studio Tab 现值「工作台」（`App.svelte:156`）——add-project-files 5.1 移交后改名一直未执行，TERMS v1 注册的「排钻」短名至今未落地。本批一并改齐。

### 1.3 TERMS v2 / PRODUCT_MODEL v4 升版（登记为任务）

- **TERMS v2**：① 词条「手动编辑」改写为「专家工作台 = 钻级编排与精修模块」，禁用词改为「手动编辑、精修编辑器」（「手动编辑」加入禁用词——历史名退役）；② 新增词条「专家 = 专家工作台的移动端短名」；③ 词条「排钻设计」禁用词由「转化工作台、工作台」调整为「转化工作台」——「工作台」从禁用词移除（被「专家工作台」合法占用），但独立使用「工作台」仍不注册（避免歧义，专家稿 §B.1 冲突消解 + §H-5 摩擦登记）；④ 头部版本行 v1→v2 登记本次变更。
- **PRODUCT_MODEL v4**：一句话「手动编辑做『钻级精修』」→「专家工作台做『钻级编排精修』」；对象树两处「手动编辑」节点标注（.gemdoc 行、导出 PNG 行）；硬规则 3「手动编辑成果不回流排钻管线」措辞同步；真源表「钻面文档」行使用位置同步；版本行 v3→v4 登记。
- 升版时机：**随 R 轨落地即升**（TERMS 是措辞真源，代码改齐与词表升版同一 PR 内完成，不留双真源窗口）。

### 1.4 grep 验收口径

- `rg '转化工作台|送转化' rhinestone-studio/src` → **零命中**（含注释与测试）。
- `rg '手动编辑' rhinestone-studio/src` → **零命中**（禁用词）。
- `rg '工作台' rhinestone-studio/src` → 残留白名单仅：app 名「贴钻工作台」（`App.svelte:70`）、「专家工作台」合法组合、以及与本 change 无关的历史注释中的泛指（**不强制全库注释大改**——〔判断〕验收只覆盖三个退役词；泛称「工作台」注释清理仅在同文件因 R 轨触及时顺带消歧，避免改名批膨胀为注释考古工程）。
- 全量 vitest 绿（断言联动后）；TERMS/PRODUCT_MODEL 版本行核对。

---

## 2. 架构轨（A 轨：store 拆非图层域子模块，零行为变化）

### 2.1 现状与动机

- `studio.svelte.ts` **1091 行**，域分布（2026-09-20 实测节标）：常量 :51 / 模块状态 :108 / 派生量 :158 / 读取器 :250 / **图像载入 :349** / 分块防抖 :564 / 块覆写 :660 / 色板 :740 / 五策略布局 :768 / **导出 :928** / **送精修构造 :960** / **PNG 入库 :1008** / 测试支持 :1045。
- `edit.svelte.ts` **752 行**，域分布：契约类型 :47 / patch 三原子 :122（`:126` EditGemFields）/ 模块状态 :154 / **载入 :208** / 读取器 :264 / 图层选择 :306 / patch 应用与撤销 :340 / **gemdoc 生命周期 :479** / 项目身份 :717 / 测试支持 :734。
- R2 §五非阻塞建议原文：「先把 studio.svelte.ts 拆成 layers、history、computeQueue 子模块，避免图层/历史/队列继续堆入单一 `$state` 文件」。

### 2.2 拆分边界（与 studio-layers 的协调协议）

**裁决**：R2 建议中的 layers/history/computeQueue 三域是 studio-layers 图层化的**重写域**（LayerRecord/computeLayer/历史 fold 将改变其形态）——本 change 不拆它们（避免同一域两次手术）；本 change 只拆**与图层无关**的域。studio-layers 立项后若其 DAG 与本轨实施窗口相撞，以其五段门序为准串行（③④ 段在 ①② 之后，本轨先行不阻塞其重写——被拆出的非图层域恰是图层化**不会重写**的部分，拆分降低而非增加其冲突面）。

| 源 | 新模块（`*.svelte.ts`，$state 宿主纪律） | 搬迁域（现状行界） | 不搬内容 |
|---|---|---|---|
| studio.svelte.ts | `src/lib/studio/imageSource.svelte.ts` | 图像载入域（:349-560）：解码/≤1024 降采样/素材库选择/上传/测试直灌 | — |
| studio.svelte.ts | `src/lib/studio/exportSink.svelte.ts` | 导出编排（:928-959 SVG/BOM）+ PNG 入库（:1008-1044） | — |
| studio.svelte.ts | `src/lib/studio/editHandoff.svelte.ts` | 送精修构造（:960-1007）：buildManualEditHandoff/sourceSummary | — |
| edit.svelte.ts | `src/lib/edit/gemdocLifecycle.svelte.ts` | 载入（:208-263 loadFromHandoff/pin）+ gemdoc 保存/打开/关闭/另存为/导出（:479-716） | patch/undo/选择/图层 |
| edit.svelte.ts | `src/lib/edit/documentStatus.svelte.ts` | 文档态：dirty/docId/blobKey/lease（:154-192 相关状态位）+ 身份读取器/重命名（:717-733） | 同上 |

studio 的「文档态」（项目身份/dirty）**无现状可拆**——add-project-files 2.1-2.5 已移交 studio-layers 且未实现（其 tasks.md:54-57 全未勾选）；登记为「不拆，归 studio-layers」。

### 2.3 零行为变化护栏

1. **公共 API 面不变**：两 store 的既有 `export` 签名零变化——组件与既有测试零改动（子模块符号经 store 根文件 re-export 兼容；`pnpm check` 证明无消费方破坏）。
2. **行为等价证明**：既有测试全绿且**零断言改动**（studio 族：pipeline/interactions；edit 族：lifecycle/undo/quickLayout/edit.store/editUnbound/editReferenceAsset）+ 同参快照（quickLayout 同参同出、gemdoc round-trip 字节等价既有测试即护栏）。
3. **单向依赖**：子模块只依赖 store 核心 $state 与 engine/persistence 公共面；子模块间禁止互相 import（防循环）；store 根只做聚合 re-export。
4. **$state 宿主纪律**：搬迁含 `$state`/`$derived` 的域必须落在 `.svelte.ts` 文件（Svelte 5 runes 模块约束）。

---

## 3. 组件轨（C 轨：专家工作台 UI 骨架，不依赖 v2 类型）

### 3.1 现状

- `EditCanvas.svelte`（571 行）：四层合成只读画布（painting/reference/blocks/gems）+ 滚轮光标锚缩放/平移（头注 1-2）+ **点选命中**（:263 tap → queryCircle r=1.5×钻半径 → 最近者入 selection）。
- edit store：selection API（`setSelection/toggleSelection/clearSelection`，`edit.svelte.ts:324-337`）、stroke 组机制（`beginStroke/endStroke`，:445/:451）、update patch（EditGemFields 现状 `x/y/colorId`，:126）。
- **缺**：框选/多选 UI、笔刷工具（画钻/擦除）UI、属性面板、对齐分布、nudge——add-manual-edit-mode tasks §5/§6 全未落地（其 tasks.md 无勾选）。

### 3.2 布局骨架（类 PS 四区；专家稿 §B.2 布局图的 P0 骨架化）

```
┌────────────────────────────────────────────────────────────────┐
│ [▦] 文档名 ●未保存 │ 工具: ▢选择 ✚画钻 ⌫擦除 │ snap:◎格位 ○自由 │ ⌘Z ⌘⇧Z │
├────┬────────────────────────────────────────────┬──────────────┤
│工具│                                            │ 属性面板       │
│ 栏 │        画布（四层合成 + 选择/笔刷层）        │  空态/单选/N选 │
│    │   框选矩形 · 笔刷光标 · 吸附格位高亮         │  字段框架      │
│ 选 │                                            ├──────────────┤
│ 画 │                                            │ 图层面板       │
│ 擦 │   状态条: N 钻 · [画幅读数位·预留]           │  四层显隐/透明 │
└────┴────────────────────────────────────────────┴──────────────┘
```

- 四区 = 工具栏 / 画布 / 属性面板 / 图层面板（右侧现有图层/计数面板迁入图层面板位，显隐/透明度控件沿用 `edit.svelte.ts:312-318` 语义）。
- **属性面板是选中对象的属性（PS Inspector 语义）**，不是管线参数面板——add-project-files §4「编辑器永不长参数面板（概念混入禁令）」沿用（专家稿 §B.4 边界重述）。
- 状态条画幅读数位预留（依赖轨 5.7 接 PhysicalCanvas 真值；W0 前不显示假值——〔判断〕读数缺真源时宁缺毋滥，避免 2.5 缺省锚被误读为声明值）。
- 响应式：桌面四区；移动端属性/图层面板折叠为底部抽屉（骨架期先折叠隐藏，不做完整移动交互）。

### 3.3 逐钻选择 / 框选 / 多选

- 点选（现状沿用）+ **Shift 点选**加选/减选（toggleSelection 已备，:330）+ **框选**（marquee 矩形手势 + 相交命中收集 → setSelection；命中查询走编辑器私有空间索引 `edit/spatialIndex.ts`，现状 queryCircle 之外补矩形查询或逐钻遍历——1 万钻 60fps 基线内实现自选）+ Esc 清空。
- 多选反馈：属性面板标题「N 颗已选」；选择集合变化驱动面板重渲染（响应式经 SvelteSet，现状 `edit.svelte.ts:97` selection 即 SvelteSet）。
- 批量属性修改（改色先行——现状 EditGemFields 允许；改形/尺寸/旋转待依赖轨）= **一个 undo 组**（beginStroke/endStroke 组机制复用）。

### 3.4 笔刷交互原型（手势层，算法后接）

- 工具态：选择/画钻/擦除三态（工具栏驱动；画布手势按工具分派——现状 pointer 手势 :520-523 只服务平移/点选，扩展为工具分派层）。
- 画钻手势：pointerdown 起笔 → move 连线 → up 收笔；**笔刷光标预览**（当前笔刷尺寸圈）；**吸附格位指示**（当前位置吸附到六方格位的高亮标记——格位计算用现行 `GridSpec` pitch/rowAngleDeg 画临时格，W0 后随当前 spec 的 pitch 重算，算法归依赖轨 5.5）；snap 开关（格位/自由，专家稿 §B.3）。
- 擦除手势：同画钻手势，命中即删。
- 手势层产出抽象为「笔刷意图流」（落点序列 + 工具 + snap 态），**算法消费接口预埋**——W0 前手势层可独立走查（落点指示/光标/吸附高亮可见），落钻行为接依赖轨。

### 3.5 属性面板框架（字段渲染框架）

- 字段描述符 → 控件渲染：`{ key, label,控件类型, 值读取器, 值写入器, undo 组策略 }`；写入统一走 update patch（N 选批量 = 单组）。
- 三态显示：空态（未选中，占位引导）/ 单选（全字段）/ N 选（显示公共可编辑字段 + 混合值占位「—」）。
- 规格字段位（形状/尺寸/朝向）**预留不实现**——控件注册表留空位，依赖轨 5.1 注册（消费 W0 的 EditGemFields 扩展）。

### 3.6 nudge 微移与对齐分布（〔裁断〕归组件轨）

- **裁断**：nudge 与对齐分布只消费 `x/y` 与现行 GridSpec（1px / pitch 步进 / 0.1mm×pixelsPerMm——`PIXELS_PER_MM=2.5` 现值 `studio.svelte.ts:56`、grid 自带 pixelsPerMm），**零 v2 类型依赖**，故归组件轨不必排后（专家稿 §B.2 P0 工具集；若 Owner 要求保守可移依赖轨，交互契约不变）。
- nudge：方向键 1px；Shift+方向 = 当前 grid pitch 步进；Alt+方向 = 0.1mm；**按键会话合组 undo**（keydown 起至 500ms 无新按键为一组——专家稿 §B.2）。
- 对齐：多选 ≥2，左/右/上/下/水平居中/垂直居中；分布：≥3，水平/垂直等距。批量变换 = 一个 undo 组。

---

## 4. service 轨（S 轨：前端 service 封装层）

### 4.1 现状与定位

无 service 层：组件直连 store/persistence/assetStore（StudioStatusBar :82-121 内联送精修与导出 busy 编排；EditView 内联打开链路）。**定位**：service = 无 UI 依赖的用例编排层（接口 + 可注入依赖 + 内存 mock 可测）；**状态真源恒在 store**——service 不复制状态、不新增第二真源（PRODUCT_MODEL 硬规则 2 精神）。

### 4.2 gemCatalogService（钻目录 service）

```ts
// src/lib/services/gemCatalogService.ts
export interface CatalogSpec {          // W0 前本地最小结构类型
  specKey: string                       // 'round-ss10'（确定性生成规则与 W0 specKey 一致）
  shapeId: string                       // W0 前恒 'round'
  sizeLabel: string                     // 'SS10'
  diameterMm: number                    // SS_TABLE[ss]
}
export interface GemCatalogService {
  listSpecs(): Promise<CatalogSpec[]>
  resolveSpec(specKey: string): Promise<CatalogSpec | undefined>
}
```

- **mock（W0 前）**：round × SS_KEYS 十二档，自 `SS_TABLE`（`engine/grid.ts:11`）派生；确定性/幂等单测。
- **真源（W0 后，依赖轨 5.6 切换）**：sys-shapes `.gemshape` 资产（**含内置形入库 seed**——§0.4 口径）；engine 迁移 bootstrap 查表仅兜旧档迁移，不是运行时真源。接口签名不变，实现替换；`CatalogSpec` 届时对齐 canonical `GemSpecSnapshot`（结构超集，赋值兼容）。
- 消费方：规格选择器（5.3）/ 校准向导参考规格列表（5.4）/ 笔刷当前 spec（5.5）——一律只依赖接口。

### 4.3 documentService（文档 service：打开/保存/导出编排）

```ts
// src/lib/services/documentService.ts（依赖注入：edit store 状态面 + persistence + assetStore）
export interface EditDocumentService {
  openFromLibrary(assetId: string): Promise<OpenResult>   // parse blob → store 载入 → lease/pin 编排
  save(): Promise<SaveResult>                              // serialize → CAS 换绑 → dirty 清零（失败注入可测）
  saveAs(name: string): Promise<SaveResult>                // fork：恒 ingest 新节点
  exportGemdoc(): ExportResult                             // 只序列化不落库（导出不清 dirty——契约沿用）
  exportSvg / exportBom / exportPng: ...                   // 导出编排（engine export + 下载/入库 + busy 态回调）
}
```

- 收敛现状内联编排（StudioStatusBar/EditView）为可测用例函数；守卫确认（dirty 三按钮）仍归 UI（service 返回需守卫信号，不弹窗）。
- 与 edit store 既有函数（`edit.svelte.ts:479-716` saveGemdoc 族）的关系：store 保持底层 API 与状态真源；service 是跨 store+persistence+assetStore 的编排壳，**不重写 store 逻辑**。

### 4.4 generationService（接口位，零实现）

- `src/lib/services/generationService.ts`：仅 interface 骨架（发起/进度/取消/结果档案的生命周期形状**留空待冻结**）+ 归属注释「生命周期契约由姊妹 change add-lab-drill-params-and-blueprint 定义，本 change 只占接口位」。禁止预填字段（避免与姊妹 change 契约 gate 抢真源）。

---

## 5. 依赖轨（D 轨：排后；硬前置逐条标注）

| # | 切片 | 硬前置（add-gem-catalog tasks 编号） | 内容 |
|---|---|---|---|
| 5.1 | 属性面板规格字段注册 | W0 0.1（GemSpecSnapshot）+ engine gate **1.4**（EditGemFields 扩展 shapeId/diameterMm/rotationDeg） | 形状/尺寸/朝向三字段控件注册进 3.5 框架；改尺寸后**立即 pairwise 重校验**（实时警告不阻断——消费 1.2 混合径 validateEditable）；批量 = 单 undo 组 |
| 5.2 | 保存/导出 pairwise warning 消费 | engine gate **1.2**（exportGate 纯函数） | 保存允许 warning（文档可存）、**导出硬阻断**（违规清单 UI）；load 后与改径/改形后立即重算 warning——专家稿 §I.3-2 放行条件原文义务 |
| 5.3 | 规格选择器 | W0 + 2.x 资产化（sys-shapes seed） | 顶部「当前 spec」选择器（形/尺寸下拉 + 色板色——专家稿 §B.3）；数据源 = gemCatalogService 真源 |
| 5.4 | 自定义钻形校准向导 UI | W0 0.4（.gemshape schema gate 六条）+ 2.2 面 8（校准数据面） | 三步向导（选贴图 → 物理尺寸 direct/reference 二选一 → 命名入库）；烘焙校准语义（calibration 只记出处）；missing/超限/比例漂移 typed 错误的 UI 呈现 |
| 5.5 | 笔刷算法落地 | W0 + 1.4 | 画钻 = 当前 spec 物化（shapeId/diameterMm/colorId，origin='manual'）；吸附六方格位 = 当前 spec pitch 格位；冲突拒画闪红（pairwise 判据）；擦除沿用；消费 3.4 手势层意图流 |
| 5.6 | gemCatalogService 真源切换 | 2.x（sys-shapes seed 落地） | mock → sys-shapes .gemshape 资产；切换点单测（同 specKey 解析等价）；mock 退役为测试夹具 |
| 5.7 | 画幅物理读数接线 | replay/handoff gate（studio-layers ③：PhysicalCanvas 贯通 EditDocument） | 状态条读数位接真值（画幅 mm + px/mm，anchorSource 区分显示） |

---

## 6. 测试策略

- **R 轨**：§1.4 grep 收据 + 全量 vitest 绿（断言联动）+ TERMS/PRODUCT_MODEL 版本行核对。
- **A 轨**：公共导出面 diff 为零（或 re-export 兼容证明）；既有测试全绿零断言改动；同参快照（quickLayout 同参同出、gemdoc round-trip 字节等价）。
- **C 轨**：jsdom pointer 序列模拟（框选命中/Shift 加选/笔刷起收笔/nudge 键序）；undo 组语义（nudge 500ms 会话合组、批量单组）；布局响应式冒烟；1 万钻选择/框选性能抽查（60fps 基线沿用 add-manual-edit-mode §4.2）。
- **S 轨**：mock 单测（listSpecs 确定性/resolveSpec 幂等）；documentService 编排成功/失败注入（CAS conflict/parse 失败/lease 过期）；generationService 仅类型编译。
- **D 轨**：规格字段 round-trip（改形/改径/旋转 → gemdoc 序列化回读）；pairwise UI 态（保存放行+徽标、导出阻断+清单）；笔刷物化断言（shapeId/diameterMm/colorId/origin='manual'/落位格心）；校准向导 direct/reference 两模式烘焙语义（参考钻后续改动不影响已入库 physical）。

## 7. 议题与未决

| # | 议题 | 状态 |
|---|---|---|
| 1 | nudge/对齐分布归组件轨还是依赖轨 | 〔裁断〕组件轨（零 v2 依赖，§3.6）；Owner 可复议移 D 轨，交互契约不变 |
| 2 | service mock 的 W0 后去留 | 切换后 mock 退役为 vitest 夹具（5.6）；不保留双实现并存 |
| 3 | 状态条画幅读数 W0 前显示缺省 2.5 还是留空 | 〔裁断〕留空（§3.2——缺真源不显示假值）；Owner 可改「显示 2.5 并标注缺省」 |
| 4 | 泛称「工作台」注释清理深度 | 〔裁断〕仅三个退役词强制清零；泛称注释顺带消歧不强制（§1.4） |
| 5 | studio-layers 未立项窗口相撞 | 以五段门序为准串行（§2.2 协调协议）；本轨拆分域与其重写域互斥，先行不冲突 |
