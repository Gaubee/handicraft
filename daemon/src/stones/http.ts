/**
 * 装饰钻库 HTTP 资产面（add-stone-library design §4.1——S3.2）。
 * 原始需求 2026-09-24（tasks.md S3.2）：GET /api/stones/{id}/texture.png 与
 * /api/stones/{id}/views/{name}——贴图/视图字节出口。
 * 发送纪律（沿 /r/{id}/files 与 dist 静态发送面先例）：
 *   auth 作用域（Authorization: Bearer 或 ?token=——共享读=全部认证用户可取，
 *   评审 D-1；未认证 401）+ ETag=blob hash（If-None-Match→304，内容寻址不可变
 *   字节的免费再验证）+ containment（DB 行名精确匹配——无文件系统路径拼接，
 *   `/`、`..` 类输入天然 404）。
 * 字节经 BlobStore 直读（贴图 gate 上限 2MB——内存发送无流式必要）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { authenticate } from '../auth.js';
import { STONE_TEXTURE_FILE_NAME } from './service.js';

export interface StoneAssetDeps {
  db: SqliteDb;
  secret: string;
  blobs: BlobStore;
}

/** 视图文件扩展名 MIME（views/ 是实物照片——非渲染源；未知扩展名按下载流回）。 */
const VIEW_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface FileRow {
  id: string;
  content_hash: string | null;
}

function childFileRow(db: SqliteDb, parentId: string, name: string): FileRow | null {
  return (
    (db
      .prepare('SELECT id, content_hash FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 0')
      .get(parentId, name) as FileRow | undefined) ?? null
  );
}

function sendBytes(
  request: IncomingMessage,
  response: ServerResponse,
  bytes: Buffer,
  etag: string,
  contentType: string,
): void {
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'content-length': bytes.byteLength,
    etag,
    // 资源可变（贴图替换=同 URL 新 hash）——no-cache 强制走 ETag 再验证（304 廉价）。
    'cache-control': 'private, no-cache',
  };
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(bytes);
}

/**
 * /api/stones/{id}/texture.png（viewName=null）与 /api/stones/{id}/views/{name}：
 * 认证→原子目录定位→贴图/views 子文件行→blob 直读→ETag 发送。
 * 404 面：id 不存在/非目录/无对应文件行/blob 缺失（同语义不区分——资产面不泄露状态）。
 */
export async function handleStoneAssetRequest(
  deps: StoneAssetDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  resourceId: string,
  viewName: string | null,
): Promise<void> {
  const authorization = request.headers.authorization;
  const token =
    (authorization !== undefined && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined) ??
    url.searchParams.get('token') ??
    undefined;
  const user = await authenticate(deps.secret, deps.db, token);
  if (!user) {
    response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '需要登录（贴图资产面 auth 作用域）' }));
    return;
  }
  const dir = deps.db.prepare('SELECT id FROM resources WHERE id = ? AND is_dir = 1').get(resourceId) as
    | { id: string }
    | undefined;
  if (dir === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('stone 不存在');
    return;
  }
  let fileRow: FileRow | null;
  let contentType: string;
  if (viewName === null) {
    fileRow = childFileRow(deps.db, resourceId, STONE_TEXTURE_FILE_NAME);
    contentType = 'image/png';
  } else {
    // views/ 子目录内精确行名匹配——containment 由 DB 查找承载（无路径拼接）。
    const viewsDir = deps.db
      .prepare('SELECT id FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 1')
      .get(resourceId, 'views') as { id: string } | undefined;
    fileRow = viewsDir === undefined ? null : childFileRow(deps.db, viewsDir.id, viewName);
    contentType = VIEW_MIME[viewName.slice(viewName.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
  }
  const hash = fileRow !== null ? fileRow.content_hash : null;
  if (fileRow === null || hash === null) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('文件不存在');
    return;
  }
  const bytes = deps.blobs.read(hash);
  if (bytes === null) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('文件内容不可读');
    return;
  }
  sendBytes(request, response, bytes, `"${hash}"`, contentType);
}
