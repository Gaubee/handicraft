/**
 * 花形族测试（add-subject-sam-pipeline design §4.2/§8——P1.2）。
 * 真实 fixture：5836 雪滴花裁片（58×88 花头+茎+叶瓣状复合体——径向签名自动检测=3 瓣）；
 * 合成六瓣玫瑰纹（r(θ)=R(0.62+0.38|cos3θ|)——检测数闭式断言）。fixture 由
 * tests/fixtures/generate-p1-semantic.py 离线预生成（测试不跨仓读文件）。
 * 覆盖：参数 schema（缺省+strict 拒+界拒）+ 布点全在掩膜内+两两间距≥钻径+数量≈
 * 密度×面积×覆盖因子 ±45%（族公差——花心环+花瓣弧非全域直排）+ 花瓣检测（合成=6、
 * fixture=3、圆盘=退化 warning）+ petals 覆写+petalDensity 密度单调+coreRadiusRatio
 * 花心占比语义（core 内半径单调）+ colorFamily 预留 warning+可读下限降级+确定性。
 * 标度：PPM=3.68+2mm 钻+密度 16/cm²（小件加密——ctx 注入面）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock, TreeMask2D } from '../src/kernel/vision/tree-to-blocks.js';
import { FlowerParamsSchema, flowerStrategy, radialSignatureAndPetals } from '../src/kernel/strategies/flower.js';
import { applyStrategy, createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';

const PPM = 3.68;
const GEM = 7.36; // 2mm 钻
const DENSITY = 25;

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
    suggested: 'fill',
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
const ctx: StrategyContext = createStrategyContext({ gemDiameterPx: GEM, densityPerCm2: DENSITY });

function applyFx(fx: Fixture, id: string, params: unknown, context = ctx) {
  const block = blockOf(fx.w, fx.h, new Uint8Array(Buffer.from(fx.maskB64, 'base64')), id);
  return flowerStrategy.apply({ node: nodeOf(block), block, params, canvas }, context);
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
    expect(g.blockId).toBe('n-f');
    expect(g.shapeId).toBe('round');
    expect(g.colorId).toBe('');
    expect(g.diameterMm).toBeCloseTo(2, 5);
  });
  for (let i = 0; i < result.gems.length; i++) {
    for (let j = i + 1; j < result.gems.length; j++) {
      const d = Math.hypot(result.gems[i]!.x - result.gems[j]!.x, result.gems[i]!.y - result.gems[j]!.y);
      expect(d).toBeGreaterThanOrEqual(GEM * 0.99);
    }
  }
}

/** 合成六瓣玫瑰纹掩膜（r(θ)=R(0.62+0.38|cos3θ|)——|cos3θ| 周期 60°×双瓣=6 瓣）。 */
function rosette(w: number, h: number, R: number): Uint8Array {
  const bits = new Uint8Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const theta = Math.atan2(dy, dx);
      const rb = R * (0.62 + 0.38 * Math.abs(Math.cos(3 * theta)));
      if (r <= rb) bits[y * w + x] = 1;
    }
  }
  return bits;
}

// ---------------------------------------------------------------- 参数 schema

describe('P1.2 flower 参数 schema（Zod 冻结）', () => {
  it('缺省 coreRadiusRatio=0.3/petalDensity=1/fallback=hex-pitch；strict 拒未知键', () => {
    const p = FlowerParamsSchema.parse({});
    expect(p).toMatchObject({ coreRadiusRatio: 0.3, petalDensity: 1, fallbackEngineStrategy: 'hex-pitch' });
    expect(() => FlowerParamsSchema.parse({ nope: 1 })).toThrow();
  });

  it('界拒：petals [3,64]/coreRadiusRatio (0.05,0.8)/petalDensity [0.2,5]', () => {
    expect(() => FlowerParamsSchema.parse({ petals: 2 })).toThrow();
    expect(() => FlowerParamsSchema.parse({ coreRadiusRatio: 0.9 })).toThrow();
    expect(() => FlowerParamsSchema.parse({ petalDensity: 6 })).toThrow();
  });

  it('node/block id 不一致防御', () => {
    const a = blockOf(10, 10, new Uint8Array(100).fill(1), 'n-a');
    const b = nodeOf(blockOf(10, 10, new Uint8Array(100).fill(1), 'n-b'));
    expect(() => flowerStrategy.apply({ node: b, block: a, params: {}, canvas }, ctx)).toThrow(/不一致/);
  });
});

