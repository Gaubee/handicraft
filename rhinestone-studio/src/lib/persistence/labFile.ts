/**
 * 实验室文件格式对（.gemtpl 模板 / .gemgen 生成结果）的序列化层——
 * gemtpl/gemgen 两格式 serialize / parse / 版本迁移链的**唯一出口**
 * （openspec add-project-files design §7.1/§7.2 + §1.3 版本纪律 + §2 PROJECT_MIME；
 * TS interface 级 schema 见 .agents/documents/2026-09-19-lab-formats/lab-formats-and-gallery.md §A.1.2/A.2.2）。
 *
 * 正交意图：
 * 1. [2026-09-19 add-project-files 4.1] 确定性序列化：对象字面量按 schema 声明序构造（不排序
 *    不 hack），serialize→parse→serialize 字节等价；gemtpl 换绑保存高频 → 「未变更字段零漂移」。
 * 2. [版本纪律 §1.3] formatVersion 向前拒读（LabFileVersionError，「文件来自更新版本的应用」，
 *    不猜测解析）；迁移链 (from,to)=>migrate 注册表逐版本串行，v1 空链；每次 bump 附 round-trip 测试。
 *    [add-lab 4.1] 正交键消费接线：gemtpl blueprint.refs 键位补齐（≤2 去重）；gemgen
 *    provenance.blueprint = 请求快照 {strategy,status,error?}（stages 单一真源）+
 *    provenance.blueprintPrompt 全文快照；provenance.requestMode 成唯一写键（v1 过渡
 *    mode 输入面随 lab store 写面迁移移除——v1 档读面迁移映射不变）。
 * 3. [防御] 脏输入 typed error 带字段路径（LabFileFieldError，点分路径如 provenance.runId）；
 *    防御上限归属迁移（补充稿 §F-5）：promptBody 8000 截断 / candidates 1-8 clamp 由本层
 *    schema 校验接管（原 localStorage 防线）；32 条模板数上限归模板 store/目录层，非单文件 schema 之事。
 * 4. [N3 打码] gemgen provenance.advancedJsonRedacted 复用 api/client 的
 *    maskAdvancedJsonForPersist 同口径（序列化边界统一打码、幂等，不复制逻辑）。
 * 5. [图像消费] gemgenImageBlob：内嵌 dataUrl → Blob 零重编码（design §9.2 B2 单点消费的
 *    纯函数半成品；assetId→file 的库读取包装 getHandoffImageBlob 是 0.6 切片，不在本层）。
 *
 * 「不入文件」清单（design §7.1/§7.2，冻结）：
 * - gemtpl：enabled（使用意图 → 会话 key lab-session）/ 总装骨架（composeDrillPrompt 代码层，
 *   序列化时刻不可计算 + 骨架演进即时惠及全模板）/ 选中态 / 目录位置（AssetProject.parentId）。
 * - gemgen：任务状态/error/debug（会话账本的事）/ imageUrl（objectURL 瞬态）/ engineVersion
 *   （实验室不消费引擎）。
 */

import { maskAdvancedJsonForPersist } from '$lib/api/client'
import type { CaseRefLayout } from '$lib/lab/caseComposite'
import { BLUEPRINT_REFS_MAX } from '$lib/lab/advancedOptions'
import { PROVENANCE_BLUEPRINT_PROMPT_KEY, type ProvenanceBlueprintSnapshot } from '$lib/lab/stages'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { customAssetIdMissing, type GemSpecSnapshot, type PhysicalCanvas, type ShapeId } from '$lib/engine'

// ---------------------------------------------------------------------------
// 版本与防御上限（schema 校验接管原 localStorage 防线）
// ---------------------------------------------------------------------------

export type LabFileKind = 'gemtpl' | 'gemgen'

/**
 * 各格式当前支持的 formatVersion（迁移链终点；bump 必附 round-trip 字节等价测试）。
 * v2（gem-catalog W0 0.3，design §1.3 / Owner 2026-09-20 裁决二）：gemtpl 补 drillParams/
 * blueprint 正交高级选项键（缺席=两开关关）+ gemSpecIds；gemgen 拆 requestMode（endpoint 语义
 * 保留，旧 mode 只读映射）+ blueprint/gemSpecs/physicalCanvas 可选键位 + provenance 正交快照。
 */
export const LABFILE_FORMAT_VERSIONS = {
  gemtpl: 2,
  gemgen: 2,
} as const

/** 模板特化正文上限（沿 saveVariants 截断上限，补充稿 A.1.2 保持 8000）。 */
export const GEMTPL_PROMPT_BODY_MAX = 8000

/** 候选数默认范围（clamp 同 updateVariant / normalizeVariants 口径）。 */
export const GEMTPL_CANDIDATES_MIN = 1
export const GEMTPL_CANDIDATES_MAX = 8

// ---------------------------------------------------------------------------
// typed error 家族（契约性异常：parse/serialize 双侧共用）
// ---------------------------------------------------------------------------

/** labFile 层错误基类（instanceof 分发用）。 */
export class LabFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LabFileError'
  }
}

/** 版本门：formatVersion 高于本应用支持（向前拒读），或低于且迁移链有断环。 */
export class LabFileVersionError extends LabFileError {
  constructor(
    public readonly kind: LabFileKind,
    public readonly foundVersion: number,
    public readonly supportedVersion: number,
    detail?: string,
  ) {
    super(
      detail ??
        `文件来自更新版本的应用，请升级后再打开（${kind} v${foundVersion} > 本应用支持的 v${supportedVersion}）。`,
    )
    this.name = 'LabFileVersionError'
  }
}

/** kind/MIME 交叉校验失败（design §2：projectKind × mime × 文件内 kind 三者对齐）。 */
export class LabFileKindError extends LabFileError {
  constructor(
    public readonly field: 'kind' | 'mime',
    public readonly expected: string,
    public readonly found: string,
  ) {
    super(`文件 ${field} 不符：期望 ${expected}，实际为 ${found}。`)
    this.name = 'LabFileKindError'
  }
}

/** 脏输入：缺字段/类型错，带点分字段路径（根文档为 ''）。found 只含类型描述，不泄露字段值。 */
export class LabFileFieldError extends LabFileError {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly found: string,
    note?: string,
  ) {
    super(
      `文件字段不合法：${path || '<文档根>'} 应为 ${expected}，实际为 ${found}${note ? `（${note}）` : ''}。`,
    )
    this.name = 'LabFileFieldError'
  }
}

// ---------------------------------------------------------------------------
// 迁移链骨架（§1.3：( (from,to) => migrate ) 注册表，逐版本串行；v1 空链）
// ---------------------------------------------------------------------------

