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
 *
 * 真链走查 P1-1（2026-10-01，会话 1187ce52 小丑图）——SAM 段循环超时孤儿三修：
 *   [a] 取消传播：runSegmentLoop options.signal 步边界检查 + 桥请求 signal 透传
 *       （排队移出/执行丢弃）+ 任务终态逐桥边界探测（turn 1800s 兜底杀/stopTask/
 *       熔断落 tasks.status 终态 → 循环 ≤1 桥请求界内自取消，typed loop-cancelled）。
 *   [b] 孤儿驱逐：同任务同图新调用进入时 abort 旧循环（上层 MCP 超时后 daemon 侧
 *       不感知的孤儿不再占满桥并发 1 队列——走查实证后续 8/8 queue-full 拒）。
 *   [c] 界匹配：MCP_TOOL_CALL_TIMEOUT_MS 缺省 600s→1200s（boot.ts——高于段循环
 *       P99 4-14min，工具层不再先死留孤儿）。
 *
 * add-segment-checkpoint-resume（2026-10-02，Owner 挂账 291 段超窗根治）：断点账本
 * +回放适配器+时间切片+进度帧——全部装配在本工具层适配器，segment-loop.ts 纯状态
 * 机零改动：
 *   [1] 断点账本（segment-ledger.ts）：fp=循环内容指纹键控 DATA_ROOT/segment-ledgers/
 *       <fp16>.jsonl；segment/analyze 双适配器先按 reqHash（投影剔 taskId——跨任务
 *       命中）查账本，命中=零桥调用回放（掩码从桥 materialize 已落 blob 读回），
 *       未命中=真桥调用后追记账本行（append 后内存 Map 即时命中——同文请求去重）。
 *   [2] 时间切片：SEGMENT_TOOL_SLICE_MS（缺省 10min，<20min MCP 窗 2× 余量）——
 *       适配器实跑桥调用前预算检查，到点抛 SegmentBudgetExhaustedError → callBridge
 *       包成 bridge-failure(cause) → 本层 .catch 通用 wrap 之前拆链识别 → **正常返回**
 *       status:'checkpointed'（不进熔断计数；零进展护栏：本片零实跑永不切片）。
 *   [3] 进度帧：实跑段逐段 emitFor(taskId,'progress')（机器验证的进展——掩码落
 *       blob+账本追记后才发）；回放阶段收束为每片一帧汇总（防 O(n²) 洪泛）。
 *   [4] 时钟注入：deps.now 透传 runSegmentLoop（树 createdAt 确定性——续跑片间树
 *       blob 逐字节一致的测试前提）。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LlmConfig } from '../../config.js';
import {
  CanvasCmSchema,
  ImagePxSchema,
  SceneAnalysisSchema,
  SceneElementSchema,
  SegmentPrecisionSchema,
  labFromRgb,
  type AgentImagePreview,
  type Lab,
  type ObjectNode,
  type ObjectTree,
  type SceneElement,
  type SegmentPrecision,
} from '@handicraft/contracts';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import type { JobService } from '../../jobs/service.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { decodePng } from '../../png/codec.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityRegistry,
} from '../../capability/core.js';
import { RUNAWAY_LIMIT } from '../../capability/studio.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import { envTimeoutMs } from '../timeout-env.js';
import {
  SamBridge,
  SamBridgeError,
  SshSamTransport,
  applySegmentPrecision,
  tuneSegmentRequest,
  type SamAnalyzeRequest,
  type SamRequestTuner,
  type SamSegmentRequest,
  type SamTransport,
} from './sam-bridge.js';
import type { MaskQualityThresholds } from './mask-quality.js';
import {
  applyIntakeResample,
  resolveIntakeResampleConfig,
  type IntakeResampleApplied,
  type IntakeResampleConfig,
  type IntakeResampleFact,
} from './intake-resample.js';
import {
  materializeNodeMaskPreviews,
  renderOverlayPreviewThumbnail,
  segmentAgentPreviewEnabled,
  segmentAgentPreviewMaxSide,
  SEGMENT_AGENT_MASK_PREVIEW_NODE_CAP,
} from './agent-preview.js';
import {
  runSegmentLoop,
  SegmentLoopError,
  type SegmentLoopResult,
  type SegmentLoopWarning,
} from './segment-loop.js';
import {
  SegmentLedger,
  segmentLedgerFingerprint,
  segmentRequestHash,
} from './segment-ledger.js';
import { createSubjectTranslator, type SubjectTranslator } from './subject-translator.js';
import { latestReferenceImageBlobRef } from './reference-image.js';
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

/** env mock 桥开关（=1 → 本地确定性合成掩码 mock）。**test-only 通道**（realize-
 * scene-understanding T4 mock 退役纪律）：仅供测试/旅程冒烟/效果演示——非生产语义、
 * 不作真链验收依据（真链=SshSamTransport 真 SAM3；验收数据=真链产物）。 */
export const SAM_BRIDGE_MOCK_ENV = 'SAM_BRIDGE_MOCK';

/**
 * 判据 1 钻径基准缺省（mm）：调用方未声明 maxGemDiameterMm 时的保守缺省（常规小钻
 * 上限一档；与 strategies FALLBACK_GEM_DIAMETER_MM 同值——两处语义不同源，不互相
 * import：循环判据缺省 vs 执行径推断基准）。
 */
export const SEGMENT_TOOL_DEFAULT_MAX_GEM_MM = 3;

/** 输出面节点摘要上限（树 schema 硬顶 256——工具结果帧有界，防 256 行结果爆帧）。 */
export const SEGMENT_TOOL_NODE_SUMMARY_CAP = 64;

// ---------------------------------------------------------------- 时间切片 env（T2）

/** 切片预算 env 键（add-segment-checkpoint-resume——ms 单位）。 */
export const SEGMENT_TOOL_SLICE_MS_ENV = 'SEGMENT_TOOL_SLICE_MS';

/**
 * 切片预算缺省（ms）：10min——20min MCP 工具窗留 2× 余量（design §4：检查仅在
 * 实跑桥调用前，在途请求不中断；agent 链式再调直至 status=done，进度单调不减）。
 */
export const SEGMENT_TOOL_SLICE_MS_DEFAULT = 600_000;

/** env 覆盖读取（envTimeoutMs 严格解析——≥1000 的有限数才采用，非数字/越界回缺省）。 */
export function segmentToolSliceMs(): number {
  return envTimeoutMs(SEGMENT_TOOL_SLICE_MS_ENV, SEGMENT_TOOL_SLICE_MS_DEFAULT);
}

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
    precision: SegmentPrecisionSchema.optional().describe(
      '精度覆写（add-vision-pipeline-v2 D3——「参考+默认」语义：不传=用图像处理配置缺省；'
        + '看图发现掩膜质量差（泄漏/空膜/收缩）且时间允许时可提高精度（升 maskMaxSide）重试；'
        + '不同精度=不同账本键（reqHash），不会串到旧精度的断点）',
    ),
    instances: z
      .enum(['best', 'all'])
      .optional()
      .describe(
        '实例枚举（add-sam-playbook D1）：缺省 best=每请求单最佳实例（旧行为零变化）；'
          + "all=同款多实例逐个成层（桥 topK 扇出——「六颗星星逐颗成层」；单次 ≤24 实例超限截断明示；"
          + '实例模式入账本键（reqHash），best/all 断点互不串）',
      ),
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
  /**
   * 循环被取消（真链走查 P1-1——2026-10-01）：新调用驱逐旧循环/任务终态/上层
   * 取消三源汇入的 AbortSignal 在步边界或桥边界收口。孤儿循环不再占桥队列。
   */
  | 'loop-cancelled'
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

