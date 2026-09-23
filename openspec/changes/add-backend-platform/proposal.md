# Proposal: add-backend-platform — 后端平台化（zhumo 模式移植）

## Why

**客户一线反馈（2026-09-23，Owner 转述）**：「提取还是蛮准，只是钻排列很散，星星点点的」——现有 ComfyUI 工具的提取准但**排布不可控**；客户要的是灵活排布。这正命中我们引擎的看家本领（六方定容网格/密度控制/分层排布），而 agent 化（对话调工具动态改排布）是把这份控制力交付给用户的形态。

Owner 2026-09-23 六决策（docs/后端化方案讨论-v1.md v1.1）：纯前端 → 双栈后端，Web 仅承载 UI，GitHub Pages 退役。参照系=Owner 的 zhumo 项目（/Users/kzf/Documents/书法，架构已侦察归档）。承载目标：①复杂工作上服务端（生成代理/重计算/持久化）②Agent 模式（基础工作流验证→原子工具→MCP→dsh-agent，满足「帽子改密度/改颜色」级灵活编排）③未来 GPU 珠点检测管线的宿主（另立项）。

## What Changes

**架构（zhumo 模式移植 + 贴钻变体）**：
1. **monorepo**：repo 根 pnpm workspace = `rhinestone-studio/`（现有前端，转 daemon 托管 SPA，**栈与 zhumo webui 完全同构**）+ `daemon/`（Node TS，tsx 直跑零编译）+ `contracts/`（Zod 前后端共享真源）；rhinestone-studio 加 package.json exports 暴露 `src/lib/engine` 供 daemon workspace 依赖（**引擎零搬家零重写**）
2. **部署（R1 收敛）**：**darwin-arm64 唯一首发平台**（Owner 2026-09-23 裁决：架构统一先行——better-sqlite3/tsx 预编译验证+启动脚本+自包含数据根+dist 入库克隆即跑）；Windows/Linux（含 Docker）**延后另立 change**（ASCII 路径/junction/容器化兼容面届时再做，CI 预留构建位）；GitHub Pages 退役（仓库 CI 保留构建）
3. **账户**：zhumo 同款——`__anonymous__` 内置行（幂等自愈）、JWT、owner_id 贯穿、禁写不禁读、role enum 预留收费；**变体：allow_anonymous 默认开**（Owner 裁决默认单账户）
4. **密钥**：zhumo 同款 .env（模板自建/原位回写/0600）+ settings 表优先的双层真源；图像 API 密钥（baseUrl/key）服务端集中
5. **API**：oRPC-over-WebSocket（contracts 包类型端到端）+ 长任务 WS 帧流（jsonl 持久化 + afterSeq 游标回放，**无队列无 SSE**）+ daemon 静态托管 SPA
6. **数据**：better-sqlite3（user_version 迁移）核心六表模式（复用 zhumo 七表中的 users/settings/blobs/resources/tasks/results，省略其向导表；blobs=sha256 内容寻址+引用计数；results=public_id 分享包）+ patch_history（批准撤销组，design §3.6）；**短会话生命周期冻结**（design §6.5：session.clear 原子回收+分享包留存矩阵）+ 文件格式（.gemproj 等）保留为导入导出交换格式（当前版本内语义无损往返为 MUST，跨版本不兼容——design §6）
7. **Agent 模式**（Owner 路线）：Phase A 基础工作流打通（上传→生成→排钻→导出全链服务端化，**与 agent 面故障隔离**——design §6.4）→ Phase B 拆原子工具为 capability（zhumo 三件套：registry/Zod/authority 只读-提议-批准变更；**变体：approved-mutation 经一次性批准凭据桥放行**——design §3.6）→ MCP streamable-http 环回（进程周期 token，loopback-only）→ dsh-agent 内核挂载（dsh-* npm 包**懒加载**进程内嵌、deny-list 双层收窄工具面、firehose 帧投影、熔断器）→ followup 续聊式编辑（「把这块区域改密一点/换成金色」）；**Agent 会话契约在 contracts 冻结**（design §3.5——W3 mock/W4 实现共用真源）
8. **GPU 抽象**（轻）：`ComputeProvider` 接口缝（submit/status/result/cancel），首实现=本机 inline；未来按国内外租赁 API 标准加适配器（不实现，只留缝）
9. **Agent 优先产品形态**（Owner 2026-09-23 定调：「我不希望你被原有的三个模式束缚。原本的三个模式你可以完全隐藏起来。有些算法确实是有价值的。但是我更希望你专注于 agent 这个新的产品形态的开发。」）：
   - **主面=Agent 会话 UI**（zhumo webui 同形态：任务会话流/帧流实时进度/审批应答/结果页与分享包）
   - **三工作台 UI（实验室/排钻/设计师）隐藏于开发者旗标后**——不删除、不维护性投入；其算法与流程沉淀为 capability 工具层供 agent 调度
   - 原计划的「三模式前端逐面切换服务器持久化」取消——前端工作集中于 Agent 主面

## Non-Goals

- GPU 珠点检测管线/客户 ComfyUI 能力对齐（另立项，见 docs/客户工作流分析报告.md；图像语义分解方向已验证落档 docs/scene-understanding-验证与架构评估.md）
- **Windows/Linux/Docker 部署**（延后另立 change——darwin-arm64 唯一首发，Owner 裁决）
- GPU/CPU 服务分离与池化（仅留接口缝）
- 收费系统（仅 role/数据层预留）
- handicraft.gaubee.com 域名迁移（Owner 后议）

## Owner 补充裁决（2026-09-23 晚）

- **无兼容包袱**：正式发布前破坏性更新随意；发布后由 Owner 负责客户数据备份再破坏——一切向下兼容工作不做
- **短会话语义**：用户「用完→下载结果→清空会话走人」——无长期会话/留存压力，产物下载与分享包是核心，存储可激进回收
- **节奏（R1 修正）**：工作流打通优先（W1-W2 独立交付）；W3 前端按冻结契约（design §3.5）mock 并行开发，**产品 MVP 验收=W4 接线后的联调集成用例（W4.4 替身集成）**；zhumo 是 Owner 自有项目，任意抄

## Impact

新 `daemon/`+`contracts/`；`rhinestone-studio` 增 package.json/exports 与 API 客户端层（Agent 主面 façade）；根 workspace 配置；darwin-arm64 私有化脚本（win/linux 延后另立 change）；引擎与既有功能面零改动（只被消费）。
