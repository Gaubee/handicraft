/**
 * 四策略角度填充测试（Owner 统一理论 2026-10-02：「钻的角度=局部方向场的估计——
 * 线条=通用底座（切向最常用）；星/花/圆=几何拟合后的方向稳定化」）。
 *
 * 角度基准（探针锚定——texture-render.test「左右分色贴图转 90°=上下分色」先例同源）：
 *   渲染层 rotationDeg 语义=局部系绕钻心旋转（像素系 x 右 y 下、正向=屏幕顺时针——
 *   texture-render.ts drawRotatedTexture / gem-shapes.ts / render.ts 三处同式）；
 *   钻形正典朝向=局部 −y（BUILTIN_PATHS drop 尖 'M 0.5 0.02' 顶置 + engine Gem 注释
 *   「0=默认朝上」）。
 *   ⇒ 尖方向 (dx,dy) ↔ rotationDeg = atan2(dy,dx)·180/π + 90（mod 360——罗盘式：
 *      0=上 / 90=右 / 180=下 / 270=左）。
 *
 * 探针（上下分色贴图=尖端半红）：水平条→尖朝右（右半红）；垂直条→尖朝下（下半红）；
 * 30° 斜条→尖朝右下。90° 偏移错误（漏 +90）与镜像错误（atan2 取反）均会被三探针抓出。
 */
import { describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBlock, TreeMask2D } from '../src/kernel/vision/tree-to-blocks.js';
import { straightLineStrategy } from '../src/kernel/strategies/straight_line.js';
import { softCurveStrategy } from '../src/kernel/strategies/soft_curve.js';
import { flowerStrategy } from '../src/kernel/strategies/flower.js';
import { geometryStrategy } from '../src/kernel/strategies/geometry.js';
import { createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';
import { renderGemsTexturePng, type StoneTextureBytes } from '../src/png/texture-render.js';
import { decodePng, encodePng } from '../src/png/codec.js';
import type { Gem, GridSpec, Palette } from 'rhinestone-studio/engine';

const PPM = 10;
const GEM_PX = 30; // 3mm 钻
const DENSITY = 16; // s = max(30, 100/4) = 30
const canvas = { px: { width: 500, height: 400 }, cm: { w: 50, h: 40 }, pixelsPerMm: PPM };
const ctx: StrategyContext = createStrategyContext({ gemDiameterPx: GEM_PX, densityPerCm2: DENSITY });

// ---------------------------------------------------------------- 合成 block/node（策略测试同款脚手架）

function blockOf(id: string, w: number, h: number, bits: Uint8Array): TreeBlock {
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
    objectName: '角度基准节点',
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

/** 实心条掩膜（w×h 全 1）。 */
function barBits(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h).fill(1);
}

/** 旋转长条掩膜（长轴沿 deg——直线测试 rotatedBar 同构）。 */
function rotatedBarBits(w: number, h: number, deg: number, halfLen: number, halfWid: number): Uint8Array {
  const bits = new Uint8Array(w * h);
  const a = (deg * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * Math.cos(a) + dy * Math.sin(a);
      const v = -dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(u) <= halfLen && Math.abs(v) <= halfWid) bits[y * w + x] = 1;
    }
  }
  return bits;
}

// ---------------------------------------------------------------- 渲染探针脚手架

const PALETTE: Palette = [
  { id: 'red', name: '红', hex: '#C8102E' },
  { id: 'blue', name: '蓝', hex: '#102EC8' },
];
const GRID: GridSpec = { pitchMm: 3.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: PPM };
const RED: [number, number, number] = [220, 30, 30];
const BLUE: [number, number, number] = [30, 30, 220];

/** 上下分色贴图（上半=尖端半红、下半蓝——尖端在贴图顶部=局部 −y）。 */
function tipTexture(): StoneTextureBytes {
  const size = 32;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const c = y < size / 2 ? RED : BLUE;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
      rgba[p + 3] = 255;
    }
  }
  return { blobRef: 'tip-split', bytes: encodePng(size, size, rgba) };
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 单钻贴图渲染（策略产钻直接入渲染管线——rotationDeg 全链生效）。 */
function renderOne(g: { id: string; x: number; y: number; colorId: string; blockId: string; shapeId: string; diameterMm: number; rotationDeg?: number }): Decoded {
  const out = renderGemsTexturePng({
    gems: [g as Gem],
    palette: PALETTE,
    grid: GRID,
    width: canvas.px.width,
    height: canvas.px.height,
    resolveStoneTexture: () => tipTexture(),
  });
  expect(out.texturedCount).toBe(1);
  return decodePng(out.png);
}

