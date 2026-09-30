<!--
CreateSetDialog.svelte——创建/添加组合对话框（restructure-materials-story W2a，
design §2.1——公共组件两处复用：材料市场左栏「添加组合」（ownerScope='market'，
owner=管理员=当前认证用户）/我的材料「创建组合」（ownerScope='personal'，owner=
当前账户）。接口契约冻结（W2b 并行方按此消费）：
  props: { open, onclose, ownerScope: 'market' | 'personal', oncreated(set: {resourceId, name}) }
owner 语义：daemon sets.create 的 ownerId=服务端注入当前认证用户（rpc.ts
setsCreate——客户端不传 owner），ownerScope 只决定挂载域文案，不在 Dialog 内猜写。
形态三段：名称 Input；钻挑选器（搜索 Input 防抖 300ms→服务端 stones 查询
（searchStonesForSetPicker——非空 q 才查、页 20，992 款库严禁全量拉）+结果列表
多选：贴图缩略+SKU+供应商+尺寸）；已选区（数量 Input 默认 0=「按设计用量另计」
——§7.1 quantity 缺省语义）。提交调 sets.create（成员=ProductionSetMember：
stoneRef+可选 quantity）；成功→oncreated+onclose；失败→错误条（对话框保留）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { createDebounce } from '$lib/studio/debounce'
  import { withAuthToken } from '$lib/stonesAdmin/authUrl'
  import { createStoneSet, searchStonesForSetPicker, SET_PICKER_PAGE_SIZE } from '$lib/stonesAdmin/store.svelte'
  import type { StoneGridCell } from '@handicraft/contracts'
  import Plus from '@lucide/svelte/icons/plus'
  import Search from '@lucide/svelte/icons/search'
  import X from '@lucide/svelte/icons/x'

  let {
    open,
    onclose,
    ownerScope,
    oncreated,
  }: {
    open: boolean
    onclose: () => void
    ownerScope: 'market' | 'personal'
    oncreated: (set: { resourceId: string; name: string }) => void
  } = $props()

  const SCOPE_COPY: Record<typeof ownerScope, { title: string; description: string; submit: string }> = {
    market: {
      title: '添加组合（材料市场）',
      description: '管理员维护的全账号共享组合——从钻库搜索挑拣成员，保存后进入材料市场左栏「组合」分区。',
      submit: '添加组合',
    },
    personal: {
      title: '创建组合（我的材料）',
      description: '跟账户走的私有组合——从钻库搜索挑拣成员，保存后进入「我的材料 · 我的贴砖组合」。',
      submit: '创建组合',
    },
  }

  let name = $state('')
  let searchInput = $state('')
  let results = $state<StoneGridCell[]>([])
  let searching = $state(false)
  let searchError = $state<string | null>(null)
  /** 已选成员（插入序——stoneRef → cell+数量草稿；数量 0=按设计用量另计）。 */
  let picked = $state<Array<{ cell: StoneGridCell; quantity: number }>>([])
  let submitting = $state(false)
  let submitError = $state<string | null>(null)

  function resetDraft(): void {
    name = ''
    searchInput = ''
    results = []
    searching = false
    searchError = null
    picked = []
    submitting = false
    submitError = null
  }

  // 打开即重置草稿（上次会话残留清零）；防抖定时器随取消丢弃迟到查询。
  $effect(() => {
    if (open) resetDraft()
  })

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
      const cells = await searchStonesForSetPicker(trimmed)
      results = cells
    } catch (error) {
      searchError = error instanceof Error ? error.message : String(error)
      results = []
    } finally {
      searching = false
    }
  }

  const debouncedSearch = createDebounce((q: string) => void runSearch(q), 300)

  $effect(() => () => debouncedSearch.cancel())

  function isPicked(resourceId: string): boolean {
    return picked.some((entry) => entry.cell.resourceId === resourceId)
  }

  function togglePick(cell: StoneGridCell): void {
    if (isPicked(cell.resourceId)) {
      picked = picked.filter((entry) => entry.cell.resourceId !== cell.resourceId)
    } else {
      picked = [...picked, { cell, quantity: 0 }]
    }
  }

  function setQuantity(resourceId: string, raw: string): void {
    const parsed = Number.parseFloat(raw)
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
    picked = picked.map((entry) => (entry.cell.resourceId === resourceId ? { ...entry, quantity: value } : entry))
  }

  function removePicked(resourceId: string): void {
    picked = picked.filter((entry) => entry.cell.resourceId !== resourceId)
  }

  async function submit(): Promise<void> {
    const trimmedName = name.trim()
    submitError = null
    if (trimmedName === '') {
      submitError = '组合名不能为空'
      return
    }
    if (picked.length === 0) {
      submitError = '组合至少一个成员（空组合无生产语义——§7.1）'
      return
    }
    submitting = true
    try {
      const created = await createStoneSet({
        name: trimmedName,
        members: picked.map((entry) => ({
          stoneRef: entry.cell.resourceId,
          ...(entry.quantity > 0 ? { quantity: entry.quantity } : {}),
        })),
        origin: { kind: 'manual-pick' },
      })
      oncreated({ resourceId: created.resourceId, name: trimmedName })
      onclose()
    } catch (error) {
      submitError = error instanceof Error ? error.message : String(error)
    } finally {
      submitting = false
    }
  }
