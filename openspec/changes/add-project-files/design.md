# Design: 项目文件格式 + 两页重构

> 规范性来源：`.agents/documents/2026-09-19-project-file-formats/project-format-and-redesign.md`（PM 稿，2026-09-19，行号引用当日源码树）。本文件冻结实现级契约与裁决；与 PM 稿冲突时以本文 + Codex 评审结论为准。§E 七议题在 Codex 裁决前**不作为实现依据**（议题表见文末）。

## 1. 格式契约（projectFile.ts 唯一出口）

### 1.1 .gemproj（参数工程）

- `kind:'gemproj'` + `formatVersion:1` + `appVersion` + `engineVersion` + 时间戳 + `name`
- `source: GemprojSource` 判别联合：库内 `{kind:'asset', assetId, name, width, height, downscale}` / 导出 `{kind:'embedded', name, mime, dataUrl, ...}`——**导出文件到磁盘时才烘焙内嵌**（原始图字节，非降采样像素；dataUrl 只存在文件字节中不驻留内存 store）
- 参数全集：`segment{k,seed}` / `overrides{disabled,density,type,color}`（键=引擎块 id；显式覆写全量，含恰为 1.0 的密度）/ `physics{ss,gapMm,globalDensity,relax}` / `palette` 全量 / `activeStrategy` / `reference?{assetId,name}`
- **永不入文件**：五策略 results、previewMode/overlayOpacity、selectedBlockId
- 推导常量（SEGMENT_GEM_DIAMETER_PX、minAreaFor 算式）不冻结——归 engineVersion 语义
- 重放漂移：`engineVersion` 不等 → 黄色横幅 + 覆写存活清单（复用 pruneStaleOverrides）；**不做冻结旧结果选项**（需要冻结 = 导出 .gemdoc）
- 引擎侧新增 `ENGINE_VERSION` 常量并立 bump 纪律：segment/布局/颜色映射的**语义**变更必 bump（横幅诚实性前提）

### 1.2 .gemdoc（烘焙文档）

- `kind:'gemdoc'` + 版本三元组 + `name` + `width/height/grid/palette`
- `gems: EditGem[]` 全量（origin/moved 语义原样；'m-' 手工钻前缀保留）；加载时 manualCounter 从 gems 派生（max(m-编号)+1，nextManualId 跳撞逻辑兜底）
- `blocks: SerializedBlock[]`（mask.bits → base64）；只读参考，编辑器不改
- `layers` 四层显隐/透明度 = 文档态（非瞬态）；`painting` 内嵌 PNG（数字油画 k 色平涂，PNG 压缩率高）；`reference?` assetId 弱引用（missing 容忍，四态解析器既有）
- `provenance{origin: 'studio-bake'|'quick-layout'|'blank', sourceSummary, sourceAssetId?, gemprojAssetId?}` 仅展示
- **撤销栈永不序列化**（两格式一致）；连锁修正：新增 `dirty`（自上次保存以来有修改）替换 `hasEdits()=undoCount>0` 的守卫/徽标/覆盖确认消费点；文案「有未导出修改」→「未保存」（导出不清除 dirty）

### 1.3 版本演进

- `parseGemproj/parseGemdoc` 对 formatVersion 向前校验：大于当前支持 → 显式错误「文件来自更新版本的应用」
- 迁移器：`(from,to)=>migrate` 纯函数链逐版本串行；每次 bump 附**往返测试（save→load→save 字节等价）**

## 2. 素材库集成

