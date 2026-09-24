# add-stone-library 子代理评审报告：S3（后端查询/资产面）+ S7（生产组合层）

- 评审对象：`git diff 9371b7c..d56ce21`（8bc042c=S3 + d56ce21=S7，19 文件 +4221/-60）
- 评审代理：ZCode 子代理（独立复验——不复述实现者自评，全部结论附 文件:行 证据或探针实测）
- 日期：2026-09-24

## 0. 开头自检

| 项 | 结果 |
|---|---|
| pwd | `/Users/kzf/Pictures/贴钻-backend`（分支 `add-backend-platform-impl`） |
| HEAD | 评审开始时 `d56ce21`；评审期间编排者追加了 `3eea349`（**仅 tasks.md 勾选 25 处**，`git show 3eea349 --stat` 确认单文件，`d56ce21` 仍是其祖先）——不在本评审范围，代码零变化 |
| 双 commit ancestry | `9371b7c` ⊂ `8bc042c` ⊂ `d56ce21`（merge-base --is-ancestor 双验通过） |
| 工作树 | 评审全程 `git status --porcelain` 零输出；探针文件（`daemon/.review-probes/`、`/tmp/review-s3-s7/`）已删净，仅余本报告 |
| `git diff --check 9371b7c..d56ce21` | CLEAN（无空白错误） |

## 1. 阻塞问题（P0）

**无。** 全部审查面（A/B/C/D 共 13 项）未发现阻塞级缺陷。

## 2. 可验证修复建议（P2——全部为边角/加固项，不阻塞验收）

### P2-1 `stones.list` SQL 面 `q` 未转义 LIKE 元字符——与 S4 MCP JS 面结果分歧
- **证据**：`daemon/src/stones/query.ts:79-84`——`q` 直接拼进 `%${filter.q.toLowerCase()}%` 的 LIKE 模式，`%`/`_` 作为通配符生效；对照面 `daemon/src/capability/stones.ts:648-654` 是 `String.includes` 字面子串。
- **探针实测**（隔离 DATA_ROOT，同库双面 6 组对比）：`supplier+family`/`q=白`/`sizeMm` 三组双面等值 ✓；**`q='%'`：SQL=2 条 vs JS=0 条；`q='J_1'`：SQL=1 条（`_` 通配命中 J51）vs JS=0 条**；注入串 `'; DROP TABLE stone_index;--` 双面 0 条、表完好（参数化成立，非注入面）。
- **影响**：RPC 真源查询面（UI）与 MCP 工具面（agent）对含元字符关键字返回不同结果——语义分叉，非安全问题。
- **修复建议**：`whereOf` 内对 `q` 做 `replaceAll('%','\\%').replaceAll('_','\\_')` 并在各 LIKE 后缀 `ESCAPE '\'`；补一组双面等价性对拍测试（同 filter 断言 SQL 面 cells === JS 面 cells）。

### P2-2 SS 云数据快照缺「与源 catalog.json 对拍」的锁死测试
- **证据**：`daemon/src/stones/cloud-catalog.ts:5-16` 头注承诺「升级=重新抄录+测试对拍」，但仓内测试（`daemon/tests/capability-stones.test.ts` S6.2 [9]）只做内部一致性（契约+diameterMm=ssSizeMm 锁死+五档覆盖），无任何测试触碰源文件。
- **评审代理独立对拍**（python，源=`贴钻/experiments/rhinestone-catalog-20260924/catalog.json`，按头注三裁剪规则 [1]63 条 ss → [2](label,color) 去重 53 → [3]rgb/colorName 取色表）：**53/53 条 label/colorName/rgb 零失配**——当前快照忠实，防漂移网缺。
- **修复建议**：补一个「快照 ↔ 源文件」对拍测试（若依「不跨仓引用」纪律则改为升级手册检查单 + 本对拍脚本入库 `daemon/scripts/`）。

### P2-3 set.* 缺 MCP 线上（over-the-wire）冒烟——S4 先例有、本波未跟
- **证据**：S4 的 `capability-stones.test.ts:932`（MCP listener 真往返 initialize→tools/list→tools/call stones_list）先例存在；本波 `capability-sets.test.ts:496-573` 只做了 registry 面（23 工具名册+mcpToolName 纯函数投影+重名 fail fast+registry 真调 set.list 一条），**无 tools/list 线上 23 工具、无 tools/call set_* 真往返**。kernel 装配点（`daemon/src/kernel/index.ts:118-125`）无专属测试（由同构组合测试代表）。
- **影响**：低（投影机制与 S4 共享、mcpToolName 是纯函数且已断言五名），但「23 工具投影」这条链少一层线上实证。
- **修复建议**：照 `capability-stones.test.ts:932` 模式补一条：MCP listener initialize→tools/list 断言 23 名含 set_*→tools/call set_list 真调。

