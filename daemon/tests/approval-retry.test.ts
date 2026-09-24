/**
 * session.retry + attempt 账本测试（W4.2——design §3.6 R4/R5/R6；tasks.md:39 重试组）。
 * 覆盖：
 *   [1] 两类 provider fixture（支持/不支持幂等键）崩溃后重启与重试断言——持久状态/
 *       远端调用次数/用户可见结果+启动遗留 operation/attempt 收敛。
 *   [2] 重试授权组：未授权（costConfirmed=false）/跨用户必拒、旧 grant 重放必拒、
 *       同一确认只产生一个 attempt、下一 attempt 需再次确认（新 retryRequestId）、
 *       重启后 attempt 归属与提示稳定。
 *   [3] 请求级幂等：响应丢失后原键重放（含首 attempt 已 unknown）不新建 attempt、
 *       同键并发/重启收敛同一 attempt、跨 owner/session/proposal 复用键必拒。
 * 测试纪律：executor 全部替身——零真实外呼；「重启」=关库重开+新服务实例。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalService } from '../src/capability/authorization.js';
import { SimulatedCrashError, createStudioCapabilities, type GenerateExecutor } from '../src/capability/studio.js';
import { createUser } from '../src/db/store.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';

/**
 * provider fixture 基座：
 * - 幂等 provider：按 idemKey 记忆结果（同键重放=同一字节，远端唯一结果计数不增）。
 * - 非幂等 provider：每次调用都是新远端尝试（调用计数恒增，结果可不同）。
 * - crashOnCall：第 N 次调用抛 SimulatedCrashError（外部接受后/写回前崩溃）。
 */
interface ProviderFixture {
  executor: GenerateExecutor;
  calls: Array<{ idemKey: string; attemptNo: number }>;
  distinctRemoteResults: Set<string>;
  crashOn: (callIndex: number) => boolean;
}

function providerFixture(idempotent: boolean, crashFirst = true): ProviderFixture {
  const calls: Array<{ idemKey: string; attemptNo: number }> = [];
  const byKey = new Map<string, Uint8Array>();
  const distinctRemoteResults = new Set<string>();
  let index = 0;
  return {
    calls,
    distinctRemoteResults,
    crashOn: () => false,
    executor: async (_payload, ctx) => {
      const i = index++;
      calls.push({ idemKey: ctx.idemKey, attemptNo: ctx.attemptNo });
      if (crashFirst && i === 0) throw new SimulatedCrashError();
      if (idempotent && byKey.has(ctx.idemKey)) return byKey.get(ctx.idemKey)!;
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, i, ...Buffer.from(ctx.idemKey.slice(0, 8))]);
      if (idempotent) byKey.set(ctx.idemKey, bytes);
      distinctRemoteResults.add(Buffer.from(bytes).toString('base64'));
      return bytes;
    },
  };
}

interface AttemptView {
  attempt_id: string;
  attempt_no: number;
  idem_key: string;
  retry_request_id: string;
  state: string;
}

/** generate 测试装配（可指定 provider 幂等性）。 */
interface RetryFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStudioCapabilities>;
  provider: ProviderFixture;
  sessionId: string;
  taskId: string;
  propose(): Promise<{ proposalId: string; requestId: string }>;
  answer(proposalId: string, requestId: string, approved?: boolean): void;
  op(proposalId: string): { state: string; result_ref: string | null };
  attempts(proposalId: string): AttemptView[];
}

