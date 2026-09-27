<!--
WorkbenchLayerStage.svelte — 工作台主画布·PS 化图层舞台（rework-layer-model v4
design §1/§3——替代 StrategyCanvas 在工作台的消费位；策略设计器仍用 StrategyCanvas）。
渲染语义：
  背景层=原图（可隐藏+透明度——holes 模式自动淡化）→ 图层抠图叠加（树前序=DOM 序
  =z 序，父先子后=父层底层）→ 钻子层（画进所属层坐标系——WorkbenchLayerItem）。
  常驻元素仅图层内容与钻渲染——零条框、零常驻文字（少即是多）。
交互态（屏幕空间叠加——常亮仅交互时）：
  hover=该层抠图提亮（层项内 CSS filter）+bbox 1px 虚线（无文字）；
  选中=2px 实线+名称标签（bbox 顶部半透明底）+右栏联动（store selectedNodeId）。
取景：world 容器 CSS transform=CanvasView（translate+scale——lib/canvaskit 单源；
滚轮锚定缩放/平移由 WorkbenchCanvasStage 驱动，本组件零交互逻辑）。
叠加注入（children snippet）：笔刷层/指针捕获层与本舞台同盒对齐（inset-0）。
-->

<script lang="ts">
  import type { Snippet } from 'svelte'
  import { imageToScreen } from '$lib/canvaskit.js'
  import { getCanvasView } from './canvasStage.svelte.js'
  import {
    getBaseImageOpacity,
    getBaseImageVisible,
    getNumberedGroupStrokes,
    getPreviewMode,
    getSelectedNodeId,
    getShowMasks,
  } from './store.svelte'
  import WorkbenchLayerItem from './WorkbenchLayerItem.svelte'
  import type { LayerRenderModel } from './layerRender.svelte.js'

  let {
    model = null,
    emptyHint = '该任务尚无排钻产物——在 Agent 会话完成策略执行',
    hoveredNodeId = null,
    children = undefined,
  }: {
    model?: LayerRenderModel | null
    emptyHint?: string
    hoveredNodeId?: string | null
    children?: Snippet | undefined
  } = $props()

  const view = $derived(getCanvasView())
  const baseVisible = $derived(getBaseImageVisible())
  const baseOpacity = $derived(getBaseImageOpacity())
  const previewMode = $derived(getPreviewMode())
  const showMasks = $derived(getShowMasks())
  const numberedStrokes = $derived(getNumberedGroupStrokes())
  const selectedId = $derived(getSelectedNodeId())

  /** holes 模式底图淡化（冲孔读图面——用户透明度取 min(值, 0.1)）。 */
  const effectiveBaseOpacity = $derived(previewMode === 'holes' ? Math.min(baseOpacity, 0.1) : baseOpacity)

  /** 选中/hover 行（可见才有交互态——隐藏层无边界）。 */
  const selectedRow = $derived.by(() => {
    if (selectedId === null || model === null) return null
    const row = model.rows.find((candidate) => candidate.node.id === selectedId)
    return row !== undefined && row.visible ? row : null
  })
  const hoveredRow = $derived.by(() => {
    if (hoveredNodeId === null || model === null) return null
    if (hoveredNodeId === selectedId) return null // 选中层不叠 hover 态
    const row = model.rows.find((candidate) => candidate.node.id === hoveredNodeId)
    return row !== undefined && row.visible ? row : null
  })

  /** bbox → 屏幕矩形（CanvasView 正映射——canvaskit 单源）。 */
  function screenRect(bbox: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const topLeft = imageToScreen(view, bbox.x, bbox.y)
    return { x: topLeft.x, y: topLeft.y, w: bbox.w * view.scale, h: bbox.h * view.scale }
  }

  const selectedRect = $derived(selectedRow === null ? null : screenRect(selectedRow.node.bbox))
  const hoveredRect = $derived(hoveredRow === null ? null : screenRect(hoveredRow.node.bbox))
  /** 名称标签位（bbox 顶上方 22px——越界贴顶内收）。 */
  const selectedLabelTop = $derived(selectedRect === null ? 0 : Math.max(0, selectedRect.y - 22))
</script>

<div
  class="bg-muted/40 relative h-full w-full overflow-hidden"
  data-testid="workbench-layer-stage"
  role="img"
  aria-label="图层画布（背景层+图层抠图+钻渲染——hover/选中时显示边界）"
>
  {#if model === null}
    <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-sm" data-testid="workbench-stage-empty">
      <p class="font-medium">画布空态</p>
      <p class="text-xs">{emptyHint}</p>
    </div>
  {:else}
    <!-- world（取景变换真源=CanvasView——屏幕=图像×scale+(x,y)） -->
    <div
      class="absolute left-0 top-0 origin-top-left"
      style="transform: translate({view.x}px, {view.y}px) scale({view.scale});"
      data-testid="workbench-world"
      aria-hidden="true"
    >
      <!-- 背景层：原图（可隐藏；层序最底） -->
      {#if model.sourceUrl !== null && baseVisible}
        <img
          src={model.sourceUrl}
          alt=""
          draggable="false"
          class="pointer-events-none absolute left-0 top-0 select-none"
          style="width: {model.imagePx.width}px; height: {model.imagePx.height}px; opacity: {effectiveBaseOpacity};"
          data-testid="workbench-base-image"
        />
      {/if}
      <!-- 图层叠（树前序=DOM 序=z 序；不可见行跳过——显隐传递） -->
      {#each model.rows as row (row.node.id)}
        {#if row.visible}
          <WorkbenchLayerItem {row} {previewMode} {showMasks} {numberedStrokes} selected={row.node.id === selectedId} hovered={row.node.id === hoveredNodeId} />
        {/if}
      {/each}
    </div>

    <!-- 交互态叠加（屏幕空间——常亮仅 hover/选中；零常驻条框文字） -->
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
      {#if hoveredRect !== null && hoveredRow !== null}
        <div
          class="absolute border border-dashed border-amber-500"
          style="left: {hoveredRect.x}px; top: {hoveredRect.y}px; width: {hoveredRect.w}px; height: {hoveredRect.h}px;"
          data-testid="workbench-hover-outline"
          data-node-id={hoveredRow.node.id}
        ></div>
      {/if}
      {#if selectedRect !== null && selectedRow !== null}
        <div
          class="border-primary absolute border-2"
          style="left: {selectedRect.x}px; top: {selectedRect.y}px; width: {selectedRect.w}px; height: {selectedRect.h}px;"
          data-testid="workbench-selection-outline"
          data-node-id={selectedRow.node.id}
        ></div>
        <!-- 名称标签（bbox 顶部半透明底——仅选中时；越界贴顶内收） -->
        <div
          class="bg-primary/90 text-primary-foreground absolute max-w-64 truncate rounded-b px-1.5 py-0.5 text-[11px] leading-tight"
          style="left: {selectedRect.x}px; top: {selectedLabelTop}px;"
          data-testid="workbench-selection-label"
          data-node-id={selectedRow.node.id}
          title={selectedRow.node.objectName}
        >
          {selectedRow.node.objectName}{selectedRow.gems.length > 0 ? ` · ${selectedRow.gems.length} 颗` : ''}
        </div>
      {/if}
    </div>
  {/if}
  {@render children?.()}
</div>
