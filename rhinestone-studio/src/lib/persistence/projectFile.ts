/**
 * 项目文件格式对（.gemproj 参数工程 / .gemdoc 烘焙文档）的序列化层——
 * 两格式 serialize / parse / 版本迁移链的**唯一出口**
 * （openspec add-project-files design §1.1/§1.2 + §1.3 版本纪律 + §2 PROJECT_MIME；
 * 与 labFile.ts 同族同纪律：门序 / typed error 家族 / round-trip 字节等价 / 迁移链骨架）。
 *
 * 正交意图：
 * 1. [2026-09-19 add-project-files 0.2] 确定性序列化：对象字面量按 schema 声明序构造（不排序
 *    不 hack），serialize→parse→serialize 字节等价；Record（覆写四表）按遭遇序重建，往返稳定。
 * 2. [版本纪律 §1.3] formatVersion 向前拒读（ProjectFileVersionError，「文件来自更新版本的应用」，
 *    不猜测解析）；迁移链 (from,to)=>migrate 注册表逐版本串行，v1 空链；每次 bump 附 round-trip 测试。
 *    gemproj 携带 ENGINE_VERSION（engine/version.ts 唯一真源；重放漂移横幅的比对基准）。
 * 3. [防御] 脏输入 typed error 带字段路径（ProjectFileFieldError，点分路径如 overrides.density.b3、
 *    blocks.2.mask.bits）；serialize / parse 双侧同口径校验，杜绝非法字节落盘。
 * 4. [双形态 source §1.1] serializeGemproj 的 source 接受 asset 引用 / embedded 内嵌（导出磁盘时
 *    烘焙原始图字节 dataUrl）两形态；**dataUrl 只存在文件字节，不驻留内存 store——本模块零模块态，
 *    序列化即弃**（embedded dataUrl 由调用方在导出边界现做现用，库内保存恒走 asset 引用形态）。
 * 5. [painting §1.2] gemdoc painting = 内嵌 PNG dataUrl（数字油画 k 色平涂，PNG 压缩率高）；
 *    paintingToDataUrl / dataUrlToPainting 是像素面 ↔ PNG 字节的编解码助手（canvas 委托，
 *    零重采样；序列化层只透传 dataUrl 字符串，不重编码——round-trip 字节等价的前提）。
 *
 * 「不入文件」清单（design §1.1/§1.2，冻结；类型层即不存在，非序列化时剔除）：
 * - gemproj：五策略 results / previewMode / overlayOpacity / selectedBlockId /
 *   推导常量（SEGMENT_GEM_DIAMETER_PX、minAreaFor 算式——归 engineVersion 语义）。
 * - gemdoc：selection / 撤销栈（undoStack/redoStack）/ manualCounter（加载时从 gems 派生
 *   max(m-编号)+1，design §1.2）/ 运行态加载错误。
 */

import {
  SHAPE_IDS,
  SS_KEYS,
  SS_TABLE,
  STRATEGY_IDS,
  roundSpecKeyOfSs,
  ssOfRoundSpecKey,
  type Block,
  type BlockType,
  type EditGem,
  type EngineImage,
  type GridSpec,
  type Palette,
  type PhysicalCanvas,
  type ShapeId,
  type SSKey,
  type StrategyId,
} from '$lib/engine'
import { ENGINE_VERSION } from '$lib/engine/version'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import type { EditLayerKey, LayerState } from '$lib/stores/edit.svelte'

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

export type ProjectFileKind = 'gemproj' | 'gemdoc'

/**
 * 各格式当前支持的 formatVersion（迁移链终点；bump 必附 round-trip 字节等价测试）。
 * v2（gem-catalog W0 0.3，design §1.3）：gemproj 化入 layers[]（恰一 rest 层）+ physicalCanvas?；
 * gemdoc gems 补规格物化字段 + grid v2（+gapMm）+ physicalCanvas?。
 */
export const PROJECTFILE_FORMAT_VERSIONS = {
  gemproj: 2,
  gemdoc: 2,
} as const

// ---------------------------------------------------------------------------
// typed error 家族（契约性异常：parse/serialize/编解码助手三方共用）
// ---------------------------------------------------------------------------

/** projectFile 层错误基类（instanceof 分发用）。 */
export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFileError'
  }
}

/** 版本门：formatVersion 高于本应用支持（向前拒读），或低于且迁移链有断环。 */
export class ProjectFileVersionError extends ProjectFileError {
  constructor(
    public readonly kind: ProjectFileKind,
    public readonly foundVersion: number,
    public readonly supportedVersion: number,
    detail?: string,
  ) {
    super(
      detail ??
        `文件来自更新版本的应用，请升级后再打开（${kind} v${foundVersion} > 本应用支持的 v${supportedVersion}）。`,
    )
    this.name = 'ProjectFileVersionError'
  }
}

/** kind/MIME 交叉校验失败（design §2：projectKind × mime × 文件内 kind 三者对齐）。 */
export class ProjectFileKindError extends ProjectFileError {
  constructor(
    public readonly field: 'kind' | 'mime',
    public readonly expected: string,
    public readonly found: string,
  ) {
    super(`文件 ${field} 不符：期望 ${expected}，实际为 ${found}。`)
    this.name = 'ProjectFileKindError'
  }
}

/** 脏输入：缺字段/类型错/值域外，带点分字段路径（根文档为 ''）。found 只含类型描述，不泄露字段值。 */
export class ProjectFileFieldError extends ProjectFileError {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly found: string,
    note?: string,
  ) {
    super(
      `文件字段不合法：${path || '<文档根>'} 应为 ${expected}，实际为 ${found}${note ? `（${note}）` : ''}。`,
    )
    this.name = 'ProjectFileFieldError'
  }
}

// ---------------------------------------------------------------------------
// 迁移链骨架（§1.3：( (from,to) => migrate ) 注册表，逐版本串行；v1 空链）
// ---------------------------------------------------------------------------

/** 单步迁移：输入旧版本已通过版本门的原文档，输出升一版的文档（纯函数，不 IO）。 */
export type ProjectFileMigrate = (data: Record<string, unknown>) => Record<string, unknown>

const projectFileMigrations = new Map<string, ProjectFileMigrate>()

/** 注册单步迁移（bump formatVersion 时配套注册 from→from+1；当前 v1 无迁移）。 */
export function registerProjectFileMigration(
  kind: ProjectFileKind,
  from: number,
  to: number,
  migrate: ProjectFileMigrate,
): void {
  projectFileMigrations.set(`${kind}:${from}->${to}`, migrate)
}

