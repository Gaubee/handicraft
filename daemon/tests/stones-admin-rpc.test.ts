/**
 * stones.trash/restore/importRun RPC 协议测试（S3.3 占位升级——人工直发写面，
 * design §4.2 管理视图收尾）。覆盖：
 *   [1] trash：owner 软删（递归盖戳走 S1 既有服务函数）→ list 默认过滤/
 *       includeTrashed 复现；系统目录禁删 typed system-dir-protected。
 *   [2] restore：恢复语义（清戳+祖先链重算——部分恢复的级联语义：祖先仍盖戳
 *       则子树保持不可见）；恢复后 list 复现。
 *   [3] owner 隔离（D-1 写面）：B trash/restore/importRun A 的原子 FORBIDDEN；
 *       admin 豁免；未认证 401；disabled 写拒（禁写不禁读）。
 *   [4] importRun：人工直发执行导入——sourcePages blob 映射直调 S2 runCardImport
 *       （操作者即批准人，审计 owner=当前用户）；返回六字段+report 全文；
 *       幂等重跑（复用 S2 supplier×sku 跳过）；坏 blob 映射/空 targetSupplier
 *       typed 拒。
 * 数据经 StoneService 直建（读面已验收——本文件只测写面协议与隔离）。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { SupplierSkuProfileSchema, type CardCatalogDraft, type RgbTuple, type SupplierSkuProfile } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { StoneService } from '../src/stones/service.js';
import type { CardImportReport } from '../src/stones/importer.js';
import { createUser } from '../src/db/store.js';
import { clientFor, createServices, type TestServices } from './helpers.js';
import { buildStandardYuhangFixture } from './stones-import-fixture.js';

// ---------------------------------------------------------------- fixtures

const YUHANG: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [
    { rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
    { rows: [76, 78], sizeMmByPrefix: { J: 12, A: 14, B: 16, C: 18, E: 20, F: 22, G: 25 } },
  ],
  styleKey: 'row',
});

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

function seedAtom(
  s: TestServices,
  ownerId: string,
  overrides: { sku?: string; family?: string } = {},
): string {
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  return stones.createStone({
    ownerId,
    supplierProfile: YUHANG,
    draft: {
      name: '象牙白 · 2mm',
      sku: overrides.sku ?? 'J51',
      sizeMm: 2,
      color: {
        name: '象牙白',
        rgb: [240, 240, 232] as RgbTuple,
        family: overrides.family ?? '白色系',
        finish: 'glossy',
      },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: textureBytes(),
  }).resourceId;
}

async function expectOrpcError(promise: Promise<unknown>, code: string): Promise<ORPCError<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    const typed = error as ORPCError<string, unknown>;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}

// ---------------------------------------------------------------- [1] trash

describe('stones.trash：软删（S1 递归盖戳服务面直发）', () => {
  it('owner 软删 → list 默认过滤+includeTrashed 复现 trashed；get 四态 soft-deleted', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const trashed = await client.stones.trash({ resourceId: atom });
      expect(trashed.trashedRows).toBe(3); // 原子目录+stone.json+贴图 三行
      expect(trashed.trashedStones).toBe(1);
      expect((await client.stones.list({})).total).toBe(0);
      const kept = await client.stones.list({ includeTrashed: true });
      expect(kept.total).toBe(1);
      expect(kept.cells[0]).toMatchObject({ trashed: true });
      expect((await client.stones.get({ resourceId: atom })).state).toBe('soft-deleted');
    } finally {
      s.dispose();
    }
  });

  it('系统目录禁删：standards 根 → BAD_REQUEST data.code=system-dir-protected', async () => {
    const s = createServices();
    try {
      seedAtom(s, s.anonymous.id);
      const standardsRoot = (
        s.db.prepare("SELECT id FROM resources WHERE meta LIKE '%\"role\":\"standards-root\"%'").get() as { id: string }
      ).id;
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const err = await expectOrpcError(client.stones.trash({ resourceId: standardsRoot }), 'BAD_REQUEST');
      expect((err.data as { code?: string }).code).toBe('system-dir-protected');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] restore

describe('stones.restore：恢复语义（清戳+祖先链重算）', () => {
  it('原子软删→恢复：list 复现+get resolved', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      await client.stones.trash({ resourceId: atom });
      const restored = await client.stones.restore({ resourceId: atom });
      expect(restored.restoredRows).toBe(3);
      expect(restored.restoredStones).toBe(1);
      expect((await client.stones.list({})).total).toBe(1);
      expect((await client.stones.get({ resourceId: atom })).state).toBe('resolved');
    } finally {
      s.dispose();
    }
  });

  it('色系目录递归软删→原子部分恢复仍不可见（祖先盖戳级联）；恢复目录后整枝复现', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const familyDir = (
        s.db.prepare("SELECT id FROM resources WHERE name = '白色系' AND is_dir = 1").get() as { id: string }
      ).id;
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      await client.stones.trash({ resourceId: familyDir });
      expect((await client.stones.list({})).total).toBe(0);
      // 部分恢复：只恢复原子目录——祖先（色系）仍盖戳 → effectiveTrashed 保持不可见。
      await client.stones.restore({ resourceId: atom });
      expect((await client.stones.list({})).total).toBe(0);
      expect((await client.stones.get({ resourceId: atom })).state).toBe('soft-deleted');
      // 恢复盖戳祖先目录 → 整枝复现（投影按祖先链重算）。
      await client.stones.restore({ resourceId: familyDir });
      expect((await client.stones.list({})).total).toBe(1);
      expect((await client.stones.get({ resourceId: atom })).state).toBe('resolved');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] owner 隔离+认证面

describe('stones 写面 owner 隔离与认证（D-1：共享读不变，写按 resources.owner_id）', () => {
  it('B trash/restore A 的原子 FORBIDDEN；admin 豁免；B 软删自己的照常', async () => {
    const s = createServices();
    try {
      const atomOfA = seedAtom(s, s.anonymous.id);
      const userB = createUser(s.db, { username: 'stones-admin-b', passwordHash: 'x', role: 'user' });
      const admin = createUser(s.db, { username: 'stones-admin-admin', passwordHash: 'x', role: 'admin' });
      const clientA = clientFor(s.context({ token: await s.tokenFor() }));
      const clientB = clientFor(s.context({ token: await s.tokenFor(userB) }));
      const clientAdmin = clientFor(s.context({ token: await s.tokenFor(admin) }));
      // B 动 A 的原子必拒（trash/restore）。
      await expectOrpcError(clientB.stones.trash({ resourceId: atomOfA }), 'FORBIDDEN');
      await expectOrpcError(clientB.stones.restore({ resourceId: atomOfA }), 'FORBIDDEN');
      // B 读共享照常（评审 D-1 读面不变锚）。
      expect((await clientB.stones.list({})).total).toBe(1);
      // admin 豁免（照 jobs requireOwnedTask）。
      await clientAdmin.stones.trash({ resourceId: atomOfA });
      await clientAdmin.stones.restore({ resourceId: atomOfA });
      expect((await clientA.stones.list({})).total).toBe(1);
      // 不存在 → BAD_REQUEST。
      await expectOrpcError(clientA.stones.trash({ resourceId: 'no-such-id' }), 'BAD_REQUEST');
    } finally {
      s.dispose();
    }
  });

  it('未认证 401；disabled 用户写拒（禁写不禁读）', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const anonymous = clientFor(s.context());
      await expectOrpcError(anonymous.stones.trash({ resourceId: atom }), 'UNAUTHORIZED');
      await expectOrpcError(anonymous.stones.restore({ resourceId: atom }), 'UNAUTHORIZED');
      await expectOrpcError(anonymous.stones.importRun({ draft: {} as CardCatalogDraft, options: { targetSupplier: 'x' } }), 'UNAUTHORIZED');
      const disabled = createUser(s.db, { username: 'stones-admin-disabled', passwordHash: 'x', role: 'user' });
      s.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(disabled.id);
      const disabledClient = clientFor(s.context({ token: await s.tokenFor(disabled) }));
      expect((await disabledClient.stones.list({})).total).toBe(1); // 读可
      await expectOrpcError(disabledClient.stones.trash({ resourceId: atom }), 'FORBIDDEN');
      await expectOrpcError(
        disabledClient.stones.importRun({ draft: {} as CardCatalogDraft, options: { targetSupplier: 'x' } }),
        'FORBIDDEN',
      );
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] importRun

describe('stones.importRun：人工直发执行导入（操作者即批准人）', () => {
  /** 钰航 fixture → sourcePages blob 映射（blobs.put 模拟 assets.upload 入库）。 */
  function fixtureOf(s: TestServices): { draft: CardCatalogDraft; sourcePages: Record<string, string> } {
    const { draft, pageImages } = buildStandardYuhangFixture();
    const sourcePages: Record<string, string> = {};
    for (const [page, bytes] of pageImages) {
      sourcePages[String(page)] = s.blobs.put(bytes).hash;
    }
    return { draft, sourcePages };
  }

  it('执行返回六字段+report 全文；审计 owner=当前用户；幂等重跑全跳过（复用 S2）', async () => {
    const s = createServices();
    try {
      const { draft, sourcePages } = fixtureOf(s);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const first = await client.stones.importRun({ draft, options: { targetSupplier: 'yuhang' }, sourcePages });
      expect(first.created).toHaveLength(28);
      expect(first.skipped).toHaveLength(0);
      expect(first.failed).toHaveLength(0);
      expect(first.pendingDowngrades).toHaveLength(0);
      expect(first.lowConfidence).toHaveLength(7); // 行 53 低置信（空名+conf 0.5）七格
      expect(first.reportRef).toMatch(/^[0-9a-f]{64}$/);
      const report = first.report as CardImportReport;
      expect(report.kind).toBe('card-import-report');
      expect(report.summary).toMatchObject({ created: 28, rows: 4 });
      // 审计 owner=操作者（anonymous——导入者即归属人）。
      const owners = new Set(
        (s.db.prepare('SELECT DISTINCT owner_id FROM stone_index').all() as Array<{ owner_id: string }>).map((r) => r.owner_id),
      );
      expect(owners).toEqual(new Set([s.anonymous.id]));
      // 幂等重跑：supplier×sku 已存在全跳过（S2 语义直承）。
      const second = await client.stones.importRun({ draft, options: { targetSupplier: 'yuhang' }, sourcePages });
      expect(second.created).toHaveLength(0);
      expect(second.skipped).toHaveLength(28);
      expect(second.skipped[0]?.reason).toMatch(/supplier×sku 已存在（幂等跳过/);
      expect((second.report as CardImportReport).summary).toMatchObject({ created: 0, skipped: 28 });
    } finally {
      s.dispose();
    }
  });

  it('sourcePages blob 不可读 → BAD_REQUEST；空 targetSupplier → typed invalid-options；单页 blobRef 回退（无 sourcePages）', async () => {
    const s = createServices();
    try {
      const { draft, sourcePages } = fixtureOf(s);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const badRef = await expectOrpcError(
        client.stones.importRun({
          draft,
          options: { targetSupplier: 'yuhang' },
          sourcePages: { '1': 'a'.repeat(64) },
        }),
        'BAD_REQUEST',
      );
      expect(badRef.message).toContain('blob 不可读');
      const badOptions = await expectOrpcError(
        client.stones.importRun({ draft, options: { targetSupplier: '  ' }, sourcePages }),
        'BAD_REQUEST',
      );
      expect((badOptions.data as { code?: string }).code).toBe('invalid-options');
      // 零落库锚。
      expect((s.db.prepare('SELECT COUNT(*) AS n FROM stone_index').get() as { n: number }).n).toBe(0);
    } finally {
      s.dispose();
    }
  });

  it('坏草表 schema → 输入面 BAD_REQUEST（oRPC CardCatalogDraftSchema 守门——runCardImport 的 typed invalid-draft 是非 RPC 调用方的纵深防御）', async () => {
    const s = createServices();
    try {
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      await expectOrpcError(
        client.stones.importRun({
          draft: { schemaVersion: 99 } as unknown as CardCatalogDraft,
          options: { targetSupplier: 'yuhang' },
        }),
        'BAD_REQUEST',
      );
    } finally {
      s.dispose();
    }
  });

  it('mock 逃生口：blobs 未装配 → 501（合法输入越过 schema 后触达装配检查）', async () => {
    const s = createServices();
    try {
      const { draft } = buildStandardYuhangFixture();
      const bare = clientFor({ config: s.config, db: s.db, secret: s.secret, token: await s.tokenFor() });
      await expectOrpcError(
        bare.stones.importRun({ draft, options: { targetSupplier: 'yuhang' } }),
        'NOT_IMPLEMENTED',
      );
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] list resourceIds（S7.5 组合投影参）

describe('stones.list resourceIds：组合成员投影过滤（S7.5 前台选择器）', () => {
  it('限定成员集+与 family 交集+groupBy 键投影随过滤集收敛', async () => {
    const s = createServices();
    try {
      const j51 = seedAtom(s, s.anonymous.id);
      const j60 = seedAtom(s, s.anonymous.id, { sku: 'J60', family: '红色系' });
      const a51 = seedAtom(s, s.anonymous.id, { sku: 'A51' });
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const projected = await client.stones.list({ resourceIds: [j51, j60, '0b7d54a5-0000-4000-8000-000000000000'] });
      expect(projected.total).toBe(2); // 未知 id=显式缺席（§7.1 成员缺失不报错）
      expect(projected.cells.map((c) => c.sku)).toEqual(['J51', 'J60']);
      expect(projected.readScope).toBe('shared-library');
      // 交集：resourceIds ∩ family。
      const red = await client.stones.list({ resourceIds: [j51, j60, a51], family: '红色系' });
      expect(red.cells.map((c) => c.sku)).toEqual(['J60']);
      // groupBy 键在全过滤集上取（白色系+红色系两键）。
      const grouped = await client.stones.list({ resourceIds: [j51, j60, a51], groupBy: 'family' });
      expect(grouped.groupKeys).toEqual(['白色系', '红色系']);
      // 软删成员自动不可见（trashed 过滤叠加）。
      await client.stones.trash({ resourceId: j60 });
      expect((await client.stones.list({ resourceIds: [j51, j60] })).total).toBe(1);
    } finally {
      s.dispose();
    }
  });
});
