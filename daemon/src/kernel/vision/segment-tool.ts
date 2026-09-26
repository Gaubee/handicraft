/**
 * 迭代抠图工具面 `studio.subject.segment`（add-subject-sam-pipeline P3.3 缺口先补
 * / design §1 S3-S5）。P2.4 segmentLoop / P0.4 tree-persist / P2.2 SamBridge 均为
 * 函数面——本模块是它们与 P2.3 scene.analyze 工件之间的**工具面胶水**：readonly
 * 直调（MCP 投影 mcp__studio__subject_segment，过 tool-surface deny 名单）。
 * 原始需求 2026-09-25（P3.3 旅程验收简报：注册内核工具，串起 识图→抠图→树工件
 * →预览 的 agent 可调用面）。
 * 编排（单次调用）：
 *   [1] 输入解析：sceneAnalysisRef（scene.analyze 工件引用——读回+锚点校验）或
 *       自身入参 elements 注入（二选一，双双缺席/同时在场=invalid-input）；
 *       原图 blob 存在性+PNG 解码+尺寸与 imagePx 一致（锚点错位必拒——scene.analyze
 *       同款纪律）。
 *   [2] 装配：SAM 桥（共享 SamBridge 实例注入——kernel/index.ts 经
 *       resolveKernelSamTransport 装配真 SshSamTransport 惰性会话/env mock 桥；
 *       缺席=降级面 P2.5 fallbackSegment 颜色结构分块+warning，不静默假装语义抠图）。
 *       循环依赖=桥 segment 投影（mask→bits）+原图 Lab 色方差测量+时钟。
 *   [3] runSegmentLoop（P2.4 状态机：首轮=元素、后续=宽泛语义、停止判据内嵌、
 *       兄弟互斥/强制细分/碎片清理加固全量生效）。
 *   [4] persistTreeWithPreview（P0.4 双轨：object-tree.json+object-tree-preview.png
 *       工件）+ artifact 帧登记（jobs.emitFor——P3.2-channel 工件读通道以帧流
 *       artifact 帧为合法引用集，studio.ts 先例接法）。
 * 落定保证：typed reject（SubjectSegmentError kind 判别）或 outcome resolve；失败
 * 面 handler 统一 noteFailure（RUNAWAY 熔断照 studio.ts 先例）。
 * 降级语义边界：桥**未装配**=降级 fallbackSegment（§6.4 基础工作流不中断）；桥
 * **在线但失败**（timeout/transport/invalid-response…）=typed 上抛不静默降级
 * （scene.analyze 通道纪律同款——降级触发面归调用方/P2.5 消费者裁量）。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CanvasCmSchema,
  ImagePxSchema,
  SceneAnalysisSchema,
  SceneElementSchema,
  labFromRgb,
  type Lab,
  type ObjectTree,
  type SceneElement,
} from '@handicraft/contracts';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import type { JobService } from '../../jobs/service.js';
import { decodePng } from '../../png/codec.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityRegistry,
} from '../../capability/core.js';
import { RUNAWAY_LIMIT } from '../../capability/studio.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import {
  SamBridge,
  SamBridgeError,
  SshSamTransport,
  type SamAnalyzeRequest,
  type SamTransport,
} from './sam-bridge.js';
import {
  runSegmentLoop,
  type SegmentLoopWarning,
} from './segment-loop.js';
import { fallbackSegment } from './fallback-segment.js';
import {
  persistTreeWithPreview,
  resolveMaskBits,
  type TreeArtifactBundle,
} from './tree-persist.js';

// ---------------------------------------------------------------- 冻结常量

/** 工具面名（MCP 投影 mcp__studio__subject_segment——studio. 前缀过 deny 名单）。 */
export const SUBJECT_SEGMENT_TOOL_NAME = 'studio.subject.segment';

/** 真 SshSamTransport 装配 env 键（kernel/index.ts 消费——host+remoteCommand 成对才装）。 */
export const SAM_SSH_HOST_ENV = 'SAM_SSH_HOST';
export const SAM_SSH_REMOTE_COMMAND_ENV = 'SAM_SSH_REMOTE_COMMAND';
export const SAM_SSH_REQUEST_TIMEOUT_SEC_ENV = 'SAM_SSH_REQUEST_TIMEOUT_SEC';

