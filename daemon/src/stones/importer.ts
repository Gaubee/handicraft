/**
 * 样卡导入器（add-stone-library design §8/§8.1——S2.1~S2.5）。
 * 原始需求 2026-09-24（Owner 补充定调三「AI 帮人录入」）：vision 产出的
 * CardCatalogDraft 草表 → bboxPx 切格去背景 → 贴图六 gate（经 StoneService，
 * S1 既有面零改动）→ 批量建原子（§1.2 目录树）→ 导入报告（blob 留档=reportRef）。
 *
 * **draft 生产方（vision/AI）必须遵守 design §8.1 规则 1/2/4/5**（标签坐标≠
 * 贴片坐标、切格禁用标签 x 锚定 / 尺寸文字行=头号污染源 / 浅色贴片阈值收缩 /
 * 大钻行独立处理）——导入器不做定位，只消费 bboxPx；本侧仅做 bbox 基本合理性
 * 检查：同 page 内 cell 互不重叠 + 界内（w/h>0 已由 S0 schema 保证）。
 *
 * 导入器侧 §8.1 硬验收落地：
 *   规则 3（跨格同字节）：同 hash 贴图出现于 ≥2 个不同 cell → 这些格全部降级
 *     card-render-pending，不静默入库。S1 约束下（StoneFile.texture 必备 +
 *     gate 6 拒缺贴图字节）「textureRef=null」落地为**不建原子**——textureStatus
 *     与降级原因记入导入报告（修复草表后重跑即入库，幂等语义天然衔接）。
 *   规则 6（变体 SKU 确定性命名）：同码多尺寸变体裸码保 code、其余 code-WxH
 *     （无尺寸声明用 #n 序号）；同码同字节=源重复跳过记报告；全程按草表出现序
 *     确定，禁止后写覆盖先写。
 *   规则 7（尺寸缺声明不猜测）：parseSku 失败 → sizeMm=null + metadata.sizeNote
 *     （显式原因），不做栅格比例尺推测。
 *   规则 8（质量旗+RGB 交叉验证）：逐 cell「贴图采样色 vs 草表 rgb」ΔE
 *     （CIE76——contracts color.ts 与引擎同源算法）；行级中位 ΔE>10 触发
 *     needsReview 人工复核标记（§8.1 原文「中位 ΔRGB>150」是 RGB 量纲，按
 *     Owner 2026-09-24 指示换算为 CIE76 量纲阈值 10——保守触发复核不拒收）；
 *     qualityFlag 经 options 透传入 metadata。
 *
 * 对外接口（S4 并行代理对接面，冻结）：runCardImport 函数名/结果字段语义不变；
 * deps 增量可选字段 pageImages（多页 PNG 直供）与 options 增量字段 ownerId/
 * supplierDisplayName/qualityFlag/… 见接口注释——均为必要增量（多页源图与资源
 * 归属无法从冻结三元组推导），结果六字段零改动。created=resourceId 列表
 * （StonePick.stoneRef 同键）；sku→resourceId 明细在导入报告。
 *
 * 正交意图：
 *   [1] S2.1 校验入口：CardCatalogDraft schema 校验 + bbox 合理性（重叠/界内/页声明）。
 *   [2] S2.2 切格+去背景首版：bboxPx 切图 → 白底阈值 alpha + ≤2px 羽化 → 主体采样色。
 *   [3] §8.1 规则 3/6/7/8：同字节降级 / 变体命名 / 缺声明不猜测 / 质量旗+ΔE 交叉验证。
 *   [4] S2.3/S2.4 批量建原子：经 StoneService 四步同事务；幂等重跑（supplier×sku
 *       跳过）；部分失败=成功保留+失败清单（不整批回滚）；低置信 `待命名-<row>` 兜底。
 *   [5] S2.5 导入报告：逐行 成功/跳过/失败/pending + 网格前后对照（每 cell 贴图
 *       ok/pending + 采样 RGB vs 草表 rgb 的 ΔE）——JSON 经 blobs.put 留档。
 */