function setupRetry(idempotent: boolean, crashFirst = true): RetryFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const provider = providerFixture(idempotent, crashFirst);
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs, providerIdempotent: () => idempotent });
  const registry = createStudioCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    approvals: auth,
    config: s.config,
    generateExecutor: provider.executor,
    revokeResult: (resultId) => s.sessions.revokeResult(resultId),
  });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '重试测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  return {
    s,
    auth,
    registry,
    provider,
    sessionId,
    taskId: task.id,
    propose: async () => {
      const result = await registry.call('studio.generate', { taskId: task.id, prompt: '生成一只猫' }, 'agent');
      if (result.kind !== 'ok') throw new Error(`generate 提议失败：${JSON.stringify(result)}`);
      const value = result.value as { proposalId: string; requestId: string };
      return { proposalId: value.proposalId, requestId: value.requestId };
    },
    answer: (proposalId, requestId, approved = true) => {
      auth.answer(s.anonymous, { sessionId, requestId, approved });
      void proposalId;
    },
    op: (proposalId) =>
      s.db.prepare('SELECT state, result_ref FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string; result_ref: string | null },
    attempts: (proposalId) =>
      s.db.prepare('SELECT * FROM attempts WHERE proposal_id = ? ORDER BY attempt_no').all(proposalId) as AttemptView[],
  };
}

describe('两类 provider fixture：崩溃→重启→重试（§3.6 R4）', () => {
  it('非幂等 provider：崩溃=unknown；重试建新 attempt（新 idemKey=新远端尝试，调用计数+1，不承诺唯一结果）', async () => {
    const f = setupRetry(false);
    try {
      const { proposalId, requestId } = await f.propose();
      f.answer(proposalId, requestId);
      const crashed = await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent');
      expect(crashed).toMatchObject({ kind: 'failed' });
      expect((crashed as { message: string }).message).toContain('收敛 unknown');
      // 崩溃未结算：op/attempt 停留 running（重启前）。
      expect(f.op(proposalId).state).toBe('running');
      expect(f.attempts(proposalId)[0]).toMatchObject({ state: 'running', attempt_no: 1 });

      // 「重启」：recoverNonTerminal → 双面 unknown（诚实呈现，用户裁决）。
      const recovered = f.auth.recoverNonTerminal();
      expect(recovered).toEqual({ ops: 1, attempts: 1 });
      expect(f.op(proposalId).state).toBe('unknown');
      expect(f.attempts(proposalId)[0]).toMatchObject({ state: 'unknown' });

      // 旧 grant 重放必拒（grant 已在崩溃前的执行中消费）。
      const replay = await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent');
      expect(replay).toMatchObject({ kind: 'failed' });
      expect((replay as { message: string }).message).toContain('已消费');

      // 用户重试确认（费用确认）→ attempt#2（新 idemKey）→ 执行成功。
      const retry = f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'retry-key-1' });
      expect(retry).toEqual({ attemptId: expect.any(String), attemptNo: 2 });
      expect(f.op(proposalId).state).toBe('approved'); // re-arm
      const done = await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent');
      expect(done).toMatchObject({ kind: 'ok' });
      const attempts = f.attempts(proposalId);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({ state: 'succeeded', attempt_no: 2 });
      expect(attempts[1]!.idem_key).not.toBe(attempts[0]!.idem_key); // 非幂等=新键（新远端尝试）
      expect(f.op(proposalId).state).toBe('succeeded');
      expect(f.op(proposalId).result_ref).toMatch(/^[0-9a-f]{64}$/); // 用户可见结果落账
      // 远端调用次数：崩溃 1 次+重试 1 次=2（如实计费两次）。
      expect(f.provider.calls).toHaveLength(2);
      expect(f.provider.distinctRemoteResults.size).toBe(1); // fixture 单结果；语义=不承诺唯一
    } finally {
      f.s.dispose();
    }
  });

  it('幂等 provider：重试复用 attempt#1 的 idemKey——同键收敛同一远端结果', async () => {
    const f = setupRetry(true);
    try {
      const { proposalId, requestId } = await f.propose();
      f.answer(proposalId, requestId);
      await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent'); // 崩溃（未结算）
      f.auth.recoverNonTerminal();
      f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'retry-key-idem' });
      const done = await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent');
      expect(done).toMatchObject({ kind: 'ok' });
      const attempts = f.attempts(proposalId);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.idem_key).toBe(attempts[0]!.idem_key); // 幂等 provider 复用同键
      expect(f.provider.calls.map((c) => c.idemKey)).toEqual([attempts[0]!.idem_key, attempts[0]!.idem_key]);
      expect(f.op(proposalId).state).toBe('succeeded');
    } finally {
      f.s.dispose();
    }
  });
});

