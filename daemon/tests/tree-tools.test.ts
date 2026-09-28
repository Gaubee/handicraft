/**
 * Agent 树组装工具面契约测试（realize-scene-understanding T2 / design §2——
 * Owner 2026-09-28 Agent 循环架构：MCP 提供 treeView，Agent 灵活组装/迭代）。
 * 覆盖五工具（studio.tree.inspect/merge/refine/reparent/rename——capability/tree.ts）：
 *   [1] inspect：树结构+mask 引用+判据数据（effectiveMm/labVariance）+origin+relation
 *       +停止判据提示；显式 treeBlobRef/帧流电流树缺省两形态。
 *   [2] merge：子→父吸收（mask 并集+bbox 并集+children 移交+判据重算）+版本入史
 *       （cause='tree-merge'）+帧推进+指派收敛（v5 组不产钻 demote）。
 *   [3] refine：限定节点掩码内 SAM 多提示→子节点（origin/relation=refinement——B2）
 *       +链式版本入史（cause='tree-refine'）。
 *   [4] reparent：子树移动（layer.reorder 内核复用——cause='reorder'）。
 *   [5] rename：名+drillWorthy 标注（B2 重分类收口）。
 *   [6] CAS 拒：expectedTreeBlobRef 漂移必拒（cas-mismatch 携幂等判别语义）。
 *   [7] 结构守卫：根保护/吸收方向倒置成环/目标缺席 typed 拒。
 *   [8] MCP 注册面：五工具在册+投影名+deny 名单存活。
 * 桥=MockSamTransport 脚本（零外呼）；引擎=strategyEngineDelegate 真身。零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  SceneAnalysisSchema,
  encodeInlineMask,
  StrategyPlanSchema,
  type ObjectNode,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { strategyEngineDelegate } from '../src/kernel/index.js';
import { FrameStore } from '../src/jobs/frame-store.js';
import { MockSamTransport, SamBridge } from '../src/kernel/vision/sam-bridge.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import {
  STRATEGY_PLAN_ARTIFACT_NAME,
} from '../src/kernel/strategies/design.js';
import { TaskWorkbench } from '../src/kernel/workbench.js';
import {
  TREE_INSPECT_TOOL_NAME,
  TREE_MERGE_TOOL_NAME,
  TREE_REFINE_TOOL_NAME,
  TREE_REPARENT_TOOL_NAME,
  TREE_RENAME_TOOL_NAME,
  createTreeCapabilities,
} from '../src/capability/tree.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { productToolDenyList } from '../src/kernel/tool-surface.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const CANVAS_CM = { w: 10, h: 10 };
const IMAGE_PX = { width: 96, height: 96 };

function testImage(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = 120;
      rgba[p + 1] = 120;
      rgba[p + 2] = 140;
      rgba[p + 3] = 255;
    }
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

/**
 * 层级树：画布 → 小丑（semantic）→ 左手/脸部（semantic）+小丑·部分1（refinement）
 * → 红鼻子（semantic）。bbox 互不重叠（兄弟互斥不干扰 merge 断言）。
 * n-part1=B2 三态归宿演示 fixture（v6 复核裁定）：refinement 临时节点——VLM 重入
 * 确认是语义部位时经 rename(relation=semantic) 显式升类（「小丑·部分1」→「左手」）；
 * 无独立语义则保持 refinement 叶子直接贴钻（父组不产钻、兄弟不重叠）。
 */
