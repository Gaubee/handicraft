# 设计：任务详情 PS 式轨道 Drawer 化

原始需求输入：Owner 2026-09-29 指令（左右 Drawer+backdrop-blur+窄屏自动收起手动展开+PS 式竖工具条+左条加图层开关+右条同理新增）。

## 0. 现状基线

- `TaskWorkbenchView.svelte`（532 行）：容器根 `@container`，中段 flex——完整形态（@lg=32rem）= 左图层内联栏 `w-64`｜中画布｜右属性内联栏；紧凑形态 = 纵排（迷你画布→图层 `max-h-[38%]`→选中层摘要）。底部 `WorkbenchHistoryDock`。
- 左侧竖工具条在 `WorkbenchCanvasStage.svelte` 内（选择/平移/缩放/笔刷——点击走 commands.ts 命令总线单源，B 键同源）。
- 容器查询只依赖宽度（inline-size）——v4 裁定保持。

## 1. 目标结构（中段重构）

```text
中段（flex-row，两形态共用骨架）：
┌────────────────────────────────────────────┐
│ [左 rail w-11] [画布区 flex-1 relative] [右 rail w-11] │
│                 │ ├ 左 Drawer（absolute left-0 inset-y-0 w-72）│
│                 │ └ 右 Drawer（absolute right-0 inset-y-0 w-80）│
└────────────────────────────────────────────┘
紧凑形态（@max-lg）：画布区下方保留 选中层摘要+策略直改条（现状语义），
历史/图层/属性全部经 Drawer。
```

- **rail 常驻不收起**（PS 同款）：工具条是轨道不是面板。
- **Drawer 非模态**：覆盖画布但不遮断交互（无全屏遮罩）；`bg-background/85 backdrop-blur-md border-r/l`；过渡 `transition-transform duration-200`（收起 translate-x-[-100%]/[100%] + `pointer-events-none`+`invisible`）。
- **z 序**：画布 overlay 观察控件（grid 控件 v6）< Drawer < rail 工具条（rail 恒可点）。

## 2. Rail 状态机（`railState.svelte.ts` 新模块，纯逻辑可单测）

```ts
type RailPanel = 'layers' | 'inspector' | 'history'   // 左=layers；右=inspector/history 互斥（同侧同时至多一个展开）
type RailMode = 'auto' | 'open' | 'closed'
// 每 panel 独立 state；同侧开一个则另一面板收起（右侧互斥）
```

- **断点输入**：容器宽度档（`wide = @2xl(42rem)` 达标与否）——由 View 层 ResizeObserver（或 container query state hack）喂给状态机；jsdom 无布局，逻辑层以布尔输入测。
- 语义（冻结）：
  - 缺省 `auto`：wide=true→open；wide=false→closed。
  - 用户点击 rail 按钮：toggle（open↔closed，进 manual 记忆）。
  - **宽度跌破断点**：全部强制 closed + 清 manual 记忆（回 auto）。
  - **升回断点**：恢复 auto（open）。
  - manual 记忆仅在 wide 档内有效（防「用户手动开后被挤压」与「窄屏手动开后残留」）。
- 快捷键：`[`/`]` 现有面板循环键位语义保持（commands.ts 路由到同一状态机——若现有键位是其他用途则新增 `\` 图层开关？——**裁定：`[`/`]` 若现为空缺位则分别=左/右面板循环，已占用则不动仅按钮交互**，实现轮以 commands.ts 现状为准）。

## 3. 组件面

- **`WorkbenchRail.svelte`（新）**：`side: 'left'|'right'` 两实例。左=画布工具组（选择/平移/缩放/笔刷——从 WorkbenchCanvasStage 外提；点击仍走命令总线）+分隔+「图层」toggle（开=active 态高亮）。右=「属性」「历史」「快捷键帮助」竖排。按钮 36×36 icon、tooltip（title）、active 语义（当前工具/面板开合）。
- **`WorkbenchRailDrawer.svelte`（新）**：开合容器（side/panel/open props，过渡+blur+非模态），内容 slot。
- **迁移**：WorkbenchLayerPanel/WorkbenchInspector/WorkbenchHistoryDock 组件**内部零改动**进 Drawer；HistoryDock 底部横条形态在 Drawer 竖容器内给 `h-full overflow-auto` 适配（外壳包一层即可，不改其内部逻辑）；TaskWorkbenchView 底部 dock 挂载点退役。
- **WorkbenchCanvasStage**：内部工具条 DOM 移除（逻辑/光标/会话不动——工具状态本就在 store）；Stage 保持画布+overlay grid 控件。

## 4. 响应式断点（容器 inline-size，Tailwind v4 @container）

| 断点 | 行为 |
|---|---|
| `< 32rem`（@max-lg）紧凑 | 画布+摘要条+双 rail；Drawer 全宽（`w-full max-w-80`）；全部收起缺省 |
| `32–42rem`（@lg..@max-2xl） | 完整画布；Drawer 覆盖式；**自动收起缺省**（可手动开） |
| `≥ 42rem`（@2xl） | 双 Drawer 缺省展开（画布不被内联栏挤压——Drawer 覆盖语义下「展开」=滑出可见） |

注：Drawer 覆盖式后「展开」不再挤画布（PS 浮面板语义）；断点仅控制缺省可见性与自动收起。

## 5. 测试面

- **railState 纯逻辑**（vitest）：auto 缺省两档/手动 toggle 记忆/跌破强制收+清记忆/升回恢复/右侧互斥/同侧唯一。
- **组件 jsdom**：rail 按钮存在与 testid（`rail-layers-toggle`/`rail-inspector-toggle`/`rail-history-toggle`）；点击开合 Drawer 内容挂载/卸载（or visibility 类）；画布工具按钮迁到 rail 后命令总线调用不回归（既有命令测试保持绿）；紧凑态摘要条在场。
- **真浏览器走查**（vision）：42rem+双开/32-42 自动收+手动开/32- 紧凑+全宽 Drawer；blur 视觉；rail 恒可点；画布在 Drawer 下仍可平移缩放。

## 6. Non-goals

- WorkbenchLayerPanel/Inspector/HistoryDock 内部功能零改动；store/commands 语义零改动（工具命令总线仅按钮位置迁移）。
- 不做 Drawer 拖拽调宽/停靠吸附（后续波）。
- 不动 Agent 会话面/设置页/其它视图。
