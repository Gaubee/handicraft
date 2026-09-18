import { z } from 'zod'
import { joinBaseUrl, type LabSettings } from './settings'

/**
 * OpenAI 兼容 Images API 的 BYOK 裸 fetch 客户端。
 *
 * 设计移植自 openai-image-webui 的 src/api/openaiImages.ts（按 Svelte/TS 严格模式重写）：
 * - generations 走 JSON，edits 走 multipart（FormData 绝不手动设 Content-Type）
 * - 恒发 n:1（Advanced JSON 也无法覆盖——多候选 = 客户端并发独立请求）
 * - 响应兼容 data[0].url 与 data[0].b64_json
 * - debug 对象全量记录但截断脱敏（b64 截 1000 字符，apiKey 永不入 debug）
 */

const DEBUG_MAX_STRING_LENGTH = 1_000

export type ApiErrorKind =
  | 'invalid-request' // 前端可预判的参数缺失 / Advanced JSON 非法
  | 'http' // 上游返回非 2xx
  | 'auth' // 401/403 鉴权失败
  | 'network' // fetch 抛异常（多为 CORS）
  | 'invalid-response' // 响应结构不符合 Images API

export class ImageApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly debug: ImageTaskDebug

  constructor(message: string, kind: ApiErrorKind, debug: ImageTaskDebug, status?: number) {
    super(message)
    this.name = 'ImageApiError'
    this.kind = kind
    this.status = status
    this.debug = debug
  }
}

/** 排查中转站问题用的请求/响应记录（已截断脱敏）。 */
export interface ImageTaskDebug {
  endpoint: string
  /** 已脱敏的请求参数（不含 apiKey；b64 截断）。 */
  requestBody: Record<string, unknown>
  responseStatus?: number
  responseStatusText?: string
  responseContentType?: string | null
  responseBodyText?: string
  /** 解析后的响应（已脱敏）。 */
  parsedResponse?: unknown
  /** 耗时（ms）。 */
  durationMs?: number
}

export interface GenerateImageParams {
  settings: LabSettings
  prompt: string
  /** 可选尺寸，如 '1024x1024'；空串则不发送。 */
  size?: string
  /** Advanced JSON 解析结果，原样合并进请求体。 */
  advanced?: Record<string, unknown>
  signal?: AbortSignal
}

export interface EditImageParams extends GenerateImageParams {
  /** 参考原图（已过白名单/降采样预处理）。 */
  image: File
}

export interface GenerateImageResult {
  /** http(s) URL 或 data:image/...;base64, 数据 URL。 */
  imageUrl: string
  b64Json?: string
  debug: ImageTaskDebug
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  errorKind?: ApiErrorKind
  status?: number
  modelCount?: number
}

// ---------------------------------------------------------------------------
// Advanced JSON 逃生舱
// ---------------------------------------------------------------------------

export type AdvancedParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

/** Advanced JSON 文本框解析：空串合法（= 无附加参数）；非法 JSON 前端直接拦截。 */
export function parseAdvancedJson(text: string): AdvancedParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: {} }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Advanced JSON 必须是对象（{ "key": value }）' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Advanced JSON 解析失败：${detail}` }
  }
}

// ---------------------------------------------------------------------------
// debug 脱敏
// ---------------------------------------------------------------------------

function truncateDebugString(value: string): string {
  if (value.length <= DEBUG_MAX_STRING_LENGTH) return value
  return `${value.slice(0, DEBUG_MAX_STRING_LENGTH)}… [已截断 ${value.length - DEBUG_MAX_STRING_LENGTH} 字符]`
}

/** 敏感键名（子串匹配，大小写不敏感）：Advanced JSON 逃生舱可能塞入凭据类参数，值一律打码 */
const SENSITIVE_KEY_RE = /key|token|authorization|api_key/i

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key)
}

/** 深度打码对象中敏感键的值（返回新对象） */
function maskSensitiveKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitiveKeysDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isSensitiveKey(k) ? '***' : maskSensitiveKeysDeep(v)]),
    )
  }
  return value
}

/**
 * 持久化用的 Advanced JSON 脱敏：解析后按敏感键打码再序列化。
 * 任务元数据会落入 localStorage（明文可读），Advanced JSON 里恶意塞入的凭据
 * 必须在持久层打码；非法 JSON 原样返回（上游运行时校验已拦截，此处兜底）。
 * 代价：hydrate 恢复的任务重试时该键值为 '***'（凭据本不应走 Advanced JSON）。
 */
