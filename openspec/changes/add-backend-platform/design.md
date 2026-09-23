# Design: add-backend-platform

> R1 修订（codex-review-r1 8 项 P1 处置）：平台口径统一 darwin-arm64、§3.5 Agent 会话契约冻结、§3.6 批准授权桥、排布参数落契约、降级隔离、Node PNG 路线、§6.5 短会话留存矩阵、格式往返口径、zhumo 映射表修正（七表/进程 token/审批变体/异步 ComputeProvider）。
> R2 修订（codex-review-r2 B1-B8 处置）：§3.4 按引擎真源逐字段重写（五策略含 cvt/density (0,1]/gapMm/dropped 语义/region 收敛 blocks）、§3.5 replay 游标 task 域+session.clear+result 确定性选择、§3.6 授权桥全工具面+服务端内部消费（nonce 零出服务端）+revision CAS、§6.3 PNG V1 形状清单（custom 缺资产=显式拒绝）、§6.4 四态降级 E2E+MCP 独立 loopback listener、§6.5 跨介质清理状态机+result→blob 引用行、护栏「实现零改动≠测试零改动」。
> R3 修订（codex-review-r3 两 P1+四 P2 处置）：§3.6 外部副作用持久 operation 状态机（本地 proposalId 幂等/外部调用诚实降级 unknown+用户裁决重试）+撤销范围按族拆分（patch 整组逆序回退；generate=cancel+产物清理；export=revoke+bundle 释放）、§6.5 并发栅栏（clearing 原子拒新+取消 drain+writer CAS fence+blob deleting 防复活+unlink 前 CAS 重验）+cleared tombstone、exportGate 真实 API 名（ExportGateVerdict.ok）、PNG 独立错误码 PNG_ASSET_UNRESOLVED、四态口径统一。

## 0. 依据

zhumo 架构侦察（本会话 Explore 报告，权威规范=zhumo `PRODUCT_DESIGN.md` v0.2）+ Owner 六决策 + docs/后端化方案讨论-v1.md v1.1。本设计=「照抄清单 + 贴钻变体」两列表驱动，凡 zhumo 已验证的模式不重新发明。

## 1. 总体架构

```
repo 根（pnpm workspace）
├── rhinestone-studio/     # 现有前端（Svelte5+Vite8+shadcn+Tailwind4——与 zhumo webui 同构）
│   └── src/lib/engine     # 纯 TS 引擎：加 package.json exports → daemon workspace 依赖，零搬家
├── daemon/                # Node TS 服务（tsx 直跑；darwin-arm64 首发，win/linux 延后另立 change）
│   ├── http.ts            # 静态托管 SPA（无点路径回退 index.html；Agent 主面+旗标后的传统三工作台）+ /ws/rpc + /ws/tasks/:id + /api/*
│   ├── auth.ts config.ts  # zhumo 同款（匿名行/JWT/.env 自建回写）
│   ├── db/                # better-sqlite3 + user_version 迁移 + BlobStore(sha256+ref_count)
│   ├── rpc.ts             # oRPC 路由（contracts 包类型端到端）
│   ├── jobs/              # 长任务（生成代理/引擎重活）→ 帧流（jsonl+afterSeq）
│   ├── capability/        # 原子工具 registry（Zod/authority/熔断）+ 批准授权桥（§3.6）
│   ├── mcp.ts             # streamable-http 环回（Bearer 进程周期 token，仅 loopback）
│   ├── kernel/            # dsh-agent 挂载（boot/profile/presets/deny-list/firehose；懒加载，失败仅降级 agent 面）
│   └── compute/           # ComputeProvider 接口缝（异步）+ InlineProvider（本机）
└── contracts/             # Zod schema 前后端唯一真源（Role/TaskStatus/Frame/各端点 IO/Agent 会话契约 §3.5）
```

## 2. zhumo → handicraft 模式映射表（R1 已按源码逐行核验修正）

