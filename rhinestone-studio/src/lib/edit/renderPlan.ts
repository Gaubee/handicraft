/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-19 Perf] 四层合成的纯绘制计划（design.md §2）：视口裁剪 + LOD 两档 + draw 调用计数。
 *    EditCanvas 与 vitest 基准共用同一代码路径——jsdom 无真渲染，基准量化数据结构与
 *    draw 调用路径（真实帧率留浏览器走查）。
 * 2. [2026-09-19 Pure] 纯 TS 零 runes/DOM，输入输出皆普通对象。
 */

import { findPaletteColor, type EditGem, type Palette } from '$lib/engine'

/** 图像坐标系的可见矩形（闭区间；viewportFromView 由画布视口逆变换） */
export interface ViewportRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** LOD 阈值：钻的屏幕直径 ≥ 该像素才走圆+描边精细档，低于则聚合为色块点 */
export const LOD_DETAILED_SCREEN_PX = 6

/** 精细档：画圆 + 描边（hex 主体色） */
export interface CircleDrawOp {
  kind: 'circle'
  x: number
  y: number
  r: number
  color: string
}

/** 聚合档：色块方点（无描边，无 arc 路径） */
export interface RectDrawOp {
  kind: 'rect'
  x: number
  y: number
  s: number
  color: string
}

export type GemDrawOp = CircleDrawOp | RectDrawOp

/** 画布视口（scale/x/y，CSS px）→ 图像坐标可见矩形 */
export function viewportFromView(
  view: { scale: number; x: number; y: number },
  canvasW: number,
  canvasH: number,
): ViewportRect {
  const inv = 1 / (view.scale > 0 ? view.scale : 1)
  return {
    x0: -view.x * inv,
    y0: -view.y * inv,
    x1: (canvasW - view.x) * inv,
    y1: (canvasH - view.y) * inv,
  }
}

/** LOD 判定：钻直径 × 缩放 ≥ 阈值像素 → 精细档 */
export function isDetailedLod(gemDiameterPx: number, scale: number): boolean {
  return gemDiameterPx * scale >= LOD_DETAILED_SCREEN_PX
}

export interface PlanOptions {
  /** 钻半径（图像 px） */
  gemRadius: number
  /** 精细档（圆+描边）或聚合档（色块点） */
  detailed: boolean
  /** 色板色查找失败时的占位色 */
  fallbackColor?: string
}

/** 批量生成钻面绘制操作（已裁剪的钻集 → draw 调用序列；1 钻 = 1 次调用）。 */
export function planGemDraws(gems: readonly EditGem[], palette: Palette, options: PlanOptions): GemDrawOp[] {
  const fallback = options.fallbackColor ?? '#9CA3AF'
  const ops: GemDrawOp[] = []
  for (const g of gems) {
    const color = findPaletteColor(palette, g.colorId)?.hex ?? fallback
    if (options.detailed) {
      ops.push({ kind: 'circle', x: g.x, y: g.y, r: options.gemRadius, color })
    } else {
      const s = options.gemRadius * 2
      ops.push({ kind: 'rect', x: g.x - options.gemRadius, y: g.y - options.gemRadius, s, color })
    }
  }
  return ops
}

/** 四层合成的 draw 调用总数：缓存底图 drawImage（painting/reference/blocks 至多 3）+ 钻面 N + 选中环。 */
export function countCompositeDrawCalls(baseImageLayers: number, gemOps: number, selectionRings: number): number {
  return baseImageLayers + gemOps + selectionRings
}
