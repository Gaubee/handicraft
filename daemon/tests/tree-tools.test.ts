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
import { persistObjectTreeArtifact, resolveMaskBits } from '../src/kernel/vision/tree-persist.js';
import {
  STRATEGY_PLAN_ARTIFACT_NAME,
} from '../src/kernel/strategies/design.js';
import { TaskWorkbench } from '../src/kernel/workbench.js';
import { treeToBlocks } from '../src/kernel/vision/tree-to-blocks.js';
import { stringToSeed } from '../src/kernel/strategies/rng.js';
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

  /**
   * add-sam-playbook T2.5：steps 步进模式——Agent 修泄漏（excludeBox 像素减法）/
   * 逐实例（instances=all 扇出）/纯框（box 无 hint）混排一次调用。目标 n-clown
   * （bbox 10,12,60,60——子掩码=父∩子且父 mask 全 1，落点即掩膜）。三步落区互斥
   * 且避开既有子（hand x[14,28)y[40,62)/face x[34,58)y[20,40)/part1 x[20,28)y[14,22)）：
   * star 两实例 A x[58,70)y[14,32)（216px）B x[14,46)y[64,72)（256px）；纯框步
   * x[44,64)y[44,64)（400px）；crown 泄漏修法 x[12,32)y[22,40)（360px）扣
   * excludeBox x[20,28)y[28,36)（64px→296px）——均 ≥碎片阈值 200px 不被吞。
   */
  it('steps 步进透传（T2.5）：hint+instances 步/纯框步/泄漏修法步混排——逐步桥 prompt 形状+excludeBox 减法落地+纯框命名+逐实例子层', async () => {
    const f = setup();
    try {
      const rectBits = (x0: number, y0: number, w: number, h: number) => {
        const bits = new Uint8Array(96 * 96);
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) bits[y * 96 + x] = 1;
        }
        return bits;
      };
      const inlineMask = (bits: Uint8Array) => ({
        kind: 'inline' as const,
        w: 96,
        h: 96,
        encoding: 'base64-01' as const,
        data: Buffer.from(bits).toString('base64'),
      });
      const seg = (bits: Uint8Array, extra: Record<string, unknown> = {}) => ({
        kind: 'segment' as const,
        mask: inlineMask(bits),
        score: 0.8,
        meta: { model: 'mock', durationMs: 1, iteration: 0 },
        ...extra,
      });
      const seenPrompts: Array<Record<string, unknown>> = [];
      const seenTopK: Array<unknown> = [];
      // 步 1：star 逐实例（detections 两枚——T1 账本逐实例明细面）
      f.transport.respond((call) => {
        if (call.request.kind === 'segment') {
          seenPrompts.push(call.request.prompt as unknown as Record<string, unknown>);
          seenTopK.push((call.request as unknown as { topK?: unknown }).topK);
        }
        return seg(rectBits(58, 14, 12, 18), {
          count: 2,
          detections: [
            { mask: inlineMask(rectBits(58, 14, 12, 18)), score: 0.9 },
            { mask: inlineMask(rectBits(14, 64, 32, 8)), score: 0.8 },
          ],
        }) as never;
      });
      // 步 2：纯框步（无 hint——mock 落点即框内）
      f.transport.respond((call) => {
        if (call.request.kind === 'segment') {
          seenPrompts.push(call.request.prompt as unknown as Record<string, unknown>);
          seenTopK.push((call.request as unknown as { topK?: unknown }).topK);
        }
        return seg(rectBits(44, 44, 20, 20)) as never;
      });
      // 步 3：crown 泄漏修法（SAM 回整块 360px——excludeBox 框内由 daemon 像素减法扣除）
      f.transport.respond((call) => {
        if (call.request.kind === 'segment') {
          seenPrompts.push(call.request.prompt as unknown as Record<string, unknown>);
          seenTopK.push((call.request as unknown as { topK?: unknown }).topK);
        }
        return seg(rectBits(12, 22, 20, 18)) as never;
      });
      const out = (await okOf(
        await f.registry.call(
          TREE_REFINE_TOOL_NAME,
          {
            taskId: f.taskId,
            expectedTreeBlobRef: f.treeBlobRef,
            nodeId: 'n-clown',
            steps: [
              { hint: 'star', instances: 'all' },
              { box: { x: 44, y: 44, w: 20, h: 20 } },
              { hint: 'crown', excludeBox: { x: 20, y: 28, w: 8, h: 8 } },
            ],
          },
          'agent',
        ),
      )) as unknown as {
        treeBlobRef: string;
        versions: number[];
        children: Array<{ objectName: string; parent: string; origin: string; relation: string; segmentPrompt?: string }>;
      };
      // —— 逐步桥 prompt 形状（一步一桥调——refine 链无账本回放面） ——
      expect(f.transport.requests).toHaveLength(3);
      expect(seenPrompts[0]).toMatchObject({ kind: 'text', text: 'star', box: { x: 10, y: 12, w: 60, h: 60 } }); // 缺省锚=父外接框
      expect(seenPrompts[0]!.excludeBox).toBeUndefined();
      expect(seenTopK[0]).toBe(24); // instances=all ⇒ topK=护栏上限（T1 D1）
      expect(seenPrompts[1]).toMatchObject({ kind: 'text', box: { x: 44, y: 44, w: 20, h: 20 } }); // 纯框：text 缺席+box=入参正框
      expect(seenPrompts[1]!.text).toBeUndefined();
      expect(seenPrompts[2]).toMatchObject({
        kind: 'text',
        text: 'crown',
        box: { x: 10, y: 12, w: 60, h: 60 },
        excludeBox: { x: 20, y: 28, w: 8, h: 8 },
      }); // 排除区随 prompt（入 reqHash）
      // —— 版本链：每步一版本；纯框步 detail 记 box[x,y,w,h] 语义串 ——
      expect(out.versions).toHaveLength(3);
      const details = versionsOf(f).map((v) => v.detail ?? '');
      expect(details[0]).toContain('提示：star');
      expect(details[1]).toContain('框选：box[44,44,20,20]');
      expect(details[2]).toContain('提示：crown');
      // —— 子层：逐实例子层（基名+序号）+纯框命名「框选区域」+泄漏修法层 ——
      expect(out.children.map((c) => c.objectName)).toEqual(['star 1', 'star 2', '框选区域', 'crown']);
      expect(out.children[0]!.segmentPrompt).toBe('star[instance-1]');
      expect(out.children[2]!.segmentPrompt).toBe('box[44,44,20,20]');
      for (const child of out.children) {
        expect(child.parent).toBe('n-clown');
        expect(child.origin).toBe('refinement');
        expect(child.relation).toBe('refinement');
      }
      const tree = readTree(f, out.treeBlobRef);
      const clown = tree.nodes.find((n) => n.id === 'n-clown')!;
      expect(clown.children).toHaveLength(7); // hand/face/part1+4 新子
      // —— excludeBox 减法落地：crown 掩膜排除区全零、区外逐位保留（bbox 不收缩） ——
      const crown = tree.nodes.find((n) => n.objectName === 'crown')!;
      expect(crown.bbox).toEqual({ x: 12, y: 22, w: 20, h: 18 }); // 排除区在内部——紧外接不变
      const { bits } = resolveMaskBits(f.s.blobs, crown.mask);
      let zeroInside = 0;
      let oneOutside = 0;
      for (let y = 0; y < crown.bbox.h; y++) {
        for (let x = 0; x < crown.bbox.w; x++) {
          // 排除区 x[20,28)y[28,36) → bbox 相对 x[8,16)y[6,14)
          const inExclude = x >= 8 && x < 16 && y >= 6 && y < 14;
          const v = bits[y * crown.bbox.w + x]!;
          if (inExclude) {
            if (v === 0) zeroInside++;
          } else if (v === 1) oneOutside++;
        }
      }
      expect(zeroInside).toBe(64); // 8×8 排除区全零
      expect(oneOutside).toBe(20 * 18 - 64); // 区外逐位保留
      expect(currentTreeRefOf(f)).toBe(out.treeBlobRef);
    } finally {
      f.dispose();
    }
  });

  it('steps 契约拒面（T2.5）：hints/steps 双全与每步全空/excludeBox 单用——typed 拒零桥请求', async () => {
    const f = setup();
    try {
      const both = await f.registry.call(
        TREE_REFINE_TOOL_NAME,
        {
          taskId: f.taskId,
          expectedTreeBlobRef: f.treeBlobRef,
          nodeId: 'n-face',
          hints: ['nose'],
          steps: [{ hint: 'cheek' }],
        },
        'agent',
      );
      expect(both).toMatchObject({ kind: 'failed' });
      expect((both as { message: string }).message).toContain('恰一存在');
      const bareStep = await f.registry.call(
        TREE_REFINE_TOOL_NAME,
        {
          taskId: f.taskId,
          expectedTreeBlobRef: f.treeBlobRef,
          nodeId: 'n-face',
          steps: [{ excludeBox: { x: 1, y: 1, w: 2, h: 2 } }],
        },
        'agent',
      );
      expect(bareStep).toMatchObject({ kind: 'failed' });
      expect((bareStep as { message: string }).message).toContain('每步 hint 与 box 至少提供一项');
      expect(f.transport.requests).toHaveLength(0); // 零桥请求
    } finally {
      f.dispose();
    }
  });

  /**
   * iter-1 Codex 审查修复②（2026-10-04）：步级 precision 全链透传——wire 回执断言。
   * 修复前 TreeRefineStepSchema 无 precision、treeRefine 只转发四参数，底层
   * segmentOne 的 precision 支持在 refine 路径不可达（「降阈值」只存在于叙事，
   * confThreshold 恒为配置缺省）。修复后：带 precision 的步 wire 请求携带覆写值；
   * 未带的步 wire 请求不携带（测试环境无 tuner——缺省即缺席，非恒 0.4）。
   */
  it('steps precision 透传（iter-1 修复②）：带参步 wire confThreshold/maskMaxSide 落参生效——未带步无覆写', async () => {
    const f = setup();
    try {
      const rectBits = (x0: number, y0: number, w: number, h: number) => {
        const bits = new Uint8Array(96 * 96);
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) bits[y * 96 + x] = 1;
        return bits;
      };
      const seg = (bits: Uint8Array) => ({
        kind: 'segment' as const,
        mask: { kind: 'inline' as const, w: 96, h: 96, encoding: 'base64-01' as const, data: Buffer.from(bits).toString('base64') },
        score: 0.8,
        meta: { model: 'mock', durationMs: 1, iteration: 0 },
      });
      // 落区避开 n-clown 既有子（hand x[14,28)y[40,62)/face x[34,58)y[20,40)/part1
      // x[20,28)y[14,22)）：步1 x[44,64)y[44,64)、步2 x[30,58)y[44,64)——均 ≥200px 不被吞。
      f.transport.respond(() => Promise.resolve(seg(rectBits(44, 44, 20, 20))) as never);
      f.transport.respond(() => Promise.resolve(seg(rectBits(30, 44, 28, 20))) as never);
      const out = (await okOf(
        await f.registry.call(
          TREE_REFINE_TOOL_NAME,
          {
            taskId: f.taskId,
            expectedTreeBlobRef: f.treeBlobRef,
            nodeId: 'n-clown',
            steps: [
              { hint: 'crown', precision: { confThreshold: 0.3, maskMaxSide: 1536 } },
              { hint: 'collar' }, // 未带 precision 的步——wire 无覆写（对照）
            ],
          },
          'agent',
        ),
      )) as unknown as { versions: number[]; children: Array<{ objectName: string }> };
      expect(out.versions).toHaveLength(2);
      // —— wire 回执（MockSamTransport.requests=桥请求真身）：带参步 confThreshold
      //    不再恒 0.4——落参 0.3/1536 逐字段生效；未带步两字段均缺席。
      expect(f.transport.requests).toHaveLength(2);
      const wireWith = f.transport.requests[0] as unknown as { confThreshold?: number; maskMaxSide?: number };
      const wireWithout = f.transport.requests[1] as unknown as { confThreshold?: number; maskMaxSide?: number };
      expect(wireWith.confThreshold).toBe(0.3);
      expect(wireWith.maskMaxSide).toBe(1536);
      expect(wireWithout.confThreshold).toBeUndefined();
      expect(wireWithout.maskMaxSide).toBeUndefined();
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

  it('P2 行为级差分（Codex v6 终评）：refinement 叶子升 relation=semantic 前后产块面完全相同——relation 不参与产块判定', async () => {
    const f = setup();
    try {
      const blocksOf = (tree: ObjectTree) => {
        const result = treeToBlocks(
          tree,
          { readBlob: (ref) => f.s.blobs.read(ref) },
          { gemDiameterPx: 5 * (IMAGE_PX.width / (CANVAS_CM.w * 10)) },
        );
        expect(result.ok).toBe(true);
        return result.ok ? result.blocks : [];
      };
      const before = blocksOf(readTree(f, f.treeBlobRef));
      expect(before.map((b) => b.id)).toContain('n-part1'); // refinement 叶子产块（叶子必产——v5）

      const out = (await okOf(
        await f.registry.call(
          TREE_RENAME_TOOL_NAME,
          { taskId: f.taskId, nodeId: 'n-part1', objectName: '右手', relation: 'semantic', expectedTreeBlobRef: f.treeBlobRef },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string };
      const after = blocksOf(readTree(f, out.treeBlobRef));
      expect(readTree(f, out.treeBlobRef).nodes.find((n) => n.id === 'n-part1')!.relation).toBe('semantic'); // 前提：升类确已发生

      // blockId 集合（含序）完全相同
      expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
      const beforeById = new Map(before.map((b) => [b.id, b] as const));
      for (const block of after) {
        const prev = beforeById.get(block.id)!;
        // mask/bbox/几何统计/建议类型/代表色逐字段相同（产块判定与 relation 无关）
        expect(block.mask).toEqual(prev.mask);
        expect(block.bbox).toEqual(prev.bbox);
        expect(block.areaPx).toBe(prev.areaPx);
        expect(block.widthPx).toEqual(prev.widthPx);
        expect(block.suggested).toBe(prev.suggested);
        expect(block.colorRgb).toEqual(prev.colorRgb);
        expect(block.origin).toEqual(prev.origin);
        // label 是唯一合法差异面（rename 改名本意）——且只发生在被改名节点
        if (block.id === 'n-part1') expect(block.label).not.toBe(prev.label);
        else expect(block.label).toBe(prev.label);
      }

      // 钻数差分：对升类节点块跑引擎布局（同 seed 同参——执行链同款确定性委派），
      // 前后 gems 完全一致且非空（relation 升类不改变任何一颗钻的落位/数量）。
      const gemsOf = (block: (typeof after)[number]) =>
        strategyEngineDelegate({
          block,
          strategy: 'hex-pitch',
          density: 1,
          seed: stringToSeed('n-part1'),
          gemDiameterMm: 5,
          pixelsPerMm: IMAGE_PX.width / (CANVAS_CM.w * 10),
        });
      const gemsBefore = gemsOf(beforeById.get('n-part1')!);
      const gemsAfter = gemsOf(after.find((b) => b.id === 'n-part1')!);
      expect(gemsBefore.gems.length).toBeGreaterThan(0);
      expect(gemsAfter).toEqual(gemsBefore);
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

  it('tree_refine 描述快照（T2.5）：steps 步进化+泄漏修法+instances 教法+KB 组引导关键词在册', () => {
    const f = setup();
    try {
      const byName = new Map(f.registry.describe().map((d) => [d.name, d] as const));
      const description = byName.get(TREE_REFINE_TOOL_NAME)!.description;
      // 步进化暴露面：steps/hints 互斥+步内至少一项
      expect(description).toContain('steps');
      expect(description).toContain('hint 与 box 至少一项');
      expect(description).toContain('互斥恰一存在');
      // 策略块（与 subject.segment 描述同口径——浓缩不重复，指向知识库组）
      expect(description).toContain('禁数词');
      expect(description).toContain('禁否定词');
      expect(description).toContain('instances=all');
      expect(description).toContain('泄漏修法');
      expect(description).toContain('excludeBox 框住泄漏区');
      expect(description).toContain('从结果掩膜中扣除');
      expect(description).toContain('SAM 提示词策略');
      expect(description).toContain('泛称回退');
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [9] 轮询未就绪熔断分流（P1-4）

describe('tree_inspect 轮询未就绪 vs 真故障熔断分流（真链走查 P1-4——2026-10-01）', () => {
  /**
   * 走查症状：树仍在生成（object-tree 工件未落）时 agent 轮询 tree.inspect，
   * 「未就绪」被按普通失败连击计数，5 次即熔断杀 turn（合法等待被当故障）。
   * 修复口径：ArtifactPendingError（上游工件未产出）走 noteNotReady——不计数、
   * 不触发 onRunaway、返回可重试语义+等待指引；真故障（连击同错）照旧熔断。
   */
  function setupWithRunaway(): { f: Fixture; runaways: string[]; registry: ReturnType<typeof createTreeCapabilities>; pendingTaskId: string } {
    const f = setup();
    const runaways: string[] = [];
    const registry = createTreeCapabilities({
      db: f.s.db,
      blobs: f.s.blobs,
      jobs: f.s.jobs,
      workbench: f.workbench,
      onRunaway: (bucket, detail) => runaways.push(`${bucket}:${detail}`),
    });
    // 未就绪任务：同库独立会话+agent 任务，不产任何树/分析工件（产树仍在进行的形态）。
    const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '产树进行中' });
    const pendingTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId, status: 'running' });
    return { f, runaways, registry, pendingTaskId: pendingTask.id };
  }

  it('N 次（>RUNAWAY_LIMIT）未就绪轮询不熔断：不触发 onRunaway、无熔断文案、带等待指引', async () => {
    const ctx = setupWithRunaway();
    try {
      for (let i = 0; i < 8; i += 1) {
        const result = await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.pendingTaskId }, 'agent');
        expect(result).toMatchObject({ kind: 'failed', code: 'UNAVAILABLE' });
        const message = (result as { message: string }).message;
        expect(message).toContain('未就绪');
        expect(message).toContain('尚无 object-tree 工件');
        expect(message).not.toContain('熔断'); // 第 6/7/8 次也不熔断
      }
      expect(ctx.runaways).toHaveLength(0); // 从未触发熔断回调
    } finally {
      ctx.f.dispose();
    }
  });

  it('树产出后轮询即成功（未就绪→ok 的等待闭环）', async () => {
    const ctx = setupWithRunaway();
    try {
      const first = await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.pendingTaskId }, 'agent');
      expect(first).toMatchObject({ kind: 'failed' });
      // 产树完成（subject.segment 落树工件的形态）。
      const treeRef = persistObjectTreeArtifact({ db: ctx.f.s.db, blobs: ctx.f.s.blobs }, ctx.pendingTaskId, clownTree()).treeBlobRef;
      ctx.f.s.jobs.emitFor(ctx.pendingTaskId, 'artifact', { blobRef: treeRef, name: 'object-tree.json' });
      const ok = await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.pendingTaskId }, 'agent');
      expect(ok).toMatchObject({ kind: 'ok' });
      expect(ctx.runaways).toHaveLength(0);
    } finally {
      ctx.f.dispose();
    }
  });

  it('连续真错误（artifact-task-mismatch 同错连击 5 次）仍熔断：onRunaway 触发+熔断文案', async () => {
    const ctx = setupWithRunaway();
    try {
      // 真故障形态：显式携带不属于本任务工件登记的 treeBlobRef（跨任务引用——typed 拒）。
      let last: unknown = null;
      for (let i = 0; i < 5; i += 1) {
        last = await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.f.taskId, treeBlobRef: 'f'.repeat(64) }, 'agent');
      }
      const message = (last as { message: string }).message;
      expect(message).toContain('熔断');
      expect(message).toContain('artifact-task-mismatch');
      expect(ctx.runaways).toHaveLength(1);
      expect(ctx.runaways[0]).toContain(ctx.f.taskId); // 任务桶定向
    } finally {
      ctx.f.dispose();
    }
  });

  it('未就绪响应不打断真故障连击（只有成功清零——防穿插轮询规避熔断）', async () => {
    const ctx = setupWithRunaway();
    try {
      const badRef = 'f'.repeat(64);
      // 3 次真故障 → 任意次未就绪（另一任务的合法等待）→ 2 次真故障 = 第 5 次真故障熔断。
      for (let i = 0; i < 3; i += 1) {
        await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.f.taskId, treeBlobRef: badRef }, 'agent');
      }
      for (let i = 0; i < 3; i += 1) {
        await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.pendingTaskId }, 'agent');
      }
      expect(ctx.runaways).toHaveLength(0); // 未就绪不熔断也不清零
      const fifth = await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.f.taskId, treeBlobRef: badRef }, 'agent');
      expect((fifth as { message: string }).message).not.toContain('熔断'); // 第 4 次（3+1 连击）
      const sixth = await ctx.registry.call(TREE_INSPECT_TOOL_NAME, { taskId: ctx.f.taskId, treeBlobRef: badRef }, 'agent');
      expect((sixth as { message: string }).message).toContain('熔断'); // 第 5 次连击=熔断
      expect(ctx.runaways).toHaveLength(1);
    } finally {
      ctx.f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [9] D3 树锚引用（add-flat-aux-segmentation T3.2）

/**
 * 四图引用分离的树编辑面收口（design D3）：树工件自带 imageBlobRef（树掩膜源
 * 显式锚——persistTreeWithPreview 单源写入，新树恒带）；树编辑（reparent/refine/
 * merge/rename）一律经 resolveTreeEditImageAnchor 取图——树锚优先，旧树无字段
 * 回退 scene-analysis 锚。定向回归=iter-5 分叉形态：树 1280px（ppm 6.4）vs
 * scene-analysis 500px（ppm 2.5）——旧取法（scene-analysis 直取）在 reparent/
 * merge 的树重落处尺寸拒（500 图 ≠ 树 1280 坐标）；树锚取法恒同图通过。
 */
describe('studio.tree 树锚引用（D3——树编辑一律用树锚，不从 scene-analysis 取图）', () => {
  const FORK_CANVAS_CM = { w: 20, h: 20 }; // iter-5 形态：500px→2.5ppm / 1280px→6.4ppm

  function solidPng(px: number, r: number, g: number, b: number): Uint8Array {
    const rgba = new Uint8Array(px * px * 4);
    for (let i = 0; i < px * px; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    return new Uint8Array(encodePng(px, px, rgba));
  }

  /** 分叉树（treePx 坐标）：画布根 → n-a/n-b 两叶（bbox 互不重叠，mask 同栅格 32×32）。 */
  function forkedTree(treePx: number): ObjectTree {
    const canvas: ObjectNode = {
      id: 'n-canvas',
      objectName: '画布',
      category: 'canvas',
      mask: solidMask(treePx, treePx),
      bbox: { x: 0, y: 0, w: treePx, h: treePx },
      parent: null,
      children: ['n-a', 'n-b'],
      effectiveMm: treePx,
      labVariance: 40,
      drillWorthy: false,
      origin: 'vlm+sam3',
    };
    const a: ObjectNode = {
      id: 'n-a',
      objectName: '甲部件',
      category: 'object',
      mask: solidMask(512, 512),
      bbox: { x: 64, y: 64, w: 512, h: 512 },
      parent: 'n-canvas',
      children: [],
      effectiveMm: 512,
      labVariance: 10,
      drillWorthy: true,
      origin: 'vlm+sam3',
      relation: 'semantic',
    };
    const b: ObjectNode = {
      id: 'n-b',
      objectName: '乙部件',
      category: 'object',
      mask: solidMask(512, 512),
      bbox: { x: 640, y: 640, w: 512, h: 512 },
      parent: 'n-canvas',
      children: [],
      effectiveMm: 512,
      labVariance: 12,
      drillWorthy: true,
      origin: 'vlm+sam3',
      relation: 'semantic',
    };
    return {
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: FORK_CANVAS_CM,
      imagePx: { width: treePx, height: treePx },
      nodes: [canvas, a, b],
      createdAt: '2026-10-04T00:00:00.000Z',
    };
  }

  interface ForkedFixture {
    s: TestServices;
    registry: ReturnType<typeof createTreeCapabilities>;
    taskId: string;
    /** 树坐标对应的图 blob（=树锚应为值）。 */
    treeImageRef: string;
    /** 分析入线图 blob（scene-analysis 锚——分叉面）。 */
    analysisImageRef: string;
    treeBlobRef: string;
    dispose(): void;
  }

  /**
   * 分叉 fixture：树=treePx 坐标（withTreeAnchor 决定树工件是否带显式锚），
   * scene-analysis 恒 500px 锚（analysisPx 可调用于同坐标兼容面）。
   */
  function setupForked(options: {
    treePx: number;
    withTreeAnchor: boolean;
    analysisPx?: number;
  }): ForkedFixture {
    const s = createServices(undefined, { imgDryRun: true });
    const { sessionId } = s.sessions.create(s.anonymous, { title: '树锚分叉测试' });
    const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
    const analysisPx = options.analysisPx ?? 500;
    const treeImageRef = s.blobs.put(solidPng(options.treePx, 200, 160, 220)).hash;
    const analysisImageRef = s.blobs.put(solidPng(analysisPx, 60, 180, 90)).hash;
    // scene-analysis（分析锚——iter-5 分叉形态的 500px 侧）
    const analysis = SceneAnalysisSchema.parse({
      kind: 'scene-analysis',
      formatVersion: 2,
      imageBlobRef: analysisImageRef,
      canvasCm: FORK_CANVAS_CM,
      imagePx: { width: analysisPx, height: analysisPx },
      elements: [
        { elementId: 'el-a', parentElementId: null, name: '甲部件', boxPx: { x: 25, y: 25, w: 200, h: 200 }, hint: 'part a', suggestDrillWorthy: true },
      ],
      createdAt: '2026-10-04T00:00:00.000Z',
    });
    const analysisRef = s.blobs.put(new Uint8Array(Buffer.from(JSON.stringify(analysis), 'utf8'))).hash;
    s.jobs.emitFor(task.id, 'artifact', { blobRef: analysisRef, name: 'scene-analysis.json' });
    const tree = forkedTree(options.treePx);
    if (options.withTreeAnchor) tree.imageBlobRef = treeImageRef;
    const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
    s.jobs.emitFor(task.id, 'artifact', { blobRef: treeBlobRef, name: 'object-tree.json' });
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
      registry,
      taskId: task.id,
      treeImageRef,
      analysisImageRef,
      treeBlobRef,
      dispose: () => s.dispose(),
    };
  }

  it('分叉场景（1280 树+500 分析图）：树锚在场 → reparent 成功不再尺寸拒；新树恒带树锚', async () => {
    const f = setupForked({ treePx: 1280, withTreeAnchor: true });
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_REPARENT_TOOL_NAME,
          { taskId: f.taskId, nodeId: 'n-b', newParentId: 'n-a', index: 0, expectedTreeBlobRef: f.treeBlobRef },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string };
      // 新树挂对+恒带树锚（=1280 树图，非 500 分析图——树编辑与树坐标恒同图）
      const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(out.treeBlobRef)!.toString('utf8')));
      expect(tree.nodes.find((n) => n.id === 'n-b')!.parent).toBe('n-a');
      expect(tree.imageBlobRef).toBe(f.treeImageRef);
    } finally {
      f.dispose();
    }
  });

  it('分叉场景：merge 成功（判据重测+树重落全在树锚图上）——673a87d 回归的树编辑扩展面', async () => {
    const f = setupForked({ treePx: 1280, withTreeAnchor: true });
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_MERGE_TOOL_NAME,
          { taskId: f.taskId, expectedTreeBlobRef: f.treeBlobRef, targetNodeId: 'n-a', sourceNodeIds: ['n-b'] },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string; removedNodeIds: string[] };
      expect(out.removedNodeIds).toEqual(['n-b']);
      const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(out.treeBlobRef)!.toString('utf8')));
      expect(tree.nodes.some((n) => n.id === 'n-b')).toBe(false);
      expect(tree.imageBlobRef).toBe(f.treeImageRef);
    } finally {
      f.dispose();
    }
  });

  it('旧树无 imageBlobRef（673a87d 前落盘）=兼容回退 scene-analysis 锚：同坐标任务现行为不变', async () => {
    // 树坐标=分析坐标（500）——回退锚与树坐标一致，编辑照旧成功（零迁移兼容面）
    const f = setupForked({ treePx: 500, withTreeAnchor: false, analysisPx: 500 });
    try {
      const out = (await okOf(
        await f.registry.call(
          TREE_REPARENT_TOOL_NAME,
          { taskId: f.taskId, nodeId: 'n-b', newParentId: 'n-a', index: 0, expectedTreeBlobRef: f.treeBlobRef },
          'agent',
        ),
      )) as unknown as { treeBlobRef: string };
      // 编辑后新树恒带锚（persist 层写入——回退锚快照固化，后续编辑不再受分析锚漂移影响）
      const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(out.treeBlobRef)!.toString('utf8')));
      expect(tree.imageBlobRef).toBe(f.analysisImageRef);
    } finally {
      f.dispose();
    }
  });

  it('旧树无锚+真分叉（1280 树 vs 500 分析锚）=回退语义下的现行为尺寸拒（不静默换图）', async () => {
    // 回退锚与树坐标分叉的历史病态档案：保持显式拒（不静默用分析图重落——
    // 那会产出坐标错位的树）；修复路径=显式树锚（新树恒带，见上两例）。
    const f = setupForked({ treePx: 1280, withTreeAnchor: false, analysisPx: 500 });
    try {
      const result = await f.registry.call(
        TREE_REPARENT_TOOL_NAME,
        { taskId: f.taskId, nodeId: 'n-b', newParentId: 'n-a', index: 0, expectedTreeBlobRef: f.treeBlobRef },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'failed' });
      expect((result as { message: string }).message).toContain('尺寸不符');
    } finally {
      f.dispose();
    }
  });
});
