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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import type { RPCHandler } from '@orpc/server/ws';
import { IdSchema, SETTING_SITE_NAME } from '@handicraft/contracts';
import type { AppConfig } from './config.js';
import { isImgConfigured, isLlmConfigured } from './config.js';
import type { SqliteDb } from './db/database.js';
import { getSetting, hasAdminUser } from './db/store.js';
import { authenticate, ensureAnonymousUser, isAllowAnonymous, signJwt } from './auth.js';
import type { RpcContext } from './rpc.js';
import type { JobService } from './jobs/service.js';
import type { BlobStore } from './db/blobs.js';
import type { SessionService } from './sessions/service.js';
import type { DshKernelFacade } from './kernel/index.js';
import { getResultByPublicId, isResultShareable } from './db/jobs.js';
import { fileNameOfBundle, type ShareBundleManifest } from './share.js';
import { sessionImageSet } from './capability/task-images.js';
import { sniffImageMime } from './image-sniff.js';
import { decodePng } from './png/codec.js';
import { handleStoneAssetRequest } from './stones/http.js';
import { handleAssetRawRequest } from './assets-http.js';

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
    void authenticate(secret, db, token, this.options.config.allowAnonymous)
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
        // S3.2 贴图资产面：/api/stones/{id}/texture.png 与 /views/{name}
        //（regex 单段捕获——解码后的 / 与 .. 在 DB 行名匹配下天然 404=containment）。
        const stoneAsset = /^\/api\/stones\/([^/]+)\/(?:texture\.png|views\/([^/]+))$/.exec(pathname);
        if (stoneAsset) {
          if (!this.options.blobs) {
            response.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'BlobStore 未装配（501）' }));
            return;
          }
          await handleStoneAssetRequest(
            { db: this.options.db, secret: this.options.secret, blobs: this.options.blobs, allowAnonymousEnv: this.options.config.allowAnonymous },
            request,
            response,
            url,
            stoneAsset[1] as string,
            (stoneAsset[2] as string | undefined) ?? null,
          );
          return;
        }
        // split-admin-portal 2.4 附件 raw 预览面：/api/assets/{ref}/raw?w=&token=
        //（ref=64 hex sha256——regex 固化形状，非 hex 形状走未知 API 404）。
        const assetRaw = /^\/api\/assets\/([0-9a-f]{64})\/raw$/.exec(pathname);
        if (assetRaw) {
          if (!this.options.blobs) {
            response.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'BlobStore 未装配（501）' }));
            return;
          }
          await handleAssetRawRequest(
            {
              db: this.options.db,
              secret: this.options.secret,
              blobs: this.options.blobs,
              allowAnonymousEnv: this.options.config.allowAnonymous,
            },
            request,
            response,
            url,
            assetRaw[1] as string,
          );
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: `未知 API 路径：${pathname}` }));
        return;
      }
      // /r/{public_id}：分享页（服务端最小 HTML）与 /r/{id}/files/{svg|bom|png|holes|numbered|source}（Range 206）
      const shareMatch = /^\/r\/([^/]+)(?:\/files\/([a-z]+))?$/.exec(pathname);
      if (shareMatch) {
        await this.handleShare(
          request,
          response,
          decodeURIComponent(shareMatch[1] ?? ''),
          (shareMatch[2] as 'svg' | 'bom' | 'png' | 'holes' | 'numbered' | 'source' | undefined) ?? null,
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
    fileKey: 'svg' | 'bom' | 'png' | 'holes' | 'numbered' | 'source' | null,
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
      // [Owner 2026-10-03 报障「结果页能预览各种可下载的」] 逐产物折叠预览
      // （<details> 原生折叠——零 JS 依赖：iframe sandbox 内/独立打开/禁脚本三态
      // 同形）+ 每产物就地下载；BOM 表格服务端预渲染（bundle 在本机磁盘，读一行
      // 渲染一行——免客户端 fetch）。SVG 以 <img> 内联渲染（位面同 PNG；img 载入
      // 的 SVG 天然禁脚本）。
      const holesBlock =
        manifest.files.holes !== undefined
          ? artifactBlock(pid, 'holes', '黑点模板 holes.png')
          : '';
      // [Owner 反馈 2026-10-03「编号图右侧是图例，左侧才是混合区域」] numbered 混
      // 合区=钻面区（render.png 尺寸=layout 画布——图例是画布右侧自适应扩展带，
      // 服务端解码 render.png 拿精确分区下发 data-mix-region；解码失败省略=整幅混合
      // 的旧行为兜底）。
      let numberedRegion = '';
      if (manifest.files.numbered !== undefined && manifest.files.png !== undefined) {
        try {
          const renderBytes = readFileSync(path.join(row.bundle_path, fileNameOfBundle('png')));
          const decoded = decodePng(renderBytes);
          numberedRegion = `0,0,${decoded.width},${decoded.height}`;
        } catch {
          numberedRegion = '';
        }
      }
      const numberedBlock =
        manifest.files.numbered !== undefined
          ? artifactBlock(pid, 'numbered', '编号工作图 numbered.png', false, numberedRegion)
          : '';
      const bomBlock =
        manifest.files.bom !== undefined ? await bomPreviewBlock(row.bundle_path, pid) : '';
      const html = [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${title} · 贴钻分享</title>`,
        '<style>',
        'body{font-family:system-ui,sans-serif;max-width:860px;margin:1.5rem auto;padding:0 1rem;background:#fafafa;color:#111}',
        'details{border:1px solid #e5e5e5;border-radius:10px;background:#fff;margin:.6rem 0;overflow:hidden}',
        'summary{cursor:pointer;padding:.7rem 1rem;font-weight:600;user-select:none;display:flex;align-items:center;justify-content:space-between;gap:.75rem}',
        'summary:hover{background:#f5f5f5}',
        'summary .btn{margin-left:auto;flex-shrink:0}',
        'details[open] summary{border-bottom:1px solid #eee}',
        '.preview{padding:.8rem 1rem;background:#fff}',
        'img{max-width:100%;border:1px solid #e5e5e5;border-radius:8px;background:#fff}',
        'table{border-collapse:collapse;width:100%;font-size:.85rem}',
        'th,td{border:1px solid #e5e5e5;padding:.3rem .55rem;text-align:left;white-space:nowrap}',
        'th{background:#f5f5f5}',
        '.btn{display:inline-block;margin-left:.75rem;padding:.3rem .8rem;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-weight:400;font-size:.85rem;vertical-align:middle}',
        '.meta{color:#666;font-size:.85rem;margin:.2rem 0 .8rem}',
        '.mix{margin-top:.8rem;border-top:1px dashed #e5e5e5;padding-top:.6rem}',
        '.mix-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.9rem;margin-bottom:.5rem}',
        '.mix-tag{font-size:.8rem;font-weight:600;color:#555}',
        '.mix-bar label{display:inline-flex;align-items:center;gap:.35rem;font-size:.8rem;color:#333}',
        '.mix-bar input[type=range]{width:110px;accent-color:#111}',
        '.mix-bar input[type=color]{width:34px;height:24px;padding:0;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer}',
        '.mix-bar input[type=checkbox]{accent-color:#111}',
        '.mix-bar output{font-size:.75rem;color:#666;min-width:3.2em}',
        '.mix canvas{max-width:100%;border:1px solid #e5e5e5;border-radius:8px;background:#fff}',
        '</style></head><body>',
        `<h1>${title}</h1>`,
        `<p class="meta">创建于 ${escapeHtml(manifest.createdAt)}（public_id ${pid}）· 点击各产物行展开预览，右侧按钮下载；位面产物支持原图混合对照</p>`,
        artifactBlock(pid, 'png', '效果图 render.png', true),
        holesBlock,
        numberedBlock,
        artifactBlock(pid, 'svg', '排钻四层 layout.svg'),
        bomBlock,
        shareMixScript(),
        '</body></html>',
      ].join('');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    if (
      fileKey !== 'svg' &&
      fileKey !== 'bom' &&
      fileKey !== 'png' &&
      fileKey !== 'holes' &&
      fileKey !== 'numbered' &&
      fileKey !== 'source'
    ) {
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
    // [2026-10-03 混合原图] source=分享页混合预览的数据面（JS fetch 消费，非直接
    // 下载）：bundle 内 source.img 优先（新导出永久留存，mime 以 manifest 为准——
    // png/jpeg passthrough 无扩展名可凭）；旧 bundle 无此文件→任务链回退（result
    // .task_id→session 主图集→blob——会话已清理/图集不可达=404，前端隐藏混合控件）。
    if (fileKey === 'source') {
      if (existsSync(file)) {
        const manifestForMime = readBundleManifest(row.bundle_path);
        await this.sendFile(request, response, file, 'no-store', {
          'content-type': manifestForMime.files.source?.mime ?? 'application/octet-stream',
        });
        return;
      }
      const fallback = this.resolveSourceFallback(row);
      if (fallback === null) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('原图不可用（旧分享包且任务已清理）');
        return;
      }
      response.writeHead(200, {
        'content-type': fallback.mime,
        'cache-control': 'no-store',
        'content-length': fallback.bytes.byteLength,
      });
      response.end(fallback.bytes);
      return;
    }
    // [挂账收口 2026-10-03] 产物下载补 Content-Disposition: attachment——此前内联
    // 打开非下载（挂账「导出五链接无 attachment」）；iframe sandbox 内的 anchor
    // download 与独立打开两态都强制落盘。img 预览不受影响（子资源加载不看此头）。
    await this.sendFile(request, response, file, 'no-store', {
      'content-disposition': `attachment; filename="${fileNameOfBundle(fileKey)}"`,
    });
  }

  /**
   * [2026-10-03 混合原图] 旧 bundle 的原图任务链回退：result.task_id → task.session_id
   * → 会话主图集（A5 审计真源，与导出时 sourceImageOfSession 同源解析链）→ blob
   * 字节 + 嗅探 mime。任一环不可达=null（调用方 404）——不猜不降级。
   */
  private resolveSourceFallback(row: { task_id: string | null; bundle_path: string }): { bytes: Buffer; mime: string } | null {
    const blobs = this.options.blobs;
    if (blobs === undefined || row.task_id === null) return null;
    let manifest: ShareBundleManifest;
    try {
      manifest = readBundleManifest(row.bundle_path);
    } catch {
      return null;
    }
    if (manifest.source === undefined) return null;
    const task = this.options.db
      .prepare('SELECT session_id FROM tasks WHERE id = ?')
      .get(row.task_id) as { session_id: string | null } | undefined;
    if (task === undefined || task.session_id === null) return null;
    const imageSet = sessionImageSet(this.options.db, task.session_id);
    if (imageSet === null) return null;
    const index = imageSet.imageIds.indexOf(manifest.source.imageId);
    if (index < 0) return null;
    const bytes = blobs.read(imageSet.attachments[index]!);
    if (bytes === null) return null;
    const mime = sniffImageMime(bytes);
    if (mime !== 'image/png' && mime !== 'image/jpeg') return null;
    return { bytes: Buffer.from(bytes), mime };
  }

  /** 版本+配置状态（密钥读面脱敏：仅存在性布尔，值零出——design §2）。 */
  private sendBootstrap(response: http.ServerResponse): void {
    const { config, db } = this.options;
    // 站点名（波 5 P2-2：顶栏品牌/登录页标题数据源——未设置空串，UI 侧回落缺省）。
    const siteName = getSetting(db, SETTING_SITE_NAME) ?? '';
    const body = {
      version: DAEMON_VERSION,
      needs_setup: false,
      allow_anonymous: isAllowAnonymous(db, config.allowAnonymous),
      // split-admin-portal 1.3：admin_configured=有 admin 用户行（可登录后台提示位）
      admin_configured: hasAdminUser(db),
      img_configured: isImgConfigured(config.img),
      llm_configured: isLlmConfigured(config.llm),
      site_name: siteName,
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
    extraHeaders: Record<string, string> = {},
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
      ...extraHeaders,
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

// ---------------------------------------------------------------- 分享页预览块（2026-10-03）

/** 分享页产物标签与下载文案（fileNameOfBundle 同源命名——按钮文案=「下载 + 标签」）。 */
const SHARE_ARTIFACT_LABELS: Record<'svg' | 'bom' | 'png' | 'holes' | 'numbered', string> = {
  png: '效果图 PNG',
  holes: '黑点模板 PNG',
  numbered: '编号工作图 PNG',
  svg: 'SVG',
  bom: 'BOM',
};

/**
 * 单产物折叠预览块：<summary>标签+下载按钮，体=<img>（PNG/SVG 同形渲染）。
 * [2026-10-03 Owner 需求] 位面产物（png/holes/numbered）追加「原图混合」控件组：
 * 双透明度滑杆（原图背景/产物前景）+canvas 实时混合预览+混合图下载（页面脚本
 * 数据驱动——data-mix-* 属性；原图不可达时控件组隐藏，原始预览/下载不受影响）。
 * [同日 Owner 反馈「只有第一个有混合效果」根因=产物底透明度差异] 效果图透明底
 * （空白区透出原图，fg 缺省 100% 即有混合观感）；黑点/编号为不透明白底——fg 缺省
 * 100% 会整幅盖死原图，缺省降至 55%（拖手柄即可回 100——缺省只求「开箱即见混合」）。
 * SVG 不设混合（四层结构本就内嵌 #source 原图层）；BOM 非图像无混合语义。
 */
const MIX_FG_DEFAULT: Record<'png' | 'holes' | 'numbered', number> = { png: 100, holes: 55, numbered: 55 };

function artifactBlock(
  pid: string,
  key: 'png' | 'holes' | 'numbered' | 'svg',
  label: string,
  open = false,
  region = '',
): string {
  const name = fileNameOfBundle(key);
  const btnText = `下载 ${SHARE_ARTIFACT_LABELS[key]}`;
  const mixable = key !== 'svg';
  const fgDefault = MIX_FG_DEFAULT[key as 'png' | 'holes' | 'numbered'];
  const mix = mixable
    ? [
        '<div class="mix" hidden data-mix-artifact="/r/' + pid + '/files/' + key + '" data-mix-source="/r/' + pid + '/files/source" data-mix-name="mix-' + name + '"' + (region !== '' ? ' data-mix-region="' + region + '"' : '') + '>',
        '<div class="mix-bar">',
        '<span class="mix-tag">原图混合</span>',
        '<label title="原图作为背景的覆盖强度">原图<input type="range" min="0" max="100" value="100" data-role="bg"><output>100%</output></label>',
        '<label title="产物前景覆盖强度——透明底产物调低即可透出原图">产物<input type="range" min="0" max="100" value="' + fgDefault + '" data-role="fg"><output>' + fgDefault + '%</output></label>',
        '<label title="下载底色——透明底导出产物落盘前平铺（默认透明=原字节直下）">底色<input type="color" value="#ffffff" data-role="bg-color"><input type="checkbox" checked data-role="bg-transparent" title="透明底（勾选=下载原始透明图，去勾=平铺所选底色）"></label>',
        '<button type="button" class="btn mix-dl">下载混合图</button>',
        '</div>',
        '<canvas></canvas>',
        '</div>',
      ].join('')
    : '';
  return [
    `<details${open ? ' open' : ''}>`,
    `<summary>${escapeHtml(label)}<a class="btn" href="/r/${pid}/files/${key}" download="${name}" data-role="raw-dl" data-raw-name="${name}">${btnText}</a></summary>`,
    '<div class="preview">',
    `<img src="/r/${pid}/files/${key}" alt="${escapeHtml(label)}预览" loading="lazy">`,
    mix,
    '</div></details>',
  ].join('');
}

/** BOM 折叠预览块：bundle 磁盘直读 → 服务端预渲染表格（零客户端 JS/零 fetch）。 */
async function bomPreviewBlock(bundlePath: string, pid: string): Promise<string> {
  const name = fileNameOfBundle('bom');
  const btnText = `下载 ${SHARE_ARTIFACT_LABELS.bom}`;
  let csv = '';
  try {
    csv = (await readFile(path.join(bundlePath, name), 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return `<details><summary>BOM 明细 bom.csv<a class="btn" href="/r/${pid}/files/bom" download="${name}">${btnText}</a></summary><div class="preview"><p>预览不可用（读取失败）——请下载查看</p></div></details>`;
  }
  const ROW_CAP = 500; // 防御上限（真实 BOM ≤ 数百 SKU；超限截断如实标注）
  const lines = csv.split(/\r?\n/).filter((line) => line !== '');
  // 首行=表头 <th>（终验观察项：此前全 <td>，th 背景样式永不生效——表头无视觉区分）。
  const rows = lines.slice(0, ROW_CAP).map((line, index) =>
    line
      .split(',')
      .map((cell) => `<${index === 0 ? 'th' : 'td'}>${escapeHtml(cell)}</${index === 0 ? 'th' : 'td'}>`)
      .join(''),
  );
  const table = `<table>${rows.map((row) => `<tr>${row}</tr>`).join('')}</table>`;
  const capNote = lines.length > ROW_CAP ? `<p>（仅预览前 ${ROW_CAP} 行，共 ${lines.length} 行——完整内容请下载）</p>` : '';
  return [
    `<details><summary>BOM 明细 bom.csv<a class="btn" href="/r/${pid}/files/bom" download="${name}">${btnText}</a></summary>`,
    `<div class="preview">${table}${capNote}</div></details>`,
  ].join('');
}

/**
 * [2026-10-03 Owner 需求「混合原图下载」] 分享页混合控件脚本（纯 vanilla、零依赖）。
 * [同日 Owner 反馈「只有第一个有混合效果」修订] 三点结构加固：
 *   - 控件组显隐只依赖产物图（本页 <img> 同源必载）——原图（3.7MB 级）不再拦门；
 *   - 原图全页单次加载、各块共享（此前每块独立 Image()+no-store=3× 大 fetch，任一
 *     瞬时失败即整块静默隐藏——生产实测正是这个症状面）；
 *   - 失败不静默：console.warn + mix-tag 位显式标注（可诊断可感知）。
 * 滑杆即时绑定（draw 内部 art/source 空值守卫）；下载混合图 canvas.toBlob PNG。
 * 字符串拼接 JS（无模板字面量/无 ${}——TS 模板安全，勿引入嵌套转义层）。
 */
function shareMixScript(): string {
  return [
    '<script>',
    '(function(){',
    'function loadImage(src){return new Promise(function(resolve,reject){var img=new Image();img.onload=function(){resolve(img)};img.onerror=function(){reject(new Error("load fail: "+src))};img.src=src;});}',
    'var blocks=document.querySelectorAll(".mix");',
    'if(blocks.length===0)return;',
    // 原图全页单次加载（不可变产物——配合服务端 max-age 缓存，跨块共享零重复大 fetch）。
    'var sourceUrl=blocks[0].getAttribute("data-mix-source");',
    'var sourcePromise=loadImage(sourceUrl);',
    'sourcePromise.catch(function(err){console.warn("[mix] 原图加载失败，混合停用：",err.message);});',
    'Array.prototype.forEach.call(blocks,function(block){',
    '  var artUrl=block.getAttribute("data-mix-artifact");',
    '  var dlName=block.getAttribute("data-mix-name")||"mix.png";',
    '  var canvas=block.querySelector("canvas");',
    '  var sliders=block.querySelectorAll("input[type=range]");',
    '  var outputs=block.querySelectorAll("output");',
    '  var bg=sliders[0],fg=sliders[1],bgOut=outputs[0],fgOut=outputs[1];',
    '  var tag=block.querySelector(".mix-tag");',
    '  var bgColorInput=block.querySelector("[data-role=bg-color]");',
    '  var bgTransparent=block.querySelector("[data-role=bg-transparent]");',
    // raw-dl 锚在 summary 内（.mix 容器之外）——作用域必须取所在 details；null 守卫
    //（终验实证：容器内查必 null，addEventListener 抛 TypeError 中止 forEach——
    // 黑点/编号块 hidden+平铺/混合下载全失效的回归根因）。
    '  var rawDl=block.closest("details")?block.closest("details").querySelector("[data-role=raw-dl]"):null;',
    '  var art=null,source=null;',
    // [Owner 2026-10-03] 下载底色：透明（勾选）=原始字节直下；选色=平铺合成后落盘。
    '  function flattenHref(){return bgTransparent.checked?null:bgColorInput.value;}',
    // 混合分区（numbered 专属——"x,y,w,h" 图像像素坐标；缺省=整幅混合）。图例带
    // （画布右侧扩展列）不参与混合：产物整幅打底，仅分区内重绘「白底+原图×bg+
    // 产物×fg」，图例列保持原样。
    '  var regionAttr=block.getAttribute("data-mix-region");',
    '  var region=regionAttr?regionAttr.split(",").map(Number):null;',
    '  function draw(){',
    '    if(!art||!source)return;',
    '    var W=art.naturalWidth,H=art.naturalHeight;',
    '    canvas.width=W;canvas.height=H;',
    '    var ctx=canvas.getContext("2d");',
    '    ctx.globalAlpha=1;',
    '    ctx.drawImage(art,0,0,W,H);',
    '    var rx=0,ry=0,rw=W,rh=H;',
    '    if(region&&region.length===4&&region[2]>0&&region[3]>0){rx=region[0];ry=region[1];rw=region[2];rh=region[3];}',
    '    ctx.save();',
    '    ctx.beginPath();ctx.rect(rx,ry,rw,rh);ctx.clip();',
    '    ctx.fillStyle=flattenHref()||"#fff";ctx.fillRect(rx,ry,rw,rh);',
    // 原图 cover-fit（保持纵横比铺满混合区，居中裁切）。
    '    var s=Math.max(rw/source.naturalWidth,rh/source.naturalHeight);',
    '    var dw=source.naturalWidth*s,dh=source.naturalHeight*s;',
    '    ctx.globalAlpha=parseInt(bg.value,10)/100;',
    '    ctx.drawImage(source,rx+(rw-dw)/2,ry+(rh-dh)/2,dw,dh);',
    '    ctx.globalAlpha=parseInt(fg.value,10)/100;',
    '    ctx.drawImage(art,0,0,W,H);',
    '    ctx.restore();',
    '    ctx.globalAlpha=1;',
    '  }',
    '  function bind(input,out){input.addEventListener("input",function(){out.textContent=input.value+"%";draw();});}',
    // 控件组显隐只随产物图（本页预览同源必载）；滑杆即时绑定，原图到位即出画。
    '  block.removeAttribute("hidden");',
    '  bind(bg,bgOut);bind(fg,fgOut);',
    '  loadImage(artUrl).then(function(img){art=img;draw();}).catch(function(err){console.warn("[mix] 产物图加载失败："+err.message);});',
    '  sourcePromise.then(function(img){source=img;draw();}).catch(function(){',
    // [Codex P2-3] 原图不可达时禁用整套混合控件（此前仅改文案——滑杆/混合下载
    // 仍可操作但 draw 永不产出，误导输入面）。
    '    tag.textContent="原图不可达（混合停用——原始预览/下载不受影响）";',
    '    bg.disabled=true;fg.disabled=true;',
    '    var mixDlBtn=block.querySelector(".mix-dl");if(mixDlBtn)mixDlBtn.disabled=true;',
    '    var cv=block.querySelector("canvas");if(cv)cv.remove();',
    '  });',
    // [Owner 2026-10-03] 原始下载平铺：透明模式保持原生 anchor 行为（attachment 直
    // 下）；选色模式接管——产物平铺底色后 toBlob 落盘（同名）。
    '  if(rawDl)rawDl.addEventListener("click",function(ev){',
    '    var flat=flattenHref();',
    '    if(flat===null)return;',
    '    ev.preventDefault();',
    '    loadImage(artUrl).then(function(img){',
    '      var c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;',
    '      var x=c.getContext("2d");x.fillStyle=flat;x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0);',
    '      c.toBlob(function(blob){',
    '        if(!blob)return;',
    '        var url=URL.createObjectURL(blob);',
    '        var a=document.createElement("a");a.href=url;a.download=rawDl.getAttribute("data-raw-name")||"artifact.png";',
    '        document.body.appendChild(a);a.click();a.remove();',
    '        setTimeout(function(){URL.revokeObjectURL(url);},5000);',
    "      },'image/png');",
    '    });',
    '  });',
    '  block.querySelector(".mix-dl").addEventListener("click",function(){',
    '    if(canvas.width===0)return;',
    '    canvas.toBlob(function(blob){',
    '      if(!blob)return;',
    '      var url=URL.createObjectURL(blob);',
    '      var a=document.createElement("a");a.href=url;a.download=dlName;',
    '      document.body.appendChild(a);a.click();a.remove();',
    '      setTimeout(function(){URL.revokeObjectURL(url);},5000);',
    "    },'image/png');",
    '  });',
    '});',
    '})();',
    '</script>',
  ].join('');
}
