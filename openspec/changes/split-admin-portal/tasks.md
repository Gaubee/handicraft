# Tasks：前后台分离（split-admin-portal）

## 波 0：契约冻结

- [x] 0.1 角色与匿名缺省契约（ALLOW_ANONYMOUS 缺省 '0'+8317 显式 env 迁移说明+settings 双层真源测试更新）
- [x] 0.2 账号语义契约（禁用=阻断读写不信 JWT 快照；__anonymous__ 三禁；级联删除域清单）+typed 拒/放行矩阵测试
- [x] 0.3 会话附件契约（text 或 attachments 至少其一；steer+附件拒；帧回放元数据形态）
- [x] 0.4 素材 owner/shared+组合归属+知识库只读授权的契约条目与测试

## 波 1：后台身份与模型

- [x] 1.1 daemon：auth.login/refresh/me RPC+requireAdmin 守卫+禁用语义收紧
- [x] 1.2 daemon：admin.userList/create/update/delete（三禁+级联清理）+admin.settings（allow_anonymous 白名单键）
- [x] 1.3 daemon：models 六端点+imageProcessing 两端点收权 requireAdmin（models.available 保持只读）
- [x] 1.4 studio：hash 路由器（#/admin/{tab}）+App 分发接入+前台默认 Agent
- [x] 1.5 studio：登录页+会话态 store（role 感知）+AdminPage 壳（四入口/侧栏/守卫卡/移动抽屉）
- [x] 1.6 studio：账号管理页（表格+创建/改密/删除 Dialog+匿名开关）+设置页三分区（ModelsConfig/ImageProcessingConfig 零改动挂载+站点安全）
- [x] 1.7 门：普通/匿名直调管理 RPC 全拒矩阵+admin 全链+8317 动线验证

## 波 2：图片会话链

- [x] 2.1 contracts：followup 放宽（text 或 attachments）+附件帧元数据
- [x] 2.2 daemon：followup 附件 owner 校验+CAS 引用账本+会话清空防重放
- [x] 2.3 daemon：物料桥（BlobStore 字节→dsh 原生图像内容块——先核实 dsh API）
- [x] 2.4 daemon：/api/assets/{ref}/raw?w= 预览面（归属校验+嗅探+上限）
- [x] 2.5 daemon：scene.analyze LLM 回退统一走后台多路由
- [x] 2.6 studio：Composer 附件接线（attachable+uploadAttachment+粘贴/拖入+raw 缩略）+followup attachments+历史回放
- [x] 2.7 门：附件链集成（图像块断言+raw 归属矩阵+刷新回放）

## 波 3：知识库

- [x] 3.1 daemon：kb/store.ts（Markdown+Git commit+降级）+种子（贴钻领域）
- [x] 3.2 contracts：kb.ts（读面/管理面/修订历史）
- [x] 3.3 daemon：admin.kb.* RPC（requireAdmin）+MCP studio.kb_list/studio.kb_get
- [x] 3.4 studio：KnowledgeManager（分组/条目 CRUD+搜索+历史恢复+5s 轮询）
- [x] 3.5 门：kb 读写历史回归+MCP 工具投影测试

## 波 4：资源后台化

- [x] 4.1 装饰钻库：写面收 admin+StonesAdminView 挂后台资源分区+MCP 契约零改动验证
- [x] 4.2 组合/套装库：WarehouseView 移后台+文案改组合库+sets owner 过滤
- [x] 4.3 素材库服务化：服务端素材记录+CRUD RPC+IDB 可重试迁移+核验
- [x] 4.4 studio：后台资源分区三页+前台 owner-scoped 素材选取（前台选取器挂后续波
      ——本波范围裁定：Agent 附件已独立于素材库（波 2），旧 AssetPickerHost 本地版
      保留不动+迁移工具入口落地；服务端选取器在 design §5 标注挂账）
- [x] 4.5 门：迁移核验+权限矩阵

## 波 5：Vision 端到端验收

- [ ] 5.1 隔离实例搭建（全新 HOME/DATA_ROOT/端口/profile+ALLOW_ANONYMOUS=0+.env 管理员）
- [ ] 5.2 后台 setup：登录→z.ai 路由（anthropic-messages/glm-5.3-flash）→models.test→设默认
- [ ] 5.3 前台演练：新建会话→传图+提问→模型识别图中细节→设计/审批→导出 PNG
- [ ] 5.4 走查报告（截图链+导出物核验+key 不入日志声明）

## 收尾（MainAgent）

- [ ] 6.1 Codex 分波复核闭环
- [ ] 6.2 spec delta（admin-portal/kb/assets 域）+tasks 勾选+8317 换装交付
