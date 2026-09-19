# Design: 实验室高级选项（水钻参数 + 蓝图）与生图生命周期

> 规范性来源（冲突时以 Owner 2026-09-20 原话为准）：
> - Owner 重定义原话（2026-09-20，本文 §0.1 逐字落档）——**推翻** `.agents/documents/2026-09-19-expert-workbench-and-sizes/expert-workbench-and-sizes.md` §C 的「双模式/workflowMode」框架与 gemspec R1 议题 9 的 workflowMode 半边；
> - 继承面：gemspec R1 议题 8/P0-3（effect/blueprint 子任务状态）、议题 12（清单默认 8 + 警告）、§C.2 注入段文本、§C.3 蓝图 prompt 骨架与人审参照定位（`.agents/documents/2026-09-19-expert-workbench-and-sizes/codex-review-r1.md`）；
> - 跨 change 契约：`openspec/changes/add-gem-catalog-and-sizes/design.md` §1.1/§1.3（canonical 类型与四格式 v2——**其 gemtpl/gemgen 行的 workflowMode 字段由主会话同步修订为正交高级选项键，本 change 以修订后口径消费**）；`openspec/changes/add-project-files/design.md` §7（.gemtpl/.gemgen 契约与归档链现状）。
> 所有「现状」断言带 `源码文件:行号`（2026-09-20 源码树实测）。本 change 不宣称任何未实现内容为已完成。

---

## 0. 定调：没有「双模式」（Owner 2026-09-20 重定义落档）

### 0.1 Owner 原话（逐字）

> 「3.1 提示词实验室双模式并不是真正意义上的『双模式』，而是一种『结构化编辑提示词』的能力：目的是将钻石素材、尺寸信息等数据信息引入……是在 案例参照图+参考图（原图）+提示词（包含对案例图和原图的一些描述和要求） 的基础上，增加了 钻石素材图和尺寸信息，这些信息也都是要拼接到提示词里面去的。所以在前端看来，只是提供了一个『高级选项』，打开这个开关，填充必要信息就可以了。
> 3.2 同理，蓝图效果也只是一个『高级选项』，如果打开，本质上是对提示词做一些追加：补充了蓝图生成的一些提示词要求，甚至会追加补充蓝图的一些参考图。
> 所以不论是『蓝图效果』还是『水钻参数配置』，都是正交的可以独立启用的，也就是说我们在制作模板的时候，完全可以按需启用。
> 另外，『蓝图效果』这个把它标记成一个『beta』功能，它可能不稳定，因为可能会有其它工作流可以替代。比如……将它和成品图同时生成，但这就会导致生成存在随机性，更加可靠的做法可能是先生成成品效果图，然后再将效果图、原图、钻石素材图、搭配提示词和蓝图参考图，最后再生成蓝图。
> 在底层，你需要做的是实现生图功能的生命周期，在此基础上去实现蓝图效果」

### 0.2 一句话裁决

1. **基础形态恒定**：案例参照图（合成，`caseBinding`）+ 参考图（原图）+ 提示词（模板特化体 + 组装骨架）——这就是现状行为（`lab.svelte.ts:1048-1062` 附图序 `[案例, 参考]` + `composeDrillPrompt` 组装），不是任何「模式」。
2. **其上是两个正交、独立启用、模板级的高级选项**：
   - **水钻参数配置 drillParams**：开关 + 可用钻清单（素材库 `.gemshape`/内置规格引用 + 每钻尺寸 + 编号）+ 可选尺寸声明（`PhysicalCanvas`，可选）；开启后**数据拼接到提示词**，自定义钻素材图作为附加参考图（§2.3 冻结策略）。
   - **蓝图效果 blueprint（beta）**：开关 + beta 标记；开启后追加蓝图提示词要求 + 可追加蓝图参考图。
   - 正交性：drillParams on × blueprint off / drillParams off × blueprint on / 双开 / 双关 四象限全部合法（蓝图在无钻清单时退化为无编号纯转换，§2.4）。
3. **开关宿主 = 模板（.gemtpl v2 正交键）**：「我们在制作模板的时候，完全可以按需启用」〔Owner〕——高级选项区住在 TemplateEditor（双宿主组件，add-project-files 4.3b 已落，实验室手风琴 + 素材库 RightSheet 同 record 互见）；发起面板不重复编辑（One Concept → One Canonical Location）。
4. **`workflowMode` 概念退役**：`.gemtpl`/`.gemgen` v2 不再有 `workflowMode` 字段；`requestMode`（endpoint 语义 `'generate'|'edit'`，旧 `mode` 拆分迁移）保留——蓝图第二请求天然是 edit。
5. **底层先行**：先落「生图生命周期」（stage 树编排，§3），蓝图效果作为其上的 stage kind（§4）。

### 0.3 对既有文档的推翻 / 继承面（逐条登记）

