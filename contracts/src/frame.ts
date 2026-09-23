/**
 * WS 事件帧模型（design §3.5 冻结——W3 mock 与 W4 实现共用的唯一真源）。
 * 原始需求 2026-09-23：统一帧 {seq, ts, kind, payload} + afterSeq 游标重放；
 * kind 按 task 两族分值域（job 与 agent 共用传输不共用状态机）。
 * 正交意图：
 *   [1] Frame 帧结构（jsonl 落盘 / WS 推送 / 回放三处共用的线格式；seq 每 task
 *       独立从 1 单调——design §3.5「回放游标以 task 为域」）。
 *   [2] kind 两族值域：job{progress|log|artifact|done|error}、
 *       agent{transcript|approval-request|approval-resolved|done|error}
 *       ——交集恰为 {done, error}（终态帧两族同形）。
 *   [3] approval 载荷逐字面冻结：approval-request 含 requestId/tool/proposalId/
 *       preview/summary/expiresAt；approval-resolved 仅 {requestId, approved,
 *       resolvedAt}——grant/nonce 不出现在任何帧载荷（design §3.6 服务端内部关联，
 *       payload 一律 strict 拒绝多余键，注入 grantId/nonce 直接 parse 失败）。
 */
import { z } from 'zod';
import { BlobRefSchema, IdSchema, IsoDateTimeSchema } from './common.js';

/** job 族 kind 值域（生成/引擎作业帧）。 */
export const JOB_FRAME_KINDS = ['progress', 'log', 'artifact', 'done', 'error'] as const;
/** agent 族 kind 值域（会话帧——增 transcript 与审批双帧）。 */
export const AGENT_FRAME_KINDS = [
  'transcript',
  'approval-request',
  'approval-resolved',
  'done',
  'error',
] as const;

/** 两族并集（Frame.kind 的完整值域；两族交集恰为 {done, error}——由测试守卫）。 */
export const FrameKindSchema = z.enum([
  'progress',
  'log',
  'artifact',
  'transcript',
  'approval-request',
  'approval-resolved',
  'done',
  'error',
]);
export type FrameKind = z.infer<typeof FrameKindSchema>;

// ---------------------------------------------------------------- 载荷（strict——冻结面）

export const ProgressPayloadSchema = z
  .object({
    /** 进度描述（人类可读） */
    text: z.string().optional(),
    /** 完成比例 0..1（不可知时缺省） */
    ratio: z.number().min(0).max(1).optional(),
  })
  .strict();
export type ProgressPayload = z.infer<typeof ProgressPayloadSchema>;

export const LogPayloadSchema = z.object({ text: z.string() }).strict();
export type LogPayload = z.infer<typeof LogPayloadSchema>;

export const ArtifactPayloadSchema = z
  .object({
    /** 产物实体（内容寻址 blob） */
    blobRef: BlobRefSchema.optional(),
    /** 产物名（如 layout.svg） */
    name: z.string().min(1).optional(),
  })
  .strict();
export type ArtifactPayload = z.infer<typeof ArtifactPayloadSchema>;

export const TranscriptPayloadSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'tool']),
    text: z.string(),
  })
  .strict();
export type TranscriptPayload = z.infer<typeof TranscriptPayloadSchema>;

/** 审批预览（前后对照——两帧各自的内容寻址 blob）。 */
export const ApprovalPreviewSchema = z
  .object({
    before: BlobRefSchema,
    after: BlobRefSchema,
  })
  .strict();
export type ApprovalPreview = z.infer<typeof ApprovalPreviewSchema>;

/** approval-request 载荷（design §3.5 逐字面）。 */
export const ApprovalRequestPayloadSchema = z
  .object({
    requestId: IdSchema,
    /** 待批准的 approved-mutation 工具名（patch-apply/generate/export） */
    tool: z.string().min(1),
    proposalId: IdSchema,
    preview: ApprovalPreviewSchema,
    summary: z.string(),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;

/**
 * approval-resolved 载荷（design §3.5 逐字面）——只有 {requestId, approved,
 * resolvedAt}；grantId/nonce 等授权凭据不属于任何帧/API 载荷（§3.6），
 * strict 模式下注入即 parse 失败。
 */
export const ApprovalResolvedPayloadSchema = z
  .object({
    requestId: IdSchema,
    approved: z.boolean(),
    resolvedAt: IsoDateTimeSchema,
  })
  .strict();
export type ApprovalResolvedPayload = z.infer<typeof ApprovalResolvedPayloadSchema>;

export const DonePayloadSchema = z.object({}).strict();
export type DonePayload = z.infer<typeof DonePayloadSchema>;

export const ErrorPayloadSchema = z.object({ message: z.string() }).strict();
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

// ---------------------------------------------------------------- Frame 判别联合

const frameBase = {
  /** 任务内单调递增序号（从 1 起；afterSeq 游标重放依据——每 task 独立） */
  seq: z.number().int().positive(),
  /** epoch 毫秒 */
  ts: z.number().int().nonnegative(),
};

/** 统一事件帧（判别联合：kind 决定 payload 形状）。 */
export const FrameSchema = z.discriminatedUnion('kind', [
  z.object({ ...frameBase, kind: z.literal('progress'), payload: ProgressPayloadSchema }),
  z.object({ ...frameBase, kind: z.literal('log'), payload: LogPayloadSchema }),
  z.object({ ...frameBase, kind: z.literal('artifact'), payload: ArtifactPayloadSchema }),
  z.object({ ...frameBase, kind: z.literal('transcript'), payload: TranscriptPayloadSchema }),
  z.object({ ...frameBase, kind: z.literal('approval-request'), payload: ApprovalRequestPayloadSchema }),
  z.object({ ...frameBase, kind: z.literal('approval-resolved'), payload: ApprovalResolvedPayloadSchema }),
  z.object({ ...frameBase, kind: z.literal('done'), payload: DonePayloadSchema }),
  z.object({ ...frameBase, kind: z.literal('error'), payload: ErrorPayloadSchema }),
]);
export type Frame = z.infer<typeof FrameSchema>;

/** afterSeq 回放语义（纯函数——W3 mock 与 W4 服务端共用同一冻结语义）。 */
export function replayWindow<F extends { seq: number }>(frames: F[], afterSeq: number): F[] {
  return frames.filter((frame) => frame.seq > afterSeq);
}
