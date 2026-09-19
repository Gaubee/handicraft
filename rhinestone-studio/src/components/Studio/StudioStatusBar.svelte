<!--
Orthogonal intents (max 4):
1. [2026-09-19 Layout 2.3] 状态条（五区之一，h-12，常驻答案位）：共 N 钻大数字（唯一大数字位）+ 策略只读回显
     （单真源：写入点只在胶片带，本条零写入）+ 校验徽标 + BOM 前 3 色…▾ + 导出组（SVG/BOM CSV/PNG）+ 送精修。
     [2026-09-19 Busy] 导出三键与送精修在生成/下载/烘焙期间 button 承载 busy（spinner+disabled+aria-busy，先让一帧再算）。
2. [2026-09-19 Gate] 导出门语义与 ExportBar 完全一致：!ready || !exportable → 禁用并列出清单（spacing/mask 违规阻断）；
     违规时红徽标 + [边界松弛][斥力修复] 直达开关 + 违规清单 ▾（PM §3.2：修复动作就近化）。
3. [2026-09-19 Mobile 4.1] 移动端导出组收进「导出▾」菜单（含送精修）；[⤢对比] 占位禁用。视口分支用 matchMedia
     （jsdom 恒桌面分支，测试选择器单实例稳定）。
4. [2026-09-19 状态矩阵] worker 进度徽标 + 取消按钮迁入状态条（原画布下摘要条位）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import {
    STRATEGY_LABELS,
    archiveExportedPng,
    buildActiveBom,
    buildActiveSvg,
    buildManualEditHandoff,
    cancelCompute,
    currentSourceSummary,
    exportFileName,
    getActiveResult,
    getActiveStrategy,
    getBomSummary,
    getBlocks,
    getComputeProgress,
    getComputing,
    getExportCheck,
    getGrid,
    getBackgroundObservation,
    getPainting,
    getPalette,
    getReferenceImage,
    getRelax,
    setRelax,
  } from '$lib/stores/studio.svelte'
  import { isEditDirty, loadFromHandoff } from '$lib/stores/edit.svelte'
  import { setView } from '$lib/stores/view.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { paintGems, paintingImageData } from './gemPaint'
  import ButtonBusy from './ButtonBusy.svelte'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'
  import PenLine from '@lucide/svelte/icons/pen-line'

  const strategy = $derived(getActiveStrategy())
  const result = $derived(getActiveResult())
  const check = $derived(getExportCheck())
  const bom = $derived(getBomSummary())
  const computing = $derived(getComputing())
  const progress = $derived(getComputeProgress())
  const relax = $derived(getRelax())
  const violations = $derived(check.ready ? check.warnings.length : 0)

  const blocked = $derived(!check.ready || !check.exportable)

  // ---- 移动端「导出▾」菜单 / 违规清单 / BOM 全量清单（向上浮出，状态条定高不增长） ----
  let exportMenuOpen = $state(false)
  let violationListOpen = $state(false)
  let bomListOpen = $state(false)

  // 视口分支（与 StudioView 同口径）：jsdom 无布局 → 恒桌面分支，测试选择器单实例
  function prefersMobileViewport(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1023px)').matches
      : false
  }
  let isMobileViewport = $state(prefersMobileViewport())
  $effect(() => {
    const onResize = (): void => {
      isMobileViewport = prefersMobileViewport()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  // ---- 送精修（add-manual-edit-mode tasks 3.x）：显式 ManualEditHandoff → 编辑文档 ----
  // 编辑中文档未保存（dirty 口径，add-project-files A.2.3 连锁修正）→ 覆盖确认弹窗
  // （design.md §1：再次送精修 = 覆盖确认；undoCount 回归纯撤销可用性）
  let overwriteConfirmOpen = $state(false)

  const canSendToEdit = $derived(!!result && !result.error)

  function requestSendToEdit(): void {
    if (!canSendToEdit || sendBusy) return
    if (isEditDirty()) {
      overwriteConfirmOpen = true
      return
    }
    void performSendToEdit()
  }

  // ---- [2026-09-19 Busy] 导出/送精修 button 承载：生成+下载/烘焙期间 spinner + disabled + aria-busy ----
  // nextPaint：先让出一帧让 spinner 绘制，再进入（大图下）同步重的生成段
  function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })
  }

  let exportBusy = $state({ svg: false, bom: false, png: false })
  let sendBusy = $state(false)

  async function performSendToEdit(): Promise<void> {
    if (sendBusy) return
    sendBusy = true
    try {
      await nextPaint()
      const handoff = buildManualEditHandoff()
      if (!handoff) return
      loadFromHandoff(handoff)
      overwriteConfirmOpen = false
      exportMenuOpen = false
      setView('edit')
      showToast('已送入专家工作台（烘焙快照，与排钻设计参数隔离）')
    } finally {
      sendBusy = false
    }
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  async function exportSvg(): Promise<void> {
    if (exportBusy.svg) return
    exportBusy.svg = true
    try {
      await nextPaint()
      const blob = buildActiveSvg()
      if (blob) downloadBlob(blob, exportFileName('svg'))
    } finally {
      exportBusy.svg = false
    }
  }

  async function exportBom(): Promise<void> {
    if (exportBusy.bom) return
    exportBusy.bom = true
    try {
      await nextPaint()
      const blob = buildActiveBom()
      if (blob) downloadBlob(blob, exportFileName('csv'))
    } finally {
      exportBusy.bom = false
    }
  }

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('参考原图解码失败'))
      img.src = src
    })
  }

  /** PNG 光栅化：画布 = 数字油画像素尺寸；底图跟随预览模式，钻位圆点按色板着色（ExportBar 逻辑原样复用） */
  async function buildPng(): Promise<Blob | null> {
    const p = getPainting()
    const res = result
    if (!p || !res || blocked) return null
    const canvas = document.createElement('canvas')
    canvas.width = p.width
    canvas.height = p.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    // [2.5/2.6] 背景源收编 + 层化渲染（PNG 光栅化：背景源 → 底图；钻位 = 联合结果逐层）
    const background = getBackgroundObservation()
    if (background.source === 'painting') {
      ctx.putImageData(paintingImageData(p), 0, 0)
    } else if (background.source === 'reference') {
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
    if (exportBusy.png) return
    exportBusy.png = true
    try {
      await nextPaint()
      const blob = await buildPng()
      if (!blob) return
      downloadBlob(blob, exportFileName('png'))
      // [add-asset-library 6.3] 导出 PNG 入库 sys-exports（下载与入库解耦；失败仅跳过 toast）
      const p = getPainting()
      const archived = await archiveExportedPng(blob, currentSourceSummary(), p?.width ?? 0, p?.height ?? 0)
      if (archived) showToast('PNG 已导出 · 在素材库中查看')
    } finally {
      exportBusy.png = false
    }
  }
</script>

<footer
  class="bg-background flex h-12 shrink-0 items-center gap-2 overflow-x-auto px-3 lg:overflow-visible lg:px-4"
  data-testid="status-bar"
>
  <!-- 答案位：共 N 钻（唯一大数字）+ 剔除注记 + worker 进度（迁自画布下摘要条） -->
  <div class="flex shrink-0 items-center gap-2">
    {#if result && !result.error}
      <span class="font-mono text-lg leading-none font-semibold tabular-nums" data-testid="export-gem-count">
        {result.gems.length.toLocaleString()}
        <span class="text-muted-foreground text-xs font-normal">钻</span>
      </span>
      {#if result.dropped > 0}
        <span class="text-muted-foreground hidden text-[11px] sm:inline" title="布局终局为满足最小间距硬约束自动剔除的钻数">
          剔除 {result.dropped}
        </span>
      {/if}
    {:else}
      <span class="text-muted-foreground text-xs" data-testid="export-gem-count">
        {computing ? (progress?.label ?? '重算中…') : '待计算'}
      </span>
    {/if}

    {#if computing}
      <Badge variant="secondary" class="text-[10px]" data-testid="compute-badge">
        {progress ? `${progress.label} ${progress.done}/${progress.total}` : '重算中…'}
      </Badge>
      <Button
        variant="ghost"
        size="xs"
        class="text-muted-foreground h-6 px-1.5 text-[11px]"
        data-testid="compute-cancel"
        onclick={() => cancelCompute()}
      >
        取消
      </Button>
    {/if}
  </div>

  <!-- 策略只读回显（单真源：写入点只在胶片带） -->
  <span class="text-muted-foreground shrink-0 text-xs whitespace-nowrap" data-testid="status-strategy-echo">
    策略 · <span class="text-foreground font-medium">{STRATEGY_LABELS[strategy]}</span>
  </span>

  <!-- 校验徽标（+ 违规时修复直达与清单入口） -->
  {#if check.ready && check.exportable}
    <span
      class="shrink-0 rounded-full bg-emerald-600/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400"
      title="孤岛/间距/掩码校验全通过"
    >
      ✓ 间距合规
    </span>
  {:else if check.ready}
    <div class="relative shrink-0" data-testid="violation-cluster">
      <div class="flex items-center gap-1">
        <span class="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
          ✗ 违规 {violations}
        </span>
        <!-- 修复直达（PM §3.2：违规时就近化，迁自 CompareGrid 区头修复组） -->
        <button
          type="button"
          class="rounded-full border px-2 py-0.5 text-[11px] transition-colors {relax.boundary
            ? 'border-primary bg-accent/50 text-foreground'
            : 'text-muted-foreground hover:bg-muted'}"
          aria-pressed={relax.boundary}
          title="分块边界附近允许放宽间距（重算后生效）"
          onclick={() => setRelax({ boundary: !relax.boundary })}
          data-testid="relax-boundary"
        >
          边界松弛
        </button>
        <button
          type="button"
          class="rounded-full border px-2 py-0.5 text-[11px] transition-colors {relax.repulsion
            ? 'border-primary bg-accent/50 text-foreground'
            : 'text-muted-foreground hover:bg-muted'}"
          aria-pressed={relax.repulsion}
          title="对违规钻对施加斥力位移（重算后生效）"
          onclick={() => setRelax({ repulsion: !relax.repulsion })}
          data-testid="relax-repulsion"
        >
          斥力修复
        </button>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground shrink-0 text-[11px] underline-offset-2 hover:underline"
          onclick={() => (violationListOpen = !violationListOpen)}
          data-testid="violation-toggle"
        >
          清单 ▾
        </button>
      </div>
      {#if violationListOpen}
        <div
          class="scrollbar-thin absolute bottom-full left-0 z-30 mb-2 max-h-56 w-80 overflow-y-auto rounded-lg border border-destructive/30 bg-card p-2.5 shadow-lg"
          data-testid="violation-list"
        >
          <p class="text-destructive mb-1 text-xs font-medium">违规 {violations} 条（spacing / mask 违规阻断导出）：</p>
          <ul class="grid gap-0.5 text-[11px] leading-relaxed">
            {#each check.warnings as w, i (i)}
              <li class="text-destructive">[{w.kind}] {w.detail}</li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}

  <!-- BOM 摘要：前 3 色 + …▾（完整清单向上浮出） -->
  {#if bom.length > 0}
    <div class="relative hidden min-w-0 shrink sm:flex sm:items-center" data-testid="bom-summary">
      {#each bom.slice(0, 3) as entry (entry.id)}
        <span class="border-input mr-1 inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]">
          <span class="size-2.5 rounded-sm border" style="background: {entry.hex}"></span>
          {entry.name} <span class="font-mono tabular-nums">× {entry.count}</span>
        </span>
      {/each}
      {#if bom.length > 3}
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground shrink-0 text-[11px] underline-offset-2 hover:underline"
          onclick={() => (bomListOpen = !bomListOpen)}
          data-testid="bom-more"
        >
          等 {bom.length} 色 ▾
        </button>
        {#if bomListOpen}
          <div
            class="scrollbar-thin absolute bottom-full left-0 z-30 mb-2 max-h-56 w-72 overflow-y-auto rounded-lg border bg-card p-2.5 shadow-lg"
            data-testid="bom-list"
          >
            <div class="flex flex-wrap gap-1.5">
              {#each bom as entry (entry.id)}
                <span class="border-input inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]">
                  <span class="size-2.5 rounded-sm border" style="background: {entry.hex}"></span>
                  {entry.name} <span class="font-mono tabular-nums">× {entry.count}</span>
                </span>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- 导出组：桌面常驻按钮组 / 移动端收进「导出▾」菜单（jsdom 恒桌面分支，选择器单实例） -->
  {#if isMobileViewport}
    <div class="relative ml-auto flex shrink-0 items-center gap-1">
      <Button
        size="icon-xs"
        variant="ghost"
        disabled
        title="大图对比即将上线（CompareOverlay）"
        data-testid="compare-overlay-entry"
      >
        <Maximize2 />
      </Button>
      <Button size="xs" variant="outline" onclick={() => (exportMenuOpen = !exportMenuOpen)} data-testid="export-menu-toggle">
        导出
        <ChevronDown />
      </Button>
      {#if exportMenuOpen}
        <div
          class="absolute bottom-full right-0 z-30 mb-2 grid w-44 gap-1 rounded-lg border bg-card p-1.5 shadow-lg"
          data-testid="export-menu"
        >
          <ButtonBusy size="xs" disabled={blocked} busy={exportBusy.svg} onclick={() => void exportSvg()} data-testid="export-svg">导出 SVG</ButtonBusy>
          <ButtonBusy size="xs" disabled={blocked} busy={exportBusy.bom} onclick={() => void exportBom()} data-testid="export-bom">导出 BOM CSV</ButtonBusy>
          <ButtonBusy size="xs" disabled={blocked} busy={exportBusy.png} onclick={() => void exportPng()} data-testid="export-png">导出 PNG</ButtonBusy>
          <ButtonBusy size="xs" variant="outline" disabled={!canSendToEdit} busy={sendBusy} onclick={requestSendToEdit} data-testid="send-to-edit">
            <PenLine />
            送精修
          </ButtonBusy>
        </div>
      {/if}
    </div>
  {:else}
    <div class="ml-auto flex shrink-0 items-center gap-2">
      {#if blocked}
        <span class="text-muted-foreground hidden items-center gap-1 text-xs xl:flex" title="修复 spacing / mask 违规后可导出">
          <ArrowDown class="size-3.5" />
          {check.ready ? '修复违规后可导出' : '等待布局结果'}
        </span>
      {/if}
      <ButtonBusy size="sm" class="h-8 px-2.5 text-xs" disabled={blocked} busy={exportBusy.svg} onclick={() => void exportSvg()} data-testid="export-svg">SVG</ButtonBusy>
      <ButtonBusy size="sm" class="h-8 px-2.5 text-xs" disabled={blocked} busy={exportBusy.bom} onclick={() => void exportBom()} data-testid="export-bom">BOM CSV</ButtonBusy>
      <ButtonBusy size="sm" class="h-8 px-2.5 text-xs" disabled={blocked} busy={exportBusy.png} onclick={() => void exportPng()} data-testid="export-png">PNG</ButtonBusy>
      <!-- 送精修：进专家工作台（spacing 违规可在编辑器里修；编辑器导出门独立把关）；bake 期间 button 承载 busy -->
      <ButtonBusy
        size="sm"
        variant="outline"
        class="h-8 px-2.5 text-xs"
        disabled={!canSendToEdit}
        busy={sendBusy}
        onclick={requestSendToEdit}
        data-testid="send-to-edit"
      >
        <PenLine />
        送精修
      </ButtonBusy>
    </div>
  {/if}
</footer>

<!-- 再次送精修的覆盖确认（编辑器文档未保存时；dirty 口径 A.2.3） -->
<Dialog.Root bind:open={overwriteConfirmOpen}>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title>覆盖当前精修内容？</Dialog.Title>
      <Dialog.Description>
        专家工作台中的文档尚未保存。再次送精修将以排钻设计当前结果重建编辑文档，未保存的修改将被丢弃（撤销历史一并清空）。
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (overwriteConfirmOpen = false)} data-testid="send-to-edit-cancel">
        取消
      </Button>
      <Button size="sm" onclick={performSendToEdit} data-testid="send-to-edit-confirm">
        覆盖并送入
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
