/**
 * task-layout 生成器测试（add-task-stones-manifest-export 4.1——arch-decisions B2
 * 「不能猜」物料匹配矩阵+渲染快照最小真值锁定）。覆盖：
 *   [1] assembleTaskLayout 纯装配：单款指派→物料身份/palette（键=stoneRef）/grid
 *       （ppm 画布推导+gap 注入+baseSpec 基准径）/blocks（id+bbox——mask 不进
 *       layout）/隐藏层（P2-4 接线：过滤在写入面按 view-state——纯装配不感知，见 [4]）。
 *   [2] 物料匹配矩阵（冻结规则）：单款=取该款；多候选 colorId↔colorHex 恰一命中=
 *       取该款；多候选零命中/多命中=拒+诊断（内核 colorId 恒 '' ⇒ 多候选一律拒）；
 *       无指派=拒；custom 形=拒（daemon 无 .gemshape 全局面——W1 偏离 5 呼应）。
 *   [3] writeTaskLayoutForExecution：无项目行=skip（blobRef null 零诊断）；有项目行=
 *       blob 落盘（TaskLayoutSchema 回读通过）+manifestRevision 锚；生成拒=零工件
 *       +诊断呈现（派生面不放大）。零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  encodeInlineMask,
  TaskLayoutSchema,
  taskLayoutArtifactName,
  type ObjectTree,
  type StonePick,
  type StrategyPlan,
} from '@handicraft/contracts';
import {
  assembleTaskLayout,
  hiddenNodeIdsOf,
  writeTaskLayoutForExecution,
  type TaskLayoutAssemblyInput,
} from '../src/kernel/task-layout';
import type { KernelGem } from '../src/kernel/strategies/registry.js';
import type { TreeBlock } from '../src/kernel/vision/tree-to-blocks.js';
import { ProjectManifestService } from '../src/kernel/project-manifest.js';
import { materializeStoneRef } from '../src/kernel/project-expand.js';
import { encodePng } from '../src/png/codec.js';
import { StoneService } from '../src/stones/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices } from './helpers.js';

// ---------------------------------------------------------------- fixture（纯装配面）

const TREE: ObjectTree = {
  kind: 'object-tree',
  formatVersion: 1,
  canvasCm: { w: 10, h: 8 },
  imagePx: { width: 200, height: 160 },
  nodes: [
    {
      id: 'n1',
      objectName: '主体',
      category: 'foliage',
      mask: encodeInlineMask(200, 160, new Uint8Array(200 * 160).fill(1)),
      bbox: { x: 0, y: 0, w: 200, h: 160 },
      parent: null,
      children: [],
      effectiveMm: 100,
      labVariance: 12,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
  ],
  createdAt: '2026-09-29T00:00:00.000Z',
};

const REF_A = 'stone-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REF_B = 'stone-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function pickOf(ref: string, sku: string, colorHex: string, sizeMm = 2) {
  return { resourceId: ref, sku, supplier: 'yuhang', sizeMm, colorHex };
}

function planOf(stones: Array<{ nodeId: string; stones: StonePick[] }>): StrategyPlan {
  return {
    kind: 'strategy-plan',
    formatVersion: 1,
    objectTreeRef: 'f'.repeat(64),
    assignments: stones.map((entry) => ({
      nodeId: entry.nodeId,
      strategyKind: 'texture-fill',
      params: { mode: 'scatter', polarity: 'dark-dense' },
      stones: entry.stones,
      densityPerCm2: 2.3,
      rationale: '测试指派',
    })),
    createdAt: '2026-09-29T00:00:00.000Z',
  } as StrategyPlan;
}

function gem(id: string, overrides: Partial<KernelGem> = {}): KernelGem {
  return {
    id,
    x: 10,
    y: 10,
    colorId: '',
    blockId: 'n1',
    shapeId: 'round',
    diameterMm: 2,
    ...overrides,
  };
}

function blockOf(id: string): TreeBlock {
  const w = 200;
  const h = 160;
  return {
    id,
    label: id,
    mask: { w, h, bits: new Uint8Array(w * h).fill(1) },
    colorRgb: [128, 128, 128],
    areaPx: w * h,
    bbox: { x: 0, y: 0, w, h },
    widthPx: { max: w, mean: w },
    suggested: 'fill',
    origin: {
      originBlockId: null,
      parentNodeId: null,
      nodeCategory: 'foliage',
      drillWorthy: true,
      nodeOrigin: 'vlm+sam3',
      effectiveMm: 100,
      labVariance: 12,
      depth: 0,
      isLeaf: true,
      colorSource: 'fallback',
    },
  };
}

function assemblyInput(overrides: Partial<TaskLayoutAssemblyInput> = {}): TaskLayoutAssemblyInput {
  return {
    projectId: 'sess-test',
    sourceTaskId: 'task-test',
    imageId: 'image-1',
    manifestRevision: 3,
    plan: planOf([{ nodeId: 'n1', stones: [pickOf(REF_A, 'A52', '#C82828', 2)] }]),
    planRef: 'a'.repeat(64),
    treeRef: 'f'.repeat(64),
    tree: TREE,
    gems: [gem('g1'), gem('g2', { x: 30, y: 40 })],
    blocks: [blockOf('n1')],
    referenceDiameterMm: 2,
    gapMm: 0.4,
    ...overrides,
  };
}

// ---------------------------------------------------------------- [1] 单款装配

describe('assembleTaskLayout：单款指派→契约体', () => {
  it('物料身份+palette（键=stoneRef）+grid（画布推导/gap 注入/baseSpec 基准径）+blocks（无 mask 键）', () => {
    const result = assembleTaskLayout(assemblyInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layout = result.layout;
    // 契约回验（生成器内部已 parse——此处显式锁定产物过 schema）。
    expect(() => TaskLayoutSchema.parse(layout)).not.toThrow();
    // 三锚绑定。
    expect(layout.source).toMatchObject({
      projectId: 'sess-test',
      sourceTaskId: 'task-test',
      imageId: 'image-1',
      planRef: 'a'.repeat(64),
      treeRef: 'f'.repeat(64),
      manifestRevision: 3,
    });
    // 物料身份：每颗 gem 携带 stoneRef/sku/supplier/colorHex（排钻当时确定）。
    expect(layout.gems).toHaveLength(2);
    for (const gemEntry of layout.gems) {
      expect(gemEntry).toMatchObject({ stoneRef: REF_A, sku: 'A52', supplier: 'yuhang', colorHex: '#C82828' });
    }
    // palette 键=stoneRef（SVG 分组/PNG 回查/BOM 行同键——物料身份单源）。
    expect(layout.palette).toEqual({ [REF_A]: { name: 'yuhang/A52', hex: '#C82828' } });
    // grid 单源：ppm=imagePx.width/(canvasCm.w×10)；gap=注入值；baseSpec=基准径。
    expect(layout.grid).toEqual({ pixelsPerMm: 2, gapMm: 0.4, baseSpec: { shapeId: 'round', diameterMm: 2 } });
    expect(layout.imageWidth).toBe(200);
    expect(layout.imageHeight).toBe(160);
    // blocks=叶子口径 id+bbox——mask 不进 layout（导出门按 treeRef 引用重算）。
    expect(layout.blocks).toEqual([{ id: 'n1', bbox: { x: 0, y: 0, w: 200, h: 160 } }]);
    // 纯装配面不感知显隐（P2-4：view-state 过滤在 writeTaskLayoutForExecution——见 [4]）。
    expect(layout.gems.map((entry) => entry.id)).toEqual(['g1', 'g2']);
    // custom 形守卫面：shapeAssets 恒空（无 custom gem）。
    expect(layout.shapeAssets).toEqual({});
  });

  it('同款多色候选：gem.colorId 恰一命中 colorHex=取该款（规则 3 正路径）', () => {
    const result = assembleTaskLayout(
      assemblyInput({
        plan: planOf([{ nodeId: 'n1', stones: [pickOf(REF_A, 'A52', '#C82828'), pickOf(REF_B, 'B53', '#5A78C8')] }]),
        gems: [gem('g1', { colorId: '#5A78C8' }), gem('g2', { colorId: '#5A78C8' })],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.gems.every((entry) => entry.stoneRef === REF_B)).toBe(true);
    expect(Object.keys(result.layout.palette)).toEqual([REF_B]);
  });
});

// ---------------------------------------------------------------- [2] 匹配矩阵（拒绝面）

describe('物料匹配矩阵：不可唯一匹配=生成器拒+诊断（B2 不能猜）', () => {
  it('多候选（同色）+内核 colorId=""=拒——诊断明示改单款指派', () => {
    const result = assembleTaskLayout(
      assemblyInput({
        plan: planOf([{ nodeId: 'n1', stones: [pickOf(REF_A, 'A52', '#C82828'), pickOf(REF_B, 'B53', '#C82828')] }]),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(2); // 每颗 gem 一条
    expect(result.diagnostics[0]).toContain('n1');
    expect(result.diagnostics[0]).toContain('恰一款');
    expect(result.diagnostics[0]).toContain('不能猜');
  });

  it('多候选（异色）+colorId=""=零命中拒', () => {
    const result = assembleTaskLayout(
      assemblyInput({
        plan: planOf([{ nodeId: 'n1', stones: [pickOf(REF_A, 'A52', '#C82828'), pickOf(REF_B, 'B53', '#5A78C8')] }]),
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('多候选+colorId 多命中=拒（同色两款不可分辨）', () => {
    const result = assembleTaskLayout(
      assemblyInput({
        plan: planOf([{ nodeId: 'n1', stones: [pickOf(REF_A, 'A52', '#C82828'), pickOf(REF_B, 'B53', '#C82828')] }]),
        gems: [gem('g1', { colorId: '#C82828' })],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toContain('无法唯一匹配');
  });

  it('custom 形=拒（daemon 无钻形资产全局面——W1 偏离 5 呼应）', () => {
    const result = assembleTaskLayout(
      assemblyInput({ gems: [gem('g1', { shapeId: 'custom' as KernelGem['shapeId'], assetId: 'asset-x' })] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toContain('custom');
    expect(result.diagnostics[0]).toContain('不收录 custom 形');
  });

  it('无对应指派=拒（blockId 漂移防御）', () => {
    const result = assembleTaskLayout(assemblyInput({ gems: [gem('g1', { blockId: 'n-x' })] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toContain('无对应策略指派');
  });
});

// ---------------------------------------------------------------- [3] 写入面（集成）

describe('writeTaskLayoutForExecution：项目行锚+落盘+派生面不放大', () => {
  function integrationFixture() {
    const s = createServices(undefined, { imgDryRun: true });
    const stones = new StoneService({ db: s.db, blobs: s.blobs });
    const created = stones.createStone({
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
        sizeMm: 2,
        color: { name: '测试色', rgb: [200, 40, 40] as [number, number, number], family: '测试系', finish: 'glossy' },
        texture: { declaredWidth: 128, declaredHeight: 128 },
      },
      textureBytes: new Uint8Array(encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(255))),
    });
    const { sessionId } = s.sessions.create(s.anonymous, { title: 'task-layout 写入测试' });
    const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
    const pick = materializeStoneRef({ db: s.db, blobs: s.blobs }, created.resourceId).pick;
    return { s, sessionId, taskId: task.id, pick };
  }

  it('无 session-project 行=skip（blobRef null——无项目语义零诊断）', () => {
    const f = integrationFixture();
    try {
      const result = writeTaskLayoutForExecution(f.s, {
        taskId: f.taskId,
        plan: planOf([{ nodeId: 'n1', stones: [pickOf(REF_A, 'A52', '#C82828')] }]),
        planRef: 'a'.repeat(64),
        tree: TREE,
        gems: [gem('g1')],
        blocks: [blockOf('n1')],
        referenceDiameterMm: 2,
        gapMm: 0.4,
      });
      expect(result).toMatchObject({ blobRef: null, imageId: 'image-1', diagnostics: [] });
    } finally {
      f.s.dispose();
    }
  });

  it('有项目行=blob 落盘（回读过 schema+manifestRevision 锚+image-1 缺省名）', () => {
    const f = integrationFixture();
    try {
      const manifests = new ProjectManifestService({ config: f.s.config, db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs });
      manifests.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 0,
        build: () => ({ sourceSet: null, entries: [] }),
      });
      const result = writeTaskLayoutForExecution(f.s, {
        taskId: f.taskId,
        plan: planOf([{ nodeId: 'n1', stones: [f.pick] }]),
        planRef: 'b'.repeat(64),
        tree: TREE,
        gems: [gem('g1'), gem('g2')],
        blocks: [blockOf('n1')],
        referenceDiameterMm: 2,
        gapMm: 0.4,
      });
      expect(result.blobRef).toBeTruthy();
      expect(result.imageId).toBe('image-1');
      expect(result.diagnostics).toEqual([]);
      // 回读：契约体+锚（manifestRevision=写入时电流行 revision=1）。
      const doc = TaskLayoutSchema.parse(JSON.parse(f.s.blobs.read(result.blobRef!)!.toString('utf8')));
      expect(doc.source).toMatchObject({
        projectId: f.sessionId,
        sourceTaskId: f.taskId,
        imageId: 'image-1',
        manifestRevision: 1,
      });
      expect(doc.gems.every((entry) => entry.stoneRef === f.pick.resourceId)).toBe(true);
      // 帧名单源（调用方 emit 消费）。
      expect(taskLayoutArtifactName('image-1')).toBe('task-layout.image-1.json');
      expect(taskLayoutArtifactName('image-12')).toBe('task-layout.image-12.json');
    } finally {
      f.s.dispose();
    }
  });

  it('生成拒=零工件+诊断呈现（多候选不放大为执行失败）', () => {
    const f = integrationFixture();
    try {
      const manifests = new ProjectManifestService({ config: f.s.config, db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs });
      manifests.writeManifest(f.s.anonymous, {
        sessionId: f.sessionId,
        taskId: f.taskId,
        expectedRevision: 0,
        build: () => ({ sourceSet: null, entries: [] }),
      });
      const result = writeTaskLayoutForExecution(f.s, {
        taskId: f.taskId,
        plan: planOf([{ nodeId: 'n1', stones: [f.pick, pickOf(REF_B, 'B53', '#C82828')] }]),
        planRef: 'c'.repeat(64),
        tree: TREE,
        gems: [gem('g1')],
        blocks: [blockOf('n1')],
        referenceDiameterMm: 2,
        gapMm: 0.4,
      });
      expect(result.blobRef).toBeNull();
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0]).toContain('恰一款');
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] P2-4 隐藏层过滤（view-state）

/** 三级树（root r > 组 m > 叶 n1/n2）——祖先隐藏传播/root 剔除判定用。 */
function deepTree(): ObjectTree {
  const node = (id: string, parent: string | null, children: string[]): ObjectTree['nodes'][number] => ({
    id,
    objectName: id,
    category: 'foliage',
    mask: encodeInlineMask(200, 160, new Uint8Array(200 * 160).fill(1)),
    bbox: { x: 0, y: 0, w: 200, h: 160 },
    parent,
    children,
    effectiveMm: 100,
    labVariance: 12,
    drillWorthy: children.length === 0,
    origin: 'vlm+sam3',
  });
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 10, h: 8 },
    imagePx: { width: 200, height: 160 },
    nodes: [node('r', null, ['m']), node('m', 'r', ['n1', 'n2']), node('n1', 'm', []), node('n2', 'm', [])],
    createdAt: '2026-09-29T00:00:00.000Z',
  };
}

