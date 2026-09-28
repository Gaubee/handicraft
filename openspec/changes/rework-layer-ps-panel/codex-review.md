# rework-layer-ps-panel v5 实现复核

## 结论

**NEEDS-WORK；7.8/10；暂不放行 Owner 第五轮真机验收。**

四个提交的父层恒不产钻、掩膜 blob 引用隔离和 PS 面板主体实现基本成立，红线范围也保持干净。阻塞点是服务端 `task.export` 仍把最新 `strategy-gems.json` 原始字节和原始颗数直接交付，旧 v4 工件因此可能出现“界面 699、下载 858”的跨面不一致。capability 的 BOM/SVG/PNG 使用独立 `LayoutDocument`，当前代码不能证明它与 workbench 树同源；该资源边界和回归需要补齐后，才可宣称所有导出面统一服从 v5 叶子语义。

## 复核范围与证据

- 工作区：`/Users/kzf/Pictures/贴钻-backend`，分支 `add-backend-platform-impl`，工作树干净。
- 逐笔检查：`0240441`、`6097165`、`c950cf2`、`286f135`；`HEAD=286f135`，提交范围无越界文件。
- 本轮独立重跑：daemon 聚焦测试 5 文件 `105/105`；contracts `workbench-pro` `13/13`；Studio `workbench.v5` `5/5`。Studio 测试只有 jsdom 未安装 `canvas` 的 `getContext()` warning，未导致失败。
- 前序本地证据（本轮未重复）：daemon/contracts typecheck、Studio `svelte-check`、Studio build 已通过。
- Owner 提供的真机回执单独视为 supplied receipt：真识别 `699=858-159`、走查 `18/18`、缩略图 `14/14`、daemon `865/865`、contracts `170/170`、studio `2506` 全绿；这些不替代本地源代码和聚焦测试复核。
- `git diff --check 0240441^..286f135` 通过；四提交未触及 `engine/`、`canvaskit`、`undo`。

## 阻塞清单

### P1：`task.export` 未按当前树叶子过滤旧父层钻

证据：

- `daemon/src/rpc.ts:1517-1542` 读取最新 `strategy-gems.json`，解析后直接返回原始 `bytes` 和 `doc.gems.length`。
- `daemon/src/rpc.ts:1171-1193` 的 `task.detail` 同样把原始 gems 数量放入响应；前端顶栏虽然在 `rhinestone-studio/src/lib/components/studio/taskWorkbench/store.svelte.ts:1052-1060` 用当前树叶子集合重新计数，导出端没有这层治理。
- 现有导出回归 `daemon/tests/workbench-pro.test.ts:888-940` 只种植 `n-hat` 叶子钻，没有“组旧钻 + 叶子钻”的负向样本，因此无法发现该不一致。

影响：存量 v4 工件中父层旧钻仍会进入下载 JSON 和 `gemCount`，而画布、fx 徽标和顶栏按叶子过滤，导出产物可能比 UI 多出父层钻。

可验证修复：抽出单一 `effectiveGems(tree, gems)`（叶子集合为 `children.length === 0`），由 `task.detail`、`task.export` 和所有 workbench 读数共同消费。`task.export` 应加载当前 `object-tree.json`，生成过滤后的新 JSON 字节，返回与新字节匹配的 `blobRef` 和过滤后 `gemCount`；mock `taskExport` 同步该行为。补一条含父层旧钻的 RPC 回归，断言导出 JSON、数量和 UI 口径均只保留叶子。

### P1 相关闭合项：capability BOM/SVG/PNG 的资源边界未与 v5 语义对齐

证据：

- `daemon/src/capability/layout-doc.ts:51-67` 的 `LayoutDocument` 只有 `blocks`、`gems` 等平面字段，不携带 workbench `ObjectTree` 的 `parent/children` 关系。
- `daemon/src/capability/studio.ts:475-487,968-1001` 直接把 `resource.doc.gems` 交给 `buildBom`、`buildSvg`、`renderGemsPng`，并按原数组计数。

这条目前不能直接定性为已泄漏：capability 读的是独立 layout resource，代码中没有证据证明它承载本批 workbench v4 工件。但如果产品要求 capability 导出也代表同一 workbench 数据，当前没有树过滤入口和父层旧钻回归，闭合不成立。

