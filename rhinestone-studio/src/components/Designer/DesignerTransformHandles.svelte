<!--
 * DesignerTransformHandles.svelte——⌘T 自由变换盒覆盖层（rework R4.1，design §3.1）。
 *
 * Orthogonal intents (max 3):
 * 1. [退役收据] redesign 3.x 的单选专用旋转/直径柄（P6/P7）已随 rework R4.1 退役——非
 *    变换态本组件零渲染（单选/多选均无 idle 手柄）；变换交互统一 ⌘T（本组件 = 变换态盒）。
 * 2. [rework R4.1 变换盒] 选集包围盒（单/多选同权——interaction.transformMode 真源）+
 *    四角柄 = 等比缩放（语义 = 批量改尺寸：直径字段，§2 红线——钻位不动）+ 外柄（柄间
 *    中点外推）= 组旋转（Shift = 15° 步进格——组语义步进作用于增量）；round-only 选集
 *    旋转柄禁用灰显（design §3.1 裁断）。拖拽逐帧写 pending 覆盖（多柄连拖累积），
 *    松手不提交；Enter = commands.confirm-transform 单 patch 单 undo 组；Esc = 取消
 *    注册表零 patch 退出（变换态取消最优先）。
 * 3. [接线] pointerdown 在柄、move/up 走 window（真浏览器会话跨元素不丢焦；jsdom 直驱
 *    window 事件）；坐标换算注入画布 toImage 单源；实时读数气泡沿
 *    designer-transform-readout 惯例（scale = %（单选附 mm）/ rotate = 增量°）。
-->

