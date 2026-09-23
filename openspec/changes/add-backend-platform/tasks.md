# Tasks: add-backend-platform

> R1 修订（codex-review-r1 处置）；R2 修订（codex-review-r2 B1-B8 处置）：replay/result 游标域与选择语义、clear 入契约、授权桥全工具面+内部消费+CAS、引擎真源镜像+adapter 等价 fixture、四态降级 E2E、PNG 形状清单、跨介质清理状态机。
> R3 修订（codex-review-r3 两 P1+四 P2 处置）：approved_ops 持久 operation 状态机（外部副作用诚实降级）、撤销按族拆分、clear 并发栅栏（原子拒新+drain+writer fence+blob 防复活）、cleared tombstone。
> R4 修订（codex-review-r4 处置）：provider 分支重试测试（支持/不支持幂等键两类 fixture）、启动遗留 operation 收敛、代际物理路径+barrier 测试、PNG 两类错误独立断言。
> R5 修订（codex-review-r5 处置）：session.retry 契约与 attempts 账本入 W0.1/W4.2（重试授权测试）、rowGen 孤儿回收测试入 W3.2。
> R6 修订（codex-review-r6 处置）：retryRequestId 幂等键入 retry 契约与重放测试；attempts 表入 W1.2 DDL。




## W0 契约冻结（W3/W4 并行的前提）

- [ ] W0.1 contracts 冻结 Agent 会话契约（design §3.5：create/list/get/followup/answer/cancel/**clear/retry**/replay/result+task.result IO+Frame kind 两族状态机+approval 载荷）——Zod 双端单测；**多 task 语义测试：一个 session 两个 task 各自 seq 从 1 起，分别回放无重帧/漏帧；session.result 确定性选择（最新完成，平局 taskId 大者）；task.result 指定查询/无结果显式 not_found；session.retry+attempts 账本 schema（attemptId 唯一/父 proposalId/attemptNo/idemKey/retryRequestId 唯一；同 op 仅一个 active attempt 的并发去重）**
- [ ] W0.2 contracts 冻结排布参数与 proposal diff（design §3.4：strategy/density/gapMm/seed/relax **直接引用引擎 schema**（StrategyIdSchema 五值含 cvt、density (0,1] 全局或逐块、gapMm≥0）；region 收敛 blocks ID）+ **adapter 等价 fixture（契约输入经 adapter 与直调 layout() 同输出）**+ 非法值显式拒绝单测（空 region/不存在 ID/负 gapMm/越界 density）+ dropped 语义呈现

## W1 地基（monorepo+daemon 骨架）

- [ ] W1.1 根 pnpm workspace + contracts 包（Zod：Role/TaskStatus/Frame/端点 IO 骨架）+ rhinestone-studio package.json exports（engine 面）——引擎零改动收据（git diff src/lib/engine 零行）；**smoke gate：daemon 的 tsx 真实 import `rhinestone-studio/engine` 调用 layout/exportSvg（不只 typecheck）**
- [ ] W1.2 daemon 骨架：tsx 入口/http（静态+SPA 回退，dist 缺失=明确报错+构建指引）/config（.env 模板自建+原位回写）/auth（__anonymous__ 幂等行+JWT+allow_anonymous 默认开+admin 经 .env ADMIN_* 幂等 upsert）/db（user_version 迁移+核心六表 DDL+patch_history+grants+approved_ops+attempts（§3.6 授权/operation/attempt 账本：attemptId 主键、proposalId+attemptNo 唯一、retryRequestId 唯一））/BlobStore（sha256+ref_count+原子写）；vitest：auth/config/db 单测
- [ ] W1.3 E2E 冒烟：起 daemon→匿名登录→bootstrap（zhumo w7b 模式，--dry-run）

## W2 服务面（生成+引擎+任务）

