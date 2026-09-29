/**
 * studio.task.stones.list / studio.task.stones.add MCP 工具面测试
 * （add-task-stones-manifest-export 2.1-2.3——arch-decisions A4 行为锁定）。覆盖：
 *   [1] list（readonly）：manifest 摘要+lint summary+可追加候选（排除已引入/软删、
 *       query 过滤）；无项目行=typed 拒（非空清单语义）。
 *   [2] add 双模全链（2.3 主回归）：策略计划引用未引入库内钻→lint warning →
 *       propose（将添加明细+approval request——库内校验/服务端回填）→ 批准 →
 *       execute（grant 消费+revision+1+服务端物化回填+lint 工件重算）→ warning
 *       消失（A6 验收「配置 tool-result 与 stones-lint.json 都有 warning；add 后
 *       revision+1、lint warning 消失」）。
 *   [3] 并发 CAS：同 expectedRevision 两提案先后执行——一成功一 STALE（不丢对方
 *       条目）；propose 面基线漂移早拒（携 currentRevision）。
 *   [4] 库外 ref typed 拒（清单携具体 stoneRef+原因；零 proposal 落库）；软删同拒。
 *   [5] alreadyPresent 幂等：混合引用=added/alreadyPresent 分账；执行期全在场=
 *       零写不进位（revision 不前进）。
 *   [6] unresolvable（软删后引用）hard 分类呈现（lint 从 plan 取源——strategy-gems
 *       无 stoneRef 不影响）。
 * 测试纪律：零常驻进程（无 listener/MCP server——capability 直调面）。
 */
import { describe, expect, it } from 'vitest';
import {
  StrategyPlanSchema,
  encodeInlineMask,
  type StrategyAssignment,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import {
  createTaskStonesCapabilities,
  TASK_STONES_ADD_TOOL_NAME,
  TASK_STONES_LIST_TOOL_NAME,
} from '../src/capability/task-stones.js';
import { ProjectManifestService } from '../src/kernel/project-manifest.js';
import { STONES_LINT_ARTIFACT_NAME } from '../src/kernel/project-lint.js';
import { materializeStoneRef } from '../src/kernel/project-expand.js';
import { STRATEGY_PLAN_ARTIFACT_NAME } from '../src/kernel/strategies/design.js';
import { StoneService } from '../src/stones/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';

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

interface TaskStonesFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createTaskStonesCapabilities>;
  manifests: ProjectManifestService;
  sessionId: string;
  taskId: string;
  /** 候选钻（stone_index 稳定序：A52 / B53 / J51）。 */
  a52: string;
  b53: string;
  j51: string;
  /** 初版 manifest（rev1——J51 已引入，origin manual-add）。 */
  seedManifest(): void;
  /** 落 plan 工件+帧（latest-by-name）——lint 数据源。 */
  plantPlan(stoneRefs: string[]): string;
  latestLint(): Record<string, unknown> | null;
  list(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  proposeAdd(stoneRefs: string[], expectedRevision: number): Promise<Record<string, unknown>>;
  approveAndExecute(proposed: Record<string, unknown>): Promise<Record<string, unknown>>;
  manifestEntries(): Array<{ stoneRef: string; origin: string; pick: { sku: string; supplier: string } }>;
  dispose(): void;
}

function setup(): TaskStonesFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createTaskStonesCapabilities({
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
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'task-stones 工具面测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  return {
    s,
    auth,
    registry,
    manifests,
    sessionId,
    taskId: task.id,
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
    plantPlan: (stoneRefs) => {
      const assignments: StrategyAssignment[] = [
        {
          nodeId: 'n-hat',
          strategyKind: 'texture-fill',
          params: { mode: 'scatter', polarity: 'dark-dense' },
          stones: stoneRefs.map((ref, i) => ({ resourceId: ref, sku: `SKU-${i}`, supplier: 'yuhang', sizeMm: 2, colorHex: '#AABBCC' })),
          densityPerCm2: 2.3,
          rationale: '测试指派（plan 仅为 lint 数据源——不执行）',
        },
      ];
      const plan = StrategyPlanSchema.parse({
        kind: 'strategy-plan',
        formatVersion: 1,
        objectTreeRef: 'a'.repeat(64),
        assignments,
        createdAt: '2026-09-29T00:00:00.000Z',
      });
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(plan), 'utf8')).hash;
      s.jobs.emitFor(task.id, 'artifact', { name: STRATEGY_PLAN_ARTIFACT_NAME, blobRef });
      return blobRef;
    },
    latestLint: () => {
      const frames = s.jobs.frames(s.anonymous, task.id, 0).frames;
      for (let i = frames.length - 1; i >= 0; i -= 1) {
        const frame = frames[i]!;
        if (frame.kind !== 'artifact') continue;
        const payload = frame.payload as { name?: unknown; blobRef?: unknown };
        if (payload.name === STONES_LINT_ARTIFACT_NAME && typeof payload.blobRef === 'string') {
          return JSON.parse(s.blobs.read(payload.blobRef)!.toString('utf8')) as Record<string, unknown>;
        }
      }
      return null;
    },
    list: async (input = {}) =>
      okOf(await registry.call(TASK_STONES_LIST_TOOL_NAME, { taskId: task.id, ...input }, 'agent')),
    proposeAdd: async (stoneRefs, expectedRevision) =>
      okOf(await registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: task.id, expectedRevision, stoneRefs }, 'agent')),
    approveAndExecute: async (proposed) => {
      auth.answer(s.anonymous, { sessionId, requestId: proposed['requestId'] as string, approved: true });
      return okOf(await registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: task.id, proposalId: proposed['proposalId'] as string }, 'agent'));
    },
    manifestEntries: () => manifests.loadManifest(sessionId).manifest?.entries ?? [],
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

