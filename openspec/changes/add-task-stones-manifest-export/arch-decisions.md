# 贴钻工作台 MCP 化设计裁定

日期：2026-09-29  
基线：/Users/kzf/Pictures/贴钻-backend，HEAD b05172b  
范围：Owner 点名的「项目钻清单 + lint 警告」和「导出工具化」。这是设计裁定，不代表实现已经完成。

## 0. 源码核实后的边界

| 现状 | 证据 | 结论 |
| --- | --- | --- |
| 集合成员是 stoneRef + quantity + note 弱引用；getSet 读取时再解析 stone | contracts/src/sets.ts:1-150；daemon/src/stones/sets-service.ts:158-184,356-384 | 集合后续改动会影响读投影，不能直接当项目快照 |
| 策略指派的钻是 StonePick[]，resourceId 即 stoneRef，并带 SKU、供应商、尺寸、颜色 | contracts/src/stones.ts:252-266；contracts/src/kernel.ts:556-580 | 策略计划是项目实际钻引用的可审计单源；strategy-gems 本身没有 stoneRef |
| strategy.design 的 activeSetId 只过滤共享库候选，并绑定集合 revision CAS | daemon/src/kernel/strategies/design.ts:326-398,835-864 | 这是集合弱引用投影，不是 Owner 要的项目展开语义 |
| studio.export-dryrun 跑 validate + exportGate，studio.export 从独立 LayoutDocument 生成 SVG/BOM/PNG 分享包 | daemon/src/capability/studio.ts:397-494,752-801,941-1005 | 现有 capability 导出不能直接拿任务工件冒充任务导出 |
| task.export 只读任务帧里的 strategy-gems/object-tree，按叶子过滤后返回 JSON | contracts/src/workbench.ts:553-585；daemon/src/rpc.ts:2026-2115 | 现有任务导出不是 SVG/PNG/BOM 导出 |
| SVG/BOM 构造在 engine，PNG 在 daemon renderer；两者已经共享几何口径 | rhinestone-studio/src/lib/engine/export.ts:59-193；daemon/src/png/render.ts:255-311 | 可服务端复用现有纯函数；接线应放 daemon/studio 适配层，不修改 engine 红线 |
| engine SVG 的 `<g>` 是按 `colorId` 分组，BOM 只按 `specKey × colorId` 聚合；前端精修导出先做可见层投影 | rhinestone-studio/src/lib/engine/export.ts:82-106,155-193；rhinestone-studio/src/lib/services/documentService.ts:261-298 | 颜色分组不等于对象图层结构；现有 BOM 没有供应商/SKU/stoneRef |
| 前端普通 Studio 的 `exportSink` 取浏览器 store 的 active result/grid/palette；PNG 在组件 canvas；精修 PNG 由浏览器离屏 canvas 合成底图/参考图/钻 | rhinestone-studio/src/lib/studio/exportSink.svelte.ts:11-48；rhinestone-studio/src/lib/designer/pngRender.ts:132-155；daemon/src/png/render.ts:255-311 | 浏览器导出编排不适合直接在 daemon 运行；现有 daemon PNG 是透明底钻层光栅，不等于精修 WYSIWYG 合成图 |
| Composer 已支持多图片附件；followup 只收 sessionId/text/attachments/mode；每次常规 followup 都新建 task | rhinestone-studio/src/lib/components/agent/ComposerCard.svelte:144-174,328-350；contracts/src/session.ts:79-114；daemon/src/kernel/index.ts:468-505 | 集合选择应进入首个常规任务消息；项目清单必须跨后续 task 延续 |
| MCP 是 capability 的 schema-faithful 投影；模型身份靠参数内 taskId，变更能力走 proposal/grant | daemon/src/capability/mcp.ts:20-75；daemon/src/capability/core.ts:16-39,75-114 | 库内校验和授权必须在服务端完成，提示词不能替代权限边界 |

### 总体数据流

