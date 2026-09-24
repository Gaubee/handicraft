/**
 * stones.tree/list/get RPC 协议测试（add-stone-library design §4.1——S3.1）。
 * 覆盖：
 *   [1] list：filter 全集（supplier/family/sizeMm/styleRow/sku/q）+ 分页 + groupBy
 *       （family/sizeMm）+ includeTrashed + readScope 标注 + StoneGridCell 轻投影协议。
 *   [2] tree：standards/ 目录树（供应商→色系→款式行→SKU 原子；childCount/role/
 *       rootId 钻取）；空库 node=null；软删剪枝/includeTrashed 保留。
 *   [3] get：stone.json 全文+revision+textureUrl+引用四态（resolved/soft-deleted/
 *       wrong-kind/not-found）；blobs 未装配 501。
 *   [4] 共享读（评审 D-1）：B 用户见 A 建的同一库内容（list/get 同值）。
 *   [5] 认证面：无 token 三端点 401。
 * 数据经 StoneService 直建（S1 已验收面——RPC 测试不重复授权桥链路）。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { SupplierSkuProfileSchema, type RgbTuple, type SupplierSkuProfile } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { StoneService } from '../src/stones/service.js';
import type { StoneTreeNode } from '../src/stones/query.js';
import { createUser } from '../src/db/store.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

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

/** 128×128 画布 96px 圆主体（alphaBounds {16,16,96,96}——gates 实测可过）。 */
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

interface SeededStone {
  resourceId: string;
  sku: string;
}

function seedStones(s: TestServices): SeededStone[] {
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  const made: SeededStone[] = [];
  const mk = (sku: string, colorName: string, rgb: RgbTuple, family: string, sizeMm: number | null): void => {
    const result = stones.createStone({
      ownerId: s.anonymous.id,
      supplierProfile: YUHANG,
      draft: {
        name: `${colorName} · ${sizeMm ?? '?'}mm`,
        sku,
        sizeMm,
        color: { name: colorName, rgb, family, finish: 'glossy' },
        texture: { declaredWidth: 128, declaredHeight: 128 },
      },
      textureBytes: textureBytes(),
    });
    made.push({ resourceId: result.resourceId, sku });
  };
  mk('J51', '象牙白', [240, 240, 232], '白色系', 2);
  mk('A51', '象牙白', [240, 240, 232], '白色系', 3);
  mk('B51', '象牙白', [240, 240, 232], '白色系', 4);
  mk('J52', '珍珠白', [250, 247, 240], '白色系', 2);
  mk('J60', '正红', [200, 16, 46], '红色系', 2);
  return made;
}

