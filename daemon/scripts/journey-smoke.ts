#!/usr/bin/env tsx
/**
 * 旅程全链冒烟（add-subject-sam-pipeline P3.3 验收——手动跑不进 CI）。
 * 形态=kernel-live 先例（tests/kernel-live.test.ts）：进程内 boot **真实 dsh 内核**
 * （HandicraftKernel+McpListener+真实 JobService/SessionService/SQLite/BlobStore，
 * 隔离 DATA_ROOT）+ **本地 mock openai-completions 网关**（127.0.0.1——与真实网关
 * 线协议同构，仅地址/key 替换）+ **mock SAM 桥注入**（kernel samTransport 注入缝——
 * macmini 真连已 P2.6 验证，本冒烟不占 macmini）。
 * 旅程（真内核 followup，一封多轮）：
 *   用户「把这束花按枝条贴」+附件图（花束 736×736，脚本转 PNG 后入 blob）
 *   → agent（网关编程步进）调 mcp__studio__scene_analyze（通道 A 桥 unimplemented
 *     →显式降通道 B=mock 网关视觉调用；elements=花束/缎带/枝叶 固定）
 *   → mcp__studio__subject_segment（P3.3 工具：S2 工件驱动 P2.4 循环——mock 桥
 *     box→内切椭圆/bouquet 文本→中央椭圆=花心/其余文本→零检出；object-tree.json
 *     +预览 PNG 双工件+artifact 帧）
 *   → mcp__studio__strategy_design propose（mock 网关策略步：解析 prompt 可贴节点
 *     清单+钻候选表→固定指派 花束=soft-curve/花束·部分=flower/缎带=geometry star/
 *     其余 exclusion——严格按 prompt 契约返回）
 *   → approval-request 帧（指派表 diff）→ **session.answer 批准**（ApprovalService
 *     真身——rpc session.answer 同一服务面；网关步进钩子在 execute 步前同步签发）
 *   → mcp__studio__strategy_design execute（consumeForExecution→逐节点真执行+引擎
 *     校验门+三工件 plan/gems/叠加 PNG）
 *   → 收尾文本 → task done。
 * 断言链：S2 工件三元素→树工件（≥4 节点+预览解码）+artifact 帧位置→approval-request
 * /resolved 帧→三工件 gems 非空+excludedRegions 非空+plan 覆盖=producing 全集。
 * 产物全部留存 OUT_DIR（全部工件+帧流摘要+耗时）；finally 杀全部进程面+零残留证据。
 * 用法：cd daemon && ./node_modules/.bin/tsx scripts/journey-smoke.ts
 *   环境覆盖：JOURNEY_IMAGE / JOURNEY_OUT（缺省 experiments/sam3-spike-20260924/
 *   5836eeaf1001d6a1e8d9dd245f641099.jpg / 贴钻/experiments/journey-20260925）。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { Frame } from '@handicraft/contracts';
import {
  ObjectTreeSchema,
  SceneAnalysisSchema,
  StrategyPlanSchema,
  SupplierSkuProfileSchema,
} from '@handicraft/contracts';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from '../src/config.js';
import { openDatabase, type SqliteDb } from '../src/db/database.js';
import { ensureAnonymousUser } from '../src/auth.js';
import { BlobStore } from '../src/db/blobs.js';
import { JobService } from '../src/jobs/service.js';
import { SessionService } from '../src/sessions/service.js';
import { generateJob } from '../src/jobs/generate.js';
import { engineJob } from '../src/jobs/engine.js';
import { runSleepJob } from '../src/jobs/sleep-job.js';
import { HandicraftKernel } from '../src/kernel/index.js';
import { McpListener } from '../src/mcp.js';
import { createStudioMcpServer } from '../src/capability/mcp.js';
import { StoneService } from '../src/stones/service.js';
import { decodePng, encodePng } from '../src/png/codec.js';
import { SamBridgeError, type SamTransport } from '../src/kernel/vision/sam-bridge.js';

// ---------------------------------------------------------------- 常量（现场锚定）

const OUT_DIR = process.env.JOURNEY_OUT ?? '/Users/kzf/Pictures/贴钻/experiments/journey-20260925';
const INPUT_IMAGE =
  process.env.JOURNEY_IMAGE ??
  '/Users/kzf/Pictures/贴钻/experiments/sam3-spike-20260924/5836eeaf1001d6a1e8d9dd245f641099.jpg';
/** 画布声明（花束单 20×20cm，图 736×736——S1 尺寸锚点）。 */
const CANVAS_CM = { w: 20, h: 20 };
/** 循环硬顶（iter0 元素轮+iter1/2 细分+iter3 硬顶封停——控时长且必终止）。 */
const MAX_ITERATIONS = 3;
const MAX_GEM_DIAMETER_MM = 3;
/** followup 兜底超时 300s+余量（看门狗在内核侧——此处只做观测等待界）。 */
const FRAME_WAIT_MS = 240_000;

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/** 逐步耗时（断言链各环）。 */
const timings: Array<{ step: string; ms: number }> = [];
function mark(step: string): void {
  timings.push({ step, ms: Date.now() - startedAt });
}
let startedAt = Date.now();

