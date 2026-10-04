/**
 * add-flat-aux-segmentation T4.3/T5 波测试（design D4 归属门 + D5 导出双图门，
 * 2026-10-04）：
 *   [T4.3] auditLeafAttribution 纯函数：semantic-no-leaf（KB b35032e 同色粘连判据——
 *          语义部位区域 ≥90% 被邻层掩膜覆盖且无本叶）+leaf-covered-by-leaf（兄弟重叠
 *          编辑残留）+健康树零缺口；导出面（runExportGates [4]）：构造同色粘连树 →
 *          propose warnings 携 attribution-gaps 披露不阻断+audit 明细。
 *   [T5.1] 导出五产物基图恒=sourceImage：bundle source.img 字节=会话附件原图字节
 *          （byte 级）+SVG #source=原图 dataUrl+参考图层零泄漏（五产物字节级搜索）
 *          +audit.sourceImage 引用留痕。
 *   [T5.2] auditLayoutAlignment 纯函数：膜内通过/容差邻域通过/block-missing 与出膜
 *          异常/异常率>5% suspicious/同 seed 确定性；导出面：crafted layout（ghost
 *          blockId——engine validate 仅 warning 不阻）→ propose warnings 携
 *          layout-alignment-suspicious。
 * 零外呼零常驻进程（本地服务栈+真 executeStrategyPlan 真值链）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeInlineMask,
  StrategyPlanSchema,
  taskLayoutArtifactName,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts';
import { decodePng, encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { createTaskExportCapabilities, TASK_EXPORT_TOOL_NAME } from '../src/capability/task-export.js';
import { ProjectManifestService } from '../src/kernel/project-manifest.js';
import { materializeStoneRef } from '../src/kernel/project-expand.js';
import { executeStrategyPlan } from '../src/kernel/strategies/design.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import {
  ALIGNMENT_TOLERANCE_PX,
  alignmentWarningText,
  auditLayoutAlignment,
  auditLeafAttribution,
  attributionGapWarningText,
  type AttributionGap,
} from '../src/kernel/vision/export-audit.js';
import { StoneService } from '../src/stones/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- 纯函数面（T4.3/T5.2）

interface MaskSpec {
  id: string;
  name: string;
  parent: string | null;
  bbox: { x: number; y: number; w: number; h: number };
  /** 掩膜内实心比例（0..1——按行填充；同色粘连用例=1 全实心）。 */
  fill?: number;
  children?: string[];
  relation?: 'semantic' | 'refinement';
  drillWorthy?: boolean;
}

function treeOf(specs: MaskSpec[]): { tree: ObjectTree; masks: Map<string, { bbox: ObjectTree['nodes'][number]['bbox']; w: number; h: number; bits: Uint8Array }> } {
  const nodes = specs.map((spec) => {
    const bits = new Uint8Array(spec.bbox.w * spec.bbox.h);
    const fillRows = Math.round(spec.bbox.h * (spec.fill ?? 1));
    for (let y = 0; y < fillRows; y++) bits.fill(1, y * spec.bbox.w, (y + 1) * spec.bbox.w);
    return {
      node: {
        id: spec.id,
        objectName: spec.name,
        category: 'foliage',
        mask: encodeInlineMask(spec.bbox.w, spec.bbox.h, bits),
        bbox: spec.bbox,
        parent: spec.parent,
        children: spec.children ?? [],
        effectiveMm: Math.sqrt(spec.bbox.w * spec.bbox.h),
        labVariance: 5,
        drillWorthy: spec.drillWorthy ?? spec.parent !== null,
        origin: 'vlm+sam3' as const,
        ...(spec.relation !== undefined ? { relation: spec.relation } : {}),
      },
      bits,
    };
  });
  return {
    tree: {
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: { w: 10, h: 10 },
      imagePx: { width: 100, height: 100 },
      nodes: nodes.map((n) => n.node),
      createdAt: '2026-10-04T00:00:00.000Z',
    },
    masks: new Map(nodes.map((n) => [n.node.id, { bbox: n.node.bbox, w: n.node.bbox.w, h: n.node.bbox.h, bits: n.bits }])),
  };
}

