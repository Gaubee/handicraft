/**
 * 沿路径族 along-path 测试（close-paving-backlog T3.4——Owner 2026-09-21 路径预留兑现）。
 * 覆盖：参数 schema（缺省+superRefine custom⟂pathPts+strict 拒+界拒）+ outline 闭合环
 * 布点（等距/掩膜内/间距/切线角）+ 折线等弧长（custom 开路径——首点对齐+尾点守卫）+
 * 内缩缺省 0.5×钻径（钻心距边）+ custom 空路径 typed 拒 + 凹形掩码边界 + 短路径可读
 * 兜底降级 + 确定性 + 注册表分发等价。标度：PPM=10+3mm 钻（geometry 测试同标）。
 */
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock, TreeMask2D } from '../src/kernel/vision/tree-to-blocks.js';
import { MIN_READABLE_GEMS } from '../src/kernel/strategies/geometry.js';
import { AlongPathParamsSchema, alongPathStrategy } from '../src/kernel/strategies/along_path.js';
import { applyStrategy, createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';

const PPM = 10;
const GEM_PX = 30; // 3mm 钻
const S_PX = Math.max(GEM_PX, (10 * PPM) / Math.sqrt(2.3)); // ≈65.94

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

function applyPath(block: TreeBlock, params: unknown, context = ctx) {
  return alongPathStrategy.apply({ node: nodeOf(block), block, params, canvas: canvas(2000, 2000) }, context);
}

function inMaskSpec(mask: TreeMask2D, bbox: TreeBBox, x: number, y: number): boolean {
  const ix = Math.round(x) - bbox.x;
  const iy = Math.round(y) - bbox.y;
  if (ix < 0 || iy < 0 || ix >= mask.w || iy >= mask.h) return false;
  return mask.bits[iy * mask.w + ix] === 1;
}

/** 通用断言束：掩膜内+两两间距+基础字段。 */
function assertGems(result: ReturnType<typeof applyPath>, block: TreeBlock) {
  expect(result.gems.length).toBeGreaterThanOrEqual(MIN_READABLE_GEMS);
  result.gems.forEach((g) => {
    expect(inMaskSpec(block.mask, block.bbox, g.x, g.y)).toBe(true);
    expect(g.blockId).toBe(block.id);
    expect(g.shapeId).toBe('round');
    expect(g.diameterMm).toBeCloseTo(3, 6);
    expect(g.rotationDeg).toBeDefined();
  });
  for (let i = 0; i < result.gems.length; i++) {
    for (let j = i + 1; j < result.gems.length; j++) {
      const d = Math.hypot(result.gems[i]!.x - result.gems[j]!.x, result.gems[j]!.y - result.gems[i]!.y);
      expect(d).toBeGreaterThanOrEqual(GEM_PX * 0.99);
    }
  }
}

/** 环形（边框）掩膜：外盘 r1 挖内盘 r0——outline 模式的标准边框花环 fixture。 */
function ring(w: number, cx: number, cy: number, r0: number, r1: number): TreeBlock {
  return synthBlock('n-ring', w, w, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r >= r0 && r <= r1;
  });
}

// ---------------------------------------------------------------- 参数 schema

