/**
 * segmentOne 单步细分原子测试（add-task-detail-layer-workbench tasks 1.2）。
 * 桥=可编程 MockSamTransport / 合成 mock（SAM_BRIDGE_MOCK 同款确定性面）——零外呼
 * 零常驻进程。覆盖：
 *   [1] 全链：树工件读回 → 单次 SAM（text 提示透传断言）→ 父∩子 → 子节点入树 →
 *       双轨落档（object-tree.json/object-tree-preview.png 工件+artifact 帧）。
 *   [2] blob 态 mask 归一（persist inlineMaxBytes:0 全转 blob 的树同样可细分）。
 *   [3] 父∩子防外溢（全画布响应掩码被父掩码裁住——bbox ⊆ 父 bbox）。
 *   [4] 零检出：空掩码响应=children []+warning+树内容不变（同 blobRef）。
 *   [5] 兄弟互斥（新子被 worthy 兄弟完全吞没=child-consumed warning+children []）。
 *   [6] typed error 面：node-not-found / bridge-failure / fence（cancelled 任务）/
 *       anchor-mismatch（imagePx 与原图不符）。
 */
import { describe, expect, it } from 'vitest';
import {
  decodeInlineMask,
  ObjectTreeSchema,
  encodeInlineMask,
  type ObjectNode,
  type ObjectTree,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask, updateTask } from '../src/db/jobs.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import { MockSamTransport, SamBridge } from '../src/kernel/vision/sam-bridge.js';
import {
  createSyntheticMockSamTransport,
} from '../src/kernel/vision/segment-tool.js';
import {
  OBJECT_TREE_ARTIFACT_NAME,
  OBJECT_TREE_PREVIEW_ARTIFACT_NAME,
  segmentOne,
  SegmentOneError,
  type SegmentOneOutcome,
} from '../src/kernel/vision/segment-one.js';
import {
  persistObjectTreeArtifact,
} from '../src/kernel/vision/tree-persist.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

/** 96×96 三色图（左红/右蓝/底部黄带——Lab 方差有真实信号）。 */
function testImage(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const [r, g, b] = y >= 80 ? [230, 200, 40] : x < w / 2 ? [200, 40, 40] : [40, 60, 200];
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
    }
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

const CANVAS_CM = { w: 10, h: 10 };
const IMAGE_PX = { width: 96, height: 96 };

function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

/**
 * 基树：n-root 画布（全幅，非钻）→ n-person 主体（中央 70×66，drillWorthy）。
 * 坐标系与 subject.segment 多主体产物同构（画布结构性根）。
 */
function baseTree(): ObjectTree {
  const person: ObjectNode = {
    id: 'n-person',
    objectName: '主体',
    category: 'person',
    mask: solidMask(70, 66),
    bbox: { x: 10, y: 8, w: 70, h: 66 },
    parent: 'n-root',
    children: [],
    effectiveMm: 68,
    labVariance: 20,
    drillWorthy: true,
    origin: 'vlm+sam3',
  };
  const root: ObjectNode = {
    id: 'n-root',
    objectName: '画布',
    category: 'canvas',
    mask: solidMask(96, 96),
    bbox: { x: 0, y: 0, w: 96, h: 96 },
    parent: null,
    children: [person.id],
    effectiveMm: 96,
    labVariance: 30,
    drillWorthy: false,
    origin: 'vlm+sam3',
  };
  return ObjectTreeSchema.parse({
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    nodes: [root, person],
    createdAt: '2026-09-26T00:00:00.000Z',
  });
}

interface Fixture {
  s: TestServices;
  taskId: string;
  imageBlobRef: string;
  transport: MockSamTransport;
  bridge: SamBridge;
  /** 落树工件（inlineMaxBytes=0 时全转 blob——blob 态归一用例）并返回 blobRef。 */
  plantTree(tree: ObjectTree, inlineMaxBytes?: number): string;
  frames(): Array<{ kind: string; payload: Record<string, unknown> }>;
}

function setup(): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'segment-one 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const transport = new MockSamTransport();
  const bridge = new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport });
  return {
    s,
    taskId: task.id,
    imageBlobRef,
    transport,
    bridge,
    plantTree: (tree, inlineMaxBytes) => {
      const persisted = persistObjectTreeArtifact(
        { db: s.db, blobs: s.blobs },
        task.id,
        tree,
        inlineMaxBytes === undefined ? {} : { inlineMaxBytes },
      );
      return persisted.treeBlobRef;
    },
    frames: () =>
      s.jobs.frames(s.anonymous, task.id, 0).frames.map((f) => ({
        kind: f.kind as string,
        payload: f.payload as Record<string, unknown>,
      })),
  };
}

