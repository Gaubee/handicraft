/**
 * 柔和曲线族测试（add-subject-sam-pipeline design §4.2/§8——P1.2）。
 * 真实 fixture：5836 花茎裁片（109×82 细弯条带群——Zhang-Suen 骨架分支；花茎物理细于
 * 2mm 钻，用 SS4 1.6mm 钻+2mm 点距）；合成 S 曲线带（已知弧长/中线——形状贴合断言）。
 * fixture 由 tests/fixtures/generate-p1-semantic.py 离线预生成（测试不跨仓读文件）。
 * 覆盖：参数 schema（缺省+strict 拒+界拒）+ 布点全在掩膜内+两两间距≥钻径+数量≈
 * 骨架总弧长/点距 ±35%（族公式——非密度×面积）+ S 曲线贴合（每钻到中线距离 ≤ 半带宽+
 * 钻径）+ 分支筛选单调（minBranchLengthMm ↑ → 产出 ≤）+ 点距缩放（点距 ×2 → 数量约
 * 减半）+ colorFamily 预留 warning+可读下限降级（实心圆盘骨架=中心点）+确定性。
 * 标度：PPM=3.68（原稿 native）；fixture 钻 1.6mm（SS4——花茎物理宽度约束）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock } from '../src/kernel/vision/tree-to-blocks.js';
import { SoftCurveParamsSchema, softCurveStrategy } from '../src/kernel/strategies/soft_curve.js';
import { applyStrategy, createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';

const PPM = 3.68;
const GEM = 5.888; // 1.6mm 钻（SS4）——花茎条带物理细于 2mm 钻

interface Fixture {
  family: string;
  w: number;
  h: number;
  maskB64: string;
  meta: { ppm: number };
}

function loadFx(name: string): Fixture {
  return JSON.parse(readFileSync(`tests/fixtures/p1-semantic/${name}.json`, 'utf8')) as Fixture;
}

function blockOf(w: number, h: number, bits: Uint8Array, id: string): TreeBlock {
  let areaPx = 0;
  for (const b of bits) if (b === 1) areaPx++;
  return {
    id,
    label: `blk/${id}`,
    mask: { w, h, bits },
    colorRgb: [128, 128, 128],
    areaPx,
    bbox: { x: 100, y: 100, w, h },
    widthPx: { max: Math.min(w, h), mean: Math.min(w, h) / 2 },
    suggested: 'linear',
    origin: {
      originBlockId: null,
      parentNodeId: null,
      nodeCategory: 'foliage',
      drillWorthy: true,
      nodeOrigin: 'vlm+sam3',
      effectiveMm: 10,
      labVariance: 1,
      depth: 0,
      isLeaf: true,
      colorSource: 'fallback',
    },
  };
}

function nodeOf(block: TreeBlock): ObjectNode {
  return ObjectNodeSchema.parse({
    id: block.id,
    objectName: 'fixture 节点',
    category: 'foliage',
    mask: encodeInlineMask(block.mask.w, block.mask.h, block.mask.bits),
    bbox: block.bbox,
    parent: null,
    children: [],
    effectiveMm: 10,
    labVariance: 1,
    drillWorthy: true,
    origin: 'vlm+sam3',
  });
}

const canvas = { px: { width: 736, height: 736 }, cm: { w: 20, h: 20 }, pixelsPerMm: PPM };
const ctx: StrategyContext = createStrategyContext({ gemDiameterPx: GEM, densityPerCm2: 9 });

function applyFx(fx: Fixture, id: string, params: unknown, context = ctx) {
  const block = blockOf(fx.w, fx.h, new Uint8Array(Buffer.from(fx.maskB64, 'base64')), id);
  return softCurveStrategy.apply({ node: nodeOf(block), block, params, canvas }, context);
}

function inMaskSpec(bits: Uint8Array, w: number, h: number, bbox: TreeBBox, x: number, y: number): boolean {
  const ix = Math.round(x) - bbox.x;
  const iy = Math.round(y) - bbox.y;
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false;
  return bits[iy * w + ix] === 1;
}

function assertGems(result: ReturnType<typeof applyFx>, bits: Uint8Array, w: number, h: number) {
  expect(result.gems.length).toBeGreaterThan(0);
  result.gems.forEach((g) => {
    expect(inMaskSpec(bits, w, h, { x: 100, y: 100, w, h }, g.x, g.y)).toBe(true);
    expect(g.blockId).toBe('n-c');
    expect(g.shapeId).toBe('round');
    expect(g.colorId).toBe('');
  });
  for (let i = 0; i < result.gems.length; i++) {
    for (let j = i + 1; j < result.gems.length; j++) {
      const d = Math.hypot(result.gems[i]!.x - result.gems[j]!.x, result.gems[i]!.y - result.gems[j]!.y);
      expect(d).toBeGreaterThanOrEqual(GEM * 0.99);
    }
  }
}

/** 合成 S 曲线带掩膜（带宽 9px，中线 y=yc(x)=40+20·sin(1.5πx/W)）。 */
function sineBand(w: number, h: number): { bits: Uint8Array; mid: (x: number) => number; arcLen: number } {
  const bits = new Uint8Array(w * h);
  const mid = (x: number) => h / 2 + (h / 4) * Math.sin((x / w) * Math.PI * 1.5);
  for (let x = 0; x < w; x++) {
    const yc = mid(x);
    for (let y = Math.floor(yc - 4); y <= Math.ceil(yc + 4); y++) {
      if (y >= 0 && y < h) bits[y * w + x] = 1;
    }
  }
  let arcLen = 0;
  for (let x = 1; x < w; x++) arcLen += Math.hypot(1, mid(x) - mid(x - 1));
  return { bits, mid, arcLen };
}

