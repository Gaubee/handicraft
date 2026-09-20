/**
 * placeholders 切片 2 测试：效果提示词占位符体系（add-lab-effect-prompt-placeholders design §1/§3）
 * + [lab-ux 2] append/removeEffectPromptPlaceholder 开关即注入/移除纯函数矩阵
 * （improve-lab-advanced-ux design §2——UI toggle 消费面的单一真源）。
 * - substitution 纯函数矩阵（替换/多占位符/多次出现/无键保留/空 plan 恒等）；
 * - append/remove 矩阵（默认式 \n【占位符】\n / 幂等 / 整行移除 / 行内只剥文本 / round-trip）；
 * - composeDrillPrompt 消费：案例（auto CASE_DESC / 覆盖 / 关=原样）、水钻（覆盖逐字节 / 缺占位符不注入）、
 *   蓝图（预解析片段替换 / 键缺席保留）；
 * - 零行为红线：三开关全关 + promptBody 无占位符 → 输出与两参形态逐字节相等
 *   （对旧字节基线的逐字节锁死另见 prompt.byteEq.test.ts——本文件锁形态等价矩阵）。
 */
import { describe, expect, it } from 'vitest'
import { composeDrillPrompt, autoCasePromptFragment } from '$lib/presets/effectRefs'
import {
  appendEffectPromptPlaceholder,
  EFFECT_PROMPT_PLACEHOLDERS,
  hasEffectPromptPlaceholder,
  removeEffectPromptPlaceholder,
  substituteEffectPromptPlaceholders,
} from '$lib/lab/prompt'
import type { GemSpecSnapshot } from '$lib/engine'

const ROLES_MATRIX = [
  { hasCase: true, caseLayout: 'horizontal' as const, hasReference: true },
  { hasCase: true, caseLayout: 'single' as const, hasReference: false },
  { hasCase: false, caseLayout: 'single' as const, hasReference: true },
  { hasCase: false, caseLayout: 'single' as const, hasReference: false },
]

const roundSs10: GemSpecSnapshot = { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }

describe('substituteEffectPromptPlaceholders 纯函数矩阵', () => {
  it('空 plan 恒等返回（红线前提）', () => {
    const body = '正文【案例参照图提示词】中段【水钻参数提示词】尾【蓝图效果提示词】'
    expect(substituteEffectPromptPlaceholders(body, {})).toBe(body)
    expect(substituteEffectPromptPlaceholders('', {})).toBe('')
  })

  it('有键替换 + 无键保留（同一 body 混合三态）', () => {
    const body = 'A【案例参照图提示词】B【水钻参数提示词】C【蓝图效果提示词】D'
    const out = substituteEffectPromptPlaceholders(body, {
      caseRef: { text: '案例片段' },
      drillParams: { text: '水钻片段' },
    })
    expect(out).toBe('A案例片段B水钻片段C【蓝图效果提示词】D')
  })

  it('多次出现全量替换（replaceAll 语义）', () => {
    const body = '【案例参照图提示词】前后【案例参照图提示词】'
    expect(substituteEffectPromptPlaceholders(body, { caseRef: { text: 'X' } })).toBe('X前后X')
  })

  it('片段文本可含另一占位符字面量（不递归展开——一次性替换）', () => {
    const out = substituteEffectPromptPlaceholders('【案例参照图提示词】', {
      caseRef: { text: '见【水钻参数提示词】' },
    })
    expect(out).toBe('见【水钻参数提示词】')
  })

  it('多行片段原文进位（换行保真）', () => {
    const fragment = '【尺寸与钻规格】\n  1 = R10 圆形 SS10（直径 2.8mm）'
    const out = substituteEffectPromptPlaceholders('头\n【水钻参数提示词】\n尾', { drillParams: { text: fragment } })
    expect(out).toBe(`头\n${fragment}\n尾`)
  })

  it('hasEffectPromptPlaceholder 判定基（发起面板缺失提示的信号源）', () => {
    const body = '只有【蓝图效果提示词】'
    expect(hasEffectPromptPlaceholder(body, 'blueprint')).toBe(true)
    expect(hasEffectPromptPlaceholder(body, 'caseRef')).toBe(false)
    expect(hasEffectPromptPlaceholder(body, 'drillParams')).toBe(false)
    expect(Object.values(EFFECT_PROMPT_PLACEHOLDERS)).toEqual([
      '【案例参照图提示词】',
      '【水钻参数提示词】',
      '【蓝图效果提示词】',
    ])
  })
})

