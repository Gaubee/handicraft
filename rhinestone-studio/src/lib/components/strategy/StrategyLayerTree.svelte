<!--
StrategyLayerTree.svelte — 图层面板（add-subject-sam-pipeline P3.2）。
ObjectTree 层级树（StonesTreeNav 递归先例）：每层行内=策略 kind 徽标/参数摘要/
预览开关（逐节点显隐）/drillWorthy 标记；行点击=选中（参数表单联动）。
层级节点（有子）不承载指派——「未指派（层级）」muted 徽标。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import {
    getStrategyLayerRows,
    isNodeVisible,
    selectStrategyNode,
    getSelectedNodeId,
    toggleNodeVisible,
    type LayerRow,
  } from '$lib/strategyDesigner/store.svelte'
  import { summarizeParams } from '$lib/strategyDesigner/paramsSchema'
  import Ban from '@lucide/svelte/icons/ban'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'

  const rows = $derived(getStrategyLayerRows())
  const selectedId = $derived(getSelectedNodeId())

  function kindBadgeVariant(assignment: LayerRow['assignment']): 'default' | 'secondary' | 'outline' | 'destructive' {
    if (assignment === null) return 'outline'
    if (assignment.strategyKind === 'exclusion') return 'destructive'
    return 'secondary'
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="strategy-layer-tree">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">图层树</span>
    <span class="text-muted-foreground font-mono text-[10px]">{rows.length} 节点</span>
    <span class="text-muted-foreground ml-auto text-[10px]">预览开关=逐节点显隐</span>
  </div>

  <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1.5">
    {#if rows.length === 0}
      <p class="text-muted-foreground px-2 py-6 text-center text-xs" data-testid="strategy-layer-empty">
        无 object-tree 工件——图层树待识图旅程产出
      </p>
    {/if}
    {#each rows as row (row.node.id)}
      <div
        class="group rounded-md px-1 py-1 transition-colors {row.node.id === selectedId ? 'bg-accent' : 'hover:bg-accent/50'}"
        data-testid="strategy-layer-row"
        data-node-id={row.node.id}
        style="padding-left: {4 + row.depth * 12}px"
      >
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            onclick={() => selectStrategyNode(row.node.id === selectedId ? null : row.node.id)}
            class="min-w-0 flex-1 truncate text-left text-xs font-medium {row.node.id === selectedId ? 'text-accent-foreground' : ''}"
            data-testid="strategy-layer-select-{row.node.id}"
            aria-pressed={row.node.id === selectedId}
            title="{row.node.objectName}（{row.node.category}·{row.node.effectiveMm.toFixed(1)}mm）"
          >
            {row.node.objectName}
          </button>
          {#if !row.node.drillWorthy}
            <Ban class="text-destructive size-3 shrink-0" aria-hidden="true" data-testid="strategy-layer-excluded-{row.node.id}" title="不值得贴（drillWorthy=false）" />
          {/if}
          <Badge variant={kindBadgeVariant(row.assignment)} class="shrink-0 px-1.5 text-[10px]" data-testid="strategy-layer-kind-{row.node.id}">
            {row.assignment === null ? (row.node.children.length > 0 ? '层级' : '未指派') : row.assignment.strategyKind}
          </Badge>
          <button
            type="button"
            onclick={() => toggleNodeVisible(row.node.id)}
            class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
            data-testid="strategy-layer-visible-{row.node.id}"
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
        </div>
        {#if row.assignment !== null}
          <p class="text-muted-foreground truncate pl-1 font-mono text-[10px]" data-testid="strategy-layer-params-{row.node.id}" title={summarizeParams(row.assignment.strategyKind, row.assignment.params)}>
            {summarizeParams(row.assignment.strategyKind, row.assignment.params)} · {row.assignment.densityPerCm2}/cm²
          </p>
        {/if}
      </div>
    {/each}
  </div>
</div>
