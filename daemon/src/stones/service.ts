/**
 * 装饰钻库服务（add-stone-library design §1.1/§1.2/§1.6——S1.2/S1.4/S1.5）。
 * 原始需求 2026-09-24（Owner 补充定调三）：可贴原子={贴图,尺寸,颜色,元数据}，
 * 沿素材库虚拟文件系统方案落 daemon 资产面——resources 行是唯一真源，
 * stone_index 是同事务维护的可重建投影（§1.1 裁决 A）。
 * 复用面（W4.2 已验收范式——layout-doc.ts / blobs.ts 同构）：
 *   owner/revision CAS（§3.6.4 grant 绑定 baseRevision）/ parent_id 树 /
 *   blobs sha256+ref_count 内容寻址去重（同贴图字节跨原子只存一份）。
 * 正交意图：
 *   [1] 系统根/供应商目录幂等 seed（meta.role：stones-root/standards-root/supplier，
 *       skuProfile 挂 meta——§2 档案存目录行）。
 *   [2] 原子生命周期：四步同事务建（目录行+stone.json+贴图+blob）/ 字段 patch
 *       （revision CAS，色系重指=同事务移目录）/ 同父名冲突 ` (2)` /
 *       supplier×sku 唯一（typed error 定位既有条目）。
 *   [3] 软删/硬删/引用保护：trashedAt 递归盖戳（级联原子可见性=任一祖先或自身
 *       盖戳即不可见）/ blob ref_count GC（归零置 deleting）/ 引用解析四态
 *       （resolved/soft-deleted/blob-missing/wrong-kind——gem-catalog §四 P0-2
 *       面 7 先例；行不存在=显式 not-found 第五态，硬清后引用方形态）。
 *   [4] stone_index 同事务维护 + 全量重建（REINDEX——投影不是第二真源）。
 * revision 落位：原子目录行（stone_index.resource_id）——授权桥 grant 绑定
 * resourceId+baseRevision 的唯一 CAS 点；stone.json 文件行只跟内容（hash/size）。
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  parseSku,
  rgbToHex,
  StoneFileSchema,
  SupplierSkuProfileSchema,
  type RgbTuple,
  type StoneFile,
  type SupplierSkuProfile,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { nowIso } from '../db/store.js';
import { gateStoneTexture } from './gates.js';

// ---------------------------------------------------------------- typed errors

export type StoneServiceErrorCode =
  | 'not-found'
  | 'wrong-kind'
  | 'sku-conflict'
  | 'revision-conflict'
  | 'texture-missing'
  | 'blob-missing'
  | 'system-dir-protected'
  | 'not-trashed'
  | 'schema';

export class StoneServiceError extends Error {
  readonly code: StoneServiceErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: StoneServiceErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'StoneServiceError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- 行/元数据形状

interface ResourceRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  is_dir: number;
  content_hash: string | null;
  size: number;
  meta: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** resources.meta JSON 形状（TEXT 落库——schema.ts 偏差说明；未知键保留透传）。 */
interface ResourceMeta {
  role?: 'stones-root' | 'standards-root' | 'supplier';
  kind?: 'stone' | 'stone-texture';
  skuProfile?: SupplierSkuProfile;
  trashedAt?: string;
}

/** 系统目录 role 集（禁删保护——§1.6「系统根/供应商档案目录禁删」）。 */
const PROTECTED_ROLES = new Set(['stones-root', 'standards-root', 'supplier']);

const STONES_ROOT_NAME = 'stones';
const STANDARDS_ROOT_NAME = 'standards';
const STONE_JSON_NAME = 'stone.json';
export const STONE_TEXTURE_FILE_NAME = '贴图.png';

