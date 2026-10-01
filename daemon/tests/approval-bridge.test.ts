/**
 * 授权桥测试（W4.2——design §3.6 R2-R6；tasks.md:39 必拒矩阵）。
 * 覆盖：
 *   [1] 全链：propose→approval-request 帧（契约载荷+grant 零出）→answer 签发 grant
 *       →approval-resolved 帧→consume（grant 消费即焚+claim+CAS）→patch-apply 落库。
 *   [2] 必拒矩阵：无授权直调/摘要不匹配/过期/重放/跨 task-user/版本漂移 全必拒。
 *   [3] answer 语义：跨用户/未知 request/重复应答/拒绝（op failed+零 grant）。
 *   [4] 同 proposal 并发调用本地去重。
 * 测试纪律：全程进程内 fake——无真实外呼。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalRequestPayloadSchema, ApprovalResolvedPayloadSchema, type Frame } from '@handicraft/contracts';
import { decodePng, encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { publishLayoutDocument, type LayoutDocument } from '../src/capability/layout-doc.js';
import { createStudioCapabilities } from '../src/capability/studio.js';
import { createUser } from '../src/db/store.js';
import { createAgentTask } from '../src/db/jobs.js';
import { clientFor, createServices, type TestServices } from './helpers.js';
import { gridFromSpec, layout, mapColors, segment, STARTER_PALETTE } from 'rhinestone-studio/engine';

/** 测试图：96×96 左半红右半蓝（segment 两个色块）。 */
function twoColorPng(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      if (x < w / 2) {
        rgba[p] = 200; rgba[p + 1] = 16; rgba[p + 2] = 46;
      } else {
        rgba[p] = 16; rgba[p + 1] = 46; rgba[p + 2] = 200;
      }
      rgba[p + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

/** 真值文档 fixture（真实 engine 管线产物——同 engine.test.ts 口径）。 */
function makeLayoutDoc(bytes: Uint8Array): { doc: LayoutDocument; blockIds: string[] } {
  const decoded = decodePng(bytes);
  const image = { width: decoded.width, height: decoded.height, data: decoded.rgba };
  const blocks = segment(image, { k: 8, seed: 1, gemDiameterPx: 3 * 8 });
  const grid = gridFromSpec({ shapeId: 'round' as const, sizeLabel: '3mm', diameterMm: 3 }, 0.4, 8);
  const result = layout(blocks, 'hex-pitch', { density: 1, seed: 1, relax: { boundary: false, repulsion: false } }, grid);
  const gems = result.gems.map((gem) => ({ ...gem, shapeId: 'round' as const, diameterMm: 3 }));
  mapColors(gems, blocks, STARTER_PALETTE);
  const doc: LayoutDocument = {
    kind: 'layout',
    version: 1,
    imageWidth: image.width,
    imageHeight: image.height,
    palette: STARTER_PALETTE as unknown as LayoutDocument['palette'],
    grid: grid as unknown as LayoutDocument['grid'],
    blocks: blocks as unknown as LayoutDocument['blocks'],
    gems: gems as unknown as LayoutDocument['gems'],
    dropped: result.dropped ?? 0,
    shapeAssets: {},
    pave: {
      strategy: 'hex-pitch',
      density: 1,
      seed: 1,
      relax: { boundary: false, repulsion: false },
      spec: { shapeId: 'round' as const, diameterMm: 3 },
      pixelsPerMm: 8,
    },
  };
  return { doc, blockIds: blocks.map((b) => b.id) };
}

/** 装配：服务+授权桥+registry+会话+agent 任务+真值资源。 */
interface ApprovalFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStudioCapabilities>;
  sessionId: string;
  taskId: string;
  resourceId: string;
  blockIds: string[];
  frames(): Frame[];
  proposeDensity(target?: string): Promise<{ proposalId: string; requestId: string }>;
}

function setupFixture(extra?: { providerIdempotent?: () => boolean; grantProjectTtlMs?: number }): ApprovalFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({
    db: s.db,
    jobs: s.jobs,
    ...(extra?.providerIdempotent ? { providerIdempotent: extra.providerIdempotent } : {}),
    ...(extra?.grantProjectTtlMs !== undefined ? { grantProjectTtlMs: extra.grantProjectTtlMs } : {}),
  });
  const registry = createStudioCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    approvals: auth,
    config: s.config,
    revokeResult: (resultId) => s.sessions.revokeResult(resultId),
  });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '授权桥测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const { doc, blockIds } = makeLayoutDoc(twoColorPng());
  const published = publishLayoutDocument(s.db, s.blobs, s.anonymous.id, '真值.gemdoc', doc);
  return {
    s,
    auth,
    registry,
    sessionId,
    taskId: task.id,
    resourceId: published.resourceId,
    blockIds,
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
    proposeDensity: async (target?: string) => {
      const result = await registry.call(
        'studio.patch-propose',
        {
          taskId: task.id,
          resourceId: published.resourceId,
          region: { kind: 'blocks', ids: [target ?? blockIds[0]!] },
          changes: [{ op: 'setDensity', target: target ?? blockIds[0]!, after: 0.5 }],
        },
        'agent',
      );
      if (result.kind !== 'ok') throw new Error(`patch-propose 失败：${JSON.stringify(result)}`);
      const value = result.value as { proposalId: string; requestId: string };
      return { proposalId: value.proposalId, requestId: value.requestId };
    },
  };
}

