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

function setupFixture(extra?: { providerIdempotent?: () => boolean }): ApprovalFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs, ...(extra?.providerIdempotent ? { providerIdempotent: extra.providerIdempotent } : {}) });
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
      // 拒绝后零 grant——主体级拒绝（无授权直调面）；op 终态 failed 可追溯。
      expect(apply).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
      expect(f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId)).toMatchObject({ revision: 1 });
    } finally {
      f.s.dispose();
    }
  });
});

describe('必拒矩阵（§3.6.5——tasks.md W4.2 测试门）', () => {
  it('无授权直调：无 proposalId/未知 proposal/未批准（无 grant）全拒', async () => {
    const f = setupFixture();
    try {
      expect(await f.registry.call('studio.patch-apply', { taskId: f.taskId }, 'agent')).toMatchObject({
        kind: 'denied',
        reason: 'principal-forbidden',
      });
      expect(await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId: '0c6b1b1a-0000-4000-8000-000000000000' }, 'agent')).toMatchObject({
        kind: 'denied',
        reason: 'principal-forbidden',
      });
      const { proposalId } = await f.proposeDensity(); // 未 answer——无 grant
      const denied = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(denied).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
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

  it('跨 task/user：consume 绑定校验必拒', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      // 跨 task：另一 agent 任务上下文消费。
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: f.sessionId, status: 'running' });
      const crossTask = f.auth.consumeForExecution({ proposalId, taskId: otherTask.id, userId: f.s.anonymous.id, tool: 'studio.patch-apply' });
      expect(crossTask).toMatchObject({ ok: false, reason: 'task-mismatch' });
      // 跨 user：另一用户消费。
      const otherUser = createUser(f.s.db, { username: 'other', passwordHash: 'x', role: 'user' });
      const crossUser = f.auth.consumeForExecution({ proposalId, taskId: f.taskId, userId: otherUser.id, tool: 'studio.patch-apply' });
      expect(crossUser).toMatchObject({ ok: false, reason: 'owner-mismatch' });
      // 跨 tool。
      const crossTool = f.auth.consumeForExecution({ proposalId, taskId: f.taskId, userId: f.s.anonymous.id, tool: 'studio.export' });
      expect(crossTool).toMatchObject({ ok: false, reason: 'tool-mismatch' });
      // 校验失败面不消费 grant。
      expect(f.s.db.prepare('SELECT consumed FROM grants WHERE proposal_id = ?').get(proposalId)).toMatchObject({ consumed: 0 });
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
