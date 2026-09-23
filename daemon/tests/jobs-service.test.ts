/**
 * JobService 帧流语义单测（design §2 长任务行——W2.1 测试门）。
 * 覆盖：jsonl 持久化（任务目录 frames.jsonl）/afterSeq 回放/断线重连不丢帧不重复
 * （先回放后实时，衔接处无重叠）/cancel 协作式收敛/归属校验（他人任务必拒、admin 豁免）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Frame } from '@handicraft/contracts';
import { createUser, type UserRow } from '../src/db/store.js';
import type { JobService } from '../src/jobs/service.js';
import { createServices } from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitDone(
  jobs: JobService,
  owner: UserRow,
  taskId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await jobs.get(owner, taskId);
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return;
    await sleep(20);
  }
  throw new Error('任务未在期限内收敛');
}

describe('JobService（sleep job 帧流语义）', () => {
  it('创建→运行→done：jsonl 落任务目录、帧序从 1 单调、终帧 done', async () => {
    const s = createServices();
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 3, intervalMs: 5 },
      });
      await waitDone(s.jobs, s.anonymous, task.taskId);
      expect(task.type).toBe('job');
      expect(task.kind).toBe('sleep');

      const file = path.join(s.config.dataRoot, 'tasks', task.taskId, 'frames.jsonl');
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      const frames = lines.map((line) => JSON.parse(line) as Frame);
      // 3 progress + 1 done（service 补帧）——seq 1..4 单调
      expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4]);
      expect(frames.map((f) => f.kind)).toEqual(['progress', 'progress', 'progress', 'done']);
      expect((frames[2] as { payload: { ratio: number } }).payload.ratio).toBe(1);

      const finalTask = await s.jobs.get(s.anonymous, task.taskId);
      expect(finalTask.task.status).toBe('done');
      expect(finalTask.task.error).toBeUndefined();
    } finally {
      s.dispose();
    }
  });

  it('afterSeq 回放：游标以 task 为域，窗口后 nextSeq 正确', async () => {
    const s = createServices();
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 4, intervalMs: 5 },
      });
      await waitDone(s.jobs, s.anonymous, task.taskId);
      const all = s.jobs.frames(s.anonymous, task.taskId, 0);
      expect(all.nextSeq).toBe(5);
      const window2 = s.jobs.frames(s.anonymous, task.taskId, 2);
      expect(window2.frames.map((f) => f.seq)).toEqual([3, 4, 5]);
      expect(window2.nextSeq).toBe(5);
      const beyond = s.jobs.frames(s.anonymous, task.taskId, 5);
      expect(beyond.frames).toEqual([]);
      expect(beyond.nextSeq).toBe(5);
    } finally {
      s.dispose();
    }
  });

  it('断线重连不丢帧不重复：先回放窗口再实时，衔接处 seq 连续无重叠', async () => {
    const s = createServices();
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 30, intervalMs: 6 },
      });
      // 第一段连接：收实时帧到 seq=K 后断开
      const firstSegment: Frame[] = [];
      const unsubscribe1 = s.jobs.openFrameStream(s.anonymous, task.taskId, 0, (f) =>
        firstSegment.push(f),
      );
      await sleep(40);
      unsubscribe1();
      const lastSeq = firstSegment[firstSegment.length - 1]?.seq ?? 0;
      expect(lastSeq).toBeGreaterThan(0);

      // 断线窗口：任务继续推帧
      await sleep(60);
      const running = await s.jobs.get(s.anonymous, task.taskId);

      // 重连：afterSeq=lastSeq——先回放断线窗口内的持久帧，再续收实时帧
      const secondSegment: Frame[] = [];
      const unsubscribe2 = s.jobs.openFrameStream(s.anonymous, task.taskId, lastSeq, (f) =>
        secondSegment.push(f),
      );
      await waitDone(s.jobs, s.anonymous, task.taskId);
      await sleep(30); // live 帧送达
      unsubscribe2();

      // 合并两段：seq 1..N 连续无重复
      const merged = [...firstSegment, ...secondSegment];
      const seqs = merged.map((f) => f.seq);
      expect(seqs.length).toBe(new Set(seqs).size); // 无重复
      expect(Math.min(...seqs)).toBe(1);
      expect(Math.max(...seqs)).toBeGreaterThan(lastSeq);
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1)); // 无缺失
      // 终帧 done 恰一次
      expect(merged.filter((f) => f.kind === 'done')).toHaveLength(1);
      expect(running.task.status === 'running' || running.task.status === 'done').toBe(true);
    } finally {
      s.dispose();
    }
  });

  it('cancel：运行中任务协作式取消，状态收敛 cancelled；终态幂等', async () => {
    const s = createServices();
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 50, intervalMs: 10 },
      });
      await sleep(30);
      const cancelResult = s.jobs.cancel(s.anonymous, task.taskId);
      expect(cancelResult.ok).toBe(true);
      await waitDone(s.jobs, s.anonymous, task.taskId);
      const finalTask = await s.jobs.get(s.anonymous, task.taskId);
      expect(finalTask.task.status).toBe('cancelled');
      // 幂等
      expect(s.jobs.cancel(s.anonymous, task.taskId).ok).toBe(true);
    } finally {
      s.dispose();
    }
  });

  it('归属校验：他人任务 get/frames/cancel 必拒；admin 豁免；不存在显式拒绝', async () => {
    const s = createServices();
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'sleep',
        params: { frames: 2, intervalMs: 5 },
      });
      const stranger: UserRow = createUser(s.db, {
        username: 'stranger',
        passwordHash: 'x',
        role: 'user',
      });
      await expect(s.jobs.get(stranger, task.taskId)).rejects.toThrow('无权访问');
      expect(() => s.jobs.frames(stranger, task.taskId, 0)).toThrow('无权访问');
      expect(() => s.jobs.cancel(stranger, task.taskId)).toThrow('无权访问');
      const admin: UserRow = createUser(s.db, {
        username: 'root',
        passwordHash: 'x',
        role: 'admin',
      });
      await expect(s.jobs.get(admin, task.taskId)).resolves.toMatchObject({
        task: { taskId: task.taskId },
      });
      await expect(s.jobs.get(s.anonymous, 'no-such-task')).rejects.toThrow('任务不存在');
    } finally {
      s.dispose();
    }
  });

  it('runner 抛错：error 帧 + 状态 failed + error 字段呈现', async () => {
    const s = createServices({
      explode: {
        run: async () => {
          throw new Error('boom');
        },
      },
    });
    try {
      const task = await s.jobs.create(s.anonymous, { kind: 'explode', params: {} });
      await waitDone(s.jobs, s.anonymous, task.taskId);
      const finalTask = await s.jobs.get(s.anonymous, task.taskId);
      expect(finalTask.task.status).toBe('failed');
      expect(finalTask.task.error).toBe('boom');
      const frames = s.jobs.frames(s.anonymous, task.taskId, 0).frames;
      expect(frames[frames.length - 1]!.kind).toBe('error');
      expect(frames[frames.length - 1]!.payload).toEqual({ message: 'boom' });
    } finally {
      s.dispose();
    }
  });

  it('未知 job 类别：create 显式拒绝', async () => {
    const s = createServices();
    try {
      await expect(s.jobs.create(s.anonymous, { kind: 'nope', params: {} })).rejects.toThrow(
        '未知 job 类别',
      );
    } finally {
      s.dispose();
    }
  });
});
