/**
 * 生产组合服务（add-stone-library design §7.2/§7.3/§7.4——S7.2）。
 * 原始需求 2026-09-24（Owner 补充定调四）：组合=把标准的部分钻/全部钻集合起来
 * 用于生产的**生产工件**。落位=resources 树上的目录行+set.json 文件行
 * （§1.1 同表承载；production-sets/ 根 meta.role='production-sets-root'，
 * 与 standards/ 平级双根——§7.3 裁决）。
 * 读时解析（§7.1 引用集不变量的服务面兑现）：
 *   成员只存 stoneRef——标准库改贴图/颜色/尺寸，组合 getSet 读时经
 *   StoneService.resolveStoneRef 重新解析自动跟随（零同步机制）；成员缺失=显式
 *   missing 态（四态+not-found）**不自动剔除**；限定名 standardId/qualifiedSku
 *   是解析投影（resolved 用 stone.json 真值；soft-deleted/blob-missing 退
 *   stone_index 投影行；行亡=缺席），不落存储。
 * 不建投影表（§7.2 裁决）：组合数量级远小于钻原子，成员查询/名称筛选走
 * resources+set.json 读时解析——规模化后再投影（§12 开放问题）。
 * 正交意图：
 *   [1] production-sets/ 根 seed（幂等——照 S1 ensureSystemDir 全局 role 标记）。
 *   [2] set.json CRUD：目录行+文件行+blob 同事务建（照 S1 四步形状）/ 成员增删
 *       改名数量 patch（revision CAS，目录行=唯一 CAS 点）/ 同父名冲突 ` (2)` /
 *       成员 stoneRef 唯一（聚合形态——BOM 反推的前置不变量）。
 *   [3] 软删同 §1.6 语义（递归盖戳+级联可见性；production-sets-root 禁删）。
 *   [4] 三来源创建（§7.4）：manual-pick 直发 / clone 浅拷贝母组合成员（仍指标准
 *       原子，不拷贝 stone 数据）/ bom-derived=接口位冻结（S7.6：内核 P3 落地前
 *       typed 'bom-source-not-implemented' 拒——不实现执行链）。
 */
