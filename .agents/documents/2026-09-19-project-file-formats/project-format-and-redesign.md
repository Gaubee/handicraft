# 项目文件格式（排钻项目 / 精修项目）+ 排钻页改名与两页重构

- 日期：2026-09-19
- 作者：产品（PM 子代理）；讨论对象：Codex 评审闭环 + 编排者；定稿后切片进 OpenSpec change
- 状态：**讨论稿**——§E 议题清单未裁决前不作为实现依据
- 输入：真实源码（`rhinestone-studio/src/`，2026-09-19 版，行号均为当日实测）+ Owner 三项需求原文 + `PRODUCT_MODEL.md` v2 + 三个已落地 change 的 design.md（add-asset-library / add-manual-edit-mode / redesign-studio-layout）+ 素材库设计稿（2026-09-19）
- 方法论出处（一手文件）：
  - 定框：`~/.agents/references/design-skills/skills/product-discovery-and-framing/SKILL.md`
  - 信息架构：`~/.agents/references/design-skills/skills/information-architecture/SKILL.md`
  - 交互行为结构：`~/.agents/references/design-skills/skills/interaction-design/SKILL.md`
  - 命名/文案：`~/.agents/references/design-skills/skills/content-design/SKILL.md`
  - 视觉红线（线框自查）：`~/.agents/references/ojo-design-skills/skills/app-ui-ux-best-practices/references/anti-patterns.md`
- 证据分级：源码行号 = 一手事实；Owner 原话 = 用户一手；行业术语检索 = 公开数据（中等置信，来源见 §B）；行为收益判断 = 标注「判断」+ 置信度
- 视觉基调：工具型产品，Convention 赛道（沿前两版判定）；**本文只做结构/数据/交互规范与线框，不产出 token/视觉终稿**（同前版声明）
- 产品模型：本设计与 `PRODUCT_MODEL.md` v2 冲突处已在 §C.4 提出 v3 增补草案，裁决前以 v2 + 本文标注的「契约豁免申请」并行阅读

---

## 0. 决策框架（framing）

**决策句**：为贴钻工作台裁定——(a) 两种「项目文件」的数据格式与生命周期语义（排钻项目 = 转化工作台的参数工程；精修项目 = 手动编辑的烘焙文档）；(b) 「转化工作台」的行业直觉改名；(c) 两页围绕「项目文件」的产品重构与素材库联动方式。截止：随新 OpenSpec change 进入实现。

**问题框定**：

1. **会话态即黑洞**：排钻页的全部工作状态（来源图/分块参数/块覆写/物理/色板/策略，`studio.svelte.ts:110-143`）与手动编辑的全部工作状态（`edit.svelte.ts:100-112`）都是模块级内存 $state——刷新即全部丢失，跨会话无法续作，跨设备无法带走。素材库解决了「图片资产」的真源问题（PRODUCT_MODEL v2），**「工作成果」仍无真源**。
2. **手动编辑是死胡同入口**（Owner 定性：concept error）：唯一进入方式 = 排钻页「送精修」（`view.svelte.ts:6-7` 注释「进入编辑器必须经『送精修』显式交接」；`EditView.svelte:104-119` 空态只有一个按钮「回工作台送精修」）。一张已在本库的图片想逐钻精修，必须先过排钻调参之旅——对「朋友（手艺人）」画像是强制性绕路。
3. **「转化工作台」名不达意**：「转化」描述的是管线中间态动作（图→钻位），不是用户心智里的行业动词；且与 app 名「贴钻工作台」共享「工作台」三字造成移动端 Tab 只能退化成泛称「工作台」（`App.svelte:63/141`）。

**非目标**：不做云同步/协作；不做项目版本历史树（P2 议题）；不改引擎算法与确定性语义（只消费）；不改变送精修烘焙原则本身（只做文件化与入口扩展）；不动实验室模块（仅文案联动）。

**成功标准（主指标各一，基线为 0，首发后校验目标值）**：

- 排钻页：刷新后续作率——曾保存 ≥1 个排钻项目的用户，次日会话经「打开项目/最近项目」续作的比例（目标 ≥40%，判断值）。
- 手动编辑：独立进入占比——从「素材库选图/打开精修项目」进入的编辑会话比例（目标 ≥30%，验证解绑成功；判断值）。
- 护栏：三模块管线回归零破坏；1 万钻画布 60fps；素材库现有测试全绿（AssetNode 扩展不回归）。

---

## §A 两种项目文件格式

### A.0 命名与文件家族（先定名，schema 用同词）

| | 格式 1 | 格式 2 |
|---|---|---|
| 对外类型名 | **排钻项目** | **精修项目** |
| 扩展名 | **`.gemproj`** | **`.gemdoc`** |
| MIME | `application/vnd.rhinestone-studio.gemproj+json` | `application/vnd.rhinestone-studio.gemdoc+json` |
| 本质 | 参数工程（菜谱） | 烘焙文档（成品稿） |
| 图标语义 | 网格蓝图 motif（蓝本/参数感，浅描线） | 钻面文档 motif（钻点笔触，实心感） |
| 体积量级 | <20KB（纯 JSON 参数） | 0.2–1.5MB（含底图 PNG + 钻位数组） |

命名理由：
- 家族前缀 `.gem*` 与引擎核心对象 `Gem`/`EditGem`（`engine/types.ts:68/79`）同词，代码词汇与用户词汇零翻译成本；`proj`/`doc` 后缀对仗「工程/文档」的心智差异——前者可再算、后者已定稿。
- 对外称谓与 §B 改名联动：排钻项目在「排钻设计」页保存，精修项目在「手动编辑」页保存，一页一格式，无第三种组合（结构性约束，见 §C.4 硬规则）。
- 撤回候选：`.stoneproj/.stonedoc`（更"行业"，但产品英文标识一直是 rhinestone/gem 双轨，gem 更短且已内化）；`.rsproj`（rs 缩写歧义大）。

### A.1 格式 1：排钻项目 `.gemproj`（参数工程）

#### A.1.1 定位裁决：参数工程，不是快照

