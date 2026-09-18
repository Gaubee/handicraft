<!--
Orthogonal intents (max 2):
1. [2026-09-18 R3 PM-Q3] 全局物理参数（项目级常数，设定后数个会话不动 → 折叠收纳）：
     SS 钻径 + gap（→ grid 重建）+ 全局密度（作用于未覆写的块）。
2. [2026-09-18 R5 vision#16] 零值/估算类数字去徽标化：全局预估钻数用纯文本 mono，不再用 Badge。
-->

<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import { SS_KEYS, SS_TABLE, type SSKey } from '$lib/engine'
  import {
    getGapMm,
    getGlobalDensity,
    getSs,
    getTotalEstimate,
    setGapMm,
    setGlobalDensity,
    setSs,
  } from '$lib/stores/studio.svelte'
  import SliderField from './SliderField.svelte'

  // 滑杆本地绑定（store → 本地 → store，值未变不写守卫防受控振荡）
  let gapValue = $state(0.4)
  $effect(() => {
    const next = getGapMm()
    if (next !== gapValue) gapValue = next
  })

  let globalDensityValue = $state(100)
  $effect(() => {
    const next = Math.round(getGlobalDensity() * 100)
    if (next !== globalDensityValue) globalDensityValue = next
  })

  const totalEstimate = $derived(getTotalEstimate())
</script>

<div class="grid gap-3">
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
    <label class="grid gap-1 text-xs">
      <span class="text-muted-foreground">SS 钻径（决定网格间距）</span>
      <Select.Root type="single" value={getSs()} onValueChange={(v) => setSs(v as SSKey)}>
        <Select.Trigger class="h-8 w-full text-xs">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {#each SS_KEYS as k (k)}
            <Select.Item value={k} label={`${k} · ${SS_TABLE[k].toFixed(1)}mm`} class="text-xs">
              {k} · {SS_TABLE[k].toFixed(1)}mm
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>
    <SliderField
      label="gap（钻间间隙）"
      bind:value={gapValue}
      min={0.4}
      max={0.8}
      step={0.05}
      format={(v) => `${v.toFixed(2)}mm`}
      onvaluechange={(v) => setGapMm(v)}
    />
  </div>

  <SliderField
    label="全局密度（未单独覆写的块）"
    bind:value={globalDensityValue}
    min={1}
    max={100}
    step={1}
    format={(v) => `${v}%`}
    onvaluechange={(v) => setGlobalDensity(Math.max(1, v) / 100)}
  />

  <p class="text-muted-foreground font-mono text-xs tabular-nums">
    全局口径预估 {totalEstimate.toLocaleString()} 钻（各策略实际钻数见对比网格 / 导出条）
  </p>
</div>
