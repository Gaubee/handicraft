<!--
Orthogonal intents (max 3):
1. [2026-09-19 Protocol] controller 的唯一 UI 投影（App 层单实例挂载）：request 驱动开合，
   Esc/外部点击/取消 → controller.cancel()；确定 → controller.resolve(selection)。
2. [2026-09-19 Browse] 快捷集合 chips（最近/全部/生成结果/上传/案例）+ 面包屑 + objectUrl 网格 + 文件夹下钻。
3. [2026-09-19 Ingest] 「上传新图片」入库当前目录→自动选中；同目录重复 → toast「已在库中」+定位高亮。
-->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import AssetThumb from './AssetThumb.svelte'
  import { assetPicker, type AssetPickerController } from '$lib/assets/controller.svelte'
  import * as library from '$lib/assets/library.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { AssetNode } from '$lib/persistence/assetStore'
  import { isAssetProject } from '$lib/persistence/assetStore'
  import Check from '@lucide/svelte/icons/check'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import FileText from '@lucide/svelte/icons/file-text'
  import Folder from '@lucide/svelte/icons/folder'
  import House from '@lucide/svelte/icons/house'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import Upload from '@lucide/svelte/icons/upload'

  let { controller = assetPicker }: { controller?: AssetPickerController } = $props()

  /** 'recent' 虚拟集合；folder id = 目录浏览（null = 根）。 */
  let view = $state<'recent' | 'folder'>('recent')
  let currentFolder = $state<string | null>(null)
  let highlightId = $state<string | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  const request = $derived(controller.request)
  const multi = $derived(request?.multi ?? false)
  /** [add-project-files 3.3] 项目模式：只可选指定 kind 的项目节点（gemdoc/gemproj）。 */
  const projectKinds = $derived(request?.projectKinds)
  const nodes = $derived(library.getNodes())
  const recent = $derived(library.recentAssets())
  const folderItems = $derived(library.childrenOf(currentFolder))
  /** 项目模式：目录可下钻，仅显示匹配 kind 的项目节点（图片不可选故不渲染）。 */
  const items = $derived(
    view === 'recent'
      ? recent
      : projectKinds !== undefined
        ? folderItems.filter(
            (n) => n.type === 'folder' || (isAssetProject(n) && projectKinds.includes(n.projectKind)),
          )
        : folderItems,
  )
  const breadcrumb = $derived(library.pathOf(currentFolder))
  const ready = $derived(library.isReady())

  const PROJECT_KIND_LABELS: Record<string, string> = {
    gemdoc: '精修',
    gemproj: '排钻',
    gemtpl: '模板',
    gemgen: '生成',
  }

  // 会话开启：就绪 + 初始目录；每轮 open 重置浏览态。
  $effect(() => {
    if (request) {
      void library.ensureLibraryReady()
      const initial = request.initialFolderId
      if (initial && initial !== '') {
        view = 'folder'
        currentFolder = initial
      } else {
        view = 'recent'
        currentFolder = null
      }
    }
  })

  function selectQuickCollection(next: 'recent' | 'folder', folderId: string | null): void {
    view = next
    currentFolder = folderId
  }

  function openFolder(id: string): void {
    view = 'folder'
    currentFolder = id
  }

  function goUp(): void {
    currentFolder = library.nodeById(currentFolder)?.parentId ?? null
  }

  function toggleItem(node: AssetNode): void {
    if (node.type === 'folder') {
      openFolder(node.id)
      return
    }
    // [3.3] 项目模式：项目节点按 kind 过滤后可单选（图片在项目模式不可选）
    if (node.type === 'project') {
      if (projectKinds !== undefined && projectKinds.includes(node.projectKind)) controller.pickProject(node)
      return
    }
    if (projectKinds !== undefined) return
    if (node.type !== 'image') return
    if (library.getUrl(node.id) === null) return // 已失效不可选入模块
    controller.pick(node)
  }

  function confirmSelection(): void {
    if (controller.selection.length === 0) return
    controller.resolve(controller.selection)
  }

  /** 上传落当前目录（快捷集合视图回退 sys-uploads）。 */
  function uploadFolderId(): string | null {
    if (view !== 'folder') return 'sys-uploads'
    return currentFolder
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    const target = uploadFolderId()
    const outcome = await library.uploadFiles(files, target)
    // 定位：跳到落点目录并高亮
    view = 'folder'
    currentFolder = outcome.targetFolderId
    for (const node of outcome.created) controller.pick(node)
    if (outcome.duplicates.length > 0) {
      showToast(outcome.duplicates.length === 1 ? '这张图已在库中' : `${outcome.duplicates.length} 张图已在库中`)
      for (const node of outcome.duplicates) {
        controller.pick(node)
        flashHighlight(node.id)
      }
    }
  }

  function flashHighlight(id: string): void {
    highlightId = id
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => (highlightId = null), 2200)
  }

  const quickChips = $derived(
    projectKinds !== undefined
      ? [
          { key: 'all', label: '全部', view: 'folder' as const, folderId: null },
          { key: 'projects', label: '项目', view: 'folder' as const, folderId: 'sys-projects' },
        ]
      : [
          { key: 'recent', label: '最近', view: 'recent' as const, folderId: null },
          { key: 'all', label: '全部', view: 'folder' as const, folderId: null },
          { key: 'generated', label: '生成结果', view: 'folder' as const, folderId: 'sys-generated' },
          { key: 'uploads', label: '上传', view: 'folder' as const, folderId: 'sys-uploads' },
          { key: 'cases', label: '案例', view: 'folder' as const, folderId: 'sys-cases' },
        ],
  )

  function isChipActive(chip: { view: 'recent' | 'folder'; folderId: string | null }): boolean {
    return view === chip.view && currentFolder === chip.folderId
  }

  // design §5：Host 销毁 → 等待方 resolve(null)，不得悬挂。
  onDestroy(() => controller.destroy())
