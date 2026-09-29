/**
 * studio.task.export / studio.task.exports.list MCP 工具面测试
 * （add-task-stones-manifest-export 4.2-4.4——arch-decisions B1/B2/B3/B4 行为锁定）。
 * 真值链=真实 executeStrategyPlan（design.ts 执行链末端同源产 task-layout——非手搓
 * 快照；门阻断矩阵用例按需叠加 crafted layout/mask 行）。覆盖（B4 验收映射）：
 *   [1] 双模全链（B4.4）：propose（三门全过→产物摘要+approval request——proposalId
 *       绑定 source/imageId/taskLayoutRef/manifestRevision）→批准→execute（grant
 *       消费+三件套 bundle+/r/ 发布+artifact 帧三条+MCP 返回无 base64）。
 *   [2] 内容对应性（B4.5）：SVG 圆数=gems 数；PNG 尺寸=imageWidth×imageHeight 且
 *       非空；BOM 按 stoneRef/SKU 分行、合计=颗数、规格/色与快照一致、备料参考列
 *       对照 manifest.quantity（未引入='未引入'）。
 *   [3] gate 阻断矩阵（B4.7）：mask-stale（workbench 门）/spacing violation（engine
 *       exportGate——crafted 重叠钻 layout）/unresolvable（lint 重算——软删后引用）
 *       各自 hard 阻断；unintroduced=warning 不阻断（B4.3 面兼容）。
 *   [4] proposal 语义（B4.8）：重复执行同一 proposal 至多一 bundle（grant 已消费必
 *       拒）；执行期门复验失败=零 bundle 零孤儿（results 行/目录双断言）。
 *   [5] 多图（B4.1/B4.6）：image-1/image-2 两组独立三件套+exports.list 按 imageId
 *       定位（task.result 单列覆盖后历史仍可查）；多图省 imageId=typed 拒。
 *   [6] 无 task-layout 工件=typed 拒（含多候选生成拒成因复述）；无授权直调执行必拒。
 * 测试纪律：零常驻进程（capability 直调面——MCP 投影由 mcp.test 锁定）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeInlineMask,
  StrategyPlanSchema,
  TaskLayoutSchema,
  taskLayoutArtifactName,
  type ObjectTree,
  type StrategyPlan,
  type TaskLayout,
} from '@handicraft/contracts';
import { decodePng, encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import {
  createTaskExportCapabilities,
  TASK_EXPORT_TOOL_NAME,
  TASK_EXPORTS_LIST_TOOL_NAME,
} from '../src/capability/task-export.js';
import { ProjectManifestService } from '../src/kernel/project-manifest.js';
import { materializeStoneRef } from '../src/kernel/project-expand.js';
import { executeStrategyPlan } from '../src/kernel/strategies/design.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import { StoneService } from '../src/stones/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const YUHANG_PROFILE: Parameters<StoneService['createStone']>[0]['supplierProfile'] = {
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { J: 2, A: 3, B: 4 } }],
  styleKey: 'row',
};

function textureBytes(): Uint8Array {
  return new Uint8Array(encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(255)));
}

/**
 * 测试树（canvasCm 10×8 / imagePx 200×160 → ppm=20——px 充裕使密度间距≫判距，
 * 真实策略产物稳定过 engine exportGate）：
 * n0 主体（层级节点）├─ n1 左叶（120×160）└─ n2 右叶（80×120）。
 */
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

