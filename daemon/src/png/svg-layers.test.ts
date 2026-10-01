/**
 * 四层 SVG 测试（导出矩阵 2026-10-02——客户「原图+黑点+编号+贴图替换」形态）。
 * 覆盖面（任务简报冻结验收）：
 *   [1] 四层结构：source/holes/numbers/gems 四个语义 <g>（文件序=渲染序）+顶层
 *       注释说明（CorelDRAW 下游友好）。
 *   [2] 黑点层：round=circle、异形=path+rotate（rotationDeg）；数据元
 *       data-color-id（=stoneRef）保持。
 *   [3] 编号层：<text> 与 gems 数一致；data-bom-row=BOM 行号；font-size=
 *       holeNumberGlyph 口径（numbered.png 同源）。
 *   [4] 贴图替换层：<defs> 每款一 <image>（alphaBounds 主径纵横比）+逐钻 <use>；
 *       缺贴图款= colorHex circle 降级；custom vectorPath=path 几何。
 *   [5] 原图层：小图内嵌 dataUrl；>2MB=注释占位且总量 <2MB；不可达=占位。
 *   [6] 体积：362 颗 8 款（128px 实拍级纹理）< 2MB。
 */
import { describe, expect, it } from 'vitest';
import { type Gem, type GridSpec, type Palette } from 'rhinestone-studio/engine';
import { encodePng } from './codec.js';
import type { StoneTextureBytes } from './texture-render.js';
import type { PngShapeAsset } from './render.js';
import { holeNumberGlyph } from './numbered-sheet.js';
import { buildLayeredSvg } from './svg-layers.js';

const GRID = (pixelsPerMm = 10, gapMm = 0.4, diameterMm = 3): GridSpec => ({
  pitchMm: diameterMm + gapMm,
  gapMm,
  rowAngleDeg: 0,
  pixelsPerMm,
});

const PALETTE: Palette = [
  { id: 'red', name: '红', hex: '#C8102E' },
  { id: 'blue', name: '蓝', hex: '#102EC8' },
  { id: 'green', name: '绿', hex: '#10C810' },
];

const ROWS = [
  { row: 1, stoneRef: 'red', name: '红', hex: '#C8102E', count: 3, diameterMm: 3 },
  { row: 2, stoneRef: 'blue', name: '蓝', hex: '#102EC8', count: 1, diameterMm: 3 },
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

/** 确定性「实拍级」纹理（棋盘噪声——deflate 压不干，模拟真实贴图体积）。 */
function noisyTexture(size: number, seed: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const x = p % size;
    const y = Math.floor(p / size);
    rgba[p * 4] = (x * 7 + y * 13 + seed * 31) % 256;
    rgba[p * 4 + 1] = (x * 3 + y * 29 + seed * 11) % 256;
    rgba[p * 4 + 2] = (x * 17 + y * 5 + seed * 7) % 256;
    rgba[p * 4 + 3] = 255;
  }
  return encodePng(size, size, rgba);
}

function tinyPngDataUrl(): string {
  return `data:image/png;base64,${Buffer.from(encodePng(8, 8, new Uint8Array(8 * 8 * 4).fill(255))).toString('base64')}`;
}

const ASSETS = new Map<string, PngShapeAsset>([
  ['vec-1', { vectorPath: 'M 0.5 0.05 L 0.95 0.95 L 0.05 0.95 Z' }],
  ['img-1', { image: { mime: 'image/png', dataUrl: tinyPngDataUrl(), width: 8, height: 8 } }],
]);

