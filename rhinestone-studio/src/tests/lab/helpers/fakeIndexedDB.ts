/**
 * 极简 IndexedDB 假实现（仅供 vitest）。
 *
 * [add-asset-library 0.1] 升级为多 objectStore / 版本 upgrade / index 查询 /
 * readwrite 事务（commit/abort 回滚）/ 中途失败注入的测试基建，同时保持旧有
 * 消费方（imageStore 的 open/onupgradeneeded/put/get/delete/getAll）完全兼容。
 *
 * 与真实 IDB 的刻意偏差（测试基建取舍）：
 * - 写操作同步落盘、abort 时整体回滚到事务开启前的快照（真实 IDB 是提交时才落盘，
 *   对外可观察语义一致：失败/中止后查不到半截写入）。
 * - 事务 oncomplete 用宏任务（setTimeout 0）触发：允许在 onsuccess 的微任务续体里
 *   继续发请求（idb 库的惯用模式），微任务队列清空后才算事务完结。
 *
 * [add-project-files 0.4] 新增提交失败注入 failNextCommit：命中事务在自动提交点
 * 不提交而走「error 事件 → abort 回滚 → abort 事件」路径（模拟真实 IDB 配额溢出等
 * 提交期错误——请求全部成功、body 已拿到返回值，但事务最终未落盘）。
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

/** 真实 IDB 的 upgradeneeded 事件携带 oldVersion/newVersion（jsdom 无该类，自行补齐）。 */
export class FakeVersionChangeEvent extends Event {
  readonly oldVersion: number
  readonly newVersion: number | null

  constructor(type: string, init: { oldVersion: number; newVersion: number | null }) {
    super(type)
    this.oldVersion = init.oldVersion
    this.newVersion = init.newVersion
  }
}

export interface FakeStoredRecord {
  id: string
  blob: Blob
  createdAt: number
}

/** 失败注入匹配器（FakeIndexedDB.failNext）：命中一次即消耗。 */
export interface FailureMatcher {
  store?: string
  index?: string
  op?: 'put' | 'get' | 'delete' | 'getAll'
  key?: IDBValidKey
}

/** 提交失败注入匹配器（FakeIndexedDB.failNextCommit）：事务到达自动提交点时命中一次即消耗。 */
export interface CommitFailureMatcher {
  /** 事务 storeNames 包含该 store 才命中；缺省 = 任意事务。 */
  store?: string
  mode?: IDBTransactionMode
}

const STORE_OPS = new Set(['put', 'get', 'delete', 'getAll'])

function injectedError(): DOMException {
  return new DOMException('注入的 IndexedDB 失败（测试）', 'UnknownError')
}

class FakeIndex {
  constructor(
    private readonly store: FakeObjectStore,
    readonly name: string,
    private readonly keyPath: string,
    private readonly ownerStoreName: string,
  ) {}

  private matches(record: unknown, key: IDBValidKey | null | undefined): boolean {
    const value = (record as Record<string, unknown>)[this.keyPath]
    if (key === undefined) return value !== undefined
    return value === key
  }

  private consumeInjection(op: 'get' | 'getAll', key: IDBValidKey | null | undefined): boolean {
    return this.store.consumeInjectionForIndex(this.ownerStoreName, this.name, op, key ?? undefined)
  }

  get(key: IDBValidKey | null): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>()
    if (this.consumeInjection('get', key)) {
      request.fail(injectedError())
      return request
    }
    const record = [...this.store.records.values()].find((r) => this.matches(r, key))
    request.succeed(record)
    return request
  }

  getAll(key?: IDBValidKey | null): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>()
    if (this.consumeInjection('getAll', key)) {
      request.fail(injectedError())
      return request
    }
    const records = [...this.store.records.values()].filter((r) => this.matches(r, key))
    request.succeed(records)
    return request
  }
}

class FakeObjectStore {
  readonly records = new Map<IDBValidKey, unknown>()
  readonly indexes = new Map<string, FakeIndex>()
  private readonly indexList: FakeIndex[] = []
  readonly keyPath: string | undefined
  /** 当前所属事务（store 方法在事务外调用时为 null——旧用法也兼容）。 */
  activeTx: FakeTransaction | null = null

