/*
 * [add-subject-sam-pipeline P3.2] 八策略族参数表单元数据测试（close-paving-backlog
 * T3 增 along-path；T1/T4 star 四参数面与 straight-line 取向场同步）。
 * 覆盖：键集完备性（===KernelStrategyKind 八值——daemon registry 同构）；判别键
 * 变体解析（texture-fill mode / geometry shape / along-path pathSource——未知值回缺省）；
 * 字段界抽查（daemon paramsSchema 抄录对齐点）；参数摘要；调整指令组装（图层级
 * 人机面——指令含节点锚/策略族/参数/密度/用钻）。
 */

import { describe, expect, it } from 'vitest'
import { KernelStrategyKindSchema } from '@handicraft/contracts'
import {
  STRATEGY_FORM_SPECS,
  STRATEGY_KIND_ORDER,
  composeAdjustInstruction,
  discriminantValueOf,
  fieldsFor,
  summarizeParams,
  type ParamFieldDescriptor,
} from '$lib/strategyDesigner/paramsSchema'

describe('八族表单元数据：完备性与控件映射', () => {
  it('键集===KernelStrategyKind 八值（registry 同构——缺族即表单渲染空洞）', () => {
    expect([...Object.keys(STRATEGY_FORM_SPECS)].sort()).toEqual([...KernelStrategyKindSchema.options].sort())
    // STRATEGY_KIND_ORDER（普通数组无类型完备性——两处下拉数据源）与键集一致且含新族
    expect([...STRATEGY_KIND_ORDER].sort()).toEqual([...KernelStrategyKindSchema.options].sort())
    expect(STRATEGY_KIND_ORDER).toContain('along-path')
  })

  it('字段控件值域封闭（number|select|text）且 select 必带选项', () => {
    for (const spec of Object.values(STRATEGY_FORM_SPECS)) {
      const all = [...spec.commonFields, ...Object.values(spec.variants).flat()]
      for (const field of all) {
        expect(['number', 'select', 'text']).toContain(field.control)
        if (field.control === 'select') expect((field.options ?? []).length).toBeGreaterThan(0)
      }
    }
  })

  it('判别族完备：texture-fill(mode)/geometry(shape)/along-path(pathSource) 各有判别键+变体', () => {
    expect(STRATEGY_FORM_SPECS['texture-fill'].discriminant?.key).toBe('mode')
    expect(Object.keys(STRATEGY_FORM_SPECS['texture-fill'].variants).sort()).toEqual(['flow', 'hybrid', 'scatter'])
    expect(STRATEGY_FORM_SPECS.geometry.discriminant?.key).toBe('shape')
    expect(Object.keys(STRATEGY_FORM_SPECS.geometry.variants).sort()).toEqual(['circle', 'ellipse', 'heart', 'rect', 'spiral', 'star'])
    expect(STRATEGY_FORM_SPECS['along-path'].discriminant?.key).toBe('pathSource')
    expect(Object.keys(STRATEGY_FORM_SPECS['along-path'].variants).sort()).toEqual(['custom', 'outline'])
  })

  it('无判别族以 default 单槽承载（五族）', () => {
    for (const kind of ['soft-curve', 'flower', 'straight-line', 'exclusion', 'free-code'] as const) {
      expect(STRATEGY_FORM_SPECS[kind].discriminant).toBeUndefined()
      expect(STRATEGY_FORM_SPECS[kind].variants.default).toBeDefined()
    }
  })

  it('T1/T4 新参数面抄录：star rays 可空+sparseness [0.2,5]；straight-line orientation select', () => {
    const star = fieldsFor('geometry', { shape: 'star' })
    const rays = star.find((f) => f.key === 'rays')!
    expect(rays.optional).toBe(true)
    expect(rays.help).toContain('自动检测')
    const sparseness = star.find((f) => f.key === 'sparseness')!
    expect(sparseness).toMatchObject({ min: 0.2, max: 5 })
    expect(star.find((f) => f.key === 'centerOffsetPx')?.derived).toBe(true)
    const orientation = fieldsFor('straight-line', {}).find((f) => f.key === 'orientation')!
    expect(orientation.control).toBe('select')
    expect(orientation.options?.map((o) => o.value)).toEqual(['global-pca', 'gradient-field'])
    // along-path outline 变体：内缩/步长；custom 变体：pathPts derived
    expect(fieldsFor('along-path', {}).map((f) => f.key)).toEqual(expect.arrayContaining(['outlineInsetPx', 'spacing']))
    const custom = fieldsFor('along-path', { pathSource: 'custom' })
    expect(custom.map((f) => f.key)).toContain('pathPts')
    expect(custom.find((f) => f.key === 'pathPts')?.derived).toBe(true)
  })
})