| 既有裁决 | 处置 | 说明 |
|---|---|---|
| 专家稿 §C.1「实验室双模式 run 级开关 workflowMode」+ §C.2「模式单选 UI」 | **推翻（Owner 2026-09-20）** | 双模式框架退役；模式单选 UI 不做；run 级只剩蓝图策略选择（§4.3） |
| 专家稿 §C.2 提示词注入段（【尺寸与钻规格】+ 比例锚）与钻清单上限（默认 8 + 可读性警告不阻断，R1 议题 12） | **继承（改挂点）** | 注入内容照收，触发条件从 `workflowMode='product'` 改为 `drillParams.enabled`；清单宿主从实验室设置面板改为模板编辑器高级选项区 |
| 专家稿 §C.3 蓝图机制（第二请求携成品图走 `/images/edits`；人审参照非 BOM 数据源；图例必须、逐钻标号尽力；机器级同排布另立 change） | **继承 = 策略 B** | Owner 2026-09-20 原话把该机制重述为「更加可靠的做法」= 默认策略；策略 A（同生）为 Owner 提及的备选，默认关闭 |
| gemspec R1 议题 9/P0-7「requestMode/workflowMode 两字段分离」 | **半退役** | `requestMode` 保留；`workflowMode` 退役。size 结构化 `{widthPx,heightPx}` 半边仍归 add-gem-catalog（与本 change 正交，比例锚消费其类型） |
| gemspec R1 议题 8/P0-3「effect/blueprint 子任务状态，父任务派生汇总」 | **继承并一般化** | 一般化为 stage 模型（§3.1）：main/blueprint 两 stage kind，各自 `requestId/status/assetId/error/retryCount`，父任务派生汇总不落独立真源 |
| add-gem-catalog design §1.3 gemtpl v2 `workflowMode?`+`gemSpecIds?`、gemgen v2 provenance `requestMode/workflowMode` | **主会话同步修订为正交键**（本 change 不改该文件） | 修订后口径见本文件 §1.3；本 change 依赖轨 4.x 消费修订版 |
| add-project-files §7.1「总装骨架永不入 gemtpl」/ §7.2「gemgen 不可变、重试产新档」 | **继承** | 高级选项注入段属组装器骨架（§2），永不入模板体；归档不可变纪律在 stage 模型下重申（§5.1） |

### 0.4 显式不做（其他 change 所有）

| 不做项 | 归属 |
|---|---|
| 尺寸/钻形格式契约、`.gemshape` schema gate、canonical 类型（BaseSpec/GemSpecSnapshot/PhysicalCanvas）、四格式 v2 版本表与迁移入口冻结 | add-gem-catalog-and-sizes（W0） |
| 专家工作台（改名/属性面板/nudge/对齐分布/钻形库上传向导 UI） | rename-and-expert-workbench |
| 图层化（LayerRecord/replay/handoff 层化消费） | studio-layers |
| 画廊重构（chips 过滤/并集/收起展开两态——已落，add-project-files 4.5） | 已落；本 change 仅加任务卡蓝图最小子态（§5.3） |
| 蓝图机器级同排布（结构化布局输出 + 本地 renderer） | 另立 change（Owner 拍板项，专家稿 §I.5-1 沿用） |

---

## 1. 数据契约：模板高级选项与档案正交键

### 1.1 模板侧：.gemtpl v2 正交键（本 change 消费口径；schema 冻结宿主 = add-gem-catalog W0 §1.3 修订版）

现状：`GemtplFile` 无任何高级选项键（`labFile.ts:159-180`）；模板 store 的 `TemplateRecord` 同样只有 name/promptBody/candidates/caseBinding（`templates.svelte.ts:62-67`），提交白名单不含新字段（`templates.svelte.ts:256-278`）。v2 增两正交可选键：

```ts
/** 水钻参数配置（模板级高级选项）。键缺席 = 从未配置；enabled=false = 配置过但当前关闭（数据保留）。 */
interface GemtplDrillParams {
  enabled: boolean
  /** 可用钻清单：canonical specKey 有序数组（内置 'round-ss10' / 自定义 'custom-<assetId>'）。
   *  数组序即编号序——run 时物化为 GemSpecSnapshot[]（ordinal = 1..n 按数组序）。 */
  specs: string[]
  /** 可选尺寸声明（结构化，可选——Owner 3.1「尺寸信息可选」）。 */
  physical?: PhysicalCanvas        // { widthMm, heightMm, anchorSource:'declared' }
}

/** 蓝图效果（模板级高级选项，beta）。策略不入模板（任务级可选，§4.3）。 */
interface GemtplBlueprint {
  enabled: boolean
  /** 蓝图参考图：素材库资产弱引用（≤2 张；上传即入库 sys-uploads 先例 + AssetPickerHost 选图）。 */
  refs?: string[]
}
```

裁决与禁令：