  constructor(
    readonly name: string,
    private readonly idb: FakeIndexedDB,
    keyPath?: string,
  ) {
    this.keyPath = keyPath
  }

  createIndex(name: string, keyPath: string): FakeIndex {
    const index = new FakeIndex(this, name, keyPath, this.name)
    this.indexes.set(name, index)
    this.indexList.push(index)
    return index
  }

  /** @internal index 查询的失败注入入口（匹配 store 名 + index 名）。 */
  consumeInjectionForIndex(
    storeName: string,
    indexName: string,
    op: 'get' | 'getAll',
    key: IDBValidKey | undefined,
  ): boolean {
    return this.idb.consumeInjection({ store: storeName, index: indexName, op, key })
  }


  index(name: string): FakeIndex {
    const found = this.indexes.get(name)
    if (!found) throw new DOMException(`index 不存在：${name}`, 'NotFoundError')
    return found
  }

  private extractKey(value: unknown, explicitKey?: IDBValidKey): IDBValidKey {
    if (this.keyPath) {
      const key = (value as Record<string, unknown>)[this.keyPath]
      if (key === undefined || key === null) {
        throw new DOMException(`记录缺少 keyPath 字段：${this.keyPath}`, 'DataError')
      }
      return key as IDBValidKey
    }
    if (explicitKey === undefined) throw new DOMException('未提供 out-of-line key', 'DataError')
    return explicitKey
  }

  private guardActive(): void {
    if (this.activeTx?.state === 'aborted') {
      throw new DOMException('事务已中止', 'TransactionInactiveError')
    }
  }

  private consumeInjection(op: 'put' | 'get' | 'delete' | 'getAll', key?: IDBValidKey): boolean {
    return this.idb.consumeInjection({ store: this.name, op, key })
  }

  put(value: unknown, explicitKey?: IDBValidKey): FakeRequest<IDBValidKey> {
    this.guardActive()
    const request = new FakeRequest<IDBValidKey>()
    const key = this.extractKey(value, explicitKey)
    if (this.consumeInjection('put', key)) {
      this.activeTx?.scheduleAbort()
      request.fail(injectedError())
      return request
    }
    this.records.set(key, value)
    request.succeed(key)
    return request
  }

  get(key: IDBValidKey): FakeRequest<unknown> {
    this.guardActive()
    const request = new FakeRequest<unknown>()
    if (this.consumeInjection('get', key)) {
      this.activeTx?.scheduleAbort()
      request.fail(injectedError())
      return request
    }
    request.succeed(this.records.get(key))
    return request
  }

  delete(key: IDBValidKey): FakeRequest<undefined> {
    this.guardActive()
    const request = new FakeRequest<undefined>()
    if (this.consumeInjection('delete', key)) {
      this.activeTx?.scheduleAbort()
      request.fail(injectedError())
      return request
    }
    this.records.delete(key)
    request.succeed(undefined)
    return request
  }

  getAll(): FakeRequest<unknown[]> {
    this.guardActive()
    const request = new FakeRequest<unknown[]>()
    if (this.consumeInjection('getAll')) {
      this.activeTx?.scheduleAbort()
      request.fail(injectedError())
      return request
    }
    request.succeed([...this.records.values()])
    return request
  }

  /** 事务快照/回滚用（浅拷贝足够：记录对象从不就地修改，put 恒整对象替换）。 */
  snapshot(): Map<IDBValidKey, unknown> {
    return new Map(this.records)
  }

