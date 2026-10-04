/**
 * 会话附件入线 PNG 归一（P1 修复 2026-10-04——t7a-flagship run1「JPEG 直传 S0 死链」）。
 * 原始需求（T7a 旗舰回归 run1 实证）：原版微信 JPEG 经 RPC 直传（assets.upload →
 * session.followup）后，scene_analyze/subject_segment/pave-preview 三工具面全被
 * `image-decode-failed（仅支持 PNG）` 拒——视觉管线（S0 假设「归一底图恒 PNG」）
 * 与上传面（魔数白名单 png/jpeg/webp）之间的管线级不兼容，agent 6.3min 零分件终报。
 * 根因：PNG 归一只存在于 UI 客户端（agentApi/attachments.ts convertImageToPng，
 * W5 走查 P0-2）——RPC 直传路径无任何归一，字节原样入会话。
 *
 * 修复选型（单一真源裁定）：**会话入线统一转码**——本模块是图片字节进入 agent
 * 会话域的唯一归一入口（followup 单漏斗调用）：非 PNG（jpeg/webp）→ sharp 解码
 * （EXIF 方向 auto-orient）→ encodePng 重编码 → 新 blob + 上传归属行（与
 * assets.upload 同款幂等入账）。后续 prompt 锚注 / tasks.params 审计 /
 * studio.task.images.list / 导出 source.img 全链只见归一 ref，视觉管线 decodePng
 * 的 PNG-only 断言恒成立（不留 ref 双源）。**既有 PNG 路径零变化**（sniff 直通
 * 原 ref，零转码零写入）。
 *
 * 依赖注记：sharp 为原生库，但已在 daemon 依赖闭包内（dsh-attachment-local 的
 * 附件深度解码即 sharp——attachments.ts「深度解码校验归 dsh saveImages」同源）；
 * 此处显式声明为直接依赖（0.35.4 与闭包同实例，不引入第二份二进制）。PNG 编码
 * 恒走仓内 encodePng（确定性——同字节同产物，内容寻址幂等）。
 *
 * 防御面：
 *   - 像素上限 = PNG_MAX_PIXELS（64MP，与 decodePng 解码门同界——解码攻击面
 *     不因转码扩大；sharp limitInputPixels 超限即抛，typed 呈现）。
 *   - 数量超限/非本人 blob/字节不可读/魔数非白名单：一律**原样透传 ref**——由
 *     acquireSessionAttachments 治理面以既有错误语义拒绝（本模块不做第二套拒收
 *     文案，避免双源）。
 *   - 转码失败（坏 JPEG 等）：显式抛错（早期拒）——语义对齐 dsh saveImages 深度
 *     解码门的迟到拒绝，但提前到入线（不入会话后死链）。
 * 正交意图：
 *   [1] normalizeAttachmentsToPng：入线归一编排（逐 ref 判定+转码+归属入账）。
 *   [2] transcodeToPngBytes：单图转码纯执行面（sharp 解码→RGBA→encodePng）。
 */
import sharp, { type OutputInfo } from 'sharp';
import type { SqliteDb } from '../db/database.js';
import { recordBlobUpload, userOwnsBlobRef, type BlobStore } from '../db/blobs.js';
import { encodePng, PNG_MAX_PIXELS } from '../png/codec.js';
import { sniffImageMime } from '../image-sniff.js';
import { FOLLOWUP_ATTACHMENTS_MAX_COUNT } from './attachments.js';

/** 入线归一依赖（与 acquireSessionAttachments 同构的最小面）。 */
export interface AttachmentNormalizeDeps {
  db: SqliteDb;
  blobs: BlobStore;
}

/**
 * 单图转码纯执行面：任意可解码图字节 → PNG 字节（EXIF 方向归一 + RGBA→encodePng
 * 确定性编码）。像素超 PNG_MAX_PIXELS / 解码失败 → 抛错（typed 呈现给调用方）。
 */
export async function transcodeToPngBytes(bytes: Uint8Array): Promise<{
  png: Uint8Array;
  width: number;
  height: number;
}> {
  let raw: { data: Uint8Array; info: OutputInfo };
  try {
    raw = await sharp(bytes, { limitInputPixels: PNG_MAX_PIXELS })
      .rotate() // EXIF 方向 auto-orient（UI canvas 转码路同语义）
      .ensureAlpha() // JPEG 无 alpha → RGBA 四通道（encodePng 输入面）
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(
      `附件转码失败（→ PNG）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (raw.info.channels !== 4) {
    // 防御断言：ensureAlpha 后恒四通道——libvips 行为漂移面（不可达常态）。
    throw new Error(`附件转码内部错误：期望 RGBA 四通道，实为 ${raw.info.channels} 通道`);
  }
  const { width, height } = raw.info;
  return { png: encodePng(width, height, raw.data), width, height };
}

/**
 * 会话入线 PNG 归一（followup 单漏斗的唯一入口调用）：逐 ref 判定——PNG/不可判
 * 定面原样透传（治理面语义不变），jpeg/webp 转码为新 PNG blob + 归属入账后以新
 * ref 替换。数组逐位对应（长度恒等——imageId 按输入顺序分配的 A5 语义不变）。
 * 幂等：同字节同 PNG（内容寻址）→ 重复 followup 零膨胀。
 */
export async function normalizeAttachmentsToPng(
  deps: AttachmentNormalizeDeps,
  userId: string,
  blobRefs: string[],
): Promise<string[]> {
  // 数量超限：整组透传（治理面以既有文案拒——不在归一面做第二套门）。
  if (blobRefs.length === 0 || blobRefs.length > FOLLOWUP_ATTACHMENTS_MAX_COUNT) {
    return [...blobRefs];
  }
  const normalized: string[] = [];
  for (const ref of blobRefs) {
    normalized.push(await normalizeOne(deps, userId, ref));
  }
  return normalized;
}

async function normalizeOne(
  deps: AttachmentNormalizeDeps,
  userId: string,
  ref: string,
): Promise<string> {
  // 归属/可读/白名单前置：不满足面透传原 ref——acquireSessionAttachments 治理
  //（CAS/owner/acquireRef/嗅探/字节门）以既有错误语义拒绝，本模块零重复拒收。
  if (!userOwnsBlobRef(deps.db, ref, userId)) return ref;
  const bytes = deps.blobs.read(ref);
  if (bytes === null) return ref;
  const mime = sniffImageMime(bytes);
  if (mime === null || mime === 'image/png') return ref;

  // jpeg/webp → PNG（唯一真源转码点）。
  const { png } = await transcodeToPngBytes(bytes);
  const put = deps.blobs.put(png);
  recordBlobUpload(deps.db, put.hash, userId); // 归属入账（=assets.upload 幂等语义）
  return put.hash;
}
