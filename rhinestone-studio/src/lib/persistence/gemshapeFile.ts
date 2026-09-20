/**
 * `.gemshape` 钻形资产格式（格式族第五成员）——schema gate 六条 + typed errors
 * （openspec add-gem-catalog-and-sizes W0 0.4，design §1.4 逐条冻结；出处 gemspec R1 P0-6 /
 * 专家稿 v1.1 §A.1.2 + Owner 2026-09-20 裁决一「包含 钻石素材图」）。
 *
 * parser schema gate 六条（全部以 texture 存在为前提，无豁免项）：
 * 1. 解码后实际宽高校验：dataUrl 解码得实际 width/height，与声明不符 = typed error 拒收
 *    （声明值不是信任源——`verifyGemshapeTexture`，异步解码面）；
 * 2. 输入上限：MIME 白名单（可解码集）+ 最大字节数 + 最大像素数（parse 同步面按声明值预检，
 *    verify 面按解码实测复检——防炸弹贴图与性能失控）；
 * 3. alpha bounds 非空：全透明（空 bounds）= 拒收；主径/物理换算一律取 alpha 内容 bounds 的主径
 *    （非整张贴图外框）；
 * 4. fit 语义冻结：physical 宽高与贴图（alpha bounds）纵横比不一致 = 拒绝（超容差；容差内按贴图
 *    实际纵横比校正——消费面行为，W0 只冻拒绝门）——不做静默裁剪/contain；
 * 5. 校准悬空防线：mode='reference' 必须满足 refSpecId 可解析（结构合法）或内嵌 refSpecSnapshot
 *    至少其一；参考资产删除后已入库钻形凭内嵌快照可审计（R3 非阻塞 2：审计不依赖贴图 alpha）；
 * 6. missing custom asset = visible/typed 状态：文档引用的 .gemshape 缺失时显式 missing 态
 *    （assertGemshapeRefs），禁止静默降级为圆钻轮廓后照常导出（导出前置 gate 拦截——运行时
 *    接线归 2.2 vertical slice，本层交付 typed 面）。
 *
 * 补充约束（裁决一 + R3 P0-1 修复冻结）：**texture 必备**——所有 .gemshape 必须携带钻石素材图；
 * vectorPath 为可选渲染加速字段（并存时导出优先矢量）；vector-only（texture 缺席）不是合法输入，
 * parse 以 typed error 拒收。
 *
 * 内容不可变纪律（design §1.6 / R3 P0-2）：texture/vectorPath/physical/calibration/specKey 任何
 * 内容变更 = 另存新资产（新 assetId/新 specKey）；本格式不参与 blobKey 换绑（同 gemgen 先例）。
 * AssetNode 接线 / sys-shapes seed / RightSheet 编辑器归 2.2 vertical slice（W0 只交付 parser 面）。
 */

import {
  SHAPE_IDS,
  customAssetIdMissing,
  type EngineImage,
  type GemSpecSnapshot,
} from '$lib/engine'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'

/** .gemshape v1 起步（无迁移——design §4：五格式中唯一从 v1 起步的新格式）。 */
export const GEMSHAPE_FORMAT_VERSION = 1

/** 贴图 MIME 白名单（可解码集——解码委托 canvas，白名单在 parse 层先行拒绝）。 */
export const GEMSHAPE_TEXTURE_MIME_WHITELIST: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']

/** 贴图字节上限（base64 载荷解码后字节数；防炸弹贴图）。 */
export const GEMSHAPE_TEXTURE_MAX_BYTES = 4 * 1024 * 1024

/** 贴图像素上限（声明与实测双侧校验）。 */
export const GEMSHAPE_TEXTURE_MAX_PIXELS = 2_000_000

/** fit 容差：physical 纵横比与贴图 alpha bounds 纵横比相对偏差超过本值 = 拒收。 */
export const GEMSHAPE_FIT_TOLERANCE = 0.02

