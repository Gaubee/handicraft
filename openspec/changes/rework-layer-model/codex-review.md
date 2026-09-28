# rework-layer-model v4 独立复核

范围：`add-backend-platform-impl`，逐笔复核 `29f2a37`、`867acbb`、`dc49d59`、`7703264`。四笔连续位于当前 HEAD；复核期间源码工作区保持干净。

## 结论

**NO-GO，7.7/10（v3 终态 8.9）。** 抠图语义、绘制层序与内容寻址缓存的主体实现扎实，但仍有四项影响实际使用或资源上限的 P1；studio 全量测试、daemon 全量测试和严格性能门均未全绿。先完成下列 P1 并取得完整绿门，再进入 Owner 验收。未连接 `8317`/`5200`，也未做真实浏览器或真机视觉验收。

## Spec

1. **P1：紧凑工作台缺少规格要求的关键操作。** [TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:243) 的紧凑摘要只有尺寸、覆盖率、指派信息，并明确把策略直改、钻选择和笔刷编辑引导到完整工作台；[design.md](/Users/kzf/Pictures/贴钻-backend/openspec/changes/rework-layer-model/design.md:36) 要求 `<32rem` 保留策略/重算关键操作。右栏/sheet 内无法完成对应操作，偏离“详情=工作台紧凑形态”。**修复/验收：**紧凑态提供相同策略与重算命令入口；在窄容器测试中实际完成策略更改、重算，并断言与完整态同一 task 状态。

2. **P1：双视图不同 task 会争用模块级工作台状态。** [TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:56) 只在自身 `taskId` 变化时加载；[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:63) 的 task/detail/tree/selection 是模块级单例，`loadWorkbench` 会覆盖同一份状态（252-261）。[App.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/App.svelte:254) 中 Agent 与 Studio 的 Tabs 内容同时挂载：Studio 打开 A、Agent 当前任务为 B 时，嵌入工作台加载 B；切回 Studio，A 的 prop 未变，不会重载，画布与后续编辑实际落在 B。已有的每消费方 canvas 拷贝只解决 DOM canvas 抢占，没有隔离 store。**修复/验收：**按 taskId 隔离 store，或在视图激活时校验当前 store taskId 并装载目标任务；增加 A/B 同时挂载、来回切换、各自选择/修改不串任务的集成测试。

3. **P1：全局快捷键没有活动视图/工作台可见性门。** 每个实例都在 [TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:111) 注册 `window keydown`；[commands.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/commands.ts:178) 仅检查 defaultPrevented、输入焦点、IME 和全局 store ready。Tabs 常驻挂载时，非工作台视图也可能被隐藏工作台截获 `⌘Z`、Delete、F2、Alt+方向等键并派发命令。**修复/验收：**派发前核对当前 ViewId 与工作台实际可见/激活状态；覆盖切到 Lab/Strategy、Agent 详情抽屉关闭、Studio 隐藏等场景，断言不 preventDefault、不调用工作台命令。

4. **P1：不可见图层仍被合成，未落实按需资源约束。** [store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:808) 把完整 `nodes` 传给 `requestCutouts`；[cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:231) 遍历所有非根节点，没有 visibility 输入或祖先过滤。隐藏父层后主画布与命中虽跳过该子树，子层仍可能解码、分配 bbox canvas 并进入合成队列；请求 effect 也未依赖显隐变化。[design.md](/Users/kzf/Pictures/贴钻-backend/openspec/changes/rework-layer-model/design.md:57) 明确要求不可见层不合成。4K RGBA canvas 单张约 64 MiB，96 条数量上限不等于字节上限。**修复/验收：**把可见节点集合及其祖先显隐变化接入请求管线；隐藏子树不得开始新合成，隐藏时取消/释放尚未消费的结果；测量多张 4K 层的峰值 canvas 内存并限制并发/字节预算，覆盖隐藏父层与重新显示。

5. **P2：钻命中在空间桶边界漏报。** [layerRender.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/layerRender.svelte.ts:79) 只按钻心把钻放进一个 64px 桶，`hitTest` 只查指针所在桶（96-103）。可复现：钻心 `(64.1,50)`、半径 `40`，查询 `(32,50)`，距离 32 在半径内但查询桶无该钻，返回 null。缩放/平移屏幕到图像坐标仍正确走 [WorkbenchCanvasStage.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchCanvasStage.svelte:16) 导入的 canvaskit `screenToImage`/`imageToScreen` 单源转换；问题在索引粗筛。**修复/验收：**将钻登记到半径覆盖的所有桶，或查询相邻桶并去重；加跨 X/Y/角点桶边界、重叠钻 z 序测试。

6. **P2：树面钻布局子行未投影祖先显隐。** [WorkbenchLayerPanel.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchLayerPanel.svelte:598) 仅检查折叠态就显示虚拟钻子行；同一行模型的 `row.visible` 已包含自身与祖先显隐。父层隐藏后主画布/命中已隐藏子树，但钻子行仍无状态标记地显示。**修复/验收：**让钻子行继承 hidden 状态（隐藏或明确降显并标注继承隐藏），增加父层显隐后画布、命中、图层面板三面的断言。

7. **P2：容器语义文档与实现不一致。** [design.md](/Users/kzf/Pictures/贴钻-backend/openspec/changes/rework-layer-model/design.md:36) 和 [TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:4) 注释写 `container-type:size`；实现是 Tailwind `@container` 的 inline-size 查询。当前断点只依赖宽度，inline-size 是合理选择；需同步设计与注释，避免后续按高度错误调整。

## Standards

- **P2（仓库规则）：**新增的 [cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:1) 与 [layerRender.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/layerRender.svelte.ts:1) 有模块说明，但没有 `~/.agents/AGENTS.md` 要求的原始需求输入和时间戳。补充简短来源注释，保持后续维护能区分 v4 初始意图与遗留约束。
- **P2（类型边界建议）：**[cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:79) 与 329 有 `as unknown as` 跨过 Canvas 上下文/图像输入类型。改成明确的窄适配接口或经验证的宿主 adapter，避免测试桩与浏览器能力仅靠断言对齐。
- **P3（diff hygiene）：**`git diff --check 29f2a37^..7703264` 在 `openspec/changes/rework-layer-model/tasks.md:24` 报文件末尾多余空行。

## 实现质量

