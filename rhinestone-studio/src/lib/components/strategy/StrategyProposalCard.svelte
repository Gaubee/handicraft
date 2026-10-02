<!--
StrategyProposalCard.svelte — strategy.design proposal 呈现卡（add-subject-sam-pipeline
P3.2——工具调用卡升级：studio.strategy.design 审批帧 → 逐节点指派表+批准/拒绝）。
指派表=plan 工件结构化投影（nodeId→策略/参数/钻/密度/理由——daemon assignmentTable
同形）；工件内容通道缺席时降级为摘要+提示（ApprovalCard 形态兜底）。批准/拒绝复用
授权 UI 通道（answerApproval——proposalId/requestId 语义与 ApprovalCard 一致）。
[w17-critic T1 人话翻译壳] 头部=结构化人话摘要（「方案：N 处指派 · 候选钻 M 款 ·
K 条提醒」——计数由指派行派生，不透传 LLM 黑话）；管线细节（LLM 英文摘要/指派
明细表/预览 hash）默认收起为「查看详情」折叠——批准/拒绝常驻折叠态外（高频动
作不藏二级）；hash/标识类降 title 悬浮。
[w19-critic P2] ①工件自举：$effect 续装 syncStrategyArtifacts（此前仅策略设计视图
挂载时装载——Agent 会话页转录/输入栈里的本卡拿不到指派行，人话摘要降级）；②inline
形态（输入卡审批 zStack 当前卡——全宽+过期「跳过」位，与 ApprovalCard 同门）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { Frame } from '@handicraft/contracts'
  import { answerApproval } from '$lib/agentApi/store.svelte'
  import { getStrategyAssignmentRows, syncStrategyArtifacts } from '$lib/strategyDesigner/store.svelte'
  import { toolDisplayName } from '$lib/agentApi/toolNames'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'

  let {
    frame,
    pending,
    /** [product-polish-w2 T3] 动作面开关（false=转录抑制态：审批栈在场时不双开批准/拒绝）。 */
    showActions = true,
    /** 输入卡内嵌形态（[w19-critic P2] zStack 当前卡——全宽+过期跳过位）。 */
    inline = false,
    /** 跳过回调（inline 过期卡的本地清卡——不入审批账）。 */
    onskip = null,
    /** [Owner 2026-10-02] 重新发起（inline 过期卡的一键发送提示词——清卡+followup 指令）。 */
    onretry = null,
  }: {
    frame: Extract<Frame, { kind: 'approval-request' }>
    pending: boolean
    showActions?: boolean
    inline?: boolean
    onskip?: (() => void) | null
    /** 重新发起回调（同 onskip 只在过期 inline 卡出现；发送链由外层承载）。 */
    onretry?: (() => void) | null
  } = $props()

  let answering = $state(false)
  /** 管线细节折叠（w17-critic：18 节点明细表默认不淹没对话流——点开细看）。 */
  let detailsOpen = $state(false)

  // [w19-critic P2] 工件自举：refs（帧流响应式）变化即续装——本卡在任何宿主
  // （转录流/输入卡 zStack）挂载都可拿到指派行（幂等——loadedKey 守卫重复装载）。
  $effect(() => {
    syncStrategyArtifacts()
  })

  const rows = $derived(getStrategyAssignmentRows())
  const expired = $derived(new Date(frame.payload.expiresAt).getTime() < Date.now())

  /** 人话头部计数（单源派生自指派行）：N 处指派 / M 款候选钻 / K 条提醒。 */
  const summaryLine = $derived.by(() => {
    if (rows.length === 0) return '方案已生成——明细见详情'
    const stoneKinds = new Set(
      rows.map((row) => row.primaryStone?.sku).filter((sku): sku is string => sku !== undefined),
    )
    const reminders = rows.filter((row) => row.strategyKind === 'exclusion' || row.primaryStone === null).length
    const parts = [`方案：${rows.length} 处指派`, `候选钻 ${stoneKinds.size} 款`]
    if (reminders > 0) parts.push(`${reminders} 条提醒`)
    return parts.join(' · ')
  })

  // [P0-3 真链走查] 完整 proposalId（点击复制）——与 ApprovalCard 同面：截断短码
  // 曾致 agent 消费 proposal-unknown 死循环。
  let proposalCopied = $state(false)

  async function copyProposalId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(frame.payload.proposalId)
      proposalCopied = true
      setTimeout(() => (proposalCopied = false), 1500)
    } catch {
      /* 降级：完整 ID 已可见可选中 */
    }
  }

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
  class="border-border/80 bg-card rounded-xl border p-3.5 shadow-sm {inline ? 'w-full' : 'mx-auto w-full max-w-[92%]'}"
  data-testid="strategy-proposal-card"