// ---------------------------------------------------------------------------
// typed error 家族
// ---------------------------------------------------------------------------

/** gemshape 层错误基类（instanceof 分发用）。 */
export class GemshapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GemshapeError'
  }
}

/** 脏输入：缺字段/类型错/值域外/gate 拒收，带点分字段路径（found 只含类型描述，不泄露 dataUrl）。 */
export class GemshapeFieldError extends GemshapeError {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly found: string,
    note?: string,
  ) {
    super(
      `钻形文件字段不合法：${path || '<文档根>'} 应为 ${expected}，实际为 ${found}${note ? `（${note}）` : ''}。`,
    )
    this.name = 'GemshapeFieldError'
  }
}

/** kind/MIME 交叉校验失败（projectKind × mime × 文件内 kind 三者对齐）。 */
export class GemshapeKindError extends GemshapeError {
  constructor(
    public readonly field: 'kind' | 'mime',
    public readonly expected: string,
    public readonly found: string,
  ) {
    super(`文件 ${field} 不符：期望 ${expected}，实际为 ${found}。`)
    this.name = 'GemshapeKindError'
  }
}

/** 引用状态（missing 四态定名——2.2 vertical slice 验收面；'wrong-kind' 涵盖 parse 失败档）。 */
export type GemshapeRefState = 'resolved' | 'soft-deleted' | 'blob-missing' | 'wrong-kind'

/** gate 6：文档引用的钻形资产非 resolved 态——显式 typed，禁静默降级导出。 */
export class GemshapeRefError extends GemshapeError {
  constructor(
    public readonly assetId: string,
    public readonly state: GemshapeRefState | 'not-found',
  ) {
    super(`钻形资产 ${assetId} 不可用（${state}）：占位渲染 + 清单标注 missing，导出已被阻断——不回退圆钻轮廓。`)
    this.name = 'GemshapeRefError'
  }
}

/**
 * gate 6 纯函数：全部引用必须 resolved，否则 GemshapeRefError（导出前置 gate 的判据面；
 * UI 接线归 2.2/engine gate）。resolve 返回四态；null/undefined = 节点不存在（硬清后）。
 */
export function assertGemshapeRefs(
  assetIds: Iterable<string>,
  resolve: (assetId: string) => GemshapeRefState | null | undefined,
): void {
  for (const assetId of assetIds) {
    const state = resolve(assetId)
    if (state !== 'resolved') {
      throw new GemshapeRefError(assetId, state ?? 'not-found')
    }
  }
}

// ---------------------------------------------------------------------------
// Schema（design §1.4 冻结；键序 = 声明序 = 序列化序）
// ---------------------------------------------------------------------------

/** 钻石素材图（Owner 裁决一「包含 钻石素材图」）——必备；声明值以解码实测为准（gate 1）。 */
export interface GemshapeTexture {
  mime: string
  dataUrl: string
  width: number
  height: number
}

/** 校准出处（烘焙式——结果物化 physical，calibration 只记出处；参考钻后续改动不影响已入库钻形）。 */
export interface GemshapeCalibration {
  mode: 'direct' | 'reference'
  /** mode='reference'：以哪个规格为量纲（如 round-ss10）——必须可解析（结构合法）或内嵌快照。 */
  refSpecId?: string
  /** 内嵌参考规格快照：refSpecId 解析失败时的审计凭据（悬空可审计、不可重新校准）。 */
  refSpecSnapshot?: GemSpecSnapshot
}

/** .gemshape = 格式族第五成员（内容不可变——任何变更另存新资产）。 */
export interface GemshapeFile {
  kind: 'gemshape'
  formatVersion: 1
  appVersion: string
  createdAt: number
  savedAt: number
  name: string
  /** 钻石素材图——必备（vector-only 非法）。 */
  texture: GemshapeTexture
  /** 归一化 SVG path 数据（单位框 0..1）——可选渲染加速字段（并存时导出优先矢量）。 */
  vectorPath?: string
  /** 校准物化结果；diameterMm = max(widthMm, heightMm)。 */
  physical: { widthMm: number; heightMm: number }
  /** canonical 身份键——seed 资产必填（round-ss10）；自定义由 ingest 派生 custom-<assetId>（可缺席）。 */
  specKey?: string
  calibration: GemshapeCalibration
}

