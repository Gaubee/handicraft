/**
 * 分享包（design §2 静态托管行：/r/{public_id} + containment/Range——zhumo 模式）。
 * 原始需求 2026-09-23（W2.3）：export job 三产物（SVG/BOM/PNG）→ blob 落库（内容
 * 寻址引用）+ 独立 bundle 目录（results/<publicId>/——与会话/blob GC 解耦的分享留存，
 * §6.5 result→blob 引用行独立生命周期的 W2 简化实现：bundle 目录自持有文件副本，
 * 完整 TTL/revoke 机制归 W3）。
 * 正交意图：
 *   [1] createShareBundle：三产物 bytes → blobs.put（manifest blobRefs）+ bundle 目录
 *       文件副本 + bundle.json manifest + results 行（public_id 唯一）。
 *   [2] bundle 读面：manifest/文件路径解析（containment 归 http.ts 发送面）。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BlobRef } from '@handicraft/contracts';
import { createResult } from './db/jobs.js';
import type { BlobStore } from './db/blobs.js';
import type { JobServiceDeps } from './jobs/service.js';

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

export async function createShareBundle(
  deps: Pick<JobServiceDeps, 'config' | 'db' | 'blobs'>,
  input: ShareBundleInput,
): Promise<ShareBundle> {
  const svgPut = deps.blobs.put(input.files.svg);
  const bomPut = deps.blobs.put(input.files.bom);
  const pngPut = deps.blobs.put(input.files.png);
  const blobRefs = { svg: svgPut.hash, bom: bomPut.hash, png: pngPut.hash };

  const publicId = newPublicId();
  const bundlePath = path.join(shareBundleRoot(deps.config.dataRoot), publicId);
  mkdirSync(bundlePath, { recursive: true });
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
  writeFileSync(path.join(bundlePath, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(bundlePath, 'layout.svg'), input.files.svg);
  writeFileSync(path.join(bundlePath, 'bom.csv'), input.files.bom);
  writeFileSync(path.join(bundlePath, 'render.png'), input.files.png);

  const row = createResult(deps.db, {
    publicId,
    taskId: input.taskId,
    ownerId: input.ownerId,
    title: input.title,
    bundlePath,
  });
  // task 行回链（export job 的 result 视图投影）
  deps.db
    .prepare('UPDATE tasks SET result_id = ?, updated_at = ? WHERE id = ?')
    .run(row.id, new Date().toISOString(), input.taskId);
  return { resultId: row.id, publicId, bundlePath, blobRefs };
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
