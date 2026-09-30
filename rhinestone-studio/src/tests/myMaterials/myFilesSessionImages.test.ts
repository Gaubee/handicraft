/*
 * [product-polish-w1 T2]「我的文件 → 会话图片」虚拟目录 jsdom 测试。
 * fake adminApi（素材树面）+ fake 会话图片客户端注入——覆盖：
 *   [1] 树顶「会话图片」入口在场；首次点击惰性取数一次→按会话分组渲染
 *       （会话标题/时间/图片卡 name+尺寸徽标；预览 80% contains+w=600 缩略参）。
 *   [2] 空态文案（无会话图片——前台会话上传引导）；失败=错误+重试。
 *   [3] 视图互斥：会话图片↔回收站切换复位；状态栏计数切换。
 *   [4] 只读红线：会话图片域无任何素材库写操作调用（fake 面计数恒 0）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { FakeAdminApi } from '../admin/fakeAdminApi'
import { makeFakeAdminApi } from '../admin/fakeAdminApi'
import type { SessionImagesGroup } from '$lib/myMaterials/schemas'

const holder: { current: FakeAdminApi | null } = vi.hoisted(() => ({ current: null }))
vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.current!.api }))

import AssetsLibAdmin from '$lib/components/assets-lib/AssetsLibAdmin.svelte'
import { resetSessionImagesForTests, type MySessionImagesClient } from '$lib/myMaterials/sessionImages.svelte'
import { resetSessionForTests } from '$lib/stores/session.svelte'

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

function click(selector: string): void {
  q(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function groupOf(sessionId: string, title: string, images: SessionImagesGroup['images']): SessionImagesGroup {
  return { sessionId, title, updatedAt: '2026-09-30T08:00:00.000Z', images }
}

function makeImagesFixture(options: { groups?: SessionImagesGroup[]; fail?: boolean } = {}): {
  client: MySessionImagesClient
  calls: { count: number }
} {
  const calls = { count: 0 }
  const client: MySessionImagesClient = {
    async listSessionImages(): Promise<{ groups: SessionImagesGroup[] }> {
      calls.count += 1
      if (options.fail) throw new Error('daemon 不可达')
      return { groups: options.groups ?? [] }
    },
  }
  return { client, calls }
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
  resetSessionImagesForTests()
})

describe('[1] 虚拟目录挂载与分组渲染', () => {
  it('树顶入口在场；首次点击惰性取数一次→分组/图片卡/缩略参渲染；幂等', async () => {
    const ref = 'a'.repeat(64)
    const ref2 = 'b'.repeat(64)
    const { client, calls } = makeImagesFixture({
      groups: [
        groupOf('s-snow', '雪人单', [
          { blobRef: ref, name: 'attachment-aaaaaaaaaaaa.png', mime: 'image/png', width: 96, height: 96 },
          { blobRef: ref2, name: 'attachment-bbbbbbbbbbbb.png', mime: 'image/png', width: 120, height: 80 },
        ]),
        groupOf('s-plain', '', [{ blobRef: ref, name: 'attachment-aaaaaaaaaaaa.png', mime: 'image/png', width: 96, height: 96 }]),
      ],
    })
    resetSessionImagesForTests(client)
    mountView()
    await flush()

    // 未进入=不取数；入口在树顶（「全部素材」之前）
    expect(calls.count).toBe(0)
    const tree = q('[data-testid="assets-lib-tree"]')
    expect(tree.textContent).toContain('会话图片')
    expect(tree.textContent!.indexOf('会话图片')).toBeLessThan(tree.textContent!.indexOf('全部素材'))

    click('[data-testid="assets-lib-tree-session-images"]')
    await flush()

    expect(calls.count).toBe(1)
    const view = q('[data-testid="my-files-session-images"]')
    // 两组：会话标题分组（空标题→未命名会话）
    expect(view.querySelectorAll('[data-testid^="my-files-session-images-group-"]')).toHaveLength(2)
    expect(q('[data-testid="my-files-session-images-group-s-snow"]').textContent).toContain('雪人单')
    expect(q('[data-testid="my-files-session-images-group-s-plain"]').textContent).toContain('未命名会话')
    // 图片卡：name+尺寸徽标；预览 80% contains+w=600 缩略参（素材卡同款）
    const card = q('[data-testid="my-files-session-images-image-s-snow-0"]')
    expect(card.textContent).toContain('attachment-aaaaaaaaaaaa.png')
    expect(card.textContent).toContain('96×96')
    const img = q('[data-testid="my-files-session-images-img-s-snow-0"]') as HTMLImageElement
    expect(img.className).toContain('w-[80%]')
    expect(img.className).toContain('h-[80%]')
    expect(img.className).toContain('object-contain')
    expect(img.getAttribute('src')).toBe(`${location.origin}/api/assets/${ref}/raw?w=600`)
    // 状态栏：会话图片域+计数（3 项）
    const statusbar = q('[data-testid="assets-lib-statusbar"]').textContent
    expect(statusbar).toContain('会话图片')
    expect(statusbar).toContain('3 项图片')

    // 切走再切回：幂等（不重复取数）
    click('[data-testid="assets-lib-tree-root"]')
    await flush()
    click('[data-testid="assets-lib-tree-session-images"]')
    await flush()
    expect(calls.count).toBe(1)
  })
})

describe('[2] 空态与失败', () => {
  it('无分组=空态引导（前台会话上传的图按会话归档）', async () => {
    const { client } = makeImagesFixture({ groups: [] })
    resetSessionImagesForTests(client)
    mountView()
    await flush()
    click('[data-testid="assets-lib-tree-session-images"]')
    await flush()

    const empty = q('[data-testid="my-files-session-images-empty"]')
    expect(empty.textContent).toContain('暂无会话图片')
    expect(empty.textContent).toContain('前台会话')
  })

  it('失败=错误行内+重试再取', async () => {
    const { client, calls } = makeImagesFixture({ fail: true })
    resetSessionImagesForTests(client)
    mountView()
    await flush()
    click('[data-testid="assets-lib-tree-session-images"]')
    await flush()

    expect(q('[data-testid="my-files-session-images-error"]').textContent).toContain('会话图片加载失败')
    click('[data-testid="my-files-session-images-retry"]')
    await flush()
    expect(calls.count).toBe(2)
  })
})

describe('[3] 视图互斥与只读红线', () => {
  it('会话图片↔回收站切换复位；素材库写操作零调用', async () => {
    const { client } = makeImagesFixture({
      groups: [
        groupOf('s-1', '单子', [{ blobRef: 'c'.repeat(64), name: 'attachment-cccc.png', mime: 'image/png', width: 10, height: 10 }]),
      ],
    })
    resetSessionImagesForTests(client)
    mountView()
    await flush()

    // 进入会话图片→回收站按钮（返回浏览态）互斥复位
    click('[data-testid="assets-lib-tree-session-images"]')
    await flush()
    expect(q('[data-testid="my-files-session-images"]')).toBeDefined()
    click('[data-testid="assets-lib-trash-toggle"]')
    await flush()
    expect(document.querySelector('[data-testid="my-files-session-images"]')).toBeNull()
    expect(q('[data-testid="assets-lib-empty"]').textContent).toContain('回收站为空')

    // 只读红线：fake adminApi 写面零调用（rename/move/softDelete/restore/purge）
    const counts = holder.current!.state.calls
    expect(counts.assetsLibRename).toHaveLength(0)
    expect(counts.assetsLibMove).toHaveLength(0)
    expect(counts.assetsLibSoftDelete).toHaveLength(0)
    expect(counts.assetsLibRestore).toHaveLength(0)
    expect(counts.assetsLibPurge).toBe(0)
  })
})
