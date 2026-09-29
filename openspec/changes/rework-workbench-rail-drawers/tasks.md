# Tasks：任务详情 PS 式轨道 Drawer 化

## 1. 状态机与容器（子代理）

- [x] 1.1 新 `railState.svelte.ts`：RailPanel/RailMode 状态机（auto 缺省随断点/手动 toggle 记忆/跌破强制收+清记忆/升回恢复/右侧互斥）+纯逻辑单测
- [x] 1.2 新 `WorkbenchRailDrawer.svelte`：非模态开合容器（blur/过渡/侧别/pointer-events 门）+slot 内容
- [x] 1.3 新 `WorkbenchRail.svelte`（side 两实例形态）：左=画布工具组外提+图层 toggle；右=属性/历史/快捷键帮助；按钮 testid/tooltip/active 态

## 2. 布局重构（子代理）

- [x] 2.1 `TaskWorkbenchView` 中段重构：左 rail｜画布（relative+双 Drawer overlay）｜右 rail；图层/属性内联栏拆除；底部历史 dock 挂载退役（WorkbenchHistoryDock 迁入右 Drawer，外壳满高滚动适配，组件内部零改动）
- [x] 2.2 `WorkbenchCanvasStage` 内部工具条 DOM 外提（光标/会话/命令逻辑零改动）；容器查询断点表落地（32rem 紧凑/42rem rail auto）+紧凑态摘要条保留
- [x] 2.3 组件 jsdom 测试：rail 按钮与开合、命令总线不回归、紧凑态语义、Drawer 内容挂载

## 3. 验收（MainAgent）

- [x] 3.1 review+合流提交+全量门（studio 全量+typecheck+svelte-check+build）
- [ ] 3.2 vision 真浏览器走查：42rem+双开/中档自动收+手动开/紧凑全宽 Drawer/blur/rail 恒可点/画布 Drawer 下可交互
- [ ] 3.3 Codex 复核闭环
- [ ] 3.4 spec delta 落盘+tasks 勾选+8317 换装交付
