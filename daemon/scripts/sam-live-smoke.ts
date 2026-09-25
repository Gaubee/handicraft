#!/usr/bin/env tsx
/**
 * SAM 真连冒烟（add-subject-sam-pipeline P2.6——opt-in macmini 真连，手动跑不进 CI）。
 * 原始需求 2026-09-24（Owner：模型推理只在 macmini；输出留存可审查）。
 * 链路：客户图 → blob → 注入固定 SceneAnalysis（LLM 无 key——elements 手工构造；
 * vision 已判读圣诞场景含圣诞树/花环/雪橇/礼物/人物）→ P2.4 迭代循环（真
 * SshSamTransport=ssh macmini direct 会话；线上 timeoutSec=180；maxIterations=2、
 * elements 取 3 控时长；elementPromptMode='hint'=文本提示——points 能力 ❌ 且文本
 * 单次最快）→ ObjectTree → persistTreeWithPreview（叠加预览+tree JSON 双轨）。
 * 产物全部留存 OUT_DIR（树 JSON/叠加 PNG/循环各轮 meta/请求日志/耗时统计/
 * data-root 内 sam-logs 每请求留存）——不改 daemon 正式 DATA_ROOT。
 * 用法：cd daemon && ./node_modules/.bin/tsx scripts/sam-live-smoke.ts
 *   环境覆盖：SAM_SMOKE_IMAGE（缺省客户圣诞图）、SAM_SMOKE_OUT（缺省
 *   /Users/kzf/Pictures/贴钻/experiments/sam3-live-20260925）。
 * 备注（LLM 通道说明）：scene.analyze 真连=Owner 配 LLM_BASE_URL/LLM_API_KEY/
 * LLM_MODEL（可选 LLM_VISION_MODEL）env 后 SAM_ANALYZE_LIVE=1 即活（P2.3 通道 B）。
 * 零残留纪律：finally 中 transport.finish()（shutdown 行→SIGTERM→界内 SIGKILL）+
 * 退出后 ps 自证；macmini 负载抖动（timeout/transport）→ 整跑重试一次（fresh 会话）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { labFromRgb, type Lab, type SceneElement } from '@handicraft/contracts';
import { ensureAnonymousUser } from '../src/auth.js';
import { BlobStore } from '../src/db/blobs.js';
import { openDatabase } from '../src/db/database.js';
import { createJobTask } from '../src/db/jobs.js';
import { SamBridge, SshSamTransport } from '../src/kernel/vision/sam-bridge.js';
import {
  finalizeSegmentLoop,
  initSegmentLoop,
  isTerminalSegmentLoop,
  stepSegmentLoop,
  type SegmentLoopDeps,
  type SegmentLoopStepMeta,
} from '../src/kernel/vision/segment-loop.js';
import { persistTreeWithPreview, resolveMaskBits } from '../src/kernel/vision/tree-persist.js';
import { decodePng } from '../src/png/codec.js';

// ---------------------------------------------------------------- 常量（现场锚定）

const OUT_DIR =
  process.env.SAM_SMOKE_OUT ?? '/Users/kzf/Pictures/贴钻/experiments/sam3-live-20260925';
const INPUT_IMAGE =
  process.env.SAM_SMOKE_IMAGE ??
  '/Users/kzf/Pictures/贴钻/experiments/sam3-spike-20260924/f5c755f7d070c9e2160841396b23a2f8.jpg';
/** macmini P2.1 direct 模式（PROTOCOL §1——勿 -t；venv python 真身）。 */
const REMOTE_COMMAND =
  '/Users/kzf/sam3-spike/mlx_sam3/.venv/bin/python /Users/kzf/sam3-spike/service/sam3_service.py';
/** 线上软界（P2.1 §6：text+box 组合逼近 120s 默认界——≥180；协议上限 600）。 */
const WIRE_TIMEOUT_SEC = 180;
/** 桥侧本地界（>线上软界+模型惰性加载+ssh 往返余量——超时面尽量由远端软界先收口）。 */
const BRIDGE_TIMEOUT_MS = 240_000;
/** 迭代硬顶（压 2：首轮元素轮+一轮细分+收尾封停——控时长）。 */
const MAX_ITERATIONS = 2;
/** 常规钻径上限 mm（判据 1 阈值=K×此值；2mm=典型小钻）。 */
const MAX_GEM_DIAMETER_MM = 2;
/** 画布声明（客户单 20×20cm，图 736×736——S1 尺寸锚点）。 */
const CANVAS_CM = { w: 20, h: 20 };

