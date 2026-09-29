/**
 * 项目钻清单 manifest service 测试（add-task-stones-manifest-export 0.2/0.4——
 * arch-decisions A1 存储形态裁定的行为锁定）：
 *   [1] 迁移 v12：session_projects 表在位（user_version=MIGRATIONS 末版）。
 *   [2] 初始化/CAS：expectedRevision=0 → rev1（跳过集合=空 entries）；同基线并发
 *       两写一成功一 typed stale（currentRevision 幂等锚）；脏基线必拒。
 *   [3] fence：会话不存在/跨用户/任务跨会话/任务取消/clearing——typed 错族。
 *   [4] 引用账本：写后 session_blob_refs 在场；字节稳定（loadManifest 往返）。
 *   [5] 补帧恢复（A1 风险节）：帧失败（stub emitFor=false）→ DB 已提交
 *       frameEmitted=false → repairManifestArtifactFrame 以状态行补帧（幂等——
       二次 repair 不产重复帧）；recoverManifestFrames 全量扫描。
 *   [6] 清理释放（A1）：session.clear → manifest blob 引用释放（ref 归零/行回收）
 *       + session_projects 行删除。
 *   [7] task.detail 投影（0.4）：rpc client 读 projectStones（无行=null；有行=
 *       revision/entryCount/sourceSetName/lint 占位 null；损坏 blob typed 拒）。
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { MIGRATIONS } from '../src/db/schema.js';
import { createAgentTask } from '../src/db/jobs.js';
import { getSessionProject } from '../src/db/sessions.js';
import { createServices, clientFor, type TestServices } from './helpers.js';
import {
  ProjectManifestError,
  ProjectManifestService,
  STONES_MANIFEST_ARTIFACT_NAME,
  projectStonesSummaryOf,
  type ManifestContent,
  type ManifestJobsLike,
} from '../src/kernel/project-manifest.js';
import type { UserRow } from '../src/db/store.js';

/** 空项目内容（跳过集合——A5：清空选择仍创建 entries=[] 的 manifest）。 */
const EMPTY_CONTENT: ManifestContent = { sourceSet: null, entries: [] };

/** 单条目内容（origin=manual-add 形态——字段合法即可，展开语义归 W1）。 */
function oneEntryContent(): ManifestContent {
  return {
    sourceSet: { resourceId: 'res-1', setId: 'set-1', setRevision: 7, name: '夏季主色' },
    entries: [
      {
        stoneRef: 'stn-1',
        pick: { resourceId: 'stn-1', sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#AABBCC' },
        stoneRevision: 4,
        stoneJsonBlobRef: 'a'.repeat(64),
        textureBlobRef: 'b'.repeat(64),
        shapeAssetBlobRef: null,
        quantity: 120,
        origin: 'set',
      },
    ],
  };
}

interface Fixture {
  s: TestServices;
  service: ProjectManifestService;
  sessionId: string;
  taskId: string;
  otherUser: UserRow;
}

function setup(): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const service = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '项目会话' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  // 第二用户（forbidden 判定——直接落 users 行，auth 细节不在本测范围）。
  const otherId = 'user-other-' + Date.now();
  s.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, disabled) VALUES (?, ?, 'x', 'user', ?, 0)",
    )
    .run(otherId, otherId, new Date().toISOString());
  const otherUser = s.db.prepare('SELECT * FROM users WHERE id = ?').get(otherId) as UserRow;
  return { s, service, sessionId, taskId: task.id, otherUser };
}

function expectManifestError(promise: () => unknown, kind: string): void {
  let caught: unknown;
  try {
    promise();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectManifestError);
  expect((caught as ProjectManifestError).kind).toBe(kind);
}

describe('迁移 v12：session_projects 状态行', () => {
  it('表在位（session_id PK/revision CHECK/blob_ref/updated_by_*），user_version=末版', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      expect(s.db.pragma('user_version', { simple: true })).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
      const ddl = (
        s.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_projects'").get() as
          | { sql: string }
          | undefined
      )?.sql;
      const normalized = ddl?.replace(/\s+/g, ' ');
      expect(normalized).toContain('session_id TEXT PRIMARY KEY');
      expect(normalized).toContain('CHECK(revision >= 1)');
      expect(normalized).toContain('blob_ref TEXT NOT NULL');
      expect(normalized).toContain('updated_by_task_id TEXT NOT NULL');
    } finally {
      s.dispose();
    }
  });
});

