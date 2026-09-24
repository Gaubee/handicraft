<!--
ApprovalCard.svelte — 审批请求卡片（W3.1：approval-request 帧 → 批准/拒绝 → session.answer）。
grant/nonce 不出现在任何帧载荷（design §3.6）——卡片只呈现 proposalId/摘要/预览引用。
pending=false 时为已处理态（按钮消失，语义由后续 approval-resolved 帧表达）。
-->
<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { Frame } from '@handicraft/contracts'
  import { answerApproval, isAgentSending } from '$lib/agentApi/store.svelte'

  let { frame, pending }: { frame: Extract<Frame, { kind: 'approval-request' }>; pending: boolean } = $props()

  let answering = $state(false)

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
  class="border-border/80 bg-card mx-auto w-full max-w-[85%] rounded-xl border p-3.5 shadow-sm"
  data-testid="approval-card"
>
  <div class="mb-2 flex items-center gap-2">
    <Badge variant="outline" class="font-mono text-xs">{frame.payload.tool}</Badge>
    {#if pending}
      <Badge variant={expired ? 'destructive' : 'secondary'}>等待你的确认</Badge>
    {:else}
      <Badge variant="secondary">已处理</Badge>
    {/if}
    <span class="text-muted-foreground ml-auto font-mono text-xs">proposal {frame.payload.proposalId.slice(0, 8)}…</span>
  </div>
  <p class="text-sm leading-relaxed">{frame.payload.summary}</p>
  <div class="text-muted-foreground mt-2 flex items-center gap-1.5 font-mono text-xs">
    <span>预览 before {frame.payload.preview.before.slice(0, 8)}…</span>
    <span>→</span>
    <span>after {frame.payload.preview.after.slice(0, 8)}…</span>
  </div>
  {#if pending}
    <div class="mt-3 flex justify-end gap-2">
      <Button size="sm" variant="outline" data-testid="approval-reject" disabled={answering || expired} onclick={() => answer(false)}>
        拒绝
      </Button>
      <Button size="sm" data-testid="approval-approve" disabled={answering || expired} onclick={() => answer(true)}>
        {answering ? '提交中…' : '批准应用'}
      </Button>
    </div>
  {/if}
</div>