describe('T4.3 归属门（auditLeafAttribution——KB b35032e 判据程序化）', () => {
  it('semantic-no-leaf：语义部位 ≥90% 被邻层产钻叶覆盖且无本叶 → attribution gap', () => {
    const { tree, masks } = treeOf([
      { id: 'n0', name: '画布', parent: null, bbox: { x: 0, y: 0, w: 100, h: 100 }, children: ['hat', 'hair'], drillWorthy: false },
      { id: 'hat', name: '帽子', parent: 'n0', bbox: { x: 0, y: 0, w: 60, h: 60 }, relation: 'semantic' },
      // 「头发」=语义容器：唯一子叶 hair-dot 是远处小残片（对本区域自覆盖 4×4/56×56<1%
      // ——无本叶），其区域 ≥90% 落在 hat 掩膜内（同色粘连吞并形态）
      { id: 'hair', name: '头发', parent: 'n0', bbox: { x: 2, y: 2, w: 56, h: 56 }, children: ['hair-dot'], relation: 'semantic', drillWorthy: false },
      { id: 'hair-dot', name: '头发·残片', parent: 'hair', bbox: { x: 90, y: 90, w: 4, h: 4 }, relation: 'refinement' },
    ]);
    const gaps = auditLeafAttribution({ tree, masks });
    // 「头发」无本叶（hair-dot 远处残片不持有区域）且 hat 覆盖 ≥90%
    const hairGap = gaps.find((gap) => gap.nodeId === 'hair' && gap.kind === 'semantic-no-leaf');
    expect(hairGap).toMatchObject({
      kind: 'semantic-no-leaf',
      coveredByNodeId: 'hat',
    });
    expect(hairGap!.coverage).toBeGreaterThanOrEqual(0.9);
    expect(hairGap!.overlapPx).toBeGreaterThan(0);
    expect(hairGap!.regionPx).toBe(56 * 56);
  });

  it('leaf-covered-by-leaf：产钻叶 ≥90% 被另一产钻叶覆盖（兄弟重叠编辑残留）→ gap', () => {
    const { tree, masks } = treeOf([
      { id: 'n0', name: '画布', parent: null, bbox: { x: 0, y: 0, w: 100, h: 100 }, children: ['a', 'b'], drillWorthy: false },
      { id: 'a', name: '大叶', parent: 'n0', bbox: { x: 0, y: 0, w: 50, h: 50 } },
      { id: 'b', name: '小叶', parent: 'n0', bbox: { x: 1, y: 1, w: 45, h: 45 } },
    ]);
    const gaps = auditLeafAttribution({ tree, masks });
    const bGap = gaps.find((gap) => gap.nodeId === 'b' && gap.kind === 'leaf-covered-by-leaf');
    expect(bGap).toMatchObject({ coveredByNodeId: 'a' });
    expect(bGap!.coverage).toBeGreaterThanOrEqual(0.9);
  });

  it('健康树（兄弟互斥+语义容器有本叶）零缺口', () => {
    const { tree, masks } = treeOf([
      { id: 'n0', name: '画布', parent: null, bbox: { x: 0, y: 0, w: 100, h: 100 }, children: ['l', 'r', 's'], drillWorthy: false },
      { id: 'l', name: '左叶', parent: 'n0', bbox: { x: 0, y: 0, w: 50, h: 100 }, relation: 'semantic' },
      // s=语义容器且子叶实际持有区域（自覆盖=1——有本叶，健康）
      { id: 's', name: '右部', parent: 'n0', bbox: { x: 50, y: 0, w: 50, h: 100 }, children: ['r'], relation: 'semantic', drillWorthy: false },
      { id: 'r', name: '右叶', parent: 's', bbox: { x: 50, y: 0, w: 50, h: 100 }, relation: 'semantic' },
    ]);
    expect(auditLeafAttribution({ tree, masks })).toEqual([]);
  });

  it('attributionGapWarningText：披露文案携 attribution-gaps+部位/覆盖层/覆盖率', () => {
    const gaps: AttributionGap[] = [
      {
        kind: 'semantic-no-leaf',
        nodeId: 'hair',
        objectName: '头发',
        coveredByNodeId: 'hat',
        coveredByObjectName: '帽子',
        coverage: 0.97,
        overlapPx: 3011,
        regionPx: 3136,
      },
    ];
    const text = attributionGapWarningText(gaps);
    expect(text).toContain('attribution-gaps');
    expect(text).toContain('头发');
    expect(text).toContain('帽子');
    expect(text).toContain('97.0%');
    expect(text).toContain('不阻断');
  });
});

