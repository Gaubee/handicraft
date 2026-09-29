/**
 * 项目钻清单 manifest service（add-task-stones-manifest-export 0.2——arch-decisions
 * A1 存储形态裁定的唯一写入面）。
 * 原始需求 2026-09-29：项目=一个 session（projectId ≡ sessionId）；内容=版本化
 * stones-manifest.json 内容寻址 blob；权威指针与 CAS revision=session_projects
 * 状态行（v12）；改动的 task 再发同名 artifact 帧（审计/通知/latest-by-name 读面）。
 * 纪律（A1「不能只沿用 putTaskArtifact 就声称 CAS 已闭合」）：
 *   - 写入=单事务：fence（session active+task 存在/归属/属该 session/未取消）→
 *     读当前 revision（CAS 基线）→ build → schema 校验 → blobs.put（引用计数）→
 *     session_blob_refs 账本登记 → UPDATE ... WHERE revision=?（初始化=INSERT）。
 *   **JSONL 帧与 SQLite 无跨介质事务**：事务提交成功后发 artifact 帧；帧失败不回滚
 *   DB——状态行=恢复源，repairManifestArtifactFrame/recoverManifestFrames 补帧
 *   （幂等：latest-by-name 已指向当前 blobRef 即跳过）。
 *   - 并发旧 revision → typed STALE（ProjectManifestError.kind='stale'，携带
 *     currentRevision 幂等重试锚）。
 *   - revision 由本 service 单源管理（写者 build 回调只产 sourceSet/entries——
 *     不可伪造 revision/updatedByTaskId）。
 * W0 消费面：loadManifest/task.detail 摘要/补帧恢复。W1（首条创建流展开集合）与
 * W2（studio.task.stones.add）经 writeManifest 同一 CAS 写路径，不开第二写面。
 */
import path from 'node:path';
import {
  StonesManifestSchema,
  type StonesManifest,
  type StonesManifestSourceSet,
  type StonesManifestEntry,
  type TaskDetailProjectStones,
} from '@handicraft/contracts';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { getTaskById } from '../db/jobs.js';
import { nowIso, type UserRow } from '../db/store.js';
import {
  addSessionBlobRef,
  casUpdateSessionProject,
  getSessionById,
  getSessionProject,
  insertSessionProject,
  listSessionProjects,
} from '../db/sessions.js';
import { FrameStore } from '../jobs/frame-store.js';

/** manifest artifact 帧名（latest-by-name 读面/补帧幂等判定的锚）。 */
export const STONES_MANIFEST_ARTIFACT_NAME = 'stones-manifest.json';

/** typed 错误码（rpc 面经 ownedError→BAD_REQUEST；W2 MCP 面同映射）。 */
export type ProjectManifestErrorKind =
  | 'session-not-found'
  | 'forbidden'
  | 'session-not-writable'
  | 'task-not-found'
  | 'task-mismatch'
  | 'stale'
  | 'invalid-manifest';

export class ProjectManifestError extends Error {
  readonly kind: ProjectManifestErrorKind;
  /** kind='stale' 时的电流 revision（幂等重试判别锚：相等=已生效放弃重试）。 */
  readonly currentRevision?: number;

  constructor(
    message: string,
    kind: ProjectManifestErrorKind,
    options?: { cause?: unknown; currentRevision?: number },
  ) {
    super(message, options);
    this.name = 'ProjectManifestError';
    this.kind = kind;
    if (options?.currentRevision !== undefined) this.currentRevision = options.currentRevision;
  }
}

/** JobService 的最小结构性类型（emitFor 单点——测试可注入 stub，不耦合实现类）。 */
export interface ManifestJobsLike {
  emitFor(taskId: string, kind: 'artifact', payload: unknown): boolean;
}

export interface ProjectManifestDeps {
  config: AppConfig;
  db: SqliteDb;
  blobs: BlobStore;
  jobs: ManifestJobsLike;
}

/** writeManifest 的可变内容（revision/身份字段由 service 单源填充——写者不可伪造）。 */
export interface ManifestContent {
  sourceSet: StonesManifestSourceSet | null;
  entries: StonesManifestEntry[];
}

export interface WriteManifestInput {
  sessionId: string;
  /** 行动者 task（校验存在/归属/属该 session/未取消——A1「校验 task/session/owner 可写」）。 */
  taskId: string;
  /** CAS 基线：0=初始化（无状态行）；n=当前行 revision。不匹配 → typed stale。 */
  expectedRevision: number;
  /** 内容构造（事务内以电流 manifest 为基调用——W1 集合展开/W2 追加的接缝）。 */
  build: (current: StonesManifest | null) => ManifestContent;
}

export interface WriteManifestResult {
  manifest: StonesManifest;
  blobRef: string;
  /** artifact 帧是否落盘（false=补帧窗口——状态行已提交，repair 面收敛）。 */
  frameEmitted: boolean;
}

