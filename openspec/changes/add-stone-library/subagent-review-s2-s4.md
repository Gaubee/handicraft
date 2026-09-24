# Subagent Review: add-stone-library S2（01cba49）+ S4（16df4db）

> 评审代理：实现评审子代理（替代 Codex 首轮）。评审基线：真实 diff `git diff 9c74ff8..16df4db` + 独立探针复现 + 全量测试独立重跑。不复述实现者自评。
> 日期：2026-09-24。

## 0. 开头自检

| 项 | 结果 |
|---|---|
| pwd | `/Users/kzf/Pictures/贴钻-backend`（分支 `add-backend-platform-impl`） |
| HEAD | `16df4db128024270b579855da8dbf087dcd62a79` |
| `git merge-base --is-ancestor 9c74ff8 HEAD` | 0（是祖先） |
| `git merge-base --is-ancestor 16df4db HEAD` | 0（是祖先） |
| 工作树 | 除本报告文件外零改动（`git status --porcelain` 空） |
| `git diff --check 9c74ff8..16df4db` | 干净（exit 0，无空白错误） |
| diff 范围 | 7 文件 +3685/-23：importer.ts（新 767）/capability/stones.ts（新 1306）/kernel/index.ts（+53 内改）/db/approvals.ts（+27 类型）/测试三文件（新） |

独立重跑证据：`pnpm -C daemon exec vitest run --exclude 'tests/e2e*.test.ts'` → **32 文件 / 319 测试全绿（7.90s）**；`pnpm -C daemon run typecheck` → 0 错误；单文件复跑 `capability-stones.test.ts` = **20/20**、`stones-import.test.ts` = **13/13**。探针脚本 `/tmp/stone-s2s4-probe.mts`（隔离 DATA_ROOT=createServices 临时根，进程内调用，零监听零常驻，已退出——`ps` 复查无残留 node/tsx/vitest）。

---

## 1. 发现分级

### P0（阻塞）

无。

### P1（应修）

#### P1-1 S4 `stone.import` 执行路径未接线 `pageImages`——多页样卡（钰航真实形态=两页）全格失败，且预览不检查源图可得性，人工批准被浪费

**证据（探针 P1a，真身 runner，非 stub）**：两页草表（页1 J51 + 页2 J76）→ propose `newCount=2`（无任何源图警告）→ 批准 → 执行 `created=0, failed=2`，失败原因逐格 `source-page-unreadable：源图字节缺失（page=1；多页草表需 deps.pageImages 直供…）`，**op 终态 succeeded**（runner 正常返回即结算成功）。对照探针 P1b：单页草表（blobRef 回退）真身执行 `created=1` 正常。

**根因（文件:行）**：
- `daemon/src/stones/importer.ts:579-607`（`resolvePages`）：多页草表必须 `deps.pageImages` 直供，单页才回退 `blobs.read(blobRef)`；
- `daemon/src/capability/stones.ts:519-520`（`executeApprovedImport`）：`runner({ service, blobs, db }, …)` —— `pageImages` 永远缺席；
- `daemon/src/capability/stones.ts:260-268/297-304`（`StoneImportProposeSchema`/`ImportInputSchema`）：**没有任何源图供给参数**（既无 `pageImages` 也无逐页 blobRef），MCP 调用方无法传入。

**为什么测试没拦住**：`capability-stones.test.ts` 的 import 用例全部走 `stubImportRunner()`（文件头声明"导入器本体链路归 stones-import.test.ts"），而 `stones-import.test.ts` 走 `pageImages` 直供——**两条测试线各自绿、组合面（MCP 执行×真身×多页）零覆盖**，正是缺口存活原因。钰航标准 fixture 本身就是两页（`stones-import-fixture.ts` page1+page2），S2 侧证明了多页可导，S4 侧却无法触达。