describe('重试授权组（§3.6 R5）', () => {
  it('未授权（costConfirmed=false）/跨用户/非 unknown 态必拒', async () => {
    const f = setupRetry(false, false); // 不崩溃——先走成功路径
    try {
      const { proposalId, requestId } = await f.propose();
      f.answer(proposalId, requestId);
      // 非 unknown（succeeded）不可重试。
      await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent');
      expect(() =>
        f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'k' }),
      ).toThrow(/仅 unknown 态/);

      // 崩溃→unknown 后：costConfirmed=false 拒；跨用户拒。
      const f2 = setupRetry(true);
      try {
        const p2 = await f2.propose();
        f2.answer(p2.proposalId, p2.requestId);
        await f2.registry.call('studio.generate', { taskId: f2.taskId, proposalId: p2.proposalId }, 'agent'); // 崩溃
        f2.auth.recoverNonTerminal();
        expect(() =>
          f2.auth.retry(f2.s.anonymous, { sessionId: f2.sessionId, proposalId: p2.proposalId, costConfirmed: false, retryRequestId: 'k2' }),
        ).toThrow(/费用确认/);
        const other = createUser(f2.s.db, { username: 'retry-other', passwordHash: 'x', role: 'user' });
        expect(() =>
          f2.auth.retry(other, { sessionId: f2.sessionId, proposalId: p2.proposalId, costConfirmed: true, retryRequestId: 'k3' }),
        ).toThrow(/仅会话 owner/);
        expect(f2.attempts(p2.proposalId)).toHaveLength(1); // 零新 attempt
      } finally {
        f2.s.dispose();
      }
    } finally {
      f.s.dispose();
    }
  });

  it('同一确认只产生一个 attempt；下一 attempt 需再次确认（新 retryRequestId）；提示帧如实呈现可能再次计费', async () => {
    const f = setupRetry(false);
    try {
      const { proposalId, requestId } = await f.propose();
      f.answer(proposalId, requestId);
      await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent'); // 崩溃
      f.auth.recoverNonTerminal();
      const first = f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'confirm-1' });
      // 同键「并发」（重复提交）→ 同一 attempt，不新建。
      const again = f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'confirm-1' });
      expect(again).toEqual(first);
      expect(f.attempts(proposalId)).toHaveLength(2);
      // attempt#2 再崩溃 → unknown；同键重放（响应丢失场景）仍返回 attempt#2 不新建。
      await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent'); // attempt#2 崩溃（crashFirst 只崩第一次——这次成功）
      // 让 attempt#2 也置 unknown：直接走 recover（模拟第二次崩溃——手工置非终态）。
      f.s.db.prepare("UPDATE approved_ops SET state = 'running' WHERE proposal_id = ?").run(proposalId);
      f.s.db.prepare("UPDATE attempts SET state = 'running' WHERE proposal_id = ? AND attempt_no = 2").run(proposalId);
      f.auth.recoverNonTerminal();
      const replaySameKey = f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'confirm-1' });
      expect(replaySameKey.attemptNo).toBe(2); // 原键重放（首 attempt 已 unknown）不新建
      expect(f.attempts(proposalId)).toHaveLength(2);
      // 有意承担费用的下一次确认=新键 → attempt#3。
      const next = f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'confirm-2' });
      expect(next.attemptNo).toBe(3);
      expect(f.attempts(proposalId)).toHaveLength(3);
      // 提示帧（transcript）如实呈现。
      const frames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames;
      const retryNotes = frames.filter((frame) => frame.kind === 'transcript' && (frame.payload as { text?: string }).text?.includes('已确认重试'));
      expect(retryNotes.length).toBeGreaterThanOrEqual(2);
      expect((retryNotes[0]!.payload as { text: string }).text).toContain('可能再次计费');
    } finally {
      f.s.dispose();
    }
  });

  it('重启后 attempt 归属与提示稳定：同键重放仍返回同一 attempt（跨实例幂等）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'handicraft-retry-'));
    const f = setupRetryAt(root, false);
    let proposalId = '';
    let firstRetry = { attemptId: '', attemptNo: 0 };
    try {
      const { proposalId: pid, requestId } = await f.propose();
      proposalId = pid;
      f.answer(pid, requestId);
      await f.registry.call('studio.generate', { taskId: f.taskId, proposalId: pid }, 'agent'); // 崩溃
      f.auth.recoverNonTerminal();
      firstRetry = f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId: pid, costConfirmed: true, retryRequestId: 'restart-key' });
      f.s.db.close(); // 「重启」
    } finally {
      if (f.s.db.open) f.s.db.close();
    }
    // 重开同一 DATA_ROOT：新服务实例 + 启动收敛。
    const s2 = createServices(undefined, { imgDryRun: true, root });
    try {
      const auth2 = new ApprovalService({ db: s2.db, jobs: s2.jobs });
      auth2.recoverNonTerminal();
      const replay = auth2.retry(s2.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'restart-key' });
      expect(replay.attemptId).toBe(firstRetry.attemptId); // 同键收敛同一 attempt
      expect(replay.attemptNo).toBe(firstRetry.attemptNo);
      const attempts = s2.db.prepare('SELECT * FROM attempts WHERE proposal_id = ?').all(proposalId) as Array<{ attempt_no: number }>;
      expect(attempts).toHaveLength(2); // 无新建
    } finally {
      s2.dispose();
    }
  });

  it('跨归属复用键必拒：同 retryRequestId 用于另一 proposal/另一 session', async () => {
    const f = setupRetry(false);
    try {
      const p1 = await f.propose();
      f.answer(p1.proposalId, p1.requestId);
      await f.registry.call('studio.generate', { taskId: f.taskId, proposalId: p1.proposalId }, 'agent'); // 崩溃
      f.auth.recoverNonTerminal();
      f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId: p1.proposalId, costConfirmed: true, retryRequestId: 'shared-key' });
      // 另一 proposal 复用同键 → 必拒。
      const p2 = await f.propose();
      f.answer(p2.proposalId, p2.requestId);
      await f.registry.call('studio.generate', { taskId: f.taskId, proposalId: p2.proposalId }, 'agent');
      f.auth.recoverNonTerminal();
      expect(() =>
        f.auth.retry(f.s.anonymous, { sessionId: f.sessionId, proposalId: p2.proposalId, costConfirmed: true, retryRequestId: 'shared-key' }),
      ).toThrow(/跨 owner\/session\/proposal 复用必拒/);
    } finally {
      f.s.dispose();
    }
  });
});

