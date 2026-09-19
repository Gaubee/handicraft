# add-project-files 设计评审与 19 项议题裁决（R1）

日期：2026-09-19  
范围：`openspec/changes/add-project-files`、姊妹稿 `project-format-and-redesign.md`、补充稿 `lab-formats-and-gallery.md`，以及 `rhinestone-studio/src/` 真实源码。  
评审边界：lab 域按案例合成重构中的 pre-wave 基线阅读；不把 `lab.svelte.ts`、`effectRefs.ts`、`taskStore.ts`、`EffectRefControl.svelte`、`caseComposite.ts` 的中途态当作终局缺陷。

## 结论

方向正确但当前 **NO-GO**。项目/模板/档案四格式、内容寻址、弱溯源和画廊重构的产品分层成立；然而契约尚未闭合，直接按现有 tasks 切片实现会在数据损坏、交接失败或异步 UI 竞态上返工。

实跑证据：`pnpm check` 通过（0 errors / 0 warnings）。`pnpm test -- --reporter=dot` 为 47/49 文件通过、525/527 测试通过；剩余为 `edit/undo.test.ts` 超时和 `lab/runGroups.test.ts` 预期数量失败，另有 jsdom canvas `getContext` 未实现警告。后两项属于当前 dirty/pre-wave 基线，不能作为本 change 的终局缺陷，但也不能宣称全量绿门。

## 1. 议题裁决表

`支持` 表示采纳 PM 方向，但仍受下方阻塞修订约束；`推翻` 给出可验证替代方案和成本。

| 编号 | 裁决 | 一句话理由；推翻项的替代方案与成本 |
|---|---|---|
| D1 | 支持 | `.gemproj` 库内 `asset` 引用、磁盘导出 `embedded` 同时满足去重与可携带性；必须明确导入/重绑时的解析分支测试，成本是两套 parser fixture。 |
| D2 | 支持 | `ENGINE_VERSION` + 横幅重算符合当前引擎确定性重放和 `.gemdoc` 冻结出口；必须把“语义变更必 bump”做成测试/发布门，否则横幅不可信。 |
| D3 | 支持 | 快速排稿是从任意图片进入编辑的最短路径，空白画布可延后；P1 期间仍需保留明确入口占位，避免把“无来源文档”误当缺失态。 |
| D4 | 支持（有前置） | AssetProject 仅豁免 `blobKey` 换绑，复用库树、回收站和内容寻址的总成本低于另建 projectStore；前置是冻结原子更新 API、旧 blob 引用扫描和失败回滚测试。 |
| D5 | 支持 | 工程项目显式保存/守卫与模板自动保存是不同文档等级；切 Tab 不守卫、刷新/页内破坏性动作守卫与当前单例 store 生命周期一致。 |
| D6 | 支持 P0，P1 延后 | `pruneStaleOverrides` 足以先阻止悬空键污染；掩码内容哈希匹配尚无稳定块签名和冲突规则，不能在本切片半实现。 |
| D7 | 支持（暂不改名） | “素材库”仍能覆盖图片、项目和模板；“>30%”只是未来触发器，需改为数据驱动复议条件而非硬阈值。 |
| E1 | 支持 | `.gemgen` 内嵌图使单文件可导出，避免档案节点与裸图节点的双家；需加文件大小/配额失败态，不能只依赖浏览器“磁盘级”配额假设。 |
| E2 | 支持 | 旧裸图缺 `variantId/presetId/composedPrompt`，字符串回填会制造假溯源；保留为普通图片并排除画廊 union 是诚实边界。 |
| E3 | **推翻 PM 的“内容不一致即覆盖”细则** | 退役信封方向正确，但内容差异不能证明“应由官方覆盖”，与 E10 create-only 冲突。替代：迁移以稳定 `ast-tpl-${presetId}` 存在性/`provenance` 判定；节点存在（含软删）一律不覆盖，缺失才创建；写入迁移日志和一次性备份 key，所有节点与 `lab-session` 成功持久化后再删 `VARIANTS_KEY`。成本：一个迁移 journal、一次启动读取和约 1 个备份清理测试。 |
| E4 | 支持（有前置） | 字段提交自动换绑保持现状心智、模板 JSON 远小于生成图；必须按模板串行化写入并带 revision/旧 blob CAS，防止快速 blur 的旧写覆盖新写。 |
| E5 | 支持（需定稿 merge 算法） | 会话任务保留进行中/失败实时性，库内 gemgen 提供刷新后历史；合并优先活任务状态、以 `assetId` 去重、无 assetId 的 legacy 只在“全部”出现。 |
| E6 | 支持 | 模板是弱引用，删除/移出不级联删除档案；必须区分“已删”和“不在模板目录”，并在删除确认中显示保留的 gemgen 数量。 |
| E7 | **支持，与 D7 手势部分合并** | 同一网格双击语义必须一致；图片把重命名移到选中态工具行/Enter，项目与图片统一为桌面单击选中、双击打开，移动端单击打开。中等成本：AssetsView 两处事件矩阵、重命名入口、预览/路由测试及姊妹稿同步修文。 |
| E8 | 支持 | `enabled` 是本次生成意图，不是模板内容；迁移到 `lab-session` 可避免导出模板携带会话态。必须定义 session key 失效/损坏时的默认启用集合。 |
| E9 | **推翻“无额外契约即可 P0”** | 视觉缩略优先级合理，但 AssetProject 当前只有 `summary`，没有 `thumbKey`/缩略存储和 GC 规则；“归档时 canvas 一次”无法支撑刷新后的卡片渲染。替代 A（推荐）：本 change 将 `thumbKey`、thumbnail MIME/尺寸、写入/删除/回收保护一次冻结后保留 P0；替代 B：先 P1，卡片懒解析 gemgen、内存 LRU，不新增持久化。A 为中等成本，B 为小成本但首屏 decode 较重。 |
| E10 | 支持 | create-only + 新 preset 增量 seed 才能真正消除 `DEFAULT_TEMPLATES_VERSION` bump 清空用户模板的数据损失；软删节点存在即跳过，恢复动作由回收站负责。 |
| E11 | 支持（需改字段命名） | 外部文件与 localStorage 同属明文暴露面，沿 N3 打码合理；档案字段应命名 `advancedJsonRedacted`/注明不可重放，不能让用户误认为它是完整请求。 |
| E12 | 支持 | Owner 要求“和实验室一样的编辑体验”，唯一可维护方案是共享 `TemplateEditor` + 共享 `$state` record；宿主只管 Sheet/手风琴 chrome，不复制编辑态。 |

