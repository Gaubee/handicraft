/**
 * 内容寻址 blob 存取——代际行模型（design §6.5 R4/R5 冻结）。
 * 原始需求 2026-09-23（W1.2）：sha256 内容寻址 + ref_count + 行级 rowGen（UUID）
 * 物理路径 `<sha256>.<rowGen>` + 原子写（staging→rename→DB 提交）+ 归零置
 * deleting 状态位（物理删除走 outbox——W3 接线，本波只建状态位）。
 * 竞态消除（R4）：引用归零的行置 deleting **阻止引用复活**——新 put 命中同
 * sha256 的 deleting 行=插入新行+新物理文件（新 rowGen 路径），旧行未来的
 * unlink 结构性不可能命中新代文件。
 * 正交意图：
 *   [1] put：active 行命中=ref_count++（稳态去重不写盘）；否则新代行落库。
 *   [2] releaseRef：递减；归零置 deleting（不删文件——outbox 留 W3）。
 *   [3] read/open：按 active 行取回字节。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { SqliteDb } from './database.js';
import { nowIso } from './store.js';

export interface BlobPutResult {
  hash: string;
  /** 行主键 UUID（代际标识——物理路径组成部分，永不复用） */
  rowGen: string;
  size: number;
  /** 是否命中已有 active 行（未重复写盘） */
  deduped: boolean;
}

interface BlobRow {
  row_gen: string;
  hash: string;
  size: number;
  store_path: string;
  ref_count: number;
  status: 'active' | 'deleting';
}

export class BlobStore {
  private readonly root: string;

  constructor(
    private readonly dataRoot: string,
    private readonly db: SqliteDb,
  ) {
    this.root = path.join(dataRoot, 'blobs');
  }

  /** 代际物理文件名：`<sha256>.<rowGen>`（R4/R5——旧行 unlink 不可能命中新代）。 */
  static fileNameOf(hash: string, rowGen: string): string {
    return `${hash}.${rowGen}`;
  }

  /** hash 对应 active 行的实体文件绝对路径（无 active 行返回 null）。 */
  pathFor(hash: string): string | null {
    const row = this.activeRowOf(hash);
    return row ? path.join(this.root, row.store_path) : null;
  }

  /** 行 store_path（相对）→ 绝对路径（W3.2 outbox 入队面——完整旧代物理路径持久化）。 */
  absolutePathOf(storePath: string): string {
    return path.join(this.root, storePath);
  }

  /** deleting 行集合（W3.2 clear/outbox 接线：归零待物理回收的行投影）。 */
  listDeletingRows(): { row_gen: string; hash: string; store_path: string }[] {
    return this.db
      .prepare("SELECT row_gen, hash, store_path FROM blobs WHERE status = 'deleting'")
      .all() as { row_gen: string; hash: string; store_path: string }[];
  }

  /**
   * 写入（内容寻址）：active 行命中=ref_count++ 去重；否则新代行。
   * 发布顺序冻结（R5）：staging 临时路径 → 原子 rename 到正式路径 → DB 行提交。
   */
  put(data: Uint8Array): BlobPutResult {
    const hash = createHash('sha256').update(data).digest('hex');
    const size = data.byteLength;
    const existing = this.activeRowOf(hash);
    if (existing) {
      this.db
        .prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE row_gen = ?')
        .run(existing.row_gen);
      return { hash, rowGen: existing.row_gen, size, deduped: true };
    }
    // deleting 行（或全新 hash）：一律新代行+新物理文件——复活防护。
    const rowGen = randomUUID();
    const relative = path.join(hash.slice(0, 2), BlobStore.fileNameOf(hash, rowGen));
    const target = path.join(this.root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    const staging = `${target}.staging-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    writeBufferTo(staging, data);
    renameSync(staging, target);
    this.db
      .prepare(
        'INSERT INTO blobs (row_gen, hash, size, store_path, ref_count, status, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      )
      .run(rowGen, hash, size, relative, 'active', nowIso());
    return { hash, rowGen, size, deduped: false };
  }

  /** 取回完整字节（active 行）；未知 hash 或实体缺失返回 null。 */
  read(hash: string): Buffer | null {
    const file = this.pathFor(hash);
    return file && existsSync(file) ? readFileSync(file) : null;
  }

  /**
   * 解除一引用：递减 active 行计数；归零置 **deleting 状态位**（阻止复活；
   * 物理删除走 cleanup outbox——W3 接线，本波不删文件）。
   */
  releaseRef(hash: string): void {
    const row = this.activeRowOf(hash);
    if (!row) return;
    const next = row.ref_count - 1;
    if (next > 0) {
      this.db
        .prepare('UPDATE blobs SET ref_count = ? WHERE row_gen = ? AND status = ?')
        .run(next, row.row_gen, 'active');
      return;
    }
    this.db
      .prepare("UPDATE blobs SET ref_count = 0, status = 'deleting' WHERE row_gen = ? AND status = 'active'")
      .run(row.row_gen);
  }

  /** 行视图（测试/维护面）。 */
  rowOf(hash: string): BlobRow | null {
    return this.activeRowOf(hash);
  }

  private activeRowOf(hash: string): BlobRow | null {
    const row = this.db
      .prepare("SELECT * FROM blobs WHERE hash = ? AND status = 'active'")
      .get(hash) as BlobRow | undefined;
    return row ?? null;
  }
}

/** 分片写盘（大文件不全量驻留写缓冲）。 */
function writeBufferTo(stagingPath: string, data: Uint8Array): void {
  const fd = openSync(stagingPath, 'w');
  try {
    let offset = 0;
    while (offset < data.byteLength) {
      const written = writeSync(fd, data, offset);
      if (written <= 0) throw new Error('blob 写入停滞');
      offset += written;
    }
  } finally {
    closeSync(fd);
  }
}
