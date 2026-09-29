/**
 * 素材库服务化契约（split-admin-portal 4.3——资源后台化：素材真源从浏览器
 * IndexedDB 迁往 daemon 服务端，2026-09-29）。
 * 设计约束（design §5 素材库行 + 简报裁定）：
 *   - 服务端素材=独立 asset_library 表（owner 隔离虚拟文件系统——目录/图片两态；
 *     内容字节入既有 blobs 内容寻址去重，行只存 blob_hash 引用）。
 *   - 守卫语义：本人资源 requireAuth（读面）/写面登录态；admin 全见+可管理
 *     （跨用户 FORBIDDEN——与 sets/stones 写面同族）。
 *   - 迁移红线：IDB→服务端迁移**可重试**（确定性 id 幂等 upsert）+**核验**
 *     （migrateVerify 清单 hash 汇总比对）；核验通过前不删浏览器原数据。
 * 正交意图：
 *   [1] 节点视图与树读面（AssetsLibNode/tree——flat 清单，客户端组树）。
 *   [2] 管理写面（uploadImage/move/rename/softDelete/restore/purgeEmptyTrash）。
 *   [3] IDB 迁移面（migrateBatch 确定性 id 批量上行+migrateVerify 清单核对）+
 *       清单 payload 纯函数（两端同源 sha256 输入格式）。
 */
import { z } from 'zod';
import { BlobRefSchema, IdSchema, IsoDateTimeSchema } from './common.js';

/** 素材名（目录/文件同规）：非空、去首尾空白、≤255 字符（文件系统习惯界）。 */
const AssetNameSchema = z.string().trim().min(1).max(255);

// ---------------------------------------------------------------- [1] 节点视图与树

/**
 * 服务端素材节点行视图（asset_library 表投影；owner=username 便于后台管理面
 * 显示归属——id 在服务端全局唯一，不泄露 users.id）。
 */
