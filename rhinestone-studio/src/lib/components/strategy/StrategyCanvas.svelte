<!--
StrategyCanvas.svelte — 策略层实时画布（add-subject-sam-pipeline P3.2；
add-task-detail-layer-workbench 2.5 受控化——喂数方式=策略设计器 store 同式投影）。
三层叠加（下→上）：原图（开关+透明度——sourceUrl 缺席时降级态）→
object-tree 预览框线（bbox+排除语义色）→ strategy gems 点阵（SVG：颜色=指派
StonePick colorHex、尺寸=diameterMm×ppm）。逐节点显隐由喂数方过滤（投影内完成）。
[2.5] 受控组件化：数据/开关态全部经 props（原策略设计器 store 直读改为
StrategyDesignerView 接线——标记与结构零变化）；新增可选蒙版叠加位（masks）
与选中层描边加粗位（selectedNodeId）——不传即不渲染，策略设计器行为不变。
[add-workbench-pro 2c 鼠标 P0] 可选 view（CanvasView——lib/canvaskit 真源；非空=
视口取景模式：动态 viewBox，滚轮锚定缩放/平移由喂数方驱动；null=既有 contain
适配——策略设计器零变化）+可选 hoverNodeId（命中层框线悬停高亮）+可选 children
snippet（叠加层注入位——笔刷层/指针捕获层与画布同盒对齐，坐标真源=画布 px）。
[add-workbench-pro v3 Owner 整改] 可选 gemMode 点阵渲染变体（renderGemsLayer——
三模式共用 model.gems 命中/坐标单源）：plain=既有平面圆点（缺省——策略设计器
零变化）；rendered=钻渲染到孔（径向渐变金属光泽+高光点）；holes=只有孔洞
（底图淡化+冲孔视觉：深色孔+浅色内缘）；numbered=孔洞+按图层分色分组编号
（组色板+组徽标+图例；稀疏点阵≤300 颗时逐孔标号）。
-->

