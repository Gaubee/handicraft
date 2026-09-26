<!--
WorkbenchCanvasStage.svelte — 工作台画布舞台（add-workbench-pro 2c 鼠标 P0）。
包 StrategyCanvas（view 视口取景+hover 高亮）+叠加注入（笔刷层/指针捕获层——
与画布 viewport 盒同盒对齐）+左侧工具条（V/H/Z/B/fit/100%/±——命令总线同源
execWorkbenchCommand）+底部状态栏。
交互（真源=lib/canvaskit 纯几何，designer DesignerCanvas 同款基建参数化复用）：
滚轮=光标锚定缩放（值域 10%-1600%）；空格按住/中键/抓手工具=平移；缩放工具=
点击放大（Alt+点击缩小）；选择工具=层命中测试（mask 位面命中——store.hitTestNodeAt）
+hover 高亮。坐标真源=画布 px（与 daemon BrushPoint 同一坐标系——§0/D-2⑥）。
-->

<script lang="ts">
  import StrategyCanvas from '$lib/components/strategy/StrategyCanvas.svelte'
  import { Button } from '$lib/components/ui/button'
  import { isEditableTarget, isImeComposing, screenToImage } from '$lib/canvaskit.js'
  import {
    getCanvasView,
    getHoveredNodeId,
    getWorkbenchTool,
    noteStageGeometry,
    panCanvasBy,
    setHoveredNodeId,
    setPointerImage,
    zoomCanvasAtPoint,
    zoomCanvasTo,
  } from './canvasStage.svelte.js'
  import {
    enterBrushMode,
    exitBrushMode,
    getBaseImageOpacity,
    getBaseImageVisible,
    getBrushSession,
    getSelectedNodeId,
    getShowBoxes,
    getShowMasks,
    getWorkbenchCanvasModel,
    hitTestNodeAt,
    selectNode,
    setBaseImageOpacity,
    setBaseImageVisible,
    setShowBoxes,
    setShowMasks,
  } from './store.svelte'
  import { execWorkbenchCommand } from './commands.js'
  import WorkbenchBrushLayer from './WorkbenchBrushLayer.svelte'
  import WorkbenchStatusBar from './WorkbenchStatusBar.svelte'
  import Hand from '@lucide/svelte/icons/hand'
  import Maximize from '@lucide/svelte/icons/maximize'
  import Minus from '@lucide/svelte/icons/minus'
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2'
  import Paintbrush from '@lucide/svelte/icons/paintbrush'
  import Plus from '@lucide/svelte/icons/plus'
  import ZoomIn from '@lucide/svelte/icons/zoom-in'

  const model = $derived(getWorkbenchCanvasModel())
  const view = $derived(getCanvasView())
  const tool = $derived(getWorkbenchTool())
  const brush = $derived(getBrushSession())
  const selectedId = $derived(getSelectedNodeId())
  const hoveredId = $derived(getHoveredNodeId())

  /** 指针捕获层元素（viewport 盒对齐锚——rect 即画布取景盒）。 */
  let overlayEl = $state<HTMLElement | null>(null)

  // 几何推送（视口 fit/中心锚缩放所需——jsdom 无布局时 rect=0，stage 侧跳过）。
  $effect(() => {
    if (overlayEl === null || model === null) return
    const rect = overlayEl.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      noteStageGeometry(rect.width, rect.height, model.imagePx.width, model.imagePx.height)
    }
  })

  /** client → viewport 盒局部（rect 平移；jsdom 无布局=零偏移直通）。 */
  function toLocal(event: { clientX: number; clientY: number }): { x: number; y: number } {
    if (overlayEl === null) return { x: event.clientX, y: event.clientY }
    const rect = overlayEl.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /** viewport 盒局部 → 画布 px（CanvasView 逆映射——canvaskit 单源）。 */
  function toImage(local: { x: number; y: number }): { x: number; y: number } {
    return screenToImage(view, local.x, local.y)
  }

  // ---------------------------------------------------------------- 滚轮锚定缩放

  function onWheel(event: WheelEvent): void {
    if (model === null) return
    event.preventDefault()
    const local = toLocal(event)
    zoomCanvasAtPoint(local.x, local.y, Math.pow(1.0015, -event.deltaY))
  }

  // ---------------------------------------------------------------- 平移/点击会话

  const TAP_SLOP_PX = 5
  /** 空格按住（临时抓手——PS 惯例；表单/按钮聚焦不劫持）。 */
  let spaceHeld = $state(false)
  /** 平移会话（中键/空格/抓手工具——pointerdown 起笔、move 增量、up 收笔）。 */
  let panning = $state<{ lastX: number; lastY: number } | null>(null)
  /** 选择工具点击会话（位移 < slop = 点击命中；≥ = 忽略拖拽）。 */
  let selectDown = $state<{ x: number; y: number } | null>(null)

  function onSpaceDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.code !== 'Space') return
    if (isImeComposing(event) || isEditableTarget(event.target)) return
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return
    spaceHeld = true
    event.preventDefault()
  }

  function onSpaceUp(event: KeyboardEvent): void {
    if (event.code === 'Space') spaceHeld = false
  }

  function effectivePanMode(): boolean {
    return panning !== null
  }

  function onPointerDown(event: PointerEvent): void {
    if (model === null || brush.active) return
    const local = toLocal(event)
    // 平移通道：中键 / 空格按住 / 抓手工具（designer 同款三分——§0 复用面）
    if (event.button === 1 || spaceHeld || tool === 'hand') {
      panning = { lastX: local.x, lastY: local.y }
      try {
        overlayEl?.setPointerCapture?.(event.pointerId)
      } catch {
        // jsdom 无 pointer capture——增量平移照常
      }
      event.preventDefault()
      return
    }
    if (event.button !== 0) return
    // 缩放工具：点击放大 / Alt+点击缩小（光标锚定）
    if (tool === 'zoom') {
      zoomCanvasAtPoint(local.x, local.y, event.altKey ? 0.8 : 1.25)
      event.preventDefault()
      return
    }
    if (tool === 'select') selectDown = { x: event.clientX, y: event.clientY }
  }

  function onPointerMove(event: PointerEvent): void {
    if (model === null) return
    const local = toLocal(event)
    // 状态栏指针读数（画布域外=null——不显示误导坐标）
    const image = toImage(local)
    const inside =
      image.x >= 0 && image.y >= 0 && image.x <= model.imagePx.width && image.y <= model.imagePx.height
    setPointerImage(inside ? { x: Math.round(image.x * 10) / 10, y: Math.round(image.y * 10) / 10 } : null)
    if (panning !== null) {
      panCanvasBy(local.x - panning.lastX, local.y - panning.lastY)
      panning = { lastX: local.x, lastY: local.y }
      return
    }
    // hover 命中高亮（选择工具、非笔刷态）
    if (tool === 'select' && !brush.active && selectDown === null) {
      setHoveredNodeId(inside ? hitTestNodeAt(image.x, image.y) : null)
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (panning !== null) {
      panning = null
      return
    }
    if (selectDown === null || model === null) return
    const moved = Math.hypot(event.clientX - selectDown.x, event.clientY - selectDown.y)
    selectDown = null
    if (moved >= TAP_SLOP_PX) return
    // 点击=层命中测试（mask 位面命中——最深层胜；空白=清空选中）
    const image = toImage(toLocal(event))
    selectNode(hitTestNodeAt(image.x, image.y))
  }

  function onPointerLeave(): void {
    setPointerImage(null)
    setHoveredNodeId(null)
    panning = null
    selectDown = null
  }

  const cursorClass = $derived.by(() => {
    if (brush.active) return ''
    if (effectivePanMode()) return 'cursor-grabbing'
    if (spaceHeld || tool === 'hand') return 'cursor-grab'
    if (tool === 'zoom') return 'cursor-zoom-in'
    return 'cursor-default'
  })

  /** 笔刷开关（工具条按钮——B 键同源命令总线）。 */
  function onToggleBrush(): void {
    if (brush.active) exitBrushMode()
    else enterBrushMode()
  }
</script>

<svelte:window onkeydown={onSpaceDown} onkeyup={onSpaceUp} />

<div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="workbench-canvas-stage">
  <div class="relative min-h-0 min-w-0 flex-1" onwheel={onWheel}>
    <StrategyCanvas
      model={model}
      baseVisible={getBaseImageVisible()}
      onSetBaseVisible={setBaseImageVisible}
      baseOpacity={getBaseImageOpacity()}
      onSetBaseOpacity={setBaseImageOpacity}
      showBoxes={getShowBoxes()}
      onSetShowBoxes={setShowBoxes}
      masks={model?.masks ?? []}
      showMasks={getShowMasks()}
      onSetShowMasks={setShowMasks}
      selectedNodeId={selectedId}
      {view}
      hoverNodeId={hoveredId}
      emptyHint="该任务尚无排钻产物——在 Agent 会话完成策略执行"
    >
      {#snippet children()}
        <!-- 笔刷层（激活时接管指针——z-[5] 在捕获层上） -->
        <WorkbenchBrushLayer />
        <!-- 指针捕获层（视口盒同构；笔刷激活时让位） -->
        <div
          bind:this={overlayEl}
          class="absolute inset-0 z-[4] touch-none {cursorClass} {brush.active ? 'pointer-events-none' : ''}"
          data-testid="workbench-pointer-overlay"
          role="application"
          aria-label="画布交互层（选择/平移/缩放——键盘等价经图层树与快捷键）"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
          onpointerleave={onPointerLeave}
          oncontextmenu={(event) => event.preventDefault()}
        ></div>
      {/snippet}
    </StrategyCanvas>

    <!-- 工具条（V/H/Z/B/fit/100%/±——命令总线同源单点） -->
    <div
      class="bg-background/90 absolute left-2 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-0.5 rounded-md border p-1 shadow-sm backdrop-blur"
      role="toolbar"
      aria-label="画布工具"
      data-testid="workbench-canvas-toolbar"
    >
      <Button
        variant="ghost"
        size="icon"
        class="size-7 {tool === 'select' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
        onclick={() => void execWorkbenchCommand('tool.select')}
        aria-pressed={tool === 'select'}
        data-testid="workbench-tool-select"
        title="选择工具（V）——点选层/命中测试"
      >
        <MousePointer2 class="size-4" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="size-7 {tool === 'hand' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
        onclick={() => void execWorkbenchCommand('tool.hand')}
        aria-pressed={tool === 'hand'}
        data-testid="workbench-tool-hand"
        title="平移工具（H）——拖拽画布；空格按住临时平移"
      >
        <Hand class="size-4" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="size-7 {tool === 'zoom' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
        onclick={() => void execWorkbenchCommand('tool.zoom')}
        aria-pressed={tool === 'zoom'}
        data-testid="workbench-tool-zoom"
        title="缩放工具（Z）——点击放大/Alt+点击缩小；滚轮恒可锚定缩放"
      >
        <ZoomIn class="size-4" aria-hidden="true" />
      </Button>
      <div class="bg-border my-0.5 h-px w-full" aria-hidden="true"></div>
      <Button
        size="icon"
        variant={brush.active ? 'default' : 'ghost'}
        class="size-7"
        disabled={selectedId === null && !brush.active}
        onclick={onToggleBrush}
        data-testid="workbench-brush-toggle"
        title="笔刷编辑选中层遮罩（B）——include/exclude 涂抹→提交重算"
      >
        <Paintbrush class="size-4" aria-hidden="true" />
      </Button>
      <div class="bg-border my-0.5 h-px w-full" aria-hidden="true"></div>
      <Button
        variant="ghost"
        size="icon"
        class="text-muted-foreground size-7"
        onclick={() => void execWorkbenchCommand('zoom.out')}
        data-testid="workbench-zoom-out"
        title="缩小一档（⌘-）"
      >
        <Minus class="size-4" aria-hidden="true" />
      </Button>
      <span class="text-muted-foreground text-center font-mono text-[10px] leading-none" data-testid="workbench-zoom-readout">
        {Math.round(view.scale * 100)}%
      </span>
      <Button
        variant="ghost"
        size="icon"
        class="text-muted-foreground size-7"
        onclick={() => void execWorkbenchCommand('zoom.in')}
        data-testid="workbench-zoom-in"
        title="放大一档（⌘+）"
      >
        <Plus class="size-4" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="text-muted-foreground size-7"
        onclick={() => void execWorkbenchCommand('zoom.fit')}
        data-testid="workbench-zoom-fit"
        title="适配画幅（⌘0）"
      >
        <Maximize class="size-4" aria-hidden="true" />
      </Button>
      <button
        type="button"
        class="text-muted-foreground hover:bg-accent hover:text-accent-foreground size-7 rounded-md font-mono text-[10px] transition-colors"
        onclick={() => zoomCanvasTo(1)}
        data-testid="workbench-zoom-100"
        title="缩放至 100%（⌘1）"
      >
        1:1
      </button>
    </div>
  </div>

  <!-- 状态栏（画布底部——zoom/坐标 px↔mm/ppm 三态/选中层/dirty/降级告警） -->
  <WorkbenchStatusBar />
</div>