function parseMeta(raw: string | null): ResourceMeta {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as ResourceMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 输入形状

export interface CreateStoneInput {
  ownerId: string;
  /** 供应商档案（幂等 seed 供应商目录；supplier 字段是唯一性键的一半） */
  supplierProfile: SupplierSkuProfile;
  draft: {
    name: string;
    sku: string;
    /** 缺省时服务端尝试 parseSku(profile, sku) 物化；解析失败留空（显式，不猜测） */
    skuParsed?: StoneFile['skuParsed'];
    sizeMm: number | null;
    color: { name: string; rgb: RgbTuple; family: string; finish: string };
    shapeClass?: string;
    gemshapeRef?: string;
    views?: string[];
    metadata?: Record<string, unknown>;
    texture: { declaredWidth: number; declaredHeight: number };
  };
  /** 贴图字节（gate 6：缺贴图=typed 拒，不静默降级） */
  textureBytes: Uint8Array;
}

/** 字段级 patch（undefined=不动；null=清除可选字段——显式语义）。 */
export interface StonePatch {
  name?: string;
  sizeMm?: number | null;
  color?: { name?: string; rgb?: RgbTuple; family?: string; finish?: string };
  shapeClass?: string | null;
  gemshapeRef?: string | null;
  views?: string[];
  /** 浅合并（键级覆盖；置 undefined 值的键不落——schema 校验把关） */
  metadata?: Record<string, unknown>;
  /** 贴图替换=新内容新 hash（内容寻址），id 不变（§1.6 更新行） */
  texture?: { bytes: Uint8Array; declaredWidth: number; declaredHeight: number };
}

export interface CreateStoneResult {
  /** 原子目录行 id（stone_index.resource_id / StonePick.resourceId / 引用键） */
  resourceId: string;
  stoneId: string;
  revision: number;
  path: string;
  textureBlobRef: string;
  stoneJsonBlobRef: string;
}

export interface UpdateStoneResult {
  resourceId: string;
  revision: number;
  path: string;
}

export interface StoneRefResolution {
  resourceId: string;
  state: 'resolved' | 'soft-deleted' | 'blob-missing' | 'wrong-kind' | 'not-found';
  stone?: StoneFile;
  revision?: number;
}

export interface GetStoneResult {
  resourceId: string;
  revision: number;
  path: string;
  trashed: boolean;
  stone: StoneFile;
  texture: { blobRef: string; width: number; height: number };
}

// ---------------------------------------------------------------- 服务

export interface StoneServiceDeps {
  db: SqliteDb;
  blobs: BlobStore;
}

export class StoneService {
  constructor(private readonly deps: StoneServiceDeps) {}

  private get db(): SqliteDb {
    return this.deps.db;
  }

  private get blobs(): BlobStore {
    return this.deps.blobs;
  }

  // -------------------------------------------------------------- seed（幂等）

  /** stones/ + stones/standards/ 系统根（幂等——首访问建，meta.role 标记）。 */
  ensureRoots(ownerId: string): { stonesRootId: string; standardsRootId: string } {
    return this.db.transaction(() => {
      const stonesRootId = this.ensureSystemDir(ownerId, null, STONES_ROOT_NAME, { role: 'stones-root' });
      const standardsRootId = this.ensureSystemDir(ownerId, stonesRootId, STANDARDS_ROOT_NAME, {
        role: 'standards-root',
      });
      return { stonesRootId, standardsRootId };
    })();
  }

  /** 供应商目录（=一个「标准」；meta.skuProfile=SKU 编码档案 §2）。 */
  ensureSupplier(ownerId: string, profile: SupplierSkuProfile): string {
    const parsed = SupplierSkuProfileSchema.parse(profile);
    return this.db.transaction(() => {
      const { standardsRootId } = this.ensureRoots(ownerId);
      const meta: ResourceMeta = { role: 'supplier', skuProfile: parsed };
      const existing = this.childDirOf(standardsRootId, parsed.supplier);
      if (existing) {
        // 已存在：档案以首档冻结（快照哲学——修订不回写已入库钻；换档显式改 meta 归管理面）
        return existing.id;
      }
      return this.insertDir(ownerId, standardsRootId, parsed.supplier, meta);
    })();
  }

  /** 系统目录幂等查找：meta.role 全局唯一标记（studio.ts meta LIKE 先例）。 */
  private ensureSystemDir(ownerId: string, parentId: string | null, name: string, meta: ResourceMeta): string {
    const like = `%"role":"${meta.role}"%`;
    const existing = this.db
      .prepare('SELECT id FROM resources WHERE is_dir = 1 AND meta LIKE ?')
      .get(like) as { id: string } | undefined;
    if (existing) return existing.id;
    const byName = parentId === null
      ? this.db.prepare('SELECT id FROM resources WHERE parent_id IS NULL AND name = ? AND is_dir = 1').get(name)
      : this.db.prepare('SELECT id FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 1').get(parentId, name);
    const named = byName as { id: string } | undefined;
    if (named) {
      // 同名私有目录已存在但未标 role：补标（首访问领养——系统根语义全局唯一）
      this.db.prepare('UPDATE resources SET meta = ? WHERE id = ?').run(
        JSON.stringify({ ...parseMeta(this.rowOf(named.id)?.meta ?? null), ...meta }),
        named.id,
      );
      return named.id;
    }
    return this.insertDir(ownerId, parentId, name, meta);
  }

  // -------------------------------------------------------------- 创建（四步同事务）

  createStone(input: CreateStoneInput): CreateStoneResult {
    const profile = SupplierSkuProfileSchema.parse(input.supplierProfile);
    const draft = input.draft;
    // gate 全链前置（纯函数——事务外拒收，坏输入零落库）。
    if (input.textureBytes === undefined || input.textureBytes.byteLength === 0) {
      throw new StoneServiceError('texture-missing', '缺贴图（gate 6：missing=显式态，不静默降级）');
    }
    const gate = gateStoneTexture({
      bytes: input.textureBytes,
      declaredWidth: draft.texture.declaredWidth,
      declaredHeight: draft.texture.declaredHeight,
      shapeClass: draft.shapeClass ?? 'round',
      sizeMm: draft.sizeMm,
    });
    return this.db.transaction(() => {
      const supplierDirId = this.ensureSupplier(input.ownerId, profile);
      // supplier×sku 唯一前置查（UNIQUE 索引兜底竞态——两者同映射 sku-conflict）。
      const clash = this.db
        .prepare('SELECT resource_id FROM stone_index WHERE supplier = ? AND sku = ?')
        .get(profile.supplier, draft.sku) as { resource_id: string } | undefined;
      if (clash) {
        throw new StoneServiceError(
          'sku-conflict',
          `supplier×sku 已存在：${profile.supplier}/${draft.sku}（resourceId=${clash.resource_id}）`,
          { existingResourceId: clash.resource_id, supplier: profile.supplier, sku: draft.sku },
        );
      }
      const now = nowIso();
      const stoneId = `stn-${randomUUID()}`;
      // skuParsed 物化快照：调用方显式给值优先（导入器真值）；缺省按档案解析，
      // 解析失败留空（显式容忍非标准码——不猜测）。
      const skuParsed = draft.skuParsed ?? this.parsedSkuOrNull(profile, draft.sku);
      const stone: StoneFile = {
        kind: 'stone',
        formatVersion: 1,
        id: stoneId,
        name: draft.name,
        supplier: profile.supplier,
        sku: draft.sku,
        ...(skuParsed !== undefined ? { skuParsed } : {}),
        sizeMm: draft.sizeMm,
        color: draft.color,
        texture: {
          file: STONE_TEXTURE_FILE_NAME,
          mime: 'image/png',
          width: gate.width,
          height: gate.height,
          alphaBounds: gate.alphaBounds, // 实测真值入库（声明值仅对账——S0 schema 注）
        },
        ...(draft.shapeClass !== undefined ? { shapeClass: draft.shapeClass } : {}),
        ...(draft.gemshapeRef !== undefined ? { gemshapeRef: draft.gemshapeRef } : {}),
        ...(draft.views !== undefined ? { views: draft.views } : {}),
        metadata: draft.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      const stoneFile = StoneFileSchema.parse(stone);
      // 目录树：供应商/色系（ensureDir 复用）/款式行（ensureDir 复用）/原子目录（唯一名）。
      const familyDirId = this.ensureChildDir(input.ownerId, supplierDirId, draft.color.family);
      const styleDirName = skuParsed !== undefined ? `${skuParsed.row}-${draft.color.name}` : draft.color.name;
      const styleDirId = this.ensureChildDir(input.ownerId, familyDirId, styleDirName);
      const atomicDirName = this.uniqueChildName(styleDirId, draft.sku);
      const resourceId = this.insertDir(input.ownerId, styleDirId, atomicDirName, {});
      // 四步之 blob 面：stone.json + 贴图（put 在事务内——DB 行随事务原子，文件先落）。
      const stoneBytes = Buffer.from(JSON.stringify(stoneFile), 'utf8');
      const stonePut = this.blobs.put(new Uint8Array(stoneBytes));
      this.insertFile(input.ownerId, resourceId, STONE_JSON_NAME, stonePut.hash, stoneBytes.byteLength, {
        kind: 'stone',
      });
      const texturePut = this.blobs.put(input.textureBytes);
      this.insertFile(input.ownerId, resourceId, STONE_TEXTURE_FILE_NAME, texturePut.hash, input.textureBytes.byteLength, {
        kind: 'stone-texture',
      });
      // 投影同事务（§1.5 维护规则）。supplier×sku UNIQUE 兜底（前置查覆盖稳态，
      // 约束覆盖竞态——两者同映射 typed sku-conflict 定位既有条目）。
      try {
        this.upsertIndexRow(resourceId, input.ownerId, stoneFile, false);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const clash = this.db
            .prepare('SELECT resource_id FROM stone_index WHERE supplier = ? AND sku = ?')
            .get(profile.supplier, draft.sku) as { resource_id: string } | undefined;
          throw new StoneServiceError(
            'sku-conflict',
            `supplier×sku 已存在：${profile.supplier}/${draft.sku}（resourceId=${clash?.resource_id ?? '未知'}）`,
            { existingResourceId: clash?.resource_id, supplier: profile.supplier, sku: draft.sku },
          );
        }
        throw error;
      }
      return {
        resourceId,
        stoneId,
        revision: 1,
        path: this.pathOf(resourceId),
        textureBlobRef: texturePut.hash,
        stoneJsonBlobRef: stonePut.hash,
      };
    })();
  }

  private parsedSkuOrNull(profile: SupplierSkuProfile, sku: string): StoneFile['skuParsed'] {
    const result = parseSku(profile, sku);
    return result.ok ? { row: result.row, prefix: result.prefix, sizeMm: result.sizeMm } : undefined;
  }

  // -------------------------------------------------------------- 更新（patch + CAS）

  /**
   * 字段级 patch → stone.json 新 blob → revision+1（CAS：baseRevision 漂移必拒——
   * §1.6/W4.2 §3.6.4 同规）。color.family 变更=色系重指（同事务移目录+改投影）。
   */
  updateStone(resourceId: string, patch: StonePatch, options: { baseRevision: number }): UpdateStoneResult {
    return this.db.transaction(() => {
      const loaded = this.loadStoneDir(resourceId); // not-found/wrong-kind typed 拒
      if (loaded.dirRow.revision !== options.baseRevision) {
        throw new StoneServiceError(
          'revision-conflict',
          `revision 漂移：base=${options.baseRevision} 当前=${loaded.dirRow.revision}（CAS 必拒）`,
          { currentRevision: loaded.dirRow.revision, baseRevision: options.baseRevision },
        );
      }
      const dirRow = loaded.dirRow;
      const stone: StoneFile = { ...loaded.stone };
      if (patch.name !== undefined) stone.name = patch.name;
      if (patch.sizeMm !== undefined) stone.sizeMm = patch.sizeMm;
      if (patch.color !== undefined) {
        if (patch.color.name !== undefined) stone.color = { ...stone.color, name: patch.color.name };
        if (patch.color.rgb !== undefined) stone.color = { ...stone.color, rgb: patch.color.rgb };
        if (patch.color.family !== undefined) stone.color = { ...stone.color, family: patch.color.family };
        if (patch.color.finish !== undefined) stone.color = { ...stone.color, finish: patch.color.finish };
      }
      if (patch.shapeClass !== undefined) {
        if (patch.shapeClass === null) delete stone.shapeClass;
        else stone.shapeClass = patch.shapeClass;
      }
      if (patch.gemshapeRef !== undefined) {
        if (patch.gemshapeRef === null) delete stone.gemshapeRef;
        else stone.gemshapeRef = patch.gemshapeRef;
      }
      if (patch.views !== undefined) stone.views = patch.views;
      if (patch.metadata !== undefined) stone.metadata = { ...stone.metadata, ...patch.metadata };
      // 贴图替换：新字节过六条 gate→新 blob（内容寻址，id 不变）→贴图文件行换绑。
      if (patch.texture !== undefined) {
        const gate = gateStoneTexture({
          bytes: patch.texture.bytes,
          declaredWidth: patch.texture.declaredWidth,
          declaredHeight: patch.texture.declaredHeight,
          shapeClass: stone.shapeClass ?? 'round',
          sizeMm: stone.sizeMm,
        });
        const textureRow = this.childFileOf(resourceId, STONE_TEXTURE_FILE_NAME);
        if (textureRow === null) {
          throw new StoneServiceError('blob-missing', `贴图文件行缺失（无法替换）：${resourceId}`, { resourceId });
        }
        const put = this.blobs.put(patch.texture.bytes);
        if (textureRow.content_hash && textureRow.content_hash !== put.hash) {
          this.blobs.releaseRef(textureRow.content_hash);
        }
        this.db
          .prepare('UPDATE resources SET content_hash = ?, size = ?, updated_at = ? WHERE id = ?')
          .run(put.hash, patch.texture.bytes.byteLength, nowIso(), textureRow.id);
        stone.texture = {
          file: STONE_TEXTURE_FILE_NAME,
          mime: 'image/png',
          width: gate.width,
          height: gate.height,
          alphaBounds: gate.alphaBounds,
        };
      }
      stone.updatedAt = nowIso();
      const next = StoneFileSchema.parse(stone);
      // 色系重指：family 变化→原子目录移至 供应商/新色系/款式行（同事务；引用只认
      // resourceId 不受路径影响——「path 是派生量」纪律）。
      if (patch.color?.family !== undefined && patch.color.family !== loaded.stone.color.family) {
        const supplierDirId = this.supplierAncestorOf(resourceId);
        if (supplierDirId === null) {
          throw new StoneServiceError('wrong-kind', `原子目录缺少供应商祖先：${resourceId}`);
        }
        const familyDirId = this.ensureChildDir(dirRow.owner_id, supplierDirId, next.color.family);
        const styleDirName =
          next.skuParsed !== undefined ? `${next.skuParsed.row}-${next.color.name}` : next.color.name;
        const styleDirId = this.ensureChildDir(dirRow.owner_id, familyDirId, styleDirName);
        if (styleDirId !== dirRow.parent_id) {
          this.db
            .prepare('UPDATE resources SET parent_id = ?, updated_at = ? WHERE id = ?')
            .run(styleDirId, nowIso(), resourceId);
        }
      }
      // stone.json 新 blob→文件行换绑+旧引用释放；revision+1（目录行=CAS 唯一点）。
      const bytes = Buffer.from(JSON.stringify(next), 'utf8');
      const put = this.blobs.put(new Uint8Array(bytes));
      if (loaded.jsonRow.content_hash && loaded.jsonRow.content_hash !== put.hash) {
        this.blobs.releaseRef(loaded.jsonRow.content_hash);
      }
      this.db
        .prepare('UPDATE resources SET content_hash = ?, size = ?, updated_at = ? WHERE id = ?')
        .run(put.hash, bytes.byteLength, nowIso(), loaded.jsonRow.id);
      const revision = dirRow.revision + 1;
      this.db
        .prepare('UPDATE resources SET revision = ?, updated_at = ? WHERE id = ?')
        .run(revision, nowIso(), resourceId);
      this.upsertIndexRow(resourceId, dirRow.owner_id, next, this.effectiveTrashed(resourceId));
      return { resourceId, revision, path: this.pathOf(resourceId) };
    })();
  }

  // -------------------------------------------------------------- 软删/恢复/硬删

  /** 递归软删：子树全行盖 meta.trashedAt（同一时间戳）+ 投影 trashed=1（级联原子可见性）。 */
  softDelete(resourceId: string): { trashedRows: number; trashedStones: number } {
    return this.db.transaction(() => {
      const row = this.requireRow(resourceId);
      const role = parseMeta(row.meta).role;
      if (role !== undefined && PROTECTED_ROLES.has(role)) {
        throw new StoneServiceError('system-dir-protected', `系统目录禁删（role=${role}）：${this.pathOf(resourceId)}`, {
          role,
        });
      }
      const ids = this.subtreeIds(resourceId);
      const stamp = nowIso();
      const update = this.db.prepare(
        'UPDATE resources SET meta = ?, updated_at = ? WHERE id = ?',
      );
      for (const id of ids) {
        const target = this.requireRow(id);
        update.run(JSON.stringify({ ...parseMeta(target.meta), trashedAt: stamp }), stamp, id);
      }
      let trashedStones = 0;
      // updated_at 不动：投影列=stone.json updatedAt 的纯冗余（重建逐行等价的前提）；
      // 软删时刻的审计时间戳在 resources.meta.trashedAt。
      const updateIndex = this.db.prepare('UPDATE stone_index SET trashed = 1 WHERE resource_id = ?');
      for (const id of ids) {
        if (this.childFileOf(id, STONE_JSON_NAME) !== null) {
          updateIndex.run(id);
          trashedStones += 1;
        }
      }
      return { trashedRows: ids.length, trashedStones };
    })();
  }

  /** 恢复：清子树戳+按「任一祖先或自身盖戳」重算投影 trashed（部分恢复的级联语义）。 */
  restore(resourceId: string): { restoredRows: number; restoredStones: number } {
    return this.db.transaction(() => {
      this.requireRow(resourceId);
      const ids = this.subtreeIds(resourceId);
      const stamp = nowIso();
      const update = this.db.prepare('UPDATE resources SET meta = ?, updated_at = ? WHERE id = ?');
      for (const id of ids) {
        const target = this.requireRow(id);
        const meta = parseMeta(target.meta);
        delete meta.trashedAt;
        update.run(JSON.stringify(meta), stamp, id);
      }
      let restoredStones = 0;
      const updateIndex = this.db.prepare('UPDATE stone_index SET trashed = ? WHERE resource_id = ?');
      for (const id of ids) {
        if (this.childFileOf(id, STONE_JSON_NAME) !== null) {
          updateIndex.run(this.effectiveTrashed(id) ? 1 : 0, id);
          restoredStones += 1;
        }
      }
      return { restoredRows: ids.length, restoredStones };
    })();
  }

  /**
   * 硬删（清空回收站语义）：仅对已软删子树开放；递归删资源行+释放全部 blob 引用
   * （ref_count 归零→deleting——物理删走既有 outbox 纪律）；投影行同事务清除。
   */
  hardDelete(resourceId: string): { deletedRows: number; releasedBlobRefs: string[] } {
    return this.db.transaction(() => {
      const row = this.requireRow(resourceId);
      const role = parseMeta(row.meta).role;
      if (role !== undefined && PROTECTED_ROLES.has(role)) {
        throw new StoneServiceError('system-dir-protected', `系统目录禁删（role=${role}）`, { role });
      }
      if (parseMeta(row.meta).trashedAt === undefined) {
        throw new StoneServiceError('not-trashed', `硬删仅作用于回收站内子树（先 softDelete）：${resourceId}`, {
          resourceId,
        });
      }
      const ids = this.subtreeIds(resourceId);
      // 投影先行（FK：stone_index.resource_id 引用 resources）。
      this.db
        .prepare(`DELETE FROM stone_index WHERE resource_id IN (${ids.map(() => '?').join(',')})`)
        .run(...ids);
      // 叶先删（子行引用父行——resources 无 FK 自引，但树语义要求叶先）。
      const byDepthDesc = ids
        .map((id) => ({ id, depth: this.depthOf(id) }))
        .sort((a, b) => b.depth - a.depth);
      const releasedBlobRefs: string[] = [];
      for (const { id } of byDepthDesc) {
        const target = this.requireRow(id);
        if (target.content_hash !== null) {
          this.blobs.releaseRef(target.content_hash);
          releasedBlobRefs.push(target.content_hash);
        }
        this.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
      }
      return { deletedRows: ids.length, releasedBlobRefs };
    })();
  }

  // -------------------------------------------------------------- 引用解析（四态）

  /** 弱引用解析：resolved/soft-deleted/blob-missing/wrong-kind（+not-found=硬清后形态）。 */
  resolveStoneRef(resourceId: string): StoneRefResolution {
    const row = this.rowOf(resourceId);
    if (row === null) return { resourceId, state: 'not-found' };
    const located = this.locateStoneDir(resourceId);
    if (located === null) return { resourceId, state: 'wrong-kind' };
    if (this.effectiveTrashed(resourceId)) return { resourceId, state: 'soft-deleted' };
    const jsonBytes = this.blobs.read(located.jsonRow.content_hash ?? '');
    if (jsonBytes === null) return { resourceId, state: 'blob-missing' };
    const textureRow = this.childFileOf(resourceId, STONE_TEXTURE_FILE_NAME);
    if (textureRow === null || textureRow.content_hash === null || this.blobs.read(textureRow.content_hash) === null) {
      return { resourceId, state: 'blob-missing' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBytes.toString('utf8'));
    } catch {
      return { resourceId, state: 'wrong-kind' };
    }
    const result = StoneFileSchema.safeParse(parsed);
    if (!result.success) return { resourceId, state: 'wrong-kind' };
    return { resourceId, state: 'resolved', stone: result.data, revision: located.dirRow.revision };
  }

  /** 单钻详情（not-found/wrong-kind/blob-missing typed 拒；软删态可读——回收站详情）。 */
  getStone(resourceId: string): GetStoneResult {
    const loaded = this.loadStoneDir(resourceId);
    const bytes = this.blobs.read(loaded.jsonRow.content_hash ?? '');
    if (bytes === null) {
      throw new StoneServiceError('blob-missing', `stone.json 内容不可读：${resourceId}`, { resourceId });
    }
    const textureRow = this.childFileOf(resourceId, STONE_TEXTURE_FILE_NAME);
    if (textureRow === null || textureRow.content_hash === null) {
      throw new StoneServiceError('blob-missing', `贴图文件行缺失：${resourceId}`, { resourceId });
    }
    return {
      resourceId,
      revision: loaded.dirRow.revision,
      path: this.pathOf(resourceId),
      trashed: this.effectiveTrashed(resourceId),
      stone: loaded.stone,
      texture: { blobRef: textureRow.content_hash, width: loaded.stone.texture.width, height: loaded.stone.texture.height },
    };
  }

  // -------------------------------------------------------------- 投影维护/重建

  /** stone_index 行视图（测试/运维面）。 */
  indexRowOf(resourceId: string): StoneIndexRow | null {
    return (
      (this.db.prepare('SELECT * FROM stone_index WHERE resource_id = ?').get(resourceId) as StoneIndexRow | undefined) ??
      null
    );
  }

  listIndexRows(): StoneIndexRow[] {
    return this.db.prepare('SELECT * FROM stone_index ORDER BY supplier, sku').all() as StoneIndexRow[];
  }

  /**
   * 全量重建（resources+blob→stone_index；§1.1「不构成第二真源」的证明面）：
   * 清空后逐原子目录回填。真源不可读行（json blob 缺失/schema 不过）跳过并计数
   * ——重建不放大损坏（损坏行显式暴露给调用方）。
   */
  rebuildStoneIndex(): { rebuilt: number; skipped: number } {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM stone_index').run();
      const dirs = this.db
        .prepare('SELECT id, owner_id FROM resources WHERE is_dir = 1')
        .all() as { id: string; owner_id: string }[];
      let rebuilt = 0;
      let skipped = 0;
      for (const dir of dirs) {
        const located = this.locateStoneDir(dir.id);
        if (located === null) continue; // 非原子目录（无 stone.json 子行）
        const bytes = this.blobs.read(located.jsonRow.content_hash ?? '');
        if (bytes === null) {
          skipped += 1;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString('utf8'));
        } catch {
          skipped += 1;
          continue;
        }
        const result = StoneFileSchema.safeParse(parsed);
        if (!result.success) {
          skipped += 1;
          continue;
        }
        this.upsertIndexRow(dir.id, dir.owner_id, result.data, this.effectiveTrashed(dir.id));
        rebuilt += 1;
      }
      return { rebuilt, skipped };
    })();
  }

  /** 投影行写入（create/update/rebuild 共用——列值唯一来源）。 */
  private upsertIndexRow(resourceId: string, ownerId: string, stone: StoneFile, trashed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO stone_index (resource_id, owner_id, supplier, sku, style_row, style_name, family, size_mm, color_hex, finish, trashed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resource_id) DO UPDATE SET
           owner_id = excluded.owner_id, supplier = excluded.supplier, sku = excluded.sku,
           style_row = excluded.style_row, style_name = excluded.style_name, family = excluded.family,
           size_mm = excluded.size_mm, color_hex = excluded.color_hex, finish = excluded.finish,
           trashed = excluded.trashed, updated_at = excluded.updated_at`,
      )
      .run(
        resourceId,
        ownerId,
        stone.supplier,
        stone.sku,
        stone.skuParsed?.row ?? null,
        stone.color.name,
        stone.color.family,
        stone.sizeMm,
        rgbToHex(stone.color.rgb),
        stone.color.finish,
        trashed ? 1 : 0,
        stone.updatedAt,
      );
  }

  // -------------------------------------------------------------- 内部工具

  private rowOf(id: string): ResourceRow | null {
    return (this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as ResourceRow | undefined) ?? null;
  }

  private requireRow(id: string): ResourceRow {
    const row = this.rowOf(id);
    if (row === null) throw new StoneServiceError('not-found', `资源不存在：${id}`, { resourceId: id });
    return row;
  }

  /** 原子目录装载（dir + stone.json 子行 + blob 解析）——not-found/wrong-kind/blob-missing typed 拒。 */
  private loadStoneDir(resourceId: string): { dirRow: ResourceRow; jsonRow: ResourceRow; stone: StoneFile } {
    const located = this.locateStoneDir(resourceId);
    if (located === null) {
      const row = this.rowOf(resourceId);
      if (row === null) {
        throw new StoneServiceError('not-found', `资源不存在：${resourceId}`, { resourceId });
      }
      throw new StoneServiceError('wrong-kind', `资源不是钻原子目录（name=${row.name}）：${resourceId}`, {
        resourceId,
      });
    }
    const bytes = this.blobs.read(located.jsonRow.content_hash ?? '');
    if (bytes === null) {
      throw new StoneServiceError('blob-missing', `stone.json 内容不可读：${resourceId}`, { resourceId });
    }
    const result = StoneFileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!result.success) {
      throw new StoneServiceError('schema', `stone.json 不符契约：${resourceId}`, { resourceId });
    }
    return { dirRow: located.dirRow, jsonRow: located.jsonRow, stone: result.data };
  }

  /** 定位原子目录（dir 行 + stone.json 文件行；不含 blob/解析——解析态归调用方）。 */
  private locateStoneDir(resourceId: string): { dirRow: ResourceRow; jsonRow: ResourceRow } | null {
    const dirRow = this.rowOf(resourceId);
    if (dirRow === null || dirRow.is_dir !== 1) return null;
    const jsonRow = this.childFileOf(resourceId, STONE_JSON_NAME);
    if (jsonRow === null) return null;
    return { dirRow, jsonRow };
  }

  private childDirOf(parentId: string, name: string): ResourceRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 1')
        .get(parentId, name) as ResourceRow | undefined) ?? null
    );
  }

  private childFileOf(parentId: string, name: string): ResourceRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 0')
        .get(parentId, name) as ResourceRow | undefined) ?? null
    );
  }

  /** 已存在同名子目录→复用（色系/款式行幂等）；否则新建（同名文件占位→唯一名后缀）。 */
  private ensureChildDir(ownerId: string, parentId: string, name: string, meta: ResourceMeta = {}): string {
    const existing = this.childDirOf(parentId, name);
    if (existing) return existing.id;
    const unique = this.uniqueChildName(parentId, name);
    return this.insertDir(ownerId, parentId, unique, meta);
  }

  /** 同父名冲突自动 ` (2)`（§1.6——查全部兄弟行，含软删：树内名字唯一是物理语义）。 */
  private uniqueChildName(parentId: string, base: string): string {
    // better-sqlite3 纪律：.get() 无行返回 undefined（非 null）——判空必须对 undefined。
    const exists = (name: string): boolean =>
      this.db.prepare('SELECT 1 FROM resources WHERE parent_id = ? AND name = ?').get(parentId, name) !== undefined;
    if (!exists(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!exists(candidate)) return candidate;
    }
  }

  private insertDir(ownerId: string, parentId: string | null, name: string, meta: ResourceMeta): string {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, 0, ?, 1, ?, ?)',
      )
      .run(id, ownerId, parentId, name, Object.keys(meta).length > 0 ? JSON.stringify(meta) : null, now, now);
    return id;
  }

  private insertFile(
    ownerId: string,
    parentId: string,
    name: string,
    contentHash: string,
    size: number,
    meta: ResourceMeta,
  ): string {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)',
      )
      .run(id, ownerId, parentId, name, contentHash, size, JSON.stringify(meta), now, now);
    return id;
  }

  /** 子树 id 集（含根——递归 CTE）。 */
  private subtreeIds(rootId: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? UNION ALL SELECT r.id FROM resources r JOIN sub ON r.parent_id = sub.id
         ) SELECT id FROM sub`,
      )
      .all(rootId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** 任一祖先或自身盖戳=不可见（级联原子可见性——§1.6 软删约束）。 */
  private effectiveTrashed(id: string): boolean {
    let current = this.rowOf(id);
    while (current !== null) {
      if (parseMeta(current.meta).trashedAt !== undefined) return true;
      current = current.parent_id === null ? null : this.rowOf(current.parent_id);
    }
    return false;
  }

  private depthOf(id: string): number {
    let depth = 0;
    let current = this.rowOf(id);
    while (current !== null && current.parent_id !== null) {
      depth += 1;
      current = this.rowOf(current.parent_id);
    }
    return depth;
  }

  /** 向上找 meta.role='supplier' 祖先（色系重指的落点父链）。 */
  private supplierAncestorOf(id: string): string | null {
    let current = this.rowOf(id);
    while (current !== null) {
      if (parseMeta(current.meta).role === 'supplier') return current.id;
      current = current.parent_id === null ? null : this.rowOf(current.parent_id);
    }
    return null;
  }

  /** path 派生量（不存储——沿 IDB 素材库不变量；引用只认 resourceId）。 */
  pathOf(resourceId: string): string {
    const names: string[] = [];
    let current = this.rowOf(resourceId);
    while (current !== null) {
      names.unshift(current.name);
      current = current.parent_id === null ? null : this.rowOf(current.parent_id);
    }
    return `/${names.join('/')}`;
  }
}

/** stone_index 行形状（v5 投影——service 测试/后续 list 面消费）。 */
export interface StoneIndexRow {
  resource_id: string;
  owner_id: string;
  supplier: string;
  sku: string;
  style_row: number | null;
  style_name: string | null;
  family: string;
  size_mm: number | null;
  color_hex: string;
  finish: string | null;
  trashed: number;
  updated_at: string;
}

/** SKU 唯一约束兜底映射（better-sqlite3 UNIQUE → typed error）。 */
function isUniqueConstraintError(error: unknown): error is Database.SqliteError {
  return error instanceof Database.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}
