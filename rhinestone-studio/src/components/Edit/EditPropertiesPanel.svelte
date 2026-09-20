<!--
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 属性面板区（PS Inspector 语义）：选中对象
 *    的属性，三态框架（空态引导 / 单选全字段 / N 选计数）。编辑器永不长排钻参数面板
 *    （概念混入禁令，add-project-files §4）。
 * 2. [2026-09-20 C-3.4] 字段渲染框架：字段描述符（properties.ts）→ 控件；写入统一 update
 *    patch、N 选批量 = 单 undo 组（applyGemChanges）；混合值占位「—」。
 *    [2026-09-20 D-5.1] 规格三字段（形状/尺寸/朝向）已注册为可用控件（渲染框架零改动）。
 * 3. [2026-09-20 C-3.5] 对齐六式（≥2）/ 等距分布（≥3）命令区（只消费 x/y；批量 = 单 undo 组）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { findPaletteColor } from '$lib/engine'
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import {
    ALIGN_COMMANDS,
    buildAlignChanges,
    buildDistributeChanges,
    DISTRIBUTION_COMMANDS,
  } from '$lib/designer/alignDistribute'
  import { buildFieldUpdatePatch, computePropertyViews } from '$lib/designer/properties'
  import type { PropertyFieldView } from '$lib/designer/properties'
  import { applyGemChanges } from '$lib/designer/gemCommands'

  const doc = $derived(getEditDoc())
  const selectionCount = $derived(doc?.selection.size ?? 0)
  /** 选中钻快照（selection SvelteSet 驱动重渲染）。 */
  const selectedGems = $derived.by(() => {
    const d = doc
    if (!d || d.selection.size === 0) return []
    const byId = new Map(d.gems.map((g) => [g.id, g] as const))
    const out = []
    for (const id of d.selection) {
      const gem = byId.get(id)
      if (gem) out.push(gem)
    }
    return out
  })
  const views = $derived(computePropertyViews(selectedGems))
  const palette = $derived(doc?.palette ?? [])

  /** 字段写入（change 事件）：N 选批量 = 一条 update patch = 单 undo 组。 */
  function onFieldInput(view: PropertyFieldView, event: Event): void {
    const target = event.currentTarget as HTMLInputElement | HTMLSelectElement
    const raw = target.value
    if (view.field.control === 'reserved' || selectedGems.length === 0 || raw === '') return
    const value = view.field.control === 'number' ? Number(raw) : raw
    if (typeof value === 'number' && !Number.isFinite(value)) return
    const patch = buildFieldUpdatePatch(selectedGems, view.field, value)
    if (patch === null) return
    applyGemChanges(patch.changes)
  }

  function colorName(id: string): string {
    return findPaletteColor(palette, id)?.name ?? id
  }

  /** [redesign 2.x] 所属图层只读显示（归属改写走移入图层/合并命令面，4.x 落）。 */
  function layerNameOf(view: PropertyFieldView): string {
    if (view.state === 'mixed') return '—（跨层）'
    const id = view.value
    return typeof id === 'string' ? (doc?.layers.find((l) => l.id === id)?.name ?? id) : '—'
  }

  function align(mode: (typeof ALIGN_COMMANDS)[number]['id']): void {
    applyGemChanges(buildAlignChanges(selectedGems, mode))
  }

  function distribute(mode: (typeof DISTRIBUTION_COMMANDS)[number]['id']): void {
    const changes = buildDistributeChanges(selectedGems, mode)
    if (changes !== null) applyGemChanges(changes)
  }
</script>

<section
  class="flex min-h-0 flex-col rounded-xl border bg-card"
  data-testid="edit-properties"
  aria-label="属性面板"
