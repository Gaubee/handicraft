/**
 * 编号工作图渲染器（导出矩阵 2026-10-02——客户「数字油画打法」形态）。
 * 客户习惯参照（主仓 docs/客户工作流分析报告.md §1「编号工作图：点内编号+图例」）：
 *   - 孔位淡色染底（钻色 30% 透明度）+ **孔内编号**＝BOM 行号 1..N（与 BOM CSV 行号
 *     严格一致——task-export taskBomRowGroupsOf 单源分组排序注入，对账严丝合缝）；
 *     编号字号≈孔径 0.5（钻径 3mm@ppm 口径自适应——清晰可读优先，超宽降档）。
 *   - 孔形按钻形（gem-shapes 单源——与 holes.png 完全同形）；AA 边带以满色描边
 *     （浅色钻在白底上的孔缘可见性——「清晰可读优先」裁量）。
 *   - 图例侧栏（画布右侧留白带——**画布扩展而非压缩图区**）：每编号一行＝编号数字
 *     +贴图缩略（钻库贴图 PNG 缩放绘制进图例格——走查 2026-10-02 升级；无贴图/
 *     解码失败回退色点，历史数据不阻断）+stoneRef（Owner：「编号对应的 ID 写出来」）
 *     +款名+颗数＝BOM 表图形化；图例宽度自适应（画布短边 15%-25%，内容驱动，超限
 *     降字号再截断）。
 * 文本面：编号/stoneRef/颗数全 ASCII（bitmap-font 点阵——确定性，零系统依赖）；
 * 款名等中文走 cjk-font 系统字体最佳努力，再降级＝空心方框占位（不静默丢字）。
 */
import { findPaletteColor, type Gem, type GridSpec, type Palette } from 'rhinestone-studio/engine';
import { decodePng, encodePng, type DecodedPng } from './codec.js';
import { rasterizeCjkGlyph } from './cjk-font.js';
import { gemHoleRaster, holeOwnerOf } from './gem-shapes.js';
import type { ResolveShapeAsset } from './render.js';
import type { ResolveStoneTexture } from './texture-render.js';
import { asciiScaleOf, drawAsciiText, drawMixedText, measureAscii, measureMixedText } from './bitmap-font.js';

/** 图例行（BOM 行图形化——行号权威源=task-export taskBomRowGroupsOf）。 */
export interface BomLegendRow {
  row: number;
  stoneRef: string;
  /** 款名（palette 色名——中文经 cjk-font）。 */
  name: string;
  hex: string;
  count: number;
  diameterMm: number;
}

export interface NumberedSheetInput {
  gems: Gem[];
  palette: Palette;
  grid: GridSpec;
  width: number;
  height: number;
  /** BOM 行序（行号权威——numbered 与 BOM CSV 同源对账）。 */
  rows: BomLegendRow[];
  resolveAsset?: ResolveShapeAsset;
  /**
   * 钻库贴图解析（图例贴图缩略——走查 2026-10-02：图例格=贴图 PNG 缩放绘制，
   * 色点仅作无贴图/解码失败回退）。缺席=全部回退色点（既有渲染面兼容）。
   */
  resolveStoneTexture?: ResolveStoneTexture;
}

export interface NumberedSheetResult {
  png: Uint8Array;
  /** 图例带宽（px——画布向右扩展量）。 */
  legendWidth: number;
  legendFontPx: number;
  legendRowCount: number;
  /** 编号成功颗数（rows 覆盖面对账——正常=gems 数）。 */
  numberedCount: number;
  /** 图例行绘制坐标（测试/诊断面——thumb=该行用了贴图缩略 false=色点回退）。 */
  legendRows: Array<{
    row: number;
    stoneRef: string;
    hex: string;
    count: number;
    swatchX: number;
    swatchY: number;
    swatchSize: number;
    thumb: boolean;
  }>;
}

