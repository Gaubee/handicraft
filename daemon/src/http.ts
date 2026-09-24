/**
 * HTTP 面（design §1/§2：daemon 托管 SPA + /api/* + /ws/rpc + /ws/tasks/:id）。
 * 原始需求 2026-09-23（W1.2 骨架；W2.1 挂 WS 双通道）：静态托管 rhinestone-studio/dist
 * + 无点路径 SPA 回退 + dist 缺失启动明确报错（构建指引文案，不静默起服）+
 * /api/bootstrap（版本+配置状态）+ /api/auth/anonymous（匿名登录签发 JWT）+
 * upgrade 分发（/ws/rpc → oRPC 路由；/ws/tasks/:id → 帧流推送——token 鉴权 +
 * afterSeq 回放 + live 订阅；服务未装配 501）。
 * 正交意图：
 *   [1] 路由分发（/api/* 优先；未知 API 显式 404）与 upgrade 通道。
 *   [2] 公开 JSON 面：bootstrap（密钥读面一律脱敏——仅存在性布尔，design §2）。
 *   [3] 匿名登录面：allow_anonymous 开→自愈匿名行+签发 JWT；关→403。
 *   [4] 文件面：dist 静态（index.html no-cache / hash 资产长缓存 / SPA 回退 /
 *       containment 防穿越）。
 *   [5] 生命周期：listen 与有界 stop（WS 客户端一并回收）。
 */
import http from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import type { RPCHandler } from '@orpc/server/ws';
import { IdSchema } from '@handicraft/contracts';
import type { AppConfig } from './config.js';
import { isImgConfigured, isLlmConfigured } from './config.js';
import type { SqliteDb } from './db/database.js';
import { authenticate, ensureAnonymousUser, isAllowAnonymous, signJwt } from './auth.js';
import type { RpcContext } from './rpc.js';
import type { JobService } from './jobs/service.js';
import type { BlobStore } from './db/blobs.js';
import type { SessionService } from './sessions/service.js';
import type { DshKernelFacade } from './kernel/index.js';
import { getResultByPublicId, isResultShareable } from './db/jobs.js';
import { fileNameOfBundle, type ShareBundleManifest } from './share.js';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
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
  /** oRPC-over-WS 路由（/ws/rpc 未装配=404）。 */
  rpcHandler?: RPCHandler<RpcContext>;
  /** W2 任务编排（装配后 /ws/tasks/:id 可用；未装配 501）。 */
  jobs?: JobService;
  /** 内容寻址存储（assets.upload 面）。 */
  blobs?: BlobStore;
  /** W3.2 Agent 会话服务（装配后 session.* 可用；未装配 501）。 */
  sessions?: SessionService;
  /** W4.1 dsh 内核（装配后 session.followup 接真实管线；降级态 501——§6.4）。 */
  kernel?: DshKernelFacade;
}

