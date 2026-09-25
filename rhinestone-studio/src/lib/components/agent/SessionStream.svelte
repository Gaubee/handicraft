<!--
SessionStream.svelte — 会话流（W3.1：帧流实时渲染 + 审批应答 + 结果 + 输入面）。
状态面（八态）：空会话引导 / 流式进行中（活跃任务 running）/ 任务完成（结果卡片）/
取消与清空（confirm 点名）/ storeError 横幅 / 发送 loading 锁 / 审批挂起 /
断线重连提示（连接态非 open 且 rpc）。
-->
<script lang="ts">
  import { tick } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import FrameView from './FrameView.svelte'
  import ResultCard from './ResultCard.svelte'
  import {
    answerApproval,
    cancelActiveTask,
    clearActiveSession,
    getActiveSession,
    getActiveSessionFrames,
    getActiveTask,
    getAgentConnection,
    getAgentError,
    getPendingApproval,
    getSessionResult,
    isAgentCancelling,
    isAgentClearing,
    isAgentSending,
    sendFollowup,
  } from '$lib/agentApi/store.svelte'
  import { clearComposerText, peekComposerText } from '$lib/agentApi/composerOutbox.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import Ban from '@lucide/svelte/icons/ban'
  import Send from '@lucide/svelte/icons/send'
  import Trash2 from '@lucide/svelte/icons/trash-2'

  const session = $derived(getActiveSession())
  const frames = $derived(getActiveSessionFrames())
  const activeTask = $derived(getActiveTask())
  const approval = $derived(getPendingApproval())
  const result = $derived(getSessionResult(session?.id ?? null))
  const running = $derived(activeTask?.status === 'running' || activeTask?.status === 'queued')
  const connection = $derived(getAgentConnection())
  const disconnected = $derived(connection === 'closed' || connection === 'error')

  let draft = $state('')
  let root = $state<HTMLDivElement | null>(null)
  let streamBottom = $state<HTMLDivElement | null>(null)
  let confirmingClear = $state(false)

  $effect(() => {
    frames
    void tick().then(() => {
      // 存在性守卫：jsdom 无 scrollIntoView；卸载后迟到的浮动 tick 不抛未处理拒绝。
      streamBottom?.scrollIntoView?.({ block: 'end' })
    })
  })

  // [add-subject-sam-pipeline P3.2] 策略参数表单指令注入：输入框空=直接置入，
  // 非空=换行追加（用户草稿不覆盖）；消费即清空（单槽——表单逐次显式触发）。
  // 可见性守卫（P3.3-fix）：Agent 与策略设计两个 tab 各挂一个本组件实例（Tabs.Content
  // 同时挂载、非激活侧由 hidden 属性隐藏）——隐藏实例必须让位，否则在策略设计 tab
  // 触发的注入会被 Agent tab 的隐藏输入框抢先消费，用户看不到文本。按 hidden 祖先
  // 判可见（属性查询，jsdom 无布局也成立）；两个实例的 $effect 同 flush 触发，隐藏方
  // return 后激活方照常消费；本组件单实例（移动端）时自身无 hidden 祖先，行为不变。
  $effect(() => {
    const injected = peekComposerText()
    if (injected === null) return
    if (root === null || root.closest('[hidden]') !== null) return
    draft = draft === '' ? injected : `${draft}\n${injected}`
    clearComposerText()
  })

  async function submit(): Promise<void> {
    const text = draft
    if (text.trim() === '' || isAgentSending()) return
    draft = ''
    await sendFollowup(text)
  }

  async function onClear(): Promise<void> {
    if (!confirmingClear) {
      confirmingClear = true
      showToast('再次点击确认清空：会话、任务与私有资源将被回收（分享链接保留）')
      return
    }
    confirmingClear = false
    await clearActiveSession()
  }
</script>

{#if session === null}
  <div class="text-muted-foreground flex h-full items-center justify-center text-sm" bind:this={root}>选择或创建一个会话开始</div>
{:else}
  <div class="flex h-full min-h-0 flex-col" data-testid="agent-stream" bind:this={root}>
    <header class="bg-background/80 flex h-12 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
      <h2 class="truncate text-sm font-semibold" data-testid="agent-stream-title">{session.title}</h2>
      <Badge variant={session.status === 'active' ? 'secondary' : 'outline'}>{session.status}</Badge>
      <div class="ml-auto flex items-center gap-1.5">
        {#if running}
          <Button size="sm" variant="ghost" data-testid="agent-cancel" disabled={isAgentCancelling()} onclick={cancelActiveTask}>
            <Ban class="size-3.5" aria-hidden="true" />
            取消任务
          </Button>
        {/if}
        <Button
          size="sm"
          variant="ghost"
          data-testid="agent-clear"
          class="text-destructive hover:text-destructive"
          disabled={isAgentClearing()}
          onclick={onClear}
        >
          <Trash2 class="size-3.5" aria-hidden="true" />
          清空会话
        </Button>
      </div>
    </header>

    {#if getAgentError()}
      <div class="border-destructive/30 bg-destructive/10 text-destructive px-4 py-1.5 text-xs" data-testid="agent-error">
        {getAgentError()}
      </div>
    {/if}
    {#if disconnected}
      <div class="bg-muted text-muted-foreground px-4 py-1.5 text-xs" data-testid="agent-disconnected">
        连接已断开，正在重连——恢复后将按已收帧游标自动回放补齐
      </div>
    {/if}

    <div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
      {#if frames.length === 0}
        <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 text-center text-sm">
          <p class="font-medium">描述你想做的贴钻作品</p>
          <p class="text-xs">例如：帮我把这张爱心线稿排满红色圆钻，密度高一点</p>
        </div>
      {/if}
      {#each frames as frame (frame.seq + frame.kind + frame.ts)}
        <FrameView {frame} pendingRequestId={approval?.requestId ?? null} />
      {/each}
      {#if result && (activeTask?.status === 'done' || frames.some((f) => f.kind === 'done'))}
        <ResultCard {result} />
      {/if}
      <div bind:this={streamBottom}></div>
    </div>

    <footer class="border-t p-3">
      <div class="flex items-end gap-2">
        <textarea
          bind:value={draft}
          data-testid="agent-composer"
          rows="2"
          placeholder={running ? '任务进行中，可稍后续写…' : '描述你的贴钻需求'}
          class="border-input bg-background focus-visible:ring-ring min-h-0 flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-50"
          disabled={session.status !== 'active'}
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        ></textarea>
        <Button size="sm" data-testid="agent-send" disabled={draft.trim() === '' || isAgentSending() || session.status !== 'active'} onclick={submit}>
          <Send class="size-3.5" aria-hidden="true" />
          {isAgentSending() ? '发送中…' : '发送'}
        </Button>
      </div>
    </footer>
  </div>
{/if}
