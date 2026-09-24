<!--
StoneCard.svelte——样卡网格单元（add-stone-library S3.3，design §4.2 StoneGridCell 协议）。
贴图缩略（textureUrl=/api/stones/{id}/texture.png，同源 HTTP+ETag 由浏览器缓存）+
SKU+尺寸/色名。预览底非纯白（§1.4）：currentColor 减色底——透明 PNG 主体在
明暗主题下都可见。trashed 单元降不透明度+徽标（回收站视图复用同卡）。
-->

<script lang="ts">
  import { withAuthToken } from '../../lib/stonesAdmin/authUrl'
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
    class="relative flex w-full flex-1 items-center justify-center overflow-hidden"
    style="min-height: {compact ? '3rem' : '5.5rem'}; background: color-mix(in srgb, currentColor 6%, transparent)"
  >
    {#if imageFailed}
      <span class="size-10 rounded-full border border-black/10 shadow-inner" style="background: {cell.colorHex}" aria-hidden="true"></span>
      <span class="text-muted-foreground absolute bottom-1 right-1.5 text-[10px]">贴图缺失</span>
    {:else}
      <img
        src={withAuthToken(cell.textureUrl)}
        alt="{cell.name} 贴图"
        loading="lazy"
        decoding="async"
        class="max-h-full max-w-full object-contain p-1.5"
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
      <span class="text-muted-foreground truncate text-[11px]">{cell.family}{cell.finish !== '' ? ` · ${cell.finish}` : ''}</span>
    {/if}
  </span>
</button>
