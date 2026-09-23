/**
 * 任务编排服务（design §1 jobs/ + §2 长任务行——W2.1 job 族）。
 * 原始需求 2026-09-23：tasks 表接线（type='job'）+ 帧流（jsonl 持久化 + afterSeq 回放
 * + live 订阅——回放/订阅同一同步块内完成，无缺失无重复）+ 取消（协作式——runner
 * 在帧间检查 isCancelled；P2-2 起 cancel 即 abort 取消信号）。zhumo TaskService 模式，
 * 贴钻变体=runner registry。
 * 正交意图：
 *   [1] create/list/get/cancel：DB 行生命周期 + 归属校验（admin 豁免）。
 *   [2] 帧提交单点：seq 分配 + FrameStore jsonl append + 订阅者同步通知——
 *       P1-2 起顺序冻结为「先落盘成功，后递增+广播」（收得到 ⇔ 回放得到）；
 *       append 失败向上抛，任务进 failed。
 *   [3] openFrameStream：先回放 afterSeq 之后的持久帧，再挂 live 订阅（WS 推送面）；
 *       退订时空 Set 删 key（订阅表不泄漏——P2-2）。
 *   [4] runner registry：sleep/generate/engine 三类 job 的分发（本波 sleep；
 *       generate/engine 随 W2.2/W2.3 注册）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FrameSchema, type Frame, type FrameKind, type TaskView } from '@handicraft/contracts';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import {
  createJobTask,
  getResultById,
  getTaskById,
  listTasksByOwner,
  updateTask,
  type ResultRow,
  type TaskRow,
} from '../db/jobs.js';
import type { UserRow } from '../db/store.js';
import { FrameStore } from './frame-store.js';

/** 帧存储结构面（FrameStore 满足；测试可注入写失败替身——P1-2 一致性测试）。 */
export interface FrameStoreLike {
  append(frame: Frame): void;
  readAfter(afterSeq: number): Frame[];
  lastSeq(): number;
}

export interface JobServiceDeps {
  config: AppConfig;
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧存储工厂（测试注入面；缺省=真实文件 FrameStore）。 */
  frameStoreOf?: (taskId: string) => FrameStoreLike;
}

/** runner 执行上下文（emit=帧提交单点；isCancelled=协作式取消位；signal=取消即中止）。 */
export interface JobRunnerContext {
  taskId: string;
  /** 任务目录（DATA_ROOT/tasks/<taskId>/——帧 jsonl 与产物落点）。 */
  taskDir: string;
  /** 任务行 params JSON 的 params 字段（create 时冻结的调用参数原样）。 */
  params: unknown;
  emit(kind: FrameKind, payload: unknown): void;
  isCancelled(): boolean;
  /**
   * JobService 持有的取消信号（P2-2）：cancel()/stop() 即 abort——外呼（fetch 等）
   * 应挂接本信号，取消后不再写 blob/外网请求。
   */
  signal: AbortSignal;
  deps: JobServiceDeps;
}

/** job runner：正常返回=任务 done；抛错=任务 failed（error 帧落 message）。 */
export type JobRunner = (ctx: JobRunnerContext) => Promise<void>;

/** job 定义：runner + 创建时同步前置校验（半配置拒绝等——抛 Error=创建被拒）。 */
export interface JobDefinition {
  run: JobRunner;
  preCreate?: (params: unknown, deps: JobServiceDeps) => void;
}