```
首条 Composer: images[] + sourceSetId?
        |
        v
首个 task -> 集合展开 -> session project / stones-manifest.json(rev=1)
后续 task -----------^ (按 sessionId 读取同一项目清单)
        |
策略计划 StonePick[] / layer.strategy.set
        |             \
        |              -> stones-lint.json (latest-by-name)
        v
task-layout.<imageId>.json (每图渲染快照)
        |
studio.task.export: propose -> user approval -> execute
        |
每图 SVG + PNG + BOM -> artifact 帧 + result bundle
                       -> task.result / task.exports.list / session.result(任务完成后)
```

## A. 项目钻清单与 lint

### A1. 存储形态

**裁定：内容用版本化 stones-manifest.json blob；权威指针和 CAS revision 放在新的 session-project 状态行（按 sessionId 唯一）；改动的 task 再发同名 artifact 帧作为审计/通知。** 不新增 tasks 宽列，也不把某一个 task 的 latest-by-name 帧当整个项目的唯一真源。当前每次常规 followup 都创建新 task；若仅存 task 工件，第二轮会丢项目配置。首波明确一个 session 对应一个项目；`taskId` 只用来校验行动者、定位工作台/产物，服务端据此解析 sessionId。

建议契约（formatVersion=1）：

```json
{
  "kind": "stones-manifest",
  "formatVersion": 1,
  "projectId": "session-id",
  "updatedByTaskId": "...",
  "revision": 3,
  "updatedAt": "...",
  "sourceSet": {
    "resourceId": "...",
    "setId": "...",
    "setRevision": 7,
    "name": "夏季主色"
  },
  "entries": [
    {
      "stoneRef": "stone-resource-id",
      "pick": {
        "resourceId": "stone-resource-id",
        "sku": "...",
        "supplier": "...",
        "sizeMm": 2.8,
        "colorHex": "#AABBCC",
        "gemshapeRef": "..."
      },
      "stoneRevision": 4,
      "stoneJsonBlobRef": "sha256...",
      "textureBlobRef": "sha256...",
      "shapeAssetBlobRef": "sha256...",
      "quantity": 120,
      "note": "备料参考",
      "origin": "set"
    }
  ]
}
```

pick 是展开时的物化快照，stoneRef 仍保留为全局身份键；stoneRevision/stoneJsonBlobRef/textureBlobRef 记录原子来源版本，存在 custom 形资产时还要冻结其 blobRef。示例中的各 hash 是字段示意，不是实际 SHA-256 长度。项目引用账本须持有这些源 blob，避免标准库删除/更换后旧项目快照变成悬空引用。sourceSet 只做溯源，不作为运行时引用。手工追加条目标记 origin=manual-add。项目状态行保存 `sessionId/revision/blobRef`，内容寻址 blob 保存 manifest；改动所在 task 的 `artifact` 帧保存当次 blobRef，供回放、任务详情和下载定位。后续 task 通过 sessionId 读项目当前指针。

写入必须由一个 manifest service 完成：校验 task/session/owner 可写，读取当前 revision，在同一 DB 事务内提交新 blob 引用和 `UPDATE ... WHERE revision=?`，并保有 session 侧 blob 引用；事务成功后发 artifact 帧。若帧 append 失败，以状态行作为恢复源补帧，不能因为 JSONL 帧和 SQLite 无跨介质事务就假称二者原子。tasks.params 只能保留首条消息的审计输入，不能成为第二个真源。不存在项目状态行时按 revision 0 初始化；并发追加的旧 revision 必须返回 STALE/CONFLICT。

**理由**：项目配置会跨对话轮次迭代；session 是当前最小稳定项目身份。内容寻址工件适合回放，SQLite 指针适合 CAS 和崩溃恢复；tasks 列会把项目状态绑在某一轮上。  
**风险**：需补 session 清理时 manifest blob 的引用释放，并处理“DB 提交成功、artifact 帧写失败”的补帧窗口；不能只沿用 `putTaskArtifact` 就声称 CAS 已闭合。  
**实现拆分**：contracts 增加 schema；daemon 增加 session-project 状态/引用/清理、manifest service、CAS writer 与补帧恢复；task.detail 增加 manifest 摘要（revision/count/sourceSet）。

