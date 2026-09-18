# Codex 评审：add-asset-library + redesign-studio-layout（R1）

## 0. 必读清单核对

已逐项阅读并与源码交叉核对：

1. `rhinestone-studio/PRODUCT_MODEL.md`
2. `.agents/documents/2026-09-19-asset-library-design/asset-library-and-studio-redesign.md`
3. `openspec/changes/add-asset-library/{proposal,design,tasks}.md`、`specs/asset-library/spec.md`
4. `openspec/changes/redesign-studio-layout/{proposal,design,tasks}.md`、`specs/studio-workbench/spec.md`
5. `imageStore.ts`、`taskStore.ts`、`lab/studio/edit/handoff` stores、`effectRefs.ts`、`StudioView.svelte`、`CompareGrid.svelte`、`ExportBar.svelte`、`add-manual-edit-mode/design.md`
6. `rhinestone-studio/src/tests/` 现状测试面

独立门结果：两个 change 的 `openspec validate --strict` 通过；当前旧实现 `37 files / 354 tests` 通过，`svelte-check` 0 errors/0 warnings，`vite build` 通过。这些是旧实现基线，不是新契约已实现的证据。

## A. 五议题裁决

### 1. blob 复用 `images` store vs 新建 `assetBlobs`

**结论：采纳 PM 方向，但必须修改接口边界。**

复用合理：当前 `images` 已按 `{id, blob, createdAt}` 存放任务图和效果参考（`src/lib/persistence/imageStore.ts:1-14`），零拷贝迁移保留 v1 数据，也保留旧任务读取路径。新建 blob store 会把所有旧 key 复制一遍，增加配额和失败恢复风险。

但 `assetId` 不能直接作为 `getImageBlob` 的 key。设计写成 `getImageBlob(blobKey(assetId))`（`add-asset-library/design.md:88-98`），而节点模型又规定 `AssetImage.id` 与 `blobKey` 解耦（同文件 `:17-43`）。应冻结 `getAsset(assetId)` / `getAssetBlob(assetId)`：先读 `assetNodes`，对 `refKind='blob'` 解析 `blobKey`，对 `external` 返回 URL/明确不可作 Blob；禁止调用方自行拼 key。复用 `images`，否决“隐式把节点 id 当 blob key”。

### 2. handoff 引用化与烘焙边界（含 C-1/C-2）

**结论：修改 PM 立场；引用化方向正确，但当前“无条件删除 dataUrl”不正确。**

lab→studio 改传资产引用是正确的，当前 handoff 仍传 `image` 与 `reference.dataUrl`（`src/lib/stores/handoff.svelte.ts:8-17`、`lab.svelte.ts:806-825`），刷新和跨模块复用确实受限。工作台→编辑器也应让不可变原图通过资产 id 解析，派生 painting/gems 继续深拷贝烘焙。

然而 C-1/C-2 不能只改字段名：当前真实渲染消费者是 `src/components/Edit/EditCanvas.svelte:63-80`，仍直接读取 `d.referenceDataUrl`；`EditDocument`/`ManualEditHandoff` 真实类型在 `src/lib/stores/edit.svelte.ts:20-58`，`StudioImage` 和 `referenceImage` 也都没有 asset id（`src/lib/stores/studio.svelte.ts:68-95`）。此外，素材硬清空只扫描变体和 studio 会话引用会把正在编辑的 reference 删除。

采纳“引用是 canonical、painting 是 bake”，但实现应至少满足：

- `ManualEditHandoff`、`EditDocument`、`EditCanvas` 共用 `referenceAssetId` 的解析/加载/失效状态；
- 首个发布周期保留旧 dataUrl 的兼容消费或一次性 fallback，直到旧 handoff 测试和运行态清空；
- active edit document 的引用进入回收站硬删保护，或对引用资产建立明确 pin/ref-count；
- handoff 失败必须有可验证的 missing-asset 出口，而不是空画布。

### 3. 生成结果归档：按批次文件夹 vs 平铺+过滤

**结论：采纳按批次，但修改创建和恢复语义。**

按批次符合现有 `runId` 画廊分组（`lab.svelte.ts:489-515`），在 P0 没有搜索时可浏览，优于把所有结果平铺。`PersistedTaskMeta` 已保存 `runId`，迁移按 runId 建目录的方向成立（`taskStore.ts:27-50`）。

