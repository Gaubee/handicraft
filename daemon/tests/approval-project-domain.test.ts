/**
 * 批准挂项目域测试（add-task-stones-manifest-export 6.2——Owner 裁决 2026-09-30）。
 * 覆盖（tasks.md 6.2/6.3 矩阵）：
 *   [1] 同项目（会话）跨轮消费成功：签发轮 task≠消费轮 task、同会话 → 放行。
 *   [2] 跨项目（新会话）拒：另一会话任务上下文消费 → task-mismatch（跨项目）。
 *   [3] 自动过期：轮次终态后 N 分钟（缺省 30min，注入可调）窗外拒/窗内放行；
 *       非终态（轮次在飞）沿用绝对 TTL；签发任务行缺失（清理孤儿）拒。
 *   [4] 单次消费保持：消费即焚——成功后重放 grant-consumed 必拒。
 *   [5] 新提案覆盖同键旧 grant：同会话+同 user+同 tool+同 digest 重提案批准 →
 *       旧 grant 失效；不同 digest（不同操作）不覆盖。
 *   [6] 项目清理级联：session.clear（markClearing 事务①）→ 会话内未消费 grant
 *       全部烧毁；清理后消费必拒。
 *   [7] 审批卡归属呈现：approval-request 帧携带 projectLabel（会话标题；空标题
 *       回退 sessionId 短码）。
 * 测试纪律：全程进程内 fake——无真实外呼。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalRequestPayloadSchema, type Frame } from '@handicraft/contracts';
import { ApprovalService } from '../src/capability/authorization.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';

/** 项目域过期窗（1 分钟——测试注入；生产缺省 30min，env 可调）。 */
const TTL_MS = 60_000;

/** 帧契约合法的 preview blobRef（64 位十六进制——帧面 strict 校验）。 */
const PREVIEW_A = 'a'.repeat(64);
const PREVIEW_B = 'b'.repeat(64);

interface ProjectFixture {
  s: TestServices;
  auth: ApprovalService;
  sessionId: string;
  taskA: string;
  /** 发起一个 patch 族 proposal 并批准（缺省签发任务=taskA——过期锚定可操控）。 */
  proposeApproved(input?: {
    sessionId?: string;
    taskId?: string;
    payloadTarget?: string;
    approved?: boolean;
  }): Promise<{ proposalId: string; requestId: string }>;
  frames(taskId: string): Frame[];
}

function setupFixture(ttlMs: number = TTL_MS): ProjectFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs, grantProjectTtlMs: ttlMs });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '项目域测试' });
  const taskA = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId }).id;
  return {
    s,
    auth,
    sessionId,
    taskA,
    proposeApproved: async (input) => {
      const sid = input?.sessionId ?? sessionId;
      const task =
        input?.taskId ??
        (sid === sessionId ? taskA : createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId: sid }).id);
      const target = input?.payloadTarget ?? 'b1';
      const proposed = auth.propose({
        taskId: task,
        userId: s.anonymous.id,
        tool: 'studio.patch-apply',
        payload: {
          kind: 'patch-apply',
          resourceId: 'r-1',
          region: { kind: 'blocks', ids: [target] },
          ops: [{ op: 'setDensity', target, after: 0.5 }],
        },
        preview: { before: PREVIEW_A, after: PREVIEW_B },
        summary: `把块 ${target} 密度→0.5`,
      });
      auth.answer(s.anonymous, { sessionId: sid, requestId: proposed.requestId, approved: input?.approved ?? true });
      return { proposalId: proposed.proposalId, requestId: proposed.requestId };
    },
    frames: (taskId) => s.jobs.frames(s.anonymous, taskId, 0).frames,
  };
}

function grantOf(f: ProjectFixture, proposalId: string): { consumed: number; session_id: string | null } {
  return f.s.db
    .prepare('SELECT consumed, session_id FROM grants WHERE proposal_id = ?')
    .get(proposalId) as { consumed: number; session_id: string | null };
}

