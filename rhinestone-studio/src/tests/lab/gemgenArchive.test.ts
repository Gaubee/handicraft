/*
 * [add-project-files 4.4] 生成结果归档改造为 .gemgen（design §7.2 + 补充稿 A.2.2/A.2.4/C.2）：
 * - 归档形态：任务成功 → AssetProject(gemgen) 节点（serializeGemgen → ingestProjectAsset）
 *   + provenance 全字段 + summary 缓存 + task.assetId 指向 + 批次夹归类与计数（image + gemgen）
 * - 溯源收编：新归档节点 meta **不再有** runId/variantName 等图片 meta 字段（上移文件 provenance）
 * - 不可变：updateProjectAsset 对 gemgen throw（复引 projectAsset.test「调用即拒」语义）
 * - 归档链：enqueue 串行共享批次夹（无重复夹）/ 补偿重试产物一致 / 空批次清理
 * - 旧裸图不回填：预置旧式图片 meta 节点 → 归档链跑过后原样（含 hydrate 迁移补归档路径）
 * - composedPrompt 快照：请求时全文落任务/持久化/归档消费；legacy（快照引入前）按附件形态重建
 * - 缩略 P0：真机 canvas 桩 → thumbKey/thumb 元组/物理字节；jsdom 无 2D → 显式缺省路径
 * - 消费 seam（留 4.5 画廊）：getGemgenImageBlob / parseGemgen / summary 直出
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTasks,
  hydrate,
  resetLabForTests,
  setReference,
  setTemplateEffectRefSingle,
  startRun,
  updateForm,
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
import {
  createFolder,
  getAsset,
  getProject,
  ingestAsset,
  listChildNodes,
  moveAsset,
  resetAssetStoreForTests,
  runAssetMigration,
  updateProjectAsset,
  type AssetFolder,
} from '$lib/persistence/assetStore'
import { getImageBlob, listImages, putImage } from '$lib/persistence/imageStore'
import { gemgenImageBlob, parseGemgen, type GemgenFile } from '$lib/persistence/labFile'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { getGemgenImageBlob } from '$lib/persistence/handoffImage'
import { getGalleryGroups, GALLERY_FILTER_ALL, resetGalleryForTests } from '$lib/stores/gallery.svelte'
import { composeDrillPrompt } from '$lib/presets/effectRefs'
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

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let fake: FakeIndexedDB
let objectUrlCounter = 0

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

  // 每次成功返回不同字节（项目入库无去重，天然独立节点）；blob: URL（会话 objectURL
  // 补建路径）统一服务 PNG 字节
  let resultSeq = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('blob:')) {
        return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      if (u.startsWith('/presets/')) {
        const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
        return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      return okResponse(b64Of(`result-${(resultSeq += 1)}`))
    }),
  )

  resetLabForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 只留 N 个解绑案例的模板、各 candidatesCount 候选（纯 generations，聚焦归档语义）。 */
async function keepBareTemplates(count = 1, candidatesCount = 1): Promise<string[]> {
  await hydrate()
  const keep = getTemplateAssetIds().slice(0, count)
  for (const id of getTemplateAssetIds()) {
    if (!keep.includes(id)) setEnabledTemplate(id, false)
  }
  for (const id of keep) {
    submitTemplateField(id, { candidates: candidatesCount, promptBody: 'archive prompt', caseBinding: null })
  }
  await whenTemplatesIdle()
  return keep
}

async function foldersUnderGenerated(): Promise<AssetFolder[]> {
  return (await listChildNodes('sys-generated')).filter(
    (n): n is AssetFolder => n.type === 'folder' && (n as { trashedAt?: number }).trashedAt === undefined,
  )
}

async function gemgenNodesUnder(parentId: string): Promise<AssetProject[]> {
  return (await listChildNodes(parentId)).filter(
    (n): n is AssetProject => n.type === 'project' && n.projectKind === 'gemgen',
  )
}

async function parseGemgenNode(node: AssetProject): Promise<GemgenFile> {
  const blob = await getImageBlob(node.blobKey)
  if (!blob) throw new Error('档案物理记录缺失')
  return parseGemgen(new TextDecoder().decode(await blob.arrayBuffer()), { mime: node.mime })
}

async function bytesOf(blob: Blob): Promise<number[]> {
  // 展开为普通数组比较（jsdom/node 跨 realm 的 Uint8Array toEqual 会误判不等）
  return [...new Uint8Array(await blob.arrayBuffer())]
}

function persistedTasks(): Array<{ id: string; assetId?: string; composedPrompt?: string }> {
  return JSON.parse(localStorage.getItem('rhinestone-studio:tasks') ?? '[]')
}

