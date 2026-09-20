/*
[2026-09-18 Test] tasks 4.x 管线集成（jsdom 无 canvas 解码，EngineImage 直灌模拟 handoff image）：
载入 → segment → 五策略 layout → validate 全部 isExportable；BOM 对账；确定性重放；松弛开关重算。
*/

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STRATEGY_IDS, isExportable, validate, type StrategyId } from '$lib/engine'
import {
  dispatchLayerConfigOp,
  getActiveResult,
  getLayers,
  getBomSummary,
  getBlocks,
  getDensitySpec,
  getEffectiveBlocks,
  getExportCheck,
  getGrid,
  loadFromEngineImage,
  recompute,
  resetStudioForTests,
  setBlockDensity,
  setEnabled,
  setRelax,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'


/** [2.7 层化口径] 旧 setActiveStrategy 兼容面废除——测试经 layer.config op 直调锚点层。 */
function switchAnchor(sid: StrategyId): void {
  const layers = getLayers()
  const anchor = layers.find((l) => l.blockIds === 'rest') ?? layers[0]
  if (!anchor || anchor.strategy === sid) return
  dispatchLayerConfigOp([anchor.id], { strategy: sid }, undefined, { immediate: true })
}

beforeAll(async () => {
  resetStudioForTests()
  // 来源标记 handoff：等价于实验室「送排钻」图在解码后的像素形态
  loadFromEngineImage(fixtureShapes(), 'fixture-shapes.png', 'handoff')
  await waitForStudioIdle()
})

afterAll(() => {
  resetStudioForTests()
})

describe('排钻工作台管线集成（handoff image → segment → 五策略 → validate）', () => {
  it('分块产出 ≥3 块且带全量属性', () => {
    const blocks = getBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    for (const b of blocks) {
      expect(b.mask.bits.length).toBe(b.bbox.w * b.bbox.h)
      expect(b.areaPx).toBeGreaterThan(0)
      expect(['fill', 'linear', 'element']).toContain(b.suggested)
    }
  })

  // [2026-09-20 studio-layers 2.3 层化口径] 五策略并行缓存退役——逐策略切换锚点层配置后重算
  // （切策略 = 该层重算，Owner 授权退役面差异；逐位等价由 computeLayer.test 活路径锁定守卫）
  it.each(STRATEGY_IDS)('%s：切换锚点层策略后结果就绪且联合门可导出', async (sid) => {
    switchAnchor(sid)
    await waitForStudioIdle()
    const res = getActiveResult()
    expect(res).not.toBeNull()
    expect(res?.error).toBeUndefined()
    expect(res?.gems.length).toBeGreaterThan(0)
    expect(res?.spacingCount).toBe(0)
    expect(getExportCheck().exportable).toBe(true)
    // 块级密度缺省语义：全 1.0 时 Record 为空
    expect(Object.keys(getDensitySpec())).toHaveLength(0)
    // N4：消解丢弃计数随结果透传（hex-thin/hex-pitch/cvt 默认零丢弃）
    expect(typeof res?.dropped).toBe('number')
    expect(res?.dropped).toBeGreaterThanOrEqual(0)
  })

  it('导出门：联合 exportGate（全层 concat 统一 pairwise）通过且可导出', () => {
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
    const snapshot = (getActiveResult()?.gems ?? []).map((g) => `${g.id}|${g.x}|${g.y}|${g.blockId}`)
    expect(snapshot.length).toBeGreaterThan(0)
    recompute()
    await waitForStudioIdle()
    const replay = (getActiveResult()?.gems ?? []).map((g) => `${g.id}|${g.x}|${g.y}|${g.blockId}`)
    expect(replay).toEqual(snapshot)
  })

  it('块密度与启用变更 → 防抖重算后钻数变化', async () => {
    switchAnchor('hybrid')
    await waitForStudioIdle()
    const before = getActiveResult()?.gems.length ?? 0
    const victim = getBlocks()[0]
    setBlockDensity(victim.id, 0.3)
    await waitForStudioIdle()
    const thinned = getActiveResult()?.gems.length ?? 0
    expect(thinned).toBeLessThanOrEqual(before)

    setEnabled(victim.id, false)
    await waitForStudioIdle()
    const without = getActiveResult()?.gems.length ?? 0
    expect(without).toBeLessThanOrEqual(thinned)
    expect((getActiveResult()?.gems ?? []).every((g) => g.blockId !== victim.id)).toBe(true)
  })

  it('松弛开关作用于锚点层且不变量保持', async () => {
    setRelax({ boundary: true, repulsion: true })
    await waitForStudioIdle()
    for (const sid of STRATEGY_IDS) {
      switchAnchor(sid)
      await waitForStudioIdle()
      const res = getActiveResult()
      expect(res?.error, `${sid} 不应失败`).toBeUndefined()
      expect(res?.spacingCount, `${sid} 松弛后不应有 spacing 违规`).toBe(0)
      const warnings = validate(res?.gems ?? [], getGrid(), getEffectiveBlocks())
      expect(isExportable(warnings), `${sid} 松弛后仍可导出`).toBe(true)
    }
    setRelax({ boundary: false, repulsion: false })
    await waitForStudioIdle()
  })
})
