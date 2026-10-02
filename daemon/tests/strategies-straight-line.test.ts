/**
 * 直线刚硬族测试（add-subject-sam-pipeline design §4.2/§8——P1.2；Owner 定调：
 * 「直线的就刚硬的（剑/杆/栅栏）」——同相位对齐不消机械感）。
 * 真实 fixture：f5c7 地精帽三角裁片（77×118——PCA 主轴沿帽长轴的平行线族）；合成
 * 旋转 30° 长条矩形（PCA 主轴恢复闭式断言+平行线残差结构）。fixture 由
 * tests/fixtures/generate-p1-semantic.py 离线预生成（测试不跨仓读文件）。
 * 覆盖：参数 schema（缺省+strict 拒+界拒）+ 布点全在掩膜内+两两间距≥钻径+数量≈
 * 密度×面积 ±25%（线距=点距=s 时方格直排=精确公式）+ 主轴恢复（30° 矩形 PCA 角
 * ±2°）+ 平行线族结构（每钻到最近线残差 <0.5px）+ 线距缩放数量反比+角度偏移语义+
 * colorFamily 预留 warning+可读下限降级（窄三角 30° 偏移欠布）+确定性。
 * 标度：PPM=3.68+2mm 钻+密度 12/cm²。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock } from '../src/kernel/vision/tree-to-blocks.js';
import { StraightLineParamsSchema, straightLineStrategy } from '../src/kernel/strategies/straight_line.js';
import { orientationField as orientationFieldShared } from '../src/kernel/strategies/orientation_field.js';
import { applyStrategy, createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';

const PPM = 3.68;
const GEM = 7.36; // 2mm 钻
const DENSITY = 12;

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
      nodeCategory: 'structure',
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
    category: 'structure',
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
  return straightLineStrategy.apply({ node: nodeOf(block), block, params, canvas }, context);
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
    expect(g.blockId).toBe('n-s');
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

/** 测试侧 PCA（规格复述——协方差最大特征向量 atan2(2sxy,sxx−syy)/2 + 质心）。 */
function pcaOf(bits: Uint8Array, w: number, h: number): { angle: number; cx: number; cy: number } {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (bits[y * w + x] === 1) {
        sx += x;
        sy += y;
        n++;
      }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (bits[y * w + x] === 1) {
        const dx = x - mx;
        const dy = y - my;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
      }
  return { angle: 0.5 * Math.atan2(2 * sxy, sxx - syy), cx: mx, cy: my };
}

/** 旋转 30° 长条矩形掩膜（200×60，长轴沿 30°）。 */
function rotatedBar(): { w: number; h: number; bits: Uint8Array } {
  const w = 240;
  const h = 160;
  const bits = new Uint8Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const a = (30 * Math.PI) / 180;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * Math.cos(a) + dy * Math.sin(a); // 沿长轴
      const v = -dx * Math.sin(a) + dy * Math.cos(a); // 法向
      if (Math.abs(u) <= 100 && Math.abs(v) <= 25) bits[y * w + x] = 1;
    }
  }
  return { w, h, bits };
}

// ---------------------------------------------------------------- 参数 schema

describe('P1.2 straight-line 参数 schema（Zod 冻结）', () => {
  it('缺省 angleOffsetDeg=0/fallback=hex-pitch；strict 拒未知键；界拒', () => {
    const p = StraightLineParamsSchema.parse({});
    expect(p).toMatchObject({ angleOffsetDeg: 0, fallbackEngineStrategy: 'hex-pitch' });
    expect(() => StraightLineParamsSchema.parse({ nope: 1 })).toThrow();
    expect(() => StraightLineParamsSchema.parse({ angleOffsetDeg: 95 })).toThrow();
    expect(() => StraightLineParamsSchema.parse({ lineSpacingMm: 0.01 })).toThrow();
  });

  it('node/block id 不一致防御', () => {
    const a = blockOf(10, 10, new Uint8Array(100).fill(1), 'n-a');
    const b = nodeOf(blockOf(10, 10, new Uint8Array(100).fill(1), 'n-b'));
    expect(() => straightLineStrategy.apply({ node: b, block: a, params: {}, canvas }, ctx)).toThrow(/不一致/);
  });
});

// ---------------------------------------------------------------- 合成旋转条（PCA+平行线结构）