缺口是“开始生成即预建文件夹”与现有持久化生命周期不一致：任务 meta 只在 terminal 状态持久化，启动中途退出或全量取消时没有可恢复的 run 记录（`lab.svelte.ts:521-547`、`:675-722`）。同时当前成功路径只 `putImage(taskId)`，没有 asset node 写入事务（`:629-639`）。

修复：以 `runId` 为幂等键，把 run/folder 状态持久化或改为首个成功结果时懒建并清理空批次；blob 写入、节点写入、任务 `assetId` 更新必须有失败重试/补偿路径。这样采纳“批次文件夹”，而不是采纳当前未闭合的预建叙述。

### 4. 工作台布局方案 A vs B

**结论：采纳 A（舞台+检查器+胶片带+对比模式），修改实现约束。**

源码确实是桌面右列滚动长列、画布固定 `45vh`、对比和导出位在画布之后（`src/lib/components/views/StudioView.svelte:99-112`、`:162-202`），而 `CompareGrid` 同时承载预览模式、参考图、修复开关、桌面卡、移动 carousel 和 zoom dialog（`src/components/Studio/CompareGrid.svelte:71-175`、`:206-417`）。因此 A 对高频“调参→看画布”循环的结构修复成立，B 的常驻小对比列不值得牺牲检查器和画布。

具体拆分风险不是否决 A 的理由，但必须前置冻结：现有 `renderPreview` 依赖组件内 `paintLayer/refImg`、canvas refs、DPR、`ResizeObserver` 和 `renderAll` 闭包（`CompareGrid.svelte:71-175`），仅写“抽 `previewRender.ts`”没有函数签名、图像生命周期和 overlay/A-B 交互状态。现有 zoom dialog 只能证明单画布放大，不证明五栏覆盖层、focus trap、拖拽分屏。要求先抽纯渲染函数并做像素/尺寸基准，再搬状态；A/B 最小形态可先做两栏切换，但必须写入验收标准。

### 5. 删除语义：P0 软删 vs P0 硬删+P1 回收站

**结论：采纳 P0 软删，但修改引用保护和递归语义。**

软删只改节点父指针和 `trashedAt`，能降低误删代价；在没有可逆回收站时直接删除生成图也违背资产层的唯一真源。当前系统却在变体替换和“清空历史”路径硬删 blob（`lab.svelte.ts:299-311`、`:838-847`），因此这是必须显式迁移的行为变更，不是 UI 小改。

必须冻结：删除文件夹是否递归移动全部后代、清空回收站如何递归删除节点与 blob、变体的双图引用如何扫描、正在 EditDocument 中的 reference 如何保护、并发移动/清空是否用同一 IDB transaction。仅“跳过命中引用的资产”不足以保证上述引用集完整。

## B. 阻塞问题

### B-1. `assetId` 到 blob 的解析契约不存在

真实 `getImageBlob(id)` 只接受 `images` 的物理 key（`imageStore.ts:68-75`）；设计的 `assetId` 是 `ast-*` 节点 id，且明确另有 `blobKey`（`add-asset-library/design.md:17-43`）。因此 handoff、选图器和 studio 消费按文档实现会读不到图。

**可验证修复：** 在 assetStore 冻结 `getAsset`, `getAssetBlob`, `objectUrlForAsset`，所有调用先解析 `AssetImage`；为 `external` 单独返回 URL；加入 blob 节点、外链节点、缺失 blob、软删节点四个测试，禁止公开 `blobKey(assetId)` 这种伪映射。

### B-2. 效果参考和案例 preset 是“双图”，新类型只有一个 id

现有 `VariantEffectRef.kind='upload'` 需要 `{src,res}` 两个 key（`lab.svelte.ts:53-61`），preset 也有 `srcImage` 与 `resImage` 两条路径（`effectRefs.ts:31-35`）。新契约却写 `kind:'asset'` + `{assetId}`，迁移只为每个 `effectref-*` key 建节点（`add-asset-library/design.md:63-65、100`），无法表达原图/效果图配对，也无法把一个 preset 的两张外链图映射完整。

**可验证修复：** 改成 `{kind:'asset', assetIds:{src?: AssetNodeId, res: AssetNodeId}}`，或定义不可变 pair 节点；明确 preset 每一张图的节点 id、显示配对和版本 upsert。旧 `uploadKeys` 读取兼容一版，并测试 src 缺省、res 缺失、preset 版本更新和迁移重跑。

