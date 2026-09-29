/**
 * 项目钻 lint 单源测试（add-task-stones-manifest-export 3.1/3.2——arch-decisions
 * A3「三处运行、一个规则单源」的行为锁定）：
 *   [1] lintAssignments 四分类：manifest×assignments×stone_index 三源判定序
 *       （在 manifest→introduced；库内现存→unintroduced[warning]；否则
 *       unresolvable[hard]；manifest 未引用→unused）；无 session-project 行=null。
 *   [2] 引用账本保护（A1）：库内软删后——已引入条目仍 introduced（manifest 快照
 *       不悬空）；未引入引用变 unresolvable（hard——不能靠添加 manifest 消除）。
 *   [3] lintTaskStoneRefs 单源函数：读 task 最新 strategy-plan（单图现状
 *       latest-by-name）→四锚组装（manifestRevision/planRef/sourceTaskId/imageId
 *       缺省 image-1）；无 plan 工件=null。
 *   [4] putStoneLintArtifact：stones-lint.json 工件+帧（latest-by-name）。
 *   [5] lintSummaryForTaskDetail 读面漂移语义：工件新鲜（双锚未漂移）直读；manifest
 *       revision 漂移/plan 漂移→现算（A3「不能展示旧的已消除」）；无 plan=null；
 *       工件损坏→现算（派生工件不放大）。
 *   [6] 接线③ layer.strategy.set：成功结果内嵌 lint+工件落档；warning 不把直改变
 *       error；无 manifest（无项目语义）=lint null 且不落工件。
 *   [7] task.detail projectStones.lint 点亮（rpc 面）+exportGate 政策分离
 *       （lint 分类不进安全门——3.3）。
 * 零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
  StrategyPlanSchema,
  encodeInlineMask,
  ObjectTreeSchema,
  type ObjectNode,
  type ObjectTree,
  type StrategyAssignment,
  type StoneLint,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { strategyEngineDelegate } from '../src/kernel/index.js';
import { StoneService } from '../src/stones/service.js';
import { ProjectManifestService } from '../src/kernel/project-manifest.js';
import { materializeStoneRef } from '../src/kernel/project-expand.js';
import {
  DEFAULT_LINT_IMAGE_ID,
  STONES_LINT_ARTIFACT_NAME,
  latestTaskArtifactRefs,
  lintAssignments,
  lintSummaryForTaskDetail,
  lintTaskStoneRefs,
  putStoneLintArtifact,
  stoneLintArtifactOf,
  stoneLintResultOf,
} from '../src/kernel/project-lint.js';
import { STRATEGY_PLAN_ARTIFACT_NAME } from '../src/kernel/strategies/design.js';
import { TaskWorkbench } from '../src/kernel/workbench.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import { createServices, clientFor, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const YUHANG_PROFILE: Parameters<StoneService['createStone']>[0]['supplierProfile'] = {
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { J: 2, A: 3 } }],
  styleKey: 'row',
};

function textureBytes(): Uint8Array {
  const rgba = new Uint8Array(128 * 128 * 4);
  for (let i = 0; i < 128 * 128; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 200;
    rgba[i * 4 + 2] = 200;
    rgba[i * 4 + 3] = 255;
  }
  return new Uint8Array(encodePng(128, 128, rgba));
}

/** 两叶树（n-person 组 → n-hat 叶）：layer.strategy.set 直改面基座。 */
function lintTree(): ObjectTree {
  const hat: ObjectNode = {
    id: 'n-hat',
    objectName: '帽子',
    category: 'hat',
    mask: encodeInlineMask(30, 20, new Uint8Array(30 * 20).fill(1)),
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
    mask: encodeInlineMask(70, 66, new Uint8Array(70 * 66).fill(1)),
    bbox: { x: 10, y: 8, w: 70, h: 66 },
    parent: 'n-root',
    children: ['n-hat'],
    effectiveMm: 68,
    labVariance: 20,
    drillWorthy: true,
    origin: 'vlm+sam3',
  };
  const root: ObjectNode = {
    id: 'n-root',
    objectName: '画布',
    category: 'canvas',
    mask: encodeInlineMask(96, 96, new Uint8Array(96 * 96).fill(1)),
    bbox: { x: 0, y: 0, w: 96, h: 96 },
    parent: null,
    children: ['n-person'],
    effectiveMm: 96,
    labVariance: 30,
    drillWorthy: false,
    origin: 'vlm+sam3',
  };
  return ObjectTreeSchema.parse({
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 10, h: 10 },
    imagePx: { width: 96, height: 96 },
    nodes: [root, person, hat],
    createdAt: '2026-09-29T00:00:00.000Z',
  });
}

