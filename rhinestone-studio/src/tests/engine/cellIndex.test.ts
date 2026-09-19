/**
 * [gem-catalog engine gate 1.1] SpatialIndex cell 契约迁移（pitch → maxCellPx）：
 * - 恰跨 cell 边界的邻域对检索不漏（混合径：大钻-小钻对横跨 maxCellPx 网格的桶边界）；
 * - 性质测试：随机混合径点集，暴力法违规对（dist < requiredCenterDistancePx×0.999）与
 *   cell=maxCellPx 的 3×3 检索枚举零漏；
 * - 等径退化：maxCellPx = pitch（v1 行为零变化的 cell 等价证据）。
 */

import { describe, expect, it } from 'vitest'
import { maxCellPx, requiredCenterDistancePx, gridFromSpec, SS_TABLE } from '$lib/engine'
import { SpatialIndex } from '$lib/engine/ops'
import type { PairwiseSpec } from '$lib/engine'

const GAP = 0.4
const PPM = 2.5

function gridOf(diameterMm: number) {
  return gridFromSpec({ shapeId: 'round', sizeLabel: `${diameterMm}mm`, diameterMm }, GAP, PPM)
}

describe('maxCellPx cell 契约（tasks 1.1）', () => {
  it('等径退化：maxCellPx = pitch（v1 cell 等价）', () => {
    for (const ss of ['SS6', 'SS10', 'SS34'] as const) {
      const d = SS_TABLE[ss]
      const grid = gridOf(d)
      const cell = maxCellPx([{ diameterMm: d }, { diameterMm: d }], grid)
      expect(cell).toBe(grid.pitchMm * grid.pixelsPerMm)
    }
  })

  it('cell ≥ 清单内任意大小径对的所需距离（检索不漏前提）', () => {
    const grid = gridOf(SS_TABLE.SS6)
    const specs: PairwiseSpec[] = [
      { diameterMm: SS_TABLE.SS6 },
      { diameterMm: SS_TABLE.SS16 },
      { diameterMm: SS_TABLE.SS34 },
    ]
    const cell = maxCellPx(specs, grid)
    for (const a of specs) {
      for (const b of specs) {
        expect(cell).toBeGreaterThanOrEqual(requiredCenterDistancePx(a, b, grid))
      }
    }
  })
})

describe('恰跨 cell 边界邻域检索不漏（混合径）', () => {
  it('大钻-小钻对横跨 maxCellPx 桶边界：3×3 检索必命中', () => {
    const small = { diameterMm: SS_TABLE.SS6 } // 2.0mm
    const big = { diameterMm: SS_TABLE.SS34 } // 7.1mm
    const grid = gridOf(SS_TABLE.SS6)
    const cell = maxCellPx([small, big], grid)
    const required = requiredCenterDistancePx(small, big, grid)
    expect(cell).toBeGreaterThan(required * 0.999) // cell 契约前提

    // 构造恰跨桶边界的违规对：把小钻放在桶边界内侧、大钻放在边界外侧、距离 < required。
    // 扫描多条边界线（x/y 向、不同桶索引），确保至少一对"跨桶且违规"被检索命中。
    let crossCellHits = 0
    let attempts = 0
    for (let boundary = 1; boundary <= 40; boundary += 1) {
      for (const axis of ['x', 'y'] as const) {
        for (const side of [-1, 1] as const) {
          const b = boundary * cell // 桶边界（cell 整数倍处）
          // 小钻贴边界内侧 ε，大钻沿同轴在边界外侧 required*0.9 处（跨桶 + 违规）
          const eps = 0.01
          const smallPt = axis === 'x' ? { x: b - eps, y: 50 } : { x: 50, y: b - eps }
          const bigOffset = side * required * 0.9
          const bigPt =
            axis === 'x'
              ? { x: b - eps + bigOffset, y: 50 }
              : { x: 50, y: b - eps + bigOffset }
          const dist = Math.hypot(bigPt.x - smallPt.x, bigPt.y - smallPt.y)
          if (dist >= required * 0.999) continue
          // 跨桶判定：两点必须落在不同桶（检索必须跨桶才能命中——真正检验 3×3 邻域）
          const cellOf = (p: { x: number; y: number }) =>
            `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`
          if (cellOf(smallPt) === cellOf(bigPt)) continue
          attempts += 1

          const index = new SpatialIndex<{ i: number; x: number; y: number }>(cell)
          index.insert(smallPt.x, smallPt.y, { i: 0, ...smallPt })
          index.insert(bigPt.x, bigPt.y, { i: 1, ...bigPt })
          const nearFromSmall = index.query(smallPt.x, smallPt.y).map((it) => it.i)
          const nearFromBig = index.query(bigPt.x, bigPt.y).map((it) => it.i)
          expect(nearFromSmall, `小钻 @${JSON.stringify(smallPt)} 应检索到跨桶大钻`).toContain(1)
          expect(nearFromBig, `大钻 @${JSON.stringify(bigPt)} 应检索到跨桶小钻`).toContain(0)
          crossCellHits += 1
        }
      }
    }
    // 场景确实覆盖了跨桶违规对（防构造退化为空集）
    expect(attempts).toBeGreaterThan(0)
    expect(crossCellHits).toBe(attempts)
  })

  it('性质测试：随机混合径点集，暴力违规对与 cell=maxCellPx 检索枚举零漏（含恰在桶边界）', () => {
    // 确定性伪随机（mulberry32 简化版）
    let seed = 42
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let trial = 0; trial < 30; trial += 1) {
      const grid = gridOf(2.0)
      const n = 40 + ((trial * 13) % 60)
      const diameters = Array.from({ length: n }, () => 1.5 + rand() * 6)
      const specs: PairwiseSpec[] = diameters.map((d) => ({ diameterMm: d }))
      const cell = maxCellPx(specs, grid)
      const pts = Array.from({ length: n }, () => ({
        // 部分点故意贴桶边界（×cell 整数倍 ± ε）：恰跨边界的对更易漏
        x: (rand() < 0.25 ? Math.round(rand() * 12) * cell : rand() * 400) + (rand() - 0.5) * 0.02,
        y: (rand() < 0.25 ? Math.round(rand() * 12) * cell : rand() * 400) + (rand() - 0.5) * 0.02,
      }))

      // 暴力法：全部违规对
      const brute: Array<[number, number]> = []
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const required = requiredCenterDistancePx(specs[i], specs[j], grid) * 0.999
          const dx = pts[j].x - pts[i].x
          const dy = pts[j].y - pts[i].y
          if (dx * dx + dy * dy < required * required) brute.push([i, j])
        }
      }

      // 索引法：cell=maxCellPx，i 的 3×3 检索应包含全部 j>i 的违规对
      const index = new SpatialIndex<number>(cell)
      pts.forEach((p, i) => index.insert(p.x, p.y, i))
      const found: Array<[number, number]> = []
      for (let i = 0; i < n; i++) {
        for (const j of index.query(pts[i].x, pts[i].y)) {
          if (j <= i) continue
          const required = requiredCenterDistancePx(specs[i], specs[j], grid) * 0.999
          const dx = pts[j].x - pts[i].x
          const dy = pts[j].y - pts[i].y
          if (dx * dx + dy * dy < required * required) found.push([i, j])
        }
      }

      const key = (p: [number, number]) => p[0] * 1e6 + p[1]
      found.sort((a, b) => key(a) - key(b))
      brute.sort((a, b) => key(a) - key(b))
      expect(found, `trial ${trial}：索引枚举应零漏且不重`).toEqual(brute)
    }
  })
})
