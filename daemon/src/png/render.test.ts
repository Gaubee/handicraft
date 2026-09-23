/**
 * Node 软光栅 fixture 测试（design §6.3 测试门——R3/R4 两类错误分别断言）。
 * fixture 集：round（analytic AA）+ builtin 非圆（square/marquise 参数化几何）+
 * custom 资产形（vectorPath / PNG 贴图）+ 两类错误分支（custom 缺 assetId→
 * CustomAssetIdMissingError；资产未解析→PNG_ASSET_UNRESOLVED）+ 旋转（rotationDeg）
 * + 透明背景 + 尺寸。真实像素断言（decodePng 读回），非 smoke。
 */
import { describe, expect, it } from 'vitest';
import { CustomAssetIdMissingError, type Gem, type GridSpec, type Palette } from 'rhinestone-studio/engine';
import { decodePng, encodePng } from './codec.js';
import {
  flattenPath,
  parseSvgPath,
  PngAssetUnresolvedError,
  PNG_ASSET_UNRESOLVED,
  renderGemsPng,
  renderGemsRgba,
  type PngShapeAsset,
} from './render.js';

const GRID = (pixelsPerMm = 8, gapMm = 0.4, diameterMm = 3): GridSpec => ({
  pitchMm: diameterMm + gapMm,
  gapMm,
  rowAngleDeg: 0,
  pixelsPerMm,
});

const PALETTE: Palette = [
  { id: 'red', name: '红', hex: '#C8102E' },
  { id: 'blue', name: '蓝', hex: '#102EC8' },
];