describe('[lab-ux 2] appendEffectPromptPlaceholder：开关即注入（Owner 默认式 \\n【占位符】\\n）', () => {
  it('缺席 → 追加末尾（Owner 默认插入式：前后换行包裹）', () => {
    expect(appendEffectPromptPlaceholder('正文', 'blueprint')).toBe('正文\n【蓝图效果提示词】\n')
    expect(appendEffectPromptPlaceholder('第一行\n第二行', 'caseRef')).toBe(
      '第一行\n第二行\n【案例参照图提示词】\n',
    )
  })

  it('末尾已有换行 → 剥尾换行再注入（不产生空行翻倍）', () => {
    expect(appendEffectPromptPlaceholder('正文\n', 'drillParams')).toBe('正文\n【水钻参数提示词】\n')
  })

  it('空 body → 不落孤立前置换行', () => {
    expect(appendEffectPromptPlaceholder('', 'caseRef')).toBe('【案例参照图提示词】\n')
  })

  it('幂等：已存在于任何位置（含句中）→ 原样返回', () => {
    expect(appendEffectPromptPlaceholder('见【案例参照图提示词】这里', 'caseRef')).toBe(
      '见【案例参照图提示词】这里',
    )
    expect(appendEffectPromptPlaceholder('【水钻参数提示词】\n尾行', 'drillParams')).toBe(
      '【水钻参数提示词】\n尾行',
    )
  })

  it('只动本效果占位符（他效果占位符不注入不干扰）', () => {
    const out = appendEffectPromptPlaceholder('【案例参照图提示词】', 'blueprint')
    expect(out).toBe('【案例参照图提示词】\n【蓝图效果提示词】\n')
  })
})

describe('[lab-ux 2] removeEffectPromptPlaceholder：开关即移除', () => {
  it('默认插入式的逆：整行移除（连同该行换行）', () => {
    expect(removeEffectPromptPlaceholder('A\n【蓝图效果提示词】\nB', 'blueprint')).toBe('A\nB')
    expect(removeEffectPromptPlaceholder('正文\n【水钻参数提示词】\n', 'drillParams')).toBe('正文')
  })

  it('注入幂等式产物 round-trip：append 后 remove 还原', () => {
    const body = '第一行\n第二行'
    expect(removeEffectPromptPlaceholder(appendEffectPromptPlaceholder(body, 'caseRef'), 'caseRef')).toBe(body)
    expect(removeEffectPromptPlaceholder(appendEffectPromptPlaceholder('', 'caseRef'), 'caseRef')).toBe('')
  })

  it('行内出现只剥占位符文本（句子与换行结构不动）', () => {
    expect(removeEffectPromptPlaceholder('见【案例参照图提示词】这里', 'caseRef')).toBe('见这里')
    expect(removeEffectPromptPlaceholder('A【水钻参数提示词】B', 'drillParams')).toBe('AB')
  })

  it('多次出现全量移除（replaceAll 语义）', () => {
    expect(removeEffectPromptPlaceholder('【蓝图效果提示词】x【蓝图效果提示词】', 'blueprint')).toBe('x')
  })

  it('不含占位符 → 恒等返回；他效果占位符不受影响', () => {
    const body = '普通正文'
    expect(removeEffectPromptPlaceholder(body, 'blueprint')).toBe(body)
    expect(removeEffectPromptPlaceholder('【案例参照图提示词】\n正文', 'drillParams')).toBe(
      '【案例参照图提示词】\n正文',
    )
  })

  it('多行包裹中的占位符行删除，独立空行保留', () => {
    // 'a、空行、占位符行、空行、b' → 占位符行消失，两侧空行各自保留
    expect(removeEffectPromptPlaceholder('a\n\n【蓝图效果提示词】\n\nb', 'blueprint')).toBe('a\n\n\nb')
  })
})