/** env mock 桥开关（=1 → 本地确定性合成掩码 mock——旅程/演示面，非生产语义）。 */
export const SAM_BRIDGE_MOCK_ENV = 'SAM_BRIDGE_MOCK';

/**
 * 判据 1 钻径基准缺省（mm）：调用方未声明 maxGemDiameterMm 时的保守缺省（常规小钻
 * 上限一档；与 strategies FALLBACK_GEM_DIAMETER_MM 同值——两处语义不同源，不互相
 * import：循环判据缺省 vs 执行径推断基准）。
 */
export const SEGMENT_TOOL_DEFAULT_MAX_GEM_MM = 3;

/** 输出面节点摘要上限（树 schema 硬顶 256——工具结果帧有界，防 256 行结果爆帧）。 */
export const SEGMENT_TOOL_NODE_SUMMARY_CAP = 64;

// ---------------------------------------------------------------- 输入 schema

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（followup 注入提示中的 taskId——工件归属与 fence 的上下文）');

const BlobRefField = z.string().regex(/^[0-9a-f]{64}$/).describe('归一底图 blobRef（S0 产物——必须 PNG）');

/** 工具输入（elements 与 sceneAnalysisRef 二选一——superRefine XOR 校验）。 */
export const SubjectSegmentToolInputSchema = z
  .object({
    taskId: TaskIdField,
    imageBlobRef: BlobRefField,
    canvasCm: CanvasCmSchema.describe('画布物理尺寸声明（cm——S1 一等输入，随树工件留存）'),
    imagePx: ImagePxSchema.describe('归一底图像素尺寸（boxPx/bbox 锚点坐标系）'),
    sceneAnalysisRef: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe('scene.analyze 工件 blobRef（S2 产物——elements 与锚点真源；与 elements 二选一）'),
    elements: z
      .array(SceneElementSchema)
      .min(1)
      .optional()
      .describe('直接注入的元素清单（无 S2 工件时的调用方自备面；与 sceneAnalysisRef 二选一）'),
    maxIterations: z.number().int().min(1).max(64).optional().describe('迭代硬顶（缺省=画布面积标定公式）'),
    maxGemDiameterMm: z
      .number()
      .positive()
      .optional()
      .describe(`钻规格最大钻径 mm（判据 1 阈值=K×此值；缺省 ${SEGMENT_TOOL_DEFAULT_MAX_GEM_MM}）`),
    vlmReentry: z
      .boolean()
      .optional()
      .describe('后续轮 VLM 复入（design §2 接口位——默认 false；true 需桥支持 analyze）'),
  })
  .strict()
  .superRefine((input, ctx) => {
    const hasRef = input.sceneAnalysisRef !== undefined;
    const hasElements = input.elements !== undefined;
    if (hasRef === hasElements) {
      ctx.addIssue({
        code: 'custom',
        message: hasRef
          ? 'sceneAnalysisRef 与 elements 不得同时提供（二选一——S2 工件或直接注入）'
          : 'sceneAnalysisRef 与 elements 必须给其一（首轮提示源不可空）',
      });
    }
  });
export type SubjectSegmentInput = z.infer<typeof SubjectSegmentToolInputSchema>;

// ---------------------------------------------------------------- typed error

export type SubjectSegmentErrorKind =
  | 'invalid-input'
  | 'image-missing'
  | 'image-decode-failed'
  | 'analysis-missing'
  | 'analysis-invalid'
  | 'anchor-mismatch'
  | 'loop-failed'
  | 'fallback-failed'
  | 'fence'
  | 'internal';

/** subject.segment 统一 typed error（沿 SceneAnalyzeError kind 先例）。 */
export class SubjectSegmentError extends Error {
  readonly kind: SubjectSegmentErrorKind;