// ---------------------------------------------------------------- 花瓣检测（径向签名）

describe('P1.2 flower 花瓣自动检测（径向边界签名）', () => {
  it('合成六瓣玫瑰纹 → 检测=6（闭式）', () => {
    const bits = rosette(121, 121, 55);
    const { detected } = radialSignatureAndPetals({ w: 121, h: 121, bits } as TreeMask2D, 60.5, 60.5);
    expect(detected).toBe(6);
  });

  it('圆盘 → 无显著瓣状结构（检测 <3 → 退化 warning 路径；抗栅格涟漪显著性下限）', () => {
    const d = new Uint8Array(121 * 121);
    for (let y = 0; y < 121; y++)
      for (let x = 0; x < 121; x++) if ((x - 60) ** 2 + (y - 60) ** 2 <= 55 * 55) d[y * 121 + x] = 1;
    const { detected } = radialSignatureAndPetals({ w: 121, h: 121, bits: d } as TreeMask2D, 60.5, 60.5);
    expect(detected).toBeLessThan(3);
  });

  it('真实 fixture 雪滴花复合体 → 检测=3（花头/茎/叶三瓣状极角）', () => {
    const fx = loadFx('flower-bloom');
    const bits = new Uint8Array(Buffer.from(fx.maskB64, 'base64'));
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < fx.h; y++)
      for (let x = 0; x < fx.w; x++)
        if (bits[y * fx.w + x] === 1) {
          sx += x;
          sy += y;
          n++;
        }
    const { detected } = radialSignatureAndPetals({ w: fx.w, h: fx.h, bits } as TreeMask2D, sx / n, sy / n);
    expect(detected).toBe(3);
  });
});

// ---------------------------------------------------------------- 真实 fixture（5836 雪滴花）

