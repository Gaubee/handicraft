/**
 * [lab-ux 6] 高级请求参数结构化编辑——纯函数层测试（lib/lab/advancedParams）：
 * - 注册表完整性（键唯一 / enum 必有 options / size 不入注册表）与值校验矩阵；
 * - JSON 字面量 parse/format（数字/字符串/布尔/对象/非法）；
 * - 序列化确定性（注册表序 + 未知键原序；空对象 → ''）；
 * - 尺寸字符串 ⇄ 结构化（旧载荷兼容回填）+ 比例分组快选数据（标准集 + 自定义入列）。
 */
import { describe, expect, it } from 'vitest'
import {
  ADVANCED_KNOWN_FIELDS,
  ADVANCED_KNOWN_KEYS,
  formatJsonValueLiteral,
  formatSizeString,
  parseJsonValueLiteral,
  parseSizeString,
  serializeAdvancedParams,
  sizePresetGroupsFor,
  validateKnownFieldValue,
} from '$lib/lab/advancedParams'

describe('已知字段注册表（可扩展冻结初始集）', () => {
  it('初始集 = Owner 常用集；键唯一；enum 必有 options；size 不入注册表（尺寸走专属通道）', () => {
    expect(ADVANCED_KNOWN_FIELDS.map((f) => f.key)).toEqual([
      'quality',
      'background',
      'output_format',
      'output_compression',
      'n',
      'moderation',
      'input_fidelity',
    ])
    expect(new Set(ADVANCED_KNOWN_FIELDS.map((f) => f.key)).size).toBe(ADVANCED_KNOWN_FIELDS.length)
    for (const field of ADVANCED_KNOWN_FIELDS) {
      if (field.type === 'enum') expect(field.options?.length ?? 0).toBeGreaterThan(0)
    }
    expect(ADVANCED_KNOWN_KEYS.has('size')).toBe(false)
  })

  it('值校验矩阵：enum 越界 / 非法数字 / 越界 / 非整数', () => {
    const quality = ADVANCED_KNOWN_FIELDS.find((f) => f.key === 'quality')!
    expect(validateKnownFieldValue(quality, 'high')).toBeNull()
    expect(validateKnownFieldValue(quality, 'ultra')).toContain('quality')
    const compression = ADVANCED_KNOWN_FIELDS.find((f) => f.key === 'output_compression')!
    expect(validateKnownFieldValue(compression, 80)).toBeNull()
    expect(validateKnownFieldValue(compression, 101)).toContain('不应大于')
    expect(validateKnownFieldValue(compression, 50.5)).toContain('整数')
    expect(validateKnownFieldValue(compression, '80')).toContain('数字')
    const n = ADVANCED_KNOWN_FIELDS.find((f) => f.key === 'n')!
    expect(validateKnownFieldValue(n, 0)).toContain('不应小于')
  })
})

describe('JSON 字面量 parse/format（自定义 key-value 的 value 表达）', () => {
  it('合法字面量：数字/字符串/布尔/null/对象/数组', () => {
    expect(parseJsonValueLiteral('42')).toEqual({ ok: true, value: 42 })
    expect(parseJsonValueLiteral('"png"')).toEqual({ ok: true, value: 'png' })
    expect(parseJsonValueLiteral('true')).toEqual({ ok: true, value: true })
    expect(parseJsonValueLiteral('null')).toEqual({ ok: true, value: null })
    expect(parseJsonValueLiteral('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } })
  })

  it('非法字面量：裸文本/未闭合（错误信号不落库的判定基）', () => {
    const bad = parseJsonValueLiteral('abc')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('JSON 字面量解析失败')
    expect(parseJsonValueLiteral('{"a":').ok).toBe(false)
  })

  it('format：value → 字面量（round-trip）', () => {
    expect(formatJsonValueLiteral(42)).toBe('42')
    expect(formatJsonValueLiteral('png')).toBe('"png"')
    expect(formatJsonValueLiteral({ a: 1 })).toBe('{"a":1}')
    const formatted = formatJsonValueLiteral([1, 'x', false])
    const reparsed = parseJsonValueLiteral(formatted)
    expect(reparsed.ok).toBe(true)
    if (reparsed.ok) expect(reparsed.value).toEqual([1, 'x', false])
  })
})

describe('序列化（与 form.advancedJson 双向同源；确定性键序）', () => {
  it('已知字段按注册表序在前 + 未知键按插入序在后（2-space）', () => {
    const out = serializeAdvancedParams({ seed: 7, quality: 'high', zzz: '"last"', background: 'transparent' })
    expect(out).toBe(
      ['{', '  "quality": "high",', '  "background": "transparent",', '  "seed": 7,', '  "zzz": "\\"last\\""', '}'].join('\n'),
    )
  })

  it('空对象 → 空串（advancedDirty「trim !== \'\'」口径对齐）', () => {
    expect(serializeAdvancedParams({})).toBe('')
  })
})

describe('尺寸：字符串 ⇄ 结构化 + 快选分组', () => {
  it('旧载荷兼容：\'1024x1536\' → {1024,1536}；malformed → null', () => {
    expect(parseSizeString('1024x1536')).toEqual({ width: 1024, height: 1536 })
    expect(parseSizeString(' 1536x1024 ')).toEqual({ width: 1536, height: 1024 })
    expect(parseSizeString('1024×1024')).toBeNull()
    expect(parseSizeString('wxxx')).toBeNull()
    expect(parseSizeString('')).toBeNull()
  })

  it('format round-trip', () => {
    expect(formatSizeString({ width: 1024, height: 1024 })).toBe('1024x1024')
    expect(parseSizeString(formatSizeString({ width: 1792, height: 1024 }))).toEqual({ width: 1792, height: 1024 })
  })

  it('标准分组 = 1:1/3:2/2:3/7:4/4:7（OpenAI 标准尺寸集）；标准值在列时不追加自定义组', () => {
    const groups = sizePresetGroupsFor(null)
    expect(groups.map((g) => g.ratio)).toEqual(['1:1', '3:2', '2:3', '7:4', '4:7'])
    expect(groups[0]?.sizes).toEqual([{ width: 1024, height: 1024 }])
    expect(sizePresetGroupsFor({ width: 1024, height: 1024 })).toHaveLength(5)
  })

  it('非标当前值 → 追加「自定义」组（Owner：平铺尺寸 + 自定义已输入值）', () => {
    const groups = sizePresetGroupsFor({ width: 640, height: 480 })
    const last = groups[groups.length - 1]!
    expect(last.ratio).toContain('自定义')
    expect(last.sizes).toEqual([{ width: 640, height: 480 }])
  })
})