- **通过的核心语义：**合成先裁原图 bbox，再以 mask 中心采样生成 alpha（bit 1→255、0→0），通过 `destination-in` 合成；根 `parent=null` 不做抠图，背景原图独立绘制。缓存键包含 `(baseImageRef, maskRef, bbox)`；运行时 inline mask ref 为 `inline:${treeBlobRef}:${nodeId}`，blob mask ref 为 `blob:${blobRef}`。mask 提交刷新树引用后换键；旧条目不会被错误命中（若内容寻址 ref 回到同值，复用字节相同的内容是安全的）。96 条 LRU 逐出会把对应消费 entry 降为 idle；`WorkbenchLayerItem` 把缓存主 canvas 拷贝到实例自有 canvas，修复双实例争抢同一 DOM 节点的问题。
- 树前序绘制、逆序节点命中及 GemSpatialIndex 的重叠层顺序一致；图层行 `visible` 计算包含祖先显隐；画布坐标仍通过 canvaskit `screenToImage`/`imageToScreen`。numbered 图例移到侧栏未破坏模式模型。demo 映射、Inspector 的 texture-fill 首推与策略 prompt 决策树一致，上衣 straight-line 和卷发 soft-curve 的例外保留。`engine/`、`contracts/`、`canvaskit.ts` 与 `undoDomains.svelte.ts` 在目标提交范围零改动；四域 undo 边界未被改写。
- **性能边界：**strict perf gate 的 `decode.layer.*` 测的是 inline mask 解码，不是浏览器真实 canvas raster；其红项仍是当前验收门结果，不能被口径限制抹去。节点 heap 也不覆盖 GPU/canvas backing store，因此隐藏层合成与多张 4K canvas 必须补真实浏览器内存验收。

## 独立门禁

- Contracts：聚焦 `24/24`、全量 `170/170`、typecheck 通过。
- Daemon：strategy-design 聚焦 `26/26`、typecheck 通过；全量 `857/858`，唯一失败为 sandbox CPU timeout（期望 `output-unserializable`，实得 `cpu-timeout`），隔离单文件复跑 `46/46`。全量门仍记红。
- Studio：v4 + cutout 聚焦 `22/22`；全量 `201` 文件为 `2456 passed / 9 failed / 1 skipped`，9 项均触发 5 秒超时；将 6 个失败文件以 `--maxWorkers=1` 复跑为 `77/77`。这支持并发负载解释，但默认全量命令仍红，未记绿。
- `svelte-check`：`0 errors / 0 warnings`。Production build 通过；bundle 有 1.658 MB JS chunk 警告。
- Strict `perf:gate`：`16/18`。`decode.layer.1K2 = 103.4ms`、`decode.layer.4K2 = 61.0ms`，均超过 `50ms` 门；这两个解码器位于未修改的 contracts 路径，未据此归因 v4 代码回归，但性能门仍未通过，不能降低门值代替修复/复测。
- 性能测试会写入 `add-workbench-pro/perf-receipt-20260927.json`；该文件已恢复为 HEAD 内容。最终 `git status` 干净。真实浏览器/真机验收未执行；本复核没有触碰 Owner 的 daemon/studio 实例。

**放行条件：**修复 Spec P1-1 至 P1-4；补 GemSpatialIndex 桶边界回归；同步 hidden 子行状态和容器文档；性能/测试红门需有明确绿门证据。完成后再做全量测试与隔离的真实浏览器验收。

轴向统计：Spec 轴 7 项（最重 P1：双 task 视图共享单例状态）；Standards 轴 3 项（最重 P2：新核心模块缺少需求/时间戳来源头）。

## 二轮复评：修复轮 f0bfba9 + a2e3928

范围：当前 HEAD `a2e3928ca7f2857d85decd902f0b330834023f28`，复核 v4 修复轮两提交。checkout 工作区干净；本章结论以 HEAD 源码为准，与 Owner 提供的修复轮门禁数字分开记录。

### 结论

**NO-GO，7.5/10（较上一轮 7.7 下降 0.2）。不放行 Owner 真机验收。** F3、F5、F8 的主体修复成立；F1 的紧凑策略操作在真实 daemon 上会因参数缺少必需判别值而失败，当前测试由 mock 放过；F2 的加载门没有给异步写回加任务代次隔离；F4 的隐藏/重显在途竞态可使图层永久停在 idle。三项均需先闭合。另有 F7b 像素级证据和全量门禁本轮无法独立复跑。

### 阻塞项

1. **P1，F1 未闭合：紧凑策略请求缺少真实策略参数。** [TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:179) 的紧凑态固定调用 `applyLayerStrategy(selectedId, compactKind, {}, density)`。完整态 [WorkbenchInspector.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchInspector.svelte:134) 会从 `STRATEGY_FORM_SPECS` 组参数并补 discriminant；daemon 在 [workbench.ts](/Users/kzf/Pictures/贴钻-backend/daemon/src/kernel/workbench.ts:529) 对参数执行族 schema 校验，几何族是必需 `shape` 判别联合、纹理族是必需 `mode` 判别联合。故紧凑态选 `geometry` 或 `texture-fill` 后传 `{}` 会返回 `params-invalid`，并未完成重算。

   新增的 [workbench.v4.test.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/tests/workbench/workbench.v4.test.ts:356) 确实断言了 `geometry + 3.3` 更新本地 assignment，但测试使用 `MockAgentApi`；[mock.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/agentApi/mock.ts:793) 直接保存输入参数，没有 daemon 的策略 schema 校验。因此这是明确的 mock 假阳性。**修复/验收：**紧凑态复用 Inspector 的默认参数序列化（最好两态共用一个纯函数），或只开放能生成有效默认参数的策略；用真实 `LayerStrategySetInput`/daemon 写路径断言参数合法、策略和密度落库且 gems/preview 版本推进。当前测试也没有施加窄容器尺寸，jsdom 不执行 container query；需浏览器中从 `<32rem` 实际触发该操作。

2. **P1，F2 未闭合：共享 store 的异步写回没有任务代次门。** [loadWorkbench](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:257) 的 `loadSeq` 只隔离读取装载结果；[renameLayer](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1003) 在 A 的 RPC 返回后直接改当前全局 `nodes/detail` 并写入 A 的 blobRef，没有检查当前任务/代次。[applyLayerStrategy](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1031) 更在第二次 `taskArtifact` 请求时再次读取可变的全局 `taskId`，之后也会无条件写 `gemsDoc/assignments/detail`。A 操作在切换并装载 B 后返回，可能把 A 的节点或工件引用写进 B 的同一模块单例。

   现有 A/B 用例先等待 A 的 rename 完成，再切视图；没有延迟 A 响应、先装载 B 再放回 A 响应的交错。**修复/验收：**每个异步命令入口捕获 `requestTaskId + loadSeq/epoch`，每次 await 后在写共享状态前校验仍属同一任务；后续 artifact 请求使用捕获的 task id。覆盖 rename、策略重算等延迟响应跨任务切换，断言 B 的 nodes/detail/undo 不变。

