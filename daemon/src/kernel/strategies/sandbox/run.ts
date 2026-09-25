/**
 * 自由代码沙箱宿主执行器（add-subject-sam-pipeline P1.4——design §4.4+tasks.md P1.4）。
 *
 * 职责分层（worker.cjs 头注「逃逸面枚举清单+防御对应表」的宿主侧对应）：
 *   [执行]   eval worker（new Worker(worker.cjs 源串,{eval:true})——无 tsx/loader 依赖，
 *            spawn ~40ms 探针实测）+ MessageChannel 协议 + SharedArrayBuffer 完成信号；
 *   [有界性三线] CPU 界=几何库调用计数（worker 侧 budgeted——超限 soft-kill 携调用数）；
 *            墙钟界=主线程 race 计时（超时 worker.terminate()——探针实证阻塞态 6.4ms 杀）；
 *            内存界=resourceLimits+结果数组长度上限（密度×面积×4）+postMessage 体积上限；
 *   [输出校验链] 用户返回值 → Zod 逐颗（KernelGem 白名单投影）→ 强制引擎校验门
 *            （gate.ts 间距/掩膜——违例颗剔除+warnings）→ 全灭/schema 拒 → typed error；
 *   [确定性回放] 同 code+同 seed 同果（worker 内建 mulberry32 与 ctx.rng 同源同构——
 *            tests 对拍把守；剔除 keep-earlier 序确定）。
 *
 * 同步/异步双模：异步=事件驱动（P3 LLM 循环消费面）；同步=Atomics.wait+receiveMessageOnPort
 * 桥（registry KernelStrategy.apply 同步冻结接口的适配——阻塞调用线程 ≤ wallMs，缺省 5s）。
 *
 * 有界重试接口位：SandboxRunOptions.maxRetries 仅声明（重试决策归调用方——P3 LLM 循环；
 * 本层只提供结构化失败 {ok:false,error,userMessage}，回 LLM 改写语境）。
 *
 * 模块环说明：registry → free-code → 本文件 → registry（KERNEL_GEM_SHAPE_IDS 值引用）。
 * 交叉引用全部延后到函数体（模块体零引用）——ESM 活绑定安全（测试/registry 双入口序均验）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { z } from 'zod';
import type { TreeBBox, TreeMask2D } from '../../vision/tree-to-blocks.js';
import { KERNEL_GEM_SHAPE_IDS, type KernelGem, type StrategyApplyInput, type StrategyContext, type StrategyWarning } from '../registry.js';
import { validateGemPlacement } from './gate.js';

// ---------------------------------------------------------------- 常量（有界缺省）

/** 用户代码体积上限（字节——CodeStrategyArtifact.source 无上限字段的沙箱侧界）。 */
export const SANDBOX_MAX_CODE_BYTES = 256 * 1024;
/** 墙钟界缺省（ms——同步模式阻塞调用线程上限同此）。 */
export const SANDBOX_DEFAULT_WALL_MS = 5_000;
/** 几何库调用预算缺省（每次白名单 API 调用+1）。 */
export const SANDBOX_DEFAULT_MAX_HELPER_CALLS = 200_000;
/** 结果数组长度上限下限（密度×面积×4 在微小节点退化——绝对下限防 1 颗式荒谬界）。 */
export const SANDBOX_MIN_GEM_CAP = 64;
/** postMessage 体积估算上限缺省（字节）。 */
export const SANDBOX_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** worker 内存界（V8 堆——分配 DoS 兜底；OOM → worker-crash typed error）。 */
export const SANDBOX_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  codeRangeSizeMb: 32,
  stackSizeMb: 8,
} as const;

// ---------------------------------------------------------------- worker 源与 screen 单源

const WORKER_SOURCE = readFileSync(new URL('./worker.cjs', import.meta.url), 'utf8');

/** SCREEN_PATTERNS 单源来自 worker.cjs（主线程 require 通道——双层 screen 同规则防漂移）。 */
const WORKER_MODULE = createRequire(import.meta.url)('./worker.cjs') as {
  SCREEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]>;
};

