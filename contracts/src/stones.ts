/**
 * 装饰钻库契约（add-stone-library design §1.3/§2/§4/§5/§8/§9——S0.1 冻结）。
 * 原始需求 2026-09-24（Owner 补充定调三：真正客观的数据=颜色+尺寸；可贴原子=
 * {贴图,尺寸,颜色,元数据}；七字段模型降级云数据参考）。
 * 与 design 字面的两处收紧（§8.1 规则 7 落地）：sizeMm nullable（无物理尺寸声明
 * 显式 null+metadata.sizeNote，不猜测）；语义必填字符串 z.string()→min(1)。
 * 全部 object schema .strict()（核心字段冻结，metadata 是唯一自由扩展面——§1.3 不变量）。
 * 正交意图：
 *   [1] stone.json 原子格式（§1.3）与供应商 SKU 编码档案/parseSku（§2）。
 *   [2] 消费面投影：样卡草表 CardCatalogDraft（§8）/网格 StoneGridCell（§4.2）/
 *       选中 StonePick（§5）/替代查询 SubstituteQuery（§9）/云数据 CloudCatalogEntry（§9.2）。
 *   [3] sizeMm↔SS 直径换算表镜像（§9.2——engine grid.ts SS_TABLE 数值同源，测试锁死）。
 */
import { z } from 'zod';
import { BlobRefSchema, IsoDateTimeSchema } from './common.js';

// ---------------------------------------------------------------- 共享标量

/** sRGB 通道（0-255 整数——契约层即拒浮点/越界，运行时安全前置）。 */
const RgbChannelSchema = z.number().int().min(0).max(255);

/** 主体代表色三元组（贴图/样卡取样，0-255）。 */
export const RgbTupleSchema = z.tuple([RgbChannelSchema, RgbChannelSchema, RgbChannelSchema]);
export type RgbTuple = z.infer<typeof RgbTupleSchema>;

/** 行段闭区间 [lo, hi]（lo≤hi 由 refine 保证——倒置行段=档案配置 bug，显式拒绝）。 */
const SkuBandRowsSchema = z
  .tuple([z.number().int(), z.number().int()])
  .refine(([lo, hi]) => lo <= hi, { message: 'rows 区间必须 lo≤hi' });

/** 前缀字母→毫米映射（{J:2, A:3, …}——同一前缀不同行段不同 mm，§2 行段漂移实证）。 */
const SkuBandSchema = z
  .object({
    rows: SkuBandRowsSchema,
    sizeMmByPrefix: z.record(z.string().min(1), z.number().positive()),
  })
  .strict();

// ---------------------------------------------------------------- §1.3 stone.json

const StoneColorSchema = z
  .object({
    /** '象牙白'（人审定名） */
    name: z.string().min(1),
    /** 0-255 主体代表色（贴图/样卡取样） */
    rgb: RgbTupleSchema,
    /** '白色系'（逻辑分组，可重指） */
    family: z.string().min(1),
    /** 质感：glossy|matte|metallic|pearl|iridescent|自由串 */
    finish: z.string().min(1),
  })
  .strict();
export type StoneColor = z.infer<typeof StoneColorSchema>;

