/**
 * models-store 单测（zhumo 方案移植块 A 任务门）：多路由真源化（settings 表三键）、
 * .env 单路由迁移收编物化（legacy 标记/source 投影）、saveModelsConfig 密钥保留
 * 语义（空=保留/非空=更新/删路由清密钥）、default 悬空防御与 effort 目录校验、
 * buildRoutesBundle 桥接投影、modelsRouteInfo 来源透明度。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from './db/database.js';
import { putSetting } from './db/store.js';
import type { LlmConfig } from './config.js';
import {
  buildRoutesBundle,
  loadDefault,
  loadKeys,
  loadModelsConfig,
  loadRoutes,
  modelsRouteInfo,
  modelsSettingsInitialized,
  resolveDefaultEffort,
  resolveRouteFor,
  saveModelsConfig,
} from './models-store.js';

const dirs: string[] = [];
function tempDb(): SqliteDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'handicraft-models-'));
  dirs.push(dir);
  return openDatabase(dir);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function llm(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: '',
    baseUrl: '',
    apiKey: '',
    model: '',
    api: '',
    visionModel: '',
    ...overrides,
  };
}

describe('.env LLM_* 迁移收编（fallback → 真源物化）', () => {
  it('四键齐备：首次读取物化一条 legacy 路由（key 一并落 models_keys）', () => {
    const db = tempDb();
    const env = llm({
      provider: 'zai',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      apiKey: 'sk-env',
      model: 'glm-5.3-flash',
    });
    const routes = loadRoutes(db, env);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      provider: 'zai',
      baseURL: 'https://api.z.ai/api/paas/v4',
      api: 'openai-completions',
      legacy: true,
    });
    expect(routes[0]!.models[0]!.id).toBe('glm-5.3-flash');
    // 物化落库（第二次读不依赖 .env——settings 真源化）
    expect(loadKeys(db)).toEqual({ zai: 'sk-env' });
    // 缺 .env 后仍能读回（真源已物化）
    const again = loadRoutes(db, llm());
    expect(again).toHaveLength(1);
    expect(again[0]!.provider).toBe('zai');
    // 旧链协议值归一：空/未知回落 openai-completions；anthropic 放行
    const anthropic = loadRoutes(tempDb(), llm({ provider: 'p', baseUrl: 'https://x', apiKey: 'k', model: 'm', api: 'anthropic-messages' }));
    expect(anthropic[0]!.api).toBe('anthropic-messages');
  });

  it('键不齐备不收编；modelsRouteInfo 语义（legacy=env，保存后=settings）', () => {
    const db = tempDb();
    expect(loadRoutes(db, llm({ provider: 'zai', baseUrl: 'https://x', apiKey: 'k' }))).toHaveLength(0);
    expect(modelsRouteInfo(db, llm())).toBeNull();

    const env = llm({ provider: 'zai', baseUrl: 'https://x', apiKey: 'k', model: 'glm' });
    expect(modelsRouteInfo(db, env)).toEqual({
      provider: 'zai',
      model: 'glm',
      source: 'env',
    });
    // 用户在 UI 保存（全量落库——legacy 标记消失，真源化）
    saveModelsConfig(db, {
      routes: [{ provider: 'zai', api: 'openai-completions', baseURL: 'https://x', models: [{ id: 'glm' }] }],
      default: { provider: 'zai', model: 'glm' },
    });
    expect(modelsRouteInfo(db, env)).toEqual({
      provider: 'zai',
      model: 'glm',
      source: 'settings',
    });
  });

  it('缺 apiKey 不迁移（v6 复核 P1-3：四键齐备才收编——无 key 路由不得物化）', () => {
    const db = tempDb();
    // provider/baseURL/model 在场、apiKey 空：零物化、零标记（后续补 key 仍可迁移）
    const noKey = llm({ provider: 'zai', baseUrl: 'https://x', model: 'glm' });
    expect(loadRoutes(db, noKey)).toHaveLength(0);
    expect(modelsSettingsInitialized(db)).toBe(false);
    expect(loadKeys(db)).toEqual({});
    expect(modelsRouteInfo(db, noKey)).toBeNull();
  });
});

describe('迁移终局标记（v6 复核 P1-3——空路由不得被 .env fallback 复活）', () => {
  it('首次 env 迁移 → 保存空路由 → 重读（含 .env 在场）恒为空', () => {
    const db = tempDb();
    const env = llm({ provider: 'zai', baseUrl: 'https://x', apiKey: 'sk-env', model: 'glm' });
    // 首次读取：.env 收编物化 + 终局标记（首次迁移即初始化）
    expect(loadRoutes(db, env)).toHaveLength(1);
    expect(modelsSettingsInitialized(db)).toBe(true);
    // 用户在 UI 删除全部路由并保存（空集=显式「未配置」意图）
    saveModelsConfig(db, { routes: [], default: null });
    expect(modelsSettingsInitialized(db)).toBe(true);
    // 重读（.env 仍在场）：不复活——settings 真源恒空
    expect(loadRoutes(db, env)).toEqual([]);
    expect(loadModelsConfig(db, env).routes).toEqual([]);
    expect(modelsRouteInfo(db, env)).toBeNull(); // 「未配置」而非 env 来源
    expect(buildRoutesBundle(db, env).routes).toEqual([]);
    expect(resolveRouteFor(db, env, 'zai', 'glm')).toBeNull();
  });

  it('未初始化库（无迁移发生）不落标记——.env 引导面保留', () => {
    const db = tempDb();
    // 无 .env 四键、无保存：库未初始化，后续 .env 配置仍可首次迁移
    expect(loadRoutes(db, llm())).toEqual([]);
    expect(modelsSettingsInitialized(db)).toBe(false);
    const env = llm({ provider: 'zai', baseUrl: 'https://x', apiKey: 'sk-env', model: 'glm' });
    expect(loadRoutes(db, env)).toHaveLength(1); // 引导迁移仍可用
  });
});

describe('saveModelsConfig 写面', () => {
  it('apiKey 空=保留旧密钥；非空=更新；删路由清密钥（不留无主密钥）', () => {
    const db = tempDb();
    saveModelsConfig(db, {
      routes: [
        { provider: 'a', api: 'openai-completions', baseURL: 'https://a', apiKey: 'sk-a', models: [{ id: 'm1' }] },
        { provider: 'b', api: 'anthropic-messages', baseURL: 'https://b', apiKey: 'sk-b', models: [{ id: 'm2' }] },
      ],
      default: { provider: 'a', model: 'm1' },
    });
    expect(loadKeys(db)).toEqual({ a: 'sk-a', b: 'sk-b' });

    // a 不带 key（=保留）、b 换 key、c 新增；b 保留但路由消失场景在下一条
    saveModelsConfig(db, {
      routes: [
        { provider: 'a', api: 'openai-completions', baseURL: 'https://a2', models: [{ id: 'm1' }] },
        { provider: 'b', api: 'anthropic-messages', baseURL: 'https://b', apiKey: 'sk-b2', models: [{ id: 'm2' }] },
      ],
      default: null,
    });
    expect(loadKeys(db)).toEqual({ a: 'sk-a', b: 'sk-b2' });

    // 删 b：其密钥一并清
    saveModelsConfig(db, {
      routes: [{ provider: 'a', api: 'openai-completions', baseURL: 'https://a2', models: [{ id: 'm1' }] }],
      default: null,
    });
    expect(loadKeys(db)).toEqual({ a: 'sk-a' });
  });

  it('default 悬空防御：路由消失置 null；effort 不在目录内剥除', () => {
    const db = tempDb();
    saveModelsConfig(db, {
      routes: [{ provider: 'a', api: 'openai-completions', baseURL: 'https://a', models: [{ id: 'm1', efforts: ['low', 'high'] }] }],
      default: { provider: 'a', model: 'm1', effort: 'high' },
    });
    expect(loadDefault(db, loadRoutes(db, llm()))).toEqual({ provider: 'a', model: 'm1', effort: 'high' });

    // 保存面：default.effort 不在（新）目录内 → 抛错（saveModelsConfig 校验门）
    expect(() =>
      saveModelsConfig(db, {
        routes: [{ provider: 'a', api: 'openai-completions', baseURL: 'https://a', models: [{ id: 'm1', efforts: ['low'] }] }],
        default: { provider: 'a', model: 'm1', effort: 'high' },
      }),
    ).toThrow(/默认强度档不在默认模型 efforts 内/);

    // 读面剥除（悬空防御——手工态/旧数据模拟：default 带 high 而目录已无）
    putSetting(db, 'models_default', JSON.stringify({ provider: 'a', model: 'm1', effort: 'high' }));
    expect(loadDefault(db, loadRoutes(db, llm()))).toEqual({ provider: 'a', model: 'm1' });

    // default 指向已删路由 → 置 null（防悬空引用）
    saveModelsConfig(db, {
      routes: [{ provider: 'a', api: 'openai-completions', baseURL: 'https://a', models: [{ id: 'm1' }] }],
      default: { provider: 'gone', model: 'x' },
    });
    expect(loadDefault(db, loadRoutes(db, llm()))).toBeNull();
  });
});

describe('读面与桥接投影', () => {
  it('loadModelsConfig：hasKey 投影 + legacy 标记不出输出面', () => {
    const db = tempDb();
    const env = llm({ provider: 'zai', baseUrl: 'https://x', apiKey: 'k', model: 'glm' });
    const out = loadModelsConfig(db, env);
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0]).toMatchObject({ provider: 'zai', hasKey: true });
    expect('legacy' in out.routes[0]).toBe(false);
    expect(out.default).toEqual({ provider: 'zai', model: 'glm' });
  });

  it('buildRoutesBundle：仅含带密钥路由；default 优先投影', () => {
    const db = tempDb();
    saveModelsConfig(db, {
      routes: [
        { provider: 'a', api: 'openai-completions', baseURL: 'https://a', apiKey: 'sk-a', models: [{ id: 'm1', contextWindow: 65536 }, { id: 'm2' }] },
        { provider: 'nokey', api: 'openai-completions', baseURL: 'https://n', models: [{ id: 'x' }] },
      ],
      default: { provider: 'a', model: 'm2' },
    });
    const bundle = buildRoutesBundle(db, llm());
    expect(bundle.routes).toHaveLength(1); // 无密钥路由不进内核桥接
    expect(bundle.routes[0]).toMatchObject({ provider: 'a', apiKey: 'sk-a' });
    expect(bundle.routes[0]!.models).toEqual([{ id: 'm1', contextWindow: 65536 }, { id: 'm2' }]);
    expect(bundle.default).toEqual({ provider: 'a', model: 'm2' });
  });

  it('resolveRouteFor：(provider, model) 精确解析 + contextWindow 缺省 128k', () => {
    const db = tempDb();
    saveModelsConfig(db, {
      routes: [{ provider: 'a', api: 'anthropic-messages', baseURL: 'https://a', apiKey: 'sk-a', models: [{ id: 'm1', contextWindow: 65536 }, { id: 'm2' }] }],
      default: null,
    });
    expect(resolveRouteFor(db, llm(), 'a', 'm1')).toMatchObject({
      provider: 'a',
      model: 'm1',
      contextWindow: 65536,
      apiKey: 'sk-a',
    });
    expect(resolveRouteFor(db, llm(), 'a', 'm2')?.contextWindow).toBe(131072);
    expect(resolveRouteFor(db, llm(), 'a', 'missing')).toBeNull();
    expect(resolveRouteFor(db, llm(), 'missing', 'm1')).toBeNull();
  });

  it('resolveDefaultEffort：目录 ceil(N/2) 档；空/缺省 undefined', () => {
    expect(resolveDefaultEffort(undefined)).toBeUndefined();
    expect(resolveDefaultEffort([])).toBeUndefined();
    expect(resolveDefaultEffort(['low', 'high', 'max'])).toBe('max'); // 3 档→下标 2
    expect(resolveDefaultEffort(['low', 'medium', 'high', 'xhigh'])).toBe('high'); // 4 档→下标 2
    expect(resolveDefaultEffort(['only'])).toBe('only'); // 1 档边界收 0
  });
});