import { createHash } from 'node:crypto';
import {
  CardCatalogDraftSchema,
  SupplierSkuProfileSchema,
  deltaE76,
  labFromRgb,
  parseSku,
  type CardCatalogDraft,
  type RgbTuple,
  type StoneFile,
  type SupplierSkuProfile,
} from '@handicraft/contracts';
import { decodePng, encodePng, type DecodedPng } from '../png/codec.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { nowIso } from '../db/store.js';
import { StoneService, StoneServiceError } from './service.js';
import { StoneTextureGateError } from './gates.js';

// ---------------------------------------------------------------- typed errors

export type CardImportErrorCode = 'invalid-draft' | 'invalid-options';

export class CardImportError extends Error {
  readonly code: CardImportErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: CardImportErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CardImportError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- 对外接口（冻结面）

/** 结果六字段冻结（brief S2）。created=resourceId 列表；sku 明细在报告。 */
export interface CardImportResult {
  /** 成功建原子的 resourceId（StonePick.stoneRef 同键） */
  created: string[];
  /** 幂等跳过（supplier×sku 已存在）与源重复（§8.1 规则 6） */
  skipped: { sku: string; reason: string }[];
  /** 逐 cell 失败（结构/gate/落库）——成功行保留，不整批回滚 */
  failed: { sku: string; reason: string }[];
  /** §8.1 规则 3 降级：跨格同字节（card-render-pending，不入库） */
  pendingDowngrades: { sku: string; reason: string }[];
  /** §S2.4：本次已入库的低置信格（confidence<0.7 或空名→`待命名-<row>`）；全量清单在报告 */
  lowConfidence: { sku: string; row: number }[];
  /** 导入报告 blob 引用（sha256——JSON 全文留存可审查） */
  reportRef: string;
}

/** 色系策略（design §8 ③ options.familyPolicy——草表建议→人审定组的导入期映射）。 */
export interface CardImportFamilyPolicy {
  /** suggestedFamily 原文 → 目标色系（键级覆盖，命中优先）。 */
  overrides?: Record<string, string>;
  /** suggestedFamily 为空时的兜底色系（缺省 '未分组'）。 */
  fallbackFamily?: string;
}

export interface CardImportOptions {
  /** 目标供应商（draft.supplier 之上的显式落库值——供应商目录与 supplier×sku 唯一键的键半）。 */
  targetSupplier: string;
  /** 落库资源归属（S4 授权桥透传 principal；冻结签名外的必要增量字段）。 */
  ownerId: string;
  supplierDisplayName?: string;
  familyPolicy?: CardImportFamilyPolicy;
  /** §8.1 规则 8 源质量旗透传（如 'source-lineart-unfilled'——默认不进生产组合由消费方解释）。 */
  qualityFlag?: string;
  /** 逐原子自由扩展（浅合并进 metadata——库存/批次等导入期附带信息）。 */
  extraMetadata?: Record<string, unknown>;
  /** 白底判定容差：255-min(r,g,b) ≤ tol 视为背景（缺省 16——纯白~近白底）。 */
  backgroundTolerance?: number;
  /** 边缘羽化 0..2px（缺省 2；>2 截断——§1.4 禁大面积半透明）。 */
  featherPx?: number;
}

export interface CardImportDeps {
  service: StoneService;
  blobs: BlobStore;
  db: SqliteDb;
  /**
   * 多页 PNG 源图直供（键=页号）。缺省回退 blobs.read(draft.sourceImage.blobRef)：
   * 仅当草表声明单页时该 blob 即该页 PNG（多页 PDF/PNG 集合由调用方——S4/后台
   * 向导——先拆页为 PNG 再直供；本导入器首版只消费 PNG，design §12-3）。
   */
  pageImages?: ReadonlyMap<number, Uint8Array>;
}

// ---------------------------------------------------------------- 报告形状（S2.5）

export type CardImportCellOutcome = 'created' | 'skipped' | 'failed' | 'pending';

export interface CardImportReportCell {
  /** 草表原始 SKU（溯源；变体命名前） */
  sku: string;
  /** 实际落库/查询 SKU（变体命名后；与 sku 同=裸码保位） */
  finalSku: string;
  page: number;
  bboxPx: { x: number; y: number; w: number; h: number };
  status: CardImportCellOutcome;
  reason: string | null;
  /** 贴图 PNG 字节 sha256（跨格同字节检测键；结构失败=null） */
  textureHash: string | null;
  textureStatus: 'ok' | 'card-render-pending' | null;
  /** 贴图主体采样色（alpha≥128 像素均值——入库 color.rgb 真值） */
  sampledRgb: RgbTuple | null;
  draftRgb: RgbTuple;
  /** 采样色 vs 草表 rgb 的 CIE76 ΔE（网格前后对照数据） */
  deltaE: number | null;
  resourceId: string | null;
}

export interface CardImportReportRow {
  row: number;
  suggestedName: string;
  /** 兜底后实际用名（`待命名-<row>` 或草表名） */
  appliedName: string;
  family: string;
  confidence: number;
  lowConfidence: boolean;
  medianDeltaE: number | null;
  needsReview: boolean;
  cells: CardImportReportCell[];
}

export interface CardImportReport {
  kind: 'card-import-report';
  formatVersion: 1;
  generatedAt: string;
  supplier: string;
  draftSupplier: string;
  options: { targetSupplier: string; qualityFlag: string | null; backgroundTolerance: number; featherPx: number };
  summary: {
    created: number;
    skipped: number;
    failed: number;
    pending: number;
    lowConfidence: number;
    rows: number;
    needsReviewRows: number;
  };
  /** 低置信全量清单（含未入库结果——proposal 预览的人工把关点，S2.4） */
  lowConfidence: { sku: string; row: number; outcome: CardImportCellOutcome }[];
  rows: CardImportReportRow[];
}

// ---------------------------------------------------------------- 常量（单源，测试可断言）

/** 低置信阈值（confidence<0.7 或 suggestedName 空——design §8）。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;
/**
 * 行级中位 ΔE 人工复核阈值（CIE76 量纲）。§8.1 规则 8 原文「中位 ΔRGB>150」
 * 是 RGB 量纲；按 Owner 2026-09-24 指示以 CIE76 ΔE>10 落地（换算注明：触发
 * 人工复核标记，不拒收——拒收归六 gate）。
 */
export const MEDIAN_DELTA_E_REVIEW_THRESHOLD = 10;
/** 白底判定容差缺省（255-min(r,g,b)≤16 → 背景：纯白~近白底，象牙白 240,240,232 主体存活）。 */
export const DEFAULT_BACKGROUND_TOLERANCE = 16;
/** 羽化上限（§1.4：抗锯齿羽化 ≤2px）。 */
export const MAX_FEATHER_PX = 2;
/** suggestedFamily 为空时的兜底色系（色系是易变分组——人审可批量重指）。 */
export const DEFAULT_FAMILY = '未分组';
/** finish 草表缺省值（草表无质感字段——不猜测 'glossy'，人审可改）。 */
export const DEFAULT_FINISH = 'unspecified';

// ---------------------------------------------------------------- 内部工作形状

type CellOutcome = 'todo' | CardImportCellOutcome;

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CellWork {
  // 草表上下文（行级）
  row: number;
  suggestedName: string;
  suggestedFamily: string;
  confidence: number;
  draftRgb: RgbTuple;
  // cell 级
  sku: string;
  page: number;
  bbox: Bbox;
  // SKU 解析（规则 7：失败→sizeMm null + sizeNote）
  sizeMm: number | null;
  skuParsed: NonNullable<StoneFile['skuParsed']> | null;
  sizeNote: string | null;
  // 管线产物
  textureBytes: Uint8Array | null;
  textureHash: string | null;
  sampledRgb: RgbTuple | null;
  deltaE: number | null;
  // 终态
  outcome: CellOutcome;
  reason: string | null;
  finalSku: string;
  resourceId: string | null;
}

type PageSource =
  | { status: 'ok'; decoded: DecodedPng }
  | { status: 'missing' | 'decode-failed' | 'dim-mismatch'; reason: string };

// ---------------------------------------------------------------- 主入口

/**
 * 样卡草表 → 批量建原子（S2 全链）。部分失败语义：逐 cell 独立事务（成功保留
 * +失败清单），草表结构性损坏（schema）整体 typed 拒。幂等：supplier×sku 存在
 * 即跳过并列入报告——重跑收敛。
 */
export function runCardImport(
  deps: CardImportDeps,
  draft: CardCatalogDraft,
  options: CardImportOptions,
): CardImportResult {
  // ---- S2.1 校验入口（schema——ZodError 包装为 typed error）
  let parsed: CardCatalogDraft;
  try {
    parsed = CardCatalogDraftSchema.parse(draft);
  } catch (error) {
    throw new CardImportError('invalid-draft', `草表不符 CardCatalogDraft 契约：${errorMessage(error)}`, {
      zodError: String(error),
    });
  }
  if (options.targetSupplier.trim() === '') {
    throw new CardImportError('invalid-options', 'targetSupplier 不可为空');
  }
  if (options.ownerId.trim() === '') {
    throw new CardImportError('invalid-options', 'ownerId 不可为空');
  }
  // 目标档案：bands 用草表实证档（vision 从样卡版式读出——design §8），供应商键以 options 为准。
  const profile: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
    supplier: options.targetSupplier,
    displayName: options.supplierDisplayName ?? parsed.supplier,
    bands: parsed.bands,
    styleKey: 'row',
  });
  const tolerance = options.backgroundTolerance ?? DEFAULT_BACKGROUND_TOLERANCE;
  const featherPx = Math.max(0, Math.min(MAX_FEATHER_PX, options.featherPx ?? MAX_FEATHER_PX));

  // ---- 源图解析（页级缓存；多页需 pageImages 直供，单页可走 blobRef）
  const pages = resolvePages(deps, parsed);

  // ---- cell 收集（草表出现序=全程确定性序：规则 6 禁后写覆盖先写的序基础）
  const works: CellWork[] = [];
  for (const style of parsed.styles) {
    for (const cell of style.cells) {
      const skuResult = parseSku(profile, cell.sku);
      works.push({
        row: style.row,
        suggestedName: style.suggestedName,
        suggestedFamily: style.suggestedFamily,
        confidence: style.confidence,
        draftRgb: style.rgb,
        sku: cell.sku,
        page: cell.page,
        bbox: cell.bboxPx,
        sizeMm: skuResult.ok ? skuResult.sizeMm : null,
        skuParsed: skuResult.ok ? { row: skuResult.row, prefix: skuResult.prefix, sizeMm: skuResult.sizeMm } : null,
        sizeNote: skuResult.ok ? null : `SKU ${cell.sku} 尺寸未声明（${skuResult.reason}）——§8.1 规则 7 不猜测`,
        textureBytes: null,
        textureHash: null,
        sampledRgb: null,
        deltaE: null,
        outcome: 'todo',
        reason: null,
        finalSku: cell.sku,
        resourceId: null,
      });
    }
  }

  // ---- S2.1 bbox 基本合理性：页声明 → 页可读 → 界内（规则 1/2/4/5 属 draft 生产侧，见文件头注）
  for (const w of works) {
    const declared = parsed.sourceImage.pages.find((p) => p.page === w.page);
    if (declared === undefined) {
      failCell(w, `page-not-declared：草表未声明 page=${w.page}`);
      continue;
    }
    const source = pages.get(w.page);
    if (source === undefined || source.status !== 'ok') {
      failCell(w, `source-page-unreadable：${source !== undefined ? source.reason : `源图页未解析（page=${w.page}）`}`);
      continue;
    }
    if (w.bbox.x + w.bbox.w > declared.widthPx || w.bbox.y + w.bbox.h > declared.heightPx) {
      failCell(w, `bbox-out-of-page：bbox ${w.bbox.x}+${w.bbox.w}/${w.bbox.y}+${w.bbox.h} 越出声明页界 ${declared.widthPx}×${declared.heightPx}`);
    }
  }
  // 同页互不重叠（正面积相交=草表 bug——涉事格逐个失败，其余照常：部分失败语义）
  for (let i = 0; i < works.length; i++) {
    const a = works[i]!;
    if (a.outcome !== 'todo') continue;
    for (let j = i + 1; j < works.length; j++) {
      const b = works[j]!;
      if (b.outcome !== 'todo' || b.page !== a.page) continue;
      if (bboxesOverlap(a.bbox, b.bbox)) {
        failCell(a, `bbox-overlap：与 ${b.sku}（row ${b.row}）同页重叠`);
        failCell(b, `bbox-overlap：与 ${a.sku}（row ${a.row}）同页重叠`);
      }
    }
  }

  // ---- S2.2 切格+去背景+采样（todo cells）
  for (const w of works) {
    if (w.outcome !== 'todo') continue;
    const source = pages.get(w.page);
    if (source === undefined || source.status !== 'ok') continue; // 前置已 fail，防御
    const crop = cropRgba(source.decoded, w.bbox);
    const cutout = cutoutFromWhite(crop, w.bbox.w, w.bbox.h, tolerance, featherPx);
    if (cutout === null) {
      failCell(w, 'background-removal-empty：切格后无主体（全白/阈值吃光——gate 3 前置显式失败）');
      continue;
    }
    const png = encodePng(w.bbox.w, w.bbox.h, cutout.rgba);
    w.textureBytes = new Uint8Array(png);
    w.textureHash = sha256Hex(w.textureBytes);
    w.sampledRgb = cutout.sampledRgb;
    // 规则 8 逐格 ΔE（采样色 vs 草表 rgb）
    w.deltaE = round2(deltaE76(labFromRgb(...cutout.sampledRgb), labFromRgb(...w.draftRgb)));
  }

  // ---- §8.1 规则 6a：同码同字节=源重复（首格保位，其余跳过——禁止后写覆盖先写）
  const seenSkuHash = new Set<string>();
  for (const w of works) {
    if (w.outcome !== 'todo' || w.textureHash === null) continue;
    const key = `${w.sku}\u0000${w.textureHash}`;
    if (seenSkuHash.has(key)) {
      w.outcome = 'skipped';
      w.reason = 'source-duplicate：同码同字节源重复（§8.1 规则 6）';
    } else {
      seenSkuHash.add(key);
    }
  }

  // ---- §8.1 规则 3：跨格同字节（不同 cell 同 hash=字形/模板污染）→ 全部 card-render-pending
  const byHash = new Map<string, CellWork[]>();
  for (const w of works) {
    if (w.outcome !== 'todo' || w.textureHash === null) continue;
    const group = byHash.get(w.textureHash);
    if (group === undefined) byHash.set(w.textureHash, [w]);
    else group.push(w);
  }
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    for (const w of group) {
      w.outcome = 'pending';
      w.reason = `card-render-pending：跨格同字节（§8.1 规则 3，textureHash=${hash.slice(0, 12)}，命中 ${group.length} 格）`;
    }
  }

  // ---- §8.1 规则 6b：变体 SKU 确定性命名（同码异字节：裸码保 code，其余 code-WxH / #n）
  const allOriginalSkus = new Set(works.map((w) => w.sku));
  const skuGroups = new Map<string, CellWork[]>();
  for (const w of works) {
    if (w.outcome !== 'todo') continue;
    const group = skuGroups.get(w.sku);
    if (group === undefined) skuGroups.set(w.sku, [w]);
    else group.push(w);
  }
  for (const [sku, group] of skuGroups) {
    if (group.length === 1) continue;
    const taken = new Set(allOriginalSkus);
    taken.delete(sku); // 裸码归本组首格
    for (let i = 0; i < group.length; i++) {
      const w = group[i]!;
      if (i === 0) continue; // 裸码保位（草表出现序）
      let n = i + 1;
      let candidate = w.sizeMm !== null ? `${sku}-${fmtMm(w.sizeMm)}x${fmtMm(w.sizeMm)}` : `${sku}#${n}`;
      while (taken.has(candidate)) {
        n += 1;
        candidate = `${sku}#${n}`;
      }
      w.finalSku = candidate;
      taken.add(candidate);
    }
  }

  // ---- S2.3 幂等前置：supplier×finalSku 已存在（含软删）→ 跳过
  const existsStmt = deps.db.prepare(
    'SELECT resource_id FROM stone_index WHERE supplier = ? AND sku = ?',
  );
  for (const w of works) {
    if (w.outcome !== 'todo') continue;
    const existing = existsStmt.get(profile.supplier, w.finalSku) as { resource_id: string } | undefined;
    if (existing !== undefined) {
      w.outcome = 'skipped';
      w.reason = `supplier×sku 已存在（幂等跳过，resourceId=${existing.resource_id}）`;
    }
  }

  // ---- 规则 8 行级聚合：中位 ΔE（行内全部已采样 cell）> 10 → needsReview
  const rowStats = new Map<number, { median: number | null; needsReview: boolean }>();
  for (const style of parsed.styles) {
    const values = works
      .filter((w) => w.row === style.row && w.deltaE !== null)
      .map((w) => w.deltaE!)
      .sort((a, b) => a - b);
    const median = values.length === 0 ? null : medianOf(values);
    rowStats.set(style.row, { median, needsReview: median !== null && median > MEDIAN_DELTA_E_REVIEW_THRESHOLD });
  }

  // ---- S2.3/S2.4 建 atoms（逐 cell 独立事务——部分失败=成功保留）
  for (const w of works) {
    if (w.outcome !== 'todo') continue;
    const colorName = appliedColorName(w);
    const family = resolveFamily(w.suggestedFamily, options.familyPolicy);
    const lowConfidence = isLowConfidence(w);
    const stats = rowStats.get(w.row);
    const metadata: Record<string, unknown> = {
      importSource: 'card-catalog-draft',
      draftRow: w.row,
      draftSupplier: parsed.supplier,
      confidence: w.confidence,
      lowConfidence,
      finishNote: `草表不含质感字段——导入缺省 ${DEFAULT_FINISH}（人审可改）`,
      cellRef: { page: w.page, bboxPx: w.bbox },
      ...(w.sampledRgb !== null ? { sampledRgb: w.sampledRgb } : {}),
      draftRgb: w.draftRgb,
      ...(w.deltaE !== null ? { deltaE: w.deltaE } : {}),
      ...(stats?.median != null ? { medianDeltaE: stats.median } : {}),
      ...(stats?.needsReview ? { needsReview: 'median-delta-e' } : {}),
      ...(w.finalSku !== w.sku ? { originalSku: w.sku } : {}),
      ...(w.sizeNote !== null ? { sizeNote: w.sizeNote } : {}),
      ...(options.qualityFlag !== undefined ? { qualityFlag: options.qualityFlag } : {}),
      ...(options.extraMetadata !== undefined ? { ...options.extraMetadata } : {}),
    };
    try {
      const created = deps.service.createStone({
        ownerId: options.ownerId,
        supplierProfile: profile,
        draft: {
          name:
            w.sizeMm !== null
              ? `${colorName} · ${fmtMm(w.sizeMm)}mm`
              : `${colorName} · 尺寸未声明`,
          sku: w.finalSku,
          ...(w.skuParsed !== null ? { skuParsed: w.skuParsed } : {}),
          sizeMm: w.sizeMm,
          // design §8：rgb 取 cell 取样（采样真值；草表 rgb 存 metadata.draftRgb 供对账）
          color: { name: colorName, rgb: w.sampledRgb ?? w.draftRgb, family, finish: DEFAULT_FINISH },
          metadata,
          texture: { declaredWidth: w.bbox.w, declaredHeight: w.bbox.h },
        },
        textureBytes: w.textureBytes!,
      });
      w.outcome = 'created';
      w.resourceId = created.resourceId;
    } catch (error) {
      w.outcome = 'failed';
      w.reason = creationFailureReason(error);
    }
  }

  // ---- S2.5 导入报告（blob 留档）+ 结果
  const report = buildReport(parsed, options, tolerance, featherPx, works, rowStats);
  const reportRef = deps.blobs.put(reportBytes(report)).hash;

  return {
    created: works.filter((w) => w.outcome === 'created').map((w) => w.resourceId!),
    skipped: works
      .filter((w) => w.outcome === 'skipped')
      .map((w) => ({ sku: w.finalSku, reason: w.reason ?? '' })),
    failed: works
      .filter((w) => w.outcome === 'failed')
      .map((w) => ({ sku: w.finalSku, reason: w.reason ?? '' })),
    pendingDowngrades: works
      .filter((w) => w.outcome === 'pending')
      .map((w) => ({ sku: w.sku, reason: w.reason ?? '' })),
    lowConfidence: works
      .filter((w) => w.outcome === 'created' && isLowConfidence(w))
      .map((w) => ({ sku: w.finalSku, row: w.row })),
    reportRef,
  };
}

