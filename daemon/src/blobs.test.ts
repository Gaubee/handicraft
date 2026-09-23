/**
 * BlobStore 单测（W1.2 任务门）：同内容去重 ref++、代际物理路径
 * `<sha256>.<rowGen>`、原子写、归零置 deleting（不删文件）、deleting 行不复活。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from './db/database.js';
import { BlobStore } from './db/blobs.js';

const stores: { db: SqliteDb; dir: string }[] = [];
function tempStore(): { store: BlobStore; db: SqliteDb; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'handicraft-blobs-'));
  const db = openDatabase(dir);
  stores.push({ db, dir });
  return { store: new BlobStore(dir, db), db, dir };
}
afterEach(() => {
  for (const { db, dir } of stores.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe('内容寻址与去重', () => {
  it('同内容二写：deduped=true、ref_count++、不新增物理文件', () => {
    const { store, dir } = tempStore();
    const data = new TextEncoder().encode('hello gems');
    const first = store.put(data);
    expect(first.deduped).toBe(false);
    const second = store.put(data);
    expect(second.deduped).toBe(true);
    expect(second.rowGen).toBe(first.rowGen);
    expect(store.rowOf(first.hash)?.ref_count).toBe(2);
    // 物理文件只有一个
    const blobsDir = path.join(dir, 'blobs', first.hash.slice(0, 2));
    expect(readdirSync(blobsDir)).toHaveLength(1);
  });
  it('读回字节一致', () => {
    const { store } = tempStore();
    const data = new TextEncoder().encode('payload-π');
    const { hash } = store.put(data);
    expect(store.read(hash)).toEqual(Buffer.from(data));
  });
});

describe('代际物理路径与原子写', () => {
  it('物理文件名 = <sha256>.<rowGen>；无 staging 残留', () => {
    const { store, dir } = tempStore();
    const data = new TextEncoder().encode('gen-test');
    const { hash, rowGen } = store.put(data);
    const file = path.join(dir, 'blobs', hash.slice(0, 2), `${hash}.${rowGen}`);
    expect(existsSync(file)).toBe(true);
    expect(rowGen).toMatch(/^[0-9a-f-]{36}$/); // UUID
    const blobsDir = path.join(dir, 'blobs', hash.slice(0, 2));
    for (const name of readdirSync(blobsDir)) {
      expect(name.endsWith('.staging') || name.includes('.staging-')).toBe(false);
    }
  });
});

describe('引用归零 → deleting 状态位（本波不删文件）', () => {
  it('单引用释放：行置 deleting、ref_count=0、**文件仍在**（outbox 留 W3）', () => {
    const { store, db, dir } = tempStore();
    const data = new TextEncoder().encode('will-drop');
    const { hash, rowGen } = store.put(data);
    store.releaseRef(hash);
    // active 行消失（读面 null）
    expect(store.rowOf(hash)).toBeNull();
    const row = db
      .prepare('SELECT * FROM blobs WHERE row_gen = ?')
      .get(rowGen) as { status: string; ref_count: number };
    expect(row.status).toBe('deleting');
    expect(row.ref_count).toBe(0);
    // 文件未删
    const file = path.join(dir, 'blobs', hash.slice(0, 2), `${hash}.${rowGen}`);
    expect(existsSync(file)).toBe(true);
  });
  it('双引用释放一次：仍 active 计数 1；再释放才置 deleting', () => {
    const { store } = tempStore();
    const data = new TextEncoder().encode('two-refs');
    const { hash } = store.put(data);
    store.put(data);
    store.releaseRef(hash);
    expect(store.rowOf(hash)?.ref_count).toBe(1);
    store.releaseRef(hash);
    expect(store.rowOf(hash)).toBeNull();
  });
});

describe('deleting 行不复活（R4 代际防复活）', () => {
  it('归零 deleting 后同内容再 put：新行+新物理文件（新 rowGen），旧文件不动', () => {
    const { store, db, dir } = tempStore();
    const data = new TextEncoder().encode('resurrect-test');
    const old = store.put(data);
    store.releaseRef(old.hash); // → deleting，文件留存
    const fresh = store.put(data);
    expect(fresh.deduped).toBe(false);
    expect(fresh.rowGen).not.toBe(old.rowGen); // 新代
    // 新旧两个物理文件并存（旧代由 W3 outbox 收敛）
    const blobsDir = path.join(dir, 'blobs', old.hash.slice(0, 2));
    expect(readdirSync(blobsDir).sort()).toEqual(
      [`${old.hash}.${old.rowGen}`, `${fresh.hash}.${fresh.rowGen}`].sort(),
    );
    // 新行可读、计数独立
    expect(store.read(fresh.hash)).toEqual(Buffer.from(data));
    expect(store.rowOf(fresh.hash)?.ref_count).toBe(1);
    // 旧行保持 deleting（不被新 put 复活/改动）
    const oldRow = db
      .prepare('SELECT * FROM blobs WHERE row_gen = ?')
      .get(old.rowGen) as { status: string };
    expect(oldRow.status).toBe('deleting');
  });
});