/**
 * 语法 screen（[E4][E5][E6]——动态 import()/require/process 字面量拒收）：先剥注释再
 * 匹配（worker.cjs screenCode 同规则）；返回命中的 token 名（null=通过）。
 * fail-closed：字符串内误命中只增拒绝不增放行（LLM 改写成本低）。
 */
export function screenUserCode(code: string): string | null {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const [token, re] of WORKER_MODULE.SCREEN_PATTERNS) {
    if (re.test(stripped)) return token;
  }
  return null;
}

// ---------------------------------------------------------------- typed error 分类

/** 沙箱失败分类（结构化——P3 有界重试回 LLM 的判据面）。 */
export type SandboxFailure =
  | { stage: 'forbidden-syntax'; token: string }
  | { stage: 'code-oversize'; bytes: number; max: number }
  | { stage: 'compile'; message: string }
  | { stage: 'entry-missing'; entryPoint: string }
  | { stage: 'runtime'; name: string; message: string }
  | { stage: 'helper-budget'; calls: number; max: number }
  | { stage: 'cpu-timeout'; wallMs: number }
  | { stage: 'worker-crash'; note?: string }
  | { stage: 'output-unserializable'; message: string }
  | { stage: 'output-oversize'; count: number; bytes?: number; max?: number }
  | { stage: 'schema'; issues: string[] }
  | { stage: 'gate-empty'; culled: number };

export interface SandboxFailureOutcome {
  ok: false;
  error: SandboxFailure;
  /** LLM 改写指引（人读中文——回 LLM 有界重试的 userMessage 通道）。 */
  userMessage: string;
}

export interface SandboxSuccessOutcome {
  ok: true;
  gems: KernelGem[];
  warnings: StrategyWarning[];
  /** 实际几何库调用数（预算消耗——审计/调参面）。 */
  helperCalls: number;
  elapsedMs: number;
}

export type SandboxOutcome = SandboxSuccessOutcome | SandboxFailureOutcome;

/** LLM 改写指引（stage → 人读建议——P3 有界重试上下文）。 */
function userMessageFor(f: SandboxFailure): string {
  switch (f.stage) {
    case 'forbidden-syntax':
      return `代码使用了被禁 API（${f.token}）——沙箱无网无 fs 无 import/require；请仅使用 sandbox 注入面（mask.at/scale/gem/geo.*/rand）重写`;
    case 'code-oversize':
      return `代码体积 ${f.bytes}B 超上限 ${f.max}B——精简算法或拆分`;
    case 'compile':
      return `代码编译失败：${f.message}`;
    case 'entry-missing':
      return `未定义入口函数 ${f.entryPoint}(sandbox)——代码需定义 function ${f.entryPoint}(sandbox){...} 并返回 Gem 数组`;
    case 'runtime':
      return `运行时错误（${f.name}）：${f.message}`;
    case 'helper-budget':
      return `几何库调用 ${f.calls} 次超预算 ${f.max}——降低循环调用量或减少候选点`;
    case 'cpu-timeout':
      return `执行超墙钟界 ${f.wallMs}ms（死循环/过重计算/沙箱崩溃）——检查循环终止与复杂度`;
    case 'worker-crash':
      return `沙箱崩溃（可能内存超限）${f.note ?? ''}——降低内存占用`;
    case 'output-unserializable':
      return `返回值不可序列化：${f.message}`;
    case 'output-oversize':
      return `返回结果超上限（${f.count} 项${f.bytes !== undefined ? `/约 ${f.bytes}B` : ''}，上限 ${f.max ?? '密度×面积×4'}）——降密度或收敛布点`;
    case 'schema':
      return `返回的 Gem 数组形状非法（${f.issues.slice(0, 3).join('；')}）——每颗钻只允许 {x, y, shapeId?, rotationDeg?}（x/y 为画布像素坐标，shapeId 取 sandbox.gem.shapeIds 枚举）`;
    case 'gate-empty':
      return `${f.culled} 颗钻全部被引擎校验门剔除（间距/掩膜）——0 颗存留即策略失败；请保证钻心落在掩膜内且中心距 ≥ sandbox.gem.diameterPx`;
  }
}

