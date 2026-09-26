/**
 * workbench-pro 波 2a 测试（契约行为冻结——Codex 二轮 CONDITIONAL-GO 放行条件）：
 * layer.reorder / layer.delete / layer.mask.patch 三写 RPC 真身 + view.state.set +
 * mask 编辑状态机/导出门。内核级（TaskWorkbench 直调）。
 * 覆盖：
 *   [1] reorder：父变更+序位+同父重排+cause 入史；cycle/parent-invalid/
 *       root-protected/index 越界/CAS 漂移（携带电流指针）/锁定 全 typed 拒。
 *   [2] delete：子树全集+父收口+指派收敛（removedAssignmentNodeIds+gems 重算）；
 *       根保护/锁定（含子树内锁定）/CAS/node-not-found 拒；mask 留痕随删清理；
 *       跨存储原子性（P0-3——重算/版本/清理三注入失败均不发布新树：无
 *       「新树已生效、历史缺失」半状态）。
 *   [3] mask.patch：笔迹光栅化（remove 收缩→tightBBox/effectiveMm 重算）+ready 入痕；
 *       空掩码拒；recomputeStrategy 重算闭环；4096 行程超限=incomplete+门阻断；
 *       锁定/CAS/node-not-found 拒。
 *   [4] view.state.set：revision 单调链+previousBlobRef 回溯+帧登记；CAS 门
 *       （缺省仅首写/错值必拒）；重复节点拒；幽灵节点拒（P0-2——未知/已删
 *       nodeId 不在当前树必拒 view-state-invalid，内核+RPC 级）。
 *   [5] exportGate：干净放行 / incomplete / stale / error 三阻断（纯函数+端到端）。
 *   [6] RPC 面：layer.reorder/view.state.set/task.detail 扩面走通+cas 载荷断言。
 *   [7] task.export 导出门真实接线（Codex 2a 复核 P0-1）：服务端重算门——
 *       incomplete（真实笔迹超限）/stale/error（状态行留痕）三态 RPC 级
 *       export-blocked 拒（完整 blockers）+ready 放行（gems 工件字节回放）。
 * 零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  encodeInlineMask,
  SceneAnalysisSchema,
  StrategyPlanSchema,
  type CanvasCm,
  type ImagePx,
  type ObjectNode,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import { HandicraftKernel, strategyEngineDelegate } from '../src/kernel/index.js';
import { SCENE_ANALYSIS_ARTIFACT_NAME } from '../src/kernel/vision/scene-analyze.js';
import { StoneService } from '../src/stones/service.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import {
  TaskWorkbench,
  TaskWorkbenchError,
  exportGateOf,
  maskEditStatusesOf,
} from '../src/kernel/workbench.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

function testImage(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = y < h / 2 ? 200 : 40;
      rgba[p + 1] = 40;
      rgba[p + 2] = y < h / 2 ? 40 : 200;
      rgba[p + 3] = 255;
    }
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

const CANVAS_CM: CanvasCm = { w: 10, h: 10 };
const IMAGE_PX: ImagePx = { width: 96, height: 96 };

function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

/** 三节点树：n-root 画布 → n-person 主体（worthy 中间产块）→ n-hat 叶。 */
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

/** 单节点 96×96 棋盘格树（RLE 行程 ~9121 > 4096——incomplete 门端到端素材）。 */
function checkerboardTree(): ObjectTree {
  const w = 96;
  const h = 96;
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) bits[y * w + x] = (x + y) % 2;
  }
  const node: ObjectNode = {
    id: 'n-grid',
    objectName: '棋盘格',
    category: 'test',
    mask: encodeInlineMask(w, h, bits),
    bbox: { x: 0, y: 0, w, h },
    parent: null,
    children: [],
    effectiveMm: 96,
    labVariance: 0,
    drillWorthy: true,
    origin: 'vlm+sam3',
  };
  return ObjectTreeSchema.parse({
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    nodes: [node],
    createdAt: '2026-09-26T00:00:00.000Z',
  });
}

const YUHANG_PROFILE: Parameters<StoneService['createStone']>[0]['supplierProfile'] = {
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { J: 2, A: 3 } }],
  styleKey: 'row',
};

interface Fixture {
  s: TestServices;
  taskId: string;
  imageBlobRef: string;
  treeBlobRef: string;
  workbench: TaskWorkbench;
  /** 最新视图态工件引用（view.state.set 后帧流 latest）。 */
  latestViewStateRef(): string | null;
  /** 最新树工件引用（帧流 latest-by-name object-tree.json——「电流树指针」发布断言锚）。 */
  latestTreeRef(): string | null;
  plantPlan(assignments: StrategyPlan['assignments']): string;
  seedStone(): void;
}