3. **P1，F4 未闭合：隐藏期间结束的合成仍进入缓存，快速重显不会接回结果。** [requestCutouts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:318) 收缩请求集时会删掉隐藏节点的 `entries`；但旧异步请求在 [第 371 行](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:371) 无条件 `cachePut`。若该层在完成前重显，新请求于 [第 354 行](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:354) 因同 key 仍在 `inFlight` 而直接跳过，且没有先登记新的 loading entry；旧请求结束时 [第 387 行](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:387) 找不到对应 entry，不会发出响应式更新。此时缓存虽然有位图，当前 entry 仍是 idle，除非无关依赖再次触发请求。

   现有 F4 测试只在合成完全结束后才隐藏/重显，不覆盖在途交错。**修复/验收：**按 key 合并 promise 并维护当前可见订阅者；重显时登记 loading/订阅，完成后只向当前请求集回填；没有可见订阅者的结果不得重新占用缓存。以延迟 `loadImage` 的测试覆盖“开始→隐藏→重显→resolve”，断言只合成一次且重显层变 ready；另测“隐藏→resolve”不复活 entry。

### 分项复核

- **F1 写路径：部分成立。**紧凑态确实调用与 Inspector 相同的 `applyLayerStrategy`；重算/放弃也直接复用 `retryMaskEditNode`/`discardMaskEditNode`。但参数组装不是同源且真实 daemon 拒绝 `{}`；测试只断言 stale 面板按钮存在，没有点击重算/放弃。
- **F2 装载边界：部分成立。**同任务非 idle 跳过、切回归属视图时按 `store.taskId` 重载、同任务保留选择的逻辑合理。例外条件 `getView() !== ownerView && !idle` 仍让无主 idle 状态的非归属实例发起装载；测试 host 每次 `resetViewForTests('studio')`，没有覆盖默认 `agent + idle + 隐藏 studio 实例`。`loadSeq` 使前台后续装载通常能胜出，但这不是严格归属门，仍会产生后台 RPC/短暂全局 loading。建议始终要求归属视图匹配，并让测试宿主显式设置 owner view。
- **F3 快捷键在场门：源码闭合，双路径证据未闭合。**App 的 bits-ui `Tabs.Content` 实际保持挂载，inactive 内容通过 `hidden` 属性隐藏；`presence.svelte.ts` 在浏览器优先用 `checkVisibility`，jsdom 无该 API 时沿祖先 `hidden` 链回退，当前 Tabs 语义两边对应。新增测试验证了 hidden fallback 下 6 键/双实例，但没有覆盖 `checkVisibility` 分支；本轮未跑真浏览器确认该分支，也未验证非 `hidden` 属性实现的 CSS `display:none` 降级场景。该 fallback 只保证当前 Tabs 的 hidden 机制，不是通用 CSS 可见性检测。
- **F4 字节预算：缓存 map 有界，整页 canvas backing store 没有被 512 MiB 计入。**`cutoutBytesOf` 仅按缓存主 canvas 和缩略图 `width*height*4` 累计；[WorkbenchLayerItem.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchLayerItem.svelte:47) 又为每个消费实例建立 bbox 尺寸 canvas 副本，合成期间还创建 mask canvas。Tabs 双实例常驻时副本不属于 LRU 统计。因此 512 MiB 是缓存对象的 RGBA 尺寸估算，不是全页 canvas 内存上限。副本解决缓存 canvas 被两个 DOM 消费方争抢的问题，但没有被预算覆盖。建议指标和注释明确命名为 cache-owned estimate；若要求总内存上限，需纳入消费副本/并发合成预算或复用有界的 canvas surface。
- **F5 根=背景层：通过源码和结构测试。**根行眼睛与画布背景开关读写 `baseVisible`；根缩略直出原图、根不提供选择按钮/不参与命中；`applyViewState` 删除旧 root hidden 值。测试覆盖两开关双向同步与根不选中。
- **F7b 背景图宽度：修复代码方向正确，像素验收未找到。**[WorkbenchLayerStage.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchLayerStage.svelte:98) 给绝对定位背景图加了 `max-w-none`，能解除 Tailwind `img{max-width:100%}` 对 shrink-to-fit world 的约束。但 HEAD 中 workbench 测试只断言 `<img>` 存在/显隐，没有找到 offsetWidth 或像素差异断言；用户提到的“非层区 99% 必变”证据不在当前仓库。本轮未启动浏览器，不能独立确认修复后的真实尺寸/像素。
- **F8 与纹理优先：通过源码及现有测试结构。**GemSpatialIndex 把半径外接方块覆盖到全部桶，再欧氏精测；测试覆盖 X/Y/角点跨桶和重叠 z 序。渲染树前序、层命中逆序，`hiddenDeepIdsOf` 同供渲染/命中/抠图请求；钻虚拟子行读取同一 visible 投影。屏幕坐标仍由 `canvaskit.ts` 的 `screenToImage/imageToScreen` 提供。`inline-size` 对宽度断点合理且文档已同步。Inspector 与紧凑态策略顺序当前同为 texture-fill 首位，但维护两份数组，后续可能漂移；demo 映射与策略 prompt 保持纹理优先和条纹/卷发例外。
- **红线：通过 diff 检查。**目标提交范围没有改 `contracts/`、`rhinestone-studio/src/lib/engine/`、`canvaskit.ts` 或 `undoDomains.svelte.ts`；四域 undo 源码未动。`git diff --check 29f2a37^..HEAD` 通过。
- **来源头仍有 P2 维护缺口。**本轮新加时间/需求来源头已覆盖 `presence.svelte.ts`、`cutout.svelte.ts`、`layerRender.svelte.ts`；`layerTree.ts` 的顶部意图仍只写旧图层管理来源，[TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:1) 与 [WorkbenchCanvasStage.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchCanvasStage.svelte:1) 也没有本轮原始需求/时间戳。

### 独立门禁与环境边界

- 本轮独立执行：`git diff --check 29f2a37^..HEAD` **PASS**；源码、测试覆盖和静态调用链抽验完成。
- 本轮没有运行 contracts/daemon/studio 聚焦或全量测试、typecheck、`svelte-check`、build、`perf:gate`，也没有运行真实浏览器像素/容器走查。检查时 swap 为 `10,944/11,264 MiB`，另有其他 Codex 会话运行；按 `~/.agents/AGENTS.md` 的重负载串行规则，没有追加测试或浏览器进程。不能将 Owner 修复轮自报数字记成本轮独立绿门。
- Owner 提供的修复轮结果单独记录为：contracts `170/170`；daemon `857/858`（sandbox cpu-timeout 单项红、隔离复跑 `46/46`）；studio `2478 passed / 1 skipped`；svelte-check/build 通过；`perf:gate 17/18`（`decode.layer.4K2=79.3ms` 挂账）。这些本轮未独立复跑，严格 perf 门也仍有一项未过。
- 只做了监听端口枚举：`8317` 有 Owner daemon listener，未连接；`5200` 无 listener，未连接；`18860` 空闲，未启动服务。没有改变任何运行中 daemon/studio 状态。

**放行条件：**闭合 F1 参数判别值并以 daemon 验证；为共享 store 的异步写操作增加任务/代次栅栏并通过延迟响应交错测试；修复 F4 在途订阅/重显竞态并明确预算统计口径；补窄容器真实浏览器策略操作和 F7b 背景像素证据；待负载允许后独立重跑聚焦/全量门禁。完成前保持 **NO-GO**。

