# 设计：图层模型 PS 化重构

## §1 数据模型（视图层派生——契约零破坏）

```
画布（渲染序=树序=z 序，父先子后）
├── 背景层 = 原图（baseImage blob；可隐藏）
└── 图层 i = 抠图层（mask ⊕ 原图）
    ├── 图像内容：原图 bbox 区域 × mask（alpha）   ← 渲染真实图像
    └── 钻布局层（虚拟子层：有 assignment 且产出 gems 才有）
        └── 渲染：gems（blockId=该节点）画在此层坐标
```

- **真源不变**：ObjectNode（mask/bbox/children）+ StrategyAssignment/gems 均为既有契约；「钻布局层」是前端视图模型派生（assignment→blockId→node 挂虚拟子行），不进引擎树、不加 RPC。
- **显隐传递**：图层隐藏 → 其钻子层随之隐藏（PS 语义）；父层隐藏 → 子层（树 children）渲染跳过。锁定沿用既有 node-locked 面。
- **z 序**：树前序=绘制序（父层先画=底层，与 PS 图层面板一致）。

## §2 抠图层合成管线（cutout.svelte.ts）

- 合成：offscreen canvas(w×h) → drawImage(原图, bbox.x, bbox.y, w, h → 0,0,w,h) → `globalCompositeOperation='destination-in'` → mask bits→ImageData alpha 通道 putImageData。
- 缓存：Map<(baseImageRef, maskRef, bbox), HTMLCanvasElement>，LRU 上限与 maskBits 同档（96 条）；mask 编辑提交后（mask 重算 ready）缓存键自然失效（maskRef 变化）。
- 加载态：合成中该层画 bbox 虚线占位（低频：仅首次/编辑后）；坏 mask（解码失败）降级为不渲染该层+图层行警示（沿用 2b 降级语义）。
- 缩略图：抠图层 canvas 缩采样（≤48px 高），treeView 行内展示。

## §3 主视图渲染（PS 化——少即是多）

- **常驻元素**：背景层（可隐藏）+ 各图层抠图 + 钻子层渲染。**零条框、零常驻文字**。
- **hover**：该图层抠图提亮（如叠加 8% 白）+ bbox 细描边（1px 虚线）——不显示文字。
- **选中**：bbox 实线描边（2px 主色）+ 名称标签（bbox 顶部，半透明底）+ 右栏联动；多选（若有）= 多描边。
- **编号模式**（previewMode=numbered 保留）：图例在侧栏（不压画布）；画布内仅组色描边（可选开关，缺省关——回归纯视图）。
- **钻渲染**：rendered 模式钻画进所属图层坐标系（随层显隐/移动语义）；层选中时该层钻可交互（hover 单颗预览规格）。
- 画布交互沿用 canvaskit 单源（V/H/Z/空格平移/滚轮锚定缩放——零变化）。

## §4 容器查询工作台（单一组件多形态）

- TaskWorkbenchView 根容器 `container-type: size`；Tailwind v4 `@container` 断点：
  - `< 32rem`（agent 详情右栏/sheet）：紧凑形态=迷你画布（顶部）+图层列表（滚动）+当前选中层摘要+关键操作（策略/重算）；省略历史 dock（入 ⋯ 菜单）。
  - `≥ 32rem`：完整三栏（现布局）。
- TaskDetailPanel 改造：删除只读摘要面板实现，直接挂载工作台紧凑形态（同组件、同 store——「详情=工作台」）；「打开完整工作台」按钮保留=全屏放大（同一 store 会话，无状态迁移）。
- 移动 sheet：同紧凑形态（容器查询自然适配，无需独立布局代码）。

## §5 纹理优先缺省

- 决策树（Inspector 引导文案+推荐排序）：通用 → texture-fill（散布/流向/混合按画面特征）；画面硬朗且填充区接近纯色 → 规整族（straight-line/geometry——低成本解）。
- demo 映射（journey-demo-clown.ts）：高帽/绒球/鼻/左手/右手 geometry→texture-fill；条纹上衣保留 straight-line（真·硬朗纯色条纹）；卷发 soft-curve 保留（曲线语义本身即纹理走向）。
- 引擎不动（五策略既有）；策略设计 prompt（design.ts 候选引导）补一句纹理优先表述。

## §6 验收门

- 全绿门（三包测试+typecheck+svelte-check+build）。
- 真浏览器走查：抠图层渲染正确性（隐藏背景仅见图层抠图；隐藏图层其钻消失；树序=z 序）+hover/选中交互+容器三形态（全屏/右栏/sheet）+纹理缺省（新任务策略推荐首项=texture-fill）。
- vision 走查：主视图「零条框零常驻文字」判定+PS 感评估。
- 性能：12 层抠图合成 <100ms（冷）/合成缓存命中后主画布重绘 P95 <16ms（既有交互门内）。

## §7 风险

- 抠图合成内存：多层 4K bbox 位图——LRU+按需合成（不可见层不合成）。
- SVG→canvas 混合渲染迁移：钻渲染从 SVG circles 迁到 canvas 绘制（层坐标）——命中/选中/hover 单颗交互需重做（空间索引）。
- 详情面板改造波及 AgentView 布局——移动端 sheet 回归必须覆盖。