</script>

<Dialog.Root {open} onOpenChange={(next) => { if (!next) onclose() }}>
  <Dialog.Content class="flex max-h-[85vh] w-full max-w-xl flex-col gap-0 p-0" data-testid="create-set-dialog" data-ownerscope={ownerScope}>
    <Dialog.Header class="flex-row items-center gap-2 border-b px-4 py-3">
      <Dialog.Title class="text-sm font-semibold">{SCOPE_COPY[ownerScope].title}</Dialog.Title>
      <Button variant="outline" size="sm" class="ml-auto" onclick={onclose} data-testid="create-set-close">关闭</Button>
    </Dialog.Header>
    <Dialog.Description class="sr-only">{SCOPE_COPY[ownerScope].description}</Dialog.Description>

    <div class="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <!-- 段一：名称 -->
      <label class="block text-xs">
        <span class="text-muted-foreground">组合名（如「圣诞雪人款」）</span>
        <Input class="mt-1" placeholder="组合名" data-testid="create-set-name" bind:value={name} />
      </label>

      <!-- 段二：钻挑选器（服务端搜索——防抖 300ms，非空 q 才查） -->
      <div class="space-y-2">
        <label class="relative block text-xs">
          <span class="text-muted-foreground">搜索钻库成员（SKU / 色名 / 供应商——服务端查询，非全量拉取）</span>
          <Search class="text-muted-foreground pointer-events-none absolute bottom-2.5 left-2 size-3.5" aria-hidden="true" />
          <Input
            class="mt-1 pl-7"
            placeholder="输入关键字搜索（空=不查询）"
            data-testid="create-set-search"
            bind:value={searchInput}
            oninput={(event) => debouncedSearch(event.currentTarget.value)}
          />
        </label>

        {#if searchError !== null}
          <p class="border-destructive/30 bg-destructive/10 text-destructive rounded-md p-2 text-xs" data-testid="create-set-search-error">{searchError}</p>
        {/if}

        <div class="scrollbar-thin max-h-56 overflow-y-auto rounded-lg border border-border/70" data-testid="create-set-results">
          {#if searching}
            <p class="text-muted-foreground px-3 py-4 text-center text-xs" data-testid="create-set-searching">搜索中…</p>
          {:else if results.length === 0}
            <p class="text-muted-foreground px-3 py-4 text-center text-xs" data-testid="create-set-results-empty">
              {searchInput.trim() === '' ? '输入关键字搜索钻库（每页最多 ' + SET_PICKER_PAGE_SIZE + ' 款）' : '无匹配钻'}
            </p>
          {:else}
            {#each results as cell (cell.resourceId)}
              <button
                type="button"
                onclick={() => togglePick(cell)}
                data-testid="create-set-result-{cell.resourceId}"
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

      <!-- 段三：已选成员（数量默认 0=按设计用量另计） -->
      <div class="space-y-2">
        <p class="text-muted-foreground text-xs">已选成员（{picked.length}）——数量 0 = 按设计用量另计（§7.1 备料参考，非库存承诺）</p>
        {#if picked.length === 0}
          <p class="text-muted-foreground rounded-lg border border-dashed border-border/70 px-3 py-3 text-center text-xs" data-testid="create-set-picked-empty">尚未选择成员——从上方搜索结果点选</p>
        {:else}
          <ul class="space-y-1.5" data-testid="create-set-picked">
            {#each picked as entry (entry.cell.resourceId)}
              <li class="border-border/70 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs" data-testid="create-set-picked-{entry.cell.resourceId}">
                <span class="size-2 shrink-0 rounded-full border border-black/10" style="background: {entry.cell.colorHex}" aria-hidden="true"></span>
                <span class="font-mono font-semibold">{entry.cell.sku}</span>
                <span class="text-muted-foreground truncate">{entry.cell.supplier} · {entry.cell.name}</span>
                <label class="ml-auto flex shrink-0 items-center gap-1">
                  <span class="text-muted-foreground">数量</span>
                  <Input
                    class="h-7 w-16 text-right font-mono"
                    type="number"
                    min="0"
                    step="1"
                    value={entry.quantity}
                    data-testid="create-set-qty-{entry.cell.resourceId}"
                    oninput={(event) => setQuantity(entry.cell.resourceId, event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  class="text-muted-foreground hover:text-destructive shrink-0"
                  onclick={() => removePicked(entry.cell.resourceId)}
                  data-testid="create-set-remove-{entry.cell.resourceId}"
                  aria-label="移除 {entry.cell.sku}"
                >
                  <X class="size-3.5" aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if submitError !== null}
        <p class="border-destructive/30 bg-destructive/10 text-destructive rounded-md p-2 text-xs leading-relaxed" data-testid="create-set-error" role="alert">{submitError}</p>
      {/if}
    </div>

    <div class="flex items-center gap-2 border-t px-4 py-3">
      <span class="text-muted-foreground mr-auto text-xs">提交调 sets.create（manual-pick 人工挑拣——owner=当前账户）</span>
      <Button size="sm" disabled={submitting} onclick={() => void submit()} data-testid="create-set-submit">
        <Plus class="size-3.5" aria-hidden="true" />
        {submitting ? '保存中…' : SCOPE_COPY[ownerScope].submit}
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