>
  <header class="flex items-center justify-between gap-2 border-b px-3 py-2">
    <h3 class="text-xs font-semibold tracking-tight">属性</h3>
    <span
      class="text-muted-foreground font-mono text-[11px] tabular-nums"
      data-testid="edit-properties-count"
    >
      {selectionCount > 0 ? `${selectionCount} 颗已选` : '未选中'}
    </span>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
    {#if selectionCount === 0}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs leading-relaxed" data-testid="edit-properties-empty">
        点选或框选钻后在此编辑属性
      </p>
    {:else}
      <div class="grid gap-2.5" data-testid="edit-properties-fields">
        {#each views as view (view.field.key)}
          {#if view.field.control === 'reserved'}
            <div class="grid gap-1" data-testid={`edit-prop-reserved-${view.field.key}`}>
              <span class="text-muted-foreground text-[11px] font-medium">{view.field.label}</span>
              <span
                class="text-muted-foreground/70 flex h-7 items-center rounded-md border border-dashed px-2 text-[11px]"
                title={view.field.note}
              >
                —（{view.field.note}）
              </span>
            </div>
          {:else if view.field.control === 'color'}
            <div class="grid gap-1" data-testid="edit-prop-colorId">
              <label class="text-[11px] font-medium" for="edit-prop-color-select">{view.field.label}</label>
              <select
                id="edit-prop-color-select"
                class="border-input bg-background h-7 w-full rounded-md border px-1.5 text-xs shadow-xs outline-none focus-visible:border-ring"
                value={view.state === 'uniform' ? (view.value as string) : ''}
                data-mixed={view.state === 'mixed'}
                onchange={(e) => onFieldInput(view, e)}
              >
                {#if view.state === 'mixed'}
                  <option value="" disabled selected>—（混合值）</option>
                {/if}
                {#each palette as color (color.id)}
                  <option value={color.id}>{colorName(color.id)}</option>
                {/each}
              </select>
            </div>
          {:else if view.field.control === 'layer'}
            <!-- [redesign 2.x] 所属图层：只读字段（单选显示层名；N 选跨层显示混合占位） -->
            <div class="grid gap-1" data-testid="edit-prop-layerId">
              <span class="text-[11px] font-medium">{view.field.label}</span>
              <span
                class="text-muted-foreground flex h-7 items-center rounded-md border px-2 text-[11px]"
                data-mixed={view.state === 'mixed'}
              >
                {layerNameOf(view)}
              </span>
            </div>
          {:else if view.field.control === 'select'}
          <!-- [D-5.1] 形状 select 已注册（内置五形目录——custom 不在列，见 properties.ts 头注） -->
          <div class="grid gap-1" data-testid={`edit-prop-${view.field.key}`}>
              <label class="text-[11px] font-medium" for={`edit-prop-select-${view.field.key}`}>
                {view.field.label}
              </label>
              <select
                id={`edit-prop-select-${view.field.key}`}
                class="border-input bg-background h-7 w-full rounded-md border px-1.5 text-xs"
                value={view.state === 'uniform' ? (view.value as string) : ''}
                onchange={(e) => onFieldInput(view, e)}
              >
                {#if view.state === 'mixed'}<option value="" disabled selected>—（混合值）</option>{/if}
                {#each view.field.options as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </div>
          {:else}
            <div class="grid gap-1" data-testid={`edit-prop-${view.field.key}`}>
              <label class="text-[11px] font-medium" for={`edit-prop-input-${view.field.key}`}>
                {view.field.label}
                <span class="text-muted-foreground font-normal">（{view.field.unit}）</span>
              </label>
              <input
                id={`edit-prop-input-${view.field.key}`}
                type="number"
                step={view.field.step}
                class="border-input bg-background h-7 w-full rounded-md border px-2 font-mono text-xs tabular-nums shadow-xs outline-none focus-visible:border-ring"
                value={view.state === 'uniform' ? String(view.value) : ''}
                placeholder={view.state === 'mixed' ? '—（混合值）' : ''}
                data-mixed={view.state === 'mixed'}
                onchange={(e) => onFieldInput(view, e)}
              />
            </div>
          {/if}
        {/each}
      </div>

      {#if selectedGems.length >= 2}
        <div class="mt-3 border-t pt-2.5" data-testid="edit-prop-align">
          <p class="text-muted-foreground mb-1.5 text-[11px] font-medium">对齐（{selectedGems.length} 选）</p>
          <div class="grid grid-cols-3 gap-1">
            {#each ALIGN_COMMANDS as cmd (cmd.id)}
              <Button
                variant="outline"
                size="xs"
                class="h-6 px-1 text-[11px]"
                onclick={() => align(cmd.id)}
                data-testid={`edit-align-${cmd.id}`}
              >
                {cmd.label}
              </Button>
            {/each}
          </div>
          {#if selectedGems.length >= 3}
            <div class="mt-1 grid grid-cols-2 gap-1" data-testid="edit-prop-distribute">
              {#each DISTRIBUTION_COMMANDS as cmd (cmd.id)}
                <Button
                  variant="outline"
                  size="xs"
                  class="h-6 px-1 text-[11px]"
                  onclick={() => distribute(cmd.id)}
                  data-testid={`edit-distribute-${cmd.id}`}
                >
                  {cmd.label}
                </Button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</section>