<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { CanvasView } from '$lib/canvaskit.js'
  import type { StrategyCanvasModel } from './canvasModel.js'

  /** 点阵渲染变体（v3——plain=缺省既有行为）。 */
  export type StrategyGemMode = 'plain' | 'rendered' | 'holes' | 'numbered'

  let {
    model = null,
    loading = false,
    loadError = null,
    emptyHint = '在左侧对话发起旅程：上传图 + cm 尺寸 → 识图抠图 → strategy.design',
    baseVisible = true,
    onSetBaseVisible = undefined,
    baseOpacity = 0.6,
    onSetBaseOpacity = undefined,
    showBoxes = true,
    onSetShowBoxes = undefined,
    masks = [],
    showMasks = false,
    onSetShowMasks = undefined,
    selectedNodeId = null,
    view = null,
    hoverNodeId = null,
    gemMode = 'plain',
    children = undefined,
  }: {
    model?: StrategyCanvasModel | null
    loading?: boolean
    loadError?: string | null
    emptyHint?: string
    baseVisible?: boolean
    onSetBaseVisible?: (visible: boolean) => void
    baseOpacity?: number
    onSetBaseOpacity?: (opacity: number) => void
    showBoxes?: boolean
    onSetShowBoxes?: (visible: boolean) => void
    masks?: StrategyCanvasModel['masks']
    showMasks?: boolean
    onSetShowMasks?: ((visible: boolean) => void) | null
    selectedNodeId?: string | null
    /** 视口取景（非空=视口模式——动态 viewBox；null=contain 适配[既有行为]）。 */
    view?: CanvasView | null
    /** 悬停层（命中高亮——框线琥珀描边；null=无悬停）。 */
    hoverNodeId?: string | null
    /** 点阵渲染变体（v3——plain=既有平面圆点；三模式见组件头注）。 */
    gemMode?: StrategyGemMode
    /** 叠加层注入位（与画布同盒对齐——绝对定位 inset-0 即画布 viewport 盒）。 */
    children?: Snippet | undefined
  } = $props()

  const imagePx = $derived(model?.imagePx ?? null)
  const sourceUrl = $derived(model?.sourceUrl ?? null)
  const maskOverlays = $derived(showMasks ? (model?.masks ?? []) : [])
  const strokeWidth = $derived(
    imagePx !== null ? Math.max(imagePx.width, imagePx.height) / 400 : 1,
  )
  /** holes/numbered 模式底图淡化（冲孔读图面——用户透明度取 min(值, 0.1)）。 */
  const effectiveBaseOpacity = $derived(
    gemMode === 'holes' || gemMode === 'numbered' ? Math.min(baseOpacity, 0.1) : baseOpacity,
  )
  /** 测量盒尺寸（视口模式 viewBox 组装；jsdom 无布局=0——ResizeObserver 缺席时
   *  经 getBoundingClientRect 降级测量：只随派生重算，无 resize 跟踪不炸）。 */
  let boxEl = $state<HTMLElement | null>(null)
  let boxW = $state(0)
  let boxH = $state(0)
  $effect(() => {
    if (boxEl === null) return
    const measure = (): void => {
      const rect = boxEl!.getBoundingClientRect()
      boxW = rect.width
      boxH = rect.height
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(boxEl)
    return () => observer.disconnect()
  })
  /** 视口模式 viewBox（screen = image×scale + (x,y) 的逆：可见图像域=[−x/s,(box−x)/s]）。 */
  const viewBoxOfView = $derived.by(() => {
    if (view === null || imagePx === null || !(view.scale > 0)) return null
    const w = boxW > 0 ? boxW : imagePx.width
    const h = boxH > 0 ? boxH : imagePx.height
    return `${-view.x / view.scale} ${-view.y / view.scale} ${w / view.scale} ${h / view.scale}`
  })
  /**
   * 框线标签避让布局（add-workbench-pro 2.6 走查遗留：画布新层标签叠压）：
   * 同区域标签纵向堆叠——水平投影重叠（CJK 全角估宽）且垂直间距不足一行者逐级
   * 下移；无碰撞保持原位（bbox 上方居中——既有单标签语义零变化）。
   */
  const labelLayout = $derived.by(() => {
    const layout = new Map<string, { x: number; y: number }>()
    if (imagePx === null) return layout
    const fontSize = Math.max(imagePx.width, imagePx.height) / 28
    const lineHeight = fontSize * 1.25
    const placed: Array<{ x: number; y: number; w: number }> = []
    for (const box of model?.boxes ?? []) {
      const x = box.bbox.x + box.bbox.w / 2
      const y = box.bbox.y - imagePx.height / 200
      const w = fontSize * (box.objectName.length + (box.excluded ? 4 : 0))
      let yy = y
      for (let depth = 0; depth <= placed.length; depth++) {
        const collides = placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - yy) < lineHeight)
        if (!collides) break
        yy += lineHeight
      }
      placed.push({ x, y: yy, w })
      layout.set(box.nodeId, { x, y: yy })
    }
    return layout
  })

  // ------------------------------------------------ v3：点阵渲染变体派生（renderGemsLayer 三模式共用坐标单源）

  /** 渲染模式去重色（rendered 渐变 defs 上界=不同石色数，与颗数无关）。 */
  const gemColors = $derived.by(() => {
    const seen = new Set<string>()
    for (const gem of model?.gems ?? []) seen.add(gem.colorHex)
    return [...seen]
  })

  /** numbered 分组面：按 gems 首现序的图层分组（组号/组色/编号区间/徽标锚）。 */
  const gemGroups = $derived.by(() => {
    if (gemMode !== 'numbered' || model === null || imagePx === null) return null
    const PALETTE = ['#DC2626', '#D97706', '#059669', '#2563EB', '#7C3AED', '#DB2777', '#0891B2', '#65A30D', '#EA580C', '#4F46E5', '#0D9488', '#B45309']
    const nameByNode = new Map((model.boxes ?? []).map((box) => [box.nodeId, box.objectName] as const))
    const bboxByNode = new Map((model.boxes ?? []).map((box) => [box.nodeId, box.bbox] as const))
    const order: string[] = []
    const counts = new Map<string, number>()
    for (const gem of model.gems) {
      if (!counts.has(gem.nodeId)) {
        order.push(gem.nodeId)
        counts.set(gem.nodeId, 0)
      }
      counts.set(gem.nodeId, (counts.get(gem.nodeId) ?? 0) + 1)
    }
    let start = 1
    return order.map((nodeId, index) => {
      const count = counts.get(nodeId) ?? 0
      const range = { start, end: start + count - 1 }
      start += count
      const bbox = bboxByNode.get(nodeId)
      return {
        nodeId,
        groupNo: index + 1,
        colorHex: PALETTE[index % PALETTE.length]!,
        objectName: nameByNode.get(nodeId) ?? nodeId,
        count,
        range,
        badge: bbox !== undefined ? { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 } : null,
      }
    })
  })

  /** numbered 孔色/孔边框色（按层）。 */
  const groupColorByNode = $derived.by(() => {
    const map = new Map<string, string>()
    for (const group of gemGroups ?? []) map.set(group.nodeId, group.colorHex)
    return map
  })

  /** 稀疏点阵（≤300 颗）逐孔标号——密集时仅组徽标（可读性/性能门）。 */
  const numberedPerHoleLabels = $derived((model?.gems.length ?? 0) <= 300)
  /** rendered 高光点（≤2000 颗——密集档回落单元素渐变光泽，性能门不动摇）。 */
  const renderedHighlights = $derived((model?.gems.length ?? 0) <= 2000)
  /** 孔径描边宽（冲孔内缘——随画幅缩放的视觉常量）。 */
  const holeStrokeWidth = $derived(imagePx !== null ? Math.max(imagePx.width, imagePx.height) / 900 : 1)
