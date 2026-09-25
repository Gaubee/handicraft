/**
 * object-tree 工件持久化+树视图叠加预览（add-subject-sam-pipeline P0.4）。
 * 形态沿仓内先例：job 路径=engine.test.ts（createServices+extraRunners+waitSettled，
 * artifact 帧登记核对）；fence 路径=sessions-clear.test.ts「cancelled 任务 fence 拒绝」
 * （R2 探针镜像：行尚存、状态 cancelled → putTaskArtifact 面零写入）。
 * 覆盖：两态 mask（小 inline 保留/大 inline→blob/pre-blob 保留）round-trip 等价、
 * DFS 规范序+确定性（同树同 hash）、预览 PNG 可解码+框像素（绿系/红）+与底图差异、
 * 尺寸锚点不符显式拒、cancelled 拒写。
 */
import { describe, expect, it } from 'vitest';
import { ObjectTreeSchema, encodeInlineMask, type ObjectTree } from '@handicraft/contracts';
import { createJobTask } from '../src/db/jobs.js';
import type { JobDefinition } from '../src/jobs/service.js';
import {
  MASK_INLINE_PERSIST_MAX_BYTES,
  loadObjectTreeArtifact,
  persistObjectTreeArtifact,
  persistTreeWithPreview,
  resolveMaskBits,
} from '../src/kernel/vision/tree-persist.js';
import { renderTreeOverlayPreview } from '../src/kernel/vision/tree-preview.js';
import { decodePng, encodePng } from '../src/png/codec.js';
import { createServices } from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitSettled(s: ReturnType<typeof createServices>, taskId: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await s.jobs.get(s.anonymous, taskId);
    if (task.status !== 'queued' && task.status !== 'running') return task;
    await sleep(25);
  }
  throw new Error('任务未在期限内收敛');
}

// ---------------------------------------------------------------- fixture

/** 80×80 纵向渐变蓝底图（非平图——预览差异断言有内容可依）。 */
function gradientPng(w = 80, h = 80): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = 20 + Math.floor((x / w) * 60);
      rgba[p + 1] = 40;
      rgba[p + 2] = 120 + Math.floor((y / h) * 100);
      rgba[p + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

/** 确定性非平凡掩码（斜纹——非全 0/1，round-trip 有区分度）。 */
function stripedBits(w: number, h: number): Uint8Array {
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      bits[y * w + x] = (x + y) % 7 < 3 ? 1 : 0;
    }
  }
  return bits;
}

interface FixtureTree {
  tree: ObjectTree;
  poleMaskBlobRef: string;
}

/** 两层树：路灯（根，大 inline 掩码→转 blob）+ 灯头（排除，小 inline 保留）+ 杆（pre-blob 保留）。 */
async function makeTree(s: ReturnType<typeof createServices>): Promise<FixtureTree> {
  const rootBits = stripedBits(70, 70); // 4900 字节 > 4096 → 转 blob
  const headBits = stripedBits(20, 20); // 400 字节 ≤ 阈值 → 保持 inline
  const poleBits = stripedBits(14, 40);
  const poleMaskBlobRef = s.blobs.put(poleBits).hash;
  const tree = ObjectTreeSchema.parse({
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 8, h: 8 },
    imagePx: { width: 80, height: 80 },
    nodes: [
      {
        id: 'obj-streetlight',
        objectName: '路灯',
        category: 'structure',
        mask: encodeInlineMask(70, 70, rootBits),
        bbox: { x: 4, y: 4, w: 70, h: 70 },
        parent: null,
        children: ['obj-head', 'obj-pole'],
        effectiveMm: 42.5,
        labVariance: 18.2,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
      {
        id: 'obj-head',
        objectName: '路灯·灯头',
        category: 'light',
        mask: encodeInlineMask(20, 20, headBits),
        bbox: { x: 8, y: 8, w: 20, h: 20 },
        parent: 'obj-streetlight',
        children: [],
        effectiveMm: 12.0,
        labVariance: 3.1,
        drillWorthy: false, // 排除节点——预览红框
        origin: 'vlm+sam3',
      },
      {
        id: 'obj-pole',
        objectName: '路灯·杆',
        category: 'structure',
        mask: { kind: 'blob', w: 14, h: 40, blobRef: poleMaskBlobRef },
        bbox: { x: 36, y: 30, w: 14, h: 40 },
        parent: 'obj-streetlight',
        children: [],
        effectiveMm: 20.4,
        labVariance: 6.7,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
    ],
    createdAt: '2026-09-25T00:00:00.000Z',
  }) as ObjectTree;
  return { tree, poleMaskBlobRef };
}

/** P2.4 tree.build 工具的 job 形态预演（extraRunners 注入——不动 helpers 共享面）。 */
function kernelTreeRunner(): JobDefinition {
  return {
    run: async (ctx) => {
      const params = ctx.params as { imageRef: string; tree: unknown };
      const tree = ObjectTreeSchema.parse(params.tree);
      const bundle = persistTreeWithPreview(ctx.deps, ctx.taskId, params.imageRef, tree);
      ctx.emit('artifact', { blobRef: bundle.treeBlobRef, name: 'object-tree.json' });
      ctx.emit('artifact', { blobRef: bundle.previewBlobRef, name: 'object-tree-preview.png' });
      ctx.emit('log', {
        text: `object-tree 定型：${bundle.persisted.nodes.length} 节点，预览 ${bundle.legend.length} 框（mask 转 blob ${bundle.maskBlobRefs.size}）`,
      });
    },
  };
}

function countColor(
  rgba: Uint8Array,
  match: (r: number, g: number, b: number) => boolean,
): number {
  let n = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    if (match(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!)) n++;
  }
  return n;
}

