/*
 * [add-project-files 4.6] 双击定位-展开动线全链（design §7.3/§9.2 B3 + 补充稿 §B.2.4 七步 / §C.4）：
 * - App 通道：四 kind 单通道分流切视图（gemtpl/gemgen → lab；gemproj 占位 → studio；
 *   gemdoc → edit）；App 只 peek 不清意图（gemproj 留 pending 给 2.x；gemdoc 自 3.x 起
 *   由 EditView 在 edit 视图下 claim 消费——本文件断言其失败分支，全分支归 edit/editUnbound）
 * - 五时序：未挂载（意图先置 → App 切视图 → LabView 挂载消费）/ 已在实验室 / 解析失败
 *   （AssetsView 拦截：零意图零切视图）/ 模板缺失（过滤回落全部 + 单次 toast + 仍定位展开）/
 *   刷新重入（内存丢弃 = 置意图后重置 store 意图为空）
 * - gemtpl 动线：左面板选中 + chips 过滤 + ackSuccess（无定位段）；模板不在列表 → ackFailure
 * - gemgen 动线：过滤 → tick → scrollIntoView({behavior:'smooth',block:'center'})（jsdom 断言
 *   调用与参数）→ 目标组折叠先展开 → 展开集合 + 高亮类 → 仅高亮挂载后 ackSuccess
 * - 失败分支矩阵（B7）：条目缺失 / 目标 DOM 不存在 / scrollIntoView 抛错 / 组件卸载 →
 *   均 ackFailure 留 failed 态 + 留当前视图 + 单次 toast
 * - 并发：两 LabView 编排者竞争一胜（0.7 原子 claim 的编排层验证）
 * - AssetsView gemgen 卡：双击 parse 先行（成功置意图切视图 / 失败三段式 toast 零意图）；
 *   悬停浮层 [在实验室查看]；移动端单击 = 打开
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from '../../App.svelte'
import LabView from '$lib/components/views/LabView.svelte'
import AssetsView from '$lib/components/views/AssetsView.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { resetDevFlagForTests } from '$lib/stores/devFlag.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { hydrate, resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import {
  getSelectedTemplateAssetId,
  getTemplateAssetIds,
  isTemplatesReady,
} from '$lib/stores/templates.svelte'
import {
  findEntryByAssetId,
  getGalleryFilter,
  isEntryExpanded,
  isRunCollapsed,
  resetGalleryForTests,
  toggleRunCollapsed,
  GALLERY_FILTER_ALL,
} from '$lib/stores/gallery.svelte'
import {
  peekOpenIntent,
  resetOpenIntentForTests,
  setOpenIntent,
} from '$lib/stores/openIntent.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import * as library from '$lib/assets/library.svelte'
import {
  createFolder,
  ingestProjectAsset,
  moveAsset,
  resetAssetStoreForTests,
  trashAsset,
} from '$lib/persistence/assetStore'
import { serializeGemgen } from '$lib/persistence/labFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

const B64 = 'aGVsbG8=' // "hello"
const DATA_URL = `data:image/png;base64,${B64}`

let fake: FakeIndexedDB
let objectUrlCounter = 0
/** jsdom 无 scrollIntoView 实现：全局桩（断言调用与参数而非真滚动）。 */
const scrollIntoViewMock = vi.fn<(...args: unknown[]) => void>()

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
  resetLabForTests() // cancelAll 会持久化上一测试的内存任务——先复位再清，防 hydrate 捞回陈旧任务
  resetGalleryForTests()
  resetOpenIntentForTests()
  // [add-backend-platform W3.3 ②] 旧动线 UI-only 测试默认照跑：测试内显式开旗标
  resetDevFlagForTests(true)
  resetAgentStoreForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
  resetToastsForTests()
  library.resetLibraryForTests()
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
      })
    }),
  )
  scrollIntoViewMock.mockReset()
  scrollIntoViewMock.mockImplementation(() => undefined)
  Element.prototype.scrollIntoView = scrollIntoViewMock
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  // 泄漏兜底：bits-ui Tabs 恒挂载全部视图，断言失败漏卸载的 App/LabView 的 $effect 会
  // 跨测试存活（body 清空只摘 DOM 不毁 effect），其 LabView 在后续测试切到 lab 视图时
  // 抢 claim 意图并以 gallery-dom-missing 失败——曾致 1 例断言失败级联 3 例假失败。
  for (const dispose of mountedApps) dispose()
  mountedApps.clear()
  vi.unstubAllGlobals()
  localStorage.clear()
  // bits-ui Dialog/portal 卸载的 jsdom 残留：清 body 防跨测试查询污染
  document.body.innerHTML = ''
})

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

