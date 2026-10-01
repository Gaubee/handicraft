<!--
StoneCard.svelte——样卡网格单元（add-stone-library S3.3，design §4.2 StoneGridCell 协议）。
贴图缩略（textureUrl=/api/stones/{id}/texture.png，同源 HTTP+ETag 由浏览器缓存）+
SKU+尺寸/色名。预览底非纯白（§1.4）：bg-muted 主题纸灰（w17-critic T2：原 zinc
冷灰蓝与暖纸底打架——token 化随主题）。预览 80% contains（restructure-materials-story
W1，Owner 2026-09-30 预览修复——取代 2026-09-25 毫米比例缩略）：贴图渲染尺寸放大至
缩略区容器的 80% 宽/高，object-contain 保比例不裁切。trashed 单元降不透明度+徽标
（回收站视图复用同卡）。
[w17-critic T2] 死信息行收敛：尺寸未声明不占行（有尺寸才显）；供应商/质感并入
hover title+底部单行弱化（text-[10px] muted）。缺图占位降调（小圆点+「缺图」小字
——无满幅水印），加载结果回报 stonesAdmin store（缺图默认隐藏/计数的数据底座）。
-->

<script lang="ts">
  import { withAuthToken } from '../../lib/stonesAdmin/authUrl'
  import { finishLabel } from '$lib/stonesAdmin/finishLabel'
  import { noteStoneTextureResult } from '$lib/stonesAdmin/store.svelte'
  import type { StoneGridCell } from '@handicraft/contracts'

  let {
    cell,
    onopen,
    compact = false,
  }: {
    cell: StoneGridCell
    onopen: (cell: StoneGridCell) => void
    /** 回收站/侧栏等紧凑位（更小 min-height、隐藏次要行——贴图随容器 80% 自适应）。 */
    compact?: boolean
  } = $props()

  let imageFailed = $state(false)
  // 贴图切换（软删/重建后 URL 变化）时复位失败态
  $effect(() => {
    void cell.textureUrl
    imageFailed = false
  })

  const finish = $derived(finishLabel(cell.finish))
  const titleText = $derived(
    `${cell.name}（${cell.sku}）${imageFailed ? ' · 贴图缺失' : ''} · ${cell.supplier}${finish !== null ? ` · ${finish}` : ''}${cell.sizeMm !== null ? ` · ${cell.sizeMm}mm` : ''}`,
  )
</script>

<button
  type="button"
  data-testid="stone-card-{cell.resourceId}"
  onclick={() => onopen(cell)}
  class="group border-border/70 bg-card hover:border-primary/50 focus-visible:ring-ring flex h-full w-full flex-col
    overflow-hidden rounded-xl border text-left shadow-sm transition-colors outline-none
    focus-visible:ring-2 {cell.trashed ? 'opacity-60' : ''}"
  title={titleText}
>
  <span
    class="bg-muted relative flex w-full flex-1 items-center justify-center overflow-hidden"
    style="min-height: {compact ? '3rem' : '5.5rem'}"
  >
    {#if imageFailed}
      <!-- 缺图占位降调：小色点+「缺图」小字（水印退场——是否缺图归网格过滤面治理）。 -->
      <span class="flex flex-col items-center gap-1" aria-hidden="true">
        <span class="size-8 rounded-full border border-dashed border-black/15" style="background: {cell.colorHex}"></span>
        <span class="text-muted-foreground/70 text-[10px]">缺图</span>
      </span>
    {:else}
      <!-- 80% contains：img 盒占缩略区 80% 宽/高（flex 居中），object-contain 在盒内
           保比例——小源图放大充满、大图收缩不裁切。加载结果回报 store（缺图计数）。 -->
      <img
        src={withAuthToken(cell.textureUrl)}
        alt="{cell.name} 贴图"
        loading="lazy"
        decoding="async"
        class="h-[80%] w-[80%] object-contain"
        onerror={() => {
          imageFailed = true
          noteStoneTextureResult(cell.resourceId, true)
        }}
        onload={() => noteStoneTextureResult(cell.resourceId, false)}
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
      {#if cell.sizeMm !== null}
        <span class="text-muted-foreground ml-auto text-[11px]">{cell.sizeMm}mm</span>
      {/if}
    </span>
    {#if !compact}
      <span class="text-foreground/80 truncate text-xs">{cell.name}</span>
      {#if finish !== null || cell.family !== ''}
        <span class="text-muted-foreground/80 truncate text-[10px]">{cell.family}{finish !== null ? ` · ${finish}` : ''}</span>
      {/if}
    {/if}
  </span>
</button>
