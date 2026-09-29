/**
 * 素材库服务（split-admin-portal 4.3——素材库服务化的存储真源）。
 * 原始需求 2026-09-29（design §5 素材库行）：asset_library 表=owner 隔离的虚拟
 * 文件系统（目录/图片两态），内容字节入 blobs 内容寻址（行存 blob_hash 引用，
 * put 去重+计数）；软删=回收站语义（目录递归盖戳）。
 * 语义骨架（与 stones/sets 服务同族）：
 *   - 同父重名自动后缀 ' (2)'（客户端虚拟文件系统习惯——assetStore 同规）。
 *   - 移动=父变更（环检测：沿目标祖先链命中自身必拒）；根（parent_id=NULL）合法。
 *   - 迁移确定性 id：`al-<ownerId>:<clientId>`——IDB 批量上行重试幂等（existing
 *     跳过不重写内容）；owner 命名空间隔离（不同用户迁移同名系统目录 id 不冲突）。
 *   - 错误面：AssetsLibraryError（typed code）→ RPC 层投影 BAD_REQUEST+data.code。
 * 正交意图：
 *   [1] 行 CRUD（listNodes/rowOf/createDir/uploadImage/moveNode/renameNode）。
 *   [2] 回收站（softDelete 递归盖戳/restore 祖先链校验/purgeTrash 叶先硬删+blob 释放）。
 *   [3] 迁移面（migrateBatch 确定性 id 批量上行/verifyManifest 清单 hash 汇总）。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { recordBlobUpload } from '../db/blobs.js';
import { nowIso } from '../db/store.js';
import { sniffImageMime } from '../image-sniff.js';
import { assetsLibManifestPayload, type AssetsLibMigrateItem, type AssetsLibMigrateResult } from '@handicraft/contracts';

export type AssetsLibraryErrorCode =
  | 'not-found'
  | 'not-a-dir'
  | 'parent-deleted'
  | 'cycle'
  | 'ancestor-still-deleted'
  | 'id-conflict'
  | 'invalid-image'
  | 'orphan-parent';

export class AssetsLibraryError extends Error {
  constructor(
    readonly code: AssetsLibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssetsLibraryError';
  }
}

/** asset_library 表行（snake_case 直投影——camelCase 视图由 toNode 折算）。 */
export interface AssetLibraryRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  is_dir: number;
  mime: string | null;
  width: number | null;
  height: number | null;
  blob_hash: string | null;
  bytes: number;
  soft_deleted: number;
  created_at: string;
  updated_at: string;
}

export interface AssetsLibraryServiceDeps {
  db: SqliteDb;
  blobs: BlobStore;
}

/** 迁移确定性 id（owner 命名空间——IDB 系统目录 id 跨用户同名不冲突；重试幂等）。 */
export function migratedRouteId(ownerId: string, clientId: string): string {
  return `al-${ownerId}:${clientId}`;
}