可验证修复：二选一并写入契约与测试：

1. 明确 capability layout 与 workbench task 导出是两个资源域，补跨域正/负测试，证明 `task.export` 是 v5 树语义的唯一任务导出入口；或
2. 给 layout resource 携带树引用/叶子有效集，在 BOM/SVG/PNG 前统一过滤，并补含父层旧钻的三路径回归。

## 已确认通过的实现面

### 产钻语义覆盖

- `daemon/src/kernel/strategies/design.ts:352-358` 与 `daemon/src/kernel/vision/tree-to-blocks.ts:243-255` 均改为 `children.length === 0`；未发现第三处仍以 `children.length === 0 || drillWorthy` 判定产块的生产路径。
- `daemon/src/kernel/workbench.ts:511-521,573-584,1122-1131` 对组 typed 拒 `node-not-leaf`，当前 plan 收敛为叶子集，execute 遇父层旧指派跳过并写 degraded warning。
- `contracts/src/workbench.ts:456-479` 与 `contracts/src/workbench-pro.test.ts:291-300` 冻结九值错误码，Studio mock `rhinestone-studio/src/lib/agentApi/mock.ts:770-773` 同构拒绝。
- `segment-loop`、`segment-one`、`segment-tool` 和 `exclusion` 中剩余的 `drillWorthy` 是分割优先级/排除建议语义，没有发现第三个实际产块谓词；这不替代导出过滤。

### `tasks.artifact` 掩膜引用扩展

- `daemon/src/rpc.ts:350-362` 先做任务 owner/admin 校验；`JobService.frames` 在 `daemon/src/jobs/service.ts:208-212` 再次校验任务归属。
- `daemon/src/rpc.ts:385-410` 仅在当前任务的最新 `object-tree.json` 中命中 `mask.kind === 'blob' && mask.blobRef === input.blobRef` 时放行；树缺席、损坏或 hash 不命中均维持拒绝。
- `daemon/tests/rpc.test.ts:450-509` 覆盖 blob mask 字节保真和非树 hash 拒绝，附件跨任务隔离也有回归。inline mask 仍嵌在树工件中，不经过 blob 直取路径；本次改动没有改变 inline 解码语义。
- 未观察到任意 owner 枚举他人 blob 的路径：任务 owner、帧引用集、会话附件集和当前树引用集均有边界。

### PS 面板主体和顺序

- `store.svelte.ts:383-405` 为树前序逆序，面板首行对应渲染最上层，根背景落最底。
- `store.svelte.ts:1702-1731` 命中测试使用逆 DFS，跳过根和隐藏祖先；拖拽视觉上沿/下沿在 `WorkbenchLayerPanel.svelte:197-214` 映射到树序 `after/before`，Alt+上下走 `moveSelectedLayer`。
- `store.svelte.ts:962-980,1047-1060` 和面板 `WorkbenchLayerPanel.svelte:569-583` 只给叶子显示/统计 fx 钻；组缩略图走子层并集；`setAllGroupsCollapsed` 在 `store.svelte.ts:589-604` 使用一次 `tree-view` undo snapshot 加一次 view-state 写透。
- 四提交未触碰 undo 四域；未发现首行逆序与 hit-test/拖拽换算的直接反向错误。

## 残留风险与证据缺口

### P2：`journey-smoke` 仍残留 v4 producing 判定

`daemon/scripts/journey-smoke.ts:775-783` 仍使用 `children.length === 0 || drillWorthy`。前序本地运行全链完成并产出工件，但最终断言失败：把有子节点的 `sam-node-0001` 当成 producing，导致非零退出。应改成纯叶子集，并显式断言每条 assignment 都是叶子；`journey-demo-clown.ts:701-709` 已正确。

### P2：living spec 漂移

`openspec/specs/kernel-pipeline/spec.md:52-64` 仍写“中间节点按 `drillWorthy` 产块”，与 v5 的叶子恒产语义冲突。变更目录下的新 design/spec 已写成 v5，但 living spec 未同步，后续实现和验证可能重新引入旧分支。

### P2：真实双击事件竞争

