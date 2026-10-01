/**
 * 密度绝对颗数语义回归（realize-scene-understanding T3 / Codex C2+C3——2026-09-28）。
 *
 * 根因背景（Codex C1）：旧换算 design.ts `density=densityPerCm2/2.3` 把 2.3 当引擎
 * 满铺基线——texture-fill 小区域可读下限触发 fallback 后绝对密度被改成「基准晶格
 * 100%」（左手 71 颗 vs 预期 13）。本套冻结新契约：
 *   [1] engineDensityConversion：baseDensityPerCm2=2/(√3·pitchCm²)（pitchMm=钻径+
 *       gap——**含 gap** 的引擎实际晶格 GridSpec）；2mm 钻+0.4mm gap 基准≈20.05
 *       颗/cm²；2.3→ratio≈0.115；超容量（ratio>1）=typed 拒不静默 clamp。
 *   [2] 左手 mask fixture（736px=20cm 画布，bbox 75×106px≈5.88cm²）：2.3 颗/cm²
 *       →≈13 颗（误差门 max(2,20%)——Codex C3）；2.3→4.6 单调近倍增无满铺断点。
 *   [3] 三路径同口径：texture-fill 直达 / 显式 engineStrategy=hex-pitch / 小区域
 *       fallback hex-pitch（<MIN_READABLE_GEMS 降级）——同一绝对目标密度。
 *   [4] 产物保留用户口径+诊断字段（nodeSummaries.density / gems 工件 nodeDensities）。
 *   [5] prompt 旧注释「2.3=满铺基线上限」删除（绝对语义措辞在场）。
 * 真链走查 P1 修正（2026-10-01 小丑图会话 1187ce52）：MIN_READABLE_GEMS 24→3
 * （声明密度优先——小部位颗数少是正确结果，<3 才形态兜底降级 hex）+stipple 六方
 * 胞元校正（颗数≈面积×密度而非 +15.5% 系统性超出）。
 * 零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import {
  encodeInlineMask,
  StrategyPlanSchema,
  SupplierSkuProfileSchema,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { StoneService } from '../src/stones/service.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import { strategyEngineDelegate, } from '../src/kernel/index.js';
import {
  buildStrategyDesignPrompt,
  engineDensityConversion,
  ENGINE_DELEGATION_GAP_MM,
  executeStrategyPlan,
  StrategyDesignError,
  type StoneCandidate,
} from '../src/kernel/strategies/design.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- 常量与工具

const SQRT3 = Math.sqrt(3);
const HAND_BBOX = { x: 170, y: 380, w: 75, h: 106 }; // Codex C1 左手锚（736 画布）
const PPM = 736 / 200; // px/mm（20cm 画布——736px=200mm）

/** 误差门（Codex C3 冻结）：max(2, 20%)——绝对/相对取宽者。 */
function withinGate(actual: number, expected: number): boolean {
  const tolerance = Math.max(2, Math.abs(expected) * 0.2);
  return Math.abs(actual - expected) <= tolerance + 1e-9;
}

/** mask 有效面积（cm²——popcount 真源，非 bbox 面积）。 */
function maskAreaCm2(bits: Uint8Array): number {
  let popcount = 0;
  for (const b of bits) popcount += b;
  return popcount / (PPM * PPM) / 100;
}

function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

function textureBytes(): Uint8Array {
  const size = 128;
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - c) * (x - c) + (y - c) * (y - c) <= r * r) {
        const p = (y * size + x) * 4;
        rgba[p] = 200;
        rgba[p + 1] = 200;
        rgba[p + 2] = 200;
        rgba[p + 3] = 255;
      }
    }
  }
  return new Uint8Array(encodePng(size, size, rgba));
}

const YUHANG = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航（密度回归）',
  bands: [{ rows: [51, 78], sizeMmByPrefix: { J: 2 } }],
  styleKey: 'row',
});

