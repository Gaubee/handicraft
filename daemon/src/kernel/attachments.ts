/**
 * followup 附件治理（split-admin-portal 2.2——图片会话链的账本/归属/入线门）。
 * 原始需求 2026-09-29（design §1「会话附件生命周期」+ §3）：
 *   [1] 会话 CAS 同事务取得引用（clearing/cleared 原子拒——W3 P1-3 裁决原样）；
 *   [2] owner 校验（blob_uploads 本人上传 ∪ 本人会话已引用——防跨用户 hash 挂账）；
 *   [3] 会话清空防重放：clear 释放引用后，仅凭已清空会话的旧 ref 无从再取得归属
 *       （owner 面已删行）；blob 归零置 deleting 后 acquireRef 显式拒（不复活）；
 *   [4] 入线门：字节读回 + 魔数嗅探（png/jpeg/webp 白名单——伪图显式拒）；
 *       深度解码校验归 dsh attachment 服务（saveImages 全解码）。
 * 返回 AttachmentMaterial[]（物料桥 2.3 的输入——字节+媒体类型+合成名）。
 */
import type { SqliteDb } from '../db/database.js';
import { userOwnsBlobRef } from '../db/blobs.js';
import type { BlobStore } from '../db/blobs.js';
import { extensionOfMime, sniffImageMime, type SniffedImageMime } from '../image-sniff.js';

/** 单次 followup 附件数量上限（物料桥内存面有界——dsh imageLimits 之外的产品门）。 */
export const FOLLOWUP_ATTACHMENTS_MAX_COUNT = 8;

/** 单次 followup 附件总字节上限（32MiB——与 assets.upload 单件门同量级）。 */
export const FOLLOWUP_ATTACHMENTS_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** 物料桥输入（BlobStore 字节已读回+嗅探过；name 为服务端合成展示名）。 */
export interface AttachmentMaterial {
  blobRef: string;
  data: Uint8Array;
  mediaType: SniffedImageMime;
  name: string;
}

export interface AttachmentGovernanceDeps {
  db: SqliteDb;
  blobs: BlobStore;
}

/**
 * 附件取得（单事务）：会话可写 CAS → 数量/总字节门 → 逐件 owner 校验 + acquireRef +
 * 账本行 + 字节读回 + 魔数嗅探。任一失败整体回滚（引用计数与账本零残留——
 * put/acquire 的副作用都在事务体内，回滚由启动孤儿回收兜底文件面）。
 */
export function acquireSessionAttachments(
  deps: AttachmentGovernanceDeps,
  user: { id: string },
  sessionId: string,
  blobRefs: string[],
): AttachmentMaterial[] {
  const { db, blobs } = deps;
  const commit = db.transaction((): AttachmentMaterial[] => {
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as
      | { status: string }
      | undefined;
    if (!session) throw new Error(`会话不存在：${sessionId}`);
    if (session.status !== 'active') throw new Error(`会话正在清理或已清理，拒绝新输入：${sessionId}`);
    if (blobRefs.length > FOLLOWUP_ATTACHMENTS_MAX_COUNT) {
      throw new Error(`附件数量超上限（${blobRefs.length} > ${FOLLOWUP_ATTACHMENTS_MAX_COUNT}）`);
    }
    const materials: AttachmentMaterial[] = [];
    let totalBytes = 0;
    for (const ref of blobRefs) {
      if (!userOwnsBlobRef(db, ref, user.id)) {
        throw new Error(`附件 blobRef 不属于当前用户（拒绝跨用户引用）：${ref}`);
      }
      blobs.acquireRef(ref); // 缺失/deleting 行显式抛错——不静默复活
      db.prepare('INSERT INTO session_blob_refs (session_id, blob_hash, created_at) VALUES (?, ?, ?)').run(
        sessionId,
        ref,
        new Date().toISOString(),
      );
      const bytes = blobs.read(ref);
      if (bytes === null) {
        throw new Error(`附件 blob 不可读（存储异常）：${ref}`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > FOLLOWUP_ATTACHMENTS_MAX_TOTAL_BYTES) {
        throw new Error(`附件总字节超上限（>${FOLLOWUP_ATTACHMENTS_MAX_TOTAL_BYTES}）`);
      }
      const mediaType = sniffImageMime(bytes);
      if (mediaType === null) {
        throw new Error(`附件不是受支持的图片（png/jpeg/webp 魔数嗅探失败）：${ref}`);
      }
      materials.push({
        blobRef: ref,
        data: bytes,
        mediaType,
        name: `attachment-${ref.slice(0, 12)}.${extensionOfMime(mediaType)}`,
      });
    }
    return materials;
  });
  return commit();
}
