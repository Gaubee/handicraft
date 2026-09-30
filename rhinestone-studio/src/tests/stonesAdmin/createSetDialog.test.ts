/*
 * CreateSetDialog 组件测试（restructure-materials-story W2a，tasks 2.2）。
 * 契约冻结面：props { open, onclose, ownerScope: 'market'|'personal', oncreated(set) }。
 * 覆盖：渲染（ownerScope 文案分叉）、搜索防抖（300ms 窗口内零查询/窗口后服务端
 * stones 查询、空输入不查询）、结果多选、已选区数量编辑（0=按设计用量另计→
 * 提交不传 quantity）、提交调 sets.create（manual-pick 成员形态）→ oncreated+
 * onclose、校验（空名/零成员）、create 失败错误条（对话框保持打开）。
 * 数据面 mock：stonesAdmin fixtures makeClient（搜索读面）+ 本目录
 * makeMarketSetsClient（sets 面）。jsdom 桩：ResizeObserver。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import CreateSetDialog from '../../components/stones-admin/CreateSetDialog.svelte'
import {
  bindStonesClient,
  bindStonesMarketSetsClient,
  resetStonesAdminForTests,
} from '$lib/stonesAdmin/store.svelte'
import { makeClient, type FixtureCalls } from './fixtures'
import { makeMarketSetsClient, type MarketSetsFixtureCalls } from './sets.fixtures'

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

let stonesCalls: FixtureCalls
let setsCalls: MarketSetsFixtureCalls

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetStonesAdminForTests()
  const stones = makeClient()
  stonesCalls = stones.calls
  const sets = makeMarketSetsClient()
  setsCalls = sets.calls
  bindStonesClient(stones.client)
  // sets 面经 store.createStoneSet 惰性取绑定客户端——直接绑 fixture。
  bindStonesMarketSetsClient(sets.client)
})

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  document.body.innerHTML = ''
})

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function qq(selector: string): Element[] {
  return [...document.querySelectorAll(selector)]
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

interface DialogHandles {
  onclose: ReturnType<typeof vi.fn>
  oncreated: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountDialog(ownerScope: 'market' | 'personal' = 'market'): Promise<DialogHandles> {
  const onclose = vi.fn()
  const oncreated = vi.fn()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(CreateSetDialog, { target, props: { open: true, onclose, ownerScope, oncreated } })
  await flush()
  return { onclose, oncreated, unmount: () => { unmount(app); target.remove() } }
}

// ---------------------------------------------------------------------------
// 渲染（ownerScope 文案分叉）
// ---------------------------------------------------------------------------

describe('CreateSetDialog 渲染', () => {
  it('market：标题「添加组合（材料市场）」+名称/搜索/已选空态/提交按钮在场', async () => {
    const h = await mountDialog('market')
    const dialog = q('[data-testid="create-set-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-ownerscope')).toBe('market')
    expect(dialog?.textContent).toContain('添加组合（材料市场）')
    expect(q('[data-testid="create-set-name"]')).not.toBeNull()
    expect(q('[data-testid="create-set-search"]')).not.toBeNull()
    expect(q('[data-testid="create-set-picked-empty"]')).not.toBeNull()
    expect(q('[data-testid="create-set-submit"]')).not.toBeNull()
    h.unmount()
  })

  it('personal：标题「创建组合（我的材料）」（挂载方传参——owner 语义不在 Dialog 内猜）', async () => {
    const h = await mountDialog('personal')
    expect(q('[data-testid="create-set-dialog"]')?.getAttribute('data-ownerscope')).toBe('personal')
    expect(q('[data-testid="create-set-dialog"]')?.textContent).toContain('创建组合（我的材料）')
    h.unmount()
  })

  it('关闭按钮 → onclose 回调', async () => {
    const h = await mountDialog()
    click('[data-testid="create-set-close"]')
    await flush()
    expect(h.onclose).toHaveBeenCalledTimes(1)
    h.unmount()
  })
})

// ---------------------------------------------------------------------------
// 搜索防抖 + 服务端查询（992 款库严禁全量拉）
// ---------------------------------------------------------------------------

describe('CreateSetDialog 钻挑选器', () => {
  it('防抖 300ms：窗口内零查询；窗口后 stones.list 收到 q（page 1/pageSize 20/includeTrashed=false——非全量）', async () => {
    const h = await mountDialog()
    type('[data-testid="create-set-search"]', '象牙')
    await flush(60)
    expect(stonesCalls.list).toHaveLength(0) // 防抖窗口内零查询
    await flush(300)
    expect(stonesCalls.list).toHaveLength(1)
    expect(stonesCalls.list[0]!.q).toBe('象牙')
    expect(stonesCalls.list[0]!.page).toBe(1)
    expect(stonesCalls.list[0]!.pageSize).toBe(20)
    expect(stonesCalls.list[0]!.includeTrashed).toBe(false)
    h.unmount()
  })

  it('空输入清零不查询（空=不查询——严禁全量拉取）', async () => {
    const h = await mountDialog()
    type('[data-testid="create-set-search"]', '象牙')
    await flush(360)
    expect(stonesCalls.list).toHaveLength(1)
    type('[data-testid="create-set-search"]', '')
    await flush(360)
    expect(stonesCalls.list).toHaveLength(1) // 清空只清结果，不发起新查询
    expect(q('[data-testid="create-set-results-empty"]')?.textContent).toContain('输入关键字')
    h.unmount()
  })

  it('结果列表：贴图缩略+SKU+供应商+尺寸', async () => {
    const h = await mountDialog()
    type('[data-testid="create-set-search"]', '象牙')
    await flush(360)
    const row = q('[data-testid="create-set-result-res-j51"]')
    expect(row).not.toBeNull()
    expect(row?.querySelector('img')?.getAttribute('src')).toBe('/api/stones/res-j51/texture.png')
    expect(row?.textContent).toContain('J51')
    expect(row?.textContent).toContain('yuhang')
    expect(row?.textContent).toContain('2mm')
    h.unmount()
  })

  it('多选：两条结果进已选区；数量 Input 默认 0；移除按钮出清', async () => {
    const h = await mountDialog()
    type('[data-testid="create-set-search"]', '象牙')
    await flush(360)
    click('[data-testid="create-set-result-res-j51"]')
    click('[data-testid="create-set-result-res-a51"]')
    await flush()
    expect(q('[data-testid="create-set-picked-res-j51"]')).not.toBeNull()
    expect(q('[data-testid="create-set-picked-res-a51"]')).not.toBeNull()
    expect((q('[data-testid="create-set-qty-res-j51"]') as HTMLInputElement)?.value).toBe('0')
    click('[data-testid="create-set-remove-res-a51"]')
    await flush()
    expect(q('[data-testid="create-set-picked-res-a51"]')).toBeNull()
    expect(qq('[data-testid^="create-set-picked-res-"]').length).toBe(1)
    h.unmount()
  })
})

// ---------------------------------------------------------------------------
// 提交面（sets.create 契约对齐）
// ---------------------------------------------------------------------------

describe('CreateSetDialog 提交', () => {
  it('成功：sets.create 收 { name, members（数量 0=不传 quantity、正数=透传）, origin: manual-pick } → oncreated({resourceId,name}) + onclose', async () => {
    const h = await mountDialog()
    type('[data-testid="create-set-name"]', '圣诞雪人款')
    type('[data-testid="create-set-search"]', '象牙')
    await flush(360)
    click('[data-testid="create-set-result-res-j51"]')
    click('[data-testid="create-set-result-res-a51"]')
    await flush()
    type('[data-testid="create-set-qty-res-j51"]', '5')
    await flush()
    click('[data-testid="create-set-submit"]')
    await flush()
    expect(setsCalls.create).toHaveLength(1)
    expect(setsCalls.create[0]).toEqual({
      name: '圣诞雪人款',
      members: [{ stoneRef: 'res-j51', quantity: 5 }, { stoneRef: 'res-a51' }],
      origin: { kind: 'manual-pick' },
    })
    expect(h.oncreated).toHaveBeenCalledWith({ resourceId: 'set-created-1', name: '圣诞雪人款' })
    expect(h.onclose).toHaveBeenCalledTimes(1)
    h.unmount()
  })

  it('校验：空名 → 错误条+零 create；仅有名零成员 → 错误条+零 create', async () => {
    const h = await mountDialog()
    click('[data-testid="create-set-submit"]')
    await flush()
    expect(q('[data-testid="create-set-error"]')?.textContent).toContain('组合名不能为空')
    expect(setsCalls.create).toHaveLength(0)

    type('[data-testid="create-set-name"]', '空成员组合')
    click('[data-testid="create-set-submit"]')
    await flush()
    expect(q('[data-testid="create-set-error"]')?.textContent).toContain('至少一个成员')
    expect(setsCalls.create).toHaveLength(0)
    h.unmount()
  })

  it('create 失败：错误条在场、onclose 零调用（对话框保持打开）', async () => {
    const failing = makeMarketSetsClient({ failCreateWith: { message: '组合服务暂不可用', code: 'server-unavailable' } })
    bindStonesMarketSetsClient(failing.client)
    const h = await mountDialog()
    type('[data-testid="create-set-name"]', '失败组合')
    type('[data-testid="create-set-search"]', '象牙')
    await flush(360)
    click('[data-testid="create-set-result-res-j51"]')
    await flush()
    click('[data-testid="create-set-submit"]')
    await flush()
    expect(q('[data-testid="create-set-error"]')?.textContent).toContain('组合服务暂不可用')
    expect(h.onclose).not.toHaveBeenCalled()
    expect(q('[data-testid="create-set-dialog"]')).not.toBeNull()
    h.unmount()
  })
})
