/**
 * 生成代理测试（W2.2）：dry-run 全链（占位帧+假结果 blob+debug.json 对齐 lab 契约）、
 * 半配置拒绝（spec 场景：只配 baseUrl 未配 key → 创建时拒绝并提示缺哪个键）、
 * 配齐后同参数可创建、settings 表优先双层真源。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../src/png/codec.js';
import { putSetting } from '../src/db/store.js';
import { getTaskById } from '../src/db/jobs.js';
import { clientFor, createServices } from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitSettled(services: ReturnType<typeof createServices>, taskId: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await services.jobs.get(services.anonymous, taskId);
    if (task.status !== 'queued' && task.status !== 'running') return task;
    await sleep(20);
  }
  throw new Error('生成任务未在期限内收敛');
}

describe('生成代理（W2.2）', () => {
  it('dry-run 全链：占位 progress 帧 + 假结果 blob（可解码 PNG）+ debug.json 字段对齐 lab 契约', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'generate',
        params: { prompt: '一颗红心，金边', size: '512x512' },
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      const frames = s.jobs.frames(s.anonymous, task.taskId, 0).frames;
      const kinds = frames.map((f) => f.kind);
      expect(kinds).toContain('progress');
      expect(kinds[kinds.length - 1]).toBe('done');
      const artifact = frames.find((f) => f.kind === 'artifact');
      expect(artifact).toBeDefined();
      const blobRef = (artifact!.payload as { blobRef?: string }).blobRef;
      expect(blobRef).toMatch(/^[0-9a-f]{64}$/);
      // 假结果 blob 是真实可解码 PNG（占位图 64×64）
      const bytes = s.blobs.read(blobRef!)!;
      const decoded = decodePng(bytes);
      expect(decoded.width).toBe(64);
      expect(decoded.height).toBe(64);

      // debug.json：字段对齐 lab ImageTaskDebug（endpoint/requestBody/durationMs）
      const debugPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json');
      expect(existsSync(debugPath)).toBe(true);
      const debug = JSON.parse(readFileSync(debugPath, 'utf8')) as Record<string, unknown>;
      expect(debug['endpoint']).toContain('dry-run');
      expect((debug['requestBody'] as Record<string, unknown>)['dryRun']).toBe(true);
      expect('durationMs' in debug).toBe(true);

      // 同 prompt 幂等内容（占位图确定性——同 prompt 同 blob）
      const task2 = await s.jobs.create(s.anonymous, {
        kind: 'generate',
        params: { prompt: '一颗红心，金边' },
      });
      await waitSettled(s, task2.taskId);
      const frames2 = s.jobs.frames(s.anonymous, task2.taskId, 0).frames;
      const artifact2 = frames2.find((f) => f.kind === 'artifact')!;
      expect((artifact2.payload as { blobRef: string }).blobRef).toBe(blobRef);
    } finally {
      s.dispose();
    }
  });

  it('半配置拒绝（spec 场景）：只配 baseUrl 未配 key → 创建显式拒绝并提示缺 IMG_API_KEY；dry-run 开启时不拒', async () => {
    const s = createServices(undefined, { imgDryRun: false });
    try {
      // .env 面半配置（baseUrl 有、key/model 无）
      s.config.img.baseUrl = 'https://img.example.com/v1';
      await expect(
        s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } }),
      ).rejects.toThrow(/缺 IMG_API_KEY、IMG_MODEL/);

      // settings 表优先（双层真源）：补齐后同参数任务可创建。baseUrl 指 loopback 死端口
      // （127.0.0.1:1——连接立即拒绝，无任何真实外呼；本测试只断言创建不再被半配置拒绝）
      putSetting(s.db, 'img_api_key', 'sk-live-test-1');
      putSetting(s.db, 'img_model', 'img-x');
      s.config.img.baseUrl = 'http://127.0.0.1:1/v1';
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      s.jobs.cancel(s.anonymous, task.taskId);
      expect(getTaskById(s.db, task.taskId)).not.toBeNull();
    } finally {
      s.dispose();
    }
  });

  it('RPC 面：dry-run 旗标经 bootstrap 下发；生成任务经 router 可创建', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const boot = await client.bootstrap();
      expect(boot.imgDryRun).toBe(true);
      expect(boot.imgConfigured).toBe(false);
      const created = await client.tasks.create({
        kind: 'generate',
        params: { prompt: 'via-rpc' },
      });
      expect(created.kind).toBe('generate');
      await waitSettled(s, created.taskId);
      const { task } = await client.tasks.get({ taskId: created.taskId });
      expect(task.status).toBe('done');
    } finally {
      s.dispose();
    }
  });

  it('P1-5 真实调用响应回显：debug.json 落盘文件无密钥明文（嵌套键打码 + 兜底替换）', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'sk-live-secret-9876');
      putSetting(s.db, 'img_model', 'img-x');

      // 成功响应携带回显字段（部分中转站会把鉴权上下文回显进 200 正文）——
      // debug.json 在成功路径落盘，此处直接断言文件内容
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            echo: {
              authorization: 'Bearer sk-live-secret-9876',
              api_key: 'sk-live-secret-9876',
              nested: { session_token: 'tok-sk-live-secret-9876' },
            },
            data: [{ b64_json: Buffer.from('fake-png').toString('base64') }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p1' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      const debugPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json');
      expect(existsSync(debugPath)).toBe(true);
      const debugText = readFileSync(debugPath, 'utf8');
      expect(debugText).not.toContain('sk-live-secret-9876'); // 明文密钥零出现
      expect(debugText).not.toContain('Bearer sk-live'); // 前缀形态零出现
      expect(debugText).toContain('…9876'); // 敏感键值 → 尾 4 位打码形态
      // 产物面照常（b64 截断入 debug、blob 内容寻址）
      const artifact = s.jobs.frames(s.anonymous, task.taskId, 0).frames.find((f) => f.kind === 'artifact');
      expect(artifact).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });
  it('P1-5 失败路径：上游 401 回显密钥——异常 message/task.error/frames.jsonl 全链无明文（R2 残余收口）', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'sk-live-secret-9876');
      putSetting(s.db, 'img_model', 'img-x');

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'rejected sk-live-secret-9876' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p1' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('failed');

      // task.error（DB 持久面）
      expect(final.error).toBeDefined();
      expect(final.error).not.toContain('sk-live-secret-9876');
      expect(final.error).not.toContain('Bearer sk-live');
      expect(final.error).toContain('***'); // 密钥本体 → 兜底整段替换（强于尾 4 位形态）

      // frames.jsonl（帧持久面）文件级断言
      const framesPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'frames.jsonl');
      const framesText = readFileSync(framesPath, 'utf8');
      expect(framesText).not.toContain('sk-live-secret-9876');
      expect(framesText).toContain('***');
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R4 同族面：短特殊字符密钥出现在请求字段（prompt 携带密钥值）——debug.json 全字段无明文', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      // 短+特殊字符密钥：不匹配 token 形态正则，只能靠「配置密钥兜底整段替换」终门拦
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'x:y$z-key123');
      putSetting(s.db, 'img_model', 'img-x');

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake').toString('base64') }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      // prompt 故意携带密钥原文——debug.requestBody.prompt 是密钥落盘的最短路径
      const task = await s.jobs.create(s.anonymous, {
        kind: 'generate',
        params: { prompt: 'x:y$z-key123' },
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      const debugPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json');
      const debugText = readFileSync(debugPath, 'utf8');
      expect(debugText).not.toContain('x:y$z-key123'); // 全字段（含 requestBody.prompt/endpoint）零明文
      expect(debugText).toContain('***');
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R5 同族面：上游把密钥用作 JSON 属性名——debug.json 键名零明文', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'x:y$z-key123');
      putSetting(s.db, 'img_model', 'img-x');

      // 上游响应的属性名=配置密钥（值无害）——deepReplaceSecret 键名替换面
      const hostile = `{"data":[{"b64_json":"${Buffer.from('fake').toString('base64')}","x:y$z-key123":"marker","nested":{"x:y$z-key123":"marker2"}}]}`;
      globalThis.fetch = (async () =>
        new Response(hostile, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      const debugPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json');
      const debugText = readFileSync(debugPath, 'utf8');
      // JSON.stringify(debug) 全文（键名+值）零明文
      expect(debugText).not.toContain('x:y$z-key123');
      expect(debugText).toContain('"***"'); // 被替换后的键名形态
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R6 同族面：dry-run fallback 绕过终门——debug.json/frames 全链无明文', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      putSetting(s.db, 'img_api_key', 'x:y$z-key123'); // 合规密钥——dry-run 不读但终门仍须生效
      const task = await s.jobs.create(s.anonymous, {
        kind: 'generate',
        params: { prompt: 'x:y$z-key123', advanced: { nested: 'x:y$z-key123' } },
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      const debugPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json');
      const debugText = readFileSync(debugPath, 'utf8');
      expect(debugText).not.toContain('x:y$z-key123');
      expect(debugText).toContain('***');
      // log 帧（frames.jsonl）中的 debugSummary 同样无明文
      const framesPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'frames.jsonl');
      expect(readFileSync(framesPath, 'utf8')).not.toContain('x:y$z-key123');
    } finally {
      s.dispose();
    }
  });

  it('P1-5 R6 P2→R9 默认：密钥为 * 字符——dry-run 下任务创建也拒绝（病态形态不豁免）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      putSetting(s.db, 'img_api_key', '*');
      await expect(
        s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: '*' } }),
      ).rejects.toThrow(/形态非法/);
    } finally {
      s.dispose();
    }
  });

  it('P1-5 R8 配置侧校验：含 * 的病态密钥（a***b）——任务创建直接拒绝（不进调用链）', async () => {
    const s = createServices(undefined, { imgDryRun: false });
    try {
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'a***b'); // 含 *：可与替换标记部分重叠/重组
      putSetting(s.db, 'img_model', 'img-x');
      await expect(
        s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } }),
      ).rejects.toThrow(/形态非法/);
    } finally {
      s.dispose();
    }
  });

  it('P1-5 R8 编码回显：上游返回 base64(密钥)——debug.json 不落编码形态', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      const key = 'sk-live-secret-9876'; // 合规形态（≥8 无 *）
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', key);
      putSetting(s.db, 'img_model', 'img-x');
      const encoded = Buffer.from(key).toString('base64');
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: [{ b64_json: encoded }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');
      const debugText = readFileSync(
        path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json'),
        'utf8',
      );
      expect(debugText).not.toContain(encoded); // 编码形态不落盘
      expect(debugText).not.toContain(key); // 原文亦不落盘
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R9 矩阵：编码 JSON 属性名（base64/percent/hex）——debug.json 键名不落编码形态', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      const key = 'x:y$z-key123'; // 合规（≥8 无 *）
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', key);
      putSetting(s.db, 'img_model', 'img-x');
      const b64 = Buffer.from(key).toString('base64');
      const pct = encodeURIComponent(key);
      const hex = Buffer.from(key).toString('hex');
      const hostile = `{"data":[{"b64_json":"${Buffer.from('fake').toString('base64')}","${b64}":"m1","${pct}":"m2","${hex}":"m3"}]}`;
      globalThis.fetch = (async () =>
        new Response(hostile, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');
      const debugText = readFileSync(
        path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json'),
        'utf8',
      );
      expect(debugText).not.toContain(b64);
      expect(debugText).not.toContain(pct);
      expect(debugText).not.toContain(hex);
      expect(debugText).not.toContain(key);
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R9 矩阵：401 message 携 base64/percent 编码——task.error/frames 不落编码形态', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      const key = 'x:y$z-key123';
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', key);
      putSetting(s.db, 'img_model', 'img-x');
      const b64 = Buffer.from(key).toString('base64');
      const pct = encodeURIComponent(key);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: `rejected ${b64} and ${pct}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('failed');
      expect(final.error).not.toContain(b64);
      expect(final.error).not.toContain(pct);
      expect(final.error).not.toContain(key);
      const framesPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'frames.jsonl');
      const framesText = readFileSync(framesPath, 'utf8');
      expect(framesText).not.toContain(b64);
      expect(framesText).not.toContain(pct);
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R9 dry-run 安全默认：已配置病态密钥（含 *）时 dry-run 任务创建也拒绝', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      putSetting(s.db, 'img_api_key', 'bad*key123'); // 含 *：dry-run 下也拒
      await expect(
        s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } }),
      ).rejects.toThrow(/形态非法/);
    } finally {
      s.dispose();
    }
  });

  it('P1-5 R7 空格密钥→R9 默认：trimmed 后过短（x:y$z）——dry-run 下创建也拒绝', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      putSetting(s.db, 'img_api_key', '  x:y$z  ');
      await expect(
        s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'x:y$z' } }),
      ).rejects.toThrow(/形态非法/);
    } finally {
      s.dispose();
    }
  });

  it('P1-5 R3 绕过一：非法下载 URL 内嵌密钥（typed ImageApiError）——task.error/frames 无明文', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'sk-live-secret-9876');
      putSetting(s.db, 'img_model', 'img-x');

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: [{ url: 'not-a-url-sk-live-secret-9876' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p1' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('failed');
      expect(final.error).not.toContain('sk-live-secret-9876');
      const framesPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'frames.jsonl');
      expect(readFileSync(framesPath, 'utf8')).not.toContain('sk-live-secret-9876');
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R3 绕过二：b64_json 回显密钥——debug.json 无明文（特殊字段旁路收口）', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'sk-live-secret-9876');
      putSetting(s.db, 'img_model', 'img-x');

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: [{ b64_json: 'sk-live-secret-9876' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p1' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      const debugPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json');
      const debugText = readFileSync(debugPath, 'utf8');
      expect(debugText).not.toContain('sk-live-secret-9876');
      expect(debugText).toContain('***');
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R10 变体矩阵：unpadded base64/小写 percent/大写 hex——debug 键值与 error 面全不落', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      const key = 'x:y$z-key123';
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', key);
      putSetting(s.db, 'img_model', 'img-x');
      const b64un = Buffer.from(key).toString('base64').replace(/=+$/, '');
      const pctLo = encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
      const hexUp = Buffer.from(key).toString('hex').toUpperCase();
      // 成功响应：三变体同时作属性名与值
      const hostile = `{"data":[{"b64_json":"${Buffer.from('fake').toString('base64')}","${b64un}":"m1"}],"echo":["${pctLo}","${hexUp}"]}`;
      globalThis.fetch = (async () =>
        new Response(hostile, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      const t1 = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      expect((await waitSettled(s, t1.taskId)).status).toBe('done');
      const debugText = readFileSync(
        path.join(s.config.dataRoot, 'tasks', t1.taskId, 'debug.json'),
        'utf8',
      );
      expect(debugText).not.toContain(b64un);
      expect(debugText).not.toContain(pctLo);
      expect(debugText).not.toContain(hexUp);

      // 失败响应：三变体进 401 message → task.error/frames
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: `${b64un} | ${pctLo} | ${hexUp}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const t2 = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const final2 = await waitSettled(s, t2.taskId);
      expect(final2.status).toBe('failed');
      expect(final2.error).not.toContain(b64un);
      expect(final2.error).not.toContain(pctLo);
      expect(final2.error).not.toContain(hexUp);
      const framesText = readFileSync(
        path.join(s.config.dataRoot, 'tasks', t2.taskId, 'frames.jsonl'),
        'utf8',
      );
      expect(framesText).not.toContain(b64un);
      expect(framesText).not.toContain(pctLo);
      expect(framesText).not.toContain(hexUp);
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R11 等价类：percent 全转义/选择性转义/逐位混合 + hex 逐 nibble 混合——三持久面全不落', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      // 载荷一：纯字母密钥（unreserved 可选择性转义——组合空间代表形态）
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'abcdefgh');
      putSetting(s.db, 'img_model', 'img-x');
      const p1 = '%61%62%63%64%65%66%67%68'; // 全转义
      const p2 = '%61bc%64efgh'; // 选择性转义
      const p3 = '%61%62%63d%65%66g%68'; // 另一选择性组合（混合逐字节可选转义）
      const hostile1 = `{"data":[{"b64_json":"${Buffer.from('fake').toString('base64')}","${p1}":"m1","${p2}":"m2","${p3}":"m3"}],"echo":["${p2}"]}`;
      globalThis.fetch = (async () =>
        new Response(hostile1, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      const t1 = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const f1 = await waitSettled(s, t1.taskId);
      expect(f1.status, `任务失败: ${f1.error}`).toBe('done');
      const debug1 = readFileSync(path.join(s.config.dataRoot, 'tasks', t1.taskId, 'debug.json'), 'utf8');
      expect(debug1).not.toContain(p1);
      expect(debug1).not.toContain(p2);
      expect(debug1).not.toContain(p3);

      // 载荷二：符号密钥的 hex 逐 nibble 混合大小写（401 消息面）
      const key2 = 'x:y$z-key123';
      putSetting(s.db, 'img_api_key', key2);
      const hexMix = key2
        .split('')
        .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0').split('').map((c, i) => (i === 0 && /[a-f]/.test(c) ? c.toUpperCase() : c)).join(''))
        .join('');
      // percent 变体族（均解码回 key2）：逐 escape 大小写混合（%3A→%3a，含字母 hex 位）
      // + 选择性转义（unreserved 'k'→%6b——R11 组合空间代表形态）
      const pctMix = encodeURIComponent(key2).replace('%3A', '%3a');
      const pctSel = 'x%3ay%24z-%6bey123'; // 选择性转义（'k'→%6b）+ %3a 小写——均解码回 key2
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: `mixed ${hexMix} ${pctMix} ${pctSel}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const t2 = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const final2 = await waitSettled(s, t2.taskId);
      expect(final2.status).toBe('failed');
      expect(final2.error).not.toContain(hexMix);
      expect(final2.error).not.toContain(pctMix);
      expect(final2.error).not.toContain(pctSel);
      const frames2 = readFileSync(path.join(s.config.dataRoot, 'tasks', t2.taskId, 'frames.jsonl'), 'utf8');
      expect(frames2).not.toContain(hexMix);
      expect(frames2).not.toContain(pctMix);
      expect(frames2).not.toContain(pctSel);
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });

  it('P1-5 R12 回归：合法密钥含 ( ) ——正则构造不崩；%28 形态掩蔽；不误遮蔽无关近形文本', async () => {
    const originalFetch = globalThis.fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      const key = 'key(123)xy'; // 合规（≥8 无 *）且含正则元字符
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', key);
      putSetting(s.db, 'img_model', 'img-x');
      // 全 %HH 化的等价形态（sub-delim 走 %28/%29——严格标准编码）
      const pctAll = '%6b%65y%28123%29xy';
      // 无关近形文本（差一个数字且不包含密钥子串——不得被误遮蔽，R12 误遮蔽回归）
      const lookalike = 'key(124)xyz';
      const hostile = `{"data":[{"b64_json":"${Buffer.from('fake').toString('base64')}","${pctAll}":"m1","keep":"${lookalike}"}]}`;
      globalThis.fetch = (async () =>
        new Response(hostile, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      const final = await waitSettled(s, task.taskId);
      expect(final.status, `任务失败: ${final.error}`).toBe('done'); // 不崩=R12 P1 闭
      const debugText = readFileSync(
        path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json'),
        'utf8',
      );
      expect(debugText).not.toContain(pctAll); // %HH 等价形态掩蔽
      expect(debugText).not.toContain(key); // 原文掩蔽
      expect(debugText).toContain(lookalike); // 近形文本原样保留（含字面括号）——不误遮蔽
      expect(debugText).toContain('***'); // 掩蔽痕迹存在
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });});
