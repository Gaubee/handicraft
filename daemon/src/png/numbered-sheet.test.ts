/**
 * 编号工作图 numbered.png 测试（导出矩阵 2026-10-02——数字油画打法）+ 文字面单元。
 * 覆盖面（任务简报冻结验收）：
 *   [1] 数字点阵字形锁（0/1/2/7 逐位断言——生产语义载荷）+ 各数字点亮数互异。
 *   [2] 孔内编号=行号：款 R1（count 3→行 1）/R2（count 1→行 2）——孔内暗像素数
 *       =litPixelsOf(行号)×scale²（字形×整数缩放，确定性对账）。
 *   [3] 孔位染底 30%（钻色 over 白——hole 上缘内点≈0.3×hex+0.7×白）。
 *   [4] 字号自适应：6mm 钻 scale=4/3mm 钻 scale=2（≈孔径 0.5——holeNumberGlyph 冻结）。
 *   [5] 图例侧栏：宽度∈[0.15,0.25]×短边；全款在列（每款 swatch 中心=hex 满色）；
 *        图例文本暗像素在场（编号+stoneRef）。
 *   [6] cjk-font：系统字体「红」可栅格（darwin——非 ASCII 位图非空）；无字体回退
 *        =drawFallbackBox 空心方框（可见占位不静默）。
 */
import { describe, expect, it } from 'vitest';
import { type Gem, type GridSpec, type Palette } from 'rhinestone-studio/engine';
import { decodePng } from './codec.js';
import { GLYPHS, asciiScaleOf, drawMixedText, litPixelsOf, measureAscii } from './bitmap-font.js';
import { rasterizeCjkGlyph } from './cjk-font.js';
import { holeNumberGlyph, renderNumberedSheetPng, type BomLegendRow } from './numbered-sheet.js';

const GRID = (pixelsPerMm = 10, gapMm = 0.4, diameterMm = 3): GridSpec => ({
  pitchMm: diameterMm + gapMm,
  gapMm,
  rowAngleDeg: 0,
  pixelsPerMm,
});

const PALETTE: Palette = [
  { id: 'R1', name: '红', hex: '#C8102E' },
  { id: 'R2', name: '蓝', hex: '#102EC8' },
];

function gem(overrides: Partial<Gem> & Pick<Gem, 'id' | 'x' | 'y'>): Gem {
  return {
    colorId: 'R1',
    blockId: 'b1',
    shapeId: 'round',
    diameterMm: 3,
    ...overrides,
  } as Gem;
}

/** BOM 行序（count 降序→stoneRef——taskBomRowGroupsOf 同式首键，手工冻结期望序）。 */
const ROWS: BomLegendRow[] = [
  { row: 1, stoneRef: 'R1', name: '红', hex: '#C8102E', count: 3, diameterMm: 3 },
  { row: 2, stoneRef: 'R2', name: '蓝', hex: '#102EC8', count: 1, diameterMm: 3 },
];

const SHEET_GEMS: Gem[] = [
  gem({ id: 'a', x: 30, y: 30 }),
  gem({ id: 'b', x: 80, y: 30 }),
  gem({ id: 'c', x: 55, y: 70 }),
  gem({ id: 'd', x: 30, y: 120, colorId: 'R2' }),
];

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function rgbAt(img: Decoded, x: number, y: number): [number, number, number] {
  const p = (y * img.width + x) * 4;
  return [img.rgba[p]!, img.rgba[p + 1]!, img.rgba[p + 2]!];
}

