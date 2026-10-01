/**
 * 会话域工件锚（P0 任务域碎片化修复）测试——2026-10-01 真链终点首验回归锁。
 * 根因场景：一次 followup=一个新 agent task（taskId 换绑），task-layout/strategy-plan
 * 等工件按执行时任务域 fence 落档；下一轮以新 taskId 按任务域 latest-by-name 读不到
 * 上轮工件→「资源不存在」终点不可达（会话 55bc9e13：639d2b04→…→149f5eb5→f4b6721c）。
 * 修复语义锁定（latestSessionArtifactAnchor 单源 + task-export/task-stones 接线）：
 *   [A] 解析器单元：跨任务 ts 最新胜/同任务 latest-by-name/名缺席 null/跨会话不泄漏/
 *       同会话异 owner 不解析。
 *   [B] studio.task.export 多轮链：
 *       B1 轮A 执行产 layout→轮B 无 sourceTaskId 导出→命中轮A layout（含 proposal
 *          载荷/审批 summary/结果的 sourceResolution 审计绑定+execute 回放）；
 *       B2 缺省解析=全会话最近成功落档（轮A+轮B 皆有→轮C 缺省取轮B——ts 最新）；
 *       B3 显式 sourceTaskId=精确锚（取轮A 旧 layout——行为不变）；
 *       B4 显式锚 miss=任务域既有文案（不迁移到会话文案）；
 *       B5 会话无任何工件=typed 可读错误（「本会话尚无可导出的布局——先完成一轮排钻」）；
 *       B6 跨会话不泄漏（会话2 缺省解析不命中会话1 工件；显式跨会话=必拒）；
 *       B7 会话曾执行策略但无 layout=生成器曾拒诊断（会话域文案）。
 *   [C] studio.task.stones.list lint 延续：轮A plan→轮B 观察 lint 非 null（修复前
 *       恒 null——strategy 工件消费点同根因）。
 * 真值链纪律：轮A 产物走真实 executeStrategyPlan（非手搓快照）；测试零常驻进程。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  StrategyPlanSchema,
  encodeInlineMask,
  taskLayoutArtifactName,
  type ObjectTree,
  type StrategyAssignment,
  type StrategyPlan,
  type TaskLayout,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { createTaskExportCapabilities, TASK_EXPORT_TOOL_NAME } from '../src/capability/task-export.js';
import {
  createTaskStonesCapabilities,
  TASK_STONES_LIST_TOOL_NAME,
} from '../src/capability/task-stones.js';
import { ProjectManifestService } from '../src/kernel/project-manifest.js';
import { materializeStoneRef } from '../src/kernel/project-expand.js';
import { executeStrategyPlan, STRATEGY_PLAN_ARTIFACT_NAME } from '../src/kernel/strategies/design.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import { latestSessionArtifactAnchor } from '../src/kernel/session-artifacts.js';
import { StoneService } from '../src/stones/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- 共用 fixture

const YUHANG_PROFILE: Parameters<StoneService['createStone']>[0]['supplierProfile'] = {
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { J: 2, A: 3, B: 4 } }],
  styleKey: 'row',
};

function textureBytes(): Uint8Array {
  return new Uint8Array(encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(255)));
}

/** 测试树（与 capability-task-export.test.ts 同构——px 充裕使真实策略产物稳定过门）。 */
function testTree(): ObjectTree {
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 10, h: 8 },
    imagePx: { width: 200, height: 160 },
    nodes: [
      {
        id: 'n0',
        objectName: '主体',
        category: 'foliage',
        mask: encodeInlineMask(200, 160, new Uint8Array(200 * 160).fill(1)),
        bbox: { x: 0, y: 0, w: 200, h: 160 },
        parent: null,
        children: ['n1', 'n2'],
        effectiveMm: 160,
        labVariance: 18,
        drillWorthy: false,
        origin: 'vlm+sam3',
      },
      {
        id: 'n1',
        objectName: '主体·左',
        category: 'foliage',
        mask: encodeInlineMask(120, 160, new Uint8Array(120 * 160).fill(1)),
        bbox: { x: 0, y: 0, w: 120, h: 160 },
        parent: 'n0',
        children: [],
        effectiveMm: 130,
        labVariance: 9,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
      {
        id: 'n2',
        objectName: '主体·右',
        category: 'flower',
        mask: encodeInlineMask(80, 120, new Uint8Array(80 * 120).fill(1)),
        bbox: { x: 120, y: 20, w: 80, h: 120 },
        parent: 'n0',
        children: [],
        effectiveMm: 95,
        labVariance: 26,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
    ],
    createdAt: '2026-09-29T00:00:00.000Z',
  };
}

