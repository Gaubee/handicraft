/**
 * 降级四态 E2E（design §6.4——W4.1 测试门）：每态**独立 daemon 子进程**（真实
 * 启动路径：tsx src/index.ts）+ 全链断言。
 *   ① DSH_ENABLED=0 → boot 日志降级（off）+ followup 501 + 基础工作流全链绿
 *   ② 缺包/坏包 → DSH_MODULE_ROOT=隔离模块解析根（bareModuleBaseUrl——裸包名
 *     全部从临时根解析）：②a 缺包（符号链接树缺 dsh-base）/②b 坏包（dsh-base
 *     入口语法破坏）→ boot 降级（missing）+ reason 点名包 + followup 501 +
 *     基础工作流全链绿。**独立进程+隔离模块解析器实测**（boot throw 不可替代
 *     ——静态/解析失败走 loader 的 bareModuleBaseUrl 路径）。
 *   ③ boot throw（运行时挂载异常）→ LLM_API=anthropic-messages（boot 期组装
 *     拒绝——模块已载入后的配置组装错误）→ 降级（error）+ followup 501 + 基础绿
 *   ④ 正常 → mock openai-completions 网关（本测试进程内 127.0.0.1——确定性
 *     替身，零真实外呼）→ followup 全链（帧流+task done）+ 基础工作流全链绿 +
 *     MCP 环回断言（token 401/501/initialize 200 + LAN 不可达——主 HTTP 可 LAN）
 * 基础工作流全链=上传→生成 dry-run→排钻→导出→分享页（e2e-full 同链压缩版）。
 * 进程纪律：每态 spawn 独立 daemon；finally 显式 SIGTERM+等退出+端口释放断言。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
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
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
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

/** mock openai-completions 网关（④态确定性模型替身——零真实外呼）。 */
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
      const text = '（mock 网关确定性回复：贴钻助手已收到你的消息。）';
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
 * ②态隔离模块解析根：符号链接真实包（内部裸导入仍按 realpath 解析到真实
 * .pnpm 树——instanceof 一致），**行包**（loader 按名导入的插件包）缺失
 * （mode=missing）或入口语法破坏（mode=broken）。bareModuleBaseUrl 使 loader
 * 的全部裸包名从该根解析——破坏只发生在临时根内，仓库 node_modules 不动。
 * 受害者=@deepseek-ai/dsh-agent-loop（bundle 行包+required 启动集成员——
 * 其导入失败必然打穿 boot，不静默半死树）。
 */
function buildIsolatedModuleRoot(mode: 'missing' | 'broken'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-module-root-'));
  const scopeDir = path.join(root, '@deepseek-ai');
  mkdirSync(scopeDir, { recursive: true });
  const realScope = path.join(daemonDir, 'node_modules', '@deepseek-ai');
  const victim = 'dsh-agent-loop';
  for (const name of readdirSync(realScope)) {
    const target = path.join(realScope, name);
    if (!lstatSync(target).isSymbolicLink() && !existsSync(path.join(target, 'package.json'))) continue;
    if (name === victim) {
      if (mode === 'missing') continue; // 整包缺席
      // broken：真实拷贝 + 入口语法破坏（解析期失败——非 boot throw）。
      const copy = path.join(scopeDir, name);
      cpSync(target, copy, { recursive: true, verbatimSymlinks: true });
      rmSync(path.join(copy, 'lib'), { recursive: true, force: true });
      mkdirSync(path.join(copy, 'lib'), { recursive: true });
      writeFileSync(path.join(copy, 'lib', 'index.js'), 'this is ( definitely not valid js {{{', 'utf8');
      continue;
    }
    symlinkSync(target, path.join(scopeDir, name), 'dir');
  }
  return root;
}

interface DaemonHandle {
  child: ChildProcess;
  pid: number;
  port: number;
  mcpPort: number;
  base: string;
  stdout: string;
  stderr: string;
  root: string;
  stop(): Promise<void>;
}

interface SpawnOptions {
  env?: Record<string, string>;
  host?: string;
}