- **`enabled` 标志保留在键内**（而非「键缺席=关」的二态）：编辑器里关灯不丢用户已填清单——数据保留是 UX 底线；round-trip 字节等价不受影响（键序确定）。〔判断·高置信〕
- **模板只存 specKey 引用，不存快照**：沿 add-gem-catalog「层配置只存 specKey，输出物化快照」裁决——身份唯一持久源是 `specKey`；ordinal/sizeLabel/diameterMm 等在 run 时物化进任务与 gemgen（`gemSpecs`）。目录改动（重命名/换绑）不污染模板。
- **validation**：`enabled=true` 时 `specs.length ∈ [1, 清单上限]`（默认 8 + 可读性警告不阻断——R1 议题 12 继承）；`specs` 内 specKey 去重（重复 = typed error 拒写）；`physical` 存在时宽高正数。`blueprint.refs` 去重、≤2。
- **提交模型**：沿 gemtpl「字段提交自动换绑（onchange/blur，非 ⌘S）」——高级选项区每个控件即改即存（add-project-files design §7.1 纪律延伸）。

### 1.2 任务侧：LabTask 高级选项快照（run 时物化）

`startRun` 现状按「启用模板 × 候选数」推任务（`lab.svelte.ts:1133-1187`）。升级：任务携带模板高级选项的**物化快照**（配置 → 快照降熵链，B.1.4 先例）：

```ts
interface LabTaskDrillParams {          // drillParams.enabled=true 时存在
  specs: GemSpecSnapshot[]              // specKey → 目录解析物化；ordinal=1..n 按模板数组序
  physical?: PhysicalCanvas
  /** 素材附图清单：自定义规格的 .gemshape 贴图 assetId（去重，§2.3 软上限）。 */
  materialAssetIds: string[]
}
interface LabTaskBlueprint {            // blueprint.enabled=true 时存在
  strategy: 'serial' | 'parallel'       // 任务级策略（发起面板，§4.3）；默认 'serial'
  refs: string[]                        // 蓝图参考图 assetId 快照
}
```

- **物化失败防线（missing .gemshape）**：run 时 specKey 解析失败（资产缺失/软删/parse 失败）→ 该任务 **fail-fast**，任务级中文错误列缺失 specKey，不静默降级为圆钻描述（沿 add-gem-catalog §1.4 gate 6「missing typed 禁静默降级」精神）；模板编辑器侧对 missing 引用显示警告角标（不阻断编辑，阻断发起）。
- **持久化**：快照随 `PersistedTaskMeta` 落账本（`taskStore.ts:78-110` 现无此字段；terminal-only 纪律与保存/恢复边界见 §3.3 刷新持久化策略）——刷新后重试/补偿归档不需重解析目录。

### 1.3 档案侧：.gemgen v2 正交键（消费口径；跨 change 同步要求）

现状：`GemgenFile` 单 `image` 键 + provenance（`labFile.ts:190-225`），provenance.`mode` 为 endpoint 语义。v2 修订版口径（**add-gem-catalog design §1.3 gemgen 行由主会话同步修订**：`workflowMode` 行删除，正交键如下）：

```ts
interface GemgenFileV2 {
  image: GemgenImage                    // 主图（效果图）——键不动，消费兼容
  blueprint?: GemgenImage               // 蓝图（成功时才存在；含 effectRequestId/blueprintRequestId
                                        // 溯源 + 「人审参照、非 BOM 数据源」typed 标记——键形沿
                                        // add-gem-catalog §1.3 原设计，本 change 只消费）
  provenance: {
    requestMode: 'generate' | 'edit'    // 旧 mode 拆分迁移（只读映射）
    gemSpecs?: GemSpecSnapshot[]        // drillParams on 的物化清单（ordinal→specKey 持久化映射即此数组）
    physicalCanvas?: PhysicalCanvas     // drillParams 的画幅声明（declared 时存在）
    blueprint?: {                       // 蓝图请求快照（provenance 级；blueprint image 键是成功产物）
      strategy: 'serial' | 'parallel'
      status: 'success' | 'failed' | 'cancelled'   // 部分失败语义（§5.1）
      error?: string
    }
    // 既有键（runId/templateAssetId/templateName/promptBody/composedPrompt/caseBinding/
    // referenceAssetId/candidateIndex/model/size/advancedJsonRedacted）不动（labFile.ts:202-224）
  }
}
```

- **单一真源纪律**：`gemSpecs?`/`physicalCanvas?` 的存在 ≡ drillParams on（§1.1 validation 保证 enabled⇒specs≥1，故物化必非空）；不设冗余的 `drillParams:{enabled}` 声明键。
- v1 旧档迁移：旧 `mode` → `requestMode` 只读映射；`blueprint`/`gemSpecs`/`physicalCanvas`/`blueprint(provenance)` 缺席 = 无蓝图/无钻参数（旧档语义）。

---

## 2. 提示词拼接 service（并行轨 A：结构化数据 → 提示词片段的纯函数）

### 2.1 组装器扩展签名（冻结）

现状：`composeDrillPrompt(templateBody, roles)` 两参（`effectRefs.ts:107`），`DrillPromptImageRoles = {hasCase, caseLayout, hasReference}`（`effectRefs.ts:51-56`），附图序号单一真源 `describeDrillImageOrder` 锁死 ordinal 1|2（`effectRefs.ts:70-85`）。扩展为：

