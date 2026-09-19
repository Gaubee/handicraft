<!--
Orthogonal intents (max 4):
1. [2026-09-19 Layout 2.2] 胶片带（五区之一，h-14）：五策略 chips（中文名 + 钻数 + 合规点 ✓/⚠N + 选中高亮）；
     点击 chip = setActiveStrategy 唯一写入点（单真源纪律平移，状态条只读回显）。
2. [2026-09-19 Mobile 4.1] 移动端横滑（overflow-x-auto，停驻 ≠ 选中——滚动不产生任何写入，点按才切换）。
3. [2026-09-19 状态矩阵] 重算中：数字变灰 + 无结果位 spinner（computing → 转 spinner；进度徽标在状态条，此处不重复）；
     点击 chip = 切换 activeStrategy 引用（既有结果秒切，无等待期 → 点击本身不挂 busy）。
4. [2026-09-19 Renderer] hover 180px 浮卡预览经 drawPreview 纯函数（$lib/studio/previewRender.ts，签名冻结）；
     Image 解析/重绘调度/定位生命周期留本组件。[⤢对比] 为占位禁用（下一波 CompareOverlay）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { STRATEGY_IDS, type StrategyId } from '$lib/engine'
  import { drawPreview } from '$lib/studio/previewRender'
  import {
    STRATEGY_LABELS,
    getActiveStrategy,
    getBlocks,
    getComputing,
    getGrid,
    getOverlayOpacity,
    getPainting,
    getPalette,
    getPreviewMode,
    getReferenceImage,
    getResults,
    setActiveStrategy,
  } from '$lib/stores/studio.svelte'
  import Check from '@lucide/svelte/icons/check'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'

  const results = $derived(getResults())
  const computing = $derived(getComputing())
  const activeStrategy = $derived(getActiveStrategy())
  const painting = $derived(getPainting())

  // ---- hover 浮卡（桌面）：180px 预览，绘制经 drawPreview 纯函数 ----
  let hoverSid = $state<StrategyId | null>(null)
  let hoverLeft = $state(0)
  let rowEl = $state<HTMLDivElement | null>(null)
  let previewCanvas = $state<HTMLCanvasElement | null>(null)

  function showHover(sid: StrategyId, chip: HTMLElement): void {
    hoverSid = sid
    const row = rowEl
    if (!row) {
      hoverLeft = 0
      return
    }
    // 浮卡锚定胶片带根（relative），left 换算到 chips 行坐标系（滚动安全）
    const cr = chip.getBoundingClientRect()
    const rr = row.getBoundingClientRect()
    hoverLeft = cr.left - rr.left
  }

  // 参考原图 → Image 元素（组件层生命周期；drawPreview 只收位图）
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

  // 依赖变化 → 浮卡重绘（painting/results/palette/blocks/背景源与透明度/位图/canvas 挂载）
  // [2.6] PreviewRenderInput v2 层化（组件废除归 2.7；浮卡 = 单层 selected 等价形态）
  $effect(() => {
    const canvas = previewCanvas
    const sid = hoverSid
    if (!canvas || !sid) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const mode = getPreviewMode()
    const opacity = getOverlayOpacity()
    drawPreview(ctx, {
      background: {
        source: mode === 'gems' ? 'none' : mode,
        opacity,
        painting,
        referenceBitmap: refImg,
      },
      layers: [{ id: 'preview', visible: true, selected: true, result: getResults()[sid] }],
      palette: getPalette(),
      blocks: getBlocks(),
      pixelsPerMm: getGrid().pixelsPerMm,
      size: { width: canvas.clientWidth || 180, height: canvas.clientHeight || 180 },
      dpr: window.devicePixelRatio || 1,
    })
  })
</script>

<div
  class="bg-background/95 relative flex h-14 shrink-0 items-center gap-2 border-t px-3 backdrop-blur lg:px-4"
  data-testid="strategy-film-strip"
