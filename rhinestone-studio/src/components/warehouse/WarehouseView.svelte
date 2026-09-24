<!--
WarehouseView.svelte——「仓储管理」工作台（add-stone-library S7.4，design §7.6
第三产品工作台——与 Agent 主面/设计师工作台并列）。
布局：左·主区=多标准纵向分组流（单一滚动容器：flatFlowLayout 段堆叠+每段虚拟
窗口+段头筛选）+拖拽 marquee 框选；右=集合侧栏（贴图墙/限定名/数量备注/汇总/
缺失警示/组合切换与保存）。Owner 定调五：可视化挑拣是人的强项——本台主体是人，
AI 辅助面在 MCP set.*（不在本 UI）。
S7.7 走查修复 2026-09-24：行槽高改用 WAREHOUSE_CELL_H（瓦片实际高，见 layout.ts）
——消除行间 ~90px 死空间；侧栏 w-96 shrink-0 固定不被挤压。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import StandardSection from './StandardSection.svelte'
  import SetSidebar from './SetSidebar.svelte'
  import PackagePlus from '@lucide/svelte/icons/package-plus'
  import PackageMinus from '@lucide/svelte/icons/package-minus'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import X from '@lucide/svelte/icons/x'
  import { flatFlowLayout, WAREHOUSE_CELL_H } from '$lib/warehouse/layout'
  import { marqueeHitIndices, marqueeRectFromPointer, type Point, type Rect } from '$lib/warehouse/marquee'
  import {
    STONE_CELL_MIN_W,
    STONE_GRID_GAP,
    STONE_GRID_OVERSCAN_ROWS,
    STONE_GRID_PAD,
  } from '$lib/stonesAdmin/virtual'
  import {
    addWarehouseSelection,
    clearWarehouseSelection,
    filterSectionCells,
    getSectionFamilyOptions,
    getWarehouseError,
    getWarehouseSections,
    getWarehouseSectionsState,
    getWarehouseSelection,
    initWarehouse,
    refreshSections,
    removeSelectedFromSet,
    addSelectedToSet,
    setSectionFilter,
    toggleSectionCollapsed,
    isWarehouseMember,
  } from '$lib/warehouse/store.svelte'

  onMount(() => {
    void initWarehouse()
  })

  const sectionsState = $derived(getWarehouseSectionsState())
  const sections = $derived(getWarehouseSections())
  const selectionCount = $derived(getWarehouseSelection().length)
  const memberSelectionCount = $derived(getWarehouseSelection().filter((id) => isWarehouseMember(id)).length)
  const error = $derived(getWarehouseError())

  /** 段过滤投影（cells+familyOptions——layout itemCount 与渲染共用同一过滤集）。 */
  const filteredSections = $derived(
    sections.map((section) => ({
      section,
      filteredCells: filterSectionCells(section.cells, section.filter),
    })),
  )

  // ---------------------------------------------------------------- 视口测量（虚拟窗口）

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

  const layout = $derived(
    flatFlowLayout({
      sections: filteredSections.map(({ section, filteredCells }) => ({
        key: section.supplier,
        itemCount: section.collapsed ? 0 : filteredCells.length,
      })),
      viewportW,
      viewportH,
      scrollTop,
      cellMinW: STONE_CELL_MIN_W,
      cellH: WAREHOUSE_CELL_H,
      gap: STONE_GRID_GAP,
      padding: STONE_GRID_PAD,
      overscanRows: STONE_GRID_OVERSCAN_ROWS,
    }),
  )

  // ---------------------------------------------------------------- marquee 框选

  let marqueeStart = $state<Point | null>(null)
  let marqueeCur = $state<Point | null>(null)

  function pointFromEvent(event: MouseEvent): Point {
    const rect = scrollEl?.getBoundingClientRect()
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0) + (scrollEl?.scrollTop ?? 0),
    }
  }

  function onPointerDown(event: MouseEvent): void {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target !== null && target.closest('button, input, select, textarea, a, label, [data-no-marquee]') !== null) return
    const point = pointFromEvent(event)
    marqueeStart = point
    marqueeCur = point
    // 指针捕获把 move/up 锁在滚动容器上（jsdom/老浏览器缺位时静默降级——事件冒泡兜底）。
    try {
      if (typeof (event as PointerEvent).pointerId === 'number') scrollEl?.setPointerCapture?.((event as PointerEvent).pointerId)
    } catch {
      /* 捕获失败不阻断框选 */
    }
  }

  function onPointerMove(event: MouseEvent): void {
    if (marqueeStart === null) return
    marqueeCur = pointFromEvent(event)
  }

  function onPointerUp(): void {
    if (marqueeStart === null) return
    if (marqueeHits.size > 0) addWarehouseSelection([...marqueeHits])
    marqueeStart = null
    marqueeCur = null
  }

  /** 拖拽矩形（内容坐标——随滚动内容平移；负向拖拽归一化）。 */
  const marqueeRect = $derived(
    marqueeStart !== null && marqueeCur !== null ? marqueeRectFromPointer(marqueeStart, marqueeCur) : null,
  )

  /** 实时命中集（矩形∩cell bbox——段内局部坐标换算后纯函数求交；高亮反馈）。 */
  const marqueeHits = $derived.by(() => {
    const hits = new Set<string>()
    if (marqueeRect === null) return hits
    for (let i = 0; i < layout.sections.length; i += 1) {
      const sectionLayout = layout.sections[i]!
      const sectionCells = filteredSections[i]?.filteredCells ?? []
      if (sectionCells.length === 0) continue
      const local: Rect = {
        x: marqueeRect.x,
        y: marqueeRect.y - sectionLayout.gridTop,
        w: marqueeRect.w,
        h: marqueeRect.h,
      }
      for (const index of marqueeHitIndices(local, sectionLayout.geometry, sectionCells.length, {
        cellH: WAREHOUSE_CELL_H,
        gap: STONE_GRID_GAP,
        padding: STONE_GRID_PAD,
      })) {
        hits.add(sectionCells[index]!.resourceId)
      }
    }
    return hits
  })