**可验证修复建议**（三选一，推荐 a）：
- (a) `StoneImportProposeSchema` 增 `sourcePages: z.array(z.object({ page: z.number().int(), blobRef: BlobRefField }))`（或 Record 形态）；propose 时逐页校验 blob 存在 + PNG 解码 + 与草表声明宽高对账（复用 `resolvePages` 判定逻辑），缺页进 `structuralFailures` 显式列出；执行时构造 `Map<number, Uint8Array>` 传入 runner。验收探针：P1a 场景下 propose 即拒（或执行 `created=2`）。
- (b) 最低限度：`previewCardImport`（stones.ts:90-148）补源图可得性检查——多页草表未直供 → `structuralFailures` 全量列出，把失败前移到 propose（不浪费批准）；执行路径缺口照旧，仅止损。
- (c) 契约约束：draft 生产侧（vision）强制单页草表（一页一 draft），importer 对多页+无直供显式拒——需写入 §8 对接契约并同步 vision 代理。

**阻塞范围**：不阻塞 S3/S5/S6 并行开发；**阻塞 S2 验收门**「钰航样卡 fixture 全链导入」（tasks.md 验收门第一行）与 S8.1 全链 E2E——验收门要求的是 MCP/后台向导可用的导入链，当前 MCP 链对两页样卡必然全格失败。

### P2（加固）

1. **§8.1 规则 6b 变体命名链跳号**：同码三格同尺寸（均解析 2mm）产出 `J51 / J51-2x2 / J51#4`——**#3 被跳过**（探针 P3）。确定性 ✓ 唯一性 ✓，但跳号反直觉：`importer.ts:415-420` 的 `n = i + 1` 起算后再撞号 `+1`，与已占的 `J51-2x2` 无关却跳到 4。建议撞号时从 `#2` 起找最小未占序号（`for (let n = 2; taken.has(`${sku}#${n}`); n++)`），命名链变为 `#2/#3` 连续。
2. **规则 3 先于幂等检查的报告噪声**：同字节组中某格 SKU 已在此前批次入库，rerun 时该格被报 `pending` 而非 `skipped`（探针 P5：`rerun pending=J55,A55 / skipped=0`，库内 J55 行不受影响）。`importer.ts:383-397`（规则 3）先于 `importer.ts:426-437`（幂等查）。建议规则 3 分组时排除 `finalSku` 已存在的格，或在报告 reason 中标注 `already-imported`。
3. **put-in-tx 回滚留物理 blob 孤儿（执行路径孤儿窗口实证）**：探针 P2——事务内 `blobs.put`（新代行）后事务抛错回滚：DB 行回滚、**物理文件留存**（DB 1 行 / 磁盘 2 文件）。可达窗口评估：gate 六条是纯函数在事务**外**前置（`service.ts:252-258`，gate 拒收零 blob 写入）；sku-conflict 前置查在 put **之前**（`service.ts:262-271`）；UNIQUE 兜底竞态在 better-sqlite3 单连接同步模型下前置查后不可达——**实际孤儿窗口≈事务中途崩溃**，与 W4.2 已登记的「预览 blob 回滚孤儿」同类（DB 一致、磁盘多文件、系统不可见）。建议：在 change 偏差清单登记 + 运维清扫面（启动物理-vs-DB 对账，与 design §1.5「投影重建端点非 P0」同族），非本波必改。
4. **§8.1 规则 8 阈值量纲变更未回写 design**：实现用「行中位 CIE76 ΔE>10」（`importer.ts:195-200`，`MEDIAN_DELTA_E_REVIEW_THRESHOLD=10`，注释引 Owner 2026-09-24 指示换算），design.md §8.1 规则 8 原文仍是「行级中位 ΔRGB>150」。换算本身合理（ΔE 量纲与全库 ΔE 面§5/§9 一致、保守触发不拒收），但 design 与实现文本漂移。建议 design.md 规则 8 补量纲脚注或在偏差清单登记该 Owner 指示（评审无法独立核验该指示原文，以登记为准）。
5. **`stones.search` q-only 路径排序键全 NaN**：`capability/stones.ts:740-746` else 分支 `const size = p.sizeMm as number`——仅给 `q`（无 nearColor/sizeMm）时 size=undefined，键 `Math.abs((size_mm ?? size) - size)`=NaN。ECMA SortCompare 对 NaN 返回 +0 → 稳定排序保持 listIndexRows 的 (supplier,sku) 原序，**行为无害但代码意图误导**。建议 else 分支前置判 `sizeMm !== undefined`，无尺寸键时直接保序返回。
6. **importer 报告 blob 无 GC 面**：`importer.ts:504` `blobs.put(report)` ref_count=1 但不挂 resources 行——引用关系只在 `approved_ops.result_ref`（S4）或调用方内存（S2 直调）。沿 W4.2 preview blob 同模式（`previewBlob`→put 同样不挂行），内容寻址可去重，但量大会累积。建议登记，与 #3 一并归运维对账面。
7. **`stone.create` 执行模式 payload 反序列化无二次 schema 校验**：`stones.ts:914-922` `payload['draft'] as …` 直转。安全性由 digest 防篡改（consumeForExecution 重算比对）+ propose 期已过 schema + canonicalJson 的 JSON round-trip 安全（schema 无 Date/NaN 面）三重兜底，风险低。建议执行模式加一行 `StoneCreateProposeSchema.safeParse` 兜底（update/delete 同理），防御纵深成本极低。
8. **`previewCardImport` 漏判同页重叠**：importer 有 `bbox-overlap` 结构检查（importer.ts:338-349），预览只查页声明+界内（stones.ts:113-121）——重叠属结构级可判却不判，预览 `newCount` 可能高估（执行期才降级为失败）。与已注明的「切格/同字节以执行报告为准」边界不同类（那些确需字节，这个不需要）。建议预览补重叠判定，或 note 中把重叠明确列入执行期判定集。
9. **（改进建议，非缺陷）双模顶层 ZodObject 优于 studio.generate 的 union**：探针 P6——`z.union` 无 `.shape`，generate 的 MCP 投影**无 inputSchema**（mcp.ts:60-74 shape 判空走无参注册）；stones 四写工具顶层 ZodObject 全可选 → 投影带完整 schema。mcp.ts 零改动故 generate 投影不受影响（无回归）。建议后续波次把 generate 的双模外层也改为 ZodObject 全可选形态，让投影带 schema。

