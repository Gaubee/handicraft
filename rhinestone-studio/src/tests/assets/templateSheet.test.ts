/**
 * 4.3b——素材库 RightSheet 第二宿主 + gemtpl 卡片两动作
 * （openspec add-project-files design §9.3 E4/B4；补充稿 §C.5 全节）。
 *
 * 覆盖：
 * - TemplateEditSheet：打开渲染 TemplateEditor（同 record）/ 三入口（overlay/Escape/完成）
 *   统一走关闭守卫 / flush 成功关闭 / flush 失败保持 open + 三选 Dialog 全分支
 *   （重试→成功关；放弃→revert+关；继续编辑→关 Dialog 留 Sheet）/ 编辑中被删终态自动关 /
 *   双宿主同 assetId 实时互见 / EffectRefControl 嵌套 Dialog portal 悬浮于 Sheet 之上
 * - revertTemplateFields（放弃修改的回退实现）：回退快照、磁盘不动、排队写空转
 * - AssetsView gemtpl 卡片两动作（C.5.1 入口矩阵）：双击=去使用（intent+切视图）/
 *   悬停浮层两按钮 / 移动端单击=去使用 / 选中态 [打开] / ✎ 去编辑 / 图片节点无浮层
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

// updateProjectAsset 门控 mock：透传真实实现 + 计数（revert「磁盘不动」的观测面）
const { updateGate } = vi.hoisted(() => ({
  updateGate: {
    deferred: null as Promise<void> | null,
    calls: 0,
    blobs: [] as string[],
  },
}))

vi.mock('$lib/persistence/assetStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/persistence/assetStore')>()
  const originalUpdate = actual.updateProjectAsset
  return {
    ...actual,
    updateProjectAsset: async (
      projectId: string,
      options: Parameters<typeof originalUpdate>[1],
    ): Promise<ReturnType<typeof originalUpdate>> => {
      updateGate.calls += 1
      updateGate.blobs.push(await options.bytes.text())
      const run = () => originalUpdate(projectId, options)
      return updateGate.deferred ? updateGate.deferred.then(run) : run()
    },
  }
})

import AssetsView from '$lib/components/views/AssetsView.svelte'
import TemplateEditSheet from '../../components/Assets/TemplateEditSheet.svelte'
import TemplateEditor from '../../components/Lab/TemplateEditor.svelte'
import * as library from '$lib/assets/library.svelte'
import {
  getProject,
  ingestAsset,
  resetAssetStoreForTests,
} from '$lib/persistence/assetStore'
import type { AssetProject } from '$lib/persistence/projectTypes'
import { getImageBlob } from '$lib/persistence/imageStore'
import { parseGemtpl, type GemtplFile } from '$lib/persistence/labFile'
import { hydrate, resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import {
  createTemplate,
  getTemplateAssetIds,
  getTemplatePersistedSnapshot,
  getTemplateRecord,
  removeTemplate,
  resetTemplatesForTests,
  revertTemplateFields,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import {
  closeTemplateSheet,
  getTemplateSheetAssetId,
  openTemplateSheet,
  resetTemplateSheetForTests,
} from '$lib/stores/templateSheet.svelte'
import { peekOpenIntent, resetOpenIntentForTests } from '$lib/stores/openIntent.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

const B64 = 'aGVsbG8='

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** hydrate 种子默认桩：/presets/ 静态图（每 URL 唯一字节防内容寻址并辙）。 */
function stubSeedFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/presets/')) {
      const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (u.endsWith('/images/generations') || u.endsWith('/images/edits')) return okResponse()
    return new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  })
}