function setup(tree: ObjectTree = workbenchTree()): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'workbench-pro 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
  const workbench = new TaskWorkbench({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    engineLayout: strategyEngineDelegate,
  });
  const taskId = task.id;
  const artifactRef = (name: string): string | null => {
    const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const fr = frames[i]!;
      if (fr.kind !== 'artifact') continue;
      const payload = fr.payload as { name?: unknown; blobRef?: unknown };
      if (payload.name === name && typeof payload.blobRef === 'string') return payload.blobRef;
    }
    return null;
  };
  return {
    s,
    taskId,
    imageBlobRef,
    treeBlobRef,
    workbench,
    latestViewStateRef: () => artifactRef('workbench-view-state.json'),
    latestTreeRef: () => artifactRef('object-tree.json'),
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
        supplierProfile: YUHANG_PROFILE,
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
  };
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

/**
 * 存储边界注入失败面（P0-3——不改产线代码）：代理 db，prepare 命中 failSql 片段
 * 即抛（重放「版本写入失败/状态清理失败」类跨存储步骤故障）。
 */
function failingPrepareDb(db: TestServices['db'], failSql: string): TestServices['db'] {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes(failSql)) throw new Error(`注入失败：${failSql}`);
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------------------------------------------------------------- [1] layer.reorder

