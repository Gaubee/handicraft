<!--
Orthogonal intents (max 2):
1. [2026-09-19 Tree] 用户目录树（扁平行渲染：展开集驱动 depth 缩进；Svelte 5 无 svelte:self，不自引用递归）。
2. [2026-09-19 Reuse] 桌面左树与移动端「目录 ▾」Sheet 共用。
-->
<script lang="ts">
  import type { AssetFolder } from '$lib/persistence/assetStore'
  import * as library from '$lib/assets/library.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Folder from '@lucide/svelte/icons/folder'

  let {
    currentFolder = '',
    onselect,
  }: {
    currentFolder?: string
    onselect: (folderId: string) => void
  } = $props()

  let expanded = $state<Set<string>>(new Set())

  interface TreeRow {
    folder: AssetFolder
    depth: number
    hasChildren: boolean
  }

  const nodes = $derived(library.getNodes())

  const rows = $derived(buildRows())

  function buildRows(): TreeRow[] {
    const result: TreeRow[] = []
    const walk = (parent: string | null, depth: number): void => {
      const folders = nodes
        .filter(
          (n): n is AssetFolder =>
            n.type === 'folder' &&
            n.parentId === parent &&
            n.system === undefined &&
            (n as { trashedAt?: number }).trashedAt === undefined,
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      for (const folder of folders) {
        const hasChildren = nodes.some(
          (n) => n.type === 'folder' && n.parentId === folder.id && (n as { trashedAt?: number }).trashedAt === undefined,
        )
        result.push({ folder, depth, hasChildren })
        if (expanded.has(folder.id)) walk(folder.id, depth + 1)
      }
    }
    walk(null, 0)
    return result
  }

  function toggleExpand(folderId: string): void {
    const next = new Set(expanded)
    if (next.has(folderId)) next.delete(folderId)
    else next.add(folderId)
    expanded = next
  }
</script>

{#if rows.length === 0}
  <p class="text-muted-foreground/70 px-1.5 text-[11px]">还没有自建文件夹</p>
{:else}
  {#each rows as row (row.folder.id)}
    <div class="flex items-center">
      <button
        type="button"
        class="hover:bg-muted flex h-6 w-5 shrink-0 items-center justify-center rounded {row.hasChildren
          ? ''
          : 'pointer-events-none opacity-0'}"
        onclick={() => toggleExpand(row.folder.id)}
        aria-label={expanded.has(row.folder.id) ? `收起 ${row.folder.name}` : `展开 ${row.folder.name}`}
      >
        {#if expanded.has(row.folder.id)}
          <ChevronDown class="text-muted-foreground size-3" aria-hidden="true" />
        {:else}
          <ChevronRight class="text-muted-foreground size-3" aria-hidden="true" />
        {/if}
      </button>
      <button
        type="button"
        data-testid={`tree-folder-${row.folder.id}`}
        class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded pr-1.5 text-left text-xs transition-colors {currentFolder === row.folder.id
          ? 'bg-primary/10 text-primary font-medium'
          : 'hover:bg-muted text-foreground'}"
        style="padding-left: {row.depth * 0.75}rem"
        onclick={() => onselect(row.folder.id)}
      >
        <Folder class="text-primary/60 size-3.5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{row.folder.name}</span>
      </button>
    </div>
  {/each}
{/if}
