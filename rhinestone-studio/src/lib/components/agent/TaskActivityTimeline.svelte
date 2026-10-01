<!--
TaskActivityTimeline.svelte — 任务详情「活动」tab 时间线（[4] 2026-10-02 Owner
需求「任务详情=整个任务会话的投影——知道任务过去发生了什么、现在正在发生什么」）。
条目=一次工具调用（activity 帧 running+终态按 activityId 配对合并——投影真源
$lib/agentApi/activity.svelte；未配对 running=进行中）：
  - 主行：状态点（running=呼吸 pulse/ok=常绿/error=红/cancelled=灰）+label+
    耗时（终态 durationMs 人话化；running=「已进行 Ns」实时秒表）。
  - 展开行（点击主行，有明细才可展）：inputSummary/outputSummary/errorBrief+
    outputBlobRef 缩略图（assetRawUrl——点击 Lightbox 大图，组=全部产出图；
    token 自愈重试后仍不可渲染（JSON 工件类引用等）→ 中性占位
    「产出已留存（内部引用）」不裂图——w20 走查 major-1 前端兜底）。
  - 排序：时间正序（旧的在上）+自动滚到最新（用户上滚 >200px 停手，FAB 回底
    ——TranscriptView 滚动跟随先例同口径）。
  - 空态：任务无 activity 帧（旧任务/新任务未起步）＝「暂无活动记录」。
实时性：frames 为 store framesByTask 的 $derived 透传——新帧经既有 WS/回放通道
到达（ingestFrame）即重投影，不另开通道。
-->

