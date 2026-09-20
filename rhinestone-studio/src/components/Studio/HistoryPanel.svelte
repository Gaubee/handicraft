<!--
Orthogonal intents (max 2):
1. [2026-09-20 studio-layers 2.7 / improve-paving-workbench 2.2] 左列历史面板（tab 2）：倒序列表
     （最新在上；图标+摘要+组合并展示 = studioOpSummary + groupId 合组）+ ⤺⤻ 按钮（与 ⌘Z/⇧⌘Z
     同源——同一 undoStudioOp/redoStudioOp reducer 入口）+ 深度计数 + 已压实标注 + 空历史态显式空状态。
2. [improve 2.2 PS 游标] 列表条目恒不变：游标（getHistoryCursor）后条目灰显只读（title「已撤销——
     重做可恢复；新修改将覆盖此后记录」）；当前态行（游标-1 位）高亮；撤销/重做只移动游标。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import {
    canRedo,
    canUndo,
    getCompactions,
    getHistoryCursor,
    getOps,
    getUndoDepth,
    redoStudioOp,
    studioOpSummary,
    undoStudioOp,
  } from '$lib/stores/studio.svelte'
  import Redo from '@lucide/svelte/icons/redo'
  import Undo from '@lucide/svelte/icons/undo'
  import History from '@lucide/svelte/icons/history'

  const ops = $derived(getOps())
  const compactions = $derived(getCompactions())
  const depth = $derived(getUndoDepth())
  /** 游标 = 已应用条目数；下标 ≥ cursor 的条目 = 已撤销的前向（灰显只读）。 */
  const cursor = $derived(getHistoryCursor())
  /** 倒序（最新在上）；i 为倒序下标 → 正序下标 = ops.length - 1 - i。 */
  const reversed = $derived([...ops].reverse())
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2" data-testid="history-panel">
  <div class="flex shrink-0 items-center gap-1">
    <Button
      variant="outline"
      size="icon-xs"
      disabled={!canUndo()}
      title="撤销（⌘Z）"
      onclick={() => undoStudioOp()}
      data-testid="history-undo"
    >
      <Undo />
    </Button>
    <Button
      variant="outline"
      size="icon-xs"
      disabled={!canRedo()}
      title="重做（⇧⌘Z）"
      onclick={() => redoStudioOp()}
      data-testid="history-redo"
    >
      <Redo />
    </Button>
    <span class="text-muted-foreground ml-auto font-mono text-[11px] tabular-nums" data-testid="history-depth">
      {ops.length} 条记录 · {depth} 步可撤销
    </span>
  </div>

  {#if compactions.length > 0}
    <p class="text-muted-foreground shrink-0 text-[11px]" data-testid="history-compaction-note">
      已压实 {compactions.reduce((sum: number, c) => sum + (c.to - c.from), 0)} 条更早操作（跨压实边界撤销等价已验证）
    </p>
  {/if}

  {#if reversed.length === 0}
    <div
      class="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-8 text-xs"
      data-testid="history-empty"
    >
      <History class="size-5 opacity-50" aria-hidden="true" />
      <span>尚无操作记录</span>
      <span class="text-[11px] opacity-70">图层/配置/覆写/色板/分块的修改会记录在这里，⌘Z 撤销</span>
    </div>
  {:else}
    <ol class="scrollbar-thin grid min-h-0 flex-1 content-start gap-1 overflow-y-auto pr-0.5" reversed>
      {#each reversed as op, i (ops.length - 1 - i)}
        {@const appliedIndex = ops.length - 1 - i}
        {@const isCurrent = appliedIndex === cursor - 1}
        {@const isForward = appliedIndex >= cursor}
        <li
          class="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs
            {isCurrent ? 'border-primary/60 bg-accent/40' : 'hover:bg-muted/50'}
            {isForward ? 'text-muted-foreground/50 border-dashed' : ''}"
          title={isForward ? '已撤销——重做可恢复；此状态下新修改将覆盖其后记录' : undefined}
          data-testid="history-item"
          data-forward={isForward ? 'true' : undefined}
        >
          <span class="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums {isForward ? '' : 'text-muted-foreground'}">
            {ops.length - i}
          </span>
          <span class="min-w-0 flex-1 truncate">{studioOpSummary(op)}</span>
          {#if 'groupId' in op && op.groupId !== undefined}
            <span class="text-muted-foreground shrink-0 text-[10px]" title="连拖合组（一次撤销）">合组</span>
          {/if}
          {#if isCurrent}
            <span class="text-primary shrink-0 text-[10px]" title="当前状态（游标）">当前</span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>