```ts
interface PromptDrillParams {           // = LabTaskDrillParams（§1.2）
  specs: GemSpecSnapshot[]
  physical?: PhysicalCanvas
  materialAssetIds: string[]
}
interface PromptBlueprint {             // 蓝图 stage 专用（主图 stage 不消费蓝图上下文，§2.4）
  hasLegend: boolean                    // = drillParams on（有编号图例）；off = 无编号纯转换
  specs?: GemSpecSnapshot[]             // 图例节数据（hasLegend 时存在）
}

/** 附图角色模型扩展：ordinal 1..n（不再锁 1|2）。 */
type DrillImageRole = 'case' | 'reference' | 'material' | 'blueprint-ref' | 'effect'
// material：钻石素材图（每资产一条声明，label「钻石素材图·<规格码>」）
// blueprint-ref：蓝图参考图（label「蓝图参考图」）——仅蓝图 stage 附图
// effect：成品效果图（label「成品效果图」）——仅策略 B 蓝图 stage 的首附图

function composeDrillPrompt(templateBody: string, roles: DrillPromptImageRoles,
                            options?: { drillParams?: PromptDrillParams }): string
function composeBlueprintPrompt(roles: BlueprintPromptRoles,
                                options?: { blueprint?: PromptBlueprint }): string   // 新增，蓝图 stage 专用
```

- **主图 stage 提示词不因蓝图开启而变化**：蓝图要求只进蓝图 stage 自己的提示词——主图请求的语义纯净性是策略 B 可靠性的前提（成品图先按基础形态生成，再被转换）。〔判断·高置信，Owner 语序「先生成成品效果图，然后再……」同向〕
- 段序冻结（主图）：`角色声明(1..n) → 任务要求 → 贴钻指导规则 → 模板特化体 → 【尺寸与钻规格】(若 on) → 输出行`——注入段插在模板体之后、输出行之前（规格约束是对任务的收尾限定，不打断角色/任务/规则的主干）。
- `describeDrillImageOrder` 扩展为 n 元（中文数字至「十」，超出落阿拉伯数字——防御性，实际单请求附图 ≤8：案例1+参考1+素材4 / 蓝图B：成品1+参考1+素材4+蓝图参考2）；**附图序号=角色声明序号**不变量沿用（`lab.svelte.ts:1048-1052` 纪律）。

### 2.2 【尺寸与钻规格】注入段（文本骨架冻结）

沿专家稿 §C.2 文本（改触发条件为 drillParams.enabled）：

```
【尺寸与钻规格】
（physical 存在时）
画幅物理尺寸 210×148mm。图宽对应 1024px：1mm ≈ 4.9px。
SS10 圆钻直径 2.8mm ≈ 画幅宽度的 1.33%——所有钻按此物理比例绘制。
（physical 缺席时）
未声明画幅物理尺寸——按钻径之比表现各规格的相对大小。
（恒有）
只允许使用以下钻（编号将用于蓝图图例）：
  1 = R10 圆形 SS10（直径 2.8mm）
  2 = C-star01 自定义钻形（最大径 5.0mm，素材见【图N：钻石素材图·C-star01】）
  ...
```

- 比例锚（钻径/画幅宽 百分比 + 1mm≈px）是给模型的最强尺寸信号——mm 对生成模型是无量纲记号〔判断·中高置信，沿专家稿论证〕；px 值消费 size 结构化 `{widthPx,heightPx}`（add-gem-catalog P0-7 的 size 半边，本 change 只消费类型）。
- 无 blueprint 时编号行文案退化为「编号用于区分钻规格」。

### 2.3 素材图注入策略（冻结裁决）

Owner：「增加了 钻石素材图和尺寸信息，这些信息也都是要拼接到提示词里面去的」；简报授权「素材图作为附加参考图或描述注入——具体拼接策略设计并冻结」。**冻结**：

| 规格来源 | 注入方式 | 依据 |
|---|---|---|
| 内置形（round/square/drop/heart/marquise） | **纯描述注入**（形状名+尺寸入 §2.2 清单行；不附图） | 形状是模型已知概念，文字即强信号；附图徒增请求重量 |
| 自定义（.gemshape） | **附加参考图**：贴图作为附图追加在 案例/参考 之后（每资产一条角色声明 `【图N：钻石素材图·<规格码>】`），清单行交叉引用图号 | 任意用户贴图无法用文字可靠描述——图像是唯一忠实通道〔判断·高置信〕 |

- **软上限**：素材附图 ≤4 张（超出取 ordinal 序前 4，编辑器与发起前警告「素材图过多，仅前 4 张随请求附送」不阻断）——图多请求重、模型注意力稀释〔判断·中置信，试产回填校准，§8-3〕。
- 素材附图与 案例/参考 的顺序恒为 `[案例(若有), 参考(若有), ...素材]`——主语义对（案例→参考）不被打断（`effectRefs.ts` 角色声明先例延伸）。

### 2.4 蓝图提示词（两策略各自骨架）

- **策略 B（串行，默认）**：`/images/edits`，附图 = `[成品效果图, 参考原图(若有), ...钻石素材图, ...蓝图参考图]`（Owner 语序原文照录）。prompt = 转换任务（沿专家稿 §C.3 蓝图 prompt 骨架）：