- `AssetProject extends AssetNodeBase {type:'project', projectKind, blobKey, mime, thumbKey?(gemgen), summary{...}, summaryUpdatedAt, ...}`；AssetNode union 三分化；**不改 DB schema**（assetNodes 对节点形状无约束）
- **vendor MIME 四值（唯一真源，`PROJECT_MIME` 常量入 projectFile/labFile 契约层）**：`application/vnd.rhinestone-studio.gemproj+json` / `.gemdoc+json` / `.gemtpl+json` / `.gemgen+json`；`projectKind × mime × 文件内 kind` 三者导入时交叉校验，扩展名不覆盖文件内 kind/MIME
- **gemgen 缩略物理契约（P0，[R2-B8] A 案）**：`thumbKey` 指向 thumb 物理记录（256px PNG，存 images store 独立记录，元组 {key, mime:'image/png', width, height, bytes}）；所有权 = 跟随 gemgen 节点（归档/导入时创建，节点软删随节点、硬删与换绑时按引用计数 GC——同 blob GC 机制）；缺失 fallback = 懒解析内嵌图 + 内存 LRU（不重建 thumb 记录）；gemproj/gemdoc/gemtpl 无缩略
- `ingestProjectAsset(blob, meta)` 与 ingestAsset 平行；MIME 白名单 = 上述四值
- **保存写路径**：首次 ingestProjectAsset → sys-projects；再次 = 同 node blobKey 换绑新内容 blob（单事务）+ summary 重写 + 旧 blob 引用计数清理（emptyTrash 同机制）；另存为 = 同上但不记 projectId（fork）
- 契约豁免（PM 稿 A.4.1）：仅 AssetProject 的 blobKey 可变；图片节点不可变契约原样
- 引用保护第 ④ 类：打开中的 gemproj pin source.assetId + reference.assetId（硬）；gemdoc 仅 pin reference（provenance 弱引用不 pin）——pin 机制见 §9.1 lease
- 呈现：网格卡片 = 类型图标 + 名 + summary 直出 + 类型徽标（gemgen 含 thumb 缩略）；双击 = 对应页打开（经守卫，统一手势见 §7.4）；项目节点不走图片预览 Dialog；「全部素材」type-aware 化 + 底栏「共 N 项 · 图片 X · 项目 Y」

## 3. 排钻设计页生命周期

- 状态机：无项目（空态+最近≤4）→ 新建未命名（默认参数起步，分块自动跑）→ 打开中（skeleton→自动重放）→ 干净 ⇄ dirty（任何参数/覆写/色板/策略/分块参数变更）
- 首次保存弹命名（默认=来源图名去扩展名）；⌘S；项目菜单：另存为…/导出项目文件(.gemproj)/导出为精修项目(.gemdoc)/关闭项目
- 守卫三分法：**切 Tab 不弹守卫**（store 模块单例跨视图存活，内存原地保留 + ●未保存徽标常驻提醒）；刷新/关窗 beforeunload（dirty 时）；页内破坏性动作（打开其它项目/换来源图/新建）三按钮「保存并继续 / 不保存 / 取消」
- 来源缺失态：画布错误卡「来源图已缺失——参数完好，重新绑定即可重放」+ [重新绑定][导出参数文件]；检查器/胶片带禁用占位
- 五区改写面：上下文条=重写（项目身份+保存+菜单+来源区扩容；预览/取景控制不动）；状态条=微改（文案）；画布/检查器/胶片带结构不变；移动端上下文条折两行、最近项目横滑 chips

## 4. 手动编辑页解绑

- 入口四路 converge 同一文档模型：①送精修（不变）②空态选图 → 快速排稿（进度+取消）→ 未保存新文档 ③打开 .gemdoc（库/最近/磁盘导入）④排钻页导出的 .gemdoc（同③）
- **快速排稿**：`lib/edit/quickLayout.ts` 默认参数一次 runCompute（segment + hybrid，k=8/seed=1/SS10/gap0.4/密度100%，与 studio 初始态同参）→ ManualEditHandoff 同构载荷 → loadFromHandoff；**不经 studio store**；provenance=quick-layout；参数固定不可调（调参去排钻页——编辑器永不长参数面板，概念混入禁令）
- 空白画布 P1（合成纯色 paintingSnapshot 满足契约，loadFromEngineImage 先例）
- 空态重设计：主 CTA 从素材库选图 / 次打开精修项目 / 上传图片；最近精修项目 ≤4；引导行「想先调密度与策略？去排钻设计送精修」
- 文档态摘要条左端加项目身份 [▦]名● + 保存/菜单（另存为/导出 .gemdoc/关闭文档）

## 5. 改名与措辞联动（一次改齐）