describe('4.4 归档形态（serializeGemgen → ingestProjectAsset）', () => {
  it('任务成功归档为 AssetProject(gemgen)：provenance 全字段 + summary 缓存 + 原始字节内嵌', async () => {
    updateForm({ advancedJson: '{"api_key":"sk-leak","quality":"high"}', size: '1024x1024' })
    const [templateId] = await keepBareTemplates(1)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()

    const task = getTasks()[0]
    expect(task.assetId).toMatch(/^ast-/)
    const node = await getProject(task.assetId as string)
    expect(node).not.toBeNull()
    if (!node) return
    expect(node.type).toBe('project')
    expect(node.projectKind).toBe('gemgen')
    expect(node.mime).toBe(PROJECT_MIME.gemgen)
    // summary 缓存（节点直出，非真源）
    expect(node.summary).toEqual({
      templateName: task.variantName,
      candidateIndex: 0,
      size: '1024x1024',
      mode: 'generate',
    })
    // 溯源收编证明：节点 meta 不再有 runId/variantName/candidateIndex/prompt/referenceAssetId
    // （旧图片形态写 meta；新形态全部上移文件 provenance——AssetProject 无 meta 字段）
    expect((node as unknown as { meta?: unknown }).meta).toBeUndefined()

    const file = await parseGemgenNode(node)
    expect(file.kind).toBe('gemgen')
    expect(file.name).toBe(`${task.variantName}·候选1`)
    expect(file.createdAt).toBe(task.createdAt)
    const p = file.provenance
    expect(p.runId).toBe(task.runId)
    expect(p.templateAssetId).toBe(templateId)
    expect(p.templateName).toBe(task.variantName)
    expect(p.promptBody).toBe(task.prompt)
    expect(p.composedPrompt).toBe(task.composedPrompt) // 请求时全文快照（审计真源）
    expect(p.composedPrompt).toContain(task.prompt)
    expect(p.composedPrompt).toContain('贴钻') // DRILL_RULES 总装骨架在全文中
    expect(p.caseBinding).toBeNull() // 显式未绑定
    expect(p.referenceAssetId).toBeUndefined()
    expect(p.candidateIndex).toBe(0)
    expect(p.requestMode).toBe('generate')
    expect(p.model).toBe('gpt-image-2.5')
    expect(p.size).toBe('1024x1024')
    // N3 打码：advancedJsonRedacted 入档，敏感键不出明文
    expect(p.advancedJsonRedacted).toBeDefined()
    expect(p.advancedJsonRedacted).not.toContain('sk-leak')
    expect(p.advancedJsonRedacted).toContain('***')

    // 内嵌原始字节：dataUrl 解回字节 = 归档时的 result blob（fetch 桩 body result-1）
    expect(file.image.mime).toBe('image/png')
    expect(file.image.width).toBe(64) // OkImage 桩解码尺寸
    expect(file.image.height).toBe(64)
    const expected = [...new TextEncoder().encode('result-1')]
    expect(await bytesOf(await gemgenImageBlob(file))).toEqual(expected)
    // 留 4.5 画廊的接缝：getGemgenImageBlob 单点出口可消费归档产物（B2）
    expect(await bytesOf(await getGemgenImageBlob(node.id))).toEqual(expected)

    // 批次夹归类与计数（project/gemgen 计入口径，文案 `· N 张` 不变）
    const folders = await foldersUnderGenerated()
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · 1 张$/)
    expect(node.parentId).toBe(folders[0].id)
    // jsdom 无 2D 上下文 → thumb 缺省（显式降级路径，归档不失败）
    expect(node.thumbKey).toBeUndefined()
    expect(node.thumb).toBeUndefined()

    // 任务账本：assetId 指向新节点 + composedPrompt 快照持久化（降级不剥 debug 之外的审计字段）
    const persisted = persistedTasks()
    expect(persisted[0].assetId).toBe(task.assetId)
    expect(persisted[0].composedPrompt).toBe(task.composedPrompt)
  })

  it('edit 任务：caseBinding 快照 + referenceAssetId 入 provenance + mode=edit', async () => {
    const [templateId] = await keepBareTemplates(1)
    // 单张案例绑定（物化入 sys-uploads + 写回模板 caseBinding）
    await setTemplateEffectRefSingle(
      templateId,
      new File([new Uint8Array([7, 7, 7])], 'case.png', { type: 'image/png' }),
    )
    const binding = getTemplateRecord(templateId)?.caseBinding
    expect(binding).not.toBeNull()
    // 原图（上传即入库 sys-uploads）
    await setReference(new File([new Uint8Array([9, 9, 9])], 'reference-src.png', { type: 'image/png' }))

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const task = getTasks()[0]
    expect(task.mode).toBe('edit')
    const node = await getProject(task.assetId as string)
    if (!node) throw new Error('归档节点缺失')
    const file = await parseGemgenNode(node)
    expect(file.provenance.requestMode).toBe('edit')
    expect(file.provenance.caseBinding).toEqual(binding)
    expect(file.provenance.referenceAssetId).toBeDefined()
    expect(node.summary.mode).toBe('edit')
    // 组装全文含案例 + 原图（提示词角色面冻结为「参考图」字样）双角色声明（请求时快照）
    expect(task.composedPrompt).toContain('案例参照图')
    expect(task.composedPrompt).toContain('【图二：参考图】')
  })

  it('不可变：updateProjectAsset 对 gemgen 调用即拒（复引 projectAsset.test 语义）', async () => {
    await keepBareTemplates(1)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const task = getTasks()[0]
    const node = await getProject(task.assetId as string)
    if (!node) throw new Error('归档节点缺失')
    await expect(
      updateProjectAsset(node.id, {
        expectedBlobKey: node.blobKey,
        bytes: new Blob(['{}'], { type: PROJECT_MIME.gemgen }),
        summary: {},
      }),
    ).rejects.toThrowError(/不可变/)
  })
})