// ---------------------------------------------------------------- mock LLM 网关

/** 旅程步（agent SSE 流的下一动作）。 */
interface MockStep {
  text?: string;
  toolCall?: { name: string; arguments: string };
}

/** S2 固定元素清单（mock 视觉步——按 prompt 契约返回）。 */
function sceneElementsJson(): string {
  return JSON.stringify({
    elements: [
      {
        name: '花束',
        category: 'flower',
        boxPx: { x: 138, y: 120, w: 460, h: 430 },
        hint: 'bouquet',
        suggestDrillWorthy: true,
        confidence: 0.92,
      },
      {
        name: '缎带',
        category: 'object',
        boxPx: { x: 48, y: 560, w: 320, h: 110 },
        hint: 'ribbon',
        suggestDrillWorthy: true,
        confidence: 0.88,
      },
      {
        name: '枝叶',
        category: 'foliage',
        boxPx: { x: 60, y: 60, w: 640, h: 620 },
        hint: 'foliage',
        suggestDrillWorthy: false,
        confidence: 0.85,
      },
    ],
  });
}

/**
 * S6 策略步（按 prompt 契约动态装配——解析「可贴节点清单」与「钻候选表」）：
 * 花束=soft-curve（枝条贴）/ 花束·部分*=flower（花心区域）/ 缎带=geometry star /
 * 其余=exclusion；非 exclusion 指派最小有尺寸候选钻+density 9。
 */
function strategyPlanJson(prompt: string): string {
  const lines = prompt.split('\n');
  const section = (start: string, end: string): string[] => {
    const i = lines.findIndex((l) => l.startsWith(start));
    if (i < 0) return [];
    const out: string[] = [];
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith(end); j++) {
      if (/^\s*- /.test(lines[j]!)) out.push(lines[j]!); // 节点行按深度缩进（depth×2 空格）
    }
    return out;
  };
  const nodes = section('可贴节点清单', '层级节点清单').map((line) => {
    const hit = /^\s*- (sam-node-\d+) (.+?)(?:（父：.+?）)? \[/.exec(line);
    return hit ? { id: hit[1]!, name: hit[2]! } : null;
  }).filter((n): n is { id: string; name: string } => n !== null);
  const candidates = section('钻候选表', '策略族').map((line) => {
    const hit = /^\s*- (\d+) \S+\/\S+ (\d+(?:\.\d+)?)mm /.exec(line);
    return hit ? { idx: Number(hit[1]), sizeMm: Number(hit[2]) } : null;
  }).filter((c): c is { idx: number; sizeMm: number } => c !== null);
  const sized = candidates.filter((c) => Number.isFinite(c.sizeMm));
  const smallest = sized.length > 0 ? sized.reduce((a, b) => (b.sizeMm < a.sizeMm ? b : a)) : undefined;
  const assignments = nodes.map((node) => {
    if (node.name === '花束') {
      return {
        nodeId: node.id,
        strategyKind: 'soft-curve',
        params: {},
        stoneIdx: smallest !== undefined ? [smallest.idx] : [1],
        densityPerCm2: 2.3,
        rationale: '花束主体沿枝条骨架柔和曲线贴钻（用户指令：按枝条贴）',
      };
    }
    if (node.name.startsWith('花束·')) {
      return {
        nodeId: node.id,
        strategyKind: 'flower',
        params: { petals: 8, coreRadiusRatio: 0.3, petalDensity: 1 },
        stoneIdx: smallest !== undefined ? [smallest.idx] : [1],
        densityPerCm2: 2.3,
        rationale: '花束细分出的花心区域用花形极坐标布钻',
      };
    }
    if (node.name === '缎带') {
      return {
        nodeId: node.id,
        strategyKind: 'geometry',
        params: { shape: 'star', rays: 5, innerRadiusRatio: 0.4, rotationDeg: 270 },
        stoneIdx: smallest !== undefined ? [smallest.idx] : [1],
        densityPerCm2: 2.3,
        rationale: '缎带饰面用五角星参数化几何点缀',
      };
    }
    return {
      nodeId: node.id,
      strategyKind: 'exclusion',
      params: { reason: '枝叶细碎不值得贴钻，保留底图' },
      rationale: '枝叶类排除不贴（显式指派——不留悬空区）',
    };
  });
  return JSON.stringify({ assignments });
}

/** 网关运行时钩子面（内核/会话就绪后回填——answer 在 execute 步前同步签发）。 */
interface GatewayRuntime {
  answerApproval?: () => { requestId: string; approved: boolean; result?: string } | { error: string };
  taskId?: string;
  sessionId?: string;
}

const runtime: GatewayRuntime = {};
const gatewayLog: Array<{ kind: string; detail: string }> = [];

