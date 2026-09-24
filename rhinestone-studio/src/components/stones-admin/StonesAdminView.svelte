<!--
StonesAdminView.svelte——「装饰钻库」管理视图（add-stone-library S3.3，design §4.2）。
开发者/管理员旗标入口（与隐藏素材库 tab 并列）；数据源=daemon resources（区别于
素材库的本地 IDB——stone 单一真源在 daemon，共享读 shared-library）。
布局：左树（供应商→色系→款式行→SKU）+ 主区（filter 面板：色系/尺寸/供应商/
关键字/分页/groupBy + 样卡式虚拟滚动网格）+ 详情 RightSheet + 回收站（只读+恢复
占位）+ 导入向导入口。二八法则：高频=搜索/分组/网格直接放主区；导入/刷新收纳
工具行，metadata/raw JSON 收纳详情折叠。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import type { StoneGridCell } from '@handicraft/contracts'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Select from '$lib/components/ui/select'
  import StoneCard from './StoneCard.svelte'
  import StoneCardGrid from './StoneCardGrid.svelte'
  import StonesTreeNav from './StonesTreeNav.svelte'
  import StoneDetailSheet from './StoneDetailSheet.svelte'
  import ImportWizard from './ImportWizard.svelte'
  import {
    getStonesAdminError,
    getStonesFamilyOptions,
    getStonesFilter,
    getStonesList,
    getStonesListState,
    getStonesTotalPages,
    getStonesTrashItems,
    getStonesTrashState,
    getStonesTreeState,
    initStonesAdmin,
    isStonesTrashMode,
    openStoneDetail,
    refreshStonesAdmin,
    setStonesFilter,
    setStonesPage,
    setStonesTrashMode,
  } from '$lib/stonesAdmin/store.svelte'
  import { openImportWizard } from '$lib/stonesAdmin/wizard.svelte'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Search from '@lucide/svelte/icons/search'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'

  onMount(() => {
    void initStonesAdmin()
  })

  const treeState = $derived(getStonesTreeState())
  const list = $derived(getStonesList())
  const listState = $derived(getStonesListState())
  const filter = $derived(getStonesFilter())
  const totalPages = $derived(getStonesTotalPages())
  const trashMode = $derived(isStonesTrashMode())
  const trashItems = $derived(getStonesTrashItems())
  const trashState = $derived(getStonesTrashState())
  const error = $derived(getStonesAdminError())

  const cells = $derived(list?.cells ?? [])
  /** 色系选项：树内 supplier 半径全量键（尺寸走数值输入——不建页内切片键）。 */
  const familyOptions = $derived(getStonesFamilyOptions())

  let qInput = $state('')
  $effect(() => {
    qInput = filter.q ?? ''
  })
  let sizeInput = $state('')

  function applyQ(): void {
    const trimmed = qInput.trim()
    void setStonesFilter({ q: trimmed === '' ? undefined : trimmed })
  }

  function applySize(): void {
    const parsed = Number.parseFloat(sizeInput)
    void setStonesFilter({ sizeMm: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined })
  }

  function openDetail(cell: StoneGridCell): void {
    void openStoneDetail(cell.resourceId)
  }

  const GROUPBY_OPTIONS: Array<{ value: string; label: string }> = [
    { value: '', label: '平铺（不分段）' },
    { value: 'family', label: '按色系分段' },
    { value: 'sizeMm', label: '按尺寸分段' },
    { value: 'style', label: '按款式分段' },
  ]
</script>

