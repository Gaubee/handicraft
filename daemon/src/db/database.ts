/**
 * 数据库连接与迁移执行（zhumo 模式）。
 * 原始需求 2026-09-23（W1.2）：better-sqlite3 打开 <data_root>/handicraft.db，
 * PRAGMA 外键+WAL，按 user_version 顺序应用 MIGRATIONS（重复执行幂等）。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';

export type SqliteDb = Database.Database;

export function openDatabase(dataRoot: string): SqliteDb {
  mkdirSync(dataRoot, { recursive: true });
  const dbPath = path.join(dataRoot, 'handicraft.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** user_version 顺序迁移（已应用版本跳过——重复启动幂等）。 */
export function migrate(db: SqliteDb): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
