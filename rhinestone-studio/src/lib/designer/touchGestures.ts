/*
 * touchGestures.ts——触摸手势映射决策核（design §1.4 移动端降级；spec「移动端降级」
 * Requirement：单指 = 工具行为、双指捏合缩放与拖动平移、长按 = 上下文菜单）。
 *
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 8.1] 手势→意图映射（纯函数）：单指分派
 *    singleTouchDispatch——select/draw/erase/zoom 交既有 pointer 工具管线（本模块不第二
 *    实现工具逻辑），hand = 平移（工具本体语义）；长按判定 longPressDecision——按住
 *    ≥ LONG_PRESS_MS 且累计位移 ≤ LONG_PRESS_SLOP_PX → 'context-menu'（消费方接既有
 *    DesignerContextMenu 两态树，与右键同源）。
 * 2. [双指两态] twoFingerDecision：span（指距）相对变化 ≥ 阈值 = 捏合缩放（zoom——
 *    因子 >1 放大 / <1 缩小，接 viewport 档位夹取 clampZoomScale 单源，与滚轮/工具/
 *    键盘同值域 [10%,1600%]）；span 不变而质心位移 = 双指拖动平移（pan）。视图合成：
 *    缩放锚 = 质心（base 质心下图像点钉在 current 质心屏幕位；factor=1 时退化为纯平移
 *    ——捏合与平移同一公式连续合成，两态是主导分型非互斥分支）。
 * 3. [Pure] 纯 TS 零 runes 声明/DOM——jsdom 直测决策核；真实双指与断点视觉归 9.2b/9.3
 *    真浏览器走查（design §8 走查义务）。
 */

import { clampZoomScale, type CanvasView } from './viewport.svelte'
import type { DesignerTool } from './workbench.svelte'

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

// ---------------------------------------------------------------------------
// 单指：当前工具行为分派（design §1.4「单指 = 当前工具行为」）
// ---------------------------------------------------------------------------

/** 单指分派结果：'tool' = 既有 pointer 工具管线（禁第二实现）；'pan' = 平移。 */
export type SingleTouchDispatch = { kind: 'tool' } | { kind: 'pan' }

/**
 * 单指分派决策（纯）：hand = 平移（抓手工具本体）；select/draw/erase/zoom = 工具行为
 * （select = 点选/框选/拖移、draw/erase = 起笔-收笔、zoom = 点击/拖框——全部走既有
 * 鼠标管线同源分派，触摸不再单独平移劫持 select）。
 */
export function singleTouchDispatch(tool: DesignerTool): SingleTouchDispatch {
  return tool === 'hand' ? { kind: 'pan' } : { kind: 'tool' }
}

// ---------------------------------------------------------------------------
// 长按：上下文菜单判定（design §1.4「长按 = 右键上下文菜单」）
// ---------------------------------------------------------------------------

/** 长按时长阈值（ms）。 */
export const LONG_PRESS_MS = 500
/** 长按累计位移容差（px）——按住期间指尖累计漂移超过即视为非长按。 */
export const LONG_PRESS_SLOP_PX = 8

/** 长按判定结果：'context-menu' = 触发菜单（接 DesignerContextMenu 两态树）；'pending' = 未成立。 */
export type LongPressDecision = 'context-menu' | 'pending'

/** 长按判定（纯）：时长 ≥ LONG_PRESS_MS 且累计位移 ≤ LONG_PRESS_SLOP_PX 才触发。 */
export function longPressDecision(heldMs: number, movedPx: number): LongPressDecision {
  if (!Number.isFinite(heldMs) || !Number.isFinite(movedPx)) return 'pending'
  return heldMs >= LONG_PRESS_MS && movedPx <= LONG_PRESS_SLOP_PX ? 'context-menu' : 'pending'
}

// ---------------------------------------------------------------------------
// 双指两态：捏合缩放 / 拖动平移（design §1.4）
// ---------------------------------------------------------------------------

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
 * 公式：scale' = clamp(base.scale × span'/span)；base 质心下的图像点钉在 current 质心：
 * x' = midCur.x − (midBase.x − base.x) / base.scale × scale'。
 * span 不变（factor=1）时 x'/y' 平移 = 质心位移（双指拖动 = 平移）；mid 不变时为以质心
 * 为锚的纯缩放（双指捏合 = 缩放）。退化输入（span=0 / scale≤0）返回原视口（pan）。
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
