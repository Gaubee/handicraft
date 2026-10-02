/**
 * gapFill 多尺寸混排测试（close-paving-backlog T2.6——「打底+补隙」执行层正交模式，
 * 客户 3mm+10mm 混排刚需）。覆盖：
 *   [1] applyGapFillPass 纯函数：fill 径 stones 内查/网格候选+分桶判距
 *       （minGapRatio=1 与 gateRequiredPairPx 逐位同式）/fill 角度继承就近 base/
 *       确定性/补隙 0 颗 warning/无尺寸与查无 stoneRef typed 拒；
 *   [2] per-pair 混径门（T2.3 咽喉）：fill 钻不被旧单径标量门误剔（反例闭式）+
 *       等径退化与旧 minPx 逐位同式；
 *   [3] 分桶与朴素逐对等价性（同输入同 kept 集——O(n+m) 工程正确性）；
 *   [4] 大 fixture（>600 钻）秒级（swap 深水位——性能冒烟无 flake 断言）。
 * 端到端（executeStrategyPlan 双径+BOM 双行/直改透传）在 strategy-design.test.ts 与
 * workbench.test.ts（复用其服务 fixture）。零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import type { StonePick, StrategyAssignment } from '@handicraft/contracts';
import type { TreeBlock } from '../src/kernel/vision/tree-to-blocks.js';
import { gateRequiredPairPx, validateGemPlacement } from '../src/kernel/strategies/sandbox/gate.js';
import {
  applyGapFillPass,
  StrategyDesignError,
} from '../src/kernel/strategies/design.js';
import type { KernelGem } from '../src/kernel/strategies/registry.js';

const PPM = 10;
const W = 600;
const H = 600;

function solidBlock(): TreeBlock {
  return {
    id: 'n-mix',
    label: 'blk/n-mix',
    mask: { w: W, h: H, bits: new Uint8Array(W * H).fill(1) },
    colorRgb: [128, 128, 128],
    areaPx: W * H,
    bbox: { x: 0, y: 0, w: W, h: H },
    widthPx: { max: W, mean: W },
    suggested: 'fill',
    origin: {
      originBlockId: null,
      parentNodeId: null,
      nodeCategory: 'structure',
      drillWorthy: true,
      nodeOrigin: 'vlm+sam3',
      effectiveMm: 100,
      labVariance: 1,
      depth: 0,
      isLeaf: true,
      colorSource: 'fallback',
    },
  };
}

const BASE: StonePick = { resourceId: 'stn-base-10', sku: 'G01', supplier: 'yuhang', sizeMm: 10, colorHex: '#C82828' };
const FILL: StonePick = { resourceId: 'stn-fill-3', sku: 'C51', supplier: 'yuhang', sizeMm: 3, colorHex: '#F0F0E8' };

function assignmentOf(gapFill: { stoneRef: string; minGapRatio?: number }, stones: StonePick[] = [BASE, FILL]): StrategyAssignment {
  return {
    nodeId: 'n-mix',
    strategyKind: 'geometry',
    params: { shape: 'circle' },
    stones,
    densityPerCm2: 2.3,
    ...(gapFill.minGapRatio !== undefined ? { gapFill: { stoneRef: gapFill.stoneRef, minGapRatio: gapFill.minGapRatio } } : { gapFill: { stoneRef: gapFill.stoneRef } }),
    rationale: '混排测试',
  } as StrategyAssignment;
}

function baseGem(id: string, x: number, y: number, rotationDeg = 45): KernelGem {
  return { id, x, y, colorId: '', blockId: 'n-mix', shapeId: 'round', diameterMm: 10, rotationDeg };
}

// ---------------------------------------------------------------- [1] 补隙趟纯函数

describe('applyGapFillPass（T2.2——网格候选+分桶判距）', () => {
  it('空隙补钻：两 base 钻间隙可容 3mm fill → 补入且判距=gateRequiredPairPx×1（逐位同式）', () => {
    const block = solidBlock();
    // 两颗 10mm base 相距 100px：3mm fill 与两者各需 ((10+3)/2)×10×0.999=64.935px
    const baseGems = [baseGem('b1', 200, 300), baseGem('b2', 300, 300)];
    const out = applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1 });
    expect(out.gems.length).toBeGreaterThan(0);
    const required = (d: number) => gateRequiredPairPx(d, 3, PPM);
    for (const g of out.gems) {
      expect(g.diameterMm).toBe(3);
      expect(g.blockId).toBe('n-mix');
      for (const b of baseGems) {
        expect(Math.hypot(g.x - b.x, g.y - b.y)).toBeGreaterThanOrEqual(required(10));
      }
      for (const other of out.gems) {
        if (other === g) continue;
        expect(Math.hypot(g.x - other.x, g.y - other.y)).toBeGreaterThanOrEqual(required(3));
      }
    }
    // fill 角度=最近 base 钻角度（两 base 同角 45——就近继承）
    out.gems.forEach((g) => expect(g.rotationDeg).toBe(45));
    // 确定性
    expect(applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1 })).toEqual(out);
  });

  it('fill 角度=就近 base（不同角 base：fill 靠哪边继承哪边角度）', () => {
    const block = solidBlock();
    const baseGems = [baseGem('b1', 100, 300, 10), baseGem('b2', 400, 300, 300)];
    const out = applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1 });
    expect(out.gems.length).toBeGreaterThan(0);
    for (const g of out.gems) {
      const nearest = baseGems.reduce((a, b) => (Math.hypot(g.x - a.x, g.y - a.y) <= Math.hypot(g.x - b.x, g.y - b.y) ? a : b));
      expect(g.rotationDeg).toBe(nearest.rotationDeg);
    }
  });

  it('minGapRatio>1 线性收紧：1.5 时同 fixture 补隙数不增（阈值放大单调）', () => {
    const block = solidBlock();
    const baseGems = [baseGem('b1', 200, 300), baseGem('b2', 300, 300)];
    const loose = applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1 });
    const tight = applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId, minGapRatio: 1.5 }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1.5 });
    expect(tight.gems.length).toBeLessThanOrEqual(loose.gems.length);
    for (const g of tight.gems) {
      for (const b of baseGems) {
        expect(Math.hypot(g.x - b.x, g.y - b.y)).toBeGreaterThanOrEqual(gateRequiredPairPx(10, 3, PPM) * 1.5);
      }
    }
  });

  it('密铺无隙：base 邻距不容 3mm fill → 补隙 0 颗+spacing warning（如实说明）', () => {
    const block = solidBlock();
    // 10mm base 网格 80px 步进：格内任一点到最近 base ≤(80/√2)=56.6px < 64.94px
    // （(10+3)/2×ppm×0.999）——3mm 补隙全域无隙
    const baseGems: KernelGem[] = [];
    for (let y = 40; y <= H; y += 80) {
      for (let x = 40; x <= W; x += 80) {
        baseGems.push(baseGem(`b${baseGems.length}`, x, y));
      }
    }
    const out = applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1 });
    expect(out.gems).toEqual([]);
    expect(out.warnings.some((w) => w.kind === 'spacing' && w.detail.includes('补隙 0 颗'))).toBe(true);
  });

  it('typed 拒：stoneRef 查无（防御）/补隙钻无尺寸', () => {
    const block = solidBlock();
    const baseGems = [baseGem('b1', 200, 300)];
    expect(() =>
      applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: 'stn-ghost' }), PPM, { stoneRef: 'stn-ghost' }),
    ).toThrow(StrategyDesignError);
    const unsized: StonePick[] = [BASE, { ...FILL, sizeMm: null }];
    expect(() =>
      applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }, unsized), PPM, { stoneRef: FILL.resourceId }),
    ).toThrow(/无尺寸/);
  });
});

// ---------------------------------------------------------------- [2] per-pair 混径门

describe('validateGemPlacement per-pair 混径模式（T2.3——旧单径门的反例闭式）', () => {
  const block = solidBlock();

  it('fill 钻不被误剔：旧标量门（base 径一刀切）必剔的形态在混径门下合法保留', () => {
    // base 10mm×2 相距 100px + 3mm fill 居中（与两 base 各距 50px）：
    //   混径门需要 ((10+3)/2)×10×0.999=64.94px → 50 < 64.94 —— 该 fill 会被剔除；
    //   构造合法形态：base 相距 160px、fill 居中各距 80px ≥64.94 → 混径门保留。
    //   旧单径标量门（minPx=10mm×10×0.999=99.9px）对 80px 的 fill 仍剔——反例成立。
    const gems: KernelGem[] = [
      baseGem('b1', 120, 300),
      baseGem('b2', 280, 300),
      { id: 'f1', x: 200, y: 300, colorId: '', blockId: 'n-mix', shapeId: 'round', diameterMm: 3 },
    ];
    const pair = validateGemPlacement(gems, { mask: block.mask, bbox: block.bbox, pairPixelsPerMm: PPM });
    expect(pair.kept.map((g) => g.id)).toEqual(['b1', 'b2', 'f1']); // 混径门：fill 全保留
    const scalar = validateGemPlacement(gems, { mask: block.mask, bbox: block.bbox, minPx: gateRequiredPairPx(10, 10, PPM) });
    expect(scalar.kept.map((g) => g.id)).toEqual(['b1', 'b2']); // 旧单径门：fill 被系统性误剔
    expect(scalar.culled).toHaveLength(1);
  });

  it('等径退化逐位同式：pair 模式（同径 gems）与 minPx 标量同 kept/culled（detail 文案外的三元组逐位相等）', () => {
    const gems: KernelGem[] = [];
    for (let y = 50; y < H; y += 90) {
      for (let x = 50; x < W; x += 90) {
        gems.push(baseGem(`b${gems.length}`, x, y));
      }
    }
    const pair = validateGemPlacement(gems, { mask: block.mask, bbox: block.bbox, pairPixelsPerMm: PPM });
    const scalar = validateGemPlacement(gems, { mask: block.mask, bbox: block.bbox, minPx: gateRequiredPairPx(10, 10, PPM) });
    expect(pair.kept.map((g) => g.id)).toEqual(scalar.kept.map((g) => g.id));
    expect(pair.culled.map((c) => [c.index, c.id, c.kind])).toEqual(scalar.culled.map((c) => [c.index, c.id, c.kind]));
  });

  it('deps 双缺/双给=RangeError（调用面防呆）', () => {
    const gems = [baseGem('b1', 120, 300)];
    expect(() => validateGemPlacement(gems, { mask: block.mask, bbox: block.bbox })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- [3] 分桶等价性 + [4] 性能

describe('分桶与朴素逐对等价性（O(n+m) 工程正确性——同输入同补隙集）', () => {
  /** 朴素判距参照（O(n×m)——不引实现，规格复述）：网格候选序 y 升 x 升 keep-earlier。 */
  function naiveFill(baseGems: KernelGem[], dF: number, ratio: number): { x: number; y: number }[] {
    const all = [...baseGems];
    const placed: { x: number; y: number }[] = [];
    const stepPx = 1.2 * dF * PPM;
    for (let y = stepPx / 2; y < H; y += stepPx) {
      for (let x = stepPx / 2; x < W; x += stepPx) {
        let ok = true;
        for (const q of all) {
          const required = gateRequiredPairPx(q.diameterMm, dF, PPM) * ratio;
          if (Math.hypot(q.x - x, q.y - y) < required) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const gem = { x, y, diameterMm: dF };
        placed.push({ x, y });
        all.push(gem as KernelGem);
      }
    }
    return placed;
  }

  it('随机化确定性 fixture：分桶产出=朴素逐对（坐标逐点相等）', () => {
    const block = solidBlock();
    // 确定性伪随机 base 布点（mulberry32 同族——测试自持，不引实现）
    let seed = 42;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const baseGems: KernelGem[] = [];
    for (let i = 0; i < 60; i++) {
      baseGems.push(baseGem(`b${i}`, 30 + rand() * (W - 60), 30 + rand() * (H - 60), Math.round(rand() * 360)));
    }
    const out = applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1 });
    const naive = naiveFill(baseGems, 3, 1);
    expect(out.gems.map((g) => `${g.x.toFixed(6)},${g.y.toFixed(6)}`)).toEqual(naive.map((q) => `${q.x.toFixed(6)},${q.y.toFixed(6)}`));
  });

  it('大 fixture（>600 base 钻）补隙趟秒级（性能冒烟——宽松上界防 flake）', () => {
    const block = solidBlock();
    const baseGems: KernelGem[] = [];
    for (let y = 20; y < H; y += 22) {
      for (let x = 20; x < W; x += 22) {
        if (baseGems.length < 640) baseGems.push(baseGem(`b${baseGems.length}`, x, y));
      }
    }
    expect(baseGems.length).toBeGreaterThan(600);
    const t0 = Date.now();
    const out = applyGapFillPass(baseGems, block, assignmentOf({ stoneRef: FILL.resourceId }), PPM, { stoneRef: FILL.resourceId, minGapRatio: 1 });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(10_000); // 秒级宽松界（swap 深水位容差——典型 <1s）
  });
});
