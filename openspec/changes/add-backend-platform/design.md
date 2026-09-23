# Design: add-backend-platform

> R1 修订（2026-09-23，codex-review-r1 8 项 P1 处置）：平台口径统一 darwin-arm64、§3.5 Agent 会话契约冻结、§3.6 批准授权桥、排布参数落契约、降级隔离、Node PNG 路线、§6.5 短会话留存矩阵、格式往返口径、zhumo 映射表修正（七表/进程 token/审批变体/异步 ComputeProvider）。

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
| DB | better-sqlite3 同步+user_version 迁移+WAL+**七表**（users/settings/wizard_steps/blobs/resources/tasks/results） | **复用六个核心表模式，省略向导表 wizard_steps**（产品变体）；新增 patch_history 表（§3.6 撤销组）；tasks.prompt→任务参数（贴钻域：模板/参数/产物引用）+`type ∈ {job, agent}` 区分引擎/生成作业与 agent 会话；results.bundle_path=导出包/分享页复用 |
| RPC | @orpc/client + RPCLink + 同源 /ws/rpc?token= | 同。**新 Agent 主面经统一 API façade（contracts 类型端到端）；旧三工作台的 fetch BYOK 直连路径随旗标退场，默认主面零本地密钥依赖**——不是「只加客户端层」即迁移完成 |
| 长任务 | 无队列：WS 帧流 /ws/tasks/:id + jsonl（任务目录 frames.jsonl）+ afterSeq 回放 | 传输/存储照抄；**contracts 中 Frame 按 kind 区分两族状态机**：job 帧（progress/log/artifact/done/error）与 agent 帧（增 transcript/approval-request/approval-resolved）——共用传输不共用状态机（§3.5） |
| Agent | dsh-* 进程内嵌 + cordis + presets + deny-list 双层收窄 + firehose Frame + 熔断 RUNAWAY_LIMIT=5 | 同；persona=贴钻 SKILL.md（产品手册全文注入）。**变体：dsh 依赖懒加载（动态 import）+ module-resolution 失败捕获——降级面见 §6.4** |
| 原子工具 | capability 三件套 + py 管线 stdout 末行 JSON；**registry 对 agent 主体一律拒绝 approved-mutation** | 工具=进程内 TS 直调引擎（引擎本就 TS）；**authority 变体（R1 冻结）**：approved-mutation 对 agent 主体放行当且仅当携带匹配的一次性批准凭据（§3.6 授权桥）——zhumo 原语义（agent 永不可 mutate）不够用，不照抄 |
| MCP | streamable-http 环回 + Bearer token（**daemon 启动生成一次、进程存活期复用——是进程周期 token，非一次性**） | 同（修正 R0 表述）；安全边界：仅绑定 loopback 可达、进程周期 token、泄露面=本机进程；不承诺轮换（开放项）。Phase 2 珠点检测才引入 py worker 时复用 zhumo stdout-JSON 契约 |
| 静态托管 | daemon 托管 dist + /r/{public_id} 分享页 + Range/containment | 同（/r/ 分享导出包）；**分享包资源闭包与留存语义见 §6.5** |
| GPU | 无此面 | **新增 ComputeProvider 缝（异步签名，§5）** |

## 3. 原子工具清单（Phase B，capability 面向 agent）

只读（readonly）：`studio.projects` / `studio.templates` / `studio.pave-preview`（同参预览）/ `studio.export-dryrun` / `studio.bom`
提议（proposal）：`studio.patch-propose`（区域级修改草案——生成 diff 预览，不动真值）
批准变更（approved-mutation，仅用户批准后凭 §3.6 授权可调）：`studio.patch-apply`（单 op 落库）/ `studio.generate`（发起图像任务）/ `studio.export`

### 3.4 排布参数契约（R1 冻结——「钻排列散」差异化主线的可实现真源）

以 `src/lib/engine` 现行 Zod/TS 输入类型为唯一真源，contracts 镜像冻结（实现期以引擎导出复核命名）：

- **region**（区域选择器，首版=用户可寻址的既有结构，**非自然语言图像识别**）：
  `{ kind: 'blocks', ids: BlockId[] } | { kind: 'layers', ids: LayerId[] }`
  自然语言→区域（「帽子」）由 agent 经只读工具查询 blocks/layers 元数据（名称/颜色/位置）后选定 ID；图像语义自动分解（Scene Graph）归 Phase 2 `add-scene-understanding`（见 docs/scene-understanding-验证与架构评估.md），本 change 不做。