// ---------------------------------------------------------------- 参数 schema

describe('P1.2 soft-curve 参数 schema（Zod 冻结）', () => {
  it('缺省全可选；strict 拒未知键；界拒', () => {
    expect(SoftCurveParamsSchema.parse({})).toMatchObject({ fallbackEngineStrategy: 'hex-pitch' });
    expect(() => SoftCurveParamsSchema.parse({ nope: 1 })).toThrow();
    expect(() => SoftCurveParamsSchema.parse({ pointSpacingMm: 0 })).toThrow();
    expect(() => SoftCurveParamsSchema.parse({ minBranchLengthMm: -1 })).toThrow();
  });

  it('node/block id 不一致防御', () => {
    const a = blockOf(10, 10, new Uint8Array(100).fill(1), 'n-a');
    const b = nodeOf(blockOf(10, 10, new Uint8Array(100).fill(1), 'n-b'));
    expect(() => softCurveStrategy.apply({ node: b, block: a, params: {}, canvas }, ctx)).toThrow(/不一致/);
  });
});

// ---------------------------------------------------------------- 合成 S 曲线（已知几何）

describe('P1.2 soft-curve 合成 S 曲线带（骨架贴合+数量公式）', () => {
  const W = 320;
  const H = 90;
  const band = sineBand(W, H);
  const applySyn = (params: unknown) => {
    const block = blockOf(W, H, band.bits, 'n-c');
    return softCurveStrategy.apply({ node: nodeOf(block), block, params, canvas }, ctx);
  };

  it('每钻贴中线（|y-mid(x)| ≤ 半带宽+钻径）+ 全在掩膜内 + 两两间距≥钻径', () => {
    const r = applySyn({ pointSpacingMm: 2 });
    assertGems(r, band.bits, W, H);
    r.gems.forEach((g) => {
      const lx = g.x - 100;
      const ly = g.y - 100;
      expect(Math.abs(ly - band.mid(lx))).toBeLessThanOrEqual(4.5 + GEM);
    });
  });

  it('数量 ≈ 骨架弧长/点距 ±35%（族公式——单带骨架≈中线弧长）', () => {
    const spacingPx = 2 * PPM;
    const r = applySyn({ pointSpacingMm: 2 });
    const expectN = band.arcLen / spacingPx;
    expect(r.gems.length).toBeGreaterThanOrEqual(expectN * 0.65);
    expect(r.gems.length).toBeLessThanOrEqual(expectN * 1.35);
  });

  it('点距缩放：pointSpacingMm ×2 → 数量约减半（±20%）', () => {
    const a = applySyn({ pointSpacingMm: 2 });
    const b = applySyn({ pointSpacingMm: 4 });
    expect(b.gems.length).toBeGreaterThanOrEqual(a.gems.length * 0.4);
    expect(b.gems.length).toBeLessThanOrEqual(a.gems.length * 0.6);
  });

  it('确定性：同输入同输出（纯算法无随机——§4.4）', () => {
    expect(applySyn({ pointSpacingMm: 2 }).gems).toEqual(applySyn({ pointSpacingMm: 2 }).gems);
  });
});

