<!--
 * DesignerStatusBar.svelte——底部状态栏（design §1.2：画幅读数（点击弹 popover）｜缩放比｜
 * 钻数（含隐藏口径）｜当前规格码｜间距读数徽标 + warning 徽标；EditStatusBar 退役重写）。
 *
 * Orthogonal intents (max 4):
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
 * 4. [2026-09-21 rework R3.2] 笔刷设定读数 + popover（design §4.3，与画幅 popover 同族）：
 *    「笔刷 Ø mm · 流量 %」读数（effectiveBrushDiameterMm 单源——光标圈/落子 footprint
 *    同读）→ 点击弹层（直径 number input + 流量 0-100 滑杆 + 跟随规格）——写入经命令总线
 *    set-brush-diameter/set-brush-flow（与 [ ] 键位 adjust-brush-diameter 同源单入口）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import { validateEditable, BUILTIN_SHAPES, baseSpecDiameterMm, gemSpecIdentityOf, type PhysicalCanvas } from '$lib/engine'
  import { countHiddenGems } from '$lib/services/documentService'
  import { brushGemSpecDiameterMm, effectiveBrushDiameterMm, getBrushSettings, getBrushSpec } from '$lib/designer/workbench.svelte'
  import { brushSnapPitchPx } from '$lib/designer/brushEngine'
  import { execDesignerCommand } from '$lib/designer/commands'
  import { canvasPixelsPerMm, setDeclaredCanvas } from '$lib/designer/canvasAnchor'
  import { getViewState } from '$lib/designer/viewport.svelte'
  // [6.2 右键空态树] popover 开合上收 viewState 单真源（右键「画幅设置…」经命令总线
  // open-canvas-popover 打开同一 popover；状态栏读数点击 toggle 同源——预填随开合 $effect）
  import { getCanvasPopoverOpen, setCanvasPopoverOpen, toggleCanvasPopover as toggleCanvasPopoverState } from '$lib/designer/viewState.svelte'

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

  /** [5.2/6.2] 画幅 popover（design §5.2 裁决 6：不强制新建弹窗——读数点击可改 declared；
   *  开合态在 viewState 单真源，右键「画幅设置…」命令同源打开）。 */
  const canvasPopoverOpen = $derived(getCanvasPopoverOpen())
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
    // 开合走 viewState 单真源（本组件内包装同名——读数点击与右键「画幅设置…」命令同源）
    toggleCanvasPopoverState()
  }

  // 打开时预填当前画幅（2 位小数去尾零）+ 错误行清零（命令入口/读数点击两路同效）
  $effect(() => {
    if (canvasPopoverOpen && canvas !== null) {
      canvasWidthInput = mmLabel(canvas.widthMm)
      canvasHeightInput = mmLabel(canvas.heightMm)
      canvasError = null
    }
  })

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

  // ---------------------------------------------------------------------------
  // [R3.2 笔刷设定 popover]（design §4.3——读数点击弹层，与画幅 popover 同族判据；
  // 直径 number input + 流量 0-100 滑杆；写入经命令总线 set-brush-diameter/set-brush-flow
  // ——与 [ ] 键位（adjust-brush-diameter）同源单入口）
  // ---------------------------------------------------------------------------

  let brushPopoverOpen = $state(false)
  let brushDiameterInput = $state('')

  /** 笔刷读数（直径 = effectiveBrushDiameterMm 单源——光标圈/落子 footprint 同读；流量 %）。 */
  const brushSettings = $derived(getBrushSettings())
  const brushDiameterMm = $derived(doc !== null ? effectiveBrushDiameterMm(doc) : null)

  function toggleBrushPopover(): void {
    brushPopoverOpen = !brushPopoverOpen
  }

  // 打开时预填当前有效直径（两位小数去尾零）
  $effect(() => {
    if (brushPopoverOpen && brushDiameterMm !== null) {
      brushDiameterInput = mmLabel(brushDiameterMm)
    }
  })

  function applyBrushDiameter(): void {
    execDesignerCommand({ kind: 'set-brush-diameter', diameterMm: Number(brushDiameterInput) })
  }

  function applyBrushFlow(event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    execDesignerCommand({ kind: 'set-brush-flow', flowPercent: value })
  }

  /** 「跟随规格」：直径覆盖清空（回 null——规格切换随之联动）。 */
  function followSpecDiameter(): void {
    execDesignerCommand({ kind: 'set-brush-diameter', diameterMm: null })
    const d = doc
    if (d !== null) brushDiameterInput = mmLabel(effectiveBrushDiameterMm(d))
  }

  // ---------------------------------------------------------------------------
  // [R5.2 走查 P2-2] popover 外点关闭 + Esc 关闭（走查实证：打开期间外点不关、快捷键
  // 失效——焦点滞留弹层输入件且无退出路径）。捕获相监听：popover/触发钮内点击不关
  // （触发钮自带 toggle 语义——关后再 toggle 会复活）；Esc 关闭并消费（不再连带清空
  // 选择）；非 Esc 键零拦截——全局键位（⌘Z 等）在弹层打开期保持可用（焦点不在输入件时）。
  // ---------------------------------------------------------------------------

  /** 命中集合：命中任一 testid（popover 本体 + 触发钮/移动端读数钮）＝ 内点不关。 */
  const CANVAS_POPOVER_KEEP = ['designer-canvas-popover', 'designer-canvas-readout', 'designer-mobile-canvas-readout'] as const
  const BRUSH_POPOVER_KEEP = ['designer-brush-popover', 'designer-status-brush'] as const

  function pathHits(path: EventTarget[], testids: readonly string[]): boolean {
    for (const target of path) {
      if (!(target instanceof Element)) continue
      for (const testid of testids) {
        if (target.closest(`[data-testid="${testid}"]`) !== null) return true
      }
    }
    return false
  }

  function onWindowPointerDown(e: PointerEvent): void {
    const path = e.composedPath()
    if (canvasPopoverOpen && !pathHits(path, CANVAS_POPOVER_KEEP)) setCanvasPopoverOpen(false)
    if (brushPopoverOpen && !pathHits(path, BRUSH_POPOVER_KEEP)) brushPopoverOpen = false
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || (!canvasPopoverOpen && !brushPopoverOpen)) return
    setCanvasPopoverOpen(false)
    brushPopoverOpen = false
    e.preventDefault()
    e.stopPropagation() // Esc 消费于关闭弹层（不连带画布取消/清空选择语义）
  }

  onMount(() => {
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('keydown', onWindowKeydown, true)
    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('keydown', onWindowKeydown, true)
    }
  })
