/**
 * 多路由模型配置存储（照 shufa-server daemon/src/models-store.ts 1:1 移植，
 * 2026-09-28 zhumo 方案移植块 A）：settings 表三个 JSON 键——
 *   models_routes  路由清单（不含密钥）
 *   models_keys    {provider: apiKey}（密钥；任何 RPC 输出面都不回值，只回 hasKey）
 *   models_default {provider, model, effort?}（默认模型；活动模型由前台按任务选择）
 * 贴钻适配（zhumo 同款演进的本地形态）：
 * - 兼容迁移：models_routes 为空且 .env LLM_* 四键齐备（provider/baseURL/model，
 *   zhumo 收编条件同款）时自动收编为一条路由，收编在首次读取时物化落库——
 *   .env 单路由=迁移引导降级为 fallback（Owner 裁决 2026-09-28）；物化路由带
 *   存储态 legacy 标记（不出 RPC 输出面），用户首次编辑保存后标记消失、
 *   settings 表成为唯一真源（.env 不再被读）。
 * - 旧链的 LLM_API 协议值收编归一：贴钻 W4.1 冻结 openai-completions——未知/
 *   空值回落 openai-completions（与 resolveSingleRoute 缺省一致）；anthropic
 *   双系值照放行（多路由面全协议开放——UI 协议 select 三档）。
 */
import type {
  ModelRouteInfo,
  ModelsDefault,
  ModelsModel,
  ModelsRoute,
  ModelsRouteView,
  ModelsSaveInput,
  RouteApi,
} from '@handicraft/contracts';
import type { BridgedRoute, ModelRoutesBundle } from './kernel/model-route.js';
import type { LlmConfig } from './config.js';
import type { SqliteDb } from './db/database.js';
import { getSetting, putSetting } from './db/store.js';

const KEY_ROUTES = 'models_routes';
const KEY_KEYS = 'models_keys';
const KEY_DEFAULT = 'models_default';

/** 存储态路由（密钥分离存 models_keys；legacy=迁移收编标记，存储态私有）。 */
export interface StoredRoute extends Omit<ModelsRoute, 'models'> {
  models: ModelsModel[];
  legacy?: true;
}

/** 读面：路由视图（hasKey 投影；legacy 标记剥离不进输出面）+ 默认模型。 */
export function loadModelsConfig(db: SqliteDb, llm: LlmConfig): {
  routes: ModelsRouteView[];
  default: ModelsDefault | null;
} {
  const routes = loadRoutes(db, llm);
  const keys = loadKeys(db);
  return {
    routes: routes.map((route) => ({
      provider: route.provider,
      api: route.api,
      baseURL: route.baseURL,
      ...(route.iconUrl !== undefined ? { iconUrl: route.iconUrl } : {}),
      models: route.models,
      hasKey: Boolean(keys[route.provider]),
    })),
    default: loadDefault(db, routes),
  };
}

/** 路由清单（含 .env 迁移收编物化——zhumo「首次读取时物化落库」同款）。 */
export function loadRoutes(db: SqliteDb, llm: LlmConfig): StoredRoute[] {
  const routes = parseJson(getSetting(db, KEY_ROUTES), []);
  if (routes.length > 0) return routes;
  // 迁移：.env LLM_* 引导链齐备 → 收编物化（key 一并落 models_keys，旧数据不丢）。
  const legacy = legacyRoute(llm);
  if (legacy) {
    putSetting(db, KEY_ROUTES, JSON.stringify([legacy]));
    putSetting(db, KEY_KEYS, JSON.stringify({ [legacy.provider]: llm.apiKey.trim() }));
    putSetting(db, KEY_DEFAULT, JSON.stringify({ provider: legacy.provider, model: legacy.models[0]!.id }));
    return [legacy];
  }
  return [];
}

/** 密钥表（仅 daemon 内部使用；不经 RPC 出参）。 */
export function loadKeys(db: SqliteDb): Record<string, string> {
  return parseJson(getSetting(db, KEY_KEYS), {});
}

/** 后台默认思考强度档算法（zhumo Owner 2026-09-28 同式）：管理员未配置时按
 * efforts 顺序取下标 ceil(N/2)（3 档→下标 2 即第三档；1 档边界收 0）。返回
 * undefined = 无目录/空目录（不传，内核自选）。 */
export function resolveDefaultEffort(efforts: string[] | undefined): string | undefined {
  if (efforts === undefined || efforts.length === 0) return undefined;
  return efforts[Math.min(Math.ceil(efforts.length / 2), efforts.length - 1)];
}

export function loadDefault(db: SqliteDb, routes?: StoredRoute[]): ModelsDefault | null {
  const value = parseJson<ModelsDefault | null>(getSetting(db, KEY_DEFAULT), null);
  const list = routes ?? [];
  if (!value) return null;
  const route = list.find((candidate) => candidate.provider === value.provider);
  if (!route) return null;
  // effort 悬空防御（zhumo 2026-09-28 同款）：目录升级/模型变更可能让已存默认
  // 档不在该模型 efforts 内——丢弃该字段回落「内核自选」，不让无效档进内核。
  if (value.effort != null) {
    const entry = route.models.find((candidate) => candidate.id === value.model);
    const efforts = entry?.efforts;
    if (!efforts || !efforts.includes(value.effort)) {
      const { effort: _drop, ...rest } = value;
      return rest;
    }
  }
  return value;
}

