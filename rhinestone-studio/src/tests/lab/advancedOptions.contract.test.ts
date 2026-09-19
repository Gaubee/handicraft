/**
 * 0.1 正交高级选项数据契约测试：类型编译（svelte-check/tsc 校验 expectTypeOf 与
 * 注释断言）+ validation 边界用例 + workflowMode 退役迁移口径（类型级）。
 *
 * 规范源：design §1.1（validation 裁决）/ §0.2-4（workflowMode 退役）/ §1.2（任务侧快照）。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BLUEPRINT_REFS_MAX,
  DRILL_SPEC_LIST_SOFT_LIMIT,
  GemtplAdvancedOptionError,
  GEMTPL_ADVANCED_OPTIONS_OFF,
  resolveGemtplAdvancedOptions,
  validateGemtplBlueprint,
  validateGemtplDrillParams,
  type GemtplAdvancedOptions,
  type GemtplBlueprint,
  type GemtplDrillParams,
  type LabTaskBlueprint,
  type LabTaskDrillParams,
} from '$lib/lab/advancedOptions'
import type { LabTaskBlueprint as StagesLabTaskBlueprint, LabTaskDrillParams as StagesLabTaskDrillParams } from '$lib/lab/stages'
import type { BlueprintToggle, DrillParamsConfig, GemgenFile, GemtplFile } from '$lib/persistence/labFile'
import type { PhysicalCanvas } from '$lib/engine'

const PHYSICAL: PhysicalCanvas = { widthMm: 210, heightMm: 148, anchorSource: 'declared' }

function drill(patch: Partial<GemtplDrillParams> = {}): GemtplDrillParams {
  return { enabled: true, specs: ['round-ss10'], ...patch }
}

function blueprint(patch: Partial<GemtplBlueprint> = {}): GemtplBlueprint {
  return { enabled: true, ...patch }
}

describe('0.1 类型契约（编译期——svelte-check/tsc 消费本文件的 expectTypeOf 与注解断言）', () => {
  it('GemtplDrillParams ≡ labFile.DrillParamsConfig（.gemtpl v2 drillParams 键结构等价）', () => {
    expectTypeOf<GemtplDrillParams>().toEqualTypeOf<DrillParamsConfig>()
  })

  it('GemtplBlueprint 可投影到 labFile.BlueprintToggle（refs 为消费侧超集，4.1 接线落键）', () => {
    // 经变量中转避免字面量过剩属性检查——断言的是结构兼容（超集投影）
    const withRefs: GemtplBlueprint = { enabled: true, refs: [] }
    const toggle: BlueprintToggle = withRefs
    expect(toggle.enabled).toBe(true)
  })

  it('任务侧快照 re-export ≡ stages.ts 唯一定义（禁止平行第二定义）', () => {
    expectTypeOf<LabTaskDrillParams>().toEqualTypeOf<StagesLabTaskDrillParams>()
    expectTypeOf<LabTaskBlueprint>().toEqualTypeOf<StagesLabTaskBlueprint>()
  })

  it('workflowMode 退役（类型级）：gemtpl/gemgen v2 键位无 workflowMode；requestMode 保留', () => {
    expectTypeOf<GemgenFile['provenance']>().toHaveProperty('requestMode')
    expectTypeOf<GemgenFile['provenance']>().not.toHaveProperty('workflowMode')
    expectTypeOf<GemtplFile>().not.toHaveProperty('workflowMode')
  })
})

describe('validateGemtplDrillParams：写入门边界', () => {
  it('enabled=true + specs≥1 合法；physical 合法通过', () => {
    expect(() => validateGemtplDrillParams(drill({ physical: PHYSICAL }))).not.toThrow()
    expect(validateGemtplDrillParams(drill({ physical: PHYSICAL })).warnings).toEqual([])
  })

  it('enabled=true + 空清单 → typed error（enabled ⇒ specs≥1）', () => {
    expect(() => validateGemtplDrillParams(drill({ specs: [] }))).toThrowError(GemtplAdvancedOptionError)
    try {
      validateGemtplDrillParams(drill({ specs: [] }))
    } catch (error) {
      expect(error).toBeInstanceOf(GemtplAdvancedOptionError)
      expect((error as GemtplAdvancedOptionError).path).toBe('drillParams.specs')
    }
  })

  it('enabled=false + 空清单合法（关灯空态）；enabled=false + 已填清单合法（关灯不丢数据）', () => {
    expect(() => validateGemtplDrillParams(drill({ enabled: false, specs: [] }))).not.toThrow()
    expect(() => validateGemtplDrillParams(drill({ enabled: false, specs: ['round-ss10', 'custom-ast-1'] }))).not.toThrow()
  })

  it('specKey 重复 → typed error 拒写（enabled 状态无关）', () => {
    for (const enabled of [true, false]) {
      expect(() =>
        validateGemtplDrillParams(drill({ enabled, specs: ['round-ss10', 'square-3.5', 'round-ss10'] })),
      ).toThrowError(GemtplAdvancedOptionError)
    }
    try {
      validateGemtplDrillParams(drill({ specs: ['round-ss10', 'round-ss10'] }))
    } catch (error) {
      expect((error as GemtplAdvancedOptionError).path).toBe('drillParams.specs.1')
    }
  })

  it('specKey 含空白/空串 → typed error', () => {
    expect(() => validateGemtplDrillParams(drill({ specs: [''] }))).toThrowError(GemtplAdvancedOptionError)
    expect(() => validateGemtplDrillParams(drill({ specs: ['round ss10'] }))).toThrowError(GemtplAdvancedOptionError)
  })

  it('physical 宽高非正数 → typed error；anchorSource 非法 → typed error', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validateGemtplDrillParams(drill({ physical: { widthMm: bad, heightMm: 148, anchorSource: 'declared' } })),
      ).toThrowError(GemtplAdvancedOptionError)
    }
    // @ts-expect-error 脏输入运行时防御（类型层已挡，此处验证运行时拒写）
    expect(() => validateGemtplDrillParams(drill({ physical: { widthMm: 210, heightMm: 148, anchorSource: 'other' } }))).toThrowError(
      GemtplAdvancedOptionError,
    )
  })

  it('清单超软上限（>8）→ 警告不阻断；恰 8 条无警告', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `round-ss${i + 6}`)
    const outcome = validateGemtplDrillParams(drill({ specs: nine }))
    expect(outcome.warnings).toHaveLength(1)
    expect(outcome.warnings[0]?.code).toBe('specs-over-soft-limit')
    expect(DRILL_SPEC_LIST_SOFT_LIMIT).toBe(8)
    const eight = Array.from({ length: 8 }, (_, i) => `round-ss${i + 6}`)
    expect(validateGemtplDrillParams(drill({ specs: eight })).warnings).toEqual([])
  })
})

describe('validateGemtplBlueprint：写入门边界', () => {
  it('refs 缺席/空/≤2 且去重 → 合法', () => {
    expect(() => validateGemtplBlueprint(blueprint())).not.toThrow()
    expect(() => validateGemtplBlueprint(blueprint({ refs: [] }))).not.toThrow()
    expect(() => validateGemtplBlueprint(blueprint({ refs: ['ast-1', 'ast-2'] }))).not.toThrow()
    expect(BLUEPRINT_REFS_MAX).toBe(2)
  })

  it('refs >2 → typed error 拒写', () => {
    expect(() => validateGemtplBlueprint(blueprint({ refs: ['ast-1', 'ast-2', 'ast-3'] }))).toThrowError(
      GemtplAdvancedOptionError,
    )
  })

  it('refs 重复 / 空串 → typed error', () => {
    expect(() => validateGemtplBlueprint(blueprint({ refs: ['ast-1', 'ast-1'] }))).toThrowError(GemtplAdvancedOptionError)
    expect(() => validateGemtplBlueprint(blueprint({ refs: [''] }))).toThrowError(GemtplAdvancedOptionError)
  })
})

describe('resolveGemtplAdvancedOptions：两键缺席 = 两开关关（v1 迁移口径）', () => {
  it('双缺席 → 归一 OFF 形态', () => {
    const resolved = resolveGemtplAdvancedOptions()
    expect(resolved.drillParams.enabled).toBe(false)
    expect(resolved.drillParams.specs).toEqual([])
    expect(resolved.blueprint.enabled).toBe(false)
    expect(resolved.blueprint.refs).toEqual([])
    expectTypeOf(resolved).toEqualTypeOf<GemtplAdvancedOptions>()
    // 归一常量与函数产物一致
    expect(resolved).toEqual(GEMTPL_ADVANCED_OPTIONS_OFF)
  })

  it('单侧缺席 → 另一侧原样、缺席侧 OFF；双存在原样透传', () => {
    const dp = drill({ physical: PHYSICAL })
    const bp = blueprint({ refs: ['ast-1'] })
    const onlyDrill = resolveGemtplAdvancedOptions(dp)
    expect(onlyDrill.drillParams).toBe(dp)
    expect(onlyDrill.blueprint.enabled).toBe(false)
    const onlyBp = resolveGemtplAdvancedOptions(undefined, bp)
    expect(onlyBp.blueprint).toBe(bp)
    expect(onlyBp.drillParams.enabled).toBe(false)
    const both = resolveGemtplAdvancedOptions(dp, bp)
    expect(both.drillParams).toBe(dp)
    expect(both.blueprint).toBe(bp)
  })
})
