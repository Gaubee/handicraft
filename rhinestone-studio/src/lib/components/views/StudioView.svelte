<!--
Orthogonal intents (max 4):
1. [2026-09-19 Layout 1.1] 五区固定视口（方案 A，Codex-R1 议题 4）：上下文条 h-10 / [画布 flex 填充 | 检查器 320px] /
     胶片带 h-14 / 状态条 h-12。min-h-0/min-w-0 链逐区落实（App.svelte 全出血壳纪律）：flex 子项默认
     min-height:auto 会撑爆固定视口——中段/舞台/检查器每个 flex 子容器显式 min-h-0，主区零纵向滚动
     （overflow-hidden，滚动只发生在画布自身取景与检查器列表内）。
2. [2026-09-19 Mobile 4.1] 移动端同构（现行为硬承诺）：来源行+参数抽屉入口行（上下文条内）→ 画布 flex-1
     （废除 60vh 定值）→ 胶片带横滑 → 状态条；底部 Tab Bar 由 App 层承载。参数抽屉 + 选中块半屏抽屉照旧。
3. [2026-09-19 Handoff] handoff 置位（含参考原图）即取图载入；App 层 $effect 已负责切视图。
4. [2026-09-19 取景转发] BlockCanvas 取景控制迁上下文条：经 bind:this 暴露 fitView/zoomBy/getZoomPercent
     （BlockCanvas 零渲染改动），StudioView 只做回调转发与读数上抛。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import BlockCanvas from '../../../components/Studio/BlockCanvas.svelte'
  import StudioContextBar from '../../../components/Studio/StudioContextBar.svelte'
  import Inspector from '../../../components/Studio/Inspector.svelte'
  import StrategyFilmStrip from '../../../components/Studio/StrategyFilmStrip.svelte'
  import StudioStatusBar from '../../../components/Studio/StudioStatusBar.svelte'
  import BlockDetail from '../../../components/Studio/BlockDetail.svelte'
  import BlockList from '../../../components/Studio/BlockList.svelte'
  import PhysicsPanel from '../../../components/Studio/PhysicsPanel.svelte'
  import PalettePanel from '../../../components/Studio/PalettePanel.svelte'
  import SegmentPanel from '../../../components/Studio/SegmentPanel.svelte'
  import { getHandoff } from '$lib/stores/handoff.svelte'
  import { getSelectedBlockId, loadFromHandoff, selectBlock } from '$lib/stores/studio.svelte'

  // 送转化交接：handoff 置位（含视图切换后首次挂载）即取图载入（参考原图自动填充见 store）
  $effect(() => {
    if (getHandoff()) void loadFromHandoff()
  })

  // ---- 取景转发（上下文条 ↔ 画布实例）：结构性接口，不耦合组件实例类型 ----
  interface CanvasFramingApi {
    fitView: () => void
    zoomBy: (factor: number) => void
    getZoomPercent: () => number
  }
  let canvasApi = $state<CanvasFramingApi | null>(null)

  // ---- 移动端抽屉（lg 以下；参数入口在上下文条，抽屉本体在此） ----
  type DrawerKind = 'blocks' | 'physics' | 'palette'
  let drawer = $state<DrawerKind | null>(null)

  // ---- 选中块半屏抽屉（移动端）：选中即露出详情，画布保持可见 ----
  let blockSheetOpen = $state(false)

  function prefersMobileViewport(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1023px)').matches
      : false
  }

  let isMobileViewport = $state(prefersMobileViewport())
  $effect(() => {
    const onResize = (): void => {
      isMobileViewport = prefersMobileViewport()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  // 画布/列表选中块（移动端）→ 自动上滑半屏详情抽屉；关闭抽屉不取消选中（画布高亮仍在）
  $effect(() => {
    if (getSelectedBlockId() && isMobileViewport) blockSheetOpen = true
  })

  const DRAWER_TITLES: Record<DrawerKind, string> = { blocks: '块', physics: '物理参数', palette: '色板' }
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
  data-testid="studio-root"
>
  <!-- ① 上下文条：来源/更换（占位禁用）+ 预览控制 + 取景控制；移动端=来源行+抽屉入口行 -->
  <StudioContextBar
    onOpenDrawer={(kind) => (drawer = kind)}
    onFit={() => canvasApi?.fitView()}
    onZoomIn={() => canvasApi?.zoomBy(1.25)}
    onZoomOut={() => canvasApi?.zoomBy(0.8)}
    zoomPercent={canvasApi?.getZoomPercent() ?? null}
  />

  <!-- ② 中段：画布常驻舞台（flex 填充剩余高宽）+ 桌面检查器 320px 右列 -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row" data-testid="studio-mid">
    <!-- 画布舞台：min-h-0/min-w-0 链关键一环（flex 子项 min-height:auto 会撑爆固定视口）；
         移动端 flex-1 填充（60vh 定值废除），桌面同为 flex-1 -->
    <div
      class="flex min-h-0 min-w-0 flex-1 flex-col p-3 lg:p-4"
      data-testid="studio-stage"
    >
      <BlockCanvas bind:this={canvasApi} />
    </div>

    <!-- 检查器右列：桌面 320px（Inspector 内部滚动）；移动端由参数抽屉承载，此列隐藏 -->
    <aside
      class="hidden w-80 shrink-0 lg:min-h-0 lg:flex lg:flex-col lg:border-l"
      data-testid="studio-inspector-slot"
    >
      <Inspector />
    </aside>
  </div>

  <!-- ③ 胶片带：五策略 chips（唯一写入点）+ [⤢对比] 占位 -->
  <StrategyFilmStrip />

  <!-- ④ 状态条：答案位 + 策略回显 + 校验/BOM/导出/送精修 + worker 进度 -->
  <StudioStatusBar />
</div>

<!-- 移动端参数抽屉（bottom sheet）：复用桌面检查器同款面板组件（现行为硬承诺） -->
<Sheet.Root
  open={drawer !== null}
  onOpenChange={(open) => {
    if (!open) drawer = null
  }}
>
  <Sheet.Content side="bottom" class="max-h-[75vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-testid="param-drawer">
    <Sheet.Header class="pb-2">
      <Sheet.Title class="text-sm">{drawer ? DRAWER_TITLES[drawer] : ''}</Sheet.Title>
    </Sheet.Header>
    <div class="px-4 pb-4">
      {#if drawer === 'blocks'}
        <div class="grid gap-3">
          <BlockDetail />
          <BlockList />
          <div class="grid gap-1">
            <p class="text-muted-foreground text-xs font-medium">分块参数</p>
            <SegmentPanel readOnly />
          </div>
        </div>
      {:else if drawer === 'physics'}
        <PhysicsPanel />
      {:else if drawer === 'palette'}
        <PalettePanel />
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- 移动端选中块半屏抽屉：选中即在手边，画布保持可见（关抽屉不取消选中） -->
<Sheet.Root bind:open={blockSheetOpen} onOpenChange={(open) => !open && (blockSheetOpen = open)}>
  <Sheet.Content side="bottom" class="max-h-[70vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-testid="block-sheet">
    <Sheet.Header class="pb-2">
      <Sheet.Title class="text-sm">选中块</Sheet.Title>
      <Sheet.Description class="text-xs">拖动可收起；关闭抽屉不会取消画布上的选中。</Sheet.Description>
    </Sheet.Header>
    <div class="px-4 pb-4">
      <BlockDetail />
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground mt-3 w-full rounded-md border py-1.5 text-xs transition-colors"
        onclick={() => {
          selectBlock(null)
          blockSheetOpen = false
        }}
      >
        取消选中
      </button>
    </div>
  </Sheet.Content>
</Sheet.Root>
