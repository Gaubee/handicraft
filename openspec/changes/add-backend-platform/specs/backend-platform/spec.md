# Delta: backend-platform（新 capability）

## ADDED Requirements

### Requirement: 私有化部署与托管形态
后端 MUST 以单进程 Node 服务交付：win/mac 私有化直跑（tsx 零编译；数据/密钥自包含于数据根目录），linux MUST 提供 Docker 部署（单容器含 API 与静态前端）。daemon MUST 静态托管前端 SPA（无点路径回退 index.html）并默认绑定 127.0.0.1（HOST 可开局域网）。前端构建产物 MUST 可入库分发（克隆即跑免构建）。GitHub Pages 渲染应用的模式 MUST 退役（仓库 CI 仅构建产物/镜像）。

#### Scenario: 克隆即跑
- **WHEN** 在全新 win/mac 机器克隆仓库并按 README 安装依赖后执行启动脚本
- **THEN** daemon 起服（默认本机端口），浏览器打开即匿名可用，数据与 .env 落在数据根目录，无需手工编译

### Requirement: 匿名默认账户与多账户预留
系统 MUST 内置匿名账户（幂等自愈的 `__anonymous__` 用户行），且匿名访问 MUST 默认开启（单账户开箱即用）。认证 MUST 采用 JWT（载荷含 sub/role），全部业务数据表 MUST 以 owner_id 贯穿归属。账户禁用语义 MUST 为禁写不禁读；role 值域 MUST 预留 admin/user/anonymous 三值（收费升级不改表结构）。匿名账户 MUST 不可改密/不可提权/不可删除。

#### Scenario: 开箱匿名
- **WHEN** 全新数据根首启 daemon 后浏览器打开
- **THEN** 自动以匿名账户登录，可正常创建任务与资产；后续管理员账户创建后多账户并存互不可见对方数据

### Requirement: 服务端密钥管理
图像生成 API 与 Agent LLM 的密钥 MUST 由服务端管理：.env 模板缺失时自动创建（0600），向导/设置回写 MUST 原位保留注释与行序；运行时 MUST 以 settings 表优先、.env 兜底的双层真源解析；半配置（必需键不齐）MUST 视为未配置并在任务创建时显式拒绝而非魔术跑通；密钥值 MUST NOT 出现在任何读面 API。

#### Scenario: 半配置拒绝
- **WHEN** .env 只配了图像 API 的 baseUrl 未配 key，用户发起生成任务
- **THEN** 任务创建被拒并提示缺哪个键；配齐后同参数任务可创建

### Requirement: 任务与资产的 服务端持久化
长任务（生成/引擎重活）MUST 服务端执行并以 WS 帧流推送进度：帧 MUST 持久化（jsonl）并支持 afterSeq 游标回放，断线重连 MUST 不丢帧。资产（图/文档）MUST 入内容寻址 blob 存储（sha256+引用计数，归零回收）。四族文件格式（.gemproj/.gemdoc/.gemtpl/.gemgen）MUST 支持与服务器资源模型的无损导入导出往返。结果 MUST 可生成 public_id 分享包（/r/{public_id} 访问，含 containment 防穿越）。

#### Scenario: 断线重连不丢帧
- **WHEN** 任务运行中断开 WS 并在若干帧后重连（携带 afterSeq）
- **THEN** 客户端先收到重连窗口内的持久帧回放，再续收实时帧，无缺失无重复

### Requirement: Agent 工具面与编排
产品 MUST 通过 MCP（streamable-http 环回）向 dsh-agent 内核暴露原子工具：工具 MUST 以 capability 规范定义（Zod 输入/输出 + authority 三级 readonly/proposal/approved-mutation），approved-mutation MUST 仅在用户批准后可调。内核通用 fs/shell/web 工具 MUST 全禁（deny-list 双层收窄），agent 可见工具面仅产品工具+ask_user/todo。同任务同工具连续相同失败 MUST 触发熔断（取消会话+任务失败）。agent 内核挂载失败 MUST 降级（相关端点 501）不阻塞其余服务。

#### Scenario: 提议-批准编辑
- **WHEN** 用户在任务会话说「把帽子区域的钻改密一点」
- **THEN** agent 产出 proposal 工具生成的修改预览（不动真值），用户批准后 approved-mutation 工具以单 op 落库，一次撤销可恢复整组

### Requirement: GPU 计算提供者抽象
系统 MUST 定义 ComputeProvider 接口缝（submit/status/result/cancel）并以本机 Inline 实现满足当前全部计算；接口 MUST 版本化序列化契约以容纳未来国内外 GPU 租赁 API 适配器；本 change MUST NOT 实现任何远程适配器。

#### Scenario: 本机内联执行
- **WHEN** 引擎重活（排钻/导出）经 ComputeProvider 提交
- **THEN** InlineProvider 进程内直调引擎完成并回传产物，接口行为与未来远程适配器一致