/** serializeGemshape 输入：文件字段减去 kind/formatVersion（由序列化层固定写当前版本）。 */
export type GemshapeFileInput = Omit<GemshapeFile, 'kind' | 'formatVersion'>

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
    throw new GemshapeFieldError(path, '对象', describeValue(value))
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new GemshapeFieldError(path, 'string', describeValue(value))
  return value
}

function expectNonEmptyString(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!text.trim()) throw new GemshapeFieldError(path, '非空 string', describeValue(text))
  return text
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GemshapeFieldError(path, '有限 number', describeValue(value))
  }
  return value
}

function expectPositiveNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path)
  if (number <= 0) throw new GemshapeFieldError(path, '正数', describeValue(number))
  return number
}

function expectPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new GemshapeFieldError(path, '正整数', describeValue(value))
  }
  return value
}

function expectSpecKey(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path)
  if (/\s/.test(text)) {
    throw new GemshapeFieldError(path, '不含空白的 specKey（canonical 键）', describeValue(text))
  }
  return text
}

const BASE64_DATAURL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/

/** dataUrl 严格形态 + 白名单 mime + 字节上限（gate 2；字节按 base64 载荷折算）。 */
function expectTextureDataUrl(value: unknown, path: string, declaredMime: string): string {
  const dataUrl = expectString(value, path)
  const match = BASE64_DATAURL_RE.exec(dataUrl)
  if (!match) {
    throw new GemshapeFieldError(path, 'base64 data URL（data:<mime>;base64,<载荷>）', describeValue(dataUrl))
  }
  if (match[1] !== declaredMime) {
    throw new GemshapeFieldError(
      path,
      `头部 mime 与 texture.mime（${declaredMime}）一致的 data URL`,
      `mime ${match[1]}`,
    )
  }
  const decodedBytes = Math.floor((match[2].length * 3) / 4)
  if (decodedBytes <= 0) {
    throw new GemshapeFieldError(path, '非空贴图载荷', '空载荷')
  }
  if (decodedBytes > GEMSHAPE_TEXTURE_MAX_BYTES) {
    throw new GemshapeFieldError(
      path,
      `≤ ${GEMSHAPE_TEXTURE_MAX_BYTES} 字节的贴图载荷`,
      `约 ${decodedBytes} 字节（超限拒收——防炸弹贴图）`,
    )
  }
  return dataUrl
}

/** gate 2（MIME 面）：白名单先行拒绝。 */
function expectTextureMime(value: unknown, path: string): string {
  const mime = expectNonEmptyString(value, path)
  if (!GEMSHAPE_TEXTURE_MIME_WHITELIST.includes(mime)) {
    throw new GemshapeFieldError(
      path,
      `白名单 MIME（${GEMSHAPE_TEXTURE_MIME_WHITELIST.join('/')}）`,
      mime,
    )
  }
  return mime
}

/** texture 结构校验（必备——vector-only 在 parseCoreFields 预检拒收）+ 声明像素上限预检（gate 2）。 */
function parseTexture(value: unknown, path: string): GemshapeTexture {
  const record = expectRecord(value, path)
  const mime = expectTextureMime(record.mime, `${path}.mime`)
  const width = expectPositiveInteger(record.width, `${path}.width`)
  const height = expectPositiveInteger(record.height, `${path}.height`)
  if (width * height > GEMSHAPE_TEXTURE_MAX_PIXELS) {
    throw new GemshapeFieldError(
      `${path}`,
      `声明像素 ≤ ${GEMSHAPE_TEXTURE_MAX_PIXELS} 的贴图`,
      `${width}×${height} = ${width * height} px（超限拒收）`,
    )
  }
  return {
    mime,
    dataUrl: expectTextureDataUrl(record.dataUrl, `${path}.dataUrl`, mime),
    width,
    height,
  }
}