/**
 * manifest blob 读回（缺失/损坏=typed 拒——不静默跳过数据腐蚀）。服务读面与
 * task.detail 摘要投影共用单源。
 */
export function readStonesManifestBlob(blobs: BlobStore, blobRef: string): StonesManifest {
  const bytes = blobs.read(blobRef);
  if (bytes === null) {
    throw new ProjectManifestError(`manifest blob 不可读（blobRef=${blobRef.slice(0, 12)}…）`, 'invalid-manifest');
  }
  let parsed: ReturnType<typeof StonesManifestSchema.safeParse>;
  try {
    parsed = StonesManifestSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new ProjectManifestError(
      `manifest blob 不是合法 JSON（blobRef=${blobRef.slice(0, 12)}…）：${error instanceof Error ? error.message : String(error)}`,
      'invalid-manifest',
      { cause: error },
    );
  }
  if (!parsed.success) {
    throw new ProjectManifestError(
      `manifest 内容不合法（blobRef=${blobRef.slice(0, 12)}…）：${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      'invalid-manifest',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** 该 task 帧流 latest-by-name 的 manifest 帧 blobRef（无帧=null——补帧幂等判定）。 */
function latestManifestFrameBlobRef(config: AppConfig, taskId: string): string | null {
  const frames = new FrameStore(
    path.join(config.dataRoot, 'tasks', taskId, 'frames.jsonl'),
  ).readAfter(0);
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'artifact') continue;
    const payload = frame.payload as { name?: unknown; blobRef?: unknown };
    if (payload.name === STONES_MANIFEST_ARTIFACT_NAME && typeof payload.blobRef === 'string') {
      return payload.blobRef;
    }
  }
  return null;
}

export class ProjectManifestService {
  constructor(private readonly deps: ProjectManifestDeps) {}

  /** 读面：无状态行={revision:0, manifest:null}（内存约定——落盘恒 ≥1）。 */
  loadManifest(sessionId: string): { revision: number; manifest: StonesManifest | null } {
    const row = getSessionProject(this.deps.db, sessionId);
    if (row === null) return { revision: 0, manifest: null };
    return { revision: row.revision, manifest: readStonesManifestBlob(this.deps.blobs, row.blob_ref) };
  }

  /**
   * CAS 写入（单事务——见类头纪律）。帧在事务外补发：emitFor 的 fence（会话清理/
   * 任务删除）在此刻仍可能拒绝，返回 frameEmitted=false 交 repair 面收敛。
   */
  writeManifest(user: Pick<UserRow, 'id' | 'role'>, input: WriteManifestInput): WriteManifestResult {
    const { db, blobs } = this.deps;
    const commit = db.transaction((): { manifest: StonesManifest; blobRef: string } => {
      // fence：session 存在+active（clearing/cleared 原子拒——与 followup 同栅栏语义）。
      const session = getSessionById(db, input.sessionId);
      if (session === null) {
        throw new ProjectManifestError(`会话不存在：${input.sessionId}`, 'session-not-found');
      }
      if (session.status === 'clearing') {
        throw new ProjectManifestError('会话正在清理，拒绝项目清单写入', 'session-not-writable');
      }
      if (session.status === 'cleared') {
        throw new ProjectManifestError('会话已清理，拒绝项目清单写入', 'session-not-writable');
      }
      // fence：task 存在+owner（admin 豁免——requireOwnedTask 同语义）+属该 session+未取消。
      const task = getTaskById(db, input.taskId);
      if (task === null) throw new ProjectManifestError(`任务不存在：${input.taskId}`, 'task-not-found');
      if (task.owner_id !== user.id && user.role !== 'admin') {
        throw new ProjectManifestError('无权写入该任务的项目清单', 'forbidden');
      }
      if (task.session_id !== input.sessionId) {
        throw new ProjectManifestError(`任务 ${input.taskId} 不属于会话 ${input.sessionId}`, 'task-mismatch');
      }
      if (task.status === 'cancelled') {
        throw new ProjectManifestError(`任务已取消，拒绝项目清单提交：${input.taskId}`, 'session-not-writable');
      }
      // CAS 基线：事务内读电流行（单连接同步事务——读-改-写无交错；WHERE 子句为
      // A1 裁定面要求的结构性第二道防线）。
      const row = getSessionProject(db, input.sessionId);
      const currentRevision = row?.revision ?? 0;
      if (input.expectedRevision !== currentRevision) {
        throw new ProjectManifestError(
          `manifest revision CAS 失败：expected=${input.expectedRevision} current=${currentRevision}（并发写入或过期基线）`,
          'stale',
          { currentRevision },
        );
      }
      const current = row !== null ? readStonesManifestBlob(blobs, row.blob_ref) : null;
      const content = input.build(current);
      const next: StonesManifest = StonesManifestSchema.parse({
        kind: 'stones-manifest',
        formatVersion: 1,
        projectId: input.sessionId,
        updatedByTaskId: input.taskId,
        revision: currentRevision + 1,
        updatedAt: nowIso(),
        sourceSet: content.sourceSet,
        entries: content.entries,
      });
      // 内容寻址 blob + 会话侧引用账本（同事务——clear 释放面自动覆盖）。
      const bytes = Buffer.from(JSON.stringify(next), 'utf8');
      const put = blobs.put(bytes);
      addSessionBlobRef(db, input.sessionId, put.hash);
      if (row === null) {
        // 初始化（revision 1）：UNIQUE 撞=并发他写先到（结构性第二道防线）。
        try {
          insertSessionProject(db, {
            session_id: input.sessionId,
            revision: next.revision,
            blob_ref: put.hash,
            updated_by_task_id: input.taskId,
            updated_at: next.updatedAt,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            const winner = getSessionProject(db, input.sessionId);
            throw new ProjectManifestError(
              `manifest 初始化竞态：会话已被并发写入（revision=${winner?.revision ?? '?'}）`,
              'stale',
              { cause: error, currentRevision: winner?.revision ?? 0 },
            );
          }
          throw error;
        }
      } else {
        const changes = casUpdateSessionProject(db, input.sessionId, row.revision, {
          revision: next.revision,
          blobRef: put.hash,
          updatedByTaskId: input.taskId,
          updatedAt: next.updatedAt,
        });
        if (changes !== 1) {
          const winner = getSessionProject(db, input.sessionId);
          throw new ProjectManifestError(
            `manifest revision CAS 失败：revision=${row.revision} 已被并发写入`,
            'stale',
            { currentRevision: winner?.revision ?? 0 },
          );
        }
      }
      return { manifest: next, blobRef: put.hash };
    });
    const { manifest, blobRef } = commit();
    // 事务成功后发 artifact 帧（A1：帧失败≠写失败——状态行为恢复源）。
    const frameEmitted = this.deps.jobs.emitFor(input.taskId, 'artifact', {
      name: STONES_MANIFEST_ARTIFACT_NAME,
      blobRef,
    });
    return { manifest, blobRef, frameEmitted };
  }

  /**
   * 补帧恢复（A1 风险节「DB 提交成功、artifact 帧写失败」的收敛面）：以状态行为
   * 恢复源，向 updated_by_task_id 的帧流重发当前 blobRef 的 artifact 帧。幂等——
   * latest-by-name 已指向当前 blobRef 即跳过（不产重复帧）。任务已删/会话清理中
   * → emitFor fence 拒绝，返回 false（下一轮维护/启动重放再试）。
   */
  repairManifestArtifactFrame(sessionId: string): boolean {
    const row = getSessionProject(this.deps.db, sessionId);
    if (row === null) return false;
    if (latestManifestFrameBlobRef(this.deps.config, row.updated_by_task_id) === row.blob_ref) {
      return false;
    }
    return this.deps.jobs.emitFor(row.updated_by_task_id, 'artifact', {
      name: STONES_MANIFEST_ARTIFACT_NAME,
      blobRef: row.blob_ref,
    });
  }

  /** 启动重放（index.ts 装配——sessions.recover() 同段）：全量状态行补帧扫描。 */
  recoverManifestFrames(): number {
    let repaired = 0;
    for (const row of listSessionProjects(this.deps.db)) {
      if (this.repairManifestArtifactFrame(row.session_id)) repaired += 1;
    }
    return repaired;
  }
}

/**
 * task.detail.projectStones 摘要投影（0.4——rpc 组装面消费；独立函数：摘要读面
 * 无 CAS/帧语义，不需服务实例）。无状态行=null；blob 缺失/损坏=typed 拒（上抛
 * rpc ownedError，与 readArtifactJson 同纪律——不静默降级）。
 */
export function projectStonesSummaryOf(
  deps: Pick<ProjectManifestDeps, 'db' | 'blobs'>,
  sessionId: string,
): TaskDetailProjectStones | null {
  const row = getSessionProject(deps.db, sessionId);
  if (row === null) return null;
  const manifest = readStonesManifestBlob(deps.blobs, row.blob_ref);
  return {
    revision: row.revision,
    entryCount: manifest.entries.length,
    sourceSetName: manifest.sourceSet?.name ?? null,
    lint: null, // W0 占位——W3 lint 单源接线后填充（形状已冻结 StoneLintSummary）
  };
}

/** SQLite UNIQUE 约束撞击判定（code=SQLITE_CONSTRAINT_UNIQUE 2067 / 讯息匹配兜底）。 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 2067) return true;
  return /UNIQUE constraint failed: session_projects/.test(error.message);
}
