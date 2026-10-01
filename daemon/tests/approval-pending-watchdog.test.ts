/**
 * [真链复验 P1-F，2026-10-01] 审批待批不杀+批准唤醒测试。
 * 实证病灶：proposal 挂着等用户期间 turn 停摆（turn/end 未达——task 仍 running），
 * 1800s 兜底照烧（卡签发后 41s 被杀）；批准后无人唤醒（两次需手动续话）。
 * fake 内核 harness（不 boot dsh——project-first-followup.test.ts readyKernel 同
 * 模式：HandicraftKernel 直构+poke state/handle+手动 attach firehose）。覆盖：
 *   [1] 无 pending proposal：看门狗照旧兜底击杀（error 帧+task failed）。
 *   [2] 待批保护：pending（approved+未过期）期间击发→按剩余 TTL+缓冲续期不杀；
 *       proposal 过期后的下一次击发照杀（上界=单 TTL 窗，不无限续）。
 *   [3] 批准唤醒·活会话：task running+live 在册→steer 注入系统续跑消息（含
 *       proposalId）——agent 续跑消费 grant。
 *   [4] 批准唤醒·轮已收口：task done（turn/end completed、live 已 dispose）→
 *       重启 followup 轮（新 task 携续跑消息；grant 会话域跨轮消费）。
 *   [5] 拒绝不唤醒（op failed，零 steer/零新轮）。
 *   [6] autoApprove 即时签发即时消费——不走 answer，零唤醒。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { createServices, type TestServices } from './helpers.js';
import { HandicraftKernel } from '../src/kernel/index.js';
import type { StudioTaskSessions } from '../src/kernel/sessions.js';
import type { HandicraftKernelHandle } from '../src/kernel/boot.js';
import { setSessionAutoApprove } from '../src/db/sessions.js';

interface FakeAgent {
  session: { id: string };
  status: string;
  followup(message: unknown): void;
  steer(message: unknown): void;
  inject(message: unknown): void;
  cancel(cause: unknown, options?: unknown): void;
  whenIdle(): Promise<void>;
  inbox: unknown;
}

interface Harness {
  s: TestServices;
  kernel: HandicraftKernel;
  prompts: unknown[];
  steered: unknown[];
  fire(event: { type: string; data: unknown }): void;
}

function textOfMessage(message: unknown): string {
  const blocks = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function harness(): Harness {
  const s = createServices(undefined, { imgDryRun: true });
  const prompts: unknown[] = [];
  const steered: unknown[] = [];
  const agent: FakeAgent = {
    session: { id: '' },
    status: 'idle',
    followup(message) {
      prompts.push(message);
    },
    steer(message) {
      steered.push(message);
    },
    inject() {},
    cancel() {},
    whenIdle: () => Promise.resolve(),
    inbox: { nextTurn: [], nextStep: [], remove: () => false, replace: () => false, splice: () => [] },
  };
  type FirehoseListener = (session: { id: string }, event: { type: string; data: unknown }) => void;
  let firehose: FirehoseListener | null = null;
  const ctx = {
    on: (event: string, cb: FirehoseListener) => {
      if (event === 'session/event') firehose = cb;
      return () => undefined;
    },
    agents: {
      create: async (options: { sessionId: string; setup?: (agentCtx: Context) => void }) => {
        agent.session.id = options.sessionId;
        options.setup?.({
          tools: { schemas: () => [{ name: 'bash' }], restrict: () => () => undefined },
        } as unknown as Context);
        return { agent, dispose: async () => undefined };
      },
    },
  } as unknown as Context;
  const handle = {
    ctx,
    record: { entries: [], activationOrder: [], inactiveActivation: [] },
    globalToolNames: () => [] as string[],
    dispose: async () => undefined,
  } as unknown as HandicraftKernelHandle;
  const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
  const poke = kernel as unknown as { state: string; handle: unknown; taskSessions: StudioTaskSessions };
  poke.state = 'ready';
  poke.handle = handle;
  poke.taskSessions.attach(handle);
  return {
    s,
    kernel,
    prompts,
    steered,
    fire: (event) => firehose?.(agent.session, event),
  };
}

function proposeFor(h: Harness, taskId: string, ttlMs?: number): { proposalId: string; requestId: string; autoApproved?: boolean } {
  const sheet = h.s.blobs.put(new Uint8Array([0x61]));
  return h.kernel.approvals.propose({
    taskId,
    userId: h.s.anonymous.id,
    tool: 'studio.export',
    payload: { kind: 'export', resourceId: 'res-1', withPng: true },
    preview: { before: sheet.hash, after: sheet.hash },
    summary: '导出贴钻',
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
}

function taskStatus(h: Harness, taskId: string): string {
  return (h.s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const savedEnv = process.env.FOLLOWUP_TIMEOUT_MS;

beforeEach(() => {
  process.env.FOLLOWUP_TIMEOUT_MS = '80';
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.FOLLOWUP_TIMEOUT_MS;
  else process.env.FOLLOWUP_TIMEOUT_MS = savedEnv;
});

describe('P1-F 审批待批不杀（看门狗保护）', () => {
  it('无 pending proposal：兜底照旧击杀（error 帧+task failed）', async () => {
    const h = harness();
    try {
      const { sessionId } = h.s.sessions.create(h.s.anonymous, { title: '无批' });
      const { taskId } = await h.kernel.followup(h.s.anonymous, sessionId, { text: '开始' });
      expect(taskStatus(h, taskId)).toBe('running');
      await sleep(400); // 看门狗 80ms 击发；无保护→立即杀
      expect(taskStatus(h, taskId)).toBe('failed');
      const frames = h.s.jobs.frames(h.s.anonymous, taskId, 0).frames;
      expect(frames[frames.length - 1]?.kind).toBe('error');
    } finally {
      await h.kernel.stop();
      h.s.dispose();
    }
  });

  it('待批期间击发续期不杀；proposal 过期后下一次击发照杀（上界=单 TTL 窗）', async () => {
    const h = harness();
    try {
      const { sessionId } = h.s.sessions.create(h.s.anonymous, { title: '待批' });
      const { taskId } = await h.kernel.followup(h.s.anonymous, sessionId, { text: '开始' });
      // pending proposal：TTL 600ms（首击发 80ms 时剩余 ~520ms → 续期 ~2520ms）。
      proposeFor(h, taskId, 600);
      await sleep(300); // 已过首击发（80ms）——受保护不杀。
      expect(taskStatus(h, taskId)).toBe('running');
      await sleep(3200); // 过续期窗口（~2600ms）再击发：proposal 已过期（600ms）→照杀。
      expect(taskStatus(h, taskId)).toBe('failed');
    } finally {
      await h.kernel.stop();
      h.s.dispose();
    }
  });
});

describe('P1-F 批准唤醒', () => {
  it('活会话（task running+live 在册）：answer(approved=true) → steer 系统续跑消息（含 proposalId）', async () => {
    process.env.FOLLOWUP_TIMEOUT_MS = '200';
    const h = harness();
    try {
      const { sessionId } = h.s.sessions.create(h.s.anonymous, { title: '唤醒活会话' });
      const { taskId } = await h.kernel.followup(h.s.anonymous, sessionId, { text: '开始' });
      const issued = proposeFor(h, taskId, 60_000);
      // turn 停摆（不 fire turn/end——live 在册、task running——实证形态）。
      h.kernel.approvals.answer(h.s.anonymous, { sessionId, requestId: issued.requestId, approved: true });
      expect(h.steered).toHaveLength(1);
      expect(textOfMessage(h.steered[0])).toContain(issued.proposalId);
      expect(textOfMessage(h.steered[0])).toContain('系统续跑');
      // 唤醒后全额重臂：短预算（200ms）下任务存活（续跑轮不吃 TTL 残余）。
      await sleep(450);
      expect(taskStatus(h, taskId)).toBe('running');
    } finally {
      await h.kernel.stop();
      h.s.dispose();
    }
  });

  it('轮已收口（task done、live 已 dispose）：answer(approved=true) → 重启 followup 轮（新 task 携续跑消息）', async () => {
    process.env.FOLLOWUP_TIMEOUT_MS = '20000';
    const h = harness();
    try {
      const { sessionId } = h.s.sessions.create(h.s.anonymous, { title: '唤醒收口轮' });
      const { taskId } = await h.kernel.followup(h.s.anonymous, sessionId, { text: '开始' });
      const issued = proposeFor(h, taskId, 60_000);
      h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      expect(taskStatus(h, taskId)).toBe('done'); // live 已随 settle dispose。
      h.kernel.approvals.answer(h.s.anonymous, { sessionId, requestId: issued.requestId, approved: true });
      // wake 的 followup 是异步 void——等一拍让新轮落地。
      await sleep(50);
      expect(h.steered).toHaveLength(0); // 不走 steer（live 不在册）。
      expect(h.prompts).toHaveLength(2); // 首轮+续跑轮。
      expect(textOfMessage(h.prompts[1])).toContain(issued.proposalId);
      expect(textOfMessage(h.prompts[1])).toContain('系统续跑');
      const rows = h.s.db
        .prepare('SELECT id, status FROM tasks WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as Array<{ id: string; status: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[1]?.status).toBe('running');
      expect(rows[0]?.id).toBe(taskId);
      expect(rows[0] && taskStatus(h, rows[0].id)).toBe('done');
    } finally {
      await h.kernel.stop();
      h.s.dispose();
    }
  });

  it('拒绝（approved=false）：不唤醒——零 steer、零新轮、op failed', async () => {
    const h = harness();
    try {
      const { sessionId } = h.s.sessions.create(h.s.anonymous, { title: '拒绝' });
      const { taskId } = await h.kernel.followup(h.s.anonymous, sessionId, { text: '开始' });
      const issued = proposeFor(h, taskId, 60_000);
      h.kernel.approvals.answer(h.s.anonymous, { sessionId, requestId: issued.requestId, approved: false });
      expect(h.steered).toHaveLength(0);
      expect(h.prompts).toHaveLength(1);
      const op = h.kernel.approvals.opOf(issued.proposalId);
      expect(op?.state).toBe('failed');
    } finally {
      await h.kernel.stop();
      h.s.dispose();
    }
  });

  it('autoApprove：即时签发即时消费——不走 answer，零唤醒', async () => {
    const h = harness();
    try {
      const { sessionId } = h.s.sessions.create(h.s.anonymous, { title: '自动批' });
      setSessionAutoApprove(h.s.db, sessionId, true);
      const { taskId } = await h.kernel.followup(h.s.anonymous, sessionId, { text: '开始' });
      const issued = proposeFor(h, taskId, 60_000);
      expect(issued.autoApproved).toBe(true);
      expect(h.steered).toHaveLength(0);
      expect(h.prompts).toHaveLength(1); // 无续跑轮。
    } finally {
      await h.kernel.stop();
      h.s.dispose();
    }
  });
});