/** 左手树（736×736=20×20cm——Codex C1 锚点；叶=左手 bbox 实心 mask）。 */
function handTree(): { tree: ObjectTree; handBits: Uint8Array } {
  const handBits = new Uint8Array(HAND_BBOX.w * HAND_BBOX.h).fill(1);
  const tree: ObjectTree = {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 20, h: 20 },
    imagePx: { width: 736, height: 736 },
    nodes: [
      {
        id: 'n-canvas',
        objectName: '画布',
        category: 'canvas',
        mask: solidMask(736, 736),
        bbox: { x: 0, y: 0, w: 736, h: 736 },
        parent: null,
        children: ['n-hand'],
        effectiveMm: 200,
        labVariance: 40,
        drillWorthy: false,
        origin: 'vlm+sam3',
      },
      {
        id: 'n-hand',
        objectName: '左手',
        category: 'body',
        mask: encodeInlineMask(HAND_BBOX.w, HAND_BBOX.h, handBits),
        bbox: { ...HAND_BBOX },
        parent: 'n-canvas',
        children: [],
        effectiveMm: Math.sqrt(HAND_BBOX.w * HAND_BBOX.h) / PPM,
        labVariance: 9.2,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
    ],
    createdAt: '2026-09-28T00:00:00.000Z',
  };
  return { tree, handBits };
}

/** 小区域树（20×30px≈0.44cm²——texture-fill <3 颗可读兜底下限触发 fallback hex-pitch）。 */
function smallRegionTree(): ObjectTree {
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 20, h: 20 },
    imagePx: { width: 736, height: 736 },
    nodes: [
      {
        id: 'n-canvas',
        objectName: '画布',
        category: 'canvas',
        mask: solidMask(736, 736),
        bbox: { x: 0, y: 0, w: 736, h: 736 },
        parent: null,
        children: ['n-small'],
        effectiveMm: 200,
        labVariance: 40,
        drillWorthy: false,
        origin: 'vlm+sam3',
      },
      {
        id: 'n-small',
        objectName: '小区域',
        category: 'body',
        mask: solidMask(20, 30),
        bbox: { x: 300, y: 300, w: 20, h: 30 },
        parent: 'n-canvas',
        children: [],
        effectiveMm: Math.sqrt(20 * 30) / PPM,
        labVariance: 5,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
    ],
    createdAt: '2026-09-28T00:00:00.000Z',
  };
}

interface Fixture {
  s: TestServices;
  taskId: string;
  treeArtifactRef: string;
  candidates: StoneCandidate[]; // idx1=2mm（密度回归唯一候选）
  dispose(): void;
}