<script lang="ts">
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import {
    handleAnchorOf,
    isRotateHandle,
    normalizeDeg,
    pointerAngleDeg,
    rotationDeltaFromDrag,
    scaleFromDrag,
    scaledDiameterMm,
    type TransformHandleId,
  } from '$lib/designer/gestures'
  import { getViewState } from '$lib/designer/viewport.svelte'
  import {
    getTransformMode,
    getTransformReadout,
    registerGestureCancel,
    setTransformReadout,
    updateTransformPending,
  } from '$lib/designer/interaction.svelte'

  let {
    toImage,
  }: {
    /** 画布坐标换算注入（client → 图像坐标——DesignerCanvas 单源）。 */
    toImage: (clientX: number, clientY: number) => { x: number; y: number }
  } = $props()

  const mode = $derived(getTransformMode())
  const view = $derived(getViewState())
  const readout = $derived(getTransformReadout())

  /** 外柄沿盒法向外推（屏幕 px——恒定视觉间距，不随缩放漂移）。 */
  const ROTATE_HANDLE_OFFSET_PX = 18

  function screenOf(x: number, y: number): { left: number; top: number } {
    return { left: x * view.scale + view.x, top: y * view.scale + view.y }
  }

  const CORNERS: ReadonlyArray<{ id: TransformHandleId; cursor: string; label: string }> = [
    { id: 'nw', cursor: 'cursor-nwse-resize', label: '缩放（等比改尺寸）' },
    { id: 'ne', cursor: 'cursor-nesw-resize', label: '缩放（等比改尺寸）' },
    { id: 'sw', cursor: 'cursor-nesw-resize', label: '缩放（等比改尺寸）' },
    { id: 'se', cursor: 'cursor-nwse-resize', label: '缩放（等比改尺寸）' },
  ]
  const OUTERS: ReadonlyArray<{ id: TransformHandleId; dx: number; dy: number }> = [
    { id: 'n', dx: 0, dy: -1 },
    { id: 'e', dx: 1, dy: 0 },
    { id: 's', dx: 0, dy: 1 },
    { id: 'w', dx: -1, dy: 0 },
  ]

  /** 柄屏幕位：角柄 = 盒角；外柄 = 边中点 + 法向外推。 */
  function handleScreenPos(handle: TransformHandleId): { left: number; top: number } {
    const m = mode
    if (m === null) return { left: 0, top: 0 }
    const anchor = handleAnchorOf(m.bounds, handle)
    const base = screenOf(anchor.x, anchor.y)
    if (!isRotateHandle(handle)) return base
    const outer = OUTERS.find((o) => o.id === handle)
    if (outer === undefined) return base
    return {
      left: base.left + outer.dx * ROTATE_HANDLE_OFFSET_PX,
      top: base.top + outer.dy * ROTATE_HANDLE_OFFSET_PX,
    }
  }

  const boxGeom = $derived.by(() => {
    const m = mode
    if (m === null) return null
    const tl = screenOf(m.bounds.x0, m.bounds.y0)
    const br = screenOf(m.bounds.x1, m.bounds.y1)
    return { left: tl.left, top: tl.top, width: br.left - tl.left, height: br.top - tl.top }
  })

  /** 读数气泡锚：盒左上角上方（沿单柄时代气泡惯例）。 */
  const readoutPos = $derived.by(() => {
    const m = mode
    if (m === null) return null
    return screenOf(m.bounds.x0, m.bounds.y0)
  })

  // ---- 拖拽会话（柄 → pending 覆盖逐帧写；松手保持预览，Enter 提交 / Esc 整态取消）----

  interface HandleSession {
    handle: TransformHandleId
    center: { x: number; y: number }
    startAnchor: { x: number; y: number }
    startPointerAngle: number
    /** 起拖基线（pending ?? 文档现值）——多柄连拖以累积值为基线复合。 */
    baseline: Record<string, { diameterMm: number; rotationDeg: number; round: boolean }>
  }

  let session: HandleSession | null = null
  let unregisterCancel: (() => void) | null = null

  function startHandleDrag(handle: TransformHandleId, e: PointerEvent): void {
    const m = mode
    if (m === null || session !== null) return
    if (isRotateHandle(handle) && !m.rotationEnabled) return // round-only：旋转柄禁用
    const doc = getEditDoc()
    if (doc === null) return
    e.preventDefault()
    e.stopPropagation()
    const byId = new Map(doc.gems.map((g) => [g.id, g] as const))
    const baseline: HandleSession['baseline'] = {}
    for (const id of m.gemIds) {
      const gem = byId.get(id)
      if (!gem) continue // 悬空 id（进态后被删等）——提交面同判跳过
      const pending = m.pending[id]
      baseline[id] = {
        diameterMm: pending?.diameterMm ?? gem.diameterMm,
        rotationDeg: pending?.rotationDeg ?? (gem.rotationDeg ?? 0),
        round: gem.shapeId === 'round',
      }
    }
    const p = toImage(e.clientX, e.clientY)
    const center = { x: (m.bounds.x0 + m.bounds.x1) / 2, y: (m.bounds.y0 + m.bounds.y1) / 2 }
    session = {
      handle,
      center,
      startAnchor: handleAnchorOf(m.bounds, handle),
      startPointerAngle: pointerAngleDeg(center.x, center.y, p.x, p.y),
      baseline,
    }
    const single = Object.keys(baseline).length === 1 ? Object.values(baseline)[0] : null
    setTransformReadout(
      isRotateHandle(handle)
        ? { kind: 'rotate', deltaDeg: 0 }
        : { kind: 'scale', percent: 100, mm: single !== null ? single.diameterMm : null },
    )
    window.addEventListener('pointermove', onSessionMove)
    window.addEventListener('pointerup', onSessionUp)
    window.addEventListener('pointercancel', onSessionCancel)
    unregisterCancel = registerGestureCancel(onSessionCancel)
  }

  function onSessionMove(e: PointerEvent): void {
    const s = session
    if (s === null) return
    const p = toImage(e.clientX, e.clientY)
    if (isRotateHandle(s.handle)) {
      const delta = rotationDeltaFromDrag({
        startPointerAngle: s.startPointerAngle,
        pointerAngle: pointerAngleDeg(s.center.x, s.center.y, p.x, p.y),
        shift: e.shiftKey,
      })
      const updates: Record<string, { rotationDeg: number }> = {}
      for (const [id, base] of Object.entries(s.baseline)) {
        if (base.round) continue // round 旋转值恒 0（design §3.1 裁断）
        updates[id] = { rotationDeg: Math.round(normalizeDeg(base.rotationDeg + delta) * 100) / 100 }
      }
      updateTransformPending(updates)
      setTransformReadout({ kind: 'rotate', deltaDeg: delta })
      return
    }
    const factor = scaleFromDrag({ center: s.center, startAnchor: s.startAnchor, pointer: p })
    const updates: Record<string, { diameterMm: number }> = {}
    let singleMm: number | null = null
    const entries = Object.entries(s.baseline)
    for (const [id, base] of entries) {
      const next = scaledDiameterMm(base.diameterMm, factor)
      updates[id] = { diameterMm: next }
      if (entries.length === 1) singleMm = next
    }
    updateTransformPending(updates)
    setTransformReadout({ kind: 'scale', percent: Math.round(factor * 100), mm: singleMm })
  }

  function onSessionUp(): void {
    // 松手保持 pending 预览（多柄连拖累积）；提交归 Enter（commands.confirm-transform）
    teardownSession()
  }

  function onSessionCancel(): void {
    teardownSession()
  }

  function teardownSession(): void {
    session = null
    window.removeEventListener('pointermove', onSessionMove)
    window.removeEventListener('pointerup', onSessionUp)
    window.removeEventListener('pointercancel', onSessionCancel)
    unregisterCancel?.()
    unregisterCancel = null
    setTransformReadout(null)
  }

  const readoutText = $derived.by(() => {
    const r = readout
    if (r === null) return ''
    if (r.kind === 'rotate') {
      const rounded = Math.round(r.deltaDeg * 10) / 10
      return `${rounded >= 0 ? '+' : ''}${rounded}°`
    }
    return r.mm !== null ? `${r.percent}% · Ø ${r.mm.toFixed(2)}mm` : `${r.percent}%`
  })
