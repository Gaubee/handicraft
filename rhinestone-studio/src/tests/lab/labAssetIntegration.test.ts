/*
 * [add-asset-library 4.2-4.5] 实验室资产接入集成测试（fake IDB，真实刷新序列 = reset module + hydrate）：
 * - 4.2 双图 effectRef asset 契约：res 缺失失效 / B-2 替换不删资产 / 旧 upload kind 一次性迁移写回变体与任务快照
 * - 4.3 生成结果归档：懒建批次夹归属与命名（`MM-DD HH:mm · N 张`）/ 全失败无残留夹 / 归档失败终态补偿补建
 * - 4.4 清空历史解耦（B-1）：任务 meta/画廊清空，资产节点与 blob 完好
 * - 4.5 送转化校验/补建：会话内归档缺失时按 objectURL 补建后再交接
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearHistory,
  getEffectRefUrls,
  getReferenceAssetId,
  getTaskGroups,
  getTasks,
  getVariants,
  hydrate,
  removeVariant,
  resetLabForTests,
  sendToStudio,
  setReference,
  setVariantEffectRefUpload,
  startRun,
  updateSettings,
  updateVariant,
  whenIdle,
} from '$lib/stores/lab.svelte'
import { getHandoff } from '$lib/stores/handoff.svelte'
import {
  emptyTrash,
  getAsset,
  getAssetBlob,
  listChildNodes,
  resetAssetStoreForTests,
  trashAsset,
  type AssetFolder,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { listImages, putImage } from '$lib/persistence/imageStore'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

function b64Of(text: string): string {
  return btoa(text)
}

function okResponse(b64: string): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: { message: 'relay exploded' } }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let fake: FakeIndexedDB
let objectUrlCounter = 0
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  objectUrlCounter = 0
  // 顺序：先复位模块（cancelAll 会把上一测试的内存任务持久化），再清 localStorage
  resetLabForTests()
  localStorage.clear()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  class OkImage {
    naturalWidth = 64
    naturalHeight = 64
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)

  // 每次成功返回不同字节（内容寻址去重下仍产生独立节点，聚焦批次夹语义）；
  // blob: URL（会话 objectURL）取回字节走 PNG（归档补偿链路的重取路径；浏览器真实
  // fetch(objectURL) 保留原 blob 类型，mock 侧需显式 content-type）
  let resultSeq = 0
  fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).startsWith('blob:')) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    return okResponse(b64Of(`result-${(resultSeq += 1)}`))
  })
  vi.stubGlobal('fetch', fetchMock)

  resetLabForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 只留 N 个无绑定变体、各 1 候选（纯 generations，聚焦归档语义）。 */
function keepBareVariants(count = 1): string[] {
  const keep = getVariants().slice(0, count)
  for (const v of [...getVariants()]) {
    if (!keep.some((k) => k.id === v.id)) removeVariant(v.id)
  }
  for (const v of keep) updateVariant(v.id, { candidates: 1, prompt: 'archive prompt', effectRef: null })
  return keep.map((v) => v.id)
}

async function imagesUnder(parentId: string): Promise<AssetImage[]> {
  return (await listChildNodes(parentId)).filter((n): n is AssetImage => n.type === 'image')
}

async function foldersUnderGenerated(): Promise<AssetFolder[]> {
  return (await listChildNodes('sys-generated')).filter(
    (n): n is AssetFolder => n.type === 'folder' && (n as { trashedAt?: number }).trashedAt === undefined,
  )
}

function persistedTasks(): Array<{ id: string; assetId?: string; runId?: string }> {
  return JSON.parse(localStorage.getItem('rhinestone-studio:tasks') ?? '[]')
}

