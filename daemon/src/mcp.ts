/**
 * MCP 独立 loopback listener（design §2 MCP 行 + §6.4 监听隔离——W4.1；
 * 协议 handler 照 shufa-server 的 createMcpHandler/toNodeHandler 组合）。
 * 原始需求 2026-09-23：streamable-http 环回（Bearer 进程周期 token，仅 loopback）。
 * 监听隔离（§6.4 R2 裁决）：**独立 listener + 专用端口**（与主 HTTP daemon 分离
 * ——shufa 挂主 HTTP /mcp 的形态按本仓冻结契约改为独立监听）——HOST=0.0.0.0
 * 开局域网只暴露主 HTTP，MCP 永不随行暴露；不以 bearer token 替代 loopback 声明。
 * 双层强制：
 *   [1] 绑定层：MCP_HOST 非 loopback（127.0.0.1/::1/localhost）→ listen 直接拒绝
 *       （配置错误启动期暴露，不留运行期静默）。
 *   [2] 连接层：remoteAddress 非 loopback（IPv4 127/8、IPv6 ::1、IPv4-mapped
 *       ::ffff:127.x.x.x 全覆盖）→ 403 拒服务（双栈绑定的纵深防御）。
 * 进程周期 token：daemon 启动生成一次，进程存活期复用；写入
 * DATA_ROOT/mcp-token（0600，每启动覆写——本地 MCP 客户端的机器可读面，
 * 等价于本机进程泄露面，不做轮换——design §7 开放项维持）。
 * 降级门（§6.4）：内核未就绪 → /mcp 501（agent 面 MCP 端点随内核降级）。
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DshKernelState } from './kernel/index.js';

/** 允许绑定的 loopback 主机名（§6.4：非 loopback 绑定必拒）。 */
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** remoteAddress 是否 loopback（IPv4 127/8 + IPv6 ::1 + IPv4-mapped 全覆盖）。 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  let addr = remoteAddress;
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length); // IPv4-mapped 归一
  if (addr === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return true;
  return false;
}

export interface McpListenerOptions {
  /** 专用端口（与主 HTTP 分离——config.mcpPort）。 */
  port: number;
  /** 绑定主机（非 loopback → listen 拒绝）。 */
  host: string;
  /** 进程周期 token（缺省现场生成——见 buildProcessToken）。 */
  token?: string;
  /** 内核状态探针（agent 面门：非 ready → 501 呈现降级）。 */
  kernelState(): DshKernelState;
  /** token 落盘目录（DATA_ROOT——机器可读面；缺省不落盘）。 */
  tokenFile?: string;
  /** MCP 协议 handler（toNodeHandler 包裹的 streamable-http 面）。 */
  handle: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
}

/** 生成进程周期 token（32 字节 hex）。 */
export function buildProcessToken(): string {
  return randomBytes(32).toString('hex');
}

export class McpListener {
  private server: http.Server | null = null;

  constructor(private readonly options: McpListenerOptions) {}

  /** 监听（返回实际端口）。绑定层拒绝：非 loopback host 抛错（§6.4 测试门）。 */
  listen(): Promise<number> {
    if (!LOOPBACK_BIND_HOSTS.has(this.options.host)) {
      return Promise.reject(
        new Error(`MCP_HOST=${this.options.host} 非 loopback：MCP 监听拒绝绑定（design §6.4 监听隔离）`),
      );
    }
    const bindHost = this.options.host === 'localhost' ? '127.0.0.1' : this.options.host;
    const token = this.options.token ?? buildProcessToken();
    if (this.options.tokenFile) {
      writeFileSync(this.options.tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handle(request, response, token).catch((error: unknown) => {
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      });
      server.once('error', reject);
      server.listen(this.options.port, bindHost, () => {
        resolve((server.address() as AddressInfo).port);
      });
      this.server = server;
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse, token: string): Promise<void> {
    // 连接层强制：remote 非 loopback → 403（双栈纵深防御）。
    const remote = (request.socket as Socket).remoteAddress;
    if (!isLoopbackAddress(remote)) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'MCP 仅接受 loopback 连接' }));
      return;
    }
    // 鉴权：Bearer 进程周期 token（缺失/错误一律 401——不区分以省探测面）。
    const authorization = request.headers.authorization ?? '';
    if (authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      response.end(JSON.stringify({ error: '需要进程周期 Bearer token（DATA_ROOT/mcp-token）' }));
      return;
    }
    // 降级门（§6.4）：内核终态降级（off/missing/error）→ 501；booting/ready
    // 放行（dsh-mcp-client 的首连发生在内核 boot 期间——蛋鸡解耦）。
    const state = this.options.kernelState();
    if (state !== 'ready' && state !== 'booting' && state !== 'unbooted') {
      response.writeHead(501, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32601, message: `dsh 内核未就绪（${state}）——MCP 面降级（design §6.4）：${this.describe(state)}` },
        }),
      );
      return;
    }
    await this.options.handle(request, response);
  }

  private describe(state: DshKernelState): string {
    switch (state) {
      case 'off':
        return 'DSH 显式关闭';
      case 'missing':
        return '缺包/坏包';
      case 'error':
        return 'boot 异常';
      default:
        return state;
    }
  }

  stop(timeoutMs = 1000): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, timeoutMs).unref?.();
    });
  }
}