function baseInput(overrides: Partial<Parameters<typeof buildLayeredSvg>[0]> = {}) {
  return {
    gems: [
      gem({ id: 'a', x: 20, y: 20 }),
      gem({ id: 'b', x: 60, y: 20 }),
      gem({ id: 'c', x: 20, y: 60, colorId: 'red' }),
      gem({ id: 'd', x: 60, y: 60, shapeId: 'square', colorId: 'blue', rotationDeg: 30 }),
      gem({ id: 'e', x: 100, y: 60, shapeId: 'custom', colorId: 'green', assetId: 'vec-1' }),
      gem({ id: 'f', x: 100, y: 20, shapeId: 'custom', colorId: 'green', assetId: 'img-1' }),
    ],
    palette: PALETTE,
    grid: GRID(),
    width: 140,
    height: 100,
    rows: [
      ...ROWS,
      { row: 3, stoneRef: 'green', name: '绿', hex: '#10C810', count: 2, diameterMm: 3 },
    ],
    resolveStoneTexture: (stoneRef: string): StoneTextureBytes | null => {
      if (stoneRef === 'red') {
        return { blobRef: 'tex-red', bytes: noisyTexture(64, 1), alphaBounds: { x: 16, y: 16, w: 32, h: 32 } };
      }
      return null; // blue/green（custom）无钻库贴图
    },
    resolveAsset: (assetId: string): PngShapeAsset | null => ASSETS.get(assetId) ?? null,
    sourceImage: { mime: 'image/png', dataUrl: tinyPngDataUrl() },
    ...overrides,
  };
}

