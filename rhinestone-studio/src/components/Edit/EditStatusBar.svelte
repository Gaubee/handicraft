<!--
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 状态条区：总钻数 / N 选计数 / 画幅读数位。
 * 2. [2026-09-20 C-3.1/5.7] 画幅物理读数位：canvas prop（PhysicalCanvas 类型，W0 契约）
 *    缺席（运行时数据源未接线，归依赖轨 5.7）时显示「未锚定」占位——缺真源不显示假值
 *    （design §3.2 议题 3 裁决；brief 放宽为可用类型 + 占位）。
-->

<script lang="ts">
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import type { PhysicalCanvas } from '$lib/engine'

  let { canvas = null }: { canvas?: PhysicalCanvas | null } = $props()

  const doc = $derived(getEditDoc())
  const total = $derived(doc?.gems.length ?? 0)
  const selected = $derived(doc?.selection.size ?? 0)
  const pixelsPerMm = $derived(doc?.grid.pixelsPerMm ?? null)

  function mmLabel(value: number): string {
    return `${Math.round(value * 100) / 100}`
  }
</script>

<footer
  class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-1.5 font-mono text-[11px] tabular-nums"
  data-testid="edit-status-bar"
>
  <span data-testid="edit-status-total">{total.toLocaleString()} 钻</span>
  <span data-testid="edit-status-selection" class={selected > 0 ? 'text-foreground' : ''}>
    {selected > 0 ? `已选 ${selected.toLocaleString()}` : '未选中'}
  </span>
  <!-- 画幅读数位：PhysicalCanvas 真值接线归依赖轨 5.7（anchorSource 区分 declared/default） -->
  <span class="ml-auto" data-testid="edit-canvas-readout">
    {#if canvas !== null}
      画幅 {mmLabel(canvas.widthMm)}×{mmLabel(canvas.heightMm)}mm
      {#if pixelsPerMm !== null}· {mmLabel(pixelsPerMm)}px/mm{/if}
      {#if canvas.anchorSource === 'default'}（缺省锚）{/if}
    {:else}
      画幅 未锚定
    {/if}
  </span>
</footer>
