/*
Orthogonal intents (max 3):
1. [2026-09-18 ColorSpace] sRGB ↔ CIELab（D65）双向换算 + ΔE CIE76（tech-research §3.2：社区标准做法，447 色规模下 CIEDE2000 收益边际）。
2. [2026-09-18 Mapping] mapColors：块代表色 → 色板最近邻（区域级取色、无 dithering 的实证裁决）。
*/

import type { Block, Gem, Palette } from "./types";

export interface Lab {
  L: number;
  a: number;
  b: number;
}

const D65_X = 0.95047;
const D65_Y = 1.0;
const D65_Z = 1.08883;

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const lv = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(lv * 255)));
}

function fLab(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
}

function fLabInv(t: number): number {
  const t3 = t * t * t;
  return t3 > 216 / 24389 ? t3 : (116 * t - 16) / 903.3;
}

/** sRGB (0..255) → CIELab (D65) */
export function labFromRgb(r: number, g: number, b: number): Lab {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / D65_X;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) / D65_Y;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / D65_Z;
  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIELab → sRGB，超出色域逐通道钳制 */
export function rgbFromLab(lab: Lab): [number, number, number] {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const x = fLabInv(fx) * D65_X;
  const y = fLabInv(fy) * D65_Y;
  const z = fLabInv(fz) * D65_Z;
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}

/** ΔE CIE76（Lab 欧氏距离） */
export function deltaE76(a: Lab, b: Lab): number {
  const dl = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * 颜色映射：每个块的 colorRgb（中位色）→ 色板 Lab 最近邻，写回该块所有 Gem 的 colorId。
 * 约定：调用前 gems 已带 blockId；palette 为空抛错（无映射目标）。
 */
export function mapColors(gems: Gem[], blocks: Block[], palette: Palette): void {
  if (palette.length === 0) {
    throw new Error("mapColors: 色板为空，无法映射");
  }
  const paletteLabs = palette.map((c) => {
    const h = c.hex;
    const r = Number.parseInt(h.slice(1, 3), 16);
    const g = Number.parseInt(h.slice(3, 5), 16);
    const b = Number.parseInt(h.slice(5, 7), 16);
    return labFromRgb(r, g, b);
  });
  const blockById = new Map(blocks.map((blk, i) => [blk.id, i] as const));
  const cache = new Map<string, string>(); // blockId -> colorId（同块同色，一次 NN）
  for (const gem of gems) {
    const bi = blockById.get(gem.blockId);
    if (bi === undefined) {
      throw new Error(`mapColors: 钻 ${gem.id} 引用了不存在的块 ${gem.blockId}`);
    }
    let colorId = cache.get(gem.blockId);
    if (colorId === undefined) {
      const lab = labFromRgb(blocks[bi].colorRgb[0], blocks[bi].colorRgb[1], blocks[bi].colorRgb[2]);
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < paletteLabs.length; i++) {
        const d = deltaE76(lab, paletteLabs[i]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      colorId = palette[best].id;
      cache.set(gem.blockId, colorId);
    }
    gem.colorId = colorId;
  }
}
