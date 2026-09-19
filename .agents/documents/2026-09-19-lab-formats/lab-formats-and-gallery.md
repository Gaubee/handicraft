# 实验室格式对（.gemtpl 模板 / .gemgen 生成结果）+ 实验室重构（模板库化 + 任务画廊升级）

- 日期：2026-09-19
- 作者：产品（PM 子代理）；讨论对象：Codex 评审闭环 + 编排者；定稿后切片进 OpenSpec change `add-project-files` §7 / 任务 4.x
- 状态：**讨论稿**——§E 议题清单未裁决前不作为实现依据
- 输入：真实源码（`rhinestone-studio/src/`，2026-09-19 版，行号为当日实测，引用以符号名为主键）+ Owner 七条裁决原文（2026-09-19，最高约束）+ Owner 追加裁决（2026-09-19：gemtpl 卡片「去使用 / 去编辑 RightSheet」，并入 §C.5，优先级最高）+ 姊妹设计稿 `.agents/documents/2026-09-19-project-file-formats/project-format-and-redesign.md`（下称姊妹稿）+ `openspec/changes/add-project-files/{proposal,design,tasks}.md` + `PRODUCT_MODEL.md` v2 + 进行中的案例合成重构契约（参照对退役：模板绑定单张合成案例图，`{kind:'asset', assetId, caseLayout}`）
- 方法论出处（一手文件）：
  - 定框：`~/.agents/references/design-skills/skills/product-discovery-and-framing/SKILL.md`
  - 信息架构：`~/.agents/references/design-skills/skills/information-architecture/SKILL.md`
  - 交互行为结构：`~/.agents/references/design-skills/skills/interaction-design/SKILL.md`
  - 视觉红线（线框自查）：`~/.agents/references/ojo-design-skills/skills/app-ui-ux-best-practices/references/anti-patterns.md`
- 证据分级：源码行号 = 一手事实；Owner 原话 = 用户一手；行为收益判断 = 标注「判断」+ 置信度
- 视觉基调：工具型产品，Convention 赛道（沿姊妹稿判定）；**本文只做结构/数据/交互规范与线框，不产出 token/视觉终稿**
- 产品模型：本设计与 `PRODUCT_MODEL.md` v2 的冲突（提示词变体真源迁移）在 §C.8 以 v3 增补草案处理；与姊妹稿的冲突（素材库打开手势）在 §C.6 提出「对齐修正申请」（= 议题 7）

---

## 0. 决策框架（framing）

**决策句**：为提示词实验室裁定——(a) 两种实验室文件格式的数据与生命周期语义（`.gemtpl` 模板 = 可编辑的配置资产；`.gemgen` 生成结果 = 自包含的不可变档案）；(b) 实验室模板面板从硬编码/localStorage 双轨改为素材库真源；(c) 任务画廊从「仅全部」升级为「模板维度过滤 + 会话任务 ∪ 库内 gemgen 并集 + 卡片收起/展开两态 + 双击定位动线）；(d) gemtpl 在素材库的双动作 IA——去使用（与双击动线收敛为单一 handler）与去编辑（RightSheet 内嵌双宿主模板编辑器，不离开素材库；Owner 追加裁决）。截止：随 `add-project-files` change 任务 4.x 进入实现。

**问题框定**（证据：源码 + Owner 定性）：

1. **模板真源是易失的双轨态**：模板（变体）持久化在 localStorage `variants {v:2}` 信封（`taskStore.ts` saveVariants/loadVariants），而其案例绑定已是素材库资产（`lab.svelte.ts` VariantEffectRef asset kind）——同一对象一半在库、一半在 localStorage。更糟的是版本门：`VARIANTS_PAYLOAD_VERSION` 不匹配即整体回落默认（`taskStore.ts` loadVarians 返回 null → `defaultVariants()`），`DEFAULT_TEMPLATES_VERSION` 注释明言「据此重置存量旧模板」。**用户对模板的每一次编辑都活在「下次模板体系演进即清零」的悬崖上**（一手事实：lab.svelte.ts L166-179 注释 + taskStore.ts L275-296）。
2. **生成结果在库里但回不到语境**：生成图自动归档入 `sys-generated`（`archiveGeneratedResult`），但素材库里它只是裸图片——双击预览图片，无法回到「哪个模板、哪次批次、提示词是什么」的画廊语境；画廊本身只有「全部」（run 维度，`getTaskGroups`），模板维度不可检索（Owner 裁决 4/6 的动机：「东西越来越多」）。
3. **画廊卡片只有一档信息密度**：卡片恒为大图+动作（`TaskCard.svelte`），结果一多即同质瀑布；Owner 明确要「收起做小图预览」（裁决 6）。

**非目标**：不做模板市场/分享（导出带走文件即可）；不做画廊搜索/时间范围筛选（chips 过滤已覆盖主检索任务）；不改 BYOK/请求链路语义（composeDrillPrompt 骨架演进照旧走代码版本）；不动案例合成管线的契约（消费其终态）；不回填旧归档裸图片（§A.4.2）。

**成功标准（可证伪）**：

- 主指标（模板存活）：升级/刷新后模板保真——`DEFAULT_TEMPLATES_VERSION` 或 `VARIANTS_PAYLOAD_VERSION` bump 后，库内模板集合与内容零变化（回归测试可断言；现状行为是整体重置，基线 = 0% 存活）。
- 主指标（画廊检索）：双击库内 `.gemgen` → 目标卡片进入视口且展开——端到端断言（过滤正确 + scrollIntoView 到位 + 展开态成立）；用户侧「找某模板的历史候选」任务在 ≥20 结果时无需滚动查找（判断值，走查验证）。
- 护栏：生成→归档→送排钻链路行为回归零破坏；素材库既有测试全绿（AssetNode 扩展不回归）；`taskStore` 三级配额降级语义不因 union 口径失效。

---

## §A 两种实验室文件格式

### A.0 命名与文件家族（四格式全景，schema 用同词）

| | 姊妹稿格式 1 | 姊妹稿格式 2 | **本稿格式 3** | **本稿格式 4** |
|---|---|---|---|---|
| 对外类型名 | 排钻项目 | 精修项目 | **模板** | **生成结果** |
| 扩展名 | `.gemproj` | `.gemdoc` | **`.gemtpl`** | **`.gemgen`** |
| MIME | `…gemproj+json` | `…gemdoc+json` | `application/vnd.rhinestone-studio.gemtpl+json` | `application/vnd.rhinestone-studio.gemgen+json` |
| 本质 | 参数工程（菜谱） | 烘焙文档（成品稿） | **配置资产（可编辑的活配置）** | **不可变档案（生成即定稿）** |
| 可变性 | blobKey 换绑（豁免） | blobKey 换绑（豁免） | **blobKey 换绑（豁免，同族）** | **不可变（同图片节点契约）** |
| 图标语义 | 网格蓝图 | 钻面文档 | 模板 motif（LayoutTemplate 类线性图标，文案质感） | 生成 motif（Sparkles，与「生成结果」目录图标同源） |
| 体积量级 | <20KB | 0.2–1.5MB | **<10KB**（promptBody ≤8000 字符 + 元数据） | **0.5–3.5MB**（内嵌图 dataUrl ≈ 原始字节 ×1.33 + JSON ~5–15KB；判断值，待实测） |

命名理由：`.gem*` 家族前缀 + `tpl`/`gen` 后缀直接对仗「模板/生成」两个已内化的产品词汇（实验室 UI 现称「模板」，TaskCard/资产 meta 现称「生成结果」目录），零翻译成本；`tpl`/`gen` 在前端开发词汇里是强共识缩写（template/generation），Owner 画像（JSON 友好）无歧义。

### A.1 格式 3：模板 `.gemtpl`（配置资产）

#### A.1.1 定位裁决：可编辑的配置资产，保存 = 换绑

**裁决：`.gemtpl` 是活配置——`promptBody`（用户可编辑特化文案）+ 案例绑定（库资产引用）+ 候选数默认；编辑写回 = blobKey 换绑新内容 blob（沿姊妹稿 A.4.1 对 AssetProject 的契约豁免，projectKind 四分化后豁免天然覆盖 gemtpl）。**

论证（证据等级：一手事实 + 推导）：

