/**
 * tasks.stop 端点两态测试（add-agent-three-channel 1.4，对齐 shufa b6cec8a 验收口径
 * 「打断后可续聊 / cancel 后不可续聊」的贴钻固化）：
 *   [1] 打断（stop）：running agent 任务 → done 收口（终态帧+error 清空）——同会话
 *       可续聊（贴钻语义=再 followup 开新任务：会话可写+新任务可收口）。
 *   [2] 终态取消（cancel）：cancelled 行——迟到帧被 writer fence 丢弃、stop 拒绝
 *       （已取消的任务不可操作）——与打断构成两态对照。
 *   [3] 幂等与边界：非 running no-op 返回现值；job 族 no-op；内核未装配仍可用。
 * 装配：真实 HandicraftKernel（未 boot——stopTask 不依赖 ready；live 已丢路径）+
 * 真实 JobService/SessionService（行/帧/fence 全真源）。live 打断面（stopByTask）
 * 由 tests/kernel.test.ts fake 内核覆盖，真实 dsh 轮打断由 tests/kernel-live.test.ts 覆盖。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { TaskStopOutputSchema } from '@handicraft/contracts';
import { createServices, clientFor, type TestServices } from './helpers.js';
import { createAgentTask } from '../src/db/jobs.js';
import { HandicraftKernel } from '../src/kernel/index.js';

/**
 * rpc 客户端窄面（tasks.stop/get/cancel——形状同 router）。stop=裸 TaskView
 * （[Codex W10 P0-1] TaskStopOutputSchema=TaskViewSchema——不再是 {task} 包装；
 * get 保持 {task} 包装=TaskGetOutputSchema）。
 */
type TaskViewShape = { taskId: string; type: string; status: string; error?: string };
type StopClient = {
  tasks: {
    stop(input: { taskId: string }): Promise<TaskViewShape>;
    get(input: { taskId: string }): Promise<{ task: TaskViewShape }>;
    cancel(input: { taskId: string }): Promise<{ ok: boolean }>;
  };
};

