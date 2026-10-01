/**
 * 任务导出效果图贴图合成渲染器测试（2026-10-02——render.png=效果图口径）。
 * 覆盖面（任务简报冻结验收）：
 *   [1] 合成正确性：贴图钻中心=贴图色（非色板色）；同 layout 圆点版 vs 贴图版
 *       gems 数一致（每颗钻位两版均有内容）；PNG 魔数+尺寸+非空。
 *   [2] 异形：custom 资产贴图（dataUrl）按位渲染；custom vectorPath=几何色面现状。
 *   [3] 旋转：rotationDeg 逆旋转映射（左右分色贴图转 90°=上下分色）。
 *   [4] alphaBounds：主体 bounds 主径=钻盒（全画布映射的反例断言）。
 *   [5] 缺图降级：resolver null（pending 款）→ colorHex 色点+计数/款号明示；
 *       解码失败（垃圾字节/隔行 Adam7）→ 同为降级+独立款号清单。
 *   [6] 解码缓存：同 blobRef 多钻只解码一次（onTextureDecode 观测）。
 *   [7] 性能：362 颗 500px 画布秒级（实测耗时断言上限）。
 */
import { describe, expect, it } from 'vitest';
import { type Gem, type GridSpec, type Palette } from 'rhinestone-studio/engine';
import { decodePng, encodePng } from './codec.js';
import { renderGemsPng } from './render.js';
import { renderGemsTexturePng, type StoneTextureBytes } from './texture-render.js';

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

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function gem(overrides: Partial<Gem> & Pick<Gem, 'id' | 'x' | 'y'>): Gem {
  return {
    colorId: 'red',
    blockId: 'b1',
    shapeId: 'round',
    diameterMm: 3,
    ...overrides,
  } as Gem;
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

/** 纯色贴图（w×h 不透明）。 */
function solidTexture(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = rgb[0];
    rgba[p * 4 + 1] = rgb[1];
    rgba[p * 4 + 2] = rgb[2];
    rgba[p * 4 + 3] = 255;
  }
  return encodePng(w, h, rgba);
}

/** 左右分色贴图（左半 a / 右半 b——旋转映射断言用）。 */
function splitTexture(size: number, a: [number, number, number], b: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const c = x < size / 2 ? a : b;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
      rgba[p + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

/** 透明画布+居中主体（alphaBounds 映射断言用——bounds 显式随行）。 */
function subjectTexture(
  canvas: number,
  subject: number,
  rgb: [number, number, number],
): StoneTextureBytes {
  const rgba = new Uint8Array(canvas * canvas * 4);
  const off = (canvas - subject) / 2;
  for (let y = 0; y < subject; y++) {
    for (let x = 0; x < subject; x++) {
      const p = ((y + off) * canvas + (x + off)) * 4;
      rgba[p] = rgb[0];
      rgba[p + 1] = rgb[1];
      rgba[p + 2] = rgb[2];
      rgba[p + 3] = 255;
    }
  }
  return {
    blobRef: `subject-${canvas}-${subject}`,
    bytes: encodePng(canvas, canvas, rgba),
    alphaBounds: { x: off, y: off, w: subject, h: subject },
  };
}

/** 隔行 PNG（IHDR interlace=1——daemon codec typed 拒收面）。 */
function interlacedPngBytes(): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[12] = 1; // Adam7
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.byteLength, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  return new Uint8Array(
    Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(0)), chunk('IEND', Buffer.alloc(0))]),
  );
}

function textureResultDecode(input: Parameters<typeof renderGemsTexturePng>[0]): Decoded {
  return decodePng(renderGemsTexturePng(input).png);
}

// ---------------------------------------------------------------- [1] 合成正确性