/** 树内按名找第一个匹配节点（浅层断言用——路径唯一性由 seed 保证）。 */
function findNode(node: StoneTreeNode | null, predicate: (n: StoneTreeNode) => boolean): StoneTreeNode | null {
  if (node === null) return null;
  if (predicate(node)) return node;
  if (node.kind === 'dir') {
    for (const child of node.children) {
      const hit = findNode(child, predicate);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** 目录变体收窄（断言可读 name/childCount）。 */
function asDir(node: StoneTreeNode | null): Extract<StoneTreeNode, { kind: 'dir' }> | null {
  return node !== null && node.kind === 'dir' ? node : null;
}

/** 原子变体收窄（断言可读 cell）。 */
function asCell(node: StoneTreeNode | null): Extract<StoneTreeNode, { kind: 'stone' }>['cell'] | null {
  return node !== null && node.kind === 'stone' ? node.cell : null;
}

async function expectOrpcError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}

// ---------------------------------------------------------------- [1] list

describe('S3.1 stones.list：filter 全集+分页+groupBy（SQL 索引查询）', () => {
  it('filter 组合：family/sizeMm/styleRow/sku/supplier/q + readScope + StoneGridCell 协议', async () => {
    const s = createServices();
    try {
      seedStones(s);
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));

      const family = await client.stones.list({ family: '白色系' });
      expect(family.total).toBe(4);
      expect(family.readScope).toBe('shared-library');
      const size = await client.stones.list({ sizeMm: 2 });
      expect(size.total).toBe(3); // J51/J52/J60
      const style = await client.stones.list({ styleRow: 51 });
      expect(style.total).toBe(3);
      const sku = await client.stones.list({ sku: 'J60' });
      expect(sku.cells[0]).toMatchObject({ sku: 'J60', supplier: 'yuhang', family: '红色系', sizeMm: 2 });
      const foreign = await client.stones.list({ supplier: 'factoryB' });
      expect(foreign.total).toBe(0);
      const byQ = await client.stones.list({ q: 'j5' });
      expect(byQ.total).toBe(2); // J51/J52（大小写不敏感）
      const byHex = await client.stones.list({ q: 'C8102E'.toLowerCase() });
      expect(byHex.total).toBe(1); // 十六进制子串
      // StoneGridCell 轻投影协议（S0 契约字段全集）。
      const cell = sku.cells[0];
      expect(cell).toMatchObject({
        resourceId: cell.resourceId,
        name: '正红 · 2mm',
        styleName: '正红',
        colorHex: '#C8102E',
        finish: 'glossy',
        textureUrl: `/api/stones/${cell.resourceId}/texture.png`,
        trashed: false,
      });
      expect(typeof cell.updatedAt).toBe('string');
    } finally {
      s.dispose();
    }
  });

  it('分页 + groupBy（family/sizeMm——全过滤集取键）', async () => {
    const s = createServices();
    try {
      seedStones(s);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const paged = await client.stones.list({ page: 2, pageSize: 2 });
      expect(paged.total).toBe(5);
      expect(paged.page).toBe(2);
      expect(paged.pageSize).toBe(2);
      expect(paged.cells).toHaveLength(2);
      expect(paged.cells.map((c) => c.sku)).toEqual(['J51', 'J52']); // supplier,sku 稳定序（A51,B51 | J51,J52 | J60）
      const byFamily = await client.stones.list({ groupBy: 'family' });
      expect(byFamily.groupKeys).toEqual(['白色系', '红色系']);
      const bySize = await client.stones.list({ groupBy: 'sizeMm' });
      expect(bySize.groupKeys).toEqual(['2', '3', '4']);
      const familyFiltered = await client.stones.list({ family: '红色系', groupBy: 'family' });
      expect(familyFiltered.groupKeys).toEqual(['红色系']);
    } finally {
      s.dispose();
    }
  });

  it('includeTrashed：默认过滤软删行；显式含回收站（trashed 标注）', async () => {
    const s = createServices();
    try {
      const seeded = seedStones(s);
      new StoneService({ db: s.db, blobs: s.blobs }).softDelete(seeded[0]!.resourceId);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const live = await client.stones.list({});
      expect(live.total).toBe(4);
      expect(live.cells.every((c) => c.trashed === false)).toBe(true);
      const trashed = await client.stones.list({ includeTrashed: true });
      expect(trashed.total).toBe(5);
      const trashedCell = trashed.cells.find((c) => c.resourceId === seeded[0]!.resourceId);
      expect(trashedCell).toMatchObject({ sku: 'J51', trashed: true });
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] tree

describe('S3.1 stones.tree：standards/ 目录树', () => {
  it('供应商→色系→款式行→SKU 原子四层；childCount/role/textureUrl 轻投影', async () => {
    const s = createServices();
    try {
      const seeded = seedStones(s);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const tree = await client.stones.tree({});
      expect(tree.readScope).toBe('shared-library');
      expect(tree.rootId).toBeTruthy();
      expect(tree.node?.kind).toBe('dir');
      expect(asDir(tree.node)?.name).toBe('standards');
      const supplier = asDir(findNode(tree.node, (n) => n.kind === 'dir' && n.name === 'yuhang'));
      expect(supplier).not.toBeNull();
      expect(supplier?.role).toBe('supplier');
      expect(supplier?.childCount).toBe(5);
      const family = asDir(findNode(supplier, (n) => n.kind === 'dir' && n.name === '白色系'));
      expect(family?.childCount).toBe(4);
      const style = asDir(findNode(family, (n) => n.kind === 'dir' && n.name === '51-象牙白'));
      expect(style?.childCount).toBe(3);
      const atom = asCell(findNode(style, (n) => n.kind === 'stone' && n.cell.sku === 'J51'));
      expect(atom).toMatchObject({
        resourceId: seeded[0]!.resourceId,
        supplier: 'yuhang',
        textureUrl: `/api/stones/${seeded[0]!.resourceId}/texture.png`,
      });
    } finally {
      s.dispose();
    }
  });

  it('rootId 钻取（色系子树）+ 空库 node=null + 显式坏根 BAD_REQUEST', async () => {
    const s = createServices();
    try {
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const empty = await client.stones.tree({});
      expect(empty.rootId).toBeNull();
      expect(empty.node).toBeNull();

      seedStones(s);
      const familyDir = (
        s.db.prepare("SELECT id FROM resources WHERE name = '白色系' AND is_dir = 1").get() as { id: string }
      ).id;
      const sub = await client.stones.tree({ rootId: familyDir });
      expect(asDir(sub.node)?.name).toBe('白色系');
      expect(asDir(sub.node)?.childCount).toBe(4);
      expect(findNode(sub.node, (n) => n.kind === 'dir' && n.name === 'yuhang')).toBeNull(); // 不上溯

      await expectOrpcError(client.stones.tree({ rootId: 'no-such-id' }), 'BAD_REQUEST');
    } finally {
      s.dispose();
    }
  });

  it('软删剪枝（默认剔除 trashed 原子+空枝）与 includeTrashed 保留（cell.trashed）', async () => {
    const s = createServices();
    try {
      const seeded = seedStones(s);
      const stones = new StoneService({ db: s.db, blobs: s.blobs });
      stones.softDelete(seeded[4]!.resourceId); // J60——红色系独苗：整色系枝被剪
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const pruned = await client.stones.tree({});
      expect(findNode(pruned.node, (n) => n.kind === 'stone' && n.cell.sku === 'J60')).toBeNull();
      expect(findNode(pruned.node, (n) => n.kind === 'dir' && n.name === '红色系')).toBeNull();
      expect(findNode(pruned.node, (n) => n.kind === 'dir' && n.name === 'yuhang')?.kind === 'dir' ? true : false).toBe(true);
      const kept = await client.stones.tree({ includeTrashed: true });
      const j60 = asCell(findNode(kept.node, (n) => n.kind === 'stone' && n.cell.sku === 'J60'));
      expect(j60?.trashed).toBe(true);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] get

describe('S3.1 stones.get：stone.json 全文+四态', () => {
  it('resolved：全文+revision+path+textureUrl+blobRef；readScope 标注', async () => {
    const s = createServices();
    try {
      const seeded = seedStones(s);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const got = await client.stones.get({ resourceId: seeded[0]!.resourceId });
      expect(got.state).toBe('resolved');
      expect(got.readScope).toBe('shared-library');
      expect(got.revision).toBe(1);
      expect(got.path).toBe('/stones/standards/yuhang/白色系/51-象牙白/J51');
      expect(got.stone).toMatchObject({ kind: 'stone', sku: 'J51', supplier: 'yuhang', sizeMm: 2 });
      expect(got.stone?.skuParsed).toMatchObject({ row: 51, prefix: 'J', sizeMm: 2 });
      expect(got.texture).toMatchObject({
        width: 128,
        height: 128,
        textureUrl: `/api/stones/${seeded[0]!.resourceId}/texture.png`,
      });
      expect(got.texture?.blobRef).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      s.dispose();
    }
  });

  it('四态：soft-deleted 可读详情 / wrong-kind（系统根）/ not-found（未知 id）', async () => {
    const s = createServices();
    try {
      const seeded = seedStones(s);
      const stones = new StoneService({ db: s.db, blobs: s.blobs });
      stones.softDelete(seeded[1]!.resourceId);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const softDeleted = await client.stones.get({ resourceId: seeded[1]!.resourceId });
      expect(softDeleted.state).toBe('soft-deleted');
      expect(softDeleted.trashed).toBe(true);
      expect(softDeleted.stone?.sku).toBe('A51');const rootId = (
        s.db.prepare("SELECT id FROM resources WHERE meta LIKE '%\"role\":\"stones-root\"%'").get() as { id: string }
      ).id;
      const wrongKind = await client.stones.get({ resourceId: rootId });
      expect(wrongKind.state).toBe('wrong-kind');
      const notFound = await client.stones.get({ resourceId: '0b7d54a5-0000-4000-8000-000000000000' });
      expect(notFound.state).toBe('not-found');
    } finally {
      s.dispose();
    }
  });

  it('mock 逃生口：blobs 未装配 → stones.get 501（tree/list 仍可用）', async () => {
    const s = createServices();
    try {
      seedStones(s);
      // bare context 不含 blobs/jobs/sessions——但带 token（requireAuth 面）。
      const bare = clientFor({ config: s.config, db: s.db, secret: s.secret, token: await s.tokenFor() });
      const listed = await bare.stones.list({});
      expect(listed.total).toBe(5);
      const tree = await bare.stones.tree({});
      expect(tree.node).not.toBeNull();
      await expectOrpcError(bare.stones.get({ resourceId: 'x' }), 'NOT_IMPLEMENTED');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] 共享读（评审 D-1）

describe('S3.1 共享读：全部认证用户见同一库内容（评审 D-1）', () => {
  it('B 用户 list/get 与 A 同值（供应链真源——不按 owner 过滤）', async () => {
    const s = createServices();
    try {
      seedStones(s); // A=anonymous 建 5 颗
      const userB = createUser(s.db, { username: 'stone-rpc-b', passwordHash: 'x', role: 'user' });
      const tokenB = await s.tokenFor(userB);
      const clientB = clientFor(s.context({ token: tokenB }));
      const clientA = clientFor(s.context({ token: await s.tokenFor() }));
      const byB = await clientB.stones.list({});
      const byA = await clientA.stones.list({});
      expect(byB.total).toBe(5);
      expect(byB.cells).toEqual(byA.cells); // 同一库内容（细胞级等值）
      expect(byB.readScope).toBe('shared-library');
      const gotB = await clientB.stones.get({ resourceId: byA.cells[0]!.resourceId });
      expect(gotB.state).toBe('resolved');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] 认证面

describe('S3.1 认证面：无 token 三端点 401', () => {
  it('tree/list/get 未认证必拒', async () => {
    const s = createServices();
    try {
      const anonymous = clientFor(s.context());
      await expectOrpcError(anonymous.stones.tree({}), 'UNAUTHORIZED');
      await expectOrpcError(anonymous.stones.list({}), 'UNAUTHORIZED');
      await expectOrpcError(anonymous.stones.get({ resourceId: 'x' }), 'UNAUTHORIZED');
    } finally {
      s.dispose();
    }
  });
});