function rgbAt(img: Decoded, x: number, y: number): [number, number, number] {
  const p = (y * img.width + x) * 4;
  return [img.rgba[p]!, img.rgba[p + 1]!, img.rgba[p + 2]!];
}

function isRed(c: [number, number, number]): boolean {
  return c[0] > 150 && c[2] < 100;
}

function isBlue(c: [number, number, number]): boolean {
  return c[2] > 150 && c[0] < 100;
}

/** 角度差（deg——[0,180] 无符号环距）。 */
function angDist(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** rotationDeg → 尖方向单位向量（罗盘式反解：(sinθ,−cosθ)）。 */
function tipDirOf(rotationDeg: number): { x: number; y: number } {
  const r = (rotationDeg * Math.PI) / 180;
  return { x: Math.sin(r), y: -Math.cos(r) };
}

// ---------------------------------------------------------------- [0] 探针：角度基准锚定（渲染实证）

describe('角度基准探针（straight-line → 贴图渲染——尖方向实证）', () => {
  it('水平条：全钻同角=90（主轴 0°+罗盘 90）→ 渲染尖端朝右（右半红/左半蓝）', () => {
    const block = blockOf('n-h', 160, 40, barBits(160, 40));
    const r = straightLineStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    // 刚硬同角：平行线族内所有钻同角
    const rots = new Set(r.gems.map((g) => g.rotationDeg));
    expect(rots.size).toBe(1);
    const rot = r.gems[0]!.rotationDeg!;
    expect(angDist(rot, 90)).toBeLessThan(1.5);
    // 渲染实证：局部 −y（尖端半红）经 90° 后指向 +x（屏幕右）
    const g = r.gems[Math.floor(r.gems.length / 2)]!;
    const img = renderOne(g);
    const gx = Math.round(g.x);
    const gy = Math.round(g.y);
    expect(isRed(rgbAt(img, gx + 8, gy))).toBe(true);
    expect(isBlue(rgbAt(img, gx - 8, gy))).toBe(true);
  });

  it('垂直条：全钻同角=180（主轴 90°+罗盘 90）→ 渲染尖端朝下（下半红/上半蓝）', () => {
    const block = blockOf('n-v', 40, 160, barBits(40, 160));
    const r = straightLineStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    const rot = r.gems[0]!.rotationDeg!;
    expect(r.gems.every((g) => g.rotationDeg === rot)).toBe(true);
    expect(angDist(rot, 180)).toBeLessThan(1.5);
    // 渲染实证：180° → 尖朝下（y+ 半红）——90° 偏移/镜像错误的联合抓捕位
    const g = r.gems[Math.floor(r.gems.length / 2)]!;
    const img = renderOne(g);
    const gx = Math.round(g.x);
    const gy = Math.round(g.y);
    expect(isRed(rgbAt(img, gx, gy + 8))).toBe(true);
    expect(isBlue(rgbAt(img, gx, gy - 8))).toBe(true);
  });

  it('30° 斜条：全钻同角=120 → 渲染尖端朝右下（镜像错误的抓捕位）', () => {
    const bits = rotatedBarBits(240, 160, 30, 100, 25);
    const block = blockOf('n-d', 240, 160, bits);
    const r = straightLineStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    const rot = r.gems[0]!.rotationDeg!;
    expect(r.gems.every((g) => g.rotationDeg === rot)).toBe(true);
    expect(angDist(rot, 120)).toBeLessThan(2);
    // 渲染实证：尖方向 (cos30,sin30) 右下 → 探针 ±8·(0.866,0.5)≈(±7,±4)
    const g = r.gems[Math.floor(r.gems.length / 2)]!;
    const img = renderOne(g);
    const gx = Math.round(g.x);
    const gy = Math.round(g.y);
    expect(isRed(rgbAt(img, gx + 7, gy + 4))).toBe(true);
    expect(isBlue(rgbAt(img, gx - 7, gy - 4))).toBe(true);
  });

  it('角度偏移透传：angleOffsetDeg=30 → 同角 120；−45 → 45（主轴+offset 全量）', () => {
    const mk = (angleOffsetDeg: number) => {
      const block = blockOf('n-o', 160, 40, barBits(160, 40));
      return straightLineStrategy.apply({ node: nodeOf(block), block, params: { angleOffsetDeg }, canvas }, ctx);
    };
    const a = mk(30);
    const b = mk(-45);
    expect(a.gems.length).toBeGreaterThanOrEqual(3);
    expect(b.gems.length).toBeGreaterThanOrEqual(3);
    expect(angDist(a.gems[0]!.rotationDeg!, 120)).toBeLessThan(1.5);
    expect(angDist(b.gems[0]!.rotationDeg!, 45)).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------- [1] soft_curve：切线角

describe('soft_curve 切线角（骨架切向——柔和跟随）', () => {
  it('水平条带：全部钻角 ≡ 90（mod 180）——沿线同向（渲染实证首尾钻红侧同侧）', () => {
    const block = blockOf('n-sc', 150, 21, barBits(150, 21));
    const r = softCurveStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      const m = ((g.rotationDeg! % 180) + 180) % 180;
      expect(Math.min(Math.abs(m - 90), 180 - Math.abs(m - 90))).toBeLessThan(2);
    });
    // 渲染同向：最左与最右钻的尖端红半在同一侧（分支链序确定——两钻同向或整体反向皆沿线）
    const sorted = [...r.gems].sort((a, b) => a.x - b.x);
    const lo = sorted[0]!;
    const hi = sorted[sorted.length - 1]!;
    const imgLo = renderOne(lo);
    const imgHi = renderOne(hi);
    const redRightLo = isRed(rgbAt(imgLo, Math.round(lo.x) + 8, Math.round(lo.y)));
    const redRightHi = isRed(rgbAt(imgHi, Math.round(hi.x) + 8, Math.round(hi.y)));
    expect(redRightLo).toBe(redRightHi);
  });

  it('四分之一圆弧带：尖方向 ⊥ 半径（切向跟随——弧上连续转向）', () => {
    // 第一象限环形带（95≤r≤104，弧心=掩膜原点→全局 (100,100)）
    const w = 106;
    const h = 106;
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const rr = Math.hypot(x, y);
        if (rr >= 95 && rr <= 104) bits[y * w + x] = 1;
      }
    }
    const block = blockOf('n-arc', w, h, bits);
    const r = softCurveStrategy.apply({ node: nodeOf(block), block, params: {}, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      const radX = g.x - 100;
      const radY = g.y - 100;
      const m = Math.hypot(radX, radY);
      const d = tipDirOf(g.rotationDeg!);
      // 切向 ⟺ 尖方向·半径单位向量 ≈ 0（容差吸收 ±30px 弧长窗弦切差 + 骨架像素噪声）
      expect(Math.abs(d.x * (radX / m) + d.y * (radY / m))).toBeLessThan(Math.sin((25 * Math.PI) / 180));
    });
  });
});

// ---------------------------------------------------------------- [2] flower：花瓣径向+花心切向

describe('flower 角度（花瓣径向「瓣尖朝外」+ 花心切向「环绕」）', () => {
  const W = 241;
  const H = 241;
  const R = 110;
  /** 六瓣玫瑰纹（flower 测试同款 r(θ)=R(0.62+0.38|cos3θ|)）。 */
  function rosetteBits(): Uint8Array {
    const bits = new Uint8Array(W * H);
    const cx = W / 2;
    const cy = H / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.hypot(dx, dy);
        const theta = Math.atan2(dy, dx);
        const rb = R * (0.62 + 0.38 * Math.abs(Math.cos(3 * theta)));
        if (r <= rb) bits[y * W + x] = 1;
      }
    }
    return bits;
  }

  it('花心环钻=切向（rot≡θ mod 180）；花瓣弧钻=径向（rot=θ+90）', () => {
    const bits = rosetteBits();
    const block = blockOf('n-fl', W, H, bits);
    const fctx: StrategyContext = createStrategyContext({ gemDiameterPx: GEM_PX, densityPerCm2: 4 });
    const r = flowerStrategy.apply(
      { node: nodeOf(block), block, params: { petalDensity: 2 }, canvas },
      fctx,
    );
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    // 花心=掩膜质心（策略同式重算）；花心/花瓣按 r 分类（core r=25、petal r=58——阈值 40）
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (bits[y * W + x] !== 1) continue;
        sx += x;
        sy += y;
        n++;
      }
    }
    const cx = 100 + sx / n;
    const cy = 100 + sy / n;
    let coreCount = 0;
    let petalCount = 0;
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      const theta = ((Math.atan2(g.y - cy, g.x - cx) * 180) / Math.PI + 360) % 360;
      const rad = Math.hypot(g.x - cx, g.y - cy);
      if (rad < 40) {
        coreCount++;
        expect(Math.min(angDist(g.rotationDeg!, theta), angDist(g.rotationDeg!, theta + 180))).toBeLessThan(0.01);
      } else {
        petalCount++;
        expect(angDist(g.rotationDeg!, theta + 90)).toBeLessThan(0.01);
      }
    });
    expect(coreCount).toBeGreaterThanOrEqual(1);
    expect(petalCount).toBeGreaterThanOrEqual(3);
  });

  it('花瓣径向发散（渲染实证）：东瓣尖朝右（右半红）、西瓣尖朝左（左半红）', () => {
    const bits = rosetteBits();
    const block = blockOf('n-fl2', W, H, bits);
    const fctx: StrategyContext = createStrategyContext({ gemDiameterPx: GEM_PX, densityPerCm2: 4 });
    const r = flowerStrategy.apply(
      { node: nodeOf(block), block, params: { petalDensity: 2 }, canvas },
      fctx,
    );
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (bits[y * W + x] !== 1) continue;
        sx += x;
        sy += y;
        n++;
      }
    }
    const cx = 100 + sx / n;
    const cy = 100 + sy / n;
    const petals = r.gems.filter((g) => Math.hypot(g.x - cx, g.y - cy) >= 40);
    const east = petals.reduce((a, b) => (b.x > a.x ? b : a));
    const west = petals.reduce((a, b) => (b.x < a.x ? b : a));
    const imgE = renderOne(east);
    const imgW = renderOne(west);
    expect(isRed(rgbAt(imgE, Math.round(east.x) + 8, Math.round(east.y)))).toBe(true); // 东瓣尖朝外=右
    expect(isBlue(rgbAt(imgE, Math.round(east.x) - 8, Math.round(east.y)))).toBe(true);
    expect(isRed(rgbAt(imgW, Math.round(west.x) - 8, Math.round(west.y)))).toBe(true); // 西瓣尖朝外=左
    expect(isBlue(rgbAt(imgW, Math.round(west.x) + 8, Math.round(west.y)))).toBe(true);
  });
});