describe('layerReorder', () => {
  it('父变更+序位：n-hat → n-root 第 0 位；version 入史 cause=reorder；同父重排合法', () => {
    const f = setup();
    const out = f.workbench.layerReorder({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null,
      nodeId: 'n-hat', newParentId: 'n-root', index: 0, expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.version).toBe(1);
    const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(out.treeBlobRef)!.toString('utf8')));
    expect(tree.nodes.find((n) => n.id === 'n-root')!.children).toEqual(['n-hat', 'n-person']);
    expect(tree.nodes.find((n) => n.id === 'n-hat')!.parent).toBe('n-root');
    expect(f.workbench.treeHistory(f.taskId).versions[0]!.cause).toBe('reorder');

    // 同父重排（n-person 在 n-root 内移到第 1 位——children 已含先前的 n-hat）
    const same = f.workbench.layerReorder({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: out.treeBlobRef, currentViewStateBlobRef: null,
      nodeId: 'n-person', newParentId: 'n-root', index: 1, expectedTreeBlobRef: out.treeBlobRef,
    });
    const tree2 = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(same.treeBlobRef)!.toString('utf8')));
    expect(tree2.nodes.find((n) => n.id === 'n-root')!.children).toEqual(['n-hat', 'n-person']);
    expect(same.version).toBe(2);
    f.s.dispose();
  });

  it('typed 拒面：cycle（新父=自身/子树内）/parent-invalid/root-protected/index 越界/node-not-found', () => {
    const f = setup();
    const base = {
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null,
      expectedTreeBlobRef: f.treeBlobRef,
    };
    expectKind(() => f.workbench.layerReorder({ ...base, nodeId: 'n-person', newParentId: 'n-hat', index: 0 }), 'cycle');
    expectKind(() => f.workbench.layerReorder({ ...base, nodeId: 'n-person', newParentId: 'n-person', index: 0 }), 'cycle');
    expectKind(() => f.workbench.layerReorder({ ...base, nodeId: 'n-hat', newParentId: 'n-missing', index: 0 }), 'parent-invalid');
    expectKind(() => f.workbench.layerReorder({ ...base, nodeId: 'n-root', newParentId: 'n-person', index: 0 }), 'root-protected');
    expectKind(() => f.workbench.layerReorder({ ...base, nodeId: 'n-hat', newParentId: 'n-root', index: 5 }), 'invalid-input');
    expectKind(() => f.workbench.layerReorder({ ...base, nodeId: 'n-missing', newParentId: 'n-root', index: 0 }), 'node-not-found');
    f.s.dispose();
  });

  it('CAS 漂移必拒：错误面携带 currentTreeBlobRef；成功后同基线重试=已生效判别', () => {
    const f = setup();
    const err = expectKind(() => f.workbench.layerReorder({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null,
      nodeId: 'n-hat', newParentId: 'n-root', index: 0, expectedTreeBlobRef: 'f'.repeat(64),
    }), 'cas-mismatch');
    expect(err.currentTreeBlobRef).toBe(f.treeBlobRef);
    // 成功后同基线重试：必拒（无重复副作用）且电流指针=自己上次响应（「已生效」可判别）
    const out = f.workbench.layerReorder({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null,
      nodeId: 'n-hat', newParentId: 'n-root', index: 0, expectedTreeBlobRef: f.treeBlobRef,
    });
    const retry = expectKind(() => f.workbench.layerReorder({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: out.treeBlobRef, currentViewStateBlobRef: null,
      nodeId: 'n-hat', newParentId: 'n-root', index: 0, expectedTreeBlobRef: f.treeBlobRef,
    }), 'cas-mismatch');
    expect(retry.currentTreeBlobRef).toBe(out.treeBlobRef);
    f.s.dispose();
  });

  it('锁定节点拒；移动锁定节点的祖先放行（子树完整搬运≠编辑锁定节点本体）', () => {
    const f = setup();
    f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef,
      nodes: [{ nodeId: 'n-hat', locked: true }],
    });
    const viewRef = f.latestViewStateRef()!;
    expectKind(() => f.workbench.layerReorder({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: viewRef,
      nodeId: 'n-hat', newParentId: 'n-root', index: 0, expectedTreeBlobRef: f.treeBlobRef,
    }), 'node-locked');
    const out = f.workbench.layerReorder({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: viewRef,
      nodeId: 'n-person', newParentId: 'n-root', index: 0, expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.version).toBeGreaterThan(0);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [2] layer.delete

describe('layerDelete', () => {
  it('删叶：子树全集+父收口+无 plan→gems null；cause=delete 入史', () => {
    const f = setup();
    const out = f.workbench.layerDelete({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat', expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.removedNodeIds).toEqual(['n-hat']);
    expect(out.removedAssignmentNodeIds).toEqual([]);
    expect(out.gems).toBeNull();
    const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(out.treeBlobRef)!.toString('utf8')));
    expect(tree.nodes.map((n) => n.id).sort()).toEqual(['n-person', 'n-root']);
    expect(tree.nodes.find((n) => n.id === 'n-person')!.children).toEqual([]);
    expect(f.workbench.treeHistory(f.taskId).versions[0]!.cause).toBe('delete');
    f.s.dispose();
  });

  it('指派收敛：删被指派叶→removedAssignmentNodeIds+gems 重算（execute 真身+plan 帧收敛）', () => {
    const f = setup();
    f.seedStone();
    const planRef = f.plantPlan([
      { nodeId: 'n-person', strategyKind: 'exclusion', params: { reason: '留白' }, stones: [], densityPerCm2: 2.3, rationale: 'agent' },
      {
        nodeId: 'n-hat', strategyKind: 'texture-fill', params: { mode: 'scatter' },
        stones: [{ resourceId: 'r1', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }],
        densityPerCm2: 2, rationale: 'agent',
      },
    ]);
    const out = f.workbench.layerDelete({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: planRef,
      nodeId: 'n-hat', expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.removedAssignmentNodeIds).toEqual(['n-hat']);
    expect(out.gems).not.toBeNull();
    const frames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames.filter(
      (fr) => fr.kind === 'artifact' && (fr.payload as { name: string }).name === 'strategy-plan.json',
    );
    const latest = frames[frames.length - 1]!.payload as { blobRef: string };
    const plan = StrategyPlanSchema.parse(JSON.parse(f.s.blobs.read(latest.blobRef)!.toString('utf8')));
    expect(plan.assignments.map((a) => a.nodeId)).toEqual(['n-person']); // 收敛面
    f.s.dispose();
  });

  it('typed 拒面：根保护/锁定（子树内锁定也拒）/CAS/node-not-found；mask 留痕随删清理', () => {
    const f = setup();
    const base = {
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      expectedTreeBlobRef: f.treeBlobRef,
    };
    expectKind(() => f.workbench.layerDelete({ ...base, nodeId: 'n-root' }), 'root-protected');
    expectKind(() => f.workbench.layerDelete({ ...base, nodeId: 'n-missing' }), 'node-not-found');
    expectKind(() => f.workbench.layerDelete({ ...base, expectedTreeBlobRef: 'e'.repeat(64), nodeId: 'n-hat' }), 'cas-mismatch');

    // 锁定 n-hat：删本体/删含它的祖先（n-person）均拒
    const locked = f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef,
      nodes: [{ nodeId: 'n-hat', locked: true }],
    });
    const viewRef = f.latestViewStateRef()!;
    expectKind(() => f.workbench.layerDelete({
      ...base, currentViewStateBlobRef: viewRef, nodeId: 'n-person',
    }), 'node-locked');
    expectKind(() => f.workbench.layerDelete({
      ...base, currentViewStateBlobRef: viewRef, nodeId: 'n-hat',
    }), 'node-locked');

    // 解锁 → mask 编辑留痕 → 删节点 → 幽灵行清理
    f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: viewRef, currentTreeBlobRef: f.treeBlobRef,
      nodes: [], expectedRevision: locked.revision,
    });
    const viewRef2 = f.latestViewStateRef()!;
    const patched = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: viewRef2, planBlobRef: null,
      nodeId: 'n-hat', ops: [{ op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(patched.editState).toBe('ready');
    expect(maskEditStatusesOf(f.s.db, f.taskId)).toHaveLength(1);
    const deleted = f.workbench.layerDelete({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: patched.treeBlobRef, currentViewStateBlobRef: viewRef2, planBlobRef: null,
      nodeId: 'n-hat', expectedTreeBlobRef: patched.treeBlobRef,
    });
    expect(deleted.removedNodeIds).toEqual(['n-hat']);
    expect(maskEditStatusesOf(f.s.db, f.taskId)).toEqual([]);
    f.s.dispose();
  });
});