function failure(error: SandboxFailure): SandboxFailureOutcome {
  return { ok: false, error, userMessage: userMessageFor(error) };
}

// ---------------------------------------------------------------- worker 协议载荷

export interface SandboxScale {
  pixelsPerMm: number;
  canvasCm: { w: number; h: number };
}

export interface SandboxGemSpec {
  diameterMm: number;
  diameterPx: number;
  shapeIds: readonly string[];
}

/** 低层 runUserCode 的注入载荷（测试 seam+P3 构件——即 worker 侧 sandbox 对象的线协议形态）。 */
export interface SandboxWorkerPayload {
  mask: { w: number; h: number; bits: Uint8Array };
  bbox: TreeBBox;
  scale: SandboxScale;
  gem: SandboxGemSpec;
  seed: number;
}

export interface SandboxRunOptions {
  /** 入口函数名（CodeStrategyArtifact.entryPoint 同义；缺省 'layout'）。 */
  entryPoint?: string;
  /** 确定性种子（CodeStrategyArtifact.seed 同义——同 code+同 seed 同果）。 */
  seed?: number;
  /** 墙钟界 ms（缺省 SANDBOX_DEFAULT_WALL_MS；测试用 150-300ms 短界）。 */
  wallMs?: number;
  /** 几何库调用预算（缺省 SANDBOX_DEFAULT_MAX_HELPER_CALLS）。 */
  maxHelperCalls?: number;
  /** 结果数组长度上限（缺省=密度×面积×4 下限 SANDBOX_MIN_GEM_CAP）。 */
  maxGems?: number;
  /** postMessage 体积估算上限（缺省 SANDBOX_MAX_PAYLOAD_BYTES）。 */
  maxPayloadBytes?: number;
  /** worker V8 界（缺省 SANDBOX_RESOURCE_LIMITS；OOM 测试用小值）。 */
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  };
  /**
   * 有界重试接口位（P3 LLM 循环消费）：本层**不消费**——失败一律结构化返回，
   * 重试决策归调用方（同 code+同 seed 确定性回放保证重试幂等前提）。
   */
  maxRetries?: number;
}

export interface UserCodeSuccess {
  ok: true;
  /** 用户代码原始返回值（未经 Zod——低层语义观察面）。 */
  raw: unknown;
  helperCalls: number;
}
export type UserCodeOutcome = UserCodeSuccess | SandboxFailureOutcome;

/** worker 完成回执（线协议——宽类型：stage 载荷经 doneToFailure 防御性提取）。 */
type WorkerDone = Record<string, unknown> & { kind: string; runId: number };

// ---------------------------------------------------------------- 有界性默认推导

/** 结果上限推导：max(SANDBOX_MIN_GEM_CAP, ceil(密度×面积×4))——brief 字面「Gem 数 > 密度×面积×4 拒」。 */
export function defaultMaxGems(densityPerCm2: number, areaPx: number, pixelsPerMm: number): number {
  const areaCm2 = areaPx / (pixelsPerMm ** 2 * 100);
  return Math.max(SANDBOX_MIN_GEM_CAP, Math.ceil(densityPerCm2 * areaCm2 * 4));
}

/** runSandboxArtifact 的注入载荷（input/ctx → worker 线协议；bits 拷贝防转移脱钩）。 */
function payloadOf(input: StrategyApplyInput, ctx: StrategyContext, seed: number): SandboxWorkerPayload {
  const ppm = input.canvas.pixelsPerMm;
  return {
    mask: { w: input.block.mask.w, h: input.block.mask.h, bits: input.block.mask.bits },
    bbox: input.block.bbox,
    scale: { pixelsPerMm: ppm, canvasCm: { w: input.canvas.cm.w, h: input.canvas.cm.h } },
    gem: {
      diameterMm: Math.round((ctx.gemDiameterPx / ppm) * 1e6) / 1e6,
      diameterPx: ctx.gemDiameterPx,
      shapeIds: KERNEL_GEM_SHAPE_IDS,
    },
    seed,
  };
}

