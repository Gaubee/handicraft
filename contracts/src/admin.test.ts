/**
 * admin 契约测试（split-admin-portal 波 0/0.3+0.4——typed 拒/放行矩阵）。
 * 冻结签名逐字段断言：studio/daemon 并行开发的单源对齐面。账号语义的
 * daemon 层拒面（__anonymous__ 三禁/不能禁用降级自己/删除级联）不在 schema
 * 层特判——本文件显式断言 schema 对 __anonymous__ 保持中立（防误加特判），
 * 行为拒面归 daemon 集成测试（tests/admin-portal-rpc.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import {
  AdminRoleSchema,
  AdminSettingsOutputSchema,
  AdminSettingsSchema,
  AdminUserCreateInputSchema,
  AdminUserDeleteInputSchema,
  AdminUserListOutputSchema,
  AdminUserUpdateInputSchema,
  AdminUserViewSchema,
  LoginInputSchema,
  MeOutputSchema,
  RefreshInputSchema,
  RefreshOutputSchema,
  TokenOutputSchema,
  UserInfoSchema,
} from './admin.js';

describe('auth 面（0.3 冻结签名）', () => {
  it('LoginInput：放行非空 username/password；拒空串与多余字段', () => {
    expect(LoginInputSchema.safeParse({ username: 'boss', password: 'p' }).success).toBe(true);
    expect(LoginInputSchema.safeParse({ username: '', password: 'p' }).success).toBe(false);
    expect(LoginInputSchema.safeParse({ username: 'boss', password: '' }).success).toBe(false);
    expect(LoginInputSchema.safeParse({ username: 'boss' }).success).toBe(false);
    expect(LoginInputSchema.safeParse({ username: 'boss', password: 'p', extra: 1 }).success).toBe(false);
  });

  it('UserInfo：role 三值放行；拒未知角色', () => {
    for (const role of ['admin', 'user', 'anonymous'] as const) {
      expect(UserInfoSchema.safeParse({ username: 'a', role }).success).toBe(true);
    }
    expect(UserInfoSchema.safeParse({ username: 'a', role: 'superuser' }).success).toBe(false);
    expect(UserInfoSchema.safeParse({ username: '', role: 'admin' }).success).toBe(false);
    expect(UserInfoSchema.safeParse({ role: 'admin' }).success).toBe(false);
  });

  it('TokenOutput/RefreshOutput/MeOutput：形状往返（camelCase expiresAt）；缺字段/类型错拒', () => {
    const token = {
      token: 'jwt-three-parts',
      expiresAt: Date.now() + 1000,
      user: { username: 'boss', role: 'admin' as const },
    };
    expect(TokenOutputSchema.parse(token)).toEqual(token);
    expect(RefreshOutputSchema.parse(token)).toEqual(token);
    expect(MeOutputSchema.parse({ username: 'boss', role: 'admin' })).toEqual({
      username: 'boss',
      role: 'admin',
    });
    expect(TokenOutputSchema.safeParse({ token: 't', user: token.user }).success).toBe(false);
    expect(
      TokenOutputSchema.safeParse({ token: 't', expiresAt: 'soon', user: token.user }).success,
    ).toBe(false);
  });

  it('RefreshInput：无参/空对象/带 token 三形态放行（token 缺省复用连接凭证）', () => {
    expect(RefreshInputSchema.safeParse(undefined).success).toBe(true);
    expect(RefreshInputSchema.safeParse({}).success).toBe(true);
    expect(RefreshInputSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(RefreshInputSchema.safeParse({ token: '' }).success).toBe(false);
    expect(RefreshInputSchema.safeParse({ token: 'abc', other: 1 }).success).toBe(false);
  });
});

describe('admin 用户管理（0.3 冻结签名）', () => {
  it('AdminRole：admin/user 放行；anonymous 拒（匿名开关走 settings）', () => {
    expect(AdminRoleSchema.safeParse('admin').success).toBe(true);
    expect(AdminRoleSchema.safeParse('user').success).toBe(true);
    expect(AdminRoleSchema.safeParse('anonymous').success).toBe(false);
  });

  it('AdminUserView/List：放行完整行；role=anonymous 拒（列表不含匿名行）', () => {
    const view = {
      username: 'worker',
      role: 'user' as const,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    expect(AdminUserViewSchema.parse(view)).toEqual(view);
    expect(
      AdminUserViewSchema.safeParse({ ...view, role: 'anonymous' as unknown as string }).success,
    ).toBe(false);
    expect(
      AdminUserViewSchema.safeParse({ username: 'w', role: 'user', disabled: 'yes', createdAt: 'x' })
        .success,
    ).toBe(false);
    expect(AdminUserListOutputSchema.parse({ users: [view] }).users).toHaveLength(1);
  });

  it('AdminUserCreate：放行 admin/user；拒匿名角色/空 username/空 password/多余字段', () => {
    expect(
      AdminUserCreateInputSchema.safeParse({ username: 'w', password: 'p', role: 'user' }).success,
    ).toBe(true);
    expect(
      AdminUserCreateInputSchema.safeParse({ username: 'w', password: 'p', role: 'admin' }).success,
    ).toBe(true);
    expect(
      AdminUserCreateInputSchema.safeParse({ username: 'w', password: 'p', role: 'anonymous' })
        .success,
    ).toBe(false);
    expect(
      AdminUserCreateInputSchema.safeParse({ username: '', password: 'p', role: 'user' }).success,
    ).toBe(false);
    expect(
      AdminUserCreateInputSchema.safeParse({ username: 'w', password: '', role: 'user' }).success,
    ).toBe(false);
    expect(
      AdminUserCreateInputSchema.safeParse({ username: 'w', password: 'p', role: 'user', disabled: true })
        .success,
    ).toBe(false);
  });

  it('AdminUserUpdate：单字段/多字段放行；空载荷拒（至少一字段）；空 password 拒；多余字段拒', () => {
    expect(AdminUserUpdateInputSchema.safeParse({ username: 'w', disabled: true }).success).toBe(true);
    expect(AdminUserUpdateInputSchema.safeParse({ username: 'w', role: 'admin' }).success).toBe(true);
    expect(AdminUserUpdateInputSchema.safeParse({ username: 'w', password: 'np' }).success).toBe(true);
    expect(
      AdminUserUpdateInputSchema.safeParse({ username: 'w', password: 'np', role: 'user', disabled: false })
        .success,
    ).toBe(true);
    // 空载荷：无 password/role/disabled 任一字段 → typed 拒
    expect(AdminUserUpdateInputSchema.safeParse({ username: 'w' }).success).toBe(false);
    expect(AdminUserUpdateInputSchema.safeParse({ username: 'w', password: '' }).success).toBe(false);
    expect(
      AdminUserUpdateInputSchema.safeParse({ username: 'w', role: 'anonymous' as unknown as string })
        .success,
    ).toBe(false);
    expect(
      AdminUserUpdateInputSchema.safeParse({ username: 'w', disabled: true, createdAt: '2026' }).success,
    ).toBe(false);
  });

  it('__anonymous__ 三禁属 daemon 层：schema 对保留用户名保持中立（防误加特判）', () => {
    // 契约只管形状——__anonymous__ 的改密/禁用/改角色/删除拒面由 daemon 按 DB 状态
    // typed 拒（409 域），见 tests/admin-portal-rpc.test.ts。此处钉住「schema 不特判」。
    expect(
      AdminUserUpdateInputSchema.safeParse({ username: '__anonymous__', disabled: true }).success,
    ).toBe(true);
    expect(AdminUserDeleteInputSchema.safeParse({ username: '__anonymous__' }).success).toBe(true);
  });

  it('AdminUserDelete：放行非空 username；拒空串/缺字段/多余字段', () => {
    expect(AdminUserDeleteInputSchema.safeParse({ username: 'w' }).success).toBe(true);
    expect(AdminUserDeleteInputSchema.safeParse({ username: '' }).success).toBe(false);
    expect(AdminUserDeleteInputSchema.safeParse({}).success).toBe(false);
    expect(AdminUserDeleteInputSchema.safeParse({ username: 'w', force: true }).success).toBe(false);
  });
});

describe('admin 设置（0.3 冻结签名）', () => {
  it('AdminSettings update 入面：空对象/单字段/双字段放行；siteName 空串拒；多余字段拒', () => {
    expect(AdminSettingsSchema.safeParse({}).success).toBe(true);
    expect(AdminSettingsSchema.safeParse({ allowAnonymous: true }).success).toBe(true);
    expect(AdminSettingsSchema.safeParse({ siteName: '贴钻工作台' }).success).toBe(true);
    expect(
      AdminSettingsSchema.safeParse({ allowAnonymous: false, siteName: '贴钻' }).success,
    ).toBe(true);
    expect(AdminSettingsSchema.safeParse({ siteName: '' }).success).toBe(false);
    expect(AdminSettingsSchema.safeParse({ allowAnonymous: 'yes' }).success).toBe(false);
    expect(AdminSettingsSchema.safeParse({ llmModel: 'x' }).success).toBe(false);
  });

  it('AdminSettingsOutput get 出面：全字段必填（allowAnonymous+siteName）；缺字段/类型错拒', () => {
    expect(AdminSettingsOutputSchema.parse({ allowAnonymous: false, siteName: '' })).toEqual({
      allowAnonymous: false,
      siteName: '',
    });
    expect(AdminSettingsOutputSchema.safeParse({ allowAnonymous: false }).success).toBe(false);
    expect(AdminSettingsOutputSchema.safeParse({ siteName: 'x' }).success).toBe(false);
    expect(
      AdminSettingsOutputSchema.safeParse({ allowAnonymous: 1, siteName: 'x' }).success,
    ).toBe(false);
  });
});