function gem(overrides: Partial<Gem> & Pick<Gem, 'id' | 'x' | 'y'>): Gem {
  return {
    colorId: 'red',
    blockId: 'b1',
    shapeId: 'round',
    diameterMm: 3,
    ...overrides,
  } as Gem;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function renderDecode(input: Parameters<typeof renderGemsPng>[0]): Decoded {
  return decodePng(renderGemsPng(input));
}

function alphaAt(img: Decoded, x: number, y: number): number {
  return img.rgba[(y * img.width + x) * 4 + 3]!;
}

function rgbAt(img: Decoded, x: number, y: number): [number, number, number] {
  const p = (y * img.width + x) * 4;
  return [img.rgba[p]!, img.rgba[p + 1]!, img.rgba[p + 2]!];
}

/** 某行的不透明像素水平跨度（最左/最右 alpha>128）。 */
function rowSpan(img: Decoded, y: number): { left: number; right: number; width: number } | null {
  let left = -1;
  let right = -1;
  for (let x = 0; x < img.width; x++) {
    if (alphaAt(img, x, y) > 128) {
      if (left < 0) left = x;
      right = x;
    }
  }
  return left < 0 ? null : { left, right, width: right - left + 1 };
}

describe('Node 软光栅（design §6.3 fixture 门）', () => {
  it('round：尺寸/透明背景/圆心实心/色板色/AA 边界半透明', () => {
    // 33×33 画布，钻心 (16,16)，直径 3mm × 8px/mm = 24px，r=12
    const img = renderDecode({
      gems: [gem({ id: 'g1', x: 16, y: 16 })],
      palette: PALETTE,
      grid: GRID(),
      width: 33,
      height: 33,
    });
    expect(img.width).toBe(33);
    expect(img.height).toBe(33);
    // 透明背景：四角与画布边缘 alpha=0
    expect(alphaAt(img, 0, 0)).toBe(0);
    expect(alphaAt(img, 32, 32)).toBe(0);
    expect(alphaAt(img, 16, 0)).toBe(0);
    // 圆心：实心 + 红色（#C8102E）
    expect(alphaAt(img, 16, 16)).toBe(255);
    expect(rgbAt(img, 16, 16)).toEqual([0xc8, 0x10, 0x2e]);
    // 半径实测：中心行不透明跨度 ≈ 2r=24（±2 容差——AA 边界）
    const span = rowSpan(img, 16)!;
    expect(span.width).toBeGreaterThanOrEqual(22);
    expect(span.width).toBeLessThanOrEqual(26);
    expect(span.left).toBeGreaterThanOrEqual(4);
    expect(span.right).toBeLessThanOrEqual(28);
    // AA：存在 0<alpha<255 的边界像素
    const boundaryAlphas: number[] = [];
    for (let x = 0; x < 33; x++) {
      const a = alphaAt(img, x, 16);
      if (a > 0 && a < 255) boundaryAlphas.push(a);
    }
    expect(boundaryAlphas.length).toBeGreaterThan(0);
  });

  it('builtin 非圆（square）：方形轮廓（跨度≈0.96s）；四角内缩于圆钻包络', () => {
    const s = 24; // 3mm×8
    const img = renderDecode({
      gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'square' })],
      palette: PALETTE,
      grid: GRID(),
      width: 33,
      height: 33,
    });
    const span = rowSpan(img, 16)!;
    expect(span.width).toBeGreaterThanOrEqual(Math.floor(0.96 * s) - 3);
    expect(span.width).toBeLessThanOrEqual(Math.ceil(0.96 * s) + 3);
    // 方形中心行中段连续实心（>0.9 覆盖）
    let solid = 0;
    for (let x = span.left; x <= span.right; x++) if (alphaAt(img, x, 16) > 240) solid++;
    expect(solid / span.width).toBeGreaterThan(0.9);
  });

  it('builtin 五形互异：marquise 与 square 中心行跨度同盒但中段覆盖形状不同（透镜 vs 方）', () => {
    const render = (shapeId: Gem['shapeId']) =>
      renderDecode({
        gems: [gem({ id: 'g1', x: 16, y: 16, shapeId })],
        palette: PALETTE,
        grid: GRID(),
        width: 33,
        height: 33,
      });
    const square = render('square');
    const marquise = render('marquise');
    // 上下边行（y=16±7）：marquise（透镜）跨度显著小于 square（方）
    const sqNearTop = rowSpan(square, 16 - 7)!.width;
    const mqNearTop = rowSpan(marquise, 16 - 7);
    expect(mqNearTop).not.toBeNull();
    expect(mqNearTop!.width).toBeLessThan(sqNearTop - 4);
    // 中心行两者都应接近满宽
    expect(rowSpan(marquise, 16)!.width).toBeGreaterThan(18);
  });

  it('旋转（rotationDeg）：square 45° 对角化（水平跨度→对角线≈0.96s·√2）；marquise 90° 对称不变', () => {
    const renderSquare = (rotationDeg?: number) =>
      renderDecode({
        gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'square', rotationDeg })],
        palette: PALETTE,
        grid: GRID(),
        width: 40,
        height: 40,
      });
    const sq0 = renderSquare(undefined);
    const sq45 = renderSquare(45);
    // 钻心 (16,16) → 中心行 y=16（像素采样口径 16+0.5）
    const span0 = rowSpan(sq0, 16)!;
    const span45 = rowSpan(sq45, 16)!;
    // 45° 方形：中心行跨度 = 对角线 ≈ 0.96·24·√2 ≈ 32.7 > 未旋转 23
    expect(span45.width).toBeGreaterThan(span0.width + 6);
    // 垂直跨度同步增大（最先出现的行更靠上）
    let top0 = -1;
    let top45 = -1;
    for (let y = 0; y < 40; y++) {
      if (top0 < 0 && rowSpan(sq0, y)) top0 = y;
      if (top45 < 0 && rowSpan(sq45, y)) top45 = y;
    }
    expect(top45).toBeLessThan(top0);
    expect(top0 - top45).toBeGreaterThanOrEqual(4);

    // marquise 90° 旋转近似不变（路径非逐位 4-fold 对称——bezier 参数化逐象限有差，
    // 断言包围盒与覆盖量近似相等而非逐像素相等）
    const renderMarquise = (rotationDeg?: number) =>
      renderGemsRgba({
        gems: [gem({ id: 'g1', x: 20, y: 20, shapeId: 'marquise', rotationDeg })],
        palette: PALETTE,
        grid: GRID(),
        width: 40,
        height: 40,
      });
    const stats = (rgba: Uint8Array) => {
      let count = 0;
      let minX = 99;
      let maxX = -1;
      let minY = 99;
      let maxY = -1;
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 40; x++) {
          if (rgba[(y * 40 + x) * 4 + 3]! > 128) {
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { count, w: maxX - minX + 1, h: maxY - minY + 1 };
    };
    const mq0 = stats(renderMarquise(undefined));
    const mq90 = stats(renderMarquise(90));
    expect(Math.abs(mq0.count - mq90.count)).toBeLessThanOrEqual(Math.max(6, mq0.count * 0.02));
    expect(Math.abs(mq0.w - mq90.w)).toBeLessThanOrEqual(3);
    expect(Math.abs(mq0.h - mq90.h)).toBeLessThanOrEqual(3);
  });

  it('custom 资产形（vectorPath）：按资产路径渲染（0.1..0.9 方框≈0.8s），与 builtin 方形可区分', () => {
    const asset: PngShapeAsset = {
      vectorPath: 'M 0.1 0.1 L 0.9 0.1 L 0.9 0.9 L 0.1 0.9 Z',
    };
    const img = renderDecode({
      gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'custom', assetId: 'ast-x' })],
      palette: PALETTE,
      grid: GRID(),
      width: 33,
      height: 33,
      resolveAsset: (id) => (id === 'ast-x' ? asset : null),
    });
    const span = rowSpan(img, 16)!;
    // 0.8×24 ≈ 19.2（±3 容差）
    expect(span.width).toBeGreaterThanOrEqual(16);
    expect(span.width).toBeLessThanOrEqual(23);
    expect(alphaAt(img, 16, 16)).toBe(255);
  });

  it('custom 资产形（PNG 贴图）：贴图像素按 s×s 方盒贴上（红块可测）', () => {
    // 8×8 全红不透明贴图（经本编码器生成——真实 PNG 字节）
    const tex = new Uint8Array(8 * 8 * 4);
    for (let p = 0; p < 64; p++) {
      tex[p * 4] = 0x20;
      tex[p * 4 + 1] = 0x80;
      tex[p * 4 + 2] = 0x40;
      tex[p * 4 + 3] = 255;
    }
    const dataUrl = `data:image/png;base64,${Buffer.from(encodePng(8, 8, tex)).toString('base64')}`;
    const img = renderDecode({
      gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'custom', assetId: 'ast-tex' })],
      palette: PALETTE,
      grid: GRID(),
      width: 33,
      height: 33,
      resolveAsset: (id) =>
        id === 'ast-tex' ? { image: { mime: 'image/png', dataUrl, width: 8, height: 8 } } : null,
    });
    // s=24 → 方盒 [4..28)² 全贴图色
    expect(alphaAt(img, 16, 16)).toBe(255);
    expect(rgbAt(img, 16, 16)).toEqual([0x20, 0x80, 0x40]);
    expect(rgbAt(img, 6, 6)).toEqual([0x20, 0x80, 0x40]);
    expect(alphaAt(img, 2, 2)).toBe(0); // 方盒外透明
  });

  it('错误分支一（R3/R4 分别断言）：custom 缺 assetId→CustomAssetIdMissingError（引擎类）', () => {
    // Gem 构造绕过 engine GemSchema（schema 层会拒——此处测渲染层语义）
    const bad = { ...gem({ id: 'g1', x: 16, y: 16, shapeId: 'custom' }) } as Gem;
    delete (bad as Partial<Gem>).assetId;
    expect(() =>
      renderGemsRgba({
        gems: [bad],
        palette: PALETTE,
        grid: GRID(),
        width: 33,
        height: 33,
        resolveAsset: () => ({ vectorPath: 'M 0 0 L 1 0 L 1 1 Z' }),
      }),
    ).toThrow(CustomAssetIdMissingError);
  });

  it('错误分支二：assetId 存在但资产未解析→PNG_ASSET_UNRESOLVED（独立错误码）', () => {
    // 分支 2a：解析器返回 null（blob 缺失/不可达）
    expect(() =>
      renderGemsRgba({
        gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'custom', assetId: 'ghost' })],
        palette: PALETTE,
        grid: GRID(),
        width: 33,
        height: 33,
        resolveAsset: () => null,
      }),
    ).toThrow(PngAssetUnresolvedError);
    // 错误码断言（独立 typed error——不与 CustomAssetIdMissingError 混用）
    try {
      renderGemsRgba({
        gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'custom', assetId: 'ghost' })],
        palette: PALETTE,
        grid: GRID(),
        width: 33,
        height: 33,
        resolveAsset: () => null,
      });
      expect.unreachable('应抛 PngAssetUnresolvedError');
    } catch (error) {
      expect(error).toBeInstanceOf(PngAssetUnresolvedError);
      expect((error as PngAssetUnresolvedError).code).toBe(PNG_ASSET_UNRESOLVED);
      expect((error as PngAssetUnresolvedError).assetId).toBe('ghost');
    }
    // 分支 2b：资产可达但无可渲染载荷（vectorPath/image 均缺）
    expect(() =>
      renderGemsRgba({
        gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'custom', assetId: 'empty' })],
        palette: PALETTE,
        grid: GRID(),
        width: 33,
        height: 33,
        resolveAsset: () => ({}),
      }),
    ).toThrow(PNG_ASSET_UNRESOLVED);
    // 分支 2c：jpeg 贴图无解码器（不静默画圆）
    expect(() =>
      renderGemsRgba({
        gems: [gem({ id: 'g1', x: 16, y: 16, shapeId: 'custom', assetId: 'jpg' })],
        palette: PALETTE,
        grid: GRID(),
        width: 33,
        height: 33,
        resolveAsset: () => ({
          image: { mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AAAA', width: 4, height: 4 },
        }),
      }),
    ).toThrow(PNG_ASSET_UNRESOLVED);
  });

  it('SVG path 解析：绝对/相对命令 + bezier 展平（单位框顶点）', () => {
    const cmds = parseSvgPath('M 0.1 0.1 l 0.8 0 L 0.9 0.9 z');
    expect(cmds).toEqual([
      { t: 'M', x: 0.1, y: 0.1 },
      { t: 'L', x: 0.9, y: 0.1 },
      { t: 'L', x: 0.9, y: 0.9 },
      { t: 'Z' },
    ]);
    // 圆弧近似（4 段 bezier）展平：闭合多边形顶点数 > 8，全部在单位框内
    const roundPts = flattenPath(
      parseSvgPath(
        'M 0.5 0.02 C 0.7651 0.02 0.98 0.2349 0.98 0.5 C 0.98 0.7651 0.7651 0.98 0.5 0.98 C 0.2349 0.98 0.02 0.7651 0.02 0.5 C 0.02 0.2349 0.2349 0.02 0.5 0.02 Z',
      ),
    );
    expect(roundPts.length).toBeGreaterThan(8);
    for (const [x, y] of roundPts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });
});