describe('4.2 双图 effectRef asset 契约', () => {
  it('res 资产软删后：getEffectRefUrls 返回 null（显式失效，非静默空串）', async () => {
    const [variantId] = keepBareVariants()
    await setVariantEffectRefUpload(
      variantId,
      new File([new Uint8Array([1])], 's.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'r.png', { type: 'image/png' }),
    )
    const variant = getVariants().find((v) => v.id === variantId)
    expect(variant?.effectRef?.kind).toBe('asset')
    if (variant?.effectRef?.kind !== 'asset') return

    expect(await getEffectRefUrls(variant.effectRef)).not.toBeNull()
    await trashAsset(variant.effectRef.assetIds.res)
    expect(await getEffectRefUrls(variant.effectRef)).toBeNull()
  })

  it('B-2 替换变体参考不删资产：旧节点与字节保留在素材库', async () => {
    const [variantId] = keepBareVariants()
    await setVariantEffectRefUpload(
      variantId,
      new File([new Uint8Array([1])], 's1.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'r1.png', { type: 'image/png' }),
    )
    const first = getVariants().find((v) => v.id === variantId)?.effectRef
    await setVariantEffectRefUpload(
      variantId,
      new File([new Uint8Array([3])], 's2.png', { type: 'image/png' }),
      new File([new Uint8Array([4])], 'r2.png', { type: 'image/png' }),
    )
    const second = getVariants().find((v) => v.id === variantId)?.effectRef
    expect(first?.kind).toBe('asset')
    expect(second?.kind).toBe('asset')
    if (first?.kind !== 'asset' || second?.kind !== 'asset') return
    expect(second.assetIds.res).not.toBe(first.assetIds.res)

    // 旧资产节点与字节均未被替换路径触碰（B-2）
    const uploads = await imagesUnder('sys-uploads')
    expect(uploads).toHaveLength(4)
    expect(await getAssetBlob(first.assetIds.res)).toBeInstanceOf(Blob)
    expect((await listImages()).length).toBeGreaterThanOrEqual(4)
  })

  it('迁移写回：旧 upload kind（effectref-* blob）hydrate 后按 blobKey 反查写回变体与任务快照', async () => {
    // 先复位再播种：resetLabForTests 的 cancelAll 会把空任务表持久化（清掉预置 meta）
    resetLabForTests()
    const variantId = 'legacy-var-1'
    const srcKey = `effectref-${variantId}-src-1700000000000`
    const resKey = `effectref-${variantId}-res-1700000000000`
    await putImage(srcKey, new File([new Uint8Array([9])], 'ls.png', { type: 'image/png' }))
    await putImage(resKey, new File([new Uint8Array([8])], 'lr.png', { type: 'image/png' }))
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify({ v: 2, items: [
        {
          id: variantId,
          name: '旧变体',
          prompt: 'legacy prompt',
          candidates: 1,
          enabled: true,
          effectRef: { kind: 'upload', uploadKeys: { src: srcKey, res: resKey } },
        },
      ] }),
    )
    localStorage.setItem(
      'rhinestone-studio:tasks',
      JSON.stringify([
        {
          id: 'legacy-task-1',
          runId: 'run-legacy-1',
          variantId,
          variantName: '旧变体',
          candidateIndex: 0,
          prompt: 'legacy prompt',
          mode: 'edit',
          model: 'm',
          size: '1024x1024',
          advancedJson: '',
          status: 'error',
          hasReference: true,
          effectRef: { kind: 'upload', uploadKeys: { src: '', res: resKey } },
          imageStored: false,
          createdAt: 1700000000000,
        },
      ]),
    )

    // 真实刷新序列：模块复位 → hydrate（检测到 legacy → 迁移建 ast-effectref-* 节点 → blobKey 反查写回）
    await hydrate()

    const restored = getVariants().find((v) => v.id === variantId)?.effectRef
    expect(restored).toEqual({ kind: 'asset', assetIds: { src: `ast-${srcKey}`, res: `ast-${resKey}` } })
    // localStorage 已写回 asset kind（旧载体消失）
    expect(localStorage.getItem('rhinestone-studio:variants')).toContain('"kind":"asset"')
    expect(localStorage.getItem('rhinestone-studio:variants')).not.toContain('"kind":"upload"')

    // 任务快照同步写回（res 配对；src 缺省保持缺省）
    const task = getTasks().find((t) => t.id === 'legacy-task-1')
    expect(task?.effectRef).toEqual({ kind: 'asset', assetIds: { res: `ast-${resKey}` } })
    expect(localStorage.getItem('rhinestone-studio:tasks')).not.toContain('"kind":"upload"')

    // 写回后的引用可解析（展示出口）
    expect(await getEffectRefUrls(restored)).not.toBeNull()
  })

  it('preset 版本 upsert：迁移后固定 id 节点存在（preset 派生 src/res 资产 id 的锚点）', async () => {
    const { runAssetMigration } = await import('$lib/persistence/assetStore')
    await runAssetMigration()
    await runAssetMigration() // 幂等重跑 = upsert，不重复建
    const cases = await imagesUnder('sys-cases')
    const srcRes = cases.filter((n) => n.id.startsWith('ast-preset-') && n.id.endsWith('-src'))
    const resOnly = cases.filter((n) => n.id.startsWith('ast-preset-') && n.id.endsWith('-res'))
    expect(resOnly.length).toBeGreaterThanOrEqual(8)
    expect(srcRes.length).toBeGreaterThanOrEqual(1)
    expect(cases.filter((n) => n.id === 'ast-preset-boston-res')).toHaveLength(1)
  })
})

describe('4.3 生成结果归档（懒建批次夹 + 补偿）', () => {
  it('首个成功懒建批次夹：归属 sys-generated、命名 `MM-DD HH:mm · N 张` 随张数刷新、meta 带 runId', async () => {
    keepBareVariants(2)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const tasks = getTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks.every((t) => t.assetId)).toBe(true)

    const folders = await foldersUnderGenerated()
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · 2 张$/)

    const images = await imagesUnder(folders[0].id)
    expect(images).toHaveLength(2)
    expect(images.every((n) => n.meta?.runId === tasks[0].runId)).toBe(true)
    expect(images.map((n) => n.source)).toEqual(['lab-generate', 'lab-generate'])

    // 任务 meta 持久化 assetId（三步之第三步）
    const persisted = persistedTasks()
    expect(persisted.map((m) => m.assetId).sort()).toEqual(tasks.map((t) => t.assetId).sort())
  })

  it('[Owner] 生成图资产携带参考原图关联：meta.referenceAssetId 跨刷新配对', async () => {
    // 上传参考原图（入库 sys-uploads）→ 带参考生成 → 归档节点 meta 引用参考资产
    await setReference(new File([new Uint8Array([9, 9, 9])], 'reference-src.png', { type: 'image/png' }))
    const referenceAssetId = getReferenceAssetId()
    expect(referenceAssetId).toBeTruthy()
    keepBareVariants(1)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const task = getTasks()[0]
    expect(task.referenceAssetId).toBe(referenceAssetId)
    const node = (await getAsset(task.assetId as string)) as AssetImage | null
    expect(node?.meta?.referenceAssetId).toBe(referenceAssetId)
    // 参考资产本体仍在库（上传目录），配对可解析
    const refNode = await getAsset(referenceAssetId as string)
    expect(refNode?.parentId).toBe('sys-uploads')
  })

  it('全部失败：不建批次夹（懒建语义 = 无成功无夹）', async () => {
    keepBareVariants(2)
    fetchMock.mockImplementation(async () => errorResponse())
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'error'))
    await whenIdle()
    expect(await foldersUnderGenerated()).toHaveLength(0)
  })

  it('归档失败补偿：任务终态持久化时幂等补建（重跑后 assetId 追平）', { timeout: 15000 }, async () => {
    keepBareVariants(2)
    // 首个 digest 调用抛错 = 第一个任务的入库失败（blob/节点步）；此后恢复
    const realDigest = crypto.subtle.digest.bind(crypto.subtle)
    let digestCalls = 0
    const digestSpy = vi.fn(async (algo: string, data: ArrayBuffer) => {
      digestCalls += 1
      if (digestCalls === 1) throw new Error('digest exploded')
      return realDigest(algo, data)
    })
    vi.stubGlobal('crypto', { ...crypto, subtle: { ...crypto.subtle, digest: digestSpy } })

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    // 第一个任务成功但暂未入库；后续任务终态持久化触发补偿 → assetId 追平
    await waitFor(() => getTasks().every((t) => t.assetId), 5000)
    await whenIdle()

    const tasks = getTasks()
    expect(tasks.every((t) => t.assetId)).toBe(true)
    const folders = await foldersUnderGenerated()
    expect(folders).toHaveLength(1)
    expect((await imagesUnder(folders[0].id)).length).toBe(2)
    // 终态持久化把补建的 assetId 写回 meta
    expect(persistedTasks().every((m) => m.assetId)).toBe(true)
  })

  it('刷新重跑（旧链路成功任务无 assetId）：hydrate 迁移补归档到既有批次夹', async () => {
    // 先复位再播种（resetLabForTests 会持久化空任务表）
    resetLabForTests()
    // 预置 v1 形态：taskId 键 blob + 无 assetId 的成功 meta
    await putImage('legacy-t1', new File([new Uint8Array([5])], 'g.png', { type: 'image/png' }))
    localStorage.setItem(
      'rhinestone-studio:tasks',
      JSON.stringify([
        {
          id: 'legacy-t1',
          runId: 'run-refresh-1',
          variantId: 'v1',
          variantName: '刷新变体',
          candidateIndex: 0,
          prompt: 'p',
          mode: 'generate',
          model: 'm',
          size: '1024x1024',
          advancedJson: '',
          status: 'success',
          hasReference: false,
          imageStored: true,
          createdAt: 1700000000000,
        },
      ]),
    )
    await hydrate()

    const task = getTasks().find((t) => t.id === 'legacy-t1')
    expect(task?.assetId).toMatch(/^ast-/)
    // 迁移（ast-task-* 节点，physicalKey=taskId）+ 内容寻址去重 → 同一节点复用，不建重复
    expect(task?.assetId).toBe('ast-task-legacy-t1')
    expect((await foldersUnderGenerated()).map((f) => f.id)).toContain('ast-batch-run-refresh-1')
    expect(persistedTasks()[0].assetId).toBe('ast-task-legacy-t1')
  })
})

