/**
 * 高级请求参数结构化编辑（improve-lab-advanced-ux 点 6）——纯函数层 + 字段注册表。
 *
 * 规范来源：Owner 2026-09-21 六点之六——「默认基于常用的 openai images 提供可视化结构化
 * 编辑（有些字段是已知的）……未知字段＝自定义可删减 key-value，value 始终用 JSON 字面量
 * 表达……尺寸不手写 wwwwxhhhh，两个 input + icon-button 展开 Dialog 按比例分组快选」。
 *
 * 正交意图：
 * 1. [2026-09-21 Owner] OpenAI images 已知字段注册表（可视化专属控件数据源；注册表可扩展——
 *    新增条目自动获得控件与序列化位，不需要改组件）。
 * 2. [2026-09-21 Semantics] 未知字段 = 自定义 key-value：value 用 JSON 字面量严格 parse
 *    （非法 → 错误信号不落库）；序列化保持注册表序 + 未知键原序（确定性输出）。
 * 3. [2026-09-21 Compat] 尺寸 'WxH' 字符串 ⇄ {width,height} 双向（form.size 存储层不变，
 *    旧载荷字符串回填双 input）；OpenAI 标准尺寸集按比例分组 + 自定义已输入值入列。
 *
 * 纪律：纯函数——不 import Svelte、不触 DOM、不做 IO；不重定义 parseAdvancedJson
 * （解析底座 = lib/api/client，本模块只做结构化编排）。
 */

// ---------------------------------------------------------------------------
// 已知字段注册表（OpenAI images 常用集——gpt-image 系列；可扩展）
// ---------------------------------------------------------------------------

export type AdvancedKnownFieldType = 'enum' | 'number'

export interface AdvancedKnownField {
  key: string
  /** 中文标签（控件行名）。 */
  label: string
  type: AdvancedKnownFieldType
  /** enum 候选（含 'auto' 类端点默认）。 */
  options?: readonly string[]
  min?: number
  max?: number
  step?: number
  integer?: boolean
  hint?: string
}

/**
 * 已知字段注册表（冻结初始集，可扩展）：quality / background / output_format /
 * output_compression / n / moderation / input_fidelity。
 * `size` 不入注册表——尺寸由专属双 input + 快选 Dialog 编辑（form.size 通道，非 JSON 键）。
 */
export const ADVANCED_KNOWN_FIELDS: readonly AdvancedKnownField[] = [
  { key: 'quality', label: '质量', type: 'enum', options: ['auto', 'high', 'medium', 'low'] },
  { key: 'background', label: '背景', type: 'enum', options: ['auto', 'transparent', 'opaque'] },
  { key: 'output_format', label: '输出格式', type: 'enum', options: ['png', 'jpeg', 'webp'] },
  { key: 'output_compression', label: '输出压缩', type: 'number', min: 0, max: 100, integer: true, step: 1 },
  {
    key: 'n',
    label: '每次请求张数',
    type: 'number',
    min: 1,
    max: 10,
    integer: true,
    step: 1,
    hint: '本应用恒以 n=1 单图逐请求并发——此键仅供特殊端点兼容',
  },
  { key: 'moderation', label: '内容审核', type: 'enum', options: ['auto', 'low'] },
  { key: 'input_fidelity', label: '输入保真（edits）', type: 'enum', options: ['low', 'high'] },
]

/** 注册表键集（未知字段判定的基）。 */
export const ADVANCED_KNOWN_KEYS: ReadonlySet<string> = new Set(ADVANCED_KNOWN_FIELDS.map((f) => f.key))