interface AnchorFixture {
  s: TestServices;
  auth: ApprovalService;
  exports: ReturnType<typeof createTaskExportCapabilities>;
  stonesTools: ReturnType<typeof createTaskStonesCapabilities>;
  sessionId: string;
  /** 全局钻（A52 3mm 红 / J51 2mm 白）。 */
  a52: string;
  j51: string;
  /** 开一轮新任务（followup 换绑 taskId 的多轮会话面）。 */
  newRoundTask(): string;
  /** 真实策略执行链（executeStrategyPlan 同真源——产四工件帧于该任务域）。 */
  runStrategyOn(taskId: string, n1: string, n2: string): { gemCount: number; layoutBlobRef: string | null };
  /** 手工落一份 strategy-plan.json 帧（不执行——B7 生成器拒诊断用）。 */
  plantPlanOn(taskId: string): void;
  seedManifest(taskId: string, entries: Array<{ ref: string; quantity: number }>): void;
  dispose(): void;
}

function setup(): AnchorFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const exports = createTaskExportCapabilities({
    db: s.db,
    blobs: s.blobs,
    config: s.config,
    jobs: s.jobs,
    approvals: auth,
  });
  const stonesTools = createTaskStonesCapabilities({
    db: s.db,
    blobs: s.blobs,
    config: s.config,
    jobs: s.jobs,
    approvals: auth,
  });
  const manifests = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs });
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  const created = [
    { sku: 'A52', sizeMm: 3, rgb: [200, 40, 40] as [number, number, number] },
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
  const { sessionId } = s.sessions.create(s.anonymous, { title: '会话域工件锚测试' });
  // 树落一次（内容寻址——轮A/轮B 计划共指同一 treeRef，与真实会话同构）。
  const firstTask = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const treeBlobRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, firstTask.id, testTree()).treeBlobRef;
  const pickOf = (stoneRef: string) => materializeStoneRef({ db: s.db, blobs: s.blobs }, stoneRef).pick;
  const planOf = (n1: string, n2: string): StrategyPlan =>
    StrategyPlanSchema.parse({
      kind: 'strategy-plan',
      formatVersion: 1,
      objectTreeRef: treeBlobRef,
      assignments: [
        {
          nodeId: 'n1',
          strategyKind: 'texture-fill',
          params: { mode: 'scatter', polarity: 'dark-dense' },
          stones: [pickOf(n1)],
          densityPerCm2: 4,
          rationale: '左叶面状纹理',
        },
        {
          nodeId: 'n2',
          strategyKind: 'texture-fill',
          params: { mode: 'scatter', polarity: 'dark-dense' },
          stones: [pickOf(n2)],
          densityPerCm2: 4,
          rationale: '右叶面状纹理',
        },
      ],
      createdAt: new Date().toISOString(),
    });
  let round = 0;
  return {
    s,
    auth,
    exports,
    stonesTools,
    sessionId,
    a52: created[0]!.resourceId,
    j51: created[1]!.resourceId,
    newRoundTask: () =>
      createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId,
        status: 'running',
        paramsJson: JSON.stringify({ text: `第 ${++round} 轮` }),
      }).id,
    runStrategyOn: (taskId, n1, n2) => {
      const executed = executeStrategyPlan(
        { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot },
        { taskId, plan: planOf(n1, n2) },
      );
      const refs = executed.value as Record<string, unknown>;
      for (const [name, ref] of [
        [STRATEGY_PLAN_ARTIFACT_NAME, refs['planBlobRef']],
        ['strategy-gems.json', refs['gemsBlobRef']],
        ['strategy-gems-preview.png', refs['previewBlobRef']],
      ] as const) {
        if (typeof ref === 'string') s.jobs.emitFor(taskId, 'artifact', { blobRef: ref, name });
      }
      if (typeof refs['taskLayoutBlobRef'] === 'string' && typeof refs['taskLayoutImageId'] === 'string') {
        s.jobs.emitFor(taskId, 'artifact', {
          blobRef: refs['taskLayoutBlobRef'] as string,
          name: taskLayoutArtifactName(refs['taskLayoutImageId'] as TaskLayout['source']['imageId']),
        });
      }
      return {
        gemCount: refs['gemCount'] as number,
        layoutBlobRef: (refs['taskLayoutBlobRef'] as string | null) ?? null,
      };
    },
    plantPlanOn: (taskId) => {
      const assignments: StrategyAssignment[] = [
        {
          nodeId: 'n-hat',
          strategyKind: 'texture-fill',
          params: { mode: 'scatter', polarity: 'dark-dense' },
          stones: [pickOf(created[0]!.resourceId), pickOf(created[1]!.resourceId)],
          densityPerCm2: 2.3,
          rationale: '测试指派（plan 仅为诊断数据源——不执行）',
        },
      ];
      const plan = StrategyPlanSchema.parse({
        kind: 'strategy-plan',
        formatVersion: 1,
        objectTreeRef: treeBlobRef,
        assignments,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(plan), 'utf8')).hash;
      s.jobs.emitFor(taskId, 'artifact', { name: STRATEGY_PLAN_ARTIFACT_NAME, blobRef });
    },
    seedManifest: (taskId, entries) => {
      manifests.writeManifest(s.anonymous, {
        sessionId,
        taskId,
        expectedRevision: 0,
        build: () => ({
          sourceSet: null,
          entries: entries.map(({ ref, quantity }) => {
            const materialized = materializeStoneRef({ db: s.db, blobs: s.blobs }, ref);
            return {
              stoneRef: ref,
              pick: materialized.pick,
              stoneRevision: materialized.stoneRevision,
              stoneJsonBlobRef: materialized.stoneJsonBlobRef,
              textureBlobRef: materialized.textureBlobRef,
              shapeAssetBlobRef: null,
              quantity,
              origin: 'manual-add' as const,
            };
          }),
        }),
      });
    },
    dispose: () => s.dispose(),
  };
}

