<!--
Orthogonal intents (max 3):
1. [2026-09-18 批次分组] 画廊主体：按「开始生成」批次分组（第 N 次运行 · HH:mm · X 张 · 状态汇总）；
     组间最新在前、组内保持发起顺序；组头可折叠（仅内存）+ 整组重试失败项。
2. [2026-09-18 R2 PM] 空态=三步引导卡（①配置连接 ②传图(可选) ③开始生成），内嵌 CTA 一步直达；
     未配置时 CTA=配置连接（开设置），已配置时 CTA=开始生成（与 RunBar 同一动作）。
3. [2026-09-18 状态] 头行：N 张候选 + 生成中/排队徽标 + 清空历史（图标 ghost，去红色噪音）。
-->

<script lang="ts">
  import * as Card from '$lib/components/ui/card'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import {
    clearHistory,
    getPendingCount,
    getRunningCount,
    getSettings,
    getTaskGroups,
    retryTask,
    startRun,
    type LabTask,
  } from '$lib/stores/lab.svelte'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import TaskCard from './TaskCard.svelte'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'

  let {
    onopenpreview,
    onsend,
  }: {
    onopenpreview: (taskId: string) => void
    onsend: (taskId: string) => void
  } = $props()

  const settings = $derived(getSettings())
  const groups = $derived(getTaskGroups())
  const running = $derived(getRunningCount())
  const pending = $derived(getPendingCount())
  const total = $derived(groups.reduce((sum, g) => sum + g.tasks.length, 0))

  const configured = $derived(
    settings.baseUrl.trim() !== '' && settings.apiKey.trim() !== '' && settings.model.trim() !== '',
  )

  /** 空态内嵌 CTA（vision #9）：与 RunBar 同一动作口径；发起失败就地提示 */
  let emptyRunError = $state('')

  function emptyStateRun(): void {
    emptyRunError = ''
    const result = startRun()
    if (!result.ok) emptyRunError = result.error ?? '发起失败'
  }

  /** 折叠状态：仅内存（key = runId），刷新后恢复默认展开，不持久化。 */
  let collapsedRuns = $state<Record<string, boolean>>({})

  function toggleRun(runId: string): void {
    collapsedRuns[runId] = !collapsedRuns[runId]
  }

  /** 组头时间：批次发起时刻（组内最早 createdAt）→ 本地 HH:mm。 */
  function formatRunTime(ts: number): string {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** 组头状态汇总：全成功时返回空串（只显张数）；否则只列非零状态。 */
  function groupStatusSummary(tasks: LabTask[]): string {
    const counts: Record<LabTask['status'], number> = { success: 0, error: 0, cancelled: 0, running: 0, pending: 0 }
    for (const t of tasks) counts[t.status] += 1
    if (counts.success === tasks.length) return ''
    const parts: string[] = []
    if (counts.success > 0) parts.push(`${counts.success} 成功`)
    if (counts.error > 0) parts.push(`${counts.error} 失败`)
    if (counts.cancelled > 0) parts.push(`${counts.cancelled} 取消`)
    if (counts.running > 0) parts.push(`${counts.running} 生成中`)
    if (counts.pending > 0) parts.push(`${counts.pending} 排队`)
    return parts.join(' / ')
  }

  function groupHasFailures(tasks: LabTask[]): boolean {
    return tasks.some((t) => t.status === 'error' || t.status === 'cancelled')
  }

  /** 组头快捷钮：整组重试失败/取消项（复用单任务 retryTask，免重传语义一致）。 */
  function retryGroupFailures(tasks: LabTask[]): void {
    for (const t of tasks) {
      if (t.status === 'error' || t.status === 'cancelled') retryTask(t.id)
    }
  }
</script>

<div class="grid gap-4 content-start">
  <div class="flex items-center gap-2">
    <h2 class="text-sm font-semibold tracking-tight">任务画廊</h2>
    {#if total > 0}
      <Badge variant="secondary" class="font-mono tabular-nums">{total} 张候选</Badge>
    {/if}
    {#if running > 0 || pending > 0}
      <Badge class="font-mono tabular-nums">生成中 {running} · 排队 {pending}</Badge>
    {/if}
    {#if total > 0}
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-destructive ml-auto"
        title="清空历史"
        onclick={() => void clearHistory()}
      >
        <Trash2 />
      </Button>
    {/if}
  </div>

  {#if groups.length === 0}
    <Card.Root class="border-dashed bg-card/60" data-testid="gallery-empty">
      <Card.Content class="bg-gem-dots flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl p-6 text-center">
        <div class="grid w-full max-w-sm gap-2 text-left">
          {#each [{ n: 1, label: '配置连接（Base URL / API Key / 模型）', ok: configured }, { n: 2, label: '上传参考原图（可选，无图走纯文生图）', ok: false }] as step (step.n)}
            <div class="bg-background/85 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs backdrop-blur-xs">
              {#if step.ok}
                <CircleCheck class="text-primary size-4 shrink-0" />
              {:else}
                <span class="text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] tabular-nums">{step.n}</span>
              {/if}
              <span class={step.ok ? 'text-muted-foreground line-through' : ''}>{step.label}</span>
            </div>
          {/each}
          <div class="bg-background/85 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
            <span class="text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] tabular-nums">3</span>
            <span>点「开始生成」，候选会出现在这里</span>
          </div>
        </div>
        {#if configured}
          <Button size="sm" onclick={emptyStateRun} data-testid="empty-run-button">
            <Sparkles />
            开始生成
          </Button>
        {:else}
          <Button size="sm" onclick={openSettings} data-testid="empty-run-button">
            <Settings2 />
            配置连接
          </Button>
        {/if}
        {#if emptyRunError}
          <p class="text-destructive text-xs" role="alert">{emptyRunError}</p>
        {/if}
      </Card.Content>
    </Card.Root>
  {:else}
    {#each groups as group (group.runId)}
      {@const collapsed = collapsedRuns[group.runId] === true}
      {@const summary = groupStatusSummary(group.tasks)}
      {@const hasFailures = groupHasFailures(group.tasks)}
      <section class="grid gap-2" data-testid="run-group">
        <!-- 组头：单行不换行（移动端截断汇总，折叠钮/时间/重试钮恒可见） -->
        <div class="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
          <button
            type="button"
            class="text-foreground flex shrink-0 cursor-pointer items-center gap-1 select-none"
            onclick={() => toggleRun(group.runId)}
            data-testid="run-toggle"
            aria-expanded={!collapsed}
          >
            <ChevronDown class={`text-muted-foreground size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
            <span class="text-xs font-semibold tracking-wide">
              {group.legacy ? '更早' : `第 ${group.runIndex} 次运行`}
            </span>
          </button>
          <span class="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">{formatRunTime(group.startedAt)}</span>
          <span class="text-muted-foreground ml-auto flex min-w-0 items-center gap-2 truncate font-mono text-[11px] tabular-nums">
            <span class="shrink-0">{group.tasks.length} 张</span>
            {#if summary}
              <span class="truncate">· {summary}</span>
            {/if}
          </span>
          {#if hasFailures}
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground shrink-0"
              title="整组重试失败项"
              onclick={() => retryGroupFailures(group.tasks)}
            >
              <RefreshCw />
            </Button>
          {/if}
        </div>
        {#if !collapsed}
          <div class="grid auto-rows-min grid-cols-2 gap-3 lg:grid-cols-3">
            {#each group.tasks as task (task.id)}
              <TaskCard {task} {onopenpreview} {onsend} />
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  {/if}
</div>
