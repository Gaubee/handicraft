<!--
WorkbenchBrushLayer.svelte — 画布笔刷编辑层（add-workbench-pro 2.3 最小编辑闭环）。
笔刷模式激活时叠加在 StrategyCanvas 同区（inset 同 padding——SVG viewBox/letterbox
与画布同构，坐标映射一致）：include/exclude 两笔刷（半径 [/] 可调）+涂抹收集笔画
（本地预览即时）+提交→layer.mask.patch（服务端 mask 重写+可选重算）+撤销最近一笔
（本地笔画栈——完整 undo 域 2c）。光标圆圈指示半径（画布 scale 换算）。
坐标真源=画布 px 坐标系（与 daemon BrushPoint 同一坐标系——§0/D-2⑥ 红线）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import {
    beginStroke,
    commitBrushStrokes,
    endStroke,
    enterBrushMode,
    exitBrushMode,
    extendStroke,
    getBrushError,
    getBrushSession,
    getSelectedNodeId,
    getNodeOf,
    getWorkbenchCanvasModel,
    isBrushSubmitting,
    setBrushOp,
    setBrushRadius,
    undoLastStroke,
  } from './store.svelte'

  const brush = $derived(getBrushSession())
  const submitting = $derived(isBrushSubmitting())
  const brushError = $derived(getBrushError())
  const selectedId = $derived(getSelectedNodeId())
  const selectedNode = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const model = $derived(getWorkbenchCanvasModel())

  let svgEl = $state<SVGSVGElement | null>(null)
  /** 光标画布坐标（圆圈预览定位——client 态不经 store）。 */
  let cursorClient = $state<{ x: number; y: number } | null>(null)

  /** SVG client 域→画布 px（preserveAspectRatio=xMidYMid meet 的逆映射）。 */
  function toImagePx(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    if (svgEl === null || model === null) return null
    const rect = svgEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const scale = Math.min(rect.width / model.imagePx.width, rect.height / model.imagePx.height)
    const offsetX = (rect.width - model.imagePx.width * scale) / 2
    const offsetY = (rect.height - model.imagePx.height * scale) / 2
    const x = (event.clientX - rect.left - offsetX) / scale
    const y = (event.clientY - rect.top - offsetY) / scale
    return { x: Math.max(0, Math.min(model.imagePx.width, x)), y: Math.max(0, Math.min(model.imagePx.height, y)) }
  }

  function onPointerDown(event: PointerEvent): void {
    const point = toImagePx(event)
    if (point === null) return
    try {
      svgEl?.setPointerCapture?.(event.pointerId)
    } catch {
      // jsdom 无 pointer capture——坐标流不受影响
    }
    beginStroke(point)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    cursorClient = { x: event.clientX, y: event.clientY }
    const point = toImagePx(event)
    if (point === null) return
    extendStroke(point)
  }

  function onPointerUp(): void {
    endStroke()
  }

  /** 笔画预览序列（在途+已收笔——半透明圆盘沿折线）。 */
  const previewStrokes = $derived(
    brush.strokes.concat(brush.previewPoints.length > 0
      ? [{ op: brush.op, radiusPx: brush.radiusPx, points: brush.previewPoints }]
      : []),
  )

  /** client 域圆圈预览几何（半径=radiusPx×画布 scale 的 client 像素）。 */
  const cursorCircle = $derived.by(() => {
    if (cursorClient === null || svgEl === null || model === null) return null
    const rect = svgEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const scale = Math.min(rect.width / model.imagePx.width, rect.height / model.imagePx.height)
    return { clientX: cursorClient.x, clientY: cursorClient.y, radiusPx: brush.radiusPx * scale }
  })

  async function onCommit(): Promise<void> {
    const ok = await commitBrushStrokes(true)
    if (ok) exitBrushMode()
  }
</script>