function lintCountsOf(value: Record<string, unknown>): Record<string, number> {
  const lint = value['lint'] as { summary: { counts: Record<string, number> } } | null;
  return lint === null ? {} : lint.summary.counts;
}

// ---------------------------------------------------------------- [1] list

describe('studio.task.stones.list（readonly）', () => {
  it('manifest 摘要+lint summary+可追加候选（排除已引入；query 过滤）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      f.plantPlan([f.j51, f.a52]); // lint 数据源：J51 introduced / A52 unintroduced
      const value = await f.list();
      const manifest = value['manifest'] as Record<string, unknown>;
      expect(manifest).toMatchObject({ revision: 1, entryCount: 1, sourceSet: null });
      expect(manifest['entries']).toEqual([
        expect.objectContaining({ stoneRef: f.j51, sku: 'J51', supplier: 'yuhang', quantity: 10, origin: 'manual-add' }),
      ]);
      // lint summary（A4：list 面=摘要——明细归 plan 响应/lint 工件）。
      expect(value['lint']).toMatchObject({
        manifestRevision: 1,
        counts: { unintroduced: 1, unresolvable: 0, introduced: 1, unused: 0 },
      });
      // 可追加候选：排除已引入 J51；含 A52/B53（共享库投影摘要五字段）。
      const candidates = value['candidates'] as Array<Record<string, unknown>>;
      expect(candidates.map((c) => c['stoneRef'])).toEqual([f.a52, f.b53]);
      expect(candidates[0]).toMatchObject({ stoneRef: f.a52, sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' });
      // query 过滤（B53 子串）。
      const filtered = await f.list({ query: 'B53' });
      expect((filtered['candidates'] as Array<Record<string, unknown>>).map((c) => c['stoneRef'])).toEqual([f.b53]);
      // 软删除目不入候选。
      new StoneService({ db: f.s.db, blobs: f.s.blobs }).softDelete(f.b53);
      const afterTrash = await f.list();
      expect((afterTrash['candidates'] as Array<Record<string, unknown>>).map((c) => c['stoneRef'])).toEqual([f.a52]);
    } finally {
      f.dispose();
    }
  });

  it('会话尚无项目行=typed 拒（首条常规消息创建项目后才能观察）', async () => {
    const f = setup();
    try {
      const failed = await failedOf(await f.registry.call(TASK_STONES_LIST_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(failed.message).toContain('尚无项目钻清单');
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] add 全链（2.3 主回归）

describe('studio.task.stones.add 双模全链（lint warning→add→warning 消失）', () => {
  it('propose（将添加明细+approval request+库内校验+回填预览）→批准→执行（revision+1+物化回填+lint 工件重算）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      f.plantPlan([f.j51, f.a52]);
      // —— propose：明细预览（服务端回填 sku/supplier——模型只给 stoneRef 身份）。
      const proposed = await f.proposeAdd([f.j51, f.a52], 1);
      expect(proposed['proposalId']).toBeTruthy();
      const preview = proposed['preview'] as Record<string, unknown>;
      expect(preview['currentRevision']).toBe(1);
      expect(preview['alreadyPresent']).toEqual([f.j51]);
      expect(preview['toAdd']).toEqual([
        expect.objectContaining({ stoneRef: f.a52, sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }),
      ]);
      // approval-request 帧入任务流（A4「先与用户讨论再添加」提示层）。
      const request = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames.find((frame) => frame['kind'] === 'approval-request');
      expect(request).toBeTruthy();
      // 批准前库内零变更（manifest 不动）。
      expect(f.manifests.loadManifest(f.sessionId).revision).toBe(1);
      // —— execute：revision+1+alreadyPresent 分账+服务端物化（origin manual-add）。
      const executed = await f.approveAndExecute(proposed);
      expect(executed['added']).toEqual([f.a52]);
      expect(executed['alreadyPresent']).toEqual([f.j51]);
      expect(executed['revision']).toBe(2);
      const entries = f.manifestEntries();
      expect(entries.map((entry) => entry.stoneRef)).toEqual([f.j51, f.a52]);
      expect(entries[1]).toMatchObject({ origin: 'manual-add', pick: { sku: 'A52', supplier: 'yuhang' } });
      // —— lint warning 消失：响应内嵌+stones-lint.json 工件（manifestRevision=2）。
      expect(lintCountsOf(executed)).toEqual({ unintroduced: 0, unresolvable: 0, introduced: 2, unused: 0 });
      const lintDoc = f.latestLint();
      expect(lintDoc).toMatchObject({
        kind: 'stones-lint',
        manifestRevision: 2,
        sourceTaskId: f.taskId,
        imageId: 'image-1',
      });
      expect((lintDoc!['items'] as Array<{ category: string }>).map((item) => item.category)).toEqual(['introduced', 'introduced']);
      // list 面复核：warning 消失（读面与工件一致——A3「不展示旧的已消除」）。
      const listed = await f.list();
      expect(listed['lint']).toMatchObject({ manifestRevision: 2, counts: { unintroduced: 0, introduced: 2 } });
      // manifest artifact 帧补发（writeManifestTx 事务外单点——A1 纪律）。
      const manifestFrames = f.s.jobs
        .frames(f.s.anonymous, f.taskId, 0)
        .frames.filter((frame) => frame['kind'] === 'artifact' && (frame['payload'] as { name: string }).name === 'stones-manifest.json');
      expect(manifestFrames.length).toBeGreaterThanOrEqual(2);
    } finally {
      f.dispose();
    }
  });

  it('无授权直调执行必拒（无 proposalId 的 add=principal-forbidden——grant 是真边界）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      const registry = createTaskStonesCapabilities({ db: f.s.db, blobs: f.s.blobs, config: f.s.config, jobs: f.s.jobs });
      const denied = await registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: f.taskId, expectedRevision: 1, stoneRefs: [f.a52] }, 'agent');
      expect(denied).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] 并发 CAS

describe('并发 add 同 expectedRevision（A6 验收：只允许一个成功，不丢对方条目）', () => {
  it('两提案同基线：先执行成功（rev+1）；后执行 STALE（携 currentRevision）且零副作用', async () => {
    const f = setup();
    try {
      f.seedManifest();
      const first = await f.proposeAdd([f.a52], 1);
      const second = await f.proposeAdd([f.b53], 1);
      const executedFirst = await f.approveAndExecute(first);
      expect(executedFirst['added']).toEqual([f.a52]);
      expect(executedFirst['revision']).toBe(2);
      // 第二提案（基线 rev1）执行：CAS 必拒 STALE——先批准再执行仍拒（执行期权威判定）。
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: second['requestId'] as string, approved: true });
      const stale = await failedOf(
        await f.registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: f.taskId, proposalId: second['proposalId'] as string }, 'agent'),
      );
      expect(stale.code).toBe('STALE');
      expect(stale.message).toContain('currentRevision=2');
      // 不丢对方条目：manifest 仍只含 J51+A52（B53 未写入）；revision 不前进。
      expect(f.manifests.loadManifest(f.sessionId).revision).toBe(2);
      expect(f.manifestEntries().map((entry) => entry.stoneRef)).toEqual([f.j51, f.a52]);
    } finally {
      f.dispose();
    }
  });

  it('propose 面基线漂移早拒（STALE 携 currentRevision——不发起必败 proposal）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      const stale = await failedOf(
        await f.registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: f.taskId, expectedRevision: 0, stoneRefs: [f.a52] }, 'agent'),
      );
      expect(stale.code).toBe('STALE');
      expect(stale.message).toContain('currentRevision=1');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] 库外/软删 typed 拒