>
  <!-- 头部：人话摘要行（计数派生）+ 状态 + 详情折叠开关。 -->
  <div class="flex flex-wrap items-center gap-2">
    <Badge variant="outline" class="text-xs" title={`工具调用名：${frame.payload.tool}`}>{toolDisplayName(frame.payload.tool)}</Badge>
    {#if pending}
      <Badge variant={expired ? 'destructive' : 'secondary'}>{expired ? '已过期' : '等待你的确认'}</Badge>
    {:else}
      <Badge variant="secondary">已处理</Badge>
    {/if}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground ml-auto max-w-[55%] break-all text-right font-mono text-[10px] leading-tight"
      data-testid="strategy-proposal-id"
      title="proposalId（完整）——点击复制"
      onclick={copyProposalId}
    >{proposalCopied ? 'proposalId 已复制' : `proposal ${frame.payload.proposalId}`}</button>
  </div>
  <p class="mt-1.5 text-sm leading-relaxed" data-testid="strategy-proposal-summary">{summaryLine}</p>

  {#if rows.length > 0}
    <!-- 折叠开关：管线细节（LLM 摘要+指派明细+预览标识）默认收起。 -->
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground mt-1.5 inline-flex items-center gap-1 text-xs font-medium transition-colors"
      aria-expanded={detailsOpen}
      data-testid="strategy-proposal-details-toggle"
      onclick={() => (detailsOpen = !detailsOpen)}
    >
      {detailsOpen ? '收起详情' : '查看详情'}
      <ChevronDown class="size-3.5 transition-transform {detailsOpen ? 'rotate-180' : ''}" aria-hidden="true" />
    </button>

    {#if detailsOpen}
      <div class="mt-2 space-y-2" data-testid="strategy-proposal-details">
        <!-- LLM 文字摘要（模型输出原样——黑话不加工，折叠态承载）。 -->
        <p class="text-muted-foreground rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-relaxed" data-testid="strategy-proposal-llm-summary">{frame.payload.summary}</p>

        <div class="border-border/70 overflow-hidden rounded-lg border" data-testid="strategy-proposal-table">
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
                      <span class="text-muted-foreground mt-1 block text-[10px]" title="引擎显式路由：{row.engineStrategy}">→ {toolDisplayName(row.engineStrategy)}</span>
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
        <p class="text-muted-foreground/80 mt-1.5 text-[10px]">批准后按此方案逐层排钻——图层级参数，单钻微调归设计师工作台</p>

        <!-- 预览标识：hash 降 title 悬浮（w17-critic：标识类不占正文行）。 -->
        <p
          class="text-muted-foreground/70 text-[10px]"
          title="预览内容寻址引用：before {frame.payload.preview.before.slice(0, 8)}… → after {frame.payload.preview.after.slice(0, 8)}…"
          data-testid="strategy-proposal-preview"
        >
          已生成修改前后对比预览
        </p>
      </div>
    {/if}
  {:else}
    <!-- 工件通道缺席降级（ApprovalCard 形态兜底）：摘要+提示直出（无折叠——
         没有可藏的明细，缺提示本身就该被看见）。 -->
    <p class="text-muted-foreground mt-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-relaxed">{frame.payload.summary}</p>
    <p class="text-muted-foreground mt-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-[10px]" data-testid="strategy-proposal-table-missing">
      指派明细未装载——摘要与预览引用如上，详表经 object-tree/strategy-plan 工件核对
    </p>
  {/if}

  {#if pending && showActions}
    {#if expired && inline}
      <!-- 过期卡（[w19-critic P2] zStack inline 形态——与 ApprovalCard 同门）：
           [Owner 2026-10-02] 操作区=「重新发起」（主位——一键发送提示词：清卡+
           followup 指令让模型重新 propose）+「跳过」（本地清卡不入审批账；服务端
           TTL 已过 consume 必拒）。 -->
      <div class="mt-3 flex items-center justify-end gap-2">
        <span class="text-muted-foreground mr-auto text-[10px]">该批准已过等待窗口——服务端已失效，可重新发起或跳过</span>
        <Button size="sm" variant="outline" data-testid="composer-approval-skip" onclick={() => onskip?.()}>
          跳过
        </Button>
        {#if onretry !== null}
          <Button size="sm" data-testid="composer-approval-retry" title="关闭本卡并向会话发送指令，让 AI 重新发起该审批" onclick={() => onretry?.()}>
            重新发起
          </Button>
        {/if}
      </div>
    {:else if !expired}
      <div class="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" data-testid="strategy-proposal-reject" disabled={answering} onclick={() => answer(false)}>
          拒绝
        </Button>
        <Button size="sm" data-testid="strategy-proposal-approve" disabled={answering} onclick={() => answer(true)}>
          {answering ? '提交中…' : '批准执行'}
        </Button>
      </div>
    {/if}
  {/if}
</div>