/** 单步迁移：输入旧版本已通过版本门的原文档，输出升一版的文档（纯函数，不 IO）。 */
export type LabFileMigrate = (data: Record<string, unknown>) => Record<string, unknown>

const labFileMigrations = new Map<string, LabFileMigrate>()

/** 注册单步迁移（bump formatVersion 时配套注册 from→from+1；当前 v1 无迁移）。 */
export function registerLabFileMigration(
  kind: LabFileKind,
  from: number,
  to: number,
  migrate: LabFileMigrate,
): void {
  labFileMigrations.set(`${kind}:${from}->${to}`, migrate)
}

/** 从 from 逐版本串行迁移到当前支持版本；断环 = 版本错误（不猜测解析）。 */
function runLabFileMigrations(
  kind: LabFileKind,
  from: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const supported = LABFILE_FORMAT_VERSIONS[kind]
  let current = data
  for (let version = from; version < supported; version += 1) {
    const migrate = labFileMigrations.get(`${kind}:${version}->${version + 1}`)
    if (!migrate) {
      throw new LabFileVersionError(
        kind,
        from,
        supported,
        `文件版本过低（${kind} v${from}），缺少 v${version}→v${version + 1} 的迁移路径，无法打开。`,
      )
    }
    current = migrate(current)
  }
  return current
}

// ---------------------------------------------------------------------------
// Schema（A.1.2 / A.2.2；键序 = 声明序 = 序列化序，round-trip 字节等价的前提）
// ---------------------------------------------------------------------------

/** 案例绑定：合成案例图的库资产引用；null = 未绑定（纯提示词生成）。 */
export interface LabCaseBinding {
  assetId: string
  caseLayout: CaseRefLayout
}

export type GemtplProvenanceSource = 'builtin-seed' | 'user-created' | 'forked'

/**
 * 水钻参数配置高级选项（Owner 2026-09-20 裁决二：正交开关，workflowMode 概念退役；
 * 键形消费规范源 = add-lab-drill-params-and-blueprint——本层只冻结 schema 位）。
 * [placeholders] promptFragment = 效果提示词覆盖文本（缺席 = 自动生成 buildDrillSpecSection 产出）。
 */
export interface DrillParamsConfig {
  enabled: boolean
  /** 钻清单 specKey 引用（canonical specKey——字段名沿裁决二键形 gemSpecIds/specs） */
  specs: string[]
  /** 高级选项内可选尺寸信息（**不属画幅锚**——R1 建议 2 定稿：模板与画幅锚无关，生成任务画幅声明在 .gemgen） */
  physical?: PhysicalCanvas
  /** [placeholders] 效果提示词覆盖（EffectPromptDialog 编辑后落键；空串 = 空覆盖合法）。 */
  promptFragment?: string
}

/**
 * 蓝图高级选项开关（beta 标记随消费 change）。refs 键位 = add-lab 4.1 补齐（advancedOptions
 * GemtplBlueprint 消费面此前超出本键——「refs 落盘归 4.1」局限解除）。
 * [placeholders] promptFragment = 效果提示词覆盖（缺席 = composeBlueprintPrompt 自动骨架）。
 */
export interface BlueprintToggle {
  enabled: boolean
  /** 蓝图参考图 assetId（≤2 张、去重——add-lab design §1.1；缺席 = 无原图）。 */
  refs?: string[]
  /** [placeholders] 效果提示词覆盖（EffectPromptDialog 编辑后落键）。 */
  promptFragment?: string
}

/**
 * [placeholders] 案例参照图功能开关（原必选绑定 → 正交开关，add-lab-effect-prompt-placeholders
 * design §2——〔实现口径〕不内嵌 caseBinding 副本：绑定唯一真源保持顶层 caseBinding 键，本键
 * 只承开关与效果提示词覆盖）。读面归一（消费层）：本键缺席 + 顶层绑定存在 → 开关视为开。
 */
export interface CaseRefToggle {
  enabled: boolean
  /** 案例参照图效果提示词覆盖（缺席 = 自动生成案例角色声明文案 CASE_DESC）。 */
  promptFragment?: string
}

/**
 * 格式 3：模板 v2（配置资产——提示词特化体 + 案例绑定 + 默认值 + 正交高级选项；总装骨架 = 代码，永不入文件）。
 * v2 新键全部可选，缺席语义：drillParams/blueprint 缺席 = 两开关关；gemSpecIds 缺席 = 无清单。
 */
export interface GemtplFile {
  kind: 'gemtpl'
  formatVersion: 2
  appVersion: string
  createdAt: number
  savedAt: number
  name: string
  /** 模板特化正文（≤8000，序列化与解析双侧截断）。 */
  promptBody: string
  caseBinding: LabCaseBinding | null
  /** 候选数默认（1-8，双侧 clamp）。 */
  candidates: number
  /** [placeholders] 案例参照图功能开关（v2 可选键；缺席 + 绑定存在 → 读面视为开——旧模板零行为变化）。 */
  caseRef?: CaseRefToggle
  /** 水钻参数配置高级选项（v2；缺席 = 关）。 */
  drillParams?: DrillParamsConfig
  /** 蓝图高级选项开关（v2；缺席 = 关）。 */
  blueprint?: BlueprintToggle
  /** 模板绑定钻清单（v2，canonical specKey 引用；编辑 UI 归 add-lab-drill-params-and-blueprint）。 */
  gemSpecIds?: string[]
  /** 溯源（展示用）：内置 preset seed / 用户新建 / 复制 fork。 */
  provenance: {
    source: GemtplProvenanceSource
    /** builtin-seed 时记 EFFECT_REF_PRESETS.id。 */
    presetId?: string
    /** 内置案例来源说明（EffectRefPreset.sourceNote）。 */
    sourceNote?: string
  }
}

/** gemgen 内嵌生成图（原始返回字节，非降采样；dataUrl 为唯一字节载体）。 */
export interface GemgenImage {
  mime: string
  dataUrl: string
  width: number
  height: number
}

/**
 * 蓝图效果档案图（v2 可选键；schema 位 W0 冻结——行为实现归 add-lab-drill-params-and-blueprint）。
 * typed 标记：本图恒为「人审参照、非 BOM 数据源」——消费方不得将其作为 BOM/逐钻数据来源。
 */
export interface GemgenBlueprintImage extends GemgenImage {
  /** 溯源：效果图请求 id（与 image 主图对应的效果请求）。 */
  effectRequestId?: string
  /** 溯源：蓝图请求 id。 */
  blueprintRequestId?: string
  /** typed 标记（字面量冻结）。 */
  role: 'human-review-reference'
}