### A2. 集合复制/展开边界与 quantity

**裁定：选择集合的瞬间展开一次；集合之后的增删改不影响项目。** 展开步骤是：读取集合及其 set revision，解析每个 stoneRef 到当前 stone_index，把 StonePick 与集合条目的 quantity/note 一起写进 manifest，并记录来源 revision。

- 集合成员解析不到、已软删或缺少必要物料字段时，首条任务创建拒绝并指出具体 stoneRef；不能把半解析成员写成“可用钻”。
- 同一 stoneRef 在多来源合并时只保留一个 entry；数量若要合并必须由服务端定义为相加，并在 origin 中保留来源，首波只支持一个集合以避免无谓的合并歧义。
- quantity 沿用现有集合语义：备料参考，不是库存锁定、也不是策略可用性约束。实际消耗以导出 BOM 的 gems 计数为准；可以在 lint/导出摘要中给出 planned-vs-actual 提示，但不能因为超量自动阻断。
- 项目仍可以引用全局库中的任何已存在钻；manifest 是“已引入/已讨论的清单”，不是候选库的硬白名单。

**理由**：Owner 说的是“复制/展开”，而当前 set 是弱引用；两者若复用同一对象会随集合漂移。StonePick 正好提供导出和策略需要的物化字段。  
**风险**：标准库的颜色、尺寸或贴图后来变化时，旧项目仍使用快照，需在 UI 中显示快照与当前库的差异；这属于可见升级，而不是静默更新。`StonePick` 自身不含原子 revision/贴图 hash（contracts/src/stones.ts:252-266），只复制它不足以锁住渲染资源。  
**偏差**：Owner 原话使用单数“一个集合”。本裁定首波 UI 只选一个集合；多集合并集属于后续明确需求。

### A3. lint 挂载点、警告形态与单源

**裁定：三处运行、一个规则单源。**

规则函数 lintTaskStoneRefs(taskId) 读取：

1. 当前 task 的 session-project 指针所指 stones-manifest.json 的 entries[*].stoneRef；
2. 被配置/导出的 sourceTaskId 与 imageId 对应的 strategy-plan.json 的 assignments[*].stones[*].resourceId（strategy-gems 不含物料身份，不能从 gems 猜）；
3. 当前 stone_index 的存在/可用状态。

结果分类：

- unintroduced：库内存在，但不在 manifest，warning，列出 stoneRef、SKU、供应商、命中的 nodeId；
- unresolvable：不在库、已删除、或快照字段不足，hard error；不能靠添加 manifest 消除；
- introduced：已在 manifest，清单通过；
- unused：已引入但当前计划没有使用，信息提示，不是错误。

挂载位置：

- strategy.design proposal 对草案 plan 跑一次，避免模型批准前看不到警告；执行落档后对当前 plan 重算；
- layer.strategy.set 和未来 MCP 图层配置工具的成功结果内嵌 lint；warning 不把 MCP 调用变成 isError；
- 每次计划/图层变更后持久化 stones-lint.json artifact，供任务详情面展示；
- 导出 dry-run/execute 前以同一函数重算，防止旧 warning 被绕过。exportGate 继续负责 spacing/mask/custom asset 等安全阻断；未引入钻默认不升级成导出硬阻断，库外/失效钻必须阻断。