/** run 消息（bits 复制件随 transferList 转移——调用方/输入 mask 永不脱钩）。 */
function buildRunMessage(runId: number, code: string, entryPoint: string, payload: SandboxWorkerPayload, deps: ExecDeps) {
  const bits = new Uint8Array(payload.mask.bits); // 拷贝（transferList 会 detach 原 buffer）
  return {
    msg: {
      kind: 'run' as const,
      runId,
      code,
      entryPoint,
      seed: payload.seed,
      mask: { w: payload.mask.w, h: payload.mask.h, bits },
      bbox: payload.bbox,
      scale: payload.scale,
      gem: payload.gem,
      limits: {
        maxHelperCalls: deps.maxHelperCalls,
        maxGems: deps.maxGems,
        maxPayloadBytes: deps.maxPayloadBytes,
        maxCodeBytes: SANDBOX_MAX_CODE_BYTES,
      },
    },
    transfer: [bits.buffer],
  };
}

/** worker 回执 → typed failure 映射（stage 字符串 → SandboxFailure 判别联合——防御性提取）。 */
function doneToFailure(d: WorkerDone): SandboxFailureOutcome {
  const s = String(d.stage);
  const n = (k: string): number | undefined => (typeof d[k] === 'number' ? (d[k] as number) : undefined);
  const str = (k: string): string | undefined => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
  switch (s) {
    case 'forbidden-syntax':
      return failure({ stage: 'forbidden-syntax', token: str('token') ?? 'unknown' });
    case 'code-oversize':
      return failure({ stage: 'code-oversize', bytes: n('bytes') ?? 0, max: n('max') ?? SANDBOX_MAX_CODE_BYTES });
    case 'compile':
      return failure({ stage: 'compile', message: str('message') ?? '' });
    case 'entry-missing':
      return failure({ stage: 'entry-missing', entryPoint: str('entryPoint') ?? 'layout' });
    case 'runtime':
      return failure({ stage: 'runtime', name: str('name') ?? 'Error', message: str('message') ?? '' });
    case 'helper-budget':
      return failure({ stage: 'helper-budget', calls: n('calls') ?? -1, max: n('max') ?? -1 });
    case 'output-unserializable':
      return failure({ stage: 'output-unserializable', message: str('message') ?? '' });
    case 'output-oversize':
      return failure({
        stage: 'output-oversize',
        count: n('count') ?? -1,
        ...(n('bytes') !== undefined ? { bytes: n('bytes') } : {}),
        ...(n('max') !== undefined ? { max: n('max') } : {}),
      });
    case 'worker-crash':
      return failure({ stage: 'worker-crash', ...(str('message') !== undefined ? { note: str('message') } : {}) });
    default:
      return failure({ stage: 'worker-crash', note: `未知 stage ${s}` });
  }
}

// ---------------------------------------------------------------- worker 生命周期（泄漏计数）

let activeWorkers = 0;
const pendingTerminations = new Set<Promise<void>>();

/** 活跃 worker 数（测试/诊断 seam——afterAll 零泄漏断言用）。 */
export function activeWorkerCount(): number {
  return activeWorkers;
}

/** 等待全部 terminate 完成（测试收尾——防 vitest worker 泄漏拖慢套件）。 */
export async function drainSandboxWorkers(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (pendingTerminations.size > 0 && Date.now() < deadline) {
    await Promise.allSettled([...pendingTerminations]);
  }
}

let runIdSeq = 0;

interface ExecDeps {
  wallMs: number;
  maxHelperCalls: number;
  maxGems: number;
  maxPayloadBytes: number;
  resourceLimits: NonNullable<SandboxRunOptions['resourceLimits']>;
}

/** 终止并回收 worker（幂等——首调生效；terminate 后计数递减入 pendingTerminations）。 */
function spawnTerminator(worker: Worker, port1: { close(): void }): () => Promise<void> {
  let done = false;
  return () => {
    if (done) return Promise.resolve();
    done = true;
    port1.close();
    const t = worker.terminate().then(
      () => {
        activeWorkers--;
      },
      () => {
        activeWorkers--;
      },
    );
    pendingTerminations.add(t);
    void t.then(() => pendingTerminations.delete(t));
    return t;
  };
}

