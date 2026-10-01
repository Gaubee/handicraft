/**
 * 闸门-引擎一致性测试（P0 修复批 2026-10-01 真链走查——导出闸门口径统一）。
 *
 * 把守的不变量（daemon 侧判距与 engine exportGate **同一换算**——单源
 * sandbox/gate.ts：EXPORT_GATE_GRID_GAP_MM + gateRequiredPairPx）：
 *   [1] 公式同源：gateRequiredPairPx(a,b,ppm) === 引擎 requiredCenterDistancePx×0.999
 *       （grid=gridFromSpec(spec, EXPORT_GATE_GRID_GAP_MM, ppm)——task-layout 写盘的
 *       grid 即此构造）——直接对引擎函数断言，非抄录自证。
 *   [2] 阈值行为：恰好达 daemon 门阈值的钻对，过引擎 exportGate spacing 零违规；
 *       略低于阈值即违规（门松紧方向不漂）。
 *   [3] 跨节点剔除：validateCrossNodeGemSpacing keep-earlier（混径按 (a+b)/2 判）。
 *   [4] 执行链端到端（**目标：引擎自己排出来的布局不被自己的闸门拒**）：
 *       executeStrategyPlan（引擎委派 hex + 内核 texture-fill + 自由代码跨节点重叠
 *       三形态混排）产出的 task-layout，其 gems 过 engine exportGate spacing 面
 *       零违规，且 layout.grid.gapMm === EXPORT_GATE_GRID_GAP_MM（接线单源断言）。
 *   [5] propose 前置校验（P0-2）：多候选物料节点在**计划装配时**即 typed 拒
 *       （plan-stone-multi-candidate——错误消息即自纠指引），prompt 教单值示例。
 */
import { describe, expect, it } from 'vitest';
import {
  encodeInlineMask,
  StrategyPlanSchema,
  TaskLayoutSchema,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts';
import {
  exportGate,
  gridFromSpec,
  requiredCenterDistancePx,
  type GateGem,
  type GridSpec,
} from 'rhinestone-studio/engine';
import { createAgentTask } from '../src/db/jobs.js';
import { insertSessionProject } from '../src/db/sessions.js';
import { strategyEngineDelegate } from '../src/kernel/index.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import {
  assembleStrategyPlan,
  buildStrategyDesignPrompt,
  executeStrategyPlan,
} from '../src/kernel/strategies/design.js';
import {
  EXPORT_GATE_GRID_GAP_MM,
  gateRequiredPairPx,
  validateCrossNodeGemSpacing,
} from '../src/kernel/strategies/sandbox/gate.js';
import type { KernelGem } from '../src/kernel/strategies/registry.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- [1] 公式同源

describe('闸门-引擎同一换算（单源 EXPORT_GATE_GRID_GAP_MM）', () => {
  it('gateRequiredPairPx === 引擎 requiredCenterDistancePx×0.999（gridFromSpec 同 gap 构造）', () => {
    for (const [a, b, ppm] of [
      [3, 3, 10],
      [2, 3, 8.5],
      [7.1, 5.3, 12.25],
      [0.8, 0.8, 40],
    ] as const) {
      const grid = gridFromSpec({ shapeId: 'round', sizeLabel: `${a}mm`, diameterMm: a }, EXPORT_GATE_GRID_GAP_MM, ppm);
      const engineValue = requiredCenterDistancePx({ diameterMm: a }, { diameterMm: b }, grid) * 0.999;
      expect(gateRequiredPairPx(a, b, ppm)).toBe(engineValue);
    }
  });

  it('等径退化与既有 daemon 门语义逐位一致（gap=0 时 (d+d)/2×ppm×0.999 === d×ppm×0.999）', () => {
    const d = 3;
    const ppm = 10;
    expect(gateRequiredPairPx(d, d, ppm)).toBe(d * ppm * 0.999);
  });

  it('EXPORT_GATE_GRID_GAP_MM=0（钻径切距判据——拾取间隙是排布面参数不进判距）', () => {
    expect(EXPORT_GATE_GRID_GAP_MM).toBe(0);
  });
});