**理由**：即时 tool-result 适合 Agent 与用户讨论；持久 lint 工件保证刷新、回放和工作台展示一致。把业务 warning 混入 engine validate 或现有 mask exportGate 会让几何安全门和项目政策混为一谈。  
**风险**：若只从 strategy-gems 检查，会丢失 stoneRef，造成“看似无警告”；若只在导出前检查，用户无法在配置阶段修复。lint 工件必须记录 manifest revision、planRef、sourceTaskId/imageId；读面发现任一来源漂移就重算，不能展示旧的“已消除”。  
**实现拆分**：定义 StoneLintSchema、单源计算器、task.detail.stoneLint 投影；在 strategy.design/layer.strategy.set/任务导出接线处复用。

### A4. MCP 工具面

**裁定：新增任务域只读/变更两个能力；集合和全局 stones 能力保持分层。**

- studio.task.stones.list({taskId})：返回 manifest revision、sourceSet、entries、lint 摘要、可追加候选（可选 query）。
- studio.task.stones.add({taskId, expectedRevision, stoneRefs:[...]})：按项目 manifest revision CAS 追加。每个 ref 必须在当前 stone_index 且未软删；服务端回填完整 StonePick，模型不能提交 sku/颜色作为真源。成功后写新 manifest、重算 stones-lint.json，返回 added/alreadyPresent/lint。
- studio.task.stones.remove 首波不做；Owner 只点名中途添加，删除会改变既有讨论结论，应另做明确审批/回滚设计。

权限：list 是 readonly；add 用现有 approved-mutation 双模（无 proposalId 发草案，有 proposalId 消费 grant），因为它修改项目配置。stones.list/get 继续是全局库查询；set.list/get 继续读取集合。策略设计默认仍可从全局库选择；`activeSetId` 只可作为用户显式指定的临时候选过滤，不能自动套用所选集合，否则无法引用“未引入但库内存在”的钻并触发 Owner 要的 warning。当前全库候选上限 200（design.ts:375-385）；超过时需让 Agent 先用全局库查询缩小 prompt 候选，但 lint 仍允许任何库内 stoneRef。

“先和用户讨论再添加”写入工具 description、Agent 系统提示和返回消息（例如“该钻未引入，请先确认是否纳入项目”），但真正约束由 add 的库内校验、task owner、approval/CAS 实现。提示词本身不是安全边界。

**风险**：只做提示词会被模型误调用；只做 stoneRef 字符串格式检查会允许库外幻觉。服务端必须查 stone_index 并回填快照。

### A5. 任务创建流

**裁定：扩展首条常规 followup 的结构化输入，Composer 继续承载多图，增加集合选择器；跳过集合 = 空 manifest。**

建议新增 `sourceSetId?` 到 SessionFollowupInput/内核 FollowupInput，只在 session 首个常规 followup 创建项目时接受；后续常规 followup 沿同一 session-project manifest，若想追加钻用 MCP add，不能重新选集合覆盖项目。steer 不接受图片和集合配置。首条请求服务端顺序：校验 session/附件归属/set owner/状态与成员 → 创建 task 并提交初版 manifest/引用 → 启动 agent；出错将 task 收口 failed 并清理/恢复引用，不留半成品 running task。当前代码先建 task 后验证附件（kernel/index.ts:468-495），这条顺序需要实改。

UI：仅在新 session 首条任务输入时，Composer 附件区旁放一个可搜索的 Select/Combobox，显示集合名、成员数、更新时间和 stale/unresolved 标记；选择后显示只读预览与“可在任务中追加”状态。首波单选；清空选择明确显示“本项目暂不引入集合成员”，仍创建 entries=[] 的 manifest。后续轮次显示当前项目清单摘要。用户无需把 setId 写进自然语言。多图附件按输入顺序分配稳定 `imageId`；各图的 scene/tree/plan/layout 工件必须带 imageId，避免 latest-by-name 覆盖前一张图。

