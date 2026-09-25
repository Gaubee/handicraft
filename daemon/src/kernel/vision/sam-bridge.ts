/**
 * macmini SAM 桥——daemon 侧（add-subject-sam-pipeline P2.2 / design §7：S2 分析/
 * S3 抠图共用）。原始需求 2026-09-24（Owner：模型推理只在 macmini；输出留存可审查）。
 * 协议形态沿 experiments/sam3-spike-20260924 spike 实证（stdin/stdout JSON + mask
 * base64 + overlay 图字节），本波纯本地 mock 面——真连归 P2.6 opt-in 冒烟。
 * 类型归属决策：协议类型放 daemon 内（非 contracts）——SamBridgeRequest/Response 是
 * daemon↔macmini 的传输实现细节，永不过前端；contracts 只收跨端工件
 * （ObjectTree/SceneAnalysis——P0.1 已冻结），避免 contracts 膨胀。
 * 正交意图：
 *   [1] 协议类型：请求（分析/抠图两类：imageBlobRef+prompt{几何点框|语义文本}+
 *       canvas 锚点）/响应（mask 两态+meta{model/耗时/迭代号}+叠加预览图可选）。
 *   [2] 传输抽象：SamTransport（send(call)→response）；SSH 实现=结构占位
 *       （ssh2 vs 系统 ssh 子进程=P2.6 前置决策，不引依赖）；Mock=可编程测试替身。
 *   [3] 队列与界限：并发 1 串行队列+每请求 120s 超时界+队列满显式拒（typed error）
 *       +取消传播（排队中取消=移出；执行中取消=结果丢弃不落库）。
 *   [4] 产物回传：响应 mask→BlobStore（经 putTaskArtifact——fence 同事务）+叠加
 *       预览图→BlobStore+输出留存目录（DATA_ROOT/sam-logs/{date}/{taskId}/
 *       req-resp JSON+mask.png+overlay 图——「输出留存可审查」纪律）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BlobRefSchema,
  CanvasCmSchema,
  IdSchema,
  ImagePxSchema,
  Mask2DRefSchema,
  NodeBBoxSchema,
  SceneElementSchema,
  type BlobMask,
  type CanvasCm,
  type ImagePx,
  type SceneElement,
} from '@handicraft/contracts';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { encodePng } from '../../png/codec.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import { resolveMaskBits } from './tree-persist.js';

/** 每请求超时界（design §7「有界超时」——46s/提示实测的 2.6 倍余量）。 */
export const SAM_REQUEST_TIMEOUT_MS = 120_000;

/** 排队等待容量上限（并发 1 之外允许的等待者数；超出显式拒）。 */
export const SAM_QUEUE_MAX_WAITING = 8;

/** 输出留存根目录名（DATA_ROOT 下）。 */
export const SAM_LOGS_DIRNAME = 'sam-logs';

// ---------------------------------------------------------------- [1] 协议类型

/** 语义文本提示（spike 实证 person/hat 类英文语义词最稳）。 */
export const SamTextPromptSchema = z
  .object({
    kind: z.literal('text'),
    text: z.string().min(1),
  })
  .strict();
export type SamTextPrompt = z.infer<typeof SamTextPromptSchema>;

/** 几何提示（圈选微调面——用户标记强调/排除点+可选框；design §0「补充微调手段」）。 */
export const SamPointSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    label: z.enum(['include', 'exclude']),
  })
  .strict();
export type SamPoint = z.infer<typeof SamPointSchema>;

export const SamGeometricPromptSchema = z
  .object({
    kind: z.literal('geometric'),
    points: z.array(SamPointSchema).min(1),
    box: NodeBBoxSchema.optional(),
  })
  .strict();
export type SamGeometricPrompt = z.infer<typeof SamGeometricPromptSchema>;

export const SamPromptSchema = z.discriminatedUnion('kind', [
  SamTextPromptSchema,
  SamGeometricPromptSchema,
]);
export type SamPrompt = z.infer<typeof SamPromptSchema>;

