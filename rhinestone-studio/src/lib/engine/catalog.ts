/**
 * 钻规格目录：资产 schema 冻结 + 迁移 bootstrap 表（gem-catalog W0 0.6，design §1.6；
 * Owner 2026-09-20 裁决一「尺寸体系也要是一种文件格式存储在素材库中」）。
 *
 * 真源分层（裁决一）：
 * - **目录真源 = 素材库 .gemshape 资产**（sys-shapes 系统目录 seed + 用户自定义同域统一）；
 *   本模块不是目录真源——engine 仅保留**迁移 bootstrap**（SS_TABLE 直径查表 + specKey 生成
 *   规则常量：迁移是纯函数，不能读 IDB 素材库）。
 * - seed 机制（2.1 接线 assetStore）：幂等 **create-only**——确定性节点 id `ast-shape-${specKey}`，
 *   节点存在即跳过（**含软删态**——删除不复活）。
 *
 * 身份不可变纪律（design §1.6 / R3 P0-2 修复冻结，本文件注释即契约）：
 * 1. **specKey 创建后不可变**——seed 资产只读（编辑入口仅「另存为自定义」，产生新 specKey 资产）；
 *    自定义资产创建后 specKey 亦不可变；改物理（校准重做）= 另存副本。
 * 2. **.gemshape 内容不可变**——texture/vectorPath/physical/calibration/specKey 任何内容变更 =
 *    另存新资产（新 assetId / 新 specKey）；**不参与 blobKey 换绑**（同 gemgen「生成即定稿」先例，
 *    gemproj/gemdoc/gemtpl 的可编辑资产换绑豁免不适用于本格式）。文档侧靠物化快照
 *    （GemSpecSnapshot）保持稳定——目录漂移不影响旧文档。
 * 3. 身份不由显示码/浮点径反推（specKey 唯一持久身份；短码 R10/SQ35 仅人读）。
 */

import { SS_TABLE } from "./grid";
import { roundSpecKeyOfSs } from "./spec";
import type { ShapeId } from "./spec";
import { SS_KEYS } from "./types";
import type { SSKey } from "./types";

// ---------------------------------------------------------------------------
// P0 内置形元数据（五形——P1 oval/star 增条目不改本语义）
// ---------------------------------------------------------------------------

/** 形 id / 短码 / 中文名（短码仅人读显示，不参与身份）。 */
export interface BuiltinShapeMeta {
  shapeId: ShapeId
  /** 人读短码（BOM/图例显示列，如 R / SQ / DP） */
  shortCode: string
  /** 中文名 */
  nameZh: string
}

export const BUILTIN_SHAPES: readonly BuiltinShapeMeta[] = Object.freeze([
  { shapeId: "round", shortCode: "R", nameZh: "圆钻" },
  { shapeId: "square", shortCode: "SQ", nameZh: "方钻" },
  { shapeId: "drop", shortCode: "DP", nameZh: "水滴" },
  { shapeId: "heart", shortCode: "HT", nameZh: "心形" },
  { shapeId: "marquise", shortCode: "MQ", nameZh: "马眼" },
]);

// ---------------------------------------------------------------------------
// seed 数据形状（W0 冻结——sys-shapes seed 条目；2.1 落库）
// ---------------------------------------------------------------------------

/**
 * seed 数据形状冻结：形 id（经 specKey 携带）/ 短码 / 中文名 / 贴图**必备**（Owner 裁决一
 * 「包含 钻石素材图」）+ 可选 vectorPath（归一化 SVG path，单位框 0..1——并存时导出优先矢量；
 * vector-only 非法）/ 物理宽高（diameterMm 取 max）。
 * specKey 在 seed 数据**必填**（如 round-ss10——engine specKey 生成规则常量派生；
 * v1 文件输入与 custom ingest 可缺席、按 custom-<assetId> 派生——design §1.4 条件矩阵）。
 */
export interface GemshapeSeedSpec {
  /** canonical 身份键（seed 必填；创建后不可变——见文件头身份纪律） */
  specKey: string;
  shapeId: ShapeId;
  /** 人读短码（'R10' / 'SQ35' 形态——不参与身份） */
  shortCode: string;
  /** 中文名 */
  nameZh: string;
  /** 钻石素材图（必备——落库时经 serializeGemshape 物化为 texture） */
  texture: { mime: string; dataUrl: string; width: number; height: number };
  /** 归一化 SVG path（单位框 0..1）——可选渲染加速字段 */
  vectorPath?: string;
  /** 物理宽高（mm；diameterMm = max） */
  physical: { widthMm: number; heightMm: number };
}

/** sys-shapes seed 确定性节点 id（幂等 create-only 的存在性判据；含软删态节点即视为存在）。 */
export function gemshapeSeedNodeId(specKey: string): string {
  return `ast-shape-${specKey}`;
}

/** 幂等 create-only 计划：existingNodeIds 应包含软删节点（删除不复活——2.1 接线时由资产树全量投影）。 */
export interface GemshapeSeedPlan {
  /** 需创建的 seed（按 seeds 声明序） */
  create: readonly GemshapeSeedSpec[];
  /** 已存在（含软删）而跳过的节点 id 清单（诊断可见，不静默） */
  skipped: readonly string[];
}

/**
 * seed 幂等计划（纯函数——2.1 的 assetStore 接线消费；W0 冻结机制语义）：
 * 节点 id 已存在（含软删态）即跳过，绝不覆盖、绝不复活。
 */
export function planGemshapeSeeds(
  seeds: readonly GemshapeSeedSpec[],
  existingNodeIds: ReadonlySet<string>,
): GemshapeSeedPlan {
  const create: GemshapeSeedSpec[] = [];
  const skipped: string[] = [];
  for (const seed of seeds) {
    if (existingNodeIds.has(gemshapeSeedNodeId(seed.specKey))) {
      skipped.push(gemshapeSeedNodeId(seed.specKey));
    } else {
      create.push(seed);
    }
  }
  return { create, skipped };
}

// ---------------------------------------------------------------------------
// 迁移 bootstrap 表（非目录真源——v1→v2 纯函数迁移补默认的直径查表 + specKey 派生）
// ---------------------------------------------------------------------------

/** 圆钻 SS 档 bootstrap 行：SS_TABLE 直径 × specKey 生成规则（round-ss10 / …；SS_KEYS 声明序）。 */
export interface RoundSsBootstrapRow {
  ss: SSKey;
  diameterMm: number;
  specKey: string;
}

/**
 * 圆钻 SS 档迁移 bootstrap 表（SS_TABLE 直径查表 + round-ssXX 派生键）。
 * **不是目录真源**——目录真源是素材库 .gemshape 资产；本表仅供纯函数迁移补默认
 * （gemdoc v1 gems 补 diameterMm / gemproj v1 physics.ss → layers[].physics.specKey）。
 * SS24 补档 = 新增 seed 条目（2.1，SS_KEYS 现缺 SS24——同参同出不 bump，随 ENGINE_VERSION
 * 纪律注释登记）；本表随 SS_KEYS/SS_TABLE 自动跟进。
 */
export const ROUND_SS_BOOTSTRAP: readonly RoundSsBootstrapRow[] = Object.freeze(
  SS_KEYS.map((ss) => ({ ss, diameterMm: SS_TABLE[ss], specKey: roundSpecKeyOfSs(ss) })),
);