function segmentResponse(mask: { w: number; h: number; bits: Uint8Array }, score = 0.8) {
  return {
    kind: 'segment' as const,
    mask: encodeInlineMask(mask.w, mask.h, mask.bits),
    score,
    meta: { model: 'mock', durationMs: 1, iteration: 0 },
  };
}

/** 中央椭圆掩码（合成 mock 桥同款几何——96×96 半径 r）。 */
function ellipseBits(w: number, h: number, r: number): Uint8Array {
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2;
      const dy = y - h / 2;
      if (dx * dx + dy * dy <= r * r) bits[y * w + x] = 1;
    }
  }
  return bits;
}

function popcount(bits: Uint8Array): number {
  let n = 0;
  for (const b of bits) n += b;
  return n;
}

async function okOf(promise: Promise<SegmentOneOutcome>): Promise<SegmentOneOutcome> {
  return await promise;
}

// ---------------------------------------------------------------- [1] 全链

describe('segmentOne 全链', () => {
  it('单次细分：提示透传+子节点入树+双工件+artifact 帧', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    f.transport.respond((call) => {
      // 提示透传断言（text 提示=hint 原文；iteration 单步=0）
      expect(call.request.kind).toBe('segment');
      if (call.request.kind === 'segment') {
        expect(call.request.prompt).toMatchObject({ kind: 'text', text: 'hat' });
        expect(call.request.imageBlobRef).toBe(f.imageBlobRef);
        expect(call.request.iteration).toBe(0);
      }
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    const outcome = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
    ));
    expect(outcome.children).toHaveLength(1);
    const child = outcome.children[0]!;
    expect(child.parent).toBe('n-person');
    expect(child.objectName).toBe('hat');
    expect(child.category).toBe('hat'); // HINT_CATEGORY_MAP 固定映射 [4]
    expect(child.drillWorthy).toBe(true); // 排除开关继承
    expect(outcome.treeBlobRef).not.toBe(treeBlobRef);
    // 落档树可回读：新子在树内且父子双向闭合
    const persisted = ObjectTreeSchema.parse(
      JSON.parse(f.s.blobs.read(outcome.treeBlobRef)!.toString('utf8')),
    );
    const parent = persisted.nodes.find((n) => n.id === 'n-person')!;
    expect(parent.children).toContain(child.id);
    // artifact 帧登记（latest-by-name=新树）
    const names = f.frames().filter((fr) => fr.kind === 'artifact').map((fr) => fr.payload.name);
    expect(names).toContain(OBJECT_TREE_ARTIFACT_NAME);
    expect(names).toContain(OBJECT_TREE_PREVIEW_ARTIFACT_NAME);
    f.s.dispose();
  });

  it('子节点 id 沿 sam-node-NNNN 确定性空间递增', async () => {
    const f = setup();
    const tree = baseTree();
    tree.nodes[1]!.id = 'sam-node-0007';
    tree.nodes[0]!.children = ['sam-node-0007'];
    const treeBlobRef = f.plantTree(tree);
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
    const outcome = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'sam-node-0007', hint: 'hat' },
    ));
    expect(outcome.children[0]!.id).toBe('sam-node-0008');
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [2] blob 态归一

it('blob 态 mask 的树同样可细分（persist 全转 blob→读回归一 inline→掩码运算）', async () => {
  const f = setup();
  const treeBlobRef = f.plantTree(baseTree(), 0); // inlineMaxBytes=0：全部 mask 转 blob
  const planted = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(treeBlobRef)!.toString('utf8')));
  expect(planted.nodes.every((n) => n.mask.kind === 'blob')).toBe(true);
  f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
  const outcome = await okOf(segmentOne(
    { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
    { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
  ));
  expect(outcome.children).toHaveLength(1);
  f.s.dispose();
});

// ---------------------------------------------------------------- [3] 父∩子防外溢

it('桥响应掩码越出父掩码被位与裁住（child bbox ⊆ 父 bbox）', async () => {
  const f = setup();
  const treeBlobRef = f.plantTree(baseTree());
  f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: new Uint8Array(96 * 96).fill(1) })); // 全画布
  const outcome = await okOf(segmentOne(
    { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
    { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
  ));
  const child = outcome.children[0]!;
  expect(child.bbox.x).toBeGreaterThanOrEqual(10);
  expect(child.bbox.y).toBeGreaterThanOrEqual(8);
  expect(child.bbox.x + child.bbox.w).toBeLessThanOrEqual(80);
  expect(child.bbox.y + child.bbox.h).toBeLessThanOrEqual(74);
  // 子掩码=父∩全画布=父掩码全量（70×66 实心）
  expect(child.bbox).toEqual({ x: 10, y: 8, w: 70, h: 66 });
  f.s.dispose();
});

// ---------------------------------------------------------------- [4] 零检出

