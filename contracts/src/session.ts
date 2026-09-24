/**
 * Agent 会话契约（design §3.5 逐字面冻结——W3 mock 与 W4 实现共用的唯一真源）。
 * 原始需求 2026-09-23（R1 冻结开发序：contracts → W3 mock → W4 同契约实现）。
 * 正交意图：
 *   [1] 十个端点 IO schema：session.create/list/get/followup/answer/cancel/
 *       clear/retry/replay/result + task.result。
 *   [2] 确定性语义纯函数：session.result 选择（最新完成 completedAt，平局 taskId
 *       大者）与 task 域回放游标（replayWindow 见 frame.ts）——mock 与服务端同源。
 *   [3] attempts 账本 schema（§3.6 R5/R6：attemptId 持久唯一主键、父 proposalId、
 *       attemptNo、idemKey、retryRequestId、state；唯一约束以常量声明供 DDL 对齐）。
 */
import { z } from 'zod';
import {
  BlobRefSchema,
  IdSchema,
  IsoDateTimeSchema,
  SessionStatusSchema,
  TaskStatusSchema,
} from './common.js';
import { FrameSchema, replayWindow } from './frame.js';

// ---------------------------------------------------------------- session.create

export const SessionCreateInputSchema = z.object({ title: z.string().min(1).optional() }).strict();
export const SessionCreateOutputSchema = z
  .object({ sessionId: IdSchema, createdAt: IsoDateTimeSchema })
  .strict();
export type SessionCreateInput = z.infer<typeof SessionCreateInputSchema>;
export type SessionCreateOutput = z.infer<typeof SessionCreateOutputSchema>;

// ---------------------------------------------------------------- session.list

export const SessionListInputSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();
export const SessionSummarySchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    status: SessionStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionListOutputSchema = z
  .object({ sessions: z.array(SessionSummarySchema), nextCursor: z.string().optional() })
  .strict();
export type SessionListInput = z.infer<typeof SessionListInputSchema>;
export type SessionListOutput = z.infer<typeof SessionListOutputSchema>;

// ---------------------------------------------------------------- session.get

export const SessionTaskSummarySchema = z
  .object({
    taskId: IdSchema,
    status: TaskStatusSchema,
    /** 该 task 已持久化的最大帧序（无帧=0） */
    lastSeq: z.number().int().nonnegative(),
    frameCount: z.number().int().nonnegative(),
  })
  .strict();
export type SessionTaskSummary = z.infer<typeof SessionTaskSummarySchema>;
export const SessionGetInputSchema = z.object({ sessionId: IdSchema }).strict();
export const SessionGetOutputSchema = z
  .object({
    session: SessionSummarySchema,
    tasks: z.array(SessionTaskSummarySchema),
  })
  .strict();
export type SessionGetInput = z.infer<typeof SessionGetInputSchema>;
export type SessionGetOutput = z.infer<typeof SessionGetOutputSchema>;

// ---------------------------------------------------------------- session.followup

export const SessionFollowupInputSchema = z
  .object({
    sessionId: IdSchema,
    text: z.string().min(1),
    attachments: z.array(BlobRefSchema).optional(),
  })
  .strict();
/** 一次 followup = 一个 type=agent 的 task（design §3.5）。 */
export const SessionFollowupOutputSchema = z.object({ taskId: IdSchema }).strict();
export type SessionFollowupInput = z.infer<typeof SessionFollowupInputSchema>;
export type SessionFollowupOutput = z.infer<typeof SessionFollowupOutputSchema>;

// ---------------------------------------------------------------- session.answer

export const SessionAnswerInputSchema = z
  .object({
    sessionId: IdSchema,
    requestId: IdSchema,
    approved: z.boolean(),
  })
  .strict();
export const SessionAnswerOutputSchema = z.object({ ok: z.boolean() }).strict();
export type SessionAnswerInput = z.infer<typeof SessionAnswerInputSchema>;
export type SessionAnswerOutput = z.infer<typeof SessionAnswerOutputSchema>;

// ---------------------------------------------------------------- session.cancel

