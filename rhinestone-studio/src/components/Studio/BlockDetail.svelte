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
  import type { BlockType } from '$lib/engine'
  import {
    getActualBlockCount,
    getBlockDensity,
    getBlockEstimate,
    getBlocks,
    getColorOverride,
    getComputing,
    getPalette,
    getSelectedBlockId,
    getTypeOverride,
    isEnabled,
    setBlockColor,
    setBlockDensity,
    setBlockType,
    setEnabled,
  } from '$lib/stores/studio.svelte'
  import { SLIDER_COMMIT_DEBOUNCE_MS, createDebounce } from '$lib/studio/debounce'
  import LabelProgress from './LabelProgress.svelte'
  import SliderField from './SliderField.svelte'

  const TYPE_LABELS: Record<BlockType, string> = { fill: '填充', linear: '线条', element: '元素' }

  const blocks = $derived(getBlocks())
  const palette = $derived(getPalette())
  const selectedId = $derived(getSelectedBlockId())
  const selected = $derived(blocks.find((b) => b.id === selectedId))
  const computing = $derived(getComputing())

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
    if (id) densityCommit(Math.max(1, v) / 100, id)
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
      <Badge variant="secondary" class="shrink-0">建议 {TYPE_LABELS[selected.suggested]}</Badge>
      <span class="text-muted-foreground ml-auto hidden shrink-0 font-mono text-[11px] tabular-nums sm:inline">
        {selected.areaPx}px² · 宽 {selected.widthPx.max}px
      </span>
    </div>

    <SliderField
      label="密度"
      bind:value={densityValue}
      min={1}
      max={100}
      step={1}
      disabled={!isEnabled(selected.id)}
      format={(v) => `${v}% · 预估 ${getBlockEstimate(selected, Math.max(1, v) / 100)} 钻`}
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
  </div>
{:else}
  <div
    class="text-muted-foreground flex items-center gap-2 rounded-xl border border-dashed bg-card/60 px-3 py-2.5 text-xs"
    data-testid="block-detail-empty"
  >
    点击画布或下方列表中的块，在这里精调密度 / 类型 / 颜色
  </div>
{/if}
