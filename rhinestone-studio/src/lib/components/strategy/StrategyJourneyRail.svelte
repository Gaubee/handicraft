<!--
StrategyJourneyRail.svelte — 旅程串联位（add-subject-sam-pipeline P3.2/P3.3 地基）。
「上传图+cm 尺寸→scene.analyze→segment 循环→strategy.design」引导链：各步经
Agent 对话工具调用自然发生——本面只按帧在场呈现各步工件卡（树预览/叠加图/指派
表经左侧会话流呈现），不驱动不伪造。
-->

<script lang="ts">
  import { getStrategyJourney } from '$lib/strategyDesigner/store.svelte'
  import Circle from '@lucide/svelte/icons/circle'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  const steps = $derived(getStrategyJourney())

  const STATUS_LABEL: Record<string, string> = { done: '已产出', active: '待批准', pending: '待发起' }
</script>

<div
  class="bg-background/80 flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 text-xs backdrop-blur"
  data-testid="strategy-journey"
  aria-label="策略设计旅程"
>
  {#each steps as step, i (step.key)}
    {#if i > 0}
      <span class="text-muted-foreground/50 mx-0.5 shrink-0" aria-hidden="true">→</span>
    {/if}
    <div
      class="flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 {step.status === 'done'
        ? 'border-primary/40 bg-primary/10 text-primary'
        : step.status === 'active'
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600'
          : 'text-muted-foreground border-border/60'}"
      data-testid="strategy-journey-step-{step.key}"
      data-status={step.status}
      title={step.note ?? STATUS_LABEL[step.status]}
    >
      {#if step.status === 'done'}
        <CircleCheck class="size-3.5" aria-hidden="true" />
      {:else if step.status === 'active'}
        <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
      {:else}
        <Circle class="size-3.5 opacity-60" aria-hidden="true" />
      {/if}
      <span class="whitespace-nowrap">{step.label}</span>
      {#if step.artifactName !== undefined}
        <span class="text-muted-foreground rounded-full bg-muted px-1.5 py-0.5 font-mono text-[9px]" data-testid="strategy-journey-artifact" title={step.blobRef ?? ''}>
          {step.artifactName}
        </span>
      {/if}
    </div>
  {/each}
</div>