`WorkbenchLayerPanel.svelte:544-547` 在同一按钮上同时绑定 `onclick` 和 `ondblclick`。浏览器真实双击会先触发两次 click；未选中行可能经历“第一次选中、第二次取消、dblclick 开始重命名”，而 `beginRename` 不重新选中节点。当前 v5 测试只直接 dispatch `dblclick`，未覆盖真实 click/dblclick 序列。修复为双击时显式 `selectNode(row.node.id)`，并补浏览器级序列断言。

### P2：面板边界行为缺少独立浏览器证据

源码的逆序、命中、拖拽换算和 fx 自定义事件链条可读且一致，但本地没有独立证明嵌套树拖拽落点、fx 锚点滚动和真实 click/dblclick 冲突的浏览器级结果。Owner 的 `18/18` 走查回执属于 supplied receipt，不能替代这些未拆解的边界断言。

### P2：叶子谓词重复维护

`design.ts:358`、`tree-to-blocks.ts:255`、`workbench.ts:578/1126` 和前端 `store.svelte.ts:964/1055` 分散重复“叶子才产块/计钻”。当前各处已同构，但后续再次变更时容易漂移。建议把领域谓词和导出过滤集中在共享的、可测试的纯函数边界；这是维护性判断项，不是当前硬性错误。

## 红线检查

- `engine/`：零改动。
- `canvaskit`：零改动。
- `undo` 四域：零改动；`setAllGroupsCollapsed` 只写 `tree-view` undo 域，并通过 view-state 记录折叠状态。
- 未触碰 `8317`、`5200`；未进行 Owner 会话或真机端口控制。

## 评分

| 维度 | 评价 |
|---|---:|
| 父层不产钻语义与契约 | 8.8 |
| 掩膜引用安全性 | 8.8 |
| PS 面板主体交互 | 7.8 |
| 导出/BOM 口径闭合 | 5.8 |
| 测试与验收证据 | 7.3 |
| **总分** | **7.8/10** |

## 放行决定

**不放行 Owner 第五轮验收。** 先闭合 `task.export` 叶子过滤及其回归；同时明确 capability layout 与 workbench task 的资源边界或统一过滤，再修 journey/spec 漂移并补真实双击/嵌套拖拽/fx 锚点证据。完成这些后再复核导出内容、计数和 BOM 三面是否同一口径。

## 二轮终评（3005f4b + cc66b44 + cca015f + c819fe8）

### 结论

**8.6/10；CONDITIONAL-GO：允许进入 Owner 第五轮真机验收，不等同于生产发布完全闭合。**

上轮两个 P1 的核心问题已闭合：`task.export` 不再原样交付含父层旧钻的 v4 工件，BOM/SVG/PNG 与 workbench 任务导出也已明确为两个独立资源域。R4 journey smoke 的旧 producing 判定已修成纯叶子并增加非叶子指派拒绝。当前仍有一个导出引用生命周期/接口一致性尾项，以及双击事件竞争、living spec 漂移和真实浏览器证据缺口，建议在 Owner 验收后、生产发布前收口。

### 本轮独立证据

- checkout 仍为 `add-backend-platform-impl`，`HEAD=c819fe8`，工作树干净；四个修复提交的祖先关系和改动范围已核对。
- 独立聚焦实跑：contracts `3 files / 62 passed`；daemon `workbench-pro + rpc = 2 files / 48 passed`；Studio `workbench.v5 = 1 file / 7 passed`；capability `approval-tools + approval-isolation = 2 files / 16 passed`。
- 独立类型/静态门：contracts `tsc --noEmit`、daemon `tsc --noEmit`、Studio `svelte-check` 均通过（Studio `0 errors / 0 warnings`）；`git diff --check 286f135^..HEAD` 通过。
- Studio jsdom 仍输出缺少 `canvas` 包的 `HTMLCanvasElement.getContext()` warning；测试通过，该输出不作为真实浏览器渲染证据。
- Owner 自报的 daemon/contracts/studio 全量绿门、真机 `699=858-159`、走查 `18/18` 和缩略图 `14/14` 仍按 supplied receipt 记录；本轮未重复全量测试、build 或真实浏览器走查。

### P1 闭合矩阵

#### R1：task.export 统一 v5 叶子口径

**核心语义：PASS。**

