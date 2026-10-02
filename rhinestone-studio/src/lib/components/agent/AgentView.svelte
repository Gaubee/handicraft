<!--
AgentView.svelte — Agent 主面（W3.1 产品形态核心——默认落地视图）。
[add-workbench-pro 1.2/1.4 zhumo 模式] 布局改版：
1. 桌面（≥md 768px）：三栏 Resizable（shadcn resizable / paneforge）——会话列表 |
   对话（SessionStream）| 任务详情（TaskDetailPanel 轻量面板，活跃会话有任务时
   出现）；两根分隔条可拖拽，autoSaveId 记忆比例。
2. 移动（<md）：会话列表+对话上下堆叠（原有布局保持）；会话流顶栏「详情」按钮
   唤起 Sheet 抽屉承载任务详情面板。
3. 会话列表/任务详情以 snippet 复用（桌面 Pane 与移动 Sheet 共享同一份标记——
   SessionStream/TaskDetailPanel 单实例不双挂，zhumo ListDetailPage 先例）。
状态：连接态（mock=本地 / rpc WS 生命周期）+ 模式徽标；列表空态引导。
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Pane, PaneGroup, Handle } from '$lib/components/ui/resizable'
  import * as Sheet from '$lib/components/ui/sheet'
  import SessionStream from './SessionStream.svelte'
  import TaskDetailPanel from './TaskDetailPanel.svelte'
  import NewTaskComposer from './NewTaskComposer.svelte'
  import {
    createSession,
    getAgentConnection,
    getAgentMode,
    getAgentSessions,
    getActiveSessionId,
    getActiveTask,
    getBoundAgentApi,
    initAgentStore,
    isAgentCreating,
    openSession,
    renameSession,
    syncAgentSessionsForUser,
  } from '$lib/agentApi/store.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { getSessionUser } from '$lib/stores/session.svelte'
  import { clearDemoDelay, getDemoDelay } from '$lib/agentApi/demoDelay.svelte'
  import { MockAgentApi } from '$lib/agentApi/mock'
  import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus'
  import PanelRight from '@lucide/svelte/icons/panel-right'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Sparkles from '@lucide/svelte/icons/sparkles'

  // [new-task-panel 2026-10-02] 开始新任务面板（Owner 需求「参考朱墨」）：侧栏
  // 「新任务」+chat 空态「开始新任务」共用入口；空态拖放收图改道开面板预填
  // （seedFiles）。表单态不持久（关闭即清——NewTaskComposer 复位 effect）。
  let newTaskOpen = $state(false)
  let newTaskSeed = $state<File[] | null>(null)

  function openNewTask(files?: File[]): void {
    newTaskSeed = files !== undefined && files.length > 0 ? files : null
    newTaskOpen = true
  }

  const sessions = $derived(getAgentSessions())
  const activeId = $derived(getActiveSessionId())
  const mode = $derived(getAgentMode())
  const connection = $derived(getAgentConnection())
  /** 活跃会话最新任务（第三栏/详情抽屉的上下文——followup 进行中跟随切换）。 */
  const activeTask = $derived(getActiveTask())

  // 已绑定 API（测试注入）优先；缺省走 factory（localStorage 模式键，默认 mock）。
  // demoDelay 走查开关（三通道 2.4，对齐 shufa a3ac820）：URL query 在 demoDelay 模块
  // 加载期已落 sessionStorage（早于 MockAgentApi 构造）；banner 呈现激活态。
  let demoActive = $state(getDemoDelay() > 0)
  onMount(() => {
    demoActive = getDemoDelay() > 0
    void initAgentStore()
  })

  // [波 5 P2-5] 会话列表随登录用户重取：挂载存续期间的登录/登出/换号（登录页往返
  // 的重挂载场景由 initAgentStore 内的同款对齐覆盖）。依赖=currentUser；sync 内部
  // 自带用户键比对（未漂移 no-op——本 effect 首跑与 initAgentStore 并发安全）。
  $effect(() => {
    getSessionUser()
    untrack(() => {
      void syncAgentSessionsForUser()
    })
  })

  function exitDemo(): void {
    clearDemoDelay()
    demoActive = false
    const bound = getBoundAgentApi()
    if (bound instanceof MockAgentApi) bound.setDemoDelay(0)
  }

  /** 桌面/移动切换（md 768px）：桌面走三栏 PaneGroup，移动走堆叠+抽屉。
   *  jsdom 无 matchMedia——守卫回落桌面分支（与 StudioStatusBar 同式）。 */
  let desktop = $state(true)
  $effect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(min-width: 768px)')
    const sync = () => (desktop = mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  })

  /** 移动详情抽屉开关。 */
  let detailOpen = $state(false)
  let root = $state<HTMLDivElement | null>(null)

  // [真链复验 P1-G] 会话改名（内联编辑态）：铅笔/双击标题进入——回车保存、Esc/
  // 失焦提交（空标题=放弃不改），保存期间锁输入（防幽灵提交）。
  let renamingSessionId = $state<string | null>(null)
  let renameDraft = $state('')
  let renamingBusy = $state(false)
  let renameInput = $state<HTMLInputElement | null>(null)

  function startRename(session: { id: string; title: string }): void {
    renamingSessionId = session.id
    renameDraft = session.title
    tick().then(() => renameInput?.focus())
  }

  function cancelRename(): void {
    renamingSessionId = null
    renameDraft = ''
  }

  async function commitRename(sessionId: string): Promise<void> {
    if (renamingSessionId !== sessionId || renamingBusy) {
      cancelRename()
      return
    }
    const next = renameDraft.trim()
    if (next === '') {
      cancelRename()
      return
    }
    if (next.length > 200) {
      showToast('标题最长 200 字符')
      return
    }
    const previous = sessions.find((candidate) => candidate.id === sessionId)?.title ?? ''
    if (next === previous) {
      cancelRename()
      return
    }
    renamingBusy = true
    try {
      // 失败面：guard 落 storeError（SessionStream 错误条呈现）+列表行不更新——
      // 保持编辑态供修正（title 未变即知未成功）。
      await renameSession(sessionId, next)
      if (sessions.find((candidate) => candidate.id === sessionId)?.title === next) cancelRename()
    } finally {
      renamingBusy = false
    }
  }

  /** 「继续对话」：收抽屉 + 聚焦对话输入框（scoped 到本视图——策略设计器 tab
   *  也挂 SessionStream（同 testid），全局查询会命中隐藏实例）。
   *  抽屉路径延迟聚焦：关闭有 200ms 过渡且 bits-ui 关闭后焦点归还触发按钮——
   *  240ms 压过两者再落输入框。 */
  function backToChat(): void {
    const wasOpen = detailOpen
    detailOpen = false
    const focusComposer = () =>
      root?.querySelector<HTMLTextAreaElement>('[data-testid="agent-composer"]')?.focus()
    if (wasOpen) setTimeout(focusComposer, 240)
    else focusComposer()
  }

  const connectionLabel: Record<string, string> = {
    mock: '本地演示',
    connecting: '连接中…',
    open: '已连接',
    closed: '已断开',
    error: '连接异常',
  }

  /** 任务状态中文化（zhumo 对照清单 T5/T6——状态 pill 与列表行第二行共用）。 */
  const TASK_STATUS_LABEL: Record<string, string> = {
    queued: '排队中',
    running: '进行中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }

  /** 列表行第二行（T6 双行化）：活跃会话=最近任务状态；其余=「贴钻会话」。 */
  function sessionSubtitle(sessionId: string): string {
    if (sessionId === activeId && activeTask !== null) {
      return `最近任务 · ${TASK_STATUS_LABEL[activeTask.status] ?? activeTask.status}`
    }
    return '贴钻会话'
  }

  function formatTime(iso: string): string {
    const date = new Date(iso)
    const today = new Date()
    return date.toDateString() === today.toDateString()
      ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  }
</script>

{#snippet sessionListColumn()}
  <div class="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
    <span class="text-sm font-semibold">任务会话</span>
    <div class="flex shrink-0 items-center gap-1.5">
      <Button size="sm" data-testid="agent-new-task" onclick={() => openNewTask()}>
        <Sparkles class="size-3.5" aria-hidden="true" />
        新任务
      </Button>
      <Button size="sm" variant="outline" data-testid="agent-new-session" disabled={isAgentCreating()} onclick={() => createSession()}>
        <MessageCirclePlus class="size-3.5" aria-hidden="true" />
        {isAgentCreating() ? '创建中…' : '新会话'}
      </Button>
    </div>
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto p-2 max-md:max-h-44">
    {#if sessions.length === 0}
      <p class="text-muted-foreground px-2 py-6 text-center text-xs" data-testid="agent-session-empty">
        还没有会话——点击「新会话」开始第一个贴钻任务
      </p>
    {/if}
    {#each sessions as session (session.id)}
      {@const isActive = session.id === activeId}
      {@const task = isActive ? activeTask : null}
      {@const renaming = renamingSessionId === session.id}
      <!-- 双行行卡（zhumo 对照清单 T6）：标题 text-xs font-medium + 第二行（最近任务
           状态或「贴钻会话」+时间）text-[11px] muted；active 行 bg-accent-soft；
           有活跃任务行右侧状态 pill（T5 同款实心 9px）。
           [真链复验 P1-G] 改名态：行切换为内联输入（input 不能嵌 button——行级二态）；
           入口=悬停铅笔 + 双击标题；回车/失焦提交、Esc 取消、空标题放弃。 -->
      {#if renaming}
        <div class="bg-accent-soft mb-1 flex items-center gap-1.5 rounded-lg px-2.5 py-2" data-testid="agent-session-rename-row">
          <input
            bind:this={renameInput}
            bind:value={renameDraft}
            disabled={renamingBusy}
            maxlength="200"
            class="bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-1.5 py-1 text-xs outline-none focus-visible:ring-1"
            data-testid="agent-session-rename-input"
            aria-label="会话标题"
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commitRename(session.id)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRename()
              }
            }}
            onblur={() => void commitRename(session.id)}
          />
          {#if renamingBusy}
            <span class="text-muted-foreground shrink-0 text-[10px]" data-testid="agent-session-rename-busy">保存中…</span>
          {/if}
        </div>
      {:else}
        <button
          type="button"
          data-testid="agent-session-item"
          aria-current={isActive ? 'true' : undefined}
          class="group mb-1 w-full rounded-lg px-2.5 py-2 text-left transition-colors {isActive ? 'bg-accent-soft' : 'hover:bg-muted/60'}"
          onclick={() => openSession(session.id)}
          ondblclick={() => startRename(session)}
        >
          <span class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-xs font-medium" data-testid="agent-session-title" title="双击重命名">{session.title}</span>
            <span
              role="button"
              tabindex={0}
              aria-label="重命名会话"
              class="text-muted-foreground hidden shrink-0 rounded p-0.5 group-hover:block focus-visible:block hover:text-foreground"
              data-testid="agent-session-rename-trigger"
              onclick={(event) => {
                event.stopPropagation()
                startRename(session)
              }}
              onkeydown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  startRename(session)
                }
              }}
            >
              <Pencil class="size-3" aria-hidden="true" />
            </span>
            {#if task !== null && (task.status === 'running' || task.status === 'queued')}
              <Badge class="shrink-0 text-[9px]" data-testid="agent-session-status">进行中</Badge>
            {:else if task !== null && task.status === 'failed'}
              <Badge class="bg-destructive text-destructive-foreground shrink-0 text-[9px]" data-testid="agent-session-status">失败</Badge>
            {/if}
          </span>
          <span class="text-muted-foreground mt-0.5 flex items-center gap-2 text-[11px]">
            <span class="truncate">{sessionSubtitle(session.id)}</span>
            <span class="shrink-0">{formatTime(session.updatedAt)}</span>
          </span>
        </button>
      {/if}
    {/each}
  </div>
  <div class="text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-xs">
    <span class="flex items-center gap-1.5" data-testid="agent-connection">
      <span
        class="size-1.5 rounded-full {connection === 'open' || connection === 'mock' ? 'bg-primary' : 'bg-destructive'}"
        aria-hidden="true"
      ></span>
      {connectionLabel[connection] ?? connection}
    </span>
    <Badge variant="outline" class="text-[10px]" data-testid="agent-mode">{mode === 'mock' ? 'MOCK' : 'RPC'}</Badge>
  </div>
{/snippet}

{#snippet chatHeaderAction()}
  <!-- 移动端「详情」入口（桌面第三栏常驻详情——按钮自抑制）；活跃会话有任务才可唤起。
       图标化（zhumo 对照清单 T8）：panel-right 20px 图标钮替代「详情」文字钮。 -->
  {#if !desktop && activeTask !== null}
    <Button
      size="icon-sm"
      variant="ghost"
      class="size-8 p-0"
      onclick={() => (detailOpen = true)}
      data-testid="agent-detail-toggle"
      aria-label="打开任务详情"
      title="打开任务详情"
    >
      <PanelRight class="size-5" aria-hidden="true" />
    </Button>
  {/if}
{/snippet}

{#snippet detailPanelColumn()}
  <!-- 单实例标记：桌面第三栏与移动 Sheet 共用（分支互斥——任一时刻只挂一份）。 -->
  {#if activeTask !== null}
    <TaskDetailPanel taskId={activeTask.taskId} onBackToChat={backToChat} />
  {/if}
{/snippet}

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && detailOpen) detailOpen = false
  }}
/>

<div class="flex h-full min-h-0 flex-col" data-testid="agent-view" bind:this={root}>
  {#if demoActive}
    <!-- 走查演示模式提示条（a3ac820 对齐）：mock 通道帧流按注入节奏模拟，可退出。 -->
    <div
      class="bg-violet-500/10 border-b border-violet-500/30 px-4 py-1 text-[11px] text-violet-700 flex items-center gap-2"
      role="status"
      data-testid="agent-demo-banner"
    >
      演示模式：帧流按 {Math.round(getDemoDelay() / 100) / 10}s 节奏模拟（mock 通道，不产生真实调用）
      <button
        type="button"
        class="rounded px-1 underline underline-offset-2 hover:bg-violet-500/10"
        data-testid="agent-demo-exit"
        onclick={exitDemo}
      >
        退出
      </button>
    </div>
  {/if}
  {#if desktop}
    <!-- 桌面：三栏可拖拽（会话列表 | 对话 | 任务详情——autoSaveId 记忆比例）。 -->
    <PaneGroup direction="horizontal" autoSaveId="rhinestone-agent-panes" class="min-h-0 min-w-0 flex-1" data-testid="agent-pane-group">
      <!-- 列表栏默认 ~348px（zhumo 对照清单 T6：双行行卡需更宽——常规 1512px 视口 23%）。
           autoSaveId 记忆的老比例优先，仅新用户落此默认。 -->
      <Pane defaultSize={23} minSize={10} class="bg-background min-w-44">
        <div class="flex h-full min-h-0 flex-col" data-testid="agent-sidebar" aria-label="任务会话列表">
          {@render sessionListColumn()}
        </div>
      </Pane>
      <Handle />
      <Pane minSize={26} class="min-w-0">
        <main class="bg-muted/40 h-full min-h-0" data-testid="agent-pane-chat">
          <SessionStream headerAction={chatHeaderAction} onstartnewtask={openNewTask} />
        </main>
      </Pane>
      {#if activeTask !== null}
        <Handle />
        <Pane defaultSize={32} minSize={18} class="min-w-72">
          <div class="h-full min-h-0" data-testid="agent-pane-detail">
            {@render detailPanelColumn()}
          </div>
        </Pane>
      {/if}
    </PaneGroup>
  {:else}
    <!-- 移动：会话列表+对话上下堆叠（原有布局）；详情走 Sheet 抽屉。 -->
    <aside class="bg-background flex w-full shrink-0 flex-col border-b" data-testid="agent-sidebar" aria-label="任务会话列表">
      {@render sessionListColumn()}
    </aside>
    <main class="bg-muted/40 min-h-0 min-w-0 flex-1">
      <SessionStream headerAction={chatHeaderAction} onstartnewtask={openNewTask} />
    </main>

    {#if activeTask !== null}
      <Sheet.Root bind:open={detailOpen}>
        <Sheet.Content
          side="right"
          class="w-[92%] max-w-md gap-0 p-0 sm:max-w-md"
          data-testid="agent-detail-sheet"
        >
          <Sheet.Header class="flex-row items-center justify-between border-b px-3 py-2">
            <Sheet.Title class="text-muted-foreground text-xs font-medium">任务详情</Sheet.Title>
          </Sheet.Header>
          <Sheet.Description class="sr-only">
            任务详情多标签面板：详情预览任务与导出结果；工作台标签编辑画布；结果标签查看导出分享页。
          </Sheet.Description>
          <div class="min-h-0 flex-1">
            {@render detailPanelColumn()}
          </div>
        </Sheet.Content>
      </Sheet.Root>
    {/if}
  {/if}

  <!-- [new-task-panel] 开始新任务面板（单实例——侧栏/chat 空态/空态拖放三入口共用）。 -->
  <NewTaskComposer bind:open={newTaskOpen} seedFiles={newTaskSeed} onseedconsumed={() => (newTaskSeed = null)} />
</div>