describe('hiddenNodeIdsOf：view-state visible=false（P2-4——与前端 Designer 导出一致）', () => {
  /** 真任务行（emitFor fence 需 task 在场——帧才落 frames.jsonl）。 */
  function taskOf(s: ReturnType<typeof createServices>): string {
    const { sessionId } = s.sessions.create(s.anonymous, { title: 'view-state 单测' });
    return createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' }).id;
  }

  it('无 dataRoot / 无 view-state 工件=空集（全可见）；visible=false 直接命中', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const taskId = taskOf(s);
      expect(hiddenNodeIdsOf({ blobs: s.blobs }, taskId, deepTree()).hidden).toEqual(new Set());
      expect(hiddenNodeIdsOf({ blobs: s.blobs, dataRoot: s.config.dataRoot }, taskId, deepTree()).hidden).toEqual(new Set());
      // 落 view-state 帧（隐藏叶 n2）。
      const doc = {
        kind: 'workbench-view-state',
        formatVersion: 1,
        nodes: [{ nodeId: 'n2', visible: false }],
        revision: 1,
        previousBlobRef: null,
        updatedAt: new Date().toISOString(),
      };
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(doc), 'utf8')).hash;
      expect(s.jobs.emitFor(taskId, 'artifact', { blobRef, name: 'workbench-view-state.json' })).toBe(true);
      const { hidden, error } = hiddenNodeIdsOf({ blobs: s.blobs, dataRoot: s.config.dataRoot }, taskId, deepTree());
      expect(error).toBeNull();
      expect(hidden).toEqual(new Set(['n2']));
      // 未列节点（默认可见）+visible=true 行不隐藏。
    } finally {
      s.dispose();
    }
  });

  it('祖先隐藏传播（组 m 隐藏→叶 n1/n2 全隐藏）；root 隐藏行剔除（v4 F5）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const taskId = taskOf(s);
      const doc = {
        kind: 'workbench-view-state',
        formatVersion: 1,
        nodes: [
          { nodeId: 'm', visible: false },
          { nodeId: 'r', visible: false }, // root 行——读回剔除（防整树消失）
        ],
        revision: 1,
        previousBlobRef: null,
        updatedAt: new Date().toISOString(),
      };
      const blobRef = s.blobs.put(Buffer.from(JSON.stringify(doc), 'utf8')).hash;
      s.jobs.emitFor(taskId, 'artifact', { blobRef, name: 'workbench-view-state.json' });
      const { hidden } = hiddenNodeIdsOf({ blobs: s.blobs, dataRoot: s.config.dataRoot }, taskId, deepTree());
      // m+n1+n2 隐藏；r 剔除（自身不隐藏——背景显隐另有真源）。
      expect(hidden).toEqual(new Set(['m', 'n1', 'n2']));
    } finally {
      s.dispose();
    }
  });

  it('工件损坏=生成拒诊断（可见性不能猜——不静默全导出）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const taskId = taskOf(s);
      const blobRef = s.blobs.put(Buffer.from('not-json{', 'utf8')).hash;
      s.jobs.emitFor(taskId, 'artifact', { blobRef, name: 'workbench-view-state.json' });
      const { error } = hiddenNodeIdsOf({ blobs: s.blobs, dataRoot: s.config.dataRoot }, taskId, deepTree());
      expect(error).toContain('可见性无法判定');
    } finally {
      s.dispose();
    }
  });
});