<div class="flex h-full min-h-0 min-w-0" data-testid="stones-admin-view">
  <!-- 左树（lg+；移动端收纳——管理面以桌面为主） -->
  <aside class="bg-background hidden w-60 shrink-0 flex-col border-r lg:flex">
    <StonesTreeNav onopenstone={openDetail} />
  </aside>

  <section class="flex min-w-0 flex-1 flex-col">
    <!-- filter 面板 -->
    <div class="bg-background/80 flex flex-wrap items-center gap-2 border-b px-3 py-2 backdrop-blur" data-testid="stones-filter-bar">
      <label class="relative min-w-40 flex-1 sm:max-w-56">
        <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" aria-hidden="true" />
        <Input
          class="h-8 pl-7 text-sm"
          placeholder="搜索 SKU / 色名 / 十六进制"
          data-testid="stones-filter-q"
          bind:value={qInput}
          onkeydown={(event) => {
            if (event.key === 'Enter') applyQ()
          }}
          onblur={() => {
            if ((filter.q ?? '') !== qInput.trim()) applyQ()
          }}
        />
      </label>
      {#if filter.q !== undefined}
        <Button variant="ghost" size="sm" class="h-8 px-2" onclick={() => { qInput = ''; void setStonesFilter({ q: undefined }) }} data-testid="stones-filter-q-clear" title="清除关键字">
          <X class="size-3.5" aria-hidden="true" />
        </Button>
      {/if}

      <Select.Root
        type="single"
        value={filter.family ?? ''}
        onValueChange={(value) => void setStonesFilter({ family: value === '' ? undefined : value })}
      >
        <Select.Trigger class="h-8 w-28 text-sm" data-testid="stones-filter-family" aria-label="色系筛选">
          {filter.family ?? '全部色系'}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="" data-testid="stones-filter-family-all">全部色系</Select.Item>
          {#each familyOptions as family (family)}
            <Select.Item value={family}>{family}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>

      <label class="flex items-center gap-1">
        <Input
          class="h-8 w-20 text-sm"
          type="number"
          min="0.1"
          step="0.1"
          placeholder="尺寸mm"
          data-testid="stones-filter-size"
          bind:value={sizeInput}
          onkeydown={(event) => {
            if (event.key === 'Enter') applySize()
          }}
          onblur={applySize}
        />
      </label>
      {#if filter.sizeMm !== undefined}
        <Badge variant="secondary" class="font-mono">{filter.sizeMm}mm</Badge>
      {/if}

      <span class="border-border/70 bg-muted/40 flex h-8 items-center gap-0.5 rounded-lg border p-0.5" role="group" aria-label="分组方式" data-testid="stones-filter-groupby">
        {#each GROUPBY_OPTIONS as option (option.value)}
          <button
            type="button"
            onclick={() => void setStonesFilter({ groupBy: option.value === '' ? undefined : (option.value as 'family' | 'sizeMm' | 'style') })}
            data-testid="stones-filter-groupby-{option.value === '' ? 'flat' : option.value}"
            class="rounded-md px-2 py-1 text-xs transition-colors
              {(filter.groupBy ?? '') === option.value ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}"
            aria-pressed={(filter.groupBy ?? '') === option.value}
          >
            {option.label}
          </button>
        {/each}
      </span>

      {#if filter.supplier !== undefined}
        <Badge variant="outline" class="font-mono" data-testid="stones-filter-supplier-badge">{filter.supplier}</Badge>
      {/if}

      <span class="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" class="h-8" onclick={() => void refreshStonesAdmin()} data-testid="stones-refresh" title="刷新树与列表">
          <RefreshCw class="size-3.5" aria-hidden="true" />
        </Button>
        <Button size="sm" class="h-8" onclick={() => openImportWizard()} data-testid="stones-import-button">
          <Upload class="size-3.5" aria-hidden="true" />
          导入样卡
        </Button>
      </span>
    </div>

    {#if error !== null}
      <p class="border-destructive/30 bg-destructive/10 text-destructive px-3 py-1.5 text-xs" data-testid="stones-error">
        {error}
      </p>
    {/if}

    <!-- 主区：网格 / 回收站 -->
    <main class="bg-muted/30 min-h-0 flex-1 overflow-hidden">
      {#if trashMode}
        <div class="flex h-full flex-col" data-testid="stones-trash-view">
          <div class="flex items-center gap-2 px-4 pt-3 pb-2 text-sm">
            <span class="font-medium">回收站（{trashItems.length}）</span>
            <span class="text-muted-foreground text-xs">软删项只读呈现——恢复待 admin API（daemon service 层 restore 未暴露浏览器 RPC）</span>
            <Button variant="ghost" size="sm" class="ml-auto" onclick={() => void setStonesTrashMode(false)} data-testid="stones-trash-exit">
              返回库视图
            </Button>
          </div>
          {#if trashState === 'loading'}
            <p class="text-muted-foreground flex-1 py-16 text-center text-sm" data-testid="stones-trash-loading">加载中…</p>
          {:else if trashItems.length === 0}
            <p class="text-muted-foreground flex-1 py-16 text-center text-sm" data-testid="stones-trash-empty">回收站为空</p>
          {:else}
            <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(136px, 1fr))">
                {#each trashItems as cell (cell.resourceId)}
                  <div class="h-44">
                    <StoneCard {cell} onopen={openDetail} />
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {:else if treeState === 'loading' && listState === 'idle'}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="stones-loading">装饰钻库加载中…</p>
      {:else}
        <StoneCardGrid {cells} groupBy={filter.groupBy} onopen={openDetail} />
      {/if}
    </main>

    <!-- 状态条 + 分页 -->
    <footer class="bg-background flex h-9 shrink-0 items-center gap-2 border-t px-3 text-xs" data-testid="stones-statusbar">
      {#if trashMode}
        <span class="text-muted-foreground">回收站 {trashItems.length} 项 · 只读</span>
      {:else}
        <span class="text-muted-foreground" data-testid="stones-status-count">
          共 {list?.total ?? 0} 项 · 第 {filter.page}/{totalPages} 页
        </span>
        <span class="flex items-center gap-1">
          <Button variant="ghost" size="sm" class="h-6 w-6 p-0" disabled={filter.page <= 1} onclick={() => void setStonesPage(filter.page - 1)} data-testid="stones-page-prev" aria-label="上一页">
            <ChevronLeft class="size-3.5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" class="h-6 w-6 p-0" disabled={filter.page >= totalPages} onclick={() => void setStonesPage(filter.page + 1)} data-testid="stones-page-next" aria-label="下一页">
            <ChevronRight class="size-3.5" aria-hidden="true" />
          </Button>
        </span>
        <span class="text-muted-foreground ml-auto font-mono" data-testid="stones-readscope">共享读 · shared-library</span>
      {/if}
    </footer>
  </section>
</div>

<StoneDetailSheet />
<ImportWizard />
