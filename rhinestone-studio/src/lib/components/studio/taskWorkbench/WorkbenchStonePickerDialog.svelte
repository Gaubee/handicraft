<!--
WorkbenchStonePickerDialog.svelte — 工作台选钻 Dialog（2026-10-05 Owner 整改）。
原始需求输入（Owner 2026-10-05）：「"用钻（992 款候选——点击多选）" 这种无脑平铺的体验
非常差，用一个 Dialog 来收纳这个选钻的功能，并且在 Dialog 中，你可以把体验打磨得更好，
可以提供搜索、提供分组、等等增强功能。另外，目前所有的钻，你都没有提供正确的配图。
我这边看到的全都是色块」。
正交意图：
  [1] 搜索（sku/款式名/供应商/族/hex 客户端子串过滤——992 行本地过滤零请求）+
      「仅看已选」toggle+已选计数；
  [2] 分组视图（family 折叠区——组默认折叠展开才渲染格子，防 992 格一次性渲染；
      组序=数量降序+locale 字母序（中文/字母代号混杂容错，不改数据）；「全部」平铺
      视图作为另一切换）；
  [3] 真实配图（textureUrl 经 withAuthToken 拼 ?token=——img 通道不带头；无贴图款
      （pending/加载失败）=色块+「无贴图」角标占位）；
  [4] 已选托盘（底部横排已选缩略单击移除+清空钮）+应用语义（空选=沿用当前指派——
      按钮文案明示防误操作；首指派（无既有指派）空选=禁用——服务端必拒不赌）。
