/**
 * 契约公共标量与枚举（design §2 账户/§3.5 会话契约的公共依赖）。
 * 正交意图：
 *   [1] 角色值域（admin/user/anonymous——收费升级不改表结构）与任务状态机
 *       （job 与 agent 两族共用传输，状态值域同一套：queued..cancelled）。
 *   [2] 会话生命周期状态（design §6.5：clearing 原子栅栏 + cleared tombstone）。
 *   [3] 通用标量（文本 id、ISO 时间戳、sha256 blobRef）。
 */
import { z } from 'zod';

export const RoleSchema = z.enum(['admin', 'user', 'anonymous']);
export type Role = z.infer<typeof RoleSchema>;

export const TaskStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** tasks.type 两族（design §2：type ∈ {job, agent}——引擎/生成作业 vs agent 会话）。 */
export const TaskKindSchema = z.enum(['job', 'agent']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/** 会话生命周期（design §6.5：clearing=并发栅栏生效；cleared=tombstone，列表过滤）。 */
export const SessionStatusSchema = z.enum(['active', 'clearing', 'cleared']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** 系统内置匿名账号用户名（auth 层约定，契约层声明供两端判断）。 */
export const ANONYMOUS_USERNAME = '__anonymous__';

/** 文本 id：sessions/tasks/results/attempts 等域对象统一字符串主键。 */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** ISO 8601 时间戳（UTC，存库与传输统一格式）。 */
export const IsoDateTimeSchema = z.string().min(1);
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** blob 引用 = sha256 内容寻址（hex 小写 64 位；引用计数与代际物理路径见 daemon BlobStore）。 */
export const BlobRefSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type BlobRef = z.infer<typeof BlobRefSchema>;