/** spawn 独立 daemon（真实启动路径）。 */
function spawnDaemon(options: SpawnOptions = {}): DaemonHandle {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-kernel-'));
  const dataRoot = path.join(root, 'data');
  const envFile = path.join(root, 'env');
  mkdirSync(dataRoot, { recursive: true });
  let port = 19100 + Math.floor(Math.random() * 400);
  for (let i = 0; i < 20 && portListeners(port).length > 0; i += 1) {
    port = 19100 + Math.floor(Math.random() * 400);
  }
  let mcpPort = 19500 + Math.floor(Math.random() * 400);
  for (let i = 0; i < 20 && portListeners(mcpPort).length > 0; i += 1) {
    mcpPort = 19500 + Math.floor(Math.random() * 400);
  }
  writeFileSync(
    envFile,
    [
      'JWT_SECRET=e2e-kernel-secret',
      `DATA_ROOT=${dataRoot}`,
      `WEBUI_DIR=${realDist}`,
      `HOST=${options.host ?? '127.0.0.1'}`,
      `PORT=${port}`,
      `MCP_PORT=${mcpPort}`,
      'IMG_DRY_RUN=1',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: daemonDir,
    env: { ...process.env, HANDICRAFT_ENV: envFile, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid as number;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return {
    child,
    pid,
    port,
    mcpPort,
    base: `http://127.0.0.1:${port}`,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    root,
    stop: async () => {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 已退出
      }
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(() => resolve(), 10000);
      });
      const released =
        (await waitUntil(() => portListeners(port).length === 0, 8000)) &&
        (await waitUntil(() => portListeners(mcpPort).length === 0, 8000));
      expect(released, `端口未释放（${port}/${mcpPort}）：${stderr}`).toBe(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface E2eClient {
  bootstrap(): Promise<{ imgDryRun: boolean }>;
  assets: { upload(input: { filename: string; dataBase64: string }): Promise<{ blobRef: string }> };
  tasks: {
    create(input: { kind: string; params: unknown }): Promise<{ taskId: string }>;
    get(input: { taskId: string }): Promise<{ task: { status: string; result?: { publicId?: string } } }>;
    frames(input: { taskId: string; afterSeq: number }): Promise<{ frames: Frame[]; nextSeq: number }>;
  };
  session: {
    create(input: { title?: string }): Promise<{ sessionId: string }>;
    followup(input: { sessionId: string; text: string }): Promise<{ taskId: string }>;
    replay(input: { sessionId: string; taskId: string; afterSeq: number }): Promise<{ frames: Frame[]; nextSeq: number }>;
  };
}

async function connect(d: DaemonHandle): Promise<{ client: E2eClient; token: string; ws: WebSocket; close(): void }> {
  const up = await waitUntil(async () => {
    try {
      return (await fetch(`${d.base}/api/bootstrap`)).ok;
    } catch {
      return false;
    }
  }, 30000);
  expect(up, `daemon 探活失败：${d.stderr}`).toBe(true);
  const login = await fetch(`${d.base}/api/auth/anonymous`, { method: 'POST' });
  const { token } = (await login.json()) as { token: string };
  const ws = new WebSocket(`${d.base.replace('http', 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client = createORPCClient(new RPCLink({ websocket: ws as unknown as WebSocket })) as unknown as E2eClient;
  return {
    client,
    token,
    ws,
    close: () => ws.close(),
  };
}

/** 基础工作流全链（§6.4 前三态断言门）：上传→生成 dry-run→排钻→导出→分享页。 */
async function basicWorkflowAllGreen(conn: { client: E2eClient; close(): void }, d: DaemonHandle): Promise<void> {
  const { client } = conn;
  const boot = await client.bootstrap();
  expect(boot.imgDryRun).toBe(true);
  const imageBytes = e2eImagePng();
  const uploaded = await client.assets.upload({ filename: 'e2e.png', dataBase64: imageBytes.toString('base64') });
  expect(uploaded.blobRef).toMatch(/^[0-9a-f]{64}$/);
  const gen = await client.tasks.create({ kind: 'generate', params: { prompt: '四态 E2E', size: '512x512' } });
  const genDone = await waitUntil(
    async () => (await client.tasks.get({ taskId: gen.taskId })).task.status === 'done',
    20000,
  );
  expect(genDone).toBe(true);
  const pave = await client.tasks.create({
    kind: 'engine',
    params: { op: 'pave', imageRef: uploaded.blobRef, strategy: 'hex-pitch', gapMm: 0.4, spec: { shapeId: 'round', diameterMm: 3 } },
  });
  const paveDone = await waitUntil(async () => (await client.tasks.get({ taskId: pave.taskId })).task.status === 'done', 20000);
  expect(paveDone).toBe(true);
  const exportTask = await client.tasks.create({ kind: 'engine', params: { op: 'export', paveTaskId: pave.taskId } });
  const exportDone = await waitUntil(
    async () => ['done', 'failed'].includes((await client.tasks.get({ taskId: exportTask.taskId })).task.status),
    25000,
  );
  expect(exportDone).toBe(true);
  const { task: exportView } = await client.tasks.get({ taskId: exportTask.taskId });
  expect(exportView.status).toBe('done');
  const publicId = exportView.result?.publicId ?? '';
  expect(publicId).toMatch(/^[A-Za-z0-9]{12}$/);
  const page = await fetch(`${d.base}/r/${publicId}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('下载 PNG');
  const svg = await fetch(`${d.base}/r/${publicId}/files/svg`);
  expect(await svg.text()).toContain('<svg');
}

/** 降级断言门：agent 面 501 + 基础全链绿 + boot 日志点名。 */
async function assertDegraded(conn: { client: E2eClient }, d: DaemonHandle, state: string, reasonFragment: string): Promise<void> {
  const combined = () => `${d.stdout}\n${d.stderr}`;
  const degraded = await waitUntil(() => combined().includes(`dsh 内核降级（${state}）`), 15000);
  expect(degraded, `boot 日志未见降级（${state}）：${combined()}`).toBe(true);
  expect(combined()).toContain(reasonFragment);
  const { sessionId } = await conn.client.session.create({ title: `态${state}` });
  await expect(conn.client.session.followup({ sessionId, text: '你好' })).rejects.toMatchObject({
    code: 'NOT_IMPLEMENTED',
  });
  await expect(
    fetch(`http://127.0.0.1:${d.mcpPort}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readFileSync(path.join(d.root, 'data', 'mcp-token'), 'utf8').trim()}` },
      body: '{}',
    }).then((r) => r.status),
  ).resolves.toBe(501); // MCP 面随内核降级
  await basicWorkflowAllGreen(conn as { client: E2eClient; close(): void }, d);
}

describe('W4.1 降级四态 E2E（design §6.4——独立 daemon 子进程）', () => {
  it('态① DSH off：显式关闭——agent 面 501 + 基础工作流全链绿', { timeout: 180000 }, async () => {
    const d = spawnDaemon({ env: { DSH_ENABLED: '0' } });
    try {
      const conn = await connect(d);
      try {
        await assertDegraded(conn, d, 'off', 'DSH_ENABLED=0');
      } finally {
        conn.close();
      }
    } finally {
      await d.stop();
    }
  });

  it('态②a 缺包：隔离模块解析根（bareModuleBaseUrl）缺 dsh-agent-loop——missing 降级', { timeout: 180000 }, async () => {
    const moduleRoot = buildIsolatedModuleRoot('missing');
    const d = spawnDaemon({ env: { DSH_MODULE_ROOT: moduleRoot } });
    try {
      const conn = await connect(d);
      try {
        await assertDegraded(conn, d, 'missing', 'dsh-agent-loop');
      } finally {
        conn.close();
      }
    } finally {
      await d.stop();
      rmSync(moduleRoot, { recursive: true, force: true });
    }
  });

  it('态②b 坏包：dsh-agent-loop 入口语法破坏（解析期失败≠boot throw）——missing 降级', { timeout: 180000 }, async () => {
    const moduleRoot = buildIsolatedModuleRoot('broken');
    const d = spawnDaemon({ env: { DSH_MODULE_ROOT: moduleRoot } });
    try {
      const conn = await connect(d);
      try {
        await assertDegraded(conn, d, 'missing', 'dsh-agent-loop');
      } finally {
        conn.close();
      }
    } finally {
      await d.stop();
      rmSync(moduleRoot, { recursive: true, force: true });
    }
  });

  it('态③ boot throw：LLM_API 配置错误（模块载入后组装拒绝）——error 降级', { timeout: 180000 }, async () => {
    const d = spawnDaemon({ env: { LLM_API_KEY: 'k', LLM_API: 'anthropic-messages' } });
    try {
      const conn = await connect(d);
      try {
        await assertDegraded(conn, d, 'error', 'openai-completions');
      } finally {
        conn.close();
      }
    } finally {
      await d.stop();
    }
  });

  it('态④ 正常：mock 网关 followup 全链 + 基础全链 + MCP 环回（token/401/initialize/LAN 隔离）', { timeout: 240000 }, async () => {
    const gateway = await startMockGateway();
    const d = spawnDaemon({
      env: {
        LLM_PROVIDER: 'zai',
        LLM_API: 'openai-completions',
        LLM_MODEL: 'glm-5.3-flash',
        LLM_API_KEY: 'mock-key',
        LLM_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      },
      host: '0.0.0.0', // 主 HTTP 开 LAN——验证 MCP 不随行暴露（§6.4）
    });
    try {
      const ready = await waitUntil(() => d.stdout.includes('dsh 内核就绪'), 30000);
      expect(ready, `内核未就绪：${d.stdout}\n${d.stderr}`).toBe(true);
      expect(d.stdout).toContain('openai-completions');
      const conn = await connect(d);
      try {
        // followup 全链：taskId → 帧流（transcript user/assistant + done）→ task done。
        const { sessionId } = await conn.client.session.create({ title: '④态' });
        const { taskId } = await conn.client.session.followup({ sessionId, text: '帮我排个钻' });
        const framesDone = await waitUntil(async () => {
          const { frames } = await conn.client.tasks.frames({ taskId, afterSeq: 0 });
          return frames.some((f) => f.kind === 'done' || f.kind === 'error');
        }, 60000);
        expect(framesDone, `帧流未到终态：${d.stdout}\n${d.stderr}`).toBe(true);
        const { frames } = await conn.client.tasks.frames({ taskId, afterSeq: 0 });
        const transcripts = frames.filter((f) => f.kind === 'transcript') as unknown as Array<{ payload: { role: string; text: string } }>;
        expect(transcripts[0]?.payload.role).toBe('user');
        expect(transcripts.find((t) => t.payload.role === 'assistant')?.payload.text).toContain('mock 网关确定性回复');
        expect(frames[frames.length - 1]?.kind).toBe('done');
        const taskDone = await waitUntil(async () => (await conn.client.tasks.get({ taskId })).task.status === 'done', 15000);
        expect(taskDone).toBe(true);
        // 回放同构。
        const replay = await conn.client.session.replay({ sessionId, taskId, afterSeq: 0 });
        expect(replay.frames.length).toBe(frames.length);
        // 基础工作流同样全链绿（agent 面与基础面共存）。
        await basicWorkflowAllGreen(conn, d);
      } finally {
        conn.close();
      }
      // MCP 环回断言：token 401 / 无 token 401 / 有 token initialize 200（serverInfo studio）。
      const token = readFileSync(path.join(d.root, 'data', 'mcp-token'), 'utf8').trim();
      const mcpBase = `http://127.0.0.1:${d.mcpPort}`;
      expect(
        (await fetch(`${mcpBase}/mcp`, { method: 'POST', body: '{}' })).status,
      ).toBe(401);
      expect(
        (await fetch(`${mcpBase}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status,
      ).toBe(401);
      const init = await fetch(`${mcpBase}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
        }),
      });
      expect(init.status).toBe(200);
      expect(await init.text()).toContain('"studio"');
      // LAN 隔离（§6.4）：主 HTTP HOST=0.0.0.0 可 LAN 达；MCP 只绑 loopback——LAN 地址连接必拒。
      const lanIp = lanAddressOf();
      if (lanIp !== null) {
        const mainViaLan = await fetch(`http://${lanIp}:${d.port}/api/bootstrap`);
        expect(mainViaLan.status).toBe(200); // 主 HTTP 从 LAN 可达
        const mcpViaLan = await fetch(`http://${lanIp}:${d.mcpPort}/mcp`, { method: 'POST', body: '{}' }).catch(() => null);
        expect(mcpViaLan).toBeNull(); // ECONNREFUSED——MCP 未绑 LAN（不以 token 替代 loopback 声明）
      }
    } finally {
      await d.stop();
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });
});

/** 本机 LAN IPv4（无则 null——离线环境下 LAN 断言优雅跳过）。 */
function lanAddressOf(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}
