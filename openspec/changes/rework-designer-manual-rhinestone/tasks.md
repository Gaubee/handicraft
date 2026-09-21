# Tasks: rework-designer-manual-rhinestone

## R1 智能排布退役（design §5）

- [x] R1.1 移除智能排布 UI 面：DocBar 按钮/右键菜单项/`open-smart-layout` 命令/SmartLayoutPanel 组件/`smartLayoutUnderlayReady` UI 消费/UI 测试删除；内核（smartLayoutGemsFromImage + smartLayout.svelte.ts + 内核测试）零 diff 保留；TERMS/速查表同步；grep 收据（UI 面零引用）；redesign change 7.1/7.2 加 superseded 注记行；vitest：受影响族回归（contextMenu/DocBar 族）
## R2 水钻贴图渲染与状态反馈（design §1）

- [ ] R2.1 sprite 烘焙管线：`lib/designer/gemSprites.ts`（纹理解析→Image→三态帧烘焙→LRU cache；missing 回退+错误通道）；裁断 1.2 取样判据执行（≥3 seed 纹理彩色/中性直方图判定，结论回填 design 附录）；vitest：solo tests/designer/gemSprites.test.ts
- [ ] R2.2 Canvas 渲染换肤：`ctx.arc` 全路径替换 drawImage(sprite)（本体/命中预览/框选预览/拖移 ghost/笔刷光标 footprint 预览 Ø2 红线联动）；hover/selected 三态消费；vitest：渲染断言（零 arc 符号路径+三态帧选择）+ 交互族回归
## R3 笔刷流量·面积落子（design §4）

- [ ] R3.1 面积落子引擎：brushEngine 圆盘 footprint 扫面增量结算（六方格位∩圆盘）/流量抽稀/碰撞（既有+批内）/吸附关退化模式；橡皮 footprint 批量擦除；vitest：solo tests/designer/brushFlow.test.ts（面积语义锚：宽带笔刷多列铺满/流量单调/避碰）
- [ ] R3.2 笔刷设定 UI+键位：读数 popover（直径+流量）；[ ] 让渡笔刷直径（§3.3 重映射——旋转键位测试显式更新）；光标即时反映；vitest：keymap 断言更新+popover 组件
## R4 ⌘T 变换+交互对齐（design §3）

- [ ] R4.1 ⌘T 自由变换态：包围盒（单/多选）+角柄缩放（批量改尺寸，§2 红线 invariant 测试）+外柄旋转+Enter/Esc+Shift 约束+顶栏读数+单 patch 单 undo；单选专用柄退役；vitest：solo tests/designer/transformMode.test.ts
- [ ] R4.2 选择与批量补齐：Alt+框选减选；框选命中数读数；⌥[ ⌥] 细旋转；交互对齐表（§3.5）回填测试映射+速查面板全表同步；vitest：gestures 族扩断言
## R5 收尾

- [ ] R5.1 绿门：designer+edit 全族+app.smoke/globalImport+check 0/0+build EXIT=0；护栏收据（engine/persistence/services 零 diff+内核保留件零 diff）；/tmp/vision-walk2 20 张证据归档引用；偏离清单回报
- [ ] R5.2 走查门重开（Owner 指令沿用）：5210 重起 → vision+ego 全量重走（A 段按新 UI 重定义+B/C 段）→ P0/P1 回修迭代至 PASS → 方提 Codex 终审（建议盖 redesign+rework 两 change）