桌面 Tab 排钻设计 / 移动 Tab 排钻 / 送转化→送排钻（TaskCard+预览 Dialog）/ 编辑空态「去排钻设计送精修」/ sys-projects 目录名「项目」/ 送精修不变 / app 副标题不变。TERMS.md v1 术语注册表**已落盘**（16 词条），实现措辞以其为准；收尾 grep 范围含源码注释、测试断言、toast、handoff 文案，不止组件文本。

## 6. 测试策略

- projectFile：两格式 round-trip 字节等价；formatVersion 向前拒读；迁移链注入；脏输入容错
- assetStore：换绑保存事务（旧 blob 计数清理、失败注入）；保护④（gemproj 来源 pin / gemdoc 仅 reference）；sys-projects seed 幂等；库内可见性回归（项目节点不隐形）
- 生命周期：dirty 触发全集 / 保存写路径 / 另存为 fork / 来源缺失重绑 / engineVersion 横幅 + 覆写清点 / 守卫三分法（切 Tab 不弹、beforeunload、三按钮）
- 编辑页：快速排稿默认参快照（同参同出）/ manualCounter 派生 / dirty 口径 / 四入口 converge
- 既有护栏：三模块管线回归零破坏；素材库测试全绿；1 万钻 60fps 不回归

## 7. 实验室格式对：.gemtpl / .gemgen（[Owner 2026-09-19] 七条裁决 + 追加裁决）

> 细节规范性设计：`.agents/documents/2026-09-19-lab-formats/lab-formats-and-gallery.md`（PM 补充稿）。本节为终局契约摘要；议题（本文 §8 1-7 + 补充稿 §E 1-12）Codex 裁决前不作为实现依据。

### 7.1 .gemtpl 模板（配置资产，可编辑）

- **模板 = 库资产（sys-templates 直系子节点）**：实验室左侧列表 = sys-templates 中 gemtpl 节点（未软删）；移出目录 = 从列表收起（库仍真源）；内置 preset 在 **lab hydrate**（非 assetStore 迁移——seed 需案例物化管线，域管线归域 store）幂等 seed，节点 id `ast-tpl-${presetId}`，**幂等口径 = 节点存在即跳过（含软删，删除不复活）**；seed 与代码演进 = **create-only**（用户编辑不被官方修订覆盖；新 preset 增量补 seed；DEFAULT_TEMPLATES_VERSION「bump 即重置」语义退役）
- **Schema（补充稿 A.1.2）**：`{kind:'gemtpl', formatVersion, appVersion, createdAt, savedAt, name, promptBody(≤8000), caseBinding:{assetId,caseLayout}|null, candidates(1-8), provenance{source: 'builtin-seed'|'user-created'|'forked', presetId?, sourceNote?}}`；**总装骨架（composeDrillPrompt 角色声明/DRILL_RULES/任务行/输出行）永不入文件**——序列化时刻不可计算（依赖运行时附图组合）+ 骨架演进须即时惠及全模板 + 审计链由 .gemgen composedPrompt 快照闭合；`enabled` 不入文件（使用意图 → 会话 key `lab-session`）
- **variants {v:2} 信封退役**：一次性迁移（用户编辑覆写 seed 节点、自建变体入库、enabled 落会话 key、全部成功删 VARIANTS_KEY、失败保留下轮幂等重试）——根治「版本门 bump 即清零用户模板」数据损失路径
- **保存 = 字段提交自动换绑（onchange/blur，非 ⌘S）**：行为连续性（现状即改即存）+ 轻量配置非工程文档，不引入 dirty/守卫机器；失败 toast 三段式 + 字段回显旧值
- **TemplateEditor.svelte 双宿主强复用**（[Owner 追加裁决] 结构性要求）：抽出可嵌入组件（名称/候选数/提示词体/案例绑定四件套），宿主 = 实验室手风琴 Content 与素材库 RightSheet；模板响应式 record 上移共享 store（`lib/stores/templates.svelte.ts`），双宿主同开同一 $state 实时互见，**宿主不持有编辑态副本**
- **EffectRefControl 终态**：绑定写回目标 variant.effectRef → gemtpl.caseBinding；新增第四入口 [从素材库选]（AssetPickerHost 选图器，caseLayout='single'）
- **复用参数（applyTaskParams）非破坏化**：不再隐式写回模板（库资产下是数据损失路径）；只回填表单层 + [复制提示词] clipboard