describe('along-path 参数 schema（Zod 冻结）', () => {
  it('缺省 pathSource=outline/closed=false/fallback=hex-pitch；strict 拒未知键', () => {
    expect(AlongPathParamsSchema.parse({})).toMatchObject({ pathSource: 'outline', closed: false, fallbackEngineStrategy: 'hex-pitch' });
    expect(() => AlongPathParamsSchema.parse({ nope: 1 })).toThrow();
  });

  it('superRefine：custom 空路径 typed 拒；outline 携 pathPts 拒；pathPts <2 点拒', () => {
    expect(() => AlongPathParamsSchema.parse({ pathSource: 'custom' })).toThrow(/pathPts/);
    expect(() => AlongPathParamsSchema.parse({ pathSource: 'custom', pathPts: [{ x: 0, y: 0 }] })).toThrow();
    expect(() => AlongPathParamsSchema.parse({ pathSource: 'outline', pathPts: [{ x: 0, y: 0 }, { x: 9, y: 9 }] })).toThrow(/outline/);
    expect(
      AlongPathParamsSchema.safeParse({ pathSource: 'custom', pathPts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }).success,
    ).toBe(true);
  });

  it('界拒：outlineInsetPx [0,500]/spacing (0,1e5]；node/block id 不一致防御', () => {
    expect(() => AlongPathParamsSchema.parse({ outlineInsetPx: -1 })).toThrow();
    expect(() => AlongPathParamsSchema.parse({ spacing: 0 })).toThrow();
    const block = ring(400, 200, 200, 150, 195);
    const node = { ...nodeOf(block), id: 'n-other' };
    expect(() => alongPathStrategy.apply({ node, block, params: {}, canvas: canvas(2000, 2000) }, ctx)).toThrow(/不一致/);
  });
});

// ---------------------------------------------------------------- outline 闭合环

describe('along-path outline（掩码边界等距线——边框花环承接）', () => {
  it('环形窄边掩码：闭环等距布点+切线角=路径切向（水平段角≈90/270——E 向切线罗盘角）', () => {
    const block = ring(400, 200, 200, 150, 195); // 环宽 45px：内缩 15px 后环心带布点
    const r = applyPath(block, { outlineInsetPx: 15, spacing: 40 });
    assertGems(r, block);
    // 闭环数量公式（像素阶梯周界 > 解析周界的栅格效应——±20% 容差）：
    // 内缩后周界 ≈2π·165≈1037px，步长 40 → n≈26
    const n = r.gems.length;
    expect(n).toBeGreaterThanOrEqual(Math.floor((2 * Math.PI * 165) / 40) * 0.8);
    expect(n).toBeLessThanOrEqual(Math.ceil((2 * Math.PI * 165) / 40) * 1.2);
    // 切线角抽查：环顶点（y 最小处）切向=±x → 罗盘角≈90 或 270
    const top = r.gems.reduce((a, b) => (a.y < b.y ? a : b));
    expect(Math.min(Math.abs(top.rotationDeg! - 90), Math.abs(top.rotationDeg! - 270))).toBeLessThan(10);
    // 确定性
    expect(applyPath(block, { outlineInsetPx: 15, spacing: 40 })).toEqual(r);
  });

  it('内缩缺省 0.5×钻径：方框掩码 outline 钻心距边 ≥inset/√2−2px（边框钻心不压边）', () => {
    const block = synthBlock('n-rect', 300, 200, () => true);
    const r = applyPath(block, {});
    assertGems(r, block);
    const inset = 0.5 * GEM_PX;
    // 每颗钻到最近背景像素的距离 ≥ inset/√2−2px——方角处边界切向=对角向，法向内缩后
    // 到两邻边的垂距=inset/√2（几何正解）；直边处=inset。
    const floor2 = inset / Math.SQRT2 - 2;
    for (const g of r.gems) {
      let minBg = Infinity;
      const ix = Math.round(g.x) - 100;
      const iy = Math.round(g.y) - 100;
      const reach = Math.ceil(inset) + 3;
      for (let dy = -reach; dy <= reach && minBg >= floor2; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const xx = ix + dx;
          const yy = iy + dy;
          const bg = xx < 0 || yy < 0 || xx >= 300 || yy >= 200 || block.mask.bits[yy * 300 + xx] === 0;
          if (bg) minBg = Math.min(minBg, Math.hypot(dx, dy));
        }
      }
      expect(minBg).toBeGreaterThanOrEqual(floor2);
    }
  });

  it('凹形掩码边界（L 形）：全部掩膜内+间距不变量（自交由判距门吸收）', () => {
    const block = synthBlock('n-lshape', 300, 300, (x, y) => (x < 100 ? true : y < 100));
    const r = applyPath(block, { outlineInsetPx: 8, spacing: 34 });
    assertGems(r, block);
    expect(r.engineStrategy).toBeUndefined();
  });

  it('短路径可读兜底：微型掩码 → 声明式降级（MIN_READABLE_GEMS 同款）', () => {
    const block = synthBlock('n-tiny', 30, 30, () => true); // 周界 ≈116px < 2 步
    const r = applyPath(block, {});
    expect(r.gems).toEqual([]);
    expect(r.engineStrategy?.reason).toBe('geometry-min-size');
    expect(r.engineStrategy?.engineStrategy).toBe('hex-pitch');
  });
});

