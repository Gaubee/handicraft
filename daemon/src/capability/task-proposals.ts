/**
 * 任务域审批状态观察工具（[grant-consumed 死锁恢复通道]，2026-10-01 P0）。
 * 实证病灶（会话 55bc9e13 生产帧流）：grant 被一次执行消费后，agent 对该
 * proposal 的后续 execute 必拒（grant-consumed），但 agent **无任何工具可查
 * proposal 真实状态**——只能盲猜（帧流原话「有两种可能：① 早前执行已完整落档
 * ② 中途夭折——无法甄别」）；恢复通道 session.retry 是用户 RPC（UI 无按钮），
 * agent 侧零恢复面=死锁。本工具=最小只读修：{taskId}（会话域锚）→ 本项目全部
 * proposal 的状态投影+逐状态行动指引（advice），agent 可自诊「已成功勿重放 /
 * 已消费需重新 propose / unknown 由用户确认重试」。写入面零新增——重新 propose
 * 走既有 propose 路径（重新 preview+approve）。
 * 数据真源：approved_ops/grants/attempts 行（db/approvals 单源 helpers）。
 */
import { z } from 'zod';
import type { SqliteDb } from '../db/database.js';
import {
  findActiveAttempt,
  listApprovedOpsOfSession,
  listGrantsOfProposal,
  getApprovedOp,
  type ApprovedOpRow,
} from '../db/approvals.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from './core.js';
import { RUNAWAY_LIMIT } from './studio.js';

export const TASK_PROPOSALS_LIST_TOOL_NAME = 'studio.task.proposals.list';

// ---------------------------------------------------------------- 输入 schema

const ListInputSchema = z.object({
  taskId: z
    .string()
    .min(1)
    .describe('当前 agent 任务 id（服务端解析所属会话=项目域——返回该项目全部 proposal）'),
  proposalId: z
    .string()
    .min(1)
    .optional()
    .describe('可选过滤：只看该 proposal（携带时其余行不返回；跨项目=typed 拒）'),
});

// ---------------------------------------------------------------- 工具面构造

