/**
 * OpenAI 兼容 Images API 服务端客户端（W2.2 生成代理——rhinestone-studio lab
 * src/lib/api/client.ts 的服务端镜像：generations JSON / edits multipart，恒 n:1，
 * 响应兼容 data[0].b64_json 与 data[0].url；debug 记录结构逐字段对齐 lab 的
 * ImageTaskDebug 契约——endpoint/requestBody/responseStatus/responseStatusText/
 * responseContentType/responseBodyText/parsedResponse/durationMs，apiKey 永不入
 * debug、敏感键打码、长串截断 1000）。
 * P1-5：responseBodyText 原文不再入 debug（JSON 递归脱敏/非 JSON 无敏感摘要）。
 * P2-1：url 形态二段取图走 downloadImageData（https only/拒私网/禁跨域重定向/
 * 流式大小上限/AbortSignal 透传）。
 * 正交意图：
 *   [1] 请求面：参数校验 + endpoint 组装（joinBaseUrl 同 lab 语义）+ edits multipart。
 *   [2] 响应面：data[0] 双形态取图（b64 优先；url 次取字节）。
 *   [3] debug 面：脱敏（截断/打码）与 typed error（kind 对齐 lab ApiErrorKind）。
 *   [4] 二段取图面（downloadImageData）：SSRF 加固纯函数集（isPublicAddress 等）。
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

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

// ---------------------------------------------------------------- 脱敏（lab 同款 + P1-5）

function truncateDebugString(value: string): string {
  if (value.length <= DEBUG_MAX_STRING_LENGTH) return value;
  return `${value.slice(0, DEBUG_MAX_STRING_LENGTH)}… [已截断 ${value.length - DEBUG_MAX_STRING_LENGTH} 字符]`;
}

const SENSITIVE_KEY_RE = /key|token|authorization|api_key/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** 敏感值打码（P1-5：保留尾 4 位便于核对，截断前缀）。 */
function maskSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 8) return `…${value.slice(-4)}`;
  return '***';
}

function sanitizeDebugValue(value: unknown, apiSecret = ''): unknown {
  if (typeof value === 'string') return truncateDebugString(maskSecretsInText(value, apiSecret));
  if (Array.isArray(value)) return value.map((nested) => sanitizeDebugValue(nested, apiSecret));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSensitiveKey(key)
          ? maskSensitiveValue(nested)
          : (key === 'b64_json' || key === 'data') && typeof nested === 'string'
            ? maskSecretsInText(truncateDebugString(nested), apiSecret)
            : sanitizeDebugValue(nested, apiSecret),
      ]),
    );
  }
  return value;
}

/**
 * 外发文本脱敏（P1-5 R2 残余——错误消息链路）：先兜底替换配置密钥本体，
 * 再把 token 形态长串（≥16 位凭据字符集，上游可能回显任意凭据）打码为「…尾4位」。
 * 任何会离开进程内存进入任务持久面（error 帧/task error/异常 message）的文本必经此面。
 */
function maskSecretsInText(text: string, apiSecret: string): string {
  const masked = replaceConfiguredSecret(text, apiSecret);
  return masked.replace(TOKEN_RUN_RE, (run) => (run.includes('***') ? run : `…${run.slice(-4)}`));
}

/** token 形态长串（≥16 位凭据字符集）——非 JSON 摘要里一律打码（上游可能原文回显）。 */
const TOKEN_RUN_RE = /[A-Za-z0-9_\-./+=]{16,}/g;

/**
 * 响应原文入 debug 的脱敏面（P1-5——修复 responseBodyText 保留原文的泄露路径）：
 * JSON → 递归脱敏（敏感键尾 4 位）后序列化；非 JSON → 无敏感模式的截断摘要
 * （token 形态串打码）；最后对配置密钥本身做兜底替换（任意路径不出现明文）。
 */
