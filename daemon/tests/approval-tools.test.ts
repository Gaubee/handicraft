/**
 * studio 工具面测试（W4.2——design §3/§3.4/§3.6.7；tasks.md:39 固定 fixture+三族撤销）。
 * 覆盖：
 *   [1] 固定 fixture：同参 pave-preview 确定 / 密度单调（钻数不减）/ dropped 呈现 /
 *       非法值显式拒绝（空 region/不存在 ID/负 gapMm/越界 density）/ 未批准真值不变。
 *   [2] patch 旅程：patch-propose diff 形状→answer→patch-apply 落库（真值变化+history）。
 *   [3] export 旅程：export-dryrun{propose}→answer→studio.export（分享包+帧）。
 *   [4] 撤销三族终态：patch 整组逆序回退（回退也记 history）/generate 取消+产物清理/
 *       export revoke+bundle 释放。
 *   [5] MCP 投影：§3 工具清单全量注册（mcpToolName 映射）+ bom/templates 只读面。
 * 测试纪律：generate 执行器替身——零真实外呼。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { loadLayoutDocument, publishLayoutDocument, type LayoutDocument } from '../src/capability/layout-doc.js';
import { createStudioCapabilities, type GenerateExecutor } from '../src/capability/studio.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';
import { gridFromSpec, layout, mapColors, segment, STARTER_PALETTE } from 'rhinestone-studio/engine';

/** 测试图：96×96 左半红右半蓝。 */
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
      spec: { shapeId: 'round' as const, diameterMm: 3 },
      pixelsPerMm: 8,
    },
  };
  return { doc, blockIds: blocks.map((b) => b.id) };
}

const okExecutor: GenerateExecutor = async () => new Uint8Array([1, 2, 3, 4]);

interface ToolFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStudioCapabilities>;
  sessionId: string;
  taskId: string;
  resourceId: string;
  blockIds: string[];
  imageRef: string;
  frames(): ReturnType<TestServices['jobs']['frames']>['frames'];
  doc(): LayoutDocument;
}

function setupTools(): ToolFixture {
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
  const { sessionId } = s.sessions.create(s.anonymous, { title: '工具面测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const imageRef = s.blobs.put(twoColorPng()).hash;
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
    imageRef,
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
    doc: () => loadLayoutDocument(s.db, s.blobs, s.anonymous.id, published.resourceId).doc,
  };
}

function paveParams(f: ToolFixture, overrides: Record<string, unknown> = {}) {
  return {
    taskId: f.taskId,
    imageRef: f.imageRef,
    strategy: 'hex-pitch' as const,
    gapMm: 0.4,
    spec: { shapeId: 'round' as const, diameterMm: 3 },
    ...overrides,
  };
}

async function valueOf(result: unknown): Promise<Record<string, unknown>> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: Record<string, unknown> }).value;
}