  restore(snapshot: Map<IDBValidKey, unknown>): void {
    this.records.clear()
    for (const [key, value] of snapshot) this.records.set(key, value)
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

type TxState = 'active' | 'committed' | 'aborted'

class FakeTransaction {
  state: TxState = 'active'
  oncomplete: (() => void) | null = null
  onabort: (() => void) | null = null
  onerror: (() => void) | null = null
  error: DOMException | null = null
  private readonly snapshots = new Map<FakeObjectStore, Map<IDBValidKey, unknown>>()
  private abortQueued = false

  constructor(
    private readonly db: FakeDatabase,
    readonly storeNames: string[],
    readonly mode: IDBTransactionMode,
  ) {
    for (const name of storeNames) {
      const store = db.stores.get(name)
      if (!store) throw new DOMException(`objectStore 不存在：${name}`, 'NotFoundError')
      if (mode === 'readwrite') this.snapshots.set(store, store.snapshot())
    }
    // 宏任务完结：onsuccess 的微任务续体里还能继续发请求（见文件头注释）。
    setTimeout(() => {
      if (this.state !== 'active') return
      if (this.db.consumeCommitFailure(this.storeNames, this.mode)) {
        // 提交期失败（配额溢出等）：error 事件先至，随后走 abort 回滚路径（首终态 = error）。
        this.error = injectedError()
        this.onerror?.()
        this.abort()
        return
      }
      this.state = 'committed'
      for (const store of this.db.stores.values()) {
        if (store.activeTx === this) store.activeTx = null
      }
      this.oncomplete?.()
    }, 0)
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.storeNames.includes(name)) {
      throw new DOMException(`事务未覆盖 objectStore：${name}`, 'NotFoundError')
    }
    const store = this.db.stores.get(name)
    if (!store) throw new DOMException(`objectStore 不存在：${name}`, 'NotFoundError')
    store.activeTx = this
    return store
  }

  /** 请求失败后安排中止（微任务序在失败事件之后，模拟真实 IDB 默认 abort 冒泡）。 */
  scheduleAbort(): void {
    if (this.state !== 'active' || this.abortQueued) return
    this.abortQueued = true
    queueMicrotask(() => this.abort())
  }

  abort(): void {
    if (this.state !== 'active') return
    this.state = 'aborted'
    // 回滚到事务开启前快照：中途失败不落半截写入。
    for (const [store, snapshot] of this.snapshots) store.restore(snapshot)
    for (const store of this.db.stores.values()) {
      if (store.activeTx === this) store.activeTx = null
    }
    queueMicrotask(() => this.onabort?.())
  }

  commit(): void {
    if (this.state !== 'active') return
    this.state = 'committed'
    for (const store of this.db.stores.values()) {
      if (store.activeTx === this) store.activeTx = null
    }
    this.oncomplete?.()
  }
}

class FakeDatabase {
  readonly objectStoreNames: FakeObjectStoreNames
  readonly stores = new Map<string, FakeObjectStore>()
  /** 0 = 尚不存在的库（首次 open 的 upgradeneeded oldVersion=0）。 */
  version = 0
  onclose: (() => void) | null = null

  constructor(private readonly idb: FakeIndexedDB) {
    this.objectStoreNames = new FakeObjectStoreNames(new Set())
  }

  createObjectStore(name: string, options?: { keyPath?: string }): FakeObjectStore {
    if (this.stores.has(name)) throw new DOMException(`objectStore 已存在：${name}`, 'ConstraintError')
    const store = new FakeObjectStore(name, this.idb, options?.keyPath)
    this.stores.set(name, store)
    this.objectStoreNames.names.add(name)
    return store
  }

  transaction(names: string | string[], mode: IDBTransactionMode): FakeTransaction {
    const list = Array.isArray(names) ? names : [names]
    for (const name of list) {
      if (!this.stores.has(name)) throw new DOMException(`objectStore 不存在：${name}`, 'NotFoundError')
    }
    return new FakeTransaction(this, list, mode)
  }

  /** @internal 事务自动提交点消费提交失败注入。 */
  consumeCommitFailure(storeNames: string[], mode: IDBTransactionMode): boolean {
    return this.idb.consumeCommitFailure(storeNames, mode)
  }

  close(): void {
    this.onclose?.()
  }
}

export class FakeIndexedDB {
  private db: FakeDatabase | null = null
  private readonly pendingFailures: FailureMatcher[] = []
  private readonly pendingCommitFailures: CommitFailureMatcher[] = []