/** 从 from 逐版本串行迁移到当前支持版本；断环 = 版本错误（不猜测解析）。 */
function runProjectFileMigrations(
  kind: ProjectFileKind,
  from: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const supported = PROJECTFILE_FORMAT_VERSIONS[kind]
  let current = data
  for (let version = from; version < supported; version += 1) {
    const migrate = projectFileMigrations.get(`${kind}:${version}->${version + 1}`)
    if (!migrate) {
      throw new ProjectFileVersionError(
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
// Schema §1.1（.gemproj 参数工程；键序 = 声明序 = 序列化序，round-trip 字节等价的前提）
// ---------------------------------------------------------------------------

/**
 * 来源双形态（design §1.1 判别联合）：
 * - asset：库内引用（会话/库内保存的常态形态，无图字节）；
 * - embedded：导出磁盘时烘焙的内嵌原图字节（原始图字节，非降采样像素；dataUrl 只存在文件字节）。
 * width/height/downscale 两形态同语义 = studio 会话工作像（降采样后尺寸与系数，
 * 与 StudioImage 口径一致）；embedded 的 dataUrl/mime 描述原始字节本身。
 */
export type GemprojSource =
  | {
      kind: 'asset'
      assetId: string
      name: string
      width: number
      height: number
      downscale: number
    }
  | {
      kind: 'embedded'
      name: string
      mime: string
      dataUrl: string
      width: number
      height: number
      downscale: number
    }

/** gemproj reference 弱引用（参考原图，missing 容忍由解析器四态处理，本层只存）。 */
export interface GemprojReference {
  assetId: string
  name: string
}

/**
 * 格式 1：参数工程 v2（重放态——全部参数 + 来源引用；打开 = 自动重放）。
 * v2（gem-catalog W0 0.3，design §1.3 / 图层稿 §E.1 合流）：顶层 `physics`/`activeStrategy`/
 * `overrides` 退役 → `layers: LayerRecord[]`（≥1，恰一层 blockIds:'rest'；每层 physics 引用
 * canonical specKey——快照策略定稿：层配置只存 specKey，输出/编辑钻物化 GemSpecSnapshot，
 * 不设内联快照缓存键）；顶层新增 `physicalCanvas?`。
 * 「永不入文件」在类型层即不存在：五策略 results / previewMode / overlayOpacity / selectedBlockId。
 */

/** 层内覆写四表（键 = 引擎块 id、仅本层块；块存在性不在打开时校验——分块后 pruneStaleOverrides 归 replay gate）。 */
export interface LayerOverrides {
  disabled: Record<string, true>
  density: Record<string, number>
  type: Record<string, BlockType>
  color: Record<string, string>
}

/** v2 层物理：per-layer canonical specKey + gap（pairwise 判据单一来源经 GridSpec/grid 消费）。 */
export interface LayerPhysics {
  /** canonical 规格键（'round-ss10' / 'square-3.5' / 'custom-<assetId>'） */
  specKey: string
  gapMm: number
  density: number
  relax: { boundary: boolean; repulsion: boolean }
}

/**
 * v2 层记录（LayerRecord 类型冻结——W0 0.3；'rest' 哨兵不变量与 parser 拒绝面以图层稿 §E.1
 * 为规范性来源；层模型的 store/reducer/UI 实现归 studio-layers）。
 * 恰一层 `blockIds:'rest'`（零/多 rest = parser 拒收）；显式层 blockIds 层内去重（重复 = 拒收）、
 * 跨层不重复（重复 = 拒收）；未知块 id 不在打开时拒收（分块后 prune + 计数提示，诊断可见不静默）。
 */
export interface LayerRecord {
  id: string
  name: string
  /** 'rest' = 兜底层（恰一层；迁移无需重跑分块——块归属交给打开后的重放解析）；显式层 = 块 id 数组 */
  blockIds: readonly string[] | 'rest'
  strategy: StrategyId
  physics: LayerPhysics
  overrides: LayerOverrides
}

/** gemproj v2 核心字段（序列化面）。 */
export interface GemprojFileV2Core {
  kind: 'gemproj'
  formatVersion: 2
  appVersion: string
  /** 引擎语义身份（保存时 ENGINE_VERSION；打开时比对不等 → 漂移横幅 + 覆写存活清点）。 */
  engineVersion: number
  createdAt: number
  savedAt: number
  name: string
  source: GemprojSource
  reference?: GemprojReference
  segment: {
    /** 量化色数 6..10（studio setSegK 同界） */
    k: number
    seed: number
  }
  /** ≥1；恰一层 blockIds='rest' */
  layers: LayerRecord[]
  palette: Palette
  /** 画幅级物理锚（缺席 = default 2.5，anchorSource 显式——运行时接线归 replay/handoff gate） */
  physicalCanvas?: PhysicalCanvas
}

/**
 * parse 产物 = v2 core + v1 兼容读面（deprecated，derived）：
 * 由 rest 层派生 {physics/activeStrategy/overrides} 供未迁移消费者（gemprojReplay.ts——engine/
 * replay gate 迁移后删除本读面）。派生仅覆盖 v1 参数空间（圆钻 SS 档 specKey）；非圆钻 specKey
 * 的派生以 typed error 拒绝（不静默猜 SS 档）。
 */
export interface GemprojFile extends GemprojFileV2Core {
  /** @deprecated v1 读面（derived：rest 层 physics；specKey round-ssXX → SS_TABLE 查表反查） */
  physics: { ss: SSKey; gapMm: number; globalDensity: number; relax: { boundary: boolean; repulsion: boolean } }
  /** @deprecated v1 读面（derived：rest 层 strategy） */
  activeStrategy: StrategyId
  /** @deprecated v1 读面（derived：rest 层 overrides 四表副本） */
  overrides: LayerOverrides
}

/** serializeGemproj 输入：v2 core 字段减去 kind/formatVersion/engineVersion（由序列化层固定写当前值）。 */
export type GemprojFileInput = Omit<GemprojFileV2Core, 'kind' | 'formatVersion' | 'engineVersion'>

// ---------------------------------------------------------------------------
// Schema §1.2（.gemdoc 烘焙文档）
// ---------------------------------------------------------------------------

/** Block 的可 JSON 化形态：唯一差异 = mask.bits → base64 字符串。 */
export interface SerializedBlock {
  id: string
  label: string
  mask: { w: number; h: number; bits: string }
  colorRgb: [number, number, number]
  areaPx: number
  bbox: { x: number; y: number; w: number; h: number }
  widthPx: { max: number; mean: number }
  suggested: BlockType
}

export type GemdocOrigin = 'studio-bake' | 'quick-layout' | 'blank'

/**
 * v2 钻位记录：EditGem + 规格物化字段（gem-catalog W0 0.3，design §1.3）。
 * shapeId/diameterMm 过渡期可选（1.4 Gem/EditGem 字段落地后转必填——v1 迁移补 round+查表直径；
 * W0→1.4 窗口内未迁移写面（edit store）产出的合法 v2 文件可缺席）。
 */
export interface GemdocGem extends EditGem {
  shapeId?: ShapeId
  /** 唯一物理依据（逐钻物化快照字段——不引目录 IO） */
  diameterMm?: number
  /** 异形朝向（0=默认朝上；圆钻恒缺省；非身份） */
  rotationDeg?: number
  /** shapeId='custom' 时 .gemshape 弱引用 */
  assetId?: string
}

/**
 * 格式 2：烘焙文档 v2（编辑成果定稿快照；gems 全量含 'm-' 手工钻前缀与 moved 语义）。
 * v2：gems 每项 + shapeId/diameterMm/rotationDeg?/assetId?；grid v2（+gapMm，ss 过渡可选）；
 * 顶层 + physicalCanvas?。
 * 「永不入文件」在类型层即不存在：selection / 撤销栈 / manualCounter（加载时从 gems 派生）。
 */
export interface GemdocFile {
  kind: 'gemdoc'
  formatVersion: 2
  appVersion: string
  /** 烘焙时的引擎语义身份（展示性溯源；gemdoc 不重放，漂移语义只属 gemproj）。 */
  engineVersion: number
  createdAt: number
  savedAt: number
  name: string
  width: number
  height: number
  grid: GridSpec
  palette: Palette
  gems: GemdocGem[]
  /** 只读参考（编辑器不改；mask base64 形态）。 */
  blocks: SerializedBlock[]
  /** 四层显隐/透明度 = 文档态（非瞬态）。 */
  layers: Record<EditLayerKey, LayerState>
  /** 内嵌数字油画底图（PNG dataUrl；序列化层透传不重编码）。 */
  painting: { mime: 'image/png'; dataUrl: string }
  /** 画幅级物理锚（缺席 = default 2.5——anchorSource 显式；schema 承载位 W0 冻结，接线归 replay gate） */
  physicalCanvas?: PhysicalCanvas
  /** 参考原图弱引用（missing 容忍，四态解析器既有）。 */
  reference?: GemprojReference
  /** 溯源（仅展示）。 */
  provenance: {
    origin: GemdocOrigin
    sourceSummary: string
    sourceAssetId?: string
    gemprojAssetId?: string
  }
}

/** serializeGemdoc 输入：blocks 收引擎 Block[]（掩码 base64 由本层转换），其余同文件形态。 */
export interface GemdocFileInput
  extends Omit<GemdocFile, 'kind' | 'formatVersion' | 'engineVersion' | 'blocks'> {
  blocks: Block[]
}

// ---------------------------------------------------------------------------
// 校验助手（点分路径 typed error；只描述类型不携带值，避免泄露 dataUrl）
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
    throw new ProjectFileFieldError(path, '对象', describeValue(value))
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ProjectFileFieldError(path, 'string', describeValue(value))
  return value
}

function expectNonEmptyString(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!text.trim()) throw new ProjectFileFieldError(path, '非空 string', describeValue(text))
  return text
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ProjectFileFieldError(path, 'boolean', describeValue(value))
  }
  return value
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectFileFieldError(path, '有限 number', describeValue(value))
  }
  return value
}

function expectPositiveNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path)
  if (number <= 0) throw new ProjectFileFieldError(path, '正数', describeValue(number))
  return number
}

function expectPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ProjectFileFieldError(path, '正整数', describeValue(value))
  }
  return value
}

function expectNonNegativeNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path)
  if (number < 0) throw new ProjectFileFieldError(path, '非负数', describeValue(number))
  return number
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ProjectFileFieldError(path, '数组', describeValue(value))
  return value
}

function expectShapeId(value: unknown, path: string): ShapeId {
  if (typeof value !== 'string' || !SHAPE_IDS.includes(value as ShapeId)) {
    throw new ProjectFileFieldError(path, `形 id（${SHAPE_IDS.join('/')}）`, describeValue(value))
  }
  return value as ShapeId
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProjectFileFieldError(path, '非负整数', describeValue(value))
  }
  return value
}

/** 值域 (0,1]（密度/不透明度/降采样系数——store 滑杆口径上限 1，下界开区间）。 */
function expectUnitNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path)
  if (number <= 0 || number > 1) {
    throw new ProjectFileFieldError(path, '(0,1] 内的数', describeValue(number))
  }
  return number
}

/** 值域 [min,max] 闭区间整数（segment.k 6..10 同 studio setSegK 界）。 */
function expectBoundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ProjectFileFieldError(path, `[${min},${max}] 内的整数`, describeValue(value))
  }
  return value
}

/** 值域 [min,max] 闭区间数（gapMm 0.4..0.8 同 studio setGapMm 界）。 */
function expectBoundedNumber(value: unknown, path: string, min: number, max: number): number {
  const number = expectFiniteNumber(value, path)
  if (number < min || number > max) {
    throw new ProjectFileFieldError(path, `[${min},${max}] 内的数`, describeValue(number))
  }
  return number
}

function expectSsKey(value: unknown, path: string): SSKey {
  if (typeof value !== 'string' || !SS_KEYS.includes(value as SSKey)) {
    throw new ProjectFileFieldError(path, 'SS 尺寸键（SS6..SS34）', describeValue(value))
  }
  return value as SSKey
}

function expectStrategyId(value: unknown, path: string): StrategyId {
  if (typeof value !== 'string' || !STRATEGY_IDS.includes(value as StrategyId)) {
    throw new ProjectFileFieldError(path, '策略 id（hex-thin/hex-pitch/poisson/hybrid/cvt）', describeValue(value))
  }
  return value as StrategyId
}

const BLOCK_TYPES: readonly string[] = ['fill', 'linear', 'element']

function expectBlockType(value: unknown, path: string): BlockType {
  if (typeof value !== 'string' || !BLOCK_TYPES.includes(value)) {
    throw new ProjectFileFieldError(path, "'fill' | 'linear' | 'element'", describeValue(value))
  }
  return value as BlockType
}

const GEMDOC_ORIGINS: readonly string[] = ['studio-bake', 'quick-layout', 'blank']

function expectGemdocOrigin(value: unknown, path: string): GemdocOrigin {
  if (typeof value !== 'string' || !GEMDOC_ORIGINS.includes(value)) {
    throw new ProjectFileFieldError(path, "'studio-bake' | 'quick-layout' | 'blank'", describeValue(value))
  }
  return value as GemdocOrigin
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

function expectPalette(value: unknown, path: string): Palette {
  if (!Array.isArray(value)) {
    throw new ProjectFileFieldError(path, '色板数组', describeValue(value))
  }
  return value.map((entry, index) => {
    const record = expectRecord(entry, `${path}.${index}`)
    const hex = expectString(record.hex, `${path}.${index}.hex`)
    if (!HEX_COLOR_RE.test(hex)) {
      throw new ProjectFileFieldError(`${path}.${index}.hex`, '#RRGGBB 六位十六进制', describeValue(hex))
    }
    return {
      id: expectNonEmptyString(record.id, `${path}.${index}.id`),
      name: expectString(record.name, `${path}.${index}.name`),
      hex,
    }
  })
}

/** 参考弱引用：校验 + 重建（键序确定）；undefined 原样返回（可选键缺席不落键）。 */
function parseReference(value: unknown, path: string): GemprojReference | undefined {
  if (value === undefined) return undefined
  const record = expectRecord(value, path)
  return {
    assetId: expectNonEmptyString(record.assetId, `${path}.assetId`),
    name: expectString(record.name, `${path}.name`),
  }
}

/**
 * 来源双形态：校验 + 重建（键序确定；serialize/parse 双侧共用——serialize 侧同口径防御，
 * 杜绝运行时脏值产出非法字节）。embedded 的 dataUrl 为非空 base64 data URL 且头部 mime
 * 与 source.mime 一致（原始图字节载体，mime 不限 PNG——来源图可为 jpeg/webp）。
 */
const BASE64_DATAURL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/

function parseGemprojSource(value: unknown, path: string): GemprojSource {
  const record = expectRecord(value, path)
  if (record.kind === 'asset') {
    return {
      kind: 'asset',
      assetId: expectNonEmptyString(record.assetId, `${path}.assetId`),
      name: expectString(record.name, `${path}.name`),
      width: expectPositiveInteger(record.width, `${path}.width`),
      height: expectPositiveInteger(record.height, `${path}.height`),
      downscale: expectUnitNumber(record.downscale, `${path}.downscale`),
    }
  }
  if (record.kind === 'embedded') {
    const mime = expectNonEmptyString(record.mime, `${path}.mime`)
    return {
      kind: 'embedded',
      name: expectString(record.name, `${path}.name`),
      mime,
      dataUrl: expectBase64DataUrl(record.dataUrl, `${path}.dataUrl`, mime),
      width: expectPositiveInteger(record.width, `${path}.width`),
      height: expectPositiveInteger(record.height, `${path}.height`),
      downscale: expectUnitNumber(record.downscale, `${path}.downscale`),
    }
  }
  throw new ProjectFileFieldError(`${path}.kind`, "'asset' | 'embedded'", describeValue(record.kind))
}

function expectBase64DataUrl(value: unknown, path: string, expectedMime: string): string {
  const dataUrl = expectString(value, path)
  const match = BASE64_DATAURL_RE.exec(dataUrl)
  if (!match || match[2].length === 0) {
    throw new ProjectFileFieldError(
      path,
      '非空 base64 data URL（data:<mime>;base64,<载荷>）',
      describeValue(dataUrl),
    )
  }
  if (match[1] !== expectedMime) {
    throw new ProjectFileFieldError(
      path,
      `头部 mime 与声明 mime（${expectedMime}）一致的 data URL`,
      `mime ${match[1]}`,
    )
  }
  return dataUrl
}

// ---------------------------------------------------------------------------
// Record 覆写表（键 = 引擎块 id，非空；按遭遇序重建——往返字节等价）
// ---------------------------------------------------------------------------

function recordEntries(value: unknown, path: string): Array<[string, unknown]> {
  const record = expectRecord(value, path)
  const entries: Array<[string, unknown]> = []
  for (const [key, entry] of Object.entries(record)) {
    if (!key.trim()) {
      throw new ProjectFileFieldError(path, '以非空块 id 为键的表', `空键（共 ${Object.keys(record).length} 键）`)
    }
    entries.push([key, entry])
  }
  return entries
}

function parseTrueRecord(value: unknown, path: string): Record<string, true> {
  const out: Record<string, true> = {}
  for (const [key, entry] of recordEntries(value, path)) {
    if (entry !== true) throw new ProjectFileFieldError(`${path}.${key}`, 'true', describeValue(entry))
    out[key] = true
  }
  return out
}

function parseDensityRecord(value: unknown, path: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, entry] of recordEntries(value, path)) {
    out[key] = expectUnitNumber(entry, `${path}.${key}`)
  }
  return out
}