type Mountable = typeof App | typeof LabView | typeof AssetsView

/** mountTo 挂载未回收注册表：断言失败时测试体尾部的 unmountView 不会执行。 */
const mountedApps = new Set<() => void>()

function mountTo(component: Mountable): { target: HTMLElement; unmountView: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(component, { target })
  const dispose = (): void => {
    unmount(app)
    target.remove()
  }
  mountedApps.add(dispose)
  return {
    target,
    unmountView: () => {
      mountedApps.delete(dispose)
      dispose()
    },
  }
}

interface SeedGemgenOptions {
  templateAssetId?: string
  templateName: string
  runId: string
  candidateIndex?: number
  corrupt?: boolean
  /** 缺省 = sys-generated 批次夹；给出 = 落入该目录（AssetsView 用例经用户文件夹直达）。 */
  parentId?: string
}

/** 直接落一颗 gemgen 档案节点（返回节点 id）。 */
async function seedGemgenDirect(options: SeedGemgenOptions): Promise<string> {
  let parentId = options.parentId
  if (parentId === undefined) {
    const folder = await createFolder(null, '09-18 10:00 · 1 张')
    parentId = (await moveAsset(folder.id, 'sys-generated')).id
  }  const createdAt = 1_700_000_000_000
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
    summary: { templateName: options.templateName, candidateIndex, size: '1024x1024', mode: 'generate' },
  })
  return ingested.node.id
}

/** hydrate 完成后取目标模板 id（优先非首项：区分「选中发生」与「默认首项」）。 */
async function templateIdForFlow(): Promise<string> {
  await hydrate()
  await waitFor(() => isTemplatesReady() && getTemplateAssetIds().length > 0)
  const ids = getTemplateAssetIds()
  return ids.length > 1 ? ids[1] : ids[0]
}

function click(selector: string): void {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`click 目标不存在：${selector}`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function dblclick(selector: string): void {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`dblclick 目标不存在：${selector}`)
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
}

/** 画廊卡滚动调用（区别于模板列表滚动的 block:'nearest'）。 */
function cardScrollCalls(): unknown[][] {
  return scrollIntoViewMock.mock.calls.filter(
    (call) => (call[0] as { block?: string } | undefined)?.block === 'center',
  )
}

// ---------------------------------------------------------------------------
// App 通道：四 kind 单通道分流切视图（占位说明：gemproj/gemdoc 只切视图不加载项目）
// ---------------------------------------------------------------------------

describe('App 通道四 kind 分流（peek 只读切视图，不 claim 不清意图）', () => {
  it('gemproj 意图 → 切排钻工作台；StudioView（Tabs 恒挂载）过可见性门 claim 消费——失败分支（项目不存在）留 failed', async () => {
    setView('assets')
    const { unmountView } = mountTo(App)
    await flush()
    expect(getView()).toBe('assets')

    setOpenIntent({ kind: 'gemproj', assetId: 'ast-proj-1' })
    await waitFor(() => getView() === 'studio')
    // [studio-layers 2.8 已落地] StudioView 随 Tabs 恒挂载，切到 studio 即过可见性门 claim
    // 并消费（gemproj 才 claim——gemgen/gemtpl/gemdoc 不偷）。沿占位假 id 断言失败分支
    // 全链闭环：openStudioProject 节点不存在 → ackFailure 留 failed（成功路径 round-trip
    // 归 tests/studio/projectPersistence.test.ts）
    await waitFor(() => peekOpenIntent()?.phase === 'failed')
    const snapshot = peekOpenIntent()
    expect(snapshot).toMatchObject({ phase: 'failed', kind: 'gemproj', assetId: 'ast-proj-1' })
    expect(snapshot?.reason).toContain('gemproj-open-failed:ast-proj-1')

    unmountView()
    setView('lab')
  })

  it('gemdoc 意图 → 切设计师工作台；EditView（Tabs 恒挂载）过可见性门 claim 消费——失败分支（档案不存在）留 failed + 单次 toast', async () => {
    setView('assets')
    const { unmountView } = mountTo(App)
    await flush()

    setOpenIntent({ kind: 'gemdoc', assetId: 'ast-doc-1' })
    await waitFor(() => getView() === 'edit') // App 只 peek 切视图（gemdoc → edit）
    // [3.x 已落地] EditView 随 bits-ui Tabs 恒挂载，切到 edit 即过可见性门 claim 并消费
    //（成功 ackSuccess / dirty 守卫分支的直挂断言归 edit/editUnbound；此处沿占位假 id
    // 断言 App 通道 → EditView 失败分支的全链闭环：loadFromGemdoc 抛错 → ackFailure）
    await waitFor(() => peekOpenIntent()?.phase === 'failed')
    const snapshot = peekOpenIntent()
    expect(snapshot).toMatchObject({ phase: 'failed', kind: 'gemdoc', assetId: 'ast-doc-1' })
    expect(snapshot?.reason).toBe('gemdoc-open-failed:ast-doc-1') // 可诊断（含目标 id）
    expect(snapshot?.token).not.toBeNull() // failed 态不清 token（与 gemgen 失败分支同口径）
    expect(getToasts().filter((t) => t.message.includes('打开精修项目失败'))).toHaveLength(1)
    expect(getView()).toBe('edit') // 留在编辑页（失败不回退视图）

    unmountView()
    setView('lab')
  })
})

