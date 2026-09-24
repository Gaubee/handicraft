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
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { loadLayoutDocument, publishLayoutDocument, type LayoutDocument } from '../src/capability/layout-doc.js';
import { createStudioCapabilities, type GenerateExecutor } from '../src/capability/studio.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createUser } from '../src/db/store.js';
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

function setupTools(root?: string): ToolFixture {
  const s = root
    ? createServices(undefined, { imgDryRun: true, root })
    : createServices(undefined, { imgDryRun: true });
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
      const bom = await valueOf(await f.registry.call('studio.bom', { taskId: f.taskId, resourceId: f.resourceId }, 'agent'));
      expect(bom['totalGems']).toBe(f.doc().gems.length);
      expect(bom['rows']).toBeGreaterThanOrEqual(1);
      expect(bom['bomBlobRef']).toMatch(/^[0-9a-f]{64}$/);

      f.s.db
        .prepare(
          "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES ('tpl-1', ?, NULL, '猫.gemtpl', 0, 'h', 10, ?, 1, ?, ?)",
        )
        .run(f.s.anonymous.id, JSON.stringify({ kind: 'gemtpl', formatVersion: 2 }), new Date().toISOString(), new Date().toISOString());
      const templates = await valueOf(await f.registry.call('studio.templates', { taskId: f.taskId }, 'agent'));
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

describe('export 本地恰好一次（W4.2 R1 P1-3——崩溃窗口收敛探针）', () => {
  it('注入 settle 提交失败→bundle 事务整体回滚→重启恢复→同键 retry→执行返回同一 resultId；bundle 计数=1；无 claimed 残留', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'handicraft-export-once-'));
    const f = setupTools(root);
    let proposalId = '';
    try {
      const dryrun = await valueOf(
        await f.registry.call('studio.export-dryrun', { taskId: f.taskId, resourceId: f.resourceId, propose: true }, 'agent'),
      );
      const proposal = dryrun['proposal'] as { proposalId: string; requestId: string };
      proposalId = proposal.proposalId;
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposal.requestId, approved: true });
      // 注入「settle 提交失败」（=旧协议 bundle 已提交/settle 未提交的崩溃窗口；
      // 新协议 settle 在 bundle 事务内——失败即整体回滚）。
      const injected = f.auth as unknown as { settleExternal: (proposalId: string, outcome: unknown) => void };
      injected.settleExternal = () => {
        throw new Error('注入：settle 提交失败（崩溃窗口探针）');
      };
      const first = await f.registry.call('studio.export', { taskId: f.taskId, proposalId }, 'agent');
      expect(first).toMatchObject({ kind: 'failed' });
      // 原子性证明：result 行零提交、bundle 目录零残留（旧协议此处=1 个已发布 bundle）。
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM results').get() as { n: number }).n).toBe(0);
      expect(readdirSync(path.join(f.s.config.dataRoot, 'results'))).toHaveLength(0);
      // op 停留 claimed（consume 已提交、bundle 未发布）——重启恢复面。
      expect((f.s.db.prepare('SELECT state FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string }).state).toBe('claimed');
      f.s.db.close(); // 「重启」
    } finally {
      if (f.s.db.open) f.s.db.close();
    }
    // 重开同一 DATA_ROOT（真实重启）+ 启动收敛 → op unknown。
    const s2 = createServices(undefined, { imgDryRun: true, root });
    try {
      const auth2 = new ApprovalService({ db: s2.db, jobs: s2.jobs });
      const registry2 = createStudioCapabilities({
        db: s2.db,
        blobs: s2.blobs,
        jobs: s2.jobs,
        approvals: auth2,
        config: s2.config,
        revokeResult: (resultId) => s2.sessions.revokeResult(resultId),
      });
      const recovered = auth2.recoverNonTerminal();
      expect(recovered.ops).toBe(1);
      expect((s2.db.prepare('SELECT state FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string }).state).toBe('unknown');
      // 同键 retry（用户确认）→ attempt 建立 + op re-arm → 执行。
      const retry = auth2.retry(s2.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'export-once-key' });
      expect(retry.attemptNo).toBe(1);
      const done = await valueOf(await registry2.call('studio.export', { taskId: f.taskId, proposalId }, 'agent'));
      const resultId = done['resultId'] as string;
      expect(resultId).toMatch(/^[0-9a-f-]{36}$/);
      // bundle 计数=1：结果行唯一且即返回值；分享目录唯一。
      const rows = s2.db.prepare('SELECT id FROM results').all() as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: resultId });
      expect(readdirSync(path.join(s2.config.dataRoot, 'results'))).toHaveLength(1);
      // op 收敛 succeeded+result_ref=同一 resultId（恢复不落 unknown、retry 不再发布第二个）。
      const op = s2.db.prepare('SELECT state, result_ref FROM approved_ops WHERE proposal_id = ?').get(proposalId) as { state: string; result_ref: string };
      expect(op.state).toBe('succeeded');
      expect(op.result_ref).toBe(resultId);
      // settle 收敛面覆盖 claimed attempt：无 claimed/running 残留（P1-3 附带修复项）。
      const attempts = s2.db.prepare('SELECT state FROM attempts WHERE proposal_id = ?').all(proposalId) as Array<{ state: string }>;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ state: 'succeeded' });
      // 同键 retry 重放不再触发执行面（幂等呈现）。
      const replay = auth2.retry(s2.anonymous, { sessionId: f.sessionId, proposalId, costConfirmed: true, retryRequestId: 'export-once-key' });
      expect(replay.attemptNo).toBe(1);
      expect((s2.db.prepare('SELECT COUNT(*) AS n FROM results').get() as { n: number }).n).toBe(1);
    } finally {
      s2.dispose();
    }
  });
});

