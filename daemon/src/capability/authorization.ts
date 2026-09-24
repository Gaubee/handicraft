/**
 * 批准授权桥（design §3.6 R2-R6——W4.2 核心）。
 * 原始需求 2026-09-23（tasks.md W4.2）：grant 服务端内部关联（nonce 零出帧/API/
 * MCP 载荷——agent 只带 proposalId）、revision CAS 漂移必拒、approved_ops 持久
 * operation 状态机（proposalId 幂等键/原子 claim）、attempt 账本（retryRequestId
 * 请求级幂等）、启动扫描遗留 claimed/running→unknown。
 * 正交意图：
 *   [1] propose→approval-request 帧→session.answer 签发 grant→approval-resolved 帧
 *       （grantId/nonce 永不出服务端——帧载荷由 contracts strict 守门）。
 *   [2] consumeForExecution：grant 消费（同事务 consumed+claim——消费即焚恰好一次）
 *       + digest/task/user/tool 四绑定校验 + revision CAS；retry-armed 路径（active
 *       attempt 授权=重试调用本身，不复用已消费 grant）。
 *   [3] attempt 账本：首次执行建 attempt#1；session.retry（owner 认证+costConfirmed
 *       +原 op unknown 校验）建新 attempt——幂等 provider 复用 attempt#1 的 idemKey
 *       （同键收敛同一远端结果），非幂等每 attempt 新键；retryRequestId 同键重放
 *       永远返回同一 attempt，跨归属复用必拒。
 *   [4] recoverNonTerminal：启动扫描（operation 与 attempt 双面）→unknown 呈现
 *       用户裁决（failed 仅由执行路径确定性错误写入——边界冻结）。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDb } from '../db/database.js';
import type { UserRow } from '../db/store.js';
import type { JobService } from '../jobs/service.js';
import {
  claimApprovedOp,
  findActiveAttempt,
  findAnyGrant,
  findUnconsumedGrant,
  getApprovedOp,
  getApprovedOpByRequest,
  getAttempt,
  getAttemptByRetryRequest,
  insertApprovedOp,
  insertAttempt,
  insertGrant,
  listAttemptsOfProposal,
  listNonTerminalApprovedOps,
  listNonTerminalAttempts,
  markGrantConsumed,
  maxAttemptNo,
  transitionApprovedOp,
  transitionAttempt,
  type ApprovedOpRow,
  type AttemptRow,
  type ProposalPayload,
} from '../db/approvals.js';

/** proposal/grant 同源 TTL（批准等待窗口；design §3.6 过期必拒）。 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** 执行授权的消费路径（grant=用户批准；retry=owner 重试确认）。 */
export type ExecutionVia = 'grant' | 'retry';

/** 消费拒绝原因（§3.6.5 必拒路径全集 + 并发/状态面）。 */
export type ConsumeDenyReason =
  | 'no-proposal'
  | 'task-mismatch'
  | 'owner-mismatch'
  | 'tool-mismatch'
  | 'digest-mismatch'
  | 'grant-missing'
  | 'grant-consumed'
  | 'grant-expired'
  | 'proposal-expired'
  | 'op-not-approved'
  | 'concurrent'
  | 'stale-revision';

export type ConsumeOutcome =
  | { ok: true; via: ExecutionVia; op: ApprovedOpRow }
  | { ok: false; reason: ConsumeDenyReason; message: string };

export interface ApprovalServiceDeps {
  db: SqliteDb;
  /** 帧提交单点（approval-request/approval-resolved/transcript——emitFor fence 语义）。 */
  jobs: JobService;
  /**
   * provider 幂等键能力（design §3.6 R4 分支）：true=重试复用 attempt#1 的
   * idemKey（同键收敛同一远端结果）；false=每 attempt 新键（可能再次计费，
   * 不承诺唯一远端结果）。缺省 false（BYOK 转发站常态）。
   */
  providerIdempotent?: () => boolean;
}

export interface ProposeInput {
  taskId: string;
  userId: string;
  tool: string;
  resourceId?: string;
  /** proposal 生成时的资源版本（CAS 基线；无资源族=generate 可缺省）。 */
  baseRevision?: number;
  payload: ProposalPayload;
  /** 前后预览 blobRef（approval-request 帧契约必填——无视觉面的族给费用单/参数单 blob）。 */
  preview: { before: string; after: string };
  summary: string;
  ttlMs?: number;
}

