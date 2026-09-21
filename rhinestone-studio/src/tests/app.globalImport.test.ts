/*
 * [add-project-files 2.7 Test] App 层全局导入（file input + 窗口级 drop）四格式路由：
 * - 识别：扩展名 / vendor MIME 双识别（沿 PROJECT_MIME 唯一真源；.gemshape 不在本面）；
 * - 路由：gemproj → 排钻工作台（openIntent 消费归 studio 打开链路）/ gemdoc → 设计师工作台 /
 *   gemtpl·gemgen → 实验室（4.6 意图通道）——openProjectNode canonical 语义对齐（素材库 1.4）；
 * - 失败三段式 toast（不支持类型 / 内容与类型不符未入库）；重复导入幂等（ingest 重名后缀）；
 * - drop：dragover preventDefault（放行 drop）+ dataTransfer.files 消费。
 * 意图断言 phase 无关（消费方 claim/ack 异步进行中不影响路由事实）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from '../App.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { peekOpenIntent, resetOpenIntentForTests } from '$lib/stores/openIntent.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import { resetGalleryForTests } from '$lib/stores/gallery.svelte'
import { resetEditForTests } from '$lib/stores/edit.svelte'
import {
  listChildNodes,
  resetAssetStoreForTests,
  SYS_PROJECTS_FOLDER_ID,
} from '$lib/persistence/assetStore'
import type { AssetProject } from '$lib/persistence/projectTypes'
import { serializeGemdoc, serializeGemproj } from '$lib/persistence/projectFile'
import { serializeGemgen, serializeGemtpl } from '$lib/persistence/labFile'
import { installFakeIndexedDB, type FakeIndexedDB } from './lab/helpers/fakeIndexedDB'

const B64 = 'aGVsbG8='
const DATA_URL = `data:image/png;base64,${B64}`
const STAMP = 1_758_000_000_000

let fake: FakeIndexedDB
let objectUrlCounter = 0
/** 泄漏兜底：断言失败漏卸载的 App 的 $effect/窗口监听跨测试存活（openIntentFlow 同式）。 */
const mountedDisposers: Array<() => void> = []

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
  resetEditForTests()
  resetLabForTests()
  resetGalleryForTests()
  resetOpenIntentForTests()
  resetToastsForTests()
  localStorage.clear()
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
  vi.stubGlobal('createImageBitmap', undefined)
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
      return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
      )
    }),
  )
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
  setView('assets')
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 四格式 fixture（serialize 最小字段——ingest 深度校验为 kind/mime 交叉，路由面不重 parse）
// ---------------------------------------------------------------------------

function gemprojText(): string {
  return serializeGemproj({
    appVersion: '0.1.0-test',
    createdAt: STAMP,
    savedAt: STAMP,
    name: '工程导入',
    source: { kind: 'asset', assetId: 'ast-img-src', name: 'a.png', width: 64, height: 48, downscale: 1 },
    segment: { k: 6, seed: 0 },
    layers: [
      {
        id: 'L1',
        name: '图层 1',
        blockIds: 'rest',
        strategy: 'poisson',
        physics: { specKey: 'round-ss6', gapMm: 0.8, density: 0.5, relax: { boundary: false, repulsion: false } },
        overrides: { disabled: {}, density: {}, type: {}, color: {} },
      },
    ],
    palette: [{ id: 'black', name: '黑', hex: '#1A1A1A' }],
  })
}

function gemdocText(): string {
  return serializeGemdoc({
    appVersion: '0.1.0-test',
    createdAt: STAMP,
    savedAt: STAMP,
    name: '文档导入',
    width: 64,
    height: 48,
    grid: { pitchMm: 2.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 },
    palette: [{ id: 'black', name: '黑', hex: '#1A1A1A' }],
    gems: [
      {
        id: 'g00001',
        x: 12.5,
        y: 20.25,
        colorId: 'black',
        blockId: 'blk-1',
        origin: 'layout',
        moved: false,
        shapeId: 'round',
        diameterMm: 2.8,
        layerId: 'L1', // [1.2 v3 演进] 归属层
      },
    ],
    // [1.2 v3 演进] 钻石层记录 + underlay 源（载荷入源；v2 四层/顶层三载荷键退役）
    layers: [{ id: 'L1', name: '图层 1', visible: true, locked: false }],
    underlay: {
      sources: [
        { key: 'painting', visible: true, opacity: 1, painting: { mime: 'image/png', dataUrl: DATA_URL } },
        {
          key: 'blocks',
          visible: true,
          opacity: 0.9,
          blocks: [
            {
              id: 'blk-1',
              label: '主体',
              mask: { w: 3, h: 3, bits: Uint8Array.from([1, 1, 0, 1, 1, 0, 1, 1, 1]) },
              colorRgb: [200, 16, 46],
              areaPx: 7,
              bbox: { x: 10, y: 20, w: 3, h: 3 },
              widthPx: { max: 3, mean: 2.5 },
              suggested: 'fill',
            },
          ],
        },
      ],
    },
    provenance: { origin: 'quick-layout', sourceSummary: '导入测试 · 12 钻' },
  })
}

