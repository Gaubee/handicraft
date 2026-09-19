/**
 * 模板高级选项（水钻参数配置 / 蓝图效果）正交数据契约——消费侧类型与 validation。
 *
 * 规范来源：openspec add-lab-drill-params-and-blueprint design §0.2（Owner 2026-09-20
 * 「正交的可以独立启用的『高级选项』」）+ §1.1（.gemtpl v2 正交键）+ §1.2（任务侧快照）。
 *
 * 正交意图：
 * 1. [2026-09-20 0.1][Owner] 模板侧正交键消费契约：`GemtplDrillParams` / `GemtplBlueprint`
 *    （schema 冻结宿主 = add-gem-catalog W0 §1.3 修订版，persistence/labFile.ts 已冻结键位——
 *    本模块是**消费侧**类型与 validation，不重定义文件 schema；键缺席 = 从未配置）。
 *    `enabled` 标志保留在键内：编辑器关灯不丢已填清单（数据保留是 UX 底线）。
 * 2. [2026-09-20 0.1] 写入门 validation（模板 store 提交前消费）：enabled⇒specs≥1、specKey
 *    去重（重复 = typed error 拒写）、physical 宽高正数、blueprint.refs 去重且 ≤2；
 *    清单超软上限（默认 8）只警告不阻断（gemspec R1 议题 12 继承）。
 * 3. [2026-09-20 0.1] workflowMode 退役迁移口径（design §0.2-4）：gemtpl/gemgen v1 两键缺席 =
 *    两开关关；gemgen 旧 `mode` → `requestMode` 只读映射（迁移本体已落 labFile v1→v2 注册表，
 *    本模块只登记消费口径——类型级断言见 src/tests/lab/advancedOptions.contract.test.ts）。
 * 4. [2026-09-20 0.1] 任务侧快照单一真源对齐：`LabTaskDrillParams` / `LabTaskBlueprint`
 *    以轨 B 的 lab/stages.ts 为唯一定义点，本模块 re-export（禁止平行第二定义）。
 *
 * 纪律：纯函数层——不 import Svelte、不触 DOM、不做 IO；typed error 带点分路径
 * （沿 labFile.LabFileFieldError 文案风格，错误家族独立于持久化层）。
 */

import type { PhysicalCanvas } from '$lib/engine'

// ---------------------------------------------------------------------------
// 模板侧正交键（消费侧类型；design §1.1 逐字段冻结）
// ---------------------------------------------------------------------------

/**
 * 水钻参数配置（模板级高级选项）。键缺席 = 从未配置；enabled=false = 配置过但当前关闭。
 * 形状与 labFile.DrillParamsConfig（.gemtpl v2 drillParams 键）结构等价。
 */
export interface GemtplDrillParams {
  enabled: boolean
  /** 可用钻清单：canonical specKey 有序数组（内置 'round-ss10' / 自定义 'custom-<assetId>'）。
   *  数组序即编号序——run 时物化为 GemSpecSnapshot[]（ordinal = 1..n 按数组序）。 */
  specs: string[]
  /** 可选尺寸声明（结构化，可选——Owner 3.1「尺寸信息可选」）。 */
  physical?: PhysicalCanvas
}

/**
 * 蓝图效果（模板级高级选项，beta）。策略不入模板（任务级可选，design §4.3）。
 * `refs` 键位超出 labFile.BlueprintToggle（W0 只冻结开关）——labFile 侧 refs 键接线归 4.1。
 */
export interface GemtplBlueprint {
  enabled: boolean
  /** 蓝图参考图：素材库资产弱引用（≤2 张，去重）。 */
  refs?: string[]
}

// ---------------------------------------------------------------------------
// typed error 与软上限
// ---------------------------------------------------------------------------

/** 高级选项 validation 错误（写入门拒写；点分路径如 drillParams.specs.2）。 */
export class GemtplAdvancedOptionError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly found: string,
    note?: string,
  ) {
    super(
      `高级选项字段不合法：${path} 应为 ${expected}，实际为 ${found}${note ? `（${note}）` : ''}。`,
    )
    this.name = 'GemtplAdvancedOptionError'
  }
}

/** 钻清单软上限（可读性警告不阻断；gemspec R1 议题 12——超出只警告，上限值试产可调）。 */
export const DRILL_SPEC_LIST_SOFT_LIMIT = 8

/** 蓝图参考图上限（硬上限——超出拒写）。 */
export const BLUEPRINT_REFS_MAX = 2

/** 非阻断警告（软上限类；消费方以 code 判别，不抛错）。 */
export interface AdvancedOptionWarning {
  code: 'specs-over-soft-limit'
  message: string
}

export interface ValidationOutcome {
  warnings: readonly AdvancedOptionWarning[]
}

// ---------------------------------------------------------------------------
// 写入门 validation（design §1.1「裁决与禁令」逐条）
// ---------------------------------------------------------------------------

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'string') return `string(${value.length})`
  return typeof value
}

/** specKey 串校验：非空且不含空白（canonical 键——沿 labFile.expectSpecKeyString 同口径）。 */
function expectSpecKey(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value)) {
    throw new GemtplAdvancedOptionError(path, '非空且不含空白的 specKey（canonical 键）', describeValue(value))
  }
  return value
}

/**
 * 水钻参数配置校验（提交/换绑前消费）：
 * - specs 条目必须合法 specKey，且**去重**（重复 = 拒写——身份唯一性禁令）；
 * - enabled=true ⇒ specs ≥ 1（enabled=false + 空清单合法 = 关灯空态；
 *   enabled=false + 已填清单合法 = 关灯不丢数据）；
 * - physical 存在 ⇒ 宽高正数（anchorSource ∈ declared|default）；
 * - specs 超软上限（默认 8）→ 返回警告，不阻断。
 */