/**
 * [placeholders] 效果提示词片段使用记录（gemgen provenance 审计键）：仅记录**实际发生替换**
 * 的效果（开关开且主提示词占位符存在）；值 = 片段来源（auto = 既有生成器 / override = 用户覆盖）。
 */
export type EffectFragmentSource = 'auto' | 'override'

export interface EffectFragmentSources {
  case?: EffectFragmentSource
  drill?: EffectFragmentSource
  blueprint?: EffectFragmentSource
}

/**
 * 格式 4：生成结果 v2（自包含不可变档案——图片内嵌 + 溯源全集；生成即定稿，无换绑路径）。
 * v2（design §1.3 / 裁决二）：provenance.mode 拆为 `requestMode`（endpoint 语义保留；
 * 旧 mode → requestMode 只读映射）+ drillParams/blueprint 正交快照（记录当次任务两开关与参数）；
 * 顶层 + blueprint?/gemSpecs?（ordinal→specKey 持久化映射即此数组）/physicalCanvas?。
 */
export interface GemgenFile {
  kind: 'gemgen'
  formatVersion: 2
  appVersion: string
  /** = 任务发起时刻（task.createdAt）。 */
  createdAt: number
  /** 归档时刻。 */
  savedAt: number
  name: string
  image: GemgenImage
  /** 蓝图效果档案图（v2；缺席 = 无蓝图）。 */
  blueprint?: GemgenBlueprintImage
  /** 钻清单快照（v2；ordinal→specKey 持久化映射）。 */
  gemSpecs?: GemSpecSnapshot[]
  /** 画幅级物理锚（v2；缺席 = default）。 */
  physicalCanvas?: PhysicalCanvas
  /** 溯源全集（展示 + 审计；不参与任何重放）。 */
  provenance: {
    /** 批次 id（画廊分组键延续）。 */
    runId: string
    /** 模板资产弱引用（画廊过滤键；模板删除/移动仍成立）。 */
    templateAssetId?: string
    /** 模板名快照（模板缺失时的显示兜底）。 */
    templateName: string
    /** 模板特化体快照（= task.prompt）。 */
    promptBody: string
    /** 提示词全文快照（composeDrillPrompt 请求时输出，审计真源；档案不打折不截断）。 */
    composedPrompt: string
    /** 发起时案例绑定快照（undefined = 键缺席；null = 显式未绑定）。 */
    caseBinding?: LabCaseBinding | null
    /** 原图资产 id（弱引用；沿 task.referenceAssetId）。 */
    referenceAssetId?: string
    /** 0 起候选序号。 */
    candidateIndex: number
    /** v2：请求端点语义（generate=生图 / edit=改图）——旧档案 mode 经迁移只读映射至此。 */
    requestMode: 'generate' | 'edit'
    model: string
    size: string
    /** 打码后的 Advanced JSON（maskAdvancedJsonForPersist 同口径，N3 纪律延伸到文件）。 */
    advancedJsonRedacted?: string
    /** 正交快照：当次任务水钻参数配置开关与参数（v2；缺席 = 当次未启用）。 */
    drillParams?: DrillParamsConfig
    /**
     * 正交快照：蓝图请求快照（v2；add-lab 4.1 键位接线——design §1.3 {strategy,status,error?}，
     * 单一真源类型 = lab/stages.ProvenanceBlueprintSnapshot）。缺席 = 当次未启用蓝图
     * （或单图先行档——blueprint 终态才落双图完整档，add-lab design §5.1）。
     */
    blueprint?: ProvenanceBlueprintSnapshot
    /**
     * 蓝图请求提示词全文快照（v2；add-lab §5.2 冻结落 provenance.blueprintPrompt——
     * blueprint 图键只承图与溯源 id，图与文分离沿 image 键先例；键名常量 = stages
     * PROVENANCE_BLUEPRINT_PROMPT_KEY）。缺席 = 无蓝图请求（或旧档）。
     */
    blueprintPrompt?: string
    /**
     * [placeholders] 效果提示词片段使用记录（v2；缺席 = 无任何占位符替换发生——旧档/全关）。
     * 只记实际替换的效果；值 auto/override = 片段来源。
     */
    fragmentSources?: EffectFragmentSources
  }
}

/** serializeGemtpl 输入：文件字段减去 kind/formatVersion（由序列化层固定写当前版本）。 */
export type GemtplFileInput = Omit<GemtplFile, 'kind' | 'formatVersion'>

/**
 * serializeGemgen 输入：advancedJson 传**原始值**（或已打码值），序列化边界统一按 N3 口径
 * 再打码为 advancedJsonRedacted（mask 幂等，调用方无法绕过打码漏出明文）。
 * [add-lab 4.1] lab store 写面已迁移 requestMode——v1 过渡写键 `mode` 输入面移除
 * （迁移入口 v1→v2 的 mode→requestMode 只读映射不变）。
 */
export interface GemgenFileInput extends Omit<GemgenFile, 'kind' | 'formatVersion' | 'provenance'> {
  provenance: Omit<GemgenFile['provenance'], 'advancedJsonRedacted'> & {
    /** 原始（或已打码）Advanced JSON；空/缺省 = 不落 advancedJsonRedacted 键。 */
    advancedJson?: string
    /** canonical 写键（必填——endpoint 语义）。 */
    requestMode: 'generate' | 'edit'
  }
}

// ---------------------------------------------------------------------------
// 校验助手（点分路径 typed error；只描述类型不携带值，避免泄露 dataUrl/凭据）
// ---------------------------------------------------------------------------

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'string') return `string(${value.length})`
  return typeof value
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabFileFieldError(path, '对象', describeValue(value))
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new LabFileFieldError(path, 'string', describeValue(value))
  return value
}

function expectNonEmptyString(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!text.trim()) throw new LabFileFieldError(path, '非空 string', describeValue(text))
  return text
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : expectString(value, path)
}

function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : expectNonEmptyString(value, path)
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LabFileFieldError(path, '有限 number', describeValue(value))
  }
  return value
}

function expectPositiveNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path)
  if (number <= 0) throw new LabFileFieldError(path, '正数', describeValue(number))
  return number
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new LabFileFieldError(path, '非负整数', describeValue(value))
  }
  return value
}

function expectPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new LabFileFieldError(path, '正整数（≥1）', describeValue(value))
  }
  return value
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LabFileFieldError(path, 'boolean', describeValue(value))
  }
  return value
}

const CASE_LAYOUTS: readonly string[] = ['horizontal', 'vertical', 'single']