// ---------------------------------------------------------------- [2] 阈值行为

/** task-export engineGridOf 同构（layout.grid → engine GridSpec）。 */
function engineGridOfLayout(layout: { grid: { baseSpec: { diameterMm: number }; gapMm: number; pixelsPerMm: number } }): GridSpec {
  return {
    pitchMm: layout.grid.baseSpec.diameterMm + layout.grid.gapMm,
    gapMm: layout.grid.gapMm,
    rowAngleDeg: 0,
    pixelsPerMm: layout.grid.pixelsPerMm,
  };
}

function gateGem(id: string, x: number, y: number, diameterMm: number): GateGem {
  return { id, x, y, blockId: null, shapeId: 'round', diameterMm };
}

describe('引擎 exportGate 按 task-layout grid 判距（阈值行为不漂）', () => {
  const d = 3;
  const ppm = 10;
  const grid = gridFromSpec({ shapeId: 'round', sizeLabel: `${d}mm`, diameterMm: d }, EXPORT_GATE_GRID_GAP_MM, ppm);

  it('恰好达 daemon 门阈值的钻对 → spacing 零违规', () => {
    const threshold = gateRequiredPairPx(d, d, ppm);
    const gems = [gateGem('g1', 0, 0, d), gateGem('g2', threshold + 1e-6, 0, d)];
    const verdict = exportGate(gems, { grid });
    expect(verdict.ok).toBe(true);
    expect(verdict.violations.filter((v) => v.kind === 'spacing')).toHaveLength(0);
  });

  it('低于阈值（0.98×）→ spacing 违规（门不松弛）', () => {
    const threshold = gateRequiredPairPx(d, d, ppm);
    const gems = [gateGem('g1', 0, 0, d), gateGem('g2', threshold * 0.98, 0, d)];
    const verdict = exportGate(gems, { grid });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'spacing' && v.gemIds.includes('g2'))).toBe(true);
  });
});

// ---------------------------------------------------------------- [3] 跨节点剔除

function kgem(id: string, blockId: string, x: number, y: number, diameterMm: number): KernelGem {
  return { id, x, y, colorId: '', blockId: blockId as KernelGem['blockId'], shapeId: 'round', diameterMm };
}