1. **模板的既有心智就是「可编辑对象」**：`updateVariant` 对 name/prompt/candidates/effectRef 全开放即改即存（`lab.svelte.ts` updateVariant → persistVariants 逐次写）。「不可变新建」会让每次编辑 fork 新资产——sys-templates 里一次会话就会堆出十几个「模板 (3)」，与「模板库」的管理预期直接冲突（IA：一个模板一个家）。
2. **豁免先例已就位**：姊妹稿 A.4.1 对 AssetProject 的豁免论证（活文档 vs 图片不可变，换绑复用 blob 引用计数 GC）逐字适用于 gemtpl——唯一差异是写频率更高，量级见 A.1.4。
3. **与 gemproj 的差异不在可变性而在保存时机**（⌘S 显式 vs 字段提交自动，裁决见 §B.1）——两格式同享换绑机制、异享保存节奏，不冲突。

#### A.1.2 Schema（TS interface 级草案）

```ts
// lib/persistence/labFile.ts（新建；gemtpl/gemgen 序列化/反序列化/版本迁移唯一出口，
// 与姊妹稿 projectFile.ts 同族同纪律——是否合并单文件由 Codex 定，纪律不变）

/** 格式 3：模板（配置资产——提示词特化体 + 案例绑定 + 默认值；总装骨架 = 代码，不入文件） */
export interface GemtplFile {
  kind: 'gemtpl'
  formatVersion: 1
  appVersion: string
  createdAt: number
  savedAt: number
  name: string                     // 模板名（seed 取 preset.name；新建默认「模板 N」）

  /** 模板特化正文（= 现 VariantEditor textarea 的内容；≤8000 字符，沿 saveVariants 截断上限）。
   *  注意：这是「用户可编辑的全部提示词内容」——总装骨架（角色声明/通用贴钻规则/输出行）
   *  由代码 composeDrillPrompt 在请求时拼装，永不入文件（理由见 A.1.3）。 */
  promptBody: string

  /** 案例绑定：合成案例图的库资产引用（进行中合成重构的终态形态）；null = 未绑定（纯提示词生成）。
   *  不设计双图/内嵌——合成图已物化为库资产，序列化引用即可。 */
  caseBinding: { assetId: string; caseLayout: CaseRefLayout } | null   // CaseRefLayout = caseComposite.ts

  /** 候选数默认（1-8，clamp 同 updateVariant）。 */
  candidates: number

  /** 溯源（展示用）：内置 preset seed / 用户新建 / 复制 fork。 */
  provenance: {
    source: 'builtin-seed' | 'user-created' | 'forked'
    presetId?: string             // builtin-seed 时记 EFFECT_REF_PRESETS.id（找回想找回官方定义用）
    sourceNote?: string           // 内置案例来源说明（EffectRefPreset.sourceNote，tooltip 展示）
  }
}
```

明确**不入文件**的量：

- **`enabled`（参与生成开关）**——它是「这次跑哪些」的使用意图，不是模板作为资产的内容属性；双击打开模板恢复 enabled 没有意义。移入实验室会话态（§B.1，议题 8）。
- **总装骨架**（composeDrillPrompt 的角色声明块 / DRILL_RULES / 任务行 / 输出行）——见 A.1.3。
- **选中态/滚动位置**——交互瞬态。
- **模板在目录树中的位置**——那是 AssetProject 节点的 parentId，不是文件内容（节点与文件分工同姊妹稿 A.4.1）。

#### A.1.3 总装骨架为什么不入文件（本题题眼）

1. **骨架在序列化时刻根本不可计算**：`composeDrillPrompt(templateBody, roles)` 的角色声明块按**请求时实际附图组合**动态编号（`effectRefs.ts` describeDrillImageOrder：hasCase × caseLayout × hasReference 的运行时函数——案例图在、参考图不在则任务行降级，纯文生图则角色声明整体省略）。文件里能存的只能是「所有分支的快照」或「其中一个分支」，前者冗余、后者错误。
2. **骨架是全局指令工程，演进应即时惠及全部模板**：DRILL_RULES 是 Owner 冻结原文（`effectRefs.ts` L88-93），历史已迭代过一整代（「全钻数字油画中间稿」英文规则整体废弃，`effectRefs.ts` 头注）。若骨架入文件，旧模板永远携带旧规则——用户以为在用「花环边框模板」，实际在用「花环边框 + 过期规则」。骨架的唯一真源 = 代码 + appVersion 语义，与 gemproj「推导常量不冻结、归 engineVersion」同构（姊妹稿 A.1.1）。
3. **体积与可维护性**：骨架 ~700 字符 × 全部模板重复存储；入文件后每次骨架修订都要考虑存量文件迁移，纯负担。
4. **审计链不缺环**：「生成时实际发出的完整指令」由 `.gemgen` 的 `composedPrompt` 全文快照承接（A.2.2）——模板存可编辑体、生成结果存当时全文，分工闭合。

#### A.1.4 写路径与量级

```
字段提交（onchange/blur，非每 keystroke）
  ─▶ serializeGemtpl(编辑态)（labFile.ts）
  ─▶ 首次：ingestProjectAsset(gemtpl) → sys-templates → 记 templateAssetId
  ─▶ 再次：同 node blobKey 换绑新内容 blob（单事务）+ summary 重写 + 旧 blob 引用计数清理
  ─▶ 新建模板 / 复制 / 删除(软删入回收站) / 重命名 = 素材库节点操作（复用既有 move/trash/rename）
```

- 换绑频率量级（判断，置信度高）：模板 JSON <10KB，编辑会话内每字段提交一次换绑；对照 sys-generated 每次生成写 1–3MB，量级低两个数量级，GC 压力可忽略。
- 案例绑定替换/解绑**不删旧合成图资产**（沿 `lab.svelte.ts` [B-2] 语义：资产生命周期归素材库）。

### A.2 格式 4：生成结果 `.gemgen`（不可变档案）

#### A.2.1 定位裁决：生成即定稿，不可变

**裁决：`.gemgen` 一次性写入，永不换绑。** 论证：

1. **语义**：生成结果没有「编辑」动作——要改就重试/重生成（新任务 → 新 gemgen）。重试链路只在 error/cancelled 态开放（`lab.svelte.ts` retryTask 守卫），成功任务无覆写路径；同一 taskId 重试成功后归档的是新节点（内容寻址去重下同字节复用 blob，节点仍新建）。
2. **契约对称**：不可变契约在素材库已存在且被验证（AssetImage）；gemgen 是「带溯源的图片」，套用图片契约零新机制。豁免只给「会被编辑的文档」（gemproj/gemdoc/gemtpl），不给定稿档案——豁免范围最小化（姊妹稿 A.4.1 同款措辞）。
3. **可变档案会破坏溯源诚实性**：composedPrompt 是「当时发了什么」的审计记录，可编辑的审计记录没有价值。

#### A.2.2 Schema（TS interface 级草案）

```ts
/** 格式 4：生成结果（自包含档案——图片内嵌 + 全量溯源；独立可开、可导出带走） */
export interface GemgenFile {
  kind: 'gemgen'
  formatVersion: 1
  appVersion: string
  createdAt: number                 // = 任务发起时刻（task.createdAt）
  savedAt: number                   // 归档时刻
  name: string                      // `${模板名}·候选${candidateIndex+1}`（沿现归档命名）

  /** 生成图字节（原始返回，非降采样）：内嵌裁决见 A.2.3。 */
  image: { mime: string; dataUrl: string; width: number; height: number }

  /** 溯源全集（展示 + 审计；不参与任何重放）。 */
  provenance: {
    runId: string                   // 批次 id（画廊分组键延续）
    templateAssetId?: string        // 模板资产弱引用（模板被删/移动仍成立；缺失降级见 §B.4）
    templateName: string            // 模板名快照（模板缺失时的显示兜底 = 现 variantName 角色）
    promptBody: string              // 模板特化体快照（= task.prompt）
    composedPrompt: string          // **提示词全文快照**（composeDrillPrompt 请求时输出，审计真源）
    caseBinding?: { assetId: string; caseLayout: CaseRefLayout } | null   // 发起时案例绑定快照
    referenceAssetId?: string       // 参考原图资产 id（弱引用；沿 task.referenceAssetId）
    candidateIndex: number          // 0 起候选序号
    mode: 'generate' | 'edit'
    model: string
    size: string                    // 如 '1024x1024'
    advancedJson?: string           // **打码后**（maskAdvancedJsonForPersist 同口径，N3 纪律延伸到文件）
  }
}
```

