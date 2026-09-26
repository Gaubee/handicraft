<!--
StrategyCanvas.svelte — 策略层实时画布（add-subject-sam-pipeline P3.2；
add-task-detail-layer-workbench 2.5 受控化——喂数方式=策略设计器 store 同式投影）。
三层叠加（下→上）：原图（开关+透明度——sourceUrl 缺席时降级态）→
object-tree 预览框线（bbox+排除语义色）→ strategy gems 点阵（SVG：颜色=指派
StonePick colorHex、尺寸=diameterMm×ppm）。逐节点显隐由喂数方过滤（投影内完成）。
[2.5] 受控组件化：数据/开关态全部经 props（原策略设计器 store 直读改为
StrategyDesignerView 接线——标记与结构零变化）；新增可选蒙版叠加位（masks）
与选中层描边加粗位（selectedNodeId）——不传即不渲染，策略设计器行为不变。
[add-workbench-pro 2c 鼠标 P0] 可选 view（CanvasView——lib/canvaskit 真源；非空=
视口取景模式：动态 viewBox，滚轮锚定缩放/平移由喂数方驱动；null=既有 contain
适配——策略设计器零变化）+可选 hoverNodeId（命中层框线悬停高亮）+可选 children
snippet（叠加层注入位——笔刷层/指针捕获层与画布同盒对齐，坐标真源=画布 px）。
-->