**理由**：现有 Composer 的附件已经是结构化 blobRef，不能把 setId 拼入 prompt；现有 followup 会把参数 JSON 写入 task 并把图片转成原生内容块，集合展开应在同一服务端边界完成。  
**风险**：若集合选择只存在前端状态，重试/刷新会丢失；必须把 sourceSet 和 manifest revision 入任务工件。若选择集合后才发现成员失效，创建必须 typed 拒绝而不是静默空集合。  
**偏差**：Owner 说“开始一个任务的时候”选择集合；当前产品是先建会话、每次常规消息新建 agent task。本裁定把 session 当项目边界，选择绑定首条常规消息，后续 task 共享清单。这是为跨轮延续做出的产品解释；若 Owner 的一个 session 要容纳多个独立项目，应另加显式 projectId，而不能静默复用 sessionId。

### A6. 波次与验收

**波次**

1. W0 契约与读模型：StonesManifestSchema、StoneLintSchema、session-project 状态行、task.detail 摘要；补 CAS/owner/error 码和清理引用。
2. W1 首条创建：Composer 单选集合 + 多图一起提交；服务端展开快照；跳过集合写空 manifest；实现 stale/unresolved 拒绝。
3. W2 MCP 中途追加：studio.task.stones.list/add、审批与 revision CAS；add 后对受影响 sourceTaskId/imageId 的 plan 重算 lint。
4. W3 配置链闭合：strategy.design、layer.strategy.set、任务详情都展示同一 lint；库外/失效引用硬错误，未引入引用保持 warning。
5. W4 回归与 Owner 走查：真实 daemon + MCP + 浏览器，验证创建、配置、讨论、追加、警告消除和任务切换后的工件回放。

**A 验收必须证明**

- 选择集合后，manifest 中的 StonePick 与 set revision 被冻结；随后修改集合，项目 manifest 字节不变。
- 跳过集合得到 revision=1、entries=[]；下一个 followup task 仍读到同一项目清单；后续 add 只能接受库内现存 stoneRef，库外输入 typed 拒绝。
- 策略计划引用未引入库内钻时，配置 tool-result 和 stones-lint.json 都有 warning；用户确认后 add，manifest revision+1，lint warning 消失。
- strategy-gems 没有 stoneRef 时仍能通过 strategy-plan 正确 lint；切换任务/重启后 session-project manifest 和对应 plan/lint 可回放。
- 两个并发 add 使用同 revision 时只允许一个成功，另一个返回 stale/conflict，并且不丢对方条目。
- 库外、软删或损坏快照为 hard error；mask/spacing 仍由原 exportGate 阻断。

## B. 导出工具化

### B1. 工具形态

**裁定：一个逻辑工具 studio.task.export，采用现有 proposal/execute 双模；不暴露 kind=svg|png|bom|all，每次执行恒产目标图片的三件套。**

- 提案调用：{taskId, sourceTaskId?, imageId?}（可带 expectedManifestRevision）跑 lint + 几何 validate/exportGate，返回产物摘要、warning 和 approval request；`taskId` 是当前 Agent/审批归属，`sourceTaskId` 是排钻真值所属 task，必须同 owner、同 session；单图可省 imageId，多图必须明确指定；
- 执行调用：{taskId, proposalId}，消费 grant，针对 proposal 绑定的输入 revision 生成 SVG、PNG、BOM；
- 首波不支持部分格式。三件套来自同一 imageId 的 task-layout 快照，避免 Agent 分别调用三个工具导致版本漂移、重复审批和产物不对应。多图任务在同一轮可按 imageId 连续调用该工具，各自产一组三件套；不把不同图片的 PNG 强行拼成一张。

这是“一个用户意图/一个 MCP 名称”，而不是把批准阶段伪装成无副作用。它沿现有 studio.export-dryrun/studio.export 和 set.* 双模授权习惯实现；若未来需要仅下载 BOM，再增加明确的只读投影，不给当前工具塞 kind 分支。

**风险**：把执行也标成 readonly 会绕过现有分享包授权；把每种格式拆成三个工具会让模型多次取快照，结果可能不一致。proposalId 必须绑定 task、sourceTask、imageId、owner、layout/manifest revision。多图一次模型调用产全部文件需新的聚合 result 契约；首波明确每图一个三件套。