describe('validateCrossNodeGemSpacing（跨节点重叠剔除——keep-earlier+混径 (a+b)/2 判）', () => {
  const ppm = 10;
  it('两节点重叠对：后节点颗被剔（keep-earlier）+detail 携两节点', () => {
    const gems = [kgem('a1', 'nA', 10, 10, 3), kgem('b1', 'nB', 10 + 15, 10, 3)]; // 15px < 30×0.999
    const verdict = validateCrossNodeGemSpacing(gems, ppm);
    expect(verdict.kept.map((g) => g.id)).toEqual(['a1']);
    expect(verdict.culled).toHaveLength(1);
    expect(verdict.culled[0]!.detail).toContain('nB');
    expect(verdict.culled[0]!.detail).toContain('nA');
  });
  it('混径对按 (a+b)/2 判：2mm+6mm 对所需 40×0.999——恰好达标保留', () => {
    const need = gateRequiredPairPx(2, 6, ppm);
    const gems = [kgem('a1', 'nA', 0, 0, 2), kgem('b1', 'nB', need + 1e-6, 0, 6)];
    const verdict = validateCrossNodeGemSpacing(gems, ppm);
    expect(verdict.kept.map((g) => g.id)).toEqual(['a1', 'b1']);
  });
  it('同节点近距不在本门职责（P1.4 门负责）——跨节点远对全保留', () => {
    const gems = [kgem('a1', 'nA', 0, 0, 3), kgem('a2', 'nA', 10, 0, 3), kgem('b1', 'nB', 100, 100, 3)];
    const verdict = validateCrossNodeGemSpacing(gems, ppm);
    expect(verdict.culled).toHaveLength(0);
    expect(verdict.kept).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- [4] 执行链端到端

/** 实心矩形 mask。 */
function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

/**
 * 测试树（canvasCm 2×1.6 / imagePx 200×160 → ppm=10——3mm 钻=30px）：
 * n0 根（层级）├ e1 引擎委派节点（叶 60×160）├ t1 纹理节点（叶 60×160）
 *            ├ f1 自由代码节点（叶 40×160）└ f2 自由代码节点（叶 40×160——与 f1 坐标域交叠）。
 */
function testTree(): ObjectTree {
  const leaf = (id: string, name: string, x: number, w: number) => ({
    id,
    objectName: name,
    category: 'foliage',
    mask: solidMask(w, 160),
    bbox: { x, y: 0, w, h: 160 },
    parent: 'n0',
    children: [],
    effectiveMm: 60,
    labVariance: 10,
    drillWorthy: true,
    origin: 'vlm+sam3' as const,
  });
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 2, h: 1.6 },
    imagePx: { width: 200, height: 160 },
    nodes: [
      {
        id: 'n0',
        objectName: '测试主体',
        category: 'foliage',
        mask: solidMask(200, 160),
        bbox: { x: 0, y: 0, w: 200, h: 160 },
        parent: null,
        children: ['e1', 't1', 'f1', 'f2'],
        effectiveMm: 160,
        labVariance: 10,
        drillWorthy: false,
        origin: 'vlm+sam3' as const,
      },
      leaf('e1', '引擎区', 0, 60),
      leaf('t1', '纹理区', 60, 60),
      leaf('f1', '自由A', 120, 40),
      leaf('f2', '自由B', 120, 40), // 与 f1 同 bbox（坐标域交叠——制造确定性跨节点重叠）
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

const FREE_CODE_F1 = 'function layout(sandbox) { return [{x:130,y:20},{x:150,y:20},{x:130,y:60},{x:150,y:60}]; }';
// f2 的首颗与 f1 的 {x:130,y:20} 距 12px < 3mm×10ppm×0.999=29.97px（确定性跨节点重叠）；
// 其余颗与 f1 及本节点均 ≥ 30px（节点内 P1.4 门零剔除——隔离跨节点面）。
const FREE_CODE_F2 = 'function layout(sandbox) { return [{x:142,y:20},{x:130,y:140},{x:152,y:112}]; }';

describe('executeStrategyPlan → 导出门 spacing 零违规（引擎自己排的布局不被自己的闸门拒）', () => {
  it('引擎委派+内核纹理+自由代码跨节点重叠三形态混排：task-layout gems 过 exportGate spacing 面全绿', () => {
    const s: TestServices = createServices(undefined, { imgDryRun: true });
    try {
      const { sessionId } = s.sessions.create(s.anonymous, { title: '闸门一致性' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      // session-project 行（task-layout 的 manifestRevision 锚——最小面直插，不经
      // writeManifest 的钻服务校验：layout 装配只消费 revision，不回读 manifest blob）。
      insertSessionProject(s.db, {
        session_id: sessionId,
        revision: 1,
        blob_ref: s.blobs.put(new Uint8Array(Buffer.from('{"kind":"stones-manifest","entries":[]}', 'utf8'))).hash,
        updated_by_task_id: task.id,
        updated_at: new Date().toISOString(),
      });
      const tree = testTree();
      const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
      const stone = {
        resourceId: 'st-3mm',
        sku: 'A52',
        supplier: 'yuhang',
        sizeMm: 3,
        colorHex: '#C82828',
      };
      const plan: StrategyPlan = StrategyPlanSchema.parse({
        kind: 'strategy-plan',
        formatVersion: 1,
        objectTreeRef: persisted.treeBlobRef,
        assignments: [
          {
            nodeId: 'e1',
            strategyKind: 'texture-fill',
            params: { mode: 'scatter', polarity: 'flat' },
            engineStrategy: 'hex-pitch', // 引擎委派（pitch=d+0.4 排布——引擎自己的布局）
            stones: [stone],
            densityPerCm2: 2.3,
            rationale: '引擎晶格区',
          },
          {
            nodeId: 't1',
            strategyKind: 'texture-fill',
            params: { mode: 'scatter', polarity: 'flat' },
            stones: [stone],
            densityPerCm2: 2.3,
            rationale: '内核纹理区',
          },
          {
            nodeId: 'f1',
            strategyKind: 'free-code',
            params: { source: FREE_CODE_F1, seed: 1 },
            codeArtifactRef: 'a'.repeat(64),
            stones: [stone],
            densityPerCm2: 2.3,
            rationale: '自由代码 A',
          },
          {
            nodeId: 'f2',
            strategyKind: 'free-code',
            params: { source: FREE_CODE_F2, seed: 1 },
            codeArtifactRef: 'b'.repeat(64),
            stones: [stone],
            densityPerCm2: 2.3,
            rationale: '自由代码 B（与 A 交叠）',
          },
        ],
        createdAt: '2026-10-01T00:00:00.000Z',
      });
      const out = executeStrategyPlan(
        { db: s.db, blobs: s.blobs },
        { taskId: task.id, plan, engineLayout: strategyEngineDelegate },
      );
      const value = out.value as {
        gemCount: number;
        warnings: Array<{ kind: string; detail: string }>;
        taskLayoutBlobRef: string | null;
      };
      expect(value.gemCount).toBeGreaterThan(0);

      // —— 跨节点剔除生效（f2 与 f1 的重叠颗被剔+warning 明示）。
      expect(value.warnings.some((w) => w.kind === 'spacing' && w.detail.includes('跨节点重叠剔除'))).toBe(true);

      // —— task-layout 接线单源：grid.gapMm === EXPORT_GATE_GRID_GAP_MM。
      expect(value.taskLayoutBlobRef).toBeTruthy();
      const layout = TaskLayoutSchema.parse(
        JSON.parse(s.blobs.read(value.taskLayoutBlobRef!)!.toString('utf8')),
      );
      expect(layout.grid.gapMm).toBe(EXPORT_GATE_GRID_GAP_MM);

      // —— 目标不变量：layout gems 过 engine exportGate spacing 面零违规
      //    （mask 面走导出链 treeRef 重建，此处聚焦 spacing——口径把守对象）。
      const gems = layout.gems.map((gem) => ({
        id: gem.id,
        x: gem.x,
        y: gem.y,
        blockId: gem.blockId,
        shapeId: gem.shapeId,
        diameterMm: gem.diameterMm,
      }));
      const verdict = exportGate(gems, { grid: engineGridOfLayout(layout) });
      const spacingViolations = verdict.violations.filter((v) => v.kind === 'spacing');
      expect(spacingViolations).toEqual([]);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] propose 前置校验

describe('多候选物料节点 propose 前置校验（P0-2——执行末端拒产前移）', () => {
  function capturePlanError(s: TestServices, stoneIdx: number[]): { kind: string; message: string } {
    const { sessionId } = s.sessions.create(s.anonymous, { title: '前置校验' });
    const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
    const tree = testTree();
    const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
    const pick = (sku: string) => ({
      resourceId: `st-${sku}`,
      sku,
      supplier: 'yuhang',
      sizeMm: 3,
      colorHex: '#C82828',
    });
    try {
      assembleStrategyPlan({
        tree,
        treeArtifactRef: persisted.treeBlobRef,
        llmPayload: {
          assignments: [
            { nodeId: 'e1', strategyKind: 'texture-fill', params: { mode: 'scatter', polarity: 'flat' }, stoneIdx, rationale: '指派' },
            { nodeId: 't1', strategyKind: 'exclusion', params: {}, rationale: 'r' },
            { nodeId: 'f1', strategyKind: 'exclusion', params: {}, rationale: 'r' },
            { nodeId: 'f2', strategyKind: 'exclusion', params: {}, rationale: 'r' },
          ],
        },
        candidates: [
          { idx: 1, pick: pick('A52'), family: '红色系' },
          { idx: 2, pick: pick('B52'), family: '红色系' },
        ],
        blobs: s.blobs,
      });
    } catch (error) {
      const e = error as { kind?: string; message: string };
      expect(e).toBeInstanceOf(Error);
      return { kind: e.kind ?? '', message: e.message };
    }
    throw new Error('多候选指派未被拒绝（assembleStrategyPlan 应 typed 拒）');
  }

  it('stones>1 → plan-stone-multi-candidate typed 拒+消息即自纠指引（stoneIdx 单值）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { kind, message } = capturePlanError(s, [1, 2]);
      expect(kind).toBe('plan-stone-multi-candidate');
      expect(message).toContain('恰指派一款钻');
      expect(message).toContain('stoneIdx 单值');
      expect(message).toContain('colorId');
    } finally {
      s.dispose();
    }
  });

  it('exclusion 多候选不在本门职责（无钻族照旧）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      expect(() => {
        const { sessionId } = s.sessions.create(s.anonymous, { title: 'exclusion 面' });
        const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
        const tree = testTree();
        const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
        assembleStrategyPlan({
          tree,
          treeArtifactRef: persisted.treeBlobRef,
          llmPayload: {
            assignments: [
              { nodeId: 'e1', strategyKind: 'texture-fill', params: { mode: 'scatter', polarity: 'flat' }, stoneIdx: [1], rationale: 'r' },
              { nodeId: 't1', strategyKind: 'exclusion', params: {}, stoneIdx: [1, 2], rationale: 'r' },
              { nodeId: 'f1', strategyKind: 'exclusion', params: {}, rationale: 'r' },
              { nodeId: 'f2', strategyKind: 'exclusion', params: {}, rationale: 'r' },
            ],
          },
          candidates: [
            { idx: 1, pick: { resourceId: 'st-A52', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }, family: '红色系' },
            { idx: 2, pick: { resourceId: 'st-B52', sku: 'B52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }, family: '红色系' },
          ],
          blobs: s.blobs,
        });
      }).not.toThrow();
    } finally {
      s.dispose();
    }
  });

  it('密度超容量 propose 前置拒（density-capacity-exceeded——消息即自纠指引）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { kind, message } = capturePlanErrorWithDensity(s, 99);
      expect(kind).toBe('density-capacity-exceeded');
      expect(message).toContain('降低密度');
    } finally {
      s.dispose();
    }
  });

  it('prompt：单值示例+恰一款规则+禁发明键（P0-4 提示词加固）', () => {
    const prompt = buildStrategyDesignPrompt({
      tree: testTree(),
      candidates: [
        { idx: 1, pick: { resourceId: 'st-A52', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }, family: '红色系' },
      ],
    });
    expect(prompt).toContain('"stoneIdx":[1]');
    expect(prompt).not.toContain('"stoneIdx":[1,3]');
    expect(prompt).toContain('每节点恰指派一款钻');
    expect(prompt).toContain('发明其余键');
    expect(prompt).toContain('rationale 必给');
    expect(prompt).toContain('必须为正数');
  });
});

/** 密度前置校验捕获（capturePlanError 的密度变体——3mm 钻容量≈9.99 颗/cm²）。 */
function capturePlanErrorWithDensity(s: TestServices, densityPerCm2: number): { kind: string; message: string } {
  const { sessionId } = s.sessions.create(s.anonymous, { title: '密度前置' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const tree = testTree();
  const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
  try {
    assembleStrategyPlan({
      tree,
      treeArtifactRef: persisted.treeBlobRef,
      llmPayload: {
        assignments: [
          {
            nodeId: 'e1',
            strategyKind: 'texture-fill',
            params: { mode: 'scatter', polarity: 'flat' },
            stoneIdx: [1],
            densityPerCm2,
            rationale: '超容量',
          },
          { nodeId: 't1', strategyKind: 'exclusion', params: {}, rationale: 'r' },
          { nodeId: 'f1', strategyKind: 'exclusion', params: {}, rationale: 'r' },
          { nodeId: 'f2', strategyKind: 'exclusion', params: {}, rationale: 'r' },
        ],
      },
      candidates: [
        { idx: 1, pick: { resourceId: 'st-A52', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }, family: '红色系' },
      ],
      blobs: s.blobs,
    });
  } catch (error) {
    const e = error as { kind?: string; message: string };
    expect(e).toBeInstanceOf(Error);
    return { kind: e.kind ?? '', message: e.message };
  }
  throw new Error('超容量密度未被拒绝（assembleStrategyPlan 应 typed 拒）');
}