describe('授权桥全链（§3.6 R2）', () => {
  it('propose→帧→answer→grant→consume→patch-apply 落库：grant 消费即焚+恰好一次+history 组', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      // approval-request 帧契约载荷（strict——注入 grantId/nonce 直接 parse 失败）。
      const requestFrame = f.frames().find((frame) => frame.kind === 'approval-request');
      expect(requestFrame).toBeDefined();
      const payload = ApprovalRequestPayloadSchema.parse(requestFrame!.payload);
      expect(payload.proposalId).toBe(proposalId);
      expect(payload.tool).toBe('studio.patch-apply');
      expect(payload.summary).toContain('setDensity');
      expect(JSON.stringify(requestFrame)).not.toMatch(/grantId|nonce/);

      const answer = f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      expect(answer).toEqual({ ok: true });
      const resolved = f.frames().find((frame) => frame.kind === 'approval-resolved');
      expect(ApprovalResolvedPayloadSchema.parse(resolved!.payload).approved).toBe(true);
      const grant = f.s.db.prepare('SELECT * FROM grants WHERE proposal_id = ?').get(proposalId) as { consumed: number };
      expect(grant.consumed).toBe(0);

      // 未批准期间真值零变化（此前 proposal 已存在——apply 前真值不变在真值测试断言）。
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'ok' });
      const after = f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId) as { revision: number };
      expect(after.revision).toBe(2);
      const op = f.s.db.prepare('SELECT * FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string };
      expect(op.state).toBe('succeeded');
      const grantAfter = f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId) as { consumed: number };
      expect(grantAfter.consumed).toBe(1); // 消费即焚
      const history = f.s.db.prepare('SELECT * FROM patch_history WHERE proposal_id = ?').get(proposalId) as { patch_group: string; op_kind: string };
      expect(history.op_kind).toBe('setDensity');
      expect(history.patch_group).toBe(proposalId); // 组=proposalId（整组撤销语义）
    } finally {
      f.s.dispose();
    }
  });

  it('answer(false)：op 终态 failed + 零 grant + mutation 必拒', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      expect(f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: false })).toEqual({ ok: true });
      const op = f.s.db.prepare('SELECT state FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string };
      expect(op.state).toBe('failed');
      expect(f.s.db.prepare('SELECT COUNT(*) AS n FROM grants').get()).toMatchObject({ n: 0 });
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      // 拒绝后零 grant——可读必拒+行动指引（P1-2 分层：非权限定性，agent 可重新提案）；
      // op 终态 failed 可追溯、真值零变化。
      expect(apply).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((apply as { message: string }).message).toContain('尚未获用户批准');
      expect(f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId)).toMatchObject({ revision: 1 });
    } finally {
      f.s.dispose();
    }
  });
});