describe('P1.2 straight-line 合成 30° 旋转长条（主轴恢复+平行线族结构）', () => {
  const bar = rotatedBar();

  it('PCA 主轴恢复：30° 长条 → 策略线方向=30°（过质心平行线族半整数网格残差 <0.5px）', () => {
    const block = blockOf(bar.w, bar.h, bar.bits, 'n-s');
    const r = straightLineStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    assertGems(r, bar.bits, bar.w, bar.h);
    const pca = pcaOf(bar.bits, bar.w, bar.h); // 测试侧恢复角（≈±30°）+质心
    expect(Math.abs(((pca.angle * 180) / Math.PI + 360) % 180 - 30)).toBeLessThan(2); // 主轴角恢复 ±2°
    const vx = -Math.sin(pca.angle);
    const vy = Math.cos(pca.angle);
    // 平行线族结构：每钻法向坐标 v ≡ ±(k+0.5)·lineSep（过质心、半格错开锚定——刚硬对齐）
    const lineSep = Math.max(GEM, (10 * PPM) / Math.sqrt(DENSITY));
    r.gems.forEach((g) => {
      const v = (g.x - 100 - pca.cx) * vx + (g.y - 100 - pca.cy) * vy;
      const half = v / lineSep - 0.5;
      const resid = Math.abs(half - Math.round(half)) * lineSep;
      expect(Math.min(resid, lineSep - resid)).toBeLessThan(0.5);
    });
  });

  it('角度偏移语义：angleOffsetDeg=90 → 线族转法向（残差结构对 90°+φ 向量成立）', () => {
    const block = blockOf(bar.w, bar.h, bar.bits, 'n-s');
    const r = straightLineStrategy.apply(
      { node: nodeOf(block), block, params: { angleOffsetDeg: 90 }, canvas },
      createStrategyContext({ gemDiameterPx: GEM, densityPerCm2: 4 }),
    );
    expect(r.gems.length).toBeGreaterThan(0);
    const pca = pcaOf(bar.bits, bar.w, bar.h);
    const phi = pca.angle + Math.PI / 2;
    const vx = -Math.sin(phi);
    const vy = Math.cos(phi);
    const lineSep = Math.max(GEM, (10 * PPM) / Math.sqrt(4));
    r.gems.forEach((g) => {
      const v = (g.x - 100 - pca.cx) * vx + (g.y - 100 - pca.cy) * vy;
      const half = v / lineSep - 0.5;
      const resid = Math.abs(half - Math.round(half)) * lineSep;
      expect(Math.min(resid, lineSep - resid)).toBeLessThan(0.5);
    });
  });

  it('线距缩放：lineSpacingMm ×2 → 数量约减半（±25%）', () => {
    const mk = (lineSpacingMm: number) => {
      const block = blockOf(bar.w, bar.h, bar.bits, 'n-s');
      return straightLineStrategy.apply(
        { node: nodeOf(block), block, params: { lineSpacingMm }, canvas },
        ctx,
      );
    };
    const a = mk(3);
    const b = mk(6);
    expect(b.gems.length).toBeGreaterThanOrEqual(a.gems.length * 0.35);
    expect(b.gems.length).toBeLessThanOrEqual(a.gems.length * 0.65);
  });
});

// ---------------------------------------------------------------- 真实 fixture（f5c7 地精帽三角）

describe('P1.2 straight-line 真实 fixture——f5c7 地精帽三角', () => {
  const fx = loadFx('straightline-hat');
  const bits = new Uint8Array(Buffer.from(fx.maskB64, 'base64'));

  it('布点全在掩膜内+两两间距≥钻径+数量≈密度×面积 ±25%（线距=点距=特征间距的方格直排）', () => {
    const r = applyFx(fx, 'n-s', {});
    assertGems(r, bits, fx.w, fx.h);
    let areaPx = 0;
    for (const b of bits) if (b === 1) areaPx++;
    const target = DENSITY * (areaPx / (PPM * PPM * 100));
    expect(r.gems.length).toBeGreaterThanOrEqual(0.75 * target);
    expect(r.gems.length).toBeLessThanOrEqual(1.25 * target);
  });

  it('线方向=帽子长轴：过质心平行线族半整数网格残差 <0.5px（刚硬对齐）', () => {
    const r = applyFx(fx, 'n-s', {});
    const pca = pcaOf(bits, fx.w, fx.h);
    const vx = -Math.sin(pca.angle);
    const vy = Math.cos(pca.angle);
    const lineSep = Math.max(GEM, (10 * PPM) / Math.sqrt(DENSITY));
    r.gems.forEach((g) => {
      const v = (g.x - 100 - pca.cx) * vx + (g.y - 100 - pca.cy) * vy;
      const half = v / lineSep - 0.5;
      const resid = Math.abs(half - Math.round(half)) * lineSep;
      expect(Math.min(resid, lineSep - resid)).toBeLessThan(0.5);
    });
  });

  it('确定性 + 分发入口同产出', () => {
    const r1 = applyFx(fx, 'n-s', {});
    const block = blockOf(fx.w, fx.h, bits, 'n-s');
    const r2 = applyStrategy('straight-line', { node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r1.gems).toEqual(r2.gems);
  });

  it('角度偏移语义（真实帽三角）：30° 偏移仍合法产出（掩膜内+间距不变量保持）', () => {
    const r = applyFx(fx, 'n-s', { angleOffsetDeg: 30 });
    assertGems(r, bits, fx.w, fx.h);
  });

  it('可读下限守卫：微小节点 → 声明式降级（§9 回流 4 同款）', () => {
    const tw = 24;
    const th = 24;
    const tb = new Uint8Array(tw * th);
    for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) tb[y * tw + x] = 1;
    const block = blockOf(tw, th, tb, 'n-tiny');
    const r = straightLineStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems).toHaveLength(0);
    expect(r.engineStrategy?.reason).toBe('geometry-min-size');
    expect(r.engineStrategy?.engineStrategy).toBe('hex-pitch');
  });
});