- **density**：`{ percent: 0..100 }`（对齐引擎密度语义：钻数随 percent 单调不减；默认沿用引擎现值）
- **gap**：`{ minSpacingMm: number > 0 }`——**硬约束**：layout 后校验器（最小间距/spatial hash）失败即任务失败，不静默放宽
- **strategy**：引擎 layout 策略枚举（hex-thin / hex-pitch / poisson / hybrid，以 `src/lib/engine` 现行导出为真源）
- 非法值=Zod 拒绝并回 agent 可读错误（含字段/范围），不魔术兜底
- **proposal diff 字段**：`{ region, ops: [{ op: 'setDensity'|'recolor'|'setSpec', target, before, after }], preview: { beforeBlob, afterBlob }, estGemsDelta }`

**固定 fixture 断言（W4 测试门）**：同参 pave-preview 逐字节确定；density 上升⇒钻数单调不减；minSpacingMm 违例必失败；未批准时 patch-propose 后真值零变化。

### 3.5 Agent 会话契约（contracts 冻结——W3 mock 与 W4 实现共用的唯一真源）

```
session.create  {title?}                          → {sessionId, createdAt}
session.list    {cursor?, limit?}                 → {sessions[], nextCursor?}
session.followup {sessionId, text, attachments?: [blobRef]} → {taskId}    // 一次 followup=一个 type=agent 的 task
session.answer  {sessionId, requestId, approved}  → {ok}                  // approval-request 帧的应答协议（ask_user）
session.cancel  {sessionId | taskId}              → {ok}
session.replay  {sessionId, afterSeq}             → {frames[], nextSeq}   // 断线回放，游标语义同任务帧流
session.result  {sessionId}                       → {resultId, publicId?, bundle: {svg, bom, png: blobRef}}

Frame（Zod）：{seq, ts, kind, payload}
  job 帧：  progress | log | artifact | done | error
  agent 帧：transcript | approval-request | approval-resolved | done | error
  approval-request.payload  = {requestId, tool, opDigest, preview:{before,after}, summary, expiresAt}
  approval-resolved.payload = {requestId, approved, grantedAt}
```

- **所有权/生命周期**：session 1—N task（tasks.session_id，type=agent）；生成/引擎 job（type=job）可独立于 session 存在（基础工作流直发）；帧 jsonl 落任务目录（zhumo 模式）；afterSeq 每 task 单调。
- **开发序（R1 冻结）**：contracts 冻结 → W3 前端按固定 fixture 帧序列 mock 开发 → W4 服务端实现同一契约 → **产品 MVP 验收=W4 接线后的联调集成用例（W4.4），W3 mock 完成不构成 MVP**。
- W4.4 集成用例（确定性模型/工具替身）：创建会话→收帧→回答审批→结果链接→断线回放，全链断言。

### 3.6 批准授权桥（R1 冻结——approved-mutation 的服务端可验证授权）

zhumo registry 对 agent 主体一律拒绝 mutation；贴钻变体引入**一次性批准凭据（grant）**：

1. agent 调 `studio.patch-propose` → 服务端生成 proposal（含 ops 与 opDigest=ops 内容摘要）
2. 前端收 approval-request 帧 → 用户批准 → `session.answer(approved=true)` → 服务端签发并持久化 grant：`{taskId, opDigest, userId, expiresAt, nonce}`（一次性）
3. agent 调 `studio.patch-apply` 必须携带 nonce；capability authority 判定：principal=agent **且** grant 的 {taskId, opDigest, userId} 全匹配且未过期未消费 → 放行**恰好一次**（消费即焚）
4. 必拒路径（测试门）：无 nonce 直调 MCP 必拒；批准别的 op（digest 不匹配）必拒；过期必拒；重放（已消费 nonce）必拒
5. **一次撤销恢复整组**：patch_history 表 append-only 记录 `{groupId(=批准批), op, nonce, appliedAt}`；undo(groupId)=按逆序回退该组全部 op——持久化实现，兑现 spec 承诺

## 4. Phase 划分（tasks 对应）

