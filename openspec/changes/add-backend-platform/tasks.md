# Tasks: add-backend-platform

> R1 修订（2026-09-23，codex-review-r1 处置）：契约冻结任务前置（design §3.4/§3.5/§3.6）、降级三态 E2E、Node PNG 路线、短会话 clear+留存矩阵、W3 测试分类冻结。

## W0 契约冻结（R1 新增——W3/W4 并行的前提）

- [ ] W0.1 contracts 冻结 Agent 会话契约（design §3.5：create/list/followup/answer/cancel/replay/result IO+Frame kind 两族状态机+approval-request/resolved 载荷+游标语义）——Zod 双端单测
- [ ] W0.2 contracts 冻结排布参数与 proposal diff（design §3.4：region/density/gap/strategy 以 `src/lib/engine` 现行类型为真源镜像）+ 非法值 Zod 拒绝单测

## W1 地基（monorepo+daemon 骨架）

- [ ] W1.1 根 pnpm workspace + contracts 包（Zod：Role/TaskStatus/Frame/端点 IO 骨架）+ rhinestone-studio package.json exports（engine 面）——引擎零改动收据（git diff src/lib/engine 零行）；**smoke gate：daemon 的 tsx 真实 import `rhinestone-studio/engine` 调用 layout/exportSvg（不只 typecheck）**
- [ ] W1.2 daemon 骨架：tsx 入口/http（静态+SPA 回退，dist 缺失=明确报错+构建指引）/config（.env 模板自建+原位回写）/auth（__anonymous__ 幂等行+JWT+allow_anonymous 默认开+admin 经 .env ADMIN_* 幂等 upsert）/db（user_version 迁移+核心六表 DDL+patch_history）/BlobStore（sha256+ref_count+原子写）；vitest：auth/config/db 单测
- [ ] W1.3 E2E 冒烟：起 daemon→匿名登录→bootstrap（zhumo w7b 模式，--dry-run）

## W2 服务面（生成+引擎+任务）

- [ ] W2.1 oRPC-over-WS 路由（contracts 端到端类型）+ mock 逃生口；tasks/results 表接线（tasks.type ∈ {job,agent}）；WS 帧流（jsonl+afterSeq 回放，Frame kind 两族）
- [ ] W2.2 生成代理：图像 API 服务端调用（.env IMG_* 键族；半配置=未配置语义；debug 记录对齐现有 lab 契约）；实验室任务参数→tasks
- [ ] W2.3 引擎 API 化：排钻/校验/导出 daemon 进程内直调（workspace 依赖）；**服务端 PNG=纯 TS 软光栅+zlib PNG 编码（design §6.3，无原生依赖、无浏览器全局），Node 进程真实 fixture 断言像素/尺寸/错误分支**；/r/{public_id} 分享页+bundle（containment/Range 照抄 zhumo）
- [ ] W2.4 daemon 托管 rhinestone-studio dist（含 SPA 回退）；E2E：上传→生成 dry-run→导出→分享页断言

## W3 Agent 主面（产品形态核心·Owner 定调）

- [ ] W3.1 API 客户端层（@orpc/client over WS）+ Agent 会话 UI 骨架（zhumo webui 形态移植：任务会话列表/会话流/帧流实时消费/审批应答/结果页+分享）——**按 W0.1 冻结契约开发，mock=固定 fixture 帧序列；mock 完成不构成 MVP（验收=W4.4 接线联调）**——产品主面
- [ ] W3.2 三工作台 UI 隐藏旗标（开发者开关默认关；不删除不维护）；BYOK 面随之退场（Agent 主面零浏览器密钥依赖）；资产/任务持久化 blobs/resources（owner_id）；导出/下载能力验收；**session.clear+留存矩阵实现（design §6.5：原子事务回收/分享包 shared 解耦+TTL/幂等重试）+ 测试（删除原子性/失败恢复/共享 blob 双引用/分享并发访问/无悬空引用）**
- [ ] W3.3 全量回归——**测试分类冻结（design §6.6）**：①默认无旗标=进 Agent 主面+三工作台导航隐藏+API façade 状态（新增）②开旗标=旧三工作台各≥1 条冒烟，UI-only 测试默认照跑（测试内开旗标 mount），保留/退役清单逐文件列明 ③引擎/持久化/格式/能力 Zod/patch/export gate 永跑 ④`app.globalImport.test.ts` 显式更新为双模式断言（无旗标=导入存资源不导航；开旗标=导航如旧）

## W4 Agent 模式

- [ ] W4.1 dsh 内核挂载：boot/profile/presets（persona=贴钻 SKILL.md）/deny-list 双层收窄——**懒加载（动态 import）+ module-resolution 失败捕获；降级三态 E2E（design §6.4）：DSH off/缺包/boot throw 三态下基础工作流（上传→生成 dry-run→排钻→导出→分享）全链绿+仅 agent/session/MCP 端点 501；正常态全功能**
- [ ] W4.2 capability 三件套 + §3 工具清单（readonly/proposal/approved-mutation）+ 排布四参数一等公民（§3.4 契约）+ 熔断器；**授权桥（§3.6：grant 签发/一次性消费/opDigest 匹配/过期/重放必拒）+ patch_history 撤销组（一次撤销恢复整组）+ 固定 fixture 断言（同参 preview 确定/密度单调/间距硬约束/未批准真值不变）**；MCP streamable-http 环回（进程周期 token，loopback-only）
- [ ] W4.3 followup 编辑旅程：任务会话→「把这块区域改密一点/换成金色」→ patch-propose 预览→用户批准（session.answer→grant）→patch-apply 单 op；firehose 帧流到前端任务面板
- [ ] W4.4 E2E：**确定性模型/工具替身集成用例（=产品 MVP 验收门，design §3.5）**：创建会话→收帧→回答审批→结果链接→断线回放全链断言；另跑 --dry-run agent 会话回归（无真实模型跑通建任务+失败收敛）

## W5 部署与收尾

- [ ] W5.1 darwin-arm64 私有化（**Owner 2026-09-23 裁决：前期唯一目标平台——架构统一先行**）：启动脚本+自包含数据根+webui dist 入库（克隆即跑）+**dist stale/missing 门禁（启动报错指引+CI 校验一致性）**；better-sqlite3/tsx 在 darwin-arm64 的预编译验证
- [ ] W5.2 win 私有化+linux Docker：**延后**（后续 change——ASCII 路径/junction/容器化兼容面届时再做；CI 预留构建位即可，不阻塞）
- [ ] W5.3 ComputeProvider 缝（**异步签名+幂等键，design §5**）+ InlineProvider；接口版本化注释（未来租赁 API 适配器位）
- [ ] W5.4 文档（部署/开发/.env 键族/admin 建号流程）+ 全量绿门（daemon+contracts+rhinestone-studio 三包）+ 偏离清单回报