### B2. 导出管道与最小真值资源

**裁定：复用 engine 纯 SVG 构造和 daemon PNG renderer，新增 daemon/studio 任务适配层；不把 studio.export 直接改成读取任务工件，也不修改 engine。** 生产三件套的 PNG 定义为透明底钻位渲染（与现有 daemon 导出一致）；若要与精修前端含底图/参考图/贴图 sprite 的 PNG 逐像素同貌，需要另建服务端合成契约和素材解析，不能宣称现有 renderer 已满足。

当前 buildSvg/buildBom 只接受 gems、grid、palette、尺寸和形状解析器；renderGemsPng 同样需要 gems、palette、grid、尺寸和 custom asset resolver。因此仅有现有 strategy-gems.json（位置、shape、diameter、colorId）不够：它没有 grid、palette，也没有每颗钻到 stoneRef/SKU/供应商的物料身份。当前 strategy-plan.json 有 StonePick，但一个节点可有多颗候选，不能安全猜每颗 gem 的颜色。前端 `documentService` 的导出还依赖精修文档的可见层投影，这段浏览器 store/IDB 逻辑不能原样搬进 daemon。

新增按 imageId 命名的任务工件 `task-layout.<imageId>.json` 作为渲染快照，最小字段为：

```
kind/formatVersion
source: { projectId, sourceTaskId, imageId, planRef, treeRef, manifestRevision }
imageWidth/imageHeight, canvasCm, grid(pixelsPerMm/gap/base spec)
palette: colorId -> { name, hex }
blocks: id + bbox + mask（导出门/边界需要时）
gems: id,x,y,blockId,shapeId,diameterMm,rotationDeg,assetId?,stoneRef,sku,supplier,colorHex
shapeAssets: assetId -> blobRef（custom 形状）
```

该工件由策略执行的同一真值链生成，并以 planRef/treeRef/manifestRevision 绑定。每颗 gem 的 stoneRef 必须在排钻当时确定；若多候选策略现在无法指出实际用了哪款钻，必须先补策略输出/布局适配契约，不能从颜色或节点候选顺序猜。导出先按当前 object-tree 叶子口径过滤旧父层钻，再按项目工作台约定投影可见/隐藏层；后者当前 `task.export` 尚未实现，W0 须冻结“隐藏是否参与生产导出”并让画布/导出一致。建议采用“隐藏不导出”，与前端精修文档导出相同。

现有 engine `buildBom` 只输出“规格、形状、尺寸、色名、hex、数量”，不含项目物料身份。任务导出的 `bom.csv` 应由 daemon 任务适配器按 `stoneRef`（含 supplier/SKU）聚合实际使用量，同时列规格/颜色与备料参考量；引擎 `buildBom` 可作为几何/数量交叉核对，但不能直接冒充项目备料 BOM。这样不修改 engine，也不会把同规格同色的不同供应商钻合并成一行。

导出适配器把 task-layout 转换成 engine 输入，调用：

```
task-layout -> exportGate/validate -> buildSvg + renderGemsPng
                             \-----> buildTaskBom(stoneRef)
           -> createShareBundle
```

task-layout 是任务域快照，不是独立资源域 LayoutDocument；现有 studio.export 继续服务独立 layout resource。task.export 现有 JSON 能力保留，不能把它悄悄改成新三件套。当前 object-tree/strategy-plan/strategy-gems 多以固定工件名用 latest-by-name 读取；多图接线必须先把这些真值按 imageId 命名或建可索引的图像槽位清单。