</script>

<footer
  class="text-muted-foreground relative flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-1.5 font-mono text-[11px] tabular-nums"
  data-testid="designer-status-bar"
>
  <!-- 画幅读数位（点击弹 popover；null 兜底保持「未锚定」占位不显示假值）。
       [8.1 移动端降级]（design §1.4：画幅读数并入顶栏第二行）：<lg 让位（hidden lg:inline-flex），
       popover 仍由本栏承载渲染（移动态本栏挂载，顶栏第二行读数同 viewState 单真源触发）。 -->
  <button
    type="button"
    class="hidden lg:inline-flex hover:text-foreground transition-colors"
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

  <!-- 缩放比（viewport 真源派生；点击回 100%/适配归视图导航切片）。
       [8.1 移动端降级]：<lg 让位（并入顶栏第二行——designer-mobile-status-zoom 同 viewport 真源）。 -->
  <span class="hidden lg:inline" data-testid="designer-status-zoom">{Math.round(view.scale * 100)}%</span>

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

  <!-- [R3.2] 笔刷设定读数（design §4.3）：Ø mm · 流量 %——点击弹 popover（直径 input +
       流量滑杆）；[ ] 键位（画笔/橡皮下）同源调直径，光标圈即时反映（同读单源）。 -->
  {#if brushDiameterMm !== null}
    <button
      type="button"
      class="hover:text-foreground transition-colors"
      title="笔刷设定（直径 = 圆盘 footprint——面积落子/批量擦除/光标圈同径；点击调节）"
      onclick={toggleBrushPopover}
      data-testid="designer-status-brush"
      aria-expanded={brushPopoverOpen}
    >
      笔刷 {mmLabel(brushDiameterMm)}mm · 流量 {brushSettings.flowPercent}%
    </button>
  {/if}
  {#if brushPopoverOpen && brushDiameterMm !== null}
    <div
      class="bg-card absolute bottom-full left-3 z-30 mb-1.5 grid w-64 gap-2 rounded-lg border p-2.5 text-left shadow-lg"
      data-testid="designer-brush-popover"
      role="dialog"
      aria-label="笔刷设定"
    >
      <span class="text-foreground text-xs font-semibold">笔刷设定</span>
      <div class="grid grid-cols-[1fr_auto] items-center gap-1.5">
        <input
          type="number"
          min={doc !== null ? mmLabel(brushGemSpecDiameterMm(doc)) : '0.1'}
          max="100"
          step="0.5"
          bind:value={brushDiameterInput}
          onchange={applyBrushDiameter}
          aria-label="笔刷直径（mm）"
          data-testid="designer-brush-diameter-input"
          class="h-6 rounded border bg-transparent px-1 text-[11px] tabular-nums"
        />
        <span class="text-[11px]">mm</span>
      </div>
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-1.5">
        <span class="text-[11px]">流量</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={brushSettings.flowPercent}
          oninput={applyBrushFlow}
          aria-label="流量（%）"
          data-testid="designer-brush-flow-input"
          class="h-1.5"
        />
        <span class="w-8 text-right text-[11px] tabular-nums" data-testid="designer-brush-flow-value">{brushSettings.flowPercent}%</span>
      </div>
      <button
        type="button"
        class="hover:bg-muted w-fit rounded px-1.5 py-0.5 text-[11px] font-medium"
        onclick={followSpecDiameter}
        data-testid="designer-brush-diameter-follow"
      >
        跟随规格直径
      </button>
      <span class="text-muted-foreground text-[10px]">直径 = 圆盘 footprint（吸附开时扫面铺格位）；流量 = 格位保留概率。[ / ] 调直径（画笔/橡皮下）。</span>
    </div>
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
