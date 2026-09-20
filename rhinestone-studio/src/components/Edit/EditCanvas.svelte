<!--
 * Orthogonal intents (max 5):
 * 1. [2026-09-19 Layers] 四层合成只读画布（design.md §2）：painting 底图快照 → reference 可选原图
 *     → blocks 只读描线 → gems 钻面；每层独立显隐+透明度（edit store layers 状态）。
 * 2. [2026-09-19 Viewport] 缩放平移复用工作台画布经验（BlockCanvas 手法）：滚轮光标锚缩放 /
 *     双指 pinch 质心锚 / 拖拽平移 / 双击适应；容器 resize 未手动取景时重算 fit。
 * 3. [2026-09-20 C-3.2/3.3 rename-and-expert-workbench] 选择/笔刷工具分派层：点选+Shift 加减选、
 *     框选（marquee 相交命中 → setSelection）、笔刷起笔-move-收笔（意图流经 workbench.emitBrushEvent
 *     出口）、笔刷光标预览与吸附格位高亮；中键/空格/触摸单指 = 平移。
 *     [2026-09-20 D-5.5] 挂载期接线 brushEngine（attachBrushEngine——消费意图流落钻/擦除，
 *     一笔单 undo 组）+ 拒画闪红读数渲染（brushRejections 红 X）；笔刷光标圈 = 当前笔刷规格半径。
 * 4. [2026-09-19 Guard] jsdom 无 2d 上下文：全部 ctx 路径 null 守卫，挂载冒烟与浏览器渲染同构。
 * 5. [2026-09-19 add-asset-library 6.1] 原图 = asset 异步 resolver（loading/ready/missing/soft-deleted
 *     四态，失效显式提示层）；切换 reference 经 releaseObjectUrl 清理；objectURL 走 assetStore 共享缓存。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { baseSpecDiameterMm, gemRadiusPx, pitchPx, type EditGem } from '$lib/engine'
  import { SpatialIndex } from '$lib/edit/spatialIndex'
  import { isDetailedLod, planGemDraws, viewportFromView } from '$lib/edit/renderPlan'
  import { getEditDoc, setSelection, clearSelection, toggleSelection, type DesignerGem } from '$lib/stores/edit.svelte'
  import { getAsset, objectUrlForAsset, releaseObjectUrl } from '$lib/persistence/assetStore'
  import { computeFit } from '../Studio/fit'
  import Plus from '@lucide/svelte/icons/plus'
  import Minus from '@lucide/svelte/icons/minus'
  import Maximize from '@lucide/svelte/icons/maximize'
  import { collectMarqueeItems } from '$lib/designer/selection'
  import { createBrushGesture, type BrushPoint, type BrushTool } from '$lib/designer/brushGesture'
  import { hexSnapPoint } from '$lib/designer/hexSnap'
  import { attachBrushEngine } from '$lib/designer/brushEngine'
  import {
    emitBrushEvent,
    getBrushCursor,
    getBrushRejections,
    getBrushSpec,
    getMarquee,
    getSnap,
    getSnapIndicator,
    getTool,
    setBrushCursor,
    setMarquee,
    setSnapIndicator,
  } from '$lib/designer/workbench.svelte'

  let canvasEl = $state<HTMLCanvasElement | null>(null)
  let wrapEl = $state<HTMLDivElement | null>(null)

  let view = $state({ scale: 1, x: 0, y: 0 })
  let dragging = $state(false)

  const doc = $derived(getEditDoc())

  /** 空间索引：钻集或任一钻位变动时重建（纯 derived，命中/裁剪共用；[1.1 v3] DesignerGem 含 layerId） */
  const index = $derived.by(() => {
    const d = doc
    if (!d) return null
    const idx = new SpatialIndex<DesignerGem>(pitchPx(d.grid))
    for (const g of d.gems) idx.insert(g)
    return idx
  })

  const gemRadius = $derived(doc ? gemRadiusPx(doc.grid) : 1)
  /** LOD 两档：屏幕钻径 ≥ 阈值 → 圆+描边；低于 → 聚合色块点（阈值单一真源在 renderPlan） */
  const detailed = $derived(isDetailedLod(gemRadius * 2, view.scale))

  // ---- 离线缓存层（painting 快照 / blocks 描线；文档替换时重建） ----
  interface CachedLayers {
    key: string
    W: number
    H: number
    paint: HTMLCanvasElement | null
    blockLines: HTMLCanvasElement | null
  }
  let layers = $state<CachedLayers | null>(null)
  let refImg = $state<HTMLImageElement | null>(null)

  // ---- 原图异步 resolver（[add-asset-library 6.1]：loading / ready / missing / soft-deleted 四态）----
  type ReferenceState =
    | { kind: 'none' }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'missing' }
    | { kind: 'soft-deleted' }
  let referenceState = $state<ReferenceState>({ kind: 'none' })
  /** 本轮持有的共享 objectURL（切换 reference / 组件销毁时 releaseObjectUrl 显式释放）。 */
  let heldReferenceUrl: string | null = null
  let referenceResolveSeq = 0

  function releaseHeldReferenceUrl(): void {
    if (heldReferenceUrl) {
      releaseObjectUrl(heldReferenceUrl)
      heldReferenceUrl = null
    }
  }

  /** 只同步读 doc.referenceAssetId（响应式追踪），异步续体经序号防串台。 */
  $effect(() => {
    const referenceAssetId = doc?.referenceAssetId ?? null
    const seq = ++referenceResolveSeq
    releaseHeldReferenceUrl()
    refImg = null
    if (!referenceAssetId) {
      referenceState = { kind: 'none' }
      return
    }
    referenceState = { kind: 'loading' }
    void (async () => {
      const node = await getAsset(referenceAssetId).catch(() => null)
      if (seq !== referenceResolveSeq) return
      if (node === null) {
        referenceState = { kind: 'missing' } // 节点已被硬删（回收站清空）
        return
      }
      if (node.trashedAt !== undefined) {
        referenceState = { kind: 'soft-deleted' } // 在回收站：提示 + 可去回收站找回
        return
      }
      const url = await objectUrlForAsset(referenceAssetId).catch(() => null)
      if (seq !== referenceResolveSeq) {
        if (url) releaseObjectUrl(url) // 迟到结果：立即释放，不入缓存持有
        return
      }
      if (!url) {
        referenceState = { kind: 'missing' } // blob 缺失（浏览器清理过存储）
        return
      }
      heldReferenceUrl = url
      referenceState = { kind: 'ready' }
      const img = new Image()
      img.onload = () => {
        if (seq === referenceResolveSeq) refImg = img
      }
      img.onerror = () => {
        // 解码失败仅丢位图（该层可选），状态保持 ready（URL 本身已解析成功）
      }
      img.src = url
    })()
    return () => {
      // 切换 reference / 组件销毁：释放本轮持有的 objectURL
      if (seq === referenceResolveSeq) releaseHeldReferenceUrl()
    }
  })

  function makeLayer(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    return ctx ? { canvas, ctx } : null
  }

  /** painting 快照 → 底图 canvas；blocks → 边界描线 canvas（复用 labelMap 边界判定手法）。
   *  只写 layers，不读 layers（避免 effect 自反馈；渲染由 redraw effect 追踪读取）。
   *  [6.1] 原图不再进缓存层：改经异步 resolver（referenceState/refImg）独立解析。 */
  $effect(() => {
    const d = doc
    if (!d) {
      layers = null
      return
    }
    const W = d.width
    const H = d.height
    const snap = d.paintingSnapshot
    const blocks = d.blocks
    const key = `${W}x${H}:${blocks.length}`

    const paint = makeLayer(W, H)
    if (paint) paint.ctx.putImageData(new ImageData(new Uint8ClampedArray(snap.data), W, H), 0, 0)

    // blocks 只读参考层：块代表色淡填充 + 边界实线（labelMap 判边界，同 BlockCanvas 手法）
    const lines = makeLayer(W, H)
    if (lines) {
      const label = new Int16Array(W * H).fill(-1)
      blocks.forEach((b, bi) => {
        const bits = b.mask.bits
        const { x, y, w, h } = b.bbox
        for (let dy = 0; dy < h; dy++) {
          const row = (y + dy) * W + x
          for (let dx = 0; dx < w; dx++) {
            if (bits[dy * w + dx] === 1) label[row + dx] = bi
          }
        }
      })
      const img = lines.ctx.createImageData(W, H)
      const px = img.data
      blocks.forEach((b, bi) => {
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
            if (!boundary) continue
            const i = (gy * W + gx) * 4
            px[i] = r
            px[i + 1] = g
            px[i + 2] = bl
            px[i + 3] = 210
          }
        }
      })
      lines.ctx.putImageData(img, 0, 0)
    }

    layers = { key, W, H, paint: paint?.canvas ?? null, blockLines: lines?.canvas ?? null }
  })

  // ---- 取景（fit）----
  let userAdjusted = false
  let fittedKey: string | null = null
  let cssTick = $state(0)

  $effect(() => {
    const l = layers
    if (!l) {
      fittedKey = null
      return
    }
    if (fittedKey !== l.key) {
      fittedKey = l.key
      fitView()
    }
  })

  function fitView(): void {
    const cv = canvasEl
    const d = doc
    if (!cv || !d) return
    const cw = cv.clientWidth || 600
    const ch = cv.clientHeight || 420
    const fit = computeFit(cw, ch, d.width, d.height)
    minScale = Math.max(0.02, fit.scale / 8)
    view = { scale: fit.scale, x: fit.x, y: fit.y }
    userAdjusted = false
  }

  let minScale = 0.05

  function zoomBy(factor: number): void {
    const cv = canvasEl
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    zoomAt(rect.width / 2, rect.height / 2, factor)
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
    if (!cv || !doc) return
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

  /** 点选命中：queryCircle(r=1.5×钻半径) → 最近者入 selection；空白清除 */
  function hitGem(x: number, y: number): EditGem | null {
    const idx = index
    if (!idx) return null
    const r = Math.max(gemRadius * 1.5, 6 / view.scale)
    const candidates = idx.queryCircle(x, y, r)
    let best: EditGem | null = null
    let bestD = Infinity
    for (const c of candidates) {
      const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y)
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    return best
  }

  // ---- 指针交互：工具分派层（C-3.2/3.3）----
  // 平移通道：中键 / 空格+拖 / 触摸单指（select 态）；框选 = 鼠标/笔 select 拖拽；
  // 笔刷 = draw/erase 起笔-move-收笔；双指 pinch（手法同 BlockCanvas）。
  const TAP_SLOP_PX = 8

  /** 空格平移修饰（PS 惯例：空格按住临时切平移） */
  let spaceHeld = $state(false)

  const tool = $derived(getTool())
  const snap = $derived(getSnap())
  const brushCursor = $derived(getBrushCursor())
  const snapIndicator = $derived(getSnapIndicator())
  const marquee = $derived(getMarquee())

  /** 笔刷手势会话：意图流唯一出口（监听方 = [D-5.5] brushEngine / 测试）。 */
  const brush = createBrushGesture(emitBrushEvent)

  /** [D-5.5] 笔刷算法接线（意图流消费：落钻/擦除；卸载退订）。 */
  onMount(() => attachBrushEngine())

  /** 笔刷光标圈半径 = 当前笔刷规格（覆盖态或文档基准派生）——逐钻径换算。 */
  const brushCursorRadius = $derived.by(() => {
    const d = doc
    if (!d) return gemRadius
    const spec = getBrushSpec()
    return gemRadiusPx(
      { shapeId: spec?.shapeId ?? 'round', diameterMm: spec?.diameterMm ?? baseSpecDiameterMm(d.grid) },
      d.grid,
    )
  })
  const brushRejections = $derived(getBrushRejections())

  /** 笔刷落点：画钻 + 格位吸附 → 最近六方格位；擦除恒自由（吸附会漏自由位钻）。 */
  function brushPointFor(p: { x: number; y: number }, t: 'draw' | 'erase', s: 'grid' | 'free'): BrushPoint {
    if (t === 'draw' && s === 'grid' && doc) return hexSnapPoint(p.x, p.y, pitchPx(doc.grid))
    return { x: p.x, y: p.y }
  }

  function updateBrushReadout(p: { x: number; y: number }, t: 'draw' | 'erase', s: 'grid' | 'free'): void {
    const point = brushPointFor(p, t, s)
    setBrushCursor(point)
    setSnapIndicator(t === 'draw' && s === 'grid' && doc ? hexSnapPoint(p.x, p.y, pitchPx(doc.grid)) : null)
  }

  let dragStart = { x: 0, y: 0, vx: 0, vy: 0, moved: false, panOnly: false }
  const activePointers = new Map<number, { x: number; y: number }>()
  let pinchBase: { dist: number; scale: number; x: number; y: number } | null = null

  /** select 态鼠标/笔点选-框选武装（moved 前是潜在 tap；越界 slop 升级为框选） */
  let marqueeDrag: {
    downX: number
    downY: number
    shift: boolean
    moved: boolean
    start: { x: number; y: number }
  } | null = null

  function pinchMetrics(): { midX: number; midY: number; dist: number } | null {
    if (activePointers.size < 2) return null
    const pts = [...activePointers.values()]
    const dx = pts[0].x - pts[1].x
    const dy = pts[0].y - pts[1].y
    return { midX: (pts[0].x + pts[1].x) / 2, midY: (pts[0].y + pts[1].y) / 2, dist: Math.hypot(dx, dy) }
  }

  /** 双指接管：丢弃进行中的框选；笔划收笔（意图流消费方决定弃留）。 */
  function abortGesturesForPinch(): void {
    marqueeDrag = null
    setMarquee(null)
    if (brush.active) brush.end()
  }

  function onPointerDown(e: PointerEvent): void {
    if (!doc) return
    try {
      canvasEl?.setPointerCapture(e.pointerId)
    } catch {
      // jsdom / 未激活指针：捕获失败不阻断手势（事件仍冒泡到画布）
    }
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (activePointers.size === 2) {
      abortGesturesForPinch()
      dragging = false
      const m = pinchMetrics()
      if (m && m.dist > 0) pinchBase = { dist: m.dist, scale: view.scale, x: view.x, y: view.y }
    } else if (activePointers.size === 1) {
      // [redesign 2.x 过渡 seam] 工具面已扩五态（V/B/E/H/Z）：hand → 平移；zoom → 待
      // DesignerCanvas 重写落行（本过渡组件不实现专行手势，保持 select/draw/erase 行为规格）
      const t = tool
      const wantsPan =
        e.button === 1 || spaceHeld || t === 'hand' || (t === 'select' && e.pointerType === 'touch')
      if (wantsPan) {
        dragging = true
        dragStart = {
          x: e.clientX,
          y: e.clientY,
          vx: view.x,
          vy: view.y,
          moved: false,
          panOnly: t === 'hand',
        }
      } else if (t === 'select') {
        marqueeDrag = {
          downX: e.clientX,
          downY: e.clientY,
          shift: e.shiftKey,
          moved: false,
          start: toImageLocal(e.clientX, e.clientY),
        }
      } else if (t === 'draw' || t === 'erase') {
        const brushTool: BrushTool = t
        const p = toImageLocal(e.clientX, e.clientY)
        brush.begin(brushTool, snap, brushPointFor(p, brushTool, snap))
        updateBrushReadout(p, brushTool, snap)
      }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    if (activePointers.size >= 2 && pinchBase) {
      const m = pinchMetrics()
      if (m && pinchBase.dist > 0) {
        const factor = m.dist / pinchBase.dist
        const scale = Math.min(40, Math.max(minScale, pinchBase.scale * factor))
        const cv = canvasEl
        if (cv) {
          const rect = cv.getBoundingClientRect()
          const mx = m.midX - rect.left
          const my = m.midY - rect.top
          userAdjusted = true
          view = {
            scale,
            x: mx - ((mx - pinchBase.x) / pinchBase.scale) * scale,
            y: my - ((my - pinchBase.y) / pinchBase.scale) * scale,
          }
        }
      }
      return
    }

    if (activePointers.size === 0 && (tool === 'draw' || tool === 'erase')) {
      // 悬停读数（无按键）：笔刷光标预览 + 吸附格位高亮
      updateBrushReadout(toImageLocal(e.clientX, e.clientY), tool, snap)
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

    if (marqueeDrag !== null) {
      const dx = e.clientX - marqueeDrag.downX
      const dy = e.clientY - marqueeDrag.downY
      if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) marqueeDrag.moved = true
      if (marqueeDrag.moved) {
        const cur = toImageLocal(e.clientX, e.clientY)
        setMarquee({ x0: marqueeDrag.start.x, y0: marqueeDrag.start.y, x1: cur.x, y1: cur.y })
      }
      return
    }

    if (brush.active) {
      const p = toImageLocal(e.clientX, e.clientY)
      brush.move(brushPointFor(p, brush.intent?.tool ?? 'draw', snap))
      updateBrushReadout(p, brush.intent?.tool ?? 'draw', snap)
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const wasSingle = activePointers.size === 1
    activePointers.delete(e.pointerId)
    if (activePointers.size < 2) pinchBase = null

    if (wasSingle && dragging) {
      dragging = false
      if (!dragStart.moved && !dragStart.panOnly) {
        const p = toImageLocal(e.clientX, e.clientY)
        const hit = hitGem(p.x, p.y)
        if (hit) setSelection([hit.id])
        else clearSelection()
      }
      return
    }
    dragging = false

    if (wasSingle && marqueeDrag !== null) {
      const drag = marqueeDrag
      marqueeDrag = null
      if (drag.moved) {
        const rect = getMarquee()
        setMarquee(null)
        const idx = index
        if (rect && idx) {
          const hits = collectMarqueeItems(idx, rect, gemRadius)
          if (drag.shift) {
            // 加选框选：并入选前集合（命中空则保持原选）
            const next = new Set(doc?.selection ?? [])
            for (const h of hits) next.add(h.id)
            setSelection(next)
          } else if (hits.length > 0) {
            setSelection(hits.map((h) => h.id))
          } else {
            clearSelection()
          }
        }
      } else {
        // tap：Shift 点选加/减选（toggleSelection），普通点选独占
        const p = toImageLocal(e.clientX, e.clientY)
        const hit = hitGem(p.x, p.y)
        if (hit) {
          if (drag.shift) toggleSelection(hit.id)
          else setSelection([hit.id])
        } else if (!drag.shift) {
          clearSelection()
        }
      }
      return
    }
    marqueeDrag = null
    setMarquee(null)

    if (wasSingle && brush.active) brush.end()
  }

  /** 取消（系统打断）：框选丢弃、笔划收笔——不提交选择。 */
  function onPointerCancel(e: PointerEvent): void {
    activePointers.delete(e.pointerId)
    if (activePointers.size < 2) pinchBase = null
    dragging = false
    marqueeDrag = null
    setMarquee(null)
    if (brush.active) brush.end()
  }

  function onPointerLeave(): void {
    dragging = false
    marqueeDrag = null
    setMarquee(null)
    setBrushCursor(null)
    setSnapIndicator(null)
  }

  // 空格平移修饰追踪（松开/失焦复位）
  function trackSpaceDown(e: KeyboardEvent): void {
    if (e.code === 'Space' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) spaceHeld = true
  }
  function trackSpaceUp(e: KeyboardEvent): void {
    if (e.code === 'Space') spaceHeld = false
  }

  // ---- 渲染 ----
  function redraw(): void {
    const cv = canvasEl
    const d = doc
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
    if (!d) return

    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.scale, view.scale)
    ctx.imageSmoothingEnabled = view.scale < 4

    const l = layers
    // [1.1 v3 seam] 四层读面 → underlay 三源态 + 钻石层（分层合成重写归切片 2 DesignerCanvas；
    // 本 seam 保持「隐藏层不渲染」语义：隐藏层钻跳过、层透明度逐层生效）
    const sourceOf = (key: 'painting' | 'reference' | 'blocks') => d.underlay.sources.find((s) => s.key === key)
    const lp = sourceOf('painting')
    const lr = sourceOf('reference')
    const lb = sourceOf('blocks')

    // L1 painting 底图快照
    if (lp?.visible && l?.paint) {
      ctx.globalAlpha = lp.opacity
      ctx.drawImage(l.paint, 0, 0)
    }
    // L2 reference 原图（可选，拉伸到文档尺寸）
    if (lr?.visible && refImg) {
      ctx.globalAlpha = lr.opacity
      ctx.drawImage(refImg, 0, 0, d.width, d.height)
    }
    // L3 blocks 只读描线
    if (lb?.visible && l?.blockLines) {
      ctx.globalAlpha = lb.opacity
      ctx.drawImage(l.blockLines, 0, 0)
    }
    ctx.globalAlpha = 1

    // L4 gems 钻面（视口裁剪 + LOD 两档 + 选中环；逐层透明度、隐藏层跳过）
    if (d.layers.some((layer) => layer.visible)) {
      const idx = index
      if (idx) {
        const vis = viewportFromView(view, cw, ch)
        const visible = idx.queryRect(vis.x0 - gemRadius, vis.y0 - gemRadius, vis.x1 + gemRadius, vis.y1 + gemRadius)
        for (const layer of d.layers) {
          if (!layer.visible) continue
          const members = visible.filter((g) => g.layerId === layer.id)
          if (members.length === 0) continue
          ctx.globalAlpha = layer.opacity ?? 1
          if (detailed) {
            const ops = planGemDraws(members, d.palette, { gemRadius, detailed: true })
            const strokeW = Math.max(gemRadius * 0.1, 0.5 / view.scale)
            for (const op of ops) {
              if (op.kind !== 'circle') continue
              ctx.fillStyle = op.color
              ctx.beginPath()
              ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2)
              ctx.fill()
              ctx.strokeStyle = 'rgba(0,0,0,0.28)'
              ctx.lineWidth = strokeW
              ctx.stroke()
            }
          } else {
            const ops = planGemDraws(members, d.palette, { gemRadius, detailed: false })
            for (const op of ops) {
              if (op.kind !== 'rect') continue
              ctx.fillStyle = op.color
              ctx.fillRect(op.x, op.y, op.s, op.s)
            }
          }
        }
        ctx.globalAlpha = 1

        // 选中环（仅可见层的可见钻）
        if (d.selection.size > 0) {
          const layerVisibleById = new Map(d.layers.map((layer) => [layer.id, layer.visible] as const))
          const byId = new Map(d.gems.map((g) => [g.id, g] as const))
          ctx.strokeStyle = '#0284C7'
          ctx.lineWidth = 2 / view.scale
          for (const id of d.selection) {
            const g = byId.get(id)
            if (!g) continue
            if (layerVisibleById.get(g.layerId) === false) continue
            if (g.x < vis.x0 || g.x > vis.x1 || g.y < vis.y0 || g.y > vis.y1) continue
            ctx.beginPath()
            ctx.arc(g.x, g.y, gemRadius * 1.4, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
      }
    }

    // ---- 覆盖层：框选矩形 / 吸附格位高亮 / 笔刷光标（C-3.2/3.3；读取 workbench $state）----
    const rect = marquee
    if (rect) {
      const loX = Math.min(rect.x0, rect.x1)
      const hiX = Math.max(rect.x0, rect.x1)
      const loY = Math.min(rect.y0, rect.y1)
      const hiY = Math.max(rect.y0, rect.y1)
      ctx.fillStyle = 'rgba(2,132,199,0.08)'
      ctx.fillRect(loX, loY, hiX - loX, hiY - loY)
      ctx.strokeStyle = '#0284C7'
      ctx.lineWidth = 1 / view.scale
      ctx.setLineDash([4 / view.scale, 3 / view.scale])
      ctx.strokeRect(loX, loY, hiX - loX, hiY - loY)
      ctx.setLineDash([])
    }
    const indicator = snapIndicator
    if (indicator) {
      // 吸附格位高亮：格位圈（虚线）+ 格心点
      ctx.strokeStyle = 'rgba(2,132,199,0.9)'
      ctx.lineWidth = 1 / view.scale
      ctx.setLineDash([3 / view.scale, 2 / view.scale])
      ctx.beginPath()
      ctx.arc(indicator.x, indicator.y, gemRadius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(2,132,199,0.9)'
      ctx.beginPath()
      ctx.arc(indicator.x, indicator.y, Math.max(gemRadius * 0.12, 1 / view.scale), 0, Math.PI * 2)
      ctx.fill()
    }
    const cursorPoint = brushCursor
    if (cursorPoint && (tool === 'draw' || tool === 'erase')) {
      // 笔刷光标预览：画钻 = 当前笔刷规格半径圈；擦除 = 破坏性红圈
      const erase = tool === 'erase'
      ctx.strokeStyle = erase ? 'rgba(220,38,38,0.9)' : 'rgba(15,23,42,0.75)'
      ctx.lineWidth = 1.5 / view.scale
      ctx.beginPath()
      ctx.arc(cursorPoint.x, cursorPoint.y, erase ? gemRadius : brushCursorRadius, 0, Math.PI * 2)
      ctx.stroke()
    }
    // ---- [D-5.5] 冲突拒画闪红：被拒落点红 X（起笔清零；逐笔重绘）----
    if (brushRejections.length > 0) {
      ctx.strokeStyle = 'rgba(220,38,38,0.95)'
      ctx.lineWidth = 2 / view.scale
      const arm = Math.max(gemRadius * 0.5, 2 / view.scale)
      for (const p of brushRejections) {
        ctx.beginPath()
        ctx.moveTo(p.x - arm, p.y - arm)
        ctx.lineTo(p.x + arm, p.y + arm)
        ctx.moveTo(p.x + arm, p.y - arm)
        ctx.lineTo(p.x - arm, p.y + arm)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  // 视口/钻集/选中/图层/缓存层 → 重绘（redraw 内部读取的响应式状态均被本 effect 追踪）
  $effect(() => {
    void view.scale
    void view.x
    void view.y
    void dragging
    void canvasEl
    void cssTick
    redraw()
  })

  // 容器尺寸跟随（jsdom 无 ResizeObserver 时退化为 window resize）
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

  // 容器 resize → 未手动取景时重算 fit
  let lastBox = { w: 0, h: 0 }
  $effect(() => {
    void cssTick
    const cv = canvasEl
    if (!cv || !doc) return
    const w = cv.clientWidth
    const h = cv.clientHeight
    if (w <= 0 || h <= 0) return
    if (w !== lastBox.w || h !== lastBox.h) {
      lastBox = { w, h }
      if (!userAdjusted) fitView()
    }
  })

  const cursor = $derived(
    dragging
      ? 'grabbing'
      : spaceHeld || tool === 'hand'
        ? 'grab'
        : tool === 'zoom'
          ? 'zoom-in'
          : tool === 'select'
            ? 'default'
            : 'crosshair',
  )
</script>

<svelte:window onkeydown={trackSpaceDown} onkeyup={trackSpaceUp} />

{#if doc}
  <div
    bind:this={wrapEl}
    class="relative h-full min-h-0 w-full overflow-hidden rounded-xl border bg-card"
    data-testid="edit-canvas"
  >
    <canvas
      bind:this={canvasEl}
      class="block h-full w-full touch-none select-none"
      style="cursor: {cursor}"
      onwheel={onWheel}
      ondblclick={() => fitView()}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerCancel}
      onpointerleave={onPointerLeave}
      data-testid="edit-canvas-canvas"
    ></canvas>

    <div class="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg border bg-background/85 p-1 shadow-sm backdrop-blur">
      <Button size="icon-xs" variant="ghost" title="适应窗口（双击画布同效）" onclick={() => fitView()}>
        <Maximize />
      </Button>
      <Button size="icon-xs" variant="ghost" title="放大" onclick={() => zoomBy(1.25)}>
        <Plus />
      </Button>
      <Button size="icon-xs" variant="ghost" title="缩小" onclick={() => zoomBy(0.8)}>
        <Minus />
      </Button>
      <span class="text-muted-foreground px-1 font-mono text-xs tabular-nums" data-testid="edit-canvas-zoom">
        {Math.round(view.scale * 100)}%
      </span>
    </div>

    <!-- [6.1] 原图失效层：显式提示（非静默空层）；soft-deleted 提示可去回收站 -->
    {#if referenceState.kind === 'missing' || referenceState.kind === 'soft-deleted'}
      <div
        class="text-destructive absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-destructive/30 bg-background/90 px-2.5 py-1 text-[11px] shadow-sm backdrop-blur"
        data-testid="edit-reference-state"
      >
        {#if referenceState.kind === 'soft-deleted'}
          原图已在回收站——可在素材库的回收站中找回后自动恢复显示
        {:else}
          原图素材已缺失（已从素材库删除），参考层不可用
        {/if}
      </div>
    {:else if referenceState.kind === 'loading'}
      <div
        class="text-muted-foreground absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border bg-background/85 px-2.5 py-1 text-[11px] shadow-sm backdrop-blur"
        data-testid="edit-reference-loading"
      >
        正在解析原图…
      </div>
    {/if}

    <div
      class="absolute right-3 bottom-3 z-10 rounded-md bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm"
    >
      <span class="hidden lg:inline">滚轮缩放 · 拖拽平移 · 点击选中钻</span>
      <span class="lg:hidden">单指平移 · 双指缩放 · 双击适应</span>
    </div>
  </div>
{/if}
