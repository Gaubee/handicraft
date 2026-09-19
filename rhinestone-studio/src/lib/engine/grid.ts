/*
Orthogonal intents:
1. [2026-09-18 Production] SS 钻径查表 + pitch 推导（原始需求：tech-research §3.1，SS→mm 非线性永远查表，各品牌 ±0.1–0.2mm 出入）。
2. [2026-09-20 Contract / gem-catalog W0 0.1] GridSpec v2 派生化：`gridFromSpec(spec, gapMm, pixelsPerMm)`
   是**标准构造入口**（pitch = BaseSpec.diameterMm + gap，不写 v1 过渡键 ss）；
   `gridFromSs` 降位为圆钻特例构造入口（SS_TABLE 查表不变，携带 v1 过渡读面 ss 供未迁移消费者）。
3. [2026-09-20 Bootstrap / W0 0.6] SS_TABLE 同时是四格式 v1→v2 迁移的直径查表 bootstrap
   （迁移是纯函数，不能读 IDB 素材库——design §1.6）；目录真源是素材库 .gemshape 资产，本表不是。
*/

import type { BaseSpec } from "./spec";
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

/**
 * **GridSpec v2 标准构造入口**（design §1.1）：由 BaseSpec 派生几何上下文——
 * pitchMm = diameterMm + gapMm（diameterMm 是间距与渲染的唯一物理依据）；
 * 不写 v1 过渡键 `ss`（等径圆钻下与 gridFromSs 结果除 ss 外逐字段相等）。
 */
export function gridFromSpec(spec: BaseSpec, gapMm: number, pixelsPerMm: number): GridSpec {
  return {
    pitchMm: spec.diameterMm + gapMm,
    gapMm,
    rowAngleDeg: 0,
    pixelsPerMm,
  };
}

/**
 * 圆钻特例构造入口（降位，W0 0.1）：SS_TABLE 查表直径 → BaseSpec 语义；
 * 携带 v1 过渡读面 `ss`（GridSpec.ss @deprecated——未迁移消费者见
 * GRIDSPEC_SS_MIGRATION_CHECKLIST，engine gate 1.3/1.4 迁移后随字段删除）。
 */
export function gridFromSs(ss: SSKey, pixelsPerMm: number, gapMm = 0.4): GridSpec {
  return { ss, pitchMm: pitchMmFromSs(ss, gapMm), gapMm, rowAngleDeg: 0, pixelsPerMm };
}

/** pitch 的像素值——引擎内部所有几何都用 px */
export function pitchPx(grid: GridSpec): number {
  return grid.pitchMm * grid.pixelsPerMm;
}

/**
 * grid 基准规格直径（mm）：`pitchMm − gapMm` 的量化回推（1e-6——消浮点回推 ULP 尾差，
 * 使 gridFromSs/gridFromSpec 构造式下与原 BaseSpec.diameterMm 逐位相等）。
 * 消费面：规格字段缺席钻的判距兜底（geometry.effectiveSpecOf）/ makeGem 规格物化戳
 * （tasks 1.4）/ gemRadiusPx 过渡重载（tasks 1.3）。
 */
export function baseSpecDiameterMm(grid: GridSpec): number {
  return Math.round((grid.pitchMm - grid.gapMm) * 1e6) / 1e6;
}

/**
 * 钻半径 px（SVG 导出画圆用）。v1 签名（单 grid 参数，SS_TABLE[grid.ss]）——
 * engine gate 1.3 迁移为逐钻 `gemRadiusPx(gem, grid)`；v2 GridSpec 的 ss 为可选过渡键，
 * 缺席（gridFromSpec 产物/非圆钻）时显式报错，不静默猜值。
 */
export function gemRadiusPx(grid: GridSpec): number {
  const ss = grid.ss;
  if (ss === undefined) {
    throw new Error("gemRadiusPx: v2 GridSpec 无 ss（gridFromSpec 产物/非圆钻）——1.3 迁移为逐钻签名 gemRadiusPx(gem, grid)");
  }
  return (SS_TABLE[ss] / 2) * grid.pixelsPerMm;
}

export type { SSKey };
export { SS_KEYS };
