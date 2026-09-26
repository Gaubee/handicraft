# Tasks: add-task-detail-layer-workbench

## 1. 契约与后端原子

- [x] 1.1 contracts：TaskDetail 响应契约（task+原图 ref+tree+指派+gems+预览）+SegmentOne 入出参（nodeId+提示→子节点[]）
- [x] 1.2 内核原子抽取：segmentOne（单节点单提示细分——runSegmentLoop 之上细粒度化，Agent 工具面与人类 RPC 共用）
- [x] 1.3 RPC：task.detail 组装端点+layer.split 人类直调面（登录态+owner 审计挂接）
- [x] 1.4 tree 操作基建：重命名/撤销重做（版本化历史）

## 2. 前端：排钻工作台重构（任务详情）

- [ ] 2.1 任务详情动线：Agent 会话/任务卡「打开任务详情」入口+路由/视图切换
- [ ] 2.2 图层管理面：图层树（显隐/重命名/选中）+mask 蒙版可视化（框线+半透明叠加）
- [ ] 2.3 人类抠图操作：选中层→提示输入→调 layer.split→子层入树（loading/失败态；mock 桥开发）
- [ ] 2.4 贴钻策略面：每层策略卡（ParamsForm 迁移复用）+调整指令注入对话（铁律）+执行触发
- [ ] 2.5 排钻结果画布：StrategyCanvas 迁移复用（原图+框线+点阵三層+逐层显隐）
- [ ] 2.6 旧 Block/Layer/Palette 面板处置（归档实验入口或移除——design 冻结后执行）

## 3. 验收与收尾

- [ ] 3.1 spec delta（任务详情/图层管理能力面）+strict
- [ ] 3.2 测试：契约/原子/RPC 单测+工作台 jsdom 交互测试+（macmini 可用时）真桥拆层走查
- [ ] 3.3 真环境走查：装载任务详情→人类拆层→策略调整→点阵刷新（vision 判读）
- [ ] 3.4 门禁+tasks 勾选+验收报告