{#if brush.active && model !== null}
  <!-- 笔刷工具条（画布顶部浮动——include/exclude/半径/撤销/提交/退出） -->
  <div
    class="bg-background/90 absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border px-2 py-1 shadow-sm backdrop-blur"
    data-testid="workbench-brush-toolbar"
    role="toolbar"
    aria-label="笔刷工具条"
  >
    <span class="text-muted-foreground text-[10px]">
      笔刷·{selectedNode?.objectName ?? ''}
    </span>
    <div class="flex overflow-hidden rounded-md border" data-testid="workbench-brush-ops">
      <button
        type="button"
        class="px-2 py-0.5 text-[11px] transition-colors {brush.op === 'add' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}"
        onclick={() => setBrushOp('add')}
        aria-pressed={brush.op === 'add'}
        data-testid="workbench-brush-add"
        title="include 笔刷（涂入掩码）"
      >
        涂入
      </button>
      <button
        type="button"
        class="px-2 py-0.5 text-[11px] transition-colors {brush.op === 'remove' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}"
        onclick={() => setBrushOp('remove')}
        aria-pressed={brush.op === 'remove'}
        data-testid="workbench-brush-remove"
        title="exclude 笔刷（擦除掩码）"
      >
        擦除
      </button>
    </div>
    <label class="text-muted-foreground flex items-center gap-1 text-[10px]" title="笔刷半径（[/] 键步进）">
      半径
      <input
        type="number"
        min="1"
        max="128"
        value={brush.radiusPx}
        onchange={(event) => {
          const next = Number(event.currentTarget.value)
          if (Number.isFinite(next) && next >= 1 && next <= 128) {
            setBrushRadius(next)
          }
        }}
        class="border-input bg-background w-12 rounded border px-1 py-0.5 text-[11px] tabular-nums"
        data-testid="workbench-brush-radius"
        aria-label="笔刷半径（像素）"
      />
      <span class="font-mono">px</span>
    </label>
    <span class="text-muted-foreground font-mono text-[10px]" data-testid="workbench-brush-stroke-count">
      {brush.strokes.length} 笔
    </span>
    <Button
      size="sm"
      variant="ghost"
      class="h-6 px-2 text-[11px]"
      disabled={brush.strokes.length === 0 || submitting}
      onclick={undoLastStroke}
      data-testid="workbench-brush-undo"
      title="撤销最近一笔（提交前）"
    >
      撤销一笔
    </Button>
    <Button
      size="sm"
      class="h-6 px-2 text-[11px]"
      disabled={brush.strokes.length === 0 || submitting}
      onclick={() => void onCommit()}
      data-testid="workbench-brush-commit"
      title="提交→服务端 mask 重写+受影响指派重算"
    >
      {submitting ? '提交中…' : '提交重算'}
    </Button>
    <Button size="sm" variant="outline" class="h-6 px-2 text-[11px]" onclick={exitBrushMode} data-testid="workbench-brush-exit" title="退出笔刷（Esc）">
      退出
    </Button>
  </div>

  {#if brushError !== null}
    <div
      class="text-destructive bg-background/95 absolute bottom-2 left-1/2 z-10 max-w-[80%] -translate-x-1/2 rounded-md border px-2 py-1 text-[11px] shadow-sm"
      data-testid="workbench-brush-error"
      role="alert"
    >
      {brushError}
    </div>
  {/if}

  <!-- 笔画层（与画布同 letterbox——viewBox=画布 px；pointer 事件接收面） -->
  <svg
    bind:this={svgEl}
    viewBox="0 0 {model.imagePx.width} {model.imagePx.height}"
    preserveAspectRatio="xMidYMid meet"
    class="absolute inset-3 z-[5] mx-auto h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] max-w-full cursor-crosshair touch-none"
    data-testid="workbench-brush-layer"
    role="img"
    aria-label="笔刷编辑叠加层"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onpointerleave={() => (cursorClient = null)}
  >
    <!-- 选中层 bbox 参照（笔画有效域提示——bbox 外无效不跨界） -->
    {#if selectedNode !== null}
      <rect
        x={selectedNode.bbox.x}
        y={selectedNode.bbox.y}
        width={selectedNode.bbox.w}
        height={selectedNode.bbox.h}
        fill="none"
        stroke="#059669"
        stroke-dasharray="{model.imagePx.width / 120} {model.imagePx.width / 80}"
        stroke-width="{Math.max(model.imagePx.width, model.imagePx.height) / 600}"
        data-testid="workbench-brush-target-bbox"
      ></rect>
    {/if}
    <!-- 笔画预览（半透明圆盘沿折线——include 绿/exclude 红） -->
    {#each previewStrokes as stroke, si (si)}
      {#each stroke.points as point, pi (pi)}
        <circle
          cx={point.x}
          cy={point.y}
          r={stroke.radiusPx}
          fill={stroke.op === 'add' ? '#10B981' : '#EF4444'}
          fill-opacity="0.28"
          data-testid="workbench-brush-dot"
        ></circle>
      {/each}
    {/each}
  </svg>

  <!-- 光标圆圈预览（client 域——半径=画布 px×scale） -->
  {#if cursorCircle !== null}
    <div
      class="pointer-events-none absolute z-[6] rounded-full border-2 {brush.op === 'add' ? 'border-emerald-500' : 'border-red-500'}"
      style="left: {cursorCircle.clientX}px; top: {cursorCircle.clientY}px; width: {cursorCircle.radiusPx * 2}px; height: {cursorCircle.radiusPx * 2}px; transform: translate(-50%, -50%);"
      data-testid="workbench-brush-cursor"
      aria-hidden="true"
    ></div>
  {/if}
{/if}