明确**不入文件**：任务状态/error/debug（任务状态是会话账本的事，档案只记成功产物）、imageUrl（objectURL 瞬态）、engineVersion（实验室不消费引擎，与 gemproj 不同源）。

#### A.2.3 图片内嵌 vs 图片资产+引用（= 议题 8，working position 覆议）

| 方案 | 自包含可带走 | 与素材库关系 | 体积 | 消费面 | 裁决 |
|---|---|---|---|---|---|
| ① 内嵌 dataUrl（本案） | ✅ 单文件即完整档案 | gemgen 节点 = 唯一节点 | ≈ 原图 ×1.33（base64 膨胀）+ JSON 少量 | 送排钻/预览需 parse 提取 blob（一个 helper） | **采纳** |
| ② gemgen(纯元数据) + 裸图片资产双节点 | ❌ 出库断链 | 每次生成两个节点，库内条目翻倍 | 最优 | 图片直取 | 否决 |
| ③ 仅引用既有图片节点 assetId | ❌ 且删图即档案残废 | 复用现有归档 | 最小 | 直取 | 否决 |

采纳①的论证：(a) Owner 语义是「生成结果换成新格式」——产物从裸图升级为带溯源的档案，图片是档案的组成部分，与 gemdoc「底图=文档内容→烘焙」同刀法（姊妹稿 A.2.2）；(b) 方案②在「生成结果」目录里每次生成出现两条（一条档案一条图），IA 上是同一概念两个家；(c) 33% 体积通胀是自包含的合理对价，且 IDB 无 localStorage 的 5MB 配额约束。已知代价：内嵌图无法与裸图片 blob 做内容寻址去重（JSON 包裹改变字节）——接受，gemgen 之间本就互不相同；「送排钻」消费经 `parseGemgen → image blob` 单点 helper（§B.2），studio 侧 handoff 契约不变形。

#### A.2.4 与既有 meta.referenceAssetId / task.assetId 关联链的关系：收编

现状链路：`task.referenceAssetId`（任务快照）+ `archiveGeneratedResult` 把 runId/variantName/candidateIndex/prompt/referenceAssetId 写入**图片节点 meta**（`lab.svelte.ts` L744-759）。**收编裁决**：这些溯源字段全部上移进 `.gemgen` 文件本体（provenance），AssetProject 节点上只留**展示性 summary 缓存**（非真源，每次归档重写，姊妹稿 A.4.1 同款）：

```ts
// AssetProject(gemgen).summary —— 卡片元信息行直出，免解析文件
summary: {
  templateName?: string      // 模板名快照
  candidateIndex?: number    // 候选序号
  size?: string              // '1024x1024'
  mode?: 'generate' | 'edit'
}
```

- `task.assetId` 语义不变：仍指向归档产物节点，只是节点从 AssetImage 变成 AssetProject(gemgen)——会话任务账本（localStorage meta）结构零破坏，仅新增 `templateAssetId` 字段（快照，画廊过滤键）。
- `meta.referenceAssetId` 的「素材库预览跳转参考图」能力（assetStore AssetMeta 注释）随图片预览一并消失于 gemgen 卡片（项目节点不走图片预览 Dialog）；替代路径 = 实验室画廊展开卡的「放大对比」（经 provenance.referenceAssetId 解析参考图，PreviewDialog 已支持无会话参考图的并排模式——需小改：从 assetId 解析而非会话 reference，见 §B.3）。

### A.3 版本演进策略（round-trip / 迁移链）

沿姊妹稿 A.4.3 纪律，逐字适用：

- `parseGemtpl/parseGemgen` 对 `formatVersion` 向前校验：大于当前支持 → 显式错误「文件来自更新版本的应用，请升级后再打开」，不猜测解析。
- 迁移器：`(from, to) => migrate` 纯函数链逐版本串行；**每次 bump 附往返测试（save→load→save 字节等价）**。gemtpl 注意：换绑保存高频，往返测试须含「未变更字段零漂移」（如 savedAt 之外字段逐字节稳定）。
- `appVersion` 只读展示。gemgen 无 engineVersion（A.2.2）。
- 导入（磁盘拖入/选择 .gemtpl/.gemgen）：ingest → sys-templates / sys-generated 对应落点 → 走 §C.4 双击同款路由。

### A.4 旧数据迁移

#### A.4.1 内置 preset → sys-templates seed（幂等）

- 系统目录 `sys-templates`（名「模板」）：`SYSTEM_FOLDER_IDS` 增一项，`seedSystemFolders` 幂等补建（assetStore 既有机制，seed idempotent + 显示名同步）。
- **seed 逻辑放 lab hydrate（不是 assetStore 迁移）**：每模板需要先物化合成案例图（`materializePresetEffectRef`：fetch public/presets → canvas 合成 → ingest，幂等键 = sys-cases 资产 meta.presetId）——这是 lab 域管线，assetStore 不 import lab 逻辑（模块边界沿现状：assetStore 只认 EFFECT_REF_PRESETS 的静态形状）。
- 确定性节点 id：`ast-tpl-${presetId}`（沿 `ast-preset-*` / `ast-batch-*` 先例）。**幂等口径 = 节点存在即跳过（含软删）**——用户删除内置模板不被复活，回收站还原后自动回到实验室列表。
- 单模板原子性：物化失败（离线/IDB 不可用）→ 该模板本轮不 seed（不建绑定缺失的半成品），下轮 hydrate 重试；已 seed 的模板不受影响。
- **seed 与代码演进的关系（议题 10）**：seed 是 create-only——代码里 preset 定义日后修订（prompt 改写/新增），已存在的模板节点**不被覆盖**（用户编辑优先）；新增 preset 按 id 增量补 seed。`DEFAULT_TEMPLATES_VERSION` 的「bump 即重置存量」语义对库模板**退役**（这正是 0 节主指标）。

#### A.4.2 旧「生成结果」裸图片：不回填（覆议维持 working position）

维持不回填，证据：旧归档图片节点的 meta 只有 `variantName / prompt / runId / candidateIndex / referenceAssetId`（assetStore AssetMeta + archiveGeneratedResult 写入面），**没有 variantId / presetId**——把它关联回某个模板只能靠 variantName 字符串匹配，重名/改名即错配，溯源档案错配比缺配更糟（伪造 provenance）。旧图片留作图片资产展示，不进画廊 union（非任务非 gemgen）；画廊若因此「看不到旧结果」，属于已知边界（判断，置信度高：旧结果无 composedPrompt 可快照，回填的档案也是残缺品）。

#### A.4.3 variants {v:2} 信封：退役（= 议题 9，给立场）

**裁决：退役，一次性迁移为库模板；会话侧只留「启用集合 + 表单」。**

迁移算法（hydrate 内，seed 之后执行）：

1. 读 legacy variants（`loadVariants()`，{v:2} items）。
2. 对每条：id 形如 `tpl-${presetId}` 且内容与代码 preset 一致（promptBody 相等）→ 跳过（seed 已建）；**内容不一致 → 换绑覆写 `ast-tpl-${presetId}` 节点内容**（用户编辑赢过官方默认——这是他们的数据）；其余 id（用户自建）→ ingest 新 gemtpl（provenance.source = 'user-created'）。
3. 案例绑定：legacy `effectRef` 已是 asset kind（合成重构迁移后）→ 原样进 caseBinding；preset kind → 经 `materializePresetEffectRef` 物化改绑（既有机制）。
4. 全部成功后删除 `VARIANTS_KEY`；任一失败保留（下轮重试，幂等：步骤 2 的覆写以内容 diff 为条件）。
5. `enabled`：迁移时把当前启用集合写入新的会话 key（`rhinestone-studio:lab-session`：`{ enabledTemplateAssetIds, selectedTemplateAssetId }`）——刷新保持、与模板内容解耦。

