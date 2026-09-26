/*
 * canvaskit.ts——画布交互基建共享核（add-workbench-pro 2c §0 复用红线的抽取落点）。
 *
 * Orthogonal intents (max 3):
 * 1. [抽取真源] designer 视口/键位/触摸三真源（viewport.svelte.ts / keymap.ts /
 *    touchGestures.ts）中的**纯决策与几何**抽至本模块：designer 与 taskWorkbench
 *    双消费单源（禁第二实现）。designer 侧模块保留 $state 单例与宿主注册表并
 *    re-export 本模块符号——既有 import 路径与测试面零变化。
 * 2. [坐标语义] CanvasView {scale,x,y}：screen = image×scale + (x,y)（画布容器
 *    局部坐标）；锚定缩放（zoomAtAnchor——光标为锚）/ 平移 / contain 适配 / 正逆
 *    映射。值域 [10%,1600%]（fit 独立取景不受限）。双指捏合与滚轮同公式连续合成。
 * 3. [Pure] 纯 TS 零 runes/DOM 依赖——jsdom 直测；designer 视口态与 workbench
 *    画布态各自持实例（$state 归各自 .svelte 模块）。
 */

// ---------------------------------------------------------------- 视口几何（真源：designer/viewport.svelte.ts）

/** 画布视口（屏幕坐标 = 图像坐标 × scale + (x, y)；jsdom/浏览器同参换算）。 */
export interface CanvasView {
  scale: number
  x: number
  y: number
}

/** 缩放档位下界（10%）。 */
export const ZOOM_MIN_SCALE = 0.1
/** 缩放档位上界（1600%）。 */
export const ZOOM_MAX_SCALE = 16

/** 档位夹取（滚轮/工具/键盘/双击的统一值域；fit 语义独立不受限）。 */
export function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return ZOOM_MIN_SCALE
  return Math.min(ZOOM_MAX_SCALE, Math.max(ZOOM_MIN_SCALE, scale))
}

/**
 * 锚定缩放（纯）：屏幕点 (ax,ay) 下的图像点缩放前后钉在原屏幕位。
 * 公式（designer DesignerCanvas.zoomAt / touchGestures.twoFingerDecision 同源）：
 * scale' = clamp(scale×factor)；x' = ax − (ax − x)/scale × scale'。
 */
export function zoomAtAnchor(view: CanvasView, ax: number, ay: number, factor: number): CanvasView {
  if (!(view.scale > 0)) return { ...view }
  const scale = clampZoomScale(view.scale * factor)
  return {
    scale,
    x: ax - ((ax - view.x) / view.scale) * scale,
    y: ay - ((ay - view.y) / view.scale) * scale,
  }
}

/** 平移（纯）：屏幕位移 (dx,dy) 直接加到视口偏移。 */
export function panViewBy(view: CanvasView, dx: number, dy: number): CanvasView {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy }
}

/** 容器中心为锚的缩放（纯）——fit/100%/键盘档位命令的统一锚点。 */
export function zoomAboutCenter(view: CanvasView, containerW: number, containerH: number, factor: number): CanvasView {
  return zoomAtAnchor(view, containerW / 2, containerH / 2, factor)
}

/**
 * contain 适配（纯）：图像 (imageW,imageH) 完整可见并居中于容器 (containerW,containerH)。
 * fit 语义独立——scale 不经档位夹取（极小画幅可 <10%）。退化输入（任一 ≤0）返回原视口。
 */
export function fitContainView(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number,
): CanvasView {
  if (!(containerW > 0 && containerH > 0 && imageW > 0 && imageH > 0)) return { scale: 1, x: 0, y: 0 }
  const scale = Math.min(containerW / imageW, containerH / imageH)
  return {
    scale,
    x: (containerW - imageW * scale) / 2,
    y: (containerH - imageH * scale) / 2,
  }
}

/** 屏幕（容器局部）→ 图像坐标（view 的逆映射）。 */
export function screenToImage(view: CanvasView, sx: number, sy: number): { x: number; y: number } {
  if (!(view.scale > 0)) return { x: sx, y: sy }
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }
}

