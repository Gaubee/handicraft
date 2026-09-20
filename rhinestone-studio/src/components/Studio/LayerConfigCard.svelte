<!--
Orthogonal intents (max 3):
1. [2026-09-20 studio-layers 2.7] 检查器置顶层配置卡（唯一策略/物理写入点——旧胶片带唯一
     写入点纪律的宿主迁移）：横幅区[单选层名/配置相同/配置不同·以①层为基准] + 策略 Select
     （STRATEGY_LABELS 中文名五选一）+ 物理组（规格 Select 数据源=gemCatalogService 接口——禁第二
     目录真源 + gap/层密度滑杆 + 松弛双开关）+ 滑杆乐观 UI + 300ms trailing 提交。
     全部写入经 writeSelectedLayerConfig = 单 layer.config op（多选批量=一次撤销恢复全部原值）。
2. [背景层选中态] isBackgroundSelected → 源 Select + 透明度滑杆 + 只读说明（1-5 区替换）。
3. [复用] 桌面检查器与移动端层配置抽屉共用本卡（现行为硬承诺——容器换组件不换）。
-->

<script lang="ts">
  import { untrack } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import { STRATEGY_IDS, type StrategyId } from '$lib/engine'
  import { STRATEGY_LABELS } from '$lib/workers/computeCore'
  import { gemCatalog, type CatalogSpec } from '$lib/services/gemCatalogService'
  import {
    getBackgroundObservation,
    getLayers,
    getSelectionOrder,
    isBackgroundSelected,
    selectedConfigView,
    setBackgroundObservation,
    writeSelectedLayerConfig,
    type LayerConfigPatch,
  } from '$lib/stores/studio.svelte'
  import { BACKGROUND_OPACITY_DEFAULT } from '$lib/studio/layers.svelte'
  import { SLIDER_COMMIT_DEBOUNCE_MS } from '$lib/studio/debounce'
  import SliderField from './SliderField.svelte'

  const view = $derived(selectedConfigView())
  const background = $derived(getBackgroundObservation())
  const backgroundSelected = $derived(isBackgroundSelected())

  // ---- 规格目录（GemCatalogService 接口——真源状态随 expert 5.6，对本方透明）----
  let specs = $state<CatalogSpec[]>([])
  $effect(() => {
    void gemCatalog.listSpecs().then((list) => {
      specs = list
    })
  })

  function specLabel(specKey: string): string {
    const spec = specs.find((s) => s.specKey === specKey)
    return spec ? `${spec.sizeLabel} · ${spec.diameterMm}mm` : specKey
  }

  /** 任一配置控件提交 = 写入全部选中普通层（单 op；混合态预填锚点值为基础修改）。 */
  function commit(patch: LayerConfigPatch, groupId?: string): void {
    if (getSelectionOrder().length === 0) return
    writeSelectedLayerConfig(patch, groupId !== undefined ? { immediate: true } : {})
  }

  // ---- 滑杆乐观 UI（本地镜像 + trailing 提交；混合态预填锚点值）----
  let gapValue = $state(40)
  $effect(() => {
    const next = Math.round((view?.gapMm.value ?? 0.4) * 100)
    untrack(() => {
      if (next !== gapValue) gapValue = next
    })
  })

  let densityValue = $state(100)
  $effect(() => {
    const next = Math.round((view?.density.value ?? 1) * 100)
    untrack(() => {
      if (next !== densityValue) densityValue = next
    })
  })

  let opacityValue = $state(Math.round(BACKGROUND_OPACITY_DEFAULT * 100))
  $effect(() => {
    const next = Math.round(background.opacity * 100)
    untrack(() => {
      if (next !== opacityValue) opacityValue = next
    })
  })

  const relax = $derived(view?.relax.value ?? { boundary: false, repulsion: false })
</script>