// ------------------------------------------------- [2b] layer.delete 跨存储原子性（Codex 2a 复核 P0-3）

describe('layerDelete 原子性：可失败步骤先行、发布收尾（无「新树已生效、历史缺失」半状态）', () => {
  it('重算失败无半状态：收敛重算抛 internal → 新树不发布+版本不入史（电流树不推进）', () => {
    const f = setup();
    // 帧流基线（产线同款：object-tree 帧=「电流树」指针——发布断言锚）
    f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: f.treeBlobRef, name: 'object-tree.json' });
    // plan：n-hat（被删指派——触发收敛）+ n-root（非产块节点——重算必败 execute-failed）
    const planRef = f.plantPlan([
      { nodeId: 'n-hat', strategyKind: 'exclusion', params: { reason: '留白' }, stones: [], densityPerCm2: 2.3, rationale: 'agent' },
      { nodeId: 'n-root', strategyKind: 'exclusion', params: { reason: '画布' }, stones: [], densityPerCm2: 2.3, rationale: 'agent' },
    ]);
    expectKind(() => f.workbench.layerDelete({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: planRef,
      nodeId: 'n-hat', expectedTreeBlobRef: f.treeBlobRef,
    }), 'internal');
    // 半状态断言：帧流电流树指针未推进+版本链无 delete 行（重试无「已发布旧工件 vs 旧状态」分裂）
    expect(f.latestTreeRef()).toBe(f.treeBlobRef);
    expect(f.workbench.treeHistory(f.taskId).versions).toEqual([]);
    f.s.dispose();
  });

  it('版本写入失败无半状态：tree_versions 插入失败 → 新树不发布（历史先行于发布）', () => {
    const f = setup();
    f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: f.treeBlobRef, name: 'object-tree.json' });
    const failing = new TaskWorkbench({
      db: failingPrepareDb(f.s.db, 'INSERT INTO tree_versions'),
      blobs: f.s.blobs,
      jobs: f.s.jobs,
    });
    expect(() => failing.layerDelete({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat', expectedTreeBlobRef: f.treeBlobRef,
    })).toThrow(/注入失败：INSERT INTO tree_versions/);
    expect(f.latestTreeRef()).toBe(f.treeBlobRef);
    expect(f.workbench.treeHistory(f.taskId).versions).toEqual([]);
    f.s.dispose();
  });

  it('状态清理失败无半状态：mask_edit_states 清理失败 → 新树不发布（电流树不推进）', () => {
    const f = setup();
    // 先留痕 n-hat 的 mask 编辑状态（删除时的清理目标）
    const patched = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat', ops: [{ op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(maskEditStatusesOf(f.s.db, f.taskId)).toHaveLength(1);
    const failing = new TaskWorkbench({
      db: failingPrepareDb(f.s.db, 'DELETE FROM mask_edit_states'),
      blobs: f.s.blobs,
      jobs: f.s.jobs,
    });
    expect(() => failing.layerDelete({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: patched.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat', expectedTreeBlobRef: patched.treeBlobRef,
    })).toThrow(/注入失败：DELETE FROM mask_edit_states/);
    // 半状态断言：电流树指针停留在删除前基线（版本/清理收口完成前不发布）
    expect(f.latestTreeRef()).toBe(patched.treeBlobRef);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [3] layer.mask.patch

describe('layerMaskPatch', () => {
  it('remove 收缩：tightBBox 重锚+effectiveMm 重算+ready 入痕+cause=mask-patch；mask 随 bbox 重锚', () => {
    const f = setup();
    const before = workbenchTree().nodes.find((n) => n.id === 'n-hat')!;
    const out = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'remove', radiusPx: 20, points: [{ x: 60, y: 14 }] }], // 清右半
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.editState).toBe('ready');
    expect(out.incomplete).toBe(false);
    expect(out.node.bbox.x).toBe(before.bbox.x); // 左缘保留
    expect(out.node.bbox.w).toBeLessThan(before.bbox.w); // 右侧收缩
    expect(out.node.effectiveMm).toBeLessThan(before.effectiveMm);
    expect(out.gems).toBeNull(); // recomputeStrategy 缺省 false
    expect(f.workbench.treeHistory(f.taskId).versions[0]!.cause).toBe('mask-patch');
    expect(maskEditStatusesOf(f.s.db, f.taskId)).toEqual([
      expect.objectContaining({ nodeId: 'n-hat', state: 'ready', incomplete: false, baseVersion: out.version }),
    ]);
    const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(out.treeBlobRef)!.toString('utf8')));
    const node = tree.nodes.find((n) => n.id === 'n-hat')!;
    expect(node.bbox).toEqual(out.node.bbox);
    expect(node.effectiveMm).toBeCloseTo(out.node.effectiveMm, 10);
    expect(node.mask.w).toBe(out.node.bbox.w);
    expect(node.mask.h).toBe(out.node.bbox.h);
    f.s.dispose();
  });

  it('空掩码拒（remove 涂空全节点——mask-invalid，提示改走 layer.delete）', () => {
    const f = setup();
    expectKind(() => f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat',
      ops: [{ op: 'remove', radiusPx: 128, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    }), 'mask-invalid');
    f.s.dispose();
  });

  it('recomputeStrategy=true：既有指派重算闭环（gems 在场+ready）', () => {
    const f = setup();
    f.seedStone();
    const planRef = f.plantPlan([
      {
        nodeId: 'n-hat', strategyKind: 'texture-fill', params: { mode: 'scatter' },
        stones: [{ resourceId: 'r1', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }],
        densityPerCm2: 2, rationale: 'agent',
      },
    ]);
    const out = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: planRef,
      nodeId: 'n-hat',
      ops: [{ op: 'remove', radiusPx: 10, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
      recomputeStrategy: true,
    });
    expect(out.gems).not.toBeNull();
    expect(out.gems!.count).toBeGreaterThan(0);
    expect(out.editState).toBe('ready');
    f.s.dispose();
  });

  it('4096 行程超限：incomplete=true 如实落盘+exportGate 阻断 mask-incomplete', () => {
    const f = setup(checkerboardTree());
    const out = f.workbench.layerMaskPatch({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-grid',
      ops: [{ op: 'add', radiusPx: 2, points: [{ x: 48, y: 48 }] }], // 棋盘行程结构保持 ~9121
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(out.incomplete).toBe(true);
    expect(out.maskRunCount).toBeGreaterThan(4096);
    expect(out.editState).toBe('ready'); // 编辑本身成功（如实落盘——不静默截断）
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId))).toEqual({
      allowed: false,
      blockers: ['mask-incomplete'],
    });
    f.s.dispose();
  });

  it('锁定/CAS/node-not-found typed 拒', () => {
    const f = setup();
    const base = {
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      expectedTreeBlobRef: f.treeBlobRef,
    };
    const op = { op: 'add' as const, radiusPx: 3, points: [{ x: 45, y: 14 }] };
    expectKind(() => f.workbench.layerMaskPatch({ ...base, nodeId: 'n-missing', ops: [op] }), 'node-not-found');
    expectKind(() => f.workbench.layerMaskPatch({
      ...base, expectedTreeBlobRef: 'd'.repeat(64), nodeId: 'n-hat', ops: [op],
    }), 'cas-mismatch');
    f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef,
      nodes: [{ nodeId: 'n-hat', locked: true }],
    });
    const viewRef = f.latestViewStateRef()!;
    expectKind(() => f.workbench.layerMaskPatch({
      ...base, currentViewStateBlobRef: viewRef, nodeId: 'n-hat', ops: [op],
    }), 'node-locked');
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [4] view.state.set

