/**
 * Owner 客户素材全量导入 8317 生产验收实例（2026-09-30 Owner 指令：
 * 「将我之前给你的那些素材和信息（cdr，我导出给你的图片和 CSV）全部作为
 * 默认素材导入」）。
 *
 * 源=stone-catalog-20260924 spike 成品（output/report.md：RAR+PDF+CDR+圈选图
 * 四件全部处理完成）。目标=8317 实例 DATA_ROOT（journey-clown-rich-v5-20260928）。
 * 运行方式：**停 8317 daemon 后**在 daemon/ 目录下
 * `nub scripts/import-owner-stones.ts`（env：DATA_ROOT 缺省即 8317 实例路径；
 * IMPORT_SCAN_ONLY=1 只做预检解码扫描不写库）。
 *
 * 行形态裁决（照抄既有服务写路径，daemon/src 零改）：
 *   - resources 树/文件行/stone_index 投影 = StoneService.createStone 四步同事务
 *     形态（已对照 8317 在场行逐列核对）；
 *   - 组合 = SetService.createSet 形态（stones/production-sets/ 根 + set.json
 *     文件行 meta.kind='stone-set'）；
 *   - blobs 走 BlobStore.put（staging→rename 原子发布 + 代际行——手搓必错，
 *     复用既有导出类不属 src 改动）；
 *   - 写路径不经过 StoneService/SetService（脚本直 SQL——本脚本即写路径）。
 *
 * 关键落库语义：
 *   - spike stone.json（自定义格式）→ daemon StoneFile 契约（StoneFileSchema.parse
 *     后序列化进 blob——读面 resolveStoneRef/rebuildStoneIndex 依赖契约通过）；
 *   - pending 45（无贴图原子）：建目录行 + stone_index 投影行，**不建**
 *     stone.json/贴图.png 文件行（StoneFile 契约硬要求贴图——不给贴图造不出
 *     合法 stone.json）；目录行 meta={kind:'stone-pending',...} 携带 spike 全量
 *     元数据（补图升级面），成员解析呈显式缺图态（五态模型）而非坏引用；
 *   - 幂等：stone 按 (supplier,sku) 在场跳过；组合按 set.json metadata.sourceSetId
 *     跳过；归档按 (parent,name) 跳过（hash 漂移仅报告）；
 *   - 8317 已有 yuhang/A52、yuhang/J51（旅程冒烟种子）→ 跳过并 remap 组合引用。
 *
 * 正交意图：
 *   [1] 预检扫描（IMPORT_SCAN_ONLY）：全量贴图解码测量，零写库。
 *   [2] 三标准库批量建原子（逐原子事务，部分失败语义）。
 *   [3] 生产组合 848 引用 remap 路径→resourceId 建组合。
 *   [4] 来源档案（CDR/RAR/PDF/CSV/页图/customer-preview + design-assets）→
 *       resources 归档域 /owner-archives/（只存档不进 stone_index）。
 *   [5] 对账报告（stdout + REPORT_PATH JSON 文件）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase, type SqliteDb } from '../src/db/database.js';
import { BlobStore } from '../src/db/blobs.js';
import { nowIso } from '../src/db/store.js';
import { decodePng } from '../src/png/codec.js';
import {
  ProductionSetFileSchema,
  StoneFileSchema,
  SupplierSkuProfileSchema,
  rgbToHex,
  type ProductionSetFile,
  type RgbTuple,
  type StoneFile,
  type SupplierSkuProfile,
} from '@handicraft/contracts';

// ---------------------------------------------------------------- 常量/入参

const SOURCE_ROOT =
  process.env.IMPORT_SOURCE_ROOT ?? '/Users/kzf/Pictures/贴钻/experiments/stone-catalog-20260924';
const OUTPUT_ROOT = path.join(SOURCE_ROOT, 'output');
const STANDARDS_ROOT = path.join(OUTPUT_ROOT, 'stones', 'standards');
const DATA_ROOT =
  process.env.DATA_ROOT ?? '/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root';
const REPORT_PATH = process.env.REPORT_PATH ?? path.join(SOURCE_ROOT, 'import-8317-report.json');
const OWNER_USERNAME = process.env.IMPORT_OWNER_USERNAME ?? 'admin';
const SCAN_ONLY = process.env.IMPORT_SCAN_ONLY === '1';

/** 新供应商档案（parseSku 全失败=显式无行编码；yuhang 已在场档案冻结不回写）。 */
const NEW_SUPPLIER_PROFILES: Record<string, SupplierSkuProfile> = {
  tuzuan: {
    supplier: 'tuzuan',
    displayName: '图钻（客户全色系素材 2026-09）',
    bands: [{ rows: [0, 0], sizeMmByPrefix: {} }],
    styleKey: 'row',
  },
  mofang: {
    supplier: 'mofang',
    displayName: '魔方钻（客户低清色卡 2026-09）',
    bands: [{ rows: [0, 0], sizeMmByPrefix: {} }],
    styleKey: 'row',
  },
};