// ---------------------------------------------------------------------------
// vectorPath：归一化 SVG path 校验（单位框 0..1；语法子集 M/L/H/V/C/S/Q/T/Z——弧 A 不受支持）
// ---------------------------------------------------------------------------

const PATH_COMMANDS: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0,
  m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, z: 0,
}

/**
 * vectorPath 校验：语法（命令子集 + 参数数）+ 全部坐标 ∈ [0,1]（单位框）。
 * 相对命令（小写）以累计光标换算后校验终点；控制点按声明值校验（归一化数据的生成纪律）。
 */
export function validateVectorPath(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path)
  const tokens = text.match(/[MmLlHhVvCcSsQqTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)
  if (tokens === null || tokens.join('') !== text.replace(/\s+/g, '')) {
    throw new GemshapeFieldError(path, '合法 SVG path 数据（命令 M/L/H/V/C/S/Q/T/Z + 数字）', describeValue(text))
  }
  let cursorX = 0
  let cursorY = 0
  let index = 0
  let hasCommand = false
  while (index < tokens.length) {
    const token = tokens[index]
    if (!(token in PATH_COMMANDS)) {
      throw new GemshapeFieldError(path, 'SVG path 命令（M/L/H/V/C/S/Q/T/Z）', `记号 ${token}`)
    }
    const command = token as keyof typeof PATH_COMMANDS
    hasCommand = true
    const argCount = PATH_COMMANDS[command]
    const args: number[] = []
    for (let i = 0; i < argCount; i += 1) {
      const numberToken = tokens[index + 1 + i]
      const parsed = Number(numberToken)
      if (numberToken === undefined || !Number.isFinite(parsed)) {
        throw new GemshapeFieldError(path, `${command} 命令的 ${argCount} 个数值参数`, `第 ${i + 1} 参数缺失/非数`)
      }
      args.push(parsed)
    }
    index += 1 + argCount
    // 坐标边界校验：绝对命令直接校验；相对命令换算终点（相对偏移本身可为负）
    const absolute = command === command.toUpperCase()
    const coordPairs: Array<[number, number]> = []
    if (command.toUpperCase() === 'M' || command.toUpperCase() === 'L') {
      coordPairs.push([args[0], args[1]])
    } else if (command.toUpperCase() === 'C') {
      coordPairs.push([args[0], args[1]], [args[2], args[3]], [args[4], args[5]])
    } else if (command.toUpperCase() === 'S' || command.toUpperCase() === 'Q') {
      coordPairs.push([args[0], args[1]], [args[2], args[3]])
    } else if (command.toUpperCase() === 'T') {
      coordPairs.push([args[0], args[1]])
    }
    for (const [x, y] of coordPairs) {
      const finalX = absolute ? x : cursorX + x
      const finalY = absolute ? y : cursorY + y
      if (finalX < 0 || finalX > 1 || finalY < 0 || finalY > 1) {
        throw new GemshapeFieldError(
          path,
          '单位框 0..1 内的归一化坐标',
          `坐标 (${finalX.toFixed(4)}, ${finalY.toFixed(4)}) 越界`,
        )
      }
    }
    if (command.toUpperCase() === 'M' || command.toUpperCase() === 'L') {
      cursorX = absolute ? args[0] : cursorX + args[0]
      cursorY = absolute ? args[1] : cursorY + args[1]
    } else if (command.toUpperCase() === 'H') {
      cursorX = absolute ? args[0] : cursorX + args[0]
      if (cursorX < 0 || cursorX > 1) {
        throw new GemshapeFieldError(path, '单位框 0..1 内的归一化坐标', `x = ${cursorX.toFixed(4)} 越界`)
      }
    } else if (command.toUpperCase() === 'V') {
      cursorY = absolute ? args[0] : cursorY + args[0]
      if (cursorY < 0 || cursorY > 1) {
        throw new GemshapeFieldError(path, '单位框 0..1 内的归一化坐标', `y = ${cursorY.toFixed(4)} 越界`)
      }
    } else if (command.toUpperCase() === 'C') {
      cursorX = absolute ? args[4] : cursorX + args[4]
      cursorY = absolute ? args[5] : cursorY + args[5]
    } else if (command.toUpperCase() === 'S' || command.toUpperCase() === 'Q') {
      cursorX = absolute ? args[2] : cursorX + args[2]
      cursorY = absolute ? args[3] : cursorY + args[3]
    } else if (command.toUpperCase() === 'T') {
      cursorX = absolute ? args[0] : cursorX + args[0]
      cursorY = absolute ? args[1] : cursorY + args[1]
    }
  }
  if (!hasCommand) {
    throw new GemshapeFieldError(path, '至少一个 SVG path 命令', '空 path')
  }
  return text
}

