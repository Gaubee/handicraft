/**
 * ComputeProvider 缝 + InlineProvider 测试（design §5）：幂等键（同键重放同 JobRef）、
 * status 状态机、result 内容寻址、cancel 协作取消。
 */
import { describe, expect, it } from 'vitest';
import { ComputeError } from '../src/compute/provider.js';
import { InlineProvider } from '../src/compute/inline.js';
import { openDatabase } from '../src/db/database.js';
import { BlobStore } from '../src/db/blobs.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ComputeSpec } from '../src/compute/provider.js';

const SPEC: ComputeSpec = { kind: 'generate-image', version: 1, prompt: 'p', model: 'm' };

function makeBlobs(): { blobs: BlobStore; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'compute-'));
  const db = openDatabase(path.join(root, 'data'));
  const blobs = new BlobStore(path.join(root, 'data'), db);
  return { blobs, dispose: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe('InlineProvider（design §5 缝）', () => {
  it('submit→running→succeeded：result=内容寻址 blobRef，幂等键重放同 JobRef', async () => {
    const { blobs, dispose } = makeBlobs();
    try {
      const provider = new InlineProvider(blobs, async (spec) => {
        expect(spec.kind).toBe('generate-image');
        return new Uint8Array([1, 2, 3]);
      });
      const ref = await provider.submit(SPEC, 'idem-1');
      expect(ref.provider).toBe('inline');
      const refAgain = await provider.submit(SPEC, 'idem-1');
      expect(refAgain).toEqual(ref); // 同键重放同 JobRef
      const blobRef = await provider.result(ref);
      expect(blobRef).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.from(blobs.read(blobRef)!)).toEqual([1, 2, 3]);
      expect((await provider.status(ref)).state).toBe('succeeded');
    } finally {
      dispose();
    }
  });

  it('executor 抛错：failed 状态 + result 抛 ComputeError（携带原因）', async () => {
    const { blobs, dispose } = makeBlobs();
    try {
      const provider = new InlineProvider(blobs, async () => {
        throw new Error('上游 500');
      });
      const ref = await provider.submit(SPEC, 'idem-2');
      await expect(provider.result(ref)).rejects.toThrow(ComputeError);
      const status = await provider.status(ref);
      expect(status.state).toBe('failed');
      expect(status.error).toContain('上游 500');
    } finally {
      dispose();
    }
  });

  it('cancel：协作取消（executor 感知 signal）→ cancelled 状态', async () => {
    const { blobs, dispose } = makeBlobs();
    try {
      const provider = new InlineProvider(blobs, (_spec, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('已取消')));
        }),
      );
      const ref = await provider.submit(SPEC, 'idem-3');
      await provider.cancel(ref);
      const status = await provider.status(ref);
      expect(status.state).toBe('cancelled');
      await expect(provider.result(ref)).rejects.toThrow('已取消');
    } finally {
      dispose();
    }
  });

  it('未知 ref：status/result 显式 ComputeError', async () => {
    const { blobs, dispose } = makeBlobs();
    try {
      const provider = new InlineProvider(blobs, async () => new Uint8Array(1));
      await expect(provider.status({ provider: 'inline', id: 'ghost' })).rejects.toThrow(ComputeError);
    } finally {
      dispose();
    }
  });
});
