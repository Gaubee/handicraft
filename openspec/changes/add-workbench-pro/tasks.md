# Tasks: add-workbench-pro

## 波 1：任务详情布局改版（zhumo 模式）

- [x] 1.1 依赖引入：shadcn resizable（paneforge 同款——shufa 已验证）
- [x] 1.2 AgentView 桌面三栏（会话|对话|任务详情 Resizable+autoSaveId 比例记忆）
- [x] 1.3 TaskDetailPanel 轻量详情（状态/图层摘要/gems/预览缩略/动作入口）+snippet 单实例复用
- [x] 1.4 移动端 Sheet 抽屉（<md）+响应式断点全测
- [x] 1.5 走查（桌面三栏拖拽+移动 sheet）+vision 判读

## 波 2a：契约冻结+基建标记+文档同步（2026-09-26 已落地——本波不做 UI）

- [x] 2a.1 contracts 冻结：layer.reorder/layer.delete/layer.mask.patch 三写契约（CAS/幂等/错误码八值/版本返回）+mask 编辑状态机五态+exportGate 三阻断+view-state 工件/锁定语义+task.detail 扩面（viewState/maskEdits/exportGate）+tree cause 六值
- [x] 2a.2 daemon 端点骨架：三写方法+view.state.set 端点+task.detail 扩面接线（typed 校验+版本入史+CAS/锁定门全实现；reexecutePlan 共用段）
- [x] 2a.3 DB v7 迁移：tree_versions cause 扩六值（表重建平移）+mask_edit_states 表
- [x] 2a.4 行为测试固化：contracts workbench-pro.test（11）+daemon workbench-pro.test（19：CAS 漂移/锁定/根删/环路/导出阻断/状态机/收敛重算/RPC 载荷）+db v7（3 新）
- [x] 2a.5 design 附录：D-2 盲点裁定（12 条）+D-3 undo 四域状态机+交错示例；§4 三层性能门 receipt 规范；§1 契约落地注记
- [x] 2a.6 proposal/tasks 同步（多选/批量降 P1 修正）+spec delta（specs/workbench-pro/spec.md——去 skip_specs）+openspec validate --strict
- [x] 2a.7 2b 前置：Codex 2a 复核 P0×3 修复（CONDITIONAL-GO 7.1/10 的关闭条件——红→绿两段式回归测试）——P0-1 task.export 导出门真实接线（服务端以 mask_edit_states 重算门，allowed=false 时 export-blocked+完整 blockers）/P0-2 view-state 节点归属门（全部 nodeId 必须在电流树——幽灵/已删节点拒 view-state-invalid）/P0-3 layer.delete 提交协议原子化（可失败步骤先行、帧发布收尾——重算/版本/清理三注入失败均无「新树已生效、历史缺失」半状态）
- 注：designer viewport/keymap 基建抽取挪 2c（W10 前端子代理正在 rhinestone-studio 并行——冲突避让；§0 红线即 2a 的复用面标记）

## 波 2：工作台专业化（Photoshop 级）