/**
 * 切片预算耗尽（add-segment-checkpoint-resume T2——executor 模块私有）：适配器在
 * 实跑桥调用前抛出 → segment-loop callBridge 包成 SegmentLoopError('bridge-failure',
 * {cause}) → runLoop 收口在通用 wrap **之前**拆 cause 链识别 → 组装 checkpointed
 * 正常返回。刻意不走 abort/cancelled 面（与驱逐/终态取消语义纠缠——两层包装均传
 * cause，拆链可行，R1-P1-3 咽喉设计）。
 */
class SegmentBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentBudgetExhaustedError';
  }
}

// ---------------------------------------------------------------- 结果面

/** 降级 warning（桥未装配→P2.5 颜色结构分块——显式留痕，不静默）。 */
export interface SegmentToolDegradedWarning {
  reason: 'bridge-unavailable';
  degraded: 'fallback-color';
  detail: string;
}

/**
 * 断点账本旧条目回放自愈留痕（add-vision-pipeline-v2 T1.3——D2 结果侧升采样的账本
 * 取舍面）：桥边界掩码归一化（commit 80f973e）之前落的 segment 账本行 maskBlobRef
 * 内容=**低分辨率掩码**（当时 macmini maskMaxSide 缩掩码直落库）——回放读回时维度
 * ≠请求 imagePx 被 resolveMaskBits 拒（RangeError），条目摘除后该段真桥实跑一次
 * （多跑可观测，不阻塞循环；reqHash 只含请求侧参数，掩膜字节变化不影响命中键）。
 * 新条目恒=原分辨率（桥 materialize 归一化后落 blob），正常回放不触发本 warning。
 */
export interface SegmentLedgerStaleWarning {
  reason: 'ledger-stale-mask';
  detail: string;
}

/**
 * 任务级参考图层不可用留痕（add-flat-aux-segmentation D4/T4.1——分件输入软失败面）：
 * 帧在场但 blob 缺失/解码失败/与工作锚点网格不符（陈旧参考图层——画布重声明后的
 * 旧帧）→ 回退 agent 传入原图（缺席语义零变化），typed warning 可观测不阻塞。
 */
export interface SegmentReferenceUnusableWarning {
  reason: 'reference-image-unusable';
  detail: string;
}

/** 输出 warnings 面=循环加固警告（P2.4-hardening）+降级留痕+账本旧条目自愈留痕。 */
export type SubjectSegmentWarning =
  | SegmentLoopWarning
  | SegmentToolDegradedWarning
  | SegmentLedgerStaleWarning
  | SegmentReferenceUnusableWarning;

export interface SubjectSegmentDoneOutcome {
  status: 'done';
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
  /**
   * 工作画布推导事实（2026-10-04 Bug A 修复——applied=true 时 imageBlobRef/imagePx
   * 即树锚点，后续 scene/segment/strategy 工具与再入参一律以本面为准；applied=false
   * =入参原值透传）。
   */
  intakeResample: IntakeResampleFact;
  /**
   * 分件输入图事实（add-flat-aux-segmentation D4/T4.1——服务端单源接线）：
   * source='reference'=任务级参考图层帧在场，送桥输入/树锚/账本分账键=该 blobRef；
   * source='source'=原图（agent 传入锚——帧缺席/参考图层不可用回退，行为零变化）。
   */
  segmentImage: { source: 'reference' | 'source'; blobRef: string };
  meta: { durationMs: number; model?: string };
  /** 本片回放命中段数（add-segment-checkpoint-resume 审计面——续跑片非零）。 */
  replayedSegments: number;
  /**
   * agent 多模态预览（add-vision-pipeline-v2 D5——掩膜预览回流）：树叠加总览缩略图
   * （每 done 结果一张）+质量门命中节点的掩膜特写（病态时逐节点，cap 4）。成本开关
   * SEGMENT_AGENT_MASK_PREVIEW（缺省开）；MCP 投影按约定字段提升为 image content
   * （daemon/src/capability/mcp.ts——LLM 真看图），文本面剥离 dataBase64 防 token 双计。
   */
  agentImagePreviews?: AgentImagePreview[];
}

/**
 * 切片断点收口（T2——正常结果非错误）：预算到点时已银行进度经账本持久，同参重调
 * 从断点续跑。message 显式指令 agent 链式续调（最坏=用户「继续」，账本仍生效）。
 */
export interface SubjectSegmentCheckpointedOutcome {
  status: 'checkpointed';
  /** 断点账本指纹（DATA_ROOT/segment-ledgers/<fp>.jsonl）。 */
  ledgerFp: string;
  /** 账本已银行 segment 段数（跨片累计——单调不减）。 */
  bankedSegments: number;
  /** 本片回放命中段数。 */
  replayedSegments: number;
  /** 本片实跑段数。 */
  liveSegments: number;
  /** 续跑指令（同参重调直至 done）。 */
  message: string;
}

/** 工具结果面（判别联合——agent 叙事面，无结构化消费方；studio 泛渲染）。 */
export type SubjectSegmentOutcome = SubjectSegmentDoneOutcome | SubjectSegmentCheckpointedOutcome;

// ---------------------------------------------------------------- env 装配面（kernel 消费）

/**
 * 确定性合成 mock 传输（SAM_BRIDGE_MOCK=1 缺省 mock 桥）。**test-only 通道**
 * （realize-scene-understanding T4 mock 退役纪律）：测试/旅程/演示面专用——
 * 非生产语义、不作真链验收依据：
 * - analyze → unimplemented（macmini 同款降级信号——scene.analyze 显式降通道 B）；
 * - segment 几何带 box → box 内切椭圆掩码（score 0.85）；points-only → include 点
 *   周边圆盘；
 * - segment 文本 → 提示文本哈希派生的中央椭圆（score 0.75）——与父掩码交集=中心
 *   区域，模拟「细分出主体核心」的模型行为；全部确定性（同提示同掩码）。
 * segmentRequests 录制送达的 segment 请求（add-image-processing-settings §5.2——
 * 每请求调谐 confThreshold/maskMaxSide 的透传断言面）。
 * 零外呼零进程——纯本地计算；生产语义归 SshSamTransport。
 */