describe('固定 fixture 断言（§3.4——tasks.md W4.2 测试门）', () => {
  it('同参 pave-preview 确定：两次同参调用产出相同 blobRef 与计数', async () => {
    const f = setupTools();
    try {
      const first = await valueOf(await f.registry.call('studio.pave-preview', paveParams(f), 'agent'));
      const second = await valueOf(await f.registry.call('studio.pave-preview', paveParams(f), 'agent'));
      expect(second['layoutBlobRef']).toBe(first['layoutBlobRef']);
      expect(second['gemCount']).toBe(first['gemCount']);
      expect(first['gemCount']).toBeGreaterThan(0);
      expect(Array.isArray(first['blocks'])).toBe(true); // blocks 元数据（区域选择查询面）
    } finally {
      f.s.dispose();
    }
  });

  it('密度单调：density 上升 ⇒ 钻数单调不减；dropped 如实呈现', async () => {
    const f = setupTools();
    try {
      const counts: number[] = [];
      for (const density of [0.3, 0.6, 1]) {
        const preview = await valueOf(await f.registry.call('studio.pave-preview', paveParams(f, { density }), 'agent'));
        counts.push(preview['gemCount'] as number);
        expect(preview['dropped']).toBeGreaterThanOrEqual(0); // dropped 呈现（非 warning 语义）
      }
      expect(counts[0]! <= counts[1]!).toBe(true);
      expect(counts[1]! <= counts[2]!).toBe(true);
    } finally {
      f.s.dispose();
    }
  });

  it('非法值显式拒绝：空 region/不存在 ID/负 gapMm/越界 density', async () => {
    const f = setupTools();
    try {
      const emptyRegion = await f.registry.call('studio.pave-preview', paveParams(f, { region: { kind: 'blocks', ids: [] } }), 'agent');
      expect(emptyRegion).toMatchObject({ kind: 'failed' });
      const unknownIds = await f.registry.call('studio.pave-preview', paveParams(f, { region: { kind: 'blocks', ids: ['no-such-block'] } }), 'agent');
      expect(unknownIds).toMatchObject({ kind: 'failed' });
      expect((unknownIds as { message: string }).message).toContain('不存在的图块');
      const negativeGap = await f.registry.call('studio.pave-preview', paveParams(f, { gapMm: -1 }), 'agent');
      expect(negativeGap).toMatchObject({ kind: 'failed' });
      const overDensity = await f.registry.call('studio.pave-preview', paveParams(f, { density: 1.5 }), 'agent');
      expect(overDensity).toMatchObject({ kind: 'failed' });
    } finally {
      f.s.dispose();
    }
  });

  it('未批准真值不变：patch-propose 后资源 revision 与内容零变化', async () => {
    const f = setupTools();
    try {
      const before = f.doc();
      const beforeRow = f.s.db.prepare('SELECT revision, content_hash FROM resources WHERE id = ?').get(f.resourceId) as { revision: number; content_hash: string };
      const proposed = await valueOf(
        await f.registry.call(
          'studio.patch-propose',
          {
            taskId: f.taskId,
            resourceId: f.resourceId,
            region: { kind: 'blocks', ids: [f.blockIds[0]!] },
            changes: [{ op: 'setDensity', target: f.blockIds[0]!, after: 0.5 }],
          },
          'agent',
        ),
      );
      // diff 形状（§3.4 proposal diff 字段全集）。
      const diff = proposed['diff'] as { ops: unknown[]; estGemsDelta: number; dropped: number; preview: { beforeBlob: string; afterBlob: string } };
      expect(diff.ops).toHaveLength(1);
      expect(diff.preview.beforeBlob).toMatch(/^[0-9a-f]{64}$/);
      expect(diff.preview.afterBlob).toMatch(/^[0-9a-f]{64}$/);
      expect(diff.preview.beforeBlob).not.toBe(diff.preview.afterBlob);
      expect(typeof diff.estGemsDelta).toBe('number');
      expect(diff.dropped).toBeGreaterThanOrEqual(0);
      // 真值零变化。
      const afterRow = f.s.db.prepare('SELECT revision, content_hash FROM resources WHERE id = ?').get(f.resourceId) as { revision: number; content_hash: string };
      expect(afterRow).toEqual(beforeRow);
      expect(f.doc()).toEqual(before);
    } finally {
      f.s.dispose();
    }
  });
});

