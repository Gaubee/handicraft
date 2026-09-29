/**
 * 图片魔数嗅探（split-admin-portal 2.2/2.4——图片会话链共用单源）。
 * 原始需求 2026-09-29：followup 附件入线与 raw 预览面都「不信扩展名/声明值」，
 * 以字节魔数判定媒体类型；白名单=image/png | image/jpeg | image/webp（gif 不在
 * 图片会话链白名单）。深度解码校验（真图 vs 伪图）归 dsh attachment 服务
 * （saveImages 全解码验证）；本模块只做廉价的第一道门。
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
