/**
 * 授权/operation/attempt 行存取面（design §3.6——W4.2 授权桥的 DB 层）。
 * 原始需求 2026-09-23（tasks.md W4.2）：proposal 持久化（approved_ops 行）/
 * grant 签发与消费（消费即焚）/ attempt 账本（幂等键唯一约束）/ patch_history
 * 撤销组。查询语句集中于此；状态机事务语义在 capability/authorization.ts 编排。
 * 正交意图：
 *   [1] approved_ops：proposal+operation 同行（proposalId=唯一幂等键；v4 追加列
 *       承载 payload/CAS 基线/preview/summary/request_id/result_ref）。
 *   [2] grants：一次性授权（签发于 session.answer；消费于 approved-mutation 执行
 *       入口——同事务标记 consumed）。
 *   [3] attempts：外部尝试账本（attemptId 主键；proposalId+attemptNo 唯一；
 *       retryRequestId 唯一——跨归属复用必拒；active partial unique=v2）。
 */
import type { ApprovedOpState, AttemptState } from '@handicraft/contracts';
import type { SqliteDb } from './database.js';
import { newId, nowIso } from './store.js';

/** proposal 持久化载荷（approved_ops.payload_json 的解析形态——族判别）。 */
export type ProposalPayload =
  | { kind: 'patch-apply'; resourceId: string; region: { kind: 'blocks'; ids: string[] }; ops: unknown[] }
  | { kind: 'generate'; prompt: string; size?: string; imageRef?: string; advanced?: unknown }
  | { kind: 'export'; resourceId: string; withPng: boolean }
  | { kind: 'undo'; family: 'patch' | 'generate' | 'export'; target: string };

export interface ApprovedOpRow {
  proposal_id: string;
  task_id: string;
  user_id: string;
  tool: string;
  op_digest: string;
  resource_id: string | null;
  state: ApprovedOpState;
  created_at: string;
  updated_at: string;
  request_id: string | null;
  payload_json: string | null;
  base_revision: number | null;
  expires_at: string | null;
  preview_json: string | null;
  summary: string | null;
  result_ref: string | null;
}

export interface GrantRow {
  id: string;
  proposal_id: string;
  task_id: string;
  op_digest: string;
  user_id: string;
  resource_id: string;
  base_revision: number;
  expires_at: string;
  consumed: number;
  created_at: string;
}

export interface AttemptRow {
  attempt_id: string;
  proposal_id: string;
  attempt_no: number;
  idem_key: string;
  retry_request_id: string;
  state: AttemptState;
  created_at: string;
  updated_at: string;
}

export interface PatchHistoryRow {
  id: string;
  owner_id: string;
  resource_id: string;
  patch_group: string;
  proposal_id: string;
  op_kind: 'setDensity' | 'recolor' | 'setSpec';
  target: string;
  before_json: string;
  after_json: string;
  base_revision: number;
  created_at: string;
}

// ---------------------------------------------------------------- approved_ops

export interface InsertApprovedOpInput {
  proposalId: string;
  taskId: string;
  userId: string;
  tool: string;
  opDigest: string;
  resourceId: string | null;
  requestId: string;
  payloadJson: string;
  baseRevision: number | null;
  expiresAt: string;
  previewJson: string | null;
  summary: string;
}

export function insertApprovedOp(db: SqliteDb, input: InsertApprovedOpInput): ApprovedOpRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO approved_ops
       (proposal_id, task_id, user_id, tool, op_digest, resource_id, state, created_at, updated_at,
        request_id, payload_json, base_revision, expires_at, preview_json, summary, result_ref)
     VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.proposalId,
    input.taskId,
    input.userId,
    input.tool,
    input.opDigest,
    input.resourceId,
    now,
    now,
    input.requestId,
    input.payloadJson,
    input.baseRevision,
    input.expiresAt,
    input.previewJson,
    input.summary,
  );
  return getApprovedOp(db, input.proposalId) as ApprovedOpRow;
}

export function getApprovedOp(db: SqliteDb, proposalId: string): ApprovedOpRow | null {
  const row = db.prepare('SELECT * FROM approved_ops WHERE proposal_id = ?').get(proposalId);
  return (row as ApprovedOpRow | undefined) ?? null;
}

export function getApprovedOpByRequest(db: SqliteDb, requestId: string): ApprovedOpRow | null {
  const row = db.prepare('SELECT * FROM approved_ops WHERE request_id = ?').get(requestId);
  return (row as ApprovedOpRow | undefined) ?? null;
}

/** 原子 claim：state='approved' → target（并发双 claim 只有一个成功）。 */
export function claimApprovedOp(
  db: SqliteDb,
  proposalId: string,
  target: ApprovedOpState,
): boolean {
  const result = db
    .prepare('UPDATE approved_ops SET state = ?, updated_at = ? WHERE proposal_id = ? AND state = ?')
    .run(target, nowIso(), proposalId, 'approved');
  return result.changes > 0;
}

/** 终态/中间态置位（claimed→running→terminal；只允许从 from 转到 to——CAS 语义）。 */
export function transitionApprovedOp(
  db: SqliteDb,
  proposalId: string,
  from: ApprovedOpState,
  to: ApprovedOpState,
  extra?: { resultRef?: string },
): boolean {
  const result = db
    .prepare(
      'UPDATE approved_ops SET state = ?, updated_at = ?, result_ref = COALESCE(?, result_ref) WHERE proposal_id = ? AND state = ?',
    )
    .run(to, nowIso(), extra?.resultRef ?? null, proposalId, from);
  return result.changes > 0;
}