describe('库内校验（A4：只能添加系统已有钻——服务端真边界）', () => {
  it('库外 ref typed 拒（清单携具体 stoneRef；零 proposal 落库）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      const failed = await failedOf(
        await f.registry.call(
          TASK_STONES_ADD_TOOL_NAME,
          { taskId: f.taskId, expectedRevision: 1, stoneRefs: [f.a52, 'no-such-stone-ref'] },
          'agent',
        ),
      );
      expect(failed.message).toContain('no-such-stone-ref');
      expect(failed.message).toContain('只能添加系统已有钻');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('软删 ref typed 拒（回收站内——先恢复再引入）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      new StoneService({ db: f.s.db, blobs: f.s.blobs }).softDelete(f.a52);
      const failed = await failedOf(await f.registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: f.taskId, expectedRevision: 1, stoneRefs: [f.a52] }, 'agent'));
      expect(failed.message).toContain('软删');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] alreadyPresent 幂等

describe('alreadyPresent 幂等语义', () => {
  it('propose 全在场=typed 拒（不发起空 proposal）；执行期全在场=零写不进位', async () => {
    const f = setup();
    try {
      f.seedManifest();
      // propose 面：全部 alreadyPresent——幂等拒绝。
      const rejected = await failedOf(
        await f.registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: f.taskId, expectedRevision: 1, stoneRefs: [f.j51] }, 'agent'),
      );
      expect(rejected.message).toContain('已在项目清单中');
      // 执行期幂等：提案 A52（基线 rev1）；执行前经第二写面（并发面模拟）引入 A52。
      const proposed = await f.proposeAdd([f.a52], 1);
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
              quantity: 5,
              origin: 'manual-add',
            },
          ],
        }),
      });
      const executed = await f.approveAndExecute(proposed);
      expect(executed['added']).toEqual([]);
      expect(executed['alreadyPresent']).toEqual([f.a52]);
      expect(executed['revision']).toBe(2); // 零写不进位（并发写已到 rev2——不再前进）
      expect(f.manifestEntries()).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [6] unresolvable hard（软删后引用）