/**
 * 固定 SceneAnalysis 注入。元素面=vision 判读（圣诞树/花环/雪橇/礼物/人物）按
 * spike 实测（experiments/sam3-spike-20260924/results/metrics.json，本图 f5c755f7）
 * 校准：text grounding 仅 person(n=1, score 0.62) 与 hat(n=1, score 0.77) 检出，
 * christmas tree/gift/wreath/sleigh 均 n=0——保留「圣诞树」作**live 零检出路径**
 * 覆盖（循环语义：元素不入树、不致命——正是 P2.4 no-instance 分支的真连演练）；
 * person/hat box 取 spike 掩码外接矩形（首轮走 hint 文本，box 仅几何备援不上线上）。
 */
function fixedElements(): SceneElement[] {
  return [
    {
      name: '人物',
      category: 'face',
      boxPx: { x: 27, y: 23, w: 577, h: 660 },
      hint: 'person',
      suggestDrillWorthy: false,
    },
    {
      name: '帽子',
      category: 'subject',
      boxPx: { x: 70, y: 23, w: 375, h: 368 },
      hint: 'hat',
      suggestDrillWorthy: true,
    },
    {
      name: '圣诞树',
      category: 'subject',
      boxPx: { x: 220, y: 120, w: 300, h: 440 },
      hint: 'christmas tree',
      suggestDrillWorthy: true,
    },
  ];
}

// ---------------------------------------------------------------- 记录面

interface RequestLogEntry {
  round: number;
  promptKind: 'box' | 'text';
  promptText: string;
  durationMs: number;
  score?: number;
  maskPx: number;
  model: string;
}

interface RoundTiming {
  iter: number;
  durationMs: number;
  requests: number;
  nodesAfter: number;
  frontierAfter: number;
  sealedNow: number;
}

const requestLog: RequestLogEntry[] = [];
const roundTimings: RoundTiming[] = [];
const roundMetas: SegmentLoopStepMeta[] = [];

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------- 原图准备

/** macmini PIL（与 spike/服务同一 JPEG 解码器——像素保真源）。 */
const MACMINI_PIL_PY = '/Users/kzf/sam3-spike/mlx_sam3/.venv/bin/python';

/**
 * daemon 解码面仅 PNG（纯 TS codec）——JPEG 输入需转 PNG。**必须像素保真**：macOS
 * sips 会嵌 ICC 色彩管理（live 实测 2026-09-25：同图同提示 person 检出 count 1→0
 * 翻转）；用 macmini 侧 PIL 转无 profile 裸 PNG（live 实测：count/score/maskPx 与
 * JPEG 原字节逐位一致）。产物缓存在 OUT_DIR——重跑幂等。
 */
function ensurePngInput(outDir: string): { pngPath: string; bytes: Uint8Array } {
  const bytes = new Uint8Array(execFileSync('/bin/cat', [INPUT_IMAGE]));
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return { pngPath: INPUT_IMAGE, bytes };
  const pngPath = path.join(outDir, 'input.png');
  if (!existsSync(pngPath)) {
    const remoteIn = `/tmp/sam-smoke-${Date.now()}.jpg`;
    const remoteOut = '/tmp/sam-smoke-conv.png';
    execFileSync('/usr/bin/scp', ['-q', '-o', 'BatchMode=yes', INPUT_IMAGE, `macmini:${remoteIn}`]);
    try {
      execFileSync('/usr/bin/ssh', [
        '-o',
        'BatchMode=yes',
        'macmini',
        `${MACMINI_PIL_PY} -c 'from PIL import Image; Image.open("${remoteIn}").save("${remoteOut}")'`,
      ]);
      execFileSync('/usr/bin/scp', ['-q', '-o', 'BatchMode=yes', `macmini:${remoteOut}`, pngPath]);
    } finally {
      try {
        execFileSync('/usr/bin/ssh', ['-o', 'BatchMode=yes', 'macmini', `rm -f ${remoteIn} ${remoteOut}`]);
      } catch {
        // 远端临时文件清理失败不阻塞（/tmp 自清）——报告零残留时人工复核
      }
    }
    log(`原图 JPEG→PNG（macmini PIL 像素保真）：${pngPath}`);
  }
  return { pngPath, bytes: new Uint8Array(execFileSync('/bin/cat', [pngPath])) };
}

