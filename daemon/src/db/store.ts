/**
 * users/settings 行存取面（zhumo store 模式——查询语句集中于此，auth/http 只消费视图）。
 * 正交意图：
 *   [1] users：按用户名/ID 查取、创建、改密、禁用。
 *   [2] settings：键值读写（allow_anonymous 等运行开关——双层真源的 DB 层）。
 */
import { randomUUID } from 'node:crypto';
import type { Role } from '@handicraft/contracts';
import type { SqliteDb } from './database.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
  disabled: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function getUserByUsername(db: SqliteDb, username: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return (row as UserRow | undefined) ?? null;
}

export function getUserById(db: SqliteDb, id: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return (row as UserRow | undefined) ?? null;
}

export function listUsers(db: SqliteDb): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

export function createUser(
  db: SqliteDb,
  input: { username: string; passwordHash: string; role: Role },
): UserRow {
  const row: UserRow = {
    id: newId(),
    username: input.username,
    password_hash: input.passwordHash,
    role: input.role,
    created_at: nowIso(),
    disabled: 0,
  };
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, created_at, disabled) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.username, row.password_hash, row.role, row.created_at, row.disabled);
  return row;
}

export function updateUserPassword(db: SqliteDb, id: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

export function setUserDisabled(db: SqliteDb, id: string, disabled: boolean): void {
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
}

export function deleteUserRow(db: SqliteDb, id: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- settings

export function getSetting(db: SqliteDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function putSetting(db: SqliteDb, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
