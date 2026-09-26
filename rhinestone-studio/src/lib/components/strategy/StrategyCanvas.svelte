<!--
StrategyCanvas.svelte — 策略层实时画布（add-subject-sam-pipeline P3.2；
add-task-detail-layer-workbench 2.5 受控化——喂数方式=策略设计器 store 同式投影）。
三层叠加（下→上）：原图（开关+透明度——sourceUrl 缺席时降级态）→
object-tree 预览框线（bbox+排除语义色）→ strategy gems 点阵（SVG：颜色=指派
StonePick colorHex、尺寸=diameterMm×ppm）。逐节点显隐由喂数方过滤（投影内完成）。
[2.5] 受控组件化：数据/开关态全部经 props（原策略设计器 store 直读改为
StrategyDesignerView 接线——标记与结构零变化）；新增可选蒙版叠加位（masks）
与选中层描边加粗位（selectedNodeId）——不传即不渲染，策略设计器行为不变。
-->

<script lang="ts">
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
  } = $props()

  const imagePx = $derived(model?.imagePx ?? null)
  const sourceUrl = $derived(model?.sourceUrl ?? null)
  const maskOverlays = $derived(showMasks ? (model?.masks ?? []) : [])
  const strokeWidth = $derived(
    imagePx !== null ? Math.max(imagePx.width, imagePx.height) / 400 : 1,
  )
</script>

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
      <svg
        viewBox="0 0 {imagePx.width} {imagePx.height}"
        preserveAspectRatio="xMidYMid meet"
        class="mx-auto h-full w-full max-w-full"
        data-testid="strategy-canvas"
        role="img"
        aria-label="策略层叠加画布（原图+图层框线+钻点阵）"
      >
        <!-- 层 1：原图（任务详情经 baseImage 锚；策略设计器经 sourceImageUrl） -->
        {#if sourceUrl !== null && baseVisible}
          <image href={sourceUrl} x="0" y="0" width={imagePx.width} height={imagePx.height} opacity={baseOpacity} data-testid="strategy-base-image" />
        {/if}

        <!-- 层 1.5：蒙版可视化叠加（半透明行程矩形——任务工作台图层管理开关） -->
        {#if showMasks}
          {#each maskOverlays as overlay (overlay.nodeId)}
            <g
              fill="#7C3AED"
              fill-opacity="0.22"
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

        <!-- 层 2：object-tree 预览框线（排除/不值得贴=红虚线；选中层描边加粗） -->
        {#if showBoxes}
          {#each model.boxes as box (box.nodeId)}
            <rect
              x={box.bbox.x}
              y={box.bbox.y}
              width={box.bbox.w}
              height={box.bbox.h}
              fill="none"
              stroke={box.excluded ? '#dc2626' : '#2563eb'}
              stroke-width={box.nodeId === selectedNodeId ? strokeWidth * 2.5 : strokeWidth}
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
      </svg>
    {/if}
  </div>
</div>