// ---------------------------------------------------------------------------
// 五时序 + gemgen 七步（B.2.4 全链）
// ---------------------------------------------------------------------------

describe('gemgen 定位-展开动线（七步）', () => {
  it('时序① 未挂载：意图先置 → App 切实验室 → LabView 挂载消费全链（过滤/滚动/展开/高亮/清意图）', async () => {
    const tplId = await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({ templateAssetId: tplId, templateName: 'A', runId: 'run-x' })
    toggleRunCollapsed('run-x') // 预折叠目标组：验证「目标组折叠先展开」

    setView('assets')
    const { unmountView } = mountTo(App)
    await flush()
    expect(getView()).toBe('assets')

    setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
    await waitFor(() => getView() === 'lab') // App 只 peek 切视图
    await waitFor(() => peekOpenIntent() === null) // LabView 挂载后 claim → 七步 → ackSuccess

    // 步骤 3/4：左面板选中 + chips 过滤
    expect(getSelectedTemplateAssetId()).toBe(tplId)
    expect(getGalleryFilter()).toBe(tplId)
    // 步骤 5：目标组先展开（不动其他组）+ scrollIntoView(smooth/center)
    expect(isRunCollapsed('run-x')).toBe(false)
    expect(cardScrollCalls()).toHaveLength(1)
    expect(cardScrollCalls()[0]).toEqual([{ behavior: 'smooth', block: 'center' }])
    // 步骤 6：加入展开集合 + 高亮 pulse 挂载（2s 后撤，测试内即时存在）
    expect(findEntryByAssetId(gemgenId)).toBeDefined()
    expect(isEntryExpanded(`asset:${gemgenId}`)).toBe(true)
    const card = document.querySelector(`[data-testid="gallery-entry"][data-entry-key="asset:${gemgenId}"]`)
    expect(card).not.toBeNull()
    expect(card!.classList.contains('gallery-locate-pulse')).toBe(true)
    // 步骤 7：意图已清（仅展开且高亮挂载后才 ack）
    expect(peekOpenIntent()).toBeNull()

    unmountView()
    setView('lab')
  })

  it('时序② 已在实验室：直接响应（不重挂载）；tick 后卡片展开 DOM 真实挂载', async () => {
    const tplId = await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({ templateAssetId: tplId, templateName: 'A', runId: 'run-y' })
    const { unmountView } = mountTo(LabView)
    await flush()
    expect(isTemplatesReady()).toBe(true)

    setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
    await waitFor(() => peekOpenIntent() === null)

    expect(getGalleryFilter()).toBe(tplId)
    expect(isEntryExpanded(`asset:${gemgenId}`)).toBe(true)
    const card = document.querySelector(`[data-entry-key="asset:${gemgenId}"]`)
    expect(card).not.toBeNull()
    // 展开态 DOM 挂载（tick 后重建）：entry-expanded 区块在卡内
    expect(card!.querySelector('[data-testid="entry-expanded"]')).not.toBeNull()
    expect(cardScrollCalls()).toHaveLength(1)

    unmountView()
  })

  it('时序④ 模板缺失：过滤回落「全部」+ 单次 toast + 左面板不动 + 仍定位展开 + ackSuccess', async () => {
    await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({
      templateAssetId: 'ast-tpl-gone',
      templateName: '孤儿模板',
      runId: 'run-orphan',
    })
    const { unmountView } = mountTo(LabView)
    await flush()

    setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
    await waitFor(() => peekOpenIntent() === null)

    expect(getGalleryFilter()).toBe(GALLERY_FILTER_ALL)
    expect(getSelectedTemplateAssetId()).not.toBe('ast-tpl-gone') // 左面板不动（§B.2.4 步骤 3）
    // 单次 toast（去重守卫：整条动线只此一条）
    const orphanToasts = getToasts().filter((t) => t.message.includes('模板已删除'))
    expect(orphanToasts).toHaveLength(1)
    expect(orphanToasts[0].message).toContain('已定位到结果')
    // 仍定位展开 + ackSuccess
    expect(isEntryExpanded(`asset:${gemgenId}`)).toBe(true)
    expect(cardScrollCalls()).toHaveLength(1)
    expect(peekOpenIntent()).toBeNull()

    unmountView()
  })

  it('时序⑤ 刷新重入：内存意图丢弃——置意图后重置 store（刷新等价物）意图为空，重挂 LabView 零消费', async () => {
    const tplId = await templateIdForFlow()
    setOpenIntent({ kind: 'gemtpl', assetId: tplId })
    expect(peekOpenIntent()).not.toBeNull()

    resetOpenIntentForTests() // 刷新 = 纯内存 $state 丢弃（design §9.2 B3 明文；不持久化）
    expect(peekOpenIntent()).toBeNull()

    const { unmountView } = mountTo(LabView)
    await flush(80)
    expect(peekOpenIntent()).toBeNull() // 重挂载不重放已丢弃的意图
    expect(getGalleryFilter()).toBe(GALLERY_FILTER_ALL)
    expect(getToasts()).toHaveLength(0)

    unmountView()
  })
})

