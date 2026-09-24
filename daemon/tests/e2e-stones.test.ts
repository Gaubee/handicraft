/**
 * add-stone-library E2E 全链（真 daemon 进程 spawn + RPC-over-WS + HTTP 贴图面）。
 * 链一（S3.4，cd20bfb）：导入→网格可见→筛选→详情→软删/恢复→幂等重跑。
 * 原始需求 2026-09-24（tasks.md S3.4）。形态照 e2e-full（zhumo w7b 模式）：
 *   起 daemon（隔离 DATA_ROOT+沙箱 dist——SPA 托管非本链关注点）→匿名登录→
 *   assets.upload 两页源图（内容寻址真上传面）→stones.importRun（钰航双页 28 格，
 *   复用 stones-import-fixture 合成图）→stones.list 网格可见→筛选（supplier/
 *   family+sizeMm 组合/q 关键字/groupBy 键投影）→stones.get 详情→贴图 textureUrl
 *   经 HTTP 取回字节+ETag 304 再验证→stones.trash 软删（默认不可见+includeTrashed
 *   可见）→stones.restore 复现→importRun 幂等重跑全 skip。
 * 链二（S8.1 后半段，2026-09-25）：双标准同编号→建组合→限定名→组合投影→
 *   标准贴图更新后组合跟随（引用集零同步）→缺失态呈现。daemon 附加 MCP_PORT+
 *   进程内 mock LLM 网关（e2e-kernel ④态模式，零真实外呼）驱动 dsh 内核 ready——
 *   标准原子字段/贴图更新**无人工直发 RPC 面**（rpc.ts stones 六端点无 update；
 *   唯一真进程写面=MCP stone.update approved-mutation 授权桥），故经
 *   session.followup 造 agent 任务→MCP tools/call stone_update propose→
 *   session.answer 批准→execute 三段真链。
 * 进程纪律：直跑 node --import tsx（pid 即 daemon）；收尾显式 SIGTERM 并断言退出
 * +端口释放+DATA_ROOT 清理（常驻进程回收；链二并关 mock 网关）。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import { describe, expect, it } from 'vitest';
import type { CardCatalogDraft, RgbTuple, StoneGridCell } from '@handicraft/contracts';
import type { CardImportReport } from '../src/stones/importer.js';
import { encodePng } from '../src/png/codec.js';
import {
  buildDraft,
  buildStandardYuhangFixture,
  PAGE1_COL_X,
  PREFIXES,
  NORMAL_MM,
  diamPx,
  rowY,
} from './stones-import-fixture.js';

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

/** sets.get 成员读时解析投影（SetMemberResolution 的 e2e 局部投影）。 */
interface SetMemberView {
  stoneRef: string;
  state: string;
  quantity?: number;
  note?: string;
  standardId?: string;
  qualifiedSku?: string;
  revision?: number;
  textureUrl?: string;
  stone?: {
    sku: string;
    supplier: string;
    color: { name: string; rgb: number[] };
    texture: { mime: string; width: number; height: number; alphaBounds: { x: number; y: number; w: number; h: number } };
  };
}

interface SetGetResult {
  resourceId: string;
  setId: string;
  revision: number;
  path: string;
  trashed: boolean;
  set: { kind: 'stone-set'; name: string; stones: Array<{ stoneRef: string; quantity?: number; note?: string }> };
  members: SetMemberView[];
}

