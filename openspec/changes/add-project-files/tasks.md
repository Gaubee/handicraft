<!--
Orthogonal intents (max 4):
1. [2026-09-19 Contract] [R2 双段 gate] 契约 gate（0.5 类型唯一化/0.6 接口签名/0.7 claim-ack 状态机/0.8 journal 冻结——只定义）先于实现 gate；
   实现顺序固定 0.4 → 0.5/1.1 → 4.1 → 0.6 → 0.7 → 0.8 → 4.3 → 1.4/2.7/4.2-4.7（0.6 真实三态测试依赖 4.1 parser；0.7 UI 动线测试随 4.6）。
   引擎仅增 ENGINE_VERSION 常量与 bump 纪律注释，不改任何算法语义。
2. [2026-09-19 Data] AssetProject 入库（ingest + blobKey 换绑保存 + sys-projects + 保护④ lease）全 vitest 证明，
   含失败注入与既有写路径回归；库内可见性回归防「项目节点隐形」。
3. [2026-09-19 UX] 两页生命周期（studio 项目态 / edit dirty+四入口）与守卫三分法；上下文条重写、
   编辑空态重写、改名联动一次改齐（grep 含注释/测试断言/toast/handoff 文案）；不回改五区其余结构。
4. [2026-09-19 Process] §E 议题已全裁（R2 复核）；对应切片依赖已显式化；每步绿门 pnpm test + svelte-check + build；
   浏览器走查覆盖 PM 稿 §C 动线。
-->

## 0. 契约冻结（GO 前置）

- [ ] 0.1 引擎 `ENGINE_VERSION` 常量 + bump 纪律注释（语义变更必 bump：segment/布局/颜色映射）；vitest：常量存在且被 gemproj 序列化消费
- [ ] 0.2 `projectFile.ts`：GemprojFile/GemdocFile 类型 + serialize/parse + `SerializedBlock`（mask base64）；vitest：两格式 round-trip **字节等价**、formatVersion 向前拒读、脏输入显式错误、dataUrl 不驻留内存 store（序列化即弃）
- [ ] 0.3 formatVersion 迁移链骨架（(from,to)=>migrate 注册表）+ 迁移注入测试（v1→v2 假想 bump 演练）
- [ ] 0.4 [R1-B1/R2] runTx 终态语义改造（**实现序列之首**）：仅首个终态生效 + `oncomplete` resolve / `onabort/onerror`/commit error reject；body 只能 await 本事务 request；先写 contract test（commit error 注入/body 已返值但 commit 失败/新 blob 写后 node put 失败/共享 blob/thumb 共享与缺失）再改造，改造后回归既有资产/回收站/哈希回填全部写路径；vitest 见 design §9.1
- [ ] 0.5 [R1-B5/R2] **AssetProject 契约唯一化定义**（类型四 kind+四 MIME PROJECT_MIME+summary/thumbKey/thumb 物理元组+lease/CAS 接口签名——本切片只定义不实现，1.1 只实现不重定义）；`openProject→lease`/`closeProject(lease)` 幂等/差分 pin/`updateProjectAsset` CAS 事务顺序与 typed conflict（不写孤儿 blob）；vitest：lease 生命周期 contract（fake 实现上验证语义签名）
- [ ] 0.6 [R1-B2/R2] `getHandoffImageBlob(assetId)` 单点出口（接口签名本切片冻结；**真实 image/gemgen/missing 三态测试依赖 4.1 parser 实现，排在 4.1 之后执行**）；typed error 全集（缺失/版本超前/损坏/节点类型与 MIME 校验）；dataUrl→Blob 不重编码；studio 旧 getAssetBlob 直连入口与注释同步清理
- [ ] 0.7 [R1-B3/R2] `openIntent.svelte.ts` **claim/ack 状态机**（pending→claimed(token)→succeeded|failed；只有 claimer 执行与 ack；新 intent replace 旧；刷新=内存丢弃明文）：先做**纯 store contract test**（claim 原子性/覆盖/半成功）；LabView UI 动线测试随 4.6；双击先 parse 成功再置 intent；失败不清 token+单次提示
- [ ] 0.8 [R1-B10/R2] 迁移 journal **算法冻结**（journal 结构/顺序/崩溃恢复见 design §9.3；本切片只冻结状态机**不消费 4.3 实现**）+ 手势统一文本核对（姊妹稿/PRODUCT_MODEL 修文一致）；1.4/2.7/4.2-4.7 在本 gate 后放行

## 1. 素材库数据层（assetStore / library）