- **W1 地基**：workspace+contracts+daemon 骨架（http/auth/config/db 迁移/BlobStore）+ 匿名默认开 + .env 族 + 引擎 smoke gate（tsx 真实调用 layout/exportSvg）+ E2E 冒烟（daemon 起→匿名登录→bootstrap）
- **W2 服务面**：生成代理（图像 API 服务端调用）+ 引擎 API 化（排钻/校验/导出重活；**Node PNG=纯 TS 软光栅+PNG 编码，§6.3**）+ tasks/results 接线 + WS 帧流 + 静态托管 SPA + /r/ 分享
- **W3 Agent 主面**（产品形态核心）：按 §3.5 冻结契约开发（mock fixture 并行）；zhumo webui 形态移植——会话列表/会话流（帧流消费+审批应答）/结果页（/r/ 分享）；三工作台 UI 收进开发者旗标（默认隐藏，零维护投入）；**测试分类冻结（§6.6）**；短会话 clear+留存矩阵（§6.5）
- **W4 Agent 后端**：dsh 懒加载挂载+capability 工具（§3/§3.4——排布四参数一等公民）+授权桥（§3.6）+MCP 环回+firehose+熔断；**降级三态 E2E（§6.4）**；「把这块区域改密一点/换成金色」对话旅程=产品主旅程验收（W4.4 替身集成用例=验收门）
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

- rhinestone-studio 既有测试/引擎/组件零改动（只加 exports 与 api 客户端层）；daemon 自带 vitest；contracts 双端单测
- **格式演进口径（R1 修正）**：不承诺**跨版本向后兼容**（Owner 裁决无兼容红线——旧版本文件可显式拒读并报版本错误，不静默丢字段）；**当前版本内**四族格式（.gemproj/.gemdoc/.gemtpl/.gemgen）与服务器资源模型的**语义无损往返**为 MUST（fixture 验证字段/资产引用/顺序/工程参数零丢失；不要求字节相等）
- 排布差异化主线：客户反馈「排列散/星星点点」= 引擎密度/结构化排布是产品差异化核心，W2 引擎 API 与 W4 agent 工具面按 §3.4 冻结契约把密度/间距/排布模式/区域一等公民暴露
- E2E：zhumo w7b-e2e 模式（起 daemon→匿名→上传→任务→断言，--dry-run 无 key 回归）

### 6.3 服务端 PNG 路线（R1 冻结）

现有引擎 barrel 只导出 SVG/BOM；`designer/pngRender.ts` 依赖 `document.createElement('canvas')`/`Image`/IndexedDB `assetStore`，daemon 不可直调。**W2 服务端 PNG=纯 TS 软光栅**（钻点圆填充+分层合成，Node `zlib` PNG 编码），输入=BlobStore 字节+解析后的 shape/颜色数据——**不引入原生依赖**（@napi-rs/canvas 为备选记录），无 `document`/IndexedDB/浏览器全局。测试门：Node 进程内以真实 fixture 导出，断言像素/尺寸/错误分支——仅 import barrel 的 smoke 不算数。浏览器端既有 pngRender 保持不变。

### 6.4 降级隔离（R1 冻结——agent 面故障不殃及基础工作流）

基础作业（上传→生成→排钻→导出→分享）与 agent 会话为**独立服务/端点/状态**：

- dsh 内核依赖**懒加载**（动态 import），module-resolution 失败（缺包/坏包）同样进入降级分支
- 仅 agent/session/MCP 相关端点返回 501；type=job 任务与基础工作流在 DSH off、缺包、boot throw 三种状态下均保持完整可用
- 三种 E2E（W4 测试门）：DSH off（显式关闭）/ boot throw（模拟挂载异常）/ 正常 Agent——前两条断言基础工作流全链绿+agent 面 501，第三条断言全功能

### 6.5 短会话生命周期与留存矩阵（R1 冻结）

Owner 裁决：「用完→下载结果→清空会话走人」，存储可激进回收。

| 资产 | session.clear 时 | 依据 |
|---|---|---|
| 会话行/task 行（type=agent） | 删除 | 短会话语义 |
| 任务帧 jsonl | 随 task 删除 | 回放价值止于会话 |
| 上传原图/生成图/中间物 blobs | 解引用，ref_count 归零即物理删除 | 激进回收 |
| 下载 bundle 产物 | 随会话回收（下载即时性，不长期保留） | 已落到用户手里 |
| **public_id 分享包** | **保留**：bundle 引用的 blob 标记 shared（ref_count 与会话解耦，clear 不触发删除）；默认 TTL 7 天（.env 可调）或显式 revoke 时回收 | 分享是核心旅程；闭包自包含无悬空 |

- `session.clear {sessionId}` 原子语义：单事务内删行+解引用+删 jsonl；失败整体回滚，无悬空引用
- 并发：clear 进行中分享包并发访问不受影响（shared 标记先行）；失败重试幂等（已删=成功）
- 测试门（W3/W4）：删除原子性/失败恢复/共享 blob 双引用/分享链接并发访问/清理后无悬空+保留分享仍可下载

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
