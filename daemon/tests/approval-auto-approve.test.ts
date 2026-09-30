/**
 * 自动批准单点测试（product-polish-w1 T2——Owner 2026-09-30「免值守」指令）。
 * 覆盖（authorization.ts propose 中央单点 + sessions.auto_approve 开关真源 +
 * grants.auto_approved 审计标记；全链经 studio.patch-apply 双模工具实证——不逐
 * 工具放行的单点语义即在此验证）：
 *   [1] 开启（sessions.auto_approve=1——followup 透传落库面）：propose 创建即
 *       签发 grant（auto_approved=1 审计）+ 立即补发 approval-resolved 帧
 *       （autoApproved=true）→ execute 无需 session.answer 直接消费成功（免值守）。
 *   [2] TTL 语义不变：自动签发 grant 的过期窗与手动批准同源（=op.expires_at；
 *       项目域重锚判定同一 grantExpired 面）。
 *   [3] 缺省/关闭行为不变：无 grant、无 approval-resolved 帧、execute 必拒
 *       （grant-missing）；手动 answer 签发的 grant auto_approved=0（审计可区分）。
 *   [4] 红线：开启前悬挂的未决 proposal 不追补自动批——开启只对**新** proposal
 *       生效（防开启瞬间把历史积压一键放行）；悬挂者仍走人工 answer。
 *   [5] 开关写入面：setSessionAutoApprove 最后写入者胜；不触碰 updated_at。
 * 测试纪律：进程内 fake（同 approval-bridge.test.ts fixture 口径），零外呼。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalResolvedPayloadSchema } from '@handicraft/contracts';
import { ApprovalService } from '../src/capability/authorization.js';
import { publishLayoutDocument, type LayoutDocument } from '../src/capability/layout-doc.js';
import { createStudioCapabilities } from '../src/capability/studio.js';
import { createAgentTask } from '../src/db/jobs.js';
import { setSessionAutoApprove } from '../src/db/sessions.js';
import { createUser } from '../src/db/store.js';
import { clientFor, createServices, type TestServices } from './helpers.js';
import { decodePng, encodePng } from '../src/png/codec.js';
import { gridFromSpec, layout, mapColors, segment, STARTER_PALETTE } from 'rhinestone-studio/engine';

/** 测试图：96×96 左半红右半蓝（segment 两个色块——同 approval-bridge 口径）。 */
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
      spec: { shapeId: 'round', diameterMm: 3 },
      pixelsPerMm: 8,
    },
  };
  return { doc, blockIds: blocks.map((b) => b.id) };
}

interface Fixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStudioCapabilities>;
  sessionId: string;
  taskId: string;
  resourceId: string;
  blockIds: string[];
  frames(): { kind: string; payload: unknown }[];
  proposeDensity(): Promise<{ proposalId: string; requestId: string }>;
}

function setupFixture(): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createStudioCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    approvals: auth,
    config: s.config,
    revokeResult: (resultId) => s.sessions.revokeResult(resultId),
  });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '自动批准测试' });
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
    frames: () =>
      s.jobs.frames(s.anonymous, task.id, 0).frames.map((frame) => ({ kind: frame.kind, payload: frame.payload })),
    proposeDensity: async () => {
      const result = await registry.call(
        'studio.patch-propose',
        {
          taskId: task.id,
          resourceId: published.resourceId,
          region: { kind: 'blocks', ids: [blockIds[0]!] },
          changes: [{ op: 'setDensity', target: blockIds[0]!, after: 0.5 }],
        },
        'agent',
      );
      if (result.kind !== 'ok') throw new Error(`patch-propose 失败：${JSON.stringify(result)}`);
      const value = result.value as { proposalId: string; requestId: string };
      return { proposalId: value.proposalId, requestId: value.requestId };
    },
  };
}