  constructor(message: string, kind: SubjectSegmentErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SubjectSegmentError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- 结果面

/** 降级 warning（桥未装配→P2.5 颜色结构分块——显式留痕，不静默）。 */
export interface SegmentToolDegradedWarning {
  reason: 'bridge-unavailable';
  degraded: 'fallback-color';
  detail: string;
}

/** 输出 warnings 面=循环加固警告（P2.4-hardening）+降级留痕。 */
export type SubjectSegmentWarning = SegmentLoopWarning | SegmentToolDegradedWarning;

export interface SubjectSegmentOutcome {
  /** object-tree.json 工件 blobRef（strategy.design 的树上下文真源）。 */
  treeArtifactRef: string;
  /** object-tree-preview.png 工件 blobRef（叠加预览——人看轨）。 */
  previewRef: string;
  warnings: SubjectSegmentWarning[];
  /** 降级标记（在场=颜色结构分块产物，非语义抠图）。 */
  degraded?: 'fallback-color';
  /** 承载面（bridge=循环 / fallback=降级分块）。 */
  channel: 'bridge' | 'fallback';
  iterations: number;
  totalNodes: number;
  /** 节点摘要（DFS 序=工件序——agent 叙事面；cap SEGMENT_TOOL_NODE_SUMMARY_CAP）。 */
  nodes: Array<{
    id: string;
    objectName: string;
    category: string;
    effectiveMm: number;
    drillWorthy: boolean;
    children: number;
  }>;
  meta: { durationMs: number; model?: string };
}

// ---------------------------------------------------------------- env 装配面（kernel 消费）

/**
 * 确定性合成 mock 传输（SAM_BRIDGE_MOCK=1 缺省 mock 桥——旅程/冒烟/演示面）：
 * - analyze → unimplemented（macmini 同款降级信号——scene.analyze 显式降通道 B）；
 * - segment 几何带 box → box 内切椭圆掩码（score 0.85）；points-only → include 点
 *   周边圆盘；
 * - segment 文本 → 提示文本哈希派生的中央椭圆（score 0.75）——与父掩码交集=中心
 *   区域，模拟「细分出主体核心」的模型行为；全部确定性（同提示同掩码）。
 * 零外呼零进程——纯本地计算；生产语义归 SshSamTransport。
 */
export function createSyntheticMockSamTransport(): SamTransport {
  const ellipseMask = (
    w: number,
    h: number,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
  ): { kind: 'inline'; w: number; h: number; encoding: 'base64-01'; data: string } => {
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / Math.max(rx, 0.5);
        const dy = (y - cy) / Math.max(ry, 0.5);
        if (dx * dx + dy * dy <= 1) bits[y * w + x] = 1;
      }
    }
    return {
      kind: 'inline',
      w,
      h,
      encoding: 'base64-01',
      data: Buffer.from(bits).toString('base64'),
    };
  };
  return {
    async send(call) {
      const request = call.request;
      const { width, height } = request.imagePx;
      const meta = { model: 'sam3-mock@synthetic', durationMs: 1, iteration: request.iteration };
      if (request.kind === 'analyze') {
        throw new SamBridgeError(
          'SAM_BRIDGE_MOCK 合成桥不支持 analyze（unimplemented）——scene.analyze 走 LLM 路由',
          'unimplemented',
        );
      }
      if (request.prompt.kind === 'geometric') {
        const box = request.prompt.box;
        if (box !== undefined) {
          return {
            kind: 'segment',
            mask: ellipseMask(
              width,
              height,
              box.x + box.w / 2,
              box.y + box.h / 2,
              (box.w - 2) / 2,
              (box.h - 2) / 2,
            ),
            score: 0.85,
            meta,
          };
        }
        const first = request.prompt.points.find((point) => point.label === 'include') ?? request.prompt.points[0]!;
        const radius = Math.max(2, Math.min(width, height) * 0.05);
        return {
          kind: 'segment',
          mask: ellipseMask(width, height, first.x, first.y, radius, radius),
          score: 0.6,
          meta,
        };
      }
      const digest = createHash('sha256').update(request.prompt.text, 'utf8').digest();
      const spread = 0.3 + (digest[0]! / 255) * 0.3; // 30%-60% 半径幅（确定性）
      const radius = (Math.min(width, height) / 2) * spread;
      // 组合提示（text+box）优先：椭圆锚定 box 中心（demo 走查实证——无锚定的全图
      // 中央落点对顶/角落节点零交集→segmentOne 零检出）。纯 text（无 box）回画布
      // 中央（原行为——整循环/测试既有依赖）。
      const box = request.prompt.box;
      const cx = box?.x !== undefined ? box.x + box.w / 2 : width / 2;
      const cy = box?.y !== undefined ? box.y + box.h / 2 : height / 2;
      return {
        kind: 'segment',
        mask: ellipseMask(width, height, cx, cy, radius, radius),
        score: 0.75,
        meta,
      };
    },
  };
}

