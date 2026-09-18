<!--
Orthogonal intents (max 4):
1. [2026-09-18 Compare/N4] 五策略对比：桌面横排 min-w-36 snap-x（vision #10 去竖折），整卡点击=设为导出策略，
     选中卡 ring+Check 明示「导出策略」唯一真源；点画布放大（Dialog）。桌面卡紧凑化：预览 h-32 固定高 + 紧凑卡头，
     卡高 ~190（240→~190，800px 视口内画布+摘要+策略行同屏）。
2. [2026-09-18 R4/N5] 移动端 carousel：策略 chips 横滑 + 当前策略单卡大图（停驻=导出策略）；
     选中 chip 自动滚入视野中央（inline:center），右缘选中不再被裁半。
3. [2026-09-18 IA-移交1] 动作分组：预览模式+参考图+透明度 = 一组（看什么）；边界松弛/斥力修复 = 一组（修复）。
4. [2026-09-18 N2'] 预览底色纯白：纯钻点模式下深色钻点在 240px 预览可辨（钻点保持原色，只改底）。
-->

<script lang="ts">
  import * as Card from '$lib/components/ui/card'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import { Switch } from '$lib/components/ui/switch'
  import { STRATEGY_IDS, type StrategyId } from '$lib/engine'
  import { paintGems, paintingImageData } from './gemPaint'
  import {
    STRATEGY_LABELS,
    clearReferenceImage,
    getActiveStrategy,
    getBlocks,
    getComputeProgress,
    getComputing,
    getGrid,
    getOverlayOpacity,
    getPainting,
    getPalette,
    getPreviewMode,
    getReferenceImage,
    getRelax,
    getResults,
    setOverlayOpacity,
    setPreviewMode,
    setRelax,
    setActiveStrategy,
    setReferenceFile,
    type PreviewMode,
    type StrategyResult,
  } from '$lib/stores/studio.svelte'
  import Check from '@lucide/svelte/icons/check'
  import Upload from '@lucide/svelte/icons/upload'
  import Eye from '@lucide/svelte/icons/eye'

  const results = $derived(getResults())
  const relax = $derived(getRelax())
  const mode = $derived(getPreviewMode())
  const reference = $derived(getReferenceImage())
  const computing = $derived(getComputing())
  const progress = $derived(getComputeProgress())
  const activeStrategy = $derived(getActiveStrategy())
  const activeRes = $derived(results[activeStrategy])

  let zoomStrategy = $state<StrategyId | null>(null)
  let opacityValue = $state(0.5)
  // 滑杆镜像：值未变化不写，防止受控往返回路
  $effect(() => {
    const next = getOverlayOpacity()
    if (next !== opacityValue) opacityValue = next
  })
  const opacity = $derived(opacityValue)

  let cellCanvases: Partial<Record<StrategyId, HTMLCanvasElement | null>> = {}
  let dialogCanvas = $state<HTMLCanvasElement | null>(null)
  let sectionEl = $state<HTMLDivElement | null>(null)
  let activeCanvasEl = $state<HTMLCanvasElement | null>(null)

  // 底图层：数字油画像素 → 离屏 canvas（分块不变时复用）
  let paintLayer: HTMLCanvasElement | null = null
  $effect(() => {
    const p = getPainting()
    if (!p) {
      paintLayer = null
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = p.width
    canvas.height = p.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      paintLayer = null
      return
    }
    ctx.putImageData(paintingImageData(p), 0, 0)
    paintLayer = canvas
    renderAll()
  })

  // 参考原图 → Image 元素（渲染层专用）
  let refImg: HTMLImageElement | null = null
  $effect(() => {
    const ref = getReferenceImage()
    if (!ref) {
      refImg = null
      renderAll()
      return
    }
    const img = new Image()
    img.onload = () => {
      refImg = img
      renderAll()
    }
    img.src = ref.dataUrl
    return () => {
      refImg = null
    }
  })

  function renderPreview(canvas: HTMLCanvasElement | null, res: StrategyResult | null): void {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const p = getPainting()
    const cssW = canvas.clientWidth || 240
    const cssH = canvas.clientHeight || 240
    const dpr = window.devicePixelRatio || 1
    const bw = Math.round(cssW * dpr)
    const bh = Math.round(cssH * dpr)
    if (canvas.width !== bw) canvas.width = bw
    if (canvas.height !== bh) canvas.height = bh
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    if (!p) return

    const W = p.width
    const H = p.height
    const s = Math.min(cssW / W, cssH / H)
    const ox = (cssW - W * s) / 2
    const oy = (cssH - H * s) / 2

    if (mode !== 'gems') {
      ctx.globalAlpha = opacity
      if (mode === 'painting' && paintLayer) ctx.drawImage(paintLayer, ox, oy, W * s, H * s)
      if (mode === 'reference' && refImg) ctx.drawImage(refImg, ox, oy, W * s, H * s)
      ctx.globalAlpha = 1
    }

    paintGems(ctx, res?.gems ?? [], getPalette(), getBlocks(), getGrid(), { scale: s, ox, oy })
  }

  function renderAll(): void {
    for (const sid of STRATEGY_IDS) renderPreview(cellCanvases[sid] ?? null, results[sid])
    renderPreview(activeCanvasEl, results[activeStrategy])
    if (zoomStrategy && dialogCanvas) renderPreview(dialogCanvas, results[zoomStrategy])
  }

  // 依赖变化 → 全量重渲染
  $effect(() => {
    void results
    void mode
    void opacity
    void getGrid()
    void getPalette()
    void getBlocks()
    void getActiveStrategy()
    void dialogCanvas
    void activeCanvasEl
    void cssTick
    renderAll()
  })

  let cssTick = $state(0)
  $effect(() => {
    const el = sectionEl
    if (!el) return
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      cssTick++
    })
    ro.observe(el)
    return () => ro.disconnect()
  })

  // N5 选中策略 chip 滚入视野中央：右缘选中不再被裁半（jsdom 无 scrollIntoView，可选调用兜底）。
  // 挂 cssTick（ResizeObserver）：桌面挂载时 carousel 是 display:none，scrollIntoView 为 no-op，
  // 布局切换到移动后必须借容器 resize 重跑一次。
  const chipEls: Partial<Record<StrategyId, HTMLButtonElement | null>> = {}
  $effect(() => {
    const active = getActiveStrategy()
    void cssTick
    const el = chipEls[active]
    if (el && el.offsetParent !== null) {
      el.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }
  })

  const MODE_LABELS: Record<PreviewMode, string> = { gems: '纯钻点', painting: '叠数字油画', reference: '叠原图' }

  function onModeClick(next: PreviewMode): void {
    if (next === 'reference' && !reference) return
    setPreviewMode(next)
  }

  async function onReferenceUpload(e: Event): Promise<void> {
    const input = e.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    if (file) await setReferenceFile(file)
    input.value = ''
  }
