/**
 * Agent 会话服务（design §3.5 契约 + §6.5 短会话生命周期与留存矩阵——W3.2 核心）。
 * 原始需求 2026-09-23：session.create/list/get/cancel/clear/replay/result 真实现；
 * followup/answer/retry 为 W4 接管占位（占位前先过 §6.5 并发栅栏校验——clearing
 * 生效后原子拒新输入即刻可测）。clear=跨介质清理状态机（事务①标记+撤引用+outbox
 * → 事务外幂等 unlink → 事务②删 task 行+cleared tombstone）；启动重放恢复一致。
 * 正交意图：
 *   [1] 会话生命周期：create/list（过滤 cleared tombstone）/get（任务投影含帧计数）。
 *   [2] clear 状态机（markClearing → outbox.processAll → finishClearing；P1-2 起
 *       未结算不收尾——convergeClearingSessions 由 recover/maintenance 收敛）+
 *       崩溃恢复 recover()（staging 清扫/deleting 行补 outbox/孤儿文件回收/
 *       清空会话续跑/TTL·revoke 回收/tombstone 24h 例行清理）。
 *   [3] 回放与结果：replay（task 域游标）+ result/taskResult（contracts 确定性选择）。
 *   [4] 并发栅栏面：assertSessionWritable（followup/answer 占位前置——clearing 原子拒）。
 */
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  selectSessionResult,
  type Frame,
  type SessionListInput,
  type SessionListOutput,
} from '@handicraft/contracts';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import type { UserRow } from '../db/store.js';
import { nowIso } from '../db/store.js';
import {
  getResultById,
  getResultByPublicId,
  listCompletedAgentTasks,
  listExpiredOrRevokedResults,
  listTasksBySession,
  markResultRevoked,
  type ResultRow,
  type TaskRow,
} from '../db/jobs.js';
import { resultViewOf, type JobService } from '../jobs/service.js';
import { FrameStore } from '../jobs/frame-store.js';
import {
  addSessionBlobRef,
  createSessionRow,
  deleteOutboxDoneOfSession,
  deleteResultBlobRefs,
  deleteSessionBlobRefs,
  deleteSessionRow,
  enqueueOutbox,
  getSessionById as getSession,
  listClearedBefore,
  listClearingSessions,
  listResultBlobRefs,
  listSessionBlobRefs,
  listSessionsByOwner,
  outboxHasPath,
  requeueAllFailed,
  requireOwnedSession,
  updateSessionStatus,
  type OutboxEntryInput,
  type SessionRow,
} from '../db/sessions.js';
import { CleanupOutbox } from './outbox.js';

/** cleared tombstone 物理清理保留窗（design §6.5：默认 24h 例行清理）。 */
export const SESSION_TOMBSTONE_MS = 24 * 60 * 60 * 1000;

/** 会话摘要视图（契约 SessionSummary 的服务端投影）。 */
export interface SessionSummaryView {
  id: string;
  title: string;
  status: SessionRow['status'];
  createdAt: string;
  updatedAt: string;
}

/** outbox blob 条目输入（完整旧代物理路径 + 行标识）。 */
interface BlobOutboxEntry {
  kind: 'blob';
  path: string;
  blob_row: string;
  session_id?: string;
}

export interface SessionServiceDeps {
  config: AppConfig;
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧写入/取消 drain 共用 JobService 单点（writer CAS fence 也在其 emitFrame）。 */
  jobs: JobService;
}

/** clear 测试钩子（barrier/崩溃阶段模拟——生产不传）。 */
export interface ClearHooks {
  /** 事务①提交后、unlink 前（barrier 测试暂停点）。 */
  afterMark?: () => void;
  /** outbox 处理后、事务②前（阶段③崩溃模拟暂停点）。 */
  afterUnlink?: () => void;
}

export class SessionService {
  private readonly outbox: CleanupOutbox;

  constructor(private readonly deps: SessionServiceDeps) {
    this.outbox = new CleanupOutbox(deps);
  }

  // ---------------------------------------------------------------- 生命周期

  create(user: UserRow, input: { title?: string }): { sessionId: string; createdAt: string } {
    const row = createSessionRow(this.deps.db, { ownerId: user.id, title: input.title ?? '' });
    return { sessionId: row.id, createdAt: row.created_at };
  }