---

## 2. 审查面逐项裁定

### A. S2 导入器（importer.ts + stones-import*.ts）

**A.1 §8.1 规则 3/6/7/8 落地正确性 —— 通过（含 P2-1/P2-2 两处加固项）**

- **规则 3（跨格同字节降级）**：`importer.ts:383-397` 按 textureHash 分组，≥2 格全部 `pending`+`card-render-pending` 原因留痕，不建原子。S1 约束下「不建原子」是正确落地（StoneFile.texture 必备+gate 6 拒缺字节，无"textureRef=null 入库"形态可用）；文件头 12-16 行明确了该裁决。测试 `stones-import.test.ts:286-330` 断言真实（pendingDowngrades 2 条+reason 正则+库内 0+报告逐格 textureStatus+**两格 textureHash 相等实证**+修复后重跑入库收敛）。探针 P5 补充边界（见 P2-2）。
- **规则 6（变体确定性命名）**：`importer.ts:370-424` 两段：6a 同码同字节=源重复首格保位其余 skipped（测试 :333-361，reason 断言到 `source-duplicate：同码同字节源重复（§8.1 规则 6）`）；6b 同码异字节裸码保 `code`、有尺寸 `code-WxH`、无尺寸 `#n`，全程草表出现序、禁后写覆盖（测试 :363-407 断言 `J51-2x2`/`X9#2`/`metadata.originalSku` 溯源+`skuParsed` 快照取原始码解析）。确定性跨 rerun 稳定：命名只依赖 draft 内容不依赖 DB 状态（rerun 时 6b 仍对全组计算，幂等查在其后按 finalSku 跳过）。跳号问题见 P2-1。
- **规则 7（缺声明不猜测）**：`importer.ts:296/306-308` parseSku 失败 → `sizeMm=null`+`skuParsed=null`+`sizeNote` 显式原因（含失败 reason），无栅格比例尺推测。测试 :409-438 断言索引 `size_mm` null、`style_row` null、name `魔方灰 · 尺寸未声明`、sizeNote 匹配 `row-out-of-band`。
- **规则 8（质量旗+ΔE 交叉验证）**：逐格采样色 vs 草表 ΔE（`importer.ts:366-367`，contracts CIE76 与引擎同源）+行级中位>10 → `needsReview` 入 metadata+报告（:439-448）；入库色=采样真值、草表色存 `metadata.draftRgb` 对账（:487-488——**优于 design 字面**的正确取舍）；qualityFlag 经 options 透传（:472）。测试 :440-490 断言到具体值（drawn 蓝入库、draftClaim 红对账、deltaE>10、medianDeltaE>10、needsReview='median-delta-e'、qualityFlag、报告逐 cell deltaE>10）。量纲变更文本漂移见 P2-4。
- **规则 1/2/4/5 归 draft 生产侧**的边界划分（文件头 7-10 行+tasks S2.2 语境）与 brief 的 S2 职责面一致：导入器只消费 bboxPx+做重叠/界内/页声明基本校验——裁定合理，vision 草表质量归其产出验收（另行把关）。