### P2-4 origin 跨类杂质字段未拒（schema 冻结面遗留的服务层校验缺口）
- **证据**：`contracts/src/sets.ts:50-62` 三个 optional 字段对任意 kind 开放（设计明言「origin 字段间的完整性归 daemon 服务层校验」）；服务层只验了 clone 缺 fromSetId（`daemon/src/stones/sets-service.ts:269-271`）、clone 双源（:272-277）、bom 冻结拒（:259-267），**未拒** `manual-pick+fromSetId` / `clone+sourceTaskId` 这类跨类字段——实测 `ProductionSetOriginSchema.safeParse({kind:'manual-pick',fromSetId:'set-x'})` 通过并会随 set.json 落库。
- **影响**：数据卫生（溯源字段可被塞入无意义值），无行为分叉。
- **修复建议**：`createSet` 来源分派处按 kind 白名单收窄 origin 字段（manual-pick={kind}、clone={kind,fromSetId}），杂质 typed `invalid-origin` 拒。

### P2-5 递归 CTE 用 UNION ALL——直改 DB 造环会挂起（加固项，服务路径不可达）
- **证据**：`daemon/src/stones/query.ts:213-217`（tree CTE）与 `sets-service.ts:599-608`（subtreeIds，照 S1 同构）均为 `UNION ALL`；`parent_id` 全部写路径（insert/ensureChildDir/updateStone 色系重指）不产生环，唯直改 DB 可造环 → 无限递归。深递归实测 50 层链构树正常（探针 B6-2）。
- **修复建议**：`UNION ALL`→`UNION`（id 唯一，去重即天然终止），零成本加固；顺带在 `resolveMember` 注释（`sets-service.ts:384`）与行为对齐——wrong-kind 且投影行残存（json 损坏）时限定名实际可得，注释写的是「缺席」。

## 3. 审查面逐项裁定

### A. S7 引用集语义（核心）

**A.1 三不变量测试真实性 —— 通过（真路径，非 mock）**
- 不变量①：`daemon/tests/sets-service.test.ts:213-239`。真跑 `stones.updateStone` 贴图替换（128/48→160/40，六 gate 实测 alphaBounds 96px→80px），断言 set.json `content_hash` 前后相等 + `revision`/`updatedAt` 双冻结。**评审探针独立复演**（probe A1）：`{"x":16,"y":16,"w":96,"h":96}→{"x":40,"y":40,"w":80,"h":80}`+width 160，hash/revision/updatedAt 三冻结全真——「标准原子被更新」路径真实到达，组合零写。
- 不变量②：`sets-service.test.ts:241-272` 四态全真造：familyDir=wrong-kind、randomUUID=not-found、`stones.softDelete`=soft-deleted、`rmSync(blob pathFor)`=blob-missing；每步断言 `set.stones` 长度不变（不剔除）+软删/blob-missing 态限定名经 stone_index 投影行可得（`yuhang/J51`）。
- 不变量③：`sets-service.test.ts:274-311` clone 浅拷贝：母组合删成员后副本仍 2 条（零联动）；标准原子 sizeMm 2→3 后母/副本双跟随（仍指原子非拷贝）。clone 校验族（缺 fromSetId/双源/不存在/跨 owner `owner-mismatch`/软删母 `soft-deleted`）全覆盖（:313-346）。

**A.2 限定名 —— 通过（service+MCP readonly 双面真验）**
- 纯函数：`contracts/src/sets.ts:81-88`，歧义（空段/含 `/`）显式 throw；`contracts/src/sets.test.ts:99-110` 四拒用例。
- 双面：service 面 `sets-service.test.ts:351-373`（yuhang/J51 与 factoryB/J51 同组合并存互异）；MCP readonly 面 `capability-sets.test.ts:464-473`（set.get 成员投影 `['yuhang/J51'],['factoryB/J51']` 双值断言）。均为真库真调用。

**A.3 set CRUD 授权面 —— 通过（零新授权语义，逐行同构）**
- 无授权直调：`capability-sets.test.ts:174-201`——三写工具随机 proposalId 直调=principal-forbidden；已 propose 未批准执行=grant-missing→principal-forbidden；未装配 approvals 面=一律 principal-forbidden；propose 后库内零组合（listSets=0）。
- 同构度：`capability/sets.ts:243-264` `executeApprovedLocal` 与 `capability/stones.ts:489-513` **逐字一致**（consumeForExecution→fn→settleExternal 同一事务）；`mutationAuth.precheck` 包装（`sets.ts:722-734` vs `stones.ts:1446-1455`）同构；`approvals.ts` 本波仅增 ProposalPayload 类型联合（零行为变更）；authorization.ts 零 diff。
- clone CAS 绑母组合：`sets.ts:452-454` propose 绑 `{resourceId:母, baseRevision}`→`authorization.ts:334-348` 执行时 CAS；漂移测试 `capability-sets.test.ts:421-438`：批准期间母组合 addMembers→execute STALE+零克隆落库，真跑。
- 执行模式互斥（带 propose 字段+proposalId 必拒）测试在册（:203-214）。

