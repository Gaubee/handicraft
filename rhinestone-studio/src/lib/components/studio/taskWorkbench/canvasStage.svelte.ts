/*
 * canvasStage.svelte.ts——工作台画布舞台态（add-workbench-pro 2c 鼠标 P0+状态栏）。
 *
 * Orthogonal intents (max 3):
 * 1. [视口态] CanvasView {scale,x,y} 单例（真源=lib/canvaskit 纯几何——designer
 *    viewport.svelte.ts 同款基建的参数化复用，§0 红线）：滚轮锚定缩放（光标为锚）/
 *    空格·中键·抓手平移/fit（contain 适配）/100%。fit 在用户手动调整后不再自动
 *    重算（几何/画幅变化不覆盖用户取景）。
 * 2. [工具与指针] 三工具 select/hand/zoom（键位 V/H/Z——designer keymap 真源对齐）
 *    +指针画布 px 坐标（状态栏 px↔mm 读数源）+hover 层 id（画布命中高亮）。笔刷
 *    模式由 store.brush 承载（覆盖层接管指针——本模块工具面让位）。
 * 3. [Test] resetCanvasStageForTests 复位（jsdom 无布局——几何缺省时 fit 退 scale=1）。
 */

import {
  fitContainView,
  panViewBy,
  zoomAboutCenter,
  zoomAtAnchor,
  type CanvasView,
} from '$lib/canvaskit.js'

/** 工作台画布工具（design §2 键盘行——V 选择/H 平移/Z 缩放；B 笔刷在 store.brush）。 */
export type WorkbenchTool = 'select' | 'hand' | 'zoom'

let view = $state<CanvasView>({ scale: 1, x: 0, y: 0 })
/** 用户手动取景后不再自动 fit（几何/画幅变化不覆盖——designer userAdjusted 同式）。 */
let userAdjusted = $state(false)
/** 舞台几何（测量盒——组件 $effect 推送；null=未测量（jsdom））。 */
let geometry = $state<{ boxW: number; boxH: number; imageW: number; imageH: number } | null>(null)

let tool = $state<WorkbenchTool>('select')
let pointerImage = $state<{ x: number; y: number } | null>(null)
let hoveredNodeId = $state<string | null>(null)

export function getCanvasView(): CanvasView {
  return view
}

export function getWorkbenchTool(): WorkbenchTool {
  return tool
}

/** 工具切换（V/H/Z 键与工具条按钮同源——命令总线单点调用）。 */
export function setWorkbenchTool(next: WorkbenchTool): boolean {
  tool = next
  return true
}

export function getPointerImage(): { x: number; y: number } | null {
  return pointerImage
}

/** 指针画布坐标更新（pointermove 驱动——null=离场）。 */
export function setPointerImage(next: { x: number; y: number } | null): void {
  pointerImage = next
}

export function getHoveredNodeId(): string | null {
  return hoveredNodeId
}

/** hover 层（画布命中高亮——select 工具 pointermove 驱动）。 */
export function setHoveredNodeId(nodeId: string | null): void {
  hoveredNodeId = nodeId
}

/**
 * 舞台几何推送（组件测量盒+当前画幅）：未手动取景时自动 contain 适配（首测量/
 * 画幅变化——fit 语义独立不受档位夹取）。
 */
export function noteStageGeometry(boxW: number, boxH: number, imageW: number, imageH: number): void {
  geometry = { boxW, boxH, imageW, imageH }
  if (!userAdjusted && boxW > 0 && boxH > 0) view = fitContainView(boxW, boxH, imageW, imageH)
}

/** 适配画幅（fit 命令/按钮——⌘0 同源）。返回是否生效（无几何=false 放行）。 */
export function fitCanvasView(): boolean {
  if (geometry === null || geometry.boxW <= 0 || geometry.boxH <= 0) return false
  view = fitContainView(geometry.boxW, geometry.boxH, geometry.imageW, geometry.imageH)
  userAdjusted = false
  return true
}

/** 缩放至指定比例（画布中心为锚——100%/⌘1 同源）。 */
export function zoomCanvasTo(scale: number): boolean {
  if (geometry === null) {
    view = { scale, x: 0, y: 0 }
    userAdjusted = true
    return true
  }
  view = zoomAboutCenter(view, geometry.boxW, geometry.boxH, scale / (view.scale || 1))
  userAdjusted = true
  return true
}

/** 中心锚步进缩放（⌘+/⌘- 工具条同源；factor>1 放大）。 */
export function zoomCanvasStep(factor: number): boolean {
  if (geometry === null) return false
  view = zoomAboutCenter(view, geometry.boxW, geometry.boxH, factor)
  userAdjusted = true
  return true
}

/**
 * 滚轮锚定缩放（光标为锚——px/py 为测量盒局部坐标）。滚轮恒启用（不限工具——
 * PS 惯例；画布空态由调用方判）。
 */
export function zoomCanvasAtPoint(px: number, py: number, factor: number): void {
  view = zoomAtAnchor(view, px, py, factor)
  userAdjusted = true
}

/** 平移（空格/中键/抓手拖拽——屏幕位移 px）。 */
export function panCanvasBy(dx: number, dy: number): void {
  view = panViewBy(view, dx, dy)
  userAdjusted = true
}

export function isCanvasUserAdjusted(): boolean {
  return userAdjusted
}

export function resetCanvasStageForTests(): void {
  view = { scale: 1, x: 0, y: 0 }
  userAdjusted = false
  geometry = null
  tool = 'select'
  pointerImage = null
  hoveredNodeId = null
}

/** 测试直设视口（jsdom 无布局——几何驱动面不可达时手工设定取景）。 */
export function setCanvasViewForTests(next: CanvasView): void {
  view = { ...next }
  userAdjusted = true
}
