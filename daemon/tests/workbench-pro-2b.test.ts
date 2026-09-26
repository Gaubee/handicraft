/**
 * workbench-pro 波 2b 复核修复测试（Codex 2b 复核 5.2/10——P0-2/P1-2）：
 * mask 编辑状态机运行路径（spec 冻结五态 accepted→recomputing→ready/stale/error 的
 * daemon 侧可达实现——2a 同步链只写 ready/error 被 Codex 判为「无运行路径」）：
 *   [1] 重算路径：patch 同步段写 accepted（响应即返）→异步作业置 recomputing→
 *       reexecutePlan 重算→终态 ready（条件更新——不覆盖竞态 stale）。
 *   [2] 树版本漂移检测：重算在途（accepted/recomputing）时非 mask-patch cause 落新
 *       版本→行 stale；作业条件更新不覆盖；stale 行阻断导出门直至重算清除。
 *   [3] 重算失败：作业 catch-all 落 error（异步路径无调用方可抛——不留 unhandled）；
 *       retryMaskEditRecompute（stale 清除/重放入口·重算）基于新基线收敛回 ready。
 *   [4] discardMaskEdit（放弃清除入口）：删行+门放行（mask 已落盘如实——仅清告警留痕）。
 *   [5] P1-2 折线光栅化：圆盘沿 points 折线扫掠（相邻点线段插值，步长≤半径/2）——
 *       大间距两点之间不留缝（旧实现逐点盖圆断笔）。
 * 内核级（TaskWorkbench 直调）。零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  StrategyPlanSchema,
  decodeInlineMask,
  encodeInlineMask,
  type ObjectNode,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { HandicraftKernel, strategyEngineDelegate } from '../src/kernel/index.js';
import { StoneService } from '../src/stones/service.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import { TaskWorkbench, exportGateOf, maskEditStatusesOf } from '../src/kernel/workbench.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture（workbench-pro.test.ts 同式精简）

function testImage(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      rgba[p] = y < h / 2 ? 200 : 40;
      rgba[p + 1] = 40;
      rgba[p + 2] = 40;
      rgba[p + 3] = 255;
    }
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

const CANVAS_CM = { w: 10, h: 10 } as const;
const IMAGE_PX = { width: 96, height: 96 } as const;

function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

/** 三节点树：n-root → n-person（worthy 中间产块）→ n-hat 叶（bbox x30 y4 w30 h20）。 */
function workbenchTree(): ObjectTree {
  const hat: ObjectNode = {
    id: 'n-hat',
    objectName: '帽子',
    category: 'hat',
    mask: solidMask(30, 20),
    bbox: { x: 30, y: 4, w: 30, h: 20 },
    parent: 'n-person',
    children: [],
    effectiveMm: 24.5,
    labVariance: 8,
    drillWorthy: true,
    origin: 'vlm+sam3',
  };
  const person: ObjectNode = {
    id: 'n-person',
    objectName: '主体',
    category: 'person',
    mask: solidMask(70, 66),
    bbox: { x: 10, y: 8, w: 70, h: 66 },
    parent: 'n-root',
    children: [hat.id],
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
    nodes: [root, person, hat],
    createdAt: '2026-09-26T00:00:00.000Z',
  });
}

interface Fixture {
  s: TestServices;
  taskId: string;
  imageBlobRef: string;
  treeBlobRef: string;
  workbench: TaskWorkbench;
  plantPlan(assignments: StrategyPlan['assignments']): string;
  seedStone(): void;
  rowState(nodeId: string): string | undefined;
  treeOf(blobRef: string): ObjectTree;
}

function setup(tree: ObjectTree = workbenchTree()): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'workbench-pro-2b 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
  const workbench = new TaskWorkbench({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    engineLayout: strategyEngineDelegate,
  });
  const taskId = task.id;
  return {
    s,
    taskId,
    imageBlobRef,
    treeBlobRef,
    workbench,
    plantPlan: (assignments) => {
      const plan = StrategyPlanSchema.parse({
        kind: 'strategy-plan',
        formatVersion: 1,
        objectTreeRef: treeBlobRef,
        assignments,
        createdAt: '2026-09-26T00:00:00.000Z',
      });
      return s.blobs.put(Buffer.from(JSON.stringify(plan), 'utf8')).hash;
    },
    seedStone: () => {
      const stones = new StoneService({ db: s.db, blobs: s.blobs });
      const rgba = new Uint8Array(128 * 128 * 4).fill(255);
      stones.createStone({
        ownerId: s.anonymous.id,
        supplierProfile: {
          id: 'sup-yuhang',
          supplier: 'yuhang',
          displayName: '钰航',
          bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { J: 2, A: 3 } }],
          styleKey: 'row',
        },
        draft: {
          name: 'A52 钻',
          sku: 'A52',
          sizeMm: 3,
          color: { name: '红', rgb: [200, 40, 40], family: '红色系', finish: 'glossy' },
          texture: { declaredWidth: 128, declaredHeight: 128 },
        },
        textureBytes: new Uint8Array(encodePng(128, 128, rgba)),
      });
    },
    rowState: (nodeId) => maskEditStatusesOf(s.db, taskId).find((row) => row.nodeId === nodeId)?.state,
    treeOf: (blobRef) =>
      ObjectTreeSchema.parse(JSON.parse(s.blobs.read(blobRef)!.toString('utf8'))),
  };
}

