/**
 * P1-1 回归（2026-09-29 Codex 整体复核裁定）：blob_uploads 归属粒度与 ref_count 守恒。
 * 修复语义——「(hash,user) 唯一行=该用户对该内容恰好一个引用」：
 *   [1] assets.upload 幂等重排：归属行在场→跳过 put（同用户重复上传零计数变化）；
 *       不在场→put+插归属行（一对一入账）。
 *   [2] adminUserDelete 事务后 releaseRef 清单补 blob_uploads 域（归属行逐行释放，
 *       与 resources/session/results/asset_library 四域同款模式）。
 * 覆盖：
 *   ① 同用户重复上传同内容：ref_count 不漂移（两次 upload 后=1）。
 *   ② 跨用户共享 hash：两归属行、ref_count=2、双方均可 raw 读。
 *   ③ 删除单一 owner：共享内容对另一用户仍可用（ref 减 1 非 deleting）。
 *   ④ 删除最后 owner：blob 进 deleting（recover/maintenance 收敛链入口）。
 *   ⑤ asset_library 行与 blob_uploads 归属并存时删除用户：无多减/漏减
 *      （素材行 releaseRef 与归属行 releaseRef 独立计数守恒——各自 put 各自释放）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth.js';
import { createUser, type UserRow } from '../src/db/store.js';
import { DaemonHttp } from '../src/http.js';
import { AssetsLibraryService } from '../src/assets-library/service.js';
import { encodePng } from '../src/png/codec.js';
import { clientFor, createServices, TEST_SECRET, type TestServices } from './helpers.js';

function pngBytes(w = 8, h = 6): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = 40 + (i % 180);
  return encodePng(w, h, rgba);
}

function makeUser(s: TestServices, username: string, role: 'admin' | 'user'): UserRow {
  return createUser(s.db, { username, passwordHash: hashPassword('pw-1'), role });
}

async function clientOf(s: TestServices, user: UserRow) {
  return clientFor(s.context({ token: await s.tokenFor(user) }));
}

function blobRowOf(s: TestServices, hash: string): { status: string; ref_count: number } {
  return s.db.prepare('SELECT status, ref_count FROM blobs WHERE hash = ?').get(hash) as {
    status: string;
    ref_count: number;
  };
}

function uploadRowsOf(s: TestServices, hash: string): number {
  return (s.db.prepare('SELECT COUNT(*) AS n FROM blob_uploads WHERE blob_hash = ?').get(hash) as { n: number }).n;
}

/** raw 读面（/api/assets/{ref}/raw——归属矩阵的用户可见真面；dist 门禁垫最小 SPA）。 */
async function withRaw(
  s: TestServices,
  run: (base: string) => Promise<void>,
): Promise<void> {
  mkdirSync(s.config.webuiDir, { recursive: true });
  writeFileSync(path.join(s.config.webuiDir, 'index.html'), '<!doctype html><title>p1-1</title>');
  const http = new DaemonHttp({ config: s.config, db: s.db, secret: TEST_SECRET, blobs: s.blobs });
  const port = await http.listen(0, '127.0.0.1');
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await http.stop(200);
  }
}

