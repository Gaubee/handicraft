/*
Orthogonal intents:
1. [2026-09-18 Production] SS 钻径查表 + pitch 推导（原始需求：tech-research §3.1，SS→mm 非线性永远查表，各品牌 ±0.1–0.2mm 出入）。
2. [2026-09-20 Contract / gem-catalog W0 0.1 + engine gate 1.4] GridSpec v2 派生化：
   `gridFromSpec(spec, gapMm, pixelsPerMm)` 是**标准构造入口**（pitch = BaseSpec.diameterMm + gap）；
   `gridFromSs` 降位为圆钻特例构造入口（SS_TABLE 查表不变；v1 过渡键 ss 已随 engine gate
   1.3/1.4 消费者迁移清零删除，产物与 gridFromSpec(round, …) 逐字段相等）。
3. [2026-09-20 Bootstrap / W0 0.6] SS_TABLE 同时是四格式 v1→v2 迁移的直径查表 bootstrap
   （迁移是纯函数，不能读 IDB 素材库——design §1.6）；目录真源是素材库 .gemshape 资产，本表不是。
*/

import type { BaseSpec } from "./spec";
import type { GridSpec, SSKey } from "./types";
import { SS_KEYS } from "./types";

/**
 * SS6~SS34 名义直径 mm（研究文档实证锚点 + 常用对照表插值，精度 ±0.1–0.2mm）。
 * [2026-09-20 gem-catalog 2.1] SS24 补档 5.3mm（行业标准，中置信——design §3.1）：
 * **同参同出不 bump**——既有档位数值零变化，SS24 仅新增可选档（specKey round-ss24 随
 * SS_KEYS 进 ROUND_SS_BOOTSTRAP，保持 5.3mm 圆钻 canonical 身份链一致），不构成强制
 * ENGINE_VERSION bump（version.ts 纪律注释登记）。
 */
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
  SS24: 5.3,
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
 * 圆钻特例构造入口（降位，W0 0.1）：SS_TABLE 查表直径 → BaseSpec 语义。
 * [engine gate 1.4] 不再写 v1 过渡键 `ss`（GridSpec.ss 已删——三处消费者于 1.3/1.4 迁移清零）；
 * 与 gridFromSpec(round, …) 产物逐字段相等。
 */
export function gridFromSs(ss: SSKey, pixelsPerMm: number, gapMm = 0.4): GridSpec {
  return { pitchMm: pitchMmFromSs(ss, gapMm), gapMm, rowAngleDeg: 0, pixelsPerMm };
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
 * 钻半径 px（SVG 导出/画布绘制用）——tasks 1.3 签名迁移：逐钻 `gemRadiusPx(gem, grid)`
 * （唯一物理依据 gem.diameterMm；圆快路径/异形包络同源）。
 *
 * @deprecated 第二重载（单 grid 参数）为 v1 过渡形态：基准规格半径
 * `(pitchMm − gapMm)/2 × pixelsPerMm`（量化回推 = SS_TABLE 查表值，v1 语义零变化）——
 * 保留给未迁移的 components 消费者（EditCanvas.svelte / gemPaint.ts，文件域禁改），
 * components 迁移（studio gate / rename-and-expert-workbench）后删除。
 */
export function gemRadiusPx(
  gem: { shapeId?: string; diameterMm: number },
  grid: GridSpec,
): number;
export function gemRadiusPx(grid: GridSpec): number;
export function gemRadiusPx(
  a: { shapeId?: string; diameterMm?: number } | GridSpec,
  b?: GridSpec,
): number {
  if (b !== undefined) {
    const gem = a as { shapeId?: string; diameterMm: number };
    return (gem.diameterMm / 2) * b.pixelsPerMm;
  }
  const grid = a as GridSpec;
  return (baseSpecDiameterMm(grid) / 2) * grid.pixelsPerMm;
}

export type { SSKey };
export { SS_KEYS };
