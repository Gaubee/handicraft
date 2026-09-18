<!--
Orthogonal intents (max 2):
1. [2026-09-19 State] 缩略图三分态渲染：未解析=skeleton / null=blob 缺失「已失效」徽标占位 / url=objectUrl 图。
2. [2026-09-19 Reuse] 库网格、列表、选图器、预览共用（url 只经 library 投影，不直拼 blob key）。
-->
<script lang="ts">
  import type { AssetImage } from '$lib/persistence/assetStore'
  import { getUrl } from '$lib/assets/library.svelte'
  import ImageOff from '@lucide/svelte/icons/image-off'

  let {
    asset,
    objectFit = 'object-contain',
  }: {
    asset: AssetImage
    objectFit?: 'object-contain' | 'object-cover'
  } = $props()

  // 回收站内条目不解析 URL（objectUrlForAsset 对软删返回 null），显示「回收站中」占位。
  const url = $derived(asset.trashedAt !== undefined ? null : getUrl(asset.id))
</script>

{#if url === null}
  {#if asset.trashedAt !== undefined}
    <!-- 回收站条目：不解析 URL（软删节点 objectUrl 出口返回 null） -->
    <div
      class="bg-muted/60 text-muted-foreground flex size-full flex-col items-center justify-center gap-1 opacity-70"
      data-testid="asset-trashed-placeholder"
      title="位于回收站"
    >
      <ImageOff class="size-5 opacity-60" aria-hidden="true" />
      <span class="text-[10px] font-medium">回收站中</span>
    </div>
  {:else}
    <!-- 七态④ blob 缺失：占位「已失效」徽标，不可选入模块 -->
    <div
      class="bg-muted/60 text-muted-foreground flex size-full flex-col items-center justify-center gap-1"
      data-testid="asset-missing"
      title="图片数据缺失（可能被浏览器清理）"
    >
      <ImageOff class="size-5 opacity-60" aria-hidden="true" />
      <span class="text-[10px] font-medium">已失效</span>
    </div>
  {/if}
{:else if url === undefined}
  <div class="bg-muted animate-pulse size-full" data-testid="asset-thumb-loading"></div>
{:else}
  <img src={url} alt={asset.name} class="size-full {objectFit}" draggable="false" loading="lazy" />
{/if}
