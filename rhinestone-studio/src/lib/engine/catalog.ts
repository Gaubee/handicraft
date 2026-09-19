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

import { SS_TABLE, baseSpecDiameterMm } from "./grid";
import { roundSpecKeyOfSs } from "./spec";
import { builtinSpecKey, customSpecKey } from "./spec";
import type { ShapeId } from "./spec";
import { SS_KEYS } from "./types";
import type { GridSpec, SSKey } from "./types";

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
// P0 seed 数据落地（gem-catalog 2.1——目录真源数据，Owner 裁决一「方便维护」）
// ---------------------------------------------------------------------------

/** 内置五形贴图（最小 PNG 嵌入；银白渐变剪影——alpha 内容 bounds 即轮廓，纵横比与档位
 *  物理纵横比对齐（fit 容差内）。生成产物，改形状 = 改数据不改代码。 */
interface GemshapeSeedTexture {
  dataUrl: string
  width: number
  height: number
}

const SEED_TEXTURES: Record<Exclude<ShapeId, "custom">, GemshapeSeedTexture> = {
  round: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABnElEQVR42u3bW3KCUBAEUPe/MU1UFBQFlDeCiCaaDXS+SJlcBSQ8Z5iqs4DuL+oyMxoN0+xE8ReyEAt7QxV6Fzw83lCHjoe+okmdCX6IrmgT6/CtlRCEn+gi1uEbKcE/fKAPWIevpQQvuKCPWIevpATXv4CC0gU4/hkUlAvvnUHJS+FtLwFFxQtwE1BUKLzlJqAsvwDnBMpyCzCdEyjLDm/H4OBpAXs7BgePw1sxOBEK2FlHcCIWYB7BiVCAYUbgRChA30fg5E/4EBz9FKDtQnA0FJDO1jiAo6GAdDZ6AI6GAtJRtQAc/foWUDUfnAhfguutD06EAlZbD5yIBWw8cCIUoGxccPLwVUhRXXDw9E1QVl1wkPkyLK8dUJb7X2C5dkBZfgErG5QV+j+4WNmgqPDf4YVig6KXdgQkxQIlpbZEJNkCBaV3hOayCQr+tSk2W5ros0p2BVmHT2e62KNPatkXZh0+nXdphy5r5GaAdfj7eZsb6IJW74ZYh7+fycxAkzp9QziZ6ahD7y5Ix1MdVSB1TzyeasgynJc3PN/9DcMwFaaAIAAAAABJRU5ErkJggg==", width: 64, height: 64 },
  square: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABQ0lEQVR42u3b13XCQBhEYfXfmI3JGQmUEyLY4Aau/bL/qofZOedr4L5PFIVFUT/8omgU4I0iC9Bd3ygaBXihyAK0/QtFIYBb0/2gKARwq9tvFIUAblXzRFEI4FbWTxRZgKJ+oMgHqB4osgB5dUeRD1DeUWQBsvKOIh+guKHIAqTFDUU+QD6gyAJc8gFFPkA2oMgCnLMrinyA9IoiC5CkPYosQHzpUTQK0KHIApzOHYpCALdj0qIoBHA7xA2KQgC3/alB0ShAjSILsDvWKLIA22OFIh/gUKHIAmwOJYp8gH2JIguw3pco8gF2BYoswGpXoMgH2OYosgDLbY4iH2CTo8gCLDYZinyAdYYiCzBfpyiyALNViqIQwG26vKAoBHD7WpxRFAK4TeYJikIAt89ZgqJRgBhFFuBjGqNoFOCEonCb/98fZ2vMcLuvaYoAAAAASUVORK5CYII=", width: 64, height: 64 },
  drop: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADEAAABGCAYAAABlu3xlAAABlElEQVR42u3a13aCQACEYd//wZJYsFeQjjQ1mrzA5ORCSCxBzbLsKHPOd89/RdtGo17x4vQT9BFR8gH6gAPKgDDe41gdIXuraI9LSAJ2KKJ0QBDucK06oqz5q3fcij5AuRAv2OJe9AFKhLjBFqJUE+BvIJr0CMffQDS5Ad4GZZESYHtrlK38CHeNspUaYLkpZCknwEkhm/AI00khm9gAO0FVhEUs7QRVERNgJajavwIMK4Yq7o8wY6jirgDdjKCa54tYLCOo6oaIEKq6KmBuhFDdc0TM9BVURx9QGDJdBGDxuBGTeQA2ZyJ8sDmJGM98sHm8iNHMA6s8YuqBVRYxnLpglUdMXLDKIgYTF6zyiLEDVllEf+yAVR4xcsAqi+iNbLDKI4Y2WP26a3eHFticPDt1BxbYnERoAwtszr4YaX0TLC6+nnb6Jlj8+cWDPuB77d4SqrvqUyZ9wGGtrgHV3PWjhT7gsKZmoGpC/qA2NR1VEX6q4K2jQ5ZSD6nQB/zca3sB0So90Eh74UV7ac1xrFHv8r4ANu92cG4jlMMAAAAASUVORK5CYII=", width: 49, height: 70 },
  heart: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAD8AAAA+CAYAAACcA8N6AAABxElEQVR42u3bSZKCQBAFUO5/MbVFEXBgVmZxti/wO1y0rYETCtSQ/SPeOvkbDagsRfnP+8mLb9wi2owKD3NEFbzOqJRsecQneJlRsfQBdeFhzstJ8wPqxnJOheJ7NIXFnJeTZHs0idUs5sUvH6rNWU8Tpzu0hcW8h4nSHWT1uHiyhezulg+TLWR3u3i8ARWl8ot4AyrK5aMNqCiVn0drUHFdPFyDmnP5IFyBmnN5f7ECNRflC1BzLu/NC1DzVz4oQM3VL74bLEFF6X/e9ZegolTe8XNQUS7v5aCiVN72MlBx87XWcjPI7u7HDNLlZ04K2T38jke2+ClTO4GsXvp2T7b4KRMrgWwqHVmNrRiyeOuwcjyLIbq3j6jNWQTRfXRGb04jiKqW7QxjGkI0te3kGJMQoql1KUkfhxBFI6to+ngB3jW6izcyF+BVKxuYmjkHb1pdQdWMOXjBZAd3aARgjenW9VAPwAoXa+cDPUDbuNq7H4x8tIXLiwfqyEfTuL55oWoemiLE1ZO+5qFuQt29+Rq6qIuQl4/IFr9Mb+CiKqmuoPUGDl4l5R28rurgGUXmdFUb9yhU0unb+KVQTKdv0SzOQ34ATBT2csI7KTYAAAAASUVORK5CYII=", width: 63, height: 62 },
  marquise: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAABQCAYAAABrjzfBAAAB0UlEQVR42u3aR3LCQBRFUfa/MRuTM8pZiAwreC4YADYCK3R42P5VZ35nUnf/RuN/iGaxPOLkP7DKpNkRt8jiDshDE5hkB+ThiFsc8IzmuD2K0BYYp3sUQR2nJTJKd6hCXWCyQxVK4sJkhzrkxsVbiPA3A4N4C5HExkUbyCAs0I82kEFMXLiBTLUDvXANmerFBWuo8DsD3WAFlcoH+iuoVCrO8VfQoXigt4QOheJsbwmdXjvQdjMweBhouRkY5Mc5GZjcBZrOAkxeL9CwF2DyLS4Fo2uglYLRJXBupWB0E5iA0SVwZiZg9DqBUyMBo5vAGIwugRMjBqNr4DwGoy9fk8k8ApO7b/F4FoHJ6wWOZiGY5P5Vj6YhGDw8kwynIRg8PdkNJwF0+vFcTB94msEkgA6F72YGYx86lLrh6o99qFT6frA/8qFSpVvW3siDCpXvqOkDz5FDDzLVfifpDl3IJOS1qTtwIYOwt7rOwIUMQl88O30HIkl5M273HYgg7cWdPvAc2bNRh5LNj1bPRhXK9mZaXRtVKN0++uhaKEPL/hZ13GmaHQtFaN0hbHZMPEOxhdlsm8hDs8P63jaRh2oT+L1t4FaDcd5aBk4arEMf+CfnE/ZAzMVRP/vFAAAAAElFTkSuQmCC", width: 40, height: 80 },
}

