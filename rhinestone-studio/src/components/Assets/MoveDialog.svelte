<!--
Orthogonal intents (max 2):
1. [2026-09-19 Op] 「移动到…」目标选择：根目录/用户目录/可整理系统目录（sys-cases 只读、
   sys-trash 禁止）；环检测 UI 禁用 + tooltip（store 层双保险）。
2. [2026-09-19 Batch] 批量移动（多选/单条共用）：确认后 moveOp 并回报 N 项。
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import * as library from '$lib/assets/library.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import Folder from '@lucide/svelte/icons/folder'
  import House from '@lucide/svelte/icons/house'
  import Lock from '@lucide/svelte/icons/lock'
  import Trash from '@lucide/svelte/icons/trash'

  let {
    open = $bindable(false),
    ids = $bindable<string[]>([]),
    ondone,
  }: {
    open?: boolean
    ids?: string[]
    ondone?: () => void
  } = $props()

  let target = $state<string | null>(null)
  let moving = $state(false)

  const nodes = $derived(library.getNodes())
  const movingCount = $derived(ids.length)

  /** 目标候选：根 + 全部文件夹（排除 sys-cases 只读 / sys-trash 非移动目标）。 */
  const folderTargets = $derived(
    nodes
      .filter(
        (n): n is Extract<typeof n, { type: 'folder' }> =>
          n.type === 'folder' && n.system !== 'sys-cases' && n.system !== 'sys-trash',
      )
      .sort((a, b) => (a.system !== undefined ? -1 : b.system !== undefined ? 1 : a.name.localeCompare(b.name, 'zh-Hans-CN'))),
  )

  // 移动集子代（含自身）：目标为其中之一即环，禁用 + tooltip。
  const forbidden = $derived(new Set(ids.flatMap((id) => descendantIdsOf(id))))

  function descendantIdsOf(rootId: string): string[] {
    const result: string[] = [rootId]
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const child of nodes.filter((n) => n.parentId === current)) {
        if (!result.includes(child.id)) {
          result.push(child.id)
          if (child.type === 'folder') queue.push(child.id)
        }
      }
    }
    return result
  }

  function disabledReason(folderId: string | null): string | null {
    if (folderId === null) return null
    if (folderId === 'sys-cases') return '内置案例为只读目录'
    if (folderId === 'sys-trash') return '回收站不是移动目标——删除请用「移入回收站」'
    if (forbidden.has(folderId)) return '不能移动到自身或其后代'
    return null
  }

  function depthOf(folderId: string): number {
    return library.pathOf(folderId).length - 1
  }

  async function confirmMove(): Promise<void> {
    if (moving) return
    moving = true
    try {
      const moved = await library.moveOp(ids, target)
      if (moved > 0) showToast(`已移动 ${moved} 项`)
      open = false
      ids = []
      ondone?.()
    } finally {
      moving = false
    }
  }

  $effect(() => {
    if (open) target = null
  })
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title>移动 {movingCount} 项</Dialog.Title>
      <Dialog.Description>选择目标文件夹；移动只改变位置，不影响引用。</Dialog.Description>
    </Dialog.Header>

    <div class="max-h-72 overflow-y-auto rounded-lg border p-1" data-testid="move-targets">
      <button
        type="button"
        class="hover:bg-muted flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm {target === null
          ? 'bg-primary/10 text-primary font-medium'
          : ''}"
        onclick={() => (target = null)}
        data-testid="move-target-root"
      >
        <House class="size-4" aria-hidden="true" />
        根目录
      </button>
      {#each folderTargets as folder (folder.id)}
        {@const reason = disabledReason(folder.id)}
        <button
          type="button"
          class="hover:bg-muted flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm {target === folder.id
            ? 'bg-primary/10 text-primary font-medium'
            : ''} {reason ? 'text-muted-foreground/60 cursor-not-allowed hover:bg-transparent' : ''}"
          style="padding-left: {0.5 + depthOf(folder.id) * 0.75}rem"
          disabled={reason !== null}
          title={reason ?? undefined}
          data-testid={`move-target-${folder.id}`}
          onclick={() => (target = folder.id)}
        >
          {#if folder.system === 'sys-cases'}
            <Lock class="size-4 shrink-0" aria-hidden="true" />
          {:else if folder.system === 'sys-trash'}
            <Trash class="size-4 shrink-0" aria-hidden="true" />
          {:else}
            <Folder class="size-4 shrink-0" aria-hidden="true" />
          {/if}
          <span class="min-w-0 flex-1 truncate">{folder.name}</span>
          {#if reason}
            <span class="text-[10px] whitespace-nowrap">{folder.system ? '不可选' : '后代'}</span>
          {/if}
        </button>
      {/each}
    </div>

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={() => (open = false)}>取消</Button>
      <Button size="sm" onclick={() => void confirmMove()} disabled={moving}>移动</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
