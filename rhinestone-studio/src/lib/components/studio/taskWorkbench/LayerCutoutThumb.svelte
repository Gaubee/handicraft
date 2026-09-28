<!--
LayerCutoutThumb.svelte — 图层行缩略图（rework-layer-model v4 design §2；v5 PS 面板
升级 2026-09-28：32×32 真实内容+组行子层并集合成；presentation U2 双模式——
trim=内容 contain/ps=整画布坐标放回，Codex E1）。
模式（thumbMode——view-state 观察态，store getThumbMode）：
  trim 叶/普通节点 —— 抠图层真实内容 contain 32×32（cutout.svelte 条目面：ready=
    缓存缩略位图移入挂载/loading=脉冲占位/error=警示徽标/idle=空占位；jsdom 无 2d
    canvas——idle 静默缺位）；
  trim group —— 子层并集 bbox 合成：子层 cutout 主位图按并集锚点等比缩画进 32×32；
  ps 叶/普通节点 —— 整画布 imagePx 坐标基准：节点 bbox 按全局 x/y 放回后随画布缩到
    32×32（保留 parent/child 空间关系——用主位图缩画，与主画布共用同一软化结果）；
  ps group —— 整画布合成直接子层（各子层主位图按全局 bbox 位置画入同一 32×32 格）；
  baseImageUrl 在场（面板根行=画布/背景层）—— 原图直出 <img>（两模式同形——画布
    行恒原图）。
-->

<script lang="ts">
  import { containPlacement, getCutoutEntryOf } from './cutout.svelte.js'
  import { getThumbMode } from './store.svelte'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  let {
    nodeId,
    nodeBbox = undefined,
    baseImageUrl = undefined,
    groupChildren = undefined,
    imagePx = undefined,
  }: {
    nodeId: string
    /** 节点全局 bbox（ps 叶模式放回画布坐标——Codex E1）。 */
    nodeBbox?: { x: number; y: number; w: number; h: number }
    /** 背景层缩略（面板根行）：原图 dataUrl 在场时直出原图缩略（非空=背景模式）。 */
    baseImageUrl?: string | null
    /** 组行子层（children>0 时传直接子层——trim 并集/ps 整画布合成）。 */
    groupChildren?: Array<{ id: string; bbox: { x: number; y: number; w: number; h: number } }>
    /** 整画布尺寸（ps 模式坐标基准——Codex E1）。 */
    imagePx?: { width: number; height: number }
  } = $props()

  const entry = $derived(getCutoutEntryOf(nodeId))
  const isBase = $derived(baseImageUrl !== undefined && baseImageUrl !== null)
  const isGroup = $derived(groupChildren !== undefined)
  const thumbMode = $derived(getThumbMode())
  /** 自持 canvas（缓存主缩略位图 drawImage 拷贝——缓存节点不入 DOM：双实例并存不争抢）。 */
  let canvasEl = $state<HTMLCanvasElement | null>(null)
  const thumbMaster = $derived(entry.phase === 'ready' ? entry.thumb : null)
  const cutMaster = $derived(entry.phase === 'ready' ? entry.canvas : null)

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

  /** ps 模式整画布放置（imagePx/bbox 缺席=装载前——退回 trim 形态防空白格）。 */
  const psPlacement = $derived.by(() => {
    if (thumbMode !== 'ps' || imagePx === undefined || imagePx.width <= 0 || imagePx.height <= 0) return null
    return containPlacement(32, 32, imagePx.width, imagePx.height)
  })

  $effect(() => {
    const canvas = canvasEl
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return // jsdom——结构面照常
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const ps = psPlacement
    if (ps !== null) {
      // —— ps 模式（Codex E1）：整画布 contain 32×32，内容按全局 bbox 放回随画布缩放 ——
      if (isGroup) {
        for (const { bbox, master } of groupMasters) {
          ctx.drawImage(
            master,
            ps.ox + bbox.x * ps.scale,
            ps.oy + bbox.y * ps.scale,
            bbox.w * ps.scale,
            bbox.h * ps.scale,
          )
        }
        return
      }
      if (nodeBbox === undefined || cutMaster === null) return
      ctx.drawImage(
        cutMaster,
        ps.ox + nodeBbox.x * ps.scale,
        ps.oy + nodeBbox.y * ps.scale,
        nodeBbox.w * ps.scale,
        nodeBbox.h * ps.scale,
      )
      return
    }
    if (isGroup) {
      const union = groupUnion
      if (union === null) return
      // —— trim 组：等比 contain（32×32 盒）+子层位图按并集锚点缩画 ——
      const place = containPlacement(canvas.width, canvas.height, union.w, union.h)
      for (const { bbox, master } of groupMasters) {
        ctx.drawImage(
          master,
          place.ox + (bbox.x - union.x) * place.scale,
          place.oy + (bbox.y - union.y) * place.scale,
          bbox.w * place.scale,
          bbox.h * place.scale,
        )
      }
      return
    }
    const master = thumbMaster
    if (master === null) return
    // —— trim 叶：等比 contain（32×32 盒——透明留边） ——
    const place = containPlacement(canvas.width, canvas.height, master.width, master.height)
    ctx.drawImage(master, place.ox, place.oy, master.width * place.scale, master.height * place.scale)
  })
</script>

<div
  class="border-border/60 bg-muted/40 relative size-8 shrink-0 overflow-hidden rounded-[3px]"
  data-testid="workbench-layer-thumb-{nodeId}"
  data-phase={isBase ? 'base' : isGroup ? `group:${groupMasters.length}` : entry.phase}
  data-role={isBase ? 'base-image' : isGroup ? 'group-composite' : undefined}
  data-mode={!isBase ? thumbMode : undefined}
  role="img"
  aria-label={isBase
    ? '背景层缩略（原图）'
    : isGroup
      ? `组缩略（${groupMasters.length} 子层${thumbMode === 'ps' ? '整画布放回' : '并集'}${groupUnion === null && thumbMode === 'trim' ? '——合成中' : ''}）`
      : `图层抠图缩略图（${thumbMode === 'ps' ? '整画布放回' : '内容贴合'} · ${entry.phase === 'ready' ? '已就绪' : entry.phase === 'loading' ? '合成中' : entry.phase === 'error' ? '合成失败' : '待合成'}）`}
  title={isBase
    ? '背景层（原图）缩略'
    : isGroup
      ? thumbMode === 'ps'
        ? '组缩略=整画布坐标放回（子层按全局位置合成——渐进就绪）'
        : '组缩略=子层并集（子层抠图合成——渐进就绪）'
      : entry.phase === 'error' && entry.error !== null
        ? `抠图层不可用：${entry.error}`
        : thumbMode === 'ps'
          ? '图层缩略（整画布坐标放回——保留空间关系）'
          : '图层抠图缩略（原图区域×遮罩——内容贴合）'}
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
