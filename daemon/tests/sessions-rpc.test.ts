/**
 * session.* / tasks.result RPC 面测试（W3.2——design §3.5 契约 + §6.5 栅栏投影）。
 * 覆盖：create/list/get 输出过契约 Zod；clear/cancel 真实现；followup/answer/retry
 * 501 占位（W4 接管）+ clearing 原子拒（BAD_REQUEST 先于 501）；replay task 域游标；
 * session.result 确定性选择与 task.result not_found；归属校验；服务未装配 501。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import {
  SessionCreateOutputSchema,
  SessionGetOutputSchema,
  SessionListOutputSchema,
  SessionReplayOutputSchema,
} from '@handicraft/contracts';
import { createAgentTask, updateTask } from '../src/db/jobs.js';
import { createShareBundle } from '../src/share.js';
import { clientFor, createServices } from './helpers.js';

type SessionClient = ReturnType<typeof clientFor> & {
  session: {
    create(input: { title?: string }): Promise<{ sessionId: string; createdAt: string }>;
    list(input?: { cursor?: string; limit?: number }): Promise<{ sessions: unknown[]; nextCursor?: string }>;
    get(input: { sessionId: string }): Promise<unknown>;
    followup(input: { sessionId: string; text: string }): Promise<never>;
    answer(input: { sessionId: string; requestId: string; approved: boolean }): Promise<never>;
    cancel(input: { sessionId?: string; taskId?: string }): Promise<{ ok: boolean }>;
    clear(input: { sessionId: string }): Promise<{ ok: boolean; status: 'cleared' | 'clearing' }>;
    retry(input: unknown): Promise<never>;
    replay(input: { sessionId: string; taskId: string; afterSeq?: number }): Promise<unknown>;
    result(input: { sessionId: string }): Promise<unknown>;
  };
  tasks: {
    result(input: { taskId: string }): Promise<unknown>;
  };
};

function sessionClient(context: Parameters<typeof clientFor>[0]): SessionClient {
  return clientFor(context) as SessionClient;
}

async function expectOrpcError(promise: Promise<unknown>, code: string, messageFragment?: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
    if (messageFragment) {
      expect((error as ORPCError<string, unknown>).message).toContain(messageFragment);
    }
    return;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

async function attachResult(s: ReturnType<typeof createServices>, sessionId: string, taskId: string, tag: string) {
  await createShareBundle(
    { config: s.config, db: s.db, blobs: s.blobs },
    {
      taskId,
      ownerId: s.anonymous.id,
      title: `结果 ${tag}`,
      files: { svg: enc(`<svg>${tag}</svg>`), bom: enc('shape,count\n'), png: enc(`PNG-${tag}`) },
    },
  );
  updateTask(s.db, taskId, { status: 'done' });
}

describe('session RPC（W3.2）', () => {
  it('create/list/get：输出过契约 Zod；list 过滤 cleared；get 含任务投影（lastSeq/frameCount）', async () => {
    const s = createServices();
    try {
      const client = sessionClient(s.context({ token: await s.tokenFor() }));
      const created = await client.session.create({ title: '第一个会话' });
      expect(SessionCreateOutputSchema.safeParse(created).success).toBe(true);

      const session2 = await client.session.create({});
      const listed = await client.session.list({ limit: 10 });
      expect(SessionListOutputSchema.safeParse(listed).success).toBe(true);
      expect((listed.sessions as { id: string }[]).map((x) => x.id).sort()).toEqual(
        [created.sessionId, session2.sessionId].sort(),
      );

      // agent task + 2 帧 → get 投影。
      const taskId = createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId: created.sessionId,
        status: 'running',
      }).id;
      s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '帧一' });
      s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '帧二' });
      const view = SessionGetOutputSchema.parse(await client.session.get({ sessionId: created.sessionId }));
      expect(view.tasks).toHaveLength(1);
      expect(view.tasks[0]).toMatchObject({ taskId, status: 'running', lastSeq: 2, frameCount: 2 });

      // clear 后列表过滤 tombstone；get 仍可读（cleared）。
      await client.session.clear({ sessionId: created.sessionId });
      const listedAfter = await client.session.list({});
      expect((listedAfter.sessions as { id: string }[]).map((x) => x.id)).not.toContain(created.sessionId);
      const tomb = SessionGetOutputSchema.parse(await client.session.get({ sessionId: created.sessionId }));
      expect(tomb.session.status).toBe('cleared');
      expect(tomb.tasks).toHaveLength(0);
    } finally {
      s.dispose();
    }
  });

  it('followup/answer/retry：answer/retry 未装配授权桥=501（W4.2 语义）；followup 无内核=501 未装配', async () => {
    const s = createServices();
    try {
      const client = sessionClient(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await client.session.create({ title: '占位' });
      await expectOrpcError(
        client.session.followup({ sessionId, text: '帮我排钻' }),
        'NOT_IMPLEMENTED',
        'dsh 内核未装配',
      );
      await expectOrpcError(
        client.session.answer({ sessionId, requestId: 'req-1', approved: true }),
        'NOT_IMPLEMENTED',
        '授权桥未装配',
      );
      await expectOrpcError(
        client.session.retry({ sessionId, proposalId: 'p1', costConfirmed: true, retryRequestId: 'r1' }),
        'NOT_IMPLEMENTED',
        '授权桥未装配',
      );
    } finally {
      s.dispose();
    }
  });

  it('clearing 生效后 followup/answer 原子拒（栅栏先于 501 占位）', async () => {
    const s = createServices();
    try {
      const client = sessionClient(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await client.session.create({ title: '栅栏' });
      createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });

      // 确定性构造清理中间态（=事务①提交后、进程未收尾的持久事实）：
      // followup/answer 在该状态下被并发栅栏拒绝——BAD_REQUEST 而非 501。
      s.db.prepare("UPDATE sessions SET status = 'clearing' WHERE id = ?").run(sessionId);
      await expectOrpcError(client.session.followup({ sessionId, text: '迟到输入' }), 'BAD_REQUEST', '正在清理');
      await expectOrpcError(
        client.session.answer({ sessionId, requestId: 'req-1', approved: false }),
        'BAD_REQUEST',
        '正在清理',
      );
      // 走完 clear（服务面幂等续跑 clearing 中间态）后：cleared 同样拒新。
      await client.session.clear({ sessionId });
      await expectOrpcError(client.session.followup({ sessionId, text: '迟到输入' }), 'BAD_REQUEST', '已清理');
      await expectOrpcError(
        client.session.answer({ sessionId, requestId: 'req-1', approved: false }),
        'BAD_REQUEST',
        '已清理',
      );
    } finally {
      s.dispose();
    }
  });

  it('cancel：sessionId 全量 drain / taskId 单点；XOR 校验；clear 后幂等 ok', async () => {
    const s = createServices();
    try {
      const client = sessionClient(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await client.session.create({ title: '取消' });
      const t1 = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      const t2 = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'queued' });
      const cancelled = await client.session.cancel({ sessionId });
      expect(cancelled.ok).toBe(true);
      expect(s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(t1.id)).toEqual({ status: 'cancelled' });
      expect(s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(t2.id)).toEqual({ status: 'cancelled' });

      // taskId 单点 + XOR（两者同给拒绝）。
      const t3 = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      expect((await client.session.cancel({ taskId: t3.id })).ok).toBe(true);
      await client.session.clear({ sessionId });
      expect((await client.session.cancel({ sessionId })).ok).toBe(true); // 幂等
      await expectOrpcError(
        client.session.cancel({ sessionId, taskId: 'x' }),
        'BAD_REQUEST',
      );
    } finally {
      s.dispose();
    }
  });

  it('replay：task 域游标（afterSeq 过滤）+ nextSeq；跨会话任务必拒', async () => {
    const s = createServices();
    try {
      const client = sessionClient(s.context({ token: await s.tokenFor() }));
      const a = await client.session.create({ title: 'A' });
      const b = await client.session.create({ title: 'B' });
      const taskA = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId: a.sessionId }).id;
      s.jobs.emitFor(taskA, 'transcript', { role: 'assistant', text: 'A1' });
      s.jobs.emitFor(taskA, 'transcript', { role: 'assistant', text: 'A2' });
      const replay = SessionReplayOutputSchema.parse(
        await client.session.replay({ sessionId: a.sessionId, taskId: taskA, afterSeq: 1 }),
      );
      expect(replay.frames.map((f) => f.seq)).toEqual([2]);
      expect(replay.nextSeq).toBe(2);
      const full = SessionReplayOutputSchema.parse(
        await client.session.replay({ sessionId: a.sessionId, taskId: taskA, afterSeq: 0 }),
      );
      expect(full.frames).toHaveLength(2);
      // 任务不属于会话 B。
      await expectOrpcError(client.session.replay({ sessionId: b.sessionId, taskId: taskA }), 'BAD_REQUEST');
    } finally {
      s.dispose();
    }
  });

  it('session.result：确定性选择（最新完成；平局 taskId 大者）+ task.result not_found', async () => {
    const s = createServices();
    try {
      const client = sessionClient(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await client.session.create({ title: '结果' });
      const early = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId }).id;
      await attachResult(s, sessionId, early, 'early');
      // 钉住 early 的完成时刻（防同毫秒平局导致选择不稳定——平局语义单独测）。
      s.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', early);
      const result = (await client.session.result({ sessionId })) as { taskId: string; publicId?: string; bundle: { svg: string } };
      expect(result.taskId).toBe(early);
      expect(result.publicId).toMatch(/^[A-Za-z0-9]{12}$/);
      expect(typeof result.bundle.svg).toBe('string');

      // 更新时间更晚的第二个结果 → 选中最新。
      const late = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId }).id;
      await attachResult(s, sessionId, late, 'late');
      const result2 = (await client.session.result({ sessionId })) as { taskId: string };
      expect(result2.taskId).toBe(late);

      // 平局（updated_at 相同）→ taskId 字典序大者。
      const now = new Date().toISOString();
      s.db.prepare('UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)').run(now, early, late);
      const result3 = (await client.session.result({ sessionId })) as { taskId: string };
      expect(result3.taskId).toBe(early > late ? early : late);

      // task.result：有结果 found / 无结果显式 not_found（不回退别的 task）。
      const byTask = (await client.tasks.result({ taskId: late })) as { found: boolean };
      expect(byTask.found).toBe(true);
      const bare = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId }).id;
      const missing = (await client.tasks.result({ taskId: bare })) as { found: boolean };
      expect(missing.found).toBe(false);
      // 无结果的会话：session.result 显式拒绝。
      const empty = await client.session.create({ title: '空' });
      await expectOrpcError(client.session.result({ sessionId: empty.sessionId }), 'BAD_REQUEST');
    } finally {
      s.dispose();
    }
  });

  it('归属：他人 session 读面/清面必拒（admin 豁免）；未装配 sessions 服务 501', async () => {
    const s = createServices();
    try {
      const { createUser } = await import('../src/db/store.js');
      const stranger = createUser(s.db, { username: 'stranger-w3', passwordHash: 'x', role: 'user' });
      const ownerClient = sessionClient(s.context({ token: await s.tokenFor() }));
      const strangerClient = sessionClient(s.context({ token: await s.tokenFor(stranger) }));
      const { sessionId } = await ownerClient.session.create({ title: '归属' });

      await expectOrpcError(strangerClient.session.get({ sessionId }), 'BAD_REQUEST');
      await expectOrpcError(strangerClient.session.clear({ sessionId }), 'BAD_REQUEST');
      expect((await ownerClient.session.get({ sessionId: sessionId })) as unknown).toBeDefined();

      // 未装配：context 无 sessions → 501。
      const bare = sessionClient(s.context({ token: await s.tokenFor(), sessions: undefined }));
      await expectOrpcError(bare.session.list({}), 'NOT_IMPLEMENTED');
    } finally {
      s.dispose();
    }
  });

  it('未登录 session.* 401', async () => {
    const s = createServices();
    try {
      const client = sessionClient(s.context());
      await expectOrpcError(client.session.list({}), 'UNAUTHORIZED');
    } finally {
      s.dispose();
    }
  });
});
