/*
 * [2026-09-19 Test] tasks 2.2：空间索引与暴力法对账（随机点集）——grid-hash 的正确性
 * 不靠实现自信，靠 O(n²) 暴力枚举逐查询核对（圆/矩形/边界/负坐标/增删改）。
 */

import { describe, expect, it } from 'vitest'
import { SpatialIndex, buildSpatialIndex, type IndexedItem } from '$lib/edit/spatialIndex'

/** 确定性 PRNG（mulberry32）：随机点集可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Pt extends IndexedItem {
  vx: number
  vy: number
}

function randomPoints(count: number, seed = 42, span = 500, allowNegative = true): Pt[] {
  const rnd = mulberry32(seed)
  return Array.from({ length: count }, (_, i) => {
    const x = rnd() * span * (allowNegative ? 2 : 1) - (allowNegative ? span / 2 : 0)
    const y = rnd() * span * (allowNegative ? 2 : 1) - (allowNegative ? span / 2 : 0)
    return { id: `p${i}`, x, y, vx: x, vy: y }
  })
}

const byId = (a: IndexedItem, b: IndexedItem): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function expectSameAsBrute(index: SpatialIndex<Pt>, points: Pt[]): void {
  const rnd = mulberry32(7)
  // 圆查询对账（含 r=0 边界：恰在点位上才命中）
  for (let q = 0; q < 300; q++) {
    const x = rnd() * 1000 - 500
    const y = rnd() * 1000 - 500
    const r = [0, 1, 8, 40, 150][Math.floor(rnd() * 5)]
    const got = [...index.queryCircle(x, y, r)].sort(byId)
    const brute = points
      .filter((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) <= r * r)
      .sort(byId)
    expect(got.map((g) => g.id), `queryCircle(${x.toFixed(1)},${y.toFixed(1)},r=${r})`).toEqual(brute.map((b) => b.id))
  }
  // 矩形查询对账（含颠倒输入与零宽）
  for (let q = 0; q < 300; q++) {
    const x0 = rnd() * 800 - 400
    const y0 = rnd() * 800 - 400
    const x1 = x0 + (rnd() * 300 - 100)
    const y1 = y0 + (rnd() * 300 - 100)
    const got = [...index.queryRect(x0, y0, x1, y1)].sort(byId)
    const loX = Math.min(x0, x1)
    const hiX = Math.max(x0, x1)
    const loY = Math.min(y0, y1)
    const hiY = Math.max(y0, y1)
    const brute = points.filter((p) => p.x >= loX && p.x <= hiX && p.y >= loY && p.y <= hiY).sort(byId)
    expect(got.map((g) => g.id), `queryRect(${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)})`).toEqual(
      brute.map((b) => b.id),
    )
  }
}

describe('SpatialIndex · 暴力法对账（随机点集）', () => {
  it('cell=pitch：500 随机点（含负坐标）的圆/矩形查询与 O(n²) 一致', () => {
    const points = randomPoints(500)
    const index = buildSpatialIndex(points, 8)
    expect(index.size).toBe(500)
    expectSameAsBrute(index, points)
  })

  it('cell=1（逐点成桶）与 cell=512（巨桶退化为暴力）两端仍一致', () => {
    for (const cell of [1, 512]) {
      const points = randomPoints(120, cell)
      const index = buildSpatialIndex(points, cell)
      expectSameAsBrute(index, points)
    }
  })

  it('点位恰在桶边界（x/cell 为整数）不丢不重', () => {
    const points: Pt[] = Array.from({ length: 64 }, (_, i) => ({
      id: `b${i}`,
      x: (i % 8) * 8,
      y: Math.floor(i / 8) * 8,
      vx: 0,
      vy: 0,
    }))
    const index = buildSpatialIndex(points, 8)
    expectSameAsBrute(index, points)
  })
})

describe('SpatialIndex · 增删改', () => {
  it('remove 后查询不再命中；size 正确增减', () => {
    const points = randomPoints(60, 9)
    const index = buildSpatialIndex(points, 8)
    const victim = points[3]
    expect(index.remove(victim.id)).toBe(victim)
    expect(index.size).toBe(59)
    expect(index.has(victim.id)).toBe(false)
    expect(index.queryCircle(victim.x, victim.y, 0.001)).toHaveLength(0)
    expect(index.remove('不存在')).toBeUndefined()
  })

  it('同 id 重复 insert = 替换（移动落位），旧桶不再命中', () => {
    const index = new SpatialIndex<Pt>(8)
    const p: Pt = { id: 'p1', x: 0, y: 0, vx: 0, vy: 0 }
    index.insert(p)
    index.insert({ ...p, x: 100, y: 100 })
    expect(index.size).toBe(1)
    expect(index.queryCircle(0, 0, 1)).toHaveLength(0)
    expect(index.queryCircle(100, 100, 1).map((it) => it.id)).toEqual(['p1'])
  })

  it('get(id) 返回当前落位项；clear 清空', () => {
    const points = randomPoints(10, 3)
    const index = buildSpatialIndex(points, 8)
    expect(index.get(points[7].id)?.x).toBeCloseTo(points[7].x, 10)
    // 巨型包围盒（非空索引）：走已占桶枚举路径，瞬时返回全部
    const giant = index.queryRect(-1e6, -1e6, 1e6, 1e6).sort(byId)
    expect(giant.map((g) => g.id)).toEqual(points.map((p) => p.id).sort())
    index.clear()
    expect(index.size).toBe(0)
    expect(index.queryRect(-1e6, -1e6, 1e6, 1e6)).toHaveLength(0)
  })

  it('cellSize 非正/非有限数直接抛错（契约门）', () => {
    expect(() => new SpatialIndex<IndexedItem>(0)).toThrow()
    expect(() => new SpatialIndex<IndexedItem>(-8)).toThrow()
    expect(() => new SpatialIndex<IndexedItem>(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => new SpatialIndex<IndexedItem>(Number.NaN)).toThrow()
  })
})