</script>

{#if mode !== null && boxGeom !== null}
  <div class="pointer-events-none absolute inset-0 z-10" data-testid="designer-transform-box">
    <!-- 选集包围盒（进态快照定格——§2 红线：钻位不动 ⇒ 盒恒定） -->
    <div
      class="absolute border-2 border-sky-600"
      style="left: {boxGeom.left}px; top: {boxGeom.top}px; width: {boxGeom.width}px; height: {boxGeom.height}px"
      aria-hidden="true"
    ></div>

    {#each CORNERS as c (c.id)}
      {@const pos = handleScreenPos(c.id)}
      <button
        type="button"
        class="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-2 border-white bg-sky-600 shadow-sm {c.cursor}"
        style="left: {pos.left}px; top: {pos.top}px"
        title="{c.label}（Enter 确认 / Esc 取消）"
        aria-label="缩放手柄 {c.id}"
        data-testid="designer-transform-handle-{c.id}"
        onpointerdown={(e) => startHandleDrag(c.id, e)}
      ></button>
    {/each}

    {#each OUTERS as o (o.id)}
      {@const pos = handleScreenPos(o.id)}
      <button
        type="button"
        class="pointer-events-auto absolute {mode.rotationEnabled
          ? 'size-3.5 cursor-grab rounded-full border-2 border-white bg-sky-600 shadow-sm'
          : 'pointer-events-none size-3.5 rounded-full border-2 border-white bg-slate-400 opacity-50 shadow-sm'}"
        style="left: {pos.left}px; top: {pos.top}px"
        title={mode.rotationEnabled ? '旋转（Shift = 15° 步进）' : '圆钻旋转无效——旋转已禁用'}
        aria-label="旋转手柄 {o.id}"
        aria-disabled={mode.rotationEnabled ? undefined : 'true'}
        data-testid="designer-transform-rotate-{o.id}"
        data-disabled={mode.rotationEnabled ? undefined : 'true'}
        onpointerdown={(e) => startHandleDrag(o.id, e)}
      ></button>
    {/each}

    {#if readout !== null && readoutPos !== null}
      <div
        class="absolute -translate-x-1/2 -translate-y-full rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white shadow-sm"
        style="left: {readoutPos.left}px; top: {readoutPos.top - 6}px"
        data-testid="designer-transform-readout"
      >
        {readoutText}
      </div>
    {/if}
  </div>
{/if}