/** 孔内编号字形（纯函数——字号≈孔径 0.5，超宽 0.8×孔径降档；测试对账面）。 */
export function holeNumberGlyph(
  number: number,
  diameterMm: number,
  pixelsPerMm: number,
): { text: string; scale: number; fontPx: number } {
  const text = String(number);
  const d = diameterMm * pixelsPerMm;
  let scale = asciiScaleOf(0.5 * d);
  while (scale > 1 && measureAscii(text, scale).width > 0.8 * d) {
    scale -= 1;
  }
  return { text, scale, fontPx: 7 * scale };
}

// ---------------------------------------------------------------- 内部：画布

class RgbaCanvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4).fill(255); // 白底不透明
  }
  /** 黑字 source-over（alpha 0..1——bitmap-font 绘制面接口）。 */
  set(x: number, y: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const d = (y * this.width + x) * 4;
    const keep = 1 - alpha;
    this.data[d] = Math.round(this.data[d]! * keep);
    this.data[d + 1] = Math.round(this.data[d + 1]! * keep);
    this.data[d + 2] = Math.round(this.data[d + 2]! * keep);
  }
  /** RGBA source-over（alpha 0..1——贴图缩略绘制面；rgb 取值 0..255 浮点）。 */
  blend(x: number, y: number, r: number, g: number, b: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const d = (y * this.width + x) * 4;
    const keep = 1 - alpha;
    this.data[d] = Math.round(r * alpha + this.data[d]! * keep);
    this.data[d + 1] = Math.round(g * alpha + this.data[d + 1]! * keep);
    this.data[d + 2] = Math.round(b * alpha + this.data[d + 2]! * keep);
  }
  /** 色点（analytic AA 圆——描边环）。 */
  fillCircle(cx: number, cy: number, r: number, rgb: [number, number, number], alpha: number): void {
    if (!(r > 0)) return;
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(this.height - 1, Math.ceil(cy + r + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(this.width - 1, Math.ceil(cx + r + 1)); x++) {
        const dist = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
        const cov = Math.max(0, Math.min(1, r + 0.5 - dist));
        if (cov <= 0) continue;
        const d = (y * this.width + x) * 4;
        const a = cov * alpha;
        this.data[d] = Math.round(rgb[0] * a + this.data[d]! * (1 - a));
        this.data[d + 1] = Math.round(rgb[1] * a + this.data[d + 1]! * (1 - a));
        this.data[d + 2] = Math.round(rgb[2] * a + this.data[d + 2]! * (1 - a));
      }
    }
  }
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

// ---------------------------------------------------------------- 图例贴图缩略（2026-10-02 走查）

/** 贴图缩略解析产物（alpha 内容盒为采样源——texture-render placements 同口径）。 */
interface LegendThumb {
  decoded: DecodedPng;
  src: { x: number; y: number; w: number; h: number };
}

/**
 * 行 stoneRef → 贴图缩略源（resolver 缺席/无贴图/解码失败=null——回退色点，不
 * 阻断导出）。按 stoneRef 记忆化（同款多规格行不重复解析/解码）。
 */
function legendThumbOf(
  stoneRef: string,
  resolveStoneTexture: ResolveStoneTexture | undefined,
  cache: Map<string, LegendThumb | null>,
): LegendThumb | null {
  if (cache.has(stoneRef)) return cache.get(stoneRef)!;
  let out: LegendThumb | null = null;
  const source = resolveStoneTexture?.(stoneRef) ?? null;
  if (source !== null) {
    try {
      const decoded = decodePng(source.bytes);
      out = { decoded, src: source.alphaBounds ?? { x: 0, y: 0, w: decoded.width, h: decoded.height } };
    } catch {
      out = null; // 贴图字节损坏（隔行/截断）＝回退色点（render.png warnings 面已另有明示）
    }
  }
  cache.set(stoneRef, out);
  return out;
}

