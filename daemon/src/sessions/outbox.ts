/**
 * cleanup outbox 处理器（design §6.5 跨介质清理协议第 2 步——事务外幂等 unlink）。
 * 原始需求 2026-09-23（W3.2）：按 outbox 逐个删文件；单文件失败不回滚，记 failed
 * 待重试（启动重放+例行维护 requeue）；blob 条目 unlink 前事务内重验行状态
 * （第二道保险——代际路径已结构性消除竞态，重验保留为纵深防御）。
 * 正交意图：
 *   [1] processAll：pending 条目逐个处理（blob 重验→unlink / file unlink / dir 递归删），
 *       完成即标 done + blob 行终删（同事务）。
 *   [2] containment：outbox 路径必须落在 DATA_ROOT 内（路径持久化但仍是防御面）。
 */
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import {
  completeOutboxEntry,
  failOutboxEntry,
  type OutboxEntryInput,
  type OutboxRow,
  enqueueOutbox,
  listOutboxPending,
} from '../db/sessions.js';

export interface OutboxDeps {
  config: AppConfig;
  db: SqliteDb;
  blobs: BlobStore;
}

interface BlobStateRow {
  status: 'active' | 'deleting';
  ref_count: number;
  store_path: string;
}

export class CleanupOutbox {
  constructor(private readonly deps: OutboxDeps) {}

  /** 入队（薄封装——调用方在 DB 事务内调用以保原子）。 */
  enqueue(entries: OutboxEntryInput[]): OutboxRow[] {
    return enqueueOutbox(this.deps.db, entries);
  }

  /** 幂等处理全部 pending 条目；返回处理计数（done/failed 分开计）。 */
  processAll(): { done: number; failed: number } {
    let done = 0;
    let failed = 0;
    for (const row of listOutboxPending(this.deps.db)) {
      const outcome = this.processEntry(row);
      if (outcome === 'done') done += 1;
      else failed += 1;
    }
    return { done, failed };
  }

  private processEntry(row: OutboxRow): 'done' | 'failed' {
    const dataRoot = path.resolve(this.deps.config.dataRoot);
    const resolved = path.resolve(row.path);
    // containment：持久化路径也只可信到 DATA_ROOT 边界内。
    if (resolved !== dataRoot && !resolved.startsWith(dataRoot + path.sep)) {
      console.error(`[outbox] 条目 ${row.id} 路径越界（${row.path}），标 failed 供排查`);
      failOutboxEntry(this.deps.db, row.id);
      return 'failed';
    }
    try {
      if (row.kind === 'blob') {
        const verdict = this.verifyBlobBeforeUnlink(row, resolved);
        if (verdict === 'failed') {
          failOutboxEntry(this.deps.db, row.id);
          return 'failed';
        }
        removeFile(resolved);
      } else if (row.kind === 'dir') {
        // recursive+force：目录不存在=已完成（幂等）。
        rmSync(resolved, { recursive: true, force: true });
      } else {
        removeFile(resolved);
      }
      // 同事务：标 done +（blob 条目）终删 blobs 行——文件已回收，行保留无意义。
      completeOutboxEntry(this.deps.db, row.id);
      return 'done';
    } catch (error) {
      console.error(
        `[outbox] 条目 ${row.id}（${row.kind} ${row.path}）处理失败：${error instanceof Error ? error.message : String(error)}`,
      );
      failOutboxEntry(this.deps.db, row.id);
      return 'failed';
    }
  }

  /**
   * blob unlink 前重验（第二道保险，design §6.5 R3）：行必须仍为 deleting 且引用为 0，
   * 且 store_path 解析后与 outbox 持久化路径一致。行不存在=前次已完成（幂等放行）。
   */
  private verifyBlobBeforeUnlink(row: OutboxRow, resolved: string): 'ok' | 'gone' | 'failed' {
    if (!row.blob_row) return 'failed';
    const blobRow = this.deps.db
      .prepare('SELECT status, ref_count, store_path FROM blobs WHERE row_gen = ?')
      .get(row.blob_row) as BlobStateRow | undefined;
    if (!blobRow) return 'gone';
    if (blobRow.status !== 'deleting' || blobRow.ref_count !== 0) {
      console.error(
        `[outbox] blob 行 ${row.blob_row} 重验失败（status=${blobRow.status} ref_count=${blobRow.ref_count}），不删文件`,
      );
      return 'failed';
    }
    const expected = path.resolve(this.deps.config.dataRoot, 'blobs', blobRow.store_path);
    if (expected !== resolved) {
      console.error(`[outbox] blob 行 ${row.blob_row} 路径漂移（${expected} != ${resolved}）`);
      return 'failed';
    }
    return 'ok';
  }
}

/** 单文件幂等删除（ENOENT=已完成）。 */
function removeFile(resolved: string): void {
  if (!existsSync(resolved)) return;
  try {
    unlinkSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
