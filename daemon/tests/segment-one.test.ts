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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeInlineMask,
  ObjectTreeSchema,
  encodeInlineMask,
  type ObjectNode,
  type ObjectTree,
} from '@handicraft/contracts';
import { decodePng, encodePng } from '../src/png/codec.js';
import { createAgentTask, updateTask } from '../src/db/jobs.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import {
  MockSamTransport,
  SAM_SEGMENT_INSTANCES_MAX,
  SamBridge,
  type SamBridgeResponse,
} from '../src/kernel/vision/sam-bridge.js';
import { segmentOneLedgerFingerprint } from '../src/kernel/vision/segment-ledger.js';
import {
  createSyntheticMockSamTransport,
} from '../src/kernel/vision/segment-tool.js';
import {
  renderNodeMaskPreview,
  segmentAgentPreviewMaxSide,
} from '../src/kernel/vision/agent-preview.js';
import { tightBBox } from '../src/kernel/vision/segment-loop.js';
import {
  OBJECT_TREE_ARTIFACT_NAME,
  OBJECT_TREE_PREVIEW_ARTIFACT_NAME,
  segmentOne,
  SegmentOneError,
  type SegmentOneOutcome,
} from '../src/kernel/vision/segment-one.js';
import {
  loadObjectTreeArtifact,
  persistObjectTreeArtifact,
  resolveMaskBits,
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

describe('segmentOne SAM 英文优先（Owner 定调 2026-10-03）', () => {
  it('中文 hint→英译送桥（命名链仍用原 hint）；同 hint 二次调用桥 text 恒定', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    const seenTexts: string[] = [];
    f.transport.respond((call) => {
      if (call.request.kind === 'segment' && call.request.prompt.kind === 'text') {
        seenTexts.push(call.request.prompt.text ?? '');
      }
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    f.transport.respond((call) => {
      if (call.request.kind === 'segment' && call.request.prompt.kind === 'text') {
        seenTexts.push(call.request.prompt.text ?? '');
      }
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    let calls = 0;
    const translate = async (subject: string) => {
      calls += 1;
      return `the ${subject === '帽子' ? 'hat' : subject} region`;
    };
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, translateSubject: translate };
    const outcome = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: '帽子',
    }));
    // 桥收到英文译文；图层名=原 hint 提取（帽子）。
    expect(seenTexts[0]).toBe('the hat region');
    expect(outcome.children[0]!.objectName).toBe('帽子');
    // 二次（不同树 ref 同 hint）：直通面每次调翻译（缓存职责在 createSubjectTranslator
    // 实例——kernel 装配单例，segment-subject-translator.test 已覆盖；桥 text 恒定）。
    const tree2 = f.plantTree(baseTree());
    await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef: tree2, nodeId: 'n-person', hint: '帽子',
    }));
    expect(calls).toBe(2);
    expect(seenTexts[1]).toBe('the hat region');
  });

  it('英译失败→原 hint 直送+subject-translate-failed warning；英文 hint 不经翻译', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    const seenTexts: string[] = [];
    f.transport.respond((call) => {
      if (call.request.kind === 'segment' && call.request.prompt.kind === 'text') {
        seenTexts.push(call.request.prompt.text ?? '');
      }
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    f.transport.respond((call) => {
      if (call.request.kind === 'segment' && call.request.prompt.kind === 'text') {
        seenTexts.push(call.request.prompt.text ?? '');
      }
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    let invoked = 0;
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, translateSubject: async () => {
      invoked += 1;
      return null;
    } };
    const outcome = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: '帽子',
    }));
    expect(invoked).toBe(1);
    expect(seenTexts[0]).toBe('帽子'); // 降级原 hint
    expect(outcome.warnings.some((w) => w.reason === 'subject-translate-failed')).toBe(true);
    // 英文 hint：翻译面零调用。
    const tree2 = f.plantTree(baseTree());
    await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef: tree2, nodeId: 'n-person', hint: 'hat',
    }));
    expect(invoked).toBe(1);
    expect(seenTexts[1]).toBe('hat');
  });

  it('翻译面抛错被吞→降级原 hint（防御性收敛）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    const seenTexts: string[] = [];
    f.transport.respond((call) => {
      if (call.request.kind === 'segment' && call.request.prompt.kind === 'text') {
        seenTexts.push(call.request.prompt.text ?? '');
      }
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    const outcome = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, translateSubject: async () => {
        throw new Error('translator impl bug');
      } },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: '帽子' },
    ));
    expect(seenTexts[0]).toBe('帽子');
    expect(outcome.warnings.some((w) => w.reason === 'subject-translate-failed')).toBe(true);
  });
});

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

// ---------------------------------------------------------------- [T1] 掩膜分辨率语义（add-vision-pipeline-v2 D2）