import { randomUUID } from 'node:crypto';
import {
  ProductionSetFileSchema,
  qualifiedSku,
  type ProductionSetFile,
  type ProductionSetMember,
  type ProductionSetOrigin,
  type StoneFile,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { nowIso } from '../db/store.js';
import { StoneService, type StoneRefResolution } from './service.js';

// ---------------------------------------------------------------- typed errors

export type SetServiceErrorCode =
  | 'not-found'
  | 'wrong-kind'
  | 'owner-mismatch'
  | 'revision-conflict'
  | 'empty-members'
  | 'duplicate-member'
  | 'invalid-origin'
  | 'system-dir-protected'
  | 'soft-deleted'
  | 'blob-missing'
  | 'schema'
  /** 递归 CTE 深度超限（评审 P2-5 环防御——写路径不可达，唯直改 DB 造环触发）。 */
  | 'depth-limit'
  /** S7.6 接口位冻结：bom-derived 来源依赖内核 change（P3 排钻产物 stone 溯源）——落地前显式拒。 */
  | 'bom-source-not-implemented';

export class SetServiceError extends Error {
  readonly code: SetServiceErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: SetServiceErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SetServiceError';
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

/** resources.meta JSON 形状（与 S1 service.ts 同族——set 面只用 kind/trashedAt）。 */
interface ResourceMeta {
  role?: 'production-sets-root';
  kind?: 'stone-set';
  trashedAt?: string;
}

const SETS_ROOT_ROLE: ResourceMeta['role'] = 'production-sets-root';
const SETS_ROOT_NAME = 'production-sets';
const SET_JSON_NAME = 'set.json';

/** 递归 CTE 深度上限（评审 P2-5——与 stones/query.ts TREE_DEPTH_LIMIT 同值同语义）。 */
const SUBTREE_DEPTH_LIMIT = 64;

function parseMeta(raw: string | null): ResourceMeta {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as ResourceMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 输入/结果形状

/** 成员清单条目（创建/追加——同 set.json 存储形状）。 */
export type SetMemberInput = ProductionSetMember;

/** 成员字段级更新（undefined=不动；null=清除——显式语义同 S1 patch）。 */
export interface SetMemberUpdate {
  stoneRef: string;
  quantity?: number | null;
  note?: string | null;
}

/** 组合级 patch（成员增删/字段级更新/改名/用途——revision CAS 下原子生效）。 */
export interface SetPatch {
  name?: string;
  purpose?: string | null;
  addMembers?: SetMemberInput[];
  removeMembers?: string[];
  updateMembers?: SetMemberUpdate[];
}

export interface CreateSetInput {
  ownerId: string;
  name: string;
  purpose?: string;
  /** manual-pick 必给成员清单；clone 禁给（服务端从母组合浅拷贝——双源必拒）。 */
  members?: SetMemberInput[];
  origin: ProductionSetOrigin;
  metadata?: Record<string, unknown>;
}

export interface CreateSetResult {
  /** 组合目录行 id（引用键/CAS 点——同 S1 resourceId 语义）。 */
  resourceId: string;
  setId: string;
  revision: number;
  path: string;
  memberCount: number;
  setJsonBlobRef: string;
}

export interface UpdateSetResult {
  resourceId: string;
  revision: number;
  path: string;
  memberCount: number;
}

/** 成员读时解析投影（五态+限定名——§7.1 不变量/§7.6 限定名）。 */
export interface SetMemberResolution {
  stoneRef: string;
  state: StoneRefResolution['state'];
  quantity?: number;
  note?: string;
  /** 标准ID（=stone.supplier——解析投影不落存储；行与投影均不可得时缺席）。 */
  standardId?: string;
  /** `<标准ID>/<SKU>`（§7.6 编号冲突区分——与 standardId 同源缺席）。 */
  qualifiedSku?: string;
  /** resolved 态 stone.json 全文（物化只在消费时刻）。 */
  stone?: StoneFile;
  /** 成员原子 revision（resolved 态）。 */
  revision?: number;
  /** resolved 态贴图 URL（与 stones.get 投影同形——ETag=blob hash 缓存面）。 */
  textureUrl?: string;
}

export interface GetSetResult {
  resourceId: string;
  setId: string;
  revision: number;
  path: string;
  trashed: boolean;
  set: ProductionSetFile;
  members: SetMemberResolution[];
}

export interface SetSummary {
  resourceId: string;
  setId: string;
  name: string;
  purpose?: string;
  origin: ProductionSetOrigin;
  memberCount: number;
  revision: number;
  path: string;
  trashed: boolean;
  updatedAt: string;
}

export interface SetListFilters {
  /** owner 隔离（评审 D-1 裁决：组合=生产工件，读写均按 owner——见文件头）。 */
  ownerId?: string;
  name?: string;
  purpose?: string;
  originKind?: ProductionSetOrigin['kind'];
  includeTrashed?: boolean;
}

// ---------------------------------------------------------------- 服务

export interface SetServiceDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** S1 标准层服务（成员读时解析的唯一真源——组合不建投影表）。 */
  stones: StoneService;
}

export class SetService {
  constructor(private readonly deps: SetServiceDeps) {}

  private get db(): SqliteDb {
    return this.deps.db;
  }

  private get blobs(): BlobStore {
    return this.deps.blobs;
  }

  private get stones(): StoneService {
    return this.deps.stones;
  }

  // -------------------------------------------------------------- seed（幂等）

  /** stones/production-sets/ 根（幂等——照 S1 ensureSystemDir 全局 role 语义）。 */
  ensureSetsRoot(ownerId: string): string {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM resources WHERE is_dir = 1 AND meta LIKE ?')
        .get(`%"role":"${SETS_ROOT_ROLE}"%`) as { id: string } | undefined;
      if (existing) return existing.id;
      const { stonesRootId } = this.stones.ensureRoots(ownerId);
      const byName = this.db
        .prepare('SELECT id FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 1')
        .get(stonesRootId, SETS_ROOT_NAME) as { id: string } | undefined;
      if (byName) {
        // 同名私有目录已存在但未标 role：补标（首访问领养——系统根语义全局唯一）。
        this.db.prepare('UPDATE resources SET meta = ? WHERE id = ?').run(
          JSON.stringify({ ...parseMeta(this.rowOf(byName.id)?.meta ?? null), role: SETS_ROOT_ROLE }),
          byName.id,
        );
        return byName.id;
      }
      return this.insertDir(ownerId, stonesRootId, SETS_ROOT_NAME, { role: SETS_ROOT_ROLE });
    })();
  }

  // -------------------------------------------------------------- 创建（三来源 §7.4）

  createSet(input: CreateSetInput): CreateSetResult {
    return this.db.transaction(() => {
      const origin = ProductionSetFileSchema.shape.origin.parse(input.origin);
      assertOriginShape(origin); // 跨类杂质字段拒（评审 P2-4——schema 冻结面归服务层收窄）
      // ---- 来源分派（§7.4）。
      let members: SetMemberInput[];
      if (origin.kind === 'bom-derived') {
        // S7.6 接口位冻结：BOM 聚合执行链依赖内核 P3（排钻产物 StonePick.stoneRef
        // 溯源落地）——落地前显式 typed 拒，不猜测、不留半实现路径。
        throw new SetServiceError(
          'bom-source-not-implemented',
          'bom-derived 来源不可用（接口位冻结——依赖内核排钻产物 stone 溯源；落地前用 manual-pick 或 clone）',
          { originKind: origin.kind },
        );
      }
      if (origin.kind === 'clone') {
        if (input.members !== undefined) {
          throw new SetServiceError(
            'invalid-origin',
            'clone 来源成员由服务端从母组合浅拷贝——不可同时显式给成员清单（双源必拒）',
          );
        }
        const mother = this.loadSetDir(origin.fromSetId);
        if (mother.dirRow.owner_id !== input.ownerId) {
          throw new SetServiceError('owner-mismatch', '母组合不属于当前 owner（跨用户 clone 必拒）', {
            fromSetId: origin.fromSetId,
          });
        }
        if (this.effectiveTrashed(origin.fromSetId)) {
          throw new SetServiceError('soft-deleted', '母组合在回收站内（先恢复再 clone）', {
            fromSetId: origin.fromSetId,
          });
        }
        // 浅拷贝：成员条目逐项复制（仍指标准原子 resourceId——不拷贝 stone 数据）。
        members = mother.set.stones.map((member) => ({ ...member }));
      } else {
        if (input.members === undefined || input.members.length === 0) {
          throw new SetServiceError('empty-members', 'manual-pick 来源须给非空成员清单（stones min 1——空组合无生产语义）');
        }
        members = input.members.map((member) => ({ ...member }));
      }
      assertMembersValid(members); // 重复 stoneRef/成员形状（聚合形态不变量）
      const setsRootId = this.ensureSetsRoot(input.ownerId);
      const now = nowIso();
      const setId = `set-${randomUUID()}`;
      const file: ProductionSetFile = {
        kind: 'stone-set',
        formatVersion: 1,
        id: setId,
        name: input.name,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        stones: members,
        origin,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      const parsed = ProductionSetFileSchema.safeParse(file);
      if (!parsed.success) {
        throw new SetServiceError('schema', `set.json 不符契约：${parsed.error.issues.map((i) => i.message).join('; ')}`);
      }
      // 目录行+set.json 文件行+blob 同事务（照 S1 四步形状——组合无贴图行）。
      const dirName = this.uniqueChildName(setsRootId, file.name);
      const resourceId = this.insertDir(input.ownerId, setsRootId, dirName, {});
      const bytes = Buffer.from(JSON.stringify(parsed.data), 'utf8');
      const put = this.blobs.put(new Uint8Array(bytes));
      this.insertFile(input.ownerId, resourceId, SET_JSON_NAME, put.hash, bytes.byteLength, {
        kind: 'stone-set',
      });
      return {
        resourceId,
        setId,
        revision: 1,
        path: this.pathOf(resourceId),
        memberCount: parsed.data.stones.length,
        setJsonBlobRef: put.hash,
      };
    })();
  }

  // -------------------------------------------------------------- 读取（读时解析）

  /** 组合详情+成员读时解析（五态+限定名——缺失成员显式态不剔除）。 */
  getSet(resourceId: string): GetSetResult {
    const loaded = this.loadSetDir(resourceId);
    return {
      resourceId,
      setId: loaded.set.id,
      revision: loaded.dirRow.revision,
      path: this.pathOf(resourceId),
      trashed: this.effectiveTrashed(resourceId),
      set: loaded.set,
      members: this.resolveMembers(loaded.set.stones),
    };
  }

  /** 成员清单读时解析（公开面——MCP propose 预览候选成员复用同一解析投影）。 */
  resolveMembers(members: readonly SetMemberInput[]): SetMemberResolution[] {
    return members.map((member) => this.resolveMember(member));
  }

  /** 成员解析：resolved 用 stone.json 真值；非 resolved 退 stone_index 投影行取限定名。 */
  private resolveMember(member: SetMemberInput): SetMemberResolution {
    const resolution = this.stones.resolveStoneRef(member.stoneRef);
    const base: SetMemberResolution = {
      stoneRef: member.stoneRef,
      state: resolution.state,
      ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
      ...(member.note !== undefined ? { note: member.note } : {}),
    };
    if (resolution.state === 'resolved' && resolution.stone !== undefined) {
      const stone = resolution.stone;
      return {
        ...base,
        standardId: stone.supplier,
        qualifiedSku: qualifiedSku(stone.supplier, stone.sku),
        stone,
        ...(resolution.revision !== undefined ? { revision: resolution.revision } : {}),
        textureUrl: `/api/stones/${member.stoneRef}/texture.png`,
      };
    }
    // soft-deleted/blob-missing：stone_index 行仍在（含软删行）——限定名投影可得。
    const indexRow = this.db
      .prepare('SELECT supplier, sku FROM stone_index WHERE resource_id = ?')
      .get(member.stoneRef) as { supplier: string; sku: string } | undefined;
    if (indexRow !== undefined) {
      return { ...base, standardId: indexRow.supplier, qualifiedSku: qualifiedSku(indexRow.supplier, indexRow.sku) };
    }
    // wrong-kind/not-found（或投影行缺失）：限定名缺席——显式 missing 态呈现。
    return base;
  }

  /** 组合清单（名称/用途/来源筛选——resources+set.json 读时解析，无投影表）。 */
  listSets(filters: SetListFilters = {}): SetSummary[] {
    const rows = this.db
      .prepare("SELECT id, owner_id, name, content_hash FROM resources WHERE is_dir = 0 AND meta LIKE '%\"kind\":\"stone-set\"%'")
      .all() as Array<{ id: string; owner_id: string; name: string; content_hash: string | null }>;
    const summaries: SetSummary[] = [];
    for (const row of rows) {
      // set.json 文件行的父=组合目录行（成员/CAS/可见性都在目录行上）。
      const fileRow = this.rowOf(row.id);
      const dirRow = fileRow !== null && fileRow.parent_id !== null ? this.rowOf(fileRow.parent_id) : null;
      if (dirRow === null) continue; // 孤儿文件行（数据不一致）——跳过不放大
      if (filters.ownerId !== undefined && dirRow.owner_id !== filters.ownerId) continue;
      if (!filters.includeTrashed && this.effectiveTrashed(dirRow.id)) continue;
      const set = this.parseSetBlob(row.content_hash);
      if (set === null) continue; // 损坏行显式跳过（解析态归 getSet 呈现）
      if (filters.name !== undefined && !set.name.includes(filters.name)) continue;
      if (filters.purpose !== undefined && (set.purpose ?? '').includes(filters.purpose) === false) continue;
      if (filters.originKind !== undefined && set.origin.kind !== filters.originKind) continue;
      summaries.push({
        resourceId: dirRow.id,
        setId: set.id,
        name: set.name,
        ...(set.purpose !== undefined ? { purpose: set.purpose } : {}),
        origin: set.origin,
        memberCount: set.stones.length,
        revision: dirRow.revision,
        path: this.pathOf(dirRow.id),
        trashed: this.effectiveTrashed(dirRow.id),
        updatedAt: set.updatedAt,
      });
    }
    // 确定性稳定序（name, setId）——过滤保序的同族纪律。
    return summaries.sort((a, b) => (a.name === b.name ? (a.setId < b.setId ? -1 : 1) : a.name < b.name ? -1 : 1));
  }

  // -------------------------------------------------------------- 更新（patch + CAS）

  /**
   * 成员增删/字段级更新/改名/用途 → set.json 新 blob → 目录行 revision+1
   * （CAS：baseRevision 漂移必拒——§1.6/W4.2 §3.6.4 同规）。改名=目录行改名
   * （同父唯一名，排除自身）。
   */
  updateSet(resourceId: string, patch: SetPatch, options: { baseRevision: number }): UpdateSetResult {
    return this.db.transaction(() => {
      const loaded = this.loadSetDir(resourceId);
      if (loaded.dirRow.revision !== options.baseRevision) {
        throw new SetServiceError(
          'revision-conflict',
          `revision 漂移：base=${options.baseRevision} 当前=${loaded.dirRow.revision}（CAS 必拒）`,
          { currentRevision: loaded.dirRow.revision, baseRevision: options.baseRevision },
        );
      }
      const next: ProductionSetFile = {
        ...loaded.set,
        stones: applyMemberOps(loaded.set.stones, patch),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      if (patch.purpose !== undefined) {
        if (patch.purpose === null) delete next.purpose;
        else next.purpose = patch.purpose;
      }
      next.updatedAt = nowIso();
      const parsed = ProductionSetFileSchema.safeParse(next);
      if (!parsed.success) {
        throw new SetServiceError('schema', `set.json 不符契约：${parsed.error.issues.map((i) => i.message).join('; ')}`);
      }
      // 改名=目录行改名（引用只认 resourceId 不受路径影响——path 是派生量纪律）。
      if (patch.name !== undefined && patch.name !== loaded.set.name) {
        const renamed = this.uniqueChildName(loaded.dirRow.parent_id, patch.name, resourceId);
        this.db
          .prepare('UPDATE resources SET name = ?, updated_at = ? WHERE id = ?')
          .run(renamed, nowIso(), resourceId);
      }
      const bytes = Buffer.from(JSON.stringify(parsed.data), 'utf8');
      const put = this.blobs.put(new Uint8Array(bytes));
      if (loaded.jsonRow.content_hash && loaded.jsonRow.content_hash !== put.hash) {
        this.blobs.releaseRef(loaded.jsonRow.content_hash);
      }
      this.db
        .prepare('UPDATE resources SET content_hash = ?, size = ?, updated_at = ? WHERE id = ?')
        .run(put.hash, bytes.byteLength, nowIso(), loaded.jsonRow.id);
      const revision = loaded.dirRow.revision + 1;
      this.db
        .prepare('UPDATE resources SET revision = ?, updated_at = ? WHERE id = ?')
        .run(revision, nowIso(), resourceId);
      return { resourceId, revision, path: this.pathOf(resourceId), memberCount: parsed.data.stones.length };
    })();
  }

  // -------------------------------------------------------------- 软删（§1.6 同语义）

  /** 递归软删：子树全行盖 meta.trashedAt（组合通常无子树——形状与 S1 对齐）。 */
  softDeleteSet(resourceId: string): { trashedRows: number } {
    return this.db.transaction(() => {
      const row = this.requireRow(resourceId);
      const role = parseMeta(row.meta).role;
      if (role !== undefined && role === SETS_ROOT_ROLE) {
        throw new SetServiceError('system-dir-protected', `系统目录禁删（role=${role}）：${this.pathOf(resourceId)}`, {
          role,
        });
      }
      this.loadSetDir(resourceId); // not-found/wrong-kind typed 拒（非组合目录禁删面）
      const ids = this.subtreeIds(resourceId);
      const stamp = nowIso();
      const update = this.db.prepare('UPDATE resources SET meta = ?, updated_at = ? WHERE id = ?');
      for (const id of ids) {
        const target = this.requireRow(id);
        update.run(JSON.stringify({ ...parseMeta(target.meta), trashedAt: stamp }), stamp, id);
      }
      return { trashedRows: ids.length };
    })();
  }

  // -------------------------------------------------------------- 内部工具

  /** 组合目录装载（dir + set.json 子行 + blob 解析）。 */
  private loadSetDir(resourceId: string): { dirRow: ResourceRow; jsonRow: ResourceRow; set: ProductionSetFile } {
    const dirRow = this.rowOf(resourceId);
    if (dirRow === null) {
      throw new SetServiceError('not-found', `资源不存在：${resourceId}`, { resourceId });
    }
    if (dirRow.is_dir !== 1) {
      throw new SetServiceError('wrong-kind', `资源不是目录：${resourceId}`, { resourceId });
    }
    const jsonRow = this.childFileOf(resourceId, SET_JSON_NAME);
    if (jsonRow === null || parseMeta(jsonRow.meta).kind !== 'stone-set') {
      throw new SetServiceError('wrong-kind', `目录不是生产组合（无 set.json 文件行）：${this.pathOf(resourceId)}`, {
        resourceId,
      });
    }
    const set = this.parseSetBlob(jsonRow.content_hash);
    if (set === null) {
      throw new SetServiceError('blob-missing', `set.json 内容不可读/不符契约：${resourceId}`, { resourceId });
    }
    return { dirRow, jsonRow, set };
  }

  /** set.json blob 解析（null=缺失或损坏——读面跳过/装载面 typed 拒）。 */
  private parseSetBlob(contentHash: string | null): ProductionSetFile | null {
    if (contentHash === null) return null;
    const bytes = this.blobs.read(contentHash);
    if (bytes === null) return null;
    try {
      const parsed = ProductionSetFileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private rowOf(id: string): ResourceRow | null {
    return (this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as ResourceRow | undefined) ?? null;
  }

  private requireRow(id: string): ResourceRow {
    const row = this.rowOf(id);
    if (row === null) throw new SetServiceError('not-found', `资源不存在：${id}`, { resourceId: id });
    return row;
  }

  private childFileOf(parentId: string, name: string): ResourceRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 0')
        .get(parentId, name) as ResourceRow | undefined) ?? null
    );
  }

  /** 同父名冲突自动 ` (2)`（§1.6——含软删兄弟行；excludeId=改名时排除自身）。 */
  private uniqueChildName(parentId: string | null, base: string, excludeId?: string): string {
    const exists = (name: string): boolean =>
      this.db
        .prepare('SELECT 1 FROM resources WHERE parent_id IS ? AND name = ? AND id != ?')
        .get(parentId, name, excludeId ?? '') !== undefined;
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

  /** 子树 id 集（含根——递归 CTE；depth 上限=环防御：超限 typed 拒不挂起）。 */
  private subtreeIds(rootId: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(id, depth) AS (
           SELECT ?, 0 UNION ALL
           SELECT r.id, sub.depth + 1 FROM resources r JOIN sub ON r.parent_id = sub.id WHERE sub.depth < ?
         ) SELECT id, depth FROM sub`,
      )
      .all(rootId, SUBTREE_DEPTH_LIMIT) as Array<{ id: string; depth: number }>;
    const maxDepth = rows.reduce((max, row) => Math.max(max, row.depth), 0);
    if (maxDepth >= SUBTREE_DEPTH_LIMIT) {
      throw new SetServiceError(
        'depth-limit',
        `子树深度超过上限 ${SUBTREE_DEPTH_LIMIT}（数据成环或异常深——拒绝递归遍历）：${rootId}`,
        { rootId },
      );
    }
    return rows.map((r) => r.id);
  }

  /** 任一祖先或自身盖戳=不可见（级联可见性——§1.6 软删约束）。 */
  private effectiveTrashed(id: string): boolean {
    let current = this.rowOf(id);
    while (current !== null) {
      if (parseMeta(current.meta).trashedAt !== undefined) return true;
      current = current.parent_id === null ? null : this.rowOf(current.parent_id);
    }
    return false;
  }

  /** path 派生量（不存储——引用只认 resourceId）。 */
  private pathOf(resourceId: string): string {
    const names: string[] = [];
    let current = this.rowOf(resourceId);
    while (current !== null) {
      names.unshift(current.name);
      current = current.parent_id === null ? null : this.rowOf(current.parent_id);
    }
    return `/${names.join('/')}`;
  }
}

// ---------------------------------------------------------------- 纯函数（propose/执行共用）

/**
 * origin 跨类形状校验（评审 P2-4——contracts schema 冻结面开放 optional，完整性归
 * 服务层白名单收窄）：manual-pick={kind} 恰好、clone 必带 fromSetId 禁带
 * sourceTaskId、bom-derived 必带 sourceTaskId 禁带 fromSetId——杂质字段 typed
 * invalid-origin 拒（溯源字段不落无意义值）。assertion 签名=校验通过后类型同步
 * 收窄（clone 分支 fromSetId 必在场）。
 */
export type ShapedSetOrigin =
  | { kind: 'manual-pick' }
  | { kind: 'clone'; fromSetId: string }
  | { kind: 'bom-derived'; sourceTaskId: string };

export function assertOriginShape(origin: ProductionSetOrigin): asserts origin is ShapedSetOrigin {
  const foreign = (present: boolean, field: string, kind: ProductionSetOrigin['kind']): void => {
    if (present) {
      throw new SetServiceError('invalid-origin', `${kind} 来源不可带 ${field}（跨类杂质字段——溯源字段按 kind 白名单收窄）`, {
        originKind: kind,
        field,
      });
    }
  };
  if (origin.kind === 'manual-pick') {
    foreign(origin.fromSetId !== undefined, 'fromSetId', origin.kind);
    foreign(origin.sourceTaskId !== undefined, 'sourceTaskId', origin.kind);
    return;
  }
  if (origin.kind === 'clone') {
    if (origin.fromSetId === undefined) {
      throw new SetServiceError('invalid-origin', 'clone 来源须带 fromSetId（母组合 resourceId）');
    }
    foreign(origin.sourceTaskId !== undefined, 'sourceTaskId', origin.kind);
    return;
  }
  if (origin.sourceTaskId === undefined) {
    throw new SetServiceError('invalid-origin', 'bom-derived 来源须带 sourceTaskId（排钻任务溯源）');
  }
  foreign(origin.fromSetId !== undefined, 'fromSetId', origin.kind);
}

/** 成员清单聚合形态校验（stoneRef 唯一——BOM 反推聚合数量的前置不变量）。 */
function assertMembersValid(members: SetMemberInput[]): void {
  const seen = new Set<string>();
  for (const member of members) {
    if (member.stoneRef.length === 0) {
      throw new SetServiceError('schema', '成员 stoneRef 不可为空');
    }
    if (seen.has(member.stoneRef)) {
      throw new SetServiceError('duplicate-member', `成员 stoneRef 重复：${member.stoneRef}（同钻多次入库=调 quantity，不重复列条目）`, {
        stoneRef: member.stoneRef,
      });
    }
    seen.add(member.stoneRef);
  }
}

/**
 * 成员运算（纯函数——capability propose 预览与 service 执行共用同一结果，
 * diff 即执行真身）：追加（重复必拒）/移除（清空必拒）/字段级更新
 * （undefined=不动；null=清除）。顺序语义：先移除后追加后更新——同 stoneRef
 * 先移除再加入=「重置条目」合法路径。remove/update 指向非成员=typed not-found
 * 拒（静默 no-op 会让 proposal diff 失真）。
 */
export function applyMemberOps(current: ProductionSetMember[], patch: SetPatch): ProductionSetMember[] {
  const removed = new Set(patch.removeMembers ?? []);
  for (const stoneRef of removed) {
    if (!current.some((member) => member.stoneRef === stoneRef)) {
      throw new SetServiceError('not-found', `removeMembers 指向非成员：${stoneRef}（成员不存在——显式拒，不静默忽略）`, {
        stoneRef,
      });
    }
  }
  let next = current.filter((member) => !removed.has(member.stoneRef));
  for (const member of patch.addMembers ?? []) {
    next = [...next, { ...member }];
  }
  assertMembersValid(next);
  if (next.length === 0) {
    throw new SetServiceError('empty-members', '成员清单不可清空（stones min 1——删空组合请走 set.delete）');
  }
  const present = new Set(next.map((member) => member.stoneRef));
  const updates = new Map((patch.updateMembers ?? []).map((update) => [update.stoneRef, update]));
  for (const stoneRef of updates.keys()) {
    if (!present.has(stoneRef)) {
      throw new SetServiceError('not-found', `updateMembers 指向非成员：${stoneRef}（成员不存在——显式拒，不静默忽略）`, {
        stoneRef,
      });
    }
  }
  next = next.map((member) => {
    const update = updates.get(member.stoneRef);
    if (update === undefined) return member;
    const result = { ...member };
    if (update.quantity !== undefined) {
      if (update.quantity === null) delete result.quantity;
      else result.quantity = update.quantity;
    }
    if (update.note !== undefined) {
      if (update.note === null) delete result.note;
      else result.note = update.note;
    }
    return result;
  });
  return next;
}
