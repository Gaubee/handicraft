/**
 * /api/stones/{id}/texture.png 与 /views/{name} HTTP 端点测试（add-stone-library
 * design §4.1——S3.2）。覆盖：auth 作用域（Bearer 与 ?token= 双通道、未认证 401）、
 * ETag=blob hash（If-None-Match 304）、containment（DB 行名精确匹配——traversal
 * 天然 404）、404 面（未知 id/非原子目录/无文件行/坏视图名）、views MIME、HEAD。
 * 真 DaemonHttp + 随机端口（fetch 直测——沿 share.test.ts 沙箱模式）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SupplierSkuProfileSchema } from '@handicraft/contracts';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { ensureAnonymousUser, signJwt } from '../src/auth.js';
import { BlobStore } from '../src/db/blobs.js';
import { DaemonHttp } from '../src/http.js';
import { StoneService } from '../src/stones/service.js';
import { encodePng } from '../src/png/codec.js';

const YUHANG = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } }],
  styleKey: 'row',
});

/** 128×128 画布 96px 圆主体（与 stones-rpc fixture 同式——gates 可过）。 */
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

interface Sandbox {
  base: string;
  db: ReturnType<typeof openDatabase>;
  resourceId: string;
  textureRef: string;
  texture: Uint8Array;
  slideBytes: Uint8Array;
  token: string;
  dispose(): Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = mkdtempSync(path.join(tmpdir(), 'handicraft-stones-http-'));
  const webuiDir = path.join(root, 'dist');
  mkdirSync(webuiDir, { recursive: true });
  writeFileSync(path.join(webuiDir, 'index.html'), '<!doctype html><title>spa</title>');
  const config = loadConfig({
    envFile: path.join(root, '.env'),
    processEnv: {
      DATA_ROOT: path.join(root, 'data'),
      WEBUI_DIR: webuiDir,
      JWT_SECRET: 'stones-http-test',
    },
  });
  const db = openDatabase(config.dataRoot);
  const anonymous = ensureAnonymousUser(db);
  const blobs = new BlobStore(config.dataRoot, db);
  const http = new DaemonHttp({ config, db, secret: 'stones-http-test', blobs });
  const port = await http.listen(0, '127.0.0.1');

