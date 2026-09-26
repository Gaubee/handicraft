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
  import { onMount } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Pane, PaneGroup, Handle } from '$lib/components/ui/resizable'
  import * as Sheet from '$lib/components/ui/sheet'
  import SessionStream from './SessionStream.svelte'
  import TaskDetailPanel from './TaskDetailPanel.svelte'
  import {
    createSession,
    getAgentConnection,
    getAgentMode,
    getAgentSessions,
    getActiveSessionId,
    getActiveTask,
    initAgentStore,
    isAgentCreating,
    openSession,
  } from '$lib/agentApi/store.svelte'
  import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus'
  import PanelRight from '@lucide/svelte/icons/panel-right'

  const sessions = $derived(getAgentSessions())
  const activeId = $derived(getActiveSessionId())
  const mode = $derived(getAgentMode())
  const connection = $derived(getAgentConnection())
  /** 活跃会话最新任务（第三栏/详情抽屉的上下文——followup 进行中跟随切换）。 */
  const activeTask = $derived(getActiveTask())

  // 已绑定 API（测试注入）优先；缺省走 factory（localStorage 模式键，默认 mock）。
  onMount(() => {
    void initAgentStore()
  })

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

  function formatTime(iso: string): string {
    const date = new Date(iso)
    const today = new Date()
    return date.toDateString() === today.toDateString()
      ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  }
</script>

{#snippet sessionListColumn()}
  <div class="flex h-12 shrink-0 items-center justify-between px-3">
    <span class="text-sm font-semibold">任务会话</span>
    <Button size="sm" variant="outline" data-testid="agent-new-session" disabled={isAgentCreating()} onclick={() => createSession()}>
      <MessageCirclePlus class="size-3.5" aria-hidden="true" />
      {isAgentCreating() ? '创建中…' : '新会话'}
    </Button>
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto p-2 max-md:max-h-44">
    {#if sessions.length === 0}
      <p class="text-muted-foreground px-2 py-6 text-center text-xs" data-testid="agent-session-empty">
        还没有会话——点击「新会话」开始第一个贴钻任务
      </p>
    {/if}
    {#each sessions as session (session.id)}
      <button
        type="button"
        data-testid="agent-session-item"
        aria-current={session.id === activeId ? 'true' : undefined}
        class="w-full rounded-lg px-2.5 py-2 text-left transition-colors {session.id === activeId
          ? 'bg-muted'
          : 'hover:bg-muted/60'}"
        onclick={() => openSession(session.id)}
      >
        <span class="block truncate text-sm font-medium">{session.title}</span>
        <span class="text-muted-foreground block text-xs">{formatTime(session.updatedAt)}</span>
      </button>
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
  <!-- 移动端「详情」入口（桌面第三栏常驻详情——按钮自抑制）；活跃会话有任务才可唤起。 -->
  {#if !desktop && activeTask !== null}
    <Button size="sm" variant="outline" onclick={() => (detailOpen = true)} data-testid="agent-detail-toggle">
      <PanelRight class="size-3.5" aria-hidden="true" />
      详情
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
  {#if desktop}
    <!-- 桌面：三栏可拖拽（会话列表 | 对话 | 任务详情——autoSaveId 记忆比例）。 -->
    <PaneGroup direction="horizontal" autoSaveId="rhinestone-agent-panes" class="min-h-0 min-w-0 flex-1" data-testid="agent-pane-group">
      <Pane defaultSize={18} minSize={10} class="bg-background min-w-44">
        <div class="flex h-full min-h-0 flex-col" data-testid="agent-sidebar" aria-label="任务会话列表">
          {@render sessionListColumn()}
        </div>
      </Pane>
      <Handle />
      <Pane minSize={26} class="min-w-0">
        <main class="bg-muted/40 h-full min-h-0" data-testid="agent-pane-chat">
          <SessionStream headerAction={chatHeaderAction} />
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
      <SessionStream headerAction={chatHeaderAction} />
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
            当前任务的轻量详情（状态/图层摘要/预览）；编辑请打开完整工作台。
          </Sheet.Description>
          <div class="min-h-0 flex-1 overflow-y-auto">
            {@render detailPanelColumn()}
          </div>
        </Sheet.Content>
      </Sheet.Root>
    {/if}
  {/if}
</div>
