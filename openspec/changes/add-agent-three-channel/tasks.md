# Tasks: add-agent-three-channel

## 1. 契约与内核

- [x] 1.1 contracts：TaskFollowupInput.mode（followup|steer 缺省 followup）+TaskStopInput/Output；schema 测试
- [x] 1.2 daemon kernel sessions：steer（live 投递，消息构造与 followup 同构；面板语义分流不进 steer）+inbox 面（nextTurn/nextStep 读+remove/replace/splice）
- [x] 1.3 daemon tasks/service：stop()（live cancel+置 done+error 清空+done 终态帧；非 running no-op；口径=前端外环——inbox 消费不承诺，见 proposal 裁定）+followup(mode) 分流
- [x] 1.4 rpc：tasksStop 端点+测试（打断后可续聊/cancel 后不可续聊两态固化+裸 TaskView wire 形状——Codex W10 P0-1）

## 2. 前端三通道+队列面板

- [x] 2.1 agentApi store：stopTask 封装（乐观置 done）+sendPrompt(mode) 透传
- [x] 2.2 ComposerCard：running 空输入时发送位变停止按钮；Enter 排队即时反馈条；Zap 引导按钮
- [x] 2.3a 队列面板基础（已交付）：队列列表（文本+模式徽标+编辑/删除）；编辑=暂离冻结+文本回填（有未发送内容拒绝）+确认按原序放回（idle 首条唤醒）；手风琴+易失性标注（Codex W10 P1-2/P1-3 拆分）
- [ ] 2.3b 完整队列面板（后续波）：立刻发送（queueSendNow）/拖动排序（queueReorder）/inject 通道——依赖后端队列端点（见 proposal 后续波清单）
- [x] 2.4 走查支撑：demoDelay URL query 演示开关
- [x] 2.5 mock/rpc 双通道测试+jsdom 队列交互测试

## 3. 收尾

- [x] 3.1 spec delta（agent 对话控制面能力）+strict 验证
- [ ] 3.2 真环境走查（rpc 模式装载会话→打断/排队/引导三通道操作截屏+vision 判读）
- [ ] 3.3 三仓门禁+tasks 勾选+验收报告