| 面 | zhumo 实现（照抄） | handicraft 变体 |
|---|---|---|
| monorepo | shufa-server 三包 pnpm@10；contracts 以 workspace source exports | repo 根 workspace：rhinestone-studio（存量）+daemon+contracts；pnpm@12 沿用本仓。W1 冻结 workspace glob/根 lockfile/脚本与 `rhinestone-studio` 包名，daemon 以 `workspace:*` 依赖 `./engine` subpath；**smoke gate=daemon 的 tsx 真实 import `rhinestone-studio/engine` 并调用 `layout`/`exportSvg`（不只 typecheck）** |
| 运行 | tsx src/index.ts 零编译；127.0.0.1 默认 host | 同；端口另选；webui dist 入库分发（克隆即跑）——**启动时 dist 缺失/损坏=明确报错并给出构建命令；CI 校验 dist 与源一致（stale 门禁）**。目标平台按 P1-1 收敛 darwin-arm64 |
| 账户 | __anonymous__ 行+开关+JWT{sub,role}+owner_id 贯穿+禁写不禁读+admin 豁免 | 同，**allow_anonymous 默认 '1'**（Owner：默认单账户）。**admin 建号唯一流程（R1 冻结）**：仅经 `.env ADMIN_USERNAME/ADMIN_PASSWORD`——daemon 启动时幂等 upsert admin 行；轮换=改 .env 重启；丢失=删行后同流程重建；首版无管理设置页（开放项可推翻）。多账户并存互不可见 |
| 密钥 | .env 模板自建/0600/原位回写 + settings 表优先双层真源 + 半配置=未配置 | 同；键族=图像 API（IMG_BASE_URL/IMG_API_KEY/IMG_MODEL）+ Agent LLM（LLM_* 同 zhumo）+ JWT_SECRET/ADMIN_*/DATA_ROOT。**读面一律脱敏（键存在性+尾 4 位），写入口仅 .env 与 settings RPC（写入也脱敏回显）**；BYOK localStorage 路径随实验室旗标退场，Agent 主面不依赖浏览器本地密钥 |
| DB | better-sqlite3 同步+user_version 迁移+WAL+**七表**（users/settings/wizard_steps/blobs/resources/tasks/results） | **复用六个核心表模式，省略向导表 wizard_steps**（产品变体）；新增 patch_history（§3.6 撤销组）与 grants（§3.6 授权持久化）表；tasks.prompt→任务参数（贴钻域：模板/参数/产物引用）+`type ∈ {job, agent}` 区分引擎/生成作业与 agent 会话；results=result→blob 引用行（§6.5 分享包独立 TTL/revoke） |
| RPC | @orpc/client + RPCLink + 同源 /ws/rpc?token= | 同。**新 Agent 主面经统一 API façade（contracts 类型端到端）；旧三工作台的 fetch BYOK 直连路径随旗标退场，默认主面零本地密钥依赖**——不是「只加客户端层」即迁移完成 |
| 长任务 | 无队列：WS 帧流 /ws/tasks/:id + jsonl（任务目录 frames.jsonl）+ afterSeq 回放 | 传输/存储照抄；**contracts 中 Frame 按 kind 区分两族状态机**：job 帧（progress/log/artifact/done/error）与 agent 帧（增 transcript/approval-request/approval-resolved）——共用传输不共用状态机（§3.5） |
| Agent | dsh-* 进程内嵌 + cordis + presets + deny-list 双层收窄 + firehose Frame + 熔断 RUNAWAY_LIMIT=5 | 同；persona=贴钻 SKILL.md（产品手册全文注入）。**变体：dsh 依赖懒加载（动态 import）+ module-resolution 失败捕获——降级面见 §6.4** |
| 原子工具 | capability 三件套 + py 管线 stdout 末行 JSON；**registry 对 agent 主体一律拒绝 approved-mutation** | 工具=进程内 TS 直调引擎（引擎本就 TS）；**authority 变体（R1 冻结）**：approved-mutation 对 agent 主体放行当且仅当携带匹配的一次性批准凭据（§3.6 授权桥）——zhumo 原语义（agent 永不可 mutate）不够用，不照抄 |
| MCP | streamable-http 环回 + Bearer token（**daemon 启动生成一次、进程存活期复用——是进程周期 token，非一次性**） | 同（修正 R0 表述）；安全边界（R2）：**独立 loopback listener 专用端口**（HOST 开局域网不随行暴露，见 §6.4）+ 进程周期 token、泄露面=本机进程；不承诺轮换（开放项）。Phase 2 珠点检测才引入 py worker 时复用 zhumo stdout-JSON 契约 |
| 静态托管 | daemon 托管 dist + /r/{public_id} 分享页 + Range/containment | 同（/r/ 分享导出包）；**分享包资源闭包与留存语义见 §6.5** |
| GPU | 无此面 | **新增 ComputeProvider 缝（异步签名，§5）** |