it('低分辨率掩膜（服务端 maskMaxSide 缩掩码）：请求侧参数透传+图像原样送线；结果侧桥归一化回 imagePx→子层落树恒原分辨率帧', async () => {
  const f = setup();
  const treeBlobRef = f.plantTree(baseTree());
  let sentImageBytes = -1;
  f.transport.respond((call) => {
    sentImageBytes = call.imageBytes.byteLength;
    // 服务端语义（sam3_service do_segment）：maskMaxSide 把掩码 PIL NEAREST 缩到
    // cap 后返回——桥收到 48×48 低分辨率帧（原图 96×96 超 cap）
    return segmentResponse({ w: 48, h: 48, bits: ellipseBits(48, 48, 10) });
  });
  const outcome = await okOf(segmentOne(
    {
      db: f.s.db,
      blobs: f.s.blobs,
      jobs: f.s.jobs,
      bridge: f.bridge,
      samRequestTuner: () => ({ maskMaxSide: 48 }),
    },
    { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
  ));
  // 请求侧（D2：图像原样送线不降图）：精度参数透传+图像字节原样送线（降
  // 掩码发生在 macmini 服务端；桥 materialize 归一化落 blob）
  expect(f.transport.requests[0]).toMatchObject({ kind: 'segment', maskMaxSide: 48 });
  expect(sentImageBytes).toBe(f.s.blobs.read(f.imageBlobRef)!.byteLength);
  // 结果侧（D2「结果缩放成原图分辨率」）：子层落树=原分辨率帧（96×96 画布坐标）
  expect(outcome.children).toHaveLength(1);
  const child = outcome.children[0]!;
  const { w: mw, h: mh, bits } = resolveMaskBits(f.s.blobs, child.mask);
  expect(mw).toBe(child.bbox.w);
  expect(mh).toBe(child.bbox.h);
  // bbox ⊆ 父 bbox（10,8,70,66）且 ⊆ imagePx 帧（96×96）——子层掩膜不低于父层帧
  expect(child.bbox.x).toBeGreaterThanOrEqual(10);
  expect(child.bbox.y).toBeGreaterThanOrEqual(8);
  expect(child.bbox.x + child.bbox.w).toBeLessThanOrEqual(80);
  expect(child.bbox.y + child.bbox.h).toBeLessThanOrEqual(74);
  // 48 帧半径 10 椭圆 → 2× 上采样后 ≈ 半径 20（中心对齐最近邻）；非空且非全幅
  expect(bits.some((b) => b === 1)).toBe(true);
  expect(child.bbox.w).toBeLessThan(96);
  // 父∩子在原分辨率帧上运算（桥归一化先于消费——ensureCanvasMask 全图锚点通过）
  expect(child.parent).toBe('n-person');
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
  // 树结构不变（D3 前语义保持）；blobRef 变化仅因 persistTreeWithPreview 恒写树锚
  //（imageBlobRef 入树工件——新树恒带，见 add-flat-aux-segmentation T3.2）：重落
  // 产物 nodes 与原树逐节点等价+锚=入线图。
  expect(outcome.treeBlobRef).not.toBe(treeBlobRef);
  const rePersisted = loadObjectTreeArtifact(f.s.blobs, outcome.treeBlobRef);
  expect(rePersisted.nodes).toEqual(loadObjectTreeArtifact(f.s.blobs, treeBlobRef).nodes);
  expect(rePersisted.imageBlobRef).toBe(f.imageBlobRef);
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

// ---------------------------------------------------------------- T2 segmentPrompt+质量门+预览回流

describe('T2 segmentPrompt+掩膜质量门+预览回流（add-vision-pipeline-v2 D4/D5）', () => {
  it('segmentPrompt=hint 原文（翻译前——译文只进 SAM 请求侧）；桥收英文译文', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
    const deps = {
      db: f.s.db,
      blobs: f.s.blobs,
      jobs: f.s.jobs,
      bridge: f.bridge,
      translateSubject: async () => 'the hat region',
    };
    const outcome = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: '把帽子拆出来',
    }));
    // 桥收到英文（SAM 英文优先——segment-one.ts 头注契约）
    const req = f.transport.requests[0]!;
    expect(req.kind === 'segment' && req.prompt.kind === 'text' ? req.prompt.text : '').toBe('the hat region');
    // segmentPrompt=调用方 hint 原文（Agent provenance——译文不落树字段）
    expect(outcome.children[0]!.segmentPrompt).toBe('把帽子拆出来');
    // 基树旧节点不伪造补字段（D4：历史树补字段=重跑抠图，Out of Scope）
    const tree = JSON.parse(f.s.blobs.read(outcome.treeBlobRef)!.toString('utf8')) as ObjectTree;
    expect(tree.nodes.find((n) => n.id === 'n-person')!.segmentPrompt).toBeUndefined();
    expect(tree.nodes.find((n) => n.id === 'n-root')!.segmentPrompt).toBeUndefined();
    // 健康掩膜（椭圆 20px 半径⊂父）零质量门 warning
    expect(outcome.warnings.map((w) => w.reason)).not.toContain('mask-parent-iou');
  });

  it('整片父泄漏（右发型）：mask-parent-iou warning+子层保留+agentImagePreviews 携带可解码特写图', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    // SAM 对提示返回整幅画布（含父全部）——子=父∩全图=父 → IoU=1 泄漏极值
    const leakBits = new Uint8Array(96 * 96).fill(1);
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: leakBits }));
    const outcome = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
    ));
    // 门=typed warning：子层保留（不丢结果不阻断）
    expect(outcome.children).toHaveLength(1);
    expect(outcome.children[0]!.segmentPrompt).toBe('hat');
    const gateWarnings = outcome.warnings.filter((w) => w.reason === 'mask-parent-iou');
    expect(gateWarnings).toHaveLength(1);
    expect(gateWarnings[0]!.detail).toContain('IoU');
    // 预览回流（缺省开）：node-mask 特写在场，PNG 可解码且长边 ≤ maxSide，blobRef 可读
    expect(outcome.agentImagePreviews).toBeDefined();
    const preview = outcome.agentImagePreviews!.find((p) => p.kind === 'node-mask')!;
    expect(preview.reason).toBe('mask-parent-iou');
    expect(preview.nodeId).toBe(outcome.children[0]!.id);
    const decoded = decodePng(new Uint8Array(Buffer.from(preview.dataBase64, 'base64')));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(512);
    expect(f.s.blobs.read(preview.blobRef)).not.toBeNull();
  });

  it('成本开关两态：SEGMENT_AGENT_MASK_PREVIEW=0 → 病态 warning 仍在、agentImagePreviews 缺席（零多模态成本）', async () => {
    const prev = process.env.SEGMENT_AGENT_MASK_PREVIEW;
    process.env.SEGMENT_AGENT_MASK_PREVIEW = '0';
    try {
      const f = setup();
      const treeBlobRef = f.plantTree(baseTree());
      const leakBits = new Uint8Array(96 * 96).fill(1);
      f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: leakBits }));
      const outcome = await okOf(segmentOne(
        { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
        { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
      ));
      // 文本面 warning 不受开关影响（可观测不静默）
      expect(outcome.warnings.some((w) => w.reason === 'mask-parent-iou')).toBe(true);
      expect(outcome.agentImagePreviews).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SEGMENT_AGENT_MASK_PREVIEW;
      else process.env.SEGMENT_AGENT_MASK_PREVIEW = prev;
    }
  });
});

