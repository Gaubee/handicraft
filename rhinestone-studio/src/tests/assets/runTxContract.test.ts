/**
 * runTx 终态语义契约（openspec add-project-files design §9.1 B1，切片 0.4）：
 *
 * 1. 首终态规则：body 返回值暂存，tx.oncomplete 之后才 resolve；onabort/onerror
 *    （含提交期错误）/body reject 一律 reject——仅首个终态生效，其后事件不二次 settle。
 * 2. 可见性：body 成功值在 oncomplete 前对调用方不可见（resolve 时点在 oncomplete 之后）。
 * 3. 失败注入回滚：nodes.put / images.put / images.delete 失败 → 旧节点/旧 blob 等全保持。
 *
 * 共享 blob 删除单边存活的 GC 语义已由 assetStore.test.ts「清一条链接另一条存活」
 * 「全清才删字节」覆盖，此处不重复造。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFolder,
  emptyTrash,
  getAsset,
  getAssetBlob,
  ingestAsset,
  listAllNodes,
  listChildNodes,
  listContentHashes,
  resetAssetStoreForTests,
  runTxForTests,
  trashAsset,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { ASSET_NODES_STORE, listImages } from '$lib/persistence/imageStore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB

/**
 * fake 事务的最小结构视图（FakeTransaction 类未从 helper 导出，测试只触达
 * state/abort/三个事件字段即可构造终态竞争）。
 */
interface FakeTxLike {
  state: 'active' | 'committed' | 'aborted'
  oncomplete: (() => void) | null
  onabort: (() => void) | null
  onerror: (() => void) | null
  abort(): void
}

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
});

function png(bytes: number[], name = 'pic.png'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

/** 微任务泵：排空 openDb→事务创建→body 启动/返回的整条微任务链（不给宏任务让路）。 */
async function flushMicrotasks(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve()
}

async function ingestRoot(bytes: number[], name = 'pic.png'): Promise<AssetImage> {
  const result = await ingestAsset({
    blob: png(bytes, name),
    name,
    width: 10,
    height: 20,
    parentId: null,
    source: 'upload',
  })
  return result.node
}

describe('runTx 终态契约（§9.1 B1：首终态规则 + 完成语义）', () => {
  it('body 已返回值但事务中止 → reject（不得假成功）', async () => {
    let releaseBody!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseBody = resolve
    })
    let fakeTx: FakeTxLike | undefined
    const promise = runTxForTests([ASSET_NODES_STORE], 'readwrite', async (tx) => {
      fakeTx = tx as unknown as FakeTxLike
      await gate
      return 'body-value'
    })
    releaseBody() // body 自此已 resolve（返回值在手，事务尚未提交）
    await flushMicrotasks()
    expect(fakeTx).toBeDefined()
    fakeTx?.abort() // 微任务窗口内中止：先于 fake 的自动提交宏任务
    await expect(promise).rejects.toBeInstanceOf(Error)
  })

  it('body 已返回值但提交期失败（配额溢出类）→ ingestAsset reject，零半截落盘', async () => {
    const keep = await ingestRoot([1], 'keep.png')
    fake.failNextCommit({ store: ASSET_NODES_STORE })
    // 拒绝值 = 提交期错误本体（DOMException，jsdom 下非 Error 实例，故用 toBeTruthy）
    await expect(ingestRoot([2], 'new.png')).rejects.toBeTruthy()
    // 请求全部成功、body 已返回 {node,status:'created'}，但提交失败 → 全量回滚
    expect((await listAllNodes()).filter((n) => n.type === 'image').map((n) => n.id)).toEqual([keep.id])
    expect(await listImages()).toHaveLength(1)
    expect(await listContentHashes()).toHaveLength(1)
    expect(await getAssetBlob(keep.id)).not.toBeNull()
  })

  it('可见性：body 成功值在 oncomplete 前对调用方不可见（resolve 时点在 oncomplete 之后）', async () => {
    let oncompleteFired = false
    let fakeTxRef: FakeTxLike | undefined
    let stateAtResolve: string | undefined
    const promise = runTxForTests([ASSET_NODES_STORE], 'readonly', async (tx) => {
      fakeTxRef = tx as unknown as FakeTxLike
      const original = fakeTxRef.oncomplete
      fakeTxRef.oncomplete = () => {
        oncompleteFired = true
        original?.()
      }
      await new Promise<void>((resolve, reject) => {
        const request = tx.objectStore(ASSET_NODES_STORE).getAll()
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error ?? new Error('IDB 请求失败'))
      })
      return 'committed-value'
    })
    const value = await promise.then((v) => {
      // 微任务续体：真实终态事件若已派发，此处必能观察到（宏任务提交早于本回调）
      stateAtResolve = fakeTxRef?.state
      return v
    })
    expect(value).toBe('committed-value')
    expect(oncompleteFired).toBe(true)
    expect(stateAtResolve).toBe('committed')
  })

  it('首终态规则：abort 定终态后，迟到的 onerror/oncomplete 不二次 settle', async () => {
    let fakeTx: FakeTxLike | undefined
    const promise = runTxForTests([ASSET_NODES_STORE], 'readwrite', async (tx) => {
      fakeTx = tx as unknown as FakeTxLike
      return 'value'
    })
    await flushMicrotasks()
    fakeTx?.abort()
    await expect(promise).rejects.toBeInstanceOf(Error)
    // 迟到事件（异常派发/重复回调场景）：终态不翻转、不产生未处理 rejection
    fakeTx?.onerror?.()
    fakeTx?.oncomplete?.()
    await new Promise((resolve) => setTimeout(resolve, 0)) // 排空 fake 自动提交宏任务
    await expect(promise).rejects.toBeInstanceOf(Error)
  })

  it('首终态规则：oncomplete 定终态后，迟到的 onabort/onerror 不翻转结果', async () => {
    let fakeTx: FakeTxLike | undefined
    const promise = runTxForTests([ASSET_NODES_STORE], 'readonly', async (tx) => {
      fakeTx = tx as unknown as FakeTxLike
      return 'stable-value'
    })
    await expect(promise).resolves.toBe('stable-value')
    fakeTx?.onabort?.()
    fakeTx?.onerror?.()
    await expect(promise).resolves.toBe('stable-value')
  })
})

