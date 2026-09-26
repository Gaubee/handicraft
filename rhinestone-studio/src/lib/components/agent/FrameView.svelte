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
  import StrategyProposalCard from '$lib/components/strategy/StrategyProposalCard.svelte'
  import { STRATEGY_DESIGN_TOOL } from '$lib/strategyDesigner/store.svelte'
  import { openStudioTask } from '$lib/stores/view.svelte'
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right'

  let { frame, pendingRequestId = null, taskId = null }: { frame: Frame; pendingRequestId?: string | null; taskId?: string | null } = $props()

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
  {#if frame.payload.tool === STRATEGY_DESIGN_TOOL}
    <!-- [add-subject-sam-pipeline P3.2] 工具调用卡升级：strategy.design proposal=逐节点指派表 -->
    <StrategyProposalCard {frame} pending={frame.payload.requestId === pendingRequestId} />
  {:else}
    <ApprovalCard {frame} pending={frame.payload.requestId === pendingRequestId} />
  {/if}
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
  <!-- [add-task-detail-layer-workbench 2.1] done 卡「打开任务详情」：任务归属经 SessionStream
       透传（taskId）——置 studio 任务上下文+切视图，StudioView 路由进任务详情工作台。 -->
  <div class="my-2 flex flex-col items-center gap-1.5" data-testid="frame-done">
    <div class="flex w-full items-center justify-center gap-2">
      <span class="bg-border h-px flex-1"></span>
      <span class="text-muted-foreground text-xs">任务完成 · {time}</span>
      <span class="bg-border h-px flex-1"></span>
    </div>
    {#if taskId !== null}
      <button
        type="button"
        onclick={() => openStudioTask(taskId)}
        data-testid="open-task-detail"
        class="border-border text-foreground hover:bg-muted inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors"
        title="在排钻工作台打开该任务：图层管理/拆层/策略直改"
      >
        <SquareArrowOutUpRight class="size-3.5" aria-hidden="true" />
        打开任务详情
      </button>
    {/if}
  </div>
{:else if frame.kind === 'error'}
  <div
    class="border-destructive/30 bg-destructive/10 text-destructive mx-auto max-w-[85%] rounded-lg border px-3 py-2 text-sm"
    data-testid="frame-error"
  >
    {frame.payload.message}
  </div>
{/if}
