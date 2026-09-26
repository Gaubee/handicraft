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
 * 2. [双指两态] twoFingerDecision 等**视口几何真源已上移 lib/canvaskit.ts**
 *    （[add-workbench-pro 2c §0 抽取]——designer 与 taskWorkbench 双消费单源：
 *    捏合缩放锚定公式与滚轮锚定缩放同式连续合成）；本模块 re-export 保持既有
 *    import 面零变化。
 * 3. [Pure] 纯 TS 零 runes 声明/DOM——jsdom 直测决策核；真实双指与断点视觉归 9.2b/9.3
 *    真浏览器走查（design §8 走查义务）。
 */

import type { DesignerTool } from './workbench.svelte'

// [2c §0 抽取] 双指两态真源 re-export（lib/canvaskit——单源双消费）。
export {
  PINCH_ZOOM_RATIO_EPS,
  touchSpan,
  touchMidpoint,
  twoFingerDecision,
} from '$lib/canvaskit.js'
export type { TouchPoint, TwoFingerSample, TwoFingerDecision } from '$lib/canvaskit.js'
export type { CanvasView } from '$lib/canvaskit.js'

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