describe('必拒矩阵（§3.6.5——tasks.md W4.2 测试门）', () => {
  it('无授权直调：无 proposalId=principal-forbidden；未知/未批准 proposal=可读必拒（P1-2 分层）', async () => {
    const f = setupFixture();
    try {
      // 真·无授权直调（输入未携带 proposalId）——主体级拒绝保持 denied。
      expect(await f.registry.call('studio.patch-apply', { taskId: f.taskId }, 'agent')).toMatchObject({
        kind: 'denied',
        reason: 'principal-forbidden',
      });
      // 未知 proposal（ID 抄录截断/幻觉）——failed INVALID_OPERATION+完整 ID 指引。
      const unknown = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId: '0c6b1b1a-0000-4000-8000-000000000000' }, 'agent');
      expect(unknown).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((unknown as { message: string }).message).toContain('proposal-unknown');
      const { proposalId } = await f.proposeDensity(); // 未 answer——无 grant
      const denied = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(denied).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((denied as { message: string }).message).toContain('尚未获用户批准');
    } finally {
      f.s.dispose();
    }
  });

  it('摘要不匹配：篡改持久化 payload → consume 必拒（digest 自洽校验）', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      // 篡改载荷（模拟内容被改——digest 不再匹配签发摘要）。
      f.s.db
        .prepare('UPDATE approved_ops SET payload_json = ? WHERE proposal_id = ?')
        .run('{"kind":"patch-apply","resourceId":"x","region":{"kind":"blocks","ids":["a"]},"ops":[]}', proposalId);
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'failed' });
      expect((apply as { message: string }).message).toContain('摘要不匹配');
    } finally {
      f.s.dispose();
    }
  });

  it('过期：op+grant 双面过期 → 必拒并要求重新 preview+approve', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      const past = new Date(Date.now() - 1000).toISOString();
      f.s.db.prepare('UPDATE approved_ops SET expires_at = ? WHERE proposal_id = ?').run(past, proposalId);
      f.s.db.prepare('UPDATE grants SET expires_at = ? WHERE proposal_id = ?').run(past, proposalId);
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'failed' });
      expect((apply as { message: string }).message).toMatch(/过期/);
    } finally {
      f.s.dispose();
    }
  });

  it('重放（已消费）：成功后再调 → grant-consumed 必拒（真值不再变化）', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      expect(await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent')).toMatchObject({ kind: 'ok' });
      const replay = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(replay).toMatchObject({ kind: 'failed' });
      expect((replay as { message: string }).message).toContain('已消费');
      expect(f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId)).toMatchObject({ revision: 2 }); // 未二次落库
    } finally {
      f.s.dispose();
    }
  });

  it('[W6 6.2] 绑定校验：跨 user/tool/跨项目（会话）必拒；同项目跨任务放行', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      // 跨 user（真实面）：另一用户以其**自己的会话任务**消费——跨用户必跨项目
      // （会话 owner 唯一），task-mismatch 必拒。[P1-2 口径修正 2026-10-01] 消费
      // 主体=任务行（会话域）而非调用侧 userId 传参——userId 不是认证身份（MCP
      // 面恒 agent，桥层从任务行解析），真实跨用户消费经会话域拦截。
      const otherUser = createUser(f.s.db, { username: 'other', passwordHash: 'x', role: 'user' });
      const otherUserSession = f.s.sessions.create(otherUser, { title: '他人项目' });
      const otherUserTask = createAgentTask(f.s.db, { ownerId: otherUser.id, sessionId: otherUserSession.sessionId, status: 'running' });
      const crossUser = f.auth.consumeForExecution({ proposalId, taskId: otherUserTask.id, userId: otherUser.id, tool: 'studio.patch-apply' });
      expect(crossUser).toMatchObject({ ok: false, reason: 'task-mismatch' });
      // 数据病态防御（owner-mismatch 保留面）：执行任务行 owner 与 proposal 签发者
      // 不一致（迁移/篡改痕迹）仍拒。
      f.s.db.prepare('UPDATE tasks SET owner_id = ? WHERE id = ?').run(otherUser.id, f.taskId);
      const tampered = f.auth.consumeForExecution({ proposalId, taskId: f.taskId, userId: f.s.anonymous.id, tool: 'studio.patch-apply' });
      expect(tampered).toMatchObject({ ok: false, reason: 'owner-mismatch' });
      f.s.db.prepare('UPDATE tasks SET owner_id = ? WHERE id = ?').run(f.s.anonymous.id, f.taskId);
      // 跨 tool。
      const crossTool = f.auth.consumeForExecution({ proposalId, taskId: f.taskId, userId: f.s.anonymous.id, tool: 'studio.export' });
      expect(crossTool).toMatchObject({ ok: false, reason: 'tool-mismatch' });
      // 跨项目（新会话）：grant 绑定已升级为项目域（Owner 裁决 2026-09-30）——
      // 另一会话的 agent 任务上下文消费必拒。
      const otherSession = f.s.sessions.create(f.s.anonymous, { title: '另一项目' });
      const otherSessionTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession.sessionId, status: 'running' });
      const crossSession = f.auth.consumeForExecution({ proposalId, taskId: otherSessionTask.id, userId: f.s.anonymous.id, tool: 'studio.patch-apply' });
      expect(crossSession).toMatchObject({ ok: false, reason: 'task-mismatch' });
      expect((crossSession as { message: string }).message).toContain('跨项目');
      // 校验失败面不消费 grant。
      expect(f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId)).toMatchObject({ consumed: 0 });
      // 同项目跨任务（跨轮）：放行——项目域语义（详见 approval-project-domain.test.ts 全矩阵）。
      const turn2Task = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'running' });
      const sameProject = f.auth.consumeForExecution({ proposalId, taskId: turn2Task.id, userId: f.s.anonymous.id, tool: 'studio.patch-apply' });
      expect(sameProject).toMatchObject({ ok: true, via: 'grant' });
      expect(f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId)).toMatchObject({ consumed: 1 });
    } finally {
      f.s.dispose();
    }
  });

  it('版本漂移：批准等待期间资源被改 → STALE 必拒（按过时 before 覆盖必拒）', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      f.s.db.prepare('UPDATE resources SET revision = revision + 1 WHERE id = ?').run(f.resourceId);
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'failed', code: 'STALE' });
      expect((apply as { message: string }).message).toContain('版本漂移');
      expect(f.s.db.prepare('SELECT state FROM approved_ops WHERE proposal_id = ?').get(proposalId)).toMatchObject({ state: 'approved' }); // 未 claim
    } finally {
      f.s.dispose();
    }
  });
});