function clownTree(): ObjectTree {
  const nose: ObjectNode = {
    id: 'n-nose',
    objectName: '红鼻子',
    category: 'face',
    mask: solidMask(10, 10),
    bbox: { x: 42, y: 26, w: 10, h: 10 },
    parent: 'n-face',
    children: [],
    effectiveMm: 10,
    labVariance: 4,
    drillWorthy: true,
    origin: 'vlm+sam3',
    relation: 'semantic',
  };
  const hand: ObjectNode = {
    id: 'n-hand',
    objectName: '左手',
    category: 'body',
    mask: solidMask(14, 22),
    bbox: { x: 14, y: 40, w: 14, h: 22 },
    parent: 'n-clown',
    children: [],
    effectiveMm: 17.5,
    labVariance: 9,
    drillWorthy: true,
    origin: 'vlm+sam3',
    relation: 'semantic',
  };
  const part1: ObjectNode = {
    id: 'n-part1',
    objectName: '小丑·部分1',
    category: 'part',
    mask: solidMask(8, 8),
    bbox: { x: 20, y: 14, w: 8, h: 8 },
    parent: 'n-clown',
    children: [],
    effectiveMm: 8,
    labVariance: 3,
    drillWorthy: true,
    origin: 'refinement',
    relation: 'refinement',
  };
  const face: ObjectNode = {
    id: 'n-face',
    objectName: '脸部',
    category: 'face',
    mask: solidMask(24, 20),
    bbox: { x: 34, y: 20, w: 24, h: 20 },
    parent: 'n-clown',
    children: [nose.id],
    effectiveMm: 21.9,
    labVariance: 12,
    drillWorthy: true,
    origin: 'vlm+sam3',
    relation: 'semantic',
  };
  const clown: ObjectNode = {
    id: 'n-clown',
    objectName: '小丑',
    category: 'character',
    mask: solidMask(60, 60),
    bbox: { x: 10, y: 12, w: 60, h: 60 },
    parent: 'n-canvas',
    children: [hand.id, face.id, part1.id],
    effectiveMm: 60,
    labVariance: 26,
    drillWorthy: true,
    origin: 'vlm+sam3',
    relation: 'semantic',
  };
  const canvas: ObjectNode = {
    id: 'n-canvas',
    objectName: '画布',
    category: 'canvas',
    mask: solidMask(96, 96),
    bbox: { x: 0, y: 0, w: 96, h: 96 },
    parent: null,
    children: [clown.id],
    effectiveMm: 96,
    labVariance: 40,
    drillWorthy: false,
    origin: 'vlm+sam3',
  };
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    nodes: [canvas, clown, hand, face, nose, part1],
    createdAt: '2026-09-28T00:00:00.000Z',
  };
}

interface Fixture {
  s: TestServices;
  workbench: TaskWorkbench;
  registry: ReturnType<typeof createTreeCapabilities>;
  transport: MockSamTransport;
  taskId: string;
  imageBlobRef: string;
  treeBlobRef: string;
  dispose(): void;
}

function setup(options: { plan?: StrategyPlan } = {}): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'tree-tools 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  // S2 锚点工件（capability 原图解析真源——帧流最新 scene-analysis.json）
  const analysis = SceneAnalysisSchema.parse({
    kind: 'scene-analysis',
    formatVersion: 2,
    imageBlobRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    elements: [
      { elementId: 'el-clown', parentElementId: null, name: '小丑', boxPx: { x: 10, y: 12, w: 60, h: 60 }, hint: 'clown', suggestDrillWorthy: true },
      { elementId: 'el-hand', parentElementId: 'el-clown', relation: 'semantic', name: '左手', boxPx: { x: 14, y: 40, w: 14, h: 22 }, hint: 'hand', suggestDrillWorthy: true },
    ],
    createdAt: '2026-09-28T00:00:00.000Z',
  });
  const analysisRef = s.blobs.put(new Uint8Array(Buffer.from(JSON.stringify(analysis), 'utf8'))).hash;
  s.jobs.emitFor(task.id, 'artifact', { blobRef: analysisRef, name: 'scene-analysis.json' });
  const tree = clownTree();
  const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
  s.jobs.emitFor(task.id, 'artifact', { blobRef: treeBlobRef, name: 'object-tree.json' });
  if (options.plan !== undefined) {
    const planRef = s.blobs.put(new Uint8Array(Buffer.from(JSON.stringify(options.plan), 'utf8'))).hash;
    s.jobs.emitFor(task.id, 'artifact', { blobRef: planRef, name: STRATEGY_PLAN_ARTIFACT_NAME });
  }
  const transport = new MockSamTransport();
  const workbench = new TaskWorkbench({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    bridge: new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport }),
    engineLayout: strategyEngineDelegate,
  });
  const registry = createTreeCapabilities({ db: s.db, blobs: s.blobs, jobs: s.jobs, workbench });
  return {
    s,
    workbench,
    registry,
    transport,
    taskId: task.id,
    imageBlobRef,
    treeBlobRef,
    dispose: () => s.dispose(),
  };
}

