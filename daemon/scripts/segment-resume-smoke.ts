#!/usr/bin/env tsx
/**
 * 段循环断点续跑真链冒烟（add-segment-checkpoint-resume 验收 6.1/6.2/6.3——手动跑
 * 不进 CI）。原始需求 2026-10-02（Owner 挂账 291 段超窗根治）。
 * 链路：真 macmini SAM 桥（SshSamTransport）+ SubjectSegmentExecutor（账本+切片+
 * 回放全量新机制）——独立 DATA_ROOT（不碰 8317/主 DATA_ROOT）。
 * 三相：
 *   [P1] kill 恢复（验收 6.2）：受害者子进程（长切片 600s）跑 ~45s 后 SIGKILL——
 *        在途请求被杀、已银行段留账本；请求日志逐条即时落盘（kill 后可审计）。
 *   [P2] 切片链续跑（验收 6.1）：30s/片反复 invoke（每片新 executor 实例=重载账本
 *        文件=重启语义）至 done——断言：实跑请求零命中相始账本快照（不重复请求已
 *        银行段）、进度帧逐段可见（验收 6.3 零进展护栏：每片 ≥1 实跑）。
 *   [P3] 跨 taskId 回放：新 task 行同参 invoke——零实跑（liveSegments=0）、树 blob
 *        与 P2 终态逐字节一致（FIXED_NOW 时钟注入）。
 * 断言集：账本行零重复 reqHash；受害者已银行段在 kill 后保留；P2 实跑请求全为
 * 快照外新 miss；P3 零桥调用；树/预览工件落档。
 * 零残留纪律：每 transport finish()；受害者 SIGKILL 后 scoped 清理孤儿 ssh + ps 自证。
 * 用法：cd daemon && ./node_modules/.bin/tsx scripts/segment-resume-smoke.ts [--victim]
 *   环境覆盖：SEGMENT_SMOKE_OUT（缺省主仓 experiments/segment-resume-smoke-20261002）。
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { CanvasCm, SceneElement } from '@handicraft/contracts';
import { ensureAnonymousUser } from '../src/auth.js';
import { BlobStore } from '../src/db/blobs.js';
import { openDatabase } from '../src/db/database.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createSessionRow } from '../src/db/sessions.js';
import { decodePng } from '../src/png/codec.js';
import { SamBridge, SshSamTransport, type SamTransport } from '../src/kernel/vision/sam-bridge.js';
import {
  parseSegmentLedgerLine,
  segmentRequestHash,
  type SegmentLedgerRow,
} from '../src/kernel/vision/segment-ledger.js';
import {
  SubjectSegmentExecutor,
  type SubjectSegmentDoneOutcome,
  type SubjectSegmentInput,
} from '../src/kernel/vision/segment-tool.js';

// ---------------------------------------------------------------- 常量（现场锚定）

const OUT_DIR =
  process.env.SEGMENT_SMOKE_OUT ?? '/Users/kzf/Pictures/贴钻/experiments/segment-resume-smoke-20261002';
const INPUT_IMAGE =
  '/Users/kzf/Pictures/贴钻/experiments/sam3-spike-20260924/f5c755f7d070c9e2160841396b23a2f8.jpg';
/** start-8317.sh 同款远端命令（PROTOCOL §1——勿 -t）。 */
const REMOTE_COMMAND = 'cd ~/sam3-spike/service && ~/sam3-spike/mlx_sam3/.venv/bin/python sam3_service.py';
const WIRE_TIMEOUT_SEC = 180;
const BRIDGE_TIMEOUT_MS = 240_000;
const CANVAS_CM: CanvasCm = { w: 20, h: 20 };
const MAX_ITERATIONS = 3;
const MAX_GEM_DIAMETER_MM = 2;
/** 树 createdAt/账本 ts 固定时钟——P3 树 blob 逐字节可比的前提（T5 时钟注入）。 */
const FIXED_NOW = (): string => '2026-10-02T00:00:00.000Z';
/** 受害者寿命（ms）——SIGKILL 落在长切片中段（在途请求被杀）；压短逼 P2 多片续跑。 */
const VICTIM_LIVE_MS = 20_000;
/** 续跑切片预算（ms）——p50 5.3s/段 → 每片银行 2-3 段，剩余段逼出 ≥2 个 checkpointed 片。 */
const RESUME_SLICE_MS = 15_000;
const SLICE_CAP = 60;
const MACMINI_PIL_PY = '/Users/kzf/sam3-spike/mlx_sam3/.venv/bin/python';

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 原图准备（sam-live-smoke 同款）