论证：(a) 模板真源唯一化是 PRODUCT_MODEL 硬规则 2 的直接适用——库模板 + localStorage variants 双真源 = 「一个概念两个设置入口」的结构性失败镜像；(b) 版本门重置语义（0 节问题 1）只有退役信封才能根治；(c) 代价：一次不可逆迁移（失败可重试，成功后旧 key 删除）——owner 已有多次「无向下兼容」裁决先例（参照对退役、url kind 删除）。

---

## §B 实验室重构（模板库化 + 任务画廊升级）

### B.1 左侧模板面板（库化）

#### B.1.1 列表与 CRUD

- **列表 = sys-templates 直系子节点中的 gemtpl 节点**（`listChildNodes('sys-templates')` 过滤 type=project/kind=gemtpl，未软删；Owner 裁决 7「从素材库那边做选取」）。用户把模板移出目录 = 从实验室列表收起（素材库仍是真源，移回即恢复；画廊 chips 与 gemgen 弱引用不受影响——见 §B.4 状态矩阵）。
- 交互沿现手风琴骨架（`VariantEditor.svelte` Accordion，single 展开）：trigger = 开关 + 名 + ×N + 案例徽标；Content = 名称/候选数/提示词体 textarea/EffectRefControl + 复制按钮。改动面：数据源从 `variants` $state 换为共享模板 store（新建 `lib/stores/templates.svelte.ts`：sys-templates 索引 + 按 assetId 的响应式 record 表 + CRUD 编排；会话启用态并入 `lab-session` key）——该 store 是双宿主编辑的地基（C.5.3），trigger 增 [复制]，删除沿软删。
- **新增**：立即 ingest（name「模板 N」/ promptBody 空 / 无绑定）→ 列表定位并展开进入编辑。空 promptBody 的模板不参与生成（startRun 现有校验口径不变）。
- **复制（fork）**：ingest 新节点（名 = 「原名 副本」后缀去重），provenance.source = 'forked'；不记 templateAssetId 链（快照语义，同 gemproj 另存为不记 projectId）。
- **删除**：软删入回收站（trashAsset 复用）；画廊孤儿语义见 §B.4；正在编辑被删模板 → 编辑焦点回落列表首项。

#### B.1.2 写回时机裁决：字段提交自动保存（非 ⌘S 显式）——= 议题 4

**裁决：自动保存（onchange/blur 提交即换绑），不引入 ⌘S。** 论证：

1. **行为连续性（一手事实）**：现状模板就是即改即存（updateVariant → persistVariants 逐次写 localStorage），用户对模板从未有过「保存」动作；库化只是把写入介质从 localStorage 换成库节点换绑，交互节奏零变化。引入 ⌘S 反而是新心智。
2. **资产量级不对称**：排钻项目是 20+ 参数的工程态、误改代价高、实验需要可弃性 → 显式保存合理（姊妹稿议题 5）。模板是单字段小配置，编辑粒度天然逐字段，自动保存的「误改」可由「再改回来/复制留底」覆盖。
3. **dirty 守卫不适用**：字段提交即持久，不存在 dirty 态，无守卫负担（对照 studio/edit 的 dirty 三态——实验室模板无需进入那套机器）。
4. 风险与兜底：换绑失败（IDB 满/不可用）→ toast 三段式 + 字段回显旧值（编辑不丢，内存态保留重试）。写放大量级见 A.1.4。

#### B.1.3 EffectRefControl 终态

- 机制不变（上传两方案/单张/粘贴链接三入口 + 物化管线），绑定写回目标从 variant.effectRef 换为 gemtpl.caseBinding（换绑保存）。
- **新增第四入口 [从素材库选]**（复用 AssetPickerHost 选图器）：绑定 = assetId + caseLayout='single'（选库内任意合成图/单张图作案例）。理由：绑定已是纯库资产引用，「从库里选」是零成本补齐的对称入口，也是「模板库化」叙事的闭环（案例与模板同为库资产）。picker 过滤口径 = 图片节点（合成图是图片资产）。
- preset 过渡态语义保留但收窄：仅存在于 seed 物化失败重试期间（A.4.1），用户可见面不再出现「内置案例」kind 绑定（seed 成功后全部为 asset 绑定）。

#### B.1.4 生成动线（startRun 消费库模板）

```
开始生成 ─▶ 校验（BYOK / advancedJson / 至少一个启用且 promptBody 非空的模板）
        ─▶ 对每个启用模板 × candidates：建任务（快照：templateAssetId + promptBody + caseBinding + model/size/advanced）
        ─▶ runTask：请求时 composeDrillPrompt(task.promptBody, 运行时附图组合)（骨架组装时机不变）
        ─▶ 成功 ─▶ serializeGemgen(task, blob) → ingestProjectAsset(gemgen) → sys-generated 批次夹
              （批次夹机制不变：findOrCreateBatchFolder 的计数从 type='image' 扩为 含 project/gemgen）
```

- **`applyTaskParams`（复用参数）语义修订**：现状会把 task.prompt 写回 variant（variantId 命中即覆写，`lab.svelte.ts` applyTaskParams）。库化后模板是持久资产，用旧快照**隐式覆写用户可能已编辑的模板**是数据损失路径。裁决：复用参数只回填表单层（model/size/advancedJson——本来就是会话态）；提示词体不自动写入任何模板，展开卡提供 [复制提示词]（clipboard）。「想用它」→ 新建模板粘贴（两步，可接受；判断，置信度中高）。
- **送排钻消费 gemgen**：`sendToStudio` 的存库校验不变（task.assetId 幂等补建）；handoff 载荷不变 `{assetId, name, referenceAssetId}`；studio 侧 `getAssetBlob` 消费点扩一个 gemgen 分支（parse → image blob）——`lib/persistence/labFile.ts` 出 `getGemgenImageBlob(assetId)` 单点 helper，studio/画廊/下载共用，禁止各处自行解析。

### B.2 任务画廊：IA 裁决

#### B.2.1 过滤形态：画廊头部单选 chips（裁决）

| 候选 | 优点 | 缺点 | 裁决 |
|---|---|---|---|
| **A. 画廊头部 chips 行**（「全部」+ 每模板一 chip 带计数） | 一击切换；计数可见；过滤模型外显（IA：过滤可见而非藏于下拉） | 模板多时占一行（横滑解决） | **采纳** |
| B. 下拉 Select | 省纵向空间 | 两击；计数不可见；藏起过滤态 | 否决 |
| C. 左侧面板选中即过滤 | 零新增控件 | **编辑焦点与浏览过滤两个意图耦死**——点开模板改两笔，画廊唰地只剩它的结果，反直觉 | 否决（结构性） |

- chips 与左侧列表是**两个概念**：chips = 画廊过滤态（浏览意图）；左面板 = 编辑焦点（创作意图）。双击 gemtpl/gemgen 入口**一次性同时设定两者**（Owner 裁决 5/6 明确要求），但用户后续各自独立变化。
- chips 排序 = sys-templates 列表序；孤儿（模板已删/移出）聚合为一个尾部 chip「已删模板」（仅当存在孤儿时出现，见 §B.4）。
- 模板维度过滤生效时，组结构仍是批次（runId）——「按 tpl 分组管理」的落点是：过滤后批次序列即该模板的完整历史（最新在前），比较任务已满足；不引入第二套组结构（两套分组维度切换是过度设计，判断，置信度中）。

#### B.2.2 数据口径：会话任务 ∪ 库内 gemgen（三案对比，裁决）——= 议题 5

| 方案 | 内容 | 优点 | 缺点 | 裁决 |
|---|---|---|---|---|
| **A. 并集（本案）** | 会话任务（活账本：含 running/error/cancelled、可重试取消）+ 库内 gemgen 中未被任何 task.assetId 引用者（只读历史卡） | 双击库内 gemgen 必然可定位（Owner 裁决 6 的硬前提）；localStorage 50 条裁剪（taskStore 三级降级）造成的史洞由库补全；导入的 gemgen 也有家 | 数据面变大；两态卡片（活/只读）需视觉区分 | **采纳** |
| B. 可切换（会话 / 全库两视图） | 各视图纯净 | 双视图 = 同一画廊两个口径要解释；「我到底在看哪个范围」常态混乱；双击动线还得先选对视图 | 否决 |
| C. 纯库（画廊 = gemgen 全集投影） | 单一口径 | 进行中/失败/排队任务无 gemgen，无法呈现——画廊丢掉「生成中」这一核心实时性 | 否决（功能性缺失） |

