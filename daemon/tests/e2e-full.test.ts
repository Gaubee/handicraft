/**
 * W2.4 E2E 全链（zhumo w7b 模式——起 daemon→匿名登录→上传→生成 dry-run→帧流收帧→
 * 排钻→导出 SVG/BOM/PNG→分享页断言→SIGTERM 退出）。daemon 托管**真实
 * rhinestone-studio/dist**（worktree 内构建产物——SPA 集成验证：入口/资产/回退）。
 * 进程纪律：直跑 node --import tsx（pid 即 daemon）；收尾显式 SIGTERM 并断言退出+端口释放。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import { describe, expect, it } from 'vitest';
import type { Frame } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(daemonDir, '..');
const realDist = path.join(repoRoot, 'rhinestone-studio', 'dist');

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

/** E2E 上传图：160×120 左红右蓝两块（segment 两块，hex-pitch 出钻）。 */
function e2eImagePng(): Buffer {
  const w = 160;
  const h = 120;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (x < w / 2) {
        rgba[p] = 200; rgba[p + 1] = 16; rgba[p + 2] = 46;
      } else {
        rgba[p] = 230; rgba[p + 1] = 160; rgba[p + 2] = 23;
      }
      rgba[p + 3] = 255;
    }
  }
  return Buffer.from(encodePng(w, h, rgba));
}