describe('answer 归属与幂等', () => {
  it('跨用户/未知 request/重复应答必拒', async () => {
    const f = setupFixture();
    try {
      const { requestId } = await f.proposeDensity();
      const otherUser = createUser(f.s.db, { username: 'other2', passwordHash: 'x', role: 'user' });
      expect(() => f.auth.answer(otherUser, { sessionId: f.sessionId, requestId, approved: true })).toThrow(/无权应答他人会话/);
      expect(() => f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: 'no-such-request', approved: true })).toThrow(/不存在/);
      // requestId 不属于该会话（另一会话的 request）。
      const otherSession = f.s.sessions.create(f.s.anonymous, { title: '另一会话' });
      expect(() => f.auth.answer(f.s.anonymous, { sessionId: otherSession.sessionId, requestId, approved: true })).toThrow(/不属于该会话/);
      expect(f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true })).toEqual({ ok: true });
      expect(() => f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true })).toThrow(/已处理/); // 重放应答必拒
      expect(f.s.db.prepare('SELECT COUNT(*) AS n FROM grants').get()).toMatchObject({ n: 1 }); // 幂等签发不重复
    } finally {
      f.s.dispose();
    }
  });
});

describe('同 proposal 并发调用本地去重', () => {
  it('claim 后二次消费=concurrent 必拒；grant 不被二次消费', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      const first = f.auth.consumeForExecution({ proposalId, taskId: f.taskId, userId: f.s.anonymous.id, tool: 'studio.patch-apply' });
      expect(first).toMatchObject({ ok: true, via: 'grant' });
      const second = f.auth.consumeForExecution({ proposalId, taskId: f.taskId, userId: f.s.anonymous.id, tool: 'studio.patch-apply' });
      expect(second).toMatchObject({ ok: false, reason: 'concurrent' });
    } finally {
      f.s.dispose();
    }
  });
});