```
【任务：施工蓝图转换】输入【图一：成品效果图】为本设计的局部贴钻成品。
将这张效果图转换为白底平面施工蓝图：保留图中每个钻位的排布位置、真实形状轮廓
（圆形/方形/水滴/心形/马眼/自定义——自定义轮廓见【图N：钻石素材图】）与物理比例，
去除背景与光照，每颗钻平涂其颜色；（有钻清单时）每个钻位中心标注其编号数字
（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格：
  1 = R10 圆形 SS10（直径 2.8mm）…
（无钻清单时省略编号与图例节，任务退化为无编号纯转换）
不新增、不移动、不删除任何钻位。
```

- **策略 A（并行同生，默认关闭）**：与主图同时派发；**无成品图输入**（尚不存在），附图 = `[参考原图(若有), ...钻石素材图, ...蓝图参考图]`，endpoint 按有无附图走 edits/generate。prompt 骨架同上但任务行改写为「为本次同时生成的设计生成配套施工蓝图……」——无输入图约束，排布一致性不可证（随机性来源，§4.1）。

---

## 3. 生图生命周期（底层能力，先行切片）

### 3.1 stage 树模型

现状：单请求无生命周期（`lab.svelte.ts:989-1124`：一次组包→一次请求→单 blob 成功；`pump` 任务粒度 :958-968；controllers 按 taskId 键控 :164）。升级：

```ts
type StageKind = 'main' | 'blueprint'
type StageStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'skipped'

interface LabStage {
  id: string                     // stage-${taskId}-main | -blueprint
  kind: StageKind
  status: StageStatus
  /** 依赖的前序 stage id（blueprint 串行策略 = [main]；并行策略/无依赖 = []）。 */
  dependsOn: string[]
  /** 请求追踪 id：本地 crypto.randomUUID 于每次派发生成（API 无回传请求 id——
   *  归档落 effectRequestId/blueprintRequestId，§1.3）。重试 = 新 requestId。 */
  requestId?: string
  assetId?: AssetNodeId          // 归档产物（main→gemgen 节点；blueprint→同节点 blueprint 键）
  imageUrl?: string              // 会话展示 URL（objectURL 瞬态，不持久化）
  imageStored: boolean
  error?: string
  debug?: ImageTaskDebug
  retryCount: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

interface LabTask {
  // 既有字段不动（lab.svelte.ts:100-140）；status 变为派生（§3.3）：
  stages: LabStage[]             // 恒恰一个 kind='main'；blueprint stage 仅在启用时存在
  drillParams?: LabTaskDrillParams   // §1.2 快照
  blueprint?: LabTaskBlueprint
  // 顶层 assetId/imageUrl/imageStored/error 退役为派生 getter（消费面兼容投影，§3.3）
}
```

- `skipped` 语义：依赖失败后的不下发（main error → blueprint skipped；策略 A 下 main 取消 → blueprint 照跑或 skipped 由用户取消粒度决定，§3.4）。

### 3.2 stage 状态机（纯函数，并行轨 B）

```ts
/** 事件驱动的纯 reduce：不 IO、不依赖 Svelte——算法研发与测试轨（Owner「算法研发和测试」）。 */
type StageEvent =
  | { type: 'dispatch'; stageId: string; requestId: string }
  | { type: 'succeed'; stageId: string }
  | { type: 'fail'; stageId: string; error: string }
  | { type: 'cancel'; stageId: string }
  | { type: 'retry'; stageId: string }          // error|cancelled → pending，retryCount+1，
                                                //  依赖失效级联（§3.4）
  | { type: 'invalidate'; stageId: string }     // 依赖产物已换代 → 本 stage 及其下游重置

function reduceStages(stages: LabStage[], event: StageEvent): LabStage[]
function deriveTaskStatus(stages: LabStage[]): TaskStatus        // §3.3 派生表
function schedulableStages(stages: LabStage[], runningCount: number, max: number): LabStage[]
                                                 // 依赖满足（dependsOn 全 success）且 pending 的前 max-runningCount 个
```

### 3.3 父任务状态派生表（不落独立真源——gemspec R1 议题 8 裁决继承）

| stages 状态 | 父任务 status | 会话徽标 | 归档（§5.1——自动触发，stage 终态即档） |
|---|---|---|---|
| main pending/running（blueprint 任意态） | pending/running | — | 不归档（活动 stage 不落账本） |
| main success，无 blueprint stage | success | — | main success 即归档**单图档**（无 blueprint 键） |
| main success + blueprint pending/running | running（蓝图进行中） | 「蓝图进行中」 | main success 即归档**单图档**；blueprint 终态后归档**双图完整档**（两档并存） |
| main success + blueprint success | success | — | 归档**双图完整档**（含 blueprint 键；与先行单图档并存） |
| main success + blueprint error/cancelled | **success** | 「蓝图失败/已取消」徽标；blueprint 可单独重试 | 归档**双图档**（provenance.blueprint.status 落 failed/cancelled，无蓝图图；与先行单图档并存） |
| main success + blueprint skipped | success | 「蓝图未随行」 | 同上（skipped 内部独立终态，档案 provenance 投影压缩为 cancelled + 错误码——有意映射，见下刷新持久化策略 5） |
| main error（blueprint → skipped） | error | — | 不归档；重试 main 级联重置 blueprint |
| main cancelled（blueprint → cancelled/skipped） | cancelled | — | 不归档 |

