/**
 * W1.3 E2E 冒烟（zhumo w7b 模式）：起 daemon（随机端口）→ HTTP 探活 → 匿名登录
 * 拿 JWT → bootstrap 断言 → SPA 回退断言 → **进程退出**。
 * 另覆盖 spec「dist 缺失显式失败」场景：无 dist 时启动以明确错误退出（含构建指引）。
 *
 * 进程纪律：直跑 `node --import tsx src/index.ts`（无 pnpm 中间层，pid 即 daemon），
 * 测试收尾显式 kill 并断言端口释放；dist 缺失分支断言非零退出码。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jwtVerify } from 'jose';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Sandbox {
  root: string;
  envFile: string;
  dataRoot: string;
  webuiDir: string;
  port: number;
}

const sandboxes: Sandbox[] = [];
const children: ChildProcess[] = [];

function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'handicraft-e2e-'));
  const dataRoot = path.join(root, 'data');
  const webuiDir = path.join(root, 'dist');
  const envFile = path.join(root, 'env');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(webuiDir, { recursive: true });
  writeFileSync(path.join(webuiDir, 'index.html'), '<!doctype html><title>e2e-spa</title>');
  // 随机端口 + 已占用跳过（避让本机常驻服务——如 ai-fly:8790，非本测试进程）
  let port = 8400 + Math.floor(Math.random() * 400);
  for (let i = 0; i < 20 && portListeners(port).length > 0; i++) {
    port = 8400 + Math.floor(Math.random() * 400);
  }
  const sandbox: Sandbox = { root, envFile, dataRoot, webuiDir, port };
  sandboxes.push(sandbox);
  return sandbox;
}

function writeEnv(sandbox: Sandbox, overrides: Record<string, string> = {}): void {
  const lines = [
    'JWT_SECRET=e2e-secret',
    `DATA_ROOT=${sandbox.dataRoot}`,
    `WEBUI_DIR=${sandbox.webuiDir}`,
    'HOST=127.0.0.1',
    `PORT=${sandbox.port}`,
    ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`),
    '',
  ];
  writeFileSync(sandbox.envFile, lines.join('\n'));
}

/** 直跑 daemon（node --import tsx——pid 即 daemon 进程，无 pnpm 孙进程链）。 */
function spawnDaemon(sandbox: Sandbox): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: daemonDir,
    env: { ...process.env, HANDICRAFT_ENV: sandbox.envFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function killDaemon(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {
    // 已退出
  }
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(300);
  }
  return false;
}

afterEach(() => {
  for (const child of children.splice(0)) killDaemon(child);
});

afterAll(async () => {
  // 收尾兜底：全部子进程已逐测试 kill；此处等端口释放 + 清沙箱。
  for (const sandbox of sandboxes.splice(0)) {
    await waitUntil(() => Promise.resolve(portListeners(sandbox.port).length === 0), 5000);
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

describe('W1.3 E2E 冒烟（起 daemon→探活→匿名→bootstrap→退出）', () => {
  it('全链：bootstrap 版本+配置状态、匿名 JWT 可验签、SPA 回退、未知 API 404、进程退出', { timeout: 60000 }, async () => {
    const sandbox = makeSandbox();
    writeEnv(sandbox);
    const child = spawnDaemon(sandbox);
    expect(child.pid).toBeDefined();
    const pid = child.pid!;

    // 探活：/api/bootstrap 200
    const base = `http://127.0.0.1:${sandbox.port}`;
    const up = await waitUntil(async () => {
      try {
        const res = await fetch(`${base}/api/bootstrap`);
        return res.ok;
      } catch {
        return false;
      }
    }, 20000);
    expect(up, 'daemon 在 20s 内探活失败').toBe(true);

    const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as Record<string, unknown>;
    expect(boot.version).toBe('0.1.0');
    expect(boot.allow_anonymous).toBe(true); // 默认开（Owner 裁决）
    expect(boot.admin_configured).toBe(false);
    expect(boot.img_configured).toBe(false);
    expect(boot.llm_configured).toBe(false);

    // 匿名登录拿 JWT
    const login = await fetch(`${base}/api/auth/anonymous`, { method: 'POST' });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { token: string; expires_at: number; user: { id: string; role: string } };
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.user.role).toBe('anonymous');
    // 服务端密钥可验签（payload {sub, role}）
    const verified = await jwtVerify(body.token, new TextEncoder().encode('e2e-secret'));
    expect(verified.payload.sub).toBe(body.user.id);
    expect(verified.payload.role).toBe('anonymous');

    // SPA：/ 与无点路径回退 index.html；静态资产命中；未知 API 显式 404
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('e2e-spa');
    const deep = await fetch(`${base}/some/deep/route`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('e2e-spa');
    const missingApi = await fetch(`${base}/api/nope`);
    expect(missingApi.status).toBe(404);

    // 匿名关（env 显式 0）→ 403（同一 daemon 沙箱新端口快速复证）
    const sandbox2 = makeSandbox();
    writeEnv(sandbox2, { ALLOW_ANONYMOUS: '0' });
    const child2 = spawnDaemon(sandbox2);
    expect(child2.pid).toBeDefined();
    const base2 = `http://127.0.0.1:${sandbox2.port}`;
    const up2 = await waitUntil(async () => {
      try {
        return (await fetch(`${base2}/api/bootstrap`)).ok;
      } catch {
        return false;
      }
    }, 20000);
    expect(up2).toBe(true);
    const denied = await fetch(`${base2}/api/auth/anonymous`, { method: 'POST' });
    expect(denied.status).toBe(403);

    // 进程退出：SIGTERM 后 daemon 退出、端口释放
    killDaemon(child);
    killDaemon(child2);
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (c) => resolve(c));
      setTimeout(() => resolve(null), 8000);
    });
    expect(code).not.toBeNull();
    const released = await waitUntil(() => Promise.resolve(portListeners(sandbox.port).length === 0), 5000);
    expect(released, `端口 ${sandbox.port} 未释放`).toBe(true);
  });

  it('dist 缺失：启动以明确错误退出（构建指引文案，不静默起服）', { timeout: 30000 }, async () => {
    const sandbox = makeSandbox();
    // 沙箱自带 dist——显式指到不存在目录
    writeEnv(sandbox, { WEBUI_DIR: path.join(sandbox.root, 'no-dist') });
    const child = spawnDaemon(sandbox);
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let err = '';
      child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
      child.once('exit', (c) => resolve({ code: c, stderr: err }));
      setTimeout(() => resolve({ code: null, stderr: err }), 20000);
    });
    expect(code).not.toBe(0); // 非零退出
    expect(code).not.toBeNull();
    const output = stderr + '';
    expect(output).toContain('前端构建产物缺失');
    expect(output).toContain('pnpm build');
  });
});
