<!--
Orthogonal intents (max 4):
1. [2026-09-19 Contract] [R4 最终 DAG，与 design §9.5 完全一致]：
     0.4（runTx，独占——不与其他写入型切片并行）
       -> 0.5（契约唯一化）/ 1.1（AssetProject 实现）/ 4.1（labFile parser）   ← 三者可并行（仅消费冻结类型）
       -> 0.6（handoff 单点）+ 0.7（intent store contract）+ 0.8（journal 实现）
       -> 4.2（sys-templates + seed）          ← 4.3 硬前置
       -> 4.3 / 4.3b
       -> 4.4
       -> 4.5
       -> 4.6（含 0.7 的 UI 动线测试）
       -> 1.4 + 2.7 + 4.7（按各自依赖收口）
   约束：并行实现代理上限 2；全量 pnpm test/check/build 绿门串行执行；引擎仅增 ENGINE_VERSION 常量与 bump 纪律注释，不改任何算法语义。
2. [2026-09-19 Data] AssetProject 入库（ingest + blobKey 换绑保存 + sys-projects + 保护④ lease）全 vitest 证明，
   含失败注入与既有写路径回归；库内可见性回归防「项目节点隐形」。
3. [2026-09-19 UX] 两页生命周期（studio 项目态 / edit dirty+四入口）与守卫三分法；上下文条重写、
   编辑空态重写、改名联动一次改齐（grep 含注释/测试断言/toast/handoff 文案）；不回改五区其余结构。
4. [2026-09-19 Process] §E 议题已全裁（R2 复核）；对应切片依赖已显式化；每步绿门 pnpm test + svelte-check + build；
   浏览器走查覆盖 PM 稿 §C 动线。
5. [2026-09-19 R2 合流重排（codex-review-r2 P0-4）] 2.1–2.5（studio 单层 v1 生命周期骨架）整体移交
   studio-layers change——v2 layers[] 序列化取代单层参数写入，serializer 首次写入即 v2（不得先落 v1 写路径再返工）；
   2.6 留守但 dirty 触发集依赖 studio-layers 的 StudioOp 全集；2.7 留守但依赖 add-gem-catalog W0
   contract gate（四格式 v2 parser + v1→v2 迁移入口）与 0.6/0.7/0.8；5.1 改名联动移交 rename-and-expert-workbench。
   五段合流门序与移交边界见 design §10。
6. [2026-09-19 勾选审计（主会话）] 对照源码符号与测试引用逐片核验：0.1-0.8、1.1-1.3、3.1-3.4、
   4.1-4.3c、4.4-4.6 共 23 片已实现（证据：engine/version.ts、projectFile.ts serialize+迁移注册、
   assetStore.ts runTx/openProject/updateProjectAsset、handoffImage.ts、openIntent.svelte.ts、
   lab/templateMigration.ts journal、edit.svelte.ts [3.2 dirty]、Assets/TemplateEditSheet.svelte 双宿主）。
   未实现：1.4（无 [1.4] 标记与底栏计数）、1.5（占位）、2.6/2.7（留守待依赖）、3.5（P1 占位）、4.7、
   5.2（核对半）、5.3。此前全未勾选与实况不符（R2 评审亦据此误判 2.x 全未实现——实况 0.6 等已落），已修正。
-->

## 0. 契约冻结（GO 前置）

