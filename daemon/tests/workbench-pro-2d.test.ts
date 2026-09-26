/**
 * [2026-09-27] workbench-pro 波 2d 终验红段（Codex 2bfix+2c 合并复评 6.6/10 NO-GO
 * 的阻塞项固化——红→绿两段式）：
 *   [1] P0-2 同节点代次竞态（复评阻塞项 #1/建议 #1）：mask_edit_states 以
 *       (task_id,node_id) 单行主键、异步推进只按 state 条件——A/B 连续 patch 同
 *       节点时 A 旧作业可把 B 的 accepted 行推进收敛（B 新编辑被旧作业结果错配），
 *       B 自己的作业反被跳过；retry/discard 与新 patch 交错同理。绿段=全部 UPDATE
 *       带 base_version 作业 token（代次条件——旧代次作业必作废）。
 *   [2] 插值资源上限（复评 P1-2/建议 #2）：坐标 0..imagePx 界内+段长上限+单笔
 *       插值步数上限+涂写工作量预算——超限 typed 拒 mask-invalid，
 *       Number.MAX_VALUE 级坐标不再进入无界循环。
 * 内核级（TaskWorkbench 直调）。零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  StrategyPlanSchema,
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
import { TaskWorkbench, TaskWorkbenchError, exportGateOf, maskEditStatusesOf } from '../src/kernel/workbench.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture（workbench-pro-2b.test.ts 同式）

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
}

function setup(tree: ObjectTree = workbenchTree()): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'workbench-pro-2d 测试' });
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
  };
}

function patchInput(
  f: Fixture,
  planBlobRef: string | null,
  treeRef: string,
  ops: Array<{ op: 'add' | 'remove'; radiusPx: number; points: Array<{ x: number; y: number }> }>,
) {
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

/** typed 断言助手：断 kind 并返回错误对象供进一步字段断言。 */
function expectKind(fn: () => unknown, kind: string): TaskWorkbenchError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TaskWorkbenchError);
    const err = e as TaskWorkbenchError;
    expect(err.kind).toBe(kind);
    return err;
  }
  throw new Error(`应抛 ${kind} 但未抛`);
}

const BAD_PLAN = 'f'.repeat(64); // 不可读 blob → 重算作业必 error（复评 2b 测试 [3] 同式）

// ------------------------------------------------- [1] P0-2 同节点代次竞态（Codex 建议一）

describe('P0-2 同节点代次竞态：base_version 作业 token（旧代次作业必作废）', () => {
  it('A/B 连续 patch 同节点：A 旧作业不得收敛 B 新编辑；B 新作业必须执行（终态=B 的重算结果）', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);

    // A：坏 plan（旧代次——若 A 的作业收敛 B 行，终态必 error）
    f.workbench.layerMaskPatch(patchInput(f, BAD_PLAN, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    expect(f.rowState('n-hat')).toBe('accepted');

    // B：微任务执行前同节点再 patch（新代次覆盖同一行——upsert 后行 base_version=vB）
    const b = f.workbench.layerMaskPatch(patchInput(f, goodPlan, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 46, y: 15 }] },
    ]));
    expect(b.editState).toBe('accepted');
    expect(f.rowState('n-hat')).toBe('accepted');

    // 作业收敛：A 旧作业必须作废（token 漂移）；B 新作业必须执行 → 终态 ready
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowState('n-hat')).toBe('ready');
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId)).allowed).toBe(true);
    f.s.dispose();
  });

  it('A/B 交错于第一级微任务之后（行已 recomputing 时 B 落新 patch）：A 不得在旧基线树上执行重算副作用', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);

    // A 落 patch → 推进第一级微任务（行=recomputing·token=vA）
    f.workbench.layerMaskPatch(patchInput(f, BAD_PLAN, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    await Promise.resolve();
    expect(f.rowState('n-hat')).toBe('recomputing');

    // B 落新 patch（upsert 覆盖行 → accepted·token=vB；A 的 recomputing 语义作废）
    f.workbench.layerMaskPatch(patchInput(f, goodPlan, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 46, y: 15 }] },
    ]));

    await f.workbench.flushMaskRecomputeJobs();
    // A 旧作业（坏 plan）不得把 B 行收敛成 error；B 作业执行 → ready
    expect(f.rowState('n-hat')).toBe('ready');
    f.s.dispose();
  });

  it('retry 重放后新 patch 交错：retry 的代次不得吃掉 B 新编辑的重算（终态=B 的 error）', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);

    // A：好 plan → accepted（作业 A 在途）
    const a = f.workbench.layerMaskPatch(patchInput(f, goodPlan, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    expect(a.editState).toBe('accepted');

    // 树推进（rename≠mask-patch）→ 行 stale；retry 基于新基线同步重放 → ready
    const renamed = f.workbench.renameNode({
      taskId: f.taskId, actorId: 'u2', imageBlobRef: f.imageBlobRef,
      treeBlobRef: a.treeBlobRef, nodeId: 'n-hat', objectName: '贝雷帽',
    });
    expect(f.rowState('n-hat')).toBe('stale');
    const treeAfterRename = renamed.treeBlobRef;
    const retried = f.workbench.retryMaskEditRecompute({
      taskId: f.taskId, nodeId: 'n-hat',
      imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: treeAfterRename,
      planBlobRef: goodPlan,
    });
    expect(retried.state).toBe('ready');

    // B：坏 plan 新 patch（新代次）→ A/retry 的旧代次作业不得收敛它；B 作业执行 → error
    f.workbench.layerMaskPatch(patchInput(f, BAD_PLAN, treeAfterRename, [
      { op: 'add', radiusPx: 3, points: [{ x: 46, y: 15 }] },
    ]));
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowState('n-hat')).toBe('error');
    f.s.dispose();
  });

  it('discard 清行后新 patch 交错：被弃编辑的旧作业不得收敛新行（终态=B 的 ready）', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);

    // A：坏 plan → accepted → 用户放弃（discard 删行）
    f.workbench.layerMaskPatch(patchInput(f, BAD_PLAN, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
    ]));
    f.workbench.discardMaskEdit({ taskId: f.taskId, nodeId: 'n-hat' });

    // B：好 plan 新 patch（新行新代次）
    f.workbench.layerMaskPatch(patchInput(f, goodPlan, f.treeBlobRef, [
      { op: 'add', radiusPx: 3, points: [{ x: 46, y: 15 }] },
    ]));

    await f.workbench.flushMaskRecomputeJobs();
    // A 旧作业（坏 plan）不得收敛 B 行；B 作业执行 → ready
    expect(f.rowState('n-hat')).toBe('ready');
    f.s.dispose();
  });
});

