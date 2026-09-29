/**
 * split-admin-portal 波 4 daemon 集成测试（资源后台化——4.5 门）。
 * createRouterClient 直调（admin-portal-rpc.test.ts 同模式），真 sqlite+真 handler。
 * 覆盖：
 *   [1] 4.1 stones 写面收权矩阵：普通/匿名 trash/restore/importRun 必拒
 *       （FORBIDDEN——守卫先于业务校验）；读面 tree/list 保持放行；admin 过守卫
 *       （未知 id 走业务 BAD_REQUEST 而非 FORBIDDEN——证明收的是权限门）。
 *   [2] 4.2 sets.list owner 过滤：普通用户恒自己（显式传他人 FORBIDDEN/未知
 *       NOT_FOUND）；admin 缺省全量+显式按 username 过滤。
 *   [3] 4.3 assetsLib 权限矩阵：无 token UNAUTHORIZED；跨用户写面 FORBIDDEN；
 *       树归属隔离（普通用户仅自己/admin 全量+显式 owner）。
 *   [4] 4.3 素材 CRUD：上传（魔数嗅探拒伪图）/重命名（同父重名后缀）/移动（环
 *       拒）/软删恢复（递归盖戳+祖先链拒）/清空回收站（叶先删+blob 引用对冲）。
 *   [5] 4.3 迁移核验：目录树先行分批+内容后行；确定性 id 重试幂等（existing 且
 *       blob 引用计数不漂移）；同内容去重；migrateVerify match 矩阵（数量/字节/
 *       digest 三面各Mismatch 一次）。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { assetsLibManifestPayload } from '@handicraft/contracts';
import { hashPassword } from '../src/auth.js';
import { createUser, type UserRow } from '../src/db/store.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

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

function makeUser(s: TestServices, username: string, role: 'admin' | 'user'): UserRow {
  return createUser(s.db, { username, passwordHash: hashPassword('pw-1'), role });
}

async function clientOf(s: TestServices, user: UserRow) {
  return clientFor(s.context({ token: await s.tokenFor(user) }));
}

/** 最小 PNG（1×1——魔数嗅探通过即可）。 */
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 签名
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR 长度+类型
]);
const TINY_PNG_B64 = TINY_PNG.toString('base64');
const OTHER_PNG_B64 = Buffer.concat([TINY_PNG, Buffer.from('other-content')]).toString('base64');

function sha256OfPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------- [1] stones 4.1

