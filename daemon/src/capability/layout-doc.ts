/**
 * 贴钻真值文档模型（W4.2 patch 族的资源真源——design §3.4 proposal diff 的落点）。
 * 原始需求 2026-09-23（tasks.md W4.2）：patch-propose「不动真值」+ patch-apply 单 op
 * 落库 + 未批准真值零变化 + 密度单调。真值=resources 行（meta.kind='layout'，content
 * 指向内容寻址 blob）携带 revision（§3.6.4 CAS 基线）——W2 排钻 job 的 PaveOutcome
 * 形状直接作为文档体（gems/blocks/palette/grid + 重排参数 pave）。
 * 正交意图：
 *   [1] LayoutDocumentSchema：真值文档 Zod（engine Gem[]/Block[]/Palette/GridSpec
 *       逐字段透传 + pave 重排参数——setDensity 需要|重排才能产出新 gems）。
 *   [2] publish/load/rewrite：资源生命周期（blob 引用随内容替换 acquire/release，
 *       revision 单调递增——CAS 唯一写点）。
 *   [3] applyPatchChanges：三态 op 的纯函数应用（setDensity=密度覆盖重排；
 *       recolor=色板映射改写；setSpec=规格重戳——与 engine job 的物化口径一致）；
 *       同参确定（seed 冻结）、density 上升⇒钻数单调不减由 layout 保证。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs';
import { nowIso } from '../db/store.js';
import {
  DensitySpecSchema,
  RegionSchema,
  StrategyIdSchema,
} from '@handicraft/contracts';
import { layout } from 'rhinestone-studio/engine';
import { canonicalJson } from './authorization.js';

/** 重排参数（setDensity 重跑 layout 的输入冻结——同参确定性的根）。 */
export const PaveContextSchema = z
  .object({
    strategy: StrategyIdSchema,
    density: DensitySpecSchema,
    seed: z.number().int().nonnegative(),
    relax: z
      .object({ boundary: z.boolean(), repulsion: z.boolean() })
      .strict(),
    spec: z
      .object({
        shapeId: z.enum(['round', 'square', 'drop', 'heart', 'marquise', 'custom']),
        diameterMm: z.number().positive(),
        rotationDeg: z.number().optional(),
        assetId: z.string().optional(),
      })
      .strict(),
    pixelsPerMm: z.number().positive(),
  })
  .strict();
export type PaveContext = z.infer<typeof PaveContextSchema>;

/** 真值文档（W2 PaveOutcome 的资源化形态）。 */
export const LayoutDocumentSchema = z
  .object({
    kind: z.literal('layout'),
    version: z.literal(1),
    imageWidth: z.number().int().positive(),
    imageHeight: z.number().int().positive(),
    palette: z.array(z.object({ id: z.string(), name: z.string(), hex: z.string() }).passthrough()),
    grid: z.object({ pitchMm: z.number(), gapMm: z.number(), rowAngleDeg: z.number(), pixelsPerMm: z.number() }).passthrough(),
    blocks: z.array(z.object({ id: z.string() }).passthrough()),
    gems: z.array(z.object({ id: z.string(), blockId: z.string() }).passthrough()),
    dropped: z.number().int().nonnegative(),
    shapeAssets: z.record(z.string(), z.string()),
    pave: PaveContextSchema,
  })
  .strict();
export type LayoutDocument = z.infer<typeof LayoutDocumentSchema>;