function gemtplText(): string {
  return serializeGemtpl({
    appVersion: '0.1.0-test',
    createdAt: STAMP,
    savedAt: STAMP,
    name: '模板导入',
    promptBody: '测试提示词',
    caseBinding: null,
    candidates: 2,
    provenance: { source: 'user-created', presetId: 'import-test', sourceNote: 'App 全局导入测试' },
  })
}

function gemgenText(): string {
  return serializeGemgen({
    appVersion: '0.1.0-test',
    createdAt: STAMP,
    savedAt: STAMP + 1,
    name: '档案导入·候选1',
    image: { mime: 'image/png', dataUrl: DATA_URL, width: 8, height: 8 },
    provenance: {
      runId: 'run-import',
      templateName: '档案导入',
      promptBody: 'prompt',
      composedPrompt: 'composed',
      caseBinding: null,
      candidateIndex: 0,
      requestMode: 'generate',
      model: 'gpt-image-2.5',
      size: '1024x1024',
    },
  })
}

const FIXTURES = {
  gemproj: gemprojText,
  gemdoc: gemdocText,
  gemtpl: gemtplText,
  gemgen: gemgenText,
} as const

type ImportKind = keyof typeof FIXTURES

/** 无 vendor MIME 的磁盘 File 形态（type=''——扩展名识别路径）。 */
function diskFile(kind: ImportKind): File {
  return new File([FIXTURES[kind]()], `导入样本.${kind}`, { type: '' })
}

// ---------------------------------------------------------------------------
// App 挂载 + 输入/drop 注入
// ---------------------------------------------------------------------------

async function mountApp(): Promise<() => void> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  await tick()
  const dispose = () => {
    unmount(app)
    target.remove()
  }
  mountedDisposers.push(dispose)
  return dispose
}

async function flush(ms = 60): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * [redesign-designer-workbench 6/7 批加固] 导入落库有界轮询等待（断言不变，只换等待方式）：
 * 批量 drop 的第二文件导入是异步 IDB 写——固定 60ms flush 在并行测试负载下偶发未完成
 * （迟到导入渗入下一测试的零产物断言）。轮询至 count 个项目节点或 3s 截止，轮询间隔
 * 复用 flush 的让步语义。
 */
async function waitForImportedProjects(count: number): Promise<AssetProject[]> {
  const deadline = Date.now() + 3000
  for (;;) {
    const projects = await importedProjects()
    if (projects.length >= count || Date.now() >= deadline) return projects
    await flush(30)
  }
}

