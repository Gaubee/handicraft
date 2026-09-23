/**
 * 四族格式资源往返（design §6 护栏：当前版本内 .gemproj/.gemdoc/.gemtpl/.gemgen 与
 * 服务器资源模型的语义无损导入导出 MUST；跨版本向前拒读——版本门对齐
 * rhinestone-studio persistence 层 PROJECTFILE_FORMAT_VERSIONS/LABFILE_FORMAT_VERSIONS
 * 镜像常量（contracts PROJECT_FORMAT_VERSIONS——W2.3 服务面消费））。
 * W2 口径：导入=envelope 门（kind + formatVersion=当前版本）+ 整文档落 resource
 * （content_hash 内容寻址 + meta 摘要）；导出=文档字节原样回放——语义无损由
 * 「解析→资源→再导出」的深比较 fixture 断言（不要求字节相等；实测字节亦等）。
 * 全字段 schema 校验（persistence 层序列化器完整镜像）归 W3 资源工作台面。
 */
import {
  PROJECT_FORMAT_VERSIONS,
  PROJECT_MIME_OF,
  type ProjectFormatKind,
} from '@handicraft/contracts';
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from './db/database.js';
import type { BlobStore } from './db/blobs.js';
import { nowIso } from './db/store.js';

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

interface ResourceRow {
  id: string;
  owner_id: string;
  name: string;
  content_hash: string | null;
  meta: string | null;
  revision: number;
}

export interface ImportFormatResult {
  resourceId: string;
  kind: ProjectFormatKind;
  formatVersion: number;
  revision: number;
}

const KIND_BY_EXTENSION: Record<string, ProjectFormatKind> = {
  '.gemproj': 'gemproj',
  '.gemdoc': 'gemdoc',
  '.gemtpl': 'gemtpl',
  '.gemgen': 'gemgen',
};

/** envelope 门：JSON → {kind, formatVersion, document}（版本不符=typed 拒读）。 */
export function parseFormatEnvelope(bytes: Uint8Array, filename: string): {
  kind: ProjectFormatKind;
  formatVersion: number;
  document: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new FormatError(`文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FormatError('文件根不是 JSON 对象');
  }
  const document = parsed as Record<string, unknown>;
  const kind = document['kind'];
  if (typeof kind !== 'string' || !(kind in PROJECT_FORMAT_VERSIONS)) {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const byExt = KIND_BY_EXTENSION[ext];
    if (byExt && kind !== byExt) {
      throw new FormatError(`文件内 kind（${String(kind)}）与扩展名（${byExt}）不符`);
    }
    throw new FormatError(`不支持的 kind：${String(kind)}（支持 gemproj/gemdoc/gemtpl/gemgen）`);
  }
  const typedKind = kind as ProjectFormatKind;
  const version = document['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new FormatError('formatVersion 缺失或非整数');
  }
  const supported = PROJECT_FORMAT_VERSIONS[typedKind];
  if (version > supported) {
    // 跨版本向前拒读（spec：旧版本文件可显式拒读报版本错误，不静默丢字段）
    throw new FormatError(
      `文件来自更新版本的应用（${typedKind} v${version} > 本应用支持的 v${supported}），请升级后再打开`,
    );
  }
  if (version < supported) {
    throw new FormatError(
      `文件版本过低（${typedKind} v${version} < 当前 v${supported}），本波不携带迁移链——显式拒读`,
    );
  }
  return { kind: typedKind, formatVersion: version, document };
}

/** 导入：envelope 门 → blob 内容寻址 + resources 行（owner 归属 + meta 摘要）。 */
export function importFormat(
  db: SqliteDb,
  blobs: BlobStore,
  ownerId: string,
  filename: string,
  bytes: Uint8Array,
): ImportFormatResult {
  const { kind, formatVersion, document } = parseFormatEnvelope(bytes, filename);
  const put = blobs.put(bytes);
  const resourceId = randomUUID();
  db.prepare(
    'INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, ?, ?, ?, 1, ?, ?)',
  ).run(
    resourceId,
    ownerId,
    filename,
    put.hash,
    bytes.byteLength,
    JSON.stringify({ kind, formatVersion, mime: PROJECT_MIME_OF[kind] }),
    nowIso(),
    nowIso(),
  );
  void document;
  return { resourceId, kind, formatVersion, revision: 1 };
}

/** 导出：resource → 文档字节（content blob 原样——当前版本内语义无损）。 */
export function exportFormat(
  db: SqliteDb,
  blobs: BlobStore,
  ownerId: string,
  resourceId: string,
): { filename: string; kind: ProjectFormatKind; bytes: Uint8Array } {
  const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as
    | ResourceRow
    | undefined;
  if (!row) throw new FormatError(`资源不存在：${resourceId}`);
  if (row.owner_id !== ownerId) throw new FormatError('无权导出他人资源');
  if (!row.content_hash) throw new FormatError('资源无内容（目录或空资源）');
  const bytes = blobs.read(row.content_hash);
  if (bytes === null) throw new FormatError('资源内容已回收（blob 缺失）');
  const meta = row.meta ? (JSON.parse(row.meta) as { kind?: string }) : {};
  if (typeof meta.kind !== 'string' || !(meta.kind in PROJECT_FORMAT_VERSIONS)) {
    throw new FormatError(`资源不是四族格式（kind=${String(meta.kind)}）`);
  }
  return { filename: row.name, kind: meta.kind as ProjectFormatKind, bytes };
}
