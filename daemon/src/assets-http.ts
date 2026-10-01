/**
 * 附件 raw 预览面（split-admin-portal 2.4——图片会话链的字节出口）。
 * 原始需求 2026-09-29（design §3 raw 行）：GET /api/assets/{ref}/raw?w=&token=
 * 发送纪律（沿 stones/http.ts 贴图面先例）：
 *   [1] token 鉴权（Authorization: Bearer 或 ?token= 查询参数——<img> 标签无法带
 *       头部的先例通道）；匿名面随全局开关（authenticate 匿名门）。
 *   [2] 归属校验（防 hash 全局读面跨用户泄漏）：blob_uploads 本人上传 ∪ 本人会话
 *       引用（userOwnsBlobRef 单源——与 followup 附件 owner 校验同源）不满足时，
 *       **blobRef 直读兜底**（w20 走查 major-1，2026-10-02）：blobs 表 active 行
 *       在场即放行——任务域中间产物（识图归一底图/工件 blob——putTaskArtifact
 *       只 blobs.put，不进 blob_uploads/session_blob_refs 账本）此前一律 404，
 *       活动产出缩略图全裂。安全面：token 门对兜底路径同样生效（无 token/坏
 *       token=401 不变，鉴权强度不降）；sha256 内容寻址 hex 不可枚举且不经公开
 *       面泄漏（分享页 /r/{publicId} 不引用 raw URL）——持 hash 即等价于持内容
 *       引用，账本外直读不构成新增泄漏面。不满足归属且 blobs 行缺失=404 同语义
 *       （不区分不存在/无权——资产面不泄露他人 blob 存在性）。
 *   [3] 内容嗅探（魔数判 png/jpeg/webp，不信扩展名/声明）——非白名单 415。
 *   [4] 总字节上限（先查行 size 再读字节——ASSETS_RAW_MAX_BYTES）。
 *   [5] w 宽度参数：**第一版不做服务端缩放**（Codex 简化裁定——预留位，接受即忽略；
 *       返回原图字节+正确 Content-Type，前端 CSS 控缩略尺寸）。
 *   [6] ETag=blob hash（内容寻址不可变字节）+ If-None-Match 304。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteDb } from './db/database.js';
import type { BlobStore } from './db/blobs.js';
import { authenticate } from './auth.js';
import { sniffImageMime } from './image-sniff.js';

export interface AssetRawDeps {
  db: SqliteDb;
  secret: string;
  blobs: BlobStore;
  /** 匿名开关 env 缺省（settings 双层真源的 env 层——http 装配注入）。 */
  allowAnonymousEnv?: boolean;
}

/** raw 面单件字节上限（与 assets.upload 单件门同量级——先查行后读字节）。 */
export const ASSETS_RAW_MAX_BYTES = 32 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, error: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error }));
}

/**
 * /api/assets/{ref}/raw?w=：鉴权→blob 行在场判定→尺寸门→魔数嗅探→字节发送。
 * 404 面：无 token/坏 token=401；blob 行缺失=404（不泄露存在性）；伪图/坏
 * 类型=415（raw 仍为图片面——JSON 等非图片工件不在此出口）；超限=413。
 */
export async function handleAssetRawRequest(
  deps: AssetRawDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  blobRef: string,
): Promise<void> {
  const authorization = request.headers.authorization;
  const token =
    (authorization !== undefined && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined) ??
    url.searchParams.get('token') ??
    undefined;
  const user = await authenticate(deps.secret, deps.db, token, deps.allowAnonymousEnv ?? false);
  if (!user) {
    sendJson(response, 401, '需要登录（附件 raw 面 auth 作用域）');
    return;
  }
  // w 参数：第一版服务端不缩放（预留位——存在即接受，值不参与行为）。
  // blobRef 直读兜底（w20 走查 major-1，2026-10-02）：原归属校验
  // （userOwnsBlobRef=blob_uploads ∪ session_blob_refs）把任务域中间产物
  // （putTaskArtifact 只 blobs.put 不入账本——识图归一底图/scene-analysis 工件）
  // 一律 404，活动产出缩略图全裂。现口径：token 门已过（上方 authenticate——
  // 鉴权强度不降）+ blobs 表 active 行在场即直读（内容寻址 hex 不可枚举、不经
  // 公开面泄漏——见文件头 [2] 安全面注记）；行缺失=404（不泄露存在性语义保留）。
  // admin 豁免分支随兜底自然消解（全部在场行对全部已鉴权用户可读）。
  const row = deps.blobs.rowOf(blobRef);
  if (row === null) {
    sendJson(response, 404, '附件不存在或已回收');
    return;
  }
  if (row.size > ASSETS_RAW_MAX_BYTES) {
    sendJson(response, 413, `附件超过 ${ASSETS_RAW_MAX_BYTES} 字节上限（实为 ${row.size}）`);
    return;
  }
  const bytes = deps.blobs.read(blobRef);
  if (bytes === null) {
    sendJson(response, 404, '附件内容不可读');
    return;
  }
  const mime = sniffImageMime(bytes);
  if (mime === null) {
    sendJson(response, 415, '附件不是受支持的图片（png/jpeg/webp 魔数嗅探失败）');
    return;
  }
  const headers: Record<string, string | number> = {
    'content-type': mime,
    'content-length': bytes.byteLength,
    etag: `"${blobRef}"`,
    // 内容寻址不可变，但按 token 鉴权面保守 no-cache（ETag 304 廉价再验证）。
    'cache-control': 'private, no-cache',
    'content-disposition': `inline; filename="attachment-${blobRef.slice(0, 12)}"`,
  };
  if (request.headers['if-none-match'] === `"${blobRef}"`) {
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
