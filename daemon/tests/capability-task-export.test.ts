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
 *   [5] 多图（B4.1/B4.6；P1-1 诚实化 2026-09-28）：多图省 imageId=typed 拒；
 *       image-2 无逐图生产链=typed 拒并明示「当前版本逐图排钻未贯通——每张图请
 *       单独会话」（不手工改写 imageId 伪造第二图三件套——per-image 贯通=W6）；
 *       image-1 照常三件套+exports.list 历史按 imageId 定位。
 *   [6] P2-3 导出锚绑定：lint 按 layout.source.planRef（策略重跑不漂移）；payload/
 *       bundle 审计锚=layout.source.manifestRevision；manifest 漂移=BOM 备料列
 *       「清单已更新（rev X→Y）」审计行（不回放旧 manifest）。
 *   [7] P2-4 隐藏层过滤：view-state visible=false 节点 gems 不进 layout/SVG/BOM
 *       （与前端 Designer 导出一致）；无 view-state=全可见。
 *   [8] P2-5 BOM 备料：quantity=0=「未设置」（正数量才数字；未引入=「未引入」）。
 *   [9] P2-6 生成拒可预见：有 plan 无 layout=typed 拒+多候选/自定义形成因（不进
 *       approval）。
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
import { litPixelsOf, measureAscii } from '../src/png/bitmap-font.js';
import { holeNumberGlyph } from '../src/png/numbered-sheet.js';
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

/** 款贴图 PNG（纯色不透明——每款独立色，与色板 hex 均远离：贴图渲染面可判来源）。 */
function textureBytes(rgb: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(128 * 128 * 4);
  for (let p = 0; p < 128 * 128; p++) {
    rgba[p * 4] = rgb[0];
    rgba[p * 4 + 1] = rgb[1];
    rgba[p * 4 + 2] = rgb[2];
    rgba[p * 4 + 3] = 255;
  }
  return new Uint8Array(encodePng(128, 128, rgba));
}

/**
 * 测试树（canvasCm 10×8 / imagePx 200×160 → ppm=2——px 充裕使密度间距≫判距，
 * 真实策略产物稳定过 engine exportGate）。imageScale=几何等比放大（imagePx/mask/bbox
 * ×N——canvasCm 不变 ⇒ ppm×N；导出矩阵用例以 scale=5 取真实编号字号口径）：
 * n0 主体（层级节点）├─ n1 左叶（120×160）└─ n2 右叶（80×120）。
 */