- `contracts/src/kernel.ts:330-345` 的 `nodeProducesBlock` 恒为叶子；`daemon/src/kernel/effective-gems.ts:20-25` 只保留当前树叶子 `blockId` 并保持原顺序。
- `daemon/src/rpc.ts:1534-1555` 先查当前 `object-tree`，树缺席返回 `BAD_REQUEST` 且 `data.code='tree-missing'`，不会静默回放旧原始字节。树在场时，`task.detail`（`rpc.ts:1188-1197`）和导出共同按当前树过滤。
- 过滤分支（`rpc.ts:1567-1587`）确实生成新 JSON、追加 `degraded` 且颗数为过滤后长度；无剔除分支（`rpc.ts:1556-1565`）直接读取原 blob 字节并返回原 `blobRef`，因此源码层面的恒等回放成立。
- `daemon/tests/workbench-pro.test.ts:987-1074` 的 v4 存量负样本包含组 `n-person` 4 颗和叶 `n-hat` 3 颗，独立验证 `detail.count=export.gemCount=decoded.gems.length=3`、父层剔除、过滤 blob 的字节与返回 `dataBase64` 相等；`tree-missing` 也有单独 typed 拒绝回归。
- v4 兼容边界是有树兼容、无树拒绝：树存在时旧父层工件可读但按新叶子口径导出；树缺席时导出明确失败。`task.detail` 的树缺席回落原始 count 是读面兼容降级，不能与导出面混称为三面一致，但契约注释已明确这一病态例外。

**R1 尾项（P2，建议发布前收口）：过滤后的 `blobRef` 未进入任务 artifact 引用集。** `rpc.ts:1580-1587` 直接 `blobs.put(bytes)` 后返回新 ref，没有 `jobs.emitFor(..., 'artifact', ...)`；而 `tasks.artifact` 只接受 artifact 帧、会话附件或当前树 mask（`rpc.ts:365-421`）。因此真实 daemon 对过滤导出的 `out.blobRef` 再调用 `tasks.artifact({taskId, blobRef})` 会得到 `NOT_FOUND`，mock 却把新 ref 放入 `gemsByRef` 并允许回读（`mock.ts:1107-1120`，测试 `workbench.v5.test.ts:308`）。直接下载因 `dataBase64` 仍可用，所以不推翻本轮叶子过滤语义；但返回值注释把它描述为帧流工件引用，且 `blobs.put` 的 ref_count 没有后续帧/释放归属，存在接口不一致和长期留存风险。

**可验证修复：** 过滤结果使用任务工件写入路径（例如 `putTaskArtifact`）并登记一个明确的导出 artifact 帧，或删除/重新定义输出中的 `blobRef`；补 daemon 回归：`task.export` 返回 ref 后经真实 `tasks.artifact` 读回，字节必须与 `dataBase64` 完全相等，并验证重复导出和任务清理的引用计数。若产品明确声明 `blobRef` 仅为下载响应的 CAS 摘要而不可经 `tasks.artifact` 回读，应同步收紧 contracts/mock 注释和测试，否则该项应升级为 P1 API 契约问题。

**恒等分支测试强度：P2。** 现有 ready 用例断言了原 `blobRef` 和颗数，但没有显式 `Buffer.from(out.dataBase64,'base64').equals(originalBytes)`；源码分支已足够证明行为，建议补一条字节等价断言防止后续重序列化回归。

#### R2：BOM/SVG/PNG 资源域边界

**语义与安全边界：PASS。**

- `contracts/src/workbench.ts:543-557` 和 `daemon/src/capability/layout-doc.ts:7-12` 冻结：`task.export` 是 v5 树语义唯一任务导出入口；capability 的 `LayoutDocument` 是独立 W2 layout 真值域，不回退读取任务 `strategy-gems/object-tree`。
- `studio.bom` 通过 `requireOwnedResource` + `loadLayoutDocument`（`studio.ts:472-487`）；SVG/BOM/PNG 的 `runLayoutExport` 也从同一 layout resource 装载并把该文档的 `gems` 交给三个 renderer（`studio.ts:953-1001`）。不存在“BOM 读 layout、PNG 偷读 task 工件”的代码路径。
- 同任务跨域测试（`daemon/tests/workbench-pro.test.ts:1083-1148`）发布含撞组节点 id 的独立 layout，断言 BOM 全量 5 颗、缺席资源失败，且 task export 仍为树过滤后的 3 颗；已有 `approval-tools` 回归覆盖独立 layout 的 SVG/BOM/PNG 三产物。