**裁决：`.gemproj` 只存「来源图 + 参数」，钻位永不入文件；打开 = 确定性引擎重放。**

论证（证据等级：一手事实 + 推导）：
1. **产品模型一致性**：PRODUCT_MODEL v2 明文「工作台（真源=参数：块覆写/物理/色板）」。快照格式会让文件成为第二真源，与「真源=参数」直接冲突——这是结构性失败（硬规则 2 的镜像案例）。
2. **引擎确定性是既有不变量，不是新增假设**：`rng.ts:3`「全引擎唯一随机源：mulberry32 PRNG + 整数坐标哈希（同 seed 逐位重放，禁 Math.random）」；`layout/index.ts:29-31`「排布主入口（纯函数，同输入同输出）」；`segment.ts:4`「固定 seed 的 k-means++ 初始化 + 光栅序全流程，同输入同输出」。参数工程的可重放性是引擎从第一天就付费维持的性质，项目文件只是第一次真正消费它。
3. **体积与可维护性**：五策略钻位全量（10k 钻 × 5 策略 × 每钻 ~60B）≈ 3MB+，且每次调参都要重写；参数 JSON <20KB 且天然可 diff、可手改（Owner 画像：JSON 友好）。
4. **「恒可重算」是资产安全的来源**：来源图缺失时参数仍可读、可重绑（§C.1 状态矩阵「来源缺失」态）——快照格式在该场景下只能整体报废。

**重放漂移语义（引擎版本升级后同参数产出不同钻位）**：
- 文件记 `engineVersion`（引擎侧需新增常量，见迁移成本）；打开时与当前版本不等 → 黄色横幅「此项目由旧版引擎创建，打开后将按当前引擎重算钻位；若块覆写失效会逐项列出」+ 可展开的覆写存活清单。**不做「冻结旧结果」选项**——需要冻结的用户出口是导出 `.gemdoc`（钻位从此不再重算），两格式各司其职。
- 推导常量（`SEGMENT_GEM_DIAMETER_PX`、`minAreaFor` 算式，`studio.svelte.ts:59-61/549-551`）**不冻结入文件**：它们是引擎行为的一部分，冻结了实时管线也消费不了（live 路径每次现算）。它们的演进归入 engineVersion 语义。文件只存用户可调参数全集。
- **块 id 跨版本不稳定是一手事实**：块 id = `b${c}-${compIdx}`（`segment.ts:232`），`c` 是 k-means 聚类序、`compIdx` 是光栅序连通域序——同引擎同输入稳定，跨引擎版本可能洗牌 → 覆写键悬空。P0 处理：复用 `pruneStaleOverrides`（`studio.svelte.ts:628-634`）+ 打开时横幅清点「N 项块覆写因重分块失效已移除」；P1 增强：按掩码内容哈希匹配迁移覆写（议题 6）。

#### A.1.2 Schema（TS interface 级草案）

```ts
// lib/persistence/projectFile.ts（新建；序列化/反序列化/版本迁移唯一出口）

/** 格式 1：排钻项目（参数工程——钻位 = 引擎(来源图 + 本文件参数) 的确定性重放产物） */
export interface GemprojFile {
  kind: 'gemproj'
  formatVersion: 1                 // 文件结构版本（schema 迁移依据，≠ engineVersion）
  appVersion: string               // 序列化方 app 版本（溯源）
  engineVersion: number            // 序列化方引擎版本（重放漂移提示依据；引擎需新增 ENGINE_VERSION 常量）
  createdAt: number
  savedAt: number
  name: string                     // 项目名（默认 = 来源图名去扩展名）

  /** 来源图：库内引用（保存/另存为到库）或内嵌（导出文件到磁盘时烘焙）——见 A.1.3 裁决 */
  source: GemprojSource
  /** 叠放参考原图（可选；仅库内有意义，文件导出时保留 assetId 缺失容忍） */
  reference?: { assetId: string; name: string }

  /** 分块参数（用户可调全集；minArea/gemDiameter 等推导常量不冻结，归引擎版本语义） */
  segment: { k: number; seed: number }

  /** 块级覆写全集（键 = 引擎块 id；显式覆写语义原样保留——含恰为 1.0 的密度覆写） */
  overrides: {
    disabled: Record<string, true>          // studio.svelte.ts:121 disabledIds
    density: Record<string, number>         // studio.svelte.ts:123 densityOverrides（注意：≠ getDensitySpec 的省略形态，存显式覆写全量）
    type: Record<string, BlockType>         // studio.svelte.ts:124
    color: Record<string, string>           // studio.svelte.ts:126（值 = 色板条目 id）
  }

  /** 全局物理参数 */
  physics: {
    ss: SSKey
    gapMm: number
    globalDensity: number                   // studio.svelte.ts:128
    relax: { boundary: boolean; repulsion: boolean }
  }

  palette: PaletteColor[]                   // studio.svelte.ts:133 色板全量（用户可能增删改过）
  activeStrategy: StrategyId                // 当前导出策略（studio.svelte.ts:136）
}

export type GemprojSource =
  | { kind: 'asset'; assetId: string; name: string; width: number; height: number; downscale: number }
  | { kind: 'embedded'; name: string; mime: string; dataUrl: string; width: number; height: number; downscale: number }
```

明确**不入文件**的量：五策略 `results`（重放产物）、`previewMode/overlayOpacity`（取景/预览是会话视图态，默认值重置零成本）、`selectedBlockId`（交互瞬态）。

#### A.1.3 来源图：assetId 引用 vs 自包含内嵌 —— 双形态裁决

**裁决：`source` 是判别联合——库内保存用 `asset` 引用，导出文件到磁盘时自动转 `embedded`（把资产 blob 烘焙为 dataUrl）。**

| 方案 | 可移植性 | 体积 | 与素材库关系 | 裁决 |
|---|---|---|---|---|
| 仅 assetId 引用 | 差（出库即断链） | 最小 | 完美（不可变资产→引用，PRODUCT_MODEL 交接语义） | 库内形态 ✅ |
| 仅内嵌 | 好 | 每项目 +0.2–2MB | 破坏去重（同图多项目重复存储） | 仅导出形态 ✅ |
| 双形态（本案） | 好 | 库内零冗余 | 引用语义 + 出口烘焙 | **采纳** |

