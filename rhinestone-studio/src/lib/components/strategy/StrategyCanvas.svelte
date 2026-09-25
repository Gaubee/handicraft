<!--
StrategyCanvas.svelte — 策略层实时画布（add-subject-sam-pipeline P3.2）。
三层叠加（下→上）：原图（开关+透明度——树工件缺 imageBlobRef 时降级态）→
object-tree 预览框线（bbox+排除语义色）→ strategy gems 点阵（SVG：颜色=指派
StonePick colorHex、尺寸=diameterMm×ppm）。逐节点显隐经 store hiddenNodes。
-->

<script lang="ts">
  import {
    getBaseImageOpacity,
    getBaseImageVisible,
    getRenderBoxes,
    getRenderGems,
    getShowBoxes,
    getStrategyArtifacts,
    getStrategyLoadError,
    getStrategyPpm,
    isStrategyLoading,
    setBaseImageOpacity,
    setBaseImageVisible,
    setShowBoxes,
  } from '$lib/strategyDesigner/store.svelte'

  const artifacts = $derived(getStrategyArtifacts())
  const gems = $derived(getRenderGems())
  const boxes = $derived(getRenderBoxes())
  const ppm = $derived(getStrategyPpm())
  const loading = $derived(isStrategyLoading())
  const loadError = $derived(getStrategyLoadError())
  const baseVisible = $derived(getBaseImageVisible())
  const baseOpacity = $derived(getBaseImageOpacity())
  const showBoxes = $derived(getShowBoxes())

  const imagePx = $derived(artifacts?.tree.imagePx ?? null)
  const sourceUrl = $derived(artifacts?.sourceImageUrl ?? null)

  function shortRef(ref: string): string {
    return `${ref.slice(0, 8)}…`
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="strategy-canvas-panel">
  <div class="bg-background/80 flex h-11 shrink-0 items-center gap-3 border-b px-3 text-xs backdrop-blur">
    <label class="flex items-center gap-1.5" data-testid="strategy-base-toggle-wrap">
      <input
        type="checkbox"
        checked={baseVisible}
        onchange={(event) => setBaseImageVisible(event.currentTarget.checked)}
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
          oninput={(event) => setBaseImageOpacity(Number(event.currentTarget.value))}
          class="accent-primary h-1.5 w-24"
          data-testid="strategy-base-opacity"
          aria-label="原图透明度"
        />
        <span class="font-mono tabular-nums">{Math.round(baseOpacity * 100)}%</span>
      </label>
    {:else}
      <span class="text-muted-foreground/70" data-testid="strategy-base-missing" title="ObjectTree 工件缺 imageBlobRef 字段（P3.1 已登记）——UI 能从任务输入图拿到时经 sourceImageUrl 位补入">
        原图未挂接（树工件缺 imageBlobRef——P3.1 登记缺口）
      </span>
    {/if}
    <label class="flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={showBoxes}
        onchange={(event) => setShowBoxes(event.currentTarget.checked)}
        class="accent-primary size-3.5"
        data-testid="strategy-boxes-toggle"
      />
      <span>图层框线</span>
    </label>
    <span class="text-muted-foreground ml-auto font-mono" data-testid="strategy-gem-count">
      {artifacts === null ? '' : `${gems.length} 颗 · ${artifacts.gems.excludedRegions.length} 处留白 · ${ppm.exact ? `ppm=${ppm.ppm.toFixed(2)}` : 'ppm≈1（纵横比不吻合）'}`}
    </span>
  </div>

  <div class="bg-muted/50 relative min-h-0 flex-1 overflow-hidden p-3">
    {#if artifacts === null}
      <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 text-center text-sm" data-testid="strategy-canvas-empty">
        {#if loading}
          <p class="animate-pulse">策略工件装载中…</p>
        {:else if loadError !== null}
          <p class="text-destructive" data-testid="strategy-canvas-error">{loadError}</p>
        {:else}
          <p class="font-medium">当前会话尚无策略工件</p>
          <p class="text-xs">在左侧对话发起旅程：上传图 + cm 尺寸 → 识图抠图 → strategy.design</p>
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
        <!-- 层 1：原图（imageBlobRef 缺口降级——见工具栏注记） -->
        {#if sourceUrl !== null && baseVisible}
          <image href={sourceUrl} x="0" y="0" width={imagePx.width} height={imagePx.height} opacity={baseOpacity} data-testid="strategy-base-image" />
        {/if}

        <!-- 层 2：object-tree 预览框线（排除/不值得贴=红虚线） -->
        {#if showBoxes}
          {#each boxes as { node, excluded } (node.id)}
            <rect
              x={node.bbox.x}
              y={node.bbox.y}
              width={node.bbox.w}
              height={node.bbox.h}
              fill="none"
              stroke={excluded ? '#dc2626' : '#2563eb'}
              stroke-width={Math.max(imagePx.width, imagePx.height) / 400}
              stroke-dasharray={excluded ? `${imagePx.width / 100} ${imagePx.width / 150}` : undefined}
              data-testid="strategy-node-box"
              data-node-id={node.id}
            ></rect>
            <text
              x={node.bbox.x + node.bbox.w / 2}
              y={node.bbox.y - imagePx.height / 200}
              text-anchor="middle"
              font-size={Math.max(imagePx.width, imagePx.height) / 28}
              fill={excluded ? '#b91c1c' : '#1d4ed8'}
              data-testid="strategy-node-label"
            >{node.objectName}{excluded ? '（不贴）' : ''}</text>
          {/each}
        {/if}

        <!-- 层 3：strategy gems 点阵 -->
        {#each gems as gem (gem.id)}
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