- [x] 0.1 引擎 `ENGINE_VERSION` 常量 + bump 纪律注释（语义变更必 bump：segment/布局/颜色映射）；vitest：常量存在且被 gemproj 序列化消费
- [x] 0.2 `projectFile.ts`：GemprojFile/GemdocFile 类型 + serialize/parse + `SerializedBlock`（mask base64）；vitest：两格式 round-trip **字节等价**、formatVersion 向前拒读、脏输入显式错误、dataUrl 不驻留内存 store（序列化即弃）
- [x] 0.3 formatVersion 迁移链骨架（(from,to)=>migrate 注册表）+ 迁移注入测试（v1→v2 假想 bump 演练）
- [x] 0.4 [R1-B1/R2] runTx 终态语义改造（**实现序列之首**）：仅首个终态生效 + `oncomplete` resolve / `onabort/onerror`/commit error reject；body 只能 await 本事务 request；先写 contract test（commit error 注入/body 已返值但 commit 失败/新 blob 写后 node put 失败/共享 blob/thumb 共享与缺失）再改造，改造后回归既有资产/回收站/哈希回填全部写路径；vitest 见 design §9.1
- [x] 0.5 [R1-B5/R2/R3] **AssetProject 契约唯一化定义**（类型四 kind+四 MIME PROJECT_MIME+summary/thumbKey/thumb 物理元组+lease/CAS 接口签名——本切片只定义不实现，1.1 只实现不重定义）；`openProject(id, ownerId)→lease`（ownerId 宿主提供且宿主生命周期内稳定；每次 open 唯一 lease/token，重复 open 各自计数）/`closeProject(lease)` 幂等（过期 token no-op stale）/差分 pin/`updateProjectAsset` CAS 事务顺序与 typed conflict（不写孤儿 blob）；vitest：lease contract（同 asset 两 owner/重复 close/过期 token/差分重绑）
- [x] 0.6 [R1-B2/R2] `getHandoffImageBlob(assetId)` 单点出口（接口签名本切片冻结；**真实 image/gemgen/missing 三态测试依赖 4.1 parser 实现，排在 4.1 之后执行**）；typed error 全集（缺失/版本超前/损坏/节点类型与 MIME 校验）；dataUrl→Blob 不重编码；studio 旧 getAssetBlob 直连入口与注释同步清理
- [x] 0.7 [R1-B3/R2] `openIntent.svelte.ts` **claim/ack 状态机**（pending→claimed(token)→succeeded|failed；只有 claimer 执行与 ack；新 intent replace 旧；刷新=内存丢弃明文）：先做**纯 store contract test**（claim 原子性/覆盖/半成功）；LabView UI 动线测试随 4.6；双击先 parse 成功再置 intent；失败不清 token+单次提示
- [x] 0.8 [R1-B10/R2] 迁移 journal **算法冻结**（journal 结构/顺序/崩溃恢复见 design §9.3；本切片只冻结状态机**不消费 4.3 实现**）+ 手势统一文本核对（姊妹稿/PRODUCT_MODEL 修文一致）；1.4/2.7/4.2-4.7 在本 gate 后放行

## 1. 素材库数据层（assetStore / library）

- [x] 1.1 AssetProject 实现（**类型/MIME/lease/CAS 以 0.5 契约为唯一定义，本切片只实现不重定义**）+ `ingestProjectAsset`（PROJECT_MIME 白名单+kind/MIME/扩展名交叉校验）+ sys-projects seed 幂等；vitest：ingest/重名后缀/白名单拒绝/交叉校验拒绝
- [x] 1.2 保存写路径：首次 ingest → 记 projectId；再次同 node **blobKey 换绑**（单事务）+ summary 重写 + 旧 blob 引用计数清理；vitest：换绑原子性、失败注入回滚、旧 blob 全清才删字节（复用 GC 机制）
- [x] 1.3 引用保护第 ④ 类：打开中 gemproj pin source+reference assetId（硬）；gemdoc 仅 pin reference；vitest：pin 期间软删/硬清被拒或保留、关闭项目后放行
- [x] 1.4 library/AssetsView type-aware 化：全部素材口径纳入项目节点（image-only 过滤改造）+ 项目卡片（图标/summary 直出/类型徽标）+ 底栏「共 N 项 · 图片 X · 项目 Y」+ 点击=对应页打开（经守卫）；vitest：项目节点可见性回归 + 点击路由
  > [2026-09-20] 1.4 收据：library.visibleItemCounts（项目=五 kind 聚合不拆分、含内置 seed；recent 仍只收图片）+ AssetsView 项目卡 type-aware（gemproj 圆规/gemdoc 画笔/gemtpl 版式图标 + 类型徽标 + projectSummaryLine 直出）+ 底栏计数 + openProjectNode canonical 路由（gemproj/gemdoc 置 openIntent 切对应页由消费侧守卫；gemtpl/gemgen/gemshape 沿 4.6/gem-catalog canonical）+ 项目节点单击选中（工具行 [打开]/[重命名]、Enter=打开、Esc 取消；图片节点手势不动归 4.7）。tests/assets/assetsViewProjects.test 5 例（五 kind 可见性+徽标+summary、底栏计数含软删回落、recent 不含项目、单击/Enter/双击/移动端路由、gemgen 解析失败不离开素材库）+ 既有族 assets-view.mount/templateSheet/picker×2/sysShapesSeed/projectAsset/assetStore 共 90 例零回归；pnpm check 全仓 0 错误。