/** 本链用到的 RPC 面（e2e 局部投影——照 e2e-full cast 形态；链二追加 sets/session）。 */
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
      sku?: string;
      q?: string;
      resourceIds?: string[];
      groupBy?: 'family' | 'sizeMm' | 'style';
      pageSize?: number;
      includeTrashed?: boolean;
    }): Promise<{ cells: StoneGridCell[]; total: number; groupKeys?: string[]; readScope: string }>;
    get(input: { resourceId: string }): Promise<StonesGetResult>;
    trash(input: { resourceId: string }): Promise<{ resourceId: string; trashedRows: number; trashedStones: number }>;
    restore(input: { resourceId: string }): Promise<{ resourceId: string; restoredRows: number; restoredStones: number }>;
  };
  sets: {
    create(input: {
      name: string;
      purpose?: string;
      members?: Array<{ stoneRef: string; quantity?: number; note?: string }>;
      origin: { kind: 'manual-pick' };
    }): Promise<{ resourceId: string; setId: string; revision: number; path: string; memberCount: number }>;
    get(input: { resourceId: string }): Promise<SetGetResult>;
  };
  session: {
    create(input: { title?: string }): Promise<{ sessionId: string }>;
    followup(input: { sessionId: string; text: string }): Promise<{ taskId: string }>;
    answer(input: { sessionId: string; requestId: string; approved: boolean }): Promise<{ ok: boolean }>;
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

// ================================================================ S8.1 组合链

/** mock openai-completions 网关（e2e-kernel ④态确定性模型替身——零真实外呼）。 */
function startMockGateway(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3-flash' }] }));
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      void body;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = '（mock 网关确定性回复：S8.1 组合链测试。）';
      const send = (payload: unknown): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      send({ choices: [{ delta: { content: text.slice(0, 10) } }] });
      send({ choices: [{ delta: { content: text.slice(10) } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

/**
 * 替换贴图（128×128 透明底 96px 暖灰圆主体——alphaBounds {16,16,96,96}，主径
 * 96px 过 gate 5 的 64px 下限；与 fixture 象牙白字节不同 hash=内容寻址新 blob）。
 */
function replacementTextureBytes(): Uint8Array {
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
        rgba[p] = 214;
        rgba[p + 1] = 208;
        rgba[p + 2] = 200;
        rgba[p + 3] = 255;
      }
    }
  }
  return new Uint8Array(encodePng(size, size, rgba));
}

/**
 * factoryB 单行草表（行 51 象牙白七格@page1——与钰航行 51 同 rgb/几何，供 targetSupplier 复用页图）。
 * pages 显式声明复用的钰航 page1 实际画布（导入器对账声明宽高=解码实测——按本行
 * cell 推导会缩小页高而与复用 blob 不符）。
 */
function buildFactoryBRow51Draft(page1: { widthPx: number; heightPx: number }): CardCatalogDraft {
  const ivory: RgbTuple = [240, 240, 232];
  const cells = PAGE1_COL_X.map((cx, i) => ({
    sku: `${PREFIXES[i]}51`,
    cx,
    cy: rowY(51),
    diameter: diamPx(NORMAL_MM[i]!),
    rgb: ivory,
  }));
  return buildDraft(
    [{ row: 51, page: 1, suggestedName: '象牙白', suggestedFamily: '白色系', rgb: ivory, confidence: 0.95, cells }],
    { supplier: 'factoryB', pages: [{ page: 1, ...page1 }] },
  );
}

/** MCP tools/call 结果载荷（CapabilityCallResult 的 JSON 文本投影）。 */
interface McpCallPayload {
  kind: string;
  message?: string;
  value?: { proposalId?: string; requestId?: string; resourceId?: string; revision?: number };
}

describe('S8.1 E2E：组合链（双标准同编号→建组合→限定名→组合投影→标准更新跟随→缺失态）', () => {
  it('双供应商 J51→sets.create→限定名并存可区分→resourceIds 投影→MCP stone.update 换贴图组合跟随（set revision 不变）→trash soft-deleted 呈现→restore', {
    timeout: 240000,
  }, async () => {
    // ---- 沙箱：隔离 DATA_ROOT + 最小 dist + MCP_PORT + mock LLM 网关（内核 ready——stone.update 真进程写面）
    const gateway = await startMockGateway();
    const root = mkdtempSync(path.join(tmpdir(), 'handicraft-e2e-stones-s81-'));
    const dataRoot = path.join(root, 'data');
    const webuiDir = path.join(root, 'dist');
    const envFile = path.join(root, 'env');
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(webuiDir, { recursive: true });
    writeFileSync(path.join(webuiDir, 'index.html'), '<!doctype html><title>e2e-stones-s81-spa</title>');
    let port = 20200 + Math.floor(Math.random() * 300);
    for (let i = 0; i < 20 && portListeners(port).length > 0; i++) {
      port = 20200 + Math.floor(Math.random() * 300);
    }
    let mcpPort = 20600 + Math.floor(Math.random() * 300);
    for (let i = 0; i < 20 && portListeners(mcpPort).length > 0; i++) {
      mcpPort = 20600 + Math.floor(Math.random() * 300);
    }
    writeFileSync(
      envFile,
      [
        'JWT_SECRET=e2e-stones-s81-secret',
        `DATA_ROOT=${dataRoot}`,
        `WEBUI_DIR=${webuiDir}`,
        'HOST=127.0.0.1',
        `PORT=${port}`,
        `MCP_PORT=${mcpPort}`,
        '',
      ].join('\n'),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: daemonDir,
      env: {
        ...process.env,
        HANDICRAFT_ENV: envFile,
        LLM_PROVIDER: 'zai',
        LLM_API: 'openai-completions',
        LLM_MODEL: 'glm-5.3-flash',
        LLM_API_KEY: 'mock-key',
        LLM_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid!;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
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
      const kernelReady = await waitUntil(() => stdout.includes('dsh 内核就绪'), 45000);
      expect(kernelReady, `内核未就绪：${stdout}\n${stderr}`).toBe(true);

      // ---- 匿名登录 + RPC over WS
      const login = await fetch(`${base}/api/auth/anonymous`, { method: 'POST' });
      expect(login.status).toBe(200);
      const { token } = (await login.json()) as { token: string };
      ws = new WebSocket(`${base.replace('http', 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`);
      const client = createORPCClient(new RPCLink({ websocket: ws as unknown as WebSocket })) as unknown as E2EClient;
      expect((await client.bootstrap()).version).toBe('0.1.0');

      // ---- [1] 双标准同编号：钰航 28 格 + factoryB 复用 page1 单行 7 格 → 两标准各一颗 J51
      const { draft, pageImages } = buildStandardYuhangFixture();
      const sourcePages: Record<string, string> = {};
      for (const [page, bytes] of pageImages) {
        const uploaded = await client.assets.upload({
          filename: `e2e-s81-page${page}.png`,
          dataBase64: Buffer.from(bytes).toString('base64'),
        });
        sourcePages[String(page)] = uploaded.blobRef;
      }
      const yuhangImport = await client.stones.importRun({
        draft,
        options: { targetSupplier: 'yuhang' },
        sourcePages,
      });
      expect(yuhangImport.created).toHaveLength(28);
      const factoryBImport = await client.stones.importRun({
        draft: buildFactoryBRow51Draft(
          draft.sourceImage.pages.find((p) => p.page === 1) as { widthPx: number; heightPx: number },
        ),
        options: { targetSupplier: 'factoryB' },
        sourcePages: { 1: sourcePages['1']! }, // 页源图复用已传 blob（内容寻址）
      });
      expect(factoryBImport.created).toHaveLength(7);
      expect(factoryBImport.failed).toHaveLength(0);
      expect(factoryBImport.pendingDowngrades).toHaveLength(0);
      expect((await client.stones.list({ supplier: 'yuhang' })).total).toBe(28);
      expect((await client.stones.list({ supplier: 'factoryB' })).total).toBe(7);
      const yuhangJ51 = (await client.stones.list({ supplier: 'yuhang', sku: 'J51' })).cells[0]!.resourceId;
      const factoryBJ51 = (await client.stones.list({ supplier: 'factoryB', sku: 'J51' })).cells[0]!.resourceId;
      expect(yuhangJ51).not.toBe(factoryBJ51); // 同编号两颗原子（supplier×sku 唯一键各占一格）

      // ---- [2] 建组合（人工直发 RPC）+ 限定名区分（§7.6）
      const created = await client.sets.create({
        name: '双标准同号套餐',
        purpose: 'S8.1 组合链',
        members: [
          { stoneRef: yuhangJ51, quantity: 2, note: '主钻' },
          { stoneRef: factoryBJ51, quantity: 1 },
        ],
        origin: { kind: 'manual-pick' },
      });
      expect(created.revision).toBe(1);
      expect(created.memberCount).toBe(2);
      expect(created.path).toBe('/stones/production-sets/双标准同号套餐');
      const got = await client.sets.get({ resourceId: created.resourceId });
      expect(got.members.map((m) => [m.state, m.qualifiedSku])).toEqual([
        ['resolved', 'yuhang/J51'],
        ['resolved', 'factoryB/J51'], // 编号冲突限定名并存可区分
      ]);
      expect(got.members[0]).toMatchObject({ standardId: 'yuhang', textureUrl: `/api/stones/${yuhangJ51}/texture.png` });
      expect(got.members[1]).toMatchObject({ standardId: 'factoryB', textureUrl: `/api/stones/${factoryBJ51}/texture.png` });
      expect(got.members[0]?.stone).toMatchObject({ supplier: 'yuhang', sku: 'J51' });
      expect(got.members[1]?.stone).toMatchObject({ supplier: 'factoryB', sku: 'J51' });
      expect(got.members[0]?.revision).toBe(1);
      const storedMembers = got.set.stones; // set.json 存储真值（零同步不变量基线）

      // ---- [3] 组合投影：stones.list resourceIds 过滤=成员集（S7.5 参数）
      const projection = await client.stones.list({ resourceIds: [yuhangJ51, factoryBJ51] });
      expect(projection.total).toBe(2);
      expect(projection.cells.map((c) => c.resourceId).sort()).toEqual([factoryBJ51, yuhangJ51].sort());

      // ---- [4] 标准更新组合跟随：MCP stone.update 换 yuhang/J51 贴图+色名（授权桥三段真链）
      const before = await client.stones.get({ resourceId: yuhangJ51 });
      expect(before.revision).toBe(1);
      const beforeBlobRef = before.texture!.blobRef;
      const beforeTexture = await fetch(`${base}${before.texture!.textureUrl}?token=${encodeURIComponent(token)}`);
      expect(beforeTexture.status).toBe(200);
      const beforeEtag = beforeTexture.headers.get('etag');
      const replacement = await client.assets.upload({
        filename: 'e2e-s81-j51-replacement.png',
        dataBase64: Buffer.from(replacementTextureBytes()).toString('base64'),
      });
      expect(replacement.blobRef).not.toBe(beforeBlobRef); // 新内容新 hash
      // agent 任务（approved-mutation 的 taskId 审计链要求——kernel followup 造 type=agent 行）。
      const { sessionId } = await client.session.create({ title: 'S8.1 组合链' });
      const { taskId } = await client.session.followup({ sessionId, text: '换主钻贴图' });
      // MCP streamable-http 环回（token=DATA_ROOT/mcp-token；initialize→initialized→tools/call）。
      const mcpToken = readFileSync(path.join(dataRoot, 'mcp-token'), 'utf8').trim();
      const mcpBase = `http://127.0.0.1:${mcpPort}/mcp`;
      let mcpSessionHeader: string | undefined;
      const mcpPost = async (body: unknown): Promise<{ status: number; contentType: string; text: string }> => {
        const res = await fetch(mcpBase, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${mcpToken}`,
            accept: 'application/json, text/event-stream',
            ...(mcpSessionHeader !== undefined ? { 'mcp-session-id': mcpSessionHeader } : {}),
          },
          body: JSON.stringify(body),
        });
        const header = res.headers.get('mcp-session-id');
        if (header !== null) mcpSessionHeader = header;
        return {
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          text: await res.text(),
        };
      };
      const mcpParse = (raw: { contentType: string; text: string }): unknown => {
        if (raw.contentType.includes('text/event-stream')) {
          const dataLines = raw.text.split('\n').filter((line) => line.startsWith('data:'));
          expect(dataLines.length).toBeGreaterThan(0);
          return JSON.parse((dataLines[dataLines.length - 1] as string).slice(5).trim());
        }
        return JSON.parse(raw.text);
      };
      const mcpCall = async (id: number, arguments_: Record<string, unknown>): Promise<McpCallPayload> => {
        const raw = await mcpPost({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'stone_update', arguments: arguments_ },
        });
        expect(raw.status).toBe(200);
        const body = mcpParse(raw) as { result?: { content?: Array<{ text: string }> }; error?: { message?: string } };
        if (body.error !== undefined) throw new Error(`MCP error：${body.error.message}`);
        return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as McpCallPayload;
      };
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e-s81', version: '0' } },
      });
      expect(init.status).toBe(200);
      await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
      // propose（字段级 diff 预览+approval-request）→ session.answer 批准 → execute（revision CAS）。
      const proposed = await mcpCall(2, {
        taskId,
        resourceId: yuhangJ51,
        patch: { color: { name: '暖珍珠白', rgb: [245, 242, 235] } },
        texture: { blobRef: replacement.blobRef, declaredWidth: 128, declaredHeight: 128 },
      });
      expect(proposed.kind).toBe('ok');
      expect(proposed.value?.proposalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(proposed.value?.requestId).toMatch(/^[0-9a-f-]{36}$/);
      const answered = await client.session.answer({
        sessionId,
        requestId: proposed.value!.requestId!,
        approved: true,
      });
      expect(answered.ok).toBe(true);
      const executed = await mcpCall(3, { taskId, proposalId: proposed.value!.proposalId });
      expect(executed.kind).toBe('ok');
      expect(executed.value).toMatchObject({ resourceId: yuhangJ51, revision: 2 });

      // 标准面真值已换；组合面零同步跟随（set.json 不动——成员富化读时解析）。
      const after = await client.stones.get({ resourceId: yuhangJ51 });
      expect(after.revision).toBe(2);
      expect(after.texture!.blobRef).toBe(replacement.blobRef);
      const followed = await client.sets.get({ resourceId: created.resourceId });
      expect(followed.revision).toBe(1); // set revision 只因 set.update 变——标准变化不触碰
      expect(followed.set.stones).toEqual(storedMembers); // set.json 内容零变更（引用集不变量）
      expect(followed.members[0]?.revision).toBe(2); // 成员富化=原子 revision 跟随
      expect(followed.members[0]?.stone?.color).toMatchObject({ name: '暖珍珠白', rgb: [245, 242, 235] });
      expect(followed.members[0]?.stone?.texture).toMatchObject({
        mime: 'image/png',
        width: 128,
        height: 128,
        alphaBounds: { x: 16, y: 16, w: 96, h: 96 }, // gate 实测入档（不信任声明）
      });
      expect(followed.members[1]?.stone?.color?.name).toBe('象牙白'); // factoryB 成员不受牵连
      const afterTexture = await fetch(`${base}${followed.members[0]!.textureUrl}?token=${encodeURIComponent(token)}`);
      expect(afterTexture.status).toBe(200);
      expect(afterTexture.headers.get('etag')).not.toBe(beforeEtag); // 同 URL 新内容（内容寻址 ETag=blob hash）
      const afterBytes = new Uint8Array(await afterTexture.arrayBuffer());
      expect(afterBytes[0]).toBe(0x89); // PNG 签名

      // ---- [5] 缺失态：trash yuhang/J51 → 组合成员 soft-deleted 呈现（不剔除）→ restore 复现
      const trashed = await client.stones.trash({ resourceId: yuhangJ51 });
      expect(trashed.trashedStones).toBe(1);
      const missing = await client.sets.get({ resourceId: created.resourceId });
      expect(missing.members).toHaveLength(2); // 缺失成员显式态（§7.1 不自动剔除）
      expect(missing.members[0]).toMatchObject({ state: 'soft-deleted', qualifiedSku: 'yuhang/J51', standardId: 'yuhang' });
      expect(missing.members[0]?.stone).toBeUndefined(); // 回收站内不物化 stone.json 真值
      expect(missing.revision).toBe(1); // 软删标准同样零触碰 set
      expect(missing.members[1]?.state).toBe('resolved');
      expect((await client.stones.list({ resourceIds: [yuhangJ51, factoryBJ51] })).total).toBe(1); // 投影面收敛到存活成员
      const restored = await client.stones.restore({ resourceId: yuhangJ51 });
      expect(restored.restoredStones).toBe(1);
      const back = await client.sets.get({ resourceId: created.resourceId });
      expect(back.members[0]).toMatchObject({ state: 'resolved', qualifiedSku: 'yuhang/J51' });
      expect(back.members[0]?.stone?.color?.name).toBe('暖珍珠白'); // 恢复后跟随真值仍在
      expect((await client.stones.list({ resourceIds: [yuhangJ51, factoryBJ51] })).total).toBe(2);

      ws.close();
    } finally {
      // SIGTERM 退出 + 双端口释放 + DATA_ROOT 清理 + mock 网关关闭（进程纪律）
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
      const released =
        (await waitUntil(() => portListeners(port).length === 0, 8000)) &&
        (await waitUntil(() => portListeners(mcpPort).length === 0, 8000));
      expect(released, `端口未释放（${port}/${mcpPort}）`).toBe(true);
      rmSync(root, { recursive: true, force: true });
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });
});
