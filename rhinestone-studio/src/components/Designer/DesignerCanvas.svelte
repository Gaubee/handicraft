<!--
 * DesignerCanvas.svelte——设计师工作台画布（design §1.2「画布（居中）」+ §7.4 EditCanvas 重写）。
 *
 * Orthogonal intents (max 5):
 * 1. [2026-09-21 redesign-designer-workbench 2.x] 分层合成画布：参考底层（三源独立
 *    visible/opacity——doc.underlay，1.x 内存面显示态消费）→ 钻石层（按层序合成、隐藏层跳过、
 *    逐层透明度）+ 交互反馈层（框选矩形/吸附格位高亮/笔刷光标/冲突拒画闪红/选中环/
 *    P5 拖移 ghost；[3.x P6-P7] 变换手柄经 DesignerTransformHandles 覆盖层接线）。
 * 2. [视图导航（行为规格继承 EditCanvas；design §1.2「光标锚缩放」经验复用；3.x P8-P12
 *    升级到规格）] 滚轮光标锚缩放（档位 [10%,1600%]）/ 双指 pinch 质心锚 / 中键·空格·抓手
 *    工具平移 / 双击两态（钻=属性定位、空白=100%⇄适配）/ 缩放工具=点击放大·Alt+点击
 *    缩小·拖框放大区域。视口态入 lib/designer/viewport 真源（状态栏读数 + 命令宿主注册
 *    ——⌘+/-/0/1 经命令总线转发到画布单源）。
 * 3. [工具分派（design §1.2 五工具）] 选择：点选+Shift 加减选+框选（marquee 相交命中 →
 *    setSelection）；[3.x P1-P4] 锁定层钻不可选中/框选跳过（隐藏层同口径）；
 *    [3.x P5] 钻上起拖 = 选集拖移（预览 ghost+Δ读数，松手单 patch 单 undo 组；Shift 轴
 *    约束；Alt 起拖 = 复制并拖副本——副本归当前层 origin='manual' blockId=null moved 重置；
 *    Esc 经取消注册表丢弃）；画笔/橡皮：起笔-move-收笔意图流（emitBrushEvent 出口，
 *    brushEngine 消费落钻/擦除——一笔单 undo 组；[3.1] 橡皮跳过锁定/隐藏层钻、custom 形
 *    missing-asset 拒画报错条）；指针读数随 move 写 workbench 真源。
 *    [8.1 触摸手势映射（design §1.4——决策核纯函数化 lib/designer/touchGestures）]：
 *    单指 = 当前工具行为（singleTouchDispatch——触摸不再平移劫持 select；hand = 平移）、
 *    双指捏合 = 缩放 + 双指拖动 = 平移（twoFingerDecision 合成视口——质心锚缩放，span
 *    不变退化为平移；档位夹取 clampZoomScale 与滚轮同源）、长按 = 上下文菜单
 *    （longPressDecision ≥500ms 且累计位移 ≤8px——接既有 DesignerContextMenu 两态树，
 *    与右键 P13/P14 同源命中裁决；触发时丢弃进行中手势武装，抬指不吃 tap 语义）。
 * 4. [Guard] jsdom 无 2d 上下文：全部 ctx 路径 null 守卫，挂载冒烟与浏览器渲染同构。
 * 5. [add-asset-library 6.1 迁移] 原图 = asset 异步 resolver（loading/ready/missing/soft-deleted
 *    四态，失效显式提示层）；切换 reference 经 releaseObjectUrl 清理；objectURL 走共享缓存。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { baseSpecDiameterMm, gemRadiusPx, pitchPx, type EditGem } from '$lib/engine'
  import { SpatialIndex } from '$lib/edit/spatialIndex'
  import { isDetailedLod, planGemDraws, viewportFromView } from '$lib/edit/renderPlan'
  import { getEditDoc, setSelection, clearSelection, toggleSelection, applyPatch, nextManualId, type DesignerGem } from '$lib/stores/edit.svelte'
  import { getAsset, objectUrlForAsset, releaseObjectUrl } from '$lib/persistence/assetStore'
  import { computeFit } from '../Studio/fit'
  import DesignerTransformHandles from './DesignerTransformHandles.svelte'
  import DesignerContextMenu from './DesignerContextMenu.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import Minus from '@lucide/svelte/icons/minus'
  import Maximize from '@lucide/svelte/icons/maximize'
  import { collectMarqueeItems } from '$lib/designer/selection'
  import { createMoveDragSession, selectabilityFilter } from '$lib/designer/gestures'
  import {
    getMovePreview,
    registerGestureCancel,
    setMovePreview,
    setPropertiesFocus,
  } from '$lib/designer/interaction.svelte'
  import { currentLayerIdOf } from '$lib/designer/workbench.svelte'
  import { createBrushGesture, type BrushPoint, type BrushTool } from '$lib/designer/brushGesture'
  import { hexSnapPoint } from '$lib/designer/hexSnap'
  import { attachBrushEngine, brushSnapPitchPx } from '$lib/designer/brushEngine'
  import { getViewState, setViewState, setViewportHost, clampZoomScale, type CanvasView } from '$lib/designer/viewport.svelte'
  import {
    LONG_PRESS_MS,
    longPressDecision,
    singleTouchDispatch,
    twoFingerDecision,
    type TwoFingerSample,
  } from '$lib/designer/touchGestures'
  import {
    emitBrushEvent,
    getBrushCursor,
    getBrushError,
    getBrushRejections,
    getBrushSpec,
    getMarquee,
    getPointer,
    getSnap,
    getSnapIndicator,
    getTool,
    setBrushCursor,
    setMarquee,
    setPointer,
    setSnapIndicator,
  } from '$lib/designer/workbench.svelte'

  let canvasEl = $state<HTMLCanvasElement | null>(null)
  let wrapEl = $state<HTMLDivElement | null>(null)

  let dragging = $state(false)

  const doc = $derived(getEditDoc())
  /** 视口态真源在 viewport 模块（状态栏缩放比共读；画布唯一写者）。 */
  const view = $derived(getViewState())

  /** 空间索引：钻集或任一钻位变动时重建（纯 derived，命中/裁剪共用；DesignerGem 含 layerId） */
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

  // ---- 原图异步 resolver（loading / ready / missing / soft-deleted 四态）----
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
   *  原图不进缓存层：经异步 resolver（referenceState/refImg）独立解析。 */
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
    if (paint) {
      // [5.1 空白起步] 快照尺寸 ≠ 画幅（空白起步文档 painting 为 1×1 透明占位）→ 透明兜底
      // 不抛 ImageData 长度错（真实浏览器会 throw；尺寸不符 = 无 painting 载荷的规范形态）。
      const snapData =
        snap.width === W && snap.height === H ? snap.data : new Uint8ClampedArray(W * H * 4)
      paint.ctx.putImageData(new ImageData(new Uint8ClampedArray(snapData), W, H), 0, 0)
    }

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
    setViewState({ scale: fit.scale, x: fit.x, y: fit.y })
    userAdjusted = false
  }

  function zoomBy(factor: number): void {
    const cv = canvasEl
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    zoomAt(rect.width / 2, rect.height / 2, factor)
  }

  /** 缩放至指定比例（画布中心锚——⌘1/P8 双击/菜单 100% 共用）。 */
  function zoomToScale(target: number): void {
    zoomBy(target / getViewState().scale)
  }

  function zoomAt(mx: number, my: number, factor: number): void {
    const current = getViewState()
    // 档位值域 [10%, 1600%]（design §2 P10——滚轮/工具/键盘统一；fit 独立取景不受限）
    const scale = clampZoomScale(current.scale * factor)
    userAdjusted = true
    setViewState({
      scale,
      x: mx - ((mx - current.x) / current.scale) * scale,
      y: my - ((my - current.y) / current.scale) * scale,
    })
  }

  /** 缩放工具拖框放大（P12）：框域 contain 取景居中（留 15% 边）。 */
  function zoomToRect(rect: { x0: number; y0: number; x1: number; y1: number }): void {
    const cv = canvasEl
    if (!cv) return
    const loX = Math.min(rect.x0, rect.x1)
    const hiX = Math.max(rect.x0, rect.x1)
    const loY = Math.min(rect.y0, rect.y1)
    const hiY = Math.max(rect.y0, rect.y1)
    const w = hiX - loX
    const h = hiY - loY
    if (!(w > 0 && h > 0)) return
    const cw = cv.clientWidth || 600
    const ch = cv.clientHeight || 420
    const scale = clampZoomScale(Math.min((cw * 0.85) / w, (ch * 0.85) / h))
    const cx = (loX + hiX) / 2
    const cy = (loY + hiY) / 2
    userAdjusted = true
    setViewState({ scale, x: cw / 2 - cx * scale, y: ch / 2 - cy * scale })
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
    const v = getViewState()
    if (!cv) return { x: 0, y: 0 }
    const rect = cv.getBoundingClientRect()
    return {
      x: (clientX - rect.left - v.x) / v.scale,
      y: (clientY - rect.top - v.y) / v.scale,
    }
  }

  /** 点选命中：queryCircle(r=1.5×钻半径) → 最近者入 selection；空白清除。
   *  [P1/P4 3.x] 锁定层钻不可选中（视为空白）；隐藏层不渲染故不可选——统一走可选性谓词。 */
  function hitGem(x: number, y: number): EditGem | null {
    const idx = index
    const d = doc
    if (!idx || !d) return null
    const selectable = selectabilityFilter(d.layers)
    const v = getViewState()
    const r = Math.max(gemRadius * 1.5, 6 / v.scale)
    const candidates = idx.queryCircle(x, y, r)
    let best: EditGem | null = null
    let bestD = Infinity
    for (const c of candidates) {
      if (!selectable(c)) continue
      const d2 = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y)
      if (d2 < bestD) {
        bestD = d2
        best = c
      }
    }
    return best
  }

  // ---- 指针交互：工具分派层（design §1.2 五工具）----
  // 平移通道：中键 / 空格+拖 / 抓手工具 / 触摸单指（select 态）；框选 = 鼠标/笔 select 拖拽；
  // 笔刷 = draw/erase 起笔-move-收笔；缩放工具 = 点击放大/Alt 点击缩小（拖框归交互核切片）；
  // 双指 pinch（手法同 BlockCanvas）。
  const TAP_SLOP_PX = 8

  /** 空格平移修饰（PS 惯例：空格按住临时切平移，松开回原工具——design §3.1） */
  let spaceHeld = $state(false)

  const tool = $derived(getTool())
  const snap = $derived(getSnap())
  const brushCursor = $derived(getBrushCursor())
  const snapIndicator = $derived(getSnapIndicator())
  const marquee = $derived(getMarquee())
  const movePreview = $derived(getMovePreview())

  /** 笔刷手势会话：意图流唯一出口（监听方 = brushEngine / 测试）。 */
  const brush = createBrushGesture(emitBrushEvent)

  /** 笔刷算法接线（意图流消费：落钻/擦除；卸载退订）。 */
  onMount(() => attachBrushEngine())

  /** 视图命令宿主注册（P9-P12：⌘+/-/0/1、菜单、双击切换经 viewport 模块转发到画布单源）。 */
  onMount(() => {
    setViewportHost({ fit: fitView, zoomStep: zoomBy, zoomTo: zoomToScale })
    return () => setViewportHost(null)
  })

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
  /** [3.1] missing-asset 拒画报错读数（起笔清零；画布顶部错误条显示）。 */
  const brushError = $derived(getBrushError())

  /** 笔刷落点：画钻 + 格位吸附 → 最近六方格位（[3.2] pitch 随当前规格重算——design §6.1：
   *  格位 = 当前规格 pitch 六方格位；规格径+gap×px/mm，基准派生态与 pitchPx(grid) 逐位相等）；
   *  擦除恒自由（吸附会漏自由位钻）。 */
  function brushPointFor(p: { x: number; y: number }, t: 'draw' | 'erase', s: 'grid' | 'free'): BrushPoint {
    if (t === 'draw' && s === 'grid' && doc) return hexSnapPoint(p.x, p.y, brushSnapPitchPx(doc))
    return { x: p.x, y: p.y }
  }

  function updateBrushReadout(p: { x: number; y: number }, t: 'draw' | 'erase', s: 'grid' | 'free'): void {
    const point = brushPointFor(p, t, s)
    setBrushCursor(point)
    setSnapIndicator(t === 'draw' && s === 'grid' && doc ? hexSnapPoint(p.x, p.y, brushSnapPitchPx(doc)) : null)
  }

  let dragStart = { x: 0, y: 0, vx: 0, vy: 0, moved: false, panOnly: false }
  const activePointers = new Map<number, { x: number; y: number }>()
  /** [8.1 双指两态] base 两指样本（client 坐标——决策时与 current 同一 rect 换算局部）+ base 视口。 */
  let pinchBase: { sample: { p0: { x: number; y: number }; p1: { x: number; y: number } }; view: CanvasView } | null = null
  /** [8.1 长按] 待决长按（触摸单指起按；move 累计位移，超时经 longPressDecision 纯判定）。 */
  let longPress: {
    pointerId: number
    startX: number
    startY: number
    movedPx: number
    timer: ReturnType<typeof setTimeout>
  } | null = null
  /** 长按已触发菜单：本次抬指不吃 tap 语义（不清选集/不点选/不提交武装）。 */
  let longPressFired = false

  /** select 态武装（P1-P5）：blank 起 = marquee/空白 tap；钻上起 = 拖移（moved 前潜在 tap：
   *  Shift=加减选，普通=点选替换）；alt 按下起拖 = 复制并拖副本（会话期锁定）。 */
  let marqueeDrag: {
    downX: number
    downY: number
    shift: boolean
    alt: boolean
    moved: boolean
    start: { x: number; y: number }
    mode: 'marquee' | 'move'
    gemId: string | null
  } | null = null

  /** P5 拖移会话（松手单 patch；预览态写 interaction 模块；Esc/打断经取消注册表）。 */
  const moveSession = createMoveDragSession({
    applyPatch,
    setSelection,
    nextId: nextManualId,
    currentLayerId: () => currentLayerIdOf(getEditDoc()),
    onPreview: setMovePreview,
  })
  let unregisterMoveCancel: (() => void) | null = null

  function armMoveCancel(): void {
    if (unregisterMoveCancel === null) {
      unregisterMoveCancel = registerGestureCancel(() => moveSession.cancel())
    }
  }

  function disarmMoveCancel(): void {
    unregisterMoveCancel?.()
    unregisterMoveCancel = null
    setMovePreview(null)
  }

  /** zoom 态武装（P12：slop 内 up = 点击缩放放大一档 / Alt 缩小一档；越 slop = 拖框放大区域）。 */
  let zoomClick: { x: number; y: number; alt: boolean; moved: boolean; imgStart: { x: number; y: number } } | null = null

  /** 双指接管（[8.1] 与长按菜单共用）：丢弃进行中的框选/点击武装；笔划收笔（意图流消费方决定弃留）。 */
  function abortActiveGestures(): void {
    marqueeDrag = null
    zoomClick = null
    setMarquee(null)
    if (brush.active) brush.end()
  }

  // ---- [8.1 长按 = 上下文菜单]（design §1.4；决策核 longPressDecision 纯函数）----

  function clearLongPress(): void {
    if (longPress !== null) {
      clearTimeout(longPress.timer)
      longPress = null
    }
  }

  function startLongPress(e: PointerEvent): void {
    clearLongPress()
    longPressFired = false
    longPress = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      movedPx: 0,
      timer: setTimeout(() => {
        const lp = longPress
        longPress = null
        if (lp === null || activePointers.size !== 1 || !activePointers.has(lp.pointerId)) return
        if (longPressDecision(LONG_PRESS_MS, lp.movedPx) !== 'context-menu') return
        longPressFired = true
        // 与双指接管同式：丢弃工具手势武装，开两态菜单（命中裁决与右键 P13/P14 同源）
        abortActiveGestures()
        dragging = false
        const cur = activePointers.get(lp.pointerId)!
        openContextMenuAtClient(cur.x, cur.y)
      }, LONG_PRESS_MS),
    }
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
      // [8.1] 双指接管：长按计时作废 + 工具手势武装丢弃 + 双指两态 base 立样
      clearLongPress()
      abortActiveGestures()
      dragging = false
      const pts = [...activePointers.values()]
      pinchBase = {
        sample: { p0: { x: pts[0].x, y: pts[0].y }, p1: { x: pts[1].x, y: pts[1].y } },
        view: { ...view },
      }
    } else if (activePointers.size === 1) {
      const t = tool
      const touch = e.pointerType === 'touch'
      // [8.1 单指 = 当前工具行为]（design §1.4）：触摸经 singleTouchDispatch 纯映射——
      // hand = 平移（工具本体），其余 = 工具行为（不再平移劫持 select）；鼠标中键/空格同旧。
      const touchPan = touch && singleTouchDispatch(t).kind === 'pan'
      // [8.1 长按 = 上下文菜单]：触摸主键起按计时（move 累计位移、双指/抬指/取消作废）
      if (touch && e.button === 0) startLongPress(e)
      const wantsPan = e.button === 1 || spaceHeld || t === 'hand' || touchPan
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
        if (e.button === 2) {
          // 右键不武装选择手势（contextmenu 接线消费——P13/P14）
        } else {
          const p = toImageLocal(e.clientX, e.clientY)
          const hit = hitGem(p.x, p.y)
          if (hit !== null) {
            // 钻上起：非 Shift 点选即时替换（拖移即时生效——PS 惯例）；Shift 延迟到 tap/拖起
            if (!e.shiftKey && !doc.selection.has(hit.id)) setSelection([hit.id])
            marqueeDrag = {
              downX: e.clientX,
              downY: e.clientY,
              shift: e.shiftKey,
              alt: e.altKey,
              moved: false,
              start: p,
              mode: 'move',
              gemId: hit.id,
            }
          } else {
            marqueeDrag = {
              downX: e.clientX,
              downY: e.clientY,
              shift: e.shiftKey,
              alt: e.altKey,
              moved: false,
              start: p,
              mode: 'marquee',
              gemId: null,
            }
          }
        }
      } else if (t === 'zoom') {
        zoomClick = {
          x: e.clientX,
          y: e.clientY,
          alt: e.altKey,
          moved: false,
          imgStart: toImageLocal(e.clientX, e.clientY),
        }
      } else {
        // t === 'draw' | 'erase'
        const brushTool: BrushTool = t
        const p = toImageLocal(e.clientX, e.clientY)
        brush.begin(brushTool, snap, brushPointFor(p, brushTool, snap))
        updateBrushReadout(p, brushTool, snap)
      }
      setPointer(toImageLocal(e.clientX, e.clientY))
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    // [8.1 长按] 累计位移（只增不减——漂移回位不复活长按）
    if (longPress !== null && longPress.pointerId === e.pointerId) {
      const moved = Math.hypot(e.clientX - longPress.startX, e.clientY - longPress.startY)
      if (moved > longPress.movedPx) longPress.movedPx = moved
    }

    if (activePointers.size >= 2 && pinchBase) {
      // [8.1 双指两态]（决策核 twoFingerDecision 纯函数）：捏合缩放（质心锚 + 档位夹取）/
      // 拖动平移（span 不变质心位移）同一公式合成；base/current 同一 rect 换算画布局部。
      const cv = canvasEl
      if (cv) {
        const rect = cv.getBoundingClientRect()
        const pts = [...activePointers.values()]
        const base = pinchBase
        const toLocal = (p: { x: number; y: number }): { x: number; y: number } => ({
          x: p.x - rect.left,
          y: p.y - rect.top,
        })
        const decision = twoFingerDecision(
          { p0: toLocal(base.sample.p0), p1: toLocal(base.sample.p1) } satisfies TwoFingerSample,
          { p0: toLocal(pts[0]), p1: toLocal(pts[1]) } satisfies TwoFingerSample,
          base.view,
        )
        userAdjusted = true
        setViewState(decision.view)
      }
      return
    }

    // 指针读数真源（任意工具；hover/拖拽均随动——状态栏/手势层共用）
    setPointer(toImageLocal(e.clientX, e.clientY))

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
        setViewState({ ...view, x: dragStart.vx + dx, y: dragStart.vy + dy })
      }
      return
    }

    if (marqueeDrag !== null) {
      const dx = e.clientX - marqueeDrag.downX
      const dy = e.clientY - marqueeDrag.downY
      if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) marqueeDrag.moved = true
      if (marqueeDrag.moved) {
        if (marqueeDrag.mode === 'move') {
          // P5 拖移：越 slop 起会话（Shift 拖起未选钻先并入选集）；逐帧决策（轴约束/吸附）
          if (!moveSession.active) {
            const d = doc
            if (d !== null) {
              if (marqueeDrag.shift && marqueeDrag.gemId !== null && !d.selection.has(marqueeDrag.gemId)) {
                const next = new Set(d.selection)
                next.add(marqueeDrag.gemId)
                setSelection(next)
              }
              const byId = new Map(d.gems.map((g) => [g.id, g] as const))
              const selected: DesignerGem[] = []
              for (const id of d.selection) {
                const gem = byId.get(id)
                if (gem) selected.push(gem)
              }
              armMoveCancel()
              moveSession.start({
                selected,
                grabbedId: marqueeDrag.gemId,
                alt: marqueeDrag.alt,
                snapMode: snap,
                pitch: brushSnapPitchPx(d), // [3.2] 拖移吸附随当前规格 pitch（§2 P5 同源）
              })
            }
          }
          const cur = toImageLocal(e.clientX, e.clientY)
          moveSession.update(cur.x - marqueeDrag.start.x, cur.y - marqueeDrag.start.y, e.shiftKey)
          return
        }
        const cur = toImageLocal(e.clientX, e.clientY)
        setMarquee({ x0: marqueeDrag.start.x, y0: marqueeDrag.start.y, x1: cur.x, y1: cur.y })
      }
      return
    }

    if (zoomClick !== null) {
      const dx = e.clientX - zoomClick.x
      const dy = e.clientY - zoomClick.y
      if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) zoomClick.moved = true
      if (zoomClick.moved) {
        // 拖框放大区域（P12）：框域读数复用 marquee 视觉（虚线矩形）
        const cur = toImageLocal(e.clientX, e.clientY)
        setMarquee({
          x0: zoomClick.imgStart.x,
          y0: zoomClick.imgStart.y,
          x1: cur.x,
          y1: cur.y,
        })
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
    clearLongPress()

    if (longPressFired) {
      // [8.1 长按] 菜单已开：本次抬指不吃 tap 语义（不清选集/不点选/不提交武装）
      longPressFired = false
      dragging = false
      marqueeDrag = null
      zoomClick = null
      setMarquee(null)
      disarmMoveCancel()
      if (brush.active) brush.end()
      return
    }

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

    if (wasSingle && zoomClick !== null) {
      const click = zoomClick
      zoomClick = null
      if (!click.moved) {
        // 缩放工具点击：放大一档；Alt+点击 = 缩小一档（PS 惯例）
        const cv = canvasEl
        if (cv) {
          const rect = cv.getBoundingClientRect()
          zoomAt(e.clientX - rect.left, e.clientY - rect.top, click.alt || e.altKey ? 0.8 : 1.25)
        }
      } else {
        // 拖框放大该区域（P12）
        const rect = getMarquee()
        setMarquee(null)
        if (rect) zoomToRect(rect)
      }
      return
    }

    if (wasSingle && marqueeDrag !== null) {
      const drag = marqueeDrag
      marqueeDrag = null
      if (drag.mode === 'move' && drag.moved) {
        // P5 松手单 patch（移动=单 update；Alt 复制=单 add+选集切副本）；一个 undo 组
        disarmMoveCancel()
        moveSession.commit()
        return
      }
      if (drag.moved) {
        const rect = getMarquee()
        setMarquee(null)
        const idx = index
        if (rect && idx) {
          // [P4 3.x] 仅收集未锁定且可见层的钻（selectabilityFilter 同 P1 口径）
          const selectable = selectabilityFilter(doc?.layers ?? [])
          const hits = collectMarqueeItems(idx, rect, gemRadius).filter(selectable)
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
      } else if (drag.mode === 'move') {
        // 钻上 tap：Shift 加/减选；普通点选已在 down 即时替换（幂等重设）
        if (drag.shift && drag.gemId !== null) toggleSelection(drag.gemId)
        else if (!drag.shift && drag.gemId !== null) setSelection([drag.gemId])
      } else {
        // 空白 tap：清空选集（Shift 点空白不改选择）
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
    zoomClick = null
    setMarquee(null)
    disarmMoveCancel()

    if (wasSingle && brush.active) brush.end()
  }

  /**
   * P8 双击两态：钻上 = 属性面板定位（选该钻 + 焦点信号——视图滚动到字段并高亮）；
   * 空白 = 视图切换 100% ⇄ 适配画幅（design §2 P8/P9）。
   */
  function onDblClick(e: MouseEvent): void {
    if (!doc) return
    const p = toImageLocal(e.clientX, e.clientY)
    const hit = hitGem(p.x, p.y)
    if (hit !== null) {
      if (doc.selection.size !== 1 || !doc.selection.has(hit.id)) setSelection([hit.id])
      setPropertiesFocus(hit.id)
      return
    }
    if (Math.abs(getViewState().scale - 1) < 1e-6) fitView()
    else zoomToScale(1)
  }

  // ---- P13/P14 右键上下文菜单（原生 contextmenu 接线；两态由命中裁决）----
  let contextMenu = $state<{ x: number; y: number; kind: 'selection' | 'blank' } | null>(null)

  /** 两态菜单打开（命中裁决单实现）：钻上 = 选中态树（未选先选它——PS 惯例）；空白 = 空态树。
   *  [8.1] 长按菜单与右键同源经本入口（design §1.4「长按 = 右键上下文菜单」）。 */
  function openContextMenuAtClient(clientX: number, clientY: number): void {
    if (!doc) return
    const cv = canvasEl
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    const p = toImageLocal(clientX, clientY)
    const hit = hitGem(p.x, p.y)
    if (hit !== null) {
      // P13：右键未选钻 → 先选它（PS 惯例——选中态树以选集为准）
      if (!doc.selection.has(hit.id)) setSelection([hit.id])
      contextMenu = { x: clientX - rect.left, y: clientY - rect.top, kind: 'selection' }
    } else {
      // P14：空白右键 → 空态树；现选集保持（不清空、不丢弃）
      contextMenu = { x: clientX - rect.left, y: clientY - rect.top, kind: 'blank' }
    }
  }

  function onContextMenu(e: MouseEvent): void {
    if (!doc) return
    e.preventDefault()
    openContextMenuAtClient(e.clientX, e.clientY)
  }

  /** 取消（系统打断）：框选/点击武装丢弃、拖移/笔划丢弃、长按计时作废——不提交任何 patch。 */
  function onPointerCancel(e: PointerEvent): void {
    activePointers.delete(e.pointerId)
    if (activePointers.size < 2) pinchBase = null
    dragging = false
    marqueeDrag = null
    zoomClick = null
    setMarquee(null)
    clearLongPress()
    longPressFired = false
    disarmMoveCancel()
    moveSession.cancel()
    if (brush.active) brush.end()
  }

  function onPointerLeave(): void {
    dragging = false
    marqueeDrag = null
    zoomClick = null
    setMarquee(null)
    clearLongPress()
    longPressFired = false
    disarmMoveCancel()
    moveSession.cancel()
    setBrushCursor(null)
    setSnapIndicator(null)
    setPointer(null)
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
    // 参考底层三源合成（design §4.2：每源独立 visible/opacity——源级态直接消费）
    const sourceOf = (key: 'painting' | 'reference' | 'blocks') => d.underlay.sources.find((s) => s.key === key)
    const lp = sourceOf('painting')
    const lr = sourceOf('reference')
    const lb = sourceOf('blocks')

    // 源 1 painting 底图快照
    if (lp?.visible && l?.paint) {
      ctx.globalAlpha = lp.opacity
      ctx.drawImage(l.paint, 0, 0)
    }
    // 源 2 reference 原图（可选，拉伸到文档尺寸）
    if (lr?.visible && refImg) {
      ctx.globalAlpha = lr.opacity
      ctx.drawImage(refImg, 0, 0, d.width, d.height)
    }
    // 源 3 blocks 只读描线
    if (lb?.visible && l?.blockLines) {
      ctx.globalAlpha = lb.opacity
      ctx.drawImage(l.blockLines, 0, 0)
    }
    ctx.globalAlpha = 1

    // 钻石层（视口裁剪 + LOD 两档 + 选中环；按层序合成、隐藏层跳过、逐层透明度）
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

        // 选中环（仅可见层的可见钻——交互反馈层；变换手柄归交互核切片）
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

          // P5 拖移预览 ghost：选中钻平移半透明副本（Alt 复制=高亮新副本色）+ Δ 读数
          const mp = movePreview
          if (mp !== null) {
            ctx.globalAlpha = 0.55
            ctx.fillStyle = mp.copy ? 'rgba(2,132,199,0.85)' : 'rgba(15,23,42,0.65)'
            for (const id of d.selection) {
              const g = byId.get(id)
              if (!g) continue
              if (layerVisibleById.get(g.layerId) === false) continue
              ctx.beginPath()
              ctx.arc(g.x + mp.dx, g.y + mp.dy, gemRadius, 0, Math.PI * 2)
              ctx.fill()
            }
            ctx.globalAlpha = 1
            const p = getPointer()
            if (p !== null) {
              ctx.font = `${Math.max(11 / view.scale, gemRadius * 0.5)}px ui-sans-serif, sans-serif`
              ctx.fillStyle = 'rgba(15,23,42,0.9)'
              ctx.fillText(
                `Δ ${mp.dx.toFixed(1)}, ${mp.dy.toFixed(1)} px${mp.copy ? ' · 副本' : ''}`,
                p.x + gemRadius,
                p.y - gemRadius,
              )
            }
          }
        }
      }
    }

    // ---- 交互反馈层：框选矩形 / 吸附格位高亮 / 笔刷光标 / 冲突拒画闪红（读取 workbench 真源）----
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
    // 冲突拒画闪红：被拒落点红 X（起笔清零；逐笔重绘）
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
    data-testid="designer-canvas"
  >
    <canvas
      bind:this={canvasEl}
      class="block h-full w-full touch-none select-none"
      style="cursor: {cursor}"
      onwheel={onWheel}
      ondblclick={onDblClick}
      oncontextmenu={onContextMenu}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerCancel}
      onpointerleave={onPointerLeave}
      data-testid="designer-canvas-canvas"
    ></canvas>

    <!-- 变换手柄覆盖层（P6/P7：单选旋转/改径；多选无手柄；坐标换算注入单源） -->
    <DesignerTransformHandles toImage={toImageLocal} />

    {#if contextMenu !== null}
      <DesignerContextMenu x={contextMenu.x} y={contextMenu.y} kind={contextMenu.kind} onClose={() => (contextMenu = null)} />
    {/if}

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
      <span class="text-muted-foreground px-1 font-mono text-xs tabular-nums" data-testid="designer-canvas-zoom">
        {Math.round(view.scale * 100)}%
      </span>
    </div>

    <!-- [3.1] missing-asset 拒画报错（design §6.2 条件项③——显式报错，不静默空笔） -->
    {#if brushError !== null}
      <div
        class="text-destructive absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-destructive/30 bg-background/90 px-2.5 py-1 text-[11px] shadow-sm backdrop-blur"
        data-testid="designer-brush-error"
      >
        {brushError}
      </div>
    {:else if referenceState.kind === 'missing' || referenceState.kind === 'soft-deleted'}
      <div
        class="text-destructive absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-destructive/30 bg-background/90 px-2.5 py-1 text-[11px] shadow-sm backdrop-blur"
        data-testid="designer-reference-state"
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
        data-testid="designer-reference-loading"
      >
        正在解析原图…
      </div>
    {/if}

    <div
      class="absolute right-3 bottom-3 z-10 rounded-md bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm"
    >
      <span class="hidden lg:inline">滚轮缩放 · 拖拽平移 · 点击选中钻</span>
      <span class="lg:hidden">单指=当前工具 · 双指缩放平移 · 长按菜单</span>
    </div>
  </div>
{/if}
