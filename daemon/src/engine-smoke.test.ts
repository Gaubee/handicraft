/**
 * 引擎 workspace 消费链路 smoke gate（vitest 轨；design §2 W1 冻结项）。
 * 真实 `import 'rhinestone-studio/engine'`（workspace 依赖 + package exports
 * subpath 解析）并调用 layout()/exportSvg()/exportBom()——非 typecheck。
 */
import { describe, expect, it } from 'vitest';
import { runEngineSmoke } from './engine-smoke.js';

describe('rhinestone-studio/engine workspace smoke gate', () => {
  it('layout(hex-pitch) 与 SVG/BOM 导出全链非空', () => {
    const result = runEngineSmoke();
    // 40×40px、pitch=(3+0.4)mm×8px/mm=27.2px → 预期数十颗量级；只断言非空与确定性形状
    expect(result.gemCount).toBeGreaterThan(10);
    expect(result.dropped).toBe(0);
    expect(result.svgBytes).toBeGreaterThan(100);
    expect(result.bomBytes).toBeGreaterThan(50);
  });

  it('同参 layout 确定性（引擎纯函数不变量）', async () => {
    const { layout, gridFromSpec } = await import('rhinestone-studio/engine');
    const grid = gridFromSpec({ shapeId: 'round', diameterMm: 3 }, 0.4, 8);
    const mk = (): Block4 => ({
      id: 'b',
      label: 'l',
      mask: { w: 20, h: 20, bits: new Uint8Array(400).fill(1) },
      colorRgb: [1, 2, 3],
      areaPx: 400,
      bbox: { x: 0, y: 0, w: 20, h: 20 },
      widthPx: { max: 20, mean: 20 },
      suggested: 'fill',
    });
    const a = layout([mk()], 'hex-pitch', {}, grid);
    const b = layout([mk()], 'hex-pitch', {}, grid);
    expect(a.gems).toEqual(b.gems);
  });
});

/** 测试内最小 Block 形状（避免从引擎导 type 造成类型耦合断言弱化）。 */
interface Block4 {
  id: string;
  label: string;
  mask: { w: number; h: number; bits: Uint8Array };
  colorRgb: [number, number, number];
  areaPx: number;
  bbox: { x: number; y: number; w: number; h: number };
  widthPx: { max: number; mean: number };
  suggested: 'fill' | 'linear' | 'element';
}
