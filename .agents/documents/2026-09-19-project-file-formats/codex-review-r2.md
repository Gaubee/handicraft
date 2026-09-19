# add-project-files R2 设计复审

日期：2026-09-19  
范围：`openspec/changes/add-project-files`、姊妹稿 `project-format-and-redesign.md`、补充稿 `lab-formats-and-gallery.md`、`rhinestone-studio/PRODUCT_MODEL.md`、`TERMS.md`，以及 `rhinestone-studio/src/` 真实源码。lab 域按要求作为案例合成重构中的 pre-wave 基线；源码未实现不作为本轮设计缺陷，但作为实现准备度证据。

## 结论

R1 的主要方向已被写入 change 层，R1 的测试失败勘误也得到独立复核：`pnpm check` 0 error/0 warning；`pnpm test -- --reporter=dot` 单进程运行通过 49 个文件、528 个测试（仅有 jsdom `HTMLCanvasElement.getContext` 警告）。`rhinestone-studio/PRODUCT_MODEL.md` v3 与 `TERMS.md` v1 确实存在。

但当前仍 **NO-GO**。剩余问题不是“没有写 §9”，而是 §9 与姊妹稿/补充稿的字段、MIME、迁移算法和任务顺序尚未形成唯一可执行契约；其中 MIME/缩略物理记录、事务终态、openIntent 的真正 exactly-once、迁移 journal 恢复和 0.4-0.8 依赖边界会在第一批实现中造成返工或错误数据状态。

## 1. R1 B1-B10 闭合核对

