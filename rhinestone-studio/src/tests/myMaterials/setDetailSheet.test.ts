/*
 * [Owner 验收 2026-09-30] 组合详情面板（SetDetailSheet）+ MySetsSection 点击接线测试。
 * Owner 验收缺口：「点我的材料中『客户全色系生产组合 2026-09』没有任何反应」——
 * 卡片应可点开右滑出详情 Sheet 预览组合「文件/文件夹」。覆盖：
 *   [1] 卡片点击（含键盘 Enter/Space）→ Sheet 打开：头部（名称/成员数徽标/用途/
 *       更新时间）+ sets.get(resourceId) 调用形态。
 *   [2] resolved 成员轻量卡（贴图/SKU/供应商/数量）与缺图成员占位（五态中文标签
 *       +限定名/短 ref——fixture 解析对齐 daemon resolveMember）。
 *   [3] 大成员量分块渐进（130 成员：首屏 60 → 加载更多 ×2 → 全量收口）。
 *   [4] 关闭（关闭按钮/Escape）与错误态+重试、空成员防御态。
 *   [5] 删除按钮 stopPropagation——不开详情（确认 Dialog 在场）。
 * 数据面：stonesAdmin sets.fixtures 内存 SetsClient（复用形态——不 ship 到 lib）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import MySetsSection from '../../components/my-materials/MySetsSection.svelte'
import { resetMySetsForTests } from '$lib/myMaterials/sets.svelte'
import { resetSessionForTests } from '$lib/stores/session.svelte'
import { makeCell } from '../stonesAdmin/fixtures'
import { makeMarketSetsClient, type MarketSetsFixtureCalls, type MarketFixtureSet } from '../stonesAdmin/sets.fixtures'
import type { WarehouseSetsClient } from '$lib/warehouse/client'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

// jsdom 未实现 ResizeObserver；bits-ui Sheet 覆盖层组件内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function mountSection(client: WarehouseSetsClient): void {
  resetMySetsForTests(client)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(MySetsSection, { target })
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

function keydown(selector: string, key: 'Enter' | ' '): void {
  q(selector).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

/** 面板内已渲染成员卡数（网格直接子级——img 子 testid 不计入）。 */
function renderedMemberCount(): number {
  return document.querySelectorAll('[data-testid="my-set-detail-grid"] > [data-testid^="my-set-detail-member-"]').length
}

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  sessionStorage.clear()
  localStorage.clear()
  resetSessionForTests({ username: 'worker', role: 'user' })
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  resetMySetsForTests()
})

/** 默认组合集：全色系组合（resolved×2 含数量）+ 缺图组合（三非 resolved 态）。 */
function defaultSets(): MarketFixtureSet[] {
  return [
    {
      resourceId: 'set-full',
      name: '客户全色系生产组合 2026-09',
      purpose: '2026-09 全色系订单交付',
      members: [
        { stoneRef: 'res-j51', cell: makeCell({ resourceId: 'res-j51', sku: 'J51', supplier: 'yuhang' }), quantity: 3 },
        { stoneRef: 'res-b52', cell: makeCell({ resourceId: 'res-b52', sku: 'B52', supplier: 'factoryB', name: '香槟金 · 2mm', styleName: '香槟金', family: '金色系', colorHex: '#D4AF37' }) },
      ],
    },
    {
      resourceId: 'set-broken',
      name: '缺图组合',
      members: [
        { stoneRef: 'res-x9', state: 'not-found' },
        { stoneRef: 'res-b7', state: 'blob-missing', cell: makeCell({ resourceId: 'res-b7', sku: 'B7', supplier: 'yuhang' }), quantity: 4 },
        { stoneRef: 'res-d2', state: 'soft-deleted', cell: makeCell({ resourceId: 'res-d2', sku: 'D2', supplier: 'factoryB' }) },
      ],
    },
  ]
}

interface Fixture {
  client: WarehouseSetsClient
  calls: MarketSetsFixtureCalls
}

function makeFixture(sets?: MarketFixtureSet[]): Fixture {
  const fixture = makeMarketSetsClient({ sets: sets ?? defaultSets() })
  return { client: fixture.client, calls: fixture.calls }
}