### 7.2 .gemgen 生成结果（不可变档案）

- **Schema（补充稿 A.2.2）**：`{kind:'gemgen', formatVersion, appVersion, createdAt(=任务发起), savedAt, name, image:{mime,dataUrl,width,height}(原始字节内嵌), provenance{runId, templateAssetId?, templateName, promptBody, composedPrompt(全文快照=审计真源), caseBinding?, referenceAssetId?, candidateIndex, mode, model, size, advancedJson?(打码,沿 N3)}}`；**不可变**（生成即定稿，重试产新档；豁免只给可编辑文档）
- **内嵌裁决**：dataUrl ≈ 原图 ×1.33 通胀换自包含可导出；双节点方案（档案+裸图）= 一个概念两个家，否决；「送排钻」消费经 `getGemgenImageBlob(assetId)` 单点 helper（labFile.ts 出口），studio handoff 契约零变形
- **溯源收编**：现写图片 meta 的 runId/variantName/candidateIndex/prompt/referenceAssetId 全部上移进 provenance；节点只留 summary 展示缓存（templateName/candidateIndex/size/mode）；`task.assetId` 语义不变（指向节点从 AssetImage 变 AssetProject(gemgen)），任务账本零破坏 + 新增 templateAssetId 快照（画廊过滤键）
- **gemgen 缩略 P0**（偏离姊妹稿项目缩略 P1）：归档/导入时渲染 256px thumb——视觉资产目录无缩略不可用；gemproj/gemdoc/gemtpl 维持 P1/无缩略
- 旧归档裸图片**不回填**（旧 meta 无 variantId/presetId，字符串关联赛道 = 伪造溯源）；旧图不进画廊并集

### 7.3 任务画廊重构

- **过滤 = 画廊头部单选 chips**（全部 + 每模板一 chip 带计数 + 尾部「已删模板」聚合 chip 仅当孤儿存在）；否决下拉（藏过滤态）与左面板选中即过滤（编辑焦点与浏览过滤两个意图耦死）；chips（浏览意图）与左面板（编辑焦点）是两个概念，双击入口一次性同时设定、后续独立变化；过滤生效时组结构仍按批次（runId）
- **数据口径 = 会话任务 ∪ 库内 gemgen 并集**：去重键 `task.assetId === gemgen.id`；localStorage 50 条裁剪史洞由库补全；只读卡（库来源）与活卡（会话任务）视觉区分（角标「库」）；「清空历史」升级确认 Dialog（可选同时软删库内 gemgen，二次确认）
- **卡片两态**：收起（默认——缩略 56-64px + 模板名 + 候选号 + 状态 + chevron 单行）/ 展开（大图横幅位 + 动作行 + error/debug 折叠）；展开集合 = 会话内存（刷新复位整洁默认）；现「点击放大」Dialog 保留且职责收窄为**对比器**（叠加/并排），参考图来源扩为 provenance.referenceAssetId 解析
- **双击 gemgen 定位-展开动线（七步，补充稿 B.2.4）**：解析先于切视图（失败不离开素材库）→ 模板存在则左面板选中 + chips 过滤（缺失降级「全部」+ toast）→ tick → scrollIntoView → 展开 + 2s 高亮 → 清意图；意图通道 `openIntent.svelte.ts`（沿 handoff 模式，一次性消费；与 gemproj/gemdoc 路由意图归并为单通道四 kind）；双击 gemtpl = 同链去定位段；移动端双击换单击

### 7.4 素材库联动

