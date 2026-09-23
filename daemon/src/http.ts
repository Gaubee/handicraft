/**
 * HTTP 面（design §1/§2：daemon 托管 SPA + /api/*；W2 再挂 /ws/rpc 与 /ws/tasks/:id）。
 * 原始需求 2026-09-23（W1.2）：静态托管 rhinestone-studio/dist + 无点路径 SPA 回退
 * + dist 缺失启动明确报错（构建指引文案，不静默起服）+ /api/bootstrap（版本+配置
 * 状态）+ /api/auth/anonymous（匿名登录签发 JWT）。
 * 正交意图：
 *   [1] 路由分发（/api/* 优先；未知 API 显式 404）。
 *   [2] 公开 JSON 面：bootstrap（密钥读面一律脱敏——仅存在性布尔，design §2）。
 *   [3] 匿名登录面：allow_anonymous 开→自愈匿名行+签发 JWT；关→403。
 *   [4] 文件面：dist 静态（index.html no-cache / hash 资产长缓存 / SPA 回退 /
 *       containment 防穿越）。
 *   [5] 生命周期：listen 与有界 stop。
 */
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { AppConfig } from './config.js';
import { isImgConfigured, isLlmConfigured } from './config.js';
import type { SqliteDb } from './db/database.js';
import { ensureAnonymousUser, isAllowAnonymous, signJwt } from './auth.js';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** daemon 版本（W1 冒烟面；后续随发布节奏走 package.json version）。 */
export const DAEMON_VERSION = '0.1.0';

/** dist 缺失的启动失败文案（spec：明确报错+构建指引，不静默起服）。 */
export function distMissingError(webuiDir: string): Error {
  return new Error(
    [
      `前端构建产物缺失或损坏：${webuiDir}`,
      '请先构建前端：cd rhinestone-studio && pnpm install && pnpm build',
      '（或设置 WEBUI_DIR 指向已有 dist 目录后重启）',
    ].join('\n'),
  );
}

export interface DaemonHttpOptions {
  config: AppConfig;
  db: SqliteDb;
  /** JWT 签名密钥（启动装配解析后的最终值）。 */
  secret: string;
}

export class DaemonHttp {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: DaemonHttpOptions) {}

  listen(port: number, host: string): Promise<number> {
    // dist 门禁在监听前：缺失=抛错退出（不静默起服）。
    if (!existsSync(path.join(this.options.config.webuiDir, 'index.html'))) {
      return Promise.reject(distMissingError(this.options.config.webuiDir));
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        this.server = server;
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  /** 有界停机：宽限期内未走完的连接强制断开（优雅退出用）。 */
  stop(graceMs = 1000): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of this.sockets) socket.destroy();
        server.closeAllConnections();
      }, graceMs);
      timer.unref();
      server.close(() => resolve());
    });
  }

  // -------------------------------------------------------------- http 路由

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/api/bootstrap') {
        this.sendBootstrap(response);
        return;
      }
      if (pathname === '/api/auth/anonymous' && request.method === 'POST') {
        await this.handleAnonymousLogin(request, response);
        return;
      }
      if (pathname.startsWith('/api/')) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: `未知 API 路径：${pathname}` }));
        return;
      }
      // SPA 路由（无点路径）回退 index.html；带点路径按静态资产精确匹配。
      const isSpaRoute = pathname === '/' || !pathname.includes('.');
      const staticPath = isSpaRoute ? 'index.html' : pathname.slice(1);
      await this.sendStaticFile(request, response, staticPath);
    } catch (error) {
      console.error(`[http] 处理失败：${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('内部错误');
    }
  }

  /** 版本+配置状态（密钥读面脱敏：仅存在性布尔，值零出——design §2）。 */
  private sendBootstrap(response: http.ServerResponse): void {
    const { config, db } = this.options;
    const body = {
      version: DAEMON_VERSION,
      needs_setup: false,
      allow_anonymous: isAllowAnonymous(db, config.allowAnonymous),
      admin_configured: config.adminUsername !== '' && config.adminPassword !== '',
      img_configured: isImgConfigured(config.img),
      llm_configured: isLlmConfigured(config.llm),
    };
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }

  /** 匿名登录：开关开→自愈匿名行+JWT；关→403。 */
  private async handleAnonymousLogin(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const { config, db, secret } = this.options;
    if (!isAllowAnonymous(db, config.allowAnonymous)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: '匿名访问已关闭' }));
      return;
    }
    const user = ensureAnonymousUser(db);
    const { token, expiresAt } = await signJwt(secret, { sub: user.id, role: user.role });
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ token, expires_at: expiresAt, user: { id: user.id, role: user.role } }));
  }

  // -------------------------------------------------------------- 文件面

  /** dist 静态：目录内精确命中，否则 SPA 回退 index.html。 */
  private async sendStaticFile(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    relativePath: string,
  ): Promise<void> {
    const root = path.resolve(this.options.config.webuiDir);
    const file = path.resolve(root, relativePath);
    // containment：`..` 前缀 + 绝对路径残余（跨盘符）都拒绝。
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && !statSync(file).isDirectory()) {
      // index.html 是 SPA 入口（引用带 hash 资产）：no-cache——升级后不跑旧 bundle；
      // 带 hash 资产长缓存。
      const cache = file === path.join(root, 'index.html') ? 'no-cache' : 'public, max-age=3600';
      await this.sendFile(request, response, file, cache);
      return;
    }
    await this.sendFile(request, response, path.join(root, 'index.html'), 'no-cache');
  }

  /** 统一文件发送：HEAD/缺失 404（W2.3 按 zhumo 补 Range 206——分享包流式面）。 */
  private async sendFile(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    filePath: string,
    cacheControl: string,
  ): Promise<void> {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未找到');
      return;
    }
    const body = readFileSync(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'cache-control': cacheControl,
      'content-length': body.byteLength,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(body);
  }
}
