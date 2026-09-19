/**
 * 轨 A 1.1 service 测试：【尺寸与钻规格】段生成 + 素材附图派生。
 * 覆盖：注入矩阵（physical × canvasWidthPx × 内置/自定义）+ 比例锚数值（§2.2 示例数字
 * 复算）+ 规格/清单行格式 + 素材附图截断/去重/警告 + specDisplayCode 正向派生。
 */
import { describe, expect, it } from 'vitest'
import {
  buildDrillSpecSection,
  deriveMaterialAttachments,
  MATERIAL_FIGURE_SOFT_LIMIT,
  orderDrillImages,
  specDisplayCode,
  specListLineOf,
} from '$lib/lab/prompt'
import type { GemSpecSnapshot } from '$lib/engine'

const roundSs10: GemSpecSnapshot = {
  specKey: 'round-ss10',
  ordinal: 1,
  shapeId: 'round',
  sizeLabel: 'SS10',
  diameterMm: 2.8,
}
const square35: GemSpecSnapshot = {
  specKey: 'square-3.5',
  ordinal: 2,
  shapeId: 'square',
  sizeLabel: '3.5mm',
  diameterMm: 3.5,
}
const customStar: GemSpecSnapshot = {
  specKey: 'custom-ast-shape-star01',
  ordinal: 3,
  shapeId: 'custom',
  sizeLabel: 'C-star01',
  diameterMm: 5,
  assetId: 'ast-shape-star01',
}
const customPetal: GemSpecSnapshot = {
  specKey: 'custom-ast-shape-petal02',
  ordinal: 4,
  shapeId: 'custom',
  sizeLabel: 'C-petal02',
  diameterMm: 4.2,
  assetId: 'ast-shape-petal02',
}

const PHYSICAL_210 = { widthMm: 210, heightMm: 148, anchorSource: 'declared' } as const

/** 与组装器同源的附图序派生（附图序号 = 角色声明序号不变量）。 */
function orderOf(specs: readonly GemSpecSnapshot[]) {
  const plan = deriveMaterialAttachments(specs)
  return orderDrillImages({
    hasCase: true,
    caseLayout: 'horizontal',
    hasReference: true,
    materials: plan.attached.map((m) => m.specCode),
  })
}

describe('【尺寸与钻规格】段生成（§2.2 骨架物化）', () => {
  it('physical 锚定请求宽度：段题→锚两行→恒有清单（§2.2 示例数字复算：4.9px / 1.33%）', () => {
    const specs = [roundSs10, customStar]
    const section = buildDrillSpecSection({ specs, physical: PHYSICAL_210, canvasWidthPx: 1024, order: orderOf(specs) })
    expect(section).toMatchInlineSnapshot(`
      "【尺寸与钻规格】
      画幅物理尺寸 210×148mm。图宽对应 1024px：1mm ≈ 4.9px。
      SS10 圆钻直径 2.8mm ≈ 画幅宽度的 1.33%——所有钻按此物理比例绘制。
      只允许使用以下钻（编号用于区分钻规格）：
        1 = R10 圆形 SS10（直径 2.8mm）
        3 = custom-ast-shape-star01 自定义钻形（最大径 5mm，素材见【图三：钻石素材图·custom-ast-shape-star01】）"
    `)
    expect(section).toContain('画幅物理尺寸 210×148mm。图宽对应 1024px：1mm ≈ 4.9px。')
    expect(section).toContain('SS10 圆钻直径 2.8mm ≈ 画幅宽度的 1.33%——所有钻按此物理比例绘制。')
    expect(section).toContain('只允许使用以下钻（编号用于区分钻规格）：')
  })

  it('physical 未锚定请求宽度：缺省换算显式标注（2.5px——engine.PIXELS_PER_MM 单源）', () => {
    const section = buildDrillSpecSection({ specs: [roundSs10], physical: PHYSICAL_210, order: [] })
    expect(section).toContain('画幅物理尺寸 210×148mm。1mm ≈ 2.5px（缺省换算，未按请求宽度锚定）。')
  })

  it('physical 缺席：退化为相对比例行（无百分比锚）', () => {
    const section = buildDrillSpecSection({ specs: [roundSs10, square35], order: [] })
    expect(section).toContain('未声明画幅物理尺寸——按钻径之比表现各规格的相对大小。')
    expect(section).not.toContain('画幅宽度')
  })

  it("比例锚数值规则：一位/两位小数 + 尾零裁剪（5.6/280×100=2 → 「2」）", () => {
    const specs = [{ ...roundSs10, diameterMm: 5.6 }]
    const section = buildDrillSpecSection({
      specs,
      physical: { widthMm: 280, heightMm: 280, anchorSource: 'declared' },
      canvasWidthPx: 1024,
      order: [],
    })
    expect(section).toContain('≈ 画幅宽度的 2%——')
    expect(section).toContain('1mm ≈ 3.7px。') // 1024/280 = 3.657 → 3.7
  })

  it('内置形清单行（纯描述注入）；自定义行交叉引用图号（附图序同源）', () => {
    const specs = [roundSs10, square35, customStar, customPetal]
    const order = orderOf(specs) // 案例(一) 参考(二) 素材star(三) 素材petal(四)
    const section = buildDrillSpecSection({ specs, physical: PHYSICAL_210, canvasWidthPx: 1024, order })
    expect(section).toContain('  1 = R10 圆形 SS10（直径 2.8mm）')
    expect(section).toContain('  2 = SQ3.5 方形 3.5mm（直径 3.5mm）')
    expect(section).toContain(
      '  3 = custom-ast-shape-star01 自定义钻形（最大径 5mm，素材见【图三：钻石素材图·custom-ast-shape-star01】）',
    )
    expect(section).toContain('  4 = custom-ast-shape-petal02 自定义钻形（最大径 4.2mm，素材见【图四：钻石素材图·custom-ast-shape-petal02】）')
  })

  it('自定义形无附图（order 无对应素材条目）→ 无交叉引用子句', () => {
    const line = specListLineOf(customStar, [])
    expect(line).toBe('3 = custom-ast-shape-star01 自定义钻形（最大径 5mm）')
  })
})