## 3. 原子工具清单（Phase B，capability 面向 agent）

只读（readonly）：`studio.projects` / `studio.templates` / `studio.pave-preview`（同参预览）/ `studio.export-dryrun` / `studio.bom`
提议（proposal）：`studio.patch-propose`（区域级修改草案——生成 diff 预览，不动真值）
批准变更（approved-mutation，仅用户批准后凭 §3.6 授权可调）：`studio.patch-apply`（单 op 落库）/ `studio.generate`（发起图像任务）/ `studio.export`

### 3.4 排布参数契约（R2 按 `src/lib/engine` 真源逐字段修正）

以引擎现行导出为唯一真源、contracts 直接引用（**不再自造字段名/口径**；下述均已在源码核验：`types.ts` STRATEGY_IDS/LayoutOptionsSchema/GridSpecSchema、`spec.ts` SHAPE_IDS、`layout/index.ts` 主入口）：

- **strategy**：`StrategyIdSchema` = `z.enum(['hex-thin','hex-pitch','poisson','hybrid','cvt'])`——**五值**（R1 漏 cvt 已修正），contracts 直接 re-export
- **density**：引擎口径 `number (0,1] | Record<blockId, (0,1]>`（全局或逐块覆盖，默认 1；`LayoutOptionsSchema.density`）。产品 UI 若要百分比，adapter 负责换算，契约层保持引擎口径
- **gap**：引擎口径 `gapMm ≥ 0`（`GridSpec.gapMm`，0=相切；钻心最小间距 `pitchMm = 钻径 + gapMm`，经 `gridFromSpec(spec, gapMm, pixelsPerMm)` 派生）——不是独立的 minSpacing 参数
- **seed / relax**：`LayoutOptions` 同款（seed int≥0 默认 1 保确定性；relax.boundary/repulsion 默认 false）
- **region**（区域选择器，首版**收敛为 blocks ID**）：`{ kind: 'blocks', ids: BlockId[] }`——引擎无 layer 概念（layers 是设计师文档域），layer→blocks 解析不做、归后续 change；自然语言→区域由 agent 经只读工具查询 blocks 元数据（颜色/位置/面积）后选定 ID，图像语义自动分解归 Phase 2 `add-scene-understanding`（docs/scene-understanding-验证与架构评估.md）
- **间距失败语义（对齐引擎现实）**：`layout()` 对冲突钻走 `enforceMinDistanceCounted` **确定性剔除并计入 `dropped`**（LayoutResult.dropped，默认路径应为 0），job 不因间距失败；外部篡改钻集的 spacing 违例经 `validate` warnings → `exportGate()` 返回 `ExportGateVerdict {ok, violations}`（`ok===false` 阻断导出；`isExportable(warnings)` 是 validate.ts 的独立函数，不属本调用链）。契约沿用该语义：`dropped` 在 proposal diff 与帧流中呈现供用户裁决，`exportGate().ok===false` 为最终硬门
- 非法值=Zod 拒绝并回 agent 可读错误（含字段/范围），不魔术兜底；空 region / blockId 不存在=显式拒绝
- **proposal diff 字段**：`{ region, ops: [{ op: 'setDensity'|'recolor'|'setSpec', target, before, after }], preview: { beforeBlob, afterBlob }, estGemsDelta, dropped }`

**固定 fixture 断言（W0.2/W4 测试门）**：契约输入经 adapter 后与直调 `layout()` 等价（同参同输出）；同参 pave-preview 确定；density 上升⇒钻数单调不减；`dropped` 语义如实呈现；空 region/不存在 ID/负 gapMm/越界 density 显式拒绝；未批准时 patch-propose 后真值零变化。

### 3.5 Agent 会话契约（contracts 冻结——W3 mock 与 W4 实现共用的唯一真源）