interface LintFixture {
  s: TestServices;
  manifests: ProjectManifestService;
  workbench: TaskWorkbench;
  sessionId: string;
  taskId: string;
  treeBlobRef: string;
  /** 候选钻（stone_index 稳定序：A52 / B53 / J51）。 */
  a52: string;
  b53: string;
  j51: string;
  /** 会话首条 followup 语义的初版 manifest（跳过集合——A5）+J51 已引入。 */
  seedManifest(): void;
  /** 落 plan 工件+帧（latest-by-name 'strategy-plan.json'）——返回 blobRef。 */
  plantPlan(assignments: StrategyAssignment[]): string;
  frames(): Array<Record<string, unknown>>;
  artifactNames(): string[];
  dispose(): void;
}

function setup(): LintFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  const created = [
    { sku: 'A52', sizeMm: 3, rgb: [200, 40, 40] as [number, number, number] },
    { sku: 'B53', sizeMm: 3, rgb: [90, 120, 200] as [number, number, number] },
    { sku: 'J51', sizeMm: 2, rgb: [240, 240, 232] as [number, number, number] },
  ].map((spec) =>
    stones.createStone({
      ownerId: s.anonymous.id,
      supplierProfile: YUHANG_PROFILE,
      draft: {
        name: `${spec.sku} 钻`,
        sku: spec.sku,
        sizeMm: spec.sizeMm,
        color: { name: '测试色', rgb: spec.rgb, family: '测试系', finish: 'glossy' },
        texture: { declaredWidth: 128, declaredHeight: 128 },
      },
      textureBytes: textureBytes(),
    }),
  );
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'lint 单源测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const tree = lintTree();
  const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
  const manifests = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs });
  const workbench = new TaskWorkbench({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    engineLayout: strategyEngineDelegate,
  });
  return {
    s,
    manifests,
    workbench,
    sessionId,
    taskId: task.id,
    treeBlobRef,
    a52: created[0]!.resourceId,
    b53: created[1]!.resourceId,
    j51: created[2]!.resourceId,
    seedManifest: () => {
      const materialized = materializeStoneRef({ db: s.db, blobs: s.blobs }, created[2]!.resourceId);
      manifests.writeManifest(s.anonymous, {
        sessionId,
        taskId: task.id,
        expectedRevision: 0,
        build: () => ({
          sourceSet: null,
          entries: [
            {
              stoneRef: created[2]!.resourceId,
              pick: materialized.pick,
              stoneRevision: materialized.stoneRevision,
              stoneJsonBlobRef: materialized.stoneJsonBlobRef,
              textureBlobRef: materialized.textureBlobRef,
              shapeAssetBlobRef: null,
              quantity: 10,
              origin: 'manual-add',
            },
          ],
        }),
      });
    },
    plantPlan: (assignments) => {
      const plan = StrategyPlanSchema.parse({
        kind: 'strategy-plan',
        formatVersion: 1,
        objectTreeRef: treeBlobRef,
        assignments,
        createdAt: '2026-09-29T00:00:00.000Z',
      });
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(plan), 'utf8')).hash;
      s.jobs.emitFor(task.id, 'artifact', { name: STRATEGY_PLAN_ARTIFACT_NAME, blobRef });
      return blobRef;
    },
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
    artifactNames: () =>
      s.jobs.frames(s.anonymous, task.id, 0).frames
        .filter((frame) => frame.kind === 'artifact')
        .map((frame) => (frame.payload as { name: string }).name),
    dispose: () => s.dispose(),
  };
}

/** StonePick 字面量（lint 只消费 resourceId——物料真源归 manifest/库回填面）。 */
function pickOf(resourceId: string, sku = 'X'): StrategyAssignment['stones'][number] {
  return { resourceId, sku, supplier: 'yuhang', sizeMm: 2, colorHex: '#AABBCC' };
}

