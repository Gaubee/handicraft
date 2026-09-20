<!--
 * DesignerTransformHandles.svelte——变换手柄覆盖层（design §2.1 形态 + §2 P6/P7 手势）。
 *
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 单选变换手柄：旋转柄
 *    （距钻心 2×半径延伸杆顶端；仅非 round 形——圆钻旋转无效柄隐藏；Shift=15° 步进）+
 *    直径柄两项（水平/垂直——四向取两避免与旋转柄冲突，交互语义（旋转/改径分离）冻结，
 *    布局可随视觉评审微调）。多选不显示手柄（design §2.1 裁断：多选变换=对齐分布+批量
 *    改规格）。
 * 2. [会话语义] 拖拽实时读数气泡（旋转° / 直径 mm——interaction 态模块真源，jsdom 经
 *    读取面断言）；松手单 patch 单 undo 组（applyGemChanges）；直径值域 (0,50]——越域/
 *    非法即回滚至会话前值（预览与收笔同口径；无变更不产 patch）；Esc 经取消注册表丢弃。
 * 3. [接线] pointerdown 在手柄、move/up 走 window（真浏览器 setPointerCapture 等效——
 *    会话跨元素不丢焦；jsdom 直驱 window 事件）；坐标换算注入画布 toImage 单源。
-->

<script lang="ts">
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import { applyGemChanges } from '$lib/designer/gemCommands'
  import {
    buildDiameterChange,
    buildRotationChange,
    diameterFromDrag,
    pointerAngleDeg,
    rotationFromDrag,
  } from '$lib/designer/gestures'
  import { getTool } from '$lib/designer/workbench.svelte'
  import { getViewState } from '$lib/designer/viewport.svelte'
  import {
    getMovePreview,
    getTransformPreview,
    registerGestureCancel,
    setTransformPreview,
  } from '$lib/designer/interaction.svelte'

  let {
    toImage,
  }: {
    /** 画布坐标换算注入（client → 图像坐标——DesignerCanvas 单源）。 */
    toImage: (clientX: number, clientY: number) => { x: number; y: number }
  } = $props()

  const doc = $derived(getEditDoc())
  const view = $derived(getViewState())
  const tool = $derived(getTool())
  const movePreview = $derived(getMovePreview())
  const transformPreview = $derived(getTransformPreview())

  /** 手柄目标 = 唯一选中钻（层隐藏时无手柄——与渲染跳过同口径）。 */
  const gem = $derived.by(() => {
    const d = doc
    if (!d || d.selection.size !== 1) return null
    const id = [...d.selection][0]
    const g = d.gems.find((x) => x.id === id)
    if (!g) return null
    const layer = d.layers.find((l) => l.id === g.layerId)
    if (!layer || !layer.visible) return null
    return g
  })

  const visible = $derived(tool === 'select' && gem !== null && movePreview === null)
  /** 旋转柄仅非 round（圆钻旋转无意义，design §2 P6）。 */
  const showRotate = $derived(gem !== null && gem.shapeId !== 'round')
  const radiusPx = $derived(gem !== null && doc !== null ? (gem.diameterMm / 2) * doc.grid.pixelsPerMm : 0)

  function screenOf(x: number, y: number): { left: number; top: number } {
    return { left: x * view.scale + view.x, top: y * view.scale + view.y }
  }

  const rotatePos = $derived(gem !== null ? screenOf(gem.x, gem.y - 2 * radiusPx) : null)
  const sizeEPos = $derived(gem !== null ? screenOf(gem.x + radiusPx, gem.y) : null)
  const sizeSPos = $derived(gem !== null ? screenOf(gem.x, gem.y + radiusPx) : null)
  const bubblePos = $derived(gem !== null ? screenOf(gem.x - radiusPx, gem.y - 3 * radiusPx) : null)

  // ---- 会话（旋转 / 改径）----
  type HandleSession =
    | { kind: 'rotate'; gemId: string; startPointerAngle: number; startRotationDeg: number; valueDeg: number }
    | { kind: 'size'; gemId: string; startMm: number; valueMm: number }

  let session: HandleSession | null = null
  let unregisterCancel: (() => void) | null = null

  function sessionGem() {
    const s = session
    const d = getEditDoc()
    if (s === null || d === null) return null
    return d.gems.find((g) => g.id === s.gemId) ?? null
  }

  function startSession(kind: 'rotate' | 'size', e: PointerEvent): void {
    const g = gem
    if (g === null || session !== null) return
    e.preventDefault()
    e.stopPropagation()
    if (kind === 'rotate') {
      const p = toImage(e.clientX, e.clientY)
      const start = g.rotationDeg ?? 0
      session = {
        kind,
        gemId: g.id,
        startPointerAngle: pointerAngleDeg(g.x, g.y, p.x, p.y),
        startRotationDeg: start,
        valueDeg: start,
      }
      setTransformPreview({ kind: 'rotate', gemId: g.id, valueDeg: start })
    } else {
      session = { kind, gemId: g.id, startMm: g.diameterMm, valueMm: g.diameterMm }
      setTransformPreview({ kind: 'diameter', gemId: g.id, valueMm: g.diameterMm })
    }
    window.addEventListener('pointermove', onSessionMove)
    window.addEventListener('pointerup', onSessionUp)
    window.addEventListener('pointercancel', onSessionCancel)
    unregisterCancel = registerGestureCancel(onSessionCancel)
  }

  function onSessionMove(e: PointerEvent): void {
    const s = session
    const g = sessionGem()
    if (s === null || g === null || doc === null) return
    const p = toImage(e.clientX, e.clientY)
    if (s.kind === 'rotate') {
      s.valueDeg = rotationFromDrag({
        startPointerAngle: s.startPointerAngle,
        pointerAngle: pointerAngleDeg(g.x, g.y, p.x, p.y),
        startRotationDeg: s.startRotationDeg,
        shift: e.shiftKey,
      })
      setTransformPreview({ kind: 'rotate', gemId: g.id, valueDeg: s.valueDeg })
      return
    }
    // 改径：指针到钻心距离 = 新半径；值域 (0,50]——越域/非法回滚至会话前值（design §2 P7）
    const r = Math.hypot(p.x - g.x, p.y - g.y)
    const mm = diameterFromDrag(r, doc.grid.pixelsPerMm)
    s.valueMm = mm ?? s.startMm
    setTransformPreview({ kind: 'diameter', gemId: g.id, valueMm: s.valueMm })
  }

  function onSessionUp(): void {
    const s = session
    teardown()
    if (s === null) return
    const d = getEditDoc()
    if (d === null) return
    const g = d.gems.find((x) => x.id === s.gemId)
    if (g === undefined) return
    // 一次拖拽会话 = 一个 undo 组（applyGemChanges begin/endStroke 单组）
    if (s.kind === 'rotate') {
      const change = buildRotationChange(g, s.valueDeg)
      if (change !== null) applyGemChanges([change])
    } else {
      const change = buildDiameterChange(g, s.valueMm)
      if (change !== null) applyGemChanges([change])
    }
  }

  function onSessionCancel(): void {
    teardown()
  }

  function teardown(): void {
    session = null
    window.removeEventListener('pointermove', onSessionMove)
    window.removeEventListener('pointerup', onSessionUp)
    window.removeEventListener('pointercancel', onSessionCancel)
    unregisterCancel?.()
    unregisterCancel = null
    setTransformPreview(null)
  }

  const bubbleText = $derived.by(() => {
    const p = transformPreview
    if (p === null) return ''
    return p.kind === 'rotate' ? `${p.valueDeg.toFixed(1)}°` : `${p.valueMm.toFixed(2)} mm`
  })