/** 同父重名自动后缀 ' (2)'、' (3)'…（assetStore uniqueNameAmong 同规）。 */
function uniqueNameAmong(existingNames: readonly string[], desired: string): string {
  const taken = new Set(existingNames);
  if (!taken.has(desired)) return desired;
  for (let n = 2; ; n += 1) {
    const candidate = `${desired} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export class AssetsLibraryService {
  constructor(private readonly deps: AssetsLibraryServiceDeps) {}

  rowOf(id: string): AssetLibraryRow | null {
    const row = this.deps.db.prepare('SELECT * FROM asset_library WHERE id = ?').get(id) as
      | AssetLibraryRow
      | undefined;
    return row ?? null;
  }

  /** 素材清单（flat——客户端按 parent_id 组树）。ownerId=undefined → 全部归属
   * （admin 后台集中管理面；普通用户经 RPC 层恒收窄为自己的 id）。 */
  listNodes(ownerId: string | undefined, includeTrashed: boolean): AssetLibraryRow[] {
    const ownerCond = ownerId === undefined ? '' : 'AND owner_id = ?';
    const params = ownerId === undefined ? [] : [ownerId];
    const sql = includeTrashed
      ? `SELECT * FROM asset_library WHERE 1 = 1 ${ownerCond} ORDER BY owner_id, created_at, id`
      : `SELECT * FROM asset_library WHERE soft_deleted = 0 ${ownerCond} ORDER BY owner_id, created_at, id`;
    return this.deps.db.prepare(sql).all(...params) as AssetLibraryRow[];
  }

  // ---------------------------------------------------------------- [1] 行 CRUD

  /** 父目录校验：存在+是目录+未软删（软删目录内不新建——先恢复再整理）。 */
  private requireDirParent(ownerId: string, parentId: string | null): void {
    if (parentId === null) return;
    const parent = this.rowOf(parentId);
    if (parent === null) throw new AssetsLibraryError('not-found', `父目录不存在：${parentId}`);
    if (parent.owner_id !== ownerId) throw new AssetsLibraryError('not-found', `父目录不存在：${parentId}`);
    if (parent.is_dir !== 1) throw new AssetsLibraryError('not-a-dir', '目标位置不是文件夹');
    if (parent.soft_deleted !== 0) throw new AssetsLibraryError('parent-deleted', '父目录在回收站内——先恢复再在其中整理');
  }

  private siblingNames(parentId: string | null): string[] {
    const rows = (
      parentId === null
        ? this.deps.db.prepare('SELECT name FROM asset_library WHERE parent_id IS NULL').all()
        : this.deps.db.prepare('SELECT name FROM asset_library WHERE parent_id = ?').all(parentId)
    ) as { name: string }[];
    return rows.map((row) => row.name);
  }

  private insertRow(
    ownerId: string,
    parentId: string | null,
    name: string,
    isDir: boolean,
    image: { mime: string; blobHash: string; bytes: number; width?: number; height?: number } | null,
    id?: string,
  ): AssetLibraryRow {
    const now = nowIso();
    const rowId = id ?? `al-${randomUUID()}`;
    this.deps.db
      .prepare(
        'INSERT INTO asset_library (id, owner_id, parent_id, name, is_dir, mime, width, height, blob_hash, bytes, soft_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      )
      .run(
        rowId,
        ownerId,
        parentId,
        name,
        isDir ? 1 : 0,
        image?.mime ?? null,
        image?.width ?? null,
        image?.height ?? null,
        image?.blobHash ?? null,
        image?.bytes ?? 0,
        now,
        now,
      );
    return this.rowOf(rowId)!;
  }

  createDir(ownerId: string, parentId: string | null, name: string): AssetLibraryRow {
    this.requireDirParent(ownerId, parentId);
    return this.insertRow(ownerId, parentId, uniqueNameAmong(this.siblingNames(parentId), name), true, null);
  }

  /**
   * 图片入库：魔数嗅探定 MIME（png/jpeg/webp 白名单——不信申报）；字节入 blobs
   * 内容寻址（去重+计数）；归属账本记录（raw 预览面 owner 校验共用——波 2.2 单源）。
   */
  uploadImage(
    ownerId: string,
    parentId: string | null,
    name: string,
    bytes: Uint8Array,
    width?: number,
    height?: number,
  ): AssetLibraryRow {
    this.requireDirParent(ownerId, parentId);
    const mime = sniffImageMime(bytes);
    if (mime === null) {
      throw new AssetsLibraryError('invalid-image', '素材不是受支持的图片（png/jpeg/webp 魔数嗅探失败）');
    }
    if (bytes.byteLength === 0) throw new AssetsLibraryError('invalid-image', '图片内容为空');
    const put = this.deps.blobs.put(bytes);
    recordBlobUpload(this.deps.db, put.hash, ownerId);
    return this.insertRow(ownerId, parentId, uniqueNameAmong(this.siblingNames(parentId), name), false, {
      mime,
      blobHash: put.hash,
      bytes: put.size,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  }

  /** 移动=父变更（环检测：沿新父祖先链命中自身必拒——store 层而非仅 UI 禁用）。 */
  moveNode(id: string, newParentId: string | null, ownerId: string): AssetLibraryRow {
    const row = this.rowOf(id);
    if (row === null) throw new AssetsLibraryError('not-found', `素材不存在：${id}`);
    this.requireDirParent(ownerId, newParentId);
    if (newParentId === id) throw new AssetsLibraryError('cycle', '不能移动到自身');
    if (newParentId !== null) {
      let cursor: string | null = newParentId;
      while (cursor !== null) {
        if (cursor === id) throw new AssetsLibraryError('cycle', '不能移动到自身或其后代');
        cursor = this.rowOf(cursor)?.parent_id ?? null;
      }
    }
    const name = uniqueNameAmong(this.siblingNames(newParentId), row.name);
    this.deps.db.prepare('UPDATE asset_library SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
      newParentId,
      name,
      nowIso(),
      id,
    );
    return this.rowOf(id)!;
  }

  renameNode(id: string, name: string): AssetLibraryRow {
    const row = this.rowOf(id);
    if (row === null) throw new AssetsLibraryError('not-found', `素材不存在：${id}`);
    const unique = uniqueNameAmong(this.siblingNames(row.parent_id), name);
    this.deps.db.prepare('UPDATE asset_library SET name = ?, updated_at = ? WHERE id = ?').run(unique, nowIso(), id);
    return this.rowOf(id)!;
  }

  // ---------------------------------------------------------------- [2] 回收站

  /** 子树全行（BFS 含已软删后代——重盖戳幂等）。 */
  private collectSubtree(rootId: string): AssetLibraryRow[] {
    const collected: AssetLibraryRow[] = [];
    const queue = [rootId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const row = this.rowOf(current);
      if (row !== null) collected.push(row);
      const children = this.deps.db
        .prepare('SELECT id FROM asset_library WHERE parent_id = ?')
        .all(current) as { id: string }[];
      for (const child of children) queue.push(child.id);
    }
    return collected;
  }

  /** 软删（回收站语义）：子树整树盖戳；已盖戳幂等（行数照计——语义面宽松）。 */
  softDelete(id: string): { softDeletedRows: number } {
    const row = this.rowOf(id);
    if (row === null) throw new AssetsLibraryError('not-found', `素材不存在：${id}`);
    const subtree = this.collectSubtree(id);
    const now = nowIso();
    const stamp = this.deps.db.prepare('UPDATE asset_library SET soft_deleted = 1, updated_at = ? WHERE id = ?');
    for (const member of subtree) stamp.run(now, member.id);
    return { softDeletedRows: subtree.length };
  }

  /** 恢复：祖先链仍有盖戳必拒（先恢复祖先——不静默半恢复）。 */
  restore(id: string): { restoredRows: number } {
    const row = this.rowOf(id);
    if (row === null) throw new AssetsLibraryError('not-found', `素材不存在：${id}`);
    let cursor = row.parent_id;
    while (cursor !== null) {
      const ancestor = this.rowOf(cursor);
      if (ancestor === null) break;
      if (ancestor.soft_deleted !== 0) {
        throw new AssetsLibraryError(
          'ancestor-still-deleted',
          `祖先目录仍在回收站（${ancestor.name}）——先恢复祖先再恢复本项`,
        );
      }
      cursor = ancestor.parent_id;
    }
    const subtree = this.collectSubtree(id);
    const now = nowIso();
    const clear = this.deps.db.prepare('UPDATE asset_library SET soft_deleted = 0, updated_at = ? WHERE id = ?');
    for (const member of subtree) clear.run(now, member.id);
    return { restoredRows: subtree.length };
  }

  /**
   * 清空回收站（硬删）：owner 域全部软删行——叶先序删除（FK ON：父行先删会撞
   * 子行外键）；每删一个图片行释放一次 blob 引用（put 按行计数——逐行对冲）。
   */
  purgeTrash(ownerId: string): { purgedNodeIds: string[]; releasedBlobHashes: string[] } {
    const rows = this.deps.db
      .prepare('SELECT * FROM asset_library WHERE owner_id = ? AND soft_deleted = 1')
      .all(ownerId) as AssetLibraryRow[];
    // 深度序（深者先删）：按祖先链长度降序。
    const depthOf = (row: AssetLibraryRow): number => {
      let depth = 0;
      let cursor = row.parent_id;
      while (cursor !== null) {
        depth += 1;
        cursor = this.rowOf(cursor)?.parent_id ?? null;
      }
      return depth;
    };
    const ordered = [...rows].sort((a, b) => depthOf(b) - depthOf(a));
    const del = this.deps.db.prepare('DELETE FROM asset_library WHERE id = ?');
    const released: string[] = [];
    const purged: string[] = [];
    for (const row of ordered) {
      del.run(row.id);
      purged.push(row.id);
      if (row.is_dir === 0 && row.blob_hash !== null) {
        this.deps.blobs.releaseRef(row.blob_hash);
        released.push(row.blob_hash);
      }
    }
    return { purgedNodeIds: purged, releasedBlobHashes: released };
  }

  // ---------------------------------------------------------------- [3] 迁移面

  /**
   * IDB 批量上行（目录树先行——客户端编排；本端点单批内自洽解析父引用）：
   * 确定性 id 已在场=status 'existing'（重试幂等——内容不重写）；父 clientId
   * 未在批内或服务端不在场=typed 拒 orphan-parent（客户端按序分批可避免）。
   */
  migrateBatch(ownerId: string, items: readonly AssetsLibMigrateItem[]): AssetsLibMigrateResult[] {
    const results: AssetsLibMigrateResult[] = [];
    for (const item of items) {
      const rowId = migratedRouteId(ownerId, item.clientId);
      const existing = this.rowOf(rowId);
      if (existing !== null) {
        if (existing.owner_id !== ownerId || existing.is_dir !== (item.isDir ? 1 : 0)) {
          throw new AssetsLibraryError('id-conflict', `迁移 id 冲突：${item.clientId}（既有行形态不符）`);
        }
        results.push({ clientId: item.clientId, status: 'existing', id: rowId });
        continue;
      }
      // 父引用解析：确定性路由 id 直查（批内先行项已插入即命中；批外/未上行=typed 拒）。
      let parentId: string | null = null;
      if (item.parentClientId !== null) {
        const parentRow = this.rowOf(migratedRouteId(ownerId, item.parentClientId));
        if (parentRow === null) {
          throw new AssetsLibraryError(
            'orphan-parent',
            `父目录尚未上行：${item.parentClientId}（目录树先行——分批按序，勿跳批）`,
          );
        }
        if (parentRow.owner_id !== ownerId || parentRow.is_dir !== 1) {
          throw new AssetsLibraryError('orphan-parent', `父引用不是本人的目录：${item.parentClientId}`);
        }
        parentId = parentRow.id;
      }
      if (item.isDir) {
        this.insertRow(ownerId, parentId, item.name, true, null, rowId);
      } else {
        const bytes = Buffer.from(item.dataBase64, 'base64');
        const mime = sniffImageMime(bytes);
        if (mime === null) {
          throw new AssetsLibraryError('invalid-image', `迁移项不是受支持的图片：${item.name}（png/jpeg/webp 魔数嗅探失败）`);
        }
        if (bytes.byteLength === 0) throw new AssetsLibraryError('invalid-image', `迁移项内容为空：${item.name}`);
        const put = this.deps.blobs.put(bytes);
        recordBlobUpload(this.deps.db, put.hash, ownerId);
        this.insertRow(ownerId, parentId, item.name, false, {
          mime,
          blobHash: put.hash,
          bytes: put.size,
          ...(item.width !== undefined ? { width: item.width } : {}),
          ...(item.height !== undefined ? { height: item.height } : {}),
        }, rowId);
      }
      results.push({ clientId: item.clientId, status: 'created', id: rowId });
    }
    return results;
  }

  /**
   * 清单核对：服务端本人非软删图片行 → (blobHash, bytes) 汇总（assetsLibManifestPayload
   * 同源格式）sha256 vs 前端申报。serverNodes 全量回传（客户端比对求不符清单）。
   */
  verifyManifest(
    ownerId: string,
    declared: { declaredCount: number; declaredBytes: number; declaredDigest: string },
  ): {
    match: boolean;
    serverCount: number;
    serverBytes: number;
    serverDigest: string;
    serverNodes: Array<{ id: string; name: string; blobHash: string; bytes: number }>;
  } {
    const rows = this.deps.db
      .prepare(
        'SELECT id, name, blob_hash, bytes FROM asset_library WHERE owner_id = ? AND is_dir = 0 AND soft_deleted = 0 AND blob_hash IS NOT NULL',
      )
      .all(ownerId) as Array<{ id: string; name: string; blob_hash: string; bytes: number }>;
    const serverNodes = rows.map((row) => ({
      id: row.id,
      name: row.name,
      blobHash: row.blob_hash as string,
      bytes: row.bytes,
    }));
    const payload = assetsLibManifestPayload(serverNodes.map((node) => ({ blobHash: node.blobHash, bytes: node.bytes })));
    const serverDigest = createHash('sha256').update(payload, 'utf8').digest('hex');
    const serverCount = serverNodes.length;
    const serverBytes = serverNodes.reduce((sum, node) => sum + node.bytes, 0);
    return {
      match:
        serverCount === declared.declaredCount && serverBytes === declared.declaredBytes && serverDigest === declared.declaredDigest,
      serverCount,
      serverBytes,
      serverDigest,
      serverNodes,
    };
  }
}
