/**
 * 轨 A 1.3 测试：composeBlueprintPrompt 两策略骨架。
 * - 策略 B（串行，默认）：成品图首附图（恒图一）+ 转换任务 + 编号图例 + 收尾禁令；
 * - 策略 A（并行同生）：无成品图任务行改写，参考原图占图一；
 * - hasLegend 矩阵（有清单/无清单/空 specs 防御退化）；
 * - 附图序同源（图号=orderDrillImages 产物）+ 旧档重建口径（确定性逐字节 + 策略差异可判别）。
 */
import { describe, expect, it } from 'vitest'
import { composeBlueprintPrompt, orderDrillImages } from '$lib/lab/prompt'
import type { BlueprintPromptRoles } from '$lib/lab/prompt'
import type { GemSpecSnapshot } from '$lib/engine'

const roundSs10: GemSpecSnapshot = { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }
const customStar: GemSpecSnapshot = {
  specKey: 'custom-ast-shape-star01',
  ordinal: 2,
  shapeId: 'custom',
  sizeLabel: 'C-star01',
  diameterMm: 5,
  assetId: 'ast-shape-star01',
}

const SERIAL_ROLES: BlueprintPromptRoles = {
  hasEffect: true,
  hasReference: true,
  materials: ['custom-ast-shape-star01'],
  blueprintRefs: 2,
}

const PARALLEL_ROLES: BlueprintPromptRoles = {
  hasEffect: false,
  hasReference: true,
  materials: ['custom-ast-shape-star01'],
  blueprintRefs: 1,
}

describe('策略 B（串行，默认）——转换骨架快照', () => {
  it('成品图恒图一 + 图例节（清单行复用主图清单行生成器）+ 收尾禁令', () => {
    const prompt = composeBlueprintPrompt(SERIAL_ROLES, {
      blueprint: { hasLegend: true, specs: [roundSs10, customStar] },
    })
    expect(prompt).toMatchInlineSnapshot(`
      "【任务：施工蓝图转换】输入【图一：成品效果图】为本设计的局部贴钻成品。
      将这张效果图转换为白底平面施工蓝图：保留图中每个钻位的排布位置、真实形状轮廓（圆形/方形/水滴/心形/马眼/自定义——自定义轮廓见【图三：钻石素材图】）与物理比例，去除背景与光照，每颗钻平涂其颜色；每个钻位中心标注其编号数字（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格：
        1 = R10 圆形 SS10（直径 2.8mm）
        2 = custom-ast-shape-star01 自定义钻形（最大径 5mm，素材见【图三：钻石素材图·custom-ast-shape-star01】）
      不新增、不移动、不删除任何钻位。"
    `)
    expect(prompt).toContain('【任务：施工蓝图转换】输入【图一：成品效果图】为本设计的局部贴钻成品。')
    expect(prompt.endsWith('不新增、不移动、不删除任何钻位。')).toBe(true)
  })

  it('附图序同源：图号与 orderDrillImages（effect→reference→素材→蓝图参考）一致', () => {
    const prompt = composeBlueprintPrompt(SERIAL_ROLES, { blueprint: { hasLegend: true, specs: [roundSs10, customStar] } })
    const order = orderDrillImages({
      hasCase: false,
      caseLayout: 'single',
      hasReference: true,
      materials: ['custom-ast-shape-star01'],
      hasEffect: true,
      blueprintRefs: 2,
    })
    expect(order.map((e) => `${e.figure}:${e.figureLabel}`)).toEqual([
      '一:成品效果图',
      '二:参考图',
      '三:钻石素材图·custom-ast-shape-star01',
      '四:蓝图参考图',
      '五:蓝图参考图',
    ])
    expect(prompt).toContain('自定义轮廓见【图三：钻石素材图】')
  })
})

