/**
 * 排钻工作台服务测试（add-task-detail-layer-workbench tasks 1.3+1.4——
 * TaskWorkbench 真身：rename/history/revert 版本链+策略直改 D-1 直接生效链）。
 * 桥=可编程 MockSamTransport（拆层编排链在 segment-one.test.ts 已覆盖，此处补
 * bridge-unavailable 面）；引擎=kernel strategyEngineDelegate 真身（策略直改全链）。
 * 覆盖：
 *   [1] renameNode：改名重落双轨+artifact 帧+v1 入史；node 缺失 typed 拒。
 *   [2] treeHistory/treeRevert：快照链升序/回退=帧指针回拨（同 blobRef）+revert
 *       入史（历史只增）/version 缺失 typed 拒/fence（cancelled 拒记史）。
 *   [3] setNodeStrategy：直改→registry params 校验→stoneIdx 回填→execute 真身
 *       （gems+预览工件+帧；未改节点确定性重放）→plan 原位替换；层级节点拒/
 *       params 非法拒/stoneIdx 幻觉拒/无尺寸拒/首版无 plan=单指派。
 *   [4] segmentOneSplit 编排：bridge 未装配 typed 拒。
 * 零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  encodeInlineMask,
  StrategyPlanSchema,
  type ObjectNode,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask, updateTask } from '../src/db/jobs.js';
import { strategyEngineDelegate } from '../src/kernel/index.js';
import { StoneService } from '../src/stones/service.js';
import { MockSamTransport, SamBridge } from '../src/kernel/vision/sam-bridge.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import {
  STRATEGY_GEMS_ARTIFACT_NAME,
  STRATEGY_PLAN_ARTIFACT_NAME,
} from '../src/kernel/strategies/design.js';
import { TaskWorkbench, TaskWorkbenchError } from '../src/kernel/workbench.js';
import { createServices, type TestServices } from './helpers.js';

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

const CANVAS_CM = { w: 10, h: 10 };
const IMAGE_PX = { width: 96, height: 96 };

function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

/** 中央椭圆掩码（与 segment-one.test 同款几何——96×96 半径 r）。 */
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

/**
 * 三节点树：n-root 画布（非钻）→ n-person 主体（worthy，中间节点）→ n-hat 叶。
 * n-person 带 children 但 drillWorthy=true（产块节点——可指派）；n-hat 叶可指派。
 */
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
  /** mock SAM 传输（bridge=true 时在场——respond 编程桥响应）。 */
  transport: MockSamTransport;
  /** 种两款钻（A52=idx1 3mm / J51=idx2 2mm——stone_index ORDER BY supplier,sku 稳定序）。 */
  seedStones(): void;
  plantPlan(assignments: StrategyPlan['assignments']): string;
  /** 最新 strategy-plan.json 工件读回（直改链产物断言面）。 */
  latestPlan(): StrategyPlan;
  /** 最新 strategy-plan.json 工件 blobRef。 */
  latestPlanRef(): string;
  artifactNames(): string[];
}

