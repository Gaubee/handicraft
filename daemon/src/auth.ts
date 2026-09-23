/**
 * 认证域（design §2 账户行：zhumo 模式 + 贴钻变体 allow_anonymous 默认开）。
 * 原始需求 2026-09-23（W1.2）：`__anonymous__` 幂等自愈用户行 + JWT{sub,role} 签发
 * 校验 + admin 经 .env ADMIN_* 启动幂等 upsert（唯一建号流程——轮换=改 .env 重启）。
 * 正交意图：
 *   [1] scrypt 口令哈希（`scrypt$salt$hash`，timingSafeEqual 校验）。
 *   [2] JWT 签发与校验（jose HS256，7 天过期）。
 *   [3] 匿名账号保障：__anonymous__ 行幂等自愈（被删后下次登录重建）；
 *       allow_anonymous 默认**开**（Owner 裁决默认单账户——与 zhumo 安全默认相反）。
 *   [4] admin upsert：ADMIN_* 双键齐备时启动收敛（缺失建行；密码漂移重哈希）。
 *   [5] token → 用户行鉴权（禁写不禁读——disabled 用户 token 仍可认证）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ANONYMOUS_USERNAME, type Role } from '@handicraft/contracts';
import type { AppConfig } from './config.js';
import type { SqliteDb } from './db/database.js';
import {
  createUser,
  getUserByUsername,
  getUserById,
  putSetting,
  updateUserPassword,
  type UserRow,
} from './db/store.js';

const SCRYPT_KEYLEN = 32;
const JWT_TTL_SECONDS = 7 * 24 * 3600;
export const SETTING_ALLOW_ANONYMOUS = 'allow_anonymous';

// ---------------------------------------------------------------- scrypt

/** 哈希格式 `scrypt$<salt hex>$<hash hex>`（N=16384, r=8, p=1）。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] ?? '', 'hex');
  const expected = Buffer.from(parts[2] ?? '', 'hex');
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- jwt

export interface TokenClaims {
  sub: string;
  role: Role;
}

/** 签发 HS256 JWT（载荷 {sub, role}）；返回 token 与过期时刻（epoch ms）。 */
export async function signJwt(
  secret: string,
  claims: TokenClaims,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + JWT_TTL_SECONDS * 1000;
  const key = new TextEncoder().encode(secret);
  const token = await new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(key);
  return { token, expiresAt };
}

/** 校验失败（签名/过期/形状）返回 null，不抛异常。 */
export async function verifyJwt(secret: string, token: string): Promise<TokenClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    const sub = payload.sub;
    const role = payload['role'];
    if (typeof sub !== 'string' || typeof role !== 'string') return null;
    if (role !== 'admin' && role !== 'user' && role !== 'anonymous') return null;
    return { sub, role };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- anonymous

/**
 * 匿名开关（双层真源：settings.allow_anonymous 优先，.env ALLOW_ANONYMOUS 兜底）。
 * **默认开**（Owner 裁决默认单账户——两层均未显式关闭即放行）。
 */
export function isAllowAnonymous(db: SqliteDb, envDefault = true): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_ALLOW_ANONYMOUS) as
    | { value: string }
    | undefined;
  if (row?.value === '1') return true;
  if (row?.value === '0') return false;
  return envDefault;
}

export function setAllowAnonymous(db: SqliteDb, allowed: boolean): void {
  putSetting(db, SETTING_ALLOW_ANONYMOUS, allowed ? '1' : '0');
}

/** 内置匿名账号不存在则创建（幂等；被删除后自愈——不可改密/提权/删除由上层守卫）。 */
export function ensureAnonymousUser(db: SqliteDb): UserRow {
  const existing = getUserByUsername(db, ANONYMOUS_USERNAME);
  if (existing) return existing;
  return createUser(db, {
    username: ANONYMOUS_USERNAME,
    // 随机不可知口令：匿名行不可用口令登录（认证入口只有匿名签发路径）
    passwordHash: hashPassword(randomBytes(24).toString('hex')),
    role: 'anonymous',
  });
}

// ---------------------------------------------------------------- admin upsert

export interface AdminUpsertResult {
  created: boolean;
  /** .env 口令与库内哈希不一致时的重哈希（轮换=改 .env 重启） */
  rotated: boolean;
  user: UserRow;
}

/**
 * .env ADMIN_* 启动幂等 upsert（唯一建号流程）：双键齐备才执行；行缺失建 admin；
 * 口令不匹配重哈希（收敛）；同名非 admin 行不动（防提权——报告偏移，罕见配置错误）。
 */
export function ensureAdminUser(
  db: SqliteDb,
  config: Pick<AppConfig, 'adminUsername' | 'adminPassword'>,
): AdminUpsertResult | null {
  if (!config.adminUsername || !config.adminPassword) return null;
  const existing = getUserByUsername(db, config.adminUsername);
  if (!existing) {
    const user = createUser(db, {
      username: config.adminUsername,
      passwordHash: hashPassword(config.adminPassword),
      role: 'admin',
    });
    return { created: true, rotated: false, user };
  }
  if (existing.role !== 'admin') {
    // 同名非 admin 行：不静默提权——返回现状交由启动装配告警。
    return { created: false, rotated: false, user: existing };
  }
  if (!verifyPassword(config.adminPassword, existing.password_hash)) {
    updateUserPassword(db, existing.id, hashPassword(config.adminPassword));
    return { created: false, rotated: true, user: { ...existing, password_hash: '' } };
  }
  return { created: false, rotated: false, user: existing };
}

// ---------------------------------------------------------------- 鉴权入口

/**
 * token → 有效用户行；签名无效、用户缺失一律 null。
 * 禁用语义=禁写不禁读（zhumo BUG5 同款）：disabled 用户 token 仍可认证，
 * 写操作由上层 requireActiveUser 拦截。
 */
export async function authenticate(
  secret: string,
  db: SqliteDb,
  token: string | null | undefined,
): Promise<UserRow | null> {
  if (!token) return null;
  const claims = await verifyJwt(secret, token);
  if (!claims) return null;
  const user = getUserById(db, claims.sub);
  if (!user) return null;
  return user;
}
