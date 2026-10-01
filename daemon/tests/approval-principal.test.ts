/**
 * 批准后执行的消费主体域（真链走查 P1-2 修复锁——2026-10-01）。
 * 走查症状：匿名会话策略提案→对话式批准后执行被 denied/principal-forbidden
 * （agent 误读「RBAC：agent 主体可提案不可执行」→故事闭环断）。
 * 勘察结论：
 *   [1] consumeForExecution 的项目域（W6 6.2 grants.session_id）在同会话跨轮恒放行
 *       ——本文件用 capability 全链（generate 双模）锁该行为。
 *   [2] principal-forbidden 曾同时承接「真直调」「proposalId 无效」「grant 未签发」
 *       三类语义——后两类分层为可读 failed+行动指引（agent 可自纠：等待审批卡应答/
 *       取回完整 proposalId），principal-forbidden 仅留输入未携带 proposalId 的
 *       无授权直调。
 *   [3] [P1-2 口径修正] grant 消费主体=会话域（用户批准的 grant，执行主体允许是
 *       代表该用户的 agent 任务）：grant.user_id 不再与调用侧逐一比对——签发会话=
 *       消费上下文会话即合法；跨会话仍必拒。与 auto_approve（propose 即签发）语义
 *       正交。
 * 覆盖：
 *   [A] 匿名会话：propose（轮A 任务）→answer 批准→execute（轮B 任务，同会话）→ok。
 *   [B] 跨会话执行必拒（task-mismatch，grant 不焚）。
 *   [C] 无 proposalId 直调=denied principal-forbidden（旧语义保持——真直调）。
 *   [D] proposalId 无效=failed INVALID_OPERATION+完整 ID 指引（非 principal-forbidden）。
 *   [E] 未批准即执行=failed INVALID_OPERATION+「尚未获用户批准」指引。
 *   [F] grant.user_id 与执行 owner 不一致（迁移/病态行）但同会话=放行（主体域=会话）。
 *   [G] auto_approve 会话：propose 即签发，跨轮任务执行 ok（正交不破坏）。
 * 测试纪律：generate 执行器替身（零外呼）；进程内 fake。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalService } from '../src/capability/authorization.js';
import { createStudioCapabilities, type GenerateExecutor } from '../src/capability/studio.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createUser } from '../src/db/store.js';
import { createServices, type TestServices } from './helpers.js';

const okExecutor: GenerateExecutor = async () => new Uint8Array([1, 2, 3, 4]);

interface PrincipalFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStudioCapabilities>;
  sessionId: string;
  taskA: string;
  /** 经 capability 发起 generate proposal 并（可选）批准；返回工具返回值。 */
  proposeViaTool(input?: { taskId?: string }): Promise<Record<string, unknown>>;
  answer(requestId: string): void;
  dispose(): void;
}

function setup(): PrincipalFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createStudioCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    approvals: auth,
    config: s.config,
    generateExecutor: okExecutor,
    revokeResult: (resultId) => s.sessions.revokeResult(resultId),
  });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '主体域测试' });
  const taskA = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' }).id;
  return {
    s,
    auth,
    registry,
    sessionId,
    taskA,
    proposeViaTool: async (input) => {
      const result = await registry.call(
        'studio.generate',
        { taskId: input?.taskId ?? taskA, prompt: '主体域测试图' },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'ok' });
      return (result as { value: Record<string, unknown> }).value;
    },
    answer: (requestId) => {
      auth.answer(s.anonymous, { sessionId, requestId, approved: true });
    },
    dispose: () => s.dispose(),
  };
}

function grantRow(f: PrincipalFixture, proposalId: string): { consumed: number; session_id: string | null; user_id: string } {
  return f.s.db
    .prepare('SELECT consumed, session_id, user_id FROM grants WHERE proposal_id = ?')
    .get(proposalId) as { consumed: number; session_id: string | null; user_id: string };
}

