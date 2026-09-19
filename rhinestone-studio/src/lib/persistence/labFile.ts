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
import { PROJECT_MIME } from '$lib/persistence/projectTypes'

// ---------------------------------------------------------------------------
// 版本与防御上限（schema 校验接管原 localStorage 防线）
// ---------------------------------------------------------------------------

export type LabFileKind = 'gemtpl' | 'gemgen'

/** 各格式当前支持的 formatVersion（迁移链终点；bump 必附 round-trip 测试）。 */
export const LABFILE_FORMAT_VERSIONS = {
  gemtpl: 1,
  gemgen: 1,
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

/** 格式 3：模板（配置资产——提示词特化体 + 案例绑定 + 默认值；总装骨架 = 代码，永不入文件）。 */
export interface GemtplFile {
  kind: 'gemtpl'
  formatVersion: 1
  appVersion: string
  createdAt: number
  savedAt: number
  name: string
  /** 模板特化正文（≤8000，序列化与解析双侧截断）。 */
  promptBody: string
  caseBinding: LabCaseBinding | null
  /** 候选数默认（1-8，双侧 clamp）。 */
  candidates: number
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

/** 格式 4：生成结果（自包含不可变档案——图片内嵌 + 溯源全集；生成即定稿，无换绑路径）。 */
export interface GemgenFile {
  kind: 'gemgen'
  formatVersion: 1
  appVersion: string
  /** = 任务发起时刻（task.createdAt）。 */
  createdAt: number
  /** 归档时刻。 */
  savedAt: number
  name: string
  image: GemgenImage
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
    /** 参考原图资产 id（弱引用；沿 task.referenceAssetId）。 */
    referenceAssetId?: string
    /** 0 起候选序号。 */
    candidateIndex: number
    mode: 'generate' | 'edit'
    model: string
    size: string
    /** 打码后的 Advanced JSON（maskAdvancedJsonForPersist 同口径，N3 纪律延伸到文件）。 */
    advancedJsonRedacted?: string
  }
}

/** serializeGemtpl 输入：文件字段减去 kind/formatVersion（由序列化层固定写当前版本）。 */
export type GemtplFileInput = Omit<GemtplFile, 'kind' | 'formatVersion'>

/**
 * serializeGemgen 输入：advancedJson 传**原始值**（或已打码值），序列化边界统一按 N3 口径
 * 再打码为 advancedJsonRedacted（mask 幂等，调用方无法绕过打码漏出明文）。
 */
export interface GemgenFileInput extends Omit<GemgenFile, 'kind' | 'formatVersion' | 'provenance'> {
  provenance: Omit<GemgenFile['provenance'], 'advancedJsonRedacted'> & {
    /** 原始（或已打码）Advanced JSON；空/缺省 = 不落 advancedJsonRedacted 键。 */
    advancedJson?: string
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

/** 序列化模板：声明序构造 + 防御上限（截断/clamp）+ 输入类型校验（字段路径 typed error）。 */
export function serializeGemtpl(input: GemtplFileInput): string {
  const provenance = input.provenance
  const presetId = optionalNonEmptyString(provenance?.presetId, 'provenance.presetId')
  const sourceNote = optionalString(provenance?.sourceNote, 'provenance.sourceNote')
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
    provenance: {
      source: expectGemtplSource(provenance?.source, 'provenance.source'),
      ...(presetId !== undefined ? { presetId } : {}),
      ...(sourceNote !== undefined ? { sourceNote } : {}),
    },
  })
}

/** 解析模板：版本门 → 逐字段校验/归一；可选键缺席即不落键（round-trip 字节等价前提）。 */
export function parseGemtpl(text: string, options?: LabFileParseOptions): GemtplFile {
  const envelope = readEnvelope(text, 'gemtpl', options)
  const provenance = expectRecord(envelope.provenance, 'provenance')
  const caseBinding = parseCaseBinding(envelope.caseBinding, 'caseBinding')
  if (caseBinding === undefined) {
    throw new LabFileFieldError('caseBinding', '案例绑定对象或 null', 'undefined', '必填键（null = 未绑定）')
  }
  const presetId = optionalNonEmptyString(provenance.presetId, 'provenance.presetId')
  const sourceNote = optionalString(provenance.sourceNote, 'provenance.sourceNote')
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

/** 序列化生成档案：advancedJson 在此边界统一 N3 打码（幂等）；composedPrompt 全文不截断。 */
export function serializeGemgen(input: GemgenFileInput): string {
  const provenance = input.provenance
  const image = input.image
  const mime = expectNonEmptyString(image?.mime, 'image.mime')
  const templateAssetId = optionalNonEmptyString(provenance?.templateAssetId, 'provenance.templateAssetId')
  const referenceAssetId = optionalNonEmptyString(provenance?.referenceAssetId, 'provenance.referenceAssetId')
  const caseBinding = parseCaseBinding(provenance?.caseBinding, 'provenance.caseBinding')
  const advancedJson = optionalString(provenance?.advancedJson, 'provenance.advancedJson')
  const redacted = advancedJson === undefined ? '' : maskAdvancedJsonForPersist(advancedJson)
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
    provenance: {
      runId: expectNonEmptyString(provenance?.runId, 'provenance.runId'),
      ...(templateAssetId !== undefined ? { templateAssetId } : {}),
      templateName: expectNonEmptyString(provenance?.templateName, 'provenance.templateName'),
      promptBody: expectString(provenance?.promptBody, 'provenance.promptBody'),
      composedPrompt: expectString(provenance?.composedPrompt, 'provenance.composedPrompt'),
      ...(caseBinding !== undefined ? { caseBinding } : {}),
      ...(referenceAssetId !== undefined ? { referenceAssetId } : {}),
      candidateIndex: expectNonNegativeInteger(provenance?.candidateIndex, 'provenance.candidateIndex'),
      mode: expectGemgenMode(provenance?.mode, 'provenance.mode'),
      model: expectNonEmptyString(provenance?.model, 'provenance.model'),
      size: expectNonEmptyString(provenance?.size, 'provenance.size'),
      ...(redacted !== '' ? { advancedJsonRedacted: redacted } : {}),
    },
  })
}

