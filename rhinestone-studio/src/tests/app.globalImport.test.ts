/*
 * [add-project-files 2.7 Test] App 层全局导入（file input + 窗口级 drop）四格式路由：
 * - 识别：扩展名 / vendor MIME 双识别（沿 PROJECT_MIME 唯一真源；.gemshape 不在本面）；
 * - 路由：gemproj → 排钻工作台（openIntent 消费归 studio 打开链路）/ gemdoc → 设计师工作台 /
 *   gemtpl·gemgen → 实验室（4.6 意图通道）——openProjectNode canonical 语义对齐（素材库 1.4）；
 * - 失败三段式 toast（不支持类型 / 内容与类型不符未入库）；重复导入幂等（ingest 重名后缀）；
 * - drop：dragover preventDefault（放行 drop）+ dataTransfer.files 消费。
 * 意图断言 phase 无关（消费方 claim/ack 异步进行中不影响路由事实）。
 * [add-backend-platform W3.3 ④ 双模式冻结断言] 每格式两段：无旗标=存资源+可下载
 * （getAssetBlob 读回）+不导航（留 Agent 主面+零意图）+「已存入」toast；开旗标=导航如旧。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from '../App.svelte'
import { getView, resetViewForTests } from '$lib/stores/view.svelte'
import { resetDevFlagForTests } from '$lib/stores/devFlag.svelte'
import { peekOpenIntent, resetOpenIntentForTests } from '$lib/stores/openIntent.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import { resetGalleryForTests } from '$lib/stores/gallery.svelte'
import { resetEditForTests } from '$lib/stores/edit.svelte'
import {
  getProject,
  listChildNodes,
  resetAssetStoreForTests,
  SYS_PROJECTS_FOLDER_ID,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import type { AssetProject } from '$lib/persistence/projectTypes'
import { parseGemproj, serializeGemdoc, serializeGemproj } from '$lib/persistence/projectFile'
import { serializeGemgen, serializeGemtpl } from '$lib/persistence/labFile'
import { installFakeIndexedDB, type FakeIndexedDB } from './lab/helpers/fakeIndexedDB'
import { MockAgentApi } from '$lib/agentApi/mock'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'

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
  resetDevFlagForTests(true) // 失败分支/幂等/drop 协议沿用旧口径（旗标开）；双模式路由测试内自行切换
  resetViewForTests('assets')
  resetAgentStoreForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
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

/** 与 App.svelte IMPORT_KIND_LABEL 同词表（toast 断言用——组件内常量未导出）。 */
const IMPORT_KIND_LABEL: Record<Exclude<ImportKind, 'gemshape'>, string> = {
  gemproj: '排钻工程',
  gemdoc: '精修文档',
  gemtpl: '提示词模板',
  gemgen: '生成档案',
}

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

/** 项目节点内容读回（可下载面）：node.blobKey → images store blob。 */
async function getProjectBlob(projectId: string): Promise<Blob | null> {
  const node = await getProject(projectId)
  if (node === null || node.blobKey === undefined) return null
  return getImageBlob(node.blobKey).catch(() => null)
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

describe('App 全局导入：四格式路由（input + drop）——W3.3 ④ 双模式冻结断言', () => {
  /**
   * 双模式走查（每格式两段）：
   * ①无旗标：ingest 落库（存资源）+ getAssetBlob 读回（可下载）+ 不导航（留 Agent
   *   主面）+ 零意图 +「已存入」toast；
   * ②开旗标：第二份同格式文件导入 → 导航如旧（openIntent 置意图切页）+「已导入」toast。
   */
  async function dualModeWalk(
    kind: ImportKind,
    importFirst: (file: File) => void,
    importSecond: (file: File) => void,
    flagOnView: string,
  ): Promise<void> {
    const dispose = await mountApp()

    // ① 无旗标：存资源+可下载+不导航。
    resetDevFlagForTests(false)
    resetViewForTests('agent')
    importFirst(diskFile(kind))
    const [node] = await waitForImportedProjects(1)
    expect(node?.projectKind).toBe(kind)
    expect(getView()).toBe('agent')
    expect(peekOpenIntent()).toBeNull()
    expect(hasToast(`已存入${IMPORT_KIND_LABEL[kind]}`)).toBe(true)
    const readback = await getProjectBlob(node!.id)
    expect(readback).not.toBeNull()
    expect(readback!.size).toBeGreaterThan(0)
    if (kind === 'gemproj') {
      // 语义读回：文件内 name 字段原样可解析（可下载=内容零丢失）。
      const parsed = parseGemproj(await readback!.text())
      expect(parsed.name).toBe('工程导入')
      expect(parsed.layers[0]?.strategy).toBe('poisson')
    }

    // ② 开旗标：第二份同格式 → 导航如旧。
    resetDevFlagForTests(true)
    importSecond(diskFile(kind))
    await waitForImportedProjects(2)
    expect(getView()).toBe(flagOnView)
    // 意图通道：gemproj/gemdoc 消费方为占位骨架不 claim——断言严格；gemtpl/gemgen 由
    // LabView 异步 claim（原注释「phase 无关」竞态在此放大：旗标重挂载加速 claim），
    // 导航事实已由 view+toast 断言承载，此处不重复制造竞态。
    if (kind === 'gemproj' || kind === 'gemdoc') {
      expect(peekOpenIntent()?.kind).toBe(kind)
    }
    expect(hasToast(`已导入${IMPORT_KIND_LABEL[kind]}`)).toBe(true)
    dispose()
  }

  it('gemproj（input）→ 无旗标存资源可下载；开旗标 ingest+openIntent+切排钻工作台', async () => {
    await dualModeWalk('gemproj', importViaInput, importViaInput, 'studio')
  })

  it('gemdoc（drop）→ 无旗标留 Agent；开旗标切设计师工作台 + openIntent', async () => {
    await dualModeWalk('gemdoc', dropOnWindow, dropOnWindow, 'edit')
  })

  it('gemtpl（input）→ 无旗标留 Agent；开旗标切实验室（4.6 意图通道）', async () => {
    await dualModeWalk('gemtpl', importViaInput, importViaInput, 'lab')
  })

  it('gemgen（drop）→ 无旗标留 Agent；开旗标切实验室（4.6 意图通道）', async () => {
    await dualModeWalk('gemgen', dropOnWindow, dropOnWindow, 'lab')
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
