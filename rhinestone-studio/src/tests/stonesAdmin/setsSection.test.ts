/*
 * 材料市场左栏组合分区 + 成员网格切换测试（restructure-materials-story W2a，
 * tasks 2.1/2.3）。覆盖：分区渲染（段头/添加按钮/组合行=名称+成员数徽标/默认展开）、
 * 点组合行→右侧网格切换成员钻卡（sets.get 快照；resolved 复用 StoneCard、缺图
 * 成员如实占位）、选中态与供应商树互斥（点供应商节点回钻型网格+取消组合选中）、
 * 分区折叠、组合列表加载失败（错误条在场、钻库网格不受影响）、添加组合端到端
 * （CreateSetDialog 提交→新组合行在场+网格切到新组合成员）。
 * 数据面 mock：stonesAdmin fixtures makeClient + 本目录 makeMarketSetsClient。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StonesAdminView from '../../components/stones-admin/StonesAdminView.svelte'
import {
  bindStonesClient,
  bindStonesMarketSetsClient,
  initStonesMarketSets,
  resetStonesAdminForTests,
} from '$lib/stonesAdmin/store.svelte'
import { resetImportWizardForTests } from '$lib/stonesAdmin/wizard.svelte'
import { makeCell, makeClient } from './fixtures'
import { makeMarketSetsClient, type MarketSetsFixtureCalls, type MarketFixtureSet } from './sets.fixtures'

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  resetStonesAdminForTests()
  resetImportWizardForTests()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:wiz-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function click(selector: string): void {
  const el = q(selector)
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function type(selector: string, value: string): void {
  const el = q(selector) as HTMLInputElement | null
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.value = value
  el!.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 默认组合集：圣诞雪人款 3 resolved 成员 + 缺图组合（not-found/blob-missing）。 */
function defaultSets(): MarketFixtureSet[] {
  return [
    {
      resourceId: 'set-snow',
      name: '圣诞雪人款',
      members: [
        { stoneRef: 'res-j51', cell: makeCell({ resourceId: 'res-j51' }) },
        { stoneRef: 'res-a51', cell: makeCell({ resourceId: 'res-a51', sku: 'A51', name: '象牙白 · 3mm', sizeMm: 3, textureUrl: '/api/stones/res-a51/texture.png' }) },
        { stoneRef: 'res-j52', cell: makeCell({ resourceId: 'res-j52', sku: 'J52', name: '米白 · 2mm', styleName: '米白', textureUrl: '/api/stones/res-j52/texture.png' }), quantity: 12 },
      ],
    },
    {
      resourceId: 'set-broken',
      name: '缺图组合',
      members: [
        { stoneRef: 'res-x9', state: 'not-found' },
        { stoneRef: 'res-b7', state: 'blob-missing', cell: makeCell({ resourceId: 'res-b7', sku: 'B7' }), quantity: 4 },
      ],
    },
  ]
}

interface ViewHandles {
  unmount: () => void
  stonesListCalls: number
  setsCalls: MarketSetsFixtureCalls
}

async function mountView(options: { sets?: MarketFixtureSet[]; failListWith?: string } = {}): Promise<ViewHandles> {
  const stones = makeClient()
  const setsFixture = makeMarketSetsClient({ sets: options.sets ?? defaultSets(), ...(options.failListWith !== undefined ? { failListWith: options.failListWith } : {}) })
  resetStonesAdminForTests()
  bindStonesClient(stones.client)
  bindStonesMarketSetsClient(setsFixture.client)
  // 视图 onMount 在 vitest 下跳过组合自动初始化（生产绑缺省 RPC）——显式装载。
  await initStonesMarketSets(setsFixture.client)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StonesAdminView, { target })
  await flush()
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
    stonesListCalls: 0,
    setsCalls: setsFixture.calls,
  }
}

// ---------------------------------------------------------------------------
// 左栏组合分区渲染
// ---------------------------------------------------------------------------