</script>

<Dialog.Root
  open={request !== null}
  onOpenChange={(next) => {
    if (!next) controller.cancel()
  }}
>
  <Dialog.Content class="flex max-h-[85vh] w-[min(56rem,94vw)] flex-col" data-testid="asset-picker">
    <Dialog.Header>
      <Dialog.Title>{projectKinds !== undefined ? '打开项目' : '选择图片'}</Dialog.Title>
      <Dialog.Description>
        {#if projectKinds !== undefined}
          单选一个项目：精修项目（.gemdoc）直接打开续作；排钻项目（.gemproj）自动转化为精修文档。
        {:else}
          {multi ? '可多选，确定后一并带入。' : '单选：点选后确定。'}上传的新图会自动入库并选中。
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <!-- 快捷集合 chips（P0：最近/全部/三个来源目录） -->
    <div class="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="快捷集合">
      {#each quickChips as chip (chip.key)}
        <button
          type="button"
          role="tab"
          aria-selected={isChipActive(chip)}
          data-testid={`picker-chip-${chip.key}`}
          class="h-7 rounded-full border px-3 text-xs font-medium transition-colors {isChipActive(chip)
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}"
          onclick={() => selectQuickCollection(chip.view, chip.folderId)}
        >
          {chip.label}
        </button>
      {/each}
    </div>

    <!-- 面包屑（⌂根 · ▴上级） -->
    {#if view === 'folder'}
      <div class="flex items-center gap-1 text-xs" data-testid="picker-breadcrumb">
        <button
          type="button"
          class="hover:bg-muted flex h-6 items-center gap-1 rounded px-1.5 font-medium"
          onclick={() => selectQuickCollection('folder', null)}
        >
          <House class="size-3.5" aria-hidden="true" />
          全部
        </button>
        {#each breadcrumb as crumb (crumb.id)}
          <ChevronRight class="text-muted-foreground/60 size-3" aria-hidden="true" />
          <button
            type="button"
            class="hover:bg-muted flex h-6 max-w-36 items-center rounded px-1.5 {crumb.id === currentFolder
              ? 'text-foreground font-medium'
              : 'text-muted-foreground truncate'}"
            onclick={() => openFolder(crumb.id)}
          >
            {crumb.name}
          </button>
        {/each}
        {#if currentFolder !== null}
          <button
            type="button"
            class="text-muted-foreground hover:bg-muted hover:text-foreground ml-1 flex h-6 items-center gap-1 rounded px-1.5"
            onclick={goUp}
            title="上一级"
          >
            <ArrowUp class="size-3.5" aria-hidden="true" />
          </button>
        {/if}
      </div>
    {/if}

    <!-- 网格（objectURL；hover 名称/尺寸；文件夹可下钻） -->
    <div class="bg-muted/30 min-h-0 flex-1 overflow-y-auto rounded-lg border p-2">
      {#if !ready && nodes.length === 0}
        <div class="text-muted-foreground flex h-40 items-center justify-center text-xs">正在读取素材库…</div>
      {:else if items.length === 0}
        <div class="text-muted-foreground flex h-40 flex-col items-center justify-center gap-1 text-xs">
          {#if projectKinds !== undefined}
            <span>还没有可打开的项目</span>
            <span class="text-muted-foreground/70">在排钻工作台页保存项目，或从一张图新建设计师文档</span>
          {:else}
            <span>{view === 'recent' ? '还没有可用图片' : '此目录为空'}</span>
            <span class="text-muted-foreground/70">上传新图片，或去实验室生成</span>
          {/if}
        </div>
      {:else}
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {#each items as node (node.id)}
            {@const missing = node.type === 'image' && library.getUrl(node.id) === null}
            {@const selected = controller.isSelected(node.id)}
            <button
              type="button"
              data-testid={`picker-item-${node.id}`}
              data-highlight={highlightId === node.id ? 'true' : undefined}
              class="group relative aspect-square overflow-hidden rounded-md border bg-card transition-all {selected
                ? 'border-primary ring-primary/40 ring-2'
                : 'border-border hover:border-ring'} {highlightId === node.id
                ? 'ring-primary/50 animate-pulse ring-2'
                : ''} {missing ? 'cursor-not-allowed opacity-60' : ''}"
              disabled={missing}
              title={node.type === 'folder'
                ? `打开文件夹「${node.name}」`
                : node.type === 'project'
                  ? `${node.name} · ${PROJECT_KIND_LABELS[node.projectKind] ?? node.projectKind}项目`
                  : node.type === 'image' && node.width > 0
                    ? `${node.name} · ${node.width}×${node.height}`
                    : node.name}
              onclick={() => toggleItem(node)}
            >
              {#if node.type === 'folder'}
                <span class="flex size-full flex-col items-center justify-center gap-1">
                  <Folder class="text-primary/70 size-7" aria-hidden="true" />
                  <span class="w-full truncate px-1 text-center text-[10px]">{node.name}</span>
                </span>
              {:else if node.type === 'project'}
                <span class="flex size-full flex-col items-center justify-center gap-1 px-1">
                  <FileText class="text-primary/70 size-7 shrink-0" aria-hidden="true" />
                  <span class="w-full truncate text-center text-[10px] font-medium">{node.name}</span>
                  <span class="text-muted-foreground text-[9px]">
                    {PROJECT_KIND_LABELS[node.projectKind] ?? node.projectKind}
                  </span>
                </span>
              {:else if node.type === 'image'}
                <AssetThumb asset={node} objectFit="object-cover" />
              {/if}
              {#if selected}
                <span
                  class="bg-primary text-primary-foreground absolute top-1 right-1 flex size-4 items-center justify-center rounded-full"
                  data-testid={`picker-check-${node.id}`}
                >
                  <Check class="size-3" aria-hidden="true" />
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <Dialog.Footer class="sm:justify-between">
      <input
        bind:this={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        class="hidden"
        onchange={(e) => {
          void handleFiles(e.currentTarget.files)
          e.currentTarget.value = ''
        }}
      />
      {#if projectKinds === undefined}
        <Button variant="outline" size="sm" onclick={() => fileInput?.click()} data-testid="picker-upload">
          <Upload />
          上传新图片
        </Button>
      {:else}
        <span></span>
      {/if}
      <div class="flex items-center gap-2">
        {#if controller.selection.length > 0}
          <span class="text-muted-foreground text-xs">已选 {controller.selection.length} 项</span>
        {/if}
        <Button variant="ghost" size="sm" onclick={() => controller.cancel()}>取消</Button>
        <Button size="sm" disabled={controller.selection.length === 0} onclick={confirmSelection} data-testid="picker-confirm">
          确定
        </Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
