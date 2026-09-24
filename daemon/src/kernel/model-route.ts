/**
 * 模型路由桥（照 shufa-server kernel/model-route.ts 移植——其上游=
 * skill-creator-v2 steward/dsh-settings 双层桥语义；W4.1 贴钻适配）。
 * 原始需求 2026-09-23（Owner 调度裁决）：z.ai 网关 `https://api.z.ai/api/paas/v4`、
 * 协议**必须 openai-completions**（shufa-server 实证：Z.ai /api/paas/v4 只讲
 * OpenAI 协议）、模型 `glm-5.3-flash`、key 走 LLM_API_KEY env（绝不入库不入
 * git——.credentials.yaml 落 DSH_HOME（DATA_ROOT 内），0600，不进仓库）。
 * 桥接面：
 *   settings.yaml   llm-pi-ai.providers 全量路由（model 条目带 contextWindow）
 *                   + agent-default-model {provider, model}（默认模型）
 *   .credentials.yaml version-1 refs 全量密钥（顶层平铺会打挂 boot）。
 * 密钥值只以 apiKeyEnv 引用/refs 落盘，settings.yaml 不含明文。
 * W4.1 适配：多路由真源（settings 表 models_*）归后续波；本波单路由=.env
 * LLM_*（resolveSingleRoute，z.ai 缺省+openai-completions 强制——其他协议值
 * 显式拒绝，防网关协议误配静默劣化）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { LlmConfig } from '../config.js';

export interface StudioModelRoute {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** wire 协议（W4.1 冻结 openai-completions——z.ai 网关实证协议）。 */
  api: string;
  contextWindow: number;
}

/** 桥接路由（多模型）：一条 provider 路由携带全部模型条目。 */
export interface BridgedRoute {
  provider: string;
  api: string;
  baseURL: string;
  apiKey: string;
  models: Array<{ id: string; contextWindow?: number }>;
}

/** 多路由桥接载荷（boot 用）：全量路由 + 默认模型。 */
export interface ModelRoutesBundle {
  routes: BridgedRoute[];
  default: { provider: string; model: string } | null;
}

/** z.ai 网关缺省（Owner 2026-09-23 裁决）。 */
export const DEFAULT_LLM_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const DEFAULT_LLM_MODEL = 'glm-5.3-flash';
export const DEFAULT_LLM_PROVIDER = 'zai';
export const DEFAULT_LLM_CONTEXT_WINDOW = 131072;

/** 已知 provider → 官方惯例 env 名；其余 provider 走 <UPPER>_API_KEY。 */
const ROUTE_API_KEY_ENVS: Readonly<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  'google-vertex': 'GOOGLE_GENERATIVE_AI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
};

export function apiKeyEnvFor(provider: string): string {
  return ROUTE_API_KEY_ENVS[provider] ?? `${provider.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
}

/**
 * W4.1 单路由解析（.env LLM_*；key 缺失 = null——内核以缺省路由运行，agent
 * 调用将在请求期报 MISSING_CREDENTIAL，不静默伪造连接）。协议仅
 * openai-completions（显式配置其他值=配置错误，抛错进降级态③）。
 */
export function resolveSingleRoute(llm: LlmConfig): StudioModelRoute | null {
  const apiKey = llm.apiKey.trim();
  if (!apiKey) return null;
  const api = llm.api.trim() || 'openai-completions';
  if (api !== 'openai-completions') {
    throw new Error(`不支持的 LLM_API=${api}（W4.1 仅 openai-completions——z.ai 网关实证协议）`);
  }
  return {
    provider: llm.provider.trim() || DEFAULT_LLM_PROVIDER,
    baseURL: llm.baseUrl.trim() || DEFAULT_LLM_BASE_URL,
    apiKey,
    model: llm.model.trim() || DEFAULT_LLM_MODEL,
    api,
    contextWindow: DEFAULT_LLM_CONTEXT_WINDOW,
  };
}

/** 单路由 → 多路由桥接载荷（boot 用——W4.2 多路由真源接入后此函数退役）。 */
export function singleRouteBundle(route: StudioModelRoute): ModelRoutesBundle {
  return {
    routes: [
      {
        provider: route.provider,
        api: route.api,
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        models: [{ id: route.model, contextWindow: route.contextWindow }],
      },
    ],
    default: { provider: route.provider, model: route.model },
  };
}

/** settings.yaml 同步：providers 全量 + agent-default-model（整段重写，行热加载）。 */
export function syncModelRoutesSettings(dshHome: string, bundle: ModelRoutesBundle): void {
  const file = path.join(dshHome, 'settings.yaml');
  const doc = readYamlObject(file);
  const providers: Record<string, unknown> = {};
  for (const route of bundle.routes) {
    const models = route.models.map((entry) => ({
      id: entry.id,
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    }));
    // 默认模型不在清单（悬空防御）时补一条。
    if (bundle.default?.provider === route.provider) {
      const has = route.models.some((entry) => entry.id === bundle.default!.model);
      if (!has) models.push({ id: bundle.default.model });
    }
    providers[route.provider] = {
      apiKeyEnv: apiKeyEnvFor(route.provider),
      api: route.api,
      baseURL: route.baseURL,
      models,
    };
  }
  doc['llm-pi-ai'] = { providers };
  if (bundle.default) {
    doc['agent-default-model'] = { provider: bundle.default.provider, model: bundle.default.model };
  } else {
    delete doc['agent-default-model'];
  }
  writeYamlFile(file, doc);
}

/** .credentials.yaml 同步：version-1 refs 全量密钥。 */
export function syncModelRoutesCredentials(
  dshHome: string,
  routes: Array<{ provider: string; apiKey: string }>,
): void {
  const file = path.join(dshHome, '.credentials.yaml');
  const doc = readYamlObject(file);
  const refs = isRecord(doc.refs) ? doc.refs : {};
  for (const route of routes) {
    if (route.apiKey) refs[apiKeyEnvFor(route.provider)] = route.apiKey;
  }
  doc.version = 1;
  doc.refs = refs;
  writeYamlFile(file, doc);
}

/** boot 时注入全部密钥 env（dispose 时以返回的还原函数恢复）。 */
export function injectApiKeysEnv(routes: Array<{ provider: string; apiKey: string }>): () => void {
  const restores: Array<() => void> = [];
  for (const route of routes) {
    if (!route.apiKey) continue;
    const key = apiKeyEnvFor(route.provider);
    const previous = process.env[key];
    process.env[key] = route.apiKey;
    restores.push(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  return () => restores.forEach((restore) => restore());
}

// ---------------------------------------------------------------- 内部工具

function readYamlObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = parseYaml(readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {}; // 坏 YAML：以空文档起步（首写重建）。
  }
}

function writeYamlFile(file: string, doc: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stringifyYaml(doc), { encoding: 'utf8', mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
