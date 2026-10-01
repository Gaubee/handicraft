/**
 * 黑点模板渲染器（导出矩阵 2026-10-02——客户挖孔形态：刻膜/定位用）。
 * 客户习惯参照（主仓 docs/客户工作流分析报告.md §1「黑点模板」）：白底黑点
 * **1-bit 语义位图**，孔形按钻形（圆钻=圆孔、方形/水滴/异形=对应形状孔——异形含
 * rotationDeg 旋转；builtin 按 shapeId 几何、custom 按 .gemshape vectorPath 轮廓、
 * custom 仅贴图资产=s×s 方形包络），孔径=钻径 1:1（生产定位语义——ppm 同 render.png
 * 口径，无缩放）。
 *
 * 光栅纪律：gem-shapes.gemHoleRaster（render.ts 形状分派/光栅原语复用）→ coverage
 * ≥0.5 二值化（黑/白各一色——严格 1-bit 语义，AA 边界按 50% 判定，孔径保持于半像素内）。
 */
import { type Gem, type GridSpec } from 'rhinestone-studio/engine';
import { encodePng } from './codec.js';
import { gemHoleRaster } from './gem-shapes.js';
import type { ResolveShapeAsset } from './render.js';

export interface HoleTemplateInput {
  gems: Gem[];
  grid: GridSpec;
  width: number;
  height: number;
  /** custom 形 .gemshape 资产解析（custom 钻在场必携——render.ts 纪律）。 */
  resolveAsset?: ResolveShapeAsset;
}

export interface HoleTemplateResult {
  png: Uint8Array;
  /** 孔数（=gems 数——对账面）。 */
  holeCount: number;
  /** 黑像素数（测试/密度诊断）。 */
  blackPixels: number;
}

/** 黑点模板：白底黑孔 1-bit 位图（挖孔形态）。 */
export function renderHoleTemplatePng(input: HoleTemplateInput): HoleTemplateResult {
  const { coverage, width: W, height: H } = gemHoleRaster(input);
  const rgba = new Uint8Array(W * H * 4);
  let blackPixels = 0;
  for (let p = 0; p < W * H; p++) {
    const d = p * 4;
    if (coverage[p]! >= 0.5) {
      rgba[d] = 0;
      rgba[d + 1] = 0;
      rgba[d + 2] = 0;
      rgba[d + 3] = 255;
      blackPixels += 1;
    } else {
      rgba[d] = 255;
      rgba[d + 1] = 255;
      rgba[d + 2] = 255;
      rgba[d + 3] = 255;
    }
  }
  return { png: encodePng(W, H, rgba), holeCount: input.gems.length, blackPixels };
}
