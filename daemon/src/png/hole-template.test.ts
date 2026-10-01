/**
 * 黑点模板 holes.png 测试（导出矩阵 2026-10-02——客户挖孔形态）。
 * 覆盖面（任务简报冻结验收）：
 *   [1] 孔数=gems 数（连通域计数）；白底（1-bit 语义——每像素恰为纯黑或纯白）。
 *   [2] 孔径=钻径 1:1（圆孔水平跨度≈diameterMm×ppm，±2px 判定带）。
 *   [3] 异形旋转：square 旋转 45° 黑像素 bbox 对角扩张（≈s√2）。
 *   [4] custom vectorPath=轮廓孔（三角形质心黑、盒角白）；custom 仅贴图资产=方形包络孔。
 */
import { describe, expect, it } from 'vitest';
import { type Gem, type GridSpec } from 'rhinestone-studio/engine';
import { decodePng, encodePng } from './codec.js';
import { renderHoleTemplatePng } from './hole-template.js';
import type { PngShapeAsset } from './render.js';

const GRID = (pixelsPerMm = 10, gapMm = 0.4, diameterMm = 3): GridSpec => ({
  pitchMm: diameterMm + gapMm,
  gapMm,
  rowAngleDeg: 0,
  pixelsPerMm,
});

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

function isBlack(img: Decoded, x: number, y: number): boolean {
  const p = (y * img.width + x) * 4;
  return img.rgba[p]! < 128 && img.rgba[p + 1]! < 128 && img.rgba[p + 2]! < 128;
}

/** 黑像素连通域数（4 邻接 flood fill——孔数对账）。 */
function countComponents(img: Decoded): number {
  const seen = new Uint8Array(img.width * img.height);
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (seen[y * img.width + x] || !isBlack(img, x, y)) continue;
      count += 1;
      const queue: [number, number][] = [[x, y]];
      seen[y * img.width + x] = 1;
      while (queue.length > 0) {
        const [cx, cy] = queue.pop()!;
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as [number, number][]) {
          if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
          if (seen[ny * img.width + nx] || !isBlack(img, nx, ny)) continue;
          seen[ny * img.width + nx] = 1;
          queue.push([nx, ny]);
        }
      }
    }
  }
  return count;
}

