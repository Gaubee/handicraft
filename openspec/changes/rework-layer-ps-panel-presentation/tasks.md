# Tasks：表现层三件

- [x] 1.1 羽化：mask 距离场软化（3/5px 两档）+主图/缩略共用+半像素对齐修正+视觉回归（fixture 边缘连续无硬阶梯无 halo）
  - cutout.svelte.ts：chamfer 3-4 两遍距离场→单调 alpha（外 0/内 255/带线性）；`?feather=5` URL 引导+`setCutoutFeatherWidthPxForTests` 注入面；compose 调用序列/bits 零改写（几何不变式锁定）；thumb 从软化主位图缩采样（同身份断言）
  - workbench.presentation.test.ts [U1] 6 用例：3px/5px 档剖面（85/170/255 与 51..255）、斜边单调、像素中心采样 fixture、几何不变、共用软化
  - 真浏览器：3px 档 partialAlpha={85:960} / 5px 档 {51:960}（两档生效）
- [x] 1.2 缩略双模式：trim/ps segmented 替换蒙版开关+组/叶/根三态空间语义+观察态持久（view-state 域）
  - store：thumbMode（view-state 观察态——不进 undo 域；服务端写透待 contracts ViewState 增字段后续波，本波满足 Codex E1 最低验收「面板重渲染/任务重载一致」）
  - LayerCutoutThumb：ps=整画布 containPlacement 放回（组=直接子层全局合成；叶=主位图全局锚定）；trim=现状；根行两模式恒原图
  - WorkbenchLayerPanel：segmented（radiogroup）替换「蒙版」checkbox（退役 dev-only——setShowMasks 注入面保留）
- [x] 1.3 grid overlay：单容器编排预览模式+背景簇、宽中窄三宽不重叠、事件命中不串写
  - WorkbenchCanvasStage：observation-root（pointer-events-none+container-type）→ 单 grid（`@min-[420px]:grid-cols-[auto_auto]`——w-fit 容器下 minmax(0,1fr) 列坍缩 0 宽，走查实证后定 auto 列+min-w-0）；两组件 absolute 坐标删除
  - 真浏览器三档：wide 1440 并排同行（478.8→654.8 / 658.8→897.1 无交叠）；mid/narrow（画布容器 124/176px<420）单列上下（垂直间隙 4px）；overflowX 三档全 false；预览/眼睛/滑杆事件互不串写+opacity 0.3 生效
- [x] 1.4 全绿门+真浏览器走查（Codex E3 验收标准）+vision 判读+Codex 复核
  - 聚焦绿：presentation 11/cutout 18/panels 36/pro/view 全绿；svelte-check 本波 8 文件 0 error 0 warning（repo 39 error 全部归属并行子代理 agent/ 在途文件——QueuePanel.svelte 删除中间态，同因阻断全量 suite 与 vite build，非本波范围）
  - 走查产物：.agents/images/2026-09-28-presentation/01-08 截图+像素统计（视觉判读以程序化像素校验承载——边缘渐变带宽度/alpha 直方图/rect 不重叠）
  - 提交归属：U1=2c82c91 / U2=07d0de0 / U3=07fed29 / docs=5b8892a（U1 曾被并行
    会话提交卷带又随其历史重写丢失——按原分组重新落库，内容与验收不变）