it('空掩码响应=children []+no-instance warning+树内容不变（同 blobRef）', async () => {
  const f = setup();
  const treeBlobRef = f.plantTree(baseTree());
  f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: new Uint8Array(96 * 96) }));
  const outcome = await okOf(segmentOne(
    { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
    { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'ghost' },
  ));
  expect(outcome.children).toEqual([]);
  expect(outcome.warnings.some((w) => w.reason === 'no-instance')).toBe(true);
  expect(outcome.treeBlobRef).toBe(treeBlobRef); // 内容寻址：树未变=同 blob
  f.s.dispose();
});

// ---------------------------------------------------------------- [5] 兄弟互斥

it('新子被 worthy 兄弟完全吞没=child-consumed warning+children []', async () => {
  const f = setup();
  // 父=非钻（新子继承 drillWorthy=false）；既有兄弟=全幅 worthy（popcount 大但 worthy 优先胜出）
  const tree = baseTree();
  const person = tree.nodes[1]!;
  person.drillWorthy = false;
  const sibling: ObjectNode = {
    id: 'n-sibling',
    objectName: '兄弟层',
    category: 'person',
    mask: solidMask(96, 96),
    bbox: { x: 0, y: 0, w: 96, h: 96 },
    parent: person.id,
    children: [],
    effectiveMm: 96,
    labVariance: 30,
    drillWorthy: true,
    origin: 'vlm+sam3',
  };
  person.children = [sibling.id];
  tree.nodes.push(sibling);
  const treeBlobRef = f.plantTree(tree);
  f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
  const outcome = await okOf(segmentOne(
    { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
    { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
  ));
  expect(outcome.children).toEqual([]);
  expect(outcome.warnings.some((w) => w.reason === 'child-consumed')).toBe(true);
  // 树闭合：新子未入树（无悬垂节点）
  const persisted = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(outcome.treeBlobRef)!.toString('utf8')));
  expect(persisted.nodes.map((n) => n.id)).not.toContain(outcome.warnings.length === 0 ? '' : 'sam-node-0001');
  f.s.dispose();
});

// ---------------------------------------------------------------- [6] typed error 面

describe('segmentOne typed error', () => {
  it('node-not-found：目标节点不在树', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    await expect(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-missing', hint: 'hat' },
    )).rejects.toMatchObject({ name: 'SegmentOneError', kind: 'node-not-found' });
    f.s.dispose();
  });

  it('bridge-failure：桥失败 typed 上抛不静默', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    f.transport.respond(() => {
      throw new Error('mock transport down');
    });
    await expect(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
    )).rejects.toMatchObject({ name: 'SegmentOneError', kind: 'bridge-failure' });
    f.s.dispose();
  });

  it('fence：cancelled 任务产物写入被拒', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    updateTask(f.s.db, f.taskId, { status: 'cancelled' });
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
    await expect(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
    )).rejects.toMatchObject({ name: 'SegmentOneError', kind: 'fence' });
    f.s.dispose();
  });

  it('anchor-mismatch：tree.imagePx 与原图不符必拒', async () => {
    const f = setup();
    const tree = baseTree();
    tree.imagePx = { width: 64, height: 64 };
    // persistTreeWithPreview 才校验解码尺寸；此处仅落 JSON 工件（读回面测试直入）
    const bytes = Buffer.from(JSON.stringify(tree), 'utf8');
    const treeBlobRef = putTaskArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, bytes).hash;
    await expect(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
    )).rejects.toMatchObject({ name: 'SegmentOneError', kind: 'anchor-mismatch' });
    f.s.dispose();
  });

  it('invalid-input：契约外字段必拒', async () => {
    const f = setup();
    await expect(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef: 'a'.repeat(64), nodeId: 'n-person', hint: '' },
    )).rejects.toBeInstanceOf(SegmentOneError);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [7] 合成 mock 桥（env 装配同款）

it('合成 mock 桥（SAM_BRIDGE_MOCK 同款）端到端：text 提示→哈希派生椭圆∩父掩码', async () => {
  const f = setup();
  const treeBlobRef = f.plantTree(baseTree());
  const bridge = new SamBridge(
    { db: f.s.db, blobs: f.s.blobs, dataRoot: f.s.config.dataRoot },
    { transport: createSyntheticMockSamTransport() },
  );
  const outcome = await okOf(segmentOne(
    { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge },
    { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
  ));
  expect(outcome.children).toHaveLength(1);
  const child = outcome.children[0]!;
  const bits = child.mask.kind === 'inline' ? decodeInlineMask(child.mask).bits : null;
  expect(bits).not.toBeNull();
  expect(popcount(bits!)).toBeGreaterThan(0);
  f.s.dispose();
});