**A.2 幂等重跑与部分失败 —— 通过（孤儿窗口窄，见 P2-3）**

- 跳过语义三处一致（全局 supplier×sku）：importer `existsStmt`（importer.ts:427-437）= S1 createStone 前置查+UNIQUE 兜底（service.ts:262-271/320-334）= S4 `previewCardImport` existing 集（stones.ts:98-124）——与 S1 `UNIQUE(supplier,sku)` 全局键完全一致。
- 幂等收敛实证：测试 :213-226（二跑 28 全跳过、零新建、reason 带 resourceId、报告 summary 断言）；变体组跨 rerun 命名稳定（上述 A.1 推导）。
- 部分失败不整批回滚：逐 cell 独立事务（每 cell 经 createStone 自身事务，importer 不包批事务）；测试 :228-259（gate 低分辨率+空主体失败格与好格共存，成功行保留）。**失败 cell 的 blob**：gate 拒收发生在事务外纯函数前置（零 blob 写入）；sku-conflict 前置查在 put 前；实际物理孤儿窗口≈事务中崩溃（探针 P2 实证机制，窗口评估见 P2-3）——执行路径与 S4 偏差 2（预览回滚孤儿）同族但窗口更窄。

**A.3 报告 reportRef 留档 —— 通过**

`CardImportResult` 六字段（created=resourceId 列表/skipped/failed/pendingDowngrades/lowConfidence/reportRef）齐备；报告（importer.ts:170-189/697-763）含：summary 六计数、逐行（appliedName 兜底后/family/confidence/medianDeltaE/needsReview/lowConfidence）、**逐 cell（sku/finalSku/bbox/status/reason/textureHash/textureStatus/sampledRgb/draftRgb/ΔE/resourceId）**、低置信全量清单（含未入库格——proposal 人工把关点）。blob 留档可读回（测试 reportOf 逐项断言）。GC 面缺位登记为 P2-6。

### B. S4 MCP 工具面（capability/stones.ts + kernel/index.ts + db/approvals.ts）

**B.4 授权桥零新语义 —— 通过（逐行对照 W4.2 两先例）**

- **复用面实证**：`executeApprovedLocal`（stones.ts:467-488）= studio patch-apply 的「consume→落库→settleExternal 同一 SQLite 事务」逐行同构（studio.ts:581-600 对照）；`executeApprovedImport`（stones.ts:495-542）= generate 的三段式 consume→批执行→settle+崩溃窗口 recoverNonTerminal 收敛（studio.ts:703-743 对照，含失败 settle+rethrow 形态）。op digest：propose 计算+consume 重算比对（authorization.ts:286-295，防篡改）；TTL：APPROVAL_TTL_MS 同源+grant 过期双查；revision CAS：bridge 层（op.resource_id≠null 时对 resources.revision）+ service 层（updateStone 自身 CAS）双保险。approvals.ts 改动**纯类型**（ProposalPayload union 增四族，`import type` 无运行时环）。
- **无绕过面**：(a) agent 无 proposalId → mutationAuth.precheck 放行 propose 面（stones.ts:1296-1302，与 studio.ts:857-865 generate 例外同构），propose 零域内副作用，字段齐备性 handler 二次校验；(b) 零字段裸调 → handler 参数面拒（测试 [1]）；(c) **human-ui 直调**：core.ts:90 只对 agent 拦截，human-ui 进 handler → executeApprovedLocal → consumeForExecution 无 grant → failed（测试 [1] 第二条专项覆盖，`stoneCount=0` 断言库内零变更）；(d) principal 检查双层：registry precheck（快面）+ handler 内 consume（权威同事务）——owner 绑定经 taskId→tasks.owner_id（agentTaskOf）+ op.task_id/user_id/tool 四绑定校验，执行模式无法跨任务/跨人重放他人 proposal。
- 测试覆盖（W4.2 用例族复用）：principal-forbidden 四工具/无 grant 执行必拒/同 grant 重放必拒（'已消费'）/answer(false) 后执行必拒/revision 漂移 STALE+库内不覆盖（第三方直改真值构造漂移源——:400-415 实证）。