/** 五形归一化矢量轮廓（单位框 0..1；与贴图同源剪影——并存时导出优先矢量，§1.4）。 */
const SEED_VECTOR_PATHS: Record<Exclude<ShapeId, "custom">, string> = {
  round: "M 0.5 0.02 C 0.7651 0.02 0.98 0.2349 0.98 0.5 C 0.98 0.7651 0.7651 0.98 0.5 0.98 C 0.2349 0.98 0.02 0.7651 0.02 0.5 C 0.02 0.2349 0.2349 0.02 0.5 0.02 Z",
  square: "M 0.02 0.02 L 0.98 0.02 L 0.98 0.98 L 0.02 0.98 Z",
  drop: "M 0.5 0.02 C 0.74 0.26 0.98 0.46 0.98 0.68 C 0.98 0.85 0.76 0.98 0.5 0.98 C 0.24 0.98 0.02 0.85 0.02 0.68 C 0.02 0.46 0.26 0.26 0.5 0.02 Z",
  heart: "M 0.5 0.98 C 0.14 0.72 0.02 0.5 0.02 0.32 C 0.02 0.14 0.16 0.02 0.3 0.02 C 0.4 0.02 0.47 0.08 0.5 0.16 C 0.53 0.08 0.6 0.02 0.7 0.02 C 0.84 0.02 0.98 0.14 0.98 0.32 C 0.98 0.5 0.86 0.72 0.5 0.98 Z",
  marquise: "M 0.5 0.02 C 0.78 0.22 0.98 0.38 0.98 0.5 C 0.98 0.62 0.78 0.78 0.5 0.98 C 0.22 0.78 0.02 0.62 0.02 0.5 C 0.02 0.38 0.22 0.22 0.5 0.02 Z",
}