describe('同项目跨轮与跨项目（6.2 核心语义）', () => {
  it('同项目跨轮消费成功：签发轮 taskA≠消费轮 taskB（同会话）→ grant 放行+单次消费保持', async () => {
    const f = setupFixture();
    try {
      const { proposalId } = await f.proposeApproved();
      // grant 行携带项目域锚（session_id 列——v13 迁移面）。
      expect(grantOf(f, proposalId)).toMatchObject({ consumed: 0, session_id: f.sessionId });
      // 跨轮：新任务（下一轮 followup 产物）消费。
      const taskB = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId });
      const consume = f.auth.consumeForExecution({
        proposalId,
        taskId: taskB.id,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(consume).toMatchObject({ ok: true, via: 'grant' });
      expect(grantOf(f, proposalId).consumed).toBe(1); // 消费即焚（现状保持）
      // 结算（真实执行路径=capability 壳的 settleExternal——直接消费面置 op 终态）。
      f.auth.settleExternal(proposalId, { kind: 'succeeded' });
      // 单次消费：重放（无论同轮/跨轮任务）必拒——grant 已焚+op 终态（grant-consumed
      // 专项面见「新提案覆盖同键」用例：op 仍 approved 而 grant 被覆盖烧毁）。
      const replay = f.auth.consumeForExecution({
        proposalId,
        taskId: taskB.id,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(replay).toMatchObject({ ok: false, reason: 'op-not-approved' });
      const replayOrigin = f.auth.consumeForExecution({
        proposalId,
        taskId: f.taskA,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(replayOrigin).toMatchObject({ ok: false, reason: 'op-not-approved' });
    } finally {
      f.s.dispose();
    }
  });

  it('跨项目（新会话）拒：另一会话任务上下文消费 → task-mismatch（跨项目）；grant 不被消费', async () => {
    const f = setupFixture();
    try {
      const { proposalId } = await f.proposeApproved();
      const otherSession = f.s.sessions.create(f.s.anonymous, { title: '另一项目' });
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession.sessionId });
      const denied = f.auth.consumeForExecution({
        proposalId,
        taskId: otherTask.id,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(denied).toMatchObject({ ok: false, reason: 'task-mismatch' });
      expect((denied as { message: string }).message).toContain('跨项目');
      expect(grantOf(f, proposalId).consumed).toBe(0); // 拒绝面不烧毁
    } finally {
      f.s.dispose();
    }
  });

  it('同轮（签发任务自身）消费照旧放行——既有链路零回归', async () => {
    const f = setupFixture();
    try {
      const { proposalId } = await f.proposeApproved();
      const consume = f.auth.consumeForExecution({
        proposalId,
        taskId: f.taskA,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(consume).toMatchObject({ ok: true, via: 'grant' });
    } finally {
      f.s.dispose();
    }
  });
});

describe('自动过期（轮次终态重锚——env 可调窗）', () => {
  it('签发轮终态后窗内放行：done+updated_at=TTL/2 前 → 跨轮消费 ok', async () => {
    const f = setupFixture();
    try {
      const { proposalId } = await f.proposeApproved();
      f.s.db
        .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
        .run(new Date(Date.now() - TTL_MS / 2).toISOString(), f.taskA);
      const taskB = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId });
      const consume = f.auth.consumeForExecution({
        proposalId,
        taskId: taskB.id,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(consume).toMatchObject({ ok: true, via: 'grant' });
    } finally {
      f.s.dispose();
    }
  });

  it('签发轮终态后窗外拒：done+updated_at=TTL+1s 前 → grant-expired（终态重锚——绝对 TTL 已过仍以重锚窗判定）', async () => {
    const f = setupFixture();
    try {
      const { proposalId } = await f.proposeApproved();
      // 先把绝对 expires_at 也拨到过去（重锚窗必须覆盖/取代绝对窗——跨轮语义）。
      f.s.db
        .prepare('UPDATE grants SET expires_at = ? WHERE proposal_id = ?')
        .run(new Date(Date.now() - TTL_MS * 10).toISOString(), proposalId);
      f.s.db
        .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
        .run(new Date(Date.now() - (TTL_MS + 1000)).toISOString(), f.taskA);
      const taskB = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId });
      const denied = f.auth.consumeForExecution({
        proposalId,
        taskId: taskB.id,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(denied).toMatchObject({ ok: false, reason: 'grant-expired' });
      expect(grantOf(f, proposalId).consumed).toBe(0);
    } finally {
      f.s.dispose();
    }
  });

  it('非终态（轮次在飞）：沿用绝对 TTL——grant.expires_at 过去即拒（批准等待窗口语义不变）', async () => {
    const f = setupFixture();
    try {
      const { proposalId } = await f.proposeApproved();
      f.s.db
        .prepare('UPDATE grants SET expires_at = ? WHERE proposal_id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), proposalId);
      const denied = f.auth.consumeForExecution({
        proposalId,
        taskId: f.taskA,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(denied).toMatchObject({ ok: false, reason: 'grant-expired' });
    } finally {
      f.s.dispose();
    }
  });

  it('签发任务行缺失（清理孤儿）：precheckMutation 只读面按过期拒', async () => {
    const f = setupFixture();
    try {
      const { proposalId } = await f.proposeApproved();
      f.s.db.prepare('DELETE FROM tasks WHERE id = ?').run(f.taskA);
      // 只读预检不解析消费上下文任务——孤儿 grant 走过期判定面。
      const precheck = f.auth.precheckMutation('studio.patch-apply', { proposalId });
      expect(precheck).toMatchObject({ ok: false, reason: 'grant-expired' });
    } finally {
      f.s.dispose();
    }
  });
});

describe('新提案覆盖同键旧 grant', () => {
  it('同 digest 重提案批准：旧 grant 烧毁（一键一活）；消费旧 proposalId=grant-consumed、新的放行', async () => {
    const f = setupFixture();
    try {
      const first = await f.proposeApproved({ payloadTarget: 'b1' });
      // 同键重提案（同会话+同 tool+同 payload → 同 digest）：用户对新 preview 重新批准。
      const second = await f.proposeApproved({ payloadTarget: 'b1' });
      expect(second.proposalId).not.toBe(first.proposalId);
      // 旧 grant 已被覆盖失效；新 grant 存活。
      expect(grantOf(f, first.proposalId).consumed).toBe(1);
      expect(grantOf(f, second.proposalId).consumed).toBe(0);
      // 旧 proposalId 消费：grant-consumed（不得双活）。
      const oldConsume = f.auth.consumeForExecution({
        proposalId: first.proposalId,
        taskId: f.taskA,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(oldConsume).toMatchObject({ ok: false, reason: 'grant-consumed' });
      // 新 proposalId 消费放行。
      const newConsume = f.auth.consumeForExecution({
        proposalId: second.proposalId,
        taskId: f.taskA,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(newConsume).toMatchObject({ ok: true, via: 'grant' });
    } finally {
      f.s.dispose();
    }
  });

  it('不同 digest（不同操作）不覆盖：两个批准并存各自可消费', async () => {
    const f = setupFixture();
    try {
      const a = await f.proposeApproved({ payloadTarget: 'b1' });
      const b = await f.proposeApproved({ payloadTarget: 'b2' }); // 不同块=different payload=different digest
      expect(grantOf(f, a.proposalId).consumed).toBe(0);
      expect(grantOf(f, b.proposalId).consumed).toBe(0);
      // 各自消费均放行（互不覆盖——不同键）。
      expect(
        f.auth.consumeForExecution({ proposalId: a.proposalId, taskId: f.taskA, userId: f.s.anonymous.id, tool: 'studio.patch-apply' }),
      ).toMatchObject({ ok: true, via: 'grant' });
      const taskB = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId });
      expect(
        f.auth.consumeForExecution({ proposalId: b.proposalId, taskId: taskB.id, userId: f.s.anonymous.id, tool: 'studio.patch-apply' }),
      ).toMatchObject({ ok: true, via: 'grant' });
    } finally {
      f.s.dispose();
    }
  });
});

describe('项目清理级联（markClearing）', () => {
  it('session.clear → 会话内未消费 grant 全部烧毁；清理后消费必拒', async () => {
    const f = setupFixture();
    try {
      const keep = await f.proposeApproved(); // 本会话——应被级联烧毁
      const otherSession = f.s.sessions.create(f.s.anonymous, { title: '无辜项目' });
      const unrelated = await f.proposeApproved({ sessionId: otherSession.sessionId }); // 他会话——不受影响
      f.s.sessions.clear(f.s.anonymous, f.sessionId);
      expect(grantOf(f, keep.proposalId).consumed).toBe(1); // 级联失效
      expect(grantOf(f, unrelated.proposalId).consumed).toBe(0); // 跨项目不误伤
      // 清理后消费（任意上下文）必拒。
      const denied = f.auth.consumeForExecution({
        proposalId: keep.proposalId,
        taskId: f.taskA,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
      });
      expect(denied.ok).toBe(false);
      // 无辜项目的批准仍可正常跨轮消费。
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession.sessionId });
      expect(
        f.auth.consumeForExecution({ proposalId: unrelated.proposalId, taskId: otherTask.id, userId: f.s.anonymous.id, tool: 'studio.patch-apply' }),
      ).toMatchObject({ ok: true, via: 'grant' });
    } finally {
      f.s.dispose();
    }
  });
});

describe('审批卡归属呈现（projectLabel）', () => {
  it('approval-request 帧携带 projectLabel=会话标题（契约 strict 可解析）', async () => {
    const f = setupFixture();
    try {
      const task = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId });
      f.auth.propose({
        taskId: task.id,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
        payload: { kind: 'patch-apply', resourceId: 'r-1', region: { kind: 'blocks', ids: ['b1'] }, ops: [] },
        preview: { before: PREVIEW_A, after: PREVIEW_B },
        summary: '提案',
      });
      const frame = f.frames(task.id).find((candidate) => candidate.kind === 'approval-request');
      expect(frame).toBeDefined();
      const payload = ApprovalRequestPayloadSchema.parse(frame!.payload);
      expect(payload.projectLabel).toBe('项目域测试');
    } finally {
      f.s.dispose();
    }
  });

  it('空标题回退 sessionId 短码（8 位）', async () => {
    const f = setupFixture();
    try {
      const bare = f.s.sessions.create(f.s.anonymous, { title: '' });
      const task = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: bare.sessionId });
      f.auth.propose({
        taskId: task.id,
        userId: f.s.anonymous.id,
        tool: 'studio.patch-apply',
        payload: { kind: 'patch-apply', resourceId: 'r-1', region: { kind: 'blocks', ids: ['b1'] }, ops: [] },
        preview: { before: PREVIEW_A, after: PREVIEW_B },
        summary: '提案',
      });
      const frame = f.frames(task.id).find((candidate) => candidate.kind === 'approval-request');
      const payload = ApprovalRequestPayloadSchema.parse(frame!.payload);
      expect(payload.projectLabel).toBe(bare.sessionId.slice(0, 8));
    } finally {
      f.s.dispose();
    }
  });
});