describe('setViewState（视图态所有权）', () => {
  it('revision 单调链+previousBlobRef 回溯+artifact 帧登记', () => {
    const f = setup();
    const first = f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef,
      nodes: [{ nodeId: 'n-hat', visible: false }, { nodeId: 'n-person', locked: true }],
    });
    expect(first.revision).toBe(1);
    const second = f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: first.blobRef, currentTreeBlobRef: f.treeBlobRef,
      nodes: [{ nodeId: 'n-hat', visible: false, collapsed: true }],
      expectedRevision: 1,
    });
    expect(second.revision).toBe(2);
    const state = JSON.parse(f.s.blobs.read(second.blobRef)!.toString('utf8'));
    expect(state.previousBlobRef).toBe(first.blobRef);
    expect(state.revision).toBe(2);
    expect(f.latestViewStateRef()).toBe(second.blobRef);
    f.s.dispose();
  });

  it('CAS 门：expectedRevision 缺省仅首写；有工件缺省/错值必拒（并发双开不静默覆盖）', () => {
    const f = setup();
    const first = f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef, nodes: [],
    });
    expectKind(() => f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: first.blobRef, currentTreeBlobRef: f.treeBlobRef, nodes: [],
    }), 'cas-mismatch');
    expectKind(() => f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: first.blobRef, currentTreeBlobRef: f.treeBlobRef,
      nodes: [], expectedRevision: 9,
    }), 'cas-mismatch');
    expectKind(() => f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef,
      nodes: [], expectedRevision: 3, // 尚无工件：非 0/缺省必拒
    }), 'cas-mismatch');
    f.s.dispose();
  });

  it('重复 nodeId 拒（view-state-invalid——全量快照每节点至多一行）', () => {
    const f = setup();
    expectKind(() => f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef,
      nodes: [{ nodeId: 'n-hat' }, { nodeId: 'n-hat' }],
    }), 'view-state-invalid');
    f.s.dispose();
  });

  it('幽灵节点拒：nodeId 不在当前树 → view-state-invalid（Codex 2a 复核 P0-2）', () => {
    const f = setup();
    expectKind(() => f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: f.treeBlobRef,
      nodes: [{ nodeId: 'n-ghost', locked: true }],
    }), 'view-state-invalid');
    f.s.dispose();
  });

  it('删节点后旧视图写入拒：layer.delete 后含被删节点的快照必拒（无树=仅空表可写）', () => {
    const f = setup();
    const deleted = f.workbench.layerDelete({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: f.treeBlobRef, currentViewStateBlobRef: null, planBlobRef: null,
      nodeId: 'n-hat', expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(deleted.removedNodeIds).toEqual(['n-hat']);
    expectKind(() => f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: deleted.treeBlobRef,
      nodes: [{ nodeId: 'n-hat', visible: false }],
    }), 'view-state-invalid');
    // 存量节点仍可写（归属校验不误伤）
    const ok = f.workbench.setViewState({
      taskId: f.taskId, actorId: 'u1', currentViewStateBlobRef: null, currentTreeBlobRef: deleted.treeBlobRef,
      nodes: [{ nodeId: 'n-person', locked: true }],
    });
    expect(ok.revision).toBe(1);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [5] exportGate 纯函数

describe('exportGateOf（导出门）', () => {
  const status = (over: Partial<{
    nodeId: string;
    state: 'accepted' | 'recomputing' | 'ready' | 'stale' | 'error';
    runCount: number;
    incomplete: boolean;
    error: string | null;
  }>) => ({
    nodeId: 'n',
    state: 'ready' as const,
    runCount: 10,
    incomplete: false,
    baseVersion: 1,
    error: null,
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...over,
  });

  it('干净面放行（无行/全 ready 且限内）', () => {
    expect(exportGateOf([])).toEqual({ allowed: true, blockers: [] });
    expect(exportGateOf([status({})])).toEqual({ allowed: true, blockers: [] });
    expect(exportGateOf([status({ state: 'accepted' }), status({ nodeId: 'n2', state: 'recomputing' })]))
      .toEqual({ allowed: true, blockers: [] }); // 过渡态不阻断（未完成≠不一致）
  });

  it('三阻断因子：incomplete/stale/error（声明序去重——确定性）', () => {
    expect(exportGateOf([
      status({ state: 'stale' }),
      status({ nodeId: 'n2', runCount: 5000, incomplete: true }),
      status({ nodeId: 'n3', state: 'stale' }),
    ])).toEqual({ allowed: false, blockers: ['mask-incomplete', 'mask-stale'] });
    expect(exportGateOf([status({ state: 'error', error: '引擎校验失败' })])).toEqual({
      allowed: false,
      blockers: ['mask-recompute-error'],
    });
  });
});

// ---------------------------------------------------------------- [6] RPC 面（路由层）

/** RPC fixture：真实 HandicraftKernel（无 SAM env——三写端点不依赖桥）+登录 token。 */
async function rpcSetup(tree: ObjectTree = workbenchTree()): Promise<Fixture & { client: ReturnType<typeof clientFor>; kernel: HandicraftKernel }> {
  const f = setup(tree);
  const kernel = new HandicraftKernel({
    config: f.s.config,
    db: f.s.db,
    jobs: f.s.jobs,
    sessions: f.s.sessions,
    blobs: f.s.blobs,
  });
  // 管线前置：scene-analysis+object-tree 帧（requireTreeContext 消费——产线同款直植）
  const analysis = SceneAnalysisSchema.parse({
    kind: 'scene-analysis',
    formatVersion: 1,
    imageBlobRef: f.imageBlobRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    elements: [{ name: '主体', boxPx: { x: 10, y: 8, w: 70, h: 66 }, hint: 'person', suggestDrillWorthy: true }],
    createdAt: '2026-09-26T00:00:00.000Z',
  });
  const analysisRef = putTaskArtifact(
    { db: f.s.db, blobs: f.s.blobs }, f.taskId, Buffer.from(JSON.stringify(analysis), 'utf8'),
  ).hash;
  f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: analysisRef, name: SCENE_ANALYSIS_ARTIFACT_NAME });
  f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: f.treeBlobRef, name: 'object-tree.json' });
  const client = clientFor(f.s.context({ kernel, token: await f.s.tokenFor() }));
  return { ...f, client, kernel };
}

