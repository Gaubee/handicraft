<!--
StoneCard.svelte——样卡网格单元（add-stone-library S3.3，design §4.2 StoneGridCell 协议）。
贴图缩略（textureUrl=/api/stones/{id}/texture.png，同源 HTTP+ETag 由浏览器缓存）+
SKU+尺寸/色名。预览底非纯白（§1.4）：中性灰底 bg-zinc-300/dark:zinc-700（S7.7 走查
修复——白贴图在白卡底低对比；对齐 warehouse 瓦片 StoneCellTile 同款灰底）。
trashed 单元降不透明度+徽标（回收站视图复用同卡）。
-->

<script lang="ts">
  import { withAuthToken } from '../../lib/stonesAdmin/authUrl'
  import { finishLabel } from '$lib/stonesAdmin/finishLabel'
  import type { StoneGridCell } from '@handicraft/contracts'

  let {
    cell,
    onopen,
    compact = false,
  }: {
    cell: StoneGridCell
    onopen: (cell: StoneGridCell) => void
    /** 回收站/侧栏等紧凑位（缩略更小、隐藏次要行）。 */
    compact?: boolean
  } = $props()

  let imageFailed = $state(false)
  // 贴图切换（软删/重建后 URL 变化）时复位失败态
  $effect(() => {
    void cell.textureUrl
    imageFailed = false
  })

  // —— 贴图真实毫米比例（Owner 2026-09-25 定稿，同 StoneCellTile 规则）——
  // 缩略不再统一大小：比例基准 REF_MAX_MM=25mm——25mm 基准钻占满缩略区可用最大边，
  // 其余尺寸按 sizeMm/25 线性缩放；sizeMm=null（未声明）按中档 6mm 渲染（文案行
  // 「尺寸未声明」另行标注）；最小渲染边 8px 下限（防更小尺寸图消失）。
  // 样卡网格单元几何 136×196（virtual.ts）→ 缩略区 ≈134×134 减 p-1.5 边距取 112；
  // 紧凑位（compact，min-height 3rem）基准边相应折半取 36。
  const TEXTURE_REF_MAX_MM = 25
  const TEXTURE_MIN_EDGE_PX = 8
  const TEXTURE_UNDECLARED_MM = 6

  function textureEdgePx(sizeMm: number | null, maxEdgePx: number): number {
    const mm = sizeMm ?? TEXTURE_UNDECLARED_MM
    const edge = Math.min((mm / TEXTURE_REF_MAX_MM) * maxEdgePx, maxEdgePx)
    return Math.max(TEXTURE_MIN_EDGE_PX, Math.round(edge))
  }
</script>

<button
  type="button"
  data-testid="stone-card-{cell.resourceId}"
  onclick={() => onopen(cell)}
  class="group border-border/70 bg-card hover:border-primary/50 focus-visible:ring-ring flex h-full w-full flex-col
    overflow-hidden rounded-xl border text-left shadow-sm transition-colors outline-none
    focus-visible:ring-2 {cell.trashed ? 'opacity-60' : ''}"
  title="{cell.name}（{cell.sku}）"
>
  <span
    class="bg-zinc-300 dark:bg-zinc-700 relative flex w-full flex-1 items-center justify-center overflow-hidden"
    style="min-height: {compact ? '3rem' : '5.5rem'}"
  >
    {#if imageFailed}
      <span class="size-10 rounded-full border border-black/10 shadow-inner" style="background: {cell.colorHex}" aria-hidden="true"></span>
      <span class="text-muted-foreground absolute bottom-1 right-1.5 text-[10px]">贴图缺失</span>
    {:else}
      {@const edgePx = textureEdgePx(cell.sizeMm, compact ? 36 : 112)}
      <img
        src={withAuthToken(cell.textureUrl)}
        alt="{cell.name} 贴图"
        loading="lazy"
        decoding="async"
        class="max-h-full max-w-full object-contain p-1.5"
        style="width: {edgePx}px; height: {edgePx}px"
        onerror={() => (imageFailed = true)}
        data-testid="stone-card-img-{cell.resourceId}"
      />
    {/if}
    {#if cell.trashed}
      <span class="bg-destructive/90 text-destructive-foreground absolute top-1 left-1 rounded px-1 py-0.5 text-[10px] font-medium">
        已软删
      </span>
    {/if}
  </span>
  <span class="flex flex-col gap-0.5 px-2 py-1.5">
    <span class="flex items-center gap-1.5">
      <span class="size-2.5 shrink-0 rounded-full border border-black/10" style="background: {cell.colorHex}" aria-hidden="true"></span>
      <span class="text-foreground font-mono text-xs font-semibold tracking-tight">{cell.sku}</span>
      <span class="text-muted-foreground ml-auto text-[11px]">{cell.sizeMm !== null ? `${cell.sizeMm}mm` : '尺寸未声明'}</span>
    </span>
    {#if !compact}
      <span class="text-foreground/80 truncate text-xs">{cell.name}</span>
      {@const finish = finishLabel(cell.finish)}
      <span class="text-muted-foreground truncate text-[11px]">{cell.family}{finish !== null ? ` · ${finish}` : ''}</span>
    {/if}
  </span>
</button>
