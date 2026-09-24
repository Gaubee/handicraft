<!--
StonesTreeNav.svelte——装饰钻库树导航（add-stone-library S3.3，design §4.1 stones.tree）。
供应商→色系→款式行→SKU 四层（软删叶默认剪枝——includeTrashed=false 树）；childCount
徽标；目录选择 → filter 投影（supplier/family 精确半径；款式行归色系半径——不猜测
解析行号）；叶点击 → 详情。「全部钻库」清过滤；「回收站」切 trash 视图（含软删重拉）。
-->

<script lang="ts">
  import type { StoneGridCell } from '@handicraft/contracts'
  import type { StoneTreeNode } from '$lib/stonesAdmin/schemas'
  import {
    clearStonesFilter,
    getStonesFilter,
    getStonesTrashItems,
    getStonesTree,
    isStonesTrashMode,
    selectStonesTreeDir,
    setStonesTrashMode,
  } from '$lib/stonesAdmin/store.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Layers from '@lucide/svelte/icons/layers'
  import Trash2 from '@lucide/svelte/icons/trash-2'

  let {
    onopenstone,
  }: {
    onopenstone: (cell: StoneGridCell) => void
  } = $props()

  const tree = $derived(getStonesTree())
  const filter = $derived(getStonesFilter())
  const trashMode = $derived(isStonesTrashMode())
  const trashCount = $derived(getStonesTrashItems().length)

  /** 展开集（根到达即展开供应商层——回收站计数/导航不藏一层点击）。 */
  let expanded = $state<Set<string>>(new Set())

  $effect(() => {
    const root = tree?.node
    if (root !== null && root !== undefined && root.kind === 'dir' && !expanded.has(root.id)) {
      expanded = new Set([root.id])
    }
  })

  function toggle(id: string): void {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expanded = next
  }

  function keyOf(node: StoneTreeNode): string {
    return node.kind === 'dir' ? node.id : node.cell.resourceId
  }

  /** 目录选择 patch：深度 1=供应商、深度 2=色系、更深（款式行）沿用色系半径。 */
  function dirPatch(depth: number, name: string, parent: { supplier?: string; family?: string }): { supplier?: string; family?: string } {
    if (depth <= 1) return { supplier: name }
    return { supplier: parent.supplier, family: name }
  }

  function isActive(patch: { supplier?: string; family?: string }): boolean {
    return filter.supplier === patch.supplier && filter.family === patch.family
  }
</script>

