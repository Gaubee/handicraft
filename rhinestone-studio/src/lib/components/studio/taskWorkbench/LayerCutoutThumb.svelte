<!--
LayerCutoutThumb.svelte — 图层行缩略图（rework-layer-model v4 design §2；v5 PS 面板
升级 2026-09-28：32×32 真实内容+组行子层并集合成）。
两形态：
  leaf/普通节点 —— 抠图层真实内容（原图区域×mask 的缩采样；cutout.svelte 条目面：
    ready=缩略 canvas 移入挂载（缓存持有元素）/loading=脉冲占位/error=警示徽标/
    idle=空占位；jsdom 无 2d canvas——idle 静默缺位（data-phase 状态面可断言））；
  group（groupChildren 在场）—— 子层并集 bbox 合成：子层 cutout 主位图按并集
    锚点等比缩画进 32×32（v5 PS 面板「组缩略=子层并集缩略」）；子层未就绪的照缺
    （渐进可用——就绪后 $derived 重渲）；
  baseImageUrl 在场（面板根行=画布/背景层）—— 原图直出 <img>（与主画布背景同源）。
-->

<script lang="ts">
  import { getCutoutEntryOf } from './cutout.svelte.js'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  let {
    nodeId,
    baseImageUrl = undefined,
    groupChildren = undefined,
  }: {
    nodeId: string
    /** 背景层缩略（面板根行）：原图 dataUrl 在场时直出原图缩略（非空=背景模式）。 */
    baseImageUrl?: string | null
    /** 组行子层（v5：children>0 时传直接子层——并集 bbox 合成组缩略）。 */
    groupChildren?: Array<{ id: string; bbox: { x: number; y: number; w: number; h: number } }>
  } = $props()

  const entry = $derived(getCutoutEntryOf(nodeId))
  const isBase = $derived(baseImageUrl !== undefined && baseImageUrl !== null)
  const isGroup = $derived(groupChildren !== undefined)
  /** 自持 canvas（缓存主缩略位图 drawImage 拷贝——缓存节点不入 DOM：双实例并存不争抢）。 */
  let canvasEl = $state<HTMLCanvasElement | null>(null)
  const thumbMaster = $derived(entry.phase === 'ready' ? entry.thumb : null)

  /** 组行子层就绪位图集（渐进——未就绪子层缺席，就绪后自动重渲）。 */
  const groupMasters = $derived.by(() => {
    if (groupChildren === undefined) return []
    const out: Array<{ bbox: { x: number; y: number; w: number; h: number }; master: HTMLCanvasElement }> = []
    for (const child of groupChildren) {
      const childEntry = getCutoutEntryOf(child.id)
      if (childEntry.phase === 'ready' && childEntry.canvas !== null) {
        out.push({ bbox: child.bbox, master: childEntry.canvas })
      }
    }
    return out
  })

  /** 组行子层并集 bbox（无就绪子层=空集——占位呈现）。 */
  const groupUnion = $derived.by(() => {
    if (groupMasters.length === 0) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const { bbox } of groupMasters) {
      x0 = Math.min(x0, bbox.x)
      y0 = Math.min(y0, bbox.y)
      x1 = Math.max(x1, bbox.x + bbox.w)
      y1 = Math.max(y1, bbox.y + bbox.h)
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  })

  $effect(() => {
    const canvas = canvasEl
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return // jsdom——结构面照常
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (isGroup) {
      const union = groupUnion
      if (union === null) return
      // 等比 contain（32×32 盒）+子层位图按并集锚点缩画
      const scale = Math.min(canvas.width / union.w, canvas.height / union.h)
      const w = union.w * scale
      const h = union.h * scale
      const ox = (canvas.width - w) / 2
      const oy = (canvas.height - h) / 2
      for (const { bbox, master } of groupMasters) {
        ctx.drawImage(
          master,
          ox + (bbox.x - union.x) * scale,
          oy + (bbox.y - union.y) * scale,
          bbox.w * scale,
          bbox.h * scale,
        )
      }
      return
    }
    const master = thumbMaster
    if (master === null) return
    // 等比 contain（32×32 盒——透明留边）
    const scale = Math.min(canvas.width / master.width, canvas.height / master.height)
    const w = master.width * scale
    const h = master.height * scale
    ctx.drawImage(master, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
  })
</script>

<div
  class="border-border/60 bg-muted/40 relative size-8 shrink-0 overflow-hidden rounded-[3px]"
  data-testid="workbench-layer-thumb-{nodeId}"
  data-phase={isBase ? 'base' : isGroup ? `group:${groupMasters.length}` : entry.phase}
  data-role={isBase ? 'base-image' : isGroup ? 'group-composite' : undefined}
  role="img"
  aria-label={isBase
    ? '背景层缩略（原图）'
    : isGroup
      ? `组缩略（${groupMasters.length} 子层并集${groupUnion === null ? '——合成中' : ''}）`
      : `图层抠图缩略图（${entry.phase === 'ready' ? '已就绪' : entry.phase === 'loading' ? '合成中' : entry.phase === 'error' ? '合成失败' : '待合成'}）`}
  title={isBase
    ? '背景层（原图）缩略'
    : isGroup
      ? '组缩略=子层并集（子层抠图合成——渐进就绪）'
      : entry.phase === 'error' && entry.error !== null
        ? `抠图层不可用：${entry.error}`
        : '图层抠图缩略（原图区域×遮罩）'}
>
  {#if isBase}
    <img src={baseImageUrl ?? ''} alt="" draggable="false" class="pointer-events-none block h-full w-full select-none object-contain" />
  {:else if !isGroup && entry.phase === 'loading'}
    <div class="bg-muted absolute inset-0 animate-pulse" data-testid="workbench-layer-thumb-loading-{nodeId}"></div>
  {:else if !isGroup && entry.phase === 'error'}
    <div class="text-destructive flex h-full w-full items-center justify-center" data-testid="workbench-layer-thumb-error-{nodeId}">
      <TriangleAlert class="size-4" aria-hidden="true" />
    </div>
  {:else}
    <canvas bind:this={canvasEl} width="32" height="32" class="block h-full w-full"></canvas>
  {/if}
</div>