export function listNonTerminalApprovedOps(db: SqliteDb): ApprovedOpRow[] {
  return db
    .prepare("SELECT * FROM approved_ops WHERE state IN ('claimed', 'running')")
    .all() as ApprovedOpRow[];
}

// ---------------------------------------------------------------- grants

export function insertGrant(
  db: SqliteDb,
  input: {
    proposalId: string;
    taskId: string;
    opDigest: string;
    userId: string;
    resourceId: string;
    baseRevision: number;
    expiresAt: string;
  },
): GrantRow {
  const row: GrantRow = {
    id: newId(),
    proposal_id: input.proposalId,
    task_id: input.taskId,
    op_digest: input.opDigest,
    user_id: input.userId,
    resource_id: input.resourceId,
    base_revision: input.baseRevision,
    expires_at: input.expiresAt,
    consumed: 0,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO grants (id, proposal_id, task_id, op_digest, user_id, resource_id, base_revision, expires_at, consumed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.proposal_id,
    row.task_id,
    row.op_digest,
    row.user_id,
    row.resource_id,
    row.base_revision,
    row.expires_at,
    row.consumed,
    row.created_at,
  );
  return row;
}

export function findUnconsumedGrant(db: SqliteDb, proposalId: string): GrantRow | null {
  const row = db
    .prepare('SELECT * FROM grants WHERE proposal_id = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1')
    .get(proposalId);
  return (row as GrantRow | undefined) ?? null;
}

export function findAnyGrant(db: SqliteDb, proposalId: string): GrantRow | null {
  const row = db.prepare('SELECT * FROM grants WHERE proposal_id = ? LIMIT 1').get(proposalId);
  return (row as GrantRow | undefined) ?? null;
}

export function markGrantConsumed(db: SqliteDb, grantId: string): void {
  db.prepare('UPDATE grants SET consumed = 1 WHERE id = ?').run(grantId);
}

// ---------------------------------------------------------------- attempts

export function insertAttempt(
  db: SqliteDb,
  input: {
    attemptId: string;
    proposalId: string;
    attemptNo: number;
    idemKey: string;
    retryRequestId: string;
    state: AttemptState;
  },
): AttemptRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO attempts (attempt_id, proposal_id, attempt_no, idem_key, retry_request_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.attemptId,
    input.proposalId,
    input.attemptNo,
    input.idemKey,
    input.retryRequestId,
    input.state,
    now,
    now,
  );
  return getAttempt(db, input.attemptId) as AttemptRow;
}

export function getAttempt(db: SqliteDb, attemptId: string): AttemptRow | null {
  const row = db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
  return (row as AttemptRow | undefined) ?? null;
}

export function getAttemptByRetryRequest(db: SqliteDb, retryRequestId: string): AttemptRow | null {
  const row = db.prepare('SELECT * FROM attempts WHERE retry_request_id = ?').get(retryRequestId);
  return (row as AttemptRow | undefined) ?? null;
}

export function listAttemptsOfProposal(db: SqliteDb, proposalId: string): AttemptRow[] {
  return db
    .prepare('SELECT * FROM attempts WHERE proposal_id = ? ORDER BY attempt_no')
    .all(proposalId) as AttemptRow[];
}

export function maxAttemptNo(db: SqliteDb, proposalId: string): number {
  const row = db
    .prepare('SELECT MAX(attempt_no) AS n FROM attempts WHERE proposal_id = ?')
    .get(proposalId) as { n: number | null };
  return row.n ?? 0;
}

export function findActiveAttempt(db: SqliteDb, proposalId: string): AttemptRow | null {
  const row = db
    .prepare("SELECT * FROM attempts WHERE proposal_id = ? AND state IN ('claimed', 'running') LIMIT 1")
    .get(proposalId);
  return (row as AttemptRow | undefined) ?? null;
}

export function transitionAttempt(
  db: SqliteDb,
  attemptId: string,
  from: AttemptState,
  to: AttemptState,
): boolean {
  const result = db
    .prepare('UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ? AND state = ?')
    .run(to, nowIso(), attemptId, from);
  return result.changes > 0;
}

export function listNonTerminalAttempts(db: SqliteDb): AttemptRow[] {
  return db
    .prepare("SELECT * FROM attempts WHERE state IN ('claimed', 'running')")
    .all() as AttemptRow[];
}

// ---------------------------------------------------------------- patch_history

export interface InsertPatchHistoryInput {
  ownerId: string;
  resourceId: string;
  patchGroup: string;
  proposalId: string;
  opKind: PatchHistoryRow['op_kind'];
  target: string;
  beforeJson: string;
  afterJson: string;
  baseRevision: number;
}

export function insertPatchHistory(db: SqliteDb, input: InsertPatchHistoryInput): void {
  db.prepare(
    `INSERT INTO patch_history (id, owner_id, resource_id, patch_group, proposal_id, op_kind, target, before_json, after_json, base_revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    input.ownerId,
    input.resourceId,
    input.patchGroup,
    input.proposalId,
    input.opKind,
    input.target,
    input.beforeJson,
    input.afterJson,
    input.baseRevision,
    nowIso(),
  );
}

export function listPatchHistoryOfGroup(db: SqliteDb, patchGroup: string): PatchHistoryRow[] {
  return db
    .prepare('SELECT * FROM patch_history WHERE patch_group = ? ORDER BY rowid')
    .all(patchGroup) as PatchHistoryRow[];
}

export function listPatchGroupsOfResource(db: SqliteDb, resourceId: string): string[] {
  return (
    db
      .prepare('SELECT DISTINCT patch_group FROM patch_history WHERE resource_id = ? ORDER BY rowid DESC')
      .all(resourceId) as { patch_group: string }[]
  ).map((row) => row.patch_group);
}