export class DaemonHttp {
  private server: http.Server | null = null;
  private readonly wsServer = new WebSocketServer({ noServer: true });
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
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
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
        for (const client of this.wsServer.clients) client.terminate();
        for (const socket of this.sockets) socket.destroy();
        server.closeAllConnections();
      }, graceMs);
      timer.unref();
      this.wsServer.close(() => {
        server.close(() => resolve());
      });
    });
  }

  // -------------------------------------------------------------- upgrade

  private handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const taskMatch = /^\/ws\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskMatch) {
      // P1-3：decodeURIComponent 对畸形百分号编码（如 /ws/tasks/%）同步抛 URIError——
      // 未捕获会终止 daemon。此处兜底为 400+关闭，taskId 过 IdSchema 严格校验。
      let taskId: string;
      try {
        taskId = decodeURIComponent(taskMatch[1] ?? '');
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      if (!IdSchema.safeParse(taskId).success) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      this.handleTaskStreamUpgrade(request, socket, head, taskId, url);
      return;
    }
    if (url.pathname !== '/ws/rpc' || !this.options.rpcHandler) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const { config, db, secret, rpcHandler, jobs, blobs, sessions, kernel } = this.options;
    const context: RpcContext = {
      config,
      db,
      secret,
      token: url.searchParams.get('token') ?? undefined,
      jobs,
      blobs,
      sessions,
      kernel,
      // W4.2 授权桥（kernel 同源实例——session.answer/retry 与 capability 面共享）。
      approvals: kernel?.approvals,
    };
    this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
      void rpcHandler
        .upgrade(guardRpcSocket(websocket as WsWebSocket), { context })
        .catch((error: unknown) => {
          // 畸形帧只断开该连接，不打穿 daemon（zhumo 实证模式）。
          try {
            websocket.close();
          } catch {
            // 已断开
          }
          console.error(`[orpc] ws 升级失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
  }

  /**
   * /ws/tasks/:id?token=&after_seq=：帧流推送（design §2 长任务行）。token 鉴权 +
   * 本人/admin 校验走 JobService.requireOwnedTask；先回放持久帧再挂 live 订阅，
   * 连接关闭即退订。
   */
  private handleTaskStreamUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    taskId: string,
    url: URL,
  ): void {
    const { db, secret, jobs } = this.options;
    if (!jobs) {
      socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
      return;
    }
    const token = url.searchParams.get('token') ?? undefined;
    void authenticate(secret, db, token)
      .then((user) => {
        if (!user) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          return;
        }
        // P2-3：after_seq 严格非负整数（等价 contracts TaskFramesInputSchema 口径）——
        // 负数/浮点/尾随字符一律 400，不再 parseInt 静默归零；
        // 超过 MAX_SAFE_INTEGER 的巨值同样 400（防数值精度回绕）。
        const rawAfterSeq = url.searchParams.get('after_seq') ?? '0';
        if (!/^\d+$/.test(rawAfterSeq) || Number(rawAfterSeq) > Number.MAX_SAFE_INTEGER) {
          rejectUpgrade(socket, 400, 'Bad Request');
          return;
        }
        const afterSeq = Number(rawAfterSeq);
        this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
          const send = (frame: unknown): void => {
            if (websocket.readyState === websocket.OPEN) websocket.send(JSON.stringify(frame));
          };
          let unsubscribe = (): void => {};
          try {
            unsubscribe = jobs.openFrameStream(user, taskId, afterSeq, send);
          } catch (error) {
            send({
              seq: -1,
              ts: Date.now(),
              kind: 'error',
              payload: { message: error instanceof Error ? error.message : String(error) },
            });
            websocket.close();
            return;
          }
          websocket.once('close', () => unsubscribe());
        });
      })
      .catch(() => {
        try {
          socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        } catch {
          // 已断开
        }
      });
  }

  // -------------------------------------------------------------- http 路由

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      // P1-3 同族加固：HTTP 面路径解码同样可能抛 URIError——显式 400（原为兜底 500）。
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('路径编码非法');
        return;
      }

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
      // /r/{public_id}：分享页（服务端最小 HTML）与 /r/{id}/files/{svg|bom|png}（Range 206）
      const shareMatch = /^\/r\/([^/]+)(?:\/files\/([a-z]+))?$/.exec(pathname);
      if (shareMatch) {
        await this.handleShare(
          request,
          response,
          decodeURIComponent(shareMatch[1] ?? ''),
          (shareMatch[2] as 'svg' | 'bom' | 'png' | undefined) ?? null,
        );
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

  /** /r/{public_id}：bundle manifest → 最小分享页；/files/{key} containment + Range 206。 */
  private async handleShare(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    publicId: string,
    fileKey: 'svg' | 'bom' | 'png' | null,
  ): Promise<void> {
    const row = getResultByPublicId(this.options.db, publicId);
    if (!row || !isResultShareable(row)) {
      // 404 同语义（不区分不存在/已撤销/已过期——分享面不泄露状态）。
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('结果不存在');
      return;
    }
    if (fileKey === null) {
      const manifest = readBundleManifest(row.bundle_path);
      const title = escapeHtml(manifest.title || '贴钻结果');
      const pid = encodeURIComponent(publicId);
      const html = [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${title} · 贴钻分享</title>`,
        '<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;background:#fafafa;color:#111}img{max-width:100%;border:1px solid #e5e5e5;border-radius:8px;background:#fff}a.btn{display:inline-block;margin:.25rem .75rem .25rem 0;padding:.5rem 1rem;border-radius:8px;background:#111;color:#fff;text-decoration:none}</style>',
        '</head><body>',
        `<h1>${title}</h1>`,
        `<p>创建于 ${escapeHtml(manifest.createdAt)}（public_id ${pid}）</p>`,
        `<img src="/r/${pid}/files/png" alt="贴钻预览" width="512">`,
        '<p>',
        `<a class="btn" href="/r/${pid}/files/png" download="render.png">下载 PNG</a>`,
        `<a class="btn" href="/r/${pid}/files/svg" download="layout.svg">下载 SVG</a>`,
        `<a class="btn" href="/r/${pid}/files/bom" download="bom.csv">下载 BOM</a>`,
        '</p></body></html>',
      ].join('');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    if (fileKey !== 'svg' && fileKey !== 'bom' && fileKey !== 'png') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未知产物');
      return;
    }
    // containment：bundle 目录内精确文件（.. 前缀 + 绝对路径残余都拒绝——zhumo 同款）
    const root = path.resolve(row.bundle_path);
    const file = path.resolve(root, fileNameOfBundle(fileKey));
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      response.writeHead(403).end();
      return;
    }
    await this.sendFile(request, response, file, 'no-store');
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

  /** 统一文件发送：Range 206、HEAD、缺失 404；流式分段（背压感知——zhumo 同款）。 */
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
    const size = statSync(filePath).size;
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const range = parseRange(request.headers['range'], size);
    if (range === 'invalid') {
      response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    const baseHeaders: Record<string, string | number> = {
      'content-type': type,
      'cache-control': cacheControl,
      'accept-ranges': 'bytes',
    };
    if (!range) {
      response.writeHead(200, { ...baseHeaders, 'content-length': size });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      streamRange(filePath, response, 0, size - 1);
      return;
    }
    const [start, end] = range;
    response.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    streamRange(filePath, response, start, end);
  }
}

