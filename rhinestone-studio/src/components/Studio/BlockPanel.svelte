<!--
Orthogonal intents (max 3):
1. [2026-09-18 R3 PM-B3] 精调列（桌面左 340px）块中心重排：选中块详情置顶常驻 → 块列表 →
     物理参数/色板/分块参数三折叠组（改一次管全局的收起来，改一次管一块的放在手边）。
2. [2026-09-18 折叠摘要] Accordion trigger 携带当前值摘要（SS/gap/k/色数），收起也能核对状态。
3. [2026-09-18 复用] 各分组本体是独立组件（BlockList/PhysicsPanel/PalettePanel/SegmentPanel），
     移动端底部抽屉复用同一批组件，避免双份实现。
-->

<script lang="ts">
  import * as Accordion from '$lib/components/ui/accordion'
  import {
    getBlocks,
    getDisabledIds,
    getGapMm,
    getPalette,
    getSegK,
    getSs,
  } from '$lib/stores/studio.svelte'
  import BlockDetail from './BlockDetail.svelte'
  import BlockList from './BlockList.svelte'
  import PhysicsPanel from './PhysicsPanel.svelte'
  import PalettePanel from './PalettePanel.svelte'
  import SegmentPanel from './SegmentPanel.svelte'

  const blocks = $derived(getBlocks())

  const palette = $derived(getPalette())

  const blockSummary = $derived(
    blocks.length === 0
      ? '待载入'
      : `${blocks.length} 块 · ${Object.keys(getDisabledIds()).length} 禁用`,
  )
  const physicsSummary = $derived(`${getSs()} · gap ${getGapMm().toFixed(2)}mm`)
  const paletteSummary = $derived(`${palette.length} 色`)
  const segmentSummary = $derived(`k ${getSegK()}`)
</script>

<div class="grid gap-4 content-start" data-testid="block-panel">
  <!-- 选中块详情：置顶常驻（选中即在视口内） -->
  <BlockDetail />

  <section class="grid gap-2">
    <div class="flex items-center gap-2">
      <h3 class="text-sm font-semibold tracking-tight">块</h3>
      <span class="text-muted-foreground font-mono text-xs tabular-nums">{blockSummary}</span>
    </div>
    <BlockList />
  </section>

  <Accordion.Root type="single" class="rounded-xl border bg-card px-3">
    <Accordion.Item value="physics">
      <Accordion.Trigger class="py-2.5 text-xs">
        <span class="flex items-center gap-2">
          <span class="font-medium">物理参数</span>
          <span class="text-muted-foreground font-mono text-[11px] tabular-nums">{physicsSummary}</span>
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
              <span class="size-2.5 rounded-full ring-1 ring-inset ring-black/10" style="background: {entry.hex}" title={entry.name}></span>
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
          <span class="text-muted-foreground font-mono text-[11px] tabular-nums">{segmentSummary}</span>
        </span>
      </Accordion.Trigger>
      <Accordion.Content class="pb-3">
        <SegmentPanel />
      </Accordion.Content>
    </Accordion.Item>
  </Accordion.Root>
</div>
