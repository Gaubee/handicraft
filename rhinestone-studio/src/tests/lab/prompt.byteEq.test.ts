/**
 * 〔WYSIWYG 基线再生 2026-09-21，enforce-lab-prompt-wysiwyg〕byteEq 公理红线（第三代基线）。
 *
 * Owner 2026-09-21 裁决（原话）：「提示词夹带私货，怎么会有一段："你是一位专业的钻石画……"
 * 不要这些，客观地，我在模板里面配置什么就是什么，所见即所得。」——旧基线（六层组装
 * 全文快照：人设前言/图序计数行/任务指令行/【贴钻指导规则】块/【模板风格补充】壳/输出
 * 指令行）**整体作废**，本文件不再快照组装全文，改为：
 *
 * 1. 公理：三开关全关（无案例附送/无水钻/无蓝图）+ promptBody 无占位符 ⇒
 *    composeDrillPrompt 返回值 ≡ promptBody **逐字节**（任意 roles 形态 × 模板体形态，
 *    含首尾空白保真——不 trim 不包裹）；options 各缺席形态（undefined/{}/undefined 键）
 *    输出两两逐字节相等；
 * 2. 六层字面量恒缺席（开关全开亦然——退场证明）；
 * 3. 每开关单开 + 占位符在位：仅占位符位置被片段替换，正文其余字节不动；
 * 4. 占位符当普通正文（开关关）＝逐字节原样保留。
 *
 * 附图角色 n 元模型（orderDrillImages/describeDrillImageOrder）旧形状回归保留。
 */
import { describe, expect, it } from 'vitest'
import {
  autoCaseRefFragment,
  composeDrillPrompt,
  describeDrillImageOrder,
  type DrillPromptImageRoles,
} from '$lib/presets/effectRefs'
import type { GemSpecSnapshot } from '$lib/engine'

/** 全角色矩阵（附图形态与案例布局的所有组合——公理对结构面不敏感）。 */
const ROLES_MATRIX: DrillPromptImageRoles[] = [
  { hasCase: true, caseLayout: 'horizontal', hasReference: true },
  { hasCase: true, caseLayout: 'vertical', hasReference: true },
  { hasCase: true, caseLayout: 'single', hasReference: true },
  { hasCase: true, caseLayout: 'horizontal', hasReference: false },
  { hasCase: false, caseLayout: 'single', hasReference: true },
  { hasCase: false, caseLayout: 'single', hasReference: false },
]

/** 模板体形态矩阵（空/单行/多行/首尾空白/尾换行/占位符当正文）。 */
const BODY_MATRIX = ['', '正文', '  第一行\n第二行  ', '正文\n', 'p', '多行\n正文\t尾\t']

const roundSs10: GemSpecSnapshot = { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }

describe('byteEq 公理（三开关全关 + 无占位符 ⇒ 发送提示词 ≡ promptBody 逐字节）', () => {
  it('全角色矩阵 × 模板体形态：返回值与 promptBody 逐字节相等（首尾空白/制表符保真）', () => {
    for (const roles of ROLES_MATRIX) {
      for (const body of BODY_MATRIX) {
        expect(composeDrillPrompt(body, roles)).toBe(body)
      }
    }
  })

  it('options 各缺席形态两两逐字节相等（undefined/{}/undefined 键/canvasWidthPx 单独在位）', () => {
    for (const roles of ROLES_MATRIX) {
      for (const body of BODY_MATRIX) {
        const baseline = body
        expect(composeDrillPrompt(body, roles, undefined)).toBe(baseline)
        expect(composeDrillPrompt(body, roles, {})).toBe(baseline)
        expect(composeDrillPrompt(body, roles, { drillParams: undefined })).toBe(baseline)
        expect(composeDrillPrompt(body, roles, { canvasWidthPx: 1024 })).toBe(baseline)
      }
    }
  })

  it('含占位符但三开关全关（hasCase=false）：占位符当普通正文逐字节原样保留', () => {
    const body = '正文【案例参照图提示词】【水钻参数提示词】【蓝图效果提示词】尾'
    for (const roles of ROLES_MATRIX.filter((r) => !r.hasCase)) {
      expect(composeDrillPrompt(body, roles, {})).toBe(body)
    }
    // 案例开 + 占位符在位（对照）：占位符被片段替换——「关=原样保留」的等价表述
    expect(
      composeDrillPrompt(body, { hasCase: true, caseLayout: 'single', hasReference: true }, {}),
    ).not.toBe(body)
  })

  it('六层注入字面量恒缺席（三开关全开 + 三占位符齐备亦然——退场证明）', () => {
    const out = composeDrillPrompt(
      '开头\n【案例参照图提示词】\n【水钻参数提示词】\n【蓝图效果提示词】\n结尾',
      { hasCase: true, caseLayout: 'horizontal', hasReference: true },
      { drillParams: { specs: [roundSs10], materialAssetIds: [] }, blueprintPrompt: { text: '蓝图片段' } },
    )
    for (const literal of [
      '你是一位专业的钻石画', // ① 人设前言
      '【任务要求】', // ② 任务指令行壳
      '【贴钻指导规则】', // ③ 规则块（迁入 v2 seed 正文尾部，运行时零注入）
      '【模板风格补充】', // ④ 模板体包裹壳
      '请输出', // ⑤ 输出指令行
    ]) {
      expect(out).not.toContain(literal)
    }
    // ⑥ 图序计数行不再是结构面独立段——只作为案例片段默认内容出现在占位符替换位
    expect(out.indexOf('我上传了2 张图片：')).toBe(out.indexOf('开头\n') + '开头\n'.length)
    // 模板体自身字节全部在位（原样居中）
    expect(out.startsWith('开头\n')).toBe(true)
    expect(out.endsWith('\n结尾')).toBe(true)
  })
})

