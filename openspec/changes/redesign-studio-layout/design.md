<!--
Orthogonal intents (max 5):
1. [2026-09-19 Source] PM 设计稿 §3 方案 A + Codex-R1（5.8/10 NO-GO）修订：方案 A 采纳（议题 4），
   实现约束修改 = renderer 纯函数边界先行 + 真浏览器测试兜底 + 依赖重定位（B-8/B-9/并行判定）。
2. [2026-09-19 Loop] 核心循环（调参→看画布→再调）两端距离=0 是全部布局裁决的第一判据；画布常驻、答案常驻、对比一步可达。
3. [2026-09-19 Renderer] previewRender 纯函数签名先冻（输入/输出/DPR/基准），Image 与 objectURL 生命周期留在组件——
   「组件本体复用」不能替代此边界 [Codex-R1-B9]。
4. [2026-09-19 Dependency] 并行只成立一半 [Codex-R1-C]：五区骨架与 renderer 抽取可先行；
   空态 CTA/上下文条更换/origin 'library'/reference 接入依赖 add-asset-library 适配层就绪，不复制临时 picker。
5. [2026-09-19 Mobile] 移动端硬承诺由真实浏览器测试兜底（312/375/桌面最小宽），vitest 仅保留状态单测 [Codex-R1-B8]。
-->

## Purpose

固化工作台布局重设计的结构契约。完整线框/状态矩阵/迁移成本见 PM §3.4-§3.7，本文冻结实现级不变量与组件拓扑。

## 1. 结构拓扑（方案 A，冻结）

```
桌面 lg+（五区固定视口，无主区滚动）
┌──────────────────────────────────────────────────────────────┬─────────────┐
│ 上下文条 h-10：[▪缩略] 名称·尺寸 [更换▾] │纯钻|叠稿|叠原 ◐% │适应 +− N%  │             │
├──────────────────────────────────────────────────────────────┤  检查器      │
│                                                              │  320px      │
│              画布（常驻舞台：flex 填充剩余高宽）                 │  选中块详情   │
│              缩放/平移/点选块；预览模式即时生效                   │  （置顶常驻） │
│                                                              │  ─────────  │
│                                                              │  折叠组：物理 │
│                                                              │  /色板/分块/  │
│                                                              │  块列表      │
├──────────────────────────────────────────────────────────────┴─────────────┤
│ 胶片带 h-14：[六方抽稀✓2,341][六方变距 2,208][泊松盘][语义混合][CVT] [⤢对比]  │
├────────────────────────────────────────────────────────────────────────────┤
│ 状态条 h-12：共 N 钻 · 策略回显 · ✓间距合规 · BOM…▾ │[SVG][BOM][PNG][✎送精修]  │
└────────────────────────────────────────────────────────────────────────────┘
```

不变量：
- **画布常驻**：任何参数调整全程画布可见（结构性目标：调整→反馈全程可见率 100%）；画布区滚动行为只在画布自身取景（现有缩放平移）。
- **答案常驻**：共 N 钻/策略/校验状态任何时刻可见（不再随滚动消失）。
- **对比是模式不是家具**：常驻面只保留 chips（轻量）；大图对比经「⤢对比」进入覆盖层（Esc/点外部退出，focus trap）。
- **策略单真源不变**：胶片带 chip 点击=唯一写入点；状态条只读回显（上版纪律平移）。

## 2. 组件拓扑（拆分映射）

```
StudioView.svelte（骨架重写：五区 flex 视口布局，min-h-0/min-w-0 链照 App.svelte 全出血壳纪律）
├─ StudioContextBar.svelte   新建：来源信息/更换入口（选图器，add-asset-library 接口）+ 预览三模式+透明度 + 取景控制
├─ BlockCanvas.svelte        保留：渲染/取景/交互不动；空态双 CTA 改造属 add-asset-library
├─ Inspector.svelte          新建（自 BlockPanel 拆装）：选中块详情置顶 + 物理参数/色板/分块/块列表折叠组
├─ StrategyFilmStrip.svelte  新建（自 CompareGrid 拆）：五策略 chips + 钻数 + 合规点 + hover 预览浮卡 + [⤢对比]
├─ CompareOverlay.svelte     新建（自 CompareGrid 拆）：全屏覆盖层——五栏大图（约 20vw/栏）+ A/B 滑动对比器；点卡=设为导出策略并退出
└─ StudioStatusBar.svelte    新建（自 ExportBar 演化）：答案位大数字 + 策略回显 + 校验徽标 + BOM 前3色…▾ + 导出组 + 送精修
                              违规时：红徽标 + [边界松弛][斥力修复]浮出 + 清单▾；导出禁用语义不变
```

