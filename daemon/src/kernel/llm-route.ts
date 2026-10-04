/**
 * LLM 路由解析+三协议线面公共模块（W5 走查 P1-3 收口，2026-09-28）。
 * 原始需求：strategy.design 文本路由 env-only（resolveSingleRoute 直连）——后台配好
 * 模型仍 llm-route-unconfigured；复刻 scene-analyze 的 resolveVisionLlmRoute 模式
 * （split-admin-portal 2.5）抽公共单源：settings 真源优先+三协议适配+.env 迁移引导
 * 回退+warning。视觉（scene.analyze 通道 B）与文本（strategy.design S6）两调用面
 * 共用本模块；视觉图像块构造（buildVisionLlmWireRequest）仍留 scene-analyze（面专属）。
 * 纪律：LLM key 只走 env→settings（models-store），不入库不入留存。
 */
import type { LlmConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import { resolveSingleRoute, type StudioModelRoute } from './model-route.js';
import { loadDefault, loadKeys, loadRoutes, modelsSettingsInitialized } from '../models-store.js';

/** 路由解析结果（settings=后台多路由真源；env=.env LLM_* 迁移引导回退）。 */
export interface ResolvedLlmRoute extends StudioModelRoute {
  /** 路由来源（settings=后台多路由真源；env=.env LLM_* 迁移引导回退）。 */
  source: 'settings' | 'env';
}

/**
 * 路由真源统一（settings 优先；env 仅迁移引导回退——split-admin-portal 2.5 语义）：
 * 后台模型路由（settings 表 models_*，loadRoutes 含 .env 迁移收编物化）优先；
 * settings 从未初始化且 .env LLM_* 完整时回退旧单路由链（明确 warning——迁移引导
 * 语义）。已初始化的空路由集=「未配置」真源意图，.env 不复活（v6 P1-3）。
 * 坏协议配置（.env LLM_API 非法值）=配置错误，resolveSingleRoute 原样上抛。
 * purpose=调用面标签（回退 warning 的日志前缀，如 'scene.analyze'/'strategy.design'）。
 */
export function resolveLlmRoute(db: SqliteDb, llm: LlmConfig, purpose: string): ResolvedLlmRoute | null {
  const routes = loadRoutes(db, llm);
  const keys = loadKeys(db);
  // D2（2026-10-04）：openai-image-edit=参考图层生成专用通道（resolveImageEditRoute
  // 单源消费），非对话协议——对话路由解析一律排除（防其被选为 host 后 wire 构造抛错）。
  const keyed = routes
    .filter((route) => route.api !== 'openai-image-edit')
    .filter((route) => Boolean(keys[route.provider]));
  if (keyed.length > 0) {
    const def = loadDefault(db, routes);
    const host = keyed.find((route) => route.provider === def?.provider) ?? keyed[0]!;
    const model =
      def !== null && host.models.some((entry) => entry.id === def.model)
        ? def.model
        : host.models[0]?.id ?? '';
    return {
      provider: host.provider,
      api: host.api,
      baseURL: host.baseURL,
      apiKey: keys[host.provider]!,
      model,
      contextWindow: host.models.find((entry) => entry.id === model)?.contextWindow ?? 131072,
      source: 'settings',
    };
  }
  if (modelsSettingsInitialized(db)) return null; // 已初始化（含显式清空）——env 不复活
  const legacy = resolveSingleRoute(llm);
  if (legacy !== null) {
    console.warn(
      `[${purpose}] settings 无可用模型路由——回退 .env LLM_* 单路由（迁移引导；后台保存模型配置后以 settings 为真源）`,
    );
    return { ...legacy, source: 'env' };
  }
  return null;
}

// ---------------------------------------------------------------- 三协议线面

/** LLM 调用线请求（协议适配产物——url/headers/body 一次成型，fetch 只管发送）。 */
export interface LlmWireRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 三协议纯文本请求构造（openai-completions / anthropic-messages / openai-responses
 * ——与后台 models 三协议值域一致；图像块变体见 scene-analyze buildVisionLlmWireRequest）。
 * 未知协议抛错（配置错误面）。
 */
export function buildTextLlmWireRequest(
  route: Pick<StudioModelRoute, 'baseURL' | 'apiKey' | 'api'>,
  model: string,
  promptText: string,
  maxTokens: number,
): LlmWireRequest {
  const base = route.baseURL.trim().replace(/\/+$/, '');
  switch (route.api) {
    case 'anthropic-messages':
      return {
        url: `${base}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': route.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
        }),
      };
    case 'openai-responses':
      return {
        url: `${base}/responses`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({
          model,
          input: [{ role: 'user', content: [{ type: 'input_text', text: promptText }] }],
          temperature: 0,
          max_output_tokens: maxTokens,
        }),
      };
    case 'openai-completions':
      return {
        url: `${base}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: promptText }],
          temperature: 0,
          max_tokens: maxTokens,
          stream: false,
        }),
      };
    default:
      throw new Error(`不支持的路由协议：${route.api}（openai-completions / anthropic-messages / openai-responses）`);
  }
}

// ---------------------------------------------------------------- 三协议响应抽取

/** openai-completions 响应体 → 文本 content（string 直取；parts 数组拼 text 段）。 */
function extractOpenaiContentText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
          ? (part as { text?: unknown }).text
          : undefined,
      )
      .filter((piece): piece is string => typeof piece === 'string');
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

/** anthropic-messages 响应体 → 文本（content[] 的 text 块拼接）。 */
function extractAnthropicContentText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((piece): piece is string => typeof piece === 'string');
  return parts.length > 0 ? parts.join('\n') : null;
}

/** openai-responses 响应体 → 文本（output_text 直取，否则 output[].content[].output_text 拼接）。 */
function extractResponsesContentText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const direct = (body as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'output_text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** 三协议响应体 → 文本 content（协议适配面——split-admin-portal 2.5）。 */
export function extractLlmContentText(api: string, body: unknown): string | null {
  switch (api) {
    case 'anthropic-messages':
      return extractAnthropicContentText(body);
    case 'openai-responses':
      return extractResponsesContentText(body);
    default:
      return extractOpenaiContentText(body);
  }
}
