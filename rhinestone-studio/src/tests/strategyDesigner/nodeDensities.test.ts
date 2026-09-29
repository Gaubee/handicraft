import { describe, expect, it } from 'vitest'
import { StrategyGemsViewSchema } from '$lib/strategyDesigner/artifacts.js'

/** 波5走查 P1-3 回归：服务端产出的 nodeDensities 三元组不再被 strict 拒收。 */
describe('StrategyGemsView nodeDensities（走查 P1-3）', () => {
  const base = {
    kind: 'strategy-gems',
    formatVersion: 1,
    planRef: 'a'.repeat(64),
    canvasCm: { w: 20, h: 20 },
    imagePx: { width: 736, height: 736 },
    gems: [],
    excludedRegions: [],
    warnings: [],
    createdAt: '2026-09-29T00:00:00Z',
  }

  it('含 nodeDensities 的产物通过（服务端 T3 形态）', () => {
    const out = StrategyGemsViewSchema.parse({
      ...base,
      nodeDensities: [{ nodeId: 'n1', densityPerCm2: 2.3, densityRatio: 0.115, baseDensityPerCm2: 20.05 }],
    })
    expect(out.nodeDensities?.[0]?.baseDensityPerCm2).toBe(20.05)
  })

  it('nodeDensities 缺席仍通过（optional 兼容旧产物）', () => {
    expect(StrategyGemsViewSchema.parse(base).nodeDensities).toBeUndefined()
  })
})
