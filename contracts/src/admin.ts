/**
 * 后台身份与管理契约（split-admin-portal 波 0 契约冻结——2026-09-29 Owner
 * 前后台分离指令；zhumo api/auth.ts + api/admin.ts 管理模型按贴钻 username 键适配）。
 * 签名冻结：studio 与 daemon 并行开发按本文件对齐，不得偏离。
 * 正交意图：
 *   [1] auth 面：login / refresh / me 三端点（JWT {sub, role}；token 经 WS upgrade
 *       ?token= 进入 context——login 出面 TokenOutput 为唯一例外）。
 *   [2] admin 用户管理：userList / userCreate / userUpdate / userDelete
 *       （键=username；__anonymous__ 三禁与「不能禁用/降级自己」为 daemon 层
 *       typed 拒——schema 不按用户名特判，见 admin.test.ts 矩阵）。
 *   [3] admin 设置：settingsGet / settingsUpdate（allowAnonymous 双层真源投影 +
 *       siteName 新键；update 入面可选字段，get 出面 siteName 未设置时省略——
 *       AdminSettingsOutputSchema 可选字段，见下方注释）。
 */
import { z } from 'zod';
import { IsoDateTimeSchema, RoleSchema } from './common.js';

/** 后台可管理角色（anonymous 不可经 CRUD 建/改——匿名开关走 settings）。 */
export const AdminRoleSchema = z.enum(['admin', 'user']);
export type AdminRole = z.infer<typeof AdminRoleSchema>;

// ---------------------------------------------------------------- auth 面

/** 脱敏用户视图（无 id/口令哈希——username 即键）。 */
export const UserInfoSchema = z.object({
  username: z.string().min(1),
  role: RoleSchema,
});
export type UserInfo = z.infer<typeof UserInfoSchema>;

export const LoginInputSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();
export type LoginInput = z.infer<typeof LoginInputSchema>;

/** 签发结果：token + 过期时刻（epoch ms）+ 用户视图。 */
export const TokenOutputSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.number(),
  user: UserInfoSchema,
});
export type TokenOutput = z.infer<typeof TokenOutputSchema>;

/** refresh 入参：token 缺省复用连接上已携带的 JWT（整体可省——无参调用形态）。 */
export const RefreshInputSchema = z
  .object({
    token: z.string().min(1).optional(),
  })
  .strict()
  .optional();
export type RefreshInput = z.infer<typeof RefreshInputSchema>;

export const RefreshOutputSchema = TokenOutputSchema;
export type RefreshOutput = TokenOutput;

export const MeOutputSchema = UserInfoSchema;
export type MeOutput = UserInfo;

// ---------------------------------------------------------------- admin 用户管理

/** 后台用户行视图（createdAt=ISO；users 表 created_at 同源）。 */
export const AdminUserViewSchema = z.object({
  username: z.string().min(1),
  role: AdminRoleSchema,
  disabled: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type AdminUserView = z.infer<typeof AdminUserViewSchema>;

export const AdminUserListOutputSchema = z.object({
  users: z.array(AdminUserViewSchema),
});
export type AdminUserListOutput = z.infer<typeof AdminUserListOutputSchema>;

export const AdminUserCreateInputSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
    role: AdminRoleSchema,
  })
  .strict();
export type AdminUserCreateInput = z.infer<typeof AdminUserCreateInputSchema>;
export const AdminUserCreateOutputSchema = AdminUserViewSchema;
export type AdminUserCreateOutput = AdminUserView;

/**
 * 更新入面（键=username）：password / role / disabled 至少其一（refine typed 拒
 * 空载荷）。__anonymous__ 三禁（改密/禁用/改角色）与「不能禁用或降级自己」
 * 由 daemon 层按 DB 当前状态 typed 拒（409 域）。
 */
export const AdminUserUpdateInputSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1).optional(),
    role: AdminRoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.password !== undefined || input.role !== undefined || input.disabled !== undefined, {
    message: 'password / role / disabled 至少提供一项',
  });
export type AdminUserUpdateInput = z.infer<typeof AdminUserUpdateInputSchema>;
export const AdminUserUpdateOutputSchema = AdminUserViewSchema;
export type AdminUserUpdateOutput = AdminUserView;

/**
 * 删除用户（硬删除=级联清理：会话/任务/资源/blob 引用账本/users 行+磁盘任务与
 * bundle 目录——daemon 层实现）。__anonymous__ 与当前登录管理员自己不可删
 * （daemon 层 typed 拒）。
 */
export const AdminUserDeleteInputSchema = z
  .object({
    username: z.string().min(1),
  })
  .strict();
export type AdminUserDeleteInput = z.infer<typeof AdminUserDeleteInputSchema>;
export const AdminUserDeleteOutputSchema = z.object({ ok: z.boolean() });
export type AdminUserDeleteOutput = z.infer<typeof AdminUserDeleteOutputSchema>;

// ---------------------------------------------------------------- admin 设置

/**
 * 设置键白名单（split-admin-portal 1.2）：allowAnonymous=匿名开关（settings 表
 * allow_anonymous 既有键，'1'/'0'）；siteName=站点名（settings 表 site_name 新键）。
 */
export const SETTING_SITE_NAME = 'site_name';

/** update 入面：可选字段（至少可全缺——键级写语义，非空载荷校验由端点按需收口）。 */
export const AdminSettingsSchema = z
  .object({
    allowAnonymous: z.boolean().optional(),
    siteName: z.string().min(1).optional(),
  })
  .strict();
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export const AdminSettingsUpdateInputSchema = AdminSettingsSchema;
export type AdminSettingsUpdateInput = AdminSettings;

/**
 * get 出面：allowAnonymous 全字段；siteName 可选（split-admin-portal 波 5 P1-1：
 * 新实例无 site_name 键时 daemon 省略字段——此前空串出门撞 update 入面 min(1)
 * 语义的读面守门（adminApi 曾以 AdminSettingsSchema 守 get），settingsGet 整包
 * 被拒 → AdminPage 整体不可用。可选字段=「未设置」的一等表达）。
 */
export const AdminSettingsOutputSchema = z.object({
  allowAnonymous: z.boolean(),
  siteName: z.string().optional(),
});
export type AdminSettingsOutput = z.infer<typeof AdminSettingsOutputSchema>;
