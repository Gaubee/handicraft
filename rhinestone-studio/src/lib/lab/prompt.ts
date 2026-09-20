/**
 * 提示词拼接 service（轨 A）——组装器契约冻结 + 纯函数实现。
 *
 * 规范来源：openspec add-lab-drill-params-and-blueprint design §2（§2.1 组装器扩展签名 /
 * §2.2 【尺寸与钻规格】注入段文本骨架 / §2.3 素材图注入策略 / §2.4 蓝图提示词两策略骨架
 * ——逐字为准）。骨架常量（*_LINE / *_HEAD / *_SKELETON / 软上限）冻结于 0.2：
 * **任何文本改动必须 bump 本注释并附变更依据**，快照测试（src/tests/lab/prompt.*.test.ts）
 * 逐字节锁死。
 * 〔1.3 bump 2026-09-20〕BLUEPRINT_SERIAL_BODY / BLUEPRINT_PARALLEL_BODY / BLUEPRINT_NO_LEGEND_TAIL：
 * 收尾句读移入 legendClause 子句（组装需要——no-legend 退化时句号归属子句，避免「：。」连写）。
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
 *    贴图附加素材附图（附于 [案例,参考] 之后，每资产一条角色声明，清单行交叉引用图号）；
 *    软上限 4（超出按 ordinal 序截断 + 警告信号，不阻断）。
 * 5. [2026-09-20 0.2/1.3] 蓝图两策略 prompt 骨架（§2.4 逐字）：策略 B（串行，默认）成品图
 *    输入转换骨架；策略 A（并行同生）无成品图任务行改写；无钻清单省略编号图例节
 *    （退化为无编号纯转换）。
 * 6. [2026-09-20 placeholders] 效果提示词占位符体系（add-lab-effect-prompt-placeholders
 *    design §1/§3）：三占位符字面量（全角方括号冻结）+ substitution 纯函数（开+占位符=片段
 *    原文替换 / 开+缺占位符=不注入 / 关=占位符原样保留）。**段尾自动注入退役**——
 *    【尺寸与钻规格】不再独立成段（SEGMENT_ORDER_MAIN 注记），水钻正文只经占位符进入
 *    模板体；两参形态输出逐字节不变（红线）。
 *    〔lab-ux 2 bump 2026-09-21〕append/removeEffectPromptPlaceholder：开关即注入/移除
 *    （Owner 2026-09-21 六点之二）——UI toggle 层消费，substitution 语义不变。
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
/** UI/术语面已改名「原图」（TERMS v4）；模型面提示词角色字面冻结为「参考图」（byteEq 红线）。 */
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
 * [placeholders] casePromptFragment：案例效果提示词覆盖（替换激活 = roles.hasCase——
 * 案例图实际附送；缺席 = 自动 CASE_DESC 角色声明文案）。
 * [placeholders] blueprintPrompt：蓝图效果提示词（调用侧预解析——覆盖 ?? composeBlueprintPrompt
 * 自动骨架；键缺席 = 蓝图效果关，蓝图占位符原样保留）。
 */