function importViaInput(file: File): void {
  const input = document.querySelector('[data-testid="app-import-input"]') as HTMLInputElement
  if (input === null) throw new Error('导入 input 未挂载')
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function dropOnWindow(file: File): void {
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
  window.dispatchEvent(drop)
}

async function importedProjects(): Promise<AssetProject[]> {
  const nodes = await listChildNodes(SYS_PROJECTS_FOLDER_ID)
  return nodes.filter((n): n is AssetProject => n.type === 'project')
}

/** 成功 toast 以成员断言（消费方 EditView/LabView 的后续 toast 会追加，不占位断言末条）。 */
function hasToast(fragment: string): boolean {
  return getToasts().some((t) => t.message.includes(fragment))
}

// ---------------------------------------------------------------------------
// 四格式导入路由
// ---------------------------------------------------------------------------

describe('App 全局导入：四格式路由（input + drop）', () => {
  it('gemproj（input）→ ingest sys-projects + openIntent + 切排钻工作台', async () => {
    const dispose = await mountApp()
    importViaInput(diskFile('gemproj'))
    await waitForImportedProjects(1)

    const [node] = await importedProjects()
    expect(node?.projectKind).toBe('gemproj')
    expect(node?.name).toBe('导入样本')
    expect(getView()).toBe('studio')
    expect(peekOpenIntent()?.kind).toBe('gemproj')
    expect(peekOpenIntent()?.assetId).toBe(node!.id)
    expect(hasToast('已导入排钻工程「导入样本」')).toBe(true)
    dispose()
  })

  it('gemdoc（drop）→ 切设计师工作台 + openIntent', async () => {
    const dispose = await mountApp()
    dropOnWindow(diskFile('gemdoc'))
    await waitForImportedProjects(1)

    const [node] = await importedProjects()
    expect(node?.projectKind).toBe('gemdoc')
    expect(getView()).toBe('edit')
    expect(peekOpenIntent()?.kind).toBe('gemdoc')
    expect(peekOpenIntent()?.assetId).toBe(node!.id)
    expect(hasToast('已导入精修文档')).toBe(true)
    dispose()
  })

  it('gemtpl（input）→ 切实验室（4.6 意图通道）', async () => {
    const dispose = await mountApp()
    importViaInput(diskFile('gemtpl'))
    await waitForImportedProjects(1)

    const [node] = await importedProjects()
    expect(node?.projectKind).toBe('gemtpl')
    expect(getView()).toBe('lab')
    expect(peekOpenIntent()?.kind).toBe('gemtpl')
    expect(hasToast('已导入提示词模板')).toBe(true)
    dispose()
  })

  it('gemgen（drop）→ 切实验室（4.6 意图通道）', async () => {
    const dispose = await mountApp()
    dropOnWindow(diskFile('gemgen'))
    await waitForImportedProjects(1)

    const [node] = await importedProjects()
    expect(node?.projectKind).toBe('gemgen')
    expect(getView()).toBe('lab')
    expect(peekOpenIntent()?.kind).toBe('gemgen')
    expect(hasToast('已导入生成档案')).toBe(true)
    dispose()
  })

  it('vendor MIME 识别（type 命中 PROJECT_MIME——无扩展名文件）', async () => {
    const dispose = await mountApp()
    importViaInput(new File([gemdocText()], 'no-extension', { type: 'application/vnd.rhinestone-studio.gemdoc+json' }))
    await waitForImportedProjects(1)

    const [node] = await importedProjects()
    expect(node?.projectKind).toBe('gemdoc')
    expect(getView()).toBe('edit')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// 失败分支（三段式 toast）+ 幂等
// ---------------------------------------------------------------------------

describe('App 全局导入：失败分支与幂等', () => {
  it('不支持的类型（.txt / .gemshape 不在本面）→ 三段式 toast、零入库、零切视图零意图', async () => {
    const dispose = await mountApp()
    importViaInput(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    await flush()
    importViaInput(new File(['{}'], 'shape.gemshape', { type: '' }))
    await flush()

    expect((await importedProjects())).toHaveLength(0)
    expect(getView()).toBe('assets')
    expect(peekOpenIntent()).toBeNull()
    const messages = getToasts().map((t) => t.message).join('\n')
    expect(messages).toContain('无法导入「notes.txt」')
    expect(messages).toContain('无法导入「shape.gemshape」')
    expect(messages).toContain('已留在当前页面')
    dispose()
  })

  it('内容与类型不符（.gemproj 壳装 gemdoc 字节）→ ingest 交叉校验拒收、三段式 toast 未入库', async () => {
    const dispose = await mountApp()
    importViaInput(new File([gemdocText()], 'mismatch.gemproj', { type: '' }))
    await flush()

    expect((await importedProjects())).toHaveLength(0)
    expect(getView()).toBe('assets')
    expect(peekOpenIntent()).toBeNull()
    expect(hasToast('导入失败（mismatch.gemproj）')).toBe(true)
    expect(hasToast('未入库')).toBe(true)
    dispose()
  })

  it('重复导入幂等：同文件两次 → 重名后缀「导入样本 (2)」、两次均成功路由', async () => {
    const dispose = await mountApp()
    importViaInput(diskFile('gemdoc'))
    await waitForImportedProjects(1)
    importViaInput(diskFile('gemdoc'))
    await waitForImportedProjects(2)

    const projects = await importedProjects()
    expect(projects).toHaveLength(2)
    const names = projects.map((n) => n.name).sort()
    expect(names).toEqual(['导入样本', '导入样本 (2)'])
    expect(getToasts().filter((t) => t.message.includes('已导入精修文档'))).toHaveLength(2)
    dispose()
  })
})

// ---------------------------------------------------------------------------
// drop 事件协议
// ---------------------------------------------------------------------------

describe('App 全局导入：窗口级 drop 事件协议', () => {
  it('dragover preventDefault（放行 drop——浏览器默认导航拦截）', async () => {
    const dispose = await mountApp()
    const allowed = window.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }))
    expect(allowed).toBe(false) // preventDefault 已调用
    dispose()
  })

  it('drop 多文件批量导入（gemdoc + gemtpl 一拖）', async () => {
    const dispose = await mountApp()
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [diskFile('gemdoc'), diskFile('gemtpl')] } })
    window.dispatchEvent(drop)
    // 两文件顺序异步落库——有界轮询（固定 sleep 在并行负载下偶发漏第二文件，渗入下测）
    const kinds = (await waitForImportedProjects(2)).map((n) => n.projectKind).sort()
    expect(kinds).toEqual(['gemdoc', 'gemtpl'])
    // 路由取最后一个完成的文件（顺序处理：gemdoc → edit，gemtpl → lab）
    expect(getView()).toBe('lab')
    expect(['gemdoc', 'gemtpl']).toContain(peekOpenIntent()?.kind ?? '')
    dispose()
  })

  it('drop 无 dataTransfer（防御）→ 无异常零动作', async () => {
    const dispose = await mountApp()
    window.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    await flush()
    expect((await importedProjects())).toHaveLength(0)
    expect(getView()).toBe('assets')
    dispose()
  })
})
