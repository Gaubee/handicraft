<!--
Orthogonal intents (max 3):
1. [2026-09-19 Layout 2.1] 检查器（桌面右列 320px，自 BlockPanel 拆装）：选中块详情置顶常驻（上版「点了没反应」
     裁决不回退）+ 折叠组：物理参数 / 色板 / 分块参数 / 块列表（PM §3.4：块列表降级为键盘/精确定位辅助）。
     无选中 = 详情占位缩小，折叠组自然顶置（全局态）。
2. [2026-09-19 折叠摘要] Accordion trigger 携带当前值摘要（SS/gap/k/色数/块数），收起也能核对状态；
     [2026-09-19 Busy] 摘要 = 非按钮 label 承载：分块中「分块中…」/布局轮「计算中… n/6」（LabelProgress，title 携完整进度）。
3. [2026-09-19 复用] 分组本体是独立组件（BlockDetail/BlockList/PhysicsPanel/PalettePanel/SegmentPanel），
     移动端底部抽屉复用同一批组件（现行为硬承诺），本组件只换容器。
-->

<script lang="ts">
  import * as Accordion from '$lib/components/ui/accordion'
  import {
    getBlocks,
    getComputeProgress,
    getComputing,
    getDisabledIds,
    getGapMm,
    getPalette,
    getSegK,
    getSegmenting,
    getSs,
  } from '$lib/stores/studio.svelte'
  import BlockDetail from './BlockDetail.svelte'
  import BlockList from './BlockList.svelte'
  import PhysicsPanel from './PhysicsPanel.svelte'
  import PalettePanel from './PalettePanel.svelte'
  import SegmentPanel from './SegmentPanel.svelte'
  import LabelProgress from './LabelProgress.svelte'

  const blocks = $derived(getBlocks())
  const palette = $derived(getPalette())
  const segmenting = $derived(getSegmenting())
  const computing = $derived(getComputing())
  const progress = $derived(getComputeProgress())

  const blockSummary = $derived(
    blocks.length === 0
      ? '待载入'
      : `${blocks.length} 块 · ${Object.keys(getDisabledIds()).length} 禁用`,
  )
  const physicsSummary = $derived(`${getSs()} · gap ${getGapMm().toFixed(2)}mm`)
  const paletteSummary = $derived(`${palette.length} 色`)
  const segmentSummary = $derived(`k ${getSegK()}`)
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-testid="inspector">
  <!-- 选中块详情：置顶常驻（选中即在视口内，零滚动） -->
  <BlockDetail />

  <Accordion.Root type="single" class="rounded-xl border bg-card px-3">
    <Accordion.Item value="physics">
      <Accordion.Trigger class="py-2.5 text-xs">
        <span class="flex items-center gap-2">
          <span class="font-medium">物理参数</span>
          <LabelProgress
            text={physicsSummary}
            busy={computing}
            progress={progress}
            class="font-mono text-[11px]"
          />
        </span>
      </Accordion.Trigger>
      <Accordion.Content class="pb-3">
        <PhysicsPanel />
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
          <LabelProgress
            text={segmentSummary}
            busy={segmenting}
            busyText="分块中…"
            class="font-mono text-[11px]"
          />
        </span>
      </Accordion.Trigger>
      <Accordion.Content class="pb-3">
        <SegmentPanel />
      </Accordion.Content>
    </Accordion.Item>

    <Accordion.Item value="blocks">
      <Accordion.Trigger class="py-2.5 text-xs">
        <span class="flex items-center gap-2">
          <span class="font-medium">块列表</span>
          <LabelProgress
            text={blockSummary}
            busy={segmenting}
            busyText="分块中…"
            class="font-mono text-[11px]"
          />
        </span>
      </Accordion.Trigger>
      <Accordion.Content class="pb-3">
        <BlockList />
      </Accordion.Content>
    </Accordion.Item>
  </Accordion.Root>
</div>
