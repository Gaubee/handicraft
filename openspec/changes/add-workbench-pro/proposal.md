# Proposal: add-workbench-pro

## Why

Owner 2026-09-26 定调（真环境走查后）：
1. **任务详情位置**——参考 zhumo（书法）项目：放 Agent 页面**右侧**（桌面三栏 Resizable：会话列表|对话|任务详情，可拖拽分隔+比例记忆），移动端通过 Sheet 抽屉展开——需响应式设计。
2. **排钻工作台离专业（Photoshop 级）差距大**——图层看不到遮罩（「没有遮罩你如何算出有效的路径呢」）、图层管理/快捷键/鼠标支持非常薄弱「非常不专业」——用子代理+Codex remix 工作流打磨到**生产级标准**（不开新 worktree，需实时与 MainAgent 对接讨论）。
3. 主线仍是 agent 相关开发（本 change 为重要支线，与主线并行推进）。

## What Changes

### 波 1：任务详情布局改版（zhumo 模式复刻）

- Agent tab 改桌面三栏 Resizable（shadcn resizable/paneforge；会话列表|对话|任务详情面板；两根分隔条可拖拽+autoSaveId 记忆比例）
- 任务详情面板=zhumo TaskDetailPanel 同式：任务状态/图层摘要/gems 计数/预览缩略图/关键动作（打开完整工作台/继续对话）——**轻量呈现**，完整编辑仍在排钻工作台 tab
- 移动（<md 768px）：对话全宽；任务详情 Sheet 抽屉（顶栏按钮唤起）；snippet 单实例复用（桌面 Pane 与移动 Sheet 共享标记，不双挂）
- 参考：shufa-server/webui/src/pages/ListDetailPage.svelte + components/agent/TaskDetailPanel.svelte（Owner 指名「以 shufa 为准尽量复用」）

### 波 2：排钻工作台专业化（Photoshop 级——remix+Codex 打磨）

- **遮罩可视化**（Owner 核心质疑）：图层树每行 mask 缩略图（alpha 蒙版小图）；画布 mask 叠加模式增强（选中层蒙版高亮+半透明填充）；遮罩数据链路（inline mask→缩略图渲染）——「没有遮罩如何算路径」的答案要看得见
- **图层管理**：拖拽重排/折叠展开/删除层；图层行内 mask 缩略图+可视性眼睛+锁定。~~多选（Shift/Ctrl）/批量显隐~~ **降 P1**（2026-09-26 Owner 确认——design 附录 D-2⑤：P0 单目标操作，多选/批量=P1 批次）
- **快捷键**（真源=designer/keymap.ts——**V 选择/H 平移/Z 缩放**，design §0 复用红线；本行原「V=画布平移」「1-9 显隐百分比」作废——2026-09-26 Codex 复核规范漂移修正）：Delete 删层/F2 重命名/Ctrl+Z 撤销（undo 四域路由，2c）/Space 临时平移/[ ] 调笔刷（遮罩编辑波）；快捷键面板（? 唤起）
- **鼠标支持**：画布缩放（滚轮+Ctrl）/平移（空格拖拽或中键）/框选图层（点击画布元素选中对应层）/右键上下文菜单（拆层/重命名/排除/显隐）；hover 层高亮
- **画布信息层**：缩放百分比/ppm/指针坐标（px↔mm）/当前层尺寸——状态栏
- 修复走查遗留：前端 401 自愈（daemon 重启旧 token 自动重登）/画布层标签叠压/有指派父节点面板守卫/拆层子名提取核心词
- **波 2a 已落地（契约冻结——2026-09-26）**：layer.reorder/layer.delete/layer.mask.patch 三写 RPC+view.state.set+task.detail 扩面（viewState/maskEdits/exportGate）的 zod 契约冻结（contracts workbench-pro 段）+daemon 端点骨架（CAS/幂等/错误码/锁定语义/版本返回测试固化）+DB v7（tree_versions cause 六值+mask_edit_states）+undo 四域状态机（design 附录 D-3）+三层性能门 receipt 规范（design §4）；P0 修复轮（同日，Codex 复核放行条件）：task.export 导出门真实接线+view-state 节点归属门+layer.delete 提交协议原子化

### 工作方式

- 子代理实现+MainAgent 实时对接（不开新 worktree）+**Codex 复核**（herdr 启动，大地三；按波提交复核，评分 0-10+依据；连续两轮不提升则升级日曜三）
- 每波独立走查（vision 判读+Owner 可见截图）

## Impact

- rhinestone-studio：AgentView 三栏化+TaskDetailPanel 新组件+工作台组件专业化改造+快捷键系统+鼠标交互
- 依赖：shadcn resizable/paneforge（shufa 同款——需引入）、sheet（已有）
- daemon：~~波 2 的删除层/批量操作可能需补 RPC（layer.delete 等）——按需~~ **已冻结（波 2a）**：layer.reorder/layer.delete/layer.mask.patch+view.state.set 契约+骨架落地（批量=多目标 P1——多次单目标调用）
- 不动：引擎红线/Agent 对话面/后端原子（波 2 主要前端；新 RPC 最小面）
