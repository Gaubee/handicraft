/**
 * 提示词拼接 service（轨 A）——组装器契约冻结 + 纯函数实现。
 *
 * 规范来源：openspec add-lab-drill-params-and-blueprint design §2（§2.1 组装器扩展签名 /
 * §2.2 【尺寸与钻规格】注入段文本骨架 / §2.3 素材图注入策略 / §2.4 蓝图提示词两策略骨架
 * ——逐字为准）。骨架常量（*_LINE / *_HEAD / *_SKELETON / 软上限）冻结于 0.2：
 * **任何文本改动必须 bump 本注释并附变更依据**，快照测试（src/tests/lab/prompt.*.test.ts）
 * 逐字节锁死。
 *
 * 正交意图：
 * 1. [2026-09-20 0.2] 附图角色 n 元模型与序号单一真源：`orderDrillImages`
 *    （≡ describeDrillImageOrder 兼容出口）——ordinal 1..n、中文数字至「十」超出落阿拉伯
 *    数字；恒序 [effect(若有), 案例(若有), 参考(若有), ...素材, ...蓝图参考]（§2.3
 *    「主语义对（案例→参考）不被打断」+ §2.4 策略 B 首附图=成品效果图）。
 *    **附图序号 = 角色声明序号**不变量（请求 images 数组同源派生——1.2 接线）。
 * 2. [2026-09-20 0.2] 组装器契约类型：`composeDrillPrompt(templateBody, roles,
 *    options?: {drillParams?})` 扩展签名 + `composeBlueprintPrompt(roles, options?)` 新签名
 *    （两参形态输出逐字节不变——回归基线 prompt.byteEq.test.ts，0.2 改造前直采）。
 *    **主图 stage 提示词不因蓝图开启而变化**（§2.1 纯净性裁决——主图请求语义与策略 B
 *    可靠性前提；§2.2 清单头恒用无蓝图文案，见 DRILL_SPEC_LIST_HEAD 注释）。
 * 3. [2026-09-20 0.2/1.1] 【尺寸与钻规格】注入段：骨架常量 + 段生成纯函数（§2.2——
 *    触发条件 drillParams.enabled；physical 比例锚 1mm≈px 与钻径/画幅百分比；缺席退化为
 *    相对比例行）。段序冻结：…模板体 → 注入段 → 输出行（SEGMENT_ORDER_MAIN）。
 * 4. [2026-09-20 0.2/1.1] 素材注入策略（§2.3）：内置形=纯描述入清单行；自定义=.gemshape
 *    贴图附加参考图（附于 [案例,参考] 之后，每资产一条角色声明，清单行交叉引用图号）；
 *    软上限 4（超出按 ordinal 序截断 + 警告信号，不阻断）。
 * 5. [2026-09-20 0.2/1.3] 蓝图两策略 prompt 骨架（§2.4 逐字）：策略 B（串行，默认）成品图
 *    输入转换骨架；策略 A（并行同生）无成品图任务行改写；无钻清单省略编号图例节
 *    （退化为无编号纯转换）。
 *
 * 纪律：纯函数——不 import Svelte、不触 DOM、不做 IO；类型引用只走 import type；
 * 显示码（R10/SQ3.5 等）一律由 specKey/形状**正向派生**（身份不由显示码反推——engine 纪律）。
 */

import { BUILTIN_SHAPES, PIXELS_PER_MM } from '$lib/engine'
import type { CaseRefLayout } from '$lib/lab/caseComposite'
import type { GemSpecSnapshot, PhysicalCanvas, ShapeId } from '$lib/engine'
import type { LabTaskDrillParams } from './stages'

// ---------------------------------------------------------------------------
// 附图角色 n 元模型（0.2 冻结；design §2.1/§2.3/§2.4）
// ---------------------------------------------------------------------------

export type DrillImageRole = 'case' | 'reference' | 'material' | 'blueprint-ref' | 'effect'

export interface OrderedDrillImage {
  /** 请求中的位置（1 起）——与提示词【图N】编号一致；n 元（不再锁 1|2）。 */
  ordinal: number
  /** 中文数字（至「十」，超出阿拉伯数字——防御性，实际单请求附图 ≤8）。 */
  figure: string
  /** 提示词角色名，如「案例参照图」「钻石素材图·C-star01」。 */
  figureLabel: string
  role: DrillImageRole
}