- [ ] 1.1 AssetProject 实现（**类型/MIME/lease/CAS 以 0.5 契约为唯一定义，本切片只实现不重定义**）+ `ingestProjectAsset`（PROJECT_MIME 白名单+kind/MIME/扩展名交叉校验）+ sys-projects seed 幂等；vitest：ingest/重名后缀/白名单拒绝/交叉校验拒绝
- [ ] 1.2 保存写路径：首次 ingest → 记 projectId；再次同 node **blobKey 换绑**（单事务）+ summary 重写 + 旧 blob 引用计数清理；vitest：换绑原子性、失败注入回滚、旧 blob 全清才删字节（复用 GC 机制）
- [ ] 1.3 引用保护第 ④ 类：打开中 gemproj pin source+reference assetId（硬）；gemdoc 仅 pin reference；vitest：pin 期间软删/硬清被拒或保留、关闭项目后放行
- [ ] 1.4 library/AssetsView type-aware 化：全部素材口径纳入项目节点（image-only 过滤改造）+ 项目卡片（图标/summary 直出/类型徽标）+ 底栏「共 N 项 · 图片 X · 项目 Y」+ 点击=对应页打开（经守卫）；vitest：项目节点可见性回归 + 点击路由
- [ ] 1.5 [议题4] 若 Codex 推翻换绑 → 按 projectStore 对照方案重切片（本条占位，默认不执行）

## 2. 排钻设计页生命周期（studio）

- [ ] 2.1 studio store 项目态：projectId/name/dirty + 序列化挂接（serializeGemproj 从 store 状态构造）；参数集本身零改动；vitest：dirty 触发全集（参数/覆写/色板/策略/分块）+ 保存后清零
- [ ] 2.2 打开链路：parseGemproj → 载入参数 → 自动重放（复用既有分块/布局重算态）；engineVersion 不等 → 横幅 + pruneStaleOverrides 清点「N 项块覆写失效已移除」；vitest：同版本干净打开、跨版本横幅、覆写悬空清点
- [ ] 2.3 StudioContextBar 重写：项目身份区（[▦]名●）+ 保存(⌘S)/另存为(fork，预填原名)/项目菜单（导出 .gemproj / 导出为精修项目 .gemdoc / 关闭）+ 来源区扩容（名 + [更换▾]）；预览/取景控制不动；移动端折两行
- [ ] 2.4 导出双路径：导出 .gemproj = source 转 embedded 烘焙（原始字节）落磁盘下载；导出 .gemdoc = buildManualEditHandoff → serialize → sys-projects 入库 toast（不切视图）；vitest：两导出与送精修共用构造函数零分叉
- [ ] 2.5 空态 + 来源缺失：空态双 CTA + 最近排钻项目 ≤4（updatedAt 降序）；来源缺失错误卡 + [重新绑定来源图][导出参数文件] + 检查器/胶片带禁用占位；vitest：缺失态进出 + 重绑重放
- [ ] 2.6 守卫三分法：切 Tab 不弹（● 徽标常驻）；beforeunload（dirty 时）；页内破坏性动作三按钮 Dialog；vitest：三分行为 + dirty 清零路径
- [ ] 2.7 App 层全局导入：file input + drop 接**四格式**（.gemproj/.gemdoc/.gemtpl/.gemgen，[R1-B10] 依赖 0.7/0.8 gate）→ ingest → 按类型路由（前两切对应页，后两走 openIntent）；失败三段式 toast；vitest：四格式导入路由

## 3. 手动编辑页（edit）

- [ ] 3.1 `lib/edit/quickLayout.ts`：默认参数（k=8/seed=1/SS10/gap0.4/密度100%）一次 runCompute（segment+hybrid）→ ManualEditHandoff 同构载荷 → loadFromHandoff；不经 studio store；vitest：同参同出快照 + provenance=quick-layout
- [ ] 3.2 edit store：serialize/deserialize（gemdoc）+ manualCounter 派生（max(m-编号)+1）+ **dirty 口径替换 hasEdits 消费点**（守卫/徽标/覆盖确认；文案「未保存」；导出不清除 dirty）；vitest：dirty 全集 + round-trip + counter 派生
- [ ] 3.3 EditView 空态重写：主 CTA 从素材库选图（→快速排稿进度+取消）/ 次打开精修项目 / 上传图片 + 最近精修项目 ≤4 + 引导行「想先调密度与策略？去排钻设计送精修」；文档态摘要条项目身份 + 保存/菜单（另存为/导出 .gemdoc/关闭文档）；vitest：四入口 converge 同一文档模型
- [ ] 3.4 打开 .gemdoc：库点击/最近/磁盘导入三通道 → painting PNG 解码 skeleton → 干净态；reference 四态沿用；vitest：打开链路 + missing reference 容忍
- [ ] 3.5 [议题3] 空白画布：默认 P1 占位；若 Codex 裁定升 P0 → 合成纯色 paintingSnapshot + 默认 grid/palette 切片（本条按裁决执行）

## 4. 实验室格式对：.gemtpl / .gemgen（[Owner 2026-09-19] 七条裁决；PM 补充稿细化后执行）

