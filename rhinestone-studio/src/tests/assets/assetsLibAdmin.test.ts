/*
 * [split-admin-portal 4.4] AssetsLibAdmin（后台素材子分区）jsdom 测试。
 * fake adminApi 注入（fakeAdminApi assetsLib 面）——覆盖：
 *   [1] 挂载：树+网格+工具行；目录切换过滤网格。
 *   [2] 管理面载荷：重命名/移动/软删（节点消失进回收站视图）/恢复/清空回收站。
 *   [3] 迁移入口：Dialog 开→开始导入→报告呈现（fake migrate 面收敛 match=true）
 *       +「不删除本浏览器原数据」红线文案在场。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { FakeAdminApi } from '../admin/fakeAdminApi'
import { makeFakeAdminApi } from '../admin/fakeAdminApi'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

const holder: { current: FakeAdminApi | null } = vi.hoisted(() => ({ current: null }))
vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.current!.api }))

import AssetsLibAdmin from '$lib/components/assets-lib/AssetsLibAdmin.svelte'
import { resetSessionForTests } from '$lib/stores/session.svelte'
import { createFolder, ingestAsset, resetAssetStoreForTests } from '$lib/persistence/assetStore'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function mountView(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(AssetsLibAdmin, { target })
  mountedDisposers.push(() => {
    unmount(app)
    target.remove()
  })
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `选择器 ${selector} 应命中`).not.toBeNull()
  return el as HTMLElement
}

function clickButtonByText(scope: HTMLElement, text: string): void {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button, `按钮「${text}」应存在`).toBeDefined()
  button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  sessionStorage.clear()
  localStorage.clear()
  holder.current = makeFakeAdminApi()
  resetSessionForTests({ username: 'boss', role: 'admin' })
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
})

describe('[1] 挂载与浏览', () => {
  it('工具行+树+网格在场；目录切换过滤网格（根空、上传目录 1 图）', async () => {
    mountView()
    await flush()

    expect(q('[data-testid="assets-lib-view"]')).toBeDefined()
    expect(q('[data-testid="assets-lib-toolbar"]')).toBeDefined()
    expect(q('[data-testid="assets-lib-tree"]').textContent).toContain('上传')
    // 根目录（默认）：无直挂图片
    expect(q('[data-testid="assets-lib-empty"]')).toBeDefined()

    q('[data-testid="assets-lib-tree-folder-al-dir-uploads"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(q('[data-testid="assets-lib-node-al-img-1"]').textContent).toContain('样图.png')
    expect(q('[data-testid="assets-lib-node-al-img-1"]').textContent).toContain('120×80')
  })
})

describe('[2] 管理面载荷', () => {
  it('重命名 Dialog→rename 载荷；移动 Dialog→move 载荷', async () => {
    mountView()
    await flush()
    q('[data-testid="assets-lib-tree-folder-al-dir-uploads"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    clickButtonByText(q('[data-testid="assets-lib-node-al-img-1"]'), '重命名')
    await flush()
    const input = q('[data-testid="assets-lib-rename-input"]') as HTMLInputElement
    input.value = '改名样图.png'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    q('[data-testid="assets-lib-rename-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(40)
    expect(holder.current!.state.calls.assetsLibRename).toEqual([{ id: 'al-img-1', name: '改名样图.png' }])
    expect(q('[data-testid="assets-lib-node-al-img-1"]').textContent).toContain('改名样图.png')

    clickButtonByText(q('[data-testid="assets-lib-node-al-img-1"]'), '移动')
    await flush()
    // bits-ui Select 内容懒渲染（jsdom 不开浮层）——按 Dialog 当前值（节点现父目录）
    // 直发确认载荷；目标选项交互归 e2e 面。
    q('[data-testid="assets-lib-move-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(40)
    expect(holder.current!.state.calls.assetsLibMove).toEqual([{ id: 'al-img-1', newParentId: 'al-dir-uploads' }])
  })

  it('软删→回收站视图恢复→清空回收站（purge 载荷）', async () => {
    mountView()
    await flush()
    q('[data-testid="assets-lib-tree-folder-al-dir-uploads"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    clickButtonByText(q('[data-testid="assets-lib-node-al-img-1"]'), '软删')
    await flush(40)
    expect(holder.current!.state.calls.assetsLibSoftDelete).toEqual(['al-img-1'])
    // 目录视图：软删后空
    expect(q('[data-testid="assets-lib-empty"]')).toBeDefined()

    // 回收站视图：恢复
    clickButtonByText(q('[data-testid="assets-lib-toolbar"]'), '回收站')
    await flush()
    expect(q('[data-testid="assets-lib-node-al-img-1"]').textContent).toContain('样图.png')
    clickButtonByText(q('[data-testid="assets-lib-node-al-img-1"]'), '恢复')
    await flush(40)
    expect(holder.current!.state.calls.assetsLibRestore).toEqual(['al-img-1'])

    // 再软删+清空
    clickButtonByText(q('[data-testid="assets-lib-toolbar"]'), '返回浏览')
    await flush()
    q('[data-testid="assets-lib-tree-folder-al-dir-uploads"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    clickButtonByText(q('[data-testid="assets-lib-node-al-img-1"]'), '软删')
    await flush(40)
    clickButtonByText(q('[data-testid="assets-lib-toolbar"]'), '回收站')
    await flush()
    clickButtonByText(q('[data-testid="assets-lib-toolbar"]'), '清空回收站')
    await flush(40)
    expect(holder.current!.state.calls.assetsLibPurge).toBe(1)
    expect(q('[data-testid="assets-lib-empty"]').textContent).toContain('回收站为空')
  })
})

describe('[3] 迁移入口（从本浏览器导入）', () => {
  it('Dialog 红线文案在场；导入按钮→报告 match=true（fake 面收敛）', async () => {
    // 合成本地 IDB（1 目录+1 图）+清空 fake 服务端种子（核验面收敛前提）。
    const fakeIdb: FakeIndexedDB = installFakeIndexedDB()
    fakeIdb.reset()
    resetAssetStoreForTests()
    const folder = await createFolder(null, '上传')
    await ingestAsset({
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' }),
      name: 'p1.png',
      width: 4,
      height: 4,
      parentId: folder.id,
      source: 'upload',
    })
    holder.current!.state.assetsNodes = []

    mountView()
    await flush()
    clickButtonByText(q('[data-testid="assets-lib-toolbar"]'), '从本浏览器导入')
    await flush()

    const dialog = q('[data-testid="assets-lib-migrate-dialog"]')
    expect(dialog.textContent).toContain('导入不删除本浏览器原数据')
    q('[data-testid="assets-lib-migrate-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(150)

    expect(holder.current!.state.calls.assetsLibMigrateBatch).toBeGreaterThanOrEqual(2) // 目录批+内容批
    expect(holder.current!.state.calls.assetsLibMigrateVerify).toHaveLength(1)
    expect(q('[data-testid="assets-lib-migrate-report"]').textContent).toContain('核验通过')
    expect(q('[data-testid="assets-lib-migrate-verify-ok"]')).toBeDefined()
  })
})
