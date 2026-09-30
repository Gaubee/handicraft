<!--
  SetStoneSearchPicker.svelte——钻库搜索多选共用件（product-polish-w1 T4 自
  restructure-materials-story W2a CreateSetDialog 抽出：CreateSetDialog 与
  SetDetailSheet 编辑态同一「搜索钻库成员」形态——992 款库严禁全量拉）。
  形态：搜索 Input（防抖 300ms——非空 q 才查、页 20 服务端查询）→结果列表多选
  （贴图缩略+SKU+供应商+尺寸+已选态）。选中状态归调用方（pickedResourceIds
  只读投影+ontoggle 回调——本组件无自有业务态，纯受控）。
-->

<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { createDebounce } from '$lib/studio/debounce'
  import { withAuthToken } from '$lib/stonesAdmin/authUrl'
  import { searchStonesForSetPicker, SET_PICKER_PAGE_SIZE } from '$lib/stonesAdmin/store.svelte'
  import type { StoneGridCell } from '@handicraft/contracts'
  import Search from '@lucide/svelte/icons/search'

  let {
    pickedResourceIds,
    ontoggle,
    testidPrefix = 'create-set',
  }: {
    /** 已选成员 resourceId 集（只读投影——选中态呈现与切换方向由调用方真源决定）。 */
    pickedResourceIds: string[]
    /** 点选结果行（toggle 语义：在选=移除/未选=追加——方向由调用方按真源判定）。 */
    ontoggle: (cell: StoneGridCell) => void
    /** testid 前缀（CreateSetDialog 沿用 create-set-* 既有锚；编辑面用 set-edit-*）。 */
    testidPrefix?: string
  } = $props()

  let searchInput = $state('')
  let results = $state<StoneGridCell[]>([])
  let searching = $state(false)
  let searchError = $state<string | null>(null)

  async function runSearch(q: string): Promise<void> {
    const trimmed = q.trim()
    if (trimmed === '') {
      results = []
      searching = false
      searchError = null
      return
    }
    searching = true
    searchError = null
    try {
      results = await searchStonesForSetPicker(trimmed)
    } catch (error) {
      searchError = error instanceof Error ? error.message : String(error)
      results = []
    } finally {
      searching = false
    }
  }

  const debouncedSearch = createDebounce((q: string) => void runSearch(q), 300)

  // 卸载即取消（防抖定时器随销毁丢弃迟到查询）。
  $effect(() => () => debouncedSearch.cancel())

  function isPicked(resourceId: string): boolean {
    return pickedResourceIds.includes(resourceId)
  }
</script>

<div class="space-y-2" data-testid="{testidPrefix}-search-picker">
  <label class="relative block text-xs">
    <span class="text-muted-foreground">搜索钻库成员（SKU / 色名 / 供应商——服务端查询，非全量拉取）</span>
    <Search class="text-muted-foreground pointer-events-none absolute bottom-2.5 left-2 size-3.5" aria-hidden="true" />
    <Input
      class="mt-1 pl-7"
      placeholder="输入关键字搜索（空=不查询）"
      data-testid="{testidPrefix}-search"
      bind:value={searchInput}
      oninput={(event) => debouncedSearch(event.currentTarget.value)}
    />
  </label>

  {#if searchError !== null}
    <p class="border-destructive/30 bg-destructive/10 text-destructive rounded-md p-2 text-xs" data-testid="{testidPrefix}-search-error">{searchError}</p>
  {/if}

  <div class="scrollbar-thin max-h-56 overflow-y-auto rounded-lg border border-border/70" data-testid="{testidPrefix}-results">
    {#if searching}
      <p class="text-muted-foreground px-3 py-4 text-center text-xs" data-testid="{testidPrefix}-searching">搜索中…</p>
    {:else if results.length === 0}
      <p class="text-muted-foreground px-3 py-4 text-center text-xs" data-testid="{testidPrefix}-results-empty">
        {searchInput.trim() === '' ? '输入关键字搜索钻库（每页最多 ' + SET_PICKER_PAGE_SIZE + ' 款）' : '无匹配钻'}
      </p>
    {:else}
      {#each results as cell (cell.resourceId)}
        <button
          type="button"
          onclick={() => ontoggle(cell)}
          data-testid="{testidPrefix}-result-{cell.resourceId}"
          aria-pressed={isPicked(cell.resourceId)}
          class="hover:bg-accent/60 flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors {isPicked(cell.resourceId) ? 'bg-accent/80' : ''}"
          title="{cell.name}（{cell.sku}）"
        >
          <span class="bg-zinc-300 dark:bg-zinc-700 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md">
            <img src={withAuthToken(cell.textureUrl)} alt="{cell.name} 贴图" loading="lazy" decoding="async" class="h-[80%] w-[80%] object-contain" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="size-2 shrink-0 rounded-full border border-black/10" style="background: {cell.colorHex}" aria-hidden="true"></span>
              <span class="text-foreground font-mono font-semibold">{cell.sku}</span>
              <span class="text-muted-foreground truncate">{cell.supplier}</span>
            </span>
            <span class="text-muted-foreground mt-0.5 block truncate">{cell.name}</span>
          </span>
          <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{cell.sizeMm !== null ? `${cell.sizeMm}mm` : '尺寸未声明'}</span>
          <span class="shrink-0" aria-hidden="true">{isPicked(cell.resourceId) ? '✓' : '+'}</span>
        </button>
      {/each}
    {/if}
  </div>
</div>