describe('patch 旅程：propose→approve→apply（真值变化+history 组）', () => {
  it('setDensity 落库：目标块钻数变化、真值 revision 前进、patch_history 记录 before/after', async () => {
    const f = setupTools();
    try {
      const before = f.doc();
      const target = f.blockIds[0]!;
      const proposed = await valueOf(
        await f.registry.call(
          'studio.patch-propose',
          { taskId: f.taskId, resourceId: f.resourceId, region: { kind: 'blocks', ids: [target] }, changes: [{ op: 'setDensity', target, after: 0.5 }] },
          'agent',
        ),
      );
      const { proposalId, requestId } = proposed as { proposalId: string; requestId: string };
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      const applied = await valueOf(await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent'));
      expect(applied['revision']).toBe(2);
      const after = f.doc();
      const beforeTarget = before.gems.filter((gem) => gem.blockId === target).length;
      const afterTarget = after.gems.filter((gem) => gem.blockId === target).length;
      expect(afterTarget).toBeLessThan(beforeTarget); // 0.5<1 密度下降——目标块钻数减少
      expect(after.pave.density).toMatchObject({ [target]: 0.5 }); // 密度覆盖持久化
      const history = f.s.db.prepare('SELECT * FROM patch_history WHERE proposal_id = ?').get(proposalId) as { before_json: string; after_json: string; op_kind: string };
      expect(history.op_kind).toBe('setDensity');
      expect(JSON.parse(history.before_json)).toBe(1);
      expect(JSON.parse(history.after_json)).toBe(0.5);
    } finally {
      f.s.dispose();
    }
  });
});

describe('export 旅程与撤销三族终态（§3.6.7）', () => {
  it('export-dryrun{propose}→answer→studio.export：分享包+artifact 帧+可撤销', async () => {
    const f = setupTools();
    try {
      const dryrun = await valueOf(
        await f.registry.call('studio.export-dryrun', { taskId: f.taskId, resourceId: f.resourceId, propose: true }, 'agent'),
      );
      expect((dryrun['verdict'] as { ok: boolean }).ok).toBe(true);
      const proposal = dryrun['proposal'] as { proposalId: string; requestId: string };
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposal.requestId, approved: true });
      const exported = await valueOf(await f.registry.call('studio.export', { taskId: f.taskId, proposalId: proposal.proposalId }, 'agent'));
      const publicId = exported['publicId'] as string;
      expect(publicId).toMatch(/^[A-Za-z0-9]{12}$/);
      expect(existsSync(path.join(f.s.config.dataRoot, 'results', publicId, 'bundle.json'))).toBe(true);
      const artifacts = f.frames().filter((frame) => frame.kind === 'artifact');
      expect(artifacts.length).toBeGreaterThanOrEqual(3); // svg/bom/png
      // export 撤销：revoke+bundle 释放。
      const undone = await valueOf(
        await f.registry.call('studio.undo', { family: 'export', resultId: exported['resultId'] as string }, 'human-ui'),
      );
      expect(undone['family']).toBe('export');
      // revoke → sweepExpiredResults 同链路回收：行删除（分享面 publicId 查询=404）。
      const resultRow = f.s.db.prepare('SELECT * FROM results WHERE id = ?').get(exported['resultId'] as string) as
        | { revoked_at: string | null; bundle_path: string }
        | undefined;
      expect(resultRow).toBeUndefined();
      const byPublic = f.s.db.prepare('SELECT * FROM results WHERE public_id = ?').get(publicId);
      expect(byPublic).toBeUndefined();
      expect(existsSync(path.join(f.s.config.dataRoot, 'results', publicId))).toBe(false); // bundle 目录释放
    } finally {
      f.s.dispose();
    }
  });

  it('patch 撤销：整组逆序回退——真值回到应用前、回退也记 history、revision 前进', async () => {
    const f = setupTools();
    try {
      const before = f.doc();
      const target = f.blockIds[0]!;
      const proposed = await valueOf(
        await f.registry.call(
          'studio.patch-propose',
          { taskId: f.taskId, resourceId: f.resourceId, region: { kind: 'blocks', ids: [target] }, changes: [{ op: 'setDensity', target, after: 0.5 }] },
          'agent',
        ),
      );
      const { proposalId, requestId } = proposed as { proposalId: string; requestId: string };
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
      const undone = await valueOf(await f.registry.call('studio.undo', { family: 'patch', resourceId: f.resourceId }, 'human-ui'));
      expect(undone['family']).toBe('patch');
      const after = f.doc();
      expect(after.gems.length).toBe(before.gems.length); // 回到应用前
      expect(after.gems).toEqual(before.gems);
      const revision = f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId) as { revision: number };
      expect(revision.revision).toBe(3); // 应用+回退——revision 单调前进（CAS 链不断）
      const undoGroups = f.s.db.prepare('SELECT COUNT(DISTINCT patch_group) AS n FROM patch_history WHERE resource_id = ?').get(f.resourceId) as { n: number };
      expect(undoGroups.n).toBe(2); // 原组+回退组（回退也记 history）
    } finally {
      f.s.dispose();
    }
  });

  it('generate 撤销：已完成=产物清理（blob 引用释放）；未完成=取消（failed）', async () => {
    const f = setupTools();
    try {
      // 已完成路径。
      const proposed = await valueOf(await f.registry.call('studio.generate', { taskId: f.taskId, prompt: '一只猫' }, 'agent'));
      const { proposalId, requestId } = proposed as { proposalId: string; requestId: string };
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
      const done = await valueOf(await f.registry.call('studio.generate', { taskId: f.taskId, proposalId }, 'agent'));
      const blobRef = done['blobRef'] as string;
      expect(f.s.blobs.read(blobRef)).not.toBeNull();
      const undone = await valueOf(await f.registry.call('studio.undo', { family: 'generate', proposalId }, 'human-ui'));
      expect(undone['family']).toBe('generate');
      const op = f.s.db.prepare('SELECT state, result_ref FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string; result_ref: string | null };
      expect(op.result_ref).toBeNull();
      const blobRow = f.s.db.prepare('SELECT status FROM blobs WHERE hash = ? AND status = ?').get(blobRef, 'active') as { status: string } | undefined;
      expect(blobRow).toBeUndefined(); // 引用归零——active 行已置 deleting（物理回收走 outbox 链）

      // 未完成路径：置 running（模拟在途）→ undo=cancel。
      const p2 = await valueOf(await f.registry.call('studio.generate', { taskId: f.taskId, prompt: '一只狗' }, 'agent'));
      const second = p2 as { proposalId: string; requestId: string };
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: second.requestId, approved: true });
      f.s.db.prepare("UPDATE approved_ops SET state = 'running' WHERE proposal_id = ?").run(second.proposalId);
      await f.registry.call('studio.undo', { family: 'generate', proposalId: second.proposalId }, 'human-ui');
      const op2 = f.s.db.prepare('SELECT state FROM approved_ops WHERE proposal_id = ?').get(second.proposalId) as { state: string };
      expect(op2.state).toBe('failed'); // cancel（未完成时）语义
    } finally {
      f.s.dispose();
    }
  });
});

