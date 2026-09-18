/**
 * fake IndexedDB 能力测试（add-asset-library 任务 0.1）：
 * 多 objectStore / version upgrade（oldVersion 透传）/ index 查询 /
 * readwrite 事务（commit/abort 回滚）/ 中途失败注入。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { installFakeIndexedDB, type FakeIndexedDB, type FakeVersionChangeEvent } from './fakeIndexedDB'

let fake: FakeIndexedDB

beforeEach(() => {
  fake = installFakeIndexedDB()
  fake.reset()
})

interface OpenedDb {
  db: Awaited<ReturnType<FakeIndexedDB['open']>>['result']
  oldVersions: number[]
}

function openAt(version?: number): Promise<OpenedDb> {
  const request = fake.open('rhinestone-studio', version)
  const oldVersions: number[] = []
  request.onupgradeneeded = (ev) => {
    oldVersions.push((ev as FakeVersionChangeEvent).oldVersion)
  }
  return new Promise<OpenedDb>((resolve, reject) => {
    request.onsuccess = () => resolve({ db: request.result, oldVersions })
    request.onerror = () => reject(request.error)
  })
}

function put(db: OpenedDb['db'], storeName: string, record: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const request = tx.objectStore(storeName).put(record)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function get(db: OpenedDb['db'], storeName: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe('fake IndexedDB：版本与 upgrade', () => {
  it('首次 open 透传 oldVersion=0，可建多 store + index；同版本重开不再 upgrade', async () => {
    const first = await openAt(2)
    expect(first.oldVersions).toEqual([0])
    first.db.createObjectStore('images', { keyPath: 'id' })
    const nodes = first.db.createObjectStore('assetNodes', { keyPath: 'id' })
    nodes.createIndex('parentId', 'parentId')
    expect(first.db.objectStoreNames.contains('images')).toBe(true)
    expect(first.db.objectStoreNames.contains('assetNodes')).toBe(true)
    expect(fake.version).toBe(2)

    const again = await openAt(2)
    expect(again.oldVersions).toEqual([])
    expect(again.db).toBe(first.db)
  })

  it('v1 → v2：oldVersion=1 透传，v1 数据保留（旧库升级语义）', async () => {
    const v1 = await openAt(1)
    v1.db.createObjectStore('images', { keyPath: 'id' })
    await put(v1.db, 'images', { id: 'legacy-key', blob: 'B', createdAt: 1 })

    const v2 = await openAt(2)
    expect(v2.oldVersions).toEqual([1])
    expect(fake.version).toBe(2)
    const record = (await get(v2.db, 'images', 'legacy-key')) as { id: string }
    expect(record.id).toBe('legacy-key')
  })

  it('请求低于当前版本 → VersionError，不触发 upgrade', async () => {
    await openAt(2)
    const request = fake.open('rhinestone-studio', 1)
    const error = await new Promise<DOMException | null>((resolve) => {
      request.onerror = () => resolve(request.error)
      request.onsuccess = () => resolve(null)
    })
    expect(error?.name).toBe('VersionError')
  })

  it('reset 后重开为全新库（连接缓存失效语义）', async () => {
    const first = await openAt(1)
    first.db.createObjectStore('images', { keyPath: 'id' })
    await put(first.db, 'images', { id: 'a', blob: 'x', createdAt: 1 })
    fake.reset()
    const second = await openAt(1)
    second.db.createObjectStore('images', { keyPath: 'id' })
    expect(await get(second.db, 'images', 'a')).toBeUndefined()
  })
})

describe('fake IndexedDB：index 查询', () => {
  async function dbWithNodes(): Promise<OpenedDb['db']> {
    const opened = await openAt(1)
    opened.db.createObjectStore('assetNodes', { keyPath: 'id' }).createIndex('parentId', 'parentId')
    await put(opened.db, 'assetNodes', { id: 'a', parentId: 'folder-1' })
    await put(opened.db, 'assetNodes', { id: 'b', parentId: 'folder-1' })
    await put(opened.db, 'assetNodes', { id: 'c', parentId: null })
    await put(opened.db, 'assetNodes', { id: 'd' }) // 无 parentId 字段：不进 index
    return opened.db
  }

  function indexGetAll(
    db: OpenedDb['db'],
    key: IDBValidKey | null | undefined,
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('assetNodes', 'readonly')
      const index = tx.objectStore('assetNodes').index('parentId')
      const request = key === undefined ? index.getAll() : index.getAll(key)
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
  }

  it('getAll(key) 按外键过滤；getAll() 返回全部含字段记录（无字段记录除外）；index.get 命中首条', async () => {
    const db = await dbWithNodes()
    expect((await indexGetAll(db, 'folder-1')).map((r) => (r as { id: string }).id).sort()).toEqual(['a', 'b'])
    expect((await indexGetAll(db, null)).map((r) => (r as { id: string }).id)).toEqual(['c'])
    expect((await indexGetAll(db, undefined)).map((r) => (r as { id: string }).id).sort()).toEqual(['a', 'b', 'c'])

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('assetNodes', 'readonly')
      const request = tx.objectStore('assetNodes').index('parentId').get('folder-1')
      request.onsuccess = () => {
        expect((request.result as { id: string }).id).toBe('a')
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  })

  it('事务 objectStore 越界（未列入事务）→ 抛 NotFoundError', async () => {
    const opened = await openAt(1)
    const db = opened.db
    db.createObjectStore('s1', { keyPath: 'id' })
    db.createObjectStore('s2', { keyPath: 'id' })
    const tx = db.transaction('s1', 'readonly')
    expect(() => tx.objectStore('s2')).toThrow()
  })
})

describe('fake IndexedDB：事务与失败注入', () => {
  async function dbWithStore(): Promise<OpenedDb['db']> {
    const opened = await openAt(1)
    opened.db.createObjectStore('images', { keyPath: 'id' })
    return opened.db
  }

  it('readwrite 事务中途失败注入：前序写入回滚，事务 onabort 触发', async () => {
    const db = await dbWithStore()
    fake.failNext({ store: 'images', op: 'put', key: 'second' })

    const outcome = await new Promise<'aborted' | 'committed'>((resolve) => {
      const tx = db.transaction('images', 'readwrite')
      const store = tx.objectStore('images')
      tx.onabort = () => resolve('aborted')
      tx.oncomplete = () => resolve('committed')
      store.put({ id: 'first' })
      const bad = store.put({ id: 'second' })
      bad.onerror = () => undefined // 失败交由事务 abort 汇报
    })
    expect(outcome).toBe('aborted')
    expect(await get(db, 'images', 'first')).toBeUndefined()
    expect(await get(db, 'images', 'second')).toBeUndefined()
  })

  it('failNext 只消耗一次：后续同操作成功', async () => {
    const db = await dbWithStore()
    fake.failNext({ store: 'images', op: 'put' })
    await expect(put(db, 'images', { id: 'x' })).rejects.toBeTruthy()
    await expect(put(db, 'images', { id: 'x' })).resolves.toBe('x')
  })

  it('手动 abort() 同样回滚快照', async () => {
    const db = await dbWithStore()
    const tx = db.transaction('images', 'readwrite')
    const store = tx.objectStore('images')
    store.put({ id: 'doomed' })
    tx.abort()
    expect(await get(db, 'images', 'doomed')).toBeUndefined()
  })

  it('index 查询失败注入（get/getAll 走同一队列）', async () => {
    const opened = await openAt(1)
    const db = opened.db
    db.createObjectStore('assetNodes', { keyPath: 'id' }).createIndex('parentId', 'parentId')
    await put(db, 'assetNodes', { id: 'a', parentId: 'f' })
    fake.failNext({ store: 'assetNodes', index: 'parentId', op: 'getAll' })
    await expect(
      new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction('assetNodes', 'readonly')
        const request = tx.objectStore('assetNodes').index('parentId').getAll('f')
        request.onsuccess = () => resolve(request.result as unknown[])
        request.onerror = () => reject(request.error)
      }),
    ).rejects.toBeTruthy()
  })
})
