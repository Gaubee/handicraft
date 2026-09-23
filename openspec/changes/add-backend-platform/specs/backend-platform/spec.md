# Delta: backend-platform（新 capability）

> R1 修订（codex-review-r1 P1-1/3/5/7/8 处置）；R2 修订（codex-review-r2 B1-B8 处置）：回放游标 task 域+clear 入契约、授权桥全工具面+服务端内部消费+版本 CAS、MCP 独立 loopback listener、短会话跨介质清理协议、排布参数以引擎真源冻结。
> R3 修订（codex-review-r3 两 P1+四 P2 处置）：approved-mutation 持久 operation 状态机（本地幂等/外部诚实降级 unknown）+撤销按族拆分（patch 整组/generate cancel+清理/export revoke）、clear 并发栅栏（原子拒新+drain+writer fence+blob deleting 防复活+unlink 前重验）+cleared tombstone。
> R4 修订（codex-review-r4 处置）：generate 重试 provider 分支语义（不支持幂等键=不承诺唯一远端结果）+启动扫描非终态→unknown、blob 代际物理路径消除删除/上传竞态窗口。


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
系统 MUST 提供 session.clear，其清理 MUST 采用跨介质可恢复协议（数据库事务标记 clearing+cleanup outbox → 幂等 unlink 文件 → 完成标记；daemon 启动 MUST 重放未完成清理）：任何阶段崩溃后重启 MUST 恢复至一致状态（无悬空引用、无孤儿文件），重试 MUST 幂等，已清会话保留 cleared tombstone（重复 clear 幂等成功）。**并发栅栏**：clearing 生效后新 followup/answer MUST 原子拒绝、运行中 agent task MUST 取消或 drain；帧/产物 writer MUST 与会话可写校验同事务（无迟到帧/无孤儿产物）；引用归零的 blob MUST 置 deleting 状态阻止引用复活（新引用同内容=新建行+**新代际物理路径** `<sha256>.<rowGen>`——旧行 unlink 结构性不可能命中新代文件，删除与并发上传的竞态窗口 MUST 消除），unlink 前事务内重验唯一性保留为第二道保险（并发重新上传不得丢文件或悬空）。public_id 分享包 MUST 与会话生命周期解耦——结果经独立的 result→blob 引用行持有引用（非 blob 级标记，以承载多个 result 的不同生命周期），clear 只撤销会话侧引用；每个 result MUST 支持独立 TTL（默认 7 天，.env 可调）与显式 revoke；clear 进行中分享包并发访问 MUST 不受影响。

#### Scenario: 下载后清空会话
- **WHEN** 用户下载结果 bundle 后执行清空会话
- **THEN** 会话、任务、帧与私有 blobs 被回收且无悬空引用；已生成的分享包仍可访问直至 revoke 或 TTL 到期

#### Scenario: 清理中途崩溃可恢复
- **WHEN** session.clear 执行到文件删除阶段前后进程崩溃，随后 daemon 重启
- **THEN** 启动清理重放完成回收，数据库无悬空引用、文件系统无孤儿文件遗留

#### Scenario: 清理与并发写入/上传隔离
- **WHEN** session.clear 进行中该会话仍有 agent task 在写帧，或另一会话在清理待删期间重新上传相同内容（同 sha256）
- **THEN** 活跃 task 被取消/drain 且无迟到帧落库；重新上传的新引用完整保有该内容文件（不丢 blob、不悬空）

### Requirement: Agent 工具面与编排
产品 MUST 通过 MCP（streamable-http 环回+进程周期 token，跑在**独立 loopback listener 专用端口**——主 HTTP 开局域网监听时 MCP MUST NOT 随行暴露，非 loopback 连接 MUST 拒绝）向 dsh-agent 内核暴露原子工具：工具 MUST 以 capability 规范定义（Zod 输入/输出 + authority 三级 readonly/proposal/approved-mutation）。approved-mutation（全部三类变更工具：patch-apply/generate/export）MUST 经服务端可验证的授权桥：用户批准（session.answer）签发绑定 {task, op 内容摘要, user, 资源版本 baseRevision, 过期时间} 的一次性授权——授权凭据 MUST 仅存于服务端、MUST NOT 出现在任何帧/API 载荷/MCP 工具参数中；agent 调用工具只携带 proposalId，服务端内部校验匹配且未消费未过期时放行。变更 MUST 以持久 operation 记录执行（proposalId=唯一幂等键，状态机 approved/claimed/running/succeeded/failed/unknown，先原子 claim 再执行）：本地确定性 op（patch-apply/export）MUST 恰好执行一次（重复调用返回同一结果）；涉外部远端调用的 op（generate）重试语义 MUST 按 provider 分支——支持幂等键则复用同一键收敛至同一远端结果；不支持则崩溃于远端接受后写回前=unknown，用户确认重试创建新的远端尝试（可能再次计费）且 MUST NOT 承诺唯一远端结果（本地 proposalId 仅去重并发触发）。daemon 启动 MUST 扫描非终态（claimed/running）operation 并转 unknown 呈现用户裁决；failed 仅由执行路径内确定性错误写入。资源当前版本与 baseRevision 不符（批准期间目标被改动）MUST 拒绝并要求重新预览批准。无授权直调、摘要不匹配、过期、重放、跨任务/用户使用 MUST 全部拒绝。撤销语义 MUST 按族拆分：patch 族以批准组为单位持久化逆序回退（一次撤销恢复整组）；generate 族补偿=未完成 cancel+产物清理；export 族补偿=revoke 分享包+bundle 引用释放——MUST NOT 声称跨族整组撤销。排布控制参数（密度/间隙/排布模式/区域）MUST 为工具一等输入并以引擎现行 schema 为真源冻结（策略枚举含全部现行值；密度为全局或逐块 (0,1]；间隙为 gapMm≥0；区域首版=用户可寻址的图块 ID，引擎无图层概念）。内核通用 fs/shell/web 工具 MUST 全禁（deny-list 双层收窄），agent 可见工具面仅产品工具+ask_user/todo。同任务同工具连续相同失败 MUST 触发熔断（取消会话+任务失败）。agent 内核挂载失败（含 dsh 缺包/坏包/懒加载失败）MUST 降级：**仅 agent 会话/MCP 相关端点返回 501，上传/生成/排钻/导出/分享等基础工作流 MUST 保持完整可用**。