/**
 * 写面：routes/default 整体覆盖；apiKey 空串/缺省 = 保留旧密钥，非空 = 更新；
 * 路由被删时对应密钥一并清（不留无主密钥）。保存后 settings 表即唯一真源
 * （.env fallback 不再命中——models_routes 已有内容）。
 */
export function saveModelsConfig(db: SqliteDb, input: ModelsSaveInput): void {
  const previousKeys = loadKeys(db);
  const keys: Record<string, string> = {};
  const routes: StoredRoute[] = [];
  for (const route of input.routes) {
    const { apiKey, ...rest } = route;
    routes.push(rest);
    if (apiKey !== undefined && apiKey.length > 0) keys[route.provider] = apiKey;
    else if (previousKeys[route.provider]) keys[route.provider] = previousKeys[route.provider]!;
  }
  putSetting(db, KEY_ROUTES, JSON.stringify(routes));
  putSetting(db, KEY_KEYS, JSON.stringify(keys));
  // default 校验：必须指向存在路由（防悬空引用）；effort 必须在该模型
  // efforts 目录内（默认强度档；无目录视为无效一并丢弃）。
  let valid: ModelsDefault | null = null;
  if (input.default) {
    const route = routes.find((candidate) => candidate.provider === input.default!.provider);
    if (route) {
      const { effort, ...rest } = input.default;
      if (effort != null && effort !== '') {
        const entry = route.models.find((candidate) => candidate.id === input.default!.model);
        if (entry?.efforts?.includes(effort)) valid = { ...rest, effort };
        else
          throw new Error(
            `默认强度档不在默认模型 efforts 内：${effort}（${input.default.model} 目录：${entry?.efforts?.join('、') ?? '无'}）`,
          );
      } else {
        valid = rest;
      }
    }
  }
  putSetting(db, KEY_DEFAULT, JSON.stringify(valid));
}

/** 按 (provider, model) 取完整路由（含该模型的 contextWindow；缺省 128k）。 */
export function resolveRouteFor(
  db: SqliteDb,
  llm: LlmConfig,
  provider: string,
  model: string,
): {
  provider: string;
  api: string;
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindow: number;
} | null {
  const route = loadRoutes(db, llm).find((candidate) => candidate.provider === provider);
  const key = loadKeys(db)[provider] ?? '';
  if (!route || !key) return null;
  const entry = route.models.find((candidate) => candidate.id === model);
  if (!entry) return null;
  return {
    provider: route.provider,
    api: route.api,
    baseURL: route.baseURL,
    apiKey: key,
    model: entry.id,
    contextWindow: entry.contextWindow ?? 131072,
  };
}

/**
 * boot 桥接载荷（贴钻 ModelRoutesBundle 形——zhumo buildRoutesBundle 同款投影）：
 * 全量路由（多模型 + 密钥）+ 默认模型。efforts 档不进 bundle（贴钻内核桥接面
 * settings.yaml 的模型条目只携带 id/contextWindow——effort 消费面属后续波）。
 */
export function buildRoutesBundle(db: SqliteDb, llm: LlmConfig): ModelRoutesBundle {
  const routes = loadRoutes(db, llm);
  const keys = loadKeys(db);
  return {
    routes: routes
      .filter((route) => Boolean(keys[route.provider]))
      .map(
        (route): BridgedRoute => ({
          provider: route.provider,
          api: route.api,
          baseURL: route.baseURL,
          apiKey: keys[route.provider]!,
          models: route.models.map((model) => ({
            id: model.id,
            ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
          })),
        }),
      ),
    default: loadDefault(db, routes),
  };
}

/**
 * 生效路由信息（bootstrap.modelRoute 投影，zhumo modelsRouteInfo 同款语义）：
 * 多路由真源（models_routes）有内容 → source 'settings'（default 优先，缺省取
 * 首路由首模型）；唯一路由且带迁移收编 legacy 标记 = 'env'（.env 引导值——
 * 用户尚未在后台编辑保存）；都无 → null（「未配置」）。
 */
export function modelsRouteInfo(db: SqliteDb, llm: LlmConfig): ModelRouteInfo | null {
  const routes = loadRoutes(db, llm);
  if (routes.length === 0) return null;
  const first = routes[0]!;
  const def = loadDefault(db, routes);
  const provider = def?.provider ?? first.provider;
  const model = def?.model ?? first.models.find((entry) => entry.id)?.id ?? first.models[0]?.id ?? '';
  // 唯一路由 + 迁移标记 = .env 引导链投影（用户在 UI 保存后标记即消失）。
  const fromEnv = routes.length === 1 && first.legacy === true;
  return { provider, model, source: fromEnv ? 'env' : 'settings' };
}

// ---------------------------------------------------------------- 内部工具

/** .env LLM_* 单路由收编（zhumo legacyRoute 同款条件：provider/baseURL/model 齐备）。 */
function legacyRoute(llm: LlmConfig): (StoredRoute & { legacy: true }) | null {
  const provider = llm.provider.trim();
  const baseURL = llm.baseUrl.trim();
  const model = llm.model.trim();
  if (!provider || !baseURL || !model) return null;
  return { provider, api: normalizeApi(llm.api.trim()), baseURL, models: [{ id: model }], legacy: true };
}

/** 旧数据协议值收编归一（未知/空回落 openai-completions——贴钻 W4.1 缺省一致）。 */
function normalizeApi(api: string): RouteApi {
  if (api === 'anthropic-messages' || api === 'openai-responses' || api === 'openai-completions') {
    return api;
  }
  return 'openai-completions';
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback; // 坏 JSON 按空处理（下次保存覆盖）。
  }
}