// ---------------------------------------------------------------- T5 试跑→确认（D6 Dialog 幂等底座）

describe('T5 dryRun 试跑→确认（add-vision-pipeline-v2 D6）', () => {
  /** 带账本（dataRoot）的 deps——试跑/确认共用同桶。 */
  function ledgerDeps(f: ReturnType<typeof setup>) {
    return { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, dataRoot: f.s.config.dataRoot };
  }

  it('试跑：真跑分段+账本照记+不落树（零 artifact 帧/树引用原样回传）+恒带试跑预览；确认=同参再调账本命中零桥调+自定义名落地', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    let bridgeCalls = 0;
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    const deps = ledgerDeps(f);

    // —— 试跑（dryRun=true，带 precision）——
    const trial = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef,
      nodeId: 'n-person', hint: 'hat', dryRun: true, precision: { maskMaxSide: 96, confThreshold: 0.4 },
    }));
    expect(bridgeCalls).toBe(1); // 真跑分段（SAM 请求照发）
    expect(trial.trial).toBeDefined();
    expect(trial.trial!.replayed).toBe(false); // 首跑=实跑
    // 试跑预览：目标层掩膜叠加缩略（恒带——不限病态），PNG 可解码+blob 可读
    expect(trial.trial!.preview.kind).toBe('trial-mask-overlay');
    expect(trial.trial!.preview.nodeId).toBe('n-person');
    const decoded = decodePng(new Uint8Array(Buffer.from(trial.trial!.preview.dataBase64, 'base64')));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(512);
    expect(f.s.blobs.read(trial.trial!.preview.blobRef)).not.toBeNull();
    // children=试跑构造的子层（未落树）；树引用=输入原样回传（树未变）
    expect(trial.children).toHaveLength(1);
    expect(trial.children[0]!.parent).toBe('n-person');
    expect(trial.treeBlobRef).toBe(treeBlobRef);
    expect(trial.previewBlobRef).toBe(trial.trial!.preview.blobRef);
    // 不落树：零 artifact 帧（jobs.emitFor 未被触达）+目标层 children 不变
    expect(f.frames().filter((fr) => fr.kind === 'artifact')).toEqual([]);
    const planted = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(treeBlobRef)!.toString('utf8')));
    expect(planted.nodes.find((n) => n.id === 'n-person')!.children).toEqual([]);

    // —— 确认落地（同参 + layerName——layerName 不入 reqHash）——
    const landed = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef,
      nodeId: 'n-person', hint: 'hat', precision: { maskMaxSide: 96, confThreshold: 0.4 },
      layerName: '右发',
    }));
    expect(bridgeCalls).toBe(1); // 账本命中掩膜直接回放——零二次桥调
    expect(landed.trial).toBeUndefined(); // 落地形态无试跑面
    expect(landed.children).toHaveLength(1);
    const child = landed.children[0]!;
    expect(child.objectName).toBe('右发'); // 自定义名优先（空=提示语命名链）
    expect(child.segmentPrompt).toBe('hat'); // D4 指令原文
    // 掩膜与试跑逐位同源（同账本条目回放）
    expect(child.bbox).toEqual(trial.children[0]!.bbox);
    // 树落地：新子挂 n-person 下+artifact 帧+新树引用
    expect(landed.treeBlobRef).not.toBe(treeBlobRef);
    const updated = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(landed.treeBlobRef)!.toString('utf8')));
    expect(updated.nodes.find((n) => n.id === 'n-person')!.children).toEqual([child.id]);
    const names = f.frames().filter((fr) => fr.kind === 'artifact').map((fr) => fr.payload.name);
    expect(names).toContain(OBJECT_TREE_ARTIFACT_NAME);
    f.s.dispose();
  });

  it('precision 入 reqHash：不同精度=不同请求（账本不串——确认换精度必重跑桥）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    let bridgeCalls = 0;
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    const deps = ledgerDeps(f);
    await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat', dryRun: true, precision: { maskMaxSide: 96 },
    }));
    const landed = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat', precision: { maskMaxSide: 512 },
    }));
    expect(bridgeCalls).toBe(2); // 换精度=换请求——miss 重跑（D3 不串账语义）
    expect(landed.children).toHaveLength(1);
    f.s.dispose();
  });

  it('dataRoot 缺席=账本停用：试跑→确认各实跑一次（行为兼容不改）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    let bridgeCalls = 0;
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge };
    const trial = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat', dryRun: true,
    }));
    expect(trial.trial!.replayed).toBe(false);
    await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat',
    }));
    expect(bridgeCalls).toBe(2); // 无账本=确认重跑（旧部署形态）
    f.s.dispose();
  });

  it('账本条目按图+提示+框分账：换提示词的试跑不串用前条目（重跑桥）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    let bridgeCalls = 0;
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) });
    });
    const deps = ledgerDeps(f);
    await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat', dryRun: true,
    }));
    const trial2 = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-root', hint: 'hat', dryRun: true,
    }));
    expect(bridgeCalls).toBe(2); // 不同目标（box 漂移）=不同 reqHash
    expect(trial2.trial!.replayed).toBe(false);
    expect(trial2.trial!.preview.nodeId).toBe('n-root'); // 预览锚=目标层
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- P2-1 试跑预览=互斥后最终形态（Codex R1）