二轮轴向统计：Spec 阻塞 `3 项 P1`（F1 参数无效、F2 异步写回串任务、F4 在途隐藏重显），另有 `3 项 P2`（idle 归属旁路、缓存预算不含消费画布、F7b 像素证据缺口）；Standards `1 项 P2`（改动文件来源头未全部同步）。相较上一轮，F3/F5/F8 与容器文档闭合，但原 P1-1、P1-2、P1-4 未全部关闭。

## 三轮复评：修复轮二 0a3f129 + c92c970 + 7c1abe5 + b34e886

范围：分支 `add-backend-platform-impl`，当前 `HEAD=b34e88639b1ea69777c35d7fc3ec0cced4150f73`；四笔目标提交均在 HEAD 历史内，工作区干净。逐笔检查提交及其最终源码/测试；没有连接或启动 daemon，没有触碰 `8317`/`5200`。

### 结论

**NO-GO，7.8/10（较二轮 7.5 上升 0.3）。不放行 Owner 验收。** G3 的普通在途隐藏/重显竞态已由订阅合并修复，G1 的判别联合默认值与参数组装在紧凑态/Inspector 间已同源，G4 像素脚本在已有真浏览器帧上独立复跑通过。但全族检查发现 `free-code` 被错误当作可空参数族，紧凑态和 Inspector 都会构造必被 daemon 拒绝的 `{}`；G2 只在 rename/strategy 两个入口加 fence，其余共享 store 写命令仍可在 A→B 切换后把 A 响应写入 B，其中重排/删除还能污染 B 的树引用并使后续 CAS 写失败。两项 P1 未闭合。

### 阻塞项

1. **P1，G1 未覆盖 free-code 的非空输入契约。** `STRATEGY_KIND_ORDER` 当前 7 项无重复且紧凑态与 Inspector 共用；`STRATEGY_FORM_SPECS` 以 `Record<KernelStrategyKind,...>` 覆盖全部七族。texture-fill 缺省产 `{mode:'scatter'}`，geometry 缺省产 `{shape:'star'}`，其余可由 daemon schema 缺省的普通族传 `{}`，这几类与 `strategyDefaultsOf` 的实现一致。[paramsSchema.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/strategyDesigner/paramsSchema.ts:241) 对没有 discriminant 的族一律返回 `{}`，但 free-code 的 [FreeCodeParamsSchema](/Users/kzf/Pictures/贴钻-backend/daemon/src/kernel/strategies/sandbox/free-code.ts:44) 明确要求 `source` 与 `codeArtifactRef` 二选一；工作台 RPC 还会在 [workbench.ts](/Users/kzf/Pictures/贴钻-backend/daemon/src/kernel/workbench.ts:529) 校验参数，并在 [design.ts](/Users/kzf/Pictures/贴钻-backend/daemon/src/kernel/strategies/design.ts:514) 要求 `params.source` 才能持久化工件。紧凑态把 free-code 暴露在策略选择项中，应用时只传 `strategyDefaultsOf(compactKind)`（[TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:180)）；即使原指派已有 source 也会丢弃。Inspector 的 `paramsForApply` 同样以 defaults 为基座且 free-code 无表单字段（[WorkbenchInspector.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchInspector.svelte:142)）。因此新选或重应用 free-code 都不能通过真 daemon 校验。现有回归只覆盖 geometry、texture-fill、soft-curve（[workbench.v4.test.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/tests/workbench/workbench.v4.test.ts:390)），没有把七个 helper 输出逐族送入 daemon schema；这正是“全族覆盖”遗漏。

   **修复建议：**把“可静态默认的族参数”与“需要载荷的 free-code”区分为可判别结果；紧凑态不应允许无 source 的 free-code 直改。已有 free-code 指派可在同族重应用时保留原 source；从别族切入则引导到能提供源码/工件的提案流程。增加七族表单键集、排序唯一性，以及逐族对真实 daemon 参数 schema 的合法性测试；free-code 另测缺载荷必须被 UI 阻止或明确报需提案，不能以 `{}` 假装缺省成功。

2. **P1，G2 仅封住两个入口，共享 store 的其余异步写路径仍有跨任务污染。** fence 本身正确：rename/strategy 捕获 taskId 与 loadSeq，strategy 两次 await 后均检查，artifact 使用捕获的 taskId；对应延迟响应测试覆盖 A 响应晚于 B 装载（[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1012)、[workbench.v4.test.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/tests/workbench/workbench.v4.test.ts:498)）。装载 effect 现在始终要求 ownerView 匹配，同任务跳过逻辑也保留纯放大选中态。

   但同一根因仍存在于其它异步命令。最直接的可复现面是 reorder：A 的 RPC 返回后无条件把 output.treeBlobRef 写入模块级 detail，再调用当时的 taskId 做 refresh（[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1428)）；若此时 B 已装载，`loadWorkbench` 会因 B 的 response ref 仍等于 lastLoadedTreeRef 而采用 treeUnchanged 分支，并复用刚被 A 改过 blobRef 的 prev.tree（[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:295)）。B 随后持有 A 的树基线，下一次 reorder/patch 等 CAS 写会以错误 ref 发出。delete 有相同的“先写 detail、后 refresh”形态；split 则在 A 响应后直接把 A 的 children 追加到当前 nodes（[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:974)）。mask retry/discard、brush patch、tree revert 也在 await 后改共享 maskEdits/detail/selection/brush 状态（例如 [store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:660)、[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1302)、[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1658)），均没有任务/代次校验。

   视图态写入也须纳入：全局 viewWriteChain 排队的 run 在执行时读取可变 `taskId`，响应不验代次便写 `viewRevision`，失败还会用调用时捕获的 previous sets 回滚当前全局状态（[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:490)、[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:502)）。排队中的 A 意图可能在 B 成为当前任务后以 B 的 taskId 执行，并携带 A 捕获的 previewMode；这是服务端持久串任务风险，不只是短暂 toast 错位。

   **修复建议：**对每个异步命令在入口捕获 `{requestTaskId, loadSeq}`，所有 RPC 固定使用 requestTaskId；每个 await 后，在写任一共享字段、selection、undo/history 或错误态前验证。跨任务只丢弃本地回填，同任务代次漂移定向刷新。viewWriteChain 要在入队时绑定 task/epoch；过期队列项不发出，响应和失败回滚也先验 fence。补 A→B 延迟响应覆盖 split/reorder/delete、mask retry/discard、brush patch、tree revert、view-state 成功/失败及 B 下一次 CAS 基线的测试。

### 分项复核