/** agent 步进（按对话状态分支——确定性，对重发幂等）。 */
function agentStepOf(body: string, corpus: string): MockStep {
  // 工具结果文本为 pretty JSON（": " 带空格）——探针一律空白容忍；corpus=解析后的
  // 消息内容拼接（真实换行/引号——非 HTTP 线转义形态）。
  const hasScene = /"artifactBlobRef":\s*"[0-9a-f]{64}"/.test(corpus);
  const hasTree = /"treeArtifactRef":\s*"[0-9a-f]{64}"/.test(corpus);
  const hasProposal = /"proposalId":\s*"[0-9a-f-]{36}"/.test(corpus);
  const hasExecuted = /"planBlobRef":\s*"[0-9a-f]{64}"/.test(corpus);
  const taskId = /taskId=([0-9a-f-]{36})/.exec(corpus)?.[1] ?? '';
  const blobRef = /附件 1 个：([0-9a-f]{64})/.exec(corpus)?.[1] ?? '';
  if (!hasScene) {
    gatewayLog.push({ kind: 'agent-step', detail: 'scene_analyze' });
    return {
      toolCall: {
        name: 'mcp__studio__scene_analyze',
        arguments: JSON.stringify({
          taskId,
          imageBlobRef: blobRef,
          canvasCm: CANVAS_CM,
          imagePx: { width: 736, height: 736 },
        }),
      },
    };
  }
  if (!hasTree) {
    const sceneRef = /"artifactBlobRef":\s*"([0-9a-f]{64})"/.exec(corpus)![1]!;
    gatewayLog.push({ kind: 'agent-step', detail: 'subject_segment' });
    return {
      toolCall: {
        name: 'mcp__studio__subject_segment',
        arguments: JSON.stringify({
          taskId,
          sceneAnalysisRef: sceneRef,
          imageBlobRef: blobRef,
          canvasCm: CANVAS_CM,
          imagePx: { width: 736, height: 736 },
          maxIterations: MAX_ITERATIONS,
          maxGemDiameterMm: MAX_GEM_DIAMETER_MM,
        }),
      },
    };
  }
  if (!hasProposal) {
    const treeRef = /"treeArtifactRef":\s*"([0-9a-f]{64})"/.exec(corpus)![1]!;
    gatewayLog.push({ kind: 'agent-step', detail: 'strategy_design propose' });
    return {
      toolCall: {
        name: 'mcp__studio__strategy_design',
        arguments: JSON.stringify({
          taskId,
          treeArtifactRef: treeRef,
          instruction: '把这束花按枝条贴：花束主体沿枝条、花心区域花形、缎带星形、枝叶不贴',
        }),
      },
    };
  }
  if (!hasExecuted) {
    const proposalId = /"proposalId":\s*"([0-9a-f-]{36})"/.exec(corpus)![1]!;
    const answer = runtime.answerApproval?.() ?? { error: 'answer 钩子未装配' };
    gatewayLog.push({ kind: 'session.answer', detail: JSON.stringify(answer) });
    if ('error' in answer) throw new Error(`批准失败：${answer.error}`);
    gatewayLog.push({ kind: 'agent-step', detail: 'strategy_design execute' });
    return {
      toolCall: {
        name: 'mcp__studio__strategy_design',
        arguments: JSON.stringify({ taskId, proposalId }),
      },
    };
  }
  gatewayLog.push({ kind: 'agent-step', detail: 'final text' });
  return {
    text:
      '已完成「把这束花按枝条贴」全链：识图（花束/缎带/枝叶）→ 迭代抠图成树 → 逐图层策略设计'
      + '（花束=柔和曲线、花心=花形、缎带=星形、枝叶=排除）→ 已获批准并执行，三工件（策略计划/钻点/叠加预览）已入任务工件域。',
  };
}

