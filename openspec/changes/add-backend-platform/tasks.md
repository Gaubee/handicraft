# Tasks: add-backend-platform

## W1 地基（monorepo+daemon 骨架）

- [ ] W1.1 根 pnpm workspace + contracts 包（Zod：Role/TaskStatus/Frame/端点 IO 骨架）+ rhinestone-studio package.json exports（engine 面）——引擎零改动收据（git diff src/lib/engine 零行）
- [ ] W1.2 daemon 骨架：tsx 入口/http（静态+SPA 回退）/config（.env 模板自建+原位回写）/auth（__anonymous__ 幂等行+JWT+allow_anonymous 默认开）/db（user_version 迁移+六表 DDL）/BlobStore（sha256+ref_count+原子写）；vitest：auth/config/db 单测
- [ ] W1.3 E2E 冒烟：起 daemon→匿名登录→bootstrap（zhumo w7b 模式，--dry-run）

## W2 服务面（生成+引擎+任务）

- [ ] W2.1 oRPC-over-WS 路由（contracts 端到端类型）+ mock 逃生口；tasks/results 表接线；WS 帧流（jsonl+afterSeq 回放）
- [ ] W2.2 生成代理：图像 API 服务端调用（.env IMG_* 键族；半配置=未配置语义；debug 记录对齐现有 lab 契约）；实验室任务参数→tasks
- [ ] W2.3 引擎 API 化：排钻/校验/导出（SVG/BOM/PNG）daemon 进程内直调（workspace 依赖）；/r/{public_id} 分享页+bundle（containment/Range 照抄 zhumo）
- [ ] W2.4 daemon 托管 rhinestone-studio dist（含 SPA 回退）；E2E：上传→生成 dry-run→导出→分享页断言

## W3 前端切换

- [ ] W3.1 API 客户端层（@orpc/client over WS）+ 实验室生成切服务端任务（画廊消费帧流）；BYOK 面退场（未配置时只读引导）
- [ ] W3.2 资产/任务持久化迁 blobs/resources（owner_id 贯穿）；四族文件格式导入导出兼容红线测试（服务器资源⇄文件往返无损）
- [ ] W3.3 设计师文档面按需切换或暂保留本地（开放项⑦裁决后落）；全量回归（前端既有测试零断言改动或显式更新清单）

## W4 Agent 模式

- [ ] W4.1 dsh 内核挂载：boot/profile/presets（persona=贴钻 SKILL.md）/deny-list 双层收窄/降级 501（挂载失败不阻塞 daemon）
- [ ] W4.2 capability 三件套 + §3 工具清单（readonly/proposal/approved-mutation）+ 熔断器；MCP streamable-http 环回（Bearer 一次性 token）
- [ ] W4.3 followup 编辑旅程：任务会话→「把帽子区域改密一点/换成金色」→ patch-propose 预览→用户批准→patch-apply 单 op；firehose 帧流到前端任务面板
- [ ] W4.4 E2E：--dry-run agent 会话回归（无真实模型跑通建任务+失败收敛）

## W5 部署与收尾

- [ ] W5.1 darwin-arm64 私有化（**Owner 2026-09-23 裁决：前期唯一目标平台——架构统一先行**）：启动脚本+自包含数据根+webui dist 入库（克隆即跑）；better-sqlite3/tsx 在 darwin-arm64 的预编译验证
- [ ] W5.2 win 私有化+linux Docker：**延后**（后续 change——ASCII 路径/junction/容器化兼容面届时再做；CI 预留构建位即可，不阻塞）
- [ ] W5.3 ComputeProvider 缝 + InlineProvider；接口版本化注释（未来租赁 API 适配器位）
- [ ] W5.4 文档（部署/开发/.env 键族）+ 全量绿门（daemon+contracts+rhinestone-studio 三包）+ 偏离清单回报
