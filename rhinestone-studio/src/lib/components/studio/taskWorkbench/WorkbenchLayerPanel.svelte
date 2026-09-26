<!--
WorkbenchLayerPanel.svelte — 图层管理左面板（add-task-detail-layer-workbench 2.2/2.3）。
StrategyLayerTree 的可编辑版：显隐/选中/inline 重命名（layer.rename RPC）+
拆分层（提示输入→layer.split→子层入树+自动选中新子层；loading/失败态可重试）+
蒙版可视化开关（画布叠加半透明）。层级徽标/参数摘要沿策略设计器同式。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { summarizeParams } from '$lib/strategyDesigner/paramsSchema'
  import {
    getRenameError,
    getSelectedNodeId,
    getShowMasks,
    getSplitError,
    getWorkbenchLayerRows,
    getNodeOf,
    isNodeVisible,
    isSplitting,
    renameLayer,
    selectNode,
    setShowMasks,
    splitLayer,
    toggleNodeVisible,
    type WorkbenchLayerRow,
  } from './store.svelte'
  import Ban from '@lucide/svelte/icons/ban'
  import Check from '@lucide/svelte/icons/check'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Scissors from '@lucide/svelte/icons/scissors'
  import X from '@lucide/svelte/icons/x'

  const rows = $derived(getWorkbenchLayerRows())
  const selectedId = $derived(getSelectedNodeId())
  const selectedNode = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const splitting = $derived(isSplitting())
  const splitError = $derived(getSplitError())
  const showMasks = $derived(getShowMasks())

  // ---- inline 重命名（Enter 提交 / Esc 取消；失败驻留错误供重试） ----
  let renamingId = $state<string | null>(null)
  let renameText = $state('')
  let renameInput = $state<HTMLInputElement | null>(null)

  // 进入编辑态聚焦（a11y：编程聚焦替代 autofocus 属性）
  $effect(() => {
    if (renamingId !== null) renameInput?.focus()
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

  function kindBadgeVariant(assignment: WorkbenchLayerRow['assignment']): 'default' | 'secondary' | 'outline' | 'destructive' {
    if (assignment === null) return 'outline'
    if (assignment.strategyKind === 'exclusion') return 'destructive'
    return 'secondary'
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="workbench-layer-panel">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">图层管理</span>
    <span class="text-muted-foreground font-mono text-[10px]">{rows.length} 节点</span>
    <label class="text-muted-foreground ml-auto flex items-center gap-1 text-[10px]" title="画布叠加各层掩膜（半透明）——inline mask 行程渲染">
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
        class="group rounded-md px-1 py-1 transition-colors {row.node.id === selectedId ? 'bg-accent' : 'hover:bg-accent/50'}"
        data-testid="workbench-layer-row"
        data-node-id={row.node.id}
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
</div>
