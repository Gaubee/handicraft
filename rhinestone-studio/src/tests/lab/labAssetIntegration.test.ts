/*
 * [add-asset-library 4.2-4.5] 实验室资产接入集成测试（fake IDB，真实刷新序列 = reset module + hydrate）：
 * - 4.2 案例参照图 asset 契约（[Owner 2026-09-19 参照对退役]：合成图资产 + caseLayout）：
 *   合成资产软删失效 / B-2 替换绑定不删合成资产 / 旧 upload kind 一次性物化改绑变体与任务快照
 * - [4.4] 生成结果归档（产物 = .gemgen 档案，机制沿 4.3）：懒建批次夹归属与命名
 *   （`MM-DD HH:mm · N 张`，计数口径 image + gemgen）/ 全失败无残留夹 / 归档失败终态补偿补建
 * - 4.4 清空历史解耦（B-1）：任务 meta/画廊清空，档案节点与 blob 完好
 * - 4.5 送排钻校验/补建：会话内归档缺失时按 objectURL 补建后再交接
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearHistory,
  getEffectRefCaseView,
  getReferenceAssetId,
  getTasks,
  hydrate,
  resetLabForTests,
  sendToStudio,
  setReference,
  setTemplateEffectRefPair,
  startRun,
  updateSettings,
  whenIdle,
} from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { getHandoff } from '$lib/stores/handoff.svelte'
import {
  getGalleryEntries,
  getGalleryGroups,
  refreshGallery,
  resetGalleryForTests,
  GALLERY_FILTER_ALL,
} from '$lib/stores/gallery.svelte'
import {
  emptyTrash,
  getAsset,
  getAssetBlob,
  getProject,
  listChildNodes,
  resetAssetStoreForTests,
  trashAsset,
  type AssetFolder,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { getImageBlob, listImages, putImage } from '$lib/persistence/imageStore'
import { parseGemgen } from '$lib/persistence/labFile'
import type { AssetProject } from '$lib/persistence/projectTypes'
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
  resetGalleryForTests()
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
    const u = String(url)
    if (u.startsWith('blob:')) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    // [4.3] hydrate seed 物化的 /presets/ 图源（每 URL 唯一字节，防内容寻址并辙）
    if (u.startsWith('/presets/')) {
      const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    return okResponse(b64Of(`result-${(resultSeq += 1)}`))
  })
  vi.stubGlobal('fetch', fetchMock)

  resetLabForTests()
  resetGalleryForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 只留 N 个无绑定模板、各 1 候选（纯 generations，聚焦归档语义）。 */
async function keepBareTemplates(count = 1): Promise<string[]> {
  await hydrate()
  const keep = getTemplateAssetIds().slice(0, count)
  for (const id of getTemplateAssetIds()) {
    if (!keep.includes(id)) setEnabledTemplate(id, false)
  }
  for (const id of keep) submitTemplateField(id, { candidates: 1, promptBody: 'archive prompt', caseBinding: null })
  await whenTemplatesIdle()
  return keep
}

async function imagesUnder(parentId: string): Promise<AssetImage[]> {
  return (await listChildNodes(parentId)).filter((n): n is AssetImage => n.type === 'image')
}

/** [4.4] 批次夹内的 gemgen 档案节点。 */
async function gemgenNodesUnder(parentId: string): Promise<AssetProject[]> {
  return (await listChildNodes(parentId)).filter(
    (n): n is AssetProject => n.type === 'project' && n.projectKind === 'gemgen',
  )
}

/** 档案节点 → 解析后的 GemgenFile（节点 blob 必在）。 */
async function parseGemgenNode(node: AssetProject) {
  const blob = await getImageBlob(node.blobKey)
  if (!blob) throw new Error('档案物理记录缺失')
  return parseGemgen(new TextDecoder().decode(await blob.arrayBuffer()))
}

async function foldersUnderGenerated(): Promise<AssetFolder[]> {
  return (await listChildNodes('sys-generated')).filter(
    (n): n is AssetFolder => n.type === 'folder' && (n as { trashedAt?: number }).trashedAt === undefined,
  )
}

function persistedTasks(): Array<{ id: string; assetId?: string; runId?: string }> {
  return JSON.parse(localStorage.getItem('rhinestone-studio:tasks') ?? '[]')
}