| 阻塞 | 状态 | 真实证据与尚缺契约 |
|---|---|---|
| B1 runTx 完成语义 | **部分闭合，仍阻塞** | `design.md:127` 已要求 `oncomplete` resolve、`onabort/onerror` reject，但未定义 body 返回值已产生后又收到 transaction error 时的终态优先级，也未限制 body 只能等待 IDB request。必须补：“仅首个终态生效；body 只能 await 本事务 request，不得跨 timer/IO/worker；body 成功值在 `oncomplete` 前不可见；commit error/abort 一律 reject”，并加 commit race 注入测试。真实 `assetStore.ts:166-203` 仍在 body resolve 时提前 resolve。 |
| B2 handoff/getHandoffImageBlob | **部分闭合，仍阻塞** | `design.md:133` 已写单点和三态测试，但 `HandoffPayload` 注释仍写 `getAssetBlob`，真实 `studio.svelte.ts:457-474` 仍直接 `getAssetBlob`。契约还要明确 parser 版本错误、gemgen 节点类型/MIME 校验、dataUrl 转 Blob 不重编码，以及 reference/download/preview 是否都走该出口；`getGemgenImageBlob` 不能只是命名出口。 |
| B3 openIntent exactly-once | **部分闭合，仍阻塞** | `design.md:134` 的 `peek/consumeSuccess` 只能保证最终清除，不保证两个并发 `$effect` 不同时执行动作；也未定义快速双击造成的旧 intent 覆盖、手动切 Tab、刷新持久性/过期和动作半成功。替代契约应是 `pending -> claimed(token) -> succeeded/failed` 的原子 claim；只有 claimer 能执行和 ack，失败保留可诊断状态且不重复 toast，并明确内存态还是带 TTL 的 sessionStorage。 |
| B4 RightSheet/写队列 | **基本闭合，仍缺关闭终态** | `design.md:140` 已有受控 `onOpenChange`、flush、revision、回滚和分支测试；仍缺“flush 失败时 `open` 必须保持 true、不得丢焦点/缓冲；放弃才回滚最后成功快照；删除/换绑冲突如何结束队列”的明确状态转移。补充 `open=true -> flushing -> open=false` 或 `open=true,error` 状态图，并测试 overlay/Escape/按钮三入口一致。 |
| B5 project lease/CAS/summary | **部分闭合，仍阻塞** | `design.md:128` 给出 API 名称，但没有 token/owner 返回类型、close 幂等、旧 lease 过期、多个宿主共享 source 时的计数键，也没有说明项目 source/reference 换绑或重载时如何增量 pin/unpin。`updateProjectAsset` 还需冻结单事务顺序：读节点及 expected key → 写新 blob/summary → 更新 node → 扫描旧 blob（含 thumb）引用 → 删除无引用物理记录；冲突必须不写任何一项。summaryUpdatedAt 需进 schema，而不只存在 prose。真实 pin 仍是 `Set`（`assetStore.ts:646-654`）。 |
| B6 variants 迁移 | **未完全闭合，仍阻塞** | §9 `design.md:139` 已改 create-only journal，但补充稿仍在 `lab-formats-and-gallery.md:230-233` 写“内容不一致 → 覆写 seed”和以内容 diff 重试，直接与 §9 冲突。真实 `taskStore.ts:289-295` 在版本不符时直接返回 null，迁移无法读取原始 v2。必须新增 raw-v2 读取路径；journal 至少含 `pending/completedNodeIds/sessionWritten/oldKeyDeleted`，规定 IDB/localStorage 非原子崩溃恢复、备份 key 清理期限及删除顺序。 |
| B7 Gallery union/定位 | **部分闭合，仍缺失败分支** | `design.md:135` 冻结了 assetId/taskId 身份和 runId，但未规定活任务指向缺失/非 gemgen 节点、归档失败后只读投影是否保留、重试产生旧档案时的状态优先级。七步动线也没有 DOM 目标不存在、组在过滤重算后消失、组件卸载或 `scrollIntoView` 失败的分支。应冻结 `asset:<id>`/`task:<id>` key、状态 precedence、目标 `data-testid`，只有完成定位-展开后清意图，失败留在当前视图并单次提示。 |
| B8/E9 thumbKey | **未闭合，阻塞** | §9 `design.md:129` 和 `tasks.md:57` 选了 P0 `thumbKey`，但 `design.md:33` 的 AssetProject schema 没有 `thumbKey`/thumb MIME/尺寸/bytes，姊妹稿 `project-format-and-redesign.md:258` 仍写项目缩略图 P1，`design.md:38` 也仍写 P1。必须选唯一版本并写出物理记录所在 store、`thumbKey` 与 node 的所有权、归档/导入/换绑/软删/硬删/GC/缺失 fallback；否则 P0 只是 UI 目标，不是可实现契约。 |
| B9 PRODUCT_MODEL/术语 | **部分闭合** | v3/TERMS 已落盘，且 `PRODUCT_MODEL.md:52,65,72` 与单点、手势、豁免、不可变规则一致；但 `design.md:38`/`:58` 仍分别写缩略 P1、TERMS “后续抽取 P2”，姊妹稿也有 P1 残留。源码仍有旧“转化工作台/送转化”是实现前预期，但 5.1/5.2 的 grep gate 必须把注释、测试、handoff 文案一起纳入，不得只扫用户界面。 |
| B10 tasks 切片/gate | **未闭合，阻塞** | §9 `design.md:149` 说 0.4-0.7 先行，但 `tasks.md:19` 的 0.5 使用的 AssetProject 类型又在 `1.1` 定义，0.6 使用 `getGemgenImageBlob/labFile.ts` 而 parser 在 `4.1`，0.7 的 LabView 行为测试又依赖 `4.6`，0.8 声称迁移 journal 先行但实际实现仍在 `4.3`。应拆成“接口/schema contract gate”和“实现 gate”：先冻结四 MIME/类型、parser 接口、lease/CAS、intent claim、journal 状态；再按 `0.4 → 0.5/1.1 → 4.1 → 0.6 → 0.7 → 0.8 → 1.4/2.7/4.2-4.7` 排序，并删除重复定义。 |

## 2. §9 契约挑刺

### 2.1 数据模型与 MIME

`design.md:34` 写的是“两个 vendor MIME（`application/vnd.rhinestone-studio.gemproj/gemdoc+json`）”，这是一个无效的合并 MIME，且与补充稿四格式表（`lab-formats-and-gallery.md:46`）冲突。唯一真源应明确为：

