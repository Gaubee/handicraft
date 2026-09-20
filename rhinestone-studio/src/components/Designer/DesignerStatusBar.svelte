<!--
 * DesignerStatusBar.svelte——底部状态栏（design §1.2：画幅读数（点击弹 popover）｜缩放比｜
 * 钻数（含隐藏口径）｜当前规格码｜间距读数徽标 + warning 徽标；EditStatusBar 退役重写）。
 *
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 2.x → 5.2] 读数四件：画幅（doc.physicalCanvas 真值；
 *    点击弹画幅 popover）+ 缩放比（viewport 共享真源——画布唯一写者）+ 钻数（总量 +
 *    「含 N 隐藏」= 隐藏层钻口径，design §4.4）+ 当前规格码（brushSpec 覆盖 ?? 文档基准
 *    派生；R10/SQ35 人读短码——身份不由显示码反推）。
 * 2. [5.2 画幅 popover 可改] 宽/高 mm 直输 → declared（setDeclaredCanvas 单通道；锚来源
 *    declared/default 显式标识）+ popover px/mm = 画幅锚定换算（widthPx÷widthMm，
 *    canvasAnchor 单源——declared 后与 grid.pixelsPerMm 分叉时以锚为准；主读数位 px/mm 维持
 *    grid.pixelsPerMm 冻结面——workbench.physicalReadout 断言基线）+ 间距徽标（当前规格
 *    pitch mm——brushSnapPitchPx 同单源随规格重算；与 warning 徽标并列不混淆）。
 * 3. [D-5.2 迁移] pairwise warning 徽标：validateEditable 派生消费（spacing=可保存·导出阻断
 *    提示，mask-hint=归属提示不阻断）——非第二真源，判据单源 engine validateEditable。
 *    [Guard] 无文档：占位读数（画幅「未锚定」位语义保留——缺真源不显示假值）。
-->

