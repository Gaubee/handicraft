<!--
WorkbenchCanvasStage.svelte — 工作台画布舞台（add-workbench-pro 2c；rework-layer-model
v4=PS 化图层渲染 2026-09-27——StrategyCanvas 消费位替换为 WorkbenchLayerStage；
修复轮二 2026-09-28 仅补来源头（Codex 二轮 Standards P2）；presentation U3
2026-09-28（Codex E2）——顶部观察控件收敛为单一 grid 定位根：预览三模式与背景
簇并排/上下 stack 由 container query 编排，两 absolute 容器退役）。
结构：WorkbenchLayerStage（背景层+图层抠图+钻子层——world 取景变换）+叠加注入
（笔刷层 z-[5]/指针捕获层 z-[4]——与舞台 viewport 盒同盒对齐）+顶部观察控件单根
grid（预览三模式+背景层开关簇——眼睛+透明度+颗数读数，design §3 背景层可隐藏）
+底部状态栏。左侧工具条已外提 WorkbenchRail 左实例（rework-workbench-rail-drawers
2.2——V/H/Z/B/缩放档位命令总线同源；工具状态真源在 store，Stage 零自有工具状态）。
交互（真源=lib/canvaskit 纯几何，零变化）：滚轮=光标锚定缩放（10%-1600%）；
空格按住/中键/抓手=平移；缩放工具=点击放大（Alt+点击缩小）；选择工具=层命中
（mask 位面命中——store.hitTestNodeAt）+hover 高亮+钻单颗 hover 预览规格
（GemSpatialIndex 命中）。坐标真源=画布 px（与 daemon BrushPoint 同一坐标系）。
-->