```ts
const PROJECT_MIME = {
  gemproj: 'application/vnd.rhinestone-studio.gemproj+json',
  gemdoc: 'application/vnd.rhinestone-studio.gemdoc+json',
  gemtpl: 'application/vnd.rhinestone-studio.gemtpl+json',
  gemgen: 'application/vnd.rhinestone-studio.gemgen+json',
} as const
```

`projectKind`、MIME、`kind` 必须交叉校验；导入时扩展名不能覆盖文件内 kind/MIME。`AssetProject` schema 同时需要 `summaryUpdatedAt` 和 gemgen 的 `thumbKey`/物理缩略元组；summary 只能是卡片缓存，parse 文件才是打开真源。

### 2.2 runTx 与内容寻址 GC

“等待 `oncomplete`”本身还不够。IDB transaction 的 request error、transaction abort、body reject、commit 完成必须有单一终态；body 不能在任意非 IDB await 后继续发 request。换绑失败时，旧 node、旧 file blob、旧 thumb、旧 content-hash 记录均保持；换绑成功后删除旧物理记录只能在全节点（含项目节点与 thumb 引用）无引用时发生。测试需覆盖“body 已返回值但 commit error”“新 blob 已写、node put 失败”“旧 blob 被另一项目共享”“thumb 共享/缺失”。

### 2.3 project lease 与 summary

`openProject(id)` 应返回带 `projectId/ownerId/token/pinnedAssetIds/closed` 的 lease；`closeProject(lease)` 幂等，只有同一 token 的最后 owner 才解除 pin。打开和 source/reference 重绑必须以 lease 的引用集合做差分。CAS 冲突只返回 typed conflict，不得把新 bytes 写入孤儿 blob；孤儿 blob 的回收应由后续 GC，而非在冲突路径盲删。

### 2.4 handoff 单点

`getHandoffImageBlob` 应是所有“跨模块消费图片字节”的出口：图片 asset 直取，gemgen 校验节点后解析内嵌 image，缺失/超前版本/损坏分别给 typed error。`HandoffPayload` 继续保持 `{assetId,name,referenceAssetId?}`，调用方不新增临时裸图 id，不做二次编码。真实源码的旧入口（`studio.svelte.ts:460` 及 handoff 注释）需在实现切片中同时清理。

### 2.5 openIntent 与七步定位

`peek/consumeSuccess` 需要改为原子 claim/ack；否则两个 effect 都可在 consume 前完成副作用。四 kind 共用一个 token namespace，并冻结“新 intent 到来时 reject/replace 旧 intent”的规则。解析必须在切 view 前完成；进入 LabView 后若 hydrate、模板回链、DOM 定位或滚动失败，不清成功 token，不自动重复 toast；只有目标卡展开且高亮已挂载才 ack。刷新要么明文规定内存 intent 丢弃，要么使用带过期的 sessionStorage，不能同时声称“防刷新重入”而不定义持久层。

### 2.6 variants journal

迁移必须先用 raw-v2 读取保存原文备份，再执行 create-only：稳定 id 存在（含软删）即跳过，只有不存在才创建；不能按 prompt diff 覆盖用户节点。建议 journal 结构：`{version, state:'pending'|'done', completedNodeIds, sessionWritten, oldKeyDeleted, backupKey, startedAt}`。顺序固定为“备份 → 节点完成集 → lab-session → state=done → 删除 VARIANTS_KEY”；任何崩溃按完成集重试，旧 key 尚未删除时保留，备份按明确 TTL 清理。

## 3. 0.4-0.8 gate 审查

| 切片 | 当前问题 | 达成 GO 的边界 |
|---|---|---|
| 0.4 | 共享 `runTx` 的错误/commit 终态未定义，且会影响所有既有 assetStore 写路径 | 先完成事务 contract test，再跑既有资产、回收站、hash backfill 回归；body 限制为 request-only await |
| 0.5 | API 与 1.1 重复，lease/CAS/thumb 引用集合未冻结 | 在此切片定义 AssetProject 完整类型、四 MIME、lease、CAS、summaryUpdatedAt、thumb ownership；1.1 只实现，不再重定义 |
| 0.6 | 依赖尚未存在的 `labFile.ts` parser，无法独立证明 gemgen 三态 | 先在 4.1 冻结 lab parser/typed errors，再实现 handoff adapter；或 0.6 仅冻结接口并把真实三态测试后移 |
| 0.7 | `peek/consumeSuccess` 非原子，且 LabView 集成尚未存在 | 先做纯 store claim/ack contract test，再做 4.6 UI 动线测试；补刷新、覆盖、半成功分支 |
| 0.8 | journal 只写“落定”，实现仍在 4.3；补充稿算法未同步 | 先同步补充稿并冻结 raw-v2/journal 状态机，4.3 只实现该状态机；不得在 0.8 通过前消费迁移任务 |