// ---------------------------------------------------------------------------
// calibration 校验（gate 5）+ physical / 快照
// ---------------------------------------------------------------------------

/**
 * [R6 P1-1] custom 规格快照缺 assetId = typed reject（engine customAssetIdMissing 单一语义源；
 * serialize/parse 双侧同口径——serializeGemshape 经 parseCalibration→本函数校验，坏输入整体拒绝无半载荷）。
 */
function parseGemSpecSnapshotRecord(value: unknown, path: string): GemSpecSnapshot {
  const record = expectRecord(value, path)
  const shapeId = record.shapeId
  if (typeof shapeId !== 'string' || !SHAPE_IDS.includes(shapeId as (typeof SHAPE_IDS)[number])) {
    throw new GemshapeFieldError(path, `规格快照对象（shapeId ∈ ${SHAPE_IDS.join('/')}）`, describeValue(value))
  }
  if (customAssetIdMissing(record)) {
    throw new GemshapeFieldError(
      `${path}.assetId`,
      "shapeId='custom' 时的非空 assetId（custom specKey 派生依据）",
      record.assetId === undefined ? 'undefined（custom 规格快照缺 assetId——typed reject）' : '空串（custom 规格快照缺 assetId——typed reject）',
    )
  }
  const rotationDegRaw = record.rotationDeg
  let rotationDeg: number | undefined
  if (rotationDegRaw !== undefined) {
    rotationDeg = expectFiniteNumber(rotationDegRaw, `${path}.rotationDeg`)
    if (rotationDeg < 0 || rotationDeg >= 360) {
      throw new GemshapeFieldError(`${path}.rotationDeg`, '[0,360) 的数', describeValue(rotationDeg))
    }
  }
  const widthMm = record.widthMm === undefined ? undefined : expectPositiveNumber(record.widthMm, `${path}.widthMm`)
  const heightMm = record.heightMm === undefined ? undefined : expectPositiveNumber(record.heightMm, `${path}.heightMm`)
  const assetId = record.assetId === undefined ? undefined : expectNonEmptyString(record.assetId, `${path}.assetId`)
  return {
    specKey: expectSpecKey(record.specKey, `${path}.specKey`),
    ordinal: expectPositiveInteger(record.ordinal, `${path}.ordinal`),
    shapeId: shapeId as GemSpecSnapshot['shapeId'],
    sizeLabel: expectNonEmptyString(record.sizeLabel, `${path}.sizeLabel`),
    diameterMm: expectPositiveNumber(record.diameterMm, `${path}.diameterMm`),
    ...(widthMm !== undefined ? { widthMm } : {}),
    ...(heightMm !== undefined ? { heightMm } : {}),
    ...(assetId !== undefined ? { assetId } : {}),
    ...(rotationDeg !== undefined ? { rotationDeg } : {}),
  }
}