export function createSyntheticMockSamTransport(): SamTransport & {
  segmentRequests: SamSegmentRequest[];
} {
  const segmentRequests: SamSegmentRequest[] = [];
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
    segmentRequests,
    async send(call) {
      const request = call.request;
      if (request.kind === 'segment') segmentRequests.push(request);
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
      // text 提示（add-sam-playbook D2/D3 契约面同步）：纯 box（无 text）=框内切椭圆
      //（几何语义同款——玩法③）；topK>1（玩法① instances='all'）=确定性 3 实例扇出
      //（detections 逐实例回传）。excludeBox 不在 mock 面（daemon 桥 materialize 统一
      // 像素减法——D2 纠偏，传输层永不见该字段）。
      const promptBox = request.prompt.box;
      if (request.prompt.text === undefined) {
        if (promptBox === undefined) {
          throw new SamBridgeError('text 提示缺 text 且缺 box——schema superRefine 不可达', 'invalid-response');
        }
        return {
          kind: 'segment',
          mask: ellipseMask(width, height, promptBox.x + promptBox.w / 2, promptBox.y + promptBox.h / 2, (promptBox.w - 2) / 2, (promptBox.h - 2) / 2),
          score: 0.85,
          meta,
        };
      }
      const digest = createHash('sha256').update(request.prompt.text, 'utf8').digest();
      const spread = 0.3 + (digest[0]! / 255) * 0.3; // 30%-60% 半径幅（确定性）
      const radius = (Math.min(width, height) / 2) * spread;
      // 组合提示（text+box）优先：椭圆锚定 box 中心（demo 走查实证——无锚定的全图
      // 中央落点对顶/角落节点零交集→segmentOne 零检出）。纯 text（无 box）回画布
      // 中央（原行为——整循环/测试既有依赖）。
      const cx = promptBox?.x !== undefined ? promptBox.x + promptBox.w / 2 : width / 2;
      const cy = promptBox?.y !== undefined ? promptBox.y + promptBox.h / 2 : height / 2;
      if (request.topK !== undefined && request.topK > 1) {
        // instances='all' 确定性扇出：锚点周边 3 实例（左/右/下偏移——score 降序）
        const offsets: Array<[number, number, number]> = [
          [-radius * 0.9, 0, 0.85],
          [radius * 0.9, 0, 0.8],
          [0, radius * 0.9, 0.75],
        ];
        const detections = offsets.map(([dx, dy, score]) => ({
          mask: ellipseMask(width, height, cx + dx, cy + dy, radius * 0.45, radius * 0.45),
          score,
        }));
        return {
          kind: 'segment',
          mask: detections[0]!.mask,
          score: detections[0]!.score,
          count: detections.length,
          detections,
          meta,
        };
      }
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
  /**
   * DATA_ROOT（add-segment-checkpoint-resume——断点账本目录 segment-ledgers/ 的根）。
   * 缺席=账本/切片停用（保持改前行为；生产装配恒在场——kernel/index.ts 注入）。
   */
  dataRoot?: string;
  /**
   * 帧提交单点（artifact/progress 帧登记+**参考图层帧流读回**——T4.1 分件输入接线
   * 消费 framesAfter 解析任务级 reference-image.png；缺席=不登记帧且分件输入回退
   * agent 传入原图，studio.ts 先例同款可选面）。
   */
  jobs?: Pick<JobService, 'emitFor' | 'framesAfter'>;
  /** SAM 桥（kernel 共享实例注入——P2.2 队列/超时/留存/sam-logs 全量生效）。 */
  bridge?: Pick<SamBridge, 'run'>;
  /**
   * SAM 每请求调谐（add-image-processing-settings §5.2——kernel 装配注入
   * imageProcessingEffective(db) 投影）：每个桥 segment 请求解析一次，改设置对
   * 下一次请求立即生效（循环内多请求各自取新值）。
   */
  samRequestTuner?: SamRequestTuner;
  /**
   * LLM 配置（SAM 英文优先提示——Owner 定调 2026-10-03：subject 无英文 hint 时
   * objectName 经 LLM 路由英译成英文语义短语再送 SAM；resolveLlmRoute 单源消费，
   * 与 scene.analyze 通道 B 同真源）。缺席=翻译面停用（循环回中文提示旧行为）。
   */
  llm?: LlmConfig;
  /**
   * 时钟注入（add-segment-checkpoint-resume T5——R1-P0-2）：透传 runSegmentLoop
   * deps.now（finalize 树 createdAt 用——确定性测试注入固定值使「树 blob 逐字节
   * 一致」可断言）+账本行 ts。缺省真时钟。
   */
  now?: () => string;
  /** 切片预算直注覆盖（ms；缺省 SEGMENT_TOOL_SLICE_MS env——测试压片注入面）。 */
  sliceMs?: number;
  /**
   * 掩膜质量门阈值（add-vision-pipeline-v2 D5——config 注入+缺省
   * MASK_QUALITY_DEFAULTS）：透传 runSegmentLoop options.maskQuality。
   */
  maskQuality?: MaskQualityThresholds;
  /**
   * 工作画布推导配置直注（2026-10-04 Bug A 修复——优先；测试注入定值；在场时
   * provider 不被调用）。
   */
  intakeConfig?: IntakeResampleConfig;
  /**
   * 工作画布推导配置 provider（调用时解析面——与 scene.analyze intakeConfigProvider
   * 同装配同语义）：每次 run() 取值一次，改设置对下一次调用立即生效。解析顺序=
   * 直注 intakeConfig → provider → env（resolveIntakeResampleConfig 缺省面）。
   */
  intakeConfigProvider?: () => IntakeResampleConfig;
}

/** 工具执行器（无后台任务——每请求经桥有界，零常驻定时器/连接）。 */
export class SubjectSegmentExecutor {
  /**
   * 同任务同图在跑循环注册面（真链走查 P1-1 孤儿检测——2026-10-01）：键=
   * taskId+NUL+imageBlobRef。新调用进来时旧循环若仍在（上层 MCP 超时后 daemon 侧
   * 不感知的孤儿，占满 SAM 桥并发 1 队列致后续 8/8 queue-full 拒）→ abort 驱逐。
   * 循环 settle（完成/失败/取消）即从注册面摘除。
   */
  private readonly inflightLoops = new Map<string, AbortController>();

  /**
   * 主体名英译面（SAM 英文优先提示——Owner 定调 2026-10-03）：llm 配置在场才装配。
   * 实例级（executor 生命周期=daemon 进程生命周期）——subject-translator 的 Map
   * 缓存随实例存活，跨调用/跨切片续跑共享（同 objectName 同译文——账本 reqHash
   * 稳定的进程侧保证，取舍见 subject-translator.ts 头注）。
   */
  private readonly subjectTranslator: SubjectTranslator | undefined;
  /** 工作画布推导配置直注（优先——在场时 provider/env 均不参与）。 */
  private readonly intakeConfig: IntakeResampleConfig | undefined;
  /** 调用时解析面（每次 run 取值，不缓存——改设置立即生效）。 */
  private readonly intakeConfigProvider: (() => IntakeResampleConfig) | undefined;

  constructor(private readonly deps: SubjectSegmentDeps) {
    this.subjectTranslator =
      deps.llm !== undefined ? createSubjectTranslator({ db: deps.db, llm: deps.llm }) : undefined;
    this.intakeConfig = deps.intakeConfig;
    this.intakeConfigProvider = deps.intakeConfigProvider;
  }

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
        `原图解码失败（管线仅支持 PNG——会话附件入线已归一；非 PNG ref=绕过入线直传，请转 PNG 后经消息附件入线）：${error instanceof Error ? error.message : String(error)}`,
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

    // —— 工作画布确定性推导（2026-10-04 Bug A 修复——与 scene.analyze 入线单源）：
    //    imagePx 恒=canvasCm×有效 ppcm（上传格式/路径无关）。此前仅在 scene.analyze
    //    接线，agent 直传原始 blob（elements 注入跳过 S2）时原始尺寸即成树锚点——
    //    同名义画布双路径分叉（500px vs 1280px 实证）。确定性推导使两入线口各自
    //    调用亦得同一 blobRef（同图同配置同产物）——锚点天然互洽。
    const intake = this.applyIntake(input, decoded, imageBytes);

    // —— T4.1 分件输入接线（add-flat-aux-segmentation D4）：任务级参考图层帧在场时
    //    送桥输入图恒=reference-image.png（缺席=agent 传入原图，行为零变化）。锚语义：
    //    参考图层与 intake 工作锚点同网格（D2 生成面恒对齐原图网格落盘）；树锚=分件
    //    输入图（persistTreeWithPreview 单源）——分件产物的树锚与分件输入图同源一致
    //    （树编辑面 T3 树锚单源自动跟随）。参考图层不可用（blob 缺失/坏图/网格不符）
    //    =typed warning+回退原图（软失败，S2 主链不受参考图层通道拖挂的同款纪律）。
    const referenceResult = this.resolveSegmentReferenceImage(intake.effective);
    const reference = referenceResult !== null && referenceResult.ok ? referenceResult : null;
    const preWarnings: SubjectSegmentWarning[] =
      referenceResult !== null && !referenceResult.ok ? [referenceResult.warning] : [];
    if (reference !== null) {
      this.deps.jobs?.emitFor(input.taskId, 'progress', {
        text: `分件输入=参考图层（blobRef=${reference.blobRef.slice(0, 12)}…——服务端任务级单源解析；树锚=本图，色彩细节排钻仍取原图）`,
      });
    }

    // —— S2 元素解析（工件读回 or 直接注入；锚点校验对**推导后**有效输入——
    //    agent 传原始 ref 时与 scene.analyze 的 intake 产物收敛到同一 blobRef；
    //    agent 显式传参考图层 blob（scene.analyze 结果指引面）亦合法——参考图层
    //    与分析锚同网格，锚校验容忍 referenceBlobRef）
    const resolved = this.resolveElements(intake.effective, reference?.blobRef);
    const effective: SubjectSegmentInput =
      reference === null
        ? intake.effective
        : { ...intake.effective, imageBlobRef: reference.blobRef };
    const effectiveBytes = reference === null ? intake.imageBytes : reference.bytes;
    const effectiveDecoded = reference === null ? intake.decoded : reference.decoded;
    const segmentImage: { source: 'reference' | 'source'; blobRef: string } = {
      source: reference === null ? 'source' : 'reference',
      blobRef: effective.imageBlobRef,
    };

    const bridge = this.deps.bridge;
    if (bridge === undefined) {
      return this.runFallback(effective, effectiveBytes, resolved, startedAt, intake.intake, preWarnings, segmentImage);
    }
    return this.runLoop(
      effective,
      effectiveDecoded,
      resolved,
      bridge,
      startedAt,
      intake.intake,
      preWarnings,
      segmentImage,
    );
  }

  /**
   * 任务级参考图层解析（T4.1 单源——latestReferenceImageBlobRef 帧流读回）：
   * - null=无帧/无帧流面（缺席=原图语义，行为零变化）；
   * - {ok:true}=帧在场且可用（blob 在场+PNG 可解码+与有效入参 imagePx 同网格——
   *   D2 生成面保证同网格；agent 直传参考图层 blob 时=恒等态，无交换）；
   * - {ok:false}=帧在场但不可用（blob 缺失/坏图/网格不符=陈旧帧，如画布重声明后的
   *   旧参考图层）——typed warning 携回 outcome，软失败回退原图绝不阻塞分件。
   */
  private resolveSegmentReferenceImage(
    effective: SubjectSegmentInput,
  ):
    | { ok: true; blobRef: string; bytes: Uint8Array; decoded: { width: number; height: number; rgba: Uint8Array } }
    | { ok: false; warning: SegmentReferenceUnusableWarning }
    | null {
    const jobs = this.deps.jobs;
    if (jobs === undefined) return null;
    const ref = latestReferenceImageBlobRef(jobs, effective.taskId);
    if (ref === null) return null;
    const fail = (warning: SegmentReferenceUnusableWarning): { ok: false; warning: SegmentReferenceUnusableWarning } => {
      this.deps.jobs?.emitFor(effective.taskId, 'progress', {
        text: `[参考图层] reference-image-unusable：${warning.detail}——分件输入回退原图（软失败不阻塞）`,
      });
      return { ok: false, warning };
    };
    const bytes = this.deps.blobs.read(ref);
    if (bytes === null) {
      return fail({
        reason: 'reference-image-unusable',
        detail: `参考图层 blob 不可读（blobRef=${ref.slice(0, 12)}…——帧在场但字节缺席，会话清理竞态？）`,
      });
    }
    let decoded: { width: number; height: number; rgba: Uint8Array };
    try {
      decoded = decodePng(bytes);
    } catch (error) {
      return fail({
        reason: 'reference-image-unusable',
        detail: `参考图层解码失败（仅支持 PNG——${error instanceof Error ? error.message : String(error)}）`,
      });
    }
    if (decoded.width !== effective.imagePx.width || decoded.height !== effective.imagePx.height) {
      return fail({
        reason: 'reference-image-unusable',
        detail:
          `参考图层网格 ${decoded.width}×${decoded.height} ≠ 工作锚点 ${effective.imagePx.width}×${effective.imagePx.height}`
          + '（陈旧参考图层帧——画布重声明/换图后的旧帧）',
      });
    }
    return { ok: true, blobRef: ref, bytes, decoded };
  }

  /**
   * 工作画布推导（applyIntakeResample 单源消费——fence 收敛为本面 typed error）。
   * 解析顺序：直注 intakeConfig → provider（调用时解析，改设置立即生效）→ env 缺省。
   */
  private applyIntake(
    input: SubjectSegmentInput,
    decoded: { width: number; height: number; rgba: Uint8Array },
    imageBytes: Uint8Array,
  ): IntakeResampleApplied<SubjectSegmentInput> {
    const intakeConfig =
      this.intakeConfig ?? this.intakeConfigProvider?.() ?? resolveIntakeResampleConfig();
    try {
      return applyIntakeResample(
        {
          db: this.deps.db,
          blobs: this.deps.blobs,
          ...(this.deps.jobs !== undefined ? { jobs: this.deps.jobs } : {}),
        },
        input,
        decoded,
        imageBytes,
        intakeConfig,
      );
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new SubjectSegmentError(
          `工作画布推导图写入被 fence 拒绝（任务 ${input.taskId} 已不可写）：${error.message}`,
          'fence',
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * S2 元素真源解析：sceneAnalysisRef 工件读回（锚点一致性强校验）或 elements 直注。
   * T4.1 容忍面：agent 显式传任务级参考图层 blob（scene.analyze 结果 referenceImage
   * 指引）时 imageBlobRef ≠ 分析锚属合法——参考图层与分析锚同网格（D2 落盘对齐），
   * imagePx/canvasCm 校验保持严格；referenceBlobRef=本调用解析出的任务参考图层。
   */
  private resolveElements(input: SubjectSegmentInput, referenceBlobRef?: string): ResolvedElements {
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
    const imageAnchorOk =
      analysis.imageBlobRef === input.imageBlobRef
      || (referenceBlobRef !== undefined && input.imageBlobRef === referenceBlobRef);
    if (
      !imageAnchorOk
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
    intake: IntakeResampleFact,
    preWarnings: SubjectSegmentWarning[],
    segmentImage: { source: 'reference' | 'source'; blobRef: string },
  ): Promise<SubjectSegmentOutcome> {
    // —— 孤儿驱逐（真链走查 P1-1）：同任务同图旧循环仍在跑（上层 MCP 超时/取消不
    //    传播到 daemon 侧的孤儿——持续占桥并发 1 队列）→ abort 旧控制器。桥在途
    //    请求由信号传播立即丢弃（迟到响应按 id 丢），队列槽位即刻释放。
    const loopKey = `${input.taskId}\u0000${input.imageBlobRef}`;
    const previous = this.inflightLoops.get(loopKey);
    if (previous !== undefined) {
      this.inflightLoops.delete(loopKey);
      previous.abort(
        new SegmentLoopError('同任务同图的新 subject.segment 调用进入——旧循环作为孤儿驱逐', 'cancelled'),
      );
    }
    const controller = new AbortController();
    this.inflightLoops.set(loopKey, controller);
    // 任务行终态探测（P1-1 取消传播：MCP 面无请求生命周期信号可接——turn 兜底杀
    // （FOLLOWUP_TIMEOUT_MS/stopTask/熔断）落 tasks.status 终态，循环在下一桥边界
    // 观测并自取消；孤儿寿命 ≤ 单桥请求界（SAM_REQUEST_TIMEOUT_MS））。
    const taskTerminal = (): string | null => {
      const row = this.deps.db
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(input.taskId) as { status: string } | undefined;
      if (row === undefined) return '任务行缺失';
      return row.status === 'running' || row.status === 'queued' ? null : `任务终态 ${row.status}`;
    };
    const cancelledError = (why: string): SegmentLoopError =>
      new SegmentLoopError(`迭代抠图循环已取消（${why}）`, 'cancelled');
    const throwIfCancelled = (): void => {
      if (controller.signal.aborted) throw cancelledError('信号已中止（驱逐/终态）');
      const terminal = taskTerminal();
      if (terminal !== null) {
        controller.abort(cancelledError(terminal));
        throw cancelledError(terminal);
      }
    };

    const measure = labVarianceMeasurer(decoded);
    let model: string | undefined;

    // —— 断点账本（add-segment-checkpoint-resume T1）：fp=循环内容指纹（resolveElements
    //    产物入哈希——同分解输入归同一账本；跨任务命中由 reqHash 投影剔 taskId 保证）。
    //    每次调用重载文件（坏行/死 blobRef 行 load 期跳过；291 段量级=58KB 文本+逐行
    //    指针查询，无性能面）。dataRoot 缺席=账本停用（改前行为）。
    //    T4.1 账本分账实跑：参考图层在场=referenceImage 入指纹键（D3 T3 预留的本批
    //    接线——不同参考图层落不同账本域不串账；缺席=undefined 吸收零漂移）。
    const ledgerHashOptions =
      segmentImage.source === 'reference' ? { referenceImage: input.imageBlobRef } : {};
    const ledger =
      this.deps.dataRoot !== undefined
        ? SegmentLedger.load(
            {
              dataRoot: this.deps.dataRoot,
              blobs: this.deps.blobs,
              ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
            },
            segmentLedgerFingerprint({
              imageBlobRef: input.imageBlobRef,
              imagePx: input.imagePx,
              canvasCm: input.canvasCm,
              elements: resolved.elements,
              ...ledgerHashOptions,
            }),
            input.taskId,
          )
        : undefined;

    // —— 时间切片（T2）：deadline 仅在实跑桥调用前检查（回放免费；在途不中断）；
    //    liveCalls===0 永不切片（零进展护栏——每片至少银行 **1 次桥调用**（segment 或
    //    analyze——vlmReentry 片可只银行 analyze 行、liveSegments 横盘），杜绝
    //    「checkpointed→重调→又 0 段」agent 空转；sliceMs=0+护栏=每片恰 1 次实跑）。
    const sliceMs = this.deps.sliceMs ?? segmentToolSliceMs();
    const deadline = Date.now() + sliceMs;
    let liveSegments = 0; // 本片实跑 segment 数
    let replayedSegments = 0; // 本片回放 segment 数（done 审计面）
    let liveCalls = 0; // 本片实跑桥调用总数（segment+analyze——护栏计数）
    let frontierCount = 0; // 待细分 frontier 快照（onStep 观察面——progress text 用）
    let replaySummaryPending = false; // 回放收束汇总帧未发（每片至多一帧——防 O(n²) 洪泛）
    // 断点账本旧条目自愈留痕收集面（add-vision-pipeline-v2 T1.3——drop 时逐条
    // progress 帧+done warnings 双轨；异常路径稀少（仅归一化前旧账本/竞态释放），不洪泛）。
    const staleLedgerDrops: Array<{ reqHash: string; detail: string }> = [];
    const nowIso = (): string => this.deps.now?.() ?? new Date().toISOString();
    const emitProgress = (text: string): void => {
      this.deps.jobs?.emitFor(input.taskId, 'progress', { text });
    };
    if (intake.applied) {
      // 工作画布推导发生了重采样——进度帧明示新锚点（agent/用户可见的坐标系变迁）。
      emitProgress(
        `工作画布推导 · ${intake.fromImagePx?.width ?? '?'}×${intake.fromImagePx?.height ?? '?'}`
          + ` → ${intake.imagePx.width}×${intake.imagePx.height} px（${intake.reason}）`
          + `——树锚点=intake 图，后续工具一律用本次结果携带的锚点`,
      );
    }
    const budgetGuard = (): void => {
      if (ledger === undefined) return; // 无账本=无断点可续——切片语义停用
      if (liveCalls > 0 && Date.now() >= deadline) {
        throw new SegmentBudgetExhaustedError(
          `切片预算到点（${sliceMs}ms——已银行 ${ledger.segmentCount} 段，本片实跑 ${liveSegments}）`,
        );
      }
    };
    /** 回放阶段收束帧：首帧实跑前发一次（本片回放 r 段——回放不逐段发帧）。 */
    const flushReplaySummary = (): void => {
      if (!replaySummaryPending) return;
      replaySummaryPending = false;
      emitProgress(`语义抠图 · 回放 ${replayedSegments} 段完成（断点账本命中），继续实跑`);
    };

    try {
      let result: SegmentLoopResult;
      try {
        result = await runSegmentLoop(
          {
            taskId: input.taskId,
            imageBlobRef: input.imageBlobRef,
            imagePx: input.imagePx,
            canvasCm: input.canvasCm,
            elements: resolved.elements,
            maxGemDiameterMm: input.maxGemDiameterMm ?? SEGMENT_TOOL_DEFAULT_MAX_GEM_MM,
            ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
            vlmReentry: input.vlmReentry ?? false,
            // 实例枚举（add-sam-playbook D1——循环消费面：'all'=逐请求 topK 扇出逐实例子层）
            instances: input.instances ?? 'best',
            // 掩膜质量门阈值（D5——deps 注入+缺省；typed warning 不丢结果不阻断）
            ...(this.deps.maskQuality !== undefined ? { maskQuality: this.deps.maskQuality } : {}),
            signal: controller.signal,
            onStep: (meta) => {
              frontierCount = meta.frontierAfter; // 纯观察——progress text 的待细分计数
            },
          },
          {
            segment: async (request) => {
              throwIfCancelled(); // 步内逐桥请求边界——回放也尊重驱逐/终态（T1.3）
              const allInstances = input.instances === 'all';
              // 每请求调谐（add-image-processing-settings §5.2——循环内逐请求解析，改设置
              // 对下一请求生效；请求显式值优先，tuner 缺省字段=不发=服务端缺省）+
              // 精度覆写（add-vision-pipeline-v2 D3——显式 precision 压配置参考值；
              // 落进请求 ⇒ reqHash 含精度，不同精度不串账）。
              const tuned = applySegmentPrecision(
                tuneSegmentRequest(request, this.deps.samRequestTuner),
                input.precision,
              );
              // —— 断点账本回放（T1.2）：命中=零桥调用，掩码从桥 materialize 已落 blob
              //    读回（恒=请求 imagePx 同维——ensureCanvasMask 校验自然通过）。
              //    all 面（add-sam-playbook D1）：行 instances 逐实例回放；行缺明细
              //    （best 单膜行）=死条目摘除自愈。reqHash 携 referenceImage 分账键
              //    （T4.1——参考图层在场时同图不同参考图层的请求不互相回放）。
              const reqHash = segmentRequestHash(tuned, ledgerHashOptions);
              const hit = ledger?.get(reqHash);
              if (hit !== undefined && hit.kind === 'segment') {
                try {
                  if (allInstances && hit.instances === undefined) {
                    throw new Error('账本条目缺逐实例明细（best 单膜行）——all 扇出不可回放');
                  }
                  const bits = resolveMaskBits(this.deps.blobs, {
                    kind: 'blob',
                    w: input.imagePx.width,
                    h: input.imagePx.height,
                    blobRef: hit.maskBlobRef,
                  });
                  const replayInstances = allInstances
                    ? hit.instances!.map((instance) => ({
                        mask: (() => {
                          const detBits = resolveMaskBits(this.deps.blobs, {
                            kind: 'blob',
                            w: input.imagePx.width,
                            h: input.imagePx.height,
                            blobRef: instance.maskBlobRef,
                          });
                          return { w: detBits.w, h: detBits.h, bits: detBits.bits };
                        })(),
                        ...(instance.score !== undefined ? { score: instance.score } : {}),
                      }))
                    : undefined;
                  replayedSegments++;
                  replaySummaryPending = true;
                  return {
                    mask: { w: bits.w, h: bits.h, bits: bits.bits },
                    ...(hit.score !== undefined ? { score: hit.score } : {}),
                    ...(replayInstances !== undefined ? { instances: replayInstances } : {}),
                  };
                } catch (error) {
                  // blob 中途释放（会话清理竞态）或旧版低分辨率条目（桥边界归一化
                  // 80f973e 之前落库——维度≠imagePx 被 resolveMaskBits RangeError 拒）
                  // ——死/旧条目摘除走真桥自愈（T1.3：回放 miss 多一次实跑，留痕可观测）
                  ledger?.drop(reqHash);
                  const detail = error instanceof Error ? error.message : String(error);
                  staleLedgerDrops.push({ reqHash, detail });
                  emitProgress(`语义抠图 · 断点账本条目作废重跑（${detail.slice(0, 160)}）`);
                }
              }
              budgetGuard(); // 实跑桥调用前预算检查（R1-P1-3——到点抛 SegmentBudgetExhausted）
              flushReplaySummary();
              // P1-1 取消传播：信号随请求入桥（排队即移出/执行即丢弃结果）。
              const run = await bridge
                .run(tuned, {
                  signal: controller.signal,
                })
                .catch((error: unknown) => {
                  if (error instanceof SamBridgeError && (error.kind === 'cancelled' || error.kind === 'fence')) {
                    // 桥取消（排队移出/执行丢弃）与 fence 拒（任务 cancelled/会话清理
                    // ——上游已走，等价取消）→ 循环面统一 typed cancelled
                    throw cancelledError(`桥请求${error.kind === 'fence' ? '被 fence 拒（上游已走）' : '取消'}：${error.message}`);
                  }
                  throw error;
                });
              throwIfCancelled(); // 响应后复查（终态/驱逐可能在等待期落位——不再发下一请求）
              if (run.kind !== 'segment') {
                throw new SamBridgeError(
                  `桥响应 kind 不匹配（期望 segment，实为 ${run.kind}——vlmReentry analyze 投影不产掩码）`,
                  'invalid-response',
                );
              }
              model = run.meta.model;
              // —— 追记账本行（T1：maskBlobRef=桥 materialize 已落 blob——内容寻址
              //    复用零额外写；append 后内存 Map 即时更新=同文请求去重留痕 R1-P2-6）。
              //    all 面（D1）附逐实例明细——扇出回放依据。
              if (run.mask.kind === 'blob') {
                ledger?.append({
                  v: 1,
                  kind: 'segment',
                  reqHash,
                  maskBlobRef: run.mask.blobRef,
                  ...(run.score !== undefined ? { score: run.score } : {}),
                  model: run.meta.model,
                  ts: nowIso(),
                  ...(allInstances && run.detections !== undefined
                    ? {
                        instances: run.detections.map((detection) => ({
                          maskBlobRef: detection.mask.blobRef,
                          ...(detection.score !== undefined ? { score: detection.score } : {}),
                        })),
                      }
                    : {}),
                });
              }
              liveSegments++;
              liveCalls++;
              const bits = resolveMaskBits(this.deps.blobs, run.mask);
              const liveInstances = allInstances && run.detections !== undefined
                ? run.detections.map((detection) => {
                    const detBits = resolveMaskBits(this.deps.blobs, detection.mask);
                    return {
                      mask: { w: detBits.w, h: detBits.h, bits: detBits.bits },
                      ...(detection.score !== undefined ? { score: detection.score } : {}),
                    };
                  })
                : undefined;
              // 实跑段逐段一帧（T3.1——progress=机器验证的进展：掩码已落 blob+账本已追记后才发）。
              emitProgress(
                `语义抠图 · 累计 ${ledger?.segmentCount ?? liveSegments} 段（本片回放 ${replayedSegments} + 实跑 ${liveSegments}）· 待细分 ${frontierCount}`,
              );
              return {
                mask: { w: bits.w, h: bits.h, bits: bits.bits },
                ...(run.score !== undefined ? { score: run.score } : {}),
                ...(liveInstances !== undefined ? { instances: liveInstances } : {}),
              };
            },
            ...(input.vlmReentry === true
              ? {
                  analyze: async (request: SamAnalyzeRequest) => {
                    throwIfCancelled();
                    // analyze 适配器同构（R1-P1-4：vlmReentry 分叉确定性——响应入账本，
                    // 回放恢复 hint 精化 → 后续请求序保持确定）。
                    const reqHash = segmentRequestHash(request, ledgerHashOptions);
                    const hit = ledger?.get(reqHash);
                    if (hit !== undefined && hit.kind === 'analyze') {
                      replaySummaryPending = true;
                      return { elements: hit.elements };
                    }
                    budgetGuard();
                    flushReplaySummary();
                    const run = await bridge.run(request, { signal: controller.signal });
                    throwIfCancelled();
                    if (run.kind !== 'analyze') {
                      throw new SamBridgeError(`桥响应 kind 不匹配（期望 analyze，实为 ${run.kind}）`, 'invalid-response');
                    }
                    ledger?.append({ v: 1, kind: 'analyze', reqHash, elements: run.elements, ts: nowIso() });
                    liveCalls++;
                    emitProgress(`语义抠图 · VLM 复入完成（hint 精化已入断点账本）`);
                    return { elements: run.elements };
                  },
                }
              : {}),
            measureLabVariance: measure,
            // SAM 英文优先（2026-10-03 定调）：无英文 hint 的主体名先英译再送桥
            //（装配缺席=翻译面停用，循环回中文提示旧行为——见 SubjectSegmentDeps.llm）。
            ...(this.subjectTranslator !== undefined
              ? { translateSubject: this.subjectTranslator }
              : {}),
            ...(this.deps.now !== undefined ? { now: this.deps.now } : {}), // T5 时钟注入——树 createdAt 确定性
          },
        );
      } catch (error) {
        // —— SliceBudgetExhausted 识别链（R1-P1-3，咽喉设计）：通用 wrap **之前**判
        //    SegmentLoopError(bridge-failure) && cause instanceof SegmentBudgetExhaustedError
        //    → checkpointed 正常返回（不走 abort 面；两层包装均传 cause，拆链可行）。
        if (
          error instanceof SegmentLoopError
          && error.kind === 'bridge-failure'
          && error.cause instanceof SegmentBudgetExhaustedError
        ) {
          const banked = ledger?.segmentCount ?? liveSegments;
          const outcome: SubjectSegmentCheckpointedOutcome = {
            status: 'checkpointed',
            ledgerFp: ledger?.fingerprint ?? '',
            bankedSegments: banked,
            replayedSegments,
            liveSegments,
            message:
              `切片预算到点，已银行 ${banked} 段（本片回放 ${replayedSegments} + 实跑 ${liveSegments}）。`
              + '请以与首次调用完全一致的入参再次调用本工具续跑（复用会话历史中的原 sceneAnalysisRef/elements 与 precision，勿重新 scene.analyze），直至 status=done。',
          };
          return outcome;
        }
        if (error instanceof SubjectSegmentError) throw error;
        if (error instanceof SegmentLoopError && error.kind === 'cancelled') {
          throw new SubjectSegmentError(error.message, 'loop-cancelled', { cause: error });
        }
        const kindText =
          error instanceof Error && 'kind' in error && typeof (error as { kind: unknown }).kind === 'string'
            ? `${(error as { kind: string }).kind}：`
            : '';
        throw new SubjectSegmentError(
          `迭代抠图循环失败：${kindText}${error instanceof Error ? error.message : String(error)}`,
          'loop-failed',
          { cause: error },
        );
      }
      const bundle = this.persist(input.taskId, input.imageBlobRef, result.tree);
      // T1.3 账本旧条目自愈 warning 并入（SegmentLedgerStaleWarning——drop 已逐条发
      // progress 帧，此处结构面留痕供 agent/前端消费；checkpointed 面无 warnings 字段，
      // 该路径靠 progress 帧可观测）。
      const staleWarnings: SegmentLedgerStaleWarning[] = staleLedgerDrops.map((drop) => ({
        reason: 'ledger-stale-mask' as const,
        detail: `断点账本回放条目作废（reqHash=${drop.reqHash.slice(0, 8)}…）：${drop.detail}——已摘除并实跑一次重建（add-vision-pipeline-v2 T1：旧版低分辨率掩码条目自愈，结果不受影响）`,
      }));
      const outcome = this.assembleOutcome({
        bundle,
        warnings: [...preWarnings, ...result.warnings, ...staleWarnings],
        channel: 'bridge',
        iterations: result.iterations,
        startedAt,
        model,
        replayedSegments,
        intakeResample: intake,
        segmentImage,
        agentImagePreviews: this.buildAgentPreviews(input.taskId, decoded, result, bundle),
      });
      this.emitArtifacts(input.taskId, bundle);
      return outcome;
    } finally {
      if (this.inflightLoops.get(loopKey) === controller) this.inflightLoops.delete(loopKey);
    }
  }

  /**
   * agent 多模态预览装配（add-vision-pipeline-v2 D5——掩膜预览回流；**预览失败绝不
   * 阻塞结果**：任何渲染/落 blob 异常吞掉降级为缺席/部分）：
   * [1] 树叠加总览缩略图（每 done 结果一张——proposal「细分产物预览以多模态结果面
   *     回 agent」；源=人看轨 object-tree-preview.png 降采样复刻）；
   * [2] 质量门命中节点掩膜特写（D5「病态 → warning 携带预览」；cap
   *     SEGMENT_AGENT_MASK_PREVIEW_NODE_CAP——病态多节点时截断防洪泛）。
   * 开关 SEGMENT_AGENT_MASK_PREVIEW（缺省开——成本敏感部署置 0 关闭）。
   */
  private buildAgentPreviews(
    taskId: string,
    decoded: { width: number; height: number; rgba: Uint8Array },
    result: SegmentLoopResult,
    bundle: TreeArtifactBundle,
  ): AgentImagePreview[] {
    if (!segmentAgentPreviewEnabled()) return [];
    const maxSide = segmentAgentPreviewMaxSide();
    const previews: AgentImagePreview[] = [];
    try {
      const overlayBytes = this.deps.blobs.read(bundle.previewBlobRef);
      if (overlayBytes !== null) {
        const thumb = renderOverlayPreviewThumbnail(decodePng(overlayBytes), maxSide);
        const blobRef = putTaskArtifact(
          { db: this.deps.db, blobs: this.deps.blobs },
          taskId,
          thumb,
        ).hash;
        previews.push({
          kind: 'tree-overlay',
          blobRef,
          mime: 'image/png',
          maxSide,
          dataBase64: Buffer.from(thumb).toString('base64'),
        });
      }
    } catch {
      // 总览失败=缺席（结果面不受影响）
    }
    try {
      const qualityReasons: ReadonlySet<string> = new Set([
        'mask-suspicious-fill',
        'mask-suspicious-aspect',
        'mask-parent-iou',
      ]);
      const flaggedByNode = new Map<string, string>(); // nodeId → reason（首命中）
      for (const warning of result.warnings) {
        if (qualityReasons.has(warning.reason) && !flaggedByNode.has(warning.nodeId)) {
          flaggedByNode.set(warning.nodeId, warning.reason);
        }
      }
      if (flaggedByNode.size > 0) {
        const canvas = new Uint8Array(decoded.width * decoded.height);
        const flagged = [...flaggedByNode.entries()].slice(0, SEGMENT_AGENT_MASK_PREVIEW_NODE_CAP);
        const requests: Array<Parameters<typeof materializeNodeMaskPreviews>[0]['flagged'][number]> = [];
        for (const [nodeId, reason] of flagged) {
          const node = bundle.persisted.nodes.find((n) => n.id === nodeId)
            ?? result.tree.nodes.find((n) => n.id === nodeId);
          if (node === undefined) continue; // 兄弟消解移出树的节点——特写缺席（warning 文本仍在）
          const { w, h, bits } = resolveMaskBits(this.deps.blobs, node.mask);
          canvas.fill(0);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              if (bits[y * w + x] === 1) {
                canvas[(node.bbox.y + y) * decoded.width + (node.bbox.x + x)] = 1;
              }
            }
          }
          requests.push({
            nodeId,
            objectName: node.objectName,
            reason: reason as Parameters<typeof materializeNodeMaskPreviews>[0]['flagged'][number]['reason'],
            bbox: node.bbox,
            bits: new Uint8Array(canvas),
          });
        }
        previews.push(
          ...materializeNodeMaskPreviews({
            db: this.deps.db,
            blobs: this.deps.blobs,
            taskId,
            image: decoded,
            flagged: requests,
            maxSide,
          }),
        );
      }
    } catch {
      // 特写失败=部分缺席（总览/文本 warning 仍在）
    }
    return previews;
  }

  /** 降级承载面（桥未装配——P2.5 颜色结构分块；显式 warning 留痕）。 */
  private runFallback(
    input: SubjectSegmentInput,
    imageBytes: Uint8Array,
    resolved: ResolvedElements,
    startedAt: number,
    intake: IntakeResampleFact,
    preWarnings: SubjectSegmentWarning[],
    segmentImage: { source: 'reference' | 'source'; blobRef: string },
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
      warnings: [...preWarnings, warning],
      channel: 'fallback',
      iterations: 1,
      startedAt,
      degraded: 'fallback-color',
      replayedSegments: 0, // 降级面不进账本/切片——无回放语义
      intakeResample: intake,
      segmentImage,
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
    /** 本片回放命中段数（add-segment-checkpoint-resume——降级面恒 0）。 */
    replayedSegments: number;
    /** agent 多模态预览（D5——桥承载面 done 结果；降级面缺席）。 */
    agentImagePreviews?: AgentImagePreview[];
    /** 工作画布推导事实（run 面单源产出——两承载面透传进结果）。 */
    intakeResample: IntakeResampleFact;
    /** 分件输入图事实（T4.1——reference=任务参考图层/source=原图）。 */
    segmentImage: { source: 'reference' | 'source'; blobRef: string };
  }): SubjectSegmentDoneOutcome {
    return {
      status: 'done',
      treeArtifactRef: input.bundle.treeBlobRef,
      previewRef: input.bundle.previewBlobRef,
      warnings: input.warnings,
      ...(input.degraded !== undefined ? { degraded: input.degraded } : {}),
      ...(input.agentImagePreviews !== undefined && input.agentImagePreviews.length > 0
        ? { agentImagePreviews: input.agentImagePreviews }
        : {}),
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
      intakeResample: input.intakeResample,
      segmentImage: input.segmentImage,
      meta: {
        durationMs: Date.now() - input.startedAt,
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
      replayedSegments: input.replayedSegments,
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
 * capability/studio.ts + vision/scene-analyze.ts 先例。checkpointed=正常 resolve
 * （kind:'ok'）→ noteSuccess 清连败计数（不进 RUNAWAY——T2.5）。
 */
export function createSubjectSegmentCapabilities(
  deps: SubjectSegmentCapabilitiesDeps,
): CapabilityRegistry {
  const executor = new SubjectSegmentExecutor({
    db: deps.db,
    blobs: deps.blobs,
    ...(deps.dataRoot !== undefined ? { dataRoot: deps.dataRoot } : {}),
    ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}),
    ...(deps.bridge !== undefined ? { bridge: deps.bridge } : {}),
    ...(deps.samRequestTuner !== undefined ? { samRequestTuner: deps.samRequestTuner } : {}),
    ...(deps.llm !== undefined ? { llm: deps.llm } : {}), // SAM 英文优先——主体名英译面装配
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sliceMs !== undefined ? { sliceMs: deps.sliceMs } : {}),
    ...(deps.maskQuality !== undefined ? { maskQuality: deps.maskQuality } : {}), // D5 质量门阈值
    ...(deps.intakeConfig !== undefined ? { intakeConfig: deps.intakeConfig } : {}),
    ...(deps.intakeConfigProvider !== undefined
      ? { intakeConfigProvider: deps.intakeConfigProvider }
      : {}), // 工作画布推导（Bug A——scene.analyze 同装配）
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
        + '降级颜色结构分块并显式 warning。出参 status=done：{treeArtifactRef, previewRef,'
        + ' warnings, nodes[], agentImagePreviews[]}。'
        + '**分件输入图（参考图层——服务端单源）**：任务存在参考图层（photographic 图'
        + '经 scene.analyze 自动生成）时，本工具**自动**以其为送桥输入图与树锚（出参'
        + ' segmentImage.source=reference）——入参 imageBlobRef 照常传工作锚点图或参考图层'
        + ' blob 均可（两者锚校验均通过）；无参考图层=原图（segmentImage.source=source，'
        + '行为不变）。无需为参考图层做任何参数调整。'
        + '**提示词策略（浓缩——分件遇阻先 kb_get 知识库「SAM 提示词策略」组**'
        + '（计数与实例枚举/背景反选/部位拆分/排除区与点微调/措辞规律/失败信号对照表），'
        + '本段为速查）：提示词=短名词短语最稳（单数光杆名词或名词+≤2 视觉属性，'
        + '如 "hat"/"golden hair"）；**禁数词**（「三个天使」类量化提示会触发实例合并——'
        + '同款多件逐个成层用 instances=all 后数掩膜，计数永远在掩膜层做）；**禁否定词**'
        + '（「不要背景」无效——排除区域走 excludeBox 排除区参数）；零检出→降 confThreshold'
        + '+泛称回退（cherub→angel→person）+变体轮询（同一提示词重发无意义，必换措辞）；'
        + '前景概念穷尽→背景反选思路（先分割 background 再剔除）+纯 box 框选兜底'
        + '（无指令框选，不赌语义命中）。**失败信号→动作对照**：mask-parent-iou'
        + '（掩膜盖满父层）/mask-suspicious-aspect（细长条带贯穿）=泄漏——可用 excludeBox '
        + '把泄漏区框住重试（框住的区域将从结果掩膜中扣除——确定性像素减法；excludeBox/'
        + 'box 正框是单步拆层面 layer.split 参数，本整循环工具的泄漏先换更具体英文措辞或'
        + '拆分提示）；mask-suspicious-fill（空膜/碎屑）=换措辞或放弃该部位并如实披露。'
        + '**instances（实例枚举）**：缺省 best=每请求单最佳实例（旧行为）；all=同款多实例'
        + '逐个成层（「六颗星星逐颗成层」——每实例独立掩膜/质量门/兄弟互斥，命名=提示语名'
        + '+空格序号），单次 ≤24 实例超限截断并 warning 明示。'
        + '**掩膜质量自检（重要）**：结果 warnings 携带掩膜质量门先验（mask-suspicious-fill '
        + '空膜/mask-suspicious-aspect 细长泄漏条带/mask-parent-iou 整片父泄漏）且 '
        + 'agentImagePreviews 附掩膜预览图——收到这类 warning 时请**先看预览图**再决策：'
        + '换更具体的英文措辞重试、用 tree.refine 拆分提示、泄漏区经 excludeBox 排除'
        + '（单步拆层面）、或在时间允许时调高 precision 重跑；不要对病态掩膜直接排钻。'
        + '**precision（精度参数）**：{maskMaxSide, confThreshold}——配置值只是参考默认；'
        + '若看图发现掩膜质量差（泄漏成条带/近乎空膜/细节收缩）且时间允许，可提高精度'
        + '（升 maskMaxSide，如 1024→1536）重试本工具；零检出/漏检可降 confThreshold；'
        + '不同精度=不同账本键（互不串账、断点独立）。断点续跑（关键纪律）：大图分解按'
        + '时间切片（SEGMENT_TOOL_SLICE_MS 缺省 10min）分批银行进度，预算到点返回 '
        + 'status=checkpointed（携带 banked/replayed/live 计数）——这不是失败，是正常'
        + '中间结果：**以与首次调用完全一致的入参再次调用本工具即从断点续跑**（必须复用'
        + '会话历史中的原 sceneAnalysisRef/elements 与 precision，勿重新 scene.analyze'
        + '——重新分析产新清单即新指纹、断点作废从零开始），链式续调直至 status=done；'
        + '进度单调不减，跨任务同图同清单同样命中续跑。'
        + '**iter-1 三规则**：precision 必须实际落在入参（降 confThreshold/升 maskMaxSide'
        + ' 只在文案里宣称无效——叙事≠参数生效，以 wire 回执为准）；lint unintroduced='
        + 'warning 非阻断继续流程（导出只进 warnings——unresolvable/mask/spacing 才是硬阻断'
        + '停止待确认）；autoApprove 会话里 proposal 类工具返回 autoApproved=true+「立即'
        + '执行」指令时立即执行（勿等待用户）。',
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
