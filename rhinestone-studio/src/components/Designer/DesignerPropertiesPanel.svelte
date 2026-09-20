<!--
 * DesignerPropertiesPanel.svelte——属性面板（design §1.2「右侧面板列·上属性」：PS Inspector 语义）。
 *
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 2.x（EditPropertiesPanel 退役重写，框架沿
 *    properties 契约迁移）] 三态框架：空态引导 / 单选全字段（规格/直径/朝向/色/所属图层）/
 *    N 选公共字段 + 混合值「—」。编辑器永不长排钻参数面板（概念混入禁令）。
 * 2. 字段渲染框架：字段描述符（lib/designer/properties）→ 控件；写入统一 update patch、
 *    N 选批量 = 单 undo 组（applyGemChanges）；[4.2] 所属图层字段可改：下拉选层 = 移入
 *    语义（moveGemsToLayer 单 op——与图层面板移入按钮/右键菜单同一命令面，不走字段
 *    update patch 通道）；多选混合层显示「混合」占位不直写（显式选层才执行移入）。
 * 3. 对齐六式（≥2）/ 等距分布（≥3）命令区（只消费 x/y；批量 = 单 undo 组）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { findPaletteColor } from '$lib/engine'
  import { getEditDoc, moveGemsToLayer } from '$lib/stores/edit.svelte'
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
    if (view.field.control === 'reserved' || view.field.control === 'layer' || selectedGems.length === 0 || raw === '') return
    const value = view.field.control === 'number' ? Number(raw) : raw
    if (typeof value === 'number' && !Number.isFinite(value)) return
    const patch = buildFieldUpdatePatch(selectedGems, view.field, value)
    if (patch === null) return
    applyGemChanges(patch.changes)
  }

  function colorName(id: string): string {
    return findPaletteColor(palette, id)?.name ?? id
  }

  /** [4.2] 层选项文案：锁定/隐藏后缀标示禁用原因（option disabled 态的可读性）。 */
  function layerName(layer: { name: string; locked: boolean; visible: boolean }): string {
    const suffix = layer.locked ? '（锁定）' : !layer.visible ? '（隐藏）' : ''
    return `${layer.name}${suffix}`
  }

  /** [4.2] 下拉选层 = 移入命令（moveGemsToLayer 单 op；不走字段 update patch 通道）。
   *  混合态选层 = 显式移入全部选中钻；空占位值（混合占位被选中态）不触发。 */
  function onLayerFieldInput(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement
    const targetLayerId = target.value
    if (targetLayerId === '' || selectedGems.length === 0) return
    moveGemsToLayer(
      selectedGems.map((g) => g.id),
      targetLayerId,
    )
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
  data-testid="designer-properties"
  aria-label="属性面板"
>
  <header class="flex items-center justify-between gap-2 border-b px-3 py-2">
    <h3 class="text-xs font-semibold tracking-tight">属性</h3>
    <span
      class="text-muted-foreground font-mono text-[11px] tabular-nums"
      data-testid="designer-properties-count"
    >
      {selectionCount > 0 ? `${selectionCount} 颗已选` : '未选中'}
    </span>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
    {#if selectionCount === 0}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs leading-relaxed" data-testid="designer-properties-empty">
        点选或框选钻后在此编辑属性
      </p>
    {:else}
      <div class="grid gap-2.5" data-testid="designer-properties-fields">
        {#each views as view (view.field.key)}
          {#if view.field.control === 'reserved'}
            <div class="grid gap-1" data-testid={`designer-prop-reserved-${view.field.key}`}>
              <span class="text-muted-foreground text-[11px] font-medium">{view.field.label}</span>
              <span
                class="text-muted-foreground/70 flex h-7 items-center rounded-md border border-dashed px-2 text-[11px]"
                title={view.field.note}
              >
                —（{view.field.note}）
              </span>
            </div>
          {:else if view.field.control === 'layer'}
            <!-- [4.2] 所属图层：下拉选层 = 移入语义（单 op）；混合层显示占位不直写；
                 锁定/隐藏目标禁用（design §2.2 移入图层禁用纪律） -->
            <div class="grid gap-1" data-testid="designer-prop-layerId">
              <label class="text-[11px] font-medium" for="designer-prop-layer-select">{view.field.label}</label>
              <select
                id="designer-prop-layer-select"
                class="border-input bg-background h-7 w-full rounded-md border px-1.5 text-xs shadow-xs outline-none focus-visible:border-ring"
                value={view.state === 'uniform' ? (view.value as string) : ''}
                data-mixed={view.state === 'mixed'}
                title={view.state === 'mixed' ? '选中钻分属多个图层（选择图层将全部移入）' : '移入选中钻到该图层'}
                onchange={(e) => onLayerFieldInput(e)}
              >
                {#if view.state === 'mixed'}
                  <option value="" disabled selected>—（跨层，选择图层将全部移入）</option>
                {/if}
                {#each doc?.layers ?? [] as layer (layer.id)}
                  <option value={layer.id} disabled={layer.locked || !layer.visible}>
                    {layerName(layer)}
                  </option>
                {/each}
              </select>
            </div>
          {:else if view.field.control === 'color'}
            <div class="grid gap-1" data-testid="designer-prop-colorId">
              <label class="text-[11px] font-medium" for="designer-prop-color-select">{view.field.label}</label>
              <select
                id="designer-prop-color-select"
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
          {:else if view.field.control === 'select'}
            <!-- 形状 select（内置五形目录——custom 不在列，见 properties.ts 头注） -->
            <div class="grid gap-1" data-testid={`designer-prop-${view.field.key}`}>
              <label class="text-[11px] font-medium" for={`designer-prop-select-${view.field.key}`}>
                {view.field.label}
              </label>
              <select
                id={`designer-prop-select-${view.field.key}`}
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
            <div class="grid gap-1" data-testid={`designer-prop-${view.field.key}`}>
              <label class="text-[11px] font-medium" for={`designer-prop-input-${view.field.key}`}>
                {view.field.label}
                <span class="text-muted-foreground font-normal">（{view.field.unit}）</span>
              </label>
              <input
                id={`designer-prop-input-${view.field.key}`}
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
        <div class="mt-3 border-t pt-2.5" data-testid="designer-prop-align">
          <p class="text-muted-foreground mb-1.5 text-[11px] font-medium">对齐（{selectedGems.length} 选）</p>
          <div class="grid grid-cols-3 gap-1">
            {#each ALIGN_COMMANDS as cmd (cmd.id)}
              <Button
                variant="outline"
                size="xs"
                class="h-6 px-1 text-[11px]"
                onclick={() => align(cmd.id)}
                data-testid={`designer-align-${cmd.id}`}
              >
                {cmd.label}
              </Button>
            {/each}
          </div>
          {#if selectedGems.length >= 3}
            <div class="mt-1 grid grid-cols-2 gap-1" data-testid="designer-prop-distribute">
              {#each DISTRIBUTION_COMMANDS as cmd (cmd.id)}
                <Button
                  variant="outline"
                  size="xs"
                  class="h-6 px-1 text-[11px]"
                  onclick={() => distribute(cmd.id)}
                  data-testid={`designer-distribute-${cmd.id}`}
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