/** {sessionId | taskId} 二选一（XOR——两者同给/全缺均拒绝）。 */
export const SessionCancelInputSchema = z
  .object({
    sessionId: IdSchema.optional(),
    taskId: IdSchema.optional(),
  })
  .strict()
  .refine(
    (input) => (input.sessionId !== undefined) !== (input.taskId !== undefined),
    { message: 'sessionId 与 taskId 必须二选一' },
  );
export const SessionCancelOutputSchema = z.object({ ok: z.boolean() }).strict();
export type SessionCancelInput = z.infer<typeof SessionCancelInputSchema>;
export type SessionCancelOutput = z.infer<typeof SessionCancelOutputSchema>;

// ---------------------------------------------------------------- session.clear

export const SessionClearInputSchema = z.object({ sessionId: IdSchema }).strict();
/**
 * clear 输出（W3 评审 P1-2 修订）：ok=true 表示清理指令已受理并推进（幂等语义不变）；
 * status 区分「已物理清理完成（cleared）」与「仍有文件删除失败/待重试（clearing）」
 * ——clearing 态会话由启动/维护重试收敛后再置 cleared，不得对调用方伪装成功。
 */
export const SessionClearOutputSchema = z
  .object({ ok: z.boolean(), status: z.enum(['cleared', 'clearing']) })
  .strict();
export type SessionClearInput = z.infer<typeof SessionClearInputSchema>;
export type SessionClearOutput = z.infer<typeof SessionClearOutputSchema>;

// ---------------------------------------------------------------- session.retry（§3.6 R5/R6）

/**
 * owner 认证的重试确认：绑定原 op+task/user+unknown 状态校验+显式费用确认
 * （costConfirmed=false 拒绝）。retryRequestId=客户端为**每一次确认**生成的幂等键——
 * 同键重放永远返回同一 attempt；有意下一次确认=新键。
 */
export const SessionRetryInputSchema = z
  .object({
    sessionId: IdSchema,
    proposalId: IdSchema,
    costConfirmed: z.boolean(),
    retryRequestId: IdSchema,
  })
  .strict();
export const SessionRetryOutputSchema = z
  .object({ attemptId: IdSchema, attemptNo: z.number().int().positive() })
  .strict();
export type SessionRetryInput = z.infer<typeof SessionRetryInputSchema>;
export type SessionRetryOutput = z.infer<typeof SessionRetryOutputSchema>;

// ---------------------------------------------------------------- session.replay / task.result

export const SessionReplayInputSchema = z
  .object({
    sessionId: IdSchema,
    taskId: IdSchema,
    /** 回放游标以 task 为域（每 task 独立从 1 单调；0=全量） */
    afterSeq: z.number().int().nonnegative().default(0),
  })
  .strict();
export const SessionReplayOutputSchema = z
  .object({
    frames: z.array(FrameSchema),
    /** 窗口后游标（无帧时=afterSeq 原值） */
    nextSeq: z.number().int().nonnegative(),
  })
  .strict();
export type SessionReplayInput = z.infer<typeof SessionReplayInputSchema>;
export type SessionReplayOutput = z.infer<typeof SessionReplayOutputSchema>;

/** 结果 bundle：三产物均内容寻址 blobRef（svg/bom 由引擎导出、png 服务端光栅）。 */
export const ResultBundleSchema = z
  .object({
    svg: BlobRefSchema,
    bom: BlobRefSchema,
    png: BlobRefSchema,
  })
  .strict();
export type ResultBundle = z.infer<typeof ResultBundleSchema>;

export const SessionResultInputSchema = z.object({ sessionId: IdSchema }).strict();
export const SessionResultOutputSchema = z
  .object({
    resultId: IdSchema,
    /** 语义=最新完成的 agent task（completedAt 最大，平局 taskId 大者——确定性） */
    taskId: IdSchema,
    publicId: z.string().min(1).optional(),
    bundle: ResultBundleSchema,
  })
  .strict();
export type SessionResultInput = z.infer<typeof SessionResultInputSchema>;
export type SessionResultOutput = z.infer<typeof SessionResultOutputSchema>;