describe('MCP 投影与只读面（§3 工具清单）', () => {
  it('§3 工具清单全量注册（10 个）+ mcpToolName 映射', async () => {
    const f = setupTools();
    try {
      const names = f.registry.names();
      expect([...names].sort()).toEqual(
        [
          'studio.projects',
          'studio.templates',
          'studio.pave-preview',
          'studio.export-dryrun',
          'studio.bom',
          'studio.patch-propose',
          'studio.patch-apply',
          'studio.generate',
          'studio.export',
          'studio.undo',
        ].sort(),
      );
      expect(mcpToolName('studio.pave-preview')).toBe('pave-preview');
      expect(mcpToolName('studio.export-dryrun')).toBe('export-dryrun');
      expect(mcpToolName('studio.patch-apply')).toBe('patch-apply');
    } finally {
      f.s.dispose();
    }
  });

  it('bom：BOM CSV 产物（totalGems/rows/blobRef）；templates：gemtpl 资源清单', async () => {
    const f = setupTools();
    try {
      const bom = await valueOf(await f.registry.call('studio.bom', { resourceId: f.resourceId }, 'agent'));
      expect(bom['totalGems']).toBe(f.doc().gems.length);
      expect(bom['rows']).toBeGreaterThanOrEqual(1);
      expect(bom['bomBlobRef']).toMatch(/^[0-9a-f]{64}$/);

      f.s.db
        .prepare(
          "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES ('tpl-1', ?, NULL, '猫.gemtpl', 0, 'h', 10, ?, 1, ?, ?)",
        )
        .run(f.s.anonymous.id, JSON.stringify({ kind: 'gemtpl', formatVersion: 2 }), new Date().toISOString(), new Date().toISOString());
      const templates = await valueOf(await f.registry.call('studio.templates', {}, 'agent'));
      const list = templates['templates'] as Array<{ resourceId: string; name: string }>;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ resourceId: 'tpl-1', name: '猫.gemtpl' });
      void readFileSync;
    } finally {
      f.s.dispose();
    }
  });
});

describe('熔断任务分桶（W4.1 收口——tasks.md W4.2 按任务分桶）', () => {
  it('任务域工具连续相同失败 → onRunaway(bucket=taskId)；成功清零', async () => {
    const runaways: Array<[string, string]> = [];
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const registry = createStudioCapabilities({
        db: s.db,
        blobs: s.blobs,
        jobs: s.jobs,
        approvals: new ApprovalService({ db: s.db, jobs: s.jobs }),
        config: s.config,
        onRunaway: (bucket, detail) => runaways.push([bucket, detail]),
      });
      const { sessionId } = s.sessions.create(s.anonymous, { title: '熔断' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      const bad = { taskId: task.id, imageRef: '0'.repeat(64), strategy: 'hex-pitch' as const, gapMm: 0.4, spec: { shapeId: 'round' as const, diameterMm: 3 } };
      for (let i = 1; i <= 4; i += 1) {
        expect((await registry.call('studio.pave-preview', bad, 'agent')).kind).toBe('failed');
      }
      expect(runaways).toHaveLength(0);
      const fifth = await registry.call('studio.pave-preview', bad, 'agent');
      expect((fifth as { message: string }).message).toContain('熔断');
      expect(runaways).toHaveLength(1);
      expect(runaways[0]![0]).toBe(task.id); // 桶=taskId（任务域分桶——非 global）
    } finally {
      s.dispose();
    }
  });
});