/** JPEG→PNG 像素保真（macmini PIL——sips 会嵌 ICC 翻转检出）；产物缓存重跑幂等。 */
function ensurePngInput(): { pngPath: string; bytes: Uint8Array } {
  const bytes = new Uint8Array(execFileSync('/bin/cat', [INPUT_IMAGE]));
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return { pngPath: INPUT_IMAGE, bytes };
  const pngPath = path.join(OUT_DIR, 'input.png');
  if (!existsSync(pngPath)) {
    const remoteIn = `/tmp/seg-smoke-${Date.now()}.jpg`;
    const remoteOut = '/tmp/seg-smoke-conv.png';
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
        // /tmp 自清——报告零残留时人工复核
      }
    }
    log(`原图 JPEG→PNG（macmini PIL 像素保真）：${pngPath}`);
  }
  return { pngPath, bytes: new Uint8Array(execFileSync('/bin/cat', [pngPath])) };
}

/** sam-live-smoke 同款固定元素（person/hat 真检出+圣诞树零检出路径覆盖）。 */
function fixedElements(): SceneElement[] {
  return [
    { name: '人物', category: 'face', boxPx: { x: 27, y: 23, w: 577, h: 660 }, hint: 'person', suggestDrillWorthy: false },
    { name: '帽子', category: 'subject', boxPx: { x: 200, y: 8, w: 220, h: 180 }, hint: 'hat', suggestDrillWorthy: true },
    { name: '圣诞树', category: 'structure', boxPx: { x: 440, y: 120, w: 250, h: 520 }, hint: 'christmas tree', suggestDrillWorthy: false },
  ];
}

// ---------------------------------------------------------------- 录制型传输（请求审计面）

interface IssuedRequest {
  phase: string;
  kind: string;
  reqHash: string;
  ts: string;
}

/** 包装 SshSamTransport：逐请求记录投影哈希（受害者模式即时落盘——SIGKILL 可审计）。 */
function makeRecordingTransport(
  phase: string,
  durableLog?: string,
): SamTransport & { issued: IssuedRequest[]; finish: () => Promise<void> } {
  const inner = new SshSamTransport({
    host: 'macmini',
    remoteCommand: REMOTE_COMMAND,
    requestTimeoutSec: WIRE_TIMEOUT_SEC,
    requestOverlay: true,
  });
  const issued: IssuedRequest[] = [];
  return {
    issued,
    async send(call) {
      const record: IssuedRequest = {
        phase,
        kind: call.request.kind,
        reqHash: segmentRequestHash(call.request),
        ts: new Date().toISOString(),
      };
      issued.push(record);
      if (durableLog !== undefined) appendFileSync(durableLog, `${JSON.stringify(record)}\n`, 'utf8');
      return inner.send(call);
    },
    finish: () => inner.finish(),
  } as SamTransport & { issued: IssuedRequest[]; finish: () => Promise<void> };
}

// ---------------------------------------------------------------- 账本快照（断言面）

interface LedgerSnapshot {
  rows: SegmentLedgerRow[];
  segmentHashes: Set<string>;
}

function snapshotLedger(dataRoot: string): LedgerSnapshot {
  const dir = path.join(dataRoot, 'segment-ledgers');
  const rows: SegmentLedgerRow[] = [];
  if (!existsSync(dir)) return { rows, segmentHashes: new Set() };
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const row = parseSegmentLedgerLine(line);
      if (row !== null) rows.push(row);
    }
  }
  return {
    rows,
    segmentHashes: new Set(rows.filter((r) => r.kind === 'segment').map((r) => r.reqHash)),
  };
}

