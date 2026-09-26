<!--
WorkbenchLayerPanel.svelte — 图层管理左面板（add-task-detail-layer-workbench 2.2/2.3；
add-workbench-pro 2.1/2.2+2c 增量）。
StrategyLayerTree 的可编辑版：显隐/选中/inline 重命名（layer.rename RPC）+
拆分层（提示输入→layer.split→子层入树+自动选中新子层）+蒙版可视化开关（画布叠加
半透明——选中层高亮填充）+24×24 蒙版缩略图（inline|blob 两态位面缓存）+
折叠/锁定（服务端视图态写透 view.state.set）+mask 编辑留痕徽标（ready/stale/
error/incomplete——导出门阻断面）。层级徽标/参数摘要沿策略设计器同式。
[2c 图层管理 P0] 拖拽重排（pointer 三落区 before/after/inside——layer.reorder；
Alt+↑↓ 键盘等价）+行内删除（确认面——layer.delete；根/锁定预判）+事务历史区
（tree.history 版本链+tree.revert 回退入口——W10 复核补齐）+F2 触发 inline 重命名
+undo 焦点域接线（图层树=tree-structure）。a11y：role=tree/treeitem+aria-level。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { summarizeParams } from '$lib/strategyDesigner/paramsSchema'
  import {
    cancelPendingDelete,
    getMaskEditOf,
    getPendingDelete,
    getRenameError,
    getRenameRequestId,
    getSelectedNodeId,
    getShowMasks,
    getSplitError,
    getTreeHistoryState,
    getWorkbenchLayerRows,
    getNodeOf,
    getWorkbenchNodes,
    isNodeCollapsed,
    isNodeLocked,
    isNodeVisible,
    isSplitting,
    isViewSyncing,
    confirmDeleteLayer,
    confirmTreeRevert,
    cancelPendingTreeRevert,
    getPendingTreeRevert,
    reorderLayerNode,
    renameLayer,
    requestDeleteLayer,
    requestTreeRevert,
    selectNode,
    setShowMasks,
    splitLayer,
    toggleNodeCollapsed,
    toggleNodeLocked,
    toggleNodeVisible,
    toggleTreeHistoryPanel,
    type WorkbenchLayerRow,
  } from './store.svelte'
  import { buildReorderPayload, type DropZone } from './layerTree.js'
  import { setUndoFocusDomain } from './undoDomains.svelte.js'
  import LayerMaskThumb from './LayerMaskThumb.svelte'
  import Ban from '@lucide/svelte/icons/ban'
  import Check from '@lucide/svelte/icons/check'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import GripVertical from '@lucide/svelte/icons/grip-vertical'
  import History from '@lucide/svelte/icons/history'
  import Lock from '@lucide/svelte/icons/lock'
  import LockOpen from '@lucide/svelte/icons/lock-open'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Scissors from '@lucide/svelte/icons/scissors'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import Undo2 from '@lucide/svelte/icons/undo-2'
  import X from '@lucide/svelte/icons/x'

  const rows = $derived(getWorkbenchLayerRows())
  const selectedId = $derived(getSelectedNodeId())
  const selectedNode = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const splitting = $derived(isSplitting())
  const splitError = $derived(getSplitError())
  const showMasks = $derived(getShowMasks())
  const viewSyncing = $derived(isViewSyncing())
  const treeHistory = $derived(getTreeHistoryState())
  const pendingDelete = $derived(getPendingDelete())
  const pendingTreeRevert = $derived(getPendingTreeRevert())

  // ---- inline 重命名（Enter 提交 / Esc 取消；失败驻留错误供重试；F2=命令总线触发） ----
  let renamingId = $state<string | null>(null)
  let renameText = $state('')
  let renameInput = $state<HTMLInputElement | null>(null)

  // 进入编辑态聚焦（a11y：编程聚焦替代 autofocus 属性）
  $effect(() => {
    if (renamingId !== null) renameInput?.focus()
  })

  // F2 触发（命令总线 requestRenameSelected→计数值变化——inline 编辑选中层）
  $effect(() => {
    if (getRenameRequestId() === 0) return
    if (selectedId === null) return
    renamingId = selectedId
    renameText = getNodeOf(selectedId)?.objectName ?? ''
  })

  function beginRename(row: WorkbenchLayerRow): void {
    renamingId = row.node.id
    renameText = row.node.objectName
  }

  function cancelRename(): void {
    renamingId = null
  }

  async function commitRename(): Promise<void> {
    const target = renamingId
    const next = renameText.trim()
    if (target === null || next === '') return
    const ok = await renameLayer(target, next)
    if (ok) renamingId = null
  }

  // ---- 拆分层（提示输入→layer.split；重试=同参再调） ----
  let splitHint = $state('')

  async function doSplit(): Promise<void> {
    const target = selectedId
    const hint = splitHint.trim()
    if (target === null || hint === '') return
    const ok = await splitLayer(target, hint)
    if (ok) splitHint = ''
  }

  // ---- 拖拽重排（pointer 三落区：上 30%=before / 下 30%=after / 中 40%=inside 子层） ----
  let dragState = $state<{ nodeId: string; overRowId: string | null; zone: DropZone | null } | null>(null)

  function onDragHandleDown(event: PointerEvent, row: WorkbenchLayerRow): void {
    if (event.button !== 0) return
    dragState = { nodeId: row.node.id, overRowId: null, zone: null }
    const handle = event.currentTarget as HTMLElement
    try {
      handle.setPointerCapture?.(event.pointerId)
    } catch {
      // jsdom 无 pointer capture——pointerup 由测试直驱
    }
    event.preventDefault()
  }

  function onDragHandleMove(event: PointerEvent): void {
    if (dragState === null) return
    const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>('[data-node-id]')
    const overRowId = target?.getAttribute('data-node-id') ?? null
    if (overRowId === null || overRowId === dragState.nodeId) {
      dragState = { ...dragState, overRowId: null, zone: null }
      return
    }
    const rect = target!.getBoundingClientRect()
    const rel = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
    const zone: DropZone = rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'inside'
    dragState = { ...dragState, overRowId, zone }
  }

  async function onDragHandleUp(): Promise<void> {
    const state = dragState
    dragState = null
    if (state === null || state.overRowId === null || state.zone === null) return
    const payload = buildReorderPayload(getWorkbenchNodes(), {
      nodeId: state.nodeId,
      targetId: state.overRowId,
      zone: state.zone,
    })
    if (payload === null) return // 根/环路/落根序位——预判已在 build 内拒（toast 由 reorder 面统一）
    await reorderLayerNode(state.nodeId, payload)
  }

  function dropIndicator(nodeId: string): string {
    if (dragState?.overRowId !== nodeId || dragState.zone === null) return ''
    if (dragState.zone === 'inside') return 'ring-primary/70 bg-primary/10 ring-2'
    return dragState.zone === 'before' ? 'border-t-primary border-t-2' : 'border-b-primary border-b-2'
  }

  /** 落区文案（拖拽中行尾提示——inside=「移入」）。 */
  function zoneLabel(nodeId: string): string {
    if (dragState?.overRowId !== nodeId || dragState.zone === null) return ''
    return dragState.zone === 'inside' ? '↳ 移入' : dragState.zone === 'before' ? '↑ 之前' : '↓ 之后'
  }

  function kindBadgeVariant(assignment: WorkbenchLayerRow['assignment']): 'default' | 'secondary' | 'outline' | 'destructive' {
    if (assignment === null) return 'outline'
    if (assignment.strategyKind === 'exclusion') return 'destructive'
    return 'secondary'
  }

  /** mask 编辑留痕徽标（2.2/2.3：incomplete=行程 4096 超限禁导出；stale/error=编辑结果不可信）。 */
  function maskEditBadge(row: WorkbenchLayerRow): { text: string; title: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' } | null {
    const edit = getMaskEditOf(row.node.id)
    if (edit === null) return null
    if (edit.incomplete) {
      return { text: '4096', title: `蒙版行程超限（${edit.runCount} 段>4096——如实落盘但禁止导出，继续编辑收敛回限内）`, variant: 'destructive' }
    }
    if (edit.state === 'stale') {
      return { text: '已漂移', title: '编辑后基线漂移（stale）——重算结果对新树不再保证一致，重算后再导出', variant: 'destructive' }
    }
    if (edit.state === 'error') {
      return { text: '重算失败', title: `重算失败（可重试）：${edit.error ?? ''}`, variant: 'destructive' }
    }
    if (edit.state === 'ready') {
      return { text: '已编辑', title: `笔刷编辑已重算（行程 ${edit.runCount} 段）`, variant: 'secondary' }
    }
    return null
  }
