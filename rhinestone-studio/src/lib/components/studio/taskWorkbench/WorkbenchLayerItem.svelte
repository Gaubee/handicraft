<!--
WorkbenchLayerItem.svelte — 图层渲染项（rework-layer-model v4 design §1/§3）。
一个图层=抠图位图（mask ⊕ 原图——cutout.svelte 合成缓存供）+钻子层 canvas
（gems 画在所属层坐标系：blockId=该节点，层内坐标=画布 px−bbox 原点；随层显隐
传递由父级 rows.visible 过滤承担）。
渲染变体（previewMode）：
  rendered=钻渲进层（径向渐变金属光泽+稀疏档高光）；holes=只孔洞（深色孔+浅内缘
  ——cutout 缺席）；numbered=组色孔+稀疏点阵逐孔标号+可选组色描边（缺省关）。
蒙版叠加（showMasks 开启）=位面行程矩形（选中层琥珀、其余紫）——诊断开关非常驻。
hover 提亮（~8% 白）由 CSS filter 承担（父级传入 hovered）。jsdom 无 2d context
——绘制静默跳过（DOM 结构照常，测试断言结构面）。
-->

<script lang="ts">
  import { getCutoutEntryOf } from './cutout.svelte.js'
  import type { LayerRenderRow } from './layerRender.svelte.js'
  import type { WorkbenchPreviewMode } from '@handicraft/contracts'

  let {
    row,
    previewMode,
    showMasks = false,
    selected = false,
    hovered = false,
    numberedStrokes = false,
  }: {
    row: LayerRenderRow
    previewMode: WorkbenchPreviewMode
    showMasks?: boolean
    selected?: boolean
    hovered?: boolean
    /** numbered 模式组色描边开关（缺省关——回归纯视图）。 */
    numberedStrokes?: boolean
  } = $props()

  const { node } = $derived(row)
  const cutoutEntry = $derived(getCutoutEntryOf(node.id))

  /**
   * 抠图宿主（v4 修正：消费方自持 canvas，缓存主位图经 drawImage 拷贝——缓存节点
   * 永不入 DOM。Tabs 恒挂载下 embedded 面板与完整工作台双实例并存，若直接移入
   * 缓存单节点，两实例挂载 effect 会互相争抢同一 DOM 节点（末位胜出=另一实例缺位）。
   * 内存口径（修复轮二 G3/Codex 二轮 P2）：本副本按 bbox 尺寸 w*h*4 计，**不在**
   * cutout LRU 的 cache-owned estimate 预算内（该预算只统计缓存主位图+缩略）——
   * 全页 canvas 总内存上限（含每实例副本+并发合成临时面）为后续架构项，不虚报。
   */
  let cutoutCanvasEl = $state<HTMLCanvasElement | null>(null)
  const cutoutMaster = $derived(cutoutEntry.phase === 'ready' ? cutoutEntry.canvas : null)

  $effect(() => {
    const canvas = cutoutCanvasEl
    const master = cutoutMaster
    if (canvas === null) return
    if (canvas.width !== node.bbox.w) canvas.width = node.bbox.w
    if (canvas.height !== node.bbox.h) canvas.height = node.bbox.h
    const ctx = canvas.getContext('2d')
    if (ctx === null) return // jsdom——结构面照常，像素面缺位
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (master !== null) ctx.drawImage(master, 0, 0)
  })

  /** 钻子层 canvas（层坐标系——本组件自持）。 */
  let gemsEl = $state<HTMLCanvasElement | null>(null)

  // 绘制面常量（v3 StrategyCanvas 视觉同款——canvas 化）
  const imageMax = $derived(Math.max(node.bbox.w * 4, node.bbox.h * 4, 160))
  const holeStrokeW = $derived(Math.max(1, imageMax / 900))
  /**
   * 逐孔标号稀疏化（v5 vision 混乱来源 7——徽标密度治理）：≤60 颗逐孔标号；
   * >60 颗间隔抽稀至 ≈60 个标号（numberEvery 间隔取整——画布可读性优先，孔色
   * 分组语义不受影响）。60=vision 判读定案的密度门。
   */
  const NUMBER_DENSITY_GATE = 60
  const numberEvery = $derived(row.gems.length <= NUMBER_DENSITY_GATE ? 1 : Math.ceil(row.gems.length / NUMBER_DENSITY_GATE))
  const perHoleNumbers = $derived(row.gems.length <= 300)
  /** rendered 高光点（≤2000 颗——密集档回落单元素渐变光泽）。 */
  const renderedHighlights = $derived(row.gems.length <= 2000)

  $effect(() => {
    const canvas = gemsEl
    const gems = row.gems
    const mode = previewMode
    const runs = showMasks ? row.maskRuns : null
    const strokes = numberedStrokes && mode === 'numbered'
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return // jsdom——结构面照常，像素面缺位
    const w = node.bbox.w
    const h = node.bbox.h
    ctx.clearRect(0, 0, w, h)
    // —— 蒙版叠加（诊断开关：行程矩形填充——选中层琥珀）——
    if (runs !== null && runs.length > 0) {
      ctx.fillStyle = selected ? 'rgba(245, 158, 11, 0.30)' : 'rgba(124, 58, 237, 0.22)'
      for (const run of runs) {
        if (run.x < node.bbox.x || run.y < node.bbox.y) continue
        ctx.fillRect(run.x - node.bbox.x, run.y - node.bbox.y, run.w, run.h)
      }
    }
    if (gems.length === 0) return
    const bboxX = node.bbox.x
    const bboxY = node.bbox.y
    if (mode === 'rendered') {
      // —— 钻渲进层：金属光泽径向渐变（原点梯度+translate 复用）+稀疏档高光 ——
      const byColor = new Map<string, CanvasGradient>()
      for (const gem of gems) {
        const lx = gem.x - bboxX
        const ly = gem.y - bboxY
        let grad = byColor.get(gem.colorHex)
        if (grad === undefined) {
          grad = ctx.createRadialGradient(-gem.radiusPx * 0.35, -gem.radiusPx * 0.38, gem.radiusPx * 0.08, 0, 0, gem.radiusPx)
          grad.addColorStop(0, 'rgba(255,255,255,0.95)')
          grad.addColorStop(0.28, gem.colorHex)
          grad.addColorStop(1, 'rgba(0,0,0,0.45)')
          byColor.set(gem.colorHex, grad)
        }
        ctx.save()
        ctx.translate(lx, ly)
        ctx.beginPath()
        ctx.arc(0, 0, gem.radiusPx, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()
        ctx.lineWidth = Math.max(0.6, imageMax / 600)
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'
        ctx.stroke()
        if (renderedHighlights) {
          ctx.beginPath()
          ctx.arc(-gem.radiusPx * 0.35, -gem.radiusPx * 0.38, gem.radiusPx * 0.26, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(255,255,255,0.85)'
          ctx.fill()
        }
        ctx.restore()
      }
    } else if (mode === 'holes') {
      // —— 只孔洞：深色孔+浅色内缘（冲孔视觉）——
      for (const gem of gems) {
        const lx = gem.x - bboxX
        const ly = gem.y - bboxY
        ctx.beginPath()
        ctx.arc(lx, ly, gem.radiusPx, 0, Math.PI * 2)
        ctx.fillStyle = '#20242C'
        ctx.fill()
        ctx.lineWidth = holeStrokeW
        ctx.strokeStyle = '#C7CEDB'
        ctx.stroke()
      }
    } else {
      // —— numbered：组色孔（半透明填充+组色描边）+稀疏档逐孔标号 ——
      const groupColor = row.groupColor ?? '#20242C'
      for (const [i, gem] of gems.entries()) {
        const lx = gem.x - bboxX
        const ly = gem.y - bboxY
        ctx.beginPath()
        ctx.arc(lx, ly, gem.radiusPx, 0, Math.PI * 2)
        ctx.globalAlpha = 0.5
        ctx.fillStyle = groupColor
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.lineWidth = holeStrokeW * 1.4
        ctx.strokeStyle = groupColor
        ctx.stroke()
        if (perHoleNumbers && gem.radiusPx * 4 > imageMax / 160 && i % numberEvery === 0) {
          ctx.font = `${gem.radiusPx * 1.3}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = '#111827'
          ctx.fillText(String((row.gemsStart ?? 0) + i + 1), lx, ly)
        }
      }
      // 组色描边（可选开关——bbox 周界组色环）
      if (strokes) {
        ctx.lineWidth = Math.max(1.5, imageMax / 400)
        ctx.strokeStyle = groupColor
        ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth)
      }
    }
  })
</script>

<!-- 层项（绝对定位=画布 px 坐标；DOM 序=z 序由父级树前序承担；根节点无抠图=位面缺位） -->
<div
  class="absolute {hovered && !selected ? 'z-[1]' : ''}"
  style="left: {node.bbox.x}px; top: {node.bbox.y}px; width: {node.bbox.w}px; height: {node.bbox.h}px;"
  data-testid="workbench-layer-item-{node.id}"
  data-node-id={node.id}
  data-gem-count={row.gems.length}
  data-cutout-phase={cutoutEntry.phase}
  data-selected={selected ? 'true' : undefined}
  data-group-color={row.groupColor ?? undefined}
  data-mask-on={showMasks && row.maskRuns !== null && row.maskRuns.length > 0 ? 'true' : undefined}
  data-mask-selected={showMasks && selected ? 'true' : undefined}
  aria-hidden="true"
>
  {#if node.parent !== null && previewMode !== 'holes' && cutoutEntry.phase !== 'error'}
    <!-- 抠图位图（自持 canvas 拷贝缓存主位图；hover 提亮 ~8% 白——CSS filter，零重绘） -->
    <div
      class="absolute inset-0 overflow-hidden {cutoutEntry.phase === 'loading' ? 'animate-pulse bg-muted/30' : ''}"
      style="filter: {hovered && !selected ? 'brightness(1.08)' : 'none'};"
      data-testid="workbench-layer-cutout-{node.id}"
      data-phase={cutoutEntry.phase}
    >
      <canvas bind:this={cutoutCanvasEl} width={node.bbox.w} height={node.bbox.h} class="block h-full w-full"></canvas>
    </div>
    {#if cutoutEntry.phase === 'loading'}
      <!-- 合成中占位（design §2：bbox 虚线占位——仅首次/编辑后低频） -->
      <div class="border-border/70 absolute inset-0 border border-dashed" data-testid="workbench-cutout-loading-{node.id}"></div>
    {/if}
  {/if}
  <!-- 钻子层（层坐标系 canvas——三模式绘制变体） -->
  <canvas
    bind:this={gemsEl}
    width={node.bbox.w}
    height={node.bbox.h}
    class="absolute inset-0 h-full w-full"
    data-testid="workbench-layer-gems-{node.id}"
    data-gem-mode={previewMode}
  ></canvas>
</div>