{#snippet nodes(node: StoneTreeNode, depth: number, parent: { supplier?: string; family?: string })}
  {#if node.kind === 'dir'}
    {@const nodePatch = dirPatch(depth, node.name, parent)}
    <div class="flex items-center" data-testid="stones-tree-dir-{node.name}">
      <button
        type="button"
        onclick={() => toggle(node.id)}
        aria-label={expanded.has(node.id) ? `折叠 ${node.name}` : `展开 ${node.name}`}
        class="text-muted-foreground hover:text-foreground -ml-1 rounded p-0.5"
        data-testid="stones-tree-toggle-{node.id}"
      >
        {#if expanded.has(node.id)}
          <ChevronDown class="size-3" aria-hidden="true" />
        {:else}
          <ChevronRight class="size-3" aria-hidden="true" />
        {/if}
      </button>
      <button
        type="button"
        onclick={() => void selectStonesTreeDir(nodePatch)}
        data-testid="stones-tree-select-{node.name}"
        class="min-w-0 flex-1 rounded-md px-1.5 py-1 text-left text-xs transition-colors
          {!trashMode && isActive(nodePatch) ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
      >
        <span class="block truncate">{node.name}</span>
      </button>
      <span class="text-muted-foreground ml-1 shrink-0 font-mono text-[10px]">{node.childCount}</span>
    </div>
    {#if expanded.has(node.id)}
      <div class="ml-3 border-l border-border/60 pl-1">
        {#each node.children as sub (keyOf(sub))}
          {@render nodes(sub, depth + 1, { supplier: nodePatch.supplier, family: depth >= 2 ? node.name : undefined })}
        {/each}
      </div>
    {/if}
  {:else}
    <button
      type="button"
      onclick={() => onopenstone(node.cell)}
      data-testid="stones-tree-leaf-{node.cell.resourceId}"
      class="text-muted-foreground hover:bg-accent/60 hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs transition-colors"
      title="{node.cell.name}（{node.cell.sku}）"
    >
      <span class="size-2 shrink-0 rounded-full border border-black/10" style="background: {node.cell.colorHex}" aria-hidden="true"></span>
      <span class="font-mono">{node.cell.sku}</span>
      <span class="ml-auto shrink-0 font-mono text-[10px] opacity-70">
        {node.cell.sizeMm !== null ? `${node.cell.sizeMm}mm` : '—'}
      </span>
    </button>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col" data-testid="stones-tree">
  <div class="flex flex-col gap-0.5 px-2 pt-2 pb-1">
    <button
      type="button"
      onclick={() => void clearStonesFilter()}
      data-testid="stones-tree-all"
      class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors
        {!trashMode && filter.supplier === undefined ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
    >
      <Layers class="size-4 shrink-0" aria-hidden="true" />
      <span class="flex-1 truncate">全部钻库</span>
      {#if tree?.node?.kind === 'dir'}
        <span class="font-mono text-[11px] opacity-70">{tree.node.childCount}</span>
      {/if}
    </button>
    <button
      type="button"
      onclick={() => void setStonesTrashMode(!trashMode)}
      data-testid="stones-tree-trash"
      class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors
        {trashMode ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
    >
      <Trash2 class="size-4 shrink-0" aria-hidden="true" />
      <span class="flex-1 truncate">回收站</span>
      {#if trashCount > 0}
        <span class="rounded-full bg-destructive/15 px-1.5 py-0.5 font-mono text-[11px] text-destructive" data-testid="stones-trash-count">
          {trashCount}
        </span>
      {/if}
    </button>
  </div>

  <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
    {#if tree === null || tree.node === null}
      <p class="text-muted-foreground px-2 py-6 text-center text-xs" data-testid="stones-tree-empty">
        {tree === null ? '目录树未加载' : '库空——经样卡导入向导或 stone.import 建库'}
      </p>
    {:else if tree.node.kind === 'dir'}
      {#each tree.node.children as child (keyOf(child))}
        {#if child.kind === 'dir'}
          {@const patch = dirPatch(1, child.name, {})}
          <div data-testid="stones-tree-dir-{child.name}">
            <div class="flex items-center">
              <button
                type="button"
                onclick={() => toggle(child.id)}
                aria-label={expanded.has(child.id) ? `折叠 ${child.name}` : `展开 ${child.name}`}
                class="text-muted-foreground hover:text-foreground -ml-1 rounded p-0.5"
                data-testid="stones-tree-toggle-{child.id}"
              >
                {#if expanded.has(child.id)}
                  <ChevronDown class="size-3.5" aria-hidden="true" />
                {:else}
                  <ChevronRight class="size-3.5" aria-hidden="true" />
                {/if}
              </button>
              <button
                type="button"
                onclick={() => void selectStonesTreeDir(patch)}
                data-testid="stones-tree-select-{child.name}"
                class="min-w-0 flex-1 rounded-md px-1.5 py-1 text-left text-sm transition-colors
                  {!trashMode && isActive(patch) ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/60'}"
              >
                <span class="block truncate">{child.name}</span>
              </button>
              <span class="text-muted-foreground ml-1 shrink-0 font-mono text-[11px]">{child.childCount}</span>
            </div>
            {#if expanded.has(child.id)}
              <div class="ml-3 border-l border-border/60 pl-1">
                {#each child.children as sub (keyOf(sub))}
                  {@render nodes(sub, 2, { supplier: patch.supplier })}
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <button
            type="button"
            onclick={() => onopenstone(child.cell)}
            data-testid="stones-tree-leaf-{child.cell.resourceId}"
            class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent/60"
          >
            <span class="size-2 shrink-0 rounded-full border border-black/10" style="background: {child.cell.colorHex}" aria-hidden="true"></span>
            <span class="font-mono">{child.cell.sku}</span>
          </button>
        {/if}
      {/each}
    {/if}
  </div>
</div>