- BlockDetail/BlockList/PhysicsPanel/PalettePanel/SegmentPanel 组件本体复用，仅换容器。
- **previewRender 纯函数边界先行 [Codex-R1-B9，签名冻结]**：

```ts
// lib/studio/previewRender.ts——纯绘制函数，无组件状态/Image 加载/objectURL 生命周期
interface PreviewRenderInput {
  painting?: EngineImage          // 叠稿底图（可选）
  referenceBitmap?: ImageBitmap | HTMLImageElement  // 叠原图（由组件解析后传入）
  result: StrategyResult          // gems/warnings
  palette: Palette; blocks: Block[]; grid: GridSpec
  mode: PreviewMode; overlayOpacity: number
  size: { width: number; height: number }; dpr: number
}
function drawPreview(ctx: CanvasRenderingContext2D, input: PreviewRenderInput): void
```
  Image/objectURL/ResizeObserver/重绘调度留在组件（FilmStrip 浮卡 / CompareOverlay 各自持有）；**基准测试**：同一 fixture 下旧 CompareGrid 卡 / 新胶片带浮卡 / 新 overlay 大图三者像素与尺寸一致性对照（旧卡为 golden 基准）。
- ExportBar 的导出逻辑（build/download/校验门/送精修构造）全复用，仅重排。**C-4 非改名 [Codex-R1-C]**：送精修入口迁移与 `buildManualEditHandoff` 的 referenceAssetId 生命周期、导出 PNG 入库（add-asset-library A-6）同链——本 change 先做不接资产的 StatusBar，资产接入在 add-asset-library §5/§6 就绪后回接，两 change 在收尾任务互查。

### 2.1 依赖边界（并行只成立一半）[Codex-R1-C]

- **可先行（无资产依赖）**：五区骨架重排、StudioContextBar（预览控制+取景，不含「更换」资产入口——先占位禁用）、Inspector、FilmStrip、CompareOverlay、StatusBar（导出逻辑复用）、renderer 抽取与基准。
- **等 add-asset-library 适配层（getAssetBlob / AssetPickerController / handoff v2 / referenceAssetId）**：空态双 CTA、上下文条「更换」、origin 'library'、reference preview、送精修 reference 链。**不复制临时 picker**。

## 3. 状态矩阵（PM §3.5 冻结引用）

空态/载入解码/分块中/重算中（worker 进度徽标平移至状态条+画布角落）/选中块/违规/对比模式/移动端选中块——八态触发·呈现·出口按 PM §3.5 执行，逐态配测试。

## 4. 移动端形态（同构映射）

现结构保留（画布优先+参数抽屉+选中块半屏抽屉）；画布 60vh 定值 → flex 填充（Tab Bar 与胶片带之间）；胶片带=横滑 chips（停驻≠选中，点按才切换）；状态条导出收进菜单（SVG/BOM/PNG/送精修）；对比模式=全屏 Sheet（策略大图横滑 scroll-snap + 底部[设为导出策略]，沿用现 carousel 交互）。

## 5. 议题裁决记录

4. **布局方案 A vs B**——Codex-R1 裁决：**采纳 A**（PM 立场）。拆分风险不否决方向但必须前置：renderer 纯函数签名+基准先行（§2）；A/B 滑动对比器 P0 最小形态 = 两栏并排+点击切换（写入验收标准），滑动器为 P0.5 增强；五栏覆盖层/focus trap/拖拽分屏不得以「zoom Dialog 已验证单画布」类推。

## 6. 验证与护栏 [Codex-R1-B8]

- **真浏览器测试兜底（硬承诺载体，vitest 仅保留状态单测）**：312px / 375px / 桌面最小宽三档 viewport——断言主区 computed overflow（无纵向滚动）、五区可见性、胶片带 pointer 滚动/停驻不改变 activeStrategy、对比 overlay Esc 退出 + focus trap、导出门禁用态、worker 进度徽标可见。
- 既有交互测试迁移：mount/interactions 选择器更新；新增胶片带/对比模式/状态条/八态用例。
- 回归硬承诺：移动端现行为、策略单真源、spacing 导出门、worker 进度可见性、1 万钻 60fps。
- 走查：PM §5 之 ④ + 「调整→画布全程可见」结构性断言；记分卡复测（Journey 5→9；发布会截图测试=能）。
- **验收标准含 A/B 最小形态**：两栏并排+点击切换可用即 P0 验收通过；拖拽分屏为增强项。