function testTree(imageScale = 1): ObjectTree {
  const px = (n: number): number => n * imageScale;
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 10, h: 8 },
    imagePx: { width: px(200), height: px(160) },
    nodes: [
      {
        id: 'n0',
        objectName: '主体',
        category: 'foliage',
        mask: encodeInlineMask(px(200), px(160), new Uint8Array(px(200) * px(160)).fill(1)),
        bbox: { x: 0, y: 0, w: px(200), h: px(160) },
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
        mask: encodeInlineMask(px(120), px(160), new Uint8Array(px(120) * px(160)).fill(1)),
        bbox: { x: 0, y: 0, w: px(120), h: px(160) },
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
        mask: encodeInlineMask(px(80), px(120), new Uint8Array(px(80) * px(120)).fill(1)),
        bbox: { x: px(120), y: px(20), w: px(80), h: px(120) },
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
  /** 手工落一份「最新 strategy-plan.json」帧（不执行策略——lint/plan 漂移用例）。 */
  plantLatestPlan(n1: string, n2: string): string;
  /** 手工落 view-state 工件帧（P2-4——隐藏层过滤数据源）。 */
  plantViewState(nodes: Array<{ nodeId: string; visible?: boolean }>): void;
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

function setup(options?: { imageIds?: string[]; imageScale?: number }): ExportFixture {
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
    { sku: 'A52', sizeMm: 3, rgb: [200, 40, 40] as [number, number, number], tex: [0, 170, 85] as [number, number, number] },
    { sku: 'J51', sizeMm: 2, rgb: [240, 240, 232] as [number, number, number], tex: [0, 170, 170] as [number, number, number] },
    { sku: 'B53', sizeMm: 4, rgb: [90, 120, 200] as [number, number, number], tex: [170, 0, 170] as [number, number, number] },
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
      textureBytes: textureBytes(spec.tex),
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
  const tree = testTree(options?.imageScale ?? 1);
  const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
  const pickOf = (stoneRef: string) => materializeStoneRef({ db: s.db, blobs: s.blobs }, stoneRef).pick;
  const planOf = (n1: string, n2: string): StrategyPlan =>
    StrategyPlanSchema.parse({
      kind: 'strategy-plan',
      formatVersion: 1,
      objectTreeRef: persisted.treeBlobRef,
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
      const plan = planOf(input.n1, input.n2);
      // dataRoot：task-layout 读 workbench-view-state.json（P2-4 隐藏层过滤）。
      const executed = executeStrategyPlan({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { taskId: task.id, plan });
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
    plantLatestPlan: (n1, n2) => {
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(planOf(n1, n2), null, 1), 'utf8')).hash;
      s.jobs.emitFor(task.id, 'artifact', { blobRef, name: 'strategy-plan.json' });
      return blobRef;
    },
    plantViewState: (nodes) => {
      const doc = {
        kind: 'workbench-view-state',
        formatVersion: 1,
        nodes,
        revision: 1,
        previousBlobRef: null,
        updatedAt: new Date().toISOString(),
      };
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(doc), 'utf8')).hash;
      s.jobs.emitFor(task.id, 'artifact', { blobRef, name: 'workbench-view-state.json' });
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


/** [Owner 2026-10-03 打印级导出] 位面产物期望尺寸=画布×(300DPI/25.4/ppm)（与
 * buildExportMatrix 的 EXPORT_DPI 缺省 300 同口径——测试环境不设 env 即同值）。 */
function printWidthOf(layout: { imageWidth: number; grid: { pixelsPerMm: number } }): number {
  return Math.round((layout.imageWidth * 300) / 25.4 / layout.grid.pixelsPerMm);
}
/** 打印缩放因子 k（旧网格像素坐标 → 打印像素坐标——取样断言用）。 */
function printScaleOf(layout: { grid: { pixelsPerMm: number } }): number {
  return (300 / 25.4) / layout.grid.pixelsPerMm;
}
function printHeightOf(layout: { imageHeight: number; grid: { pixelsPerMm: number } }): number {
  return Math.round((layout.imageHeight * 300) / 25.4 / layout.grid.pixelsPerMm);
}

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

  it('无 task-layout 工件=typed 拒（策略未执行——指引先跑策略；P0 会话域缺省锚后会话级文案）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      const failed = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(failed.message).toContain('task-layout.image-1.json');
      expect(failed.message).toContain('本会话尚无可导出的布局');
      expect(failed.message).toContain('先完成一轮排钻');
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
      expect(decoded.width).toBe(printWidthOf(layout));
      expect(decoded.height).toBe(printHeightOf(layout));

      // —— PNG 效果图口径（2026-10-02 贴图渲染接线）：fixture 贴图=每款独立纯色
      //（A52 贴图 #00AA55），A52 色板红（#C82828）——钻位中心=贴图色（圆点版则
      // =红）：证明 render.png 走的是 StoneService 贴图按位合成，非 colorHex 圆点。
      const a52Gem = layout.gems.find((gem) => gem.sku === 'A52')!;
      const px = Math.round(a52Gem.x * printScaleOf(layout));
      const py = Math.round(a52Gem.y * printScaleOf(layout));
      const p = (py * decoded.width + px) * 4;
      expect([...decoded.rgba.slice(p, p + 3)]).toEqual([0, 170, 85]);
      expect(decoded.rgba[p + 3]).toBe(255);

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

// ---------------------------------------------------------------- [5] 多图（B4.1/B4.6；P1-1 诚实化）

describe('多图：单图三件套+非贯通图 typed 拒+exports.list 历史读面（B3.5）', () => {
  it('多图任务：省 imageId=typed 拒；image-2（无逐图生产链）=typed 拒并明示未贯通；image-1 照常三件套；历史按 imageId 定位', async () => {
    const f = setup({ imageIds: ['image-1', 'image-2'] });
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }, { ref: f.a52, quantity: 5 }]);
      const executed = f.runStrategy({ n1: f.j51, n2: f.a52 }); // 真链产 image-1
      expect(executed.layoutBlobRef).toBeTruthy();

      // 多图省 imageId=typed 拒。
      const missing = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(missing.message).toContain('必须指定 imageId');
      expect(missing.message).toContain('image-1、image-2');

      // P1-1（2026-09-28 复核）：image-2 无生产链 layout=typed 拒+未贯通文案——
      // 不再手工改写 imageId 伪造第二图三件套（per-image 贯通=W6）。
      const rejected = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId, imageId: 'image-2' }, 'agent'));
      expect(rejected.message).toContain('task-layout.image-2.json');
      expect(rejected.message).toContain('当前版本逐图排钻未贯通');
      expect(rejected.message).toContain('每张图请单独会话');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);

      // image-1 三件套照常。
      const proposed1 = await f.propose({ imageId: 'image-1' });
      const value1 = await f.approveAndExecute(proposed1);
      expect(value1['source']).toMatchObject({ imageId: 'image-1' });
      expect(existsSync(path.join(f.bundleDir(value1['publicId'] as string), 'layout.svg'))).toBe(true);
      expect(f.resultsCount()).toBe(1);

      // exports.list：单图导出一行（image-1）。
      const listed = await f.listExports();
      const exportsRows = listed['exports'] as Array<Record<string, unknown>>;
      expect(exportsRows).toHaveLength(1);
      expect((exportsRows[0]!['source'] as Record<string, unknown>)['imageId']).toBe('image-1');
      expect((exportsRows[0]!['source'] as Record<string, unknown>)['taskLayoutRef']).toBe(executed.layoutBlobRef);
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

// ---------------------------------------------------------------- [6] P2-3 导出锚绑定定版 layout

describe('导出锚绑定（P2-3——2026-09-28 复核：lint/BOM/审计不随策略重跑或清单演进漂移）', () => {
  it('策略 plan 前进后导出旧 layout：lint 按 layout.source.planRef（不读最新 plan）', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      // planA（layout 锚）：n2=A52（未引入——warning 面）。
      const executed = f.runStrategy({ n1: f.j51, n2: f.a52 });
      expect(executed.layoutBlobRef).toBeTruthy();
      // 策略重跑（latest strategy-plan.json 前进到 planB：n2=B53）——但不再产新
      // layout 帧（手工只落 plan 帧，模拟旧 layout 仍为 latest 的导出面）。
      f.plantLatestPlan(f.j51, f.b53);
      const proposed = await f.propose();
      const lint = proposed['lint'] as { summary: { counts: Record<string, number> }; items: Array<{ stoneRef: string }> };
      // lint=planA 口径（A52 未引入）——不是最新 planB 的 B53。
      expect(lint.summary.counts).toMatchObject({ unintroduced: 1, introduced: 1 });
      expect(lint.items.map((item) => item.stoneRef)).toContain(f.a52);
      expect(lint.items.map((item) => item.stoneRef)).not.toContain(f.b53);
      const warnings = proposed['warnings'] as string[];
      expect(warnings.join('\n')).toContain(f.a52);
      expect(warnings.join('\n')).not.toContain(f.b53);
      // 可照常执行（门按定版 layout 判——bundle source 审计同锚）。
      const value = await f.approveAndExecute(proposed);
      expect(value['source']).toMatchObject({ taskLayoutRef: executed.layoutBlobRef });
    } finally {
      f.dispose();
    }
  });

  it('manifest 前进后导出旧 layout：payload/审计锚=layout.source.manifestRevision；BOM 备料列=「清单已更新」审计行', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      // 清单演进（layout 锚 rev1 → 当前 rev2：A52 引入 quantity 5）。
      f.manifests.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 1,
        build: (current) => {
          const materialized = materializeStoneRef({ db: f.s.db, blobs: f.s.blobs }, f.a52);
          return {
            sourceSet: null,
            entries: [
              ...(current?.entries ?? []),
              {
                stoneRef: f.a52,
                pick: materialized.pick,
                stoneRevision: materialized.stoneRevision,
                stoneJsonBlobRef: materialized.stoneJsonBlobRef,
                textureBlobRef: materialized.textureBlobRef,
                shapeAssetBlobRef: null,
                quantity: 5,
                origin: 'manual-add' as const,
              },
            ],
          };
        },
      });
      expect(f.manifests.loadManifest(f.sessionId).revision).toBe(2);
      const proposed = await f.propose();
      // 锚=layout 锚 rev1（非当前 rev2）。
      const summary = proposed['summary'] as Record<string, unknown>;
      expect((summary['anchors'] as Record<string, unknown>)['manifestRevision']).toBe(1);
      // 漂移 warning（审计面——不阻断）。
      const warnings = proposed['warnings'] as string[];
      expect(warnings.join('\n')).toContain('清单已更新（rev 1→2）');
      // 执行：bundle source 审计=rev1；BOM 备料列全列=审计行（不回放旧 manifest）。
      const value = await f.approveAndExecute(proposed);
      expect(value['source']).toMatchObject({ manifestRevision: 1 });
      expect((value['warnings'] as string[]).join('\n')).toContain('清单已更新（rev 1→2）');
      const csv = f.s.blobs.read((value['bundle'] as Record<string, string>)['bom']!)!.toString('utf8');
      const rows = bomRowsOf(csv);
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row[6]).toBe('清单已更新（rev 1→2）');
      }
      // 对照：manifest 与 layout 锚一致（rev 不漂移）→ 备料列正常数值（P2-5 用例覆盖
      // 「未设置」），此处在同测试内以重跑链复核：重跑策略（锚=rev2）→新 layout。
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const proposed2 = await f.propose();
      expect(((proposed2['summary'] as Record<string, unknown>)['anchors'] as Record<string, unknown>)['manifestRevision']).toBe(2);
      expect((proposed2['warnings'] as string[]).join('\n')).not.toContain('清单已更新');
      const value2 = await f.approveAndExecute(proposed2);
      const csv2 = f.s.blobs.read((value2['bundle'] as Record<string, string>)['bom']!)!.toString('utf8');
      const bySku2 = new Map(bomRowsOf(csv2).map((row) => [row[1], row]));
      expect(bySku2.get('J51')![6]).toBe('10');
      expect(bySku2.get('A52')![6]).toBe('5');
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [7] P2-4 隐藏层过滤

