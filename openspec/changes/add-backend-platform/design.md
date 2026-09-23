# Design: add-backend-platform

## 0. 依据

zhumo 架构侦察（本会话 Explore 报告，权威规范=zhumo `PRODUCT_DESIGN.md` v0.2）+ Owner 六决策 + docs/后端化方案讨论-v1.md v1.1。本设计=「照抄清单 + 贴钻变体」两列表驱动，凡 zhumo 已验证的模式不重新发明。

## 1. 总体架构

```
repo 根（pnpm workspace）
├── rhinestone-studio/     # 现有前端（Svelte5+Vite8+shadcn+Tailwind4——与 zhumo webui 同构）
│   └── src/lib/engine     # 纯 TS 引擎：加 package.json exports → daemon workspace 依赖，零搬家
├── daemon/                # Node TS 服务（tsx 直跑；win/mac 私有化 + linux Docker）
│   ├── http.ts            # 静态托管 SPA（无点路径回退 index.html；Agent 主面+旗标后的传统三工作台）+ /ws/rpc + /ws/tasks/:id + /api/*
│   ├── auth.ts config.ts  # zhumo 同款（匿名行/JWT/.env 自建回写）
│   ├── db/                # better-sqlite3 + user_version 迁移 + BlobStore(sha256+ref_count)
│   ├── rpc.ts             # oRPC 路由（contracts 包类型端到端）
│   ├── jobs/              # 长任务（生成代理/引擎重活）→ 帧流（jsonl+afterSeq）
│   ├── capability/        # 原子工具 registry（Zod/authority/熔断）
│   ├── mcp.ts             # streamable-http 环回（Bearer 一次性 token）
│   ├── kernel/            # dsh-agent 挂载（boot/profile/presets/deny-list/firehose）
│   └── compute/           # ComputeProvider 接口缝 + InlineProvider（本机）
└── contracts/             # Zod schema 前后端唯一真源（Role/TaskStatus/Frame/各端点 IO）
```

## 2. zhumo → handicraft 模式映射表

| 面 | zhumo 实现（照抄） | handicraft 变体 |
|---|---|---|
| monorepo | shufa-server 三包 pnpm@10 | repo 根 workspace：rhinestone-studio（存量）+daemon+contracts；pnpm@12 沿用本仓 |
| 运行 | tsx src/index.ts 零编译；127.0.0.1:8217；HOST=0.0.0.0 局域网 | 同；端口另选；webui dist 可入库分发（克隆即跑）沿用决策 |
| 账户 | __anonymous__ 行+开关默认关+JWT{sub,role}7d+owner_id 贯穿+禁写不禁读+admin 豁免+三禁 | 同，**allow_anonymous 默认 '1'**（Owner：默认单账户）；安装向导简化（首启即匿名可用，admin 可后建） |
| 密钥 | .env 模板自建/0600/原位回写 + settings 表优先双层真源 + 半配置=未配置 | 同；键族=图像 API（IMG_BASE_URL/IMG_API_KEY/IMG_MODEL）+ Agent LLM（LLM_* 同 zhumo）+ JWT_SECRET/ADMIN_*/DATA_ROOT |
| DB | better-sqlite3 同步+user_version 迁移+WAL+六表 | 同六表；tasks.prompt→任务参数（贴钻域：模板/参数/产物引用）；results.bundle_path=导出包/分享页复用 |
| RPC | oRPC-over-WS + contracts + mock 逃生口 | 同 |
| 长任务 | 无队列：WS 帧流 /ws/tasks/:id + jsonl + afterSeq 回放 | 同（生成/引擎重活共用） |
| Agent | dsh-* 进程内嵌 + cordis + presets + deny-list 双层收窄 + firehose Frame + 熔断 RUNAWAY_LIMIT=5 | 同；persona=贴钻 SKILL.md（产品手册全文注入） |
| 原子工具 | capability 三件套 + py 管线 stdout 末行 JSON | **工具=进程内 TS 直调引擎**（引擎本就 TS）——无需 py 子进程契约；Phase 2 珠点检测才引入 py worker 时复用 zhumo 的 stdout-JSON 契约 |
| MCP | streamable-http 环回 + Bearer 一次性 token | 同 |
| 静态托管 | daemon 托管 dist + /r/{public_id} 分享页 + Range/containment | 同（/r/ 分享导出包） |
| GPU | 无此面 | **新增 ComputeProvider 缝**（见 §5） |