describe('贴图合成正确性', () => {
  it('贴图钻中心=贴图色（非色板色）；PNG 魔数+尺寸+非空', () => {
    const green: StoneTextureBytes = { blobRef: 'green', bytes: solidTexture(32, 32, [16, 160, 16]) };
    const result = renderGemsTexturePng({
      gems: [gem({ id: 'g1', x: 32, y: 32 })],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: (ref) => (ref === 'red' ? green : null),
    });
    // PNG 魔数 + 尺寸 + 非空
    expect(Array.from(result.png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(result.png.byteLength).toBeGreaterThan(100);
    const img = decodePng(result.png);
    expect(img.width).toBe(65);
    expect(img.height).toBe(65);
    // 中心=贴图绿（不是色板红）
    expect(alphaAt(img, 32, 32)).toBe(255);
    expect(rgbAt(img, 32, 32)).toEqual([16, 160, 16]);
    // 透明背景
    expect(alphaAt(img, 0, 0)).toBe(0);
    expect(result.texturedCount).toBe(1);
    expect(result.fallbackCount).toBe(0);
  });

  it('同 layout 圆点版 vs 贴图版 gems 数一致（每颗钻位两版均有内容）', () => {
    const gems: Gem[] = [
      gem({ id: 'a', x: 12, y: 12, colorId: 'red' }),
      gem({ id: 'b', x: 44, y: 12, colorId: 'blue' }),
      gem({ id: 'c', x: 12, y: 44, colorId: 'red', shapeId: 'square' }),
      gem({ id: 'd', x: 44, y: 44, colorId: 'blue', shapeId: 'marquise', rotationDeg: 30 }),
    ];
    const textures = new Map<string, StoneTextureBytes>([
      ['red', { blobRef: 't-red', bytes: solidTexture(32, 32, [200, 40, 40]) }],
      ['blue', { blobRef: 't-blue', bytes: solidTexture(32, 32, [90, 120, 200]) }],
    ]);
    const shared = { gems, palette: PALETTE, grid: GRID(), width: 65, height: 65 };
    const dot = decodePng(renderGemsPng({ ...shared, gems }));
    const tex = renderGemsTexturePng({ ...shared, resolveStoneTexture: (ref) => textures.get(ref) ?? null });
    const texImg = decodePng(tex.png);
    expect(tex.texturedCount + tex.fallbackCount).toBe(gems.length);
    // 每颗钻位：圆点版与贴图版均不透明（渲染颗数一致——挖孔/丢钻即失败）。
    for (const g of gems) {
      expect(alphaAt(dot, g.x, g.y)).toBeGreaterThan(0);
      expect(alphaAt(texImg, g.x, g.y)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------- [2] 异形

describe('异形（custom 形）', () => {
  it('custom 资产贴图（dataUrl）按位渲染——中心=贴图色', () => {
    const bytes = solidTexture(24, 24, [200, 120, 10]);
    const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const result = renderGemsTexturePng({
      gems: [gem({ id: 'c1', x: 32, y: 32, shapeId: 'custom', assetId: 'ast-1' })],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: () => null,
      resolveAsset: (assetId) =>
        assetId === 'ast-1'
          ? { image: { mime: 'image/png', dataUrl, width: 24, height: 24 } }
          : null,
    });
    const img = decodePng(result.png);
    expect(result.texturedCount).toBe(1);
    expect(alphaAt(img, 32, 32)).toBe(255);
    expect(rgbAt(img, 32, 32)).toEqual([200, 120, 10]);
  });

  it('custom vectorPath=几何色面现状（色板色渲染，不计缺图降级）', () => {
    const result = renderGemsTexturePng({
      gems: [gem({ id: 'c2', x: 32, y: 32, shapeId: 'custom', assetId: 'ast-2' })],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: () => null,
      resolveAsset: (assetId) =>
        assetId === 'ast-2' ? { vectorPath: 'M 0.02 0.02 L 0.98 0.02 L 0.98 0.98 L 0.02 0.98 Z' } : null,
    });
    const img = decodePng(result.png);
    expect(result.texturedCount).toBe(0);
    expect(result.fallbackCount).toBe(0); // 几何渲染=现状口径，非缺图
    expect(result.missingStoneRefs).toEqual([]);
    expect(alphaAt(img, 32, 32)).toBe(255);
    expect(rgbAt(img, 32, 32)).toEqual([0xc8, 0x10, 0x2e]); // 色板色
  });
});

// ---------------------------------------------------------------- [3] 旋转

describe('旋转（rotationDeg 逆旋转映射）', () => {
  it('左右分色贴图转 90°=上下分色（红上蓝下）', () => {
    const bytes = splitTexture(32, [220, 30, 30], [30, 30, 220]); // 左红右蓝
    const img = textureResultDecode({
      gems: [gem({ id: 'r1', x: 32, y: 32, rotationDeg: 90 })],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: () => ({ blobRef: 'split', bytes }),
    });
    // 局部 +x（蓝）在正向旋转 90° 后指向屏幕下方 → 上半红、下半蓝。
    expect(rgbAt(img, 32, 32 - 6)).toEqual([220, 30, 30]);
    expect(rgbAt(img, 32, 32 + 6)).toEqual([30, 30, 220]);
    // 左右两侧为贴图混合边界（非纯色）——不断言。
  });
});

// ---------------------------------------------------------------- [4] alphaBounds

describe('alphaBounds 主径映射', () => {
  it('主体 bounds（10/20 画布）主径=钻盒 s——非全画布拉伸', () => {
    // 画布 20、主体 10；s=3mm×8ppm=24px。全画布映射（错）会得到 ~48px 跨度。
    const source = subjectTexture(20, 10, [90, 200, 60]);
    const img = textureResultDecode({
      gems: [gem({ id: 'ab1', x: 32, y: 32 })],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: () => source,
    });
    const span = rowSpan(img, 32)!;
    expect(span.width).toBeGreaterThanOrEqual(21);
    expect(span.width).toBeLessThanOrEqual(27);
    expect(rgbAt(img, 32, 32)).toEqual([90, 200, 60]);
  });
});

// ---------------------------------------------------------------- [5] 缺图降级

describe('缺图降级（pending 款/解码失败——warnings 明示不静默）', () => {
  it('resolver null（pending 款）→ colorHex 色点+计数/款号', () => {
    const textures = new Map<string, StoneTextureBytes>([
      ['red', { blobRef: 't-red', bytes: solidTexture(32, 32, [200, 40, 40]) }],
    ]);
    const result = renderGemsTexturePng({
      gems: [
        gem({ id: 'ok1', x: 12, y: 12, colorId: 'red' }),
        gem({ id: 'ok2', x: 44, y: 12, colorId: 'red' }),
        gem({ id: 'miss1', x: 12, y: 44, colorId: 'blue' }),
        gem({ id: 'miss2', x: 44, y: 44, colorId: 'blue' }),
      ],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: (ref) => textures.get(ref) ?? null,
    });
    const img = decodePng(result.png);
    expect(result.texturedCount).toBe(2);
    expect(result.fallbackCount).toBe(2);
    expect(result.fallbackMissingCount).toBe(2);
    expect(result.missingStoneRefs).toEqual(['blue']);
    // 降级钻=色板色（blue → #102EC8）
    expect(rgbAt(img, 12, 44)).toEqual([0x10, 0x2e, 0xc8]);
    expect(rgbAt(img, 44, 44)).toEqual([0x10, 0x2e, 0xc8]);
  });

  it('解码失败（垃圾字节）→ 降级色点+undecodable 款号（与缺失分列）', () => {
    const result = renderGemsTexturePng({
      gems: [gem({ id: 'bad1', x: 32, y: 32, colorId: 'red' })],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: () => ({ blobRef: 'garbage', bytes: new Uint8Array([1, 2, 3, 4, 5]) }),
    });
    const img = decodePng(result.png);
    expect(result.fallbackUndecodableCount).toBe(1);
    expect(result.undecodableStoneRefs).toEqual(['red']);
    expect(result.missingStoneRefs).toEqual([]);
    expect(rgbAt(img, 32, 32)).toEqual([0xc8, 0x10, 0x2e]); // 色板色降级
  });

  it('隔行 PNG（Adam7——interlace=1）走解码失败降级（入库管线保证外的防御面）', () => {
    const result = renderGemsTexturePng({
      gems: [gem({ id: 'adam7', x: 32, y: 32, colorId: 'red' })],
      palette: PALETTE,
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: () => ({ blobRef: 'interlaced', bytes: interlacedPngBytes() }),
    });
    expect(result.fallbackUndecodableCount).toBe(1);
    expect(result.undecodableStoneRefs).toEqual(['red']);
  });

  it('非隔行贴图（encodePng 产物——导入管线重编码后形态）解码路径贯通', () => {
    // encodePng 恒非隔行（filter 0 + color type 6）——全部用例的基础路径在此显式锁定。
    const bytes = solidTexture(16, 16, [1, 2, 3]);
    const decoded = decodePng(bytes); // codec 面：非隔行可解
    expect(decoded.width).toBe(16);
    const result = renderGemsTexturePng({
      gems: [gem({ id: 'ni1', x: 8, y: 8 })],
      palette: PALETTE,
      grid: { ...GRID(), pixelsPerMm: 4 },
      width: 17,
      height: 17,
      resolveStoneTexture: () => ({ blobRef: 'non-interlaced', bytes }),
    });
    expect(result.texturedCount).toBe(1);
    expect(result.fallbackCount).toBe(0);
  });
});

// ---------------------------------------------------------------- [6] 解码缓存

describe('贴图解码缓存（按 blobRef）', () => {
  it('同 blobRef 多钻只解码一次（不同 blobRef 各一次——onTextureDecode 观测）', () => {
    const decodeKeys: string[] = [];
    const bytesA = solidTexture(32, 32, [10, 200, 10]);
    const bytesB = solidTexture(32, 32, [10, 10, 200]);
    const byRef = new Map<string, StoneTextureBytes>([
      ['ref-a', { blobRef: 'ref-a', bytes: bytesA }], // stone-1/stone-2 共享
      ['ref-b', { blobRef: 'ref-b', bytes: bytesB }],
    ]);
    const result = renderGemsTexturePng({
      gems: [
        gem({ id: 's1', x: 12, y: 12, colorId: 'stone-1' }),
        gem({ id: 's2', x: 44, y: 12, colorId: 'stone-2' }),
        gem({ id: 's3', x: 12, y: 44, colorId: 'stone-3' }),
      ],
      palette: [{ id: 'stone-1', name: '一', hex: '#111111' }],
      grid: GRID(),
      width: 65,
      height: 65,
      resolveStoneTexture: (ref) =>
        ref === 'stone-3' ? byRef.get('ref-b')! : byRef.get('ref-a')!,
      onTextureDecode: (key) => decodeKeys.push(key),
    });
    expect(result.texturedCount).toBe(3);
    // ref-a（stone-1/stone-2 共享）+ref-b 各解码一次——resolver 逐钻调用、解码按 blobRef。
    expect(decodeKeys).toEqual(['blob:ref-a', 'blob:ref-b']);
  });
});

// ---------------------------------------------------------------- [7] 性能

describe('性能（362 颗 500px 画布秒级）', () => {
  it('362 颗 ×8 款贴图 500×500 渲染耗时 < 5s（实测值输出）', () => {
    // 19×19 网格 +1 = 362 颗；8 款贴图（128×128——tuzuan 批典型分辨率）。
    const refs = Array.from({ length: 8 }, (_, i) => `stone-${i + 1}`);
    const textures = new Map<string, StoneTextureBytes>(
      refs.map((ref, i) => [
        ref,
        { blobRef: `blob-${i}`, bytes: solidTexture(128, 128, [30 * i + 10, 160, 200 - 20 * i]) },
      ]),
    );
    const gems: Gem[] = [];
    for (let i = 0; i < 362; i++) {
      const col = i % 19;
      const row = Math.floor(i / 19);
      gems.push(
        gem({
          id: `p${i}`,
          x: 8 + col * 26,
          y: 8 + (i === 361 ? 18 : row) * 26,
          colorId: refs[i % 8]!,
          ...(i % 5 === 0 ? { rotationDeg: (i % 90) * 2 } : {}),
        }),
      );
    }
    const palette: Palette = refs.map((ref, i) => ({ id: ref, name: `款${i}`, hex: '#A0A0A0' }));
    const started = performance.now();
    const result = renderGemsTexturePng({
      gems,
      palette,
      grid: { ...GRID(), pixelsPerMm: 10 },
      width: 500,
      height: 500,
      resolveStoneTexture: (ref) => textures.get(ref) ?? null,
    });
    const elapsed = performance.now() - started;
    // eslint-disable-next-line no-console
    console.info(`[texture-render perf] 362 颗 500px 渲染耗时 ${Math.round(elapsed)}ms`);
    expect(result.texturedCount).toBe(362);
    expect(result.fallbackCount).toBe(0);
    expect(result.png.byteLength).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(5000);
  });
});
