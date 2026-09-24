/**
 * session.clear 跨介质清理测试门（design §6.5 全量——W3.2）。
 * 覆盖：三阶段崩溃重启恢复一致 / 活跃 task 竞态无迟到帧无孤儿 / barrier（CAS 后
 * unlink 前并发同 sha256 上传）/ rowGen 恢复（旧行清理后重放与新建共存 + 文件写
 * 成功 DB 未提交的启动孤儿回收）/ outbox pending 期间重上传不丢不悬空 / 共享 blob
 * 双引用（会话删·分享留）/ clear 进行中分享并发访问 / TTL 到期与 revoke 回收 /
 * 重复 clear 幂等 / cleared tombstone 24h 例行清理。
 * 崩溃模拟=关库不跑收尾（WAL 已提交事务持久），重开数据根+recover() 即「重启」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentTask, updateTask } from '../src/db/jobs.js';
import { getSessionById, listSessionBlobRefs } from '../src/db/sessions.js';
import { acquireSessionBlobRef, SESSION_TOMBSTONE_MS } from '../src/sessions/service.js';
import { createShareBundle } from '../src/share.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function makeSession(s: TestServices, title = '清理测试会话'): string {
  return s.sessions.create(s.anonymous, { title }).sessionId;
}

function makeAgentTask(s: TestServices, sessionId: string, status: 'running' | 'done' = 'running'): string {
  return createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status }).id;
}

function framesFile(s: TestServices, taskId: string): string {
  return path.join(s.config.dataRoot, 'tasks', taskId, 'frames.jsonl');
}

function blobFile(s: TestServices, hash: string, rowGen: string): string {
  return path.join(s.config.dataRoot, 'blobs', hash.slice(0, 2), `${hash}.${rowGen}`);
}

async function makeShare(
  s: TestServices,
  taskId: string,
  files?: { svg: Uint8Array; bom: Uint8Array; png: Uint8Array },
): Promise<{ resultId: string; publicId: string; bundlePath: string }> {
  const bundle = await createShareBundle(
    { config: s.config, db: s.db, blobs: s.blobs },
    {
      taskId,
      ownerId: s.anonymous.id,
      title: '清理测试分享',
      files: files ?? {
        svg: enc('<svg>layout</svg>'),
        bom: enc('shape,count\nround,10\n'),
        png: enc('PNG-BYTES'),
      },
    },
  );
  updateTask(s.db, taskId, { status: 'done' });
  return { resultId: bundle.resultId, publicId: bundle.publicId, bundlePath: bundle.bundlePath };
}

/** 崩溃模拟：关库（保留文件）→ 重开同一数据根 + 启动重放。返回新服务组。 */
function crashAndRecover(s: TestServices): TestServices {
  s.db.close();
  const reopened = createServices(undefined, { root: s.root });
  reopened.sessions.recover();
  return reopened;
}

/** 关库重开但不跑 recover（测试「先新建后重放」的共存序）。 */
function crashAndReopen(s: TestServices): TestServices {
  s.db.close();
  return createServices(undefined, { root: s.root });
}

/** 崩溃模拟后原服务组已关库——安全回收（双 close 容忍）。 */
function disposeSafe(s: TestServices): void {
  try {
    s.db.close();
  } catch {
    // 已被崩溃模拟关闭
  }
  rmSync(s.root, { recursive: true, force: true });
}