function expectCaseLayout(value: unknown, path: string): CaseRefLayout {
  if (typeof value !== 'string' || !CASE_LAYOUTS.includes(value)) {
    throw new LabFileFieldError(path, "'horizontal' | 'vertical' | 'single'", describeValue(value))
  }
  return value as CaseRefLayout
}

/** 防御上限：promptBody 8000 截断（serialize/parse 双侧同口径）。 */
function clampPromptBody(body: string): string {
  return body.length <= GEMTPL_PROMPT_BODY_MAX ? body : body.slice(0, GEMTPL_PROMPT_BODY_MAX)
}

/** 防御上限：candidates 1-8 clamp（floor 同 normalizeVariants）；非有限数字 → typed error。 */
function clampCandidates(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LabFileFieldError(path, '有限 number', describeValue(value))
  }
  return Math.min(GEMTPL_CANDIDATES_MAX, Math.max(GEMTPL_CANDIDATES_MIN, Math.floor(value)))
}

function expectGemtplSource(value: unknown, path: string): GemtplProvenanceSource {
  if (value !== 'builtin-seed' && value !== 'user-created' && value !== 'forked') {
    throw new LabFileFieldError(path, "'builtin-seed' | 'user-created' | 'forked'", describeValue(value))
  }
  return value
}

/**
 * 案例绑定：校验 + 重建（键序确定）。undefined 原样返回（gemgen 可选键缺席与 null 显式
 * 未绑定是两种状态，不得混同）；gemtpl 侧由调用点把 undefined 判为缺字段。
 */
function parseCaseBinding(value: unknown, path: string): LabCaseBinding | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const record = expectRecord(value, path)
  return {
    assetId: expectNonEmptyString(record.assetId, `${path}.assetId`),
    caseLayout: expectCaseLayout(record.caseLayout, `${path}.caseLayout`),
  }
}

/** 档案严格 base64 data URL（image/png 等）：非空载荷 + 头部 mime 与 image.mime 一致。 */
const BASE64_DATAURL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/

function expectBase64DataUrl(value: unknown, path: string, expectedMime: string): string {
  const dataUrl = expectString(value, path)
  const match = BASE64_DATAURL_RE.exec(dataUrl)
  if (!match || match[2].length === 0) {
    throw new LabFileFieldError(path, '非空 base64 data URL（data:<mime>;base64,<载荷>）', describeValue(dataUrl))
  }
  if (match[1] !== expectedMime) {
    throw new LabFileFieldError(
      path,
      `头部 mime 与 image.mime（${expectedMime}）一致的 data URL`,
      `mime ${match[1]}`,
    )
  }
  return dataUrl
}

// ---------------------------------------------------------------------------
// 信封读取：MIME 门 → JSON → kind 门 → 版本门（→ 迁移链）——版本错误先于字段校验
// ---------------------------------------------------------------------------

/** parse 可选交叉校验：容器/节点声明的 MIME（导入路径用，design §2 三者对齐）。 */
export interface LabFileParseOptions {
  mime?: string
}

function readEnvelope(text: string, kind: LabFileKind, options?: LabFileParseOptions): Record<string, unknown> {
  if (options?.mime !== undefined && options.mime !== PROJECT_MIME[kind]) {
    throw new LabFileKindError('mime', PROJECT_MIME[kind], options.mime)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new LabFileFieldError('', '合法 JSON 文档', '无法解析', error instanceof Error ? error.message : String(error))
  }
  const envelope = expectRecord(parsed, '')
  const foundKind = envelope.kind
  if (typeof foundKind !== 'string') {
    throw new LabFileFieldError('kind', "'gemtpl' | 'gemgen'", describeValue(foundKind))
  }
  if (foundKind !== kind) {
    throw new LabFileKindError('kind', kind, foundKind)
  }
  const supported = LABFILE_FORMAT_VERSIONS[kind]
  const version = envelope.formatVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new LabFileFieldError('formatVersion', '整数', describeValue(version))
  }
  if (version > supported) throw new LabFileVersionError(kind, version, supported)
  if (version < supported) return runLabFileMigrations(kind, version, envelope)
  return envelope
}

// ---------------------------------------------------------------------------
// gemtpl serialize / parse
// ---------------------------------------------------------------------------