function sanitizeBodyText(bodyText: string, apiSecret: string): string {
  let text: string;
  try {
    text = JSON.stringify(sanitizeDebugValue(JSON.parse(bodyText) as unknown, apiSecret)) ?? bodyText;
  } catch {
    text = bodyText.replace(TOKEN_RUN_RE, '…');
  }
  return truncateDebugString(replaceConfiguredSecret(text, apiSecret));
}

/** 配置密钥本体替换原语（maskSecretsInText 与 sanitizeBodyText 共用）。 */
function replaceConfiguredSecret(text: string, apiSecret: string): string {
  return apiSecret.length > 0 ? text.split(apiSecret).join('***') : text;
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
 * download 选项透传给二段取图（P2-1 SSRF 加固面——测试注入 DNS/上限替身）。
 */
export async function callImagesApi(
  settings: ImgApiSettings,
  input: GenerateCallInput,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  download?: SecureDownloadOptions,
): Promise<GenerateCallResult> {
  // P1-5 R3 结构性收口：统一出口脱敏——任何异常 message 离开本模块前必经
  // maskSecretsInText（含 downloadImageData 抛的 ImageApiError——其 message 可能
  // 嵌上游控制的 urlText/Location，逐构造点追堵已被证实会漏）
  const secret = settings.apiKey.trim();
  try {
    return await callImagesApiInner(settings, input, fetchImpl, signal, download);
  } catch (error) {
    if (error instanceof ImageApiError) {
      error.message = maskSecretsInText(error.message, secret);
      throw error;
    }
    throw new ImageApiError(
      maskSecretsInText(
        `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
        secret,
      ),
      'network',
      { endpoint: '(request)', requestBody: {} },
    );
  }
}

async function callImagesApiInner(
  settings: ImgApiSettings,
  input: GenerateCallInput,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  download?: SecureDownloadOptions,
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
      return await readResponse(response, debug, startedAt, fetchImpl, settings.apiKey.trim(), signal, download);
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
    return await readResponse(response, debug, startedAt, fetchImpl, settings.apiKey.trim(), signal, download);
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    throw error; // 网络异常交由外层统一出口脱敏后包装
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
  apiSecret: string,
  signal?: AbortSignal,
  download?: SecureDownloadOptions,
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
  debug.parsedResponse = sanitizeDebugValue(parsed, apiSecret);
  // P1-5：原文不再直接入 debug——JSON 递归脱敏序列化 / 非 JSON 无敏感摘要。
  debug.responseBodyText = sanitizeBodyText(bodyText, apiSecret);

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
    // url 形态：二段取字节（P2-1 SSRF 加固——https only / 拒私网 / 禁跨域重定向 /
    // 流式大小上限 / 传 AbortSignal）
    try {
      const image = await downloadImageData(item.url, {
        debug,
        fetchImpl,
        signal,
        ...download,
      });
      return { image, debug };
    } catch (error) {
      if (error instanceof ImageApiError) throw error;
      throw new ImageApiError(
        `结果图下载失败：${error instanceof Error ? error.message : String(error)}`,
        'network',
        debug,
      );
    }
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

// ---------------------------------------------------------------- 二段取图加固（P2-1）

/** 二段下载大小上限（64MiB——生成产物图量级封顶）。 */
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** 重定向上限（仅同源逐跳复验——跨域直接拒绝）。 */
const DOWNLOAD_MAX_REDIRECTS = 3;

export interface SecureDownloadOptions {
  /** fetch 替身（缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 取消信号（透传到二段 fetch——cancel 即中止下载）。 */
  signal?: AbortSignal;
  /** DNS 解析注入面（测试替身；缺省 node:dns/promises lookup all）。 */
  lookupImpl?: (hostname: string) => Promise<string[]>;
  /** 大小上限注入面（测试替身）。 */
  maxBytes?: number;
  /** 错误携带的 debug 记录（缺省最小占位）。 */
  debug?: ImageTaskDebug;
}

function invalidDownload(debug: ImageTaskDebug | undefined, message: string): ImageApiError {
  return new ImageApiError(message, 'invalid-response', debug ?? { endpoint: '(download)', requestBody: {} });
}

/** 解析结果 IP 是否公网可访问（拒 loopback/link-local/私网/保留/组播/ULA）。 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false; // 保留/私网/环回
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 私网
    if (a === 192 && b === 168) return false; // 私网
    if (a === 192 && b === 0 && (address.startsWith('192.0.2.'))) return false; // TEST-NET-1
    if (a === 198 && (b === 51 || b === 18)) return false; // TEST-NET-2/3 + 198.18 基准
    if (a === 203 && b === 0) return false; // TEST-NET-3
    if (a >= 224) return false; // 组播+保留
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false; // 未指定/环回
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return false; // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // ULA fc00::/7
    if (lower.startsWith('ff')) return false; // 组播
    // IPv4 映射地址 ::ffff:a.b.c.d 按内层 v4 判定
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    return true;
  }
  return false; // 非 IP 字面量由解析路径保证不会到这
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/**
 * 二段取图（P2-1 SSRF 加固）：仅 https；DNS 解析后逐地址拒绝
 * loopback/link-local/私网/保留段；重定向仅同源逐跳复验（跨域拒绝）；流式下载
 * 大小上限；透传 AbortSignal。策略违例抛 invalid-response，网络失败向上冒泡。
 */
export async function downloadImageData(
  urlText: string,
  options: SecureDownloadOptions = {},
): Promise<Uint8Array> {
  const {
    fetchImpl = fetch,
    signal,
    lookupImpl = defaultLookup,
    maxBytes = DOWNLOAD_MAX_BYTES,
    debug,
  } = options;
  let current: URL;
  try {
    current = new URL(urlText);
  } catch {
    throw invalidDownload(debug, `结果图 URL 非法：${urlText.slice(0, 100)}`);
  }
  for (let hop = 0; hop <= DOWNLOAD_MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:') {
      throw invalidDownload(debug, '结果图 URL 仅允许 https。');
    }
    // 主机解析校验：IP 字面量直接判；域名 DNS 解析后逐地址判（任一私网即拒）。
    if (isIP(current.hostname) !== 0) {
      if (!isPublicAddress(current.hostname)) {
        throw invalidDownload(debug, `结果图主机地址被拒绝（非公网）：${current.hostname}`);
      }
    } else {
      let addresses: string[];
      try {
        addresses = await lookupImpl(current.hostname);
      } catch (error) {
        throw new Error(`结果图主机解析失败（${current.hostname}）：${error instanceof Error ? error.message : String(error)}`);
      }
      for (const address of addresses) {
        if (!isPublicAddress(address)) {
          throw invalidDownload(debug, `结果图主机解析到非公网地址（${address}），已拒绝`);
        }
      }
    }
    const response = await fetchImpl(current, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw invalidDownload(debug, `重定向响应缺少 Location（HTTP ${response.status}）`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw invalidDownload(debug, `重定向 Location 非法：${location.slice(0, 100)}`);
      }
      if (next.origin !== current.origin) {
        throw invalidDownload(debug, `跨域重定向被拒绝：${current.origin} → ${next.origin}`);
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      throw new ImageApiError(
        `结果图下载失败 HTTP ${response.status}`,
        httpErrorKind(response.status),
        debug ?? { endpoint: '(download)', requestBody: {} },
        response.status,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw invalidDownload(debug, `结果图超过大小上限（${declared} > ${maxBytes} 字节）`);
    }
    // 流式累计（流式上限——无 content-length 也封顶）
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw invalidDownload(debug, `结果图超过大小上限`);
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw invalidDownload(debug, `结果图超过大小上限（>${maxBytes} 字节）`);
      }
      if (value) chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  throw invalidDownload(debug, `重定向次数超过 ${DOWNLOAD_MAX_REDIRECTS} 上限`);
}