export const CASE_FIGURE_LABEL = '案例参照图'
export const REFERENCE_FIGURE_LABEL = '参考图'
export const EFFECT_FIGURE_LABEL = '成品效果图'
export const MATERIAL_FIGURE_LABEL_PREFIX = '钻石素材图·'
export const BLUEPRINT_REF_FIGURE_LABEL = '蓝图参考图'

/** 中文数字（一…十）；超出落阿拉伯数字。 */
const FIGURES_ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'] as const

export function figureOf(ordinal: number): string {
  return ordinal >= 1 && ordinal <= FIGURES_ZH.length ? FIGURES_ZH[ordinal - 1] : String(ordinal)
}

/**
 * 附图角色（与请求 images 数组顺序一一对应）。
 * [0.2 n 元扩展] materials / hasEffect / blueprintRefs 可选——缺席即零条；
 * hasEffect 与 blueprintRefs 仅蓝图 stage 使用（主图 stage 恒不设）。
 */
export interface DrillPromptImageRoles {
  hasCase: boolean
  /** 案例参照图布局：合成横/纵（两半=原图+效果图）或 single（单张效果图）。 */
  caseLayout: CaseRefLayout
  hasReference: boolean
  /** 自定义钻素材图规格码（每码一条角色声明；附于案例/参考之后——§2.3 附图序裁决）。 */
  materials?: readonly string[]
  /** 成品效果图（仅策略 B 蓝图 stage 的首附图）。 */
  hasEffect?: boolean
  /** 蓝图参考图张数（≤2；仅蓝图 stage 附图，每张一条声明）。 */
  blueprintRefs?: number
}

/**
 * 附图序号单一真源（n 元）：composeDrillPrompt / composeBlueprintPrompt 与实验室 UI 的
 * 「图N」徽标共用此函数，界面标注与提示词编号永不漂移。
 * 恒序：effect(若有) → case(若有) → reference(若有) → ...素材 → ...蓝图参考。
 */
export function orderDrillImages(roles: DrillPromptImageRoles): OrderedDrillImage[] {
  const out: OrderedDrillImage[] = []
  const push = (role: DrillImageRole, figureLabel: string): void => {
    const ordinal = out.length + 1
    out.push({ ordinal, figure: figureOf(ordinal), figureLabel, role })
  }
  if (roles.hasEffect === true) push('effect', EFFECT_FIGURE_LABEL)
  if (roles.hasCase) push('case', CASE_FIGURE_LABEL)
  if (roles.hasReference) push('reference', REFERENCE_FIGURE_LABEL)
  for (const code of roles.materials ?? []) push('material', `${MATERIAL_FIGURE_LABEL_PREFIX}${code}`)
  for (let i = 0; i < (roles.blueprintRefs ?? 0); i += 1) push('blueprint-ref', BLUEPRINT_REF_FIGURE_LABEL)
  return out
}

/** 兼容出口（原 effectRefs.describeDrillImageOrder 同名同语义——UI 消费面零变化）。 */
export const describeDrillImageOrder = orderDrillImages

// ---------------------------------------------------------------------------
// 组装器契约类型（0.2 冻结签名；design §2.1）
// ---------------------------------------------------------------------------

/** 主图 stage 消费的钻参数（≡ LabTaskDrillParams——§2.1「= §1.2」）。 */
export type PromptDrillParams = LabTaskDrillParams

/** 蓝图 stage 专用（主图 stage 不消费蓝图上下文——§2.1 纯净性）。 */
export interface PromptBlueprint {
  /** = drillParams on（有编号图例）；off = 无编号纯转换。 */
  hasLegend: boolean
  /** 图例节数据（hasLegend 时存在）。 */
  specs?: readonly GemSpecSnapshot[]
}

/**
 * composeDrillPrompt 第三参（1.2 接线；两参调用输出逐字节不变）。
 * canvasWidthPx：请求图宽（size 结构化 {widthPx,heightPx} 的宽半边——比例锚 1mm≈px 的
 * 锚定源；缺席时按 engine.PIXELS_PER_MM 缺省换算并显式标注，不静默）。
 */
