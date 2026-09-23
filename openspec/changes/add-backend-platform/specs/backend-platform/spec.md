# Delta: backend-platform（新 capability）

> R1 修订（2026-09-23，codex-review-r1 P1-1/3/5/7/8 处置）：平台收敛 darwin-arm64、批准授权桥 MUST、降级隔离精确化、短会话生命周期新 requirement、格式往返口径统一。

## ADDED Requirements

### Requirement: 私有化部署与托管形态
后端 MUST 以单进程 Node 服务交付，**首发唯一支持平台为 darwin-arm64**（Windows/Linux/Docker 为后续 change，本 change MUST NOT 声明其支持）。daemon MUST 静态托管前端 SPA（无点路径回退 index.html）并默认绑定 127.0.0.1（HOST 可开局域网）。前端构建产物 MUST 可入库分发（克隆即跑免构建），启动时 dist 缺失 MUST 明确报错并给出构建指引。GitHub Pages 渲染应用的模式 MUST 退役（仓库 CI 仅构建产物/镜像）。darwin-arm64 门禁 MUST 验证：依赖安装（better-sqlite3/tsx 预编译）、daemon 启停、SQLite 迁移、SPA 分发。

#### Scenario: 克隆即跑
- **WHEN** 在全新 darwin-arm64 机器克隆仓库并按 README 安装依赖后执行启动脚本
- **THEN** daemon 起服（默认本机端口），浏览器打开即匿名可用，数据与 .env 落在数据根目录，无需手工编译

#### Scenario: dist 缺失显式失败
- **WHEN** 数据根外的前端 dist 目录缺失或损坏时启动 daemon
- **THEN** daemon 以明确错误退出并提示构建命令，不得以无样式/空白 SPA 静默起服

### Requirement: 匿名默认账户与多账户预留
系统 MUST 内置匿名账户（幂等自愈的 `__anonymous__` 用户行），且匿名访问 MUST 默认开启（单账户开箱即用）。认证 MUST 采用 JWT（载荷含 sub/role），全部业务数据表 MUST 以 owner_id 贯穿归属。账户禁用语义 MUST 为禁写不禁读；role 值域 MUST 预留 admin/user/anonymous 三值（收费升级不改表结构）。匿名账户 MUST 不可改密/不可提权/不可删除。管理员账户 MUST 经 `.env ADMIN_*` 键族在 daemon 启动时幂等创建（唯一建号流程；轮换=改 .env 重启）。

#### Scenario: 开箱匿名
- **WHEN** 全新数据根首启 daemon 后浏览器打开
- **THEN** 自动以匿名账户登录，可正常创建任务与资产；配置 ADMIN_* 重启后多账户并存互不可见对方数据

### Requirement: 服务端密钥管理
图像生成 API 与 Agent LLM 的密钥 MUST 由服务端管理：.env 模板缺失时自动创建（0600），向导/设置回写 MUST 原位保留注释与行序；运行时 MUST 以 settings 表优先、.env 兜底的双层真源解析；半配置（必需键不齐）MUST 视为未配置并在任务创建时显式拒绝而非魔术跑通；密钥值 MUST NOT 出现在任何读面 API（仅存在性+尾 4 位脱敏）。Agent 主面 MUST NOT 依赖浏览器本地（localStorage）密钥。

#### Scenario: 半配置拒绝
- **WHEN** .env 只配了图像 API 的 baseUrl 未配 key，用户发起生成任务
- **THEN** 任务创建被拒并提示缺哪个键；配齐后同参数任务可创建

### Requirement: 任务与资产的服务端持久化
长任务（生成/引擎重活）MUST 服务端执行并以 WS 帧流推送进度：帧 MUST 持久化（jsonl）并支持 afterSeq 游标回放，断线重连 MUST 不丢帧。任务 MUST 区分 job（生成/引擎作业）与 agent（会话）两族状态机（共用帧传输，kind 值域分离）。资产（图/文档）MUST 入内容寻址 blob 存储（sha256+引用计数，归零回收）。四族文件格式（.gemproj/.gemdoc/.gemtpl/.gemgen）MUST 支持与服务器资源模型的**当前版本内语义无损**导入导出往返（字段/资产引用/顺序/工程参数零丢失；不要求字节相等；跨版本不承诺向后兼容——旧版本文件显式拒读报版本错误，不静默丢字段）。结果 MUST 可生成 public_id 分享包（/r/{public_id} 访问，含 containment 防穿越）。

#### Scenario: 断线重连不丢帧
- **WHEN** 任务运行中断开 WS 并在若干帧后重连（携带 afterSeq）
- **THEN** 客户端先收到重连窗口内的持久帧回放，再续收实时帧，无缺失无重复

#### Scenario: 当前版本格式往返
- **WHEN** 导入 .gemproj/.gemdoc/.gemtpl/.gemgen 文件后再导出同族格式
- **THEN** 以 fixture 断言字段、资产引用、顺序与工程参数零丢失（语义无损，不比对字节）

