/**
 * writer CAS fence（design §6.5 R3——W3 评审 P1-1/P1-3 修复的共用判定单点）。
 * 原始需求 2026-09-23：帧 writer（emitFrame）、任务产物 blob writer（putTaskArtifact）、
 * 分享包 writer（createShareBundle）、会话 blob writer（acquireSessionBlobRef）共用
 * 同一「session/task 仍可写」判定——fence 于 session.status、task 行存在性/归属，
 * 及（W3 R2 起）task.status!=='cancelled'。
 * 单线程同步块内校验与写入间不存在交错窗口；跨介质的第二道保险由代际行模型承担。
 * 正交意图：
 *   [1] ArtifactFenceError：fence 拒绝的显式错误类型（runner 静默收敛 vs 其他错误上抛）。
 *   [2] taskWriterAllowed/assertTaskWritable：task 行存在 +（若属会话）session active。
 */
import { getTaskById } from './db/jobs.js';
import { getSessionById } from './db/sessions.js';
import type { SqliteDb } from './db/database.js';

/** fence 拒绝（会话清理中/已清理/任务行已删）——非故障，runner 收敛不该写 error 帧。 */
export class ArtifactFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactFenceError';
  }
}

/**
 * fence 判定（§6.5 R3；W3 R2 起含 task 取消态）：task 行存在且 status!=='cancelled'，
 * 且（若属会话）session.status==='active'。与 JobService.emitFrame 的帧 fence 同
 * 谓词——帧/产物/blob 三类 writer 一致。cancelled 拒绝：取消后迟到 runner 不得再写
 * 任何产物（R2 探针——取消但行尚存的 putTaskArtifact 漏洞）；帧面同拒与 engine
 * 终态语义一致（任务终态归 JobService，迟到帧静默丢弃）。
 */
export function taskWriterAllowed(db: SqliteDb, taskId: string): boolean {
  const task = getTaskById(db, taskId);
  if (!task) return false;
  if (task.status === 'cancelled') return false;
  if (task.session_id === null) return true;
  const session = getSessionById(db, task.session_id);
  return session !== null && session.status === 'active';
}

/** fence 断言（事务内 CAS 单点）：不可写即抛 ArtifactFenceError（携带原因）。 */
export function assertTaskWritable(db: SqliteDb, taskId: string): void {
  const task = getTaskById(db, taskId);
  if (!task) throw new ArtifactFenceError(`任务已不可写（行已删除）：${taskId}`);
  if (task.status === 'cancelled') throw new ArtifactFenceError(`任务已取消，拒绝产物提交：${taskId}`);
  if (task.session_id === null) return;
  const session = getSessionById(db, task.session_id);
  if (!session) throw new ArtifactFenceError(`会话行缺失，拒绝产物提交：${task.session_id}`);
  if (session.status === 'clearing') throw new ArtifactFenceError('会话正在清理，拒绝产物提交');
  if (session.status === 'cleared') throw new ArtifactFenceError('会话已清理，拒绝产物提交');
}