export interface ComposeDrillPromptOptions {
  drillParams?: PromptDrillParams
  canvasWidthPx?: number
}

/** 蓝图 stage 附图角色（strategy 由 hasEffect 表达：B=true / A=false）。 */
export interface BlueprintPromptRoles {
  /** 策略 B 首附图=成品效果图；策略 A 无成品图输入。 */
  hasEffect: boolean
  hasReference: boolean
  /** 自定义钻素材图规格码（与主图 stage 同源派生——deriveMaterialAttachments）。 */
  materials: readonly string[]
  /** 蓝图参考图张数（≤2）。 */
  blueprintRefs: number
}

export interface ComposeBlueprintPromptOptions {
  blueprint?: PromptBlueprint
}

// ---------------------------------------------------------------------------
// 【尺寸与钻规格】注入段骨架（0.2 文本冻结；design §2.2 逐字——占位符 {…} 于 1.1 物化）
// ---------------------------------------------------------------------------

export const DRILL_SPEC_SECTION_TITLE = '【尺寸与钻规格】'

/**
 * 段序冻结（主图 stage，§2.1）：注入段插在模板体之后、输出行之前——规格约束是对任务的
 * 收尾限定，不打断角色/任务/规则的主干。任何改动须 bump 文件头冻结注释。
 */
export const SEGMENT_ORDER_MAIN = [
  '角色声明(1..n)',
  '任务要求',
  '贴钻指导规则',
  '模板特化体',
  '【尺寸与钻规格】(drillParams on 时)',
  '输出行',
] as const

/** physical 存在且锚定请求宽度时（§2.2 例：画幅物理尺寸 210×148mm。图宽对应 1024px：1mm ≈ 4.9px。）。 */
export const DRILL_SPEC_ANCHOR_LINE = '画幅物理尺寸 {widthMm}×{heightMm}mm。图宽对应 {canvasWidthPx}px：1mm ≈ {pxPerMm}px。'

/** physical 存在但未锚定请求宽度：缺省换算（engine.PIXELS_PER_MM=2.5）显式标注，不静默。 */
export const DRILL_SPEC_ANCHOR_DEFAULT_LINE =
  '画幅物理尺寸 {widthMm}×{heightMm}mm。1mm ≈ {pxPerMm}px（缺省换算，未按请求宽度锚定）。'

/** physical 缺席退化行（§2.2 恒有块之外的首行退化）。 */
export const DRILL_SPEC_ANCHOR_FALLBACK_LINE = '未声明画幅物理尺寸——按钻径之比表现各规格的相对大小。'

/** 钻径/画幅宽比例锚（§2.2 例：SS10 圆钻直径 2.8mm ≈ 画幅宽度的 1.33%——所有钻按此物理比例绘制。）。 */
export const DRILL_SPEC_RATIO_ANCHOR_LINE = '{specDesc} ≈ 画幅宽度的 {pct}%——所有钻按此物理比例绘制。'

/**
 * 清单头（恒有块）。〔冻结裁决〕§2.2 示例的「编号将用于蓝图图例」变体**不用于主图 stage**：
 * §2.1 纯净性裁决（主图提示词不因蓝图开启而变化——Owner 语序「先生成成品效果图，然后再……」）
 * 优先于 §2.2 示例文案；蓝图图例语义由 composeBlueprintPrompt 的图例节（§2.4）承担。
 */
export const DRILL_SPEC_LIST_HEAD = '只允许使用以下钻（编号用于区分钻规格）：'

/** 清单行（内置形——纯描述注入，§2.3；例：1 = R10 圆形 SS10（直径 2.8mm））。 */
export const SPEC_LIST_LINE_BUILTIN = '{ordinal} = {code} {shapeName} {sizeLabel}（直径 {diameterMm}mm）'

/** 清单行（自定义形 + 素材附图交叉引用；例：2 = C-star01 自定义钻形（最大径 5.0mm，素材见【图三：钻石素材图·C-star01】））。 */
export const SPEC_LIST_LINE_CUSTOM_ATTACHED =
  '{ordinal} = {code} 自定义钻形（最大径 {diameterMm}mm，素材见【图{figure}：钻石素材图·{code}】）'