<script lang="ts">
  import { imageToScreen, isEditableTarget, isImeComposing, screenToImage } from '$lib/canvaskit.js'
  import {
    getCanvasView,
    getHoveredNodeId,
    getWorkbenchTool,
    noteStageGeometry,
    panCanvasBy,
    setHoveredNodeId,
    setPointerImage,
    zoomCanvasAtPoint,
  } from './canvasStage.svelte.js'
  import {
    getAssignmentOf,
    getBaseImageOpacity,
    getBaseImageVisible,
    getBaseSourceMode,
    getBrushSession,
    getPreviewMode,
    getSourceImageUrl,
    getWorkbenchLayerRender,
    hitTestNodeAt,
    selectNode,
    setBaseImageOpacity,
    setBaseImageVisible,
    setBaseSourceMode,
    setPreviewMode,
  } from './store.svelte'
  import { GemSpatialIndex, type GemHit } from './layerRender.svelte.js'
  import { isWorkbenchVisible } from './presence.svelte.js'
  import type { WorkbenchPreviewMode } from '@handicraft/contracts'
  import WorkbenchBrushLayer from './WorkbenchBrushLayer.svelte'
  import WorkbenchLayerStage from './WorkbenchLayerStage.svelte'
  import WorkbenchStatusBar from './WorkbenchStatusBar.svelte'
  import Circle from '@lucide/svelte/icons/circle'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Hash from '@lucide/svelte/icons/hash'
  import Sparkles from '@lucide/svelte/icons/sparkles'

  let {
    /** [w17-critic T3] 左/右 Drawer 在场——观察控件根避让（工具条居中于剩余区，
     *  不再被 Drawer 拦腰盖住；宽度档与 WorkbenchRailDrawer 同源：左 w-72/紧凑
     *  max-w-80，右 w-80）。 */
    avoidLeft = false,
    avoidRight = false,
  }: { avoidLeft?: boolean; avoidRight?: boolean } = $props()

  const model = $derived(getWorkbenchLayerRender())
  const view = $derived(getCanvasView())
  const tool = $derived(getWorkbenchTool())
  const brush = $derived(getBrushSession())
  const hoveredId = $derived(getHoveredNodeId())
  const previewMode = $derived(getPreviewMode())

  /** 钻空间索引（模型身份驱动——hover 单颗命中）。 */
  const gemIndex = $derived(model === null ? null : new GemSpatialIndex(model.rows))

  /** 预览三模式（v4 语义重定）：rendered=钻渲进层/holes=只孔洞/numbered=组色+侧栏图例。 */
  const PREVIEW_MODES: Array<{ value: WorkbenchPreviewMode; label: string; title: string; icon: typeof Circle }> = [
    { value: 'holes', label: '孔洞', title: '孔洞模式——底图淡化+冲孔视觉（只看钻孔位·层内坐标）', icon: Circle },
    { value: 'numbered', label: '编号', title: '编号模式——孔洞按图层分色（图例在图层面板；组色描边可选）', icon: Hash },
    { value: 'rendered', label: '成钻', title: '成钻模式——钻渲染进所属图层（石色+高光+金属光泽；缺省）', icon: Sparkles },
  ]

  /** 指针捕获层元素（viewport 盒对齐锚——rect 即画布取景盒）。 */
  let overlayEl = $state<HTMLElement | null>(null)
  /** 舞台根（空格门可见性锚——presence.svelte）。 */
  let stageEl = $state<HTMLElement | null>(null)

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
    if (!isWorkbenchVisible(stageEl)) return // F3：隐藏工作台不截获空格平移（Tabs 常驻双实例）
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

  // ---------------------------------------------------------------- 钻单颗 hover（空间索引）

  /** hover 钻面（层名+规格——design §3 选中层钻可交互：hover 单颗预览规格）。 */
  let hoveredGem = $state<GemHit | null>(null)
  /** 光标屏幕位（tooltip 锚——viewport 盒局部 px）。 */
  let hoveredGemAt = $state<{ x: number; y: number } | null>(null)

  const hoveredGemSpec = $derived.by(() => {
    if (hoveredGem === null) return null
    const assignment = getAssignmentOf(hoveredGem.nodeId)
    const stones = assignment?.stones ?? []
    const sku = stones.map((stone) => `${stone.sku}${stone.sizeMm !== null ? `(${stone.sizeMm}mm)` : ''}`).join('、')
    return {
      nodeId: hoveredGem.nodeId,
      colorHex: hoveredGem.gem.colorHex,
      diameterMm: (hoveredGem.gem.radiusPx * 2) / (model?.ppm.ppm ?? 2),
      sku: sku === '' ? '未指派钻' : sku,
      count: stones.length,
    }
  })

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
    // hover 命中（选择工具、非笔刷态）：钻单颗优先（空间索引）→层命中（mask 位面）
    if (tool === 'select' && !brush.active && selectDown === null) {
      if (inside && gemIndex !== null) {
        const gemHit = gemIndex.hitTest(image.x, image.y)
        hoveredGem = gemHit
        hoveredGemAt = gemHit === null ? null : { x: local.x, y: local.y }
        setHoveredNodeId(gemHit !== null ? gemHit.nodeId : inside ? hitTestNodeAt(image.x, image.y) : null)
        return
      }
      hoveredGem = null
      hoveredGemAt = null
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
    hoveredGem = null
    hoveredGemAt = null
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
</script>

<svelte:window onkeydown={onSpaceDown} onkeyup={onSpaceUp} />

<div class="flex min-h-0 min-w-0 flex-1 flex-col" bind:this={stageEl} data-testid="workbench-canvas-stage">
  <div class="relative min-h-0 min-w-0 flex-1" onwheel={onWheel}>
    <WorkbenchLayerStage {model} hoveredNodeId={hoveredId}>
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
        <!-- 钻单颗 hover 规格（design §3——光标近旁；仅 hover 时在场） -->
        {#if hoveredGemSpec !== null && hoveredGemAt !== null}
          {@const tipX = Math.min(hoveredGemAt.x + 14, (overlayEl?.clientWidth ?? 9999) - 176)}
          <div
            class="bg-background/95 pointer-events-none absolute z-[7] flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] shadow-sm"
            style="left: {tipX}px; top: {hoveredGemAt.y + 14}px;"
            data-testid="workbench-gem-hover-tip"
            data-node-id={hoveredGemSpec.nodeId}
            role="status"
          >
            <span class="size-2.5 shrink-0 rounded-full border border-black/20" style="background: {hoveredGemSpec.colorHex}" aria-hidden="true"></span>
            <span class="font-medium">{hoveredGemSpec.diameterMm.toFixed(1)}mm</span>
            <span class="text-muted-foreground max-w-32 truncate" title={hoveredGemSpec.sku}>{hoveredGemSpec.sku}</span>
          </div>
        {/if}
      {/snippet}
    </WorkbenchLayerStage>

    <!-- 画布观察控件单定位根（presentation U3/Codex E2——两个 absolute 容器收敛为一）：
         根=全宽 pointer-events-none 轨道（container-type: inline-size——container query
         基准=画布舞台宽）；内部单一 grid 编排 [预览模式 segmented]+[背景簇]——
         宽（容器 ≥420px）两单元并排（auto 列：shrink-to-fit 容器下 1fr 列会坍缩 0 宽，
         auto 列=内容宽且可 min-w-0 收缩）；窄（<420px，含紧凑 320px）自然单列上下
         stack。事件命中：根不接收指针（不遮画布主体），两单元 pointer-events-auto
         各自独立 hit area（点击/拖滑不串写）。笔刷态预览单元让位（背景簇常驻）。
         [w19-critic P0] 轨道改 inset-y-0 全高（避让 left/right 内缩）后 flex 缺省
         stretch 曾把可见 grid 拉满列高（434×764 磨砂大卡盖画布）——根 items-start+
         grid h-fit/self-start 双保险恢复紧凑 pill 形态。 -->
    <div
      class="pointer-events-none absolute inset-y-0 top-2 z-10 flex items-start justify-center px-2 transition-[left,right] duration-200
        {avoidLeft ? '@max-lg:left-80 left-72' : 'left-0'}
        {avoidRight ? 'right-80' : 'right-0'}"
      style="container-type: inline-size"
      data-testid="workbench-observation-root"
    >
      <div
        class="pointer-events-auto bg-background/90 grid h-fit w-fit max-w-full grid-cols-1 gap-1 self-start rounded-md border p-1 shadow-sm backdrop-blur @min-[420px]:grid-cols-[auto_auto]"
        data-testid="workbench-observation-grid"
      >
        <!-- 单元一：预览三模式（v4 语义重定——rendered/holes/numbered；笔刷态让位） -->
        {#if !brush.active}
          <div
            class="flex min-w-0 items-center justify-center gap-0.5 overflow-x-auto rounded p-0.5"
            role="toolbar"
            aria-label="预览模式"
            data-testid="workbench-preview-mode"
          >
            {#each PREVIEW_MODES as mode (mode.value)}
              {@const Icon = mode.icon}
              <button
                type="button"
                class="hover:bg-accent hover:text-accent-foreground flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors {previewMode === mode.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}"
                onclick={() => setPreviewMode(mode.value)}
                aria-pressed={previewMode === mode.value}
                data-testid="workbench-preview-{mode.value}"
                title={mode.title}
                aria-label={mode.label}
              >
                <Icon class="size-3.5" aria-hidden="true" />
                <span>{mode.label}</span>
              </button>
            {/each}
          </div>
        {/if}
        <!-- 单元二：背景层开关簇（眼睛+透明度+颗数读数——背景层=原图可隐藏） -->
        <div
          class="flex min-w-0 items-center justify-center gap-2 px-1.5"
          data-testid="workbench-base-controls"
          role="group"
          aria-label="背景层与读数"
        >
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded px-1 py-0.5 text-[11px] transition-colors"
            onclick={() => setBaseImageVisible(!getBaseImageVisible())}
            aria-pressed={getBaseImageVisible()}
            data-testid="workbench-base-toggle"
            title={getBaseImageVisible() ? '隐藏背景层——仅见图层抠图' : '显示背景层'}
          >
            {#if getBaseImageVisible()}
              <Eye class="size-3.5" aria-hidden="true" />
            {:else}
              <EyeOff class="size-3.5 opacity-50" aria-hidden="true" />
            {/if}
            <span>背景</span>
          </button>
          {#if getSourceImageUrl() !== null}
            <!-- 底图源切换（2026-10-05 Owner 需求：原图=参考图之根——两者都要可见）。
                 仅原图在场且参考图层同源可辨时显示；anchor=树锚（参考图/识图锚）。 -->
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground rounded px-1 py-0.5 text-[11px] transition-colors"
              onclick={() => setBaseSourceMode(getBaseSourceMode() === 'anchor' ? 'source' : 'anchor')}
              data-testid="workbench-base-source-toggle"
              title={getBaseSourceMode() === 'anchor' ? '当前底图=树锚图（参考图/识图锚）——点击切换为会话原图' : '当前底图=会话原图（参考图之根）——点击切换回树锚图'}
            >
              {getBaseSourceMode() === 'anchor' ? '底图·参考图' : '底图·原图'}
            </button>
          {/if}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={getBaseImageOpacity()}
            oninput={(event) => setBaseImageOpacity(Number(event.currentTarget.value))}
            class="accent-primary hidden h-1.5 w-12 @min-[280px]:block @min-[480px]:w-16"
            data-testid="workbench-base-opacity"
            aria-label="背景层透明度"
          />
          <span
            class="text-muted-foreground hidden font-mono text-[10px] @min-[480px]:block @min-[480px]:pl-1"
            data-testid="workbench-stage-count"
            title="可见钻数（去重口径——父层旧指派不计数） · ppm 换算口径"
          >
            {model === null ? '' : `${model.gemsVisible} 颗${model.ppm.exact ? ` · ppm=${model.ppm.ppm.toFixed(2)}` : ' · ppm≈回退'}`}
          </span>
        </div>
      </div>
    </div>

    <!-- 画布工具条已外提左 rail（rework-workbench-rail-drawers 2.2——WorkbenchRail
         左实例承载 V/H/Z/B/缩放档位，命令总线同源；Stage 只剩画布+观察控件+状态栏） -->
  </div>

  <!-- 状态栏（画布底部——zoom/坐标 px↔mm/ppm 三态/选中层/dirty/降级告警） -->
  <WorkbenchStatusBar />
</div>