describe('失败注入回滚（§9.1 B1：换绑失败时旧记录均保持的基建前提）', () => {
  it('nodes.put 失败：旧节点/旧 blob 均保持，无新节点残留', async () => {
    const a = await ingestRoot([1], 'a.png')
    const folder = await createFolder(null, 'F')
    fake.failNext({ store: 'assetNodes', op: 'put' })
    await expect(
      ingestAsset({
        blob: png([1], 'b.png'),
        name: 'b.png',
        width: 1,
        height: 1,
        parentId: folder.id,
        source: 'upload',
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(await listChildNodes(folder.id)).toHaveLength(0)
    expect(await getAsset(a.id)).toMatchObject({ id: a.id, name: 'a.png' })
    expect(await getAssetBlob(a.id)).not.toBeNull()
    expect(await listImages()).toHaveLength(1)
    expect(await listContentHashes()).toHaveLength(1)
  })

  it('images.put 失败：新内容入库全回滚（无新节点/新 blob/新哈希），旧资产原样', async () => {
    const a = await ingestRoot([1], 'a.png')
    fake.failNext({ store: 'images', op: 'put' })
    await expect(ingestRoot([2], 'new.png')).rejects.toBeInstanceOf(Error)
    expect((await listAllNodes()).filter((n) => n.type === 'image')).toHaveLength(1)
    expect(await listImages()).toHaveLength(1)
    expect(await listContentHashes()).toHaveLength(1)
    expect(await getAssetBlob(a.id)).not.toBeNull()
  })

  it('images.delete 失败：emptyTrash reject，软删节点/blob/哈希全保持', async () => {
    const a = await ingestRoot([4], 'a.png')
    await trashAsset(a.id)
    fake.failNext({ store: 'images', op: 'delete' })
    await expect(emptyTrash()).rejects.toBeInstanceOf(Error)
    expect(await getAsset(a.id)).not.toBeNull()
    expect(await listImages()).toHaveLength(1)
    expect(await listContentHashes()).toHaveLength(1)
  })
})