describe('材料市场左栏组合分区', () => {
  it('分区在场：段头「组合」+添加按钮+组合行（名称+成员数徽标）；默认展开（aria-expanded）', async () => {
    const { unmount } = await mountView()
    expect(q('[data-testid="stones-sets-section"]')).not.toBeNull()
    expect(q('[data-testid="stones-sets-section"]')?.textContent).toContain('组合')
    expect(q('[data-testid="stones-set-add"]')).not.toBeNull()
    expect(q('[data-testid="stones-sets-toggle"]')?.getAttribute('aria-expanded')).toBe('true')

    const row = q('[data-testid="stones-set-row-set-snow"]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('圣诞雪人款')
    expect(row?.textContent).toContain('3')
    expect(q('[data-testid="stones-set-row-set-broken"]')?.textContent).toContain('缺图组合')
    unmount()
  })

  it('sets.list 读面：includeTrashed=false（软删组合不进分区）+pageSize 200', async () => {
    const { unmount, setsCalls } = await mountView()
    expect(setsCalls.list.length).toBeGreaterThanOrEqual(1)
    expect(setsCalls.list[0]!.includeTrashed).toBe(false)
    expect(setsCalls.list[0]!.pageSize).toBe(200)
    unmount()
  })

  it('折叠：段头 toggle 收起组合行（分区头仍在场）', async () => {
    const { unmount } = await mountView()
    click('[data-testid="stones-sets-toggle"]')
    await flush()
    expect(q('[data-testid="stones-set-row-set-snow"]')).toBeNull()
    expect(q('[data-testid="stones-sets-section"]')).not.toBeNull()
    expect(q('[data-testid="stones-sets-toggle"]')?.getAttribute('aria-expanded')).toBe('false')
    unmount()
  })

  it('组合列表加载失败：分区错误条在场，钻库网格不受影响（网格模式 tree+样卡在场）', async () => {
    const { unmount } = await mountView({ failListWith: '组合服务不可达' })
    expect(q('[data-testid="stones-sets-error"]')?.textContent).toContain('组合服务不可达')
    expect(q('main[data-testid="stones-grid-mode-tree"]')).not.toBeNull()
    expect(q('[data-testid="stone-card-res-j51"]')).not.toBeNull()
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 组合选中态网格切换 + 互斥
// ---------------------------------------------------------------------------

describe('组合选中态网格切换', () => {
  it('点组合行 → stones-grid-mode-set + sets.get 快照成员钻卡（resolved 复用 StoneCard）+行选中态+状态条成员计数', async () => {
    const { unmount, setsCalls } = await mountView()
    expect(q('main[data-testid="stones-grid-mode-tree"]')).not.toBeNull()
    click('[data-testid="stones-set-row-set-snow"]')
    await flush()
    expect(q('main[data-testid="stones-grid-mode-set"]')).not.toBeNull()
    expect(setsCalls.get).toContain('set-snow')
    expect(q('[data-testid="stones-set-view"]')?.textContent).toContain('圣诞雪人款')
    // resolved 成员复用 StoneCard（贴图 URL/SKU 投影）
    for (const id of ['res-j51', 'res-a51', 'res-j52']) {
      const card = q(`[data-testid="stone-card-${id}"]`)
      expect(card, `成员 ${id} 钻卡应存在`).not.toBeNull()
    }
    expect(q('[data-testid="stone-card-img-res-j51"]')?.getAttribute('src')).toBe('/api/stones/res-j51/texture.png')
    expect(q('[data-testid="stone-card-res-j52"]')?.textContent).toContain('J52')
    // 行选中态 + 状态条
    expect(q('[data-testid="stones-set-row-set-snow"]')?.getAttribute('aria-current')).toBe('true')
    expect(q('[data-testid="stones-status-count"]')?.textContent).toContain('3 项成员')
    expect(q('[data-testid="stones-readscope"]')?.textContent).toContain('sets.get')
    unmount()
  })

  it('互斥：组合模式下点供应商树节点 → 回钻型网格+组合行取消选中+树节点激活', async () => {
    const { unmount, setsCalls } = await mountView()
    click('[data-testid="stones-set-row-set-snow"]')
    await flush()
    expect(q('main[data-testid="stones-grid-mode-set"]')).not.toBeNull()

    click('[data-testid="stones-tree-select-yuhang"]')
    await flush()
    expect(q('main[data-testid="stones-grid-mode-tree"]')).not.toBeNull()
    expect(q('[data-testid="stones-set-row-set-snow"]')?.getAttribute('aria-current')).toBeNull()
    expect(q('[data-testid="stones-tree-select-yuhang"]')?.className).toContain('bg-accent')
    expect(setsCalls.get).toContain('set-snow')
    unmount()
  })

  it('返回钻库按钮：组合视图退出回钻型网格', async () => {
    const { unmount } = await mountView()
    click('[data-testid="stones-set-row-set-snow"]')
    await flush()
    expect(q('main[data-testid="stones-grid-mode-set"]')).not.toBeNull()
    click('[data-testid="stones-set-exit"]')
    await flush()
    expect(q('main[data-testid="stones-grid-mode-tree"]')).not.toBeNull()
    expect(q('[data-testid="stone-card-res-j51"]')).not.toBeNull()
    unmount()
  })

  it('缺图成员如实占位：not-found/blob-missing 呈状态标签+限定名/短 ref+数量，不伪造钻卡', async () => {
    const { unmount } = await mountView()
    click('[data-testid="stones-set-row-set-broken"]')
    await flush()
    const missing = q('[data-testid="stones-set-member-missing-res-x9"]')
    expect(missing).not.toBeNull()
    expect(missing?.textContent).toContain('成员不存在')
    expect(missing?.textContent).toContain('未解析/') // not-found 限定名缺席——短 ref 兜底
    expect(q('[data-testid="stone-card-res-x9"]')).toBeNull()

    const blobMissing = q('[data-testid="stones-set-member-missing-res-b7"]')
    expect(blobMissing).not.toBeNull()
    expect(blobMissing?.textContent).toContain('贴图缺失')
    expect(blobMissing?.textContent).toContain('yuhang/B7') // stone_index 限定名投影
    expect(blobMissing?.textContent).toContain('数量 4')
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 添加组合端到端（CreateSetDialog 集成）
// ---------------------------------------------------------------------------

describe('添加组合端到端', () => {
  it('点「+」→ CreateSetDialog（ownerScope=market）→ 名称+搜索+多选+数量 → 提交后新组合行在场+网格切到新组合成员', async () => {
    const { unmount, setsCalls } = await mountView()
    click('[data-testid="stones-set-add"]')
    await flush()
    const dialog = q('[data-testid="create-set-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-ownerscope')).toBe('market')

    type('[data-testid="create-set-name"]', '客户全色系生产组合')
    type('[data-testid="create-set-search"]', '象牙')
    await flush(360)
    click('[data-testid="create-set-result-res-j51"]')
    await flush()
    type('[data-testid="create-set-qty-res-j51"]', '8')
    await flush()
    click('[data-testid="create-set-submit"]')
    await flush(60)

    expect(setsCalls.create).toHaveLength(1)
    expect(setsCalls.create[0]!.name).toBe('客户全色系生产组合')
    expect(setsCalls.create[0]!.members).toEqual([{ stoneRef: 'res-j51', quantity: 8 }])
    // 新组合行在场（sets.list 重拉）+ 网格切到新组合成员视图
    const row = q('[data-testid="stones-set-row-set-created-1"]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('客户全色系生产组合')
    expect(q('main[data-testid="stones-grid-mode-set"]')).not.toBeNull()
    expect(q('[data-testid="stones-set-view"]')?.textContent).toContain('客户全色系生产组合')
    expect(q('[data-testid="stone-card-res-j51"]')).not.toBeNull()
    unmount()
  })
})