**B.5 import 双段式 —— 有条件通过（P1-1）**

- **proposal 批准前零域内变更**：`previewCardImport` 纯 SELECT；propose 面写 approved_ops 行（proposal 本身）+ **preview blob 两枚**（previewBlob→blobs.put，stones.ts:450-452）——「库内零变更」对 resources/stone_index 成立（测试 stoneCount=0 断言），blob 面有 preview 留档写入，**沿 W4.2 generate costSheet/preview 同模式，非新偏差**。报告 blob 仅执行期产生。
- **执行事务边界**：import 三段式（consume→逐 cell 独立事务批执行→settle）为**有意偏差**（部分失败=成功行保留语义与单事务互斥），文档注明崩溃窗口由 recoverNonTerminal（unknown→用户裁决）+幂等重跑收敛兜底——与 generate 外部执行同构，裁定合理。reportRef 入 result_ref 原子性：settleExternal 单事务写 op 终态+result_ref（authorization.ts:447-469，transition 带 resultRef），测试断言 `state='succeeded' AND result_ref=reportRef`。S1 四步同事务在每 cell 内保持（createStone 自身事务）。
- **缺口**：pageImages 未接线+预览不查源图可得性 → P1-1。

**B.6 MCP 投影 —— 通过（studio 十工具无回归）**

- 八工具名称投影正确：`stones.list→stones_list`…`stone.import→stone_import`（mcpToolName 非 studio 前缀不去首段，dsh 全名=mcp__studio__stones_list 等）；tools/list 断言八名+stones_list/stone_create 的 inputSchema 属性集 schema-faithful；tools/call stones_list readonly 真调往返（listener finally stop，零常驻）。
- **kernel/index.ts 改动回归评估**：onRunaway 提取为共享 const（函数体逐字不变，双 registry 共用同一回调语义）；composeRegistries 仅组合（call/definitionOf/describe/names 全委托+跨 registry 重名 fail fast）——studio 十工具行为等价，全量套件（kernel/mcp/generate/approval-* 共 319）独立复跑全绿佐证。
- **双模顶层 ZodObject**：四写工具外层单 ZodObject 全可选（propose/执行两形态都过面，互斥由 handler 判定+显式拒"执行模式只带 {taskId, proposalId}"）→ 投影带完整 inputSchema——**优于** generate 的 z.union（无 .shape→投影无 inputSchema，探针 P6）且不触动 mcp.ts，generate 投影零变化。改进建议见 P2-9。

**B.7 readonly 四工具与 owner 语义 —— 实现自洽，语义裁定归 D-1**

list（filter/分页/groupBy/nearColor ΔE 升序+平局 sku 稳定序）/search（三条件组合+无条件显式拒）/get（四态+not-found 第五态，blob-missing/wrong-kind 用真实 DB 破坏构造，soft-deleted 可读=回收站详情）/substitutes（基准排除+容差过滤+ΔE 升序+平局稳定序+基准无尺寸显式拒不猜测）——测试断言到具体值序。owner 语义：`filterRows` 按 `task.ownerId` 过滤+`ownedResourceOf` 跨用户必拒（测试 [7] B 任务四工具交叉实证，含 B 自建走自己任务）。`listIndexRows`（service.ts:607-609）无 owner 过滤、JS 层过滤——S3.1 SQL 化已登记偏差。与 design §6 字面（共享读）的冲突为 brief 指令从严落地+文件头偏差登记——裁定见 D-1。

### C. 交叉面

**C.8 CardImportRunner 静态直连 —— 类型面通过；pageImages 约定不一致（P1-1）**

