# 设计：前后台分离（split-admin-portal）

原始需求输入：Owner 2026-09-29 指令（前后台分离+zhumo 1:0.99 复刻+图片链+知识库+功能挪后台+vision 端到端）。架构裁定：Codex 讨论 /tmp/codex-arch-split-review.md（六议题 A-F 逐项裁定）+ arch-decisions.md（裁定摘要）+ domain-terms.md（领域词汇）。摸底：/tmp/zhumo-survey.md（zhumo 全貌）+贴钻差距报告（会话记录）。

## 0. 总形态（Codex 总裁定采纳）

同 SPA hash 路由、同 daemon、双层角色门（客户端守卫卡+服务端 requireAdmin），不拆两个部署。1:0.99 复刻交互与管理模型；身份授权/数据归属/图片协议按贴钻既有会话与 BlobRef 契约重做。

```text
同源 SPA：前台 #/…（Agent/会话/产物）  ｜  后台 #/admin/{tab}（账号/资源/知识库/设置）
              ↘ daemon：认证 + owner 校验 + requireAdmin ↙
              BlobStore / session refs / dsh / MCP
```

## 1. 波 0：契约冻结

- **角色与匿名**：role 三值不变；`ALLOW_ANONYMOUS` 缺省改 '0'（多角色安装默认关——Codex 裁定）；既有 8317 实例以显式 `ALLOW_ANONYMOUS=1` env 保 Owner 现行动线（迁移说明写进 proposal）。管理员唯一引导=`.env ADMIN_*` 幂等 upsert（Owner 变体保留）；不开放自助注册。
- **账号语义**：禁用=阻断后续读写与刷新/新登录、保留数据（**收紧**现行「禁写不禁读」）；每次 RPC 按 DB 当前 disabled 复核，不信 JWT 角色快照。硬删除=级联清理（会话/任务/资源/blob 引用账本/users 行+用户目录）——zhumo adminUserDelete 同款语义按贴钻表结构适配。
- **素材 owner/shared**：服务端素材记录=resources 表扩展（owner_id+shared 标记+软删），不新建平行表。
- **会话附件生命周期**：followup 接受时同事务 CAS 取得引用；会话清空后旧 BlobRef 不得复活引用；帧存附件元数据+BlobRef 可回放。
- **知识库写授权**：第一版 Agent 只读；proposal 写挂 W4.2 授权桥（后续波）。
- **组合归属**：sets 保留 owner；后台管理显式选择/筛选 owner，不无声全局化。
- 测试契约：上述各语义的 typed 拒绝/放行矩阵先落 contracts 测试。

## 2. 波 1：后台身份与模型

### daemon
- `auth.login/refresh/me` RPC（zhumo rpc.ts:293-324 同构；login 禁用用户不发 token 或发而读写全拦——按禁用语义收紧版：不发）。
- `requireAdmin` 守卫中间件（zhumo rpc.ts:181-186 同构）+全部管理 RPC 挂载。
- `admin.userList/create/update/delete` RPC（贴钻 db/store.ts 函数已有，补三禁：__anonymous__ 改密/禁用/改角色拒；不能禁用/降级自己；删除级联按贴钻表域适配）。
- `admin.settings.get/update`（allow_anonymous/site 元信息白名单键）。
- models 六端点+imageProcessing 两端点守卫收紧：`requireActiveUser`→`requireAdmin`；`models.available` 保持活动用户只读。
### studio
- hash 路由器（zhumo router.svelte.ts 同构：Route 联合{admin:{tab}}+解析+非法回落）——App.svelte 分发接入；前台默认 #/ Agent。
- 登录页（zhumo LoginPage 形态：用户名+口令→auth.login→token 存 sessionStorage 既有键位——升级为带 role 的会话态 store）。
- AdminPage（zhumo 773 行形态 1:0.99：≥md 侧栏四入口/移动 Sheet 抽屉/守卫卡/返回前台）：账号管理页（表格+三 Dialog+匿名开关 Switch——zhumo AdminPage:374-524+714-772 复刻）；设置页二级 list-detail（大模型服务=ModelsConfig 现组件挂载/图像处理=ImageProcessingConfig 现组件/站点与安全）。
- 顶栏「设置」入口改 admin 可见（普通用户不再直达模型配置）。
### 验收
普通/匿名用户直调 admin.* 与 models.save 必 typed 拒；admin 全链可用；8317 显式 env 匿名动线不破坏。

## 3. 波 2：图片会话链（Codex C 全文采纳）

```text
选图 → 有界上传/解码 → BlobStore → BlobRef
                                    → session.followup.attachments
                                    → owner 校验 + session CAS 引用账本 + 持久帧
                                    → dsh 用户消息原生图像内容块 → 已配视觉模型
```