/**
 * 贴图缩略绘制进图例格：src 内容盒 contain 适配进半径 r 的圆内（纵横比保持
 * ——窄边让位），目标像素→源矩形 box 平均降采样（大幅缩小无噪点；预乘平均
 * ——软 alpha 边无深色光晕，texture-render 降采样同式）+圆形裁剪（与色点同
 * 视觉节奏）。contain 外/全透明源＝保持底色不写像素。
 */
function drawLegendThumb(
  canvas: RgbaCanvas,
  cx: number,
  cy: number,
  r: number,
  thumb: LegendThumb,
): void {
  const { decoded, src } = thumb;
  if (src.w <= 0 || src.h <= 0) return;
  const aspect = src.w / src.h;
  const safeAspect = Number.isFinite(aspect) && aspect > 0.1 && aspect < 10 ? aspect : 1;
  const box = 2 * (r - 1); // 描边环内侧再收 1px
  const bw = safeAspect >= 1 ? box : box * safeAspect;
  const bh = safeAspect >= 1 ? box / safeAspect : box;
  if (bw <= 0 || bh <= 0) return;
  const du = src.w / bw;
  const dv = src.h / bh;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const lx = x + 0.5 - cx;
      const ly = y + 0.5 - cy;
      if (lx * lx + ly * ly > r * r) continue; // 圆形裁剪
      if (Math.abs(lx) > bw / 2 || Math.abs(ly) > bh / 2) continue; // contain 外=底色
      // 目标像素中心 → 源矩形（宽 du×dv 的 box 平均）。
      const u = src.x + (lx / bw + 0.5) * src.w;
      const v = src.y + (ly / bh + 0.5) * src.h;
      const sx0 = Math.max(0, Math.floor(u - du / 2));
      const sx1 = Math.min(decoded.width, Math.max(sx0 + 1, Math.ceil(u + du / 2)));
      const sy0 = Math.max(0, Math.floor(v - dv / 2));
      const sy1 = Math.min(decoded.height, Math.max(sy0 + 1, Math.ceil(v + dv / 2)));
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = (sy * decoded.width + sx) * 4;
          const a = decoded.rgba[p + 3]! / 255;
          pr += decoded.rgba[p]! * a;
          pg += decoded.rgba[p + 1]! * a;
          pb += decoded.rgba[p + 2]! * a;
          pa += a;
          n += 1;
        }
      }
      if (pa <= 0 || n === 0) continue; // 全透明源区=底色
      canvas.blend(x, y, pr / pa, pg / pa, pb / pa, pa / n);
    }
  }
}

// ---------------------------------------------------------------- 图例排版

interface LegendLayout {
  legendWidth: number;
  fontPx: number;
  rowH: number;
  numColX: number; // 编号列右缘
  swatchX: number;
  textX: number;
  swatchSize: number;
  titleY: number;
  rowsStartY: number;
  maxTextWidth: number;
}

function layoutLegend(width: number, height: number, rows: BomLegendRow[]): LegendLayout {
  const short = Math.min(width, height);
  const minW = Math.round(short * 0.15);
  const maxW = Math.round(short * 0.25);
  let fontPx = Math.max(11, Math.min(26, Math.round(short / 32)));
  const cjkMeasure = (char: string): boolean => rasterizeCjkGlyph(char, 20) !== null;
  for (;;) {
    const pad = Math.max(6, Math.round(fontPx * 0.6));
    const gap = Math.max(6, Math.round(fontPx * 0.5));
    const numStr = String(Math.max(...rows.map((row) => row.row), 1));
    const numCol = measureAscii(numStr, asciiScaleOf(fontPx)).width;
    const swatchSize = Math.round(fontPx * 1.6);
    const rowH = Math.round(fontPx * 2.4);
    const textLines = rows.map((row) => [
      measureMixedText(row.stoneRef, fontPx, cjkMeasure).width,
      measureMixedText(`${row.name} x${row.count}`, fontPx, cjkMeasure).width,
    ]);
    const textCol = Math.max(1, ...textLines.flat());
    const neededWidth = pad + numCol + gap + swatchSize + gap + textCol + pad;
    const titleH = Math.round(fontPx * 1.8);
    const footerH = Math.round(fontPx * 1.8);
    const neededHeight = titleH + rows.length * rowH + footerH + pad * 2;
    if ((neededWidth <= maxW && neededHeight <= height) || fontPx <= 9) {
      const legendWidth = Math.max(minW, Math.min(maxW, neededWidth));
      const maxTextWidth = legendWidth - (pad + numCol + gap + swatchSize + gap + pad);
      return {
        legendWidth,
        fontPx,
        rowH,
        numColX: pad + numCol,
        swatchX: pad + numCol + gap,
        textX: pad + numCol + gap + swatchSize + gap,
        swatchSize,
        titleY: pad,
        rowsStartY: pad + titleH,
        maxTextWidth,
      };
    }
    fontPx -= 1;
  }
}

