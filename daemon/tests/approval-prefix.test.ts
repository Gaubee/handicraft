/**
 * proposal 前缀容错查询单测（P0-3 真链走查 2026-10-01：审批卡曾只显 8 位截断 ID
 * ——用户/agent 转述截断后 consume proposal-unknown 死循环）。
 *
 * 语义把守（authorization.ts resolveProposalId）：
 *   [1] 完整 ID 精确命中=既有快路径（不因容错改语义）；
 *   [2] 截断前缀在**消费上下文会话**内恰一命中=解析放行（绑定校验照走）；
 *   [3] 多命中=proposal-unknown 携可读候选清单（不猜）；
 *   [4] 零命中/过短前缀/完整长度 ID=proposal-unknown（行动指引文案）；
 *   [5] 域隔离：他会话的前缀唯一命中不解析（前缀不跨项目泄配）；
 *   [6] precheckMutation 同语义（上下文任务在场才做前缀解析）。
 * 测试纪律：进程内 fake（createServices），零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalService, digestOf } from '../src/capability/authorization.js';
import { createAgentTask } from '../src/db/jobs.js';
import { insertApprovedOp } from '../src/db/approvals.js';
import { createServices, type TestServices } from './helpers.js';

interface PrefixFixture {
  s: TestServices;
  auth: ApprovalService;
  sessionId: string;
  /** 消费上下文任务（proposal 签发与消费同任务——同会话内）。 */
  consumeTaskId: string;
}

function setup(): PrefixFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '前缀容错' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  return { s, auth, sessionId, consumeTaskId: task.id };
}

/** 签发任务的 approval-request requestId（帧流取回——answer 消费）。 */
function requestIdOf(f: PrefixFixture): string {
  const frame = f.s.jobs.frames(f.s.anonymous, f.consumeTaskId, 0).frames.find((x) => x.kind === 'approval-request');
  return (frame!.payload as { requestId: string }).requestId;
}

/** 真实 propose 链（approval-request 帧走 jobs——与生产同路）。 */
function proposeOf(f: PrefixFixture, tool: 'task-export' | 'strategy-design' = 'task-export'): string {
  return f.auth
    .propose({
      taskId: f.consumeTaskId,
      userId: f.s.anonymous.id,
      tool,
      payload: { kind: 'export', resourceId: 'res-test', withPng: false },
      preview: { before: 'a'.repeat(64), after: 'b'.repeat(64) },
      summary: '前缀容错测试',
    })
    .proposalId;
}

/** 直接落行（多命中/跨会话 fixture——crafted proposal_id 共享前缀）。 */
function insertOp(f: PrefixFixture, proposalId: string, taskId?: string): void {
  insertApprovedOp(f.s.db, {
    proposalId,
    taskId: taskId ?? f.consumeTaskId,
    userId: f.s.anonymous.id,
    tool: 'task-export',
    opDigest: digestOf({ tool: 'task-export', payload: { kind: 'export', resourceId: 'res-test', withPng: false } }),
    resourceId: null,
    requestId: `req-${proposalId.slice(0, 8)}`,
    payloadJson: '{"kind":"export","resourceId":"res-test","withPng":false}',
    baseRevision: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    previewJson: '{"before":"a","after":"b"}',
    summary: 'crafted',
  });
}