理由：
- 库内（IndexedDB 会话）重放链已经存在且被验证：`loadFromLibrary` 经 `getAssetBlob` 解析 → 解码管线（`studio.svelte.ts:423-438`）。引用形态零新增机制。
- 「不可变资产 → 引用；派生/出口产物 → 烘焙」是 PRODUCT_MODEL v2 交接语义的直接套用（与 handoff v2 / referenceAssetId 同构）。
- 内嵌只在**序列化为可带走的文件**时发生一次，dataUrl 只存在于文件字节中，不驻留内存 store（同 handoff v2 的 dataUrl 中转纪律）。
- 内嵌的是**原始图字节**（资产 blob 原样），不是降采样后像素：重放 = 解码→降采样→分块，与 live 路径完全同链（`imageToEngineImage`，`studio.svelte.ts:349-364`）。`downscale/width/height` 是校验/展示元信息。
- 已知边界（判断，置信度中）：canvas `drawImage` 降采样跨浏览器不保证逐位一致 → 跨设备重放可能有边缘像素级漂移→ 块 id 可能洗牌。这与引擎版本漂移同属「参数工程的承诺边界」：**承诺参数与来源，不承诺逐颗钻位跨环境冻结**。横幅语义覆盖之；`paintingHash`（重放前校验哈希）留作 P1 可选增强。

### A.2 格式 2：精修项目 `.gemdoc`（烘焙文档）

#### A.2.1 Schema（TS interface 级草案）

```ts
/** 格式 2：精修项目（烘焙快照——自包含、独立可开、不依赖格式 1 或任何资产存在） */
export interface GemdocFile {
  kind: 'gemdoc'
  formatVersion: 1
  appVersion: string
  engineVersion: number            // 溯源信息（gemdoc 不重放，不参与正确性）
  createdAt: number
  savedAt: number
  name: string                     // 默认「精修 · <来源摘要>」

  width: number
  height: number
  grid: GridSpec                   // engine/types.ts:111（导出/校验必需）
  palette: PaletteColor[]

  /** 唯一真源：钻位全量（origin/moved 语义原样；手工钻 id 'm-' 前缀保留） */
  gems: EditGem[]                  // engine/types.ts:79

  /** 只读参考块（mask.bits 序列化为 base64；编辑器不改，重排块策略填充消费） */
  blocks: SerializedBlock[]        // Block 的可 JSON 化形态：{ ...Block, mask: { w,h,bits: base64 } }

  /** 固定四层显隐/透明度（文档态，非瞬态） */
  layers: Record<'painting'|'reference'|'blocks'|'gems', { visible: boolean; opacity: number }>

  /** 底图：内嵌 PNG（烘焙裁决见 A.2.2） */
  painting: { mime: 'image/png'; dataUrl: string; width: number; height: number }

  /** 参考原图：可选资产引用（缺失容忍——独立可开要求） */
  reference?: { assetId: string; name: string }

  /** 溯源（展示用；不参与重放） */
  provenance: {
    origin: 'studio-bake' | 'quick-layout' | 'blank'   // 送精修烘焙 / 图片直入快速排稿 / 空白画布(P1)
    sourceSummary: string                              // '六方抽稀 · 密度 62% · SS10 · 2,341 钻' 等（studio.svelte.ts:934-938 同口径）
    sourceAssetId?: string                             // 弱引用（可选溯源跳转）
    gemprojAssetId?: string                            // 若从某排钻项目烘焙，记其资产 id（弱引用，展示「来源项目」）
  }
}
```

明确**不入文件**：`selection`（交互瞬态）、撤销/重做栈（A.2.3）、`manualCounter`（加载时从 gems 派生：`max(m-编号)+1`，单一真源原则；`nextManualId` 的防御性跳撞逻辑 `edit.svelte.ts:207-211` 兜底）。

#### A.2.2 底图像素三方案权衡

| 方案 | 独立可开 | 精确性 | 体积 | 依赖风险 | 裁决 |
|---|---|---|---|---|---|
| ① 内嵌像素（PNG 压缩） | ✅ | ✅ 逐位还原 | 0.1–0.5MB（数字油画是 k 色平涂，PNG 压缩率极高；判断值，待实测） | 无 | **采纳** |
| ② 引用格式 1 来源重推导 | ❌ 依赖 gemproj | △（跨浏览器降采样漂移，A.1.3） | 最小 | 链式依赖（来源资产→解码→降采样三跳全活） | 否决：违背「独立可开」硬要求，且重推导不保证逐位一致 |
| ③ 仅素材 assetId 引用 | ❌ 依赖资产存活 | △ 同上 | 最小 | 资产删除即底图消失 | 否决：同上；但作为 provenance.sourceAssetId 弱引用保留 |

**烘焙原则的准确边界**（PRODUCT_MODEL v2「派生数据→烘焙」）：烘焙保护的是「编辑器文档不随工作台参数变化」——底图作为文档的组成部分必须随之冻结；参考原图是不可变资产，引用不破坏快照语义（C-1 修订已裁决的先例，`add-manual-edit-mode/design.md` §1）。本案把同一刀法切到底图：**底图=文档内容→烘焙；参考原图=外部不可变资产→引用**。

参考原图保留 assetId 引用而非内嵌：四态解析器（loading/ready/missing/soft-deleted）已落地（add-asset-library §5 手动编辑接入），missing 不阻断文档打开（painting 层独立存在）。

#### A.2.3 撤销栈不入文件（两格式一致）

**裁决：撤销/重做栈永不序列化。** 理由：
1. 撤销是**交互历史**不是文档状态；文档真源 = gems（PRODUCT_MODEL：EditDocument.gems 唯一真源）。
2. 体积：patch 三原子携带完整 gem 副本（add/remove），100 组预算（`edit.svelte.ts:91`）× 巨型组 ≈ 文件体积翻数倍。
3. 行业基线（Baseline 层）：主流文档工具不跨会话持久化撤销栈（PSD 不存 history、Figma 文件不存 undo）；跨会话 undo 不是本品类用户预期。
4. `MAX_STROKE_GEMS`（2000）防御门（`edit.svelte.ts:93`）语义在会话内自洽即可。