- [ ] W2.1 oRPC-over-WS 路由（contracts 端到端类型）+ mock 逃生口；tasks/results 表接线（tasks.type ∈ {job,agent}）；WS 帧流（jsonl+afterSeq 回放，Frame kind 两族）
- [ ] W2.2 生成代理：图像 API 服务端调用（.env IMG_* 键族；半配置=未配置语义；debug 记录对齐现有 lab 契约）；实验室任务参数→tasks
- [ ] W2.3 引擎 API 化：排钻/校验/导出 daemon 进程内直调（workspace 依赖）；**服务端 PNG=纯 TS 软光栅+zlib PNG 编码（design §6.3，无原生依赖、无浏览器全局；V1 形状清单=builtin 五形全支持（含旋转/透明）+custom 经 assetId 取 blob 资产解析，禁静默画圆），Node 进程真实 fixture：round+builtin 非圆+custom 资产形，断言像素/尺寸/透明度；**两类错误分别断言（R4）**：custom 缺 assetId→CustomAssetIdMissingError 语义；assetId 存在但资产未解析→独立错误码 PNG_ASSET_UNRESOLVED**；/r/{public_id} 分享页+bundle（containment/Range 照抄 zhumo）
- [ ] W2.4 daemon 托管 rhinestone-studio dist（含 SPA 回退）；E2E：上传→生成 dry-run→导出→分享页断言

## W3 Agent 主面（产品形态核心·Owner 定调）

- [ ] W3.1 API 客户端层（@orpc/client over WS）+ Agent 会话 UI 骨架（zhumo webui 形态移植：任务会话列表/会话流/帧流实时消费/审批应答/结果页+分享）——**按 W0.1 冻结契约开发，mock=固定 fixture 帧序列；mock 完成不构成 MVP（验收=W4.4 接线联调）**——产品主面
- [ ] W3.2 三工作台 UI 隐藏旗标（开发者开关默认关；不删除不维护）；BYOK 面随之退场（Agent 主面零浏览器密钥依赖）；资产/任务持久化 blobs/resources（owner_id）；导出/下载能力验收；**session.clear 跨介质清理状态机+并发栅栏（design §6.5 R3：DB 事务标记+cleanup outbox+幂等 unlink+启动重放；clearing 原子拒新 followup/answer+取消 drain 活跃 task；writer CAS fence 无迟到帧；blob deleting 防复活+**代际物理路径 `<sha256>.<rowGen>`（rowGen=行主键 UUID 永不复用；outbox 持久化完整旧代路径；staging→原子发布→DB 提交顺序——旧行 unlink 不可能命中新代文件，消 TOCTOU）**+unlink 前事务重验；cleared tombstone 幂等；result→blob 引用行承载分享包独立 TTL/revoke）+ 测试（①②③各阶段崩溃重启恢复一致/clear 对活跃 task 竞态无迟到帧无孤儿/**barrier 测试：暂停 cleanup 于 CAS 提交后 unlink 前，另一会话上传相同 sha256 且新引用可读，恢复旧 unlink 后新引用文件仍可读、行状态/计数一致**/**rowGen 恢复测试：旧行物理清理后重启+同 sha256 新建行与旧 outbox 重放共存不互扰；文件写成功但 DB 提交失败的启动孤儿回收断言**/outbox pending 期间另一会话同 sha256 重上传不丢不悬空/共享 blob 双引用/分享并发访问/TTL 到期回收）**
- [ ] W3.3 全量回归——**测试分类冻结（design §6.6）**：①默认无旗标=进 Agent 主面+三工作台导航隐藏+API façade 状态（新增）②开旗标=旧三工作台各≥1 条冒烟，UI-only 测试默认照跑（测试内开旗标 mount），保留/退役清单逐文件列明 ③引擎/持久化/格式/能力 Zod/patch/export gate 永跑 ④`app.globalImport.test.ts` 显式更新为双模式断言（无旗标=导入存资源不导航；开旗标=导航如旧）

## W4 Agent 模式