- [x] 2.1 遮罩可视化：图层行 mask 缩略图+画布蒙版叠加增强（Owner 核心质疑的答案）——**blob mask 全链（拉取/缓存/加载态/坏数据态/编辑回写）=本波首项**（D-2②；含 rhinestone-studio agentApi 客户端/mock 同步——**2a 契约扩展 task.detail 三新面（viewState/maskEdits/exportGate）的前端类型对齐在此补**+view.state.set/task.export 前端调用闭环（API client+缓存+刷新/换端回放——2a daemon 端点绿灯≠端到端完成）；波 2a 刻意不动 rhinestone-studio：W10 并行避让）
- [x] 2.2 图层管理：拖拽重排/折叠/删除层（消费 2a 冻结的 layer.reorder/layer.delete RPC）；多选/批量显隐=P1（D-2⑤ 降级——proposal 已修正）
- [x] 2.3 快捷键系统：V/H/Z/Delete/F2/Ctrl+Z/Space 映射（**真源=designer/keymap.ts——V 选择/H 平移/Z 缩放**）+? 快捷键面板；undo 四域游标+Ctrl+Z 焦点域路由（design 附录 D-3——mask 域精确逆在 workbench 增补）
- [x] 2.4 鼠标支持：画布缩放平移/点选层/hover 高亮；designer viewport/keymap 基建抽取（§0 复用面——**2c 落地：lib/canvaskit.ts 单源双消费**——锚定缩放/IME 保护/双指决策纯核；滚轮光标锚定缩放+空格/中键平移+fit/100%/层命中 mask 位面测试+右键禁用菜单；点选=mask 位面命中）
- [x] 2.5 画布状态栏（zoom%/ppm 三态（不可推导如实标注）/坐标 px↔mm/选中层尺寸/dirty 未提交笔画/遮罩告警聚合）；笔刷编辑 UI（**2b 已交付**——layer.mask.patch 闭环+编辑状态机告警面）
- [x] 2.5b 服务端异步重算/stale 语义（accepted/recomputing 过渡态运行路径+树版本漂移检测+stale 清除/重放入口——**2b 复核修复轮落地（Codex P0-2）**：mask.patch 同步段 accepted（重算面）+两级微任务作业 recomputing→ready/error 终态条件更新（不覆盖竞态 stale）；recordTreeVersion 非 mask-patch cause→未终态行 stale；kernel retryMaskEditRecompute/discardMaskEdit 显式入口（RPC 面挂 2d 契约扩展）；无重算面保持同步 ready；tests/workbench-pro-2b.test.ts 7 用例）
- [x] 2.6 走查遗留修复：401 自愈（rpc 客户端 401→弃 token 重新匿名登录一次+重连重放——仅自愈一次）/标签叠压（StrategyCanvas 标签避让：水平重叠者纵向堆叠）/父节点守卫（有指派即可编辑——仅未指派层级节点维持引导）/拆层子名提取（childNameForHint：/把(.+?)拆|分/ 优先，回退原 hint——daemon 与 mock 同式）
- [~] 2.6b undo 域增量三件（已提交 mask 精确逆/跨 revert 游标/多域 redo）**移出本 change 发布范围——立后续 change（Owner 排期）**：Codex 终裁 9.0/10 的转化条件（2c 已交付四域游标+路由+结构/视图/参数/笔画域回退=本 change undo 声明面；spec 已同步分期措辞）
- [ ] 2.7 Codex 复核轮（herdr 大地三）+按评分迭代

## 终评收尾轮（2026-09-27——Codex 终评 7.0/10 NO-GO 的关闭轮）

- [x] F.1 P0-1 stale/error 恢复链全链（终评唯一 P0）：contracts MaskEditRetry/Discard 契约（expectedBaseVersion CAS+响应携带完整留痕行/discarded 幂等位）→ daemon RPC `maskEdit.retry`/`maskEdit.discard`（retry 重读行现值返回+plan 缺席 typed 拒；discard 仅面向阻断留痕 stale/error/incomplete）→ AgentApi 双通道（rpc 守门 parse+mock 同构——stale/error 造数可重放/放弃）→ UI 图层行「重算」「放弃」按钮（携带现读 baseVersion；成功后终态刷新+门重估）；daemon 9 用例（workbench-pro-final：内核语义+竞态缝+RPC 面）+studio 9 用例（workbench.final：mock 语义+UI 动作+rpc 传输守门）
- [x] F.2 P1-1 retry 零行 CAS 阻副作用：条件 UPDATE changes≠1 时重读行现值直接返回（不跑 runMaskRecompute）；prepare 拦截注入 SELECT/UPDATE 竞态缝回归（UPDATE 落空时零 strategy-gems 帧发布——不基于过期基线树发布工件）
- [x] F.3 P1-2 性能门修二：[a] `perf:gate` 默认命令带 WORKBENCH_PERF_GATE_STRICT=1（CI 绿=receipt 绿）；[b] first-frame.hot.100000 651ms>600ms 修复——`gemsDoc` 深层 $state 代理对 100k 颗文档的逐元素代理在每次热装载写回 ~100ms（改 `$state.raw` 不可变快照）+装载身份保持（lastLoaded* 锚——树/底图/gems/指派/视图态内容寻址引用未变时旧对象身份保持）+投影缓存键改模型实读面（detail 整对象出键）；热 100k **651→0.2ms**、冷 100k 1112→220ms、内存 265→19MB；[c] decode.layer.4K2 独立复跑三次 **41.2/42.5/42.5ms（中位 42.5<50）稳定绿**——代理堆清除后解码分配不再被 100k 代理树拖慢；**worker 解码仍挂 P1**（单线程下界近界——余量 ~15%，架构余量项非阻塞）
- [x] F.4 走查第 17 项补全：真浏览器阻断态演示（涂抹至 incomplete>4096 行程→导出被拒 blockers 可见→放弃编辑→导出恢复）——截图+断言入 experiments/workbench-perf-20260927/walkthrough/（2d-walk-results 更新 17/17）
- [x] F.5 spec delta 同步：mask 编辑状态机 Requirement 增「stale/error 恢复链」Scenario（retry CAS/零行无副作用/discard 幂等）；挂账如实——**2.6b undo 增量三件（已提交 mask 精确逆/跨 revert 游标/多域 redo）仍开放交 Owner 排期**；worker 解码（架构余量）挂 P1 后续波