**风险**：若只在导出时从 assignment 反推 gem 物料，多个 StonePick、颜色映射、异形资产都会出现不可审计的猜测；若把任务工件强行塞成 layout resource，会重新打破 v5 已建立的资源域边界。当前 engine SVG 只按颜色 `<g>` 分组，不保留 PS 对象图层；若 Owner 的“SVG 分层”要求对象图层可编辑，需另加对象图层导出契约和验收，不能把现有色组声称为对象层。  
**实现拆分**：先冻结 TaskLayoutSchema、可见层与对象层语义及生成器，再写 runTaskExport/buildTaskBom；所有 gate、SVG、BOM、PNG 共用同一解析器和同一快照。

### B3. 产物呈现与 session.result

**裁定：三件套同时进入 artifact 帧和 result bundle；不新增 result 帧 kind。**

执行成功后：

1. createShareBundle 以 layout.svg、bom.csv、render.png 生成内容寻址三元组，沿现有 results/<publicId> 和 /r/{publicId} 规则发布；bundle manifest 增加 sourceTaskId/imageId/输入 refs 供审计；
2. 对当前调用 task 发三条 artifact 帧，名称带 imageId（如 `task-export.<imageId>.svg`），payload 仍是 {name,blobRef}，供任务详情/下载面读取；DB bundle 成功而 JSONL 帧失败时，由 result 历史索引补发/修复帧，不能让可下载 result 失去任务展示；
3. MCP 返回 {resultId, publicId, bundle:{svg,bom,png}, source:{sourceTaskId,imageId,taskLayoutRef,manifestRevision}, warnings}；不把 base64 大文件塞进 MCP 文本；
4. task.result 返回该调用 task 最近一组 bundle，即使 task 仍在运行；session.result 只投影同 session 最近**已完成** agent task 的 bundle，当前轮结束前可能仍是旧结果或无结果（contracts/src/session.ts:201-240；daemon/src/sessions/service.ts:435-451）。执行当下 UI 用 MCP 返回值/当前 task.result 定位，不等待 session.result。
5. 多图导出应补 `task.exports.list` 或等价的结果历史读面（按 taskId、imageId 查 results），因为现有 `tasks.result_id` 只有一列，后一次导出会覆盖 task.result 的指针；前一组 result 行不能因此失去下载入口。

这样普通 artifact 回放和分享 result 各司其职：artifact 是任务帧内的精确文件引用，result 是可下载/分享的三件套契约。导出失败或 gate 阻断时不发布半成品 bundle，也不更新 tasks.result_id。

**风险**：session.result 是“最近完成 task”投影，连续导出会替换会话级最新结果；task.result 也只指向最后一组 bundle。多图必须有按 imageId 的持久结果索引与下载面，不能只靠临时 MCP 返回或帧扫描。

### B4. 端到端验收

**必须由真实 daemon、MCP listener、浏览器工作台共同验收，不能只用引擎单测。**

1. 首条消息上传两张图片并选择集合；任务详情能看到 manifest revision/sourceSet，两个 imageId 都有独立的真值工件。
2. Agent 对两张图分别完成识图、object-tree、strategy-plan，并产出 task-layout.<imageId>.json；其 gems 的 stoneRef、颜色、尺寸与 plan/manifest 一致。
3. 一颗未引入但库内存在的钻进入策略计划：lint 在 tool-result 和任务详情出现 warning；用户确认后调用 studio.task.stones.add，revision 增加，下一次 lint 为零条 unintroduced。
4. 每图调用 studio.task.export 提案模式，返回 gate、lint、产物预览和 approval-request；批准后以 {taskId,proposalId} 执行，得到各图同一 source revision 的 SVG、PNG、BOM；单图任务一次调用即产完整三件套。
5. 内容对应性断言：SVG 钻元素数量与经叶子/可见层投影的 gems 数量一致；PNG 尺寸等于 imageWidth × imageHeight 且非空；BOM 按 stoneRef/SKU 分行，合计等于同一 gems 数量、规格/颜色与各 gem 快照一致；三者 blobRef 可由 artifact 帧和 result bundle 读回。
6. task.result 在运行中即能看到最后一组 bundle；session.result 在任务完成后才投影；结果历史读面仍能定位两图各自 bundle。再次修改策略后旧 result 不被原地改写，新导出产生新的 resultId/publicId。
7. mask incomplete/stale、spacing/mask violation、库外 stoneRef 各自命中对应 hard blocker；仅 unintroduced warning 不伪装成 gate 通过或失败之外的第三状态。
8. 取消、清理、导出前 task 切换和 proposal stale 都不留下 orphan artifact/result；重复执行同一 proposal 至多一个 bundle。