并集规则：去重键 = `task.assetId === gemgen 节点 id`；合并后按 createdAt 降序、批次分组（runId 沿 `getTaskGroups` 算法，库内来源的 runId 取 provenance.runId）。旧归档裸图片不进并集（A.4.2）。legacy 会话任务（无 templateAssetId）只在「全部」出现，任何模板 chip 下隐藏（矩阵见 B.4）。

#### B.2.3 卡片两态：收起（默认）/ 展开

- **收起（默认态）**：单行横排——缩略方图（~56-64px，状态态用占位：生成中 spinner/失败红点/缓存失效灰）+ 模板名 + 候选号 + 状态/耗时 + 角标（案例绑定/库来源）。行尾 chevron。信息量 = 「一眼扫过批次结果」。
- **展开**：大图（约 3-4 卡宽的横幅位）+ 动作行（活卡：放大对比/送排钻/下载/复用参数/取消·重试；只读卡：放大对比/送排钻/下载）+ error/debug 折叠。点击收起行任意处 toggle；再次点击收起。
- **与现「点击放大」Dialog 的关系**：保留且职责收窄——Dialog = 参考图叠加/并排**对比**器（PreviewDialog 的 opacity 滑杆/双 tab 是展开卡替代不了的工具）；展开卡上的 [放大对比] 打开 Dialog。小修：Dialog 的参考图来源从「会话 reference」扩为「会话 reference ?? provenance.referenceAssetId 解析」（刷新后/只读卡也能对比；解析失败走既有「无参考图」分支）。
- **展开集合持久范围 = 会话内存**（模块 $state，沿 collapsedRuns 先例：切视图保留、刷新复位默认全收起）。理由：刷新后全收起 = 「小图预览的整洁默认」正是 Owner 要的收起价值；持久化展开集合会让回访永远面对上次留下的大图断壁。库内只读卡同口径（会话内存，不写库）。
- 移动端同构：收起行 tap = toggle 展开（无双击歧义）；展开卡动作行折行。

#### B.2.4 双击 gemgen 的定位-展开动线（Journey First 全链）

```
素材库双击 gemgen 卡（移动端：单击）
 ─▶1 openIntent 置位 {kind:'gen', assetId}（新 store，沿 handoff 模式：App $effect 切实验室视图）
 ─▶2 LabView 消费意图（挂载后 $effect；已在实验室则直接响应）：
     hydrate 就绪 → getAsset + parseGemgen（失败 → 三段式 toast，停留/返回素材库，不清意图前不切视图——
     解析在切换前完成：AssetsView 双击 handler 内先 parse 成功再置 intent，失败不离开素材库）
 ─▶3 溯源 templateAssetId：
     存在于 sys-templates → 左面板选中该模板（编辑焦点 + 列表滚到可见）
     已删/移出 → 左面板不动 + 过滤回落「全部」+ toast「模板已删除（或不在模板目录），已定位到结果」
 ─▶4 画廊 chips 设为该 tpl（= 步骤 3 存在时）
 ─▶5 过滤重算 → await tick() → 目标卡 data-testid 定位 → scrollIntoView({behavior:'smooth', block:'center'})
     （若目标卡所在批次组处于折叠态 → 先展开该组，不动其他组）
 ─▶6 目标卡加入展开集合 + 2s 高亮 pulse
 ─▶7 清除意图（一次性消费，防刷新后重放）
```

跨分组时序要点：步骤 4→5 之间必须等画廊 DOM 重建（tick + 过滤后组消失导致的滚动容器高度变化在 scrollIntoView 前完成）；smooth 滚动期间用户手动滚动不中断定位（一次性，不锁定滚动）。双击 **.gemtpl** 动线 = 同链去掉 2/5/6（切实验室 + 左面板选中 + chips 过滤，无定位目标）。

### B.3 状态矩阵（画廊 × 模板库）

| 状态 | 触发 | 呈现 | 出口/恢复 |
|---|---|---|---|
| 模板库空 | seed 失败（IDB 不可用）且无用户模板 | 左面板空态：「模板库为空」+ [重建内置模板]（重跑 seed）+ [新建模板] | 重试 seed / 手动新建 |
| 模板被删但 gemgen 还在 | gemtpl 软删/硬清，gemgen 引用悬空 | 画廊出现「已删模板」chip（聚合孤儿，名取 templateName 快照排序）；展开卡徽标「模板已删除」+ templateName | 回收站还原模板 → 弱引用自动回链（按 assetId，无迁移） |
| 模板被移出 sys-templates | moveAsset 到用户目录 | 实验室列表与 chips 均不再显示（移出=收起）；gemgen 仍可经「已删模板」chip 找到（措辞「不在模板库」） | 移回目录即恢复 |
| 画廊空（全局） | 无任务无 gemgen | 现三步引导卡不动（配置连接/传图/开始生成） | — |
| 画廊空（过滤态） | 选中某 tpl 无任何结果 | 「该模板还没有生成结果」+（已配置时）[开始生成] /（未配置）[配置连接] | 换 chip / 去生成 |
| 生成中 | running/pending 存在 | 收起行 spinner/排队占位 + 头部「生成中 N · 排队 M」徽标（现状保留） | 完成自动刷为缩略 |
| 只读卡（库来源） | gemgen 无会话任务对应 | 收起行角标「库」；展开卡无重试/取消/复用参数 | 送排钻/下载/对比可用 |
| gemgen 解析失败 | 文件损坏/版本超前 | 卡片占位「档案无法读取（来自更新版本？）」+ toast | 格式版本错误走 A.3 拒读文案 |
| 清空历史（语义升级） | 头部清空按钮 | 确认 Dialog：「清除本次会话任务记录；生成结果档案保留在素材库与画廊（只读）」+ 可选 [同时移入库内生成结果]（软删 sys-generated 下 gemgen，二次确认） | 确认/取消 |
| Sheet 编辑·保存失败 | RightSheet 内换绑写库失败（IDB 满/不可用） | Sheet 头部「保存失败 [重试]」+ 字段内存态保留（编辑不丢） | 重试成功 → 已保存指示；此时关闭触发守卫行 |
| Sheet 关闭守卫 | 关闭时有未提交输入（textarea oninput 未 blur）或失败写入 | 先 flush 提交；失败 → 三选 mini Dialog「重试保存 / 放弃修改并关闭 / 继续编辑」 | 放弃 = record 回退到最后成功换绑内容 |
| 双宿主同开同一模板 | 实验室面板与素材库 RightSheet 同时编辑同一 tpl | 同一 $state record（templates store），编辑实时互见 | 按构造无冲突（C.5.3），无提示噪音 |
| Sheet 编辑中模板被删 | 回收站软删/硬清（另一入口） | Sheet 转「模板已删除」终态 + 自动关闭；在途 flush 不再写 | 回收站还原 → 重新打开 |
| 跨标签页同编辑 | 两个浏览器 tab 各持 record 副本 | 最后写赢（blob 换绑 + 引用计数 GC 善后，无合并） | 检测告警列 P2 |

（「清空历史」必须升级为确认 Dialog：并集口径下单纯清任务不会清画廊，旧按钮的承诺失效——不解释就是 bug 观感。）

### B.4 线框（桌面 lg+；左列 400px 沿现骨架，仅标注改写面）