/** yuhang 无 spike family 键——按素材语义归「珍珠系」（family=可重指逻辑分组）。 */
const YUHANG_FAMILY = '珍珠系';
const STONE_JSON_NAME = 'stone.json';
const TEXTURE_FILE_NAME = '贴图.png';
const SET_JSON_NAME = 'set.json';
const ARCHIVE_STEM = 'stone-catalog-20260924';
const SUPPLIER_NAMES = ['tuzuan', 'mofang', 'yuhang'] as const;

/** 来源档案清单（spike 根目录四件套 + 解析表）。 */
const SOURCE_FILES: readonly string[] = [
  '全色系钻(1).cdr',
  '钻石图案(1).rar',
  'sample-card.pdf',
  'page-1.png',
  'page-2.png',
  'page1-parsed.csv',
  'customer-preview.png',
];

/**
 * 隔行贴图（Adam7——daemon 纯 TS codec 拒收，240 张全在 tuzuan/CDR 线）的
 * 重编码缓存（PIL 非隔行重存，RGBA 像素恒等；生成命令见任务报告）。
 * 命中缓存=入库字节为重编码版，atom metadata 记 textureReencoded 审计标记。
 */
const TEXTURE_CACHE_ROOT = process.env.IMPORT_TEXTURE_CACHE ?? path.join(SOURCE_ROOT, 'reencoded-textures');

/** 贴图字节解析：重编码缓存优先→源文件；返回 null=无可用贴图（pending）。 */
function resolveTextureBytes(relDir: string): { bytes: Uint8Array; reencoded: boolean } | null {
  const cached = path.join(TEXTURE_CACHE_ROOT, relDir, 'texture.png');
  if (existsSync(cached)) {
    try {
      return { bytes: new Uint8Array(readFileSync(cached)), reencoded: true };
    } catch {
      // 缓存不可读退源文件
    }
  }
  const original = path.join(STANDARDS_ROOT, relDir, 'texture.png');
  if (existsSync(original)) {
    try {
      return { bytes: new Uint8Array(readFileSync(original)), reencoded: false };
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- spike 形状（宽松读，落库前转契约）

interface SpikeStone {
  kind: string;
  id: string;
  supplier: string;
  sku: string;
  sizeMm: number | null;
  color: { name: string | null; rgb: RgbTuple; texture: string };
  shape: string;
  textureRef: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------- 报告形状

interface SupplierReport {
  diskAtoms: number;
  diskTextures: number;
  created: number;
  pendingCreated: number;
  skipped: number;
  failed: number;
  advisories: string[];
  failures: { sku: string; reason: string }[];
}

interface ImportReport {
  kind: 'owner-stones-import-report';
  formatVersion: 1;
  generatedAt: string;
  scanOnly: boolean;
  dataRoot: string;
  sourceRoot: string;
  ownerId: string;
  suppliers: Record<string, SupplierReport>;
  preexistingSkips: { supplier: string; sku: string; resourceId: string }[];
  set: {
    sourceMembers: number;
    remapped: number;
    skipped: boolean;
    resourceId: string | null;
    setId: string | null;
    memberClosureMissing: string[];
  };
  archives: { filesFound: number; created: number; skipped: number; hashMismatch: string[] };
  verification: {
    indexTotals: Record<string, number>;
    textureBlobCheck: { sku: string; ok: boolean; width: number; height: number; bytes: number }[];
    pendingAtoms: number;
  };
}

// ---------------------------------------------------------------- 小工具

function fail(message: string): never {
  console.error(`[import-owner-stones] 致命：${message}`);
  process.exit(1);
}

function isRgb(v: unknown): v is RgbTuple {
  return (
    Array.isArray(v) && v.length === 3 && v.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
  );
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function parseSpikeStone(file: string): SpikeStone {
  const raw = readJson(file) as Record<string, unknown>;
  const color = (raw['color'] ?? {}) as Record<string, unknown>;
  const metadata = (raw['metadata'] ?? {}) as Record<string, unknown>;
  const kind = String(raw['kind'] ?? '');
  const supplier = String(raw['supplier'] ?? '');
  const sku = String(raw['sku'] ?? '');
  const rgb = color['rgb'];
  if (kind !== 'stone' || supplier === '' || sku === '' || !isRgb(rgb)) {
    throw new Error(`spike stone.json 形状不符：${file}`);
  }
  return {
    kind,
    id: String(raw['id'] ?? ''),
    supplier,
    sku,
    sizeMm: typeof raw['sizeMm'] === 'number' ? raw['sizeMm'] : null,
    color: {
      name: typeof color['name'] === 'string' ? color['name'] : null,
      rgb,
      texture: String(color['texture'] ?? 'unspecified'),
    },
    shape: String(raw['shape'] ?? 'round'),
    textureRef: typeof raw['textureRef'] === 'string' ? raw['textureRef'] : null,
    metadata,
  };
}

function walkAtomDirs(supplierDir: string): string[] {
  const out: string[] = [];
  const stack = [supplierDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) stack.push(abs);
      else if (entry === STONE_JSON_NAME) out.push(dir);
    }
  }
  return out.sort();
}

function walkFiles(root: string, base = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = path.join(root, entry);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out.sort();
}

/** 与 gates.ts 同算法：alpha>0 最小包围盒（无内容=null）。 */
function alphaBoundsOf(width: number, height: number, rgba: Uint8Array) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** mm 千分化显示（与 importer.ts fmtMm 同式）。 */
function fmtMm(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------- resources 直 SQL（照抄 service 行形态）

interface ResourceRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  is_dir: number;
  content_hash: string | null;
  size: number;
  meta: string | null;
}

function childRow(db: SqliteDb, parentId: string, name: string, isDir: boolean): ResourceRow | undefined {
  return db
    .prepare('SELECT * FROM resources WHERE parent_id = ? AND name = ? AND is_dir = ?')
    .get(parentId, name, isDir ? 1 : 0) as ResourceRow | undefined;
}

function uniqueChildName(db: SqliteDb, parentId: string, base: string): string {
  const exists = (name: string): boolean =>
    db.prepare('SELECT 1 FROM resources WHERE parent_id = ? AND name = ?').get(parentId, name) !== undefined;
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!exists(candidate)) return candidate;
  }
}

function insertDir(db: SqliteDb, ownerId: string, parentId: string | null, name: string, meta: Record<string, unknown> | null): string {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    'INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, 0, ?, 1, ?, ?)',
  ).run(id, ownerId, parentId, name, meta === null ? null : JSON.stringify(meta), now, now);
  return id;
}

