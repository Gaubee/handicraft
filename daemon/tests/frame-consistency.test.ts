/**
 * 帧持久化一致性与取消生命周期测试（P1-2 + P2-2——codex-impl-review-w0w2）。
 * P1-2 覆盖：注入写失败帧存储——append 失败使任务进 failed；实时流收到的每一帧
 * 都能从 jsonl/afterSeq 回放得到（收得到 ⇔ 回放得到，不出现不可回放帧）。
 * P2-2 覆盖：退订后空 Set 删 key（订阅表无泄漏）；取消即 abort——挂起外呼中止、
 * 无孤儿 blob 写入。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Frame } from '@handicraft/contracts';
import { FrameStore } from '../src/jobs/frame-store.js';
import type { FrameStoreLike } from '../src/jobs/service.js';
import { putSetting } from '../src/db/store.js';
import { clientFor, createServices } from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitSettled(
  services: ReturnType<typeof createServices>,
  taskId: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await services.jobs.get(services.anonymous, taskId);
    if (task.status !== 'queued' && task.status !== 'running') return task.status;
    await sleep(15);
  }
  throw new Error('任务未在期限内收敛');
}

/** 写失败替身：前 okCount 次照常落盘，之后 append 抛错（模拟磁盘中途变只读）。 */
class FailingAfterStore implements FrameStoreLike {
  private count = 0;
  constructor(
    private readonly real: FrameStore,
    private readonly okCount: number,
  ) {}
  append(frame: Frame): void {
    if (this.count >= this.okCount) throw new Error('EACCES: 只读文件系统（注入）');
    this.count++;
    this.real.append(frame);
  }
  readAfter(afterSeq: number): Frame[] {
    return this.real.readAfter(afterSeq);
  }
  lastSeq(): number {
    return this.real.lastSeq();
  }
}

/** 注入面：per-taskId 记忆化的写失败工厂（service 每次 emit 都取 store——必须同实例计数）。 */
function injectFailingStore(
  s: ReturnType<typeof createServices>,
  okCount: number,
): void {
  const deps = s.jobsDeps();
  const stores = new Map<string, FrameStoreLike>();
  deps.frameStoreOf = (taskId) => {
    let store = stores.get(taskId);
    if (!store) {
      store = new FailingAfterStore(
        new FrameStore(path.join(deps.config.dataRoot, 'tasks', taskId, 'frames.jsonl')),
        okCount,
      );
      stores.set(taskId, store);
    }
    return store;
  };
}

describe('P1-2 帧落盘失败一致性（实时流 / jsonl / afterSeq 三者一致）', () => {
  it('append 第 4 帧起失败：任务进 failed；实时收到的帧全部可回放（无不可回放帧）', async () => {
    const s = createServices();
    try {
      injectFailingStore(s, 3);

      // live 订阅先挂（create 之前——第 1 帧起全程监听）
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 6, intervalMs: 5 },
      });
      const live: Frame[] = [];
      const unsubscribe = s.jobs.openFrameStream(s.anonymous, task.taskId, 0, (f) => live.push(f));

      const status = await waitSettled(s, task.taskId);
      unsubscribe();
      expect(status).toBe('failed');

      // 实时流：恰好前 3 帧（progress×3），失败后无任何「收到但未落盘」的帧
      expect(live.map((f) => f.seq)).toEqual([1, 2, 3]);

      // jsonl：与实时流逐帧相等（收得到 ⇔ 落盘）
      const file = path.join(s.config.dataRoot, 'tasks', task.taskId, 'frames.jsonl');
      const persisted = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Frame);
      expect(persisted.map((f) => f.seq)).toEqual([1, 2, 3]);
      expect(live).toEqual(persisted);

      // afterSeq 回放（rpc 面同源）：与 jsonl 相等；游标不前进到未落盘帧
      const replayed = s.jobs.frames(s.anonymous, task.taskId, 0);
      expect(replayed.frames).toEqual(persisted);
      expect(replayed.nextSeq).toBe(3);
      const window2 = s.jobs.frames(s.anonymous, task.taskId, 2);
      expect(window2.frames.map((f) => f.seq)).toEqual([3]);
      expect(window2.nextSeq).toBe(3);

      // 失败原因呈现（append 错误向上传播——不再被吞）
      const final = await s.jobs.get(s.anonymous, task.taskId);
      expect(final.task.status).toBe('failed');
      expect(final.task.error).toContain('EACCES');
    } finally {
      s.dispose();
    }
  });

  it('全程写失败（第 1 帧即败）：任务仍收敛 failed，回放为空、无广播帧', async () => {
    const s = createServices();
    try {
      injectFailingStore(s, 0);
      const live: Frame[] = [];
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 2, intervalMs: 5 },
      });
      const unsubscribe = s.jobs.openFrameStream(s.anonymous, task.taskId, 0, (f) => live.push(f));
      const status = await waitSettled(s, task.taskId);
      unsubscribe();
      expect(status).toBe('failed');
      expect(live).toEqual([]); // 第一帧落盘失败——零广播
      expect(s.jobs.frames(s.anonymous, task.taskId, 0).frames).toEqual([]);
      expect(s.jobs.frames(s.anonymous, task.taskId, 0).nextSeq).toBe(0);
    } finally {
      s.dispose();
    }
  });
});