function seedAgentTask(
  s: TestServices,
  sessionId: string,
  options?: { status?: string; paramsJson?: string },
): string {
  const row = createAgentTask(s.db, {
    ownerId: s.anonymous.id,
    sessionId,
    status: (options?.status ?? 'running') as 'running',
    ...(options?.paramsJson !== undefined ? { paramsJson: options.paramsJson } : {}),
  });
  return row.id;
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

describe('tasks.stop 两态固化（打断≠终态取消——对齐 shufa b6cec8a）', () => {
  it('打断：running agent 任务 stop → done 收口（终态帧+error 清空）+同会话可续聊', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
    try {
      const client = clientFor(s.context({ token: await s.tokenFor(), kernel: kernel as never })) as unknown as StopClient;
      const { sessionId } = s.sessions.create(s.anonymous, { title: '打断' });
      // 运行中 agent 任务，params 携带历史 error（stop 的「error 清空」验证面）。
      const taskId = seedAgentTask(s, sessionId, { paramsJson: JSON.stringify({ text: '排钻', error: '旧失败原因' }) });
      const stopped = await client.tasks.stop({ taskId });
      // [Codex W10 P0-1] 真实 router 响应=裸 TaskView，过 TaskStopOutputSchema（前端
      // façade 同一 schema 守门——跨层形状一致才放行）。
      const wire = TaskStopOutputSchema.safeParse(stopped);
      expect(wire.success).toBe(true);
      expect(stopped.status).toBe('done');
      expect(stopped.taskId).toBe(taskId);
      // 行收口 + error 清空（params.error 剥离——视图不再呈现 error）。
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('done');
      const view = await client.tasks.get({ taskId });
      expect(view.task.error).toBeUndefined();
      expect(JSON.parse((s.db.prepare('SELECT params FROM tasks WHERE id = ?').get(taskId) as { params: string }).params)).toEqual({ text: '排钻' });
      // 终态帧补齐（live 已丢路径的帧流收口——最后一帧 done）。
      const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
      expect(frames[frames.length - 1]?.kind).toBe('done');
      // 打断后可续聊：会话仍可写（栅栏通过）+同会话新 agent 任务正常建行收帧。
      const writable = s.sessions.assertSessionWritable(s.anonymous, sessionId);
      expect(writable.id).toBe(sessionId);
      const taskId2 = seedAgentTask(s, sessionId);
      expect(s.jobs.emitFor(taskId2, 'transcript', { role: 'user', text: '续聊消息' })).toBe(true);
      expect((await client.tasks.get({ taskId: taskId2 })).task.status).toBe('running');
    } finally {
      await kernel.stop();
      s.dispose();
    }
  });

  it('终态取消对照：cancel 后迟到帧被 fence 丢弃、行保持 cancelled、stop 拒绝（不可续聊不可打断）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
    try {
      const client = clientFor(s.context({ token: await s.tokenFor(), kernel: kernel as never })) as unknown as StopClient;
      const { sessionId } = s.sessions.create(s.anonymous, { title: '终态取消' });
      const taskId = seedAgentTask(s, sessionId);
      expect((await client.tasks.cancel({ taskId })).ok).toBe(true);
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('cancelled');
      // 迟到的 agent 帧（取消后内核自然落下）被 writer fence 丢弃——帧流冻结。
      expect(s.jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '迟到回复' })).toBe(false);
      expect(s.jobs.emitFor(taskId, 'done', {})).toBe(false);
      expect(s.jobs.frames(s.anonymous, taskId, 0).frames).toHaveLength(0);
      // stop 拒绝：已取消的任务不可操作（shufa CONFLICT 语义——本仓统一 BAD_REQUEST）。
      await expectOrpcError(client.tasks.stop({ taskId }), 'BAD_REQUEST', '已取消的任务不可操作');
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('cancelled');
    } finally {
      await kernel.stop();
      s.dispose();
    }
  });

  it('非 running 幂等 no-op：done 任务 stop 返回现值、不加帧', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
    try {
      const client = clientFor(s.context({ token: await s.tokenFor(), kernel: kernel as never })) as unknown as StopClient;
      const { sessionId } = s.sessions.create(s.anonymous, { title: '幂等' });
      const taskId = seedAgentTask(s, sessionId, { status: 'done' });
      const before = s.jobs.frames(s.anonymous, taskId, 0).frames.length;
      const stopped = await client.tasks.stop({ taskId });
      expect(stopped.status).toBe('done');
      expect(s.jobs.frames(s.anonymous, taskId, 0).frames).toHaveLength(before); // 不加终态帧
    } finally {
      await kernel.stop();
      s.dispose();
    }
  });

  it('job 族 no-op：running sleep 任务 stop 返回现值（无对话轮可打断——job 取消仍走 tasks.cancel）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
    try {
      const client = clientFor(s.context({ token: await s.tokenFor(), kernel: kernel as never })) as unknown as {
        tasks: StopClient['tasks'] & { create(input: { kind: string; params: unknown }): Promise<{ taskId: string; status: string }> };
      };
      const job = await client.tasks.create({ kind: 'sleep', params: { frames: 50, intervalMs: 10_000 } });
      expect(['queued', 'running']).toContain(job.status);
      const stopped = await client.tasks.stop({ taskId: job.taskId });
      // no-op：job 任务不因 stop 离开活跃态（打断是 agent 对话语义；job 取消走 tasks.cancel）。
      expect(['queued', 'running']).toContain(stopped.status);
    } finally {
      s.jobs.stop();
      await kernel.stop();
      s.dispose();
    }
  });

  it('内核未装配（context.kernel 缺席）：stop 面仍可用——cancelled 拒绝+现值返回', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const client = clientFor(s.context({ token: await s.tokenFor() })) as unknown as StopClient;
      const { sessionId } = s.sessions.create(s.anonymous, { title: '未装配' });
      const cancelled = seedAgentTask(s, sessionId, { status: 'cancelled' });
      await expectOrpcError(client.tasks.stop({ taskId: cancelled }), 'BAD_REQUEST', '已取消的任务不可操作');
      const done = seedAgentTask(s, sessionId, { status: 'failed' });
      const stopped = await client.tasks.stop({ taskId: done });
      expect(stopped.status).toBe('failed'); // 现值返回（无行级收敛——无内核即无 agent 活动语义）
    } finally {
      s.dispose();
    }
  });

  // [Codex W10 P0-1] 跨层 wire 形状固化：真实 router 的 stop 响应必须过
  // TaskStopOutputSchema（=TaskViewSchema 裸形——前端 RpcAgentApi.stopTask 按同一
  // schema 守门）；{task} 包装形必拒——若服务端回退为包装响应，前端 façade 会当场
  // 拒收（本测试在 daemon 侧提前拦截该漂移）。
  it('wire 形状：真实 router stop 响应过 TaskStopOutputSchema；{task} 包装形必拒', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const client = clientFor(s.context({ token: await s.tokenFor() })) as unknown as StopClient;
      const { sessionId } = s.sessions.create(s.anonymous, { title: 'wire 形状' });
      const taskId = seedAgentTask(s, sessionId, { status: 'running' });
      const stopped = await client.tasks.stop({ taskId });
      expect(TaskStopOutputSchema.safeParse(stopped).success).toBe(true);
      // 负例：旧包装形 {task: view}——strict TaskViewSchema 不认 task 字段外的形状。
      expect(TaskStopOutputSchema.safeParse({ task: stopped }).success).toBe(false);
    } finally {
      s.dispose();
    }
  });
});