describe('manifest service：初始化/CAS/引用账本', () => {
  it('expectedRevision=0 初始化：rev1+状态行+blob+会话引用账本+artifact 帧', () => {
    const f = setup();
    try {
      const result = f.service.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 0,
        build: () => EMPTY_CONTENT,
      });
      expect(result.manifest.revision).toBe(1);
      expect(result.manifest.projectId).toBe(f.sessionId);
      expect(result.manifest.updatedByTaskId).toBe(f.taskId);
      expect(result.frameEmitted).toBe(true);
      // 状态行=blob 指针+revision。
      const row = getSessionProject(f.s.db, f.sessionId);
      expect(row).toMatchObject({ revision: 1, blob_ref: result.blobRef, updated_by_task_id: f.taskId });
      // 会话侧引用账本（clear 释放面的锚）。
      const ledger = f.s.db
        .prepare('SELECT blob_hash FROM session_blob_refs WHERE session_id = ?')
        .all(f.sessionId) as { blob_hash: string }[];
      expect(ledger.map((r) => r.blob_hash)).toContain(result.blobRef);
      // artifact 帧（latest-by-name 审计面）。
      const artifact = f.s.jobs
        .frames(f.s.anonymous, f.taskId, 0)
        .frames.filter((frame) => frame.kind === 'artifact')
        .map((frame) => frame.payload as { name?: string; blobRef?: string });
      expect(artifact).toContainEqual({ name: STONES_MANIFEST_ARTIFACT_NAME, blobRef: result.blobRef });
    } finally {
      f.s.dispose();
    }
  });

  it('同基线并发两写：一成功一 typed stale（不丢对方条目）；stale 携带 currentRevision', () => {
    const f = setup();
    try {
      const first = f.service.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 0,
        build: () => EMPTY_CONTENT,
      });
      expect(first.manifest.revision).toBe(1);
      // 并发第二写以同基线 0 再入：typed stale，电流 revision=1（幂等重试锚）。
      const second = (): void => {
        f.service.writeManifest(f.s.anonymous, {
          sessionId: f.sessionId,
          taskId: f.taskId,
          expectedRevision: 0,
          build: () => oneEntryContent(),
        });
      };
      expectManifestError(second, 'stale');
      try {
        second();
      } catch (error) {
        expect((error as ProjectManifestError).currentRevision).toBe(1);
      }
      // 首写内容未被吞（不丢对方条目——空 entries 保持；对方写入整体未生效）。
      const loaded = f.service.loadManifest(f.sessionId);
      expect(loaded.revision).toBe(1);
      expect(loaded.manifest?.entries).toEqual([]);
      // 正确基线续写：rev2 带条目（字节稳定往返）。
      const third = f.service.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 1,
        build: () => oneEntryContent(),
      });
      expect(third.manifest.revision).toBe(2);
      expect(third.manifest.entries[0]?.stoneRef).toBe('stn-1');
      const reloaded = f.service.loadManifest(f.sessionId);
      expect(reloaded.revision).toBe(2);
      expect(reloaded.manifest).toEqual(third.manifest);
      // 未来基线也拒（跳号不可写）。
      expectManifestError(() => {
        f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 5, build: () => EMPTY_CONTENT });
      }, 'stale');
    } finally {
      f.s.dispose();
    }
  });

  it('写者不可伪造身份字段：build 只产 sourceSet/entries（revision/updatedByTaskId 服务端单源）', () => {
    const f = setup();
    try {
      const result = f.service.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 0,
        build: () => oneEntryContent(),
      });
      expect(result.manifest.revision).toBe(1); // 非 build 可控
      expect(result.manifest.updatedByTaskId).toBe(f.taskId);
      expect(result.manifest.sourceSet?.name).toBe('夏季主色');
      expect(result.manifest.entries).toHaveLength(1);
    } finally {
      f.s.dispose();
    }
  });

  it('fence 错族：会话不存在/跨用户/任务跨会话/任务取消', () => {
    const f = setup();
    try {
      expectManifestError(() => {
        f.service.writeManifest(f.s.anonymous, { sessionId: 'no-such-session', taskId: f.taskId, expectedRevision: 0, build: () => EMPTY_CONTENT });
      }, 'session-not-found');
      expectManifestError(() => {
        f.service.writeManifest(f.otherUser, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 0, build: () => EMPTY_CONTENT });
      }, 'forbidden');
      const otherSession = f.s.sessions.create(f.s.anonymous, { title: '另一会话' });
      expectManifestError(() => {
        f.service.writeManifest(f.s.anonymous, { sessionId: otherSession.sessionId, taskId: f.taskId, expectedRevision: 0, build: () => EMPTY_CONTENT });
      }, 'task-mismatch');
      const cancelled = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'cancelled' });
      expectManifestError(() => {
        f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: cancelled.id, expectedRevision: 0, build: () => EMPTY_CONTENT });
      }, 'session-not-writable');
      // 任务不存在。
      expectManifestError(() => {
        f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: 'no-such-task', expectedRevision: 0, build: () => EMPTY_CONTENT });
      }, 'task-not-found');
    } finally {
      f.s.dispose();
    }
  });

  it('clearing 栅栏：会话清理中原子拒写', () => {
    const f = setup();
    try {
      f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 0, build: () => EMPTY_CONTENT });
      f.s.db.prepare("UPDATE sessions SET status = 'clearing' WHERE id = ?").run(f.sessionId);
      expectManifestError(() => {
        f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 1, build: () => EMPTY_CONTENT });
      }, 'session-not-writable');
    } finally {
      f.s.dispose();
    }
  });
});