>
  <!-- 五策略 chips：唯一写入点（点击=设为导出策略）；移动端横滑，停驻不写入 -->
  <div
    bind:this={rowEl}
    role="presentation"
    class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    onmouseleave={() => (hoverSid = null)}
    data-testid="strategy-chip-row"
  >
    {#each STRATEGY_IDS as sid (sid)}
      {@const res = results[sid]}
      {@const active = sid === activeStrategy}
      {@const failed = !!res?.error}
      {@const hasCount = !!res && !res.error}
      {@const dim = computing || !res}
      <button
        type="button"
        class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs whitespace-nowrap transition-colors {active
          ? 'border-primary bg-accent/50 font-medium'
          : 'bg-card text-muted-foreground hover:bg-muted/50'}"
        onclick={() => setActiveStrategy(sid)}
        onmouseenter={(e) => {
          if (e.currentTarget instanceof HTMLElement) showHover(sid, e.currentTarget)
        }}
        onfocus={(e) => {
          if (e.currentTarget instanceof HTMLElement) showHover(sid, e.currentTarget)
        }}
        onblur={() => (hoverSid = null)}
        aria-pressed={active}
        title="{STRATEGY_LABELS[sid]}（{sid}）· 点击设为导出策略"
        data-testid="strategy-chip-{sid}"
        data-count={hasCount ? res.gems.length : ''}
      >
        {#if active}
          <Check class="text-primary size-3.5" aria-hidden="true" />
        {/if}
        <span>{STRATEGY_LABELS[sid]}</span>
        {#if hasCount}
          <span class="font-mono text-[11px] tabular-nums {dim ? 'text-muted-foreground/50' : ''}">
            {res.gems.length.toLocaleString()}
          </span>
          {#if res.spacingCount > 0}
            <span class="text-destructive font-medium" title="间距违规 {res.spacingCount}">
              ⚠{res.spacingCount}
            </span>
          {:else}
            <span class="text-emerald-600 dark:text-emerald-400" title="间距合规">✓</span>
          {/if}
        {:else if failed}
          <span class="text-destructive" title={res?.error}>失败</span>
        {:else if computing}
          <!-- [2026-09-19 Busy] 无缓存结果的策略位：计算轮在途 → chip 内 spinner（点击切换始终秒切，无等待期） -->
          <LoaderCircle class="text-muted-foreground/60 size-3 shrink-0 animate-spin" aria-hidden="true" />
        {:else}
          <span class="text-muted-foreground/60 font-mono text-[11px]">—</span>
        {/if}
      </button>
    {/each}
  </div>

  <!-- hover 180px 浮卡（桌面；pointer-events-none 不挡点按），绘制经 drawPreview -->
  {#if hoverSid}
    <div
      class="pointer-events-none absolute bottom-full z-30 mb-2 hidden lg:block"
      style="left: {Math.max(hoverLeft - 4, 0)}px"
      data-testid="strategy-hover-card"
    >
      <div class="rounded-lg border bg-card p-1 shadow-lg">
        <canvas bind:this={previewCanvas} class="block h-[180px] w-[180px] rounded-md bg-white"></canvas>
        <p class="text-muted-foreground flex items-center justify-between px-1 pt-1 text-[10px]">
          <span class="font-medium">{STRATEGY_LABELS[hoverSid]}</span>
          {#if results[hoverSid] && !results[hoverSid]!.error}
            <span class="font-mono tabular-nums">{results[hoverSid]!.gems.length.toLocaleString()} 钻</span>
          {/if}
        </p>
      </div>
    </div>
  {/if}

  <!-- 对比模式入口：占位禁用（CompareOverlay 属下一波任务 3.x） -->
  <Button
    size="xs"
    variant="outline"
    disabled
    title="大图对比覆盖层即将上线（CompareOverlay）"
    class="hidden shrink-0 lg:inline-flex"
    data-testid="compare-overlay-entry"
  >
    <Maximize2 />
    对比
  </Button>
</div>
