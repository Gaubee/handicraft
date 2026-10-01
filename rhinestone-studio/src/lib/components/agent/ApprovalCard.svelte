<!--
ApprovalCard.svelte — 审批请求卡片（W3.1：approval-request 帧 → 批准/拒绝 → session.answer）。
grant/nonce 不出现在任何帧载荷（design §3.6）——卡片只呈现 proposalId/摘要/预览引用。
pending=false 时为已处理态（按钮消失，语义由后续 approval-resolved 帧表达）。
[product-polish-w2 T3] 审批卡入 InputGroup（zStack 当前卡）：
- inline=true：输入卡内嵌形态（全宽——栈卡不留转录流的 85% 居中留白）；
- expired + inline：操作区变「跳过」（本地清卡不入审批账——服务端 TTL 已过
  consume 必拒 proposal-expired；skip 回调由外层清 UI 队列）；
- showActions=false：信息态（动作面归输入卡栈——转录流不双开操作面）。
-->
<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { Frame } from '@handicraft/contracts'
  import { answerApproval, isAgentSending } from '$lib/agentApi/store.svelte'

  let {
    frame,
    pending,
    inline = false,
    showActions = true,
    onskip = null,
  }: {
    frame: Extract<Frame, { kind: 'approval-request' }>
    pending: boolean
    /** 输入卡内嵌形态（zStack 当前卡——全宽+过期跳过位）。 */
    inline?: boolean
    /** 动作面开关（false=转录流抑制态：栈在场时转录不双开批准/拒绝）。 */
    showActions?: boolean
    /** 跳过回调（inline 过期卡的本地清卡——不入审批账）。 */
    onskip?: (() => void) | null
  } = $props()

  let answering = $state(false)

  const expired = $derived(new Date(frame.payload.expiresAt).getTime() < Date.now())

  // [P0-3 真链走查] 审批卡显示完整 proposalId（点击复制）——曾只显 8 位截断 ID，
  // 用户/agent 转述截断后 execute 消费 proposal-unknown 死循环。剪贴板不可用
  // （非安全上下文/权限拒）时降级为可选中复制（文本仍在卡上，不再是短码）。
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
  class="border-border/80 bg-card rounded-xl border p-3.5 shadow-sm {inline ? 'w-full' : 'mx-auto w-full max-w-[85%]'}"
  data-testid="approval-card"
>
  <div class="mb-2 flex items-center gap-2">
    <Badge variant="outline" class="font-mono text-xs">{frame.payload.tool}</Badge>
    <!-- [W6 6.2] 归属项目（批准挂项目域——会话标题/sessionId 短码；旧 daemon 帧缺省不显）。 -->
    {#if frame.payload.projectLabel}
      <Badge variant="outline" class="max-w-40 truncate text-xs" data-testid="approval-project-label">
        {frame.payload.projectLabel}
      </Badge>
    {/if}
    {#if pending}
      <Badge variant={expired ? 'destructive' : 'secondary'}>{expired ? '已过期' : '等待你的确认'}</Badge>
    {:else}
      <Badge variant="secondary">已处理</Badge>
    {/if}
    <!-- [P0-3] 完整 proposalId（点击复制）——execute 消费需完整 ID；截断短码会被
         daemon 前缀容错兜住，但完整 ID 一开始就该可取。 -->
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground ml-auto max-w-[55%] break-all text-right font-mono text-[10px] leading-tight"
      data-testid="approval-proposal-id"
      title="proposalId（完整）——点击复制"
      onclick={copyProposalId}
    >{proposalCopied ? 'proposalId 已复制' : `proposal ${frame.payload.proposalId}`}</button>
  </div>
  <p class="text-sm leading-relaxed">{frame.payload.summary}</p>
  <div class="text-muted-foreground mt-2 flex items-center gap-1.5 font-mono text-xs">
    <span>预览 before {frame.payload.preview.before.slice(0, 8)}…</span>
    <span>→</span>
    <span>after {frame.payload.preview.after.slice(0, 8)}…</span>
  </div>
  {#if pending && showActions}
    {#if expired && inline}
      <!-- 过期卡（T3）：操作区变「跳过」——服务端 TTL 已过（consume 必拒），跳过=
           本地清卡不入审批账。 -->
      <div class="mt-3 flex items-center justify-end gap-2">
        <span class="text-muted-foreground mr-auto text-[10px]">该批准已过等待窗口——服务端已失效，可跳过清卡</span>
        <Button size="sm" variant="outline" data-testid="composer-approval-skip" onclick={() => onskip?.()}>
          跳过
        </Button>
      </div>
    {:else if !expired}
      <div class="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" data-testid="approval-reject" disabled={answering} onclick={() => answer(false)}>
          拒绝
        </Button>
        <Button size="sm" data-testid="approval-approve" disabled={answering} onclick={() => answer(true)}>
          {answering ? '提交中…' : '批准应用'}
        </Button>
      </div>
    {/if}
  {/if}
</div>