describe('manifest service：补帧恢复（A1 风险节）', () => {
  /** stub jobs：emitFor 恒 false（模拟帧写失败——fence 拒/帧流不可写窗口）。 */
  const failingJobs: ManifestJobsLike = { emitFor: () => false };

  it('帧失败不回滚 DB：状态行已提交 → repair 以状态行补帧（幂等不产重复帧）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { sessionId } = s.sessions.create(s.anonymous, { title: '补帧会话' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      const broken = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: failingJobs });
      const result = broken.writeManifest(s.anonymous, { sessionId, taskId: task.id, expectedRevision: 0, build: () => EMPTY_CONTENT });
      expect(result.frameEmitted).toBe(false);
      expect(getSessionProject(s.db, sessionId)?.blob_ref).toBe(result.blobRef); // DB 已提交
      expect(s.jobs.frames(s.anonymous, task.id, 0).frames).toHaveLength(0); // 帧未落

      // 修复：真 jobs 的 service 以状态行补帧。
      const healer = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs });
      expect(healer.repairManifestArtifactFrame(sessionId)).toBe(true);
      const frames = s.jobs.frames(s.anonymous, task.id, 0).frames.filter((frame) => frame.kind === 'artifact');
      expect(frames.map((frame) => frame.payload)).toContainEqual({ name: STONES_MANIFEST_ARTIFACT_NAME, blobRef: result.blobRef });
      // 幂等：latest-by-name 已指向当前 blobRef——二次 repair 零动作。
      expect(healer.repairManifestArtifactFrame(sessionId)).toBe(false);
      expect(healer.recoverManifestFrames()).toBe(0);
      const count = s.jobs.frames(s.anonymous, task.id, 0).frames.filter((frame) => frame.kind === 'artifact').length;
      expect(count).toBe(1);
    } finally {
      s.dispose();
    }
  });

  it('rev2 后旧帧指向 rev1 blob：repair 补新帧（latest-by-name 前进）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { sessionId } = s.sessions.create(s.anonymous, { title: '补帧2' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      const service = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs });
      const rev1 = service.writeManifest(s.anonymous, { sessionId, taskId: task.id, expectedRevision: 0, build: () => EMPTY_CONTENT });
      expect(rev1.frameEmitted).toBe(true);
      // rev2 走 stub（帧失败）→ 帧流仍指 rev1 blob。
      const broken = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: failingJobs });
      const rev2 = broken.writeManifest(s.anonymous, { sessionId, taskId: task.id, expectedRevision: 1, build: () => oneEntryContent() });
      expect(rev2.frameEmitted).toBe(false);
      expect(service.repairManifestArtifactFrame(sessionId)).toBe(true);
      const artifactFrames = s.jobs
        .frames(s.anonymous, task.id, 0)
        .frames.filter((frame) => frame.kind === 'artifact')
        .map((frame) => (frame.payload as { name?: string; blobRef?: string }));
      expect(artifactFrames).toHaveLength(2); // rev1+rev2 各一帧（历史保留）
      expect(artifactFrames[1]).toEqual({ name: STONES_MANIFEST_ARTIFACT_NAME, blobRef: rev2.blobRef });
    } finally {
      s.dispose();
    }
  });
});

