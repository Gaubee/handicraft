<!--
Orthogonal intents (max 4):
1. [2026-09-19 Layout 2.3 / 2026-09-20 studio-layers 2.7 收窄] 状态条（Owner：底部只剩统计与导出）：
     左 = 共 N 钻（Σ 各层含隐藏层——「隐藏 ≠ 排除」口径）+ M 层·含 k 隐藏层 + 联合校验徽标 + BOM 前 3 色▾；
     右 = SVG/BOM CSV/PNG/送精修（exportGate 全层 concat 统一 pairwise 前置硬阻断）+ worker 进度徽标 + 取消。
     [废除] 策略只读回显与 [⤢对比] 占位（策略真源 = 检查器层配置卡——胶片带宿主迁移完成）。
2. [联合违规态] 红徽标 + 分层分组清单 ▾（intra 层内 / inter 层 A × 层 B）+ [边界松弛][斥力修复]
     写入违规涉及层（批量 layer.config op——多选批量语义复用 §2.4）。
3. [2026-09-19 Mobile 4.1] 移动端导出组收进「导出▾」菜单（视口分支用 matchMedia——jsdom 恒桌面分支，
     测试选择器单实例稳定）。
4. [2026-09-19 Busy] 导出/送精修 button 承载 busy（spinner+disabled+aria-busy，先让一帧再算）。
5. [2026-09-20 R6 P0-1] 送精修 = exportGate 第四路共同前置（spec §「联合导出前置」：违规硬阻断）：
     按钮 disabled 与 SVG/BOM/PNG 同族（!check.ready || !check.exportable）；performSendToEdit
     入口二次短路（覆盖确认弹窗确认键/移动端菜单等直接调用路径）——阻断 = 三段式 toast
     （事实 + 首项违规摘要 + 恢复动作），不产生 handoff、不切视图。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import {
    archiveExportedPng,
    buildActiveBom,
    buildActiveSvg,
    buildManualEditHandoff,
    cancelCompute,
    currentSourceSummary,
    dispatchLayerConfigOp,
    exportFileName,
    getActiveResult,
    getBackgroundObservation,
    getBomSummary,
    getBlocks,
    getComputeProgress,
    getComputing,
    getExportCheck,
    getGrid,
    getHiddenLayerCount,
    getLayerResult,
    getLayers,
    getPainting,
    getPalette,
    getReferenceImage,
    jointViewOf,
  } from '$lib/stores/studio.svelte'
  import { isEditDirty, loadFromHandoff } from '$lib/stores/edit.svelte'
  import { setView } from '$lib/stores/view.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { paintGems, paintingImageData } from './gemPaint'
  import ButtonBusy from './ButtonBusy.svelte'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import PenLine from '@lucide/svelte/icons/pen-line'

  const result = $derived(getActiveResult())
  const check = $derived(getExportCheck())
  const bom = $derived(getBomSummary())
  const computing = $derived(getComputing())
  const progress = $derived(getComputeProgress())
  const layers = $derived(getLayers())
  const hiddenCount = $derived(getHiddenLayerCount())

  /** 联合口径统计：Σ 各层钻数（含隐藏层——隐藏 ≠ 排除） */
  const totalGems = $derived(jointViewOf(layers).gems.length)
  const totalDropped = $derived(layers.reduce((sum, l) => sum + (getLayerResult(l.id)?.dropped ?? 0), 0))
  const violations = $derived(check.ready ? check.warnings.length : 0)
  const blocked = $derived(!check.ready || !check.exportable)
  /** 违规涉及层松弛双开关态（修复直达读面——涉事层全开才显示已开） */
  const involvedRelax = $derived.by(() => {
    const involved = check.involvedLayerIds
    const targets = layers.filter((l) => involved.includes(l.id))
    return {
      boundary: targets.length > 0 && targets.every((l) => l.physics.relax.boundary),
      repulsion: targets.length > 0 && targets.every((l) => l.physics.relax.repulsion),
    }
  })

  // ---- 浮出（违规清单 / BOM 全量 / 移动端导出菜单——向上浮出，状态条定高不增长） ----
  let exportMenuOpen = $state(false)
  let violationListOpen = $state(false)
  let bomListOpen = $state(false)

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

  // ---- 送精修（编辑中文档未保存 → 覆盖确认弹窗） ----
  let overwriteConfirmOpen = $state(false)
  /** [R6 P0-1] exportGate 第四路前置：结果就绪且联合校验可导出才可送（blocked 与 SVG/BOM/PNG 同源） */
  const canSendToEdit = $derived(!!result && !result.error && !blocked)

  function requestSendToEdit(): void {
    if (!canSendToEdit || sendBusy) return
    if (isEditDirty()) {
      overwriteConfirmOpen = true
      return
    }
    void performSendToEdit()
  }

  function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })
  }

  let exportBusy = $state({ svg: false, bom: false, png: false })
  let sendBusy = $state(false)

  /** [R6 P0-1] 送精修阻断三段式提示（与导出按钮 blocked 文案同族：事实 + 首项违规原因 + 恢复动作） */
  function notifySendBlocked(): void {
    const gate = getExportCheck()
    const first = gate.warnings[0]
    if (!gate.ready || first === undefined) {
      showToast('送精修已阻断：布局结果未就绪。请等待重算完成后重试。')
      return
    }
    showToast(
      `送精修已阻断：联合校验存在 ${gate.warnings.length} 项违规（首项：${first.detail}）。请先修复违规后再送精修。`,
    )
  }

  async function performSendToEdit(): Promise<void> {
    if (sendBusy) return
    // [R6 P0-1] exportGate 硬门（四路共同前置）：不可导出 = 短路阻断——不产生 handoff、不切视图；
    // 覆盖确认弹窗确认键（绕过 requestSendToEdit 的 canSendToEdit）与任何直接调用路径
    const gate = getExportCheck()
    if (!gate.ready || !gate.exportable) {
      overwriteConfirmOpen = false
      exportMenuOpen = false
      notifySendBlocked()
      return
    }
    sendBusy = true
    try {
      await nextPaint()
      const handoff = buildManualEditHandoff()
      if (!handoff) return
      loadFromHandoff(handoff)
      overwriteConfirmOpen = false
      exportMenuOpen = false
      setView('edit')
      showToast('已送入设计师工作台（烘焙快照，与排钻工作台参数隔离）')
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
      img.onerror = () => reject(new Error('原图解码失败'))
      img.src = src
    })
  }

  /** PNG 光栅化：画布 = 数字油画像素尺寸；底图跟随背景源，钻位按色板着色（联合口径含隐藏层） */
  async function buildPng(): Promise<Blob | null> {
    const p = getPainting()
    if (!p || !result || blocked) return null
    const canvas = document.createElement('canvas')
    canvas.width = p.width
    canvas.height = p.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

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

    paintGems(ctx, result.gems, getPalette(), getBlocks(), getGrid())
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
      const p = getPainting()
      const archived = await archiveExportedPng(blob, currentSourceSummary(), p?.width ?? 0, p?.height ?? 0)
      if (archived) showToast('PNG 已导出 · 在素材库中查看')
    } finally {
      exportBusy.png = false
    }
  }

  /** 修复写入违规涉及层（批量 layer.config op——一次撤销恢复全部涉事层原值） */
  function writeInvolvedRelax(patch: { boundary?: boolean; repulsion?: boolean }): void {
    const involved = check.involvedLayerIds
    if (involved.length === 0) return
    const targets = layers.filter((l) => involved.includes(l.id))
    if (targets.length === 0) return
    const first = targets[0]
    dispatchLayerConfigOp(involved, { relax: { ...first!.physics.relax, ...patch } }, undefined, { immediate: true })
  }
