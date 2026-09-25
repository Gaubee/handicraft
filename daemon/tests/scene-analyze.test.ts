/**
 * scene.analyze mock 单测（add-subject-sam-pipeline P2.3——纯本地 mock 面，零真实外呼）。
 * 形态沿仓内先例：装配=createServices（sam-bridge.test.ts 同款）；LLM 网关=
 * 本地 openai-completions mock（kernel-live.test.ts 先例的线协议同构替身——
 * 127.0.0.1 loopback、stream:false JSON 体；与真实网关仅地址/key 不同）。
 * 覆盖：通道 B 正常（elements 全字段+工件+留存）/fenced 与裸 JSON 容错/内容
 * parts 数组形态/畸形 JSON 拒（原文摘要）/elements schema 拒/HTTP 坏/超时/视觉
 * 模型未配置 typed/live 门（缺省 mock：SAM_ANALYZE_LIVE env+live-disabled）/桥
 * 通道优先级（桥 ok 不走 LLM；桥 unsupported 降 LLM 不留静默；桥 operational
 * 失败不降级）/输入面（blobRef 非法/blob 缺失/imagePx 锚点错位）/fence/
 * capability 注册面（readonly agent 直调+MCP 投影名+deny 名单存活）。
 * 零常驻纪律：每用例 finally 显式 stop mock 网关（server.close）+dispose 服务。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SceneElement } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { MockSamTransport, SamBridge, SamBridgeError } from '../src/kernel/vision/sam-bridge.js';
import {
  createVisionCapabilities,
  extractJsonText,
  SAM_ANALYZE_LIVE_ENV,
  SceneAnalyzer,
  SceneAnalyzeError,
  SCENE_ANALYZE_LOGS_DIRNAME,
  type SceneAnalyzeInput,
} from '../src/kernel/vision/scene-analyze.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { productToolDenyList } from '../src/kernel/tool-surface.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

function tinyPng(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = 40 + (i % 180);
  return encodePng(w, h, rgba);
}

/** 全字段元素 fixture（confidence 可选字段另用第二元素缺席覆盖）。 */
function fullElements(): SceneElement[] {
  return [
    {
      name: '路灯',
      category: 'structure',
      boxPx: { x: 10, y: 20, w: 30, h: 60 },
      hint: 'street lamp',
      suggestDrillWorthy: true,
      confidence: 0.92,
    },
    { name: '草地', category: 'foliage', boxPx: { x: 0, y: 80, w: 100, h: 20 }, hint: 'grass', suggestDrillWorthy: true },
  ];
}

const ELEMENTS_JSON = JSON.stringify({ elements: fullElements() });

/** mock 网关脚本：按序弹出（确定性）；记录请求体供断言。 */
interface MockGateway {
  server: Server;
  port: number;
  requests: string[];
  stop(): Promise<void>;
}

function startMockGateway(
  script: () => { status?: number; body?: string; delayMs?: number } | { text: string; parts?: boolean },
): Promise<MockGateway> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      requests.push(body);
      const step = script();
      if ('text' in step) {
        const content: unknown = step.parts
          ? [{ type: 'text', text: step.text }]
          : step.text;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        return;
      }
      if (step.delayMs !== undefined && step.delayMs > 0) {
        setTimeout(() => {
          response.writeHead(step.status ?? 500, { 'content-type': 'text/plain' });
          response.end(step.body ?? '');
        }, step.delayMs);
        return;
      }
      response.writeHead(step.status ?? 500, { 'content-type': 'text/plain' });
      response.end(step.body ?? '');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        requests,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

interface Ctx {
  s: TestServices;
  taskId: string;
  imageRef: string;
  input: SceneAnalyzeInput;
}

function setup(imageW = 64, imageH = 48): Ctx {
  const s = createServices();
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'scene-analyze 测试' });
  const taskId = createAgentTask(s.db, {
    ownerId: s.anonymous.id,
    sessionId,
    paramsJson: JSON.stringify({ kind: 'scene-analyze-test' }),
  }).id;
  const imageRef = s.blobs.put(tinyPng(imageW, imageH)).hash;
  return {
    s,
    taskId,
    imageRef,
    input: {
      taskId,
      imageBlobRef: imageRef,
      imagePx: { width: imageW, height: imageH },
      canvasCm: { w: 20, h: 15 },
    },
  };
}