## 2. 建议波次（A+B 联动）

| 波次 | 交付 | 放行条件 |
| --- | --- | --- |
| W0 | manifest/lint/task-layout 三份契约；session-project 状态/引用、imageId 与读投影 | schema、owner、revision、source refs 冻结；明确旧 task.export 不变 |
| W1 | 首条多图+集合展开、空集合、manifest 回放 | 集合修改不漂移项目；后续 task 共享 manifest；无效成员 typed 拒绝 |
| W2 | task.stones.list/add + approval/CAS + lint 工件 | 未引入 warning -> add -> warning 消失全链可回放 |
| W3 | strategy/layer lint 接线、按 imageId 的真值和 task-layout 生成器 | plan/布局/manifest 的 revision 和每颗钻物料身份可交叉核对 |
| W4 | 单逻辑导出工具双模、每图三件套 bundle/artifact/result 历史 | 同一图快照生成三件套；多图可下载；gate、取消、重复 proposal 回归通过 |
| W5 | Owner 浏览器走查和发布前证据 | 多图+集合选择、讨论追加、lint 消除、下载三件套真实走通 |

## 3. 与 Owner 原话的显式偏差与待确认项

1. **首波单集合**：Owner 原话没有要求多集合并集；本裁定首波单选，避免重复成员/数量合并产生未定义语义。
2. **未引入钻不自动阻断导出**：原话明确是 lint 警告；本裁定把它保持为 warning。库外、失效、损坏引用才是 hard error。若 Owner 要求“有任何 lint 就不能导出”，只需把 unintroduced 加进 export blocker，清单快照和工具形态不用推倒重来。
3. **quantity 不作库存约束**：沿现有集合“备料参考”语义；若 Owner 要项目级用量上限，需要另立库存/消耗契约。
4. **导出需审批双模**：Owner 说“工具化”，没有取消现有授权桥的意思；因为导出会发布分享 result，仍保留 proposal/approval。执行侧对 Agent 是一个 MCP 名称，但实际交互是提案后再执行。
5. **新增 task-layout.json**：这是为满足 SVG/PNG/BOM 的最小真值而新增的任务工件；现有 strategy-gems 不含 palette/grid/物料身份，不能靠猜测补齐。engine 保持只读复用。
6. **项目锚在 session，输出按图片分组**：这是从“每次 followup 新建 task”及“可多图”推得的本裁定，不是 Owner 逐字指定。一个 session 多独立项目、或多图合成一张物理画布，都需要另立显式契约。
7. **任务 BOM 与对象图层 SVG**：本裁定的任务 BOM 比 engine 现有规格×颜色 CSV 多 supplier/SKU；当前 engine SVG 只有颜色组，尚不能声称具备对象层分组。后者若是 Owner 交付要求，需列入单独设计/验收波次。
8. **PNG 视觉口径**：本裁定选 daemon 透明底钻位 PNG；它不等于浏览器精修文档的底图/参考图/sprite 合成 PNG。若 Owner 要完全 WYSIWYG 的导出，需把该合成真值与服务端渲染另列前置波次。

结论：A 可以按 W0-W3 实现；B 在 task-layout 和多图定位契约冻结前不应直接把现有 studio.export 接到 Agent 任务上。每图三件套端到端验收通过后，才可声称 Owner 的“两项 MCP 化”实现闭环。此轮仅做源码核对和设计裁定，未运行实现测试或真实浏览器流程。
