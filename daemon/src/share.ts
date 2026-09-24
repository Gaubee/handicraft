/**
 * 分享包（design §2 静态托管行：/r/{public_id} + containment/Range——zhumo 模式）。
 * 原始需求 2026-09-23（W2.3）：export job 三产物（SVG/BOM/PNG）→ blob 落库（内容
 * 寻址引用）+ 独立 bundle 目录（results/<publicId>/——与会话/blob GC 解耦的分享留存，
 * §6.5 result→blob 引用行独立生命周期的 W2 简化实现：bundle 目录自持有文件副本，
 * 完整 TTL/revoke 机制归 W3）。
 * 正交意图：
 *   [1] createShareBundle（W3 评审 P1-1 起 fenced；R2 收口）：fence CAS（task 存在
 *       且未取消+session active）与 blob 行/bundle/result 行/task 回链同事务提交；
 *       staged 物理发布与 bundle 目录发布全阶段纳入同一异常回收边界（R2：发布前半
 *       段失败同样回收），回收失败进持久 outbox；bundle 目录自持有文件副本（§6.5
 *       分享留存——完整 TTL/revoke 机制归 W3.2 sweepExpiredResults）。
 *   [2] bundle 读面：manifest/文件路径解析（containment 归 http.ts 发送面）。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BlobRef } from '@handicraft/contracts';
import { createResult } from './db/jobs.js';
import { addResultBlobRefs, enqueueOutbox } from './db/sessions.js';
import type { BlobStore, BlobStaged } from './db/blobs.js';
import type { JobServiceDeps } from './jobs/service.js';
import { ArtifactFenceError, assertTaskWritable } from './writer-fence.js';

/** custom 形资产解析产物（.gemshape 的最小渲染面——vectorPath 矢量优先）。 */
export interface ShapeAssetSource {
  vectorPath?: string;
  image?: { mime: string; dataUrl: string; width: number; height: number };
}

export interface ShareBundleInput {
  taskId: string;
  ownerId: string;
  title: string;
  files: { svg: Uint8Array; bom: Uint8Array; png: Uint8Array };
  /** 取消信号（每个外部副作用前的第一道检查——runner 传入 ctx.signal）。 */
  signal?: AbortSignal;
}

export interface ShareBundle {
  resultId: string;
  publicId: string;
  bundlePath: string;
  /** 三产物内容寻址引用（manifest 三元组——task.result 视图投影源）。 */
  blobRefs: { svg: BlobRef; bom: BlobRef; png: BlobRef };
}

/** public_id：12 位 base62（zhumo newPublicId 同式）。 */
export function newPublicId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let id = '';
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

export function shareBundleRoot(dataRoot: string): string {
  return path.join(dataRoot, 'results');
}

/**
 * 创建分享包（W3 评审 P1-1 修复：session/task fenced 产物提交——同步函数）。
 * 协议（staging/outbox 恢复语义）：
 *   1. 取消信号前置检查 + fence 预探测（避免对已不可写任务做无谓工作）。
 *   2. 事务外文件发布：三产物 staged 物理写（不提交行）+ bundle 目录副本
 *      （results/ 为分享留存面，本就不随会话回收）。
 *   3. 单一 SQLite 事务：fence CAS 重验（task 存在 + session active）→ blob 行/
 *      result 行/引用/task 回链全部提交——fence 拒绝则整体回滚，无半提交。
 *   4. 事务失败（fence 或其他）→ 已发布文件回收：内联删除，失败进持久 outbox
 *      （复用 §6.5 清理机制）兜底；blob 未提交行文件另由启动孤儿回收清扫。
 */