</script>

<footer
  class="bg-background flex h-12 shrink-0 items-center gap-2 overflow-x-auto px-3 lg:overflow-visible lg:px-4"
  data-testid="status-bar"
>
  <!-- 左：统计（Owner「左下角的统计」——联合口径含隐藏层） -->
  <div class="flex shrink-0 items-center gap-2">
    {#if result && !result.error}
      <span class="font-mono text-lg leading-none font-semibold tabular-nums" data-testid="export-gem-count">
        {totalGems.toLocaleString()}
        <span class="text-muted-foreground text-xs font-normal">钻</span>
      </span>
      {#if totalDropped > 0}
        <span class="text-muted-foreground hidden text-[11px] sm:inline" title="布局终局为满足最小间距硬约束自动剔除的钻数">
          剔除 {totalDropped}
        </span>
      {/if}
    {:else}
      <span class="text-muted-foreground text-xs" data-testid="export-gem-count">
        {computing ? (progress?.label ?? '重算中…') : '待计算'}
      </span>
    {/if}

    <!-- M 层 · 含 k 隐藏层（附注，仅当有隐藏层） -->
    <span class="text-muted-foreground shrink-0 text-xs whitespace-nowrap" data-testid="status-layer-count">
      {layers.length} 层{#if hiddenCount > 0}<span class="text-amber-600 dark:text-amber-400" title="隐藏层照常参与计算/统计/导出（隐藏 ≠ 排除）"> · 含 {hiddenCount} 隐藏层</span>{/if}
    </span>

    <!-- 联合校验徽标（+ 违规时修复直达与分层清单入口） -->
    {#if check.ready && check.exportable}
      <span
        class="shrink-0 rounded-full bg-emerald-600/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400"
        title="全层联合 pairwise 校验通过"
      >
        ✓ 间距合规
      </span>
    {:else if check.ready}
      <div class="relative shrink-0" data-testid="violation-cluster">
        <div class="flex items-center gap-1">
          <span class="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            ✗ 违规 {violations}
          </span>
          <!-- 修复直达（写入违规涉及层——批量单 op） -->
          <button
            type="button"
            class="rounded-full border px-2 py-0.5 text-[11px] transition-colors {involvedRelax.boundary
              ? 'border-primary bg-accent/50 text-foreground'
              : 'text-muted-foreground hover:bg-muted'}"
            aria-pressed={involvedRelax.boundary}
            title="对违规涉及层开启边界松弛（重算后生效）"
            onclick={() => writeInvolvedRelax({ boundary: !involvedRelax.boundary })}
            data-testid="relax-boundary"
          >
            边界松弛
          </button>
          <button
            type="button"
            class="rounded-full border px-2 py-0.5 text-[11px] transition-colors {involvedRelax.repulsion
              ? 'border-primary bg-accent/50 text-foreground'
              : 'text-muted-foreground hover:bg-muted'}"
            aria-pressed={involvedRelax.repulsion}
            title="对违规涉及层开启斥力修复（重算后生效）"
            onclick={() => writeInvolvedRelax({ repulsion: !involvedRelax.repulsion })}
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
            <p class="text-destructive mb-1 text-xs font-medium">违规 {violations} 条（按层分组；spacing/mask 违规阻断导出）：</p>
            <ul class="grid gap-1 text-[11px] leading-relaxed">
              {#each check.groups as group (group.layerIds.join('×'))}
                <li>
                  <span class="font-medium">
                    {group.scope === 'intra' ? `层「${group.layerNames[0]}」内` : `${group.layerNames[0]} × ${group.layerNames[1]}`}
                  </span>
                  <span class="text-muted-foreground">（{group.violations.length}）</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
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

  <!-- 右：导出组（Owner「右下角的导出」——exportGate 前置）；移动端收「导出▾」 -->
  {#if isMobileViewport}
    <div class="relative ml-auto flex shrink-0 items-center gap-1">
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
          <ButtonBusy
            size="xs"
            variant="outline"
            disabled={!canSendToEdit}
            busy={sendBusy}
            onclick={requestSendToEdit}
            title={!canSendToEdit ? (check.ready ? '修复联合校验违规后可送精修' : '等待布局结果') : undefined}
            data-testid="send-to-edit"
          >
            <PenLine />
            送精修
          </ButtonBusy>
        </div>
      {/if}
    </div>
  {:else}
    <div class="ml-auto flex shrink-0 items-center gap-2">
      {#if blocked}
        <span class="text-muted-foreground hidden items-center gap-1 text-xs xl:flex" title="修复联合校验违规后可导出">
          <ArrowDown class="size-3.5" />
          {check.ready ? '修复违规后可导出' : '等待布局结果'}
        </span>
      {/if}
      <ButtonBusy size="sm" class="h-8 px-2.5 text-xs" disabled={blocked} busy={exportBusy.svg} onclick={() => void exportSvg()} data-testid="export-svg">SVG</ButtonBusy>
      <ButtonBusy size="sm" class="h-8 px-2.5 text-xs" disabled={blocked} busy={exportBusy.bom} onclick={() => void exportBom()} data-testid="export-bom">BOM CSV</ButtonBusy>
      <ButtonBusy size="sm" class="h-8 px-2.5 text-xs" disabled={blocked} busy={exportBusy.png} onclick={() => void exportPng()} data-testid="export-png">PNG</ButtonBusy>
      <ButtonBusy
        size="sm"
        variant="outline"
        class="h-8 px-2.5 text-xs"
        disabled={!canSendToEdit}
        busy={sendBusy}
        onclick={requestSendToEdit}
        title={!canSendToEdit ? (check.ready ? '修复联合校验违规后可送精修' : '等待布局结果') : undefined}
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
        设计师工作台中的文档尚未保存。再次送精修将以排钻工作台当前结果重建编辑文档，未保存的修改将被丢弃（撤销历史一并清空）。
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
