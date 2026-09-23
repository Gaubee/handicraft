/**
 * 引擎 workspace 消费链路 smoke gate（design §2 映射表 W1 冻结项）。
 * 原始需求：daemon 侧真实 `import 'rhinestone-studio/engine'`（package exports subpath）
 * 并调用 `layout()`（hex-pitch 最小 blocks fixture）与 SVG/BOM 导出函数，断言产出非空
 * ——证明 workspace source exports 链路通，不只 typecheck。
 * 正交意图：
 *   [1] fixture 构造（40×40 实心方块 block + SS10 圆钻规格 grid）。
 *   [2] layout + buildSvg/buildBom/exportSvg/exportBom 全链非空断言，汇总体检结果。
 */
import {
  layout,
  exportSvg,
  exportBom,
  gridFromSpec,
  type Block,
  type Palette,
} from 'rhinestone-studio/engine';

export interface SmokeResult {
  gemCount: number;
  dropped: number;
  svgBytes: number;
  bomBytes: number;
}

/** 200×200 实心方块（mask=字节每像素，1=属于块——引擎 ops/validate 消费约定）。 */
function smokeBlock(): Block {
  const w = 200;
  const h = 200;
  const bits = new Uint8Array(w * h).fill(1);
  return {
    id: 'smoke-block',
    label: 'smoke',
    mask: { w, h, bits },
    colorRgb: [196, 30, 48],
    areaPx: w * h,
    bbox: { x: 0, y: 0, w, h },
    widthPx: { max: w, mean: w },
    suggested: 'fill',
  };
}

/** 全链体检：layout（hex-pitch）→ SVG/BOM 导出，产出必须非空。 */
export function runEngineSmoke(): SmokeResult {
  const grid = gridFromSpec({ shapeId: 'round', diameterMm: 3 }, 0.4, 8);
  const result = layout([smokeBlock()], 'hex-pitch', {}, grid);
  if (result.gems.length === 0) throw new Error('smoke: layout 产出空钻集');
  if (result.warnings.length > 0) throw new Error(`smoke: 意外 warnings=${JSON.stringify(result.warnings)}`);

  const palette: Palette = [
    { id: 'c-smoke', name: '烟测红', hex: '#C41E30' },
  ];
  const svgBlob = exportSvg(result, grid, { width: 200, height: 200, palette });
  const bomBlob = exportBom(result, palette, grid);
  if (svgBlob.size === 0) throw new Error('smoke: exportSvg 产出空 Blob');
  if (bomBlob.size === 0) throw new Error('smoke: exportBom 产出空 Blob');

  return {
    gemCount: result.gems.length,
    dropped: result.dropped ?? 0,
    svgBytes: svgBlob.size,
    bomBytes: bomBlob.size,
  };
}