function setup(bridge = true): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'workbench 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, workbenchTree()).treeBlobRef;
  const transport = new MockSamTransport();
  const workbench = new TaskWorkbench({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    ...(bridge ? { bridge: new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport }) } : {}),
    // T5（add-vision-pipeline-v2）：dataRoot 在场=segmentOne 断点账本启用（试跑→确认零二次桥调）
    dataRoot: s.config.dataRoot,
    engineLayout: strategyEngineDelegate,
  });
  return {
    s,
    taskId: task.id,
    imageBlobRef,
    treeBlobRef,
    workbench,
    transport,
    seedStones: () => {
      const stones = new StoneService({ db: s.db, blobs: s.blobs });
      for (const { sku, sizeMm, rgb, family } of [
        { sku: 'A52', sizeMm: 3, rgb: [200, 40, 40] as [number, number, number], family: '红色系' },
        { sku: 'J51', sizeMm: 2, rgb: [240, 240, 232] as [number, number, number], family: '白色系' },
      ]) {
        const rgba = new Uint8Array(128 * 128 * 4);
        for (let i = 0; i < 128 * 128; i++) {
          rgba[i * 4] = 200; rgba[i * 4 + 1] = 200; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255;
        }
        stones.createStone({
          ownerId: s.anonymous.id,
          supplierProfile: YUHANG_PROFILE,
          draft: {
            name: `${sku} 钻`,
            sku,
            sizeMm,
            color: { name: '测试色', rgb, family, finish: 'glossy' },
            texture: { declaredWidth: 128, declaredHeight: 128 },
          },
          textureBytes: new Uint8Array(encodePng(128, 128, rgba)),
        });
      }
    },
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
    latestPlanRef: () => {
      const planFrames = s.jobs.frames(s.anonymous, task.id, 0).frames.filter(
        (fr) => fr.kind === 'artifact' && (fr.payload as { name: string }).name === STRATEGY_PLAN_ARTIFACT_NAME,
      );
      return (planFrames[planFrames.length - 1]!.payload as { blobRef: string }).blobRef;
    },
    latestPlan: () => StrategyPlanSchema.parse(JSON.parse(s.blobs.read(
      (() => {
        const planFrames = s.jobs.frames(s.anonymous, task.id, 0).frames.filter(
          (fr) => fr.kind === 'artifact' && (fr.payload as { name: string }).name === STRATEGY_PLAN_ARTIFACT_NAME,
        );
        return (planFrames[planFrames.length - 1]!.payload as { blobRef: string }).blobRef;
      })(),
    )!.toString('utf8'))),
    artifactNames: () =>
      s.jobs.frames(s.anonymous, task.id, 0).frames
        .filter((f) => f.kind === 'artifact')
        .map((f) => (f.payload as { name: string }).name),
  };
}

// ---------------------------------------------------------------- [1] rename

