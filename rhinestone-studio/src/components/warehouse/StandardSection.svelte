<!--
StandardSection.svelte——仓储管理工作台·标准平铺区单段（add-stone-library S7.4，
design §7.6 纵向分组流：每标准一段=段头+完整样卡网格）。段内独立筛选（色系/尺寸/
搜索）；网格窗口/定位几何全部来自父层 flatFlowLayout 产物（单一滚动内容坐标）；
平铺单元=StoneCellTile（S5 组件复用——selected 态/贴图/尺寸徽标直接迁移）。
选中=staged 选择集高亮；在集合=成员徽标（侧栏与平铺区增删同步的可视面）。
-->

<script lang="ts">
  import { withAuthToken } from '../../lib/stonesAdmin/authUrl'
  import type { StoneGridCell } from '@handicraft/contracts'
  import StoneCellTile from '../stone-picker/StoneCellTile.svelte'
  import { Input } from '$lib/components/ui/input'
  import * as Select from '$lib/components/ui/select'
  import { ChevronDown, ChevronRight, Search, X } from '@lucide/svelte'
  import {
    isWarehouseMember,
    isWarehouseSelected,
    toggleWarehouseCell,
    type WarehouseSectionFilter,
  } from '$lib/warehouse/store.svelte'
  import type { FlowSectionLayout } from '$lib/warehouse/layout'
  import { STONE_CELL_H, STONE_GRID_GAP, STONE_GRID_PAD } from '$lib/stonesAdmin/virtual'

  let {
    sectionLayout,
    supplier,
    cells,
    filter,
    familyOptions,
    collapsed,
    marqueeHits,
    onfilter,
    ontogglecollapsed,
  }: {
    sectionLayout: FlowSectionLayout
    supplier: string
    cells: StoneGridCell[]
    filter: WarehouseSectionFilter
    familyOptions: string[]
    collapsed: boolean
    /** 拖拽框选实时命中集（高亮反馈——commit 时并入选择集）。 */
    marqueeHits: ReadonlySet<string>
    onfilter: (patch: Partial<WarehouseSectionFilter>) => void
    ontogglecollapsed: () => void
  } = $props()

  const geometry = $derived(sectionLayout.geometry)

  /** 窗口内条目（行主序展开；折叠/离屏段=空窗口零渲染）。 */
  const windowItems = $derived.by(() => {
    const items: Array<{ index: number; cell: StoneGridCell; row: number; col: number }> = []
    for (let row = geometry.startRow; row < geometry.endRowExclusive; row += 1) {
      for (let col = 0; col < geometry.columns; col += 1) {
        const index = row * geometry.columns + col
        const cell = cells[index]
        if (cell === undefined) break
        items.push({ index, cell, row, col })
      }
    }
    return items
  })

  let qInput = $state('')
  $effect(() => {
    qInput = filter.q ?? ''
  })

  function applyQ(): void {
    const trimmed = qInput.trim()
    onfilter({ q: trimmed === '' ? undefined : trimmed })
  }
</script>

<section
  class="absolute right-0 left-0"
  style="top: {sectionLayout.sectionTop}px;"
  data-testid="warehouse-section-{supplier}"
  data-collapsed={collapsed}
>
  <!-- 段头：标准 ID+计数+段内筛选（可折叠——折叠段网格高 0） -->
  <header
    class="bg-background/95 sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b px-4 py-2 backdrop-blur"
    style="height: {sectionLayout.height - sectionLayout.gridHeight}px;"
    data-testid="warehouse-section-header-{supplier}"
  >
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground rounded p-0.5"
      onclick={ontogglecollapsed}
      data-testid="warehouse-section-collapse-{supplier}"
      aria-label={collapsed ? `展开标准 ${supplier}` : `折叠标准 ${supplier}`}
      aria-expanded={!collapsed}
    >
      {#if collapsed}
        <ChevronRight class="size-4" />
      {:else}
        <ChevronDown class="size-4" />
      {/if}
    </button>
    <h3 class="text-sm font-semibold tracking-tight">
      <span class="bg-primary/15 text-primary rounded px-1.5 py-0.5 font-mono text-xs">{supplier}</span>
      <span class="text-muted-foreground ml-1.5 text-xs font-normal">{cells.length} 项</span>
    </h3>
    {#if !collapsed}
      <span class="ml-auto flex flex-wrap items-center gap-1.5">
        <Select.Root
          type="single"
          value={filter.family ?? ''}
          onValueChange={(value) => onfilter({ family: value === '' ? undefined : value })}
        >
          <Select.Trigger class="h-7 w-24 text-xs" data-testid="warehouse-section-family-{supplier}" aria-label="段内色系筛选">
            {filter.family ?? '全部色系'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="">全部色系</Select.Item>
            {#each familyOptions as family (family)}
              <Select.Item value={family}>{family}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>

        <label class="relative">
          <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2" aria-hidden="true" />
          <Input
            class="h-7 w-28 pl-6 text-xs"
            placeholder="搜 SKU / 色名"
            data-testid="warehouse-section-q-{supplier}"
            bind:value={qInput}
            onkeydown={(event) => {
              if (event.key === 'Enter') applyQ()
            }}
            onblur={() => {
              if ((filter.q ?? '') !== qInput.trim()) applyQ()
            }}
          />
        </label>
        {#if filter.q !== undefined || filter.family !== undefined}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground rounded p-0.5"
            title="清除段内筛选"
            data-testid="warehouse-section-clear-{supplier}"
            onclick={() => onfilter({ family: undefined, q: undefined })}
          >
            <X class="size-3.5" />
          </button>
        {/if}
      </span>
    {/if}
  </header>

  {#if !collapsed}
    <!-- 段网格画布：窗口行绝对定位（padTop 基准） -->
    <div class="relative" style="height: {sectionLayout.gridHeight}px;" data-testid="warehouse-section-grid-{supplier}">
      {#each windowItems as item (item.index)}
        <div
          class="absolute"
          style="
            left: {STONE_GRID_PAD + item.col * (geometry.columnWidth + STONE_GRID_GAP)}px;
            top: {geometry.padTop + (item.row - geometry.startRow) * (STONE_CELL_H + STONE_GRID_GAP)}px;
            width: {geometry.columnWidth}px;
            height: {STONE_CELL_H}px;"
        >
          <div
            class="flex h-full w-full items-start justify-center rounded-lg {isWarehouseMember(item.cell.resourceId)
              ? 'ring-primary/50 ring-2'
              : ''}"
          >
            <div class="relative">
              <StoneCellTile
                cell={item.cell}
                textureSrc={withAuthToken(item.cell.textureUrl)}
                selected={isWarehouseSelected(item.cell.resourceId) || marqueeHits.has(item.cell.resourceId)}
                onPick={(cell) => toggleWarehouseCell(cell.resourceId)}
              />
              {#if isWarehouseMember(item.cell.resourceId)}
                <span
                  class="bg-primary text-primary-foreground absolute -top-1 -left-1 rounded-full px-1 text-[9px] leading-4"
                  data-testid="warehouse-inset-badge-{item.cell.resourceId}"
                >
                  集合
                </span>
              {/if}
            </div>
          </div>
        </div>
      {/each}
      {#if cells.length === 0}
        <p class="text-muted-foreground absolute inset-0 flex items-center justify-center text-xs" data-testid="warehouse-section-empty-{supplier}">
          段内筛选无匹配钻
        </p>
      {/if}
    </div>
  {/if}
</section>