  const texture = textureBytes();
  const created = new StoneService({ db, blobs }).createStone({
    ownerId: anonymous.id,
    supplierProfile: YUHANG,
    draft: {
      name: '象牙白 · 2mm',
      sku: 'J51',
      sizeMm: 2,
      color: { name: '象牙白', rgb: [240, 240, 232], family: '白色系', finish: 'glossy' },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: texture,
  });
  // views/ fixture：实物照片子目录+文件行（S1 服务面无 views 写 API——测试直接落行）。
  const slideBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const slidePut = blobs.put(slideBytes);
  const now = new Date().toISOString();
  const viewsDirId = randomUUID();
  db.prepare(
    'INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, 0, NULL, 1, ?, ?)',
  ).run(viewsDirId, anonymous.id, created.resourceId, 'views', now, now);
  db.prepare(
    'INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, 1, ?, ?)',
  ).run(randomUUID(), anonymous.id, viewsDirId, '斜视.jpg', slidePut.hash, slideBytes.byteLength, now, now);

  const { token } = await signJwt('stones-http-test', { sub: anonymous.id, role: anonymous.role });
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    resourceId: created.resourceId,
    textureRef: created.textureBlobRef,
    texture,
    slideBytes,
    token,
    dispose: async () => {
      await http.stop(200);
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('S3.2 /api/stones/{id}/texture.png（auth+ETag+containment）', () => {
  it('未认证 401（无 token/坏 token）；Bearer 与 ?token= 双通道可取', { timeout: 15000 }, async () => {
    const s = await makeSandbox();
    try {
      const url = `${s.base}/api/stones/${s.resourceId}/texture.png`;
      const noToken = await fetch(url);
      expect(noToken.status).toBe(401);
      const badToken = await fetch(`${url}?token=not-a-jwt`);
      expect(badToken.status).toBe(401);
      const viaQuery = await fetch(`${url}?token=${encodeURIComponent(s.token)}`);
      expect(viaQuery.status).toBe(200);
      const viaBearer = await fetch(url, { headers: { authorization: `Bearer ${s.token}` } });
      expect(viaBearer.status).toBe(200);
    } finally {
      await s.dispose();
    }
  });

  it('200：image/png + ETag=blob hash + 字节等值 + If-None-Match 304 + HEAD', { timeout: 15000 }, async () => {
    const s = await makeSandbox();
    try {
      const url = `${s.base}/api/stones/${s.resourceId}/texture.png?token=${encodeURIComponent(s.token)}`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('etag')).toBe(`"${s.textureRef}"`);
      expect(res.headers.get('cache-control')).toContain('no-cache');
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body).toEqual(s.texture);
      // 304：同 ETag 再验证。
      const revalidate = await fetch(url, { headers: { 'if-none-match': `"${s.textureRef}"` } });
      expect(revalidate.status).toBe(304);
      expect(await revalidate.arrayBuffer()).toEqual(new ArrayBuffer(0));
      // HEAD：头齐体空。
      const head = await fetch(url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('etag')).toBe(`"${s.textureRef}"`);
      expect(await head.arrayBuffer()).toEqual(new ArrayBuffer(0));
    } finally {
      await s.dispose();
    }
  });

  it('404 面：未知 id / 非原子目录（系统根）/ blob 缺失 / 坏视图名；traversal 解码后含 / 走未知 API 404', { timeout: 15000 }, async () => {
    const s = await makeSandbox();
    try {
      const q = `?token=${encodeURIComponent(s.token)}`;
      const unknown = await fetch(`${s.base}/api/stones/${randomUUID()}/texture.png${q}`);
      expect(unknown.status).toBe(404);
      // 非原子目录：stones 系统根是 dir 但无 贴图.png 子行 → 404。
      const rootId = (
        s.db.prepare("SELECT id FROM resources WHERE meta LIKE '%\"role\":\"stones-root\"%'").get() as { id: string }
      ).id;
      const notAtom = await fetch(`${s.base}/api/stones/${rootId}/texture.png${q}`);
      expect(notAtom.status).toBe(404);
      // blob 缺失：贴图行 hash 指向不可读 blob（直改 DB 后还原）。
      const textureRow = s.db
        .prepare('SELECT id FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 0')
        .get(s.resourceId, '贴图.png') as { id: string };
      s.db.prepare('UPDATE resources SET content_hash = ? WHERE id = ?').run('f'.repeat(64), textureRow.id);
      const blobMissing = await fetch(`${s.base}/api/stones/${s.resourceId}/texture.png${q}`);
      expect(blobMissing.status).toBe(404);
      s.db.prepare('UPDATE resources SET content_hash = ? WHERE id = ?').run(s.textureRef, textureRow.id);
      // 坏视图名：无对应行 → 404。
      const missingView = await fetch(`${s.base}/api/stones/${s.resourceId}/views/${encodeURIComponent('不存在.jpg')}${q}`);
      expect(missingView.status).toBe(404);
      // containment：解码后含 /（%2F）——路由不匹配 → 未知 API 路径 404（JSON 面）。
      const traversal = await fetch(`${s.base}/api/stones/${s.resourceId}/views/${encodeURIComponent('../stone.json')}${q}`);
      expect(traversal.status).toBe(404);
      expect(traversal.headers.get('content-type')).toContain('application/json');
      // 纯 '..' 行名：DB 精确匹配无行 → 404。
      const dotdot = await fetch(`${s.base}/api/stones/${s.resourceId}/views/..${q}`);
      expect(dotdot.status).toBe(404);
    } finally {
      await s.dispose();
    }
  });

  it('views/{name}：MIME 按扩展名 + 字节等值（实物照片面）', { timeout: 15000 }, async () => {
    const s = await makeSandbox();
    try {
      const res = await fetch(
        `${s.base}/api/stones/${s.resourceId}/views/${encodeURIComponent('斜视.jpg')}?token=${encodeURIComponent(s.token)}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body).toEqual(s.slideBytes);
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    } finally {
      await s.dispose();
    }
  });
});
