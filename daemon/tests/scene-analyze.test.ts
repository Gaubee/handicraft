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
import { decodePng, encodePng } from '../src/png/codec.js';
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
import { imageProcessingEffective, saveImageProcessing } from '../src/image-processing-store.js';
import { loadModelsConfig, saveModelsConfig } from '../src/models-store.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

function tinyPng(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = 40 + (i % 180);
  return encodePng(w, h, rgba);
}

/** 全字段元素 fixture（v2 Scene Graph 关系格式——confidence 可选字段另用第二元素缺席覆盖）。 */
function fullElements(): SceneElement[] {
  return [
    {
      name: '路灯',
      category: 'structure',
      boxPx: { x: 10, y: 20, w: 30, h: 60 },
      hint: 'street lamp',
      suggestDrillWorthy: true,
      confidence: 0.92,
      elementId: 'el-0001',
      parentElementId: null,
    },
    {
      name: '草地',
      category: 'foliage',
      boxPx: { x: 0, y: 80, w: 100, h: 20 },
      hint: 'grass',
      suggestDrillWorthy: true,
      elementId: 'el-0002',
      parentElementId: null,
    },
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
        formatVersion: 2,
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

  it('（2.5 语义更新）env 单路由协议值经迁移收编放行：anthropic-messages 不再是配置错误', async () => {
    const ctx = setup();
    const gw = await startProtocolGateway(() => ({ ok: true }));
    try {
      // W4.1 曾冻结 openai-completions-only（误配 typed 拒）；split-admin-portal 2.5
      // 起三协议开放——.env anthropic-messages 经 loadRoutes 迁移收编为 settings
      // 路由（normalizeApi 双系放行），线面走 /v1/messages。
      ctx.s.config.llm.provider = 'zai';
      ctx.s.config.llm.baseUrl = `http://127.0.0.1:${gw.port}`;
      ctx.s.config.llm.apiKey = 'sk-anthropic-env';
      ctx.s.config.llm.model = 'glm-5.3v';
      ctx.s.config.llm.api = 'anthropic-messages';
      ctx.s.config.llm.visionModel = '';
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('llm-route');
      expect(gw.requests[0]?.url).toBe('/v1/messages');
      expect(gw.requests[0]?.headers['x-api-key']).toBe('sk-anthropic-env');
      expect(gw.requests).toHaveLength(1);
    } finally {
      await gw.stop();
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

// ---------------------------------------------------------------- W1 入线降采样

describe('scene.analyze W1 入线降采样（物理密度门）', () => {
  /** 高密度 fixture：80×60 @ 1.6×1.2cm = 50px/cm → 目标 25 → 40×30（精确减半）。 */
  function denseCtx(): Ctx {
    const ctx = setup(80, 60);
    ctx.input.canvasCm = { w: 1.6, h: 1.2 };
    return ctx;
  }

  it('密度超目标 → 锚点图重建：analysis 锚点=新 blob/新尺寸；VLM 收降采图；留存审计面齐', async () => {
    const ctx = denseCtx();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true }, // intakeConfig 缺省=env（测试进程未设→开+25）
      );
      const originalRef = ctx.input.imageBlobRef;
      const outcome = await analyzer.analyze(ctx.input);

      // 结果面：intakeResample from→to 完整（Agent 后续锚点真源）
      expect(outcome.intakeResample).toMatchObject({
        applied: true,
        reason: 'density-cap',
        fromImageBlobRef: originalRef,
        fromImagePx: { width: 80, height: 60 },
        imagePx: { width: 40, height: 30 },
        ppcmBefore: 50,
        ppcmAfter: 25,
      });
      // 工件锚点同源更新（新 blobRef≠原图；新尺寸）
      expect(outcome.analysis.imagePx).toEqual({ width: 40, height: 30 });
      expect(outcome.analysis.imageBlobRef).not.toBe(originalRef);
      expect(outcome.analysis.imageBlobRef).toBe(outcome.intakeResample.imageBlobRef);
      // 新锚点图真实可读+尺寸正确（下游 subject.segment/workbench 消费面）
      const anchorBytes = ctx.s.blobs.read(outcome.analysis.imageBlobRef);
      expect(anchorBytes).not.toBeNull();
      const decoded = decodePng(anchorBytes!);
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 40, height: 30 });
      // 原图 blob 不动（内容寻址只读）
      expect(ctx.s.blobs.read(originalRef)).not.toBeNull();

      // 线面：VLM 收到的是降采图（data URL base64 解码=40×30）+box 边界文本按新尺寸
      expect(gw.requests).toHaveLength(1);
      const sent = JSON.parse(gw.requests[0]!) as {
        messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
      };
      const imagePart = sent.messages[0]!.content.find((part) => part.type === 'image_url');
      const b64 = imagePart?.image_url?.url.replace(/^data:image\/png;base64,/, '') ?? '';
      const seen = decodePng(new Uint8Array(Buffer.from(b64, 'base64')));
      expect({ width: seen.width, height: seen.height }).toEqual({ width: 40, height: 30 });
      const textPart = sent.messages[0]!.content.find((part) => part.type === 'text');
      expect(textPart?.text).toContain('40×30');

      // 留存：intakeResample 审计面（from→to 可追溯）
      const record = readRetention(outcome.retention.exchangeJson);
      expect(record['intakeResample']).toMatchObject({ applied: true, reason: 'density-cap' });
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('密度≤目标 → 透传：锚点=原图原尺寸（只降不升）', async () => {
    const ctx = setup(64, 48); // 3.2px/cm << 25
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.intakeResample).toMatchObject({
        applied: false,
        imageBlobRef: ctx.input.imageBlobRef,
        imagePx: ctx.input.imagePx,
      });
      expect(outcome.analysis.imagePx).toEqual(ctx.input.imagePx);
      expect(outcome.analysis.imageBlobRef).toBe(ctx.input.imageBlobRef);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('env 面：PPCM_RESAMPLE=0 透传旧行为；PPCM_TARGET 覆写目标密度', async () => {
    const savedResample = process.env.PPCM_RESAMPLE;
    const savedTarget = process.env.PPCM_TARGET;
    try {
      // =0：高密度图也不降（旧行为）
      process.env.PPCM_RESAMPLE = '0';
      {
        const ctx = denseCtx();
        const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
        try {
          wireLlm(ctx, gw.port);
          const analyzer = new SceneAnalyzer(
            { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
            { live: true },
          );
          const outcome = await analyzer.analyze(ctx.input);
          expect(outcome.intakeResample.applied).toBe(false);
          expect(outcome.analysis.imagePx).toEqual({ width: 80, height: 60 });
        } finally {
          await gw.stop();
          ctx.s.dispose();
        }
      }
      // TARGET=40：50px/cm → 40px/cm（80×60→64×48）
      delete process.env.PPCM_RESAMPLE;
      process.env.PPCM_TARGET = '40';
      {
        const ctx = denseCtx();
        const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
        try {
          wireLlm(ctx, gw.port);
          const analyzer = new SceneAnalyzer(
            { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
            { live: true },
          );
          const outcome = await analyzer.analyze(ctx.input);
          expect(outcome.intakeResample.applied).toBe(true);
          expect(outcome.analysis.imagePx).toEqual({ width: 64, height: 48 });
        } finally {
          await gw.stop();
          ctx.s.dispose();
        }
      }
    } finally {
      if (savedResample === undefined) delete process.env.PPCM_RESAMPLE;
      else process.env.PPCM_RESAMPLE = savedResample;
      if (savedTarget === undefined) delete process.env.PPCM_TARGET;
      else process.env.PPCM_TARGET = savedTarget;
    }
  });

  it('fence：cancelled 任务 → 入线写入拒 typed fence（零网关调用——降采先于通道）', async () => {
    const ctx = denseCtx();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      ctx.s.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('cancelled', ctx.taskId);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('fence');
      expect(gw.requests).toHaveLength(0); // 降采工件写入在通道前——fence 先收口
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('e2e（工具面全链）：大图任务 → intake-image.png+scene-analysis.json 双帧；帧流 blobRef 可解析且锚点尺寸正确', async () => {
    const ctx = denseCtx();
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
      const result = await registry.call('studio.scene.analyze', ctx.input, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      const value = (result as { value: Record<string, unknown> }).value;
      expect((value['intakeResample'] as { applied: boolean }).applied).toBe(true);

      // 帧流（tasks.artifact 合法引用集）：intake-image.png 先于 scene-analysis.json
      const artifactFrames = ctx.s.jobs
        .frames(ctx.s.anonymous, ctx.taskId, 0)
        .frames.filter((frame) => frame.kind === 'artifact')
        .map((frame) => frame.payload as { blobRef: string; name: string });
      expect(artifactFrames.map((f) => f.name)).toEqual(['intake-image.png', 'scene-analysis.json']);
      // 帧流锚点图 blobRef 可解析 → 40×30（下游帧流消费者同源）
      const intakeFrame = artifactFrames[0]!;
      const frameBytes = ctx.s.blobs.read(intakeFrame.blobRef);
      expect(frameBytes).not.toBeNull();
      const decoded = decodePng(frameBytes!);
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 40, height: 30 });
      // scene-analysis 工件帧 = 结果面 artifactBlobRef；锚点一致
      expect(artifactFrames[1]!.blobRef).toBe(value['artifactBlobRef']);
      const analysis = value['analysis'] as { imagePx: { width: number; height: number } };
      expect(analysis.imagePx).toEqual({ width: 40, height: 30 });
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- W1 intake 调用时解析（add-image-processing-settings §5.1）

describe('scene.analyze intakeConfigProvider（调用时解析——改设置不重启）', () => {
  /** 高密度 fixture 同 W1（80×60 @ 1.6×1.2cm = 50px/cm）。 */
  function denseCtx(): Ctx {
    const ctx = setup(80, 60);
    ctx.input.canvasCm = { w: 1.6, h: 1.2 };
    return ctx;
  }

  it('同实例两次 analyze 之间换 provider 返回值 → 第二次用新 ppcm（每次调用解析）', async () => {
    const ctx = denseCtx();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      let current = { enabled: true, ppcmTarget: 40 };
      let calls = 0;
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        {
          live: true,
          intakeConfigProvider: () => {
            calls++;
            return current;
          },
        },
      );
      const first = await analyzer.analyze(ctx.input);
      expect(first.intakeResample).toMatchObject({ applied: true, imagePx: { width: 64, height: 48 } }); // 50→40px/cm
      current = { enabled: true, ppcmTarget: 25 };
      const second = await analyzer.analyze(ctx.input);
      expect(second.intakeResample).toMatchObject({ applied: true, imagePx: { width: 40, height: 30 } }); // 50→25px/cm
      expect(calls).toBeGreaterThanOrEqual(2); // 每次取值（不缓存）
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('直注 intakeConfig 保留且优先：provider 不被调用（现有测试注入面零改动兼容）', async () => {
    const ctx = denseCtx();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      let providerCalls = 0;
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        {
          live: true,
          intakeConfig: { enabled: true, ppcmTarget: 40 },
          intakeConfigProvider: () => {
            providerCalls++;
            return { enabled: true, ppcmTarget: 25 };
          },
        },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.intakeResample).toMatchObject({ applied: true, imagePx: { width: 64, height: 48 } });
      expect(providerCalls).toBe(0);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('设置驱动（kernel 装配同款闭包）：analyze 之间保存快速档 → 第二次按 15px/cm 降采', async () => {
    const ctx = denseCtx();
    const gw = await startMockGateway(() => ({ text: ELEMENTS_JSON }));
    try {
      wireLlm(ctx, gw.port);
      // kernel/index.ts 装配注入的闭包形状（imageProcessingEffective(db) 投影）
      const intakeConfigProvider = () => {
        const v = imageProcessingEffective(ctx.s.db, {});
        return { enabled: v.resampleEnabled, ppcmTarget: v.ppcmTarget };
      };
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true, intakeConfigProvider },
      );
      // 未保存 → default=性能档 25 → 40×30
      const before = await analyzer.analyze(ctx.input);
      expect(before.intakeResample).toMatchObject({ applied: true, imagePx: { width: 40, height: 30 } });
      // 保存快速档（15px/cm）→ 同实例下一次 analyze 立即用新值
      saveImageProcessing(ctx.s.db, { preset: 'fast' }, {});
      const after = await analyzer.analyze(ctx.input);
      expect(after.intakeResample).toMatchObject({ applied: true, imagePx: { width: 24, height: 18 } }); // 50→15px/cm
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
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

// ---------------------------------------------------------------- 2.5 路由统一（settings 真源 + 三协议）

/**
 * 协议感知网关（2.5）：记录 {url, headers, body}，按当前路由协议回协议同形响应——
 * openai-completions {choices[]} / anthropic-messages {content[]} / openai-responses
 * {output_text}。body 固定回 ELEMENTS_JSON（走 extractLlmContentText 协议分支）。
 */
interface ProtocolGateway {
  server: Server;
  port: number;
  requests: Array<{ url: string; headers: Record<string, string>; body: string }>;
  stop(): Promise<void>;
}

function startProtocolGateway(script: () => { ok: boolean }): Promise<ProtocolGateway> {
  const requests: ProtocolGateway['requests'] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      requests.push({ url: request.url ?? '', headers, body });
      const step = script();
      if (!step.ok) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('boom');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url?.endsWith('/v1/messages')) {
        response.end(JSON.stringify({ content: [{ type: 'text', text: ELEMENTS_JSON }] }));
        return;
      }
      if (request.url?.endsWith('/responses')) {
        response.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: ELEMENTS_JSON }] }] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ELEMENTS_JSON } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
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

describe('scene.analyze 路由统一（split-admin-portal 2.5——后台多路由真源）', () => {
  it('settings anthropic-messages 命中：/v1/messages + x-api-key + source base64 图块（env 全空——真源即 settings）', async () => {
    const ctx = setup();
    const gw = await startProtocolGateway(() => ({ ok: true }));
    try {
      saveModelsConfig(ctx.s.db, {
        routes: [
          {
            provider: 'zai-prod',
            api: 'anthropic-messages',
            baseURL: `http://127.0.0.1:${gw.port}`,
            apiKey: 'sk-test-anthropic',
            models: [{ id: 'glm-5.3v' }],
          },
        ],
        default: { provider: 'zai-prod', model: 'glm-5.3v' },
      });
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('llm-route');
      expect(outcome.meta.model).toBe('glm-5.3v'); // 路由默认模型（visionModel 未配）
      expect(gw.requests).toHaveLength(1);
      const hit = gw.requests[0]!;
      expect(hit.url).toBe('/v1/messages');
      expect(hit.headers['x-api-key']).toBe('sk-test-anthropic');
      expect(hit.headers['anthropic-version']).toBe('2023-06-01');
      const sent = JSON.parse(hit.body) as {
        model: string;
        max_tokens: number;
        temperature: number;
        messages: Array<{ role: string; content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> }>;
      };
      expect(sent.model).toBe('glm-5.3v');
      expect(sent.temperature).toBe(0);
      const imageBlock = sent.messages[0]!.content.find((block) => block.type === 'image');
      expect(imageBlock?.source?.type).toBe('base64');
      expect(imageBlock?.source?.media_type).toBe('image/png');
      expect(imageBlock?.source?.data).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(outcome.analysis.elements).toHaveLength(2);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('settings openai-responses 命中：/responses + Bearer + input_image data URL；output_text 抽取', async () => {
    const ctx = setup();
    const gw = await startProtocolGateway(() => ({ ok: true }));
    try {
      saveModelsConfig(ctx.s.db, {
        routes: [
          {
            provider: 'openai-prod',
            api: 'openai-responses',
            baseURL: `http://127.0.0.1:${gw.port}/v1`,
            apiKey: 'sk-test-responses',
            models: [{ id: 'gpt-vision' }, { id: 'gpt-other' }],
          },
        ],
        default: null, // 无默认 → 首路由首模型
      });
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true, visionModel: 'gpt-vision' },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('llm-route');
      expect(outcome.meta.model).toBe('gpt-vision');
      const hit = gw.requests[0]!;
      expect(hit.url).toBe('/v1/responses');
      expect(hit.headers['authorization']).toBe('Bearer sk-test-responses');
      const sent = JSON.parse(hit.body) as {
        input: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string }> }>;
        max_output_tokens: number;
      };
      const imageBlock = sent.input[0]!.content.find((block) => block.type === 'input_image');
      expect(imageBlock?.image_url).toMatch(/^data:image\/png;base64,/);
      expect(outcome.analysis.elements).toHaveLength(2);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('已初始化空路由集不回退 .env（P1-3 真源意图）：env 完整也 typed 拒+零外呼', async () => {
    const ctx = setup();
    const gw = await startProtocolGateway(() => ({ ok: true }));
    try {
      saveModelsConfig(ctx.s.db, { routes: [], default: null }); // 显式清空=「未配置」
      wireLlm(ctx, gw.port); // .env 旧链完整（指向可达网关）
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const error = await capture(analyzer.analyze(ctx.input));
      expect(error.kind).toBe('llm-route-unconfigured');
      expect(gw.requests).toHaveLength(0); // .env 不复活（v6 复核 P1-3）
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });

  it('env 迁移引导语义：settings 从未初始化+env 完整 → loadRoutes 收编物化（后续读面同源）', async () => {
    const ctx = setup();
    const gw = await startProtocolGateway(() => ({ ok: true }));
    try {
      wireLlm(ctx, gw.port);
      const analyzer = new SceneAnalyzer(
        { db: ctx.s.db, blobs: ctx.s.blobs, dataRoot: ctx.s.config.dataRoot, llm: ctx.s.config.llm },
        { live: true },
      );
      const outcome = await analyzer.analyze(ctx.input);
      expect(outcome.channel).toBe('llm-route');
      expect(gw.requests[0]?.url).toBe('/v1/chat/completions'); // openai-completions 线面（wireLlm 缺省协议，baseUrl 带 /v1 前缀）
      // 迁移物化断言：settings 读面出现 env 收编路由（zhumo「首次读取时物化」同款）。
      const config = loadModelsConfig(ctx.s.db, ctx.s.config.llm);
      expect(config.routes[0]?.provider).toBe('zai');
      expect(config.routes[0]?.hasKey).toBe(true);
    } finally {
      await gw.stop();
      ctx.s.dispose();
    }
  });
});
