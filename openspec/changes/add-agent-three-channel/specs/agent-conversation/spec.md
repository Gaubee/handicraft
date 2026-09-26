# agent-conversation 能力增量（add-agent-three-channel）

## ADDED Requirements

### Requirement: 对话打断（stop≠终态取消两态固化）

agent 对话 SHALL 支持打断当前轮：`tasks.stop` 对 running/queued 的 agent 任务中止生成，任务以 done 终态帧+行 done 收口（params 内历史 error 剥离）；打断后同会话 SHALL 可续聊（再 followup 即开新 task）。打断与终态取消 SHALL 保持两态区分：终态取消（`tasks.cancel` → cancelled，管理面语义）后迟到帧被 writer fence 丢弃、stop 拒绝操作、不可续聊。非 running/queued 的 stop 幂等返回现值；已取消任务拒绝；job 族无对话轮可打断（no-op 返回现值）。内核 cancel 携带的 keepInbox 仅为对齐 dsh cancel 惯例——**inbox 消费不承诺**（live 会话随收口 dispose，排队消息延续由前端队列外环负责；后端 inbox 持久化属后续波）。

#### Scenario: 打断后可续聊

- **when** running agent 任务 tasks.stop → done 终态帧+行 done+error 清空；同会话再 followup → 新 task 正常建行收帧
- **when** 非 running 任务 tasks.stop → 幂等返回现值、不加终态帧
- **when** cancelled 任务 tasks.stop → 拒绝（已取消的任务不可操作）

#### Scenario: 终态取消对照

- **when** tasks.cancel 后内核迟到帧提交 → 被 writer fence 丢弃（帧流冻结于取消点）
- **when** stop 与 cancel 交错 → 打断收口 done 不复活已被取消的行（终态不覆盖幂等）

### Requirement: 排队通道（前端队列外环——唯一真源）

贴钻约束「一次 followup=一个 agent task」下，会话有运行中任务时的常规发送 SHALL 进入前端投递队列（不并行开任务），当前轮结束（自然 done 或打断收口）后队头按序自动以常规 followup 开跑。队列 SHALL 支持查看/逐条删除/暂离编辑（编辑期间自动开跑冻结、确认按原序放回）与清空。投递失败 SHALL 将条目放回队头并熔断自动开跑（防连败死循环，用户动作或下一次 done 复位）。

#### Scenario: 运行中排队与自动串行

- **when** running 中常规发送 → 即时入队反馈（不入内核）；当前任务 done（含打断收口）→ 队头自动开跑、依次串行
- **when** 暂离编辑确认 → 条目原位更新且自动开跑恢复判定
- **when** 队头投递失败 → 条目回队头+自动开跑熔断（不连败重试）

### Requirement: 前端队列 ephemeral 边界显式声明

本波队列为活跃会话内存态（ephemeral MVP）：单标签页生效、刷新/关闭标签页/RPC 重连丢帧窗口内丢失、切会话即清空、无多端一致性。队列面板 SHALL 在 UI 上显式标注该边界；生产级持久化（后端 inbox 持久化或 IndexedDB、sendNow/reorder/inject 通道）SHALL 作为后续波显式记录，不得在本波验收中宣称。

#### Scenario: 边界守卫

- **when** 刷新或关闭标签页 → 未开跑队列条目丢失（产品口径已标注，不判失败）
- **when** 切换会话 → 队列清空（活跃会话域）
- **when** 本波验收 → sendNow/拖动排序/inject 通道缺席不判失败（UI 保持禁用占位，不做旁路）

### Requirement: 引导通道（steer——仅当前 live turn 即时投递）

运行中任务的引导发送 SHALL 即时投递内核（dsh steer——下一 step 边界消费、影响当前轮、同 taskId 不开新任务）；idle 会话的引导 SHALL 等价常规发送（开新任务）。steer 是唯一进入内核 inbox 的通道，且只承诺当前 live turn——任务收口后 inbox 即随 live 销毁，不承诺跨轮保留。

#### Scenario: 引导即时投递

- **when** running 任务引导发送 → 不排队、不新增 task（同 taskId，帧走既有订阅）
- **when** idle 会话引导发送 → 等价常规发送（开新任务）

### Requirement: tasks.stop wire 契约（裸 TaskView）

`tasks.stop` 的 RPC 响应 SHALL 为裸 TaskView（TaskStopOutputSchema=TaskViewSchema，strict）；`{task}` 包装形 SHALL 被前端契约守门拒绝。跨层形状一致性 SHALL 由真实 router 响应过同一 schema 的测试固化。

#### Scenario: wire 形状守门

- **when** daemon 真实 router 的 stop 响应 → 过 TaskStopOutputSchema 成功（裸形）
- **when** 响应为 {task: view} 包装形 → strict schema 拒绝（前端 façade 与 daemon 测试两侧一致拦截）