describe('每开关单开：仅占位符位置被替换，正文其余字节不动', () => {
  it('案例单开 + 占位符在位：替换为 autoCaseRefFragment 输出；正文前后缀逐字节保留', () => {
    const body = '前缀\n【案例参照图提示词】\n后缀'
    const roles: DrillPromptImageRoles = { hasCase: true, caseLayout: 'horizontal', hasReference: true }
    const out = composeDrillPrompt(body, roles)
    expect(out).toBe(`前缀\n${autoCaseRefFragment(roles)}\n后缀`)
    // 图序声明进入片段默认内容（复合对照变体）
    expect(out).toContain('我上传了2 张图片：')
    expect(out).toContain('1. 【图一 [image #1]：案例参照图】：案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。')
    expect(out).toContain('2. 【图二 [image #2]：参考图】：需要你处理的目标图像。')
    expect(out).toContain('请参照【图一 [image #1]：案例参照图】所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为【图二 [image #2]：参考图】生成对应的 Partial Drill 效果图。')
  })

  it('水钻单开 + 占位符在位：替换为【尺寸与钻规格】段；无附图交叉引用（内置形）', () => {
    const out = composeDrillPrompt(
      '头\n【水钻参数提示词】\n尾',
      { hasCase: false, caseLayout: 'single', hasReference: false },
      { drillParams: { specs: [roundSs10], materialAssetIds: [] }, canvasWidthPx: 1024 },
    )
    expect(out.startsWith('头\n')).toBe(true)
    expect(out.endsWith('\n尾')).toBe(true)
    expect(out).toContain('【尺寸与钻规格】')
    expect(out).toContain('  1 = R10 圆形 SS10（直径 2.8mm）')
    expect(out).not.toContain('【水钻参数提示词】')
  })

  it('蓝图单开 + 占位符在位：替换为调用侧预解析片段', () => {
    const out = composeDrillPrompt(
      '头【蓝图效果提示词】尾',
      { hasCase: false, caseLayout: 'single', hasReference: false },
      { blueprintPrompt: { text: '蓝图片段正文' } },
    )
    expect(out).toBe('头蓝图片段正文尾')
  })

  it('案例覆盖片段逐字节替换（casePromptFragment verbatim）；素材附图集并入图序', () => {
    const roles: DrillPromptImageRoles = {
      hasCase: true,
      caseLayout: 'vertical',
      hasReference: true,
      materials: ['custom-a'],
    }
    const out = composeDrillPrompt('【案例参照图提示词】', roles, { casePromptFragment: '用户改写的案例指引' })
    expect(out).toBe('用户改写的案例指引')
    // auto 默认内容 = 同 roles 附图集（素材图声明并入——图号连续）
    const auto = autoCaseRefFragment(roles)
    expect(auto).toContain('我上传了3 张图片：')
    expect(auto).toContain('3. 【图三 [image #3]：钻石素材图·custom-a】')
  })
})

describe('describeDrillImageOrder 旧输入形状输出（UI 徽标消费面兼容）', () => {
  it('case+reference → 图一/图二；无 case → 参考图占图一', () => {
    const both: DrillPromptImageRoles = { hasCase: true, caseLayout: 'horizontal', hasReference: true }
    expect(describeDrillImageOrder(both)).toMatchInlineSnapshot(`
      [
        {
          "figure": "一",
          "figureLabel": "案例参照图",
          "ordinal": 1,
          "role": "case",
        },
        {
          "figure": "二",
          "figureLabel": "参考图",
          "ordinal": 2,
          "role": "reference",
        },
      ]
    `)
    const refOnly: DrillPromptImageRoles = { hasCase: false, caseLayout: 'single', hasReference: true }
    expect(describeDrillImageOrder(refOnly)).toMatchInlineSnapshot(`
      [
        {
          "figure": "一",
          "figureLabel": "参考图",
          "ordinal": 1,
          "role": "reference",
        },
      ]
    `)
    const none: DrillPromptImageRoles = { hasCase: false, caseLayout: 'single', hasReference: false }
    expect(describeDrillImageOrder(none)).toMatchInlineSnapshot(`[]`)
  })
})
