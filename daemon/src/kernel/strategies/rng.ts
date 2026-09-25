/**
 * 内核策略确定性随机源（add-subject-sam-pipeline P1.5——StrategyContext.rng 默认实现）。
 *
 * 引擎红线纪律：**不 import 不改动** rhinestone-studio/engine——mulberry32/mixSeed 按引擎
 * rng.ts 已文档语义同构自实现（算法逐行同构；非逐位对拍——引擎输入域（块索引/tag 整数）
 * 与内核输入域（nodeId 字符串）不同，等价性由「文档语义抄录」纪律保证，同 P0.2 EDT 先例）。
 *
 * 确定性契约（design §4.4「同代码+同 seed 可回放」）：同 seed 逐位同序列；禁 Math.random。
 */
export type RngFactory = (seed: number) => () => number;

/** mulberry32：32bit 可复现 PRNG，返回 [0,1)（引擎 rng.ts 同构）。 */
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

/** 种子混合（引擎 rng.ts mixSeed 同构——整数域派生子种子，互扰最小化）。 */
export function mixSeed(seed: number, a: number, b: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (a + 0x165667b1), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h ^ (b + 0x27d4eb2f), 0x85ebca77);
  h ^= h >>> 13;
  return h >>> 0;
}

/** FNV-1a 32bit：字符串 → 32bit 种子（nodeId→seed 派生——内核节点域确定性锚）。 */
export function stringToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