```
┌────────────────────────────────────────────┬───────────────────────────────────────────────────┐
│ 配置列 400px（左）                          │ 画廊主区（右）                                       │
│ ┌────────────────────────────┐             │ 任务画廊  [12 张候选] [生成中 1]        [清空历史 ⌫] │
│ │ Dropzone（不变）             │             │ 过滤: (全部·12)(城市分层·全要素·4)(花环边框·6)…▸   │
│ ├────────────────────────────┤             │ ┌─ 第 3 次运行 14:32 · 4 张 ─────────────────────┐ │
│ │ 模板  [8 个 · ×12]     [+] │             │ │ ▾ [缩略] 城市分层·全要素 候选1 完成 8.2s  [案例] │ │
│ │ ┌────────────────────────┐│             │ │ ▾ [缩略] 城市分层·全要素 候选2 完成 7.9s  [案例] │ │
│ │ │▣ 城市分层·全要素 ×2 案例 ││             │ │ ▴ [展开大图……………………] [放大对比][送排钻]        │ │
│ │ │  名称/候选/提示词体       ││             │ │   [下载][复用参数]  ◂再点收起                  │ │
│ │ │  EffectRefControl(+库选) ││             │ │ ▾ [缩略] 花环边框 候选1 生成中…                  │ │
│ │ │  [复制][删除]            ││             │ └─ 第 2 次运行 11:07 · 8 张 ─────────────────────┘ │
│ │ ├────────────────────────┤│             │   （过滤=「花环边框」时：仅含该模板卡片的批次序列）    │
│ │ │▢ 花环边框 ×3 案例        ││             │                                                    │
│ │ └────────────────────────┘│             │                                                    │
│ ├────────────────────────────┤             │                                                    │
│ │ 高级请求参数（不变）          │             │                                                    │
│ └────────────────────────────┘             │                                                    │
│ [RunBar 吸底：开始生成 × 12]                │                                                    │
└────────────────────────────────────────────┴───────────────────────────────────────────────────┘
```

改写面清单：VariantEditor = 重写（数据源库化 + 复制/删除 + EffectRefControl 第四入口）；TaskQueue = 重写（chips 行 + 并集分组 + 两态卡）；TaskCard = 重写（收起行/展开态两形态）；Dropzone/RunBar/PreviewDialog = 微改（Dialog 参考图来源扩展）；LabView = 挂 openIntent 消费。移动端：chips 横滑行；收起行全宽；其余沿单列自然流。

---

## §C 素材库联动

### C.1 sys-templates「模板」目录

`SYSTEM_FOLDER_IDS` 增 `sys-templates`（名「模板」，禁删/改名/移动自身——系统目录统一契约；条目可移动/软删）。`SYSTEM_ENTRIES`（AssetsView）插入「生成结果」之前（模板→生成结果的产线邻接）：全部素材 / **模板** / 生成结果 / 上传 / 导出 / 案例 / 回收站。seed 幂等见 A.4.1（目录 seed 在 assetStore，条目 seed 在 lab hydrate）。

### C.2 「生成结果」目录产物换 .gemgen

- `archiveGeneratedResult` 重写：`serializeGemgen` → `ingestProjectAsset`（vendor MIME 白名单四值，姊妹稿 A.4.1 机制）→ 批次夹（`findOrCreateBatchFolder` 计数口径扩为 image + project(gemgen)，文件夹名 `MM-DD HH:mm · N 张` 不变）。
- 归档串行链（enqueueArchive）、三步补偿（reconcileUnarchivedResults）、空批次清理——机制全保留，仅换产物形态。
- **gemgen 卡片有缩略（P0，偏离姊妹稿「项目缩略 P1」）**：归档/导入时顺手渲染 256px thumb（图字节在手，canvas 一次）。理由：生成结果是视觉资产，「生成结果」目录无缩略等于图片目录退化成文件名列表——与图片卡的检索体验断裂（IA：视觉检索是本目录的主检索任务）。gemtpl 无缩略（文本资产：类型图标 + summary 直出）。gemproj/gemdoc 维持姊妹稿 P1 判断（参数/文档型，图标+摘要够用）。

### C.3 projectKind 四分化卡片呈现

`AssetProject.projectKind: 'gemproj' | 'gemdoc' | 'gemtpl' | 'gemgen'`（姊妹稿 A.4.1 类型扩展至四值）。

| | gemtpl | gemgen |
|---|---|---|
| 图标 | 模板 motif（LayoutTemplate 类） | Sparkles（与目录图标同源） |
| 缩略 | 无（图标 + 类型徽标「模板」） | 有（256px thumb，C.2） |
| summary 直出 | 「×2 候选 · 已绑案例 / 未绑案例」 | 「城市分层·全要素 · 候选 2 · 1024×1024」+ 溯源徽标（模板名快照） |
| 类型徽标 | 模板 | 生成 |

### C.4 双击路由四分流 + 打开意图通道

- 通道：新 `lib/stores/openIntent.svelte.ts`（沿 handoff 模式）：`setOpenIntent({kind:'tpl'|'gen', assetId})`；App 层 `$effect` 见意图 → setView('lab')；LabView 消费后清除（B.2.4 全链）。gemproj/gemdoc 的路由意图通道由姊妹稿任务 2.7 承担，App 层统一为「openIntent 四分流」单通道（kind 四值），避免两条并行意图 store（实现细节由 Codex 归并，纪律：**意图一次性消费、切换前完成解析、失败不离开当前视图**）。
- 全局导入（磁盘拖入/选择四格式）：ingest → 按类型路由（前两切对应页，后两走本链）。
- **移动端：单击 = 打开**（无双击）；长按 = 多选（现状）。（gemtpl 的「打开」= 去使用，卡面双动作分工见 §C.5.1）

### C.5 gemtpl 卡片：去使用 / 去编辑（RightSheet）（[Owner 2026-09-19 追加裁决]）

Owner 追加裁决要点：素材库管理 tpl 的两个主要动作 = **去使用**（跳实验室测试使用，即此前「双击 .gemtpl」动线的本体）与**去编辑**（在 **RightSheet 右抽屉**展开「和在提示词实验室一样的编辑体验」——提示词体 + 案例参照绑定等，编辑完成写回 .gemtpl 资产，不离开素材库；**移动端支持必须好**）。

#### C.5.1 动线收敛：一个动作一个 handler（防「三四个入口各走各的」）

| 动作 | canonical handler | 入口（affordance） |
|---|---|---|
| 去使用 | `openIntent {kind:'tpl'}`（= §C.4 路由 + §B.2.4 动线：切实验室 + 左面板选中 + 画廊 chips 过滤） | 桌面**双击卡面**（canonical 手势）/ 桌面**悬停浮层 [去使用]** / 移动端**单击卡面** / 选中态工具行 **[打开]** / 全局导入路由 |
| 去编辑 | `openTemplateSheet(templateAssetId)`（本节 RightSheet） | 桌面**悬停浮层 [去编辑]** / 移动端**卡面右上常驻 ✎ 小按钮** /（P2：右键·长按菜单收敛进多选菜单） |

裁决理由：
- **去使用 ≈ 双击，二者就是同一动线**：此前裁决的「双击 .gemtpl → 实验室 + 画廊过滤」是本体；卡面按钮/工具行只是同一 handler 的可见性补齐——双击不可发现、按钮可发现（interaction-design：主要动作必须有可见入口，手势是加速器不是唯一路径）。
- 单击语义不变（桌面 = 选中、移动端 = 去使用即主开行动作）；悬停浮层仅桌面存在（触摸无 hover）。
- gemgen 卡片本稿**不加**浮层（双击定位动线已覆盖其主任务；悬停 [去实验室查看] 列 P2 对称补齐——scope 纪律）。
- 入口矩阵的纪律：**任何新增入口必须绑定上表两个 handler 之一**，禁止第三条独立路径（IA：多入口 converge 到 canonical）。

#### C.5.2 RightSheet 信息架构

- **组件族**：shadcn-svelte **Sheet（side="right"）**——与 AssetsView 既有移动端目录 Sheet（side="bottom"）同族同原语（Dialog primitives + 滑入变体）；新建薄宿主组件 `TemplateEditSheet.svelte`（只负责 chrome：头部/滚动体/关闭守卫），**不新造组件体系**。
- **宽度断点**：`w-full sm:max-w-[520px]`——移动端全宽滑入（Owner 点名移动端要好的落点：全宽无横向局促、顶部拖拽把手可下滑关闭、底部 safe-area padding、textarea 字号 ≥16px 防 iOS 聚焦自动缩放）；桌面 lg+ 固定 520px（实验室配置列 400px 是编辑器内容的设计宽度下限，520px 留出呼吸；网格在抽屉之后仍可见 = 「在库里就地改」的空间连续性，Spatial Continuity）。
- **头部**：模板名 + 保存态指示（「已保存 14:32」/「保存失败 [重试]」）+ 关闭 ✕；**体部**独立滚动 = 内嵌 TemplateEditor（C.5.3）；EffectRefControl 的嵌套对比 Dialog 经 portal 悬浮于 Sheet 之上（shadcn Dialog 默认 portal 到 body；Sheet→Dialog 焦点陷阱链列入走查项）。

