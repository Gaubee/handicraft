/**
 * ΔE CIE76 纯函数（add-stone-library design §9——服务端不 import engine，
 * 双端一致由 color.test.ts 向量对拍 + 引擎源常量扫描锁死）。
 * 复制源：rhinestone-studio/src/lib/engine/color.ts（2026-09-24 抄录，逐算法行
 * 一致——labFromRgb/deltaE76 与内部辅助 srgbToLinear/fLab/D65 三元组）。
 * 纪律：本文件是引擎算法的镜像副本，**任何修改必须与 engine 同源同步**（禁单端
 * 漂移）；engine 的 rgbFromLab/fLabInv 未纳入（ΔE 链路不需要，不携死代码）。
 * 正交意图：[1] sRGB→CIELab(D65)；[2] CIE76 色差。
 */

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

function fLab(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
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

/** ΔE CIE76（Lab 欧氏距离） */
export function deltaE76(a: Lab, b: Lab): number {
  const dl = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}