/** 图像 → 屏幕（容器局部）坐标。 */
export function imageToScreen(view: CanvasView, ix: number, iy: number): { x: number; y: number } {
  return { x: ix * view.scale + view.x, y: iy * view.scale + view.y }
}

// ---------------------------------------------------------------- 键位保护（真源：designer/keymap.ts）

/** 表单控件聚焦判定（input/textarea/select/contenteditable —— 键盘归表单，不劫持）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** IME 组字中判定（中文输入法组合期间不拦截——W10 P1 同款谨慎）。 */
export function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

/**
 * 工具单键匹配（纯）：无修饰键且非表单聚焦时命中绑定表。designer 与 workbench
 * 各自的绑定表共用同一判定（V 选择/H 平移/Z 缩放跨端一致——§0 真源表）。
 */
export function matchSingleKeyTool<T extends string>(
  event: KeyboardEvent,
  bindings: ReadonlyArray<{ key: string; tool: T }>,
): T | null {
  if (event.defaultPrevented || isImeComposing(event)) return null
  if (isEditableTarget(event.target)) return null
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  const binding = bindings.find((b) => b.key === event.key.toLowerCase())
  return binding === undefined ? null : binding.tool
}

// ---------------------------------------------------------------- 双指两态（真源：designer/touchGestures.ts）

/** 画布局部屏幕坐标点（px；client − canvas rect，DOM 换算归画布消费方）。 */
export interface TouchPoint {
  x: number
  y: number
}

/** 两指样本（p0/p1 按指针进入序；span/质心由 touchSpan/touchMidpoint 派生）。 */
export interface TwoFingerSample {
  p0: TouchPoint
  p1: TouchPoint
}

/** 捏合判定阈值：span 相对变化 ≥ 2% 主导为 zoom；否则质心位移主导为 pan。 */
export const PINCH_ZOOM_RATIO_EPS = 0.02

/** 两指指距（span，px）。 */
export function touchSpan(sample: TwoFingerSample): number {
  return Math.hypot(sample.p1.x - sample.p0.x, sample.p1.y - sample.p0.y)
}

/** 两指质心（缩放锚 / 平移位移基准）。 */
export function touchMidpoint(sample: TwoFingerSample): TouchPoint {
  return { x: (sample.p0.x + sample.p1.x) / 2, y: (sample.p0.y + sample.p1.y) / 2 }
}

export interface TwoFingerDecision {
  /** 两态主分型：'zoom' = 捏合缩放（span 变化主导）；'pan' = 拖动平移（质心位移主导）。 */
  intent: 'zoom' | 'pan'
  /** 下一视口（缩放已过 clampZoomScale 档位夹取；pan 态 scale 不变）。 */
  view: CanvasView
}

/**
 * 双指两态决策（纯）：base 样本 + base 视口 → current 样本的下一视口。
 * 公式：scale' = clamp(base.scale × span'/span)；base 质心下的图像点钉在 current 质心。
 * span 不变（factor=1）时为质心平移；mid 不变时为以质心为锚的纯缩放。
 * 退化输入（span=0 / scale≤0）返回原视口（pan）。
 */
export function twoFingerDecision(
  base: TwoFingerSample,
  current: TwoFingerSample,
  baseView: CanvasView,
): TwoFingerDecision {
  if (!(baseView.scale > 0)) return { intent: 'pan', view: { ...baseView } }
  const spanBase = touchSpan(base)
  const factor = spanBase > 0 ? touchSpan(current) / spanBase : 1
  const scale = clampZoomScale(baseView.scale * factor)
  const midBase = touchMidpoint(base)
  const midCur = touchMidpoint(current)
  const view: CanvasView = {
    scale,
    x: midCur.x - ((midBase.x - baseView.x) / baseView.scale) * scale,
    y: midCur.y - ((midBase.y - baseView.y) / baseView.scale) * scale,
  }
  return { intent: Math.abs(factor - 1) >= PINCH_ZOOM_RATIO_EPS ? 'zoom' : 'pan', view }
}