describe('fieldsFor：判别变体解析', () => {
  it('texture-fill mode=hybrid → lineShare+lloydIters；mode=flow → 无迭代字段', () => {
    const hybrid = fieldsFor('texture-fill', { mode: 'hybrid' }).map((f) => f.key)
    expect(hybrid).toContain('lineShare')
    expect(hybrid).toContain('lloydIters')
    expect(hybrid).toContain('polarity')
    expect(hybrid).toContain('fallbackEngineStrategy')

    const flow = fieldsFor('texture-fill', { mode: 'flow' }).map((f) => f.key)
    expect(flow).not.toContain('lloydIters')
    expect(flow).not.toContain('lineShare')
  })

  it('geometry shape 切换字段集：star→rays/innerRadiusRatio/rotationDeg；spiral→turns/pitchMm/decay', () => {
    const star = fieldsFor('geometry', { shape: 'star' }).map((f) => f.key)
    expect(star).toEqual(expect.arrayContaining(['rays', 'innerRadiusRatio', 'rotationDeg', 'fallbackEngineStrategy']))

    const spiral = fieldsFor('geometry', { shape: 'spiral' }).map((f) => f.key)
    expect(spiral).toEqual(expect.arrayContaining(['turns', 'pitchMm', 'decay']))
    expect(spiral).not.toContain('rays')
  })

  it('判别值缺失/未知 → 回缺省（scatter/star——表单初值不炸）', () => {
    const spec = STRATEGY_FORM_SPECS['texture-fill']
    expect(discriminantValueOf(spec, {})).toBe('scatter')
    expect(discriminantValueOf(spec, { mode: 'unknown-mode' })).toBe('scatter')
    expect(fieldsFor('geometry', {}).map((f) => f.key)).toContain('rays')
  })

  it('字段界抽查（daemon paramsSchema 抄录对齐）：lloydIters 0-16 整数 / coreRadiusRatio 0.05-0.8 / petals 3-64 可空', () => {
    const pick = (fields: ParamFieldDescriptor[], key: string): ParamFieldDescriptor => {
      const found = fields.find((f) => f.key === key)
      expect(found).toBeDefined()
      return found!
    }
    const lloyd = pick(fieldsFor('texture-fill', { mode: 'scatter' }), 'lloydIters')
    expect(lloyd).toMatchObject({ min: 0, max: 16, integer: true })
    const core = pick(fieldsFor('flower', {}), 'coreRadiusRatio')
    expect(core).toMatchObject({ min: 0.05, max: 0.8 })
    const petals = pick(fieldsFor('flower', {}), 'petals')
    expect(petals).toMatchObject({ min: 3, max: 64, optional: true })
  })

  it('lumaB64 标记 derived（只读呈现——不出摘要不出指令）', () => {
    const luma = fieldsFor('texture-fill', { mode: 'flow', lumaB64: 'abc' }).find((f) => f.key === 'lumaB64')
    expect(luma?.derived).toBe(true)
    expect(summarizeParams('texture-fill', { mode: 'flow', lumaB64: 'abc' })).not.toContain('lumaB64')
  })
})

describe('summarizeParams / composeAdjustInstruction', () => {
  it('摘要=判别键先行+非空字段 key=value 压缩', () => {
    expect(summarizeParams('texture-fill', { mode: 'flow', polarity: 'dark-dense', fallbackEngineStrategy: 'hex-pitch' })).toBe(
      'mode=flow polarity=dark-dense fallbackEngineStrategy=hex-pitch',
    )
    expect(summarizeParams('geometry', { shape: 'star', rays: 5 })).toBe('shape=star rays=5')
  })

  it('指令含节点锚/策略族/判别/参数/密度/用钻/批准语义（不旁路直写）', () => {
    const text = composeAdjustInstruction({
      objectName: '柳树·枝条',
      nodeId: 'n-branch',
      kind: 'texture-fill',
      params: { mode: 'flow', polarity: 'bright-dense', lumaB64: 'zzz' },
      densityPerCm2: 3.1,
      stonesSummary: 'J-303 深柳绿 3mm',
    })
    expect(text).toContain('柳树·枝条')
    expect(text).toContain('nodeId=n-branch')
    expect(text).toContain('策略族：texture-fill')
    expect(text).toContain('mode：flow')
    expect(text).toContain('polarity=bright-dense')
    expect(text).not.toContain('lumaB64') // derived 不出指令
    expect(text).toContain('密度：3.1 颗/cm²')
    expect(text).toContain('用钻：J-303 深柳绿 3mm')
    expect(text).toContain('等待我批准')
  })

  it('空参数族（exclusion reason）指令仍成段', () => {
    const text = composeAdjustInstruction({
      objectName: '路灯·灯头',
      nodeId: 'n-lamp',
      kind: 'exclusion',
      params: { reason: '灯光不贴' },
      densityPerCm2: 2.3,
      stonesSummary: '',
    })
    expect(text).toContain('策略族：exclusion')
    expect(text).toContain('reason=灯光不贴')
    expect(text).not.toContain('用钻')
  })
})
