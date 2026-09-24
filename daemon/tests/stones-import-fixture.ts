/**
 * 钰航样卡合成 fixture（add-stone-library S2——stones-import.test.ts 专用）。
 * 实测锚点（2026-09-24 四件素材实证，experiments/stone-catalog-20260924）：
 *   - page1 贴片列心 x=[238,368,462,684,912,1152,1410]（J..G，间距 130→258 递增）；
 *   - page2 普通行列心=[232,368,460,688,912,1148,1408]，大钻行 76/78 列心不同（G≈1650）；
 *   - 普通行贴片直径 px≈mm×8.66（行 51 实测 17/26/35/44/52/69/87 即 2-10mm）；
 *     大钻行直径 112→221px（12-25mm）；
 *   - PDF 文本层标签 y = 131+95×(row-51)（page1）。
 * 真实源图 220dpi（page 1819×2573）下 2-6mm 贴片主径 <64px 过不了 gate 5——
 * 测试按 SCALE=4 放大合成（保列距/直径比例结构，不保绝对 px；测试内不跨仓
 * 读真实源图，纪律见任务简报）。
 * 正交意图：
 *   [1] drawCardPage：白底页合成（圆/方块色块——png codec 直绘）。
 *   [2] buildDraft：草表构造（bbox 由 cell 几何推导，可显式覆写驱动坏输入用例）。
 *   [3] buildStandardYuhangFixture：钰航标准三行段样卡（51/52 普通行+53 低置信
 *       行@page1；76 大钻行@page2）——S2.2/S2.3/S2.4/S2.5 全链基线。
 */