/** 清单行（自定义形但素材图超出软上限未附送——无交叉引用子句）。 */
export const SPEC_LIST_LINE_CUSTOM_UNATTACHED = '{ordinal} = {code} 自定义钻形（最大径 {diameterMm}mm）'

/** 清单行缩进（§2.2 示例两空格）。 */
export const SPEC_LIST_LINE_INDENT = '  '

// 比例锚数值格式化规则（冻结）：pxPerMm 一位小数、百分比两位小数，尾零裁剪。

// ---------------------------------------------------------------------------
// 素材注入策略常量（0.2 冻结；design §2.3）
// ---------------------------------------------------------------------------

/** 素材附图软上限：≤4 张（超出取 ordinal 序前 4，警告不阻断——图多请求重、注意力稀释）。 */
export const MATERIAL_FIGURE_SOFT_LIMIT = 4

/** 截断警告文案（编辑器与发起前共用信号）。 */
export const MATERIAL_OVERFLOW_WARNING = '素材图过多，仅前 4 张随请求附送'

// ---------------------------------------------------------------------------
// 蓝图两策略 prompt 骨架（0.2 冻结；design §2.4 逐字——占位符 {…} 于 1.3 物化）
// ---------------------------------------------------------------------------

/** 形状轮廓枚举（§2.4 括注原文）。 */
export const BLUEPRINT_SHAPE_ENUMERATION = '圆形/方形/水滴/心形/马眼/自定义'

/** 自定义轮廓交叉引用子句（有素材附图时拼入括注；N=首张素材图号）。 */
export const BLUEPRINT_CUSTOM_REF_CLAUSE = '——自定义轮廓见【图{figure}：钻石素材图】'

/** 策略 B 任务行（§2.4 首句逐字；effectFigure=成品效果图图号——策略 B 恒图一）。 */
export const BLUEPRINT_SERIAL_TASK =
  '【任务：施工蓝图转换】输入【图{effectFigure}：成品效果图】为本设计的局部贴钻成品。'

/** 策略 B 转换体（§2.4 主体逐字；legendClause 由图例节/退化文案二选一）。 */
export const BLUEPRINT_SERIAL_BODY =
  '将这张效果图转换为白底平面施工蓝图：保留图中每个钻位的排布位置、真实形状轮廓（{shapeEnumeration}{customRefClause}）与物理比例，去除背景与光照，每颗钻平涂其颜色{legendClause}。'

/** 策略 B 图例子句（有钻清单时；清单行复用 SPEC_LIST_LINE_* 模板）。 */
export const BLUEPRINT_LEGEND_CLAUSE =
  '；每个钻位中心标注其编号数字（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格：'

/** 无钻清单的退化收尾（省略编号与图例节，任务退化为无编号纯转换）。 */
export const BLUEPRINT_NO_LEGEND_TAIL = '（无编号纯转换：图中钻位不标号、无图例。）'

/** 策略 A 任务行（§2.4「任务行改写」逐字；无成品图输入——排布一致性不可证的随机性声明归 UI）。 */
export const BLUEPRINT_PARALLEL_TASK = '【任务：施工蓝图生成】为本次同时生成的设计生成配套施工蓝图。'

/** 策略 A 转换体（骨架同 B 减输入图约束：无「这张效果图」，轮廓/比例/图例节同构）。 */
export const BLUEPRINT_PARALLEL_BODY =
  '生成白底平面施工蓝图：每颗钻保留真实形状轮廓（{shapeEnumeration}{customRefClause}）与物理比例，平涂其颜色{legendClause}。'

/** 收尾禁令（§2.4 末句逐字——两策略共用）。 */
export const BLUEPRINT_CLOSING_LINE = '不新增、不移动、不删除任何钻位。'

// ---------------------------------------------------------------------------
// service 实现（轨 A 1.1：【尺寸与钻规格】段生成 + 素材附图派生；纯函数族）
// ---------------------------------------------------------------------------