### E7 与姊妹稿的合并修订措辞

姊妹稿 A.4.2 将“**点击 = 用对应页面打开**”改为：

> 桌面端单击项目节点仅选中并显示选中态工具行；双击打开对应页面，移动端单击打开；工具行“打开”与键盘 Enter 等价于双击。项目节点不进入图片预览 Dialog。

姊妹稿硬规则 5 将“**项目文件点击 = 用对应页面打开**”改为：

> 项目文件遵循统一素材库手势：桌面单击选中、双击打开，移动端单击打开；对应页面是一页一格式的唯一消费者。图片节点同步遵循同一打开模型，重命名仅从选中态工具行/Enter 进入。

## 2. 阻塞问题清单

### B1. IDB 事务完成语义不足，换绑/GC 的“原子成功”不可验证

真实源码 `assetStore.ts` 的 `runTx` 在 `body(tx)` 完成后直接 `resolve(value)`，没有等待 `tx.oncomplete`；事务真正提交可能晚于调用方观察到的成功。新 `ingestProjectAsset`/blobKey 换绑若直接复用，会让“保存成功、旧 blob 已清理、失败回滚”测试失真。

可验证修复：将事务执行器改为“body 返回值暂存，`oncomplete` 后 resolve；`onabort/onerror` reject”，并增加：换绑前后节点/新旧 blob、注入 `nodes.put`/`images.put/delete` 失败时旧节点和旧 blob 均保持、共享 blob 引用不被误删的测试。

### B2. `.gemgen` 节点与 handoff v2 当前单点解析不闭合

现有 `HandoffPayload` 只有 `{assetId,name,referenceAssetId?}`；`studio.loadFromHandoff` 通过 `getAssetBlob(payload.assetId)` 读取 `AssetImage`。新设计把 `task.assetId` 指向不可变 `AssetProject(gemgen)`，而 `getAssetBlob` 只接受图片节点。若不改消费边界，“送排钻”会稳定进入缺失错误；若把 `assetId` 改成临时裸图，又违反 E1 的单节点和 handoff 零变形。

可验证修复：保留 HandoffPayload 形状不变，在唯一消费边界增加 `getHandoffImageBlob(assetId)`：图片走 `getAssetBlob`，gemgen 走 `getGemgenImageBlob`；`studio.loadFromHandoff`、下载和画廊均只调用该出口。测试覆盖 image/gemgen/missing 三态，断言 payload 字段零增加、零重编码语义变形。

### B3. openIntent 一次性消费的时序与失败语义未冻结

设计要求“解析先于切视图、失败不离开当前视图、只消费一次”，但当前 App 只有 handoff `$effect`，没有 openIntent；LabView 以 `onMount → hydrate()` 为入口。若 `setView`、LabView 挂载、hydrate 和解析并发，容易出现意图被清早、刷新重放或失败后仍切到实验室。