## 波 2d：性能门+测试矩阵（design §4/§5）

- [x] 2d.1 scripts/perf-gate.ts（三层门+冷/热+RSS tab 级口径——receipt JSON 规范见 design §4）+mask overlay/图层树滚动/blob 解码场景——**2026-09-27 交付**：`pnpm --filter rhinestone-studio run perf:gate` 直跑；receipt=experiments/workbench-perf-20260927/perf-receipt.json（+change 目录归档副本）——**17/18 门通过**；门超项回炉修复（contracts 快速 base64 解码 4K² 366→57ms/热载入 gems 工件复用 1464→420ms/§3 投影缓存 pan·zoom 100k ~300ms→~0）；**挂账 1 项如实**：decode.layer.4K2=57ms>50ms（单线程 JS 解码下界——worker 解码=P1；WORKBENCH_PERF_GATE_STRICT=1 可按门严格红）；口径声明在 receipt.env.notes（jsdom 计算口径/tab RSS 需真浏览器）
- [x] 2d.2 测试矩阵全量（§5）+全链走查（编辑 mask→重算→撤销→刷新→导出）——**2026-09-27 真浏览器（Chrome 154 headless+CDP 直连）走查 16/17 通过**：rpc 装载「给小丑贴钻（真识图演示）」→工作台→掩码缩略图/叠加/选中高亮→B 笔刷 5 笔提交 accepted→重算→ready 徽标→CAS 漂移面（双 tab rename 推进）+基于新基线重放→拖拽重排+删除确认→滚轮锚定缩放/V/H/Z/空格平移/点选层→Ctrl+Z 笔画撤销→导出（已导出 238 颗）→状态栏坐标 px↔mm/zoom/ppm 三态；截图 13 张+断言明细=experiments/workbench-perf-20260927/walkthrough/；**如实挂账 1 项**：导出阻断态浏览器演示未达（真实 mask 形态下 UI 涂抹未至 4096 行程；stale 面经实证受事件循环原子性保护在生产竞态不可达——阻断面以 daemon/mock 33 项聚焦回归为准）；走查毕 daemon+Chrome 进程零残留（8795/18321/9790 三端口无监听复检）；jsdom 矩阵新增 workbench.2d（LRU/a11y/异步等待/mock 坐标界 8 用例）+perf.gate receipt 产出器

### 2d 验收小结（好/坏如实）

**好**：Codex 合并复评（6.6/10 NO-GO）两个阻塞项+六条建议全部闭合——P0-2 同节点代次竞态（base_version 作业 token+执行前代次复核；红→绿 4 用例）/插值资源上限（契约+daemon+mock 三侧 7 用例）/blob LRU 补全/a11y roving focus/spec 异步契约对齐+前端轮询终态/strict any 清零；性能门 receipt 17/18+三项 §3 性能实装；真浏览器全链 16/17。
**坏（挂账）**：decode.layer.4K2=57ms>50ms（worker 解码 P1）；浏览器阻断态演示未达（UI 无 retry/discard 入口——RPC 面挂 2d 契约扩展未做）；2.6b undo 增量收尾与 2.7 Codex 复核轮仍开放。

## 收尾

- [ ] 3.1 spec delta 复核（workbench-pro 能力面——波 2a 已建首版，随 2b/2c 实现增补场景）+strict
- [ ] 3.2 全门禁+真环境走查+验收报告
