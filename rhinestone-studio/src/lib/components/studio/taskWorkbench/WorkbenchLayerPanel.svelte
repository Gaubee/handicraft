<!--
WorkbenchLayerPanel.svelte — 图层管理左面板（v5 PS 图层面板复刻——rework-layer-ps-panel
design §2+vision 11 项差距清单，2026-09-28 重写；presentation U2（2026-09-28，
Codex E1）：headerBar「蒙版」产品开关退役为 dev-only 注入面，替换为 trim/ps 缩略
双模式 segmented——观察态不进 undo 域）。
Owner 定调（权威）：图层=PS 图层；钻=图层特效（fx）——左栏完全复刻 Photoshop 图层控制：
  排序=**顶部最上层**（树前序逆序；根「画布」行固定面板最底=背景层，带锁形图标位）；
  单行节奏（~28px）：[组 caret][缩略图 32×32 真实内容][名称（双击行内重命名）]
  [fx 徽标（有钻叶子：◆+颗数微标——点击右栏定位钻区）][锁定图标][眼睛（列右对齐）]
  ——v4 双行节奏（钻布局虚拟子行/灰元数据行）与「随层隐藏」文字双重表达全数移除
  （元数据收进 fx 徽标/行 tooltip）。
  组行为：14px/级缩进+竖向轨道线；折叠整组收起；组缩略=子层并集 bbox 原图缩略。
  底部操作条（固定图标条）：拆分（选中叶子）/删除/展开全部/收起全部。
  选中=整行 accent 高亮+名称反色。
保留（v2-v4 语义）：服务端视图态折叠/显隐/锁定写透、拖拽重排（三落区+Alt+↑↓ PS 方向）、
行内重命名（双击/F2）、拆分层（底部）、删除确认面、a11y roving focus（tree/treeitem）。
-->