</script>

<div bind:this={sectionEl} class="grid gap-3" data-testid="compare-grid" id="strategy-compare">
  <!-- 区头（vision #19 与画廊/导出条同语言）+ 修复开关组 -->
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
    <h2 class="text-sm font-semibold tracking-tight">策略对比</h2>
    {#if computing}
      <Badge variant="secondary">{progress ? `${progress.label} ${progress.done}/${progress.total}` : '重算中…'}</Badge>
    {/if}
    <div class="ml-auto flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-1.5">
        <Switch size="sm" checked={relax.boundary} onCheckedChange={(v) => setRelax({ boundary: v })} />
        <span class="text-muted-foreground">边界松弛</span>
      </label>
      <label class="flex items-center gap-1.5">
        <Switch size="sm" checked={relax.repulsion} onCheckedChange={(v) => setRelax({ repulsion: v })} />
        <span class="text-muted-foreground">斥力修复</span>
      </label>
    </div>
  </div>

  <!-- 预览组：三模式 pills + 参考图动作 + 透明度（与修复组分离，IA 移交项 1） -->
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <div class="flex flex-wrap items-center gap-1">
      {#each Object.entries(MODE_LABELS) as [m, label] (m)}
        <Button
          size="xs"
          variant={mode === m ? 'default' : 'secondary'}
          disabled={m === 'reference' && !reference}
          title={m === 'reference' && !reference ? '先上传/送转化带过参考原图' : `切换预览：${label}`}
          onclick={() => onModeClick(m as PreviewMode)}
        >
          {label}
        </Button>
      {/each}
    </div>
    <label class="cursor-pointer">
      <span
        class="border-input bg-background hover:bg-muted hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium shadow-xs transition-colors"
      >
        <Upload class="size-3.5" />
        上传原图
      </span>
      <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={onReferenceUpload} />
    </label>
    {#if reference}
      <Button size="xs" variant="ghost" onclick={clearReferenceImage} title="移除参考原图">清除原图</Button>
    {/if}
    {#if mode !== 'gems'}
      <label class="flex min-w-56 flex-1 items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">底图不透明度</span>
        <Slider
          type="single"
          bind:value={opacityValue}
          onValueChange={(v) => setOverlayOpacity(v ?? 0.5)}
          min={0}
          max={1}
          step={0.01}
          class="h-9 flex-1"
        />
        <span class="text-muted-foreground w-10 shrink-0 text-right font-mono tabular-nums">{Math.round(opacity * 100)}%</span>
      </label>
    {/if}
  </div>

  <!-- 桌面：五卡横排 snap-x；整卡点击=设为导出策略（唯一真源）；选中=ring+Check -->
  <div class="scrollbar-thin hidden gap-3 overflow-x-auto snap-x pb-1 lg:flex" data-testid="strategy-row-desktop">
    {#each STRATEGY_IDS as sid (sid)}
      {@const res = results[sid]}
      {@const active = sid === activeStrategy}
      <Card.Root
        class="min-w-36 shrink-0 snap-start cursor-pointer transition-shadow p-0 {active
          ? 'bg-accent/50 ring-primary ring-1'
          : 'hover:shadow-sm'}"
        onclick={() => setActiveStrategy(sid)}
        title={active ? '当前导出策略（点击其它卡可切换）' : '点击设为导出策略'}
        data-testid="strategy-card-{sid}"
      >
        <Card.Header class="relative px-2.5 pt-2 pb-1">
          {#if active}
            <span
              class="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full"
              title="当前导出策略"
            >
              <Check class="size-3" />
            </span>
          {/if}
          <Card.Title class="flex items-center gap-1.5 text-xs whitespace-nowrap">
            {STRATEGY_LABELS[sid]}
            <span class="text-muted-foreground font-mono text-[10px] font-normal">{sid}</span>
          </Card.Title>
          <Card.Description class="flex flex-wrap items-center gap-1 text-[10px]">
            {#if res}
              {#if res.error}
                <Badge variant="destructive">失败</Badge>
              {:else}
                <span class="font-mono tabular-nums">{res.gems.length} 钻 · {Math.round(res.durationMs)}ms</span>
                {#if res.spacingCount > 0}
                  <Badge variant="destructive">间距违规 {res.spacingCount}</Badge>
                {:else}
                  <Badge variant="secondary">间距合规</Badge>
                {/if}
                {#if res.dropped > 0}
                  <Badge variant="outline" title="布局终局为满足最小间距硬约束自动剔除的钻数">剔除 {res.dropped}</Badge>
                {/if}
              {/if}
            {:else}
              <span class="text-muted-foreground">{computing ? '计算中…' : '待计算'}</span>
            {/if}
          </Card.Description>
        </Card.Header>
        <Card.Content class="px-2.5 pt-0 pb-2">
          <canvas
            bind:this={cellCanvases[sid]}
            class="block h-32 w-full cursor-zoom-in rounded-md bg-white"
            onclick={(e) => {
              e.stopPropagation()
              zoomStrategy = sid
            }}
            data-testid="strategy-canvas-{sid}"
          ></canvas>
        </Card.Content>
      </Card.Root>
    {/each}
  </div>

  <!-- 移动端 carousel：chips 横滑 + 当前策略单卡（停驻=导出策略） -->
  <div class="grid gap-2 lg:hidden" data-testid="strategy-carousel">
    <div class="scrollbar-thin flex gap-1.5 overflow-x-auto pb-1">
      {#each STRATEGY_IDS as sid (sid)}
        {@const res = results[sid]}
        <button
          type="button"
          bind:this={chipEls[sid]}
          class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs whitespace-nowrap transition-colors {sid === activeStrategy
            ? 'border-primary bg-accent/50 font-medium'
            : 'bg-card text-muted-foreground'}"
          onclick={() => setActiveStrategy(sid)}
          aria-pressed={sid === activeStrategy}
          data-testid="strategy-chip-{sid}"
        >
          {#if sid === activeStrategy}
            <Check class="text-primary size-3.5" />
          {/if}
          {STRATEGY_LABELS[sid]}
          {#if res && !res.error}
            <span class="font-mono tabular-nums">{res.gems.length}</span>
          {/if}
        </button>
      {/each}
    </div>
    <Card.Root class="overflow-hidden p-0" data-testid="strategy-card-active">
      <Card.Content class="relative p-2">
        <canvas
          bind:this={activeCanvasEl}
          class="block aspect-square w-full cursor-zoom-in rounded-md bg-white"
          onclick={() => (zoomStrategy = activeStrategy)}
          data-testid="strategy-canvas-active"
        ></canvas>
        <div class="text-muted-foreground absolute bottom-3 left-4 flex items-center gap-1 text-[11px]">
          <Eye class="size-3.5" />
          点击放大
        </div>
      </Card.Content>
      <Card.Footer class="flex flex-wrap items-center gap-1.5 px-3 py-2 text-[11px]">
        <span class="font-medium">{STRATEGY_LABELS[activeStrategy]}</span>
        {#if activeRes}
          {#if activeRes.error}
            <Badge variant="destructive">失败</Badge>
          {:else}
            <span class="font-mono tabular-nums">{activeRes.gems.length} 钻 · {Math.round(activeRes.durationMs)}ms</span>
            {#if activeRes.spacingCount > 0}
              <Badge variant="destructive">间距违规 {activeRes.spacingCount}</Badge>
            {:else}
              <Badge variant="secondary">间距合规</Badge>
            {/if}
            {#if activeRes.dropped > 0}
              <Badge variant="outline">剔除 {activeRes.dropped}</Badge>
            {/if}
          {/if}
        {:else}
          <span class="text-muted-foreground">{computing ? '计算中…' : '待计算'}</span>
        {/if}
        <span class="text-muted-foreground ml-auto">停驻卡片 = 导出策略</span>
      </Card.Footer>
    </Card.Root>
  </div>
</div>

<Dialog.Root
  open={zoomStrategy !== null}
  onOpenChange={(open) => {
    if (!open) zoomStrategy = null
  }}
>
  <Dialog.Content class="max-w-3xl">
    <Dialog.Header>
      <Dialog.Title class="text-sm">
        {zoomStrategy ? `${STRATEGY_LABELS[zoomStrategy]}（${zoomStrategy}）` : ''}
      </Dialog.Title>
      <Dialog.Description>
        {#if zoomStrategy && results[zoomStrategy]}
          {results[zoomStrategy]!.gems.length} 钻 · {Math.round(results[zoomStrategy]!.durationMs)}ms ·
          spacing 违规 {results[zoomStrategy]!.spacingCount} · 底图：{MODE_LABELS[mode]}
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <canvas
      bind:this={dialogCanvas}
      class="block max-h-[70vh] w-full bg-white"
      data-testid="strategy-dialog-canvas"
    ></canvas>
  </Dialog.Content>
</Dialog.Root>