// ---------------------------------------------------------------- 装配

interface SmokeContext {
  dataRoot: string;
  imageBlobRef: string;
  imagePx: { width: number; height: number };
  ownerId: string;
  sessionId: string;
}

function openContext(): { db: ReturnType<typeof openDatabase>; blobs: BlobStore; ctx: SmokeContext } {
  const dataRoot = path.join(OUT_DIR, 'data-root');
  mkdirSync(dataRoot, { recursive: true });
  const db = openDatabase(dataRoot);
  const blobs = new BlobStore(dataRoot, db);
  const input = ensurePngInput();
  const decoded = decodePng(input.bytes);
  const anonymous = ensureAnonymousUser(db);
  const session = createSessionRow(db, { ownerId: anonymous.id, title: 'segment-resume-smoke' });
  return {
    db,
    blobs,
    ctx: {
      dataRoot,
      imageBlobRef: blobs.put(input.bytes).hash,
      imagePx: { width: decoded.width, height: decoded.height },
      ownerId: anonymous.id,
      sessionId: session.id,
    },
  };
}

/** 进度帧录制（Pick<JobService,'emitFor'|'framesAfter'> 注入面——最小探针，不落库；
 * framesAfter=T4.1 分件输入接线的参考图层帧流读回面——探针恒空（无参考图层=原图，
 * smoke 语义不变）。 */
function frameRecorder(): {
  jobs: {
    emitFor(taskId: string, kind: string, payload: unknown): boolean;
    framesAfter(taskId: string, afterSeq: number): never[];
  };
  frames: Array<{ taskId: string; kind: string; payload: unknown }>;
} {
  const frames: Array<{ taskId: string; kind: string; payload: unknown }> = [];
  return {
    frames,
    jobs: {
      emitFor(taskId, kind, payload) {
        frames.push({ taskId, kind, payload });
        return true;
      },
      framesAfter() {
        return []; // 探针无参考图层帧（T4.1 读回面空=分件输入原图——smoke 语义不变）
      },
    },
  };
}

function baseInputOf(ctx: SmokeContext, taskId: string): SubjectSegmentInput {
  return {
    taskId,
    imageBlobRef: ctx.imageBlobRef,
    canvasCm: CANVAS_CM,
    imagePx: ctx.imagePx,
    elements: fixedElements(),
    maxIterations: MAX_ITERATIONS,
    maxGemDiameterMm: MAX_GEM_DIAMETER_MM,
  };
}

// ---------------------------------------------------------------- 受害者（P1 子进程）

/** 受害者真身：长切片单次 invoke（外层 SIGKILL 终止——收尾日志可能来不及写）。 */
async function victimMain(): Promise<void> {
  const { db, blobs, ctx } = openContext();
  const task = createAgentTask(db, { ownerId: ctx.ownerId, sessionId: ctx.sessionId, status: 'running' });
  const transport = makeRecordingTransport('victim', path.join(OUT_DIR, 'victim-requests.jsonl'));
  const bridge = new SamBridge({ db, blobs, dataRoot: ctx.dataRoot }, { transport, timeoutMs: BRIDGE_TIMEOUT_MS });
  const executor = new SubjectSegmentExecutor({
    db,
    blobs,
    dataRoot: ctx.dataRoot,
    jobs: frameRecorder().jobs,
    bridge,
    now: FIXED_NOW,
    sliceMs: 600_000, // 长切片——SIGKILL 落在切片中段
  });
  log(`[victim] 启动：task=${task.id}（长切片 600s——等待外层击杀）`);
  const outcome = await executor.run(baseInputOf(ctx, task.id));
  // 正常返回=未被击杀（外层时限太长等场景）——留记录供外层判定
  writeFileSync(path.join(OUT_DIR, 'victim-returned.json'), JSON.stringify({ status: outcome.status }, null, 1));
  await transport.finish();
  db.close();
}

