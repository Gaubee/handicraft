/**
 * [grant-consumed 死锁恢复通道，2026-10-01 P0] studio.task.proposals.list 测试。
 * 实证病灶：grant 被一次执行消费后 agent 对 proposal 状态零可见（帧流原话
 * 「有两种可能①已落档②中途夭折——无法甄别」），session.retry 又无 UI 按钮——
 * 恢复通道=agent 侧只读状态面+逐状态行动指引。覆盖：
 *   [1] 未批准（无 grant）→ advice=向用户呈现预览等待批准。
 *   [2] 已批准待执行（grant 未消费）→ advice=携带 proposalId 走 execute。
 *   [3] 已成功（succeeded+resultRef）→ advice=勿重放直接继续。
 *   [4] 授权已被消费且产物未落档（supersede 形态：同 digest 新提案使旧 grant 失效）
 *       → advice=勿重试 execute，重新发起 proposal。
 *   [5] 执行中（claimed/running）→ advice=勿并发重放。
 *   [6] proposalId 过滤：跨项目拒/不存在 NOT_FOUND。
 *   [7] 会话域清单=本项目全部 proposal（跨会话不串）。
 */
import { describe, expect, it } from 'vitest';
import { createServices, type TestServices } from './helpers.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { createTaskProposalsCapabilities } from '../src/capability/task-proposals.js';
import { createAgentTask } from '../src/db/jobs.js';

interface Fixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createTaskProposalsCapabilities>;
  sessionId: string;
  taskId: string;
}

function setup(): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createTaskProposalsCapabilities({ db: s.db });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '提案观察' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  return { s, auth, registry, sessionId, taskId: task.id };
}

function propose(f: Fixture, overrides: Record<string, unknown> = {}) {
  const sheet = f.s.blobs.put(new Uint8Array([0x61]));
  return f.auth.propose({
    taskId: f.taskId,
    userId: f.s.anonymous.id,
    tool: 'studio.export',
    payload: { kind: 'export', resourceId: 'res-1', withPng: true, ...overrides },
    preview: { before: sheet.hash, after: sheet.hash },
    summary: '导出贴钻',
  });
}

async function callList(f: Fixture, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await f.registry.call('studio.task.proposals.list', { taskId: f.taskId, ...input }, 'agent');
  return result as unknown as Record<string, unknown>;
}

async function okValue(f: Fixture, input: Record<string, unknown> = {}): Promise<{
  proposals: Array<Record<string, unknown>>;
}> {
  const result = await callList(f, input);
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: { proposals: Array<Record<string, unknown>> } }).value;
}

describe('studio.task.proposals.list（恢复通道只读面）', () => {
  it('未批准：grant.total=0，advice 指引向用户呈现预览', async () => {
    const f = setup();
    try {
      const issued = propose(f);
      const value = await okValue(f);
      expect(value.proposals).toHaveLength(1);
      const row = value.proposals[0]!;
      expect(row['proposalId']).toBe(issued.proposalId);
      expect(row['state']).toBe('approved');
      expect(row['grant']).toEqual({ total: 0, unconsumed: 0 });
      expect(String(row['advice'])).toContain('呈现预览');
    } finally {
      f.s.dispose();
    }
  });

  it('已批准待执行：grant 未消费，advice 指引走 execute', async () => {
    const f = setup();
    try {
      const issued = propose(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: issued.requestId, approved: true });
      const value = await okValue(f);
      expect(value.proposals[0]?.['grant']).toEqual({ total: 1, unconsumed: 1 });
      expect(String(value.proposals[0]?.['advice'])).toContain('execute');
    } finally {
      f.s.dispose();
    }
  });

  it('已成功：resultRef 在案，advice=勿重放直接继续', async () => {
    const f = setup();
    try {
      const issued = propose(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: issued.requestId, approved: true });
      const consumed = f.auth.consumeForExecution({
        proposalId: issued.proposalId,
        taskId: f.taskId,
        userId: f.s.anonymous.id,
        tool: 'studio.export',
      });
      expect(consumed.ok).toBe(true);
      f.auth.settleExternal(issued.proposalId, { kind: 'succeeded', resultRef: 'blob-abc' });
      const value = await okValue(f, { proposalId: issued.proposalId });
      expect(value.proposals).toHaveLength(1);
      expect(value.proposals[0]?.['state']).toBe('succeeded');
      expect(value.proposals[0]?.['resultRef']).toBe('blob-abc');
      expect(value.proposals[0]?.['grant']).toEqual({ total: 1, unconsumed: 0 });
      expect(String(value.proposals[0]?.['advice'])).toContain('勿重放');
    } finally {
      f.s.dispose();
    }
  });

  it('执行中（claimed）：advice=勿并发重放', async () => {
    const f = setup();
    try {
      const issued = propose(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: issued.requestId, approved: true });
      const consumed = f.auth.consumeForExecution({
        proposalId: issued.proposalId,
        taskId: f.taskId,
        userId: f.s.anonymous.id,
        tool: 'studio.export',
      });
      expect(consumed.ok).toBe(true); // 消费即 claim（approved→claimed）。
      const value = await okValue(f, { proposalId: issued.proposalId });
      expect(value.proposals[0]?.['state']).toBe('claimed');
      expect(String(value.proposals[0]?.['advice'])).toContain('勿并发重放');
    } finally {
      f.s.dispose();
    }
  });

  it('授权已被消费且产物未落档（supersede 同 digest 新提案）：advice=重新发起 proposal', async () => {
    const f = setup();
    try {
      const first = propose(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: first.requestId, approved: true });
      // 同 digest 新提案批准 → 一键一活：旧 grant superseded（consumed=1），
      // 旧 op 仍 approved——「授权已消费、产物未落档」的观测形态。
      const second = propose(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: second.requestId, approved: true });
      const value = await okValue(f, { proposalId: first.proposalId });
      expect(value.proposals[0]?.['state']).toBe('approved');
      expect(value.proposals[0]?.['grant']).toEqual({ total: 1, unconsumed: 0 });
      expect(String(value.proposals[0]?.['advice'])).toContain('重新发起 proposal');
    } finally {
      f.s.dispose();
    }
  });

  it('proposalId 过滤：不存在=NOT_FOUND；跨项目=typed 拒；会话域清单不串会话', async () => {
    const f = setup();
    try {
      const bogus = await callList(f, { proposalId: '00000000-0000-4000-8000-000000000000' });
      expect(bogus).toMatchObject({ kind: 'failed', code: 'NOT_FOUND' });

      const issued = propose(f);
      // 同 db 第二项目（会话+任务）——读第一项目的 proposal=跨项目 typed 拒。
      const otherSession = f.s.sessions.create(f.s.anonymous, { title: '另一项目' });
      const otherTask = createAgentTask(f.s.db, {
        ownerId: f.s.anonymous.id,
        sessionId: otherSession.sessionId,
        status: 'running',
      });
      const cross = await f.registry.call(
        'studio.task.proposals.list',
        { taskId: otherTask.id, proposalId: issued.proposalId },
        'agent',
      );
      expect(cross).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect(String((cross as { message?: string }).message)).toContain('不属于当前项目');
      // 跨会话的清单不含他项目的 proposal。
      const mine = await okValue(f, { taskId: otherTask.id });
      expect(mine.proposals).toHaveLength(0);
    } finally {
      f.s.dispose();
    }
  });
});