export interface ComposeDrillPromptOptions {
  drillParams?: PromptDrillParams
  canvasWidthPx?: number
  casePromptFragment?: string
  blueprintPrompt?: { text: string }
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
// 效果提示词占位符体系（placeholders——add-lab-effect-prompt-placeholders design §1/§3；
// 字面量冻结：中文全角方括号记号，与 .gemtpl promptBody 中用户书写形态逐字一致）
// ---------------------------------------------------------------------------

/** 三正交效果键（案例参照图 / 水钻参数配置 / 蓝图效果——与 .gemtpl 开关键同名）。 */
export type EffectPromptKey = 'caseRef' | 'drillParams' | 'blueprint'

/** 占位符字面量（冻结）：run 时被对应效果片段原文替换；效果关 = 原样保留。 */
export const EFFECT_PROMPT_PLACEHOLDERS: Readonly<Record<EffectPromptKey, string>> = Object.freeze({
  caseRef: '【案例参照图提示词】',
  drillParams: '【水钻参数提示词】',
  blueprint: '【蓝图效果提示词】',
})

/** 占位符替换供给（plan 有键 = 效果开且片段已解析[override ?? auto]；无键 = 不动）。 */
export interface EffectPromptSubstitution {
  caseRef?: { text: string }
  drillParams?: { text: string }
  blueprint?: { text: string }
}

/** 主提示词是否含某效果占位符（发起面板「开关开而占位符缺失」提示的判定基）。 */
export function hasEffectPromptPlaceholder(body: string, effect: EffectPromptKey): boolean {
  return body.includes(EFFECT_PROMPT_PLACEHOLDERS[effect])
}

/**
 * [lab-ux 2] 开关即注入（Owner 2026-09-21：开→默认直接注入，方式 `\n【占位符】\n`）：
 * 占位符缺席时以 `\n${占位符}\n` 追加 body 末尾（末尾既有换行先剥，避免空行翻倍）；
 * 已存在于**任何位置** → 原样返回（幂等——用户可自由移动占位符后再开-关-开）。
 * 空 body → `${占位符}\n`（不落孤立前置换行）。纯函数。
 */
export function appendEffectPromptPlaceholder(body: string, effect: EffectPromptKey): string {
  const placeholder = EFFECT_PROMPT_PLACEHOLDERS[effect]
  if (body.includes(placeholder)) return body
  if (body === '') return `${placeholder}\n`
  return `${body.replace(/\n$/, '')}\n${placeholder}\n`
}

/**
 * [lab-ux 2] 开关即移除（Owner 2026-09-21：关→自动移除）：
 * 先删掉「整行仅含该占位符」的行（该行换行随行移除＝连同紧邻包裹换行——默认插入式的逆；
 * 占位符行曾是末行时再剥残留尾换行，保证 append→remove 恒等还原），
 * 再剥除行内残存出现（用户移进句中的占位符只剥占位符文本，句子与换行结构不动）。
 * 纯函数；body 不含占位符时恒等返回。
 */
export function removeEffectPromptPlaceholder(body: string, effect: EffectPromptKey): string {
  const placeholder = EFFECT_PROMPT_PLACEHOLDERS[effect]
  if (!body.includes(placeholder)) return body
  const keptLines = body.split('\n').filter((line) => line.trim() !== placeholder)
  const stripped = keptLines.join('\n').replaceAll(placeholder, '')
  const wasLastLine = body.endsWith(placeholder) || body.endsWith(`${placeholder}\n`)
  return wasLastLine ? stripped.replace(/\n$/, '') : stripped
}

/**
 * 占位符 → 片段**原文替换**（核心语义，design §1 行为矩阵）：
 * - plan 有键 → body 中该效果占位符（全部出现）被 text 替换（用户控制注入位置）；
 * - plan 无键（效果关 / 未配置）→ 对应占位符**原样保留**（用户可见自己写的结构）；
 * - plan 有键但 body 无占位符 → no-op（调用侧的「不注入 + 发起面板提示」信号另行判定）。
 * 纯函数：同输入同输出；空 plan 恒等返回（红线——两参 composeDrillPrompt 的字节等价前提）。
 */
export function substituteEffectPromptPlaceholders(body: string, substitution: EffectPromptSubstitution): string {
  let out = body
  for (const key of Object.keys(EFFECT_PROMPT_PLACEHOLDERS) as EffectPromptKey[]) {
    const fragment = substitution[key]
    if (fragment === undefined) continue
    out = out.replaceAll(EFFECT_PROMPT_PLACEHOLDERS[key], fragment.text)
  }
  return out
}

// ---------------------------------------------------------------------------
// 【尺寸与钻规格】注入段骨架（0.2 文本冻结；design §2.2 逐字——占位符 {…} 于 1.1 物化）
// ---------------------------------------------------------------------------

export const DRILL_SPEC_SECTION_TITLE = '【尺寸与钻规格】'

/**
 * 段序冻结（主图 stage，§2.1）。〔placeholders bump 2026-09-20〕**段尾注入退役**：
 * 【尺寸与钻规格】不再独立成段（原第 5 段删除）——水钻/案例/蓝图效果正文只经模板体
 * 占位符替换进入（用户控制注入位置；开+缺占位符=不注入，不静默追加）。任何改动须
 * bump 文件头冻结注释。
 */
export const SEGMENT_ORDER_MAIN = [
  '角色声明(1..n)',
  '任务要求',
  '贴钻指导规则',
  '模板特化体(含效果占位符替换)',
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

/** 策略 B 转换体（§2.4 主体逐字；legendClause 由图例节/退化文案二选一，自带句读）。〔1.3 bump：收尾句号移入 legendClause——no-legend 退化时句号归属子句〕 */
export const BLUEPRINT_SERIAL_BODY =
  '将这张效果图转换为白底平面施工蓝图：保留图中每个钻位的排布位置、真实形状轮廓（{shapeEnumeration}{customRefClause}）与物理比例，去除背景与光照，每颗钻平涂其颜色{legendClause}'

/** 策略 B 图例子句（有钻清单时；清单行复用 SPEC_LIST_LINE_* 模板）。 */
export const BLUEPRINT_LEGEND_CLAUSE =
  '；每个钻位中心标注其编号数字（1/2/3…，与下述清单一致），字号不小于钻径；右下角图例列出编号对应规格：'

/** 无钻清单的退化收尾（省略编号与图例节，任务退化为无编号纯转换）。〔1.3 bump：自带句号归属〕 */
export const BLUEPRINT_NO_LEGEND_TAIL = '。（无编号纯转换：图中钻位不标号、无图例。）'

/** 策略 A 任务行（§2.4「任务行改写」逐字；无成品图输入——排布一致性不可证的随机性声明归 UI）。 */
export const BLUEPRINT_PARALLEL_TASK = '【任务：施工蓝图生成】为本次同时生成的设计生成配套施工蓝图。'

/** 策略 A 转换体（骨架同 B 减输入图约束：无「这张效果图」，轮廓/比例/图例节同构）。〔1.3 bump：收尾句号移入 legendClause〕 */
export const BLUEPRINT_PARALLEL_BODY =
  '生成白底平面施工蓝图：每颗钻保留真实形状轮廓（{shapeEnumeration}{customRefClause}）与物理比例，平涂其颜色{legendClause}'

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

// ---------------------------------------------------------------------------
// service 实现（轨 A 1.3：composeBlueprintPrompt 两策略骨架物化；§2.4 逐字）
// ---------------------------------------------------------------------------

/**
 * 蓝图 stage 提示词组装（§2.4 两策略——strategy 由 roles.hasEffect 表达）：
 * - 策略 B（串行，默认——hasEffect=true）：附图 [成品, 原图(若有), ...素材, ...蓝图参考]，
 *   首附图恒「图一：成品效果图」；prompt = 转换任务骨架（保留排布/轮廓/物理比例，
 *   去背景光照、平涂、编号标注 + 图例，收尾禁令「不新增、不移动、不删除任何钻位」）。
 * - 策略 A（并行同生——hasEffect=false）：无成品图输入，任务行改写为
 *   「为本次同时生成的设计生成配套施工蓝图」；排布一致性不可证（随机性来源——§4.1）。
 * - 无钻清单（blueprint 缺席 / hasLegend=false / specs 空）→ 省略编号与图例节，
 *   退化为无编号纯转换。
 * 图号全部取 orderDrillImages（附图序号 = 角色声明序号——与请求 images 数组同源）；
 * 图例行复用 specListLineOf（单一实现；自定义行带素材图交叉引用）。确定性纯函数：
 * 同输入同输出逐字节相等（旧档重建口径——provenance.blueprintPrompt 审计快照可复算）。
 */
export function composeBlueprintPrompt(roles: BlueprintPromptRoles, options?: ComposeBlueprintPromptOptions): string {
  const order = orderDrillImages({
    hasCase: false,
    caseLayout: 'single',
    hasReference: roles.hasReference,
    materials: roles.materials,
    hasEffect: roles.hasEffect,
    blueprintRefs: roles.blueprintRefs,
  })
  const effectFigure = order.find((e) => e.role === 'effect')?.figure ?? '一'
  const firstMaterial = order.find((e) => e.role === 'material')
  const customRefClause =
    firstMaterial !== undefined ? BLUEPRINT_CUSTOM_REF_CLAUSE.replaceAll('{figure}', firstMaterial.figure) : ''

  const blueprint = options?.blueprint
  const specs = blueprint?.specs ?? []
  const hasLegend = blueprint?.hasLegend === true && specs.length > 0
  const legendClause = hasLegend ? BLUEPRINT_LEGEND_CLAUSE : BLUEPRINT_NO_LEGEND_TAIL

  const subst = (template: string): string =>
    template
      .replaceAll('{shapeEnumeration}', BLUEPRINT_SHAPE_ENUMERATION)
      .replaceAll('{customRefClause}', customRefClause)
      .replaceAll('{legendClause}', legendClause)
      .replaceAll('{effectFigure}', effectFigure)

  const taskLine = roles.hasEffect ? subst(BLUEPRINT_SERIAL_TASK) : BLUEPRINT_PARALLEL_TASK
  const bodyLine = subst(roles.hasEffect ? BLUEPRINT_SERIAL_BODY : BLUEPRINT_PARALLEL_BODY)

  const lines = [taskLine, bodyLine]
  if (hasLegend) {
    for (const spec of specs) lines.push(`${SPEC_LIST_LINE_INDENT}${specListLineOf(spec, order)}`)
  }
  lines.push(BLUEPRINT_CLOSING_LINE)
  return lines.join('\n')
}