// ---------------------------------------------------------------- 编排主体

async function orchestratorMain(): Promise<void> {
  const startedAt = Date.now();
  const { db, blobs, ctx } = openContext();
  // —— 清相：账本/受害者日志（input.png 缓存保留——幂等）
  rmSync(path.join(OUT_DIR, 'victim-requests.jsonl'), { force: true });
  rmSync(path.join(OUT_DIR, 'victim-returned.json'), { force: true });
  rmSync(path.join(ctx.dataRoot, 'segment-ledgers'), { recursive: true, force: true });

  const summary: Record<string, unknown> = { outDir: OUT_DIR, canvasCm: CANVAS_CM, maxIterations: MAX_ITERATIONS };
  const failures: string[] = [];
  /** 断言（asserts 签名——TS 控制流收窄调用侧表达式）。 */
  function assert(ok: boolean, what: string): asserts ok {
    if (!ok) {
      failures.push(what);
      throw new Error(`断言失败：${what}`);
    }
  }

  // ================= P1：kill 恢复（验收 6.2） =================
  log('P1 kill 恢复：spawn 受害者子进程（长切片，进程组 detached）……');
  const victim = spawn('./node_modules/.bin/tsx', ['scripts/segment-resume-smoke.ts', '--victim'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 自成进程组——tsx CLI 是 spawn 子进程形态，kill(-pid) 才能杀到真身
  });
  victim.stdout.on('data', (d: Buffer) => process.stdout.write(`[victim] ${d}`));
  victim.stderr.on('data', (d: Buffer) => process.stderr.write(`[victim!] ${d}`));
  await sleep(VICTIM_LIVE_MS);
  // 进程组击杀（终审 R2：victim.kill 只杀 tsx 包装——真身 node 子进程存活到 pkill
  // 掐 ssh 才死，「kill 恢复」机制宣称与事实不符；负 pid 杀整组=真·SIGKILL 中段）。
  let groupKilled = false;
  try {
    process.kill(-victim.pid!, 'SIGKILL');
    groupKilled = true;
  } catch {
    // 组已消亡（victim 提前自退——如桥失败错误路径）
  }
  // 击杀后等 victim 退出事件落地（单写者假设：P2 起跑前旧写者必须确死）
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    victim.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
    if (victim.exitCode !== null) {
      clearTimeout(timer);
      resolve(true);
    }
  });
  log(`P1 进程组 SIGKILL（groupKilled=${groupKilled}）——victim 退出确认=${exited}；3s 后 scoped 清理孤儿 ssh`);
  await sleep(3_000);
  try {
    const remotePattern = REMOTE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\~/g, '~');
    execFileSync('/usr/bin/pkill', ['-f', `ssh.*${remotePattern}`]);
  } catch {
    // 无匹配=已自清
  }

  const victimIssued: IssuedRequest[] = existsSync(path.join(OUT_DIR, 'victim-requests.jsonl'))
    ? readFileSync(path.join(OUT_DIR, 'victim-requests.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as IssuedRequest)
    : [];
  const ledgerAfterKill = snapshotLedger(ctx.dataRoot);
  const victimBanked = victimIssued.filter((r) => ledgerAfterKill.segmentHashes.has(r.reqHash)).length;
  const victimInflight = victimIssued.length - victimBanked;
  log(
    `P1 受害者：issued=${victimIssued.length} banked=${victimBanked} 在途被杀=${victimInflight}；账本段=${ledgerAfterKill.segmentHashes.size}`,
  );
  assert(ledgerAfterKill.segmentHashes.size > 0, `P1 kill 后账本零段（45s 内应至少银行 1 段——p50 5.3s/段；issued=${victimIssued.length}）`);
  assert(victimInflight <= 1, `P1 在途被杀请求 ${victimInflight} > 1（桥并发 1——应至多 1 个在途）`);
  summary.p1 = {
    victimIssued: victimIssued.length,
    victimBanked,
    victimInflightKilled: victimInflight,
    ledgerSegmentsAfterKill: ledgerAfterKill.segmentHashes.size,
  };

  // ================= P2：切片链续跑至 done（验收 6.1/6.3） =================
  log('P2 切片链续跑（30s/片，每片新 executor=重载账本）……');
  const ledgerAtP2Start = snapshotLedger(ctx.dataRoot);
  const p2Transport = makeRecordingTransport('resume');
  const p2Bridge = new SamBridge({ db, blobs, dataRoot: ctx.dataRoot }, { transport: p2Transport, timeoutMs: BRIDGE_TIMEOUT_MS });
  const p2Frames = frameRecorder();
  const taskP2 = createAgentTask(db, { ownerId: ctx.ownerId, sessionId: ctx.sessionId, status: 'running' });
  const baseInput = baseInputOf(ctx, taskP2.id);
  const checkpointedFaces: Array<{ banked: number; replayed: number; live: number }> = [];
  let done: SubjectSegmentDoneOutcome | undefined;
  for (let i = 0; i < SLICE_CAP; i++) {
    const executor = new SubjectSegmentExecutor({
      db,
      blobs,
      dataRoot: ctx.dataRoot,
      jobs: p2Frames.jobs,
      bridge: p2Bridge,
      now: FIXED_NOW,
      sliceMs: RESUME_SLICE_MS,
    });
    const outcome = await executor.run(baseInput);
    if (outcome.status === 'checkpointed') {
      checkpointedFaces.push({ banked: outcome.bankedSegments, replayed: outcome.replayedSegments, live: outcome.liveSegments });
      log(
        `P2 片 ${i + 1}：checkpointed（banked=${outcome.bankedSegments} replayed=${outcome.replayedSegments} live=${outcome.liveSegments}）`,
      );
      assert(outcome.liveSegments >= 1, 'P2 零进展护栏被破（checkpointed 片 liveSegments=0——agent 会空转）');
      continue;
    }
    done = outcome;
    log(`P2 完成：done（iterations=${outcome.iterations} totalNodes=${outcome.totalNodes} replayed=${outcome.replayedSegments}）`);
    break;
  }
  assert(done !== undefined, `P2 ${SLICE_CAP} 片内未达 done`);
  await p2Transport.finish();

  const p2Issued = p2Transport.issued;
  const duplicateOfBanked = p2Issued.filter((r) => ledgerAtP2Start.segmentHashes.has(r.reqHash));
  assert(duplicateOfBanked.length === 0, `P2 ${duplicateOfBanked.length} 个实跑请求命中相始已银行段（重复请求——回放失效）`);
  // 验收 6.1 真链链式面：必须实际出现 checkpointed 片（终审 R1——首轮冒烟 1 片跑完名不副实）
  assert(checkpointedFaces.length >= 1, `P2 零 checkpointed 片（liveRequests=${p2Issued.length}——切片链未真正演练）`);
  // 链路闭环（终审 R4）：受害者被杀在途请求 == P2 首个实跑请求（断点=在途被杀点，直接钉死）
  const victimUnbanked = victimIssued.filter((r) => !ledgerAfterKill.segmentHashes.has(r.reqHash));
  if (victimUnbanked.length > 0 && p2Issued.length > 0) {
    assert(
      p2Issued[0]!.reqHash === victimUnbanked[victimUnbanked.length - 1]!.reqHash,
      `P2 首实跑请求 ≠ 受害者被杀在途请求（断点闭环断裂：${p2Issued[0]!.reqHash.slice(0, 8)} vs ${victimUnbanked[victimUnbanked.length - 1]!.reqHash.slice(0, 8)}）`,
    );
    log('P2 闭环：首实跑请求=受害者被杀在途请求（断点=被杀点，直接命中）');
  }
  const ledgerFinal = snapshotLedger(ctx.dataRoot);
  const dupInLedger = ledgerFinal.rows.length - new Set(ledgerFinal.rows.map((r) => r.reqHash)).size;
  assert(dupInLedger === 0, `P2 账本 ${dupInLedger} 行重复 reqHash`);
  const progressFrames = p2Frames.frames.filter((f) => f.kind === 'progress').length;
  assert(progressFrames > 0, 'P2 零进度帧（实跑段逐段应发帧——看门狗喂帧面）');
  const treeBytes = blobs.read(done.treeArtifactRef);
  const previewBytes = blobs.read(done.previewRef);
  assert(treeBytes !== null && previewBytes !== null, 'P2 树/预览工件 blob 缺失');
  log(
    `P2 断言全过：实跑 ${p2Issued.length} 请求零重复；账本段=${ledgerFinal.segmentHashes.size}；进度帧=${progressFrames}；片数=${checkpointedFaces.length + 1}`,
  );
  summary.p2 = {
    slices: checkpointedFaces.length + 1,
    checkpointedFaces,
    liveRequests: p2Issued.length,
    ledgerSegments: ledgerFinal.segmentHashes.size,
    progressFrames,
    done: {
      iterations: done.iterations,
      totalNodes: done.totalNodes,
      replayedSegments: done.replayedSegments,
      treeBlobRef: done.treeArtifactRef,
      previewRef: done.previewRef,
    },
  };
  writeFileSync(path.join(OUT_DIR, 'object-tree.json'), treeBytes.toString('utf8'));
  writeFileSync(path.join(OUT_DIR, 'object-tree-preview.png'), previewBytes);

  // ================= P3：跨 taskId 回放（R1-P0-1 真链回归网） =================
  log('P3 跨 taskId 回放：新 task 行同参单次 invoke……');
  const p3Transport = makeRecordingTransport('cross-task');
  const p3Bridge = new SamBridge({ db, blobs, dataRoot: ctx.dataRoot }, { transport: p3Transport, timeoutMs: BRIDGE_TIMEOUT_MS });
  const taskP3 = createAgentTask(db, { ownerId: ctx.ownerId, sessionId: ctx.sessionId, status: 'running' });
  const p3Executor = new SubjectSegmentExecutor({
    db,
    blobs,
    dataRoot: ctx.dataRoot,
    jobs: frameRecorder().jobs,
    bridge: p3Bridge,
    now: FIXED_NOW,
    sliceMs: RESUME_SLICE_MS,
  });
  const p3Outcome = await p3Executor.run({ ...baseInput, taskId: taskP3.id });
  await p3Transport.finish();
  assert(p3Outcome.status === 'done', `P3 期望 done（全量回放），实为 ${p3Outcome.status}`);
  assert(p3Transport.issued.length === 0, `P3 跨 taskId 仍实跑 ${p3Transport.issued.length} 请求（reqHash 投影失效——R1-P0-1 回归）`);
  assert(
    p3Outcome.replayedSegments === ledgerFinal.segmentHashes.size,
    `P3 回放段 ${p3Outcome.replayedSegments} ≠ 账本段 ${ledgerFinal.segmentHashes.size}`,
  );
  const p3TreeBytes = blobs.read(p3Outcome.treeArtifactRef);
  assert(
    p3TreeBytes !== null && Buffer.compare(Buffer.from(p3TreeBytes), Buffer.from(treeBytes)) === 0,
    'P3 跨 taskId 树 blob 与 P2 终态不逐字节一致',
  );
  log(`P3 断言全过：零实跑、回放 ${p3Outcome.replayedSegments} 段、树逐字节一致`);
  summary.p3 = { liveRequests: 0, replayedSegments: p3Outcome.replayedSegments, treeByteIdentical: true };

  // ================= 收口 =================
  summary.ok = true;
  summary.wallMs = Date.now() - startedAt;
  summary.failures = failures;
  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));
  db.close();
  log(`PASS——三相全过（${Math.round((summary.wallMs as number) / 1000)}s）。产物：${OUT_DIR}`);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  if (process.argv.includes('--victim')) {
    await victimMain();
    return;
  }
  await orchestratorMain();
}

main().catch((error: unknown) => {
  console.error(`[segment-resume-smoke] FAIL：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