/** 标准重算 patch 输入（n-hat+texture-fill 指派）。 */
function patchInput(f: Fixture, planBlobRef: string, treeRef: string, ops: Array<{ op: 'add' | 'remove'; radiusPx: number; points: Array<{ x: number; y: number }> }>) {
  return {
    taskId: f.taskId,
    actorId: 'u1',
    imageBlobRef: f.imageBlobRef,
    currentTreeBlobRef: treeRef,
    currentViewStateBlobRef: null,
    planBlobRef,
    nodeId: 'n-hat',
    ops,
    expectedTreeBlobRef: treeRef,
    recomputeStrategy: true,
  };
}

function hatAssignmentPlanRef(f: Fixture): string {
  return f.plantPlan([
    {
      nodeId: 'n-hat',
      strategyKind: 'texture-fill' as const,
      params: { mode: 'scatter' },
      stones: [{ resourceId: 'r1', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }],
      densityPerCm2: 2,
      rationale: 'agent',
    },
  ]);
}

// ---------------------------------------------------------------- [1] 重算路径：accepted → recomputing → ready

describe('P0-2 状态机运行路径：accepted → recomputing → ready', () => {
  it('patch 同步段写 accepted（响应即返+gems 后置）→微任务作业置 recomputing→flush 后 ready', async () => {
    const f = setup();
    f.seedStone();
    const planRef = hatAssignmentPlanRef(f);

    const out = f.workbench.layerMaskPatch(patchInput(f, planRef, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    // 同步段：CAS 过门+光栅化+版本入史+行=accepted；响应即返（重算后置——不阻塞调用方）
    expect(out.editState).toBe('accepted');
    expect(out.gems).toBeNull();
    expect(f.rowState('n-hat')).toBe('accepted');

    // 作业第一阶段（微任务）：置 recomputing——两级微任务之间可观测
    await Promise.resolve();
    expect(f.rowState('n-hat')).toBe('recomputing');

    // 作业第二阶段：reexecutePlan 收敛重算→终态 ready（gems 经帧流后置发布）
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowState('n-hat')).toBe('ready');
    f.s.dispose();
  });

  it('无重算面（recomputeStrategy 缺省）：同步直达 ready（纯 mask 面——不进异步作业）', async () => {
    const f = setup();
    const out = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat', ops: [{ op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.editState).toBe('ready');
    expect(f.rowState('n-hat')).toBe('ready');
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowState('n-hat')).toBe('ready');
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [2] 树版本漂移检测 → stale

describe('P0-2 树版本漂移检测：重算在途时树被推进 → stale', () => {
  it('作业挂起（accepted）时 rename 落新版本 → 行 stale；作业条件更新不覆盖；门阻断', async () => {
    const f = setup();
    f.seedStone();
    const planRef = hatAssignmentPlanRef(f);
    const patched = f.workbench.layerMaskPatch(patchInput(f, planRef, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    expect(f.rowState('n-hat')).toBe('accepted');

    // 树推进（cause=rename≠mask-patch）：未终态编辑（accepted/recomputing）→stale
    f.workbench.renameNode({
      taskId: f.taskId, actorId: 'u2', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: patched.treeBlobRef, nodeId: 'n-hat', objectName: '贝雷帽',
    });
    expect(f.rowState('n-hat')).toBe('stale');

    // 作业跑完也不得把 stale 覆盖成 ready（条件更新：仅 recomputing 态推进终态）
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowState('n-hat')).toBe('stale');
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId)).allowed).toBe(false);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [3] 重算失败 → error + retry 重放

describe('P0-2 重算失败 error + retryMaskEditRecompute（stale/error 重放清除入口）', () => {
  it('作业重算失败（plan 不可读）→行 error 不上抛；retry 带正确 plan →收敛回 ready', async () => {
    const f = setup();
    f.seedStone();
    const planRef = hatAssignmentPlanRef(f);
    const patched = f.workbench.layerMaskPatch(patchInput(f, 'f'.repeat(64), f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    expect(patched.editState).toBe('accepted');

    await f.workbench.flushMaskRecomputeJobs();
    const row = maskEditStatusesOf(f.s.db, f.taskId).find((r) => r.nodeId === 'n-hat')!;
    expect(row.state).toBe('error');
    expect(row.error).toContain('plan');

    // stale/error 重放入口：基于电流树+正确 plan 重算 → ready（异步路径无调用方——同步收敛）
    const retried = f.workbench.retryMaskEditRecompute({
      taskId: f.taskId, nodeId: 'n-hat', actorId: 'u1',
      imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: patched.treeBlobRef,
      planBlobRef: planRef,
    });
    expect(retried.state).toBe('ready');
    expect(f.rowState('n-hat')).toBe('ready');
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId)).allowed).toBe(true);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [4] 放弃清除入口

describe('P0-2 discardMaskEdit（放弃清除——mask 已落盘如实，仅清告警留痕）', () => {
  it('stale 行 → discard 删行+导出门放行', async () => {
    const f = setup();
    f.seedStone();
    const planRef = hatAssignmentPlanRef(f);
    const patched = f.workbench.layerMaskPatch(patchInput(f, planRef, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    f.workbench.renameNode({
      taskId: f.taskId, actorId: 'u2', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: patched.treeBlobRef, nodeId: 'n-hat', objectName: '贝雷帽',
    });
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowState('n-hat')).toBe('stale');

    f.workbench.discardMaskEdit({ taskId: f.taskId, nodeId: 'n-hat' });
    expect(maskEditStatusesOf(f.s.db, f.taskId)).toHaveLength(0);
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId)).allowed).toBe(true);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [5] P1-2 折线光栅化（圆盘沿折线扫掠）

describe('P1-2 折线笔刷光栅化：相邻点线段插值（步长≤半径/2）', () => {
  it('大间距两点 remove（间距 18px >> 2r=8px）：中点必须被清除——旧逐点盖圆留缝', () => {
    const f = setup();
    // n-hat bbox (30,4,30,20)→局部 (8,10)/(26,10)，中点 (17,10) 距两端 9px>r=4
    const out = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'remove', radiusPx: 4, points: [{ x: 38, y: 14 }, { x: 56, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    });
    const tree = f.treeOf(out.treeBlobRef);
    const hat = tree.nodes.find((n) => n.id === 'n-hat')!;
    if (hat.mask.kind !== 'inline') throw new Error('P1-2 测试预期 inline 态掩码');
    const bits = decodeInlineMask(hat.mask);
    const midX = 47 - hat.bbox.x; // 中点画布 (47,14) → 新 bbox 局部
    const midY = 14 - hat.bbox.y;
    expect(bits.bits[midY * bits.w + midX]).toBe(0);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [6] 2.6-4 拆层子名提取（hint 正则）

describe('2.6-4 拆层子名提取：hint 正则提取核心名词（/把(.+?)拆/ 优先，回退原 hint）', () => {
  it('hint「把帽子拆出来」→ 子层名「帽子」（非整句 hint）；无匹配回退原 hint', async () => {
    const { SamBridge, MockSamTransport } = await import('../src/kernel/vision/sam-bridge.js');
    const { segmentOne } = await import('../src/kernel/vision/segment-one.js');
    const s = createServices(undefined, { imgDryRun: true });
    const imageBlobRef = s.blobs.put(testImage()).hash;
    const { sessionId } = s.sessions.create(s.anonymous, { title: '拆层子名测试' });
    const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
    const transport = new MockSamTransport();
    const bridge = new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport });
    const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, workbenchTree()).treeBlobRef;

    const ellipse = new Uint8Array(96 * 96);
    for (let y = 0; y < 96; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const dx = x - 48;
        const dy = y - 48;
        if (dx * dx + dy * dy <= 20 * 20) ellipse[y * 96 + x] = 1;
      }
    }
    transport.respond(() => ({
      kind: 'segment' as const,
      mask: encodeInlineMask(96, 96, ellipse),
      score: 0.8,
      meta: { model: 'mock', durationMs: 1, iteration: 0 },
    }));

    const outcome = await segmentOne(
      { db: s.db, blobs: s.blobs, jobs: s.jobs, bridge },
      { taskId: task.id, imageBlobRef, treeBlobRef, nodeId: 'n-person', hint: '把帽子拆出来' },
    );
    expect(outcome.children).toHaveLength(1);
    expect(outcome.children[0]!.objectName).toBe('帽子');
    s.dispose();
  });
});