**连锁修正（必须随格式落地，否则语义破洞）**：`hasEdits() = undoCount>0`（`edit.svelte.ts:189-192`）在「保存后继续编辑」「重开文件」场景下失真。新增 `dirty`（自上次保存以来有修改）作为守卫/徽标/覆盖确认的统一口径；`undoCount` 回归纯撤销可用性。文案从「有未导出修改」改「未保存」（导出不清除 dirty——导出≠保存）。

### A.3 格式 1 → 格式 2 导出（送精修的文件化）

现有「送精修」= 内存内 `buildManualEditHandoff()`（`studio.svelte.ts:946-965`）→ `loadFromHandoff` 深拷贝（`edit.svelte.ts:147-171`）。文件化后出现两条同源路径：

| 路径 | 动作 | 产物 | 视图 |
|---|---|---|---|
| 送精修（现有，主路径） | 状态条 [✎送精修] | 内存 handoff → 编辑文档（未保存、无名） | 切到手动编辑页 |
| 另存为精修项目（新，出口路径） | 上下文条项目菜单「导出为精修项目(.gemdoc)」 | 同一 `buildManualEditHandoff` → 序列化 → 入库 sys-projects | 不切视图，toast「已存入素材库」 |

两者共用同一烘焙构造函数（零语义分叉），差异只在「是否立即进入编辑」。**不自动在送精修时落库**：编辑文档是中间态，中间态不入库（素材库设计 §2.5 同则）；用户在编辑页显式保存才成为资产。

### A.4 素材库集成（AssetNode 类型扩展）

#### A.4.1 节点模型扩展

```ts
// assetStore.ts 增量（不改 DB schema——assetNodes store 对节点形状无约束，无需 version bump）
export type ProjectKind = 'gemproj' | 'gemdoc'

export interface AssetProject extends AssetNodeBase {
  type: 'project'
  projectKind: ProjectKind
  refKind: 'blob'
  blobKey: string            // 序列化文件本体，内容寻址（images store 复用为文件 blob 仓）
  mime: string               // A.0 vendor MIME
  /** 展示性摘要缓存（非真源；每次保存重写）——网格卡片元信息行直出，免解析文件 */
  summary: {
    gemCount?: number        // 保存时 activeStrategy 钻数（gemproj）/ gems.length（gemdoc）
    strategy?: StrategyId    // gemproj
    ss?: SSKey
    sourceName?: string      // 来源图名
    updatedHint?: string     // 编辑页 sourceSummary（gemdoc）
  }
  trashedAt?: number
}

export type AssetNode = AssetFolder | AssetImage | AssetProject   // union 扩展
```

**契约豁免申请（重要，需 Codex 裁决 = 议题 4）**：素材库不变量「资产不可变：任何操作不改 blob 与图片内容」（add-asset-library design §1）对项目节点**显式豁免**——项目是活文档，保存 = blobKey 换绑新内容 blob（旧 blob 走既有按 blobKey 引用计数清理，机制同 `emptyTrash` 的 blob GC，`assetStore.ts:617-637`）。图片节点的不可变契约原样保留。豁免范围最小化：仅 AssetProject 的 blobKey 可变，其余仍只有 name/parentId/updatedAt/trashedAt 可变。

配套改动：
- `ingestProjectAsset(blob, meta)` 新增（与 `ingestAsset` 平行；MIME 白名单独立 = 两个 vendor MIME，不复用图片白名单 `assetStore.ts:370`）。
- **引用保护全集扩展第 ④ 类**：打开中的项目 pin 其 source/reference assetId（gemproj 硬保护——来源缺失即项目残废；gemdoc 仅 reference 硬保护，provenance 弱引用）。
- 落点目录：新增系统目录 `sys-projects`（名称「项目」，排钻/精修项目默认落点；用户可移动整理）。序列号上 `SYSTEM_FOLDER_IDS` 增一项，seed 幂等补建。

#### A.4.2 呈现与打开

- **网格卡片（P0）**：类型图标（排钻项目=网格蓝图 / 精修项目=钻面文档）+ 名称 + 元信息行（`2,341 钻 · SS10 · 09-19`，直出 summary 缓存）+ 类型徽标。**缩略图（[Codex-R2 修订]）**：gemproj/gemdoc/gemtpl 无缩略（P1 复议）；gemgen 缩略 **P0 显式 thumbKey**（物理契约见 change design §2/§9.1，推翻本稿原「项目缩略 P1」一刀切表述）。
- **点击 = 用对应页面打开**（[Codex-R1-E7 合并裁决修订] 桌面端单击项目节点仅选中并显示选中态工具行；双击打开对应页面，移动端单击打开；工具行「打开」与键盘 Enter 等价于双击。项目节点不进入图片预览 Dialog；图片节点同步遵循同一打开模型，重命名仅从选中态工具行/Enter 进入）
- **「全部素材」口径**：根聚合视图与计数纳入项目节点（`library.svelte.ts` 的 image-only 过滤 L85/L179/L194-202 需 type-aware 化）；底栏统计 `共 214 项 · 图片 208 · 项目 6`。名称「全部素材」是否随项目入库改为「全部文件」→ 议题 7（立场：不改）。

#### A.4.3 版本演进策略（formatVersion）

- 读取方：`parseGemproj/parseGemdoc` 对 `formatVersion` 做向前校验——大于当前支持版本 → 显式错误态「文件来自更新版本的应用，请升级后再打开」（不猜测解析）。
- 迁移器：`formatVersion` 递增时在 projectFile.ts 内注册 `(from, to) => migrate` 纯函数链，逐版本串行；每次 bump 必须 附往返测试（save→load→save 字节等价，非语义等价）。
- `engineVersion/appVersion` 只读展示，不参与迁移判断。

