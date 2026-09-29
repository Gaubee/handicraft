# 后台能力域（admin-portal）——前后台分离

> 新能力域：同 SPA hash 路由 `#/admin/{tab}` + 服务端 requireAdmin 双层门（zhumo 管理模型 1:0.99 复刻适配）。四入口：账号/资源/知识库/设置。

### Requirement: 后台路由与角色门

后台 SHALL 为同 SPA hash 路由分区（`#/admin/{tab}`，非法 tab 回落账号页），客户端守卫卡只做提示与跳转；**所有管理 RPC SHALL 服务端 requireAdmin**（路由守卫不替代授权）。匿名缺省 SHALL 关（`ALLOW_ANONYMOUS` 缺省 '0'；既有单账户实例可显式 env 保持开）。管理员唯一引导=`.env ADMIN_*` 幂等 upsert；不开放自助注册。登录/刷新/当前用户 SHALL 有 auth RPC 与登录页；禁用账号 SHALL 阻断后续读写与刷新/新登录（不信 JWT 角色快照，按 DB 当前状态复核）。

#### Scenario: 授权边界

- **when** 普通/匿名用户直调 admin.* 或 models.save → typed 拒（403 域）
- **when** 管理员登录后建号/改密/禁用/删除 → 生效；`__anonymous__` 三禁（改密/禁用/改角色）拒；不能禁用或降级自己
- **when** 删除用户 → 会话/任务/资源/blob 引用账本/users 行级联清理
- **when** ALLOW_ANONYMOUS 未显式配置的新安装 → 匿名关；显式 '1' → 开

### Requirement: 后台设置与资源分区

设置分区 SHALL 含大模型服务（ModelsConfig）+图像处理（ImageProcessingConfig）+站点与安全；模型与图像处理读写 SHALL 收权 admin（models.available 保持活动用户只读）。资源分区 SHALL 含装饰钻库管理（写面 admin；Agent MCP 消费契约不变）、组合/套装库（sets owner/shared 显式，不虚构库存实体）、素材库（服务端真源）。素材库 SHALL 先服务化（服务端记录+owner/shared+软删+可重试 IDB 迁移+数量内容核验通过前保留浏览器原数据）再开放后台维护；前台 SHALL 保留用户查看本人素材与 Agent 选图能力。

#### Scenario: 资源治理

- **when** 普通用户访问装饰钻写操作 → 拒；Agent 经 MCP stones 工具读 → 不变
- **when** 素材迁移核验（服务端数量+内容 hash 对 IDB 逐项）通过 → 才可清理本地；未通过 → 保留并可重试

### Requirement: 图片会话链

会话附件 SHALL 走结构化 BlobRef[]（不注入文件路径、不造 taskRoot 硬链）：上传→BlobStore→`session.followup.attachments`（text 或 attachments 至少其一；steer+附件拒）→owner 校验+CAS 引用账本→**dsh 用户消息原生图像内容块**→已配视觉模型。raw 预览面 `/api/assets/{ref}/raw?w=` SHALL 校验登录与归属+内容嗅探+尺寸/MIME/字节上限。scene.analyze 的 LLM 回退 SHALL 消费后台模型路由（不走 .env 单协议）。

#### Scenario: 图片链验收

- **when** 真实视觉模型会话收到图片+问题 → 回答图中可核对细节（非附件名）
- **when** 跨用户读他人附件 raw → 拒；会话清空后重放旧 BlobRef → 不复活引用
- **when** 历史会话刷新 → 附件缩略回放

### Requirement: 知识库

知识库 SHALL 为两级 Markdown 文件+Git 历史（每变更一 commit；git 缺席历史面降级明示）+后台管理（分组/条目 CRUD/搜索/历史恢复，admin 写）+前台 Agent MCP 只读工具（kb_list/kb_get——不注入 system prompt）。第一版 Agent 写关闭（proposal 写挂授权桥后续波）。种子=贴钻领域（钻径规格/密度单位/色系编码/工艺规则/SS 尺码），内容标注来源与适用范围。

#### Scenario: KB 消费

- **when** Agent 需要工艺参数 → 调 kb_list/kb_get 按需读取
- **when** 管理员改条目 → git commit 记录 actor；历史面板可查看与恢复