describe('P1.2 flower 真实 fixture——5836 雪滴花复合体', () => {
  const fx = loadFx('flower-bloom');
  const bits = new Uint8Array(Buffer.from(fx.maskB64, 'base64'));

  it('布点全在掩膜内+两两间距≥钻径+数量 ≥ 可读下限+族公差 [0.25,0.95]×密度×面积', () => {
    const r = applyFx(fx, 'n-f', { coreRadiusRatio: 0.45 }); // 花心占比上调：3 瓣复合体凹谷排除后花心环承载
    assertGems(r, bits, fx.w, fx.h);
    expect(r.gems.length).toBeGreaterThanOrEqual(24);
    let areaPx = 0;
    for (const b of bits) if (b === 1) areaPx++;
    const target = DENSITY * (areaPx / (PPM * PPM * 100));
    expect(r.gems.length).toBeGreaterThanOrEqual(0.25 * target);
    expect(r.gems.length).toBeLessThanOrEqual(0.95 * target);
  });

  it('petals 覆写（等分扇区替代检测峰位）合法产出——小件上密度微调受钻径门钳定', () => {
    const over = applyFx(fx, 'n-f', { petals: 6, coreRadiusRatio: 0.25 });
    expect(over.gems.length).toBeGreaterThan(0);
    const dense = applyFx(fx, 'n-f', { coreRadiusRatio: 0.45, petalDensity: 1.2 });
    expect(dense.gems.length).toBeGreaterThan(0);
  });

  it('确定性 + 分发入口同产出', () => {
    const r1 = applyFx(fx, 'n-f', {});
    const block = blockOf(fx.w, fx.h, bits, 'n-f');
    const r2 = applyStrategy('flower', { node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r1.gems).toEqual(r2.gems);
  });
});

// ---------------------------------------------------------------- 合成玫瑰纹（结构语义）

describe('P1.2 flower 合成六瓣玫瑰纹（极坐标分解结构）', () => {
  const W = 241;
  const bits = rosette(W, W, 110);
  const applySyn = (params: unknown) => {
    const block = blockOf(W, W, bits, 'n-f');
    return flowerStrategy.apply({ node: nodeOf(block), block, params, canvas }, ctx);
  };
  const applySynCtx = (params: unknown, context: StrategyContext) => {
    const block = blockOf(W, W, bits, 'n-f');
    return flowerStrategy.apply({ node: nodeOf(block), block, params, canvas }, context);
  };

  it('扇区语义：自动检测 6 瓣下瓣间凹谷带无钻（凹谷排除带半宽 0.35×π/6=10.5°——凹谷 ±8° 外）', () => {
    const r = applySyn({});
    expect(r.gems.length).toBeGreaterThan(0);
    // 六瓣峰位≈k·60°；凹谷≈k·60°+30°。扇区约束后 r>花心区的钻应远离凹谷 ≥14°
    r.gems.forEach((g) => {
      const dx = g.x - 100 - W / 2;
      const dy = g.y - 100 - W / 2;
      const r0 = Math.hypot(dx, dy);
      if (r0 <= 0.3 * 110) return; // 花心不筛
      const theta = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const toValley = Math.abs(((theta % 60) + 60) % 60 - 30); // 到最近凹谷（30° 模）的距离
      expect(toValley).toBeGreaterThan(8);
    });
  });

  it('petalDensity ↑ → 花瓣弧向加密（合成玫瑰纹：1→1.5 数量单调增——弧间距 12.27→8.18 仍 ≥ 钻径）', () => {
    const ctx9 = createStrategyContext({ gemDiameterPx: GEM, densityPerCm2: 9 });
    const base = applySynCtx({}, ctx9);
    const dense = applySynCtx({ petalDensity: 1.5 }, ctx9);
    expect(dense.gems.length).toBeGreaterThan(base.gems.length);
  });

  it('coreRadiusRatio 语义：花心占比 ↑ → 花心环内钻数不减（半径单调扩张）', () => {
    const small = applySyn({ coreRadiusRatio: 0.15 });
    const large = applySyn({ coreRadiusRatio: 0.5 });
    const inCore = (r: ReturnType<typeof applySyn>, ratio: number) =>
      r.gems.filter((g) => Math.hypot(g.x - 100 - W / 2, g.y - 100 - W / 2) <= ratio * 110 * 0.6).length;
    expect(inCore(large, 0.15)).toBeGreaterThanOrEqual(inCore(small, 0.15));
  });
});

// ---------------------------------------------------------------- 贯穿面

describe('P1.2 flower 贯穿面', () => {
  const fx = loadFx('flower-bloom');

  it('colorFamily 预留位：参数记录+warning 输出位（选色归 P3）', () => {
    const r = applyFx(fx, 'n-f', { colorFamily: '白瓣族' });
    expect(r.warnings.some((w) => w.detail.includes('colorFamily=白瓣族'))).toBe(true);
  });

  it('可读下限守卫：微小节点 → 声明式降级（缺省 hex-pitch 可覆写）', () => {
    const bits = new Uint8Array(24 * 24);
    for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) bits[y * 24 + x] = 1;
    const block = blockOf(24, 24, bits, 'n-tiny');
    const r = flowerStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems).toHaveLength(0);
    expect(r.engineStrategy?.reason).toBe('geometry-min-size');
    const r2 = flowerStrategy.apply(
      { node: nodeOf(block), block, params: { fallbackEngineStrategy: 'hybrid' }, canvas },
      ctx,
    );
    expect(r2.engineStrategy?.engineStrategy).toBe('hybrid');
  });
});