## 3. 原子工具清单（Phase B，capability 面向 agent）

只读（readonly）：`studio.projects` / `studio.templates` / `studio.pave-preview`（同参预览）/ `studio.export-dryrun` / `studio.bom`
提议（proposal）：`studio.patch-propose`（区域级修改草案：密度/色替换/规格——生成 diff 预览，不动真值）
批准变更（approved-mutation，仅用户批准后 agent 可调）：`studio.patch-apply`（单 op 落库）/ `studio.generate`（发起图像任务）/ `studio.export`
> 对应 Owner 场景「帽子改密度/改颜色」：agent 用区域选择+patch-propose→用户看预览→批准 apply。区域语义首版=图块/图层（选区/路径归 add-designer-selection-paths）。
工具面 deny-list：内核通用 fs/shell/web 全禁（zhumo KERNEL_DISABLED_TOOL_ROWS 同款）+ allowlist 只留 ask_user/todo + mcp__studio__*。

## 4. Phase 划分（tasks 对应）

- **W1 地基**：workspace+contracts+daemon 骨架（http/auth/config/db 迁移/BlobStore）+ 匿名默认开 + .env 族 + E2E 冒烟（daemon 起→匿名登录→bootstrap）
- **W2 服务面**：生成代理（图像 API 服务端调用）+ 引擎 API 化（排钻/导出重活）+ tasks/results 六表接线 + WS 帧流 + 静态托管 SPA + /r/ 分享
- **W3 Agent 主面**（产品形态核心）：zhumo webui 形态移植——任务会话列表/会话流（帧流消费+审批应答 ask_user）/结果页（/r/ 分享）；三工作台 UI 收进开发者旗标（localStorage 开关，默认隐藏，零维护投入）；BYOK 面随实验室隐藏自然退场
- **W4 Agent 后端**：dsh 挂载+capability 工具（§3 清单——排布四参数一等公民）+MCP 环回+firehose+熔断；「把帽子改密/换金色」对话旅程=产品主旅程验收（与 W3 的会话 UI 联调即产品 MVP）
- **W5 部署与缝**：win/mac 私有化脚本与适配清单+linux Docker+ComputeProvider 缝（Inline 实现）+文档+全量绿门

## 5. ComputeProvider 缝（轻抽象，不做重）

```ts
interface ComputeProvider { submit(spec): JobRef; status(ref): JobState; result(ref): BlobRef; cancel(ref): void }
```
首实现 InlineProvider（进程内直跑=引擎调用）。未来适配器（AutoDL/RunPod/vast.ai 等成熟租赁 API）实现同一接口即接入 GPU 池；spec 序列化格式即接口契约（版本化）。**不实现任何远程适配器**。

## 6. 护栏

- rhinestone-studio 既有测试/引擎/组件零改动（只加 exports 与 api 客户端层）；daemon 自带 vitest；contracts 双端单测
- **无兼容红线（Owner 裁决）**：正式发布前破坏性更新自由——四族文件格式按需随意演进（导出/下载能力保留——短会话「下载结果走人」是核心旅程；严格往返兼容测试不做）
- 排布差异化主线：客户反馈「排列散/星星点点」= 引擎密度/结构化排布（hex/density/分层）是产品差异化核心，W2 引擎 API 与 W4 agent 工具面都要把排布控制参数（密度/间距/排布模式/区域）一等公民暴露
- E2E：zhumo w7b-e2e 模式（起 daemon→匿名→上传→任务→断言，--dry-run 无 key 回归）
- W4 前每波 daemon 可独立交付（W1-W3 不依赖 agent 面；agent 挂载失败降级 501 不阻塞——zhumo 降级语义照抄）

## 7. 开放项（实现期裁决，标注可推翻）

- 端口号/数据根目录命名；实验室在前端的 BYOK 设置面保留为「服务端未配置时的只读提示」还是彻底删除
- followup 编辑的区域语义首版用图块还是图层（倾向图层——设计师已建）