// ---------------------------------------------------------------- custom 折线

describe('along-path custom（显式折线——画布坐标）', () => {
  it('开折线等弧长：首点对齐+点距=spacing（±1px）+尾点守卫（端点不缺钻）+切线角', () => {
    const block = synthBlock('n-band', 400, 120, () => true);
    // 画布坐标折线：水平线 y=160（bbox y=100 → 局部 y=60），长 360px
    const path = [
      { x: 100, y: 160 },
      { x: 460, y: 160 },
    ];
    const r = applyPath(block, { pathSource: 'custom', pathPts: path, spacing: 40 });
    expect(r.gems.length).toBeGreaterThanOrEqual(MIN_READABLE_GEMS);
    const xs = r.gems.map((g) => g.x).sort((a, b) => a - b);
    // 首点=路径起点（±0.5px）
    expect(xs[0]).toBeCloseTo(100, 0);
    // 相邻点距=40（±1px——插值浮点）
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i]! - xs[i - 1]! - 40)).toBeLessThanOrEqual(1.5);
    // 尾点守卫：360 恰为 40 整倍——resampleOpen t≤total 含终点（10 点含首尾），无补尾
    expect(xs.length).toBe(10);
    expect(xs[xs.length - 1]).toBeCloseTo(460, 0);
    // 水平路径切向=+x → 罗盘角 90
    r.gems.forEach((g) => expect(g.rotationDeg).toBeCloseTo(90, 5));
    expect(applyPath(block, { pathSource: 'custom', pathPts: path, spacing: 40 })).toEqual(r);
  });

  it('尾点守卫补尾：尾段剩余 ≥0.75×spacing 时路径终点有钻', () => {
    const block = synthBlock('n-band2', 400, 120, () => true);
    const path = [
      { x: 100, y: 160 },
      { x: 100 + 9 * 40 + 32, y: 160 }, // 长 392：尾段剩 32 ≥0.75×40=30 → 补尾点
    ];
    const r = applyPath(block, { pathSource: 'custom', pathPts: path, spacing: 40 });
    const xs = r.gems.map((g) => g.x);
    expect(Math.max(...xs)).toBeCloseTo(100 + 9 * 40 + 32, 0);
  });

  it('closed=true 闭合折线：resampleClosed 环布（末点回卷不重复）', () => {
    const block = synthBlock('n-sq', 400, 400, () => true);
    const square = [
      { x: 120, y: 120 },
      { x: 360, y: 120 },
      { x: 360, y: 360 },
      { x: 120, y: 360 },
    ];
    const r = applyPath(block, { pathSource: 'custom', pathPts: square, closed: true, spacing: 60 });
    assertGems(r, block);
    // 方框周界 960px/60=16 点（floor——resampleClosed 语义）
    expect(r.gems.length).toBe(16);
  });

  it('短折线降级 + 注册表分发等价', () => {
    const block = synthBlock('n-short', 300, 300, () => true);
    const short = applyPath(block, {
      pathSource: 'custom',
      pathPts: [
        { x: 100, y: 150 },
        { x: 190, y: 150 },
      ],
    }); // 弧长 90 < 2 步 → 降级
    expect(short.engineStrategy?.reason).toBe('geometry-min-size');
    const input = {
      node: nodeOf(block),
      block,
      params: { pathSource: 'outline', spacing: 40 },
      canvas: canvas(2000, 2000),
    };
    expect(applyStrategy('along-path', input, ctx)).toEqual(alongPathStrategy.apply(input, ctx));
  });
});