describe('4.4 归档链（enqueue 串行 / 补偿 / 空批次清理）', () => {
  it('并发成功共享同一批次夹（串行链无懒建竞态重复夹）', async () => {
    await keepBareTemplates(2)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    expect(getTasks()).toHaveLength(2)
    const folders = await foldersUnderGenerated()
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · 2 张$/)
    expect((await gemgenNodesUnder(folders[0].id)).length).toBe(2)
  })

  it('归档失败补偿：终态持久化时幂等补建，产物为一致形态的 gemgen', { timeout: 15000 }, async () => {
    await keepBareTemplates(1)
    // 首个 digest 调用抛错 = 首任务入库失败；此后恢复（补偿链路重试成功）
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
    await waitFor(() => getTasks().every((t) => t.assetId), 5000)
    await whenIdle()

    const task = getTasks()[0]
    const node = await getProject(task.assetId as string)
    if (!node) throw new Error('补偿归档节点缺失')
    const file = await parseGemgenNode(node)
    expect(file.provenance.runId).toBe(task.runId)
    expect(file.provenance.candidateIndex).toBe(0)
    expect(persistedTasks()[0].assetId).toBe(task.assetId)
  })

  it('持续入库失败：任务保持成功态、无空批次夹残留（新建夹被清理软删）', { timeout: 15000 }, async () => {
    await keepBareTemplates(2)
    const imagesBefore = (await listImages()).length
    // digest 恒抛：serialize 之后的 ingest（sha256OfBlob）全部失败
    vi.stubGlobal('crypto', {
      ...crypto,
      subtle: { ...crypto.subtle, digest: vi.fn(async () => Promise.reject(new Error('IDB 满'))) },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await new Promise((resolve) => setTimeout(resolve, 200)) // 让补偿链路跑完一轮（仍失败）
    await whenIdle()

    expect(getTasks().every((t) => t.status === 'success' && !t.assetId)).toBe(true)
    // 空批次清理：懒建的夹已软删，sys-generated 下无有效夹
    expect(await foldersUnderGenerated()).toHaveLength(0)
    expect((await listImages()).length).toBe(imagesBefore) // 归档 blob 零落盘（模板 seed 等基线不变）
    warnSpy.mockRestore()
  })
})

describe('4.4 旧裸图不回填（A.2.4 收编边界）', () => {
  it('新归档链跑过：旧式图片 meta 节点原样（不包装、不改写、不进 gemgen）', async () => {
    // 预置旧形态：批次夹内的裸图片节点（meta 携带旧溯源字段）
    await runAssetMigration()
    const folder = await createFolder(null, '旧批次')
    await moveAsset(folder.id, 'sys-generated')
    const ingested = await ingestAsset({
      blob: new Blob([new Uint8Array([42])], { type: 'image/png' }),
      name: '旧模板·候选1',
      width: 32,
      height: 32,
      parentId: folder.id,
      source: 'lab-generate',
      meta: { runId: 'run-old-1', variantName: '旧模板', candidateIndex: 0, prompt: 'old prompt' },
    })
    const before = JSON.parse(JSON.stringify(await getAsset(ingested.node.id)))

    // 新一轮生成归档（.gemgen）
    await keepBareTemplates(1)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()

    const after = await getAsset(ingested.node.id)
    expect(after).not.toBeNull()
    expect(JSON.parse(JSON.stringify(after))).toEqual(before) // 旧节点逐字段原样
    // 新旧产物分属不同夹：旧夹计数不被新归档触碰（无 gemgen 混入旧夹）
    expect(await gemgenNodesUnder(folder.id)).toHaveLength(0)
  })

  it('hydrate 迁移补归档（旧链路成功任务）：产新 gemgen 档案，旧 ast-task 图片节点原样；计数口径 image+gemgen', async () => {
    resetLabForTests()
    await putImage('legacy-m1', new File([new Uint8Array([5])], 'g.png', { type: 'image/png' }))
    localStorage.setItem(
      'rhinestone-studio:tasks',
      JSON.stringify([
        {
          id: 'legacy-m1',
          runId: 'run-mixed-1',
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

    const task = getTasks().find((t) => t.id === 'legacy-m1')
    expect(task?.assetId).toMatch(/^ast-/)
    expect(task?.assetId).not.toBe('ast-task-legacy-m1') // 新档案节点，不复用旧图片节点
    const node = await getProject(task?.assetId as string)
    if (!node) throw new Error('迁移归档节点缺失')
    expect(node.parentId).toBe('ast-batch-run-mixed-1')

    // legacy composedPrompt：快照引入前的任务按附件形态重建（纯文生图组装）
    const file = await parseGemgenNode(node)
    expect(file.provenance.composedPrompt).toBe(
      composeDrillPrompt('p', { hasCase: false, caseLayout: 'single', hasReference: false }),
    )
    expect(file.provenance.templateAssetId).toBeUndefined() // legacy 任务无模板资产快照

    // 旧图片节点原样（不回填）：type/bytes/meta 不变
    const oldImage = await getAsset('ast-task-legacy-m1')
    expect(oldImage).not.toBeNull()
    expect(oldImage?.type).toBe('image')
    expect(oldImage?.meta).toEqual({
      runId: 'run-mixed-1',
      variantName: '刷新变体',
      candidateIndex: 0,
      prompt: 'p',
      referenceAssetId: undefined,
    })

    // 批次夹计数口径扩：旧图 + 新 gemgen 同计（`· 2 张`，文案不变）
    const folders = await foldersUnderGenerated()
    const mixed = folders.find((f) => f.id === 'ast-batch-run-mixed-1')
    expect(mixed?.name).toMatch(/· 2 张$/)
    const children = await listChildNodes('ast-batch-run-mixed-1')
    expect(children.filter((n) => n.type === 'image')).toHaveLength(1)
    expect(await gemgenNodesUnder('ast-batch-run-mixed-1')).toHaveLength(1)
    // 画廊分组仍按批次（runId）：迁移归档任务组不炸
    expect(getGalleryGroups(GALLERY_FILTER_ALL).some((g) => g.runId === 'run-mixed-1')).toBe(true)
  })
})

describe('4.4 缩略 P0（256px thumb 物理记录）', () => {
  it('canvas 桩（真机路径）：thumbKey + thumb 元组 + 物理记录；节点/档案/GC 各就位', async () => {
    await keepBareTemplates(1)
    // 真机 canvas 桩：getContext 返回可绘制 2D 上下文，toBlob 出 PNG 字节
    const thumbBytes = new Blob([new Uint8Array([2, 0, 2, 0])], { type: 'image/png' })
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    const toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback?.(thumbBytes)
      return undefined
    })

    try {
      startRun()
      await waitFor(() => getTasks().every((t) => t.status === 'success'))
      await whenIdle()
    } finally {
      getContextSpy.mockRestore()
      toBlobSpy.mockRestore()
    }

    const task = getTasks()[0]
    const node = await getProject(task.assetId as string)
    if (!node) throw new Error('归档节点缺失')
    expect(node.thumbKey).toMatch(/^ast-thumb-/)
    expect(node.thumb).toEqual({
      key: node.thumbKey,
      mime: 'image/png',
      width: 256,
      height: 256,
      bytes: thumbBytes.size,
    })
    const physical = await getImageBlob(node.thumbKey as string)
    expect(physical).not.toBeNull()
    expect(await bytesOf(physical as Blob)).toEqual(await bytesOf(thumbBytes))
  })

  it('jsdom 无 2D（缺省路径）：thumb 缺省不阻断归档，节点档案完整', async () => {
    await keepBareTemplates(1)
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const task = getTasks()[0]
    const node = await getProject(task.assetId as string)
    if (!node) throw new Error('归档节点缺失')
    expect(node.thumbKey).toBeUndefined()
    expect(node.thumb).toBeUndefined()
    const file = await parseGemgenNode(node)
    expect(file.kind).toBe('gemgen')
  })
})