- 顶层兼容投影：`task.assetId` ≡ main.assetId、`task.imageUrl` ≡ main.imageUrl、`task.error` ≡ main.error（blueprint 的 error 走徽标与 stage 详情）——既有画廊/测试消费面零破坏（`gallery.svelte.ts` 并集投影沿用顶层字段）。

**刷新持久化策略（R3 P0 修复冻结，2026-09-20——spec/design/tasks 三处一致）**：

1. **账本 terminal-only 不变**：`PersistedTaskMeta` 只落终态 stage（pending/running 不落账本——沿 `taskStore.ts:28,69-105,159-160,223-256` 现状纪律扩展）；刷新 = 活动 stage **中断丢弃**（hydrate 不恢复活动 controller——controller/AbortController 为会话态，不可序列化）；重试 = 新派发**新 requestId**（`crypto.randomUUID`，不复用旧 id——裁断 3 既有纪律）。
2. **字节保护与不可变相容（双档并存）**：main stage success **即归档单图 gemgen**（立即定稿——blob URL 会话即逝，先档防刷新丢字节）；blueprint stage 终态后归档**双图完整档**（image+blueprint 或 provenance 终态）；**两档并存**（画廊 createdAt 降序——B7「重试产新档旧档并存」先例延伸）。归档触发 = **自动**（stage 终态触发，不等用户动作——R3 非阻塞 1：消除「归档等待用户放弃重试」的歧义表述）。
3. **恢复语义**：刷新后账本恢复终态任务；main success 而蓝图无终态（中断）→ 任务显示「蓝图已中断，可重试」（单图档已在库，重试从 main.assetId 归档字节取输入，零重新生成）。
4. **保存/恢复边界冻结**：`PersistedTaskMeta` 恢复 = 终态 stage 快照（含 requestId/assetId）+ drillParams/blueprint 参数快照 + materialAssetIds；**活动 stage 零持久化**（imageUrl 等 objectURL 瞬态字段不落账本）。
5. **skipped 投影映射（有意）**：skipped 在 stage 状态机内是独立终态；归档 provenance 投影压缩为 cancelled + 错误码（`SKIPPED_UPSTREAM` 类标记）——内部状态保留、档案投影压缩，是设计决定而非信息丢失。
6. **幂等与配额**：`reconcileUnarchivedResults` 幂等（达成归档条件而未入库的任务补建，**不重复归档**——双档并存策略下按「main 单图档/blueprint 双图档」分别判重）；配额降级（剥 debug 等大字段）不得丢终态 stage 快照。
7. **legacy 合成迁移**：无 stages 的旧账本 → 读时合成单 main stage（status=旧 status、assetId=旧 assetId），只读兼容不回写。

### 3.4 调度与操作粒度

- **pump stage 化**：并发预算按 **stage（=请求数）** 计——`MAX_CONCURRENCY = 4`（`lab.svelte.ts:81`）语义从「并行任务数」细化为「并行请求数」，数值不变（现状每任务恰一请求，行为零变化）。
- **取消**：`cancelTask(taskId)` = abort 该任务全部 running stage 的 controller + pending stage → cancelled；`cancelStage(stageId)` = 蓝图单独取消（main 不动）。controllers map 键从 taskId → stageId（`lab.svelte.ts:164` 现状）。
- **重试**：`retryStage(stageId)`（error/cancelled → pending；串行 blueprint 的依赖产物从 main 会话 blob 或 main.assetId 归档字节取回——零重新生成；刷新中断后的重试恒走 assetId 路径，§3.3 刷新持久化策略 3）；`retryTask(taskId)` = main 重试 + **级联失效**（blueprint stage 一并重置 pending：成品图换代后旧蓝图必然失配——`invalidate` 事件）；重试派发 = 新 requestId（§3.3 策略 1，不复用旧 id）。
- **归档链**：`enqueueArchive` 串行链/三步补偿/`whenIdle` 排干（`lab.svelte.ts:838-860,912-919`）机制全保留，归档单元从「任务成功」改为「§3.3 派生表的归档时点——main/blueprint 各自终态自动触发（单图先行档 + 双图完整档，§5.1）」。

---

## 4. 蓝图两策略

### 4.1 策略 A：并行同生（默认关闭）

一次 run 内 main 与 blueprint 同时派发（`dependsOn: []`）；blueprint 无成品图输入（§2.4）。**随机性声明**：两请求无共享 latent/坐标，蓝图与成品图的排布一致性不可证（gemspec R1 议题 1 对「两次独立 generate」的推翻论证在本策略下同样成立）——故默认关闭、UI 明示「同生模式随机性大」。价值：省一跳延迟，供 Owner 实验对比。