/**
 * kernel 装配面（kernel/index.ts 唯一消费者）：env → SAM 传输。
 * 优先级：SAM_BRIDGE_MOCK=1（合成 mock）→ SAM_SSH_HOST+SAM_SSH_REMOTE_COMMAND
 * 成对（真 SshSamTransport——惰性 ssh 会话，首请求才 spawn+握手）→ undefined
 * （无桥=工具降级面 P2.5 fallbackSegment+warning）。单配置源 env（model-route
 * 纪律同款——key/拓扑不入库）。
 */
export function resolveKernelSamTransport(env: NodeJS.ProcessEnv = process.env): SamTransport | undefined {
  if (env[SAM_BRIDGE_MOCK_ENV] === '1') return createSyntheticMockSamTransport();
  const host = env[SAM_SSH_HOST_ENV]?.trim() ?? '';
  const remoteCommand = env[SAM_SSH_REMOTE_COMMAND_ENV]?.trim() ?? '';
  if (host.length > 0 && remoteCommand.length > 0) {
    const timeoutRaw = env[SAM_SSH_REQUEST_TIMEOUT_SEC_ENV]?.trim() ?? '';
    const timeoutSec = Number(timeoutRaw);
    return new SshSamTransport({
      host,
      remoteCommand,
      ...(Number.isFinite(timeoutSec) && timeoutSec >= 1 ? { requestTimeoutSec: Math.min(600, timeoutSec) } : {}),
    });
  }
  return undefined;
}

/** 传输优雅收口（kernel stop 面——SshSamTransport finish 幂等；其余实现无操作）。 */
export async function finishSamTransport(transport: SamTransport | undefined): Promise<void> {
  if (transport instanceof SshSamTransport) await transport.finish();
}

// ---------------------------------------------------------------- Lab 色方差测量

/**
 * 原图 Lab 色方差测量器（RMS ΔE76——fallback-segment statsOf / sam-live-smoke
 * makeLabMeasurer 同口径；逐像素 Lab 键缓存）。循环判据 2 的输入面。
 */