/** 异步执行（事件驱动——P3 消费面/测试主通道）。 */
async function executeAsync(
  code: string,
  payload: SandboxWorkerPayload,
  entryPoint: string,
  deps: ExecDeps,
): Promise<UserCodeOutcome> {
  const { port1, port2 } = new MessageChannel();
  const sab = new SharedArrayBuffer(8);
  const runId = ++runIdSeq;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { port: port2, sab },
    transferList: [port2],
    resourceLimits: deps.resourceLimits,
  });
  activeWorkers++;
  const terminate = spawnTerminator(worker, port1);
  let settled = false;
  const settle = (fn: () => void): void => {
    settled = true;
    void terminate().then(fn);
  };
  try {
    return await new Promise<UserCodeOutcome>((resolve) => {
      const timer = setTimeout(() => {
        settle(() => resolve(failure({ stage: 'cpu-timeout', wallMs: deps.wallMs })));
      }, deps.wallMs);
      port1.on('message', (msg: WorkerDone) => {
        if (msg.kind !== 'done' || msg.runId !== runId) return;
        clearTimeout(timer);
        settle(() => {
          resolve(msg.ok === true ? { ok: true, raw: msg.raw, helperCalls: Number(msg.helperCalls ?? 0) } : doneToFailure(msg));
        });
      });
      worker.on('error', (e: Error) => {
        clearTimeout(timer);
        settle(() => resolve(failure({ stage: 'worker-crash', note: String(e.message).slice(0, 300) })));
      });
      worker.on('exit', (exitCode: number) => {
        if (settled) return; // 正常终止路径（message/timeout 已收割）
        clearTimeout(timer);
        settle(() =>
          resolve(failure({ stage: 'worker-crash', note: `worker 异常退出（code=${exitCode}——可能 OOM/资源界）` })),
        );
      });
      const { msg, transfer } = buildRunMessage(runId, code, entryPoint, payload, deps);
      port1.postMessage(msg, transfer);
    });
  } finally {
    await terminate();
  }
}

/** 同步桥（registry apply 冻结同步接口适配）：Atomics.wait 墙钟界 + receiveMessageOnPort 收割。 */
function executeSync(code: string, payload: SandboxWorkerPayload, entryPoint: string, deps: ExecDeps): UserCodeOutcome {
  const { port1, port2 } = new MessageChannel();
  const sab = new SharedArrayBuffer(8);
  const i32 = new Int32Array(sab);
  const runId = ++runIdSeq;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { port: port2, sab },
    transferList: [port2],
    resourceLimits: deps.resourceLimits,
  });
  activeWorkers++;
  const terminate = spawnTerminator(worker, port1);
  try {
    const { msg, transfer } = buildRunMessage(runId, code, entryPoint, payload, deps);
    port1.postMessage(msg, transfer);
    const waitRes = Atomics.wait(i32, 0, 0, deps.wallMs); // 阻塞调用线程 ≤ wallMs（apply 同步界）
    if (waitRes === 'ok') {
      const received = receiveMessageOnPort(port1);
      const done = received?.message as WorkerDone | undefined;
      if (done !== undefined && done.kind === 'done' && done.runId === runId) {
        return done.ok === true ? { ok: true, raw: done.raw, helperCalls: Number(done.helperCalls ?? 0) } : doneToFailure(done);
      }
    }
    // 超时或崩溃未及回执（同步域观察不到 exit 事件——统一墙钟界语义，userMessage 注记可能崩溃）
    return failure({ stage: 'cpu-timeout', wallMs: deps.wallMs });
  } finally {
    void terminate();
  }
}

// ---------------------------------------------------------------- 输出校验链（Zod + 强制引擎校验门）

/** 用户返回钻的白名单投影（KernelGem 内核强制字段不开放——id/blockId/colorId/diameterMm 由宿主生成）。 */
function rawGemSchema(shapeIds: readonly string[]) {
  const enumValues = (shapeIds.length > 0 ? shapeIds : ['round']).slice() as [string, ...string[]];
  return z
    .object({
      x: z.number(),
      y: z.number(),
      shapeId: z.enum(enumValues).optional(),
      rotationDeg: z.number().min(0).max(360).optional(),
    })
    .strict();
}

