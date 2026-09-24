/**
 * stones service 单测（add-stone-library design §1.1/§1.2/§1.6——S1.2/S1.4/S1.5）。
 * 覆盖面：
 *   [1] seed 幂等（系统根 meta.role / 供应商目录 skuProfile 挂 meta）。
 *   [2] 四步同事务建原子（目录+stone.json+贴图+blob）+ path 派生 + 投影行。
 *   [3] supplier×sku 唯一 typed error / 同父名冲突 ` (2)` / gate 拒收零落库（原子性）。
 *   [4] patch→revision+1 CAS（漂移必拒）/ 贴图替换内容寻址 / 色系重指同事务移目录。
 *   [5] 软删递归盖戳+级联原子可见性 / 恢复 / 硬删回收站语义 + blob ref_count GC
 *       （共享贴图跨原子只存一份——去重与归零置 deleting）。
 *   [6] 引用解析四态 resolved/soft-deleted/blob-missing/wrong-kind（照 gem-catalog
 *       design §四 P0-2 面 7 先例）+ not-found（硬清后形态）。
 *   [7] stone_index 同事务一致性（create/update/重指/软删/恢复 五路径写后即查）
 *       + 投影可重建（resources+blob 全量重建逐行等价——§1.5 的验证项）。
 */
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  rgbToHex,
  StoneFileSchema,
  SupplierSkuProfileSchema,
  type RgbTuple,
  type SupplierSkuProfile,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { StoneTextureGateError } from '../src/stones/gates.js';
import {
  StoneService,
  StoneServiceError,
  type CreateStoneInput,
  type GetStoneResult,
  type StoneIndexRow,
} from '../src/stones/service.js';
import { createServices, type TestServices } from './helpers.js';

const active: TestServices[] = [];
function setup(): { svc: TestServices; stones: StoneService; ownerId: string } {
  const svc = createServices();
  active.push(svc);
  return { svc, stones: new StoneService({ db: svc.db, blobs: svc.blobs }), ownerId: svc.anonymous.id };
}
afterEach(() => {
  for (const s of active.splice(0)) s.dispose();
});

/** 钰航档案（card-text.txt 三行段实证——§2 行段漂移）。 */
const YUHANG: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [
    { rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
    { rows: [76, 78], sizeMmByPrefix: { J: 12, A: 14, B: 16, C: 18, E: 20, F: 22, G: 25 } },
    { rows: [80, 89], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
  ],
  styleKey: 'row',
});

const FACTORY_B: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'factoryB',
  displayName: '乙厂',
  bands: [{ rows: [1, 99], sizeMmByPrefix: { J: 2, A: 3 } }],
  styleKey: 'row',
});

/** 128×128 画布 96px 圆主体（alphaBounds {16,16,96,96}——与 gates fixture 同推导）。 */
function textureBytes(): Uint8Array {
  const size = 128;
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= r * r) {
        const p = (y * size + x) * 4;
        rgba[p] = 240;
        rgba[p + 1] = 240;
        rgba[p + 2] = 232;
        rgba[p + 3] = 255;
      }
    }
  }
  return new Uint8Array(encodePng(size, size, rgba));
}

interface DraftOverrides {
  sku?: string;
  name?: string;
  family?: string;
  colorName?: string;
  rgb?: RgbTuple;
  sizeMm?: number | null;
  supplierProfile?: SupplierSkuProfile;
  shapeClass?: string;
}

function createInput(overrides: DraftOverrides = {}): CreateStoneInput {
  const colorName = overrides.colorName ?? '象牙白';
  return {
    ownerId: '',
    supplierProfile: overrides.supplierProfile ?? YUHANG,
    draft: {
      name: overrides.name ?? `${colorName} · 2mm`,
      sku: overrides.sku ?? 'J51',
      // null 是显式语义（无尺寸声明）——不能用 ?? 兜底（会吞掉 null）
      sizeMm: overrides.sizeMm === undefined ? 2 : overrides.sizeMm,
      color: {
        name: colorName,
        rgb: overrides.rgb ?? [240, 240, 232],
        family: overrides.family ?? '白色系',
        finish: 'glossy',
      },
      ...(overrides.shapeClass !== undefined ? { shapeClass: overrides.shapeClass } : {}),
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: textureBytes(),
  };
}

function make(overrides: DraftOverrides, ownerId: string): CreateStoneInput {
  return { ...createInput(overrides), ownerId };
}

function expectServiceError(fn: () => unknown, code: string): StoneServiceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StoneServiceError);
    const typed = error as StoneServiceError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`期望 StoneServiceError（code=${code}）但通过了`);
}

