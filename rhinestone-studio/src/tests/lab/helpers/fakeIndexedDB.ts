/**
 * 极简 IndexedDB 假实现（仅供 vitest）。
 * 只实现 imageStore.ts 用到的面：open/onupgradeneeded/transaction/put/get/delete/getAll。
 */

import { vi } from 'vitest'

export class FakeRequest<T = unknown> {
  result: T = undefined as unknown as T
  error: DOMException | null = null
  onsuccess: ((this: FakeRequest<T>, ev: Event) => unknown) | null = null
  onerror: ((this: FakeRequest<T>, ev: Event) => unknown) | null = null
  onupgradeneeded: ((this: FakeRequest<T>, ev: Event) => unknown) | null = null

  succeed(value: T): void {
    this.result = value
    queueMicrotask(() => this.onsuccess?.call(this, new Event('success')))
  }

  fail(error: DOMException): void {
    this.error = error
    queueMicrotask(() => this.onerror?.call(this, new Event('error')))
  }
}

export interface FakeStoredRecord {
  id: string
  blob: Blob
  createdAt: number
}

class FakeObjectStore {
  readonly records = new Map<string, FakeStoredRecord>()

  put(value: FakeStoredRecord): FakeRequest<IDBValidKey> {
    const request = new FakeRequest<IDBValidKey>()
    this.records.set(value.id, value)
    request.succeed(value.id)
    return request
  }

  get(key: IDBValidKey): FakeRequest<FakeStoredRecord | undefined> {
    const request = new FakeRequest<FakeStoredRecord | undefined>()
    request.succeed(this.records.get(String(key)))
    return request
  }

  delete(key: IDBValidKey): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>()
    this.records.delete(String(key))
    request.succeed(undefined)
    return request
  }

  getAll(): FakeRequest<FakeStoredRecord[]> {
    const request = new FakeRequest<FakeStoredRecord[]>()
    request.succeed([...this.records.values()])
    return request
  }
}

class FakeObjectStoreNames {
  readonly names: Set<string>

  constructor(names: Set<string>) {
    this.names = names
  }

  contains(name: string): boolean {
    return this.names.has(name)
  }
}

class FakeTransaction {
  readonly store: FakeObjectStore

  constructor(store: FakeObjectStore) {
    this.store = store
  }

  objectStore(_name: string): FakeObjectStore {
    return this.store
  }
}

class FakeDatabase {
  readonly objectStoreNames: FakeObjectStoreNames
  readonly store = new FakeObjectStore()
  onclose: (() => void) | null = null

  constructor() {
    this.objectStoreNames = new FakeObjectStoreNames(new Set())
  }

  createObjectStore(name: string): FakeObjectStore {
    this.objectStoreNames.names.add(name)
    return this.store
  }

  transaction(_name: string, _mode: IDBTransactionMode): FakeTransaction {
    return new FakeTransaction(this.store)
  }

  close(): void {
    this.onclose?.()
  }
}

export class FakeIndexedDB {
  private db: FakeDatabase | null = null

  open(_name: string, _version: number): FakeRequest<FakeDatabase> {
    const request: FakeRequest<FakeDatabase> & { onupgradeneeded: ((this: FakeRequest<FakeDatabase>, ev: Event) => unknown) | null } = new FakeRequest<FakeDatabase>()
    const fresh = this.db === null
    const db = this.db ?? new FakeDatabase()
    this.db = db
    queueMicrotask(() => {
      // 真实 IDB 在 upgrade 事件里 request.result 即为 db 实例
      request.result = db
      if (fresh && !db.objectStoreNames.contains('images')) {
        // 首次打开：先触发调用方的 onupgradeneeded（建 store），再触发成功。
        request.onupgradeneeded?.call(request, new Event('upgradeneeded'))
      }
      request.succeed(db)
    })
    return request
  }

  /** 清空数据并断开连接（让被测模块的连接缓存失效）。 */
  reset(): void {
    this.db?.close()
    this.db = null
  }
}

// 单例：同一测试文件内复用同一实例，reset() 通过 close() 让被测模块的
// 连接缓存失效——避免「新 fake vs 模块缓存的旧 db」错位。
let sharedFake: FakeIndexedDB | null = null

export function installFakeIndexedDB(): FakeIndexedDB {
  if (!sharedFake) sharedFake = new FakeIndexedDB()
  // 必须每次 stub：vi.unstubAllGlobals() 会摘掉 indexedDB，单例只省对象不省 stub。
  vi.stubGlobal('indexedDB', sharedFake)
  return sharedFake
}