describe('4.4 清空历史解耦（B-1）', () => {
  it('清空历史后资产与 blob 完好：只清任务 meta/画廊', async () => {
    keepBareVariants(1)
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')
    await whenIdle()
    const task = getTasks()[0]
    expect(task.assetId).toMatch(/^ast-/)
    const blobCountBefore = (await listImages()).length
    expect(blobCountBefore).toBeGreaterThan(0)

    await clearHistory()

    expect(getTasks()).toHaveLength(0)
    expect(getTaskGroups()).toHaveLength(0)
    expect(persistedTasks()).toHaveLength(0)
    // 资产节点与字节完好（节点在批次夹内，未被任务史清理触碰）
    const folders = await foldersUnderGenerated()
    const images = await imagesUnder(folders[0]?.id ?? 'sys-generated')
    expect(images.map((n) => n.id)).toContain(task.assetId)
    expect(await getAssetBlob(task.assetId ?? '')).toBeInstanceOf(Blob)
    expect((await listImages()).length).toBeGreaterThanOrEqual(blobCountBefore)
    // 硬清空回收站无被清任务史牵连的删除
    expect((await emptyTrash()).deletedNodeIds).toEqual([])
  })
})

describe('4.5 送转化校验/补建', () => {
  it('会话内归档缺失（assetId 被摘）→ sendToStudio 按 objectURL 补建后交接', async () => {
    keepBareVariants(1)
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')
    await whenIdle()
    const task = getTasks()[0]
    const archivedAssetId = task.assetId
    expect(archivedAssetId).toMatch(/^ast-/)

    // 模拟归档结果丢失（终态持久化前的异常路径）：摘掉 assetId，靠会话 objectURL 补建
    // （fetchMock 对 blob: URL 统一服务 PNG 字节，即归档补偿的重取路径）
    const taskImageUrl = task.imageUrl
    expect(taskImageUrl).toMatch(/^blob:/)
    ;(task as { assetId?: string }).assetId = undefined

    const ok = await sendToStudio(task.id)
    expect(ok).toBe(true)
    const handoff = getHandoff()
    expect(handoff?.assetId).toMatch(/^ast-/)
    expect(handoff?.assetId).not.toBe(archivedAssetId) // 补建的是新节点（不同内容）
    expect(handoff?.name).toContain('候选1')
    expect(task.assetId).toBe(handoff?.assetId) // 补建结果回写任务
  })
})