<script lang="ts">
  import type { Frame } from '@handicraft/contracts'
  import Lightbox from './Lightbox.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import IconArrowDown from '@lucide/svelte/icons/arrow-down'
  import { assetRawUrl, retryRawImageOnError } from '$lib/agentApi/attachments'
  import { currentStoredToken } from '$lib/daemonToken'
  import {
    activityElapsedSec,
    formatActivityDuration,
    projectActivity,
    type ActivityEntry,
  } from '$lib/agentApi/activity.svelte'

  let {
    frames,
  }: {
    /** 该任务的全部帧（activity 帧由投影过滤——同通道透传，不另开数据面）。 */
    frames: Frame[]
  } = $props()

  const entries = $derived(projectActivity(frames))
  /** 进行中秒表驱动（有在途条目才 tick——终态任务零 interval）。 */
  let nowTs = $state(Date.now())
  $effect(() => {
    if (!entries.some((entry) => entry.status === 'running')) return
    const timer = setInterval(() => {
      nowTs = Date.now()
    }, 1000)
    return () => clearInterval(timer)
  })

  function durationLabel(entry: ActivityEntry): string {
    if (entry.status === 'running') return `已进行 ${activityElapsedSec(entry.startedAt, nowTs)}s`
    return entry.durationMs !== undefined ? formatActivityDuration(entry.durationMs) : ''
  }

  /** 状态点配色（running=呼吸 pulse；终态与面板状态徽标色族对齐）。 */
  const DOT_CLASS: Record<ActivityEntry['status'], string> = {
    running: 'bg-primary animate-pulse',
    ok: 'bg-emerald-500',
    error: 'bg-destructive',
    cancelled: 'bg-muted-foreground/50',
  }
  const STATUS_TITLE: Record<ActivityEntry['status'], string> = {
    running: '进行中',
    ok: '已完成',
    error: '失败',
    cancelled: '已取消',
  }

  // ---------------------------------------------------------------- 展开行

  let openIds = $state<Record<string, boolean>>({})

  function toggle(entry: ActivityEntry): void {
    openIds = { ...openIds, [entry.activityId]: !(openIds[entry.activityId] ?? false) }
  }

  /** 可展开=任一明细在场（无明细的行点击无义——不可展）。 */
  function expandable(entry: ActivityEntry): boolean {
    return (
      entry.inputSummary !== undefined ||
      entry.outputSummary !== undefined ||
      entry.errorBrief !== undefined ||
      entry.outputBlobRef !== undefined
    )
  }

  // ---------------------------------------------------------------- Lightbox（产出图组）

  /**
   * 终态不可渲染的产出引用（w20 走查 major-1 前端兜底）：token 自愈重试后仍失败
   * （415=JSON 工件类引用/字节缺失等）→ 中性占位「产出已留存（内部引用）」不裂图。
   * key=blobRef（内容寻址——同引用失败不随条目重复）。
   */
  let failedOutputs = $state<Record<string, boolean>>({})

  function handleThumbError(entry: ActivityEntry, event: Event): void {
    const img = event.currentTarget
    if (!(img instanceof HTMLImageElement)) return
    let used: string | null = null
    try {
      used = new URL(img.src).searchParams.get('token')
    } catch {
      used = null
    }
    const fresh = currentStoredToken()
    if (fresh !== null && fresh !== used) {
      retryRawImageOnError(event) // 401 token 代际自愈——换新 token 重试一次
      return
    }
    if (entry.outputBlobRef !== undefined) {
      failedOutputs = { ...failedOutputs, [entry.outputBlobRef]: true }
    }
  }

  /** 全部产出图（组内左右切——同任务工件 Lightbox 先例；终态失败引用不进组）。 */
  const outputImages = $derived(
    entries
      .filter((entry) => entry.outputBlobRef !== undefined && failedOutputs[entry.outputBlobRef] !== true)
      .map((entry) => ({ blobRef: entry.outputBlobRef!, name: entry.label })),
  )
  let lightboxIndex = $state<number | null>(null)

  function openLightbox(entry: ActivityEntry): void {
    if (entry.outputBlobRef === undefined) return
    const index = outputImages.findIndex((item) => item.blobRef === entry.outputBlobRef)
    lightboxIndex = index >= 0 ? index : 0
  }

  // ---------------------------------------------------------------- 滚动跟随（TranscriptView 同口径）

  let scrollBody = $state<HTMLElement | null>(null)
  let awayFromBottom = $state(false)
  let lastContentHeight = 0
  // 首帧跟随完成前容器不可见（mount 期中间态闪现——TranscriptView firstFollowDone 同式）。
  let firstFollowDone = $state(false)
  $effect(() => {
    void entries.length
    const body = scrollBody
    if (!body) return
    const follow = (): void => {
      const wasNearBottom = lastContentHeight - body.scrollTop - body.clientHeight < 160
      lastContentHeight = body.scrollHeight
      if (wasNearBottom || body.scrollHeight - body.scrollTop - body.clientHeight < 160) {
        body.scrollTop = body.scrollHeight
      }
      awayFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight > 200
      firstFollowDone = true
    }
    follow()
    const observer = new ResizeObserver(follow)
    for (const child of body.children) observer.observe(child)
    return () => observer.disconnect()
  })

  function backToBottom(): void {
    const body = scrollBody
    if (body) {
      body.scrollTop = body.scrollHeight
      lastContentHeight = body.scrollHeight
      awayFromBottom = false
    }
  }
</script>

