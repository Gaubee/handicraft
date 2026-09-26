/**
 * [2026-09-27] workbench-pro 终评收尾轮（Codex 终评 7.0/10 NO-GO 的 P0-1/P1-1 闭合）：
 *   [1] P0-1 stale/error 恢复链产品面：maskEdit.retry / maskEdit.discard 内核语义
 *       （CAS=expectedBaseVersion 漂移必拒；discard 仅面向阻断留痕 stale/error/
 *       incomplete；幂等行缺席=discarded:false）。
 *   [2] P1-1 retry 零行 CAS 阻副作用：SELECT 与条件 UPDATE 之间行被同节点新 patch
 *       覆盖（prepare 拦截注入的精确竞态缝）时——不得执行 runMaskRecompute（不发布
 *       strategy-gems 工件/帧），重读行现值如实返回。
 *   [3] RPC 面：maskEdit.retry/maskEdit.discard 端点走通（stale→retry→ready 放行；
 *       stale→discard→门开；CAS 拒面 data.code 可编程判别）。
 * 内核级+RPC 级。零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  SceneAnalysisSchema,
  StrategyPlanSchema,
  encodeInlineMask,
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
import { TaskWorkbench, TaskWorkbenchError, exportGateOf, maskEditStatusesOf } from '../src/kernel/workbench.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture（workbench-pro.test.ts 同式）

function testImage(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
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

/** 三节点树：n-root 画布 → n-person 主体（worthy 中间产块）→ n-hat 叶（bbox x30 y4 w30 h20）。 */
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
  rowOf(nodeId: string): { state: string; baseVersion: number } | undefined;
}

function setup(): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'workbench-pro-final 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, workbenchTree()).treeBlobRef;
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
    rowOf: (nodeId) => {
      const row = maskEditStatusesOf(s.db, taskId).find((r) => r.nodeId === nodeId);
      return row === undefined ? undefined : { state: row.state, baseVersion: row.baseVersion };
    },
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

/**
 * 形状合法但不可执行的 plan（RPC 级 error 态素材）：texture-fill params mode 非法
 * （registry paramsSchema 判别联合外——plan 疏 schema 让 task.detail 照常组装
 * assignments，重算作业 execute 真身必拒）→ 行 error。
 */
