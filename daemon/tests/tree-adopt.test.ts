/**
 * tree.adopt 跨任务树领养（2026-10-05 Owner 报障「打开完整工作台→该任务尚无图层树」
 * ——fail-then-resume 流终局任务树域空的修复面）：
 *   [1] 同会话领养：源任务最新树版本内容寻址零拷贝转发（双工件帧+journey 基线入链）
 *       →task.detail tree 投影非空；幂等（链尾已覆盖=版本不变零新增行）。
 *   [2] 跨会话 typed 拒（tree-adopt-not-same-session）。
 *   [3] 源无树 typed 拒（tree-adopt-source-empty）。
 */
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, ObjectTreeSchema, encodeInlineMask } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { HandicraftKernel } from '../src/kernel/index.js';
import { createServices, clientFor, type TestServices } from './helpers.js';

function minimalTree() {
  const inline = encodeInlineMask(2, 2, new Uint8Array([1, 1, 1, 0]));
  const node = (id: string, parent: string | null, children: string[]): ObjectNodeSchema extends never ? never : ReturnType<typeof ObjectNodeSchema.parse> =>
    ObjectNodeSchema.parse({
      id,
      objectName: `节点-${id}`,
      category: 'structure',
      mask: inline,
      bbox: { x: 10, y: 20, w: 2, h: 2 },
      parent,
      children,
      effectiveMm: 6.4,
      labVariance: 4.2,
      drillWorthy: true,
      origin: 'vlm+sam3',
    });
  return ObjectTreeSchema.parse({
    kind: 'object-tree' as const,
    formatVersion: 1 as const,
    canvasCm: { w: 20, h: 20 },
    imagePx: { width: 500, height: 500 },
    nodes: [node('n-root', null, ['n-child']), node('n-child', 'n-root', [])],
    createdAt: new Date().toISOString(),
  });
}

interface Fixture {
  s: TestServices;
  client: ReturnType<typeof clientFor>;
  sourceTaskId: string;
  targetTaskId: string;
}

/** 同会话双任务 fixture；源任务手植一版树（blob+版本行——内容寻址真源形态）。 */
async function setup(withSourceTree = true, sameSession = true): Promise<Fixture> {
  const s = createServices(undefined, { imgDryRun: true });
  const sessionId = s.sessions.create(s.anonymous, { title: 'tree-adopt 测试' }).sessionId;
  const otherSessionId = sameSession ? sessionId : s.sessions.create(s.anonymous, { title: '另一会话' }).sessionId;
  const sourceTaskId = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'done' }).id;
  const targetTaskId = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId: otherSessionId, status: 'done' }).id;
  if (withSourceTree) {
    const tree = minimalTree();
    const treeRef = s.blobs.put(Buffer.from(JSON.stringify(tree), 'utf8')).hash;
    const previewRef = s.blobs.put(new Uint8Array(encodePng(4, 4, new Uint8Array(4 * 4 * 4).fill(255)))).hash;
    s.db
      .prepare('INSERT INTO tree_versions (task_id, version, tree_blob_ref, preview_blob_ref, cause, detail, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sourceTaskId, 1, treeRef, previewRef, 'segment-one', '手植测试树', s.anonymous.id, new Date().toISOString());
  }
  const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
  const client = clientFor(s.context({ kernel, token: await s.tokenFor() }));
  return { s, client, sourceTaskId, targetTaskId };
}

describe('tree.adopt 跨任务树领养', () => {
  it('同会话领养：双工件帧+journey 入链+detail.tree 非空；幂等零新增', async () => {
    const f = await setup();
    const out = await f.client.tree.adopt({ taskId: f.targetTaskId, fromTaskId: f.sourceTaskId });
    expect(out.ok).toBe(true);
    expect(out.nodeCount).toBe(2);
    expect(out.version).toBeGreaterThan(0);
    // 目标任务帧流有 object-tree.json；版本链有一行
    const frames = f.s.jobs.framesAfter(f.targetTaskId, 0);
    const treeFrame = frames.find((x) => x.kind === 'artifact' && (x.payload as { name?: string }).name === 'object-tree.json');
    expect(treeFrame).toBeDefined();
    const rows = f.s.db.prepare('SELECT COUNT(*) AS c FROM tree_versions WHERE task_id = ?').get(f.targetTaskId) as { c: number };
    expect(rows.c).toBe(1);
    // task.detail 树投影非空（Owner 报障面）
    const detail = await f.client.task.detail({ taskId: f.targetTaskId });
    expect((detail as { tree?: unknown }).tree).not.toBeNull();
    // 幂等：重复领养零新增行、版本不变
    const again = await f.client.tree.adopt({ taskId: f.targetTaskId, fromTaskId: f.sourceTaskId });
    const rows2 = f.s.db.prepare('SELECT COUNT(*) AS c FROM tree_versions WHERE task_id = ?').get(f.targetTaskId) as { c: number };
    expect(rows2.c).toBe(1);
    expect(again.version).toBe(out.version);
  });

  it('跨会话 typed 拒（tree-adopt-not-same-session）', async () => {
    const f = await setup(true, false);
    await expect(f.client.tree.adopt({ taskId: f.targetTaskId, fromTaskId: f.sourceTaskId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      data: { code: 'tree-adopt-not-same-session' },
    });
  });

  it('源无树 typed 拒（tree-adopt-source-empty）', async () => {
    const f = await setup(false, true);
    await expect(f.client.tree.adopt({ taskId: f.targetTaskId, fromTaskId: f.sourceTaskId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      data: { code: 'tree-adopt-source-empty' },
    });
  });
});
