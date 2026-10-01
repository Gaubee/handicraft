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
import { deleteSetting, getSetting, putSetting } from './db/store.js';
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

describe('marker 损伤 fail-open 收口（v6 终评边界1——models_* 数据在场=已初始化不可伪造证据）', () => {
  // 场景基座：用户已保存路由（settings 真源化+marker 落库）后 marker 被外部手删/
  // 改损——.env 四键仍在的旧环境不得借机重新物化 legacy 路由。
  const env = llm({ provider: 'zai', baseUrl: 'https://x', apiKey: 'sk-env', model: 'glm-env' });

  function damagedMarkerDb(damage: (db: SqliteDb) => void): SqliteDb {
    const db = tempDb();
    saveModelsConfig(db, {
      routes: [{ provider: 'real', api: 'openai-completions', baseURL: 'https://real', apiKey: 'sk-real', models: [{ id: 'm-real' }] }],
      default: { provider: 'real', model: 'm-real' },
    });
    expect(modelsSettingsInitialized(db)).toBe(true); // 基座：marker 在场
    damage(db);
    return db;
  }

  it('①marker 手删（routes 在场）→ loadRoutes 不重新物化 legacy、source 仍 settings', () => {
    const db = damagedMarkerDb((d) => deleteSetting(d, 'models_initialized'));
    const routes = loadRoutes(db, env);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.provider).toBe('real'); // settings 路由原样
    expect(routes[0]!.legacy).toBeUndefined(); // 零 legacy 复活
    expect(modelsRouteInfo(db, env)).toEqual({ provider: 'real', model: 'm-real', source: 'settings' });
    expect(getSetting(db, 'models_routes')).toContain('real'); // 真源未被 env 物化覆盖
    expect(modelsSettingsInitialized(db)).toBe(true); // routes 在场=已初始化证据
  });

  it('②marker 改损为非 1（routes 在场）→ 同上：legacy 不复活', () => {
    const db = damagedMarkerDb((d) => putSetting(d, 'models_initialized', 'corrupt'));
    const routes = loadRoutes(db, env);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.provider).toBe('real');
    expect(routes[0]!.legacy).toBeUndefined();
    expect(modelsRouteInfo(db, env)?.source).toBe('settings');
    expect(modelsSettingsInitialized(db)).toBe(true);
  });

  it('②b marker 改损但仅 keys/default 在场（routes 空）→ 仍判定已初始化（fallback 阻断）', () => {
    // saveModelsConfig 保存空路由集会清空 keys/default——手工构造「marker 损伤+余键在场」：
    // keys 表残留（如保存空集前旧密钥行被外部半删场景）同样是已初始化证据。
    const db = tempDb();
    putSetting(db, 'models_routes', JSON.stringify([]));
    putSetting(db, 'models_keys', JSON.stringify({ real: 'sk-real' }));
    putSetting(db, 'models_initialized', 'corrupt');
    expect(modelsSettingsInitialized(db)).toBe(true);
    expect(loadRoutes(db, env)).toEqual([]); // 不回 env 迁移
    expect(loadModelsConfig(db, env).routes).toEqual([]);
    // default 在场同款（routes/keys 清空、仅 default 残留）
    const db2 = tempDb();
    putSetting(db2, 'models_default', JSON.stringify({ provider: 'real', model: 'm' }));
    expect(modelsSettingsInitialized(db2)).toBe(true);
  });

  it('③marker+全部 models_* 键全删 → 回 env fallback（等价显式 reset 语义）', () => {
    const db = damagedMarkerDb((d) => {
      deleteSetting(d, 'models_initialized');
      deleteSetting(d, 'models_routes');
      deleteSetting(d, 'models_keys');
      deleteSetting(d, 'models_default');
    });
    expect(modelsSettingsInitialized(db)).toBe(false);
    const routes = loadRoutes(db, env);
    expect(routes).toHaveLength(1); // 等价 reset——env 迁移是合理恢复
    expect(routes[0]).toMatchObject({ provider: 'zai', legacy: true });
  });

  it('④marker 在场+空 routes → 不 fallback（既有回归保持）', () => {
    const db = tempDb();
    putSetting(db, 'models_initialized', '1');
    putSetting(db, 'models_routes', JSON.stringify([]));
    expect(loadRoutes(db, env)).toEqual([]);
    expect(modelsSettingsInitialized(db)).toBe(true);
  });

  it('结构不合法的 models_* 残值不算初始化证据（坏 JSON/空容器=按缺席处理）', () => {
    const db = tempDb();
    putSetting(db, 'models_routes', '{broken json');
    putSetting(db, 'models_keys', JSON.stringify({}));
    putSetting(db, 'models_default', JSON.stringify({}));
    expect(modelsSettingsInitialized(db)).toBe(false);
    expect(loadRoutes(db, env)).toHaveLength(1); // 坏数据被 env 迁移覆盖=合理恢复
  });
});

