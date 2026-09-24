/**
 * MCP 独立 loopback listener 测试（design §6.4 监听隔离——W4.1；协议 handler=
 * @modelcontextprotocol streamable-http 真实面）。覆盖：非 loopback 绑定必拒
 * （0.0.0.0/LAN IP）；loopback 三形态可绑；isLoopbackAddress 全覆盖（IPv4 127/8、
 * ::1、IPv4-mapped、非 loopback 各形态）；token 面（缺失/错误 401；正确→真实
 * MCP initialize 200 + serverInfo studio）；降级门（off/missing/error 终态 501、
 * booting/ready 放行——蛋鸡解耦）；token 落盘 0600；连接层 403（handler 级注入
 * 非 loopback remoteAddress）；stop 释放端口。
 * 进程纪律：每个用例显式 stop()。
 */
import { readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { isLoopbackAddress, McpListener, buildProcessToken, type McpListenerOptions } from '../src/mcp.js';
import { createCapabilityRegistry } from '../src/capability/core.js';
import { createStudioMcpServer } from '../src/capability/mcp.js';
import type { DshKernelState } from '../src/kernel/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

const noopHandle: McpListenerOptions['handle'] = async (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
};

const listeners: McpListener[] = [];

async function makeListener(
  kernelState: () => DshKernelState,
  options?: Partial<McpListenerOptions>,
): Promise<{ listener: McpListener; port: number; tokenFile: string; token: string }> {
  const tokenFile = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-test-')), 'mcp-token');
  const token = buildProcessToken();
  const listener = new McpListener({
    port: await freePort(),
    host: '127.0.0.1',
    kernelState,
    token,
    tokenFile,
    handle: noopHandle,
    ...options,
  });
  listeners.push(listener);
  const port = await listener.listen();
  return { listener, port, tokenFile, token };
}

afterAll(async () => {
  for (const listener of listeners.splice(0)) await listener.stop(500);
});

describe('isLoopbackAddress（IPv4/IPv6/IPv4-mapped 全覆盖——§6.4）', () => {
  it('loopback 形态全放行', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.2')).toBe(true);
    expect(isLoopbackAddress('127.255.0.3')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.3.4.5')).toBe(true);
  });

  it('非 loopback 全拒（含 IPv4-mapped 的非 loopback）', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('172.16.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('fe80::1')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
    expect(isLoopbackAddress('localhost')).toBe(false); // 主机名非地址（remoteAddress 不产出）
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('MCP listener 绑定与 token 面', () => {
  it('非 loopback 绑定必拒（0.0.0.0 / LAN IP / ::）', async () => {
    for (const host of ['0.0.0.0', '192.168.1.100', '10.1.2.3', '::']) {
      const listener = new McpListener({ port: await freePort(), host, kernelState: () => 'ready', handle: noopHandle });
      await expect(listener.listen()).rejects.toThrow(/非 loopback/);
    }
  });

  it('loopback 绑定（127.0.0.1/::1/localhost）+ 进程周期 token 落盘 0600', async () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const { port, tokenFile, token } = await makeListener(() => 'ready', { host });
      expect(port).toBeGreaterThan(0);
      expect(readFileSync(tokenFile, 'utf8').trim()).toBe(token);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    }
  });

  it('token 校验：缺失/错误 401；正确 + ready → 真实 MCP initialize 200（serverInfo studio）', async () => {
    const capabilities = createCapabilityRegistry([]);
    const mcpHandler = createMcpHandler(() => createStudioMcpServer({ capabilities }), { legacy: 'stateless' });
    const { port, token } = await makeListener(() => 'ready', { handle: toNodeHandler(mcpHandler) });
    const base = `http://127.0.0.1:${port}`;

    const noToken = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(noToken.status).toBe(401);
    const badToken = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${buildProcessToken()}` },
      body: '{}',
    });
    expect(badToken.status).toBe(401);

    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(init.status).toBe(200);
    const body = await init.text();
    expect(body).toContain('"studio"'); // serverInfo.name
  });

  it('降级门：终态 off/missing/error 与 unbooted → 501；booting/ready 放行（蛋鸡解耦）', async () => {
    // unbooted（W4.1 R2 P1-1）：mcp.listen 先于 kernel.boot 的启动窗口——内核
    // 尚未开始 boot，MCP 面不得执行，与终态降级同为 501。
    for (const state of ['off', 'missing', 'error', 'unbooted'] as const) {
      const { port, token } = await makeListener(() => state);
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      });
      expect(res.status).toBe(501);
      expect(await res.text()).toContain(state);
    }
    for (const state of ['booting', 'ready'] as const) {
      const { port, token } = await makeListener(() => state);
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      });
      expect(res.status).toBe(200); // noop handle
    }
  });

  it('token 权限收敛（W4.1 R2 P1-2）：预存 0644 文件 listen 后强制 0600 且内容轮换', async () => {
    // 不经 makeListener（其构造即 listen——时序上无法在 listen 前预置文件）；
    // 手工装配：预置历史遗留宽松权限文件（POSIX 下 writeFileSync 的 mode 不改
    // 已有文件——必须显式 chmod 收敛；探针复现：修复前该文件保持 0644）。
    const tokenFile = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-mode-')), 'mcp-token');
    writeFileSync(tokenFile, 'stale-token\n', { mode: 0o644 });
    chmodSync(tokenFile, 0o644);
    const listener = new McpListener({
      port: await freePort(),
      host: '127.0.0.1',
      kernelState: () => 'ready',
      token: buildProcessToken(),
      tokenFile,
      handle: noopHandle,
    });
    listeners.push(listener);
    await listener.listen();
    expect((statSync(tokenFile).mode & 0o777).toString(8)).toBe('600');
    expect(readFileSync(tokenFile, 'utf8')).not.toContain('stale-token'); // 进程周期 token 已覆写
  });

  it('连接层 403：handler 级注入非 loopback remoteAddress（真实 socket 由绑定层结构性保证）', async () => {
    const { listener, token } = await makeListener(() => 'ready');
    const server = (listener as unknown as { server: http.Server | null }).server as http.Server;
    const invoke = (remote: string): Promise<{ status: number | undefined; body: string }> =>
      new Promise((resolve) => {
        const fakeSocket = { remoteAddress: remote } as Socket;
        const fakeRequest = new http.IncomingMessage(fakeSocket);
        fakeRequest.url = '/mcp';
        fakeRequest.method = 'POST';
        fakeRequest.headers = { authorization: `Bearer ${token}` };
        const status = { value: undefined as number | undefined };
        const fakeResponse = {
          headersSent: false,
          writeHead(code: number) {
            status.value = code;
          },
          end(body: string) {
            resolve({ status: status.value, body });
          },
        } as unknown as http.ServerResponse;
        server.emit('request', fakeRequest, fakeResponse);
      });
    const verdict = await invoke('192.168.1.5');
    expect(verdict.status).toBe(403);
    expect(verdict.body).toContain('loopback');
    // 对照：IPv4-mapped loopback remote 不被连接层拒。
    const pass = await invoke('::ffff:127.0.0.1');
    expect(pass.status).not.toBe(403);
  });

  it('stop 释放端口（无孤儿监听）', async () => {
    const { listener, port } = await makeListener(() => 'ready');
    await listener.stop(500);
    await sleep(150);
    const probe = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }).catch(() => null);
    expect(probe).toBeNull(); // 连接被拒=监听已关
  });
});
