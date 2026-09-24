/**
 * 装饰钻库查询真源面（add-stone-library design §4.1——S3.1）。
 * 原始需求 2026-09-24（tasks.md S3.1）：stones.tree/list/get 的查询底座——
 * **SQL 索引查询**（stone_index 直查，不复用 S4 listIndexRows 的 JS 全量过滤——
 * 评审 P2-4：那是测试面函数，本模块是真源查询面）。
 * 共享读语义（评审 D-1 裁定，design §6 修订）：list/tree/get 对全部认证用户
 * 返回同一库内容（供应链真源）——每响应带 readScope:'shared-library'；
 * 写路径 owner 审计不受影响（capability/授权桥面）。
 * 正交意图：
 *   [1] list：filter 全集 SQL 组装（supplier/family/sizeMm/styleRow/sku/q/
 *       includeTrashed）+ 分页 + groupBy 键投影。
 *   [2] tree：standards/ 目录树（供应商→色系→款式行→SKU 原子；原子叶=
 *       StoneGridCell 轻投影=S0 契约）。
 *   [3] gridCellOfRow：投影行→StoneGridCell（textureUrl=/api/stones/{id}/texture.png，
 *       S3.2 HTTP 面的协议对偶）。
 */
import type { StoneGridCell } from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { StoneIndexRow } from './service.js';

/** 共享读标注（评审 D-1：库内容对全部认证用户同一——响应面统一携带）。 */
export const READ_SCOPE_SHARED = 'shared-library' as const;

// ---------------------------------------------------------------- list（SQL 索引查询）

export interface StoneListFilter {
  supplier?: string;
  family?: string;
  sizeMm?: number;
  styleRow?: number;
  sku?: string;
  /** 关键字（SKU/供应商/色系/款式名/十六进制子串——小写包含匹配）。 */
  q?: string;
  groupBy?: 'family' | 'sizeMm' | 'style';
  page: number;
  pageSize: number;
  includeTrashed: boolean;
}

export interface StoneListResult {
  cells: StoneGridCell[];
  total: number;
  page: number;
  pageSize: number;
  groupKeys?: string[];
}