describe('P1-1：blob_uploads 归属粒度与 ref_count 守恒', () => {
  it('① 同用户重复上传同内容：ref_count 不漂移（两次 upload 后=1）+归属行唯一', async () => {
    const s = createServices();
    try {
      const alice = makeUser(s, 'alice', 'user');
      const aliceClient = await clientOf(s, alice);
      const bytes = pngBytes();

      const first = await aliceClient.assets.upload({
        filename: 'a.png',
        dataBase64: Buffer.from(bytes).toString('base64'),
      });
      expect(first.blobRef).toMatch(/^[0-9a-f]{64}$/);
      expect(first.size).toBe(bytes.byteLength);
      expect(blobRowOf(s, first.blobRef)).toEqual({ status: 'active', ref_count: 1 });
      expect(uploadRowsOf(s, first.blobRef)).toBe(1);

      // 重复上传同内容：返回同 hash，零计数变化、归属行不加行
      const second = await aliceClient.assets.upload({
        filename: 'a-again.png',
        dataBase64: Buffer.from(bytes).toString('base64'),
      });
      expect(second.blobRef).toBe(first.blobRef);
      expect(second.size).toBe(bytes.byteLength);
      expect(blobRowOf(s, first.blobRef)).toEqual({ status: 'active', ref_count: 1 });
      expect(uploadRowsOf(s, first.blobRef)).toBe(1);
    } finally {
      s.dispose();
    }
  });

  it('② 跨用户共享 hash：两归属行、ref_count=2、双方均可 raw 读', async () => {
    const s = createServices();
    try {
      const alice = makeUser(s, 'alice', 'user');
      const bob = makeUser(s, 'bob', 'user');
      const aliceClient = await clientOf(s, alice);
      const bobClient = await clientOf(s, bob);
      const bytes = pngBytes(10, 8);

      const a = await aliceClient.assets.upload({
        filename: 'shared.png',
        dataBase64: Buffer.from(bytes).toString('base64'),
      });
      const b = await bobClient.assets.upload({
        filename: 'shared-copy.png',
        dataBase64: Buffer.from(bytes).toString('base64'),
      });
      expect(b.blobRef).toBe(a.blobRef); // 内容寻址同 hash
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'active', ref_count: 2 });
      expect(uploadRowsOf(s, a.blobRef)).toBe(2); // alice+bob 各一行
      expect(
        s.db.prepare('SELECT COUNT(*) AS n FROM blob_uploads WHERE blob_hash = ? AND user_id = ?').get(a.blobRef, alice.id),
      ).toEqual({ n: 1 });

      await withRaw(s, async (base) => {
        const aliceToken = await s.tokenFor(alice);
        const bobToken = await s.tokenFor(bob);
        const url = `${base}/api/assets/${a.blobRef}/raw`;
        expect((await fetch(`${url}?token=${encodeURIComponent(aliceToken)}`)).status).toBe(200);
        expect((await fetch(`${url}?token=${encodeURIComponent(bobToken)}`)).status).toBe(200);
      });
    } finally {
      s.dispose();
    }
  });

  it('③ 删除单一 owner（adminUserDelete）：共享内容对另一用户仍可用（ref 减 1 非 deleting）', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const admin = await clientOf(s, boss);
      const alice = makeUser(s, 'alice', 'user');
      const bob = makeUser(s, 'bob', 'user');
      const aliceClient = await clientOf(s, alice);
      const bobClient = await clientOf(s, bob);
      const bytes = pngBytes(12, 9);
      const dataBase64 = Buffer.from(bytes).toString('base64');
      const a = await aliceClient.assets.upload({ filename: 'shared.png', dataBase64 });
      await bobClient.assets.upload({ filename: 'shared.png', dataBase64 });
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'active', ref_count: 2 });

      // 删除 bob：归属行清、ref 减 1——共享内容对 alice 仍 active 可用
      expect((await admin.admin.userDelete({ username: 'bob' })).ok).toBe(true);
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'active', ref_count: 1 });
      expect(uploadRowsOf(s, a.blobRef)).toBe(1); // 仅剩 alice 归属行
      expect(
        (s.db.prepare('SELECT COUNT(*) AS n FROM blob_uploads WHERE blob_hash = ? AND user_id = ?').get(a.blobRef, alice.id) as { n: number }).n,
      ).toBe(1);

      await withRaw(s, async (base) => {
        const aliceToken = await s.tokenFor(alice);
        expect(
          (await fetch(`${base}/api/assets/${a.blobRef}/raw?token=${encodeURIComponent(aliceToken)}`)).status,
        ).toBe(200);
      });

      // alice 重复上传仍幂等（归属行在场路径不受删除影响）
      const again = await aliceClient.assets.upload({ filename: 'shared.png', dataBase64 });
      expect(again.blobRef).toBe(a.blobRef);
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'active', ref_count: 1 });
    } finally {
      s.dispose();
    }
  });

  it('④ 删除最后 owner：blob 进 deleting（recover/maintenance 收敛链）+归属账本清零', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const admin = await clientOf(s, boss);
      const alice = makeUser(s, 'alice', 'user');
      const aliceClient = await clientOf(s, alice);
      const a = await aliceClient.assets.upload({
        filename: 'solo.png',
        dataBase64: Buffer.from(pngBytes(6, 6)).toString('base64'),
      });
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'active', ref_count: 1 });

      expect((await admin.admin.userDelete({ username: 'alice' })).ok).toBe(true);
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'deleting', ref_count: 0 });
      expect(uploadRowsOf(s, a.blobRef)).toBe(0);
    } finally {
      s.dispose();
    }
  });

  it('⑤ asset_library 行与 blob_uploads 归属并存时删除用户：无多减/漏减（两域各释放一次各自引用）', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const admin = await clientOf(s, boss);
      const alice = makeUser(s, 'alice', 'user');
      const bob = makeUser(s, 'bob', 'user');
      const aliceClient = await clientOf(s, alice);
      const bobClient = await clientOf(s, bob);
      const bytes = pngBytes(14, 10);
      const dataBase64 = Buffer.from(bytes).toString('base64');

      // alice 两域并存：assets.upload（归属域引用）+ 素材库入库同内容（素材域引用——
      // 内容寻址去重下归属行复用、素材行各持一引用）；bob 共享同 hash 作多减探针。
      const a = await aliceClient.assets.upload({ filename: 'lib-src.png', dataBase64 });
      const lib = new AssetsLibraryService({ db: s.db, blobs: s.blobs });
      const assetRow = lib.uploadImage(alice.id, null, 'lib.png', bytes);
      expect(assetRow.blob_hash).toBe(a.blobRef);
      await bobClient.assets.upload({ filename: 'probe.png', dataBase64 });
      // 3 引用 = alice 归属 1 + alice 素材行 1 + bob 归属 1
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'active', ref_count: 3 });
      expect(uploadRowsOf(s, a.blobRef)).toBe(2);
      expect(
        (s.db.prepare('SELECT COUNT(*) AS n FROM asset_library WHERE owner_id = ? AND blob_hash = ?').get(alice.id, a.blobRef) as { n: number }).n,
      ).toBe(1);

      // 删除 alice：两域各释放一次（2）——bob 的引用不被多吃（多减→deleting）也不滞留（漏减→2）
      expect((await admin.admin.userDelete({ username: 'alice' })).ok).toBe(true);
      expect(blobRowOf(s, a.blobRef)).toEqual({ status: 'active', ref_count: 1 });
      expect(uploadRowsOf(s, a.blobRef)).toBe(1); // 仅 bob
      expect(
        (s.db.prepare('SELECT COUNT(*) AS n FROM asset_library WHERE owner_id = ?').get(alice.id) as { n: number }).n,
      ).toBe(0);
      expect(
        (s.db.prepare('SELECT COUNT(*) AS n FROM blob_uploads WHERE user_id = ?').get(alice.id) as { n: number }).n,
      ).toBe(0);

      await withRaw(s, async (base) => {
        const bobToken = await s.tokenFor(bob);
        expect(
          (await fetch(`${base}/api/assets/${a.blobRef}/raw?token=${encodeURIComponent(bobToken)}`)).status,
        ).toBe(200);
      });
    } finally {
      s.dispose();
    }
  });
});
