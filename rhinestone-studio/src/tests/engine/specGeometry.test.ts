/**
 * 唯一几何 helper 契约（gem-catalog W0 0.2，design §1.2 / R2 §三-1 定案签名）：
 * - requiredCenterDistancePx(a, b, grid) 三参唯一：等径=pitch 等价 / 大小径包络 / 对称性 /
 *   rotationDeg 圆包络不变性 / gap 单一来源（Δgap × pixelsPerMm 线性）
 * - maxCellPx(specs, grid)：≥ 清单内任意对所需距离（3×3 邻域检索不漏前提）/ 空清单 0
 * - 全库唯一调用面断言：定义只存在于 engine/geometry.ts（二参/别名并存 = 契约破坏）
 * 纯函数测试。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SS_TABLE,
  gridFromSpec,
  maxCellPx,
  pitchPx,
  requiredCenterDistancePx,
  type GemSpecSnapshot,
} from '$lib/engine'

const specOf = (specKey: string, diameterMm: number, ordinal = 1, rotationDeg?: number): GemSpecSnapshot => ({
  specKey,
  ordinal,
  shapeId: 'round',
  sizeLabel: `${diameterMm}mm`,
  diameterMm,
  ...(rotationDeg !== undefined ? { rotationDeg } : {}),
})

const SS10 = specOf('round-ss10', SS_TABLE.SS10)
const SS16 = specOf('round-ss16', SS_TABLE.SS16, 2)
const SS34 = specOf('round-ss34', SS_TABLE.SS34, 3)
const GAP = 0.4
const PPM = 2.5

describe('requiredCenterDistancePx 契约（W0 0.2）', () => {
  it('等径 = pitch 等价：同径对所需距离 === grid.pitchMm × pixelsPerMm（v1 单一 pitch 判据的退化）', () => {
    const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, GAP, PPM)
    expect(requiredCenterDistancePx(SS10, SS10, grid)).toBe(pitchPx(grid))
    expect(requiredCenterDistancePx(SS10, SS10, grid)).toBeCloseTo((SS_TABLE.SS10 + GAP) * PPM, 12)
  })

  it('大小径包络：判据由两钻径共同决定（(dᵢ+dⱼ)/2 + gap），且对称', () => {
    const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, GAP, PPM)
    const expected = ((SS_TABLE.SS10 + SS_TABLE.SS34) / 2 + GAP) * PPM
    expect(requiredCenterDistancePx(SS10, SS34, grid)).toBeCloseTo(expected, 12)
    expect(requiredCenterDistancePx(SS34, SS10, grid)).toBeCloseTo(expected, 12)
    // 与等径阈值的严格序：大小径混合判据大于小径等径判据、小于大径等径判据
    expect(requiredCenterDistancePx(SS10, SS34, grid)).toBeGreaterThan(requiredCenterDistancePx(SS10, SS10, grid))
    expect(requiredCenterDistancePx(SS10, SS34, grid)).toBeLessThan(requiredCenterDistancePx(SS34, SS34, grid))
  })

  it('rotationDeg 圆包络不变性：旋转不改包络判距（异形按最大径圆包络）', () => {
    const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, GAP, PPM)
    const rotated = specOf('round-ss10', SS_TABLE.SS10, 1, 37.5)
    expect(requiredCenterDistancePx(rotated, SS16, grid)).toBe(requiredCenterDistancePx(SS10, SS16, grid))
    expect(requiredCenterDistancePx(rotated, rotated, grid)).toBe(requiredCenterDistancePx(SS10, SS10, grid))
  })

  it('gap 单一来源：Δgap 对判距的增量恒为 Δgap × pixelsPerMm（mm→px 只发生在 helper 内）', () => {
    const base = { shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 } as const
    const g04 = gridFromSpec(base, 0.4, PPM)
    const g08 = gridFromSpec(base, 0.8, PPM)
    expect(requiredCenterDistancePx(SS10, SS34, g08) - requiredCenterDistancePx(SS10, SS34, g04)).toBeCloseTo(0.4 * PPM, 12)
    // pixelsPerMm 是唯一换算系数：判距随 ppm 线性
    const g5 = gridFromSpec(base, 0.4, 5)
    expect(requiredCenterDistancePx(SS10, SS34, g5)).toBeCloseTo(requiredCenterDistancePx(SS10, SS34, g04) * 2, 12)
  })
})

describe('maxCellPx 契约（W0 0.2）', () => {
  it('cell = (max(diameterMm) + gapMm) × pixelsPerMm ≥ 清单内任意对所需距离（3×3 邻域检索不漏）', () => {
    const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, GAP, PPM)
    const specs = [SS10, SS16, SS34]
    const cell = maxCellPx(specs, grid)
    expect(cell).toBeCloseTo((SS_TABLE.SS34 + GAP) * PPM, 12)
    for (const a of specs) {
      for (const b of specs) {
        expect(cell).toBeGreaterThanOrEqual(requiredCenterDistancePx(a, b, grid))
      }
    }
  })

  it('多组随机状清单的性质保持（max pair ≤ cell 恒成立）', () => {
    const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, 0.8, 2.5)
    for (let trial = 0; trial < 50; trial += 1) {
      const specs = Array.from({ length: 1 + (trial % 6) }, (_, i) => specOf(`s${i}`, 1 + ((trial * 7 + i * 13) % 60) / 10, i + 1))
      const cell = maxCellPx(specs, grid)
      for (const a of specs) {
        for (const b of specs) {
          expect(cell).toBeGreaterThanOrEqual(requiredCenterDistancePx(a, b, grid))
        }
      }
    }
  })

  it('空清单 = 0（无钻无 cell）；单条目 = (d + gap) × ppm', () => {
    const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, GAP, PPM)
    expect(maxCellPx([], grid)).toBe(0)
    expect(maxCellPx([SS16], grid)).toBeCloseTo((SS_TABLE.SS16 + GAP) * PPM, 12)
  })
})

// ---------------------------------------------------------------------------
// 全库唯一调用面断言（定义唯一；二参/别名并存 = 契约破坏）
// ---------------------------------------------------------------------------

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, out)
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('helper 唯一调用面（W0 0.2）', () => {
  it('requiredCenterDistancePx / maxCellPx 的 function 定义全库仅 engine/geometry.ts 一处', () => {
    const libRoot = resolve(process.cwd(), 'src/lib')
    const definers: string[] = []
    const aliasSuspects: string[] = []
    for (const file of collectSourceFiles(libRoot)) {
      const text = readFileSync(file, 'utf8')
      if (/function\s+requiredCenterDistancePx|function\s+maxCellPx|const\s+(requiredCenterDistancePx|maxCellPx)\s*=/.test(text)) {
        definers.push(file)
      }
      // 同义别名函数（centerDistance 类命名）不得另立
      if (/function\s+\w*[Cc]enterDistance\w*\s*\(/.test(text) && !text.includes('function requiredCenterDistancePx')) {
        aliasSuspects.push(file)
      }
    }
    expect(definers).toEqual([join(libRoot, 'engine/geometry.ts')])
    expect(aliasSuspects).toEqual([])
  })
})