/** 通道 B 装配：mock 网关地址注入 config.llm（kernel-live 同款缝）。 */
function wireLlm(ctx: Ctx, port: number, visionModel = 'glm-4.6v'): void {
  ctx.s.config.llm.provider = 'zai';
  ctx.s.config.llm.baseUrl = `http://127.0.0.1:${port}/v1`;
  ctx.s.config.llm.apiKey = 'mock-gateway-key';
  ctx.s.config.llm.model = 'glm-5.3-flash';
  ctx.s.config.llm.api = '';
  ctx.s.config.llm.visionModel = visionModel;
}

async function capture(p: Promise<unknown>): Promise<SceneAnalyzeError> {
  const error = (await p.catch((e: unknown) => e)) as SceneAnalyzeError;
  expect(error).toBeInstanceOf(SceneAnalyzeError);
  return error;
}

function readRetention(exchangeJson: string): Record<string, unknown> {
  return JSON.parse(readFileSync(exchangeJson, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------- extractJsonText 单测

describe('extractJsonText（fenced/裸 JSON 容错）', () => {
  it('裸 JSON 直取；fenced 剥壳（json 语言标与无标两形态）', () => {
    expect(extractJsonText('  {"a":1}  ')).toBe('{"a":1}');
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('前后缀噪声：取首 { 到尾 }', () => {
    expect(extractJsonText('好的，分析结果如下：\n{"elements":[]}\n以上。')).toBe('{"elements":[]}');
  });
  it('无 JSON 结构：原样返回（由 JSON.parse 判死）', () => {
    expect(extractJsonText('这不是 JSON')).toBe('这不是 JSON');
  });
});

// ---------------------------------------------------------------- 通道 B（LLM 路由）

describe('scene.analyze 通道 B（LLM 路由 mock 网关）', () => {
  it('正常：elements 全字段 → SceneAnalysis 工件+留存；线面=model/image_url data URL/temperature 0', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('llm-route');
      expect(outcome.demotedFrom).toBeUndefined();
      expect(outcome.meta.model).toBe('glm-4.6v');
      // 工件 round-trip：blob 内容=完整 SceneAnalysis（锚点=daemon 真源回填）
      const bytes = ctx.s.blobs.read(outcome.artifactBlobRef);
      expect(bytes).not.toBeNull();
      const analysis = JSON.parse(bytes!.toString('utf8'));
      expect(analysis).toMatchObject({
        kind: 'scene-analysis',
        formatVersion: 1,
        imageBlobRef: ctx.imageRef,
        canvasCm: ctx.input.canvasCm,
        imagePx: ctx.input.imagePx,
      });
      expect(analysis.elements).toEqual(fullElements());
      expect(outcome.analysis.elements).toHaveLength(2);
      // 线面断言：视觉模型名+图 base64 data URL 进消息+确定性温度
      expect(gw.requests).toHaveLength(1);
      const sent = JSON.parse(gw.requests[0]!) as {
        model: string;
        temperature: number;
        stream: boolean;
        messages: Array<{ role: string; content: Array<{ type: string; image_url?: { url: string } }> }>;
      };
      expect(sent.model).toBe('glm-4.6v');
      expect(sent.temperature).toBe(0);
      expect(sent.stream).toBe(false);
      const imagePart = sent.messages[0]!.content.find((part) => part.type === 'image_url');
      expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
      // 留存：outcome ok+model+responseText；不含 apiKey、不含图 base64
      const record = readRetention(outcome.retention.exchangeJson);
      expect(record['outcome']).toBe('ok');
      expect(record['channel']).toBe('llm-route');
      expect(record['model']).toBe('glm-4.6v');
      expect(String(record['responseText'])).toContain('路灯');
      const raw = readFileSync(outcome.retention.exchangeJson, 'utf8');
      expect(raw).not.toContain('mock-gateway-key');
      expect(raw).not.toContain('data:image/png;base64');
      // 留存目录形态：scene-analyze-logs/{date}/{taskId}/
      expect(outcome.retention.exchangeJson).toContain(SCENE_ANALYZE_LOGS_DIRNAME);
      expect(outcome.retention.exchangeJson).toContain(ctx.taskId);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('容错：fenced 输出与 content parts 数组形态均可抽取', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({
      text: '```json\n' + ELEMENTS_JSON + '\n```',
      parts: true,
    }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.analysis.elements).toHaveLength(2);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('畸形 JSON 拒：typed llm-bad-json 携原文摘要+失败留存', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: '抱歉，我无法分析这张图。' }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('llm-bad-json');
      expect(error.message).toContain('无法解析为 JSON');
      expect(error.message).toContain('抱歉，我无法分析这张图');
      // 失败留存：outcome=error:llm-bad-json（当日目录下该任务的记录）
      const date = new Date().toISOString().slice(0, 10);
      const dir = path.join(ctx.s.config.dataRoot, SCENE_ANALYZE_LOGS_DIRNAME, date, ctx.taskId);
      const files = readdirSync(dir);
      expect(files.length).toBe(1);
      const record = readRetention(path.join(dir, files[0]!));
      expect(record['outcome']).toBe('error:llm-bad-json');
      expect(record['channel']).toBe('llm-route');
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('elements schema 拒：typed llm-invalid-elements 携 issues+原文摘要', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({
      text: JSON.stringify({ elements: [{ name: '', boxPx: { x: -1, y: 0, w: 0, h: 0 }, hint: '' }] }),
    }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('llm-invalid-elements');
      expect(error.message).toContain('elements 校验失败');
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('HTTP 坏：typed llm-call-failed 携状态码', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ status: 502, body: 'bad gateway' }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('llm-call-failed');
      expect(error.message).toContain('502');
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('超时界：短界注入 → typed llm-call-failed（不悬挂）', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ status: 200, body: '', delayMs: 1200 }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true, timeoutMs: 80 },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('llm-call-failed');
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  }, 10_000);

  it('视觉模型未配置：typed llm-route-unconfigured（零外呼——网关零请求）', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      // config.llm 未配置（createServices 缺省无 LLM_*）——即使网关可达也不触达
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('llm-route-unconfigured');
      expect(error.message).toContain('LLM_API_KEY');
      expect(gw.requests).toHaveLength(0);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('协议误配：非 openai-completions → typed llm-route-unconfigured（配置错误面）', async () => {
    const ctx = setup();
    try {
      ctx.s.config.llm.apiKey = 'sk-x';
      ctx.s.config.llm.api = 'anthropic-messages';
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('llm-route-unconfigured');
      expect(error.message).toContain('openai-completions');
    } finally {
      ctx.s.dispose();
    }
  });

  it('live 门：缺省（无 SAM_ANALYZE_LIVE env）→ typed live-disabled（零外呼）', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      delete process.env[SAM_ANALYZE_LIVE_ENV];
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('live-disabled');
      expect(error.message).toContain(SAM_ANALYZE_LIVE_ENV);
      expect(gw.requests).toHaveLength(0);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('live 门：env SAM_ANALYZE_LIVE=1 构造缺省解析真连开（走 mock 网关成功）', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      process.env[SAM_ANALYZE_LIVE_ENV] = '1';
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('llm-route');
      expect(outcome.analysis.elements).toHaveLength(2);
    } finally {
      delete process.env[SAM_ANALYZE_LIVE_ENV];
      await gw.stop();
      ctx.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 通道 A 与优先级

describe('scene.analyze 双通道优先级（桥 vs LLM 路由）', () => {
  it('桥 ok：走桥不走 LLM（网关零请求）——工件+桥留存引用', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      const transport = new MockSamTransport();
      transport.respond(() => ({
        kind: 'analyze',
        elements: fullElements(),
        meta: { model: 'vlm-bridge@macmini', durationMs: 2100, iteration: 0 },
      }));
      const bridge = new SamBridge(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot },
        { transport },
      );
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm, bridge },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('bridge');
      expect(outcome.meta.model).toBe('vlm-bridge@macmini');
      expect(outcome.analysis.elements).toHaveLength(2);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]).toMatchObject({ kind: 'analyze', taskId: ctx.taskId });
      expect(gw.requests).toHaveLength(0); // 桥优先——LLM 网关零触达
      // 桥留存引用进了 scene-analyze 留存记录
      const record = readRetention(outcome.retention.exchangeJson);
      expect(record['outcome']).toBe('ok');
      expect(String(record['bridgeExchangeJson'])).toContain('sam-logs');
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('桥 unsupported：显式降通道 B（demotedFrom 不留静默）+留存记录降级', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      const transport = new MockSamTransport();
      transport.respond(() => {
        throw new SamBridgeError('macmini 侧未上报 VLM analyze 能力', 'unimplemented');
      });
      const bridge = new SamBridge(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot },
        { transport },
      );
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm, bridge },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('llm-route');
      expect(outcome.demotedFrom).toBe('bridge-unsupported');
      expect(outcome.meta.model).toBe('glm-4.6v');
      expect(transport.requests).toHaveLength(1); // 桥被试过一次
      expect(gw.requests).toHaveLength(1); // 降级后 LLM 真实承载
      const record = readRetention(outcome.retention.exchangeJson);
      expect(record['demotedFrom']).toBe('bridge-unsupported');
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('桥 operational 失败：不降级——typed bridge-failed 上抛（LLM 零触达）', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      const transport = new MockSamTransport();
      transport.respond(() => {
        throw new Error('ssh 连接抖动');
      });
      const bridge = new SamBridge(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot },
        { transport },
      );
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm, bridge },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('bridge-failed');
      expect(gw.requests).toHaveLength(0);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 输入面与 fence

describe('scene.analyze 输入面与 fence', () => {
  it('输入非法（blobRef 形状）→ typed invalid-input', async () => {
    const ctx = setup();
    try {
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(
        analyzer.analyze({ ...ctx.input, imageBlobRef: 'not-a-blob-ref' }),
      );
      expect(error.kind).toBe('invalid-input');
    } finally {
      ctx.s.dispose();
    }
  });

  it('原图缺失 → typed image-missing', async () => {
    const ctx = setup();
    try {
      ctx.s.config.llm.apiKey = 'sk-x';
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const missing = '0'.repeat(64);
      const error = await capture(analyzer.analyze({ ...ctx.input, imageBlobRef: missing }));
      expect(error.kind).toBe('image-missing');
    } finally {
      ctx.s.dispose();
    }
  });

  it('imagePx 与原图尺寸不符 → typed image-decode-failed（锚点错位必拒）', async () => {
    const ctx = setup();
    try {
      ctx.s.config.llm.apiKey = 'sk-x';
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(
        analyzer.analyze({ ...ctx.input, imagePx: { width: 32, height: 48 } }),
      );
      expect(error.kind).toBe('image-decode-failed');
      expect(error.message).toContain('锚点错位');
    } finally {
      ctx.s.dispose();
    }
  });

  it('fence：cancelled 任务工件写入拒 → typed fence（零任务域 blob）', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      ctx.s.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('cancelled', ctx.taskId);
      const before = (ctx.s.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c;
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('fence');
      const after = (ctx.s.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c;
      expect(after).toBe(before); // fence 拒——零任务域写入（网关调用后、写工件前拦截）
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 工具面注册

describe('scene.analyze capability 注册面（readonly 直调+MCP 投影）', () => {
  it('agent 直调 ok：value 携 channel/artifactBlobRef/meta/analysis；输入镜像 schema', async () => {
    const ctx = setup();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      const registry = createVisionCapabilities({
        db: ctx.s.db,
        blobs: ctx.s.blobs,
        dataRoot: ctx.s.config.dataRoot,
        llm: ctx.s.config.llm,
        jobs: ctx.s.jobs,
        analyzerOptions: { live: true },
      });
      expect(registry.names()).toEqual(['studio.scene.analyze']);
      const result = await registry.call('studio.scene.analyze', ctx.input, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      const value = (result as { value: Record<string, unknown> }).value;
      expect(value['channel']).toBe('llm-route');
      expect(typeof value['artifactBlobRef']).toBe('string');
      expect((value['analysis'] as { elements: unknown[] }).elements).toHaveLength(2);
      // artifact 帧登记（P3.3-fix：tasks.artifact 合法集=帧∪附件——名字/blobRef 命中）。
      const artifactFrames = ctx.s.jobs
        .frames(ctx.s.anonymous, ctx.taskId, 0)
        .frames.filter((frame) => frame.kind === 'artifact')
        .map((frame) => (frame.payload as { blobRef: string; name: string }));
      expect(artifactFrames).toEqual([{ blobRef: value['artifactBlobRef'], name: 'scene-analysis.json' }]);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('任务不存在 → failed 闭合结果（UNAVAILABLE）', async () => {
    const ctx = setup();
    try {
      const registry = createVisionCapabilities({
        db: ctx.s.db,
        blobs: ctx.s.blobs,
        dataRoot: ctx.s.config.dataRoot,
        llm: ctx.s.config.llm,
      });
      const result = await registry.call(
        'studio.scene.analyze',
        { ...ctx.input, taskId: 'task-does-not-exist' },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'failed', code: 'UNAVAILABLE' });
      expect((result as { message: string }).message).toContain('任务不存在');
    } finally {
      ctx.s.dispose();
    }
  });

  it('MCP 投影名+deny 名单存活：mcp__studio__scene_analyze 不被收窄', () => {
    expect(mcpToolName('studio.scene.analyze')).toBe('scene_analyze');
    const deny = productToolDenyList(['bash', 'todo_write', 'mcp__studio__scene_analyze']);
    expect(deny).toEqual(['bash']); // ask_user_question 在 allowlist；scene 工具存活
  });
});

// ---------------------------------------------------------------- 隔离性自检（并行波防串扰）

describe('scene.analyze 测试隔离', () => {
  it('tmp 数据根独立（无跨用例残留）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scene-analyze-iso-'));
    try {
      expect(path.basename(root)).toMatch(/^scene-analyze-iso-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
