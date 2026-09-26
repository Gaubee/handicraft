<!--
LayerMaskThumb.svelte — 图层行蒙版缩略图（add-workbench-pro 2.2——Owner 核心质疑
「没有遮罩如何算出有效路径」的行级答案）。
24×24 alpha 蒙版小图：inline|blob 两态统一消费位面缓存（maskBits.svelte.ts）——
loading=骨架位（脉冲）/error=单层错误徽标（不炸画布——Codex 一轮风险[4]）/
ready=canvas 打点渲染（box 覆盖率下采样 alpha——非 DOM 节点堆积）。
jsdom 无 2d context——降级为占位块（测试断言 data-phase 状态面）。
-->

<script lang="ts">
  import { getMaskEntryOf } from './maskBits.svelte.js'

  let { nodeId }: { nodeId: string } = $props()

  const entry = $derived(getMaskEntryOf(nodeId))
  let canvasEl = $state<HTMLCanvasElement | null>(null)

  // 位面→24×24 alpha 打点（box 覆盖率下采样——保形状不丢小区域）
  $effect(() => {
    const canvas = canvasEl
    if (canvas === null || entry.phase !== 'ready' || entry.bits === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const { w, h, bits } = entry.bits
    const size = 24
    const image = ctx.createImageData(size, size)
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        // 覆盖率=块内 1 位占比（alpha 阶梯——稀疏条纹≈0.6 可辨）
        const x0 = Math.floor((tx * w) / size)
        const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / size))
        const y0 = Math.floor((ty * h) / size)
        const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / size))
        let on = 0
        let total = 0
        for (let y = y0; y < y1 && y < h; y++) {
          for (let x = x0; x < x1 && x < w; x++) {
            total += 1
            if (bits[y * w + x] === 1) on += 1
          }
        }
        const coverage = total === 0 ? 0 : on / total
        const p = (ty * size + tx) * 4
        image.data[p] = 124
        image.data[p + 1] = 58
        image.data[p + 2] = 237
        image.data[p + 3] = Math.round(coverage * 235)
      }
    }
    ctx.clearRect(0, 0, size, size)
    ctx.putImageData(image, 0, 0)
  })
</script>

<div
  class="border-border/60 bg-muted/40 relative size-6 shrink-0 overflow-hidden rounded-[3px]"
  data-testid="workbench-mask-thumb-{nodeId}"
  data-phase={entry.phase}
  role="img"
  aria-label="图层蒙版缩略图（{entry.phase === 'ready' ? '已就绪' : entry.phase === 'loading' ? '装载中' : entry.phase === 'error' ? '装载失败' : '待装载'}）"
  title={entry.phase === 'error' && entry.error !== null ? `蒙版装载失败：${entry.error}` : '图层蒙版缩略图'}
>
  {#if entry.phase === 'loading'}
    <div class="bg-muted absolute inset-0 animate-pulse" data-testid="workbench-mask-thumb-loading-{nodeId}"></div>
  {:else if entry.phase === 'error'}
    <div class="text-destructive flex h-full w-full items-center justify-center" data-testid="workbench-mask-thumb-error-{nodeId}">
      <svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
    </div>
  {:else}
    <canvas bind:this={canvasEl} width="24" height="24" class="block h-full w-full"></canvas>
  {/if}
</div>