function insertFile(db: SqliteDb, ownerId: string, parentId: string, name: string, contentHash: string, size: number, meta: Record<string, unknown>): string {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    'INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)',
  ).run(id, ownerId, parentId, name, contentHash, size, JSON.stringify(meta), now, now);
  return id;
}

/** ensureSystemDir 语义（meta.role 全局查→同名领养→新建）。 */
function ensureSystemDir(db: SqliteDb, ownerId: string, parentId: string | null, name: string, role: string): string {
  const byRole = db
    .prepare('SELECT id FROM resources WHERE is_dir = 1 AND meta LIKE ?')
    .get(`%"role":"${role}"%`) as { id: string } | undefined;
  if (byRole !== undefined) return byRole.id;
  const byName =
    parentId === null
      ? db.prepare('SELECT id FROM resources WHERE parent_id IS NULL AND name = ? AND is_dir = 1').get(name)
      : db.prepare('SELECT id FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 1').get(parentId, name);
  const named = byName as { id: string } | undefined;
  if (named !== undefined) return named.id;
  return insertDir(db, ownerId, parentId, name, { role });
}

/** ensureSupplier 语义（在场档案冻结——只复用不回写 meta）。 */
function ensureSupplier(db: SqliteDb, ownerId: string, standardsRootId: string, profile: SupplierSkuProfile): string {
  const existing = childRow(db, standardsRootId, profile.supplier, true);
  if (existing !== undefined) return existing.id;
  return insertDir(db, ownerId, standardsRootId, profile.supplier, { role: 'supplier', skuProfile: profile });
}

/** ensureChildDir 语义（同名复用，否则唯一名新建）。 */
function ensureChildDir(db: SqliteDb, ownerId: string, parentId: string, name: string): string {
  const existing = childRow(db, parentId, name, true);
  if (existing !== undefined) return existing.id;
  return insertDir(db, ownerId, parentId, uniqueChildName(db, parentId, name), {});
}

/** 原子四元组（导入与扫描共用抽取）。 */
interface AtomPlan {
  supplier: string;
  sku: string;
  relDir: string;
  absDir: string;
  spike: SpikeStone;
  textureBytes: Uint8Array | null;
  textureReencoded: boolean;
  family: string;
  styleName: string;
  skuParsed: { prefix: string; row: number; sizeMm: number } | undefined;
}