/** filter → WHERE 片段与参数（list 与 groupKeys 共用同一过滤口径）。 */
function whereOf(filter: Pick<StoneListFilter, 'supplier' | 'family' | 'sizeMm' | 'styleRow' | 'sku' | 'q' | 'includeTrashed'>): {
  where: string;
  params: unknown[];
} {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (!filter.includeTrashed) conds.push('trashed = 0');
  if (filter.supplier !== undefined) {
    conds.push('supplier = ?');
    params.push(filter.supplier);
  }
  if (filter.family !== undefined) {
    conds.push('family = ?');
    params.push(filter.family);
  }
  if (filter.sizeMm !== undefined) {
    conds.push('size_mm = ?');
    params.push(filter.sizeMm);
  }
  if (filter.styleRow !== undefined) {
    conds.push('style_row = ?');
    params.push(filter.styleRow);
  }
  if (filter.sku !== undefined) {
    conds.push('sku = ?');
    params.push(filter.sku);
  }
  if (filter.q !== undefined) {
    // SQLite lower() 仅 ASCII——与 S4 面 JS toLowerCase 在本域（ASCII 编码/十六进制/
    // 中文原文）等价；中文色系大小写无义。
    // LIKE 元字符字面化（评审 P2-1）：%/_/escape 反斜杠先转义+各 LIKE 配 ESCAPE
    // '\'——与 S4 capability 面 String.includes 字面子串语义等价（q='%' 不再通配）。
    const escaped = filter.q
      .toLowerCase()
      .replaceAll('\\', '\\\\')
      .replaceAll('%', '\\%')
      .replaceAll('_', '\\_');
    conds.push(
      "(lower(sku) LIKE ? ESCAPE '\\' OR lower(supplier) LIKE ? ESCAPE '\\' OR lower(family) LIKE ? ESCAPE '\\' OR lower(ifnull(style_name, '')) LIKE ? ESCAPE '\\' OR lower(color_hex) LIKE ? ESCAPE '\\')",
    );
    const needle = `%${escaped}%`;
    params.push(needle, needle, needle, needle, needle);
  }
  return { where: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** 投影行 → 网格单元（StoneGridCell 契约——name 由 style×size 合成，与 S4 面同式）。 */
export function gridCellOfRow(row: StoneIndexRow): StoneGridCell {
  const name = row.size_mm !== null ? `${row.style_name ?? row.sku} · ${row.size_mm}mm` : (row.style_name ?? row.sku);
  return {
    resourceId: row.resource_id,
    sku: row.sku,
    supplier: row.supplier,
    name,
    styleName: row.style_name ?? '',
    family: row.family,
    sizeMm: row.size_mm,
    colorHex: row.color_hex,
    finish: row.finish ?? '',
    textureUrl: `/api/stones/${row.resource_id}/texture.png`,
    trashed: row.trashed === 1,
    updatedAt: row.updated_at,
  };
}

/** stones.list 查询体：过滤+分页（supplier,sku 稳定序）+可选 groupKeys（全过滤集上取键）。 */
export function queryStoneCells(db: SqliteDb, filter: StoneListFilter): StoneListResult {
  const { where, params } = whereOf(filter);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM stone_index ${where}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT * FROM stone_index ${where} ORDER BY supplier, sku LIMIT ? OFFSET ?`)
    .all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as StoneIndexRow[];
  const result: StoneListResult = {
    cells: rows.map(gridCellOfRow),
    total,
    page: filter.page,
    pageSize: filter.pageSize,
  };
  if (filter.groupBy !== undefined) {
    result.groupKeys = groupKeysOf(db, where, params, filter.groupBy);
  }
  return result;
}

/** groupBy 键投影（DISTINCT over 全过滤集——非当前页；空值档显式殿后）。 */
function groupKeysOf(db: SqliteDb, where: string, params: unknown[], groupBy: 'family' | 'sizeMm' | 'style'): string[] {
  if (groupBy === 'family') {
    const rows = db.prepare(`SELECT DISTINCT family AS k FROM stone_index ${where} ORDER BY family`).all(...params) as Array<{ k: string }>;
    return rows.map((row) => row.k);
  }
  if (groupBy === 'sizeMm') {
    const rows = db
      .prepare(`SELECT DISTINCT size_mm AS k FROM stone_index ${where} ORDER BY (size_mm IS NULL), size_mm`)
      .all(...params) as Array<{ k: number | null }>;
    return rows.map((row) => (row.k !== null ? String(row.k) : '未声明'));
  }
  const rows = db
    .prepare(`SELECT DISTINCT style_row AS k FROM stone_index ${where} ORDER BY (style_row IS NULL), style_row`)
    .all(...params) as Array<{ k: number | null }>;
  return rows.map((row) => (row.k !== null ? `row-${row.k}` : '未编行'));
}

// ---------------------------------------------------------------- tree（standards/ 目录树）

export type StoneTreeNode =
  | {
      kind: 'dir';
      id: string;
      name: string;
      role?: 'stones-root' | 'standards-root' | 'supplier';
      /** 子树内原子计数（含可见性过滤——UI 徽标用）。 */
      childCount: number;
      children: StoneTreeNode[];
    }
  | { kind: 'stone'; cell: StoneGridCell };

export interface StoneTreeResult {
  /** 树根（null=库空——standards 根尚未 seed，首颗原子入库后出现）。 */
  rootId: string | null;
  node: StoneTreeNode | null;
}

/** 递归 CTE 子树行（resources LEFT JOIN stone_index——原子=有投影行的目录；depth=环防御深度列）。 */
interface TreeRow {
  id: string;
  parent_id: string | null;
  name: string;
  is_dir: number;
  meta: string | null;
  depth: number;
  resource_id: string | null;
  sku: string | null;
  supplier: string | null;
  style_row: number | null;
  style_name: string | null;
  family: string | null;
  size_mm: number | null;
  color_hex: string | null;
  finish: string | null;
  trashed: number | null;
  updated_at: string | null;
}

function treeRowToIndexRow(row: TreeRow): StoneIndexRow {
  return {
    resource_id: row.resource_id as string,
    owner_id: '',
    supplier: row.supplier as string,
    sku: row.sku as string,
    style_row: row.style_row,
    style_name: row.style_name,
    family: row.family as string,
    size_mm: row.size_mm,
    color_hex: row.color_hex as string,
    finish: row.finish,
    trashed: row.trashed as number,
    updated_at: row.updated_at as string,
  };
}

/** 递归 CTE 深度上限（评审 P2-5 环防御）：写路径不产生环，唯直改 DB 可造——超限 typed 拒绝递归（不挂起）。 */
export const TREE_DEPTH_LIMIT = 64;

/**
 * stones.tree：rootId 缺省=standards 根（meta.role 全局唯一标记——S1 seed 语义）。
 * !includeTrashed：trashed=1 原子剔除+空枝剪除（级联可见性已物化在投影列）；
 * includeTrashed：全量保留（回收站视图，cell.trashed 标注）。
 */
export function stonesTreeOf(db: SqliteDb, options: { rootId?: string; includeTrashed: boolean }): StoneTreeResult {
  const rootId = options.rootId ?? standardsRootIdOf(db);
  if (rootId === null) return { rootId: null, node: null };
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id, parent_id, name, is_dir, meta, depth) AS (
         SELECT id, parent_id, name, is_dir, meta, 0 FROM resources WHERE id = ?
         UNION ALL
         SELECT r.id, r.parent_id, r.name, r.is_dir, r.meta, sub.depth + 1 FROM resources r JOIN sub ON r.parent_id = sub.id WHERE sub.depth < ?
       )
       SELECT sub.id, sub.parent_id, sub.name, sub.is_dir, sub.meta, sub.depth,
              si.resource_id, si.sku, si.supplier, si.style_row, si.style_name,
              si.family, si.size_mm, si.color_hex, si.finish, si.trashed, si.updated_at
       FROM sub LEFT JOIN stone_index si ON si.resource_id = sub.id`,
    )
    .all(rootId, TREE_DEPTH_LIMIT) as TreeRow[];
  const maxDepth = rows.reduce((max, row) => Math.max(max, row.depth), 0);
  if (maxDepth >= TREE_DEPTH_LIMIT) {
    // 直改 DB 造环防御（服务路径不可达）：有界截断后显式拒——不无限递归挂起。
    throw new Error(`目录树深度超过上限 ${TREE_DEPTH_LIMIT}（数据成环或异常深——拒绝递归遍历）：${rootId}`);
  }
  const byId = new Map<string, TreeRow>(rows.map((row) => [row.id, row]));
  const root = byId.get(rootId);
  if (root === undefined || root.is_dir !== 1) {
    // 显式 rootId 打错=调用方错误（BAD_REQUEST 面——由 rpc ownedError 投影）。
    throw new Error(`树根不存在或不是目录：${rootId}`);
  }
  const childrenOf = new Map<string, TreeRow[]>();
  for (const row of rows) {
    if (row.parent_id === null || row.id === rootId) continue;
    const list = childrenOf.get(row.parent_id);
    if (list === undefined) childrenOf.set(row.parent_id, [row]);
    else list.push(row);
  }
  const node = buildTreeNode(root, childrenOf, options.includeTrashed);
  // includeTrashed=false 且子树全空：根保留（UI 锚点），children=[]。
  return { rootId, node: node ?? { kind: 'dir', id: rootId, name: root.name, childCount: 0, children: [] } };
}

function standardsRootIdOf(db: SqliteDb): string | null {
  const row = db
    .prepare("SELECT id FROM resources WHERE is_dir = 1 AND meta LIKE ?")
    .get('%"role":"standards-root"%') as { id: string } | undefined;
  return row?.id ?? null;
}

/** 递归构节点；可见性过滤后无内容的子树返回 null（剪枝）；childCount=子树原子数。 */
function buildTreeNode(
  row: TreeRow,
  childrenOf: Map<string, TreeRow[]>,
  includeTrashed: boolean,
): StoneTreeNode | null {
  if (row.resource_id !== null) {
    if (!includeTrashed && (row.trashed ?? 0) === 1) return null;
    return { kind: 'stone', cell: gridCellOfRow(treeRowToIndexRow(row)) };
  }
  if (row.is_dir !== 1) return null; // stone.json/贴图.png 文件行不入树
  const children: StoneTreeNode[] = [];
  let childCount = 0;
  for (const child of childrenOf.get(row.id) ?? []) {
    const node = buildTreeNode(child, childrenOf, includeTrashed);
    if (node === null) continue;
    childCount += node.kind === 'stone' ? 1 : node.childCount;
    children.push(node);
  }
  if (!includeTrashed && children.length === 0) {
    // 空枝剪除（系统根语义上仍保留顶层根——由调用方兜底，见 stonesTreeOf 尾部）。
    return null;
  }
  const meta = parseRoleOf(row.meta);
  return {
    kind: 'dir',
    id: row.id,
    name: row.name,
    childCount,
    children,
    ...(meta !== undefined ? { role: meta } : {}),
  };
}

function parseRoleOf(meta: string | null): 'stones-root' | 'standards-root' | 'supplier' | undefined {
  if (meta === null) return undefined;
  try {
    const parsed = JSON.parse(meta) as { role?: unknown };
    if (parsed.role === 'stones-root' || parsed.role === 'standards-root' || parsed.role === 'supplier') {
      return parsed.role;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