/** 本地 openai-completions mock 网关（agent=SSE 流 / 工具面=非流 JSON——kernel-live 同款）。 */
function startMockGateway(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3-flash' }] }));
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      let parsedBody: { messages?: Array<{ content?: unknown }>; stream?: boolean } | null = null;
      try {
        const raw: unknown = JSON.parse(body);
        parsedBody = raw as { messages?: Array<{ content?: unknown }>; stream?: boolean };
      } catch {
        parsedBody = null;
      }
      const corpus = (parsedBody?.messages ?? [])
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null)))
        .join('\n');
      // —— 工具面 LLM 调用（stream:false）：scene.analyze 视觉步 / strategy.design 策略步
      if (parsedBody?.stream !== true) {
        let content: string | null = null;
        if (corpus.includes('全图语义分析器')) {
          content = sceneElementsJson();
          gatewayLog.push({ kind: 'llm-scene-analyze', detail: '固定 elements=花束/缎带/枝叶' });
        } else if (corpus.includes('策略设计师')) {
          content = strategyPlanJson(corpus);
          gatewayLog.push({ kind: 'llm-strategy-design', detail: `prompt ${corpus.length} 字符 → 动态指派表` });
        }
        if (content !== null) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
          );
          return;
        }
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'journey mock：未识别的非流调用' } }));
        return;
      }
      // —— agent 会话步（SSE——kernel-live 同款线形态）
      const step = agentStepOf(body, corpus);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (payload: unknown): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      if (step.text !== undefined && step.text !== '') {
        const mid = Math.ceil(step.text.length / 2);
        send({ choices: [{ delta: { content: step.text.slice(0, mid) } }] });
        send({ choices: [{ delta: { content: step.text.slice(mid) } }] });
      }
      if (step.toolCall !== undefined) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `mock_${Date.now()}`,
                    type: 'function',
                    function: { name: step.toolCall.name, arguments: step.toolCall.arguments },
                  },
                ],
              },
            },
          ],
        });
      }
      send({
        choices: [{ delta: {}, finish_reason: step.toolCall !== undefined ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

// ---------------------------------------------------------------- mock SAM 桥（注入缝）

/**
 * 旅程 mock 桥（kernel samTransport 注入缝——不占 macmini）：
 * analyze → unimplemented（scene.analyze 通道 A 显式降通道 B=P2.6 live 同款行为）；
 * segment 几何 box → box 内切椭圆（score 0.85）；文本含 bouquet → 画布中央椭圆
 * （score 0.75——父∩子=花心区域，驱动细分轮）；其余文本 → 全零掩码（零检出）。
 */
function journeySamTransport(): SamTransport {
  const ellipse = (w: number, h: number, cx: number, cy: number, rx: number, ry: number): Uint8Array => {
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / Math.max(rx, 0.5);
        const dy = (y - cy) / Math.max(ry, 0.5);
        if (dx * dx + dy * dy <= 1) bits[y * w + x] = 1;
      }
    }
    return bits;
  };
  const inline = (w: number, h: number, bits: Uint8Array) => ({
    kind: 'inline' as const,
    w,
    h,
    encoding: 'base64-01' as const,
    data: Buffer.from(bits).toString('base64'),
  });
  return {
    async send(call) {
      const request = call.request;
      const { width, height } = request.imagePx;
      const meta = { model: 'sam3-mock@journey', durationMs: 1, iteration: request.iteration };
      if (request.kind === 'analyze') {
        throw new SamBridgeError('旅程 mock 桥不支持 analyze（unimplemented）——scene.analyze 走 LLM 路由', 'unimplemented');
      }
      if (request.prompt.kind === 'geometric' && request.prompt.box !== undefined) {
        const { box } = request.prompt;
        return {
          kind: 'segment',
          mask: inline(width, height, ellipse(width, height, box.x + box.w / 2, box.y + box.h / 2, (box.w - 2) / 2, (box.h - 2) / 2)),
          score: 0.85,
          meta,
        };
      }
      if (request.prompt.kind === 'text' && request.prompt.text.includes('bouquet')) {
        const radius = (Math.min(width, height) / 2) * 0.3;
        return {
          kind: 'segment',
          mask: inline(width, height, ellipse(width, height, width / 2, height / 2, radius, radius)),
          score: 0.75,
          meta,
        };
      }
      return {
        kind: 'segment',
        mask: inline(width, height, new Uint8Array(width * height)),
        meta,
      };
    },
  };
}

// ---------------------------------------------------------------- 钻规格种子（S1 候选面）

/** 128×128 灰色圆盘纹理（texture gate 下限过——strategy-design.test 同款）。 */
function stoneTextureBytes(): Uint8Array {
  const size = 128;
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= r * r) {
        const p = (y * size + x) * 4;
        rgba[p] = 200;
        rgba[p + 1] = 200;
        rgba[p + 2] = 200;
        rgba[p + 3] = 255;
      }
    }
  }
  return new Uint8Array(encodePng(size, size, rgba));
}

const YUHANG_PROFILE: Parameters<StoneService['createStone']>[0]['supplierProfile'] =
  SupplierSkuProfileSchema.parse({
    supplier: 'yuhang',
    displayName: '钰航（旅程冒烟）',
    bands: [{ rows: [51, 78], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } }],
    styleKey: 'row',
  });