- 一等类型（stones.ts:75-82）+ `defaultCardImportRunner` 静态直连真身（runCardImportImpl 直接调用，签名漂移即 typecheck 失败——typecheck 绿=对接证明）；`deps.cardImportRunner` 注入缝真实可测（stubImportRunner 经 setup 注入跑通全链）。
- **约定不一致**：S2 约定「多页需 pageImages 直供」（importer.ts:125-131 注释点名 S4/后台向导为直供方），S4 执行路径不传且 schema 无入口——S2 的多页逃生门在 S4 侧没有门框。详见 P1-1。

**C.9 测试独立重跑 —— 通过**

全量 319/319（7.90s）+ typecheck 0 错 + 单文件 20/20、13/13（见自检节）。零常驻：vitest run 退出、探针进程退出、`ps` 复查干净。

---

## 3. 设计裁定（D-1/D-2）

### D-1 owner 隔离（S4 现状）vs design §6「共享读」（§12-1 开放问题）

**现状结构事实（评审实证）**：
1. S1 层：`stone_index UNIQUE(supplier,sku)` **全局**；目录骨架 `stones/` 根按 meta.role **全局唯一**查找（service.ts:222-241 ensureSystemDir 不分 owner）——S1 落的就是全局共享骨架，owner_id 是行级归属字段。
2. S4 层：readonly 四工具按 task.ownerId 严格隔离（brief 从严指令，文件头偏差登记）。
3. 组合效应（探针 P4）：B 的 import 预览显示「J51 已存在全 skip」，但 B 的 `stones.list` total=0——**全局唯一键宣示全局真相，读面却按 owner 切片**：B 既看不到 A 录入的标准，也无法自己重录同 supplier 同 SKU（唯一键必拒），唯一出路是造 `yuhang`/`yuhang-2` 双份真相。

**两语义对三消费面的影响**：
- **MCP readonly 面**：隔离下 B 的 agent 做排钻设计/BOM/替代查询时看不到已录入的供应链标准——每用户被迫各录一份且被唯一键阻断；共享读下与「钰航/tuzuan 标准全客户共用」的业务事实一致，taskId 必填保留审计链（谁在读、读什么），授权桥写面不放松。
- **前台选择器（S5）**：数据源=stone_index 投影。选择器心智是「这个厂有什么钻」（供应链目录），不是「我私人有什么钻」；隔离语义与 S5 需求直接冲突。
- **生产组合（S7 引用集）**：组合成员=stoneRef 弱引用，物化在消费时刻解析。订单协作/多操作员场景下（A 录入、B 投产），隔离读会让组合成员大面积 soft-not-found——与「引用集自动跟随」的 S7 核心语义互斥。W4.2 P1-1 教训针对的是 projects/templates 类**私有设计工件**，装饰钻库是**供应链真源**，两类资源的归属模型本应不同。

**建议**：采纳共享读+写操作 owner 审计留痕（与 brief 倾向一致），三条理由：(a) 与 S1 已定结构（全局骨架+全局唯一键）一致，改动面最小（filterRows 去 owner 过滤+ownedResourceOf 放宽为存在性校验，substitutes 候选同改，get 四态语义不变）；(b) 与业务本质一致（供应链真源全客户共用，与私有工件的 W4.2 教训不同类）；(c) 隔离读在现结构下制造「双份真相」反模式，是结构自洽性缺陷而非保守选择。落地路径：**Owner 确认 §12-1 后在 S3 RPC 波次一并落地**（S3.1 本来就要做 SQL 化+读面协议），本波 S4 已作偏差登记、不返工。owner_id 保留为「录入者/审计」语义（写路径全部留痕：proposal+grant+resources.owner_id），未来若需多账户差异化（如私有注释/库存字段）走 metadata 层。

### D-2 `stone.create` sku-conflict 错误的跨 owner 存在性可见

**实证（探针 P4）**：S4 propose 模式错误**不含** resourceId（`supplier×sku 已存在：yuhang/J51（唯一性冲突——更新请走 stone.update）`——无 UUID 泄露，stones.ts:945-947）；S1 service 层 sku-conflict 的 message+detail 含 `existingResourceId`（service.ts:266-270）——该面在**执行竞态/直调 service** 时对跨 owner 可见。