describe('deriveMaterialAttachments：素材附图派生（§2.3）', () => {
  it('只取自定义形 + specKey 去重保序', () => {
    const plan = deriveMaterialAttachments([roundSs10, customStar, { ...customStar, ordinal: 9 }, customPetal])
    expect(plan.attached.map((m) => m.specCode)).toEqual(['custom-ast-shape-star01', 'custom-ast-shape-petal02'])
    expect(plan.truncated).toEqual([])
    expect(plan.warning).toBeNull()
  })

  it('软上限 4：超出截断 + 警告信号（不阻断）', () => {
    const extra = (i: number): GemSpecSnapshot => ({
      specKey: `custom-ast-c${i}`,
      ordinal: i,
      shapeId: 'custom',
      sizeLabel: `c${i}`,
      diameterMm: 3,
      assetId: `ast-c${i}`,
    })
    const plan = deriveMaterialAttachments([customStar, customPetal, extra(3), extra(4), extra(5), extra(6)])
    expect(MATERIAL_FIGURE_SOFT_LIMIT).toBe(4)
    expect(plan.attached).toHaveLength(4)
    expect(plan.truncated.map((m) => m.specCode)).toEqual(['custom-ast-c5', 'custom-ast-c6'])
    expect(plan.warning).toBe('素材图过多，仅前 4 张随请求附送')
  })

  it('截断的自定义规格仍进清单（仅不附图）——清单行与附图解耦', () => {
    const specs = [roundSs10, customStar, customPetal]
    const truncatedOnly = [...specs.slice(0, 2)] // 场景：petal 被截断
    const order = orderDrillImages({ hasCase: false, caseLayout: 'single', hasReference: false, materials: ['custom-ast-shape-star01'] })
    const line = specListLineOf(customPetal, order)
    expect(line).not.toContain('素材见')
  })
})

describe('specDisplayCode：规格码正向派生（身份不由显示码反推的镜像）', () => {
  it('round-ss10 → R10；square-3.5 → SQ3.5；custom → specKey 全形', () => {
    expect(specDisplayCode(roundSs10)).toBe('R10')
    expect(specDisplayCode(square35)).toBe('SQ3.5')
    expect(specDisplayCode(customStar)).toBe('custom-ast-shape-star01')
  })

  it('specKey 形态异常时以 sizeLabel 归一兜底（防御）', () => {
    const odd: GemSpecSnapshot = { specKey: 'round#weird', ordinal: 1, shapeId: 'round', sizeLabel: 'SS16', diameterMm: 4 }
    expect(specDisplayCode(odd)).toBe('R16')
  })
})
