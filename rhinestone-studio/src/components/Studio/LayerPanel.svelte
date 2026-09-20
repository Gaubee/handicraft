<!--
Orthogonal intents (max 4):
1. [2026-09-20 studio-layers 2.7 / improve-paving-workbench 1.3] 左列图层面板树化：一级行
     [眼睛][≡ 拖柄][层名双击重命名][钻数 mono][状态点 ◷/～/！/空] + 选择序徽标 ①②③ + 行尾菜单
     [重命名/合并到本层/删除·兜底层禁用] + [+ 新建图层] + 背景层钉底行；行内可折叠展开成员块子行
     （#No 区块 = 二级图层——improve 点 1/5，rest 兜底层下同样显示；子行点击 = selectBlock，
     画布选块 ⇄ 子行高亮双向同步）。
2. [improve 1.1/1.2] 一级行 HTML5 拖动排序（layer.reorder op——仅视觉序，联合口径恒按层 id
     稳定序）；合并/移块的层成员变化经 markLayersDirty 标脏（裸 dispatch 无人标脏 = 移入 BUG 修复）。
3. [键盘] ↑↓ 单选移动 / Space 切眼睛（P0 兜底——画布容差命中 = P1 入口验收门）。
4. [状态点] layerComputeStatus（stale=标脏待重算 ～ / error ！ / empty 空 / computing ◷ / ok 无标）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import {
    clearStaleOverrideNotice,
    getActualBlockCount,
    getBackgroundObservation,
    getBlocks,
    getLayerMemberIds,
    getLayers,
    getLayerResult,
    getSelectedBlockId,
    getSelectionOrder,
    getStaleOverrideNotice,
    independentBlockConfigOf,
    isLayerSelected,
    layerComputeStatus,
    markLayersDirty,
    owningLayerOf,
    selectAllLayers,
    selectBackground,
    selectBlock,
    selectLayer,
    selectionBadgeOf,
    setLayerVisible,
  } from '$lib/stores/studio.svelte'
  import { dispatchStudioOp } from '$lib/studio/history.svelte'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import MoreHorizontal from '@lucide/svelte/icons/more-horizontal'
  import Plus from '@lucide/svelte/icons/plus'

  const layers = $derived(getLayers())
  const blocks = $derived(getBlocks())
  const background = $derived(getBackgroundObservation())
  const staleNotice = $derived(getStaleOverrideNotice())
  const selectedBlockId = $derived(getSelectedBlockId())

  const SOURCE_LABELS: Record<string, string> = { none: '无', painting: '数字油画', reference: '参考原图' }

  /** 各层成员数（rest = 分块结果 − 显式层并集）。 */
  const memberCounts = $derived.by(() => {
    const explicit = new Set<string>()
    for (const layer of layers) {
      if (layer.blockIds !== 'rest') for (const id of layer.blockIds) explicit.add(id)
    }
    const counts = new Map<string, number>()
    for (const layer of layers) {
      counts.set(
        layer.id,
        layer.blockIds === 'rest'
          ? blocks.filter((b) => !explicit.has(b.id)).length
          : layer.blockIds.length,
      )
    }
    return counts
  })

  // ---- 二级图层（成员块子行）：默认展开（Owner「在左侧的列表中能看到这些二级图层」）----
  /** 折叠集（缺省展开——记录的是「被收起」的层 id）。 */
  let collapsedIds = $state<Set<string>>(new Set())

  function memberBlocksOf(layerId: string): typeof blocks {
    const ids = getLayerMemberIds(layerId)
    return blocks.filter((b) => ids.has(b.id))
  }

  function toggleExpand(layerId: string): void {
    const next = new Set(collapsedIds)
    if (next.has(layerId)) next.delete(layerId)
    else next.add(layerId)
    collapsedIds = next
  }

  // 画布选中块 → 父层自动展开 + 子行高亮（双向同步的「画布 → 面板」半边；
  // 归属判定与 owningLayerOf 同义：显式层命中 ?? 兜底层）
  $effect(() => {
    const id = selectedBlockId
    if (id === null) return
    const owner =
      layers.find((l) => l.blockIds !== 'rest' && l.blockIds.includes(id)) ??
      layers.find((l) => l.blockIds === 'rest')
    if (owner !== undefined && collapsedIds.has(owner.id)) toggleExpand(owner.id)
  })

  function rgbCss(rgb: readonly [number, number, number]): string {
    return `rgb(${rgb.map((v) => Math.round(v)).join(' ')})`
  }

  /** [improve 3.3] 子行「独」徽标数据面（继承开关关 = 独立配置生效）。 */
  function isBlockIndependent(blockId: string): boolean {
    const owner = owningLayerOf(layers, blockId)
    return owner !== null && independentBlockConfigOf(owner, blockId) !== null
  }

  // ---- 一级行拖动排序（layer.reorder——视觉序 only，联合口径不受影响）----
  let dragLayerId = $state<string | null>(null)
  let dropTargetId = $state<string | null>(null)

  function onDrop(targetId: string): void {
    const dragged = dragLayerId
    dragLayerId = null
    dropTargetId = null
    if (dragged === null || dragged === targetId) return
    const ids = layers.map((l) => l.id)
    const from = ids.indexOf(dragged)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(to, 0, ids.splice(from, 1)[0]!)
    if (ids.join() !== layers.map((l) => l.id).join()) {
      dispatchStudioOp({ t: 'layer.reorder', order: ids })
    }
  }

  // ---- 重命名（双击行名 → 行内输入）----
  let renamingId = $state<string | null>(null)
  let renamingValue = $state('')

  function startRename(layerId: string, name: string): void {
    renamingId = layerId
    renamingValue = name
  }

  function commitRename(): void {
    if (renamingId !== null) {
      dispatchStudioOp({ t: 'layer.rename', layerId: renamingId, name: renamingValue })
    }
    renamingId = null
  }

  // ---- 行尾菜单（重命名 / 合并到本层 / 删除）----
  let menuOpenId = $state<string | null>(null)
  let deleteConfirmId = $state<string | null>(null)
  const deleteTarget = $derived(layers.find((l) => l.id === deleteConfirmId) ?? null)

  /** 合并到本层：锚点=本层，其余选中层并入（多选 ≥2 时可用）。并入块落位 → 锚点层标脏重算。 */
  function mergeInto(layerId: string): void {
    const from = getSelectionOrder().filter((id) => id !== layerId)
    if (from.length === 0) return
    dispatchStudioOp({ t: 'layer.merge', intoLayerId: layerId, fromLayerIds: from })
    markLayersDirty([layerId], { immediate: true })
    selectLayer(layerId)
  }

  function createLayer(): void {
    dispatchStudioOp({ t: 'layer.create' })
    const last = getLayers()[getLayers().length - 1]
    if (last) selectLayer(last.id)
  }

  // ---- 键盘：↑↓ 单选移动 / Space 切眼睛 / Cmd+A 全选 ----
  function onKeydown(e: KeyboardEvent): void {
    if (renamingId !== null) return
    const ids = layers.map((l) => l.id)
    if (ids.length === 0) return
    const current = getSelectionOrder()[0] ?? ids[0]
    const index = ids.indexOf(current)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(ids.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))
      selectLayer(ids[next]!)
    } else if (e.key === ' ') {
      e.preventDefault()
      const layer = layers[index === -1 ? 0 : index]
      if (layer) setLayerVisible(layer.id, !layer.visible)
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selectAllLayers()
    }
  }

  function statusChar(status: string): string {
    if (status === 'computing') return '◷'
    if (status === 'stale') return '～'
    if (status === 'error') return '！'
    return ''
  }