function outboxStates(s: TestServices): { pending: number; done: number; failed: number } {
  const rows = s.db
    .prepare('SELECT state, COUNT(*) AS n FROM cleanup_outbox GROUP BY state')
    .all() as { state: string; n: number }[];
  const out = { pending: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.state === 'pending') out.pending = row.n;
    if (row.state === 'done') out.done = row.n;
    if (row.state === 'failed') out.failed = row.n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// clear 基线与幂等
// ---------------------------------------------------------------------------

describe('session.clear 基线（§6.5 留存矩阵）', () => {
  it('全链：task 行删除+帧目录回收+私有 blob 解引物理删+会话 cleared tombstone', () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      const taskId = makeAgentTask(s, sessionId);
      expect(s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '正在分析图块' })).toBe(true);
      expect(s.jobs.emitFor(taskId, 'done', {})).toBe(true);
      const { hash } = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, sessionId, enc('upload-source'));
      const rowGen = s.blobs.rowOf(hash)!.row_gen;

      const cleared = s.sessions.clear(s.anonymous, sessionId);
      expect(cleared.ok).toBe(true);

      // 会话行保留 tombstone；task 行删除；帧目录回收；blob 行+文件物理删。
      expect(getSessionById(s.db, sessionId)?.status).toBe('cleared');
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE session_id = ?').get(sessionId)).toEqual({ n: 0 });
      expect(existsSync(path.join(s.config.dataRoot, 'tasks', taskId))).toBe(false);
      expect(existsSync(blobFile(s, hash, rowGen))).toBe(false);
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE row_gen = ?').get(rowGen)).toEqual({ n: 0 });
      expect(listSessionBlobRefs(s.db, sessionId)).toHaveLength(0);
      // 迟到帧被 fence 丢弃且不重建 jsonl。
      expect(s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '迟到' })).toBe(false);
      expect(existsSync(framesFile(s, taskId))).toBe(false);
      // 列表过滤 cleared tombstone。
      expect(s.sessions.list(s.anonymous, {}).sessions.map((x) => x.id)).not.toContain(sessionId);
    } finally {
      s.dispose();
    }
  });

  it('重复 clear 幂等 ok（tombstone 不重复出账）；get 仍可读 tombstone', () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      makeAgentTask(s, sessionId);
      expect(s.sessions.clear(s.anonymous, sessionId).ok).toBe(true);
      expect(s.sessions.clear(s.anonymous, sessionId).ok).toBe(true);
      expect(s.sessions.clear(s.anonymous, sessionId).ok).toBe(true);
      // outbox 无 pending 残留。
      expect(outboxStates(s).pending).toBe(0);
      const view = s.sessions.get(s.anonymous, sessionId);
      expect(view.session.status).toBe('cleared');
      expect(view.tasks).toHaveLength(0);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 崩溃恢复（阶段①标记后 / ②unlink 中 / ③unlink 后）
// ---------------------------------------------------------------------------

describe('清理各阶段崩溃重启恢复一致（§6.5 测试门）', () => {
  it('阶段①（事务①提交后、unlink 前）崩溃 → 重启重放完成回收', () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      const taskId = makeAgentTask(s, sessionId);
      s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '帧 1' });
      const { hash } = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, sessionId, enc('crash-stage1'));
      const rowGen = s.blobs.rowOf(hash)!.row_gen;

      let marked = false;
      try {
        s.sessions.clear(s.anonymous, sessionId, {
          afterMark: () => {
            marked = true;
            throw new Error('SIMULATED-CRASH-STAGE-1');
          },
        });
        expect(marked).toBe(true); // 不应到达（钩子抛出=clear 中断）
      } catch (error) {
        expect((error as Error).message).toBe('SIMULATED-CRASH-STAGE-1');
      }

      const r = crashAndRecover(s);
      try {
        expect(getSessionById(r.db, sessionId)?.status).toBe('cleared');
        expect(existsSync(path.join(r.config.dataRoot, 'tasks', taskId))).toBe(false);
        expect(existsSync(blobFile(r, hash, rowGen))).toBe(false);
        expect(outboxStates(r).pending).toBe(0);
      } finally {
        disposeSafe(s);
        r.dispose();
      }
    } finally {
      disposeSafe(s);
    }
  });

  it('阶段②（unlink 部分完成）崩溃 → 重启幂等续删（ENOENT 视为已完成）', () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      const taskId = makeAgentTask(s, sessionId);
      const refA = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, sessionId, enc('crash-a'));
      const refB = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, sessionId, enc('crash-b'));
      const genA = s.blobs.rowOf(refA.hash)!.row_gen;
      const genB = s.blobs.rowOf(refB.hash)!.row_gen;

      try {
        s.sessions.clear(s.anonymous, sessionId, {
          afterMark: () => {
            // 模拟 unlink 进行到一半：先手动删 A 的文件再「崩溃」。
            rmSync(blobFile(s, refA.hash, genA));
            throw new Error('SIMULATED-CRASH-STAGE-2');
          },
        });
      } catch {
        // 预期崩溃信号
      }

      const r = crashAndRecover(s);
      try {
        expect(existsSync(blobFile(r, refA.hash, genA))).toBe(false); // 已删，幂等
        expect(existsSync(blobFile(r, refB.hash, genB))).toBe(false); // 重放补删
        expect(existsSync(path.join(r.config.dataRoot, 'tasks', taskId))).toBe(false);
        expect(outboxStates(r).pending).toBe(0);
        expect(getSessionById(r.db, sessionId)?.status).toBe('cleared');
      } finally {
        disposeSafe(s);
        r.dispose();
      }
    } finally {
      disposeSafe(s);
    }
  });

  it('阶段③（unlink 完成、事务②前）崩溃 → 重启收尾 task 行删除+tombstone', () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      const taskId = makeAgentTask(s, sessionId);
      acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, sessionId, enc('crash-stage3'));

      try {
        s.sessions.clear(s.anonymous, sessionId, {
          afterUnlink: () => {
            throw new Error('SIMULATED-CRASH-STAGE-3');
          },
        });
      } catch {
        // 预期崩溃信号
      }
      // 文件已回收但 DB 未收尾——重启前中间态可见（clearing）。
      expect(getSessionById(s.db, sessionId)?.status).toBe('clearing');

      const r = crashAndRecover(s);
      try {
        expect(getSessionById(r.db, sessionId)?.status).toBe('cleared');
        expect(r.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(taskId)).toEqual({ n: 0 });
        expect(existsSync(path.join(r.config.dataRoot, 'tasks', taskId))).toBe(false);
      } finally {
        disposeSafe(s);
        r.dispose();
      }
    } finally {
      disposeSafe(s);
    }
  });
});

