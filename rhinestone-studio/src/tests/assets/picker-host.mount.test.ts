/**
 * AssetPickerHost 交互（add-asset-library tasks 3.1/3.2 的选图器侧）：
 * 单/多选、取消、Esc、chips 快捷集合与目录下钻、上传即入库自动选中、
 * 同目录重复 → toast「已在库中」+ 定位高亮、blob 缺失不可选。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import AssetPickerHost from '../../components/Assets/AssetPickerHost.svelte'
import { AssetPickerController } from '$lib/assets/controller.svelte'
import * as library from '$lib/assets/library.svelte'
import {
  createFolder,
  ingestAsset,
  renameAsset,
  resetAssetStoreForTests,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { deleteImage } from '$lib/persistence/imageStore'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

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
  localStorage.clear()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:picker-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  vi.stubGlobal('createImageBitmap', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  // bits-ui Dialog 卸载时的 portal 清理存在 jsdom 残留：测试间清空 body，避免陈旧弹层污染查询
  document.body.innerHTML = ''
})

function png(bytes: number[], name = 'pic.png'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

async function ingest(parentId: string | null, bytes: number[], name = 'pic.png'): Promise<AssetImage> {
  const result = await ingestAsset({
    blob: png(bytes, name),
    name,
    width: 8,
    height: 8,
    parentId,
    source: 'upload',
  })
  return result.node
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

interface MountedPicker {
  controller: AssetPickerController
  unmount: () => void
}

async function mountHost(): Promise<MountedPicker> {
  const controller = new AssetPickerController()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(AssetPickerHost, { target, props: { controller } })
  return {
    controller,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function click(selector: string): void {
  const el = document.querySelector(selector)
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('AssetPickerHost 单/多选与取消（design §5）', () => {
  it('open → 点图 → 确定：promise 以该图落定，弹层关闭', async () => {
    const a = await ingest(null, [1], 'a.png')
    await library.ensureLibraryReady()
    const { controller, unmount } = await mountHost()

    const pending = controller.open()
    await flush()
    expect(document.querySelector('[data-testid="asset-picker"]')).not.toBeNull()

    click(`[data-testid="picker-item-${a.id}"]`)
    await flush()
    expect(document.querySelector(`[data-testid="picker-check-${a.id}"]`)).not.toBeNull()

    click('[data-testid="picker-confirm"]')
    const result = await pending
    expect(result).toMatchObject([{ id: a.id }])
    await flush()
    expect(document.querySelector('[data-testid="asset-picker"]')).toBeNull()

    unmount()
  })

  it('multi：点选两张 → 确定带回两项；半选再点摘除', async () => {
    const a = await ingest(null, [1], 'a.png')
    const b = await ingest(null, [2], 'b.png')
    await library.ensureLibraryReady()
    const { controller, unmount } = await mountHost()

    const pending = controller.open({ multi: true })
    await flush()
    click(`[data-testid="picker-item-${a.id}"]`)
    click(`[data-testid="picker-item-${b.id}"]`)
    click(`[data-testid="picker-item-${a.id}"]`) // 摘除
    await flush()
    expect(document.body.textContent).toContain('已选 1 项')

    click('[data-testid="picker-confirm"]')
    const result = await pending
    expect(result?.map((x) => x.id)).toEqual([b.id])

    unmount()
  })

  it('取消按钮 / Esc：resolve(null) 且半选态清空', async () => {
    const a = await ingest(null, [1], 'a.png')
    await library.ensureLibraryReady()
    const { controller, unmount } = await mountHost()

    const pending = controller.open({ multi: true })
    await flush()
    click(`[data-testid="picker-item-${a.id}"]`)
    await flush()
    const cancel = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '取消')
    cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await expect(pending).resolves.toBeNull()
    expect(controller.selection).toHaveLength(0)

    // Esc 路径
    const second = controller.open()
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(second).resolves.toBeNull()

    unmount()
  })

  it('Host 销毁：等待方 resolve(null)', async () => {
    await library.ensureLibraryReady()
    const { controller, unmount } = await mountHost()
    const pending = controller.open()
    await flush()
    unmount()
    controller.destroy()
    await expect(pending).resolves.toBeNull()
  })
})

describe('AssetPickerHost 浏览与集合（chips/面包屑/下钻）', () => {
  it('默认「最近」集合：updatedAt 降序（rename touch 排前）', async () => {
    // fake IDB 太快会让两次 ingest 与 rename 落进同一毫秒（updatedAt 平局），单调化 Date.now 保证次序确定
    let clock = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
    try {
      const a = await ingest(null, [1], 'a.png')
      const b = await ingest(null, [2], 'b.png')
      await renameAsset(b.id, 'b-renamed.png') // bump updatedAt
      await library.ensureLibraryReady()
      const { controller, unmount } = await mountHost()

      void controller.open()
      await flush()
      const items = [...document.querySelectorAll('[data-testid^="picker-item-"]')]
      expect(items.map((el) => el.getAttribute('data-testid'))[0]).toBe(`picker-item-${b.id}`)
      expect(items).toHaveLength(2)
      void a

      unmount()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('「生成结果」chip → 目录视图列出 sys-generated 内容；「全部」列根层文件夹', async () => {
    await library.ensureLibraryReady() // 迁移 seed 系统目录
    const gen = await ingest('sys-generated', [3], 'gen.png')
    const folder = await createFolder(null, '我的收藏')
    await library.refresh()
    const { controller, unmount } = await mountHost()

    void controller.open()
    await flush()
    click('[data-testid="picker-chip-generated"]')
    await flush()
    expect(document.querySelector(`[data-testid="picker-item-${gen.id}"]`)).not.toBeNull()
    expect(document.querySelector('[data-testid="picker-breadcrumb"]')?.textContent).toContain('生成结果')

    click('[data-testid="picker-chip-all"]')
    await flush()
    expect(document.querySelector(`[data-testid="picker-item-${folder.id}"]`)).not.toBeNull()

    unmount()
  })

  it('initialFolderId：直接落在指定目录', async () => {
    const folder = await createFolder(null, '定向')
    const inner = await ingest(folder.id, [4], 'inner.png')
    await library.ensureLibraryReady()
    const { controller, unmount } = await mountHost()

    void controller.open({ initialFolderId: folder.id })
    await flush()
    expect(document.querySelector(`[data-testid="picker-item-${inner.id}"]`)).not.toBeNull()
    expect(document.querySelector('[data-testid="picker-breadcrumb"]')?.textContent).toContain('定向')

    unmount()
  })

  it('blob 缺失条目：禁用不可选（七态④）', async () => {
    const a = await ingest(null, [9], 'ghost.png')
    await deleteImage(a.blobKey ?? '')
    library.resetLibraryForTests()
    await library.ensureLibraryReady()
    const { controller, unmount } = await mountHost()

    void controller.open()
    await flush()
    const item = document.querySelector(`[data-testid="picker-item-${a.id}"]`) as HTMLButtonElement
    expect(item.disabled).toBe(true)
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(controller.selection).toHaveLength(0)

    unmount()
  })
})

describe('AssetPickerHost 上传即入库（task 3.2 选图器侧）', () => {
  it('上传新图片：落当前目录 → 自动选中 → 确定带回新节点', async () => {
    await library.ensureLibraryReady()
    const { controller, unmount } = await mountHost()

    const pending = controller.open()
    await flush()
    click('[data-testid="picker-upload"]')
    const input = document.querySelector('[data-testid="asset-picker"] input[type="file"]') as HTMLInputElement
    setFiles(input, [png([5, 5, 5], 'fresh.png')])
    await flush(60)

    const created = (await library.childrenOf('sys-uploads')).find((n) => n.type === 'image') as AssetImage
    expect(created?.name).toBe('fresh.png')
    expect(controller.isSelected(created.id)).toBe(true)
    expect(document.querySelector(`[data-testid="picker-item-${created.id}"]`)).not.toBeNull()

    click('[data-testid="picker-confirm"]')
    const result = await pending
    expect(result?.map((x) => x.id)).toEqual([created.id])

    unmount()
  })

  it('同目录重复上传：toast「已在库中」+ 选中并高亮既有条目（不建新节点）', async () => {
    await library.ensureLibraryReady() // seed 系统目录后再入 sys-uploads
    const existing = await ingest('sys-uploads', [7, 7], 'dup.png')
    await library.refresh()
    const { controller, unmount } = await mountHost()

    const pending = controller.open()
    await flush()
    click('[data-testid="picker-upload"]')
    const input = document.querySelector('[data-testid="asset-picker"] input[type="file"]') as HTMLInputElement
    setFiles(input, [png([7, 7], 'dup-again.png')])
    await flush(60)

    expect(getToasts().some((t) => t.message.includes('已在库中'))).toBe(true)
    const uploads = (await library.childrenOf('sys-uploads')).filter((n) => n.type === 'image')
    expect(uploads).toHaveLength(1) // 同目录同内容去重
    expect(controller.isSelected(existing.id)).toBe(true)
    const item = document.querySelector(`[data-testid="picker-item-${existing.id}"]`)
    expect(item?.getAttribute('data-highlight')).toBe('true')

    click('[data-testid="picker-confirm"]')
    const result = await pending
    expect(result?.map((x) => x.id)).toEqual([existing.id])

    unmount()
  })
})