function countOf(svc: TestServices, table: 'resources' | 'blobs' | 'stone_index'): number {
  return (svc.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function dirIdByName(svc: TestServices, name: string): string {
  const row = svc.db
    .prepare('SELECT id FROM resources WHERE name = ? AND is_dir = 1')
    .get(name) as { id: string } | undefined;
  if (row === undefined) throw new Error(`目录不存在：${name}`);
  return row.id;
}

/** 投影行 ↔ stone.json 等价断言（S1.5 写后即查的统一判据——逐列对账）。 */
function expectIndexMatchesStone(row: StoneIndexRow | null, got: GetStoneResult, trashed: boolean): void {
  expect(row).not.toBeNull();
  if (row === null) return;
  expect(row.resource_id).toBe(got.resourceId);
  expect(row.supplier).toBe(got.stone.supplier);
  expect(row.sku).toBe(got.stone.sku);
  expect(row.style_row).toBe(got.stone.skuParsed?.row ?? null);
  expect(row.style_name).toBe(got.stone.color.name);
  expect(row.family).toBe(got.stone.color.family);
  expect(row.size_mm).toBe(got.stone.sizeMm);
  expect(row.color_hex).toBe(rgbToHex(got.stone.color.rgb));
  expect(row.finish).toBe(got.stone.color.finish);
  expect(row.trashed).toBe(trashed ? 1 : 0);
  expect(row.updated_at).toBe(got.stone.updatedAt);
}

describe('S1.2 seed 幂等', () => {
  it('系统根：二次调用同 id（幂等）+ role 标记 + standards 挂 stones 下', () => {
    const { svc, stones, ownerId } = setup();
    const first = stones.ensureRoots(ownerId);
    expect(stones.ensureRoots(ownerId)).toEqual(first);
    const root = svc.db.prepare('SELECT * FROM resources WHERE id = ?').get(first.stonesRootId) as {
      parent_id: string | null;
      name: string;
      meta: string | null;
      is_dir: number;
    };
    expect(root.parent_id).toBeNull();
    expect(root.name).toBe('stones');
    expect(root.is_dir).toBe(1);
    expect(JSON.parse(root.meta ?? '{}')).toEqual({ role: 'stones-root' });
    const standards = svc.db.prepare('SELECT * FROM resources WHERE id = ?').get(first.standardsRootId) as {
      parent_id: string;
      name: string;
      meta: string | null;
    };
    expect(standards.parent_id).toBe(first.stonesRootId);
    expect(standards.name).toBe('standards');
    expect(JSON.parse(standards.meta ?? '{}')).toEqual({ role: 'standards-root' });
  });

  it('供应商目录：幂等同 id；meta.skuProfile 挂 meta（档案往返）；异供应商异目录', () => {
    const { svc, stones, ownerId } = setup();
    const a = stones.ensureSupplier(ownerId, YUHANG);
    expect(stones.ensureSupplier(ownerId, YUHANG)).toBe(a);
    const row = svc.db.prepare('SELECT * FROM resources WHERE id = ?').get(a) as {
      name: string;
      meta: string | null;
      parent_id: string;
    };
    expect(row.name).toBe('yuhang');
    const meta = JSON.parse(row.meta ?? '{}') as { role?: string; skuProfile?: SupplierSkuProfile };
    expect(meta.role).toBe('supplier');
    expect(SupplierSkuProfileSchema.parse(meta.skuProfile)).toEqual(YUHANG);
    const { standardsRootId } = stones.ensureRoots(ownerId);
    expect(row.parent_id).toBe(standardsRootId);
    expect(stones.ensureSupplier(ownerId, FACTORY_B)).not.toBe(a);
  });
});

describe('S1.2 createStone 四步同事务', () => {
  it('绿：目录行+stone.json+贴图.png+blob 四件齐 + path 派生 + skuParsed 物化 + alphaBounds 实测', () => {
    const { svc, stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    expect(created.revision).toBe(1);
    expect(created.path).toBe('/stones/standards/yuhang/白色系/51-象牙白/J51');
    const children = svc.db
      .prepare('SELECT name, is_dir, meta FROM resources WHERE parent_id = ? ORDER BY name')
      .all(created.resourceId) as { name: string; is_dir: number; meta: string | null }[];
    expect(children.map((c) => c.name)).toEqual(['stone.json', '贴图.png']);
    const jsonMeta = JSON.parse(children[0]!.meta ?? '{}');
    const texMeta = JSON.parse(children[1]!.meta ?? '{}');
    expect(jsonMeta).toEqual({ kind: 'stone' });
    expect(texMeta).toEqual({ kind: 'stone-texture' });
    for (const hash of [created.stoneJsonBlobRef, created.textureBlobRef]) {
      const blob = svc.db.prepare('SELECT ref_count, status FROM blobs WHERE hash = ?').get(hash) as {
        ref_count: number;
        status: string;
      };
      expect(blob).toEqual({ ref_count: 1, status: 'active' });
    }
    const json = svc.blobs.read(created.stoneJsonBlobRef)!;
    const stone = StoneFileSchema.parse(JSON.parse(json.toString('utf8')));
    expect(stone.id).toBe(created.stoneId);
    expect(stone.supplier).toBe('yuhang');
    expect(stone.skuParsed).toEqual({ row: 51, prefix: 'J', sizeMm: 2 });
    expect(stone.texture.alphaBounds).toEqual({ x: 16, y: 16, w: 96, h: 96 });
    expect(stone.texture.width).toBe(128);
  });

  it('绿：同款式行变体共目录（A51 与 J51 同父）；行段漂移（J76→12mm）独立款式行', () => {
    const { stones, ownerId } = setup();
    stones.createStone(make({}, ownerId));
    const a51 = stones.createStone(make({ sku: 'A51', name: '象牙白 · 3mm', sizeMm: 3 }, ownerId));
    expect(a51.path).toBe('/stones/standards/yuhang/白色系/51-象牙白/A51');
    const j76 = stones.createStone(make({ sku: 'J76', colorName: '古铜金', family: '大径行', sizeMm: 12 }, ownerId));
    expect(j76.path).toBe('/stones/standards/yuhang/大径行/76-古铜金/J76');
  });

  it('红：supplier×sku 撞 UNIQUE → typed sku-conflict 定位既有条目；跨供应商同 sku 放行', () => {
    const { stones, ownerId } = setup();
    const first = stones.createStone(make({}, ownerId));
    const error = expectServiceError(() => stones.createStone(make({}, ownerId)), 'sku-conflict');
    expect(error.detail.existingResourceId).toBe(first.resourceId);
    const cross = stones.createStone(make({ supplierProfile: FACTORY_B }, ownerId));
    expect(cross.path).toBe('/stones/standards/factoryB/白色系/51-象牙白/J51');
  });

  it('红：冲突事务原子回滚——失败建库后零残留行/零残留 blob 引用', () => {
    const { svc, stones, ownerId } = setup();
    stones.createStone(make({}, ownerId));
    const resourcesBefore = countOf(svc, 'resources');
    const blobsBefore = countOf(svc, 'blobs');
    expectServiceError(() => stones.createStone(make({}, ownerId)), 'sku-conflict');
    expect(countOf(svc, 'resources')).toBe(resourcesBefore);
    expect(countOf(svc, 'blobs')).toBe(blobsBefore);
  });

  it('红：gate 拒收在事务前——全透明贴图/缺贴图 typed 拒且零落库', () => {
    const { svc, stones, ownerId } = setup();
    const blankInput = make({}, ownerId);
    blankInput.textureBytes = new Uint8Array(encodePng(128, 128, new Uint8Array(128 * 128 * 4)));
    try {
      stones.createStone(blankInput);
      expect.unreachable('gate 3 应拒全透明');
    } catch (error) {
      expect(error).toBeInstanceOf(StoneTextureGateError);
    }
    const missing = make({}, ownerId);
    missing.textureBytes = new Uint8Array(0);
    expectServiceError(() => stones.createStone(missing), 'texture-missing');
    expect(countOf(svc, 'resources')).toBe(0);
    expect(countOf(svc, 'stone_index')).toBe(0);
  });

  it('绿：同父名冲突自动 ` (2)`（手工占位 J51 目录在场——混管树语义）', () => {
    const { svc, stones, ownerId } = setup();
    const supplierDir = stones.ensureSupplier(ownerId, YUHANG);
    const now = new Date().toISOString();
    const mkDir = (parentId: string, name: string): string => {
      const id = randomUUID();
      svc.db
        .prepare(
          "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
        )
        .run(id, ownerId, parentId, name, now, now);
      return id;
    };
    const family = mkDir(supplierDir, '白色系');
    const style = mkDir(family, '51-象牙白');
    mkDir(style, 'J51');
    const created = stones.createStone(make({}, ownerId));
    expect(created.path).toBe('/stones/standards/yuhang/白色系/51-象牙白/J51 (2)');
  });
});

describe('S1.2 updateStone（patch + CAS）', () => {
  it('绿：字段级 patch→revision+1 + stone.json 新 blob + 旧引用释放', () => {
    const { svc, stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    const oldJsonHash = created.stoneJsonBlobRef;
    const updated = stones.updateStone(
      created.resourceId,
      { name: '象牙白 · 2mm（改）', color: { finish: 'matte' }, metadata: { batch: 'B-09' } },
      { baseRevision: 1 },
    );
    expect(updated.revision).toBe(2);
    const got = stones.getStone(created.resourceId);
    expect(got.stone.name).toBe('象牙白 · 2mm（改）');
    expect(got.stone.color.finish).toBe('matte');
    expect(got.stone.metadata).toEqual({ batch: 'B-09' });
    expect(got.revision).toBe(2);
    expect(svc.blobs.rowOf(oldJsonHash)).toBeNull(); // 归零→deleting（active 面消失）
    expect(svc.blobs.read(oldJsonHash)).toBeNull();
  });

  it('红：CAS 漂移必拒（baseRevision 落后）——currentRevision 明示；正确基线放行', () => {
    const { stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    stones.updateStone(created.resourceId, { name: '第一改' }, { baseRevision: 1 });
    const error = expectServiceError(
      () => stones.updateStone(created.resourceId, { name: '第二改' }, { baseRevision: 1 }),
      'revision-conflict',
    );
    expect(error.detail).toMatchObject({ currentRevision: 2, baseRevision: 1 });
    expect(stones.updateStone(created.resourceId, { name: '第二改' }, { baseRevision: 2 }).revision).toBe(3);
  });

  it('绿：贴图替换=新内容新 hash、id 不变；实测宽高/alphaBounds 随新图重算', () => {
    const { svc, stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    const oldTextureHash = created.textureBlobRef;
    const size = 96;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - (size - 1) / 2;
        const dy = y - (size - 1) / 2;
        if (dx * dx + dy * dy <= 32 * 32) {
          const p = (y * size + x) * 4;
          rgba[p] = 200;
          rgba[p + 1] = 16;
          rgba[p + 2] = 46;
          rgba[p + 3] = 255;
        }
      }
    }
    stones.updateStone(
      created.resourceId,
      { texture: { bytes: new Uint8Array(encodePng(size, size, rgba)), declaredWidth: 96, declaredHeight: 96 } },
      { baseRevision: 1 },
    );
    const got = stones.getStone(created.resourceId);
    expect(got.resourceId).toBe(created.resourceId);
    expect(got.texture.width).toBe(96);
    expect(got.stone.texture.alphaBounds).toEqual({ x: 16, y: 16, w: 64, h: 64 });
    expect(got.texture.blobRef).not.toBe(oldTextureHash);
    expect(svc.blobs.rowOf(oldTextureHash)).toBeNull();
  });

  it('绿：色系重指=同事务移目录+投影 family 更新（path 派生量随动）', () => {
    const { stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    const updated = stones.updateStone(created.resourceId, { color: { family: '红色系' } }, { baseRevision: 1 });
    expect(updated.path).toBe('/stones/standards/yuhang/红色系/51-象牙白/J51');
    expect(stones.getStone(created.resourceId).stone.color.family).toBe('红色系');
    expect(stones.indexRowOf(created.resourceId)?.family).toBe('红色系');
  });
});

describe('S1.4 软删/恢复/硬删/引用保护', () => {
  it('软删：子树三行全盖 trashedAt + 投影 trashed=1 + 解析 soft-deleted；恢复全还原', () => {
    const { svc, stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    const { trashedRows, trashedStones } = stones.softDelete(created.resourceId);
    expect(trashedRows).toBe(3);
    expect(trashedStones).toBe(1);
    const stamped = svc.db
      .prepare("SELECT COUNT(*) AS n FROM resources WHERE meta LIKE '%\"trashedAt\"%'")
      .get() as { n: number };
    expect(stamped.n).toBe(3);
    expect(stones.indexRowOf(created.resourceId)?.trashed).toBe(1);
    expect(stones.resolveStoneRef(created.resourceId).state).toBe('soft-deleted');
    expect(stones.restore(created.resourceId).restoredStones).toBe(1);
    expect(stones.indexRowOf(created.resourceId)?.trashed).toBe(0);
    expect(stones.resolveStoneRef(created.resourceId).state).toBe('resolved');
  });

  it('级联原子可见性：软删色系目录→成员钻全 trashed；单钻恢复不越级；恢复目录全还原', () => {
    const { svc, stones, ownerId } = setup();
    const j = stones.createStone(make({}, ownerId));
    const a = stones.createStone(make({ sku: 'A51', sizeMm: 3 }, ownerId));
    const familyDirId = dirIdByName(svc, '白色系');
    stones.softDelete(familyDirId);
    expect(stones.resolveStoneRef(j.resourceId).state).toBe('soft-deleted');
    expect(stones.resolveStoneRef(a.resourceId).state).toBe('soft-deleted');
    expect(stones.indexRowOf(j.resourceId)?.trashed).toBe(1);
    expect(stones.indexRowOf(a.resourceId)?.trashed).toBe(1);
    // 单钻恢复：祖先（色系目录）仍盖戳——级联可见性不变
    stones.restore(j.resourceId);
    expect(stones.indexRowOf(j.resourceId)?.trashed).toBe(1);
    expect(stones.resolveStoneRef(j.resourceId).state).toBe('soft-deleted');
    // 恢复目录：全还原
    stones.restore(familyDirId);
    expect(stones.indexRowOf(j.resourceId)?.trashed).toBe(0);
    expect(stones.indexRowOf(a.resourceId)?.trashed).toBe(0);
    expect(stones.resolveStoneRef(a.resourceId).state).toBe('resolved');
  });

  it('系统目录禁删：stones 根/standards 根/供应商目录 softDelete 必拒', () => {
    const { stones, ownerId } = setup();
    const roots = stones.ensureRoots(ownerId);
    const supplierDir = stones.ensureSupplier(ownerId, YUHANG);
    expectServiceError(() => stones.softDelete(roots.stonesRootId), 'system-dir-protected');
    expectServiceError(() => stones.softDelete(roots.standardsRootId), 'system-dir-protected');
    expectServiceError(() => stones.softDelete(supplierDir), 'system-dir-protected');
  });

  it('硬删：仅回收站内可硬删；行/投影清除 + blob ref_count GC（共享贴图去重不误删）', () => {
    const { svc, stones, ownerId } = setup();
    const j = stones.createStone(make({}, ownerId));
    const g = stones.createStone(make({ sku: 'G51', sizeMm: 10 }, ownerId));
    expect(g.textureBlobRef).toBe(j.textureBlobRef); // 同字节贴图内容寻址去重
    const sharedHash = j.textureBlobRef;
    expect(
      (svc.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(sharedHash) as { ref_count: number }).ref_count,
    ).toBe(2);
    expectServiceError(() => stones.hardDelete(j.resourceId), 'not-trashed');
    stones.softDelete(j.resourceId);
    const { deletedRows, releasedBlobRefs } = stones.hardDelete(j.resourceId);
    expect(deletedRows).toBe(3);
    expect(releasedBlobRefs).toHaveLength(2);
    expect(
      svc.db.prepare('SELECT ref_count, status FROM blobs WHERE hash = ?').get(sharedHash),
    ).toEqual({ ref_count: 1, status: 'active' }); // 共享 ref 2→1
    expect(stones.resolveStoneRef(j.resourceId).state).toBe('not-found');
    expect(stones.indexRowOf(j.resourceId)).toBeNull();
    stones.softDelete(g.resourceId);
    stones.hardDelete(g.resourceId);
    expect(
      svc.db.prepare('SELECT ref_count, status FROM blobs WHERE hash = ?').get(sharedHash),
    ).toEqual({ ref_count: 0, status: 'deleting' }); // 归零置 deleting（物理删走 outbox）
  });

  it('引用解析四态：resolved/soft-deleted/blob-missing/wrong-kind + not-found', () => {
    const { svc, stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    expect(stones.resolveStoneRef(created.resourceId).state).toBe('resolved');
    stones.softDelete(created.resourceId);
    expect(stones.resolveStoneRef(created.resourceId).state).toBe('soft-deleted');
    stones.restore(created.resourceId);
    rmSync(svc.blobs.pathFor(created.textureBlobRef)!); // 贴图实体亡（行在字节亡）
    expect(stones.resolveStoneRef(created.resourceId).state).toBe('blob-missing');
    rmSync(svc.blobs.pathFor(created.stoneJsonBlobRef)!); // json 实体亡（同态）
    expect(stones.resolveStoneRef(created.resourceId).state).toBe('blob-missing');
    const supplierDir = stones.ensureSupplier(ownerId, YUHANG);
    expect(stones.resolveStoneRef(supplierDir).state).toBe('wrong-kind');
    const { stonesRootId } = stones.ensureRoots(ownerId);
    expect(stones.resolveStoneRef(stonesRootId).state).toBe('wrong-kind');
    expect(stones.resolveStoneRef(randomUUID()).state).toBe('not-found');
  });
});

describe('S1.5 stone_index 同事务一致性（五路径写后即查）', () => {
  it('create → 投影行与 stone.json 等价', () => {
    const { stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    expect(created).toBeDefined();
    expectIndexMatchesStone(stones.indexRowOf(created.resourceId), stones.getStone(created.resourceId), false);
  });

  it('update → sizeMm/finish/updatedAt 全列跟随', () => {
    const { stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    stones.updateStone(created.resourceId, { sizeMm: 2.4, color: { finish: 'pearl' }, name: '改名' }, { baseRevision: 1 });
    const got = stones.getStone(created.resourceId);
    expectIndexMatchesStone(stones.indexRowOf(created.resourceId), got, false);
    expect(stones.indexRowOf(created.resourceId)?.size_mm).toBe(2.4);
  });

  it('色系重指 → family 列随移', () => {
    const { stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    stones.updateStone(created.resourceId, { color: { family: '红色系' } }, { baseRevision: 1 });
    expectIndexMatchesStone(stones.indexRowOf(created.resourceId), stones.getStone(created.resourceId), false);
    expect(stones.indexRowOf(created.resourceId)?.family).toBe('红色系');
  });

  it('软删 → trashed=1；恢复 → trashed=0', () => {
    const { stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    stones.softDelete(created.resourceId);
    expect(stones.indexRowOf(created.resourceId)?.trashed).toBe(1);
    stones.restore(created.resourceId);
    expectIndexMatchesStone(stones.indexRowOf(created.resourceId), stones.getStone(created.resourceId), false);
  });
});

describe('S1.1/S1.5 投影可重建（resources+blob 全量重建逐行等价）', () => {
  it('多钻（跨供应商/含软删/含无尺寸）全量重建=逐行等价', () => {
    const { svc, stones, ownerId } = setup();
    const j51 = stones.createStone(make({}, ownerId));
    stones.createStone(make({ sku: 'J76', colorName: '古铜金', family: '大径行', sizeMm: 12 }, ownerId));
    stones.createStone(make({ sku: 'H042', colorName: '魔方白', family: '魔方', sizeMm: null }, ownerId));
    stones.createStone(make({ supplierProfile: FACTORY_B }, ownerId));
    stones.softDelete(j51.resourceId); // 含软删行
    const before = stones.listIndexRows();
    expect(before).toHaveLength(4);
    expect(before.find((r) => r.sku === 'H042')?.size_mm).toBeNull(); // 无尺寸显式 null
    svc.db.prepare('DELETE FROM stone_index').run();
    expect(stones.listIndexRows()).toHaveLength(0);
    const { rebuilt, skipped } = stones.rebuildStoneIndex();
    expect(rebuilt).toBe(4);
    expect(skipped).toBe(0);
    expect(stones.listIndexRows()).toEqual(before); // 逐行等价
  });

  it('真源损坏行显式跳过（不放大损坏）；健康行照常重建', () => {
    const { svc, stones, ownerId } = setup();
    const a = stones.createStone(make({}, ownerId));
    const c = stones.createStone(make({ sku: 'C51', sizeMm: 5 }, ownerId));
    rmSync(svc.blobs.pathFor(c.textureBlobRef)!); // 贴图实体亡——投影列全来自 json，重建不受影响
    const before = stones.listIndexRows();
    svc.db.prepare('DELETE FROM stone_index').run();
    expect(stones.rebuildStoneIndex()).toEqual({ rebuilt: 2, skipped: 0 });
    expect(stones.listIndexRows()).toEqual(before);
    rmSync(svc.blobs.pathFor(a.stoneJsonBlobRef)!); // json 实体亡=真源不可读→显式跳过
    svc.db.prepare('DELETE FROM stone_index').run();
    expect(stones.rebuildStoneIndex()).toEqual({ rebuilt: 1, skipped: 1 });
  });
});

// ---------------------------------------------------------------- P2-5 subtreeIds 环防御

describe('P2-5 软删面递归 CTE 环防御：直改 DB 造环 → typed depth-limit 拒（不挂起）', () => {
  it('原子目录 parent 指向子 stone.json 行成环 → softDelete depth-limit（有界返回）', () => {
    const { svc, stones, ownerId } = setup();
    const created = stones.createStone(make({}, ownerId));
    // 直改 DB 造环：原子目录.parent ← 子 stone.json 行（子指父→父指子成环；
    // services 写路径不产生环）。CTE 锚=原子目录（根注入）→经 json 行回到锚→发散
    // →depth 上限截断后显式 typed 拒，事务回滚零盖戳。
    const jsonRow = svc.db
      .prepare('SELECT id FROM resources WHERE parent_id = ? AND name = ?')
      .get(created.resourceId, 'stone.json') as { id: string };
    svc.db.prepare('UPDATE resources SET parent_id = ? WHERE id = ?').run(jsonRow.id, created.resourceId);
    const err = expectServiceError(() => stones.softDelete(created.resourceId), 'depth-limit');
    expect(err.message).toContain('深度超过上限');
    // 零盖戳（事务回滚——原子目录与子行均无 trashedAt）。
    const stamped = svc.db
      .prepare("SELECT COUNT(*) AS n FROM resources WHERE meta LIKE '%\"trashedAt\"%'")
      .get() as { n: number };
    expect(stamped.n).toBe(0);
  });
});