</script>

<div
  class="flex min-h-0 flex-1 flex-col gap-1 outline-none"
  tabindex="0"
  role="listbox"
  aria-label="图层列表"
  onkeydown={onKeydown}
  data-testid="layer-panel"
>
  {#if staleNotice !== null}
    <button
      type="button"
      class="bg-destructive/10 text-destructive rounded-md px-2 py-1 text-left text-[11px]"
      onclick={() => clearStaleOverrideNotice()}
      data-testid="stale-override-notice"
    >
      重分块：{staleNotice} 项块覆写失效已移除（点击关闭）
    </button>
  {/if}

  <div class="scrollbar-thin grid min-h-0 flex-1 content-start gap-1 overflow-y-auto pr-0.5">
    {#each layers as layer (layer.id)}
      {@const entry = getLayerResult(layer.id)}
      {@const badge = selectionBadgeOf(layer.id)}
      {@const status = layerComputeStatus(layer, memberCounts.get(layer.id) ?? 0)}
      {@const members = memberBlocksOf(layer.id)}
      {@const collapsed = collapsedIds.has(layer.id)}
      {@const isDropTarget = dropTargetId === layer.id && dragLayerId !== null && dragLayerId !== layer.id}
      <div class="grid gap-1" data-testid="layer-group-{layer.id}">
        <div
          class="group flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors
            {isLayerSelected(layer.id) ? 'border-primary bg-accent/50' : 'hover:bg-muted/50'}
            {isDropTarget ? 'border-primary/70 ring-primary/30 ring-1' : ''}
            {dragLayerId === layer.id ? 'opacity-50' : ''}"
          role="option"
          tabindex={-1}
          aria-selected={isLayerSelected(layer.id)}
          draggable={renamingId !== layer.id}
          data-testid="layer-row-{layer.id}"
          data-layer-id={layer.id}
          onclick={(e) => selectLayer(layer.id, e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'replace')}
          onkeydown={onKeydown}
          ondragstart={(e) => {
            dragLayerId = layer.id
            // jsdom 合成事件无 dataTransfer（undefined）——真浏览器才设置 effectAllowed
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
          }}
          ondragend={() => {
            dragLayerId = null
            dropTargetId = null
          }}
          ondragover={(e) => {
            e.preventDefault()
            if (dragLayerId !== null && dragLayerId !== layer.id) dropTargetId = layer.id
          }}
          ondragleave={() => {
            if (dropTargetId === layer.id) dropTargetId = null
          }}
          ondrop={(e) => {
            e.preventDefault()
            onDrop(layer.id)
          }}
        >
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-30"
            disabled={members.length === 0}
            aria-label={collapsed ? `展开 ${layer.name} 的块子层` : `收起 ${layer.name} 的块子层`}
            aria-expanded={members.length > 0 && !collapsed}
            onclick={(e) => {
              e.stopPropagation()
              toggleExpand(layer.id)
            }}
            data-testid="layer-expand-{layer.id}"
          >
            {#if members.length > 0}
              {#if collapsed}
                <ChevronRight class="size-3.5" />
              {:else}
                <ChevronDown class="size-3.5" />
              {/if}
            {:else}
              <span class="block size-3.5"></span>
            {/if}
          </button>

          <button
            type="button"
            class="text-muted-foreground/60 hover:text-foreground shrink-0 cursor-grab active:cursor-grabbing"
            title="拖动排序（仅面板视觉序，不改变导出与 BOM 顺序）"
            aria-label="拖动排序 {layer.name}"
            onclick={(e) => e.stopPropagation()}
            ondragstart={(e) => {
              // 拖柄冒泡触发行拖动（行级 draggable 为真源；此 handler 仅阻断行点击语义）
              e.stopPropagation()
            }}
            data-testid="layer-drag-handle-{layer.id}"
          >
            ⠿
          </button>

          <button
            type="button"
            class="text-muted-foreground hover:text-foreground shrink-0"
            title={layer.visible ? '隐藏此层（隐藏 ≠ 排除——仍计算/统计/导出）' : '显示此层'}
            aria-label={layer.visible ? `隐藏 ${layer.name}` : `显示 ${layer.name}`}
            onclick={(e) => {
              e.stopPropagation()
              setLayerVisible(layer.id, !layer.visible)
            }}
            data-testid="layer-eye-{layer.id}"
          >
            {#if layer.visible}
              <Eye class="size-3.5" />
            {:else}
              <EyeOff class="size-3.5" />
            {/if}
          </button>

          {#if badge !== null}
            <span
              class="bg-primary/10 text-primary shrink-0 rounded-full px-1.5 font-mono text-[10px]"
              title="选择序 {badge}（锚点 = 最早选中）"
              data-testid="layer-badge-{layer.id}"
            >
              {['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'][badge - 1] ?? badge}
            </span>
          {/if}

          {#if renamingId === layer.id}
            <input
              class="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-xs"
              bind:value={renamingValue}
              onblur={commitRename}
              onkeydown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') (renamingId = null)
              }}
              onclick={(e) => e.stopPropagation()}
              data-testid="layer-rename-input"
            />
          {:else}
            <span
              class="min-w-0 flex-1 truncate"
              role="button"
              tabindex={-1}
              title="{layer.name}（双击重命名）"
              ondblclick={(e) => {
                e.stopPropagation()
                startRename(layer.id, layer.name)
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  startRename(layer.id, layer.name)
                }
              }}
            >
              {layer.name}
            </span>
          {/if}

          <span
            class="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums"
            title={status === 'empty' ? '空层（重分块后成员已重置）' : `${entry?.gems.length ?? 0} 钻`}
          >
            {status === 'empty' ? '空' : (entry?.gems.length ?? 0).toLocaleString()}
          </span>
          <span
            class="w-3 shrink-0 text-center text-[11px] {status === 'error' ? 'text-destructive' : 'text-muted-foreground'}"
            title={status === 'error' ? entry?.error : status === 'computing' ? '排布中' : status === 'stale' ? '待重算' : ''}
            data-testid="layer-status-{layer.id}"
          >
            {statusChar(status)}
          </span>

          <div class="relative shrink-0">
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground"
              aria-label="{layer.name} 操作菜单"
              onclick={(e) => {
                e.stopPropagation()
                menuOpenId = menuOpenId === layer.id ? null : layer.id
              }}
              data-testid="layer-menu-{layer.id}"
            >
              <MoreHorizontal class="size-3.5" />
            </button>
            {#if menuOpenId === layer.id}
              <div
                class="absolute right-0 z-30 mt-1 grid w-36 gap-1 rounded-lg border bg-card p-1.5 shadow-lg"
                data-testid="layer-menu-pop-{layer.id}"
              >
                <button
                  type="button"
                  class="hover:bg-muted rounded px-2 py-1 text-left text-xs"
                  onclick={(e) => {
                    e.stopPropagation()
                    menuOpenId = null
                    startRename(layer.id, layer.name)
                  }}
                >
                  重命名
                </button>
                <button
                  type="button"
                  class="hover:bg-muted rounded px-2 py-1 text-left text-xs disabled:opacity-40"
                  disabled={getSelectionOrder().filter((id) => id !== layer.id).length === 0}
                  title="其余选中层并入本层（配置取本层）"
                  onclick={(e) => {
                    e.stopPropagation()
                    menuOpenId = null
                    mergeInto(layer.id)
                  }}
                  data-testid="layer-merge-{layer.id}"
                >
                  合并选中层到此
                </button>
                <button
                  type="button"
                  class="hover:bg-muted text-destructive rounded px-2 py-1 text-left text-xs disabled:opacity-40"
                  disabled={layer.blockIds === 'rest'}
                  title={layer.blockIds === 'rest' ? '兜底层不可删除' : '删除图层'}
                  onclick={(e) => {
                    e.stopPropagation()
                    menuOpenId = null
                    deleteConfirmId = layer.id
                  }}
                  data-testid="layer-delete-{layer.id}"
                >
                  删除图层
                </button>
              </div>
            {/if}
          </div>
        </div>

        <!-- 二级图层子行（#No 区块；点击 = 选中该块——画布 ⇄ 面板同一选择真源） -->
        {#if !collapsed}
          {#each members as b (b.id)}
            <button
              type="button"
              class="ml-5 flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors
                {b.id === selectedBlockId ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted/50'}"
              aria-label="选择区块 {b.label}"
              title="{b.label}（点击选中；选中后右侧检查器可精调）"
              onclick={() => selectBlock(b.id)}
              data-testid="layer-child-{b.id}"
            >
              <span class="size-3 shrink-0 rounded-sm border" style="background: {rgbCss(b.colorRgb)}"></span>
              <span class="min-w-0 flex-1 truncate">{b.label}</span>
              {#if isBlockIndependent(b.id)}
                <span
                  class="bg-accent text-accent-foreground shrink-0 rounded px-1 py-px text-[9px]"
                  title="独立配置（继承开关关——策略/规格自行微调）"
                  data-testid="layer-child-independent-{b.id}"
                >
                  独
                </span>
              {/if}
              <span class="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
                {getActualBlockCount(b.id).toLocaleString()}
              </span>
            </button>
          {/each}
        {/if}
      </div>
    {/each}

    <!-- 背景层钉底行（分隔线之下；选中 → 检查器出源+透明度面板） -->
    <div class="bg-border my-1 h-px shrink-0" aria-hidden="true"></div>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors
        {getBackgroundObservation().source !== 'none' && background.visible ? '' : 'opacity-70'}
        hover:bg-muted/50"
      onclick={() => selectBackground()}
      data-testid="layer-row-background"
    >
      {#if background.visible && background.source !== 'none'}
        <Eye class="text-muted-foreground size-3.5 shrink-0" />
      {:else}
        <EyeOff class="text-muted-foreground size-3.5 shrink-0" />
      {/if}
      <span class="flex-1 truncate text-left">背景</span>
      <span class="text-muted-foreground shrink-0 font-mono text-[11px]">
        {SOURCE_LABELS[background.source] ?? background.source} · {Math.round(background.opacity * 100)}%
      </span>
    </button>
  </div>

  <Button
    variant="outline"
    size="xs"
    class="shrink-0 justify-start"
    onclick={() => createLayer()}
    data-testid="layer-create"
  >
    <Plus class="size-3.5" />
    新建图层
  </Button>
</div>

<!-- 删除确认（层内块随层移出设计） -->
<Dialog.Root open={deleteConfirmId !== null} onOpenChange={(open) => !open && (deleteConfirmId = null)}>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title>删除图层「{deleteTarget?.name}」？</Dialog.Title>
      <Dialog.Description>
        层内 {memberCounts.get(deleteTarget?.id ?? '') ?? 0}
        块将随层移出设计（不再参与排布/统计/导出）。此操作可撤销。
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (deleteConfirmId = null)} data-testid="layer-delete-cancel">
        取消
      </Button>
      <Button
        size="sm"
        onclick={() => {
          if (deleteConfirmId !== null) {
            dispatchStudioOp({ t: 'layer.delete', layerId: deleteConfirmId })
          }
          deleteConfirmId = null
        }}
        data-testid="layer-delete-confirm"
      >
        删除
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
