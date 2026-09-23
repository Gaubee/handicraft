/**
 * auth 单测（W1.2 任务门）：匿名行自愈、JWT 往返/篡改、allow_anonymous 默认开、
 * admin upsert 幂等与口令轮换、禁用用户 token 仍可认证（禁写不禁读）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ANONYMOUS_USERNAME } from '@handicraft/contracts';
import {
  authenticate,
  ensureAdminUser,
  ensureAnonymousUser,
  hashPassword,
  isAllowAnonymous,
  setAllowAnonymous,
  signJwt,
  verifyJwt,
  verifyPassword,
} from './auth.js';
import { openDatabase, type SqliteDb } from './db/database.js';
import { deleteUserRow, getUserByUsername } from './db/store.js';

const dbs: { db: SqliteDb; dir: string }[] = [];
function tempDb(): SqliteDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'handicraft-auth-'));
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

describe('匿名行自愈', () => {
  it('首次创建 role=anonymous；重复 ensure 幂等（同一行）；删除后自愈重建', () => {
    const db = tempDb();
    const first = ensureAnonymousUser(db);
    expect(first.username).toBe(ANONYMOUS_USERNAME);
    expect(first.role).toBe('anonymous');
    const again = ensureAnonymousUser(db);
    expect(again.id).toBe(first.id);
    deleteUserRow(db, first.id);
    const healed = ensureAnonymousUser(db);
    expect(healed.id).not.toBe(first.id);
    expect(healed.role).toBe('anonymous');
  });
  it('匿名口令为随机不可知值（verifyPassword 对随机串必假——不可口令登录）', () => {
    const db = tempDb();
    const user = ensureAnonymousUser(db);
    expect(verifyPassword('admin123', user.password_hash)).toBe(false);
    expect(verifyPassword('', user.password_hash)).toBe(false);
  });
});

describe('JWT 签发与校验', () => {
  it('往返 {sub, role}；篡改/换密钥/垃圾 token 拒绝', async () => {
    const db = tempDb();
    const user = ensureAnonymousUser(db);
    const { token } = await signJwt('secret-1', { sub: user.id, role: user.role });
    const claims = await verifyJwt('secret-1', token);
    expect(claims).toEqual({ sub: user.id, role: 'anonymous' });
    expect(await verifyJwt('secret-2', token)).toBeNull();
    expect(await verifyJwt('secret-1', `${token}x`)).toBeNull();
    expect(await verifyJwt('secret-1', 'garbage')).toBeNull();
  });
  it('authenticate：有效 token → 用户行；用户被删 → null', async () => {
    const db = tempDb();
    const user = ensureAnonymousUser(db);
    const { token } = await signJwt('s', { sub: user.id, role: user.role });
    expect((await authenticate('s', db, token))?.id).toBe(user.id);
    deleteUserRow(db, user.id);
    expect(await authenticate('s', db, token)).toBeNull();
    expect(await authenticate('s', db, null)).toBeNull();
  });
  it('禁用用户 token 仍可认证（禁写不禁读——写拦截归上层）', async () => {
    const db = tempDb();
    const user = ensureAnonymousUser(db);
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
    const { token } = await signJwt('s', { sub: user.id, role: user.role });
    const authed = await authenticate('s', db, token);
    expect(authed?.id).toBe(user.id);
    expect(authed?.disabled).toBe(1);
  });
});

describe('allow_anonymous 双层真源（默认开）', () => {
  it('无 settings 键 → envDefault；' + "'1'/'0' 显式覆盖", () => {
    const db = tempDb();
    expect(isAllowAnonymous(db, true)).toBe(true);
    expect(isAllowAnonymous(db, false)).toBe(false);
    setAllowAnonymous(db, true);
    expect(isAllowAnonymous(db, false)).toBe(true);
    setAllowAnonymous(db, false);
    expect(isAllowAnonymous(db, true)).toBe(false);
  });
});

describe('admin upsert（.env 唯一建号流程）', () => {
  it('ADMIN_* 齐备：首启创建；重启幂等（同行）；改 .env 口令 → 轮换收敛', () => {
    const db = tempDb();
    const cfg = { adminUsername: 'boss', adminPassword: 'p1' };
    const first = ensureAdminUser(db, cfg);
    expect(first?.created).toBe(true);
    expect(first?.user.role).toBe('admin');
    const again = ensureAdminUser(db, cfg);
    expect(again?.created).toBe(false);
    expect(again?.rotated).toBe(false);
    // 轮换：.env 改口令重启 → 哈希更新
    const rotated = ensureAdminUser(db, { adminUsername: 'boss', adminPassword: 'p2' });
    expect(rotated?.rotated).toBe(true);
    const row = getUserByUsername(db, 'boss');
    expect(row && verifyPassword('p2', row.password_hash)).toBe(true);
  });
  it('ADMIN_* 缺任一键：不建号（null）', () => {
    const db = tempDb();
    expect(ensureAdminUser(db, { adminUsername: 'boss', adminPassword: '' })).toBeNull();
    expect(ensureAdminUser(db, { adminUsername: '', adminPassword: 'p' })).toBeNull();
  });
  it('同名非 admin 行：不静默提权', () => {
    const db = tempDb();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, disabled) VALUES ('u1', 'dup', ?, 'user', ?, 0)",
    ).run(hashPassword('x'), new Date().toISOString());
    const result = ensureAdminUser(db, { adminUsername: 'dup', adminPassword: 'p' });
    expect(result?.created).toBe(false);
    expect(result?.user.role).toBe('user');
  });
});