- [ ] 1.5 [议题4] 若 Codex 推翻换绑 → 按 projectStore 对照方案重切片（本条占位，默认不执行）

## 2. 排钻设计页生命周期（studio）

> [2026-09-19 R2 合流重排] 原 2.1–2.5（studio store 项目态 / 打开链路 / ContextBar 重写 / 导出双路径 / 空态与来源缺失）**整体移交 studio-layers change**：图层模型（layers[] v2）改变序列化、打开重放与 dirty 触发形态，单层 v1 骨架在本 change 落地即返工。生命周期 UX 契约（design §3）作为移交输入保留，由 studio-layers 的对应切片承接实现与验收。本节仅留守守卫与全局导入两片。

- [x] 2.6 守卫三分法：切 Tab 不弹（● 徽标常驻）；beforeunload（dirty 时）；页内破坏性动作三按钮 Dialog；vitest：三分行为 + dirty 清零路径。**依赖（R2 重排）：dirty 触发全集 = studio-layers 的 StudioOp/图层操作全集（层配置/成员变更/重分块/历史 op 等）落地后收口，本切片不得以 v1 参数集为终态口径**
  〔2026-09-20 完成：依赖就绪（studio-layers 2.8 isStudioDirty 全集 = 一切 StudioOp）。①切 Tab 不弹 = store 模块单例跨视图存活（bits-ui Tabs 恒挂载，无路由守卫参与）+ ●徽标常驻：未命名会话 studio-dirty-badge（StudioContextBar 来源组新徽标）+ 已保存/已打开项目 project-dirty-dot（既有）。②beforeunload 归 StudioView svelte:window（dirty 时 preventDefault——视图恒挂载故任意 Tab 下成立）。③页内破坏性动作三按钮「保存并继续/不保存/取消」收口为新 guard 域单例 `src/lib/studio/guard.svelte.ts`（Dialog 单实例挂 StudioView，overlay/Escape 关闭按取消处理；保存复用 ④段 saveGemproj 链路——首存默认名 ingest/再存 CAS，失败就地 role=alert Dialog 保持可改选「不保存」）；触发面接线：openIntent 打开其它项目（StudioView 意图门 claim 后守卫——取消 = ackFailure 'gemproj-open-guard-cancelled'，EditView guardClaim 同式）、缺源重绑换档（sourceOverride 路径）、换来源图（ContextBar.changeSource 选定后守卫）、新建会话（送排钻 handoff 消费守卫——armed 位防 dirty 翻转重入双载，取消 = clearHandoff 丢弃交接；空态选图/上传守卫）。范围注记：关闭项目不设守卫（closeStudioProject 保留会话内容在内存、可另存新档——无数据丢失，design §3 破坏性清单未含）。vitest guard.test 9 例（store 级 4：干净直行/dirty 挂起取消/保存并继续链路/保存失败分支/claim 取消 ack；挂载级 5：切 Tab 零拦截+徽标常驻、beforeunload 两态、openIntent 取消+不保存全链（ack consumed + 干净 base）、handoff 取消丢弃+保存后直行、换来源图取消/不保存）+ 邻面 interactions/panels/studio-view.mount/projectPersistence 38 例 + app.smoke/busyStates/walkthrough 31 例零回归；svelte-check 0 错误〕
- [x] 2.7 App 层全局导入：file input + drop 接**四格式**（.gemproj/.gemdoc/.gemtpl/.gemgen，[R1-B10] 依赖 0.7/0.8 gate）→ ingest → 按类型路由（前两切对应页，后两走 openIntent）；失败三段式 toast；vitest：四格式导入路由。**依赖（R2 重排）：add-gem-catalog W0 contract gate 完成（四格式 v2 版本表 + v1→v2 迁移入口 + .gemshape parser 冻结）后方可实现——导入路由消费 v2 parser，旧版本文件经迁移入口读入**
  〔2026-09-20 完成：App.svelte 顶栏隐藏 file input（accept 四扩展名+multiple）+ 入口按钮 + svelte:window dragover(preventDefault)/drop 窗口级接线——识别 = vendor MIME 优先（projectKindOfMime）回落扩展名（沿 PROJECT_MIME 唯一真源；.gemshape 走素材库上传链路不在此面）→ blob 按 PROJECT_MIME 重打类型后 ingestProjectAsset（mime×kind×文件内 kind 三方交叉校验）→ 路由对齐素材库 1.4 openProjectNode canonical 语义（gemproj/gemdoc setOpenIntent 切排钻设计/专家工作台由对应页消费守卫；gemtpl/gemgen 沿 4.6 意图通道切实验室）；失败三段式 toast（不支持类型/交叉校验不符未入库）；重复导入幂等（uniqueNameAmong 重名后缀「 (2)」）。vitest app.globalImport 11 例：四格式 input/drop 路由（视图+意图+节点落 sys-projects+成功 toast）/vendor MIME 无扩展名识别/失败三分支（.txt 与 .gemshape 拒收零入库零切视图零意图、.gemproj 壳装 gemdoc 字节交叉校验拒收）/重复导入幂等/drop 协议（dragover preventDefault、多文件批量、无 dataTransfer 防御）——app.smoke 8 + openIntentFlow 17 + assetsViewProjects 5 邻面共 41 例全绿〕