let fake: FakeIndexedDB
let objectUrlCounter = 0
const unmounts: Array<() => void> = []

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  library.resetLibraryForTests()
  resetLabForTests()
  resetTemplatesForTests()
  resetTemplateSheetForTests()
  resetOpenIntentForTests()
  resetToastsForTests()
  setView('assets')
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:sheet-${(objectUrlCounter += 1)}`),
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
  vi.stubGlobal('fetch', stubSeedFetch())
  updateGate.deferred = null
  updateGate.calls = 0
  updateGate.blobs = []
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(async () => {
  for (const fn of unmounts.splice(0)) fn()
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, timeoutMs = 3000, context = ''): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时${context ? `（${context}）` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function click(selector: string | Element): void {
  const el = typeof selector === 'string' ? q(selector) : selector
  expect(el, `${typeof selector === 'string' ? selector : '元素'} 应存在`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function pointerdown(el: Element, pointerType = 'touch'): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType }))
}

/** overlay 关闭入口的合成 pointerdown：jsdom 的 getBoundingClientRect 恒零矩形，
 *  bits-ui isClickTrulyOutside 要求事件坐标真在矩形外——给非零坐标。 */
function outsidePointerdown(): void {
  const overlay = q('[data-slot="sheet-overlay"]')
  expect(overlay, 'sheet overlay 应存在').not.toBeNull()
  overlay!.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      clientX: 700,
      clientY: 300,
    }),
  )
}

function escapeKey(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

async function readTemplateFile(assetId: string): Promise<GemtplFile> {
  const node = await getProject(assetId)
  expect(node, `节点 ${assetId} 应存在`).not.toBeNull()
  const blob = await getImageBlob((node as AssetProject).blobKey)
  expect(blob).not.toBeNull()
  return parseGemtpl(await (blob as Blob).text())
}

function sheetEl(): Element | null {
  return q('[data-testid="template-edit-sheet"]')
}

function promptTextarea(): HTMLTextAreaElement | null {
  return q('[data-testid="template-prompt-textarea"]') as HTMLTextAreaElement | null
}

/** 挂载 RightSheet 单例组件（生产中由 AssetsView 挂载；单宿主测试直挂等价）。 */
async function mountSheet(): Promise<void> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(TemplateEditSheet, { target })
  unmounts.push(() => {
    unmount(app)
    target.remove()
  })
  await flush()
}

async function openSheetOn(assetId: string): Promise<void> {
  openTemplateSheet(assetId)
  await mountSheet()
  await waitFor(() => sheetEl() !== null)
}

/** 在已挂载的 Sheet 单例上重新打开（T2 三入口循环复用同一实例）。 */
async function reopenSheetOn(assetId: string): Promise<void> {
  openTemplateSheet(assetId)
  await waitFor(() => sheetEl() !== null)
}

/** 向 Sheet 的提示词 textarea 写入未提交文本（只改 DOM 值，不派发 change = 未 blur）。 */
function typeUncommitted(text: string): void {
  const area = promptTextarea()
  expect(area, 'Sheet 内提示词 textarea 应存在').not.toBeNull()
  area!.value = text
}

// ---------------------------------------------------------------------------
// TemplateEditSheet（RightSheet 第二宿主 + 关闭状态机）
// ---------------------------------------------------------------------------

describe('TemplateEditSheet：第二宿主与渲染', () => {
  it('打开即渲染 TemplateEditor：同 record 同值；头部「已保存 HH:MM」+ 移动端把手', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    await openSheetOn(id)

    expect(q('[data-testid="template-editor"]')).not.toBeNull()
    const nameInput = q('[data-testid="template-name-input"]') as HTMLInputElement
    expect(nameInput.value).toBe(getTemplateRecord(id)?.name)
    expect(promptTextarea()?.value).toBe(getTemplateRecord(id)?.promptBody)
    expect(q('[data-testid="template-sheet-saved"]')?.textContent).toMatch(/已保存 \d{2}:\d{2}/)
    expect(q('[data-testid="template-sheet-done"]')?.textContent).toContain('完成')
    expect(q('[data-testid="template-sheet-handle"]')).not.toBeNull()

    closeTemplateSheet()
    await flush()
  })

  it('嵌套 EffectRefControl Dialog portal 悬浮于 Sheet 之上：可开，Escape 只关内层不泄漏', async () => {
    await hydrate()
    const id = await createTemplate() // caseBinding=null：案例区走未绑定文案
    expect(id).not.toBeNull()
    await openSheetOn(id as string)

    click('[data-testid="effect-ref-open"]')
    await waitFor(() => q('[data-testid="effect-ref-upload-single"]') !== null)
    expect(q('[data-testid="template-edit-sheet"]')).not.toBeNull() // Sheet 仍开（Dialog 叠于其上）

    escapeKey() // 内层 Dialog 自行关闭；Escape 不下渗 Sheet
    await waitFor(() => q('[data-testid="effect-ref-upload-single"]') === null)
    await flush(80)
    expect(sheetEl()).not.toBeNull() // Sheet 不被内层 Escape 关掉
  })

  it('双宿主同 assetId 互见：Sheet 内提交字段，实验室宿主（直挂 TemplateEditor）实时同值', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]

    // 实验室宿主模拟：直挂 TemplateEditor（VariantEditor 手风琴 Content 的等价消费）
    const labTarget = document.createElement('div')
    document.body.appendChild(labTarget)
    const labHost = mount(TemplateEditor, { target: labTarget, props: { templateAssetId: id } })
    unmounts.push(() => {
      unmount(labHost)
      labTarget.remove()
    })

    await openSheetOn(id)
    const sheetArea = promptTextarea()!
    sheetArea.value = '双宿主互见正文'
    sheetArea.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    const labArea = labTarget.querySelector('[data-testid="template-prompt-textarea"]') as HTMLTextAreaElement
    expect(labArea.value).toBe('双宿主互见正文') // 内存 record 实时互见（不等写盘）
    await whenTemplatesIdle()
    expect((await readTemplateFile(id)).promptBody).toBe('双宿主互见正文') // 换绑落盘
  })
})

describe('TemplateEditSheet：关闭状态机（design §9.3 E4/B4）', () => {
  it('三入口（overlay / Escape / 完成）统一走守卫：未提交文本 flush 落盘后关闭', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    await mountSheet() // 单实例：三入口循环复用（多次 open/close）
    const entries: Array<{ label: string; trigger: () => void }> = [
      { label: '完成按钮', trigger: () => click('[data-testid="template-sheet-done"]') },
      { label: 'Escape', trigger: () => escapeKey() },
      { label: 'overlay 点击', trigger: () => outsidePointerdown() },
    ]

    for (let i = 0; i < entries.length; i += 1) {
      const { label, trigger } = entries[i]
      const text = `守卫落盘-${i}`
      await reopenSheetOn(id)
      typeUncommitted(text) // textarea 有未 blur 文本（§C.5.4 守卫触发面）
      trigger()
      await waitFor(() => sheetEl() === null, 3000, `${label}：Sheet 应关闭`)
      expect(getTemplateSheetAssetId(), `${label}：store 关闭`).toBeNull()
      expect(getTemplateRecord(id)?.promptBody, `${label}：record 已提交`).toBe(text)
      await whenTemplatesIdle()
      expect((await readTemplateFile(id)).promptBody, `${label}：落盘`).toBe(text)
    }
  })

  it('flush 失败：保持 open 不丢缓冲载荷；[重试保存] 重放补丁，成功后关闭', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const before = getTemplateRecord(id)?.promptBody ?? ''
    await openSheetOn(id)

    fake.failNext({ store: 'assetNodes', op: 'put' }) // 换绑事务在 node put 处失败回滚
    typeUncommitted('注定失败-可重试')
    click('[data-testid="template-sheet-done"]')
    await waitFor(() => q('[data-testid="template-sheet-rescue"]') !== null)

    // open=true（禁止关闭）+ record 已被失败路径回退到快照 + 三选可见
    expect(sheetEl()).not.toBeNull()
    expect(getTemplateRecord(id)?.promptBody).toBe(before)
    expect(q('[data-testid="rescue-retry"]')).not.toBeNull()
    expect(q('[data-testid="rescue-discard"]')).not.toBeNull()
    expect(q('[data-testid="rescue-continue"]')).not.toBeNull()

    click('[data-testid="rescue-retry"]') // 重试：重放失败补丁（IDB 已恢复）
    await waitFor(() => sheetEl() === null)
    expect((await readTemplateFile(id)).promptBody).toBe('注定失败-可重试') // 缓冲载荷未丢
    expect(getTemplateRecord(id)?.lastError).toBeNull()
  })

  it('flush 失败：[放弃修改并关闭] = revert 回退快照 + lastError 清 + 磁盘不动', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const before = getTemplateRecord(id)?.promptBody ?? ''
    const fileBefore = await readTemplateFile(id)
    await openSheetOn(id)

    fake.failNext({ store: 'assetNodes', op: 'put' })
    typeUncommitted('注定失败-将放弃')
    click('[data-testid="template-sheet-done"]')
    await waitFor(() => q('[data-testid="template-sheet-rescue"]') !== null)
    expect(getTemplateRecord(id)?.lastError).toBeTruthy()

    click('[data-testid="rescue-discard"]')
    await waitFor(() => sheetEl() === null)
    expect(getTemplateRecord(id)?.promptBody).toBe(before) // 回退快照
    expect(getTemplateRecord(id)?.lastError).toBeNull() // revert 清失败指示
    expect((await readTemplateFile(id)).promptBody).toBe(fileBefore.promptBody) // 磁盘不动
  })

  it('flush 失败：[继续编辑] 关 Dialog 留 Sheet（记录停留在快照态）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const before = getTemplateRecord(id)?.promptBody ?? ''
    await openSheetOn(id)

    fake.failNext({ store: 'assetNodes', op: 'put' })
    typeUncommitted('注定失败-继续编辑')
    click('[data-testid="template-sheet-done"]')
    await waitFor(() => q('[data-testid="template-sheet-rescue"]') !== null)

    click('[data-testid="rescue-continue"]')
    await waitFor(() => q('[data-testid="template-sheet-rescue"]') === null)
    await flush(60)
    expect(sheetEl()).not.toBeNull() // Sheet 留开
    expect(getTemplateRecord(id)?.promptBody).toBe(before)
    expect(promptTextarea()?.value).toBe(before) // 编辑器回显快照（用户接管）
  })

  it('编辑中模板被删（另一入口软删）：「模板已删除」终态 + 自动关闭', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    await openSheetOn(id)
    expect(q('[data-testid="template-editor"]')).not.toBeNull()

    await removeTemplate(id) // 另一入口删除（回收站/模板面板同源 store 熔断）
    await waitFor(() => q('[data-testid="template-sheet-deleted"]') !== null)
    expect(sheetEl()).not.toBeNull() // 终态文案可见窗口
    await waitFor(() => sheetEl() === null, 2500) // 自动关闭（900ms 延迟）
    expect(getTemplateSheetAssetId()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// revertTemplateFields（「放弃修改」的回退实现；时序裁决见 store 注释）
// ---------------------------------------------------------------------------

describe('revertTemplateFields：回退快照，磁盘不动', () => {
  it('record 回退最后成功快照；排队未开始的写空转（revision 对齐 → 不写盘）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]

    submitTemplateField(id, { promptBody: '已落盘正文' })
    await whenTemplatesIdle()
    const callsAfterPersist = updateGate.calls
    expect((await readTemplateFile(id)).promptBody).toBe('已落盘正文')

    // 提交后【同步】回退（写轮次已入队但 runWrite 尚未开始）：
    // revert 把 revision 对齐 writtenRevision → 排队写空转，磁盘不动
    submitTemplateField(id, { promptBody: '未落盘缓冲' })
    expect(getTemplateRecord(id)?.promptBody).toBe('未落盘缓冲')
    expect(revertTemplateFields(id)).toBe(true)
    expect(getTemplateRecord(id)?.promptBody).toBe('已落盘正文') // record 回退
    expect(getTemplateRecord(id)?.lastError).toBeNull()

    await whenTemplatesIdle()
    expect(updateGate.calls).toBe(callsAfterPersist) // 排队写空转：零新写入
    expect((await readTemplateFile(id)).promptBody).toBe('已落盘正文') // 磁盘不动
  })

  it('快照只读口与无快照保护：拷贝返回；record 不存在 → revert false', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const snap = getTemplatePersistedSnapshot(id)
    expect(snap).toBeDefined()
    expect(snap?.promptBody).toBe(getTemplateRecord(id)?.promptBody)
    // 拷贝语义：改副本不泄漏进内部快照
    const copy = { ...(snap as { promptBody: string }) }
    copy.promptBody = 'tampered'
    expect(getTemplatePersistedSnapshot(id)?.promptBody).not.toBe('tampered')

    expect(revertTemplateFields('ast-not-exist')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AssetsView gemtpl 卡片两动作（C.5.1 入口矩阵）
// ---------------------------------------------------------------------------

describe('AssetsView：gemtpl 卡片两动作', () => {
  async function mountAssetsAtTemplates(): Promise<string> {
    await hydrate()
    await library.ensureLibraryReady()
    await library.refresh()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(AssetsView, { target })
    unmounts.push(() => {
      unmount(app)
      target.remove()
    })
    await flush(40)
    click('[data-testid="tree-sys-sys-templates"]')
    await flush()
    const id = getTemplateAssetIds()[0]
    expect(q(`[data-testid="asset-item-${id}"]`), 'gemtpl 卡片应渲染').not.toBeNull()
    return id
  }

  function assertUseIntent(id: string, label: string): void {
    const intent = peekOpenIntent()
    expect(intent, `${label}：意图已置`).not.toBeNull()
    expect(intent?.kind).toBe('gemtpl')
    expect(intent?.assetId).toBe(id)
    expect(getView(), `${label}：切实验室`).toBe('lab')
  }

  it('去使用三入口：桌面双击（canonical）/ 悬停浮层 [去使用] 都置 intent + 切实验室', async () => {
    const id = await mountAssetsAtTemplates()
    const card = q(`[data-testid="asset-item-${id}"]`)!

    // 桌面双击卡面 = 去使用（canonical 手势）
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await flush()
    assertUseIntent(id, '双击')

    // 悬停浮层 [去使用]（jsdom 无真 hover：断言渲染 + click）
    resetOpenIntentForTests()
    setView('assets')
    expect(q(`[data-testid="gemtpl-overlay-${id}"]`)).not.toBeNull()
    click(`[data-testid="gemtpl-use-${id}"]`)
    await flush()
    assertUseIntent(id, '悬停浮层去使用')
  })

  it('移动端单击卡面 = 去使用（touch pointerdown 前置）；桌面单击不动作', async () => {
    const id = await mountAssetsAtTemplates()
    const card = q(`[data-testid="asset-item-${id}"]`)!

    // 桌面（mouse pointerdown）：单击不动作（单击=选中模型归 4.7）
    pointerdown(card, 'mouse')
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(peekOpenIntent()).toBeNull()

    // 移动端（touch）：pointerdown + click → 去使用
    pointerdown(card, 'touch')
    card.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    assertUseIntent(id, '移动端单击')
  })

  it('去编辑两入口：悬停浮层 [去编辑] 与移动端 ✎ 都开同一 RightSheet（TemplateEditor 就位）', async () => {
    const id = await mountAssetsAtTemplates()

    click(`[data-testid="gemtpl-edit-${id}"]`) // 桌面悬停浮层
    await waitFor(() => sheetEl() !== null)
    expect(getTemplateSheetAssetId()).toBe(id)
    expect(q('[data-testid="template-editor"]')).not.toBeNull()

    click('[data-testid="template-sheet-done"]') // 干净关闭（无未提交文本）
    await waitFor(() => sheetEl() === null)

    click(`[data-testid="gemtpl-edit-fab-${id}"]`) // 移动端 ✎ 常驻按钮
    await waitFor(() => sheetEl() !== null)
    expect(getTemplateSheetAssetId()).toBe(id)
    expect(q('[data-testid="template-prompt-textarea"]')).not.toBeNull()
  })

  it('选中态工具行 [打开] = 去使用等价物，点击后退出多选', async () => {
    const id = await mountAssetsAtTemplates()

    click('[data-testid="select-mode-button"]')
    click(`[data-testid="asset-item-${id}"]`) // 多选模式：点选
    await flush()
    const open = q('[data-testid="batch-open"]')
    expect(open, '选中 gemtpl 时 [打开] 出现').not.toBeNull()
    click(open!)
    await flush()
    assertUseIntent(id, '工具行打开')
    expect(q('[data-testid="selection-count"]')).toBeNull() // 已退出多选
  })

  it('入口存在性：gemtpl 卡有浮层两按钮 + 移动端 ✎；图片卡完全不动（手势统一 = 4.7）', async () => {
    const id = await mountAssetsAtTemplates()
    expect(q(`[data-testid="gemtpl-use-${id}"]`)?.textContent).toContain('去使用')
    expect(q(`[data-testid="gemtpl-edit-${id}"]`)?.textContent).toContain('去编辑')
    expect(q(`[data-testid="gemtpl-edit-fab-${id}"]`)?.getAttribute('aria-label')).toBe('去编辑')

    // 图片节点：无浮层、无 ✎、双击仍 = 行内重命名（4.7 前完全不动）
    const ingested = await ingestAsset({
      blob: new File([new Uint8Array([9])], 'plain.png', { type: 'image/png' }),
      name: 'plain.png',
      width: 10,
      height: 10,
      parentId: null,
      source: 'upload',
    })
    await library.refresh()
    click('[data-testid="tree-sys-root"]')
    await flush()
    expect(document.querySelectorAll('[data-testid^="gemtpl-overlay-"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-testid^="gemtpl-edit-fab-"]')).toHaveLength(0)
    const imgCard = q(`[data-testid="asset-item-${ingested.node.id}"]`)
    expect(imgCard, '根目录图片卡应渲染').not.toBeNull()
    imgCard!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await flush()
    expect(peekOpenIntent()).toBeNull() // 图片双击不产生打开意图
    expect(q('[data-testid="inline-rename-input"]')).not.toBeNull() // 仍是行内重命名
  })
})