function seedStones(db: SqliteDb, blobs: BlobStore, ownerId: string): void {
  const stones = new StoneService({ db, blobs });
  const texture = stoneTextureBytes();
  for (const [sku, sizeMm, rgb, family] of [
    ['A52', 3, [200, 40, 40], '红色系'],
    ['J51', 2, [240, 240, 232], '白色系'],
  ] as const) {
    stones.createStone({
      ownerId,
      supplierProfile: YUHANG_PROFILE,
      draft: {
        name: `${sku} 钻`,
        sku,
        sizeMm,
        color: { name: '旅程冒烟色', rgb: [...rgb], family, finish: 'glossy' },
        texture: { declaredWidth: 128, declaredHeight: 128 },
      },
      textureBytes: texture,
    });
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  startedAt = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });
  const dataRoot = path.join(OUT_DIR, 'data-root');
  mkdirSync(dataRoot, { recursive: true });

  // —— 原图 JPEG→PNG（daemon png codec 仅 PNG；sips 本地转换——mock 掩码确定性，
  //    色彩保真不构成旅程断言面【对照：P2.6 真连用 macmini PIL 保真】）
  const pngPath = path.join(OUT_DIR, 'input.png');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', INPUT_IMAGE, '--out', pngPath], { stdio: 'pipe' });
  const { readFileSync } = await import('node:fs');
  const pngBytes = new Uint8Array(readFileSync(pngPath));
  const decoded = decodePng(pngBytes);
  if (decoded.width !== 736 || decoded.height !== 736) {
    throw new Error(`输入图非 736×736（${decoded.width}×${decoded.height}）——旅程锚点漂移`);
  }
  log(`输入图就绪：${pngPath}（${decoded.width}×${decoded.height}，画布 ${CANVAS_CM.w}×${CANVAS_CM.h}cm）`);
  mark('input-ready');

  // —— live 门 env 先置（SceneAnalyzer/StrategyDesigner 构造期读取 process.env）
  process.env.SAM_ANALYZE_LIVE = '1';
  process.env.STRATEGY_DESIGN_LIVE = '1';

  const { server, port: gatewayPort } = await startMockGateway();
  log(`mock LLM 网关：127.0.0.1:${gatewayPort}`);

  const config = loadConfig({
    envFile: path.join(OUT_DIR, 'app', '.env'),
    processEnv: {
      DATA_ROOT: dataRoot,
      WEBUI_DIR: path.join(OUT_DIR, 'webui'),
      JWT_SECRET: 'journey-smoke-secret',
      IMG_DRY_RUN: '1',
      LLM_PROVIDER: 'zai',
      LLM_API: 'openai-completions',
      LLM_MODEL: 'glm-5.3-flash',
      LLM_API_KEY: 'mock-gateway-key',
    },
  });
  (config.llm as { baseUrl: string }).baseUrl = `http://127.0.0.1:${gatewayPort}/v1`;

  const db = openDatabase(config.dataRoot);
  const anonymous = ensureAnonymousUser(db);
  const blobs = new BlobStore(config.dataRoot, db);
  const jobs = new JobService({ config, db, blobs }, { sleep: { run: runSleepJob }, generate: generateJob, engine: engineJob });
  const sessions = new SessionService({ config, db, blobs, jobs });

  seedStones(db, blobs, anonymous.id);
  log('钻规格种子：A52 3mm 红色系 / J51 2mm 白色系（S1 候选面）');
  mark('stones-seeded');

  const imageBlobRef = blobs.put(pngBytes).hash;
  const kernel = new HandicraftKernel({
    config,
    db,
    jobs,
    sessions,
    blobs,
    samTransport: journeySamTransport(),
  });
  const mcpHandler = createMcpHandler(() => createStudioMcpServer({ capabilities: kernel.capabilities }), {
    legacy: 'stateless',
  });
  const mcpToken = randomBytes(24).toString('hex');
  const mcp = new McpListener({
    port: 0,
    host: '127.0.0.1',
    kernelState: () => kernel.state,
    token: mcpToken,
    tokenFile: path.join(config.dataRoot, 'mcp-token'),
    handle: toNodeHandler(mcpHandler),
  });
  const mcpPort = await mcp.listen();
  await kernel.boot({ url: `http://127.0.0.1:${mcpPort}/mcp`, token: mcpToken });
  if (kernel.state !== 'ready') throw new Error(`内核未就绪（${kernel.state}）：${kernel.reason}`);
  log(`内核 ready：${kernel.reason}（MCP=127.0.0.1:${mcpPort}）`);
  // MCP 工具注册栅栏（followup 内也有——此处显式留证：subject_segment 在册）
  const deadline = Date.now() + 20000;
  while (!kernel.debugToolNames().some((name) => name === 'mcp__studio__subject_segment')) {
    if (Date.now() > deadline) throw new Error('MCP 工具面 20s 内未完成注册（mcp__studio__subject_segment 缺席）');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const toolCount = kernel.debugToolNames().filter((n) => n.startsWith('mcp__studio__')).length;
  log(`MCP studio 工具面就绪：${toolCount} 工具（含 mcp__studio__subject_segment）`);
  mark('kernel-ready');

  const { sessionId } = sessions.create(anonymous, { title: '旅程冒烟：把这束花按枝条贴' });
  runtime.sessionId = sessionId;
  // answer 钩子真身：从帧流取 approval-request → ApprovalService.answer（rpc session.answer 同一服务面）
  runtime.answerApproval = () => {
    const taskId = runtime.taskId;
    if (taskId === undefined) return { error: 'followup 尚未返回 taskId' };
    const framesNow = jobs.frames(anonymous, taskId, 0).frames;
    const request = framesNow.find((f) => f.kind === 'approval-request') as
      | { payload: { requestId: string } }
      | undefined;
    if (request === undefined) return { error: '帧流未见 approval-request' };
    const resolved = framesNow.find(
      (f) => f.kind === 'approval-resolved' && (f.payload as { requestId: string }).requestId === request.payload.requestId,
    );
    if (resolved !== undefined) return { requestId: request.payload.requestId, approved: true, result: '已批准（幂等重入——不重放应答）' };
    const answered = kernel.approvals.answer(anonymous, {
      sessionId,
      requestId: request.payload.requestId,
      approved: true,
    });
    return {
      requestId: request.payload.requestId,
      approved: true,
      result: JSON.stringify(answered).slice(0, 200),
    };
  };

  const { taskId } = await kernel.followup(anonymous, sessionId, {
    text: '把这束花按枝条贴',
    attachments: [imageBlobRef],
  });
  runtime.taskId = taskId;
  log(`followup：sessionId=${sessionId} taskId=${taskId}`);
  mark('followup-accepted');

  // —— 收口面（任何路径必经——含断言异常；进程 finally 杀+零残留证据）
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await kernel.stop();
      await mcp.stop(500);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      log('内核/MCP/mock 网关/db 全部收口（进程内零常驻；唯一子进程 sips 已同步退出）');
    } catch (cleanupError) {
      console.error('[journey-smoke] 收口异常（不掩盖主错误）', cleanupError);
    }
    try {
      const ps = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' });
      const leftovers = ps
        .split('\n')
        .filter((line) => /journey-smoke|sam3_service|mlx_sam3/.test(line) && !/grep/.test(line));
      console.log(`零残留自证（journey/sam3 相关进程）：${leftovers.length === 0 ? '无' : `\n${leftovers.join('\n')}`}`);
    } catch {
      // ps 失败不阻塞退出
    }
  };

  try {
  // —— 帧流等待终态（done/error）
  let frames: Frame[] = [];
  const waitOk = await (async (): Promise<boolean> => {
    const until = Date.now() + FRAME_WAIT_MS;
    while (Date.now() < until) {
      frames = jobs.frames(anonymous, taskId, 0).frames;
      if (frames.some((f) => f.kind === 'done' || f.kind === 'error')) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  })();
  if (!waitOk) throw new Error(`帧流 ${FRAME_WAIT_MS}ms 未达终态（已收 ${frames.length} 帧）`);
  mark('frames-settled');

  // —— 断言链（旅程各环——失败=非零退出，不伪造通过）
  const assertions: Array<{ step: string; ok: boolean; detail: string }> = [];
  const assert = (step: string, ok: boolean, detail: string): void => {
    assertions.push({ step, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${step}：${detail}`);
  };
  const toolTexts = frames
    .filter((f) => f.kind === 'transcript' && (f.payload as { role: string }).role === 'tool')
    .map((f) => (f.payload as { text: string }).text);
  const allToolText = toolTexts.join('\n');

  // [1] S2 scene-analysis 工件（三元素固定）
  const sceneRef = /"artifactBlobRef":\s*"([0-9a-f]{64})"/.exec(allToolText)?.[1];
  assert('scene-analysis 工件', sceneRef !== undefined, sceneRef !== undefined ? `blobRef=${sceneRef.slice(0, 12)}…` : '工具结果未含 artifactBlobRef');
  const sceneDoc = sceneRef !== undefined ? SceneAnalysisSchema.parse(JSON.parse(blobs.read(sceneRef)!.toString('utf8'))) : null;
  assert(
    'S2 elements=花束/缎带/枝叶',
    sceneDoc !== null && ['花束', '缎带', '枝叶'].every((name) => sceneDoc.elements.some((e) => e.name === name)),
    sceneDoc !== null ? `${sceneDoc.elements.length} 元素：${sceneDoc.elements.map((e) => e.name).join('/')}` : '工件缺失',
  );
  mark('assert-scene');

  // [2] subject.segment 树工件+预览+artifact 帧位置
  const treeRef = /"treeArtifactRef":\s*"([0-9a-f]{64})"/.exec(allToolText)?.[1];
  const previewRef = /"previewRef":\s*"([0-9a-f]{64})"/.exec(allToolText)?.[1];
  const tree = treeRef !== undefined ? ObjectTreeSchema.parse(JSON.parse(blobs.read(treeRef)!.toString('utf8'))) : null;
  assert(
    'object-tree 工件（≥4 节点）',
    tree !== null && tree.nodes.length >= 4,
    tree !== null ? `${tree.nodes.length} 节点：${tree.nodes.map((n) => n.objectName).join('/')}` : '工件缺失',
  );
  const previewDecoded = previewRef !== undefined ? decodePng(blobs.read(previewRef)!) : null;
  assert(
    'object-tree 预览 PNG',
    previewDecoded !== null && previewDecoded.width === 736,
    previewDecoded !== null ? `${previewDecoded.width}×${previewDecoded.height}` : '预览缺失',
  );
  const artifactFrames = frames
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.kind === 'artifact')
    .map(({ f, i }) => ({ seq: f.seq, index: i, name: (f.payload as { name?: string }).name ?? '', blobRef: (f.payload as { blobRef?: string }).blobRef ?? '' }));
  assert(
    'artifact 帧登记（object-tree.json/preview.png）',
    artifactFrames.some((a) => a.name === 'object-tree.json' && a.blobRef === treeRef)
      && artifactFrames.some((a) => a.name === 'object-tree-preview.png' && a.blobRef === previewRef),
    `帧位置：${JSON.stringify(artifactFrames)}`,
  );
  mark('assert-segment');

  // [3] approval-request（指派表）/ approval-resolved 帧
  const approvalRequest = frames.find((f) => f.kind === 'approval-request') as
    | { seq: number; payload: { requestId: string; tool: string; proposalId: string; summary: string; preview: { before: string; after: string } } }
    | undefined;
  assert(
    'approval-request 帧（studio.strategy.design）',
    approvalRequest !== undefined && approvalRequest.payload.tool === 'studio.strategy.design',
    approvalRequest !== undefined ? `seq=${approvalRequest.seq} summary=${approvalRequest.payload.summary.slice(0, 80)}` : '帧缺失',
  );
  const afterDoc =
    approvalRequest !== undefined
      ? (JSON.parse(blobs.read(approvalRequest.payload.preview.after)!.toString('utf8')) as { assignments?: unknown[] })
      : null;
  assert(
    'proposal 指派表非空',
    afterDoc !== null && Array.isArray(afterDoc.assignments) && afterDoc.assignments.length > 0,
    afterDoc !== null && Array.isArray(afterDoc.assignments) ? `${afterDoc.assignments.length} 节点指派` : 'preview.after 无 assignments',
  );
  const approvalResolved = frames.find((f) => f.kind === 'approval-resolved') as
    | { payload: { requestId: string; approved: boolean } }
    | undefined;
  assert(
    'session.answer 批准→approval-resolved',
    approvalResolved !== undefined && approvalResolved.payload.approved === true,
    approvalResolved !== undefined ? `requestId=${approvalResolved.payload.requestId} approved=${approvalResolved.payload.approved}` : '帧缺失',
  );
  mark('assert-approval');

  // [4] 执行三工件（plan/gems/叠加 PNG）+gems/excluded/全覆盖
  const planRef = /"planBlobRef":\s*"([0-9a-f]{64})"/.exec(allToolText)?.[1];
  const gemsRef = /"gemsBlobRef":\s*"([0-9a-f]{64})"/.exec(allToolText)?.[1];
  const gemsPreviewRef = /"previewBlobRef":\s*"([0-9a-f]{64})"/.exec(allToolText)?.[1];
  assert('执行三工件引用', planRef !== undefined && gemsRef !== undefined && gemsPreviewRef !== undefined, `plan=${planRef?.slice(0, 12)}… gems=${gemsRef?.slice(0, 12)}… preview=${gemsPreviewRef?.slice(0, 12)}…`);
  const plan = planRef !== undefined ? StrategyPlanSchema.parse(JSON.parse(blobs.read(planRef)!.toString('utf8'))) : null;
  const gemsDoc =
    gemsRef !== undefined
      ? (JSON.parse(blobs.read(gemsRef)!.toString('utf8')) as {
          gems: unknown[];
          excludedRegions: unknown[];
          warnings: unknown[];
        })
      : null;
  assert('gems 非空', gemsDoc !== null && gemsDoc.gems.length > 0, gemsDoc !== null ? `${gemsDoc.gems.length} 颗` : 'gems 工件缺失');
  assert(
    'excludedRegions 非空（exclusion 显式指派生效）',
    gemsDoc !== null && gemsDoc.excludedRegions.length > 0,
    gemsDoc !== null ? `${gemsDoc.excludedRegions.length} 区` : 'gems 工件缺失',
  );
  const gemsPreview = gemsPreviewRef !== undefined ? decodePng(blobs.read(gemsPreviewRef)!) : null;
  assert('叠加预览 PNG 工件', gemsPreview !== null && gemsPreview.width === 736, gemsPreview !== null ? `${gemsPreview.width}×${gemsPreview.height}` : '缺失');
  if (tree !== null && plan !== null) {
    const producing = new Set(
      tree.nodes.filter((n) => n.children.length === 0 || n.drillWorthy).map((n) => n.id),
    );
    const assigned = new Set(plan.assignments.map((a) => a.nodeId));
    const missing = [...producing].filter((id) => !assigned.has(id));
    assert(
      'plan 覆盖=可贴节点全集',
      missing.length === 0 && plan.assignments.every((a) => producing.has(a.nodeId)),
      `producing ${producing.size} 节点 vs 指派 ${plan.assignments.length} 条（缺=${missing.join(',') || '无'}）`,
    );
    const kinds = plan.assignments.map((a) => `${tree.nodes.find((n) => n.id === a.nodeId)?.objectName}=${a.strategyKind}`);
    log(`指派表：${kinds.join('、')}`);
  }
  // [5] 终态
  const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
  assert('task 终态=done', frames[frames.length - 1]?.kind === 'done' && taskRow?.status === 'done', `帧末=${frames[frames.length - 1]?.kind} task=${taskRow?.status}`);
  mark('assert-execute');

  // —— 产物留存（全部工件+帧流摘要+网关步进日志+耗时）
  if (sceneRef !== undefined) writeFileSync(path.join(OUT_DIR, 'scene-analysis.json'), blobs.read(sceneRef)!);
  if (treeRef !== undefined) writeFileSync(path.join(OUT_DIR, 'object-tree.json'), blobs.read(treeRef)!);
  if (previewRef !== undefined) writeFileSync(path.join(OUT_DIR, 'object-tree-preview.png'), blobs.read(previewRef)!);
  if (planRef !== undefined) writeFileSync(path.join(OUT_DIR, 'strategy-plan.json'), blobs.read(planRef)!);
  if (gemsRef !== undefined) writeFileSync(path.join(OUT_DIR, 'strategy-gems.json'), blobs.read(gemsRef)!);
  if (gemsPreviewRef !== undefined) writeFileSync(path.join(OUT_DIR, 'strategy-gems-preview.png'), blobs.read(gemsPreviewRef)!);
  writeFileSync(path.join(OUT_DIR, 'session-id.txt'), `${sessionId}\n${taskId}\n`);
  writeFileSync(
    path.join(OUT_DIR, 'frames-summary.jsonl'),
    frames
      .map((f) => {
        const payload = f.payload as Record<string, unknown>;
        const digest =
          f.kind === 'transcript'
            ? `${(payload.role as string) ?? ''}:${String(payload.text ?? '').slice(0, 120).replace(/\n/g, '\\n')}`
            : f.kind === 'artifact'
              ? `${(payload.name as string) ?? ''}=${String(payload.blobRef ?? '').slice(0, 16)}`
              : f.kind === 'approval-request'
                ? `tool=${(payload.tool as string) ?? ''} proposal=${String(payload.proposalId ?? '').slice(0, 8)}`
                : f.kind === 'approval-resolved'
                  ? `approved=${String(payload.approved)}`
                  : JSON.stringify(payload).slice(0, 100);
        return JSON.stringify({ seq: f.seq, kind: f.kind, digest });
      })
      .join('\n') + '\n',
  );
  const summary = {
    ok: assertions.every((a) => a.ok),
    sessionId,
    taskId,
    image: { source: INPUT_IMAGE, converted: pngPath, width: 736, height: 736, canvasCm: CANVAS_CM },
    kernel: { state: kernel.state, reason: kernel.reason, mcpPort, studioToolCount: toolCount },
    mockFaces: { gateway: `127.0.0.1:${gatewayPort}`, samTransport: 'journey（analyze=unimplemented→通道 B；box→椭圆；bouquet→中央椭圆；其余→零检出）' },
    loop: { maxIterations: MAX_ITERATIONS, maxGemDiameterMm: MAX_GEM_DIAMETER_MM },
    frames: frames.length,
    frameKinds: frames.reduce<Record<string, number>>((acc, f) => {
      acc[f.kind] = (acc[f.kind] ?? 0) + 1;
      return acc;
    }, {}),
    artifactFramePositions: artifactFrames,
    approvalRequestSeq: approvalRequest?.seq ?? null,
    assertions,
    timings,
    gatewayLog,
    artifacts: [
      'input.png',
      'scene-analysis.json',
      'object-tree.json',
      'object-tree-preview.png',
      'strategy-plan.json',
      'strategy-gems.json',
      'strategy-gems-preview.png',
      'frames-summary.jsonl',
      'session-id.txt',
      'gateway-log（本文件 gatewayLog 字段）',
      'data-root/（隔离 DATA_ROOT：handicraft.db+sam-logs+scene-analyze-logs+strategy-design-logs）',
    ],
  };
  writeFileSync(path.join(OUT_DIR, 'journey-summary.json'), JSON.stringify(summary, null, 1));

  console.log('\n=== [journey-smoke] 旅程全链汇总 ===');
  console.log(`会话：${sessionId}（task=${taskId}，帧 ${frames.length}）`);
  for (const a of assertions) console.log(`  ${a.ok ? 'PASS' : 'FAIL'} ${a.step}：${a.detail}`);
  for (const t of timings) console.log(`  ⏱ ${t.step}: +${t.ms}ms`);
  console.log(`产物根：${OUT_DIR}`);

  // —— 产物留存后的退出码（finally 收口在下方——不 process.exit 跳过 finally）
  if (!summary.ok) process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

// —— 任何路径（含异常）都经 main 内 finally 收口后退出；此处兜底退出码
main().catch((error) => {
  console.error('[journey-smoke] 未预期异常：', error);
  process.exitCode = 1;
});