### B-3. 刷新后参考原图无法支持承诺的重试链路

当前 lab reference 仅是内存 `PreparedReferenceImage`（`lab.svelte.ts:160-170、263-280`）；`PersistedTaskMeta` 只有 `hasReference` 布尔值，没有 reference asset id（`taskStore.ts:27-50`）。刷新 hydrate 后，edit 任务在 `!hasReference() && !task.effectRef` 时直接失败（`lab.svelte.ts:576-583`）。仅把图片“建节点”不能恢复这个任务输入。

**可验证修复：** 任务 meta 增 `referenceAssetId`，上传/选图时持久化当前引用；hydrate 时解析为 File/Blob 或在重试前按 id 加载，并为缺失资产给出明确失效状态。测试真实刷新序列：上传 reference → terminal task → reset module → hydrate → retry，不能只断言素材库中存在节点。

### B-4. IDB v2、迁移幂等和失败恢复没有可执行边界

源码仍是 DB version 1，只创建 `images`（`imageStore.ts:6-31`）；测试 fake IDB 也只支持一个 object store、没有 version upgrade/index/transaction 语义（`src/tests/lab/helpers/fakeIndexedDB.ts:1-6、86-125`）。设计要求 assetNodes、三 index、异步迁移、失败重跑，却没有定义由谁打开同一个 DB、flag 何时提交、节点和 blob 如何原子/补偿。

**可验证修复：** 抽一个共享 DB opener，明确 `oldVersion→2` 的 upgrade；先完成每个幂等步骤，再仅在全部步骤成功后写 migration flag；失败时保留可重跑状态并记录缺失项。扩展 fake IDB 或使用真实 IndexedDB 测试 upgrade、index 查询、注入中途失败、重跑收敛和旧 v1 数据回读。

### B-5. C-1/C-2 未覆盖真实渲染和删除生命周期

设计任务只列 `types/edit.svelte.ts/buildManualEditHandoff/EditView`（`add-asset-library/tasks.md:41-44`），但真实渲染在 `EditCanvas.svelte` 并读取 `referenceDataUrl`（`:63-80`）；`EditView.svelte` 只挂载 canvas，不消费 reference。`buildManualEditHandoff` 也仍从无 asset id 的 `referenceImage.dataUrl` 构造（`studio.svelte.ts:832-850`）。

**可验证修复：** 将 `referenceAssetId` 从 studio reference 状态一路传到 handoff、EditDocument 和 EditCanvas 的异步 resolver；覆盖加载中、缺失、软删、硬删保护和切换 reference 的清理。更新 edit store、canvas mount 和 lifecycle 测试，不能只改文档字段。

### B-6. `pickAsset(): Promise` 没有组件调用/并发/取消协议

`AssetPickerDialog.svelte` 尚不存在；设计只给出全局形状 `pickAsset(opts): Promise<...>`（`add-asset-library/design.md:80-85`），没有说明 promise 由哪个 controller resolve、调用方如何取消、多个入口并发时谁拥有 modal/focus、组件销毁如何 reject。`redesign-studio-layout` 把此接口当唯一并行依赖（`redesign-studio-layout/design.md:41-56`），但“签名先冻”并不能解决运行时所有权。

**可验证修复：** 采用显式 `AssetPickerController`/context（`open(opts)` + `resolve/cancel`），或组件事件回调接口；定义单实例、销毁、Esc、外部点击、缺失资产和 multi 选择语义。先做 controller 单测，再让 studio context bar/空态和 lab dropzone 使用同一实例。

### B-7. 软删引用集不完整，存在 hard-clear 破坏正在使用资产的路径

设计只把变体 `kind:'asset'` 和内存 studio 引用列为保护，任务 meta 的 assetId 被定义为弱引用；但手动编辑文档将持有 referenceAssetId，且当前代码没有任何 edit 引用登记。清空回收站若按文档实现，可以删除 EditCanvas 仍在显示的原图；同时 `clearHistory` 当前会直接删除任务 blob（`lab.svelte.ts:838-847`）。

**可验证修复：** 选一种可测试的生命周期：维护跨模块 active-reference registry/ref-count，或规定 EditDocument 在硬清空前自动解除/转为 bake fallback；把所有删除和清空走 assetStore transaction，并用“变体引用 + studio 引用 + edit 引用 + task 弱引用”四类测试固定语义。

