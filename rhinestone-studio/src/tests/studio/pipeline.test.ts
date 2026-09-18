/*
[2026-09-18 Test] tasks 4.x 管线集成（jsdom 无 canvas 解码，EngineImage 直灌模拟 handoff image）：
载入 → segment → 五策略 layout → validate 全部 isExportable；BOM 对账；确定性重放；松弛开关重算。
*/

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STRATEGY_IDS, isExportable, validate } from '$lib/engine'
import {
  getActiveResult,
  getBomSummary,
  getBlocks,
  getDensitySpec,
  getEffectiveBlocks,
  getExportCheck,
  getGrid,
  getResults,
  loadFromEngineImage,
  recompute,
  resetStudioForTests,
  setBlockDensity,
  setEnabled,
  setRelax,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'

beforeAll(async () => {
  resetStudioForTests()
  // 来源标记 handoff：等价于实验室「送转化」图在解码后的像素形态
  loadFromEngineImage(fixtureShapes(), 'fixture-shapes.png', 'handoff')
  await waitForStudioIdle()
})

afterAll(() => {
  resetStudioForTests()
})

describe('工作台管线集成（handoff image → segment → 五策略 → validate）', () => {
  it('分块产出 ≥3 块且带全量属性', () => {
    const blocks = getBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    for (const b of blocks) {
      expect(b.mask.bits.length).toBe(b.bbox.w * b.bbox.h)
      expect(b.areaPx).toBeGreaterThan(0)
      expect(['fill', 'linear', 'element']).toContain(b.suggested)
    }
  })

  it.each(STRATEGY_IDS)('%s：结果就绪且 isExportable', (sid) => {
    const res = getResults()[sid]
    expect(res).not.toBeNull()
    expect(res?.error).toBeUndefined()
    expect(res?.gems.length).toBeGreaterThan(0)
    expect(res?.spacingCount).toBe(0)
    expect(isExportable(res?.warnings ?? [])).toBe(true)
    // 块级密度缺省语义：全 1.0 时 Record 为空
    expect(Object.keys(getDensitySpec())).toHaveLength(0)
    // N4：消解丢弃计数随结果透传（hex-thin/hex-pitch/cvt 默认零丢弃）
    expect(typeof res?.dropped).toBe('number')
    expect(res?.dropped).toBeGreaterThanOrEqual(0)
  })

  it('导出门：activeStrategy 重跑 validate 通过且可导出', () => {
    const check = getExportCheck()
    expect(check.ready).toBe(true)
    expect(check.exportable).toBe(true)
    expect(check.warnings.filter((w) => w.kind === 'spacing')).toEqual([])
  })

  it('BOM 对账：摘要合计 = 当前 Gem 总数', () => {
    const res = getActiveResult()
    expect(res).not.toBeNull()
    const total = getBomSummary().reduce((sum, e) => sum + e.count, 0)
    expect(total).toBe(res?.gems.length)
    // BOM 条目均为已映射色板色
    expect(getBomSummary().every((e) => e.id !== '')).toBe(true)
  })

  it('确定性重放：同参数重算逐位一致', async () => {
    const snapshot = (getResults().hybrid?.gems ?? []).map((g) => `${g.id}|${g.x}|${g.y}|${g.blockId}`)
    expect(snapshot.length).toBeGreaterThan(0)
    recompute()
    await waitForStudioIdle()
    const replay = (getResults().hybrid?.gems ?? []).map((g) => `${g.id}|${g.x}|${g.y}|${g.blockId}`)
    expect(replay).toEqual(snapshot)
  })

  it('块密度与启用变更 → 防抖重算后钻数变化', async () => {
    const before = getResults().hybrid?.gems.length ?? 0
    const victim = getBlocks()[0]
    setBlockDensity(victim.id, 0.3)
    await waitForStudioIdle()
    const thinned = getResults().hybrid?.gems.length ?? 0
    expect(thinned).toBeLessThanOrEqual(before)

    setEnabled(victim.id, false)
    await waitForStudioIdle()
    const without = getResults().hybrid?.gems.length ?? 0
    expect(without).toBeLessThanOrEqual(thinned)
    expect((getResults().hybrid?.gems ?? []).every((g) => g.blockId !== victim.id)).toBe(true)
  })

  it('松弛开关作用于全部策略且不变量保持', async () => {
    setRelax({ boundary: true, repulsion: true })
    await waitForStudioIdle()
    for (const sid of STRATEGY_IDS) {
      const res = getResults()[sid]
      expect(res?.error, `${sid} 不应失败`).toBeUndefined()
      expect(res?.spacingCount, `${sid} 松弛后不应有 spacing 违规`).toBe(0)
      const warnings = validate(res?.gems ?? [], getGrid(), getEffectiveBlocks())
      expect(isExportable(warnings), `${sid} 松弛后仍可导出`).toBe(true)
    }
    setRelax({ boundary: false, repulsion: false })
    await waitForStudioIdle()
  })
})