- AssetProject.projectKind 四分化；sys-templates「模板」插在「生成结果」之前（产线邻接：全部素材/模板/生成结果/上传/导出/案例/回收站）；归档链（enqueueArchive 串行/三步补偿/空批次清理）机制全保留仅换产物形态
- **gemtpl 卡片两动作（[Owner 追加裁决]）**：**去使用** = openIntent tpl 动线本体（canonical handler；入口 = 桌面双击/悬停浮层[去使用]/移动端单击/选中态工具行[打开]）；**去编辑** = **RightSheet**（shadcn Sheet side=right，`w-full sm:max-w-[520px]`，移动端全宽+拖拽把手+safe-area+textarea ≥16px 防 iOS 缩放）内嵌 TemplateEditor，自动保存同模型；关闭守卫（flush 失败三选 mini Dialog：重试保存/放弃修改/继续编辑）；**任何新增入口必须绑定两个 canonical handler 之一**；gemgen 卡本波不加浮层（P2 对称补齐）
- **打开手势统一（含对姊妹稿的对齐修正申请）**：项目四格式单击选中/双击打开（移动端单击）；申请图片节点同步修订为同一模型（现状「图片双击=行内重命名」让位于「双击=打开」通识，重命名移入选中态工具行）——Codex 合并裁决时同步修订姊妹稿 A.4.2/硬规则 5 措辞，避免两套手势落地
- 「全部素材」type-aware：recent 集合**只收图片**（gemtpl/gemgen 不进最近）；底栏「共 N 项 · 图片 X · 项目 Y」（项目聚合四 kind 不拆分）

## 8. 评审议题（PM 立场为工作裁决，Codex 裁决前不实现对应切片）

| # | 议题 | PM 立场 |
|---|---|---|
| 1 | gemproj source 双形态 vs 恒内嵌 | 双形态（库内引用/导出内嵌）；备选：导入时归一化为 asset 引用 |
| 2 | 引擎漂移 UX：横幅+重算 vs 冻结旧结果 | 横幅+重算；前提 ENGINE_VERSION bump 纪律 |
| 3 | 编辑页从图开始：快速排稿 vs 空白画布 P0 范围 | 快速排稿 P0、空白画布 P1（边际成本近零可升 P0，需成本依据） |
| 4 | AssetProject blobKey 换绑 vs 独立 projectStore | 换绑+契约显式豁免（复用 blob GC + 单事务） |
| 5 | 显式保存+守卫 vs 自动草稿 | P0 显式保存；draft P2 独立槽 revisit |
| 6 | 块覆写跨版本迁移 | P0 悬空清点 + P1 掩码内容哈希；评估块 id 内嵌哈希尾缀可行性 |
| 7 | 素材库是否更名（收编项目后） | 不改名；项目占比 >30% 再议 |
| 8 | .gemgen 图片内嵌 vs 图片资产+元数据引用 | 内嵌（补充稿 A.2.3）——**R1 已裁：支持**（补配额失败态） |
| 9 | 旧「生成结果」裸图片归档是否包装迁移 | 不回填（伪造溯源有害）——**R1 已裁：支持**（库内标「旧生成图片」徽标） |
| 10 | variants {v:2} 信封：退役+一次性迁移 vs 保留会话缓冲 | 退役——**R1 已裁：方向支持、细则推翻**（见 §9-E3：create-only 迁移 journal，不做内容差异覆盖） |

实验室专属议题 11-22 见补充稿 §E——**R1 全部裁决完毕**（19 项：16 支持/附前置、E3/E9 推翻细则、E7 与手势合并修订），裁决全文见 `.agents/documents/2026-09-19-project-file-formats/codex-review-r1.md`，契约化落档见 §9。

## 9. R1 评审落档（Codex 19 裁决 + 10 阻塞的契约化；实现波次的强制前置）

> R1 结论 NO-GO（5.2/10），本节是达成 GO 的最小修订集在 change 层的落档；tasks.md 0.4+ 为其切片。R1 两处事实勘误：①「47/49 基线失败」系与并行走查负载争用——solo 复跑 21/21、全量 528/528（两文件各自绿）；②PRODUCT_MODEL.md 实体存在于 rhinestone-studio/（v2→**v3 已落盘**，TERMS.md 同建）。

### 9.1 数据层契约（B1/B5/B8；R2 精化）

