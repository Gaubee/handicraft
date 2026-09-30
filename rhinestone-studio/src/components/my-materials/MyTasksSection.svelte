<!--
  MyTasksSection.svelte——「我的材料 → 我的任务」子区（restructure-materials-story
  W2b，2026-09-30 Owner 故事·归档环：每一单的任务随时回看）。
  任务行列表：会话标题/最新任务状态徽标（中性色——惰性补齐，缺省「—」）/更新
  时间/「进入会话」（跳前台会话——前台无会话子路由，动作=agentApi store
  openSession + navigate('#/')，见 lib/myMaterials/tasks.svelte.ts）。
  只读红线：无任何任务/会话写操作（取消/清理属前台会话域）。
  首屏 50 行+「加载更多」（cursor 追加）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { TaskStatus } from '@handicraft/contracts'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import ListTodo from '@lucide/svelte/icons/list-todo'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import {
    enterMyTaskSession,
    getMyTaskLatest,
    getMyTaskSessions,
    getMyTasksError,
    getMyTasksNextCursor,
    getMyTasksState,
    initMyTasks,
    isMyTasksLoadingMore,
    loadMoreMyTasks,
    refreshMyTasks,
    type LatestTaskView,
  } from '$lib/myMaterials/tasks.svelte'

  // store 读面（getter 派生）。
  const sessions = $derived(getMyTaskSessions())
  const loading = $derived(getMyTasksState() === 'loading')
  const error = $derived(getMyTasksError())
  const cursor = $derived(getMyTasksNextCursor())
  const loadingMore = $derived(isMyTasksLoadingMore())

  /** 最新任务状态徽标（中性色——队列/运行/完成/失败/取消同族呈现）。 */
  const TASK_BADGES: Record<TaskStatus, { label: string; cls: string }> = {
    queued: { label: '排队中', cls: 'bg-muted text-muted-foreground' },
    running: { label: '运行中', cls: 'bg-primary/10 text-primary' },
    done: { label: '已完成', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
    failed: { label: '失败', cls: 'bg-destructive/10 text-destructive' },
    cancelled: { label: '已取消', cls: 'bg-muted text-muted-foreground' },
  }

  function badgeOf(latest: LatestTaskView | undefined): { label: string; cls: string } | null {
    if (latest === undefined) return null // 补齐中/补齐失败——「—」
    if (latest === 'none') return { label: '无任务', cls: 'bg-muted text-muted-foreground' }
    return TASK_BADGES[latest.status]
  }

  function sessionTitle(title: string): string {
    return title.trim() === '' ? '未命名会话' : title
  }

  function formatUpdatedAt(iso: string): string {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
  }

  onMount(() => {
    void initMyTasks()
  })
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="my-tasks-section">
  <!-- 工具行 -->
  <div class="bg-background/80 flex flex-wrap items-center gap-2 border-b px-3 py-2 backdrop-blur" data-testid="my-tasks-toolbar">
    <Button size="sm" class="h-8" disabled={loading || loadingMore} onclick={() => void refreshMyTasks()} data-testid="my-tasks-refresh" title="重载任务清单">
      <RefreshCw class="size-3.5" aria-hidden="true" />
      刷新
    </Button>
    <span class="text-muted-foreground ml-auto text-xs" data-testid="my-tasks-count">{sessions.length} 个会话</span>
  </div>

  {#if error !== null}
    <div class="flex items-center gap-2 border-b px-3 py-1.5">
      <p class="border-destructive/30 bg-destructive/10 text-destructive flex-1 px-2 py-1 text-xs" data-testid="my-tasks-error" role="alert">{error}</p>
      <Button size="sm" variant="outline" class="h-8" disabled={loading} onclick={() => void refreshMyTasks()}>重试</Button>
    </div>
  {/if}

  <main class="bg-muted/30 min-h-0 flex-1 overflow-y-auto p-3" data-testid="my-tasks-list">
    {#if loading}
      <p class="text-muted-foreground py-16 text-center text-sm" role="status">任务清单加载中…</p>
    {:else if sessions.length === 0}
      <div class="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center" data-testid="my-tasks-empty">
        <ListTodo class="size-8 opacity-40" aria-hidden="true" />
        <p class="text-sm">暂无任务</p>
        <p class="text-xs opacity-80">在前台新建会话开始排钻，每一单都会归档在这里</p>
      </div>
    {:else}
      <div class="bg-card mx-auto flex max-w-3xl flex-col divide-y overflow-hidden rounded-lg border" data-testid="my-tasks-rows">
        {#each sessions as session (session.id)}
          {@const badge = badgeOf(getMyTaskLatest(session.id))}
          <div class="flex min-w-0 items-center gap-2 px-3 py-2" data-testid="my-task-row-{session.id}">
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate text-sm" title={sessionTitle(session.title)}>{sessionTitle(session.title)}</span>
                {#if badge !== null}
                  <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium {badge.cls}" data-testid="my-task-badge-{session.id}">{badge.label}</span>
                {:else}
                  <span class="text-muted-foreground shrink-0 text-[10px]" data-testid="my-task-badge-{session.id}">—</span>
                {/if}
              </div>
              <div class="text-muted-foreground mt-0.5 text-[10px]" title={session.updatedAt}>更新于 {formatUpdatedAt(session.updatedAt)}</div>
            </div>
            <Button
              size="xs"
              variant="ghost"
              class="shrink-0"
              onclick={() => void enterMyTaskSession(session.id)}
              data-testid="my-task-enter-{session.id}"
            >
              <ExternalLink class="size-3" aria-hidden="true" />
              进入会话
            </Button>
          </div>
        {/each}
      </div>
      {#if cursor !== undefined}
        <div class="mt-3 flex justify-center">
          <Button size="sm" variant="outline" class="h-8" disabled={loadingMore} onclick={() => void loadMoreMyTasks()} data-testid="my-tasks-load-more">
            {loadingMore ? '加载中…' : '加载更多'}
          </Button>
        </div>
      {/if}
    {/if}
  </main>

  <footer class="bg-background text-muted-foreground flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs" data-testid="my-tasks-statusbar">
    <span>会话任务归档（只读）</span>
    <Badge variant="secondary" class="ml-auto text-[10px]">本人域 · 不含清理操作</Badge>
  </footer>
</div>
