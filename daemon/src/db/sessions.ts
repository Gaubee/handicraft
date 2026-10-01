/**
 * sessions / 引用账本 / cleanup outbox 行存取面（W3.2——design §6.5 跨介质清理）。
 * 原始需求 2026-09-23：sessions 表（clearing 栅栏+cleared tombstone；列表过滤 cleared）、
 * session_blob_refs（会话侧引用——一行=一次引用事件，与 ref_count 增量一一对应）、
 * result_blob_refs（分享包独立引用）、cleanup_outbox（待删文件清单，持久化完整旧代路径）。
 * 正交意图：
 *   [1] sessions：建/查/列（列表过滤 cleared tombstone——tombstone 只对 clear 幂等与
 *       24h 例行清理可见）/状态流转。
 *   [2] 两张引用账本：会话侧与 result 侧各自独立计数语义（§6.5 留存矩阵）。
 *   [3] cleanup_outbox：入队/取 pending/标 done（含 blob 行终删）/失败重试计数。
 */
import type { SqliteDb } from './database.js';
import { newId, nowIso } from './store.js';

export interface SessionRow {
  id: string;
  owner_id: string;
  title: string;
  status: 'active' | 'clearing' | 'cleared';
  created_at: string;
  updated_at: string;
  cleared_at: string | null;
  /**
   * [product-polish-w1 T2] 会话级自动批准开关（v14 列；0/1）——followup.autoApprove
   * 透传写入（最后写入者胜），propose 中央单点读取（开启=proposal 创建即签发 grant）。
   */
  auto_approve: number;
}

export interface OutboxRow {
  id: string;
  kind: 'blob' | 'file' | 'dir';
  path: string;
  blob_row: string | null;
  session_id: string | null;
  result_id: string | null;
  state: 'pending' | 'done' | 'failed';
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface OutboxEntryInput {
  kind: OutboxRow['kind'];
  /** 完整绝对路径（blob=旧代物理文件；dir=任务/bundle 目录；file=单文件）。 */
  path: string;
  blob_row?: string;
  session_id?: string;
  result_id?: string;
}

// ---------------------------------------------------------------- sessions

export function createSessionRow(
  db: SqliteDb,
  input: { ownerId: string; title: string },
): SessionRow {
  const row: SessionRow = {
    id: newId(),
    owner_id: input.ownerId,
    title: input.title,
    status: 'active',
    created_at: nowIso(),
    updated_at: nowIso(),
    cleared_at: null,
    auto_approve: 0,
  };
  db.prepare(
    'INSERT INTO sessions (id, owner_id, title, status, created_at, updated_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.owner_id, row.title, row.status, row.created_at, row.updated_at, row.cleared_at);
  return row;
}

export function getSessionById(db: SqliteDb, id: string): SessionRow | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return (row as SessionRow | undefined) ?? null;
}

/** 会话及其归属校验（admin 豁免——tasks 面同语义）。 */
export function requireOwnedSession(
  db: SqliteDb,
  user: { id: string; role: string },
  sessionId: string,
): SessionRow {
  const session = getSessionById(db, sessionId);
  if (!session) throw new Error(`会话不存在：${sessionId}`);
  if (session.owner_id !== user.id && user.role !== 'admin') throw new Error('无权访问该会话');
  return session;
}

/** 列表过滤 cleared tombstone（§6.5——cleared 不出现在用户列表）。 */
export function listSessionsByOwner(db: SqliteDb, ownerId: string): SessionRow[] {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE owner_id = ? AND status != 'cleared' ORDER BY created_at DESC, id DESC",
    )
    .all(ownerId) as SessionRow[];
}

export function listClearingSessions(db: SqliteDb): SessionRow[] {
  return db.prepare("SELECT * FROM sessions WHERE status = 'clearing'").all() as SessionRow[];
}

export function listClearedBefore(db: SqliteDb, iso: string): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE status = 'cleared' AND cleared_at IS NOT NULL AND cleared_at < ?")
    .all(iso) as SessionRow[];
}

export function updateSessionStatus(
  db: SqliteDb,
  id: string,
  patch: { status: SessionRow['status']; clearedAt?: string | null },
): void {
  db.prepare('UPDATE sessions SET status = ?, cleared_at = COALESCE(?, cleared_at), updated_at = ? WHERE id = ?').run(
    patch.status,
    patch.clearedAt ?? null,
    nowIso(),
    id,
  );
}