/** patch 变更输入（agent 面：只给 after——before 由服务端从真值读取）。 */
export const PatchChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setDensity'), target: z.string().min(1), after: z.number().positive().max(1) }).strict(),
  z.object({ op: z.literal('recolor'), target: z.string().min(1), after: z.string().min(1) }).strict(),
  z
    .object({
      op: z.literal('setSpec'),
      target: z.string().min(1),
      after: z
        .object({
          shapeId: z.enum(['round', 'square', 'drop', 'heart', 'marquise', 'custom']),
          diameterMm: z.number().positive(),
          rotationDeg: z.number().optional(),
          assetId: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type PatchChange = z.infer<typeof PatchChangeSchema>;

export const PatchProposeInputSchema = z
  .object({
    taskId: z.string().min(1),
    resourceId: z.string().min(1),
    region: RegionSchema,
    changes: z.array(PatchChangeSchema).min(1),
  })
  .strict();
export type PatchProposeInput = z.infer<typeof PatchProposeInputSchema>;

export interface LayoutResource {
  resourceId: string;
  revision: number;
  ownerId: string;
  doc: LayoutDocument;
}

/** 发布真值文档为资源（revision=1；blob 引用由 resources.content_hash 持有）。 */
export function publishLayoutDocument(
  db: SqliteDb,
  blobs: BlobStore,
  ownerId: string,
  name: string,
  doc: LayoutDocument,
): { resourceId: string; revision: number } {
  const parsed = LayoutDocumentSchema.parse(doc);
  const bytes = Buffer.from(canonicalJson(parsed), 'utf8');
  const put = blobs.put(new Uint8Array(bytes));
  const resourceId = randomUUID();
  db.prepare(
    `INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, ?, ?, ?, 1, ?, ?)`,
  ).run(
    resourceId,
    ownerId,
    name,
    put.hash,
    bytes.byteLength,
    JSON.stringify({ kind: 'layout', version: 1 }),
    nowIso(),
    nowIso(),
  );
  return { resourceId, revision: 1 };
}

/** 读取真值资源（owner 校验 + meta.kind 门 + blob 解析）。 */
export function loadLayoutDocument(
  db: SqliteDb,
  blobs: BlobStore,
  ownerId: string,
  resourceId: string,
): LayoutResource {
  const row = db
    .prepare('SELECT * FROM resources WHERE id = ?')
    .get(resourceId) as
    | { id: string; owner_id: string; name: string; content_hash: string | null; meta: string | null; revision: number }
    | undefined;
  if (!row) throw new Error(`资源不存在：${resourceId}`);
  if (row.owner_id !== ownerId) throw new Error('无权访问他人资源');
  const meta = row.meta ? (JSON.parse(row.meta) as { kind?: string }) : null;
  if (meta?.kind !== 'layout') {
    throw new Error(`资源不是贴钻真值文档（kind=${String(meta?.kind)}）——patch 族仅作用于 layout 资源`);
  }
  if (!row.content_hash) throw new Error('真值文档缺少内容引用');
  const bytes = blobs.read(row.content_hash);
  if (bytes === null) throw new Error(`真值文档内容不可读（blobRef=${row.content_hash.slice(0, 12)}…）`);
  const doc = LayoutDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  return { resourceId, revision: row.revision, ownerId: row.owner_id, doc };
}

/**
 * 真值改写（patch-apply 的落库面——调用方事务内调用）：新内容 blob 替换 + 旧引用
 * 释放 + revision 单调 +1。revision CAS 由授权桥在消费事务内先行校验。
 */
export function rewriteLayoutDocument(
  db: SqliteDb,
  blobs: BlobStore,
  resourceId: string,
  doc: LayoutDocument,
): { revision: number; blobRef: string } {
  const parsed = LayoutDocumentSchema.parse(doc);
  const bytes = Buffer.from(canonicalJson(parsed), 'utf8');
  const put = blobs.put(new Uint8Array(bytes));
  const row = db
    .prepare('SELECT content_hash, revision FROM resources WHERE id = ?')
    .get(resourceId) as { content_hash: string | null; revision: number } | undefined;
  if (!row) throw new Error(`资源不存在：${resourceId}`);
  if (row.content_hash && row.content_hash !== put.hash) blobs.releaseRef(row.content_hash);
  const revision = row.revision + 1;
  db.prepare('UPDATE resources SET content_hash = ?, size = ?, revision = ?, updated_at = ? WHERE id = ?').run(
    put.hash,
    bytes.byteLength,
    revision,
    nowIso(),
    resourceId,
  );
  return { revision, blobRef: put.hash };
}

/** 密度规格 → 逐块生效映射（全局标量展开 + 逐块覆盖）。 */
function effectiveDensityMap(doc: LayoutDocument): Record<string, number> {
  const map: Record<string, number> = {};
  for (const block of doc.blocks) map[block.id] = typeof doc.pave.density === 'number' ? doc.pave.density : 1;
  if (typeof doc.pave.density !== 'number') Object.assign(map, doc.pave.density);
  return map;
}

/**
 * 应用 patch 变更（纯函数——不动库）：返回 after 文档与逐 op 的 before/after 值。
 * setDensity=合并密度覆盖后整图重排（同 seed——非目标块结果不变，目标块密度单调）；
 * recolor=目标块钻的 colorId 改写（after 必须是 palette 既有条目）；
 * setSpec=目标块钻规格重戳（与 engine job 物化口径一致——不重排网格）。
 */
export function applyPatchChanges(
  doc: LayoutDocument,
  region: { kind: 'blocks'; ids: string[] },
  changes: PatchChange[],
): { after: LayoutDocument; opRows: Array<{ opKind: 'setDensity' | 'recolor' | 'setSpec'; target: string; beforeJson: string; afterJson: string }> } {
  const blockIds = new Set(doc.blocks.map((block) => block.id));
  const unknownRegion = region.ids.filter((id) => !blockIds.has(id));
  if (unknownRegion.length > 0) {
    throw new Error(`region 引用不存在的图块 ID：${unknownRegion.join('、')}`);
  }
  const regionSet = new Set(region.ids);
  for (const change of changes) {
    if (!blockIds.has(change.target)) {
      throw new Error(`patch 目标图块不存在：${change.target}（可用：${[...blockIds].join('、')}）`);
    }
    if (!regionSet.has(change.target)) {
      throw new Error(`patch 目标 ${change.target} 不在 region 内——region 与 ops 目标集必须一致`);
    }
  }

  const opRows: Array<{ opKind: 'setDensity' | 'recolor' | 'setSpec'; target: string; beforeJson: string; afterJson: string }> = [];
  let gems = [...doc.gems];
  let dropped = doc.dropped;
  const densityMap = effectiveDensityMap(doc);
  let densityDirty = false;
  const pave: PaveContext = { ...doc.pave };

  for (const change of changes) {
    switch (change.op) {
      case 'setDensity': {
        opRows.push({
          opKind: 'setDensity',
          target: change.target,
          beforeJson: canonicalJson(densityMap[change.target] ?? 1),
          afterJson: canonicalJson(change.after),
        });
        densityMap[change.target] = change.after;
        densityDirty = true;
        break;
      }
      case 'recolor': {
        if (!doc.palette.some((color) => color.id === change.after)) {
          throw new Error(`色板不存在条目 ${change.after}（可用：${doc.palette.map((c) => c.id).join('、')}）`);
        }
        const before = gems.find((gem) => gem.blockId === change.target) as { colorId?: unknown } | undefined;
        const beforeColor = typeof before?.colorId === 'string' ? before.colorId : null;
        opRows.push({
          opKind: 'recolor',
          target: change.target,
          beforeJson: canonicalJson(beforeColor),
          afterJson: canonicalJson(change.after),
        });
        gems = gems.map((gem) => (gem.blockId === change.target ? { ...gem, colorId: change.after } : gem));
        break;
      }
      case 'setSpec': {
        const before = gems.find((gem) => gem.blockId === change.target);
        const beforeSpec = before
          ? {
              shapeId: before.shapeId,
              diameterMm: before.diameterMm,
              ...(before.rotationDeg !== undefined ? { rotationDeg: before.rotationDeg } : {}),
              ...(before.assetId !== undefined ? { assetId: before.assetId } : {}),
            }
          : null;
        if (change.after.shapeId === 'custom' && !change.after.assetId) {
          throw new Error('setSpec 目标形状为 custom 但缺 assetId（引擎 CustomAssetIdMissingError 同语义）');
        }
        opRows.push({ opKind: 'setSpec', target: change.target, beforeJson: canonicalJson(beforeSpec), afterJson: canonicalJson(change.after) });
        gems = gems.map((gem) =>
          gem.blockId === change.target
            ? {
                ...gem,
                shapeId: change.after.shapeId,
                diameterMm: change.after.diameterMm,
                ...(change.after.rotationDeg !== undefined ? { rotationDeg: change.after.rotationDeg } : {}),
                ...(change.after.assetId !== undefined ? { assetId: change.after.assetId } : {}),
              }
            : gem,
        );
        break;
      }
    }
  }

  if (densityDirty) {
    // 密度覆盖重排：同 seed/同 strategy/同 grid——非目标块密度不变故结果不变；
    // 目标块密度上升 ⇒ 钻数单调不减（engine layout 语义）。
    // 色映射取自**当前**（含本批 recolor 已生效的）gems——recolor+setDensity 同批
    // 时重排结果保留新色（变更合并语义）。
    const blockColor = new Map<string, string>();
    for (const gem of gems) {
      const typed = gem as { blockId: string; colorId?: unknown };
      if (typeof typed.colorId === 'string') blockColor.set(typed.blockId, typed.colorId);
    }
    const specFields = {
      shapeId: pave.spec.shapeId,
      diameterMm: pave.spec.diameterMm,
      ...(pave.spec.rotationDeg !== undefined ? { rotationDeg: pave.spec.rotationDeg } : {}),
      ...(pave.spec.assetId !== undefined ? { assetId: pave.spec.assetId } : {}),
    };
    const result = layout(
      doc.blocks as unknown as Parameters<typeof layout>[0],
      pave.strategy,
      { density: densityMap, seed: pave.seed, relax: pave.relax },
      doc.grid as unknown as Parameters<typeof layout>[3],
    );
    gems = result.gems.map((gem) => ({
      ...gem,
      ...specFields,
      colorId: blockColor.get(gem.blockId) ?? doc.palette[0]?.id ?? '',
    })) as typeof gems;
    dropped = result.dropped ?? 0;
    pave.density = densityMap;
  }

  return { after: { ...doc, gems, dropped, pave }, opRows };
}
