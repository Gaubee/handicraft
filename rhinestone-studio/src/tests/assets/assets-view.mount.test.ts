/**
 * AssetsView 挂载与交互（add-asset-library tasks 2.1-2.4）：
 * 树渲染/导航/网格列表切换/多选/回收站计数徽标/状态条；七态中可 jsdom 化的
 * 空库/迁移中/blob 缺失/重名后缀/上传失败/移动环禁用；清空回收站引用保护明细（pin 表）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import AssetsView from '$lib/components/views/AssetsView.svelte'
import * as library from '$lib/assets/library.svelte'
import {
  createFolder,
  ingestAsset,
  pinAsset,
  renameAsset,
  resetAssetStoreForTests,
  trashAsset,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { deleteImage } from '$lib/persistence/imageStore'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
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
  localStorage.clear()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:view-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  // jsdom 无 createImageBitmap：上传路径 dims 回退 0×0 即时落定
  vi.stubGlobal('createImageBitmap', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  // bits-ui 覆盖层卸载时的 portal 清理存在 jsdom 残留：测试间清空 body，避免陈旧弹层污染查询
  document.body.innerHTML = ''
})

function png(bytes: number[], name = 'pic.png'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

async function ingest(parentId: string | null, bytes: number[], name = 'pic.png'): Promise<AssetImage> {
  const result = await ingestAsset({
    blob: png(bytes, name),
    name,
    width: 10,
    height: 20,
    parentId,
    source: 'upload',
  })
  return result.node
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function mountView(): Promise<{ target: HTMLElement; unmount: () => void }> {
  await library.ensureLibraryReady()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(AssetsView, { target })
  await flush()
  return {
    target,
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

describe('AssetsView 树与导航（task 2.1）', () => {
  it('系统目录置顶 + 用户目录树渲染；点击用户文件夹导航并更新面包屑', async () => {
    const folder = await createFolder(null, '蝴蝶素材')
    const wing = await ingest(folder.id, [1, 2], 'wing.png')
    const rootImg = await ingest(null, [3], 'root.png')
    const { unmount } = await mountView()

    for (const testid of [
      'tree-sys-root',
      'tree-sys-sys-generated',
      'tree-sys-sys-uploads',
      'tree-sys-sys-cases',
      'tree-sys-sys-trash',
    ]) {
      expect(document.querySelector(`[data-testid="${testid}"]`)).not.toBeNull()
    }
    expect(document.querySelector(`[data-testid="tree-folder-${folder.id}"]`)).not.toBeNull()
    // 根层：用户文件夹置顶 + 根图片可见
    expect(document.querySelector(`[data-testid="asset-item-${folder.id}"]`)).not.toBeNull()
    expect(document.querySelector(`[data-testid="asset-item-${rootImg.id}"]`)).not.toBeNull()

    click(`[data-testid="tree-folder-${folder.id}"]`)
    await flush()
    expect(document.querySelector(`[data-testid="asset-item-${wing.id}"]`)).not.toBeNull()
    expect(document.querySelector('[data-testid="assets-breadcrumb"]')?.textContent).toContain('蝴蝶素材')
    expect(document.querySelector(`[data-testid="asset-item-${rootImg.id}"]`)).toBeNull()

    unmount()
  })

  it('网格 ⇄ 列表切换：列表含名称/来源列', async () => {
    const a = await ingest(null, [9], 'a.png')
    const { unmount } = await mountView()

    expect(document.querySelector('[data-testid="assets-grid"]')).not.toBeNull()
    click('[data-testid="view-list"]')
    await flush()
    expect(document.querySelector('[data-testid="assets-list"]')).not.toBeNull()
    const row = document.querySelector(`[data-testid="asset-row-${a.id}"]`)
    expect(row?.textContent).toContain('a.png')
    expect(row?.textContent).toContain('上传') // 来源列

    unmount()
  })

  it('行内重命名：双击条目 → 输入 → Enter 提交（Esc 取消）', async () => {
    const a = await ingest(null, [6], 'old.png')
    const { unmount } = await mountView()

    const item = document.querySelector(`[data-testid="asset-item-${a.id}"]`)!
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flush()
    const input = document.querySelector('[data-testid="inline-rename-input"]') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = 'new.png'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush(60)

    const renamed = (await library.childrenOf(null)).find((n) => n.id === a.id)
    expect(renamed?.name).toBe('new.png')
    expect(document.querySelector('[data-testid="inline-rename-input"]')).toBeNull()

    unmount()
  })
})

describe('AssetsView 多选与批量操作（task 2.2）', () => {
  it('工具行「选择」进入多选：点选两项 → 已选 2 → 移动/删除/下载出现', async () => {
    const a = await ingest(null, [1], 'a.png')
    const b = await ingest(null, [2], 'b.png')
    const { unmount } = await mountView()

    click('[data-testid="select-mode-button"]')
    await flush()
    click(`[data-testid="asset-item-${a.id}"]`)
    click(`[data-testid="asset-item-${b.id}"]`)
    await flush()

    expect(document.querySelector('[data-testid="selection-count"]')?.textContent).toContain('已选 2')
    for (const t of ['batch-move', 'batch-delete', 'batch-download']) {
      expect(document.querySelector(`[data-testid="${t}"]`)).not.toBeNull()
    }

    unmount()
  })

  it('Ctrl+点击不经「选择」直接进入批量操作位', async () => {
    const a = await ingest(null, [1], 'a.png')
    const { unmount } = await mountView()

    const el = document.querySelector(`[data-testid="asset-item-${a.id}"]`)!
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await flush()
    expect(document.querySelector('[data-testid="batch-move"]')).not.toBeNull()

    unmount()
  })
})

describe('AssetsView 回收站与状态条（task 2.4）', () => {
  it('删除 → 回收站徽标计数；sys-trash 视图列出软删项；状态条含共 N/回收站 N/存储', async () => {
    const a = await ingest(null, [1], 'a.png')
    const { unmount } = await mountView()

    click('[data-testid="select-mode-button"]')
    click(`[data-testid="asset-item-${a.id}"]`)
    await flush()
    click('[data-testid="batch-delete"]')
    await flush()
    expect(document.querySelector('[data-testid="confirm-trash"]')).not.toBeNull()
    expect(document.body.textContent).toContain('1 张图片') // 确认框列明 N 图 M 夹
    click('[data-testid="confirm-trash"]')
    await flush(60)

    expect(document.querySelector('[data-testid="trash-count-badge"]')?.textContent).toContain('1')
    expect(library.trashCount()).toBe(1)

    click('[data-testid="tree-sys-sys-trash"]')
    await flush()
    expect(document.querySelector(`[data-testid="asset-item-${a.id}"]`)).not.toBeNull()
    expect(document.querySelector('[data-testid="asset-trashed-placeholder"]')).not.toBeNull()

    const status = document.querySelector('[data-testid="assets-statusbar"]')?.textContent ?? ''
    expect(status).toContain('回收站 1 项')
    expect(status).toContain('存储')

    unmount()
  })

  it('清空回收站：红色点名确认 + pinned 引用保护跳过明细', async () => {
    const a = await ingest(null, [1], 'a.png')
    const b = await ingest(null, [2], 'b.png')
    pinAsset(a.id)
    await trashAsset(a.id)
    await trashAsset(b.id)
    const { unmount } = await mountView()

    click('[data-testid="tree-sys-sys-trash"]')
    await flush()
    click('[data-testid="empty-trash-button"]')
    await flush()
    // 红色点名确认：标题含「永久删除 N 项」
    expect(document.body.textContent).toContain('永久删除 2 项')
    click('[data-testid="confirm-empty-trash"]')
    await flush(60)

    const skipped = document.querySelector('[data-testid="empty-trash-skipped"]')
    expect(skipped).not.toBeNull()
    expect(skipped?.textContent).toContain('a.png')
    expect(skipped?.textContent).toContain('正被模块引用')
    expect(library.trashCount()).toBe(1) // pinned 保留

    unmount()
  })
})

describe('七态（PM §2.6 状态矩阵，jsdom 可化子集）', () => {
  it('① 空库：引导卡 + 上传 CTA + 归档说明（仅有内置案例亦算空库）', async () => {
    const { unmount } = await mountView()
    const empty = document.querySelector('[data-testid="assets-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('实验室生成的图会自动归档到此处')
    expect(document.querySelector('[data-testid="empty-upload-button"]')).not.toBeNull()
    unmount()
  })

  it('② 迁移进行中：顶部细进度条出现，结束后消失', async () => {
    const { unmount } = await mountView()
    library.setMigrationRunningForTests(true)
    await flush()
    expect(document.querySelector('[data-testid="migration-progress"]')).not.toBeNull()
    library.setMigrationRunningForTests(false)
    await flush()
    expect(document.querySelector('[data-testid="migration-progress"]')).toBeNull()
    unmount()
  })

  it('③ blob 缺失：缩略图「已失效」占位且视图不炸', async () => {
    const a = await ingest(null, [7], 'ghost.png')
    await deleteImage(a.blobKey ?? '')
    library.resetLibraryForTests() // 强制下一轮 ensure 重新解析 url
    const { unmount } = await mountView()

    expect(document.querySelector(`[data-testid="asset-item-${a.id}"]`)).not.toBeNull()
    expect(document.querySelector('[data-testid="asset-missing"]')).not.toBeNull()

    unmount()
  })

  it('④ 上传失败三段式 toast：非白名单 MIME 被拒且不留半节点', async () => {
    const { unmount } = await mountView()
    click('[data-testid="upload-button"]')
    const input = document.querySelector('[data-testid="assets-view"] input[type="file"]') as HTMLInputElement
    setFiles(input, [new File([new Uint8Array([1])], 'bad.gif', { type: 'image/gif' })])
    await flush(60)

    const toast = getToasts().find((t) => t.message.includes('上传失败'))
    expect(toast).toBeDefined()
    expect(toast?.message).toContain('该图片未入库') // 怎么办段
    expect((await library.childrenOf(null)).filter((n) => n.type === 'image')).toHaveLength(0)

    unmount()
  })

  it('⑤ 重名自动后缀不打断：新建文件夹两次得「新建文件夹 (2)」并 toast', async () => {
    const { unmount } = await mountView()
    click('[data-testid="tree-new-folder"]')
    await flush(60)
    click('[data-testid="tree-new-folder"]')
    await flush(60)

    const names = (await library.childrenOf(null)).filter((n) => n.type === 'folder').map((n) => n.name)
    expect(names).toContain('新建文件夹')
    expect(names).toContain('新建文件夹 (2)')
    expect(getToasts().some((t) => t.message.includes('已自动调整'))).toBe(true)

    unmount()
  })

  it('⑥ 移动环：移动对话框中自身与后代目标禁用 + title 提示；根目录可选', async () => {
    const parent = await createFolder(null, 'parent')
    const child = await createFolder(parent.id, 'child')
    await ingest(child.id, [5], 'inner.png')
    const { unmount } = await mountView()

    // 根层选中 parent 发起移动：forbidden = parent 子树（parent + child）
    click('[data-testid="select-mode-button"]')
    click(`[data-testid="asset-item-${parent.id}"]`)
    await flush()
    click('[data-testid="batch-move"]')
    await flush()

    const parentTarget = document.querySelector(`[data-testid="move-target-${parent.id}"]`) as HTMLButtonElement
    const childTarget = document.querySelector(`[data-testid="move-target-${child.id}"]`) as HTMLButtonElement
    expect(parentTarget.disabled).toBe(true)
    expect(parentTarget.title).toContain('不能移动到自身或其后代')
    expect(childTarget.disabled).toBe(true)
    expect(document.querySelector('[data-testid="move-target-root"]')).not.toBeNull()

    unmount()
  })

  it('⑦ 既有节点重命名冲突：store 自动 (2)（ingest/move 同源 uniqueNameAmong 口径）', async () => {
    await ingest(null, [1], 'same.png')
    const b = await ingest(null, [2], 'other.png')
    await renameAsset(b.id, 'same.png')
    library.resetLibraryForTests()
    const { unmount } = await mountView()

    const names = (await library.childrenOf(null)).filter((n) => n.type === 'image').map((n) => n.name)
    expect(names).toContain('same.png (2)')

    unmount()
  })
})

describe('[Owner] 生成图↔参考原图配对（meta.referenceAssetId 预览关联）', () => {
  it('生成图预览显示参考原图并可点击跳转（切换预览对象）；参考失效显已失效', async () => {
    await library.ensureLibraryReady() // seed 系统目录后再入 sys-uploads
    const ref = await ingest('sys-uploads', [7], '参考原图.png')
    const gen = await ingestAsset({
      blob: png([8], 'gen.png'),
      name: 'gen.png',
      width: 10,
      height: 10,
      parentId: 'sys-uploads',
      source: 'lab-generate',
      meta: { referenceAssetId: ref.id },
    })
    const orphan = await ingestAsset({
      blob: png([9], 'orphan.png'),
      name: 'orphan.png',
      width: 10,
      height: 10,
      parentId: 'sys-uploads',
      source: 'lab-generate',
      meta: { referenceAssetId: 'ast-does-not-exist' },
    })
    const { unmount } = await mountView()
    click('[data-testid="tree-sys-sys-uploads"]')
    await flush()

    // 打开生成图预览 → 参考原图行显示参考名，点击跳转
    click(`[data-testid="asset-item-${gen.node.id}"]`)
    await flush()
    const refBtn = document.querySelector('[data-testid="preview-open-reference"]') as HTMLButtonElement
    expect(refBtn).not.toBeNull()
    expect(refBtn.textContent).toContain('参考原图.png')
    refBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    // 预览切换到参考图：参考图自身无参考行
    expect(document.querySelector('[data-testid="preview-open-reference"]')).toBeNull()

    // 失效参考：orphan 显示已失效占位，无跳转按钮
    click(`[data-testid="asset-item-${orphan.node.id}"]`)
    await flush()
    const dlg = document.querySelector('[role="dialog"]')
    expect(dlg?.textContent).toContain('已失效')
    expect(document.querySelector('[data-testid="preview-open-reference"]')).toBeNull()

    unmount()
  })
})