- **B1 runTx 终态语义（R2 补首终态规则）**：body 返回值暂存，`tx.oncomplete` 后 resolve；`onabort/onerror`/body reject/commit error 一律 reject——**仅首个终态生效**（终态后到达的事件忽略）；**body 只能 await 本事务的 IDB request**，不得跨 timer/IO/worker 再发 request；body 成功值在 `oncomplete` 前对调用方不可见。实现顺序：先 contract test（commit error 注入/body 已返回值但 commit 失败/新 blob 已写但 node put 失败/旧 blob 被共享/thumb 共享与缺失），再回归既有 assetStore 全部写路径（资产/回收站/哈希回填）。换绑失败时旧 node、旧 file blob、旧 thumb、旧 content-hash 记录**均保持**；换绑成功后旧物理记录删除仅在**全节点（含项目节点与 thumb 引用）无引用**时发生。
- **B5 项目生命周期 API（R2 冻结 lease/CAS 形状）**：`openProject(id)` 返回 lease `{projectId, ownerId, token, pinnedAssetIds, closed}`；`closeProject(lease)` **幂等**，仅同一 token 的最后一个 owner 关闭才解除 pin；打开与 source/reference **重绑以 lease 引用集合做差分 pin/unpin**；`updateProjectAsset(projectId, bytes, summary, expectedBlobKey)` 单确认事务 **CAS 换绑**，事务顺序冻结：读节点及 expected key → 写新 blob/summary → 更新 node → 扫描旧 blob（含 thumb）引用 → 删除无引用物理记录；**冲突返回 typed conflict 且不写任何一项**（孤儿 blob 由后续 GC 回收，不在冲突路径盲删）；**卡片只用 summary 展示，实际打开必 parse blob**；summary 缺失/不一致可重算但不覆盖文件真源（`summaryUpdatedAt` 进 schema）。
- **B8/E9 缩略定案（A 案，物理契约见 §2）**：thumbKey/thumb 物理元组随 AssetProject schema 冻结（§2 已落）；gemproj/gemdoc/gemtpl 无缩略；姊妹稿原「项目缩略 P1」表述以本条为准（已修文对齐）。

### 9.2 消费与意图契约（B2/B3/B7；R2 精化）

- **B2 图像消费单点（R2 扩展）**：`getHandoffImageBlob(assetId)` 是**所有「跨模块消费图片字节」的出口**——图片 asset 直取；gemgen 校验节点类型/MIME 后 parse 内嵌 image（dataUrl→Blob 不重编码）；缺失/版本超前/损坏分别给 typed error（含 parser 版本错误分支）。`studio.loadFromHandoff`、下载、预览、画廊全部只调此出口；HandoffPayload 保持 `{assetId,name,referenceAssetId?}` 零变化，调用方不新增临时裸图 id；实现切片需同步清理 studio 旧 `getAssetBlob` 直连入口与注释。
- **B3 openIntent 原子 claim/ack（R2 推翻 peek/consumeSuccess）**：状态机 `pending → claimed(token) → succeeded | failed`——**只有 claimer 能执行动作与 ack**（并发 $effect 至多一个 claim 成功）；四 kind 共用单一 token namespace；**新 intent 到来 = replace 旧 intent（旧 claim 作废）**；AssetsView 双击**先 parse 成功再置 intent**（失败不离开素材库）；App 只切视图不清 intent；LabView 侧 hydrate/模板回链/DOM 定位/滚动任一失败 → **不清 token、留在当前视图、单次提示**（不重复 toast，保留可诊断状态）；**只有目标卡展开且高亮已挂载才 ack**；刷新语义 = **内存 intent 丢弃（明文规定，不持久化）**。测试五时序 + intent 覆盖 + 半成功分支。
- **B7 画廊并集与定位失败分支（R2 补）**：entry key 冻结 `asset:<id>` / `task:<id>`；活任务状态覆盖只读投影（precedence：活任务 > 库档案；活任务指向缺失/非 gemgen 节点 → 按活任务态展示 + 缺失角标；归档失败后只读投影保留；重试产新档旧档按 createdAt 降序并存）；库来源 runId 取 provenance.runId；legacy 只进「全部」；定位动线失败分支冻结：目标 DOM（data-testid）不存在 / 过滤重算后目标组消失 / 组件卸载 / scrollIntoView 失败 → 均「不清 token + 留当前视图 + 单次提示」；目标组折叠先展开再定位。并集矩阵测试（重复/归档失败/模板孤儿/50 条裁剪/只读卡/进行中卡）+ 定位失败分支测试。