describe('custom 形资产解析（W4.2 R1 P1-4——Agent 导出路径真实 .gemshape fixture）', () => {
  /** .gemshape 资产（vectorPath 方框形+贴图——内容不可变格式合法形态，与 engine.test.ts 同式）。 */
  function gemshapeAsset(name: string): Buffer {
    const tex = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return Buffer.from(
      JSON.stringify({
        kind: 'gemshape',
        formatVersion: 1,
        appVersion: '0.1.0',
        createdAt: Date.now(),
        savedAt: Date.now(),
        name,
        texture: { mime: 'image/png', dataUrl: tex, width: 1, height: 1 },
        vectorPath: 'M 0.1 0.1 L 0.9 0.1 L 0.9 0.9 L 0.1 0.9 Z',
        physical: { widthMm: 3, heightMm: 3 },
        calibration: { mode: 'direct' },
      }),
      'utf8',
    );
  }

  function setupCustomShape(): ToolFixture & { customResourceId: string } {
    const f = setupTools();
    const assetRef = f.s.blobs.put(new Uint8Array(gemshapeAsset('方框钻'))).hash;
    const doc = f.doc();
    const customDoc: LayoutDocument = {
      ...doc,
      gems: doc.gems.map((gem) => ({ ...gem, shapeId: 'custom', assetId: 'ast-square' })) as LayoutDocument['gems'],
      shapeAssets: { 'ast-square': assetRef },
      pave: { ...doc.pave, spec: { ...doc.pave.spec, shapeId: 'custom', assetId: 'ast-square' } },
    };
    const published = publishLayoutDocument(f.s.db, f.s.blobs, f.s.anonymous.id, '方框钻真值.gemdoc', customDoc);
    return { ...f, customResourceId: published.resourceId };
  }

  it('custom 形 export-dryrun verdict.ok=true（有效资产可达——非 missing-asset）+ 真实 export 三产物含贴图形（非 missing）', async () => {
    const f = setupCustomShape();
    try {
      const dryrun = await valueOf(
        await f.registry.call('studio.export-dryrun', { taskId: f.taskId, resourceId: f.customResourceId, propose: true }, 'agent'),
      );
      expect((dryrun['verdict'] as { ok: boolean }).ok).toBe(true);
      const proposal = dryrun['proposal'] as { proposalId: string; requestId: string };
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposal.requestId, approved: true });
      const exported = await valueOf(await f.registry.call('studio.export', { taskId: f.taskId, proposalId: proposal.proposalId }, 'agent'));
      const bundle = exported['bundle'] as { svg: string; bom: string; png: string };
      // SVG：custom 矢量 path 直通（矢量优先），无 missing 占位标记。
      const svg = f.s.blobs.read(bundle.svg)!.toString('utf8');
      expect(svg).toContain('M 0.1 0.1 L 0.9 0.1');
      expect(svg).not.toContain('data-missing');
      // BOM：custom 规格行呈现资产 id，无「资产缺失」标注。
      const bom = f.s.blobs.read(bundle.bom)!.toString('utf8');
      expect(bom).toContain('custom-ast-square');
      expect(bom).not.toContain('资产缺失');
      // PNG：可解码、尺寸正确、有实际钻形像素（非空渲染）。
      const png = decodePng(f.s.blobs.read(bundle.png)!);
      expect(png.width).toBe(f.doc().imageWidth);
      expect(png.height).toBe(f.doc().imageHeight);
      let opaque = 0;
      for (let p = 3; p < png.rgba.length; p += 4) if (png.rgba[p]! > 0) opaque += 1;
      expect(opaque).toBeGreaterThan(0);
    } finally {
      f.s.dispose();
    }
  });

  it('缺失资产分支：assetId 无对应 shapeAssets 映射 → dryrun missing-asset 违规（显式拒绝，不静默画圆）', async () => {
    const f = setupTools();
    try {
      const doc = f.doc();
      const dangling: LayoutDocument = {
        ...doc,
        gems: doc.gems.slice(0, 4).map((gem) => ({ ...gem, shapeId: 'custom', assetId: 'ast-gone' })) as LayoutDocument['gems'],
        shapeAssets: {}, // assetId 存在但映射缺席——blob-missing/节点不存在
      };
      const published = publishLayoutDocument(f.s.db, f.s.blobs, f.s.anonymous.id, '悬空资产.gemdoc', dangling);
      const dryrun = await valueOf(
        await f.registry.call('studio.export-dryrun', { taskId: f.taskId, resourceId: published.resourceId }, 'agent'),
      );
      const verdict = dryrun['verdict'] as { ok: boolean; violations: Array<{ kind: string }> };
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.some((v) => v.kind === 'missing-asset')).toBe(true);
    } finally {
      f.s.dispose();
    }
  });
});

