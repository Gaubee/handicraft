<!--
StrategyProposalCard.svelte — strategy.design proposal 呈现卡（add-subject-sam-pipeline
P3.2——工具调用卡升级：studio.strategy.design 审批帧 → 逐节点指派表+批准/拒绝）。
指派表=plan 工件结构化投影（nodeId→策略/参数/钻/密度/理由——daemon assignmentTable
同形）；工件内容通道缺席时降级为摘要+提示（ApprovalCard 形态兜底）。批准/拒绝复用
授权 UI 通道（answerApproval——proposalId/requestId 语义与 ApprovalCard 一致）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { Frame } from '@handicraft/contracts'
  import { answerApproval } from '$lib/agentApi/store.svelte'
  import { getStrategyAssignmentRows } from '$lib/strategyDesigner/store.svelte'

  let { frame, pending }: { frame: Extract<Frame, { kind: 'approval-request' }>; pending: boolean } = $props()

  let answering = $state(false)

  const rows = $derived(getStrategyAssignmentRows())
  const expired = $derived(new Date(frame.payload.expiresAt).getTime() < Date.now())

  async function answer(approved: boolean): Promise<void> {
    if (answering) return
    answering = true
    try {
      await answerApproval(frame.payload.requestId, approved)
    } finally {
      answering = false
    }
  }
</script>

<div
  class="border-border/80 bg-card mx-auto w-full max-w-[92%] rounded-xl border p-3.5 shadow-sm"
  data-testid="strategy-proposal-card"
>
  <div class="mb-2 flex flex-wrap items-center gap-2">
    <Badge variant="outline" class="font-mono text-xs">{frame.payload.tool}</Badge>
    {#if pending}
      <Badge variant={expired ? 'destructive' : 'secondary'}>等待你的确认</Badge>
    {:else}
      <Badge variant="secondary">已处理</Badge>
    {/if}
    <span class="text-muted-foreground ml-auto font-mono text-xs">proposal {frame.payload.proposalId.slice(0, 8)}…</span>
  </div>
  <p class="text-sm leading-relaxed">{frame.payload.summary}</p>

  {#if rows.length > 0}
    <div class="border-border/70 mt-2.5 overflow-hidden rounded-lg border" data-testid="strategy-proposal-table">
      <table class="w-full table-fixed text-left text-xs">
        <thead class="bg-muted/70 text-muted-foreground">
          <tr>
            <th class="w-[26%] px-2 py-1.5 font-medium">图层</th>
            <th class="w-[18%] px-2 py-1.5 font-medium">策略</th>
            <th class="px-2 py-1.5 font-medium">参数 / 钻 / 密度</th>
            <th class="w-[28%] px-2 py-1.5 font-medium">理由</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.nodeId)}
            <tr class="border-border/60 border-t align-top" data-testid="strategy-proposal-row" data-node-id={row.nodeId}>
              <td class="px-2 py-1.5">
                <span class="block truncate font-medium" title="{row.objectName} · {row.nodeId}">{row.objectName}</span>
                <span class="text-muted-foreground block truncate font-mono text-[10px]">{row.nodeId}</span>
              </td>
              <td class="px-2 py-1.5">
                <Badge variant={row.strategyKind === 'exclusion' ? 'destructive' : 'secondary'} class="text-[10px]">{row.kindLabel}</Badge>
                {#if row.engineStrategy !== undefined}
                  <span class="text-muted-foreground mt-1 block font-mono text-[10px]" title="引擎显式路由">→ {row.engineStrategy}</span>
                {/if}
              </td>
              <td class="px-2 py-1.5">
                <span class="block truncate font-mono text-[10px]" title={row.paramsSummary} data-testid="strategy-proposal-params-{row.nodeId}">
                  {row.paramsSummary === '' ? '—' : row.paramsSummary}
                </span>
                <span class="mt-0.5 flex items-center gap-1 text-[10px]">
                  {#if row.primaryStone !== null}
                    <span class="size-2 shrink-0 rounded-full border border-black/10" style="background: {row.primaryStone.colorHex}" aria-hidden="true"></span>
                    <span class="truncate">{row.primaryStone.sku}{row.primaryStone.sizeMm !== null ? ` ${row.primaryStone.sizeMm}mm` : ''}</span>
                    {#if row.stoneCount > 1}<span class="text-muted-foreground">+{row.stoneCount - 1}</span>{/if}
                  {:else}
                    <span class="text-muted-foreground">无钻（排除/待定）</span>
                  {/if}
                  {#if row.strategyKind !== 'exclusion'}<span class="text-muted-foreground ml-auto shrink-0 font-mono">{row.densityPerCm2}/cm²</span>{/if}
                </span>
              </td>
              <td class="text-muted-foreground px-2 py-1.5 text-[10px] leading-relaxed" title={row.rationale}>{row.rationale}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-muted-foreground/80 mt-1.5 text-[10px]">指派表=批准即执行真身（逐节点 applyStrategy+引擎校验门）——图层级参数，单钻微调归设计师工作台</p>
  {:else}
    <p class="text-muted-foreground mt-2 rounded-md bg-muted/50 px-2 py-1.5 text-[10px]" data-testid="strategy-proposal-table-missing">
      指派表详表未装载（结构化工件内容通道待接线）——摘要与预览引用如上，详表经 object-tree/strategy-plan 工件核对
    </p>
  {/if}

  <div class="text-muted-foreground mt-2 flex items-center gap-1.5 font-mono text-[10px]">
    <span>预览 before {frame.payload.preview.before.slice(0, 8)}…</span>
    <span>→</span>
    <span>after {frame.payload.preview.after.slice(0, 8)}…</span>
  </div>

  {#if pending}
    <div class="mt-3 flex justify-end gap-2">
      <Button size="sm" variant="outline" data-testid="strategy-proposal-reject" disabled={answering || expired} onclick={() => answer(false)}>
        拒绝
      </Button>
      <Button size="sm" data-testid="strategy-proposal-approve" disabled={answering || expired} onclick={() => answer(true)}>
        {answering ? '提交中…' : '批准执行'}
      </Button>
    </div>
  {/if}
</div>