export function labVarianceMeasurer(image: {
  width: number;
  rgba: Uint8Array;
}): (region: { bbox: { x: number; y: number; w: number; h: number }; bits: Uint8Array }) => number {
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
  return (region) => {
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

// ---------------------------------------------------------------- 执行器本体

/** S2 元素解析结果（工件读回或直接注入——锚点校验后）。 */
interface ResolvedElements {
  elements: SceneElement[];
  model?: string;
}

export interface SubjectSegmentDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（artifact 帧登记——studio.ts 先例；缺席=不登记帧，仅落工件）。 */
  jobs?: Pick<JobService, 'emitFor'>;
  /** SAM 桥（kernel 共享实例注入——P2.2 队列/超时/留存/sam-logs 全量生效）。 */
  bridge?: Pick<SamBridge, 'run'>;
}

/** 工具执行器（无后台任务——每请求经桥有界，零常驻定时器/连接）。 */
export class SubjectSegmentExecutor {
  constructor(private readonly deps: SubjectSegmentDeps) {}

  /** 单次调用全链（typed reject 或 resolve——失败面不吞）。 */
  async run(rawInput: unknown): Promise<SubjectSegmentOutcome> {
    const parsed = SubjectSegmentToolInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new SubjectSegmentError(
        `subject.segment 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const input = parsed.data;
    const startedAt = Date.now();

    // —— 原图存在性+解码+锚点（两承载面共用）
    const imageBytes = this.deps.blobs.read(input.imageBlobRef);
    if (imageBytes === null) {
      throw new SubjectSegmentError(
        `原图 blob 不存在（blobRef=${input.imageBlobRef.slice(0, 12)}…）`,
        'image-missing',
      );
    }
    let decoded: { width: number; height: number; rgba: Uint8Array };
    try {
      decoded = decodePng(imageBytes);
    } catch (error) {
      throw new SubjectSegmentError(
        `原图解码失败（仅支持 PNG——S0 归一面）：${error instanceof Error ? error.message : String(error)}`,
        'image-decode-failed',
        { cause: error },
      );
    }
    if (decoded.width !== input.imagePx.width || decoded.height !== input.imagePx.height) {
      throw new SubjectSegmentError(
        `imagePx 与原图尺寸不符（${input.imagePx.width}×${input.imagePx.height} ≠ 实际 ${decoded.width}×${decoded.height}）——bbox 锚点错位，拒绝抠图`,
        'image-decode-failed',
      );
    }

    // —— S2 元素解析（工件读回 or 直接注入）
    const resolved = this.resolveElements(input);

    const bridge = this.deps.bridge;
    if (bridge === undefined) {
      return this.runFallback(input, imageBytes, resolved, startedAt);
    }
    return this.runLoop(input, decoded, resolved, bridge, startedAt);
  }

  /** S2 元素真源解析：sceneAnalysisRef 工件读回（锚点一致性强校验）或 elements 直注。 */
  private resolveElements(input: SubjectSegmentInput): ResolvedElements {
    if (input.elements !== undefined) {
      return { elements: input.elements };
    }
    const ref = input.sceneAnalysisRef!;
    const bytes = this.deps.blobs.read(ref);
    if (bytes === null) {
      throw new SubjectSegmentError(
        `scene-analysis 工件不存在（blobRef=${ref.slice(0, 12)}…——先经 scene.analyze 产出）`,
        'analysis-missing',
      );
    }
    let analysis: z.infer<typeof SceneAnalysisSchema>;
    try {
      analysis = SceneAnalysisSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      throw new SubjectSegmentError(
        `scene-analysis 工件不符契约：${error instanceof Error ? error.message : String(error)}`,
        'analysis-invalid',
        { cause: error },
      );
    }
    if (
      analysis.imageBlobRef !== input.imageBlobRef
      || analysis.imagePx.width !== input.imagePx.width
      || analysis.imagePx.height !== input.imagePx.height
      || analysis.canvasCm.w !== input.canvasCm.w
      || analysis.canvasCm.h !== input.canvasCm.h
    ) {
      throw new SubjectSegmentError(
        `scene-analysis 工件锚点与入参不符（工件 imageBlobRef=${analysis.imageBlobRef.slice(0, 12)}…/${analysis.imagePx.width}×${analysis.imagePx.height}/${analysis.canvasCm.w}×${analysis.canvasCm.h}cm ≠ 入参 ${input.imageBlobRef.slice(0, 12)}…/${input.imagePx.width}×${input.imagePx.height}/${input.canvasCm.w}×${input.canvasCm.h}cm）——boxPx 坐标系漂移必拒`,
        'anchor-mismatch',
      );
    }
    return { elements: analysis.elements };
  }

  /** 桥承载面：装配循环依赖 → runSegmentLoop → persistTreeWithPreview → artifact 帧。 */
  private async runLoop(
    input: SubjectSegmentInput,
    decoded: { width: number; height: number; rgba: Uint8Array },
    resolved: ResolvedElements,
    bridge: Pick<SamBridge, 'run'>,
    startedAt: number,
  ): Promise<SubjectSegmentOutcome> {
    const measure = labVarianceMeasurer(decoded);
    let model: string | undefined;
    const result = await runSegmentLoop(
      {
        taskId: input.taskId,
        imageBlobRef: input.imageBlobRef,
        imagePx: input.imagePx,
        canvasCm: input.canvasCm,
        elements: resolved.elements,
        maxGemDiameterMm: input.maxGemDiameterMm ?? SEGMENT_TOOL_DEFAULT_MAX_GEM_MM,
        ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
        vlmReentry: input.vlmReentry ?? false,
      },
      {
        segment: async (request) => {
          const run = await bridge.run(request);
          if (run.kind !== 'segment') {
            throw new SamBridgeError(
              `桥响应 kind 不匹配（期望 segment，实为 ${run.kind}——vlmReentry analyze 投影不产掩码）`,
              'invalid-response',
            );
          }
          model = run.meta.model;
          const bits = resolveMaskBits(this.deps.blobs, run.mask);
          return { mask: { w: bits.w, h: bits.h, bits: bits.bits }, ...(run.score !== undefined ? { score: run.score } : {}) };
        },
        ...(input.vlmReentry === true
          ? {
              analyze: async (request: SamAnalyzeRequest) => {
                const run = await bridge.run(request);
                if (run.kind !== 'analyze') {
                  throw new SamBridgeError(`桥响应 kind 不匹配（期望 analyze，实为 ${run.kind}）`, 'invalid-response');
                }
                return { elements: run.elements };
              },
            }
          : {}),
        measureLabVariance: measure,
      },
    ).catch((error: unknown) => {
      if (error instanceof SubjectSegmentError) throw error;
      const kindText =
        error instanceof Error && 'kind' in error && typeof (error as { kind: unknown }).kind === 'string'
          ? `${(error as { kind: string }).kind}：`
          : '';
      throw new SubjectSegmentError(
        `迭代抠图循环失败：${kindText}${error instanceof Error ? error.message : String(error)}`,
        'loop-failed',
        { cause: error },
      );
    });
    const bundle = this.persist(input.taskId, input.imageBlobRef, result.tree);
    const outcome = this.assembleOutcome({
      bundle,
      warnings: result.warnings,
      channel: 'bridge',
      iterations: result.iterations,
      startedAt,
      model,
    });
    this.emitArtifacts(input.taskId, bundle);
    return outcome;
  }

  /** 降级承载面（桥未装配——P2.5 颜色结构分块；显式 warning 留痕）。 */
  private runFallback(
    input: SubjectSegmentInput,
    imageBytes: Uint8Array,
    resolved: ResolvedElements,
    startedAt: number,
  ): SubjectSegmentOutcome {
    void resolved; // 降级面不消费 S2 元素（颜色聚类与语义清单正交——显式留痕）
    const fallback = fallbackSegment(imageBytes, { canvasCm: input.canvasCm });
    if (!fallback.ok) {
      const detail = 'message' in fallback ? fallback.message : JSON.stringify(fallback);
      throw new SubjectSegmentError(
        `桥未装配降级颜色分块失败（${detail}）——配置 SAM_SSH_HOST/SAM_SSH_REMOTE_COMMAND 或 SAM_BRIDGE_MOCK=1 后重试语义抠图`,
        'fallback-failed',
      );
    }
    const bundle = this.persist(input.taskId, input.imageBlobRef, fallback.tree);
    const warning: SegmentToolDegradedWarning = {
      reason: 'bridge-unavailable',
      degraded: 'fallback-color',
      detail:
        'SAM 桥未装配（env SAM_SSH_HOST+SAM_SSH_REMOTE_COMMAND 或 SAM_BRIDGE_MOCK=1）——降级 P2.5 颜色结构分块（一键模式语义，非语义抠图）；S2 元素清单未参与',
    };
    const outcome = this.assembleOutcome({
      bundle,
      warnings: [warning],
      channel: 'fallback',
      iterations: 1,
      startedAt,
      degraded: 'fallback-color',
    });
    this.emitArtifacts(input.taskId, bundle);
    return outcome;
  }

  /** 双轨工件落档（fence 收敛——cancelled/cleared 任务产物写入=typed 拒）。 */
  private persist(taskId: string, imageBlobRef: string, tree: ObjectTree): TreeArtifactBundle {
    try {
      return persistTreeWithPreview({ db: this.deps.db, blobs: this.deps.blobs }, taskId, imageBlobRef, tree);
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new SubjectSegmentError(
          `object-tree 工件写入被 fence 拒绝（任务 ${taskId} 已不可写）：${error.message}`,
          'fence',
          { cause: error },
        );
      }
      throw new SubjectSegmentError(
        `object-tree 工件落档失败：${error instanceof Error ? error.message : String(error)}`,
        'internal',
        { cause: error },
      );
    }
  }

  /** artifact 帧登记（P3.2-channel 合法引用集=帧流 artifact 帧——studio.ts 先例）。 */
  private emitArtifacts(taskId: string, bundle: TreeArtifactBundle): void {
    this.deps.jobs?.emitFor(taskId, 'artifact', { blobRef: bundle.treeBlobRef, name: 'object-tree.json' });
    this.deps.jobs?.emitFor(taskId, 'artifact', { blobRef: bundle.previewBlobRef, name: 'object-tree-preview.png' });
  }

  private assembleOutcome(input: {
    bundle: TreeArtifactBundle;
    warnings: SubjectSegmentWarning[];
    channel: 'bridge' | 'fallback';
    iterations: number;
    startedAt: number;
    degraded?: 'fallback-color';
    model?: string;
  }): SubjectSegmentOutcome {
    return {
      treeArtifactRef: input.bundle.treeBlobRef,
      previewRef: input.bundle.previewBlobRef,
      warnings: input.warnings,
      ...(input.degraded !== undefined ? { degraded: input.degraded } : {}),
      channel: input.channel,
      iterations: input.iterations,
      totalNodes: input.bundle.persisted.nodes.length,
      nodes: input.bundle.persisted.nodes.slice(0, SEGMENT_TOOL_NODE_SUMMARY_CAP).map((node) => ({
        id: node.id,
        objectName: node.objectName,
        category: node.category,
        effectiveMm: node.effectiveMm,
        drillWorthy: node.drillWorthy,
        children: node.children.length,
      })),
      meta: {
        durationMs: Date.now() - input.startedAt,
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------- 工具面注册

export interface SubjectSegmentCapabilitiesDeps extends SubjectSegmentDeps {
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

/**
 * subject.segment 能力集（kernel 工具面注册——readonly 直调；MCP 投影
 * mcp__studio__subject_segment 过 tool-surface deny 名单）。熔断/任务行校验照
 * capability/studio.ts + vision/scene-analyze.ts 先例。
 */
export function createSubjectSegmentCapabilities(
  deps: SubjectSegmentCapabilitiesDeps,
): CapabilityRegistry {
  const executor = new SubjectSegmentExecutor({
    db: deps.db,
    blobs: deps.blobs,
    ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}),
    ...(deps.bridge !== undefined ? { bridge: deps.bridge } : {}),
  });
  const streaks = new Map<string, { key: string; count: number }>();

  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return {
        kind: 'failed',
        code: 'INVALID_OPERATION',
        message: `熔断：${reason}。请停止重试，向用户报告失败原因。`,
      };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  /** 任务行校验（scene-analyze requireAgentTask 同款——MCP 面身份经 taskId 贯穿）。 */
  function requireAgentTask(taskId: string): void {
    const task = deps.db
      .prepare('SELECT id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
  }

  const definitions = [
    {
      name: SUBJECT_SEGMENT_TOOL_NAME,
      description:
        '迭代语义抠图（管线 S3-S5）：S2 元素清单（sceneAnalysisRef 工件或 elements 注入）'
        + '驱动 SAM 桥迭代循环（首轮=元素几何提示、后续轮=宽泛语义细分、停止判据内嵌、'
        + '兄弟互斥/碎片清理加固）→ ObjectTree 工件+叠加预览 PNG（object-tree.json/'
        + 'object-tree-preview.png——strategy.design 的树上下文真源）。只读直调；桥未装配时'
        + '降级颜色结构分块并显式 warning。出参 {treeArtifactRef, previewRef, warnings, nodes[]}。',
      authority: 'readonly' as const,
      input: SubjectSegmentToolInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SubjectSegmentToolInputSchema.safeParse(input);
        const bucket =
          typeof (input as { taskId?: unknown } | null | undefined)?.taskId === 'string' &&
          ((input as { taskId?: unknown }).taskId as string).length > 0
            ? ((input as { taskId: string }).taskId)
            : 'global';
        if (!parsed.success) {
          return noteFailure(
            bucket,
            SUBJECT_SEGMENT_TOOL_NAME,
            `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        try {
          requireAgentTask(parsed.data.taskId);
          const outcome = await executor.run(parsed.data);
          noteSuccess(bucket);
          return { kind: 'ok', value: outcome };
        } catch (error) {
          const detail =
            error instanceof SubjectSegmentError
              ? `${error.kind}：${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          return noteFailure(bucket, SUBJECT_SEGMENT_TOOL_NAME, detail);
        }
      },
    },
  ];

  return createCapabilityRegistry(definitions);
}
