<!--
Orthogonal intents (max 2):
1. [2026-09-18 R5 vision#15] 滑杆统一 Field 结构：label（text-xs muted）+ 右侧当前值（font-mono tabular-nums）。
2. [2026-09-18 R4 PM-4.5] 触控命中 ≥44px：Slider 根元素 h-11（bits-ui 在根上收 pointer 事件，根即命中区）。
-->

<script lang="ts">
  import { Slider } from '$lib/components/ui/slider'

  let {
    label,
    value = $bindable(0),
    min,
    max,
    step,
    disabled = false,
    format,
    onvaluechange,
  }: {
    label: string
    value: number
    min: number
    max: number
    step: number
    disabled?: boolean
    format?: (value: number) => string
    onvaluechange?: (value: number) => void
  } = $props()
</script>

<div class="grid gap-0.5" data-disabled={disabled || undefined}>
  <div class="flex items-baseline justify-between gap-2 text-xs">
    <span class="text-muted-foreground truncate">{label}</span>
    <span class="ml-auto shrink-0 font-mono text-xs tabular-nums">
      {format ? format(value) : value}
    </span>
  </div>
  <Slider
    type="single"
    bind:value
    {min}
    {max}
    {step}
    {disabled}
    class="h-11"
    onValueChange={(v) => onvaluechange?.(v)}
  />
</div>