// ---------------------------------------------------------------------------
// gemtpl 动线（同链去 2/5/6：选中 + 过滤 + ackSuccess）
// ---------------------------------------------------------------------------

describe('gemtpl 动线', () => {
  it('左面板选中 + chips 过滤 + ackSuccess（无定位段：不滚动画廊卡）', async () => {
    const tplId = await templateIdForFlow()
    const { unmountView } = mountTo(LabView)
    await flush()

    setOpenIntent({ kind: 'gemtpl', assetId: tplId })
    await waitFor(() => peekOpenIntent() === null)

    expect(getSelectedTemplateAssetId()).toBe(tplId)
    expect(getGalleryFilter()).toBe(tplId)
    expect(cardScrollCalls()).toHaveLength(0) // 无定位段（B.2.4：同链去掉 5/6）
    expect(getToasts()).toHaveLength(0)

    unmountView()
  })

  it('模板已删/移出列表 → ackFailure 留 failed 态 + 单次 toast + 不动过滤', async () => {
    await templateIdForFlow()
    const { unmountView } = mountTo(LabView)
    await flush()

    setOpenIntent({ kind: 'gemtpl', assetId: 'ast-tpl-deleted' })
    await waitFor(() => peekOpenIntent()?.phase === 'failed')

    const snapshot = peekOpenIntent()
    expect(snapshot).toMatchObject({ phase: 'failed', kind: 'gemtpl', assetId: 'ast-tpl-deleted' })
    expect(snapshot?.reason).toContain('ast-tpl-deleted') // 可诊断
    const toasts = getToasts().filter((t) => t.message.includes('无法在实验室使用'))
    expect(toasts).toHaveLength(1) // 单次
    expect(getGalleryFilter()).toBe(GALLERY_FILTER_ALL) // 不动

    unmountView()
  })
})

// ---------------------------------------------------------------------------
// 失败分支矩阵（B7：不清 token + 留当前视图 + 单次提示）
// ---------------------------------------------------------------------------