/** 序列化模板 v2：声明序构造 + 防御上限（截断/clamp）+ 输入类型校验（字段路径 typed error）；v2 新键可选（缺席不落键）。 */
export function serializeGemtpl(input: GemtplFileInput): string {
  const provenance = input.provenance
  const presetId = optionalNonEmptyString(provenance?.presetId, 'provenance.presetId')
  const sourceNote = optionalString(provenance?.sourceNote, 'provenance.sourceNote')
  const drillParams = input.drillParams === undefined ? undefined : parseDrillParams(input.drillParams, 'drillParams')
  const blueprint = input.blueprint === undefined ? undefined : parseBlueprintToggle(input.blueprint, 'blueprint')
  const gemSpecIds = input.gemSpecIds === undefined ? undefined : parseSpecKeyArray(input.gemSpecIds, 'gemSpecIds')
  const caseRef = input.caseRef === undefined ? undefined : parseCaseRefToggle(input.caseRef, 'caseRef')
  return JSON.stringify({
    kind: 'gemtpl',
    formatVersion: LABFILE_FORMAT_VERSIONS.gemtpl,
    appVersion: expectNonEmptyString(input.appVersion, 'appVersion'),
    createdAt: expectFiniteNumber(input.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(input.savedAt, 'savedAt'),
    name: expectString(input.name, 'name'),
    promptBody: clampPromptBody(expectString(input.promptBody, 'promptBody')),
    caseBinding: parseCaseBinding(input.caseBinding, 'caseBinding') ?? null,
    candidates: clampCandidates(input.candidates, 'candidates'),
    ...(caseRef !== undefined ? { caseRef } : {}),
    ...(drillParams !== undefined ? { drillParams } : {}),
    ...(blueprint !== undefined ? { blueprint } : {}),
    ...(gemSpecIds !== undefined ? { gemSpecIds } : {}),
    provenance: {
      source: expectGemtplSource(provenance?.source, 'provenance.source'),
      ...(presetId !== undefined ? { presetId } : {}),
      ...(sourceNote !== undefined ? { sourceNote } : {}),
    },
  })
}

/** 解析模板 v2：版本门 → 迁移链 → 逐字段校验/归一；可选键缺席即不落键（round-trip 字节等价前提）。 */
export function parseGemtpl(text: string, options?: LabFileParseOptions): GemtplFile {
  const envelope = readEnvelope(text, 'gemtpl', options)
  const provenance = expectRecord(envelope.provenance, 'provenance')
  const caseBinding = parseCaseBinding(envelope.caseBinding, 'caseBinding')
  if (caseBinding === undefined) {
    throw new LabFileFieldError('caseBinding', '案例绑定对象或 null', 'undefined', '必填键（null = 未绑定）')
  }
  const presetId = optionalNonEmptyString(provenance.presetId, 'provenance.presetId')
  const sourceNote = optionalString(provenance.sourceNote, 'provenance.sourceNote')
  const drillParams =
    envelope.drillParams === undefined ? undefined : parseDrillParams(envelope.drillParams, 'drillParams')
  const blueprint =
    envelope.blueprint === undefined ? undefined : parseBlueprintToggle(envelope.blueprint, 'blueprint')
  const gemSpecIds =
    envelope.gemSpecIds === undefined ? undefined : parseSpecKeyArray(envelope.gemSpecIds, 'gemSpecIds')
  const caseRef = envelope.caseRef === undefined ? undefined : parseCaseRefToggle(envelope.caseRef, 'caseRef')
  return {
    kind: 'gemtpl',
    formatVersion: LABFILE_FORMAT_VERSIONS.gemtpl,
    appVersion: expectNonEmptyString(envelope.appVersion, 'appVersion'),
    createdAt: expectFiniteNumber(envelope.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(envelope.savedAt, 'savedAt'),
    name: expectString(envelope.name, 'name'),
    promptBody: clampPromptBody(expectString(envelope.promptBody, 'promptBody')),
    caseBinding,
    candidates: clampCandidates(envelope.candidates, 'candidates'),
    ...(caseRef !== undefined ? { caseRef } : {}),
    ...(drillParams !== undefined ? { drillParams } : {}),
    ...(blueprint !== undefined ? { blueprint } : {}),
    ...(gemSpecIds !== undefined ? { gemSpecIds } : {}),
    provenance: {
      source: expectGemtplSource(provenance.source, 'provenance.source'),
      ...(presetId !== undefined ? { presetId } : {}),
      ...(sourceNote !== undefined ? { sourceNote } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// gemgen serialize / parse
// ---------------------------------------------------------------------------

/**
 * 序列化生成档案 v2：advancedJson 在此边界统一 N3 打码（幂等）；composedPrompt 全文不截断。
 * [add-lab 4.1] requestMode 为唯一写键（v1 过渡 mode 输入面已随 lab store 写面迁移移除）；
 * provenance.blueprint 快照/blueprintPrompt 全文快照随双图完整档落键（§1.3/§5.2）。
 */
export function serializeGemgen(input: GemgenFileInput): string {
  const provenance = input.provenance
  const image = input.image
  const mime = expectNonEmptyString(image?.mime, 'image.mime')
  const templateAssetId = optionalNonEmptyString(provenance?.templateAssetId, 'provenance.templateAssetId')
  const referenceAssetId = optionalNonEmptyString(provenance?.referenceAssetId, 'provenance.referenceAssetId')
  const caseBinding = parseCaseBinding(provenance?.caseBinding, 'provenance.caseBinding')
  const advancedJson = optionalString(provenance?.advancedJson, 'provenance.advancedJson')
  const redacted = advancedJson === undefined ? '' : maskAdvancedJsonForPersist(advancedJson)
  if (provenance?.requestMode === undefined) {
    throw new LabFileFieldError('provenance.requestMode', "'generate' | 'edit'", 'undefined（必填）')
  }
  const requestMode = expectGemgenMode(provenance.requestMode, 'provenance.requestMode')
  const blueprint = input.blueprint === undefined ? undefined : parseGemgenBlueprint(input.blueprint, 'blueprint')
  const gemSpecs =
    input.gemSpecs === undefined
      ? undefined
      : Array.isArray(input.gemSpecs)
        ? input.gemSpecs.map((spec, index) => parseGemSpecSnapshot(spec, `gemSpecs.${index}`))
        : (() => {
            throw new LabFileFieldError('gemSpecs', 'GemSpecSnapshot 数组', describeValue(input.gemSpecs))
          })()
  const physicalCanvas = parsePhysicalCanvas(input.physicalCanvas, 'physicalCanvas')
  const drillParams =
    provenance?.drillParams === undefined
      ? undefined
      : parseDrillParams(provenance.drillParams, 'provenance.drillParams')
  const blueprintSnapshot =
    provenance?.blueprint === undefined
      ? undefined
      : parseProvenanceBlueprintSnapshot(provenance.blueprint, 'provenance.blueprint')
  const blueprintPrompt = optionalString(provenance?.blueprintPrompt, `provenance.${PROVENANCE_BLUEPRINT_PROMPT_KEY}`)
  const fragmentSources =
    provenance?.fragmentSources === undefined
      ? undefined
      : parseEffectFragmentSources(provenance.fragmentSources, 'provenance.fragmentSources')
  return JSON.stringify({
    kind: 'gemgen',
    formatVersion: LABFILE_FORMAT_VERSIONS.gemgen,
    appVersion: expectNonEmptyString(input.appVersion, 'appVersion'),
    createdAt: expectFiniteNumber(input.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(input.savedAt, 'savedAt'),
    name: expectString(input.name, 'name'),
    image: {
      mime,
      dataUrl: expectBase64DataUrl(image?.dataUrl, 'image.dataUrl', mime),
      width: expectPositiveNumber(image?.width, 'image.width'),
      height: expectPositiveNumber(image?.height, 'image.height'),
    },
    ...(blueprint !== undefined ? { blueprint } : {}),
    ...(gemSpecs !== undefined ? { gemSpecs } : {}),
    ...(physicalCanvas !== undefined ? { physicalCanvas } : {}),
    provenance: {
      runId: expectNonEmptyString(provenance?.runId, 'provenance.runId'),
      ...(templateAssetId !== undefined ? { templateAssetId } : {}),
      templateName: expectNonEmptyString(provenance?.templateName, 'provenance.templateName'),
      promptBody: expectString(provenance?.promptBody, 'provenance.promptBody'),
      composedPrompt: expectString(provenance?.composedPrompt, 'provenance.composedPrompt'),
      ...(caseBinding !== undefined ? { caseBinding } : {}),
      ...(referenceAssetId !== undefined ? { referenceAssetId } : {}),
      candidateIndex: expectNonNegativeInteger(provenance?.candidateIndex, 'provenance.candidateIndex'),
      requestMode,
      model: expectNonEmptyString(provenance?.model, 'provenance.model'),
      size: expectNonEmptyString(provenance?.size, 'provenance.size'),
      ...(redacted !== '' ? { advancedJsonRedacted: redacted } : {}),
      ...(drillParams !== undefined ? { drillParams } : {}),
      ...(blueprintSnapshot !== undefined ? { blueprint: blueprintSnapshot } : {}),
      ...(blueprintPrompt !== undefined ? { [PROVENANCE_BLUEPRINT_PROMPT_KEY]: blueprintPrompt } : {}),
      ...(fragmentSources !== undefined && Object.keys(fragmentSources).length > 0 ? { fragmentSources } : {}),
    },
  })
}

function expectGemgenMode(value: unknown, path: string): 'generate' | 'edit' {
  if (value !== 'generate' && value !== 'edit') {
    throw new LabFileFieldError(path, "'generate' | 'edit'", describeValue(value))
  }
  return value
}

// ---------------------------------------------------------------------------
// v2 子结构校验（physicalCanvas / drillParams / blueprint / gemSpecs——gem-catalog W0 0.3）
// ---------------------------------------------------------------------------

function parsePhysicalCanvas(value: unknown, path: string): PhysicalCanvas | undefined {
  if (value === undefined) return undefined
  const record = expectRecord(value, path)
  const anchorSource = record.anchorSource
  if (anchorSource !== 'declared' && anchorSource !== 'default') {
    throw new LabFileFieldError(`${path}.anchorSource`, "'declared' | 'default'", describeValue(anchorSource))
  }
  return {
    widthMm: expectPositiveNumber(record.widthMm, `${path}.widthMm`),
    heightMm: expectPositiveNumber(record.heightMm, `${path}.heightMm`),
    anchorSource,
  }
}

function expectSpecKeyString(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!text.trim() || /\s/.test(text)) {
    throw new LabFileFieldError(path, '非空且不含空白的 specKey（canonical 键）', describeValue(text))
  }
  return text
}

/** 钻清单（specKey 引用数组；按遭遇序重建）。 */
function parseSpecKeyArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new LabFileFieldError(path, 'specKey 字符串数组', describeValue(value))
  return value.map((entry, index) => expectSpecKeyString(entry, `${path}.${index}`))
}

/**
 * 水钻参数配置高级选项（正交开关 + 钻清单 + 可选尺寸信息）。
 * [add-lab 4.1] 脏输入防线（task 4.1）：specs 重复 specKey = typed error（身份唯一性禁令）；
 * enabled=true + 空清单 = typed error（§1.1 enabled⇒specs≥1；enabled=false + 空清单 =
 * 关灯空态合法，enabled=false + 已填清单 = 关灯不丢数据合法）。
 */
function parseDrillParams(value: unknown, path: string): DrillParamsConfig {
  const record = expectRecord(value, path)
  const physical = parsePhysicalCanvas(record.physical, `${path}.physical`)
  const specs = parseSpecKeyArray(record.specs, `${path}.specs`)
  const seen = new Set<string>()
  specs.forEach((key, index) => {
    if (seen.has(key)) {
      throw new LabFileFieldError(`${path}.specs.${index}`, '不重复的 specKey（清单内去重）', key)
    }
    seen.add(key)
  })
  const enabled = expectBoolean(record.enabled, `${path}.enabled`)
  if (enabled && specs.length === 0) {
    throw new LabFileFieldError(`${path}.specs`, '启用时至少 1 条（enabled=true ⇒ specs≥1）', '空清单')
  }
  const promptFragment = optionalString(record.promptFragment, `${path}.promptFragment`)
  return {
    enabled,
    specs,
    ...(physical !== undefined ? { physical } : {}),
    ...(promptFragment !== undefined ? { promptFragment } : {}),
  }
}

/** [placeholders] 案例参照图功能开关（enabled + 可选覆盖文本；caseBinding 不入本键）。 */
function parseCaseRefToggle(value: unknown, path: string): CaseRefToggle {
  const record = expectRecord(value, path)
  const promptFragment = optionalString(record.promptFragment, `${path}.promptFragment`)
  return {
    enabled: expectBoolean(record.enabled, `${path}.enabled`),
    ...(promptFragment !== undefined ? { promptFragment } : {}),
  }
}

/** 蓝图参考图 assetId 数组（≤2 硬上限 + 非空 + 去重——add-lab 4.1 键位补齐；上限常量单源 = advancedOptions）。 */
function parseBlueprintRefs(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new LabFileFieldError(path, 'assetId 字符串数组', describeValue(value))
  if (value.length > BLUEPRINT_REFS_MAX) {
    throw new LabFileFieldError(path, `至多 ${BLUEPRINT_REFS_MAX} 张蓝图参考图`, `${value.length} 条`)
  }
  const out: string[] = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new LabFileFieldError(`${path}.${index}`, '非空 assetId 字符串', describeValue(entry))
    }
    if (out.includes(entry)) {
      throw new LabFileFieldError(`${path}.${index}`, '不重复的 assetId（列表内去重）', entry)
    }
    out.push(entry)
  })
  return out
}

function parseBlueprintToggle(value: unknown, path: string): BlueprintToggle {
  const record = expectRecord(value, path)
  const refs = record.refs === undefined ? undefined : parseBlueprintRefs(record.refs, `${path}.refs`)
  const promptFragment = optionalString(record.promptFragment, `${path}.promptFragment`)
  return {
    enabled: expectBoolean(record.enabled, `${path}.enabled`),
    ...(refs !== undefined ? { refs } : {}),
    ...(promptFragment !== undefined ? { promptFragment } : {}),
  }
}

/** [placeholders] gemgen provenance.fragmentSources（只承 auto/override 枚举；脏值 typed reject）。 */
function parseEffectFragmentSources(value: unknown, path: string): EffectFragmentSources {
  const record = expectRecord(value, path)
  const sourceOf = (key: keyof EffectFragmentSources): EffectFragmentSource | undefined => {
    const entry = record[key]
    if (entry === undefined) return undefined
    if (entry !== 'auto' && entry !== 'override') {
      throw new LabFileFieldError(`${path}.${key}`, "'auto' | 'override'", describeValue(entry))
    }
    return entry
  }
  const sources: EffectFragmentSources = {}
  let present = false
  for (const key of ['case', 'drill', 'blueprint'] as const) {
    const source = sourceOf(key)
    if (source !== undefined) {
      sources[key] = source
      present = true
    }
  }
  return present ? sources : {}
}

/**
 * gemgen provenance.blueprint 请求快照（add-lab design §1.3——{strategy,status,error?}；
 * skipped 档案投影压缩为 cancelled+错误码由 stages.blueprintProvenanceOf 负责，本层只校形状）。
 */
function parseProvenanceBlueprintSnapshot(value: unknown, path: string): ProvenanceBlueprintSnapshot {
  const record = expectRecord(value, path)
  const strategy = record.strategy
  if (strategy !== 'serial' && strategy !== 'parallel') {
    throw new LabFileFieldError(`${path}.strategy`, "'serial' | 'parallel'", describeValue(strategy))
  }
  const status = record.status
  if (status !== 'success' && status !== 'failed' && status !== 'cancelled') {
    throw new LabFileFieldError(`${path}.status`, "'success' | 'failed' | 'cancelled'", describeValue(status))
  }
  const error = record.error === undefined ? undefined : expectString(record.error, `${path}.error`)
  return { strategy, status, ...(error !== undefined ? { error } : {}) }
}

const LAB_SHAPE_IDS: readonly string[] = ['round', 'square', 'drop', 'heart', 'marquise', 'custom']

function expectShapeId(value: unknown, path: string): ShapeId {
  if (typeof value !== 'string' || !LAB_SHAPE_IDS.includes(value)) {
    throw new LabFileFieldError(path, `形 id（${LAB_SHAPE_IDS.join('/')}）`, describeValue(value))
  }
  return value as ShapeId
}

/**
 * GemSpecSnapshot 校验 + 键序重建（gemgen.gemSpecs 条目——ordinal→specKey 持久化映射）。
 * [R6 P1-1] custom 规格缺 assetId = typed reject（engine customAssetIdMissing 单一语义源；
 * serialize/parse 双侧同口径——serializeGemgen 经本函数校验，坏输入整体拒绝无半载荷）。
 */
function parseGemSpecSnapshot(value: unknown, path: string): GemSpecSnapshot {
  const record = expectRecord(value, path)
  const shapeId = expectShapeId(record.shapeId, `${path}.shapeId`)
  if (customAssetIdMissing(record)) {
    throw new LabFileFieldError(
      `${path}.assetId`,
      "shapeId='custom' 时的非空 assetId（custom specKey 派生依据）",
      record.assetId === undefined ? 'undefined（custom 规格缺 assetId——typed reject）' : '空串（custom 规格缺 assetId——typed reject）',
    )
  }
  const widthMm = record.widthMm === undefined ? undefined : expectPositiveNumber(record.widthMm, `${path}.widthMm`)
  const heightMm = record.heightMm === undefined ? undefined : expectPositiveNumber(record.heightMm, `${path}.heightMm`)
  const assetId = record.assetId === undefined ? undefined : expectNonEmptyString(record.assetId, `${path}.assetId`)
  const rotationDegRaw = record.rotationDeg
  let rotationDeg: number | undefined
  if (rotationDegRaw !== undefined) {
    rotationDeg = expectFiniteNumber(rotationDegRaw, `${path}.rotationDeg`)
    if (rotationDeg < 0 || rotationDeg >= 360) {
      throw new LabFileFieldError(`${path}.rotationDeg`, '[0,360) 的数', describeValue(rotationDeg))
    }
  }
  return {
    specKey: expectSpecKeyString(record.specKey, `${path}.specKey`),
    ordinal: expectPositiveInteger(record.ordinal, `${path}.ordinal`),
    shapeId,
    sizeLabel: expectNonEmptyString(record.sizeLabel, `${path}.sizeLabel`),
    diameterMm: expectPositiveNumber(record.diameterMm, `${path}.diameterMm`),
    ...(widthMm !== undefined ? { widthMm } : {}),
    ...(heightMm !== undefined ? { heightMm } : {}),
    ...(assetId !== undefined ? { assetId } : {}),
    ...(rotationDeg !== undefined ? { rotationDeg } : {}),
  }
}

/** 蓝图效果档案图（typed 标记 role 字面量冻结）。 */
function parseGemgenBlueprint(value: unknown, path: string): GemgenBlueprintImage {
  const record = expectRecord(value, path)
  if (record.role !== 'human-review-reference') {
    throw new LabFileFieldError(`${path}.role`, "'human-review-reference'（人审参照、非 BOM 数据源——typed 标记）", describeValue(record.role))
  }
  const mime = expectNonEmptyString(record.mime, `${path}.mime`)
  const effectRequestId =
    record.effectRequestId === undefined ? undefined : expectNonEmptyString(record.effectRequestId, `${path}.effectRequestId`)
  const blueprintRequestId =
    record.blueprintRequestId === undefined
      ? undefined
      : expectNonEmptyString(record.blueprintRequestId, `${path}.blueprintRequestId`)
  return {
    mime,
    dataUrl: expectBase64DataUrl(record.dataUrl, `${path}.dataUrl`, mime),
    width: expectPositiveNumber(record.width, `${path}.width`),
    height: expectPositiveNumber(record.height, `${path}.height`),
    ...(effectRequestId !== undefined ? { effectRequestId } : {}),
    ...(blueprintRequestId !== undefined ? { blueprintRequestId } : {}),
    role: 'human-review-reference',
  }
}

/** 解析生成档案 v2：不可变档案只读解析，不重放、不修正业务字段（防御上限不适用于审计快照）。 */
export function parseGemgen(text: string, options?: LabFileParseOptions): GemgenFile {
  const envelope = readEnvelope(text, 'gemgen', options)
  const image = expectRecord(envelope.image, 'image')
  const mime = expectNonEmptyString(image.mime, 'image.mime')
  const provenance = expectRecord(envelope.provenance, 'provenance')
  const templateAssetId = optionalNonEmptyString(provenance.templateAssetId, 'provenance.templateAssetId')
  const referenceAssetId = optionalNonEmptyString(provenance.referenceAssetId, 'provenance.referenceAssetId')
  const caseBinding = parseCaseBinding(provenance.caseBinding, 'provenance.caseBinding')
  const advancedJsonRedacted = optionalString(provenance.advancedJsonRedacted, 'provenance.advancedJsonRedacted')
  const blueprint =
    envelope.blueprint === undefined ? undefined : parseGemgenBlueprint(envelope.blueprint, 'blueprint')
  const gemSpecs =
    envelope.gemSpecs === undefined
      ? undefined
      : Array.isArray(envelope.gemSpecs)
        ? envelope.gemSpecs.map((spec, index) => parseGemSpecSnapshot(spec, `gemSpecs.${index}`))
        : (() => {
            throw new LabFileFieldError('gemSpecs', 'GemSpecSnapshot 数组', describeValue(envelope.gemSpecs))
          })()
  const physicalCanvas = parsePhysicalCanvas(envelope.physicalCanvas, 'physicalCanvas')
  const drillParams =
    provenance.drillParams === undefined
      ? undefined
      : parseDrillParams(provenance.drillParams, 'provenance.drillParams')
  const blueprintSnapshot =
    provenance.blueprint === undefined
      ? undefined
      : parseProvenanceBlueprintSnapshot(provenance.blueprint, 'provenance.blueprint')
  const blueprintPrompt = optionalString(
    provenance[PROVENANCE_BLUEPRINT_PROMPT_KEY],
    `provenance.${PROVENANCE_BLUEPRINT_PROMPT_KEY}`,
  )
  const fragmentSources =
    provenance.fragmentSources === undefined
      ? undefined
      : parseEffectFragmentSources(provenance.fragmentSources, 'provenance.fragmentSources')
  return {
    kind: 'gemgen',
    formatVersion: LABFILE_FORMAT_VERSIONS.gemgen,
    appVersion: expectNonEmptyString(envelope.appVersion, 'appVersion'),
    createdAt: expectFiniteNumber(envelope.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(envelope.savedAt, 'savedAt'),
    name: expectString(envelope.name, 'name'),
    image: {
      mime,
      dataUrl: expectBase64DataUrl(image.dataUrl, 'image.dataUrl', mime),
      width: expectPositiveNumber(image.width, 'image.width'),
      height: expectPositiveNumber(image.height, 'image.height'),
    },
    ...(blueprint !== undefined ? { blueprint } : {}),
    ...(gemSpecs !== undefined ? { gemSpecs } : {}),
    ...(physicalCanvas !== undefined ? { physicalCanvas } : {}),
    provenance: {
      runId: expectNonEmptyString(provenance.runId, 'provenance.runId'),
      ...(templateAssetId !== undefined ? { templateAssetId } : {}),
      templateName: expectNonEmptyString(provenance.templateName, 'provenance.templateName'),
      promptBody: expectString(provenance.promptBody, 'provenance.promptBody'),
      composedPrompt: expectString(provenance.composedPrompt, 'provenance.composedPrompt'),
      ...(caseBinding !== undefined ? { caseBinding } : {}),
      ...(referenceAssetId !== undefined ? { referenceAssetId } : {}),
      candidateIndex: expectNonNegativeInteger(provenance.candidateIndex, 'provenance.candidateIndex'),
      requestMode: expectGemgenMode(provenance.requestMode, 'provenance.requestMode'),
      model: expectNonEmptyString(provenance.model, 'provenance.model'),
      size: expectNonEmptyString(provenance.size, 'provenance.size'),
      ...(advancedJsonRedacted !== undefined ? { advancedJsonRedacted } : {}),
      ...(drillParams !== undefined ? { drillParams } : {}),
      ...(blueprintSnapshot !== undefined ? { blueprint: blueprintSnapshot } : {}),
      ...(blueprintPrompt !== undefined ? { [PROVENANCE_BLUEPRINT_PROMPT_KEY]: blueprintPrompt } : {}),
      ...(fragmentSources !== undefined && Object.keys(fragmentSources).length > 0 ? { fragmentSources } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// MIME 对齐（PROJECT_MIME 唯一真源的只读投影）与图像消费
// ---------------------------------------------------------------------------

/** 各格式落库/导出应使用的 vendor MIME（消费 projectTypes 的 PROJECT_MIME，不重定义）。 */
export function labFileMime(kind: LabFileKind): (typeof PROJECT_MIME)[LabFileKind] {
  return PROJECT_MIME[kind]
}

/**
 * 内嵌生成图 → Blob（零重编码：base64 解码为原始字节，Blob type 取档案 image.mime）。
 * 供「送排钻」等跨模块消费（design §9.2 B2：gemgen 校验节点后 parse 内嵌图，不重编码）。
 * 坏 dataUrl → LabFileFieldError('image.dataUrl')。与 imageStore.dataUrlToBlob 的分工：
 * 那是通用宽松版（百分号编码亦收、generic Error）；此处是档案专用严格版（typed error +
 * mime 以 schema 为权威），故不复用。
 */
export async function gemgenImageBlob(file: GemgenFile): Promise<Blob> {
  const { mime, dataUrl } = file.image
  const match = BASE64_DATAURL_RE.exec(dataUrl)
  if (!match || match[2].length === 0 || match[1] !== mime) {
    throw new LabFileFieldError(
      'image.dataUrl',
      `非空 base64 data URL 且头部 mime 与 image.mime（${mime}）一致`,
      describeValue(dataUrl),
    )
  }
  let binary: string
  try {
    binary = atob(match[2])
  } catch (error) {
    throw new LabFileFieldError('image.dataUrl', '合法 base64 载荷', '解码失败', error instanceof Error ? error.message : String(error))
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// ---------------------------------------------------------------------------
// v1→v2 迁移注册（gem-catalog W0 0.3，design §1.3——纯函数，无 IO）
// ---------------------------------------------------------------------------

/**
 * gemtpl v1→v2：三新键（drillParams/blueprint/gemSpecIds）v1 均不存在——防御性归一为缺席
 * （缺席 = 两开关关 / 无清单；迁移本体为直通）。完整键形消费语义归 add-lab-drill-params-and-blueprint。
 */
registerLabFileMigration('gemtpl', 1, 2, (data) => {
  const out = { ...data }
  delete out.drillParams
  delete out.blueprint
  delete out.gemSpecIds
  delete out.caseRef
  out.formatVersion = 2
  return out
})

/**
 * gemgen v1→v2：provenance.mode → requestMode（endpoint 语义保留，只读映射——原键删除）；
 * blueprint/gemSpecs/physicalCanvas/provenance 正交快照/blueprintPrompt 全部缺席 = 无蓝图 /
 * 两开关关 / default 画幅（v1 schema 无此键——手造脏键防御性删除，沿 gemtpl 迁移同口径）。
 */
registerLabFileMigration('gemgen', 1, 2, (data) => {
  const provenance = expectRecord(data.provenance, 'provenance')
  const mode = expectGemgenMode(provenance.mode, 'provenance.mode')
  const nextProvenance: Record<string, unknown> = { ...provenance, requestMode: mode }
  delete nextProvenance.mode
  delete nextProvenance.drillParams
  delete nextProvenance.blueprint
  delete nextProvenance[PROVENANCE_BLUEPRINT_PROMPT_KEY]
  delete nextProvenance.fragmentSources
  const out: Record<string, unknown> = { ...data, provenance: nextProvenance, formatVersion: 2 }
  delete out.blueprint
  delete out.gemSpecs
  delete out.physicalCanvas
  return out
})