## 3. 手动编辑页（edit）

- [x] 3.1 `lib/edit/quickLayout.ts`：默认参数（k=8/seed=1/SS10/gap0.4/密度100%）一次 runCompute（segment+hybrid）→ ManualEditHandoff 同构载荷 → loadFromHandoff；不经 studio store；vitest：同参同出快照 + provenance=quick-layout
- [x] 3.2 edit store：serialize/deserialize（gemdoc）+ manualCounter 派生（max(m-编号)+1）+ **dirty 口径替换 hasEdits 消费点**（守卫/徽标/覆盖确认；文案「未保存」；导出不清除 dirty）；vitest：dirty 全集 + round-trip + counter 派生
- [x] 3.3 EditView 空态重写：主 CTA 从素材库选图（→快速排稿进度+取消）/ 次打开精修项目 / 上传图片 + 最近精修项目 ≤4 + 引导行「想先调密度与策略？去排钻设计送精修」；文档态摘要条项目身份 + 保存/菜单（另存为/导出 .gemdoc/关闭文档）；vitest：四入口 converge 同一文档模型
- [x] 3.4 打开 .gemdoc：库点击/最近/磁盘导入三通道 → painting PNG 解码 skeleton → 干净态；reference 四态沿用；vitest：打开链路 + missing reference 容忍
- [ ] 3.5 [议题3] 空白画布：默认 P1 占位；若 Codex 裁定升 P0 → 合成纯色 paintingSnapshot + 默认 grid/palette 切片（本条按裁决执行）

## 4. 实验室格式对：.gemtpl / .gemgen（[Owner 2026-09-19] 七条裁决；PM 补充稿细化后执行）

