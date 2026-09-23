/**
 * OpenAI 兼容 Images API 服务端客户端（W2.2 生成代理——rhinestone-studio lab
 * src/lib/api/client.ts 的服务端镜像：generations JSON / edits multipart，恒 n:1，
 * 响应兼容 data[0].b64_json 与 data[0].url；debug 记录结构逐字段对齐 lab 的
 * ImageTaskDebug 契约——endpoint/requestBody/responseStatus/responseStatusText/
 * responseContentType/responseBodyText/parsedResponse/durationMs，apiKey 永不入
 * debug、敏感键打码、长串截断 1000）。
 * 正交意图：
 *   [1] 请求面：参数校验 + endpoint 组装（joinBaseUrl 同 lab 语义）+ edits multipart。
 *   [2] 响应面：data[0] 双形态取图（b64 优先；url 次取字节）。
 *   [3] debug 面：脱敏（截断/打码）与 typed error（kind 对齐 lab ApiErrorKind）。
 */
import { createHash } from 'node:crypto';

const DEBUG_MAX_STRING_LENGTH = 1_000;

export type ApiErrorKind = 'invalid-request' | 'http' | 'auth' | 'network' | 'invalid-response';

/** 排查中转站问题用的请求/响应记录（字段名逐字面对齐 rhinestone-studio lab 契约）。 */
export interface ImageTaskDebug {
  endpoint: string;
  /** 已脱敏的请求参数（不含 apiKey；b64 截断）。 */
  requestBody: Record<string, unknown>;
  responseStatus?: number;
  responseStatusText?: string;
  responseContentType?: string | null;
  responseBodyText?: string;
  /** 解析后的响应（已脱敏）。 */
  parsedResponse?: unknown;
  /** 耗时（ms）。 */
  durationMs?: number;
}

export class ImageApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly debug: ImageTaskDebug;

  constructor(message: string, kind: ApiErrorKind, debug: ImageTaskDebug, status?: number) {
    super(message);
    this.name = 'ImageApiError';
    this.kind = kind;
    this.status = status;
    this.debug = debug;
  }
}

export interface ImgApiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface GenerateCallInput {
  prompt: string;
  size?: string;
  /** edits 模式原图字节（缺席=generations）。 */
  image?: { filename: string; bytes: Uint8Array; mime: string };
  advanced?: Record<string, unknown>;
}

export interface GenerateCallResult {
  /** 图像字节（PNG/JPEG 按上游返回）。 */
  image: Uint8Array;
  debug: ImageTaskDebug;
}

function joinBaseUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${pathname}`;
}

// ---------------------------------------------------------------- 脱敏（lab 同款）

function truncateDebugString(value: string): string {
  if (value.length <= DEBUG_MAX_STRING_LENGTH) return value;
  return `${value.slice(0, DEBUG_MAX_STRING_LENGTH)}… [已截断 ${value.length - DEBUG_MAX_STRING_LENGTH} 字符]`;
}

const SENSITIVE_KEY_RE = /key|token|authorization|api_key/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function sanitizeDebugValue(value: unknown): unknown {
  if (typeof value === 'string') return truncateDebugString(value);
  if (Array.isArray(value)) return value.map(sanitizeDebugValue);
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
    );
  }
  return value;
}

function httpErrorKind(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth';
  return 'http';
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------- 主入口

/**
 * 单次生成调用（服务端）。fetchImpl 注入面（测试替身；缺省全局 fetch）。
 * 失败一律抛 ImageApiError（携带对齐 lab 的 debug 记录）。
 */
export async function callImagesApi(
  settings: ImgApiSettings,
  input: GenerateCallInput,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<GenerateCallResult> {
  for (const [field, value] of [
    ['Base URL', settings.baseUrl],
    ['API Key', settings.apiKey],
    ['模型名', settings.model],
    ['提示词', input.prompt],
  ] as const) {
    if (!value.trim()) throw new Error(`请先配置图像 API 的${field}。`);
  }

  const isEdit = input.image !== undefined;
  const endpoint = joinBaseUrl(settings.baseUrl, isEdit ? '/images/edits' : '/images/generations');
  const startedAt = Date.now();

  let response: Response;
  try {
    if (isEdit) {
      // multipart（Node 全局 FormData——boundary 自动生成，同 lab「绝不手动设 Content-Type」）
      const form = new FormData();
      form.append('model', settings.model.trim());
      form.append('prompt', input.prompt.trim());
      if (input.size?.trim()) form.append('size', input.size.trim());
      const reserved = new Set(['model', 'prompt', 'n', 'size', 'image', 'mask']);
      for (const [key, value] of Object.entries(input.advanced ?? {})) {
        if (reserved.has(key) || value === undefined || value === null) continue;
        form.append(
          key,
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value),
        );
      }
      form.append('n', '1');
      const image = input.image!;
      form.append(
        'image',
        new File([new Uint8Array(image.bytes)], image.filename, { type: image.mime }),
      );
      const debug = createDebug(endpoint, {
        model: settings.model.trim(),
        prompt: input.prompt.trim(),
        size: input.size?.trim() || undefined,
        advanced: input.advanced ?? {},
        n: 1,
        imageCount: 1,
        imageNames: [`${image.filename} (${image.mime}, ${image.bytes.byteLength}B)`],
      });
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey.trim()}` },
        body: form,
        signal,
      });
      return await readResponse(response, debug, startedAt, fetchImpl);
    }
    const body: Record<string, unknown> = {
      model: settings.model.trim(),
      prompt: input.prompt.trim(),
      ...(input.size?.trim() ? { size: input.size.trim() } : {}),
      ...(input.advanced ?? {}),
      n: 1,
    };
    const debug = createDebug(endpoint, body);
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    return await readResponse(response, debug, startedAt, fetchImpl);
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    throw new ImageApiError(
      `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
      'network',
      { endpoint, requestBody: {} },
    );
  }
}

function createDebug(endpoint: string, requestBody: Record<string, unknown>): ImageTaskDebug {
  return { endpoint, requestBody: sanitizeDebugValue(requestBody) as Record<string, unknown> };
}

async function readResponse(
  response: Response,
  debug: ImageTaskDebug,
  startedAt: number,
  fetchImpl: typeof fetch,
): Promise<GenerateCallResult> {
  const bodyText = await response.text();
  debug.durationMs = Date.now() - startedAt;
  debug.responseStatus = response.status;
  debug.responseStatusText = response.statusText;
  debug.responseContentType = response.headers.get('content-type');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  debug.parsedResponse = sanitizeDebugValue(parsed);
  debug.responseBodyText = truncateDebugString(bodyText);

  if (!response.ok) {
    throw new ImageApiError(
      `上游返回 HTTP ${response.status}${readApiErrorMessage(parsed)}`,
      httpErrorKind(response.status),
      debug,
      response.status,
    );
  }
  const item = itemOf(parsed);
  if (item === null) {
    throw new ImageApiError('响应 data[0] 缺失。', 'invalid-response', debug);
  }
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    return { image: Buffer.from(item.b64_json, 'base64'), debug };
  }
  if (typeof item.url === 'string' && item.url.length > 0) {
    // url 形态：二段取字节（Content-Type 透传 debug）
    const download = await fetchImpl(item.url);
    if (!download.ok) {
      throw new ImageApiError(
        `结果图下载失败 HTTP ${download.status}`,
        httpErrorKind(download.status),
        debug,
        download.status,
      );
    }
    return { image: new Uint8Array(await download.arrayBuffer()), debug };
  }
  throw new ImageApiError('响应 data[0] 中既无 url 也无 b64_json。', 'invalid-response', debug);
}

function itemOf(parsed: unknown): { b64_json?: unknown; url?: unknown } | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (first === null || typeof first !== 'object') return null;
  return first as { b64_json?: unknown; url?: unknown };
}

function readApiErrorMessage(parsed: unknown): string {
  if (parsed !== null && typeof parsed === 'object') {
    const error = (parsed as { error?: unknown }).error;
    if (error !== null && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return `：${message}`;
    }
  }
  return '';
}

/** debug 摘要落帧/落盘面（敏感串已在上游打码——此处再保险去 b64 长串）。 */
export function debugSummary(debug: ImageTaskDebug): string {
  return `${debug.endpoint} → ${debug.responseStatus ?? 'pending'}（${debug.durationMs ?? 0}ms，产物 sha256 已内容寻址）`;
}

export { sha256Of };