<div class="relative min-h-0 flex-1">
  <div
    bind:this={scrollBody}
    class="h-full overflow-y-auto px-3 py-3 transition-none"
    class:invisible={!firstFollowDone}
    onscroll={(event) => {
      const body = event.currentTarget
      lastContentHeight = body.scrollHeight
      awayFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight > 200
    }}
  >
    {#if entries.length === 0}
      <div class="flex h-full items-center justify-center">
        <p class="max-w-[280px] text-center text-xs text-muted-foreground" data-testid="task-activity-empty">暂无活动记录</p>
      </div>
    {:else}
      <div class="space-y-1">
        {#each entries as entry (entry.activityId)}
          {@const open = openIds[entry.activityId] ?? false}
          {@const canExpand = expandable(entry)}
          <div data-testid="task-activity-row" data-activity-id={entry.activityId} data-status={entry.status}>
            <button
              type="button"
              class="hover:bg-muted/60 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors"
              aria-expanded={canExpand ? open : undefined}
              data-testid="task-activity-row-toggle"
              title="{entry.label}（{entry.tool}）"
              onclick={() => canExpand && toggle(entry)}
            >
              <span class="size-2 shrink-0 rounded-full {DOT_CLASS[entry.status]}" aria-hidden="true" title="{STATUS_TITLE[entry.status]}——{entry.tool}"></span>
              <span class="min-w-0 flex-1 truncate font-medium" data-testid="task-activity-label">{entry.label}</span>
              {#if entry.status === 'running'}
                <span class="text-primary shrink-0 text-[11px] tabular-nums" data-testid="task-activity-duration">{durationLabel(entry)}</span>
              {:else if durationLabel(entry) !== ''}
                <span
                  class="shrink-0 text-[11px] tabular-nums {entry.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}"
                  data-testid="task-activity-duration"
                >{durationLabel(entry)}</span>
              {/if}
              {#if canExpand}
                <ChevronDown class="text-muted-foreground size-3 shrink-0 transition-transform {open ? 'rotate-180' : ''}" aria-hidden="true" />
              {/if}
            </button>
            {#if open && canExpand}
              <!-- 展开明细：输入/产出/失败简述+产出图缩略（assetRawUrl——点击 Lightbox）。 -->
              <div class="mt-0.5 mb-1 space-y-1.5 rounded-md border bg-card px-2.5 py-2 text-[11px]" data-testid="task-activity-detail">
                {#if entry.inputSummary !== undefined}
                  <p class="min-w-0" data-testid="task-activity-input">
                    <span class="text-muted-foreground shrink-0">输入 · </span>{entry.inputSummary}
                  </p>
                {/if}
                {#if entry.outputSummary !== undefined}
                  <p class="min-w-0" data-testid="task-activity-output">
                    <span class="text-muted-foreground shrink-0">产出 · </span>{entry.outputSummary}
                  </p>
                {/if}
                {#if entry.errorBrief !== undefined}
                  <p class="text-destructive min-w-0" role="alert" data-testid="task-activity-error">{entry.errorBrief}</p>
                {/if}
                {#if entry.outputBlobRef !== undefined}
                  {#if failedOutputs[entry.outputBlobRef] === true}
                    <!-- 终态不可渲染（token 自愈后仍失败——JSON 工件类引用/字节缺失）：中性占位不裂图。 -->
                    <div
                      class="text-muted-foreground flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-[11px]"
                      data-testid="task-activity-thumb-fallback"
                      title="产出已留存（内部引用）——当前不可预览"
                    >
                      <span>产出已留存（内部引用）</span>
                    </div>
                  {:else}
                    <button
                      type="button"
                      class="border-border bg-muted/30 hover:bg-muted/60 block overflow-hidden rounded-md border p-0 transition-colors"
                      title="{entry.label}——点击查看大图"
                      data-testid="task-activity-thumb"
                      onclick={() => openLightbox(entry)}
                    >
                      <img
                        src={assetRawUrl(entry.outputBlobRef, 320)}
                        alt="{entry.label}产出图"
                        class="max-h-40 w-auto"
                        loading="lazy"
                        onerror={(event) => handleThumbError(entry, event)}
                      />
                    </button>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
  {#if awayFromBottom}
    <button
      type="button"
      class="absolute top-3 right-3 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-md transition-colors hover:text-foreground"
      title="回到底部"
      aria-label="回到底部"
      data-testid="task-activity-back-bottom"
      onclick={backToBottom}
    >
      <IconArrowDown class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  {/if}
</div>

{#if lightboxIndex !== null && outputImages.length > 0}
  <Lightbox items={outputImages} index={lightboxIndex} onclose={() => (lightboxIndex = null)} />
{/if}
