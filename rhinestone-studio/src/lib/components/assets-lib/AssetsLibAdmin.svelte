<!--
  AssetsLibAdmin.svelte——「我的材料 → 我的文件」子区（split-admin-portal 4.4，
  2026-09-29；restructure-materials-story W1：素材库→我的材料，废弃 IndexedDB
  迁移入口——老技术不进新故事，「从本浏览器导入」与 migrateToServer 依赖退役）。
  服务端素材树+网格的轻管理面（比照 AssetsView 的树+网格形态重做服务端数据源版
  ——AssetsView 本地 IDB 版零改动保留为迁移源）：浏览/重命名/移动/软删/恢复/
  清空回收站。
  数据面：adminApi().assetsLib.*（requireAuth 本人域；admin 全量+owner 过滤）；
  缩略走 /api/assets/{ref}/raw?w=600&token=（assetRawUrl 单源——w 缩放参数，
  daemon raw 面现为接受即忽略的预留位，服务端实装缩放后即刻生效）。
  预览 80% contains（W1 预览修复）：贴图渲染尺寸放大至预览卡容器的 80% 宽/高，
  object-contain 保比例——小源图放大充满、大图不裁切。
  状态机：加载/错误/操作 busy 锁（全生命周期——杜绝幽灵操作）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Select from '$lib/components/ui/select'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { adminApi, type AssetsLibNodeView } from '$lib/adminApi'
  import { assetRawUrl, retryRawImageOnError } from '$lib/agentApi/attachments'
  import { isAdmin } from '$lib/stores/session.svelte'
  import Folder from '@lucide/svelte/icons/folder'
  import House from '@lucide/svelte/icons/house'
  import Pencil from '@lucide/svelte/icons/pencil'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Undo2 from '@lucide/svelte/icons/undo-2'
  import MoveRight from '@lucide/svelte/icons/move-right'

  let nodes = $state<AssetsLibNodeView[]>([])
  let loading = $state(false)
  let loadError = $state<string | null>(null)
  /** 操作 busy 锁（重命名/移动/软删/恢复/清空共用——串行化管理操作）。 */
  let busy = $state(false)
  let opError = $state<string | null>(null)
  /** 回收站视图（true=呈现软删子树+清空入口）。 */
  let trashView = $state(false)
  /** 当前目录（null=根）。 */
  let currentFolder = $state<string | null>(null)
  /** admin 的 owner 过滤（空=全量；普通用户服务端恒收窄自己——本输入仅 admin 呈现）。 */
  let ownerFilter = $state('')
  const admin = $derived(isAdmin())

  // ---- 重命名 Dialog
  let renameTarget = $state<AssetsLibNodeView | null>(null)
  let renameValue = $state('')
  // ---- 移动 Dialog
  let moveTarget = $state<AssetsLibNodeView | null>(null)
  let moveParentId = $state<string>('')

  const nodeName = (id: string | null): string => {
    if (id === null) return '根'
    return nodes.find((node) => node.id === id)?.name ?? id
  }

  /** 文件夹树渲染行（深度缩进平铺——文件库目录量级小，免折叠态）。 */
  const folderRows = $derived.by(() => {
    const folders = nodes.filter((node) => node.isDir && (trashView ? node.softDeleted : !node.softDeleted))
    const childrenOf = new Map<string | null, AssetsLibNodeView[]>()
    for (const folder of folders) {
      const key = folder.parentId
      const list = childrenOf.get(key) ?? []
      list.push(folder)
      childrenOf.set(key, list)
    }
    const rows: Array<{ node: AssetsLibNodeView; depth: number }> = []
    const walk = (parent: string | null, depth: number): void => {
      for (const folder of childrenOf.get(parent) ?? []) {
        rows.push({ node: folder, depth })
        walk(folder.id, depth + 1)
      }
    }
    walk(null, 0)
    return rows
  })

  /** 当前目录图片（回收站视图=全部软删图片平铺）。 */
  const images = $derived(
    trashView
      ? nodes.filter((node) => !node.isDir && node.softDeleted)
      : nodes.filter((node) => !node.isDir && !node.softDeleted && node.parentId === currentFolder),
  )

  async function refresh(): Promise<void> {
    loading = true
    loadError = null
    try {
      const out = await adminApi().assetsLibTree({
        includeTrashed: true,
        ...(ownerFilter.trim() !== '' ? { owner: ownerFilter.trim() } : {}),
      })
      nodes = out.nodes
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void refresh()
  })

  async function commitRename(): Promise<void> {
    if (renameTarget === null) return
    const name = renameValue.trim()
    if (name === '') return
    busy = true
    opError = null
    try {
      await adminApi().assetsLibRename(renameTarget.id, name)
      renameTarget = null
      await refresh()
    } catch (error) {
      opError = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }

  async function commitMove(): Promise<void> {
    if (moveTarget === null) return
    busy = true
    opError = null
    try {
      await adminApi().assetsLibMove(moveTarget.id, moveParentId === '' ? null : moveParentId)
      moveTarget = null
      await refresh()
    } catch (error) {
      opError = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }

  async function softDelete(node: AssetsLibNodeView): Promise<void> {
    busy = true
    opError = null
    try {
      await adminApi().assetsLibSoftDelete(node.id)
      await refresh()
    } catch (error) {
      opError = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }

  async function restore(node: AssetsLibNodeView): Promise<void> {
    busy = true
    opError = null
    try {
      await adminApi().assetsLibRestore(node.id)
      await refresh()
    } catch (error) {
      opError = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }

  async function purgeTrash(): Promise<void> {
    busy = true
    opError = null
    try {
      await adminApi().assetsLibPurgeEmptyTrash()
      await refresh()
    } catch (error) {
      opError = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }

  /** 移动目标候选（排除自身与后代——服务端环检测的客户端前置）。 */
  function moveTargetsOf(node: AssetsLibNodeView): AssetsLibNodeView[] {
    const blocked = new Set<string>([node.id])
    let grew = true
    while (grew) {
      grew = false
      for (const candidate of nodes) {
        if (candidate.isDir && candidate.parentId !== null && blocked.has(candidate.parentId) && !blocked.has(candidate.id)) {
          blocked.add(candidate.id)
          grew = true
        }
      }
    }
    return nodes.filter((candidate) => candidate.isDir && !blocked.has(candidate.id))
  }
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="assets-lib-view">
  <!-- 工具行 -->
  <div class="bg-background/80 flex flex-wrap items-center gap-2 border-b px-3 py-2 backdrop-blur" data-testid="assets-lib-toolbar">
    <Button size="sm" class="h-8" disabled={loading || busy} onclick={() => void refresh()} data-testid="assets-lib-refresh" title="重载服务端素材树">
      <RefreshCw class="size-3.5" aria-hidden="true" />
      刷新
    </Button>
    {#if admin}
      <Input
        class="h-8 w-36 text-xs"
        placeholder="按用户名过滤（空=全量）"
        value={ownerFilter}
        onchange={(event) => {
          ownerFilter = event.currentTarget.value
          void refresh()
        }}
        data-testid="assets-lib-owner-filter"
      />
    {/if}
    <span class="flex-1"></span>
    <Button
      size="sm"
      variant="outline"
      class="h-8"
      onclick={() => {
        trashView = !trashView
        currentFolder = null
      }}
      data-testid="assets-lib-trash-toggle"
    >
      {trashView ? '返回浏览' : '回收站'}
    </Button>
    {#if trashView}
      <Button size="sm" variant="destructive" class="h-8" disabled={busy || images.length === 0} onclick={() => void purgeTrash()} data-testid="assets-lib-purge">
        清空回收站
      </Button>
    {/if}
  </div>

  {#if loadError !== null}
    <p class="border-destructive/30 bg-destructive/10 text-destructive px-3 py-1.5 text-xs" data-testid="assets-lib-error" role="alert">{loadError}</p>
  {:else if opError !== null}
    <p class="border-destructive/30 bg-destructive/10 text-destructive px-3 py-1.5 text-xs" data-testid="assets-lib-op-error" role="alert">{opError}</p>
  {/if}

  <div class="flex min-h-0 flex-1">
    <!-- 左：目录树 -->
    <aside class="bg-card hidden w-52 shrink-0 flex-col overflow-y-auto border-r p-2 md:flex" data-testid="assets-lib-tree">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors {!trashView && currentFolder === null
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
        onclick={() => {
          trashView = false
          currentFolder = null
        }}
        data-testid="assets-lib-tree-root"
      >
        <House class="size-3.5 shrink-0" aria-hidden="true" />
        全部素材
      </button>
      {#each folderRows as row (row.node.id)}
        <button
          type="button"
          class="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors {!trashView && currentFolder === row.node.id
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
          style="padding-left: {8 + row.depth * 14}px"
          onclick={() => {
            trashView = false
            currentFolder = row.node.id
          }}
          data-testid="assets-lib-tree-folder-{row.node.id}"
          title={row.node.owner}
        >
          <Folder class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{row.node.name}</span>
          {#if row.node.owner}
            <span class="text-muted-foreground shrink-0 text-[10px] opacity-70">{row.node.owner}</span>
          {/if}
        </button>
      {/each}
    </aside>

    <!-- 右：网格（移动端窄列自适应） -->
    <main class="bg-muted/30 min-h-0 flex-1 overflow-y-auto p-3" data-testid="assets-lib-grid">
      {#if loading}
        <p class="text-muted-foreground py-16 text-center text-sm" role="status">服务端素材加载中…</p>
      {:else if images.length === 0}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="assets-lib-empty">
          {trashView ? '回收站为空' : '当前目录暂无图片素材'}
        </p>
      {:else}
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {#each images as node (node.id)}
            <div
              class="bg-card flex flex-col gap-1.5 rounded-lg border p-2"
              data-testid="assets-lib-node-{node.id}"
            >
              <!-- 预览 80% contains（W1 预览修复）：容器 aspect-square 灰底，img 盒占
                   容器 80% 宽/高（flex 居中）+ object-contain 保比例——小源图放大
                   充满 80% 区、大图等比收缩不裁切；缩略 src 携带 w=600 缩放参数
                   （daemon raw 面预留位——实装缩放后 15MB 原图不进缩略格）。 -->
              <span class="bg-muted relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md">
                <img
                  src={assetRawUrl(node.blobHash ?? '', 600)}
                  alt={node.name}
                  loading="lazy"
                  decoding="async"
                  class="h-[80%] w-[80%] object-contain"
                  onerror={retryRawImageOnError}
                  data-testid="assets-lib-img-{node.id}"
                />
              </span>
              <div class="flex min-w-0 items-center gap-1">
                <span class="min-w-0 flex-1 truncate text-xs" title={node.name}>{node.name}</span>
                {#if node.width !== null && node.height !== null}
                  <Badge variant="secondary" class="shrink-0 text-[10px]">{node.width}×{node.height}</Badge>
                {/if}
              </div>
              <div class="text-muted-foreground flex items-center justify-between text-[10px]">
                <span class="truncate" title={node.owner}>{node.owner} · {Math.max(1, Math.round(node.bytes / 1024))}KB</span>
              </div>
              <div class="flex flex-wrap gap-1">
                {#if node.softDeleted}
                  <Button size="xs" variant="ghost" disabled={busy} onclick={() => void restore(node)} data-testid="assets-lib-restore-{node.id}">
                    <Undo2 class="size-3" aria-hidden="true" />
                    恢复
                  </Button>
                {:else}
                  <Button
                    size="xs"
                    variant="ghost"
                    onclick={() => {
                      renameTarget = node
                      renameValue = node.name
                    }}
                    data-testid="assets-lib-rename-{node.id}"
                  >
                    <Pencil class="size-3" aria-hidden="true" />
                    重命名
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onclick={() => {
                      moveTarget = node
                      moveParentId = node.parentId ?? ''
                    }}
                    data-testid="assets-lib-move-{node.id}"
                  >
                    <MoveRight class="size-3" aria-hidden="true" />
                    移动
                  </Button>
                  <Button size="xs" variant="ghost" class="text-destructive" disabled={busy} onclick={() => void softDelete(node)} data-testid="assets-lib-trash-{node.id}">
                    <Trash2 class="size-3" aria-hidden="true" />
                    软删
                  </Button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </main>
  </div>

  <footer class="bg-background text-muted-foreground flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs" data-testid="assets-lib-statusbar">
    <span>{trashView ? '回收站' : nodeName(currentFolder)} · {images.length} 项图片</span>
    <span class="ml-auto">服务端文件库（owner 隔离 · admin 全见）</span>
  </footer>
</div>

<!-- 重命名 Dialog -->
<Dialog.Root
  open={renameTarget !== null}
  onOpenChange={(open) => {
    if (!open) renameTarget = null
  }}
>
  <Dialog.Content class="max-w-sm p-5" data-testid="assets-lib-rename-dialog">
    <Dialog.Title class="text-sm font-medium">重命名 · {renameTarget?.name ?? ''}</Dialog.Title>
    <div class="mt-3 flex flex-col gap-2">
      <Input bind:value={renameValue} class="h-8 text-xs" data-testid="assets-lib-rename-input" />
      {#if opError}
        <p class="text-destructive text-xs" role="alert">{opError}</p>
      {/if}
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (renameTarget = null)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void commitRename()} data-testid="assets-lib-rename-submit">确认</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 移动 Dialog（目标目录下拉——自身/后代已排除） -->
<Dialog.Root
  open={moveTarget !== null}
  onOpenChange={(open) => {
    if (!open) moveTarget = null
  }}
>
  <Dialog.Content class="max-w-sm p-5" data-testid="assets-lib-move-dialog">
    <Dialog.Title class="text-sm font-medium">移动 · {moveTarget?.name ?? ''}</Dialog.Title>
    <div class="mt-3 flex flex-col gap-2">
      <Select.Root
        type="single"
        value={moveParentId}
        onValueChange={(value) => (moveParentId = value)}
      >
        <Select.Trigger class="h-8 w-full text-xs" data-testid="assets-lib-move-select">
          {moveParentId === '' ? '根目录' : nodeName(moveParentId)}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="" data-testid="assets-lib-move-option-root">根目录</Select.Item>
          {#each moveTarget !== null ? moveTargetsOf(moveTarget) : [] as folder (folder.id)}
            <Select.Item value={folder.id}>{folder.name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if opError}
        <p class="text-destructive text-xs" role="alert">{opError}</p>
      {/if}
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (moveTarget = null)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void commitMove()} data-testid="assets-lib-move-submit">确认</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