// ---------------------------------------------------------------- 真实 fixture（5836 花茎）

describe('P1.2 soft-curve 真实 fixture——5836 花茎细弯条带群', () => {
  const fx = loadFx('softcurve-stems');
  const bits = new Uint8Array(Buffer.from(fx.maskB64, 'base64'));

  it('布点全在掩膜内+两两间距≥钻径+数量 ≥ 可读下限（1.6mm 钻+2mm 点距）', () => {
    const r = applyFx(fx, 'n-c', { pointSpacingMm: 2 });
    assertGems(r, bits, fx.w, fx.h);
    expect(r.gems.length).toBeGreaterThanOrEqual(24);
  });

  it('分支筛选：minBranchLengthMm ↑ → 产出单调不增（碎枝被筛）+ geometry warning 明示', () => {
    const base = applyFx(fx, 'n-c', { pointSpacingMm: 2, minBranchLengthMm: 0.5 });
    const coarse = applyFx(fx, 'n-c', { pointSpacingMm: 2, minBranchLengthMm: 30 });
    expect(coarse.warnings.some((w) => w.kind === 'geometry' && w.detail.includes('筛除'))).toBe(true);
    const baseCount = base.engineStrategy === undefined ? base.gems.length : 0;
    const coarseCount = coarse.engineStrategy === undefined ? coarse.gems.length : 0;
    expect(coarseCount).toBeLessThanOrEqual(baseCount);
  });

  it('确定性 + 分发入口同产出', () => {
    const r1 = applyFx(fx, 'n-c', { pointSpacingMm: 2 });
    const block = blockOf(fx.w, fx.h, bits, 'n-c');
    const r2 = applyStrategy('soft-curve', { node: nodeOf(block), block, params: { pointSpacingMm: 2 }, canvas }, ctx);
    expect(r1.gems).toEqual(r2.gems);
  });
});

// ---------------------------------------------------------------- 贯穿面

describe('P1.2 soft-curve 贯穿面', () => {
  const fx = loadFx('softcurve-stems');

  it('colorFamily 预留位：参数记录+warning 输出位（选色归 P3）', () => {
    const r = applyFx(fx, 'n-c', { pointSpacingMm: 2, colorFamily: '绿叶族' });
    expect(r.warnings.some((w) => w.detail.includes('colorFamily=绿叶族'))).toBe(true);
  });

  it('可读下限守卫：实心圆盘骨架=中心孤立点 → 声明式降级（§9 回流 4 同款）', () => {
    const w = 61;
    const h = 61;
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if ((x - 30) ** 2 + (y - 30) ** 2 <= 28 * 28) bits[y * w + x] = 1;
    const block = blockOf(w, h, bits, 'n-disk');
    const r = softCurveStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems).toHaveLength(0);
    expect(r.engineStrategy?.engineStrategy).toBe('hex-pitch');
    expect(r.engineStrategy?.reason).toBe('geometry-min-size');
  });
});