### 9.3 实验室契约（E3/E4/B4/B6；R2 精化）

- **E3/B6 variants 迁移 journal（R2 结构定案）**：先新增 **raw-v2 reader**（现 loadVariants 版本门不符直返 null，无法读原文——迁移专用读取路径绕过版本门取 {v:2} 原始 items）；journal 结构冻结 `{version, state:'pending'|'done', completedNodeIds, sessionWritten, oldKeyDeleted, backupKey, startedAt}`；执行顺序固定：**备份原文（一次性备份 key，TTL 30 天清理）→ 逐节点 create-only（稳定 `ast-tpl-${presetId}` 存在性含软删即跳过，绝不内容覆盖）→ 记完成集 → 写 lab-session → state='done' → 删 VARIANTS_KEY**；IDB 与 localStorage 非原子：任一步崩溃按完成集重试（旧 key 未删则保留），软删不复活，用户内容零变化；测试：中途失败/重启重试/成功删 key/软删不复活/备份 TTL。补充稿 A.4.3 原「内容不一致覆写」算法**作废**，以本条为唯一迁移算法（补充稿已修文）。
- **E4/B4 模板写队列与关闭终态（R2 补状态图）**：每模板 asset 串行写队列 + 单调 revision（旧 revision 完成不得覆盖新内容；删除/换绑冲突 = 清空队列并终止在途写，typed error 上浮）；RightSheet **受控 `onOpenChange`**，关闭状态机冻结 `open=true → flushing → open=false` 或 `open=true → error(open 保持 true，不丢焦点/缓冲)`——flush 失败**禁止关闭**，仅「放弃修改」才回退最后成功快照并关闭；编辑器保留共享 record 外的短暂未提交缓冲，成功提交即清空；测试：overlay/Escape/按钮三入口一致 + 删除中/IDB 失败/双宿主同开。
- E11 字段名定案 `advancedJsonRedacted`（注明不可重放；复用参数读会话 task 原值；与旧图片节点 meta.prompt 明文遗留**分开记录**于安全说明——后者属 E2 旧归档不回填边界）；E8 lab-session 失效/损坏回默认启用集；跨 tab `storage` 事件**显式提示覆盖发生**（非静默 last-write-win）。

### 9.4 手势统一（E7 合并裁决，姊妹稿已同步修文）

桌面单击选中（选中态工具行 [打开]/[重命名]，Enter=打开）、双击打开；移动端单击打开；图片节点同步遵循（重命名移出双击），修订文本已并入姊妹稿 A.4.2/硬规则 5 与 PRODUCT_MODEL v3 硬规则 5。

### 9.5 切片顺序（B10；R2 重排为契约 gate → 实现 gate 双段）

- **契约 gate（仅文档/类型/接口冻结，零实现）**：四格式 schema+MIME+parser 接口（4.1 的类型与 typed error 定义前移）、AssetProject 完整类型/lease/CAS/thumb 所有权（0.5 前移为**唯一** contract 定义，1.1 只实现不重定义）、openIntent claim/ack 状态机、迁移 journal 状态机（0.8 只冻结算法**不消费 4.3 实现**）。
- **实现 gate 顺序**：`0.4（runTx contract test+改造）→ 0.5/1.1（类型唯一化+实现）→ 4.1（labFile parser 实现）→ 0.6（getHandoffImageBlob 真实三态测试）→ 0.7（intent store contract test → 4.6 UI 动线测试）→ 0.8（journal 实现）→ 1.4 / 2.7 / 4.2-4.7 放行`；0.7 拆两段：纯 store claim/ack contract test 先行，LabView 集成测试随 4.6；2.7 四格式导入。
- D6 掩码哈希另立 P1 change；E7 的 >30% 复议条件改数据驱动表述。