describe('4.1 stones 写面收权矩阵', () => {
  it('普通/匿名：trash/restore/importRun FORBIDDEN；tree/list 读面放行', async () => {
    const s = createServices();
    try {
      makeUser(s, 'boss', 'admin');
      const worker = makeUser(s, 'worker', 'user');
      const workerClient = await clientOf(s, worker);
      const anonClient = clientFor(s.context({ token: await s.tokenFor() }));

      for (const client of [workerClient, anonClient]) {
        await expectOrpcError(client.stones.trash({ resourceId: 'whatever' }), 'FORBIDDEN');
        await expectOrpcError(client.stones.restore({ resourceId: 'whatever' }), 'FORBIDDEN');
        await expectOrpcError(
          client.stones.importRun({
            draft: { kind: 'card-catalog', formatVersion: 1 } as never,
            options: { targetSupplier: 'SUP' },
          }),
          'FORBIDDEN',
        );
        // 读面不受收权影响（共享读——Agent MCP 与普通用户浏览照旧）。
        const tree = await client.stones.tree({ includeTrashed: false });
        expect(tree.readScope).toBe('shared-library');
        const list = await client.stones.list({ page: 1, pageSize: 10, includeTrashed: false });
        expect(list.readScope).toBe('shared-library');
      }
    } finally {
      s.dispose();
    }
  });

  it('admin 过守卫（未知 id 走业务 BAD_REQUEST——收的是权限门非业务门）', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const admin = await clientOf(s, boss);
      await expectOrpcError(admin.stones.trash({ resourceId: 'no-such' }), 'BAD_REQUEST');
      await expectOrpcError(admin.stones.restore({ resourceId: 'no-such' }), 'BAD_REQUEST');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] sets 4.2

describe('4.2 sets.list owner 过滤', () => {
  it('普通用户：缺省=自己；显式传他人 FORBIDDEN；未知用户 NOT_FOUND', async () => {
    const s = createServices();
    try {
      const a = makeUser(s, 'a', 'user');
      makeUser(s, 'b', 'user');
      const aClient = await clientOf(s, a);
      const created = await aClient.sets.create({
        name: 'A 的组合',
        members: [{ stoneRef: 'r-1', quantity: 2 }],
        origin: { kind: 'manual-pick' },
      });
      void created;

      const own = await aClient.sets.list({ page: 1, pageSize: 50, includeTrashed: false });
      expect(own.sets.map((row) => row.name)).toEqual(['A 的组合']);

      await expectOrpcError(aClient.sets.list({ owner: 'b', page: 1, pageSize: 50, includeTrashed: false }), 'FORBIDDEN');
      await expectOrpcError(aClient.sets.list({ owner: 'ghost', page: 1, pageSize: 50, includeTrashed: false }), 'NOT_FOUND');
      // 显式查自己=放行
      const self = await aClient.sets.list({ owner: 'a', page: 1, pageSize: 50, includeTrashed: false });
      expect(self.sets).toHaveLength(1);
    } finally {
      s.dispose();
    }
  });

  it('admin：缺省全量；显式 owner=按用户过滤', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const a = makeUser(s, 'a', 'user');
      const b = makeUser(s, 'b', 'user');
      const aClient = await clientOf(s, a);
      const bClient = await clientOf(s, b);
      await aClient.sets.create({ name: 'A1', members: [{ stoneRef: 'r-1' }], origin: { kind: 'manual-pick' } });
      await bClient.sets.create({ name: 'B1', members: [{ stoneRef: 'r-2' }], origin: { kind: 'manual-pick' } });

      const admin = await clientOf(s, boss);
      const all = await admin.sets.list({ page: 1, pageSize: 50, includeTrashed: false });
      expect(all.sets.map((row) => row.name).sort()).toEqual(['A1', 'B1']);
      const onlyA = await admin.sets.list({ owner: 'a', page: 1, pageSize: 50, includeTrashed: false });
      expect(onlyA.sets.map((row) => row.name)).toEqual(['A1']);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] assetsLib 权限矩阵

describe('4.3 assetsLib 权限矩阵', () => {
  it('无 token UNAUTHORIZED；跨用户写面 FORBIDDEN；普通用户树恒自己', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const a = makeUser(s, 'a', 'user');
      const b = makeUser(s, 'b', 'user');
      const bare = clientFor(s.context());
      const aClient = await clientOf(s, a);
      const bClient = await clientOf(s, b);

      await expectOrpcError(bare.assetsLib.tree({ includeTrashed: false }), 'UNAUTHORIZED');
      await expectOrpcError(
        bare.assetsLib.uploadImage({ parentId: null, name: 'x.png', dataBase64: TINY_PNG_B64 }),
        'UNAUTHORIZED',
      );

      const uploaded = await aClient.assetsLib.uploadImage({
        parentId: null,
        name: 'a-pic.png',
        dataBase64: TINY_PNG_B64,
        width: 1,
        height: 1,
      });
      expect(uploaded.owner).toBe('a');

      // 普通用户树=自己（b 空；显式查 a → FORBIDDEN）。
      const bTree = await bClient.assetsLib.tree({ includeTrashed: false });
      expect(bTree.nodes).toEqual([]);
      await expectOrpcError(bClient.assetsLib.tree({ owner: 'a', includeTrashed: false }), 'FORBIDDEN');
      await expectOrpcError(bClient.assetsLib.tree({ owner: 'ghost', includeTrashed: false }), 'NOT_FOUND');

      // 跨用户写面四连拒。
      await expectOrpcError(bClient.assetsLib.move({ id: uploaded.id, newParentId: null }), 'FORBIDDEN');
      await expectOrpcError(bClient.assetsLib.rename({ id: uploaded.id, name: '抢注.png' }), 'FORBIDDEN');
      await expectOrpcError(bClient.assetsLib.softDelete({ id: uploaded.id }), 'FORBIDDEN');
      await expectOrpcError(bClient.assetsLib.restore({ id: uploaded.id }), 'FORBIDDEN');
      void boss;
    } finally {
      s.dispose();
    }
  });

  it('admin：缺省全量树+显式 owner 视图+代管写面放行', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const a = makeUser(s, 'a', 'user');
      const aClient = await clientOf(s, a);
      const uploaded = await aClient.assetsLib.uploadImage({
        parentId: null,
        name: 'a-pic.png',
        dataBase64: TINY_PNG_B64,
      });

      const admin = await clientOf(s, boss);
      const all = await admin.assetsLib.tree({ includeTrashed: false });
      expect(all.nodes).toHaveLength(1);
      expect(all.nodes[0]!.owner).toBe('a');
      const onlyA = await admin.assetsLib.tree({ owner: 'a', includeTrashed: false });
      expect(onlyA.nodes[0]!.id).toBe(uploaded.id);
      // admin 代管重命名放行（owner 豁免）。
      const renamed = await admin.assetsLib.rename({ id: uploaded.id, name: 'admin 改名.png' });
      expect(renamed.owner).toBe('a');
      expect(renamed.name).toBe('admin 改名.png');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] 素材 CRUD

describe('4.3 素材 CRUD 语义', () => {
  it('上传：伪图拒（invalid-image）；同父重名自动后缀', async () => {
    const s = createServices();
    try {
      const a = makeUser(s, 'a', 'user');
      const aClient = await clientOf(s, a);
      const err = await aClient.assetsLib
        .uploadImage({ parentId: null, name: 'fake.png', dataBase64: Buffer.from('not-an-image').toString('base64') })
        .catch((error: unknown) => error as ORPCError<string, unknown>);
      expect(err).toBeInstanceOf(ORPCError);
      expect((err as ORPCError<string, unknown>).data).toMatchObject({ code: 'invalid-image' });

      const first = await aClient.assetsLib.uploadImage({ parentId: null, name: 'dup.png', dataBase64: TINY_PNG_B64 });
      const second = await aClient.assetsLib.uploadImage({ parentId: null, name: 'dup.png', dataBase64: OTHER_PNG_B64 });
      expect(first.name).toBe('dup.png');
      expect(second.name).toBe('dup.png (2)'); // 后缀挂全名（assetStore uniqueNameAmong 同规）
      // 同内容不同名（软链语义——blob 去重）。
      expect(first.blobHash).not.toBeNull();
    } finally {
      s.dispose();
    }
  });

  it('目录：建目录/移动环拒/目录内建节点；软删递归盖戳+恢复祖先链拒+清空回收站', async () => {
    const s = createServices();
    try {
      const a = makeUser(s, 'a', 'user');
      const aClient = await clientOf(s, a);
      const dir = await aClient.assetsLib.migrateBatch({
        items: [{ clientId: 'd1', name: '相册', parentClientId: null, isDir: true }],
      });
      const dirId = dir.results[0]!.id;
      const child = await aClient.assetsLib.uploadImage({
        parentId: dirId,
        name: 'in-dir.png',
        dataBase64: TINY_PNG_B64,
      });
      // 环拒：把目录移进自己的子孙。
      const err = await aClient.assetsLib.move({ id: dirId, newParentId: dirId }).catch((e: unknown) => e as ORPCError<string, unknown>);
      expect((err as ORPCError<string, unknown>).data).toMatchObject({ code: 'cycle' });
      void child;

      // 软删=递归（目录+图片两行）。
      const trashed = await aClient.assetsLib.softDelete({ id: dirId });
      expect(trashed.softDeletedRows).toBe(2);
      const withTrash = await aClient.assetsLib.tree({ includeTrashed: true });
      expect(withTrash.nodes.every((node) => node.softDeleted)).toBe(true);
      // 恢复后子树复位。
      const restored = await aClient.assetsLib.restore({ id: dirId });
      expect(restored.restoredRows).toBe(2);
      const live = await aClient.assetsLib.tree({ includeTrashed: false });
      expect(live.nodes).toHaveLength(2);

      // 再软删后清空回收站：行删+blob 引用对冲（deleting 态）。
      await aClient.assetsLib.softDelete({ id: dirId });
      const purged = await aClient.assetsLib.purgeEmptyTrash({});
      expect(purged.purgedNodeIds).toHaveLength(2);
      expect(purged.releasedBlobHashes).toHaveLength(1);
      const blobRow = s.db
        .prepare('SELECT status, ref_count FROM blobs WHERE hash = ?')
        .get(purged.releasedBlobHashes[0]!) as { status: string; ref_count: number };
      expect(blobRow).toEqual({ status: 'deleting', ref_count: 0 });
      const empty = await aClient.assetsLib.tree({ includeTrashed: true });
      expect(empty.nodes).toEqual([]);
    } finally {
      s.dispose();
    }
  });

  it('恢复祖先链拒：祖先仍盖戳时子项恢复 typed 拒', async () => {
    const s = createServices();
    try {
      const a = makeUser(s, 'a', 'user');
      const aClient = await clientOf(s, a);
      const dir = await aClient.assetsLib.migrateBatch({
        items: [{ clientId: 'd1', name: '外层', parentClientId: null, isDir: true }],
      });
      const dirId = dir.results[0]!.id;
      await aClient.assetsLib.migrateBatch({
        items: [{ clientId: 'd2', name: '内层', parentClientId: 'd1', isDir: true }],
      });
      await aClient.assetsLib.softDelete({ id: dirId });
      const inner = s.db.prepare("SELECT id FROM asset_library WHERE name = '内层'").get() as { id: string };
      const err = await aClient.assetsLib.restore({ id: inner.id }).catch((e: unknown) => e as ORPCError<string, unknown>);
      expect((err as ORPCError<string, unknown>).data).toMatchObject({ code: 'ancestor-still-deleted' });
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] 迁移核验

describe('4.3 迁移核验（migrateBatch/migrateVerify）', () => {
  it('目录树先行+内容后行；重试幂等（existing+blob 计数不漂移）；核验三面 match', async () => {
    const s = createServices();
    try {
      const a = makeUser(s, 'a', 'user');
      const aClient = await clientOf(s, a);

      // 第一批：目录树（根目录+子目录——含系统目录名）。
      const dirs = await aClient.assetsLib.migrateBatch({
        items: [
          { clientId: 'sys-uploads', name: '上传', parentClientId: null, isDir: true },
          { clientId: 'ast-folder-1', name: '手办照片', parentClientId: 'sys-uploads', isDir: true },
        ],
      });
      expect(dirs.results.map((r) => r.status)).toEqual(['created', 'created']);

      // 第二批：内容（两份唯一内容+一份同内容副本——blob 去重）。
      const images = await aClient.assetsLib.migrateBatch({
        items: [
          { clientId: 'ast-img-1', name: 'p1.png', parentClientId: 'ast-folder-1', isDir: false, dataBase64: TINY_PNG_B64, width: 1, height: 1 },
          { clientId: 'ast-img-2', name: 'p2.png', parentClientId: 'sys-uploads', isDir: false, dataBase64: OTHER_PNG_B64 },
          { clientId: 'ast-img-3', name: 'p1-副本.png', parentClientId: 'ast-folder-1', isDir: false, dataBase64: TINY_PNG_B64 },
        ],
      });
      expect(images.results.every((r) => r.status === 'created')).toBe(true);
      const sameContent = images.results.filter((r) => r.clientId !== 'ast-img-2');
      const hashOf = (clientId: string) =>
        (s.db.prepare('SELECT blob_hash FROM asset_library WHERE id = ?').get(`al-${a.id}:${clientId}`) as { blob_hash: string }).blob_hash;
      expect(hashOf(sameContent[0]!.clientId)).toBe(hashOf(sameContent[1]!.clientId));

      // 前端申报清单（同内容计一次——payload 纯函数去重）。
      const manifest = [
        { blobHash: hashOf('ast-img-1'), bytes: TINY_PNG.byteLength },
        { blobHash: hashOf('ast-img-2'), bytes: TINY_PNG.byteLength + 'other-content'.length },
      ];
      const verify = await aClient.assetsLib.migrateVerify({
        declaredCount: 3,
        declaredBytes: manifest.reduce((sum, item) => sum + item.bytes, 0) + TINY_PNG.byteLength, // 节点口径（副本计字节）
        declaredDigest: sha256OfPayload(assetsLibManifestPayload(manifest)),
      });
      // 服务端口径：节点数=3；digest=去重清单；bytes=节点字节和（副本计入）。
      expect(verify.serverCount).toBe(3);
      expect(verify.match).toBe(true);

      // 重试幂等：同批重发 → existing；blob 引用计数不漂移（每内容恰一次 put/次重试零增）。
      const refBefore = (s.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(hashOf('ast-img-1')) as { ref_count: number }).ref_count;
      const dirsRetry = await aClient.assetsLib.migrateBatch({
        items: [{ clientId: 'sys-uploads', name: '上传', parentClientId: null, isDir: true }],
      });
      expect(dirsRetry.results[0]!.status).toBe('existing');
      const imagesRetry = await aClient.assetsLib.migrateBatch({
        items: [
          { clientId: 'ast-img-1', name: 'p1.png', parentClientId: 'ast-folder-1', isDir: false, dataBase64: TINY_PNG_B64 },
          { clientId: 'ast-img-2', name: 'p2.png', parentClientId: 'sys-uploads', isDir: false, dataBase64: OTHER_PNG_B64 },
          { clientId: 'ast-img-3', name: 'p1-副本.png', parentClientId: 'ast-folder-1', isDir: false, dataBase64: TINY_PNG_B64 },
        ],
      });
      expect(imagesRetry.results.every((r) => r.status === 'existing')).toBe(true);
      const refAfter = (s.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(hashOf('ast-img-1')) as { ref_count: number }).ref_count;
      expect(refAfter).toBe(refBefore);

      // 核验三面各错一次 → match=false。
      const base = {
        declaredCount: verify.serverCount,
        declaredBytes: verify.serverBytes,
        declaredDigest: verify.serverDigest,
      };
      expect((await aClient.assetsLib.migrateVerify({ ...base, declaredCount: base.declaredCount + 1 })).match).toBe(false);
      expect((await aClient.assetsLib.migrateVerify({ ...base, declaredBytes: base.declaredBytes + 1 })).match).toBe(false);
      expect((await aClient.assetsLib.migrateVerify({ ...base, declaredDigest: 'f'.repeat(64) })).match).toBe(false);
      // serverNodes 回传（客户端求不符清单的数据面）。
      expect(verify.serverNodes).toHaveLength(3);
    } finally {
      s.dispose();
    }
  });

  it('orphan-parent：跳批上行（父未先行）typed 拒', async () => {
    const s = createServices();
    try {
      const a = makeUser(s, 'a', 'user');
      const aClient = await clientOf(s, a);
      const err = await aClient.assetsLib
        .migrateBatch({
          items: [{ clientId: 'ast-img-x', name: 'x.png', parentClientId: 'sys-uploads', isDir: false, dataBase64: TINY_PNG_B64 }],
        })
        .catch((e: unknown) => e as ORPCError<string, unknown>);
      expect((err as ORPCError<string, unknown>).data).toMatchObject({ code: 'orphan-parent' });
    } finally {
      s.dispose();
    }
  });
});