function setup(tree: ObjectTree): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '密度绝对语义回归' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const treeArtifactRef = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree).treeBlobRef;
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  const j2 = stones.createStone({
    ownerId: s.anonymous.id,
    supplierProfile: YUHANG,
    draft: {
      name: 'J51 钻',
      sku: 'J51',
      sizeMm: 2,
      color: { name: '密度回归白', rgb: [240, 240, 232], family: '白色系', finish: 'glossy' },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: textureBytes(),
  });
  const candidates: StoneCandidate[] = [
    { idx: 1, pick: { resourceId: j2.resourceId, sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#F0F0E8' }, family: '白色系' },
  ];
  return {
    s,
    taskId: task.id,
    treeArtifactRef,
    candidates,
    dispose: () => s.dispose(),
  };
}

function planOf(f: Fixture, assignment: {
  nodeId: string;
  strategyKind: 'texture-fill' | 'exclusion';
  params: Record<string, unknown>;
  densityPerCm2: number;
  engineStrategy?: 'hex-pitch';
}): StrategyPlan {
  return StrategyPlanSchema.parse({
    kind: 'strategy-plan',
    formatVersion: 1,
    objectTreeRef: f.treeArtifactRef,
    assignments: [
      {
        nodeId: assignment.nodeId,
        strategyKind: assignment.strategyKind,
        params: assignment.params,
        stones: assignment.strategyKind === 'exclusion' ? [] : [f.candidates[0]!.pick],
        densityPerCm2: assignment.densityPerCm2,
        ...(assignment.engineStrategy !== undefined ? { engineStrategy: assignment.engineStrategy } : {}),
        rationale: '密度绝对语义回归',
      },
    ],
    createdAt: '2026-09-28T00:00:00.000Z',
  });
}

// ---------------------------------------------------------------- [1] 换算纯函数

describe('engineDensityConversion（T3 公式修正版——Codex C2）', () => {
  it('基准容量按含 gap 的引擎实际晶格：2mm 钻+0.4mm gap → ≈20.05 颗/cm²；2.3 → ratio≈0.115', () => {
    expect(ENGINE_DELEGATION_GAP_MM).toBe(0.4); // 与 strategyEngineDelegate gridFromSpec 同源
    const { densityRatio, baseDensityPerCm2 } = engineDensityConversion(2.3, 2);
    const pitchCm = (2 + 0.4) / 10;
    expect(baseDensityPerCm2).toBeCloseTo(2 / (SQRT3 * pitchCm * pitchCm), 6);
    expect(baseDensityPerCm2).toBeCloseTo(20.05, 1);
    expect(densityRatio).toBeCloseTo(2.3 / 20.049, 4); // ≈0.1147——非「2.3/2.3=1」旧口径
  });

  it('超容量 typed 拒 density-capacity-exceeded——禁止静默 clamp 到 1', () => {
    // 2mm 钻容量 ≈20.05；25 颗/cm² 必拒（降 gap/换小钻径是显式决策）
    expect(() => engineDensityConversion(25, 2)).toThrow(StrategyDesignError);
    try {
      engineDensityConversion(25, 2);
    } catch (error) {
      expect((error as StrategyDesignError).kind).toBe('density-capacity-exceeded');
      expect((error as StrategyDesignError).message).toContain('基准容量');
    }
    // 1mm 钻容量 ≈86.8——25 合法（容量随钻径变化：改钻径后按 cm² 仍可预测）
    expect(engineDensityConversion(25, 1).densityRatio).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------- [2][3] 左手回归+三路径

describe('左手 mask fixture 密度回归（Codex C3 误差门 max(2,20%)）', () => {
  it('左手 2.3 颗/cm² → ≈13 颗（非 71——旧「/2.3」口径把 fallback 改成满铺的特征值）', () => {
    const { tree, handBits } = handTree();
    const f = setup(tree);
    try {
      const expected = 2.3 * maskAreaCm2(handBits); // ≈2.3×5.87≈13.5
      expect(expected).toBeGreaterThan(12);
      expect(expected).toBeLessThan(15);
      const out = executeStrategyPlan(
        { db: f.s.db, blobs: f.s.blobs },
        { taskId: f.taskId, plan: planOf(f, { nodeId: 'n-hand', strategyKind: 'texture-fill', params: { mode: 'scatter' }, densityPerCm2: 2.3 }), engineLayout: strategyEngineDelegate },
      );
      const value = out.value as {
        gemCount: number;
        warnings: Array<{ kind: string; detail: string }>;
        nodeSummaries: Array<{ nodeId: string; gemCount: number; engineDelegation?: { strategy: string; reason: string } }>;
      };
      const summary = value.nodeSummaries.find((s) => s.nodeId === 'n-hand')!;
      // 走查 P1 修正（24→3 下限）：13 颗 ≥ 3——**保形自产钻不降级**（旧 24 下限把
      // texture-fill 强制降级 hex 形态；降级密度口径已由 d30edfb 保住，本修再保形态）。
      expect(summary.engineDelegation).toBeUndefined();
      expect(value.warnings.some((w: { kind: string; detail: string }) => w.kind === 'degraded' && w.detail.includes('可读下限'))).toBe(false);
      expect(withinGate(value.gemCount, expected)).toBe(true);
      expect(value.gemCount).toBeLessThan(20); // 满铺断点防回归（71 颗=旧口径特征）
    } finally {
      f.dispose();
    }
  });

  it('texture-fill 直达（大区域 ≥ 可读下限）：engineDelegation 缺席+绝对口径成立', () => {
    // 200×200px 实心 ≈29.5cm²——2.3×29.5≈68 颗 ≥ 24 可读下限（不触发 fallback）
    const tree = handTree().tree;
    tree.nodes = tree.nodes.map((node) =>
      node.id === 'n-canvas' ? node : { ...node, objectName: '大区域', mask: solidMask(200, 200), bbox: { x: 100, y: 100, w: 200, h: 200 } },
    );
    const f = setup(tree);
    try {
      const expected = 2.3 * maskAreaCm2(new Uint8Array(200 * 200).fill(1));
      expect(expected).toBeGreaterThanOrEqual(24);
      const out = executeStrategyPlan(
        { db: f.s.db, blobs: f.s.blobs },
        { taskId: f.taskId, plan: planOf(f, { nodeId: 'n-hand', strategyKind: 'texture-fill', params: { mode: 'scatter' }, densityPerCm2: 2.3 }), engineLayout: strategyEngineDelegate },
      );
      const value = out.value as { gemCount: number; nodeSummaries: Array<{ nodeId: string; engineDelegation?: unknown }> };
      expect(value.nodeSummaries.find((s) => s.nodeId === 'n-hand')!.engineDelegation).toBeUndefined();
      expect(withinGate(value.gemCount, expected)).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it('显式 engineStrategy=hex-pitch：同一绝对口径 → ≈13 颗（引擎乘数=densityRatio）', () => {
    const { tree, handBits } = handTree();
    const f = setup(tree);
    try {
      const expected = 2.3 * maskAreaCm2(handBits);
      const out = executeStrategyPlan(
        { db: f.s.db, blobs: f.s.blobs },
        { taskId: f.taskId, plan: planOf(f, { nodeId: 'n-hand', strategyKind: 'texture-fill', params: { mode: 'scatter' }, densityPerCm2: 2.3, engineStrategy: 'hex-pitch' }), engineLayout: strategyEngineDelegate },
      );
      const value = out.value as { gemCount: number };
      expect(withinGate(value.gemCount, expected)).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it('fallback hex-pitch（小区域 <MIN_READABLE_GEMS=3 降级）：目标密度不被改成满铺', () => {
    const tree = smallRegionTree();
    const f = setup(tree);
    try {
      const bits = new Uint8Array(20 * 30).fill(1);
      const expected = 2.3 * maskAreaCm2(bits); // ≈1.0——远低于 3 颗可读兜底下限
      expect(expected).toBeLessThan(3);
      const out = executeStrategyPlan(
        { db: f.s.db, blobs: f.s.blobs },
        { taskId: f.taskId, plan: planOf(f, { nodeId: 'n-small', strategyKind: 'texture-fill', params: { mode: 'scatter' }, densityPerCm2: 2.3 }), engineLayout: strategyEngineDelegate },
      );
      const value = out.value as {
        gemCount: number;
        warnings: Array<{ kind: string; detail: string }>;
        nodeSummaries: Array<{ nodeId: string; gemCount: number; engineDelegation?: { strategy: string; reason: string } }>;
      };
      const summary = value.nodeSummaries.find((s) => s.nodeId === 'n-small')!;
      // 降级事实明示（fallback 只改形态不改目标密度）
      expect(summary.engineDelegation).toMatchObject({ strategy: 'hex-pitch', reason: 'degraded' });
      expect(value.warnings.some((w) => w.kind === 'degraded' && w.detail.includes('可读下限'))).toBe(true);
      // 绝对口径保持：≈1 颗而非满铺 ~9 颗（旧口径 d=1 基准晶格的特征值）
      expect(withinGate(value.gemCount, expected)).toBe(true);
      expect(value.gemCount).toBeLessThan(3);
    } finally {
      f.dispose();
    }
  });

  it('2.3→4.6 单调近倍增——无满铺断点', () => {
    const { tree, handBits } = handTree();
    const f = setup(tree);
    try {
      const run = (density: number): number =>
        (executeStrategyPlan(
          { db: f.s.db, blobs: f.s.blobs },
          { taskId: f.taskId, plan: planOf(f, { nodeId: 'n-hand', strategyKind: 'texture-fill', params: { mode: 'scatter' }, densityPerCm2: density }), engineLayout: strategyEngineDelegate },
        ).value as { gemCount: number }).gemCount;
      const expectedLow = 2.3 * maskAreaCm2(handBits);
      const expectedHigh = 4.6 * maskAreaCm2(handBits);
      const low = run(2.3);
      const high = run(4.6);
      expect(withinGate(low, expectedLow)).toBe(true);
      expect(withinGate(high, expectedHigh)).toBe(true);
      expect(high).toBeGreaterThan(low); // 单调
      expect(high / low).toBeGreaterThan(1.4); // 近倍增
      expect(high).toBeLessThan(40); // 无满铺断点（2mm 满铺 ≈118 颗）
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4][5] 诊断字段+prompt

describe('密度诊断面与 prompt 契约', () => {
  it('产物保留用户口径+诊断三元组（nodeSummaries.density / gems 工件 nodeDensities）', () => {
    const { tree, handBits } = handTree();
    const f = setup(tree);
    try {
      const out = executeStrategyPlan(
        { db: f.s.db, blobs: f.s.blobs },
        { taskId: f.taskId, plan: planOf(f, { nodeId: 'n-hand', strategyKind: 'texture-fill', params: { mode: 'scatter' }, densityPerCm2: 2.3 }), engineLayout: strategyEngineDelegate },
      );
      const value = out.value as {
        nodeSummaries: Array<{ nodeId: string; density?: { densityPerCm2: number; densityRatio: number; baseDensityPerCm2: number } }>;
      };
      const density = value.nodeSummaries.find((s) => s.nodeId === 'n-hand')!.density;
      expect(density).toMatchObject({ densityPerCm2: 2.3 });
      expect(density!.baseDensityPerCm2).toBeCloseTo(2 / (SQRT3 * 0.24 * 0.24), 4);
      expect(density!.densityRatio).toBeCloseTo(2.3 / (2 / (SQRT3 * 0.24 * 0.24)), 4);
      // gems 工件诊断面（读回 strategy-gems.json）
      const gemsRef = (out.value as { gemsBlobRef: string }).gemsBlobRef;
      const gemsDoc = JSON.parse(f.s.blobs.read(globsRefOf(gemsRef))!.toString('utf8')) as {
        nodeDensities?: Array<{ nodeId: string; densityPerCm2: number; densityRatio: number; baseDensityPerCm2: number }>;
      };
      expect(gemsDoc.nodeDensities).toBeDefined();
      expect(gemsDoc.nodeDensities![0]).toMatchObject({ nodeId: 'n-hand', densityPerCm2: 2.3 });
    } finally {
      f.dispose();
    }
    function globsRefOf(ref: string): string {
      return ref; // blobs.read(blobRef) 直读（别名仅为可读性）
    }
  });

  it('prompt：旧「2.3=满铺基线上限」注释已删；绝对颗数密度语义在场', () => {
    const prompt = buildStrategyDesignPrompt({
      tree: handTree().tree,
      candidates: [
        { idx: 1, pick: { resourceId: 'r'.repeat(24) + '0'.repeat(16), sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#F0F0E8' }, family: '白色系' },
      ],
    });
    expect(prompt).not.toContain('满铺基线上限');
    expect(prompt).toContain('绝对颗数密度');
    expect(prompt).toContain('基准容量');
  });
});

// ---------------------------------------------------------------- [6] 真链走查 P1 修正回归（2026-10-01 小丑图）

/**
 * 走查对照表（会话 1187ce52）修复前后颗数对照——画布 20cm、声明密度 2.3 颗/cm²：
 *   左手   掩膜实积≈3.6cm²  应≈8.3   修复前 71（+426%，旧 24 下限降级 hex 满基准）→ 修复后 ≈8（保形 texture-fill）
 *   帽顶绒球 ≈2.5cm²       应≈5.8   修复前 36（同上）→ 修复后 ≈6（保形）
 *   上衣   ≈28cm²          应≈64.7  修复前 34（−47%，走查 daemon 旧口径/LLM 逐节点低密度覆盖）→ 修复后 ≈65（±20% 门）
 * 兜底：极小部位（<3 颗）仍降级 hex 形态（目标密度不变——上方案例）。
 */

/** 实心矩形部位树（走查场景参数化——n-region 为唯一产块叶子）。 */
function solidRegionTree(region: { w: number; h: number; x: number; y: number }): ObjectTree {
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 20, h: 20 },
    imagePx: { width: 736, height: 736 },
    nodes: [
      {
        id: 'n-canvas',
        objectName: '画布',
        category: 'canvas',
        mask: solidMask(736, 736),
        bbox: { x: 0, y: 0, w: 736, h: 736 },
        parent: null,
        children: ['n-region'],
        effectiveMm: 200,
        labVariance: 40,
        drillWorthy: false,
        origin: 'vlm+sam3',
      },
      {
        id: 'n-region',
        objectName: '走查部位',
        category: 'body',
        mask: solidMask(region.w, region.h),
        bbox: { x: region.x, y: region.y, w: region.w, h: region.h },
        parent: 'n-canvas',
        children: [],
        effectiveMm: Math.sqrt(region.w * region.h) / PPM,
        labVariance: 9,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

/** 走查部位执行（texture-fill scatter 缺省路径——真链缺省指派）→ {颗数, 降级?}。 */
function runWalkthroughRegion(region: { w: number; h: number; x: number; y: number }): {
  gemCount: number;
  delegated: boolean;
  expected: number;
} {
  const f = setup(solidRegionTree(region));
  try {
    const out = executeStrategyPlan(
      { db: f.s.db, blobs: f.s.blobs },
      {
        taskId: f.taskId,
        plan: planOf(f, { nodeId: 'n-region', strategyKind: 'texture-fill', params: { mode: 'scatter' }, densityPerCm2: 2.3 }),
        engineLayout: strategyEngineDelegate,
      },
    );
    const value = out.value as {
      gemCount: number;
      nodeSummaries: Array<{ nodeId: string; engineDelegation?: unknown }>;
    };
    return {
      gemCount: value.gemCount,
      delegated: value.nodeSummaries.find((s) => s.nodeId === 'n-region')!.engineDelegation !== undefined,
      expected: 2.3 * ((region.w * region.h) / (PPM * PPM) / 100),
    };
  } finally {
    f.dispose();
  }
}

describe('真链走查 P1：声明密度优先——小/大部位颗数=面积×密度（±20%）', () => {
  it('左手（70×70px≈3.62cm²）：应≈8.3 颗，修复前 71——保形不降级', () => {
    const r = runWalkthroughRegion({ w: 70, h: 70, x: 170, y: 380 });
    expect(r.expected).toBeGreaterThan(7.5);
    expect(r.expected).toBeLessThan(9);
    expect(r.delegated).toBe(false); // 旧 24 下限：8<24 强制降级 hex 满基准（71 颗）
    expect(withinGate(r.gemCount, r.expected)).toBe(true);
    expect(r.gemCount).toBeLessThan(14); // 71 颗特征防回归
  });

  it('帽顶绒球（58×58px≈2.49cm²）：应≈5.7 颗，修复前 36——保形不降级', () => {
    const r = runWalkthroughRegion({ w: 58, h: 58, x: 300, y: 60 });
    expect(r.expected).toBeGreaterThan(5);
    expect(r.expected).toBeLessThan(6.5);
    expect(r.delegated).toBe(false);
    expect(withinGate(r.gemCount, r.expected)).toBe(true);
    expect(r.gemCount).toBeLessThan(10); // 36 颗特征防回归
  });

  it('上衣（195×195px≈28.08cm²）：应≈64.6 颗，修复前 34（−47%）——大部位不欠密', () => {
    const r = runWalkthroughRegion({ w: 195, h: 195, x: 120, y: 200 });
    expect(r.expected).toBeGreaterThan(63);
    expect(r.expected).toBeLessThan(66);
    expect(withinGate(r.gemCount, r.expected)).toBe(true); // ±20%（含 stipple 六方胞元校正后 ≈1.0×目标）
    expect(r.gemCount).toBeGreaterThan(51); // 34 颗（−47%）欠密特征防回归
  });
});
