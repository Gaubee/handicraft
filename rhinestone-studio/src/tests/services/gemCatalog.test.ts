/*
 * [2026-09-20 S-4.1 Test] gemCatalogService mock（rename-and-expert-workbench tasks 4.1）：
 * 确定性（同源派生 ROUND_SS_BOOTSTRAP）、幂等（重复调用等值）、specKey 规则
 * 'round-ssXX' × SS_KEYS 十二档、未知 specKey → undefined、接口签名冻结（类型面）。
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import { ROUND_SS_BOOTSTRAP, SS_KEYS } from '$lib/engine'
import {
  createInMemoryGemCatalogService,
  type CatalogSpec,
  type GemCatalogService,
} from '$lib/services/gemCatalogService'

describe('gemCatalogService 内存 mock', () => {
  it('listSpecs：round × SS_KEYS 十二档，与 ROUND_SS_BOOTSTRAP 同源派生', async () => {
    const service = createInMemoryGemCatalogService()
    const specs = await service.listSpecs()
    expect(specs).toHaveLength(SS_KEYS.length)
    expect(specs.map((s) => s.specKey)).toEqual(ROUND_SS_BOOTSTRAP.map((r) => r.specKey))
    expect(specs.every((s) => s.shapeId === 'round')).toBe(true)
    for (let i = 0; i < specs.length; i++) {
      expect(specs[i].diameterMm).toBe(ROUND_SS_BOOTSTRAP[i].diameterMm)
      expect(specs[i].sizeLabel).toBe(ROUND_SS_BOOTSTRAP[i].ss)
    }
  })

  it('specKey 确定性规则：round-ssXX（小写 SS 键）', async () => {
    const service = createInMemoryGemCatalogService()
    const specs = await service.listSpecs()
    for (const ss of SS_KEYS) {
      expect(specs.map((s) => s.specKey)).toContain(`round-${ss.toLowerCase()}`)
    }
  })

  it('resolveSpec 幂等：重复解析等值；返回新对象（持有安全）', async () => {
    const service = createInMemoryGemCatalogService()
    const a = await service.resolveSpec('round-ss10')
    const b = await service.resolveSpec('round-ss10')
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    a!.diameterMm = 999 // 外部改动不渗入
    expect((await service.resolveSpec('round-ss10'))!.diameterMm).toBe(2.8)

    // listSpecs 返回亦为快照拷贝
    const list1 = await service.listSpecs()
    list1[0].specKey = 'polluted'
    expect((await service.listSpecs())[0].specKey).toBe('round-ss6')
  })

  it('未知 specKey → undefined', async () => {
    const service = createInMemoryGemCatalogService()
    expect(await service.resolveSpec('round-ss99')).toBeUndefined()
    expect(await service.resolveSpec('square-3.5')).toBeUndefined()
    expect(await service.resolveSpec('')).toBeUndefined()
  })

  it('接口签名冻结（类型面）：listSpecs/resolveSpec 形状', () => {
    expectTypeOf(createInMemoryGemCatalogService()).toExtend<GemCatalogService>()
    expectTypeOf<GemCatalogService['listSpecs']>().returns.toEqualTypeOf<Promise<CatalogSpec[]>>()
    expectTypeOf<GemCatalogService['resolveSpec']>().parameter(0).toEqualTypeOf<string>()
    expectTypeOf<GemCatalogService['resolveSpec']>()
      .returns.toEqualTypeOf<Promise<CatalogSpec | undefined>>()
  })
})