export function createShareBundle(
  deps: Pick<JobServiceDeps, 'config' | 'db' | 'blobs'>,
  input: ShareBundleInput,
): ShareBundle {
  if (input.signal?.aborted) throw new ArtifactFenceError('任务已取消，中止分享包发布');
  assertTaskWritable(deps.db, input.taskId);

  const publicId = newPublicId();
  const bundlePath = path.join(shareBundleRoot(deps.config.dataRoot), publicId);
  // W3 R2：staged 增量收集 + 发布全阶段（stage×3 → bundle 目录 → 提交事务）纳入
  // 同一异常回收边界——物理发布前半段失败同样回收，不留无 DB 行的孤儿文件/目录。
  const staged: BlobStaged[] = [];
  try {
    // 逐份 stage+入列：push 与 stage 同步成对——中段失败时已完成项必在列（可回收）。
    staged.push(deps.blobs.stage(input.files.svg));
    staged.push(deps.blobs.stage(input.files.bom));
    staged.push(deps.blobs.stage(input.files.png));
    const blobRefs = { svg: staged[0]!.hash, bom: staged[1]!.hash, png: staged[2]!.hash };

    const manifest = {
      publicId,
      title: input.title,
      taskId: input.taskId,
      createdAt: new Date().toISOString(),
      blobRefs,
      files: {
        svg: { name: 'layout.svg', mime: 'image/svg+xml', size: input.files.svg.byteLength },
        bom: { name: 'bom.csv', mime: 'text/csv', size: input.files.bom.byteLength },
        png: { name: 'render.png', mime: 'image/png', size: input.files.png.byteLength },
      },
    };
    publishBundleDir(bundlePath, manifest, input.files);

    const commit = deps.db.transaction((): ShareBundle => {
      // fence CAS 重验（单点）：事务内同步校验——clearing/cleared/取消/行已删在此拦截。
      assertTaskWritable(deps.db, input.taskId);
      for (const item of staged) deps.blobs.commitStaged(item);
      const row = createResult(deps.db, {
        publicId,
        taskId: input.taskId,
        ownerId: input.ownerId,
        title: input.title,
        bundlePath,
        // W3.2 §6.5：分享包独立 TTL（默认 7 天，.env RESULT_TTL_DAYS 可调）。
        expiresAt: new Date(Date.now() + deps.config.resultTtlDays * 24 * 60 * 60 * 1000).toISOString(),
      });
      // result→blob 引用行（§6.5）：分享包持有自己的引用（与会话引用独立计数）——
      // clear 只撤会话侧；TTL/revoke 到期由 sweepExpiredResults 释放这侧。
      addResultBlobRefs(deps.db, row.id, [blobRefs.svg, blobRefs.bom, blobRefs.png]);
      // task 行回链（export job 的 result 视图投影）
      deps.db
        .prepare('UPDATE tasks SET result_id = ?, updated_at = ? WHERE id = ?')
        .run(row.id, new Date().toISOString(), input.taskId);
      return { resultId: row.id, publicId, bundlePath, blobRefs };
    });
    return commit();
  } catch (error) {
    // 事务/发布任一失败：DB 侧整体回滚（无 blob/result/回链残留）——回收全部已发布文件。
    reclaimPublished(deps, staged, bundlePath, input.taskId);
    throw error;
  }
}

/** bundle 目录写入（事务外文件发布——publicId 唯一，目录不与他者冲突）。 */
function publishBundleDir(
  bundlePath: string,
  manifest: ShareBundleManifest,
  files: { svg: Uint8Array; bom: Uint8Array; png: Uint8Array },
): void {
  mkdirSync(bundlePath, { recursive: true });
  writeFileSync(path.join(bundlePath, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(bundlePath, 'layout.svg'), files.svg);
  writeFileSync(path.join(bundlePath, 'bom.csv'), files.bom);
  writeFileSync(path.join(bundlePath, 'render.png'), files.png);
}

/**
 * 事务失败后的文件回收：staged 新代文件与 bundle 目录内联删除；删除失败进持久
 * outbox（幂等重试兜底——不依赖进程存活）。回收自身的任何错误都不得掩盖原始
 * 失败（fence/DB）——未提交行的 staged 文件另由启动孤儿回收（sweepOrphanBlobFiles）
 * 二道清扫。
 */
function reclaimPublished(
  deps: Pick<JobServiceDeps, 'config' | 'db' | 'blobs'>,
  staged: BlobStaged[],
  bundlePath: string,
  taskId: string,
): void {
  const orphans: { kind: 'file' | 'dir'; path: string }[] = [];
  for (const item of staged) {
    if (item.deduped) continue; // 命中已有 active 行——文件非本次发布，不动
    let absolute: string | null = null;
    try {
      absolute = resolveStagedAbsolute(deps, item);
      if (absolute !== null && existsFile(absolute)) unlinkSync(absolute);
    } catch {
      if (absolute !== null) orphans.push({ kind: 'file', path: absolute });
    }
  }
  try {
    rmSync(bundlePath, { recursive: true, force: true });
  } catch {
    orphans.push({ kind: 'dir', path: bundlePath });
  }
  if (orphans.length > 0) {
    try {
      enqueueOutbox(deps.db, orphans.map((entry) => ({ ...entry })));
    } catch {
      // DB 已不可写（极端情形）——孤儿 blob 文件仍由启动孤儿回收兜底。
      console.error(
        `[share] 任务 ${taskId} 产物回收失败且 outbox 入队不可用：${orphans.map((o) => o.path).join('、')}`,
      );
    }
  }
}

/** staged 文件绝对路径（两级解析——任一失败返回 null 交由启动孤儿回收兜底）。 */
function resolveStagedAbsolute(deps: Pick<JobServiceDeps, 'blobs'>, item: BlobStaged): string | null {
  try {
    return deps.blobs.absolutePathOfStaged(item);
  } catch {
    try {
      return deps.blobs.absolutePathOf(item.relative);
    } catch {
      return null;
    }
  }
}

function existsFile(absolute: string): boolean {
  try {
    statSync(absolute);
    return true;
  } catch {
    return false;
  }
}

export interface ShareBundleManifest {
  publicId: string;
  title: string;
  taskId: string;
  createdAt: string;
  blobRefs: { svg: string; bom: string; png: string };
  files: Record<'svg' | 'bom' | 'png', { name: string; mime: string; size: number }>;
}

export function fileNameOfBundle(key: 'svg' | 'bom' | 'png'): string {
  return { svg: 'layout.svg', bom: 'bom.csv', png: 'render.png' }[key];
}