- [x] 4.1 `lib/persistence/labFile.ts` 新建（与 projectFile.ts 同族同纪律；是否合并单文件由 Codex 定）：GemtplFile/GemgenFile serialize/parse + round-trip 字节等价（gemtpl 含「未变更字段零漂移」）+ formatVersion 向前拒读 + 迁移链 + 防御上限归属迁移登记（32 条/promptBody 8000 → schema 校验）；vitest 同 0.2 口径
- [x] 4.2 素材库数据面（**4.3 的硬前置，见 design §9.5 DAG**）：projectKind 四分化 + PROJECT_MIME 四值（0.5 契约）+ sys-templates「模板」目录（assetStore seed，插「生成结果」前）；**preset → .gemtpl 条目 seed 在 lab hydrate**（域管线归域 store：物化合成案例 + 建模板，节点 id `ast-tpl-${presetId}`，存在即跳过含软删；单模板失败不建半品下轮重试）；vitest：seed 幂等/删内置不复活/软删还原回列表
- [x] 4.3 实验室模板面板库化（**在 0.8 journal 状态机之后、4.2 sys-templates 就绪后执行**；自建变体迁移用确定性 id `ast-tpl-legacy-${legacyId}`，见 design §9.3）：`lib/stores/templates.svelte.ts` 共享 record store + VariantEditor 数据源切换；CRUD（新建即 ingest/复制 fork/软删/重命名）；**保存=字段提交自动换绑**（[R1-E4] 每模板串行写队列 + 单调 revision，旧写不覆盖新写）；EffectRefControl 写回 caseBinding + 第四入口 [从素材库选]；**variants {v:2} 信封退役迁移（[R1-E3/R2] 严格按 0.8 冻结的 journal 状态机实现：raw-v2 reader + create-only + 备份 key TTL + 完成集 + 全部成功才删旧 key）**；applyTaskParams 非破坏化（表单回填+[复制提示词]）；vitest：CRUD 写路径/迁移中途失败重启重试/自建 variant 崩溃重试仅建一个 gemtpl（确定性 id）/成功删 key/备份 TTL/版本门 bump 后库模板零变化（主指标）/软删不复活
- [x] 4.3b **TemplateEditor 双宿主**：抽出可嵌入组件（名称/候选/提示词体/案例绑定四件套）+ 实验室手风琴与 RightSheet 两宿主接线；RightSheet（Sheet side=right，`w-full sm:max-w-[520px]`，移动端把手/safe-area/≥16px）+ 保存态指示 + **[R1-B4] 受控 onOpenChange 关闭状态机**（overlay/Escape/按钮统一 flush；失败三选 mini Dialog；放弃=回退最后成功快照）；vitest：双宿主同 record 互见 + 守卫全分支（overlay/Escape/删除中/IDB 失败/双宿主同开）
- [x] 4.3c 素材库 tpl 卡片两动作：去使用/去编辑收敛为两个 canonical handler（入口矩阵见补充稿 C.5.1）；vitest：动线 converge + 禁第三路径
- [x] 4.4 归档改造：archiveGeneratedResult → serializeGemgen → ingestProjectAsset（sys-generated 批次夹机制不变）；溯源收编（meta 字段上移 provenance + summary 缓存 + task 新增 templateAssetId）+ **[R1-E9] gemgen 缩略 P0 = 显式 thumbKey**（256px thumb 物理记录 + MIME/尺寸 + 删除/换绑/回收引用规则随 AssetProject schema 冻结）+ `getGemgenImageBlob` 单点 helper（送排钻/画廊/下载共用，接 0.6 出口）；旧裸图片不回填不进并集（库内标「旧生成图片」徽标）；vitest：归档形态/溯源字段/不可变/thumb 生命周期/handoff 零变形
- [x] 4.5 任务画廊重构：头部单选 chips（计数 + 「已删模板」聚合）+ **[R1-B7] GalleryEntry 身份冻结**（assetId 去重 + 活任务状态覆盖只读投影；无 assetId 以 task id；库来源 runId 取 provenance；legacy 只进「全部」）+ 卡片收起(默认)/展开两态（展开集会话内存）+ PreviewDialog 参考图来源扩 provenance + 「清空历史」确认 Dialog 升级（文案明确「只清会话记录不删档案」）；vitest：并集矩阵（重复/归档失败/模板孤儿/50 条裁剪/只读卡/进行中卡）
- [x] 4.6 `openIntent.svelte.ts` 统一意图通道（四 kind 一次性消费）+ 双击 gemgen 七步定位-展开动线（解析先于切视图/tick/scrollIntoView/展开+高亮/清意图）+ 双击 gemtpl 动线 + 移动端单击；vitest：两动线全链 + 失败分支
- [ ] 4.7 打开手势统一：项目节点单击选中/双击打开 + 图片节点是否同步修订按议题裁决落（含姊妹稿文本修订）；四格式全局导入路由；浏览器走查（双击两动线 + 收起展开手感 + RightSheet 移动端）

## 5. 改名联动 + 收尾

> [2026-09-19 R2 合流重排] 5.1 改名联动**移交 rename-and-expert-workbench change**（该 change 统一承接「转化工作台→排钻设计」与「手动编辑→专家工作台」两次命名及其全库 grep 联动，「送精修」动作文案经 Owner 工作默认裁定不改）。本节留守模型核对与绿门收尾。

- [ ] 5.1 ~~措辞表一次改齐~~ **移交 rename-and-expert-workbench**（见上注；本 change 不再承载任何命名切片）
- [ ] 5.2 ~~PRODUCT_MODEL v3 增补落盘~~ **已落盘（R1 前完成）**：PRODUCT_MODEL v3 + TERMS.md v1 已提交（四格式真源/豁免登记/硬规则 5-8/getHandoffImageBlob 单点/降熵链）；本项改为核对实现与模型零漂移 + CI grep 旧规则残留（「点击 = 用对应页面打开」等旧措辞）
- [ ] 5.3 全量绿门 + 浏览器走查：PM 稿 §C 动线（新建→调参→保存→刷新→最近续作；选图直入快速排稿；来源缺失重绑；双格式导入导出）；1 万钻 60fps 抽查；三模块管线回归
