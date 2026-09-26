<!--
SessionStream.svelte — 会话流（W3.1：帧流实时渲染 + 审批应答 + 结果 + 输入面）。
状态面（八态）：空会话引导 / 流式进行中（活跃任务 running）/ 任务完成（结果卡片）/
取消与清空（confirm 点名）/ storeError 横幅 / 发送 loading 锁 / 审批挂起 /
断线重连提示（连接态非 open 且 rpc）。
composer 三通道（add-agent-three-channel 2.2，对齐 shufa b6cec8a ComposerCard）：
running 空输入=发送位变停止按钮（tasks.stop——打断≠取消）；running 有输入=Enter 排队
（反馈条「已排队——当前轮结束后自动开跑」）+ Zap 引导按钮（steer 立即投递当前任务）。
队列面板（2.3）+ 暂离编辑（编辑态发送位变确认/Esc 取消）见 QueuePanel。
-->
<script lang="ts">
  import { tick } from 'svelte'
  import type { Snippet } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import FrameView from './FrameView.svelte'
  import QueuePanel from './QueuePanel.svelte'
  import ResultCard from './ResultCard.svelte'
  import {
    answerApproval,
    beginAgentQueueEdit,
    cancelActiveTask,
    cancelAgentQueueEdit,
    clearActiveSession,
    clearAgentQueue,
    confirmAgentQueueEdit,
    getActiveSession,
    getActiveSessionFrames,
    getActiveSessionTaskFrames,
    getActiveTask,
    getAgentConnection,
    getAgentError,
    getAgentQueue,
    getAgentQueueEditingId,
    getPendingApproval,
    getSessionResult,
    isAgentCancelling,
    isAgentClearing,
    isAgentSending,
    removeAgentQueueItem,
    sendFollowup,
    stopActiveTask,
  } from '$lib/agentApi/store.svelte'
  import { clearComposerText, peekComposerText } from '$lib/agentApi/composerOutbox.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import Ban from '@lucide/svelte/icons/ban'
  import Check from '@lucide/svelte/icons/check'
  import Send from '@lucide/svelte/icons/send'
  import Square from '@lucide/svelte/icons/square'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import X from '@lucide/svelte/icons/x'
  import Zap from '@lucide/svelte/icons/zap'

  // [add-workbench-pro 1.4] 顶栏扩展位（可选 snippet——AgentView 注入移动端「详情」
  // 按钮唤起任务详情 Sheet；策略设计器等其余挂载点不传=零变化）。
  let { headerAction }: { headerAction?: Snippet } = $props()

  const session = $derived(getActiveSession())
  const frames = $derived(getActiveSessionFrames())
  const taskFrameGroups = $derived(getActiveSessionTaskFrames())
  const activeTask = $derived(getActiveTask())
  const approval = $derived(getPendingApproval())
  const result = $derived(getSessionResult(session?.id ?? null))
  const running = $derived(activeTask?.status === 'running' || activeTask?.status === 'queued')
  const connection = $derived(getAgentConnection())
  const disconnected = $derived(connection === 'closed' || connection === 'error')
  const queueItems = $derived(getAgentQueue())
  const queueEditingId = $derived(getAgentQueueEditingId())

  let draft = $state('')
  let root = $state<HTMLDivElement | null>(null)
  let streamBottom = $state<HTMLDivElement | null>(null)
  let confirmingClear = $state(false)
  /** 本实例的编辑会话（进入时回填文本；queueEditingId 为全局冻结标记）。 */
  let editingActive = $state(false)

  // 通道反馈条（三通道 2.2，对齐 shufa W10a inline notice）：3s 自清。
  let noticeText = $state<string | null>(null)
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  function notice(message: string): void {
    noticeText = message
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => (noticeText = null), 3000)
  }

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

  /**
   * 提交（三通道 2.2）：编辑态=确认修改；running+常规=排队（store 持有外环+反馈条）；
   * running+steer=引导（立即投递当前任务）；idle=常规发送。
   */
  async function submit(mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    const text = draft
    if (text.trim() === '' || isAgentSending()) return
    if (editingActive) {
      draft = ''
      editingActive = false
      confirmAgentQueueEdit(text)
      return
    }
    const wasRunning = running
    draft = ''
    await sendFollowup(text, mode)
    if (wasRunning) {
      notice(mode === 'steer' ? '已引导当前轮——下一步即生效' : '已排队——当前轮结束后自动开跑')
    }
  }

  // ------------------------------------------------------------ 队列编辑（W10b 暂离编辑）

  /** 进入编辑：输入框有未发送内容拒绝（Owner 设计）；文本回填，全局冻结自动开跑。 */
  function onQueueEdit(id: string): void {
    if (editingActive) return
    if (draft.trim() !== '') {
      showToast('输入框有未发送内容——发送或清空后再编辑排队消息')
      return
    }
    const text = beginAgentQueueEdit(id)
    if (text === null) return
    draft = text
    editingActive = true
  }

  function cancelQueueEdit(): void {
    draft = ''
    editingActive = false
    cancelAgentQueueEdit()
  }

  function onClear(): Promise<void> {
    if (!confirmingClear) {
      confirmingClear = true
      showToast('再次点击确认清空：会话、任务与私有资源将被回收（分享链接保留）')
      return Promise.resolve()
    }
    confirmingClear = false
    return clearActiveSession()
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
        {@render headerAction?.()}
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
      <!-- [2.1] 按任务分组渲染（顺序与扁平投影一致）——done 卡携带任务归属（打开任务详情入口）。 -->
      {#each taskFrameGroups as group (group.taskId)}
        {#each group.frames as frame (frame.seq + frame.kind + frame.ts)}
          <FrameView {frame} pendingRequestId={approval?.requestId ?? null} taskId={group.taskId} />
        {/each}
      {/each}
      {#if result && (activeTask?.status === 'done' || frames.some((f) => f.kind === 'done'))}
        <ResultCard {result} />
      {/if}
      <div bind:this={streamBottom}></div>
    </div>

    <footer class="border-t p-3">
      <!-- 投递队列面板（三通道 2.3，W10c 手风琴）：空队列且非编辑态整条隐藏。 -->
      <QueuePanel
        items={queueItems}
        editingId={queueEditingId}
        onedit={onQueueEdit}
        oncancel={cancelQueueEdit}
        onremove={removeAgentQueueItem}
        onclear={clearAgentQueue}
      />
      {#if noticeText !== null}
        <div
          class="text-muted-foreground mb-2 flex items-center gap-1.5 px-1 text-[11px]"
          role="status"
          data-testid="agent-channel-notice"
        >
          <Zap class="size-3 shrink-0" aria-hidden="true" />
          <span>{noticeText}</span>
        </div>
      {/if}
      <div class="flex items-end gap-2">
        <textarea
          bind:value={draft}
          data-testid="agent-composer"
          rows="2"
          placeholder={editingActive
            ? '编辑排队消息（Enter 确认，Esc 取消）…'
            : running
              ? '任务进行中——Enter 排队当前轮结束后自动开跑，⚡ 引导立即生效'
              : '描述你的贴钻需求'}
          class="border-input bg-background focus-visible:ring-ring min-h-0 flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-50"
          disabled={session.status !== 'active'}
          onkeydown={(event) => {
            if (event.key === 'Escape' && editingActive) {
              event.preventDefault()
              cancelQueueEdit()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        ></textarea>
        {#if editingActive}
          <!-- W10b 编辑态：发送位变「确认修改」+ 取消。 -->
          <Button
            size="sm"
            variant="outline"
            data-testid="agent-edit-cancel"
            disabled={session.status !== 'active'}
            onclick={cancelQueueEdit}
            title="取消编辑（队列按原样保留）"
          >
            <X class="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            data-testid="agent-edit-confirm"
            disabled={draft.trim() === '' || isAgentSending() || session.status !== 'active'}
            onclick={() => void submit()}
            title="确认修改（该条按原序放回队列）"
          >
            <Check class="size-3.5" aria-hidden="true" />
            确认修改
          </Button>
        {:else if running && draft.trim() === ''}
          <!-- 三通道·打断：running 空输入=停止（tasks.stop——打断≠终态取消，任务回 done 可续聊）。 -->
          <Button
            size="sm"
            variant="outline"
            class="hover:bg-destructive/10 hover:text-destructive"
            data-testid="agent-stop"
            disabled={isAgentCancelling()}
            onclick={() => void stopActiveTask()}
            title="停止生成（已排队的消息保留）"
          >
            <Square class="size-3.5 fill-current" aria-hidden="true" />
            停止
          </Button>
        {:else}
          {#if running && draft.trim() !== ''}
            <!-- 三通道·引导：steer——不等本轮结束，下一 step 边界即生效（影响当前任务）。 -->
            <Button
              size="sm"
              variant="outline"
              data-testid="agent-steer"
              disabled={isAgentSending() || session.status !== 'active'}
              onclick={() => void submit('steer')}
              title="立即引导：不等本轮结束，下一步即生效"
            >
              <Zap class="size-3.5" aria-hidden="true" />
              引导
            </Button>
          {/if}
          <!-- running 时发送=排队（当前轮结束后自动开跑）；idle=常规发送。 -->
          <Button
            size="sm"
            data-testid="agent-send"
            disabled={draft.trim() === '' || isAgentSending() || session.status !== 'active'}
            title={running ? '排队发送：当前轮结束后自动开跑' : '发送'}
            onclick={() => void submit()}
          >
            <Send class="size-3.5" aria-hidden="true" />
            {isAgentSending() ? '发送中…' : running ? '排队' : '发送'}
          </Button>
        {/if}
      </div>
    </footer>
  </div>
{/if}
