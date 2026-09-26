<!--
StudioView.svelte — 排钻工作台路由（add-task-detail-layer-workbench 2.1/2.4 重构）。
三分支：
  [1] 任务上下文（studioTaskId——SessionStream 任务卡「打开任务详情」置位）→
      TaskWorkbenchView（任务详情工作台：图层管理/拆层/策略直改——D-1 人类主权面）。
  [2] 引擎实验模式（模式选择进入；handoff 送排钻/gemproj 意图自动路由——旧动线保持）→
      EngineExperimentView（旧 Block/Layer/Palette/Segment 纯前端面板——归档保留，逻辑零改动）。
  [3] 无上下文默认 → 模式选择（任务工作台空态引导 vs 引擎实验入口）。
旧面板本体见 src/lib/components/studio/EngineExperimentView.svelte（2.4 迁移）。
-->

<script lang="ts">
  import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
  import EngineExperimentView from '$lib/components/studio/EngineExperimentView.svelte'
  import { getHandoff } from '$lib/stores/handoff.svelte'
  import { peekOpenIntent } from '$lib/stores/openIntent.svelte'
  import { getStudioTaskId } from '$lib/stores/view.svelte'
  import FlaskConical from '@lucide/svelte/icons/flask-conical'
  import ListTree from '@lucide/svelte/icons/list-tree'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'

  const taskContext = $derived(getStudioTaskId())

  /** 引擎实验模式（组件实例态——切 tab 保持；派生进入不写环）。
   *  自动进入信号=旧动线锚：handoff 送排钻 / gemproj 打开意图（App peek 切 studio 后
   *  由引擎面 claim 消费——路由不吞旧动线）。 */
  let studioMode = $state<'select' | 'engine'>('select')
  const gemprojIntentActive = $derived.by(() => {
    const intent = peekOpenIntent()
    return intent !== null && intent.phase === 'pending' && intent.kind === 'gemproj'
  })
  const effectiveMode = $derived(
    studioMode === 'engine' || getHandoff() !== null || gemprojIntentActive ? 'engine' : 'select',
  )
</script>

{#if taskContext !== null}
  <!-- [1] 任务详情工作台（任务上下文——SessionStream 入口唯一写面 openStudioTask） -->
  <TaskWorkbenchView taskId={taskContext} />
{:else if effectiveMode === 'engine'}
  <!-- [2] 引擎实验（旧排钻面板——归档保留；顶条提供返回模式选择出口） -->
  <div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="studio-engine-wrap">
    <div class="bg-background/80 flex h-7 shrink-0 items-center gap-2 border-b px-3 text-[11px] backdrop-blur">
      <FlaskConical class="text-muted-foreground size-3" aria-hidden="true" />
      <span class="text-muted-foreground">引擎实验（旧排钻面板——纯前端引擎对照保留）</span>
      <button
        type="button"
        onclick={() => (studioMode = 'select')}
        data-testid="studio-engine-exit"
        class="text-muted-foreground hover:text-foreground ml-auto font-medium transition-colors"
      >
        返回模式选择
      </button>
    </div>
    <div class="min-h-0 min-w-0 flex-1">
      <EngineExperimentView />
    </div>
  </div>
{:else}
  <!-- [3] 模式选择（无任务上下文默认面） -->
  <div class="flex h-full min-h-0 items-center justify-center overflow-y-auto p-6" data-testid="studio-mode-select">
    <div class="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
      <div class="bg-card rounded-xl border p-5 shadow-sm" data-testid="studio-mode-workbench">
        <div class="mb-3 flex items-center gap-2">
          <ListTree class="text-primary size-4" aria-hidden="true" />
          <h3 class="text-sm font-semibold">任务工作台</h3>
        </div>
        <p class="text-muted-foreground mb-4 text-xs leading-relaxed">
          基于 Agent 会话任务装载任务详情：图层管理（重命名/显隐/蒙版）、人类拆层、贴钻策略直改（直接生效）。入口在 Agent 会话的任务完成卡——「打开任务详情」。
        </p>
        <p class="text-muted-foreground/80 text-[11px] leading-relaxed">
          尚未选择任务。去 Agent 会话完成一次排钻旅程，或打开既有任务的详情。
        </p>
      </div>
      <div class="bg-card rounded-xl border p-5 shadow-sm" data-testid="studio-mode-engine">
        <div class="mb-3 flex items-center gap-2">
          <FlaskConical class="text-muted-foreground size-4" aria-hidden="true" />
          <h3 class="text-sm font-semibold">引擎实验</h3>
        </div>
        <p class="text-muted-foreground mb-4 text-xs leading-relaxed">
          旧排钻工作台：数字油画载入 + 本地引擎分块/布局（Block/Layer/Palette/Segment 纯前端面板）——能力对照保留。
        </p>
        <button
          type="button"
          onclick={() => (studioMode = 'engine')}
          class="border-border text-foreground hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors"
          data-testid="studio-mode-engine-enter"
        >
          进入引擎实验
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>
{/if}