```
session.create  {title?}                          → {sessionId, createdAt}
session.list    {cursor?, limit?}                 → {sessions[], nextCursor?}
session.get     {sessionId}                       → {session: {id,title,status,createdAt,updatedAt}, tasks: [{taskId,status,lastSeq,frameCount}]}
session.followup {sessionId, text, attachments?: [blobRef]} → {taskId}    // 一次 followup=一个 type=agent 的 task
session.answer  {sessionId, requestId, approved}  → {ok}                  // approval-request 帧的应答协议（ask_user）
session.cancel  {sessionId | taskId}              → {ok}
session.clear   {sessionId}                       → {ok}                  // 短会话清理（§6.5 状态机）
session.replay  {sessionId, taskId, afterSeq}     → {frames[], nextSeq}   // 回放游标以 task 为域（session 1—N task，各 task seq 独立从 1 单调）
session.result  {sessionId}                       → {resultId, taskId, publicId?, bundle: {svg, bom, png: blobRef}}  // 默认=最新完成的 agent task（completedAt 最大，平局取 taskId 大者——确定性）
task.result     {taskId}                          → {resultId, publicId?, bundle}   // 指定 task 的结果（无结果=显式 not_found，不回退到别的 task）

Frame（Zod）：{seq, ts, kind, payload}
  job 帧：  progress | log | artifact | done | error
  agent 帧：transcript | approval-request | approval-resolved | done | error
  approval-request.payload  = {requestId, tool, proposalId, preview:{before,after}, summary, expiresAt}
  approval-resolved.payload = {requestId, approved, resolvedAt}   // grant/nonce 不出现在任何帧或 API 载荷（§3.6 服务端内部关联）
```

- **所有权/生命周期**：session 1—N task（tasks.session_id，type=agent）；生成/引擎 job（type=job）可独立于 session 存在（基础工作流直发）；帧 jsonl 落任务目录（zhumo 模式）；afterSeq **每 task 独立**单调（W0.1 测试：一个 session 两个 task 各自 seq 从 1 起，分别回放无重帧/漏帧）。
- **开发序（R1 冻结）**：contracts 冻结 → W3 前端按固定 fixture 帧序列 mock 开发 → W4 服务端实现同一契约 → **产品 MVP 验收=W4 接线后的联调集成用例（W4.4），W3 mock 完成不构成 MVP**。
- W4.4 集成用例（确定性模型/工具替身）：创建会话→收帧→回答审批→结果链接→断线回放，全链断言。

### 3.6 批准授权桥（R2 收敛——grant 全 approved-mutation 工具面+服务端内部消费+revision CAS）

zhumo registry 对 agent 主体一律拒绝 mutation；贴钻变体引入**服务端内部关联的一次性授权（grant）**：

1. **批准对象覆盖全部 approved-mutation 工具**（patch-apply / generate / export 三者同规）：agent 调 proposal/readonly 工具产出草案 → 服务端生成 proposal `{proposalId, taskId, opDigest(内容摘要), resourceId, baseRevision, expiresAt}` 并持久化
2. 前端收 approval-request 帧（含 proposalId+preview）→ 用户批准 → `session.answer(approved=true)` → 服务端签发并持久化 grant：`{grantId, proposalId, taskId, opDigest, userId, resourceId, baseRevision, expiresAt, consumed}`——**grantId/nonce 不出现在任何帧、API 载荷或 MCP 工具参数里**
3. **消费路径（服务端内部关联）**：agent 调 approved-mutation 工具只带 `{proposalId}`；服务端在该 task 上下文内查未消费、未过期、{taskId, opDigest, userId} 匹配的 grant → 放行**恰好一次**（同事务标记 consumed，消费即焚）——凭据不经过 agent 可见的任何通道，泄露面=服务端进程内部
4. **revision CAS**：grant 绑定 `{resourceId, baseRevision}`（proposal 生成时的资源版本）；apply 时资源当前 revision ≠ baseRevision（批准等待期间被其他写入改动）→ **拒绝并要求重新 preview+approve**，杜绝按过时 before 覆盖新状态
5. 必拒路径（测试门）：无 grant 直调（agent 上下文无有效 proposalId）必拒；digest 不匹配必拒；过期必拒；重放（已消费）必拒；跨 task/user 使用必拒；revision 漂移必拒
6. **外部副作用的诚实 exactly-once（R3）**：approved-mutation 统一建模为**持久 operation 记录**（`approved_ops` 表，proposalId=唯一幂等键，状态机 approved→claimed→running→succeeded/failed/unknown）——先原子 claim 再执行。**本地确定性 op（patch-apply）=严格恰好一次**（claim+落库同事务）。**涉外部调用的 op（generate 远端图像 API）本地记录仍以 proposalId 幂等（一旦 succeeded 重试返回同一结果），但外部调用诚实降级**：provider 支持幂等键则透传；不支持（BYOK 转发站常态）则崩溃于远端接受后/写回前=unknown 状态，**不承诺外部恰好一次**——UI 呈现 unknown 由用户裁决重试（重试可能重复计费，如实告知）。export 无外部副作用（本地 bundle），按本地恰好一次处理
7. **撤销范围按族拆分（R3）**：「一次撤销恢复整组」**仅适用于 patch 族**（可逆操作，patch_history 逆序回退，回退也记 history）；generate 不可逆——补偿=cancel（未完成时）+产物清理（删结果 blob+撤引用）；export 补偿=revoke（分享包撤销+bundle 引用释放）。三族补偿语义各自冻结，不承诺跨族「撤销整组」