/** 异形纵横比常量（宽/高——widthMm/heightMm 由主尺寸（最大径 = 高轴长轴）派生，design §1.6）。 */
const SEED_ASPECTS = {
  square: 1,
  drop: 3 / 4.3,
  heart: 4.5 / 4.4,
  marquise: 2.5 / 5,
} as const

function mm(n: number): string {
  return `${Math.round(n * 100) / 100}mm`
}

function seedOf(
  shapeId: Exclude<ShapeId, "custom">,
  specKey: string,
  shortCode: string,
  nameZh: string,
  majorMm: number,
): GemshapeSeedSpec {
  const texture = SEED_TEXTURES[shapeId]
  const aspect = shapeId === "round" ? 1 : SEED_ASPECTS[shapeId]
  // majorMm = 最大径（design §1.6：圆=直径；方=边长；异形=长轴）——aspect = width/height
  const widthMm = aspect >= 1 ? majorMm : Math.round(majorMm * aspect * 100) / 100
  const heightMm = aspect >= 1 ? Math.round((majorMm / aspect) * 100) / 100 : majorMm
  return {
    specKey,
    shapeId,
    shortCode,
    nameZh,
    texture: { mime: "image/png", dataUrl: texture.dataUrl, width: texture.width, height: texture.height },
    vectorPath: SEED_VECTOR_PATHS[shapeId],
    physical: { widthMm, heightMm },
  }
}

/** round SS 档（SS_KEYS 声明序——含 2.1 补档 SS24≈5.3mm；specKey = roundSpecKeyOfSs 派生键）。 */
const ROUND_SS_SEEDS: readonly GemshapeSeedSpec[] = SS_KEYS.map((ss) =>
  seedOf("round", roundSpecKeyOfSs(ss), `R${ss.slice(2)}`, `圆钻 ${ss}`, SS_TABLE[ss]),
)

/** 四异形常用 mm 档（主尺寸 = 最大径/长轴；specKey = builtinSpecKey 规则派生，与 BOM 投影一致）。 */
const SHAPE_MM_SEEDS: readonly GemshapeSeedSpec[] = [
  ...[3, 3.5, 4].map((d) => seedOf("square", builtinSpecKey("square", mm(d)), `SQ${Math.round(d * 10)}`, `方钻 ${mm(d)}`, d)),
  ...[4.3, 5.2].map((d) => seedOf("drop", builtinSpecKey("drop", mm(d)), `DP${Math.round(d * 10)}`, `水滴 ${mm(d)}`, d)),
  seedOf("heart", builtinSpecKey("heart", mm(4.5)), "HT45", "心形 4.5mm", 4.5),
  seedOf("marquise", builtinSpecKey("marquise", "5mm"), "MQ5", "马眼 5×2.5mm", 5),
]

