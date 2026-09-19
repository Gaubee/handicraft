<!--
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 状态条区：总钻数 / N 选计数 / 画幅读数位。
 * 2. [2026-09-20 C-3.1/5.7] 画幅物理读数位：canvas prop（PhysicalCanvas 类型，W0 契约）
 *    接 EditView 真值（doc.physicalCanvas——studio-layers ③段 handoff v2 装载后文档态恒
 *    携带；[5.7] 贯通）；null（防御兜底）时显示「未锚定」占位——缺真源不显示假值
 *    （design §3.2 议题 3 裁决）。anchorSource 区分：declared 直读、default 标「缺省锚」。
 * 3. [2026-09-20 D-5.2] pairwise warning 徽标位：validateEditable 派生消费（doc $state 深响应
 *    ——load 后 / 改径/改形后 / undo 后自动重算；专家稿 §I.3-2：spacing=可保存·导出阻断提示，
 *    mask-hint=归属提示不阻断）。非第二真源——纯派生视图，判据单源 engine validateEditable。
-->

<script lang="ts">
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import { validateEditable, type PhysicalCanvas } from '$lib/engine'

  let { canvas = null }: { canvas?: PhysicalCanvas | null } = $props()

  const doc = $derived(getEditDoc())
  const total = $derived(doc?.gems.length ?? 0)
  const selected = $derived(doc?.selection.size ?? 0)
  const pixelsPerMm = $derived(doc?.grid.pixelsPerMm ?? null)

  /** [D-5.2] pairwise warning 派生（gems/grid/blocks 任一变动即重算——load/改径/改形/undo）。 */
  const warnings = $derived.by(() => {
    const d = doc
    if (!d || d.gems.length < 2) return []
    return validateEditable(d.gems, d.grid, d.blocks)
  })
  const spacingCount = $derived(warnings.filter((w) => w.kind === 'spacing').length)
  const maskHintCount = $derived(warnings.filter((w) => w.kind === 'mask-hint').length)

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
  <!-- [D-5.2] pairwise warning 徽标：spacing=可保存·导出将被拦截；mask-hint=归属提示不阻断 -->
  {#if spacingCount > 0}
    <span
      class="text-destructive"
      title={warnings
        .filter((w) => w.kind === 'spacing')
        .map((w) => w.detail)
        .join('\n')}
      data-testid="edit-status-spacing-warnings"
    >
      ⚠ {spacingCount} 处间距冲突（可保存 · 导出将被拦截）
    </span>
  {/if}
  {#if maskHintCount > 0}
    <span
      class="text-destructive/80"
      title={warnings
        .filter((w) => w.kind === 'mask-hint')
        .map((w) => w.detail)
        .join('\n')}
      data-testid="edit-status-mask-hints"
    >
      {maskHintCount} 处越出来源块掩码（提示）
    </span>
  {/if}
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
