/**
 * 纹理贴图法族测试（add-subject-sam-pipeline design §4.2/§8/§10——P1.2）。
 * 真实 fixture：2a0c 小丑服裁片（230×250，亮度场=灰度——scatter 亮度加权/flow 方向场）+
 * ebdc 水晶雪橇裁片（180×130——flow 方向跟随，spike e-sleigh 同源区）；掩膜/亮度场由
 * tests/fixtures/generate-p1-semantic.py 离线预生成（PIL 确定性阈值——测试不跨仓读文件）。
 * 覆盖：三模参数 schema（Zod 冻结+缺省+strict 拒+界拒+lumaB64 非法拒/长度失配抛）+
 * 布点全在掩膜内+两两间距≥钻径+数量≈密度×面积±族公差（scatter=六角初始化 1.155×；
 * flow=线几何 0.35-0.85×）+ scatter 覆盖均匀性（NN 距离变异系数）+ flow 方向一致性
 * （gem→最近邻向量 vs 局部切向夹角中位 <45°——spike 实测 18-32° 的工程化放宽）+
 * hybrid 混合路由（B 打底+A 描线：方向优于纯 scatter）+ 无 luma 退化 warning+
 * colorFamily 预留位 warning+可读下限降级+确定性（同 node 同参同果/异 node 异果）。
 * 标度：PPM=3.68（736px/200mm 原稿 native）+2mm 钻（7.36px）+密度 12/cm²（注入面
 * StrategyAssignment.densityPerCm2 同通道——ctx）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock, TreeMask2D } from '../src/kernel/vision/tree-to-blocks.js';
import {
  TextureFillParamsSchema,
  orientationField,
  textureFillStrategy,
} from '../src/kernel/strategies/texture_fill.js';
import { applyStrategy, createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';

const PPM = 3.68; // 原稿 native 标度（736px / 200mm）
const GEM = 7.36; // 2mm 钻
const DENSITY = 12;

interface Fixture {
  family: string;
  w: number;
  h: number;
  maskB64: string;
  lumaB64: string;
  meta: { ppm: number };
}

/** fixture 装载（掩膜+亮度场——base64 字节，TreeMask2D 同构语义）。 */
function loadFx(name: string): Fixture {
  return JSON.parse(readFileSync(`tests/fixtures/p1-semantic/${name}.json`, 'utf8')) as Fixture;
}