describe('4.2 案例参照图 asset 契约（合成图资产 + caseLayout）', () => {
  it('合成资产软删后：getEffectRefCaseView 返回 null（显式失效，非静默空串）', async () => {
    const [templateId] = await keepBareTemplates()
    await setTemplateEffectRefPair(
      templateId,
      new File([new Uint8Array([1])], 's.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'r.png', { type: 'image/png' }),
    )
    const binding = getTemplateRecord(templateId)?.caseBinding
    expect(binding).not.toBeNull()
    if (!binding) return
    const ref = { kind: 'asset' as const, ...binding }

    expect(await getEffectRefCaseView(ref)).not.toBeNull()
    await trashAsset(binding.assetId)
    expect(await getEffectRefCaseView(ref)).toBeNull()
  })

  it('B-2 替换模板案例绑定不删合成资产：旧合成节点与字节保留在素材库', async () => {
    const [templateId] = await keepBareTemplates()
    await setTemplateEffectRefPair(
      templateId,
      new File([new Uint8Array([1])], 's1.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'r1.png', { type: 'image/png' }),
    )
    const first = getTemplateRecord(templateId)?.caseBinding
    await setTemplateEffectRefPair(
      templateId,
      new File([new Uint8Array([3])], 's2.png', { type: 'image/png' }),
      new File([new Uint8Array([4])], 'r2.png', { type: 'image/png' }),
    )
    const second = getTemplateRecord(templateId)?.caseBinding
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (!first || !second) return
    expect(second.assetId).not.toBe(first.assetId)

    // 旧合成资产节点与字节均未被替换路径触碰（B-2：替换绑定不删合成资产）
    const uploads = await imagesUnder('sys-uploads')
    expect(uploads).toHaveLength(2)
    expect(await getAssetBlob(first.assetId)).toBeInstanceOf(Blob)
    expect((await listImages()).length).toBeGreaterThanOrEqual(2)
  })

  it('迁移写回：旧 upload kind（effectref-* blob）——引擎建库模板（载体→空绑定）+ 任务快照物化改绑', async () => {
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

    // 真实刷新序列：模块复位 → hydrate（引擎迁移变体信封 + 任务 upload 反查物化改绑）
    await hydrate()

    // 引擎侧（design §9.3）：自建变体 → 确定性 id ast-tpl-legacy-<id>；upload 载体不属当前
    // 契约两形态 → caseBinding 落 null（内容 promptBody/name 保真）；信封收走删除
    const migrated = getTemplateRecord(`ast-tpl-legacy-${variantId}`)
    expect(migrated).toBeDefined()
    expect(migrated?.promptBody).toBe('legacy prompt')
    expect(migrated?.name).toBe('旧变体')
    expect(migrated?.caseBinding).toBeNull()
    expect(localStorage.getItem('rhinestone-studio:variants')).toBeNull()

    // 任务快照同步物化改绑（res 配对；src 缺省 → single）
    const task = getTasks().find((t) => t.id === 'legacy-task-1')
    expect(task?.effectRef?.kind).toBe('asset')
    if (task?.effectRef?.kind !== 'asset') return
    expect(task.effectRef.caseLayout).toBe('single')
    expect(await getAssetBlob(task.effectRef.assetId)).toBeInstanceOf(Blob)
    expect(localStorage.getItem('rhinestone-studio:tasks')).not.toContain('"kind":"upload"')

    // 旧 asset 对节点保留在库（B-2 语义：迁移不删既有素材）；jsdom 降级合成 = res 字节本身 →
    // 内容寻址与既有 res 节点去重（合成绑定复用 ast-<resKey>，不建重复节点）
    const uploads = await imagesUnder('sys-uploads')
    expect(uploads.map((n) => n.id)).toContain(`ast-${srcKey}`)
    expect(uploads.map((n) => n.id)).toContain(`ast-${resKey}`)
    expect(task.effectRef.assetId).toBe(`ast-${resKey}`)

    // 写回后的引用可解析（展示出口）
    expect(await getEffectRefCaseView(task.effectRef)).not.toBeNull()
  })

  it('preset 过渡态迁移（引擎物化）：自建变体带 preset 引用 → 库模板 caseBinding 物化入 sys-cases；二次 hydrate 零新增请求', async () => {
    resetLabForTests()
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify({ v: 2, items: [
        {
          id: 'own-preset',
          name: '花环',
          prompt: 'wreath prompt',
          candidates: 1,
          enabled: true,
          effectRef: { kind: 'preset', presetId: 'wreath-border' },
        },
      ] }),
    )
    // 每 URL 唯一字节：内容寻址下各 preset 得到独立合成资产（恒定字节会并辙成一个节点，
    // 其 meta 归属先物化的 preset——seed 先跑后归 new-orleans，wreath 反查将 miss）
    const presetFetch = vi.fn(async (url: unknown) => {
      expect(String(url).startsWith('/presets/')).toBe(true)
      const seed = [...String(url)].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    })
    vi.stubGlobal('fetch', presetFetch)

    await hydrate()
    const migrated = getTemplateRecord('ast-tpl-legacy-own-preset')
    expect(migrated?.caseBinding).not.toBeNull()
    const binding = migrated?.caseBinding
    if (!binding) return
    // wreath-border 无原图对（srcImage 空串）→ 真单张（非降级）
    expect(binding.caseLayout).toBe('single')
    const cases = await imagesUnder('sys-cases')
    const composite = cases.find((n) => (n.meta as { presetId?: string } | undefined)?.presetId === 'wreath-border')
    expect(composite?.id).toBe(binding.assetId)
    expect(localStorage.getItem('rhinestone-studio:variants')).toBeNull()

    // 二次刷新：meta.presetId 反查命中 → 不再 fetch，同一资产（确定性可重复）。
    // [4.2] hydrate 另挂内置模板 seed（首启为 8 preset 物化案例），以「二次 hydrate 零新增
    // 请求」为准断言，与 seed 解耦。
    const fetchesAfterFirst = presetFetch.mock.calls.length
    resetLabForTests()
    await hydrate()
    expect(getTemplateRecord('ast-tpl-legacy-own-preset')?.caseBinding).toEqual({
      assetId: composite?.id,
      caseLayout: 'single',
    })
    expect(presetFetch.mock.calls.length - fetchesAfterFirst).toBe(0) // 零新增请求
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

describe('[4.4] 生成结果归档为 .gemgen（懒建批次夹 + 补偿机制沿 4.3）', () => {
  it('首个成功懒建批次夹：归属 sys-generated、命名 `MM-DD HH:mm · N 张` 随张数刷新、溯源入档', async () => {
    await keepBareTemplates(2)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const tasks = getTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks.every((t) => t.assetId)).toBe(true)

    const folders = await foldersUnderGenerated()
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · 2 张$/)

    // [4.4] 归档产物 = AssetProject(gemgen)；runId 等溯源字段上移文件 provenance（节点 meta 收编）
    const nodes = await gemgenNodesUnder(folders[0].id)
    expect(nodes).toHaveLength(2)
    for (const node of nodes) {
      const file = await parseGemgenNode(node)
      expect(file.provenance.runId).toBe(tasks[0].runId)
    }
    expect(nodes.map((n) => n.id).sort()).toEqual(tasks.map((t) => t.assetId).sort())

    // 任务 meta 持久化 assetId（三步之第三步）
    const persisted = persistedTasks()
    expect(persisted.map((m) => m.assetId).sort()).toEqual(tasks.map((t) => t.assetId).sort())
  })

  it('[Owner] 生成档案携带参考原图关联：provenance.referenceAssetId 跨刷新配对', async () => {
    // 上传参考原图（入库 sys-uploads）→ 带参考生成 → 归档档案 provenance 引用参考资产
    await setReference(new File([new Uint8Array([9, 9, 9])], 'reference-src.png', { type: 'image/png' }))
    const referenceAssetId = getReferenceAssetId()
    expect(referenceAssetId).toBeTruthy()
    await keepBareTemplates(1)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const task = getTasks()[0]
    expect(task.referenceAssetId).toBe(referenceAssetId)
    const node = await getProject(task.assetId as string)
    expect(node?.projectKind).toBe('gemgen')
    if (!node) return
    const file = await parseGemgenNode(node)
    expect(file.provenance.referenceAssetId).toBe(referenceAssetId)
    // 参考资产本体仍在库（上传目录），配对可解析
    const refNode = await getAsset(referenceAssetId as string)
    expect(refNode?.parentId).toBe('sys-uploads')
  })

  it('全部失败：不建批次夹（懒建语义 = 无成功无夹）', async () => {
    await keepBareTemplates(2)
    fetchMock.mockImplementation(async () => errorResponse())
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'error'))
    await whenIdle()
    expect(await foldersUnderGenerated()).toHaveLength(0)
  })

  it('归档失败补偿：任务终态持久化时幂等补建（重跑后 assetId 追平）', { timeout: 15000 }, async () => {
    await keepBareTemplates(2)
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
    expect((await gemgenNodesUnder(folders[0].id)).length).toBe(2)
    // 终态持久化把补建的 assetId 写回 meta
    expect(persistedTasks().every((m) => m.assetId)).toBe(true)
  })

  it('刷新重跑（旧链路成功任务无 assetId）：hydrate 迁移补归档产新 gemgen 档案，旧图不回填', async () => {
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
    // [4.4] 补归档产**新** gemgen 档案节点（不复用旧 ast-task 图片节点——旧裸图不回填），
    // 归入迁移期既有批次夹（ast-batch-<runId>，计数口径 image + gemgen）
    expect(task?.assetId).not.toBe('ast-task-legacy-t1')
    const node = await getProject(task?.assetId as string)
    expect(node?.projectKind).toBe('gemgen')
    expect(node?.parentId).toBe('ast-batch-run-refresh-1')
    const file = node ? await parseGemgenNode(node) : null
    expect(file?.provenance.runId).toBe('run-refresh-1')
    expect(file?.provenance.composedPrompt).toContain('p') // legacy 无快照 → 附件形态重建
    // 旧 ast-task 图片节点原样保留（不回填不删除）
    const oldImage = await getAsset('ast-task-legacy-t1')
    expect(oldImage?.type).toBe('image')
    expect((await foldersUnderGenerated()).map((f) => f.id)).toContain('ast-batch-run-refresh-1')
    expect(persistedTasks()[0].assetId).toBe(task?.assetId)
  })
})

describe('4.4 清空历史解耦（B-1）', () => {
  it('清空历史后档案与 blob 完好：只清会话任务（[4.5] 档案保留画廊只读可见）', async () => {
    await keepBareTemplates(1)
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')
    await whenIdle()
    const task = getTasks()[0]
    expect(task.assetId).toMatch(/^ast-/)
    const blobCountBefore = (await listImages()).length
    expect(blobCountBefore).toBeGreaterThan(0)

    await clearHistory()

    expect(getTasks()).toHaveLength(0)
    // [4.5] 并集口径：活任务组清空（重扫前库投影未变，语义 = 只清会话账本）
    expect(getGalleryGroups(GALLERY_FILTER_ALL).every((g) => g.entries.every((e) => e.live))).toBe(true)
    expect(persistedTasks()).toHaveLength(0)
    // [4.5] 重扫后档案以只读卡保留（清空历史的新承诺：画廊不清，档案只读可见）
    await refreshGallery()
    const readonlyEntries = getGalleryEntries().filter((e) => !e.live)
    expect(readonlyEntries.map((e) => e.assetId)).toContain(task.assetId)
    // [4.4] gemgen 档案节点与字节完好（节点在批次夹内，未被任务史清理触碰）
    const folders = await foldersUnderGenerated()
    const nodes = await gemgenNodesUnder(folders[0]?.id ?? 'sys-generated')
    expect(nodes.map((n) => n.id)).toContain(task.assetId)
    expect(nodes[0]).toBeDefined()
    if (nodes[0]) expect((await parseGemgenNode(nodes[0])).kind).toBe('gemgen')
    expect(await getImageBlob(nodes[0]?.blobKey ?? '')).toBeInstanceOf(Blob)
    expect((await listImages()).length).toBeGreaterThanOrEqual(blobCountBefore)
    // 硬清空回收站无被清任务史牵连的删除
    expect((await emptyTrash()).deletedNodeIds).toEqual([])
  })
})

describe('4.5 送排钻校验/补建', () => {
  it('会话内归档缺失（assetId 被摘）→ sendToStudio 按 objectURL 补建后交接', async () => {
    await keepBareTemplates(1)
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