function brokenExecPlanRef(f: Fixture): string {
  return f.plantPlan([
    {
      nodeId: 'n-hat',
      strategyKind: 'texture-fill' as const,
      params: { mode: 'bogus-mode' },
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

/** 落一笔 patch 后树推进（rename）→ 行 stale（retry/discard 的产品面前置）。 */
function seedStaleRow(f: Fixture, planRef: string): { treeAfterRename: string } {
  const patched = f.workbench.layerMaskPatch(patchInput(f, planRef, f.treeBlobRef, [
    { op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] },
  ]));
  const renamed = f.workbench.renameNode({
    taskId: f.taskId, actorId: 'u2', imageBlobRef: f.imageBlobRef,
    treeBlobRef: patched.treeBlobRef, nodeId: 'n-hat', objectName: '贝雷帽',
  });
  return { treeAfterRename: renamed.treeBlobRef };
}

// ------------------------------------------------- [1] P0-1 恢复链内核语义（retry/discard）

describe('maskEdit.retry/discard 内核语义（终评 P0-1 恢复链）', () => {
  it('stale 行 retry（CAS 基线正确）：同步重放收敛 ready+门放行+响应携带完整留痕行', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);
    const { treeAfterRename } = seedStaleRow(f, goodPlan);
    expect(f.rowOf('n-hat')?.state).toBe('stale');

    const row = maskEditStatusesOf(f.s.db, f.taskId).find((r) => r.nodeId === 'n-hat')!;
    const retried = f.workbench.retryMaskEditRecompute({
      taskId: f.taskId, nodeId: 'n-hat',
      imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: treeAfterRename,
      planBlobRef: goodPlan,
      expectedBaseVersion: row.baseVersion,
    });
    expect(retried.edit.state).toBe('ready');
    expect(retried.edit.error).toBeNull();
    expect(retried.edit.baseVersion).toBe(row.baseVersion);
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId)).allowed).toBe(true);
    await f.workbench.flushMaskRecomputeJobs(); // seedStaleRow 遗留的 A 作业排空（dispose 后微任务不再触已关 DB）
    f.s.dispose();
  });

  it('retry CAS 漂移（期望 baseVersion=旧值，行已被新编辑接管）：typed 拒 cas-mismatch+行不被触碰', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);
    const { treeAfterRename } = seedStaleRow(f, goodPlan);
    const staleBase = f.rowOf('n-hat')!.baseVersion;

    // 同节点新 patch 接管行（base_version 推进）
    const next = f.workbench.layerMaskPatch(patchInput(f, goodPlan, treeAfterRename, [
      { op: 'add', radiusPx: 3, points: [{ x: 46, y: 15 }] },
    ]));
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowOf('n-hat')?.state).toBe('ready');
    expect(f.rowOf('n-hat')!.baseVersion).toBeGreaterThan(staleBase);

    // 旧基线 retry 必拒——不得把新编辑的行拉回重算
    expectKind(() => f.workbench.retryMaskEditRecompute({
      taskId: f.taskId, nodeId: 'n-hat',
      imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: next.treeBlobRef,
      planBlobRef: goodPlan,
      expectedBaseVersion: staleBase,
    }), 'cas-mismatch');
    expect(f.rowOf('n-hat')?.state).toBe('ready'); // 行不被触碰
    f.s.dispose();
  });

  it('retry 无存量 plan（planBlobRef=null）：typed 拒 plan-missing（重算面缺席）', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);
    const { treeAfterRename } = seedStaleRow(f, goodPlan);
    const row = f.rowOf('n-hat')!;
    expectKind(() => f.workbench.retryMaskEditRecompute({
      taskId: f.taskId, nodeId: 'n-hat',
      imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: treeAfterRename,
      planBlobRef: null,
      expectedBaseVersion: row.baseVersion,
    }), 'plan-missing');
    await f.workbench.flushMaskRecomputeJobs();
    f.s.dispose();
  });

  it('discard stale 行：删行+门放行；行缺席=幂等 discarded:false', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);
    seedStaleRow(f, goodPlan);
    const row = f.rowOf('n-hat')!;
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId)).allowed).toBe(false);

    const out = f.workbench.discardMaskEdit({ taskId: f.taskId, nodeId: 'n-hat', expectedBaseVersion: row.baseVersion });
    expect(out.discarded).toBe(true);
    expect(maskEditStatusesOf(f.s.db, f.taskId)).toHaveLength(0);
    expect(exportGateOf(maskEditStatusesOf(f.s.db, f.taskId)).allowed).toBe(true);

    // 再弃（行已不在）=幂等成功
    expect(f.workbench.discardMaskEdit({ taskId: f.taskId, nodeId: 'n-hat', expectedBaseVersion: row.baseVersion }).discarded).toBe(false);
    await f.workbench.flushMaskRecomputeJobs();
    f.s.dispose();
  });

  it('discard CAS 漂移：期望旧 baseVersion 而行已推进——typed 拒 cas-mismatch（不误弃新编辑留痕）', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);
    const { treeAfterRename } = seedStaleRow(f, goodPlan);
    const staleBase = f.rowOf('n-hat')!.baseVersion;
    f.workbench.layerMaskPatch(patchInput(f, goodPlan, treeAfterRename, [
      { op: 'add', radiusPx: 3, points: [{ x: 46, y: 15 }] },
    ]));
    await f.workbench.flushMaskRecomputeJobs();

    expectKind(() => f.workbench.discardMaskEdit({ taskId: f.taskId, nodeId: 'n-hat', expectedBaseVersion: staleBase }), 'cas-mismatch');
    expect(maskEditStatusesOf(f.s.db, f.taskId)).toHaveLength(1); // 新编辑留痕不被误弃
    f.s.dispose();
  });
});

// ------------------------------------------------- [2] P1-1 retry 零行 CAS 阻副作用（精确竞态缝）

