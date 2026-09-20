/**
 * [add-project-files 1.4] 素材库 type-aware 化（spec「素材库项目节点与统一打开手势」）：
 *
 * 1. 全部素材口径：AssetProject 五 kind（gemproj/gemdoc/gemtpl/gemgen/gemshape）入库后
 *    卡片可见（类型徽标 + summary 直出）+ 底栏「共 N 项 · 图片 X · 项目 Y」计数纳入
 *    （项目聚合五 kind 不拆分，含内置 seed；软删后计数回落）。
 * 2. recent 集合仍只收图片（design §7.4：gemtpl/gemgen/钻形不进最近）。
 * 3. 项目节点统一打开手势：桌面单击选中（选中态工具行 [打开]/[重命名]、Enter=打开、Esc 取消）、
 *    双击/移动端单击 = 按格式路由（gemproj→排钻工作台 / gemdoc→设计师工作台（经 openIntent，
 *    守卫与解析失败在消费侧）/ gemtpl·gemgen→实验室）；gemgen 解析失败不离开素材库不置意图。
 *    图片节点手势不动（修订归 4.7）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import AssetsView from '$lib/components/views/AssetsView.svelte'
import * as library from '$lib/assets/library.svelte'
import {
  ingestAsset,
  ingestProjectAsset,
  resetAssetStoreForTests,
  trashAsset,
  type AssetNode,
} from '$lib/persistence/assetStore'
import { PROJECT_MIME, type AssetProject, type ProjectKind } from '$lib/persistence/projectTypes'
import { serializeGemgen } from '$lib/persistence/labFile'
import { getImageBlob } from '$lib/persistence/imageStore'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { peekOpenIntent, resetOpenIntentForTests } from '$lib/stores/openIntent.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

let fake: FakeIndexedDB
let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  library.resetLibraryForTests()
  resetToastsForTests()
  resetOpenIntentForTests()
  setView('assets')
  localStorage.clear()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:view-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  vi.stubGlobal('createImageBitmap', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

const DATA_URL = 'data:image/png;base64,aGVsbG8='

/** 最小合法项目文件 blob（ingest 交叉校验只需 MIME × 声明 kind × 文件内 kind 一致）。 */
function projectBlob(kind: ProjectKind, payload: Record<string, unknown> = {}): Blob {
  return new Blob([JSON.stringify({ kind, formatVersion: 1, ...payload })], { type: PROJECT_MIME[kind] })
}

async function ingestProject(
  kind: ProjectKind,
  name: string,
  options: { parentId?: string; summary?: AssetProject['summary']; text?: string } = {},
): Promise<AssetProject> {
  const text =
    options.text ??
    (kind === 'gemgen'
      ? serializeGemgen({
          appVersion: 'test',
          createdAt: 1,
          savedAt: 2,
          name,
          image: { mime: 'image/png', dataUrl: DATA_URL, width: 8, height: 8 },
          provenance: {
            runId: 'run-1',
            templateName: '水钻模板',
            promptBody: 'prompt',
            composedPrompt: 'composed',
            caseBinding: null,
            candidateIndex: 0,
            requestMode: 'generate',
            model: 'gpt-image-2.5',
            size: '1024x1024',
          },
        })
      : JSON.stringify({ kind, formatVersion: 1 }))
  const result = await ingestProjectAsset({
    blob: new Blob([text], { type: PROJECT_MIME[kind] }),
    name,
    projectKind: kind,
    parentId: options.parentId,
    summary: options.summary,
  })
  return result.node
}