  list(user: UserRow, input: SessionListInput): SessionListOutput {
    const limit = input.limit ?? 50;
    const all = listSessionsByOwner(this.deps.db, user.id);
    let page = all;
    if (input.cursor) {
      const anchor = getSession(this.deps.db, input.cursor);
      if (!anchor) return { sessions: [] };
      page = all.filter(
        (row) => row.created_at < anchor.created_at || (row.created_at === anchor.created_at && row.id < anchor.id),
      );
    }
    const slice = page.slice(0, limit);
    const nextCursor = page.length > limit ? slice[slice.length - 1]?.id : undefined;
    return {
      sessions: slice.map((row) => this.toSummary(row)),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  get(
    user: UserRow,
    sessionId: string,
  ): { session: SessionSummaryView; tasks: { taskId: string; status: TaskRow['status']; lastSeq: number; frameCount: number }[] } {
    const session = requireOwnedSession(this.deps.db, user, sessionId);
    const tasks = listTasksBySession(this.deps.db, sessionId).map((task) => {
      const frames = this.framesOf(task.id);
      const last = frames.length > 0 ? (frames[frames.length - 1]?.seq as number) : 0;
      return { taskId: task.id, status: task.status, lastSeq: last, frameCount: frames.length };
    });
    return { session: this.toSummary(session), tasks };
  }

  /**
   * 并发栅栏（design §6.5 R3）：clearing 生效后 followup/answer 原子拒绝。
   * W3 的 followup/answer 主体为 W4 占位（501），但栅栏校验先行——clearing 状态
   * 立刻可测；W4 实装时在同一入口内以同事务语义复核。
   */
  assertSessionWritable(user: UserRow, sessionId: string): SessionRow {
    const session = requireOwnedSession(this.deps.db, user, sessionId);
    if (session.status === 'clearing') throw new Error('会话正在清理，拒绝新输入');
    if (session.status === 'cleared') throw new Error('会话已清理');
    return session;
  }

  /** 取消：taskId 单点（复用 JobService 归属校验）或 sessionId 全量 drain。 */
  cancel(user: UserRow, input: { sessionId?: string; taskId?: string }): { ok: boolean } {
    if (input.taskId) {
      this.deps.jobs.cancel(user, input.taskId);
      return { ok: true };
    }
    if (!input.sessionId) throw new Error('sessionId 与 taskId 必须二选一');
    requireOwnedSession(this.deps.db, user, input.sessionId);
    this.deps.jobs.cancelSessionTasks(input.sessionId);
    return { ok: true };
  }

  // ---------------------------------------------------------------- clear 状态机（§6.5）

  /**
   * session.clear（跨介质清理三段协议）：
   * ① DB 事务：status→clearing（原子栅栏）+ drain 活跃 task + 撤会话侧 blob 引用
   *   （归零行置 deleting + outbox 持久化完整旧代路径）+ 任务目录入 outbox。
   * ② 事务外：outbox 幂等 unlink（blob 先重验行状态；失败记 pending 重试）。
   * ③ DB 事务：删 task 行（results.task_id 解链——分享包保留）+ outbox done 行清理
   *   + session 置 cleared tombstone（重复 clear 幂等 ok）。
   * W3 评审 P1-2：②存在失败/未结算条目时**不进事务③**——会话保持 clearing，由启动/
   * 维护重试收敛后再 finish；对调用方返回显式 status（不伪装 {ok:true} 已清理）。
   */
  clear(
    user: UserRow,
    sessionId: string,
    hooks: ClearHooks = {},
  ): { ok: boolean; status: 'cleared' | 'clearing' } {
    const session = requireOwnedSession(this.deps.db, user, sessionId);
    if (session.status === 'cleared') return { ok: true, status: 'cleared' }; // tombstone 幂等
    this.markClearing(session);
    hooks.afterMark?.();
    this.outbox.processAll();
    hooks.afterUnlink?.();
    if (this.sessionOutboxSettled(sessionId)) {
      this.finishClearing(sessionId);
      return { ok: true, status: 'cleared' };
    }
    return { ok: true, status: 'clearing' };
  }

  /** 事务①：标记 clearing（幂等——已 clearing 的崩溃恢复重入直接续跑同一段）。 */
  private markClearing(session: SessionRow): void {
    const { db, blobs, config, jobs } = this.deps;
    const tx = db.transaction(() => {
      const fresh = getSession(db, session.id);
      if (!fresh) throw new Error(`会话不存在：${session.id}`);
      if (fresh.status === 'cleared') return; // 幂等（并发 clear 另一事务已收尾）
      if (fresh.status === 'active') {
        updateSessionStatus(db, fresh.id, { status: 'clearing' });
      }
      // drain 活跃 task：取消标记 + abort 信号（worker 收到即停；迟到帧被 emit fence 丢弃）。
      jobs.cancelSessionTasks(fresh.id);
      // 撤会话侧 blob 引用（逐行 releaseRef——与 put 增量一一对应）；归零行由
      // releaseRef 置 deleting；随后 deleting 行统一补 outbox（完整旧代物理路径）。
      for (const ref of listSessionBlobRefs(db, fresh.id)) {
        blobs.releaseRef(ref.blob_hash);
      }
      deleteSessionBlobRefs(db, fresh.id);
      const entries: OutboxEntryInput[] = this.deletingRowsOutboxEntries(fresh.id);
      for (const task of listTasksBySession(db, fresh.id)) {
        entries.push({
          kind: 'dir',
          path: path.join(config.dataRoot, 'tasks', task.id),
          session_id: fresh.id,
        });
      }
      enqueueOutbox(db, entries);
    });
    tx();
  }

  /** 事务②：删 task 行 + cleared tombstone。崩溃于 unlink 前后由 recover() 续跑。 */
  private finishClearing(sessionId: string): void {
    const { db } = this.deps;
    const tx = db.transaction(() => {
      for (const task of listTasksBySession(db, sessionId)) {
        // 分享包保留（§6.5 留存矩阵）：results.task_id 解链后删 task 行。
        db.prepare('UPDATE results SET task_id = NULL WHERE task_id = ?').run(task.id);
        db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      }
      deleteOutboxDoneOfSession(db, sessionId);
      updateSessionStatus(db, sessionId, { status: 'cleared', clearedAt: nowIso() });
    });
    tx();
  }

  /** 当前全部 deleting blob 行 → outbox 条目（幂等：同路径已有条目跳过）。 */
  private deletingRowsOutboxEntries(sessionId?: string): BlobOutboxEntry[] {
    const entries: BlobOutboxEntry[] = [];
    for (const row of this.deps.blobs.listDeletingRows()) {
      const absolute = this.deps.blobs.absolutePathOf(row.store_path);
      if (outboxHasPath(this.deps.db, absolute)) continue;
      entries.push({ kind: 'blob', path: absolute, blob_row: row.row_gen, ...(sessionId ? { session_id: sessionId } : {}) });
    }
    return entries;
  }

  // ---------------------------------------------------------------- 启动恢复与例行维护

  /**
   * daemon 启动重放（§6.5 第 4 步）：任何阶段崩溃后重启，无悬空引用、无孤儿文件。
   * 顺序：staging 清扫 → deleting 行补 outbox → 孤儿 blob 文件回收（put 崩于
   * rename 后 INSERT 前）→ results/ 孤儿 bundle 目录回收（发布崩于目录建成后
   * 行提交前）→ failed 重排 → outbox 全量处理 → clearing 会话收尾 →
   * TTL/revoke 回收 → tombstone 24h 例行清理。
   */
  recover(): void {
    const { db } = this.deps;
    this.sweepStagingFiles();
    // deleting 行必须有 outbox 条目（releaseRef 发生在 clear 之外的历史行同样收敛）。
    const missing = this.deletingRowsOutboxEntries();
    if (missing.length > 0) enqueueOutbox(db, missing);
    this.sweepOrphanBlobFiles();
    this.sweepOrphanResultDirs();
    requeueAllFailed(db);
    this.outbox.processAll();
    this.convergeClearingSessions();
    this.sweepExpiredResults();
    this.sweepClearedTombstones();
  }

  /** 例行维护（小时级定时）：TTL/revoke 回收 + tombstone 清理 + outbox 重试收敛。 */
  maintenance(): void {
    requeueAllFailed(this.deps.db);
    this.outbox.processAll();
    this.convergeClearingSessions();
    this.sweepExpiredResults();
    this.sweepClearedTombstones();
  }

  /**
   * clearing 会话收尾（P1-2）：仅当该会话 outbox 全部结算（无 pending/failed）才进
   * 事务②；否则保持 clearing 等下一轮重试——unlink 未完成的会话不得置 cleared。
   */
  private convergeClearingSessions(): void {
    for (const session of listClearingSessions(this.deps.db)) {
      if (this.sessionOutboxSettled(session.id)) this.finishClearing(session.id);
    }
  }

  /** 会话 outbox 结算判定（事务②前置）：无该会话的 pending/failed 条目。 */
  private sessionOutboxSettled(sessionId: string): boolean {
    const row = this.deps.db
      .prepare("SELECT 1 FROM cleanup_outbox WHERE session_id = ? AND state != 'done' LIMIT 1")
      .get(sessionId);
    return row === undefined;
  }

  /** staging 残留清扫（put 崩于写 staging 后 rename 前）。 */
  private sweepStagingFiles(): void {
    const blobsRoot = path.join(this.deps.config.dataRoot, 'blobs');
    if (!existsSync(blobsRoot)) return;
    for (const name of readdirRecursive(blobsRoot)) {
      if (name.includes('.staging-')) {
        try {
          unlinkSync(name);
        } catch {
          // ENOENT 等——并发完成，忽略。
        }
      }
    }
  }

  /**
   * 孤儿 blob 文件回收：blobs 树下不被任何行（active/deleting）的 store_path 引用
   * 的文件 = put 崩于 rename 后 DB 提交前（发布顺序冻结的第三段缺口）。
   */
  private sweepOrphanBlobFiles(): void {
    const blobsRoot = path.join(this.deps.config.dataRoot, 'blobs');
    if (!existsSync(blobsRoot)) return;
    const referenced = new Set(
      (
        this.deps.db.prepare('SELECT store_path FROM blobs').all() as { store_path: string }[]
      ).map((row) => path.normalize(row.store_path)),
    );
    for (const file of readdirRecursive(blobsRoot)) {
      const relative = path.relative(blobsRoot, file);
      if (referenced.has(path.normalize(relative))) continue;
      try {
        unlinkSync(file);
      } catch {
        // 忽略——下轮维护再试。
      }
    }
  }

  /**
   * results/ 孤儿 bundle 目录回收（W3 R2 风险③收口）：分享包发布崩于「bundle 目录
   * 已建成、result 行未提交」的目录无行可对账——启动时按 publicId 对账删除。
   * 仅挂 recover()：启动时无在途发布者；maintenance 与在途发布存在窗口竞态，不挂。
   * results 根为普通文件（R3 新 P1——目录发布失败的残留形态）时自愈移除：该路径
   * 下合法写者只会建目录，普通文件必为异常产物，不删则 recover 崩且后续发布恒败。
   */
  private sweepOrphanResultDirs(): void {
    const resultsRoot = path.join(this.deps.config.dataRoot, 'results');
    let rootIsDir: boolean;
    try {
      rootIsDir = statSync(resultsRoot).isDirectory();
    } catch {
      return; // 不存在——无需清扫。
    }
    if (!rootIsDir) {
      try {
        unlinkSync(resultsRoot);
      } catch {
        // 忽略——下轮启动再试（本轮跳过目录清扫，recover 不崩）。
      }
      return;
    }
    for (const name of readdirSync(resultsRoot)) {
      const full = path.join(resultsRoot, name);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (getResultByPublicId(this.deps.db, name) !== null) continue;
      try {
        rmSync(full, { recursive: true, force: true });
      } catch {
        // 忽略——下轮启动再试。
      }
    }
  }

  /** TTL 到期与已撤销的分享包回收：释放 result 侧引用（归零→outbox）+ 删 bundle 目录与行。 */
  sweepExpiredResults(): void {
    const { db, blobs } = this.deps;
    for (const result of listExpiredOrRevokedResults(db)) {
      const tx = db.transaction(() => {
        for (const ref of listResultBlobRefs(db, result.id)) {
          blobs.releaseRef(ref.blob_hash);
        }
        deleteResultBlobRefs(db, result.id);
        db.prepare('UPDATE tasks SET result_id = NULL WHERE result_id = ?').run(result.id);
        enqueueOutbox(db, [
          { kind: 'dir', path: result.bundle_path, result_id: result.id },
          ...this.deletingRowsOutboxEntries(),
        ]);
        db.prepare('DELETE FROM results WHERE id = ?').run(result.id);
      });
      tx();
    }
    this.outbox.processAll();
  }

  /** revoke 入口（显式撤销——授权族 export 补偿的 W3 底座；设标记后走同一回收链路）。 */
  revokeResult(resultId: string): void {
    markResultRevoked(this.deps.db, resultId);
    this.sweepExpiredResults();
  }

  /** cleared tombstone 24h 例行物理删（重复 clear 幂等由「行不存在=新建」自然承接）。 */
  private sweepClearedTombstones(): void {
    const cutoff = new Date(Date.now() - SESSION_TOMBSTONE_MS).toISOString();
    for (const session of listClearedBefore(this.deps.db, cutoff)) {
      const tx = this.deps.db.transaction(() => {
        deleteOutboxDoneOfSession(this.deps.db, session.id);
        deleteSessionRow(this.deps.db, session.id);
      });
      tx();
    }
  }

  // ---------------------------------------------------------------- 回放与结果

  /** session.replay：回放游标以 task 为域（契约 §3.5——task 必须属于该会话）。 */
  replay(user: UserRow, input: { sessionId: string; taskId: string; afterSeq: number }): { frames: Frame[]; nextSeq: number } {
    requireOwnedSession(this.deps.db, user, input.sessionId);
    const task = this.requireSessionTask(input.sessionId, input.taskId);
    const frames = this.framesOf(task.id, input.afterSeq);
    const nextSeq = frames.length > 0 ? (frames[frames.length - 1]?.seq as number) : input.afterSeq;
    return { frames, nextSeq };
  }

  /** session.result：确定性选择（最新完成 completedAt，平局 taskId 大者——contracts 同源）。 */
  result(user: UserRow, sessionId: string): { resultId: string; taskId: string; publicId?: string; bundle: { svg: string; bom: string; png: string } } {
    requireOwnedSession(this.deps.db, user, sessionId);
    const tasks = listCompletedAgentTasks(this.deps.db, sessionId);
    const best = selectSessionResult(
      tasks.map((task) => ({ taskId: task.id, completedAt: task.updated_at })),
    );
    if (!best) throw new Error('会话暂无已完成结果');
    const task = tasks.find((candidate) => candidate.id === best.taskId) as TaskRow;
    return this.taskResultView(task);
  }

  /** task.result：指定查询——无结果显式 not_found（不回退到别的 task）。 */
  taskResult(user: UserRow, taskId: string): { found: true; resultId: string; publicId?: string; bundle: { svg: string; bom: string; png: string } } | { found: false } {
    const task = this.deps.jobs.requireOwnedTask(user, taskId);
    if (!task.result_id) return { found: false };
    return { found: true, ...this.taskResultView(task) };
  }

  private taskResultView(task: TaskRow): { resultId: string; taskId: string; publicId?: string; bundle: { svg: string; bom: string; png: string } } {
    const result = getResultById(this.deps.db, task.result_id as string) as ResultRow;
    if (!result) throw new Error(`任务 ${task.id} 的结果行缺失`);
    const view = resultViewOf(result);
    return { resultId: view.resultId, taskId: task.id, ...(view.publicId ? { publicId: view.publicId } : {}), bundle: view.bundle };
  }

  // ---------------------------------------------------------------- 内部

  /** 会话任务行（task 必须属于 session——replay 域校验）。 */
  private requireSessionTask(sessionId: string, taskId: string): TaskRow {
    const task = this.deps.db
      .prepare('SELECT * FROM tasks WHERE id = ? AND session_id = ?')
      .get(taskId, sessionId) as TaskRow | undefined;
    if (!task) throw new Error(`任务不属于该会话：${taskId}`);
    return task;
  }

  private framesOf(taskId: string, afterSeq = 0): Frame[] {
    return new FrameStore(path.join(this.deps.config.dataRoot, 'tasks', taskId, 'frames.jsonl')).readAfter(afterSeq);
  }

  private toSummary(row: SessionRow): { id: string; title: string; status: SessionRow['status']; createdAt: string; updatedAt: string } {
    return { id: row.id, title: row.title, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  /** 测试/维护面：outbox 处理器（崩溃阶段模拟直接驱动）。 */
  outboxProcessor(): CleanupOutbox {
    return this.outbox;
  }
}

/**
 * 会话侧引用登记（put + 账本行——W4 followup 附件与测试共用的一引用事件）。
 * W3 评审 P1-3：CAS 与写入同事务——先校验 session.status==='active' 再 put/登记；
 * clearing/cleared/行缺失的迟到调用原子拒绝（含文件在内的全部副作用不发生——
 * put 的文件发布也在事务体内，回滚后由启动孤儿回收清扫）。
 */
export function acquireSessionBlobRef(
  deps: Pick<SessionServiceDeps, 'db' | 'blobs'>,
  sessionId: string,
  data: Uint8Array,
): { hash: string } {
  const commit = deps.db.transaction(() => {
    const session = getSession(deps.db, sessionId);
    if (!session) throw new Error(`会话不存在：${sessionId}`);
    if (session.status === 'clearing') throw new Error('会话正在清理，拒绝新输入');
    if (session.status === 'cleared') throw new Error('会话已清理');
    const put = deps.blobs.put(data);
    addSessionBlobRef(deps.db, sessionId, put.hash);
    return { hash: put.hash };
  });
  return commit();
}

/** 深度枚举目录下全部普通文件（不含目录本身）。 */
function readdirRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}
