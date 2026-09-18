<!--
Orthogonal intents (max 4):
1. [2026-09-18 R3] 桌面布局：340px 精调列（BlockPanel）+ 画布主区（来源行 → 画布 45vh → 摘要条 → 策略对比 → 导出条）。
2. [2026-09-18 R4/N6] 移动端画布优先：摘要与[块][物理][色板]抽屉入口合并单行（ChevronUp 暗示可展开）
     → 画布 60vh → 摘要条 → 策略 carousel → 导出条；选中块 → 半屏底部抽屉（画布保持可见）。
3. [2026-09-18 Handoff] handoff 置位（含参考原图）即取图载入；App 层 $effect 已负责切视图。
4. [2026-09-18 N4] 首屏答案位：画布正下方「共 N 钻 · 导出策略」摘要条（gem-summary），
     800px 视口内可见 画布+摘要+至少一行策略卡；钻数唯一大数字位仍在导出条。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import BlockCanvas from '../../../components/Studio/BlockCanvas.svelte'
  import BlockPanel from '../../../components/Studio/BlockPanel.svelte'
  import BlockDetail from '../../../components/Studio/BlockDetail.svelte'
  import BlockList from '../../../components/Studio/BlockList.svelte'
  import PhysicsPanel from '../../../components/Studio/PhysicsPanel.svelte'
  import PalettePanel from '../../../components/Studio/PalettePanel.svelte'
  import SegmentPanel from '../../../components/Studio/SegmentPanel.svelte'
  import CompareGrid from '../../../components/Studio/CompareGrid.svelte'
  import ExportBar from '../../../components/Studio/ExportBar.svelte'
  import { getHandoff } from '$lib/stores/handoff.svelte'
  import {
    STRATEGY_LABELS,
    cancelCompute,
    getActiveResult,
    getActiveStrategy,
    getBlocks,
    getComputeProgress,
    getComputing,
    getDisabledIds,
    getLoadError,
    getSelectedBlockId,
    getSourceImage,
    loadFromFile,
    loadFromHandoff,
    selectBlock,
  } from '$lib/stores/studio.svelte'
  import Upload from '@lucide/svelte/icons/upload'
  import Layers from '@lucide/svelte/icons/layers'
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import Palette from '@lucide/svelte/icons/palette'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'

  const source = $derived(getSourceImage())
  const loadError = $derived(getLoadError())
  const blocks = $derived(getBlocks())
  const activeStrategy = $derived(getActiveStrategy())
  const activeResult = $derived(getActiveResult())
  const computing = $derived(getComputing())
  const progress = $derived(getComputeProgress())


  // 送转化交接：handoff 置位（含视图切换后首次挂载）即取图载入（参考原图自动填充见 store）
  $effect(() => {
    if (getHandoff()) void loadFromHandoff()
  })

  async function onUpload(e: Event): Promise<void> {
    const input = e.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    if (file) await loadFromFile(file)
    input.value = ''
  }

  // ---- 移动端抽屉（lg 以下；参数入口在画布上方，画布优先） ----
  type DrawerKind = 'blocks' | 'physics' | 'palette'
  let drawer = $state<DrawerKind | null>(null)

  // ---- 选中块半屏抽屉（移动端）：选中即露出详情，画布保持可见 ----
  let blockSheetOpen = $state(false)

  function prefersMobileViewport(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1023px)').matches
      : false
  }

  let isMobileViewport = $state(prefersMobileViewport())
  $effect(() => {
    const onResize = (): void => {
      isMobileViewport = prefersMobileViewport()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  // 画布/列表选中块（移动端）→ 自动上滑半屏详情抽屉；关闭抽屉不取消选中（画布高亮仍在）
  $effect(() => {
    if (getSelectedBlockId() && isMobileViewport) blockSheetOpen = true
  })

  const DRAWER_TITLES: Record<DrawerKind, string> = { blocks: '块', physics: '物理参数', palette: '色板' }
</script>

<div
  class="flex h-full min-h-0 flex-col overflow-y-auto lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:overflow-hidden"
>
  <!-- 桌面精调列（340px）：块详情置顶 + 块列表 + 三折叠组；移动端由抽屉承载，此列隐藏 -->
  <aside
    class="hidden lg:col-start-1 lg:row-start-1 lg:flex lg:min-h-0 lg:flex-col lg:overflow-y-auto lg:border-r lg:p-3"
  >
    <BlockPanel />
  </aside>

  <!-- 主区：桌面右列整高滚动；移动端单列（画布优先） -->
  <div
    class="flex min-h-0 flex-col gap-4 p-4 pb-28 lg:col-start-2 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto lg:pb-6"
  >
    {#if source}
      <!-- 载入摘要 + 参数抽屉入口合并单行（N6：来源文件名 chip 化，省一行竖向空间给画布） -->
      <div class="flex flex-wrap items-center gap-1.5 text-xs" data-testid="source-summary">
        <Badge variant="secondary" class="hidden sm:inline-flex">{source.origin === 'handoff' ? '来自实验室' : '本地上传'}</Badge>
        <span class="border-input inline-flex min-w-0 max-w-24 items-center rounded-md border px-1.5 py-0.5 sm:max-w-40">
          <span class="truncate font-medium">{source.name}</span>
        </span>
        <span class="text-muted-foreground hidden font-mono whitespace-nowrap tabular-nums sm:inline">
          {source.width}×{source.height}px
          {#if source.downscale < 1}
            · 已降采样 {(source.downscale * 100).toFixed(0)}%
          {/if}
        </span>
        <label class="cursor-pointer">
          <span
            class="border-input bg-background hover:bg-muted hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium shadow-xs transition-colors"
          >
            <Upload class="size-3.5" />
            <span class="hidden sm:inline">更换</span>
          </span>
          <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={onUpload} />
        </label>
        {#if loadError}
          <span class="text-destructive text-xs" role="alert">{loadError}</span>
        {/if}

        <!-- 移动端参数抽屉入口（ChevronUp 暗示可展开为底部抽屉） -->
        <div class="ml-auto flex items-center gap-1 lg:hidden" data-testid="mobile-param-entry">
          <Button variant="outline" size="xs" onclick={() => (drawer = 'blocks')}>
            <Layers />
            块 {blocks.length > 0 ? blocks.length : ''}
            <ChevronUp class="opacity-60" />
          </Button>
          <Button variant="outline" size="xs" onclick={() => (drawer = 'physics')}>
            <SlidersHorizontal />
            物理
            <ChevronUp class="opacity-60" />
          </Button>
          <Button variant="outline" size="xs" onclick={() => (drawer = 'palette')}>
            <Palette />
            色板
            <ChevronUp class="opacity-60" />
          </Button>
        </div>
      </div>
    {:else if loadError}
      <p class="text-destructive px-1 text-xs" role="alert">{loadError}</p>
    {/if}

    <!-- 分块画布：移动 60vh / 桌面 ≤48vh（N4：给首屏答案位留空间）。
         shrink-0：滚动列的 flex-shrink 会把 60vh 压到 min-h-72(288px) 下限——N6 的根因 -->
    <div class="h-[60vh] min-h-72 shrink-0 lg:h-[45vh]">
      <BlockCanvas />
    </div>

    <!-- 首屏答案位（N4）：画布正下方即可读到「共 N 钻 · 当前策略」；大数字唯一位仍在导出条 -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="gem-summary">
      {#if activeResult && !activeResult.error}
        <span class="font-mono text-base font-semibold tabular-nums" data-testid="gem-summary-count">
          {activeResult.gems.length.toLocaleString()}
          <span class="text-muted-foreground text-xs font-normal">钻</span>
        </span>
        {#if activeResult.dropped > 0}
          <span class="text-muted-foreground">已剔除 {activeResult.dropped} 冲突</span>
        {/if}
      {:else}
        <span class="text-muted-foreground" data-testid="gem-summary-count">
          {computing ? (progress?.label ?? '重算中…') : '待计算'}
        </span>
      {/if}
      <span class="text-muted-foreground">导出策略 · {STRATEGY_LABELS[activeStrategy]}</span>
      {#if computing}
        <Badge variant="secondary" data-testid="compute-badge">
          {progress ? `${progress.label} ${progress.done}/${progress.total}` : '重算中…'}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground h-6 px-2 text-xs"
          data-testid="compute-cancel"
          onclick={() => cancelCompute()}
        >
          取消
        </Button>
      {/if}
    </div>

    <CompareGrid />
    <ExportBar />
  </div>
</div>

<!-- 移动端参数抽屉（bottom sheet）：复用桌面同款面板组件 -->
<Sheet.Root
  open={drawer !== null}
  onOpenChange={(open) => {
    if (!open) drawer = null
  }}
>
  <Sheet.Content side="bottom" class="max-h-[75vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-testid="param-drawer">
    <Sheet.Header class="pb-2">
      <Sheet.Title class="text-sm">{drawer ? DRAWER_TITLES[drawer] : ''}</Sheet.Title>
    </Sheet.Header>
    <div class="px-4 pb-4">
      {#if drawer === 'blocks'}
        <div class="grid gap-3">
          <BlockDetail />
          <BlockList />
          <div class="grid gap-1">
            <p class="text-muted-foreground text-xs font-medium">分块参数</p>
            <SegmentPanel readOnly />
          </div>
        </div>
      {:else if drawer === 'physics'}
        <PhysicsPanel />
      {:else if drawer === 'palette'}
        <PalettePanel />
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- 移动端选中块半屏抽屉：选中即在手边，画布保持可见 -->
<Sheet.Root bind:open={blockSheetOpen} onOpenChange={(open) => !open && (blockSheetOpen = open)}>
  <Sheet.Content side="bottom" class="max-h-[70vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-testid="block-sheet">
    <Sheet.Header class="pb-2">
      <Sheet.Title class="text-sm">选中块</Sheet.Title>
      <Sheet.Description class="text-xs">拖动可收起；关闭抽屉不会取消画布上的选中。</Sheet.Description>
    </Sheet.Header>
    <div class="px-4 pb-4">
      <BlockDetail />
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground mt-3 w-full rounded-md border py-1.5 text-xs transition-colors"
        onclick={() => {
          selectBlock(null)
          blockSheetOpen = false
        }}
      >
        取消选中
      </button>
    </div>
  </Sheet.Content>
</Sheet.Root>