/** /ws/tasks/:id 收帧直到终态或条件满足。 */
function collectFrames(
  base: string,
  token: string,
  taskId: string,
  afterSeq: number,
  until: (frames: Frame[]) => boolean,
  timeoutMs: number,
): Promise<{ frames: Frame[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/ws/tasks/${encodeURIComponent(taskId)}?after_seq=${afterSeq}&token=${encodeURIComponent(token)}`,
    );
    const frames: Frame[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`E2E 帧流等待超时（已收 ${frames.length} 帧）`));
    }, timeoutMs);
    ws.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)) as Frame);
        if (until(frames)) {
          clearTimeout(timer);
          // 快照：resolve 后仍可能有在途消息推入 frames（close 握手完成前）——
          // 只以触发时刻的窗口为重连游标，避免与下一段重放重叠
          resolve({ frames: [...frames], ws });
        }
      } catch {
        // 畸形帧丢弃
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('W2.4 E2E 全链（真实 dist 托管）', () => {
  it('起 daemon→匿名→上传→生成 dry-run→帧流→排钻→导出→分享页→SIGTERM', { timeout: 120000 }, async () => {
    expect(realDist).toContain('rhinestone-studio');
    const root = mkdtempSync(path.join(tmpdir(), 'handicraft-e2e-full-'));
    const dataRoot = path.join(root, 'data');
    const envFile = path.join(root, 'env');
    mkdirSync(dataRoot, { recursive: true });
    let port = 18400 + Math.floor(Math.random() * 400);
    for (let i = 0; i < 20 && portListeners(port).length > 0; i++) {
      port = 18400 + Math.floor(Math.random() * 400);
    }
    writeFileSync(
      envFile,
      [
        'JWT_SECRET=e2e-full-secret',
        `DATA_ROOT=${dataRoot}`,
        `WEBUI_DIR=${realDist}`,
        'HOST=127.0.0.1',
        `PORT=${port}`,
        'IMG_DRY_RUN=1',
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

      // ---- dist 托管集成验证（真实构建产物）
      const indexHtml = await fetch(`${base}/`);
      expect(indexHtml.status).toBe(200);
      const html = await indexHtml.text();
      expect(html).toContain('贴钻工作台'); // 真实 SPA 入口
      const assetMatch = /src="\.\/(assets\/[^"]+\.js)"/.exec(html);
      expect(assetMatch).not.toBeNull();
      const asset = await fetch(`${base}/${assetMatch![1]}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toContain('javascript');
      const deep = await fetch(`${base}/studio/deep/route`);
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain('贴钻工作台'); // SPA 回退同入口

      // ---- 匿名登录 + RPC over WS
      const login = await fetch(`${base}/api/auth/anonymous`, { method: 'POST' });
      const { token } = (await login.json()) as { token: string };
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`);
      const client = createORPCClient(new RPCLink({ websocket: ws as unknown as WebSocket })) as {
        bootstrap(): Promise<{ imgDryRun: boolean; version: string }>;
        assets: { upload(input: { filename: string; dataBase64: string }): Promise<{ blobRef: string; size: number }> };
        tasks: {
          create(input: { kind: string; params: unknown }): Promise<{ taskId: string; status: string }>;
          get(input: { taskId: string }): Promise<{ task: { status: string; result?: { publicId?: string; bundle: { svg: string; bom: string; png: string } } } }>;
          frames(input: { taskId: string; afterSeq: number }): Promise<{ frames: Frame[]; nextSeq: number }>;
        };
      };
      const boot = await client.bootstrap();
      expect(boot.imgDryRun).toBe(true);

      // ---- 上传 fixture PNG
      const imageBytes = e2eImagePng();
      const uploaded = await client.assets.upload({
        filename: 'e2e-two-color.png',
        dataBase64: imageBytes.toString('base64'),
      });
      expect(uploaded.blobRef).toMatch(/^[0-9a-f]{64}$/);

      // ---- 生成 dry-run 任务 + /ws/tasks/:id 帧流（断线重连带 after_seq 续收）
      const gen = await client.tasks.create({
        kind: 'generate',
        params: { prompt: 'E2E 红蓝贴钻', size: '512x512' },
      });
      const first = await collectFrames(base, token, gen.taskId, 0, (fs) => fs.length >= 2, 10000);
      first.ws.close();
      const lastSeq = first.frames[first.frames.length - 1]!.seq;
      const second = await collectFrames(
        base,
        token,
        gen.taskId,
        lastSeq,
        (fs) => [...first.frames, ...fs].some((f) => f.kind === 'done'),
        15000,
      );
      second.ws.close();
      const merged = [...first.frames, ...second.frames];
      const seqs = merged.map((f) => f.seq);
      expect(new Set(seqs).size).toBe(seqs.length); // 无重复
      expect(seqs).toContain(1);
      expect(merged.some((f) => f.kind === 'artifact')).toBe(true); // 假结果 blob 帧

      // ---- 排钻（hex-pitch）→ 导出（SVG/BOM/PNG）
      const pave = await client.tasks.create({
        kind: 'engine',
        params: {
          op: 'pave',
          imageRef: uploaded.blobRef,
          strategy: 'hex-pitch',
          gapMm: 0.4,
          spec: { shapeId: 'round', diameterMm: 3 },
        },
      });
      const paveDone = await waitUntil(
        async () => (await client.tasks.get({ taskId: pave.taskId })).task.status === 'done',
        20000,
      );
      expect(paveDone).toBe(true);

      const exportTask = await client.tasks.create({
        kind: 'engine',
        params: { op: 'export', paveTaskId: pave.taskId },
      });
      const exportDone = await waitUntil(async () => {
        const { task } = await client.tasks.get({ taskId: exportTask.taskId });
        return task.status === 'done' || task.status === 'failed';
      }, 25000);
      expect(exportDone).toBe(true);
      const { task: exportView } = await client.tasks.get({ taskId: exportTask.taskId });
      expect(exportView.status).toBe('done');
      const result = exportView.result!;
      expect(result.publicId).toMatch(/^[A-Za-z0-9]{12}$/);

      // ---- 分享页断言：HTML + 三产物下载 + Range 206 + containment
      const page = await fetch(`${base}/r/${result.publicId}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('下载 PNG');
      const svg = await fetch(`${base}/r/${result.publicId}/files/svg`);
      expect(svg.status).toBe(200);
      expect(await svg.text()).toContain('<svg');
      const png = await fetch(`${base}/r/${result.publicId}/files/png`);
      expect(png.headers.get('content-type')).toBe('image/png');
      const pngBytes = new Uint8Array(await png.arrayBuffer());
      expect(pngBytes[0]).toBe(0x89); // PNG 签名
      const rangeRes = await fetch(`${base}/r/${result.publicId}/files/png`, {
        headers: { Range: 'bytes=0-15' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 0-15/${pngBytes.byteLength}`);
      const traversal = await fetch(`${base}/r/x/files/..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd`);
      expect(traversal.status).toBe(403);
      expect((await fetch(`${base}/r/nope`)).status).toBe(404);

      ws.close();
    } finally {
      // SIGTERM 退出 + 端口释放（进程纪律）
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
