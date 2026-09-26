<!--
StrategyDesignerView.svelte — 策略设计器视图（add-subject-sam-pipeline P3.2——
owner 内核：「左边是对话框，右边是实时的画布。里面能看到所有的图层，以及每个图层
采用的贴钻策略，还有这些策略对应的参数」）。
布局：顶部旅程串联位 → 左=Agent 会话流（SessionStream 复用——工具调用卡升级见
FrameView 分派）｜右=实时画布（三层叠加）+ 图层树/参数表单侧栏。
两层编辑铁律：本面=策略层图层级（禁单钻微调——单钻归设计师工作台）。
数据：帧流（agentApi store）派生工件引用/旅程；结构化工件内容经 provider
（缺省 mock——真实通道接线见 strategyDesigner/artifacts.ts 头注）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import SessionStream from '$lib/components/agent/SessionStream.svelte'
  import StrategyCanvas from './StrategyCanvas.svelte'
  import StrategyJourneyRail from './StrategyJourneyRail.svelte'
  import StrategyLayerTree from './StrategyLayerTree.svelte'
  import StrategyParamsForm from './StrategyParamsForm.svelte'
  import { initAgentStore, openSession, getAgentSessions, getActiveSessionId } from '$lib/agentApi/store.svelte'
  import {
    getBaseImageOpacity,
    getBaseImageVisible,
    getRenderBoxes,
    getRenderGems,
    getShowBoxes,
    getStrategyArtifacts,
    getStrategyLoadError,
    getStrategyPpm,
    getStrategyRefs,
    isStrategyLoading,
    setBaseImageOpacity,
    setBaseImageVisible,
    setShowBoxes,
    syncStrategyArtifacts,
  } from '$lib/strategyDesigner/store.svelte'
  import type { StrategyCanvasModel } from './canvasModel.js'

  onMount(() => {
    // 会话面幂等初始化（AgentView 先行初始化过则直通）；策略视图消费活跃会话帧。
    void initAgentStore()
  })

  // 工件续装：refs 为帧流响应式投影——新工件帧落地（含 live）自动按新引用集装载。
  $effect(() => {
    getStrategyRefs()
    syncStrategyArtifacts()
  })

  // [2.5 受控化接线] store 投影 → 画布模型（原 StrategyCanvas 直读 store 改为此处喂数）。
  const canvasModel = $derived.by<StrategyCanvasModel | null>(() => {
    const bundle = getStrategyArtifacts()
    if (bundle === null) return null
    return {
      imagePx: bundle.tree.imagePx,
      gems: getRenderGems(),
      boxes: getRenderBoxes().map(({ node, excluded }) => ({
        nodeId: node.id,
        objectName: node.objectName,
        bbox: node.bbox,
        excluded,
      })),
      ppm: getStrategyPpm(),
      sourceUrl: bundle.sourceImageUrl,
      excludedCount: bundle.gems.excludedRegions.length,
    }
  })

  const sessions = $derived(getAgentSessions())
  const activeId = $derived(getActiveSessionId())
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="strategy-view">
  <StrategyJourneyRail />

  <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <!-- 左：Agent 会话流（策略层人机面——提案/批准/指令注入都在这里） -->
    <section
      class="bg-background min-h-0 w-full shrink-0 border-b lg:w-[26rem] lg:border-r lg:border-b-0 max-lg:max-h-[45%]"
      aria-label="Agent 对话（策略层）"
    >
      {#if sessions.length > 1 && activeId !== null}
        <div class="bg-background/80 flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs backdrop-blur">
          <span class="text-muted-foreground">会话</span>
          <select
            class="border-input bg-background min-w-0 flex-1 truncate rounded-md border px-2 py-1 text-xs"
            value={activeId}
            onchange={(event) => void openSession(event.currentTarget.value)}
            data-testid="strategy-session-select"
            aria-label="切换任务会话"
          >
            {#each sessions as session (session.id)}
              <option value={session.id}>{session.title}</option>
            {/each}
          </select>
        </div>
      {/if}
      <div class="min-h-0 {sessions.length > 1 && activeId !== null ? 'flex-1' : 'h-full'}">
        <SessionStream />
      </div>
    </section>

    <!-- 右：实时画布 + 图层树/参数侧栏 -->
    <div class="flex min-h-0 min-w-0 flex-1">
      <div class="min-h-0 min-w-0 flex-1">
        <StrategyCanvas
          model={canvasModel}
          loading={isStrategyLoading()}
          loadError={getStrategyLoadError()}
          baseVisible={getBaseImageVisible()}
          onSetBaseVisible={setBaseImageVisible}
          baseOpacity={getBaseImageOpacity()}
          onSetBaseOpacity={setBaseImageOpacity}
          showBoxes={getShowBoxes()}
          onSetShowBoxes={setShowBoxes}
        />
      </div>
      <aside class="bg-background hidden w-80 shrink-0 flex-col border-l lg:flex" aria-label="图层与参数面板">
        <div class="min-h-0 max-h-[52%] shrink-0 border-b">
          <StrategyLayerTree />
        </div>
        <div class="min-h-0 flex-1">
          <StrategyParamsForm />
        </div>
      </aside>
    </div>
  </div>
</div>