function planAtom(absDir: string, supplier: string, texture: { bytes: Uint8Array; reencoded: boolean } | null): AtomPlan {
  const spike = parseSpikeStone(path.join(absDir, STONE_JSON_NAME));
  if (spike.supplier !== supplier) throw new Error(`supplier 声明不符：${spike.supplier}`);
  const family =
    typeof spike.metadata['family'] === 'string' && spike.metadata['family'] !== ''
      ? spike.metadata['family']
      : supplier === 'yuhang'
        ? YUHANG_FAMILY
        : (() => {
            throw new Error(`${supplier}/${spike.sku} 缺 family 键`);
          })();
  const styleName = spike.color.name ?? spike.sku;
  const skuParseRaw = spike.metadata['skuParse'] as Record<string, unknown> | undefined;
  const skuParsed =
    skuParseRaw !== undefined &&
    typeof skuParseRaw['prefix'] === 'string' && skuParseRaw['prefix'] !== '' &&
    Number.isInteger(skuParseRaw['row']) &&
    typeof skuParseRaw['sizeMm'] === 'number' && skuParseRaw['sizeMm'] > 0
      ? { prefix: skuParseRaw['prefix'], row: skuParseRaw['row'] as number, sizeMm: skuParseRaw['sizeMm'] as number }
      : undefined;
  return {
    supplier,
    sku: spike.sku,
    relDir: path.relative(STANDARDS_ROOT, absDir),
    absDir,
    spike,
    textureBytes: texture?.bytes ?? null,
    textureReencoded: texture?.reencoded ?? false,
    family,
    styleName,
    skuParsed,
  };
}

function styleRowOf(plan: AtomPlan): number | null {
  return plan.skuParsed?.row ?? (typeof plan.spike.metadata['styleRow'] === 'number' ? (plan.spike.metadata['styleRow'] as number) : null);
}

// ---------------------------------------------------------------- 主流程

console.log(`[import-owner-stones] 源=${OUTPUT_ROOT}`);
console.log(`[import-owner-stones] 目标 DATA_ROOT=${DATA_ROOT}${SCAN_ONLY ? '（SCAN ONLY）' : ''}`);
if (!existsSync(path.join(STANDARDS_ROOT, 'tuzuan'))) fail('源 standards 目录不存在');
if (!existsSync(DATA_ROOT)) fail('DATA_ROOT 不存在');

const db = openDatabase(DATA_ROOT);
const blobs = new BlobStore(DATA_ROOT, db);