/**
 * P0 内置规格 seed 全集（声明序 = 落库序 = 目录枚举序；20 条）。
 * **目录真源数据**（裁决一）——维护 = 增删本表条目（sys-shapes 幂等 create-only 补建，
 * 删除不复活），不改消费代码。SS24 补档 = 本表 round-ss24 条目（同参同出不 bump——见 grid.ts）。
 */
export const GEMSHAPE_SEEDS: readonly GemshapeSeedSpec[] = Object.freeze([...ROUND_SS_SEEDS, ...SHAPE_MM_SEEDS])

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

// ---------------------------------------------------------------------------
// 逐钻 canonical specKey 投影（engine gate 1.3：BOM 聚合键 specKey×colorId 唯一入口）
// ---------------------------------------------------------------------------

/** 逐钻规格身份投影：canonical specKey + 人读规格列（形状中文名/尺寸标签）。 */
export interface GemSpecIdentity {
  /** canonical 稳定键（BOM 聚合键；不由显示码/浮点径格式化反推——圆钻 SS 档走 bootstrap 查表精确匹配） */
  specKey: string;
  /** 形 id（'round' | … | 'custom'） */
  shapeId: string;
  /** 尺寸标签（'SS10' / '3.5mm'——显示用，不参与身份） */
  sizeLabel: string;
}

/** mm 显示标签：1e-6 量化后原样输出（2.8 → '2.8mm'；3.5 → '3.5mm'——消浮点尾数噪声）。 */
function mmSizeLabel(diameterMm: number): string {
  const d = Math.round(diameterMm * 1e6) / 1e6;
  return `${d}mm`;
}

/**
 * 逐钻规格身份投影（纯函数；design §1.1/§2.2）：
 * - custom → `custom-<assetId>`（canonical 至少含 assetId；assetId 缺席的 custom 为非法输入面，
 *   以 'custom-unknown' 聚合行呈现——导出前置由 exportGate missing-asset 面硬阻断）；
 * - round 且直径与 ROUND_SS_BOOTSTRAP 精确相等 → `round-ssXX`（v1 圆钻迁移后自然落 round-ssXX 行；
 *   baseSpecDiameterMm 的量化回推保证 gridFromSs 构造链下逐位命中查表值）；
 * - 其余 builtin → builtinSpecKey(shapeId, mm 标签)（'square-3.5' 形态——非 SS 档空间）。
 * 直径缺席（v1 无规格字段钻）按 grid 基准规格派生（baseSpecDiameterMm——与判距兜底同单源）。
 */
export function gemSpecIdentityOf(
  gem: { shapeId?: string; diameterMm?: number; assetId?: string },
  grid: GridSpec,
): GemSpecIdentity {
  const shapeId = gem.shapeId ?? "round";
  const diameterMm = Math.round((gem.diameterMm ?? baseSpecDiameterMm(grid)) * 1e6) / 1e6;
  if (shapeId === "custom") {
    return { specKey: customSpecKey(gem.assetId ?? "unknown"), shapeId, sizeLabel: "自定义" };
  }
  if (shapeId === "round") {
    for (const row of ROUND_SS_BOOTSTRAP) {
      if (row.diameterMm === diameterMm) {
        return { specKey: row.specKey, shapeId, sizeLabel: row.ss };
      }
    }
  }
  return { specKey: builtinSpecKey(shapeId, mmSizeLabel(diameterMm)), shapeId, sizeLabel: mmSizeLabel(diameterMm) };
}

/** 形状显示名：builtin 查 BUILTIN_SHAPES 中文名；custom/未知原样返回形 id。 */
export function gemShapeDisplayName(shapeId: string): string {
  const meta = BUILTIN_SHAPES.find((s) => s.shapeId === shapeId);
  return meta !== undefined ? meta.nameZh : shapeId;
}
