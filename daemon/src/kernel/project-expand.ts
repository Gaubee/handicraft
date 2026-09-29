/**
 * 集合展开快照（add-task-stones-manifest-export 1.1——arch-decisions A2 复制/展开
 * 边界裁定的物化面）。
 * 原始语义（Owner 2026-09-29）：任务开始时选集合=**复制/展开关系非引用**——选择
 * 瞬间逐成员解析 stone_index 物化 StonePick+冻结原子 revision/源 blob 引用；集合
 * 此后增删改不影响项目字节（不随弱引用漂移——sets.ts 读时解析语义在此切断）。
 * 纪律（A2）：
 *   - 成员解析不到/软删/物料 blob 缺失/必要物料字段缺 → typed 拒并携带具体
 *     stoneRef 清单（不把半解析成员写成「可用钻」，不留半成品 task 行——配合
 *     kernel followup「先校验后建行」顺序，拒=零行残留）。
 *   - 首波单集合（A2 偏差 1）：不引入多来源合并歧义；stoneRef 唯一由 set 侧
 *     聚合不变量保证（sets-service assertMembersValid）。
 *   - quantity 沿集合「备料参考」语义（A2 偏差 3——非库存锁定/非策略约束）。
 * 冻结裁量（W1 落地）：
 *   - [shapeAssetBlobRef 恒 null·缺场合理缺省] daemon stone 域现有 blobRef 面=
 *     stone.json+贴图两文件行（texture 已有、stoneJson 经 stoneSourceBlobRefsOf
 *     补齐）；.gemshape 资产无 daemon 全局寻址面（资产在前端素材库/任务入参——
 *     PaveJobParams.shapeAssets 形态），故首波不可冻结、恒 null。custom 形 gem
 *     的 assetBlob 硬约束（B2：custom 必带 assetId+shapeAssets blob）由 W4
 *     task-layout 生成器在任务入参面落地，不在此放宽。
 *   - [quantity 缺省物化 0]（W1 契约裁定修正 2026-09-29：nonnegative——与 sets
 *     「缺省=按设计用量另计」语义对齐，缺 quantity 成员物化 0 而非拒任务创建）。
 */