</script>

{#if visible}
  <div class="pointer-events-none absolute inset-0 z-10" data-testid="designer-handles">
    {#if showRotate && rotatePos !== null}
      <button
        type="button"
        class="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-sky-600 shadow-sm"
        style="left: {rotatePos.left}px; top: {rotatePos.top}px"
        title="旋转（拖拽；Shift = 15° 步进）"
        aria-label="旋转手柄"
        data-testid="designer-handle-rotate"
        onpointerdown={(e) => startSession('rotate', e)}
      ></button>
      <!-- 旋转延伸杆（视觉连线，非交互件） -->
      {#if gem !== null}
        <div
          class="absolute w-px bg-sky-600/70"
          style="left: {screenOf(gem.x, gem.y).left}px; top: {rotatePos.top}px; height: {radiusPx * view.scale}px"
          aria-hidden="true"
        ></div>
      {/if}
    {/if}
    {#if sizeEPos !== null}
      <button
        type="button"
        class="pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize rounded-[2px] border border-white bg-slate-700 shadow-sm"
        style="left: {sizeEPos.left}px; top: {sizeEPos.top}px"
        title="直径（拖拽连续改径，单位 mm）"
        aria-label="直径手柄（水平）"
        data-testid="designer-handle-size-e"
        onpointerdown={(e) => startSession('size', e)}
      ></button>
    {/if}
    {#if sizeSPos !== null}
      <button
        type="button"
        class="pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ns-resize rounded-[2px] border border-white bg-slate-700 shadow-sm"
        style="left: {sizeSPos.left}px; top: {sizeSPos.top}px"
        title="直径（拖拽连续改径，单位 mm）"
        aria-label="直径手柄（垂直）"
        data-testid="designer-handle-size-s"
        onpointerdown={(e) => startSession('size', e)}
      ></button>
    {/if}
    {#if transformPreview !== null && bubblePos !== null}
      <div
        class="absolute -translate-x-1/2 -translate-y-full rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white shadow-sm"
        style="left: {bubblePos.left}px; top: {bubblePos.top}px"
        data-testid="designer-transform-readout"
      >
        {bubbleText}
      </div>
    {/if}
  </div>
{/if}