describe('retry 零行 CAS：SELECT 与条件 UPDATE 之间行被新 patch 覆盖 → 不执行重算副作用', () => {
  it('prepare 拦截注入竞态缝：UPDATE 落空时零 strategy-gems 帧发布+行现值如实返回（B 作业自会收敛）', async () => {
    const f = setup();
    f.seedStone();
    const goodPlan = hatAssignmentPlanRef(f);
    const { treeAfterRename } = seedStaleRow(f, goodPlan);
    expect(f.rowOf('n-hat')?.state).toBe('stale');
    const staleBase = f.rowOf('n-hat')!.baseVersion;

    // 帧监听（副作用观测锚）：reexecutePlan 发布 strategy-gems 工件帧——retry 零行路径不得出现
    const artifactNames: string[] = [];
    const realJobs = f.s.jobs;
    const jobsSpy = {
      emitFor: (taskId: string, kind: unknown, payload: unknown) => {
        if (typeof (payload as { name?: unknown })?.name === 'string') artifactNames.push((payload as { name: string }).name);
        return realJobs.emitFor(taskId, kind as never, payload);
      },
    } as typeof realJobs;

    // db 代理：在 retry 的条件 UPDATE 语句执行瞬间注入同节点新 patch（SELECT 已读过旧行
    // ——模拟 SELECT/UPDATE 缝间行被覆盖；patch 用不同 SQL 不经拦截，无递归）
    const realDb = f.s.db;
    const RETRY_UPDATE_MARK = "SET state = 'recomputing', error = NULL";
    let seamFired = false;
    const interceptedWorkbench = new TaskWorkbench({
      db: new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes(RETRY_UPDATE_MARK)) return stmt;
            return {
              run: (...args: unknown[]) => {
                if (!seamFired) {
                  seamFired = true;
                  // 竞态缝：新 patch 覆盖行（accepted·base_version=staleBase+1）——旧 stale 行不复存在
                  f.workbench.layerMaskPatch(patchInput(f, goodPlan, treeAfterRename, [
                    { op: 'add', radiusPx: 3, points: [{ x: 46, y: 15 }] },
                  ]));
                }
                return stmt.run(...(args as []));
              },
            } as typeof stmt;
          };
        },
      }),
      blobs: f.s.blobs,
      jobs: jobsSpy,
      engineLayout: strategyEngineDelegate,
    });

    const retried = interceptedWorkbench.retryMaskEditRecompute({
      taskId: f.taskId, nodeId: 'n-hat',
      imageBlobRef: f.imageBlobRef,
      currentTreeBlobRef: treeAfterRename,
      planBlobRef: goodPlan,
      expectedBaseVersion: staleBase,
    });
    expect(seamFired).toBe(true);
    // 零行 CAS：不执行 runMaskRecompute——行现值（B 新 patch 的 accepted/新 base_version）如实返回
    expect(retried.edit.baseVersion).toBeGreaterThan(staleBase);
    expect(['accepted', 'recomputing']).toContain(retried.edit.state);
    // 副产物零发布：缝内 B patch 的 object-tree/preview 帧在，但 strategy-gems 帧不得出现（B 的异步作业未跑）
    expect(artifactNames).not.toContain('strategy-gems.json');

    // B 自己的作业收敛（flush 后 ready——新编辑不被旧 retry 阻断）
    await f.workbench.flushMaskRecomputeJobs();
    expect(f.rowOf('n-hat')?.state).toBe('ready');
    f.s.dispose();
  });
});

// ------------------------------------------------- [3] RPC 面（maskEdit.retry / maskEdit.discard）

/** RPC fixture：真实 HandicraftKernel+登录 token+管线帧前置（rpcSetup 同式）。 */
async function rpcSetup(plan: 'good' | 'broken'): Promise<Fixture & { client: ReturnType<typeof clientFor>; kernel: HandicraftKernel; plantPlanFrame: (ref: string) => void }> {
  const f = setup();
  const kernel = new HandicraftKernel({
    config: f.s.config,
    db: f.s.db,
    jobs: f.s.jobs,
    sessions: f.s.sessions,
    blobs: f.s.blobs,
  });
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
  const plantPlanFrame = (ref: string): void => {
    f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: ref, name: 'strategy-plan.json' });
  };
  // 帧：scene-analysis + object-tree + strategy-plan（retry 的重算面真源——帧流 latest-by-name）
  f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: analysisRef, name: SCENE_ANALYSIS_ARTIFACT_NAME });
  f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: f.treeBlobRef, name: 'object-tree.json' });
  plantPlanFrame(plan === 'good' ? hatAssignmentPlanRef(f) : brokenExecPlanRef(f));
  const client = clientFor(f.s.context({ kernel, token: await f.s.tokenFor() }));
  return { ...f, client, kernel, plantPlanFrame };
}