async function okOf(result: unknown): Promise<Record<string, unknown>> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: Record<string, unknown> }).value;
}

async function failedOf(result: unknown): Promise<{ code: string; message: string }> {
  expect(result).toMatchObject({ kind: 'failed' });
  return result as { code: string; message: string };
}

// ---------------------------------------------------------------- [A] 解析器单元

describe('latestSessionArtifactAnchor（会话域最近成功工件锚）', () => {
  it('跨任务取 ts 最新；同任务内同名取最后一帧（latest-by-name）；名缺席=null', () => {
    const f = setup();
    try {
      const taskA = f.newRoundTask();
      const taskB = f.newRoundTask();
      const name = 'probe.json';
      const older = f.s.blobs.put(Buffer.from('{"v":1}', 'utf8')).hash;
      const newer = f.s.blobs.put(Buffer.from('{"v":2}', 'utf8')).hash;
      const third = f.s.blobs.put(Buffer.from('{"v":3}', 'utf8')).hash;
      // taskA：older 后 third（同任务同名——最后一帧胜）。
      f.s.jobs.emitFor(taskA, 'artifact', { name, blobRef: older });
      f.s.jobs.emitFor(taskA, 'artifact', { name, blobRef: third });
      // taskB：newer（后落帧——ts 更新）。
      f.s.jobs.emitFor(taskB, 'artifact', { name, blobRef: newer });
      const deps = { db: f.s.db, config: f.s.config };
      const anchor = latestSessionArtifactAnchor(deps, { sessionId: f.sessionId, ownerId: f.s.anonymous.id, name });
      expect(anchor).not.toBeNull();
      expect(anchor!.taskId).toBe(taskB); // ts 最新（跨任务）
      expect(anchor!.blobRef).toBe(newer);
      const inTaskALatest = latestSessionArtifactAnchor(deps, { sessionId: f.sessionId, ownerId: f.s.anonymous.id, name: 'absent.json' });
      expect(inTaskALatest).toBeNull();
      // 同任务 latest-by-name 佐证：仅 taskA 域查询（taskB 无该名工件时 taskA 最后一帧胜）。
      f.s.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskB);
      const onlyA = latestSessionArtifactAnchor(deps, { sessionId: f.sessionId, ownerId: f.s.anonymous.id, name });
      expect(onlyA!.blobRef).toBe(third);
    } finally {
      f.dispose();
    }
  });

  it('跨会话不泄漏：他会的任务域不参与解析', () => {
    const f = setup();
    try {
      const taskA = f.newRoundTask();
      f.s.jobs.emitFor(taskA, 'artifact', { name: 'probe.json', blobRef: 'a'.repeat(64) });
      const { sessionId: otherSession } = f.s.sessions.create(f.s.anonymous, { title: '另一会话' });
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession, status: 'running' }).id;
      f.s.jobs.emitFor(otherTask, 'artifact', { name: 'probe.json', blobRef: 'b'.repeat(64) });
      // 会话1 解析只见会话1 的工件。
      const inSession1 = latestSessionArtifactAnchor(
        { db: f.s.db, config: f.s.config },
        { sessionId: f.sessionId, ownerId: f.s.anonymous.id, name: 'probe.json' },
      );
      expect(inSession1!.taskId).toBe(taskA);
      // 会话2 有自己的工件——互不可见对方（taskId 归属即证）。
      const inSession2 = latestSessionArtifactAnchor(
        { db: f.s.db, config: f.s.config },
        { sessionId: otherSession, ownerId: f.s.anonymous.id, name: 'probe.json' },
      );
      expect(inSession2!.taskId).toBe(otherTask);
      // 空会话（无工件任务）=null。
      const { sessionId: emptySession } = f.s.sessions.create(f.s.anonymous, { title: '空会话' });
      expect(
        latestSessionArtifactAnchor({ db: f.s.db, config: f.s.config }, { sessionId: emptySession, ownerId: f.s.anonymous.id, name: 'probe.json' }),
      ).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('同会话异 owner 的任务域不参与解析（owner 围栏）', () => {
    const f = setup();
    try {
      const foreignId = `user-${randomUUID().slice(0, 8)}`;
      f.s.db
        .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'x', 'user', ?)")
        .run(foreignId, `u-${randomUUID().slice(0, 8)}`, new Date().toISOString());
      const foreignTask = createAgentTask(f.s.db, { ownerId: foreignId, sessionId: f.sessionId, status: 'running' }).id;
      const mine = f.newRoundTask();
      // 异 owner 任务后落帧（ts 最新）——anchor 仍只解析本 owner 的。
      f.s.jobs.emitFor(mine, 'artifact', { name: 'probe.json', blobRef: 'a'.repeat(64) });
      f.s.jobs.emitFor(foreignTask, 'artifact', { name: 'probe.json', blobRef: 'b'.repeat(64) });
      const anchor = latestSessionArtifactAnchor(
        { db: f.s.db, config: f.s.config },
        { sessionId: f.sessionId, ownerId: f.s.anonymous.id, name: 'probe.json' },
      );
      expect(anchor!.taskId).toBe(mine);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [B] export 多轮链

describe('studio.task.export 会话域缺省锚（多轮会话延续上轮排钻成果）', () => {
  it('B1 轮A 执行产 layout→轮B 无 sourceTaskId 导出→命中轮A（审计绑定贯穿 propose/审批/execute）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [
        { ref: f.j51, quantity: 10 },
        { ref: f.a52, quantity: 10 },
      ]);
      const executed = f.runStrategyOn(roundA, f.j51, f.a52);
      expect(executed.layoutBlobRef).toBeTruthy();
      const roundB = f.newRoundTask(); // followup 换绑新 taskId——旧链在此断（资源不存在）
      // —— propose（缺省 sourceTaskId）：命中轮A layout。
      const proposed = await okOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: roundB }, 'agent'));
      const summary = proposed['summary'] as Record<string, unknown>;
      expect(summary['sourceTaskId']).toBe(roundA);
      expect(summary['sourceResolution']).toBe('session-latest');
      expect((summary['anchors'] as Record<string, unknown>)['taskLayoutRef']).toBe(executed.layoutBlobRef);
      expect(summary['gemCount']).toBe(executed.gemCount);
      // —— proposal 载荷+审批 summary 审计绑定（「这次导出用的是哪轮的布局」可追溯）。
      const op = f.s.db
        .prepare('SELECT payload_json, summary FROM approved_ops WHERE proposal_id = ?')
        .get(proposed['proposalId'] as string) as { payload_json: string; summary: string };
      const payload = JSON.parse(op.payload_json) as Record<string, unknown>;
      expect(payload['sourceTaskId']).toBe(roundA);
      expect(payload['sourceResolution']).toBe('session-latest');
      expect(op.summary).toContain('会话延续');
      // —— execute（从轮B 消费 grant）：bundle 审计源=轮A 定版 layout。
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
      const value = await okOf(
        await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: roundB, proposalId: proposed['proposalId'] as string }, 'agent'),
      );
      expect(value['source']).toMatchObject({
        sourceTaskId: roundA,
        imageId: 'image-1',
        taskLayoutRef: executed.layoutBlobRef,
        sourceResolution: 'session-latest',
      });
      expect(value['download']).toMatch(/^\/r\//);
    } finally {
      f.dispose();
    }
  });

  it('B2 缺省解析=全会话最近成功落档（轮A+轮B 皆有 layout→轮C 缺省取轮B）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [
        { ref: f.j51, quantity: 10 },
        { ref: f.a52, quantity: 10 },
      ]);
      const a = f.runStrategyOn(roundA, f.j51, f.a52);
      const roundB = f.newRoundTask();
      const b = f.runStrategyOn(roundB, f.j51, f.a52); // 更近一轮排钻（ts 最新）
      expect(a.layoutBlobRef).not.toBe(b.layoutBlobRef);
      const roundC = f.newRoundTask();
      const proposed = await okOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: roundC }, 'agent'));
      const summary = proposed['summary'] as Record<string, unknown>;
      expect(summary['sourceTaskId']).toBe(roundB);
      expect(summary['sourceResolution']).toBe('session-latest');
      expect((summary['anchors'] as Record<string, unknown>)['taskLayoutRef']).toBe(b.layoutBlobRef);
    } finally {
      f.dispose();
    }
  });

  it('B3 显式 sourceTaskId=精确锚（取轮A 旧 layout——行为不变）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [
        { ref: f.j51, quantity: 10 },
        { ref: f.a52, quantity: 10 },
      ]);
      const a = f.runStrategyOn(roundA, f.j51, f.a52);
      const roundB = f.newRoundTask();
      f.runStrategyOn(roundB, f.j51, f.a52);
      const roundC = f.newRoundTask();
      const proposed = await okOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: roundC, sourceTaskId: roundA }, 'agent'));
      const summary = proposed['summary'] as Record<string, unknown>;
      expect(summary['sourceTaskId']).toBe(roundA);
      expect(summary['sourceResolution']).toBe('explicit');
      expect((summary['anchors'] as Record<string, unknown>)['taskLayoutRef']).toBe(a.layoutBlobRef);
    } finally {
      f.dispose();
    }
  });

  it('B4 显式锚 miss=任务域既有文案（不迁移会话文案）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [
        { ref: f.j51, quantity: 10 },
        { ref: f.a52, quantity: 10 },
      ]);
      f.runStrategyOn(roundA, f.j51, f.a52);
      const fresh = f.newRoundTask(); // 无任何工件的任务域
      const roundC = f.newRoundTask();
      const failed = await failedOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: roundC, sourceTaskId: fresh }, 'agent'));
      expect(failed.message).toContain(`任务 ${fresh} 尚无 ${taskLayoutArtifactName('image-1')} 渲染快照`);
      expect(failed.message).toContain('先完成策略执行');
    } finally {
      f.dispose();
    }
  });

  it('B5 会话无任何工件=typed 可读错误（本会话尚无可导出的布局——先完成一轮排钻）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [{ ref: f.j51, quantity: 10 }]);
      const roundB = f.newRoundTask();
      const failed = await failedOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: roundB }, 'agent'));
      expect(failed.message).toContain('本会话尚无可导出的布局');
      expect(failed.message).toContain(taskLayoutArtifactName('image-1'));
      expect(failed.message).toContain('先完成一轮排钻');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('B6 跨会话不泄漏：会话2 缺省解析不命中会话1 工件；显式跨会话=必拒', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [
        { ref: f.j51, quantity: 10 },
        { ref: f.a52, quantity: 10 },
      ]);
      f.runStrategyOn(roundA, f.j51, f.a52);
      // 会话2（同 owner——隔离只看会话域）。
      const { sessionId: session2 } = f.s.sessions.create(f.s.anonymous, { title: '会话2' });
      const task2 = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: session2, status: 'running' }).id;
      new ProjectManifestService({ config: f.s.config, db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs }).writeManifest(
        f.s.anonymous,
        { sessionId: session2, taskId: task2, expectedRevision: 0, build: () => ({ sourceSet: null, entries: [] }) },
      );
      const failed = await failedOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: task2 }, 'agent'));
      expect(failed.message).toContain('本会话尚无可导出的布局'); // 不见会话1 的 layout
      const denied = await failedOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: task2, sourceTaskId: roundA }, 'agent'));
      expect(denied.message).toContain('不在同一会话（跨会话导出必拒）'); // requireSourceTask 既有门
    } finally {
      f.dispose();
    }
  });

  it('B7 会话曾执行策略但无 layout=生成器曾拒诊断（会话域文案）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [{ ref: f.j51, quantity: 10 }]);
      f.plantPlanOn(roundA); // 有 plan 无 layout——生成器曾拒形态
      const roundB = f.newRoundTask();
      const failed = await failedOf(await f.exports.call(TASK_EXPORT_TOOL_NAME, { taskId: roundB }, 'agent'));
      expect(failed.message).toContain('本会话曾执行策略但无');
      expect(failed.message).toContain('生成器曾拒');
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [C] stones.list lint 延续

describe('studio.task.stones.list lint 会话域延续（strategy 工件消费点）', () => {
  it('轮A 真实执行产 plan→轮B 观察 lint 非 null（修复前恒 null）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [{ ref: f.j51, quantity: 10 }]); // A52 未引入=warning 面
      f.runStrategyOn(roundA, f.j51, f.a52);
      const roundB = f.newRoundTask();
      const value = await okOf(await f.stonesTools.call(TASK_STONES_LIST_TOOL_NAME, { taskId: roundB }, 'agent'));
      // list 响应的 lint 即 summary 投影（computedAt/manifestRevision/counts）。
      expect(value['lint']).not.toBeNull();
      expect(value['lint']).toMatchObject({ counts: { introduced: 1, unintroduced: 1 } }); // J51 已引入/A52 未引入
    } finally {
      f.dispose();
    }
  });

  it('会话从未执行策略=lint null（既有语义不变）', async () => {
    const f = setup();
    try {
      const roundA = f.newRoundTask();
      f.seedManifest(roundA, [{ ref: f.j51, quantity: 10 }]);
      const roundB = f.newRoundTask();
      const value = await okOf(await f.stonesTools.call(TASK_STONES_LIST_TOOL_NAME, { taskId: roundB }, 'agent'));
      expect(value['lint']).toBeNull();
    } finally {
      f.dispose();
    }
  });
});
