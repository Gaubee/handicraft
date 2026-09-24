<!--
StoneCardGrid.svelte——样卡式网格（add-stone-library S3.3；design §7.6 性能护栏：
大样卡平铺虚拟滚动——钰航 259+tuzuan 623 量级只渲染可视窗口+overscan）。
两形态：
  [平铺（缺省）] 单滚动容器虚拟化——固定单元几何（virtual.ts 常量），绝对定位
    窗口行；scroll/resize/ResizeObserver 三路重测。
  [groupBy 分组] 当前页 cells 按组键分段渲染（页有界 ≤pageSize，无需虚拟化；
    服务端 groupKeys 是全过滤集 facets，页内段是当前页投影——不冒充全集）。
-->

<script lang="ts">
  import type { StoneGridCell } from '@handicraft/contracts'
  import StoneCard from './StoneCard.svelte'
  import {
    STONE_CELL_H,
    STONE_CELL_MIN_W,
    STONE_GRID_GAP,
    STONE_GRID_OVERSCAN_ROWS,
    STONE_GRID_PAD,
    virtualGridGeometry,
  } from '$lib/stonesAdmin/virtual'

  let {
    cells,
    groupBy = undefined,
    onopen,
  }: {
    cells: StoneGridCell[]
    groupBy?: 'family' | 'sizeMm' | 'style'
    onopen: (cell: StoneGridCell) => void
  } = $props()

  let scrollEl = $state<HTMLDivElement | null>(null)
  let viewportW = $state(0)
  let viewportH = $state(0)
  let scrollTop = $state(0)

  function measure(): void {
    if (scrollEl === null) return
    viewportW = scrollEl.clientWidth
    viewportH = scrollEl.clientHeight
  }

  $effect(() => {
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null
    observer?.observe(scrollEl ?? document.body)
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  })

  const geometry = $derived(
    virtualGridGeometry({
      itemCount: cells.length,
      viewportW,
      viewportH,
      scrollTop,
      cellMinW: STONE_CELL_MIN_W,
      cellH: STONE_CELL_H,
      gap: STONE_GRID_GAP,
      padding: STONE_GRID_PAD,
      overscanRows: STONE_GRID_OVERSCAN_ROWS,
    }),
  )

  /** 窗口内条目（index → cell + 行列定位）。 */
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

  /** 组键（cell 携带字段派生——style 档以 styleName 呈现，与服务端 row-N 键不同源但同诚实）。 */
  function groupKeyOf(cell: StoneGridCell): string {
    if (groupBy === 'family') return cell.family
    if (groupBy === 'sizeMm') return cell.sizeMm !== null ? `${cell.sizeMm}mm` : '未声明'
    return cell.styleName !== '' ? cell.styleName : '未命名款式'
  }

  const groups = $derived.by(() => {
    if (groupBy === undefined) return []
    const order: string[] = []
    const byKey = new Map<string, StoneGridCell[]>()
    for (const cell of cells) {
      const key = groupKeyOf(cell)
      const bucket = byKey.get(key)
      if (bucket === undefined) {
        order.push(key)
        byKey.set(key, [cell])
      } else {
        bucket.push(cell)
      }
    }
    return order.map((key) => ({ key, cells: byKey.get(key) ?? [] }))
  })
</script>

{#if groupBy !== undefined}
  <div class="h-full overflow-y-auto p-4" data-testid="stones-grid-grouped">
    {#each groups as group (group.key)}
      <section class="mb-5" data-testid="stones-grid-group-{group.key}">
        <h3 class="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium tracking-wide">
          <span class="bg-primary/20 rounded px-1.5 py-0.5 font-mono">{group.key}</span>
          <span>{group.cells.length} 项</span>
        </h3>
        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax({STONE_CELL_MIN_W}px, 1fr))">
          {#each group.cells as cell (cell.resourceId)}
            <div style="height: {STONE_CELL_H}px">
              <StoneCard {cell} {onopen} />
            </div>
          {/each}
        </div>
      </section>
    {/each}
    {#if groups.length === 0}
      <p class="text-muted-foreground py-16 text-center text-sm">当前过滤集无匹配钻</p>
    {/if}
  </div>
{:else}
  <div
    bind:this={scrollEl}
    class="scrollbar-thin h-full overflow-y-auto overflow-x-hidden"
    data-testid="stones-grid-scroll"
    onscroll={() => (scrollTop = scrollEl?.scrollTop ?? 0)}
  >
    <div class="relative" style="height: {geometry.totalHeight}px" data-testid="stones-grid-canvas">
      {#each windowItems as item (item.index)}
        <div
          class="absolute"
          style="
            left: {STONE_GRID_PAD + item.col * (geometry.columnWidth + STONE_GRID_GAP)}px;
            top: {geometry.padTop + (item.row - geometry.startRow) * (STONE_CELL_H + STONE_GRID_GAP)}px;
            width: {geometry.columnWidth}px;
            height: {STONE_CELL_H}px;"
        >
          <StoneCard cell={item.cell} {onopen} />
        </div>
      {/each}
      {#if cells.length === 0}
        <p class="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm" data-testid="stones-grid-empty">
          当前过滤集无匹配钻
        </p>
      {/if}
    </div>
  </div>
{/if}