describe('RPC 面：layer.reorder / layer.mask.patch / view.state.set / task.detail 扩面', () => {
  it('三写端点走通：reorder 成功+mask.patch 成功+view.state.set 成功+task.detail 三新面在场', async () => {
    const f = await rpcSetup();
    const client = f.client;
    const moved = await client.layer.reorder({
      taskId: f.taskId, nodeId: 'n-hat', newParentId: 'n-root', index: 0,
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(moved.version).toBe(1);
    const patched = await client.layer.mask.patch({
      taskId: f.taskId, nodeId: 'n-hat',
      ops: [{ op: 'remove', radiusPx: 5, points: [{ x: 40, y: 10 }] }],
      expectedTreeBlobRef: moved.treeBlobRef,
    });
    expect(patched.editState).toBe('ready');
    const view = await client.view.state.set({
      taskId: f.taskId, nodes: [{ nodeId: 'n-hat', visible: false }],
    });
    expect(view.revision).toBe(1);

    const detail = await client.task.detail({ taskId: f.taskId });
    expect(detail.viewState?.revision).toBe(1);
    expect(detail.viewState?.nodes[0]).toMatchObject({ nodeId: 'n-hat', visible: false });
    expect(detail.maskEdits).toHaveLength(1);
    expect(detail.exportGate).toEqual({ allowed: true, blockers: [] });
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });

  it('CAS 拒经 RPC 面：data.currentTreeBlobRef 载荷可编程判别', async () => {
    const f = await rpcSetup();
    const client = f.client;
    try {
      await client.layer.reorder({
        taskId: f.taskId, nodeId: 'n-hat', newParentId: 'n-root', index: 0,
        expectedTreeBlobRef: 'c'.repeat(64),
      });
      expect.unreachable('CAS 漂移应拒');
    } catch (e) {
      const data = (e as { data?: { code?: string; currentTreeBlobRef?: string } }).data;
      expect(data?.code).toBe('cas-mismatch');
      expect(data?.currentTreeBlobRef).toBe(f.treeBlobRef);
    }
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });

  it('view.state.set 幽灵节点 RPC 级拒：未知节点+删节点后旧视图均 view-state-invalid（Codex 2a 复核 P0-2）', async () => {
    const f = await rpcSetup();
    const client = f.client;
    try {
      await client.view.state.set({ taskId: f.taskId, nodes: [{ nodeId: 'n-ghost', visible: false }] });
      expect.unreachable('未知节点应拒');
    } catch (e) {
      expect((e as { data?: { code?: string } }).data?.code).toBe('view-state-invalid');
    }
    // 删 n-hat 后，含 n-hat 的旧视图写入必拒（服务端读当前树校验归属）
    await client.layer.delete({ taskId: f.taskId, nodeId: 'n-hat', expectedTreeBlobRef: f.treeBlobRef });
    try {
      await client.view.state.set({ taskId: f.taskId, nodes: [{ nodeId: 'n-hat', visible: false }] });
      expect.unreachable('已删节点应拒');
    } catch (e) {
      expect((e as { data?: { code?: string } }).data?.code).toBe('view-state-invalid');
    }
    const ok = await client.view.state.set({ taskId: f.taskId, nodes: [{ nodeId: 'n-person', locked: true }] });
    expect(ok.revision).toBe(1);
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [7] task.export 导出门接线（Codex 2a 复核 P0-1）

describe('RPC 面：task.export 导出门真实接线', () => {
  /**
   * task.export 客户端面（红测试先行——端点落地前经动态形状调用，落地后同形走通；
   * 输出形状沿既有导出代码形态 resources.export 的 filename/kind/dataBase64）。
   */
  interface ExportOutput {
    filename: string;
    kind: string;
    dataBase64: string;
    blobRef: string;
    gemCount: number;
  }
  type ExportRpc = (input: { taskId: string }) => Promise<ExportOutput>;
  const exportRpc = (client: unknown): ExportRpc => {
    const rpc = (client as { task: { export?: ExportRpc } }).task.export;
    if (rpc === undefined) throw new Error('task.export 端点未装配');
    return rpc;
  };

  /** 植入 strategy-gems 工件帧（导出内容真源——帧流 latest-by-name）。 */
  function plantGemsFrame(f: Fixture, gemCount = 3): string {
    const doc = {
      kind: 'strategy-gems',
      formatVersion: 1,
      planRef: '0'.repeat(64),
      canvasCm: CANVAS_CM,
      imagePx: IMAGE_PX,
      gems: Array.from({ length: gemCount }, (_, i) => ({
        id: `g${i + 1}`, x: 10 + i, y: 20, colorId: '', blockId: 'n-hat',
        shapeId: 'round', diameterMm: 3,
      })),
      excludedRegions: [],
      warnings: [],
      createdAt: '2026-09-26T00:00:00.000Z',
    };
    const ref = f.s.blobs.put(Buffer.from(JSON.stringify(doc), 'utf8')).hash;
    f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: ref, name: 'strategy-gems.json' });
    return ref;
  }

  /** 直接植状态行（stale/error 运行时转移路径=2b 异步重算面——门测试按持久真源植行）。 */
  function seedMaskEditState(f: Fixture, nodeId: string, state: 'stale' | 'error', error: string | null): void {
    f.s.db
      .prepare(
        'INSERT INTO mask_edit_states (task_id, node_id, state, run_count, base_version, error, updated_at) VALUES (?, ?, ?, 10, 1, ?, ?)',
      )
      .run(f.taskId, nodeId, state, error, '2026-09-26T00:00:00.000Z');
  }

  /** 断言导出被门拒并返回完整 blockers。 */
  async function expectExportBlocked(fn: () => Promise<unknown>): Promise<string[]> {
    try {
      await fn();
    } catch (e) {
      const data = (e as { data?: { code?: string; blockers?: string[] } }).data;
      expect(data?.code).toBe('export-blocked');
      return data?.blockers ?? [];
    }
    throw new Error('应被导出门拒（export-blocked）但放行了');
  }

  it('ready 放行：门净时导出 gems 工件字节回放（filename/kind/blobRef/gemCount/dataBase64）', async () => {
    const f = await rpcSetup();
    const gemsRef = plantGemsFrame(f);
    const out = await exportRpc(f.client)({ taskId: f.taskId });
    expect(out.kind).toBe('strategy-gems');
    expect(out.blobRef).toBe(gemsRef);
    expect(out.gemCount).toBe(3);
    expect(out.filename).toContain(f.taskId);
    const decoded = JSON.parse(Buffer.from(out.dataBase64, 'base64').toString('utf8'));
    expect(decoded.kind).toBe('strategy-gems');
    expect(decoded.gems).toHaveLength(3);
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });

  it('incomplete 拒：真实笔迹超 4096 行程 → export-blocked+blockers=[mask-incomplete]', async () => {
    const f = await rpcSetup(checkerboardTree());
    const patched = await f.client.layer.mask.patch({
      taskId: f.taskId, nodeId: 'n-grid',
      ops: [{ op: 'add', radiusPx: 2, points: [{ x: 48, y: 48 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
    });
    expect(patched.incomplete).toBe(true);
    plantGemsFrame(f);
    const blockers = await expectExportBlocked(() => exportRpc(f.client)({ taskId: f.taskId }));
    expect(blockers).toEqual(['mask-incomplete']);
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });

  it('stale 拒：编辑基线漂移留痕 → export-blocked+blockers=[mask-stale]', async () => {
    const f = await rpcSetup();
    seedMaskEditState(f, 'n-hat', 'stale', null);
    plantGemsFrame(f);
    const blockers = await expectExportBlocked(() => exportRpc(f.client)({ taskId: f.taskId }));
    expect(blockers).toEqual(['mask-stale']);
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });

  it('error 拒：重算失败留痕 → export-blocked；多因子完整清单（声明序去重）', async () => {
    const f = await rpcSetup();
    seedMaskEditState(f, 'n-hat', 'stale', null);
    seedMaskEditState(f, 'n-person', 'error', '引擎校验失败（注入留痕）');
    plantGemsFrame(f);
    const blockers = await expectExportBlocked(() => exportRpc(f.client)({ taskId: f.taskId }));
    expect(blockers).toEqual(['mask-stale', 'mask-recompute-error']);
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });
});