describe('proposal 前缀容错查询（P0-3）', () => {
  it('完整 ID：精确命中快路径不变（propose→answer→consume ok）', () => {
    const f = setup();
    try {
      const proposalId = proposeOf(f);
      const answer = f.auth.answer(f.s.anonymous, {
        sessionId: f.sessionId,
        requestId: requestIdOf(f),
        approved: true,
      });
      expect(answer.ok).toBe(true);
      const consume = f.auth.consumeForExecution({
        proposalId,
        taskId: f.consumeTaskId,
        userId: f.s.anonymous.id,
        tool: 'task-export',
      });
      expect(consume.ok).toBe(true);
      expect(consume.ok && consume.op.proposal_id).toBe(proposalId);
    } finally {
      f.s.dispose();
    }
  });

  it('8 位截断前缀（审批卡历史形态）：会话内恰一命中=解析放行+消费的是完整行', () => {
    const f = setup();
    try {
      const proposalId = proposeOf(f);
      f.auth.answer(f.s.anonymous, {
        sessionId: f.sessionId,
        requestId: requestIdOf(f),
        approved: true,
      });
      const consume = f.auth.consumeForExecution({
        proposalId: proposalId.slice(0, 8), // 用户/agent 抄录截断形态
        taskId: f.consumeTaskId,
        userId: f.s.anonymous.id,
        tool: 'task-export',
      });
      expect(consume.ok).toBe(true);
      expect(consume.ok && consume.op.proposal_id).toBe(proposalId); // 结算/账本都在完整行上
    } finally {
      f.s.dispose();
    }
  });

  it('多命中=proposal-unknown 携可读候选清单（不猜）', () => {
    const f = setup();
    try {
      insertOp(f, 'aabbcc01-0000-4000-8000-000000000001');
      insertOp(f, 'aabbcc02-0000-4000-8000-000000000002');
      const consume = f.auth.consumeForExecution({
        proposalId: 'aabbcc',
        taskId: f.consumeTaskId,
        userId: f.s.anonymous.id,
        tool: 'task-export',
      });
      expect(consume.ok).toBe(false);
      if (!consume.ok) {
        expect(consume.reason).toBe('proposal-unknown');
        expect(consume.message).toContain('aabbcc01-0000-4000-8000-000000000001');
        expect(consume.message).toContain('aabbcc02-0000-4000-8000-000000000002');
        expect(consume.message).toContain('完整 proposalId');
      }
    } finally {
      f.s.dispose();
    }
  });

  it('零命中前缀与过短前缀=proposal-unknown（行动指引文案）', () => {
    const f = setup();
    try {
      for (const bad of ['zzzzzzzz', 'ab']) {
        const consume = f.auth.consumeForExecution({
          proposalId: bad,
          taskId: f.consumeTaskId,
          userId: f.s.anonymous.id,
          tool: 'task-export',
        });
        expect(consume.ok).toBe(false);
        if (!consume.ok) {
          expect(consume.reason).toBe('proposal-unknown');
          expect(consume.message).toContain('完整 ID');
        }
      }
    } finally {
      f.s.dispose();
    }
  });

  it('域隔离：他会话的同前缀唯一命中不解析（前缀不跨项目泄配）', () => {
    const f = setup();
    try {
      const { sessionId: otherSession } = f.s.sessions.create(f.s.anonymous, { title: '他会话' });
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession, status: 'running' });
      insertOp(f, 'aabbcc03-0000-4000-8000-000000000003', otherTask.id);
      const consume = f.auth.consumeForExecution({
        proposalId: 'aabbcc03', // 全局唯一，但不在消费上下文会话
        taskId: f.consumeTaskId,
        userId: f.s.anonymous.id,
        tool: 'task-export',
      });
      expect(consume.ok).toBe(false);
      if (!consume.ok) expect(consume.reason).toBe('proposal-unknown');
    } finally {
      f.s.dispose();
    }
  });

  it('precheckMutation：上下文任务在场时前缀恰一命中放行；缺席时退化为精确匹配', () => {
    const f = setup();
    try {
      const proposalId = proposeOf(f);
      f.auth.answer(f.s.anonymous, {
        sessionId: f.sessionId,
        requestId: requestIdOf(f),
        approved: true,
      });
      // 上下文在场（同会话）→ 前缀解析放行。
      expect(f.auth.precheckMutation('task-export', { proposalId: proposalId.slice(0, 8), taskId: f.consumeTaskId }).ok).toBe(true);
      // 上下文缺席 → 不做前缀解析（精确不命中=proposal-unknown）。
      const bare = f.auth.precheckMutation('task-export', { proposalId: proposalId.slice(0, 8) });
      expect(bare.ok).toBe(false);
      expect(bare.reason).toBe('proposal-unknown');
    } finally {
      f.s.dispose();
    }
  });
});