describe('组合详情面板（Owner 验收 2026-09-30）', () => {
  it('卡片点击打开面板：头部（名称/成员数/用途/更新时间）+ sets.get 调用形态', async () => {
    const fixture = makeFixture()
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-full"]')
    await flush()

    // 数据面：详情读面经绑定 client 直通 sets.get(resourceId)
    expect(fixture.calls.get).toEqual(['set-full'])
    const sheet = q('[data-testid="my-set-detail-sheet"]')
    expect(sheet.textContent).toContain('客户全色系生产组合 2026-09')
    expect(q('[data-testid="my-set-detail-count"]').textContent).toContain('2 款钻')
    expect(q('[data-testid="my-set-detail-purpose"]').textContent).toContain('2026-09 全色系订单交付')
    expect(sheet.textContent).toContain('更新于')
  })

  it('resolved 成员轻量卡：贴图/SKU/供应商/数量（按设计用量另计缺省）', async () => {
    const fixture = makeFixture()
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-full"]')
    await flush()

    const member = q('[data-testid="my-set-detail-member-res-j51"]')
    expect(member.textContent).toContain('J51')
    expect(member.textContent).toContain('yuhang')
    expect(member.textContent).toContain('数量 3')
    const img = q('[data-testid="my-set-detail-member-img-res-j51"]') as HTMLImageElement
    expect(img.getAttribute('src')).toContain('/api/stones/res-j51/texture.png')
    // 数量缺省成员：按设计用量另计（§7.1）
    expect(q('[data-testid="my-set-detail-member-res-b52"]').textContent).toContain('按设计用量另计')
  })

  it('缺图成员如实占位：五态中文标签+限定名/短 ref（不伪造钻卡）', async () => {
    const fixture = makeFixture()
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-broken"]')
    await flush()

    // not-found（索引未知——双缺退短 ref）
    const notFound = q('[data-testid="my-set-detail-member-res-x9"]')
    expect(notFound.textContent).toContain('成员不存在')
    expect(notFound.textContent).toContain('未解析/res-x9')
    expect(notFound.textContent).toContain('无贴图')
    // blob-missing（索引已知——限定名回填）
    const blobMissing = q('[data-testid="my-set-detail-member-res-b7"]')
    expect(blobMissing.textContent).toContain('贴图缺失')
    expect(blobMissing.textContent).toContain('yuhang/B7')
    expect(blobMissing.textContent).toContain('数量 4')
    // soft-deleted（索引已知——限定名回填）
    expect(q('[data-testid="my-set-detail-member-res-d2"]').textContent).toContain('成员已软删')
  })

  it('大成员量分块渐进：130 成员首屏 60 → 加载更多渐进 → 全量收口', async () => {
    const members = Array.from({ length: 130 }, (_, index) => ({
      stoneRef: `res-m${index}`,
      quantity: (index % 3) + 1,
    }))
    const fixture = makeFixture([{ resourceId: 'set-huge', name: '全色系巨组合', members }])
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-huge"]')
    await flush()

    // 首屏 60（严禁一次渲染 130）
    expect(renderedMemberCount()).toBe(60)
    const more = q('[data-testid="my-set-detail-load-more"]')
    expect(more.textContent).toContain('60/130')

    more.click()
    await flush()
    expect(renderedMemberCount()).toBe(120)

    click('[data-testid="my-set-detail-load-more"]')
    await flush()
    // 末块收口：全量在场+按钮退场
    expect(renderedMemberCount()).toBe(130)
    expect(document.querySelector('[data-testid="my-set-detail-load-more"]')).toBeNull()
    expect(q('[data-testid="my-set-detail-all-loaded"]').textContent).toContain('130')
  })

  it('关闭：关闭按钮/Escape 关面板', async () => {
    const fixture = makeFixture()
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-full"]')
    await flush()
    expect(q('[data-testid="my-set-detail-sheet"]')).toBeDefined()

    click('[data-testid="my-set-detail-close"]')
    await flush()
    expect(document.querySelector('[data-testid="my-set-detail-sheet"]')).toBeNull()

    // Escape（bits-ui document 键监听 → onOpenChange → onclose）
    click('[data-testid="my-sets-card-set-full"]')
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(document.querySelector('[data-testid="my-set-detail-sheet"]')).toBeNull()
  })

  it('错误态+重试：get 失败呈错误与重试，重试后成员在场', async () => {
    const base = makeFixture()
    let failFirst = true
    const flaky: WarehouseSetsClient = {
      ...base.client,
      get: async (resourceId: string) => {
        if (failFirst) {
          failFirst = false
          throw new Error('组合/套装库 RPC 连接失败（daemon 不可达）')
        }
        return base.client.get(resourceId)
      },
    }
    mountSection(flaky)
    await flush()

    click('[data-testid="my-sets-card-set-full"]')
    await flush()

    const error = q('[data-testid="my-set-detail-error"]')
    expect(error.textContent).toContain('成员装载失败')
    expect(error.textContent).toContain('daemon 不可达')
    expect(document.querySelector('[data-testid="my-set-detail-grid"]')).toBeNull()

    click('[data-testid="my-set-detail-retry"]')
    await flush()
    expect(q('[data-testid="my-set-detail-grid"]')).toBeDefined()
    expect(q('[data-testid="my-set-detail-member-res-j51"]')).toBeDefined()
  })

  it('空成员防御态：契约面空成员拒——面板如实呈现不崩', async () => {
    const fixture = makeFixture([{ resourceId: 'set-void', name: '空组合', members: [] }])
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-void"]')
    await flush()

    expect(q('[data-testid="my-set-detail-empty"]').textContent).toContain('组合暂无成员')
  })

  it('键盘可达：Enter/Space 打开面板', async () => {
    const fixture = makeFixture()
    mountSection(fixture.client)
    await flush()

    keydown('[data-testid="my-sets-card-set-full"]', 'Enter')
    await flush()
    expect(q('[data-testid="my-set-detail-sheet"]')).toBeDefined()
    click('[data-testid="my-set-detail-close"]')
    await flush()

    keydown('[data-testid="my-sets-card-set-full"]', ' ')
    await flush()
    expect(q('[data-testid="my-set-detail-sheet"]')).toBeDefined()
  })

  it('删除按钮 stopPropagation：点击删除不开详情（确认 Dialog 在场）', async () => {
    const fixture = makeFixture()
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-delete-set-full"]')
    await flush()

    expect(q('[data-testid="my-sets-delete-dialog"]').textContent).toContain('删除组合 · 客户全色系生产组合 2026-09')
    expect(document.querySelector('[data-testid="my-set-detail-sheet"]')).toBeNull()
    expect(fixture.calls.get).toHaveLength(0)
  })
})