describe('writeTaskLayoutForExecution：隐藏层过滤接线（P2-4）', () => {
  it('view-state 隐藏叶→gems 过滤（layout 无隐藏节点钻）；损坏 view-state=拒诊断零工件', () => {
    const s = createServices(undefined, { imgDryRun: true });
    const stones = new StoneService({ db: s.db, blobs: s.blobs });
    const created = stones.createStone({
      ownerId: s.anonymous.id,
      supplierProfile: {
        supplier: 'yuhang',
        displayName: '钰航',
        bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { A: 3 } }],
        styleKey: 'row',
      },
      draft: {
        name: 'A52 钻',
        sku: 'A52',
        sizeMm: 3,
        color: { name: '测试色', rgb: [200, 40, 40] as [number, number, number], family: '测试系', finish: 'glossy' },
        texture: { declaredWidth: 128, declaredHeight: 128 },
      },
      textureBytes: new Uint8Array(encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(255))),
    });
    const { sessionId } = s.sessions.create(s.anonymous, { title: '隐藏层接线' });
    const taskId = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' }).id;
    const pick = materializeStoneRef({ db: s.db, blobs: s.blobs }, created.resourceId).pick;
    try {
      const manifests = new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs });
      manifests.writeManifest(s.anonymous, {
        sessionId,
        taskId,
        expectedRevision: 0,
        build: () => ({ sourceSet: null, entries: [] }),
      });
      const plan = planOf([{ nodeId: 'n1', stones: [pick] }]);
      // deepTree：n1 是组 m 下的叶（非 root）——root 隐藏行剔除逻辑不吞掉本用例。
      const base = {
        taskId,
        plan,
        planRef: 'd'.repeat(64),
        tree: deepTree(),
        gems: [gem('g1'), gem('g2', { blockId: 'n1', x: 50 })],
        blocks: [blockOf('n1')],
        referenceDiameterMm: 2,
        gapMm: 0.4,
      };
      // 无 dataRoot（旧装配面）=全可见。
      const all = writeTaskLayoutForExecution(s, base);
      expect(all.blobRef).toBeTruthy();
      // dataRoot+无 view-state=全可见。
      const noState = writeTaskLayoutForExecution({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, base);
      expect(noState.blobRef).toBeTruthy();
      expect(JSON.parse(s.blobs.read(noState.blobRef!)!.toString('utf8')).gems).toHaveLength(2);
      // 隐藏 n1（TREE 的唯一叶）→gems 全过滤（空 layout 合法——BOM 空/合计 0）。
      const doc = {
        kind: 'workbench-view-state',
        formatVersion: 1,
        nodes: [{ nodeId: 'n1', visible: false }],
        revision: 1,
        previousBlobRef: null,
        updatedAt: new Date().toISOString(),
      };
      const vsRef = s.blobs.put(Buffer.from(JSON.stringify(doc), 'utf8')).hash;
      s.jobs.emitFor(taskId, 'artifact', { blobRef: vsRef, name: 'workbench-view-state.json' });
      const filtered = writeTaskLayoutForExecution({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, base);
      expect(filtered.blobRef).toBeTruthy();
      const layoutDoc = TaskLayoutSchema.parse(JSON.parse(s.blobs.read(filtered.blobRef!)!.toString('utf8')));
      expect(layoutDoc.gems).toEqual([]);
      expect(layoutDoc.palette).toEqual({});
      // 损坏 view-state=生成拒（诊断+零工件）。
      const brokenRef = s.blobs.put(Buffer.from('not-json{', 'utf8')).hash;
      s.jobs.emitFor(taskId, 'artifact', { blobRef: brokenRef, name: 'workbench-view-state.json' });
      const refused = writeTaskLayoutForExecution({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, base);
      expect(refused.blobRef).toBeNull();
      expect(refused.diagnostics[0]).toContain('可见性无法判定');
    } finally {
      s.dispose();
    }
  });
});
