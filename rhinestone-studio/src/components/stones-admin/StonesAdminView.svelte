<!--
StonesAdminView.svelte——「材料市场」管理视图（add-stone-library S3.3，design §4.2；
restructure-materials-story W1 改名：装饰钻库→材料市场——外部域，管理员维护、
全账号共享；W2a：组合并入左栏分组分区（供应商树下方「组合」可折叠段+添加组合
CreateSetDialog；点组合行→右侧网格切换成员钻卡 sets.get 快照，与供应商树选中
互斥——design §2.2）。
数据源=daemon resources（stone 单一真源在 daemon，共享读 shared-library；
组合面=sets.* 经 S7.4 WarehouseSetsClient 复用）。
布局：左树（供应商→色系→款式行→SKU）+组合分区 + 主区（filter 面板：色系/尺寸/
供应商/关键字/分页/groupBy + 样卡式虚拟滚动网格 / 组合成员网格）+ 详情 RightSheet
+ 回收站（只读+恢复占位）+ 导入向导入口。二八法则：高频=搜索/分组/网格直接放
主区；导入/刷新收纳工具行，metadata/raw JSON 收纳详情折叠。
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
  import CreateSetDialog from './CreateSetDialog.svelte'
  import {
    getStonesAdminError,
    getStonesFamilyOptions,
    getStonesFilter,
    getStonesList,
    getStonesListState,
    getStonesMarketSelectedSet,
    getStonesMarketSelectedSetId,
    getStonesMarketSelectedSetState,
    getStonesMarketSets,
    getStonesMarketSetsError,
    getStonesMarketSetsState,
    getStonesTotalPages,
    getStonesTrashItems,
    getStonesTrashState,
    getStonesTreeState,
    initStonesAdmin,
    initStonesMarketSets,
    isStonesMarketSetMode,
    isStonesTrashMode,
    isStonesWriting,
    openStoneDetail,
    refreshStonesAdmin,
    refreshStonesMarketSets,
    restoreStone,
    selectStonesMarketSet,
    setStonesFilter,
    setStonesPage,
    setStonesTrashMode,
  } from '$lib/stonesAdmin/store.svelte'
  import { memberCellOf, memberPlaceholderOf, SET_MEMBER_STATE_LABEL } from '$lib/stonesAdmin/setMembers'
  import { withAuthToken } from '$lib/stonesAdmin/authUrl'
  import { openImportWizard } from '$lib/stonesAdmin/wizard.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Package from '@lucide/svelte/icons/package'
  import Plus from '@lucide/svelte/icons/plus'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Search from '@lucide/svelte/icons/search'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'

  onMount(() => {
    void initStonesAdmin()
    // 组合分区初始化（W2a）：生产/开发面绑缺省 sets RPC 客户端并拉列表；vitest
    // 环境跳过自动绑（jsdom 无 daemon——测试显式 bind fixture 后调 initStonesMarketSets）。
    if (!import.meta.env.VITEST) void initStonesMarketSets()
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
  const marketSets = $derived(getStonesMarketSets())
  const marketSetsState = $derived(getStonesMarketSetsState())
  const marketSetsError = $derived(getStonesMarketSetsError())
  const selectedSetId = $derived(getStonesMarketSelectedSetId())
  const selectedSetDetail = $derived(getStonesMarketSelectedSet())
  const selectedSetState = $derived(getStonesMarketSelectedSetState())
  /** 网格模式（W2a）：组合选中=成员钻卡网格；与供应商树选中互斥。 */
  const setMode = $derived(isStonesMarketSetMode())
  const selectedSummary = $derived(marketSets.find((set) => set.resourceId === selectedSetId))
  const selectedMembers = $derived(selectedSetDetail?.members ?? [])

  const cells = $derived(list?.cells ?? [])
  /** 色系选项：树内 supplier 半径全量键（尺寸走数值输入——不建页内切片键）。 */
  const familyOptions = $derived(getStonesFamilyOptions())

  let qInput = $state('')
  $effect(() => {
    qInput = filter.q ?? ''
  })
  let sizeInput = $state('')

  /** 左栏组合分区折叠态（默认展开——design §2.2）。 */
  let setsExpanded = $state(true)
  /** CreateSetDialog 开合（ownerScope=market——材料市场左栏「添加组合」入口）。 */
  let setDialogOpen = $state(false)

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

  /** CreateSetDialog 创建成功：刷新组合列表并选中新组合（网格即切成员视图）。 */
  async function onSetCreated(set: { resourceId: string; name: string }): Promise<void> {
    await refreshStonesMarketSets()
    await selectStonesMarketSet(set.resourceId)
  }

  const GROUPBY_OPTIONS: Array<{ value: string; label: string }> = [
    { value: '', label: '平铺（不分段）' },
    { value: 'family', label: '按色系分段' },
    { value: 'sizeMm', label: '按尺寸分段' },
    { value: 'style', label: '按款式分段' },
  ]
</script>

<div class="flex h-full min-h-0 min-w-0" data-testid="stones-admin-view">
  <!-- 左树（lg+；移动端收纳——管理面以桌面为主）+ 组合分区（W2a：供应商树下方） -->
  <aside class="bg-background hidden w-60 shrink-0 flex-col border-r lg:flex">
    <div class="min-h-0 flex-1">
      <StonesTreeNav onopenstone={openDetail} />
    </div>

    <!-- 组合分区（可折叠，与树同视觉语言——design §2.2；行=名称+成员数徽标） -->
    <div class="border-t" data-testid="stones-sets-section">
      <div class="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onclick={() => (setsExpanded = !setsExpanded)}
          aria-label={setsExpanded ? '折叠组合分区' : '展开组合分区'}
          aria-expanded={setsExpanded}
          class="text-muted-foreground hover:text-foreground -ml-1 rounded p-0.5"
          data-testid="stones-sets-toggle"
        >
          {#if setsExpanded}
            <ChevronDown class="size-3.5" aria-hidden="true" />
          {:else}
            <ChevronRight class="size-3.5" aria-hidden="true" />
          {/if}
        </button>
        <span class="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium">
          <Package class="size-4 shrink-0" aria-hidden="true" />
          <span class="truncate">组合</span>
          {#if marketSets.length > 0}
            <span class="text-muted-foreground font-mono text-[11px]">{marketSets.length}</span>
          {/if}
        </span>
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground hover:text-foreground h-7 w-7 p-0"
          onclick={() => (setDialogOpen = true)}
          data-testid="stones-set-add"
          title="添加组合（材料市场——sets.create）"
          aria-label="添加组合"
        >
          <Plus class="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      {#if setsExpanded}
        <div class="scrollbar-thin max-h-56 overflow-y-auto px-2 pb-2">
          {#if marketSetsState === 'loading'}
            <p class="text-muted-foreground px-1 py-2 text-xs" data-testid="stones-sets-loading">组合加载中…</p>
          {:else if marketSetsError !== null}
            <p class="text-destructive rounded bg-destructive/10 px-1.5 py-2 text-xs leading-relaxed" data-testid="stones-sets-error" role="alert">{marketSetsError}</p>
          {:else if marketSets.length === 0}
            <p class="text-muted-foreground px-1 py-2 text-xs" data-testid="stones-sets-empty">
              暂无组合——右上「+」从钻库挑拣成员新建
            </p>
          {:else}
            <div class="flex flex-col gap-0.5">
              {#each marketSets as set (set.resourceId)}
                <button
                  type="button"
                  onclick={() => void selectStonesMarketSet(set.resourceId)}
                  data-testid="stones-set-row-{set.resourceId}"
                  aria-current={selectedSetId === set.resourceId ? 'true' : undefined}
                  title="{set.name}（{set.memberCount} 项成员）"
                  class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors
                    {selectedSetId === set.resourceId ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
                >
                  <span class="min-w-0 flex-1 truncate">{set.name}</span>
                  <span class="text-muted-foreground shrink-0 font-mono text-[10px]">{set.memberCount}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
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
          class="h-8 w-24 text-sm"
          type="number"
          min="0.1"
          step="0.1"
          placeholder="尺寸(mm)"
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

    <!-- 主区：网格（钻型/组合成员互斥） / 回收站 -->
    <main class="bg-muted/30 min-h-0 flex-1 overflow-hidden" data-testid="stones-grid-mode-{setMode && !trashMode ? 'set' : 'tree'}">
      {#if trashMode}
        <div class="flex h-full flex-col" data-testid="stones-trash-view">
          <div class="flex items-center gap-2 px-4 pt-3 pb-2 text-sm">
            <span class="font-medium">回收站（{trashItems.length}）</span>
            <span class="text-muted-foreground text-xs">软删项可恢复（stones.restore——祖先仍盖戳时恢复子树无效，需恢复到祖先级）</span>
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
                  <div class="flex h-44 flex-col gap-1">
                    <StoneCard {cell} onopen={openDetail} />
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 w-full text-xs"
                      disabled={isStonesWriting()}
                      onclick={() => void restoreStone(cell.resourceId)}
                      data-testid="stones-trash-restore-{cell.resourceId}"
                      title="恢复该原子（stones.restore）"
                    >
                      恢复
                    </Button>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {:else if setMode}
        <!-- 组合成员网格（W2a）：sets.get 读时解析快照——resolved 复用 StoneCard，
             缺图成员如实占位（五态+限定名/短 ref，§7.1 不剔除不伪造）。 -->
        <div class="flex h-full flex-col" data-testid="stones-set-view">
          <div class="flex items-center gap-2 px-4 pt-3 pb-2 text-sm">
            <span class="font-medium">组合 · {selectedSetDetail?.set.name ?? selectedSummary?.name ?? selectedSetId}</span>
            <span class="text-muted-foreground text-xs">{selectedMembers.length} 项成员 · 成员快照（sets.get 读时解析）</span>
            <Button variant="ghost" size="sm" class="ml-auto" onclick={() => void selectStonesMarketSet(null)} data-testid="stones-set-exit">
              返回钻库
            </Button>
          </div>
          {#if selectedSetState === 'loading' || selectedSetDetail === null}
            <p class="text-muted-foreground flex-1 py-16 text-center text-sm" data-testid="stones-set-loading">
              {selectedSetState === 'error' ? '组合成员装载失败（见左栏组合分区错误提示）' : '组合成员加载中…'}
            </p>
          {:else}
            <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(136px, 1fr))">
                {#each selectedMembers as member (member.stoneRef)}
                  {@const cell = memberCellOf(member)}
                  {#if cell !== null}
                    <div class="h-44">
                      <StoneCard {cell} onopen={openDetail} />
                    </div>
                  {:else}
                    {@const placeholder = memberPlaceholderOf(member)}
                    <div
                      class="border-border/70 bg-card flex h-44 flex-col overflow-hidden rounded-xl border text-left"
                      data-testid="stones-set-member-missing-{placeholder.stoneRef}"
                      title="{placeholder.label}（{SET_MEMBER_STATE_LABEL[placeholder.state]}）"
                    >
                      <span class="bg-zinc-300 dark:bg-zinc-700 relative flex w-full flex-1 items-center justify-center overflow-hidden" style="min-height: 3rem">
                        {#if placeholder.textureUrl !== undefined}
                          <img
                            src={withAuthToken(placeholder.textureUrl)}
                            alt="{placeholder.label} 贴图"
                            loading="lazy"
                            decoding="async"
                            class="h-[80%] w-[80%] object-contain opacity-70"
                          />
                        {:else}
                          <span class="text-muted-foreground text-[10px]">无贴图</span>
                        {/if}
                        <span class="bg-destructive/90 text-destructive-foreground absolute top-1 left-1 rounded px-1 py-0.5 text-[10px] font-medium">
                          {SET_MEMBER_STATE_LABEL[placeholder.state]}
                        </span>
                      </span>
                      <span class="flex flex-col gap-0.5 px-2 py-1.5">
                        <span class="text-foreground/80 truncate font-mono text-xs">{placeholder.label}</span>
                        <span class="text-muted-foreground text-[11px]">{placeholder.quantity !== undefined ? `数量 ${placeholder.quantity}` : '按设计用量另计'}</span>
                      </span>
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {:else if treeState === 'loading' && listState === 'idle'}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="stones-loading">材料市场加载中…</p>
      {:else}
        <StoneCardGrid {cells} groupBy={filter.groupBy} onopen={openDetail} />
      {/if}
    </main>

    <!-- 状态条 + 分页 -->
    <footer class="bg-background flex h-9 shrink-0 items-center gap-2 border-t px-3 text-xs" data-testid="stones-statusbar">
      {#if trashMode}
        <span class="text-muted-foreground">回收站 {trashItems.length} 项 · 只读</span>
      {:else if setMode}
        <span class="text-muted-foreground" data-testid="stones-status-count">
          组合 {selectedSetDetail?.set.name ?? selectedSummary?.name ?? ''} · {selectedMembers.length} 项成员 · 快照只读
        </span>
        <span class="text-muted-foreground ml-auto font-mono" data-testid="stones-readscope">成员解析 · sets.get</span>
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
<CreateSetDialog
  open={setDialogOpen}
  onclose={() => (setDialogOpen = false)}
  ownerScope="market"
  oncreated={(set) => void onSetCreated(set)}
/>
