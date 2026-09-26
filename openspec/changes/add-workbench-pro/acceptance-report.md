# 交付验收报告——W10 三通道 + 工作台专业化（双 change）

日期：2026-09-27 ｜ 分支：add-backend-platform-impl（HEAD 49a2a90，全部已推送）
评审：Codex remix 闭环九轮（herdr 大地三全程）

## 一句话结论

**两条 change 均达 Codex 条件放行**：add-agent-three-channel 8.4/10（收窄口径条件放行）、add-workbench-pro 9.0/10（**CONDITIONAL-GO 生产放行生效**——Codex 终裁原话「最终裁定为 CONDITIONAL-GO，生产放行生效」）。可交付 Owner 验收。

## Change 1：add-agent-three-channel（W10 对话三通道——shufa 同步主线）

打断/排队/引导全链（dsh-agent 原生能力暴露）：运行中点停止可续聊（≠终态取消）/运行中发消息自动排队+队头串行/引导即时投递影响当前轮/队列面板（查看/删除/暂离编辑）+demoDelay 走查开关。队列=前端外环唯一真源（贴钻一次对话=一个任务架构下的正确适配；ephemeral 边界界面+文档双标注）。spec 5R/9S strict 过+真实走查 9/9。

## Change 2：add-workbench-pro（工作台 Photoshop 级打磨）

| 波 | 交付 | Codex 评 |
|---|---|---|
| 1 | zhumo 式三栏（会话\|对话\|任务详情 Resizable）+移动 Sheet+响应式 | 走查 PASS |
| 2a | 三写 RPC 契约冻结（reorder/delete/mask.patch+CAS/幂等/八错误码/状态机五态/导出门/view-state/undo 四域）+DB v7 | 7.1 CONDITIONAL |
| 2a-P0 | 导出门真接线（task.export 服务端重算门）/view-state 幽灵拒/删除原子性（红→绿） | 关闭 |
| 2b | 遮罩可视化（缩略图+blob 全链 LRU+选中高亮+4096 徽标）+笔刷编辑闭环（B 键/两笔刷/半径/撤销/CAS 重放）+view-state 服务端化+导出消费+预览白钻对比环 | 5.2→修复 |
| 2b-fix | 状态机运行路径（accepted→recomputing→ready/error/stale+代次 token 四处条件更新）/插值资源上限三侧/mock blob 回写/竞态四修/2.6 四项（401 自愈/标签避让/父节点守卫/拆层命名） | 6.8 |
| 2c | 图层拖拽重排（三落区+键盘等价）/删除确认/锁定/命令总线 18 命令（IME 保护）/鼠标 P0（锚定缩放/平移/mask 位面精确命中）/状态栏（ppm 三态不伪装）/undo 四域路由/canvaskit 抽取双消费/并发 CAS 回归 | 7.1 |
| 终验 | a11y roving focus/性能门 18/18（hot.100k 651→0.15ms 根因修/4K² 42.5ms）/真浏览器 17/17（含阻断态 8/8：incomplete→导出拒→放弃→恢复） | 7.0 |
| 收尾 | stale/error 恢复链全链（重算/放弃按钮）/retry 零行/停机屏障/测试生命周期 | **9.0 CONDITIONAL-GO** |

## Owner 验收入口

- 演示 daemon 已运行：http://127.0.0.1:8792（PID 51059；DATA_ROOT=干净真识别数据 journey-clown-real-20260927——macmini SAM3 真识别，1888 颗）
- 浏览器控制台：`localStorage.setItem('handicraft.agentApi','rpc'); localStorage.setItem('handicraft.dev.workbenches','1')` → 刷新
- 推荐动线：Agent 会话「给小丑贴钻（真识图演示）」→ 右栏任务详情 → 打开完整工作台 → ①图层行掩码缩略图+蒙版开关 ②B 笔刷涂抹→应用看重算 ③拖拽重排/删除 ④V/H/Z+滚轮缩放+空格平移+点选层 ⑤Ctrl+Z ⑥导出
- 走查留档：experiments/workbench-perf-20260927/walkthrough/（13+4 截图+断言 JSON）+性能 receipt（perf:gate 可复跑）
- macmini 真识别随时可用（旅程脚本一键：JOURNEY_OUT=<目录> tsx scripts/journey-demo-clown.ts）

## 已知限制与挂账（交 Owner 排期）

1. **2.6b undo 增量三件**（已提交掩码前驱快照精确逆/跨 revert 线性游标/多域 redo）——已移出本 change 范围立后续 change（本 change undo 声明面=四域游标+路由+结构/视图/参数/笔画域回退）
2. **worker 解码架构**（4K² 掩码 42.5ms 已过门但单线程余量有限——100k 颗级会话建议 worker 化）
3. **W10 2.3b 完整队列**（持久化队列/立刻发送/拖动排序/inject 通道——UI 禁用位已留零旁路）
4. macmini 识图 25-70s/次（M1 硬件特性）；LLM 无 key（策略指派为脚本代演——配 key 即真 AI 旅程）
5. 队列为本地标签页态（刷新丢失——界面已标注；生产持久化待 2.3b）

## remix 闭环账目（九轮评审）

proposal 4.2→W10 6.0→8.4｜2a 7.1→2b 5.2→6.8｜2c 7.1（合并 6.6）→终验 7.0→收尾 9.0 CONDITIONAL-GO。每轮 Codex 独立 detached worktree 实跑验证；抓出的关键真问题：跨层响应形状漂移/笔刷坐标错位（测试替身盲区）/同节点代次竞态/导出门未接真实路径/勾选超前——全部修复闭环。