describe('RPC 面：session.answer / session.retry 端到端（§3.5 契约端点）', () => {
  it('answer 经 rpc 签发 grant；retry 经 rpc 建 attempt（owner 认证+费用确认）', async () => {
    const f = setupFixture();
    try {
      const client = clientFor(
        f.s.context({ token: await f.s.tokenFor(), approvals: f.auth }),
      ) as unknown as {
        session: {
          answer(input: { sessionId: string; requestId: string; approved: boolean }): Promise<{ ok: boolean }>;
          retry(input: { sessionId: string; proposalId: string; costConfirmed: boolean; retryRequestId: string }): Promise<{ attemptId: string; attemptNo: number }>;
        };
      };
      // generate 提议（工具面）→ rpc answer。
      const proposed = await f.registry.call('studio.generate', { taskId: f.taskId, prompt: 'rpc 端到端' }, 'agent');
      const { proposalId, requestId } = (proposed as { value: { proposalId: string; requestId: string } }).value;
      const answered = await client.session.answer({ sessionId: f.sessionId, requestId, approved: true });
      expect(answered).toEqual({ ok: true });
      expect(f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId)).toMatchObject({ consumed: 0 });
      // 非 unknown 态 retry → BAD_REQUEST。
      await expect(client.session.retry({ sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'rpc-key' })).rejects.toThrow(/仅 unknown 态/);
    } finally {
      f.s.dispose();
    }
  });
});