/** 已知字段值校验：合法返回 null；非法返回中文错误（可视化控件行内错误的判定基）。 */
export function validateKnownFieldValue(field: AdvancedKnownField, value: unknown): string | null {
  if (field.type === 'enum') {
    if (field.options === undefined || !field.options.includes(String(value))) {
      return `${field.label}（${field.key}）应为 ${field.options?.join(' / ') ?? '…'}`
    }
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field.label}（${field.key}）应为数字`
  if (field.integer && !Number.isInteger(value)) return `${field.label}（${field.key}）应为整数`
  if (field.min !== undefined && value < field.min) return `${field.label}（${field.key}）不应小于 ${field.min}`
  if (field.max !== undefined && value > field.max) return `${field.label}（${field.key}）不应大于 ${field.max}`
  return null
}

// ---------------------------------------------------------------------------
// 自定义 key-value 的 JSON 字面量（value 始终以字面量表达——严格 parse）
// ---------------------------------------------------------------------------

export type JsonLiteralParse = { ok: true; value: unknown } | { ok: false; error: string }

/** 严格 parse：合法 JSON 字面量（含对象/数组/字符串/数字/布尔/null）。 */
export function parseJsonValueLiteral(text: string): JsonLiteralParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `JSON 字面量解析失败：${detail}` }
  }
}

/** value → 字面量展示/编辑形态（JSON.stringify；undefined 防御落 null）。 */
export function formatJsonValueLiteral(value: unknown): string {
  return JSON.stringify(value ?? null) ?? 'null'
}

// ---------------------------------------------------------------------------
// 序列化（与 form.advancedJson 字符串双向同源；确定性键序）
// ---------------------------------------------------------------------------

/**
 * 序列化为 Advanced JSON 文本：已知字段按注册表序在前 + 其余键按插入序在后；
 * 2-space 缩进；空对象 → ''（与 advancedDirty「trim !== ''」口径对齐）。
 */
export function serializeAdvancedParams(value: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  for (const field of ADVANCED_KNOWN_FIELDS) {
    if (field.key in value) ordered[field.key] = value[field.key]
  }
  for (const key of Object.keys(value)) {
    if (!(key in ordered)) ordered[key] = value[key]
  }
  return Object.keys(ordered).length === 0 ? '' : JSON.stringify(ordered, null, 2)
}

// ---------------------------------------------------------------------------
// 尺寸（'WxH' 字符串存储层 ⇄ 结构化；旧载荷兼容 + 比例分组快选数据）
// ---------------------------------------------------------------------------

export interface SizeValue {
  width: number
  height: number
}

/** '1024x1536' → {1024,1536}（旧载荷回填兼容；malformed → null）。 */
export function parseSizeString(size: string): SizeValue | null {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(size.trim())
  if (match === null) return null
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function formatSizeString(value: SizeValue): string {
  return `${value.width}x${value.height}`
}

export interface SizePresetGroup {
  /** 比例标签（分组标题）。 */
  ratio: string
  sizes: readonly SizeValue[]
}

/** OpenAI 标准尺寸集（gpt-image 三档 + dall-e-3 大档），按比例分组。 */
export const OPENAI_SIZE_PRESET_GROUPS: readonly SizePresetGroup[] = [
  { ratio: '1:1', sizes: [{ width: 1024, height: 1024 }] },
  { ratio: '3:2', sizes: [{ width: 1536, height: 1024 }] },
  { ratio: '2:3', sizes: [{ width: 1024, height: 1536 }] },
  { ratio: '7:4', sizes: [{ width: 1792, height: 1024 }] },
  { ratio: '4:7', sizes: [{ width: 1024, height: 1792 }] },
]

/**
 * 快选分组视图：标准组 + 「自定义」组（当前输入值不在标准集时追加——Owner：
 * 「平铺尺寸 + 自定义已输入值」）。纯函数。
 */
export function sizePresetGroupsFor(current: SizeValue | null): readonly SizePresetGroup[] {
  if (current === null) return OPENAI_SIZE_PRESET_GROUPS
  const inPreset = OPENAI_SIZE_PRESET_GROUPS.some((g) =>
    g.sizes.some((s) => s.width === current.width && s.height === current.height),
  )
  if (inPreset) return OPENAI_SIZE_PRESET_GROUPS
  const ratio = `${current.width}:${current.height}`
  return [...OPENAI_SIZE_PRESET_GROUPS, { ratio: `${ratio}（自定义）`, sizes: [current] }]
}