function expectGemgenMode(value: unknown, path: string): 'generate' | 'edit' {
  if (value !== 'generate' && value !== 'edit') {
    throw new LabFileFieldError(path, "'generate' | 'edit'", describeValue(value))
  }
  return value
}

/** 解析生成档案：不可变档案只读解析，不重放、不修正业务字段（防御上限不适用于审计快照）。 */
export function parseGemgen(text: string, options?: LabFileParseOptions): GemgenFile {
  const envelope = readEnvelope(text, 'gemgen', options)
  const image = expectRecord(envelope.image, 'image')
  const mime = expectNonEmptyString(image.mime, 'image.mime')
  const provenance = expectRecord(envelope.provenance, 'provenance')
  const templateAssetId = optionalNonEmptyString(provenance.templateAssetId, 'provenance.templateAssetId')
  const referenceAssetId = optionalNonEmptyString(provenance.referenceAssetId, 'provenance.referenceAssetId')
  const caseBinding = parseCaseBinding(provenance.caseBinding, 'provenance.caseBinding')
  const advancedJsonRedacted = optionalString(provenance.advancedJsonRedacted, 'provenance.advancedJsonRedacted')
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
    provenance: {
      runId: expectNonEmptyString(provenance.runId, 'provenance.runId'),
      ...(templateAssetId !== undefined ? { templateAssetId } : {}),
      templateName: expectNonEmptyString(provenance.templateName, 'provenance.templateName'),
      promptBody: expectString(provenance.promptBody, 'provenance.promptBody'),
      composedPrompt: expectString(provenance.composedPrompt, 'provenance.composedPrompt'),
      ...(caseBinding !== undefined ? { caseBinding } : {}),
      ...(referenceAssetId !== undefined ? { referenceAssetId } : {}),
      candidateIndex: expectNonNegativeInteger(provenance.candidateIndex, 'provenance.candidateIndex'),
      mode: expectGemgenMode(provenance.mode, 'provenance.mode'),
      model: expectNonEmptyString(provenance.model, 'provenance.model'),
      size: expectNonEmptyString(provenance.size, 'provenance.size'),
      ...(advancedJsonRedacted !== undefined ? { advancedJsonRedacted } : {}),
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