- [ ] W4.1 dsh 内核挂载：boot/profile/presets（persona=贴钻 SKILL.md）/deny-list 双层收窄——**懒加载（动态 import）+ module-resolution 失败捕获；降级四态 E2E（design §6.4）：DSH off/缺包坏包（独立进程+隔离模块解析器，boot throw 不可替代）/boot throw/正常——前三态基础工作流（上传→生成 dry-run→排钻→导出→分享）全链绿+仅 agent/session/MCP 端点 501，第四态全功能；MCP 独立 loopback listener 专用端口+非 loopback 必拒集成测试（主 HTTP 可 LAN 同时）**
- [ ] W4.2 capability 三件套 + §3 工具清单（readonly/proposal/approved-mutation）+ 排布四参数一等公民（§3.4 契约真源镜像）+ 熔断器；**授权桥（§3.6 R3：覆盖 patch-apply/generate/export 全 approved-mutation；grant 服务端内部关联——nonce 不出帧/API/MCP 载荷，agent 只带 proposalId；revision CAS 漂移必拒）+ approved_ops 持久 operation 状态机（approved/claimed/running/succeeded/failed/unknown，proposalId 幂等键，原子 claim；patch/export 本地恰好一次；generate 重试按 provider 分支——支持幂等键则复用同键收敛同一远端结果，不支持则崩溃=unknown、重试经 **session.retry（owner 认证+costConfirmed 费用确认+原 op unknown 校验）创建新 attempt（attempts 账本：attemptId 持久唯一/父 proposalId/新 idemKey——不复用已消费 grant，执行时 revision CAS 重校验）**如实提示可能再次计费；**启动扫描遗留 claimed/running→unknown 收敛（operation 与 attempt）**）+ 撤销按族拆分（patch_history 整组逆序回退/generate cancel+产物清理/export revoke+bundle 释放）+ 测试（无授权直调/摘要不匹配/过期/重放/跨 task-user/版本漂移全必拒；**两类 provider fixture（支持/不支持幂等键）崩溃后重启与重试断言**——持久状态/远端调用次数/用户可见结果+启动遗留 operation/attempt 收敛；**重试授权测试：未授权/跨用户 session.retry 必拒、旧 grant 重放必拒、同一确认并发只产生一个 attempt、下一 attempt 需再次确认（新 retryRequestId）、重启后 attempt 归属与提示稳定；请求级幂等：响应丢失后原键重放（含首 attempt 已 unknown）不新建 attempt、同键并发/重启收敛同一 attempt、跨 owner/session/proposal 复用键必拒**；同 proposal 并发调用本地去重；三族撤销各自终态）+ 固定 fixture 断言（同参 preview 确定/密度单调/dropped 呈现/未批准真值不变）**；MCP streamable-http 环回（进程周期 token+独立 loopback listener）
- [ ] W4.3 followup 编辑旅程：任务会话→「把这块区域改密一点/换成金色」→ patch-propose 预览→用户批准（session.answer→grant）→patch-apply 单 op；firehose 帧流到前端任务面板
- [ ] W4.4 E2E：**确定性模型/工具替身集成用例（=产品 MVP 验收门，design §3.5）**：创建会话→收帧→回答审批→结果链接→断线回放全链断言；另跑 --dry-run agent 会话回归（无真实模型跑通建任务+失败收敛）

## W5 部署与收尾

- [ ] W5.1 darwin-arm64 私有化（**Owner 2026-09-23 裁决：前期唯一目标平台——架构统一先行**）：启动脚本+自包含数据根+webui dist 入库（克隆即跑）+**dist stale/missing 门禁（启动报错指引+CI 校验一致性）**；better-sqlite3/tsx 在 darwin-arm64 的预编译验证
- [ ] W5.2 win 私有化+linux Docker：**延后**（后续 change——ASCII 路径/junction/容器化兼容面届时再做；CI 预留构建位即可，不阻塞）
- [ ] W5.3 ComputeProvider 缝（**异步签名+幂等键，design §5**）+ InlineProvider；接口版本化注释（未来租赁 API 适配器位）
- [ ] W5.4 文档（部署/开发/.env 键族/admin 建号流程）+ 全量绿门（daemon+contracts+rhinestone-studio 三包）+ 偏离清单回报