export function validateGemtplDrillParams(value: GemtplDrillParams, path = 'drillParams'): ValidationOutcome {
  if (!Array.isArray(value.specs)) {
    throw new GemtplAdvancedOptionError(`${path}.specs`, 'specKey 字符串数组', describeValue(value.specs))
  }
  const seen = new Set<string>()
  value.specs.forEach((entry, index) => {
    const key = expectSpecKey(entry, `${path}.specs.${index}`)
    if (seen.has(key)) {
      throw new GemtplAdvancedOptionError(`${path}.specs.${index}`, '不重复的 specKey（清单内去重）', key)
    }
    seen.add(key)
  })
  if (value.enabled && value.specs.length < 1) {
    throw new GemtplAdvancedOptionError(`${path}.specs`, '启用时至少 1 条（enabled=true ⇒ specs≥1）', '空清单')
  }
  if (value.physical !== undefined) {
    const p = value.physical
    const physicalPath = `${path}.physical`
    for (const dim of ['widthMm', 'heightMm'] as const) {
      if (typeof p[dim] !== 'number' || !Number.isFinite(p[dim]) || p[dim] <= 0) {
        throw new GemtplAdvancedOptionError(`${physicalPath}.${dim}`, '正数（mm）', describeValue(p[dim]))
      }
    }
    if (p.anchorSource !== 'declared' && p.anchorSource !== 'default') {
      throw new GemtplAdvancedOptionError(
        `${physicalPath}.anchorSource`,
        "'declared' | 'default'",
        describeValue(p.anchorSource),
      )
    }
  }
  if (value.enabled && value.specs.length > DRILL_SPEC_LIST_SOFT_LIMIT) {
    return {
      warnings: [
        {
          code: 'specs-over-soft-limit',
          message: `钻清单已 ${value.specs.length} 条（>${DRILL_SPEC_LIST_SOFT_LIMIT}），编号可辨性可能下降`,
        },
      ],
    }
  }
  return { warnings: [] }
}

/**
 * 蓝图效果校验：refs 条目非空串、**去重**、≤2（BLUEPRINT_REFS_MAX——超出拒写）；
 * enabled 与 refs 数量无强约束（开蓝图不强制参考图）。
 */
export function validateGemtplBlueprint(value: GemtplBlueprint, path = 'blueprint'): ValidationOutcome {
  if (value.refs !== undefined) {
    if (!Array.isArray(value.refs)) {
      throw new GemtplAdvancedOptionError(`${path}.refs`, 'assetId 字符串数组', describeValue(value.refs))
    }
    if (value.refs.length > BLUEPRINT_REFS_MAX) {
      throw new GemtplAdvancedOptionError(
        `${path}.refs`,
        `至多 ${BLUEPRINT_REFS_MAX} 张蓝图参考图`,
        `${value.refs.length} 条`,
      )
    }
    const seen = new Set<string>()
    value.refs.forEach((entry, index) => {
      const assetId = typeof entry === 'string' && entry.length > 0 ? entry : null
      if (assetId === null) {
        throw new GemtplAdvancedOptionError(`${path}.refs.${index}`, '非空 assetId 字符串', describeValue(entry))
      }
      if (seen.has(assetId)) {
        throw new GemtplAdvancedOptionError(`${path}.refs.${index}`, '不重复的 assetId（列表内去重）', assetId)
      }
      seen.add(assetId)
    })
  }
  return { warnings: [] }
}

// ---------------------------------------------------------------------------
// 读面归一（workflowMode 退役迁移口径：两键缺席 = 两开关关）
// ---------------------------------------------------------------------------

/**
 * gemtpl v1/v2 读面归一（design §0.2-4 / §1.1）：`drillParams`/`blueprint` 键缺席 =
 * 从未配置（enabled=false 空数据）。模板 store / 发起面板消费归一形态，不各自判空。
 * 不做 validation（读面宽容——脏数据归 undefined 由调用方按防御处理；写入门在上）。
 */
export interface GemtplAdvancedOptions {
  drillParams: GemtplDrillParams
  blueprint: GemtplBlueprint
}

export const GEMTPL_ADVANCED_OPTIONS_OFF: GemtplAdvancedOptions = Object.freeze({
  drillParams: Object.freeze({ enabled: false, specs: Object.freeze([] as string[]) }) as GemtplDrillParams,
  blueprint: Object.freeze({ enabled: false, refs: Object.freeze([] as string[]) }) as GemtplBlueprint,
})

export function resolveGemtplAdvancedOptions(
  drillParams?: GemtplDrillParams,
  blueprint?: GemtplBlueprint,
): GemtplAdvancedOptions {
  if (drillParams === undefined && blueprint === undefined) return GEMTPL_ADVANCED_OPTIONS_OFF
  return {
    drillParams: drillParams ?? { ...GEMTPL_ADVANCED_OPTIONS_OFF.drillParams },
    blueprint: blueprint ?? { ...GEMTPL_ADVANCED_OPTIONS_OFF.blueprint },
  }
}

// ---------------------------------------------------------------------------
// 任务侧快照（单一真源 = lab/stages.ts，本模块只 re-export——禁止平行第二定义）
// ---------------------------------------------------------------------------

export type { LabTaskDrillParams, LabTaskBlueprint } from './stages'