</script>

<div class="flex h-full min-h-0 min-w-0" data-testid="warehouse-view">
  <!-- 左·主区：标准平铺（纵向分组流+框选） -->
  <section class="flex min-w-0 flex-1 flex-col">
    <div class="bg-background/80 flex flex-wrap items-center gap-2 border-b px-3 py-2 backdrop-blur" data-testid="warehouse-toolbar">
      <Badge variant="secondary" data-testid="warehouse-selection-count">已选 {selectionCount}</Badge>
      <Button
        size="sm"
        class="h-8"
        disabled={selectionCount === 0}
        onclick={() => addSelectedToSet()}
        data-testid="warehouse-add-to-set"
        title="把所选钻加入当前集合（Owner：选择→添加到集合）"
      >
        <PackagePlus class="size-3.5" aria-hidden="true" />
        加入集合
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="h-8"
        disabled={memberSelectionCount === 0}
        onclick={() => removeSelectedFromSet()}
        data-testid="warehouse-remove-from-set"
        title="把所选成员移出当前集合（添加/删除到集合的双向动作）"
      >
        <PackageMinus class="size-3.5" aria-hidden="true" />
        移出所选{memberSelectionCount > 0 ? `（${memberSelectionCount}）` : ''}
      </Button>
      {#if selectionCount > 0}
        <Button variant="ghost" size="sm" class="h-8 px-2" onclick={() => clearWarehouseSelection()} data-testid="warehouse-clear-selection" title="清除选择">
          <X class="size-3.5" aria-hidden="true" />
        </Button>
      {/if}
      <span class="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" class="h-8" onclick={() => void refreshSections()} data-testid="warehouse-refresh" title="重载标准平铺">
          <RefreshCw class="size-3.5" aria-hidden="true" />
        </Button>
      </span>
    </div>

    {#if error !== null}
      <p class="border-destructive/30 bg-destructive/10 text-destructive px-3 py-1.5 text-xs" data-testid="warehouse-error">
        {error}
      </p>
    {/if}

    <main class="bg-muted/30 min-h-0 flex-1 overflow-hidden">
      {#if sectionsState === 'loading' || sectionsState === 'idle'}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="warehouse-loading">标准平铺加载中…</p>
      {:else if sections.length === 0}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="warehouse-empty">无标准可平铺（stones 树为空或 daemon 不可达）</p>
      {:else}
        <div
          bind:this={scrollEl}
          role="presentation"
          aria-label="标准平铺区（拖拽框选）"
          class="scrollbar-thin h-full overflow-y-auto overflow-x-hidden"
          data-testid="warehouse-flow-scroll"
          onscroll={() => (scrollTop = scrollEl?.scrollTop ?? 0)}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
        >
          <div class="relative" style="height: {layout.totalHeight}px" data-testid="warehouse-flow-canvas">
            {#each layout.sections as sectionLayout, index (sectionLayout.key)}
              {@const view = filteredSections[index]}
              {#if view !== undefined}
                <StandardSection
                  sectionLayout={sectionLayout}
                  supplier={view.section.supplier}
                  cells={view.section.collapsed ? [] : view.filteredCells}
                  filter={view.section.filter}
                  familyOptions={getSectionFamilyOptions(view.section.supplier)}
                  collapsed={view.section.collapsed}
                  marqueeHits={marqueeHits}
                  onfilter={(patch) => void setSectionFilter(view.section.supplier, patch)}
                  ontogglecollapsed={() => toggleSectionCollapsed(view.section.supplier)}
                />
              {/if}
            {/each}
            {#if marqueeRect !== null}
              <div
                class="border-primary/60 bg-primary/10 pointer-events-none absolute border border-dashed"
                style="left: {marqueeRect.x}px; top: {marqueeRect.y}px; width: {marqueeRect.w}px; height: {marqueeRect.h}px;"
                data-testid="warehouse-marquee"
              ></div>
            {/if}
          </div>
        </div>
      {/if}
    </main>

    <footer class="bg-background flex h-9 shrink-0 items-center gap-2 border-t px-3 text-xs" data-testid="warehouse-statusbar">
      <span class="text-muted-foreground" data-testid="warehouse-status-sections">{sections.length} 个标准在场</span>
      <span class="text-muted-foreground ml-auto font-mono" data-testid="warehouse-readscope">共享读 · shared-library</span>
    </footer>
  </section>

  <!-- 右：集合侧栏（当前集合贴图墙+限定名+编辑+汇总+组合操作） -->
  <aside class="bg-background hidden w-96 shrink-0 flex-col border-l md:flex">
    <SetSidebar />
  </aside>
</div>