/**
 * [product-polish-w1 T2] 会话级自动批准开关写入（followup.autoApprove 透传落库——
 * 最后写入者胜；不触碰 updated_at：开关变更不是会话内容活动，避免列表排序漂移）。
 */
export function setSessionAutoApprove(db: SqliteDb, id: string, value: boolean): void {
  db.prepare('UPDATE sessions SET auto_approve = ? WHERE id = ?').run(value ? 1 : 0, id);
}

/**
 * [真链复验 P1-G，2026-10-01] 会话改名（session.rename 落库——title 非空由
 * 契约层守门；updated_at 同步推进：改名是会话内容活动）。
 */
export function renameSessionRow(db: SqliteDb, id: string, title: string): void {
  db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), id);
}

export function deleteSessionRow(db: SqliteDb, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- 会话侧引用账本

/** 记一次会话引用（与 blobs.put 的 ref_count 增量一一对应——不去重，防计数漂移）。 */
export function addSessionBlobRef(db: SqliteDb, sessionId: string, blobHash: string): void {
  db.prepare('INSERT INTO session_blob_refs (session_id, blob_hash, created_at) VALUES (?, ?, ?)').run(
    sessionId,
    blobHash,
    nowIso(),
  );
}

export function listSessionBlobRefs(db: SqliteDb, sessionId: string): { blob_hash: string }[] {
  return db
    .prepare('SELECT blob_hash FROM session_blob_refs WHERE session_id = ? ORDER BY created_at, rowid')
    .all(sessionId) as { blob_hash: string }[];
}

export function deleteSessionBlobRefs(db: SqliteDb, sessionId: string): void {
  db.prepare('DELETE FROM session_blob_refs WHERE session_id = ?').run(sessionId);
}

// ---------------------------------------------------------------- 项目状态行（v12）

/** session_projects 行（add-task-stones-manifest-export 0.2——arch-decisions A1）。 */
export interface SessionProjectRow {
  session_id: string;
  revision: number;
  blob_ref: string;
  updated_by_task_id: string;
  updated_at: string;
}

export function getSessionProject(db: SqliteDb, sessionId: string): SessionProjectRow | null {
  const row = db.prepare('SELECT * FROM session_projects WHERE session_id = ?').get(sessionId);
  return (row as SessionProjectRow | undefined) ?? null;
}

/** 全量行（启动补帧恢复扫描面——recoverManifestFrames）。 */
export function listSessionProjects(db: SqliteDb): SessionProjectRow[] {
  return db.prepare('SELECT * FROM session_projects').all() as SessionProjectRow[];
}

/** 初始化（revision 1 起）：UNIQUE 撞=并发他写先到（manifest service 映射 stale）。 */
export function insertSessionProject(db: SqliteDb, row: SessionProjectRow): void {
  db.prepare(
    'INSERT INTO session_projects (session_id, revision, blob_ref, updated_by_task_id, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.session_id, row.revision, row.blob_ref, row.updated_by_task_id, row.updated_at);
}

/**
 * CAS 写（A1：UPDATE ... WHERE revision=?——changes=0 即 stale/他写先到，调用方
 * typed 拒；better-sqlite3 单连接同步事务下读-改-写无交错，WHERE 子句为裁定面
 * 要求的第二道结构性防线）。
 */
export function casUpdateSessionProject(
  db: SqliteDb,
  sessionId: string,
  expectedRevision: number,
  next: { revision: number; blobRef: string; updatedByTaskId: string; updatedAt: string },
): number {
  const result = db
    .prepare(
      'UPDATE session_projects SET revision = ?, blob_ref = ?, updated_by_task_id = ?, updated_at = ? WHERE session_id = ? AND revision = ?',
    )
    .run(next.revision, next.blobRef, next.updatedByTaskId, next.updatedAt, sessionId, expectedRevision);
  return result.changes;
}

/** clear 收尾删行（manifest blob 引用经 session_blob_refs 既有面释放）。 */
export function deleteSessionProject(db: SqliteDb, sessionId: string): void {
  db.prepare('DELETE FROM session_projects WHERE session_id = ?').run(sessionId);
}

// ---------------------------------------------------------------- result 侧引用账本

export function addResultBlobRefs(db: SqliteDb, resultId: string, blobHashes: string[]): void {
  const stmt = db.prepare(
    'INSERT INTO result_blob_refs (result_id, blob_hash, created_at) VALUES (?, ?, ?)',
  );
  for (const hash of blobHashes) stmt.run(resultId, hash, nowIso());
}

export function listResultBlobRefs(db: SqliteDb, resultId: string): { blob_hash: string }[] {
  return db
    .prepare('SELECT blob_hash FROM result_blob_refs WHERE result_id = ? ORDER BY created_at, rowid')
    .all(resultId) as { blob_hash: string }[];
}

export function deleteResultBlobRefs(db: SqliteDb, resultId: string): void {
  db.prepare('DELETE FROM result_blob_refs WHERE result_id = ?').run(resultId);
}

// ---------------------------------------------------------------- cleanup outbox

export function enqueueOutbox(db: SqliteDb, entries: OutboxEntryInput[]): OutboxRow[] {
  const stmt = db.prepare(
    'INSERT INTO cleanup_outbox (id, kind, path, blob_row, session_id, result_id, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
  );
  const rows: OutboxRow[] = [];
  for (const entry of entries) {
    const row: OutboxRow = {
      id: newId(),
      kind: entry.kind,
      path: entry.path,
      blob_row: entry.blob_row ?? null,
      session_id: entry.session_id ?? null,
      result_id: entry.result_id ?? null,
      state: 'pending',
      attempts: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    stmt.run(
      row.id,
      row.kind,
      row.path,
      row.blob_row,
      row.session_id,
      row.result_id,
      row.state,
      row.created_at,
      row.updated_at,
    );
    rows.push(row);
  }
  return rows;
}

export function listOutboxPending(db: SqliteDb): OutboxRow[] {
  return db
    .prepare("SELECT * FROM cleanup_outbox WHERE state = 'pending' ORDER BY created_at, rowid")
    .all() as OutboxRow[];
}

/** 幂等入队守卫：同路径 pending/done 条目已存在则跳过（崩溃重放入队防重复行）。 */
export function outboxHasPath(db: SqliteDb, entryPath: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM cleanup_outbox WHERE path = ? LIMIT 1')
    .get(entryPath);
  return row !== undefined;
}

/** 完成一条：标 done；blob 条目同时终删 blobs 行（文件已 unlink——行保留无意义）。 */
export function completeOutboxEntry(db: SqliteDb, id: string): void {
  const row = db.prepare('SELECT * FROM cleanup_outbox WHERE id = ?').get(id) as OutboxRow | undefined;
  if (!row) return;
  const stmts = [
    db.prepare("UPDATE cleanup_outbox SET state = 'done', updated_at = ? WHERE id = ?"),
  ];
  if (row.kind === 'blob' && row.blob_row) {
    stmts.push(db.prepare('DELETE FROM blobs WHERE row_gen = ? AND status = ?'));
  }
  const finish = db.transaction(() => {
    stmts[0]!.run(nowIso(), id);
    if (row.kind === 'blob' && row.blob_row) stmts[1]!.run(row.blob_row, 'deleting');
  });
  finish();
}

export function failOutboxEntry(db: SqliteDb, id: string): void {
  db.prepare(
    "UPDATE cleanup_outbox SET state = 'failed', attempts = attempts + 1, updated_at = ? WHERE id = ?",
  ).run(nowIso(), id);
}

/** 失败条目回置 pending（启动重放与例行维护的重试面）。 */
export function requeueOutboxEntry(db: SqliteDb, id: string): void {
  db.prepare("UPDATE cleanup_outbox SET state = 'pending', updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function requeueAllFailed(db: SqliteDb): number {
  const result = db
    .prepare("UPDATE cleanup_outbox SET state = 'pending', updated_at = ? WHERE state = 'failed'")
    .run(nowIso());
  return result.changes;
}

/** 会话清理收尾：该会话全部 outbox 条目已处理后，物理删 done 行（表不无限增长）。 */
export function deleteOutboxDoneOfSession(db: SqliteDb, sessionId: string): void {
  db.prepare("DELETE FROM cleanup_outbox WHERE session_id = ? AND state = 'done'").run(sessionId);
}
