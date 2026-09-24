<!--
Orthogonal intents (max 3):
1. [2026-09-24 S5.1 排板] 按色（family→款式行→尺寸变体三级懒展开）/按尺寸（sizeMm 档→
   同径色阵）双形态 + 搜索（SKU/色名/十六进制，q 去抖入 stones.list）。
2. [2026-09-24 S5.2 推荐] ΔE 邻近推荐面板：目标色（hex 输入/钻面取色）→ nearColor 协议位
   （客户端排序回退——P3.2 接线服务端排序，标注见 source.ts）；四态缺失与空/载/错状态。
3. [2026-09-24 S7.5 组合投影] activeSetId=组合成员解析投影（徽标=真实组合名+锁定
   提示条——design §7.5 设计中途切换须显式确认，确认回调位在 store）；选中=StonePick
   契约（onPick 回调+底部选中摘要）。
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Search from '@lucide/svelte/icons/search'
  import X from '@lucide/svelte/icons/x'
  import type { StoneGridCell, StonePick } from '@handicraft/contracts'
  import { deltaEOfCell, type StoneRefState } from '$lib/stonePicker/source.js'
  import { StonePickerStore } from '$lib/stonePicker/store.svelte.js'
  import StoneCellTile from './StoneCellTile.svelte'

  let {
    store,
    onPick = undefined,
    title = '装饰钻',
  }: {
    /** 选择器状态真源（消费方实例化并持有——P3.2 策略层参数面板注入）。 */
    store: StonePickerStore
    /** 选中产出回调（StonePick 契约——结构化引用，不内嵌贴图数据）。 */
    onPick?: (pick: StonePick, cell: StoneGridCell) => void
    title?: string
  } = $props()

  /** 展开款式行集合（键=StyleRowNode.key；首展开触发懒加载子查询）。 */
  let expandedStyles = $state<Set<string>>(new Set())

  const layout = $derived(store.layout)
  const boardPhase = $derived(store.boardPhase)
  const isEmpty = $derived(
    boardPhase === 'ready' &&
      (layout === 'color' ? store.families.length === 0 : store.sizeTiers.length === 0),
  )

  onMount(() => {
    void store.refresh()
    return () => store.dispose()
  })

  function textureSrc(cell: StoneGridCell): string {
    return store.source.resolveTextureUrl(cell.textureUrl)
  }

  function handlePick(cell: StoneGridCell): void {
    store.selectCell(cell)
    const pick = store.selectedPick
    if (pick !== null) onPick?.(pick, cell)
  }

  async function handleUseColor(cell: StoneGridCell): Promise<void> {
    await store.setNearColorFromCell(cell)
  }

  function toggleStyle(key: string): void {
    const row = store.styleRows.find((r) => r.key === key)
    if (row === undefined) return
    const next = new Set(expandedStyles)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
      void store.expandStyleRow(row)
    }
    expandedStyles = next
  }

  function isExpanded(key: string): boolean {
    return expandedStyles.has(key)
  }

  async function applyNearColorInput(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    await store.setNearColorFromHex(store.nearColorInput)
  }
</script>

<section
  data-testid="stone-picker"
  class="bg-background text-foreground flex min-h-0 flex-col overflow-hidden rounded-xl border"
  aria-label={title}
