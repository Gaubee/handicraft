# Tasks：材料故事闭环重构

## W1 骨架（波 1 子代理）

- [ ] 1.1 改名：AdminPage 资源区「装饰钻库」→「材料市场」、「素材库」→「我的材料」（导航 label+面板标题+注释+测试断言同步； StonesAdminView 内部自称文案同步）
- [ ] 1.2 材料市场去 tab：StonesLibraryPanel 退役，AdminPage 直挂 StonesAdminView；相关测试更新
- [ ] 1.3 我的材料三分区壳：新 MyMaterialsPanel（我的组合/我的文件/我的任务三 pill 子导航；文件区挂 AssetsLibAdmin；组合/任务区占位空态）
- [ ] 1.4 预览 80% contains：AssetsLibAdmin 素材卡+StonesAdminView 钻样卡图片放大至容器 80% 宽/高 contain；素材缩略加 raw?w=600
- [ ] 1.5 废弃 IndexedDB 迁移：删「从本浏览器导入」入口+migrateToServer 依赖（引用 grep 定夺文件去留）+空态文案修正
- [ ] 1.6 绿门：svelte-check 0 errors；聚焦测试（adminPage/assetsLib/stonesAdmin）绿；studio 全量（flake 隔离复跑定性）

## W2a 材料市场组合（波 2 并行子代理 A）

- [ ] 2.1 StonesAdminView 左栏「组合」分区（可折叠段+组合行：名称/成员数+「添加组合」按钮）
- [ ] 2.2 CreateSetDialog（名称+钻搜索多选+数量默认 0+sets.create；owner 挂载方传参）+单测
- [ ] 2.3 组合选中态：右侧网格切换组合成员钻卡（sets.get），与供应商树选中互斥；点供应商回钻型网格
- [ ] 2.4 绿门同 1.6

## W2b 我的内容（波 2 并行子代理 B）

- [ ] 3.1 我的组合区：组合卡片列表（成员数/更新时间）+创建（复用 CreateSetDialog，owner=本人）+删除确认
- [ ] 3.2 我的任务区：任务行列表（会话/状态徽标/时间/进会话链接）；数据 sessions.list 优先，daemon 零改
- [ ] 3.3 绿门同 1.6

## W3 收尾（MainAgent）

- [ ] 4.1 review 整合+显式路径提交+push+8317 换装
- [ ] 4.2 vision 走查故事闭环四环（市场→组套→开工→归档）
- [ ] 4.3 归档 change 前置：Owner 验收
