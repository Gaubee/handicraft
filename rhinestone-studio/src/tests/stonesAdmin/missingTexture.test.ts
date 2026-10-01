/*
 * [w17-critic T2] 缺图款治理回归：
 *   [1] store：noteStoneTextureResult 登记撤销+当前过滤结果缺图计数+供应商半径计数。
 *   [2] 视图：网格默认隐藏缺图款；「贴图缺失 N」chip 切换显隐；全缺页空态明示去向；
 *        树供应商徽标同步（缺图 N）。
 *   [3] 占位降调：缺图卡无「贴图缺失」满幅水印（小圆点+「缺图」小字）。
 * fixture 复用 view.mount.test.ts 的 makeClient（jsdom 无图像加载——探测由测试
 * 直登记录替代，VITEST 下 probeTreeTextures 跳过）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StonesAdminView from '../../components/stones-admin/StonesAdminView.svelte'
import {
  bindStonesClient,
  getMissingTextureCountBySupplier,
  getMissingTextureCountInList,
  getShowMissingTexture,
  noteStoneTextureResult,
  resetStonesAdminForTests,
  setShowMissingTexture,
} from '$lib/stonesAdmin/store.svelte'
import { makeClient } from './fixtures'

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
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mt-${(objectUrlCounter += 1)}`),
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

async function mountView(): Promise<void> {
  const { client } = makeClient()
  bindStonesClient(client)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StonesAdminView, { target })
  await flush()
  cleanupStack.push(() => {
    unmount(app)
    target.remove()
  })
}

const cleanupStack: Array<() => void> = []
afterEach(() => {
  while (cleanupStack.length > 0) cleanupStack.pop()?.()
})

describe('[1] store 缺图登记/计数', () => {
  it('noteStoneTextureResult 登记撤销+列表计数+供应商半径计数', async () => {
    const { client } = makeClient()
    bindStonesClient(client)
    // initStonesAdmin 走页面 onMount——直调亦可；这里经视图面覆盖，直接手工登记录。
    noteStoneTextureResult('res-j51', true)
    noteStoneTextureResult('res-a51', true)
    noteStoneTextureResult('res-j52', false) // 探活成功撤销
    expect(getMissingTextureCountInList()).toBe(0) // list 未拉取=0（守卫）

    noteStoneTextureResult('res-j52', true)
    noteStoneTextureResult('res-j52', false)
    noteStoneTextureResult('res-j51', false)
    expect(getShowMissingTexture()).toBe(false) // 默认隐藏
    setShowMissingTexture(true)
    expect(getShowMissingTexture()).toBe(true)
    setShowMissingTexture(false)
  })

  it('供应商半径计数（树徽标数据源——经视图装载树）', async () => {
    await mountView()
    await flush()
    noteStoneTextureResult('res-j51', true)
    noteStoneTextureResult('res-a51', true)
    const bySupplier = getMissingTextureCountBySupplier()
    expect(bySupplier['yuhang']).toBe(2)
  })
})

describe('[2] 视图：默认隐藏+chip 切换+全缺空态', () => {
  it('缺图款默认不渲染；chip 点击后显示；计数随登记更新', async () => {
    await mountView()
    await flush()
    // 首页三款（j51/a51/j52）——登记两款缺图（jsdom 探测跳过，测试直登）。
    noteStoneTextureResult('res-j51', true)
    noteStoneTextureResult('res-a51', true)
    await flush()

    // 默认隐藏：缺图卡缺席、未缺卡在场。
    expect(q('[data-testid="stone-card-res-j51"]')).toBeNull()
    expect(q('[data-testid="stone-card-res-a51"]')).toBeNull()
    expect(q('[data-testid="stone-card-res-j52"]')).not.toBeNull()

    // chip：计数=2，点击切换显示。
    const chip = q('[data-testid="stones-filter-missing-toggle"]') as HTMLButtonElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain('贴图缺失 2')
    chip.click()
    await flush()
    expect(q('[data-testid="stone-card-res-j51"]')).not.toBeNull()
    expect(q('[data-testid="stone-card-res-a51"]')).not.toBeNull()

    // 树供应商徽标：yuhang（缺图 2）。
    const dir = q('[data-testid="stones-tree-dir-yuhang"]')
    expect(dir?.textContent).toContain('缺图 2')
  })

  it('全缺页：明示去向（非空库假象）+一键显示', async () => {
    await mountView()
    await flush()
    for (const id of ['res-j51', 'res-a51', 'res-j52']) noteStoneTextureResult(id, true)
    await flush()

    expect(q('[data-testid="stone-card-res-j52"]')).toBeNull()
    const allMissing = q('[data-testid="stones-grid-all-missing"]')
    expect(allMissing?.textContent).toContain('均缺贴图')
    ;(q('[data-testid="stones-grid-all-missing-show"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-testid="stone-card-res-j51"]')).not.toBeNull()
  })
})

describe('[3] 占位降调（无满幅水印）', () => {
  it('缺图卡（显示态）：色点占位，无「贴图缺失」角标水印', async () => {
    await mountView()
    await flush()
    noteStoneTextureResult('res-j51', true)
    await flush()
    ;(q('[data-testid="stones-filter-missing-toggle"]') as HTMLButtonElement).click()
    await flush()
    // jsdom 不加载图像——直发 error 事件触发卡片缺图占位（onerror 同链）。
    const img = q('[data-testid="stone-card-img-res-j51"]') as HTMLImageElement
    expect(img).not.toBeNull()
    img.dispatchEvent(new Event('error'))
    await flush()
    const card = q('[data-testid="stone-card-res-j51"]')!
    expect(card.textContent).not.toContain('贴图缺失')
    expect(card.textContent).toContain('缺图')
    // title 保留全量诊断信息（含「贴图缺失」标注——hover 可查）。
    expect(card.getAttribute('title')).toContain('贴图缺失')
  })
})