### 4.2 策略 B：串行依赖（默认）

`dependsOn: ['main']`；main success 后派发 blueprint：`/images/edits`，附图 = `[成品图, 原图(若有), ...钻石素材图, ...蓝图参考图]`，prompt = §2.4 转换骨架。排布一致性来源 = 图像编辑的输入约束（而非重采样运气）——Owner 原话「更加可靠的做法」即此。

### 4.3 策略选择层级（模板只存开关不锁策略）

- **模板**：只存 `blueprint.enabled`（+refs）——「制作模板的时候，完全可以按需启用」〔Owner〕。
- **发起面板（run 级表单）**：当次 run 存在 blueprint.enabled 模板时，显示策略选择（默认 串行 B；单选：串行（推荐）/并行实验）；快照进每个启用蓝图的任务（`LabTaskBlueprint.strategy`）与 gemgen provenance。表单值随 lab-session form 持久化（`saveLabForm` 先例，`lab.svelte.ts:195-203`）。

### 4.4 beta 标记与人审参照定位

- **beta 双标记**：UI——TemplateEditor 蓝图开关旁 `Beta` 徽标 + tooltip「蓝图效果可能不稳定，未来可能被其它工作流替代」；发起面板策略选择区同款徽标；文档——本 design §0.1/§4 与 spec delta 显式声明。
- **人审参照、非 BOM 数据源**（已生效工作默认，专家稿 §C.3 继承）：蓝图卡固定角标「人审参照 · 非 BOM 数据源」；gemgen blueprint 键携带 typed 标记（§1.3）；BOM 一律由排钻设计/专家工作台引擎重算；机器级同排布另立 change（§0.4）。

---

## 5. 归档与画廊最小面

### 5.1 归档时点与部分失败语义

- **归档时点（R3 P0 修复冻结——自动触发，双档并存）**：main stage success **即归档单图 gemgen**（立即定稿，防刷新丢字节——blob URL 会话即逝）；blueprint stage 终态后归档**双图完整档**（成功则 `blueprint` 键含图；失败/取消/skipped 则 provenance.blueprint.status 落对应态、无图）。**两档并存**：先行单图档与后继双图档同时在库（画廊 createdAt 降序——B7「重试产新档旧档并存」先例延伸）；归档触发 = stage 终态**自动**触发，不等用户动作（统一 spec「账本恢复」与本节的触发叙述——归档不存在等待用户动作的语义）。不可变性不破（生成即定稿；add-project-files §7.2 纪律）。
- **蓝图重试** = 产**新档**（重试产新档纪律沿用）：从旧档 main 图字节（assetId 解析，零重编码）+ 新蓝图重建完整 gemgen；旧档（先行单图档或失败双图档）保留。会话内失败重试与刷新中断后的重试同路径——main 字节已在先行单图档中，输入恒可取回（§3.3 策略 3）。
- 缩略：thumb 恒取 main 图（收起卡缩略语义不变）；`blueprint` 键不建独立 thumb（画廊最小面只做展开位蓝图缩略，§5.3）。
- 补偿链路（`reconcileUnarchivedResults`，`lab.svelte.ts:866-886`）升级：达成归档条件而未入库的任务幂等补建（蓝图字节从 stage imageUrl 回取）；**幂等判重按两档分别进行**（main 单图档/blueprint 双图档各自判已档，不重复归档——§3.3 刷新持久化策略 6）。

### 5.2 gemgen v2 接线

`archiveGeneratedResult`（`lab.svelte.ts:771-836`）升级：serializeGemgen 输入 + blueprint 键（成功时）+ provenance（requestMode/gemSpecs/physicalCanvas/blueprint 快照）；composedPrompt 审计快照扩为**双快照**（main 与 blueprint 各自请求全文，`composedPrompt` 仍为主图全文、新增 `blueprint.composedPrompt` 落 blueprint 键内或 provenance——**冻结：落 provenance.blueprintPrompt，blueprint 键只承图与溯源 id**，图与文分离沿 image 键先例）。四态显式覆盖（R1 非阻塞建议继承）：蓝图失败 / 重试中 / 旧档无 blueprint / missing custom asset。

### 5.3 任务卡蓝图最小子态（非画廊重构）

画廊重构已落（add-project-files 4.5：chips 过滤/并集/收起展开两态）。本 change 仅扩**展开位**：主图横幅旁蓝图缩略（并排/切换 tab）+「人审参照」角标 + 蓝图失败徽标 + 蓝图单独重试/取消动作行 + **「蓝图已中断，可重试」态**（刷新后 main success 而蓝图无终态的恢复呈现——§3.3 刷新持久化策略 3）；收起卡不动。对比 Dialog（叠加/并排）扩展「效果 vs 蓝图」来源——职责自然延伸，不重构。

---

## 6. 模板编辑器高级选项区（并行轨 C）

### 6.1 组件契约

