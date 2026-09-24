/**
 * add-stone-library S3.4 E2E 全链（真 daemon 进程 spawn + RPC-over-WS + HTTP 贴图面）：
 * 导入→网格可见→筛选→详情→软删/恢复→幂等重跑。
 * 原始需求 2026-09-24（tasks.md S3.4）。形态照 e2e-full（zhumo w7b 模式）：
 *   起 daemon（隔离 DATA_ROOT+沙箱 dist——SPA 托管非本链关注点）→匿名登录→
 *   assets.upload 两页源图（内容寻址真上传面）→stones.importRun（钰航双页 28 格，
 *   复用 stones-import-fixture 合成图）→stones.list 网格可见→筛选（supplier/
 *   family+sizeMm 组合/q 关键字/groupBy 键投影）→stones.get 详情→贴图 textureUrl
 *   经 HTTP 取回字节+ETag 304 再验证→stones.trash 软删（默认不可见+includeTrashed
 *   可见）→stones.restore 复现→importRun 幂等重跑全 skip。
 * 进程纪律：直跑 node --import tsx（pid 即 daemon）；收尾显式 SIGTERM 并断言退出
 * +端口释放+DATA_ROOT 清理（常驻进程回收）。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import { describe, expect, it } from 'vitest';
import type { CardCatalogDraft, StoneGridCell } from '@handicraft/contracts';
import type { CardImportReport } from '../src/stones/importer.js';
import { buildStandardYuhangFixture } from './stones-import-fixture.js';

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function portListeners(port: number): string[] {
  try {
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(300);
  }
  return false;
}

/** importRun 返回（六字段+RPC 面 report 全文即时读回）。 */
interface ImportRunResult {
  created: string[];
  skipped: { sku: string; reason: string }[];
  failed: { sku: string; reason: string }[];
  pendingDowngrades: { sku: string; reason: string }[];
  lowConfidence: { sku: string; row: number }[];
  reportRef: string;
  report: CardImportReport;
}

interface StonesGetResult {
  resourceId: string;
  state: string;
  revision?: number;
  trashed?: boolean;
  stone?: {
    sku: string;
    supplier: string;
    sizeMm: number | null;
    skuParsed?: { row: number; prefix: string; sizeMm: number };
  };
  texture?: { blobRef: string; width: number; height: number; textureUrl: string };
  readScope: string;
}

/** 本链用到的 RPC 面（e2e 局部投影——照 e2e-full cast 形态）。 */
type E2EClient = {
  bootstrap(): Promise<{ version: string }>;
  assets: {
    upload(input: { filename: string; dataBase64: string }): Promise<{ blobRef: string; size: number }>;
  };
  stones: {
    importRun(input: {
      draft: CardCatalogDraft;
      options: { targetSupplier: string };
      sourcePages?: Record<string, string>;
    }): Promise<ImportRunResult>;
    list(input: {
      supplier?: string;
      family?: string;
      sizeMm?: number;
      q?: string;
      groupBy?: 'family' | 'sizeMm' | 'style';
      pageSize?: number;
      includeTrashed?: boolean;
    }): Promise<{ cells: StoneGridCell[]; total: number; groupKeys?: string[]; readScope: string }>;
    get(input: { resourceId: string }): Promise<StonesGetResult>;
    trash(input: { resourceId: string }): Promise<{ resourceId: string; trashedRows: number; trashedStones: number }>;
    restore(input: { resourceId: string }): Promise<{ resourceId: string; restoredRows: number; restoredStones: number }>;
  };
};