function parseCalibration(value: unknown, path: string): GemshapeCalibration {
  const record = expectRecord(value, path)
  const mode = record.mode
  if (mode !== 'direct' && mode !== 'reference') {
    throw new GemshapeFieldError(`${path}.mode`, "'direct' | 'reference'", describeValue(mode))
  }
  const refSpecId = record.refSpecId === undefined ? undefined : expectSpecKey(record.refSpecId, `${path}.refSpecId`)
  const refSpecSnapshot =
    record.refSpecSnapshot === undefined
      ? undefined
      : parseGemSpecSnapshotRecord(record.refSpecSnapshot, `${path}.refSpecSnapshot`)
  if (mode === 'direct' && refSpecId !== undefined) {
    throw new GemshapeFieldError(`${path}.refSpecId`, "仅 mode='reference' 时携带", 'direct 模式携带 refSpecId')
  }
  if (mode === 'reference' && refSpecId === undefined && refSpecSnapshot === undefined) {
    // gate 5：reference 校准悬空防线——二者至少其一
    throw new GemshapeFieldError(
      `${path}.refSpecId`,
      '可解析的 refSpecId 或内嵌 refSpecSnapshot 至少其一',
      '两者均缺席（悬空校准拒收）',
    )
  }
  return {
    mode,
    ...(refSpecId !== undefined ? { refSpecId } : {}),
    ...(refSpecSnapshot !== undefined ? { refSpecSnapshot } : {}),
  }
}

function parsePhysical(value: unknown, path: string): { widthMm: number; heightMm: number } {
  const record = expectRecord(value, path)
  return {
    widthMm: expectPositiveNumber(record.widthMm, `${path}.widthMm`),
    heightMm: expectPositiveNumber(record.heightMm, `${path}.heightMm`),
  }
}

// ---------------------------------------------------------------------------
// 信封读取（MIME 门 → JSON → kind 门 → 版本门）+ serialize / parse
// ---------------------------------------------------------------------------

export interface GemshapeParseOptions {
  /** 容器/节点声明的 MIME（导入路径交叉校验）。 */
  mime?: string
}

function readEnvelope(text: string, options?: GemshapeParseOptions): Record<string, unknown> {
  if (options?.mime !== undefined && options.mime !== PROJECT_MIME.gemshape) {
    throw new GemshapeKindError('mime', PROJECT_MIME.gemshape, options.mime)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new GemshapeFieldError('', '合法 JSON 文档', '无法解析', error instanceof Error ? error.message : String(error))
  }
  const envelope = expectRecord(parsed, '')
  if (envelope.kind !== 'gemshape') {
    throw new GemshapeKindError('kind', 'gemshape', describeValue(envelope.kind))
  }
  const version = envelope.formatVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new GemshapeFieldError('formatVersion', '整数', describeValue(version))
  }
  if (version > GEMSHAPE_FORMAT_VERSION) {
    throw new GemshapeFieldError(
      'formatVersion',
      `≤ ${GEMSHAPE_FORMAT_VERSION}（本应用支持的版本）`,
      `v${version}（文件来自更新版本的应用）`,
    )
  }
  if (version < GEMSHAPE_FORMAT_VERSION) {
    throw new GemshapeFieldError('formatVersion', `= ${GEMSHAPE_FORMAT_VERSION}（v1 起步，无迁移链）`, `v${version}`)
  }
  return envelope
}

/** 核心字段校验 + 键序重建（serialize/parse 双侧共用——同口径防御）。 */
function parseCoreFields(value: Record<string, unknown>): Omit<GemshapeFile, 'kind' | 'formatVersion'> {
  if (value.texture === undefined && value.vectorPath !== undefined) {
    throw new GemshapeFieldError(
      'texture',
      '携带 texture（钻石素材图必备；vectorPath 仅为可选渲染加速字段）',
      'vector-only 输入（拒收）',
    )
  }
  const vectorPath = value.vectorPath === undefined ? undefined : validateVectorPath(value.vectorPath, 'vectorPath')
  const specKey = value.specKey === undefined ? undefined : expectSpecKey(value.specKey, 'specKey')
  return {
    appVersion: expectNonEmptyString(value.appVersion, 'appVersion'),
    createdAt: expectFiniteNumber(value.createdAt, 'createdAt'),
    savedAt: expectFiniteNumber(value.savedAt, 'savedAt'),
    name: expectString(value.name, 'name'),
    texture: parseTexture(value.texture, 'texture'),
    ...(vectorPath !== undefined ? { vectorPath } : {}),
    physical: parsePhysical(value.physical, 'physical'),
    ...(specKey !== undefined ? { specKey } : {}),
    calibration: parseCalibration(value.calibration, 'calibration'),
  }
}

