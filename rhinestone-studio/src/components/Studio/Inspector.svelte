<!--
Orthogonal intents (max 3):
1. [2026-09-20 studio-layers 2.7] 检查器改版：层配置卡置顶常驻（LayerConfigCard——策略/物理唯一写入点）
     + 选中块详情沿用 + 「移入图层 ▸」（BlockDetail 内）+ 折叠组（块列表[只列选中层块]/色板/分块参数
     [破坏性警示升级]）。背景层选中时配置卡替换为背景面板（LayerConfigCard 内分流）。
2. [折叠摘要] Accordion trigger 携带当前值摘要（k/色数/块数/选中层块数），收起也能核对状态。
3. [复用] 分组本体是独立组件（BlockDetail/BlockList/PalettePanel/SegmentPanel），移动端底部抽屉
     复用同一批组件（现行为硬承诺），本组件只换容器；PhysicsPanel 随胶片带/全局物理废除退役。
-->

<script lang="ts">
  import * as Accordion from '$lib/components/ui/accordion'
  import {
    getAnchorLayer,
    getBlocks,
    getLayerMemberCount,
    getPalette,
    getSegK,
    isBackgroundSelected,
  } from '$lib/stores/studio.svelte'
  import BlockDetail from './BlockDetail.svelte'
  import BlockList from './BlockList.svelte'
  import PalettePanel from './PalettePanel.svelte'
  import SegmentPanel from './SegmentPanel.svelte'
  import LayerConfigCard from './LayerConfigCard.svelte'
  import LabelProgress from './LabelProgress.svelte'

  const blocks = $derived(getBlocks())
  const palette = $derived(getPalette())
  const anchor = $derived(getAnchorLayer())
  const backgroundSelected = $derived(isBackgroundSelected())

  const blockSummary = $derived(
    blocks.length === 0
      ? '待载入'
      : `选中层 ${getLayerMemberCount(anchor?.id ?? '')} 块 / 全部 ${blocks.length} 块`,
  )
  const paletteSummary = $derived(`${palette.length} 色`)
  const segmentSummary = $derived(`k ${getSegK()}`)
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-testid="inspector">
  <!-- 层配置卡置顶常驻（背景层选中 → 背景面板） -->
  <LayerConfigCard />

  <!-- 选中块详情：置顶常驻（选中即在视口内，零滚动） -->
  {#if !backgroundSelected}
    <BlockDetail />
  {/if}

  {#if !backgroundSelected}
    <Accordion.Root type="single" class="rounded-xl border bg-card px-3">
      <Accordion.Item value="blocks">
        <Accordion.Trigger class="py-2.5 text-xs">
          <span class="flex items-center gap-2">
            <span class="font-medium">块列表</span>
            <span class="text-muted-foreground font-mono text-[11px]">{blockSummary}</span>
          </span>
        </Accordion.Trigger>
        <Accordion.Content class="pb-3">
          <!-- 只列选中层的块（图层稿 §B.3-6——层内精确定位；全块列表由画布/统计覆盖） -->
          <BlockList onlyAnchorLayer />
        </Accordion.Content>
      </Accordion.Item>

      <Accordion.Item value="palette">
        <Accordion.Trigger class="py-2.5 text-xs">
          <span class="flex items-center gap-2">
            <span class="font-medium">色板</span>
            <span class="flex items-center gap-0.5">
              {#each palette.slice(0, 6) as entry (entry.id)}
                <span
                  class="size-2.5 rounded-full ring-1 ring-inset ring-black/10"
                  style="background: {entry.hex}"
                  title={entry.name}
                ></span>
              {/each}
            </span>
            <span class="text-muted-foreground font-mono text-[11px] tabular-nums">{paletteSummary}</span>
          </span>
        </Accordion.Trigger>
        <Accordion.Content class="pb-3">
          <PalettePanel />
        </Accordion.Content>
      </Accordion.Item>

      <Accordion.Item value="segment">
        <Accordion.Trigger class="py-2.5 text-xs">
          <span class="flex items-center gap-2">
            <span class="font-medium">分块参数</span>
            <LabelProgress text={segmentSummary} class="font-mono text-[11px]" />
          </span>
        </Accordion.Trigger>
        <Accordion.Content class="pb-3">
          <!-- 破坏性警示升级（图层稿 §A.2：重分块将重置图层分配与块覆写） -->
          <p class="text-destructive mb-2 text-[11px] leading-relaxed" data-testid="segment-destructive-warning">
            重分块将重置图层分配与块覆写：新块全部落入兜底层、显式层清空保留配置、悬空覆写移除并计数提示。可撤销（撤销 = 引擎按旧参数确定性重生成旧块）。
          </p>
          <SegmentPanel />
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  {/if}
</div>