describe('读面形状校验（统一终核 P1——合法但形状错误的残值按缺席处理）', () => {
  // Codex 实证基线：models_routes 存字符串 \"abc\"/带 length 对象时旧实现把它当
  // 路由返回，loadModelsConfig 的 routes.map 直接崩（与「结构不合法按缺席」注释矛盾）。
  const env = llm({ provider: 'zai', baseUrl: 'https://x', apiKey: 'sk-env', model: 'glm-env' });
  const validRoute = { provider: 'real', api: 'openai-completions' as const, baseURL: 'https://real', models: [{ id: 'm-real' }] };

  it('models_routes=合法标量字符串/带 length 对象/数字：不崩、按 [] 处理（keys 在场=已初始化，env 不重物化）', () => {
    for (const bad of ['\"abc\"', '{\"length\":1}', '123', 'true']) {
      const db = tempDb();
      putSetting(db, 'models_routes', bad);
      putSetting(db, 'models_keys', JSON.stringify({ real: 'sk-real' }));
      // 不抛 routes.map is not a function——读面按缺席处理
      const out = loadModelsConfig(db, env);
      expect(out.routes).toEqual([]);
      expect(out.default).toBeNull();
      expect(loadRoutes(db, env)).toEqual([]);
      // keys 在场=已初始化证据——残值原样保留（未被 env 迁移覆盖）
      expect(modelsSettingsInitialized(db)).toBe(true);
      expect(getSetting(db, 'models_routes')).toBe(bad);
    }
  });

  it('models_routes=合法数组混入非法项：合法项保留、非法项剔除（逐项形状校验）', () => {
    const db = tempDb();
    putSetting(
      db,
      'models_routes',
      JSON.stringify([
        validRoute,
        'abc',
        { length: 1 },
        null,
        { provider: 'no-models', api: 'openai-completions', baseURL: 'https://x' }, // 缺 models
        { provider: '', api: 'openai-completions', baseURL: 'https://x', models: [{ id: 'm' }] }, // provider 空
        { provider: 'bad-api', api: 'grpc', baseURL: 'https://x', models: [{ id: 'm' }] }, // api 非法
        { provider: 'empty-models', api: 'openai-completions', baseURL: 'https://x', models: [] }, // 空模型清单
      ]),
    );
    const routes = loadRoutes(db, env);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ provider: 'real' });
    expect(loadModelsConfig(db, env).routes).toEqual([
      { provider: 'real', api: 'openai-completions', baseURL: 'https://real', models: [{ id: 'm-real' }], hasKey: false },
    ]);
    // 合法项在场=已初始化证据（marker 缺席下仍阻断 env 重物化）
    expect(modelsSettingsInitialized(db)).toBe(true);
  });

  it('models_keys=含非字符串值的对象：字符串值保留、非字符串值剔除（hasKey/桥接面同口径）', () => {
    const db = tempDb();
    putSetting(
      db,
      'models_routes',
      JSON.stringify([validRoute, { provider: 'b', api: 'openai-completions', baseURL: 'https://b', models: [{ id: 'm-b' }] }]),
    );
    putSetting(db, 'models_keys', JSON.stringify({ real: 'sk-real', b: 42, c: null, d: true, e: { x: 1 } }));
    expect(loadKeys(db)).toEqual({ real: 'sk-real' });
    const out = loadModelsConfig(db, env);
    expect(out.routes.find((route) => route.provider === 'real')!.hasKey).toBe(true);
    expect(out.routes.find((route) => route.provider === 'b')!.hasKey).toBe(false); // 非字符串值=无密钥
    expect(buildRoutesBundle(db, env).routes.map((route) => route.provider)).toEqual(['real']);
    // 剔除后空表不算证据：仅剩垃圾值的 keys 不阻断 env 迁移（形状错误=缺席）
    const db2 = tempDb();
    putSetting(db2, 'models_keys', JSON.stringify({ a: 1, b: null }));
    expect(modelsSettingsInitialized(db2)).toBe(false);
    expect(loadRoutes(db2, env)).toHaveLength(1); // env 迁移照常
  });

  it('models_default=数组等非法形状：按 null 处理且不算初始化证据', () => {
    const db = tempDb();
    putSetting(db, 'models_routes', JSON.stringify([validRoute]));
    putSetting(db, 'models_default', JSON.stringify(['array']));
    const out = loadModelsConfig(db, env);
    expect(out.default).toBeNull();
    expect(loadDefault(db)).toBeNull();
    for (const bad of [{ provider: 'a' }, { provider: 1, model: 'm' }, { provider: 'a', model: 'm', effort: 42 }]) {
      putSetting(db, 'models_default', JSON.stringify(bad));
      expect(loadDefault(db)).toBeNull();
      expect(loadModelsConfig(db, env).default).toBeNull(); // 不崩
    }
    // routes/keys 缺席+default 形状非法 → 不算证据 → env 迁移恢复（reset 语义）
    const db2 = tempDb();
    putSetting(db2, 'models_default', JSON.stringify(['x']));
    expect(modelsSettingsInitialized(db2)).toBe(false);
    expect(loadRoutes(db2, env)).toHaveLength(1);
  });

  it('marker 损伤组合①：坏 JSON routes+keys 在场 → 不崩、env 不重物化（残值原样）', () => {
    const db = tempDb();
    putSetting(db, 'models_routes', '{broken json');
    putSetting(db, 'models_keys', JSON.stringify({ real: 'sk-real' }));
    deleteSetting(db, 'models_initialized'); // marker 手删
    expect(modelsSettingsInitialized(db)).toBe(true); // keys 在场=证据
    expect(loadModelsConfig(db, env).routes).toEqual([]); // 不崩
    expect(loadRoutes(db, env)).toEqual([]);
    expect(getSetting(db, 'models_routes')).toBe('{broken json'); // 未被 env 物化覆盖
  });

  it('marker 损伤组合②：marker corrupt+routes 全非法+余键缺席 → 回 env 迁移（等价显式 reset 语义）', () => {
    const db = tempDb();
    putSetting(db, 'models_routes', JSON.stringify(['abc', { length: 1 }])); // 数组但全非法
    putSetting(db, 'models_initialized', 'corrupt');
    expect(modelsSettingsInitialized(db)).toBe(false); // 全非法=零证据
    const routes = loadRoutes(db, env);
    expect(routes).toHaveLength(1); // reset 语义——env 迁移是合理恢复
    expect(routes[0]).toMatchObject({ provider: 'zai', legacy: true });
    expect(loadModelsConfig(db, env).routes[0]).toMatchObject({ provider: 'zai', hasKey: true }); // 不崩且投影正常
    expect(JSON.parse(getSetting(db, 'models_routes')!)[0].provider).toBe('zai'); // 坏残值被迁移覆盖
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

  it('buildRoutesBundle：仅含带密钥路由；default 优先投影；[product-polish-w2] efforts 随模型条目进 bundle（settings.yaml reasoningEfforts 声明源）', () => {
    const db = tempDb();
    saveModelsConfig(db, {
      routes: [
        {
          provider: 'a',
          api: 'openai-completions',
          baseURL: 'https://a',
          apiKey: 'sk-a',
          models: [
            { id: 'm1', contextWindow: 65536, efforts: ['low', 'medium', 'high'] },
            { id: 'm2' },
          ],
        },
        { provider: 'nokey', api: 'openai-completions', baseURL: 'https://n', models: [{ id: 'x' }] },
      ],
      default: { provider: 'a', model: 'm2' },
    });
    const bundle = buildRoutesBundle(db, llm());
    expect(bundle.routes).toHaveLength(1); // 无密钥路由不进内核桥接
    expect(bundle.routes[0]).toMatchObject({ provider: 'a', apiKey: 'sk-a' });
    expect(bundle.routes[0]!.models).toEqual([
      { id: 'm1', contextWindow: 65536, efforts: ['low', 'medium', 'high'] },
      { id: 'm2' },
    ]);
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