- [ ] 4.1 `lib/persistence/labFile.ts` 新建（与 projectFile.ts 同族同纪律；是否合并单文件由 Codex 定）：GemtplFile/GemgenFile serialize/parse + round-trip 字节等价（gemtpl 含「未变更字段零漂移」）+ formatVersion 向前拒读 + 迁移链 + 防御上限归属迁移登记（32 条/promptBody 8000 → schema 校验）；vitest 同 0.2 口径
- [ ] 4.2 素材库数据面：projectKind 四分化 + vendor MIME 四值 + sys-templates「模板」目录（assetStore seed，插「生成结果」前）；**preset → .gemtpl 条目 seed 在 lab hydrate**（域管线归域 store：物化合成案例 + 建模板，节点 id `ast-tpl-${presetId}`，存在即跳过含软删；单模板失败不建半品下轮重试）；vitest：seed 幂等/删内置不复活/软删还原回列表
- [ ] 4.3 实验室模板面板库化（**在 0.8 journal 状态机之后执行**）：`lib/stores/templates.svelte.ts` 共享 record store + VariantEditor 数据源切换；CRUD（新建即 ingest/复制 fork/软删/重命名）；**保存=字段提交自动换绑**（[R1-E4] 每模板串行写队列 + 单调 revision，旧写不覆盖新写）；EffectRefControl 写回 caseBinding + 第四入口 [从素材库选]；**variants {v:2} 信封退役迁移（[R1-E3/R2] 严格按 0.8 冻结的 journal 状态机实现：raw-v2 reader + create-only + 备份 key TTL + 完成集 + 全部成功才删旧 key）**；applyTaskParams 非破坏化（表单回填+[复制提示词]）；vitest：CRUD 写路径/迁移中途失败重启重试/成功删 key/备份 TTL/版本门 bump 后库模板零变化（主指标）/软删不复活
- [ ] 4.3b **TemplateEditor 双宿主**：抽出可嵌入组件（名称/候选/提示词体/案例绑定四件套）+ 实验室手风琴与 RightSheet 两宿主接线；RightSheet（Sheet side=right，`w-full sm:max-w-[520px]`，移动端把手/safe-area/≥16px）+ 保存态指示 + **[R1-B4] 受控 onOpenChange 关闭状态机**（overlay/Escape/按钮统一 flush；失败三选 mini Dialog；放弃=回退最后成功快照）；vitest：双宿主同 record 互见 + 守卫全分支（overlay/Escape/删除中/IDB 失败/双宿主同开）
- [ ] 4.3c 素材库 tpl 卡片两动作：去使用/去编辑收敛为两个 canonical handler（入口矩阵见补充稿 C.5.1）；vitest：动线 converge + 禁第三路径
- [ ] 4.4 归档改造：archiveGeneratedResult → serializeGemgen → ingestProjectAsset（sys-generated 批次夹机制不变）；溯源收编（meta 字段上移 provenance + summary 缓存 + task 新增 templateAssetId）+ **[R1-E9] gemgen 缩略 P0 = 显式 thumbKey**（256px thumb 物理记录 + MIME/尺寸 + 删除/换绑/回收引用规则随 AssetProject schema 冻结）+ `getGemgenImageBlob` 单点 helper（送排钻/画廊/下载共用，接 0.6 出口）；旧裸图片不回填不进并集（库内标「旧生成图片」徽标）；vitest：归档形态/溯源字段/不可变/thumb 生命周期/handoff 零变形
- [ ] 4.5 任务画廊重构：头部单选 chips（计数 + 「已删模板」聚合）+ **[R1-B7] GalleryEntry 身份冻结**（assetId 去重 + 活任务状态覆盖只读投影；无 assetId 以 task id；库来源 runId 取 provenance；legacy 只进「全部」）+ 卡片收起(默认)/展开两态（展开集会话内存）+ PreviewDialog 参考图来源扩 provenance + 「清空历史」确认 Dialog 升级（文案明确「只清会话记录不删档案」）；vitest：并集矩阵（重复/归档失败/模板孤儿/50 条裁剪/只读卡/进行中卡）
- [ ] 4.6 `openIntent.svelte.ts` 统一意图通道（四 kind 一次性消费）+ 双击 gemgen 七步定位-展开动线（解析先于切视图/tick/scrollIntoView/展开+高亮/清意图）+ 双击 gemtpl 动线 + 移动端单击；vitest：两动线全链 + 失败分支
- [ ] 4.7 打开手势统一：项目节点单击选中/双击打开 + 图片节点是否同步修订按议题裁决落（含姊妹稿文本修订）；四格式全局导入路由；浏览器走查（双击两动线 + 收起展开手感 + RightSheet 移动端）

## 5. 改名联动 + 收尾

- [ ] 5.1 措辞表一次改齐：桌面 Tab 排钻设计 / 移动 Tab 排钻 / 送转化→送排钻（TaskCard + 预览 Dialog）/ 编辑空态引导 / ViewId 与路由同步；全库 grep 无「转化工作台/送转化」残留
- [ ] 5.2 ~~PRODUCT_MODEL v3 增补落盘~~ **已落盘（R1 前完成）**：PRODUCT_MODEL v3 + TERMS.md v1 已提交（四格式真源/豁免登记/硬规则 5-8/getHandoffImageBlob 单点/降熵链）；本项改为核对实现与模型零漂移 + CI grep 旧规则残留（「点击 = 用对应页面打开」等旧措辞）
- [ ] 5.3 全量绿门 + 浏览器走查：PM 稿 §C 动线（新建→调参→保存→刷新→最近续作；选图直入快速排稿；来源缺失重绑；双格式导入导出）；1 万钻 60fps 抽查；三模块管线回归
