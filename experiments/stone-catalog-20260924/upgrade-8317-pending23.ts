/**
 * 8317 pending 23 贴图补全（2026-10-05 Owner 指令「补」）：
 * 23 款 yuhang pending 无任何可用源图（spike 质检显式判 pending：文字字形污染 16 +
 * 行 73 整行缺贴片 7——「待 Owner 裁决：45 格 pending 补图方式」的遗留）。
 * 方案=**确定性内置贴图占位**（daemon builtin-texture 同款渲染：同 rgb 同字节）——
 * metadata 留痕 placeholder（日后 Owner 给实拍图可按 upgrade-8317-textures.ts
 * 同型再升级）。事务形态照抄 upgrade-8317-textures.ts yuhang 段（四步同事务）。
 *
 * 运行（停 daemon 后，cwd=贴钻-backend/daemon）：
 *   DATA_ROOT=<8317root> node --require <tsx preflight> --import <tsx loader> \
 *     /Users/kzf/Pictures/贴钻/experiments/stone-catalog-20260924/upgrade-8317-pending23.ts
 * DRY_RUN=1 只打印计划不写库。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase, type SqliteDb } from '/Users/kzf/Pictures/贴钻-backend/daemon/src/db/database.js';
import { BlobStore } from '/Users/kzf/Pictures/贴钻-backend/daemon/src/db/blobs.js';
import { nowIso } from '/Users/kzf/Pictures/贴钻-backend/daemon/src/db/store.js';
import { decodePng } from '/Users/kzf/Pictures/贴钻-backend/daemon/src/png/codec.js';
import { generateBuiltinTexturePng } from '/Users/kzf/Pictures/贴钻-backend/daemon/src/stones/builtin-texture.js';
import { StoneFileSchema, type RgbTuple, type StoneFile } from '/Users/kzf/Pictures/贴钻-backend/contracts/src/index.ts';

const SOURCE_ROOT = '/Users/kzf/Pictures/贴钻/experiments/stone-catalog-20260924';
const DATA_ROOT = process.env.DATA_ROOT ?? '/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root';
const DRY_RUN = process.env.DRY_RUN === '1';
const REPORT_PATH = path.join(SOURCE_ROOT, 'upgrade-8317-pending23-report.json');
const YUHANG_FAMILY = '珍珠系';

function hexToRgb(hex: string): RgbTuple {
  const h = hex.replace('#', '');
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)] as RgbTuple;
}
function alphaBoundsOf(width: number, height: number, rgba: Uint8Array) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rgba[(y * width + x) * 4 + 3]! > 0) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function fmtMm(n: number): string { return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1))); }

const db = openDatabase(DATA_ROOT);
const blobs = new BlobStore(DATA_ROOT, db);
const owner = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string } | undefined;
if (owner === undefined) throw new Error('admin 用户不存在');
const ownerId = owner.id;
const now = nowIso();

// pending 清单=动态取（stone_index 行无 stone.json 子文件行）——幂等天然成立
const pending = db.prepare(`
  SELECT si.resource_id, si.sku, si.style_name, si.size_mm, si.color_hex, si.finish
  FROM stone_index si
  WHERE si.trashed = 0 AND si.supplier = 'yuhang' AND NOT EXISTS (
    SELECT 1 FROM resources f WHERE f.parent_id = si.resource_id AND f.name = 'stone.json'
  ) ORDER BY si.sku`).all() as Array<{ resource_id: string; sku: string; style_name: string | null; size_mm: number | null; color_hex: string | null; finish: string | null }>;
console.log(`[pending23] 待补：${pending.length} 款`);

const report: Record<string, unknown> = { kind: 'upgrade-8317-pending23', generatedAt: now, dryRun: DRY_RUN, dataRoot: DATA_ROOT, before: pending.length, done: [] as unknown[], errors: [] as unknown[] };

function insertFile(parentId: string, name: string, contentHash: string, size: number, meta: Record<string, unknown>): string {
  const id = randomUUID();
  const t = nowIso();
  db.prepare('INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)')
    .run(id, ownerId, parentId, name, contentHash, size, JSON.stringify(meta), t, t);
  return id;
}

let done = 0;
for (const row of pending) {
  try {
    const dirRow = db.prepare('SELECT id, meta, revision FROM resources WHERE id = ?').get(row.resource_id) as { id: string; meta: string | null; revision: number } | undefined;
    if (dirRow === undefined) throw new Error('目录行不存在');
    const dirMeta = dirRow.meta !== null ? (JSON.parse(dirRow.meta) as Record<string, unknown>) : {};
    if (dirMeta['kind'] !== 'stone-pending') throw new Error(`非 pending 目录行（kind=${String(dirMeta['kind'])}）——跳过`);
    const rgb = row.color_hex ? hexToRgb(row.color_hex) : ([164, 159, 145] as RgbTuple);
    const textureBytes = generateBuiltinTexturePng(rgb);
    const decoded = decodePng(textureBytes);
    const bounds = alphaBoundsOf(decoded.width, decoded.height, decoded.rgba);
    if (bounds === null) throw new Error('占位贴图全透明');

    const { kind: _k, pending: _p, pendingReason: _r, ...baseMeta } = dirMeta;
    const skuParseRaw = baseMeta['skuParse'] as Record<string, unknown> | undefined;
    const skuParsed = skuParseRaw !== undefined && typeof skuParseRaw['prefix'] === 'string' && Number.isInteger(skuParseRaw['row']) && typeof skuParseRaw['sizeMm'] === 'number'
      ? { prefix: skuParseRaw['prefix'] as string, row: skuParseRaw['row'] as number, sizeMm: skuParseRaw['sizeMm'] as number }
      : undefined;
    const colorName = typeof baseMeta['colorNameFromCard'] === 'string' ? baseMeta['colorNameFromCard'] : (row.style_name ?? row.sku);
    const sizeMm = row.size_mm ?? (skuParsed?.sizeMm ?? 3);
    const stone: StoneFile = {
      kind: 'stone', formatVersion: 1, id: `stn-${randomUUID()}`,
      name: `${colorName} · ${fmtMm(sizeMm)}mm`, supplier: 'yuhang', sku: row.sku,
      ...(skuParsed !== undefined ? { skuParsed } : {}),
      sizeMm,
      color: { name: colorName, rgb, family: YUHANG_FAMILY, finish: row.finish ?? 'unspecified' },
      texture: { file: '贴图.png', mime: 'image/png', width: decoded.width, height: decoded.height, alphaBounds: bounds },
      shapeClass: 'round',
      metadata: {
        ...baseMeta,
        importUpgrade: 'pending23-placeholder-20261005',
        textureSource: 'builtin-deterministic（占位：源素材无图——spike 质检 pending：文字字形污染/行73 缺贴片；Owner 2026-10-05 指令「补」）',
        texturePlaceholder: true,
        originalPendingReason: dirMeta['pendingReason'] ?? 'unknown',
      },
      createdAt: now, updatedAt: now,
    };
    const parsed = StoneFileSchema.parse(stone);
    const stoneBytes = Buffer.from(JSON.stringify(parsed), 'utf8');
    if (DRY_RUN) {
      console.log(`[dry] ${row.sku}: +stone.json(${stoneBytes.length}B) +贴图.png(${textureBytes.byteLength}B 占位 rgb=${rgb.join(',')})`);
    } else {
      db.transaction(() => {
        const stonePut = blobs.put(new Uint8Array(stoneBytes));
        insertFile(row.resource_id, 'stone.json', stonePut.hash, stoneBytes.byteLength, { kind: 'stone' });
        const texturePut = blobs.put(textureBytes);
        insertFile(row.resource_id, '贴图.png', texturePut.hash, textureBytes.byteLength, { kind: 'stone-texture' });
        db.prepare("UPDATE resources SET meta = '{}', revision = revision + 1, updated_at = ? WHERE id = ?").run(nowIso(), row.resource_id);
        db.prepare('UPDATE stone_index SET updated_at = ? WHERE resource_id = ?').run(parsed.updatedAt, row.resource_id);
      })();
    }
    done += 1;
    (report.done as unknown[]).push({ sku: row.sku, resourceId: row.resource_id, rgb, px: [decoded.width, decoded.height], bytes: textureBytes.byteLength, placeholder: true });
  } catch (e) {
    (report.errors as unknown[]).push({ sku: row.sku, error: String(e instanceof Error ? e.message : e) });
    console.error(`[pending23] ${row.sku} 失败：${String(e instanceof Error ? e.message : e)}`);
  }
}
report['after'] = done;
console.log(`[pending23] 完成 ${done}/${pending.length}（占位贴图——builtin 确定性渲染，metadata 留痕可再升级）`);
if (!DRY_RUN) writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