- 契约：`SessionFollowupInputSchema` 放宽 `text.min(1)` → 「text 或 attachments 至少其一」；steer+attachments 拒绝语义保持。
- daemon 物料桥：followup 处理时从 BlobStore 读字节→dsh 原生多模态图像块（实现轮先核实当前 dsh 版本 API 形态再定细节—— Codex 提醒）；**不**拼路径进 prompt、**不**造 taskRoot 硬链。
- 前端：SessionStream `attachable={false}`→注入真 uploadAttachment（assets.upload→BlobRef）；ComposerCard 附件面全启（选择/粘贴/拖入/≤4MiB/chip 缩略/raw 预览 URL/移除/错误态）；RpcAgentApi.followup 带 attachments；历史会话刷新后附件回放（帧元数据渲染缩略）。
- raw 面：`GET /api/assets/{ref}/raw?w=`——登录 token+归属校验（会话引用账本或 owner）+内容嗅探（不信任扩展名）+宽度/MIME/文件数/总字节上限。
- **scene.analyze 路由统一**（Codex 抓的暗坑）：LLM 回退从 `.env LLM_*` openai-completions-only 改为消费后台模型路由（models_route 桥接面）——演练链不破。
- 验收：真实视觉模型收到图像内容块并回答图中可核对细节（非附件名）；跨用户读 raw 拒。

## 4. 波 3：知识库（Codex D 采纳）

- daemon `kb/store.ts`（zhumo 同构）：`DATA_ROOT/knowledge/<组>/index.md+<key>.md`；每变更一 git commit（actor=admin:<user>/agent/system）；git 缺席降级（历史面 available=false）。
- 契约 `contracts/src/kb.ts`（zhumo kb.ts 适配）：agent 读面（kb_list/kb_get）+admin 管理面（分组/条目 upsert/delete/rename）+修订历史（log/详情/恢复）。
- RPC `admin.kb.*`（requireAdmin）+MCP capability `studio.kb_list/studio.kb_get`（readonly——服务前台 Agent；capability/mcp.ts 投影机制已有）。
- 后台 UI KnowledgeManager（zhumo 619 行形态：左组/右条目编辑+搜索+历史面板+5s 轮询回填 agent 并行写）。
- 种子：贴钻领域（钻径与规格/密度及单位/色系编码/工艺规则/SS 尺码映射）——内容标注来源与适用范围，模型生成常识不自动成标准。
- 第一版 Agent 只读；proposal 写=W4.2 后续波。

## 5. 波 4：资源后台化

- 装饰钻库：stones 六端点写面收 requireAdmin（读面/trash 语义按 owner 保留——实现轮核对）；StonesAdminView 挂后台资源分区；MCP stones 工具契约零改动。
- 组合/套装库：WarehouseView 移后台资源分区+文案改「组合/套装」；sets RPC owner 过滤参数；不新增库存实体（实物库存=另立需求）。
- 素材库服务化：服务端素材记录（resources 扩展+shared+软删）+素材 CRUD RPC+IDB→服务端可重试迁移（去重+数量内容核验通过前保留浏览器原数据）+后台集中管理入口+前台 owner-scoped 选取（Agent 选图能力不丢——Codex 红线）。AssetsView 本地形态保留为迁移源。

## 6. 波 5：Vision 端到端（Codex F 前置清单采纳）

独立隔离实例（全新 HOME/DATA_ROOT/端口/浏览器 profile；ALLOW_ANONYMOUS=0）：后台 .env 管理员登录→账号确认→设置分区新增 z.ai 路由（anthropic-messages / https://api.z.ai/api/anthropic / glm-5.3-flash）→models.test 通→保存设默认→普通用户前台新建会话→传图+明确问题→模型回答图中可核对细节→设计/审批→导出 PNG（非空可打开=演练结果）。key 只填后台密钥框（不入 URL/截图/日志）。

## 7. 风险登记（Codex 原文要点）

- 先放后台页再补服务端授权=改接口可绕过——波 1 内 RPC 收权与 UI 同步落。
- 关匿名早于登录引导=锁死安装——.env 引导+登录页先行，8317 显式 env 保底。
- 只验上传不证模型看见图——波 2 验收必须含「回答图中细节」。
- 素材迁移丢/串——核验通过前保留 IDB 原数据。
- hash 全局 raw 读面跨用户泄漏——归属校验必做。

## 8. 测试与门

每波：contracts/daemon/studio 聚焦+全量+typecheck+svelte-check；波 1 加「普通用户直调管理 RPC 全拒矩阵」；波 2 加附件链集成（mock dsh 图像块断言+raw 归属矩阵）；波 4 加迁移核验；波 5=浏览器端到端（vision 子代理）。engine/ 零改动全程红线。
