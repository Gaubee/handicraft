/*
 * [add-project-files 4.5] 任务画廊并集 + chips + 卡片两态（design §7.3/§9.2 B7 + 补充稿 §B.2/§B.3）：
 * - 并集矩阵（B7 指定）：重复（task.assetId 认领 gemgen → 活覆盖只读）/ 归档失败（活任务无
 *   assetId 照常展示）/ 模板孤儿（chip 聚合 + entry 归 __deleted__）/ 50 条裁剪（localStorage
 *   裁掉的任务由库内 gemgen 补全史洞）/ 只读卡（provenance 全字段 + imageUrl 异步解析缓存）/
 *   进行中卡（running 活态）/ 活任务指向缺失节点（缺失角标）
 * - chips：计数 / 过滤生效（组结构仍按批次、编号不随过滤重排）/ legacy 只在「全部」/
 *   「已删模板」chip 仅孤儿存在时出现
 * - 卡片两态：默认收起 / 点击展开 / 展开集会话内存（reset store 复位）/ 只读卡无重试·取消·复用参数
 * - 清空历史升级：确认 Dialog 文案 / 可选软删 sys-generated 下 gemgen（二次确认列数量）
 * - PreviewDialog：provenance.referenceAssetId 原图解析分支（失败走「无原图」）+ 只读卡送排钻
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import {
  getTasks,
  hydrate,
  resetLabForTests,
  startRun,
  updateSettings,
} from '$lib/stores/lab.svelte'
import {
  createTemplate,
  getTemplateAssetIds,
  removeTemplate,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import {
  clearGalleryHistory,
  countGeneratedGemgens,
  ensureEntryImageUrl,
  expandEntry,
  findEntryByAssetId,
  getGalleryChips,
  getGalleryEntries,
  getGalleryEntry,
  getGalleryGroups,
  getReadonlyImageUrl,
  isEntryExpanded,
  refreshGallery,
  resetGalleryForTests,
  resolveEntryReferenceUrl,
  sendGalleryEntry,
  toggleEntryExpanded,
  whenGalleryUrlsIdle,
  GALLERY_FILTER_ALL,
  GALLERY_FILTER_DELETED,
} from '$lib/stores/gallery.svelte'
import { getHandoff } from '$lib/stores/handoff.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  createFolder,
  getProject,
  ingestAsset,
  ingestProjectAsset,
  moveAsset,
  resetAssetStoreForTests,
  runAssetMigration,
  trashAsset,
} from '$lib/persistence/assetStore'
import { serializeGemgen } from '$lib/persistence/labFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import TaskCard from '../../components/Lab/TaskCard.svelte'
import TaskQueue from '../../components/Lab/TaskQueue.svelte'
import PreviewDialog from '../../components/Lab/PreviewDialog.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

const B64 = 'aGVsbG8=' // "hello"
const TASKS_KEY = 'rhinestone-studio:tasks'
const DATA_URL = `data:image/png;base64,${B64}`

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
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

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  objectUrlCounter = 0
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/presets/')) {
        const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
        return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      return okResponse()
    }),
  )
  localStorage.clear()
  resetLabForTests() // cancelAll 会持久化上一测试的内存任务——先复位再清，防 hydrate 捞回陈旧任务
  resetGalleryForTests()
  resetToastsForTests()
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  // bits-ui Dialog/portal 卸载的 jsdom 残留：清 body 防跨测试查询污染
  document.body.innerHTML = ''
})

function click(selector: string): void {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`click 目标不存在：${selector}`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

// ---------------------------------------------------------------------------
// 数据脚手架
// ---------------------------------------------------------------------------

/** 单模板启用（name · candidates 候选 · 纯 generations），返回其 assetId。 */
async function setupSingleTemplate(name = 'A', candidates = 2): Promise<string> {
  await hydrate()
  const first = getTemplateAssetIds()[0]
  for (const id of getTemplateAssetIds()) {
    if (id !== first) setEnabledTemplate(id, false)
  }
  submitTemplateField(first, { name, promptBody: `prompt ${name}`, candidates, caseBinding: null })
  await whenTemplatesIdle()
  return first
}

