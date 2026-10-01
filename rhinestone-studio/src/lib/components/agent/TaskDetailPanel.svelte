<!--
TaskDetailPanel.svelte — 任务详情面板（rework-layer-model v4 design §4：详情=工作台
紧凑形态——「详情面板直接挂载工作台紧凑形态（同组件、同 store）」）。
形态：面板头（任务标题+总钻数徽标+「打开完整工作台」纯放大+「继续对话」）
+款钻用量 chips 行+TaskWorkbenchView（embedded——无自带顶栏；窄容器=迷你画布+
图层列表+选中层摘要+关键操作）。
同 store 会话：workbench store 为模块级单例——右栏/Sheet 与完整工作台同一状态源，
「打开完整工作台」=openStudioTask 纯放大（无状态迁移）。
单实例：桌面第三栏与移动 Sheet 经 AgentView 的同一 snippet 渲染（不双挂）。
[zhumo 对照清单 T2 2026-09-28] 头部工件清单卡（zhumo TaskDetailPanel 导出结果列表
同款形态）：会话工件帧投影（相邻同名去重）——「导出工件 N」折叠头 + 28px 行
（名称+外链 icon 新窗口开 raw）；transcript 尾部 chip 墙收敛后的工件读面。
[product-polish-w1 T2/T3 2026-10-01] 总钻数徽标+款钻 chips（N1 报价闭环——王老板
在面板头一眼见「N 颗 · M 款」）：task-layout 实排快照聚合（与导出 BOM 同源）；
top 5 款 chip（贴图缩略 80% contains+401 自愈+SKU+颗数），其余「+K 款」折叠
（工件清单卡同款折叠形态）；运行中显「排钻中…」占位不硬编。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
  import { openStudioTask } from '$lib/stores/view.svelte'
  import { getActiveSessionTaskFrames, getActiveTasks } from '$lib/agentApi/store.svelte'
  import { assetRawUrl, retryRawImageOnError } from '$lib/agentApi/attachments'
  import { isImageArtifactName } from '$lib/agentApi/artifactKind'
  import Lightbox from './Lightbox.svelte'
  import {
    GEM_COUNT_CALIBER_TITLE,
    stoneTextureUrl,
    taskGemSummaries,
    taskLayoutRefsOfFrames,
    type GemStoneUsage,
  } from '$lib/agentApi/gemSummary.svelte'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import ImageIcon from '@lucide/svelte/icons/image'
  import MessageCircle from '@lucide/svelte/icons/message-circle'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Gem from '@lucide/svelte/icons/gem'

  let {
    taskId,
    onBackToChat,
  }: {
    /** 活跃会话最新任务（followup 进行中跟随切换）。 */
    taskId: string
    /** 「继续对话」：回对话栏（AgentView 聚焦输入框/移动端收抽屉）。 */
    onBackToChat: () => void
  } = $props()

  /** 工件清单（T2）：来源任务的 artifact 帧——相邻同名去重（与 transcript 投影同口径）。 */
  const artifacts = $derived.by(() => {
    const groups = getActiveSessionTaskFrames()
    const frames = groups.find((group) => group.taskId === taskId)?.frames ?? []
    const out: Array<{ key: string; name: string; blobRef?: string }> = []
    for (const frame of frames) {
      if (frame.kind !== 'artifact') continue
      const name = frame.payload.name ?? '产物'
      const prev = out[out.length - 1]
      if (prev !== undefined && prev.name === name) continue
      const blobRef = frame.payload.blobRef
      out.push({ key: `${out.length}-${name}`, name, ...(blobRef !== undefined ? { blobRef } : {}) })
    }
    return out
  })

  /**
   * [w17-critic T5] 图片类工件 → 应用内 Lightbox（items=该任务全部图片类工件——
   * 就近可左右切全组；blobRef 缺席的行不进组）。外链新窗口只作 Lightbox 内保底。
   */
  const imageArtifacts = $derived(
    artifacts
      .filter((art) => art.blobRef !== undefined && isImageArtifactName(art.name))
      .map((art) => ({ blobRef: art.blobRef!, name: art.name })),
  )
  let lightboxIndex = $state<number | null>(null)

  let artifactsOpen = $state(false)

  // ------------------------------------------------------------ 总钻数（T2/T3）

  /** 任务状态（「排钻中…」占位门——running/queued 数字未定不硬编）。 */
  const taskStatus = $derived(getActiveTasks().find((task) => task.taskId === taskId)?.status ?? null)
  const taskRunning = $derived(taskStatus === 'running' || taskStatus === 'queued')

  /** 该任务全部 task-layout 摘要（多图逐图；null 项=未就绪——就绪后 $state 自动重渲）。 */
  const gemSummaries = $derived.by(() => {
    const groups = getActiveSessionTaskFrames()
    const frames = groups.find((group) => group.taskId === taskId)?.frames ?? []
    return taskGemSummaries(taskId, taskLayoutRefsOfFrames(frames)).filter(
      (summary): summary is NonNullable<typeof summary> => summary !== null,
    )
  })

  /** 面板徽标口径：跨图合计颗数+去重款数；逐款用量跨图合并（同款颗数相加）。 */
  const gemBadge = $derived.by(() => {
    if (gemSummaries.length === 0) return null
    const byRef = new Map<string, GemStoneUsage>()
    let total = 0
    for (const summary of gemSummaries) {
      total += summary.totalGems
      for (const stone of summary.stones) {
        const existing = byRef.get(stone.stoneRef)
        if (existing !== undefined) existing.count += stone.count
        else byRef.set(stone.stoneRef, { ...stone })
      }
    }
    const stones = [...byRef.values()].sort(
      (a, b) => b.count - a.count || (a.stoneRef < b.stoneRef ? -1 : a.stoneRef > b.stoneRef ? 1 : 0),
    )
    return { total, stones }
  })

  /** chips 折叠（T2：top 5 款 + 其余「+K 款」——工件清单卡同款折叠形态）。 */
  const GEM_CHIP_TOP_N = 5
  let gemChipsOpen = $state(false)
  const gemChipHidden = $derived(gemBadge !== null ? Math.max(0, gemBadge.stones.length - GEM_CHIP_TOP_N) : 0)
  const gemChipStones = $derived(
    gemBadge === null ? [] : gemChipsOpen || gemBadge.stones.length <= GEM_CHIP_TOP_N ? gemBadge.stones : gemBadge.stones.slice(0, GEM_CHIP_TOP_N),
  )