describe('P2-1 试跑预览/质量判定=兄弟互斥后的最终子层（Codex R1）', () => {
  /** 目标层非钻+左半 worthy 兄弟：新子（椭圆∩父）左半被削——部分重叠况。 */
  function halfSiblingTree(): ObjectTree {
    const tree = baseTree();
    const person = tree.nodes[1]!;
    person.drillWorthy = false; // 新子继承非钻 → 兄弟（worthy）胜出
    const sibling: ObjectNode = {
      id: 'n-left',
      objectName: '左半兄弟',
      category: 'person',
      mask: solidMask(38, 66),
      bbox: { x: 10, y: 8, w: 38, h: 66 }, // 覆盖椭圆左半（x∈[10,48)）
      parent: person.id,
      children: [],
      effectiveMm: 48,
      labVariance: 20,
      drillWorthy: true,
      origin: 'vlm+sam3',
    };
    person.children = [sibling.id];
    tree.nodes.push(sibling);
    return tree;
  }

  /** 互斥后期望的新子 bits：椭圆 ∩ 父掩码 ∩ x≥48（左半被 worthy 兄弟削去）。 */
  function expectedTrimmedBits(): Uint8Array {
    const expected = new Uint8Array(96 * 96);
    const ellipse = ellipseBits(96, 96, 20);
    for (let i = 0; i < expected.length; i++) {
      expected[i] = ellipse[i]! === 1 && i % 96 >= 48 ? 1 : 0;
    }
    return expected;
  }

  /** 全幅帧 bits 按 bbox 裁剪（子层掩膜存储形态——bbox 相对局部帧；P3 逐字节比较源）。 */
  function cropBitsOf(
    bits: Uint8Array,
    frameW: number,
    bbox: { x: number; y: number; w: number; h: number },
  ): Uint8Array {
    const out = new Uint8Array(bbox.w * bbox.h);
    for (let y = 0; y < bbox.h; y++) {
      for (let x = 0; x < bbox.w; x++) {
        out[y * bbox.w + x] = bits[(bbox.y + y) * frameW + (bbox.x + x)]!;
      }
    }
    return out;
  }

  it('部分重叠：试跑 children/预览掩膜=互斥裁剪后形态（预览字节与最终 bits 渲染同源）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(halfSiblingTree());
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
    const trial = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat', dryRun: true },
    ));
    // children=互斥后形态：bbox=裁剪后紧外接、掩膜置位=期望裁剪 bits
    expect(trial.children).toHaveLength(1);
    const child = trial.children[0]!;
    const expected = expectedTrimmedBits();
    expect(child.bbox).toEqual(tightBBox(expected, 96, 96));
    if (child.mask.kind !== 'inline') throw new Error('期望 inline 态子层掩膜');
    const decodedChild = decodeInlineMask(child.mask);
    expect(popcount(decodedChild.bits)).toBe(popcount(expected));
    // P3（Codex R2）：解码子层掩膜与预期裁剪掩膜逐字节同源（子层按 bbox 裁剪存储——
    // 取期望全幅帧同区域比对；对齐试跑预览 PNG 的字节级比较深度）
    const expectedCrop = cropBitsOf(expected, 96, child.bbox);
    expect(decodedChild.w).toBe(child.bbox.w);
    expect(decodedChild.h).toBe(child.bbox.h);
    expect(decodedChild.bits).toEqual(expectedCrop);
    // 预览掩膜=最终形态（字节级：同一渲染函数对最终 bits 的输出与试跑预览逐字节同源）
    const image = decodePng(f.s.blobs.read(f.imageBlobRef)!);
    const expectedPng = renderNodeMaskPreview({
      image: { width: image.width, height: image.height, rgba: image.rgba },
      bits: expected,
      bbox: { x: 10, y: 8, w: 70, h: 66 },
      maxSide: segmentAgentPreviewMaxSide(),
    });
    expect(new Uint8Array(Buffer.from(trial.trial!.preview.dataBase64, 'base64'))).toEqual(new Uint8Array(expectedPng));
    // 落地同源：确认（同参）子层与试跑逐位一致（确定性消解+同响应几何——试跑未带
    // dataRoot 无账本条目，落地补一次编程响应实跑）
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
    const landed = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' },
    ));
    const landedChild = landed.children[0]!;
    expect(landedChild.bbox).toEqual(child.bbox);
    // P3（Codex R2）：落地子层掩膜同样与预期裁剪掩膜逐字节同源（试跑=落地单源；
    // resolveMaskBits 兼容 persist 后 inline/blob 两态）
    const landedBits = resolveMaskBits(f.s.blobs, landedChild.mask);
    expect(landedBits.w).toBe(child.bbox.w);
    expect(landedBits.h).toBe(child.bbox.h);
    expect(landedBits.bits).toEqual(expectedCrop);
    f.s.dispose();
  });

  it('完全吞没：试跑 children []+无预览掩膜（零叠加渲染）+child-consumed 文案点名胜者兄弟', async () => {
    const f = setup();
    // 父=非钻（新子继承）；既有兄弟=全幅 worthy → 新子被完全吞没
    const tree = baseTree();
    const person = tree.nodes[1]!;
    person.drillWorthy = false;
    const sibling: ObjectNode = {
      id: 'n-full',
      objectName: '全幅兄弟',
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
    const trial = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat', dryRun: true },
    ));
    expect(trial.children).toEqual([]); // 无落地结果
    const consumed = trial.warnings.find((w) => w.reason === 'child-consumed');
    expect(consumed).toBeDefined();
    expect(consumed!.detail).toContain('全幅兄弟'); // 点名胜者兄弟
    expect(consumed!.detail).toContain('无落地结果');
    // 预览恒带但掩膜为零（无叠加——字节级=零 bits 渲染同源）
    const image = decodePng(f.s.blobs.read(f.imageBlobRef)!);
    const expectedPng = renderNodeMaskPreview({
      image: { width: image.width, height: image.height, rgba: image.rgba },
      bits: new Uint8Array(96 * 96),
      bbox: { x: 10, y: 8, w: 70, h: 66 },
      maxSide: segmentAgentPreviewMaxSide(),
    });
    expect(new Uint8Array(Buffer.from(trial.trial!.preview.dataBase64, 'base64'))).toEqual(new Uint8Array(expectedPng));
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- add-sam-playbook D1 实例枚举扇出（玩法①）

describe("instances='all' 实例枚举扇出（add-sam-playbook D1 玩法①）", () => {
  /** 全图 bits：box 内全 1（width 缺省 96——本 describe 主画幅；护栏用例 256）。 */
  function rectBits(box: { x: number; y: number; w: number; h: number }, width = 96): Uint8Array {
    const bits = new Uint8Array(width * width);
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) bits[y * width + x] = 1;
    }
    return bits;
  }

  /** 多实例响应（count+detections 逐实例 inline 掩码——线上 topK>1 形状）。 */
  function multiInstanceResponse(
    boxes: Array<{ x: number; y: number; w: number; h: number }>,
    options: { count?: number; scores?: number[] } = {},
  ): SamBridgeResponse {
    return {
      kind: 'segment',
      mask: encodeInlineMask(96, 96, rectBits(boxes[0]!)),
      score: options.scores?.[0] ?? 0.9,
      count: options.count ?? boxes.length,
      detections: boxes.map((b, i) => ({
        mask: encodeInlineMask(96, 96, rectBits(b)),
        score: options.scores?.[i] ?? 0.85 + i * 0.01,
      })),
      meta: { model: 'mock', durationMs: 1, iteration: 0 },
    };
  }

  /** 三实例 disjoint（实例 2=细长条带 12×62——高贯父层触发 mask-suspicious-aspect）。 */
  const THREE = [
    { x: 14, y: 12, w: 20, h: 20 },
    { x: 52, y: 10, w: 12, h: 62 },
    { x: 14, y: 40, w: 20, h: 20 },
  ];

  it('3 实例→3 子层：topK 请求+独立掩膜+命名序号+segmentPrompt 后缀+独立质量门', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    f.transport.respond(() => multiInstanceResponse(THREE));
    const outcome = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      {
        taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
        hint: 'star', instances: 'all',
      },
    ));
    // 请求面：topK=护栏上限（instances 入 reqHash 的请求侧锚点）
    const req = f.transport.requests[0]!;
    expect(req.kind === 'segment' ? req.topK : undefined).toBe(SAM_SEGMENT_INSTANCES_MAX);
    // 3 子层：命名=提示语名+空格序号；segmentPrompt=原文+[instance-N]；掩膜独立（bbox=各实例矩形）
    expect(outcome.children).toHaveLength(3);
    const byName = new Map(outcome.children.map((c) => [c.objectName, c] as const));
    expect([...byName.keys()]).toEqual(['star 1', 'star 2', 'star 3']);
    for (let i = 0; i < 3; i++) {
      const child = outcome.children[i]!;
      expect(child.segmentPrompt).toBe(`star[instance-${i + 1}]`);
      expect(child.bbox).toEqual(THREE[i]);
      expect(child.parent).toBe('n-person');
    }
    // 独立质量门：实例 2 细长条带命中 aspect 先验——warning 带实例定位（名字含序号）
    const aspect = outcome.warnings.filter((w) => w.reason === 'mask-suspicious-aspect');
    expect(aspect).toHaveLength(1);
    expect(aspect[0]!.detail).toContain('star 2');
    // 健康实例零质量门命中（fill/aspect 干净）
    expect(outcome.warnings.filter((w) => w.reason === 'mask-suspicious-fill')).toHaveLength(0);
    expect(outcome.warnings.filter((w) => w.reason === 'mask-parent-iou')).toHaveLength(0);
    // 树落地：三子全挂 n-person
    const updated = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(outcome.treeBlobRef)!.toString('utf8')));
    const person = updated.nodes.find((n) => n.id === 'n-person')!;
    expect(person.children).toHaveLength(3);
    f.s.dispose();
  });

  it('实例间兄弟互斥：重叠实例败者削交集（掩膜互斥消解照常）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    const a = { x: 14, y: 12, w: 30, h: 30 };
    const b = { x: 24, y: 22, w: 30, h: 30 };
    f.transport.respond(() => multiInstanceResponse([a, b]));
    const outcome = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      {
        taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
        hint: 'star', instances: 'all',
      },
    ));
    expect(outcome.children).toHaveLength(2);
    expect(outcome.warnings.some((w) => w.reason === 'child-consumed')).toBe(false);
    // 互斥不变式：两子层画布级掩膜零交叠（同 popcount 平手=创建序早者胜）
    const canvasOf = (bbox: { x: number; y: number; w: number; h: number }, bits: Uint8Array): Uint8Array => {
      const out = new Uint8Array(96 * 96);
      for (let y = 0; y < bbox.h; y++) {
        for (let x = 0; x < bbox.w; x++) {
          if (bits[y * bbox.w + x] === 1) out[(bbox.y + y) * 96 + bbox.x + x] = 1;
        }
      }
      return out;
    };
    const canvases = outcome.children.map((c) => {
      const bits = c.mask.kind === 'inline' ? decodeInlineMask(c.mask).bits : resolveMaskBits(f.s.blobs, c.mask).bits;
      return canvasOf(c.bbox, bits);
    });
    let overlap = 0;
    for (let i = 0; i < canvases[0]!.length; i++) {
      if (canvases[0]![i] === 1 && canvases[1]![i] === 1) overlap++;
    }
    expect(overlap).toBe(0);
    f.s.dispose();
  });

  it('试跑逐实例缩略：trial.instancePreviews 逐实例+blob 可读；best 试跑无 instancePreviews', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    f.transport.respond(() => multiInstanceResponse(THREE));
    const trial = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      {
        taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
        hint: 'star', instances: 'all', dryRun: true,
      },
    ));
    expect(trial.trial!.instancePreviews).toHaveLength(3);
    const childIds = new Set(trial.children.map((c) => c.id));
    for (const preview of trial.trial!.instancePreviews!) {
      expect(preview.kind).toBe('trial-mask-overlay');
      expect(childIds.has(preview.nodeId!)).toBe(true);
      const decoded = decodePng(new Uint8Array(Buffer.from(preview.dataBase64, 'base64')));
      expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(512);
      expect(f.s.blobs.read(preview.blobRef)).not.toBeNull();
    }
    expect(trial.trial!.instancePreviews!.map((p) => p.objectName)).toEqual(['star 1', 'star 2', 'star 3']);
    // best 试跑：单实例形态——instancePreviews 缺席（契约可选字段零污染）
    const tree2 = f.plantTree(baseTree());
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: ellipseBits(96, 96, 20) }));
    const bestTrial = await okOf(segmentOne(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge },
      { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef: tree2, nodeId: 'n-person', hint: 'star', dryRun: true },
    ));
    expect(bestTrial.trial!.instancePreviews).toBeUndefined();
    f.s.dispose();
  });

  it('试跑→确认同参幂等：账本逐实例回放零二次桥调；best=不同 reqHash 必重跑（instances 入 reqHash）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    let bridgeCalls = 0;
    f.transport.respond(() => {
      bridgeCalls += 1;
      return multiInstanceResponse(THREE);
    });
    f.transport.respond(() => {
      bridgeCalls += 1;
      return multiInstanceResponse(THREE);
    });
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, dataRoot: f.s.config.dataRoot };
    const base = {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'star',
    };
    // 试跑（all）：1 次实跑；账本行携带逐实例明细
    const trial = await okOf(segmentOne(deps, { ...base, instances: 'all', dryRun: true }));
    expect(bridgeCalls).toBe(1);
    expect(trial.trial!.replayed).toBe(false);
    const fp = segmentOneLedgerFingerprint({
      imageBlobRef: f.imageBlobRef, imagePx: IMAGE_PX, canvasCm: CANVAS_CM,
    });
    const ledgerText = readFileSync(
      join(f.s.config.dataRoot, 'segment-ledgers', `${fp}.jsonl`), 'utf8',
    );
    expect(ledgerText).toContain('"instances"');
    expect(ledgerText.match(/"instances"/g)).toHaveLength(1); // 恰一行 all 明细
    // 确认（同参 all）：账本命中逐实例回放——零二次桥调+子层与试跑逐位同源
    const landed = await okOf(segmentOne(deps, { ...base, instances: 'all' }));
    expect(bridgeCalls).toBe(1);
    expect(landed.children).toHaveLength(3);
    expect(landed.children.map((c) => c.bbox)).toEqual(trial.children.map((c) => c.bbox));
    expect(landed.children.map((c) => c.objectName)).toEqual(['star 1', 'star 2', 'star 3']);
    // best（同提示）：reqHash 不含 topK=不同条目——必重跑桥（不串账）
    const best = await okOf(segmentOne(deps, base));
    expect(bridgeCalls).toBe(2);
    expect(best.children).toHaveLength(1);
    expect(best.children[0]!.objectName).toBe('star'); // 单实例=基名（不加噪）
    f.s.dispose();
  });

  it('>24 实例护栏：截断保留前 24+instances-truncated warning 明示（不 fail）', async () => {
    // 256×256 画幅（碎片阈值 200px——16×16=256px 实例存活）；目标=画布根全幅
    const SIZE = 256;
    const rgba = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const p = (y * SIZE + x) * 4;
        const [r, g, b] = (x / 32 + y / 32) % 2 === 0 ? [200, 40, 40] : [40, 60, 200];
        rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255;
      }
    }
    const image = new Uint8Array(encodePng(SIZE, SIZE, rgba));
    const s = createServices(undefined, { imgDryRun: true });
    const imageBlobRef = s.blobs.put(image).hash;
    const { sessionId } = s.sessions.create(s.anonymous, { title: 'fanout-cap' });
    const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
    const transport = new MockSamTransport();
    const bridge = new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport });
    const tree: ObjectTree = ObjectTreeSchema.parse({
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: { w: 20, h: 20 },
      imagePx: { width: SIZE, height: SIZE },
      nodes: [{
        id: 'n-root', objectName: '画布', category: 'canvas',
        mask: solidMask(SIZE, SIZE), bbox: { x: 0, y: 0, w: SIZE, h: SIZE },
        parent: null, children: [], effectiveMm: 256, labVariance: 30,
        drillWorthy: true, origin: 'vlm+sam3',
      }],
      createdAt: '2026-10-04T00:00:00.000Z',
    });
    const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
    /** 5×5 网格 25 个 16×16 实例（互不重叠——纯护栏面）。 */
    const gridBoxes = (): Array<{ x: number; y: number; w: number; h: number }> => {
      const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) boxes.push({ x: 20 + col * 36, y: 20 + row * 36, w: 16, h: 16 });
      }
      return boxes;
    };
    const responseOf = (boxes: Array<{ x: number; y: number; w: number; h: number }>, count: number): SamBridgeResponse => ({
      kind: 'segment',
      mask: encodeInlineMask(SIZE, SIZE, rectBits(boxes[0]!, SIZE)),
      score: 0.9,
      count,
      detections: boxes.map((b) => ({ mask: encodeInlineMask(SIZE, SIZE, rectBits(b, SIZE)), score: 0.8 })),
      meta: { model: 'mock', durationMs: 1, iteration: 0 },
    });
    // 检出 25（detections 超限）：截断保留前 24
    transport.respond(() => responseOf(gridBoxes(), 25));
    const over = await okOf(segmentOne(
      { db: s.db, blobs: s.blobs, jobs: s.jobs, bridge },
      { taskId: task.id, imageBlobRef, treeBlobRef, nodeId: 'n-root', hint: 'dot', instances: 'all' },
    ));
    expect(over.children).toHaveLength(SAM_SEGMENT_INSTANCES_MAX);
    const truncation = over.warnings.find((w) => w.reason === 'instances-truncated')!;
    expect(truncation.detail).toContain('25');
    expect(truncation.detail).toContain(String(SAM_SEGMENT_INSTANCES_MAX));
    expect(over.children.map((c) => c.objectName)).toContain(`dot ${SAM_SEGMENT_INSTANCES_MAX}`);
    // 线上 count=30>detections 24：count 分支明示「共检出 30」
    const tree2 = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
    transport.respond(() => responseOf(gridBoxes().slice(0, SAM_SEGMENT_INSTANCES_MAX), 30));
    const countBranch = await okOf(segmentOne(
      { db: s.db, blobs: s.blobs, jobs: s.jobs, bridge },
      { taskId: task.id, imageBlobRef, treeBlobRef: tree2, nodeId: 'n-root', hint: 'dot', instances: 'all' },
    ));
    expect(countBranch.children).toHaveLength(SAM_SEGMENT_INSTANCES_MAX);
    expect(countBranch.warnings.find((w) => w.reason === 'instances-truncated')!.detail).toContain('30');
    s.dispose();
  });
});

