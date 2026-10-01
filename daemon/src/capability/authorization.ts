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
  grantIssuingTask,
  insertApprovedOp,
  insertAttempt,
  insertGrant,
  listAttemptsOfProposal,
  listNonTerminalApprovedOps,
  listNonTerminalAttempts,
  markGrantConsumed,
  maxAttemptNo,
  supersedeSessionGrants,
  transitionApprovedOp,
  transitionAttempt,
  type ApprovedOpRow,
  type AttemptRow,
  type GrantRow,
  type ProposalPayload,
} from '../db/approvals.js';

/** proposal/grant 同源 TTL（批准等待窗口；design §3.6 过期必拒）。 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/**
 * [W6 6.2] 项目域 grant 过期窗：签发轮次终态（done/failed/cancelled）后 N 分钟
 * （Owner 裁决缺省 30min；env GRANT_PROJECT_TTL_MINUTES 可调——kernel 装配注入）。
 * 同项目跨轮消费的窗口=轮次终态重锚（非终态期间沿用绝对 TTL——批准等待窗口语义
 * 不变）。lazy 判定（消费时刻计算），无后台扫描。
 */
export const GRANT_PROJECT_TTL_MS = 30 * 60 * 1000;

/** [W6 6.2] 过期锚定用的任务终态集（queued/running=轮次在飞——绝对 TTL 照旧）。 */
const TASK_TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

/** 执行授权的消费路径（grant=用户批准；retry=owner 重试确认）。 */
export type ExecutionVia = 'grant' | 'retry';