可验证修复：四 kind 共用一个 store，提供带 token 的 `peek/consumeSuccess(token)`；AssetsView 双击先读取并 parse，成功后才置意图；App 只切视图不清意图；LabView 在 hydrate 就绪并完成目标动作后才消费，失败保留当前视图且只 toast 一次。测试覆盖未挂载、已在实验室、解析失败、模板缺失、刷新重入五时序。

### B4. RightSheet 关闭守卫与自动保存竞态没有事件契约

补充稿要求 textarea `oninput` 未 blur 时关闭先 flush，失败时三选；同时又要求宿主不持编辑副本。若仅依赖 Sheet 默认 `open` 双向绑定，overlay/Escape/按钮可能绕过守卫；若每次 blur 直接换绑，多个异步写会乱序。

可验证修复：`TemplateEditSheet` 使用受控 `onOpenChange`，关闭请求统一进入 flush 状态机；编辑器保留共享 record 外的短暂未提交字段缓冲，成功提交后清空；模板 store 为每个 asset 建串行写队列和单调 revision，旧 revision 完成不得覆盖新内容；放弃修改回滚到最后成功快照。补充 overlay、Escape、删除中、IDB 失败、双宿主同开测试。

### B5. AssetProject 的引用保护、换绑 CAS 与 summary 真源边界未形成 API

当前 pin 是模块级无计数 `Set<string>`，`emptyTrash` 只按 pin 阻断；没有“打开 gemproj pin source+reference、关闭时成对 unpin”的项目生命周期 API。多个宿主/项目共享同一 source 或 reference 时，任一宿主直接 `unpinAsset` 会过早解除另一宿主的保护。设计还要求 summary 是缓存而非真源，但没有规定读取时解析/损坏时如何修复。

可验证修复：新增带 owner/token 的 `openProject/closeProject` 生命周期（或将 pin 改为引用计数），记录 project→asset 引用集合；只有最后一个 owner 关闭才解除 pin。`updateProjectAsset(projectId, bytes, summary, expectedBlobKey)` 在一个已确认完成的事务中 CAS 换绑；GC 仅在全节点无引用时删物理 blob；打开卡片只用 summary 展示，实际打开必 parse blob，summary 缺失/不一致可重算但不覆盖文件真源。

### B6. variants 迁移的 E3/E10 冲突会导致覆盖用户编辑或丢数据

补充稿 A.4.1 的 seed 规则是“节点存在（含软删）即跳过、create-only”，A.4.3 却要求 legacy 内容不一致时覆盖 `ast-tpl-${presetId}`。仅比较 promptBody 无法区分官方修订与用户编辑；删除 `VARIANTS_KEY` 也不是跨多个 IDB 写入和 session key 的原子操作。

可验证修复：迁移前写一次性备份和 `migrationState=pending`；按稳定 id/provenance 做 create-only，不做内容差异覆盖；每个节点写入后记录完成集，`lab-session` 成功后才将状态置 `done` 并删除旧 key。任一步失败保留备份和旧 key，下次按完成集重试；测试“中途失败、重启重试、成功删 key、软删不复活、用户内容零变化”。

### B7. 画廊并集的身份、批次和旧任务口径仍有歧义

现有 `getTaskGroups` 只按会话 `runId` 分组，`PersistedTaskMeta.assetId` 现指图片；新 union 要把库内 gemgen 投影进同一批次。仅写“`task.assetId === gemgen.id`”不足以说明无 assetId 任务、归档失败任务、模板缺失和同一档案的活卡/只读卡如何合并。

可验证修复：冻结 `GalleryEntry` 身份：有 `assetId` 以 asset id 去重并以活任务状态覆盖只读投影，无 assetId 以 task id；库来源 runId 取 provenance.runId，legacy 只进“全部”；过滤后仍按 runId 组建，目标组折叠先展开再定位。加入并集矩阵测试：重复、归档失败、模板孤儿、50 条裁剪、只读卡和进行中卡。

### B8. E9 缩略 P0 缺存储契约

`AssetProject` 设计只有 `blobKey` 和 `summary`，没有缩略的物理键、MIME、尺寸、GC 和 pin 规则。没有这些字段，刷新后只能逐卡解析完整 JSON 并解码内嵌原图，无法证明“归档一次 canvas”可持续。

可验证修复：在 P0 方案中显式加入 `thumbKey`（或独立 thumbnail record）及项目节点删除/换绑/回收引用规则；否则把 E9 降为 P1 的 lazy decode + 内存 LRU，并在 tasks 中删除“P0”字样。

### B9. PRODUCT_MODEL v3 与交接契约尚未落盘

仓库当前没有 `PRODUCT_MODEL.md` 或 `TERMS.md` 实体；tasks 5.2 只有未来落盘项。与此同时旧硬规则仍是项目文件点击打开、现有 handoff 仍是图片资产解析。若先实现后补模型，四格式真源、豁免范围和 handoff 适配会各自解释。

