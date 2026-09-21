<!--
 * DesignerSmartLayoutPanel.svelte——智能排布参数小窗（design §5.3；旧选图即排入口退役后的
 * 显式工具形态——术语更名见 TERMS v5 禁用映射）。
 *
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 7.2] 参数小窗（PRODUCT_MODEL v6 硬规则 6 修订：
 *    显式工具允许自有参数小窗——策略×基础规格（目录档）×间距 gapMm×密度 %四参；k/seed/
 *    relax 维持 quickLayout 冻结缺省不暴露）；执行链 = runSmartLayout（quickLayout 钻数组
 *    产物模式——计算内核复用零改动；进度 label + 取消 AbortSignal）。
 * 2. [落点与报数] 结果落当前图层单 undo 组（面板不持归属逻辑——smartLayout 执行链单源）；
 *    冲突钻丢弃在结果行显式报数（「并入 N 颗，跳过 M 颗冲突」——design §5.3 显式不静默）；
 *    store 巨型批门（MAX_STROKE_GEMS）拒绝/解码失败在错误行显式呈现。
 * 3. [开合同源] open 态在 smartLayout 模块单真源（命令总线 open-smart-layout / DocBar 按钮 /
 *    右键空态「智能排布…」同入口）；关闭（Esc/背景/取消钮）中止在途计算。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { SS_TABLE, type BaseSpec } from '$lib/engine'
  import { ComputeAbortedError, STRATEGY_LABELS } from '$lib/workers/computeCore'
  import type { StrategyId } from '$lib/engine'
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import {
    getSmartLayoutOpen,
    runSmartLayout,
    setSmartLayoutOpen,
    type SmartLayoutRunResult,
  } from '$lib/designer/smartLayout.svelte'
  import {
    getSpecCatalog,
    getSpecCatalogStatus,
    groupSpecCatalog,
    loadSpecCatalog,
    specCodeOf,
  } from '$lib/designer/specSelector.svelte'

  const open = $derived(getSmartLayoutOpen())
  const catalog = $derived(getSpecCatalog())
  const catalogStatus = $derived(getSpecCatalogStatus())

  /** 目录档平铺（形分组序 → 组内目录序；specKey 选项身份）。 */
  const specOptions = $derived.by(() => {
    const out: Array<{ spec: BaseSpec; label: string; identity: string }> = []
    for (const group of groupSpecCatalog(catalog)) {
      for (const entry of group.sizes) {
        out.push({
          spec: {
            shapeId: entry.shapeId as BaseSpec['shapeId'],
            sizeLabel: entry.sizeLabel,
            diameterMm: entry.diameterMm,
            ...(entry.shapeId === 'custom' && entry.assetId !== undefined ? { assetId: entry.assetId } : {}),
          },
          label: `${group.label} · ${specCodeOf(entry)}`,
          identity: entry.specKey,
        })
      }
    }
    if (out.length === 0) {
      // 目录缺席（loading/error/空）兜底：冻结缺省同值圆钻 SS10（与 QUICK_LAYOUT_PARAMS 同参）
      out.push({ spec: { shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, label: '圆钻 · R10', identity: 'round-ss10' })
    }
    return out
  })

  // ---- 参数态（缺省 = quickLayout 冻结参数同值：hybrid / SS10 / 0.4 / 100%）----
  let strategy = $state<StrategyId>('hybrid')
  let specIdentity = $state('')
  let gapMm = $state(0.4)
  let densityPercent = $state(100)

  const STRATEGIES: ReadonlyArray<StrategyId> = ['hex-thin', 'hex-pitch', 'poisson', 'hybrid', 'cvt']
  const GAP_MIN = 0.4
  const GAP_MAX = 0.8

  $effect(() => {
    if (specIdentity === '') specIdentity = specOptions[0]?.identity ?? ''
  })

  const activeSpec = $derived(
    specOptions.find((o) => o.identity === specIdentity)?.spec ?? specOptions[0]!.spec,
  )

  // ---- 执行态（进度/取消/结果/错误——design §5.3 显式呈现，不静默）----
  let busy = $state(false)
  let progressLabel = $state('')
  let result = $state<SmartLayoutRunResult | null>(null)
  let error = $state<string | null>(null)
  let abort: AbortController | null = null

  onMount(() => {
    void loadSpecCatalog() // 目录幂等拉取（规格选择器同源共享态）
  })

  function close(): void {
    abort?.abort() // 关闭中止在途计算（进度/取消语义保留）
    abort = null
    busy = false
    progressLabel = ''
    setSmartLayoutOpen(false)
  }

  async function run(): Promise<void> {
    const doc = getEditDoc()
    if (doc === null || busy) return
    busy = true
    error = null
    result = null
    progressLabel = '准备中…'
    abort = new AbortController()
    try {
      result = await runSmartLayout(
        { strategy, spec: activeSpec, gapMm, density: densityPercent / 100 },
        {
          signal: abort.signal,
          onProgress: (p) => {
            progressLabel = p.label
          },
        },
      )
    } catch (caught) {
      if (!(caught instanceof ComputeAbortedError)) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
    } finally {
      abort = null
      busy = false
      progressLabel = ''
    }
  }
</script>

<Dialog.Root
  open={open}
  onOpenChange={(next) => {
    if (!next) close()
  }}
>
  <Dialog.Content class="max-w-sm" data-testid="designer-smart-layout-panel">
    <Dialog.Header>
      <Dialog.Title>智能排布</Dialog.Title>
      <Dialog.Description>
        按参考底图一次排布，结果并入当前图层（一次撤销整体恢复）；与既有钻冲突的结果将被丢弃并报数。
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid gap-2.5">
      <div class="grid grid-cols-[4.5rem_1fr] items-center gap-2">
        <label class="text-xs font-medium" for="designer-smart-strategy">策略</label>
        <select
          id="designer-smart-strategy"
          class="border-input bg-background h-8 rounded-md border px-2 text-xs"
          bind:value={strategy}
          disabled={busy}
          data-testid="designer-smart-strategy"
        >
          {#each STRATEGIES as sid (sid)}
            <option value={sid}>{STRATEGY_LABELS[sid]}</option>
          {/each}
        </select>
      </div>

      <div class="grid grid-cols-[4.5rem_1fr] items-center gap-2">
        <label class="text-xs font-medium" for="designer-smart-spec">基础规格</label>
        <select
          id="designer-smart-spec"
          class="border-input bg-background h-8 rounded-md border px-2 text-xs"
          bind:value={specIdentity}
          disabled={busy}
          data-testid="designer-smart-spec"
        >
          {#each specOptions as option (option.identity)}
            <option value={option.identity}>{option.label}</option>
          {/each}
        </select>
      </div>
      {#if catalogStatus === 'loading' || catalogStatus === 'error'}
        <p class="text-muted-foreground pl-[5.5rem] text-[10px]" data-testid="designer-smart-catalog-note">
          {catalogStatus === 'loading' ? '目录加载中（暂用缺省规格）…' : '目录不可用（缺省规格兜底）'}
        </p>
      {/if}

      <div class="grid grid-cols-[4.5rem_1fr] items-center gap-2">
        <label class="text-xs font-medium" for="designer-smart-gap">间距 mm</label>
        <Input
          id="designer-smart-gap"
          type="number"
          min={GAP_MIN}
          max={GAP_MAX}
          step={0.05}
          bind:value={gapMm}
          disabled={busy}
          data-testid="designer-smart-gap"
          class="h-8 text-xs"
        />
      </div>

      <div class="grid grid-cols-[4.5rem_1fr] items-center gap-2">
        <label class="text-xs font-medium" for="designer-smart-density">密度 %</label>
        <Input
          id="designer-smart-density"
          type="number"
          min={1}
          max={100}
          step={5}
          bind:value={densityPercent}
          disabled={busy}
          data-testid="designer-smart-density"
          class="h-8 text-xs"
        />
      </div>
    </div>

    {#if busy}
      <div class="mt-3 flex items-center gap-2" data-testid="designer-smart-progress">
        <div class="border-primary border-t-primary/30 size-4 animate-spin rounded-full border-2" aria-hidden="true"></div>
        <span class="text-xs font-medium">{progressLabel}</span>
        <Button variant="outline" size="xs" class="ml-auto" onclick={() => abort?.abort()} data-testid="designer-smart-cancel">
          取消
        </Button>
      </div>
    {/if}

    {#if result !== null}
      <p class="text-foreground mt-3 text-xs font-medium" data-testid="designer-smart-result">
        并入 {result.added.toLocaleString()} 颗，跳过 {result.dropped.toLocaleString()} 颗冲突
      </p>
      <p class="text-muted-foreground text-[10px]" data-testid="designer-smart-result-summary">{result.sourceSummary}</p>
    {/if}

    {#if error !== null}
      <p class="text-destructive mt-3 text-xs" data-testid="designer-smart-error">{error}</p>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={close} data-testid="designer-smart-close">
        关闭
      </Button>
      <Button size="sm" disabled={busy || gapMm < GAP_MIN || gapMm > GAP_MAX || densityPercent < 1 || densityPercent > 100} onclick={() => void run()} data-testid="designer-smart-run">
        {busy ? '排布中…' : '开始排布'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