- **G1 同源性：部分成立。**两个 UI 调用 `strategyDefaultsOf`，Inspector 不再单独补 discriminant，紧凑态和 Inspector 共用同一策略序及 applyLayerStrategy 写路径。texture-fill/geometry 的必需判别值修复并有真 daemon 走查方案。但函数注释称“其余字段全 default/optional”不适用于 free-code 的 XOR refinement；提交测试没有覆盖该特殊族，不能给全族闭合结论。
- **G1 真 daemon 证据链：代码链可读，当前仅能确认 Owner 提供的走查记录，未独立执行。**r3 seed 会播种 plan/gems，verify 直接读 daemon DB/frames 与 blob，C1-C4 检查 kind/shape/density/钻继承，链路设计方向正确。证据脚本仍有两个宽松点：[walkthrough-v4-r3-verify.ts](/Users/kzf/Pictures/贴钻-backend/daemon/scripts/walkthrough-v4-r3-verify.ts:38) 未传 seedPlanRef 时 C5 自动通过；C6 只要求 gems 数量大于零，而 tasks 声称 68 颗；脚本还选“最新 done task”而不是强制目标 task。因此可运行脚本不足以单独证明完整 6/6 与本次任务关联。建议要求 taskId、seedPlanRef 为必填参数，验证同一 task 的新旧 planRef 及预期/下界 count。
- **G3 订阅集快速级联：状态转移本身闭合。**初次请求把 nodeId 加入在途 flight；隐藏时请求集收缩会移除订阅；重显同 key 会重新订阅并登记 loading；再隐藏移除订阅；resolve 时 subscribers 为空，故不 cache、不回填、不复活 entry（[cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:350)、[cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:386)、[cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:428)）。现有 G3 测试分别覆盖一次隐藏后重显与隐藏后 resolve，没有直接覆盖“隐藏→重显→再隐藏→resolve”，建议补用例锁定这条转移。
- **G3 尚存 P2：订阅身份只含 nodeId，不含当前期望 key。**requestCutouts 用 liveIds 按 id 修剪所有 flight；同一可见节点若 maskRef/bbox/baseImageRef 在旧合成未完成时变化，旧 flight 的 nodeId 仍在 liveIds 中，即使当前 entry 已指向新 key，旧 flight 仍因 subscribers 非空而 cachePut 旧画布。之后 entry.key 检查会阻止旧结果回填 UI，但无当前消费者的旧结果仍占字节预算并可能逐出有效项。[cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:95) 的 Set 应表达 `{nodeId, expectedKey}` 或按当前可见节点重算各 flight 的有效订阅者；至少在 cachePut 前过滤当前 key。加同 ID 换 maskRef/bbox 的延迟完成用例。
- **字节预算口径：命名诚实且估算边界明确。**`CUTOUT_CACHE_OWNED_BYTES_MAX` 按主 canvas 与 thumbnail 的 width×height×4 计数；注释明确排除消费 canvas 副本、合成临时面和 GPU backing store（[cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:50)）。LRU 逐出会降级仍引用被逐出 canvas 的 entry。它不是全页内存上限，但名称和说明没有误报。
- **F3：源实现与两种浏览器可见性语义合理。**有 checkVisibility 时检测 CSS/UA visibility，缺失时遍历 hidden 属性祖先链（[presence.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/presence.svelte.ts:23)）。降级分支只等价覆盖 bits-ui 当前使用的 hidden 属性，不是通用 display:none 检测；真浏览器 CSS display:none 双分支证据来自 Owner 记录，本轮没有启动浏览器重测。
- **G4/F7b：独立像素帧复跑 PASS。**使用入库 [pixel-diff-f7b.ts](/Users/kzf/Pictures/贴钻-backend/experiments/layer-model-v4/pixel-diff-f7b.ts:97) 读取 `/tmp/walk-v4-r2` 的现存截图：画布外变化 `0.0%`、画布内非层变化 `99.0%`、帽子红 `42.6%`、脸肤 `79.7%`，均通过阈值。这是对已有帧的独立计算复跑，不是本轮重新浏览器截图。`max-w-none` 修复存在，像素断言能抓背景缺失且实体层保留。
- **F5-F8 抽验：**根行眼睛仍只驱动 baseVisible，根不进命中；hiddenDeepIdsOf 仍单源供画布/命中/抠图请求；GemSpatialIndex 按钻半径覆盖登记桶并做欧氏精测；钻虚拟子行继承隐藏标记；inline-size 文档与代码一致。`engine/`、`contracts/`、canvaskit 坐标单源、undo domain 文件在本轮四笔 diff 中均零改动；`git diff --check 29f2a37^..HEAD` PASS。

### 独立门禁与环境边界

- 本轮独立执行：目标提交逐笔 diff/源码/测试抽查；`git diff --check 29f2a37^..HEAD` **PASS**；`nub experiments/layer-model-v4/pixel-diff-f7b.ts /tmp/walk-v4-r2` **PASS**（99.0%/0.0%/42.6%/79.7%）。工作区检查保持干净。
- 本轮没有独立运行 contracts/daemon/studio 测试、typecheck、svelte-check、build、perf:gate，也没有启动真 daemon/浏览器：复核时 swap 为 `8644/10240 MiB`，仍有其他 Codex 会话/受控任务进程，按重负载纪律没有并发加压。Owner 自报 contracts `170/170`、daemon `858/858`、studio `2483 passed / 1 skipped`、typecheck/svelte-check/build/diff-check 通过，均记为**未独立复验**；`decode.layer.4K2` 仍按 Owner 提供信息记为既有挂账。只枚举过监听：`8317` 有 Owner listener，`5200` 与 `18880` 当时无监听；没有连接这些端口或启动服务。

**放行条件：**修正/限制 free-code 无载荷直改并补全七族真源合法性回归；对所有异步 store 写命令加 task/epoch fence，尤其验证 reorder/delete 的树引用 refresh 交错和视图态队列；补 G3 双隐藏级联与 key 漂移订阅测试。待机器负载允许后独立重跑指定聚焦/全量绿门、类型检查、构建和 perf gate，再进入 Owner 验收。

三轮轴向统计：Spec/运行正确性 `2 项 P1`（G1 free-code 载荷无效；G2 未受 fence 的异步写路径），`2 项 P2`（G3 nodeId-only stale cache；daemon walkthrough verifier 的版本/数量断言可跳过）；G3 核心隐藏/重显竞态、F7b 像素回归及 F5-F8 抽验通过。综合分相对二轮 **7.5 → 7.8（+0.3）**，验收结论 **NO-GO**。

## 四轮终评：修复轮三 0fe3f57 + d73379d + 7a81b0b + bae1881 + d2fa001

范围：当前 checkout `add-backend-platform-impl`，`HEAD=d2fa001004ce47a5e26144d6fc020d550d65fc31`，五笔目标提交均在历史内，工作区干净。本轮只复核 H1-H4 及其指定抽验；未连接/修改 `8317`、`5200`。

### 结论