describe('批准后执行的消费主体域（P1-2——grant 绑会话而非调用者身份）', () => {
  it('[A] 匿名会话跨轮：propose（轮A）→批准→execute（轮B 同会话）→ok（agent 任务=合法消费主体）', async () => {
    const f = setup();
    try {
      const proposed = await f.proposeViaTool();
      f.answer(proposed['requestId'] as string);
      // 下一轮 followup 产物：同会话新 agent 任务（每轮一任务——kernel followup 同构）。
      const taskB = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'running' });
      const executed = await f.registry.call(
        'studio.generate',
        { taskId: taskB.id, proposalId: proposed['proposalId'] as string },
        'agent',
      );
      expect(executed).toMatchObject({ kind: 'ok' });
      expect((executed as { value: { blobRef?: string } }).value.blobRef).toBeTruthy();
      expect(grantRow(f, proposed['proposalId'] as string).consumed).toBe(1); // 消费即焚
      expect(f.auth.opOf(proposed['proposalId'] as string)?.state).toBe('succeeded');
    } finally {
      f.dispose();
    }
  });

  it('[B] 跨会话执行必拒（task-mismatch）；grant 不被烧毁', async () => {
    const f = setup();
    try {
      const proposed = await f.proposeViaTool();
      f.answer(proposed['requestId'] as string);
      const other = f.s.sessions.create(f.s.anonymous, { title: '另一项目' });
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: other.sessionId, status: 'running' });
      const denied = await f.registry.call(
        'studio.generate',
        { taskId: otherTask.id, proposalId: proposed['proposalId'] as string },
        'agent',
      );
      expect(denied).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((denied as { message: string }).message).toContain('跨项目');
      expect(grantRow(f, proposed['proposalId'] as string).consumed).toBe(0); // 拒绝面不烧毁
    } finally {
      f.dispose();
    }
  });

  it('[C] 无 proposalId 直调=denied principal-forbidden（真·无授权直调语义保持）', async () => {
    const f = setup();
    try {
      // patch-apply 执行模式必带 proposalId：缺省即直调形态。
      const denied = await f.registry.call('studio.patch-apply', { taskId: f.taskA }, 'agent');
      expect(denied).toMatchObject({ kind: 'denied', reason: 'principal-forbidden', requestedOperation: 'studio.patch-apply' });
    } finally {
      f.dispose();
    }
  });

  it('[D] proposalId 无效（截断/误抄）=failed INVALID_OPERATION+完整 ID 指引（非 principal-forbidden——agent 可自纠）', async () => {
    const f = setup();
    try {
      const result = await f.registry.call(
        'studio.generate',
        { taskId: f.taskA, proposalId: '1130652e' }, // 走查形态：8 位短码（完整 ID 为 UUID）
        'agent',
      );
      expect(result).not.toMatchObject({ kind: 'denied' });
      expect(result).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      const message = (result as { message: string }).message;
      expect(message).toContain('proposal-unknown');
      expect(message).toContain('完整');
    } finally {
      f.dispose();
    }
  });

  it('[E] 未批准即执行=failed INVALID_OPERATION+「尚未获用户批准」指引（文字回复不构成批准）', async () => {
    const f = setup();
    try {
      const proposed = await f.proposeViaTool(); // 不 answer——对话式文字批准不落 grant
      const result = await f.registry.call(
        'studio.generate',
        { taskId: f.taskA, proposalId: proposed['proposalId'] as string },
        'agent',
      );
      expect(result).not.toMatchObject({ kind: 'denied' });
      expect(result).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((result as { message: string }).message).toContain('尚未获用户批准');
      expect((result as { message: string }).message).toContain('approval-request');
    } finally {
      f.dispose();
    }
  });

  it('[F] grant.user_id 与执行 owner 不一致（迁移/病态行）但同会话=放行（主体域=会话，非调用者身份）', async () => {
    const f = setup();
    try {
      const proposed = await f.proposeViaTool();
      f.answer(proposed['requestId'] as string);
      // 病态行模拟：历史/迁移面 grant.user_id 与当前任务 owner 失配（旧口径在此误杀
      // 同会话合法任务执行——task-mismatch；新口径以会话域判定放行）。
      const stranger = createUser(f.s.db, { username: 'legacy-grant-user', passwordHash: 'x', role: 'user' });
      f.s.db
        .prepare('UPDATE grants SET user_id = ? WHERE proposal_id = ?')
        .run(stranger.id, proposed['proposalId'] as string);
      const taskB = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'running' });
      const executed = await f.registry.call(
        'studio.generate',
        { taskId: taskB.id, proposalId: proposed['proposalId'] as string },
        'agent',
      );
      expect(executed).toMatchObject({ kind: 'ok' });
    } finally {
      f.dispose();
    }
  });

  it('[G] auto_approve 会话：propose 即签发 grant，跨轮任务执行 ok（与自动批准正交不破坏）', async () => {
    const f = setup();
    try {
      f.s.db.prepare('UPDATE sessions SET auto_approve = 1 WHERE id = ?').run(f.sessionId);
      const proposed = await f.proposeViaTool();
      // propose 即签发（中央单点）：无需 answer，grant 已在案（auto_approved=1 审计标记）。
      const grant = grantRow(f, proposed['proposalId'] as string);
      expect(grant.consumed).toBe(0);
      expect(grant.session_id).toBe(f.sessionId);
      expect(
        (f.s.db.prepare('SELECT auto_approved FROM grants WHERE proposal_id = ?').get(proposed['proposalId'] as string) as { auto_approved: number }).auto_approved,
      ).toBe(1);
      const taskB = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'running' });
      const executed = await f.registry.call(
        'studio.generate',
        { taskId: taskB.id, proposalId: proposed['proposalId'] as string },
        'agent',
      );
      expect(executed).toMatchObject({ kind: 'ok' });
      expect(grantRow(f, proposed['proposalId'] as string).consumed).toBe(1);
    } finally {
      f.dispose();
    }
  });
});