describe('自动批准（product-polish-w1 T2 中央单点）', () => {
  it('[1] 开启：propose 创建即签发 grant（审计 auto_approved=1）+ 立即 approval-resolved（autoApproved=true）→ execute 免值守直接消费', async () => {
    const f = setupFixture();
    try {
      // followup.autoApprove 透传的落库面（kernel.followup 同一 helper）。
      setSessionAutoApprove(f.s.db, f.sessionId, true);
      const { proposalId, requestId } = await f.proposeDensity();

      // 帧序：approval-request 后紧跟 approval-resolved（autoApproved=true 审计标记）。
      const kinds = f.frames().map((frame) => frame.kind);
      expect(kinds).toContain('approval-request');
      expect(kinds).toContain('approval-resolved');
      const resolved = f.frames().find((frame) => frame.kind === 'approval-resolved');
      const payload = ApprovalResolvedPayloadSchema.parse(resolved!.payload);
      expect(payload.requestId).toBe(requestId);
      expect(payload.approved).toBe(true);
      expect(payload.autoApproved).toBe(true);

      // 审计：grant 已签发且未消费、auto_approved=1（可追溯哪些是自动批的）。
      const grant = f.s.db
        .prepare('SELECT consumed, auto_approved FROM grants WHERE proposal_id = ?')
        .get(proposalId) as { consumed: number; auto_approved: number };
      expect(grant).toEqual({ consumed: 0, auto_approved: 1 });

      // 免值守：不 answer，execute 直接消费成功（中央单点对所有 approved-mutation 生效）。
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'ok' });
      const grantAfter = f.s.db
        .prepare('SELECT consumed FROM grants WHERE proposal_id = ?')
        .get(proposalId) as { consumed: number };
      expect(grantAfter.consumed).toBe(1);
    } finally {
      f.s.dispose();
    }
  });

  it('[2] TTL 语义不变：自动签发 grant 的过期窗=proposal 窗（与手动批准同源）', async () => {
    const f = setupFixture();
    try {
      setSessionAutoApprove(f.s.db, f.sessionId, true);
      const { proposalId } = await f.proposeDensity();
      const row = f.s.db
        .prepare('SELECT g.expires_at AS grantExpires, o.expires_at AS opExpires FROM grants g JOIN approved_ops o ON o.proposal_id = g.proposal_id WHERE g.proposal_id = ?')
        .get(proposalId) as { grantExpires: string; opExpires: string };
      expect(row.grantExpires).toBe(row.opExpires);
      // 签发轮 running（非终态）→ 绝对 TTL 面（grantExpired 与手动链同一判定函数）。
      const task = f.s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(f.taskId) as { status: string };
      expect(task.status).toBe('running');
    } finally {
      f.s.dispose();
    }
  });

  it('[3] 缺省/关闭行为不变：无 grant 无 resolved 帧、execute 必拒；手动 answer 的 grant auto_approved=0', async () => {
    const f = setupFixture();
    try {
      const { proposalId, requestId } = await f.proposeDensity();
      expect(f.frames().some((frame) => frame.kind === 'approval-resolved')).toBe(false);
      const grant = f.s.db.prepare('SELECT * FROM grants WHERE proposal_id = ?').get(proposalId);
      expect(grant).toBeUndefined();

      // 免授权直调必拒（既有语义零变化）。
      const denied = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(denied).toMatchObject({ kind: 'denied' });

      // 手动批准链原样：answer 签发的 grant 审计=0（区分自动批/人工批）。
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      const manualGrant = f.s.db
        .prepare('SELECT auto_approved, consumed FROM grants WHERE proposal_id = ?')
        .get(proposalId) as { auto_approved: number; consumed: number };
      expect(manualGrant).toEqual({ auto_approved: 0, consumed: 0 });
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'ok' });
    } finally {
      f.s.dispose();
    }
  });

  it('[4] 红线：开启前悬挂的未决 proposal 不追补自动批——只对开启后的新 proposal 生效', async () => {
    const f = setupFixture();
    try {
      // 开启前发起（缺省关）：悬挂等待人工批准。
      const pending = await f.proposeDensity();
      // 开启（模拟下一条 followup 携带 autoApprove=true 落库）。
      setSessionAutoApprove(f.s.db, f.sessionId, true);
      // 悬挂者不被追补：无 grant、无 approval-resolved 帧。
      expect(f.s.db.prepare('SELECT * FROM grants WHERE proposal_id = ?').get(pending.proposalId)).toBeUndefined();
      expect(f.frames().some((frame) => frame.kind === 'approval-resolved')).toBe(false);
      // 悬挂者仍走人工链（answer 原样可用）。
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: pending.requestId, approved: true });
      const apply = await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId: pending.proposalId }, 'agent');
      expect(apply).toMatchObject({ kind: 'ok' });

      // 开启后的新 proposal：自动批。
      const fresh = await f.proposeDensity();
      const grant = f.s.db
        .prepare('SELECT auto_approved FROM grants WHERE proposal_id = ?')
        .get(fresh.proposalId) as { auto_approved: number };
      expect(grant.auto_approved).toBe(1);
    } finally {
      f.s.dispose();
    }
  });

  it('[5] 开关写入面：最后写入者胜；不触碰 updated_at（列表排序不漂移）', () => {
    const f = setupFixture();
    try {
      const before = f.s.db
        .prepare('SELECT auto_approve, updated_at FROM sessions WHERE id = ?')
        .get(f.sessionId) as { auto_approve: number; updated_at: string };
      expect(before.auto_approve).toBe(0); // 缺省关（v14 DEFAULT 0）
      setSessionAutoApprove(f.s.db, f.sessionId, true);
      setSessionAutoApprove(f.s.db, f.sessionId, false);
      setSessionAutoApprove(f.s.db, f.sessionId, true);
      const after = f.s.db
        .prepare('SELECT auto_approve, updated_at FROM sessions WHERE id = ?')
        .get(f.sessionId) as { auto_approve: number; updated_at: string };
      expect(after.auto_approve).toBe(1);
      expect(after.updated_at).toBe(before.updated_at);
    } finally {
      f.s.dispose();
    }
  });

  it('[1-扩展] 跨用户隔离：他/她人开启自动批准不影响本人会话（开关=会话域，propose 按 task 所属会话读取）', async () => {
    const f = setupFixture();
    try {
      const other = createUser(f.s.db, { username: 'auto-approve-other', passwordHash: 'x', role: 'user' });
      const otherSession = f.s.sessions.create(other, { title: '他人会话' });
      setSessionAutoApprove(f.s.db, otherSession.sessionId, true);
      // 本人会话（未开启）零影响。
      const { proposalId } = await f.proposeDensity();
      expect(f.s.db.prepare('SELECT * FROM grants WHERE proposal_id = ?').get(proposalId)).toBeUndefined();
      // 开关投影面（toSummary 契约 optional 面——sessionService 读回）。
      const view = f.s.sessions.get(other, otherSession.sessionId);
      expect(view.session.autoApprove).toBe(true);
    } finally {
      f.s.dispose();
    }
  });
});

// clientFor 显式消费（types 层面避免未用 import 报错——与 approval-bridge 同款冗余位）。
void clientFor;
