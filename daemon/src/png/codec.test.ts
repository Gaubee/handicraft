/**
 * PNG 编解码往返测试（design §6.3）：encode→decode 逐像素相等；透明像素保留；
 * 畸形输入（非 PNG 签名/截断）typed 拒绝；RGB 色型输入转换 alpha=255。
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng, encodePng, PngCodecError } from './codec.js';

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
});
