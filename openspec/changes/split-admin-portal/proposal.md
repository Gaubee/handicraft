# 提案：前后台分离——zhumo 管理体系 1:0.99 复刻适配（Owner 指令 2026-09-29）

## Why

Owner：zhumo 有后台（模型设置/账户管理/知识库管理）和前台；贴钻目前只有前台、所有东西开放给单角色，要升级。后台管理 1:0.99 复刻 zhumo、适配贴钻管理体系；前台 Agent Chat 同样 1:0.99 复刻（zhumo 处理视频→贴钻处理图片——**现在连上传图片的途径都没有**）。知识库系统服务于前台。前台部分功能挪后台（候选：素材库、装饰钻库、仓储管理）。完成后 vision 子代理用 ego-browser 端到端（后台 setup 配 z.ai glm-5.3-flash→前台 Agent 演练→导出效果图）。

已与 Codex 完成架构讨论（/tmp/codex-arch-split-review.md，2026-09-29 裁定+arch-decisions.md 摘要）：同 SPA hash 路由双层角色门、结构化 BlobRef 图片链、知识库 Markdown+Git+MCP、素材库先服务化、仓储=组合库不虚构库存。

## What Changes（六波）

0. **契约冻结**：角色/匿名缺省/owner-shared 素材语义/会话附件引用与清理/知识库写授权/组合归属——测试契约与迁移策略先定。
1. **后台身份与模型**：auth.login/refresh/me RPC+登录页；`#/admin/{tab}` 后台壳（账号/资源/知识库/设置四入口，zhumo AdminPage 形态）+`requireAdmin` 守卫+账号 CRUD RPC/UI（照 zhumo：不开放注册/改密/禁用/删除级联清理/匿名开关）；模型+图像处理设置收权 admin 并移入后台设置分区（ModelsConfig/ImageProcessingConfig 零改动换承载）。普通用户直调管理 RPC 必拒。
2. **图片会话链**：Composer 启用附件（attachable 接线+粘贴/拖入/上传态/缩略/移除）；契约放宽「有文本或有图片」；followup.attachments 全链（owner 校验+CAS 引用账本+帧回放）；daemon 物料桥=BlobStore 字节→dsh 原生图像内容块（不路径注入不硬链）；`/api/assets/{ref}/raw?w=` 预览面（归属校验+内容嗅探+上限）；**scene.analyze LLM 回退统一走后台多路由**（现状 .env openai-completions 暗坑修复）。
3. **知识库**：四层照搬 zhumo——Markdown 文件+Git 历史（DATA_ROOT/knowledge/）+后台管理 UI（分组/条目 CRUD/搜索/历史/恢复）+MCP `kb_list`/`kb_get` 只读工具（服务前台 Agent）；第一版 Agent 只读（W4.2 授权桥完成前不开 proposal 写）；种子=贴钻领域（钻径规格/密度单位/色系编码/工艺规则/SS 尺码）。
4. **资源后台化**：装饰钻库管理收 admin（MCP 消费不变）；仓储改名组合/套装库入后台资源分区（owner/shared 显式）；素材库 daemon 服务化（服务端素材记录+owner/shared+软删+可重试 IDB 迁移+数量内容核验）→后台集中管理入口+前台 owner-scoped 选取。
5. **Vision 端到端验收**：全部实现门过后，vision 子代理 ego-browser 独立隔离实例走：后台 setup（z.ai anthropic-messages+glm-5.3-flash+models.test）→前台新建会话传图提问→模型识别图片细节→设计/审批/导出 PNG。

## Impact

- 全栈：contracts（auth/admin/kb/assets 契约）+daemon（auth RPC/requireAdmin/后台 RPC 群/kb store+capability/附件物料桥/raw 面/scene-analyze 路由统一）+studio（hash 路由壳/登录页/AdminPage/账号 UI/Composer 接线/KB UI/素材服务化迁移）。
- 行为变化：匿名缺省关（8317 实例显式 ALLOW_ANONYMOUS=1 保 Owner 动线）；管理 RPC 收权。
- 不动：engine/、既有 MCP 工具契约（stones 等仅守卫变化）、dsh 内核机制、v5-v7 已冻结语义。