## 4. Phase 划分（tasks 对应）

- **W1 地基**：workspace+contracts+daemon 骨架（http/auth/config/db 迁移/BlobStore）+ 匿名默认开 + .env 族 + 引擎 smoke gate（tsx 真实调用 layout/exportSvg）+ E2E 冒烟（daemon 起→匿名登录→bootstrap）
- **W2 服务面**：生成代理（图像 API 服务端调用）+ 引擎 API 化（排钻/校验/导出重活；**Node PNG=纯 TS 软光栅+PNG 编码，§6.3**）+ tasks/results 接线 + WS 帧流 + 静态托管 SPA + /r/ 分享
- **W3 Agent 主面**（产品形态核心）：按 §3.5 冻结契约开发（mock fixture 并行）；zhumo webui 形态移植——会话列表/会话流（帧流消费+审批应答）/结果页（/r/ 分享）；三工作台 UI 收进开发者旗标（默认隐藏，零维护投入）；**测试分类冻结（§6.6）**；短会话 clear+留存矩阵（§6.5）
- **W4 Agent 后端**：dsh 懒加载挂载+capability 工具（§3/§3.4——排布四参数一等公民）+授权桥（§3.6）+MCP 环回+firehose+熔断；**降级四态 E2E（§6.4）**；「把这块区域改密一点/换成金色」对话旅程=产品主旅程验收（W4.4 替身集成用例=验收门）
- **W5 部署与缝**：darwin-arm64 私有化脚本（启动/自包含数据根/dist 入库+stale 门禁/better-sqlite3 与 tsx 预编译验证）+ ComputeProvider 缝（异步，Inline 实现）+ 文档 + 全量绿门；**win/linux 延后另立 change（本 change non-goal）**

## 5. ComputeProvider 缝（轻抽象，不做重；R1 异步化）

```ts
interface ComputeProvider {
  submit(spec, idempotencyKey): Promise<JobRef>   // 幂等：同键重放返回同 JobRef
  status(ref): Promise<JobState>
  result(ref): Promise<BlobRef>
  cancel(ref): Promise<void>
}
```

全异步（远程 submit/status/result/cancel 都可能等待网络）；spec 序列化格式即接口契约（版本化）。首实现 InlineProvider（进程内直跑=引擎调用）；未来适配器（AutoDL/RunPod/vast.ai 等成熟租赁 API）实现同一接口即接入。**不实现任何远程适配器**。

## 6. 护栏

- rhinestone-studio 既有**实现**（引擎/组件/逻辑代码）零改动（只加 exports 与 api 客户端层）；**测试文件允许按 §6.6 分类新增/更新**（如 app.globalImport.test.ts 双模式断言）——「实现零改动」不禁止测试的显式调整；daemon 自带 vitest；contracts 双端单测
- **格式演进口径（R1 修正）**：不承诺**跨版本向后兼容**（Owner 裁决无兼容红线——旧版本文件可显式拒读并报版本错误，不静默丢字段）；**当前版本内**四族格式（.gemproj/.gemdoc/.gemtpl/.gemgen）与服务器资源模型的**语义无损往返**为 MUST（fixture 验证字段/资产引用/顺序/工程参数零丢失；不要求字节相等）
- 排布差异化主线：客户反馈「排列散/星星点点」= 引擎密度/结构化排布是产品差异化核心，W2 引擎 API 与 W4 agent 工具面按 §3.4 冻结契约把密度/间距/排布模式/区域一等公民暴露
- E2E：zhumo w7b-e2e 模式（起 daemon→匿名→上传→任务→断言，--dry-run 无 key 回归）

