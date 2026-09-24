<!--
AgentView.svelte — Agent 主面（W3.1 产品形态核心——默认落地视图）。
布局：左侧会话列表（新建入口）+ 右侧会话流；移动端上下堆叠。
状态：连接态（mock=本地 / rpc WS 生命周期）+ 模式徽标；列表空态引导。
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import SessionStream from './SessionStream.svelte'
  import {
    createSession,
    getAgentConnection,
    getAgentMode,
    getAgentSessions,
    getActiveSessionId,
    initAgentStore,
    isAgentCreating,
    openSession,
  } from '$lib/agentApi/store.svelte'
  import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus'

  const sessions = $derived(getAgentSessions())
  const activeId = $derived(getActiveSessionId())
  const mode = $derived(getAgentMode())
  const connection = $derived(getAgentConnection())

  // 已绑定 API（测试注入）优先；缺省走 factory（localStorage 模式键，默认 mock）。
  onMount(() => {
    void initAgentStore()
  })

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

<div class="flex h-full min-h-0 flex-col md:flex-row" data-testid="agent-view">
  <aside
    class="bg-background flex w-full shrink-0 flex-col border-b md:w-72 md:border-r md:border-b-0"
    data-testid="agent-sidebar"
    aria-label="任务会话列表"
  >
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
  </aside>

  <main class="bg-muted/40 min-h-0 min-w-0 flex-1">
    <SessionStream />
  </main>
</div>