/** 消费拒绝原因（§3.6.5 必拒路径全集 + 并发/状态面）。 */
export type ConsumeDenyReason =
  /** 输入未携带 proposalId（真·无授权直调——core.ts 映射 principal-forbidden）。 */
  | 'no-proposal'
  /** proposalId 在场但查无此行（agent 抄录截断/幻觉 ID——可行动指引，非权限定性）。 */
  | 'proposal-unknown'
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
  /**
   * [W6 6.2] 项目域 grant 过期窗（毫秒）：签发轮次终态后的跨轮消费窗口。
   * 缺省 30min；生产装配=env GRANT_PROJECT_TTL_MINUTES（config.ts 解析）。
   */
  grantProjectTtlMs?: number;
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
   * [product-polish-w1 T2·中央单点] 会话开启自动批准（sessions.auto_approve=1）时，
   * proposal 创建即自动签发 grant（supersede 同键旧 grant + insertGrant
   * autoApproved=1）+ 补发 approval-resolved 帧（autoApproved=true 审计标记）——
   * 所有 approved-mutation 工具统一经此生效，不逐工具放行。TTL 语义不变
   * （grant 过期窗与用户点击批准完全同源）；开启前悬挂的未决 proposal 不追补
   * （只在 propose 时刻判定——只对开启后的新 proposal 生效）。
   */
  propose(input: ProposeInput): {
    proposalId: string;
    requestId: string;
    opDigest: string;
    expiresAt: string;
    autoApproved?: boolean;
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
    // [W6 6.2] 审批卡归属呈现：项目=会话标题（空标题回退 sessionId 短码）——跨轮
    // 批准的归属可见（「这个批准属于哪个项目」）。可选字段=存量帧/旧前端兼容。
    const session = this.db
      .prepare('SELECT title, auto_approve FROM sessions WHERE id = ?')
      .get(task.session_id) as { title: string; auto_approve: number } | undefined;
    const projectLabel =
      session && session.title !== '' ? session.title : task.session_id.slice(0, 8);
    this.deps.jobs.emitFor(input.taskId, 'approval-request', {
      requestId,
      tool: input.tool,
      proposalId,
      preview: input.preview,
      summary: input.summary,
      expiresAt,
      projectLabel,
    });
    // [product-polish-w1 T2] 自动批准：会话开关开启 → 创建即签发 grant（与 answer
    // (approved=true) 同一签发链：同键旧 grant supersede + 审计标记 auto_approved）。
    // 消费面不变——agent 随后携带 proposalId 的 execute 走既有 consumeForExecution。
    const autoApprove = session !== undefined && session.auto_approve === 1;
    if (autoApprove) {
      supersedeSessionGrants(this.db, {
        sessionId: task.session_id,
        userId: input.userId,
        tool: input.tool,
        opDigest,
      });
      insertGrant(this.db, {
        proposalId,
        taskId: input.taskId,
        sessionId: task.session_id,
        opDigest,
        userId: input.userId,
        resourceId: input.resourceId ?? '',
        baseRevision: input.baseRevision ?? 0,
        expiresAt,
        autoApproved: true,
      });
      this.deps.jobs.emitFor(input.taskId, 'approval-resolved', {
        requestId,
        approved: true,
        resolvedAt: new Date().toISOString(),
        autoApproved: true,
      });
    }
    return {
      proposalId,
      requestId,
      opDigest,
      expiresAt,
      ...(autoApprove ? { autoApproved: true } : {}),
    };
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
          // [W6 6.2] 新提案覆盖同键旧 grant：同会话+同 user+同 tool+同 digest 的未
          // 消费旧 grant 先失效（一键一活——重新 preview+approve 后旧批准不双活）。
          supersedeSessionGrants(this.db, {
            sessionId: task.session_id as string,
            userId: op.user_id,
            tool: op.tool,
            opDigest: op.op_digest,
          });
          insertGrant(this.db, {
            proposalId: op.proposal_id,
            taskId: op.task_id,
            sessionId: task.session_id,
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
   * 单事务内：绑定校验（user/tool/digest+**项目域**）→ grant 消费即焚（consumed=1）
   * → revision CAS → op 原子 claim（approved→claimed）。
   * [W6 6.2（Owner 裁决 2026-09-30）] grant 绑定从 task 升级为 project：匹配键=
   * 签发任务所属会话 vs 消费上下文任务所属会话——同项目（会话）内跨轮（跨任务）
   * 消费放行；跨项目（新会话）必拒（须重新批准）。单次消费（消费即焚）保持。
   * [真链走查 P1-2 口径修正 2026-10-01] 消费主体=会话域内的 agent 任务（代表其
   * owner 行动），而非调用者身份等值：grant.user_id 不再与调用侧 userId 逐一比对
   * ——「用户批准的 grant，执行主体允许是代表该用户的 agent 任务」。grant 的合法
   * 消费主体判定=签发会话与消费上下文会话一致（同 session 的任务执行即合法）；
   * 跨 user 防线收窄为 op 归属防御（proposal 签发者与执行任务 owner 不一致=数据
   * 病态/跨账户挪用，仍拒 owner-mismatch）。同会话任务 owner 恒同源（sessions.
   * owner_id 单值+followup 建行），正常链路零行为变化。
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
        return {
          ok: false,
          reason: 'proposal-unknown',
          message: `proposal 不存在：${input.proposalId}（proposalId 须为工具 propose 返回的完整 ID——截断/误抄的 ID 无法消费，请从发起记录取回完整值）`,
        };
      }
      // 项目域匹配（W6 6.2）：消费上下文任务（agent 任务+会话归属）与 proposal 签发
      // 任务的会话必须一致。上下文缺失/非 agent/无会话归属=不可信消费面，同拒。
      const current = this.db
        .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
        .get(input.taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
      const opSession = this.sessionOfTask(op.task_id);
      if (
        !current ||
        current.type !== 'agent' ||
        current.session_id === null ||
        opSession === null ||
        opSession !== current.session_id
      ) {
        return {
          ok: false,
          reason: 'task-mismatch',
          message: 'grant 跨项目（会话）使用必拒——新会话须重新 preview+approve',
        };
      }
      if (op.user_id !== current.owner_id) {
        // [P1-2 口径修正] 主体域锚=执行任务行（代表其 owner 的 agent 任务）而非
        // 调用侧传参——签名保留 userId 兼容既有桥，判定以任务行真源为准。
        return { ok: false, reason: 'owner-mismatch', message: 'grant 跨 user 使用必拒（proposal 签发者与执行任务归属不符）' };
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
        if (this.grantExpired(grant)) {
          return { ok: false, reason: 'grant-expired', message: 'grant 已过期——需重新 preview+approve' };
        }
        // [P1-2 口径修正] grant 消费主体=会话域（「用户批准的 grant，执行主体允许是
        // 代表该用户的 agent 任务」）：判定键=签发会话与消费上下文会话一致。grant.
        // user_id 不再与调用侧逐一比对（历史行/迁移面 user 记录不一致不再误杀同
        // 会话的合法任务执行）；跨会话仍必拒。
        if (grant.session_id === null || grant.session_id !== current.session_id) {
          return { ok: false, reason: 'task-mismatch', message: 'grant 跨项目（会话）使用必拒——新会话须重新 preview+approve' };
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
              : '该 proposal 尚未获用户批准（无 grant 在案）——请先向用户呈现预览并等待其批准（approval-request → 用户应答），批准后携带同一 proposalId 再执行',
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

  /** [W6 6.2] 任务所属会话（项目域匹配键；行缺失/无会话=null）。 */
  private sessionOfTask(taskId: string): string | null {
    const row = this.db
      .prepare('SELECT session_id FROM tasks WHERE id = ?')
      .get(taskId) as { session_id: string | null } | undefined;
    return row?.session_id ?? null;
  }

  /** [W6 6.2] 项目域过期窗（env 可调注入；缺省 30min）。 */
  private get grantProjectTtlMs(): number {
    return this.deps.grantProjectTtlMs ?? GRANT_PROJECT_TTL_MS;
  }

  /**
   * [W6 6.2] 项目域过期判定（lazy——消费/预检时刻计算，无后台扫描）：
   * - 签发任务行缺失（clear 事务②已删）：孤儿 grant=过期（项目已亡）。
   * - 签发任务终态（done/failed/cancelled）：轮次结束=updated_at+N 分钟重锚——
   *   同项目跨轮消费窗口（缺省 30min）。
   * - 非终态（queued/running——轮次在飞）：绝对 TTL 照旧（批准等待窗口语义）。
   */
  private grantExpired(grant: GrantRow): boolean {
    const now = Date.now();
    const issuing = grantIssuingTask(this.db, grant.task_id);
    if (issuing === null) return true;
    if (TASK_TERMINAL_STATUSES.has(issuing.status)) {
      return new Date(issuing.updated_at).getTime() + this.grantProjectTtlMs <= now;
    }
    return new Date(grant.expires_at).getTime() <= now;
  }

  /**
   * 只读预检（core.ts 授权桥的 call 路径快面——不消费不写状态）：
   * approved-mutation 对 agent 主体的放行判定；真实消费在执行入口的同事务内。
   * [收官终评 P1/P2，2026-09-28] 两处对齐 consumeForExecution：
   *   - 消费上下文：execute 模式输入本就携带 taskId（MutationExecuteInputSchema 家族
   *     ={taskId,proposalId}——六处 capability 桥同形），预检阶段即校验其会话归属与
   *     签发会话一致，跨项目（task-mismatch）早拒；输入无 taskId（非标准形态）时
   *     保持「预检只负责 grant 形态，执行消费负责项目身份」的旧语义。
   *   - TTL：grant 在场（已批准）的过期判定统一以项目域 TTL（grantExpired——终态
   *     30min 重锚窗）为准，不再被 approved_ops.expires_at（10min 批准等待窗）截断
   *     「签发轮终态后 10-30 分钟、项目窗内」的真实 MCP 消费。
   */
  precheckMutation(name: string, input: unknown): { ok: boolean; reason?: ConsumeDenyReason; message?: string } {
    const proposalId = (input as { proposalId?: unknown } | null)?.proposalId;
    if (typeof proposalId !== 'string' || proposalId.length === 0) {
      return { ok: false, reason: 'no-proposal', message: 'approved-mutation 需携带 proposalId（无授权直调必拒）' };
    }
    const op = getApprovedOp(this.db, proposalId);
    if (!op) {
      // [真链走查 P1-2] proposalId 在场但查无此行=ID 抄录截断/幻觉（agent 跨轮转述
      // 只持短码时的高频形态），非权限定性——映射可读 failed 携行动指引（core.ts），
      // 不再与「无授权直调」混同 principal-forbidden（曾致 agent 误读「RBAC 拒绝」
      // 放弃执行、故事闭环断——真链走查 2026-10-01）。
      return {
        ok: false,
        reason: 'proposal-unknown',
        message: `proposal 不存在：${proposalId}（proposalId 须为工具 propose 返回的完整 ID——截断/误抄的 ID 无法消费，请从发起记录取回完整值后重试）`,
      };
    }
    if (op.tool !== name) {
      return { ok: false, reason: 'tool-mismatch', message: `proposal 工具不符（${op.tool}≠${name}）` };
    }
    // [收官终评 P2·预检上下文] 与 consumeForExecution 同口径：消费上下文任务须为
    // agent 任务且其会话=proposal 签发任务会话（项目域匹配键）。行缺失/非 agent/
    // 无会话归属/跨项目同拒（task-mismatch）——早于 handler 原子消费面呈现。
    const contextTaskId = (input as { taskId?: unknown } | null)?.taskId;
    if (typeof contextTaskId === 'string' && contextTaskId.length > 0) {
      const current = this.db
        .prepare('SELECT id, session_id, type FROM tasks WHERE id = ?')
        .get(contextTaskId) as { id: string; session_id: string | null; type: string } | undefined;
      const opSession = this.sessionOfTask(op.task_id);
      if (
        !current ||
        current.type !== 'agent' ||
        current.session_id === null ||
        opSession === null ||
        opSession !== current.session_id
      ) {
        return {
          ok: false,
          reason: 'task-mismatch',
          message: 'grant 跨项目（会话）使用必拒——新会话须重新 preview+approve',
        };
      }
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
            : '该 proposal 尚未获用户批准（无 grant 在案）——请先向用户呈现预览并等待其批准（approval-request → 用户应答），批准后携带同一 proposalId 再执行；文字回复不构成批准，需经审批卡应答',
        };
      }
    } else if (this.grantExpired(grant)) {
      // [W6 6.2] 项目域过期（终态重锚窗+孤儿/绝对 TTL 同一判定面）。
      return { ok: false, reason: 'grant-expired', message: 'grant 已过期——需重新 preview+approve' };
    }
    if (op.state !== 'approved') {
      return { ok: false, reason: 'op-not-approved', message: `proposal 状态不可执行（state=${op.state}）` };
    }
    // [收官终评 P1·TTL 一致性] grant 在场（已批准）路径：过期语义统一以项目域 TTL
    // 为准（上方 grantExpired 与 consumeForExecution 同一判定面，执行消费不检查
    // proposal 绝对 TTL）——预检不得以 10min 批准等待窗截断项目窗内的真实调用。
    // 无 grant 的 retry-armed 路径保持 proposal TTL（session.retry re-arm 时已对
    // approved 态续期——批准等待窗语义不因此放宽）。
    if (!grant && new Date(op.expires_at as string) <= new Date()) {
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
