<!--
WorkbenchLayerPanel.svelte — 图层管理左面板（add-task-detail-layer-workbench 2.2/2.3；
add-workbench-pro 2.1/2.2+2c；v3 Owner 整改=PS 式精简）。
行=掩码缩略图（24×24）+图层名+眼睛/锁定图标（hover 显重命名/删除/拖柄）——参数串/
密度/策略徽标堆叠全数移入右侧 WorkbenchInspector（信息过杂根因整改）；行 hover
title=关键摘要 tooltip。保留：树形缩进/折叠（服务端视图态）、拖拽重排（三落区+
Alt+↑↓ 键盘等价）、行内删除（确认面）、inline 重命名（F2）、拆分层（底部——
PS 图层操作位）。a11y（Codex 复评建议四）：role=tree/treeitem+aria-level+roving
focus（容器单焦点+方向键移动/展开收起+aria-activedescendant；Enter/Space 选中；
Alt+方向/输入框/IME 保护）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { summarizeParams } from '$lib/strategyDesigner/paramsSchema'
  import { isEditableTarget, isImeComposing } from '$lib/canvaskit.js'
  import {
    cancelPendingDelete,
    getAssignmentOf,
    getMaskEditOf,
    getPendingDelete,
    getRenameError,
    getRenameRequestId,
    getSelectedNodeId,
    getShowMasks,
    getSplitError,
    getWorkbenchLayerRows,
    getNodeOf,
    getWorkbenchNodes,
    isNodeCollapsed,
    isNodeLocked,
    isNodeVisible,
    isSplitting,
    isViewSyncing,
    confirmDeleteLayer,
    reorderLayerNode,
    renameLayer,
    requestDeleteLayer,
    selectNode,
    setShowMasks,
    splitLayer,
    toggleNodeCollapsed,
    toggleNodeLocked,
    toggleNodeVisible,
    type WorkbenchLayerRow,
  } from './store.svelte'
  import { buildReorderPayload, type DropZone } from './layerTree.js'
  import { setUndoFocusDomain } from './undoDomains.svelte.js'
  import LayerMaskThumb from './LayerMaskThumb.svelte'
  import Check from '@lucide/svelte/icons/check'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import GripVertical from '@lucide/svelte/icons/grip-vertical'
  import Lock from '@lucide/svelte/icons/lock'
  import LockOpen from '@lucide/svelte/icons/lock-open'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Scissors from '@lucide/svelte/icons/scissors'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import X from '@lucide/svelte/icons/x'

  const rows = $derived(getWorkbenchLayerRows())
  const selectedId = $derived(getSelectedNodeId())
  const selectedNode = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const splitting = $derived(isSplitting())
  const splitError = $derived(getSplitError())
  const showMasks = $derived(getShowMasks())
  const viewSyncing = $derived(isViewSyncing())
  const pendingDelete = $derived(getPendingDelete())

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

  /**
   * 行 hover 关键摘要（v3：行内参数串/徽标堆叠移除——摘要收进 tooltip，
   * 细节全在右侧属性面板）。
   */
  function rowTooltip(row: WorkbenchLayerRow): string {
    const parts = [
      `${row.node.objectName}（${row.node.category}）`,
      `${row.node.bbox.w}×${row.node.bbox.h} px · 有效粒径 ${row.node.effectiveMm.toFixed(1)} mm`,
      row.node.drillWorthy ? '值得贴' : '不值得贴（drillWorthy=false）',
    ]
    const assignment = getAssignmentOf(row.node.id)
    if (assignment !== null) {
      parts.push(
        `策略：${assignment.strategyKind}${assignment.strategyKind === 'exclusion' ? '' : ` · 密度 ${assignment.densityPerCm2}/cm²`}`,
      )
      if (assignment.stones.length > 0) {
        parts.push(`用钻：${assignment.stones.map((stone) => `${stone.sku}${stone.sizeMm !== null ? `(${stone.sizeMm}mm)` : ''}`).join('、')}`)
      }
      parts.push(`参数：${summarizeParams(assignment.strategyKind, assignment.params) || '—'}`)
    } else {
      parts.push('策略：未指派')
    }
    const edit = getMaskEditOf(row.node.id)
    if (edit !== null) {
      parts.push(`掩码编辑：${edit.state}${edit.incomplete ? '（行程超限禁导出）' : `（行程 ${edit.runCount} 段）`}`)
    }
    return parts.join('\n')
  }

  /**
   * 行级掩码编辑告警徽标（v3 精简：仅阻断态在行上出现——stale/error/incomplete；
   * ready 等非阻断态与「重算/放弃」动作面全在右侧属性面板）。
   */
  function maskEditWarning(row: WorkbenchLayerRow): { text: string; title: string } | null {
    const edit = getMaskEditOf(row.node.id)
    if (edit === null) return null
    if (edit.incomplete) {
      return { text: '4096', title: `蒙版行程超限（${edit.runCount} 段>4096——如实落盘但禁止导出；属性面板可放弃告警）` }
    }
    if (edit.state === 'stale') {
      return { text: '已漂移', title: '编辑基线漂移（stale）——属性面板重算后再导出' }
    }
    if (edit.state === 'error') {
      return { text: '重算失败', title: `重算失败（可重试）：${edit.error ?? ''}` }
    }
    return null
  }

  // ---- a11y roving focus（Codex 复评建议四·design §2：tree 容器单焦点 tabindex=0
  // +treeitem tabindex=-1+方向键移动/展开收起+aria-activedescendant 同步；容器持焦，
  // 活动项经 id 寻址——Enter/Space 选中、Alt+方向/组合键不劫持（命令总线面））----
  let treeActiveNodeId = $state<string | null>(null)

  // 选中变化（点击/命令）→ 活动项跟随（键盘遍历反之独立移动，Enter 才提交选中）
  $effect(() => {
    if (selectedId !== null) treeActiveNodeId = selectedId
  })

  const activeId = $derived.by(() => {
    const inRows = (id: string | null): boolean => id !== null && rows.some((row) => row.node.id === id)
    if (inRows(treeActiveNodeId)) return treeActiveNodeId
    if (inRows(selectedId)) return selectedId
    return rows[0]?.node.id ?? null
  })

  const activeItemDomId = $derived(activeId === null ? undefined : `wb-treeitem-${activeId}`)

  function nodeIndexOf(id: string): number {
    return rows.findIndex((row) => row.node.id === id)
  }

  function onTreeKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return // 组合键归命令总线
    if (isImeComposing(event) || isEditableTarget(event.target)) return // 输入框/IME 保护
    if (activeId === null || rows.length === 0) return
    const index = nodeIndexOf(activeId)
    if (index < 0) return
    const row = rows[index]!
    const move = (next: number): void => {
      const clamped = Math.min(rows.length - 1, Math.max(0, next))
      treeActiveNodeId = rows[clamped]!.node.id
      event.preventDefault()
    }
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1)
        return
      case 'ArrowUp':
        move(index - 1)
        return
      case 'Home':
        move(0)
        return
      case 'End':
        move(rows.length - 1)
        return
      case 'ArrowRight':
        // 展开态/叶子=移到下一行（首个子行/后继行）；折叠=先展开
        if (row.node.children.length > 0 && isNodeCollapsed(row.node.id)) {
          toggleNodeCollapsed(row.node.id)
          event.preventDefault()
          return
        }
        move(index + 1)
        return
      case 'ArrowLeft': {
        // 展开=先折叠；折叠/叶子=移到父行
        if (row.node.children.length > 0 && !isNodeCollapsed(row.node.id)) {
          toggleNodeCollapsed(row.node.id)
          event.preventDefault()
          return
        }
        const parentId = row.node.parent
        if (parentId !== null && nodeIndexOf(parentId) >= 0) {
          treeActiveNodeId = parentId
          event.preventDefault()
        }
        return
      }
      case 'Enter':
      case ' ':
        selectNode(activeId)
        event.preventDefault()
        return
    }
  }