export interface TaskProposalsCapabilitiesDeps {
  db: SqliteDb;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

/** 逐状态行动指引（agent 自诊面——死锁恢复的核心输出）。 */
function adviceOf(op: ApprovedOpRow, grants: { total: number; unconsumed: number }): string {
  switch (op.state) {
    case 'succeeded':
      return '已成功执行（resultRef 在案）——勿重放 execute（grant-consumed 必拒），直接继续后续步骤';
    case 'failed':
      return '已失败/被拒——需重新发起 proposal（同一工具 preview 模式→用户批准）';
    case 'unknown':
      return '执行中断、结果未知——请向用户说明并由其在会话中确认重试（session.retry，重试后携带原 proposalId 续跑），或重新发起 proposal';
    case 'claimed':
    case 'running':
      return '执行中——勿并发重放（concurrent 必拒），等待其收敛';
    case 'approved':
      return grants.unconsumed > 0
        ? '已批准待执行——携带该 proposalId 走工具 execute 模式（grant 在案未消费）'
        : grants.total > 0
          ? '授权已被一次执行消费——若执行产物未落档（工件缺失）即消费后夭折：勿重试 execute（grant-consumed 必拒），需重新发起 proposal；若产物在案则执行已成功，直接继续后续步骤'
          : '尚无授权（未被批准）——请先向用户呈现预览并等待批准（approval-request → 用户应答）';
  }
}

export function createTaskProposalsCapabilities(
  deps: TaskProposalsCapabilitiesDeps,
): CapabilityRegistry {
  const streaks = new Map<string, { key: string; count: number }>();

  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return { kind: 'failed', code: 'INVALID_OPERATION', message: `熔断：${reason}。请停止重试，向用户报告失败原因。` };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  /** 调用任务行校验（agent 任务+会话锚——与 task-images 同语义）。 */
  function agentTaskSessionOf(taskId: string): { sessionId: string; ownerId: string } {
    const task = deps.db
      .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
    if (task.session_id === null) throw new Error(`任务 ${taskId} 不属于任何会话——审批以会话（项目域）为锚`);
    return { sessionId: task.session_id, ownerId: task.owner_id };
  }

  function bucketOf(input: unknown): string {
    const taskId = (input as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : 'global';
  }

  function proposalView(op: ApprovedOpRow): Record<string, unknown> {
    const grants = listGrantsOfProposal(deps.db, op.proposal_id);
    const unconsumed = grants.filter((grant) => grant.consumed === 0).length;
    const active = findActiveAttempt(deps.db, op.proposal_id);
    const grantInfo = { total: grants.length, unconsumed };
    return {
      proposalId: op.proposal_id,
      tool: op.tool,
      state: op.state,
      taskId: op.task_id,
      createdAt: op.created_at,
      updatedAt: op.updated_at,
      expiresAt: op.expires_at,
      resultRef: op.result_ref,
      grant: grantInfo,
      ...(active !== null ? { activeAttempt: { attemptNo: active.attempt_no, state: active.state } } : {}),
      advice: adviceOf(op, grantInfo),
    };
  }

  const definitions: CapabilityDefinition[] = [
    {
      name: TASK_PROPOSALS_LIST_TOOL_NAME,
      description:
        '审批状态观察（只读）：返回当前项目（会话域）全部 approved-mutation proposal 的真实状态'
        + '（state/grant 消费面/attempt/逐状态行动指引）。专用于自诊授权死锁：execute 被拒'
        + '（grant-consumed/concurrent/proposal-expired 等）时先查本工具再决定——已成功'
        + '（succeeded）勿重放直接继续；授权已消费且产物缺失=需重新发起 proposal（preview→'
        + '用户批准）；unknown=执行中断，由用户在会话中确认重试后携原 proposalId 续跑。'
        + '勿以 execute 重试代替查询（重放必拒且烧重试预算）。',
      authority: 'readonly' as const,
      input: ListInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ListInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, TASK_PROPOSALS_LIST_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          const { sessionId, ownerId } = agentTaskSessionOf(parsed.data.taskId);
          let ops: ApprovedOpRow[];
          if (parsed.data.proposalId !== undefined) {
            const op = getApprovedOp(deps.db, parsed.data.proposalId);
            if (op === null) {
              noteSuccess(bucket);
              return {
                kind: 'failed',
                code: 'NOT_FOUND',
                message: `proposal 不存在：${parsed.data.proposalId}（proposalId 须为工具 propose 返回的完整 ID——截断/误抄无法查询，请从发起记录取回完整值）`,
              };
            }
            // 项目域+归属防御（读面同 consume 口径：跨项目不读；op 签发者与调用任务 owner 不一致=病态行拒读）。
            const opSession = deps.db
              .prepare('SELECT session_id FROM tasks WHERE id = ?')
              .get(op.task_id) as { session_id: string | null } | undefined;
            if ((opSession?.session_id ?? null) !== sessionId) {
              noteSuccess(bucket);
              return {
                kind: 'failed',
                code: 'INVALID_OPERATION',
                message: 'proposal 不属于当前项目（会话）——跨项目状态不可读，请在本项目内重新发起 proposal',
              };
            }
            if (op.user_id !== ownerId) {
              noteSuccess(bucket);
              return { kind: 'failed', code: 'INVALID_OPERATION', message: 'proposal 归属与当前任务不符（跨 user 读必拒）' };
            }
            ops = [op];
          } else {
            ops = listApprovedOpsOfSession(deps.db, sessionId).filter((op) => op.user_id === ownerId);
          }
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposals: ops.map(proposalView),
              note:
                'advice=按 state+grant 消费面给出的行动指引；grant.total=签发数（含 superseded 审计行）、unconsumed=当前可执行数。执行授权判定以工具 execute 时的服务端原子消费为准（本面为只读快照）。',
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_PROPOSALS_LIST_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  return createCapabilityRegistry(definitions);
}