#### Scenario: 提议-批准编辑
- **WHEN** 用户在任务会话说「把这块区域的钻改密一点」（区域=已寻址的图块 ID）
- **THEN** agent 产出 proposal 工具生成的修改预览（不动真值），用户批准后 approved-mutation 工具经服务端内部授权校验以单 op 恰好一次落库，patch 族一次撤销可恢复整组

#### Scenario: 外部副作用的崩溃恢复
- **WHEN** generate 类操作在远端图像 API 接受请求后、结果写回前进程崩溃，daemon 重启
- **THEN** 启动扫描将该 operation 转为 unknown 呈现用户裁决（不谎报成功/失败）；若 provider 支持幂等键，重试复用同键收敛同一远端结果；若不支持，用户确认的重试创建新的远端尝试（如实提示可能再次计费），不承诺唯一远端结果

#### Scenario: 越权、漂移与重放必拒
- **WHEN** agent 无有效 proposal 直调 approved-mutation、授权指向另一 op、过期、已消费后重放、跨任务/用户使用，或批准等待期间目标资源已被其他写入修改（版本漂移）
- **THEN** 全部被拒绝且真值零变化（版本漂移要求重新预览与批准）

#### Scenario: agent 面降级不殃及基础工作流
- **WHEN** dsh 内核被显式关闭、缺包或挂载抛错时
- **THEN** 仅 agent 会话/MCP 端点返回 501；上传→生成→排钻→导出→分享全链仍可用

### Requirement: GPU 计算提供者抽象
系统 MUST 定义异步 ComputeProvider 接口缝（submit/status/result/cancel，submit 携幂等键——同键重放返回同 JobRef）并以本机 Inline 实现满足当前全部计算；接口 MUST 版本化序列化契约以容纳未来国内外 GPU 租赁 API 适配器；本 change MUST NOT 实现任何远程适配器。

#### Scenario: 本机内联执行
- **WHEN** 引擎重活（排钻/导出）经 ComputeProvider 提交
- **THEN** InlineProvider 进程内直调引擎完成并回传产物，接口行为与未来远程适配器一致

### Requirement: Agent 优先界面形态
产品主界面 MUST 为 Agent 会话形态：任务会话列表、会话流（实时帧进度与审批应答）、结果页与分享包；会话交互 MUST 按冻结契约（create/list/get/followup/answer/cancel/clear/replay/result）实现，回放游标 MUST 以 task 为域（每 task 独立单调），会话结果查询 MUST 有确定性选择语义。传统三工作台 UI（提示词实验室/排钻工作台/设计师工作台）MUST 默认隐藏于开发者旗标后（不删除），其算法能力 MUST 经 capability 工具层供 agent 调度；三工作台相关测试 MUST 按冻结分类执行（默认无旗标=Agent 主面断言；开旗标=可访问性冒烟；引擎/格式/能力测试永跑——既有实现零改动、测试文件允许按分类显式更新），MUST NOT 因默认隐藏而静默跳过。

#### Scenario: 默认进入 Agent 主面
- **WHEN** 用户打开应用
- **THEN** 直接进入 Agent 会话主面；三工作台不在导航可见；开启开发者旗标后可访问传统工作台（零维护承诺下的现状入口）

#### Scenario: 会话断线恢复
- **WHEN** agent 会话中刷新页面或断线后重连（携带 afterSeq）
- **THEN** 帧回放无缺失后续收实时帧，未应答的审批请求仍可应答