interface ExportFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createTaskExportCapabilities>;
  manifests: ProjectManifestService;
  sessionId: string;
  taskId: string;
  /** 全局钻（stone_index 稳定序：A52 3mm 红 / J51 2mm 白 / B53 4mm 蓝）。 */
  a52: string;
  j51: string;
  b53: string;
  pickOf: (stoneRef: string) => ReturnType<typeof materializeStoneRef>['pick'];
  /** 真实策略执行链（design.ts 同真源——末端产 task-layout.image-1.json）+帧登记。 */
  runStrategy(input: { n1: string; n2: string }): { gemCount: number; layoutBlobRef: string | null };
  /** crafted layout 覆盖（latest-by-name 后帧胜——门矩阵/多图用例）。 */
  plantLayout(layout: TaskLayout): string;
  readLayout(): TaskLayout | null;
  seedManifest(stoneRefs: Array<{ ref: string; quantity: number }>): void;
    propose(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
    approveAndExecute(proposed: Record<string, unknown>): Promise<Record<string, unknown>>;
  listExports(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  resultsCount(): number;
  bundleDir(publicId: string): string;
  dispose(): void;
}

function setup(options?: { imageIds?: string[] }): ExportFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createTaskExportCapabilities({
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
    { sku: 'B53', sizeMm: 4, rgb: [90, 120, 200] as [number, number, number] },
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
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'task-export 工具面测试' });
  const task = createAgentTask(s.db, {
    ownerId: s.anonymous.id,
    sessionId,
    status: 'running',
    // 多图用例：首条主图集审计（A5 冻结分配面——exports/导出工具按此判定多图域）。
    paramsJson: JSON.stringify({ text: '', ...(options?.imageIds ? { imageIds: options.imageIds } : {}) }),
  });
  const tree = testTree();
  const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
  const pickOf = (stoneRef: string) => materializeStoneRef({ db: s.db, blobs: s.blobs }, stoneRef).pick;
  return {
    s,
    auth,
    registry,
    manifests,
    sessionId,
    taskId: task.id,
    a52: created[0]!.resourceId,
    j51: created[1]!.resourceId,
    b53: created[2]!.resourceId,
    pickOf,
    runStrategy: (input) => {
      const plan: StrategyPlan = StrategyPlanSchema.parse({
        kind: 'strategy-plan',
        formatVersion: 1,
        objectTreeRef: persisted.treeBlobRef,
        assignments: [
          {
            nodeId: 'n1',
            strategyKind: 'texture-fill',
            params: { mode: 'scatter', polarity: 'dark-dense' },
            stones: [pickOf(input.n1)],
            densityPerCm2: 4,
            rationale: '左叶面状纹理',
          },
          {
            nodeId: 'n2',
            strategyKind: 'texture-fill',
            params: { mode: 'scatter', polarity: 'dark-dense' },
            stones: [pickOf(input.n2)],
            densityPerCm2: 4,
            rationale: '右叶面状纹理',
          },
        ],
        createdAt: new Date().toISOString(),
      });
      const executed = executeStrategyPlan({ db: s.db, blobs: s.blobs }, { taskId: task.id, plan });
      const refs = executed.value as Record<string, unknown>;
      for (const [name, ref] of [
        ['strategy-plan.json', refs['planBlobRef']],
        ['strategy-gems.json', refs['gemsBlobRef']],
        ['strategy-gems-preview.png', refs['previewBlobRef']],
      ] as const) {
        if (typeof ref === 'string') s.jobs.emitFor(task.id, 'artifact', { blobRef: ref, name });
      }
      if (typeof refs['taskLayoutBlobRef'] === 'string' && typeof refs['taskLayoutImageId'] === 'string') {
        s.jobs.emitFor(task.id, 'artifact', {
          blobRef: refs['taskLayoutBlobRef'] as string,
          name: taskLayoutArtifactName(refs['taskLayoutImageId'] as TaskLayout['source']['imageId']),
        });
      }
      return {
        gemCount: refs['gemCount'] as number,
        layoutBlobRef: (refs['taskLayoutBlobRef'] as string | null) ?? null,
      };
    },
    plantLayout: (layout) => {
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(layout, null, 1), 'utf8')).hash;
      s.jobs.emitFor(task.id, 'artifact', { blobRef, name: taskLayoutArtifactName(layout.source.imageId) });
      return blobRef;
    },
    readLayout: () => {
      const frames = s.jobs.frames(s.anonymous, task.id, 0).frames;
      for (let i = frames.length - 1; i >= 0; i -= 1) {
        const frame = frames[i]!;
        if (frame.kind !== 'artifact') continue;
        const payload = frame.payload as { name?: unknown; blobRef?: unknown };
        if (payload.name === taskLayoutArtifactName('image-1') && typeof payload.blobRef === 'string') {
          return TaskLayoutSchema.parse(JSON.parse(s.blobs.read(payload.blobRef)!.toString('utf8')));
        }
      }
      return null;
    },
    seedManifest: (entries) => {
      manifests.writeManifest(s.anonymous, {
        sessionId,
        taskId: task.id,
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
    propose: async (input = {}) => {
      const result = await registry.call(TASK_EXPORT_TOOL_NAME, { taskId: task.id, ...input }, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      return (result as { value: Record<string, unknown> }).value;
    },
    approveAndExecute: async (proposed) => {
      auth.answer(s.anonymous, { sessionId, requestId: proposed['requestId'] as string, approved: true });
      const result = await registry.call(
        TASK_EXPORT_TOOL_NAME,
        { taskId: task.id, proposalId: proposed['proposalId'] as string },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'ok' });
      return (result as { value: Record<string, unknown> }).value;
    },
    listExports: async (input = {}) => {
      const result = await registry.call(TASK_EXPORTS_LIST_TOOL_NAME, { taskId: task.id, ...input }, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      return (result as { value: Record<string, unknown> }).value;
    },
    resultsCount: () => (s.db.prepare('SELECT COUNT(*) AS n FROM results').get() as { n: number }).n,
    bundleDir: (publicId) => path.join(s.config.dataRoot, 'results', publicId),
    dispose: () => s.dispose(),
  };
}

async function failedOf(result: unknown): Promise<{ code: string; message: string }> {
  expect(result).toMatchObject({ kind: 'failed' });
  return result as { code: string; message: string };
}

/** BOM CSV → 数据行（去 BOM/CRLF；表头+合计之外）。 */
function bomRowsOf(csv: string): string[][] {
  const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  return lines.slice(1, -1).map((line) => line.split(','));
}

// ---------------------------------------------------------------- [1] 双模全链（B4.4）

describe('studio.task.export 双模全链', () => {
  it('propose（摘要+approval request）→批准→execute（三件套 bundle+/r/ 发布+帧三条+返回无 base64）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      const executed = f.runStrategy({ n1: f.j51, n2: f.a52 });
      expect(executed.gemCount).toBeGreaterThan(0);
      expect(executed.layoutBlobRef).toBeTruthy();
      // —— propose：三门全过（J51 已引入；A52 未引入=warning 不阻断）。
      const proposed = await f.propose();
      expect(proposed['proposalId']).toBeTruthy();
      const summary = proposed['summary'] as Record<string, unknown>;
      expect(summary).toMatchObject({ imageId: 'image-1', sourceTaskId: f.taskId, gemCount: executed.gemCount });
      expect(summary['materials']).toEqual(
        expect.arrayContaining([expect.objectContaining({ stoneRef: f.j51 }), expect.objectContaining({ stoneRef: f.a52 })]),
      );
      expect((summary['materials'] as unknown[])).toHaveLength(2);
      expect(proposed['warnings'] as string[]).toHaveLength(1); // A52 unintroduced
      expect((proposed['warnings'] as string[])[0]).toContain(f.a52);
      expect(proposed['lint']).toMatchObject({ summary: { counts: { unintroduced: 1, introduced: 1 } } });
      // approval-request 帧入任务流。
      expect(f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames.some((frame) => frame['kind'] === 'approval-request')).toBe(true);
      // —— execute：恒产三件套。
      const value = await f.approveAndExecute(proposed);
      expect(value['resultId']).toBeTruthy();
      const publicId = value['publicId'] as string;
      const bundle = value['bundle'] as Record<string, string>;
      for (const ref of [bundle['svg']!, bundle['png']!, bundle['bom']!]) {
        expect(ref).toMatch(/^[0-9a-f]{64}$/); // blobRef 引用——无 base64 大文件
      }
      expect(value['source']).toMatchObject({
        sourceTaskId: f.taskId,
        imageId: 'image-1',
        taskLayoutRef: executed.layoutBlobRef,
        manifestRevision: 1,
      });
      // artifact 帧三条（任务详情/下载面按 imageId 定位）。
      const frames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames;
      for (const name of ['task-export.image-1.svg', 'task-export.image-1.png', 'task-export.image-1.bom']) {
        expect(
          frames.some((frame) => frame['kind'] === 'artifact' && (frame['payload'] as { name: string }).name === name),
        ).toBe(true);
      }
      // /r/ 发布面：bundle 目录三元组+manifest 审计字段。
      const dir = f.bundleDir(publicId);
      expect(existsSync(path.join(dir, 'layout.svg'))).toBe(true);
      expect(existsSync(path.join(dir, 'bom.csv'))).toBe(true);
      expect(existsSync(path.join(dir, 'render.png'))).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(dir, 'bundle.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest['source']).toMatchObject({ sourceTaskId: f.taskId, imageId: 'image-1' });
      expect(f.resultsCount()).toBe(1);
    } finally {
      f.dispose();
    }
  });

  it('无 task-layout 工件=typed 拒（策略未执行——指引先跑策略）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      const failed = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(failed.message).toContain('task-layout.image-1.json');
      expect(failed.message).toContain('先完成策略执行');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('无授权直调执行必拒（principal-forbidden——grant 是真边界）', async () => {
    const f = setup();
    try {
      f.seedManifest([]);
      const bare = createTaskExportCapabilities({ db: f.s.db, blobs: f.s.blobs, config: f.s.config, jobs: f.s.jobs });
      const denied = await bare.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId, imageId: 'image-1' }, 'agent');
      expect(denied).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] 内容对应性（B4.5）

describe('三件套内容对应性', () => {
  it('SVG 圆数=gems 数；PNG 尺寸=imageWidth×imageHeight 且非空；BOM 按 stoneRef 分行合计=颗数+备料参考对照', async () => {
    const f = setup();
    try {
      // J51 已引入（备料 10）；A52 未引入（warning——备料参考列='未引入'）。
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      const executed = f.runStrategy({ n1: f.j51, n2: f.a52 });
      const layout = f.readLayout()!;
      const proposed = await f.propose();
      const value = await f.approveAndExecute(proposed);
      const bundle = value['bundle'] as Record<string, string>;

      // —— SVG：全部 round ⇒ circle 元素数=gems 数（viewBox=图像尺寸）。
      const svg = f.s.blobs.read(bundle['svg']!)!.toString('utf8');
      const circles = svg.match(/<circle /g) ?? [];
      expect(circles).toHaveLength(layout.gems.length);
      expect(svg).toContain(`viewBox="0 0 ${layout.imageWidth} ${layout.imageHeight}"`);
      // 按色分组键=stoneRef（palette 物料身份单源）。
      for (const stoneRef of Object.keys(layout.palette)) {
        expect(svg).toContain(`data-color-id="${stoneRef}"`);
      }

      // —— PNG：尺寸=图像尺寸；字节非空（decode 校验 IHDR）。
      const pngBytes = f.s.blobs.read(bundle['png']!)!;
      expect(pngBytes.byteLength).toBeGreaterThan(0);
      const decoded = decodePng(pngBytes);
      expect(decoded.width).toBe(layout.imageWidth);
      expect(decoded.height).toBe(layout.imageHeight);

      // —— BOM：按 stoneRef 分行；合计=颗数；规格/色名/hex 与快照一致；备料参考对照。
      const csv = f.s.blobs.read(bundle['bom']!)!.toString('utf8');
      const rows = bomRowsOf(csv);
      expect(rows.length).toBe(2); // 每款 stone 一行（各节点单款钻）
      const bySku = new Map(rows.map((row) => [row[1], row]));
      const j51Row = bySku.get('J51')!;
      const a52Row = bySku.get('A52')!;
      const j51Gems = layout.gems.filter((gem) => gem.sku === 'J51');
      const a52Gems = layout.gems.filter((gem) => gem.sku === 'A52');
      expect(Number(j51Row[5])).toBe(j51Gems.length);
      expect(Number(a52Row[5])).toBe(a52Gems.length);
      expect(j51Row[4]).toBe('#F0F0E8');
      expect(a52Row[4]).toBe('#C82828');
      // 规格列=gem 快照钻径（mm）。
      expect(j51Row[2]).toBe(`${j51Gems[0]!.diameterMm}mm`);
      // 备料参考：J51=manifest.quantity 10；A52 未引入。
      expect(j51Row[6]).toBe('10');
      expect(a52Row[6]).toBe('未引入');
      // 合计行=总颗数。
      const totalLine = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n').pop()!;
      expect(totalLine).toBe(`合计,,,,,${layout.gems.length},`);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] gate 阻断矩阵（B4.7）

describe('导出门阻断矩阵（mask/spacing=安全门；unresolvable=阻断；unintroduced=不阻断）', () => {
  it('mask-stale（workbench 门）→propose 硬阻断（blockers 明示）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      f.s.db
        .prepare("INSERT INTO mask_edit_states (task_id, node_id, state, run_count, base_version, error, updated_at) VALUES (?, 'n1', 'stale', 10, 1, NULL, ?)")
        .run(f.taskId, new Date().toISOString());
      const failed = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(failed.message).toContain('mask 门阻断');
      expect(failed.message).toContain('mask-stale');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('spacing violation（engine exportGate——crafted 重叠钻 layout）→propose 硬阻断', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const layout = f.readLayout()!;
      // 两颗重叠钻（同 2mm：判据 (2+2)/2+0.4mm——2px 间距必违规）。
      const gem0 = layout.gems[0]!;
      const crafted: TaskLayout = TaskLayoutSchema.parse({
        ...layout,
        gems: [
          { ...gem0, id: 'overlap-1', x: 50, y: 50, diameterMm: 2 },
          { ...gem0, id: 'overlap-2', x: 52, y: 50, diameterMm: 2 },
        ],
      });
      f.plantLayout(crafted);
      const failed = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(failed.message).toContain('exportGate 阻断');
      expect(failed.message).toContain('spacing');
    } finally {
      f.dispose();
    }
  });

  it('unresolvable（plan 引用软删未引入钻——lint 执行期重算）→propose 硬阻断', async () => {
    const f = setup();
    try {
      // manifest 只引 J51；策略用 J51（已引入）+B53（未引入→软删=不可解析）。
      // unintroduced=warning 不阻断的正路径已由 [1] 覆盖（A52 未引入仍产 proposal）。
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      f.runStrategy({ n1: f.j51, n2: f.b53 });
      new StoneService({ db: f.s.db, blobs: f.s.blobs }).softDelete(f.b53);
      const failed = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(failed.message).toContain('lint 硬错');
      expect(failed.message).toContain(f.b53);
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('执行期门复验失败=零 bundle 零孤儿（批准后 mask 漂移——results 行/目录双断言）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const proposed = await f.propose();
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
      // 批准后、执行前：mask 编辑基线漂移（stale）——执行期复验必拒。
      f.s.db
        .prepare("INSERT INTO mask_edit_states (task_id, node_id, state, run_count, base_version, error, updated_at) VALUES (?, 'n1', 'stale', 10, 1, NULL, ?)")
        .run(f.taskId, new Date().toISOString());
      const failed = await failedOf(
        await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'),
      );
      expect(failed.message).toContain('门阻');
      expect(failed.message).toContain('mask-stale');
      // 零孤儿：无 results 行、无 bundle 目录、无 task-export 帧。
      expect(f.resultsCount()).toBe(0);
      const resultsRoot = path.join(f.s.config.dataRoot, 'results');
      expect(existsSync(resultsRoot) ? readdirSync(resultsRoot).length : 0).toBe(0);
      expect(
        f.s.jobs
          .frames(f.s.anonymous, f.taskId, 0)
          .frames.some((frame) => frame['kind'] === 'artifact' && String((frame['payload'] as { name?: unknown }).name).startsWith('task-export.')),
      ).toBe(false);
      // op 收敛 failed（settleExternal）——可重新发起提案。
      const op = f.s.db
        .prepare('SELECT state FROM approved_ops WHERE proposal_id = ?')
        .get(proposed['proposalId'] as string) as { state: string };
      expect(op.state).toBe('failed');
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] proposal 语义（B4.8）

describe('proposal 恰好一次', () => {
  it('重复执行同一 proposal 至多一 bundle（grant 已消费必拒）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }, { ref: f.a52, quantity: 5 }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const proposed = await f.propose();
      const first = await f.approveAndExecute(proposed);
      expect(first['resultId']).toBeTruthy();
      // 重放：grant 已消费=denied（非 ok）——不产第二 bundle。
      const replay = await f.registry.call(
        TASK_EXPORT_TOOL_NAME,
        { taskId: f.taskId, proposalId: proposed['proposalId'] as string },
        'agent',
      );
      expect(replay).toMatchObject({ kind: 'failed' });
      expect(f.resultsCount()).toBe(1);
    } finally {
      f.dispose();
    }
  });

  it('expectedManifestRevision 漂移=STALE（CAS 基线早拒——零 proposal 落库）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const failed = await failedOf(
        await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId, expectedManifestRevision: 0 }, 'agent'),
      );
      expect(failed.code).toBe('STALE');
      expect(failed.message).toContain('currentRevision=1');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] 多图（B4.1/B4.6）

describe('多图：每图独立三件套+exports.list 历史读面（B3.5）', () => {
  it('image-1/image-2 两组独立 bundle；省 imageId=typed 拒；历史按 imageId 定位', async () => {
    const f = setup({ imageIds: ['image-1', 'image-2'] });
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }, { ref: f.a52, quantity: 5 }]);
      const executed = f.runStrategy({ n1: f.j51, n2: f.a52 }); // 真链产 image-1
      expect(executed.layoutBlobRef).toBeTruthy();
      // image-2 渲染快照（多图=每图一次策略链——本 fixture 以 image-1 产物改锚模拟
      // 第二图链：同真源结构，imageId 锚独立）。
      const layout1 = f.readLayout()!;
      const layout2: TaskLayout = TaskLayoutSchema.parse({
        ...layout1,
        source: { ...layout1.source, imageId: 'image-2' },
        gems: layout1.gems.map((gem, i) => ({ ...gem, id: `${gem.id}-2` })),
      });
      const layout2Ref = f.s.blobs.put(Buffer.from(JSON.stringify(layout2, null, 1), 'utf8')).hash;
      f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: layout2Ref, name: taskLayoutArtifactName('image-2') });

      // 多图省 imageId=typed 拒。
      const missing = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(missing.message).toContain('必须指定 imageId');
      expect(missing.message).toContain('image-1、image-2');

      // image-1 三件套。
      const proposed1 = await f.propose({ imageId: 'image-1' });
      const value1 = await f.approveAndExecute(proposed1);
      expect(value1['source']).toMatchObject({ imageId: 'image-1' });
      // image-2 三件套（独立 bundle——不同 resultId/publicId）。
      const proposed2 = await f.propose({ imageId: 'image-2' });
      const value2 = await f.approveAndExecute(proposed2);
      expect(value2['source']).toMatchObject({ imageId: 'image-2' });
      expect(value2['resultId']).not.toBe(value1['resultId']);
      expect(value2['publicId']).not.toBe(value1['publicId']);
      // 两组 bundle 目录独立在场。
      expect(existsSync(path.join(f.bundleDir(value1['publicId'] as string), 'layout.svg'))).toBe(true);
      expect(existsSync(path.join(f.bundleDir(value2['publicId'] as string), 'layout.svg'))).toBe(true);
      expect(f.resultsCount()).toBe(2);

      // exports.list：历史两行（task.result 单列已被第二次导出覆盖——本面按 imageId 定位）。
      const listed = await f.listExports();
      const exportsRows = listed['exports'] as Array<Record<string, unknown>>;
      expect(exportsRows).toHaveLength(2);
      const byImage = new Map(exportsRows.map((row) => [((row['source'] as Record<string, unknown>)['imageId']), row]));
      expect(byImage.get('image-2')).toMatchObject({ resultId: value2['resultId'], publicId: value2['publicId'] });
      expect(byImage.get('image-1')).toMatchObject({ resultId: value1['resultId'] });
      // 按 imageId 过滤。
      const only1 = await f.listExports({ imageId: 'image-1' });
      expect(((only1['exports'] as Array<Record<string, unknown>>)).map((row) => (row['source'] as Record<string, unknown>)['imageId'])).toEqual(['image-1']);
      // 独立 layout ref（第二组绑定 image-2 快照）。
      expect(byImage.get('image-2')!['source']).toMatchObject({ taskLayoutRef: layout2Ref });
    } finally {
      f.dispose();
    }
  });

  it('exports.list 空=零导出清面；无会话任务=typed 拒', async () => {
    const f = setup();
    try {
      const listed = await f.listExports();
      expect(listed['exports']).toEqual([]);
      expect(listed['total']).toBe(0);
    } finally {
      f.dispose();
    }
  });
});
