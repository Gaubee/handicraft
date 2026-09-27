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

## 波 5：v4 修复轮（Codex NO-GO 7.7/10 + MainAgent vision 走查定案——2026-09-28）

- [x] 5.1 F1 紧凑工作台补关键操作（Codex P1-1）：紧凑态策略直改（族选择+密度——applyLayerStrategy 同一写路径）+掩码重算/放弃命令（stale/error/incomplete 就近恢复链）——`workbench.v4.test.ts` [E] F1 两用例（策略更改+重算入口）
- [x] 5.2 F2 双任务视图不串 store（Codex P1-2）：装载门按视图归属（embedded→agent/完整→studio；store 无主宽松装载、有主严格归属+taskId 校验重载）——A/B 任务（clown/willow）来回切换集成测试+同任务双实例选中保留
- [x] 5.3 F3 快捷键可见性门（Codex P1-3）：presence.svelte.ts（checkVisibility/hidden 链双态）——⌘Z/Delete/F2/Alt+方向/?/空格 在隐藏工作台（lab/agent Tab、双实例）不截获不触发
- [x] 5.4 F4 不可见层不合成（Codex P1-4）：可见节点集（hiddenDeepIdsOf 单源——渲染/命中/请求三面同式）接入 requestCutoutsForTree；条目随请求集收缩释放；LRU 增字节预算 512MiB（超限逐出最旧）——`workbench.cutout.test.ts` [F] 两用例
- [x] 5.5 F5 树根=背景层（MainAgent B1）：根行眼睛驱动 baseImage 显隐（与工具栏背景簇同真源双向）+根行缩略=原图+根行不选中/不承接命中（选中限图层节点）+旧 view-state 快照 root.hidden 读回剔除
- [x] 5.6 F6 390px 工具行重叠（vision P2）：@max-lg 预览模式条靠左+右侧预留背景胶囊带+图标化+横滚；背景胶囊/颗数读数收紧——r2 走查 390/320 两控件完整可见可点
- [x] 5.7 F7 演示可辨性+断言加严：a) 种子底色改 #2a2e37 深底；b) 隐藏背景走查断言=截图像素 diff（非层区域必变——r2 走查）；c) 斜纹实证：codec 往返无损+纯色区零偏离+真照片无对角周期（/tmp/stripe-forensics.ts——非 codec 伪影非数据特性，记录即止）
- [x] 5.8 F8 P2 清单：a) GemSpatialIndex 桶边界（半径覆盖所有桶登记——跨 X/Y/角点+重叠 z 序测试）；b) 钻子行继承祖先显隐（降显+data-inherited-hidden 标记——画布/命中/面板三面断言）；c) design.md/TaskWorkbenchView 注释 inline-size 同步；d) cutout/layerRender 来源头+时间戳+as unknown as 改窄适配；e) tasks.md EOF 空行清除