import {
  rgbToHex,
  type StonesManifestEntry,
  type StonesManifestSourceSet,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { StoneService } from '../stones/service.js';
import { SetService, type GetSetResult, type SetMemberResolution } from '../stones/sets-service.js';

// ---------------------------------------------------------------- typed errors

export type ProjectExpandErrorKind =
  | 'set-not-found'
  | 'set-forbidden'
  | 'set-soft-deleted'
  | 'set-unreadable'
  | 'invalid-members';

/** 无效成员明细（typed 拒携带的具体 stoneRef 清单——A2「指出具体 stoneRef」）。 */
export interface InvalidMemberDetail {
  stoneRef: string;
  reason: string;
}

export class ProjectExpandError extends Error {
  readonly kind: ProjectExpandErrorKind;
  readonly detail: Record<string, unknown>;

  constructor(kind: ProjectExpandErrorKind, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProjectExpandError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface ProjectExpandDeps {
  db: SqliteDb;
  blobs: BlobStore;
}

/** 展开产物（writeManifest 的 ManifestContent 直接形态——revision/身份字段归 service 单源）。 */
export interface SetExpansion {
  sourceSet: StonesManifestSourceSet;
  entries: StonesManifestEntry[];
}

/** 集合成员解析态 → 无效原因文案（A2 四态对齐 resolveStoneRef 词汇）。 */
function invalidReasonOf(state: SetMemberResolution['state']): string {
  switch (state) {
    case 'not-found':
      return '库内不存在（stoneRef 解析不到）';
    case 'soft-deleted':
      return '已软删（回收站内——先恢复再选集合）';
    case 'blob-missing':
      return '物料 blob 缺失（stone.json/贴图不可读）';
    default:
      return '不是钻原子目录（wrong-kind）';
  }
}

/** 加载集合（owner/状态/可读性栅栏——纯读，建 task 行之前调用）。 */
function loadOwnedSet(sets: SetService, db: SqliteDb, ownerId: string, sourceSetId: string): GetSetResult {
  // owner 隔离按 sets 现状（评审 D-1：组合=owner 私有生产工件，读写均按 owner——
  // 无共享、无 admin 豁免；capability/sets.ts ownedResourceOf 同语义）。
  const row = db.prepare('SELECT owner_id FROM resources WHERE id = ?').get(sourceSetId) as
    | { owner_id: string }
    | undefined;
  if (row === undefined) {
    throw new ProjectExpandError('set-not-found', `集合不存在：${sourceSetId}`, { sourceSetId });
  }
  if (row.owner_id !== ownerId) {
    throw new ProjectExpandError('set-forbidden', '集合不属于当前用户（组合按 owner 隔离——跨用户必拒）', {
      sourceSetId,
    });
  }
  let result: GetSetResult;
  try {
    result = sets.getSet(sourceSetId);
  } catch (error) {
    // SetServiceError code 映射（not-found/wrong-kind→不存在；blob-missing/schema→不可读）。
    const code = (error as { code?: unknown }).code;
    if (code === 'not-found' || code === 'wrong-kind') {
      throw new ProjectExpandError('set-not-found', `集合不存在（或不是生产组合目录）：${sourceSetId}`, {
        sourceSetId,
        cause: error,
      });
    }
    throw new ProjectExpandError(
      'set-unreadable',
      `集合内容不可读（set.json 缺失/损坏）：${error instanceof Error ? error.message : String(error)}`,
      { sourceSetId, cause: error },
    );
  }
  if (result.trashed) {
    throw new ProjectExpandError('set-soft-deleted', `集合在回收站内（先恢复再选）：${sourceSetId}`, { sourceSetId });
  }
  return result;
}

/**
 * 集合展开（A2）：逐成员物化 StonePick+冻结 stoneRevision/stoneJsonBlobRef/
 * textureBlobRef（shapeAssetBlobRef 恒 null——文件头冻结裁量）；任一成员无效=
 * typed 拒（错误码+具体 stoneRef 清单），不产半成品内容。
 */
export function expandSourceSet(
  deps: ProjectExpandDeps,
  ownerId: string,
  sourceSetId: string,
): SetExpansion {
  const stones = new StoneService({ db: deps.db, blobs: deps.blobs });
  const sets = new SetService({ db: deps.db, blobs: deps.blobs, stones });
  const result = loadOwnedSet(sets, deps.db, ownerId, sourceSetId);
  const invalid: InvalidMemberDetail[] = [];
  const entries: StonesManifestEntry[] = [];
  // getSet.members 与 set.stones 同序一一对应（resolveMembers 逐成员映射）。
  result.set.stones.forEach((member, index) => {
    const resolution = result.members[index]!;
    if (resolution.state !== 'resolved' || resolution.stone === undefined || resolution.revision === undefined) {
      invalid.push({ stoneRef: member.stoneRef, reason: invalidReasonOf(resolution.state) });
      return;
    }
    const stone = resolution.stone;
    const refs = stones.stoneSourceBlobRefsOf(member.stoneRef);
    if (refs.stoneJsonBlobRef === null || refs.textureBlobRef === null) {
      invalid.push({ stoneRef: member.stoneRef, reason: '物料 blob 缺失（stone.json/贴图文件行缺席）' });
      return;
    }
    // W1 契约裁定修正（2026-09-29）：quantity nonnegative（0=未设置备料参考）——与
    // sets「缺省=按设计用量另计」语义对齐：缺 quantity 成员物化 0 而非拒任务创建。
    const quantity = member.quantity ?? 0;
    entries.push({
      stoneRef: member.stoneRef,
      pick: {
        resourceId: member.stoneRef,
        sku: stone.sku,
        supplier: stone.supplier,
        sizeMm: stone.sizeMm,
        colorHex: rgbToHex(stone.color.rgb),
        ...(stone.gemshapeRef !== undefined ? { gemshapeRef: stone.gemshapeRef } : {}),
      },
      stoneRevision: resolution.revision,
      stoneJsonBlobRef: refs.stoneJsonBlobRef,
      textureBlobRef: refs.textureBlobRef,
      // 缺场合理缺省（文件头冻结裁量）——daemon 无 .gemshape 全局资产面。
      shapeAssetBlobRef: null,
      quantity,
      ...(member.note !== undefined ? { note: member.note } : {}),
      origin: 'set',
    });
  });
  if (invalid.length > 0) {
    throw new ProjectExpandError(
      'invalid-members',
      `集合成员无效（${invalid.length} 条——首条任务创建拒绝，不把半解析成员写成可用钻）：${invalid
        .map((item) => `${item.stoneRef}（${item.reason}）`)
        .join('；')}`,
      { sourceSetId, members: invalid },
    );
  }
  return {
    sourceSet: {
      resourceId: sourceSetId,
      setId: result.setId,
      setRevision: result.revision,
      name: result.set.name,
    },
    entries,
  };
}
