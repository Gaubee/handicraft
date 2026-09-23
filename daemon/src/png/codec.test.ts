/**
 * PNG 编解码往返测试（design §6.3）：encode→decode 逐像素相等；透明像素保留；
 * 畸形输入（非 PNG 签名/截断）typed 拒绝；RGB 色型输入转换 alpha=255。
 * P1-4 输入边界：超像素 IHDR / 压缩炸弹 / 巨 IDAT——typed 拒绝且不按攻击者
 * 尺寸分配（进程存活即测试继续本身）。
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  decodePng,
  encodePng,
  PngCodecError,
  PNG_MAX_IDAT_BYTES,
  PNG_MAX_PIXELS,
} from './codec.js';

/** 手工 PNG 组装（IHDR 尺寸/色型可控——不校验 CRC，与既有手工构造测试同法）。 */
function handmadePng(
  width: number,
  height: number,
  idat: Buffer | Buffer[],
  colorType: 2 | 6 = 6,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[12] = 0; // 非隔行
  const mk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.byteLength, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const chunks = Array.isArray(idat) ? idat : [idat];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mk('IHDR', ihdr),
    ...chunks.map((part) => mk('IDAT', part)),
    mk('IEND', Buffer.alloc(0)),
  ]);
}

describe('PNG codec', () => {
  it('encode→decode 往返：RGBA 逐像素相等（含透明像素）', () => {
    const w = 5;
    const h = 4;
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      rgba[p * 4] = (p * 13) % 256;
      rgba[p * 4 + 1] = (p * 7) % 256;
      rgba[p * 4 + 2] = (p * 29) % 256;
      rgba[p * 4 + 3] = p % 2 === 0 ? 255 : 64; // 半透明与不透明交替
    }
    const png = encodePng(w, h, rgba);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const decoded = decodePng(png);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });

  it('签名不符/空输入：typed 拒绝', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngCodecError);
    expect(() => decodePng(new Uint8Array(0))).toThrow(PngCodecError);
  });

  it('截断 PNG：typed 拒绝', () => {
    const png = encodePng(3, 3, new Uint8Array(3 * 3 * 4).fill(200));
    expect(() => decodePng(png.subarray(0, Math.floor(png.byteLength / 2)))).toThrow(PngCodecError);
  });

  it('手工构造 RGB(color type 2) 行：解码为 RGBA（alpha=255）', () => {
    // 2×1 RGB：红、绿
    const w = 2;
    const h = 1;
    const stride = w * 3;
    const raw = Buffer.alloc(h * (1 + stride));
    raw[0] = 0; // filter none
    raw[1] = 255; raw[2] = 0; raw[3] = 0;
    raw[4] = 0; raw[5] = 255; raw[6] = 0;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2; // RGB
    const mk = (type: string, data: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.byteLength, 0);
      head.write(type, 4, 'ascii');
      // CRC 不校验解码面——但保持合法结构（复用编码器私有 crc 不可得，置 0）
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mk('IHDR', ihdr),
      mk('IDAT', deflateSync(raw)),
      mk('IEND', Buffer.alloc(0)),
    ]);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(2);
    expect(Array.from(decoded.rgba)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('全透明大图往返（软光栅透明背景语义的底座）', () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8Array(w * h * 4); // 全 0=全透明
    const decoded = decodePng(encodePng(w, h, rgba));
    expect(decoded.rgba.every((v) => v === 0)).toBe(true);
  });

  it('P1-4 超像素 IHDR：像素总数超 64MP 直接 typed 拒绝（不进入 inflate/分配）', () => {
    // 20000×20000 = 400MP > 64MP；IDAT 只需极小（尺寸声明即拒绝）
    const bomb = handmadePng(20000, 20000, deflateSync(Buffer.alloc(16)));
    const startedAt = Date.now();
    expect(() => decodePng(bomb)).toThrow(PngCodecError);
    expect(() => decodePng(bomb)).toThrow(/像素总数超上限/);
    // 快速拒绝（无 256MB 级分配——毫秒级返回）
    expect(Date.now() - startedAt).toBeLessThan(2000);
    // 单维极端（0xFFFFFFFF）同样拒绝
    expect(() => decodePng(handmadePng(0xffffffff, 4, deflateSync(Buffer.alloc(16))))).toThrow(
      PngCodecError,
    );
  });

  it('P1-4 压缩炸弹：小 IDAT 高压缩比→超期望输出——有界 inflate 报错不按攻击尺寸分配', () => {
    // IHDR 4000×4000 RGBA（16MP ≤ 64MP 通过像素门）：期望输出 4000*(1+16000)=64,000,400B。
    // IDAT 为 ~128MB 零的 deflate（≈128KB 压缩）——展开远超期望，maxOutputLength 即时拒绝。
    const expected = 4000 * (1 + 4000 * 4);
    const compressed = deflateSync(Buffer.alloc(Math.ceil(expected * 2), 0), { level: 9 });
    expect(compressed.byteLength).toBeLessThan(1024 * 1024); // 输入确实小（高压缩比）
    const bomb = handmadePng(4000, 4000, compressed);
    expect(() => decodePng(bomb)).toThrow(PngCodecError);
    expect(() => decodePng(bomb)).toThrow(/解压失败/);
  });

  it('P1-4 压缩炸弹（欠展开形态）：像素内 IDAT 展开不足——typed 拒绝（长度不足）', () => {
    // 8160×8160（66.6MP ≤ 64MP 通过）但 IDAT 仅 1KB 零——展开远小于期望行数
    const bomb = handmadePng(8160, 8160, deflateSync(Buffer.alloc(1024)));
    expect(() => decodePng(bomb)).toThrow(PngCodecError);
    expect(() => decodePng(bomb)).toThrow(/长度不足/);
  });

  it('P1-4 巨 IDAT：多分片压缩输入总量超 96MB——进入 inflate 前拒绝', () => {
    // 两个各 ~48MB 的 IDAT 分片（合法 PNG 允许多 IDAT）——合计超 PNG_MAX_IDAT_BYTES
    const chunk = Buffer.alloc(Math.floor(PNG_MAX_IDAT_BYTES / 2) + 1024, 0);
    const bomb = handmadePng(2, 2, [
      deflateSync(chunk, { level: 0 }), // 存储式：输出≈输入
      deflateSync(chunk, { level: 0 }),
    ]);
    expect(() => decodePng(bomb)).toThrow(PngCodecError);
    expect(() => decodePng(bomb)).toThrow(/IDAT 压缩数据超上限/);
  });

  it('P1-4 边界内侧不误伤：64MP 上限内的正常解码照常', () => {
    // 小图往返已在其余用例覆盖——此处验证像素门常量口径（64MP）
    expect(PNG_MAX_PIXELS).toBe(64 * 1024 * 1024);
    const decoded = decodePng(encodePng(4, 4, new Uint8Array(4 * 4 * 4).fill(9)));
    expect(decoded.width).toBe(4);
  });
});