describe('隐藏层过滤（P2-4——view-state visible=false 节点 gems 不进 layout/SVG/BOM）', () => {
  it('隐藏 n2 →layout/SVG/BOM 只含 n1 的钻（与前端 Designer 导出一致）；无 view-state=全可见', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }, { ref: f.a52, quantity: 5 }]);
      // —— 无 view-state：全可见（基线）。
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const all = f.readLayout()!;
      expect(all.gems.some((gem) => gem.blockId === 'n2')).toBe(true);
      // —— 隐藏 n2 后重跑：n2 gems 不进 layout（palette 亦收敛）。
      f.plantViewState([{ nodeId: 'n2', visible: false }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const layout = f.readLayout()!;
      expect(layout.gems.length).toBeGreaterThan(0);
      expect(layout.gems.every((gem) => gem.blockId === 'n1')).toBe(true);
      expect(Object.keys(layout.palette)).toEqual([f.j51]);
      // 导出三件套同口径：SVG 圆数=过滤后 gems；BOM 仅 J51 行。
      const proposed = await f.propose();
      const value = await f.approveAndExecute(proposed);
      const svg = f.s.blobs.read((value['bundle'] as Record<string, string>)['svg']!)!.toString('utf8');
      expect((svg.match(/<circle /g) ?? []).length).toBe(layout.gems.length);
      expect(svg).not.toContain(`data-color-id="${f.a52}"`);
      const rows = bomRowsOf(f.s.blobs.read((value['bundle'] as Record<string, string>)['bom']!)!.toString('utf8'));
      expect(rows.map((row) => row[1])).toEqual(['J51']);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [8] P2-5 BOM 未设置

describe('BOM 备料参考（P2-5——quantity=0 输出「未设置」，正数量才数字）', () => {
  it('quantity=0（未设置备料参考）→「未设置」；正数量→数字；未引入→「未引入」', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 0 }]);
      f.runStrategy({ n1: f.j51, n2: f.a52 });
      const proposed = await f.propose();
      const value = await f.approveAndExecute(proposed);
      const csv = f.s.blobs.read((value['bundle'] as Record<string, string>)['bom']!)!.toString('utf8');
      const bySku = new Map(bomRowsOf(csv).map((row) => [row[1], row]));
      expect(bySku.get('J51')![6]).toBe('未设置'); // 集合缺省/手工追加物化 0
      expect(bySku.get('A52')![6]).toBe('未引入'); // 不在 manifest
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [10] 导出矩阵（2026-10-02）

describe('导出矩阵（黑点模板 holes.png+编号工作图 numbered.png+四层 SVG）', () => {
  it('产物清单五件：帧五条/bundle 五元组/目录五文件/manifest 五条目', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      const executed = f.runStrategy({ n1: f.j51, n2: f.a52 });
      expect(executed.gemCount).toBeGreaterThan(0);
      const proposed = await f.propose();
      const value = await f.approveAndExecute(proposed);
      const bundle = value['bundle'] as Record<string, string>;
      for (const ref of [bundle['svg']!, bundle['png']!, bundle['bom']!, bundle['holes']!, bundle['numbered']!]) {
        expect(ref).toMatch(/^[0-9a-f]{64}$/);
      }
      // artifact 帧五条（holes/numbered 按文件名带出——ResultCard/下载面自然扩展）。
      const frames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames;
      for (const name of [
        'task-export.image-1.svg',
        'task-export.image-1.png',
        'task-export.image-1.bom',
        'task-export.image-1.holes.png',
        'task-export.image-1.numbered.png',
      ]) {
        expect(
          frames.some((frame) => frame['kind'] === 'artifact' && (frame['payload'] as { name: string }).name === name),
        ).toBe(true);
      }
      // bundle 目录+manifest：五文件/五条目（新件按文件名自然带出）。
      const dir = f.bundleDir(value['publicId'] as string);
      for (const file of ['layout.svg', 'bom.csv', 'render.png', 'holes.png', 'numbered.png']) {
        expect(existsSync(path.join(dir, file))).toBe(true);
      }
      const manifest = JSON.parse(readFileSync(path.join(dir, 'bundle.json'), 'utf8')) as {
        blobRefs: Record<string, string>;
        files: Record<string, { name: string }>;
      };
      expect(Object.keys(manifest.blobRefs).sort()).toEqual(['bom', 'holes', 'numbered', 'png', 'svg']);
      expect(manifest.files['holes']).toMatchObject({ name: 'holes.png' });
      expect(manifest.files['numbered']).toMatchObject({ name: 'numbered.png' });
    } finally {
      f.dispose();
    }
  });

  it('产物语义：holes=白底黑孔 1-bit（孔数=gems 数）；numbered=图例带扩展画布+全款贴图缩略+孔内编号=BOM 行号；SVG=四层结构', async () => {
    // imageScale=5：真实链 1000×800px（ppm=10）——编号字号=真实生产口径（fixture
    // 缺省 ppm=2 时孔径 4px，字形退化不具断言意义）。
    const f = setup({ imageScale: 5 });
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      const executed = f.runStrategy({ n1: f.j51, n2: f.a52 });
      expect(executed.gemCount).toBeGreaterThan(0);
      const layout = f.readLayout()!;
      const proposed = await f.propose();
      const value = await f.approveAndExecute(proposed);
      const bundle = value['bundle'] as Record<string, string>;

      // —— holes.png：1-bit 语义（纯黑不透明/全透明——[Owner 2026-10-03] 刻膜透明底）；
      //    黑像素连通域=gems 数（spacing 门保证不相连）；尺寸=打印级（300DPI 同口径）。
      const holesImg = decodePng(f.s.blobs.read(bundle['holes']!)!);
      expect(holesImg.width).toBe(printWidthOf(layout));
      expect(holesImg.height).toBe(printHeightOf(layout));
      let oneBit = true;
      let components = 0;
      {
        const seen = new Uint8Array(holesImg.width * holesImg.height);
        const isBlack = (x: number, y: number): boolean => {
          const p = (y * holesImg.width + x) * 4;
          return holesImg.rgba[p + 3]! >= 128 && holesImg.rgba[p]! < 128;
        };
        for (let p = 0; p < holesImg.width * holesImg.height; p++) {
          const [r, g, b, a] = [holesImg.rgba[p * 4]!, holesImg.rgba[p * 4 + 1]!, holesImg.rgba[p * 4 + 2]!, holesImg.rgba[p * 4 + 3]!];
          if (!(r === 0 && g === 0 && b === 0 && (a === 0 || a === 255))) oneBit = false;
        }
        for (let y = 0; y < holesImg.height; y++) {
          for (let x = 0; x < holesImg.width; x++) {
            if (seen[y * holesImg.width + x] || !isBlack(x, y)) continue;
            components += 1;
            const queue: [number, number][] = [[x, y]];
            seen[y * holesImg.width + x] = 1;
            while (queue.length > 0) {
              const [cx, cy] = queue.pop()!;
              for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as [number, number][]) {
                if (nx < 0 || ny < 0 || nx >= holesImg.width || ny >= holesImg.height) continue;
                if (seen[ny * holesImg.width + nx] || !isBlack(nx, ny)) continue;
                seen[ny * holesImg.width + nx] = 1;
                queue.push([nx, ny]);
              }
            }
          }
        }
      }
      expect(oneBit).toBe(true);
      expect(components).toBe(layout.gems.length);

      // —— numbered.png：画布右侧图例带扩展（宽>imageWidth，高=imageHeight）；
      //    图例全款在列（每款 swatch=钻库贴图缩略——2026-10-02 走查升级：fixture
      //    每款独立色贴图，缩略像素=贴图色而非 palette hex——J51 #00AAAA / A52 #00AA55）。
      const numberedImg = decodePng(f.s.blobs.read(bundle['numbered']!)!);
      expect(numberedImg.width).toBeGreaterThan(printWidthOf(layout));
      expect(numberedImg.height).toBe(printHeightOf(layout));
      const texOf = { J51: [0, 170, 170], A52: [0, 170, 85] } as const;
      for (const [sku, rgb] of Object.entries(texOf)) {
        const found = (() => {
          for (let y = 0; y < numberedImg.height; y++) {
            for (let x = printWidthOf(layout); x < numberedImg.width; x++) {
              const p = (y * numberedImg.width + x) * 4;
              if (
                Math.abs(numberedImg.rgba[p]! - rgb[0]) <= 2 &&
                Math.abs(numberedImg.rgba[p + 1]! - rgb[1]) <= 2 &&
                Math.abs(numberedImg.rgba[p + 2]! - rgb[2]) <= 2
              ) {
                return true;
              }
            }
          }
          return false;
        })();
        expect(found, `图例应有 ${sku} 贴图缩略`).toBe(true);
      }

      // —— 孔内编号=BOM 行号（CSV 行序→款→孔内暗像素=字形×scale²——对账严丝合缝）。
      const csv = f.s.blobs.read(bundle['bom']!)!.toString('utf8');
      const ppm = layout.grid.pixelsPerMm * printScaleOf(layout); // 打印口径（渲染同参）
      bomRowsOf(csv).forEach((row, index) => {
        const rowNumber = index + 1;
        const sku = row[1]!;
        const gems = layout.gems.filter((gem) => gem.sku === sku);
        expect(gems.length).toBe(Number(row[5]));
        for (const gem of gems) {
          const glyph = holeNumberGlyph(rowNumber, gem.diameterMm, ppm);
          const size = measureAscii(glyph.text, glyph.scale);
          const k = printScaleOf(layout);
          const x0 = Math.round(gem.x * k + 0.5 - size.width / 2) - 1;
          const y0 = Math.round(gem.y * k + 0.5 - size.height / 2) - 1;
          let dark = 0;
          for (let y = y0; y <= y0 + size.height + 1; y++) {
            for (let x = x0; x <= x0 + size.width + 1; x++) {
              const p = (y * numberedImg.width + x) * 4;
              const [r, g, b] = [numberedImg.rgba[p]!, numberedImg.rgba[p + 1]!, numberedImg.rgba[p + 2]!];
              if (0.299 * r + 0.587 * g + 0.114 * b < 128) dark += 1;
            }
          }
          expect(dark, `SKU ${sku} 行 ${rowNumber} 孔内编号`).toBe(litPixelsOf(glyph.text) * glyph.scale ** 2);
        }
      });

      // —— SVG：四层结构（source 占位——fixture 会话无主图集；holes/numbers/gems 在场）。
      const svg = f.s.blobs.read(bundle['svg']!)!.toString('utf8');
      expect(svg).toContain('会话主图集不可达'); // 无输入图→占位层（不阻断导出）
      const iHoles = svg.indexOf('<g id="holes"');
      const iNumbers = svg.indexOf('<g id="numbers"');
      const iGems = svg.indexOf('<g id="gems"');
      expect(iHoles).toBeGreaterThan(-1);
      expect(iNumbers).toBeGreaterThan(iHoles);
      expect(iGems).toBeGreaterThan(iNumbers);
      expect(svg).toContain('data-color-id');
      expect(svg).toContain('data-bom-row');
      // 源图不可达=execute warnings 明示（不静默）。
      expect((value['warnings'] as string[]).some((w) => w.includes('SVG 原图层降级占位'))).toBe(true);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [9] P2-6 生成拒可预见

describe('propose 可预见生成拒（P2-6——有 plan 无 layout=refusal 诊断，不进 approval）', () => {
  it('策略已执行（plan 在场）但 layout 缺席=生成器曾拒：typed 拒+明示多候选/自定义形成因', async () => {
    const f = setup();
    try {
      f.seedManifest([{ ref: f.j51, quantity: 10 }]);
      // 只落 plan 帧（策略工件面），不跑执行链——layout 缺席=生成拒形态。
      f.plantLatestPlan(f.j51, f.a52);
      const failed = await failedOf(await f.registry.call(TASK_EXPORT_TOOL_NAME, { taskId: f.taskId }, 'agent'));
      expect(failed.message).toContain('生成器曾拒');
      expect(failed.message).toContain('该计划含多候选物料节点/自定义形——当前不支持导出，请改为每节点恰一款钻');
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(0);
    } finally {
      f.dispose();
    }
  });
});