/** 等待 patch 的异步重算作业终态（两级微任务+reexecutePlan——RPC 测试无 flush 钩子）。 */
async function settleAsyncRecompute(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.resolve();
  await Promise.resolve();
}

describe('RPC 面：maskEdit.retry / maskEdit.discard 端点走通', () => {
  // 注：RPC 级走 error 态路径（patch 的异步作业确定性收敛 error——坏 plan）；stale 态
  // 的「重算未完成窗口内树推进」在 RPC await 边界存在微任务竞态（内核级同步调用已
  // 确定性覆盖，见 [1]），此处不赌时序。
  it('patch（坏 plan→error）→maskEdit.retry RPC（换正确 plan 帧）：终态 ready+门放行', async () => {
    const f = await rpcSetup('broken'); // 帧流 plan=形状合法但 stone 缺席 → 作业 error
    f.seedStone();
    const client = f.client;

    const patched = await client.layer.mask.patch({
      taskId: f.taskId, nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
      recomputeStrategy: true,
    });
    expect(patched.editState).toBe('accepted');
    await settleAsyncRecompute();
    let detail = await client.task.detail({ taskId: f.taskId });
    expect(detail.maskEdits[0]?.state).toBe('error');
    expect(detail.exportGate).toEqual({ allowed: false, blockers: ['mask-recompute-error'] });

    // 换正确 plan 帧（帧流 latest-by-name 推进）→ retry 重放 → ready
    f.plantPlanFrame(hatAssignmentPlanRef(f));
    const retried = await client.maskEdit.retry({
      taskId: f.taskId, nodeId: 'n-hat',
      expectedBaseVersion: detail.maskEdits[0]!.baseVersion,
    });
    expect(retried.edit.state).toBe('ready');

    detail = await client.task.detail({ taskId: f.taskId });
    expect(detail.maskEdits[0]?.state).toBe('ready');
    expect(detail.exportGate.allowed).toBe(true);
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });

  it('error→maskEdit.discard RPC：留痕清空+门放行；再弃=幂等 discarded:false', async () => {
    const f = await rpcSetup('broken');
    f.seedStone();
    const client = f.client;

    await client.layer.mask.patch({
      taskId: f.taskId, nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
      recomputeStrategy: true,
    });
    await settleAsyncRecompute();
    const detail = await client.task.detail({ taskId: f.taskId });
    expect(detail.maskEdits[0]?.state).toBe('error');

    const out = await client.maskEdit.discard({
      taskId: f.taskId, nodeId: 'n-hat',
      expectedBaseVersion: detail.maskEdits[0]!.baseVersion,
    });
    expect(out.discarded).toBe(true);
    const after = await client.task.detail({ taskId: f.taskId });
    expect(after.maskEdits).toHaveLength(0);
    expect(after.exportGate.allowed).toBe(true);
    const again = await client.maskEdit.discard({
      taskId: f.taskId, nodeId: 'n-hat',
      expectedBaseVersion: detail.maskEdits[0]!.baseVersion,
    });
    expect(again.discarded).toBe(false);
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });

  it('retry/discard CAS 拒经 RPC 面：data.code=cas-mismatch 可编程判别', async () => {
    const f = await rpcSetup('broken');
    f.seedStone();
    const client = f.client;

    await client.layer.mask.patch({
      taskId: f.taskId, nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 3, points: [{ x: 45, y: 14 }] }],
      expectedTreeBlobRef: f.treeBlobRef,
      recomputeStrategy: true,
    });
    await settleAsyncRecompute();
    const detail = await client.task.detail({ taskId: f.taskId });
    expect(detail.maskEdits[0]?.state).toBe('error');
    for (const rpc of [
      () => client.maskEdit.retry({ taskId: f.taskId, nodeId: 'n-hat', expectedBaseVersion: 999 }),
      () => client.maskEdit.discard({ taskId: f.taskId, nodeId: 'n-hat', expectedBaseVersion: 999 }),
    ]) {
      try {
        await rpc();
        expect.unreachable('CAS 漂移应拒');
      } catch (e) {
        expect((e as { data?: { code?: string } }).data?.code).toBe('cas-mismatch');
      }
    }
    void f.kernel.stop().catch(() => undefined);
    f.s.dispose();
  });
});