// ---------------------------------------------------------------- add-sam-playbook D2 excludeBox（纠偏后语义）

describe('add-sam-playbook D2 excludeBox 排除区（daemon 像素减法——纠偏后语义）', () => {
  it('落树掩膜：excludeBox 区域内为零+区域外逐位不变+边缘裁剪紧外接收缩；excludeBox 不上线/入 reqHash', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    let bridgeCalls = 0;
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: rectIn(20, 20, 40, 40) });
    });
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: rectIn(20, 20, 40, 40) });
    });
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, dataRoot: f.s.config.dataRoot };
    const base = { taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: 'hat' };
    // 泄漏修漏形态：SAM 回 20..60 实心块（模拟「抠出区域含泄漏」），排除区叠加其上
    const landed = await okOf(segmentOne(deps, { ...base, excludeBox: { x: 30, y: 30, w: 10, h: 10 } }));
    expect(landed.children).toHaveLength(1);
    const child = landed.children[0]!;
    // 排除区在掩膜内部：bbox 不收缩（20..60 块的紧外接不变）
    expect(child.bbox).toEqual({ x: 20, y: 20, w: 40, h: 40 });
    const { bits } = resolveMaskBits(f.s.blobs, child.mask);
    let zeroInside = 0;
    let oneOutside = 0;
    for (let y = child.bbox.y; y < child.bbox.y + child.bbox.h; y++) {
      for (let x = child.bbox.x; x < child.bbox.x + child.bbox.w; x++) {
        const inExclude = x >= 30 && x < 40 && y >= 30 && y < 40;
        const v = bits[(y - child.bbox.y) * child.bbox.w + (x - child.bbox.x)]!;
        if (inExclude) {
          if (v === 0) zeroInside++;
        } else if (v === 1) oneOutside++;
      }
    }
    expect(zeroInside).toBe(100); // 10×10 排除区全零
    expect(oneOutside).toBe(40 * 40 - 100); // 区域外逐位保留（父∩子=块全在父内）
    // excludeBox 不上线：桥请求（daemon 侧）携带 excludeBox 合法字段，wire 映射剥除面
    // 已由 ssh-sam-transport wire-echo 断言；此处断言 excludeBox 入 reqHash——同提示不同
    // 排除区=不同账本条目（miss 重跑桥）
    await okOf(segmentOne(deps, { ...base, excludeBox: { x: 50, y: 20, w: 30, h: 40 } }));
    expect(bridgeCalls).toBe(2); // 不同排除区=不同 reqHash——不回放
    // 边缘裁剪：排除区覆盖掩膜右缘 → 紧外接右边界收缩到 50
    const trimmed = await okOf(segmentOne(deps, { ...base, dryRun: true, excludeBox: { x: 50, y: 20, w: 30, h: 40 } }));
    expect(trimmed.children[0]!.bbox).toEqual({ x: 20, y: 20, w: 30, h: 40 });
    f.s.dispose();
  });

  /** 全图 bits：矩形内全 1（本 describe 专用——rectBits 在扇出 describe 内）。 */
  function rectIn(x0: number, y0: number, w: number, h: number): Uint8Array {
    const bits = new Uint8Array(96 * 96);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) bits[y * 96 + x] = 1;
    }
    return bits;
  }
});