describe('unresolvable（软删后引用）=hard 分类呈现（lint 从 plan 取源）', () => {
  it('plan 引用软删钻（未引入）→lint unresolvable；已在 manifest 的软删钻仍 introduced（A1 快照保护）', async () => {
    const f = setup();
    try {
      f.seedManifest();
      // plan 引用 J51（已引入）+B53（未引入）——随后 B53 软删。
      f.plantPlan([f.j51, f.b53]);
      new StoneService({ db: f.s.db, blobs: f.s.blobs }).softDelete(f.b53);
      const value = await f.list();
      expect(value['lint']).toMatchObject({
        counts: { unintroduced: 0, unresolvable: 1, introduced: 1, unused: 0 },
      });
      // 3.3：strategy-gems 无 stoneRef 不影响——lint 数据源恒=plan（本 fixture 全程
      // 无 strategy-gems.json 工件，lint 照常四分类；gems 位置/色不参与判定）。
      const hasGemsArtifact = f.s.jobs
        .frames(f.s.anonymous, f.taskId, 0)
        .frames.some((frame) => frame['kind'] === 'artifact' && (frame['payload'] as { name?: unknown }).name === 'strategy-gems.json');
      expect(hasGemsArtifact).toBe(false);
      expect(value['lint']).toBeTruthy();
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [7] P2-2 批准的物料版本绑定

describe('add proposal 物料版本绑定（P2-2——2026-09-28 复核：批准快照 vs 实际写入）', () => {
  it('提案后编辑 stone 元数据（stoneRevision 漂移）→执行 typed STALE（零写入+op failed）；一致→成功照旧', async () => {
    const f = setup();
    try {
      f.seedManifest();
      f.plantPlan([f.j51, f.a52]);
      const proposed = await f.proposeAdd([f.a52], 1);
      // payload 携带物料版本快照（stoneRevision+源 blobRef——P2-2 绑定面）。
      const op = f.s.db
        .prepare('SELECT payload_json FROM approved_ops WHERE proposal_id = ?')
        .get(proposed['proposalId'] as string) as { payload_json: string };
      const payload = JSON.parse(op.payload_json) as {
        stoneSnapshots?: Array<{ stoneRef: string; stoneRevision: number; stoneJsonBlobRef: string; textureBlobRef: string }>;
      };
      expect(payload.stoneSnapshots).toEqual([
        expect.objectContaining({ stoneRef: f.a52, stoneRevision: 1, stoneJsonBlobRef: expect.any(String), textureBlobRef: expect.any(String) }),
      ]);
      // 批准前编辑 stone 元数据（updateStone→revision 2——批准的预览已过时）。
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
      const edited = new StoneService({ db: f.s.db, blobs: f.s.blobs }).updateStone(
        f.a52,
        { name: 'A52 改' },
        { baseRevision: 1 },
      );
      expect(edited.revision).toBe(2);
      const stale = await failedOf(
        await f.registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'),
      );
      expect(stale.code).toBe('STALE');
      expect(stale.message).toContain('物料已变更');
      expect(stale.message).toContain('请重新查看预览批准');
      // 零写入：manifest revision 不前进、条目不增。
      expect(f.manifests.loadManifest(f.sessionId).revision).toBe(1);
      expect(f.manifestEntries().map((entry) => entry.stoneRef)).toEqual([f.j51]);
      // op 收敛 failed（grant 已消费——该批准对应的预览已不存在，须重新提案）。
      const opState = f.s.db
        .prepare('SELECT state FROM approved_ops WHERE proposal_id = ?')
        .get(proposed['proposalId'] as string) as { state: string };
      expect(opState.state).toBe('failed');
      // 重执行同 proposal=grant 已消费必拒（不产第二写入）。
      const replay = await f.registry.call(TASK_STONES_ADD_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent');
      expect(replay).toMatchObject({ kind: 'failed' });
      // —— 对照组：无漂移（提案后不编辑）→成功照旧（revision+1+物化回填）。
      const again = await f.proposeAdd([f.a52], 1);
      const executed = await f.approveAndExecute(again);
      expect(executed['added']).toEqual([f.a52]);
      expect(executed['revision']).toBe(2);
    } finally {
      f.dispose();
    }
  });
});