/** 请求公共锚点（canvas 一等输入——S1 声明随请求留存，供响应侧对齐）。 */
const SamRequestAnchor = {
  taskId: IdSchema,
  imageBlobRef: BlobRefSchema,
  imagePx: ImagePxSchema,
  canvasCm: CanvasCmSchema,
  /** S3 迭代号（0 基——停止判据 hard-cap 输入；响应 meta 回显）。 */
  iteration: z.number().int().nonnegative(),
} as const;

export const SamBridgeRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('segment'),
      ...SamRequestAnchor,
      prompt: SamPromptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('analyze'),
      ...SamRequestAnchor,
      /** VLM 全图分析指令（S2 scene.analyze 面——几何提示不适用于分析类）。 */
      prompt: SamTextPromptSchema,
    })
    .strict(),
]);
export type SamBridgeRequest = z.infer<typeof SamBridgeRequestSchema>;
export type SamSegmentRequest = Extract<SamBridgeRequest, { kind: 'segment' }>;
export type SamAnalyzeRequest = Extract<SamBridgeRequest, { kind: 'analyze' }>;

/** 响应 meta（model 版本/耗时/迭代号——迭代号自请求回显）。 */
export const SamResponseMetaSchema = z
  .object({
    model: z.string().min(1),
    durationMs: z.number().nonnegative(),
    iteration: z.number().int().nonnegative(),
  })
  .strict();
export type SamResponseMeta = z.infer<typeof SamResponseMetaSchema>;

/** 叠加预览图（可选——macmini 侧渲染的半透明彩色+label+score 图字节，base64 过 JSON 线）。 */
export const SamOverlayPreviewSchema = z
  .object({
    mime: z.enum(['image/png', 'image/jpeg']),
    dataBase64: z.string().min(4),
  })
  .strict();
export type SamOverlayPreview = z.infer<typeof SamOverlayPreviewSchema>;

/**
 * 响应：segment 携 mask（inline/blob 引用二选一——Mask2DRef 两态：inline=base64-01
 * 过 JSON 线；blob=daemon BlobStore 既有引用，本地/缓存型传输面用）；analyze 携
 * 元素清单（SceneElement 同构——P2.3 组装 SceneAnalysis 工件）。
 */
export const SamBridgeResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('segment'),
      mask: Mask2DRefSchema,
      score: z.number().min(0).max(1).optional(),
      overlay: SamOverlayPreviewSchema.optional(),
      meta: SamResponseMetaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('analyze'),
      elements: z.array(SceneElementSchema),
      meta: SamResponseMetaSchema,
    })
    .strict(),
]);
export type SamBridgeResponse = z.infer<typeof SamBridgeResponseSchema>;
export type SamSegmentResponse = Extract<SamBridgeResponse, { kind: 'segment' }>;

// ---------------------------------------------------------------- typed error

export type SamBridgeErrorKind =
  | 'queue-full'
  | 'timeout'
  | 'cancelled'
  | 'transport'
  | 'invalid-response'
  | 'fence'
  | 'unimplemented'
  | 'internal';

/** 桥面统一 typed error（沿 imgapi ImageApiError kind 先例——kind 判别失败面）。 */
export class SamBridgeError extends Error {
  readonly kind: SamBridgeErrorKind;