## 4. 19 项议题裁决（R2 复核）

以下结论沿用 R1，但逐项按真实修订文本复核；“支持”是支持 PM 方向，不代表当前实现已完成。

| 编号 | 裁决 | 理由/替代方案 |
|---|---|---|
| D1 | 支持 | 库内 asset 引用、导出 embedded 同时满足续作与便携；必须补四格式 parser/MIME 交叉测试。 |
| D2 | 支持 | ENGINE_VERSION 横幅+重算正确；需把语义 bump 纪律纳入发布/测试门。 |
| D3 | 支持 | 快速排稿是最低摩擦入口，空白画布 P1 合理；不能把无来源文档误当缺失态。 |
| D4 | 支持（有前置） | blobKey 换绑比独立 projectStore 低成本；以前述 CAS、lease、thumb GC 契约为前置。 |
| D5 | 支持 | 工程文档显式保存/守卫与模板字段自动保存分层合理。 |
| D6 | 支持 P0、哈希 P1 | 先清理悬空 block id；掩码内容哈希另立 change，避免半实现。 |
| D7 | 支持（暂不改名） | 素材库可覆盖全部资产；复议条件应保持数据驱动。 |
| E1 | 支持 | gemgen 内嵌使档案自包含；必须补配额/大文件失败态。 |
| E2 | 支持 | 旧裸图缺稳定 provenance，拒绝字符串伪回填；以旧生成图片身份保留。 |
| E3 | **推翻 PM 覆写细则** | create-only、稳定 id/provenance、含软删存在即跳过；journal+备份+完成集后再删旧 key。替代成本是 raw-v2 reader、journal 和恢复测试。 |
| E4 | 支持（有前置） | 字段提交自动换绑符合现状；必须串行 revision 队列和受控 Sheet 关闭。 |
| E5 | 支持 | 会话任务保留实时态、库档案补刷新历史；按 assetId 去重，legacy 只在全部。 |
| E6 | 支持 | gemgen 弱引用不级联删除；孤儿 chip/徽标和回收站还原回链。 |
| E7 | 支持，和手势合并 | 桌面单击选中、双击打开、移动端单击打开；图片双击预览，重命名移入选中态工具行/Enter。 |
| E8 | 支持 | enabled 属于 lab-session；损坏/失效回默认启用，并给跨 tab LWW 提示。 |
| E9 | **支持 P0 目标，但推翻“当前文本已足够”** | 采用显式 thumbKey A 案；必须补物理 record、MIME/尺寸、GC/删除/缺失 fallback，并把姊妹稿和 §1 的 P1 改为同一 P0。若不补，替代是降 P1 lazy decode+LRU。 |
| E10 | 支持 | create-only、新 preset 增量补 seed，退役 DEFAULT_TEMPLATES_VERSION bump 清零。 |
| E11 | 支持 | `advancedJsonRedacted` 明示不可重放，复用参数读会话 task 原值。 |
| E12 | 支持 | TemplateEditor + 共享 record store 双宿主是唯一可维护方案，宿主不持副本。 |

### E7 两处统一措辞（R2 保持）

姊妹稿 A.4.2：

> 桌面端单击项目节点仅选中并显示选中态工具行；双击打开对应页面，移动端单击打开；工具行“打开”与键盘 Enter 等价于双击。项目节点不进入图片预览 Dialog；图片节点同一打开模型，重命名仅从选中态工具行/Enter 进入。

姊妹稿硬规则 5：

> 项目文件遵循统一素材库手势：桌面单击选中、双击打开，移动端单击打开；对应页面是一页一格式的唯一消费者。图片节点同步遵循同一打开模型，重命名仅从选中态工具行/Enter 进入。