// ------------------------------------------------- [2] 插值资源上限（Codex 建议二）

describe('插值资源上限：坐标界内+段长+步数+工作量预算（超限 typed 拒 mask-invalid）', () => {
  it('坐标超出 imagePx 界（x=200 > 96）→ mask-invalid 拒（bbox 外无效——不静默裁剪）', () => {
    const f = setup();
    expectKind(() => f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 4, points: [{ x: 200, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    }), 'mask-invalid');
    f.s.dispose();
  });

  it('坐标 y 超界（y=9999 > 96）→ mask-invalid 拒', () => {
    const f = setup();
    expectKind(() => f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 4, points: [{ x: 45, y: 9999 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    }), 'mask-invalid');
    f.s.dispose();
  });

  it('大跨度段拒（两点相距 ~10000px——zod 绝对界内但画布界外/段长远超语义）→ mask-invalid 拒', () => {
    const f = setup();
    // x=10004 在契约绝对上界 65536 内（zod 放行——区别于 invalid-input 面），
    // 但超画布 96px 界且段长 10000px 远超任何合法笔画——daemon 侧 mask-invalid 拒
    expectKind(() => f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 8, points: [{ x: 4, y: 48 }, { x: 10004, y: 48 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    }), 'mask-invalid');
    f.s.dispose();
  });

  it('单笔插值步数超上限（界内 68 点往返折线 Σ≈16.7k 步 > 16k）→ mask-invalid 拒（CPU 有界）', () => {
    const f = setup();
    // 96×96 界内往返折线（半径 0.6→步长 0.5）：每段 ~124.5px→249 步；67 段 Σ≈16.7k
    // > WORKBENCH_BRUSH_STROKE_STEPS_MAX(16384)——坐标/段长均合法，纯步数超限
    const points = Array.from({ length: 68 }, (_, i) => (i % 2 === 0 ? { x: 4, y: 4 } : { x: 92, y: 92 }));
    expectKind(() => f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 0.6, points }],
      expectedTreeBlobRef: f.treeBlobRef,
    }), 'mask-invalid');
    f.s.dispose();
  });

  it('涂写工作量超预算（大半径长笔画 ~9M px 涂写）→ mask-invalid 拒', () => {
    const f = setup();
    // 500 点×半径 100 在 96×96 位面上扫掠：~1000 次 stamp×~9216px/次 ≈ 9.2M px > 4M 预算
    const points = Array.from({ length: 500 }, (_, i) => ({ x: 8 + (i % 80), y: 8 + Math.floor(i / 80) * 12 }));
    expectKind(() => f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-root',
      ops: [{ op: 'add', radiusPx: 100, points }],
      expectedTreeBlobRef: f.treeBlobRef,
    }), 'mask-invalid');
    f.s.dispose();
  });

  it('界内合法笔迹不受影响（回归护栏：常用坐标/段长正常落盘）', () => {
    const f = setup();
    const out = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 3, points: [{ x: 40, y: 10 }, { x: 50, y: 18 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.editState).toBe('ready');
    f.s.dispose();
  });
});