function parseBlockTypeRecord(value: unknown, path: string): Record<string, BlockType> {
  const out: Record<string, BlockType> = {}
  for (const [key, entry] of recordEntries(value, path)) {
    out[key] = expectBlockType(entry, `${path}.${key}`)
  }
  return out
}

function parseStringRecord(value: unknown, path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, entry] of recordEntries(value, path)) {
    out[key] = expectNonEmptyString(entry, `${path}.${key}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// mask bits ↔ base64（Uint8Array 助手；serialize/parse 与编辑页接缝共用）
// ---------------------------------------------------------------------------

/** Uint8Array → base64（分块拼串防大掩码栈溢出；掩码值域 0|1，标准 base64 确定性编码）。 */
export function maskBitsToBase64(bits: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bits.length; i += CHUNK) {
    binary += String.fromCharCode(...bits.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** base64 → Uint8Array；非法字符/坏载荷 → 点分路径 typed error（只描述不携带值）。 */
export function maskBitsFromBase64(value: unknown, path: string): Uint8Array {
  const text = expectString(value, path)
  if (text.length === 0) {
    throw new ProjectFileFieldError(path, '非空 base64 字符串', describeValue(text))
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new ProjectFileFieldError(path, '合法 base64 字符集（A-Z a-z 0-9 + / =）', describeValue(text))
  }
  let binary: string
  try {
    binary = atob(text)
  } catch (error) {
    throw new ProjectFileFieldError(path, '合法 base64 载荷', '解码失败', error instanceof Error ? error.message : String(error))
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 引擎 Block → 可 JSON 化 SerializedBlock（serialize 与编辑页接缝共用；值域全量校验）。 */
export function toSerializedBlock(block: Block, path: string): SerializedBlock {
  const mask = block.mask
  if (!(mask.w > 0 && mask.h > 0) || mask.bits.length !== mask.w * mask.h) {
    throw new ProjectFileFieldError(`${path}.mask`, `w×h=${mask.w}×${mask.h} 的位面`, `bits 长度 ${mask.bits.length}`)
  }
  for (let i = 0; i < mask.bits.length; i += 1) {
    if (mask.bits[i] !== 0 && mask.bits[i] !== 1) {
      throw new ProjectFileFieldError(`${path}.mask.bits`, '0|1 位值', `值 ${mask.bits[i]}（下标 ${i}）`)
    }
  }
  const suggested = expectBlockType(block.suggested, `${path}.suggested`)
  const bbox = block.bbox
  const widthPx = block.widthPx
  return {
    id: expectNonEmptyString(block.id, `${path}.id`),
    label: expectString(block.label, `${path}.label`),
    mask: { w: mask.w, h: mask.h, bits: maskBitsToBase64(mask.bits) },
    colorRgb: [
      expectChannel(block.colorRgb?.[0], `${path}.colorRgb.0`),
      expectChannel(block.colorRgb?.[1], `${path}.colorRgb.1`),
      expectChannel(block.colorRgb?.[2], `${path}.colorRgb.2`),
    ],
    areaPx: expectPositiveInteger(block.areaPx, `${path}.areaPx`),
    bbox: {
      x: expectNonNegativeInteger(bbox?.x, `${path}.bbox.x`),
      y: expectNonNegativeInteger(bbox?.y, `${path}.bbox.y`),
      w: expectPositiveInteger(bbox?.w, `${path}.bbox.w`),
      h: expectPositiveInteger(bbox?.h, `${path}.bbox.h`),
    },
    widthPx: {
      max: expectPositiveNumber(widthPx?.max, `${path}.widthPx.max`),
      mean: expectPositiveNumber(widthPx?.mean, `${path}.widthPx.mean`),
    },
    suggested,
  }
}

function expectChannel(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new ProjectFileFieldError(path, '0..255 整数', describeValue(value))
  }
  return value
}

/** SerializedBlock（已过 parse 校验）→ 引擎 Block（bits base64 解码回 Uint8Array；编辑页接缝）。 */
export function fromSerializedBlock(block: SerializedBlock): Block {
  return {
    id: block.id,
    label: block.label,
    mask: { w: block.mask.w, h: block.mask.h, bits: maskBitsFromBase64(block.mask.bits, 'blocks.mask.bits') },
    colorRgb: [...block.colorRgb] as [number, number, number],
    areaPx: block.areaPx,
    bbox: { ...block.bbox },
    widthPx: { ...block.widthPx },
    suggested: block.suggested,
  }
}

/** SerializedBlock 读取侧校验 + 键序重建（parse 主路径）。 */
function parseSerializedBlock(value: unknown, path: string): SerializedBlock {
  const record = expectRecord(value, path)
  const mask = expectRecord(record.mask, `${path}.mask`)
  const w = expectPositiveInteger(mask.w, `${path}.mask.w`)
  const h = expectPositiveInteger(mask.h, `${path}.mask.h`)
  const bits = maskBitsFromBase64(mask.bits, `${path}.mask.bits`)
  if (bits.length !== w * h) {
    throw new ProjectFileFieldError(`${path}.mask.bits`, `${w}×${h}=${w * h} 字节的 base64 载荷`, `解码后 ${bits.length} 字节`)
  }
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] !== 0 && bits[i] !== 1) {
      throw new ProjectFileFieldError(`${path}.mask.bits`, '0|1 位值', `值 ${bits[i]}（第 ${i} 字节）`)
    }
  }
  const colorRgbRecord = record.colorRgb
  if (!Array.isArray(colorRgbRecord) || colorRgbRecord.length !== 3) {
    throw new ProjectFileFieldError(`${path}.colorRgb`, '3 元素数组 [r,g,b]', describeValue(colorRgbRecord))
  }
  const bbox = expectRecord(record.bbox, `${path}.bbox`)
  const widthPx = expectRecord(record.widthPx, `${path}.widthPx`)
  return {
    id: expectNonEmptyString(record.id, `${path}.id`),
    label: expectString(record.label, `${path}.label`),
    mask: { w, h, bits: maskBitsToBase64(bits) },
    colorRgb: [
      expectChannel(colorRgbRecord[0], `${path}.colorRgb.0`),
      expectChannel(colorRgbRecord[1], `${path}.colorRgb.1`),
      expectChannel(colorRgbRecord[2], `${path}.colorRgb.2`),
    ],
    areaPx: expectPositiveInteger(record.areaPx, `${path}.areaPx`),
    bbox: {
      x: expectNonNegativeInteger(bbox.x, `${path}.bbox.x`),
      y: expectNonNegativeInteger(bbox.y, `${path}.bbox.y`),
      w: expectPositiveInteger(bbox.w, `${path}.bbox.w`),
      h: expectPositiveInteger(bbox.h, `${path}.bbox.h`),
    },
    widthPx: {
      max: expectPositiveNumber(widthPx.max, `${path}.widthPx.max`),
      mean: expectPositiveNumber(widthPx.mean, `${path}.widthPx.mean`),
    },
    suggested: expectBlockType(record.suggested, `${path}.suggested`),
  }
}

// ---------------------------------------------------------------------------
// grid / physicalCanvas / gemdoc layers / gems（v2 子结构）
// ---------------------------------------------------------------------------

/**
 * grid v2（gem-catalog W0 0.3 入文件）：+gapMm（必填）；ss 为 v1 过渡读面（可选——GridSpec v2
 * canonical 不携带；v1 旧档经迁移补 gapMm，ss 保留）。键序 = 声明序（ss?, pitchMm, gapMm,
 * rowAngleDeg, pixelsPerMm——round-trip 字节等价的前提）。
 */
function parseGrid(value: unknown, path: string): GridSpec {
  const record = expectRecord(value, path)
  const rowAngleDeg = record.rowAngleDeg
  if (rowAngleDeg !== 0) {
    throw new ProjectFileFieldError(`${path}.rowAngleDeg`, '字面量 0（行向水平全局一致，实证裁决）', describeValue(rowAngleDeg))
  }
  const ss = record.ss === undefined ? undefined : expectSsKey(record.ss, `${path}.ss`)
  return {
    ...(ss !== undefined ? { ss } : {}),
    pitchMm: expectPositiveNumber(record.pitchMm, `${path}.pitchMm`),
    gapMm: expectNonNegativeNumber(record.gapMm, `${path}.gapMm`),
    rowAngleDeg: 0,
    pixelsPerMm: expectPositiveNumber(record.pixelsPerMm, `${path}.pixelsPerMm`),
  }
}

/** 画幅级物理锚（可选键：undefined 原样返回；anchorSource 两值显式）。 */
function parsePhysicalCanvas(value: unknown, path: string): PhysicalCanvas | undefined {
  if (value === undefined) return undefined
  const record = expectRecord(value, path)
  const anchorSource = record.anchorSource
  if (anchorSource !== 'declared' && anchorSource !== 'default') {
    throw new ProjectFileFieldError(`${path}.anchorSource`, "'declared' | 'default'", describeValue(anchorSource))
  }
  return {
    widthMm: expectPositiveNumber(record.widthMm, `${path}.widthMm`),
    heightMm: expectPositiveNumber(record.heightMm, `${path}.heightMm`),
    anchorSource,
  }
}

const EDIT_LAYER_KEYS: readonly EditLayerKey[] = ['painting', 'reference', 'blocks', 'gems']

/** gemdoc 四层显隐（编辑层——与 gemproj layers[] 的 LayerRecord 无关，勿混）。 */
function parseLayers(value: unknown, path: string): Record<EditLayerKey, LayerState> {
  const record = expectRecord(value, path)
  const out = {} as Record<EditLayerKey, LayerState>
  for (const key of EDIT_LAYER_KEYS) {
    const layer = expectRecord(record[key], `${path}.${key}`)
    out[key] = {
      visible: expectBoolean(layer.visible, `${path}.${key}.visible`),
      opacity: expectUnitNumber(layer.opacity, `${path}.${key}.opacity`),
    }
  }
  return out
}

/** specKey 形态：非空、无空白（canonical 生成规则见 engine/spec.ts；此处只把关可存储性）。 */
function expectSpecKey(value: unknown, path: string): string {
  const specKey = expectNonEmptyString(value, path)
  if (/\s/.test(specKey)) {
    throw new ProjectFileFieldError(path, '不含空白的 specKey（canonical 键）', describeValue(specKey))
  }
  return specKey
}

/** LayerOverrides 四表（键 = 引擎块 id，按遭遇序重建——往返字节等价）。 */
function parseLayerOverrides(value: unknown, path: string): LayerOverrides {
  const record = expectRecord(value, path)
  return {
    disabled: parseTrueRecord(record.disabled, `${path}.disabled`),
    density: parseDensityRecord(record.density, `${path}.density`),
    type: parseBlockTypeRecord(record.type, `${path}.type`),
    color: parseStringRecord(record.color, `${path}.color`),
  }
}

/**
 * gemproj v2 layers[]：校验 + 键序重建 + 分区不变量拒绝面（图层稿 §E.1）——
 * 恰一 'rest'（零/多 = 拒收）；显式层 blockIds 层内去重（重复 = 拒收）；跨层重复块 = 拒收；
 * 未知块 id 不拒收（分块后 prune + 计数，replay gate 接线）。
 */
function parseLayerRecords(value: unknown, path: string): LayerRecord[] {
  const rawLayers = expectArray(value, path)
  if (rawLayers.length === 0) {
    throw new ProjectFileFieldError(path, '至少一层的层记录数组（恰一层 blockIds="rest"）', '空数组')
  }
  const seenBlockIds = new Set<string>()
  const out: LayerRecord[] = []
  let restCount = 0
  rawLayers.forEach((raw, index) => {
    const layerPath = `${path}.${index}`
    const record = expectRecord(raw, layerPath)
    const physics = expectRecord(record.physics, `${layerPath}.physics`)
    const relax = expectRecord(physics.relax, `${layerPath}.physics.relax`)
    let blockIds: readonly string[] | 'rest'
    if (record.blockIds === 'rest') {
      blockIds = 'rest'
      restCount += 1
    } else {
      const ids = expectArray(record.blockIds, `${layerPath}.blockIds`)
      if (ids.length === 0) {
        throw new ProjectFileFieldError(`${layerPath}.blockIds`, '非空块 id 数组或 "rest"', '空数组')
      }
      blockIds = ids.map((id, idIndex) => {
        const blockId = expectNonEmptyString(id, `${layerPath}.blockIds.${idIndex}`)
        if (seenBlockIds.has(blockId)) {
          throw new ProjectFileFieldError(
            `${layerPath}.blockIds.${idIndex}`,
            '层内/跨层不重复的块 id',
            `重复块 id ${blockId}`,
          )
        }
        seenBlockIds.add(blockId)
        return blockId
      })
    }
    out.push({
      id: expectNonEmptyString(record.id, `${layerPath}.id`),
      name: expectString(record.name, `${layerPath}.name`),
      blockIds,
      strategy: expectStrategyId(record.strategy, `${layerPath}.strategy`),
      physics: {
        specKey: expectSpecKey(physics.specKey, `${layerPath}.physics.specKey`),
        gapMm: expectBoundedNumber(physics.gapMm, `${layerPath}.physics.gapMm`, 0.4, 0.8),
        density: expectUnitNumber(physics.density, `${layerPath}.physics.density`),
        relax: {
          boundary: expectBoolean(relax.boundary, `${layerPath}.physics.relax.boundary`),
          repulsion: expectBoolean(relax.repulsion, `${layerPath}.physics.relax.repulsion`),
        },
      },
      overrides: parseLayerOverrides(record.overrides, `${layerPath}.overrides`),
    })
  })
  if (restCount !== 1) {
    throw new ProjectFileFieldError(
      path,
      '恰一层 blockIds="rest" 的层记录数组（分区不变量）',
      `${restCount} 个 rest 层`,
    )
  }
  return out
}

/**
 * v1 兼容读面（deprecated）：由 rest 层派生顶层 physics/activeStrategy/overrides——
 * 未迁移消费者（gemprojReplay.ts）专用，engine/replay gate 迁移后连同字段删除。
 * ss 仅从圆钻 SS 档 specKey（round-ssXX）反查（SS_TABLE bootstrap）；非圆钻 specKey 的
 * 旧读面派生以 typed error 拒绝——不静默猜 SS 档（replay gate 迁移后解除本限制）。
 */
function deriveLegacyGemprojView(layers: readonly LayerRecord[]): Pick<GemprojFile, 'physics' | 'activeStrategy' | 'overrides'> {
  const restIndex = layers.findIndex((layer) => layer.blockIds === 'rest')
  const rest = layers[restIndex]
  const ss = ssOfRoundSpecKey(rest.physics.specKey)
  if (ss === null) {
    throw new ProjectFileFieldError(
      `layers.${restIndex}.physics.specKey`,
      'round-ssXX 圆钻规格键（v1 重放读面派生仅覆盖 v1 参数空间；非圆钻 v2 工程的重放迁移归 replay gate）',
      `非圆钻规格键 ${rest.physics.specKey}`,
    )
  }
  return {
    physics: {
      ss,
      gapMm: rest.physics.gapMm,
      globalDensity: rest.physics.density,
      relax: { ...rest.physics.relax },
    },
    activeStrategy: rest.strategy,
    overrides: {
      disabled: { ...rest.overrides.disabled },
      density: { ...rest.overrides.density },
      type: { ...rest.overrides.type },
      color: { ...rest.overrides.color },
    },
  }
}

/**
 * gemdoc v2 钻位：EditGem 校验 + 规格物化字段（可选——过渡期；1.4 转必填）+ 键序重建
 * （'m-' 手工钻前缀与 id 一并透传；可选规格键缺席不落键）。
 */
function parseGemdocGem(value: unknown, path: string): GemdocGem {
  const record = expectRecord(value, path)
  const origin = record.origin
  if (origin !== 'layout' && origin !== 'manual') {
    throw new ProjectFileFieldError(`${path}.origin`, "'layout' | 'manual'", describeValue(origin))
  }
  const blockId = record.blockId
  if (blockId !== null && typeof blockId !== 'string') {
    throw new ProjectFileFieldError(`${path}.blockId`, 'string | null（手工钻为 null）', describeValue(blockId))
  }
  const shapeId = record.shapeId === undefined ? undefined : expectShapeId(record.shapeId, `${path}.shapeId`)
  const diameterMm = record.diameterMm === undefined ? undefined : expectPositiveNumber(record.diameterMm, `${path}.diameterMm`)
  const rotationDegRaw = record.rotationDeg
  let rotationDeg: number | undefined
  if (rotationDegRaw !== undefined) {
    rotationDeg = expectFiniteNumber(rotationDegRaw, `${path}.rotationDeg`)
    if (rotationDeg < 0 || rotationDeg >= 360) {
      throw new ProjectFileFieldError(`${path}.rotationDeg`, '[0,360) 的数', describeValue(rotationDeg))
    }
  }
  const assetId = record.assetId === undefined ? undefined : expectNonEmptyString(record.assetId, `${path}.assetId`)
  return {
    id: expectNonEmptyString(record.id, `${path}.id`),
    x: expectFiniteNumber(record.x, `${path}.x`),
    y: expectFiniteNumber(record.y, `${path}.y`),
    colorId: expectString(record.colorId, `${path}.colorId`),
    blockId,
    origin,
    moved: expectBoolean(record.moved, `${path}.moved`),
    ...(shapeId !== undefined ? { shapeId } : {}),
    ...(diameterMm !== undefined ? { diameterMm } : {}),
    ...(rotationDeg !== undefined ? { rotationDeg } : {}),
    ...(assetId !== undefined ? { assetId } : {}),
  }
}

// ---------------------------------------------------------------------------
// 信封读取：MIME 门 → JSON → kind 门 → 版本门（→ 迁移链）——版本错误先于字段校验
// ---------------------------------------------------------------------------

/** parse 可选交叉校验：容器/节点声明的 MIME（导入路径用，design §2 三者对齐）。 */
export interface ProjectFileParseOptions {
  mime?: string
}

function readEnvelope(
  text: string,
  kind: ProjectFileKind,
  options?: ProjectFileParseOptions,
): Record<string, unknown> {
  if (options?.mime !== undefined && options.mime !== PROJECT_MIME[kind]) {
    throw new ProjectFileKindError('mime', PROJECT_MIME[kind], options.mime)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ProjectFileFieldError('', '合法 JSON 文档', '无法解析', error instanceof Error ? error.message : String(error))
  }
  const envelope = expectRecord(parsed, '')
  const foundKind = envelope.kind
  if (typeof foundKind !== 'string') {
    throw new ProjectFileFieldError('kind', "'gemproj' | 'gemdoc'", describeValue(foundKind))
  }
  if (foundKind !== kind) {
    throw new ProjectFileKindError('kind', kind, foundKind)
  }
  const supported = PROJECTFILE_FORMAT_VERSIONS[kind]
  const version = envelope.formatVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new ProjectFileFieldError('formatVersion', '整数', describeValue(version))
  }
  if (version > supported) throw new ProjectFileVersionError(kind, version, supported)
  if (version < supported) return runProjectFileMigrations(kind, version, envelope)
  return envelope
}

// ---------------------------------------------------------------------------
// gemproj serialize / parse
// ---------------------------------------------------------------------------

/** 序列化参数工程 v2：声明序构造（layers 声明序：id/name/blockIds/strategy/physics/overrides）+ 双侧同口径校验；engineVersion 固定写当前 ENGINE_VERSION。 */
export function serializeGemproj(input: GemprojFileInput): string {
  const reference = parseReference(input.reference, 'reference')
  const segmentRecord = expectRecord(input.segment, 'segment')
  const physicalCanvas = parsePhysicalCanvas(input.physicalCanvas, 'physicalCanvas')
  return JSON.stringify({
    kind: 'gemproj',
    formatVersion: PROJECTFILE_FORMAT_VERSIONS.gemproj,
    appVersion: expectNonEmptyString(input.appVersion, 'appVersion'),
    engineVersion: ENGINE_VERSION,
    createdAt: expectFiniteNumber(input.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(input.savedAt, 'savedAt'),
    name: expectString(input.name, 'name'),
    source: parseGemprojSource(input.source, 'source'),
    ...(reference !== undefined ? { reference } : {}),
    segment: {
      k: expectBoundedInteger(segmentRecord.k, 'segment.k', 6, 10),
      seed: expectNonNegativeInteger(segmentRecord.seed, 'segment.seed'),
    },
    layers: parseLayerRecords(input.layers, 'layers'),
    ...(physicalCanvas !== undefined ? { physicalCanvas } : {}),
    palette: expectPalette(input.palette, 'palette'),
  })
}

/** 解析参数工程 v2：版本门 → 迁移链（v1 补单 rest 层）→ 逐字段校验/归一 + v1 兼容读面派生。 */
export function parseGemproj(text: string, options?: ProjectFileParseOptions): GemprojFile {
  const envelope = readEnvelope(text, 'gemproj', options)
  const reference = parseReference(envelope.reference, 'reference')
  const segmentRecord = expectRecord(envelope.segment, 'segment')
  const layers = parseLayerRecords(envelope.layers, 'layers')
  const physicalCanvas = parsePhysicalCanvas(envelope.physicalCanvas, 'physicalCanvas')
  return {
    kind: 'gemproj',
    formatVersion: PROJECTFILE_FORMAT_VERSIONS.gemproj,
    appVersion: expectNonEmptyString(envelope.appVersion, 'appVersion'),
    engineVersion: expectNonNegativeInteger(envelope.engineVersion, 'engineVersion'),
    createdAt: expectFiniteNumber(envelope.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(envelope.savedAt, 'savedAt'),
    name: expectString(envelope.name, 'name'),
    source: parseGemprojSource(envelope.source, 'source'),
    ...(reference !== undefined ? { reference } : {}),
    segment: {
      k: expectBoundedInteger(segmentRecord.k, 'segment.k', 6, 10),
      seed: expectNonNegativeInteger(segmentRecord.seed, 'segment.seed'),
    },
    layers,
    ...(physicalCanvas !== undefined ? { physicalCanvas } : {}),
    palette: expectPalette(envelope.palette, 'palette'),
    ...deriveLegacyGemprojView(layers),
  }
}

// ---------------------------------------------------------------------------
// gemdoc serialize / parse
// ---------------------------------------------------------------------------

/** 序列化烘焙文档 v2：blocks 引擎形态 → base64 掩码；grid v2 五键（ss 过渡可选）；painting dataUrl 严格校验透传（不重编码）。 */
export function serializeGemdoc(input: GemdocFileInput): string {
  const reference = parseReference(input.reference, 'reference')
  const provenanceRecord = expectRecord(input.provenance, 'provenance')
  const physicalCanvas = parsePhysicalCanvas(input.physicalCanvas, 'physicalCanvas')
  const sourceAssetId =
    provenanceRecord.sourceAssetId === undefined
      ? undefined
      : expectNonEmptyString(provenanceRecord.sourceAssetId, 'provenance.sourceAssetId')
  const gemprojAssetId =
    provenanceRecord.gemprojAssetId === undefined
      ? undefined
      : expectNonEmptyString(provenanceRecord.gemprojAssetId, 'provenance.gemprojAssetId')
  return JSON.stringify({
    kind: 'gemdoc',
    formatVersion: PROJECTFILE_FORMAT_VERSIONS.gemdoc,
    appVersion: expectNonEmptyString(input.appVersion, 'appVersion'),
    engineVersion: ENGINE_VERSION,
    createdAt: expectFiniteNumber(input.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(input.savedAt, 'savedAt'),
    name: expectString(input.name, 'name'),
    width: expectPositiveInteger(input.width, 'width'),
    height: expectPositiveInteger(input.height, 'height'),
    grid: parseGrid(input.grid, 'grid'),
    palette: expectPalette(input.palette, 'palette'),
    gems: input.gems.map((gem, index) => parseGemdocGem(gem, `gems.${index}`)),
    blocks: input.blocks.map((block, index) => toSerializedBlock(block, `blocks.${index}`)),
    layers: parseLayers(input.layers, 'layers'),
    painting: {
      mime: 'image/png' as const,
      dataUrl: expectBase64DataUrl(input.painting?.dataUrl, 'painting.dataUrl', 'image/png'),
    },
    ...(physicalCanvas !== undefined ? { physicalCanvas } : {}),
    ...(reference !== undefined ? { reference } : {}),
    provenance: {
      origin: expectGemdocOrigin(provenanceRecord.origin, 'provenance.origin'),
      sourceSummary: expectString(provenanceRecord.sourceSummary, 'provenance.sourceSummary'),
      ...(sourceAssetId !== undefined ? { sourceAssetId } : {}),
      ...(gemprojAssetId !== undefined ? { gemprojAssetId } : {}),
    },
  })
}

/** 解析烘焙文档：blocks 留 base64 形态（SerializedBlock，编辑页经 fromSerializedBlock 还原引擎 Block）。 */
export function parseGemdoc(text: string, options?: ProjectFileParseOptions): GemdocFile {
  const envelope = readEnvelope(text, 'gemdoc', options)
  const reference = parseReference(envelope.reference, 'reference')
  const provenanceRecord = expectRecord(envelope.provenance, 'provenance')
  const sourceAssetId =
    provenanceRecord.sourceAssetId === undefined
      ? undefined
      : expectNonEmptyString(provenanceRecord.sourceAssetId, 'provenance.sourceAssetId')
  const gemprojAssetId =
    provenanceRecord.gemprojAssetId === undefined
      ? undefined
      : expectNonEmptyString(provenanceRecord.gemprojAssetId, 'provenance.gemprojAssetId')
  const painting = expectRecord(envelope.painting, 'painting')
  const physicalCanvas = parsePhysicalCanvas(envelope.physicalCanvas, 'physicalCanvas')
  const gemsRecord = envelope.gems
  if (!Array.isArray(gemsRecord)) {
    throw new ProjectFileFieldError('gems', '钻位数组', describeValue(gemsRecord))
  }
  const blocksRecord = envelope.blocks
  if (!Array.isArray(blocksRecord)) {
    throw new ProjectFileFieldError('blocks', '块数组', describeValue(blocksRecord))
  }
  return {
    kind: 'gemdoc',
    formatVersion: PROJECTFILE_FORMAT_VERSIONS.gemdoc,
    appVersion: expectNonEmptyString(envelope.appVersion, 'appVersion'),
    engineVersion: expectNonNegativeInteger(envelope.engineVersion, 'engineVersion'),
    createdAt: expectFiniteNumber(envelope.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(envelope.savedAt, 'savedAt'),
    name: expectString(envelope.name, 'name'),
    width: expectPositiveInteger(envelope.width, 'width'),
    height: expectPositiveInteger(envelope.height, 'height'),
    grid: parseGrid(envelope.grid, 'grid'),
    palette: expectPalette(envelope.palette, 'palette'),
    gems: gemsRecord.map((gem, index) => parseGemdocGem(gem, `gems.${index}`)),
    blocks: blocksRecord.map((block, index) => parseSerializedBlock(block, `blocks.${index}`)),
    layers: parseLayers(envelope.layers, 'layers'),
    painting: {
      mime: 'image/png' as const,
      dataUrl: expectBase64DataUrl(painting.dataUrl, 'painting.dataUrl', 'image/png'),
    },
    ...(physicalCanvas !== undefined ? { physicalCanvas } : {}),
    ...(reference !== undefined ? { reference } : {}),
    provenance: {
      origin: expectGemdocOrigin(provenanceRecord.origin, 'provenance.origin'),
      sourceSummary: expectString(provenanceRecord.sourceSummary, 'provenance.sourceSummary'),
      ...(sourceAssetId !== undefined ? { sourceAssetId } : {}),
      ...(gemprojAssetId !== undefined ? { gemprojAssetId } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// painting ↔ PNG dataUrl 编解码助手（§1.2；canvas 委托，浏览器运行时面）
// ---------------------------------------------------------------------------

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败（不支持的格式或损坏的文件）'))
    img.src = src
  })
}

/**
 * 像素面 → PNG dataUrl（烘焙路径：gemdoc painting 的唯一编码出口）。
 * 经 ctx.createImageData 构造（不依赖全局 ImageData 构造器可用性）；输出严格 PNG data URL。
 */
export function paintingToDataUrl(painting: EngineImage): string {
  const { width, height, data } = painting
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    data.length !== width * height * 4
  ) {
    throw new ProjectFileFieldError(
      'painting',
      `width×height×4 的像素平面（${width}×${height}）`,
      `data 长度 ${data.length}`,
    )
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new ProjectFileFieldError('painting', '可用的 Canvas 2D', '上下文创建失败（无法编码 PNG）')
  }
  const imageData = ctx.createImageData(width, height)
  imageData.data.set(data)
  ctx.putImageData(imageData, 0, 0)
  const dataUrl = canvas.toDataURL('image/png')
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(dataUrl) || dataUrl.length <= 22) {
    throw new ProjectFileFieldError('painting', 'PNG 编码产物（data:image/png;base64,…）', describeValue(dataUrl))
  }
  return dataUrl
}

/**
 * PNG dataUrl → 像素面（加载路径：gemdoc painting 的唯一解码出口）。
 * 按原始尺寸解码零重采样（文档分辨率即 paintingSnapshot 分辨率）；坏 dataUrl/解码失败 → typed error。
 */
export async function dataUrlToPainting(dataUrl: string): Promise<EngineImage> {
  expectBase64DataUrl(dataUrl, 'painting.dataUrl', 'image/png')
  let img: HTMLImageElement
  try {
    img = await loadImageElement(dataUrl)
  } catch (error) {
    throw new ProjectFileFieldError(
      'painting.dataUrl',
      '可解码的 PNG 图像',
      '解码失败',
      error instanceof Error ? error.message : String(error),
    )
  }
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new ProjectFileFieldError('painting.dataUrl', '携带有效尺寸的 PNG', `${width}×${height}`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new ProjectFileFieldError('painting.dataUrl', '可用的 Canvas 2D', '上下文创建失败（无法解码 PNG）')
  }
  ctx.drawImage(img, 0, 0, width, height)
  const out = ctx.getImageData(0, 0, width, height)
  if (out.width !== width || out.height !== height) {
    throw new ProjectFileFieldError('painting.dataUrl', `${width}×${height} 的解码面`, `${out.width}×${out.height}`)
  }
  return { width, height, data: new Uint8ClampedArray(out.data) }
}

// ---------------------------------------------------------------------------
// MIME 对齐（PROJECT_MIME 唯一真源的只读投影）
// ---------------------------------------------------------------------------

/** 各格式落库/导出应使用的 vendor MIME（消费 projectTypes 的 PROJECT_MIME，不重定义）。 */
export function projectFileMime(kind: ProjectFileKind): (typeof PROJECT_MIME)[ProjectFileKind] {
  return PROJECT_MIME[kind]
}

// ---------------------------------------------------------------------------
// v1→v2 迁移注册（gem-catalog W0 0.3，design §1.3——纯函数，无 IO；
// 完整迁移语义（gemproj overrides 块键搬运细目等）归切片 2.3，本入口覆盖核心映射）
// ---------------------------------------------------------------------------

/**
 * gemproj v1→v2：顶层 physics/activeStrategy/overrides 化入单一兜底层
 * `layers=[{id:'L1',name:'图层 1',blockIds:'rest',strategy,physics:{specKey:'round-<ss>',gapMm,
 * density:globalDensity,relax},overrides}]`（rest 哨兵：迁移无需重跑分块）；physicalCanvas 缺席 = default。
 */
registerProjectFileMigration('gemproj', 1, 2, (data) => {
  const physics = expectRecord(data.physics, 'physics')
  const relax = expectRecord(physics.relax, 'physics.relax')
  const ss = expectSsKey(physics.ss, 'physics.ss')
  const layer: LayerRecord = {
    id: 'L1',
    name: '图层 1',
    blockIds: 'rest',
    strategy: expectStrategyId(data.activeStrategy, 'activeStrategy'),
    physics: {
      specKey: roundSpecKeyOfSs(ss),
      gapMm: expectBoundedNumber(physics.gapMm, 'physics.gapMm', 0.4, 0.8),
      density: expectUnitNumber(physics.globalDensity, 'physics.globalDensity'),
      relax: {
        boundary: expectBoolean(relax.boundary, 'physics.relax.boundary'),
        repulsion: expectBoolean(relax.repulsion, 'physics.relax.repulsion'),
      },
    },
    overrides: parseLayerOverrides(data.overrides, 'overrides'),
  }
  const out = { ...data }
  delete out.physics
  delete out.activeStrategy
  delete out.overrides
  out.layers = [layer]
  out.formatVersion = 2
  return out
})

/**
 * gemdoc v1→v2：gems 每项补 `shapeId:'round' + diameterMm=SS_TABLE[grid.ss]`（v1 全圆钻）；
 * grid 补 `gapMm = pitchMm − SS_TABLE[ss]`（v1 构造式反推）；physicalCanvas 缺席。
 */
registerProjectFileMigration('gemdoc', 1, 2, (data) => {
  const grid = expectRecord(data.grid, 'grid')
  const ss = expectSsKey(grid.ss, 'grid.ss')
  const pitchMm = expectPositiveNumber(grid.pitchMm, 'grid.pitchMm')
  const gapMm = pitchMm - SS_TABLE[ss]
  if (gapMm < 0) {
    throw new ProjectFileFieldError(
      'grid.pitchMm',
      `大于 SS_TABLE 钻径（${ss} = ${SS_TABLE[ss]}mm）的间距`,
      `pitchMm ${pitchMm}（隐含 gap ${gapMm} 为负）`,
    )
  }
  const diameterMm = SS_TABLE[ss]
  const gems = expectArray(data.gems, 'gems').map((gem, index) => ({
    ...expectRecord(gem, `gems.${index}`),
    shapeId: 'round',
    diameterMm,
  }))
  return { ...data, grid: { ...grid, gapMm }, gems, formatVersion: 2 }
})
