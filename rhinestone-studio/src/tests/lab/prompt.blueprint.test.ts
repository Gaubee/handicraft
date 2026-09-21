/**
 * 蓝图片段默认内容生成器（autoBlueprintPromptFragment）——〔WYSIWYG 基线再生 2026-09-21〕
 * 原 composeBlueprintPrompt 两策略**请求骨架**退场为**片段默认内容**：图序声明并入片段
 * （计数行 + figureTagOf 声明行——原隐藏注入面可见化），蓝图 stage 请求 = 覆盖片段
 * verbatim ?? 本函数输出，无额外包裹。
 * - 策略 B（串行，默认）：成品图首附图（恒图一）声明 + 转换任务 + 编号图例 + 收尾禁令；
 * - 策略 A（并行同生）：无成品图任务行改写，参考原图占图一；
 * - hasLegend 矩阵（有清单/无清单/空 specs 防御退化）；
 * - 附图序同源（图号=orderDrillImages 产物）+ 旧档重建口径（确定性逐字节 + 策略差异可判别）。
 */
import { describe, expect, it } from 'vitest'
import { autoBlueprintPromptFragment, orderDrillImages } from '$lib/lab/prompt'
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

describe('策略 B（串行，默认）——片段默认内容快照', () => {
  it('图序声明（附图 5 张计数+逐图行）+ 转换任务 + 图例节（清单行复用主图清单行生成器）+ 收尾禁令', () => {
    const fragment = autoBlueprintPromptFragment(SERIAL_ROLES, {
      blueprint: { hasLegend: true, specs: [roundSs10, customStar] },
    })
    expect(fragment).toMatchInlineSnapshot(`
      "我上传了5 张图片：
      1. 【图一 [image #1]：成品效果图】：本设计的局部贴钻成品效果图。
      2. 【图二 [image #2]：参考图】：需要转换的设计原图。
      3. 【图三 [image #3]：钻石素材图·custom-ast-shape-star01】：该自定义钻形的钻石素材贴图——钻清单以「素材见【图N [image #N]：钻石素材图】」交叉引用本图。
      4. 【图四 [image #4]：蓝图参考图】：蓝图风格参考图（版式与风格参照）。
      5. 【图五 [image #5]：蓝图参考图】：蓝图风格参考图（版式与风格参照）。
      【任务：施工蓝图转换】输入【图一 [image #1]：成品效果图】为本设计的局部贴钻成品。
      将这张效果图转换为白底平面施工蓝图：保留图中每个钻位的排布位置、真实形状轮廓（圆形/方形/水滴/心形/马眼/自定义——自定义轮廓见【图三 [image #3]：钻石素材图】）与物理比例，去除背景与光照，每颗钻平涂其颜色；每个钻位中心标注其编号数字（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格：
        1 = R10 圆形 SS10（直径 2.8mm）
        2 = custom-ast-shape-star01 自定义钻形（最大径 5mm，素材见【图三 [image #3]：钻石素材图·custom-ast-shape-star01】）
      不新增、不移动、不删除任何钻位。"
    `)
    expect(fragment).toContain('【任务：施工蓝图转换】输入【图一 [image #1]：成品效果图】为本设计的局部贴钻成品。')
    expect(fragment.endsWith('不新增、不移动、不删除任何钻位。')).toBe(true)
  })

  it('附图序同源：图号与 orderDrillImages（effect→reference→素材→蓝图参考）一致', () => {
    const fragment = autoBlueprintPromptFragment(SERIAL_ROLES, { blueprint: { hasLegend: true, specs: [roundSs10, customStar] } })
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
    expect(fragment).toContain('自定义轮廓见【图三 [image #3]：钻石素材图】')
  })
})

