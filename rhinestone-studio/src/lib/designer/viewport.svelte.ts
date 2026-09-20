/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-21 redesign-designer-workbench 2.x] 画布视口态真源（design §1.3 交互态域）：
 *    {scale, x, y}（图像→屏幕仿射：screen = image×scale + (x,y)）——画布写（滚轮锚缩放/
 *    平移/fit），状态栏缩放比读数消费；视图导航命令（⌘+/⌘-/⌘0/⌘1、双击 100%⇄适配）归 2.3。
 * 2. [Test] resetViewportForTests 复位。
 */

/** 画布视口（屏幕坐标 = 图像坐标 × scale + (x, y)；jsdom/浏览器同参换算）。 */
export interface CanvasView {
  scale: number
  x: number
  y: number
}

let view = $state<CanvasView>({ scale: 1, x: 0, y: 0 })

export function getViewState(): CanvasView {
  return view
}

export function setViewState(next: CanvasView): void {
  view = { scale: next.scale, x: next.x, y: next.y }
}

/** 测试专用：复位（scale=1 原点）。 */
export function resetViewportForTests(): void {
  view = { scale: 1, x: 0, y: 0 }
}