// ---------------------------------------------------------------- [3] geometry：圆切向/星径向/矩椭螺旋切向/heart 缺省

describe('geometry 角度（圆环切向+星射线径向+矩/椭/螺旋轨迹切向+heart 不填）', () => {
  /** 实心圆盘掩膜。 */
  function diskBits(w: number, h: number, r: number): Uint8Array {
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x - w / 2) ** 2 + (y - h / 2) ** 2 <= r * r) bits[y * w + x] = 1;
      }
    }
    return bits;
  }

  function centroidOf(bits: Uint8Array, w: number, h: number): { x: number; y: number } {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (bits[y * w + x] !== 1) continue;
        sx += x;
        sy += y;
        n++;
      }
    }
    return { x: 100 + sx / n, y: 100 + sy / n };
  }

  it('circle：环钻=切向（rot=θ+180 解析精确）', () => {
    const bits = diskBits(121, 121, 55);
    const block = blockOf('n-ci', 121, 121, bits);
    const r = geometryStrategy.apply({ node: nodeOf(block), block, params: { shape: 'circle' }, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    const c = centroidOf(bits, 121, 121);
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      const theta = ((Math.atan2(g.y - c.y, g.x - c.x) * 180) / Math.PI + 360) % 360;
      expect(angDist(g.rotationDeg!, theta + 180)).toBeLessThan(0.001);
    });
  });

  it('star：射线钻=径向（rot=射线角+90；缺省 rotationDeg=270 → 首射线朝上钻尖朝上）', () => {
    const bits = diskBits(121, 121, 55);
    const block = blockOf('n-st', 121, 121, bits);
    const r = geometryStrategy.apply({ node: nodeOf(block), block, params: { shape: 'star', rays: 5 }, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    const c = centroidOf(bits, 121, 121);
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      const theta = ((Math.atan2(g.y - c.y, g.x - c.x) * 180) / Math.PI + 360) % 360;
      // 最近射线（星射线角 270+k·72——钻位在射线上）
      let bestK = 0;
      let bestD = 360;
      for (let k = 0; k < 5; k++) {
        const d = angDist(theta, (270 + k * 72) % 360);
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      }
      expect(bestD).toBeLessThan(0.01); // 钻在射线上
      expect(angDist(g.rotationDeg!, (270 + bestK * 72 + 90) % 360)).toBeLessThan(0.001); // 径向
    });
  });

  it('rect：回字环钻=边切向（rot 匹配所在边的行进方向——轴对齐四向）', () => {
    const bits = barBits(160, 100);
    const block = blockOf('n-re', 160, 100, bits);
    const r = geometryStrategy.apply({ node: nodeOf(block), block, params: { shape: 'rect' }, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(4);
    // 两圈回字环的边线（全局坐标）→ 切向罗盘角：水平边 90/270（顶边 +x/底边 −x）、
    // 垂直边 180/0（右边 +y 下/左边 −y 上）
    const lines: { horiz: boolean; at: number; compass: number }[] = [
      { horiz: true, at: 100, compass: 90 },
      { horiz: true, at: 200, compass: 270 },
      { horiz: false, at: 100, compass: 0 },
      { horiz: false, at: 260, compass: 180 },
      { horiz: true, at: 130, compass: 90 },
      { horiz: true, at: 170, compass: 270 },
      { horiz: false, at: 130, compass: 0 },
      { horiz: false, at: 230, compass: 180 },
    ];
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      const ok = lines.some((ln) => {
        const dist = ln.horiz ? Math.abs(g.y - ln.at) : Math.abs(g.x - ln.at);
        return dist < 0.5 && angDist(g.rotationDeg!, ln.compass) < 0.001;
      });
      expect(ok).toBe(true);
    });
  });

  it('ellipse：椭圆环钻=解析切向（参数 t 反解 ±1°）', () => {
    const bits = barBits(160, 100);
    const block = blockOf('n-el', 160, 100, bits);
    const r = geometryStrategy.apply({ node: nodeOf(block), block, params: { shape: 'ellipse' }, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(4);
    const center = { x: 180, y: 150 };
    const rings = [
      { a: 80, b: 50 },
      { a: 50, b: 20 },
    ];
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      // 环归属（椭圆方程残差最小者）
      const fit = rings.map(({ a, b }) => Math.abs(((g.x - center.x) / a) ** 2 + ((g.y - center.y) / b) ** 2 - 1));
      const ring = fit[0]! <= fit[1]! ? rings[0]! : rings[1]!;
      const t = Math.atan2((g.y - center.y) / ring.b, (g.x - center.x) / ring.a);
      const dirX = -ring.a * Math.sin(t);
      const dirY = ring.b * Math.cos(t);
      const expected = ((Math.atan2(dirY, dirX) * 180) / Math.PI + 90 + 360) % 360;
      expect(angDist(g.rotationDeg!, expected)).toBeLessThan(1);
    });
  });

  it('spiral：转迹切向（外圈 ±8°/内圈 ±25°——中心区 r→0 方向退化容差）', () => {
    const bits = diskBits(121, 121, 55);
    const block = blockOf('n-sp', 121, 121, bits);
    const r = geometryStrategy.apply(
      { node: nodeOf(block), block, params: { shape: 'spiral', turns: 1.5 }, canvas },
      ctx,
    );
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    const c = centroidOf(bits, 121, 121);
    const R = 45; // pitch=s=30（DENSITY=16）× turns 1.5
    const thetaMax = 3 * Math.PI;
    r.gems.forEach((g) => {
      expect(g.rotationDeg).toBeDefined();
      const rad = Math.hypot(g.x - c.x, g.y - c.y);
      if (rad < 5) return; // 中心区 r→0 方向数学退化（螺旋起点）——只要求有值
      const theta = (thetaMax * rad) / R;
      const drdth = R / thetaMax;
      const vx = drdth * Math.cos(theta) - rad * Math.sin(theta);
      const vy = drdth * Math.sin(theta) + rad * Math.cos(theta);
      const expected = ((Math.atan2(vy, vx) * 180) / Math.PI + 90 + 360) % 360;
      expect(angDist(g.rotationDeg!, expected)).toBeLessThan(8);
    });
  });

  it('heart：无极角结构不填角度（rotationDeg 缺席=optional 缺省保持）', () => {
    const bits = barBits(121, 121);
    const block = blockOf('n-he', 121, 121, bits);
    const r = geometryStrategy.apply({ node: nodeOf(block), block, params: { shape: 'heart' }, canvas }, ctx);
    expect(r.gems.length).toBeGreaterThanOrEqual(3);
    r.gems.forEach((g) => {
      expect('rotationDeg' in g).toBe(false);
      expect(g.rotationDeg).toBeUndefined();
    });
  });
});