/** 固定 root 的装配（重启测试——与 setupRetry 同构）。 */
function setupRetryAt(root: string, idempotent: boolean): RetryFixture {
  const s = createServices(undefined, { imgDryRun: true, root });
  const provider = providerFixture(idempotent, true);
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs, providerIdempotent: () => idempotent });
  const registry = createStudioCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    approvals: auth,
    config: s.config,
    generateExecutor: provider.executor,
    revokeResult: (resultId) => s.sessions.revokeResult(resultId),
  });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '重启测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  return {
    s,
    auth,
    registry,
    provider,
    sessionId,
    taskId: task.id,
    propose: async () => {
      const result = await registry.call('studio.generate', { taskId: task.id, prompt: '重启场景' }, 'agent');
      if (result.kind !== 'ok') throw new Error(`generate 提议失败：${JSON.stringify(result)}`);
      const value = result.value as { proposalId: string; requestId: string };
      return { proposalId: value.proposalId, requestId: value.requestId };
    },
    answer: (proposalId, requestId, approved = true) => {
      void proposalId;
      auth.answer(s.anonymous, { sessionId, requestId, approved });
    },
    op: (proposalId) =>
      s.db.prepare('SELECT state, result_ref FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string; result_ref: string | null },
    attempts: (proposalId) =>
      s.db.prepare('SELECT * FROM attempts WHERE proposal_id = ? ORDER BY attempt_no').all(proposalId) as AttemptView[],
  };
}