describe('四层 SVG（svg-layers）', () => {
  const result = buildLayeredSvg(baseInput());
  const svg = result.svg;

  it('四层结构：source/holes/numbers/gems 语义 <g>（文件序=渲染序）+层说明注释', () => {
    expect(svg).toContain('xmlns:xlink');
    const iSource = svg.indexOf('<g id="source">');
    const iHoles = svg.indexOf('<g id="holes"');
    const iNumbers = svg.indexOf('<g id="numbers"');
    const iGems = svg.indexOf('<g id="gems"');
    expect(iSource).toBeGreaterThan(-1);
    expect(iHoles).toBeGreaterThan(iSource);
    expect(iNumbers).toBeGreaterThan(iHoles);
    expect(iGems).toBeGreaterThan(iNumbers);
    expect(svg.indexOf('四层结构')).toBeGreaterThan(0); // 顶层注释（CDR 下游说明）
    expect(svg).toContain('#holes');
    expect(svg).toContain('#numbers');
    expect(svg).toContain('#gems');
  });

  it('原图层：输入图 dataUrl 内嵌；>2MB 降级占位（无内嵌+总量 <2MB）', () => {
    expect(result.sourceLayer).toBe('embedded');
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain(`href="data:image/png;base64,`);
    const oversize = buildLayeredSvg(
      baseInput({ sourceImage: { mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024 + 16)}` } }),
    );
    expect(oversize.sourceLayer).toBe('oversize-placeholder');
    expect(oversize.svg).toContain('未内嵌');
    expect(oversize.svg).not.toContain('AAAA'.repeat(64)); // 大载荷确未进产物
    expect(oversize.byteLength).toBeLessThan(2 * 1024 * 1024);
    const missing = buildLayeredSvg(baseInput({ sourceImage: null }));
    expect(missing.sourceLayer).toBe('missing-placeholder');
    expect(missing.svg).toContain('会话主图集不可达');
  });

  it('黑点层：round=circle（4）；异形=path（2：square+custom vec）；rotationDeg=rotate(30)；data-color-id 保持', () => {
    const holes = svg.slice(svg.indexOf('<g id="holes"'), svg.indexOf('<g id="numbers"'));
    expect(holes.match(/<circle /g)).toHaveLength(3); // a/b/c=round；d=square/e=vec/f=img 走 path
    expect(holes.match(/<path /g)).toHaveLength(3); // square d + custom vec e + custom img f（方形包络）
    expect(holes).toContain('rotate(30');
    expect(holes).toContain('data-color-id="red"');
    expect(holes).toContain('data-color-id="blue"');
    expect(holes).toContain('data-color-id="green"');
    expect(holes).toContain('data-bom-row="1"');
  });

  it('编号层：<text> 数=行号覆盖钻数；data-bom-row=BOM 行号；font-size=holeNumberGlyph 同源', () => {
    const numbers = svg.slice(svg.indexOf('<g id="numbers"'), svg.indexOf('<g id="gems"'));
    expect(numbers.match(/<text /g)).toHaveLength(6); // 全部钻均在 rows 覆盖内
    expect(numbers).toContain('data-bom-row="1"');
    expect(numbers).toContain('data-bom-row="2"');
    expect(numbers).toContain('data-bom-row="3"');
    const fontPx = holeNumberGlyph(1, 3, 10).fontPx;
    expect(numbers).toContain(`font-size="${fontPx}"`);
    expect(numbers).toContain('text-anchor="middle"');
  });

  it('贴图替换层：defs 每款一 image（red alphaBounds 主径 + custom img）；逐钻 use；缺贴图款=colorHex circle；vectorPath=path', () => {
    const gemsLayer = svg.slice(svg.indexOf('<g id="gems"'));
    expect(gemsLayer.match(/<image id="tex-/g)).toHaveLength(2); // red（builtin）+ img-1（custom 资产）
    expect(gemsLayer.match(/<use /g)).toHaveLength(4); // red×3 + custom img×1
    expect(gemsLayer).toContain('fill="#102EC8"'); // blue 缺贴图款降级色点
    expect(gemsLayer).toContain('fill="#10C810"'); // custom vectorPath 几何色面
    // red 贴图 alphaBounds 32×32（正方）@s=30 → box 30×30（主径=钻盒）。
    expect(gemsLayer).toContain('width="30" height="30"');
  });

  it('alphaBounds 纵横比：竖长主体（32×64）→ box 窄边=s×0.5（texture-render 同式）', () => {
    const tall = buildLayeredSvg(
      baseInput({
        resolveStoneTexture: (stoneRef: string): StoneTextureBytes | null =>
          stoneRef === 'red'
            ? { blobRef: 'tex-red', bytes: noisyTexture(64, 2), alphaBounds: { x: 16, y: 0, w: 32, h: 64 } }
            : null,
      }),
    );
    const gemsLayer = tall.svg.slice(tall.svg.indexOf('<g id="gems"'));
    expect(gemsLayer).toContain('width="15" height="30"'); // s=30 主径=高，宽=30×(32/64)
  });

  it('体积：362 颗 8 款 128px 实拍级纹理 → 全四层 < 2MB', () => {
    const stones = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      name: `色${i}`,
      hex: `#1000${(16 + i * 8).toString(16).padStart(2, '0').toUpperCase()}`.slice(0, 7),
    }));
    const palette: Palette = stones.map((s) => ({ id: s.id, name: s.name, hex: s.hex }));
    const textures = new Map(stones.map((s, i) => [s.id, noisyTexture(128, i + 3)]));
    const gems: Gem[] = [];
    // 19×20 网格 ≈362 颗（pitch 34px——spacing 安全），逐颗轮转 8 款。
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 19; col++) {
        const index = row * 19 + col;
        if (index >= 362) break;
        gems.push(gem({ id: `g${index}`, x: 20 + col * 34, y: 20 + row * 34, colorId: stones[index % 8]!.id }));
      }
    }
    const big = buildLayeredSvg({
      gems,
      palette,
      grid: GRID(),
      width: 680,
      height: 720,
      rows: stones.map((s, i) => ({
        row: i + 1,
        stoneRef: s.id,
        name: s.name,
        hex: s.hex,
        count: gems.filter((g) => g.colorId === s.id).length,
        diameterMm: 3,
      })),
      resolveStoneTexture: (stoneRef: string): StoneTextureBytes | null => {
        const bytes = textures.get(stoneRef);
        return bytes === undefined ? null : { blobRef: `tex-${stoneRef}`, bytes };
      },
      sourceImage: { mime: 'image/png', dataUrl: tinyPngDataUrl() },
    });
    expect(big.sourceLayer).toBe('embedded');
    expect(gems).toHaveLength(362);
    expect(big.byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(big.svg.match(/<use /g)).toHaveLength(362);
  });
});