/** fixture → TreeBlock（bbox 锚点任取 100,100——gem 输出为画布全局坐标）。 */
function blockOf(fx: Fixture, id: string): TreeBlock {
  const bits = new Uint8Array(Buffer.from(fx.maskB64, 'base64'));
  let areaPx = 0;
  for (const b of bits) if (b === 1) areaPx++;
  return {
    id,
    label: `fixture/${fx.family}`,
    mask: { w: fx.w, h: fx.h, bits },
    colorRgb: [128, 128, 128],
    areaPx,
    bbox: { x: 100, y: 100, w: fx.w, h: fx.h },
    widthPx: { max: Math.min(fx.w, fx.h), mean: Math.min(fx.w, fx.h) / 2 },
    suggested: 'fill',
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

function apply(fx: Fixture, id: string, params: unknown, context = ctx) {
  const block = blockOf(fx, id);
  return textureFillStrategy.apply({ node: nodeOf(block), block, params, canvas }, context);
}

/** 掩膜内判定（测试侧规格复述，不引实现）。 */
function inMaskSpec(fx: Fixture, bbox: TreeBBox, x: number, y: number): boolean {
  const ix = Math.round(x) - bbox.x;
  const iy = Math.round(y) - bbox.y;
  if (ix < 0 || iy < 0 || ix >= fx.w || iy >= fx.h) return false;
  return new Uint8Array(Buffer.from(fx.maskB64, 'base64'))[iy * fx.w + ix] === 1;
}

/** 通用断言束：全在掩膜内+两两间距 ≥ 钻径×0.99+基础字段。 */
function assertGems(result: ReturnType<typeof apply>, fx: Fixture) {
  expect(result.gems.length).toBeGreaterThan(0);
  result.gems.forEach((g) => {
    expect(inMaskSpec(fx, { x: 100, y: 100, w: fx.w, h: fx.h }, g.x, g.y)).toBe(true);
    expect(g.blockId).toBe('n-t');
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

/** 最近邻距离统计（均值/变异系数——scatter 覆盖均匀性度量）。 */
function nnStats(gems: { x: number; y: number }[]): { mean: number; cv: number } {
  const nn: number[] = [];
  for (let i = 0; i < gems.length; i++) {
    let best = Infinity;
    for (let j = 0; j < gems.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(gems[i]!.x - gems[j]!.x, gems[i]!.y - gems[j]!.y);
      if (d < best) best = d;
    }
    if (best < Infinity) nn.push(best);
  }
  const mean = nn.reduce((a, b) => a + b, 0) / nn.length;
  const sd = Math.sqrt(nn.reduce((a, b) => a + (b - mean) ** 2, 0) / nn.length);
  return { mean, cv: sd / mean };
}

/**
 * 方向一致性度量（spike REPORT §4.1 同口径）：gem→最近邻 gem 向量与局部切向的最小
 * 夹角中位（各向同性基准 45°；spike A 流线实测 18-32°）。
 */
function directionMedian(result: ReturnType<typeof apply>, fx: Fixture): number {
  const p = TextureFillParamsSchema.parse({ mode: 'flow', lumaB64: fx.lumaB64 });
  const mask: TreeMask2D = { w: fx.w, h: fx.h, bits: new Uint8Array(Buffer.from(fx.maskB64, 'base64')) };
  const ori = orientationField(p, mask);
  const gems = result.gems;
  const angles: number[] = [];
  for (let i = 0; i < gems.length; i++) {
    let best = Infinity;
    let bj = -1;
    for (let j = 0; j < gems.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(gems[i]!.x - gems[j]!.x, gems[i]!.y - gems[j]!.y);
      if (d < best) {
        best = d;
        bj = j;
      }
    }
    if (bj < 0) continue;
    const ix = Math.round(gems[i]!.x) - 100;
    const iy = Math.round(gems[i]!.y) - 100;
    if (ix < 0 || iy < 0 || ix >= fx.w || iy >= fx.h) continue;
    const k = iy * fx.w + ix;
    const dx = gems[bj]!.x - gems[i]!.x;
    const dy = gems[bj]!.y - gems[i]!.y;
    const dot = Math.abs((dx * ori.tx[k]! + dy * ori.ty[k]!) / (Math.hypot(dx, dy) || 1));
    angles.push((Math.acos(Math.min(1, dot)) * 180) / Math.PI);
  }
  angles.sort((a, b) => a - b);
  return angles[Math.floor(angles.length / 2)] ?? 90;
}

/** 数量族公差断言（family tolerance——见用例注）。 */
function assertCount(result: ReturnType<typeof apply>, fx: Fixture, lo: number, hi: number) {
  const bits = new Uint8Array(Buffer.from(fx.maskB64, 'base64'));
  let areaPx = 0;
  for (const b of bits) if (b === 1) areaPx++;
  const areaCm2 = areaPx / (PPM * PPM * 100);
  const target = DENSITY * areaCm2;
  expect(result.gems.length).toBeGreaterThanOrEqual(lo * target);
  expect(result.gems.length).toBeLessThanOrEqual(hi * target);
}

// ---------------------------------------------------------------- 参数 schema

describe('P1.2 texture-fill 参数 schema（Zod 冻结）', () => {
  it('scatter 缺省：polarity=dark-dense/lloydIters=8/fallback=hex-pitch；strict 拒未知键', () => {
    const p = TextureFillParamsSchema.parse({ mode: 'scatter' });
    expect(p).toMatchObject({ mode: 'scatter', polarity: 'dark-dense', lloydIters: 8, fallbackEngineStrategy: 'hex-pitch' });
    expect(() => TextureFillParamsSchema.parse({ mode: 'scatter', nope: 1 })).toThrow();
  });

  it('flow 无 lloydIters 面；hybrid lineShare 缺省 0.4 且界 (0,1]', () => {
    const p = TextureFillParamsSchema.parse({ mode: 'flow' });
    expect('lloydIters' in p).toBe(false);
    const h = TextureFillParamsSchema.parse({ mode: 'hybrid' });
    expect(h.mode === 'hybrid' && h.lineShare).toBe(0.4);
    expect(() => TextureFillParamsSchema.parse({ mode: 'hybrid', lineShare: 0 })).toThrow();
    expect(() => TextureFillParamsSchema.parse({ mode: 'hybrid', lineShare: 1.5 })).toThrow();
  });

  it('lumaB64 非法字符拒；lloydIters 界 0-16；polarity 三值枚举', () => {
    expect(() => TextureFillParamsSchema.parse({ mode: 'scatter', lumaB64: '!!not-b64!!' })).toThrow();
    expect(() => TextureFillParamsSchema.parse({ mode: 'scatter', lloydIters: 17 })).toThrow();
    expect(TextureFillParamsSchema.parse({ mode: 'scatter', polarity: 'bright-dense' }).polarity).toBe('bright-dense');
    expect(() => TextureFillParamsSchema.parse({ mode: 'scatter', polarity: 'nope' })).toThrow();
  });

  it('lumaB64 长度失配 apply 内显式拒（RangeError——亮度场与掩膜同 bbox 语义）', () => {
    const fx = loadFx('texture-costume');
    const bad = Buffer.alloc(10).toString('base64');
    expect(() => apply(fx, 'n-t', { mode: 'scatter', lumaB64: bad })).toThrow(RangeError);
  });

  it('node/block id 不一致防御（P0.2 同寻址空间契约）', () => {
    const fx = loadFx('texture-costume');
    const block = blockOf(fx, 'n-a');
    const node = nodeOf(blockOf(fx, 'n-b'));
    expect(() => textureFillStrategy.apply({ node, block, params: { mode: 'scatter' }, canvas }, ctx)).toThrow(/不一致/);
  });
});

// ---------------------------------------------------------------- scatter（B：加权 Voronoi 点画）

describe('P1.2 texture-fill scatter（加权 Voronoi+受限 Lloyd）——真实 fixture 2a0c 小丑服', () => {
  const fx = loadFx('texture-costume');

  it('布点全在掩膜内+两两间距≥钻径+数量≈密度×面积±族公差（六角初始化 1.155×——[0.9,1.5]）', () => {
    const r = apply(fx, 'n-t', { mode: 'scatter', lumaB64: fx.lumaB64 });
    assertGems(r, fx);
    assertCount(r, fx, 0.9, 1.5);
  });

  it('覆盖均匀性：NN 距离变异系数 < 0.25（亮度加权重排后仍近均匀——spike cov≈1.00 的间接度量）', () => {
    const r = apply(fx, 'n-t', { mode: 'scatter', lumaB64: fx.lumaB64 });
    const st = nnStats(r.gems);
    expect(st.cv).toBeLessThan(0.25);
    expect(st.mean).toBeGreaterThan(GEM); // NN 均距不下探钻径（无粘连堆积）
  });

  it('flat 极性：均匀密度（ρ≡1）——CV 更低（<0.15）且各向同性方向中位 ≈45°±15', () => {
    const r = apply(fx, 'n-t', { mode: 'scatter', polarity: 'flat' });
    expect(nnStats(r.gems).cv).toBeLessThan(0.15);
    const dir = directionMedian(r, fx);
    expect(dir).toBeGreaterThan(30);
    expect(dir).toBeLessThan(60);
  });

  it('受限 Lloyd 迭代预算：lloydIters=0 跳过松弛仍合法产出（生成级间距已 ≥ 钻径）', () => {
    const r = apply(fx, 'n-t', { mode: 'scatter', lumaB64: fx.lumaB64, lloydIters: 0 });
    assertGems(r, fx);
  });
});

// ---------------------------------------------------------------- flow（A：ETF 流线）

describe('P1.2 texture-fill flow（ETF 流线）——真实 fixture ebdc 水晶雪橇', () => {
  const fx = loadFx('texture-sleigh');

  it('方向一致性：NN-切向夹角中位 <45°（briefing 硬门——spike 实测 18-32° 工程化放宽）', () => {
    const r = apply(fx, 'n-t', { mode: 'flow', lumaB64: fx.lumaB64 });
    assertGems(r, fx);
    expect(directionMedian(r, fx)).toBeLessThan(45);
  });

  it('数量族公差 [0.35,0.85]×密度×面积（线几何+洞补——非密度直排）+确定性同 node 同果', () => {
    const r1 = apply(fx, 'n-t', { mode: 'flow', lumaB64: fx.lumaB64 });
    assertCount(r1, fx, 0.35, 0.85);
    const r2 = apply(fx, 'n-t', { mode: 'flow', lumaB64: fx.lumaB64 });
    expect(r1.gems).toEqual(r2.gems); // §4.4 同 node+同参可回放
  });

  it('无 lumaB64：方向场退化掩膜形状流——degraded warning 明示+仍合法产出', () => {
    const r = apply(fx, 'n-t', { mode: 'flow' });
    expect(r.warnings.some((w) => w.kind === 'degraded' && w.detail.includes('掩膜形状流'))).toBe(true);
    assertGems(r, fx);
  });
});

// ---------------------------------------------------------------- hybrid（B 打底+A 描线）

describe('P1.2 texture-fill hybrid（§10 回流 1 混合路由）——真实 fixture 2a0c 小丑服', () => {
  const fx = loadFx('texture-costume');

  it('数量≈密度×面积（scatter 打底主导 [0.7,1.3]）+间距/掩膜不变量', () => {
    const r = apply(fx, 'n-t', { mode: 'hybrid', lineShare: 0.4, lumaB64: fx.lumaB64 });
    assertGems(r, fx);
    assertCount(r, fx, 0.7, 1.3);
  });

  it('描线提升方向感：hybrid(0.8) 方向中位 < 纯 scatter 方向中位（线份额单调语义）', () => {
    const scatter = apply(fx, 'n-t', { mode: 'scatter', lumaB64: fx.lumaB64 });
    const hybrid = apply(fx, 'n-t', { mode: 'hybrid', lineShare: 0.8, lumaB64: fx.lumaB64 });
    expect(directionMedian(hybrid, fx)).toBeLessThan(directionMedian(scatter, fx));
  });
});

// ---------------------------------------------------------------- 贯穿面（colorFamily/降级/确定性/分发）

describe('P1.2 texture-fill 贯穿面', () => {
  const fx = loadFx('texture-costume');

  it('colorFamily 预留位：参数记录+warning 输出位（§10 回流 3——选色归 P3，本族 colorId 恒 \'\'）', () => {
    const r = apply(fx, 'n-t', { mode: 'scatter', lumaB64: fx.lumaB64, colorFamily: '红族' });
    expect(r.warnings.some((w) => w.detail.includes('colorFamily=红族'))).toBe(true);
    r.gems.forEach((g) => expect(g.colorId).toBe(''));
  });

  it('可读下限守卫：微小节点 <24 颗 → 声明式降级 engineStrategy（缺省 hex-pitch 可覆写）', () => {
    const bits = new Uint8Array(30 * 30);
    for (let y = 8; y < 22; y++) for (let x = 8; x < 22; x++) bits[y * 30 + x] = 1; // 14×14 岛 <1 钻距²×下限
    const tinyFx: Fixture = { ...fx, w: 30, h: 30, maskB64: Buffer.from(bits).toString('base64') };
    const r = apply(tinyFx, 'n-t', { mode: 'scatter' });
    expect(r.gems).toHaveLength(0);
    expect(r.engineStrategy?.engineStrategy).toBe('hex-pitch');
    expect(r.engineStrategy?.reason).toBe('geometry-min-size');
    const r2 = apply(tinyFx, 'n-t', { mode: 'scatter', fallbackEngineStrategy: 'poisson' });
    expect(r2.engineStrategy?.engineStrategy).toBe('poisson');
  });

  it('确定性：异 node 异果（seed=nodeId 派生——节点域可回放锚）', () => {
    const a = apply(fx, 'n-a', { mode: 'scatter', lumaB64: fx.lumaB64 });
    const b = apply(fx, 'n-b', { mode: 'scatter', lumaB64: fx.lumaB64 });
    expect(a.gems).not.toEqual(b.gems);
  });

  it('分发入口 applyStrategy(\'texture-fill\') 同产出（注册表路由面）', () => {
    const block = blockOf(fx, 'n-t');
    const viaRegistry = applyStrategy('texture-fill', { node: nodeOf(block), block, params: { mode: 'scatter', lumaB64: fx.lumaB64 }, canvas }, ctx);
    const direct = apply(fx, 'n-t', { mode: 'scatter', lumaB64: fx.lumaB64 });
    expect(viaRegistry.gems).toEqual(direct.gems);
  });
});
