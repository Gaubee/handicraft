<!--
Orthogonal intents (max 3):
1. [2026-09-20 studio-layers 2.7] 左列图层面板（行结构 [眼睛][层名双击重命名][钻数 mono][状态点
     ◷/～/！/空] + 选择序徽标 ①②③ + 行尾菜单[重命名/合并到本层/删除·兜底层禁用] + [+ 新建图层] +
     背景层钉底行）：选择动作 selectLayer replace/toggle/range + selectAllLayers（Cmd+A 由容器键盘处理）；
     删除 = 确认 Dialog「层内 N 块将随层移出设计」。
2. [键盘] ↑↓ 单选移动 / Space 切眼睛（P0 兜底——画布容差命中 = P1 入口验收门）。
3. [状态点] layerComputeStatus（stale=标脏待重算 ～ / error ！ / empty 空 / computing ◷ / ok 无标）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import {
    clearStaleOverrideNotice,
    getBackgroundObservation,
    getBlocks,
    getLayers,
    getLayerResult,
    getSelectionOrder,
    getStaleOverrideNotice,
    isLayerSelected,
    layerComputeStatus,
    selectAllLayers,
    selectBackground,
    selectLayer,
    selectionBadgeOf,
    setLayerVisible,
  } from '$lib/stores/studio.svelte'
  import { dispatchStudioOp } from '$lib/studio/history.svelte'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import MoreHorizontal from '@lucide/svelte/icons/more-horizontal'
  import Plus from '@lucide/svelte/icons/plus'

  const layers = $derived(getLayers())
  const blocks = $derived(getBlocks())
  const background = $derived(getBackgroundObservation())
  const staleNotice = $derived(getStaleOverrideNotice())

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

  const SOURCE_LABELS: Record<string, string> = { none: '无', painting: '数字油画', reference: '参考原图' }

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

  /** 合并到本层：锚点=本层，其余选中层并入（多选 ≥2 时可用）。 */
  function mergeInto(layerId: string): void {
    const from = getSelectionOrder().filter((id) => id !== layerId)
    if (from.length === 0) return
    dispatchStudioOp({ t: 'layer.merge', intoLayerId: layerId, fromLayerIds: from })
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
      <div
        class="group flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors
          {isLayerSelected(layer.id) ? 'border-primary bg-accent/50' : 'hover:bg-muted/50'}"
        role="option"
        tabindex={-1}
        aria-selected={isLayerSelected(layer.id)}
        data-testid="layer-row-{layer.id}"
        data-layer-id={layer.id}
        onclick={(e) => selectLayer(layer.id, e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'replace')}
        onkeydown={onKeydown}
      >
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