import { createHash } from 'node:crypto';
import {
  CardCatalogDraftSchema,
  type CardCatalogDraft,
  type RgbTuple,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';

/** 合成放大系数（220dpi 实测几何 ×4——2mm 贴片 69px 过 gate 5 的 64px 下限）。 */
export const SCALE = 4;
/** cell 画布外扩（bbox=直径+2×PAD——贴片四周留白切格窗）。 */
export const PAD = 6;

/** 前缀列序（钰航七码 J..G——§2 行段表列序）。 */
export const PREFIXES = ['J', 'A', 'B', 'C', 'E', 'F', 'G'] as const;

/** 普通行（51-75 段）mm 档（§2 行段表：J=2 … G=10）。 */
export const NORMAL_MM = [2, 3, 4, 5, 6, 8, 10] as const;
/** 大钻行（76-78 段）mm 档（§2 行段表：J=12 … G=25）。 */
export const BIG_MM = [12, 14, 16, 18, 20, 22, 25] as const;

/** 钰航 SKU 三行段档案（card-text.txt 实证——行段漂移：J51→2mm / J76→12mm）。 */
export const YUHANG_BANDS = [
  { rows: [51, 75] as [number, number], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
  { rows: [76, 78] as [number, number], sizeMmByPrefix: { J: 12, A: 14, B: 16, C: 18, E: 20, F: 22, G: 25 } },
  { rows: [80, 89] as [number, number], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
];

/** page1 贴片列心（实测 ×SCALE）。 */
export const PAGE1_COL_X = [238, 368, 462, 684, 912, 1152, 1410].map((x) => x * SCALE);
/** page2 大钻行列心（实测锚点 G≈1650 + 保直径不重叠的内插列距 ×SCALE）。 */
export const PAGE2_BIG_COL_X = [232, 420, 640, 900, 1170, 1440, 1650].map((x) => x * SCALE);

/** 标签行 y（实测公式 ×SCALE）。 */
export function rowY(row: number): number {
  return (131 + 95 * (row - 51)) * SCALE;
}

/** 贴片直径 px（实测 mm×8.66 ×SCALE）。 */
export function diamPx(mm: number): number {
  return Math.round(mm * 8.66 * SCALE);
}

// ---------------------------------------------------------------- 页合成

export interface DrawCell {
  cx: number;
  cy: number;
  diameter: number;
  rgb: RgbTuple;
  /** 缺省圆（钻贴片）；方块=字形/模板污染用例（同尺寸同色跨格同字节）。 */
  shape?: 'circle' | 'square';
}

/** 白底页合成：纯白背景 + 居中色块（png codec 直绘——合成图足以驱动全管线）。 */
export function drawCardPage(width: number, height: number, cells: DrawCell[]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (const cell of cells) {
    const r = cell.diameter / 2;
    const x0 = Math.max(0, Math.floor(cell.cx - r));
    const x1 = Math.min(width - 1, Math.ceil(cell.cx + r));
    const y0 = Math.max(0, Math.floor(cell.cy - r));
    const y1 = Math.min(height - 1, Math.ceil(cell.cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cell.cx;
        const dy = y - cell.cy;
        const inside =
          cell.shape === 'square'
            ? Math.abs(dx) <= r && Math.abs(dy) <= r
            : dx * dx + dy * dy <= r * r;
        if (!inside) continue;
        const p = (y * width + x) * 4;
        rgba[p] = cell.rgb[0];
        rgba[p + 1] = cell.rgb[1];
        rgba[p + 2] = cell.rgb[2];
        rgba[p + 3] = 255;
      }
    }
  }
  return new Uint8Array(encodePng(width, height, rgba));
}

// ---------------------------------------------------------------- 草表构造

export interface DraftCellSpec {
  sku: string;
  cx: number;
  cy: number;
  diameter: number;
  rgb: RgbTuple;
  shape?: 'circle' | 'square';
  /** 显式覆写 bbox（坏输入用例：越界/重叠）；缺省由几何推导。 */
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface DraftStyleSpec {
  row: number;
  page: number;
  suggestedName: string;
  suggestedFamily: string;
  rgb: RgbTuple;
  confidence: number;
  cells: DraftCellSpec[];
}

export interface DraftBuildOptions {
  supplier?: string;
  /** 缺省单页 blobRef 占位（草表 schema 必填——pageImages 直供时不读取）。 */
  blobRef?: string;
  /** 显式页声明覆写（blob 单页回退用例：先定页尺寸再按尺寸画图，避免推导值≠画布）。 */
  pages?: { page: number; widthPx: number; heightPx: number }[];
}

/** 草表构造：页几何由 cells 推导（+20 边距；options.pages 显式覆写）；bbox 缺省=直径+2×PAD 居中方窗。 */
export function buildDraft(styles: DraftStyleSpec[], options: DraftBuildOptions = {}): CardCatalogDraft {
  const pageNumbers = [...new Set(styles.map((s) => s.page))];
  const pages =
    options.pages ??
    pageNumbers
      .sort((a, b) => a - b)
      .map((page) => {
        let w = 0;
        let h = 0;
        for (const s of styles) {
          if (s.page !== page) continue;
          for (const c of s.cells) {
            const side = c.diameter + 2 * PAD;
            w = Math.max(w, c.cx + side / 2);
            h = Math.max(h, c.cy + side / 2);
          }
        }
        return { page, widthPx: Math.ceil(w) + 20, heightPx: Math.ceil(h) + 20 };
      });
  const blobRef =
    options.blobRef ??
    createHash('sha256').update('stones-import-fixture-占位源图').digest('hex');
  return CardCatalogDraftSchema.parse({
    schemaVersion: 1,
    supplier: options.supplier ?? 'yuhang',
    sourceImage: { blobRef, pages },
    bands: YUHANG_BANDS,
    styles: styles.map((s) => ({
      row: s.row,
      suggestedName: s.suggestedName,
      suggestedFamily: s.suggestedFamily,
      rgb: s.rgb,
      confidence: s.confidence,
      cells: s.cells.map((c) => ({
        sku: c.sku,
        page: s.page,
        bboxPx: c.bbox ?? bboxOf(c),
      })),
    })),
  });
}

function bboxOf(c: DraftCellSpec): { x: number; y: number; w: number; h: number } {
  const side = c.diameter + 2 * PAD;
  return {
    x: Math.round(c.cx - side / 2),
    y: Math.round(c.cy - side / 2),
    w: side,
    h: side,
  };
}

// ---------------------------------------------------------------- 标准钰航 fixture

export interface StandardYuhangFixture {
  draft: CardCatalogDraft;
  pageImages: ReadonlyMap<number, Uint8Array>;
  /** 标准七格列（J..G × mm 档）——按页列心与行 y 生成 cell 规格。 */
  cellsOf(page: 1 | 2, row: number, mmList: readonly number[], rgb: RgbTuple): DrawCell[];
}

/**
 * 钰航标准样卡：page1 行 51 象牙白/52 珍珠白/53 低置信（空名+conf 0.5）；
 * page2 行 76 古铜金大钻行。28 cell 全链基线（含 band 漂移 J76→12mm）。
 */
export function buildStandardYuhangFixture(): StandardYuhangFixture {
  const ivory: RgbTuple = [240, 240, 232];
  const pearl: RgbTuple = [245, 242, 235];
  const lake: RgbTuple = [96, 168, 160];
  const bronze: RgbTuple = [176, 141, 87];
  const sevenCells = (page: 1 | 2, row: number, mmList: readonly number[], rgb: RgbTuple): DrawCell[] =>
    (page === 1 ? PAGE1_COL_X : PAGE2_BIG_COL_X).map((cx, i) => ({
      cx,
      cy: page === 1 ? rowY(row) : 1000, // page2 大钻行 y 取页首安全带（保直径不越界）
      diameter: diamPx(mmList[i]!),
      rgb,
    }));
  const styles: DraftStyleSpec[] = [
    { row: 51, page: 1, suggestedName: '象牙白', suggestedFamily: '白色系', rgb: ivory, confidence: 0.95, cells: asSpecs(51, sevenCells(1, 51, NORMAL_MM, ivory)) },
    { row: 52, page: 1, suggestedName: '珍珠白', suggestedFamily: '白色系', rgb: pearl, confidence: 0.9, cells: asSpecs(52, sevenCells(1, 52, NORMAL_MM, pearl)) },
    { row: 53, page: 1, suggestedName: '', suggestedFamily: '', rgb: lake, confidence: 0.5, cells: asSpecs(53, sevenCells(1, 53, NORMAL_MM, lake)) },
    { row: 76, page: 2, suggestedName: '古铜金', suggestedFamily: '大径行', rgb: bronze, confidence: 0.92, cells: asSpecs(76, sevenCells(2, 76, BIG_MM, bronze)) },
  ];
  const draft = buildDraft(styles);
  const pageNumbers = [...new Set(styles.map((s) => s.page))];
  const pageImages = new Map<number, Uint8Array>();
  for (const page of pageNumbers) {
    const pageStyleCells = styles.filter((s) => s.page === page).flatMap((s) => s.cells);
    const declared = draft.sourceImage.pages.find((p) => p.page === page)!;
    pageImages.set(
      page,
      drawCardPage(
        declared.widthPx,
        declared.heightPx,
        pageStyleCells.map((c) => ({ cx: c.cx, cy: c.cy, diameter: c.diameter, rgb: c.rgb, shape: c.shape })),
      ),
    );
  }
  return { draft, pageImages, cellsOf: sevenCells };
}

/** DrawCell → DraftCellSpec（sku=前缀+行号，J..G 列序）。 */
function asSpecs(row: number, cells: DrawCell[]): DraftCellSpec[] {
  return cells.map((c, i) => ({ sku: `${PREFIXES[i]}${row}`, ...c }));
}