**NO-GO，8.3/10（较三轮 7.8 上升 0.5）。不放行 Owner 验收。** H1 的 free-code 判别面、H3 的 key 漂移过滤、H4 的 verifier 旁路封堵均已由源码和聚焦回归证明；H2 的 split/reorder/delete/tree-revert-confirm/mask retry/discard/brush/view-state 主体栅栏已补齐，8 个 A→B 交错用例通过。但 H2 的“全部入口同式栅栏”仍未完全兑现：`requestTreeRevert` 在等待历史读取后无归属/代次复核，可能把 A 的确认面放进 B；`exportTask` 只校验 taskId，异常面和同任务重装载没有 epoch fence，也没有对应交错测试；`loadWorkbench` 换任务时还保留 `pendingDelete`/`pendingTreeRevert`，A 的确认面可直接留在 B 并以 B 的 taskId 执行。上述均属于本轮明确点名的共享异步命令/确认面，故保持 NO-GO。

### 阻塞项

1. **P1，H2 回退发起阶段仍可跨任务污染确认面。** [store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1734) 的 `requestTreeRevert` 在 `!structureSeeded` 时 `await fetchTreeHistory()`，之后直接用当前模块级 `treeHistory` 写入 `pendingTreeRevert`（1737-1740），没有捕获 `{requestTaskId, loadSeq}`，也没有在 await 后校验。A 发起回退、历史请求在途时切到 B，`loadWorkbench(B)` 会重置历史/代次；A 的历史响应虽由 `fetchTreeHistory` 自身丢弃，但 `requestTreeRevert` 仍会继续在 B 上创建确认面，目标版本来自 A 的调用。用户随后确认可能对 B 发起错误版本回退。现有 H2 8 例只覆盖 `confirmTreeRevert` 的延迟响应，不覆盖这个发起阶段窗口。

   **可验证修复：**在 `requestTreeRevert` 入口捕获 task/epoch；`await fetchTreeHistory()` 后先验 fence，失守即放弃且不写 `pendingTreeRevert`。任务切换（`loadWorkbench` 非 refresh）时清空所有属于旧任务的 `pendingDelete`/`pendingTreeRevert`，或给确认对象附 task/epoch 并在确认入口校验。增加 A 发起回退→切 B→历史响应迟到、以及 A 仅打开删除/回退确认面→切 B 的交错测试，断言 B 的确认面为空、B 的 tree history 不变且不能发出 B 的错误版本/node 写。

2. **P1，`exportTask` 未达到 H2 声明的完整栅栏契约。** [store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:749) 只捕获 `requestTaskId`（755），RPC 返回后只比较 `requestTaskId !== taskId`（760），没有 `loadSeq`/epoch；若同一 task 在导出期间重新装载，迟到产物仍可下载/提示。更直接的是 catch 始终写模块级 `exportError`（780），没有先验当前 task/epoch，A 的失败可把错误显示到 B。H2 测试的 `GatedMethod`（[workbench.v4.test.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/tests/workbench/workbench.v4.test.ts:827)）没有 `exportTask`，因此“全部入口”没有回归证据。

   **可验证修复：**导出入口捕获 `{requestTaskId, epoch}`；成功下载、错误写入、toast 和 finally 收尾均先过 fence；过期结果静默丢弃。增加 A→B 延迟成功/失败两例，断言 B 的 `exportError`、toast、下载均不被 A 触发。

### H1：free-code 判别面与七族真源

**闭合。** [paramsSchema.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/strategyDesigner/paramsSchema.ts:223) 的 `STRATEGY_KIND_ORDER` 为七族唯一序，`STRATEGY_FORM_SPECS` 是 `Record<KernelStrategyKind,...>`；`strategyDefaultsOf` 在 260-264 对 `free-code` 返回 `{status:'requires-payload'}`，其余六族返回静态参数，`texture-fill`/`geometry` 分别带 `mode`/`shape` 判别值。紧凑态 [TaskWorkbenchView.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte:181) 别族切入 free-code 时按钮禁用并显示同源提示，同族重应用在 193-196 深拷贝原载荷后仍走 `applyLayerStrategy`；Inspector [WorkbenchInspector.svelte](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/WorkbenchInspector.svelte:160) 同语义，无第二写路径。

daemon [workbench.v4-strategy-defaults.test.ts](/Users/kzf/Pictures/贴钻-backend/daemon/tests/workbench.v4-strategy-defaults.test.ts:26) 检查七族无重复、表单键集一致；六族逐族将 helper 输出送入 `STRATEGY_REGISTRY` 的真实 `paramsSchema`，free-code 空对象和 source/codeArtifactRef 同时存在均拒绝，原 source 载荷通过。studio H1 三例覆盖阻止、同族载荷保留和 Inspector 双面；本轮独立运行 `35/35`，daemon 七族测试 `4/4`。真 daemon/Chrome 8/8 属 Owner 提供证据，本轮未在低 swap 环境重启实例，故仍按供给证据记录。

### H2：栅栏覆盖盘点

| 入口 | 源码结论 | 本轮交错证据 |
| --- | --- | --- |
| `splitLayer` | 捕获 task/epoch，响应与异常前校验 | 有，B nodes 不被 A 子层污染 |
| `reorderLayerNode` | 捕获 task/epoch，tree ref 写入和 refresh 前后校验 | 有，B CAS 基线后续写验证 |
| `confirmDeleteLayer` | 捕获 task/epoch，迟到响应清确认面并丢弃；但换任务前仅打开的 `pendingDelete` 不会自动清理 | 有，B nodes/确认面不变；无“仅打开确认面后切 B”例 |
| `confirmTreeRevert` | 捕获 task/epoch，响应与 refresh 收尾校验；但换任务前仅打开的 `pendingTreeRevert` 不会自动清理 | 有，B nodes/确认面不变；无“仅打开确认面后切 B”例 |
| `retryMaskEditNode` / `discardMaskEditNode` | RPC 后校验，refresh 使用捕获 task | retry 有；discard 未单独交错 |
| `commitBrushStrokes` + `waitForMaskEditSettled` | RPC、轮询 task id、刷新后均有主校验 | 有，B maskEdits/tree ref 不污染 |
| `viewWriteChain` | 入队绑定 task/epoch；发送、响应、失败回滚先校验 | 有，成功/失败各一例 |
| `exportTask` | 仅 taskId，缺 epoch，catch 无校验 | 无，见阻塞项 2 |
| `requestTreeRevert` | `await fetchTreeHistory` 后无 fence | 无，见阻塞项 1 |

其余主体路径的实现与三轮要求一致：`applyLayerStrategy` 的两次 await 都用捕获 task/epoch，后续 artifact 不读可变全局；`loadWorkbench` 自身仍以 `loadSeq` 丢弃陈旧装载。但 `loadWorkbench` 换任务只重置 `treeHistory` 等读面，没有重置 `pendingDelete`/`pendingTreeRevert`，所以确认态本身仍跨任务存活；这不是迟到响应问题，而是共享 store 的任务归属缺失。另有各命令 `finally` 对模块级 busy 标志无 fence（[store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1045) 等），当前 busy 单飞门使其主要表现为旧命令结束后解除阻塞，尚未形成 B 数据写入；建议与上述修复一并使收尾状态只由同一 command owner 清理。