<script lang="ts">
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import { validateEditable, BUILTIN_SHAPES, baseSpecDiameterMm, gemSpecIdentityOf, type PhysicalCanvas } from '$lib/engine'
  import { countHiddenGems } from '$lib/services/documentService'
  import { getBrushSpec } from '$lib/designer/workbench.svelte'
  import { brushSnapPitchPx } from '$lib/designer/brushEngine'
  import { canvasPixelsPerMm, setDeclaredCanvas } from '$lib/designer/canvasAnchor'
  import { getViewState } from '$lib/designer/viewport.svelte'

  const doc = $derived(getEditDoc())
  const total = $derived(doc?.gems.length ?? 0)
  const selected = $derived(doc?.selection.size ?? 0)
  const canvas = $derived(doc?.physicalCanvas ?? null)
  /** 主读数位 px/mm（2.x 冻结面：grid.pixelsPerMm——workbench.physicalReadout 断言基线）。 */
  const gridPixelsPerMm = $derived(doc?.grid.pixelsPerMm ?? null)
  /** [5.2] popover px/mm = 画幅锚定换算（widthPx÷widthMm——declared 后与 grid 分叉时锚为准）。 */
  const anchorPixelsPerMm = $derived(canvas !== null ? canvasPixelsPerMm(doc) : null)
  /** 缩放比（viewport 共享真源——画布 fit/缩放写者；本栏只读）。 */
  const view = $derived(getViewState())

  /** [5.2] 间距徽标：当前规格 pitch mm（brushSnapPitchPx 同单源——brushSpec 覆盖随规格重算）。 */
  const pitchMm = $derived.by(() => {
    const d = doc
    if (!d) return null
    return brushSnapPitchPx(d) / d.grid.pixelsPerMm
  })

  /** 隐藏层钻计数（design §4.4「含 N 隐藏」口径——[4.3] 数据源单源化：
   *  documentService.countHiddenGems 与导出投影 projectVisibleGems 同源，锁定不参与）。 */
  const hiddenCount = $derived(doc !== null ? countHiddenGems(doc) : 0)

  /** [D-5.2 迁移] pairwise warning 派生（gems/grid/blocks 任一变动即重算——load/改径/改形/undo）。 */
  const warnings = $derived.by(() => {
    const d = doc
    if (!d || d.gems.length < 2) return []
    return validateEditable(d.gems, d.grid, d.blocks)
  })
  const spacingCount = $derived(warnings.filter((w) => w.kind === 'spacing').length)
  const maskHintCount = $derived(warnings.filter((w) => w.kind === 'mask-hint').length)

  /** 当前规格码（人读短码 R10/SQ35——brushSpec 显式覆盖 ?? 文档基准派生；显示码不参与身份）。 */
  const specCode = $derived.by(() => {
    const d = doc
    if (!d) return null
    const override = getBrushSpec()
    const spec =
      override ?? { shapeId: 'round' as const, diameterMm: baseSpecDiameterMm(d.grid), colorId: d.palette[0]?.id ?? '' }
    const identity = gemSpecIdentityOf(spec, d.grid)
    if (identity.shapeId === 'custom') return identity.specKey
    const shortCode = BUILTIN_SHAPES.find((s) => s.shapeId === identity.shapeId)?.shortCode
    if (shortCode === undefined) return identity.specKey
    return `${shortCode}${identity.sizeLabel.replace(/^SS/, '').replace(/mm$/, '')}`
  })

  /** [5.2] 画幅 popover（design §5.2 裁决 6：不强制新建弹窗——读数点击可改 declared）。 */
  let canvasPopoverOpen = $state(false)
  let canvasWidthInput = $state('')
  let canvasHeightInput = $state('')
  let canvasError = $state<string | null>(null)

  function mmLabel(value: number): string {
    return `${Math.round(value * 100) / 100}`
  }

  function anchorLabel(c: PhysicalCanvas): string {
    return c.anchorSource === 'default' ? '缺省锚' : '声明锚'
  }

  function toggleCanvasPopover(): void {
    canvasPopoverOpen = !canvasPopoverOpen
    if (canvasPopoverOpen && canvas !== null) {
      // 预填当前画幅（2 位小数去尾零）；错误行清零
      canvasWidthInput = mmLabel(canvas.widthMm)
      canvasHeightInput = mmLabel(canvas.heightMm)
      canvasError = null
    }
  }

  function applyDeclaredCanvas(): void {
    const result = setDeclaredCanvas(Number(canvasWidthInput), Number(canvasHeightInput))
    if (result.ok) {
      canvasError = null
      canvasWidthInput = mmLabel(getEditDoc()!.physicalCanvas.widthMm)
      canvasHeightInput = mmLabel(getEditDoc()!.physicalCanvas.heightMm)
    } else {
      canvasError = result.error ?? '画幅值非法'
    }
  }
</script>

<footer
  class="text-muted-foreground relative flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-1.5 font-mono text-[11px] tabular-nums"
  data-testid="designer-status-bar"