// ---------------------------------------------------------------- helpers

/** upgrade 阶段的协议级拒绝：写原始 HTTP 错误响应并关闭 socket（不进入 WS 握手）。 */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`, () => {
    socket.destroy();
  });
}

/**
 * oRPC ws 适配器对畸形帧可能抛未捕获 rejection（@orpc/server 实测行为，zhumo 同款
 * 防护）：message 监听器同步异常与返回的 Promise rejection 一律兜底——只断开该连接，
 * 不打穿 daemon。
 */
function guardRpcSocket(websocket: WsWebSocket): WsWebSocket {
  const wrapListener = (listener: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]): void => {
      try {
        const result = listener(...args);
        if (result instanceof Promise) {
          result.catch(() => {
            try {
              websocket.close();
            } catch {
              // 已断开
            }
          });
        }
      } catch {
        try {
          websocket.close();
        } catch {
          // 已断开
        }
      }
    };
  };
  return new Proxy(websocket, {
    get(target, property, receiver) {
      if (property === 'on' || property === 'once' || property === 'addEventListener') {
        return (event: string, listener: unknown, ...rest: unknown[]) => {
          const wrapped =
            event === 'message' && typeof listener === 'function'
              ? wrapListener(listener as (...args: unknown[]) => unknown)
              : listener;
          const register = Reflect.get(target, property, receiver) as unknown as (
            ...callArgs: unknown[]
          ) => unknown;
          return register.call(target, event, wrapped, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** 解析单区间 Range 头：无=undefined；语法/越界错='invalid'；否则 [start,end] 闭区间。 */
export function parseRange(
  header: string | string[] | undefined,
  size: number,
): [number, number] | 'invalid' | undefined {
  if (!header) return undefined;
  const text = Array.isArray(header) ? (header[0] ?? '') : header;
  const match = /^bytes=(\d*)-(\d*)$/.exec(text.trim());
  if (!match) return 'invalid';
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return 'invalid';
  if (rawStart === '') {
    // 后缀式 bytes=-N：最后 N 字节。
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return 'invalid';
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start >= size) return 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return [start, end];
}

/** 按闭区间流式发送文件片段（背压感知）。 */
function streamRange(
  filePath: string,
  response: http.ServerResponse,
  start: number,
  end: number,
): void {
  const fd = openSync(filePath, 'r');
  const chunkSize = 256 * 1024;
  let position = start;
  let closed = false;
  response.on('close', () => {
    closed = true;
    try {
      closeSync(fd);
    } catch {
      // 已关闭
    }
  });
  const writeNext = (): void => {
    if (closed) return;
    if (position > end) {
      closeSync(fd);
      response.end();
      return;
    }
    const length = Math.min(chunkSize, end - position + 1);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    position += read;
    const slice = read === length ? buffer : buffer.subarray(0, read);
    if (!response.write(slice)) {
      response.once('drain', writeNext);
      return;
    }
    writeNext();
  };
  writeNext();
}

function readBundleManifest(bundlePath: string): ShareBundleManifest {
  try {
    return JSON.parse(readFileSync(path.join(bundlePath, 'bundle.json'), 'utf8')) as ShareBundleManifest;
  } catch {
    throw new Error('结果 bundle 缺少 bundle.json');
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
