<!--
Orthogonal intents (max 3):
1. [2026-09-18 R3 PM-Q3] 全局物理参数（项目级常数，设定后数个会话不动 → 折叠收纳）：
     SS 钻径 + gap（→ grid 重建）+ 全局密度（作用于未覆写的块）。
2. [2026-09-18 R5 vision#16] 零值/估算类数字去徽标化：全局预估钻数用纯文本 mono，不再用 Badge。
3. [2026-09-19 Busy 切片] gap/全局密度滑杆乐观 UI + 300ms trailing 提交（immediate 直起计算轮），
     计算中数值 label 转「计算中…」（SliderField busy 承载）；SS Select 是离散选择，走 store 既有防抖不动。
-->

<script lang="ts">
  import { untrack } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import { SS_KEYS, SS_TABLE, type SSKey } from '$lib/engine'
  import {
    getComputing,
    getGapMm,
    getGlobalDensity,
    getSs,
    getTotalEstimate,
    setGapMm,
    setGlobalDensity,
    setSs,
  } from '$lib/stores/studio.svelte'
  import { SLIDER_COMMIT_DEBOUNCE_MS } from '$lib/studio/debounce'
  import SliderField from './SliderField.svelte'

  // 滑杆本地绑定（store → 本地 → store）。镜像 effect 只依赖 store 值（本地值 untrack）：
  // 防抖窗口内 store 落后于乐观本地值时，镜像不会把 thumb 拽回旧值（受控往返）。
  let gapValue = $state(0.4)
  $effect(() => {
    const next = getGapMm()
    untrack(() => {
      if (next !== gapValue) gapValue = next
    })
  })

  let globalDensityValue = $state(100)
  $effect(() => {
    const next = Math.round(getGlobalDensity() * 100)
    untrack(() => {
      if (next !== globalDensityValue) globalDensityValue = next
    })
  })

  const totalEstimate = $derived(getTotalEstimate())
  const computing = $derived(getComputing())
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
      debounceMs={SLIDER_COMMIT_DEBOUNCE_MS}
      onvaluechange={(v) => setGapMm(v, { immediate: true })}
      busy={computing}
    />
  </div>

  <SliderField
    label="全局密度（未单独覆写的块）"
    bind:value={globalDensityValue}
    min={1}
    max={100}
    step={1}
    format={(v) => `${v}%`}
    debounceMs={SLIDER_COMMIT_DEBOUNCE_MS}
    onvaluechange={(v) => setGlobalDensity(Math.max(1, v) / 100, { immediate: true })}
    busy={computing}
  />

  <p class="text-muted-foreground font-mono text-xs tabular-nums">
    全局口径预估 {totalEstimate.toLocaleString()} 钻（各策略实际钻数见对比网格 / 导出条）
  </p>
</div>