export interface ValidationChainDeps {
  blockId: string;
  shapeIds: readonly string[];
  mask: TreeMask2D;
  bbox: TreeBBox;
  gemDiameterPx: number;
  pixelsPerMm: number;
}

/** raw → 校验链终点（gems+warnings / typed failure——纯宿主侧，无 IO 无随机：确定性）。 */
export function validateRawGems(
  raw: unknown,
  deps: ValidationChainDeps,
): { ok: true; gems: KernelGem[]; warnings: StrategyWarning[] } | SandboxFailureOutcome {
  if (!Array.isArray(raw)) return failure({ stage: 'schema', issues: [`返回值必须是 Gem 数组（实为 ${typeof raw}）`] });
  const schema = rawGemSchema(deps.shapeIds);
  const gems: KernelGem[] = [];
  const issues: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = schema.safeParse(raw[i]);
    if (!parsed.success) {
      issues.push(`第 ${i + 1} 颗：${parsed.error.issues.map((x) => `${x.path.join('.') || '(root)'} ${x.message}`).join(', ')}`);
      if (issues.length >= 5) break;
      continue;
    }
    const r = parsed.data;
    gems.push({
      id: `${deps.blockId}#${String(i + 1).padStart(4, '0')}`,
      x: r.x,
      y: r.y,
      colorId: '',
      blockId: deps.blockId,
      shapeId: (r.shapeId ?? 'round') as KernelGem['shapeId'],
      diameterMm: Math.round((deps.gemDiameterPx / deps.pixelsPerMm) * 1e6) / 1e6,
      ...(r.rotationDeg !== undefined ? { rotationDeg: r.rotationDeg } : {}),
    });
  }
  if (issues.length > 0) return failure({ stage: 'schema', issues });
  if (gems.length === 0) return failure({ stage: 'gate-empty', culled: 0 }); // 空产出=非法（不静默零 Gem——同 reserved fail-fast 哲学）

  const verdict = validateGemPlacement(gems, { mask: deps.mask, bbox: deps.bbox, minPx: deps.gemDiameterPx * 0.999 });
  if (verdict.kept.length === 0) return failure({ stage: 'gate-empty', culled: verdict.culled.length });
  const warnings: StrategyWarning[] = [];
  const maskCulled = verdict.culled.filter((c) => c.kind === 'mask');
  const spacingCulled = verdict.culled.filter((c) => c.kind === 'spacing');
  if (maskCulled.length > 0) {
    warnings.push({
      kind: 'mask',
      detail: `自由代码输出 ${maskCulled.length} 颗越出掩膜被引擎校验门剔除（如 ${maskCulled[0]!.detail}）`,
    });
  }
  if (spacingCulled.length > 0) {
    warnings.push({
      kind: 'spacing',
      detail: `自由代码输出 ${spacingCulled.length} 颗间距不足被引擎校验门剔除（如 ${spacingCulled[0]!.detail}）`,
    });
  }
  return { ok: true, gems: verdict.kept, warnings };
}

// ---------------------------------------------------------------- 公共入口

function resolveDeps(opts: SandboxRunOptions, defaults: { maxGems: number }): ExecDeps {
  if (opts.maxRetries !== undefined && (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0)) {
    throw new RangeError('maxRetries 必须为非负整数（接口位——重试决策归调用方）');
  }
  if (opts.wallMs !== undefined && !(opts.wallMs > 0)) throw new RangeError('wallMs 必须为正');
  if (opts.maxHelperCalls !== undefined && !(opts.maxHelperCalls > 0)) throw new RangeError('maxHelperCalls 必须为正');
  return {
    wallMs: opts.wallMs ?? SANDBOX_DEFAULT_WALL_MS,
    maxHelperCalls: opts.maxHelperCalls ?? SANDBOX_DEFAULT_MAX_HELPER_CALLS,
    maxGems: opts.maxGems ?? defaults.maxGems,
    maxPayloadBytes: opts.maxPayloadBytes ?? SANDBOX_MAX_PAYLOAD_BYTES,
    resourceLimits: opts.resourceLimits ?? SANDBOX_RESOURCE_LIMITS,
  };
}