**分析**：泄露实质是「存在性 oracle」（拿到的 resourceId 在隔离读下也读不到内容，id 本身价值有限；真正的信息是"此 SKU 存在"）。同 owner 场景 resourceId 直接指向冲突条目，排障价值高（可直接 update/delete/查详情）。**若 D-1 采纳共享读，存在性本就全员可见，泄露面归零，保持现状即可**；若 D-1 维持隔离，建议：detail.existingResourceId 保留（内部），message 中的 resourceId 仅当冲突资源属当前 task owner 时附带（一行属主判定），跨 owner 只报「已存在」不带 id——兼顾排障与最小披露。非阻塞项。

---

## 4. 质量评价

**强项**：
1. §8.1 四规则落地是**真实现而非图省略**——测试断言到哈希相等、具体 ΔE 值、命名链、报告逐格字段；「不建原子」降级形态在 S1 约束下的裁决（textureStatus 入报告+幂等衔接修复重跑）想得透。
2. 授权桥复用严格：executeApprovedLocal/executeApprovedImport 与 patch-apply/generate 两个 W4.2 先例逐行同构，无任何私有授权分支；测试复用 W4.2 用例族并补 human-ui 绕过面。
3. 确定性纪律贯穿：排序平局稳定序、变体命名草表出现序、报告 blob 留档可审查、快照哲学（skuParsed 物化+sizeMm 直值）。
4. 测试装配纪律：fixture 以实测锚点合成（列心/直径比例结构保真）、双测线分工声明、零常驻（listener finally stop 复核）。

**弱项**：
1. P1-1 组合面缺口——stub 策略让「MCP 执行×真身×多页」零覆盖，两测试线各自绿掩盖了主路径断链；这是本波唯一实质缺口。
2. 若干 P2 加固项（命名跳号/规则 3×幂等噪声/量纲变更未回写 design/预览漏判重叠）显示收尾略糙，但无一影响数据正确性。

---

## 5. 综合评分与结论

### 综合评分：**8 / 10**

**评分依据**：正确性（§8.1 规则+幂等+CAS+四态全对，-1 为 P1-1 主路径组合缺口）；安全性（授权桥零新语义+无绕过面+owner 绑定交叉验证，满分）；测试质量（断言真实+独立复跑全绿，扣 stub 策略造成的组合盲区）；工程完成度（P2 收尾项若干）；设计忠实度（偏差均有登记或注释论证，design 量纲文本未同步小扣）。

### 结论：**GO（附条件）**

- S3/S5/S6 可立即并行开工（依赖的 S4 面稳定）。
- **附条件**：P1-1 修复（推荐方案 a：sourcePages 参数+propose 期源图可得性校验）+ 补一条「MCP 执行×真身 runner×多页草表」组合回归用例，方可宣告 S2 验收门「钰航样卡 fixture 全链导入」——此前该验收门状态为未达成。
- D-1 提请 Owner 裁定 §12-1（建议共享读+写审计），落点 S3 波次；D-2 随 D-1 联动，非独立工作项。
- P2 清单建议随下一波次顺带收编（P2-4 design 脚注与 P2-1 命名连续性成本最低，优先）。

### 与 S0-S1 波次的质量对比（一句话）

本波整体延续了 S0-S1「typed error+探针可实证」的纪律水准（契约面与服务面同等扎实），但 S4 的 stub 隔离策略首次引入了 S0-S1 未出现过的「单测全绿而组合主路径断链」缺口——S1 波次的投影重建/引用四态等组合面都有直连真身用例，本波 P1-1 即败在组合面缺一条同等用例。

---

## 附：评审过程资源回收

- 探针脚本 `/tmp/stone-s2s4-probe.mts`：进程内调用、无监听无端口、createServices.dispose() 清理临时 DATA_ROOT，进程已退出。
- vitest run（两轮）+ tsc 均自然退出；`ps aux | grep -E "vitest|tsx /tmp|stone-s2s4"` 复查零残留。
- 本评审唯一写入文件：本报告（`openspec/changes/add-stone-library/subagent-review-s2-s4.md`）。