#### C.5.3 编辑器双宿主复用（结构性要求，写进实现方契约）

**`TemplateEditor.svelte` 必须抽出为可嵌入组件**（名称 / 候选数 / 提示词体 textarea / EffectRefControl 四件套 + 字段提交回调），两个宿主共用：

1. 实验室 VariantEditor 手风琴 Content（现宿主，`VariantEditor.svelte`）；
2. 素材库 TemplateEditSheet（新宿主）。

配套结构要求：模板的响应式 record 上移到共享模块 store（B.1.1 的 `lib/stores/templates.svelte.ts`）。**双宿主绑定同一 record**——实验室面板与 RightSheet 同时打开同一模板时是同一份 $state，编辑实时互见，冲突按构造消解（而非靠提示仲裁）；宿主只提供 chrome，**不持有编辑态副本**（持有副本 = 漂移的开始）。

#### C.5.4 保存语义与守卫（沿 B.1.2 自动保存模型）

- 字段提交（onchange/blur）即换绑写回 .gemtpl——与实验室面板**完全同一模型**，RightSheet 不引入第二套保存语义（Owner：「保存语义沿你正在裁定的模板保存模型」）。无 [保存] 按钮；关闭按钮文案 [完成]。
- **关闭守卫**：关闭时先 flush 未提交字段（textarea oninput 未 blur 的文本）；写库失败 → 三选 mini Dialog「重试保存 / 放弃修改并关闭（record 回退到最后成功换绑内容）/ 继续编辑」。
- **编辑中模板被删**（回收站/另一入口）：Sheet 转「模板已删除」终态 + 自动关闭，在途 flush 不再写。
- **跨标签页并发**：两 tab 各持 record 副本，最后写赢（blob 换绑 + 内容寻址 GC 天然善后，无合并语义）。单用户本地应用，接受 last-write-wins（判断，置信度高；storage 事件检测告警列 P2）。

#### C.5.5 线框（RightSheet；桌面 520px / 移动端全宽）

```
素材库网格（gemtpl 卡）                     ┌─ RightSheet（side=right）─────────────┐
┌───────────────┐  桌面 hover 浮层           │ 城市分层·全要素   已保存 14:32     ✕ │
│ ▤ 模板徽标      │  ┌───────────────────┐   ├──────────────────────────────────────┤
│ 城市分层·全要素  │  │ [去使用]  [去编辑]  │   │ TemplateEditor（与实验室同构）           │
│ ×2 · 已绑案例   │  └───────────────────┘   │ 名称 [____________]   候选 [ 2]       │
│        (✎)*    │  移动端：✎ 卡右上常驻；     │ 提示词体 textarea …（字号≥16px）        │
└───────────────┘  单击卡面 = 去使用           │ 案例参照图（EffectRefControl）           │
                                           │  [粘贴链接][上传两图][单张][从素材库选]    │
                                           │ （底部 safe-area padding；体部独立滚动）   │
                                           └──────────────────────────────────────┘
                                           * ✎ 仅移动端常驻；桌面走悬停浮层
```

### C.6 打开手势统一 + 单击语义（= 议题 7，含对姊妹稿的对齐修正申请）

Owner 裁决（经 openspec design 7.4）：**双击打开（移动端单击），单击仅选中**。本稿细化并申请统一：

- **项目节点（四格式）**：单击 = 选中（primary ring 高亮，不弹预览）；双击 = 打开（路由）。选中态下工具行出现 [打开]（= 双击等价物，键盘 Enter 亦触发；gemtpl 的「打开」= 去使用，动作映射表见 C.5.1）与 [重命名]（行内编辑，Esc/Enter/失焦提交——沿现图片行内重命名交互）。
- **图片节点**：**申请同步修订为同一模型**——双击 = 打开（预览浮层）、单击 = 选中、重命名移入选中态工具行/Enter。现状「图片双击 = 行内重命名」（AssetsView startInlineRename）与「项目双击 = 打开」若并存，同一网格两种双击语义，用户无法建立稳定预期（interaction-design：可预期性 > 局部习惯）。
- **对姊妹稿的对齐修正（非豁免）**：姊妹稿 A.4.2「项目节点点击 = 用对应页面打开」与硬规则 5「项目文件点击 = 打开」措辞需随 Owner 双击裁决升级为「双击（移动端单击）打开，单击选中」——请 Codex 在合并裁决时一并修订两处文本，避免姊妹稿实现（任务 1.4/2.x）与本稿实现（任务 4.2）落地两套手势。

### C.7 「全部素材」口径与底栏计数

- `visibleItemCount` / `childrenOf` / `recentAssets` / `isLibraryEmpty` / `generatedCount`（library.svelte.ts，现 image-only 过滤）type-aware 化：recent 集合**只收图片**（最近的使用动线是选图/送排钻，gemgen 经画廊定位更短——gemtpl/gemgen 不进「最近」；判断，置信度中）；`generatedCount` 扩为含 gemgen 节点。
- 底栏：「共 N 项 · 图片 X · 项目 Y」（项目聚合四 kind，不拆分——拆到四类是计数噪音；沿姊妹稿口径）。
- 素材库 Tab 名不改（姊妹稿议题 7 立场沿用：项目占比 >30% 再议）。

### C.8 PRODUCT_MODEL v3 增补草案（diff 形式，随姊妹稿 C.4 一并裁决）

- 对象树改：`实验室 · 模板（.gemtpl）= AssetProject 节点（真源；sys-templates，页面内编辑、字段提交换绑写回）`；`实验室 · 模板案例绑定 = 引用资产（assetId + caseLayout；preset/url 形态退役）`；`实验室 · 生成结果（.gemgen）= 自动入库（不可变档案：内嵌图 + 溯源；source='lab-generate'）`。
- 真源表改：`提示词模板 = 素材库（AssetProject, gemtpl）｜快捷入口：实验室左面板`；`生成历史 = 实验室画廊（会话任务 ∪ 库内 gemgen）｜删任务记录不删档案`。
- 硬规则增：7. 模板编辑的唯一编辑器 = TemplateEditor 组件，双宿主（实验室模板面板 / 素材库 RightSheet）共用，编辑态真源 converge 到库资产 .gemtpl（宿主不持有副本，见 C.5.3）；8. `.gemgen` 不可变（生成即定稿，重试产新档）。
- 交接语义增：模板 → 任务 → gemgen 是「配置 → 快照 → 档案」三级降熵链：模板可编辑（换绑）、任务快照可重试、档案不可变；composedPrompt 全文只存在于档案。

---

## §D 记分卡

**现状实验室（2026-09-19 走查，模板/画廊维度）**：

```
Product coherence:   5/10  模板半库半 localStorage（案例绑定=库资产、内容=variants 信封）；版本门可整体重置用户模板
Journey continuity:  5/10  素材库里的生成结果双击只预览图片，回不到画廊语境；无跨模块打开动线
IA integrity:        6/10  画廊仅「全部」单维（run）；模板维度不可检索；素材库无模板位
Interaction clarity: 7/10  卡片动作齐全；信息密度单档，无收起态
State visibility:    7/10  组头状态汇总好；模板「存在哪/是否持久」不可见
Visual quality:      7/10  克制一致；大批量下画廊同质卡片瀑布
VERDICT: NEEDS-WORK（coherence/journey < 7 双触发——真源结构与回访动线问题，页内修补无效）
发布会截图测试: 不能 —— 50+ 结果的画廊是无层级的同质卡片瀑布
```

**目标态（自评，供实现后复测）**：coherence 9（模板/档案真源均入库，One Concept One Canonical Location）/ journey 9（双击两动线 converge 到画廊定位-展开，失败分支全显式）/ IA 9（chips×批次双维 + 只读卡角标区分）/ interaction 8（两态卡片 + 定位动线 + 复用参数非破坏化）/ state 9（孤儿/空过滤/解析失败/清空历史确认全显式）/ visual 8-9（收起行扫读 + 展开卡聚焦的层级）。VERDICT: SHIP（待 Codex + 实现复测）。

---

## §E 给 Codex 的议题清单（附立场；编号接 openspec design §8 之后的实验室专属序）