/** 黑像素 bbox（限定窗口内——旋转断言用）。 */
function blackBbox(img: Decoded): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!isBlack(img, x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** 某行黑像素水平跨度（孔径 1:1 断言）。 */
function rowSpan(img: Decoded, y: number): number {
  let left = -1;
  let right = -1;
  for (let x = 0; x < img.width; x++) {
    if (isBlack(img, x, y)) {
      if (left < 0) left = x;
      right = x;
    }
  }
  return right - left + 1;
}

function tinyPngDataUrl(): string {
  return `data:image/png;base64,${Buffer.from(encodePng(8, 8, new Uint8Array(8 * 8 * 4).fill(255))).toString('base64')}`;
}

describe('黑点模板 holes.png', () => {
  it('孔数=gems 数（连通域）；白底黑点 1-bit 语义（每像素恰纯黑或纯白）', () => {
    // d=30px（3mm@ppm10）——中心间距 ≥45px（spacing 门同语义，孔不相连）。
    const gems = [
      gem({ id: 'g1', x: 15, y: 15 }),
      gem({ id: 'g2', x: 60, y: 15 }),
      gem({ id: 'g3', x: 15, y: 60 }),
      gem({ id: 'g4', x: 60, y: 60 }),
      gem({ id: 'g5', x: 95, y: 38 }),
    ];
    const result = renderHoleTemplatePng({ gems, grid: GRID(), width: 130, height: 100 });
    expect(result.holeCount).toBe(5);
    const img = decodePng(result.png);
    expect(img.width).toBe(130);
    expect(img.height).toBe(100);
    expect(countComponents(img)).toBe(5);
    // 1-bit 语义：全画布像素 ∈ {纯黑, 纯白}；背景（左上角远端）白。
    for (let p = 0; p < img.width * img.height; p++) {
      const [r, g, b] = [img.rgba[p * 4]!, img.rgba[p * 4 + 1]!, img.rgba[p * 4 + 2]!];
      expect(r === g && g === b && (r === 0 || r === 255)).toBe(true);
    }
    expect(isBlack(img, 125, 5)).toBe(false);
  });

  it('孔径=钻径 1:1（3mm@ppm10=30px——圆孔中心行跨度 30±2）', () => {
    const result = renderHoleTemplatePng({
      gems: [gem({ id: 'g1', x: 20, y: 20, diameterMm: 3 })],
      grid: GRID(10),
      width: 60,
      height: 60,
    });
    const img = decodePng(result.png);
    expect(rowSpan(img, 21)).toBeGreaterThanOrEqual(28); // 圆心 y=20.5 → 行 21
    expect(rowSpan(img, 21)).toBeLessThanOrEqual(32);
  });

  it('异形旋转：square 转 45° 黑像素 bbox 对角扩张（s→≈s√2）', () => {
    const axis = renderHoleTemplatePng({
      gems: [gem({ id: 's1', x: 40, y: 40, shapeId: 'square', diameterMm: 6 })],
      grid: GRID(10, 0.4, 6),
      width: 90,
      height: 90,
    });
    const rotated = renderHoleTemplatePng({
      gems: [gem({ id: 's1', x: 40, y: 40, shapeId: 'square', diameterMm: 6, rotationDeg: 45 })],
      grid: GRID(10, 0.4, 6),
      width: 90,
      height: 90,
    });
    const bboxAxis = blackBbox(decodePng(axis.png))!;
    const bboxRot = blackBbox(decodePng(rotated.png))!;
    const s = 6 * 10; // 60px
    expect(bboxAxis.maxX - bboxAxis.minX + 1).toBeLessThanOrEqual(s + 2);
    expect(bboxRot.maxX - bboxRot.minX + 1).toBeGreaterThanOrEqual(Math.floor(s * Math.SQRT2) - 3);
  });

  it('custom vectorPath=轮廓孔（三角形质心黑/盒角白）；custom 仅贴图资产=方形包络孔', () => {
    const assets = new Map<string, PngShapeAsset>([
      ['vec-1', { vectorPath: 'M 0.5 0.05 L 0.95 0.95 L 0.05 0.95 Z' }],
      ['img-1', { image: { mime: 'image/png', dataUrl: tinyPngDataUrl(), width: 8, height: 8 } }],
    ]);
    const resolveAsset = (assetId: string): PngShapeAsset | null => assets.get(assetId) ?? null;
    const result = renderHoleTemplatePng({
      gems: [
        gem({ id: 'c1', x: 25, y: 20, shapeId: 'custom', diameterMm: 4, assetId: 'vec-1' }),
        gem({ id: 'c2', x: 95, y: 20, shapeId: 'custom', diameterMm: 4, assetId: 'img-1' }),
      ],
      grid: GRID(10, 0.4, 4),
      width: 140,
      height: 60,
      resolveAsset,
    });
    const img = decodePng(result.png);
    expect(result.holeCount).toBe(2);
    expect(countComponents(img)).toBe(2);
    // 三角形（单位框 M 0.5 0.05 L 0.95 0.95 L 0.05 0.95 Z）：质心 (0.5, 0.65) 黑；
    // 孔外点 (0.15, 0.15)/(0.05, 0.5) 白。c1 中心 (25.5, 20.5)，s=40px。
    expect(isBlack(img, Math.round(25.5 + (0.5 - 0.5) * 40), Math.round(20.5 + (0.65 - 0.5) * 40))).toBe(true);
    expect(isBlack(img, Math.round(25.5 + (0.15 - 0.5) * 40), Math.round(20.5 + (0.15 - 0.5) * 40))).toBe(false);
    expect(isBlack(img, Math.round(25.5 + (0.05 - 0.5) * 40), Math.round(20.5 + (0.5 - 0.5) * 40))).toBe(false);
    // 仅贴图资产：方形包络——四角黑（s=40 内缩 2px）。c2 中心 (95.5, 20.5)。
    for (const [dx, dy] of [
      [-17, -17],
      [17, -17],
      [-17, 17],
      [17, 17],
    ] as [number, number][]) {
      expect(isBlack(img, Math.round(95.5 + dx), Math.round(20.5 + dy))).toBe(true);
    }
  });
});
