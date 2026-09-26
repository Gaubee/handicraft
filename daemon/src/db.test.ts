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

describe('stone_index 迁移 v5（add-stone-library §1.5）', () => {
  it('v5 应用：表+三索引在位，user_version=MIGRATIONS 末版', () => {
    const db = tempDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS[MIGRATIONS.length - 1].version,
    );
    // v5 已应用即可（硬编码 5 在 v6+ 误红——W10 后端段 stash 实证既有失败）
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(5);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stone_index'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('stone_index');
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stone_index'")
      .all() as { name: string }[];
    const indexNames = indexes.map((r) => r.name);
    for (const idx of ['idx_stone_family', 'idx_stone_size', 'idx_stone_supplier']) {
      expect(indexNames).toContain(idx);
    }
  });
  it('列面：supplier/sku/style_row/family/size_mm/color_hex/trashed 等落位；size_mm 可空（S0 契约 nullable 镜像）', () => {
    const db = tempDb();
    const cols = db.prepare('PRAGMA table_info(stone_index)').all() as { name: string; notnull: number }[];
    const colNames = cols.map((c) => c.name);
    for (const col of [
      'resource_id', 'owner_id', 'supplier', 'sku', 'style_row', 'style_name',
      'family', 'size_mm', 'color_hex', 'finish', 'trashed', 'updated_at',
    ]) {
      expect(colNames).toContain(col);
    }
    // size_mm 允许 NULL（StoneFile.sizeMm nullable——§8.1 规则 7 无尺寸声明不猜测）
    const sizeCol = cols.find((c) => c.name === 'size_mm');
    expect(sizeCol?.notnull).toBe(0);
    const trashedCol = cols.find((c) => c.name === 'trashed');
    expect(trashedCol?.notnull).toBe(1);
  });
  it('UNIQUE(supplier,sku) 生效：同对二插必拒；跨供应商同 sku 放行', () => {
    const db = tempDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, disabled) VALUES ('u', 'n', 'h', 'admin', ?, 0)",
    ).run(now);
    const insertResource = (id: string) =>
      db.prepare(
        "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, revision, created_at, updated_at) VALUES (?, 'u', NULL, ?, 1, 1, ?, ?)",
      ).run(id, id, now, now);
    insertResource('r1');
    insertResource('r2');
    insertResource('r3');
    const insertIndex = (rid: string, supplier: string, sku: string, sizeMm: number | null) =>
      db
        .prepare(
          "INSERT INTO stone_index (resource_id, owner_id, supplier, sku, family, size_mm, color_hex, trashed, updated_at) VALUES (?, 'u', ?, ?, '白色系', ?, '#FFFFFF', 0, ?)",
        )
        .run(rid, supplier, sku, sizeMm, now);
    insertIndex('r1', 'yuhang', 'J51', 2);
    insertIndex('r2', 'factoryB', 'J51', null); // 跨供应商同 sku 合法 + size_mm NULL 合法
    expect(() => insertIndex('r3', 'yuhang', 'J51', 3)).toThrow();
  });
  it('resource_id 外键生效：引用不存在 resources 行必拒（foreign_keys=ON）', () => {
    const db = tempDb();
    const now = new Date().toISOString();
    expect(() =>
      db.prepare(
        "INSERT INTO stone_index (resource_id, owner_id, supplier, sku, family, color_hex, trashed, updated_at) VALUES ('ghost', 'u', 'yuhang', 'J51', '白色系', '#FFFFFF', 0, ?)",
      ).run(now),
    ).toThrow();
  });
});

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
    // 跨连接两 claim（顺序发起——真并发提交时同样由唯一索引原子仲裁；本用例证明跨连接可见性）
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
