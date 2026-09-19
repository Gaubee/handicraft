<!--
Orthogonal intents (max 3):
1. [2026-09-18 Canvas] 数字油画底图 + 分块着色（中位色半透明覆盖 + 边界描线）的 canvas 渲染，悬停高亮 / 点击选中。
     [2026-09-19 Preview-fix] 预览三模式接线（redesign-studio-layout spec：预览控制即时作用于画布呈现）：
     层分派经 pickCanvasLayers 纯函数（gems 纯钻 / painting 叠稿 / reference 叠原；无钻回落现状渲染）。
2. [2026-09-18 Viewport/N1] 缩放平移：滚轮（光标锚）/ 双指 pinch（质心锚，R4）/ 拖拽平移 / 双击适应；
     分层离屏缓存保证大图流畅。浮动工具栏（vision P0-1 重叠修复：absolute 浮层不再压图像）。
     取景 fit = computeFit 纯函数（contain×0.9 居中），容器 resize 后未手动取景时重算（N1 移动取景损坏修复）。
3. [2026-09-18 R3 → add-asset-library 5.1] 空态双 CTA（从素材库选择=主入口（AssetPickerController 已接线）/
     直接上传=次入口，上传即入库+选中）+ 钻点母题底纹。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import {
    getBackgroundObservation,
    getBlocks,
    getDisabledIds,
    getGrid,
    getLayerResult,
    getLayers,
    getPainting,
    getPalette,
    getReferenceImage,
    getSelectedBlockId,
    getSegmenting,
    getSourceImage,
    isLayerSelected,
    loadFromFile,
    loadFromLibrary,
    selectBlock,
  } from '$lib/stores/studio.svelte'
  import { DESELECTED_LAYER_OPACITY, SELECTED_LAYER_OPACITY } from '$lib/studio/layers.svelte'
  import Upload from '@lucide/svelte/icons/upload'
  import Library from '@lucide/svelte/icons/library'
  import { pickCanvasLayers, type CanvasLayerPlan } from '$lib/studio/previewRender'
  import { computeFit } from './fit'
  import { paintGems } from './gemPaint'

  let canvasEl = $state<HTMLCanvasElement | null>(null)
  let wrapEl = $state<HTMLDivElement | null>(null)

  let view = $state({ scale: 1, x: 0, y: 0 })
  let hoverBi = $state(-1)
  let dragging = $state(false)

  const source = $derived(getSourceImage())
  const blocks = $derived(getBlocks())
  const selectedId = $derived(getSelectedBlockId())
  const segmenting = $derived(getSegmenting())

  // 参考原图 → Image 元素（reference 模式叠原底图；生命周期模式与 StrategyFilmStrip 一致：
  // 组件层解析位图，绘制层只收成品；卸载/换源清理）
  let refImg = $state<HTMLImageElement | null>(null)
  $effect(() => {
    const ref = getReferenceImage()
    if (!ref) {
      refImg = null
      return
    }
    const img = new Image()
    img.onload = () => {
      refImg = img
    }
    img.src = ref.dataUrl
    return () => {
      refImg = null
    }
  })

  interface Layers {
    W: number
    H: number
    paint: HTMLCanvasElement | null
    overlay: HTMLCanvasElement | null
    label: Int16Array
  }
  let layers = $state<Layers | null>(null)
  let minScale = 0.05

  // 离屏高亮缓存（块索引 → bbox 大小画布；块集变化时失效）
  let highlightCache = new Map<number, HTMLCanvasElement>()

  function makeLayer(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    return ctx ? { canvas, ctx } : null
  }

  /** 底图 / 分块覆盖 / labelMap 重建（分块或禁用集变化时）。只写 layers，不触发渲染/适配——
   * 渲染由下方渲染 effect 自动追踪 redraw 内对 layers 的读取，适配由独立 effect 负责
   * （本 effect 若经 redraw/fitView 读 layers，即读写同一状态 → effect_update_depth_exceeded） */
  $effect(() => {
    const p = getPainting()
    const bs = getBlocks()
    const disabled = new Set(Object.keys(getDisabledIds()))
    highlightCache = new Map()
    if (!p) {
      layers = null
      return
    }
    const W = p.width
    const H = p.height
    const data = new Uint8ClampedArray(p.data)

    const paint = makeLayer(W, H)
    if (paint) paint.ctx.putImageData(new ImageData(data, W, H), 0, 0)

    const label = new Int16Array(W * H).fill(-1)
    bs.forEach((b, bi) => {
      const bits = b.mask.bits
      const { x, y, w, h } = b.bbox
      for (let dy = 0; dy < h; dy++) {
        const row = (y + dy) * W + x
        for (let dx = 0; dx < w; dx++) {
          if (bits[dy * w + dx] === 1) label[row + dx] = bi
        }
      }
    })

    const overlay = makeLayer(W, H)
    if (overlay) {
      const img = overlay.ctx.createImageData(W, H)
      const px = img.data
      const dim = disabled.has.bind(disabled)
      bs.forEach((b, bi) => {
        if (dim(b.id)) return
        const [r, g, bl] = b.colorRgb
        const { x, y, w, h } = b.bbox
        const bits = b.mask.bits
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) {
            if (bits[dy * w + dx] !== 1) continue
            const gx = x + dx
            const gy = y + dy
            const boundary =
              label[gy * W + gx - 1] !== bi ||
              label[gy * W + gx + 1] !== bi ||
              label[(gy - 1) * W + gx] !== bi ||
              label[(gy + 1) * W + gx] !== bi
            const i = (gy * W + gx) * 4
            px[i] = r
            px[i + 1] = g
            px[i + 2] = bl
            px[i + 3] = boundary ? 210 : 70
          }
        }
      })
      overlay.ctx.putImageData(img, 0, 0)
    }

    layers = { W, H, paint: paint?.canvas ?? null, overlay: overlay?.canvas ?? null, label }
  })

  /** 新图落成 → 强制适应窗口（N1：fit 由 computeFit 纯函数计算；写 view 不读 view，无自反馈环）。
   *  userAdjusted：用户手动缩放/平移后置位——容器 resize 只在未手动取景时重算 fit，不打断用户视口 */
  let userAdjusted = false
  let fittedFor: { src: unknown; key: string } | null = null
  $effect(() => {
    const l = layers
    const src = source
    if (!l) {
      fittedFor = null
      return
    }
    const key = `${l.W}x${l.H}`
    if (!fittedFor || fittedFor.src !== src || fittedFor.key !== key) {
      fittedFor = { src, key }
      fitView()
    }
  })

  /** 单块高亮画布（边界实线 + 内部淡填充），懒构建并缓存 */
  function highlightCanvas(bi: number): HTMLCanvasElement | null {
    const cached = highlightCache.get(bi)
    if (cached) return cached
    const b = blocks[bi]
    const l = layers
    if (!b || !l) return null
    const layer = makeLayer(b.bbox.w, b.bbox.h)
    if (!layer) return null
    const img = layer.ctx.createImageData(b.bbox.w, b.bbox.h)
    const px = img.data
    const { w, h } = b.bbox
    const bits = b.mask.bits
    const label = l.label
    const W = l.W
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (bits[dy * w + dx] !== 1) continue
        const gx = b.bbox.x + dx
        const gy = b.bbox.y + dy
        const boundary =
          label[gy * W + gx - 1] !== bi ||
          label[gy * W + gx + 1] !== bi ||
          label[(gy - 1) * W + gx] !== bi ||
          label[(gy + 1) * W + gx] !== bi
        const i = (dy * w + dx) * 4
        px[i] = 255
        px[i + 1] = 255
        px[i + 2] = 255
        px[i + 3] = boundary ? 230 : 50
      }
    }
    layer.ctx.putImageData(img, 0, 0)
    highlightCache.set(bi, layer.canvas)
    return layer.canvas
  }

  const selectedBi = $derived(selectedId ? blocks.findIndex((b) => b.id === selectedId) : -1)

  /** 三模式层分派执行：plan 由重绘 effect 按预览模式/透明度/有钻经 pickCanvasLayers 产出。
   *  钻点层默认 transform（scale:1/ox:0/oy:0）——ctx 已带视口变换，半径语义与胶片带浮卡一致 */
  function redraw(plan: CanvasLayerPlan): void {
    const cv = canvasEl
    const l = layers
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const cw = cv.clientWidth || 600
    const ch = cv.clientHeight || 420
    const dpr = window.devicePixelRatio || 1
    const bw = Math.round(cw * dpr)
    const bh = Math.round(ch * dpr)
    if (cv.width !== bw) cv.width = bw
    if (cv.height !== bh) cv.height = bh
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    if (!l) return

    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.scale, view.scale)
    ctx.imageSmoothingEnabled = view.scale < 4
    if (plan.reference && refImg) {
      // 叠原：参考原图铺满 painting 尺寸区域（原图未降采样，拉伸对齐底图坐标系——drawPreview 同语义）
      ctx.globalAlpha = plan.referenceAlpha
      ctx.drawImage(refImg, 0, 0, l.W, l.H)
      ctx.globalAlpha = 1
    }
    if (plan.paint && l.paint) {
      // 叠稿：底图按 overlayOpacity 半透明（回落时 alpha=1 = 修复前现状）
      ctx.globalAlpha = plan.paintAlpha
      ctx.drawImage(l.paint, 0, 0)
      ctx.globalAlpha = 1
    }
    if (plan.overlay && l.overlay) {
      // 分块着色层：仅无钻回落保留（有钻时让位给钻点，避免双层色干扰对照）
      ctx.globalAlpha = plan.overlayAlpha
      ctx.drawImage(l.overlay, 0, 0)
      ctx.globalAlpha = 1
    }
    if (plan.gems) {
      // [2.6] 逐层绘制（可见层按列表序；选中 1.0 / 非选中 0.8 固定常量——渲染三分）
      const grid = getGrid()
      for (const layer of getLayers()) {
        if (!layer.visible) continue
        const entry = getLayerResult(layer.id)
        if (!entry || entry.gems.length === 0) continue
        ctx.globalAlpha = isLayerSelected(layer.id) ? SELECTED_LAYER_OPACITY : DESELECTED_LAYER_OPACITY
        paintGems(ctx, entry.gems, getPalette(), blocks, grid)
        ctx.globalAlpha = 1
      }
    }
    if (hoverBi >= 0 && hoverBi !== selectedBi) {
      const hc = highlightCanvas(hoverBi)
      const b = blocks[hoverBi]
      if (hc && b) {
        ctx.globalAlpha = 0.6
        ctx.drawImage(hc, b.bbox.x, b.bbox.y)
        ctx.globalAlpha = 1
      }
    }
    if (selectedBi >= 0) {
      const hc = highlightCanvas(selectedBi)
      const b = blocks[selectedBi]
      if (hc && b) {
        ctx.drawImage(hc, b.bbox.x, b.bbox.y)
        ctx.strokeStyle = 'rgba(255,255,255,0.95)'
        ctx.lineWidth = 1.5 / view.scale
        ctx.setLineDash([6 / view.scale, 4 / view.scale])
        ctx.strokeRect(b.bbox.x, b.bbox.y, b.bbox.w, b.bbox.h)
        ctx.setLineDash([])
      }
    }
    ctx.restore()
  }

  // 重绘调度：latest-wins rAF 合并（透明度连拖/平移高频事件一帧最多一次全量重绘；
  // 无 rAF 环境（jsdom/SSR）同步退化——待绘 plan 恒取最新一次 effect 产物）
  let redrawRaf = 0
  let redrawPending = false
  let pendingPlan: CanvasLayerPlan | null = null
  function scheduleRedraw(plan: CanvasLayerPlan): void {
    pendingPlan = plan
    if (redrawPending) return
    redrawPending = true
    const run = (): void => {
      redrawPending = false
      redrawRaf = 0
      const p = pendingPlan
      pendingPlan = null
      if (p) redraw(p)
    }
    if (typeof requestAnimationFrame === 'function') redrawRaf = requestAnimationFrame(run)
    else run()
  }
  // 卸载清理：未决帧撤销（防迟到的 rAF 回调触达已卸载组件）
  $effect(() => {
    return () => {
      if (redrawRaf) cancelAnimationFrame(redrawRaf)
    }
  })

  // 视口 / 悬停 / 选中 / 画布尺寸 / 图层重建 / 参考位图 / 背景源与透明度 / 层可见与选择 / 结果落地 → 重绘
  $effect(() => {
    void view.scale
    void view.x
    void view.y
    void hoverBi
    void selectedBi
    void canvasEl
    void cssTick
    void layers
    void blocks
    void refImg
    const studioLayers = getLayers()
    const background = getBackgroundObservation()
    const layerResults = studioLayers.map((l) => ({ layer: l, entry: getLayerResult(l.id) }))
    const hasGems = layerResults.some(({ layer, entry }) => layer.visible && (entry?.gems.length ?? 0) > 0)
    const plan = pickCanvasLayers({
      background: { source: background.source, opacity: background.opacity, visible: background.visible },
      hasGems,
    })
    // 重着色跟随：palette/颜色覆写原地重映射只改 colorId（钻数与结果引用不变）→ 深读入依赖；
    // 层选择驱动三分 alpha → 深读 isLayerSelected
    if (plan.gems) {
      for (const { layer, entry } of layerResults) {
        if (!layer.visible) continue
        void isLayerSelected(layer.id)
        for (const g of entry?.gems ?? []) void g.colorId
      }
    }
    scheduleRedraw(plan)
  })

  // 容器尺寸跟随（jsdom 无 ResizeObserver 时退化为 window resize）
  let cssTick = $state(0)
  $effect(() => {
    const wrap = wrapEl
    if (!wrap) return
    if (typeof ResizeObserver === 'undefined') {
      const onResize = (): void => {
        cssTick++
      }
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    const ro = new ResizeObserver(() => {
      cssTick++
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  })

  // N1 容器 resize → 未手动取景时重算 fit：移动端旋转/工具栏收放/断点切换后，
  // 取景不再滞留旧容器尺寸（此前 fit 只在新图层时计算一次，是移动画布取景损坏的根因）
  let lastBox = { w: 0, h: 0 }
  $effect(() => {
    void cssTick
    const cv = canvasEl
    if (!cv || !layers) return
    const w = cv.clientWidth
    const h = cv.clientHeight
    if (w <= 0 || h <= 0) return
    if (w !== lastBox.w || h !== lastBox.h) {
      lastBox = { w, h }
      if (!userAdjusted) fitView()
    }
  })

  /** 取景纯出口（redesign-studio-layout 1.2）：取景控制迁上下文条，经 bind:this 暴露给 StudioView 转发 */
  export function fitView(): void {
    const cv = canvasEl
    const l = layers
    if (!cv || !l) return
    const cw = cv.clientWidth || 600
    const ch = cv.clientHeight || 420
    const fit = computeFit(cw, ch, l.W, l.H)
    minScale = Math.max(0.02, fit.scale / 8)
    view = { scale: fit.scale, x: fit.x, y: fit.y }
    userAdjusted = false
  }

  export function zoomBy(factor: number): void {
    const cv = canvasEl
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    zoomAt(rect.width / 2, rect.height / 2, factor)
  }

  /** 当前缩放百分比（上下文条读数；读 view.scale 信号，父级 $derived 可追踪） */
  export function getZoomPercent(): number {
    return Math.round(view.scale * 100)
  }

  function zoomAt(mx: number, my: number, factor: number): void {
    const scale = Math.min(40, Math.max(minScale, view.scale * factor))
    userAdjusted = true
    view = {
      scale,
      x: mx - ((mx - view.x) / view.scale) * scale,
      y: my - ((my - view.y) / view.scale) * scale,
    }
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    const cv = canvasEl
    if (!cv || !layers) return
    const rect = cv.getBoundingClientRect()
    const factor = Math.pow(1.0015, -e.deltaY)
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
  }

  function toImageLocal(clientX: number, clientY: number): { x: number; y: number } {
    const cv = canvasEl
    if (!cv) return { x: 0, y: 0 }
    const rect = cv.getBoundingClientRect()
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    }
  }

  function blockIndexAt(x: number, y: number): number {
    const l = layers
    if (!l) return -1
    const ix = Math.round(x)
    const iy = Math.round(y)
    if (ix < 0 || iy < 0 || ix >= l.W || iy >= l.H) return -1
    return l.label[iy * l.W + ix]
  }

  // ---- 指针交互：单指拖拽/点选 + 双指 pinch（R4）----
  // 移动阈值 8px 内视为 tap（PM §4.3 放宽命中）；双指进入 pinch 后本次手势不再点选
  const TAP_SLOP_PX = 8

  let dragStart = { x: 0, y: 0, vx: 0, vy: 0, moved: false }
  const activePointers = new Map<number, { x: number; y: number }>()
  /** pinch 基线：起始双指距 / 起始 scale / 起始视口 */
  let pinchBase: { dist: number; scale: number; x: number; y: number } | null = null

  function pinchMetrics(): { midX: number; midY: number; dist: number } | null {
    if (activePointers.size < 2) return null
    const pts = [...activePointers.values()]
    const dx = pts[0].x - pts[1].x
    const dy = pts[0].y - pts[1].y
    return { midX: (pts[0].x + pts[1].x) / 2, midY: (pts[0].y + pts[1].y) / 2, dist: Math.hypot(dx, dy) }
  }

  function localMid(midX: number, midY: number): { mx: number; my: number } {
    const cv = canvasEl
    if (!cv) return { mx: 0, my: 0 }
    const rect = cv.getBoundingClientRect()
    return { mx: midX - rect.left, my: midY - rect.top }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!layers) return
    canvasEl?.setPointerCapture(e.pointerId)
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (activePointers.size === 2) {
      // 双指手势接管：取消单指拖拽，冻结 pinch 基线
      dragging = false
      const m = pinchMetrics()
      if (m && m.dist > 0) pinchBase = { dist: m.dist, scale: view.scale, x: view.x, y: view.y }
    } else if (activePointers.size === 1) {
      dragging = true
      dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    // pinch：以双指质心为锚，factor = 当前距 / 基线距
    if (activePointers.size >= 2 && pinchBase) {
      const m = pinchMetrics()
      if (m && pinchBase.dist > 0) {
        const factor = m.dist / pinchBase.dist
        const scale = Math.min(40, Math.max(minScale, pinchBase.scale * factor))
        const { mx, my } = localMid(m.midX, m.midY)
        userAdjusted = true
        view = {
          scale,
          x: mx - ((mx - pinchBase.x) / pinchBase.scale) * scale,
          y: my - ((my - pinchBase.y) / pinchBase.scale) * scale,
        }
      }
      return
    }

    if (dragging) {
      const dx = e.clientX - dragStart.x
      const dy = e.clientY - dragStart.y
      if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) dragStart.moved = true
      if (dragStart.moved) {
        userAdjusted = true
        view = { ...view, x: dragStart.vx + dx, y: dragStart.vy + dy }
      }
      return
    }
    const p = toImageLocal(e.clientX, e.clientY)
    hoverBi = blockIndexAt(p.x, p.y)
  }

  function onPointerUp(e: PointerEvent): void {
    const wasSingle = activePointers.size === 1
    activePointers.delete(e.pointerId)
    if (activePointers.size < 2) pinchBase = null

    if (wasSingle && dragging) {
      dragging = false
      if (!dragStart.moved) {
        const p = toImageLocal(e.clientX, e.clientY)
        const bi = blockIndexAt(p.x, p.y)
        // [2.4] 命中失败不改变任何选择（图层稿 §A.5——层/块列表是确定性兜底；列表行/详情的
        // 显式取消选中仍走 selectBlock(null)）
        if (bi >= 0) selectBlock(blocks[bi]?.id ?? null)
      }
      return
    }
    dragging = false
  }

  function onPointerLeave(): void {
    hoverBi = -1
    dragging = false
  }

  async function onUpload(e: Event): Promise<void> {
    const input = e.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    if (file) await loadFromFile(file)
    input.value = ''
  }

  /** [5.1 主 CTA] 素材库选图器（App 层唯一 Host；取消/Esc → null 不动当前图）。 */
  async function pickFromLibrary(): Promise<void> {
    const picked = await assetPicker.open({ multi: false })
    const first = picked?.[0]
    if (first) await loadFromLibrary({ id: first.id, name: first.name })
  }

  const cursor = $derived(dragging ? 'grabbing' : layers ? (hoverBi >= 0 ? 'pointer' : 'grab') : 'default')
</script>

<div
  bind:this={wrapEl}
  class="relative h-full min-h-0 w-full overflow-hidden rounded-xl border bg-card"
  data-testid="block-canvas"
>
  {#if !source}
    <!-- 空态：钻点母题底纹 + 双 CTA（[add-asset-library 5.1] 从素材库选择=主 / 上传=次，入库+选中） -->
    <div
      class="bg-gem-dots flex h-full min-h-72 flex-col items-center justify-center gap-4 rounded-xl p-6 text-center"
      data-testid="canvas-empty"
    >
      <div class="flex flex-col items-center gap-1.5">
        <h3 class="text-sm font-semibold tracking-tight">还没有数字油画</h3>
        <p class="text-muted-foreground text-xs">从素材库挑一张生成图/上传图，或直接上传一张已就绪的图</p>
      </div>
      <div class="flex flex-col items-center gap-2 sm:flex-row">
        <!-- 主 CTA：素材库选图器（controller 已就绪：open → loadFromLibrary 入选） -->
        <Button onclick={() => void pickFromLibrary()} title="从素材库挑一张生成图或上传图" data-testid="empty-pick-from-library">
          <Library />
          从素材库选择
        </Button>
        <label class="cursor-pointer">
          <span
            class="border-input bg-background hover:bg-muted hover:text-foreground inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium shadow-xs transition-colors"
          >
            <Upload class="size-4" />
            直接上传数字油画
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="hidden"
            onchange={onUpload}
            data-testid="painting-upload"
          />
        </label>
      </div>
    </div>
  {:else}
    <canvas
      bind:this={canvasEl}
      class="block h-full w-full touch-none select-none"
      style="cursor: {cursor}"
      onwheel={onWheel}
      ondblclick={() => fitView()}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onpointerleave={onPointerLeave}
      data-testid="block-canvas-canvas"
    ></canvas>

    <!-- 取景控制（适应/±/百分比）已迁上下文条（redesign-studio-layout 1.2，经 export fitView/zoomBy/getZoomPercent）；
         此处仅留角落状态徽标（状态矩阵：分块中 → 画布角落沿用） -->
    {#if segmenting}
      <div class="absolute left-3 top-3 z-10">
        <Badge variant="secondary">分块中…</Badge>
      </div>
    {/if}

    <!-- 深底白字提示条（vision #17） -->
    <div
      class="absolute right-3 bottom-3 z-10 rounded-md bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm"
    >
      <span class="hidden lg:inline">滚轮缩放 · 拖拽平移 · 点击选块</span>
      <span class="lg:hidden">单指平移 · 双指缩放 · 双击适应</span>
    </div>
  {/if}
</div>