/** 序列化钻形资产：声明序构造 + 双侧同口径校验（内容不可变——序列化即定稿）。 */
export function serializeGemshape(input: GemshapeFileInput): string {
  const core = parseCoreFields(input as Record<string, unknown>)
  return JSON.stringify({
    kind: 'gemshape',
    formatVersion: GEMSHAPE_FORMAT_VERSION,
    ...core,
  })
}

/**
 * 解析钻形资产（同步面）：texture 必备（vector-only 拒收）/ MIME 白名单 / 字节·像素上限 /
 * vectorPath 单位框 / 校准悬空防线。贴图解码实测三 gate（宽高·alpha·fit）在
 * `verifyGemshapeTexture`（异步）——入库时刻一次性执行。
 */
export function parseGemshape(text: string, options?: GemshapeParseOptions): GemshapeFile {
  const envelope = readEnvelope(text, options)
  return {
    kind: 'gemshape',
    formatVersion: GEMSHAPE_FORMAT_VERSION,
    ...parseCoreFields(envelope),
  }
}

// ---------------------------------------------------------------------------
// 贴图解码三 gate（gate 1 实测宽高 / gate 3 alpha bounds / gate 4 fit 容差）+ 校准烘焙
// ---------------------------------------------------------------------------

/** 贴图解码器：dataUrl → 像素面（生产 = canvas 零重采样解码；测试注入确定性替身）。 */
export type GemshapeTextureDecoder = (dataUrl: string) => Promise<EngineImage>

