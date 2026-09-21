/**
 * 0.2 组装器契约冻结测试：附图角色 n 元模型（orderDrillImages/describeDrillImageOrder）
 * + 【尺寸与钻规格】注入段骨架常量 + 素材注入策略常量 + 蓝图两策略骨架（design §2.2-2.4
 * 逐字）+ 组装器契约类型（类型级断言由 svelte-check/tsc 消费）。
 *
 * 〔WYSIWYG 基线再生 2026-09-21〕主图段序常量 SEGMENT_ORDER_MAIN 随六层注入退场删除
 * （主图提示词不再有组装段序——正文 = 模板体原样）；蓝图骨架常量保留，但消费面从
 * 「请求隐藏骨架」改为「蓝图片段默认内容生成器」（autoBlueprintPromptFragment）。
 *
 * 骨架快照冻结纪律：任何快照漂移 = 契约变更，须 bump src/lib/lab/prompt.ts 文件头冻结
 * 注释并附依据；不得为过测试而改快照。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BLUEPRINT_CLOSING_LINE,
  BLUEPRINT_CUSTOM_REF_CLAUSE,
  BLUEPRINT_LEGEND_CLAUSE,
  BLUEPRINT_NO_LEGEND_TAIL,
  BLUEPRINT_PARALLEL_BODY,
  BLUEPRINT_PARALLEL_TASK,
  BLUEPRINT_SERIAL_BODY,
  BLUEPRINT_SERIAL_TASK,
  BLUEPRINT_SHAPE_ENUMERATION,
  CASE_FIGURE_LABEL,
  DRILL_SPEC_ANCHOR_DEFAULT_LINE,
  DRILL_SPEC_ANCHOR_FALLBACK_LINE,
  DRILL_SPEC_ANCHOR_LINE,
  DRILL_SPEC_LIST_HEAD,
  DRILL_SPEC_RATIO_ANCHOR_LINE,
  DRILL_SPEC_SECTION_TITLE,
  EFFECT_FIGURE_LABEL,
  MATERIAL_FIGURE_LABEL_PREFIX,
  MATERIAL_FIGURE_SOFT_LIMIT,
  MATERIAL_OVERFLOW_WARNING,
  orderDrillImages,
  REFERENCE_FIGURE_LABEL,
  SPEC_LIST_LINE_BUILTIN,
  SPEC_LIST_LINE_CUSTOM_ATTACHED,
  SPEC_LIST_LINE_CUSTOM_UNATTACHED,
  SPEC_LIST_LINE_INDENT,
  figureOf,
} from '$lib/lab/prompt'
import type {
  ComposeBlueprintPromptOptions,
  ComposeDrillPromptOptions,
  PromptBlueprint,
  PromptDrillParams,
} from '$lib/lab/prompt'
import { describeDrillImageOrder } from '$lib/presets/effectRefs'
import type { LabTaskDrillParams } from '$lib/lab/stages'
import type { GemSpecSnapshot } from '$lib/engine'

describe('orderDrillImages：附图角色 n 元模型（序号单一真源）', () => {
  it('恒序 effect → case → reference → ...素材 → ...蓝图参考；ordinal 连续', () => {
    const order = orderDrillImages({
      hasEffect: true,
      hasCase: true,
      caseLayout: 'horizontal',
      hasReference: true,
      materials: ['C-star01', 'C-petal02'],
      blueprintRefs: 2,
    })
    expect(order.map((e) => e.role)).toEqual(['effect', 'case', 'reference', 'material', 'material', 'blueprint-ref', 'blueprint-ref'])
    expect(order.map((e) => e.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(order.map((e) => e.figureLabel)).toEqual([
      EFFECT_FIGURE_LABEL,
      CASE_FIGURE_LABEL,
      REFERENCE_FIGURE_LABEL,
      `${MATERIAL_FIGURE_LABEL_PREFIX}C-star01`,
      `${MATERIAL_FIGURE_LABEL_PREFIX}C-petal02`,
      '蓝图参考图',
      '蓝图参考图',
    ])
    // 附图序号 = 角色声明序号不变量：图号与 ordinal 恒同源
    expect(order.every((e) => e.figure === figureOf(e.ordinal))).toBe(true)
  })

  it('中文数字至「十」，超出落阿拉伯数字（防御性）', () => {
    expect(orderDrillImages({ hasCase: false, caseLayout: 'single', hasReference: false, materials: Array.from({ length: 11 }, (_, i) => `c${i}`) })
      .map((e) => e.figure)).toEqual(['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '11'])
    expect(figureOf(1)).toBe('一')
    expect(figureOf(10)).toBe('十')
    expect(figureOf(12)).toBe('12')
  })

  it('旧输入形状零变化：可选扩展字段缺席即零条（UI 徽标消费面兼容出口同源）', () => {
    const legacy = { hasCase: true, caseLayout: 'vertical' as const, hasReference: false }
    expect(orderDrillImages(legacy)).toEqual(describeDrillImageOrder(legacy))
    expect(orderDrillImages(legacy).map((e) => e.figureLabel)).toEqual(['案例参照图'])
  })
})

describe('组装器契约类型（编译期冻结）', () => {
  it('PromptDrillParams ≡ LabTaskDrillParams（§2.1「= §1.2」单一真源）', () => {
    expectTypeOf<PromptDrillParams>().toEqualTypeOf<LabTaskDrillParams>()
  })

  it('ComposeDrillPromptOptions / PromptBlueprint / ComposeBlueprintPromptOptions 形状', () => {
    expectTypeOf<ComposeDrillPromptOptions>().toEqualTypeOf<{
      drillParams?: PromptDrillParams
      canvasWidthPx?: number
      casePromptFragment?: string
      blueprintPrompt?: { text: string }
    }>()
    expectTypeOf<PromptBlueprint>().toEqualTypeOf<{ hasLegend: boolean; specs?: readonly GemSpecSnapshot[] }>()
    const options: ComposeBlueprintPromptOptions = { blueprint: { hasLegend: true, specs: [] } }
    expect(options.blueprint?.hasLegend).toBe(true)
  })
})

describe('【尺寸与钻规格】注入段骨架（§2.2 逐字冻结——快照锁死）', () => {
  it('段题/清单头', () => {
    expect(DRILL_SPEC_SECTION_TITLE).toMatchInlineSnapshot(`"【尺寸与钻规格】"`)
    expect(DRILL_SPEC_LIST_HEAD).toMatchInlineSnapshot(`"只允许使用以下钻（编号用于区分钻规格）："`)
    // [WYSIWYG 2026-09-21] SEGMENT_ORDER_MAIN（主图组装段序）随六层注入退场删除——
    // 【尺寸与钻规格】只经模板体占位符替换进入（正文 = 模板体原样，无段序概念）。
  })

  it('比例锚三形态 + 清单行模板（占位符 {…} 冻结）', () => {
    expect(DRILL_SPEC_ANCHOR_LINE).toMatchInlineSnapshot(
      `"画幅物理尺寸 {widthMm}×{heightMm}mm。图宽对应 {canvasWidthPx}px：1mm ≈ {pxPerMm}px。"`,
    )
    expect(DRILL_SPEC_ANCHOR_DEFAULT_LINE).toMatchInlineSnapshot(
      `"画幅物理尺寸 {widthMm}×{heightMm}mm。1mm ≈ {pxPerMm}px（缺省换算，未按请求宽度锚定）。"`,
    )
    expect(DRILL_SPEC_ANCHOR_FALLBACK_LINE).toMatchInlineSnapshot(
      `"未声明画幅物理尺寸——按钻径之比表现各规格的相对大小。"`,
    )
    expect(DRILL_SPEC_RATIO_ANCHOR_LINE).toMatchInlineSnapshot(
      `"{specDesc} ≈ 画幅宽度的 {pct}%——所有钻按此物理比例绘制。"`,
    )
    expect(SPEC_LIST_LINE_BUILTIN).toMatchInlineSnapshot(`"{ordinal} = {code} {shapeName} {sizeLabel}（直径 {diameterMm}mm）"`)
    expect(SPEC_LIST_LINE_CUSTOM_ATTACHED).toMatchInlineSnapshot(
      `"{ordinal} = {code} 自定义钻形（最大径 {diameterMm}mm，素材见{figureTag}）"`,
    )
    expect(SPEC_LIST_LINE_CUSTOM_UNATTACHED).toMatchInlineSnapshot(
      `"{ordinal} = {code} 自定义钻形（最大径 {diameterMm}mm）"`,
    )
    expect(SPEC_LIST_LINE_INDENT).toBe('  ')
  })
})

describe('素材注入策略常量（§2.3 冻结）', () => {
  it('软上限 4 + 截断警告文案', () => {
    expect(MATERIAL_FIGURE_SOFT_LIMIT).toBe(4)
    expect(MATERIAL_OVERFLOW_WARNING).toMatchInlineSnapshot(`"素材图过多，仅前 4 张随请求附送"`)
  })
})

describe('蓝图两策略骨架（§2.4 逐字冻结——快照锁死）', () => {
  it('策略 B（串行，默认）任务行/转换体/图例子句/退化收尾/禁令', () => {
    expect(BLUEPRINT_SERIAL_TASK).toMatchInlineSnapshot(
      `"【任务：施工蓝图转换】输入{effectTag}为本设计的局部贴钻成品。"`,
    )
    expect(BLUEPRINT_SERIAL_BODY).toMatchInlineSnapshot(
      `"将这张效果图转换为白底平面施工蓝图：保留图中每个钻位的排布位置、真实形状轮廓（{shapeEnumeration}{customRefClause}）与物理比例，去除背景与光照，每颗钻平涂其颜色{legendClause}"`,
    )
    expect(BLUEPRINT_LEGEND_CLAUSE).toMatchInlineSnapshot(
      `"；每个钻位中心标注其编号数字（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格："`,
    )
    expect(BLUEPRINT_NO_LEGEND_TAIL).toMatchInlineSnapshot(`"。（无编号纯转换：图中钻位不标号、无图例。）"`)
    expect(BLUEPRINT_CLOSING_LINE).toMatchInlineSnapshot(`"不新增、不移动、不删除任何钻位。"`)
  })

  it('策略 A（并行同生）任务行改写 + 无输入图约束转换体 + 自定义轮廓子句 + 形状枚举', () => {
    expect(BLUEPRINT_PARALLEL_TASK).toMatchInlineSnapshot(
      `"【任务：施工蓝图生成】为本次同时生成的设计生成配套施工蓝图。"`,
    )
    expect(BLUEPRINT_PARALLEL_BODY).toMatchInlineSnapshot(
      `"生成白底平面施工蓝图：每颗钻保留真实形状轮廓（{shapeEnumeration}{customRefClause}）与物理比例，平涂其颜色{legendClause}"`,
    )
    expect(BLUEPRINT_CUSTOM_REF_CLAUSE).toMatchInlineSnapshot(`"——自定义轮廓见{figureTag}"`)
    expect(BLUEPRINT_SHAPE_ENUMERATION).toMatchInlineSnapshot(`"圆形/方形/水滴/心形/马眼/自定义"`)
  })
})