```
┌─ TemplateEditor · 高级选项 ──────────────────────────────┐
│ [ ] 水钻参数配置                                         │
│   └─（开启后展开）                                       │
│      可用钻清单  [＋ 从钻形目录选择…]（规格选择器）        │
│        1  R10  圆形 SS10  2.8mm            [×]           │
│        2  C-star01  自定义  5.0mm  ⚠素材缺失  [×]        │
│        （>8 条：警告「编号可辨性可能下降」，不阻断）        │
│      画幅物理尺寸  [ ] 声明  [210]×[148] mm（可选）       │
│ [ ] 蓝图效果  Beta                                        │
│   └─（开启后展开）                                       │
│      蓝图参考图  [＋ 从素材库选]（≤2）                    │
│      「蓝图可能不稳定，可能被其它工作流替代」              │
└──────────────────────────────────────────────────────────┘
```

- 宿主 = TemplateEditor 抽出组件内（双宿主同步受益：实验室手风琴与 RightSheet 同 record 互见，add-project-files 4.3b 先例）；提交模型 = 字段提交自动换绑（§1.1）。
- **规格选择器依赖 W0 类型**（GemSpec 目录枚举 + sys-shapes 资产解析）：并行轨 C 交付开关+表单骨架（桩类型/桩目录），真选择器在依赖轨 4.2 接线。

### 6.2 发起面板最小面

run 级：策略单选（§4.3，仅当启用蓝图的模板在列）+ 汇总 chips（只读：「2 个模板启用水钻参数 · 1 个启用蓝图」）；钻清单**不可**在发起面板编辑（canonical 唯一，§0.2-3）。

---

## 7. 测试策略

- **service（轨 A）**：注入矩阵（drillParams×physical×blueprint×roles 四象限 × 附图组合）——段落存在性/序号连续性/比例锚数值（1mm≈px、钻径百分比）/无 blueprint 时编号文案退化/素材附图清单派生（去重、≤4 截断+警告）/两策略 prompt 骨架差异/快照确定性（同输入同输出字节等价）。
- **调度算法（轨 B）**：reduce 矩阵（dispatch/succeed/fail/cancel/retry/invalidate 全事件 × 串行/并行树）；派生表逐行；级联失效（main 重试 → blueprint 重置；main error → blueprint skipped）；schedulableStages 依赖满足判定与并发预算；legacy 账本合成迁移 round-trip；**刷新持久化 fixture（R3 P0 验收）**——main pending/running 刷新（活动 stage 丢弃、不落账本）、main success+blueprint running 刷新（单图档已在库、恢复态「蓝图已中断，可重试」）、失败后重试（新 requestId 不复用断言）、legacy 无 stages 合成、终态快照保存/恢复边界（requestId/assetId/drillParams/blueprint/materialAssetIds）、配额降级不丢终态快照。
- **接线（轨 4）**：gemtpl v2 正交键 serialize/parse round-trip 字节等价 + v1 迁移（两键缺席=关）+ 脏输入 typed error（重复 specKey/空清单 enabled/refs>2）；startRun 快照物化（specKey→GemSpecSnapshot、missing fail-fast）；stage 化 runTask 端到端（jsdom 桩 client）：策略 B 串行依赖附图序、策略 A 并发、蓝图单独重试/取消、归档**双档并存**（main success 单图先行档 + blueprint 终态双图档，createdAt 降序；四态显式覆盖——成功双图/蓝图失败/重试中/旧档无 blueprint）+ missing custom asset 归档阻断；**自动归档触发（stage 终态即档，无用户动作依赖）+ reconcileUnarchivedResults 幂等（不重复归档）+ 重试 requestId 不复用 + 刷新中断恢复端到端**；任务卡蓝图子态渲染断言（含「蓝图已中断，可重试」态）。
- **基线**：全量 `pnpm test`/`pnpm check`/`pnpm build` 绿门（收尾前置）；既有护栏（openIntentFlow/galleryUnion/gemgenArchive 兄弟套件）零回归。

---

## 8. 议题与未决（不阻塞 0.x/并行轨）

| # | 议题 | 状态 |
|---|---|---|
| 1 | 蓝图机器级同排布是否另立 change | 待 Owner 拍板（默认不进本 change——人审参照定位已生效，§4.4） |
| 2 | add-gem-catalog §1.3 workflowMode→正交键修订的落档时点 | **已闭合（2026-09-20，gem-catalog 8e172d2）**：§1.3 已按正交键修订（.gemtpl/.gemgen 无 workflowMode 键），0.4-④ 核对门已验证通过；4.x 按 DAG 开工 |
| 3 | 素材附图软上限 4 的实证校准 | Owner 试产（5.x）回填；上限值可调，机制（截断+警告）不变 |
| 4 | 归档后蓝图重试产新档导致同成品图双档并存 | 画廊 createdAt 降序沿用（add-project-files B7 先例）；观察期后复议是否给旧失败档打「已替代」标记 |
| 5 | 蓝图 prompt 实证错误率（编号错标/糊字） | Owner 试产 3-5 批回填（沿专家稿 §C.3 论证 5：图例必须+逐钻标号尽力；不可接受则降级「图例必须 + 大钻位标号」幅度调整） |