/**
 * task.result 输出：found 显式双态——无结果=显式 not_found（不回退到别的 task），
 * 有结果与 session.result 同形（resultId/publicId?/bundle）。
 */
export const TaskResultInputSchema = z.object({ taskId: IdSchema }).strict();
export const TaskResultOutputSchema = z.discriminatedUnion('found', [
  z
    .object({
      found: z.literal(true),
      resultId: IdSchema,
      publicId: z.string().min(1).optional(),
      bundle: ResultBundleSchema,
    })
    .strict(),
  z.object({ found: z.literal(false) }).strict(),
]);
export type TaskResultInput = z.infer<typeof TaskResultInputSchema>;
export type TaskResultOutput = z.infer<typeof TaskResultOutputSchema>;

// ---------------------------------------------------------------- 确定性语义（纯函数）

/** session.result 候选（一个 session 内已完成 agent task 的投影行）。 */
export interface SessionResultCandidate {
  taskId: string;
  completedAt: string;
}

/**
 * 确定性选择（design §3.5）：最新 completedAt；平局取 taskId 大者（字典序——
 * task id 为字符串主键，比较语义冻结为字典序 max）。空集返回 null。
 */
export function selectSessionResult(candidates: SessionResultCandidate[]): SessionResultCandidate | null {
  let best: SessionResultCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.completedAt > best.completedAt) {
      best = candidate;
    } else if (candidate.completedAt === best.completedAt && candidate.taskId > best.taskId) {
      best = candidate;
    }
  }
  return best;
}

/** 回放游标以 task 为域（re-export 供会话面消费——两语义同源）。 */
export { replayWindow };

// ---------------------------------------------------------------- attempts 账本（§3.6 R5/R6）

/** attempt 状态机：claimed→running→succeeded/failed；unknown=崩溃或远端不可知。 */
export const AttemptStateSchema = z.enum(['claimed', 'running', 'succeeded', 'failed', 'unknown']);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

/** approved-mutation 持久 operation 状态机（approved_ops.proposalId=唯一幂等键）。 */
export const ApprovedOpStateSchema = z.enum([
  'approved',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'unknown',
]);
export type ApprovedOpState = z.infer<typeof ApprovedOpStateSchema>;

/** 外部尝试账本行（generate 族）：attemptId 持久唯一 UUID 主键。 */
export const AttemptSchema = z
  .object({
    attemptId: IdSchema,
    /** 父 approved op */
    proposalId: IdSchema,
    /** 同 proposal 内 1 起单调（首次批准自动创建 #1） */
    attemptNo: z.number().int().positive(),
    /** provider 幂等键（幂等 provider 重试复用同键；非幂等每 attempt 新键） */
    idemKey: IdSchema,
    /** 请求级确认幂等键（客户端生成，绑定 owner/session/proposal——跨归属复用必拒） */
    retryRequestId: IdSchema,
    state: AttemptStateSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Attempt = z.infer<typeof AttemptSchema>;

/**
 * attempts 表唯一约束（DDL 与本 schema 的对齐声明——design §2 R6）：
 * proposalId+attemptNo 唯一（同 op attempt 序号不重复）；
 * retryRequestId 唯一（同键重放收敛同一 attempt）。
 */
export const ATTEMPT_UNIQUE_KEYS = [
  ['proposalId', 'attemptNo'],
  ['retryRequestId'],
] as const;

/**
 * 「同 op 仅一个 active attempt」partial unique index（P1-6——DDL 对齐声明）：
 * proposalId 上 partial unique，条件 state IN ('claimed','running')——终态
 * （succeeded/failed/unknown）不占位，重试可开新 active attempt；并发两 claim
 * 只有一个成功（数据库层仲裁）。daemon 迁移 v2 落地。
 */
export const ATTEMPT_ACTIVE_UNIQUE_INDEX = {
  name: 'idx_attempts_one_active',
  columns: ['proposalId'] as const,
  where: "state IN ('claimed', 'running')",
};