{#if backgroundSelected}
  <!-- 背景层面板（选中背景行 → 1-5 区替换：源 + 透明度 + 只读说明） -->
  <div class="grid gap-3 rounded-xl border bg-card p-3" data-testid="background-panel">
    <div class="flex items-center gap-2 text-xs font-medium">
      <span class="text-muted-foreground">背景层</span>
      <span class="text-muted-foreground font-normal">不参与排布与统计</span>
    </div>
    <label class="grid gap-1 text-xs">
      <span class="text-muted-foreground">背景源</span>
      <Select.Root
        type="single"
        value={background.source}
        onValueChange={(v) => setBackgroundObservation({ source: v as 'none' | 'painting' | 'reference' })}
      >
        <Select.Trigger class="h-8 w-full text-xs" data-testid="background-source-select">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="none" label="无（纯钻）" class="text-xs">无（纯钻）</Select.Item>
          <Select.Item value="painting" label="数字油画" class="text-xs">数字油画</Select.Item>
          <Select.Item value="reference" label="原图" class="text-xs">原图</Select.Item>
        </Select.Content>
      </Select.Root>
    </label>
    <SliderField
      label="背景透明度"
      bind:value={opacityValue}
      min={0}
      max={100}
      step={1}
      format={(v) => `${v}%`}
      onvaluechange={(v) => setBackgroundObservation({ opacity: Math.max(0, v) / 100 })}
    />
    <p class="text-muted-foreground text-[11px] leading-relaxed">
      背景是独立图层：钉底、不可删除、不参与排布/统计/导出。切换源与透明度是纯观察操作，不入工程文件。
    </p>
  </div>
{:else if view}
  <div class="grid gap-3 rounded-xl border bg-card p-3" data-testid="layer-config-card">
    <!-- 横幅区：单选层名 / 配置相同 / 配置不同·锚点基准 -->
    <div class="flex items-center gap-2 text-xs" data-testid="layer-config-banner">
      {#if view.count === 1}
        <span class="truncate font-medium">{view.anchorName}</span>
      {:else if view.banner === 'same'}
        <span class="truncate font-medium">{view.count} 层 · 配置相同</span>
      {:else}
        <span class="truncate font-medium" data-testid="layer-config-mixed">
          {view.count} 层配置不同 · 以 ①{view.anchorName} 为基准
        </span>
      {/if}
      {#if view.count > 1}
        <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{view.count} 层选中</span>
      {/if}
    </div>

    <!-- 策略 Select：全应用唯一策略写入点（胶片带废除后） -->
    <label class="grid gap-1 text-xs">
      <span class="text-muted-foreground">排钻策略（{view.count > 1 ? `写入全部 ${view.count} 层` : '本层'}）</span>
      <Select.Root
        type="single"
        value={view.strategy.value}
        onValueChange={(v) => commit({ strategy: v as StrategyId })}
      >
        <Select.Trigger class="h-8 w-full text-xs" data-testid="layer-strategy-select">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {#each STRATEGY_IDS as sid (sid)}
            <Select.Item value={sid} label={STRATEGY_LABELS[sid]} class="text-xs">
              {STRATEGY_LABELS[sid]}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>

    <!-- 物理组：规格 Select（gemCatalog 接口）+ gap/层密度滑杆 + 松弛双开关 -->
    <label class="grid gap-1 text-xs">
      <span class="text-muted-foreground">基础规格</span>
      <Select.Root
        type="single"
        value={view.specKey.value}
        onValueChange={(v) => commit({ specKey: v })}
      >
        <Select.Trigger class="h-8 w-full text-xs" data-testid="layer-spec-select">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {#each specs as spec (spec.specKey)}
            <Select.Item value={spec.specKey} label={specLabel(spec.specKey)} class="text-xs">
              {specLabel(spec.specKey)}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
      <SliderField
        label="gap（钻间间隙）"
        bind:value={gapValue}
        min={40}
        max={80}
        step={5}
        format={(v) => `${(v / 100).toFixed(2)}mm`}
        debounceMs={SLIDER_COMMIT_DEBOUNCE_MS}
        onvaluechange={(v) => writeSelectedLayerConfig({ gapMm: v / 100 }, { immediate: true })}
      />
      <SliderField
        label="层密度（未覆写块）"
        bind:value={densityValue}
        min={0}
        max={100}
        step={1}
        format={(v) => `${v}%`}
        debounceMs={SLIDER_COMMIT_DEBOUNCE_MS}
        onvaluechange={(v) => writeSelectedLayerConfig({ density: v / 100 }, { immediate: true })}
      />
    </div>

    <div class="grid grid-cols-2 gap-2">
      <button
        type="button"
        class="rounded-md border px-2 py-1.5 text-xs transition-colors {relax.boundary
          ? 'border-primary bg-accent/50 text-foreground'
          : 'text-muted-foreground hover:bg-muted'}"
        aria-pressed={relax.boundary}
        title="分块边界附近允许放宽间距（重算后生效）"
        onclick={() => commit({ relax: { ...relax, boundary: !relax.boundary } })}
        data-testid="layer-relax-boundary"
      >
        边界松弛
      </button>
      <button
        type="button"
        class="rounded-md border px-2 py-1.5 text-xs transition-colors {relax.repulsion
          ? 'border-primary bg-accent/50 text-foreground'
          : 'text-muted-foreground hover:bg-muted'}"
        aria-pressed={relax.repulsion}
        title="对违规钻对施加斥力位移（重算后生效）"
        onclick={() => commit({ relax: { ...relax, repulsion: !relax.repulsion } })}
        data-testid="layer-relax-repulsion"
      >
        斥力修复
      </button>
    </div>
  </div>
{:else}
  <div
    class="text-muted-foreground flex items-center gap-2 rounded-xl border border-dashed bg-card/60 px-3 py-2.5 text-xs"
    data-testid="layer-config-empty"
  >
    左侧图层面板选择图层后，在这里配置策略与物理参数
  </div>
{/if}