/** assignments 字面量（exclusion 无 stones 合法——plan schema 全段过面）。 */
function assignmentOf(nodeId: string, stones: StrategyAssignment['stones']): StrategyAssignment {
  return {
    nodeId,
    strategyKind: stones.length > 0 ? 'texture-fill' : 'exclusion',
    params: stones.length > 0 ? { mode: 'scatter', polarity: 'dark-dense' } : {},
    stones,
    densityPerCm2: 2.3,
    rationale: '测试指派',
  };
}

async function detailOf(f: LintFixture): Promise<Record<string, unknown>> {
  const client = clientFor(f.s.context({ token: await f.s.tokenFor() }));
  return client.task.detail({ taskId: f.taskId }) as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------- [1] 四分类

describe('lintAssignments 四分类（A3 判定序）', () => {
  it('manifest×plan×库三源：introduced/unintroduced/unresolvable/unused 全分类+计数+nodeIds', () => {
    const f = setup();
    try {
      f.seedManifest();
      const computation = lintAssignments(
        { db: f.s.db, blobs: f.s.blobs },
        {
          sessionId: f.sessionId,
          assignments: [
            assignmentOf('n-hat', [pickOf(f.j51, 'J51'), pickOf(f.a52, 'A52')]),
            assignmentOf('n-person', [pickOf(f.a52, 'A52'), pickOf('stn-gone')]),
          ],
        },
      );
      expect(computation).not.toBeNull();
      expect(computation!.counts).toEqual({ unintroduced: 1, unresolvable: 1, introduced: 1, unused: 0 });
      const byCategory = new Map(computation!.items.map((item) => [item.category, item] as const));
      // introduced：manifest 在场（sku/supplier 取 manifest 物化快照）+命中节点。
      expect(byCategory.get('introduced')).toMatchObject({ stoneRef: f.j51, sku: 'J51', supplier: 'yuhang', nodeIds: ['n-hat'] });
      // unintroduced：库内存在但不在 manifest（warning）——sku/supplier 回填库现状。
      expect(byCategory.get('unintroduced')).toMatchObject({ stoneRef: f.a52, sku: 'A52', supplier: 'yuhang', nodeIds: ['n-hat', 'n-person'] });
      // unresolvable：库外（hard——不能靠添加 manifest 消除）。
      expect(byCategory.get('unresolvable')).toMatchObject({ stoneRef: 'stn-gone', nodeIds: ['n-person'] });
      // 锚：manifestRevision=计算时 session-project revision。
      expect(computation!.manifestRevision).toBe(1);
      expect(typeof computation!.computedAt).toBe('string');
    } finally {
      f.dispose();
    }
  });

  it('unused：已引入未被计划引用=info（nodeIds 空）', () => {
    const f = setup();
    try {
      f.seedManifest();
      const computation = lintAssignments(
        { db: f.s.db, blobs: f.s.blobs },
        { sessionId: f.sessionId, assignments: [assignmentOf('n-hat', [pickOf(f.a52, 'A52')])] },
      );
      expect(computation!.counts).toEqual({ unintroduced: 1, unresolvable: 0, introduced: 0, unused: 1 });
      const unused = computation!.items.find((item) => item.category === 'unused')!;
      expect(unused).toMatchObject({ stoneRef: f.j51, sku: 'J51', nodeIds: [] });
    } finally {
      f.dispose();
    }
  });

  it('无 session-project 行=null（无项目语义——不产空 lint）', () => {
    const f = setup();
    try {
      expect(
        lintAssignments({ db: f.s.db, blobs: f.s.blobs }, { sessionId: f.sessionId, assignments: [assignmentOf('n-hat', [pickOf(f.j51)])] }),
      ).toBeNull();
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] 引用账本保护（A1）+软删 hard

describe('软删与引用账本（unresolvable=hard 的边界）', () => {
  it('已引入条目库内软删后仍 introduced（manifest 快照保护——A1 引用账本）；未引入引用软删→unresolvable', () => {
    const f = setup();
    try {
      f.seedManifest();
      const stones = new StoneService({ db: f.s.db, blobs: f.s.blobs });
      stones.softDelete(f.j51);
      stones.softDelete(f.a52);
      const computation = lintAssignments(
        { db: f.s.db, blobs: f.s.blobs },
        { sessionId: f.sessionId, assignments: [assignmentOf('n-hat', [pickOf(f.j51, 'J51'), pickOf(f.a52, 'A52')])] },
      );
      // j51：manifest 在场→introduced（项目持有物化快照，库软删不破坏）。
      // a52：不在 manifest 且库内软删→unresolvable（hard）。
      expect(computation!.counts).toEqual({ unintroduced: 0, unresolvable: 1, introduced: 1, unused: 0 });
      expect(computation!.items.find((item) => item.stoneRef === f.a52)?.category).toBe('unresolvable');
      expect(computation!.items.find((item) => item.stoneRef === f.j51)?.category).toBe('introduced');
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3][4] 单源函数+工件

describe('lintTaskStoneRefs 单源函数+putStoneLintArtifact 工件', () => {
  it('读 task 最新 plan→四锚组装（imageId 缺省 image-1——单图现状冻结）+工件+帧', () => {
    const f = setup();
    try {
      f.seedManifest();
      expect(lintTaskStoneRefs({ db: f.s.db, blobs: f.s.blobs, config: f.s.config }, { sessionId: f.sessionId, sourceTaskId: f.taskId })).toBeNull(); // 尚无 plan
      const planRef = f.plantPlan([assignmentOf('n-hat', [pickOf(f.j51, 'J51'), pickOf(f.a52, 'A52')])]);
      const linted = lintTaskStoneRefs(
        { db: f.s.db, blobs: f.s.blobs, config: f.s.config },
        { sessionId: f.sessionId, sourceTaskId: f.taskId },
      );
      expect(linted).not.toBeNull();
      // 四锚：manifestRevision/planRef/sourceTaskId/imageId（缺省 image-1）。
      expect(linted!.lint).toMatchObject({
        kind: 'stones-lint',
        manifestRevision: 1,
        planRef,
        sourceTaskId: f.taskId,
        imageId: DEFAULT_LINT_IMAGE_ID,
      });
      expect(linted!.result.summary.counts).toEqual({ unintroduced: 1, unresolvable: 0, introduced: 1, unused: 0 });
      // 工件+帧（latest-by-name）。
      const put = putStoneLintArtifact({ db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs }, { taskId: f.taskId, lint: linted!.lint });
      expect(put.blobRef).toBeTruthy();
      expect(put.frameEmitted).toBe(true);
      const refs = latestTaskArtifactRefs(f.s.config, f.taskId);
      expect(refs.get(STONES_LINT_ARTIFACT_NAME)).toBe(put.blobRef);
      expect(refs.get(STRATEGY_PLAN_ARTIFACT_NAME)).toBe(planRef);
      // 工件 blob round-trip=StoneLint 契约体。
      const doc = JSON.parse(f.s.blobs.read(put.blobRef!)!.toString('utf8')) as StoneLint;
      expect(doc.items.map((item) => item.category).sort()).toEqual(['introduced', 'unintroduced']);
    } finally {
      f.dispose();
    }
  });

  it('imageId 透传锚定（多图参数面——数据源单图现状冻结，见 project-lint.ts 头注）', () => {
    const f = setup();
    try {
      f.seedManifest();
      const planRef = f.plantPlan([assignmentOf('n-hat', [pickOf(f.j51, 'J51')])]);
      const linted = lintTaskStoneRefs(
        { db: f.s.db, blobs: f.s.blobs, config: f.s.config },
        { sessionId: f.sessionId, sourceTaskId: f.taskId, imageId: 'image-2' },
      );
      expect(linted!.lint).toMatchObject({ planRef, imageId: 'image-2' });
      const computation = lintAssignments(
        { db: f.s.db, blobs: f.s.blobs },
        { sessionId: f.sessionId, assignments: [assignmentOf('n-hat', [pickOf(f.j51, 'J51')])] },
      )!;
      expect(stoneLintArtifactOf(computation, { sourceTaskId: f.taskId, imageId: 'image-2', planRef }).imageId).toBe('image-2');
      expect(stoneLintResultOf(computation).summary.manifestRevision).toBe(1);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] 读面漂移

describe('lintSummaryForTaskDetail 读面（漂移重算——A3「不能展示旧的已消除」）', () => {
  it('工件新鲜直读；manifest revision 漂移→现算；plan 漂移→现算；无 plan=null', () => {
    const f = setup();
    try {
      f.seedManifest();
      const planRef = f.plantPlan([assignmentOf('n-hat', [pickOf(f.j51, 'J51'), pickOf(f.a52, 'A52')])]);
      const linted = lintTaskStoneRefs(
        { db: f.s.db, blobs: f.s.blobs, config: f.s.config },
        { sessionId: f.sessionId, sourceTaskId: f.taskId },
      )!;
      putStoneLintArtifact({ db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs }, { taskId: f.taskId, lint: linted.lint });
      const lintRef = latestTaskArtifactRefs(f.s.config, f.taskId).get(STONES_LINT_ARTIFACT_NAME)!;
      const assignments = [assignmentOf('n-hat', [pickOf(f.j51, 'J51'), pickOf(f.a52, 'A52')])];
      // 新鲜（双锚未漂移）：工件 summary 直读（computedAt=工件值）。
      const fresh = lintSummaryForTaskDetail(
        { db: f.s.db, blobs: f.s.blobs },
        { sessionId: f.sessionId, latestPlanRef: planRef, latestLintRef: lintRef, assignments },
      );
      expect(fresh).toMatchObject({ manifestRevision: 1, counts: { unintroduced: 1, introduced: 1 } });
      expect(fresh!.computedAt).toBe(linted.lint.computedAt);
      // manifest 漂移（A52 经 manifest 追加——writeManifest rev+1）→现算：warning 消失。
      const materialized = materializeStoneRef({ db: f.s.db, blobs: f.s.blobs }, f.a52);
      f.manifests.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 1,
        build: (current) => ({
          sourceSet: current!.sourceSet,
          entries: [
            ...current!.entries,
            {
              stoneRef: f.a52,
              pick: materialized.pick,
              stoneRevision: materialized.stoneRevision,
              stoneJsonBlobRef: materialized.stoneJsonBlobRef,
              textureBlobRef: materialized.textureBlobRef,
              shapeAssetBlobRef: null,
              quantity: 0,
              origin: 'manual-add',
            },
          ],
        }),
      });
      const drifted = lintSummaryForTaskDetail(
        { db: f.s.db, blobs: f.s.blobs },
        { sessionId: f.sessionId, latestPlanRef: planRef, latestLintRef: lintRef, assignments },
      );
      expect(drifted).toMatchObject({ manifestRevision: 2, counts: { unintroduced: 0, introduced: 2 } });
      expect(drifted!.computedAt).not.toBe(linted.lint.computedAt); // 现算时间戳
      // plan 漂移（新 plan 帧引用 B53——rpc 面以当前 plan 的 assignments 传入）→现算。
      const planRef2 = f.plantPlan([assignmentOf('n-hat', [pickOf(f.b53, 'B53')])]);
      const planDrift = lintSummaryForTaskDetail(
        { db: f.s.db, blobs: f.s.blobs },
        { sessionId: f.sessionId, latestPlanRef: planRef2, latestLintRef: lintRef, assignments: [assignmentOf('n-hat', [pickOf(f.b53, 'B53')])] },
      );
      expect(planDrift!.counts).toMatchObject({ unintroduced: 1, unresolvable: 0, introduced: 0, unused: 2 });
      // 无 plan（assignments 空）=null——lint 无数据源。
      expect(
        lintSummaryForTaskDetail(
          { db: f.s.db, blobs: f.s.blobs },
          { sessionId: f.sessionId, latestPlanRef: null, latestLintRef: lintRef, assignments: [] },
        ),
      ).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('lint 工件损坏→现算不放大（派生工件——真源是 manifest×plan×库）', () => {
    const f = setup();
    try {
      f.seedManifest();
      const planRef = f.plantPlan([assignmentOf('n-hat', [pickOf(f.j51, 'J51')])]);
      const linted = lintTaskStoneRefs(
        { db: f.s.db, blobs: f.s.blobs, config: f.s.config },
        { sessionId: f.sessionId, sourceTaskId: f.taskId },
      )!;
      const put = putStoneLintArtifact({ db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs }, { taskId: f.taskId, lint: linted.lint });
      // 物理覆写工件 blob（模拟腐蚀）→ 读面现算（不放大）。
      writeFileSync(f.s.blobs.pathFor(put.blobRef!) as string, 'corrupt{');
      const summary = lintSummaryForTaskDetail(
        { db: f.s.db, blobs: f.s.blobs },
        { sessionId: f.sessionId, latestPlanRef: planRef, latestLintRef: put.blobRef!, assignments: [assignmentOf('n-hat', [pickOf(f.j51, 'J51')])] },
      );
      expect(summary).toMatchObject({ manifestRevision: 1, counts: { introduced: 1 } });
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [6] 接线③ layer.strategy.set

describe('layer.strategy.set lint 接线（A3 接线③）', () => {
  it('直改成功结果内嵌 lint+stones-lint.json 工件；warning 不把直改变 error', () => {
    const f = setup();
    try {
      f.seedManifest();
      const out = f.workbench.setNodeStrategy({
        taskId: f.taskId,
        treeBlobRef: f.treeBlobRef,
        planBlobRef: null,
        nodeId: 'n-hat',
        strategyKind: 'texture-fill',
        params: { mode: 'scatter', polarity: 'dark-dense' },
        // stone_index 稳定序：A52=1 / B53=2 / J51=3——选未引入的 A52 出 warning。
        stoneIdx: [1],
        densityPerCm2: 2,
      });
      expect(out.gems.count).toBeGreaterThan(0); // 直改成功（warning 不挡）
      expect(out.lint).not.toBeNull();
      expect(out.lint!.summary.counts).toEqual({ unintroduced: 1, unresolvable: 0, introduced: 0, unused: 1 });
      expect(out.lint!.items[0]).toMatchObject({ category: 'unintroduced', stoneRef: f.a52, sku: 'A52', nodeIds: ['n-hat'] });
      expect(f.artifactNames()).toContain(STONES_LINT_ARTIFACT_NAME);
      // 工件锚=刚落档的 plan（latest-by-name 同值）。
      const refs = latestTaskArtifactRefs(f.s.config, f.taskId);
      const lintDoc = JSON.parse(f.s.blobs.read(refs.get(STONES_LINT_ARTIFACT_NAME)!)!.toString('utf8')) as StoneLint;
      expect(lintDoc.planRef).toBe(refs.get(STRATEGY_PLAN_ARTIFACT_NAME));
      expect(lintDoc.sourceTaskId).toBe(f.taskId);
      expect(lintDoc.manifestRevision).toBe(1);
    } finally {
      f.dispose();
    }
  });

  it('无 session-project 行（无项目语义）：lint=null 且不落工件——直改不炸', () => {
    const f = setup();
    try {
      const out = f.workbench.setNodeStrategy({
        taskId: f.taskId,
        treeBlobRef: f.treeBlobRef,
        planBlobRef: null,
        nodeId: 'n-hat',
        strategyKind: 'texture-fill',
        params: { mode: 'scatter', polarity: 'dark-dense' },
        stoneIdx: [1],
        densityPerCm2: 2,
      });
      expect(out.gems.count).toBeGreaterThan(0);
      expect(out.lint).toBeNull();
      expect(f.artifactNames()).not.toContain(STONES_LINT_ARTIFACT_NAME);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [7] task.detail 点亮+exportGate 分离

describe('task.detail projectStones.lint 点亮（rpc 面）+exportGate 政策分离', () => {
  it('plan+manifest 在场→lint 摘要投影；lint warning 不影响 exportGate（安全门/政策分离——3.3）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      const client = clientFor(f.s.context({ token: await f.s.tokenFor() }));
      // 无 plan：lint=null（projectStones 在场——manifest 摘要）。
      const before = (await client.task.detail({ taskId: f.taskId })) as unknown as Record<string, unknown>;
      const stonesBefore = before['projectStones'] as Record<string, unknown>;
      expect(stonesBefore).toMatchObject({ revision: 1, entryCount: 1 });
      expect(stonesBefore['lint']).toBeNull();
      // plan 引用未引入 A52→lint warning 可见；exportGate 不受 lint 影响（allowed）。
      f.plantPlan([assignmentOf('n-hat', [pickOf(f.j51, 'J51'), pickOf(f.a52, 'A52')])]);
      const after = (await detailOf(f)) as Record<string, unknown>;
      const projectStones = after['projectStones'] as Record<string, unknown>;
      const lint = projectStones['lint'] as Record<string, unknown>;
      expect(lint).toMatchObject({ manifestRevision: 1, counts: { unintroduced: 1, introduced: 1, unused: 0, unresolvable: 0 } });
      const exportGate = after['exportGate'] as { allowed: boolean; blockers: string[] };
      expect(exportGate.allowed).toBe(true); // mask/spacing 安全门与 lint 政策分离
      expect(exportGate.blockers).toEqual([]);
    } finally {
      f.dispose();
    }
  });
});