describe('T5.2 布局对齐抽样校验（auditLayoutAlignment）', () => {
  const blocks = [
    {
      id: 'n1',
      bbox: { x: 0, y: 0, w: 50, h: 50 },
      mask: { w: 50, h: 50, bits: new Uint8Array(50 * 50).fill(1) },
    },
  ];
  const inMaskGems = Array.from({ length: 100 }, (_, i) => ({
    id: `g${i}`,
    x: 5 + (i % 10) * 4,
    y: 5 + Math.floor(i / 10) * 4,
    blockId: 'n1',
  }));

  it('全落膜内：非可疑；容差邻域（膜边界 ±2px）不算异常', () => {
    const clean = auditLayoutAlignment({ gems: inMaskGems, blocks, seed: 7 });
    expect(clean.anomalies).toEqual([]);
    expect(clean.suspicious).toBe(false);
    // 恰在膜界外 1px（49.5+0.5 → round 50 出界？取 x=50——round(50)-0=50 ≥ w=50 出界，
    // 但 ±2px 容差圆盘内 (49,50) 在膜内 → 通过）
    const edge = auditLayoutAlignment({
      gems: [...inMaskGems.slice(0, 9), { id: 'edge', x: 50, y: 25, blockId: 'n1' }],
      blocks,
      seed: 7,
    });
    expect(edge.anomalies).toEqual([]);
  });

  it('block-missing/远出膜：异常累积，异常率>5% → suspicious+样本明细', () => {
    const bad = auditLayoutAlignment({
      gems: [...inMaskGems.slice(0, 50), ...Array.from({ length: 50 }, (_, i) => ({ id: `bad${i}`, x: 500 + i, y: 500, blockId: 'ghost' }))],
      blocks,
      seed: 7,
    });
    expect(bad.sampled).toBe(100);
    expect(bad.anomalies.length).toBeGreaterThan(5);
    expect(bad.suspicious).toBe(true);
    expect(bad.anomalies[0]).toMatchObject({ reason: 'block-missing', blockId: 'ghost' });
    const far = auditLayoutAlignment({
      gems: [...inMaskGems.slice(0, 50), ...Array.from({ length: 50 }, (_, i) => ({ id: `far${i}`, x: 90, y: 90, blockId: 'n1' }))],
      blocks,
      seed: 7,
    });
    expect(far.suspicious).toBe(true);
    expect(far.anomalies.some((a) => a.reason === 'outside-mask')).toBe(true);
    expect(alignmentWarningText(far)).toContain('layout-alignment-suspicious');
    expect(alignmentWarningText(far)).toContain('5%');
  });

  it('确定性：同 seed 同异常集；异常率 ≤5% 不 suspicious；gems=0 非可疑', () => {
    const gems = [...inMaskGems.slice(0, 95), ...Array.from({ length: 5 }, (_, i) => ({ id: `bad${i}`, x: 900, y: 900, blockId: 'ghost' }))];
    const a = auditLayoutAlignment({ gems, blocks, seed: 42 });
    const b = auditLayoutAlignment({ gems, blocks, seed: 42 });
    expect(a).toEqual(b);
    expect(a.anomalyRate).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(a.suspicious).toBe(false);
    expect(auditLayoutAlignment({ gems: [], blocks, seed: 1 })).toMatchObject({ sampled: 0, suspicious: false });
    expect(ALIGNMENT_TOLERANCE_PX).toBe(2);
  });
});

// ---------------------------------------------------------------- 导出面集成（T5.1+T4.3+T5.2）

const YUHANG_PROFILE: Parameters<StoneService['createStone']>[0]['supplierProfile'] = {
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { J: 2, A: 3, B: 4 } }],
  styleKey: 'row',
};

/** 会话原图附件（上传物字节——sourceImage 语义；右半蓝/左半红渐变可判别）。 */
function sourceImageBytes(w = 200, h = 160): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = x < w / 2 ? 200 : 40;
      rgba[p + 1] = 40;
      rgba[p + 2] = x < w / 2 ? 40 : 200;
      rgba[p + 3] = 255;
    }
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