/** 一轮全成功 run（归档完成 + localStorage 落盘）。 */
async function runOnceOk(): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
  startRun()
  await waitFor(
    () =>
      getTasks().length > 0 &&
      getTasks().every((t) => t.status === 'success') &&
      getTasks().every((t) => t.assetId !== undefined),
  )
  await waitFor(
    () =>
      (JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as { assetId?: string }[]).length ===
      getTasks().length,
  )
}

interface SeedGemgenOptions {
  templateAssetId?: string
  templateName: string
  runId: string
  candidateIndex?: number
  createdAt?: number
  referenceAssetId?: string
  corrupt?: boolean
  /** 缺省 = sys-generated 批次夹；可指到其他目录（范围外口径测试）。 */
  parentId?: string
}

/** 直接落一颗 gemgen 档案节点（库源/导入态；返回节点 id）。 */
async function seedGemgenDirect(options: SeedGemgenOptions): Promise<string> {
  let parentId = options.parentId
  if (parentId === undefined) {
    const folder = await createFolder(null, '09-18 10:00 · 1 张')
    parentId = (await moveAsset(folder.id, 'sys-generated')).id
  }
  const createdAt = options.createdAt ?? 1_700_000_000_000
  const candidateIndex = options.candidateIndex ?? 0
  const text = options.corrupt
    ? 'not-a-gemgen-json'
    : serializeGemgen({
        appVersion: 'test',
        createdAt,
        savedAt: createdAt + 1,
        name: `${options.templateName}·候选${candidateIndex + 1}`,
        image: { mime: 'image/png', dataUrl: DATA_URL, width: 8, height: 8 },
        provenance: {
          runId: options.runId,
          ...(options.templateAssetId !== undefined
            ? { templateAssetId: options.templateAssetId }
            : {}),
          templateName: options.templateName,
          promptBody: `prompt ${options.templateName}`,
          composedPrompt: `composed ${options.templateName}`,
          caseBinding: null,
          ...(options.referenceAssetId !== undefined
            ? { referenceAssetId: options.referenceAssetId }
            : {}),
          candidateIndex,
          requestMode: 'generate',
          model: 'gpt-image-2.5',
          size: '1024x1024',
        },
      })
  const ingested = await ingestProjectAsset({
    blob: new Blob([text], { type: PROJECT_MIME.gemgen }),
    name: `${options.templateName}·候选${candidateIndex + 1}`,
    projectKind: 'gemgen',
    parentId,
    summary: {
      templateName: options.templateName,
      candidateIndex,
      size: '1024x1024',
      mode: 'generate',
    },
  })
  return ingested.node.id
}