/** alpha 内容 bounds（gate 3 判据；全透明返回 null——主径/物理换算一律取 bounds，非贴图外框）。 */
export function alphaBounds(image: EngineImage): { x: number; y: number; w: number; h: number } | null {
  const { width, height, data } = image
  if (data.length !== width * height * 4) {
    throw new GemshapeFieldError('texture', `${width}×${height}×4 的像素平面`, `data 长度 ${data.length}`)
  }
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** verify 产物：实测信息 + alpha bounds（主径 = max(w,h)——物理换算依据）。 */
export interface GemshapeTextureVerification {
  image: EngineImage
  bounds: { x: number; y: number; w: number; h: number }
  /** alpha bounds 主径 px（max(w,h)） */
  majorAxisPx: number
}

/**
 * 贴图解码实测三 gate（入库时刻一次性执行）：
 * gate 1 声明宽高 ≠ 解码实测 → 拒收（声明值不是信任源）；
 * gate 2 复检实测像素上限；
 * gate 3 全透明（空 bounds）→ 拒收；
 * gate 4 physical 纵横比与 alpha bounds 纵横比相对偏差超容差 → 拒收（不做静默裁剪/contain；
 *      容差内的「按贴图纵横比校正 + 告警」是消费面行为，W0 只冻拒绝门）。
 */
export async function verifyGemshapeTexture(
  file: GemshapeFile,
  decode: GemshapeTextureDecoder,
): Promise<GemshapeTextureVerification> {
  const image = await decode(file.texture.dataUrl)
  if (
    !Number.isInteger(image.width) ||
    image.width <= 0 ||
    !Number.isInteger(image.height) ||
    image.height <= 0
  ) {
    throw new GemshapeFieldError('texture.width', '携带有效尺寸的贴图', `${image.width}×${image.height}`)
  }
  if (image.width !== file.texture.width || image.height !== file.texture.height) {
    throw new GemshapeFieldError(
      'texture.width',
      `与解码实测一致（声明 ${file.texture.width}×${file.texture.height}）`,
      `实测 ${image.width}×${image.height}（声明值不是信任源）`,
    )
  }
  if (image.width * image.height > GEMSHAPE_TEXTURE_MAX_PIXELS) {
    throw new GemshapeFieldError(
      'texture',
      `实测像素 ≤ ${GEMSHAPE_TEXTURE_MAX_PIXELS}`,
      `${image.width}×${image.height} = ${image.width * image.height} px`,
    )
  }
  const bounds = alphaBounds(image)
  if (bounds === null) {
    throw new GemshapeFieldError('texture.alphaBounds', '非空 alpha 内容 bounds', '全透明（空 bounds）')
  }
  const boundsAspect = bounds.w / bounds.h
  const physicalAspect = file.physical.widthMm / file.physical.heightMm
  const deviation = Math.abs(physicalAspect - boundsAspect) / boundsAspect
  if (deviation > GEMSHAPE_FIT_TOLERANCE) {
    throw new GemshapeFieldError(
      'physical',
      `纵横比与贴图 alpha bounds 一致（容差 ${(GEMSHAPE_FIT_TOLERANCE * 100).toFixed(0)}% 内）`,
      `相对偏差 ${(deviation * 100).toFixed(1)}%（比例漂移 = 物理尺寸谎言，拒收）`,
    )
  }
  return { image, bounds, majorAxisPx: Math.max(bounds.w, bounds.h) }
}

/** 校准烘焙输入（direct 输 mm / reference 以现有规格反推——「拿现有的钻去做参考」）。 */
export type CalibrationBakeInput =
  | { mode: 'direct'; widthMm: number; heightMm: number }
  | { mode: 'reference'; refSpec: Pick<GemSpecSnapshot, 'specKey' | 'diameterMm'> }

/**
 * 校准烘焙（纯函数；design §1.4 校准语义）：结果物化 physical；calibration 只记出处——
 * 参考钻后续改动不影响已入库钻形（ManualEditHandoff 同 philosophy）。
 * - direct：直接采用声明的物理宽高；
 * - reference：alpha bounds 主径 px ÷ 参考规格 diameterMm → px/mm → bounds 宽高换算 mm。
 */
export function bakeCalibrationPhysical(
  bounds: { w: number; h: number },
  input: CalibrationBakeInput,
): { widthMm: number; heightMm: number } {
  if (input.mode === 'direct') {
    return { widthMm: input.widthMm, heightMm: input.heightMm }
  }
  const majorAxisPx = Math.max(bounds.w, bounds.h)
  const pxPerMm = majorAxisPx / input.refSpec.diameterMm
  if (!(pxPerMm > 0)) {
    throw new GemshapeFieldError('calibration', '正的参考直径', `px/mm = ${pxPerMm}`)
  }
  return { widthMm: bounds.w / pxPerMm, heightMm: bounds.h / pxPerMm }
}

// ---------------------------------------------------------------------------
// 浏览器解码器（canvas 零重采样——与 projectFile dataUrlToPainting 同链；node 测试注入替身）
// ---------------------------------------------------------------------------

export async function canvasTextureDecoder(dataUrl: string): Promise<EngineImage> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new GemshapeFieldError('texture.dataUrl', '可解码的贴图图像', '解码失败'))
    element.src = dataUrl
  })
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new GemshapeFieldError('texture.dataUrl', '携带有效尺寸的贴图', `${width}×${height}`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new GemshapeFieldError('texture.dataUrl', '可用的 Canvas 2D', '上下文创建失败（无法解码贴图）')
  }
  ctx.drawImage(img, 0, 0, width, height)
  const out = ctx.getImageData(0, 0, width, height)
  return { width, height, data: new Uint8ClampedArray(out.data) }
}