### Requirement: 短会话生命周期与分享留存
系统 MUST 提供 session.clear（原子事务：删会话/任务行/帧 jsonl/解引用会话私有 blobs——引用计数归零即物理删除），失败 MUST 整体回滚不留悬空引用，重试 MUST 幂等。public_id 分享包 MUST 与会话生命周期解耦（其引用的 blob 标记 shared，clear 不触发删除），默认 7 天 TTL（.env 可调）或显式 revoke 时回收；clear 进行中分享包并发访问 MUST 不受影响。

#### Scenario: 下载后清空会话
- **WHEN** 用户下载结果 bundle 后执行清空会话
- **THEN** 会话、任务、帧与私有 blobs 被原子回收且无悬空引用；已生成的分享包仍可访问直至 revoke 或 TTL 到期

### Requirement: Agent 工具面与编排
产品 MUST 通过 MCP（streamable-http 环回，loopback-only+进程周期 token）向 dsh-agent 内核暴露原子工具：工具 MUST 以 capability 规范定义（Zod 输入/输出 + authority 三级 readonly/proposal/approved-mutation）。approved-mutation MUST 经服务端可验证的授权桥：用户批准（session.answer）签发绑定 {task, op 内容摘要, user, 过期时间} 的一次性凭据，agent 携匹配凭据时该 op 恰好可执行一次；无凭据直调、摘要不匹配、过期、重放 MUST 全部拒绝。撤销 MUST 以批准组为单位持久化（一次撤销恢复整组）。排布控制参数（密度/最小间距/排布模式/区域）MUST 为工具一等输入并以引擎类型为真源冻结（区域首版=用户可寻址的图块/图层 ID）。内核通用 fs/shell/web 工具 MUST 全禁（deny-list 双层收窄），agent 可见工具面仅产品工具+ask_user/todo。同任务同工具连续相同失败 MUST 触发熔断（取消会话+任务失败）。agent 内核挂载失败（含 dsh 缺包/懒加载失败）MUST 降级：**仅 agent 会话/MCP 相关端点返回 501，上传/生成/排钻/导出/分享等基础工作流 MUST 保持完整可用**。

#### Scenario: 提议-批准编辑
- **WHEN** 用户在任务会话说「把这块区域的钻改密一点」（区域=已寻址的图块/图层）
- **THEN** agent 产出 proposal 工具生成的修改预览（不动真值），用户批准后 approved-mutation 工具凭一次性凭据以单 op 落库，一次撤销可恢复整组

#### Scenario: 越权与重放必拒
- **WHEN** agent 无凭据直调 approved-mutation、凭据指向另一 op、凭据过期或已消费后重放
- **THEN** 全部被拒绝且真值零变化

#### Scenario: agent 面降级不殃及基础工作流
- **WHEN** dsh 内核被显式关闭、缺包或挂载抛错时
- **THEN** 仅 agent 会话/MCP 端点返回 501；上传→生成→排钻→导出→分享全链仍可用

### Requirement: GPU 计算提供者抽象
系统 MUST 定义异步 ComputeProvider 接口缝（submit/status/result/cancel，submit 携幂等键——同键重放返回同 JobRef）并以本机 Inline 实现满足当前全部计算；接口 MUST 版本化序列化契约以容纳未来国内外 GPU 租赁 API 适配器；本 change MUST NOT 实现任何远程适配器。

#### Scenario: 本机内联执行
- **WHEN** 引擎重活（排钻/导出）经 ComputeProvider 提交
- **THEN** InlineProvider 进程内直调引擎完成并回传产物，接口行为与未来远程适配器一致

### Requirement: Agent 优先界面形态
产品主界面 MUST 为 Agent 会话形态：任务会话列表、会话流（实时帧进度与审批应答）、结果页与分享包；会话交互 MUST 按冻结契约（create/list/followup/answer/cancel/replay/result）实现。传统三工作台 UI（提示词实验室/排钻工作台/设计师工作台）MUST 默认隐藏于开发者旗标后（不删除），其算法能力 MUST 经 capability 工具层供 agent 调度；三工作台相关测试 MUST 按冻结分类执行（默认无旗标=Agent 主面断言；开旗标=可访问性冒烟；引擎/格式/能力测试永跑），MUST NOT 因默认隐藏而静默跳过。

#### Scenario: 默认进入 Agent 主面
- **WHEN** 用户打开应用
- **THEN** 直接进入 Agent 会话主面；三工作台不在导航可见；开启开发者旗标后可访问传统工作台（零维护承诺下的现状入口）

#### Scenario: 会话断线恢复
- **WHEN** agent 会话中刷新页面或断线后重连（携带 afterSeq）
- **THEN** 帧回放无缺失后续收实时帧，未应答的审批请求仍可应答