/** 节点域 Lab 色方差（RMS ΔE76——fallback-segment statsOf 同口径；bits=bbox 局部；RGB 键缓存同先例）。 */
function makeLabMeasurer(image: { width: number; rgba: Uint8Array }) {
  const cache = new Map<number, Lab>();
  const labAt = (x: number, y: number): Lab => {
    const key = y * image.width + x;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const i = key * 4;
    const lab = labFromRgb(image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!);
    cache.set(key, lab);
    return lab;
  };
  return (region: { bbox: { x: number; y: number; w: number; h: number }; bits: Uint8Array }): number => {
    const { bbox, bits } = region;
    let sumL = 0;
    let sumA = 0;
    let sumB = 0;
    let n = 0;
    for (let y = 0; y < bbox.h; y++) {
      for (let x = 0; x < bbox.w; x++) {
        if (bits[y * bbox.w + x] !== 1) continue;
        const lab = labAt(bbox.x + x, bbox.y + y);
        sumL += lab.L;
        sumA += lab.a;
        sumB += lab.b;
        n++;
      }
    }
    if (n === 0) return 0;
    const mean = { L: sumL / n, a: sumA / n, b: sumB / n };
    let sqSum = 0;
    for (let y = 0; y < bbox.h; y++) {
      for (let x = 0; x < bbox.w; x++) {
        if (bits[y * bbox.w + x] !== 1) continue;
        const lab = labAt(bbox.x + x, bbox.y + y);
        const dL = lab.L - mean.L;
        const da = lab.a - mean.a;
        const db = lab.b - mean.b;
        sqSum += dL * dL + da * da + db * db;
      }
    }
    return Math.round(Math.sqrt(sqSum / n) * 100) / 100;
  };
}

function popcount(bits: Uint8Array): number {
  let n = 0;
  for (const b of bits) n += b;
  return n;
}

// ---------------------------------------------------------------- 一跑（attempt）

interface AttemptOutcome {
  ok: boolean;
  error?: { kind: string; message: string };
  tree?: ReturnType<typeof finalizeSegmentLoop>['tree'];
  iterations?: number;
  totalNodes?: number;
  sealedByNode?: Record<string, string[]>;
  transportStats: { spawnCount: number; sessionAlive: boolean };
}

