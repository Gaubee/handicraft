/*
Orthogonal intents (max 3):
1. [2026-09-18 Production] SS 钻径查表 + pitch 推导（原始需求：tech-research §3.1，SS→mm 非线性永远查表，各品牌 ±0.1–0.2mm 出入）。
2. [2026-09-18 Units] gridFromSs 是 GridSpec 的标准构造入口（pitch = 钻径 + gap，gap 默认 0.4mm 可配）。
*/

import type { GridSpec, SSKey } from "./types";
import { SS_KEYS } from "./types";

/** SS6~SS34 名义直径 mm（研究文档实证锚点 + 常用对照表插值，精度 ±0.1–0.2mm） */
export const SS_TABLE = {
  SS6: 2.0,
  SS8: 2.4,
  SS10: 2.8,
  SS12: 3.0,
  SS14: 3.5,
  SS16: 4.0,
  SS18: 4.3,
  SS20: 4.8,
  SS22: 5.2,
  SS26: 5.8,
  SS30: 6.4,
  SS34: 7.1,
} as const satisfies Record<SSKey, number>;

export function ssDiameterMm(ss: SSKey): number {
  return SS_TABLE[ss];
}

/** pitch（钻心最小间距）= 钻径 + gap；gap 0.4–0.8mm 可调，默认 0.4（转移膜可干净拾取下限） */
export function pitchMmFromSs(ss: SSKey, gapMm = 0.4): number {
  return SS_TABLE[ss] + gapMm;
}

/** 标准网格构造：SS10 + 2.5px/mm → pitch 8px / 钻径 7px */
export function gridFromSs(ss: SSKey, pixelsPerMm: number, gapMm = 0.4): GridSpec {
  return { ss, pitchMm: pitchMmFromSs(ss, gapMm), rowAngleDeg: 0, pixelsPerMm };
}

/** pitch 的像素值——引擎内部所有几何都用 px */
export function pitchPx(grid: GridSpec): number {
  return grid.pitchMm * grid.pixelsPerMm;
}

/** 钻半径 px（SVG 导出画圆用） */
export function gemRadiusPx(grid: GridSpec): number {
  return (SS_TABLE[grid.ss] / 2) * grid.pixelsPerMm;
}

export type { SSKey };
export { SS_KEYS };
