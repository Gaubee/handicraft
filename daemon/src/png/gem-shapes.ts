/**
 * 钻形→孔形几何管线（导出矩阵 2026-10-02——黑点模板 holes.png / 编号工作图
 * numbered.png 的形状单源）。客户习惯参照（主仓 docs/客户工作流分析报告.md）：
 * 黑点模板=挖孔形态（刻膜/定位用），**孔形按钻形**（圆钻=圆孔、方形/水滴/异形=
 * 对应形状孔——异形含 rotationDeg 旋转；builtin 形按 shapeId 几何、custom 形按
 * .gemshape vectorPath 轮廓），孔径=钻径 1:1（生产定位语义）。
 *
 * 复用纪律（禁复制）：形状分派/光栅原语全部走 render.ts 导出面——
 *   - shapePolygonOf：builtin 五形 BUILTIN_PATHS + custom vectorPath（'texture'
 *     哨兵=custom 仅有 image 贴图资产→挖孔口径取 s×s 方形包络——与贴图渲染的
 *     drawTexture s×s 方盒同口径，且三个产物 holes/numbered/SVG holes 层一致）。
 *   - drawCircleAA / drawPolygonSS：analytic AA 圆 + 4×4 超采样多边形（render.ts
 *     光栅原语——coverage max-merge，spacing 门保证钻位不重叠，逐像素归属唯一）。
 */
import { type Gem, type GridSpec } from 'rhinestone-studio/engine';
import { drawCircleAA, drawPolygonSS, shapePolygonOf, type ResolveShapeAsset } from './render.js';

/** custom 仅有 image 贴图资产时的方形包络孔（单位框顶点——顺时针）。 */
const SQUARE_ENVELOPE: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export interface GemShapeRasterInput {
  gems: Gem[];
  grid: GridSpec;
  width: number;
  height: number;
  /** custom 形 .gemshape 资产解析（缺席时任何 custom 钻=PngAssetUnresolvedError——不静默）。 */
  resolveAsset?: ResolveShapeAsset;
}

/**
 * 逐钻孔形覆盖平面（整幅 max-merge coverage 0..1）+ 逐像素归属钻索引。
 *
 * 归属语义：colorPlane 每命中像素写 `(gemIndex+1)` 的低 24 位小端三字节（rgb 参数
 * 位面）——spacing 门保证孔位不重叠，每像素至多一钻命中（max-merge 的最后写者即
 * 唯一写者）；coverage=孔形覆盖率（AA 边界 0..1）。调用方消费：
 *   - holes.png：coverage≥0.5 → 黑（1-bit 语义位图）。
 *   - numbered.png：按归属钻的 colorHex 以 30% 透明度染底（AA 加权）。
 */
export function gemHoleRaster(input: GemShapeRasterInput): {
  coverage: Float32Array;
  /** 命中像素归属（0=无；n=第 n-1 颗钻——低 24 位小端编码于三字节）。 */
  owner: Uint8Array;
  width: number;
  height: number;
} {
  const { gems, grid, width: W, height: H } = input;
  const coverage = new Float32Array(W * H);
  const owner = new Uint8Array(W * H * 3); // drawXxx 的 colorPlane 位面（承载归属编码）
  gems.forEach((gem, index) => {
    const tag = index + 1;
    const rgb: [number, number, number] = [tag & 0xff, (tag >> 8) & 0xff, (tag >> 16) & 0xff];
    const cx = gem.x + 0.5;
    const cy = gem.y + 0.5;
    if (gem.shapeId === 'round') {
      const r = (gem.diameterMm / 2) * grid.pixelsPerMm;
      drawCircleAA(coverage, owner, rgb, cx, cy, r, W, H);
      return;
    }
    const s = gem.diameterMm * grid.pixelsPerMm; // 方盒边长（render.ts path scale 同口径）
    const polygon = shapePolygonOf(gem, input.resolveAsset);
    const unit = polygon === 'texture' ? SQUARE_ENVELOPE : polygon;
    const rotation = ((gem.rotationDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const pts: [number, number][] = unit.map(([u, v]) => {
      const lx = (u - 0.5) * s;
      const ly = (v - 0.5) * s;
      return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
    });
    drawPolygonSS(coverage, owner, rgb, pts, W, H);
  });
  return { coverage, owner, width: W, height: H };
}

/** owner 三字节 → 钻索引（0=无归属）。 */
export function holeOwnerOf(owner: Uint8Array, p: number): number {
  return (owner[p * 3]! | (owner[p * 3 + 1]! << 8) | (owner[p * 3 + 2]! << 16)) - 1;
}