### 6.3 服务端 PNG 路线（R2 冻结形状保真边界）

现有引擎 barrel 只导出 SVG/BOM；`designer/pngRender.ts` 依赖 `document.createElement('canvas')`/`Image`/IndexedDB `assetStore`，daemon 不可直调。**W2 服务端 PNG=纯 TS 软光栅**（Node `zlib` PNG 编码），输入=BlobStore 字节+**解析后的 shape 几何/资产字节+颜色数据**——不引入原生依赖（@napi-rs/canvas 为备选记录），无 `document`/IndexedDB/浏览器全局。

**V1 形状支持清单（对齐 `spec.ts` SHAPE_IDS）**：builtin 五形全支持（round/square/drop/heart/marquise——参数化几何路径光栅，含 rotationDeg 与透明背景）；custom 形经其 assetId 从 BlobStore 取资产字节解析渲染。**两类错误分别冻结（R3）**：custom 缺 assetId=对齐引擎 `CustomAssetIdMissingError` 语义（身份缺失 typed invalid）；assetId 存在但资产字节未解析/不可用=**服务端 PNG 独立 typed error `PNG_ASSET_UNRESOLVED`**（语义对应 exportGate 的 `missing-asset` violation，但不复用同一错误对象）——两者均显式拒绝，**禁静默降级画圆**（产物与 SVG/BOM 的形状预期不一致属静默替代，不许）。测试门：Node 进程真实 fixture 至少含 round、builtin 非圆、custom 资产形、缺失资产错误分支（两类错误各自断言），断言像素/尺寸/透明度/旋转；仅 import barrel 的 smoke 不算数。浏览器端既有 pngRender 保持不变。

### 6.4 降级隔离（R2 四态——agent 面故障不殃及基础工作流）

基础作业（上传→生成→排钻→导出→分享）与 agent 会话为**独立服务/端点/状态**：

- dsh 内核依赖**懒加载**（动态 import），module-resolution 失败（缺包/坏包）同样进入降级分支
- 仅 agent/session/MCP 相关端点返回 501；type=job 任务与基础工作流在降级状态下均保持完整可用
- **四态 E2E（W4 测试门）**：①DSH off（显式关闭）②缺包/坏包（独立进程+隔离模块解析器——临时破坏 dsh 包入口模拟 module-resolution 失败，boot throw 不能替代此态：静态/解析失败发生在不同加载路径）③boot throw（运行时挂载异常）④正常 Agent——前三条断言基础工作流全链绿+agent 面 501，第四条断言全功能

**MCP 监听隔离（R2 新增）**：MCP 端点跑在**独立 loopback listener**（仅绑 127.0.0.1 的专用端口），与主 HTTP daemon 分离——HOST=0.0.0.0 开局域网只暴露主 HTTP，MCP 永不随行暴露。集成测试：主 HTTP 从 LAN 地址可达而 MCP 从非 loopback 连接必拒（IPv4/IPv6/IPv4-mapped 全覆盖）。不以 bearer token 替代 loopback 声明。

### 6.5 短会话生命周期与留存矩阵（R2 收敛跨介质清理协议）

Owner 裁决：「用完→下载结果→清空会话走人」，存储可激进回收。

| 资产 | session.clear 时 | 依据 |
|---|---|---|
| 会话行/task 行（type=agent） | task 行删除；会话行保留 cleared tombstone（列表过滤，重复 clear 幂等 ok，默认 24h 例行清理物理删） | 短会话语义+崩溃恢复可重放 |
| 任务帧 jsonl | 随 task 删除 | 回放价值止于会话 |
| 上传原图/生成图/中间物 blobs | 解引用，ref_count 归零即物理删除 | 激进回收 |
| 下载 bundle 产物 | 随会话回收（下载即时性，不长期保留） | 已落到用户手里 |
| **public_id 分享包** | **保留**：结果经独立 **result→blob 引用行**持有自己的引用（与会话引用独立计数），clear 只撤会话侧引用；每个 result 独立 TTL（默认 7 天，.env 可调）与 revoke；TTL/revoke 到期回收时释放引用行，归零物理删除 | 分享是核心旅程；**不用 blob 级 shared 标记**（无法承载多个 result 的不同生命周期） |