export function maskAdvancedJsonForPersist(advancedJson: string): string {
  if (!advancedJson.trim()) return advancedJson
  try {
    const parsed: unknown = JSON.parse(advancedJson)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return advancedJson
    return JSON.stringify(maskSensitiveKeysDeep(parsed))
  } catch {
    return advancedJson
  }
}

function sanitizeDebugValue(value: unknown): unknown {
  if (typeof value === 'string') return truncateDebugString(value)
  if (Array.isArray(value)) return value.map(sanitizeDebugValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSensitiveKey(key)
          ? '***'
          : (key === 'b64_json' || key === 'data') && typeof nested === 'string'
            ? truncateDebugString(nested)
            : sanitizeDebugValue(nested),
      ]),
    )
  }
  return value
}

function createDebug(endpoint: string, requestBody: Record<string, unknown>): ImageTaskDebug {
  return {
    endpoint,
    requestBody: sanitizeDebugValue(requestBody) as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// 响应校验（zod）与解析
// ---------------------------------------------------------------------------

const imageItemSchema = z.object({
  url: z.string().min(1).optional(),
  b64_json: z.string().min(1).optional(),
})

const imageResponseSchema = z.object({
  data: z.array(imageItemSchema).min(1),
  created: z.number().optional(),
  usage: z.unknown().optional(),
})

function readResponseText(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

function parseJsonResponse(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function fillResponseDebug(debug: ImageTaskDebug, res: Response, bodyText: string, parsed: unknown): void {
  debug.responseStatus = res.status
  debug.responseStatusText = res.statusText
  debug.responseContentType = res.headers.get('content-type')
  debug.responseBodyText = truncateDebugString(bodyText)
  debug.parsedResponse = sanitizeDebugValue(parsed)
}

function readApiErrorMessage(res: Response, text: string): string {
  if (!text) return `请求失败，HTTP ${res.status}`
  const parsed = parseJsonResponse(text)
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const candidate = parsed as { error?: { message?: unknown }; message?: unknown }
    if (typeof candidate.error?.message === 'string' && candidate.error.message) {
      return candidate.error.message
    }
    if (typeof candidate.message === 'string' && candidate.message) return candidate.message
  }
  return text
}

function httpErrorKind(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth'
  return 'http'
}

function httpErrorMessage(status: number, upstream: string): string {
  const label = status === 401 || status === 403 ? '鉴权失败' : `上游错误 HTTP ${status}`
  return `${label}：${upstream}`
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function networkErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return `网络请求失败（${reason}）。若 curl 可直接访问而此处报 Failed to fetch，通常是中转站未放行 CORS。`
}

function imageItemToResult(parsed: unknown, debug: ImageTaskDebug): GenerateImageResult {
  const item = imageResponseSchema.parse(parsed).data[0]
  if (item.b64_json) {
    return { imageUrl: `data:image/png;base64,${item.b64_json}`, b64Json: item.b64_json, debug }
  }
  if (item.url) {
    return { imageUrl: item.url, debug }
  }
  throw new ImageApiError('响应 data[0] 中既无 url 也无 b64_json。', 'invalid-response', debug)
}

function parseSuccessResponse(debug: ImageTaskDebug, bodyText: string): GenerateImageResult {
  const parsed = parseJsonResponse(bodyText)
  debug.parsedResponse = sanitizeDebugValue(parsed)
  if (parsed === undefined) {
    throw new ImageApiError('响应不是合法 JSON 或为空。', 'invalid-response', debug)
  }
  const validated = imageResponseSchema.safeParse(parsed)
  if (!validated.success) {
    throw new ImageApiError(
      `响应结构不符合 Images API：${validated.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
      'invalid-response',
      debug,
    )
  }
  return imageItemToResult(parsed, debug)
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

function assertBasicParams(params: GenerateImageParams): void {
  const { settings, prompt } = params
  if (!settings.baseUrl.trim()) throw new Error('请先在设置中填写 Base URL。')
  if (!settings.apiKey.trim()) throw new Error('请先在设置中填写 API Key。')
  if (!settings.model.trim()) throw new Error('请先在设置中填写模型名。')
  if (!prompt.trim()) throw new Error('提示词不能为空。')
}

// ---------------------------------------------------------------------------
// POST /images/generations（JSON）
// ---------------------------------------------------------------------------

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const { settings, prompt, size, advanced = {}, signal } = params
  assertBasicParams(params)

  const endpoint = joinBaseUrl(settings.baseUrl, '/images/generations')
  // n 放在 advanced 之后合并：多候选恒由客户端并发承担，请求体 n 恒为 1。
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    prompt: prompt.trim(),
    ...(size?.trim() ? { size: size.trim() } : {}),
    ...advanced,
    n: 1,
  }
  const debug = createDebug(endpoint, body)
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    debug.durationMs = Date.now() - startedAt
    if (isAbortError(error)) throw error
    throw new ImageApiError(networkErrorMessage(error), 'network', debug)
  }

  const bodyText = await readResponseText(res)
  debug.durationMs = Date.now() - startedAt
  fillResponseDebug(debug, res, bodyText, parseJsonResponse(bodyText))

  if (!res.ok) {
    throw new ImageApiError(
      httpErrorMessage(res.status, readApiErrorMessage(res, bodyText)),
      httpErrorKind(res.status),
      debug,
      res.status,
    )
  }
  return parseSuccessResponse(debug, bodyText)
}

// ---------------------------------------------------------------------------
// POST /images/edits（multipart）
// ---------------------------------------------------------------------------

export async function editImage(params: EditImageParams): Promise<GenerateImageResult> {
  const { settings, prompt, size, advanced = {}, image, signal } = params
  assertBasicParams(params)

  const endpoint = joinBaseUrl(settings.baseUrl, '/images/edits')
  const form = new FormData()
  form.append('model', settings.model.trim())
  form.append('prompt', prompt.trim())
  if (size?.trim()) form.append('size', size.trim())
  // FormData 的 append 无法覆盖：保留字段从 advanced 中剔除，保证 n:1 等不变量。
  const reservedFormKeys = new Set(['model', 'prompt', 'n', 'size', 'image', 'mask'])
  for (const [key, value] of Object.entries(advanced)) {
    if (reservedFormKeys.has(key) || value === undefined || value === null) continue
    form.append(key, typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value))
  }
  // n 恒为 1：edits 同样由客户端并发承担多候选。
  form.append('n', '1')
  // 参考图重复 image 字段（浏览器自动生成 multipart boundary，多 part 即多图语义）。
  form.append('image', image, image.name)

  const debugBody: Record<string, unknown> = {
    model: settings.model.trim(),
    prompt: prompt.trim(),
    size: size?.trim() || undefined,
    advanced,
    n: 1,
    imageCount: 1,
    imageNames: [`${image.name} (${image.type}, ${image.size}B)`],
  }
  const debug = createDebug(endpoint, debugBody)
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      // 绝不手动设 Content-Type：multipart boundary 必须由浏览器生成。
      headers: { Authorization: `Bearer ${settings.apiKey.trim()}` },
      body: form,
      signal,
    })
  } catch (error) {
    debug.durationMs = Date.now() - startedAt
    if (isAbortError(error)) throw error
    throw new ImageApiError(networkErrorMessage(error), 'network', debug)
  }

  const bodyText = await readResponseText(res)
  debug.durationMs = Date.now() - startedAt
  fillResponseDebug(debug, res, bodyText, parseJsonResponse(bodyText))

  if (!res.ok) {
    throw new ImageApiError(
      httpErrorMessage(res.status, readApiErrorMessage(res, bodyText)),
      httpErrorKind(res.status),
      debug,
      res.status,
    )
  }
  return parseSuccessResponse(debug, bodyText)
}

// ---------------------------------------------------------------------------
// GET /models 连接测试
// ---------------------------------------------------------------------------

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() })).optional(),
})

export async function testConnection(settings: LabSettings, signal?: AbortSignal): Promise<ConnectionTestResult> {
  if (!settings.baseUrl.trim()) {
    return { ok: false, message: '请先填写 Base URL。', errorKind: 'invalid-request' }
  }
  const endpoint = joinBaseUrl(settings.baseUrl, '/models')
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'GET',
      headers: settings.apiKey.trim() ? { Authorization: `Bearer ${settings.apiKey.trim()}` } : {},
      signal,
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    return { ok: false, message: networkErrorMessage(error), errorKind: 'network' }
  }

  const bodyText = await readResponseText(res)
  if (!res.ok) {
    const kind = httpErrorKind(res.status)
    return {
      ok: false,
      message: httpErrorMessage(res.status, readApiErrorMessage(res, bodyText)),
      errorKind: kind,
      status: res.status,
    }
  }

  const parsed = modelsResponseSchema.safeParse(parseJsonResponse(bodyText))
  const modelCount = parsed.success ? parsed.data.data?.length : undefined
  return {
    ok: true,
    status: res.status,
    modelCount,
    message:
      parsed.success && typeof modelCount === 'number'
        ? `连接成功，/models 返回 ${modelCount} 个模型`
        : '连接成功（/models 响应未包含模型列表，但不影响生成）',
  }
}