/** 清单行/蓝图括注的形状中文名（§2.2/§2.4 示例文案：圆形/方形/…/自定义钻形）。 */
const SHAPE_PROMPT_NAMES: Record<ShapeId, string> = {
  round: '圆形',
  square: '方形',
  drop: '水滴',
  heart: '心形',
  marquise: '马眼',
  custom: '自定义钻形',
}

/** 锚行形状名取 engine BUILTIN_SHAPES.nameZh（§2.2 示例「SS10 圆钻直径」——单一真源）。 */
function shapeAnchorNameOf(spec: GemSpecSnapshot): string {
  if (spec.shapeId === 'custom') return '自定义钻形'
  return BUILTIN_SHAPES.find((s) => s.shapeId === spec.shapeId)?.nameZh ?? SHAPE_PROMPT_NAMES[spec.shapeId]
}

/**
 * 规格码（人读短码，如 R10 / SQ3.5；custom = specKey 全形）——由 specKey/形状**正向派生**
 * （身份不由显示码反推的镜像纪律）。GemSpecSnapshot 不携带 shortCode（W0 冻结快照无此字段，
 * .gemshape 目录短码不随 run 物化），故 builtin = 引擎短码 + specKey 尺寸后缀（圆钻剥 'ss'）。
 */
export function specDisplayCode(spec: GemSpecSnapshot): string {
  if (spec.shapeId === 'custom') return spec.specKey
  const prefix = `${spec.shapeId}-`
  const token = spec.specKey.startsWith(prefix)
    ? spec.specKey.slice(prefix.length)
    : spec.sizeLabel.trim().toLowerCase().replace(/mm$/, '')
  const sizeToken = spec.shapeId === 'round' ? token.replace(/^ss/, '') : token
  const shortCode = BUILTIN_SHAPES.find((s) => s.shapeId === spec.shapeId)?.shortCode
  return shortCode !== undefined ? `${shortCode}${sizeToken}` : spec.specKey
}

/** 数值格式化（冻结）：定点小数 + 尾零裁剪（4.876→'4.9'；1.3333→'1.33'；2.00→'2'）。 */
function fmtFixed(value: number, decimals: number): string {
  return value
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
}

/** 素材附图条目（自定义规格 → 规格码 + 贴图 assetId 语义由 specKey 携带）。 */
export interface MaterialAttachment {
  spec: GemSpecSnapshot
  specCode: string
}

/**
 * 素材附图清单派生（§2.3 冻结策略）：
 * - 只取自定义规格（shapeId='custom'——内置形纯描述注入，不附图）；
 * - specKey 去重保序（custom specKey = 'custom-<assetId>'，同资产只附一次）；
 * - 软上限 4：超出按 ordinal 序截断（truncated 仍进钻清单，仅不附图不交叉引用）；
 * - 截断时返回警告信号（不阻断——上限值试产可调，机制冻结）。
 */
export interface MaterialAttachmentPlan {
  attached: readonly MaterialAttachment[]
  truncated: readonly MaterialAttachment[]
  warning: string | null
}

export function deriveMaterialAttachments(specs: readonly GemSpecSnapshot[]): MaterialAttachmentPlan {
  const customs: MaterialAttachment[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    if (spec.shapeId !== 'custom' || seen.has(spec.specKey)) continue
    seen.add(spec.specKey)
    customs.push({ spec, specCode: specDisplayCode(spec) })
  }
  const attached = customs.slice(0, MATERIAL_FIGURE_SOFT_LIMIT)
  const truncated = customs.slice(MATERIAL_FIGURE_SOFT_LIMIT)
  return { attached, truncated, warning: truncated.length > 0 ? MATERIAL_OVERFLOW_WARNING : null }
}

function materialFigureOf(order: readonly OrderedDrillImage[], specCode: string): OrderedDrillImage | undefined {
  return order.find((e) => e.role === 'material' && e.figureLabel === `${MATERIAL_FIGURE_LABEL_PREFIX}${specCode}`)
}