**clear 跨介质清理协议（R2 状态机 + R3 并发栅栏）**：

1. DB 事务①：session.status→'clearing'（**同一事务内原子生效并发栅栏**，见下）+ 撤销私有 blob 引用 + 写 cleanup outbox（待删文件清单：帧 jsonl/将归零的 blob 文件）→ 提交
2. 事务外：**幂等 unlink**（按 outbox 逐个删文件；单文件失败不回滚，记 pending 重试）
3. DB 事务②：删除 task 行 + outbox 标记 done + session 保留为 **cleared tombstone**（不物理删行——列表查询过滤 cleared；重复 clear=幂等返回 ok；tombstone 随例行清理物理删，默认 24h）→ 提交
4. **崩溃恢复**：daemon 启动时重放未完成清理（clearing/outbox pending → 续跑至一致）；任何阶段崩溃重启后无悬空引用、无孤儿文件遗漏

**并发栅栏（R3）**：

- clearing 生效后，`session.followup`/`session.answer` **原子拒绝**（同一事务读 status）；运行中 agent task 在事务①**取消或 drain**（cancel 标记下发，worker 收到即停）
- **writer CAS fence**：帧/产物 writer 每次写入与「session/task 仍可写」校验同事务（fence 于 session.status 与 task 归属）——clearing 后无迟到帧、无孤儿产物
- **blob 复活防护**：引用归零的 blob 行置 `deleting` 状态（**阻止 ref 增回既有行**——新上传/新引用命中同 sha256 时**插入新行**，不复活 deleting 行）；**unlink 前在事务中 CAS 重验**（该 sha256 仅剩此 deleting 行才执行 unlink；否则放弃删除、行恢复 active）——另一 session 在 outbox pending 期间重新上传相同内容时，新行保有文件，无悬空
- 并发：clear 进行中分享包并发访问不受影响（result 引用行独立）；失败重试幂等（已删=成功）

**测试门（W3/W4）**：进程在①②③各阶段崩溃后重启恢复一致；clear 对活跃 task 的竞态（无迟到帧/无孤儿产物）；另一 session 在 outbox pending 时重新上传相同 sha256（无丢 blob/无悬空）；共享 blob 双引用（会话删/分享留）；分享链接并发访问；清理后无悬空引用+保留分享仍可下载；TTL/revoke 到期回收释放引用。

### 6.6 W3 测试分类（R1 冻结——「不维护旧 UI」≠跳过其测试）

Vitest 按 `src/**/*.test.ts` 收集，不受 localStorage 旗标影响，分类处置：

1. **默认无旗标（新增）**：进入 Agent 主面、三工作台导航隐藏、Agent API façade/会话状态正确
2. **显式启用旗标（保留）**：旧三工作台各至少 1 条可访问性冒烟；UI-only 测试**默认照跑**（测试内显式开旗标后 mount），保留/退役清单逐文件列明，不因默认隐藏自动 skip
3. **永跑门（与 UI 无关）**：引擎/持久化/格式/能力 Zod schema/patch/export gate 测试全量必跑；算法沉淀为 capability 后新增能力调用测试覆盖 agent 消费路径
4. **App 级格式导入路由（冻结）**：无旗标导入 .gemproj/.gemdoc/.gemtpl/.gemgen → 存入会话资源+可下载（不导航旧工作台）；开旗标 → 导航如旧。`app.globalImport.test.ts` 显式更新为双模式断言（列入 W3.3 清单，不留「零改动或以后更新」二选一）

## 7. 开放项（实现期裁决，标注可推翻）

- 端口号/数据根目录命名
- MCP token 轮换（首版进程周期 token+loopback-only，泄露面=本机——够用；多用户场景再议）
- BYOK 设置面在旗标后的形态（当前冻结：实验室面板保留只读，Agent 主面零浏览器密钥依赖）