async function okOf(result: unknown): Promise<Record<string, unknown>> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: Record<string, unknown> }).value;
}

function readTree(f: Fixture, ref: string): ObjectTree {
  return ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(ref)!.toString('utf8')));
}

function versionsOf(f: Fixture): Array<{ cause: string; detail: string | null }> {
  return (
    f.s.db.prepare('SELECT cause, detail FROM tree_versions WHERE task_id = ? ORDER BY version ASC').all(f.taskId) as Array<
      { cause: string; detail: string | null }
    >
  );
}

function currentTreeRefOf(f: Fixture): string {
  // 帧流 jsonl 读回（capability latestArtifactRefs 同源——rpc.ts latest-by-name 语义）
  const frames = new FrameStore(f.s.jobs.framesFileOf(f.taskId)).readAfter(0);
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'artifact') continue;
    const payload = frame.payload as { name?: unknown; blobRef?: unknown };
    if (payload.name === 'object-tree.json' && typeof payload.blobRef === 'string') return payload.blobRef;
  }
  throw new Error('帧流无 object-tree.json（测试辅助）');
}

// ---------------------------------------------------------------- [1] inspect

describe('studio.tree.inspect（树读面——判据数据+停止判据提示）', () => {
  it('帧流电流树缺省：结构+mask 引用+判据数据+relation+版本号+停止判据提示', async () => {
    const f = setup();
    try {
      const out = (await okOf(await f.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: f.taskId }, 'agent'))) as unknown as {
        treeBlobRef: string;
        currentVersion: number | null;
        stopCriteriaHint: string;
        nodes: Array<{ id: string; objectName: string; parent: string | null; relation: string | null; effectiveMm: number; labVariance: number; mask: { kind: string; w?: number; h?: number } }>;
      };
      expect(out.treeBlobRef).toBe(f.treeBlobRef);
      expect(out.currentVersion).toBeNull(); // 尚无工作台版本链
      expect(out.stopCriteriaHint).toContain('停止判据');
      expect(out.stopCriteriaHint).toContain('effectiveMm');
      const hand = out.nodes.find((n) => n.id === 'n-hand')!;
      expect(hand.parent).toBe('n-clown');
      expect(hand.relation).toBe('semantic');
      expect(hand.effectiveMm).toBe(17.5);
      expect(hand.labVariance).toBe(9);
      expect(hand.mask).toMatchObject({ kind: 'inline', w: 14, h: 22 });
    } finally {
      f.dispose();
    }
  });

  it('显式 treeBlobRef 读历史版本；无树任务 typed 失败', async () => {
    const f = setup();
    try {
      const out = (await okOf(await f.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: f.taskId, treeBlobRef: f.treeBlobRef }, 'agent'))) as unknown as { treeBlobRef: string };
      expect(out.treeBlobRef).toBe(f.treeBlobRef);
      const bare = setup();
      try {
        const result = await bare.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: 'task-nonexistent' }, 'agent');
        expect(result).toMatchObject({ kind: 'failed' });
      } finally {
        bare.dispose();
      }
    } finally {
      f.dispose();
    }
  });

  it('归属门（v6 复核 P1-2）：跨任务树 blob typed 拒 artifact-task-mismatch；本任务 blob 通', async () => {
    const f = setup();
    try {
      // 任务 B：同库独立会话+agent 任务+自有树（帧流只登记 B 自己的工件）。
      // 树内容与 A 有意不同（内容寻址去重——同内容同 hash 会让归属断言失真）。
      const { sessionId: otherSession } = f.s.sessions.create(f.s.anonymous, { title: 'tree-tools 跨任务' });
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession, status: 'running' });
      const otherTree = clownTree();
      otherTree.nodes = otherTree.nodes.map((n) => (n.id === 'n-clown' ? { ...n, objectName: '小丑（B 任务）' } : n));
      const otherTreeRef = persistObjectTreeArtifact({ db: f.s.db, blobs: f.s.blobs }, otherTask.id, otherTree).treeBlobRef;
      f.s.jobs.emitFor(otherTask.id, 'artifact', { blobRef: otherTreeRef, name: 'object-tree.json' });

      // B 显式传 A 的树 blob → typed 拒（内容寻址 hash 推不出归属——零节点内容泄露）
      const leaked = await f.registry.call(
        TREE_INSPECT_TOOL_NAME,
        { taskId: otherTask.id, treeBlobRef: f.treeBlobRef },
        'agent',
      );
      expect(leaked).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
      expect((leaked as { message: string }).message).toContain('artifact-task-mismatch');
      expect((leaked as { message: string }).message).not.toContain('n-clown'); // 拒面不携带他任务树内容

      // B 读自己的 blob → ok（帧流登记面命中）
      const own = (await okOf(
        await f.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: otherTask.id, treeBlobRef: otherTreeRef }, 'agent'),
      )) as unknown as { treeBlobRef: string };
      expect(own.treeBlobRef).toBe(otherTreeRef);

      // A 显式读自己的登记 blob → ok
      const self = (await okOf(
        await f.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: f.taskId, treeBlobRef: f.treeBlobRef }, 'agent'),
      )) as unknown as { treeBlobRef: string };
      expect(self.treeBlobRef).toBe(f.treeBlobRef);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] merge