可验证修复：GO 前提交 PRODUCT_MODEL v3 的真实 diff/新增文件，明确四格式真源、AssetProject blobKey 豁免、gemgen 不可变、模板→任务→档案降熵链和 handoff 单点解析；将本报告 E7 文案同步到姊妹稿与 spec，并在 CI grep 检查旧规则残留。

### B10. tasks.md 的切片顺序没有把未裁决契约隔离

`tasks 1.4` 已要求项目点击路由，`2.7` 只写 `.gemproj/.gemdoc` 导入，`4.6/4.7` 才冻结四格式 openIntent 与手势；这会先落一套点击/导入语义，再被 E7 和实验室路由返工。`4.2` 同时把目录 seed 写入 assetStore、把条目 seed 写入 lab hydrate，边界虽在补充稿解释，任务依赖未显式化。

可验证修复：新增“契约冻结”前置 gate；先完成 `projectFile/labFile`、AssetProject union、openIntent/handoff adapter、手势文本和迁移 journal，再放行 1.4/2.7/4.2-4.7。将 2.7 改为四格式导入，或明确分成基础格式导入与 lab 格式导入两个依赖切片。

## 3. 非阻塞建议

- `summary` 字段使用显式 schema 版本或 `summaryUpdatedAt`，便于诊断缓存过期；不要把 summary 当解析失败的替代品。
- D6 的掩码内容哈希作为 P1 独立 change，先记录块 mask 的稳定 hash、碰撞时的用户确认和颜色/密度覆写映射，不要把“评估可行性”写成实现验收。
- E8 的 `lab-session` 需定义跨浏览器 tab 的 last-write-wins 提示；至少监听 `storage` 事件，避免用户以为 enabled 是模板内容。
- E11 采用 `advancedJsonRedacted` 命名并保留“不可用于重试”的 UI 文案；复用参数继续读取会话 task 的原值，不从 gemgen 反推秘密。
- 旧裸图不回填是正确边界，但素材库应明确显示“旧生成图片”而不是让用户误以为画廊数据丢失。
- 不改“素材库”名称时，底栏计数建议把四种项目聚合为“项目”并提供类型徽标，避免 `gemtpl/gemgen` 混入“最近”图片选择器。
- 画廊清空历史的确认文案应明确“只清会话任务记录，不删除档案”，软删档案必须二次确认并列出数量。
- 当前 `pnpm test` 的两个基线失败应在 change 结束前重新独立复测；不能用 pre-wave 说明替代最终绿门。

## 4. 评分与 GO 判定

| 维度 | 分数 | 依据 |
|---|---:|---|
| 设计质量 | 6.5/10 | 数据分层、格式职责、弱引用和失败分支覆盖较完整；但 E3/E10 冲突、缩略 schema、openIntent/handoff 时序和 PRODUCT_MODEL 落盘未闭合。 |
| 实现质量/可进入实现准备度 | 4.0/10 | 现有源码有成熟的内容寻址、pin、案例物化和 handoff 基础，但目标能力尚未实现，且 `runTx` 完成语义和 gemgen 消费边界会使第一批切片产生假绿。 |
| 综合 | **5.2/10** | 方向可保留，契约与任务排序需先收敛。 |

**Verdict: NO-GO。**

达到 GO 的最小修订集：

1. 修复并测试 IDB 事务完成语义；冻结 `AssetProject` 更新/CAS/GC/pin API，明确 summary 非真源。
2. 冻结四格式 schema、vendor MIME、parser/migration journal；解决 E3/E10，旧 key 仅在全量成功后删除。
3. 冻结 `getHandoffImageBlob`/`getGemgenImageBlob` 单点消费，保持 HandoffPayload 零变形并覆盖 gemgen/missing 测试。
4. 冻结 openIntent 四 kind 的 exactly-once、解析先于切视图和失败不离开语义；冻结画廊 union 身份/去重/批次算法。
5. 为 RightSheet 关闭守卫和自动保存增加受控关闭、flush、revision 写队列及双宿主同 record 测试。
6. 对 E9 选择“显式 thumbKey P0”或“P1 lazy decode”之一并改写 tasks；不要保留无存储契约的 P0 表述。
7. 合并 E7 手势文本到姊妹稿 A.4.2/硬规则 5，重排 1.4/2.7/4.2-4.7 的依赖；补齐四格式导入任务。
8. 将 PRODUCT_MODEL v3/TERMS 真实落盘，随后独立复跑 `pnpm check`、全量 Vitest 和浏览器走查；当前两项基线失败在最终 GO 前必须有明确归因和修复/豁免记录。
