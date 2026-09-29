/**
 * 图片魔数嗅探（split-admin-portal 2.2/2.4——图片会话链共用单源）。
 * 原始需求 2026-09-29：followup 附件入线与 raw 预览面都「不信扩展名/声明值」，
 * 以字节魔数判定媒体类型；白名单=image/png | image/jpeg | image/webp（gif 不在
 * 图片会话链白名单）。深度解码校验（真图 vs 伪图）归 dsh attachment 服务
 * （saveImages 全解码验证）；本模块只做廉价的第一道门。
 * W5 走查 P0-1（2026-09-28）增补：probeImageSize 魔数级尺寸探测（PNG IHDR/JPEG
 * SOF/WebP 容器头——studio.task.images.list 投影面，同样不解码像素）。
 */

/** 图片会话链白名单媒体类型（contracts AttachmentMetaSchema.mime 同源值域）。 */
export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** 白名单只读视图（消费方校验/文案共用）。 */
export const SNIFFED_IMAGE_MIMES: readonly SniffedImageMime[] = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * 魔数嗅探：PNG（89 50 4E 47）/ JPEG（FF D8 FF）/ WEBP（RIFF 头 + WEBP 标识）。
 * 不在白名单或字节过短返回 null（调用方显式拒绝——不静默降级 octet-stream）。
 */
export function sniffImageMime(bytes: Uint8Array): SniffedImageMime | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return 'image/webp';
  }
  return null;
}

/** 媒体类型 → 展示用扩展名（附件合成名/raw 面文件名用）。 */
export function extensionOfMime(mime: SniffedImageMime): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
  }
}

/**
 * 魔数级尺寸探测（W5 走查 P0-1——studio.task.images.list 的 width/height 投影面）：
 * 只读头部声明（PNG IHDR / JPEG SOF / WebP VP8X|VP8|VP8L），不解码像素——廉价第一道门
 * 的延续。声明缺失/字节过短返回 null（调用方呈现 null，不猜）。
 */
export function probeImageSize(bytes: Uint8Array, mime: SniffedImageMime): { width: number; height: number } | null {
  const be16 = (offset: number): number => (bytes[offset]! << 8) | bytes[offset + 1]!;
  const be32 = (offset: number): number =>
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
  switch (mime) {
    case 'image/png': {
      // 签名(8) + 长度(4) + "IHDR"(4) → width/height 各 BE uint32。
      if (bytes.length < 24) return null;
      return { width: be32(16), height: be32(20) };
    }
    case 'image/jpeg': {
      // 段扫描：FF D8 后逐段跳 length，命中 SOF（C0-CF 除 C4/C8/CC）取尺寸。
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1; // 填充字节（marker 前的 0xFF 串）逐字节前进
          continue;
        }
        const marker = bytes[offset + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2; // 无长度段
          continue;
        }
        if (offset + 4 > bytes.length) return null;
        const length = be16(offset + 2);
        if (
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        ) {
          if (offset + 9 > bytes.length) return null;
          return { height: be16(offset + 5), width: be16(offset + 7) };
        }
        if (length < 2) return null;
        offset += 2 + length;
      }
      return null;
    }
    case 'image/webp': {
      if (bytes.length < 30) return null;
      const fourcc = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
      if (fourcc === 'VP8X') {
        // VP8X：canvas 宽高各 3 字节 LE 存「值-1」。
        const le24 = (offset: number): number =>
          bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
        return { width: le24(24) + 1, height: le24(27) + 1 };
      }
      if (fourcc === 'VP8 ') {
        // lossy：3 字节 frame tag 后 9D 01 2A 同步码，宽高 LE uint14。
        return { width: be16(26) & 0x3fff, height: be16(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        // lossless：0x2F 签名后 14+14 位打包的（宽-1/高-1）。
        const b = (index: number): number => bytes[21 + index]!;
        const width = ((b(0) | (b(1) << 8) | (b(2) << 16)) & 0x3fff) + 1;
        const height = (((b(2) >>> 6) | (b(3) << 2) | (b(4) << 10)) & 0x3fff) + 1;
        return { width, height };
      }
      return null;
    }
  }
}
