<!--
FrameView.svelte — 会话流单帧渲染（W3.1）。
正交意图（单帧 kind → 视图；审批交互归 ApprovalCard、结果归 ResultCard）：
  [1] transcript 三角色气泡（user/assistant/tool）。
  [2] progress 进度条（ratio 可缺省）。
  [3] approval-request/resolved 卡片线。
  [4] artifact 产物 chip / done 终态 / error 破坏性文本。
-->
<script lang="ts">
  import type { Frame } from '@handicraft/contracts'
  import ApprovalCard from './ApprovalCard.svelte'

  let { frame, pendingRequestId = null }: { frame: Frame; pendingRequestId?: string | null } = $props()

  const time = $derived(new Date(frame.ts).toLocaleTimeString('zh-CN', { hour12: false }))
</script>

{#if frame.kind === 'transcript'}
  {#if frame.payload.role === 'user'}
    <div class="flex justify-end" data-testid="frame-transcript-user">
      <div class="bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap">
        {frame.payload.text}
      </div>
    </div>
  {:else if frame.payload.role === 'assistant'}
    <div class="flex justify-start" data-testid="frame-transcript-assistant">
      <div class="bg-muted max-w-[80%] rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm whitespace-pre-wrap">
        {frame.payload.text}
      </div>
    </div>
  {:else}
    <div class="text-muted-foreground mx-auto max-w-[85%] text-center font-mono text-xs" data-testid="frame-transcript-tool">
      <span class="bg-muted/60 rounded px-1.5 py-0.5">{frame.payload.text}</span>
    </div>
  {/if}
{:else if frame.kind === 'progress'}
  <div class="mx-auto max-w-[60%]" data-testid="frame-progress">
    <div class="text-muted-foreground mb-1 flex items-center justify-between text-xs">
      <span>{frame.payload.text ?? '进行中'}</span>
      {#if frame.payload.ratio !== undefined}
        <span>{Math.round(frame.payload.ratio * 100)}%</span>
      {/if}
    </div>
    <div class="bg-muted h-1.5 overflow-hidden rounded-full">
      {#if frame.payload.ratio !== undefined}
        <div class="bg-primary h-full rounded-full transition-all" style="width: {frame.payload.ratio * 100}%"></div>
      {:else}
        <div class="bg-primary/60 h-full w-1/3 animate-pulse rounded-full"></div>
      {/if}
    </div>
  </div>
{:else if frame.kind === 'approval-request'}
  <ApprovalCard {frame} pending={frame.payload.requestId === pendingRequestId} />
{:else if frame.kind === 'approval-resolved'}
  <div class="text-muted-foreground text-center text-xs" data-testid="frame-approval-resolved">
    {frame.payload.approved ? '已批准该修改' : '已拒绝该修改'} · {time}
  </div>
{:else if frame.kind === 'artifact'}
  <div class="bg-muted/50 mx-auto flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs" data-testid="frame-artifact">
    <span class="font-medium">{frame.payload.name ?? '产物'}</span>
    {#if frame.payload.blobRef}
      <span class="text-muted-foreground font-mono">{frame.payload.blobRef.slice(0, 10)}…</span>
    {/if}
  </div>
{:else if frame.kind === 'done'}
  <div class="my-2 flex items-center justify-center gap-2" data-testid="frame-done">
    <span class="bg-border h-px flex-1"></span>
    <span class="text-muted-foreground text-xs">任务完成 · {time}</span>
    <span class="bg-border h-px flex-1"></span>
  </div>
{:else if frame.kind === 'error'}
  <div
    class="border-destructive/30 bg-destructive/10 text-destructive mx-auto max-w-[85%] rounded-lg border px-3 py-2 text-sm"
    data-testid="frame-error"
  >
    {frame.payload.message}
  </div>
{/if}