<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { CanvasView } from '$lib/canvaskit.js'
  import type { StrategyCanvasModel } from './canvasModel.js'

  let {
    model = null,
    loading = false,
    loadError = null,
    emptyHint = '在左侧对话发起旅程：上传图 + cm 尺寸 → 识图抠图 → strategy.design',
    baseVisible = true,
    onSetBaseVisible = undefined,
    baseOpacity = 0.6,
    onSetBaseOpacity = undefined,
    showBoxes = true,
    onSetShowBoxes = undefined,
    masks = [],
    showMasks = false,
    onSetShowMasks = undefined,
    selectedNodeId = null,
    view = null,
    hoverNodeId = null,
    children = undefined,
  }: {
    model?: StrategyCanvasModel | null
    loading?: boolean
    loadError?: string | null
    emptyHint?: string
    baseVisible?: boolean
    onSetBaseVisible?: (visible: boolean) => void
    baseOpacity?: number
    onSetBaseOpacity?: (opacity: number) => void
    showBoxes?: boolean
    onSetShowBoxes?: (visible: boolean) => void
    masks?: StrategyCanvasModel['masks']
    showMasks?: boolean
    onSetShowMasks?: ((visible: boolean) => void) | null
    selectedNodeId?: string | null
    /** 视口取景（非空=视口模式——动态 viewBox；null=contain 适配[既有行为]）。 */
    view?: CanvasView | null
    /** 悬停层（命中高亮——框线琥珀描边；null=无悬停）。 */
    hoverNodeId?: string | null
    /** 叠加层注入位（与画布同盒对齐——绝对定位 inset-0 即画布 viewport 盒）。 */
    children?: Snippet | undefined
  } = $props()

  const imagePx = $derived(model?.imagePx ?? null)
  const sourceUrl = $derived(model?.sourceUrl ?? null)
  const maskOverlays = $derived(showMasks ? (model?.masks ?? []) : [])
  const strokeWidth = $derived(
    imagePx !== null ? Math.max(imagePx.width, imagePx.height) / 400 : 1,
  )
  /** 测量盒尺寸（视口模式 viewBox 组装；jsdom 无布局=0——ResizeObserver 缺席时
   *  经 getBoundingClientRect 降级测量：只随派生重算，无 resize 跟踪不炸）。 */
  let boxEl = $state<HTMLElement | null>(null)
  let boxW = $state(0)
  let boxH = $state(0)
  $effect(() => {
    if (boxEl === null) return
    const measure = (): void => {
      const rect = boxEl!.getBoundingClientRect()
      boxW = rect.width
      boxH = rect.height
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(boxEl)
    return () => observer.disconnect()
  })
  /** 视口模式 viewBox（screen = image×scale + (x,y) 的逆：可见图像域=[−x/s,(box−x)/s]）。 */
  const viewBoxOfView = $derived.by(() => {
    if (view === null || imagePx === null || !(view.scale > 0)) return null
    const w = boxW > 0 ? boxW : imagePx.width
    const h = boxH > 0 ? boxH : imagePx.height
    return `${-view.x / view.scale} ${-view.y / view.scale} ${w / view.scale} ${h / view.scale}`
  })
</script>

{#snippet canvasLayers()}
  {#if model !== null && imagePx !== null}
        <!-- 层 1：原图（任务详情经 baseImage 锚；策略设计器经 sourceImageUrl） -->
        {#if sourceUrl !== null && baseVisible}
          <image href={sourceUrl} x="0" y="0" width={imagePx.width} height={imagePx.height} opacity={baseOpacity} data-testid="strategy-base-image" />
        {/if}

        <!-- 层 1.5：蒙版可视化叠加（半透明行程矩形——任务工作台图层管理开关；
             选中层=琥珀高亮填充+描边（add-workbench-pro 2.2 遮罩可视化增强）） -->
        {#if showMasks}
          {#each maskOverlays as overlay (overlay.nodeId)}
            <g
              fill={overlay.selected ? '#F59E0B' : '#7C3AED'}
              fill-opacity={overlay.selected ? 0.3 : 0.22}
              stroke={overlay.selected ? '#B45309' : 'none'}
              stroke-width={overlay.selected ? strokeWidth * 1.5 : undefined}
              data-testid="strategy-mask-overlay"
              data-node-id={overlay.nodeId}
              aria-hidden="true"
            >
              {#each overlay.runs as run, i (i)}
                <rect x={run.x} y={run.y} width={run.w} height={run.h}></rect>
              {/each}
            </g>
          {/each}
        {/if}

        <!-- 层 2：object-tree 预览框线（排除/不值得贴=红虚线；选中层描边加粗；[2c] hover=琥珀描边） -->
        {#if showBoxes}
          {#each model.boxes as box (box.nodeId)}
            <rect
              x={box.bbox.x}
              y={box.bbox.y}
              width={box.bbox.w}
              height={box.bbox.h}
              fill="none"
              stroke={box.nodeId === selectedNodeId ? (box.excluded ? '#dc2626' : '#2563eb') : box.nodeId === hoverNodeId ? '#f59e0b' : box.excluded ? '#dc2626' : '#2563eb'}
              stroke-width={box.nodeId === selectedNodeId ? strokeWidth * 2.5 : box.nodeId === hoverNodeId ? strokeWidth * 2 : strokeWidth}
              stroke-dasharray={box.excluded ? `${imagePx.width / 100} ${imagePx.width / 150}` : undefined}
              data-testid="strategy-node-box"
              data-node-id={box.nodeId}
            ></rect>
            <text
              x={box.bbox.x + box.bbox.w / 2}
              y={box.bbox.y - imagePx.height / 200}
              text-anchor="middle"
              font-size={Math.max(imagePx.width, imagePx.height) / 28}
              fill={box.excluded ? '#b91c1c' : '#1d4ed8'}
              data-testid="strategy-node-label"
            >{box.objectName}{box.excluded ? '（不贴）' : ''}</text>
          {/each}
        {/if}

        <!-- 层 3：strategy gems 点阵 -->
        {#each model.gems as gem (gem.id)}
          <circle
            cx={gem.x}
            cy={gem.y}
            r={gem.radiusPx}
            fill={gem.colorHex}
            stroke="rgba(0,0,0,0.25)"
            stroke-width={Math.max(imagePx.width, imagePx.height) / 500}
            data-testid="strategy-gem"
            data-node-id={gem.nodeId}
          >
            <title>{gem.id} · {gem.nodeId} · {gem.colorHex}</title>
          </circle>
        {/each}
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col" data-testid="strategy-canvas-panel">
  <div class="bg-background/80 flex h-11 shrink-0 items-center gap-3 border-b px-3 text-xs backdrop-blur">
    <label class="flex items-center gap-1.5" data-testid="strategy-base-toggle-wrap">
      <input
        type="checkbox"
        checked={baseVisible}
        onchange={(event) => onSetBaseVisible?.(event.currentTarget.checked)}
        disabled={sourceUrl === null}
        class="accent-primary size-3.5"
        data-testid="strategy-base-toggle"
      />
      <span class={sourceUrl === null ? 'text-muted-foreground/60' : ''}>原图</span>
    </label>
    {#if sourceUrl !== null}
      <label class="flex min-w-32 items-center gap-1.5">
        <span class="text-muted-foreground">透明度</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={baseOpacity}
          oninput={(event) => onSetBaseOpacity?.(Number(event.currentTarget.value))}
          class="accent-primary h-1.5 w-24"
          data-testid="strategy-base-opacity"
          aria-label="原图透明度"
        />
        <span class="font-mono tabular-nums">{Math.round(baseOpacity * 100)}%</span>
      </label>
    {:else}
      <span class="text-muted-foreground/70" data-testid="strategy-base-missing" title="任务尚无识图工件（scene-analysis 缺席）——原图锚为空，画布按框线+点阵渲染">
        原图未挂接（该任务无识图工件锚——按框线+点阵渲染）
      </span>
    {/if}
    <label class="flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={showBoxes}
        onchange={(event) => onSetShowBoxes?.(event.currentTarget.checked)}
        class="accent-primary size-3.5"
        data-testid="strategy-boxes-toggle"
      />
      <span>图层框线</span>
    </label>
    {#if onSetShowMasks !== undefined}
      <label class="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={showMasks}
          onchange={(event) => onSetShowMasks?.(event.currentTarget.checked)}
          class="accent-primary size-3.5"
          data-testid="strategy-masks-toggle"
        />
        <span>蒙版</span>
      </label>
    {/if}
    <span class="text-muted-foreground ml-auto font-mono" data-testid="strategy-gem-count">
      {model === null ? '' : `${model.gems.length} 颗 · ${model.excludedCount} 处留白 · ${model.ppm.exact ? `ppm=${model.ppm.ppm.toFixed(2)}` : 'ppm≈1（纵横比不吻合）'}`}
    </span>
  </div>

  <div class="bg-muted/50 relative min-h-0 flex-1 overflow-hidden p-3">
    {#if model === null}
      <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 text-center text-sm" data-testid="strategy-canvas-empty">
        {#if loading}
          <p class="animate-pulse">策略工件装载中…</p>
        {:else if loadError !== null}
          <p class="text-destructive" data-testid="strategy-canvas-error">{loadError}</p>
        {:else}
          <p class="font-medium">当前会话尚无策略工件</p>
          <p class="text-xs">{emptyHint}</p>
        {/if}
      </div>
    {:else if imagePx !== null}
      <!-- 画布 viewport 盒（视口模式 viewBox 组装+叠加层注入对齐的测量锚——bind:clientWidth/Height） -->
      <div bind:this={boxEl} class="relative h-full w-full">
      {#if viewBoxOfView !== null}
        <svg
          viewBox={viewBoxOfView}
          preserveAspectRatio="xMidYMid meet"
          class="absolute inset-0 h-full w-full"
          data-testid="strategy-canvas"
          data-canvas-viewport="true"
          role="img"
          aria-label="策略层叠加画布（原图+图层框线+钻点阵）"
        >
          {@render canvasLayers()}
        </svg>
      {:else}
        <svg
          viewBox="0 0 {imagePx.width} {imagePx.height}"
          preserveAspectRatio="xMidYMid meet"
          class="mx-auto h-full w-full max-w-full"
          data-testid="strategy-canvas"
          role="img"
          aria-label="策略层叠加画布（原图+图层框线+钻点阵）"
        >
          {@render canvasLayers()}
        </svg>
      {/if}
      {@render children?.()}
      </div>
    {/if}
  </div>
</div>