describe('composeDrillPrompt 占位符消费', () => {
  it('案例占位符：hasCase 时替换为 CASE_DESC 自动文案；案例关（hasCase=false）原样保留', () => {
    const on = composeDrillPrompt(
      '正文\n【案例参照图提示词】',
      { hasCase: true, caseLayout: 'horizontal', hasReference: true },
    )
    expect(on).toContain('案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。')
    expect(on).not.toContain('【案例参照图提示词】')
    const off = composeDrillPrompt(
      '正文\n【案例参照图提示词】',
      { hasCase: false, caseLayout: 'single', hasReference: true },
    )
    expect(off).toContain('【案例参照图提示词】')
    expect(off).not.toContain('案例参照合成图')
  })

  it('案例占位符覆盖文本逐字节替换（casePromptFragment）；结构面角色声明仍用自动文案（design §6）', () => {
    const out = composeDrillPrompt(
      '头【案例参照图提示词】尾',
      { hasCase: true, caseLayout: 'vertical', hasReference: false },
      { casePromptFragment: '用户改写的案例指引' },
    )
    expect(out).toContain('头用户改写的案例指引尾')
    // 结构面不变：附图角色声明块（1. 【图一 [image #1]：案例参照图】：…）仍为 CASE_DESC 自动文案
    expect(out).toContain('1. 【图一 [image #1]：案例参照图】：案例参照合成图：上半为未贴钻的原图')
  })

  it('autoCasePromptFragment = CASE_DESC 单一真源（Dialog 预填共用）', () => {
    expect(autoCasePromptFragment('single')).toBe('案例参照图：一张已完成的 Partial Drill（局部贴钻）效果图。')
    for (const layout of ['horizontal', 'vertical', 'single'] as const) {
      const out = composeDrillPrompt(
        '【案例参照图提示词】',
        { hasCase: true, caseLayout: layout, hasReference: true },
      )
      expect(out).toContain(autoCasePromptFragment(layout))
    }
  })

  it('水钻占位符覆盖文本逐字节替换（drillParams.promptFragment）；缺席 = buildDrillSpecSection 自动段', () => {
    const override = composeDrillPrompt(
      '【水钻参数提示词】',
      { hasCase: false, caseLayout: 'single', hasReference: true },
      { drillParams: { specs: [roundSs10], materialAssetIds: [], promptFragment: '用户改写的水钻段' } },
    )
    expect(override).toContain('用户改写的水钻段')
    expect(override).not.toContain('【尺寸与钻规格】')
    const auto = composeDrillPrompt(
      '【水钻参数提示词】',
      { hasCase: false, caseLayout: 'single', hasReference: true },
      { drillParams: { specs: [roundSs10], materialAssetIds: [] } },
    )
    expect(auto).toContain('【尺寸与钻规格】')
    expect(auto).toContain('  1 = R10 圆形 SS10（直径 2.8mm）')
  })

  it('水钻开 + 缺占位符 = 正文不注入且无独立段尾（不静默追加）', () => {
    const out = composeDrillPrompt(
      '只有正文',
      { hasCase: false, caseLayout: 'single', hasReference: true },
      { drillParams: { specs: [roundSs10], materialAssetIds: [] } },
    )
    expect(out).not.toContain('【尺寸与钻规格】')
    expect(out).not.toContain('只允许使用以下钻')
  })

  it('水钻关 + 占位符存在 = 原样保留（占位符字面量随请求可见——design §1 冻结裁决）', () => {
    const out = composeDrillPrompt('正文【水钻参数提示词】尾', {
      hasCase: false,
      caseLayout: 'single',
      hasReference: true,
    })
    expect(out).toContain('正文【水钻参数提示词】尾')
  })

  it('蓝图占位符：blueprintPrompt 存在 = 预解析片段替换；键缺席 = 原样保留', () => {
    const on = composeDrillPrompt(
      '正文\n【蓝图效果提示词】',
      { hasCase: false, caseLayout: 'single', hasReference: true },
      { blueprintPrompt: { text: '【任务：施工蓝图转换】预解析骨架' } },
    )
    expect(on).toContain('【任务：施工蓝图转换】预解析骨架')
    expect(on).not.toContain('【蓝图效果提示词】')
    const off = composeDrillPrompt('正文\n【蓝图效果提示词】', {
      hasCase: false,
      caseLayout: 'single',
      hasReference: true,
    })
    expect(off).toContain('【蓝图效果提示词】')
  })

  it('三开关全开 + 三占位符齐备：全部替换且互不干扰', () => {
    const out = composeDrillPrompt(
      '开头\n【案例参照图提示词】\n【水钻参数提示词】\n【蓝图效果提示词】\n结尾',
      { hasCase: true, caseLayout: 'single', hasReference: true },
      {
        drillParams: { specs: [roundSs10], materialAssetIds: [] },
        blueprintPrompt: { text: '蓝图预解析' },
      },
    )
    expect(out).toContain('开头\n案例参照图：一张已完成的')
    expect(out).toContain('【尺寸与钻规格】')
    expect(out).toContain('蓝图预解析')
    expect(out).toContain('结尾')
    for (const literal of Object.values(EFFECT_PROMPT_PLACEHOLDERS)) {
      expect(out).not.toContain(literal)
    }
  })
})

describe('零行为红线（design §1）：三开关全关 + 无占位符 → 逐字节相等', () => {
  it('空 options === 两参形态（全角色矩阵 × 模板体形态）', () => {
    for (const roles of ROLES_MATRIX) {
      for (const body of ['', '正文', '  第一行\n第二行  ']) {
        const baseline = composeDrillPrompt(body, roles)
        expect(composeDrillPrompt(body, roles, undefined)).toBe(baseline)
        expect(composeDrillPrompt(body, roles, {})).toBe(baseline)
        expect(composeDrillPrompt(body, roles, { drillParams: undefined })).toBe(baseline)
      }
    }
  })

  it('含占位符但全关：输出与「占位符当普通正文」的两参形态逐字节相等（关=原样保留的等价表述）', () => {
    const body = '正文【案例参照图提示词】【水钻参数提示词】【蓝图效果提示词】'
    for (const roles of ROLES_MATRIX) {
      expect(composeDrillPrompt(body, roles, {})).toBe(composeDrillPrompt(body, roles))
    }
  })
})
