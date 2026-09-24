/**
 * stone→引擎 adapter 纯函数单测（add-stone-library tasks S0.3——design §10 三签名）。
 * 覆盖：specOfStone gemshapeRef 两分支+尺寸未声明显式态；paletteColorOfStone
 * id/name/hex 投影；resolveStoneTexture PNG 头解析 round-trip+三类 typed error
 * （dataUrl 与 base64Encode 以 node btoa 独立算出的硬编码基准串对拍——本包不依赖
 * 平台全局，tsconfig 无 node types）。
 */
import { describe, expect, it } from 'vitest';
import { base64Encode, paletteColorOfStone, resolveStoneTexture, rgbToHex, specOfStone } from './stone-adapter.js';
import type { StoneFile } from './stones.js';
import { StoneFileSchema } from './stones.js';

const iso = '2026-09-24T00:00:00.000Z';

const stoneOf = (over: Partial<StoneFile>): StoneFile =>
  StoneFileSchema.parse({
    kind: 'stone',
    formatVersion: 1,
    id: 'stn-0a1b2c3d',
    name: '象牙白 · 2mm',
    supplier: 'yuhang',
    sku: 'J51',
    skuParsed: { row: 51, prefix: 'J', sizeMm: 2 },
    sizeMm: 2,
    color: { name: '象牙白', rgb: [255, 255, 240], family: '白色系', finish: 'glossy' },
    texture: {
      file: '贴图.png',
      mime: 'image/png',
      width: 64,
      height: 64,
      alphaBounds: { x: 8, y: 8, w: 48, h: 48 },
    },
    metadata: {},
    createdAt: iso,
    updatedAt: iso,
    ...over,
  });

describe('specOfStone（§10 签名一：sizeMm 是唯一物理依据）', () => {
  it('无 gemshapeRef → round 圆包络（无 assetId）', () => {
    const r = specOfStone(stoneOf({}));
    expect(r).toEqual({ ok: true, spec: { shapeId: 'round', diameterMm: 2 } });
  });
  it('有 gemshapeRef → custom + assetId（直径仍取 sizeMm——pitch 圆包络语义）', () => {
    const r = specOfStone(stoneOf({ gemshapeRef: 'gem-round-seed', sizeMm: 12 }));
    expect(r).toEqual({ ok: true, spec: { shapeId: 'custom', diameterMm: 12, assetId: 'gem-round-seed' } });
  });
  it('sizeMm=null → 显式 size-unspecified（不猜测，§8.1 规则 7）', () => {
    for (const over of [{ sizeMm: null }, { sizeMm: null, gemshapeRef: 'gem-round-seed' }]) {
      expect(specOfStone(stoneOf(over))).toEqual({ ok: false, reason: 'size-unspecified' });
    }
  });
});

describe('paletteColorOfStone（§10 签名二：mapColors 最近邻换算直接可用）', () => {
  it('id=stone.id（stn- 前缀原值）/name=色名/hex 大写', () => {
    expect(paletteColorOfStone(stoneOf({}))).toEqual({
      id: 'stn-0a1b2c3d',
      name: '象牙白',
      hex: '#FFFFF0',
    });
  });
  it('rgbToHex 逐通道两位补零（低位色不丢位）', () => {
    expect(rgbToHex([0, 15, 255])).toBe('#000FFF');
    expect(rgbToHex([10, 200, 3])).toBe('#0AC803');
  });
});

// ---------------------------------------------------------------- PNG fixture

/** 最小合法 PNG 头（签名+IHDR：len13+类型+宽高+5 参数字节+CRC 占位）——33 字节。 */
function pngBytes(width: number, height: number): Uint8Array {
  const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13),
    0x49, 0x48, 0x44, 0x52, // 'IHDR'
    ...be32(width),
    ...be32(height),
    8, 6, 0, 0, 0, // bitDepth=8, colorType=6(RGBA), compression, filter, interlace
    0, 0, 0, 0, // CRC 占位（头级解析不校验 CRC）
  ]);
}

/** pngBytes(64,48) 的 base64（node btoa 独立算出，2026-09-24 抄录——对拍基准）。 */
const PNG_64_48_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAAAAAAA';

describe('resolveStoneTexture（§10 签名三：resolveAsset 消费形态）', () => {
  it('PNG 头 round-trip：宽高直读 + dataUrl 前缀与基准串', () => {
    const bytes = pngBytes(64, 48);
    const r = resolveStoneTexture(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.texture.mime).toBe('image/png');
    expect(r.texture.width).toBe(64);
    expect(r.texture.height).toBe(48);
    expect(r.texture.dataUrl).toBe(`data:image/png;base64,${PNG_64_48_B64}`);
  });
  it('跨 256 进位的大尺寸宽高（BE32 拼装正确性）', () => {
    const r = resolveStoneTexture(pngBytes(300, 4096));
    expect(r.ok && r.texture.width).toBe(300);
    expect(r.ok && r.texture.height).toBe(4096);
  });
  it('typed error：垃圾字节/坏签名→not-png；不足 24 字节→truncated；宽高 0→bad-dimensions', () => {
    expect(resolveStoneTexture(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, ...pngBytes(1, 1).slice(8)]))).toMatchObject({
      ok: false,
      reason: 'not-png',
    });
    expect(resolveStoneTexture(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toMatchObject({
      ok: false,
      reason: 'truncated',
    });
    expect(resolveStoneTexture(new Uint8Array([]))).toMatchObject({ ok: false, reason: 'truncated' });
    expect(resolveStoneTexture(pngBytes(0, 64))).toMatchObject({ ok: false, reason: 'bad-dimensions' });
    expect(resolveStoneTexture(pngBytes(64, 0))).toMatchObject({ ok: false, reason: 'bad-dimensions' });
  });
  it('签名合法但首块非 IHDR → not-png', () => {
    const bytes = pngBytes(64, 48);
    bytes[12] = 0x49; bytes[13] = 0x44; bytes[14] = 0x41; bytes[15] = 0x54; // 'IDAT'
    expect(resolveStoneTexture(bytes)).toMatchObject({ ok: false, reason: 'not-png' });
  });
  it('base64Encode 与独立基准同值（含 1/2 字节尾部 padding 分支）', () => {
    expect(base64Encode(new Uint8Array([]))).toBe('');
    expect(base64Encode(new Uint8Array([0xff]))).toBe('/w==');
    expect(base64Encode(new Uint8Array([0xff, 0xfe]))).toBe('//4=');
    expect(base64Encode(pngBytes(64, 48))).toBe(PNG_64_48_B64);
  });
});