1. **gemgen 图片内嵌 vs 引用**（= design 议题 8 的细化）：内嵌 dataUrl（本案 A.2.3）vs「元数据文件 + 独立图片资产」双节点。
   立场：**内嵌**。33% 体积通胀换自包含可导出；双节点方案让「生成结果」目录条目翻倍（一个概念两个家），且出库即断链。若 Codex 从存储压力反驳，请给出「双节点 + 库内去重」在 IDB 无配额硬限场景下的实际收益测算——我方预判不成立（浏览器 IDB 配额通常是磁盘级）。
2. **旧「生成结果」裸图片是否回填包装为 gemgen**（= design 议题 9 覆议）。
   立场：**不回填**（A.4.2）。旧节点 meta 无 variantId/presetId，模板关联只能字符串匹配——错配的溯源档案比缺配更有害。旧图留作图片资产，画廊不收录（已知边界，不修复）。
3. **variants {v:2} 信封退役 vs 保留会话缓冲**（= design 议题 10）。
   立场：**退役 + 一次性迁移**（A.4.3：用户编辑覆写 seed、自建变体入库、enabled 落会话 key、成功后删 VARIANTS_KEY）。保留信封 = 模板双真源（结构性失败）；「离线缓冲」论点不成立——库写入失败时字段编辑保留在内存态 + 重试（A.1.4 兜底），不需要第二持久层。若 Codex 担心迁移不可逆风险，可加「迁移前把 {v:2} 原文搬进一次性备份 key（30 天后清）」的保险丝——我方认为不必（Owner 多次裁决无向下兼容）。
4. **模板保存时机：字段提交自动换绑 vs ⌘S 显式**。
   立场：**自动**（B.1.2）。行为连续性（现状即改即存）+ 模板是轻量配置非工程文档；dirty/守卫机器不为模板引入。若 Codex 认为换绑 GC 频率有风险，请以量级反驳（<10KB/次 vs 生成 1-3MB/次）。
5. **画廊数据口径三案**（并集 / 可切换 / 纯库）。
   立场：**并集**（B.2.2）。双击定位动线（Owner 裁决 6）在 B/C 案下不成立或需视图前置条件；纯库案丢失生成中实时性。配套义务：只读卡视觉区分 + 「清空历史」升级为确认 Dialog（B.3）。
6. **模板删除/移出时 gemgen 的孤儿语义**。
   立场：**弱引用降级**——不级联删档案；画廊「已删模板」chip 聚合 + 卡片徽标；回收站还原自动回链（按 assetId）。删除模板的确认文案明示「N 个生成结果将保留（其模板标记失效）」。
7. **素材库打开手势统一**（本稿 C.6）：项目四格式「单击选中/双击打开」是否同步施加于图片节点（双击=预览、重命名移入选中态），以及姊妹稿 A.4.2/硬规则 5 的文本修订。
   立场：**统一**。同一网格两种双击语义不可学习；图片现「双击重命名」让位于文件管理器通识（双击=打开）。若 Codex 判定图片行为变更波及面大，可折中为「本 change 只落项目节点新手势 + 图片双击保持重命名」，但必须在姊妹稿标注 P2 统一——不接受两套语义长期并存且无追踪。
8. **enabled（参与生成开关）的归属**：gemtpl 文件内 vs 会话层。
   立场：**会话层**（`lab-session` key，A.4.3 步骤 5）。「资产内容 vs 使用意图」分层；双击打开模板不恢复 enabled 的语义支持此判。反方论点（存文件=刷新零丢失且少一个 key）也成立——若 Codex 倾向文件内，请同步裁决「seed 模板的默认 enabled」并接受模板文件携带会话态的语义混杂；我方维持会话层。
9. **gemgen 缩略 P0 vs 沿姊妹稿项目缩略 P1**。
   立场：**gemgen 提前 P0**（C.2：归档/导入时 256px thumb）。视觉资产的目录无缩略不可用；成本一次性 canvas。gemproj/gemdoc/gemtpl 维持 P1/无缩略。
10. **模板 seed 与代码 preset 演进的冲突策略**：create-only（用户编辑不被官方修订覆盖）vs 每次版本 bump 重置（沿 DEFAULT_TEMPLATES_VERSION 旧语义）。
    立场：**create-only + 新 preset 增量补**（A.4.1）。bump 重置语义正是本次要根治的数据损失路径；官方想推送修订版模板 → 以新 presetId seed 新条目（并存，用户自选），不覆写。
11. **advancedJson 打码入 gemgen**：沿 taskStore N3 打码（maskAdvancedJsonForPersist）vs 原文存储。
    立场：**打码**。localStorage 与导出文件同级的明文暴露面（档案可被带走）；复用参数场景下打码键的保真度损失已被现有 task meta 接受（同一口径），不为文件格式破例。
12. **TemplateEditor 双宿主复用 vs RightSheet 独立实现**（C.5.3，Owner 追加裁决的结构性要求）。
   立场：**强复用 + 共享 record store**。独立实现必然漂移——「和在实验室一样的编辑体验」靠两处代码人肉同步是幻觉，Owner 措辞本身就在禁它；更粗粒度的「把实验室整个配置列嵌入 Sheet」否决（带入 Dropzone/RunBar 等无关内容，抽屉变成第二个实验室）。若 Codex 实现中发现手风琴 Content 与 Sheet 体部的布局需求分叉大到无法同组件，请先回来重议组件切分线（编辑器内聚「名称/候选/提示词体/案例绑定」四件套，宿主自管 chrome），而不是就地复制一份。

---

## §F 执行摩擦反馈（协议要求）

1. **「PM 补充稿裁定」的效力等级需要协议定义**：openspec design §7 多处预写了「PM 补充稿裁定并集口径」等委托裁决——补充稿实质是议题表的 PM 立场载体，但仍需 Codex 走完裁决闭环。建议协议明确：被委托裁定的默认效力 = 议题表立场（不作为实现依据直至裁决），避免「补充稿写了就直接实现」与「补充稿是规范性文件」两读。
2. **任务题干内嵌推荐答案**：如「保存=换绑……（模板可编辑，应是换绑——给出论证）」——PM 独立论证后结论一致，但题干预设削弱了可证伪性。建议下发时分离「已知 working position」与「开放问题」，让 PM 的反方检验留出真实空间。
3. **双击手势的跨稿冲突**：Owner 双击裁决与姊妹稿已冻结的「点击=打开」、与现状「图片双击=重命名」三方不一致，波及两份设计稿与两个任务组（1.4/2.x 与 4.2）。本稿以议题 7 + 对齐修正申请处理——建议 openspec change 层面做一次手势语义的合并裁决，避免实现期两套手势先落地再返工。
4. **迁移职责的模块边界首次被打破**：模板 seed 需要 lab 域的物化管线（materializePresetEffectRef），故放在 lab hydrate 而非 assetStore 迁移（A.4.1）。这是「结构迁移出 assetStore」的第一例，建议在 add-asset-library spec 或 PRODUCT_MODEL 注一笔边界规则（assetStore 迁移 = 纯节点/拓扑；涉及域管线的 seed 归域 store hydrate），否则下次设计还会重新争论。
5. **防御性上限的归属迁移**：saveVariants 的 32 条上限 / promptBody 8000 字符截断原属 localStorage 防线；库化后由 schema 校验接管（本稿保持 8000 不变）。这类「旧防线新家」的值迁移建议显式登记（tasks 4.1 的测试口径），防止两边都以为对方在管。
6. **AssetMeta.prompt 与 gemgen composedPrompt 的敏感度口径**：本稿将 N3 打码纪律延伸到文件（议题 11），但「图片节点 meta.prompt 明文」的现状并未同步处理（旧归档不回填故维持）。Codex 复核时请确认这是可接受的遗留面，或提议旧 meta 字段在读取面统一脱敏。
7. **追加裁决的并入格式**：Owner 在设计进行中追加「去使用/去编辑 RightSheet」裁决，本次以增量修订并入（新增 §C.5 全节 + §B.3 矩阵五行 + 议题 12 + PRODUCT_MODEL 硬规则 7 改写 + §C 编号重排），未重写全文。建议协议固化「追加裁决合并格式」：新小节承载增量、显式改写受影响小节、引用处以节号+符号名双锚定（本次 §C.5→C.6 重排即暴露纯节号引用的脆弱性）。
```