>
  <!-- 画幅读数位（点击弹 popover；null 兜底保持「未锚定」占位不显示假值） -->
  <button
    type="button"
    class="hover:text-foreground transition-colors"
    title="画幅物理读数（点击查看锚定详情 / 改声明画幅）"
    onclick={toggleCanvasPopover}
    data-testid="designer-canvas-readout"
    aria-expanded={canvasPopoverOpen}
  >
    {#if canvas !== null}
      画幅 {mmLabel(canvas.widthMm)}×{mmLabel(canvas.heightMm)}mm
      {#if gridPixelsPerMm !== null}· {mmLabel(gridPixelsPerMm)}px/mm{/if}
      {#if canvas.anchorSource === 'default'}（缺省锚）{/if}
    {:else}
      画幅 未锚定
    {/if}
  </button>
  {#if canvasPopoverOpen && canvas !== null}
    <div
      class="bg-card absolute bottom-full left-3 z-30 mb-1.5 grid w-60 gap-1.5 rounded-lg border p-2.5 text-left shadow-lg"
      data-testid="designer-canvas-popover"
      role="dialog"
      aria-label="画幅设置"
    >
      <span class="text-foreground text-xs font-semibold">画幅锚定</span>
      <span>宽 {mmLabel(canvas.widthMm)}mm · 高 {mmLabel(canvas.heightMm)}mm</span>
      <span data-testid="designer-canvas-pxmm">{anchorPixelsPerMm !== null ? `${mmLabel(anchorPixelsPerMm)}px/mm` : 'px/mm 未定'}</span>
      <span data-testid="designer-canvas-anchor-source">锚来源：{anchorLabel(canvas)}</span>
      <!-- [5.2] 宽/高 mm 直输 → declared（design §5.2：px 尺寸不变，物理换算随声明重定） -->
      <div class="mt-1 grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
        <input
          type="number"
          min="0.01"
          step="0.1"
          bind:value={canvasWidthInput}
          aria-label="宽（mm）"
          data-testid="designer-canvas-width-input"
          class="h-6 rounded border bg-transparent px-1 text-[11px] tabular-nums"
        />
        <input
          type="number"
          min="0.01"
          step="0.1"
          bind:value={canvasHeightInput}
          aria-label="高（mm）"
          data-testid="designer-canvas-height-input"
          class="h-6 rounded border bg-transparent px-1 text-[11px] tabular-nums"
        />
        <button
          type="button"
          class="hover:bg-muted rounded px-1.5 py-0.5 text-[11px] font-medium"
          onclick={applyDeclaredCanvas}
          data-testid="designer-canvas-apply"
        >
          改声明
        </button>
      </div>
      {#if canvasError !== null}
        <span class="text-destructive text-[10px]" data-testid="designer-canvas-error">{canvasError}</span>
      {/if}
    </div>
  {/if}

  <!-- 缩放比（viewport 真源派生；点击回 100%/适配归视图导航切片） -->
  <span data-testid="designer-status-zoom">{Math.round(view.scale * 100)}%</span>

  <!-- 钻数（design §4.4：总量 + 含 N 隐藏口径——隐藏层不导出，状态栏仍显总量+隐藏数） -->
  <span data-testid="designer-status-total">
    {total.toLocaleString()} 钻{#if hiddenCount > 0}<span data-testid="designer-status-hidden"> · 含 {hiddenCount} 隐藏</span>{/if}
  </span>
  <span data-testid="designer-status-selection" class={selected > 0 ? 'text-foreground' : ''}>
    {selected > 0 ? `已选 ${selected.toLocaleString()}` : '未选中'}
  </span>

  <!-- 当前规格码（brushSpec ?? 文档基准；R10/SQ35 人读） -->
  {#if specCode !== null}
    <span data-testid="designer-status-spec" title="当前规格（笔刷覆盖或文档基准派生）">{specCode}</span>
  {/if}

  <!-- [5.2] 间距徽标：当前规格 pitch（brushSnapPitchPx 同单源随规格重算；格位吸附同距） -->
  {#if pitchMm !== null}
    <span
      data-testid="designer-status-pitch"
      title="当前规格间距（径+gap；格位吸附/⇧微移同距）"
    >
      间距 {mmLabel(pitchMm)}mm
    </span>
  {/if}

  <!-- [D-5.2 迁移] pairwise warning 徽标：spacing=可保存·导出将被拦截；mask-hint=归属提示不阻断 -->
  {#if spacingCount > 0}
    <span
      class="text-destructive"
      title={warnings
        .filter((w) => w.kind === 'spacing')
        .map((w) => w.detail)
        .join('\n')}
      data-testid="designer-status-spacing-warnings"
    >
      ⚠ {spacingCount} 处间距冲突（可保存 · 导出将被拦截）
    </span>
  {/if}
  {#if maskHintCount > 0}
    <span
      class="text-destructive/80"
      title={warnings
        .filter((w) => w.kind === 'mask-hint')
        .map((w) => w.detail)
        .join('\n')}
      data-testid="designer-status-mask-hints"
    >
      {maskHintCount} 处越出来源块掩码（提示）
    </span>
  {/if}
</footer>
