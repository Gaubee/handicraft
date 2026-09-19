<!--
Orthogonal intents (max 3):
1. [2026-09-19 4.5 chips] 画廊头部单选 chips（全部·N + 每模板带计数[sys-templates 列表序] +
     尾部「已删模板」聚合[仅孤儿存在时]）——过滤态自持（浏览意图，与左面板编辑焦点两概念）；
     过滤后仍按批次（runId）组建，组头折叠（会话内存）+ 整组重试失败项。
2. [2026-09-19 4.5 空态] 全局空 = 三步引导卡（原样）；过滤空 = 「该模板还没有生成结果」+
     （已配置）[开始生成] /（未配置）[配置连接]。
3. [2026-09-19 4.5 清空] 「清空历史」升级确认 Dialog：并集口径下显式承诺「只清会话任务记录，
     档案保留（只读）」；可选 [同时移入库内生成结果]（软删 sys-generated 下 gemgen，二次确认列数量）。
-->

<script lang="ts">
  import * as Card from '$lib/components/ui/card'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Switch } from '$lib/components/ui/switch'
  import {
    cancelStage,
    getPendingCount,
    getRunningCount,
    getSettings,
    retryStage,
    retryTask,
    startRun,
    getTasks,
  } from '$lib/stores/lab.svelte'
  import { stageIdOf } from '$lib/lab/stages'
  import {
    clearGalleryHistory,
    countGeneratedGemgens,
    getGalleryChips,
    getGalleryEntries,
    getGalleryFilter,
    getGalleryGroups,
    isRunCollapsed,
    scheduleGalleryRefresh,
    setGalleryFilter,
    toggleRunCollapsed,
    type GalleryEntry,
  } from '$lib/stores/gallery.svelte'
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
  }: {
    onopenpreview: (entryKey: string) => void
  } = $props()

  const settings = $derived(getSettings())
  const chips = $derived(getGalleryChips())
  const filter = $derived(getGalleryFilter())
  const groups = $derived(getGalleryGroups())
  const running = $derived(getRunningCount())
  const pending = $derived(getPendingCount())
  const total = $derived(getGalleryEntries().length)

  const configured = $derived(
    settings.baseUrl.trim() !== '' && settings.apiKey.trim() !== '' && settings.model.trim() !== '',
  )

  /**
   * 库内 gemgen 投影同步：任务账本指纹（状态推进 / 归档回写 assetId）变化 → 合并重扫。
   * 并集去重的真源在库（task.assetId 认领 gemgen），任务终态后必须重扫一次才不漏史洞补全。
   */
  $effect(() => {
    getTasks()
      .map((t) => `${t.id}:${t.status}:${t.assetId ?? ''}`)
      .join('|')
    scheduleGalleryRefresh()
  })

  /** 空态/过滤空态内嵌 CTA（与 RunBar 同一动作口径）；发起失败就地提示 */
  let emptyRunError = $state('')

  function emptyStateRun(): void {
    emptyRunError = ''
    const result = startRun()
    if (!result.ok) emptyRunError = result.error ?? '发起失败'
  }

  /** 组头时间：批次发起时刻（组内最早 createdAt）→ 本地 HH:mm。 */
  function formatRunTime(ts: number): string {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** 组头状态汇总：只读卡（库来源）计入「成功」；全成功时返回空串（只显张数）。 */
  function groupStatusSummary(entries: GalleryEntry[]): string {
    const counts: Record<GalleryEntry['status'], number> = { success: 0, error: 0, cancelled: 0, running: 0, pending: 0 }
    for (const entry of entries) counts[entry.status] += 1
    if (counts.success === entries.length) return ''
    const parts: string[] = []
    if (counts.success > 0) parts.push(`${counts.success} 成功`)
    if (counts.error > 0) parts.push(`${counts.error} 失败`)
    if (counts.cancelled > 0) parts.push(`${counts.cancelled} 取消`)
    if (counts.running > 0) parts.push(`${counts.running} 生成中`)
    if (counts.pending > 0) parts.push(`${counts.pending} 排队`)
    return parts.join(' / ')
  }

  function groupHasFailures(entries: GalleryEntry[]): boolean {
    return entries.some((entry) => entry.live && (entry.status === 'error' || entry.status === 'cancelled'))
  }

  /** 组头快捷钮：整组重试失败/取消项（复用单任务 retryTask，免重传语义一致；只读卡无此语义）。 */
  function retryGroupFailures(entries: GalleryEntry[]): void {
    for (const entry of entries) {
      if (entry.live && entry.task && (entry.status === 'error' || entry.status === 'cancelled')) {
        retryTask(entry.task.id)
      }
    }
  }

  // ----- 清空历史确认 Dialog（两步：勾选「同时移入库内生成结果」时二次确认列数量） -----

  let clearOpen = $state(false)
  let clearAlsoRemove = $state(false)
  /** 1 = 语义确认；2 = 数量二次确认（仅勾选软删时进入）。 */
  let clearStep = $state<1 | 2>(1)
  let clearCount = $state(0)
  let clearing = $state(false)

  function openClearDialog(): void {
    clearStep = 1
    clearAlsoRemove = false
    clearOpen = true
  }

  async function proceedClear(): Promise<void> {
    if (clearAlsoRemove) {
      clearCount = await countGeneratedGemgens()
      if (clearCount > 0) {
        clearStep = 2
        return
      } // 库内无生成档案：无需二次确认，直接执行
    }
    await executeClear()
  }

  async function executeClear(): Promise<void> {
    clearing = true
    try {
      await clearGalleryHistory({ trashGemgens: clearAlsoRemove })
      clearOpen = false
    } finally {
      clearing = false
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
        data-testid="clear-history-open"
        onclick={openClearDialog}
      >
        <Trash2 />
      </Button>
    {/if}
  </div>

  {#if total > 0}
    <!-- 过滤 chips 行：单选；移动端横滑（shrink-0 + overflow-x-auto）；chips=过滤态（浏览意图） -->
    <div
      class="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1"
      role="group"
      aria-label="按模板过滤画廊"
    >
      {#each chips as chip (chip.filter)}
        <button
          type="button"
          class={`flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${
            filter === chip.filter
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          data-testid="gallery-chip"
          data-filter={chip.filter}
          aria-pressed={filter === chip.filter}
          title={chip.orphanTemplateNames ? `模板已删除或移出模板目录：${chip.orphanTemplateNames.join('、')}` : undefined}
          onclick={() => setGalleryFilter(chip.filter)}
        >
          <span class="max-w-40 truncate">{chip.label}</span>
          <span class="font-mono text-[10px] tabular-nums opacity-80">{chip.count}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if total === 0}
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
  {:else if groups.length === 0}
    <!-- 过滤空态（B.3）：全局非空但当前 chip 下无结果；换 chip 或去生成 -->
    <Card.Root class="border-dashed bg-card/60" data-testid="gallery-filter-empty">
      <Card.Content class="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl p-6 text-center">
        <p class="text-muted-foreground text-xs">该模板还没有生成结果</p>
        {#if configured}
          <Button size="sm" onclick={emptyStateRun} data-testid="filter-empty-run-button">
            <Sparkles />
            开始生成
          </Button>
        {:else}
          <Button size="sm" onclick={openSettings} data-testid="filter-empty-run-button">
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
      {@const collapsed = isRunCollapsed(group.runId)}
      {@const summary = groupStatusSummary(group.entries)}
      {@const hasFailures = groupHasFailures(group.entries)}
      <section class="grid gap-2" data-testid="run-group" data-run-id={group.runId}>
        <!-- 组头：单行不换行（移动端截断汇总，折叠钮/时间/重试钮恒可见） -->
        <div class="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
          <button
            type="button"
            class="text-foreground flex shrink-0 cursor-pointer items-center gap-1 select-none"
            onclick={() => toggleRunCollapsed(group.runId)}
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
            <span class="shrink-0">{group.entries.length} 张</span>
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
              onclick={() => retryGroupFailures(group.entries)}
            >
              <RefreshCw />
            </Button>
          {/if}
        </div>
        {#if !collapsed}
          <!-- 两态卡为全宽单行（移动端同构）；收起行点击展开 -->
          <div class="grid gap-2">
            {#each group.entries as entry (entry.key)}
              <!-- [4.4] 蓝图单独动作接线（C3.3 回调缝 → lab store stage 级 API） -->
              <TaskCard
                {entry}
                {onopenpreview}
                onBlueprintAction={(kind, taskId) =>
                  kind === 'retry'
                    ? retryStage(stageIdOf(taskId, 'blueprint'))
                    : cancelStage(stageIdOf(taskId, 'blueprint'))}
              />
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<!-- 清空历史确认 Dialog（并集口径语义升级：只清会话记录，档案保留只读；可选连带软删） -->
<Dialog.Root bind:open={clearOpen}>
  <Dialog.Content class="max-w-md" data-testid="clear-history-dialog">
    <Dialog.Header>
      <Dialog.Title class="text-sm">清空历史</Dialog.Title>
      {#if clearStep === 1}
        <Dialog.Description>
          清除本次会话任务记录；生成结果档案保留在素材库与画廊（只读）。
        </Dialog.Description>
      {:else}
        <Dialog.Description>
          将同时把 {clearCount} 个生成结果档案移入回收站（可在回收站还原）。此操作不影响上传与导出素材。
        </Dialog.Description>
      {/if}
    </Dialog.Header>

    {#if clearStep === 1}
      <label class="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 text-xs">
        <span>
          <span class="block font-medium">同时移入库内生成结果</span>
          <span class="text-muted-foreground">软删「生成结果」目录下的 .gemgen 档案（进回收站，可还原）</span>
        </span>
        <Switch bind:checked={clearAlsoRemove} data-testid="clear-history-also-remove" />
      </label>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" disabled={clearing} onclick={() => (clearOpen = false)}>
        取消
      </Button>
      {#if clearStep === 1}
        <Button
          variant="destructive"
          size="sm"
          disabled={clearing}
          data-testid="clear-history-confirm"
          onclick={() => void proceedClear()}
        >
          {clearing ? '清除中…' : '清除'}
        </Button>
      {:else}
        <Button variant="ghost" size="sm" disabled={clearing} onclick={() => (clearStep = 1)}>
          返回
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={clearing}
          data-testid="clear-history-confirm-final"
          onclick={() => void executeClear()}
        >
          {clearing ? '清除中…' : `确认清除（含 ${clearCount} 个档案）`}
        </Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