### H3：在途订阅 key 漂移

**闭合。** [cutout.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/cutout.svelte.ts:432) 完成判定改为 `entries.get(subscriber)?.key === key` 的 `consumers` 集；只有仍有当前 key 消费者时才 `cachePut`，旧 key 结果不会回填、占预算或逐出 keeper。请求集仍按可见节点收缩，隐藏父层不会启动抠图；重显同 key 会合并既有 flight 并登记 loading。新增测试覆盖同 ID 换 maskRef 的延迟完成、小预算 keeper 保护，以及“隐藏→重显→再隐藏→resolve”级联；本轮独立 `workbench.cutout.test.ts 18/18` 通过。缓存预算命名 `CUTOUT_CACHE_OWNED_BYTES_MAX` 与注释仍准确限定为缓存自有 RGBA 尺寸估算，不宣称全页 canvas 上限。

### H4：verifier 旁路封堵

**闭合。** [walkthrough-v4-r3-verify.ts](/Users/kzf/Pictures/贴钻-backend/daemon/scripts/walkthrough-v4-r3-verify.ts:20) 要求 `taskId` 与 `seedPlanRef`，缺参 exit 2；查询必须是目标 task，不再挑最新 done task（37-40）；C5a 要求 seed ref 出现在目标 task 的 plan 帧历史，C5b 要求 gems planRef 与 seed 不同，C6 改为 count 下界（默认 68）。脚本显式输出 C0-C6 结果，错误 seed、不存在 task、无参路径均拒绝。独立运行无参路径得到 exit 2/usage；四路径全量实证为 Owner 提供的隔离记录，本轮未启动 daemon。

### 抽验与红线

- F5-F8 抽验保持通过：根行是背景层且不进命中；`hiddenDeepIdsOf` 同源供渲染/命中/抠图请求；GemSpatialIndex 半径覆盖桶后欧氏精测；钻子行继承祖先隐藏；inline-size 文档与代码一致。
- `engine/`、`contracts/`、canvaskit 坐标单源和 undo 四域在目标范围零改动；`git diff --check 29f2a37^..HEAD` **PASS**。
- F7b 像素断言与真浏览器/Chrome 结果本轮没有重新采集；已核对脚本入库和前轮像素证据，不把既有截图复跑当成本轮浏览器验收。

### 独立门禁与环境边界

- 本轮独立通过：`rhinestone-studio` `workbench.v4.test.ts` **35/35**；`workbench.cutout.test.ts` **18/18**；daemon `workbench.v4-strategy-defaults.test.ts` **4/4**；verifier 无参用法 **exit 2**；`git diff --check` **PASS**。
- 本轮未运行 contracts/daemon/studio 全量测试、typecheck、svelte-check、build、perf:gate，也未启动 daemon/Chrome：操作前 `vm.swapusage` 为 `used=8937.81M/free=1302.19M`，且存在其他 Codex/Herdr 任务。按仓库重负载纪律未叠加构建或全量测试；未触碰 `8317`/`5200`，未启用 `18880`。
- Owner 自报门禁单独记录为：contracts `170/170`；daemon `862/862`；studio `2496 passed/1 skipped`；typecheck/svelte-check `0/0`；build；diff-check PASS；这些数字本轮未独立复验。`decode.layer.4K2` 既有挂账继续保留。

### 放行条件与评分

补齐 `requestTreeRevert` 发起阶段和 `exportTask` 的 task/epoch fence、成功/失败交错回归，并在机器负载允许时独立重跑 contracts/daemon/studio 全量、typecheck、svelte-check、build 与 perf gate 后再验收。H1/H3/H4 已具备生产级证据，H2 仍有明确可复现的跨任务窗口。

综合评分 **8.3/10（7.8 → 8.3，+0.5）**。实现质量从三轮的两项 P1 未闭合提升到一项 P1（H2 残余）未闭合、H3/H4 P2 已闭合；**Owner 验收：NO-GO，不放行**。

## 五轮终评：修复轮四 6007380（MainAgent 亲修）

范围：当前 checkout `add-backend-platform-impl`，`HEAD=60073809366dcd4a987d6a1b28ed91e2f1bdac71`。本轮逐笔检查 `6007380` 的 store/test diff，并复核四个新增交错用例；未连接或修改 `8317`、`5200`。工作区另有既存的 `openspec/changes/add-workbench-pro/perf-receipt-20260927.json` 生成物修改，本轮未触碰或回退。

### 结论

**NO-GO，8.6/10（较四轮 8.3 上升 0.3）。运行时代码的两项 P1 已闭合，但回归证据仍有两个实质窗口未被真实锁定，不放行 Owner 验收。** `requestTreeRevert` 的入口 task/epoch 捕获、历史 await 后校验、`exportTask` 的成功/失败双面栅栏以及换任务确认面清理，源码位置和顺序均正确；然而新增历史交错用例实际命中了初始化历史预取的 `loading` 快速返回，未把 `requestTreeRevert` 自己的历史 await 挂住，且确认面清理用例没有建立 `pendingDelete`。同任务导出用例也没有断言 toast/download 未发生。

### P1 逐项复核

1. **`requestTreeRevert`：运行时闭合，窗口测试不充分。** [store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1744) 先捕获 `requestTaskId/loadSeq`，在历史读取之后于 1751 行检查；任务切换会推进二者，A 的 continuation 不会写 B 的 `pendingTreeRevert`。该时点能封住四轮指出的窗口。

   但新增用例 [workbench.v4.test.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/tests/workbench/workbench.v4.test.ts:984) 先调用 `mountA()`；`loadWorkbench` 在进入 `ready` 前已经 `void fetchTreeHistory()`，而 `gatedApi('treeHistory')` 将其挂起。随后 `requestTreeRevert()` 看到 `treeHistory.loading=true`，`fetchTreeHistory()` 只设置 `historyPending` 并立即返回，故它的 `await` 不会跨越 gate。测试中 `pendingTreeRevert` 先在 A 写入，切 B 后由 319-327 行清掉；即使移除 1751 行 fence，该测试仍可能通过。应让 gate 只阻塞第二次历史请求，或先完成初始化预取后通过结构写使 `structureSeeded=false`，再发起被 gate 的历史读取，并断言切 B 前 `requestPromise` 尚未完成、放行后确认面仍为空。

2. **`exportTask`：运行时闭合，失败交错有效，成功面断言不足。** [store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:759) 捕获 `requestSeq`；成功路径在下载和 toast 前检查 task+epoch（767），catch 仅在同 task 同代次写 `exportError`（788-790）。失败迟到用例确实跨任务挂起并验证 B 的错误面不变；同任务代次用例只断言 `exportError=null`，没有检查 toast 列表或 anchor/download 调用，因此旧实现即使错误 toast 仍可能通过。应快照 `getToasts()`，并 stub `URL.createObjectURL` 与 anchor `click`，放行后断言二者均未新增。