</script>

<!-- 焦点域接线（图层树=tree-structure——Ctrl+Z 路由面） -->
<div
  class="flex h-full min-h-0 flex-col"
  data-testid="workbench-layer-panel"
  role="tree"
  aria-label="图层树"
  onfocusin={() => setUndoFocusDomain('tree-structure')}
>
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">图层管理</span>
    <span class="text-muted-foreground font-mono text-[10px]">{rows.length} 节点</span>
    {#if viewSyncing}
      <span class="text-muted-foreground/70 animate-pulse text-[10px]" data-testid="workbench-view-syncing">同步中…</span>
    {/if}
    <label class="text-muted-foreground ml-auto flex items-center gap-1 text-[10px]" title="画布叠加各层掩膜（半透明——选中层高亮填充；inline|blob 两态）">
      <input
        type="checkbox"
        checked={showMasks}
        onchange={(event) => setShowMasks(event.currentTarget.checked)}
        class="accent-primary size-3"
        data-testid="workbench-mask-toggle"
      />
      蒙版
    </label>
  </div>

  <!-- 拆分层（2.3 人类抠图：选中层+文本提示→SAM 单步细分） -->
  <div class="space-y-1.5 border-b p-2.5" data-testid="workbench-split-box">
    <div class="flex items-center gap-1.5 text-xs font-medium">
      <Scissors class="size-3.5" aria-hidden="true" />
      拆分图层
    </div>
    {#if selectedNode !== null}
      <p class="text-muted-foreground truncate text-[11px]">
        目标层：<span class="text-foreground font-medium">{selectedNode.objectName}</span>
      </p>
      <input
        type="text"
        bind:value={splitHint}
        placeholder="如：把帽子拆出来"
        disabled={splitting}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void doSplit()
          }
        }}
        class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
        data-testid="workbench-split-hint"
        aria-label="拆分提示"
      />
      <Button size="sm" class="w-full" disabled={splitting || splitHint.trim() === ''} onclick={() => void doSplit()} data-testid="workbench-split-apply">
        {splitting ? '细分中…（真跑约 1-2 分钟）' : '拆分图层'}
      </Button>
      {#if splitError !== null}
        <div class="text-destructive space-y-1 text-[11px]" data-testid="workbench-split-error" role="alert">
          <p class="leading-relaxed">拆分失败：{splitError}</p>
          <button
            type="button"
            onclick={() => void doSplit()}
            class="border-destructive/40 hover:bg-destructive/10 rounded border px-2 py-0.5 font-medium transition-colors"
            data-testid="workbench-split-retry"
          >
            重试
          </button>
        </div>
      {/if}
    {:else}
      <p class="text-muted-foreground text-[11px] leading-relaxed" data-testid="workbench-split-idle">
        在下方图层树选择一个图层，输入提示（如「把帽子拆出来」）即可单步细分出子层
      </p>
    {/if}
  </div>

  <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1.5">
    {#if rows.length === 0}
      <p class="text-muted-foreground px-2 py-6 text-center text-xs" data-testid="workbench-layer-empty">
        该任务尚无图层树——先在 Agent 会话完成识图抠图
      </p>
    {/if}
    {#each rows as row (row.node.id)}
      <div
        class="group rounded-md px-1 py-1 transition-colors {row.node.id === selectedId ? 'bg-accent' : 'hover:bg-accent/50'} {dropIndicator(row.node.id)}"
        data-testid="workbench-layer-row"
        data-node-id={row.node.id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={row.node.id === selectedId}
        aria-expanded={row.node.children.length > 0 ? !isNodeCollapsed(row.node.id) : undefined}
        style="padding-left: {4 + row.depth * 12}px"
      >
        <div class="flex items-center gap-1.5">
          {#if renamingId === row.node.id}
            <!-- inline 重命名（2.2）：Enter 提交→layer.rename；Esc 取消 -->
            <input
              type="text"
              bind:value={renameText}
              bind:this={renameInput}
              onkeydown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename()
                }
              }}
              class="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2"
              data-testid="workbench-rename-input"
              aria-label="重命名图层"
            />
            <button
              type="button"
              onclick={() => void commitRename()}
              class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
              data-testid="workbench-rename-commit"
              aria-label="确认重命名"
              title="确认重命名"
            >
              <Check class="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onclick={cancelRename}
              class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
              data-testid="workbench-rename-cancel"
              aria-label="取消重命名"
              title="取消"
            >
              <X class="size-3.5" aria-hidden="true" />
            </button>
          {:else}
            {#if row.node.children.length > 0}
              <button
                type="button"
                onclick={() => toggleNodeCollapsed(row.node.id)}
                class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
                data-testid="workbench-layer-collapse-{row.node.id}"
                aria-label={isNodeCollapsed(row.node.id) ? `展开 ${row.node.objectName}` : `折叠 ${row.node.objectName}`}
                aria-expanded={!isNodeCollapsed(row.node.id)}
                title={isNodeCollapsed(row.node.id) ? '展开子层' : '折叠子层'}
              >
                {#if isNodeCollapsed(row.node.id)}
                  <ChevronRight class="size-3.5" aria-hidden="true" />
                {:else}
                  <ChevronDown class="size-3.5" aria-hidden="true" />
                {/if}
              </button>
            {:else}
              <span class="inline-block size-3.5 shrink-0"></span>
            {/if}
            <!-- 拖拽重排手柄（2c——pointer 三落区；根不可移；键盘等价 Alt+↑↓） -->
            {#if row.node.parent !== null}
              <button
                type="button"
                class="text-muted-foreground/50 hover:text-foreground shrink-0 cursor-grab rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
                onpointerdown={(event) => onDragHandleDown(event, row)}
                onpointermove={onDragHandleMove}
                onpointerup={() => void onDragHandleUp()}
                onpointercancel={() => (dragState = null)}
                data-testid="workbench-layer-drag-{row.node.id}"
                aria-label="拖拽重排 {row.node.objectName}（键盘等价 Alt+↑↓）"
                title="拖拽到目标层：上沿=排其前 / 下沿=排其后 / 中部=移入其内"
              >
                <GripVertical class="size-3" aria-hidden="true" />
              </button>
            {:else}
              <span class="inline-block size-3.5 shrink-0"></span>
            {/if}
            <!-- 24×24 蒙版缩略图（2.2 Owner 核心质疑——行级遮罩可见性） -->
            <LayerMaskThumb nodeId={row.node.id} />
            <button
              type="button"
              onclick={() => selectNode(row.node.id === selectedId ? null : row.node.id)}
              class="min-w-0 flex-1 truncate text-left text-xs font-medium {row.node.id === selectedId ? 'text-accent-foreground' : ''}"
              data-testid="workbench-layer-select-{row.node.id}"
              aria-pressed={row.node.id === selectedId}
              title="{row.node.objectName}（{row.node.category}·{row.node.effectiveMm.toFixed(1)}mm）"
            >
              {row.node.objectName}
            </button>
            {#if zoneLabel(row.node.id) !== ''}
              <span class="text-primary shrink-0 text-[10px] font-medium" data-testid="workbench-drop-zone-label">
                {zoneLabel(row.node.id)}
              </span>
            {/if}
            {#if maskEditBadge(row) !== null}
              {@const badge = maskEditBadge(row)}
              <Badge variant={badge!.variant} class="shrink-0 px-1.5 text-[10px]" data-testid="workbench-mask-edit-{row.node.id}" title={badge!.title}>
                {#if badge!.variant === 'destructive'}
                  <TriangleAlert class="size-2.5" aria-hidden="true" />
                {/if}
                {badge!.text}
              </Badge>
            {/if}
            <button
              type="button"
              onclick={() => beginRename(row)}
              class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              data-testid="workbench-layer-rename-{row.node.id}"
              aria-label="重命名 {row.node.objectName}"
              title="重命名"
            >
              <Pencil class="size-3" aria-hidden="true" />
            </button>
            {#if !row.node.drillWorthy}
              <Ban class="text-destructive size-3 shrink-0" aria-hidden="true" data-testid="workbench-layer-excluded-{row.node.id}" title="不值得贴（drillWorthy=false）" />
            {/if}
            <Badge variant={kindBadgeVariant(row.assignment)} class="shrink-0 px-1.5 text-[10px]" data-testid="workbench-layer-kind-{row.node.id}">
              {row.assignment === null ? (row.node.children.length > 0 ? '层级' : '未指派') : row.assignment.strategyKind}
            </Badge>
            <button
              type="button"
              onclick={() => toggleNodeLocked(row.node.id)}
              class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
              data-testid="workbench-layer-lock-{row.node.id}"
              aria-label={isNodeLocked(row.node.id) ? `解锁 ${row.node.objectName}` : `锁定 ${row.node.objectName}`}
              aria-pressed={isNodeLocked(row.node.id)}
              title={isNodeLocked(row.node.id) ? '已锁定（遮罩+结构面冻结）——点击解锁' : '锁定（遮罩+结构面冻结）'}
            >
              {#if isNodeLocked(row.node.id)}
                <Lock class="text-amber-600 size-3.5" aria-hidden="true" />
              {:else}
                <LockOpen class="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
              {/if}
            </button>
            <button
              type="button"
              onclick={() => toggleNodeVisible(row.node.id)}
              class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
              data-testid="workbench-layer-visible-{row.node.id}"
              aria-label={isNodeVisible(row.node.id) ? `隐藏 ${row.node.objectName}` : `显示 ${row.node.objectName}`}
              aria-pressed={isNodeVisible(row.node.id)}
              title={isNodeVisible(row.node.id) ? '点击隐藏该层' : '点击显示该层'}
            >
              {#if isNodeVisible(row.node.id)}
                <Eye class="size-3.5" aria-hidden="true" />
              {:else}
                <EyeOff class="size-3.5 opacity-50" aria-hidden="true" />
              {/if}
            </button>
            <!-- 行内删除（2c——layer.delete；根不可删；Delete 键同源命令总线） -->
            {#if row.node.parent !== null}
              <button
                type="button"
                onclick={() => requestDeleteLayer(row.node.id)}
                class="text-muted-foreground hover:text-destructive shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                data-testid="workbench-layer-delete-{row.node.id}"
                aria-label="删除 {row.node.objectName}（含子层）"
                title="删除该层及其子树（确认后执行——Delete 键同源）"
              >
                <Trash2 class="size-3" aria-hidden="true" />
              </button>
            {/if}
          {/if}
        </div>
        {#if row.assignment !== null && renamingId !== row.node.id}
          <p class="text-muted-foreground truncate pl-1 font-mono text-[10px]" data-testid="workbench-layer-params-{row.node.id}" title={summarizeParams(row.assignment.strategyKind, row.assignment.params)}>
            {summarizeParams(row.assignment.strategyKind, row.assignment.params)}{row.assignment.strategyKind === 'exclusion' ? '' : ` · ${row.assignment.densityPerCm2}/cm²`}
          </p>
        {/if}
      </div>
    {/each}
  </div>

  {#if getRenameError() !== null}
    <div class="text-destructive border-t px-3 py-1.5 text-[11px]" data-testid="workbench-rename-error" role="alert">
      重命名失败：{getRenameError()}
    </div>
  {/if}

  <!-- 事务历史区（2c——tree.history 版本链+tree.revert 回退入口；W10 复核补齐的前端 API） -->
  <div class="shrink-0 border-t" data-testid="workbench-tree-history">
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px]"
      onclick={toggleTreeHistoryPanel}
      aria-expanded={treeHistory.open}
      data-testid="workbench-tree-history-toggle"
    >
      {#if treeHistory.open}
        <ChevronDown class="size-3" aria-hidden="true" />
      {:else}
        <ChevronRight class="size-3" aria-hidden="true" />
      {/if}
      <History class="size-3" aria-hidden="true" />
      事务历史
    </button>
    {#if treeHistory.open}
      <div class="scrollbar-thin max-h-40 overflow-y-auto px-2 pb-2" data-testid="workbench-tree-history-body">
        {#if treeHistory.loading}
          <p class="text-muted-foreground animate-pulse px-1 py-2 text-[11px]" data-testid="workbench-tree-history-loading">版本链读取中…</p>
        {:else if treeHistory.error !== null}
          <p class="text-destructive px-1 py-2 text-[11px]" role="alert" data-testid="workbench-tree-history-error">{treeHistory.error}</p>
        {:else if treeHistory.versions.length === 0}
          <p class="text-muted-foreground px-1 py-2 text-[11px]" data-testid="workbench-tree-history-empty">尚无版本——首次拆层/重命名/重排/删除/笔刷编辑后入史</p>
        {:else}
          {#each [...treeHistory.versions].reverse() as version (version.version)}
            <div
              class="flex items-center gap-1.5 rounded px-1 py-1 text-[10px]"
              data-testid="workbench-tree-history-row"
              data-version={version.version}
            >
              <span class="text-muted-foreground w-8 shrink-0 font-mono">v{version.version}</span>
              <Badge variant={version.cause === 'mask-patch' ? 'outline' : 'secondary'} class="shrink-0 px-1 text-[9px]">
                {version.cause}
              </Badge>
              <span class="text-muted-foreground min-w-0 flex-1 truncate" title={version.detail ?? ''}>{version.detail ?? '—'}</span>
              {#if version.version !== treeHistory.versions[treeHistory.versions.length - 1]?.version}
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 transition-colors"
                  onclick={() => void requestTreeRevert(version.version)}
                  data-testid="workbench-tree-revert-{version.version}"
                  aria-label="回退到 v{version.version}"
                  title="整树回退到该版本（tree.revert——后续版本一并回退，确认后执行）"
                >
                  <Undo2 class="size-2.5" aria-hidden="true" />
                  回退
                </button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  <!-- 删除确认面（破坏性=确认——全局纪律；count=子树节点数） -->
  {#if pendingDelete !== null}
    {@const deleteTarget = getNodeOf(pendingDelete.nodeId)}
    <div class="bg-background border-t p-2.5" data-testid="workbench-delete-confirm" role="alertdialog" aria-label="确认删除图层">
      <p class="text-xs leading-relaxed">
        删除「{deleteTarget?.objectName ?? pendingDelete.nodeId}」及其子层（共 {pendingDelete.count} 节点）？
        <span class="text-muted-foreground block text-[10px]">被删层上的指派随产块节点集收敛移除，存量方案将重算。</span>
      </p>
      <div class="mt-2 flex gap-1.5">
        <Button size="sm" variant="destructive" class="h-6 px-2 text-[11px]" onclick={() => void confirmDeleteLayer()} data-testid="workbench-delete-confirm-ok">
          <Trash2 class="size-3" aria-hidden="true" />
          确认删除
        </Button>
        <Button size="sm" variant="outline" class="h-6 px-2 text-[11px]" onclick={cancelPendingDelete} data-testid="workbench-delete-confirm-cancel">
          取消
        </Button>
      </div>
    </div>
  {/if}

  <!-- 整树回退确认面（D-3 透明化——结构域回退将一并回退 target 之后的全部中间操作） -->
  {#if pendingTreeRevert !== null}
    <div class="bg-background border-t p-2.5" data-testid="workbench-revert-confirm" role="alertdialog" aria-label="确认整树回退">
      <p class="text-xs leading-relaxed">
        回退到 v{pendingTreeRevert.targetVersion}？
        {#if pendingTreeRevert.entries.length > 0}
          <span class="text-destructive block text-[10px]">
            将一并回退 {pendingTreeRevert.entries.length} 个后续版本（含遮罩/重排交错——
            {pendingTreeRevert.entries.map((entry) => `v${entry.version} ${entry.cause}`).join('、')}）
          </span>
        {:else}
          <span class="text-muted-foreground block text-[10px]">该版本之后无其他操作。</span>
        {/if}
      </p>
      <div class="mt-2 flex gap-1.5">
        <Button size="sm" class="h-6 px-2 text-[11px]" onclick={() => void confirmTreeRevert()} data-testid="workbench-revert-confirm-ok">
          <Undo2 class="size-3" aria-hidden="true" />
          确认回退
        </Button>
        <Button size="sm" variant="outline" class="h-6 px-2 text-[11px]" onclick={cancelPendingTreeRevert} data-testid="workbench-revert-confirm-cancel">
          取消
        </Button>
      </div>
    </div>
  {/if}
</div>