</script>

<!-- 焦点域接线（图层树=tree-structure——Ctrl+Z 路由面） -->
<div
  class="flex h-full min-h-0 flex-col"
  data-testid="workbench-layer-panel"
  onfocusin={() => setUndoFocusDomain('tree-structure')}
>
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">图层</span>
    <span class="text-muted-foreground font-mono text-[10px]">{rows.length}</span>
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

  <!-- 图层树列表（a11y roving focus——容器 role=tree 可聚焦
       tabindex=0（单焦点），treeitem tabindex=-1+aria-activedescendant 同步） -->
  <div
    class="scrollbar-thin focus-visible:ring-ring/60 min-h-0 flex-1 overflow-y-auto p-1.5 outline-none focus-visible:ring-2"
    role="tree"
    aria-label="图层树"
    tabindex={rows.length > 0 ? 0 : -1}
    aria-activedescendant={activeItemDomId}
    onkeydown={onTreeKeydown}
    data-testid="workbench-layer-tree"
  >
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
        id="wb-treeitem-{row.node.id}"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={row.node.id === selectedId}
        aria-expanded={row.node.children.length > 0 ? !isNodeCollapsed(row.node.id) : undefined}
        tabindex="-1"
        title={renamingId === row.node.id ? undefined : rowTooltip(row)}
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
              class="min-w-0 flex-1 truncate text-left text-xs font-medium {row.node.id === selectedId ? 'text-accent-foreground' : ''} {row.assignment === null && row.node.children.length === 0 ? 'text-muted-foreground' : ''}"
              data-testid="workbench-layer-select-{row.node.id}"
              aria-pressed={row.node.id === selectedId}
            >
              {row.node.objectName}
            </button>
            {#if zoneLabel(row.node.id) !== ''}
              <span class="text-primary shrink-0 text-[10px] font-medium" data-testid="workbench-drop-zone-label">
                {zoneLabel(row.node.id)}
              </span>
            {/if}
            {#if maskEditWarning(row) !== null}
              {@const warning = maskEditWarning(row)!}
              <span
                class="text-destructive flex shrink-0 items-center gap-0.5 rounded border border-destructive/40 px-1 py-0.5 text-[9px] leading-none"
                data-testid="workbench-mask-edit-{row.node.id}"
                title={warning.title}
              >
                <TriangleAlert class="size-2.5" aria-hidden="true" />
                {warning.text}
              </span>
            {/if}
            <button
              type="button"
              onclick={() => beginRename(row)}
              class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              data-testid="workbench-layer-rename-{row.node.id}"
              aria-label="重命名 {row.node.objectName}"
              title="重命名（细节见右侧属性面板）"
            >
              <Pencil class="size-3" aria-hidden="true" />
            </button>
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
      </div>
    {/each}
  </div>

  {#if getRenameError() !== null}
    <div class="text-destructive border-t px-3 py-1.5 text-[11px]" data-testid="workbench-rename-error" role="alert">
      重命名失败：{getRenameError()}
    </div>
  {/if}

  <!-- 拆分层（2.3 人类抠图：选中层+文本提示→SAM 单步细分；PS 图层操作位=面板底部） -->
  <div class="space-y-1.5 border-t p-2.5" data-testid="workbench-split-box">
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
      <Button size="sm" variant="outline" class="w-full" disabled={splitting || splitHint.trim() === ''} onclick={() => void doSplit()} data-testid="workbench-split-apply">
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
        在上方图层树选择一个图层，输入提示（如「把帽子拆出来」）即可单步细分出子层
      </p>
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
</div>