// ---------------------------------------------------------------- 贯穿面

describe('P1.2 straight-line 贯穿面', () => {
  const fx = loadFx('straightline-hat');

  it('colorFamily 预留位：参数记录+warning 输出位（选色归 P3）', () => {
    const r = applyFx(fx, 'n-s', { colorFamily: '粉帽族' });
    expect(r.warnings.some((w) => w.detail.includes('colorFamily=粉帽族'))).toBe(true);
  });

  it('fallback 覆写：可读下限不足时可指派 poisson（声明式降级目标可配）', () => {
    const tw = 24;
    const th = 24;
    const tb = new Uint8Array(tw * th);
    for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) tb[y * tw + x] = 1;
    const block = blockOf(tw, th, tb, 'n-tiny');
    const r = straightLineStrategy.apply(
      { node: nodeOf(block), block, params: { fallbackEngineStrategy: 'poisson' }, canvas },
      ctx,
    );
    expect(r.engineStrategy?.engineStrategy).toBe('poisson');
  });
});

// ---------------------------------------------------------------- T4 取向场（close-paving-backlog）

describe('T4 straight-line 取向场（orientation 双模——global-pca 逐位兼容/gradient-field 布点核替换）', () => {
  const W = 320;
  const H = 320;
  const solidBits = new Uint8Array(W * H).fill(1);

  /**
   * 合成旋转纹理亮度场（水平→垂直渐变）：luma=sin(2π·g/λ)，g=y·(1−t)+x·t（t=x/w）
   * ——等值线（结构张量切向）左半水平、右半垂直、中间连续旋转：线族随场弯曲的闭式场。
   */
  function rotatingStripeLuma(): string {
    const lambda = 24;
    const buf = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = x / W;
        const g = y * (1 - t) + x * t;
        buf[y * W + x] = Math.round(127.5 + 127.5 * Math.sin((2 * Math.PI * g) / lambda));
      }
    }
    return buf.toString('base64');
  }

  it('schema：orientation 缺省 global-pca；lumaB64 非法字母表拒', () => {
    expect(StraightLineParamsSchema.parse({})).toMatchObject({ orientation: 'global-pca' });
    expect(StraightLineParamsSchema.parse({ orientation: 'gradient-field' }).orientation).toBe('gradient-field');
    expect(() => StraightLineParamsSchema.parse({ orientation: 'isotropic' })).toThrow();
    expect(() => StraightLineParamsSchema.parse({ lumaB64: 'not@base64!' })).toThrow();
  });

  it('缺省逐位兼容：orientation 缺省=global-pca 与显式 global-pca 逐位同产（升级不改现状）', () => {
    const block = blockOf(W, H, solidBits, 'n-s');
    const implicit = straightLineStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    const explicit = straightLineStrategy.apply(
      { node: nodeOf(block), block, params: { orientation: 'global-pca' }, canvas },
      ctx,
    );
    expect(implicit).toEqual(explicit);
    // 平行线族全局同角（旧语义——gradient-field 测试的对偶基准）
    const angles = new Set(explicit.gems.map((g) => g.rotationDeg));
    expect(angles.size).toBe(1);
  });

  it('gradient-field+lumaB64：线族随场弯曲（非全局平行）+钻角=局部取向+间距/掩膜不变量', () => {
    const block = blockOf(W, H, solidBits, 'n-s');
    const lumaB64 = rotatingStripeLuma();
    const r = straightLineStrategy.apply(
      { node: nodeOf(block), block, params: { orientation: 'gradient-field', lumaB64 }, canvas },
      ctx,
    );
    expect(r.gems.length).toBeGreaterThan(0);
    // 布点合法面（掩膜内+钻径间距）
    r.gems.forEach((g) => {
      expect(inMaskSpec(solidBits, W, H, { x: 100, y: 100, w: W, h: H }, g.x, g.y)).toBe(true);
    });
    for (let i = 0; i < r.gems.length; i++) {
      for (let j = i + 1; j < r.gems.length; j++) {
        const d = Math.hypot(r.gems[i]!.x - r.gems[j]!.x, r.gems[i]!.y - r.gems[j]!.y);
        expect(d).toBeGreaterThanOrEqual(GEM * 0.99);
      }
    }
    // 线族弯曲：rotationDeg 多值（全局平行=单值）且跨象限跨距大（mod 180 标准差 >15°）
    const angles180 = r.gems.map((g) => ((g.rotationDeg ?? 0) % 180 + 180) % 180);
    const mean = angles180.reduce((a, b) => a + b, 0) / angles180.length;
    const sd = Math.sqrt(angles180.reduce((a, b) => a + (b - mean) ** 2, 0) / angles180.length);
    expect(new Set(angles180.map((a) => Math.round(a))).size).toBeGreaterThan(10);
    expect(sd).toBeGreaterThan(15);
    // 左半（水平结构）角≈90 mod 180；右半（垂直结构）角≈0 mod 180——场随 x 弯曲
    const distTo = (a: number, target: number) => Math.min(Math.abs(a - target), 180 - Math.abs(a - target));
    const left = r.gems.filter((g) => g.x - 100 < W / 3).map((g) => (((g.rotationDeg ?? 0) % 180) + 180) % 180);
    const right = r.gems.filter((g) => g.x - 100 > (2 * W) / 3).map((g) => (((g.rotationDeg ?? 0) % 180) + 180) % 180);
    expect(left.length).toBeGreaterThan(5);
    expect(right.length).toBeGreaterThan(5);
    const leftMedian = left.slice().sort((a, b) => distTo(a, 90) - distTo(b, 90))[Math.floor(left.length / 2)]!;
    const rightMedian = right.slice().sort((a, b) => distTo(a, 0) - distTo(b, 0))[Math.floor(right.length / 2)]!;
    expect(distTo(leftMedian, 90)).toBeLessThan(30);
    expect(distTo(rightMedian, 0)).toBeLessThan(30);
    expect(distTo(leftMedian, rightMedian)).toBeGreaterThan(45);
    // 钻角=局部取向（对共享件方向场逐点比对——夹角 <25°）
    const ori = orientationFieldShared(lumaB64, block.mask);
    for (const g of r.gems) {
      const ix = Math.round(g.x) - 100;
      const iy = Math.round(g.y) - 100;
      if (ix < 1 || iy < 1 || ix >= W - 1 || iy >= H - 1) continue;
      const k = iy * W + ix;
      const fieldDeg = (Math.atan2(ori.ty[k]!, ori.tx[k]!) * 180) / Math.PI + 90;
      let diff = Math.abs((g.rotationDeg ?? 0) - fieldDeg) % 180;
      if (diff > 90) diff = 180 - diff;
      expect(diff).toBeLessThan(25);
    }
    // 确定性
    expect(
      straightLineStrategy.apply(
        { node: nodeOf(block), block, params: { orientation: 'gradient-field', lumaB64 }, canvas },
        ctx,
      ),
    ).toEqual(r);
  });

  it('gradient-field 无 lumaB64：方向场退化掩膜形状流——degraded warning+仍合法产出', () => {
    const block = blockOf(W, H, solidBits, 'n-s');
    const r = straightLineStrategy.apply(
      { node: nodeOf(block), block, params: { orientation: 'gradient-field' }, canvas },
      ctx,
    );
    expect(r.gems.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.kind === 'degraded' && w.detail.includes('掩膜形状流'))).toBe(true);
    r.gems.forEach((g) => {
      expect(inMaskSpec(solidBits, W, H, { x: 100, y: 100, w: W, h: H }, g.x, g.y)).toBe(true);
    });
  });

  it('gradient-field lumaB64 长度失配 apply 内显式拒（RangeError——texture_fill 同语义）', () => {
    const block = blockOf(W, H, solidBits, 'n-s');
    const bad = Buffer.alloc(10).toString('base64');
    expect(() =>
      straightLineStrategy.apply(
        { node: nodeOf(block), block, params: { orientation: 'gradient-field', lumaB64: bad }, canvas },
        ctx,
      ),
    ).toThrow(/lumaB64 解码长度/);
  });
});