---

## §B 「转化工作台」改名

### B.1 行业术语证据（公开检索，2026-09-19，中等置信）

| 术语 | 行业用法 | 对本品的贴合度 |
|---|---|---|
| **排钻** | 烫钻工艺标准动词：「先用牛皮纸做好花样模板，将钻石排到固定位置」（百度百科·烫钻技术）；行业工具直接命名「排钻助手」（烫钻定位图排版软件）；大钻小钻分批时称「两套排钻图」 | 高——排钻页的核心产出正是钻位排布方案；且 app 内部词汇已收敛于「排布/排钻策略」（胶片带策略名 `STRATEGY_LABELS`） |
| **点钻** | 消费者侧动词：DIY 者用点钻笔把钻点到编号格（钻石画语境） | 中——是「朋友」画像的动作，但那是**下游手工活**，不是本页的工作；用作页名会与用户预期（我来点钻）错位 |
| **图纸/点钻图/钻图** | 钻石画成品的编号网格图（DIY 套装里那张图） | 中高——但更像「导出产物」（SVG/BOM 对应物）而非「调参过程」，指代结果不指代活动 |
| **打版** | 把照片/设计转成可生产图纸的过程（钻石画定制打版；英文圈对应 digitize，Hotfix Era 自述 "digitize design objects"） | 中——生产感强、贴「朋友要买钻」的下游；但多义（服装打版/印刷打版），且「版」暗示一次性转换，本页实际是迭代调参循环 |
| **转化** | 现名；无行业锚点，是管线视角的内部词 | 低——需要解释才能懂 |