describe('gemgen 失败分支矩阵', () => {
  it('条目缺失（目标已入回收站）→ ackFailure + failed 态 + 单次 toast + 留实验室', async () => {
    const tplId = await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({ templateAssetId: tplId, templateName: 'A', runId: 'run-z' })
    await trashAsset(gemgenId)
    const { unmountView } = mountTo(LabView)
    await flush()

    setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
    await waitFor(() => peekOpenIntent()?.phase === 'failed')

    expect(peekOpenIntent()?.reason).toContain('gallery-entry-missing')
    expect(getToasts().filter((t) => t.message.includes('未能定位该生成结果'))).toHaveLength(1)
    expect(getView()).toBe('lab') // 留当前视图

    unmountView()
  })

  it('目标 DOM 不存在（实验室挂载在文档外）→ ackFailure 留 failed 态 + 单次 toast', async () => {
    const tplId = await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({ templateAssetId: tplId, templateName: 'A', runId: 'run-d' })
    // 挂载到未接入 document 的容器：TaskQueue 正常渲染但 document.querySelector 找不到卡
    const target = document.createElement('div')
    const app = mount(LabView, { target })
    try {
      await flush()

      setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
      await waitFor(() => peekOpenIntent()?.phase === 'failed')

      expect(peekOpenIntent()?.reason).toContain('gallery-dom-missing')
      expect(getToasts().filter((t) => t.message.includes('画廊尚未渲染完成'))).toHaveLength(1)
    } finally {
      unmount(app)
      target.remove()
    }
  })

  it('scrollIntoView 抛错 → ackFailure 留 failed 态 + 单次 toast（不静默吞定位失败）', async () => {
    const tplId = await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({ templateAssetId: tplId, templateName: 'A', runId: 'run-s' })
    const { unmountView } = mountTo(LabView)
    await flush()

    // 持续桩（mockImplementationOnce 会被模板列表滚动 block:'nearest' 消耗）：只让画廊卡
    // 滚动（block:'center'）抛错；beforeEach 统一复位
    scrollIntoViewMock.mockImplementation((...args: unknown[]) => {
      if ((args[0] as { block?: string } | undefined)?.block === 'center') {
        throw new Error('no-scroll')
      }
      return undefined
    })
    setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
    await waitFor(() => peekOpenIntent()?.phase === 'failed')

    expect(peekOpenIntent()?.reason).toContain('scroll-failed')
    expect(getToasts().filter((t) => t.message.includes('定位滚动失败'))).toHaveLength(1)
    // 失败不清 token：failed 态可诊断、不可再 claim
    expect(peekOpenIntent()?.token).not.toBeNull()

    unmountView()
  })

  it('组件卸载（动线在途时切走视图）→ ackFailure 留 failed 态 + 单次 toast', async () => {
    const tplId = await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({ templateAssetId: tplId, templateName: 'A', runId: 'run-u' })
    const { unmountView } = mountTo(LabView)
    await flush()

    setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
    await tick() // effect 已 claim，动线在 refreshGallery 的 await 处挂起
    unmountView() // 卸载中断
    await flush(80)

    expect(peekOpenIntent()?.phase).toBe('failed')
    expect(peekOpenIntent()?.reason).toBe('lab-view-unmounted')
    expect(getToasts().filter((t) => t.message.includes('定位已中断'))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 并发纪律（0.7 原子 claim 的编排层验证）
// ---------------------------------------------------------------------------

describe('并发：两编排者竞争一胜', () => {
  it('两个 LabView 同时挂载，同一意图只被消费一次（单次滚动/单次高亮/单次 ack）', async () => {
    const tplId = await templateIdForFlow()
    const gemgenId = await seedGemgenDirect({ templateAssetId: tplId, templateName: 'A', runId: 'run-c' })
    const a = mountTo(LabView)
    const b = mountTo(LabView)
    await flush()

    setOpenIntent({ kind: 'gemgen', assetId: gemgenId })
    await waitFor(() => peekOpenIntent() === null)

    // 两份 TaskQueue DOM 并存（同 store 投影），但画廊卡滚动只发生一次
    expect(cardScrollCalls()).toHaveLength(1)
    // 命令式高亮只挂在一个卡上（claim 胜者的编排单次执行）
    expect(document.querySelectorAll('.gallery-locate-pulse')).toHaveLength(1)
    expect(getToasts()).toHaveLength(0) // 败者 claim 得 null 直接退出，不 toast

    a.unmountView()
    b.unmountView()
  })
})

// ---------------------------------------------------------------------------
// AssetsView gemgen 卡：双击 parse 先行（C.4：解析先于切视图，失败不离开素材库）
// ---------------------------------------------------------------------------

describe('AssetsView gemgen 卡（parse 先行）', () => {
  async function mountAssets(): Promise<() => void> {
    await library.ensureLibraryReady()
    await library.refresh()
    const { unmountView } = mountTo(AssetsView)
    await flush()
    return unmountView
  }

  /** 落一颗 gemgen 到用户文件夹并导航到位（ingestProjectAsset 的 parentId:null 会落
   * sys-projects——不在素材树入口列表，故经用户文件夹保证卡面在默认视图两击内可达）。 */
  async function seedInUserFolder(
    options: Omit<SeedGemgenOptions, 'parentId'>,
  ): Promise<{ gemgenId: string; unmountAssets: () => void }> {
    const folder = await createFolder(null, '结果夹')
    const gemgenId = await seedGemgenDirect({ ...options, parentId: folder.id })
    const unmountAssets = await mountAssets()
    setView('assets')
    click(`[data-testid="asset-item-${folder.id}"]`) // 进入文件夹（itemClick：folder → navigate）
    await flush()
    return { gemgenId, unmountAssets }
  }

  it('双击有效档案 → parse 成功 → 置意图 + 切实验室；LabView 未挂载不消费', async () => {
    const tplId = await templateIdForFlow()
    const { gemgenId, unmountAssets } = await seedInUserFolder({
      templateAssetId: tplId,
      templateName: 'A',
      runId: 'run-av',
    })

    dblclick(`[data-testid="asset-item-${gemgenId}"]`)
    await flush(60)

    expect(peekOpenIntent()).toMatchObject({ phase: 'pending', kind: 'gemgen', assetId: gemgenId })
    expect(getView()).toBe('lab') // 切视图在 parse 成功之后
    expect(getToasts()).toHaveLength(0)

    unmountAssets()
    setView('lab')
  })

  it('双击损坏档案 → 三段式 toast + 零意图 + 零切视图（解析失败在素材库侧拦截）', async () => {
    const tplId = await templateIdForFlow()
    const { gemgenId, unmountAssets } = await seedInUserFolder({
      templateAssetId: tplId,
      templateName: '坏档',
      runId: 'run-bad',
      corrupt: true,
    })

    dblclick(`[data-testid="asset-item-${gemgenId}"]`)
    await flush(60)

    expect(peekOpenIntent()).toBeNull() // 零意图
    expect(getView()).toBe('assets') // 零切视图（失败不离开素材库）
    const toasts = getToasts().filter((t) => t.message.includes('无法打开生成结果'))
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toContain('坏档') // 失败事实（哪个档案）
    expect(toasts[0].message).toContain('已留在素材库') // 恢复动作段

    unmountAssets()
    setView('lab')
  })

  it('悬停浮层 [在实验室查看] = 同一 canonical handler（点击置意图切实验室）', async () => {
    const tplId = await templateIdForFlow()
    const { gemgenId, unmountAssets } = await seedInUserFolder({
      templateAssetId: tplId,
      templateName: 'A',
      runId: 'run-ov',
    })

    click(`[data-testid="gemgen-use-${gemgenId}"]`)
    await flush(60)

    expect(peekOpenIntent()).toMatchObject({ kind: 'gemgen', assetId: gemgenId })
    expect(getView()).toBe('lab')

    unmountAssets()
    setView('lab')
  })

  it('移动端单击卡面 = 打开（pointerType touch → click 触发同一动线）', async () => {
    const tplId = await templateIdForFlow()
    const { gemgenId, unmountAssets } = await seedInUserFolder({
      templateAssetId: tplId,
      templateName: 'A',
      runId: 'run-mb',
    })

    const card = document.querySelector(`[data-testid="asset-item-${gemgenId}"]`)!
    const pointerdown = new MouseEvent('pointerdown', { bubbles: true })
    Object.defineProperty(pointerdown, 'pointerType', { value: 'touch' })
    card.dispatchEvent(pointerdown)
    card.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush(60)

    expect(peekOpenIntent()).toMatchObject({ kind: 'gemgen', assetId: gemgenId })
    expect(getView()).toBe('lab')

    unmountAssets()
    setView('lab')
  })
})