describe('manifest service：清理释放（A1 挂接）', () => {
  it('session.clear：manifest blob 引用释放（行回收/deleting）+session_projects 行删除', () => {
    const f = setup();
    try {
      const rev1 = f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 0, build: () => EMPTY_CONTENT });
      const rev2 = f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 1, build: () => oneEntryContent() });
      // 两代 blob 各有一次引用（会话账本两行——与 ref_count 增量一一对应）。
      const ledger = f.s.db
        .prepare('SELECT COUNT(*) AS n FROM session_blob_refs WHERE session_id = ?')
        .get(f.sessionId) as { n: number };
      expect(ledger.n).toBe(2);
      const outcome = f.s.sessions.clear(f.s.anonymous, f.sessionId);
      expect(outcome.status).toBe('cleared');
      // 状态行已删（cleared 会话不再持有项目指针）。
      expect(getSessionProject(f.s.db, f.sessionId)).toBeNull();
      // 引用归零：active 行回收（outbox 终删）或置 deleting——均不可再被引用。
      for (const ref of [rev1.blobRef, rev2.blobRef]) {
        const row = f.s.blobs.rowOf(ref);
        expect(row === null || row.status === 'deleting').toBe(true);
      }
      // 清理后写入=typed 拒（cleared 不可写）。
      expectManifestError(() => {
        f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 0, build: () => EMPTY_CONTENT });
      }, 'session-not-writable');
    } finally {
      f.s.dispose();
    }
  });
});

describe('task.detail projectStones 投影（0.4）', () => {
  it('无项目行=null；写入后摘要=revision/entryCount/sourceSetName（lint 占位 null）', async () => {
    const f = setup();
    try {
      const client = clientFor(f.s.context({ token: await f.s.tokenFor() }));
      const before = await client.task.detail({ taskId: f.taskId });
      expect(before.projectStones).toBeNull();
      // job 任务（无会话）恒 null。
      expect(projectStonesSummaryOf({ db: f.s.db, blobs: f.s.blobs }, f.sessionId)).toBeNull();

      f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 0, build: () => oneEntryContent() });
      const summary = projectStonesSummaryOf({ db: f.s.db, blobs: f.s.blobs }, f.sessionId);
      expect(summary).toEqual({ revision: 1, entryCount: 1, sourceSetName: '夏季主色', lint: null });
      const after = await client.task.detail({ taskId: f.taskId });
      expect(after.projectStones).toEqual({ revision: 1, entryCount: 1, sourceSetName: '夏季主色', lint: null });
    } finally {
      f.s.dispose();
    }
  });

  it('跳过集合：sourceSetName=null；损坏 blob=typed 拒（不静默降级）', () => {
    const f = setup();
    try {
      const result = f.service.writeManifest(f.s.anonymous, { sessionId: f.sessionId, taskId: f.taskId, expectedRevision: 0, build: () => EMPTY_CONTENT });
      expect(projectStonesSummaryOf({ db: f.s.db, blobs: f.s.blobs }, f.sessionId)).toEqual({
        revision: 1,
        entryCount: 0,
        sourceSetName: null,
        lint: null,
      });
      // 物理覆写 manifest blob（模拟腐蚀）→ 读面 typed 拒。
      const file = f.s.blobs.pathFor(result.blobRef);
      writeFileSync(file as string, 'not-json{');
      expectManifestError(() => projectStonesSummaryOf({ db: f.s.db, blobs: f.s.blobs }, f.sessionId), 'invalid-manifest');
    } finally {
      f.s.dispose();
    }
  });
});