// ---------------------------------------------------------------- 内部实现

function failCell(w: CellWork, reason: string): void {
  w.outcome = 'failed';
  w.reason = reason;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function creationFailureReason(error: unknown): string {
  if (error instanceof StoneTextureGateError) return `texture-gate/${error.code}：${error.message}`;
  if (error instanceof StoneServiceError) return `${error.code}：${error.message}`;
  return errorMessage(error);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** mm 千分化显示（2→'2'，2.5→'2.5'——变体码保持可读短形）。 */
function fmtMm(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function medianOf(sortedAsc: number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 1 ? sortedAsc[mid]! : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

function appliedColorName(w: CellWork): string {
  return w.suggestedName.trim() !== '' ? w.suggestedName : `待命名-${w.row}`;
}

function isLowConfidence(w: CellWork): boolean {
  return w.confidence < LOW_CONFIDENCE_THRESHOLD || w.suggestedName.trim() === '';
}

function resolveFamily(suggested: string, policy: CardImportFamilyPolicy | undefined): string {
  const overrides = policy?.overrides;
  if (overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, suggested)) {
    const mapped = overrides[suggested];
    if (typeof mapped === 'string' && mapped.trim() !== '') return mapped;
  }
  if (suggested.trim() !== '') return suggested;
  const fallback = policy?.fallbackFamily;
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback : DEFAULT_FAMILY;
}

/** 页源解析：pageImages 直供优先；单页草表回退 blobRef（多页缺直供=显式 missing）。 */
function resolvePages(deps: CardImportDeps, draft: CardCatalogDraft): Map<number, PageSource> {
  const out = new Map<number, PageSource>();
  const declared = draft.sourceImage.pages;
  const singleBlobBytes = declared.length === 1 ? deps.blobs.read(draft.sourceImage.blobRef) : null;
  for (const p of declared) {
    const bytes = deps.pageImages?.get(p.page) ?? singleBlobBytes ?? null;
    if (bytes === null) {
      out.set(p.page, {
        status: 'missing',
        reason: `源图字节缺失（page=${p.page}；多页草表需 deps.pageImages 直供，单页草表可走 blobRef）`,
      });
      continue;
    }
    try {
      const decoded = decodePng(bytes);
      if (decoded.width !== p.widthPx || decoded.height !== p.heightPx) {
        out.set(p.page, {
          status: 'dim-mismatch',
          reason: `声明 ${p.widthPx}×${p.heightPx} 与解码实测 ${decoded.width}×${decoded.height} 不符（page=${p.page}）`,
        });
        continue;
      }
      out.set(p.page, { status: 'ok', decoded });
    } catch (error) {
      out.set(p.page, { status: 'decode-failed', reason: `源图解码失败（page=${p.page}）：${errorMessage(error)}` });
    }
  }
  return out;
}

function bboxesOverlap(a: Bbox, b: Bbox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** bbox 切格（源页 RGBA → cell 画布）。 */
function cropRgba(page: DecodedPng, bbox: Bbox): Uint8Array {
  const out = new Uint8Array(bbox.w * bbox.h * 4);
  for (let y = 0; y < bbox.h; y++) {
    const srcRow = ((bbox.y + y) * page.width + bbox.x) * 4;
    out.set(page.rgba.subarray(srcRow, srcRow + bbox.w * 4), y * bbox.w * 4);
  }
  return out;
}

/**
 * 白底去背景首版（design §8 ④）：白底阈值 alpha（255-min(r,g,b)>tol 为主体）
 * + ≤2px 羽化（3×3 盒滤 ×N 次——边界 0..255 渐变，核心不变；禁大面积半透明）
 * + 主体采样色（alpha≥128 像素 RGB 均值）。无主体返回 null（gate 3 前置显式失败）。
 */
function cutoutFromWhite(
  crop: Uint8Array,
  width: number,
  height: number,
  tolerance: number,
  featherPx: number,
): { rgba: Uint8Array; sampledRgb: RgbTuple } | null {
  const count = width * height;
  const mask = new Uint8Array(count);
  let hasSubject = false;
  for (let i = 0; i < count; i++) {
    const r = crop[i * 4] ?? 0;
    const g = crop[i * 4 + 1] ?? 0;
    const b = crop[i * 4 + 2] ?? 0;
    if (255 - Math.min(r, g, b) > tolerance) {
      mask[i] = 255;
      hasSubject = true;
    }
  }
  if (!hasSubject) return null;
  let alpha: Uint8Array = mask;
  for (let pass = 0; pass < featherPx; pass++) {
    alpha = boxBlur3(alpha, width, height);
  }
  // 出图：原 RGB + 羽化 alpha（背景像素 RGB 保留原值——透明底 PNG，RGB 不参与渲染）
  const out = new Uint8Array(count * 4);
  let samples = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < count; i++) {
    const a = alpha[i] ?? 0;
    out[i * 4] = crop[i * 4] ?? 0;
    out[i * 4 + 1] = crop[i * 4 + 1] ?? 0;
    out[i * 4 + 2] = crop[i * 4 + 2] ?? 0;
    out[i * 4 + 3] = a;
    if (a >= 128) {
      sr += crop[i * 4] ?? 0;
      sg += crop[i * 4 + 1] ?? 0;
      sb += crop[i * 4 + 2] ?? 0;
      samples += 1;
    }
  }
  if (samples === 0) return null; // 羽化后无 ≥128 像素（极端小主体）——显式失败
  return {
    rgba: out,
    sampledRgb: [Math.round(sr / samples), Math.round(sg / samples), Math.round(sb / samples)],
  };
}

/** 3×3 盒滤（边界钳位，整数均摊）——单次扩边 1px。 */
function boxBlur3(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          sum += src[yy * width + xx] ?? 0;
        }
      }
      out[y * width + x] = Math.round(sum / 9);
    }
  }
  return out;
}