  constructor(message: string, kind: SamBridgeErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SamBridgeError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- [2] 传输抽象

/** 传输调用面：桥已解析的原图字节+合并取消信号（超时/取消都汇入 signal）。 */
export interface SamTransportCall {
  request: SamBridgeRequest;
  /** imageBlobRef 解析出的原图字节（桥读 BlobStore——传输层是纯字节管道）。 */
  imageBytes: Uint8Array;
  /** 取消信号（超时界/调用方取消二合一——实现必须尽快中止并使 send 落定）。 */
  signal?: AbortSignal;
}

export interface SamTransport {
  send(call: SamTransportCall): Promise<SamBridgeResponse>;
}

/** SSH 传输配置（P2.6 真连时补全——远端常驻服务=P2.1 spike.py 底座改 stdin/stdout JSON 协议）。 */
export interface SshSamTransportOptions {
  host: string;
  port?: number;
  username: string;
  /** 远端常驻服务启动命令（P2.1 产物）。 */
  remoteCommand: string;
  /** 连接/握手超时（ms）。 */
  connectTimeoutMs?: number;
}

/**
 * SSH 长连接传输——结构占位（design §7「SSH 长连接」）。P2.6 前置决策（未决，故不引
 * 依赖）：① ssh2 库（连接池化/流控内控，但重依赖面）；② 系统 ssh 子进程
 * （ControlMaster 长连接，零依赖但进程管理面）。决策前 send 恒拒（unimplemented）。
 */
export class SshSamTransport implements SamTransport {
  constructor(readonly options: SshSamTransportOptions) {}

  send(): Promise<SamBridgeResponse> {
    return Promise.reject(
      new SamBridgeError(
        `SshSamTransport 未实现（P2.6 真连前置决策：ssh2 依赖 vs 系统 ssh 子进程二选一；目标 ${this.options.username}@${this.options.host}）`,
        'unimplemented',
      ),
    );
  }
}

/** Mock 传输可编程处理器（逐请求弹出；响应/延迟/失败注入由处理器自定义）。 */
export type MockSamHandler = (
  call: SamTransportCall,
) => Promise<SamBridgeResponse> | SamBridgeResponse;

/**
 * 可编程 mock 传输（测试用——P2.3/P2.4/P2.5 mock 桥与验收门「全链 mock 桥」复用）：
 * respond() 逐请求编程（脚本队列，空=显式拒绝）；requests 记录送达序（串行实证）；
 * abortedCalls 统计信号中止（取消传播观测面）。
 */
export class MockSamTransport implements SamTransport {
  readonly requests: SamBridgeRequest[] = [];
  abortedCalls = 0;
  private readonly script: MockSamHandler[] = [];

  respond(handler: MockSamHandler): this {
    this.script.push(handler);
    return this;
  }

  async send(call: SamTransportCall): Promise<SamBridgeResponse> {
    this.requests.push(call.request);
    const handler = this.script.shift();
    if (handler === undefined) {
      throw new Error('MockSamTransport：未编程响应（respond 队列已空）');
    }
    const handled = Promise.resolve().then(() => handler(call));
    handled.catch(() => {}); // 竞败/中止后迟到落定——不给进程留 unhandledRejection
    if (call.signal === undefined) return handled;
    const { signal } = call;
    return await Promise.race([
      handled,
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          this.abortedCalls++;
          reject(signal.reason ?? new SamBridgeError('mock 传输请求已中止', 'cancelled'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  }
}

/** 可中止延迟（mock 处理器注入延迟用——signal 中止即 reject，不留悬挂定时器）。 */
export function samDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new SamBridgeError('延迟已中止', 'cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------- [4] 结果面

/** 留存文件集（sam-logs 下本次请求的全部落点——绝对路径）。 */
export interface SamRetentionFiles {
  dir: string;
  exchangeJson: string;
  maskPng?: string;
  overlayImage?: string;
}

export interface SamSegmentRunResult {
  kind: 'segment';
  /** 落盘后掩码（blob 态——putTaskArtifact 产物，内容=w*h 0/1 字节 Mask2D 同构）。 */
  mask: BlobMask;
  overlay?: { blobRef: string; mime: 'image/png' | 'image/jpeg' };
  score?: number;
  meta: SamResponseMeta;
  retention: SamRetentionFiles;
}

export interface SamAnalyzeRunResult {
  kind: 'analyze';
  elements: SceneElement[];
  meta: SamResponseMeta;
  retention: SamRetentionFiles;
}

export type SamRunResult = SamSegmentRunResult | SamAnalyzeRunResult;

/** 留存记录 outcome（exchange.json 的 outcome 字面量——审查面词汇表）。 */
export type SamRetentionOutcome =
  | 'ok'
  | 'cancelled'
  | 'timeout'
  | 'transport-error'
  | 'invalid-response'
  | 'fence-rejected'
  | 'internal-error';

// ---------------------------------------------------------------- [3] 桥本体

export interface SamBridgeDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** DATA_ROOT（sam-logs 留存根）。 */
  dataRoot: string;
}

export interface SamBridgeOptions {
  transport: SamTransport;
  /** 每请求超时界（ms）——缺省 120_000；测试短界注入。 */
  timeoutMs?: number;
  /** 排队等待容量——缺省 8；超出显式拒（queue-full）。 */
  maxWaiting?: number;
}

export interface SamRunOptions {
  /** 调用方取消信号（排队中取消=移出；执行中取消=结果丢弃不落库）。 */
  signal?: AbortSignal;
}

interface PendingEntry {
  request: SamBridgeRequest;
  signal?: AbortSignal;
  resolve: (result: SamRunResult) => void;
  reject: (error: unknown) => void;
  /** 排队期取消监听（执行期取消由 execute 内 race 承接）。 */
  onCallerAbort: () => void;
}

/** 任意 promise → 永不 reject 的结果盒（race 竞败迟到拒绝不炸进程）。 */
function noReject<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

/**
 * SAM 桥：并发 1 串行队列+120s 界+取消传播+产物回传+输出留存。
 * 生命周期：进程级单例语义（SSH 长连接归传输层；桥本身无后台任务——每请求的
 * timer 在 execute finally 必清，零常驻定时器/连接）。落定保证：execute 任何
 * 路径必 settle 恰一次（外层兜底把意外错误也收敛为 reject——promise 不悬挂）。
 */
export class SamBridge {
  private readonly transport: SamTransport;
  private readonly timeoutMs: number;
  private readonly maxWaiting: number;
  private readonly queue: PendingEntry[] = [];
  private running: PendingEntry | null = null;
  private seq = 0;

  constructor(
    private readonly deps: SamBridgeDeps,
    options: SamBridgeOptions,
  ) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? SAM_REQUEST_TIMEOUT_MS;
    this.maxWaiting = options.maxWaiting ?? SAM_QUEUE_MAX_WAITING;
  }

  /** 队列快照（测试/监控面）。 */
  snapshot(): { running: boolean; waiting: number } {
    return { running: this.running !== null, waiting: this.queue.length };
  }

  /**
   * 提交一请求（排队→串行执行→响应校验→产物回传→留存）。
   * 失败面全部 typed（SamBridgeError）：queue-full/timeout/cancelled/transport/
   * invalid-response/fence；请求本身非法抛 ZodError（调用方 bug，不入队）。
   */
  run(request: SamBridgeRequest, options: SamRunOptions = {}): Promise<SamRunResult> {
    const parsed = SamBridgeRequestSchema.parse(request);
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(new SamBridgeError('SAM 请求在入队前已取消', 'cancelled'));
    }
    if (this.queue.length >= this.maxWaiting) {
      return Promise.reject(
        new SamBridgeError(
          `SAM 桥队列已满（等待 ${this.queue.length}/${this.maxWaiting}，并发 1）——显式拒绝`,
          'queue-full',
        ),
      );
    }
    return new Promise<SamRunResult>((resolve, reject) => {
      const entry: PendingEntry = {
        request: parsed,
        signal,
        resolve,
        reject,
        onCallerAbort: () => {
          if (this.running === entry) return; // 执行中——execute race 承接
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1); // 排队中取消=移出（design §7）
            reject(
              withRetention(
                new SamBridgeError(`SAM ${parsed.kind} 请求排队中被取消（移出队列）`, 'cancelled'),
                null,
              ),
            );
          }
        },
      };
      signal?.addEventListener('abort', entry.onCallerAbort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    while (this.running === null && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.running = entry;
      void this.execute(entry).finally(() => {
        // belt-and-braces：正常路径 finish 已先释放（settle 前置——await run() 返回即空闲）
        if (this.running === entry) this.running = null;
        this.pump();
      });
    }
  }

  /**
   * 收口原语：先释放占用再 settle（调用方 await 返回时 snapshot 已空闲——语义
   * 「任务完成即队列入睡」），最后续泵。settle 只被调用一次（各路径互斥）。
   */
  private finish(entry: PendingEntry, settle: () => void): void {
    if (this.running === entry) this.running = null;
    settle();
    this.pump();
  }

  /** 落定保证外壳：executeInner 全路径已 settle；此处兜底意外逃逸（必不悬挂）。 */
  private async execute(entry: PendingEntry): Promise<void> {
    try {
      await this.executeInner(entry);
    } catch (error) {
      const wrapped =
        error instanceof SamBridgeError
          ? error
          : new SamBridgeError(
              `SAM 桥内部错误：${error instanceof Error ? error.message : String(error)}`,
              'internal',
              { cause: error },
            );
      this.finish(entry, () => entry.reject(wrapped));
    }
  }

  private async executeInner(entry: PendingEntry): Promise<void> {
    const { request, signal } = entry;
    const seq = ++this.seq;
    const startedAt = Date.now();

    // —— 原图字节（存在性前置——不把缺图请求送上传输线）
    const imageBytes = this.deps.blobs.read(request.imageBlobRef);
    if (imageBytes === null) {
      this.settleFailure(entry, seq, startedAt, 'transport-error', {
        response: undefined,
        error: new SamBridgeError(
          `原图 blob 不存在（blobRef=${request.imageBlobRef.slice(0, 12)}…）——请求未送出`,
          'transport',
        ),
      });
      return;
    }

    // —— 超时界+取消传播（二合一 AbortController；race 保证「执行中取消=结果丢弃不落库」）
    const controller = new AbortController();
    let callerAborted = false;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort(
        new SamBridgeError(`SAM ${request.kind} 请求已取消（执行中）`, 'cancelled'),
      );
    };
    if (signal) {
      if (signal.aborted) onCallerAbort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(
        new SamBridgeError(`SAM ${request.kind} 请求超时（${this.timeoutMs}ms 界）`, 'timeout'),
      );
    }, this.timeoutMs);
    const aborted = new Promise<{ aborted: true }>((resolve) => {
      const done = () => resolve({ aborted: true });
      if (controller.signal.aborted) done();
      else controller.signal.addEventListener('abort', done, { once: true });
    });

    const sent = noReject(
      this.transport.send({
        request,
        imageBytes: new Uint8Array(imageBytes),
        signal: controller.signal,
      }),
    );
    try {
      const raced = await Promise.race([sent, aborted]);
      if (controller.signal.aborted) {
        // 取消/超时胜出：以 signal 状态判（非 race 胜者——abort 同拍 sent 可能一并落定，
        // 但 abort 已发生即请求死亡，迟到响应一律丢弃不落库）；占用即释放，续跑队列
        this.settleFailure(entry, seq, startedAt, callerAborted ? 'cancelled' : 'timeout', {
          response: undefined,
          error: callerAborted
            ? new SamBridgeError(
                `SAM ${request.kind} 请求执行中取消——结果丢弃不落库`,
                'cancelled',
              )
            : new SamBridgeError(
                `SAM ${request.kind} 请求超时（${this.timeoutMs}ms 界）`,
                'timeout',
              ),
        });
        return;
      }
      if ('aborted' in raced) {
        // 理论不可达（aborted resolve ⇒ signal.aborted）——防御性同路收口
        this.settleFailure(entry, seq, startedAt, 'timeout', {
          response: undefined,
          error: new SamBridgeError(`SAM ${request.kind} 请求中止（竞态兜底）`, 'timeout'),
        });
        return;
      }
      if (!raced.ok) {
        const cause = raced.error;
        this.settleFailure(entry, seq, startedAt, 'transport-error', {
          response: undefined,
          error: new SamBridgeError(
            `SAM 传输失败（${request.kind}）：${cause instanceof Error ? cause.message : String(cause)}`,
            'transport',
            { cause },
          ),
        });
        return;
      }
      const response = raced.value;

      // —— 响应校验（schema+kind 匹配；坏 mask 由 Mask2DRefSchema superRefine 拒收）
      const check = SamBridgeResponseSchema.safeParse(response);
      if (!check.success) {
        this.settleFailure(entry, seq, startedAt, 'invalid-response', {
          response,
          error: new SamBridgeError(
            `SAM 响应校验失败（期望 ${request.kind}）：${check.error.issues
              .map((i) => i.message)
              .join('; ')}`,
            'invalid-response',
            { cause: check.error },
          ),
        });
        return;
      }
      if (check.data.kind !== request.kind) {
        this.settleFailure(entry, seq, startedAt, 'invalid-response', {
          response,
          error: new SamBridgeError(
            `SAM 响应 kind 不匹配（请求 ${request.kind} ≠ 响应 ${check.data.kind}）`,
            'invalid-response',
          ),
        });
        return;
      }

      // —— 产物回传+留存（物化是同步段——取消信号不可能插入；fence 拒绝归 'fence-rejected'）
      try {
        const result = this.materialize(seq, startedAt, request, check.data);
        this.finish(entry, () => entry.resolve(result));
      } catch (error) {
        if (error instanceof ArtifactFenceError) {
          this.settleFailure(entry, seq, startedAt, 'fence-rejected', {
            response,
            error: new SamBridgeError(
              `SAM 产物回传被 fence 拒绝（任务 ${request.taskId} 已不可写）：${error.message}`,
              'fence',
              { cause: error },
            ),
          });
          return;
        }
        if (error instanceof SamBridgeError && error.kind === 'invalid-response') {
          this.settleFailure(entry, seq, startedAt, 'invalid-response', { response, error });
          return;
        }
        throw error; // 留存落盘等意外——execute 外壳收敛为 internal reject
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** 失败收口：留存记录（含可选响应原文）→ typed reject（错误携带留存落点）。 */
  private settleFailure(
    entry: PendingEntry,
    seq: number,
    startedAt: number,
    outcome: SamRetentionOutcome,
    failure: { response?: SamBridgeResponse; error: SamBridgeError },
  ): void {
    const retention = this.writeRetention({
      seq,
      startedAt,
      request: entry.request,
      outcome,
      ...(failure.response !== undefined ? { response: failure.response } : {}),
      error: `${failure.error.name}[${failure.error.kind}]: ${failure.error.message}`,
    });
    this.finish(entry, () => entry.reject(withRetention(failure.error, retention)));
  }

  /** 成功路径：按 kind 物化产物（BlobStore）+写留存。 */
  private materialize(
    seq: number,
    startedAt: number,
    request: SamBridgeRequest,
    response: SamBridgeResponse,
  ): SamRunResult {
    if (response.kind === 'analyze') {
      const retention = this.writeRetention({
        seq,
        startedAt,
        request,
        outcome: 'ok',
        response,
      });
      return { kind: 'analyze', elements: response.elements, meta: response.meta, retention };
    }
    // segment：overlay 先验后落（解码为空=拒收，先于任何 blob 写入——不留半落盘残留）
    let overlay: { blobRef: string; mime: 'image/png' | 'image/jpeg' } | undefined;
    let overlayBytes: Uint8Array | undefined;
    if (response.overlay !== undefined) {
      const decoded = Buffer.from(response.overlay.dataBase64, 'base64');
      if (decoded.byteLength === 0) {
        throw new SamBridgeError('overlay 预览图 base64 解码为空——拒收', 'invalid-response');
      }
      overlayBytes = decoded;
    }
    // mask 两态 → bits（blob 态长度/取值校验内建）→ 任务域 blob（fence 同事务）
    const bits = resolveMaskBits(this.deps.blobs, response.mask);
    const maskRef = putTaskArtifact(this.deps, request.taskId, bits.bits).hash;
    const mask: BlobMask = { kind: 'blob', w: bits.w, h: bits.h, blobRef: maskRef };
    if (overlayBytes !== undefined && response.overlay !== undefined) {
      const overlayRef = putTaskArtifact(this.deps, request.taskId, overlayBytes).hash;
      overlay = { blobRef: overlayRef, mime: response.overlay.mime };
    }
    const retention = this.writeRetention({
      seq,
      startedAt,
      request,
      outcome: 'ok',
      response,
      blobRefs: overlay ? [maskRef, overlay.blobRef] : [maskRef],
      maskPng: renderMaskPng(bits.w, bits.h, bits.bits),
      ...(overlayBytes !== undefined && response.overlay !== undefined
        ? { overlay: { mime: response.overlay.mime, bytes: overlayBytes } }
        : {}),
    });
    return {
      kind: 'segment',
      mask,
      ...(overlay !== undefined ? { overlay } : {}),
      ...(response.score !== undefined ? { score: response.score } : {}),
      meta: response.meta,
      retention,
    };
  }

  /** 输出留存：sam-logs/{date}/{taskId}/{seq}-{kind}-{startedAtMs}.{json|png|图}。 */
  private writeRetention(input: {
    seq: number;
    startedAt: number;
    request: SamBridgeRequest;
    outcome: SamRetentionOutcome;
    response?: SamBridgeResponse;
    error?: string;
    blobRefs?: string[];
    maskPng?: Uint8Array;
    overlay?: { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array };
  }): SamRetentionFiles {
    const date = new Date(input.startedAt).toISOString().slice(0, 10);
    const dir = path.join(this.deps.dataRoot, SAM_LOGS_DIRNAME, date, input.request.taskId);
    mkdirSync(dir, { recursive: true });
    const stamp = `${String(input.seq).padStart(4, '0')}-${input.request.kind}-${input.startedAt}`;
    const exchangeJson = path.join(dir, `${stamp}.json`);
    writeFileSync(
      exchangeJson,
      JSON.stringify(
        {
          seq: input.seq,
          outcome: input.outcome,
          startedAt: new Date(input.startedAt).toISOString(),
          durationMs: Date.now() - input.startedAt,
          request: input.request,
          ...(input.response !== undefined ? { response: input.response } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.blobRefs !== undefined ? { blobRefs: input.blobRefs } : {}),
        },
        null,
        1,
      ),
    );
    let maskPng: string | undefined;
    if (input.maskPng !== undefined) {
      maskPng = path.join(dir, `${stamp}-mask.png`);
      writeFileSync(maskPng, input.maskPng);
    }
    let overlayImage: string | undefined;
    if (input.overlay !== undefined) {
      overlayImage = path.join(
        dir,
        `${stamp}-overlay.${input.overlay.mime === 'image/png' ? 'png' : 'jpg'}`,
      );
      writeFileSync(overlayImage, input.overlay.bytes);
    }
    return {
      dir,
      exchangeJson,
      ...(maskPng !== undefined ? { maskPng } : {}),
      ...(overlayImage !== undefined ? { overlayImage } : {}),
    };
  }
}

/** 失败错误附加留存落点（retention=null=尚未写留存——排队中取消等不入留存面）。 */
function withRetention(error: SamBridgeError, retention: SamRetentionFiles | null): SamBridgeError {
  (error as SamBridgeError & { retention?: SamRetentionFiles | null }).retention = retention;
  return error;
}

/** mask bits → 可审查 PNG（选中=白、背景=黑——spike mask_N.png 同语义）。 */
function renderMaskPng(w: number, h: number, bits: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = bits[i] === 1 ? 255 : 0;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(w, h, rgba);
}

// ---------------------------------------------------------------- 请求便捷构造

/** segment 请求构造（S3 迭代循环侧——字段同 schema，纯省样板+入口校验）。 */
export function makeSegmentRequest(input: {
  taskId: string;
  imageBlobRef: string;
  imagePx: ImagePx;
  canvasCm: CanvasCm;
  prompt: SamPrompt;
  iteration: number;
}): SamSegmentRequest {
  return SamBridgeRequestSchema.parse({ kind: 'segment', ...input }) as SamSegmentRequest;
}

/** analyze 请求构造（S2 scene.analyze 侧——iteration 恒 0）。 */
export function makeAnalyzeRequest(input: {
  taskId: string;
  imageBlobRef: string;
  imagePx: ImagePx;
  canvasCm: CanvasCm;
  prompt: SamTextPrompt;
  iteration?: number;
}): SamAnalyzeRequest {
  return SamBridgeRequestSchema.parse({
    kind: 'analyze',
    ...input,
    iteration: input.iteration ?? 0,
  }) as SamAnalyzeRequest;
}
