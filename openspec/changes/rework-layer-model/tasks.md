# Tasks：图层模型 PS 化重构（v4）

## 波 1：渲染语义层

- [x] 1.1 cutout.svelte.ts 抠图层合成管线（destination-in+内容寻址 LRU+坏 mask 降级+缩略图派生）+单元测试（缓存命中/失效/降级）——`workbench.cutout.test.ts` 12 用例
- [x] 1.2 主视图图层化渲染：背景层（可隐藏）+图层抠图叠加（树序=z 序）+钻子层（随层显隐传递）+选中/hover 交互态（描边+标签仅交互时）——移除常驻 bbox 条框/标签/组徽标（WorkbenchLayerStage/Item；走查 01-08 截图）
- [x] 1.3 钻渲染迁 canvas（层坐标系+空间索引命中/hover 单颗）+previewMode 三模式在层模型下的语义重定（numbered 图例移侧栏）
- [x] 1.4 treeView 对齐：图层行缩略图=抠图缩略渲染（LayerCutoutThumb——替换蒙版色块）；钻布局虚拟子行（规格+颗数——assignments 派生）

## 波 2：容器查询工作台+详情合一

- [x] 2.1 TaskWorkbenchView 容器查询（container-type+@container 断点 @lg=32rem）：紧凑形态（迷你画布+图层列表+选中层摘要+关键操作）/完整形态；历史 dock 入 ⋯ 菜单
- [x] 2.2 TaskDetailPanel 改造=挂载工作台紧凑形态（删只读摘要实现；同 store；「打开完整工作台」=纯放大）+AgentView 桌面右栏/移动 sheet 双形态回归

## 波 3：纹理优先缺省

- [x] 3.1 demo 映射回归（高帽/绒球/鼻/双手→texture-fill；上衣保留 straight-line；卷发保留 soft-curve）+Inspector 策略推荐决策树与引导文案+策略设计 prompt 纹理优先表述（前半已入 29f2a37；本轮=Inspector 决策树+daemon prompt 快照同步）

## 波 4：验收

- [x] 4.1 全绿门（contracts/daemon/studio 测试+typecheck+svelte-check+build）——contracts 170/170、daemon 858/858（strategy-design 快照随 prompt 决策树句同步）、studio workbench+agent 172/172+svelte-check 0/0+build 通过+perf-gate 17/18（decode.layer.4K2 为既有挂账，基线同）
- [x] 4.2 真浏览器走查：抠图层正确性/显隐传递/z 序/交互态/三形态/纹理缺省——截图+断言（`.agents/images/2026-09-27-layer-model-v4/` 13 张+CDP 断言两步零失败；走查脚本 /tmp/walk-v4）
- [ ] 4.3 vision 走查（零条框判定+PS 感）+Codex 复核+spec delta 同步+验收报告（MainAgent 阶段）

