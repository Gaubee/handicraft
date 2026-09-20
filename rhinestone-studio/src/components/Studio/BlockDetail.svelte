<!--
Orthogonal intents (max 3):
1. [2026-09-18 R3 PM-B3/P0-4] 选中块详情：密度滑杆（实时预估钻数）+ 类型/颜色覆写 + 禁用。
     桌面钉在精调列顶部常驻、移动端进底部抽屉——选中即在手边，解决「点了没反应」。
2. [2026-09-18 受控滑杆] store ↔ 本地镜像（值未变不写守卫），防 bits-ui Slider 受控往返回路。
3. [2026-09-19 Busy 切片] 密度滑杆乐观 UI + trailing debounce：拖动中 thumb/数值/预估逐帧乐观
     （预估用乐观密度直算，不读 store），停止 300ms 后携末值 immediate 提交直起计算轮；
     提交目标块 = 拖动时刻选中的块（防 300ms 内切换选中错块）；实排行 label 承载「计算中…」。
-->

<script lang="ts">
  import { untrack } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import { Badge } from '$lib/components/ui/badge'
  import { Switch } from '$lib/components/ui/switch'
  import { STRATEGY_IDS, type BlockType, type StrategyId } from '$lib/engine'
  import { STRATEGY_LABELS } from '$lib/workers/computeCore'
  import { gemCatalog, type CatalogSpec } from '$lib/services/gemCatalogService'
  import {
    getActualBlockCount,
    getBlockConfigView,
    getBlockDensity,
    getBlockEstimate,
    getBlocks,
    getColorOverride,
    getComputing,
    getLayers,
    getPalette,
    getSelectedBlockId,
    getTypeOverride,
    isEnabled,
    moveBlockToLayer,
    owningLayerOf,
    setBlockColor,
    setBlockDensity,
    setBlockInherit,
    setBlockLayerConfig,
    setBlockType,
    setEnabled,
  } from '$lib/stores/studio.svelte'
  import { SLIDER_COMMIT_DEBOUNCE_MS, createDebounce } from '$lib/studio/debounce'
  import LabelProgress from './LabelProgress.svelte'
  import SliderField from './SliderField.svelte'

  const TYPE_LABELS: Record<BlockType, string> = { fill: '填充', linear: '线条', element: '元素' }

  const blocks = $derived(getBlocks())
  const palette = $derived(getPalette())
  let moveMenuOpen = $state(false)
  const selectedId = $derived(getSelectedBlockId())
  const selected = $derived(blocks.find((b) => b.id === selectedId))
  const computing = $derived(getComputing())
  /** [improve 1.2] 当前绑定层（移入图层标签同步真源）。 */
  const ownerLayer = $derived(selected !== undefined ? owningLayerOf(getLayers(), selected.id) : null)
  /** [improve 3.3] 块配置视图（继承开关 + 有效策略/规格）。 */
  const configView = $derived(selected !== undefined ? getBlockConfigView(selected.id) : null)

  // 规格目录（GemCatalogService 接口——LayerConfigCard 同源；禁第二目录真源）
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

  // 密度滑杆本地绑定（store → 本地 → store）。镜像只依赖 store 值（本地 untrack）：
  // 防抖窗口内 store 落后于乐观本地值时不回拽 thumb；换选中块时仍同步到新块密度。
  let densityValue = $state(100)
  $effect(() => {
    const next = Math.round(getBlockDensity(selected?.id ?? '') * 100)
    untrack(() => {
      if (next !== densityValue) densityValue = next
    })
  })

  // 密度 trailing 提交：携 (末值, 拖动时刻块 id)——提交目标以拖动意图为准，防 300ms 内切换选中错块
  const densityCommit = createDebounce<[density: number, blockId: string]>(
    (density, blockId) => setBlockDensity(blockId, density, { immediate: true }),
    SLIDER_COMMIT_DEBOUNCE_MS,
  )
  $effect(() => {
    // 卸载自动取消（移动端抽屉关闭即卸载；桌面上选中切换不卸载，pending 仍按拖动意图落地）
    return () => densityCommit.cancel()
  })

  function onDensityValueChange(v: number): void {
    const id = selected?.id
    // [improve 4.2] 密度可拉到 0%（0 = 无钻：排除口径同禁用块，不参与排布/预估/统计）
    if (id) densityCommit(v / 100, id)
  }

  function rgbCss(rgb: [number, number, number]): string {
    return `rgb(${rgb.map((v) => Math.round(v)).join(' ')})`
  }