function buildReport(
  parsed: CardCatalogDraft,
  options: CardImportOptions,
  tolerance: number,
  featherPx: number,
  works: CellWork[],
  rowStats: Map<number, { median: number | null; needsReview: boolean }>,
): CardImportReport {
  const rows: CardImportReportRow[] = parsed.styles.map((style) => {
    const stats = rowStats.get(style.row);
    const rowWorks = works.filter((w) => w.row === style.row);
    const cells = rowWorks.map((w): CardImportReportCell => ({
        sku: w.sku,
        finalSku: w.finalSku,
        page: w.page,
        bboxPx: w.bbox,
        status: w.outcome === 'todo' ? 'failed' : w.outcome, // 防御：todo 不会漏到报告阶段
        reason: w.reason,
        textureHash: w.textureHash,
        textureStatus:
          w.outcome === 'pending' ? 'card-render-pending' : w.textureHash !== null ? 'ok' : null,
        sampledRgb: w.sampledRgb,
        draftRgb: w.draftRgb,
        deltaE: w.deltaE,
        resourceId: w.resourceId,
      }));
    return {
      row: style.row,
      suggestedName: style.suggestedName,
      appliedName: rowWorks.length > 0 ? appliedColorName(rowWorks[0]!) : style.suggestedName,
      family: resolveFamily(style.suggestedFamily, options.familyPolicy),
      confidence: style.confidence,
      lowConfidence:
        style.confidence < LOW_CONFIDENCE_THRESHOLD || style.suggestedName.trim() === '',
      medianDeltaE: stats?.median ?? null,
      needsReview: stats?.needsReview ?? false,
      cells,
    };
  });
  const lowConfidenceAll = works
    .filter((w) => w.outcome !== 'skipped' && isLowConfidence(w))
    .map((w) => ({ sku: w.finalSku, row: w.row, outcome: w.outcome as CardImportCellOutcome }));
  return {
    kind: 'card-import-report',
    formatVersion: 1,
    generatedAt: nowIso(),
    supplier: options.targetSupplier,
    draftSupplier: parsed.supplier,
    options: {
      targetSupplier: options.targetSupplier,
      qualityFlag: options.qualityFlag ?? null,
      backgroundTolerance: tolerance,
      featherPx,
    },
    summary: {
      created: works.filter((w) => w.outcome === 'created').length,
      skipped: works.filter((w) => w.outcome === 'skipped').length,
      failed: works.filter((w) => w.outcome === 'failed').length,
      pending: works.filter((w) => w.outcome === 'pending').length,
      lowConfidence: lowConfidenceAll.length,
      rows: rows.length,
      needsReviewRows: rows.filter((r) => r.needsReview).length,
    },
    lowConfidence: lowConfidenceAll,
    rows,
  };
}

function reportBytes(report: CardImportReport): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(report), 'utf8'));
}
