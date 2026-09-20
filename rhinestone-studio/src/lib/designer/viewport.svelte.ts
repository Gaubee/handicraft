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

/** 画布视口（屏幕坐标 = 图像坐标 × scale + (x, y)；jsdom/浏览器同参换算）。 */
export interface CanvasView {
  scale: number
  x: number
  y: number
}

/** 缩放档位下界（design §2 P10：10%）。 */
export const ZOOM_MIN_SCALE = 0.1
/** 缩放档位上界（design §2 P10：1600%）。 */
export const ZOOM_MAX_SCALE = 16

let view = $state<CanvasView>({ scale: 1, x: 0, y: 0 })

export function getViewState(): CanvasView {
  return view
}

export function setViewState(next: CanvasView): void {
  view = { scale: next.scale, x: next.x, y: next.y }
}

/** 档位夹取（滚轮/工具/键盘/双击的统一值域；fit 语义独立不受限）。 */
export function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return ZOOM_MIN_SCALE
  return Math.min(ZOOM_MAX_SCALE, Math.max(ZOOM_MIN_SCALE, scale))
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
