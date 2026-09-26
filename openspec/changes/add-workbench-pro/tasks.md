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
- 注：designer viewport/keymap 基建抽取挪 2c（W10 前端子代理正在 rhinestone-studio 并行——冲突避让；§0 红线即 2a 的复用面标记）

## 波 2：工作台专业化（Photoshop 级）

- [ ] 2.1 遮罩可视化：图层行 mask 缩略图+画布蒙版叠加增强（Owner 核心质疑的答案）——**blob mask 全链（拉取/缓存/加载态/坏数据态/编辑回写）=本波首项**（D-2②；含 rhinestone-studio agentApi 客户端/mock 同步——**2a 契约扩展 task.detail 三新面的前端类型对齐在此补**（波 2a 刻意不动 rhinestone-studio：W10 并行避让））
- [ ] 2.2 图层管理：拖拽重排/折叠/删除层（消费 2a 冻结的 layer.reorder/layer.delete RPC）；多选/批量显隐=P1（D-2⑤ 降级——proposal 已修正）
- [ ] 2.3 快捷键系统：V/Z/Delete/F2/Ctrl+Z/Space/1-9 映射+? 快捷键面板；undo 四域游标+Ctrl+Z 焦点域路由（design 附录 D-3——mask 域精确逆在 workbench 增补）
- [ ] 2.4 鼠标支持：画布缩放平移/点选层/右键菜单/hover 高亮；designer viewport/keymap 基建抽取（§0 复用面——自 2a 挪入）
- [ ] 2.5 画布状态栏（缩放%/ppm/坐标 px↔mm/层尺寸）；笔刷编辑 UI（消费 layer.mask.patch+编辑状态机告警面）
- [ ] 2.6 走查遗留修复：401 自愈/标签叠压/父节点守卫/拆层子名提取
- [ ] 2.7 Codex 复核轮（herdr 大地三）+按评分迭代

## 波 2d：性能门+测试矩阵（design §4/§5）

- [ ] 2d.1 scripts/perf-gate.ts（三层门+冷/热+RSS tab 级口径——receipt JSON 规范见 design §4）+mask overlay/图层树滚动/blob 解码场景
- [ ] 2d.2 测试矩阵全量（§5）+全链走查（编辑 mask→重算→撤销→刷新→导出）

## 收尾

- [ ] 3.1 spec delta 复核（workbench-pro 能力面——波 2a 已建首版，随 2b/2c 实现增补场景）+strict
- [ ] 3.2 全门禁+真环境走查+验收报告