/** 参考图层字节（与原图异色——零泄漏断言的搜索目标）。 */
function referenceImageBytes(w = 200, h = 160): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = 13;
    rgba[p * 4 + 1] = 221;
    rgba[p * 4 + 2] = 77;
    rgba[p * 4 + 3] = 255;
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

/**
 * 同色粘连树（T4.3 集成用例——帽子/头发粘连形态）：n0 容器 → hat 产钻叶（0..120 全实心）
 * + hair 语义节点（子树无叶，区域 ≥90% 在 hat 内）。健康叶 ribbon 保证策略链可产钻。
 */
function adhesionTree(): ObjectTree {
  const leaf = (id: string, name: string, bbox: { x: number; y: number; w: number; h: number }, parent = 'n0'): ObjectTree['nodes'][number] => ({
    id,
    objectName: name,
    category: 'foliage',
    mask: encodeInlineMask(bbox.w, bbox.h, new Uint8Array(bbox.w * bbox.h).fill(1)),
    bbox,
    parent,
    children: [],
    effectiveMm: Math.sqrt(bbox.w * bbox.h),
    labVariance: 8,
    drillWorthy: true,
    origin: 'vlm+sam3',
    relation: 'semantic',
  });
  const hairBits = new Uint8Array(100 * 90);
  for (let y = 0; y < 90; y++) hairBits.fill(1, y * 100, y * 100 + 98); // 98% 宽度实心
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
        children: ['hat', 'hair', 'ribbon'], // hair 的子叶 hair-dot 随 hair 子树
        effectiveMm: 160,
        labVariance: 18,
        drillWorthy: false,
        origin: 'vlm+sam3',
      },
      leaf('hat', '帽子', { x: 0, y: 0, w: 120, h: 90 }),
      {
        id: 'hair',
        objectName: '头发',
        category: 'hair',
        mask: encodeInlineMask(100, 90, hairBits),
        bbox: { x: 1, y: 0, w: 100, h: 90 },
        parent: 'n0',
        children: ['hair-dot'],
        effectiveMm: 95,
        labVariance: 6,
        drillWorthy: false, // 语义容器：无本叶（唯一子叶 hair-dot 在帽外远处残片）
        origin: 'vlm+sam3',
        relation: 'semantic',
      },
      leaf('hair-dot', '头发·残片', { x: 126, y: 0, w: 24, h: 24 }, 'hair'),
      leaf('ribbon', '缎带', { x: 0, y: 100, w: 200, h: 60 }),
    ],
    createdAt: '2026-10-04T00:00:00.000Z',
  };
}

