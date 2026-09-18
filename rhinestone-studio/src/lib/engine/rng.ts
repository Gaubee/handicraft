/*
Orthogonal intents (max 3):
1. [2026-09-18 Determinism] 全引擎唯一随机源：mulberry32 PRNG + 整数坐标哈希（同 seed 逐位重放，禁 Math.random）。
2. [2026-09-18 Algorithm] 相干 value noise：hex-thin 的 RIPD 式蓝噪声抽稀按"噪声值 < 密度"保留（阈值单调 → 密度嵌套 → 钻数单调）。
*/

/** mulberry32：32bit 可复现 PRNG，返回 [0,1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二维整数坐标 → [0,1)（点级稳定哈希：与遍历顺序无关，保证按点判定与密度嵌套） */
export function hash01(x: number, y: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x + 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (y + 0xc2b2ae3d), 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 相干 value noise（平滑双线性插值，cell = 噪声晶格尺寸）。
 * hex-thin 抽稀：keep ⟺ valueNoise(p) < density —— 阈值连续单调，
 * 低密度点集是高密度点集的子集（不变量 4 的构造来源）。
 */
export function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash01(gx, gy, seed);
  const n10 = hash01(gx + 1, gy, seed);
  const n01 = hash01(gx, gy + 1, seed);
  const n11 = hash01(gx + 1, gy + 1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/** 种子混合：为"每块独立 PRNG"派生子种子，块 A 的密度变化不影响块 B 的随机序列（B 钻数稳定的构造来源） */
export function mixSeed(seed: number, blockIndex: number, tag: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (blockIndex + 0x165667b1), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h ^ (tag + 0x27d4eb2f), 0x85ebca77);
  h ^= h >>> 13;
  return h >>> 0;
}