/** 贴图元数据（必备——去背景留主体；声明值，入库以解码实测为准=gate 1，§1.4）。 */
const StoneTextureSchema = z
  .object({
    /** 原子目录内文件名（冻结字面） */
    file: z.literal('贴图.png'),
    mime: z.literal('image/png'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** alpha 内容 bounds（主径/物理换算取此，非画布外框；非空 w/h>0） */
    alphaBounds: z.object({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    }),
  })
  .strict();
export type StoneTexture = z.infer<typeof StoneTextureSchema>;

/** parseSku 成功结果的 stone.json 物化快照（§1.3 注：{row:51, prefix:'J', sizeMm:2}）。 */
export const SkuParsedSchema = z
  .object({
    row: z.number().int(),
    prefix: z.string().min(1),
    sizeMm: z.number().positive(),
  })
  .strict();
export type SkuParsed = z.infer<typeof SkuParsedSchema>;

export const StoneFileSchema = z
  .object({
    kind: z.literal('stone'),
    formatVersion: z.literal(1),
    /** 'stn-' + uuid（resourceId 独立于原子目录行 id） */
    id: z.string().min(1),
    /** 显示名 '象牙白 · 2mm' */
    name: z.string().min(1),
    /** 'yuhang'（唯一性=supplier×sku） */
    supplier: z.string().min(1),
    /** 原始编码 'J51'（溯源） */
    sku: z.string().min(1),
    /** 导入时物化快照（档案后续修订不回写） */
    skuParsed: SkuParsedSchema.optional(),
    /**
     * 最大径 mm——客观真值（唯一物理依据，引擎消费此值）。
     * §8.1 规则 7：无物理尺寸声明的素材显式 null + metadata.sizeNote，不猜测；
     * 栅格比例尺推导仅在素材库有统一标定证据时允许，且标定值入 metadata。
     */
    sizeMm: z.number().positive().nullable(),
    color: StoneColorSchema,
    texture: StoneTextureSchema,
    /** 几何归类：'round'|'cabochon'|'pearl'|'resin-dome'|…（缺省 'round'，消费方解释） */
    shapeClass: z.string().min(1).optional(),
    /** 可选关联 .gemshape 资产 id（§3——渲染形状定义，单向弱引用） */
    gemshapeRef: z.string().min(1).optional(),
    /** views/ 下文件名清单（实物照片，非渲染源） */
    views: z.array(z.string().min(1)).optional(),
    /** 自由扩展（库存/采购/工艺备注/批次/sizeNote/qualityFlag…——唯一自由扩展面） */
    metadata: z.record(z.string(), z.unknown()),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type StoneFile = z.infer<typeof StoneFileSchema>;

// ---------------------------------------------------------------- §2 SKU 编码档案

export const SupplierSkuProfileSchema = z
  .object({
    /** 'yuhang' */
    supplier: z.string().min(1),
    /** '钰航' */
    displayName: z.string().min(1),
    /** 行段可配（同一前缀不同行段→不同 mm；行 77/79 样卡缺席=稀疏行容忍） */
    bands: z.array(SkuBandSchema).min(1),
    /** 款式号=行号（其它供应商编码位次变化时扩） */
    styleKey: z.literal('row'),
  })
  .strict();
export type SupplierSkuProfile = z.infer<typeof SupplierSkuProfileSchema>;

/** parseSku 失败原因（结构化 typed error，不猜测——§2）。 */
export type SkuParseFailureReason = 'prefix-unknown' | 'row-out-of-band' | 'malformed';

export type SkuParseResult =
  | { ok: true; supplier: string; row: number; prefix: string; sizeMm: number }
  | { ok: false; reason: SkuParseFailureReason };

/** SKU 码结构：前缀字母 ≥1 + 行号数字 ≥1（如 'J51'；大小写敏感，不做规范化猜测）。 */
const SKU_CODE_PATTERN = /^([A-Za-z]+)([0-9]+)$/;

/**
 * 解析供应商 SKU 码 → {supplier, row, prefix, sizeMm}。
 * 实证（钰航样卡 §2 行段漂移）：'J51'→2mm 而 'J76'→12mm（band [76,78]: J=12）；
 * 'J77'→12mm（稀疏行在 band 内即容忍）。失败族：'X51'→prefix-unknown /
 * 'J90'→row-out-of-band / '51J'|'J'|''→malformed。首匹配行段生效（bands 配置
 * 责任不重叠；稀疏行=行缺席≠行段外）。
 */
export function parseSku(profile: SupplierSkuProfile, code: string): SkuParseResult {
  const match = SKU_CODE_PATTERN.exec(code);
  if (match === null) return { ok: false, reason: 'malformed' };
  const prefix = match[1] as string;
  const row = Number.parseInt(match[2] as string, 10);
  const band = profile.bands.find((b) => row >= b.rows[0] && row <= b.rows[1]);
  if (band === undefined) return { ok: false, reason: 'row-out-of-band' };
  const sizeMm = band.sizeMmByPrefix[prefix];
  if (sizeMm === undefined) return { ok: false, reason: 'prefix-unknown' };
  return { ok: true, supplier: profile.supplier, row, prefix, sizeMm };
}

// ---------------------------------------------------------------- §8 样卡草表

export const CardCatalogDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** 'yuhang'（vision 草表字段名以本 schema 为对接契约） */
    supplier: z.string().min(1),
    sourceImage: z
      .object({
        blobRef: BlobRefSchema,
        pages: z
          .array(
            z
              .object({
                page: z.number().int().positive(),
                widthPx: z.number().int().positive(),
                heightPx: z.number().int().positive(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    /** 与 §2 档案同构（vision 从样卡版式读出） */
    bands: z.array(SkuBandSchema).min(1),
    styles: z.array(
      z
        .object({
          /** 51 */
          row: z.number().int(),
          /** '象牙白'（空串=待人工命名——导入不猜测命名，`待命名-<row>` 兜底） */
          suggestedName: z.string(),
          /** '白色系' */
          suggestedFamily: z.string(),
          rgb: RgbTupleSchema,
          confidence: z.number().min(0).max(1),
          cells: z
            .array(
              z
                .object({
                  sku: z.string().min(1),
                  page: z.number().int().positive(),
                  bboxPx: z.object({
                    x: z.number().int().nonnegative(),
                    y: z.number().int().nonnegative(),
                    w: z.number().int().positive(),
                    h: z.number().int().positive(),
                  }),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type CardCatalogDraft = z.infer<typeof CardCatalogDraftSchema>;

// ---------------------------------------------------------------- §4.2 网格轻投影

/** 样卡式网格单元（stones.list 投影——列表不载 stone.json 全文）。 */
export const StoneGridCellSchema = z
  .object({
    /** 原子目录行 id（resourceId） */
    resourceId: z.string().min(1),
    sku: z.string().min(1),
    supplier: z.string().min(1),
    /** '象牙白 · 2mm' */
    name: z.string().min(1),
    styleName: z.string(),
    family: z.string().min(1),
    /** 与 StoneFile.sizeMm 同 nullable 语义（未声明=显示层显式标注，§8.1 规则 7） */
    sizeMm: z.number().positive().nullable(),
    /** '#FFFFF0'（大写，冗余投影——ΔE/筛选用） */
    colorHex: z.string().regex(/^#[0-9A-F]{6}$/),
    finish: z.string(),
    /** /api/stones/{id}/texture.png */
    textureUrl: z.string().min(1),
    trashed: z.boolean(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type StoneGridCell = z.infer<typeof StoneGridCellSchema>;

// ---------------------------------------------------------------- §5 选中产出

/** 选钻产出（策略参数引用钻的唯一形态——不内嵌贴图数据）。 */
export const StonePickSchema = z
  .object({
    /** resourceId 即 stoneRef（组合成员/BOM 反推溯源共用此键，§7/§10） */
    resourceId: z.string().min(1),
    sku: z.string().min(1),
    supplier: z.string().min(1),
    /** 未声明尺寸的钻不可排钻（消费方按显式态处理），schema 与 StoneFile 同 nullable */
    sizeMm: z.number().positive().nullable(),
    colorHex: z.string().regex(/^#[0-9A-F]{6}$/),
    /** 可选 shape 关联（.gemshape 资产 id 弱引用） */
    gemshapeRef: z.string().min(1).optional(),
  })
  .strict();
export type StonePick = z.infer<typeof StonePickSchema>;

// ---------------------------------------------------------------- §9 替代查询

const SubstituteDefaults = {
  maxDeltaE: z.number().positive().default(10),
  sizeToleranceMm: z.number().positive().default(0.5),
  supplier: z.string().min(1).optional(),
} as const;

/** 二选一形态 A：按 SKU（服务端解析目标色/尺寸）。 */
const SubstituteBySkuSchema = z
  .object({ sku: z.string().min(1), ...SubstituteDefaults })
  .strict();

/** 二选一形态 B：按颜色+尺寸（sizeMm 必填且非 null——无尺寸即无替代基准）。 */
const SubstituteByColorSchema = z
  .object({ colorRgb: RgbTupleSchema, sizeMm: z.number().positive(), ...SubstituteDefaults })
  .strict();

/** sku | colorRgb+sizeMm 二选一（strict 交叉拒斥：混给/缺给均失败——不猜测）。 */
export const SubstituteQuerySchema = z.union([SubstituteBySkuSchema, SubstituteByColorSchema]);
export type SubstituteQuery = z.infer<typeof SubstituteQuerySchema>;

// ---------------------------------------------------------------- §9.2 云数据参考

/** SS 云数据参考条目（消费接口位冻结；云数据建设另立——非库存承诺）。 */
export const CloudCatalogEntrySchema = z
  .object({
    system: z.literal('ss'),
    /** 'SS10' */
    label: z.string().regex(/^SS[0-9]+$/),
    diameterMm: z.number().positive(),
    colorName: z.string(),
    /** 云数据须携带 rgb 才可 ΔE；缺 rgb 降级为仅尺寸建议+色名提示 */
    rgb: RgbTupleSchema.optional(),
  })
  .strict();
export type CloudCatalogEntry = z.infer<typeof CloudCatalogEntrySchema>;

// ---------------------------------------------------------------- §9.2 SS 换算镜像

/**
 * SS6~SS34 名义直径 mm（sizeMm↔SS 换算真源镜像）。
 * 真源：rhinestone-studio/src/lib/engine/grid.ts `SS_TABLE`（2026-09-24 抄录，
 * 测试字面量断言锁死；精度 ±0.1–0.2mm，SS24=5.3 中置信补档）。
 * 与 design §2 同理：本包不 import 引擎——数值同源由 stones.test.ts 对拍保证。
 */
export const SS_DIAMETER_TABLE = {
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
} as const satisfies Record<string, number>;

export type SsKey = keyof typeof SS_DIAMETER_TABLE;

/** SS→mm 查表（非线性，永远查表——tech-research §3.1）。 */
export function ssSizeMm(ss: SsKey): number {
  return SS_DIAMETER_TABLE[ss];
}

/** mm→SS 最近档（平局取表序靠前=尺寸较小档，确定性输出）。 */
export function nearestSs(sizeMm: number): { key: SsKey; sizeMm: number; deltaMm: number } {
  let best: SsKey | undefined;
  let bestDelta = Infinity;
  for (const key of Object.keys(SS_DIAMETER_TABLE) as SsKey[]) {
    const delta = Math.abs(SS_DIAMETER_TABLE[key] - sizeMm);
    if (delta < bestDelta) {
      best = key;
      bestDelta = delta;
    }
  }
  // bands min(1) 不适用于本表（编译期字面量非空），运行时兜底断言防御未来改表
  if (best === undefined) throw new Error('SS_DIAMETER_TABLE 为空');
  return { key: best, sizeMm: SS_DIAMETER_TABLE[best], deltaMm: bestDelta };
}