/** 清单行生成（§2.2 模板物化；order 供自定义形交叉引用图号——附图序号单一真源）。 */
export function specListLineOf(spec: GemSpecSnapshot, order: readonly OrderedDrillImage[]): string {
  const code = specDisplayCode(spec)
  if (spec.shapeId !== 'custom') {
    return SPEC_LIST_LINE_BUILTIN.replaceAll('{ordinal}', String(spec.ordinal))
      .replaceAll('{code}', code)
      .replaceAll('{shapeName}', SHAPE_PROMPT_NAMES[spec.shapeId])
      .replaceAll('{sizeLabel}', spec.sizeLabel)
      .replaceAll('{diameterMm}', String(spec.diameterMm))
  }
  const hit = materialFigureOf(order, code)
  const template = hit !== undefined ? SPEC_LIST_LINE_CUSTOM_ATTACHED : SPEC_LIST_LINE_CUSTOM_UNATTACHED
  return template
    .replaceAll('{ordinal}', String(spec.ordinal))
    .replaceAll('{code}', code)
    .replaceAll('{diameterMm}', String(spec.diameterMm))
    .replaceAll('{figure}', hit !== undefined ? hit.figure : '')
}

/** 比例锚的锚定规格描述（§2.2 示例「SS10 圆钻直径 2.8mm」/「C-star01 自定义钻形最大径 5.0mm」）。 */
function anchorSpecDescOf(spec: GemSpecSnapshot): string {
  if (spec.shapeId === 'custom') {
    return `${specDisplayCode(spec)} 自定义钻形最大径 ${spec.diameterMm}mm`
  }
  return `${spec.sizeLabel} ${shapeAnchorNameOf(spec)}直径 ${spec.diameterMm}mm`
}

/** 【尺寸与钻规格】段生成入参（specs = GemSpecSnapshot[]（ordinal 序）；order = 附图序）。 */
export interface DrillSpecSectionInput {
  specs: readonly GemSpecSnapshot[]
  physical?: PhysicalCanvas
  /** 请求图宽（比例锚 1mm≈px 的锚定源；缺席走 PIXELS_PER_MM 缺省换算并显式标注）。 */
  canvasWidthPx?: number
  order: readonly OrderedDrillImage[]
}

/**
 * 【尺寸与钻规格】注入段全文（§2.2 骨架物化——composeDrillPrompt 在 drillParams on 时
 * 插入「模板体之后、输出行之前」；段内结构：段题 → 比例锚（physical 存在时两行 / 缺席时
 * 退化一行）→ 恒有清单（头 + 缩进行））。
 */
export function buildDrillSpecSection(input: DrillSpecSectionInput): string {
  const { specs, physical, canvasWidthPx, order } = input
  const lines: string[] = [DRILL_SPEC_SECTION_TITLE]

  if (physical !== undefined) {
    if (canvasWidthPx !== undefined && canvasWidthPx > 0) {
      lines.push(
        DRILL_SPEC_ANCHOR_LINE.replaceAll('{widthMm}', String(physical.widthMm))
          .replaceAll('{heightMm}', String(physical.heightMm))
          .replaceAll('{canvasWidthPx}', String(canvasWidthPx))
          .replaceAll('{pxPerMm}', fmtFixed(canvasWidthPx / physical.widthMm, 1)),
      )
    } else {
      lines.push(
        DRILL_SPEC_ANCHOR_DEFAULT_LINE.replaceAll('{widthMm}', String(physical.widthMm))
          .replaceAll('{heightMm}', String(physical.heightMm))
          .replaceAll('{pxPerMm}', fmtFixed(PIXELS_PER_MM, 1)),
      )
    }
    const anchor = specs[0]
    if (anchor !== undefined) {
      lines.push(
        DRILL_SPEC_RATIO_ANCHOR_LINE.replaceAll('{specDesc}', anchorSpecDescOf(anchor)).replaceAll(
          '{pct}',
          fmtFixed((anchor.diameterMm / physical.widthMm) * 100, 2),
        ),
      )
    }
  } else {
    lines.push(DRILL_SPEC_ANCHOR_FALLBACK_LINE)
  }

  lines.push(DRILL_SPEC_LIST_HEAD)
  for (const spec of specs) lines.push(`${SPEC_LIST_LINE_INDENT}${specListLineOf(spec, order)}`)
  return lines.join('\n')
}
