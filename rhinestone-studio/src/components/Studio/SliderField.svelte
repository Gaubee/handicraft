<!--
Orthogonal intents (max 3):
1. [2026-09-18 R5 vision#15] 滑杆统一 Field 结构：label（text-xs muted）+ 右侧当前值（font-mono tabular-nums）。
2. [2026-09-18 R4 PM-4.5] 触控命中 ≥44px：Slider 根元素 h-11（bits-ui 在根上收 pointer 事件，根即命中区）。
3. [2026-09-19 Busy 切片] input-range 乐观 UI + trailing debounce（Owner 裁决）：
     debounceMs > 0 时 thumb/数值 label 逐帧乐观更新（bind:value 本地直连，store 零写入），
     onvaluechange 于停止交互 debounceMs 后携末值提交一次（连拖合并、新输入取消旧 pending、不排队旧值）；
     卸载自动 cancel；外部写回（复位/换图镜像同步）≠ 拖动末值时 pending 作废（外部值胜出）。
     busy=true（计算轮在途）→ 数值 label 转「计算中…」pulse 态（title 保留数值可核对）。
     纯视觉滑杆（透明度）不传 debounceMs：onvaluechange 逐帧实时，无防抖。
-->

<script lang="ts">
  import { untrack } from 'svelte'
  import { Slider } from '$lib/components/ui/slider'
  import { createDebounce } from '$lib/studio/debounce'

  let {
    label,
    value = $bindable(0),
    min,
    max,
    step,
    disabled = false,
    format,
    onvaluechange,
    debounceMs = 0,
    busy = false,
  }: {
    label: string
    value: number
    min: number
    max: number
    step: number
    disabled?: boolean
    format?: (value: number) => string
    /** 提交回调：debounceMs=0 逐帧实时；>0 时 trailing 合并后携末值触发一次 */
    onvaluechange?: (value: number) => void
    /** trailing 防抖窗口（ms）；0 = 实时（纯视觉滑杆） */
    debounceMs?: number
    /** 计算轮在途：数值 label 转「计算中…」（乐观值仍写本地，thumb 不冻结） */
    busy?: boolean
  } = $props()

  // ---- 乐观 UI + trailing 提交（debounceMs > 0 时启用） ----
  // 拖动末值快照：外部写回 value 且 ≠ 末值（复位/换图）→ pending 作废，防止迟到提交复活旧参数
  let pendingValue: number | null = null
  // debounceMs 按挂载时初值取定（所有调用点传字面量）；untrack 显式声明「有意只取初值」
  const commit = createDebounce(
    (v: number) => {
      pendingValue = null
      onvaluechange?.(v)
    },
    untrack(() => Math.max(0, debounceMs)),
  )
  $effect(() => {
    // 卸载自动取消（$effect 无依赖只跑一次，cleanup 在销毁时执行）
    return () => commit.cancel()
  })
  $effect(() => {
    if (commit.isPending() && pendingValue !== null && value !== pendingValue) commit.cancel()
  })

  function handleValueChange(v: number): void {
    if (debounceMs <= 0) {
      onvaluechange?.(v)
      return
    }
    pendingValue = v
    commit(v)
  }

  const valueText = $derived(format ? format(value) : String(value))
</script>

<div class="grid gap-0.5" data-disabled={disabled || undefined} data-slider-field={label}>
  <div class="flex items-baseline justify-between gap-2 text-xs">
    <span class="text-muted-foreground truncate">{label}</span>
    {#if busy}
      <span
        class="text-muted-foreground ml-auto shrink-0 animate-pulse text-xs"
        aria-live="polite"
        title={valueText}
        data-testid="slider-value-busy"
      >计算中…</span>
    {:else}
      <span class="ml-auto shrink-0 font-mono text-xs tabular-nums" data-testid="slider-value">
        {valueText}
      </span>
    {/if}
  </div>
  <Slider
    type="single"
    bind:value
    {min}
    {max}
    {step}
    {disabled}
    class="h-11"
    onValueChange={(v) => handleValueChange(v)}
  />
</div>