</script>

<div class="bg-background flex h-full min-h-0 flex-col" data-testid="task-detail-panel">
  <!-- 面板头：动作区（总钻数徽标 N1 报价闭环 + 打开完整工作台=纯放大同会话；继续对话收抽屉） -->
  <div class="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-2">
    <span class="text-xs font-semibold">任务详情</span>
    <span class="text-muted-foreground/70 shrink-0 text-[10px]" title="窄容器=工作台紧凑形态（同会话）">=工作台</span>
    <!-- [T2/T3] 总钻数徽标：实排颗数·用料款数（title=口径注释）；运行中占位不硬编。 -->
    {#if gemBadge !== null}
      <span
        class="bg-primary/10 text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
        data-testid="task-detail-gem-badge"
        title={GEM_COUNT_CALIBER_TITLE}
      >
        <Gem class="size-3 shrink-0" aria-hidden="true" />
        <!-- 单行插值（Svelte 编译期剥行内元素边界空格——数字段不跨行拼）。 -->
        <span>{gemBadge.total.toLocaleString('zh-CN')} 颗 · {gemBadge.stones.length} 款</span>
      </span>
    {:else if taskRunning}
      <span
        class="text-muted-foreground shrink-0 text-[11px]"
        data-testid="task-detail-gem-pending"
        title="任务运行中——排钻结果未定，完成后在此显示总颗数与款数"
      >
        排钻中…
      </span>
    {/if}
    <div class="ml-auto flex shrink-0 gap-1.5">
      <Button size="sm" class="h-7 px-2 text-[11px]" onclick={() => openStudioTask(taskId)} data-testid="task-detail-open-workbench" title="放大为完整工作台（同会话继续——无状态迁移）">
        <ExternalLink class="size-3.5" aria-hidden="true" />
        完整工作台
      </Button>
      <Button size="sm" variant="outline" class="h-7 px-2 text-[11px]" onclick={onBackToChat} data-testid="task-detail-back-chat">
        <MessageCircle class="size-3.5" aria-hidden="true" />
        继续对话
      </Button>
    </div>
  </div>

  {#if gemBadge !== null && gemBadge.stones.length > 0}
    <!-- 款钻用量 chips（T2）：top 5 款贴图缩略+SKU+颗数；其余「+K 款」折叠展开
         （工件清单卡同款折叠形态）。贴图=80% contains+底色 hex 兜底+401 自愈。 -->
    <div class="shrink-0 border-b px-2.5 py-2" data-testid="task-detail-gem-chips">
      <div class="flex flex-wrap items-center gap-1">
        {#each gemChipStones as stone (stone.stoneRef)}
          <span
            class="border-border bg-muted/30 inline-flex h-7 items-center gap-1.5 rounded-full border pl-0.5 pr-2"
            data-testid="task-detail-gem-chip"
            title="{stone.name}（{stone.supplier}/{stone.sku} · 首见规格 {stone.diameterMm}mm）× {stone.count} 颗——{GEM_COUNT_CALIBER_TITLE}"
          >
            <span class="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full" style="background-color: {stone.hex}26">
              <img
                src={stoneTextureUrl(stone.stoneRef)}
                alt=""
                class="size-[80%] object-contain"
                loading="lazy"
                onerror={retryRawImageOnError}
              />
            </span>
            <span class="max-w-24 truncate text-[11px] font-medium">{stone.sku}</span>
            <span class="text-muted-foreground text-[11px] tabular-nums">×{stone.count}</span>
          </span>
        {/each}
        {#if gemChipHidden > 0}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex h-7 items-center gap-0.5 rounded-full px-2 text-[11px] transition-colors"
            data-testid="task-detail-gem-more"
            aria-expanded={gemChipsOpen}
            onclick={() => (gemChipsOpen = !gemChipsOpen)}
          >
            {gemChipsOpen ? '收起' : `+${gemChipHidden} 款`}
            <ChevronDown class="size-3 transition-transform {gemChipsOpen ? 'rotate-180' : ''}" aria-hidden="true" />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if artifacts.length > 0}
    <!-- 工件清单卡（T2）：折叠头「导出工件 N」+ 28px 行（名称+外链 raw 新窗口）。 -->
    <div class="shrink-0 border-b px-2.5 py-2" data-testid="task-artifacts-card">
      <button
        type="button"
        class="flex w-full items-center gap-1 text-left text-xs font-medium"
        aria-expanded={artifactsOpen}
        data-testid="task-artifacts-toggle"
        onclick={() => (artifactsOpen = !artifactsOpen)}
      >
        <span>导出工件</span>
        <span class="text-[11px] font-normal text-muted-foreground">{artifacts.length}</span>
        <ChevronDown
          class="text-muted-foreground ml-auto size-3 shrink-0 transition-transform {artifactsOpen ? 'rotate-180' : ''}"
          aria-hidden="true"
        />
      </button>
      {#if artifactsOpen}
        <div class="mt-1 space-y-0.5">
          {#each artifacts as art (art.key)}
            {#if art.blobRef !== undefined && isImageArtifactName(art.name)}
              <!-- [w17-critic T5] 图片类工件：点击开应用内 Lightbox（缩放/平移/组内切图）。 -->
              <button
                type="button"
                class="hover:bg-muted/60 flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-xs transition-colors"
                data-testid="task-artifact-row"
                data-image="true"
                title="{art.name}——点击查看大图"
                onclick={() => {
                  const index = imageArtifacts.findIndex((item) => item.blobRef === art.blobRef)
                  lightboxIndex = index >= 0 ? index : 0
                }}
              >
                <span class="min-w-0 flex-1 truncate text-left">{art.name}</span>
                <ImageIcon class="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
              </button>
            {:else if art.blobRef !== undefined}
              <a
                href={assetRawUrl(art.blobRef)}
                target="_blank"
                rel="noopener"
                class="flex h-7 items-center justify-between gap-2 rounded-md px-2 text-xs transition-colors hover:bg-muted/60"
                data-testid="task-artifact-row"
                title="{art.name}——在新窗口打开"
              >
                <span class="min-w-0 flex-1 truncate">{art.name}</span>
                <ExternalLink class="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
              </a>
            {:else}
              <div class="text-muted-foreground flex h-7 items-center rounded-md px-2 text-xs" data-testid="task-artifact-row">
                <span class="min-w-0 flex-1 truncate">{art.name}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- 工作台紧凑形态（embedded：装载/错误/空树态由工作台自承载；容器查询自适应） -->
  <div class="min-h-0 flex-1">
    <TaskWorkbenchView {taskId} embedded />
  </div>

  {#if lightboxIndex !== null && imageArtifacts.length > 0}
    <Lightbox items={imageArtifacts} index={lightboxIndex} onclose={() => (lightboxIndex = null)} />
  {/if}
</div>
