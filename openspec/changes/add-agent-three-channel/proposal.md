# Proposal: add-agent-three-channel

## Why

shufa 项目 2026-09-25 落地 W10「agent 对话三通道+队列面板」（b6cec8a+W10c/d/e 三轮迭代），把 `@deepseek-ai/dsh-agent` 库原生的会话控制能力（cancel/keepInbox、steer、inject、inbox）暴露到 RPC 与 UI。贴钻 daemon 与 shufa 同源依赖同一套 dsh-* 0.1.6-alpha.1（P1-1 收敛成果），底层能力同具备，但贴钻侧只暴露了 followup+终态 cancel——运行中会话无法打断续聊、无法排队、无法引导，Agent 对话体验落后 shufa 一代。Owner 定调：以 shufa 的代码为准，尽量复用。

## What Changes

- **契约**（contracts）：`TaskFollowupInput` 增 `mode: 'followup' | 'steer'`（缺省 followup）；新增 `TaskStopInput/Output`（打断≠终态取消：任务回 done 可续聊，cancelled 不可续聊保持管理面语义）
- **内核接线**（daemon/kernel）：sessions 增 steer（live 投递 entry.agent.steer，消息构造与 followup 同构）；inbox 可见性面（nextTurn/nextStep 读；remove/replace/splice 改——队列编辑的「暂离内核」语义）
- **任务服务**（daemon）：`tasks.stop`——live cancel(keepInbox:true)+任务置 done（error 清空）+status 帧；非 running no-op；followup(mode) 分流 steer
- **RPC**：tasksStop 端点
- **前端**（rhinestone-studio）：composer 三通道（running 空输入时发送位变停止按钮；Enter 排队即时反馈条；Zap 引导按钮）+队列面板（composer 上方队列列表：文本+模式徽标+编辑/改模式/删除；编辑=splice 暂离冻结+文本回填+确认放回；手风琴/锁定 status/拖动排序/立刻发送——照 shufa W10c/d/e 成熟形态复写）
- **走查支撑**：URL query demoDelay 走查演示开关（复用 shufa 模式）

## Impact

- contracts/tasks、daemon kernel+tasks/rpc、rhinestone-studio agentApi stores+ComposerCard/QueuePanel
- 复用参考：shufa b6cec8a（契约 72 行+内核 146+service 115+UI 392）与 W10c/d/e 迭代提交、changes/W10-agent对话三通道.md 设计文档
- 风险：打断/终态取消的语义区分要在测试里固化（stop 后可续聊 vs cancel 不可续聊）；队列编辑的 splice 暂离-放回时序（idle 唤醒边界）
