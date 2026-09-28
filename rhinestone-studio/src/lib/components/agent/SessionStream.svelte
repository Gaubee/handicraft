<!--
SessionStream.svelte — 会话流（zhumo 方案移植块 B，2026-09-28 组件级 1:1 换装）。
形态=zhumo ListDetailPage chatColumn：header（标题+状态+取消/清空）→ 失败/断线
横幅 → TranscriptView（转录流）→ footer（QueueDrawer + ComposerCard）。
贴钻 store 绑定保留（W10 三通道/队列外环/审批卡/暂离编辑语义全数由 zhumo 组件
树承载）：
- 三通道：ComposerCard 发送位（running 空输入=停止 / running 有输入=⚡引导+排队
  / idle=发送）——steer/stop/队列反馈走全局 toast；
- 队列：QueueDrawer（拖动排序/暂停段/模式改档/编辑/删除/清空——前端外环本地
  真源，zhumo W10m 交互全量）；
- 审批卡/策略提案卡/产物 chip/完成入口：TranscriptView 的 frame 分支走贴钻
  FrameView 原样渲染；
- composerOutbox 注入（策略参数表单指令）：ComposerCard.setPrompt 实例方法。
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import TranscriptView from './TranscriptView.svelte'
  import QueueDrawer from './QueueDrawer.svelte'
  import ComposerCard from './ComposerCard.svelte'
  import ResultCard from './ResultCard.svelte'
  import {
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
    getAgentQueueLockBoundary,
    getAgentQueueReordering,
    getPendingApproval,
    getSessionResult,
    isAgentCancelling,
    isAgentClearing,
    isAgentSending,
    lockAgentQueue,
    removeAgentQueueItem,
    reorderAgentQueue,
    sendFollowup,
    setAgentQueueItemMode,
    setAgentQueueReordering,
    stopActiveTask,
  } from '$lib/agentApi/store.svelte'
  import { pendingQueueItems, projectFrames } from '$lib/agentApi/transcript.svelte'
  import { clearComposerText, peekComposerText } from '$lib/agentApi/composerOutbox.svelte'
  import { modelsApi } from '$lib/modelsApi'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { AvailableModel } from '@handicraft/contracts'
  import Ban from '@lucide/svelte/icons/ban'
  import Trash2 from '@lucide/svelte/icons/trash-2'

  // [add-workbench-pro 1.4] 顶栏扩展位（可选 snippet——AgentView 注入移动端「详情」按钮）。
  let { headerAction }: { headerAction?: Snippet } = $props()

  const session = $derived(getActiveSession())
  const frames = $derived(getActiveSessionFrames())
  /** 按任务分组的帧流（v6 复核 P1-5：投影携带来源 taskId——历史任务 done/审批/
   *  产物帧只路由其自身任务，不由最新任务顶替）。 */
  const taskFrames = $derived(getActiveSessionTaskFrames())
  const activeTask = $derived(getActiveTask())
  const approval = $derived(getPendingApproval())
  const result = $derived(getSessionResult(session?.id ?? null))
  const running = $derived(activeTask?.status === 'running' || activeTask?.status === 'queued')
  const connection = $derived(getAgentConnection())
  const disconnected = $derived(connection === 'closed' || connection === 'error')
  const queueItems = $derived(getAgentQueue())
  const queueEditingId = $derived(getAgentQueueEditingId())

  /** 转录条目（贴钻帧投影（任务分组）+ 队列待发气泡合并——zhumo W10l 同款）。 */
  const transcriptItems = $derived.by(() => {
    const projected = projectFrames(taskFrames)
    return [...projected, ...pendingQueueItems(queueItems, projected.length)]
  })

  // 可用模型（挂载即拉——zhumo 同款；失败静默隐藏 chip）。
  let availableModels = $state<AvailableModel[] | null>(null)
  let availableDefault = $state<{ provider: string; model: string; effort?: string | null } | null>(null)
  onMount(() => {
    void (async () => {
      try {
        const out = await modelsApi().getAvailableModels()
        availableModels = out.models
        availableDefault = out.default
      } catch {
        availableModels = null // mock 模式/daemon 未配路由——chip 隐藏
      }
    })()
  })

  /** 活动模型上下文窗口（ContextMeter 容量；null=回退 128k 假定值）。 */
  const activeCapacity = $derived.by(() => {
    const current =
      availableDefault !== null && availableModels !== null
        ? availableModels.find((m) => m.provider === availableDefault!.provider && m.model === availableDefault!.model)
        : null
    return current?.contextWindow ?? null
  })

  let root = $state<HTMLDivElement | null>(null)
  let composerRef = $state<ComposerCard | null>(null)
  let confirmingClear = $state(false)
  /** 本实例的编辑会话（进入时回填文本；queueEditingId 为全局冻结标记）。 */
  let editingActive = $state(false)
  let editingDraft = $state<string | null>(null)

  // [add-subject-sam-pipeline P3.2] 策略参数表单指令注入：经 ComposerCard.setPrompt
  // 实例方法注入（空=直接置入，非空=换行追加——用户草稿不覆盖；消费即清空）。
  // 可见性守卫：Agent 与策略设计两个 tab 各挂一个本组件实例——隐藏实例让位。
  $effect(() => {
    const injected = peekComposerText()
    if (injected === null) return
    if (root === null || root.closest('[hidden]') !== null) return
    composerRef?.setPrompt(injected)
    clearComposerText()
  })

  /** ComposerCard 发送回调（Enter/按钮/steer 同源；文本在组件内组装）。
   *  三通道分发在 store.sendFollowup：running+followup=入队、steer=立即投递、
   *  idle=常规开跑；通道反馈 toast 由 ComposerCard 内部发出。 */
  async function onComposerSend(text: string, mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    if (editingActive) return // 编辑态由 onconfirmedit 承接
    await sendFollowup(text, mode)
  }

  // ------------------------------------------------------------ 队列编辑（W10b 暂离编辑）

  /** 进入编辑：输入框有未发送内容拒绝（Owner 设计）；文本回填，全局冻结自动开跑。 */
  function onQueueEdit(id: string): void {
    if (editingActive) return
    if ((composerRef?.draftLength() ?? 0) > 0) {
      showToast('输入框有未发送内容——发送或清空后再编辑排队消息')
      return
    }
    const text = beginAgentQueueEdit(id)
    if (text === null) return
    editingDraft = text
    editingActive = true
  }

  function onQueueEditCancel(): void {
    editingActive = false
    editingDraft = null
    composerRef?.setPrompt('') // 贴钻语义：取消=队列原样放回 + composer 清空
    cancelAgentQueueEdit()
  }

  function onQueueEditConfirm(text: string): void {
    editingActive = false
    editingDraft = null
    confirmAgentQueueEdit(text)
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
  <div class="bg-background flex h-full min-h-0 flex-col" data-testid="agent-stream" bind:this={root}>
    <header class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
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

    <TranscriptView
      items={transcriptItems}
      {running}
      emptyHint="描述你想做的贴钻作品——例如：帮我把这张爱心线稿排满红色圆钻，密度高一点"
      pendingRequestId={approval?.requestId ?? null}
    />

    {#if result && (activeTask?.status === 'done' || frames.some((f) => f.kind === 'done'))}
      <div class="border-t px-4 py-3">
        <ResultCard {result} />
      </div>
    {/if}

    <footer class="border-t p-3">
      <!-- 队列抽屉（zhumo W10c/W10m 形态——外环本地真源：拖动排序/暂停段/改模式/编辑）。 -->
      <QueueDrawer
        items={queueItems}
        lockBoundary={getAgentQueueLockBoundary()}
        editingId={queueEditingId}
        reordering={getAgentQueueReordering()}
        running={running}
        onedit={onQueueEdit}
        oncancel={onQueueEditCancel}
        onremove={removeAgentQueueItem}
        onsetmode={setAgentQueueItemMode}
        onlock={lockAgentQueue}
        onreorder={reorderAgentQueue}
        onreordering={setAgentQueueReordering}
        onclear={clearAgentQueue}
      />
      <ComposerCard
        bind:this={composerRef}
        onsend={(text, mode) => void onComposerSend(text, mode)}
        onstop={() => void stopActiveTask()}
        editingActive={editingActive}
        editingDraft={editingDraft}
        onconfirmedit={onQueueEditConfirm}
        oncanceledit={onQueueEditCancel}
        sending={isAgentSending()}
        disabled={session.status !== 'active'}
        models={availableModels}
        defaultModel={availableDefault}
        {running}
        capacity={activeCapacity}
        attachable={false}
        triggers={false}
      />
    </footer>
  </div>
{/if}