describe('[收官终评 P1/P2] MCP registry 预检：项目域 TTL 一致性 + 预检消费上下文早拒', () => {
  /**
   * 模拟「签发轮终态后 10-30 分钟」窗口（时间面照 approval-project-domain.test.ts
   * 形态——直接操纵 DB 时间戳，无 clock 注入缝）：10min 批准等待窗已过（op/grant
   * 绝对 expires_at 拨到过去），项目窗内/外由终态 updated_at 锚定（注入 60s TTL）。
   */
  function simulateTerminalWindow(f: ApprovalFixture, proposalId: string, terminalAgeMs: number): void {
    const past = new Date(Date.now() - 1000).toISOString();
    f.s.db.prepare('UPDATE approved_ops SET expires_at = ? WHERE proposal_id = ?').run(past, proposalId);
    f.s.db.prepare('UPDATE grants SET expires_at = ? WHERE proposal_id = ?').run(past, proposalId);
    f.s.db
      .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - terminalAgeMs).toISOString(), f.taskId);
  }

  it('终态后 10-30 分钟窗口（proposal 10min 已过、项目窗内）：registry 真实调用面同项目消费成功+grant 消费+真值落库', async () => {
    const f = setupFixture({ grantProjectTtlMs: 60_000 });
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      simulateTerminalWindow(f, proposalId, 30_000); // 终态 30s 前（60s 项目窗中点）
      const turn2 = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'running' });
      // 修复前：precheckMutation 在 grantExpired（项目窗内）放行后，仍无条件以
      // approved_ops.expires_at（10min 批准等待窗）拒——真实 MCP 调用面被截断，
      // 直接消费面（consumeForExecution）却放行，W6 项目域未在工具面成立。
      const apply = await f.registry.call('studio.patch-apply', { taskId: turn2.id, proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'ok' });
      expect(f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId)).toMatchObject({ consumed: 1 });
      expect(f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId)).toMatchObject({ revision: 2 });
    } finally {
      f.s.dispose();
    }
  });

  it('超项目窗（终态 updated_at 超过项目 TTL）→ grant-expired 必拒；grant 未消费+真值零变化', async () => {
    const f = setupFixture({ grantProjectTtlMs: 60_000 });
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      simulateTerminalWindow(f, proposalId, 61_000); // 项目窗（60s）外 1s
      const turn2 = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'running' });
      const denied = await f.registry.call('studio.patch-apply', { taskId: turn2.id, proposalId }, 'agent');
      expect(denied).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((denied as { message: string }).message).toMatch(/grant-expired|过期/);
      expect(f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId)).toMatchObject({ consumed: 0 });
      expect(f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId)).toMatchObject({ revision: 1 });
    } finally {
      f.s.dispose();
    }
  });

  it('跨项目（新会话任务）：预检阶段即 task-mismatch 早拒（grant 未消费+真值零变化）', async () => {
    const f = setupFixture({ grantProjectTtlMs: 60_000 });
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      const otherSession = f.s.sessions.create(f.s.anonymous, { title: '收官另一项目' });
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession.sessionId, status: 'running' });
      const denied = await f.registry.call('studio.patch-apply', { taskId: otherTask.id, proposalId }, 'agent');
      // 预检早拒形态：registry 桥包装「<tool> 必拒（task-mismatch）：…」——handler 内
      // consumeForExecution 的失败面不带「必拒（…）」包装，据此区分预检/handler 层。
      expect(denied).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((denied as { message: string }).message).toContain('必拒（task-mismatch）');
      expect((denied as { message: string }).message).toContain('跨项目');
      expect(f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId)).toMatchObject({ consumed: 0 });
      expect(f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId)).toMatchObject({ revision: 1 });
    } finally {
      f.s.dispose();
    }
  });

  it('retry-armed 路径保持 proposal TTL（无 grant 的预检不放宽批准等待窗）', async () => {
    const f = setupFixture();
    try {
      // 造 retry-armed：消费 grant 后把 op/attempt 收敛 unknown，再经 session.retry
      // re-arm（approved+active attempt、无未消费 grant）。
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      expect(
        f.auth.consumeForExecution({ proposalId, taskId: f.taskId, userId: f.s.anonymous.id, tool: 'studio.patch-apply' }),
      ).toMatchObject({ ok: true });
      f.auth.recoverNonTerminal(); // 消费后未结算的 op → unknown（重启收敛面）
      f.auth.retry(f.s.anonymous, {
        sessionId: f.sessionId,
        proposalId,
        costConfirmed: true,
        retryRequestId: 'final-review-retry-key',
      });
      // re-arm 续期后的 proposal 窗内：预检放行（attempt 在身——形态面）。
      expect(f.auth.precheckMutation('studio.patch-apply', { taskId: f.taskId, proposalId })).toMatchObject({ ok: true });
      // 续期窗过后：无 grant 路径仍按 proposal 绝对 TTL 拒（不因 P1 修复放宽）。
      f.s.db
        .prepare('UPDATE approved_ops SET expires_at = ? WHERE proposal_id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), proposalId);
      expect(f.auth.precheckMutation('studio.patch-apply', { taskId: f.taskId, proposalId })).toMatchObject({
        ok: false,
        reason: 'proposal-expired',
      });
    } finally {
      f.s.dispose();
    }
  });
});