## 5. 阻塞问题与可验证修复

1. **四格式 MIME/schema 与 thumb 冲突（P0）**：修正 `design.md:34` 为四值 MIME；在 AssetProject schema 增加 `summaryUpdatedAt`、`thumbKey` 及 thumb 物理元组/所有权；同步 `design.md:38`、姊妹稿 `:258`、spec 和 4.4；加入 kind/MIME、thumb GC、缺失 fallback 测试。
2. **事务终态仍不可验证（P0）**：按 §2.2 的首终态规则改 runTx contract；加 commit error、body race、共享 blob/thumb 失败注入，并回归全部旧写路径。
3. **openIntent 不是动作级 exactly-once（P0）**：引入原子 claim/ack 状态机；冻结 intent 覆盖、刷新、手动切 view、DOM 定位失败的语义和五时序测试。
4. **迁移契约跨稿漂移（P0）**：删除补充稿 A.4.3 的“内容不一致覆写”及内容 diff 幂等描述；新增 raw-v2 reader、journal 状态和崩溃恢复/备份 TTL 测试。
5. **gate 依赖不可切片（P0）**：把 0.5 的类型/API前移为唯一 contract 定义，4.1 先于真实 0.6 parser 测试，0.7 拆 store contract/UI integration，0.8 只冻结 journal 不提前消费 4.3。
6. **project lease/CAS 与 thumb 引用规则不足（P1）**：冻结 lease 返回/关闭幂等、source/reference 差分 pin、CAS 冲突不写入和全引用 GC 顺序。
7. **画廊定位失败分支缺失（P1）**：冻结 entry key、活态优先级、目标 DOM 标识及组消失/卸载/滚动失败行为；仅成功展开后清意图。

## 6. 非阻塞建议

- `openspec validate add-project-files --strict` 当前只报 spec 中中文 ADDED requirement 缺少 RFC 2119 `SHALL/MUST` 警告并以非零退出；不影响语义，但可在 spec 句首补 MUST，避免 CI 把文档质量警告当失败。
- `design.md:58` 应改为“TERMS.md v1 已落盘，5.2 校验零漂移”，不要保留“后续抽取 P2”。
- `lab-session` 的 storage 事件提示应显示发生了覆盖，不要静默覆盖当前启用态。
- `advancedJsonRedacted` 和旧图片 `meta.prompt` 的明文遗留应在安全说明中分开记录，避免读者误以为全链路已脱敏。
- 旧“转化工作台/送转化”源码注释和测试在实现前保留是可解释的；收尾 5.1 必须覆盖注释、测试断言、toast、handoff 文案而不只搜组件文本。

## 7. 评分与决定

| 维度 | R1 | R2 | 变化依据 |
|---|---:|---:|---|
| 设计质量 | 6.5 | **7.3** | B1-B7 的 API/失败测试、E3 journal、E9 A 案、E7 文案、PRODUCT_MODEL/TERMS 已显著补齐；但 MIME、thumb P0/P1、补充稿迁移覆写残留和 openIntent/事务终态仍阻止更高分。 |
| 实现准备度 | 4.0 | **5.0** | 独立复跑确认基线为 49/49、528/528，且 gate 任务已显式化；真实源码仍是 pre-implementation，0.4-0.8 仍有 parser/API/迁移依赖倒置。 |
| 综合 | 5.2 | **6.2** | 方向与主要数据分层成立，残余问题集中在可执行契约和切片边界，而不是产品方向。 |

**Verdict：NO-GO。** 不能按当前 `tasks.md` 直接进入 1.4/2.7/4.2-4.7；先完成第 5 节七项中的前五项（尤其四 MIME+thumb、runTx、intent claim、迁移 journal、gate 重排），再实现 0.4-0.8 的 contract tests。达到以下最小条件后可转 GO：所有文档只剩一套 schema/MIME/迁移算法；0.4-0.8 测试可在其声明依赖内独立通过；旧 assetStore 全量回归仍保持 49/49、528/528；随后再由 4.7/5.3 做浏览器走查和最终绿门。