>
  <!-- ---------------------------------------------------------------- 头部：形态切换+搜索+组合投影（S7.5） -->
  <header class="flex flex-col gap-2 border-b p-3">
    <div class="flex items-center gap-2">
      <h3 class="text-sm font-semibold">{title}</h3>
      {#if store.activeSetId !== null}
        <Badge
          variant="secondary"
          data-testid="stone-activeset"
          title="组合投影（design §7.5）——数据源限定为该组合成员解析投影；设计中途切换组合须显式确认"
        >
          组合投影 · {store.activeSetName ?? store.activeSetId}
        </Badge>
      {/if}
      <div class="ml-auto inline-flex overflow-hidden rounded-md border" role="tablist" aria-label="排板形态">
        <button
          type="button"
          role="tab"
          aria-selected={layout === 'color'}
          data-testid="stone-layout-color"
          class="px-2.5 py-1 text-xs font-medium transition-colors {layout === 'color'
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-muted'}"
          onclick={() => store.setLayout('color')}
        >
          按色
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={layout === 'size'}
          data-testid="stone-layout-size"
          class="border-l px-2.5 py-1 text-xs font-medium transition-colors {layout === 'size'
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-muted'}"
          onclick={() => store.setLayout('size')}
        >
          按尺寸
        </button>
      </div>
    </div>
    <div class="relative">
      <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        data-testid="stone-search-input"
        class="pl-8"
        placeholder="搜索 SKU / 色名 / 十六进制（#FFFFF0）"
        value={store.q}
        oninput={(event) => store.setQ(event.currentTarget.value)}
      />
    </div>
    {#if store.activeSetId !== null}
      <!-- 锁定提示条（design §7.5 最小实现）：配色纪律——设计中途切换组合须显式确认（确认回调位在 store.confirmSetSwitch） -->
      <p class="text-muted-foreground text-[10px] leading-tight" data-testid="stone-activeset-lock-hint">
        已锁定组合（配色纪律）——面板限定组合成员投影；设计中途切换须经确认。
      </p>
    {/if}
  </header>

  <!-- ---------------------------------------------------------------- 排板主区 -->
  <div class="min-h-0 flex-1 overflow-y-auto p-3">
    {#if boardPhase === 'loading'}
      <p data-testid="stone-loading" class="text-muted-foreground py-8 text-center text-xs" role="status">
        加载中…
      </p>
    {:else if boardPhase === 'error'}
      <div data-testid="stone-error" class="flex flex-col items-center gap-2 py-8" role="alert">
        <p class="text-destructive text-xs">{store.boardError}</p>
        <Button variant="outline" size="sm" data-testid="stone-retry" onclick={() => store.refresh()}>
          <RefreshCw class="size-3.5" /> 重试
        </Button>
      </div>
    {:else if isEmpty}
      <p data-testid="stone-empty" class="text-muted-foreground py-8 text-center text-xs">
        {store.q.trim() !== '' ? '无匹配结果——换个关键字试试' : '钻库为空——先在装饰钻库管理视图导入样卡'}
      </p>
    {:else if layout === 'color'}
      <!-- 色系 chip 轨（一级） -->
      <div class="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="色系">
        {#each store.families as family (family)}
          <button
            type="button"
            role="tab"
            aria-selected={store.selectedFamily === family}
            data-testid="stone-family-{family}"
            class="rounded-full border px-2.5 py-0.5 text-xs transition-colors {store.selectedFamily === family
              ? 'border-primary bg-primary text-primary-foreground'
              : 'hover:bg-muted'}"
            onclick={() => store.selectFamily(family)}
          >
            {family}
          </button>
        {/each}
      </div>
      <!-- 款式行折叠列表（二级）→ 尺寸变体行内（三级，懒展开子查询） -->
      <div class="flex flex-col gap-1.5">
        {#each store.styleRows as row (row.key)}
          <div class="rounded-lg border">
            <button
              type="button"
              data-testid="stone-style-{row.key}"
              class="hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-medium"
              aria-expanded={isExpanded(row.key)}
              onclick={() => toggleStyle(row.key)}
            >
              {#if isExpanded(row.key)}
                <ChevronDown class="text-muted-foreground size-3.5" />
              {:else}
                <ChevronRight class="text-muted-foreground size-3.5" />
              {/if}
              <span>{row.key.startsWith('row-') ? `款式行 ${row.key.slice(4)}` : row.key}</span>
              {#if row.phase === 'loading'}
                <span class="text-muted-foreground ml-auto text-[10px]">加载中…</span>
              {:else if row.phase === 'error'}
                <span class="text-destructive ml-auto text-[10px]">加载失败</span>
              {/if}
            </button>
            {#if isExpanded(row.key)}
              <div class="flex flex-wrap gap-2 p-2 pt-0">
                {#if row.cells.length === 0 && row.phase === 'ready'}
                  <p class="text-muted-foreground text-[10px]">该款式行暂无尺寸变体</p>
                {/if}
                {#each row.cells as cell (cell.resourceId)}
                  <StoneCellTile
                    cell={cell}
                    textureSrc={textureSrc(cell)}
                    selected={store.selectedCell?.resourceId === cell.resourceId}
                    refState={store.selectedCell?.resourceId === cell.resourceId ? store.selectedRefState : null}
                    onPick={handlePick}
                    onUseColor={handleUseColor}
                  />
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if layout === 'size'}
      <!-- 尺寸档 chip 轨（一级）→ 同径色阵（二级） -->
      <div class="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="尺寸档">
        {#each store.sizeTiers as tier (tier)}
          <button
            type="button"
            role="tab"
            aria-selected={store.selectedTier === tier}
            data-testid="stone-tier-{tier}"
            class="rounded-full border px-2.5 py-0.5 text-xs transition-colors {store.selectedTier === tier
              ? 'border-primary bg-primary text-primary-foreground'
              : 'hover:bg-muted'}"
            onclick={() => store.selectTier(tier)}
          >
            {tier === '未声明' ? '未声明' : `${tier}mm`}
          </button>
        {/each}
      </div>
      <div class="flex flex-wrap gap-2">
        {#each store.tierCells as cell (cell.resourceId)}
          <StoneCellTile
            cell={cell}
            textureSrc={textureSrc(cell)}
            selected={store.selectedCell?.resourceId === cell.resourceId}
            refState={store.selectedCell?.resourceId === cell.resourceId ? store.selectedRefState : null}
            onPick={handlePick}
            onUseColor={handleUseColor}
          />
        {/each}
      </div>
    {/if}
  </div>

  <!-- ---------------------------------------------------------------- ΔE 邻近推荐（S5.2） -->
  {#if store.nearColor !== null}
    <section
      data-testid="stone-recommend"
      class="border-t p-3"
      aria-label="ΔE 邻近推荐"
    >
      <div class="mb-2 flex items-center gap-2">
        <span class="size-3.5 rounded-sm border" style="background-color: {store.nearColorInput}" aria-hidden="true"></span>
        <span class="text-xs font-medium">ΔE 邻近推荐</span>
        <Badge variant="outline" class="text-[10px]" title="RPC 面 stones.list 暂无 nearColor——现为客户端 ΔE(CIE76) 排序回退（当前页内）；P3.2 接线服务端排序（语义沿 MCP capability stones.list/search），完整 substitutes 容差查询同批接线">
          客户端排序 · P3.2 服务端接线
        </Badge>
        <button
          type="button"
          data-testid="stone-recommend-clear"
          class="text-muted-foreground hover:text-foreground ml-auto"
          aria-label="清除目标色"
          onclick={() => store.clearNearColor()}
        >
          <X class="size-3.5" />
        </button>
      </div>
      {#if store.recommendPhase === 'loading'}
        <p data-testid="stone-recommend-loading" class="text-muted-foreground text-[10px]" role="status">推荐计算中…</p>
      {:else if store.recommendPhase === 'error'}
        <p data-testid="stone-recommend-error" class="text-destructive text-[10px]" role="alert">{store.recommendError}</p>
      {:else if store.recommendedCells.length === 0}
        <p data-testid="stone-recommend-empty" class="text-muted-foreground text-[10px]">无候选（当前过滤集为空）</p>
      {:else}
        <div class="flex flex-wrap gap-2">
          {#each store.recommendedCells as cell (cell.resourceId)}
            {@const deltaE = store.nearColor !== null ? deltaEOfCell(store.nearColor, cell) : null}
            <StoneCellTile
              cell={cell}
              textureSrc={textureSrc(cell)}
              selected={store.selectedCell?.resourceId === cell.resourceId}
              deltaE={deltaE}
              refState={store.selectedCell?.resourceId === cell.resourceId ? store.selectedRefState : null}
              onPick={handlePick}
              onUseColor={handleUseColor}
            />
          {/each}
        </div>
      {/if}
    </section>
  {:else}
    <form
      data-testid="stone-recommend-form"
      class="border-t p-3"
      onsubmit={applyNearColorInput}
    >
      <label class="text-muted-foreground mb-1 block text-[10px]" for="stone-recommend-input">ΔE 邻近推荐：输入目标色十六进制</label>
      <div class="flex gap-1.5">
        <Input
          id="stone-recommend-input"
          name="near-color-hex"
          data-testid="stone-recommend-input"
          placeholder="#AABBCC"
          bind:value={store.nearColorInput}
          aria-invalid={store.nearColorError !== ''}
        />
        <Button type="submit" size="sm" data-testid="stone-recommend-apply">找近似</Button>
      </div>
      {#if store.nearColorError !== ''}
        <p data-testid="stone-recommend-invalid" class="text-destructive mt-1 text-[10px]" role="alert">{store.nearColorError}</p>
      {/if}
    </form>
  {/if}

  <!-- ---------------------------------------------------------------- 选中摘要（StonePick 契约投影） -->
  {#if store.selectedPick !== null}
    <footer
      data-testid="stone-selected-summary"
      class="flex items-center gap-2 border-t bg-muted/30 px-3 py-2 text-xs"
    >
      <span class="size-3.5 rounded-sm border" style="background-color: {store.selectedPick.colorHex}" aria-hidden="true"></span>
      <span class="font-medium">{store.selectedPick.supplier}/{store.selectedPick.sku}</span>
      <span class="text-muted-foreground">
        {store.selectedPick.sizeMm !== null ? `${store.selectedPick.sizeMm}mm` : '尺寸未声明'}
        · {store.selectedPick.colorHex}
        {#if store.selectedPick.gemshapeRef !== undefined}
          · shape {store.selectedPick.gemshapeRef}
        {/if}
      </span>
      <button
        type="button"
        data-testid="stone-selected-clear"
        class="text-muted-foreground hover:text-foreground ml-auto"
        aria-label="取消选中"
        onclick={() => store.clearSelection()}
      >
        <X class="size-3.5" />
      </button>
    </footer>
  {/if}
</section>