  open(name: string, version?: number): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>()
    const fresh = this.db === null
    const db = this.db ?? new FakeDatabase(this)
    const currentVersion = db.version
    const requested = version ?? (fresh ? 1 : currentVersion)
    this.db = db
    queueMicrotask(() => {
      if (!fresh && version !== undefined && version < currentVersion) {
        request.fail(new DOMException('请求的数据库版本低于当前版本', 'VersionError'))
        return
      }
      const needsUpgrade = fresh || (version !== undefined && version > currentVersion)
      const oldVersion = currentVersion
      if (needsUpgrade) db.version = requested
      // 真实 IDB 在 upgrade 事件里 request.result 即为 db 实例
      request.result = db
      if (needsUpgrade) {
        request.onupgradeneeded?.call(
          request,
          new FakeVersionChangeEvent('upgradeneeded', { oldVersion, newVersion: requested }),
        )
      }
      request.succeed(db)
    })
    return request
  }

  /** 清空数据并断开连接（让被测模块的连接缓存失效）。 */
  reset(): void {
    this.pendingFailures.length = 0
    this.pendingCommitFailures.length = 0
    this.db?.close()
    this.db = null
  }

  /** 当前连接的版本（测试断言 upgrade 序列用）。 */
  get version(): number {
    return this.db?.version ?? 0
  }

  /**
   * 注入下一次命中匹配器的请求失败（每次调用消耗一次）。
   * 例：fake.failNext({ store: 'assetNodes', op: 'put' }) → 下一次 assetNodes.put 报错并回滚其所属事务。
   */
  failNext(matcher: FailureMatcher): void {
    this.pendingFailures.push(matcher)
  }

  /** 清空尚未命中的注入（测试 afterEach 兜底）。 */
  clearFailures(): void {
    this.pendingFailures.length = 0
    this.pendingCommitFailures.length = 0
  }

  /**
   * 注入下一次命中匹配器的事务提交失败（每次调用消耗一次）：命中事务到达自动提交点时
   * 不提交，改走 error 事件 → abort 回滚 → abort 事件（模拟配额溢出等提交期错误）。
   */
  failNextCommit(matcher: CommitFailureMatcher = {}): void {
    this.pendingCommitFailures.push(matcher)
  }

  /** @internal 由事务在自动提交点消费；返回是否命中。 */
  consumeCommitFailure(storeNames: string[], mode: IDBTransactionMode): boolean {
    const index = this.pendingCommitFailures.findIndex(
      (matcher) =>
        (matcher.store === undefined || storeNames.includes(matcher.store)) &&
        (matcher.mode === undefined || matcher.mode === mode),
    )
    if (index < 0) return false
    this.pendingCommitFailures.splice(index, 1)
    return true
  }

  /** @internal 由 store/index 操作消费；返回是否命中。 */
  consumeInjection(candidate: Required<Pick<FailureMatcher, 'op'>> & FailureMatcher): boolean {
    const index = this.pendingFailures.findIndex((matcher) => {
      if (matcher.store !== undefined && matcher.store !== candidate.store) return false
      if (matcher.index !== undefined && matcher.index !== candidate.index) return false
      if (!STORE_OPS.has(candidate.op)) return false
      if (matcher.op !== undefined && matcher.op !== candidate.op) return false
      if (matcher.key !== undefined && matcher.key !== candidate.key) return false
      return true
    })
    if (index < 0) return false
    this.pendingFailures.splice(index, 1)
    return true
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

/**
 * [add-project-files 0.4] 宏任务泵：排空基于 fake IDB 的在途异步链。
 *
 * runTx 完成语义 = 等事务真实提交（oncomplete 宏任务）后，归档/物化/迁移等
 * 未被测试 await 的后台链长度从「微任务级」变为「每步一跳宏任务」，可能在测试
 * 断言完成后仍在途；若不排空，链会跨过 fake.reset() 边界，前后两次 openDb 分别
 * 落在旧库/新库（imageStore 的连接缓存被 reset 置空），产生跨测试污染。
 * 在 afterEach 里、unstub 之前调用，让迟到副作用落在本测试的桩与清理范围内。
 */
export async function drainFakeIndexedDBChains(hops = 50): Promise<void> {
  for (let i = 0; i < hops; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