**A.4 S7.6 冻结位四件套 —— 构成完整「执行链不可达」证明**
- schema 导出：`capability/sets.ts:57-64`（SetCreateFromBomInputSchema strict，`taskId+sourceTaskId`，测试 :383-387 三态验证）；
- typed error 同码：常量 `BOM_SOURCE_NOT_IMPLEMENTED`（:67）=service 错误码 `bom-source-not-implemented`（`sets-service.ts:53-54`）；capability propose 拒（`sets.ts:432-438`，零 proposal 落库断言 :370-381 `proposalCount===0`）+service 直调同码拒（`sets-service.test.ts:495-512`，含 `stone-set` 行数=0 的零落库断言）；
- 不设 approval 族：`db/approvals.ts:49-56` 类型联合只有 set-create/set-update/set-delete 三 kind，**无 set-create-bom**；
- 不注册第六工具：definitions 仅五工具（`sets.ts:303-718`）。四件合围：唯一入口 set.create 在 propose 与 execute（service）双重同码拒，proposal 面不可达→执行链不可达。✔

### B. S3 查询/资产面

**B.5 stones.list SQL 组装 —— 通过（一处 P2-1 分歧）**
- 参数化：全部条件 `?` 参数（`query.ts:53-84`）；注入探针（组6）表完好。分页 COUNT：`COUNT(*)` over 同 where（:110-112），与页数据同口径（测试 `stones-rpc.test.ts:164-184` 分页+groupBy 全过滤集断言）。groupBy DISTINCT over 全过滤集非当前页（:129-144，`familyFiltered` 用例证）。软删过滤 `trashed = 0`（:55，测试 :186-202）。
- 双面等价性探针：三组常规 filter SQL(JS) 完全等值；`%`/`_` 元字符分歧 → **P2-1**。

**B.6 stones.tree 递归 CTE —— 通过**
- 空库 `{rootId:null,node:null}`（探针 B6-1+测试 :237-243）；深递归 50 层直插链构树实测深度 50 不炸（探针 B6-2）；软删剪枝经**服务真路径**验证（测试 :260-277：J60 软删→红色系整枝剪除+includeTrashed 保留 trashed 标注）；显式坏根 BAD_REQUEST（:254）。环=直改 DB 才可达 → P2-5 加固注记。

**B.7 贴图 HTTP —— 通过**
- ETag 304 往返：测试 `stones-http.test.ts:141-164`（200+ETag=blob hash+字节等值+If-None-Match 304+HEAD）；**探针 B7 补贴图替换面**：替换后旧 ETag→200 新字节、新 ETag→304、ETag 始终==行 content_hash——「同 URL 新 hash」的 no-cache 声明实测成立。
- containment：路由 regex 单段（`http.ts:277`）+`decodeURIComponent(pathname)`（http.ts:259）后 `%2F`/`..` 解码含 `/` 不匹配路由→未知 API 404（测试 :189-192）；纯 `..` 行名 DB 精确匹配无行 404（:194-195）；401 双通道（Bearer/?token=）+坏 token（:124-138）。hash 一致性：探针 B7-6 `ETag=="${blobHash}"` 真。
- 与 S1 blob 一致：字节经 BlobStore 直读（`stones/http.ts:122-127`）。

**B.8 云数据融合 —— 通过（快照忠实性经独立对拍，锁死测试缺 → P2-2）**
- 53 条静态表：评审代理用源 catalog.json 按头注三裁剪规则独立推导——**53/53 label/colorName/rgb 零失配**；仓内锁死面=CloudCatalogEntry 契约+diameterMm≡ssSizeMm（测试 `capability-stones.test.ts` S6.2[9]，模块装载期档位闭集校验 `cloud-catalog.ts:82-87`）。
- fallback 语义探针（测试+读码双证）：库内有近邻→`cloudResults:[]`（`capability/stones.ts:964-965` `candidates.length===0 ? cloud : []`，测试「库优先」用例）；库空/无近邻→云候选按同容差过滤+ΔE 升序+null 殿后。
- 「非库存承诺」标注面：每条 `cloudReference:true`+note 字面（测试三用例全断言）。

### C. 跨波边界（重点）

