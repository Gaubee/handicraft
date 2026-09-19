/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.2 rename-and-expert-workbench] 框选（marquee）相交命中：钻圆与矩形
 *    相交即入选（中心在内或圆边触矩形），查询走编辑器私有空间索引（queryRect 外扩半径
 *    取候选，再逐钻圆-矩形相交精筛）——1 万钻基线内（C 3.6 性能抽查消费）。
 * 2. [2026-09-20 Pure] 纯 TS——命中语义可脱离 DOM 直接 vitest 对账。
 */

import type { SpatialIndex } from '$lib/edit/spatialIndex'
import type { IndexedItem } from '$lib/edit/spatialIndex'

/** 框选矩形（图像坐标系；x0/x1、y0/y1 任意次序——自动归一）。 */
export interface MarqueeRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 钻圆与矩形相交（中心点在内，或圆边触及矩形边界）。 */
export function gemIntersectsRect(
  gem: IndexedItem,
  radius: number,
  rect: MarqueeRect,
): boolean {
  const loX = Math.min(rect.x0, rect.x1)
  const hiX = Math.max(rect.x0, rect.x1)
  const loY = Math.min(rect.y0, rect.y1)
  const hiY = Math.max(rect.y0, rect.y1)
  const cx = Math.min(Math.max(gem.x, loX), hiX)
  const cy = Math.min(Math.max(gem.y, loY), hiY)
  const dx = gem.x - cx
  const dy = gem.y - cy
  return dx * dx + dy * dy <= radius * radius
}

/** 框选命中收集：外扩 radius 取候选 → 圆-矩形相交精筛。返回顺序不定（调用方按集合消费）。 */
export function collectMarqueeItems<T extends IndexedItem>(
  index: SpatialIndex<T>,
  rect: MarqueeRect,
  radius: number,
): T[] {
  const loX = Math.min(rect.x0, rect.x1)
  const hiX = Math.max(rect.x0, rect.x1)
  const loY = Math.min(rect.y0, rect.y1)
  const hiY = Math.max(rect.y0, rect.y1)
  const candidates = index.queryRect(loX - radius, loY - radius, hiX + radius, hiY + radius)
  return candidates.filter((gem) => gemIntersectsRect(gem, radius, rect))
}