// ---------------------------------------------------------------------------
// 并发栅栏（R3）：drain + writer fence + clearing 原子拒新
// ---------------------------------------------------------------------------

describe('clear 对活跃 task 的并发栅栏（无迟到帧/无孤儿）', () => {
  it('drain：clear 事务①内置 cancelled；迟到帧 fence 丢弃；任务行终删后 emit 不重建文件', async () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      const taskId = makeAgentTask(s, sessionId, 'running');
      expect(s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '清理前帧' })).toBe(true);

      // 异步写入器跨 clear 窗口持续运行（模拟 agent worker）：单线程同步块内 fence
      // 与事务①互斥——clear 前的帧落盘，clear 后的迟到帧全部被 fence 丢弃。
      let emitted = 0;
      const timer = setInterval(() => {
        emitted += 1;
        s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: `异步帧 ${emitted}` });
      }, 1);
      await new Promise((resolve) => setTimeout(resolve, 8)); // 写入器先跑若干帧
      const framesBefore = s.db
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?')
        .get(taskId);
      expect(framesBefore).toEqual({ n: 1 });
      try {
        s.sessions.clear(s.anonymous, sessionId);
      } finally {
        clearInterval(timer);
      }
      // 迟到帧不重建 jsonl/目录；任务行已删。
      expect(existsSync(framesFile(s, taskId))).toBe(false);
      expect(existsSync(path.join(s.config.dataRoot, 'tasks', taskId))).toBe(false);
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(taskId)).toEqual({ n: 0 });
      expect(emitted).toBeGreaterThan(0); // 写入器确实在跑
    } finally {
      s.dispose();
    }
  });

  it('clearing 生效后 assertSessionWritable 原子拒（followup/answer 的 W4 前置栅栏即刻可测）', () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      let rejectedInWindow = false;
      s.sessions.clear(s.anonymous, sessionId, {
        afterMark: () => {
          rejectedInWindow = true;
          expect(() => s.sessions.assertSessionWritable(s.anonymous, sessionId)).toThrow('会话正在清理');
        },
      });
      expect(rejectedInWindow).toBe(true);
      // clear 完成后 cleared 状态同样拒新。
      expect(() => s.sessions.assertSessionWritable(s.anonymous, sessionId)).toThrow('会话已清理');
      expect(getSessionById(s.db, sessionId)?.status).toBe('cleared');
    } finally {
      s.dispose();
    }
  });

  it('barrier（R4）：CAS 提交后 unlink 前另一会话上传同 sha256——新引用可读；恢复旧 unlink 后新文件仍在、行状态/计数一致', () => {
    const s = createServices();
    try {
      const shared = enc('barrier-shared-bytes');
      const session1 = makeSession(s, '会话1');
      const old = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session1, shared);
      const oldGen = s.blobs.rowOf(old.hash)!.row_gen;

      let afterMarkDone = false;
      try {
        s.sessions.clear(s.anonymous, session1, {
          afterMark: () => {
            afterMarkDone = true;
            // 暂停于 CAS 提交后、unlink 前：旧行已 deleting、outbox pending。
            const row = s.db
              .prepare('SELECT status, ref_count FROM blobs WHERE row_gen = ?')
              .get(oldGen) as { status: string; ref_count: number };
            expect(row.status).toBe('deleting');
            expect(row.ref_count).toBe(0);
            expect(outboxStates(s).pending).toBeGreaterThan(0);
            expect(existsSync(blobFile(s, old.hash, oldGen))).toBe(true); // 文件未删

            // 另一会话上传相同 sha256：防复活=新行+新物理文件，新引用可读。
            const session2 = makeSession(s, '会话2');
            const fresh = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session2, shared);
            expect(fresh.hash).toBe(old.hash);
            const freshGen = s.blobs.rowOf(fresh.hash)!.row_gen;
            expect(freshGen).not.toBe(oldGen);
            expect(existsSync(blobFile(s, fresh.hash, freshGen))).toBe(true);
            expect(s.blobs.read(fresh.hash)).toEqual(Buffer.from(shared));

            // 会话2 收尾不影响（其 clear 独立结算——此处先不清，留给恢复后断言）。
          },
        });
      } finally {
        expect(afterMarkDone).toBe(true);
      }
      // 恢复旧 unlink：clear 继续完成。
      expect(getSessionById(s.db, session1)?.status).toBe('cleared');
      // 旧代文件已删；新代文件仍可读；新行 active 计数 1；旧行已终删。
      expect(existsSync(blobFile(s, old.hash, oldGen))).toBe(false);
      const newRow = s.blobs.rowOf(old.hash);
      expect(newRow?.ref_count).toBe(1);
      expect(s.blobs.read(old.hash)).toEqual(Buffer.from(shared));
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE row_gen = ?').get(oldGen)).toEqual({ n: 0 });
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// rowGen 恢复（R5）：旧行清理后重放与新建共存 + 启动孤儿回收
// ---------------------------------------------------------------------------

describe('rowGen 恢复与启动孤儿回收（R5）', () => {
  it('旧行物理清理路径与同 sha256 新建行在重启重放中共存不互扰', () => {
    const s = createServices();
    try {
      const shared = enc('rowgen-recovery');
      const session1 = makeSession(s, '旧会话');
      const old = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session1, shared);
      const oldGen = s.blobs.rowOf(old.hash)!.row_gen;

      // 崩溃于 afterMark（旧代 deleting + outbox pending、文件仍在）。
      try {
        s.sessions.clear(s.anonymous, session1, {
          afterMark: () => {
            throw new Error('SIMULATED-CRASH-BEFORE-UNLINK');
          },
        });
      } catch {
        // 预期
      }

      // 重开（不跑 recover）：同 sha256 新建行（新代文件）先落地，旧 outbox 仍 pending。
      const r = crashAndReopen(s);
      try {
        const session2 = r.sessions.create(r.anonymous, { title: '重启后新会话' }).sessionId;
        const fresh = acquireSessionBlobRef({ db: r.db, blobs: r.blobs }, session2, shared);
        const freshGen = r.blobs.rowOf(fresh.hash)!.row_gen;
        expect(freshGen).not.toBe(oldGen);
        expect(existsSync(blobFile(r, old.hash, oldGen))).toBe(true); // 旧代未重放
        expect(existsSync(blobFile(r, fresh.hash, freshGen))).toBe(true);

        // 启动重放：旧 outbox 只删旧代路径——新代结构上不可能被命中。
        r.sessions.recover();
        expect(existsSync(blobFile(r, old.hash, oldGen))).toBe(false);
        expect(existsSync(blobFile(r, fresh.hash, freshGen))).toBe(true);
        expect(r.blobs.read(fresh.hash)).toEqual(Buffer.from(shared));
        expect(r.blobs.rowOf(fresh.hash)?.ref_count).toBe(1);
        expect(getSessionById(r.db, session1)?.status).toBe('cleared');
      } finally {
        disposeSafe(s);
        r.dispose();
      }
    } finally {
      disposeSafe(s);
    }
  });

  it('文件写成功但 DB 提交失败的启动孤儿回收 + staging 残留清扫', () => {
    const s = createServices();
    try {
      const blobsRoot = path.join(s.config.dataRoot, 'blobs');
      const shard = path.join(blobsRoot, 'ab');
      mkdirSync(shard, { recursive: true });
      // 孤儿：rename 已发布但 INSERT 未提交（代际命名、无 DB 行）。
      const orphanRel = path.join('ab', `aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899.${crypto.randomUUID()}`);
      const orphanAbs = path.join(blobsRoot, orphanRel);
      writeFileSync(orphanAbs, enc('orphan-published'));
      // staging 残留：写 staging 后 rename 前崩溃。
      const stagingAbs = path.join(shard, 'deadbeef.staging-1-2-abc');
      writeFileSync(stagingAbs, enc('staging-leftover'));
      // 在账文件：不受孤儿回收影响。
      const kept = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, makeSession(s), enc('kept-blob'));
      const keptGen = s.blobs.rowOf(kept.hash)!.row_gen;

      s.sessions.recover();

      expect(existsSync(orphanAbs)).toBe(false);
      expect(existsSync(stagingAbs)).toBe(false);
      expect(existsSync(blobFile(s, kept.hash, keptGen))).toBe(true);
    } finally {
      s.dispose();
    }
  });

  it('outbox pending 期间另一会话同 sha256 重上传：两会话各自 clear 后不丢不悬空（全回收、零残留）', () => {
    const s = createServices();
    try {
      const shared = enc('pending-window');
      const session1 = makeSession(s, '会话A');
      const session2 = makeSession(s, '会话B');
      const a = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session1, shared);
      const oldGen = s.blobs.rowOf(a.hash)!.row_gen;

      s.sessions.clear(s.anonymous, session1, {
        afterMark: () => {
          // pending 窗口内会话 B 重上传：不丢（新行可读）、不悬空（新行有文件）。
          const b = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session2, shared);
          expect(s.blobs.read(b.hash)).toEqual(Buffer.from(shared));
        },
      });
      // 会话 B 也 clear：同 hash 两代行全部走完回收，无 active 行、无文件、无 pending。
      s.sessions.clear(s.anonymous, session2);
      expect(s.blobs.rowOf(a.hash)).toBeNull();
      expect(existsSync(blobFile(s, a.hash, oldGen))).toBe(false);
      const leftover = readdirSync(path.join(s.config.dataRoot, 'blobs', a.hash.slice(0, 2)));
      expect(leftover).toHaveLength(0);
      expect(outboxStates(s).pending).toBe(0);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 分享留存：双引用 / 并发访问 / TTL / revoke
// ---------------------------------------------------------------------------

describe('分享包留存（§6.5：与会话生命周期解耦）', () => {
  it('共享 blob 双引用：会话删/分享留——clear 只撤会话侧引用', async () => {
    const s = createServices();
    try {
      const session = makeSession(s);
      const taskId = makeAgentTask(s, session);
      const sharedSvg = enc('<svg>shared-svg-bytes</svg>');
      const ref = acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session, sharedSvg);
      // 分享包以同一内容建 result 侧引用（put 命中 active 行 → ref_count=2）。
      const share = await makeShare(s, taskId, {
        svg: sharedSvg,
        bom: enc('shape,count\n'),
        png: enc('PNG'),
      });
      expect(s.blobs.rowOf(ref.hash)?.ref_count).toBe(2);

      s.sessions.clear(s.anonymous, session);

      // 会话侧引用撤、分享侧仍在：行 active 计数 1、文件在、分享可访问。
      expect(s.blobs.rowOf(ref.hash)?.ref_count).toBe(1);
      expect(s.blobs.read(ref.hash)).toEqual(Buffer.from(sharedSvg));
      const row = s.db.prepare('SELECT * FROM results WHERE public_id = ?').get(share.publicId) as
        | { task_id: string | null }
        | undefined;
      expect(row).toBeDefined(); // 分享行保留（task_id 已解链为 NULL）
      expect(row?.task_id).toBeNull();
      expect(existsSync(path.join(share.bundlePath, 'render.png'))).toBe(true);
    } finally {
      s.dispose();
    }
  });

  it('clear 进行中分享并发访问不受影响（afterMark 暂停窗口内仍可读）', async () => {
    const s = createServices();
    try {
      const session = makeSession(s);
      const taskId = makeAgentTask(s, session);
      const share = await makeShare(s, taskId);
      acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session, enc('session-private'));

      s.sessions.clear(s.anonymous, session, {
        afterMark: () => {
          const row = s.db.prepare('SELECT * FROM results WHERE public_id = ?').get(share.publicId);
          expect(row).toBeDefined();
          expect(existsSync(path.join(share.bundlePath, 'bundle.json'))).toBe(true);
          expect(readFileSync(path.join(share.bundlePath, 'render.png'), 'utf8')).toBe('PNG-BYTES');
        },
      });
      // clear 完成后分享照常。
      expect(existsSync(path.join(share.bundlePath, 'render.png'))).toBe(true);
    } finally {
      s.dispose();
    }
  });

  it('TTL 到期回收：分享行删除+bundle 目录回收+引用释放（归零物理删）', async () => {
    const s = createServices();
    try {
      const session = makeSession(s);
      const taskId = makeAgentTask(s, session);
      const share = await makeShare(s, taskId);
      const svgHash = s.db
        .prepare('SELECT blob_hash FROM result_blob_refs WHERE result_id = ? LIMIT 1')
        .get(share.resultId) as { blob_hash: string };

      // 未到期：可达。
      expect(
        s.db.prepare('SELECT * FROM results WHERE public_id = ?').get(share.publicId),
      ).toBeDefined();

      // 到期（倒拨 expires_at）→ 例行维护回收。
      s.db
        .prepare('UPDATE results SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), share.resultId);
      s.sessions.maintenance();

      expect(s.db.prepare('SELECT COUNT(*) AS n FROM results WHERE id = ?').get(share.resultId)).toEqual({ n: 0 });
      expect(existsSync(share.bundlePath)).toBe(false);
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM result_blob_refs WHERE result_id = ?').get(share.resultId)).toEqual({ n: 0 });
      // 无其他引用 → blob 行+文件物理删；outbox 无 pending。
      expect(s.blobs.rowOf(svgHash.blob_hash)).toBeNull();
      expect(outboxStates(s).pending).toBe(0);
    } finally {
      s.dispose();
    }
  });

  it('revoke：显式撤销即走同一回收链路（bundle 释放+引用归零）', async () => {
    const s = createServices();
    try {
      const session = makeSession(s);
      const taskId = makeAgentTask(s, session);
      const share = await makeShare(s, taskId);

      s.sessions.revokeResult(share.resultId);

      expect(s.db.prepare('SELECT COUNT(*) AS n FROM results WHERE id = ?').get(share.resultId)).toEqual({ n: 0 });
      expect(existsSync(share.bundlePath)).toBe(false);
      expect(outboxStates(s).pending).toBe(0);
    } finally {
      s.dispose();
    }
  });

  it('分享独占 blob：会话 clear 不触碰 result 侧（TTL 后才物理删）', async () => {
    const s = createServices();
    try {
      const session = makeSession(s);
      const taskId = makeAgentTask(s, session);
      const share = await makeShare(s, taskId);
      const hashes = (
        s.db.prepare('SELECT blob_hash FROM result_blob_refs WHERE result_id = ?').all(share.resultId) as {
          blob_hash: string;
        }[]
      ).map((r) => r.blob_hash);
      acquireSessionBlobRef({ db: s.db, blobs: s.blobs }, session, enc('session-only'));

      s.sessions.clear(s.anonymous, session);
      for (const hash of hashes) {
        expect(s.blobs.rowOf(hash)?.ref_count).toBe(1); // 分享侧独占
      }

      s.sessions.revokeResult(share.resultId);
      for (const hash of hashes) {
        expect(s.blobs.rowOf(hash)).toBeNull(); // 释放归零物理删
      }
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// tombstone 例行清理
// ---------------------------------------------------------------------------

describe('cleared tombstone 24h 例行清理', () => {
  it('到期物理删行；未到期保留（重复 clear 幂等窗口）', () => {
    const s = createServices();
    try {
      const sessionId = makeSession(s);
      makeAgentTask(s, sessionId);
      s.sessions.clear(s.anonymous, sessionId);
      expect(getSessionById(s.db, sessionId)).toBeDefined(); // tombstone 保留

      // 未到期维护：保留。
      s.sessions.maintenance();
      expect(getSessionById(s.db, sessionId)).toBeDefined();

      // 倒拨 cleared_at 超过保留窗：物理删。
      s.db
        .prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?')
        .run(new Date(Date.now() - SESSION_TOMBSTONE_MS - 1000).toISOString(), sessionId);
      s.sessions.maintenance();
      expect(getSessionById(s.db, sessionId)).toBeNull();
    } finally {
      s.dispose();
    }
  });
});