describe('undo 显式 group 绑定（W4.2 R1 P2-1——跨资源/owner 必拒）', () => {
  it('另一资源的 group / 他人资源的 group 必拒；本资源自有 group 正常回退', async () => {
    const f = setupTools();
    try {
      // 两资源各落一组 patch（组=proposalId）。
      const applyDensityPatch = async (resourceId: string): Promise<string> => {
        const target = loadLayoutDocument(f.s.db, f.s.blobs, f.s.anonymous.id, resourceId).doc.blocks[0]!.id;
        const proposed = await valueOf(
          await f.registry.call(
            'studio.patch-propose',
            { taskId: f.taskId, resourceId, region: { kind: 'blocks', ids: [target] }, changes: [{ op: 'setDensity', target, after: 0.5 }] },
            'agent',
          ),
        );
        const { proposalId, requestId } = proposed as { proposalId: string; requestId: string };
        f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId, approved: true });
        await f.registry.call('studio.patch-apply', { taskId: f.taskId, proposalId }, 'agent');
        return proposalId;
      };
      const secondDoc = f.doc();
      const second = publishLayoutDocument(f.s.db, f.s.blobs, f.s.anonymous.id, '第二资源.gemdoc', secondDoc);
      const groupA = await applyDensityPatch(f.resourceId);
      await applyDensityPatch(second.resourceId);

      // 跨资源：R2 的 undo 引用 R1 的 group → 必拒（revision 不动）。
      const cross = await f.registry.call('studio.undo', { family: 'patch', resourceId: second.resourceId, group: groupA }, 'human-ui');
      expect(cross).toMatchObject({ kind: 'failed' });
      expect((cross as { message: string }).message).toContain('跨资源/owner');
      expect((f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(second.resourceId) as { revision: number }).revision).toBe(2);

      // 跨 owner：B 的资源引用 A 的 group → 必拒。
      const userB = createUser(f.s.db, { username: 'undo-b', passwordHash: 'x', role: 'user' });
      const bDoc = f.doc();
      const bResource = publishLayoutDocument(f.s.db, f.s.blobs, userB.id, 'B 资源.gemdoc', bDoc);
      const crossOwner = await f.registry.call('studio.undo', { family: 'patch', resourceId: bResource.resourceId, group: groupA }, 'human-ui');
      expect(crossOwner).toMatchObject({ kind: 'failed' });
      expect((crossOwner as { message: string }).message).toContain('跨资源/owner');

      // 正向对照：本资源自有 group 正常整组回退。
      const ok = await f.registry.call('studio.undo', { family: 'patch', resourceId: f.resourceId, group: groupA }, 'human-ui');
      expect(ok).toMatchObject({ kind: 'ok' });
      expect((f.s.db.prepare('SELECT revision FROM resources WHERE id = ?').get(f.resourceId) as { revision: number }).revision).toBe(3);
    } finally {
      f.s.dispose();
    }
  });
});