describe('studio.tree.merge（子→父吸收——树变换+版本入史+CAS）', () => {
  it('兄弟吸收：mask 并集+bbox 并集+children 移交+判据重算+版本入史+帧推进', async () => {
    const f = setup();
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_MERGE_TOOL_NAME,
          { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-hand', sourceNodeIds: ['n-face'] },
          'agent',
        ),
      )) as unknown as {
        treeBlobRef: string;
        previewBlobRef: string;
        version: number;
        removedNodeIds: string[];
        demotedNodeIds: string[];
      };
      expect(out.removedNodeIds).toEqual(['n-face']);
      expect(out.version).toBe(1);
      const versions = versionsOf(f);
      expect(versions[versions.length - 1]).toMatchObject({ cause: 'tree-merge' });
      expect(currentTreeRefOf(f)).toBe(out.treeBlobRef); // 帧流电流树推进
      const tree = readTree(f, out.treeBlobRef);
      // n-face 出树；n-nose（n-face 子）移交 n-hand；n-hand 变组 → demote（v5 组不产钻）
      expect(tree.nodes.some((n) => n.id === 'n-face')).toBe(false);
      const hand = tree.nodes.find((n) => n.id === 'n-hand')!;
      const nose = tree.nodes.find((n) => n.id === 'n-nose')!;
      const clown = tree.nodes.find((n) => n.id === 'n-clown')!;
      expect(nose.parent).toBe('n-hand'); // children 移交
      expect(hand.children).toEqual(['n-nose']);
      expect(clown.children).toEqual(['n-hand', 'n-part1']); // n-face 从父 children 移除（n-part1=refinement fixture 不受影响）
      // n-hand 吸收 children 变组 → 旧指派收敛面（v5 组不产钻——demotedNodeIds 标记）
      expect(out.demotedNodeIds).toEqual(['n-hand']);
      // mask 并集：n-hand(14×22 @14,40) ∪ n-face(24×20 @34,20) → bbox x[14,58) y[20,62)
      expect(hand.bbox).toEqual({ x: 14, y: 20, w: 44, h: 42 });
      expect(hand.effectiveMm).toBeCloseTo(Math.sqrt(44 * 42) / 0.96, 5); // ppm=96px/100mm=0.96
      expect(hand.labVariance).toBeGreaterThanOrEqual(0);
    } finally {
      f.dispose();
    }
  });

  it('demote 语义：target 吸收 children 后变组=组不产钻（demotedNodeIds=[target]）', async () => {
    const f = setup();
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_MERGE_TOOL_NAME,
          { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-clown', sourceNodeIds: ['n-hand'] },
          'agent',
        ),
      )) as unknown as { demotedNodeIds: string[]; removedNodeIds: string[] };
      expect(out.removedNodeIds).toEqual(['n-hand']);
      // n-clown 吸收后仍有 children（n-face）→ demote 标记（无存量 plan 时无指派实收敛）
      expect(out.demotedNodeIds).toEqual(['n-clown']);
    } finally {
      f.dispose();
    }
  });

  it('指派收敛：被吸收/组化节点的旧指派随 plan 收敛重算（exclusion 面零引擎依赖）', async () => {
    const plan = StrategyPlanSchema.parse({
      kind: 'strategy-plan',
      formatVersion: 1,
      objectTreeRef: '0'.repeat(64),
      assignments: [
        { nodeId: 'n-hand', strategyKind: 'exclusion', params: { reason: '测试排除' }, stones: [], densityPerCm2: 2.3, rationale: 'r' },
        { nodeId: 'n-nose', strategyKind: 'exclusion', params: { reason: '测试排除' }, stones: [], densityPerCm2: 2.3, rationale: 'r' },
      ],
      createdAt: '2026-09-28T00:00:00.000Z',
    });
    const f = setup({ plan });
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_MERGE_TOOL_NAME,
          { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-hand', sourceNodeIds: ['n-face'] },
          'agent',
        ),
      )) as unknown as { gems?: { count: number }; treeBlobRef: string; demotedNodeIds: string[] };
      // 收敛面：n-face（出树）+n-hand（吸收 n-nose 变组——demote）指派移除；n-nose 保留重算
      expect(out.demotedNodeIds).toEqual(['n-hand']);
      expect(out.gems).toBeDefined(); // 剩余指派重算落档（exclusion 产 excludedRegions）
      expect(currentTreeRefOf(f)).toBe(out.treeBlobRef);
      // 帧流 strategy-plan.json 已推进到收敛 plan
      const frames = new FrameStore(f.s.jobs.framesFileOf(f.taskId)).readAfter(0);
      const planFrames = frames.filter(
        (frame) => frame.kind === 'artifact' && (frame.payload as { name?: string }).name === STRATEGY_PLAN_ARTIFACT_NAME,
      );
      expect(planFrames.length).toBeGreaterThanOrEqual(2); // 种子帧+收敛帧
      const convergedPlan = StrategyPlanSchema.parse(
        JSON.parse(f.s.blobs.read((planFrames.at(-1)!.payload as { blobRef: string }).blobRef)!.toString('utf8')),
      );
      expect(convergedPlan.assignments.map((a) => a.nodeId)).toEqual(['n-nose']);
    } finally {
      f.dispose();
    }
  });

  it('CAS 拒：expectedTreeBlobRef 漂移必拒（cas-mismatch——不静默覆盖他写）', async () => {
    const f = setup();
    try {
      const result = await f.registry.call(
        TREE_MERGE_TOOL_NAME,
        { taskId: f.taskId, expectedTreeBlobRef: 'a'.repeat(64), targetNodeId: 'n-hand', sourceNodeIds: ['n-face'] },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'failed' });
      expect((result as { message: string }).message).toContain('CAS 漂移必拒');
      expect(versionsOf(f)).toHaveLength(0); // 零写入
    } finally {
      f.dispose();
    }
  });

  it('结构守卫：根保护（画布不可被吸收）/吸收方向倒置成环/目标缺席', async () => {
    const f = setup();
    try {
      const rootMerge = await f.registry.call(
        TREE_MERGE_TOOL_NAME,
        { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-clown', sourceNodeIds: ['n-canvas'] },
        'agent',
      );
      expect((rootMerge as { message: string }).message).toContain('root-protected');
      const inverted = await f.registry.call(
        TREE_MERGE_TOOL_NAME,
        { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-clown', sourceNodeIds: ['n-canvas'] },
        'agent',
      );
      expect(inverted).toMatchObject({ kind: 'failed' });
      // target 在 source 子树内（n-nose 在 n-face 子树内——反向吸收）
      const cycle = await f.registry.call(
        TREE_MERGE_TOOL_NAME,
        { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-nose', sourceNodeIds: ['n-face'] },
        'agent',
      );
      expect((cycle as { message: string }).message).toContain('子树内');
      const missing = await f.registry.call(
        TREE_MERGE_TOOL_NAME,
        { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-none', sourceNodeIds: ['n-face'] },
        'agent',
      );
      expect((missing as { message: string }).message).toContain('不在当前树');
      expect(versionsOf(f)).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it('嵌套 source 拒（v6 复核 P2）：sourceNodeIds 同含祖先-后代对 → typed 拒零写入', async () => {
    const f = setup();
    try {
      // n-face 在 n-clown 子树内（父+子同为吸收源）——吸收边界含糊，语义冻结为显式拒
      const result = await f.registry.call(
        TREE_MERGE_TOOL_NAME,
        { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-canvas', sourceNodeIds: ['n-clown', 'n-face'] },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'failed' });
      expect((result as { message: string }).message).toContain('嵌套');
      expect(versionsOf(f)).toHaveLength(0); // 零写入
      const tree = readTree(f, currentTreeRefOf(f));
      expect(tree.nodes).toHaveLength(6); // 树原样（含 n-part1 fixture）
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] refine

describe('studio.tree.refine（限定节点掩码内 SAM 多提示→refinement 子节点）', () => {
  it('链式两提示：子节点 origin/relation=refinement+每步版本入史（cause=tree-refine）', async () => {
    const f = setup();
    try {
      // 合成响应（test-only mock 桥）：组合提示的 box（=父 bbox 锚）中心 16×16 实心块
      // （≥碎片阈值 200px——96×96 画布 max(200, 0.05%×画幅)=200）；按提示文本奇偶
      // 左右偏 5px——两子区域错开（兄弟互斥不吞没）。
      const solidCenter = (req: { prompt: { text?: unknown; box?: { x: number; y: number; w: number; h: number } } }) => {
        const box = req.prompt.box!;
        const dx = (String(req.prompt.text ?? '').length % 2 === 0 ? -5 : 5);
        const cx = box.x + Math.floor(box.w / 2) + dx;
        const cy = box.y + Math.floor(box.h / 2);
        const bits = new Uint8Array(96 * 96);
        for (let y = cy - 8; y < cy + 8; y++) {
          for (let x = cx - 8; x < cx + 8; x++) bits[y * 96 + x] = 1;
        }
        return {
          kind: 'segment' as const,
          mask: { kind: 'inline' as const, w: 96, h: 96, encoding: 'base64-01' as const, data: Buffer.from(bits).toString('base64') },
          score: 0.8,
          meta: { model: 'mock', durationMs: 1, iteration: 0 },
        };
      };
      f.transport.respond((call) => Promise.resolve(solidCenter(call.request as never)) as never);
      f.transport.respond((call) => Promise.resolve(solidCenter(call.request as never)) as never);
      const out = (await okOf(
        await f.registry.call(
          TREE_REFINE_TOOL_NAME,
          { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, nodeId: 'n-face', hints: ['nose', 'cheek'] },
          'agent',
        ),
      )) as unknown as {
        treeBlobRef: string;
        previewBlobRef: string;
        versions: number[];
        children: Array<{ origin: string; relation: string; parent: string }>;
        warnings: unknown[];
      };
      expect(out.versions).toHaveLength(2); // 每提示一步=版本入史
      const causes = versionsOf(f).map((v) => v.cause);
      expect(causes).toEqual(['tree-refine', 'tree-refine']);
      expect(out.children).toHaveLength(2);
      for (const child of out.children) {
        expect(child.parent).toBe('n-face');
        expect(child.origin).toBe('refinement'); // B2：SAM 拆分产物=refinement 临时节点
        expect(child.relation).toBe('refinement');
      }
      const tree = readTree(f, out.treeBlobRef);
      const face = tree.nodes.find((n) => n.id === 'n-face')!;
      expect(face.children).toHaveLength(3); // 既有 n-nose+两个 refinement 子
      // 子掩码=父∩子（限定节点 mask 区域内——外溢被裁）
      for (const child of tree.nodes.filter((n) => n.parent === 'n-face')) {
        expect(child.bbox.x).toBeGreaterThanOrEqual(face.bbox.x);
        expect(child.bbox.x + child.bbox.w).toBeLessThanOrEqual(face.bbox.x + face.bbox.w);
      }
      expect(currentTreeRefOf(f)).toBe(out.treeBlobRef);
    } finally {
      f.dispose();
    }
  });

  it('CAS 拒：expectedTreeBlobRef 漂移必拒（零桥请求）', async () => {
    const f = setup();
    try {
      const result = await f.registry.call(
        TREE_REFINE_TOOL_NAME,
        { taskId: f.taskId, expectedTreeBlobRef: 'b'.repeat(64), nodeId: 'n-face', hints: ['nose'] },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'failed' });
      expect((result as { message: string }).message).toContain('CAS 漂移必拒');
      expect(f.transport.requests).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] reparent + [5] rename

describe('studio.tree.reparent / studio.tree.rename（B2 重分类收口）', () => {
  it('reparent：红鼻子 脸部→小丑（layer.reorder 内核复用——cause=reorder）', async () => {
    const f = setup();
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_REPARENT_TOOL_NAME,
          { taskId: f.taskId, nodeId: 'n-nose', newParentId: 'n-clown', index: 0, expectedTreeBlobRef: f.treeBlobRef },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string; version: number };
      const tree = readTree(f, out.treeBlobRef);
      const nose = tree.nodes.find((n) => n.id === 'n-nose')!;
      const clown = tree.nodes.find((n) => n.id === 'n-clown')!;
      const face = tree.nodes.find((n) => n.id === 'n-face')!;
      expect(nose.parent).toBe('n-clown');
      expect(clown.children[0]).toBe('n-nose');
      expect(face.children).toEqual([]);
      expect(versionsOf(f).at(-1)).toMatchObject({ cause: 'reorder' });
    } finally {
      f.dispose();
    }
  });

  it('rename：名+drillWorthy 标注一步完成（「小丑·部分1」→「左手」类重分类）', async () => {
    const f = setup();
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_RENAME_TOOL_NAME,
          { taskId: f.taskId, nodeId: 'n-hand', objectName: '左手（左）', drillWorthy: false, expectedTreeBlobRef: f.treeBlobRef },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string; version: number };
      const tree = readTree(f, out.treeBlobRef);
      const hand = tree.nodes.find((n) => n.id === 'n-hand')!;
      expect(hand.objectName).toBe('左手（左）');
      expect(hand.drillWorthy).toBe(false); // drillWorthy 标注写透
      expect(hand.relation).toBe('semantic'); // 未传 relation=不改（纯改名面）
      expect(versionsOf(f).at(-1)).toMatchObject({ cause: 'rename' });
    } finally {
      f.dispose();
    }
  });

  it('rename 显式重分类（v6 复核 P1-1）：「小丑·部分1」refinement→semantic 升语义部位', async () => {
    const f = setup();
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_RENAME_TOOL_NAME,
          { taskId: f.taskId, nodeId: 'n-part1', objectName: '右手', relation: 'semantic', expectedTreeBlobRef: f.treeBlobRef },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string; version: number };
      const tree = readTree(f, out.treeBlobRef);
      const part = tree.nodes.find((n) => n.id === 'n-part1')!;
      expect(part.objectName).toBe('右手');
      expect(part.relation).toBe('semantic'); // 产钻面升级：semantic 叶子可产钻
      // 结构面零漂移：parent/children/mask/bbox/drillWorthy 不因重分类变动
      expect(part.parent).toBe('n-clown');
      expect(part.children).toEqual([]);
      expect(part.bbox).toEqual({ x: 20, y: 14, w: 8, h: 8 });
      expect(part.drillWorthy).toBe(true);
      const version = versionsOf(f).at(-1)!;
      expect(version.cause).toBe('rename');
      expect(version.detail).toContain('refinement→semantic'); // 版本链记录重分类轨迹
      expect(currentTreeRefOf(f)).toBe(out.treeBlobRef); // 帧流电流树推进
    } finally {
      f.dispose();
    }
  });

  it('rename 显式重分类降级：semantic→refinement（误标回退——B2 三态可逆）', async () => {
    const f = setup();
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_RENAME_TOOL_NAME,
          { taskId: f.taskId, nodeId: 'n-hand', objectName: '左手', relation: 'refinement', expectedTreeBlobRef: f.treeBlobRef },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string };
      const tree = readTree(f, out.treeBlobRef);
      expect(tree.nodes.find((n) => n.id === 'n-hand')!.relation).toBe('refinement');
      expect(versionsOf(f).at(-1)!.detail).toContain('semantic→refinement');
    } finally {
      f.dispose();
    }
  });

  it('rename 重分类 typed 拒：根/画布与组节点不可改类（零写入）', async () => {
    const f = setup();
    try {
      const root = await f.registry.call(
        TREE_RENAME_TOOL_NAME,
        { taskId: f.taskId, nodeId: 'n-canvas', objectName: '画布', relation: 'semantic', expectedTreeBlobRef: f.treeBlobRef },
        'agent',
      );
      expect((root as { message: string }).message).toContain('root-protected');
      const group = await f.registry.call(
        TREE_RENAME_TOOL_NAME,
        { taskId: f.taskId, nodeId: 'n-clown', objectName: '小丑', relation: 'refinement', expectedTreeBlobRef: f.treeBlobRef },
        'agent',
      );
      expect((group as { message: string }).message).toContain('不可重分类');
      expect(group).toMatchObject({ kind: 'failed' });
      expect(versionsOf(f)).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it('rename CAS 拒（漂移必拒——零写入）', async () => {
    const f = setup();
    try {
      const result = await f.registry.call(
        TREE_RENAME_TOOL_NAME,
        { taskId: f.taskId, nodeId: 'n-hand', objectName: 'x', expectedTreeBlobRef: 'c'.repeat(64) },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'failed' });
      expect(versionsOf(f)).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [8] MCP 注册面

describe('MCP 注册面（五工具在册+投影名+deny 名单存活）', () => {
  it('registry 五工具名与 authority 标注；mcp 投影名 tree_*；product deny 名单不遮蔽', () => {
    const f = setup();
    try {
      const descriptors = f.registry.describe();
      expect(descriptors.map((d) => d.name).sort()).toEqual(
        [TREE_INSPECT_TOOL_NAME, TREE_MERGE_TOOL_NAME, TREE_REFINE_TOOL_NAME, TREE_REPARENT_TOOL_NAME, TREE_RENAME_TOOL_NAME].sort(),
      );
      const byName = new Map(descriptors.map((d) => [d.name, d] as const));
      expect(byName.get(TREE_INSPECT_TOOL_NAME)!.authority).toBe('readonly');
      expect(byName.get(TREE_MERGE_TOOL_NAME)!.authority).toBe('proposal'); // 直效写标注（文件头注语义）
      expect(mcpToolName(TREE_INSPECT_TOOL_NAME)).toBe('tree_inspect');
      expect(mcpToolName(TREE_MERGE_TOOL_NAME)).toBe('tree_merge');
      // product deny 名单不遮蔽（mcp__studio__* 前缀族——rpc 同款判定）
      const deny = productToolDenyList([
        'bash',
        'todo_write',
        'mcp__studio__tree_inspect',
        'mcp__studio__tree_merge',
        'mcp__studio__tree_refine',
        'mcp__studio__tree_reparent',
        'mcp__studio__tree_rename',
      ]);
      expect(deny).toEqual(['bash']); // todo_write 在 allowlist（deny 只含非 allowlist 非 studio 面）
    } finally {
      f.dispose();
    }
  });
});
