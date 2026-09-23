# Proposal: add-backend-platform — 后端平台化（zhumo 模式移植）

## Why

Owner 2026-09-23 六决策（docs/后端化方案讨论-v1.md v1.1）：纯前端 → 双栈后端，Web 仅承载 UI，GitHub Pages 退役。参照系=Owner 的 zhumo 项目（/Users/kzf/Documents/书法，架构已侦察归档）。承载目标：①复杂工作上服务端（生成代理/重计算/持久化）②Agent 模式（基础工作流验证→原子工具→MCP→dsh-agent，满足「帽子改密度/改颜色」级灵活编排）③未来 GPU 珠点检测管线的宿主（另立项）。

## What Changes

**架构（zhumo 模式移植 + 贴钻变体）**：
1. **monorepo**：repo 根 pnpm workspace = `rhinestone-studio/`（现有前端，转 daemon 托管 SPA，**栈与 zhumo webui 完全同构**）+ `daemon/`（Node TS，tsx 直跑零编译）+ `contracts/`（Zod 前后端共享真源）；rhinestone-studio 加 package.json exports 暴露 `src/lib/engine` 供 daemon workspace 依赖（**引擎零搬家零重写**）
2. **部署**：win/mac 私有化直跑（zhumo 同款：better-sqlite3 预编译/纯 ASCII 路径/junction 适配清单）+ linux Docker（单容器 daemon+静态托管）；GitHub Pages 退役（仓库 CI 保留构建）
3. **账户**：zhumo 同款——`__anonymous__` 内置行（幂等自愈）、JWT、owner_id 贯穿、禁写不禁读、role enum 预留收费；**变体：allow_anonymous 默认开**（Owner 裁决默认单账户）
4. **密钥**：zhumo 同款 .env（模板自建/原位回写/0600）+ settings 表优先的双层真源；图像 API 密钥（baseUrl/key）服务端集中
5. **API**：oRPC-over-WebSocket（contracts 包类型端到端）+ 长任务 WS 帧流（jsonl 持久化 + afterSeq 游标回放，**无队列无 SSE**）+ daemon 静态托管 SPA
6. **数据**：better-sqlite3（user_version 迁移）六表族（users/settings/blobs/resources/tasks/results——blobs=sha256 内容寻址+引用计数；results=public_id 分享包）+ 文件格式（.gemproj 等）保留为导入导出交换格式
7. **Agent 模式**（Owner 路线）：Phase A 基础工作流打通（上传→生成→排钻→导出全链服务端化）→ Phase B 拆原子工具为 capability（zhumo 三件套：registry/Zod/authority 只读-提议-批准变更）→ MCP streamable-http 环回 → dsh-agent 内核挂载（dsh-* npm 包进程内嵌、deny-list 双层收窄工具面、firehose 帧投影、熔断器）→ followup 续聊式编辑（「把帽子区域改密一点/换成金色」）
8. **GPU 抽象**（轻）：`ComputeProvider` 接口缝（submit/status/result/cancel），首实现=本机 inline；未来按国内外租赁 API 标准加适配器（不实现，只留缝）
9. **前端切换分批**：实验室生成→资产/任务持久化→设计师文档，IDB 逐步让位（文件导入导出保留离线兜底）

## Non-Goals

- GPU 珠点检测管线/客户 ComfyUI 能力对齐（另立项，见 docs/客户工作流分析报告.md）
- GPU/CPU 服务分离与池化（仅留接口缝）
- 收费系统（仅 role/数据层预留）
- handicraft.gaubee.com 域名迁移（Owner 后议）

## Impact

新 `daemon/`+`contracts/`；`rhinestone-studio` 增 package.json/exports 与 API 客户端层；根 workspace 配置；Docker/私有化脚本；引擎与既有功能面零改动（只被消费）。