// ---------------------------------------------------------------- tests

describe('object-tree 工件持久化+预览（P0.4）', () => {
  it('双轨落盘：round-trip 等价（含 inline→blob）+工件登记帧+预览框像素', async () => {
    const s = createServices({ 'kernel-tree': kernelTreeRunner() });
    try {
      const { tree, poleMaskBlobRef } = await makeTree(s);
      const imageRef = s.blobs.put(gradientPng()).hash;
      const task = await s.jobs.create(s.anonymous, {
        kind: 'kernel-tree',
        params: { imageRef, tree },
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      // 工件登记（artifact 帧行存在——仓内登记面）
      const frames = s.jobs.frames(s.anonymous, task.taskId, 0).frames;
      const artifacts = frames.filter((f) => f.kind === 'artifact');
      const names = artifacts.map((f) => (f.payload as { name: string }).name);
      expect(names).toEqual(['object-tree.json', 'object-tree-preview.png']);
      const treeBlobRef = (artifacts[0]!.payload as { blobRef: string }).blobRef;
      const previewBlobRef = (artifacts[1]!.payload as { blobRef: string }).blobRef;

      // round-trip：读回=规范序（DFS 先序）+逐节点等价
      const loaded = loadObjectTreeArtifact(s.blobs, treeBlobRef);
      expect(loaded.nodes.map((n) => n.id)).toEqual(['obj-streetlight', 'obj-head', 'obj-pole']);
      const originalById = new Map(tree.nodes.map((n) => [n.id, n] as const));
      for (const node of loaded.nodes) {
        const before = originalById.get(node.id)!;
        expect(node.objectName).toBe(before.objectName);
        expect(node.category).toBe(before.category);
        expect(node.bbox).toEqual(before.bbox);
        expect(node.drillWorthy).toBe(before.drillWorthy);
        expect(node.effectiveMm).toBe(before.effectiveMm);
        expect(node.labVariance).toBe(before.labVariance);
        // 两态 mask 语义等价：解码 bits 逐字节相同
        const restored = resolveMaskBits(s.blobs, node.mask);
        const source = resolveMaskBits(s.blobs, before.mask);
        expect(restored.w).toBe(source.w);
        expect(restored.h).toBe(source.h);
        expect(Buffer.from(restored.bits).equals(Buffer.from(source.bits))).toBe(true);
      }
      // 三态落点：根大 inline→blob；灯头小 inline 保留；杆 pre-blob 原引用保留
      expect(loaded.nodes[0]!.mask.kind).toBe('blob');
      expect(loaded.nodes[1]!.mask.kind).toBe('inline');
      expect(loaded.nodes[2]!.mask.kind).toBe('blob');
      if (loaded.nodes[2]!.mask.kind === 'blob') {
        expect(loaded.nodes[2]!.mask.blobRef).toBe(poleMaskBlobRef);
      }

      // 预览：可解码+同尺寸+框像素（根=亮绿/杆=次绿/灯头=红）+与底图有差异
      const previewBytes = s.blobs.read(previewBlobRef)!;
      const decoded = decodePng(previewBytes);
      expect(decoded.width).toBe(80);
      expect(decoded.height).toBe(80);
      const brightGreen = countColor(decoded.rgba, (r, g, b) => r === 0 && g === 255 && b === 0);
      const midGreen = countColor(decoded.rgba, (r, g, b) => r === 0 && g === 190 && b === 0);
      const red = countColor(decoded.rgba, (r, g, b) => r === 255 && g === 0 && b === 0);
      expect(brightGreen).toBeGreaterThan(0); // depth 0 根框
      expect(midGreen).toBeGreaterThan(0); // depth 1 杆框（深浅层级）
      expect(red).toBeGreaterThan(0); // 排除节点红框
      const originalDecoded = decodePng(gradientPng());
      const changed = (() => {
        let n = 0;
        for (let i = 0; i < decoded.rgba.length; i++) {
          if (decoded.rgba[i] !== originalDecoded.rgba[i]) n++;
        }
        return n;
      })();
      expect(changed).toBeGreaterThan(100); // 非平凡叠加
      // 人看图双轨桥：图上角标序号=JSON 节点序（legend 与 loaded.nodes 一一对齐）
      const bundleLegend = renderTreeOverlayPreview(
        { width: 80, height: 80, rgba: originalDecoded.rgba },
        loaded,
      ).legend;
      expect(bundleLegend.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(bundleLegend.map((e) => e.nodeId)).toEqual(loaded.nodes.map((n) => n.id));
      expect(bundleLegend.map((e) => e.objectName)).toEqual(['路灯', '路灯·灯头', '路灯·杆']);
      expect(bundleLegend.map((e) => e.drillWorthy)).toEqual([true, false, true]);
    } finally {
      s.dispose();
    }
  });

  it('确定性：同树重复持久化同 hash；已 blob 态二次零转换', async () => {
    const s = createServices();
    try {
      const { tree } = await makeTree(s);
      const taskId = createJobTask(s.db, {
        ownerId: s.anonymous.id,
        paramsJson: JSON.stringify({ kind: 'kernel-tree', params: {} }),
      }).id;
      const first = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, taskId, tree);
      expect(70 * 70).toBeGreaterThan(MASK_INLINE_PERSIST_MAX_BYTES); // 根掩码确在阈值外
      expect(first.maskBlobRefs.size).toBe(1); // 仅根大 inline 转换
      expect(first.maskBlobRefs.has('obj-streetlight')).toBe(true);
      const second = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, taskId, first.persisted);
      expect(second.treeBlobRef).toBe(first.treeBlobRef); // 内容寻址去重：同 JSON 同 hash
      expect(second.maskBlobRefs.size).toBe(0); // 已 blob 态不再转换
      // 阈值语义直证：全转 blob（inlineMaxBytes=0）时小 inline 也转换
      const all = persistObjectTreeArtifact(
        { db: s.db, blobs: s.blobs },
        taskId,
        tree,
        { inlineMaxBytes: 0 },
      );
      expect(all.persisted.nodes.every((n) => n.mask.kind === 'blob')).toBe(true);
    } finally {
      s.dispose();
    }
  });

  it('锚点防呆：tree.imagePx 与原图不符显式拒（任务失败非静默）', async () => {
    const s = createServices({ 'kernel-tree': kernelTreeRunner() });
    try {
      const { tree } = await makeTree(s);
      const mismatched = ObjectTreeSchema.parse({
        ...tree,
        imagePx: { width: 40, height: 40 },
      }) as ObjectTree;
      const imageRef = s.blobs.put(gradientPng()).hash;
      const task = await s.jobs.create(s.anonymous, {
        kind: 'kernel-tree',
        params: { imageRef, tree: mismatched },
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('failed');
      expect(final.error).toMatch(/imagePx 与原图尺寸不符/);
    } finally {
      s.dispose();
    }
  });

  it('writer fence：cancelled 任务拒写（tree/预览两入口零新增 blob）', async () => {
    const s = createServices();
    try {
      const { tree } = await makeTree(s);
      // R2 探针镜像：无会话归属任务行，行尚存、状态 cancelled。
      const taskId = createJobTask(s.db, {
        ownerId: s.anonymous.id,
        paramsJson: JSON.stringify({ kind: 'kernel-tree', params: {} }),
      }).id;
      s.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(taskId);
      const blobRows = () =>
        (s.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c;
      const before = blobRows();
      expect(() =>
        persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, taskId, tree),
      ).toThrow(/已取消|已不可写/);
      const imageRef = s.blobs.put(gradientPng()).hash; // 原图非任务域写入（不走 fence）
      expect(() =>
        persistTreeWithPreview({ db: s.db, blobs: s.blobs }, taskId, imageRef, tree),
      ).toThrow(/已取消|已不可写/);
      expect(blobRows()).toBe(before + 1); // 仅原图一行，任务域零写入
    } finally {
      s.dispose();
    }
  });
});