export const AssetsLibNodeSchema = z.object({
  id: IdSchema,
  owner: z.string().min(1),
  parentId: IdSchema.nullable(),
  name: z.string().min(1),
  isDir: z.boolean(),
  /** 图片节点的魔数嗅探 MIME（png/jpeg/webp）；目录=null。 */
  mime: z.string().nullable(),
  /** 客户端申报的像素宽高（解码实测值；未申报=null）。 */
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  /** 内容寻址引用（is_dir=false 时非空）；目录=null。 */
  blobHash: BlobRefSchema.nullable(),
  bytes: z.number().int().nonnegative(),
  softDeleted: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AssetsLibNode = z.infer<typeof AssetsLibNodeSchema>;

export const AssetsLibTreeInputSchema = z
  .object({
    /** admin 显式查指定用户（username）/缺省=全量（后台集中管理面）；普通用户恒=自己（传他人 FORBIDDEN）。 */
    owner: z.string().min(1).optional(),
    includeTrashed: z.boolean().default(false),
  })
  .strict();
export type AssetsLibTreeInput = z.infer<typeof AssetsLibTreeInputSchema>;

/** flat 节点清单（客户端按 parentId 组树——素材库规模远小于服务端分页需求）。 */
export const AssetsLibTreeOutputSchema = z.object({
  nodes: z.array(AssetsLibNodeSchema),
});
export type AssetsLibTreeOutput = z.infer<typeof AssetsLibTreeOutputSchema>;

// ---------------------------------------------------------------- [2] 管理写面

/** 图片上传入参（base64 字节面——服务端魔数嗅探定 MIME，不信申报）。 */
export const AssetsLibUploadImageInputSchema = z
  .object({
    parentId: IdSchema.nullable(),
    name: AssetNameSchema,
    dataBase64: z.string().min(1),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AssetsLibUploadImageInput = z.infer<typeof AssetsLibUploadImageInputSchema>;
export const AssetsLibUploadImageOutputSchema = AssetsLibNodeSchema;
export type AssetsLibUploadImageOutput = AssetsLibNode;

export const AssetsLibMoveInputSchema = z
  .object({
    id: IdSchema,
    newParentId: IdSchema.nullable(),
  })
  .strict();
export type AssetsLibMoveInput = z.infer<typeof AssetsLibMoveInputSchema>;
export const AssetsLibMoveOutputSchema = AssetsLibNodeSchema;
export type AssetsLibMoveOutput = AssetsLibNode;

export const AssetsLibRenameInputSchema = z
  .object({
    id: IdSchema,
    name: AssetNameSchema,
  })
  .strict();
export type AssetsLibRenameInput = z.infer<typeof AssetsLibRenameInputSchema>;
export const AssetsLibRenameOutputSchema = AssetsLibNodeSchema;
export type AssetsLibRenameOutput = AssetsLibNode;

export const AssetsLibSoftDeleteInputSchema = z
  .object({ id: IdSchema })
  .strict();
export type AssetsLibSoftDeleteInput = z.infer<typeof AssetsLibSoftDeleteInputSchema>;
/** 软删=回收站语义（目录递归盖戳——子树整树 soft_deleted，restore 可恢复）。 */
export const AssetsLibSoftDeleteOutputSchema = z.object({
  id: IdSchema,
  softDeletedRows: z.number().int().nonnegative(),
});
export type AssetsLibSoftDeleteOutput = z.infer<typeof AssetsLibSoftDeleteOutputSchema>;

export const AssetsLibRestoreInputSchema = z
  .object({ id: IdSchema })
  .strict();
export type AssetsLibRestoreInput = z.infer<typeof AssetsLibRestoreInputSchema>;
/** 恢复=清子树戳（祖先仍盖戳时 typed 拒——先恢复祖先，语义与 stones.restore 同族）。 */
export const AssetsLibRestoreOutputSchema = z.object({
  id: IdSchema,
  restoredRows: z.number().int().nonnegative(),
});
export type AssetsLibRestoreOutput = z.infer<typeof AssetsLibRestoreOutputSchema>;

export const AssetsLibPurgeEmptyTrashInputSchema = z.object({}).strict();
export type AssetsLibPurgeEmptyTrashInput = z.infer<typeof AssetsLibPurgeEmptyTrashInputSchema>;
/** 清空回收站=硬删本人（或 admin 指定 owner——4.3 首版按调用者本人域）软删子树。 */
export const AssetsLibPurgeEmptyTrashOutputSchema = z.object({
  purgedNodeIds: z.array(IdSchema),
  releasedBlobHashes: z.array(BlobRefSchema),
});
export type AssetsLibPurgeEmptyTrashOutput = z.infer<typeof AssetsLibPurgeEmptyTrashOutputSchema>;

// ---------------------------------------------------------------- [3] IDB 迁移面

/** 迁移目录项（确定性 id：服务端按 (ownerId, clientId) 派生——重试幂等）。 */
export const AssetsLibMigrateDirItemSchema = z
  .object({
    clientId: IdSchema,
    name: AssetNameSchema,
    parentClientId: IdSchema.nullable(),
    isDir: z.literal(true),
  })
  .strict();
export type AssetsLibMigrateDirItem = z.infer<typeof AssetsLibMigrateDirItemSchema>;

/** 迁移图片项（内容字节随行——服务端嗅探+内容寻址去重）。 */
export const AssetsLibMigrateImageItemSchema = z
  .object({
    clientId: IdSchema,
    name: AssetNameSchema,
    parentClientId: IdSchema.nullable(),
    isDir: z.literal(false),
    dataBase64: z.string().min(1),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AssetsLibMigrateImageItem = z.infer<typeof AssetsLibMigrateImageItemSchema>;

export const AssetsLibMigrateItemSchema = z.discriminatedUnion('isDir', [
  AssetsLibMigrateDirItemSchema,
  AssetsLibMigrateImageItemSchema,
]);
export type AssetsLibMigrateItem = z.infer<typeof AssetsLibMigrateItemSchema>;

/** 单批上限（载荷有界——客户端分批上行：目录树先行+内容后行）。 */
export const ASSETS_LIB_MIGRATE_BATCH_LIMIT = 64;

export const AssetsLibMigrateBatchInputSchema = z
  .object({
    items: z.array(AssetsLibMigrateItemSchema).min(1).max(ASSETS_LIB_MIGRATE_BATCH_LIMIT),
  })
  .strict();
export type AssetsLibMigrateBatchInput = z.infer<typeof AssetsLibMigrateBatchInputSchema>;

export const AssetsLibMigrateResultSchema = z.object({
  clientId: IdSchema,
  /** created=本批新建；existing=确定性 id 已在场（重试幂等跳过——内容不重写）。 */
  status: z.enum(['created', 'existing']),
  id: IdSchema,
});
export type AssetsLibMigrateResult = z.infer<typeof AssetsLibMigrateResultSchema>;

export const AssetsLibMigrateBatchOutputSchema = z.object({
  results: z.array(AssetsLibMigrateResultSchema),
});
export type AssetsLibMigrateBatchOutput = z.infer<typeof AssetsLibMigrateBatchOutputSchema>;

/**
 * 清单 payload（两端同源纯函数）：去重后的图片内容清单（hash 去重——同内容
 * 多节点计一次）按 hash 字典序展开为 `<hash>:<bytes>\n` 行——migrateVerify 的
 * 申报值与服务端汇总值都用本格式做 sha256 输入（浏览器 crypto.subtle / node
 * crypto 各自摘要，格式单源在此）。
 */
export function assetsLibManifestPayload(items: ReadonlyArray<{ blobHash: string; bytes: number }>): string {
  const unique = new Map<string, number>();
  for (const item of items) {
    const prev = unique.get(item.blobHash);
    unique.set(item.blobHash, prev === undefined ? item.bytes : Math.max(prev, item.bytes));
  }
  return [...unique.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hash, bytes]) => `${hash}:${bytes}\n`)
    .join('');
}

/** 申报清单（前端对本地 IDB 图片内容的汇总）。 */
export const AssetsLibMigrateVerifyInputSchema = z
  .object({
    declaredCount: z.number().int().nonnegative(),
    declaredBytes: z.number().int().nonnegative(),
    /** sha256(assetsLibManifestPayload(本地内容清单))——hex 小写。 */
    declaredDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type AssetsLibMigrateVerifyInput = z.infer<typeof AssetsLibMigrateVerifyInputSchema>;

export const AssetsLibMigrateVerifyOutputSchema = z.object({
  match: z.boolean(),
  serverCount: z.number().int().nonnegative(),
  serverBytes: z.number().int().nonnegative(),
  serverDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** 服务端图片节点清单（id/name/blobHash/bytes——客户端比对求不符清单用）。 */
  serverNodes: z.array(
    z.object({
      id: IdSchema,
      name: z.string().min(1),
      blobHash: BlobRefSchema,
      bytes: z.number().int().nonnegative(),
    }),
  ),
});
export type AssetsLibMigrateVerifyOutput = z.infer<typeof AssetsLibMigrateVerifyOutputSchema>;