来源：[Coldesi/Colman & Company](https://shop.coldesi.com)、[Sierra Software – Hotfix Era](https://www.sierra-software.com)、[Silhouette 101](https://www.silhouette101.com)、[MakeBead 钻石画图案设计器](https://makebead.com)、[BeadPattern](https://beadpattern.net) 及中文电商/百科检索摘要。

### B.2 候选与推荐

| 候选 | 行业锚点 | 优点 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 排钻设计**（推荐） | 排钻（强，B.1 首行） | 行业直觉动词 +「设计」承认迭代调参属性；与「手动编辑」构成清晰两级：**排钻设计=参数级 / 手动编辑=钻级**；移动端短名「排钻」成立 | 排钻在机加工语境指排孔钻削（多义），但 app 内语境零歧义 | **采纳** |
| B. 钻图打版 | 打版（中强） | 生产链路感完整，贴定制下单场景 | 打版多义；「版」与迭代调参的活动性质不匹配；两词叠加偏行话，对「朋友」画像不友好 | 备选 |
| C. 钻位设计 | 无外部锚点（app 内词汇：PRODUCT_MODEL「钻位方案」） | 与产品模型用词零翻译 | 无行业直觉增益，等于自造词 | 不采纳 |

Owner 预判「排钻设计」经证据检验成立，予以确认。

### B.3 措辞联动表（改名一次改齐，避免新旧混用）

| 触点 | 现文案 | 新文案 | 位置 |
|---|---|---|---|
| 桌面 Tab | 转化工作台 | **排钻设计** | `App.svelte:63` |
| 移动端 Tab | 工作台 | **排钻** | `App.svelte:141` |
| 实验室→工作台动作 | 送转化 | **送排钻** | `TaskCard.svelte:163`、LabView/预览 Dialog |
| 排钻页内项目称谓 | —（无项目概念） | 排钻项目（.gemproj） | §A |
| 排钻页→编辑页动作 | 送精修 | 送精修（**不变**——「精修」与编辑页心智已绑定，无歧义） | `StudioStatusBar.svelte:345/371` |
| 编辑页空态引导 | 回工作台送精修 | 去排钻设计送精修（次级引导） | `EditView.svelte:115-118` |
| 素材库落点 | — | 系统目录「项目」 | §A.4.1 |
| 全局壳副标题 | 贴钻工作台 Rhinestone Studio | 不变 | — |

---

## §C 两页产品重构

### C.1 排钻设计页（原转化工作台）：项目生命周期入页

#### C.1.1 动线（Journey First）

```
进入页 ──无项目──▶ 空态：[从素材库选图][上传] ＋ 最近排钻项目(≤4)
   │                    │选图 = 新建未命名项目（默认参数起步）
   │                    │点最近/库中项目 = 打开（载入→自动重放）
   └─有项目──▶ 项目态：调参循环（现状五区不动）
                    │ 任何参数变更 → dirty●
                    ├─ 保存(⌘S) / 另存为(=fork) —— 写回素材库节点
                    ├─ 项目菜单：导出项目文件(.gemproj)/导出为精修项目(.gemdoc)/关闭项目
                    ├─ 送精修（状态条，不变）→ 编辑页（未保存新文档）
                    └─ 离开：切 Tab=状态保留不守卫；刷新/关窗=beforeunload 守卫；页内破坏性动作=确认
```

**守卫模型裁决**（关键，依一手事实）：四 Tab 是同一 SPA 的视图切换，studio store 是模块级单例 $state（`studio.svelte.ts:110-143`），**切 Tab 不卸载状态**。因此：
- 切 Tab（去素材库等）→ **不弹守卫**（状态在内存原地保留，回来即续）；上下文条持续显示 `●未保存` 徽标作为提醒。
- 刷新/关闭浏览器 → `beforeunload` 守卫（dirty 时）。移动端浏览器对 beforeunload 支持不稳 → 依赖「最近项目」与显式保存习惯兜底；draft 自动续作列 P2（议题 5）。
- 页内破坏性动作（打开其它项目/换来源图/新建）→ 三按钮确认：「保存并继续 / 不保存 / 取消」。

#### C.1.2 状态矩阵（项目生命周期 × 五区）

| 状态 | 触发 | 呈现 | 出口/恢复 |
|---|---|---|---|
| 无项目（空态） | 进入页且未打开项目 | 现空态双 CTA + **最近排钻项目**行（updatedAt 降序 ≤4，卡片=图标+名+钻数摘要） | 选图=新建；点卡=打开 |
| 新建未命名 | 空态选图/上传 | 项目名占位「未命名项目」+ 来源图名；分块自动跑（现状链路零改动） | 首次保存弹命名（默认=来源图名） |
| 打开中 | 点库/最近项目 | 上下文条 skeleton；解析完成自动触发既有分块/布局重算态（进度徽标复用） | 完成→干净态 |
| 干净 | 打开完成/保存完成 | 项目名无●；[保存] 常规态 | 参数变更→dirty |
| dirty | 任何参数/覆写/色板/策略/分块参数变更 | 项目名旁●+ [保存] 高亮；切 Tab 持续可见 | 保存/⌘S；另存为 |
| 来源缺失 | gemproj 的 source.assetId 解析失败（软删/硬清） | 画布区错误卡：「来源图已缺失——项目参数完好，重新绑定来源图即可重放」+ [重新绑定来源图][导出参数文件]；检查器/胶片带禁用占位 | 重绑=选图器选图（提示将按新图重算）；或仅导出参数存档 |
| 引擎版本不同 | engineVersion ≠ 当前 | 顶部黄条横幅（可展开覆写存活清单）| 继续打开/取消 |
| 文件导入 | 拖入/选择 .gemproj/.gemdoc | 全局入口（App 层）→ ingest → 按类型切对应页打开 | 成功 toast / 失败三段式 toast |

参数工程的红利态即「来源缺失」：快照格式在此只能报废，参数格式可重绑续命——这是 A.1.1 裁决的用户可感知回报。

#### C.1.3 线框（桌面 lg+，五区骨架不变，标注改写面）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ◆ 贴钻工作台 [素材库][提示词实验室][排钻设计●][手动编辑]              ● BYOK │
├──────────────────────────────────────────────────────────────┬─────────────┤
│ 上下文条 h-10 【改写】                                        │  检查器      │
│ [▦] 蝴蝶主体·排钻 ● [保存][▾] │ 来源: 蝴蝶主体-候选2 [更换▾]    │  320px      │
│                              │纯钻|叠稿|叠原 ◐60% │适应 +− 128% │  （不变）    │
├──────────────────────────────────────────────────────────────┤             │
│                                                              │             │
│              画布（不变；+来源缺失错误卡/版本横幅两种浮层）         │             │
│                                                              │             │
├──────────────────────────────────────────────────────────────┴─────────────┤
│ 胶片带（不变：五策略 chips + ⤢对比）                                          │
├────────────────────────────────────────────────────────────────────────────┤
│ 状态条【微改】：共 2,341 钻 · ✓间距合规 · BOM…▾ │[SVG][BOM][PNG][✎送精修]      │
└────────────────────────────────────────────────────────────────────────────┘
项目菜单 ▾（上下文条）：另存为… / 导出项目文件(.gemproj) / 导出为精修项目(.gemdoc) / 关闭项目
```

五区改写面清单：**上下文条=重写**（项目身份区+保存+菜单+来源区扩容，预览/取景控制不动）；**状态条=微改**（零布局变化，仅文案联动）；画布/检查器/胶片带=结构不变。移动端：上下文条折两行（项目行 [▦]名● ⋮ + 来源行），空态最近项目=横滑 chips。

#### C.1.4 保存写路径（与素材库的接缝）

```
保存(⌘S) ─▶ serializeGemproj(studio state)（新 projectFile.ts）
        ─▶ 首次：ingestProjectAsset → AssetProject 入 sys-projects → 记 projectId
        ─▶ 再次：同 node blobKey 换绑新内容 blob（同事务）+ summary 重写 + 旧 blob 引用计数清理
        ─▶ dirty=false；toast「已保存到素材库」
另存为 = 同上但不记 projectId（fork），命名 Dialog 预填原名
```

### C.2 手动编辑页：解除硬绑定

#### C.2.1 入口裁决：「从任何一张图片开始」的 ? = 快速排稿（不过排钻页、不空画布）

**裁决：素材库选图 → 自动「快速排稿」（默认参数一次性烘焙）→ 进入编辑。空白画布直接笔刷 = P1。**

论证：
1. **产品模型不动摇**：编辑文档真源 = gems；gems 进入文档只有烘焙一条路（送精修烘焙 / 快速排稿烘焙——同构 `ManualEditHandoff` 载荷，`buildManualEditHandoff` 的参数化复刻）。编辑器自身永不跑分块（blocks 恒为只读参考）——「编辑器长出参数面板」是概念混入，禁止。
2. **画像贴合**：朋友画像「选图→看钻→买钻」——空画布+笔刷让他们从零手摆上千颗钻，是设计师用例不是手艺人用例；快速排稿 5 秒内给出可看可改的钻面，正中画像。空白画布（字母/花边/原创 motif——烫钻行业经典用例）是 Owner 级用例，P1 以「空白画布」CTA 补齐（EditDocument 的 paintingSnapshot 以合成纯色图满足契约，机制可行：`loadFromEngineImage` 先例 `studio.svelte.ts:483-498`）。
3. **成本**：快速排稿 = 一次 `runCompute`（segment + hybrid 单策略，默认 k=8/seed=1/SS10/gap0.4/密度100%——与 studio 初始态同参，`studio.svelte.ts:115-136`），新模块 `lib/edit/quickLayout.ts` 直接消费 computeClient + engine，**不经 studio store**（避免两模块状态互踩）。中低成本。
4. 快速排稿后想调密度/换策略？→ 编辑器内已有「选块策略填充」做局部；整幅调参的正确去处是排钻页——空态与摘要条提供引导（Concept Continuity：每个入口告诉用户「接下来能去哪」）。

#### C.2.2 入口全景（改后）

```
① 排钻页送精修（现有主链，不变）：调参 → 烘焙快照 → 编辑页未保存新文档
② 素材库选图直入（新）：编辑页空态 [从素材库选图] → 快速排稿(进度) → 未保存新文档（provenance=quick-layout）
③ 打开精修项目（新）：库中 gemdoc 点击 / 空态最近列表 / 磁盘导入 → 干净文档态
④ 排钻页导出的 .gemdoc（并存）：与③同通道打开；provenance.gemprojAssetId 提供「来源项目」溯源展示
```

四入口全部 converge 到同一文档模型；「再次送精修=覆盖确认」触发口径改为 dirty（A.2.3）。

#### C.2.3 状态矩阵（编辑页）

| 状态 | 触发 | 呈现 | 出口/恢复 |
|---|---|---|---|
| 无文档（空态·重设计） | 进入页无文档 | 主 CTA [从素材库选图开始] / 次 [打开精修项目] / [上传图片]；最近精修项目(≤4)；引导行「想先调密度与策略？去排钻设计」 | 选图→快速排稿；点卡→打开 |
| 快速排稿中 | ②选图后 | 画布区进度（复用 computeProgress 文案「正在分块…/排布中…」）+ [取消] | 完成→文档态；取消→回空态 |
| 文档·干净 | 打开/新建烘焙完成 | 现摘要条（钻数/来源/尺寸）；项目身份入摘要条左端：[▦] 名称 | 编辑→dirty |
| 文档·dirty | 任何 patch 提交后（口径见 A.2.3） | 名称旁●未保存 + [保存]；徽标「未保存」 | 保存/⌘S（首次=命名，默认「精修 · <来源摘要>」） |
| gemdoc 打开中 | ③④ | 摘要条 skeleton + 画布「载入中」（painting PNG 解码） | 完成→干净 |
| 参考图四态 | 现状 | loading/ready/missing/soft-deleted（既有，不动） | 既有 |
| 守卫 | dirty + 刷新/关窗/覆盖送精修/打开其它 | 同 C.1.1 模型（切 Tab 不守卫） | 三按钮确认 |

#### C.2.4 线框（空态重设计 + 文档态摘要条）

```
空态：                                    文档态摘要条（改写）：
┌──────────────────────────────┐        ┌────────────────────────────────────────────┐
│                              │        │ [▦] 蝴蝶·精修 ●未保存 [保存][▾]  2,341 钻   │
│     从一张图开始钻级精修        │        │ 快速排稿 · SS10 · 1024×1024px    [图层]     │
│  选图后自动快速排稿成钻面，      │        └────────────────────────────────────────────┘
│  再逐钻增删/移动/换色           │         ▾ 菜单：另存为… / 导出精修文件(.gemdoc) / 关闭文档
│                              │
│  [从素材库选图] [上传图片]      │
│  最近：[蝴蝶·精修][招牌字] →    │
│  ── 想先调密度与策略？去排钻    │
│     设计页调好再「送精修」 ──   │
└──────────────────────────────┘
```

### C.3 迁移成本评估

| 项 | 改动 | 量级 |
|---|---|---|
| `persistence/projectFile.ts` 新建 | 两格式 serialize/parse/版本迁移链 + 往返测试 | 中 |
| `assetStore.ts` | AssetProject 类型 + ingestProjectAsset + blobKey 换绑保存 + sys-projects seed + 引用保护④ + image-only 查询口径（部分在 library.svelte.ts） | 中 |
| `library.svelte.ts` / `AssetsView.svelte` | type-aware 过滤/计数；项目卡片渲染；点击路由（经守卫）；预览 Dialog 不触达项目 | 中 |
| `studio.svelte.ts` | 项目生命周期 state（projectId/dirty/name）+ 挂接序列化；**参数集本身零改动**（真源=参数的实证） | 中 |
| `StudioContextBar.svelte` | 项目身份区 + 保存/菜单 + 移动端折叠 | 小-中 |
| `edit.svelte.ts` | serialize/deserialize + manualCounter 派生 + dirty 口径替换 hasEdits 消费点 | 小-中 |
| `edit/quickLayout.ts` 新建 | 默认参数一次 runCompute → handoff 载荷 | 小-中 |
| `EditView.svelte` | 空态重写 + 摘要条项目身份 + 守卫挂接 | 中 |
| `App.svelte` | 改名 Tab + .gemproj/.gemdoc 全局导入（file input + drop）+ beforeunload 挂接 | 小 |
| 文案 | 送转化→送排钻 等联动表 B.3 | 微 |
| 测试 | 生命周期/守卫/round-trip/来源缺失/版本横幅/快速排稿 | 中 |

风险：(1) AssetNode union 扩展波及 library 全部 image-only 过滤——遗漏即项目节点「隐形」（用「库内可见性」回归测试兜底）；(2) blobKey 换绑事务与旧 blob GC 是新的存储语义，需注入失败测试；(3) beforeunload 在移动端不可靠——已用「不守卫切 Tab + 显式保存」降低暴露面。

### C.4 PRODUCT_MODEL v3 增补草案（diff 形式，随 change 裁决）

- 一句话：…素材库是**全部资产（图片 + 项目文件）**的唯一真源。
- 对象树增：`素材库 ├──▶ 排钻项目(.gemproj)/精修项目(.gemdoc) = AssetProject 节点（真源；页面内编辑、保存回写）`；`手动编辑 ←─ 素材库选图 · 快速排稿（默认参数一次性烘焙，独立入口）`。
- 真源表增：排钻项目文件 = 素材库（AssetProject, gemproj）；精修项目文件 = 素材库（AssetProject, gemdoc）；快速排稿参数 = 固定默认（不可调——调参去排钻页）。
- 交接语义增：项目文件 = 交接语义的文件化（gemproj=参数工程可重放；gemdoc=烘焙快照自包含）。
- 硬规则增：5. 项目文件遵循统一素材库手势（[Codex-R1-E7 修订]）：桌面单击选中、双击打开，移动端单击打开；对应页面是一页一格式的唯一消费者。图片节点同步遵循同一打开模型，重命名仅从选中态工具行/Enter 进入；6. 编辑器不暴露排钻参数面板（概念混入禁令）。
- 契约豁免：AssetProject 的 blobKey 随保存换绑（图片不可变契约不适用于项目节点，见 A.4.1）。

---

## §D 记分卡

**现状两页（改版基线，2026-09-19 走查）**：

```
手动编辑页（concept error 主体）：
Product coherence:   4/10  唯一入口绑死排钻页；一图想精修必须先调参（结构性）
Journey continuity:  4/10  空态单出口回工作台；无打开/续作路径；刷新全丢
IA integrity:        5/10  页本身简单无混乱；但作为终点页无回头路
Interaction clarity: 6/10  图层控制可用；无保存/项目概念可评
State visibility:    6/10  摘要条齐；无 dirty/保存态
Visual quality:      6/10  克制一致；空态引导单薄
VERDICT: NEEDS-WORK（coherence/journey < 7 双触发——入口结构问题，页内修补无效）

排钻页（项目维度）：Journey 6/10（工作成果无保存/续作断点）；其余沿素材库设计稿评分。
发布会截图测试: 不能 —— 编辑页空态的单一按钮是死胡同本身
```

**目标态（自评，供实现后复测）**：两页 coherence 9（一页一格式一真源）/ journey 9（四入口 converge、守卫三态齐）/ IA 9 / interaction 8 / state 9（dirty/缺失/版本三新态全显式）/ visual 9（空态即动线图）。VERDICT: SHIP（待 Codex + 实现复测）。

---

## §E 给 Codex 的议题清单（附立场）

1. **gemproj 来源双形态 vs 恒内嵌**：`source` 判别联合（库内 asset 引用 / 导出内嵌）vs 永远内嵌。
   立场：**双形态**。恒内嵌破坏内容寻址去重（同图多项目全量重复存储）且库内保存路径多余；双形态的唯一代价是解析方两分支（各配测试）。若 Codex 认为双分支的缺失态组合爆炸，可收敛为「内嵌仅存在于导出文件、导入时自动转 asset 引用（有图入库）」的归一化策略——我方预审认为归一化反而增加导入副作用，倾向保留两态。
2. **引擎版本漂移的 UX 强度**：横幅提示 + 重算（本案）vs 提供「按旧引擎结果冻结打开」选项。
   立场：**横幅 + 重算**。「冻结」需要随包分发多版本引擎或快照回退，成本不成比例；需要冻结的语义已由导出 gemdoc 覆盖。附实现前提：engine 新增 `ENGINE_VERSION` 常量并纳入「语义变更必 bump」的 PR 纪律（无此纪律横幅即谎言）。
3. **手动编辑从图开始：快速排稿 vs 空白画布的 P0 范围**。
   立场：**快速排稿 P0、空白画布 P1**。若 Codex 从实现角度评估空白画布边际成本近零（合成纯色 paintingSnapshot + 默认 grid/palette 即可），可升 P0——请给出成本依据而非方向异议。
4. **AssetProject 保存的 blobKey 换绑 vs 独立 projectStore**：项目内容演进 vs 素材库「节点不可变」契约的张力。
   立场：**换绑（契约显式豁免）**。独立 store 引入第二真源与双簿记；换绑复用既有 blob 引用计数 GC（emptyTrash 同机制）+ 单事务。风险在旧 blob 清理的失败注入测试，机制已有先例。若 Codex 坚持契约纯洁性，请同时给出 projectStore 方案中「库内可见性/移动/回收站/引用保护」的等价实现成本对照。
5. **自动草稿（draft autosave）**：显式保存 + 守卫（本案）vs 打开即自动保存（Figma 式）。
   立场：**P0 显式保存**。Owner 任务原文即「保存/另存为/未保存离开守卫」的文档模型；自动保存需草稿槽（不可变契约外的第三种写入路径）+ 参数实验可回退性设计（无版本历史时自动保存=实验不可逆）。P2 以独立 draft 槽（非内容寻址、单槽覆盖） revisit。
6. **块覆写跨引擎版本的迁移**：P0 悬空清点 + P1 掩码内容哈希匹配。
   立场：**按此两段走**。请 Codex 评估 segment 块 id（`b${c}-${compIdx}`，`segment.ts:232`）是否有低成本的内容寻址化空间（如 id 内嵌掩码哈希尾缀）——若可行，P1 匹配器可省，但需评估 id 长度/可读性代价。
7. **「素材库」是否因收编项目而更名（如「资料库/文件库」）+「全部素材」口径**。
   立场：**不改名**。项目在用户心智里也是「我的素材/我的东西」的宽口径；Tab 刚定名（素材库居首）再改是 churn。P2 若项目资产占比显著（>30% 节点）再议。

---

## §F 执行摩擦反馈（协议要求）

1. **PRODUCT_MODEL v2 与本需求存在未预载的张力**：「资产不可变」契约写于项目文件概念之前，字面禁止保存换绑内容。本次以「契约豁免申请」（A.4.1）+ v3 diff（C.4）双轨处理——建议协议明确：PRODUCT_MODEL 修订在 change 裁决前以「豁免申请」形式并行存在的合法路径，避免 PM 擅自改模型或被迫冻结设计。
2. **任务原文「未保存离开守卫」与源码事实冲突**：字面理解=切 Tab 弹守卫；源码事实=store 模块单例跨视图存活，切 Tab 不丢状态。已按事实重构守卫语义（C.1.1 三分法）。提示任务下发热点：涉及「离开」的表述建议注明指刷新/卸载还是视图切换。
3. `interaction-design` 状态矩阵出口在本场景继续好使（C.1.2/C.2.3）；「守卫三按钮」无现成 pattern，本次自拟，建议 skill 增补「文档型脏态守卫」条目。
4. `content-design` 的命名审计流程（voice/术语表）在本仓尚无落盘术语表——B.3 联动表实为首个术语注册表雏形，建议后续抽 `TERMS.md` 入仓根（排钻/精修/送排钻/送精修/项目 两级词条）。**[R3 更新] 该建议已落实：TERMS.md v1 已落盘（rhinestone-studio/TERMS.md，16 词条），本条保留为历史反馈记录。**
5. 行号引用基线为 2026-09-19 源码树；本 change 实现期与 add-manual-edit-mode tasks 5.x（编辑工具 UI）并行时行号必然漂移，Codex 复核请以符号名（函数/常量）为主键。
