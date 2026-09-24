/*
 * 虚拟滚动几何单测（add-stone-library S3.3——design §7.6 性能护栏）：
 * 列数/行数/总高/窗口边界/overscan/夹紧/退化输入（0 视口、负 scrollTop、超尾滚动）。
 */

import { describe, expect, it } from 'vitest'
import {
  STONE_CELL_H,
  STONE_CELL_MIN_W,
  STONE_GRID_GAP,
  STONE_GRID_OVERSCAN_ROWS,
  STONE_GRID_PAD,
  virtualGridGeometry,
  virtualWindowIndices,
} from '$lib/stonesAdmin/virtual'

const BASE = {
  cellMinW: STONE_CELL_MIN_W,
  cellH: STONE_CELL_H,
  gap: STONE_GRID_GAP,
  padding: STONE_GRID_PAD,
  overscanRows: STONE_GRID_OVERSCAN_ROWS,
}

describe('virtualGridGeometry', () => {
  it('列数=容纳数（含 gap），列宽拉伸填满不小于最小宽', () => {
    const geo = virtualGridGeometry({ ...BASE, itemCount: 10, viewportW: 1000, viewportH: 600, scrollTop: 0 })
    // track=968, 单元 148 → floor(980/148)=6 列
    expect(geo.columns).toBe(6)
    expect(geo.columnWidth).toBeGreaterThanOrEqual(STONE_CELL_MIN_W)
    // 均分验证：columns*w + (columns-1)*gap ≤ track
    expect(geo.columns * geo.columnWidth + (geo.columns - 1) * STONE_GRID_GAP).toBeLessThanOrEqual(1000 - STONE_GRID_PAD * 2 + 0.001)
  })

  it('总高=行数×(单元高+gap)；窗口含 overscan 行', () => {
    const geo = virtualGridGeometry({ ...BASE, itemCount: 60, viewportW: 1000, viewportH: 500, scrollTop: 0 })
    expect(geo.rows).toBe(10)
    expect(geo.totalHeight).toBe(10 * (STONE_CELL_H + STONE_GRID_GAP))
    expect(geo.startRow).toBe(0)
    // 可见行=ceil(500/208)=3，首行 0，+overscan 3 → 6 行（0..6 不含）
    expect(geo.endRowExclusive).toBe(3 + STONE_GRID_OVERSCAN_ROWS)
  })

  it('滚动推进：startRow 跟随 scrollTop 并前移 overscan；padTop 与窗口对齐', () => {
    const geo = virtualGridGeometry({ ...BASE, itemCount: 600, viewportW: 1000, viewportH: 500, scrollTop: 208 * 20 })
    expect(geo.startRow).toBe(20 - STONE_GRID_OVERSCAN_ROWS)
    expect(geo.padTop).toBe(geo.startRow * (STONE_CELL_H + STONE_GRID_GAP))
  })

  it('夹紧：负 scrollTop 归 0；超尾滚动窗口封顶 rows', () => {
    const negative = virtualGridGeometry({ ...BASE, itemCount: 12, viewportW: 1000, viewportH: 500, scrollTop: -100 })
    expect(negative.startRow).toBe(0)
    const over = virtualGridGeometry({ ...BASE, itemCount: 12, viewportW: 1000, viewportH: 500, scrollTop: 100_000 })
    expect(over.endRowExclusive).toBe(over.rows)
    expect(over.startRow).toBeLessThan(over.rows)
  })

  it('退化输入：0/负 视口不产生 NaN——单列+overscan 窗口仍闭合', () => {
    const geo = virtualGridGeometry({ ...BASE, itemCount: 5, viewportW: 0, viewportH: 0, scrollTop: 0 })
    expect(geo.columns).toBe(1)
    expect(Number.isFinite(geo.totalHeight)).toBe(true)
    expect(geo.endRowExclusive).toBeGreaterThan(0)
    expect(geo.endRowExclusive).toBeLessThanOrEqual(geo.rows)
  })

  it('空集：rows=0，窗口为空但不越界', () => {
    const geo = virtualGridGeometry({ ...BASE, itemCount: 0, viewportW: 1000, viewportH: 500, scrollTop: 0 })
    expect(geo.rows).toBe(0)
    expect(geo.startRow).toBe(0)
    expect(geo.endRowExclusive).toBe(0)
    expect(virtualWindowIndices({ ...BASE, itemCount: 0, viewportW: 1000, viewportH: 500, scrollTop: 0 })).toEqual([])
  })

  it('窗口索引展开：行主序且不越 itemCount', () => {
    const params = { ...BASE, itemCount: 14, viewportW: 1000, viewportH: 500, scrollTop: 0 }
    const indices = virtualWindowIndices(params)
    expect(indices.length).toBeGreaterThan(0)
    expect(Math.max(...indices)).toBeLessThan(14)
    // 行主序：索引单调递增
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b))
  })
})