describe('策略 A（并行同生）——任务行改写快照', () => {
  it('无成品图：参考原图占图一，任务行为「为本次同时生成的设计生成配套施工蓝图」', () => {
    const prompt = composeBlueprintPrompt(PARALLEL_ROLES, {
      blueprint: { hasLegend: true, specs: [roundSs10, customStar] },
    })
    expect(prompt).toMatchInlineSnapshot(`
      "【任务：施工蓝图生成】为本次同时生成的设计生成配套施工蓝图。
      生成白底平面施工蓝图：每颗钻保留真实形状轮廓（圆形/方形/水滴/心形/马眼/自定义——自定义轮廓见【图二：钻石素材图】）与物理比例，平涂其颜色；每个钻位中心标注其编号数字（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格：
        1 = R10 圆形 SS10（直径 2.8mm）
        2 = custom-ast-shape-star01 自定义钻形（最大径 5mm，素材见【图二：钻石素材图·custom-ast-shape-star01】）
      不新增、不移动、不删除任何钻位。"
    `)
    expect(prompt).not.toContain('成品效果图')
    expect(prompt).toContain('【任务：施工蓝图生成】为本次同时生成的设计生成配套施工蓝图。')
  })

  it('两策略骨架差异可判别（同清单同素材——B 有成品图输入/A 无）', () => {
    const serial = composeBlueprintPrompt(SERIAL_ROLES, { blueprint: { hasLegend: true, specs: [roundSs10] } })
    const parallel = composeBlueprintPrompt(PARALLEL_ROLES, { blueprint: { hasLegend: true, specs: [roundSs10] } })
    expect(serial).not.toBe(parallel)
    expect(serial).toContain('输入【图一：成品效果图】')
    expect(parallel).not.toContain('【图一：成品效果图】')
  })
})

describe('hasLegend 矩阵（无钻清单退化）', () => {
  it('blueprint 缺席 → 省略编号与图例节，退化为无编号纯转换', () => {
    const prompt = composeBlueprintPrompt(SERIAL_ROLES)
    expect(prompt).toContain('。（无编号纯转换：图中钻位不标号、无图例。）')
    expect(prompt).not.toContain('图例列出编号对应规格')
    expect(prompt).not.toMatch(/^  \d+ = /m)
  })

  it('hasLegend=false → 同退化', () => {
    const prompt = composeBlueprintPrompt(SERIAL_ROLES, { blueprint: { hasLegend: false, specs: [roundSs10] } })
    expect(prompt).toContain('。（无编号纯转换：图中钻位不标号、无图例。）')
  })

  it('hasLegend=true 但 specs 空 → 防御性退化（不产生空图例节）', () => {
    const prompt = composeBlueprintPrompt(SERIAL_ROLES, { blueprint: { hasLegend: true, specs: [] } })
    expect(prompt).toContain('。（无编号纯转换：图中钻位不标号、无图例。）')
  })

  it('无素材附图 → 括注无自定义轮廓子句（形状枚举干净收口）', () => {
    const prompt = composeBlueprintPrompt(
      { hasEffect: true, hasReference: false, materials: [], blueprintRefs: 0 },
      { blueprint: { hasLegend: true, specs: [roundSs10] } },
    )
    expect(prompt).toContain('真实形状轮廓（圆形/方形/水滴/心形/马眼/自定义）与物理比例')
  })
})

describe('旧档重建口径（确定性——provenance.blueprintPrompt 审计快照可复算）', () => {
  it('同输入两次调用逐字节相等；图例开关/策略各自改变输出', () => {
    const options = { blueprint: { hasLegend: true, specs: [roundSs10, customStar] } } as const
    const a = composeBlueprintPrompt(SERIAL_ROLES, options)
    const b = composeBlueprintPrompt(SERIAL_ROLES, options)
    expect(a).toBe(b)
    expect(composeBlueprintPrompt(SERIAL_ROLES)).not.toBe(a)
    expect(composeBlueprintPrompt(PARALLEL_ROLES, options)).not.toBe(a)
  })
})
