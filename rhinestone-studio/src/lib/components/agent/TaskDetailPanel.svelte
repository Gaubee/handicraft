<!--
TaskDetailPanel.svelte — 任务详情面板（rework-layer-model v4 design §4：详情=工作台
紧凑形态——「详情面板直接挂载工作台紧凑形态（同组件、同 store）」）。
形态：面板头（任务标题+「打开完整工作台」纯放大+「继续对话」）+TaskWorkbenchView
（embedded——无自带顶栏；窄容器=迷你画布+图层列表+选中层摘要+关键操作）。
同 store 会话：workbench store 为模块级单例——右栏/Sheet 与完整工作台同一状态源，
「打开完整工作台」=openStudioTask 纯放大（无状态迁移）。
单实例：桌面第三栏与移动 Sheet 经 AgentView 的同一 snippet 渲染（不双挂）。
[zhumo 对照清单 T2 2026-09-28] 头部工件清单卡（zhumo TaskDetailPanel 导出结果列表
同款形态）：会话工件帧投影（相邻同名去重）——「导出工件 N」折叠头 + 28px 行
（名称+外链 icon 新窗口开 raw）；transcript 尾部 chip 墙收敛后的工件读面。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
  import { openStudioTask } from '$lib/stores/view.svelte'
  import { getActiveSessionTaskFrames } from '$lib/agentApi/store.svelte'
  import { assetRawUrl } from '$lib/agentApi/attachments'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import MessageCircle from '@lucide/svelte/icons/message-circle'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'

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

  let artifactsOpen = $state(false)
</script>

<div class="bg-background flex h-full min-h-0 flex-col" data-testid="task-detail-panel">
  <!-- 面板头：动作区（打开完整工作台=纯放大同会话；继续对话收抽屉） -->
  <div class="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-2">
    <span class="text-xs font-semibold">任务详情</span>
    <span class="text-muted-foreground/70 shrink-0 text-[10px]" title="窄容器=工作台紧凑形态（同会话）">=工作台</span>
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
            {#if art.blobRef !== undefined}
              <a
                href={assetRawUrl(art.blobRef)}
                target="_blank"
                rel="noopener"
                class="flex h-7 items-center justify-between gap-2 rounded-md px-2 text-xs transition-colors hover:bg-muted/60"
                data-testid="task-artifact-row"
                title="{art.name}——在新窗口打开原图"
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
</div>