3. **换任务确认面清理：源码闭合，`pendingDelete` 测试断言是空值旁路。** `loadWorkbench` 非 refresh 在 319-327 行清空 `pendingDelete` 与 `pendingTreeRevert`。新增用例只调用 `requestTreeRevert(1)`，从未调用 `requestDeleteLayer`，所以 `expect(getPendingDelete()).toBeNull()` 没有验证 A 的删除确认面。应在切换前建立并断言 `requestDeleteLayer('n-hat')` 的 pending 状态，再验证 B 清空。

### H2 覆盖盘点

| 窗口 | 运行时判断 | 新增证据 |
| --- | --- | --- |
| 回退发起阶段：历史 await 后切任务 | 已闭合，task+epoch 校验在确认面写入前 | **不足**：被初始化 `treeHistory.loading` 快速返回截短 |
| 导出跨任务失败 | 已闭合，catch 先验 task+epoch | **有效**：失败 gate 后 B `exportError` 保持空 |
| 导出同任务代次漂移 | 已闭合，成功面在下载/toast 前丢弃 | **部分**：未断言 toast/download |
| 换任务确认面 | 已闭合，非 refresh 清两个 pending | **部分**：只真实建立回退确认，删除断言为空值 |

四轮原有 split/reorder/delete confirm/tree-revert confirm/mask retry/discard/brush/view-state 的 8 个交错用例未被回退；其余栅栏调用链保持不变。

### 抽验、门禁与环境边界

- `6007380` 的提交 diff 与目标范围 `git diff --check 29f2a37^..6007380` 通过；`engine/`、`contracts/`、canvaskit 坐标单源和 undo 域仍未改动。
- Owner 自报 `workbench.v4` 聚焦 **39/39**、studio 全量 **2500 passed / 1 skipped**、`svelte-check 0/0`、build 通过；本轮未独立重跑这些命令。
- 当前 `vm.swapusage` 为 `used=10067/11264 MiB`、free 约 `1197 MiB`，且存在其他 Codex/受控任务进程；按重负载纪律未追加全量测试、typecheck、svelte-check、build、perf 或真 daemon/Chrome。未触碰 `8317`、`5200`，未启动 `18880`。

### 放行条件与评分

先补三类回归证据：真正被 gate 挂住的 `requestTreeRevert` 发起阶段、真实建立的 `pendingDelete` 换任务清理、同任务导出代次漂移的 toast/download 负断言；随后在资源允许时独立重跑聚焦及全量门禁。

综合评分 **8.6/10（8.3 → 8.6，+0.3）**。两项 P1 的生产代码修复成立，残留为验收证据质量问题；**Owner 验收：NO-GO，不放行**。

## 终评：测试窗口收紧 0124672

范围：当前 checkout `add-backend-platform-impl`，`HEAD=0124672d3661b5479b76c13e0ba495fb6d682db5`。本轮提交只修改 `rhinestone-studio/src/tests/workbench/workbench.v4.test.ts`（39 行变更）；`6007380` 中的生产修复未被回退。工作区另有既存的 `openspec/changes/add-workbench-pro/perf-receipt-20260927.json` 修改，本轮未触碰。

### 结论

**GO，9.1/10（8.6 → 9.1，+0.5），放行 Owner 验收。** 五轮指出的三个测试证据窗口已被实际收紧；没有发现新的 P1 阻塞。生产栅栏、确认面清理和测试时序现在形成可验证闭环。

### 三窗口复核

1. **`requestTreeRevert` 发起阶段：已锁定。** 新测试不再用一个 gate 同时拦截初始化预取和命令读取，而是让第一次 `treeHistory` 调用正常完成；`mountA()` 后调用 `renameLayer`，其 `noteStructureWrite()` 将 `structureSeeded` 置回 `false`，且历史面未打开，不会产生额外拉取。`requestTreeRevert(1)` 因而必然发起第二次历史读取，wrapper 只在第二次调用后等待 `secondGate`。测试先等待 `switchToB()` 完成，再释放 gate；这使 `requestTreeRevert` 的 `await fetchTreeHistory()` 确实跨过 A→B 切换。源码 [store.svelte.ts](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1744) 在 await 后以 `taskId + loadSeq` 校验，缺少该校验时会在 B 建立 A 的 `pendingTreeRevert`，现有断言会失败。该用例已从“换任务清理兜底”变为“发起阶段栅栏拦截”语义。

2. **确认面清理：已锁定。** 测试在切换前真实调用 `requestTreeRevert(1)` 和 `requestDeleteLayer('n-hat')`，并先断言两个 pending 面均非空；切换到 B 后分别断言均为空。对应 [loadWorkbench](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:319) 的非 refresh 分支清理 `pendingDelete` 与 `pendingTreeRevert`，不再存在通过“原本就是 null”得到绿灯的旁路。

3. **导出同任务代次：已锁定。** 测试在 B 发起 `exportTask()`，用 `loadWorkbench(B, { refresh: true })` 推进 `loadSeq`，清空 toast 后才释放迟到成功响应，并断言没有“已导出” toast。生产代码 [exportTask](/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:759) 在 `createObjectURL`/anchor 下载和 `showToast` 之前共用同一 `taskId + loadSeq` 检查，因此迟到产物不会落 UI 面或触发提示；失败面另有同一栅栏，跨任务交错用例继续覆盖 `exportError` 不写入 B。测试没有单独 spy 下载 anchor，但下载和 toast 位于同一成功栅栏之后，未形成运行时缺口。

### 轻量独立核对与门禁来源

- 独立通过：`git diff --check 6007380..0124672`；提交文件范围确认只含上述测试文件。
- 本轮未运行 studio/daemon/contracts 全量、typecheck、svelte-check、build 或真实 daemon/Chrome。检查时 swap 为 `used=10003.31M/free=1260.69M`，且有其他受控任务进程；按资源纪律没有叠加重负载命令，也未触碰 `8317`、`5200`。
- Owner 提供的最终收据记录为：v4 聚焦 `39/39`；studio 全量 `2500 passed / 1 skipped`；`svelte-check 0/0`；build 通过。上述数字作为提交方收据记录，不冒充本轮独立重跑结果。
- `engine/`、`contracts/`、canvaskit 单源、undo 四域和 daemon 生产代码均未被本轮测试提交改动；既有 `decode.layer.4K2` perf 挂账不影响本轮三个窗口的闭合判断。

### 最终裁定

三处测试窗口均已具备反事实失败能力：移除回退发起阶段 fence 会在 gate 释放后把 A 目标版本写入 B；移除确认面清理会使切换后的两个 pending 断言失败；移除导出代次 fence 会产生“已导出” toast。结合 `6007380` 的运行时代码修复与 Owner 提供的聚焦/全量收据，**放行 Owner 验收**。