describe('P2-2 订阅泄漏与取消生命周期', () => {
  it('退订后空 Set 删 key：订阅表不残留 taskId', async () => {
    const s = createServices();
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 40, intervalMs: 10 },
      });
      const unsubscribe = s.jobs.openFrameStream(s.anonymous, task.taskId, 0, () => {});
      expect(s.jobs.subscriberIds()).toContain(task.taskId);
      unsubscribe();
      expect(s.jobs.subscriberIds()).not.toContain(task.taskId); // 空 Set 已删 key
      await waitSettled(s, task.taskId);
    } finally {
      s.dispose();
    }
  });

  it('取消即中止：挂起外呼被 abort，无孤儿 blob 写入', async () => {
    const s = createServices({
      'hang-then-put': {
        run: async (ctx) => {
          // 模拟长外呼：等取消信号或 5s 超时
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5000);
            ctx.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          if (ctx.signal.aborted) throw new Error('外呼已取消');
          ctx.deps.blobs.put(Buffer.from('must-not-exist'));
          ctx.emit('done', {});
        },
      },
    });
    try {
      const blobsCount = () =>
        (s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
      const before = blobsCount();
      const task = await s.jobs.create(s.anonymous, { kind: 'hang-then-put', params: {} });
      await sleep(50); // 让 runner 进入挂起段
      const startedAt = Date.now();
      s.jobs.cancel(s.anonymous, task.taskId);
      const status = await waitSettled(s, task.taskId, 2000);
      // 取消后 ~ms 级收敛（不等满 5s 超时——abort 真正打断了挂起）
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(status).toBe('cancelled');
      expect(blobsCount()).toBe(before); // 无孤儿 blob
    } finally {
      s.dispose();
    }
  });

  it('generate 全链取消：全局 fetch 挂起→cancel→观察到 abort、无产物 blob、状态 cancelled', async () => {
    const originalFetch = globalThis.fetch;
    let observedAbort = false;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(new DOMException('This operation was aborted', 'AbortError'));
            },
            { once: true },
          );
        }
      });
    }) as typeof fetch;
    const s = createServices(undefined, { imgDryRun: false });
    try {
      // settings 双层真源配齐（baseUrl 域名不真实外呼——fetch 已被替身接管）
      putSetting(s.db, 'img_base_url', 'https://img.example.com/v1');
      putSetting(s.db, 'img_api_key', 'sk-live-key');
      putSetting(s.db, 'img_model', 'img-x');
      const blobsCount = () =>
        (s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
      const before = blobsCount();

      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const created = await client.tasks.create({
        kind: 'generate',
        params: { prompt: '一颗红心' },
      });
      await sleep(80); // 进入真实外呼挂起
      await client.tasks.cancel({ taskId: created.taskId });
      const status = await waitSettled(s, created.taskId, 3000);
      expect(status).toBe('cancelled');
      expect(observedAbort).toBe(true); // ctx.signal 经 AbortSignal.any 真正到达 fetch
      expect(blobsCount()).toBe(before); // 取消后无产物 blob 落盘
    } finally {
      globalThis.fetch = originalFetch;
      s.dispose();
    }
  });
});
