/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 2.x] 画布视口态真源（design §1.3 交互态域）：
 *    {scale, x, y}（图像→屏幕仿射：screen = image×scale + (x,y)）——画布写（滚轮锚缩放/
 *    平移/fit），状态栏缩放比读数消费。
 * 2. [3.x P9-P12] 缩放档位与视图命令宿主：档位值域 [10%, 1600%]（design §2 P10）；
 *    画布注册宿主（fit/zoomStep/zoomTo——坐标换算与画布尺寸在画布侧单源），命令总线
 *    （⌘+/-/0/1、右键菜单「适配画幅/100%」、P8 双击切换）经本模块转发，无宿主（画布
 *    未挂载）时返回 false 放行。
 * 3. [Test] resetViewportForTests 复位。
 */

/**
 * [add-workbench-pro 2c §0 抽取] 纯几何/常量真源已上移 `lib/canvaskit.ts`
 * （designer 与 taskWorkbench 双消费单源）——本模块 re-export 保持既有 import
 * 路径零变化；此处仅保留 designer 专属的 $state 视口单例与命令宿主注册表。
 */
export { ZOOM_MIN_SCALE, ZOOM_MAX_SCALE, clampZoomScale } from '$lib/canvaskit.js'
export type { CanvasView } from '$lib/canvaskit.js'

import type { CanvasView } from '$lib/canvaskit.js'

let view = $state<CanvasView>({ scale: 1, x: 0, y: 0 })

export function getViewState(): CanvasView {
  return view
}

export function setViewState(next: CanvasView): void {
  view = { scale: next.scale, x: next.x, y: next.y }
}

// ---------------------------------------------------------------------------
// 视图命令宿主（画布注册；命令总线消费——同源纪律：视图命令单实现）
// ---------------------------------------------------------------------------

export interface ViewportHost {
  /** 适配画幅（contain 取景）。 */
  fit(): void
  /** 以画布中心为锚缩放一档（factor > 1 放大）。 */
  zoomStep(factor: number): void
  /** 缩放至指定比例（以画布中心为锚）。 */
  zoomTo(scale: number): void
}

let host: ViewportHost | null = null

/** 画布挂载时注册（卸载注销）——坐标换算与容器尺寸保持在画布侧单源。 */
export function setViewportHost(next: ViewportHost | null): void {
  host = next
}

export function viewportFit(): boolean {
  if (host === null) return false
  host.fit()
  return true
}

export function viewportZoomStep(factor: number): boolean {
  if (host === null) return false
  host.zoomStep(factor)
  return true
}

export function viewportZoomTo(scale: number): boolean {
  if (host === null) return false
  host.zoomTo(scale)
  return true
}

/** 测试专用：复位（scale=1 原点 + 宿主注销）。 */
export function resetViewportForTests(): void {
  view = { scale: 1, x: 0, y: 0 }
  host = null
}
