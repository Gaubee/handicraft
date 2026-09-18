<!--
Orthogonal intents (max 3):
1. [2026-09-19 Preview] 大图 + meta（尺寸/大小/来源/时间/originNote/variant）+「N 处引用」徽标（blobKey 计数）。
2. [2026-09-19 Actions] 预览内动作：下载/重命名（行内）/移动/删除（回调上行，AssetsView 统一编排确认框）。
3. [2026-09-19 Mobile] 桌面 Dialog / 移动全屏 Sheet 双形态（matchMedia 切换，jsdom 落桌面分支）。
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Sheet from '$lib/components/ui/sheet'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as library from '$lib/assets/library.svelte'
  import type { AssetImage } from '$lib/persistence/assetStore'
  import Download from '@lucide/svelte/icons/download'
  import Move from '@lucide/svelte/icons/move'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Trash from '@lucide/svelte/icons/trash'
  import Check from '@lucide/svelte/icons/check'
  import X from '@lucide/svelte/icons/x'

  let {
    asset,
    open = $bindable(false),
    ondownload,
    onrename,
    onmove,
    ondelete,
  }: {
    asset?: AssetImage | null
    open?: boolean
    ondownload: (asset: AssetImage) => void
    onrename: (asset: AssetImage, name: string) => void
    onmove: (asset: AssetImage) => void
    ondelete: (asset: AssetImage) => void
  } = $props()

  let isMobile = $state(false)
  let renaming = $state(false)
  let renameValue = $state('')

  $effect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(max-width: 1023px)')
    const update = (): void => {
      isMobile = mq.matches
    }
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  })

  // 每次打开重置行内重命名态
  $effect(() => {
    if (open) {
      renaming = false
      renameValue = asset?.name ?? ''
    }
  })

  const refCount = $derived(asset ? library.referenceCountOf(asset) : 1)
  const url = $derived(!asset ? undefined : asset.trashedAt !== undefined ? null : library.getUrl(asset.id))

  const SOURCE_LABELS: Record<string, string> = {
    upload: '上传',
    'lab-generate': '生成',
    'edit-export': '精修导出',
    preset: '内置案例',
    migrated: '迁移',
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '—'
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  function formatTime(ts: number): string {
    const d = new Date(ts)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  function commitRename(): void {
    if (!asset) return
    onrename(asset, renameValue)
    renaming = false
  }

  function startRename(): void {
    if (!asset) return
    renameValue = asset.name
    renaming = true
  }

  function metaLine(): string {
    if (!asset?.meta) return ''
    const parts: string[] = []
    if (asset.meta.variantName) parts.push(asset.meta.variantName)
    if (asset.meta.candidateIndex !== undefined) parts.push(`候选 ${asset.meta.candidateIndex + 1}`)
    return parts.join(' · ')
  }
</script>

{#if asset}
  {#snippet body()}
    <div class="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
      <!-- 大图（blob 缺失 → 已失效占位） -->
      <div
        class="bg-muted/40 relative mx-auto aspect-square w-full max-w-lg overflow-hidden rounded-lg border"
        style="background-image: repeating-conic-gradient(var(--color-muted) 0% 25%, transparent 0% 50%); background-size: 16px 16px;"
        data-testid="preview-canvas"
      >
        {#if url === null}
          <div class="text-muted-foreground flex size-full flex-col items-center justify-center gap-1 text-xs">
            {#if asset.trashedAt !== undefined}
              <span class="font-medium">图片在回收站中</span>
              <span class="text-muted-foreground/70">清空回收站前可预览元信息</span>
            {:else}
              <span class="font-medium">图片已失效</span>
              <span class="text-muted-foreground/70">源数据缺失（可能被浏览器清理），可删除该条目</span>
            {/if}
          </div>
        {:else if url === undefined}
          <div class="bg-muted animate-pulse size-full"></div>
        {:else}
          <img src={url} alt={asset.name} class="absolute inset-0 size-full object-contain" draggable="false" />
        {/if}
      </div>

      <!-- meta 面板 -->
      <div class="grid content-start gap-2 text-xs">
        <div class="flex flex-wrap items-center gap-1.5">
          {#if refCount > 1}
            <Badge variant="secondary" data-testid="preview-refcount">{refCount} 处引用</Badge>
          {/if}
          <Badge variant="outline">{SOURCE_LABELS[asset.source] ?? asset.source}</Badge>
          {#if asset.trashedAt !== undefined}
            <Badge variant="destructive">回收站中</Badge>
          {/if}
        </div>

        <div class="grid gap-1.5">
          {#if renaming}
            <div class="flex items-center gap-1">
              <Input
                bind:value={renameValue}
                class="h-7 text-xs"
                data-testid="preview-rename-input"
                onkeydown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') renaming = false
                }}
              />
              <Button size="icon-xs" variant="ghost" onclick={commitRename} title="确认重命名">
                <Check />
              </Button>
              <Button size="icon-xs" variant="ghost" onclick={() => (renaming = false)} title="取消">
                <X />
              </Button>
            </div>
          {:else}
            <p class="flex items-center gap-1 truncate text-sm font-medium" data-testid="preview-name" title={asset.name}>
              {asset.name}
              {#if asset.trashedAt === undefined && asset.parentId !== 'sys-cases'}
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground shrink-0"
                  onclick={startRename}
                  title="重命名"
                  data-testid="preview-rename-start"
                >
                  <Pencil class="size-3.5" />
                </button>
              {/if}
            </p>
          {/if}
          <dl class="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt>尺寸</dt>
            <dd class="tabular-nums">{asset.width > 0 ? `${asset.width}×${asset.height}` : '—'}</dd>
            <dt>大小</dt>
            <dd class="tabular-nums">{formatBytes(asset.bytes)}</dd>
            <dt>更新</dt>
            <dd class="tabular-nums">{formatTime(asset.updatedAt)}</dd>
            {#if metaLine()}
              <dt>来源</dt>
              <dd class="truncate" title={metaLine()}>{metaLine()}</dd>
            {/if}
            {#if asset.meta?.originNote}
              <dt>说明</dt>
              <dd>{asset.meta.originNote}</dd>
            {/if}
          </dl>
          {#if asset.meta?.prompt}
            <p class="text-muted-foreground line-clamp-3 rounded border bg-muted/40 p-1.5" title={asset.meta.prompt}>
              {asset.meta.prompt}
            </p>
          {/if}
        </div>

        {#if asset.trashedAt === undefined}
          <div class="mt-1 grid grid-cols-2 gap-1.5">
            {#if url !== null}
              <Button variant="outline" size="sm" onclick={() => ondownload(asset)} data-testid="preview-download">
                <Download />
                下载
              </Button>
            {/if}
            {#if asset.parentId !== 'sys-cases'}
              <Button variant="outline" size="sm" onclick={() => onmove(asset)} data-testid="preview-move">
                <Move />
                移动
              </Button>
              <Button variant="destructive" size="sm" onclick={() => ondelete(asset)} data-testid="preview-delete">
                <Trash />
                删除
              </Button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/snippet}

  {#if isMobile}
    <Sheet.Root bind:open>
      <Sheet.Content side="bottom" class="h-[92vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-testid="preview-sheet">
        <Sheet.Header class="pb-2">
          <Sheet.Title class="text-sm">图片预览</Sheet.Title>
          <Sheet.Description>{asset.name}</Sheet.Description>
        </Sheet.Header>
        <div class="px-4 pb-4">
          {@render body()}
        </div>
      </Sheet.Content>
    </Sheet.Root>
  {:else}
    <Dialog.Root bind:open>
      <Dialog.Content class="max-w-3xl" data-testid="preview-dialog">
        <Dialog.Header>
          <Dialog.Title class="text-sm">图片预览</Dialog.Title>
          <Dialog.Description>查看元信息；重命名/移动/删除不影响其它模块的既有引用。</Dialog.Description>
        </Dialog.Header>
        {@render body()}
      </Dialog.Content>
    </Dialog.Root>
  {/if}
{/if}