**R2 测试强度尾项（P2）：** 新增的跨域负向断言直接覆盖的是 `studio.bom`，并以 BOM 文本“不包含任务 gem id”证明互不交叠；SVG/PNG 的同一任务正负边界主要由源码和既有 generic export 测试支撑，缺少同一 fixture 下的 `studio.export` 三产物逐项断言，也未对缺席资源断言具体错误码。该缺口不改变当前资源域实现结论，但建议补齐以冻结边界而非只冻结 BOM。

### R3/R4 与面板残余

- R3 证据与实现一致：编号图例 jsdom 断言每行颗数等于该层 gems，真机同形数据的 `21/71/71` 名数配对已进入测试；本轮仍未独立跑真实浏览器第 6 行验证，因此 Owner 走查仍是 supplied receipt。
- R4 `daemon/scripts/journey-smoke.ts:775-790` 已使用 contracts `nodeProducesBlock`，并显式拒绝非叶子 assignment；这是上轮 journey P2 的实质闭合。`journey-demo-clown.ts:701-709` 仍使用同构的 `children.length===0` 内联表达式，属于 demo 维护性尾项，不是运行时产块路径。
- 上轮指出的真实双击竞争仍存在：`WorkbenchLayerPanel.svelte:544-548` 同一名称按钮同时绑定 click 切换选中和 dblclick 重命名，而 `beginRename`（同文件 `:136-139`）不会重新选中。真实浏览器双击的两次 click 可能把行从选中切回 null，再进入重命名；当前测试 `workbench.v5.test.ts:156-159` 只直接派发 `dblclick`，未覆盖真实事件序列。建议 dblclick 处理显式 `selectNode(row.node.id)`，并补 click→click→dblclick 浏览器级回归。
- living spec 仍漂移：`openspec/specs/kernel-pipeline/spec.md:52-64` 保留“中间节点按 `drillWorthy` 产块”，与 contracts/daemon v5 叶子恒产语义冲突。建议同步 living spec，避免下一轮实现或验收重新引入废止分支。

### 红线与覆盖边界

- 修复轮文件仍未触碰 `engine/`、`canvaskit` 或 undo 四域；`setAllGroupsCollapsed` 维持单笔 `tree-view` undo 快照并写透 view-state。`8317/5200` 未触碰。
- `tasks.artifact` 的 owner 越权边界仍闭合：先校验任务 owner/admin，再由 `jobs.frames` 取当前任务帧，树 mask 只在当前树命中时放行；未发现任意 owner 以 blobRef 枚举他人 blob 的路径。inline mask 继续走树工件，不受本次 blobRef 扩展误伤。

### 二轮评分

| 维度 | 二轮评价 |
|---|---:|
| 父层不产钻语义、execute/export/detail 收敛 | 9.2 |
| 掩膜引用安全性与 owner 隔离 | 9.0 |
| PS 面板主体顺序、计数、组门 | 8.3 |
| 导出/BOM/SVG/PNG 资源域闭合 | 8.3 |
| 测试与验收证据（含 ref 生命周期/浏览器缺口） | 8.0 |
| **总分** | **8.6/10** |

相较上一轮 **7.8/10**，主要提升来自 R1 导出语义和 R2 资源域边界已落到源码、契约和负向回归；扣分集中在过滤 ref 未登记 artifact、真实双击竞争、living spec 漂移及缺少独立浏览器证据。

### 放行裁定

**放行 Owner 第五轮真机验收（CONDITIONAL-GO）；暂不宣称生产发布完全 GO。** Owner 走查应重点验证图例第 6 行、真实双击后选中态/重命名、嵌套拖拽落点和 fx 锚滚；验收通过后，生产发布前必须收口过滤导出 ref 的 artifact 生命周期/契约一致性并同步 living spec。若产品要求返回的 `blobRef` 必须经 `tasks.artifact` 回读，则该尾项按 P1 处理并撤销本次放行，直到 daemon 回归通过。
