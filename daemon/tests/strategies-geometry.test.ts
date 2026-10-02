/**
 * 参数化几何族测试（add-subject-sam-pipeline design §4.1/§8——P1.1）。
 * 覆盖：六形状逐族参数 round-trip（Zod 冻结+缺省+strict 拒未知键+逐字段界拒）+
 * 确定性（同输入同输出——§4.4「同 seed 可回放」的参数化族形态）+ 点全在掩膜内
 * （预览不变量）+ 两两间距 ≥ 钻径（生成级切距自保证）+ 数量公式（填充族
 * count≈密度×面积；星=射线数×每射线颗数闭式；螺旋缺省螺距=π·匝数²闭式）+
 * §9 回流 4 可读兜底下限守卫（<3 颗极小产出→声明式降级 engineStrategy 通道+可配
 * fallback——2026-10-01 真链走查 P1 修正：声明密度优先，小部位颗数少是正确结果）+
 * 参数敏感度（改参改果）+ node/block id 一致性防御。
 * 标度：10 px/mm（PPM=10）+ 钻径 30px（3mm）+ 默认密度 2.3/cm²（Owner 定调）。
 */
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock, TreeMask2D } from '../src/kernel/vision/tree-to-blocks.js';
import {
  GeometryParamsSchema,
  MIN_READABLE_GEMS,
  geometryStrategy,
} from '../src/kernel/strategies/geometry.js';
import { radialSignatureAndPetals, signatureAt } from '../src/kernel/strategies/radial_signature.js';
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
      rays: undefined, // T1：缺省=径向签名峰数自动检测（不再是 legacy 常量 5）
      innerRadiusRatio: 0.4,
      rotationDeg: 270,
      sparseness: 1, // T1：沿射线步长倍数（缺省 1=现状间距）
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
  it('star：射线数×每射线颗数闭式（r(θ) 调制界——T1 升级后按逐角签名收短）——rays=4/rot=45 精确断言', () => {
    const block = solid(1200, 1200);
    // 质心 (700,700)；R_max=hypot(600,600)（(100,100) 角像素——偶宽质心偏 0.5px 取远角）；
    // T1：步进上界=min(sig(θ)×0.98, rMax)（径向签名共享件——方形掩膜对角向 sig<角落 rMax，
    // 期望计数按同一签名真源推导：闭式=掩膜过滤/间距门**零剔除**的管线不变量）
    const rMax = Math.hypot(600, 600);
    const r0 = 0.4 * rMax;
    const { sig } = radialSignatureAndPetals(block.mask, 700 - 100, 700 - 100);
    const bound45 = Math.min(signatureAt(sig, (45 * Math.PI) / 180) * 0.98, rMax);
    const perRay = Math.floor((bound45 - r0) / S_PX) + 1;
    const r1 = applyGeom(block, { shape: 'star', rays: 4, rotationDeg: 45 });
    expect(perRay).toBeGreaterThan(0);
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

describe('可读兜底下限守卫（真链走查 P1 修正：声明密度优先——<3 颗极小产出才降级）', () => {
  it('circle 小节点但 ≥3 颗（1 环 3 颗）：声明密度优先——保形自产钻不降级', () => {
    const block = solid(68, 68); // R_max≈48px：仅 1 环 3 颗全落掩膜内（旧 24 下限会强制降级 hex）
    const r = applyGeom(block, { shape: 'circle' });
    expect(r.gems).toHaveLength(3); // 3 颗就是 3 颗（Owner 心算口径）
    expect(r.engineStrategy).toBeUndefined();
    expect(r.warnings.some((w) => w.kind === 'degraded')).toBe(false);
    assertGemsBlock(r, block);
    expect(applyGeom(block, { shape: 'circle' })).toEqual(r); // 确定性
  });

  it('circle 极小节点（0 颗 <3）：零 Gem+degraded 警告+hex-pitch 降级（warning 如实说明兜底）', () => {
    const block = solid(40, 40); // R_max≈28px < 首环 33px——零环 0 颗
    const r = applyGeom(block, { shape: 'circle' });
    expect(r.gems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.kind).toBe('degraded');
    expect(r.warnings[0]!.detail).toContain('hex-pitch');
    expect(r.warnings[0]!.detail).toContain('目标密度不变'); // warning 如实：仅形态兜底
    expect(r.engineStrategy).toEqual({
      engineStrategy: 'hex-pitch',
      reason: 'geometry-min-size',
      note: expect.stringContaining('circle'),
    });
    expect(applyGeom(block, { shape: 'circle' })).toEqual(r); // 降级路径同确定性
  });

  it('可配 fallback：hex-thin 透传', () => {
    const block = solid(40, 40);
    const r = applyGeom(block, { shape: 'circle', fallbackEngineStrategy: 'hex-thin' });
    expect(r.engineStrategy?.engineStrategy).toBe('hex-thin');
  });

  it('star 每射线 <3 颗但总数 ≥3：保形自产钻不降级（旧 per-ray 降级规则废止）', () => {
    const block = solid(1200, 1200);
    // T1 后 r(θ) 调制使轴向射线收短——innerRadiusRatio 0.9 会整射线归零（sig(0°)×0.98<r0），
    // 0.7 下每射线 1-4 颗、总数远超 3：保形自产钻不降级语义不变。
    const r = applyGeom(block, { shape: 'star', rays: 40, innerRadiusRatio: 0.7, rotationDeg: 45 });
    expect(r.engineStrategy).toBeUndefined(); // 每射线仅 1-4 颗、总数 ~100——声明密度优先保星形
    expect(r.gems.length).toBeGreaterThanOrEqual(MIN_READABLE_GEMS);
    assertGemsBlock(r, block);
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

// ---------------------------------------------------------------- T1 star 原位升级（close-paving-backlog）

/**
 * 闭式合成凹五角星掩膜（星形多边形——尖在外 rOuter、凹谷在内 rInner，5 尖 5 谷）。
 * 中心对称（质心=星心）——径向签名峰数=5 的闭式 fixture。
 */
function pentagramMask(w: number, h: number, rOuter: number, rInner: number, rotDeg = -90): Uint8Array {
  const bits = new Uint8Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const vertices: { x: number; y: number }[] = [];
  for (let k = 0; k < 10; k++) {
    // 顶点交错外径/内径（10 顶点星形多边形——5 尖+5 谷）
    const r = k % 2 === 0 ? rOuter : rInner;
    const theta = ((rotDeg + (k * 360) / 10) * Math.PI) / 180;
    vertices.push({ x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) });
  }
  // 多边形栅格化（even-odd 扫描线）
  for (let y = 0; y < h; y++) {
    const xs: number[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!;
      const b = vertices[(i + 1) % vertices.length]!;
      if (a.y === b.y) continue;
      const yy = y + 0.5;
      if (yy < Math.min(a.y, b.y) || yy >= Math.max(a.y, b.y)) continue;
      xs.push(a.x + ((yy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let j = 0; j + 1 < xs.length; j += 2) {
      for (let x = Math.ceil(xs[j]! - 0.5); x <= Math.floor(xs[j + 1]! - 0.5); x++) {
        if (x >= 0 && x < w) bits[y * w + x] = 1;
      }
    }
  }
  return bits;
}

describe('T1 star 原位升级（r(θ) 调制/峰数检测/圆心偏移/稀疏倍数/质心外退路）', () => {
  const W = 401;
  const R_OUT = 190;
  const R_IN = 78; // 深凹五角星（凹谷半径 ≈0.41×尖半径——凹口显著）
  const starBits = pentagramMask(W, W, R_OUT, R_IN);
  const starBlock = synthBlock('n-star5', W, W, (x, y) => starBits[y * W + x] === 1);

  it('峰数自动检测：凹五角星缺省 rays=5（不写 rays——检测即星角数）', () => {
    const { detected } = radialSignatureAndPetals(starBlock.mask, W / 2, W / 2);
    expect(detected).toBe(5);
    // 缺省 rays（params 不带 rays）→ 自动检测 5 条射线：每尖一条主轴链
    const r = applyGeom(starBlock, { shape: 'star', innerRadiusRatio: 0.15 });
    expect(r.gems.length).toBeGreaterThan(0);
    expect(r.engineStrategy).toBeUndefined();
    assertGemsBlock(r, starBlock);
    // 五尖方向（270°+k·72°）均有钻到达且越出凹谷半径（尖区布点——非谷向截断）
    for (let k = 0; k < 5; k++) {
      const theta = ((270 + k * 72) * Math.PI) / 180;
      const onRay = r.gems.filter((g) => {
        const dx = g.x - 100 - W / 2;
        const dy = g.y - 100 - W / 2;
        const ang = Math.atan2(dy, dx);
        let d = Math.abs(ang - theta) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        return d < 0.06;
      });
      expect(onRay.length).toBeGreaterThan(0);
      expect(Math.max(...onRay.map((g) => Math.hypot(g.x - 100 - W / 2, g.y - 100 - W / 2)))).toBeGreaterThan(R_IN + 5);
    }
  });

  it('凹口射线收短（r(θ) 调制）：每颗钻半径 ≤ 其方向签名×0.98（无穿出候选）+射线链连续无岛点', () => {
    const r = applyGeom(starBlock, { shape: 'star', rays: 5, rotationDeg: 270, innerRadiusRatio: 0.15 });
    expect(r.gems.length).toBeGreaterThan(0);
    const { sig } = radialSignatureAndPetals(starBlock.mask, W / 2, W / 2);
    for (const g of r.gems) {
      const dx = g.x - 100 - W / 2;
      const dy = g.y - 100 - W / 2;
      const radius = Math.hypot(dx, dy);
      const bound = Math.min(signatureAt(sig, Math.atan2(dy, dx)) * 0.98, R_OUT + 1);
      expect(radius).toBeLessThanOrEqual(bound + 0.5); // 调制界成立——无钻越其方向边界（穿出岛点杜绝）
    }
    // 岛链断言：每条射线（270°+k·72°±3°）的钻按半径排序后相邻间隙 ≤1.5×步长
    // （「穿出再穿入」会产生 >1 步长的半径断档——岛链；步长≈65.94px @ 密度 2.3/钻 3mm）
    const S = Math.max(GEM_PX, (10 * PPM) / Math.sqrt(2.3));
    for (let k = 0; k < 5; k++) {
      const theta = ((270 + k * 72) * Math.PI) / 180;
      const onRay = r.gems
        .filter((g) => {
          const dx = g.x - 100 - W / 2;
          const dy = g.y - 100 - W / 2;
          let d = Math.abs(Math.atan2(dy, dx) - theta) % (2 * Math.PI);
          if (d > Math.PI) d = 2 * Math.PI - d;
          return d < 0.055;
        })
        .map((g) => Math.hypot(g.x - 100 - W / 2, g.y - 100 - W / 2))
        .sort((a, b) => a - b);
      for (let i = 1; i < onRay.length; i++) {
        expect(onRay[i]! - onRay[i - 1]!).toBeLessThanOrEqual(1.5 * S);
      }
    }
    // 凹口方向（270°+36°+k·72°）最远钻 ≤ 凹谷半径+1 步长（射线收短的调制生效面）
    for (let k = 0; k < 5; k++) {
      const theta = ((270 + 36 + k * 72) * Math.PI) / 180;
      const notchGems = r.gems.filter((g) => {
        const dx = g.x - 100 - W / 2;
        const dy = g.y - 100 - W / 2;
        let d = Math.abs(Math.atan2(dy, dx) - theta) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        return d < 0.05;
      });
      if (notchGems.length === 0) continue;
      expect(Math.max(...notchGems.map((g) => Math.hypot(g.x - 100 - W / 2, g.y - 100 - W / 2)))).toBeLessThan(R_IN + 1.2 * S);
    }
  });

  it('四参数显式覆写：rays/rotationDeg/centerOffsetPx/sparseness 各改果', () => {
    const base = applyGeom(starBlock, { shape: 'star', rays: 5, rotationDeg: 270, innerRadiusRatio: 0.15 });
    // sparseness=2：步长倍增 → 同射线颗数减半（±1 容差——边界步取舍）
    const sparse = applyGeom(starBlock, { shape: 'star', rays: 5, rotationDeg: 270, innerRadiusRatio: 0.15, sparseness: 2 });
    expect(sparse.gems.length).toBeLessThan(base.gems.length);
    expect(sparse.gems.length).toBeGreaterThanOrEqual(Math.floor(base.gems.length / 2) - 1);
    // centerOffsetPx：圆心右移 40px → 坐标集改变（掩膜过滤吸收越界侧）
    const shifted = applyGeom(starBlock, {
      shape: 'star', rays: 5, rotationDeg: 270, innerRadiusRatio: 0.15, centerOffsetPx: { x: 40, y: 0 },
    });
    expect(shifted.gems.map((g) => `${g.x},${g.y}`)).not.toEqual(base.gems.map((g) => `${g.x},${g.y}`));
    // rotationDeg 旋转 36°（尖→谷）→ 谷向射线收短：最远钻半径显著变小
    const rotated = applyGeom(starBlock, { shape: 'star', rays: 5, rotationDeg: 306, innerRadiusRatio: 0.15 });
    const maxR = (r: ReturnType<typeof applyGeom>) => Math.max(...r.gems.map((g) => Math.hypot(g.x - 100 - W / 2, g.y - 100 - W / 2)));
    expect(maxR(rotated)).toBeLessThan(maxR(base) - 40);
    // 界拒：sparseness [0.2,5] 外拒（schema 冻结面）
    expect(() => GeometryParamsSchema.parse({ shape: 'star', sparseness: 5.1 })).toThrow();
    expect(() => GeometryParamsSchema.parse({ shape: 'star', centerOffsetPx: { x: 1, z: 2 } })).toThrow();
    const sparsed = GeometryParamsSchema.parse({ shape: 'star', sparseness: 0.2 });
    expect(sparsed.shape === 'star' ? sparsed.sparseness : undefined).toBe(0.2);
  });

  it('质心落掩膜外退路：C 形掩膜（质心落口部）→ 最大内切圆心近似+geometry warning', () => {
    // C 形掩膜：大圆盘（r=145）挖去右侧偏心圆（心 (210,150) r=140——口部朝右）——
    // 数值实证质心 ≈(69.9,150) 落挖空区（下方断言把守）
    const w = 301;
    const cBits = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const inDisk = (x - 150) ** 2 + (y - 150) ** 2 <= 145 * 145;
        const inHole = (x - 210) ** 2 + (y - 150) ** 2 <= 140 * 140;
        if (inDisk && !inHole) cBits[y * w + x] = 1;
      }
    }
    const cBlock = synthBlock('n-cshape', w, w, (x, y) => cBits[y * w + x] === 1);
    // 质心确实落掩膜外（退路触发前提）
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        if (cBits[y * w + x] === 1) {
          sx += x;
          sy += y;
          n++;
        }
    expect(cBits[Math.round(sy / n) * w + Math.round(sx / n)] ?? 0).toBe(0);
    const r = applyGeom(cBlock, { shape: 'star', rays: 8, innerRadiusRatio: 0.2, rotationDeg: 0 });
    expect(r.warnings.some((warn) => warn.kind === 'geometry' && warn.detail.includes('最大内切圆心近似'))).toBe(true);
    assertGemsBlock(r, cBlock);
    // 全部钻仍在掩膜内且星结构以近似圆心放射（assertGemsBlock 已含掩膜断言）
    expect(r.gems.length).toBeGreaterThanOrEqual(MIN_READABLE_GEMS);
  });
});