async function runOnce(
  bridgeDeps: { db: ReturnType<typeof openDatabase>; blobs: BlobStore; dataRoot: string },
  labMeasure: SegmentLoopDeps['measureLabVariance'],
  anchors: {
    taskId: string;
    imageBlobRef: string;
    imagePx: { width: number; height: number };
    canvasCm: { w: number; h: number };
  },
  elements: SceneElement[],
  attempt: number,
): Promise<AttemptOutcome> {
  const transport = new SshSamTransport({
    host: 'macmini',
    remoteCommand: REMOTE_COMMAND,
    requestTimeoutSec: WIRE_TIMEOUT_SEC,
    requestOverlay: true,
  });
  const bridge = new SamBridge(bridgeDeps, { transport, timeoutMs: BRIDGE_TIMEOUT_MS });
  const loopDeps: SegmentLoopDeps = {
    async segment(request) {
      const startedAt = Date.now();
      const result = await bridge.run(request);
      if (result.kind !== 'segment') {
        throw new Error('冒烟面只走 segment（vlmReentry=false——analyze 不上线）');
      }
      const { bits } = resolveMaskBits(bridgeDeps.blobs, result.mask);
      requestLog.push({
        round: request.iteration,
        promptKind: request.prompt.kind === 'text' ? 'text' : 'box',
        promptText:
          request.prompt.kind === 'text'
            ? request.prompt.text
            : `geometric box ${JSON.stringify(request.prompt.box)}`,
        durationMs: Date.now() - startedAt,
        ...(result.score !== undefined ? { score: result.score } : {}),
        maskPx: popcount(bits),
        model: result.meta.model,
      });
      return {
        mask: { w: result.mask.w, h: result.mask.h, bits },
        ...(result.score !== undefined ? { score: result.score } : {}),
      };
    },
    measureLabVariance: labMeasure,
    now: () => new Date().toISOString(),
  };
  /** 循环主体（自捕获全部失败面——不外抛；transportStats 由 finish 后统一回填）。 */
  const attemptBody = async (): Promise<AttemptOutcome> => {
    try {
      const { state, ctx } = initSegmentLoop(
        {
          ...anchors,
          elements,
          maxGemDiameterMm: MAX_GEM_DIAMETER_MM,
          maxIterations: MAX_ITERATIONS,
          elementPromptMode: 'hint',
          vlmReentry: false,
        },
        loopDeps,
      );
      let current = state;
      while (!isTerminalSegmentLoop(current)) {
        const stepStart = Date.now();
        const requestsBefore = requestLog.length;
        current = await stepSegmentLoop(current, ctx);
        const meta = current.history[current.history.length - 1]!;
        roundMetas.push(meta);
        roundTimings.push({
          iter: meta.iter,
          durationMs: Date.now() - stepStart,
          requests: requestLog.length - requestsBefore,
          nodesAfter: meta.nodesAfter,
          frontierAfter: meta.frontierAfter,
          sealedNow: meta.sealed.length,
        });
        log(
          `轮 ${meta.iter}：${meta.entries.length} 请求 → 节点 ${meta.nodesAfter}（frontier ${meta.frontierAfter}，本轮封停 ${meta.sealed.length}）`,
        );
      }
      const result = finalizeSegmentLoop(current, ctx);
      return {
        ok: true,
        tree: result.tree,
        iterations: result.iterations,
        totalNodes: result.totalNodes,
        sealedByNode: Object.fromEntries(
          Object.entries(result.sealedByNode).map(([id, reasons]) => [id, [...reasons]]),
        ),
        transportStats: { spawnCount: 0, sessionAlive: false }, // finish 后回填
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          kind:
            error instanceof Error && 'kind' in error && typeof (error as { kind: unknown }).kind === 'string'
              ? (error as { kind: string }).kind
              : error instanceof Error
                ? error.name
                : String(error),
          message: error instanceof Error ? error.message : String(error),
        },
        transportStats: { spawnCount: 0, sessionAlive: false }, // finish 后回填
      };
    }
  };
  const outcome = await attemptBody();
  // —— 会话收口（终态以 finish 之后为准——零残留证据面）
  await transport.finish();
  outcome.transportStats = { spawnCount: transport.spawnCount, sessionAlive: transport.sessionAlive };
  log(
    `attempt ${attempt} ssh 会话收口：spawnCount=${transport.spawnCount} sessionAlive=${transport.sessionAlive}`,
  );
  return outcome;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const dataRoot = path.join(OUT_DIR, 'data-root');
  mkdirSync(dataRoot, { recursive: true });
  const input = ensurePngInput(OUT_DIR);
  const decoded = decodePng(input.bytes);
  log(`输入图：${input.pngPath}（${decoded.width}×${decoded.height}，画布 ${CANVAS_CM.w}×${CANVAS_CM.h}cm）`);

  const db = openDatabase(dataRoot);
  const blobs = new BlobStore(dataRoot, db);
  const anonymous = ensureAnonymousUser(db);
  const task = createJobTask(db, {
    ownerId: anonymous.id,
    paramsJson: JSON.stringify({ kind: 'sam-live-smoke', params: { image: path.basename(input.pngPath) } }),
  });
  const imageBlobRef = blobs.put(input.bytes).hash;
  const bridgeDeps = { db, blobs, dataRoot };
  const anchors = {
    taskId: task.id,
    imageBlobRef,
    imagePx: { width: decoded.width, height: decoded.height },
    canvasCm: CANVAS_CM,
  };
  const elements = fixedElements();
  const labMeasure = makeLabMeasurer({ width: decoded.width, rgba: decoded.rgba });

  const startedAt = Date.now();
  let attempt = 1;
  let outcome = await runOnce(bridgeDeps, labMeasure, anchors, elements, attempt);
  // macmini 负载抖动（桥失败包裹的 timeout/transport）→ 整跑重试一次（fresh ssh 会话）
  if (!outcome.ok && outcome.error !== undefined && ['bridge-failure', 'timeout', 'transport'].includes(outcome.error.kind)) {
    log(`attempt 1 失败（${outcome.error.kind}：${outcome.error.message}）——重试一次（fresh 会话）`);
    attempt = 2;
    outcome = await runOnce(bridgeDeps, labMeasure, anchors, elements, attempt);
  }
  const wallMs = Date.now() - startedAt;

  // —— 请求日志/轮 meta 落盘（失败也留——审查面）
  writeFileSync(path.join(OUT_DIR, 'request-log.jsonl'), requestLog.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const roundsPath = path.join(OUT_DIR, 'loop-rounds');
  mkdirSync(roundsPath, { recursive: true });
  roundTimings.forEach((rt, i) => {
    writeFileSync(path.join(roundsPath, `iter-${i}.json`), JSON.stringify({ timing: rt, meta: roundMetas[i] ?? null }, null, 1));
  });

  if (!outcome.ok || outcome.tree === undefined) {
    writeFileSync(
      path.join(OUT_DIR, 'summary.json'),
      JSON.stringify({ ok: false, attempts: attempt, wallMs, error: outcome.error, roundTimings, requestLog }, null, 1),
    );
    console.error(`[sam-live-smoke] FAIL（attempts=${attempt}）：${outcome.error?.kind}——${outcome.error?.message}`);
    console.error(`产物：${OUT_DIR}{request-log.jsonl,loop-rounds/,summary.json,data-root/sam-logs/}`);
    db.close();
    process.exit(1);
  }

  // —— 双轨工件（tree JSON+叠加预览）
  const bundle = persistTreeWithPreview({ db, blobs }, task.id, imageBlobRef, outcome.tree);
  writeFileSync(path.join(OUT_DIR, 'object-tree.json'), blobs.read(bundle.treeBlobRef)!.toString('utf8'));
  writeFileSync(path.join(OUT_DIR, 'object-tree-preview.png'), blobs.read(bundle.previewBlobRef)!);
  writeFileSync(path.join(OUT_DIR, 'preview-legend.json'), JSON.stringify(bundle.legend, null, 1));

  // —— 判停原因分布
  const stopReasonDist: Record<string, number> = {};
  for (const reasons of Object.values(outcome.sealedByNode ?? {})) {
    for (const r of reasons) stopReasonDist[r] = (stopReasonDist[r] ?? 0) + 1;
  }

  const summary = {
    ok: true,
    attempts: attempt,
    wallMs,
    image: { path: input.pngPath, width: decoded.width, height: decoded.height, canvasCm: CANVAS_CM },
    elements: elements.map((e) => ({ name: e.name, hint: e.hint, category: e.category })),
    loop: {
      iterations: outcome.iterations,
      totalNodes: outcome.totalNodes,
      maxIterations: MAX_ITERATIONS,
      wireTimeoutSec: WIRE_TIMEOUT_SEC,
      bridgeTimeoutMs: BRIDGE_TIMEOUT_MS,
      maxGemDiameterMm: MAX_GEM_DIAMETER_MM,
    },
    rounds: roundTimings,
    requests: requestLog.length,
    requestTotalMs: requestLog.reduce((s, r) => s + r.durationMs, 0),
    stopReasonDist,
    treeBlobRef: bundle.treeBlobRef,
    previewBlobRef: bundle.previewBlobRef,
    transport: outcome.transportStats,
    artifacts: [
      'object-tree.json',
      'object-tree-preview.png',
      'preview-legend.json',
      'request-log.jsonl',
      'loop-rounds/',
      'summary.json',
      'data-root/sam-logs/（每请求 req-resp JSON+mask png+overlay jpg）',
      'data-root/handicraft.db',
    ],
    llmChannelNote:
      'scene.analyze 真连=配 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL（可选 LLM_VISION_MODEL）后 SAM_ANALYZE_LIVE=1（P2.3 通道 B——LLM 路由 openai-completions 视觉调用）；本冒烟因无 key 注入固定 SceneAnalysis',
  };
  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));

  log(`完成（${Math.round(wallMs / 1000)}s 墙钟，attempts=${attempt}）`);
  console.log('\n=== [sam-live-smoke] 汇总 ===');
  console.log(`树节点：${outcome.totalNodes}（${outcome.iterations} 轮，硬顶 ${MAX_ITERATIONS}；画布根=结构性容器）`);
  for (const rt of roundTimings) {
    console.log(`  轮 ${rt.iter}：${(rt.durationMs / 1000).toFixed(1)}s，${rt.requests} 请求 → 节点 ${rt.nodesAfter}/frontier ${rt.frontierAfter}/封停 ${rt.sealedNow}`);
  }
  for (const r of requestLog) {
    console.log(`  请求 [轮${r.round}] ${r.promptKind} "${r.promptText}" ${(r.durationMs / 1000).toFixed(1)}s score=${r.score ?? '-'} maskPx=${r.maskPx} (${r.model})`);
  }
  console.log(`判停原因分布：${JSON.stringify(stopReasonDist)}`);
  console.log(`产物根：${OUT_DIR}`);
  console.log(`ssh 会话：spawnCount=${outcome.transportStats.spawnCount}（finish 后 sessionAlive=${outcome.transportStats.sessionAlive}）`);
  console.log(`LLM 通道备注：${summary.llmChannelNote}`);
  db.close();
}

main().catch((error) => {
  console.error('[sam-live-smoke] 未预期异常：', error);
  process.exit(1);
});