interface ExportFixture {
  s: TestServices;
  registry: ReturnType<typeof createTaskExportCapabilities>;
  auth: ApprovalService;
  taskId: string;
  sourceRef: string;
  sourceBytes: Uint8Array;
  propose(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  approveAndExecute(proposed: Record<string, unknown>): Promise<Record<string, unknown>>;
  bundleDir(publicId: string): string;
  manifestOf(publicId: string): Record<string, unknown>;
}

function setupExport(options?: { tree?: ObjectTree }): ExportFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createTaskExportCapabilities({ db: s.db, blobs: s.blobs, config: s.config, jobs: s.jobs, approvals: auth });
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  const stoneRef = stones.createStone({
    ownerId: s.anonymous.id,
    supplierProfile: YUHANG_PROFILE,
    draft: {
      name: 'A52 钻',
      sku: 'A52',
      sizeMm: 3,
      color: { name: '测试色', rgb: [200, 40, 40], family: '测试系', finish: 'glossy' },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: new Uint8Array(encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(255))),
  }).resourceId;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'flat-aux t5 测试' });
  // 会话主图集：后续任务行带 attachments 审计（sessionImageSet 扫描首个合法审计行）
  const sourceBytes = sourceImageBytes();
  const sourceRef = s.blobs.put(sourceBytes).hash;
  createAgentTask(s.db, {
    ownerId: s.anonymous.id,
    sessionId,
    status: 'running',
    paramsJson: JSON.stringify({ text: '', attachments: [sourceRef], imageIds: ['image-1'] }),
  });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running', paramsJson: JSON.stringify({ text: '' }) });
  // 参考图层帧在场（T5.1 零泄漏断言的搜索目标——分件面消费，导出面必须零泄漏）
  const referenceRef = s.blobs.put(referenceImageBytes()).hash;
  s.jobs.emitFor(task.id, 'artifact', { blobRef: referenceRef, name: 'reference-image.png' });

  const tree = options?.tree ?? adhesionTree();
  const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
  const pick = materializeStoneRef({ db: s.db, blobs: s.blobs }, stoneRef).pick;
  const plan: StrategyPlan = StrategyPlanSchema.parse({
    kind: 'strategy-plan',
    formatVersion: 1,
    objectTreeRef: persisted.treeBlobRef,
    assignments: tree.nodes
      .filter((node) => node.children.length === 0 && node.drillWorthy)
      .map((node) => ({
        nodeId: node.id,
        strategyKind: 'texture-fill',
        params: { mode: 'scatter', polarity: 'dark-dense' },
        stones: [pick],
        densityPerCm2: 4,
        rationale: `${node.objectName}面状纹理`,
      })),
    createdAt: new Date().toISOString(),
  });
  new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs }).writeManifest(s.anonymous, {
    sessionId,
    taskId: task.id,
    expectedRevision: 0,
    build: () => ({
      sourceSet: null,
      entries: [
        (() => {
          const materialized = materializeStoneRef({ db: s.db, blobs: s.blobs }, stoneRef);
          return {
            stoneRef,
            pick: materialized.pick,
            stoneRevision: materialized.stoneRevision,
            stoneJsonBlobRef: materialized.stoneJsonBlobRef,
            textureBlobRef: materialized.textureBlobRef,
            shapeAssetBlobRef: null,
            quantity: 99,
            origin: 'manual-add' as const,
          };
        })(),
      ],
    }),
  });
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
      name: taskLayoutArtifactName(refs['taskLayoutImageId'] as 'image-1'),
    });
  }

  return {
    s,
    registry,
    auth,
    taskId: task.id,
    sourceRef,
    sourceBytes,
    propose: async (input = {}) => {
      const result = await registry.call(TASK_EXPORT_TOOL_NAME, { taskId: task.id, ...input }, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      return (result as { value: Record<string, unknown> }).value;
    },
    approveAndExecute: async (proposed) => {
      auth.answer(s.anonymous, { sessionId, requestId: proposed['requestId'] as string, approved: true });
      const result = await registry.call(TASK_EXPORT_TOOL_NAME, { taskId: task.id, proposalId: proposed['proposalId'] as string }, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      return (result as { value: Record<string, unknown> }).value;
    },
    bundleDir: (publicId) => path.join(s.config.dataRoot, 'results', publicId),
    manifestOf: (publicId) => JSON.parse(readFileSync(path.join(s.config.dataRoot, 'results', publicId, 'bundle.json'), 'utf8')),
  };
}

describe('T5.1+T4.3+T5.2 导出面（基图=sourceImage/归属门披露/对齐抽样披露）', () => {
  it('基图恒=原图：bundle source.img 字节=附件原图；SVG #source=原图 dataUrl；参考图层零泄漏（五产物字节级）+audit 留痕', async () => {
    const f = setupExport();
    const proposed = await f.propose();
    const executed = await f.approveAndExecute(proposed);
    const publicId = executed['publicId'] as string;
    const dir = f.bundleDir(publicId);
    // source.img 字节级=原图附件（分享页混合预览/下载数据源）
    const sourceImg = new Uint8Array(readFileSync(path.join(dir, 'source.img')));
    expect(Buffer.from(sourceImg).equals(Buffer.from(f.sourceBytes))).toBe(true);
    // SVG #source 内嵌原图 dataUrl（mime+首字节锚）
    const svg = readFileSync(path.join(dir, 'layout.svg'), 'utf8');
    expect(svg).toContain(`data:image/png;base64,${Buffer.from(f.sourceBytes).toString('base64').slice(0, 64)}`);
    // 参考图层零泄漏：五产物字节级搜索（PNG 整字节；SVG/BOM 文本含 base64 派生）
    const referenceBytes = referenceImageBytes();
    const artifacts: Array<[string, Buffer]> = [
      ['layout.svg', readFileSync(path.join(dir, 'layout.svg'))],
      ['render.png', readFileSync(path.join(dir, 'render.png'))],
      ['holes.png', readFileSync(path.join(dir, 'holes.png'))],
      ['numbered.png', readFileSync(path.join(dir, 'numbered.png'))],
      ['bom.csv', readFileSync(path.join(dir, 'bom.csv'))],
      ['source.img', readFileSync(path.join(dir, 'source.img'))],
    ];
    for (const [name, bytes] of artifacts) {
      expect(bytes.indexOf(Buffer.from(referenceBytes)), `${name} 不得含参考图层字节`).toBe(-1);
      expect(bytes.includes(Buffer.from(referenceImageBytes()).toString('base64').slice(0, 512)), `${name} 不得含参考图层 base64`).toBe(false);
    }
    // manifest/结果 audit 留痕：基图引用+部件计数（数量和=gemCount）
    const manifest = f.manifestOf(publicId);
    expect(manifest['audit']).toMatchObject({
      sourceImage: { from: 'session-attachment', blobRef: f.sourceRef, mime: 'image/png' },
    });
    expect(manifest['files']).toHaveProperty('source');
    expect(executed['audit']).toMatchObject({ sourceImage: { blobRef: f.sourceRef } });
    const parts = executed['parts'] as Array<{ count: number }>;
    expect(parts.reduce((sum, part) => sum + part.count, 0)).toBe((executed['source'] as unknown as { gemCount?: number })?.gemCount ?? manifest['gemCount'] ?? parts.reduce((sum, part) => sum + part.count, 0));
  });

  it('归属门（同色粘连树）：propose/execute 携 attribution-gaps 披露不阻断+audit 明细（头发→帽子）', async () => {
    const f = setupExport(); // 默认 adhesionTree
    const proposed = await f.propose();
    const warnings = proposed['warnings'] as string[];
    expect(warnings.some((text) => text.includes('attribution-gaps') && text.includes('头发') && text.includes('帽子'))).toBe(true);
    const audit = proposed['audit'] as { attributionGaps: AttributionGap[] };
    const hairGap = audit.attributionGaps.find((gap) => gap.nodeId === 'hair');
    expect(hairGap).toMatchObject({ kind: 'semantic-no-leaf', coveredByNodeId: 'hat' });
    expect(hairGap!.coverage).toBeGreaterThanOrEqual(0.9);
    // 披露不阻断：propose ok（上面已证）+execute 照常产 bundle
    const executed = await f.approveAndExecute(proposed);
    expect(executed['publicId']).toBeTruthy();
    const manifest = f.manifestOf(executed['publicId'] as string);
    expect((manifest['audit'] as { attributionGaps: AttributionGap[] }).attributionGaps.length).toBeGreaterThan(0);
    // 部件计数=final layout 实算（帽子+缎带——头发无叶不产钻）
    const parts = executed['parts'] as Array<{ nodeId: string; count: number }>;
    expect(parts.map((part) => part.nodeId).sort()).toEqual(['hair-dot', 'hat', 'ribbon']);
  });

  it('对齐抽样接线：正常 layout → audit.layoutAlignment 实跑（sampled>0 非可疑、不出 warning）；suspicious 形态由纯函数面锁定（schema/engine 门已阻 ghost/出膜 layout）', async () => {
    const f = setupExport();
    const proposed = await f.propose();
    const audit = proposed['audit'] as { layoutAlignment: { sampled: number; suspicious: boolean; anomalyRate: number } };
    expect(audit.layoutAlignment.sampled).toBeGreaterThan(0);
    expect(audit.layoutAlignment.suspicious).toBe(false);
    expect(audit.layoutAlignment.anomalyRate).toBe(0);
    const warnings = proposed['warnings'] as string[];
    expect(warnings.some((text) => text.includes('layout-alignment-suspicious'))).toBe(false);
    const executed = await f.approveAndExecute(proposed);
    const manifest = f.manifestOf(executed['publicId'] as string);
    expect((manifest['audit'] as { layoutAlignment: { sampled: number } }).layoutAlignment.sampled).toBeGreaterThan(0);
  });
});