// ---------------------------------------------------------------- add-sam-playbook T2 纯 box（D3 暴露面）

describe('add-sam-playbook T2 纯 box/正框覆写（D3——hint 可选+box 透传）', () => {
  /** 全图 bits：矩形内全 1（本 describe 专用——rectIn 同形）。 */
  function rectBitsIn(x0: number, y0: number, w: number, h: number): Uint8Array {
    const bits = new Uint8Array(96 * 96);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) bits[y * 96 + x] = 1;
    }
    return bits;
  }

  it('纯 box（无 hint）：桥 prompt 只发 box（text 缺席）+box=入参正框；命名「框选区域」+segmentPrompt=box[x,y,w,h] 语义串', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    const seenPrompts: Array<Record<string, unknown>> = [];
    f.transport.respond((call) => {
      if (call.request.kind === 'segment') {
        seenPrompts.push(call.request.prompt as unknown as Record<string, unknown>);
      }
      return segmentResponse({ w: 96, h: 96, bits: rectBitsIn(30, 30, 20, 20) });
    });
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, dataRoot: f.s.config.dataRoot };
    const landed = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
      box: { x: 24, y: 20, w: 40, h: 30 },
    }));
    expect(landed.children).toHaveLength(1);
    expect(landed.children[0]!.objectName).toBe('框选区域');
    expect(landed.children[0]!.segmentPrompt).toBe('box[24,20,40,30]');
    // 桥收到纯 box 提示：text 缺席+box=入参正框（非父外接框覆写）
    expect(seenPrompts[0]!.kind).toBe('text');
    expect(seenPrompts[0]!.text).toBeUndefined();
    expect(seenPrompts[0]!.box).toEqual({ x: 24, y: 20, w: 40, h: 30 });
    f.s.dispose();
  });

  it('text+box 组合：box 覆写父外接框锚定（桥收 text+入参 box）；纯 box 零检出 warning 用框选标签', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    const seenPrompts: Array<Record<string, unknown>> = [];
    f.transport.respond((call) => {
      if (call.request.kind === 'segment') {
        seenPrompts.push(call.request.prompt as unknown as Record<string, unknown>);
      }
      return segmentResponse({ w: 96, h: 96, bits: rectBitsIn(30, 30, 20, 20) });
    });
    f.transport.respond(() => segmentResponse({ w: 96, h: 96, bits: new Uint8Array(96 * 96) })); // 空掩码
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, dataRoot: f.s.config.dataRoot };
    const landed = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
      hint: 'hat', box: { x: 26, y: 22, w: 30, h: 30 },
    }));
    expect(landed.children[0]!.objectName).toBe('hat');
    expect(seenPrompts[0]!.text).toBe('hat');
    expect(seenPrompts[0]!.box).toEqual({ x: 26, y: 22, w: 30, h: 30 }); // 覆写（缺省=父框 10,8,70,66）
    // 纯 box 零检出：warning detail 走「框选 box[...]」标签（无空「提示」占位）
    const empty = await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
      box: { x: 24, y: 20, w: 40, h: 30 }, dryRun: true,
    }));
    expect(empty.children).toHaveLength(0);
    const noInstance = empty.warnings.find((w) => w.reason === 'no-instance')!;
    expect(noInstance.detail).toContain('框选 box[24,20,40,30]');
    f.s.dispose();
  });

  it('hint 与 box 全空=invalid-input（schema superRefine+原子防御双面）；box 入 reqHash（不同正框不串账）', async () => {
    const f = setup();
    const treeBlobRef = f.plantTree(baseTree());
    let bridgeCalls = 0;
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: rectBitsIn(30, 30, 20, 20) });
    });
    f.transport.respond(() => {
      bridgeCalls += 1;
      return segmentResponse({ w: 96, h: 96, bits: rectBitsIn(30, 30, 20, 20) });
    });
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge: f.bridge, dataRoot: f.s.config.dataRoot };
    await expect(okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
    }))).rejects.toMatchObject({ name: 'SegmentOneError', kind: 'invalid-input' });
    await expect(okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: '   ',
    }))).rejects.toMatchObject({ name: 'SegmentOneError', kind: 'invalid-input' });
    // box 入 reqHash：同 hint 不同正框=不同账本条目（第二次必重跑桥）
    await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
      hint: 'hat', box: { x: 24, y: 20, w: 40, h: 30 },
    }));
    await okOf(segmentOne(deps, {
      taskId: f.taskId, imageBlobRef: f.imageBlobRef, treeBlobRef, nodeId: 'n-person',
      hint: 'hat', box: { x: 30, y: 20, w: 40, h: 30 },
    }));
    expect(bridgeCalls).toBe(2);
    f.s.dispose();
  });
});
