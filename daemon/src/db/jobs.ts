/**
 * tasks/results 行存取面（zhumo db/tasks 模式——查询语句集中于此，服务层只消费视图）。
 * 正交意图：
 *   [1] tasks：job/agent 任务行的建/查/列/改（type ∈ {job, agent}；params 为 JSON TEXT）。
 *   [2] results：public_id 分享包行（bundle 落任务目录，bundle_path 指目录）。
 */
import type { TaskKind, TaskStatus } from '@handicraft/contracts';
import type { SqliteDb } from './database.js';
import { newId, nowIso } from './store.js';

export interface TaskRow {
  id: string;
  owner_id: string;
  resource_id: string | null;
  session_id: string | null;
  type: TaskKind;
  status: TaskStatus;
  params: string | null;
  result_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResultRow {
  id: string;
  public_id: string;
  task_id: string | null;
  owner_id: string;
  title: string | null;
  bundle_path: string;
  created_at: string;
  /** 分享包独立 TTL 到期时刻（ISO；NULL=迁移前旧行——视为不过期）。 */
  expires_at: string | null;
  /** 显式撤销时刻（ISO；非 NULL=已撤销——分享面 404）。 */
  revoked_at: string | null;
}

export function getTaskById(db: SqliteDb, id: string): TaskRow | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return (row as TaskRow | undefined) ?? null;
}

export function listTasksByOwner(db: SqliteDb, ownerId: string): TaskRow[] {
  return db
    .prepare('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC, id DESC')
    .all(ownerId) as TaskRow[];
}

export function createJobTask(
  db: SqliteDb,
  input: { ownerId: string; paramsJson: string },
): TaskRow {
  return insertTaskRow(db, {
    ownerId: input.ownerId,
    sessionId: null,
    type: 'job',
    paramsJson: input.paramsJson,
    status: 'queued',
  });
}

/** agent 会话任务行（W3.2——session.followup 的 501 期间测试/W4 内核的建行面）。 */
export function createAgentTask(
  db: SqliteDb,
  input: { ownerId: string; sessionId: string; paramsJson?: string; status?: TaskRow['status'] },
): TaskRow {
  return insertTaskRow(db, {
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    type: 'agent',
    paramsJson: input.paramsJson ?? null,
    status: input.status ?? 'running',
  });
}

function insertTaskRow(
  db: SqliteDb,
  input: {
    ownerId: string;
    sessionId: string | null;
    type: TaskKind;
    paramsJson: string | null;
    status: TaskRow['status'];
  },
): TaskRow {
  const row: TaskRow = {
    id: newId(),
    owner_id: input.ownerId,
    resource_id: null,
    session_id: input.sessionId,
    type: input.type,
    status: input.status,
    params: input.paramsJson,
    result_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    'INSERT INTO tasks (id, owner_id, resource_id, session_id, type, status, params, result_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.owner_id,
    row.resource_id,
    row.session_id,
    row.type,
    row.status,
    row.params,
    row.result_id,
    row.created_at,
    row.updated_at,
  );
  return row;
}

/** 会话下的全部任务行（clear 状态机的 task 域投影）。 */
export function listTasksBySession(db: SqliteDb, sessionId: string): TaskRow[] {
  return db
    .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at, id')
    .all(sessionId) as TaskRow[];
}

export function updateTask(
  db: SqliteDb,
  id: string,
  patch: Partial<Pick<TaskRow, 'status' | 'params' | 'result_id'>>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.params !== undefined) {
    sets.push('params = ?');
    values.push(patch.params);
  }
  if (patch.result_id !== undefined) {
    sets.push('result_id = ?');
    values.push(patch.result_id);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getResultById(db: SqliteDb, id: string): ResultRow | null {
  const row = db.prepare('SELECT * FROM results WHERE id = ?').get(id);
  return (row as ResultRow | undefined) ?? null;
}

export function getResultByPublicId(db: SqliteDb, publicId: string): ResultRow | null {
  const row = db.prepare('SELECT * FROM results WHERE public_id = ?').get(publicId);
  return (row as ResultRow | undefined) ?? null;
}

/** 分享面可达判定（W3.2 §6.5）：撤销或 TTL 到期=不可分享（/r/ 404）。 */
export function isResultShareable(row: ResultRow, now: Date = new Date()): boolean {
  if (row.revoked_at !== null) return false;
  if (row.expires_at !== null && row.expires_at <= now.toISOString()) return false;
  return true;
}

/** 已完成 agent task 的结果选择投影（contracts selectSessionResult 的候选行）。 */
export function listCompletedAgentTasks(db: SqliteDb, sessionId: string): TaskRow[] {
  return db
    .prepare(
      "SELECT * FROM tasks WHERE session_id = ? AND type = 'agent' AND status = 'done' AND result_id IS NOT NULL",
    )
    .all(sessionId) as TaskRow[];
}

/** 撤销：置 revoked_at（物理回收归 sweepExpiredResults——同一条 outbox 链路）。 */
export function markResultRevoked(db: SqliteDb, id: string): void {
  db.prepare('UPDATE results SET revoked_at = ? WHERE id = ?').run(nowIso(), id);
}

/** TTL 到期或已撤销的 results 行（sweepExpiredResults 的输入面）。 */
export function listExpiredOrRevokedResults(db: SqliteDb, now: Date = new Date()): ResultRow[] {
  return db
    .prepare(
      'SELECT * FROM results WHERE revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?)',
    )
    .all(now.toISOString()) as ResultRow[];
}

export function createResult(
  db: SqliteDb,
  input: {
    taskId: string | null;
    ownerId: string;
    title: string | null;
    bundlePath: string;
    publicId: string;
    expiresAt?: string | null;
  },
): ResultRow {
  const row: ResultRow = {
    id: newId(),
    public_id: input.publicId,
    task_id: input.taskId,
    owner_id: input.ownerId,
    title: input.title,
    bundle_path: input.bundlePath,
    created_at: nowIso(),
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
  };
  db.prepare(
    'INSERT INTO results (id, public_id, task_id, owner_id, title, bundle_path, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.public_id,
    row.task_id,
    row.owner_id,
    row.title,
    row.bundle_path,
    row.created_at,
    row.expires_at,
    row.revoked_at,
  );
  return row;
}