**C.9 共享读 vs owner 隔离边界不串 —— 通过（独立探针实证）**
- 探针（同 kernel 组合 stones+set 双 registry，用户 B 的同一 task）：`set.list`→`{total:0}`（0 套 A 组合）；`set.get` A 的组合→failed「跨用户资源访问必拒」；**同 task** `stones.list`→total=1 见 A 建的 J51、`stones.get`→resolved+readScope=shared-library。两语义在同一注册表内并存不串。
- 附加语义验证：B 可建引用 A 原子的组合（成员=共享库弱引用，设计如此）；A 的 set.list 仍只见自己的 1 套（B 的组合对 A 不可见）——隔离是双向的。
- 写面不变：`capability-stones.test.ts` [7]（S4 修订版）——B 的任务对 A 的资源 update/delete 必拒「跨用户」+op 审计 user_id 归属不漂移。

**C.10 软删交叉 —— 通过（独立探针实证）**
- 组合引用的原子软删后：`stones.list` 默认 total-1 / includeTrashed 复现 trashed:true；`set.get` 成员态 `soft-deleted`（限定名经投影行仍可得）与 `resolved` 并存、存储清单长度不变；组合自身可见性不受成员软删影响（trashed:false）；`restore` 后双成员复位 resolved。includeTrashed 与 set.get 成员态**同源一致**（都吃 softDelete 同事务维护的投影列，`service.ts:455-485`）。

**C.11 kernel 23 工具注册回归 —— 通过（registry 面真测；线上面缺 → P2-3）**
- `capability-sets.test.ts:520-557`：23 名册（studio 10 抽样+stones 8 全列+set 5 全列）、五 mcpToolName 投影、重名 fail fast（duplicate capability registration）、authority 投影 readonly 2+approved-mutation 3；:559-572 compose 后跨 registry 真调 set.list ok。kernel 装配（`kernel/index.ts:118-125`）与测试同构。

### D. 合态质量

**D.12 独立重跑 —— 全绿**
- daemon vitest 全量（排除 e2e）：**36 文件 376/376**（=预期 376）；
- contracts：**8 文件 106/106**（=预期 106）；
- 双 typecheck（daemon `tsc --noEmit` + contracts `tsc --noEmit`）：零错误。
- 单文件计数：`sets-service.test.ts` 15 / `capability-sets.test.ts` 18 / `stones-rpc.test.ts` 11 / `stones-http.test.ts` 4 = 48 条新增。

**D.13 tasks.md 复选框**：评审期间编排者已以 `3eea349` 勾选（单文件 25 处，范围外）——不再列提醒；后续波次（S3.3-S3.4/S5/S7.4-7.5/S7.7 前端）仍为未勾。

## 4. 质量评价

- **架构纪律**：S7 组合层与 S1/S4 家族纪律严格同构——目录/文件行/blob 同事务四步形状、revision CAS 单点（目录行）、同父唯一名 ` (2)`、typed error 全显式（11 码）、strict schema 即不变量证明面（成员内嵌副本 schema 级拒，`contracts/src/sets.test.ts:57-79`）。引用集「读时解析」设计兑现干净：组合侧零同步机制、零投影表（§7.2 裁决自洽）。
- **测试真实性**：48 条新增测试全部真路径（真 SQLite+真 blob+真 gates；无一处 mock 核心语义面）——三不变量/四态/CAS 漂移/授权链全部可在探针中独立复现。S2S4 评审的 P1-1 教训（stub 吞覆盖）在本波未复发。
- **跨波缝合**：D-1 共享读修订正确落进三张面（RPC/MCP/HTTP）且写面 owner 审计不动；design.md §6 增补裁定记录（`design.md:259`）；S3 与 S7 同库协作（软删投影列同源）无缝。
- **弱点**：两查询面（SQL/JS）的 `q` 元字符分叉是唯一实质行为分歧（P2-1）；S4 有的线上 MCP 冒烟本波未跟（P2-3）；快照对拍与 origin 收窄属卫生项（P2-2/P2-4）。

## 5. 评分与结论

**综合评分：9/10**

评分依据：核心语义（引用集三不变量、限定名、授权桥复用、冻结位证明、D-1 双语义边界）全部经独立探针实证无缺陷（+）；测试全真路径且 376+106 全绿（+）；P0/P1 零（+）；扣 1 分于五项 P2——`q` LIKE 元字符双面分叉（行为级）、线上 MCP 冒烟缺位、快照对拍缺位、origin 杂质字段、CTE 环加固（各为边角，均有可验证修法）。

**GO** —— 可进入后续波次（S3.3-S3.4/S5/S7.4-7.5/S7.7 前端）；P2-1/P2-3 建议随下一波顺手修复，P2-2/P2-4/P2-5 可入 backlog。

与前波对比一句：较 S2S4（8/10，含一次 P1 修复回合）明显提升——本波零 P0/P1、跨波缝（共享读×owner 隔离×软删交叉）经独立探针逐条实证，唯一行为级瑕疵退到 LIKE 元字符边角。
