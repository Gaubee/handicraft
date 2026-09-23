/**
 * db 单测（W1.2 任务门）：user_version 迁移框架 + 十表 DDL 落库 + 迁移幂等 +
 * P1-6② attempts active partial unique index（同 op 单 active / 并发 claim 仲裁）。
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDb } from './db/database.js';
import { MIGRATIONS } from './db/schema.js';

const dbs: { db: SqliteDb; dir: string }[] = [];
function tempDb(): SqliteDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'handicraft-db-'));
  const db = openDatabase(dir);
  dbs.push({ db, dir });
  return db;
}
afterEach(() => {
  for (const { db, dir } of dbs.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const TEN_TABLES = [
  'users',
  'settings',
  'blobs',
  'resources',
  'tasks',
  'results',
  'patch_history',
  'grants',
  'approved_ops',
  'attempts',
];

describe('user_version 迁移框架', () => {
  it('首启：全部迁移应用，user_version=最新版', () => {
    const db = tempDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS[MIGRATIONS.length - 1].version,
    );
  });
  it('重复启动迁移幂等（migrate 再跑无错、版本不变、表不重建丢数据）', () => {
    const db = tempDb();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, disabled) VALUES ('u1', 'keep', 'h', 'user', ?, 0)",
    ).run(new Date().toISOString());
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS[MIGRATIONS.length - 1].version,
    );
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get('u1');
    expect(row).toEqual({ username: 'keep' });
  });
});

describe('十表 DDL 落库', () => {
  it('核心六表 + 授权四表全部存在', () => {
    const db = tempDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const table of TEN_TABLES) expect(names).toContain(table);
  });
  it('tasks.type 只收 job/agent；session_id 列在位', () => {
    const db = tempDb();
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('type');
    expect(colNames).toContain('session_id');
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, disabled) VALUES ('u', 'n', 'h', 'anonymous', ?, 0)",
    ).run(new Date().toISOString());
    db.prepare(
      "INSERT INTO tasks (id, owner_id, session_id, type, status, created_at, updated_at) VALUES ('t1', 'u', 's1', 'agent', 'queued', ?, ?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    expect(() =>
      db.prepare(
        "INSERT INTO tasks (id, owner_id, type, status, created_at, updated_at) VALUES ('t2', 'u', 'cron', 'queued', ?, ?)",
      ).run(new Date().toISOString(), new Date().toISOString()),
    ).toThrow();
  });
  it('attempts 两唯一约束生效（proposalId+attemptNo / retryRequestId）', () => {
    const db = tempDb();
    const now = new Date().toISOString();
    // 状态参数化：历史行用终态（succeeded）避开 P1-6② active partial unique 占位
    const insert = (attemptId: string, proposalId: string, no: number, rr: string, state = 'succeeded') =>
      db
        .prepare(
          'INSERT INTO attempts (attempt_id, proposal_id, attempt_no, idem_key, retry_request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(attemptId, proposalId, no, `idem-${no}-${attemptId}`, rr, state, now, now);
    insert('a1', 'p1', 1, 'rr-1');
    // proposalId+attemptNo 撞 → 拒（即使前者已终态）
    expect(() => insert('a2', 'p1', 1, 'rr-2')).toThrow();
    // retryRequestId 撞（即使 attemptNo 不同）→ 拒
    expect(() => insert('a3', 'p1', 2, 'rr-1')).toThrow();
    // 合法新行（同 op 新 attemptNo，终态互不占位）
    insert('a4', 'p1', 2, 'rr-4');
    // 跨归属复用同一 retryRequestId 必拒（§3.6 R6：绑定 owner/session/proposal）
    expect(() => insert('a5', 'p2', 1, 'rr-1')).toThrow();
  });
  it('approved_ops.proposalId 唯一（幂等键）', () => {
    const db = tempDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, disabled) VALUES ('u', 'n', 'h', 'anonymous', ?, 0)",
    ).run(now);
    const insert = (p: string) =>
      db
        .prepare(
          "INSERT INTO approved_ops (proposal_id, task_id, user_id, tool, op_digest, state, created_at, updated_at) VALUES (?, 't', 'u', 'studio.generate', 'd', 'approved', ?, ?)",
        )
        .run(p, now, now);
    insert('p1');
    expect(() => insert('p1')).toThrow();
  });
  it('P1-6② 同 op 仅一个 active attempt：partial unique index（claimed/running 占位，终态放行重试）', () => {
    const db = tempDb();
    const now = new Date().toISOString();
    const insert = (attemptId: string, proposalId: string, no: number, state: string) =>
      db
        .prepare(
          'INSERT INTO attempts (attempt_id, proposal_id, attempt_no, idem_key, retry_request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(attemptId, proposalId, no, `idem-${attemptId}`, `rr-${attemptId}`, state, now, now);
    // 首个 active（claimed）占位成功
    insert('a1', 'p1', 1, 'claimed');
    // 第二个 active（running）同 op → 唯一索引拒绝
    expect(() => insert('a2', 'p1', 2, 'running')).toThrow();
    expect(() => insert('a3', 'p1', 3, 'claimed')).toThrow();
    // 终态不占位：succeeded 后可开新 active attempt（重试语义）
    db.prepare("UPDATE attempts SET state = 'succeeded' WHERE attempt_id = 'a1'").run();
    insert('a4', 'p1', 2, 'claimed'); // 新 active 放行
    // failed/unknown 终态同理放行
    db.prepare("UPDATE attempts SET state = 'failed' WHERE attempt_id = 'a4'").run();
    insert('a5', 'p1', 3, 'running');
    // 不同 op 各自一个 active 互不冲突
    insert('a6', 'p2', 1, 'claimed');
  });
  it('P1-6② 并发两 claim 仅一成功：双连接同库竞争（WAL 真实并发形态）', () => {
    const db = tempDb();
    const now = new Date().toISOString();
    // 第二连接（并发 claim 的另一持有者）——同库文件、独立句柄
    const db2 = new Database(db.name as string, { fileMustExist: true });
    dbs.push({ db: db2, dir: db.name as string });
    const claim = (conn: SqliteDb, attemptId: string) =>
      conn
        .prepare(
          "INSERT INTO attempts (attempt_id, proposal_id, attempt_no, idem_key, retry_request_id, state, created_at, updated_at) VALUES (?, 'race-p', 1, ?, ?, 'claimed', ?, ?)",
        )
        .run(attemptId, `idem-${attemptId}`, `rr-${attemptId}`, now, now);
    // 并发两 claim（两连接对同一 proposal 发起——唯一索引仲裁）
    claim(db, 'c1');
    let secondSucceeded = false;
    try {
      claim(db2, 'c2');
      secondSucceeded = true;
    } catch {
      secondSucceeded = false;
    }
    expect(secondSucceeded).toBe(false); // 仅一个 active claim 存活
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE proposal_id = 'race-p' AND state IN ('claimed','running')")
      .get() as { n: number };
    expect(active.n).toBe(1);
  });
  it('blobs 代际行模型：row_gen 主键 + status 值域', () => {
    const db = tempDb();
    const cols = db.prepare('PRAGMA table_info(blobs)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('row_gen');
    expect(cols.map((c) => c.name)).toContain('status');
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO blobs (row_gen, hash, size, store_path, ref_count, status, created_at) VALUES ('g1', 'h1', 1, 'h1/g1', 1, 'active', ?)",
    ).run(now);
    expect(() =>
      db.prepare(
        "INSERT INTO blobs (row_gen, hash, size, store_path, ref_count, status, created_at) VALUES ('g2', 'h1', 1, 'h1/g2', 1, 'gone', ?)",
      ).run(now),
    ).toThrow();
  });
});