<script lang="ts">
  import { tick } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { summarizeParams } from '$lib/strategyDesigner/paramsSchema'
  import { isEditableTarget, isImeComposing } from '$lib/canvaskit.js'
  import {
    cancelPendingDelete,
    getAssignmentOf,
    getBaseImageUrl,
    getBaseImageVisible,
    getMaskEditOf,
    getNumberedGroupStrokes,
    getPendingDelete,
    getPreviewMode,
    getRenameError,
    getRenameRequestId,
    getSelectedNodeId,
    getSplitError,
    getThumbMode,
    getWorkbenchLayerRender,
    getWorkbenchLayerRows,
    getNodeOf,
    getWorkbenchNodes,
    isNodeCollapsed,
    isNodeLocked,
    isNodeVisible,
    isSplitting,
    isStaleGroupAssignment,
    isViewSyncing,
    confirmDeleteLayer,
    reorderLayerNode,
    renameLayer,
    requestDeleteLayer,
    selectNode,
    setAllGroupsCollapsed,
    setBaseImageVisible,
    setNumberedGroupStrokes,
    setThumbMode,
    splitLayer,
    toggleNodeCollapsed,
    toggleNodeLocked,
    toggleNodeVisible,
  } from './store.svelte'
  import { buildReorderPayload, type DropZone } from './layerTree.js'
  import { setUndoFocusDomain } from './undoDomains.svelte.js'
  import LayerCutoutThumb from './LayerCutoutThumb.svelte'
  import Check from '@lucide/svelte/icons/check'
  import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up'
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import GripVertical from '@lucide/svelte/icons/grip-vertical'
  import Lock from '@lucide/svelte/icons/lock'
  import LockOpen from '@lucide/svelte/icons/lock-open'
  import Scissors from '@lucide/svelte/icons/scissors'
  import Sparkle from '@lucide/svelte/icons/sparkle'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import X from '@lucide/svelte/icons/x'

  const rows = $derived(getWorkbenchLayerRows())
  const selectedId = $derived(getSelectedNodeId())
  const selectedNode = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const splitting = $derived(isSplitting())
  const splitError = $derived(getSplitError())
  /** 缩略观察模式（presentation U2——view-state 态，不进 undo 域）。 */
  const thumbMode = $derived(getThumbMode())
  const viewSyncing = $derived(isViewSyncing())
  const pendingDelete = $derived(getPendingDelete())
  const previewMode = $derived(getPreviewMode())
  const numberedStrokes = $derived(getNumberedGroupStrokes())
  /** 背景层（树根=画布）：显隐真源=baseVisible（工具栏背景簇同源双向）。 */
  const baseVisible = $derived(getBaseImageVisible())
  const baseImageUrl = $derived(getBaseImageUrl())
  const nodesAll = $derived(getWorkbenchNodes())
  const byIdAll = $derived.by(() => new Map(nodesAll.map((node) => [node.id, node] as const)))

  /** 渲染行投影（fx 徽标颗数/numbered 图例共用——assignments 派生不进引擎树）。 */
  const renderModel = $derived(getWorkbenchLayerRender())
  const renderRowOf = $derived.by(() => {
    const map = new Map<string, { gems: number; groupNo: number | null; groupColor: string | null; visible: boolean }>()
    for (const row of renderModel?.rows ?? []) {
      map.set(row.node.id, { gems: row.gems.length, groupNo: row.groupNo, groupColor: row.groupColor, visible: row.visible })
    }
    return map
  })

  /** numbered 图例行（侧栏——图例移侧栏不压画布；组=可见有钻层）。 */
  const legendGroups = $derived.by(() => {
    if (previewMode !== 'numbered' || renderModel === null) return []
    return renderModel.rows
      .filter((row) => row.visible && row.gems.length > 0)
      .map((row) => ({
        nodeId: row.node.id,
        objectName: row.node.objectName,
        groupNo: row.groupNo ?? 0,
        colorHex: row.groupColor ?? '#20242C',
        count: row.gems.length,
      }))
  })

  // ---- inline 重命名（双击行名/F2 进入；Enter 提交 / Esc 取消；失败驻留错误供重试） ----
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

  function beginRename(nodeId: string): void {
    renamingId = nodeId
    renameText = getNodeOf(nodeId)?.objectName ?? ''
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

  // ---- fx 徽标 → 右栏定位钻区（v5：钻=图层特效——点徽标=选中+右栏策略区滚入视野） ----
  function focusInspectorStrategy(nodeId: string): void {
    selectNode(nodeId)
    window.dispatchEvent(new CustomEvent('workbench:fx-focus', { detail: { nodeId } }))
  }

  // ---- 拆分层（底部操作条「拆分」展开提示输入→layer.split；重试=同参再调） ----
  let splitOpen = $state(false)
  let splitHint = $state('')

  async function doSplit(): Promise<void> {
    const target = selectedId
    const hint = splitHint.trim()
    if (target === null || hint === '') return
    const ok = await splitLayer(target, hint)
    if (ok) {
      splitHint = ''
      splitOpen = false
    }
  }

  // ---- 拖拽重排（pointer 三落区——PS 方向换算：视觉上沿=树上序位+1（抬升），中=移入子层） ----
  let dragState = $state<{ nodeId: string; overRowId: string | null; zone: DropZone | null } | null>(null)

  function onDragHandleDown(event: PointerEvent, nodeId: string): void {
    if (event.button !== 0) return
    dragState = { nodeId, overRowId: null, zone: null }
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
    // 面板顶部=最上层：视觉上沿（rel<0.3）=抬到目标之上=树序位其后（after）
    const zone: DropZone = rel < 0.3 ? 'after' : rel > 0.7 ? 'before' : 'inside'
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
    return dragState.zone === 'after' ? 'border-t-primary border-t-2' : 'border-b-primary border-b-2'
  }

  /** 落区文案（拖拽中行尾提示——inside=「移入」；after/before 按 PS 方向表述）。 */
  function zoneLabel(nodeId: string): string {
    if (dragState?.overRowId !== nodeId || dragState.zone === null) return ''
    return dragState.zone === 'inside' ? '↳ 移入' : dragState.zone === 'after' ? '↑ 移到上方' : '↓ 移到下方'
  }

  /**
   * 行 hover 关键摘要（v5：v4 钻布局虚拟子行的元数据全数收进此处 tooltip——
   * 单行节奏下细节经 tooltip 与右栏属性面板呈现）。
   */
  function rowTooltip(row: { node: { id: string; objectName: string; category: string; bbox: { w: number; h: number }; effectiveMm: number; drillWorthy: boolean; children: unknown[] } }): string {
    const node = row.node
    const parts = [
      `${node.objectName}（${node.category}）`,
      `${node.bbox.w}×${node.bbox.h} px · 有效粒径 ${node.effectiveMm.toFixed(1)} mm`,
      node.children.length > 0 ? '组（v5：组不产钻——拆分后在子图层指派）' : node.drillWorthy ? '叶子层（可贴钻）' : '叶子层（drillWorthy=false——默认排除）',
    ]
    const assignment = getAssignmentOf(node.id)
    if (assignment !== null) {
      const stale = isStaleGroupAssignment(node.id)
      parts.push(
        `策略：${assignment.strategyKind}${stale ? '（组不产钻——已失效）' : assignment.strategyKind === 'exclusion' ? '' : ` · 密度 ${assignment.densityPerCm2}/cm²`}`,
      )
      if (assignment.stones.length > 0) {
        parts.push(`用钻：${assignment.stones.map((stone) => `${stone.sku}${stone.sizeMm !== null ? `(${stone.sizeMm}mm)` : ''}`).join('、')}`)
      }
      parts.push(`参数：${summarizeParams(assignment.strategyKind, assignment.params) || '—'}`)
      const gems = renderRowOf.get(node.id)?.gems ?? 0
      if (gems > 0) parts.push(`钻布局：${gems} 颗（fx）`)
    } else if (node.children.length === 0) {
      parts.push('策略：未指派')
    }
    const edit = getMaskEditOf(node.id)
    if (edit !== null) {
      parts.push(`掩码编辑：${edit.state}${edit.incomplete ? '（行程超限禁导出）' : `（行程 ${edit.runCount} 段）`}`)
    }
    return parts.join('\n')
  }

  /**
   * 行级掩码编辑告警徽标（仅阻断态在行上出现——stale/error/incomplete；
   * ready 等非阻断态与「重算/放弃」动作面全在右侧属性面板）。
   */
  function maskEditWarning(nodeId: string): { text: string; title: string } | null {
    const edit = getMaskEditOf(nodeId)
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

  // ---- 锚定折叠/展开（BUG 8317「向上收起」修复） ----
  // PS 逆序表中组行的子行在其**上方**（顶部=最上层）：折叠移除上方行→组行内容偏移骤减，
  // scrollTop 数值不变即视口内容整体上跳（「向上收起」），内容骤缩时还被浏览器钳制到
  // 错误位置；展开反之把组行推出视野（锚点丢失）。切换前后按锚行在滚动内容中的位移差
  // 回补 scrollTop——视口稳定在被操作行；scrollIntoView(nearest) 兜底（钳制后仍可见）。
  let treeScrollEl = $state<HTMLDivElement | null>(null)

  /** 行相对滚动容器内容顶的绝对偏移（rect 差法——不受 offsetParent 链影响）。 */
  function rowContentOffset(row: HTMLElement, container: HTMLElement): number {
    return row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  }

  /** 折叠/展开锚定补偿：apply 变更投影 → DOM 更新后按锚行位移差回补 scrollTop。 */
  async function scrollAnchored(apply: () => void, anchorId: string | null): Promise<void> {
    const container = treeScrollEl
    const anchor =
      anchorId !== null ? (container?.querySelector<HTMLElement>(`[data-node-id="${anchorId}"]`) ?? null) : null
    if (container === null || anchor === null) {
      apply()
      return
    }
    const before = rowContentOffset(anchor, container)
    apply()
    await tick()
    if (!anchor.isConnected) return // 锚行被移除（收起全部时活动行在子树内）——无从补偿
    const delta = rowContentOffset(anchor, container) - before
    if (delta !== 0) container.scrollTop += delta
    anchor.scrollIntoView?.({ block: 'nearest' })
  }

  /** 单组折叠/展开（锚=被操作组行——keyed each 元素复用，前后可同元素测量）。 */
  function toggleCollapsedAnchored(nodeId: string): void {
    void scrollAnchored(() => toggleNodeCollapsed(nodeId), nodeId)
  }

  /** 展开/收起全部（锚=活动行；活动行不在树内则退化为不补偿）。 */
  function setAllCollapsedAnchored(collapsed: boolean): void {
    void scrollAnchored(() => setAllGroupsCollapsed(collapsed), activeId)
  }

  // ---- a11y roving focus（tree 容器单焦点 tabindex=0+treeitem tabindex=-1+
  // 方向键移动/展开收起+aria-activedescendant 同步；容器持焦，活动项经 id 寻址——
  // Enter/Space 选中、Alt+方向/组合键不劫持（命令总线面））----
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
        // 展开态/叶子=移到下一行（PS 序：下一行=更深/后继）；折叠=先展开
        if (row.node.children.length > 0 && row.node.parent !== null && isNodeCollapsed(row.node.id)) {
          toggleCollapsedAnchored(row.node.id)
          event.preventDefault()
          return
        }
        move(index + 1)
        return
      case 'ArrowLeft': {
        // 展开=先折叠；折叠/叶子=移到父行（PS 序：父行在本行下方）
        if (row.node.children.length > 0 && row.node.parent !== null && !isNodeCollapsed(row.node.id)) {
          toggleCollapsedAnchored(row.node.id)
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
    <!-- 缩略双模式 segmented（presentation U2/Codex E1——替换已退役的「蒙版」产品开关：
         trim=内容贴合（小图层放大可读）；ps=整画布坐标放回（保留 parent/child 空间关系）。
         观察=view-state 态（不进 undo 域）；蒙版叠加保留为 dev-only 测试注入面 setShowMasks -->
    <div
      class="border-border/60 bg-muted/40 ml-auto flex items-center rounded-md border p-0.5"
      role="radiogroup"
      aria-label="缩略图模式"
      data-testid="workbench-thumb-mode"
    >
      <button
        type="button"
        class="rounded px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium transition-colors {thumbMode === 'trim' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        onclick={() => setThumbMode('trim')}
        role="radio"
        aria-checked={thumbMode === 'trim'}
        data-testid="workbench-thumb-mode-trim"
        title="trim：内容贴合——按图层内容 bbox 放大（小图层可读优先）"
      >
        trim
      </button>
      <button
        type="button"
        class="rounded px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium transition-colors {thumbMode === 'ps' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        onclick={() => setThumbMode('ps')}
        role="radio"
        aria-checked={thumbMode === 'ps'}
        data-testid="workbench-thumb-mode-ps"
        title="PS：整画布坐标放回——图层按全局位置缩进缩略格（parent/child 空间关系）"
      >
        ps
      </button>
    </div>
  </div>

  <!-- numbered 图例（图例移侧栏——不压画布；组色描边可选开关缺省关） -->
  {#if previewMode === 'numbered'}
    <div class="space-y-1 border-b px-2.5 py-2" data-testid="workbench-numbered-legend" aria-label="分组编号图例（侧栏）">
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground text-[10px] font-semibold">分组编号图例</span>
        <label class="text-muted-foreground flex items-center gap-1 text-[10px]" title="画布内各层 bbox 组色描边（缺省关——回归纯视图）">
          <input
            type="checkbox"
            checked={numberedStrokes}
            onchange={(event) => setNumberedGroupStrokes(event.currentTarget.checked)}
            class="accent-primary size-2.5"
            data-testid="workbench-numbered-strokes-toggle"
          />
          组色描边
        </label>
      </div>
      {#if legendGroups.length === 0}
        <p class="text-muted-foreground/70 text-[10px]">当前无可见钻布局——切回成钻模式或展开被隐藏的层</p>
      {:else}
        <div class="scrollbar-thin max-h-28 space-y-0.5 overflow-y-auto">
          {#each legendGroups as group (group.nodeId)}
            <div class="flex items-center gap-1.5 py-0.5 text-[10px]" data-testid="workbench-numbered-legend-row" data-node-id={group.nodeId}>
              <span class="size-2.5 shrink-0 rounded-sm border border-black/10" style="background: {group.colorHex}" aria-hidden="true"></span>
              <span class="w-4 shrink-0 text-center font-mono font-semibold">{group.groupNo}</span>
              <span class="min-w-0 flex-1 truncate" title={group.objectName}>{group.objectName}</span>
              <span class="text-muted-foreground shrink-0 font-mono">{group.count}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- 图层树列表（v5 PS 序：顶部=最上层；根「画布」行固定最底=背景层）。
       overflow-anchor:none——禁浏览器原生滚动锚定：折叠/展开由 scrollAnchored 显式
       补偿（原生锚定择节点不受控，与显式回补叠加会二次跳动——BUG 8317） -->
  <div
    bind:this={treeScrollEl}
    class="scrollbar-thin focus-visible:ring-ring/60 min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-2 [overflow-anchor:none]"
    role="tree"
    aria-label="图层树（顶部=最上层）"
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
      {@const isRoot = row.node.parent === null}
      {@const isGroup = row.node.children.length > 0 && !isRoot}
      {@const gemCount = renderRowOf.get(row.node.id)?.gems ?? 0}
      {@const staleAssignment = row.assignment !== null && isStaleGroupAssignment(row.node.id)}
      <div
        class="group/row flex h-7 items-center gap-1 pr-1 transition-colors {row.node.id === selectedId ? 'bg-accent' : 'hover:bg-accent/50'} {dropIndicator(row.node.id)}"
        data-testid="workbench-layer-row"
        data-node-id={row.node.id}
        data-root={isRoot ? 'true' : undefined}
        id="wb-treeitem-{row.node.id}"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={row.node.id === selectedId}
        aria-expanded={row.node.children.length > 0 && !isRoot ? !isNodeCollapsed(row.node.id) : undefined}
        tabindex="-1"
        title={renamingId === row.node.id ? undefined : rowTooltip(row)}
      >
        <!-- 竖向轨道线（14px/级——组层级视觉锚） -->
        {#each Array(row.depth) as _, di (di)}
          <span class="ml-1 w-3 self-stretch border-l border-border/50" aria-hidden="true"></span>
        {/each}
        {#if renamingId === row.node.id}
          <!-- inline 重命名（双击/F2 进入）：Enter 提交→layer.rename；Esc 取消 -->
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
          <!-- 组 caret（叶子=空位对齐；根=背景层无折叠语义） -->
          {#if isGroup}
            <button
              type="button"
              onclick={() => toggleCollapsedAnchored(row.node.id)}
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
          <!-- 拖拽重排手柄（hover 显——pointer 三落区；根不可移；键盘等价 Alt+↑↓ PS 方向） -->
          {#if !isRoot}
            <button
              type="button"
              class="text-muted-foreground/50 hover:text-foreground shrink-0 cursor-grab rounded p-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 active:cursor-grabbing"
              onpointerdown={(event) => onDragHandleDown(event, row.node.id)}
              onpointermove={onDragHandleMove}
              onpointerup={() => void onDragHandleUp()}
              onpointercancel={() => (dragState = null)}
              data-testid="workbench-layer-drag-{row.node.id}"
              aria-label="拖拽重排 {row.node.objectName}（键盘等价 Alt+↑↓）"
              title="拖到目标层：上沿=排其上 / 下沿=排其下 / 中部=移入其内"
            >
              <GripVertical class="size-3" aria-hidden="true" />
            </button>
          {:else}
            <span class="inline-block size-3.5 shrink-0"></span>
          {/if}
          <!-- 缩略图（32×32 真实内容）：叶/普通层=抠图；组=子层并集（trim）/整画布放回（ps）；根行=原图（背景层） -->
          <LayerCutoutThumb
            nodeId={row.node.id}
            nodeBbox={isRoot ? undefined : row.node.bbox}
            baseImageUrl={isRoot ? baseImageUrl : undefined}
            groupChildren={isGroup
              ? row.node.children.map((id) => byIdAll.get(id)).filter((n): n is NonNullable<typeof n> => n !== undefined).map((n) => ({ id: n.id, bbox: n.bbox }))
              : undefined}
            imagePx={renderModel?.imagePx}
          />
          <!-- 名称（双击行内重命名；组旧指派降级标注） -->
          {#if !isRoot}
            <button
              type="button"
              onclick={() => selectNode(row.node.id === selectedId ? null : row.node.id)}
              ondblclick={() => beginRename(row.node.id)}
              class="min-w-0 flex-1 truncate text-left text-xs font-medium {row.node.id === selectedId ? 'text-accent-foreground' : ''} {row.assignment === null && row.node.children.length === 0 ? 'text-muted-foreground' : ''}"
              data-testid="workbench-layer-select-{row.node.id}"
              aria-pressed={row.node.id === selectedId}
              title="双击重命名"
            >
              {row.node.objectName}{staleAssignment ? '（组不产钻——已失效）' : ''}
            </button>
          {:else}
            <!-- 根行=背景层——无策略语义，点击不进右栏属性（选中限图层节点） -->
            <span
              class="text-muted-foreground min-w-0 flex-1 truncate text-left text-xs font-medium"
              title="背景层（原图）——显隐经眼睛/画布右上开关；无图层属性"
            >
              {row.node.objectName}
            </span>
          {/if}
          {#if zoneLabel(row.node.id) !== ''}
            <span class="text-primary shrink-0 text-[10px] font-medium" data-testid="workbench-drop-zone-label">
              {zoneLabel(row.node.id)}
            </span>
          {/if}
          <!-- fx 徽标（v5：钻=图层特效——有钻叶子行 ◆+颗数微标；点击=右栏定位钻区） -->
          {#if !isRoot && !isGroup && gemCount > 0}
            <button
              type="button"
              onclick={() => focusInspectorStrategy(row.node.id)}
              class="text-primary bg-primary/10 hover:bg-primary/20 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] leading-none font-medium"
              data-testid="workbench-layer-fx-{row.node.id}"
              data-gem-count={gemCount}
              aria-label={`查看 ${row.node.objectName} 的钻布局（${gemCount} 颗——右栏定位）`}
              title="钻布局（fx——图层特效）：{gemCount} 颗 · 点击在右侧属性面板定位钻区"
            >
              <Sparkle class="size-2.5" aria-hidden="true" />
              <span class="font-mono">{gemCount}</span>
            </button>
          {/if}
          {#if maskEditWarning(row.node.id) !== null}
            {@const warning = maskEditWarning(row.node.id)!}
            <span
              class="text-destructive flex shrink-0 items-center gap-0.5 rounded border border-destructive/40 px-1 py-0.5 text-[9px] leading-none"
              data-testid="workbench-mask-edit-{row.node.id}"
              title={warning.title}
            >
              <TriangleAlert class="size-2.5" aria-hidden="true" />
              {warning.text}
            </span>
          {/if}
          <!-- 锁定（根=背景层：锁形图标位——背景默认锁定语义后续波，本波仅图标位） -->
          {#if isRoot}
            <span
              class="text-muted-foreground/60 shrink-0 p-0.5"
              data-testid="workbench-layer-lock-{row.node.id}"
              title="背景层（锁定图标位——背景默认锁定语义后续波）"
              aria-label="背景层（锁定）"
            >
              <Lock class="size-3.5" aria-hidden="true" />
            </span>
          {:else}
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
                <LockOpen class="size-3.5 opacity-0 transition-opacity group-hover/row:opacity-100" aria-hidden="true" />
              {/if}
            </button>
          {/if}
          <!-- 眼睛（列右对齐） -->
          {#if !isRoot}
            <button
              type="button"
              onclick={() => toggleNodeVisible(row.node.id)}
              class="text-muted-foreground hover:text-foreground ml-auto shrink-0 rounded p-0.5"
              data-testid="workbench-layer-visible-{row.node.id}"
              aria-label={isNodeVisible(row.node.id) ? `隐藏 ${row.node.objectName}` : `显示 ${row.node.objectName}`}
              aria-pressed={isNodeVisible(row.node.id)}
              title={isNodeVisible(row.node.id) ? '点击隐藏该层（组隐藏=子树全隐）' : '点击显示该层'}
            >
              {#if isNodeVisible(row.node.id)}
                <Eye class="size-3.5" aria-hidden="true" />
              {:else}
                <EyeOff class="size-3.5 opacity-50" aria-hidden="true" />
              {/if}
            </button>
          {:else}
            <!-- 根行眼睛=背景层（原图）显隐——与画布右上背景簇同一真源双向同步 -->
            <button
              type="button"
              onclick={() => setBaseImageVisible(!baseVisible)}
              class="text-muted-foreground hover:text-foreground ml-auto shrink-0 rounded p-0.5"
              data-testid="workbench-layer-visible-{row.node.id}"
              data-role="base-image"
              aria-label={baseVisible ? '隐藏背景层（原图）' : '显示背景层（原图）'}
              aria-pressed={baseVisible}
              title={baseVisible ? '隐藏背景层（原图）——仅见图层抠图；与画布右上开关同源' : '显示背景层（原图）——与画布右上开关同源'}
            >
              {#if baseVisible}
                <Eye class="size-3.5" aria-hidden="true" />
              {:else}
                <EyeOff class="size-3.5 opacity-50" aria-hidden="true" />
              {/if}
            </button>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  {#if getRenameError() !== null}
    <div class="text-destructive border-t px-3 py-1.5 text-[11px]" data-testid="workbench-rename-error" role="alert">
      重命名失败：{getRenameError()}
    </div>
  {/if}

  <!-- 拆分提示输入（底部操作条「拆分」展开——选中叶子+文本提示→SAM 单步细分） -->
  {#if splitOpen}
    <div class="space-y-1.5 border-t p-2.5" data-testid="workbench-split-box">
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
  {/if}

  <!-- v5 PS 底部操作条（固定图标条）：拆分（选中叶子）/删除/展开全部/收起全部 -->
  <div
    class="bg-background/80 flex h-9 shrink-0 items-center gap-1 border-t px-2 backdrop-blur"
    data-testid="workbench-layer-bottombar"
    role="toolbar"
    aria-label="图层操作"
  >
    <Button
      variant="ghost"
      size="icon"
      class="size-7 {splitOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
      disabled={selectedNode === null}
      onclick={() => (splitOpen = !splitOpen)}
      data-testid="workbench-layer-split-toggle"
      title="拆分选中图层（输入提示→SAM 单步细分出子层）"
      aria-pressed={splitOpen}
    >
      <Scissors class="size-4" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="text-muted-foreground hover:text-destructive size-7"
      disabled={selectedNode === null || selectedNode.parent === null}
      onclick={() => selectedId !== null && requestDeleteLayer(selectedId)}
      data-testid="workbench-layer-delete-selected"
      title="删除选中层及其子树（确认后执行——Delete 键同源）"
    >
      <Trash2 class="size-4" aria-hidden="true" />
    </Button>
    <div class="bg-border mx-0.5 h-4 w-px" aria-hidden="true"></div>
    <Button
      variant="ghost"
      size="icon"
      class="text-muted-foreground size-7"
      onclick={() => setAllCollapsedAnchored(false)}
      data-testid="workbench-layer-expand-all"
      title="展开全部组"
    >
      <ChevronsUpDown class="size-4" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="text-muted-foreground size-7"
      onclick={() => setAllCollapsedAnchored(true)}
      data-testid="workbench-layer-collapse-all"
      title="收起全部组"
    >
      <ChevronsDownUp class="size-4" aria-hidden="true" />
    </Button>
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
