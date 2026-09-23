/**
 * 分享页 HTTP 测试（W2.3）：/r/{public_id} 最小分享页（产物预览+下载链接）、
 * /r/{id}/files/{svg|bom|png} 下载（containment 防穿越 + Range 206 + 416 + HEAD）、
 * 未知 public_id 404。真 DaemonHttp + 随机端口（fetch 直测）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { ensureAnonymousUser } from '../src/auth.js';
import { BlobStore } from '../src/db/blobs.js';
import { DaemonHttp } from '../src/http.js';
import { createShareBundle } from '../src/share.js';
import { encodePng } from '../src/png/codec.js';

async function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'handicraft-share-'));
  const webuiDir = path.join(root, 'dist');
  mkdirSync(webuiDir, { recursive: true });
  writeFileSync(path.join(webuiDir, 'index.html'), '<!doctype html><title>spa</title>');
  const config = loadConfig({
    envFile: path.join(root, '.env'),
    processEnv: {
      DATA_ROOT: path.join(root, 'data'),
      WEBUI_DIR: webuiDir,
      JWT_SECRET: 'share-test',
    },
  });
  const db = openDatabase(config.dataRoot);
  const anonymous = ensureAnonymousUser(db);
  const blobs = new BlobStore(config.dataRoot, db);
  const http = new DaemonHttp({ config, db, secret: 'share-test' });
  const port = await http.listen(0, '127.0.0.1');
  // 分享包挂真实 task 行（results.task_id 外键）
  const { createJobTask } = await import('../src/db/jobs.js');
  const taskRow = createJobTask(db, { ownerId: anonymous.id, paramsJson: '{"kind":"engine"}' });

  // 分享包：SVG/BOM + 大 PNG（Range 面——384KB 有意义分片）
  const png = encodePng(320, 320, new Uint8Array(320 * 320 * 4).fill(128));
  const bundle = await createShareBundle(
    { config, db, blobs },
    {
      taskId: taskRow.id,
      ownerId: anonymous.id,
      title: '分享测试包',
      files: {
        svg: new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
        bom: new Uint8Array(Buffer.from('\uFEFF规格,数量\r\nround-ss10,10\r\n')),
        png,
      },
    },
  );
  return {
    base: `http://127.0.0.1:${port}`,
    bundle,
    png,
    dispose: async () => {
      await http.stop(200);
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('分享页 /r/{public_id}（W2.3）', () => {
  it('分享页 HTML（预览+三下载链接）与三产物可下载（Content-Type 正确）', { timeout: 15000 }, async () => {
    const s = await makeSandbox();
    try {
      const page = await fetch(`${s.base}/r/${s.bundle.publicId}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toContain('分享测试包');
      expect(html).toContain(`/r/${s.bundle.publicId}/files/png`);
      expect(html).toContain('下载 SVG');
      expect(html).toContain('下载 BOM');

      const svg = await fetch(`${s.base}/r/${s.bundle.publicId}/files/svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toContain('image/svg+xml');
      expect(await svg.text()).toContain('<svg');

      const bom = await fetch(`${s.base}/r/${s.bundle.publicId}/files/bom`);
      expect(bom.headers.get('content-type')).toContain('text/csv');
      expect((await bom.text()).length).toBeGreaterThan(0);

      const png = await fetch(`${s.base}/r/${s.bundle.publicId}/files/png`);
      expect(png.status).toBe(200);
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(Number(png.headers.get('content-length'))).toBe(s.png.byteLength);
      expect(new Uint8Array(await png.arrayBuffer()).byteLength).toBe(s.png.byteLength);
    } finally {
      await s.dispose();
    }
  });

  it('Range 206：单区间/后缀式分片 + content-range 正确；非法区间 416；HEAD 200 带 accept-ranges', { timeout: 15000 }, async () => {
    const s = await makeSandbox();
    try {
      const url = `${s.base}/r/${s.bundle.publicId}/files/png`;
      const r1 = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      expect(r1.status).toBe(206);
      expect(r1.headers.get('content-range')).toBe(`bytes 0-99/${s.png.byteLength}`);
      expect(Number(r1.headers.get('content-length'))).toBe(100);
      expect((await r1.arrayBuffer()).byteLength).toBe(100);

      const r2 = await fetch(url, { headers: { Range: 'bytes=-50' } });
      expect(r2.status).toBe(206);
      expect(r2.headers.get('content-range')).toBe(
        `bytes ${s.png.byteLength - 50}-${s.png.byteLength - 1}/${s.png.byteLength}`,
      );

      const r3 = await fetch(url, { headers: { Range: `bytes=${s.png.byteLength + 10}-` } });
      expect(r3.status).toBe(416);
      expect(r3.headers.get('content-range')).toBe(`bytes */${s.png.byteLength}`);

      const head = await fetch(url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('accept-ranges')).toBe('bytes');
    } finally {
      await s.dispose();
    }
  });

  it('containment 与 404：未知 public_id 404；未知产物 key 404；越界路径不放行', { timeout: 15000 }, async () => {
    const s = await makeSandbox();
    try {
      expect((await fetch(`${s.base}/r/no-such-id`)).status).toBe(404);
      expect((await fetch(`${s.base}/r/${s.bundle.publicId}/files/exe`)).status).toBe(404);
      // 越界（出 webui 根——静态面 containment 兜底 403）
      const deep = await fetch(
        `${s.base}/r/x/files/..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd`,
      );
      expect(deep.status).toBe(403);
      // 浅层穿越（归一化后仍在 webui 内的不存在路径）→ SPA 回退，不得泄漏 bundle 内容
      const shallow = await fetch(`${s.base}/r/${s.bundle.publicId}/files/..%2F..%2Fbundle.json`);
      expect([200, 403, 404]).toContain(shallow.status);
      expect(await shallow.text()).not.toContain('blobRefs');
    } finally {
      await s.dispose();
    }
  });
});
