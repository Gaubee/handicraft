<!--
Orthogonal intents (max 3):
1. [2026-09-18 R3 PM-B5] 「共 N 钻」答案位：导出条是钻数唯一大数字位（font-mono tabular-nums），
     其余处（全局预估/策略卡）降为辅助口径。
2. [2026-09-18 R3 PM-B4/P0-2] 策略只读回显：移除策略 Select（双真源之一），「更改」锚点滚回对比网格；
     设置 activeStrategy 的 UI 入口全应用唯一 = 对比网格选中卡。
3. [2026-09-18 Gate] 导出前全量 validate：isExportable=false（spacing/mask 违规）禁用按钮并列出清单；
     BOM 摘要 chips（色名×数量）。PNG 光栅化底图模式跟随预览选择。
-->

<script lang="ts">
  import * as Card from '$lib/components/ui/card'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import {
    STRATEGY_LABELS,
    buildActiveBom,
    buildActiveSvg,
    exportFileName,
    getActiveResult,
    getActiveStrategy,
    getBomSummary,
    getBlocks,
    getExportCheck,
    getGrid,
    getPainting,
    getPalette,
    getPreviewMode,
    getReferenceImage,
  } from '$lib/stores/studio.svelte'
  import { paintGems, paintingImageData } from './gemPaint'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'

  const strategy = $derived(getActiveStrategy())
  const result = $derived(getActiveResult())
  const check = $derived(getExportCheck())
  const bom = $derived(getBomSummary())

  const blocked = $derived(!check.ready || !check.exportable)

  /** 「更改」→ 滚回对比网格（策略唯一设置入口；jsdom 无 scrollIntoView，可选调用兜底） */
  function gotoCompare(): void {
    document.getElementById('strategy-compare')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  function exportSvg(): void {
    const blob = buildActiveSvg()
    if (blob) downloadBlob(blob, exportFileName('svg'))
  }

  function exportBom(): void {
    const blob = buildActiveBom()
    if (blob) downloadBlob(blob, exportFileName('csv'))
  }

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('参考原图解码失败'))
      img.src = src
    })
  }

  /** PNG 光栅化：画布 = 数字油画像素尺寸；底图跟随预览模式，钻位圆点按色板着色 */
  async function buildPng(): Promise<Blob | null> {
    const p = getPainting()
    const res = result
    if (!p || !res || blocked) return null
    const canvas = document.createElement('canvas')
    canvas.width = p.width
    canvas.height = p.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const mode = getPreviewMode()
    if (mode === 'painting') {
      ctx.putImageData(paintingImageData(p), 0, 0)
    } else if (mode === 'reference') {
      const ref = getReferenceImage()
      if (ref) {
        try {
          ctx.drawImage(await loadImage(ref.dataUrl), 0, 0, p.width, p.height)
        } catch {
          // 底图失败不阻断钻位导出
        }
      }
    }

    paintGems(ctx, res.gems, getPalette(), getBlocks(), getGrid())
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    })
  }

  async function exportPng(): Promise<void> {
    const blob = await buildPng()
    if (blob) downloadBlob(blob, exportFileName('png'))
  }
</script>

<Card.Root data-testid="export-bar">
  <Card.Header>
    <Card.Title class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      导出
      <!-- 策略只读回显（唯一设置入口在对比网格） -->
      <span class="text-muted-foreground inline-flex items-center gap-1 text-xs">
        策略：
        <span class="text-foreground font-medium">{STRATEGY_LABELS[strategy]}</span>
        <span class="font-mono text-[10px]">({strategy})</span>
        <button
          type="button"
          class="text-primary hover:underline underline-offset-2"
          onclick={gotoCompare}
          data-testid="export-strategy-change"
        >
          更改
        </button>
      </span>

      {#if result && !result.error}
        <!-- 「要买多少钻」的答案位：唯一大数字 -->
        <span class="font-mono text-xl font-semibold tabular-nums" data-testid="export-gem-count">
          {result.gems.length.toLocaleString()}
          <span class="text-muted-foreground text-sm font-normal">钻</span>
        </span>
        {#if result.dropped > 0}
          <span class="text-muted-foreground text-xs">（已自动剔除 {result.dropped} 颗冲突钻）</span>
        {/if}
      {:else}
        <span class="text-muted-foreground text-xs">无结果</span>
      {/if}

      {#if check.ready && check.exportable}
        <Badge variant="secondary">校验通过 · 可导出</Badge>
      {:else if check.ready}
        <Badge variant="destructive">校验违规 · 禁止导出</Badge>
      {/if}
    </Card.Title>
    <Card.Description>
      导出前执行全量校验（间距 / 掩码 / 孤岛）；BOM 合计 = 总钻数。
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid gap-3">
    {#if bom.length > 0}
      <div class="flex flex-wrap items-center gap-1.5 text-xs" data-testid="bom-summary">
        {#each bom as entry (entry.id)}
          <span class="border-input inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
            <span class="size-2.5 rounded-sm border" style="background: {entry.hex}"></span>
            {entry.name} <span class="font-mono tabular-nums">× {entry.count}</span>
          </span>
        {/each}
      </div>
    {/if}

    {#if check.ready && check.warnings.length > 0}
      <div class="grid gap-1">
        <p class="text-destructive text-xs font-medium">
          违规 {check.warnings.length} 条（spacing / mask 违规阻断导出）：
        </p>
        <div class="scrollbar-thin max-h-28 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 p-2">
          <ul class="grid gap-0.5 text-[11px] leading-relaxed">
            {#each check.warnings as w, i (i)}
              <li class="text-destructive">
                [{w.kind}] {w.detail}
              </li>
            {/each}
          </ul>
        </div>
      </div>
    {:else if check.ready}
      <p class="text-muted-foreground text-xs">校验无警告（孤岛/间距/掩码全通过）。</p>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={blocked} onclick={exportSvg}>导出 SVG</Button>
      <Button size="sm" disabled={blocked} onclick={exportBom}>导出 BOM CSV</Button>
      <Button size="sm" disabled={blocked} onclick={() => void exportPng()}>导出 PNG</Button>
      {#if blocked}
        <span class="text-muted-foreground flex items-center gap-1 text-xs">
          <ArrowDown class="size-3.5" />
          {check.ready ? '修复 spacing / mask 违规（调整密度/开启斥力修复）后可导出' : '等待布局结果'}
        </span>
      {/if}
    </div>
  </Card.Content>
</Card.Root>