// ---- 阶段 0：预检扫描（IMPORT_SCAN_ONLY=1：解码测量全量贴图后退出，零写库）
if (SCAN_ONLY) {
  let decodeOk = 0;
  let pending = 0;
  const failures: string[] = [];
  for (const supplier of SUPPLIER_NAMES) {
    for (const absDir of walkAtomDirs(path.join(STANDARDS_ROOT, supplier))) {
      const texture = resolveTextureBytes(path.relative(STANDARDS_ROOT, absDir));
      if (texture === null) {
        pending += 1;
        continue;
      }
      try {
        const decoded = decodePng(texture.bytes);
        if (alphaBoundsOf(decoded.width, decoded.height, decoded.rgba) === null) {
          failures.push(`${absDir}: 全透明`);
          continue;
        }
        decodeOk += 1;
      } catch (error) {
        failures.push(`${absDir}: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
  }
  console.log(`[import-owner-stones] 扫描：decodeOk=${decodeOk} pending=${pending} failures=${failures.length}`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

const owner = db.prepare('SELECT id FROM users WHERE username = ?').get(OWNER_USERNAME) as
  | { id: string }
  | undefined;
if (owner === undefined) fail(`owner 用户不存在：${OWNER_USERNAME}（先启动 daemon 建号）`);
const ownerId = owner.id;
console.log(`[import-owner-stones] ownerId=${ownerId}（${OWNER_USERNAME}）`);

const report: ImportReport = {
  kind: 'owner-stones-import-report',
  formatVersion: 1,
  generatedAt: nowIso(),
  scanOnly: false,
  dataRoot: DATA_ROOT,
  sourceRoot: SOURCE_ROOT,
  ownerId,
  suppliers: {},
  preexistingSkips: [],
  set: { sourceMembers: 0, remapped: 0, skipped: false, resourceId: null, setId: null, memberClosureMissing: [] },
  archives: { filesFound: 0, created: 0, skipped: 0, hashMismatch: [] },
  verification: { indexTotals: {}, textureBlobCheck: [], pendingAtoms: 0 },
};

// ---- 系统根（stones/standards——全局 role 查，在场复用）
const stonesRootId = ensureSystemDir(db, ownerId, null, 'stones', 'stones-root');
const standardsRootId = ensureSystemDir(db, ownerId, stonesRootId, 'standards', 'standards-root');

// ---- 阶段 1：原子导入（逐原子事务）
const relDirToKey = new Map<string, { supplier: string; sku: string }>(); // 组合 remap 键

for (const supplier of SUPPLIER_NAMES) {
  const supplierDir = path.join(STANDARDS_ROOT, supplier);
  if (!existsSync(supplierDir)) fail(`供应商目录缺失：${supplierDir}`);
  const atomDirs = walkAtomDirs(supplierDir);
  const sr: SupplierReport = {
    diskAtoms: atomDirs.length,
    diskTextures: 0,
    created: 0,
    pendingCreated: 0,
    skipped: 0,
    failed: 0,
    advisories: [],
    failures: [],
  };
  report.suppliers[supplier] = sr;

  let profile: SupplierSkuProfile;
  if (supplier === 'yuhang') {
    const existingDir = childRow(db, standardsRootId, 'yuhang', true);
    const metaParsed =
      existingDir !== undefined && existingDir.meta !== null
        ? (JSON.parse(existingDir.meta) as { skuProfile?: unknown })
        : {};
    const frozen = SupplierSkuProfileSchema.safeParse(
      metaParsed['skuProfile'] ?? {
        supplier: 'yuhang',
        displayName: '钰航',
        bands: [{ rows: [51, 78], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } }],
        styleKey: 'row',
      },
    );
    if (!frozen.success) fail(`yuhang 在场档案不符契约：${existingDir?.id ?? '（无目录）'}`);
    profile = frozen.data;
  } else {
    profile = NEW_SUPPLIER_PROFILES[supplier] as SupplierSkuProfile;
  }
  const supplierRowId = ensureSupplier(db, ownerId, standardsRootId, profile);

  const existsStmt = db.prepare('SELECT resource_id FROM stone_index WHERE supplier = ? AND sku = ?');

  for (const absDir of atomDirs) {
    const relDir = path.relative(STANDARDS_ROOT, absDir);
    let plan: AtomPlan;
    try {
      plan = planAtom(absDir, supplier, resolveTextureBytes(relDir));
      if (plan.textureBytes !== null) sr.diskTextures += 1;
    } catch (error) {
      sr.failed += 1;
      sr.failures.push({ sku: relDir, reason: `spike 解析失败：${String(error)}` });
      continue;
    }
    relDirToKey.set(plan.relDir, { supplier, sku: plan.sku });

    // 幂等前置：(supplier,sku) 在场跳过（含 8317 既有 yuhang/A52、J51）
    const existing = existsStmt.get(supplier, plan.sku) as { resource_id: string } | undefined;
    if (existing !== undefined) {
      sr.skipped += 1;
      report.preexistingSkips.push({ supplier, sku: plan.sku, resourceId: existing.resource_id });
      continue;
    }

    const importMetadata: Record<string, unknown> = {
      ...plan.spike.metadata,
      importSource: 'owner-stone-catalog-20260924',
      importScript: 'daemon/scripts/import-owner-stones.ts',
      spikeAtomId: plan.spike.id,
      spikeRelDir: plan.relDir,
      ...(plan.textureReencoded ? { textureReencoded: 'adam7→noninterlaced(PIL 恒等重编码，源隔行被 codec 拒收)' } : {}),
    };
    const advisories: string[] = [];

    try {
      const resourceId = db.transaction((): string => {
        const familyDirId = ensureChildDir(db, ownerId, supplierRowId, plan.family);
        const styleDirName = plan.skuParsed !== undefined ? `${plan.skuParsed.row}-${plan.styleName}` : plan.styleName;
        const styleDirId = ensureChildDir(db, ownerId, familyDirId, styleDirName);
        const atomDirId = insertDir(db, ownerId, styleDirId, uniqueChildName(db, styleDirId, plan.sku), {});

        if (plan.textureBytes === null) {
          // pending 原子：目录行 + 投影行（不建 stone.json/贴图行——契约硬要求贴图）
          const reason =
            typeof plan.spike.metadata['textureDroppedReason'] === 'string'
              ? plan.spike.metadata['textureDroppedReason']
              : typeof plan.spike.metadata['textureStatus'] === 'string'
                ? plan.spike.metadata['textureStatus']
                : 'no-texture';
          db.prepare(
            'INSERT INTO stone_index (resource_id, owner_id, supplier, sku, style_row, style_name, family, size_mm, color_hex, finish, trashed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
          ).run(
            atomDirId,
            ownerId,
            supplier,
            plan.sku,
            styleRowOf(plan),
            plan.styleName,
            plan.family,
            plan.spike.sizeMm,
            rgbToHex(plan.spike.color.rgb),
            plan.spike.color.texture,
            nowIso(),
          );
          db.prepare('UPDATE resources SET meta = ? WHERE id = ?').run(
            JSON.stringify({ ...importMetadata, kind: 'stone-pending', pending: true, pendingReason: reason }),
            atomDirId,
          );
          return atomDirId;
        }

        // 常规原子：解码实测（与 gate 同源算法；advisory 不拒收——44px 低清色卡是素材本身）
        const decoded = decodePng(plan.textureBytes);
        const bounds = alphaBoundsOf(decoded.width, decoded.height, decoded.rgba);
        if (bounds === null) throw new Error('贴图全透明（alpha 内容为空）');
        const majorPx = Math.max(bounds.w, bounds.h);
        if (majorPx < 64) advisories.push(`subject ${majorPx}px < 64px 下限（低清色卡素材——显式入库不拒）`);
        if (plan.textureBytes.byteLength > 2 * 1024 * 1024) advisories.push(`贴图 ${(plan.textureBytes.byteLength / 1048576).toFixed(2)}MB 超 2MB 约定`);
        const pxSize = plan.spike.metadata['pxSize'];
        if (
          Array.isArray(pxSize) &&
          pxSize.length === 2 &&
          (pxSize[0] !== decoded.width || pxSize[1] !== decoded.height)
        ) {
          advisories.push(`pxSize 声明 ${String(pxSize[0])}×${String(pxSize[1])} 与实测 ${decoded.width}×${decoded.height} 不符（以实测入库）`);
        }

        const stone: StoneFile = {
          kind: 'stone',
          formatVersion: 1,
          id: `stn-${randomUUID()}`,
          name: plan.spike.sizeMm !== null ? `${plan.styleName} · ${fmtMm(plan.spike.sizeMm)}mm` : `${plan.styleName} · 尺寸未声明`,
          supplier,
          sku: plan.sku,
          ...(plan.skuParsed !== undefined ? { skuParsed: plan.skuParsed } : {}),
          sizeMm: plan.spike.sizeMm,
          color: { name: plan.styleName, rgb: plan.spike.color.rgb, family: plan.family, finish: plan.spike.color.texture },
          texture: {
            file: TEXTURE_FILE_NAME,
            mime: 'image/png',
            width: decoded.width,
            height: decoded.height,
            alphaBounds: bounds,
          },
          shapeClass: plan.spike.shape,
          metadata: importMetadata,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        const parsedStone = StoneFileSchema.parse(stone); // 契约关口（读面依赖）
        const stoneBytes = Buffer.from(JSON.stringify(parsedStone), 'utf8');
        const stonePut = blobs.put(new Uint8Array(stoneBytes));
        insertFile(db, ownerId, atomDirId, STONE_JSON_NAME, stonePut.hash, stoneBytes.byteLength, { kind: 'stone' });
        const texturePut = blobs.put(plan.textureBytes);
        insertFile(db, ownerId, atomDirId, TEXTURE_FILE_NAME, texturePut.hash, plan.textureBytes.byteLength, { kind: 'stone-texture' });
        db.prepare(
          'INSERT INTO stone_index (resource_id, owner_id, supplier, sku, style_row, style_name, family, size_mm, color_hex, finish, trashed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
        ).run(
          atomDirId,
          ownerId,
          supplier,
          plan.sku,
          styleRowOf(plan),
          plan.styleName,
          plan.family,
          plan.spike.sizeMm,
          rgbToHex(plan.spike.color.rgb),
          plan.spike.color.texture,
          parsedStone.updatedAt,
        );
        return atomDirId;
      })();
      if (plan.textureBytes === null) sr.pendingCreated += 1;
      else sr.created += 1;
      sr.advisories.push(...advisories.map((a) => `${plan.sku}: ${a}`));
    } catch (error) {
      sr.failed += 1;
      sr.failures.push({ sku: plan.sku, reason: String(error instanceof Error ? error.message : error) });
    }
  }

  console.log(
    `[import-owner-stones] ${supplier}: disk=${sr.diskAtoms} created=${sr.created} pending=${sr.pendingCreated} skipped=${sr.skipped} failed=${sr.failed}`,
  );
}

// ---- 阶段 2：生产组合（路径 remap→resourceId）
{
  const setFile = path.join(OUTPUT_ROOT, 'stones', 'production-sets', 'customer-quanxi-202609', SET_JSON_NAME);
  if (!existsSync(setFile)) fail(`组合源缺失：${setFile}`);
  const spikeSet = readJson(setFile) as {
    id: string;
    name: string;
    purpose?: string;
    stones: Array<{ stoneRef: string; note?: string }>;
    metadata: Record<string, unknown>;
  };
  report.set.sourceMembers = spikeSet.stones.length;

  // 幂等：在场 set.json（meta.kind=stone-set 文件行）解析比对 metadata.sourceSetId
  const setFileRows = db
    .prepare("SELECT id, content_hash FROM resources WHERE is_dir = 0 AND meta LIKE '%\"kind\":\"stone-set\"%'")
    .all() as Array<{ id: string; content_hash: string | null }>;
  let existingSetDir: string | null = null;
  let existingSetId: string | null = null;
  for (const row of setFileRows) {
    if (row.content_hash === null) continue;
    const bytes = blobs.read(row.content_hash);
    if (bytes === null) continue;
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as { id: string; metadata?: { sourceSetId?: string } };
      if (parsed.metadata?.sourceSetId === spikeSet.id) {
        const fileRow = db.prepare('SELECT parent_id FROM resources WHERE id = ?').get(row.id) as
          | { parent_id: string }
          | undefined;
        existingSetDir = fileRow?.parent_id ?? null;
        existingSetId = parsed.id;
        break;
      }
    } catch {
      // 损坏行跳过
    }
  }

  if (existingSetDir !== null) {
    report.set.skipped = true;
    report.set.resourceId = existingSetDir;
    report.set.setId = existingSetId;
    console.log(`[import-owner-stones] 组合已在场跳过（resourceId=${existingSetDir}）`);
  } else {
    const members = spikeSet.stones.map((m) => {
      const rel = m.stoneRef.replace(/^stones\/standards\//, '');
      const key = relDirToKey.get(rel);
      if (key === undefined) throw new Error(`组合引用无原子：${m.stoneRef}`);
      const row = db
        .prepare('SELECT resource_id FROM stone_index WHERE supplier = ? AND sku = ?')
        .get(key.supplier, key.sku) as { resource_id: string } | undefined;
      if (row === undefined) throw new Error(`组合引用未落库：${m.stoneRef}（${key.supplier}/${key.sku}）`);
      return { stoneRef: row.resource_id, ...(m.note !== undefined ? { note: m.note } : {}) };
    });
    if (new Set(members.map((m) => m.stoneRef)).size !== members.length) fail('组合成员 stoneRef 重复（remap 后）');

    const now = nowIso();
    const file: ProductionSetFile = {
      kind: 'stone-set',
      formatVersion: 1,
      id: `set-${randomUUID()}`,
      name: spikeSet.name,
      ...(spikeSet.purpose !== undefined ? { purpose: spikeSet.purpose } : {}),
      stones: members,
      origin: { kind: 'manual-pick' },
      metadata: {
        ...spikeSet.metadata,
        sourceSetId: spikeSet.id,
        importSource: 'owner-stone-catalog-20260924',
        importScript: 'daemon/scripts/import-owner-stones.ts',
        refConvention: '离线预产包相对路径引用已于导入时 remap 为 resourceId（本行覆盖 spike 同名说明）',
      },
      createdAt: now,
      updatedAt: now,
    };
    const parsed = ProductionSetFileSchema.parse(file);

    const setDirId = db.transaction((): string => {
      const setsRoot = ensureSystemDir(db, ownerId, stonesRootId, 'production-sets', 'production-sets-root');
      const dirId = insertDir(db, ownerId, setsRoot, uniqueChildName(db, setsRoot, file.name), {});
      const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
      const put = blobs.put(new Uint8Array(bytes));
      insertFile(db, ownerId, dirId, SET_JSON_NAME, put.hash, bytes.byteLength, { kind: 'stone-set' });
      return dirId;
    })();
    report.set.resourceId = setDirId;
    report.set.setId = parsed.id;
    console.log(`[import-owner-stones] 组合建：${parsed.name}（${members.length} 引用，resourceId=${setDirId}）`);
  }

  // 成员闭合校验（全部 remap 键在场）
  if (report.set.resourceId !== null) {
    const fileRow = childRow(db, report.set.resourceId, SET_JSON_NAME, false);
    if (fileRow !== undefined && fileRow.content_hash !== null) {
      const bytes = blobs.read(fileRow.content_hash);
      if (bytes !== null) {
        const parsed = JSON.parse(bytes.toString('utf8')) as { stones: Array<{ stoneRef: string }> };
        for (const m of parsed.stones) {
          const hit = db.prepare('SELECT 1 FROM stone_index WHERE resource_id = ?').get(m.stoneRef);
          if (hit === undefined) report.set.memberClosureMissing.push(m.stoneRef);
        }
        report.set.remapped = parsed.stones.length;
      }
    }
  }
}

// ---- 阶段 3：来源档案归档（/owner-archives/stone-catalog-20260924/**）
{
  const archiveRoot = db.transaction(() => {
    const ownerArchives = ensureSystemDir(db, ownerId, null, 'owner-archives', 'owner-archives-root');
    return ensureChildDir(db, ownerId, ownerArchives, ARCHIVE_STEM);
  })();

  const archiveOne = (absFile: string, relName: string, stemDirName: string): void => {
    const parts = relName.split(path.sep);
    let dirId = db.transaction(() => ensureChildDir(db, ownerId, archiveRoot, stemDirName))();
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] as string;
      dirId = db.transaction(() => ensureChildDir(db, ownerId, dirId, seg))();
    }
    const name = parts[parts.length - 1] as string;
    const bytes = new Uint8Array(readFileSync(absFile));
    const hash = sha256Hex(bytes);
    const existing = childRow(db, dirId, name, false);
    if (existing !== undefined) {
      report.archives.skipped += 1;
      if (existing.content_hash !== hash) report.archives.hashMismatch.push(relName);
      return;
    }
    db.transaction(() => {
      const put = blobs.put(bytes);
      insertFile(db, ownerId, dirId, name, put.hash, bytes.byteLength, { kind: 'archive-file' });
    })();
    report.archives.created += 1;
  };

  // design-assets 全树
  const designAssetsRoot = path.join(OUTPUT_ROOT, 'design-assets');
  for (const rel of walkFiles(designAssetsRoot)) {
    archiveOne(path.join(designAssetsRoot, rel), rel, 'design-assets');
    report.archives.filesFound += 1;
  }
  // 来源档案四件套 + CSV + 页图 + 预览图
  for (const name of SOURCE_FILES) {
    const abs = path.join(SOURCE_ROOT, name);
    if (!existsSync(abs)) {
      report.archives.hashMismatch.push(`源缺失：${name}`);
      continue;
    }
    archiveOne(abs, name, 'sources');
    report.archives.filesFound += 1;
  }
  console.log(
    `[import-owner-stones] 归档：found=${report.archives.filesFound} created=${report.archives.created} skipped=${report.archives.skipped} mismatch=${report.archives.hashMismatch.length}`,
  );
}

// ---- 阶段 4：落库后校验 + 报告
{
  for (const supplier of SUPPLIER_NAMES) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM stone_index WHERE supplier = ?').get(supplier) as { n: number };
    report.verification.indexTotals[supplier] = row.n;
  }
  report.verification.pendingAtoms = (
    db.prepare("SELECT COUNT(*) AS n FROM resources WHERE is_dir = 1 AND meta LIKE '%\"kind\":\"stone-pending\"%'").get() as { n: number }
  ).n;

  // 抽查贴图：blob 可读 + 解码尺寸合理（跨库跨族定点取样）
  const samples = db
    .prepare(
      `SELECT si.supplier, si.sku, r.content_hash AS hash FROM stone_index si
       JOIN resources r ON r.parent_id = si.resource_id AND r.name = '贴图.png' AND r.is_dir = 0
       WHERE (si.supplier = 'tuzuan' AND si.sku IN ('1', 'SD20', 'PC-01-3'))
          OR (si.supplier = 'mofang' AND si.sku = '151')
          OR (si.supplier = 'yuhang' AND si.sku = 'B54')`,
    )
    .all() as Array<{ supplier: string; sku: string; hash: string }>;
  for (const s of samples) {
    const bytes = blobs.read(s.hash);
    if (bytes === null) {
      report.verification.textureBlobCheck.push({ sku: `${s.supplier}/${s.sku}`, ok: false, width: 0, height: 0, bytes: 0 });
      continue;
    }
    const decoded = decodePng(new Uint8Array(bytes));
    report.verification.textureBlobCheck.push({
      sku: `${s.supplier}/${s.sku}`,
      ok: decoded.width > 0 && decoded.height > 0,
      width: decoded.width,
      height: decoded.height,
      bytes: bytes.byteLength,
    });
  }
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
console.log(`[import-owner-stones] 报告=${REPORT_PATH}`);
const totalFailed = Object.values(report.suppliers).reduce((n, s) => n + s.failed, 0);
console.log(
  `[import-owner-stones] 完成：failed=${totalFailed} setMissing=${report.set.memberClosureMissing.length} archiveMismatch=${report.archives.hashMismatch.length}`,
);
if (totalFailed > 0 || report.set.memberClosureMissing.length > 0) process.exit(1);