/** 前置 screen+体积界（spawn 前拒——省一次 worker 生成）。 */
function precheck(code: string): SandboxFailureOutcome | null {
  if (typeof code !== 'string' || code.length === 0) {
    return failure({ stage: 'compile', message: 'code 必须为非空字符串' });
  }
  if (code.length > SANDBOX_MAX_CODE_BYTES) {
    return failure({ stage: 'code-oversize', bytes: code.length, max: SANDBOX_MAX_CODE_BYTES });
  }
  const token = screenUserCode(code);
  if (token !== null) return failure({ stage: 'forbidden-syntax', token });
  return null;
}

/**
 * 低层执行（raw 观察 seam——逃逸面负测试/P3 构件）：仅 screen+有界执行，
 * 不做输出校验链（raw 原样返回）。失败结构化（同 SandboxFailure 分类）。
 */
export async function runUserCode(
  code: string,
  payload: SandboxWorkerPayload,
  opts: SandboxRunOptions = {},
): Promise<UserCodeOutcome> {
  const pre = precheck(code);
  if (pre !== null) return pre;
  const deps = resolveDeps(opts, { maxGems: opts.maxGems ?? SANDBOX_MIN_GEM_CAP });
  return executeAsync(code, payload, opts.entryPoint ?? 'layout', deps);
}

function chainOutcome(
  outcome: UserCodeOutcome,
  input: StrategyApplyInput,
  ctx: StrategyContext,
  elapsedMs: number,
  shapeIds: readonly string[],
): SandboxOutcome {
  if (!outcome.ok) return outcome;
  const chain = validateRawGems(outcome.raw, {
    blockId: input.block.id,
    shapeIds,
    mask: input.block.mask,
    bbox: input.block.bbox,
    gemDiameterPx: ctx.gemDiameterPx,
    pixelsPerMm: input.canvas.pixelsPerMm,
  });
  if (!chain.ok) return chain;
  return { ok: true, gems: chain.gems, warnings: chain.warnings, helperCalls: outcome.helperCalls, elapsedMs };
}

/**
 * 自由代码策略执行（完整链：screen→worker 有界执行→Zod→强制引擎校验门）。
 * 确定性回放：同 code+同 seed+同 input → 同 gems（tests 逐颗对拍把守）。
 */
export async function runSandboxArtifact(
  code: string,
  input: StrategyApplyInput,
  ctx: StrategyContext,
  opts: SandboxRunOptions = {},
): Promise<SandboxOutcome> {
  const pre = precheck(code);
  if (pre !== null) return pre;
  const payload = payloadOf(input, ctx, opts.seed ?? 0);
  const deps = resolveDeps(opts, {
    maxGems: defaultMaxGems(ctx.densityPerCm2, input.block.areaPx, input.canvas.pixelsPerMm),
  });
  const t0 = Date.now();
  const outcome = await executeAsync(code, payload, opts.entryPoint ?? 'layout', deps);
  return chainOutcome(outcome, input, ctx, Date.now() - t0, payload.gem.shapeIds);
}

/**
 * 同步形态（registry apply 适配）：Atomics 桥——阻塞调用线程 ≤ wallMs。
 * worker 崩溃（OOM 等）在同步域观察不到 exit 事件，落入墙钟界语义（userMessage 注记）。
 */
export function runSandboxArtifactSync(
  code: string,
  input: StrategyApplyInput,
  ctx: StrategyContext,
  opts: SandboxRunOptions = {},
): SandboxOutcome {
  const pre = precheck(code);
  if (pre !== null) return pre;
  const payload = payloadOf(input, ctx, opts.seed ?? 0);
  const deps = resolveDeps(opts, {
    maxGems: defaultMaxGems(ctx.densityPerCm2, input.block.areaPx, input.canvas.pixelsPerMm),
  });
  const t0 = Date.now();
  const outcome = executeSync(code, payload, opts.entryPoint ?? 'layout', deps);
  return chainOutcome(outcome, input, ctx, Date.now() - t0, payload.gem.shapeIds);
}
