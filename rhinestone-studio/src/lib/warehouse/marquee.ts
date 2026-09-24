/*
 * 框选（marquee）命中数学（add-stone-library S7.4——design §7.6）。
 * 原始需求 2026-09-24（Owner 定调五）：「他可以用框选或者是点选的方式进行选择」
 * ——框选命中计算必须纯函数可测：矩形∩cell bbox，任意方向拖拽（负向 delta）、
 * 边界接触、缩放视口（CSS transform scale 下指针位移÷scale 才是内容位移）。
 * 坐标系：**内容坐标**（= 指针 clientXY − 容器 rect 原点 + scroll 偏移）；
 * 段内命中再减段网格顶（layout.ts gridTop）——本文件的矩形运算与坐标系无关。
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 归一化拖拽矩形（任意方向：向左上/右下/左下/右上拖均产出正宽高）。
 * 零面积（点击未拖动）→ w/h 为 0 的退化矩形（命中=仅边界接触的 cell）。
 */
export function normalizeRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  }
}

/**
 * 指针拖拽 → 内容坐标矩形（缩放视口：容器被 CSS transform scale 放缩时，
 * 指针位移须 ÷scale 才等于内容位移；scale 缺省 1=无缩放）。
 */
export function marqueeRectFromPointer(
  start: Point,
  end: Point,
  scale = 1,
): Rect {
  if (!(scale > 0)) scale = 1
  return normalizeRect(
    { x: start.x / scale, y: start.y / scale },
    { x: end.x / scale, y: end.y / scale },
  )
}

/**
 * 矩形相交（闭区间：边界接触算命中——与视觉一致，marquee 掠过 cell 边即选中）。
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w &&
    b.x <= a.x + a.w &&
    a.y <= b.y + b.h &&
    b.y <= a.y + a.h
  )
}

/** 平铺网格单元几何入参（virtual.ts 的 VirtualGridGeometry 直通——不重复定义）。 */
export interface MarqueeGridGeometry {
  columns: number
  rows: number
  columnWidth: number
  startRow: number
  endRowExclusive: number
}

export interface MarqueeGridMetrics {
  cellH: number
  gap: number
  padding: number
}

/** 段内 cell bbox（网格局部坐标：x=pad+col 步进，y=row 步进——窗口无关稳定式）。 */
export function cellBoxInGrid(index: number, geometry: MarqueeGridGeometry, metrics: MarqueeGridMetrics): Rect {
  const col = index % geometry.columns
  const row = Math.floor(index / geometry.columns)
  return {
    x: metrics.padding + col * (geometry.columnWidth + metrics.gap),
    y: row * (metrics.cellH + metrics.gap),
    w: geometry.columnWidth,
    h: metrics.cellH,
  }
}

/**
 * 框选命中索引（段内）：marquee 矩形 ∩ cell bbox。
 * rect 为**网格局部**坐标（内容矩形 y 已减 gridTop）；只扫矩形 y 跨度覆盖的行
 * （大样卡不必全量遍历）；命中含边界接触（rectsIntersect 闭区间）。
 */
export function marqueeHitIndices(
  rect: Rect,
  geometry: MarqueeGridGeometry,
  itemCount: number,
  metrics: MarqueeGridMetrics,
): number[] {
  if (itemCount <= 0 || geometry.columns <= 0) return []
  const stride = metrics.cellH + metrics.gap
  const firstRow = Math.max(0, Math.floor(rect.y / stride))
  const lastRow = Math.min(geometry.rows - 1, Math.ceil((rect.y + rect.h) / stride))
  const hits: number[] = []
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = 0; col < geometry.columns; col += 1) {
      const index = row * geometry.columns + col
      if (index >= itemCount) break
      if (rectsIntersect(rect, cellBoxInGrid(index, geometry, metrics))) hits.push(index)
    }
  }
  return hits
}