</script>

{#if selected}
  {@const typeOverride = getTypeOverride(selected.id)}
  <div class="grid gap-3 rounded-xl border bg-card p-3" data-testid="block-detail">
    <div class="flex items-center gap-2 text-xs">
      <span class="size-4 shrink-0 rounded-sm border" style="background: {rgbCss(selected.colorRgb)}"></span>
      <span class="truncate font-medium">{selected.label}</span>
      <!-- [improve 4.1]「建议 填充」类推断提示删除（Owner 点 3）——类型值仍可在类型 Select 的「自动（X）」中查看 -->
      <span class="text-muted-foreground ml-auto hidden shrink-0 font-mono text-[11px] tabular-nums sm:inline">
        {selected.areaPx}px² · 宽 {selected.widthPx.max}px
      </span>
    </div>

    <SliderField
      label="密度"
      bind:value={densityValue}
      min={0}
      max={100}
      step={1}
      disabled={!isEnabled(selected.id)}
      format={(v) => `${v}% · 预估 ${getBlockEstimate(selected, v / 100)} 钻`}
      onvaluechange={onDensityValueChange}
      busy={computing}
    />
    <p class="text-muted-foreground -mt-2 font-mono text-[11px] tabular-nums">
      {#if isEnabled(selected.id)}
        <LabelProgress
          text={`当前策略实排 ${getActualBlockCount(selected.id)} 钻`}
          busy={computing}
        />
      {:else}
        已禁用 · 不参与排钻
      {/if}
    </p>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label class="grid gap-1 text-xs">
        <span class="text-muted-foreground">类型</span>
        <Select.Root
          type="single"
          value={typeOverride ?? 'auto'}
          onValueChange={(v) => setBlockType(selected.id, v === 'auto' ? null : (v as BlockType))}
        >
          <Select.Trigger class="h-8 w-full text-xs"><Select.Value /></Select.Trigger>
          <Select.Content>
            <Select.Item value="auto" label={`自动（${TYPE_LABELS[selected.suggested]}）`} class="text-xs">
              自动（{TYPE_LABELS[selected.suggested]}）
            </Select.Item>
            <Select.Item value="fill" label="填充 fill" class="text-xs">填充 fill</Select.Item>
            <Select.Item value="linear" label="线条 linear" class="text-xs">线条 linear</Select.Item>
            <Select.Item value="element" label="元素 element" class="text-xs">元素 element</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      <label class="grid gap-1 text-xs">
        <span class="text-muted-foreground">颜色</span>
        <Select.Root
          type="single"
          value={getColorOverride(selected.id) ?? 'auto'}
          onValueChange={(v) => setBlockColor(selected.id, v === 'auto' ? null : v)}
        >
          <Select.Trigger class="h-8 w-full text-xs"><Select.Value /></Select.Trigger>
          <Select.Content>
            <Select.Item value="auto" label="自动（ΔE 最近邻）" class="text-xs">自动（ΔE 最近邻）</Select.Item>
            {#each palette as entry (entry.id)}
              <Select.Item value={entry.id} label={`${entry.name} ${entry.hex}`} class="text-xs">
                {entry.name} {entry.hex}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </label>
    </div>

    <label class="text-muted-foreground hover:text-foreground flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors">
      <span>禁用此块（不排钻）</span>
      <Switch
        size="sm"
        checked={!isEnabled(selected.id)}
        onCheckedChange={(v) => setEnabled(selected.id, !v)}
      />
    </label>

    <!-- [improve 3.3] 块级「继承」开关：开 = 跟随一级图层（只读回显父层值 +「继承中」标记）；
         关 = 独立微调排钻策略 + 基础规格（首次以父层快照起点；再开休眠保留、再关恢复） -->
    <div class="grid gap-2 rounded-md border px-2.5 py-2" data-testid="block-inherit-card">
      <label class="hover:text-foreground flex items-center justify-between gap-2 text-xs transition-colors">
        <span class="text-muted-foreground">继承图层配置（策略 / 基础规格）</span>
        <Switch
          size="sm"
          checked={configView?.inherit ?? true}
          onCheckedChange={(v) => selected && setBlockInherit(selected.id, v, { immediate: true })}
          aria-label={configView?.inherit ? `脱离继承，独立微调 ${selected?.label}` : `恢复继承 ${configView?.ownerName} 配置`}
          data-testid="block-inherit-switch"
        />
      </label>
      {#if configView !== null}
        {#if configView.inherit}
          <div class="text-muted-foreground grid gap-1 text-[11px]" data-testid="block-inherit-readonly">
            <Badge variant="outline" class="w-fit text-[10px]">继承中 · 跟随 {configView.ownerName}</Badge>
            <span>排钻策略：{STRATEGY_LABELS[configView.strategy]}</span>
            <span>基础规格：{specLabel(configView.specKey)}</span>
            <span class="opacity-70">关闭开关即可独立微调（再次开启保留微调值）</span>
          </div>
        {:else}
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="block-independent-config">
            <label class="grid gap-1 text-xs">
              <span class="text-muted-foreground">排钻策略（独立）</span>
              <Select.Root
                type="single"
                value={configView.strategy}
                onValueChange={(v) =>
                  selected && setBlockLayerConfig(selected.id, { strategy: v as StrategyId, specKey: configView.specKey }, { immediate: true })
                }
              >
                <Select.Trigger class="h-8 w-full text-xs" data-testid="block-strategy-select">
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
            <label class="grid gap-1 text-xs">
              <span class="text-muted-foreground">基础规格（独立）</span>
              <Select.Root
                type="single"
                value={configView.specKey}
                onValueChange={(v) =>
                  selected && setBlockLayerConfig(selected.id, { strategy: configView.strategy, specKey: v }, { immediate: true })
                }
              >
                <Select.Trigger class="h-8 w-full text-xs" data-testid="block-spec-select">
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
          </div>
        {/if}
      {/if}
    </div>

    <!-- [improve 1.2] 移入图层 ▸：标签同步当前绑定；移动经 moveBlockToLayer（新旧所属层双标脏——修复「移入不生效」BUG） -->
    <div class="relative">
      <button
        type="button"
        class="hover:bg-muted flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-xs transition-colors"
        onclick={() => (moveMenuOpen = !moveMenuOpen)}
        data-testid="move-to-layer"
      >
        <span>移入图层 · 当前：{ownerLayer?.name ?? '未分配'}</span>
        <span class="text-muted-foreground">▸</span>
      </button>
      {#if moveMenuOpen}
        <div class="absolute bottom-full z-30 mb-1 grid w-full gap-1 rounded-lg border bg-card p-1.5 shadow-lg" data-testid="move-to-layer-menu">
          {#each getLayers() as layer (layer.id)}
            <button
              type="button"
              class="hover:bg-muted rounded px-2 py-1 text-left text-xs disabled:opacity-40"
              disabled={layer.id === ownerLayer?.id}
              title={layer.blockIds === 'rest' ? '兜底层（未显式分配的块自动落入）' : layer.name}
              onclick={() => {
                moveBlockToLayer(selected.id, layer.id)
                moveMenuOpen = false
              }}
              data-testid="move-to-layer-{layer.id}"
            >
              {layer.name}{layer.blockIds === 'rest' ? '（兜底）' : ''}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{:else}
  <div
    class="text-muted-foreground flex items-center gap-2 rounded-xl border border-dashed bg-card/60 px-3 py-2.5 text-xs"
    data-testid="block-detail-empty"
  >
    点击画布或下方列表中的块，在这里精调密度 / 类型 / 颜色
  </div>
{/if}