选集草稿=Dialog 内部 working 态（开窗快照 selectedIdx——取消丢弃，应用经
onApply(selection) 走 Inspector 现 applyLayerStrategy 通道提交 stoneIdx）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import type { StoneCandidateRow } from '@handicraft/contracts'
  import { withAuthToken } from '$lib/stonesAdmin/authUrl'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Search from '@lucide/svelte/icons/search'
  import X from '@lucide/svelte/icons/x'

  interface Props {
    open: boolean
    /** 候选表（task.detail.stoneCandidates——992 款全量，本地过滤）。 */
    candidates: StoneCandidateRow[]
    /** 开窗锚定选中集（Inspector selectedStoneIdx——stoneDraft ?? 指派反查）。 */
    selectedIdx: number[]
    applying: boolean
    applyError: string | null
    /** 既有指派在场（空选应用=沿用旧指派语义成立；首指派空选=服务端必拒→禁用）。 */
    hasExistingAssignment: boolean
    onOpenChange: (open: boolean) => void
    /** 提交选集（返回 true=成功由父级关窗；false=失败留窗呈现错误）。 */
    onApply: (selection: number[]) => Promise<boolean>
  }

  let {
    open,
    candidates,
    selectedIdx,
    applying,
    applyError,
    hasExistingAssignment,
    onOpenChange,
    onApply,
  }: Props = $props()

  // ---- 选集草稿（开窗快照——会话锚 armed 防 selectedIdx 漂移覆写进行中的选择） ----
  let working = $state<number[]>([])
  let search = $state('')
  let selectedOnly = $state(false)
  let view = $state<'group' | 'all'>('group')
  /** 组展开态（缺省折叠——懒渲染锚；搜索时无视折叠全展开）。 */
  let expanded = $state<Record<string, boolean>>({})
  /** 贴图加载失败回退（resourceId 键——失败后落色块+「无贴图」占位，不反复试探）。 */
  let failed = $state<Record<string, boolean>>({})
  let armed = $state(false)

  $effect(() => {
    if (open) {
      if (!armed) {
        working = [...selectedIdx]
        search = ''
        selectedOnly = false
        view = 'group'
        expanded = {}
        failed = {}
        armed = true
      }
    } else {
      armed = false
    }
  })

  function toggleStone(idx: number): void {
    working = working.includes(idx) ? working.filter((v) => v !== idx) : [...working, idx].sort((a, b) => a - b)
  }

  // ---- [1] 搜索过滤（客户端子串——sku/款式名/供应商/族/hex 小写包含） ----
  const needle = $derived(search.trim().toLowerCase())
  const filtered = $derived(
    candidates.filter((candidate) => {
      if (selectedOnly && !working.includes(candidate.idx)) return false
      if (needle === '') return true
      const hay = [candidate.sku, candidate.styleName ?? '', candidate.supplier, candidate.family, candidate.colorHex]
        .join(' ')
        .toLowerCase()
      return hay.includes(needle)
    }),
  )

  // ---- [2] family 分组（组序=数量降序+locale 序——中文/字母代号混杂容错，不改数据） ----
  const groups = $derived.by(() => {
    const byFamily = new Map<string, StoneCandidateRow[]>()
    for (const candidate of filtered) {
      const rows = byFamily.get(candidate.family) ?? []
      rows.push(candidate)
      byFamily.set(candidate.family, rows)
    }
    return [...byFamily.entries()]
      .map(([family, rows]) => ({ family, rows }))
      .sort(
        (a, b) =>
          b.rows.length - a.rows.length ||
          a.family.localeCompare(b.family, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
      )
  })

  /** 搜索中/仅看已选=无视折叠全展开（命中即见——过滤态下折叠只会藏住目标）。 */
  function groupOpen(family: string): boolean {
    return needle !== '' || selectedOnly || expanded[family] === true
  }

  // ---- [4] 已选托盘行（idx→候选；不在候选表的 idx 不呈现——反查同口径） ----
  const trayRows = $derived(
    working
      .map((idx) => candidates.find((candidate) => candidate.idx === idx))
      .filter((candidate): candidate is StoneCandidateRow => candidate !== undefined),
  )

  /** 首指派空选=必拒禁用（服务端「无尺寸依据钻」typed 拒——不发出必败请求）。 */
  const applyBlocked = $derived(applying || (!hasExistingAssignment && working.length === 0))

  const applyLabel = $derived(
    working.length > 0
      ? `应用（已选 ${working.length} 款）`
      : hasExistingAssignment
        ? '应用（空选=沿用当前指派）'
        : '应用（首指派至少选一款）',
  )

  async function submit(): Promise<void> {
    if (applyBlocked) return
    const ok = await onApply([...working])
    if (ok) onOpenChange(false)
  }

  // ---- [3] 格子视图数据（贴图在场=img 通道（withAuthToken 拼 ?token=）；无/失败=色块占位） ----
  function textureSrc(candidate: StoneCandidateRow): string | null {
    if (candidate.textureUrl === null || candidate.textureUrl === undefined) return null
    if (failed[candidate.resourceId] === true) return null
    return withAuthToken(candidate.textureUrl)
  }

  /** sku 短码（首 token——「J-201 朱红」→「J-201」；格子底栏空间有限）。 */
  function skuShort(sku: string): string {
    return sku.split(/\s+/)[0] ?? sku
  }

  function titleOf(candidate: StoneCandidateRow): string {
    const parts = [
      candidate.sku,
      candidate.styleName ?? null,
      candidate.supplier,
      candidate.sizeMm !== null ? `${candidate.sizeMm}mm` : '未声明尺寸（不可单独承载）',
      candidate.family,
      candidate.finish ?? null,
    ].filter((part): part is string => part !== null)
    return `${parts.join(' · ')} · idx=${candidate.idx}`
  }

  function onTrayRemove(idx: number): void {
    working = working.filter((v) => v !== idx)
  }
</script>

<Dialog.Root
  open={open}
  onOpenChange={(next) => {
    if (!next && applying) return // 在途应用不关窗（Loading 锁——防丢已选意图）
    onOpenChange(next)
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="bg-black/40" />
    <Dialog.Content
      class="bg-background fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border p-4 shadow-lg"
      escapeKeydownBehavior={applying ? 'ignore' : 'close'}
      interactOutsideBehavior={applying ? 'ignore' : 'close'}
      showCloseButton={!applying}
      data-testid="workbench-stone-dialog"
    >
      <Dialog.Header class="mb-2 shrink-0">
        <Dialog.Title class="flex items-center gap-1.5 text-sm font-semibold">
          <Search class="size-3.5" aria-hidden="true" />
          选择用钻
        </Dialog.Title>
        <Dialog.Description class="text-muted-foreground text-[11px] leading-relaxed">
          全库 {candidates.length} 款候选——搜索/分组浏览，贴图点选（多选=混钻排布）
        </Dialog.Description>
      </Dialog.Header>

      <!-- [1] 顶栏：搜索+仅看已选+视图切换+已选计数 -->
      <div class="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
        <div class="relative min-w-40 flex-1">
          <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2" aria-hidden="true" />
          <input
            type="text"
            value={search}
            oninput={(event) => (search = event.currentTarget.value)}
            placeholder="搜索 SKU / 色名 / 供应商 / 族 / 十六进制"
            class="border-input bg-background focus-visible:ring-ring w-full rounded-md border py-1 pr-6 pl-6 text-xs outline-none focus-visible:ring-2"
            data-testid="workbench-stone-search"
          />
          {#if search !== ''}
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2"
              onclick={() => (search = '')}
              aria-label="清空搜索"
              data-testid="workbench-stone-search-clear"
            >
              <X class="size-3" aria-hidden="true" />
            </button>
          {/if}
        </div>
        <label class="flex cursor-pointer items-center gap-1 text-[11px]" data-testid="workbench-stone-selected-only-label">
          <input
            type="checkbox"
            checked={selectedOnly}
            onchange={(event) => (selectedOnly = event.currentTarget.checked)}
            class="size-3.5 accent-primary"
            data-testid="workbench-stone-selected-only"
          />
          仅看已选
        </label>
        <div class="border-input inline-flex overflow-hidden rounded-md border text-[10px]" role="group" aria-label="浏览视图">
          <button
            type="button"
            class={view === 'group' ? 'bg-primary text-primary-foreground px-2 py-0.5 font-medium' : 'hover:bg-accent text-muted-foreground px-2 py-0.5'}
            onclick={() => (view = 'group')}
            data-testid="workbench-stone-view-group"
          >
            按族分组
          </button>
          <button
            type="button"
            class={view === 'all' ? 'bg-primary text-primary-foreground px-2 py-0.5 font-medium' : 'hover:bg-accent text-muted-foreground px-2 py-0.5'}
            onclick={() => (view = 'all')}
            data-testid="workbench-stone-view-all"
          >
            全部平铺
          </button>
        </div>
        <span class="text-muted-foreground font-mono text-[10px]" data-testid="workbench-stone-count">
          已选 {working.length} · 匹配 {filtered.length}/{candidates.length}
        </span>
      </div>

      <!-- [2] 候选浏览区（滚动体——分组折叠/全部平铺两视图） -->
      <div class="scrollbar-thin scrollbar-track-transparent min-h-0 flex-1 overflow-y-auto pr-0.5" data-testid="workbench-stone-grid">
        {#if filtered.length === 0}
          <p class="text-muted-foreground px-1 py-8 text-center text-xs" data-testid="workbench-stone-filter-empty">
            {selectedOnly ? '已选款不在当前搜索范围内——清搜索或关「仅看已选」' : '无匹配钻——换个关键词（SKU/色名/供应商/族）试试'}
          </p>
        {:else if view === 'group'}
          {#each groups as group (group.family)}
            {@const groupSelected = group.rows.filter((row) => working.includes(row.idx)).length}
            {@const isOpen = groupOpen(group.family)}
            <div class="mb-1.5 rounded-md border" data-testid="workbench-stone-group" data-family={group.family}>
              <button
                type="button"
                class="hover:bg-accent/50 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
                onclick={() => (expanded[group.family] = !isOpen)}
                aria-expanded={isOpen}
                data-testid="workbench-stone-group-header"
              >
                {#if isOpen}
                  <ChevronDown class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                {:else}
                  <ChevronRight class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                {/if}
                <span class="min-w-0 flex-1 truncate text-xs font-medium">{group.family}</span>
                <span class="text-muted-foreground font-mono text-[10px]">{group.rows.length} 款</span>
                {#if groupSelected > 0}
                  <span class="text-primary font-mono text-[10px]">已选 {groupSelected}</span>
                {/if}
              </button>
              {#if isOpen}
                <div class="grid grid-cols-6 gap-1 p-1.5 pt-0 sm:grid-cols-8">
                  {#each group.rows as candidate (candidate.idx)}
                    {@const src = textureSrc(candidate)}
                    {@const active = working.includes(candidate.idx)}
                    <button
                      type="button"
                      class="group relative flex aspect-square items-center justify-center overflow-hidden rounded-md border transition-all {active ? 'border-primary ring-primary/50 ring-2' : 'border-border hover:border-primary/50'}"
                      onclick={() => toggleStone(candidate.idx)}
                      aria-pressed={active}
                      data-testid="workbench-stone-{candidate.idx}"
                      title={titleOf(candidate)}
                    >
                      {#if src !== null}
                        <img
                          src={src}
                          alt="{candidate.sku} 贴图"
                          loading="lazy"
                          decoding="async"
                          class="h-full w-full object-contain"
                          onerror={() => (failed[candidate.resourceId] = true)}
                          data-testid="workbench-stone-img-{candidate.idx}"
                        />
                      {:else}
                        <span class="absolute inset-0" style="background: {candidate.colorHex}" aria-hidden="true"></span>
                        <span class="absolute inset-x-0 top-0 bg-black/45 text-center text-[7px] leading-tight text-white" title="无贴图（pending）">无贴图</span>
                      {/if}
                      <span class="absolute inset-x-0 bottom-0 truncate bg-black/45 px-0.5 text-center font-mono text-[7px] leading-tight text-white" aria-hidden="true">
                        {skuShort(candidate.sku)}{candidate.sizeMm !== null ? `·${candidate.sizeMm}` : ''}
                      </span>
                      {#if candidate.sizeMm === null}
                        <span class="absolute left-0.5 top-0.5 text-[9px] font-bold text-amber-300" title="未声明尺寸">!</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {:else}
          <div class="grid grid-cols-6 gap-1 sm:grid-cols-8">
            {#each filtered as candidate (candidate.idx)}
              {@const src = textureSrc(candidate)}
              {@const active = working.includes(candidate.idx)}
              <button
                type="button"
                class="group relative flex aspect-square items-center justify-center overflow-hidden rounded-md border transition-all {active ? 'border-primary ring-primary/50 ring-2' : 'border-border hover:border-primary/50'}"
                onclick={() => toggleStone(candidate.idx)}
                aria-pressed={active}
                data-testid="workbench-stone-{candidate.idx}"
                title={titleOf(candidate)}
              >
                {#if src !== null}
                  <img
                    src={src}
                    alt="{candidate.sku} 贴图"
                    loading="lazy"
                    decoding="async"
                    class="h-full w-full object-contain"
                    onerror={() => (failed[candidate.resourceId] = true)}
                    data-testid="workbench-stone-img-{candidate.idx}"
                  />
                {:else}
                  <span class="absolute inset-0" style="background: {candidate.colorHex}" aria-hidden="true"></span>
                  <span class="absolute inset-x-0 top-0 bg-black/45 text-center text-[7px] leading-tight text-white" title="无贴图（pending）">无贴图</span>
                {/if}
                <span class="absolute inset-x-0 bottom-0 truncate bg-black/45 px-0.5 text-center font-mono text-[7px] leading-tight text-white" aria-hidden="true">
                  {skuShort(candidate.sku)}{candidate.sizeMm !== null ? `·${candidate.sizeMm}` : ''}
                </span>
                {#if candidate.sizeMm === null}
                  <span class="absolute left-0.5 top-0.5 text-[9px] font-bold text-amber-300" title="未声明尺寸">!</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- [4] 已选托盘（横排缩略单击移除+清空） -->
      <div class="mt-2 flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5" data-testid="workbench-stone-tray">
        <span class="text-muted-foreground shrink-0 text-[10px]">已选 {working.length}</span>
        <div class="scrollbar-thin scrollbar-track-transparent flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {#if trayRows.length === 0}
            <span class="text-muted-foreground/70 text-[10px]" data-testid="workbench-stone-tray-empty">
              {hasExistingAssignment ? '未选——应用将沿用当前指派钻' : '首指派至少选一款'}
            </span>
          {:else}
            {#each trayRows as candidate (candidate.idx)}
              {@const src = textureSrc(candidate)}
              <button
                type="button"
                class="group relative size-8 shrink-0 overflow-hidden rounded border border-border hover:border-destructive"
                onclick={() => onTrayRemove(candidate.idx)}
                title="点击移除：{titleOf(candidate)}"
                data-testid="workbench-stone-tray-{candidate.idx}"
              >
                {#if src !== null}
                  <img src={src} alt="{candidate.sku} 贴图" loading="lazy" class="h-full w-full object-contain" />
                {:else}
                  <span class="absolute inset-0" style="background: {candidate.colorHex}" aria-hidden="true"></span>
                {/if}
                <span class="absolute inset-0 hidden items-center justify-center bg-black/50 group-hover:flex" aria-hidden="true">
                  <X class="size-3 text-white" />
                </span>
              </button>
            {/each}
          {/if}
        </div>
        {#if working.length > 0}
          <button
            type="button"
            class="text-muted-foreground hover:text-destructive shrink-0 text-[10px] underline-offset-2 hover:underline"
            onclick={() => (working = [])}
            data-testid="workbench-stone-tray-clear"
          >
            清空
          </button>
        {/if}
      </div>

      <Dialog.Footer class="mt-3 shrink-0 gap-1.5">
        {#if applyError !== null}
          <p class="text-destructive mr-auto max-w-[55%] text-left text-[10px] leading-relaxed" data-testid="workbench-stone-apply-error" role="alert">
            应用失败：{applyError}
          </p>
        {/if}
        <Button size="sm" variant="outline" disabled={applying} onclick={() => onOpenChange(false)} data-testid="workbench-stone-cancel">
          取消
        </Button>
        <Button size="sm" class="shrink-0" disabled={applyBlocked} onclick={() => void submit()} data-testid="workbench-stone-apply" title={applyLabel}>
          {#if applying}
            <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
            应用中…
          {:else}
            {applyLabel}
          {/if}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