/** 稳定序列化（键排序——digest 对载荷字段序不敏感）。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** opDigest：{tool, resourceId, baseRevision, payload} 的 sha256（内容摘要）。 */
export function digestOf(input: {
  tool: string;
  resourceId?: string;
  baseRevision?: number;
  payload: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        tool: input.tool,
        resourceId: input.resourceId ?? null,
        baseRevision: input.baseRevision ?? null,
        payload: input.payload,
      }),
    )
    .digest('hex');
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  private get db(): SqliteDb {
    return this.deps.db;
  }

  // ---------------------------------------------------------------- proposal 签发

  /**
   * 创建 proposal（approved_ops 行，state='approved'）+ approval-request 帧。
   * 返回给 agent 的面只有 {proposalId, requestId, expiresAt}——grant 语义零出。
   */
  propose(input: ProposeInput): {
    proposalId: string;
    requestId: string;
    opDigest: string;
    expiresAt: string;
  } {
    const task = this.db
      .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
      .get(input.taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${input.taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${input.taskId}`);
    if (task.owner_id !== input.userId) throw new Error('任务归属与操作者不符（跨 user 使用必拒）');
    if (task.session_id === null) throw new Error(`任务未绑定会话：${input.taskId}`);

    const proposalId = randomUUID();
    const requestId = randomUUID();
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? APPROVAL_TTL_MS)).toISOString();
    const opDigest = digestOf({
      tool: input.tool,
      resourceId: input.resourceId,
      baseRevision: input.baseRevision,
      payload: input.payload,
    });
    insertApprovedOp(this.db, {
      proposalId,
      taskId: input.taskId,
      userId: input.userId,
      tool: input.tool,
      opDigest,
      resourceId: input.resourceId ?? null,
      requestId,
      payloadJson: canonicalJson(input.payload),
      baseRevision: input.baseRevision ?? null,
      expiresAt,
      previewJson: canonicalJson(input.preview),
      summary: input.summary,
    });
    this.deps.jobs.emitFor(input.taskId, 'approval-request', {
      requestId,
      tool: input.tool,
      proposalId,
      preview: input.preview,
      summary: input.summary,
      expiresAt,
    });
    return { proposalId, requestId, opDigest, expiresAt };
  }

  // ---------------------------------------------------------------- session.answer

  /**
   * 审批应答（rpc session.answer 入口）：approved=true → 签发并持久化 grant；
   * false → op 转 failed（终态，不签发）。双路径都发 approval-resolved 帧。
   * grant 字段全部服务端内部关联——签发后任何帧/API/MCP 载荷不携带 grantId/nonce。
   */
  answer(
    user: UserRow,
    input: { sessionId: string; requestId: string; approved: boolean },
  ): { ok: boolean } {
    const tx = this.db.transaction(() => {
      const session = this.db
        .prepare('SELECT id, owner_id, status FROM sessions WHERE id = ?')
        .get(input.sessionId) as { id: string; owner_id: string; status: string } | undefined;
      if (!session) throw new Error(`会话不存在：${input.sessionId}`);
      if (session.status === 'clearing') throw new Error('会话正在清理，拒绝审批应答');
      if (session.status === 'cleared') throw new Error('会话已清理');
      if (session.owner_id !== user.id) throw new Error('无权应答他人会话的审批');

      const op = getApprovedOpByRequest(this.db, input.requestId);
      if (!op) throw new Error(`审批请求不存在：${input.requestId}`);
      const task = this.db
        .prepare('SELECT id, session_id FROM tasks WHERE id = ?')
        .get(op.task_id) as { id: string; session_id: string | null } | undefined;
      if (!task || task.session_id !== input.sessionId) {
        throw new Error(`审批请求不属于该会话：${input.requestId}`);
      }
      if (op.state !== 'approved' || findAnyGrant(this.db, op.proposal_id) !== null) {
        const alreadyGranted = findAnyGrant(this.db, op.proposal_id) !== null;
        throw new Error(
          alreadyGranted
            ? `审批请求已处理（grant 已签发${op.state === 'succeeded' ? '且已执行' : ''}）——重放应答必拒`
            : `审批请求已处理（state=${op.state}）——重放应答必拒`,
        );
      }
      if (new Date(op.expires_at as string) <= new Date()) {
        throw new Error('审批请求已过期——请让助手重新发起 proposal');
      }

      if (input.approved) {
        // 已存在未消费 grant=幂等重放（同 request 重复 answer 的并发面）。
        if (!findUnconsumedGrant(this.db, op.proposal_id)) {
          insertGrant(this.db, {
            proposalId: op.proposal_id,
            taskId: op.task_id,
            opDigest: op.op_digest,
            userId: op.user_id,
            resourceId: op.resource_id ?? '',
            baseRevision: op.base_revision ?? 0,
            expiresAt: op.expires_at as string,
          });
        }
      } else {
        transitionApprovedOp(this.db, op.proposal_id, 'approved', 'failed');
      }
      this.deps.jobs.emitFor(op.task_id, 'approval-resolved', {
        requestId: input.requestId,
        approved: input.approved,
        resolvedAt: new Date().toISOString(),
      });
      return { ok: true };
    });
    return tx();
  }

  // ---------------------------------------------------------------- 执行授权（消费面）

  /**
   * approved-mutation 执行入口的原子消费（§3.6.3-4）：
   * 单事务内：四绑定校验（task/user/tool/digest）→ grant 消费即焚（consumed=1）
   * → revision CAS → op 原子 claim（approved→claimed）。
   * retry-armed（无未消费 grant 但存在 active attempt——session.retry 已确认）：
   * 授权=重试调用本身，直接 claim；执行时 revision CAS 仍重校验。
   */
  consumeForExecution(input: {
    proposalId: string;
    taskId: string;
    userId: string;
    tool: string;
  }): ConsumeOutcome {
    const tx = this.db.transaction((): ConsumeOutcome => {
      const op = getApprovedOp(this.db, input.proposalId);
      if (!op) {
        return { ok: false, reason: 'no-proposal', message: `proposal 不存在：${input.proposalId}` };
      }
      if (op.task_id !== input.taskId) {
        return { ok: false, reason: 'task-mismatch', message: 'grant 跨 task 使用必拒' };
      }
      if (op.user_id !== input.userId) {
        return { ok: false, reason: 'owner-mismatch', message: 'grant 跨 user 使用必拒' };
      }
      if (op.tool !== input.tool) {
        return { ok: false, reason: 'tool-mismatch', message: `proposal 工具不符（${op.tool}≠${input.tool}）` };
      }
      // digest 自洽：持久化 payload 重算摘要必须等于签发摘要（篡改 payload/grant 必拒）。
      const recomputed = digestOf({
        tool: op.tool,
        resourceId: op.resource_id ?? undefined,
        baseRevision: op.base_revision ?? undefined,
        payload: JSON.parse(op.payload_json as string) as unknown,
      });
      if (recomputed !== op.op_digest) {
        return { ok: false, reason: 'digest-mismatch', message: 'proposal 载荷摘要不匹配——内容被篡改或损坏，必拒' };
      }
      if (op.state === 'claimed' || op.state === 'running') {
        return { ok: false, reason: 'concurrent', message: '同 proposal 已在执行中——并发调用本地去重必拒' };
      }
      if (op.state !== 'approved') {
        return { ok: false, reason: 'op-not-approved', message: `proposal 状态不可执行（state=${op.state}）` };
      }

      let via: ExecutionVia | null = null;
      const grant = findUnconsumedGrant(this.db, input.proposalId);
      if (grant) {
        if (new Date(grant.expires_at) <= new Date()) {
          return { ok: false, reason: 'grant-expired', message: 'grant 已过期——需重新 preview+approve' };
        }
        if (grant.task_id !== input.taskId || grant.user_id !== input.userId) {
          return { ok: false, reason: 'task-mismatch', message: 'grant 跨 task/user 使用必拒' };
        }
        if (grant.op_digest !== op.op_digest || recomputed !== grant.op_digest) {
          return { ok: false, reason: 'digest-mismatch', message: 'grant 摘要不匹配——必拒' };
        }
        markGrantConsumed(this.db, grant.id); // 消费即焚（同事务）
        via = 'grant';
      } else {
        // 无未消费 grant：已消费过的 grant 重放必拒；retry-armed（active attempt）放行。
        const anyGrant = findAnyGrant(this.db, input.proposalId);
        const active = findActiveAttempt(this.db, input.proposalId);
        if (!active) {
          return {
            ok: false,
            reason: anyGrant ? 'grant-consumed' : 'grant-missing',
            message: anyGrant
              ? 'grant 已消费——重放必拒（重试需经 session.retry 重新确认）'
              : '无授权直调必拒——需用户批准（approval-request → session.answer）后携带 proposalId 调用',
          };
        }
        via = 'retry';
      }

      // revision CAS（§3.6.4）：资源当前版本 ≠ proposal 基线 → 拒绝并要求重新 preview+approve。
      if (op.resource_id !== null) {
        const resource = this.db
          .prepare('SELECT revision FROM resources WHERE id = ?')
          .get(op.resource_id) as { revision: number } | undefined;
        if (!resource) {
          return { ok: false, reason: 'stale-revision', message: `proposal 绑定的资源已不存在：${op.resource_id}` };
        }
        if (resource.revision !== (op.base_revision ?? 0)) {
          return {
            ok: false,
            reason: 'stale-revision',
            message: `资源版本漂移（当前 v${resource.revision} ≠ 批准时 v${op.base_revision}）——按过时状态覆盖必拒，请重新 preview+approve`,
          };
        }
      }

      if (!claimApprovedOp(this.db, input.proposalId, 'claimed')) {
        return { ok: false, reason: 'concurrent', message: '同 proposal 并发 claim——本地去重必拒' };
      }
      return { ok: true, via, op };
    });
    return tx();
  }

  /**
   * 只读预检（core.ts 授权桥的 call 路径快面——不消费不写状态）：
   * approved-mutation 对 agent 主体的放行判定；真实消费在执行入口的同事务内。
   */
  precheckMutation(name: string, input: unknown): { ok: boolean; reason?: ConsumeDenyReason; message?: string } {
    const proposalId = (input as { proposalId?: unknown } | null)?.proposalId;
    if (typeof proposalId !== 'string' || proposalId.length === 0) {
      return { ok: false, reason: 'no-proposal', message: 'approved-mutation 需携带 proposalId（无授权直调必拒）' };
    }
    const op = getApprovedOp(this.db, proposalId);
    if (!op) return { ok: false, reason: 'no-proposal', message: `proposal 不存在：${proposalId}` };
    if (op.tool !== name) {
      return { ok: false, reason: 'tool-mismatch', message: `proposal 工具不符（${op.tool}≠${name}）` };
    }
    if (op.state === 'claimed' || op.state === 'running') {
      return { ok: false, reason: 'concurrent', message: '同 proposal 已在执行中' };
    }
    // grant 面先行：已消费的重放（含 op 已终态）优先呈现「已消费」——比裸终态更可读。
    const grant = findUnconsumedGrant(this.db, proposalId);
    if (!grant) {
      const anyGrant = findAnyGrant(this.db, proposalId);
      const active = findActiveAttempt(this.db, proposalId);
      if (!active) {
        return {
          ok: false,
          reason: anyGrant ? 'grant-consumed' : 'grant-missing',
          message: anyGrant
            ? 'grant 已消费——重放必拒（重试需经 session.retry 重新确认）'
            : '无授权直调必拒——需用户批准（approval-request → session.answer）后携带 proposalId 调用',
        };
      }
    } else if (new Date(grant.expires_at) <= new Date()) {
      return { ok: false, reason: 'grant-expired', message: 'grant 已过期——需重新 preview+approve' };
    }
    if (op.state !== 'approved') {
      return { ok: false, reason: 'op-not-approved', message: `proposal 状态不可执行（state=${op.state}）` };
    }
    if (new Date(op.expires_at as string) <= new Date()) {
      return { ok: false, reason: 'proposal-expired', message: 'proposal 已过期——需重新发起' };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- generate attempt 面

  /**
   * 外部 op 执行启动：op claimed→running + attempt 建立/接管。
   * 首次执行（无 attempt）→ 建 attempt#1（state 直达 running）；retry-armed →
   * 接管 active attempt（claimed→running）。返回 attempt（idemKey 供 provider）。
   */
  startExternalAttempt(proposalId: string): AttemptRow {
    const tx = this.db.transaction((): AttemptRow => {
      const op = getApprovedOp(this.db, proposalId);
      if (!op) throw new Error(`proposal 不存在：${proposalId}`);
      if (op.state === 'running') {
        const active = findActiveAttempt(this.db, proposalId);
        if (active && active.state === 'running') return active; // 幂等重入（执行器内部恢复面）
      }
      if (!transitionApprovedOp(this.db, proposalId, 'claimed', 'running')) {
        throw new Error(`op 非 claimed 态，无法启动执行（state=${op.state}）`);
      }
      const active = findActiveAttempt(this.db, proposalId);
      if (active) {
        if (!transitionAttempt(this.db, active.attempt_id, 'claimed', 'running')) {
          throw new Error(`attempt ${active.attempt_id} 非 claimed 态，无法接管`);
        }
        return getAttempt(this.db, active.attempt_id) as AttemptRow;
      }
      const attempt = insertAttempt(this.db, {
        attemptId: randomUUID(),
        proposalId,
        attemptNo: maxAttemptNo(this.db, proposalId) + 1,
        idemKey: randomUUID(),
        retryRequestId: `first:${randomUUID()}`, // 首次批准自动创建（非用户确认键——合成唯一值占位）
        state: 'running',
      });
      return attempt;
    });
    return tx();
  }

  /**
   * 执行收尾：op →terminal + attempt →terminal（同一事务）。
   * 本地 op（patch/export——claim 后同步执行，不经过 running 面）与外部 op
   * （generate——startExternalAttempt 置 running）两条收尾路径都在此收敛。
   * W4.2 R1 P1-3：attempt 收敛面覆盖 claimed（session.retry 为 unknown op 新建的
   * attempt 恒为 claimed——export/patch 本地执行不经 running 面，收尾必须能从
   * claimed 直达终态，否则残留 claimed 悬挂）。
   */
  settleExternal(
    proposalId: string,
    outcome: { kind: 'succeeded'; resultRef?: string } | { kind: 'failed'; message: string },
  ): void {
    const tx = this.db.transaction(() => {
      const op = getApprovedOp(this.db, proposalId);
      if (!op) throw new Error(`proposal 不存在：${proposalId}`);
      if (op.state === 'succeeded' || op.state === 'failed' || op.state === 'unknown') return; // 幂等（已结算）
      const terminal = outcome.kind === 'succeeded' ? 'succeeded' : 'failed';
      const settled =
        transitionApprovedOp(this.db, proposalId, 'running', terminal, outcome.kind === 'succeeded' ? { resultRef: outcome.resultRef } : undefined) ||
        transitionApprovedOp(this.db, proposalId, 'claimed', terminal, outcome.kind === 'succeeded' ? { resultRef: outcome.resultRef } : undefined);
      if (!settled) {
        throw new Error(`op 非 running/claimed 态，无法结算（state=${op.state}）`);
      }
      const active = findActiveAttempt(this.db, proposalId);
      if (active) {
        transitionAttempt(this.db, active.attempt_id, 'running', terminal) ||
          transitionAttempt(this.db, active.attempt_id, 'claimed', terminal);
      }
    });
    tx();
  }

  // ---------------------------------------------------------------- session.retry

  /**
   * owner 认证的重试确认（§3.6 R5/R6）：
   * - 绑定校验：session 归属 + op 归属（task 属 session + user）+ 原 op unknown；
   * - costConfirmed=false 拒绝；如实提示可能再次计费（transcript 帧入任务流）；
   * - retryRequestId 请求级幂等：同键重放（含首 attempt 已 unknown 后）永远返回
   *   同一 attempt；跨 owner/session/proposal 复用键必拒；重放遇 unknown attempt
   *   =重新接管（P1-2：re-arm 该 attempt 后可继续执行——不新建、不重复计费）；
   * - 幂等 provider：复用 attempt#1 的 idemKey（同键收敛同一远端结果）；非幂等：
   *   新 idemKey（新远端尝试，可能再次计费，不承诺唯一结果）；
   * - 新 attempt state='claimed' + op unknown→approved（re-arm；执行时 revision CAS 重校验）。
   */
  retry(
    user: UserRow,
    input: { sessionId: string; proposalId: string; costConfirmed: boolean; retryRequestId: string; ttlMs?: number },
  ): { attemptId: string; attemptNo: number } {
    // 费用确认门（W4.2 R2 残余 P2 收口）：入口先行——同键重放/重新接管路径同样必拒
    // false（冻结契约「costConfirmed=false 必拒」覆盖全部 retry 形态，不只首建 attempt）。
    if (!input.costConfirmed) {
      throw new Error('重试需显式费用确认（costConfirmed=true）——外部调用可能再次计费');
    }
    const tx = this.db.transaction((): { attemptId: string; attemptNo: number } => {
      const session = this.db
        .prepare('SELECT id, owner_id, status FROM sessions WHERE id = ?')
        .get(input.sessionId) as { id: string; owner_id: string; status: string } | undefined;
      if (!session) throw new Error(`会话不存在：${input.sessionId}`);
      if (session.status !== 'active') throw new Error('会话正在清理或已清理，拒绝重试确认');
      if (session.owner_id !== user.id) throw new Error('跨用户 session.retry 必拒——仅会话 owner 可确认重试');

      // 请求级幂等（R6）：同键重放返回同一 attempt——键绑定 owner/session/proposal。
      const existing = getAttemptByRetryRequest(this.db, input.retryRequestId);
      if (existing) {
        const bound = this.db
          .prepare('SELECT t.session_id, t.owner_id FROM approved_ops o JOIN tasks t ON t.id = o.task_id WHERE o.proposal_id = ?')
          .get(existing.proposal_id) as { session_id: string | null; owner_id: string } | undefined;
        if (
          !bound ||
          bound.session_id !== input.sessionId ||
          bound.owner_id !== user.id ||
          existing.proposal_id !== input.proposalId
        ) {
          throw new Error('retryRequestId 跨 owner/session/proposal 复用必拒');
        }
        // P1-2 重新接管：确认在执行前崩溃/重启后，attempt 已随恢复收敛 unknown——同键
        // 重放不能只回显原行（grant 已消费+attempt 非 active=执行入口 grant-consumed
        // 死锁），必须重新 arm：attempt unknown→claimed + op unknown→approved（TTL 续期）。
        // attempt 仍 claimed/running（在途执行中）或已终态（succeeded/failed）的重放
        // 保持只读返回（同键不新建、不重复计费语义不变）。
        if (existing.state === 'unknown') {
          const opRow = getApprovedOp(this.db, input.proposalId);
          if (opRow && (opRow.state === 'unknown' || opRow.state === 'approved')) {
            if (!transitionAttempt(this.db, existing.attempt_id, 'unknown', 'claimed')) {
              throw new Error(`attempt ${existing.attempt_id} 重新接管失败（状态已变化）`);
            }
            this.db
              .prepare(
                "UPDATE approved_ops SET state = 'approved', expires_at = ?, updated_at = ? WHERE proposal_id = ? AND state IN ('unknown', 'approved')",
              )
              .run(
                new Date(Date.now() + (input.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
                new Date().toISOString(),
                input.proposalId,
              );
            this.deps.jobs.emitFor(opRow.task_id, 'transcript', {
              role: 'user',
              text: `已重新接管重试确认（attempt #${existing.attempt_no}）——可继续执行：${input.proposalId}`,
            });
          }
        }
        return { attemptId: existing.attempt_id, attemptNo: existing.attempt_no };
      }

      const op = getApprovedOp(this.db, input.proposalId);
      if (!op) throw new Error(`proposal 不存在：${input.proposalId}`);
      const task = this.db
        .prepare('SELECT id, session_id, owner_id FROM tasks WHERE id = ?')
        .get(op.task_id) as { id: string; session_id: string | null; owner_id: string } | undefined;
      if (!task || task.session_id !== input.sessionId) {
        throw new Error('proposal 不属于该会话——重试绑定必拒');
      }
      if (op.user_id !== user.id || task.owner_id !== user.id) {
        throw new Error('跨用户 session.retry 必拒——仅 op owner 可确认重试');
      }
      if (op.state !== 'unknown') {
        throw new Error(`仅 unknown 态 op 可重试（当前 state=${op.state}——failed 请重新发起 proposal）`);
      }

      // 幂等 provider：复用 attempt#1 的 idemKey（同键收敛同一远端结果）。
      const attempts = listAttemptsOfProposal(this.db, input.proposalId);
      const first = attempts.find((candidate) => candidate.attempt_no === 1);
      const idemKey =
        this.deps.providerIdempotent?.() && first ? first.idem_key : randomUUID();

      const attempt = insertAttempt(this.db, {
        attemptId: randomUUID(),
        proposalId: input.proposalId,
        attemptNo: maxAttemptNo(this.db, input.proposalId) + 1,
        idemKey,
        retryRequestId: input.retryRequestId,
        state: 'claimed',
      });
      // re-arm：unknown→approved + TTL 续期（重试授权=本次确认本身——等待执行的
      // 窗口从确认时刻重新起算；active attempt 在身，执行入口走 retry-armed 路径）。
      this.db
        .prepare(
          "UPDATE approved_ops SET state = 'approved', expires_at = ?, updated_at = ? WHERE proposal_id = ? AND state = 'unknown'",
        )
        .run(
          new Date(Date.now() + (input.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
          new Date().toISOString(),
          input.proposalId,
        );
      this.deps.jobs.emitFor(op.task_id, 'transcript', {
        role: 'user',
        text: `已确认重试（attempt #${attempt.attempt_no}${this.deps.providerIdempotent?.() ? '，幂等键复用收敛同一远端结果' : '，可能再次计费'}）：${input.proposalId}`,
      });
      return { attemptId: attempt.attempt_id, attemptNo: attempt.attempt_no };
    });
    return tx();
  }

  // ---------------------------------------------------------------- 启动收敛（R4）

  /**
   * 启动扫描：claimed/running 的 operation 与 attempt 全部转 unknown（崩溃瞬间
   * 无法自行落库——呈现用户裁决；failed 仅由执行路径确定性错误写入，边界冻结）。
   * W4.2 R1 P1-2 成对收敛：attempt 非终态 ⇔ 执行至少被 arm 过一次——其父 op 无论
   * approved（retry re-arm 后、执行前重启的窗口）/claimed/running 都必须回到
   * unknown。只收敛 attempt 不收敛 op 会留下「op=approved + 已消费 grant +
   * attempt=unknown」的不可执行死锁（执行入口 grant-consumed，retry 又因 op 非
   * unknown 被拒）。
   */
  recoverNonTerminal(): { ops: number; attempts: number } {
    const now = new Date().toISOString();
    const ops = listNonTerminalApprovedOps(this.db);
    for (const op of ops) {
      this.db
        .prepare('UPDATE approved_ops SET state = ?, updated_at = ? WHERE proposal_id = ?')
        .run('unknown', now, op.proposal_id);
    }
    const attempts = listNonTerminalAttempts(this.db);
    const parents = new Set<string>();
    for (const attempt of attempts) {
      this.db
        .prepare('UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ?')
        .run('unknown', now, attempt.attempt_id);
      parents.add(attempt.proposal_id);
    }
    let paired = 0;
    for (const proposalId of parents) {
      const result = this.db
        .prepare(
          "UPDATE approved_ops SET state = 'unknown', updated_at = ? WHERE proposal_id = ? AND state IN ('approved', 'claimed', 'running')",
        )
        .run(now, proposalId);
      paired += result.changes;
    }
    return { ops: ops.length + paired, attempts: attempts.length };
  }

  // ---------------------------------------------------------------- 读面（诊断/撤销）

  opOf(proposalId: string): ApprovedOpRow | null {
    return getApprovedOp(this.db, proposalId);
  }

  attemptsOf(proposalId: string): AttemptRow[] {
    return listAttemptsOfProposal(this.db, proposalId);
  }
}
