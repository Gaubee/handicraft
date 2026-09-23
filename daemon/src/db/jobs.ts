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
  const row: TaskRow = {
    id: newId(),
    owner_id: input.ownerId,
    resource_id: null,
    session_id: null,
    type: 'job',
    status: 'queued',
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

export function createResult(
  db: SqliteDb,
  input: { taskId: string | null; ownerId: string; title: string | null; bundlePath: string; publicId: string },
): ResultRow {
  const row: ResultRow = {
    id: newId(),
    public_id: input.publicId,
    task_id: input.taskId,
    owner_id: input.ownerId,
    title: input.title,
    bundle_path: input.bundlePath,
    created_at: nowIso(),
  };
  db.prepare(
    'INSERT INTO results (id, public_id, task_id, owner_id, title, bundle_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.public_id, row.task_id, row.owner_id, row.title, row.bundle_path, row.created_at);
  return row;
}