describe('S3.4 E2E：装饰钻库全链（导入→网格→筛选→详情→软删/恢复→幂等）', () => {
  it('起 daemon→上传两页→importRun 28 格→list/筛选/get+贴图字节→trash/restore→重跑全 skip→SIGTERM', {
    timeout: 180000,
  }, async () => {
    // ---- 沙箱：隔离 DATA_ROOT + 最小 dist（SPA 托管非本链关注点——照 e2e-smoke 沙箱形态）
    const root = mkdtempSync(path.join(tmpdir(), 'handicraft-e2e-stones-'));
    const dataRoot = path.join(root, 'data');
    const webuiDir = path.join(root, 'dist');
    const envFile = path.join(root, 'env');
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(webuiDir, { recursive: true });
    writeFileSync(path.join(webuiDir, 'index.html'), '<!doctype html><title>e2e-stones-spa</title>');
    let port = 18800 + Math.floor(Math.random() * 400);
    for (let i = 0; i < 20 && portListeners(port).length > 0; i++) {
      port = 18800 + Math.floor(Math.random() * 400);
    }
    writeFileSync(
      envFile,
      [
        'JWT_SECRET=e2e-stones-secret',
        `DATA_ROOT=${dataRoot}`,
        `WEBUI_DIR=${webuiDir}`,
        'HOST=127.0.0.1',
        `PORT=${port}`,
        '',
      ].join('\n'),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: daemonDir,
      env: { ...process.env, HANDICRAFT_ENV: envFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid!;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    let ws: WebSocket | undefined;
    try {
      const base = `http://127.0.0.1:${port}`;
      const up = await waitUntil(async () => {
        try {
          return (await fetch(`${base}/api/bootstrap`)).ok;
        } catch {
          return false;
        }
      }, 25000);
      expect(up, `daemon 探活失败：${stderr}`).toBe(true);

      // ---- 匿名登录 + RPC over WS
      const login = await fetch(`${base}/api/auth/anonymous`, { method: 'POST' });
      expect(login.status).toBe(200);
      const { token } = (await login.json()) as { token: string };
      ws = new WebSocket(`${base.replace('http', 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`);
      const client = createORPCClient(new RPCLink({ websocket: ws as unknown as WebSocket })) as unknown as E2EClient;
      expect((await client.bootstrap()).version).toBe('0.1.0');

      // ---- 两页源图上传（内容寻址真上传面——assets.upload）
      const { draft, pageImages } = buildStandardYuhangFixture();
      expect(pageImages.size).toBe(2); // 钰航式双页（page1 三行+page2 大钻行）
      const sourcePages: Record<string, string> = {};
      for (const [page, bytes] of pageImages) {
        const uploaded = await client.assets.upload({
          filename: `e2e-yuhang-page${page}.png`,
          dataBase64: Buffer.from(bytes).toString('base64'),
        });
        expect(uploaded.blobRef).toMatch(/^[0-9a-f]{64}$/);
        expect(uploaded.size).toBe(bytes.byteLength);
        sourcePages[String(page)] = uploaded.blobRef;
      }
      expect(sourcePages['1']).not.toBe(sourcePages['2']); // 两页字节寻址不同

      // ---- 导入（sourcePages 两页直供草表）→ 28 格创建
      const imported = await client.stones.importRun({
        draft,
        options: { targetSupplier: 'yuhang' },
        sourcePages,
      });
      expect(imported.created).toHaveLength(28); // 4 行 × J..G 七格
      expect(imported.skipped).toHaveLength(0);
      expect(imported.failed).toHaveLength(0);
      expect(imported.pendingDowngrades).toHaveLength(0);
      expect(imported.lowConfidence).toHaveLength(7); // 行 53 低置信（空名+conf 0.5）
      expect(imported.reportRef).toMatch(/^[0-9a-f]{64}$/);
      expect(imported.report.kind).toBe('card-import-report');
      expect(imported.report.summary).toMatchObject({ created: 28, rows: 4 });

      // ---- 网格可见：supplier 过滤=导入数，StoneGridCell 协议字段
      const grid = await client.stones.list({ supplier: 'yuhang' });
      expect(grid.total).toBe(28);
      expect(grid.readScope).toBe('shared-library');
      expect(grid.cells).toHaveLength(28); // 默认 pageSize 50——单页全量
      for (const cell of grid.cells) {
        expect(cell.supplier).toBe('yuhang');
        expect(cell.textureUrl).toBe(`/api/stones/${cell.resourceId}/texture.png`);
      }

      // ---- 筛选：family+sizeMm 组合 / 单参 / q 关键字 / groupBy 键投影
      const combo = await client.stones.list({ supplier: 'yuhang', family: '大径行', sizeMm: 12 });
      expect(combo.total).toBe(1); // J76（band 漂移：大钻行 J=12mm）
      expect(combo.cells[0]).toMatchObject({ sku: 'J76', family: '大径行', sizeMm: 12 });
      const whites = await client.stones.list({ family: '白色系' });
      expect(whites.total).toBe(14); // 行 51 象牙白+52 珍珠白
      const whiteJ = await client.stones.list({ family: '白色系', sizeMm: 2 });
      expect(whiteJ.total).toBe(2); // J51+J52（两行同 J=2mm 档）
      const byStyleName = await client.stones.list({ q: '古铜金' });
      expect(byStyleName.total).toBe(7); // 款式名关键字（行 76）
      const bySku = await client.stones.list({ q: 'j51' });
      expect(bySku.total).toBe(1);
      expect(bySku.cells[0]!.sku).toBe('J51');
      const grouped = await client.stones.list({ supplier: 'yuhang', groupBy: 'family' });
      expect(grouped.groupKeys).toEqual(['大径行', '未分组', '白色系']); // 未分组=行 53 空名兜底

      // ---- 详情 + 贴图 HTTP 取回（字节+ETag 304 再验证）
      const j51Id = bySku.cells[0]!.resourceId;
      const detail = await client.stones.get({ resourceId: j51Id });
      expect(detail.state).toBe('resolved');
      expect(detail.stone).toMatchObject({ sku: 'J51', supplier: 'yuhang', sizeMm: 2 });
      expect(detail.stone?.skuParsed).toMatchObject({ row: 51, prefix: 'J', sizeMm: 2 });
      expect(detail.texture?.blobRef).toMatch(/^[0-9a-f]{64}$/);
      expect(detail.texture?.textureUrl).toBe(`/api/stones/${j51Id}/texture.png`);
      // 未认证 401（贴图资产面 auth 作用域）→ ?token= 取回 PNG 字节+ETag。
      const textureUrl = detail.texture!.textureUrl;
      expect((await fetch(`${base}${textureUrl}`)).status).toBe(401);
      const tex = await fetch(`${base}${textureUrl}?token=${encodeURIComponent(token)}`);
      expect(tex.status).toBe(200);
      expect(tex.headers.get('content-type')).toBe('image/png');
      const etag = tex.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/); // ETag=blob hash（内容寻址）
      const texBytes = new Uint8Array(await tex.arrayBuffer());
      expect(texBytes.byteLength).toBeGreaterThan(0);
      expect(texBytes[0]).toBe(0x89); // PNG 签名
      expect(texBytes[1]).toBe(0x50);
      const revalidated = await fetch(`${base}${textureUrl}?token=${encodeURIComponent(token)}`, {
        headers: { 'If-None-Match': etag! },
      });
      expect(revalidated.status).toBe(304); // 廉价再验证

      // ---- 软删/恢复：默认不可见+includeTrashed 可见+组合过滤收敛→恢复复现
      const trashed = await client.stones.trash({ resourceId: j51Id });
      expect(trashed.trashedStones).toBe(1);
      expect(trashed.trashedRows).toBe(3); // 原子目录+stone.json+贴图 三行
      expect((await client.stones.list({ supplier: 'yuhang' })).total).toBe(27);
      const withTrashed = await client.stones.list({ supplier: 'yuhang', includeTrashed: true });
      expect(withTrashed.total).toBe(28);
      const trashedCell = withTrashed.cells.find((c) => c.resourceId === j51Id);
      expect(trashedCell?.trashed).toBe(true);
      expect((await client.stones.list({ family: '白色系', sizeMm: 2 })).total).toBe(1); // J52 残留（J51 已盖戳）
      expect((await client.stones.get({ resourceId: j51Id })).state).toBe('soft-deleted');
      const restored = await client.stones.restore({ resourceId: j51Id });
      expect(restored.restoredStones).toBe(1);
      expect((await client.stones.list({ supplier: 'yuhang' })).total).toBe(28);
      expect((await client.stones.list({ family: '白色系', sizeMm: 2 })).total).toBe(2); // 组合过滤复现
      expect((await client.stones.get({ resourceId: j51Id })).state).toBe('resolved');

      // ---- 幂等：importRun 重跑全 skip（supplier×sku 唯一键）
      const rerun = await client.stones.importRun({
        draft,
        options: { targetSupplier: 'yuhang' },
        sourcePages,
      });
      expect(rerun.created).toHaveLength(0);
      expect(rerun.skipped).toHaveLength(28);
      expect(rerun.skipped[0]?.reason).toMatch(/supplier×sku 已存在（幂等跳过/);
      expect((await client.stones.list({ supplier: 'yuhang' })).total).toBe(28); // 零新增

      ws.close();
    } finally {
      // SIGTERM 退出 + 端口释放 + DATA_ROOT 清理（进程纪律）
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 已退出
      }
      const code = await new Promise<number | null>((resolve) => {
        child.once('exit', (c) => resolve(c));
        setTimeout(() => resolve(null), 10000);
      });
      expect(code, `daemon 退出码：${stderr}`).not.toBeNull();
      const released = await waitUntil(() => portListeners(port).length === 0, 8000);
      expect(released, `端口 ${port} 未释放`).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
