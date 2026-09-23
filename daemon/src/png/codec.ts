/**
 * PNG 编解码（design §6.3 服务端 PNG 路线——纯 TS + Node zlib，无原生依赖）。
 * 原始需求 2026-09-23（W2.3）：编码面=RGBA8 非隔行（软光栅产物落盘/分享包）；
 * 解码面=RGBA8/RGB8 非隔行+filter 0..4（上传图入引擎 segment 与 .gemshape 贴图
 * 像素面——jpeg/webp 无纯 TS 解码器，typed 拒绝不走浏览器全局）。
 * 正交意图：
 *   [1] encodePng：RGBA → PNG 字节（filter 0 + deflateSync；CRC32 查表）。
 *   [2] decodePng：签名/IHDR/IDAT 校验 → inflate → 逐行 unfilter → RGBA 平面。
 *   [3] typed error：PngCodecError（不支持的位深/色型/隔行/截断——上层转
 *       PNG_ASSET_UNRESOLVED 或上传拒绝）。
 */
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngCodecError';
  }
}

// ---------------------------------------------------------------- CRC32（查表）

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.byteLength, 0);
  head.write(type, 4, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])), 0);
  return Buffer.concat([head, Buffer.from(data), crcBuf]);
}

// ---------------------------------------------------------------- encode

/** RGBA8 → PNG（color type 6，filter 0，非隔行）。data 长度必须 width*height*4。 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (width <= 0 || height <= 0) throw new PngCodecError(`尺寸非法：${width}×${height}`);
  if (rgba.byteLength !== width * height * 4) {
    throw new PngCodecError(`像素面长度 ${rgba.byteLength} ≠ ${width}×${height}×4`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // 扫描线：filter byte 0 + 像素行
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------- decode

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA8 平面 */
  rgba: Uint8Array;
}

/**
 * PNG → RGBA。支持面：bit depth 8 / color type 6(RGBA)·2(RGB) / filter 0..4 /
 * 非隔行。palette/灰度/16bit/隔行=typed 拒绝（当前消费面=本编码器产物、
 * 用户上传常见 RGBA/RGB——覆盖足够，其余显式报错不静默）。
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.byteLength < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngCodecError('不是合法 PNG（签名不符）');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  let interlace = -1;
  const idat: Buffer[] = [];
  while (offset + 8 <= buf.byteLength) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (data.byteLength < length) throw new PngCodecError('PNG 截断（chunk 数据不完整）');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width <= 0 || height <= 0) throw new PngCodecError('IHDR 缺失或尺寸非法');
  if (bitDepth !== 8) throw new PngCodecError(`不支持 bit depth ${bitDepth}（仅 8）`);
  if (colorType !== 6 && colorType !== 2) {
    throw new PngCodecError(`不支持 color type ${colorType}（仅 6 RGBA / 2 RGB）`);
  }
  if (interlace !== 0) throw new PngCodecError('不支持隔行扫描（Adam7）');
  const channels = colorType === 6 ? 4 : 3;
  const bpp = channels; // bytes per pixel（bit depth 8）
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new PngCodecError(
      `像素数据解压失败（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const stride = width * bpp;
  if (inflated.byteLength < height * (1 + stride)) {
    throw new PngCodecError('像素数据不完整（inflate 后长度不足）');
  }
  const raw = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride); // 首行上文=零行
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    const filter = inflated[rowStart]!;
    const src = inflated.subarray(rowStart + 1, rowStart + 1 + stride);
    const dst = raw.subarray(y * stride, (y + 1) * stride);
    unfilterRow(filter, src, dst, prev, bpp);
    prev = Buffer.from(dst);
  }
  // → RGBA 平面
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const d = p * 4;
    rgba[d] = raw[s]!;
    rgba[d + 1] = raw[s + 1]!;
    rgba[d + 2] = raw[s + 2]!;
    rgba[d + 3] = channels === 4 ? raw[s + 3]! : 255;
  }
  return { width, height, rgba };
}

function unfilterRow(
  filter: number,
  src: Buffer,
  dst: Buffer,
  prev: Buffer,
  bpp: number,
): void {
  switch (filter) {
    case 0:
      src.copy(dst);
      return;
    case 1: // Sub
      for (let i = 0; i < dst.length; i++) {
        dst[i] = (src[i]! + (i >= bpp ? dst[i - bpp]! : 0)) & 0xff;
      }
      return;
    case 2: // Up
      for (let i = 0; i < dst.length; i++) {
        dst[i] = (src[i]! + prev[i]!) & 0xff;
      }
      return;
    case 3: // Average
      for (let i = 0; i < dst.length; i++) {
        const left = i >= bpp ? dst[i - bpp]! : 0;
        dst[i] = (src[i]! + ((left + prev[i]!) >> 1)) & 0xff;
      }
      return;
    case 4: // Paeth
      for (let i = 0; i < dst.length; i++) {
        const left = i >= bpp ? dst[i - bpp]! : 0;
        const up = prev[i]!;
        const upLeft = i >= bpp ? prev[i - bpp]! : 0;
        dst[i] = (src[i]! + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new PngCodecError(`未知 filter 类型 ${filter}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