</script>

{#snippet renderGemsLayer(mode: 'plain' | 'rendered' | 'holes' | 'numbered')}
  <!-- 层 3：strategy gems 点阵（v3 renderGemsLayer——三模式共用 model.gems 坐标/命中单源） -->
  {#if mode === 'rendered'}
    <!-- rendered：钻渲染到孔——金属光泽径向渐变（defs 按石色去重）+稀疏档高光点 -->
    <defs>
      {#each gemColors as color, ci (color)}
        <radialGradient id="wb-gem-grad-{ci}" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"></stop>
          <stop offset="28%" stop-color={color} stop-opacity="1"></stop>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.45"></stop>
        </radialGradient>
      {/each}
    </defs>
    {@const gradIndex = new Map(gemColors.map((color, ci) => [color, ci] as const))}
    {#each model!.gems as gem (gem.id)}
      <circle
        cx={gem.x}
        cy={gem.y}
        r={gem.radiusPx}
        fill="url(#wb-gem-grad-{gradIndex.get(gem.colorHex) ?? 0})"
        stroke="rgba(0,0,0,0.35)"
        stroke-width={Math.max(imagePx!.width, imagePx!.height) / 600}
        data-testid="strategy-gem"
        data-gem-mode="rendered"
        data-node-id={gem.nodeId}
      >
        <title>{gem.id} · {gem.nodeId} · {gem.colorHex}</title>
      </circle>
      {#if renderedHighlights}
        <circle
          cx={gem.x - gem.radiusPx * 0.35}
          cy={gem.y - gem.radiusPx * 0.38}
          r={gem.radiusPx * 0.26}
          fill="#ffffff"
          fill-opacity="0.85"
          pointer-events="none"
          aria-hidden="true"
        ></circle>
      {/if}
    {/each}
  {:else if mode === 'holes'}
    <!-- holes：只有孔洞——冲孔视觉（深色孔+浅色内缘）；底图淡化经 effectiveBaseOpacity -->
    {#each model!.gems as gem (gem.id)}
      <circle
        cx={gem.x}
        cy={gem.y}
        r={gem.radiusPx}
        fill="#20242C"
        stroke="#C7CEDB"
        stroke-width={holeStrokeWidth}
        data-testid="strategy-gem"
        data-gem-mode="holes"
        data-node-id={gem.nodeId}
      >
        <title>{gem.id} · {gem.nodeId}</title>
      </circle>
    {/each}
  {:else if mode === 'numbered'}
    <!-- numbered：孔洞+分类分组编号——孔按层色+层色边框；组徽标（层 bbox 中心）；
         稀疏点阵（≤300）逐孔标号 -->
    {#each model!.gems as gem, gi (gem.id)}
      {@const groupColor = groupColorByNode.get(gem.nodeId) ?? '#20242C'}
      <circle
        cx={gem.x}
        cy={gem.y}
        r={gem.radiusPx}
        fill={groupColor}
        fill-opacity="0.5"
        stroke={groupColor}
        stroke-width={holeStrokeWidth * 1.4}
        data-testid="strategy-gem"
        data-gem-mode="numbered"
        data-node-id={gem.nodeId}
      >
        <title>{gem.id} · {gem.nodeId}</title>
      </circle>
      {#if numberedPerHoleLabels && gem.radiusPx * 4 > Math.max(imagePx!.width, imagePx!.height) / 160}
        <text
          x={gem.x}
          y={gem.y + gem.radiusPx * 0.35}
          text-anchor="middle"
          font-size={gem.radiusPx * 1.3}
          fill="#111827"
          pointer-events="none"
          aria-hidden="true"
          data-testid="strategy-gem-hole-no"
        >{gi + 1}</text>
      {/if}
    {/each}
    {#if gemGroups !== null}
      {@const badgeR = Math.max(imagePx!.width, imagePx!.height) / 110}
      {#each gemGroups as group (group.nodeId)}
        {#if group.badge !== null}
          <g data-testid="strategy-gem-group-badge" data-node-id={group.nodeId}>
            <circle cx={group.badge.x} cy={group.badge.y} r={badgeR} fill={group.colorHex} stroke="#ffffff" stroke-width={badgeR * 0.16}></circle>
            <text x={group.badge.x} y={group.badge.y + badgeR * 0.36} text-anchor="middle" font-size={badgeR * 1.15} font-weight="600" fill="#ffffff">{group.groupNo}</text>
          </g>
        {/if}
      {/each}
    {/if}
  {:else}
    <!-- plain：既有平面圆点（策略设计器缺省——零变化） -->
    {#each model!.gems as gem (gem.id)}
      <circle
        cx={gem.x}
        cy={gem.y}
        r={gem.radiusPx}
        fill={gem.colorHex}
        stroke="rgba(0,0,0,0.25)"
        stroke-width={Math.max(imagePx!.width, imagePx!.height) / 500}
        data-testid="strategy-gem"
        data-gem-mode="plain"
        data-node-id={gem.nodeId}
      >
        <title>{gem.id} · {gem.nodeId} · {gem.colorHex}</title>
      </circle>
    {/each}
  {/if}
{/snippet}

{#snippet canvasLayers()}
  {#if model !== null && imagePx !== null}
        <!-- 层 1：原图（任务详情经 baseImage 锚；策略设计器经 sourceImageUrl）；
             holes/numbered 模式底图淡化（冲孔读图面） -->
        {#if sourceUrl !== null && baseVisible}
          <image href={sourceUrl} x="0" y="0" width={imagePx.width} height={imagePx.height} opacity={effectiveBaseOpacity} data-testid="strategy-base-image" />
        {/if}

        <!-- 层 1.5：蒙版可视化叠加（半透明行程矩形——任务工作台图层管理开关；
             选中层=琥珀高亮填充+描边（add-workbench-pro 2.2 遮罩可视化增强）） -->
        {#if showMasks}
          {#each maskOverlays as overlay (overlay.nodeId)}
            <g
              fill={overlay.selected ? '#F59E0B' : '#7C3AED'}
              fill-opacity={overlay.selected ? 0.3 : 0.22}
              stroke={overlay.selected ? '#B45309' : 'none'}
              stroke-width={overlay.selected ? strokeWidth * 1.5 : undefined}
              data-testid="strategy-mask-overlay"
              data-node-id={overlay.nodeId}
              aria-hidden="true"
            >
              {#each overlay.runs as run, i (i)}
                <rect x={run.x} y={run.y} width={run.w} height={run.h}></rect>
              {/each}
            </g>
          {/each}
        {/if}

        <!-- 层 2：object-tree 预览框线（排除/不值得贴=红虚线；选中层描边加粗；[2c] hover=琥珀描边；
             [2.6] 标签避让——同区域纵向堆叠） -->
        {#if showBoxes}
          {#each model.boxes as box (box.nodeId)}
            <rect
              x={box.bbox.x}
              y={box.bbox.y}
              width={box.bbox.w}
              height={box.bbox.h}
              fill="none"
              stroke={box.nodeId === selectedNodeId ? (box.excluded ? '#dc2626' : '#2563eb') : box.nodeId === hoverNodeId ? '#f59e0b' : box.excluded ? '#dc2626' : '#2563eb'}
              stroke-width={box.nodeId === selectedNodeId ? strokeWidth * 2.5 : box.nodeId === hoverNodeId ? strokeWidth * 2 : strokeWidth}
              stroke-dasharray={box.excluded ? `${imagePx.width / 100} ${imagePx.width / 150}` : undefined}
              data-testid="strategy-node-box"
              data-node-id={box.nodeId}
            ></rect>
            {@const labelPos = labelLayout.get(box.nodeId) ?? { x: box.bbox.x + box.bbox.w / 2, y: box.bbox.y - imagePx.height / 200 }}
            <text
              x={labelPos.x}
              y={labelPos.y}
              text-anchor="middle"
              font-size={Math.max(imagePx.width, imagePx.height) / 28}
              fill={box.excluded ? '#b91c1c' : '#1d4ed8'}
              data-testid="strategy-node-label"
            >{box.objectName}{box.excluded ? '（不贴）' : ''}</text>
          {/each}
        {/if}

        <!-- 层 3：strategy gems 点阵（gemMode 渲染变体分发——v3） -->
        {@render renderGemsLayer(gemMode)}
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col" data-testid="strategy-canvas-panel">
  <div class="bg-background/80 flex h-11 shrink-0 items-center gap-3 border-b px-3 text-xs backdrop-blur">
    <label class="flex items-center gap-1.5" data-testid="strategy-base-toggle-wrap">
      <input
        type="checkbox"
        checked={baseVisible}
        onchange={(event) => onSetBaseVisible?.(event.currentTarget.checked)}
        disabled={sourceUrl === null}
        class="accent-primary size-3.5"
        data-testid="strategy-base-toggle"
      />
      <span class={sourceUrl === null ? 'text-muted-foreground/60' : ''}>原图</span>
    </label>
    {#if sourceUrl !== null}
      <label class="flex min-w-32 items-center gap-1.5">
        <span class="text-muted-foreground">透明度</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={baseOpacity}
          oninput={(event) => onSetBaseOpacity?.(Number(event.currentTarget.value))}
          class="accent-primary h-1.5 w-24"
          data-testid="strategy-base-opacity"
          aria-label="原图透明度"
        />
        <span class="font-mono tabular-nums">{Math.round(baseOpacity * 100)}%</span>
      </label>
    {:else}
      <span class="text-muted-foreground/70" data-testid="strategy-base-missing" title="任务尚无识图工件（scene-analysis 缺席）——原图锚为空，画布按框线+点阵渲染">
        原图未挂接（该任务无识图工件锚——按框线+点阵渲染）
      </span>
    {/if}
    <label class="flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={showBoxes}
        onchange={(event) => onSetShowBoxes?.(event.currentTarget.checked)}
        class="accent-primary size-3.5"
        data-testid="strategy-boxes-toggle"
      />
      <span>图层框线</span>
    </label>
    {#if onSetShowMasks !== undefined}
      <label class="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={showMasks}
          onchange={(event) => onSetShowMasks?.(event.currentTarget.checked)}
          class="accent-primary size-3.5"
          data-testid="strategy-masks-toggle"
        />
        <span>蒙版</span>
      </label>
    {/if}
    <span class="text-muted-foreground ml-auto font-mono" data-testid="strategy-gem-count">
      {model === null ? '' : `${model.gems.length} 颗 · ${model.excludedCount} 处留白 · ${model.ppm.exact ? `ppm=${model.ppm.ppm.toFixed(2)}` : 'ppm≈1（纵横比不吻合）'}`}
    </span>
  </div>

  <div class="bg-muted/50 relative min-h-0 flex-1 overflow-hidden p-3">
    {#if model === null}
      <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 text-center text-sm" data-testid="strategy-canvas-empty">
        {#if loading}
          <p class="animate-pulse">策略工件装载中…</p>
        {:else if loadError !== null}
          <p class="text-destructive" data-testid="strategy-canvas-error">{loadError}</p>
        {:else}
          <p class="font-medium">当前会话尚无策略工件</p>
          <p class="text-xs">{emptyHint}</p>
        {/if}
      </div>
    {:else if imagePx !== null}
      <!-- 画布 viewport 盒（视口模式 viewBox 组装+叠加层注入对齐的测量锚——bind:clientWidth/Height） -->
      <div bind:this={boxEl} class="relative h-full w-full">
      {#if viewBoxOfView !== null}
        <svg
          viewBox={viewBoxOfView}
          preserveAspectRatio="xMidYMid meet"
          class="absolute inset-0 h-full w-full"
          data-testid="strategy-canvas"
          data-canvas-viewport="true"
          role="img"
          aria-label="策略层叠加画布（原图+图层框线+钻点阵）"
        >
          {@render canvasLayers()}
        </svg>
      {:else}
        <svg
          viewBox="0 0 {imagePx.width} {imagePx.height}"
          preserveAspectRatio="xMidYMid meet"
          class="mx-auto h-full w-full max-w-full"
          data-testid="strategy-canvas"
          role="img"
          aria-label="策略层叠加画布（原图+图层框线+钻点阵）"
        >
          {@render canvasLayers()}
        </svg>
      {/if}
      <!-- numbered 图例（分组=策略/钻分类——色块=图层名+编号区间；v3） -->
      {#if gemMode === 'numbered' && gemGroups !== null && gemGroups.length > 0}
        <div
          class="bg-background/90 scrollbar-thin border-muted/60 pointer-events-none absolute right-2 top-2 z-10 max-h-[70%] max-w-56 overflow-y-auto rounded-md border px-2.5 py-2 shadow-sm backdrop-blur"
          data-testid="strategy-gem-legend"
          aria-label="分组编号图例"
        >
          <p class="text-muted-foreground mb-1 text-[10px] font-semibold">分组编号图例</p>
          {#each gemGroups as group (group.nodeId)}
            <div class="flex items-center gap-1.5 py-0.5 text-[10px]" data-testid="strategy-gem-legend-row" data-node-id={group.nodeId}>
              <span class="size-2.5 shrink-0 rounded-sm border border-black/10" style="background: {group.colorHex}" aria-hidden="true"></span>
              <span class="w-4 shrink-0 text-center font-mono font-semibold">{group.groupNo}</span>
              <span class="min-w-0 flex-1 truncate" title={group.objectName}>{group.objectName}</span>
              <span class="text-muted-foreground shrink-0 font-mono">#{group.range.start}-{group.range.end}（{group.count}）</span>
            </div>
          {/each}
        </div>
      {/if}
      {@render children?.()}
      </div>
    {/if}
  </div>
</div>