async function ingestReferencePng(name: string): Promise<string> {
  await runAssetMigration() // sys-uploads 系统目录种子（未走 lab hydrate 的测试路径）
  const ingested = await ingestAsset({
    blob: new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' }),
    name,
    width: 4,
    height: 4,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  return ingested.node.id
}

// ---------------------------------------------------------------------------
// 并集矩阵（B7）
// ---------------------------------------------------------------------------

describe('并集矩阵（B7：活任务 ∪ 库内 gemgen）', () => {
  it('重复：task.assetId 认领库内同 id gemgen → 单 entry，活任务覆盖只读投影', async () => {
    const aId = await setupSingleTemplate()
    await runOnceOk() // 2 候选 → 2 任务归档（assetId 各指向 gemgen 节点）
    await refreshGallery()

    const entries = getGalleryEntries()
    expect(entries).toHaveLength(2)
    for (const task of getTasks()) {
      const entry = findEntryByAssetId(task.assetId as string)
      expect(entry).toBeDefined()
      expect(entry?.key).toBe(`asset:${task.assetId}`)
      expect(entry?.live).toBe(true) // 活覆盖只读：不出现第二颗「库」卡
      expect(entry?.status).toBe('success')
    }
    // 同 id 只有一个 entry（认领去重，不双卡）
    expect(new Set(entries.map((e) => e.key)).size).toBe(2)
    expect(entries.every((e) => e.templateAssetId === aId)).toBe(true)
  })

  it('归档失败：成功任务无 assetId（字节已不可得）→ 照常展示为活卡（task:<id> 键）', async () => {
    // 旧成功任务：imageStored 但无 assetId、IDB 无 blob → hydrate 置 imageMissing，不归档
    localStorage.setItem(
      TASKS_KEY,
      JSON.stringify([
        {
          id: 'task-noarch',
          runId: 'run-noarch-1',
          variantId: 'v1',
          variantName: 'A',
          candidateIndex: 0,
          prompt: 'p',
          mode: 'generate',
          model: 'gpt-image-2.5',
          size: '1024x1024',
          advancedJson: '',
          status: 'success',
          hasReference: false,
          imageStored: true,
          createdAt: 1_700_000_100_000,
          finishedAt: 1_700_000_101_000,
          durationMs: 1000,
        },
      ]),
    )
    await hydrate()
    await refreshGallery()

    const entries = getGalleryEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.key).toBe('task:task-noarch') // 无 assetId 以 task id（B7）
    expect(entries[0]?.live).toBe(true)
    expect(entries[0]?.status).toBe('success')
    expect(entries[0]?.assetMissing).toBeFalsy() // 无 assetId 不判缺失
  })

  it('模板孤儿：模板删除 → 「已删模板」聚合 chip 出现、entry 归 __deleted__、原模板 chip 消失', async () => {
    const aId = await setupSingleTemplate()
    await runOnceOk()
    await refreshGallery()

    // 删除前：无 __deleted__ chip（仅孤儿存在时出现）
    expect(getGalleryChips().some((c) => c.filter === GALLERY_FILTER_DELETED)).toBe(false)

    await removeTemplate(aId)
    const chips = getGalleryChips()
    const deletedChip = chips.find((c) => c.filter === GALLERY_FILTER_DELETED)
    expect(deletedChip).toBeDefined()
    expect(deletedChip?.count).toBe(2)
    expect(deletedChip?.orphanTemplateNames).toEqual(['A'])
    expect(chips.some((c) => c.filter === aId)).toBe(false) // 模板 chip 随列表消失

    // entry 归 __deleted__；「全部」仍可见
    const deletedGroups = getGalleryGroups(GALLERY_FILTER_DELETED)
    expect(deletedGroups).toHaveLength(1)
    expect(deletedGroups[0]?.entries).toHaveLength(2)
    expect(getGalleryGroups(GALLERY_FILTER_ALL)[0]?.entries).toHaveLength(2)
  })

  it('50 条裁剪：localStorage 任务被裁 → 库内 gemgen 补全史洞（只读卡，provenance 全字段）', async () => {
    const aId = await setupSingleTemplate('A', 2)
    await runOnceOk()
    const runId = getTasks()[0]?.runId as string
    const assetIds = getTasks()
      .map((t) => t.assetId)
      .filter((id): id is string => id !== undefined)

    // 模拟裁剪：任务账本整体丢失（localStorage 三级降级裁掉），库仍在
    resetLabForTests()
    resetGalleryForTests()
    localStorage.removeItem(TASKS_KEY)
    await refreshGallery()

    const entries = getGalleryEntries()
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => !e.live && e.key === `asset:${e.assetId}`)).toBe(true)
    expect(entries.map((e) => e.assetId).sort()).toEqual([...assetIds].sort())
    for (const entry of entries) {
      expect(entry.templateAssetId).toBe(aId)
      expect(entry.templateName).toBe('A')
      expect(entry.runId).toBe(runId) // 库源 runId 取 provenance.runId
      expect(entry.status).toBe('success')
      expect(entry.composedPrompt).toContain('prompt A') // composeDrillPrompt 全文含模板体
    }
    // 组结构：批次仍按 runId（runIndex 在未过滤全集上编号）
    const groups = getGalleryGroups(GALLERY_FILTER_ALL)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.runId).toBe(runId)
    expect(groups[0]?.runIndex).toBe(1)
  })

  it('只读卡 imageUrl：异步解析 + 会话缓存（同档案只解析一次）；损坏档案 → parseError 占位 + url 失败', async () => {
    const aId = await setupSingleTemplate()
    await runOnceOk()
    resetLabForTests()
    resetGalleryForTests()
    localStorage.removeItem(TASKS_KEY)
    await seedGemgenDirect({ templateAssetId: aId, templateName: '坏档案', runId: 'run-bad-1', corrupt: true })
    await refreshGallery()

    const entries = getGalleryEntries()
    expect(entries).toHaveLength(3) // 2 颗好档案 + 1 颗坏档案
    const ok = entries.find((e) => e.parseError === undefined)
    const bad = entries.find((e) => e.parseError !== undefined)
    expect(ok).toBeDefined()
    expect(bad?.parseError).toBeTruthy()

    // 好档案：pending → 解析 → url（缓存命中不重复 createObjectURL）
    if (ok?.assetId === undefined) throw new Error('assetId 缺失')
    expect(getReadonlyImageUrl(ok.assetId)).toBeUndefined()
    ensureEntryImageUrl(ok)
    await whenGalleryUrlsIdle()
    const url = getReadonlyImageUrl(ok.assetId)
    expect(url).toMatch(/^blob:mock-/)
    ensureEntryImageUrl(ok)
    await whenGalleryUrlsIdle()
    expect(getReadonlyImageUrl(ok.assetId)).toBe(url)

    // 坏档案：不发起取字节，直接失败占位（null）
    if (bad?.assetId === undefined) throw new Error('bad assetId 缺失')
    ensureEntryImageUrl(bad)
    await whenGalleryUrlsIdle()
    expect(getReadonlyImageUrl(bad.assetId)).toBeNull()
  })

  it('进行中卡：running 任务活态展示（chips 计数含进行中）', async () => {
    await setupSingleTemplate('A', 1)
    const gate = new Promise<Response>((resolve) => {
      setTimeout(() => resolve(okResponse()), 500)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => (String(url).startsWith('/presets/') ? okResponse() : await gate)),
    )
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'running')

    const entries = getGalleryEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.live).toBe(true)
    expect(entries[0]?.status).toBe('running')
    expect(getGalleryChips()[0]?.count).toBe(1)
    await waitFor(() => getTasks()[0]?.status === 'success')
  })

  it('活任务指向缺失节点（档案软删）→ 活态展示 + assetMissing 角标；只读投影不复活', async () => {
    await setupSingleTemplate('A', 1)
    await runOnceOk()
    await refreshGallery()
    const assetId = getTasks()[0]?.assetId as string
    expect(findEntryByAssetId(assetId)?.assetMissing).toBeFalsy()

    await trashAsset(assetId)
    await refreshGallery()
    const entry = findEntryByAssetId(assetId)
    expect(entry).toBeDefined()
    expect(entry?.live).toBe(true)
    expect(entry?.assetMissing).toBe(true)
    expect(getGalleryEntries().some((e) => !e.live && e.assetId === assetId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// chips（过滤态）
// ---------------------------------------------------------------------------

describe('chips（计数 / 过滤生效 / legacy 只在全部）', () => {
  it('计数正确 + 模板列表序：全部·N + 每模板带计数', async () => {
    await hydrate()
    const first = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) {
      if (id !== first) setEnabledTemplate(id, false)
    }
    submitTemplateField(first, { name: 'A', promptBody: 'a', candidates: 2, caseBinding: null })
    const bId = (await createTemplate()) as string
    submitTemplateField(bId, { name: 'B', promptBody: 'b', candidates: 1 })
    await whenTemplatesIdle()

    await runOnceOk() // A×2 + B×1
    await refreshGallery()

    const chips = getGalleryChips()
    expect(chips[0]?.filter).toBe(GALLERY_FILTER_ALL) // 「全部」居首
    expect(chips[0]?.count).toBe(3)
    const chipA = chips.find((c) => c.filter === first) // 模板 chip 按列表序出现
    const chipB = chips.find((c) => c.filter === bId)
    expect(chipA?.count).toBe(2)
    expect(chipA?.label).toBe('A')
    expect(chipB?.count).toBe(1)
    expect(chips.indexOf(chipA as (typeof chips)[number])).toBeLessThan(chips.indexOf(chipB as (typeof chips)[number]))
  })

  it('过滤生效：组结构仍按批次、过滤丢弃空组、批次编号不随过滤重排', async () => {
    const aId = await setupSingleTemplate('A', 1)
    await runOnceOk()
    await runOnceOk()
    await refreshGallery()

    const allGroups = getGalleryGroups(GALLERY_FILTER_ALL)
    expect(allGroups).toHaveLength(2)
    const allIndexes = allGroups.map((g) => g.runIndex)

    const filtered = getGalleryGroups(aId)
    expect(filtered).toHaveLength(2)
    expect(filtered.map((g) => g.runIndex)).toEqual(allIndexes) // 编号在全集上稳定
    expect(filtered.every((g) => g.entries.every((e) => e.templateAssetId === aId))).toBe(true)

    // 无匹配的过滤 → 空组序列（过滤空态由组件呈现）
    const bId = (await createTemplate()) as string
    expect(getGalleryGroups(bId)).toHaveLength(0)
  })

  it('legacy 任务（无 templateAssetId）只在「全部」出现：任何模板 chip 与 __deleted__ 下隐藏', async () => {
    await setupSingleTemplate()
    await runOnceOk()
    const persisted = JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as object[]
    resetLabForTests() // 先复位（cancelAll 会重写 localStorage），再叠加 legacy 条目
    resetGalleryForTests()
    localStorage.setItem(
      TASKS_KEY,
      JSON.stringify([
        ...persisted,
        {
          id: 'legacy-1',
          runId: 'legacy',
          variantId: 'v-old',
          variantName: '旧变体',
          candidateIndex: 0,
          prompt: 'old',
          mode: 'generate',
          model: 'gpt-image-2.5',
          size: '1024x1024',
          advancedJson: '',
          status: 'success',
          hasReference: false,
          imageStored: false,
          createdAt: 1_700_000_000_500,
          finishedAt: 1_700_000_001_500,
          durationMs: 1000,
        },
      ]),
    )
    await hydrate()
    await refreshGallery()

    const allEntries = getGalleryGroups(GALLERY_FILTER_ALL).flatMap((g) => g.entries)
    expect(allEntries.some((e) => e.key === 'task:legacy-1')).toBe(true)

    for (const chip of getGalleryChips()) {
      if (chip.filter === GALLERY_FILTER_ALL) continue
      const entries = getGalleryGroups(chip.filter).flatMap((g) => g.entries)
      expect(entries.some((e) => e.key === 'task:legacy-1')).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 卡片两态（store + TaskCard 组件）
// ---------------------------------------------------------------------------

describe('卡片两态（收起默认 / 点击展开 / 展开集会话内存 / 只读卡动作面）', () => {
  it('store：默认收起；toggle/expand；resetGalleryForTests 复位（会话内存）', async () => {
    await setupSingleTemplate('A', 1)
    await runOnceOk()
    const entry = getGalleryEntries()[0]
    if (!entry) throw new Error('entry 缺失')

    expect(isEntryExpanded(entry.key)).toBe(false)
    toggleEntryExpanded(entry.key)
    expect(isEntryExpanded(entry.key)).toBe(true)
    toggleEntryExpanded(entry.key)
    expect(isEntryExpanded(entry.key)).toBe(false)
    expandEntry(entry.key) // 4.6 定位-展开接缝
    expect(isEntryExpanded(entry.key)).toBe(true)

    resetGalleryForTests() // 刷新复位 = store 整体重置的等价物
    expect(isEntryExpanded(entry.key)).toBe(false)
  })

  it('TaskCard：默认收起（无展开区）；点击收起行 toggle；data-testid/data-entry-key 约定', async () => {
    await setupSingleTemplate('A', 1)
    await runOnceOk()
    const entry = getGalleryEntries()[0]
    if (!entry) throw new Error('entry 缺失')

    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(TaskCard, { target, props: { entry, onopenpreview: () => {} } })

    const root = target.querySelector('[data-testid="gallery-entry"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('data-entry-key')).toBe(entry.key)
    expect(target.querySelector('[data-testid="entry-expanded"]')).toBeNull() // 默认收起

    click('[data-testid="entry-toggle"]')
    await tick()
    expect(target.querySelector('[data-testid="entry-expanded"]')).not.toBeNull()

    click('[data-testid="entry-toggle"]')
    await tick()
    expect(target.querySelector('[data-testid="entry-expanded"]')).toBeNull()

    unmount(component)
    target.remove()
  })

  // [UX-A] 状态图标居中结构断言：缩略位容器必须 flex 全心居中，图标禁 m-auto
  //（inline SVG 的 auto 边距计算为 0，图标钉盒顶——jsdom 无法验视觉，class 即几何契约）
  it('TaskCard：缩略位状态图标（running spinner）容器 flex 居中且图标无 m-auto', async () => {
    await setupSingleTemplate('A', 1)
    const gate = new Promise<Response>((resolve) => {
      setTimeout(() => resolve(okResponse()), 500)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => (String(url).startsWith('/presets/') ? okResponse() : await gate)),
    )
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'running')
    const entry = getGalleryEntries()[0]
    if (!entry) throw new Error('entry 缺失')

    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(TaskCard, { target, props: { entry, onopenpreview: () => {} } })

    const thumb = target.querySelector('[data-testid="entry-toggle"] > span.relative')
    expect(thumb).not.toBeNull()
    expect(thumb?.classList.contains('flex')).toBe(true)
    expect(thumb?.classList.contains('items-center')).toBe(true)
    expect(thumb?.classList.contains('justify-center')).toBe(true)
    const icon = thumb?.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon?.classList.contains('animate-spin')).toBe(true)
    expect(icon?.classList.contains('m-auto')).toBe(false) // 旧 bug 的回归钉

    unmount(component)
    target.remove()
    await waitFor(() => getTasks()[0]?.status === 'success')
  })

  it('只读卡：无重试/取消/复用参数；带「库」角标与送排钻/下载/放大对比 + 提示词档案折叠', async () => {
    await setupSingleTemplate()
    await runOnceOk()
    resetLabForTests()
    resetGalleryForTests()
    localStorage.removeItem(TASKS_KEY)
    await refreshGallery()

    const entry = getGalleryEntries()[0]
    if (!entry || entry.live) throw new Error('只读 entry 缺失')
    ensureEntryImageUrl(entry)
    await whenGalleryUrlsIdle()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(TaskCard, { target, props: { entry, onopenpreview: () => {} } })
    click('[data-testid="entry-toggle"]')
    await tick()

    const cardText = target.textContent ?? ''
    const text = target.querySelector('[data-testid="entry-expanded"]')?.textContent ?? ''
    expect(cardText).toContain('库') // 库来源角标（收起行状态位）
    expect(text).toContain('放大对比')
    expect(text).toContain('送排钻')
    expect(text).toContain('下载')
    expect(text).not.toContain('重试')
    expect(text).not.toContain('取消')
    expect(text).not.toContain('复用参数')
    expect(text).toContain('提示词全文（档案快照）') // composedPrompt（provenance）

    unmount(component)
    target.remove()
  })

  it('活卡失败态：展开含重试/去设置；终态无取消；debug 折叠在', async () => {
    await setupSingleTemplate('A', 1)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).startsWith('/presets/') ? okResponse() : errorResponse(500, 'boom'),
      ),
    )
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')
    const entry = getGalleryEntries()[0]
    if (!entry) throw new Error('entry 缺失')

    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(TaskCard, { target, props: { entry, onopenpreview: () => {} } })
    click('[data-testid="entry-toggle"]')
    await tick()

    const text = target.querySelector('[data-testid="entry-expanded"]')?.textContent ?? ''
    expect(text).toContain('重试')
    expect(text).toContain('去设置')
    expect(text).not.toContain('取消') // 终态无取消
    expect(text).toContain('debug')

    unmount(component)
    target.remove()
  })
})

// ---------------------------------------------------------------------------
// 清空历史升级（确认 Dialog / 可选软删 gemgen）
// ---------------------------------------------------------------------------

describe('清空历史升级（B.3：确认 Dialog + 可选软删）', () => {
  it('clearGalleryHistory({trashGemgens:false})：任务清空、档案保留（画廊只读可见）', async () => {
    await setupSingleTemplate('A', 2)
    await runOnceOk()
    const assetId = getTasks()[0]?.assetId as string

    await clearGalleryHistory({ trashGemgens: false })

    expect(getTasks()).toHaveLength(0)
    expect((await getProject(assetId))?.trashedAt).toBeUndefined() // 档案完好
    const readonlyAfter = getGalleryEntries().filter((e) => !e.live)
    expect(readonlyAfter.map((e) => e.assetId)).toContain(assetId) // 画廊只读保留
  })

  it('clearGalleryHistory({trashGemgens:true})：sys-generated 下 gemgen 软删；范围外 gemgen 不动', async () => {
    const aId = await setupSingleTemplate('A', 1)
    await runOnceOk()
    const inRangeId = getTasks()[0]?.assetId as string
    const outOfRangeId = await seedGemgenDirect({
      templateAssetId: aId,
      templateName: '导入档案',
      runId: 'run-import-1',
      parentId: 'sys-projects',
    })
    expect(await countGeneratedGemgens()).toBe(1) // 只计 sys-generated 子树

    await clearGalleryHistory({ trashGemgens: true })

    expect((await getProject(inRangeId))?.trashedAt).toBeDefined()
    expect((await getProject(outOfRangeId))?.trashedAt).toBeUndefined()
    expect(getGalleryEntries().some((e) => e.assetId === inRangeId)).toBe(false) // 重扫在 clear 内完成
  })

  it('TaskQueue 确认 Dialog：文案承诺 + 可选项二次确认列数量 + 执行软删', async () => {
    await setupSingleTemplate('A', 1)
    await runOnceOk()
    resetLabForTests()
    resetGalleryForTests()
    localStorage.removeItem(TASKS_KEY)
    await refreshGallery()
    expect(getGalleryEntries().length).toBeGreaterThan(0)
    const assetId = getGalleryEntries()[0]?.assetId as string

    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(TaskQueue, { target, props: { onopenpreview: () => {} } })
    await tick()

    click('[data-testid="clear-history-open"]')
    await tick()
    await waitFor(() => document.querySelector('[data-testid="clear-history-dialog"]') !== null)

    const dialog = document.querySelector('[data-testid="clear-history-dialog"]')
    expect(dialog?.textContent).toContain('清除本次会话任务记录；生成结果档案保留在素材库与画廊（只读）')
    expect(dialog?.textContent).toContain('同时移入库内生成结果')

    // 第一步确认（未勾选）→ 直接执行并关闭（档案保留）
    click('[data-testid="clear-history-confirm"]')
    await waitFor(() => document.querySelector('[data-testid="clear-history-dialog"]') === null)
    expect(getGalleryEntries().some((e) => !e.live)).toBe(true)
    expect((await getProject(assetId))?.trashedAt).toBeUndefined()

    // 第二轮：勾选「同时移入」→ 二次确认列数量
    click('[data-testid="clear-history-open"]')
    await tick()
    await waitFor(() => document.querySelector('[data-testid="clear-history-dialog"]') !== null)
    click('[data-testid="clear-history-also-remove"]')
    await tick()
    click('[data-testid="clear-history-confirm"]')
    await waitFor(() =>
      document
        .querySelector('[data-testid="clear-history-dialog"]')
        ?.textContent?.includes('将同时把 1 个生成结果档案移入回收站') === true,
    )

    click('[data-testid="clear-history-confirm-final"]')
    await waitFor(() => document.querySelector('[data-testid="clear-history-dialog"]') === null)
    expect(getGalleryEntries()).toHaveLength(0) // 任务与档案俱清
    expect((await getProject(assetId))?.trashedAt).toBeDefined()

    unmount(component)
    target.remove()
  })
})

// ---------------------------------------------------------------------------
// PreviewDialog 原图来源扩展（会话 reference ?? referenceAssetId 解析）
// ---------------------------------------------------------------------------

describe('PreviewDialog 原图来源扩展（B.2.3）', () => {
  it('resolveEntryReferenceUrl：无会话引用 → referenceAssetId 经 getAssetBlob 解析；缺失 → null；缓存命中', async () => {
    const referenceId = await ingestReferencePng('ref.png')
    const entryLike = {
      key: 'asset:test-x',
      live: false,
      templateName: 'A',
      runId: 'run-ref-1',
      candidateIndex: 0,
      status: 'success' as const,
      createdAt: 1,
      referenceAssetId: referenceId,
    }
    const url = await resolveEntryReferenceUrl(entryLike)
    expect(url).toMatch(/^blob:mock-/)
    expect(await resolveEntryReferenceUrl(entryLike)).toBe(url) // 缓存
    expect(await resolveEntryReferenceUrl({ ...entryLike, referenceAssetId: 'ast-missing' })).toBeNull()
    expect(await resolveEntryReferenceUrl({ ...entryLike, referenceAssetId: undefined })).toBeNull()
  })

  it('只读卡打开对比器：provenance.referenceAssetId 解析成功 → 叠加可用 + 原图渲染', async () => {
    const referenceId = await ingestReferencePng('ref2.png')
    const gemgenId = await seedGemgenDirect({
      templateName: '带参考',
      runId: 'run-ref-2',
      referenceAssetId: referenceId,
    })
    await refreshGallery()
    const entry = getGalleryEntry(`asset:${gemgenId}`)
    if (!entry) throw new Error('entry 缺失')

    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(PreviewDialog, {
      target,
      props: { open: true, entryKey: entry.key, onsend: () => {} },
    })
    await waitFor(() => {
      const overlayTrigger = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('叠加'),
      )
      return overlayTrigger !== undefined && !overlayTrigger.disabled
    })
    expect(document.querySelector('img[alt="原图"]')?.getAttribute('src')).toMatch(/^blob:mock-/)
    expect(document.querySelector('img[alt="生成候选"]')).not.toBeNull()

    unmount(component)
    target.remove()
  })

  it('送排钻：只读卡经 gemgen 资产交接（handoff payload 带档案 referenceAssetId）', async () => {
    const referenceId = await ingestReferencePng('ref3.png')
    const gemgenId = await seedGemgenDirect({
      templateName: '交接',
      runId: 'run-send-1',
      referenceAssetId: referenceId,
    })
    await refreshGallery()
    const okSend = await sendGalleryEntry(`asset:${gemgenId}`)
    expect(okSend).toBe(true)
    expect(getHandoff()).toEqual({
      assetId: gemgenId,
      name: '交接-候选1.png',
      referenceAssetId: referenceId,
    })
  })
})
