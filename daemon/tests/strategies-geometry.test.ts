/**
 * 参数化几何族测试（add-subject-sam-pipeline design §4.1/§8——P1.1）。
 * 覆盖：六形状逐族参数 round-trip（Zod 冻结+缺省+strict 拒未知键+逐字段界拒）+
 * 确定性（同输入同输出——§4.4「同 seed 可回放」的参数化族形态）+ 点全在掩膜内
 * （预览不变量）+ 两两间距 ≥ 钻径（生成级切距自保证）+ 数量公式（填充族
 * count≈密度×面积；星=射线数×每射线颗数闭式；螺旋缺省螺距=π·匝数²闭式）+
 * §9 回流 4 可读下限守卫（不足→声明式降级 engineStrategy 通道+可配 fallback）+
 * 参数敏感度（改参改果）+ node/block id 一致性防御。
 * 标度：10 px/mm（PPM=10）+ 钻径 30px（3mm）+ 默认密度 2.3/cm²（Owner 定调）。
 */
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock, TreeMask2D } from '../src/kernel/vision/tree-to-blocks.js';
import {
  GeometryParamsSchema,
  MIN_READABLE_GEMS,
  STAR_MIN_PER_RAY,
  geometryStrategy,
} from '../src/kernel/strategies/geometry.js';
import { applyStrategy, createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';

const PPM = 10;
const GEM_PX = 30; // 3mm 钻
const S_PX = Math.max(GEM_PX, (10 * PPM) / Math.sqrt(2.3)); // ≈65.9381——密度 2.3/cm² 特征间距

/** 合成 TreeBlock（实心/自定义位图；origin 标注最小面——策略只消费几何+label/areaPx）。 */
function synthBlock(
  id: string,
  w: number,
  h: number,
  bit: (x: number, y: number) => boolean,
  bboxX = 100,
  bboxY = 100,
): TreeBlock {
  const bits = new Uint8Array(w * h);
  let areaPx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bit(x, y)) {
        bits[y * w + x] = 1;
        areaPx++;
      }
    }
  }
  return {
    id,
    label: `合成/${id}`,
    mask: { w, h, bits },
    colorRgb: [128, 128, 128],
    areaPx,
    bbox: { x: bboxX, y: bboxY, w, h },
    widthPx: { max: Math.min(w, h), mean: Math.min(w, h) / 2 },
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

const solid = (w: number, h: number, bx = 100, by = 100) =>
  synthBlock('n-solid', w, h, () => true, bx, by);

/** 圆盘掩膜（局部像素中心 (cx,cy) 半径 R 内为 1）。 */
const disk = (w: number, h: number, cx: number, cy: number, r: number, id = 'n-disk') =>
  synthBlock(id, w, h, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);

/** 契约 ObjectNode（mask 与 block 同几何——id 同寻址空间）。 */
function nodeOf(block: TreeBlock): ObjectNode {
  return ObjectNodeSchema.parse({
    id: block.id,
    objectName: '合成节点',
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

const canvas = (w: number, h: number) => ({
  px: { width: w, height: h },
  cm: { w: w / (PPM * 10), h: h / (PPM * 10) },
  pixelsPerMm: PPM,
});

const ctx: StrategyContext = createStrategyContext({ gemDiameterPx: GEM_PX });

function applyGeom(block: TreeBlock, params: unknown, context = ctx) {
  return geometryStrategy.apply({ node: nodeOf(block), block, params, canvas: canvas(2000, 2000) }, context);
}

/** 独立掩膜内判定（像素中心取整——测试侧规格复述，不引实现）。 */
function inMaskSpec(mask: TreeMask2D, bbox: TreeBBox, x: number, y: number): boolean {
  const ix = Math.round(x) - bbox.x;
  const iy = Math.round(y) - bbox.y;
  if (ix < 0 || iy < 0 || ix >= mask.w || iy >= mask.h) return false;
  return mask.bits[iy * mask.w + ix] === 1;
}

/** 通用断言束：掩膜内+两两间距+基础字段（shapeId/colorId/diameterMm/blockId/id 序）。 */
function assertGemsBlock(result: ReturnType<typeof applyGeom>, block: TreeBlock) {
  expect(result.gems.length).toBeGreaterThan(0);
  expect(result.engineStrategy).toBeUndefined();
  result.gems.forEach((g, i) => {
    expect(inMaskSpec(block.mask, block.bbox, g.x, g.y)).toBe(true);
    expect(g.blockId).toBe(block.id);
    expect(g.shapeId).toBe('round');
    expect(g.colorId).toBe('');
    expect(g.diameterMm).toBeCloseTo(3, 6);
    expect(g.id).toBe(`${block.id}#${String(i + 1).padStart(4, '0')}`);
  });
  const minD = GEM_PX * 0.999;
  for (let i = 0; i < result.gems.length; i++) {
    for (let j = i + 1; j < result.gems.length; j++) {
      const d = Math.hypot(result.gems[i]!.x - result.gems[j]!.x, result.gems[i]!.y - result.gems[j]!.y);
      expect(d).toBeGreaterThanOrEqual(minD);
    }
  }
}

describe('P1.1 参数 schema（Zod 冻结）', () => {
  it('六形状最小 JSON round-trip：缺省补全+二次 parse 幂等', () => {
    const minimals: Record<string, unknown> = {
      star: { shape: 'star' },
      heart: { shape: 'heart' },
      circle: { shape: 'circle' },
      rect: { shape: 'rect' },
      ellipse: { shape: 'ellipse' },
      spiral: { shape: 'spiral' },
    };
    for (const [shape, raw] of Object.entries(minimals)) {
      const parsed = GeometryParamsSchema.parse(raw);
      expect(parsed.shape).toBe(shape);
      expect(GeometryParamsSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed); // round-trip
    }
    expect(GeometryParamsSchema.parse({ shape: 'star' })).toEqual({
      shape: 'star',
      rays: 5,
      innerRadiusRatio: 0.4,
      rotationDeg: 270,
      fallbackEngineStrategy: 'hex-pitch',
    });
    expect(GeometryParamsSchema.parse({ shape: 'spiral' })).toEqual({
      shape: 'spiral',
      turns: 6,
      pitchMm: undefined,
      decay: 1,
      fallbackEngineStrategy: 'hex-pitch',
    });
  });

  it('strict+界拒：未知键/越界值/缺 shape/非法 fallback 全拒', () => {
    expect(() => GeometryParamsSchema.parse({ shape: 'circle', rays: 5 })).toThrow(); // strict
    expect(() => GeometryParamsSchema.parse({ shape: 'star', rays: 2 })).toThrow(); // min 3
    expect(() => GeometryParamsSchema.parse({ shape: 'star', innerRadiusRatio: 1 })).toThrow(); // lt 1
    expect(() => GeometryParamsSchema.parse({ shape: 'star', rotationDeg: -1 })).toThrow();
    expect(() => GeometryParamsSchema.parse({ shape: 'heart', dentDepth: 1.5 })).toThrow();
    expect(() => GeometryParamsSchema.parse({ shape: 'spiral', pitchMm: 0 })).toThrow();
    expect(() => GeometryParamsSchema.parse({ shape: 'blob' })).toThrow();
    expect(() => GeometryParamsSchema.parse({})).toThrow();
    expect(() => GeometryParamsSchema.parse({ shape: 'circle', fallbackEngineStrategy: 'hex' })).toThrow(); // 五值之外
  });

  it('fallbackEngineStrategy 五值全合法（引擎 hex 族透传）', () => {
    for (const id of ['hex-thin', 'hex-pitch', 'poisson', 'hybrid', 'cvt'] as const) {
      expect(GeometryParamsSchema.parse({ shape: 'circle', fallbackEngineStrategy: id }).fallbackEngineStrategy).toBe(id);
    }
  });
});

describe('P1.1 逐族布点（确定性+掩膜内+间距+数量公式）', () => {
  it('star：射线数×每射线颗数闭式（对角射线无裁剪）——rays=4/rot=45 精确断言', () => {
    const block = solid(1200, 1200);
    // 质心 (700,700)；R_max=hypot(600,600)（(100,100) 角像素——偶宽质心偏 0.5px 取远角）
    const rMax = Math.hypot(600, 600);
    const r0 = 0.4 * rMax;
    const perRay = Math.floor((rMax - r0) / S_PX) + 1;
    const r1 = applyGeom(block, { shape: 'star', rays: 4, rotationDeg: 45 });
    expect(r1.gems.length).toBe(4 * perRay);
    assertGemsBlock(r1, block);
    // 确定性：同输入同输出（逐位）
    const r2 = applyGeom(block, { shape: 'star', rays: 4, rotationDeg: 45 });
    expect(r2).toEqual(r1);
    // 参数敏感度：射线数 4→5 改果
    const r3 = applyGeom(block, { shape: 'star', rays: 5, rotationDeg: 45 });
    expect(r3.gems.length).not.toBe(r1.gems.length);
    // 初始角度敏感度：旋转 45→135 改坐标集
    const r4 = applyGeom(block, { shape: 'star', rays: 4, rotationDeg: 135 });
    expect(r4.gems.map((g) => `${g.x},${g.y}`)).not.toEqual(r1.gems.map((g) => `${g.x},${g.y}`));
  });

  it('circle：填充族数量公式 count≈密度×掩膜面积（±15%）', () => {
    const block = disk(1000, 1000, 500, 500, 500);
    const r = applyGeom(block, { shape: 'circle' });
    assertGemsBlock(r, block);
    const expected = 2.3 * (block.areaPx / (PPM * PPM * 100)); // 密度/cm² × 面积 cm²
    expect(Math.abs(r.gems.length / expected - 1)).toBeLessThanOrEqual(0.15);
    expect(applyGeom(block, { shape: 'circle' })).toEqual(r); // 确定性
  });

  it('rect：回字环填充 count≈密度×面积（±20%）', () => {
    const block = solid(1000, 1000);
    const r = applyGeom(block, { shape: 'rect' });
    assertGemsBlock(r, block);
    const expected = 2.3 * (block.areaPx / (PPM * PPM * 100));
    expect(Math.abs(r.gems.length / expected - 1)).toBeLessThanOrEqual(0.2);
    expect(applyGeom(block, { shape: 'rect' })).toEqual(r);
  });

  it('ellipse：椭圆环填充 count≈密度×面积（±20%）', () => {
    const block = solid(1200, 800, 0, 0); // 非方形 bbox——椭圆纵横比生效
    const r = applyGeom(block, { shape: 'ellipse' });
    assertGemsBlock(r, block);
    const expected = 2.3 * (block.areaPx / (PPM * PPM * 100));
    expect(Math.abs(r.gems.length / expected - 1)).toBeLessThanOrEqual(0.2);
    expect(applyGeom(block, { shape: 'ellipse' })).toEqual(r);
  });

  it('heart：嵌套缩心填充——数量/确定性/敏感度（凹陷深+宽高比各改果）', () => {
    const block = solid(900, 900);
    const r = applyGeom(block, { shape: 'heart' });
    assertGemsBlock(r, block);
    expect(r.gems.length).toBeGreaterThanOrEqual(MIN_READABLE_GEMS);
    const expected = 2.3 * (block.areaPx / (PPM * PPM * 100));
    expect(r.gems.length).toBeLessThanOrEqual(expected * 1.35); // 填充上界（心形裁角）
    expect(applyGeom(block, { shape: 'heart' })).toEqual(r);
    const dent = applyGeom(block, { shape: 'heart', dentDepth: 0.2 });
    expect(dent.gems.map((g) => `${g.x},${g.y}`)).not.toEqual(r.gems.map((g) => `${g.x},${g.y}`));
    const aspect = applyGeom(block, { shape: 'heart', aspectRatio: 0.8 });
    expect(aspect.gems.map((g) => `${g.x},${g.y}`)).not.toEqual(r.gems.map((g) => `${g.x},${g.y}`));
  });

  it('spiral：缺省螺距=密度间距 → count≈π·匝数²（±10%，足迹圆恰达目标密度）', () => {
    const block = disk(1000, 1000, 500, 500, 500);
    const turns = 6;
    const r = applyGeom(block, { shape: 'spiral', turns });
    assertGemsBlock(r, block);
    const expected = Math.PI * turns * turns;
    expect(Math.abs(r.gems.length / expected - 1)).toBeLessThanOrEqual(0.1);
    expect(applyGeom(block, { shape: 'spiral', turns })).toEqual(r);
    // 显式螺距+衰减：确定性+掩膜内+匝数敏感度
    const ex = applyGeom(block, { shape: 'spiral', turns: 5, pitchMm: 5, decay: 0.7 });
    assertGemsBlock(ex, block);
    expect(applyGeom(block, { shape: 'spiral', turns: 5, pitchMm: 5, decay: 0.7 })).toEqual(ex);
    const ex2 = applyGeom(block, { shape: 'spiral', turns: 8, pitchMm: 5, decay: 0.7 });
    expect(ex2.gems.length).toBeGreaterThan(ex.gems.length);
  });

  it('高密度上下文：间距下限=钻径（s<gemDiameterPx 时特征间距取钻径）', () => {
    const block = disk(1000, 1000, 500, 500, 500);
    const denseCtx = createStrategyContext({ gemDiameterPx: GEM_PX, densityPerCm2: 100 }); // s=100/10=10<30
    const r = applyGeom(block, { shape: 'circle' }, denseCtx);
    assertGemsBlock(r, block);
  });
});

describe('P1.1 §9 回流 4：可读下限守卫（声明式降级 engineStrategy 通道）', () => {
  it('circle 小节点：候选 < MIN_READABLE_GEMS → 零 Gem+degraded 警告+hex-pitch 降级', () => {
    const block = solid(60, 60); // R_max≈42px < s——仅 1 环 3 颗
    const r = applyGeom(block, { shape: 'circle' });
    expect(r.gems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.kind).toBe('degraded');
    expect(r.warnings[0]!.detail).toContain('hex-pitch');
    expect(r.engineStrategy).toEqual({
      engineStrategy: 'hex-pitch',
      reason: 'geometry-min-size',
      note: expect.stringContaining('circle'),
    });
    expect(applyGeom(block, { shape: 'circle' })).toEqual(r); // 降级路径同确定性
  });

  it('可配 fallback：hex-thin 透传', () => {
    const block = solid(60, 60);
    const r = applyGeom(block, { shape: 'circle', fallbackEngineStrategy: 'hex-thin' });
    expect(r.engineStrategy?.engineStrategy).toBe('hex-thin');
  });

  it('star 每射线下限：总颗数达标但每射线 < STAR_MIN_PER_RAY 仍降级', () => {
    const block = solid(1200, 1200);
    const r = applyGeom(block, { shape: 'star', rays: 40, innerRadiusRatio: 0.9, rotationDeg: 45 });
    const floor = Math.max(MIN_READABLE_GEMS, 40 * STAR_MIN_PER_RAY);
    expect(r.engineStrategy?.reason).toBe('geometry-min-size');
    expect(r.warnings[0]!.detail).toContain(String(floor));
    expect(r.gems).toEqual([]);
  });

  it('掩膜偏差大警告：圆环过半候选落在窄条掩膜外（仍足下限→mask 警告非降级）', () => {
    const block = synthBlock('n-bar', 200, 800, () => true, 100, 100); // 窄竖条：宽 200 高 800
    const r = applyGeom(block, { shape: 'circle' });
    expect(r.gems.length).toBeGreaterThanOrEqual(MIN_READABLE_GEMS); // 足下限不降级
    expect(r.engineStrategy).toBeUndefined();
    expect(r.warnings.some((w) => w.kind === 'mask')).toBe(true);
    assertGemsBlock(r, block);
  });
});

describe('P1.1 防御与分发', () => {
  it('node/block id 不一致 → 显式抛（P0.2 同寻址空间契约）', () => {
    const block = solid(300, 300);
    const node = { ...nodeOf(block), id: 'n-other' };
    expect(() =>
      geometryStrategy.apply({ node, block, params: { shape: 'circle' }, canvas: canvas(2000, 2000) }, ctx),
    ).toThrow(/不一致/);
  });

  it('params 非法 → Zod fail-fast（P3 捕获回 LLM 有界重试）', () => {
    const block = solid(300, 300);
    expect(() => applyGeom(block, { shape: 'circle', extra: 1 })).toThrow();
    expect(() => applyGeom(block, { shape: 'star', rays: 'many' })).toThrow();
  });

  it('注册表分发等价：applyStrategy(kind=geometry) = geometryStrategy.apply', () => {
    const block = disk(600, 600, 300, 300, 300);
    const input = { node: nodeOf(block), block, params: { shape: 'circle' }, canvas: canvas(1200, 1200) };
    expect(applyStrategy('geometry', input, ctx)).toEqual(geometryStrategy.apply(input, ctx));
  });
});