/** 图例文本截断（超宽时保 stoneRef 前缀+'..'——可见截断不静默）。 */
function truncateToWidth(text: string, fontPx: number, maxWidth: number): string {
  if (measureMixedText(text, fontPx, () => false).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measureMixedText(`${out}..`, fontPx, () => false).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}..`;
}

// ---------------------------------------------------------------- 主函数

export function renderNumberedSheetPng(input: NumberedSheetInput): NumberedSheetResult {
  const { gems, palette, grid, width: W, height: H } = input;
  const rows = input.rows;
  const legend = layoutLegend(W, H, rows);
  const canvas = new RgbaCanvas(W + legend.legendWidth, H);

  // —— 图区：孔位染底（30%）+ AA 边带满色描边 + 孔内编号。
  const { coverage, owner } = gemHoleRaster({ gems, grid, width: W, height: H, resolveAsset: input.resolveAsset });
  const rgbByRef = new Map<string, [number, number, number]>();
  for (const gem of gems) {
    if (!rgbByRef.has(gem.colorId)) {
      const entry = findPaletteColor(palette, gem.colorId);
      rgbByRef.set(gem.colorId, entry ? hexToRgb(entry.hex) : [0x9c, 0xaf, 0xaf]);
    }
  }
  for (let p = 0; p < W * H; p++) {
    const cov = coverage[p]!;
    if (cov <= 0.01) continue;
    const gemIndex = holeOwnerOf(owner, p);
    if (gemIndex < 0 || gemIndex >= gems.length) continue;
    const rgb = rgbByRef.get(gems[gemIndex]!.colorId)!;
    // canvas 行跨=canvas.width（图区+图例带）——p 是 W 步进行，需换算列。
    const d = (Math.floor(p / W) * canvas.width + (p % W)) * 4;
    // AA 边带（0.1<cov<0.9）＝满色描边；内部＝钻色 30% 染底（cov 加权）。
    const alpha = cov < 0.9 && cov > 0.1 ? cov : 0.3 * cov;
    for (let ch = 0; ch < 3; ch++) {
      canvas.data[d + ch] = Math.round(rgb[ch]! * alpha + 255 * (1 - alpha));
    }
  }
  // —— 孔内编号（BOM 行号——rows 权威注入）。
  const rowByGemKey = new Map<string, number>();
  for (const row of rows) rowByGemKey.set(`${row.stoneRef}\u0000${row.diameterMm}`, row.row);
  let numberedCount = 0;
  for (const gem of gems) {
    const rowNumber = rowByGemKey.get(`${gem.colorId}\u0000${gem.diameterMm}`);
    if (rowNumber === undefined) continue; // rows 未覆盖（调用方契约破坏——孔仍渲染，编号缺席）
    const glyph = holeNumberGlyph(rowNumber, gem.diameterMm, grid.pixelsPerMm);
    const size = measureAscii(glyph.text, glyph.scale);
    const x0 = Math.round(gem.x + 0.5 - size.width / 2);
    const y0 = Math.round(gem.y + 0.5 - size.height / 2);
    drawAsciiText(canvas, glyph.text, x0, y0, glyph.scale);
    numberedCount += 1;
  }

  // —— 分隔线 + 图例侧栏。
  for (let y = 0; y < H; y++) {
    for (let x = W; x < W + 2; x++) {
      const d = (y * canvas.width + x) * 4;
      canvas.data[d] = 0xbb;
      canvas.data[d + 1] = 0xbb;
      canvas.data[d + 2] = 0xbb;
    }
  }
  const cjkDrawer = (char: string, x: number, y: number, sizePx: number): boolean => {
    const glyph = rasterizeCjkGlyph(char, sizePx);
    if (glyph === null) return false;
    for (let gy = 0; gy < glyph.height; gy++) {
      for (let gx = 0; gx < glyph.width; gx++) {
        const cov = glyph.coverage[gy * glyph.width + gx]!;
        if (cov > 0.05) canvas.set(x + gx, y + gy, cov);
      }
    }
    return true;
  };
  const drawLine = (text: string, x: number, y: number): void => {
    drawMixedText(canvas, text, x, y, legend.fontPx, cjkDrawer);
  };
  drawLine('编号图例', W + legend.textX, legend.titleY);
  const legendRowsMeta: NumberedSheetResult['legendRows'] = [];
  const thumbCache = new Map<string, LegendThumb | null>();
  rows.forEach((row, index) => {
    const y0 = legend.rowsStartY + index * legend.rowH;
    // 编号（右对齐于编号列）
    const numText = String(row.row);
    const numSize = measureAscii(numText, asciiScaleOf(legend.fontPx));
    drawAsciiText(canvas, numText, legend.numColX - numSize.width, y0 + Math.round(legend.rowH * 0.15), asciiScaleOf(legend.fontPx));
    // 贴图缩略（黑描边环+白底+贴图 contain 圆形裁剪）；无贴图/解码失败回退色点
    // （hex 满色——历史数据兼容）。
    const thumb = legendThumbOf(row.stoneRef, input.resolveStoneTexture, thumbCache);
    const rgb = hexToRgb(row.hex);
    const cx = W + legend.swatchX + legend.swatchSize / 2;
    const cy = y0 + legend.rowH / 2;
    canvas.fillCircle(cx, cy, legend.swatchSize / 2, [0, 0, 0], 1);
    if (thumb !== null) {
      canvas.fillCircle(cx, cy, legend.swatchSize / 2 - 1.5, [255, 255, 255], 1);
      drawLegendThumb(canvas, cx, cy, legend.swatchSize / 2 - 1.5, thumb);
    } else {
      canvas.fillCircle(cx, cy, legend.swatchSize / 2 - 1.5, rgb, 1);
    }
    legendRowsMeta.push({
      row: row.row,
      stoneRef: row.stoneRef,
      hex: row.hex,
      count: row.count,
      swatchX: Math.round(cx),
      swatchY: Math.round(cy),
      swatchSize: legend.swatchSize,
      thumb: thumb !== null,
    });
    // 文本两行：stoneRef / 款名 x 颗数（超宽截断）
    const line1 = truncateToWidth(row.stoneRef, legend.fontPx, legend.maxTextWidth);
    const line2 = truncateToWidth(`${row.name} x${row.count}`, legend.fontPx, legend.maxTextWidth);
    const lineH = Math.round(legend.fontPx * 1.15);
    drawLine(line1, W + legend.textX, y0 + Math.round(legend.rowH * 0.08));
    drawLine(line2, W + legend.textX, y0 + Math.round(legend.rowH * 0.08) + lineH);
  });
  const totalGems = rows.reduce((sum, row) => sum + row.count, 0);
  drawLine(`合计 x${totalGems}`, W + legend.textX, legend.rowsStartY + rows.length * legend.rowH + Math.round(legend.fontPx * 0.4));

  return {
    png: encodePng(canvas.width, canvas.height, canvas.data),
    legendWidth: legend.legendWidth,
    legendFontPx: legend.fontPx,
    legendRowCount: rows.length,
    numberedCount,
    legendRows: legendRowsMeta,
  };
}