export class JobService {
  private readonly seqs = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<(frame: Frame) => void>>();
  private readonly cancelled = new Set<string>();
  /** 在跑任务的取消控制器（P2-2：JobService 持有，cancel/stop 即 abort）。 */
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly deps: JobServiceDeps,
    private readonly runners: Readonly<Record<string, JobDefinition>>,
  ) {}

  // ---------------------------------------------------------------- 生命周期

  async create(user: UserRow, input: { kind: string; params: unknown }): Promise<TaskView> {
    const definition = this.runners[input.kind];
    if (!definition) throw new Error(`未知 job 类别：${input.kind}`);
    definition.preCreate?.(input.params, this.deps);
    const row = createJobTask(this.deps.db, {
      ownerId: user.id,
      paramsJson: JSON.stringify({ kind: input.kind, params: input.params }),
    });
    void this.run(row, definition.run).catch((error: unknown) => {
      // run 自身兜底后不应到这——防御性记录。
      console.error(
        `[jobs] 任务 ${row.id} 调度异常：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.toView(row);
  }

  private async run(row: TaskRow, runner: JobRunner): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(row.id, controller);
    try {
      this.setStatus(row.id, 'running');
      this.seqs.set(row.id, this.storeOf(row.id).lastSeq());
      const ctx: JobRunnerContext = {
        taskId: row.id,
        taskDir: this.taskDirOf(row.id),
        params: parseParamsField(row.params),
        emit: (kind, payload) => this.emitFrame(row.id, kind, payload),
        isCancelled: () => this.cancelled.has(row.id),
        signal: controller.signal,
        deps: this.deps,
      };
      try {
        await runner(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // P1-2：error 帧落盘也可能失败（同一损坏存储）——不掩盖 failed 状态转换。
        try {
          this.emitFrame(row.id, 'error', { message });
        } catch (frameError) {
          console.error(
            `[jobs] 任务 ${row.id} error 帧落盘失败：${frameError instanceof Error ? frameError.message : String(frameError)}`,
          );
        }
        this.setStatus(row.id, this.cancelled.has(row.id) ? 'cancelled' : 'failed', {
          error: message,
        });
        return;
      }
      if (this.cancelled.has(row.id)) {
        this.setStatus(row.id, 'cancelled');
        return;
      }
      this.emitFrame(row.id, 'done', {});
      this.setStatus(row.id, 'done');
    } finally {
      this.cancelled.delete(row.id);
      this.controllers.delete(row.id);
      // 终态即中止残留外呼（runner 已返回；仍挂起的 fetch/IO 不再占资源）。
      controller.abort();
    }
  }

  /** 取消（协作式 + 中止信号）：queued/running → cancelled；终态幂等 ok。 */
  cancel(user: UserRow, taskId: string): { ok: boolean } {
    const task = this.requireOwnedTask(user, taskId);
    if (task.status === 'queued' || task.status === 'running') {
      this.cancelled.add(taskId);
      // P2-2：取消即 abort——挂接 ctx.signal 的外呼立刻中止，取消后不再写 blob。
      this.controllers.get(taskId)?.abort();
      this.setStatus(taskId, 'cancelled');
    }
    return { ok: true };
  }

  /** 停机面：中止全部在跑任务（daemon 优雅退出时调用）。 */
  stop(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  // ---------------------------------------------------------------- 读面

  list(user: UserRow): { tasks: TaskView[] } {
    return { tasks: listTasksByOwner(this.deps.db, user.id).map((row) => this.toView(row)) };
  }

  async get(user: UserRow, taskId: string): Promise<{ task: TaskView }> {
    return { task: this.toView(this.requireOwnedTask(user, taskId)) };
  }

  /** afterSeq 回放（游标以 task 为域；FrameSchema 守门读回）。 */
  frames(user: UserRow, taskId: string, afterSeq: number): { frames: Frame[]; nextSeq: number } {
    this.requireOwnedTask(user, taskId);
    const frames = this.storeOf(taskId).readAfter(afterSeq);
    const nextSeq = frames.length > 0 ? (frames[frames.length - 1]!.seq as number) : afterSeq;
    return { frames, nextSeq };
  }

  /**
   * 打开帧流：先回放 afterSeq 之后的持久帧，再挂 live 订阅；返回退订函数。
   * 回放与订阅在同一同步块内完成（emit 也是同步单点）——帧不可能在窗口间丢失或重复。
   */
  openFrameStream(
    user: UserRow,
    taskId: string,
    afterSeq: number,
    send: (frame: Frame) => void,
  ): () => void {
    this.requireOwnedTask(user, taskId);
    for (const frame of this.storeOf(taskId).readAfter(afterSeq)) {
      send(frame);
    }
    let listeners = this.subscribers.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(taskId, listeners);
    }
    listeners.add(send);
    return () => {
      listeners!.delete(send);
      // P2-2：空 Set 删 key——订阅表不随 taskId 无限增长。
      if (listeners!.size === 0) this.subscribers.delete(taskId);
    };
  }

  /** 订阅面探针（测试/维护：仍有 live 订阅者的 taskId 集合）。 */
  subscriberIds(): string[] {
    return [...this.subscribers.keys()];
  }

  // ---------------------------------------------------------------- internals

  private emitFrame(taskId: string, kind: FrameKind, payload: unknown): void {
    const seq = (this.seqs.get(taskId) ?? 0) + 1;
    const parsed = FrameSchema.safeParse({ seq, ts: Date.now(), kind, payload });
    if (!parsed.success) {
      console.error(
        `[jobs] 帧 ${taskId}#${seq}（${kind}）载荷不合法，丢弃：${JSON.stringify(parsed.error.issues)}`,
      );
      return;
    }
    // P1-2：先落盘（失败抛出——序号不前进、不广播），仅落盘成功才递增+广播。
    // 不变式：任何被广播/可回放窗口覆盖的帧必已持久化（收得到 ⇔ 回放得到）。
    this.storeOf(taskId).append(parsed.data);
    this.seqs.set(taskId, seq);
    const listeners = this.subscribers.get(taskId);
    if (listeners) {
      for (const send of listeners) send(parsed.data);
    }
  }

  /** 帧存储解析：注入工厂优先（测试面），缺省真实文件 FrameStore。 */
  private storeOf(taskId: string): FrameStoreLike {
    return this.deps.frameStoreOf
      ? this.deps.frameStoreOf(taskId)
      : new FrameStore(this.framesFileOf(taskId));
  }

  private setStatus(taskId: string, status: TaskRow['status'], extra?: { error?: string }): void {
    const task = getTaskById(this.deps.db, taskId);
    if (!task) return;
    const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
    if (extra?.error !== undefined) params['error'] = extra.error;
    updateTask(this.deps.db, taskId, { status, params: JSON.stringify(params) });
  }

  requireOwnedTask(user: UserRow, id: string): TaskRow {
    const task = getTaskById(this.deps.db, id);
    if (!task) throw new Error(`任务不存在：${id}`);
    if (task.owner_id !== user.id && user.role !== 'admin') throw new Error('无权访问该任务');
    return task;
  }

  toView(row: TaskRow): TaskView {
    const meta = row.params ? (JSON.parse(row.params) as Record<string, unknown>) : {};
    const error = typeof meta['error'] === 'string' ? (meta['error'] as string) : undefined;
    const resultRow = row.result_id ? getResultById(this.deps.db, row.result_id) : null;
    return {
      taskId: row.id,
      type: row.type,
      kind: typeof meta['kind'] === 'string' ? (meta['kind'] as TaskView['kind']) : undefined,
      status: row.status,
      ...(error !== undefined ? { error } : {}),
      ...(resultRow ? { result: resultViewOf(resultRow) } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  taskDirOf(taskId: string): string {
    return path.join(this.deps.config.dataRoot, 'tasks', taskId);
  }

  framesFileOf(taskId: string): string {
    return path.join(this.taskDirOf(taskId), 'frames.jsonl');
  }
}

/** results 行 → 契约结果视图（bundle manifest 的 blobRefs 三元组投影——W2.3 share 写入）。 */
export function resultViewOf(row: ResultRow): {
  resultId: string;
  publicId?: string;
  bundle: { svg: string; bom: string; png: string };
} {
  const manifest = JSON.parse(
    readFileSync(path.join(row.bundle_path, 'bundle.json'), 'utf8'),
  ) as { blobRefs: { svg: string; bom: string; png: string } };
  return { resultId: row.id, publicId: row.public_id, bundle: manifest.blobRefs };
}

/** 任务行 params JSON（{kind, params}）→ params 字段（缺失=undefined）。 */
export function parseParamsField(paramsJson: string | null): unknown {
  if (!paramsJson) return undefined;
  const parsed = JSON.parse(paramsJson) as { params?: unknown };
  return parsed.params;
}