### B-8. 布局 change 的移动端硬承诺没有现有测试兜底

现有测试断言旧 DOM（`compare-grid`、`strategy-card-*`、`export-bar`），例如 `src/tests/studio/studio-view.mount.test.ts:43-59`、`studio.interactions.test.ts:154-175`；没有 312/375 viewport、真实 CSS overflow 或 focus-trap 验证。当前旧测试全绿不能证明“五区无主滚动”“胶片带停驻不切换”或移动端 Sheet 可用。

**可验证修复：** 迁移 selector 的同时加入真实浏览器测试：312px、375px、桌面最小宽度；断言 computed overflow/可见区域、胶片带 pointer/scroll 不改变 activeStrategy、对比 overlay Esc/focus trap、导出门和 worker 进度。vitest 仅保留状态单测，不能作为移动端承诺的唯一兜底。

### B-9. CompareGrid 拆分缺少可实现的 renderer/state 边界

当前预览函数同时负责 canvas 尺寸、DPR、底图、参考图加载和所有 canvas 重绘（`CompareGrid.svelte:71-175`）。将其拆成 `StrategyFilmStrip`、`CompareOverlay` 和 `previewRender.ts`，但没有冻结 renderer 输入/输出，也没有 overlay 两栏拖分屏与 hover canvas 的资源释放语义。

**可验证修复：** 先定义纯函数签名（输入 `EngineImage/StrategyResult/Palette/Blocks/GridSpec/PreviewMode/size/dpr`，输出绘制到指定 context），把 `Image`/object URL 生命周期留在组件；用同一 fixture 对旧卡、新胶片带、新 overlay 做像素/尺寸基准。A 可以保留，但不能以“组件本体复用”替代这个边界。

## C. 开工判定与评分

### `add-asset-library`

**NO-GO，4.4/10。**

产品边界（素材库唯一真源、blob/节点分离、软删、按批次）是可行的，且当前 IDB/task 基线和迁移目标有清晰事实依据；但 P0 仍有多个未闭合的类型/生命周期契约：asset id 无解析链、双图效果参考无法表示、刷新重试没有 reference id、IDB upgrade/失败恢复没有真实测试能力、C-1/C-2 漏掉真实 `EditCanvas`。这些不是实现顺序上的小缺口，会让上传、handoff、迁移和删除保护在首个端到端路径上失效。修复 B-1~B-7，并先补一个“上传→生成→刷新→选图→送转化→送精修→清理”的最小纵向测试后，才可转 GO。

### `redesign-studio-layout`

**NO-GO，5.8/10。**

方案 A 与源码诊断匹配，现有 BlockPanel/策略单真源/ExportBar 的可复用边界也足以支撑骨架重排；但它依赖尚未实现的选图器运行时协议和 handoff/reference 契约，且 CompareGrid 拆分、A/B overlay、DPR/资源生命周期没有实现级签名。移动端“312px/375px、无主滚动、停驻不误切”的硬承诺当前没有浏览器测试兜底。可先做不接资产的五区骨架，但完整 change 不能在共享契约和 B-6/B-8/B-9 未修复前开工验收。

### 两 change 的并行/依赖关系

设计所述“选图器签名先冻后并行”**只成立一半**。`redesign-studio-layout` 可以先做纯布局骨架和 renderer 抽取，但一旦接入空态 CTA、上下文条更换、`origin:'library'`、reference preview，就依赖 `AssetImage` 解析器、picker controller、handoff v2 和 C-1/C-2；这不只是一个 `pickAsset` 函数签名。C-4 也不是单纯把 `ExportBar` 换名为 `StatusBar`，因为同一入口同时受 `buildManualEditHandoff`、reference asset 生命周期和导出入库影响。

建议顺序：

1. 先冻结 `AssetImage`/双图 effect ref、`getAssetBlob`、picker controller、handoff v2、reference retention 和 IDB v2 upgrade 事务。
2. 实现 assetStore/迁移及 lab reference/task retry，补纵向数据测试。
3. 在稳定 adapter 上并行完成 Studio 五区骨架和 renderer 基准；不要在此阶段复制一套临时 picker。
4. 接入 studio、manual edit、PNG 入库与 C-4，再跑真实浏览器移动端和跨会话走查。

