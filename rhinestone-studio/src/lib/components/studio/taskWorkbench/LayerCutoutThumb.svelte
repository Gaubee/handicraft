<!--
LayerCutoutThumb.svelte — 图层行抠图缩略图（rework-layer-model v4 design §2——
替换 v3 蒙版色块缩略：图层行缩略=抠图层真实内容（原图区域×mask 的缩采样）。
消费 cutout.svelte 条目面：ready=缩略 canvas 移入挂载（缓存持有元素）/loading=
脉冲占位/error=警示徽标（该层不渲染——图层行警示语义）/idle=空占位。
jsdom 无 2d canvas——idle 静默缺位（data-phase 状态面可断言）。
-->

<script lang="ts">
  import { getCutoutEntryOf } from './cutout.svelte.js'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  let { nodeId }: { nodeId: string } = $props()

  const entry = $derived(getCutoutEntryOf(nodeId))
  /** 自持 canvas（缓存主缩略位图 drawImage 拷贝——缓存节点不入 DOM：双实例并存不争抢）。 */
  let canvasEl = $state<HTMLCanvasElement | null>(null)
  const thumbMaster = $derived(entry.phase === 'ready' ? entry.thumb : null)

  $effect(() => {
    const canvas = canvasEl
    const master = thumbMaster
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return // jsdom——结构面照常
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (master === null) return
    // 等比 contain（24×24 盒——透明留边）
    const scale = Math.min(canvas.width / master.width, canvas.height / master.height)
    const w = master.width * scale
    const h = master.height * scale
    ctx.drawImage(master, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
  })
</script>

<div
  class="border-border/60 bg-muted/40 relative size-6 shrink-0 overflow-hidden rounded-[3px]"
  data-testid="workbench-layer-thumb-{nodeId}"
  data-phase={entry.phase}
  role="img"
  aria-label="图层抠图缩略图（{entry.phase === 'ready' ? '已就绪' : entry.phase === 'loading' ? '合成中' : entry.phase === 'error' ? '合成失败' : '待合成'}）"
  title={entry.phase === 'error' && entry.error !== null ? `抠图层不可用：${entry.error}` : '图层抠图缩略（原图区域×遮罩）'}
>
  {#if entry.phase === 'loading'}
    <div class="bg-muted absolute inset-0 animate-pulse" data-testid="workbench-layer-thumb-loading-{nodeId}"></div>
  {:else if entry.phase === 'error'}
    <div class="text-destructive flex h-full w-full items-center justify-center" data-testid="workbench-layer-thumb-error-{nodeId}">
      <TriangleAlert class="size-3.5" aria-hidden="true" />
    </div>
  {:else}
    <canvas bind:this={canvasEl} width="24" height="24" class="block h-full w-full"></canvas>
  {/if}
</div>