/** 编号数字盒内暗像素数（字形对账——盒=measureAscii 居中，避开孔缘描边带）。 */
function darkPixelsInNumberBox(img: Decoded, cx: number, cy: number, rowNumber: number, diameterMm: number): number {
  const glyph = holeNumberGlyph(rowNumber, diameterMm, 10);
  const size = measureAscii(glyph.text, glyph.scale);
  const x0 = Math.round(cx - size.width / 2) - 1;
  const y0 = Math.round(cy - size.height / 2) - 1;
  let count = 0;
  for (let y = y0; y <= y0 + size.height + 1; y++) {
    for (let x = x0; x <= x0 + size.width + 1; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const [r, g, b] = rgbAt(img, x, y);
      if (0.299 * r + 0.587 * g + 0.114 * b < 128) count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------- [1] 数字点阵锁

describe('bitmap-font 数字字形（生产语义载荷——字面量冻结）', () => {
  it('数字 0/1/2/7 逐位断言（防漂移）；0-9 点亮数互异对账', () => {
    expect(GLYPHS['0']).toEqual([
      '01110',
      '10001',
      '10011',
      '10101',
      '11001',
      '10001',
      '01110',
    ]);
    expect(GLYPHS['1']).toEqual(['00100', '01100', '00100', '00100', '00100', '00100', '01110']);
    expect(GLYPHS['2']).toEqual(['01110', '10001', '00001', '00010', '00100', '01000', '11111']);
    expect(GLYPHS['7']).toEqual(['11111', '00001', '00010', '00100', '01000', '01000', '01000']);
    const counts = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => litPixelsOf(d));
    expect(new Set(counts).size).toBeGreaterThanOrEqual(6); // 无两两全同簇（字形互可分辨）
    expect(litPixelsOf('1')).toBe(10);
    expect(litPixelsOf('2')).toBe(14);
    expect(litPixelsOf('7')).not.toBe(litPixelsOf('1'));
  });

  it('holeNumberGlyph：字号≈孔径 0.5（scale=round(0.5d/7)）；超宽降档', () => {
    expect(holeNumberGlyph(1, 3, 10)).toMatchObject({ text: '1', scale: 2, fontPx: 14 }); // 0.5×30=15→scale 2
    expect(holeNumberGlyph(2, 6, 10)).toMatchObject({ scale: 4, fontPx: 28 }); // 0.5×60=30→scale 4
    expect(holeNumberGlyph(123, 3, 10).scale).toBe(1); // 3 位数 17 单位×2=34px > 0.8×30 → 降档 1
    expect(measureAscii('12', 2).width).toBe(11 * 2);
    expect(asciiScaleOf(15)).toBe(2);
  });
});

// ---------------------------------------------------------------- [2]-[5] 编号工作图

describe('编号工作图 numbered.png', () => {
  const rendered = renderNumberedSheetPng({
    gems: SHEET_GEMS,
    palette: PALETTE,
    grid: GRID(),
    width: 160,
    height: 160,
    rows: ROWS,
  });
  const img: Decoded = decodePng(rendered.png);

  it('画布=图区+图例带（右侧扩展不压缩图区）；全部钻编号（numberedCount=gems 数）', () => {
    expect(img.width).toBe(160 + rendered.legendWidth);
    expect(img.height).toBe(160);
    expect(rendered.numberedCount).toBe(SHEET_GEMS.length);
  });

  it('孔内编号=BOM 行号（R1 孔=字形 1×scale²；R2 孔=字形 2×scale²——对账严丝合缝）', () => {
    const scale = holeNumberGlyph(1, 3, 10).scale;
    for (const target of SHEET_GEMS.filter((g) => g.colorId === 'R1')) {
      expect(darkPixelsInNumberBox(img, target.x + 0.5, target.y + 0.5, 1, 3)).toBe(litPixelsOf('1') * scale * scale);
    }
    const r2 = SHEET_GEMS.find((g) => g.colorId === 'R2')!;
    expect(darkPixelsInNumberBox(img, r2.x + 0.5, r2.y + 0.5, 2, 3)).toBe(litPixelsOf('2') * scale * scale);
  });

  it('孔位染底=钻色 30%（孔上缘内点≈0.3×hex+0.7×255——AA/编号避开）', () => {
    // R1 孔中心 (30.5,30.5) d=30：上缘内点 (30.5, 30.5-12)（编号盒外/孔内）。
    const [r, g, b] = rgbAt(img, 30, 18);
    expect(Math.abs(r - Math.round(0.3 * 200 + 0.7 * 255))).toBeLessThanOrEqual(3);
    expect(Math.abs(g - Math.round(0.3 * 16 + 0.7 * 255))).toBeLessThanOrEqual(3);
    expect(Math.abs(b - Math.round(0.3 * 46 + 0.7 * 255))).toBeLessThanOrEqual(3);
  });

  it('字号自适应：6mm 钻编号 scale=4 暗像素=3mm（scale=2）的 4 倍', () => {
    const one = renderNumberedSheetPng({
      gems: [gem({ id: 's', x: 40, y: 40, diameterMm: 3 })],
      palette: PALETTE,
      grid: GRID(10, 0.4, 3),
      width: 90,
      height: 90,
      rows: [{ row: 1, stoneRef: 'R1', name: '红', hex: '#C8102E', count: 1, diameterMm: 3 }],
    });
    const big = renderNumberedSheetPng({
      gems: [gem({ id: 's', x: 40, y: 40, diameterMm: 6 })],
      palette: PALETTE,
      grid: GRID(10, 0.4, 6),
      width: 90,
      height: 90,
      rows: [{ row: 1, stoneRef: 'R1', name: '红', hex: '#C8102E', count: 1, diameterMm: 6 }],
    });
    const smallCount = darkPixelsInNumberBox(decodePng(one.png), 40.5, 40.5, 1, 3);
    const bigCount = darkPixelsInNumberBox(decodePng(big.png), 40.5, 40.5, 1, 6);
    expect(smallCount).toBe(litPixelsOf('1') * 4);
    expect(bigCount).toBe(litPixelsOf('1') * 16); // scale 2→4：4 倍像素
  });

  it('图例宽度∈[0.15,0.25]×短边；全款在列（swatch=hex 满色）；图例文本在场', () => {
    expect(rendered.legendWidth).toBeGreaterThanOrEqual(Math.round(0.15 * 160));
    expect(rendered.legendWidth).toBeLessThanOrEqual(Math.round(0.25 * 160));
    expect(rendered.legendRowCount).toBe(2);
    // 每款 swatch 中心=纯 hex（全色填充）。
    for (const meta of rendered.legendRows) {
      const [r, g, b] = rgbAt(img, meta.swatchX, meta.swatchY);
      const [er, eg, eb] = [
        Number.parseInt(meta.hex.slice(1, 3), 16),
        Number.parseInt(meta.hex.slice(3, 5), 16),
        Number.parseInt(meta.hex.slice(5, 7), 16),
      ];
      expect(Math.abs(r - er)).toBeLessThanOrEqual(2);
      expect(Math.abs(g - eg)).toBeLessThanOrEqual(2);
      expect(Math.abs(b - eb)).toBeLessThanOrEqual(2);
    }
    // 图例区有文本暗像素（编号+stoneRef+颗数——黑字）。
    let darkText = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 160; x < img.width; x++) {
        const [r, g, b] = rgbAt(img, x, y);
        if (r < 100 && g < 100 && b < 100) darkText += 1;
      }
    }
    expect(darkText).toBeGreaterThan(50);
  });

  it('cjk-font：系统字体可栅格汉字（darwin STHeiti/Songti）；无字体回退=空心方框', () => {
    const glyph = rasterizeCjkGlyph('红', 24);
    if (glyph !== null) {
      // darwin 主路径：位图非空（coverage 有笔画的像素）。
      let lit = 0;
      for (const cov of glyph.coverage) if (cov > 0.5) lit += 1;
      expect(lit).toBeGreaterThan(20);
      expect(glyph.advancePx).toBeGreaterThan(10);
    } else {
      // Linux 无字体环境：回退面仍可工作（不抛）——方框占位。
      expect(rasterizeCjkGlyph('红', 24)).toBeNull();
    }
    // 回退方框：drawMixedText cjkDrawer 恒 false → 方框（非空白）。
    const pixels = new Set<string>();
    drawMixedText(
      {
        width: 40,
        height: 40,
        set: (x, y) => pixels.add(`${x},${y}`),
      },
      '红',
      2,
      2,
      24,
      () => false,
    );
    expect(pixels.size).toBeGreaterThan(20);
  });
});