async function ingestImage(bytes: number[], name = 'pic.png'): Promise<AssetNode> {
  const result = await ingestAsset({
    blob: new File([new Uint8Array(bytes)], name, { type: 'image/png' }),
    name,
    width: 10,
    height: 20,
    parentId: null,
    source: 'upload',
  })
  return result.node
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function click(selector: string | Element): void {
  const el = typeof selector === 'string' ? q(selector) : selector
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function dblclick(el: Element): void {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
}

/** 移动端单击：touch pointerdown 前置 + click（沿 templateSheet 既有合成手法）。 */
function touchClick(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' }))
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function mountView(): Promise<() => void> {
  await library.ensureLibraryReady()
  await library.refresh()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(AssetsView, { target })
  await flush()
  return () => {
    unmount(app)
    target.remove()
  }
}

function trashedAtOf(node: AssetNode): number | undefined {
  return (node as { trashedAt?: number }).trashedAt
}

// ---------------------------------------------------------------------------
// 1. 全部素材口径 + 底栏计数 + recent
// ---------------------------------------------------------------------------

describe('[1.4] 全部素材口径：五 kind 可见 + 底栏计数 + recent 只收图片', () => {
  it('五 kind 各一入库：卡片可见（徽标 + summary 直出）；底栏「共 N · 图片 X · 项目 Y」纳入项目', async () => {
    await library.ensureLibraryReady() // 先 seed 系统目录（sys-templates/generated/shapes）再入库
    const image = await ingestImage([1], '参考.png')
    const gemproj = await ingestProject('gemproj', '蝴蝶工程.gemproj', {
      summary: { gemCount: 128, sourceName: '蝴蝶.jpg' },
    })
    const gemdoc = await ingestProject('gemdoc', '精修一份.gemdoc', { summary: { gemCount: 64 } })
    const gemtpl = await ingestProject('gemtpl', '水钻模板.gemtpl', { parentId: 'sys-templates' })
    const gemgen = await ingestProject('gemgen', '水钻模板·候选1.gemgen', {
      parentId: 'sys-generated',
      summary: { templateName: '水钻模板', candidateIndex: 0, size: '1024x1024', mode: 'generate' },
    })
    const gemshape = await ingestProject('gemshape', '自定义钻.gemshape', { parentId: 'sys-shapes' })
    const unmount = await mountView()

    // —— 底栏计数：从节点全集计算期望（含 sys-shapes 内置 seed——五 kind 聚合不拆分）——
    const all = library.getNodes()
    const expectedImages = all.filter((n) => n.type === 'image' && trashedAtOf(n) === undefined).length
    const expectedProjects = all.filter((n) => n.type === 'project' && trashedAtOf(n) === undefined).length
    const expectedFolders = all.filter((n) => n.type === 'folder' && (n as { system?: string }).system === undefined).length
    expect(expectedProjects).toBeGreaterThanOrEqual(25) // 20 内置钻形 seed + 五 kind 夹具
    expect(q('[data-testid="statusbar-projects"]')?.textContent).toBe(`项目 ${expectedProjects}`)
    expect(q('[data-testid="statusbar-images"]')?.textContent).toBe(`图片 ${expectedImages}`)
    expect(q('[data-testid="statusbar-total"]')?.textContent).toBe(
      `共 ${expectedFolders + expectedImages + expectedProjects} 项`,
    )
    expect(expectedImages).toBeGreaterThanOrEqual(1) // 夹具图片在内置案例之外

    // —— recent 只收图片：五 kind 项目 id 一概不进最近 ——
    const recentIds = library.recentAssets().map((a) => a.id)
    expect(library.recentAssets().every((a) => a.type === 'image')).toBe(true)
    for (const node of [gemproj, gemdoc, gemtpl, gemgen, gemshape]) {
      expect(recentIds).not.toContain(node.id)
    }
    expect(recentIds).toContain(image.id)

    // —— 卡片可见性 + 徽标 + summary 直出（按各自系统目录逐一导航）——
    click('[data-testid="tree-sys-sys-templates"]')
    await flush()
    expect(q(`[data-testid="asset-item-${gemtpl.id}"]`)).not.toBeNull()
    expect(q(`[data-testid="project-badge-${gemtpl.id}"]`)?.textContent).toBe('模板')
    expect(q(`[data-testid="asset-item-${gemtpl.id}"]`)?.textContent).toContain('模板') // summary 空回退类型标注

    click('[data-testid="tree-sys-sys-generated"]')
    await flush()
    expect(q(`[data-testid="asset-item-${gemgen.id}"]`)).not.toBeNull()
    expect(q(`[data-testid="gemgen-badge-${gemgen.id}"]`)?.textContent).toBe('生成')
    expect(q(`[data-testid="asset-item-${gemgen.id}"]`)?.textContent).toContain('水钻模板') // summary 直出

    click('[data-testid="tree-sys-sys-shapes"]')
    await flush()
    expect(q(`[data-testid="asset-item-${gemshape.id}"]`)).not.toBeNull()
    expect(q(`[data-testid="gemshape-badge-${gemshape.id}"]`)?.textContent).toBe('钻形')

    // gemproj/gemdoc 落 sys-projects：全部素材根级的「项目」目录卡可达（项目节点不隐形）
    click('[data-testid="tree-sys-root"]')
    await flush()
    click('[data-testid="asset-item-sys-projects"]')
    await flush()
    expect(q(`[data-testid="asset-item-${gemproj.id}"]`)).not.toBeNull()
    expect(q(`[data-testid="project-badge-${gemproj.id}"]`)?.textContent).toBe('排钻')
    expect(q(`[data-testid="asset-item-${gemproj.id}"]`)?.textContent).toContain('128 钻')
    expect(q(`[data-testid="asset-item-${gemproj.id}"]`)?.textContent).toContain('蝴蝶.jpg')
    expect(q(`[data-testid="asset-item-${gemdoc.id}"]`)).not.toBeNull()
    expect(q(`[data-testid="project-badge-${gemdoc.id}"]`)?.textContent).toBe('精修')
    expect(q(`[data-testid="asset-item-${gemdoc.id}"]`)?.textContent).toContain('64 钻')

    // —— 软删后计数回落（回收站内不计入「项目 Y」）——
    await trashAsset(gemdoc.id)
    await library.refresh()
    await flush()
    expect(q('[data-testid="statusbar-projects"]')?.textContent).toBe(`项目 ${expectedProjects - 1}`)
    expect(q(`[data-testid="asset-item-${gemdoc.id}"]`)).toBeNull()

    unmount()
  })
})

// ---------------------------------------------------------------------------
// 2. 统一打开手势（项目节点）
// ---------------------------------------------------------------------------

describe('[1.4] 项目节点统一手势：单击选中 / 工具行与 Enter / 双击与移动端路由', () => {
  it('桌面单击选中 → 工具行 [打开]/[重命名]；Enter=打开；再次单击取消；Esc 取消', async () => {
    const gemdoc = await ingestProject('gemdoc', '精修.gemdoc', { summary: { gemCount: 9 } })
    const unmount = await mountView()
    click('[data-testid="asset-item-sys-projects"]')
    await flush()
    const card = q(`[data-testid="asset-item-${gemdoc.id}"]`)!

    click(card) // 桌面单击 = 选中
    await flush()
    expect(q(`[data-testid="asset-check-${gemdoc.id}"]`)).not.toBeNull()
    expect(q('[data-testid="open-selected"]')).not.toBeNull()
    expect(q('[data-testid="rename-selected"]')).not.toBeNull()
    expect(peekOpenIntent()).toBeNull() // 单击只选中，不打开

    click('[data-testid="rename-selected"]') // 双击已让位给打开：重命名入口在选中态工具行
    await flush()
    const input = q('[data-testid="inline-rename-input"]') as HTMLInputElement
    expect(input).not.toBeNull()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(q('[data-testid="inline-rename-input"]')).toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) // Enter = 打开
    await flush()
    expect(peekOpenIntent()).toMatchObject({ kind: 'gemdoc', assetId: gemdoc.id })
    expect(getView()).toBe('edit')
    expect(q(`[data-testid="asset-check-${gemdoc.id}"]`)).toBeNull() // 打开即清选中

    setView('assets')
    resetOpenIntentForTests()
    click(card) // 重新选中后再单击同卡 = 取消
    await flush()
    click(card)
    await flush()
    expect(q('[data-testid="open-selected"]')).toBeNull()
    click(card)
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) // Esc = 取消单选
    await flush()
    expect(q(`[data-testid="asset-check-${gemdoc.id}"]`)).toBeNull()

    unmount()
  })

  it('双击路由：gemproj→排钻工作台 / gemdoc→设计师工作台 / gemtpl·gemgen→实验室（openIntent 置位）', async () => {
    await library.ensureLibraryReady() // seed 系统目录后再入 sys-templates/sys-generated
    const gemproj = await ingestProject('gemproj', '工程.gemproj')
    const gemdoc = await ingestProject('gemdoc', '文档.gemdoc')
    const gemtpl = await ingestProject('gemtpl', '模板.gemtpl', { parentId: 'sys-templates' })
    const gemgen = await ingestProject('gemgen', '生成.gemgen', {
      parentId: 'sys-generated',
      summary: { templateName: 'T', candidateIndex: 0, size: '1024x1024', mode: 'generate' },
    })
    const unmount = await mountView()

    click('[data-testid="asset-item-sys-projects"]')
    await flush()
    dblclick(q(`[data-testid="asset-item-${gemproj.id}"]`)!)
    await flush()
    expect(peekOpenIntent()).toMatchObject({ kind: 'gemproj', assetId: gemproj.id })
    expect(getView()).toBe('studio')
    resetOpenIntentForTests()

    dblclick(q(`[data-testid="asset-item-${gemdoc.id}"]`)!)
    await flush()
    expect(peekOpenIntent()).toMatchObject({ kind: 'gemdoc', assetId: gemdoc.id })
    expect(getView()).toBe('edit')
    resetOpenIntentForTests()

    click('[data-testid="tree-sys-sys-templates"]')
    await flush()
    dblclick(q(`[data-testid="asset-item-${gemtpl.id}"]`)!)
    await flush()
    expect(peekOpenIntent()).toMatchObject({ kind: 'gemtpl', assetId: gemtpl.id })
    expect(getView()).toBe('lab')
    resetOpenIntentForTests()

    click('[data-testid="tree-sys-sys-generated"]')
    await flush()
    dblclick(q(`[data-testid="asset-item-${gemgen.id}"]`)!)
    await flush()
    expect(peekOpenIntent()).toMatchObject({ kind: 'gemgen', assetId: gemgen.id })
    expect(getView()).toBe('lab')
    resetOpenIntentForTests()

    unmount()
  })

  it('gemgen 解析失败不离开素材库：三段式 toast + 不置意图（解析先于切视图）', async () => {
    await library.ensureLibraryReady()
    const broken = await ingestProject('gemgen', '损坏档案.gemgen', {
      parentId: 'sys-generated',
      text: 'not-a-gemgen-json',
      summary: { templateName: 'T', candidateIndex: 0, size: '1024x1024', mode: 'generate' },
    })
    const unmount = await mountView()

    click('[data-testid="tree-sys-sys-generated"]')
    await flush()
    dblclick(q(`[data-testid="asset-item-${broken.id}"]`)!)
    await flush(60)

    expect(peekOpenIntent()).toBeNull()
    expect(getView()).toBe('assets')
    const toast = getToasts().find((t) => t.message.includes('无法打开生成结果'))
    expect(toast).toBeDefined()
    expect(toast?.message).toContain('已留在素材库')
    // 物理记录确在（失败是解析层而非字节缺失）
    expect(await getImageBlob(broken.blobKey)).not.toBeNull()

    unmount()
  })

  it('移动端单击项目节点 = 打开（touch pointerdown 前置）', async () => {
    const gemdoc = await ingestProject('gemdoc', '移动打开.gemdoc')
    const unmount = await mountView()
    click('[data-testid="asset-item-sys-projects"]')
    await flush()

    touchClick(q(`[data-testid="asset-item-${gemdoc.id}"]`)!)
    await flush()
    expect(peekOpenIntent()).toMatchObject({ kind: 'gemdoc', assetId: gemdoc.id })
    expect(getView()).toBe('edit')

    unmount()
  })
})