describe('策略 A（并行同生）——任务行改写快照', () => {
  it('无成品图：参考原图占图一，任务行为「为本次同时生成的设计生成配套施工蓝图」', () => {
    const fragment = autoBlueprintPromptFragment(PARALLEL_ROLES, {
      blueprint: { hasLegend: true, specs: [roundSs10, customStar] },
    })
    expect(fragment).toMatchInlineSnapshot(`
      "我上传了3 张图片：
      1. 【图一 [image #1]：参考图】：需要转换的设计原图。
      2. 【图二 [image #2]：钻石素材图·custom-ast-shape-star01】：该自定义钻形的钻石素材贴图——钻清单以「素材见【图N [image #N]：钻石素材图】」交叉引用本图。
      3. 【图三 [image #3]：蓝图参考图】：蓝图风格参考图（版式与风格参照）。
      【任务：施工蓝图生成】为本次同时生成的设计生成配套施工蓝图。
      生成白底平面施工蓝图：每颗钻保留真实形状轮廓（圆形/方形/水滴/心形/马眼/自定义——自定义轮廓见【图二 [image #2]：钻石素材图】）与物理比例，平涂其颜色；每个钻位中心标注其编号数字（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格：
        1 = R10 圆形 SS10（直径 2.8mm）
        2 = custom-ast-shape-star01 自定义钻形（最大径 5mm，素材见【图二 [image #2]：钻石素材图·custom-ast-shape-star01】）
      不新增、不移动、不删除任何钻位。"
    `)
    expect(fragment).not.toContain('成品效果图')
    expect(fragment).toContain('【任务：施工蓝图生成】为本次同时生成的设计生成配套施工蓝图。')
  })

  it('两策略片段差异可判别（同清单同素材——B 有成品图声明/A 无）', () => {
    const serial = autoBlueprintPromptFragment(SERIAL_ROLES, { blueprint: { hasLegend: true, specs: [roundSs10] } })
    const parallel = autoBlueprintPromptFragment(PARALLEL_ROLES, { blueprint: { hasLegend: true, specs: [roundSs10] } })
    expect(serial).not.toBe(parallel)
    expect(serial).toContain('输入【图一 [image #1]：成品效果图】')
    expect(parallel).not.toContain('【图一 [image #1]：成品效果图】')
  })
})

describe('hasLegend 矩阵（无钻清单退化）', () => {
  it('blueprint 缺席 → 省略编号与图例节，退化为无编号纯转换', () => {
    const fragment = autoBlueprintPromptFragment(SERIAL_ROLES)
    expect(fragment).toContain('。（无编号纯转换：图中钻位不标号、无图例。）')
    expect(fragment).not.toContain('图例列出编号对应规格：')
    expect(fragment).not.toMatch(/^  \d+ = /m)
  })

  it('hasLegend=false → 同退化', () => {
    const fragment = autoBlueprintPromptFragment(SERIAL_ROLES, { blueprint: { hasLegend: false, specs: [roundSs10] } })
    expect(fragment).toContain('。（无编号纯转换：图中钻位不标号、无图例。）')
  })

  it('hasLegend=true 但 specs 空 → 防御性退化（不产生空图例节）', () => {
    const fragment = autoBlueprintPromptFragment(SERIAL_ROLES, { blueprint: { hasLegend: true, specs: [] } })
    expect(fragment).toContain('。（无编号纯转换：图中钻位不标号、无图例。）')
  })

  it('无素材附图 → 括注无自定义轮廓子句（形状枚举干净收口）', () => {
    const fragment = autoBlueprintPromptFragment(
      { hasEffect: true, hasReference: false, materials: [], blueprintRefs: 0 },
      { blueprint: { hasLegend: true, specs: [roundSs10] } },
    )
    expect(fragment).toContain('真实形状轮廓（圆形/方形/水滴/心形/马眼/自定义）与物理比例')
  })
})

describe('旧档重建口径（确定性——provenance.blueprintPrompt 审计快照可复算）', () => {
  it('同输入两次调用逐字节相等；图例开关/策略各自改变输出', () => {
    const options = { blueprint: { hasLegend: true, specs: [roundSs10, customStar] } } as const
    const a = autoBlueprintPromptFragment(SERIAL_ROLES, options)
    const b = autoBlueprintPromptFragment(SERIAL_ROLES, options)
    expect(a).toBe(b)
    expect(autoBlueprintPromptFragment(SERIAL_ROLES)).not.toBe(a)
    expect(autoBlueprintPromptFragment(PARALLEL_ROLES, options)).not.toBe(a)
  })
})