describe('renameNode', () => {
  it('改名重落双轨+artifact 帧+v1 入史', () => {
    const f = setup();
    const out = f.workbench.renameNode({
      taskId: f.taskId,
      actorId: f.s.anonymous.id,
      imageBlobRef: f.imageBlobRef,
      treeBlobRef: f.treeBlobRef,
      nodeId: 'n-hat',
      objectName: '小丑帽',
    });
    expect(out.version).toBe(1);
    const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(out.treeBlobRef)!.toString('utf8')));
    expect(tree.nodes.find((n) => n.id === 'n-hat')!.objectName).toBe('小丑帽');
    expect(f.artifactNames()).toContain('object-tree.json');
    expect(f.artifactNames()).toContain('object-tree-preview.png');
    f.s.dispose();
  });

  it('node 缺失 typed 拒', () => {
    const f = setup();
    expect(() => f.workbench.renameNode({
      taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef, treeBlobRef: f.treeBlobRef,
      nodeId: 'n-missing', objectName: 'x',
    })).toThrowError(TaskWorkbenchError);
    try {
      f.workbench.renameNode({
        taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef, treeBlobRef: f.treeBlobRef,
        nodeId: 'n-missing', objectName: 'x',
      });
    } catch (e) {
      expect((e as TaskWorkbenchError).kind).toBe('node-not-found');
    }
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [2] history/revert

describe('tree 版本历史', () => {
  it('快照链升序+revert=帧指针回拨（同 blobRef）+revert 入史只增', () => {
    const f = setup();
    const v1 = f.workbench.renameNode({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef, treeBlobRef: f.treeBlobRef,
      nodeId: 'n-hat', objectName: '小丑帽',
    });
    const v2 = f.workbench.renameNode({
      taskId: f.taskId, actorId: 'u1', imageBlobRef: f.imageBlobRef, treeBlobRef: v1.treeBlobRef,
      nodeId: 'n-hat', objectName: '尖顶帽',
    });
    expect(v2.version).toBe(2);
    const history = f.workbench.treeHistory(f.taskId);
    expect(history.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(history.versions.map((v) => v.cause)).toEqual(['rename', 'rename']);
    expect(history.currentVersion).toBe(2);

    // revert 到 v1：当前树指针回拨（帧流最新 object-tree.json=v1 快照）
    const reverted = f.workbench.treeRevert({ taskId: f.taskId, actorId: 'u1', version: 1 });
    expect(reverted.treeBlobRef).toBe(v1.treeBlobRef);
    expect(reverted.version).toBe(3);
    const after = f.workbench.treeHistory(f.taskId);
    expect(after.versions).toHaveLength(3);
    expect(after.versions[2]!.cause).toBe('revert');
    const frames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames.filter(
      (fr) => fr.kind === 'artifact' && (fr.payload as { name: string }).name === 'object-tree.json',
    );
    expect((frames[frames.length - 1]!.payload as { blobRef: string }).blobRef).toBe(v1.treeBlobRef);
    f.s.dispose();
  });

  it('version 缺失 typed 拒；cancelled 任务拒记史（fence）', () => {
    const f = setup();
    expect(() => f.workbench.treeRevert({ taskId: f.taskId, actorId: 'u', version: 99 })).toThrowError(TaskWorkbenchError);
    updateTask(f.s.db, f.taskId, { status: 'cancelled' });
    try {
      f.workbench.renameNode({
        taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef, treeBlobRef: f.treeBlobRef,
        nodeId: 'n-hat', objectName: 'x',
      });
      expect.unreachable('cancelled 任务应 fence 拒');
    } catch (e) {
      expect((e as TaskWorkbenchError).kind).toBe('fence');
    }
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [3] 策略直改

describe('setNodeStrategy（D-1 直接生效）', () => {
  it('直改→execute 真身重算：gems+预览工件+帧+plan 原位替换（未改节点保留）', () => {
    const f = setup();
    f.seedStones();
    const planRef = f.plantPlan([
      {
        nodeId: 'n-person', strategyKind: 'exclusion', params: { reason: '主体留白' }, stones: [], densityPerCm2: 2.3, rationale: 'agent 原指派',
      },
    ]);
    const out = f.workbench.setNodeStrategy({
      taskId: f.taskId,
      treeBlobRef: f.treeBlobRef,
      planBlobRef: planRef,
      nodeId: 'n-hat',
      strategyKind: 'texture-fill',
      params: { mode: 'scatter', polarity: 'dark-dense' },
      stoneIdx: [1],
      densityPerCm2: 2,
    });
    expect(out.gems.count).toBeGreaterThan(0);
    const names = f.artifactNames();
    expect(names).toContain(STRATEGY_PLAN_ARTIFACT_NAME);
    expect(names).toContain(STRATEGY_GEMS_ARTIFACT_NAME);
    expect(names).toContain('strategy-gems-preview.png');
    // 新 plan：n-hat 直改；n-person 旧指派（父层）随收敛移除——v5 产块集=叶子集
    const planFrames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames.filter(
      (fr) => fr.kind === 'artifact' && (fr.payload as { name: string }).name === STRATEGY_PLAN_ARTIFACT_NAME,
    );
    const latest = planFrames[planFrames.length - 1]!.payload as { blobRef: string };
    const plan = StrategyPlanSchema.parse(JSON.parse(f.s.blobs.read(latest.blobRef)!.toString('utf8')));
    const byNode = new Map(plan.assignments.map((a) => [a.nodeId, a] as const));
    expect(byNode.get('n-hat')?.strategyKind).toBe('texture-fill');
    expect(byNode.has('n-person')).toBe(false); // v5：组（有 children）旧指派收敛移除
    expect(plan.objectTreeRef).toBe(f.treeBlobRef);
    f.s.dispose();
  });

  it('同参数重放确定性：两次直改产同 gems 点阵（seed 同源——createdAt 使 blobRef 异、钻位深比较）', () => {
    const f = setup();
    f.seedStones();
    const input = {
      taskId: f.taskId,
      treeBlobRef: f.treeBlobRef,
      planBlobRef: null,
      nodeId: 'n-hat',
      strategyKind: 'geometry' as const,
      params: { shape: 'circle' },
      stoneIdx: [2],
    };
    const a = f.workbench.setNodeStrategy(input);
    const b = f.workbench.setNodeStrategy({ ...input, planBlobRef: null });
    expect(b.gems.count).toBe(a.gems.count);
    expect(b.gems.count).toBeGreaterThan(0);
    const gemsOf = (ref: string): unknown =>
      (JSON.parse(f.s.blobs.read(ref)!.toString('utf8')) as { gems: unknown }).gems;
    expect(gemsOf(b.gems.blobRef)).toEqual(gemsOf(a.gems.blobRef));
    f.s.dispose();
  });

  it('组节点拒（v5：恒=叶子可指派——drillWorthy 父层同拒 node-not-leaf）', () => {
    const f = setup(false);
    f.seedStones();
    try {
      f.workbench.setNodeStrategy({
        taskId: f.taskId, treeBlobRef: f.treeBlobRef, planBlobRef: null,
        nodeId: 'n-person', strategyKind: 'exclusion', params: { reason: 'x' },
      });
      expect.unreachable('drillWorthy 组节点应拒（v5 组恒不产钻）');
    } catch (e) {
      expect((e as TaskWorkbenchError).kind).toBe('node-not-leaf');
    }
    try {
      f.workbench.setNodeStrategy({
        taskId: f.taskId, treeBlobRef: f.treeBlobRef, planBlobRef: null,
        nodeId: 'n-root', strategyKind: 'exclusion', params: { reason: 'x' },
      });
      expect.unreachable('根组节点应拒');
    } catch (e) {
      expect((e as TaskWorkbenchError).kind).toBe('node-not-leaf');
    }
    f.s.dispose();
  });

  it('params 非法拒（registry 逐项——多余字段）；stoneIdx 幻觉拒；无尺寸拒', () => {
    const f = setup(false);
    f.seedStones();
    const base = { taskId: f.taskId, treeBlobRef: f.treeBlobRef, planBlobRef: null, nodeId: 'n-hat' };
    try {
      f.workbench.setNodeStrategy({ ...base, strategyKind: 'texture-fill', params: { mode: 'scatter', unknown: 1 }, stoneIdx: [1] });
      expect.unreachable('params 非法应拒');
    } catch (e) {
      expect((e as TaskWorkbenchError).kind).toBe('params-invalid');
    }
    try {
      f.workbench.setNodeStrategy({ ...base, strategyKind: 'texture-fill', params: { mode: 'scatter' }, stoneIdx: [9] });
      expect.unreachable('幻觉 idx 应拒');
    } catch (e) {
      expect((e as TaskWorkbenchError).kind).toBe('stone-invalid');
    }
    try {
      f.workbench.setNodeStrategy({ ...base, strategyKind: 'texture-fill', params: { mode: 'scatter' }, stoneIdx: [] });
      expect.unreachable('空钻应拒');
    } catch (e) {
      expect((e as TaskWorkbenchError).kind).toBe('stone-invalid');
    }
    f.s.dispose();
  });

  it('首版无 plan=单指派 plan（其余节点待指派）', () => {
    const f = setup(false);
    f.seedStones();
    const out = f.workbench.setNodeStrategy({
      taskId: f.taskId, treeBlobRef: f.treeBlobRef, planBlobRef: null,
      nodeId: 'n-hat', strategyKind: 'soft-curve', params: {}, stoneIdx: [1],
    });
    expect(out.gems.count).toBeGreaterThan(0);
    f.s.dispose();
  });

  it('gapFill 透传保留（close-paving-backlog T2.5——直改微调不静默丢混排配置）', () => {
    const f = setup();
    f.seedStones();
    // 两款钻 picks（A52 idx1 3mm 打底 / J51 idx2 2mm 补隙——stone_index 稳定序）
    const rows = new StoneService({ db: f.s.db, blobs: f.s.blobs }).listIndexRows().filter((r) => r.trashed === 0);
    const a52 = rows.find((r) => r.sku === 'A52')!;
    const j51 = rows.find((r) => r.sku === 'J51')!;
    const pick = (r: typeof a52) => ({
      resourceId: r.resource_id, sku: r.sku, supplier: r.supplier, sizeMm: r.size_mm, colorHex: r.color_hex,
    });
    const planRef = f.plantPlan([
      {
        nodeId: 'n-hat', strategyKind: 'geometry', params: { shape: 'circle' },
        stones: [pick(a52), pick(j51)], densityPerCm2: 2.3,
        gapFill: { stoneRef: j51.resource_id, minGapRatio: 1.2 },
        rationale: 'agent 混排指派',
      },
    ]);
    // 直改微调密度（stoneIdx 不回传——stones 继承先例）：新 plan 必须仍带 gapFill
    const out = f.workbench.setNodeStrategy({
      taskId: f.taskId, treeBlobRef: f.treeBlobRef, planBlobRef: planRef,
      nodeId: 'n-hat', strategyKind: 'geometry', params: { shape: 'circle' },
      densityPerCm2: 3,
    });
    expect(out.gems.count).toBeGreaterThan(0);
    const latestPlan = f.latestPlan();
    const assignment = latestPlan.assignments.find((a) => a.nodeId === 'n-hat')!;
    expect(assignment.densityPerCm2).toBe(3);
    expect(assignment.gapFill).toEqual({ stoneRef: j51.resource_id, minGapRatio: 1.2 }); // 透传保留
    expect(assignment.stones.map((s) => s.resourceId)).toEqual([a52.resource_id, j51.resource_id]); // stones 继承
    // 切族 exclusion（不产钻）=守卫放弃 gapFill（superRefine 组合拒的预防线——不炸直改）
    const out2 = f.workbench.setNodeStrategy({
      taskId: f.taskId, treeBlobRef: f.treeBlobRef, planBlobRef: f.latestPlanRef(),
      nodeId: 'n-hat', strategyKind: 'exclusion', params: { reason: '留白' },
    });
    expect(out2.gems.count).toBe(0);
    const after = f.latestPlan().assignments.find((a) => a.nodeId === 'n-hat')!;
    expect(after.strategyKind).toBe('exclusion');
    expect(after.gapFill).toBeUndefined(); // 组合非法面：直改透传守卫放弃（非静默丢——组内注记见 workbench.ts）
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [4] 拆层编排

it('segmentOneSplit：bridge 未装配 typed 拒（无降级面）', async () => {
  const f = setup(false);
  await expect(f.workbench.segmentOneSplit({
    taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef,
    treeBlobRef: f.treeBlobRef, nodeId: 'n-hat', hint: 'hat',
  })).rejects.toMatchObject({ name: 'TaskWorkbenchError', kind: 'bridge-unavailable' });
  f.s.dispose();
});

it('segmentOneSplit dryRun（T5/D6）：试跑不入版本史；确认同参零桥调+入史+自定义名', async () => {
  const f = setup();
  let bridgeCalls = 0;
  const respond = (): void => {
    f.transport.respond(() => {
      bridgeCalls += 1;
      // 椭圆掩码落在 n-person 内（96×96 半径 20）
      return {
        kind: 'segment' as const,
        mask: encodeInlineMask(96, 96, ellipseBits(96, 96, 20)),
        score: 0.8,
        meta: { model: 'mock', durationMs: 1, iteration: 0 },
      };
    });
  };
  respond();
  respond();
  const versionsBefore = f.workbench.treeHistory(f.taskId).versions.length;
  // —— 试跑（dryRun）：trial 面在场+版本史不增 ——
  const trial = await f.workbench.segmentOneSplit({
    taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef,
    treeBlobRef: f.treeBlobRef, nodeId: 'n-person', hint: 'hat',
    dryRun: true, precision: { maskMaxSide: 96 },
  });
  expect(bridgeCalls).toBe(1);
  expect(trial.trial).toBeDefined();
  expect(trial.trial!.preview.kind).toBe('trial-mask-overlay');
  expect(f.workbench.treeHistory(f.taskId).versions.length).toBe(versionsBefore);
  // —— 确认（同参+layerName）：账本命中零桥调+入史 ——
  const landed = await f.workbench.segmentOneSplit({
    taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef,
    treeBlobRef: f.treeBlobRef, nodeId: 'n-person', hint: 'hat',
    precision: { maskMaxSide: 96 }, layerName: '右发',
  });
  expect(bridgeCalls).toBe(1); // 零二次桥调（T5 幂等底座）
  expect(landed.trial).toBeUndefined();
  expect(landed.children[0]!.objectName).toBe('右发');
  const versions = f.workbench.treeHistory(f.taskId).versions;
  expect(versions.length).toBe(versionsBefore + 1);
  expect(versions[versions.length - 1]!.cause).toBe('segment-one');
  f.s.dispose();
});

it('segmentOneSplit trialTreeBlobRef（Codex R1 P1）：过期基线=typed 拒 trial-stale-tree 零桥调不入史；一致基线=照常落地', async () => {
  const f = setup();
  let bridgeCalls = 0;
  const respond = (): void => {
    f.transport.respond(() => {
      bridgeCalls += 1;
      return {
        kind: 'segment' as const,
        mask: encodeInlineMask(96, 96, ellipseBits(96, 96, 20)),
        score: 0.8,
        meta: { model: 'mock', durationMs: 1, iteration: 0 },
      };
    });
  };
  respond();
  respond();
  // —— 试跑（dryRun）——响应 treeBlobRef=当前树引用原样回传
  const trial = await f.workbench.segmentOneSplit({
    taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef,
    treeBlobRef: f.treeBlobRef, nodeId: 'n-person', hint: 'hat',
    dryRun: true, precision: { maskMaxSide: 96 },
  });
  expect(bridgeCalls).toBe(1);
  const versionsBefore = f.workbench.treeHistory(f.taskId).versions.length;
  // —— 确认携带过期基线（试跑后树被别处改过=电流树引用已漂移）——typed 拒不落树
  const driftedTree = workbenchTree();
  driftedTree.nodes[2]!.objectName = '帽子（他处改名）'; // 内容寻址：内容变=新 blobRef
  const driftedRef = persistObjectTreeArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, driftedTree).treeBlobRef;
  expect(driftedRef).not.toBe(f.treeBlobRef);
  const stale = await f.workbench.segmentOneSplit({
    taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef,
    treeBlobRef: driftedRef, nodeId: 'n-person', hint: 'hat',
    precision: { maskMaxSide: 96 }, trialTreeBlobRef: trial.treeBlobRef,
  }).catch((error: unknown) => error);
  expect(stale).toBeInstanceOf(TaskWorkbenchError);
  expect((stale as TaskWorkbenchError).kind).toBe('trial-stale-tree');
  expect((stale as TaskWorkbenchError).currentTreeBlobRef).toBe(driftedRef); // 客户端刷新锚
  expect(bridgeCalls).toBe(1); // 拒绝发生在桥调用前
  expect(f.workbench.treeHistory(f.taskId).versions.length).toBe(versionsBefore); // 不入史
  // —— 确认携带一致基线（trialTreeBlobRef=试跑时树引用=电流树）——照常落地
  const landed = await f.workbench.segmentOneSplit({
    taskId: f.taskId, actorId: 'u', imageBlobRef: f.imageBlobRef,
    treeBlobRef: f.treeBlobRef, nodeId: 'n-person', hint: 'hat',
    precision: { maskMaxSide: 96 }, layerName: '右发',
    trialTreeBlobRef: trial.treeBlobRef,
  });
  expect(landed.children[0]!.objectName).toBe('右发');
  expect(f.workbench.treeHistory(f.taskId).versions.length).toBe(versionsBefore + 1);
  f.s.dispose();
});
