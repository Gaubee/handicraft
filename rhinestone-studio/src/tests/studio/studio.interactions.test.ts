/*
[2026-09-18 Test] 改版交互红点（R2–R4）：
1. 块详情置顶常驻（PM-B3/P0-4：选中即在手边，DOM 顺序先于块列表）
2. 底部参数抽屉（R4：[块][物理][色板] 入口开 bottom sheet）
3. 策略单一真源（PM-B4/P0-2：导出条只读回显，点对比卡切换）
4. 画布空态双 CTA（R3：回实验室=主入口 / 直接上传=次入口）
*/

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import {
    applyHandoffReference,
    getActiveStrategy,
    getBlocks,
    getReferenceImage,
    loadFromEngineImage,
    resetStudioForTests,
    selectBlock,
    waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { fixtureShapes } from '../engine/helpers'

// jsdom 未实现 ResizeObserver；bits-ui Slider 内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

async function mountStudio(): Promise<{ unmount: () => void }> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StudioView, { target })
  await tick()
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('工作台 · handoff 参考原图落位（R3）', () => {
  beforeEach(() => {
    resetStudioForTests()
  })

  it('applyHandoffReference：无既有参考图时落位，已手动上传则不覆盖', () => {
    expect(getReferenceImage()).toBeNull()
    applyHandoffReference({ dataUrl: 'data:image/png;base64,QUJD', name: 'ref.png' })
    expect(getReferenceImage()?.name).toBe('ref.png')

    // 已有参考图（手动上传优先）：handoff 不覆盖
    applyHandoffReference({ dataUrl: 'data:image/png;base64,WFla', name: 'later.png' })
    expect(getReferenceImage()?.name).toBe('ref.png')

    // 无 reference 字段：无操作
    applyHandoffReference(undefined)
    expect(getReferenceImage()?.name).toBe('ref.png')
  })
})

describe('工作台 · 块详情置顶常驻（R3 / PM-B3）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('选中块后详情出现在精调列顶部（先于块列表），且随选中切换更新', async () => {
    const { unmount } = await mountStudio()
    loadFromEngineImage(fixtureShapes(), 'redpoint.png', 'upload')
    await waitForStudioIdle()

    // 未选中：占位提示存在
    expect(document.querySelector('[data-testid="block-detail-empty"]')).not.toBeNull()

    const first = getBlocks()[0]
    selectBlock(first.id)
    await tick()

    const detail = document.querySelector('[data-testid="block-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain(first.label)
    expect(detail!.textContent).toContain('密度')

    // 置顶语义：详情在 DOM 顺序上先于块列表（PM：详情不再埋在滚动列表之下）
    const list = document.querySelector('[data-testid="block-list"]')
    expect(list).not.toBeNull()
    expect(detail!.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    unmount()
  })
})

describe('工作台 · 移动端参数抽屉（R4）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('点击「物理」入口打开底部抽屉并渲染物理参数', async () => {
    loadFromEngineImage(fixtureShapes(), 'drawer.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const entry = [...document.querySelectorAll('[data-testid="mobile-param-entry"] button')].find((b) =>
      b.textContent?.includes('物理'),
    )
    expect(entry).toBeDefined()
    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const drawer = document.querySelector('[data-testid="param-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer!.textContent).toContain('物理参数')
    expect(drawer!.textContent).toContain('SS 钻径')
    expect(drawer!.textContent).toContain('gap')

    unmount()
  })

  it('「块」抽屉内含块详情占位/详情、块列表与只读分块参数（PM §4.4 降级）', async () => {
    loadFromEngineImage(fixtureShapes(), 'blocks-drawer.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const entry = [...document.querySelectorAll('[data-testid="mobile-param-entry"] button')].find((b) =>
      b.textContent?.includes('块'),
    )
    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const drawer = document.querySelector('[data-testid="param-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer!.querySelector('[data-testid="block-list"]')).not.toBeNull()
    // 分块参数只读降级提示（k/seed 编辑回桌面）
    expect(drawer!.textContent).toContain('桌面端调整')

    unmount()
  })
})

describe('工作台 · 策略单一真源（R3 / PM-B4）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('导出条只读回显策略（无 Select），点对比卡即切换导出策略', async () => {
    loadFromEngineImage(fixtureShapes(), 'truth.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const bar = document.querySelector('[data-testid="export-bar"]')
    expect(bar).not.toBeNull()
    // 双真源拆除：导出条内不再有策略下拉（role=combobox）
    expect(bar!.querySelector('[role="combobox"]')).toBeNull()
    expect(bar!.textContent).toContain('策略：')

    // 点对比卡（hex-thin）→ 唯一设置入口生效 → 导出条回显切换
    const card = document.querySelector('[data-testid="strategy-card-hex-thin"]')
    expect(card).not.toBeNull()
    card!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(getActiveStrategy()).toBe('hex-thin')
    const barAfter = document.querySelector('[data-testid="export-bar"]')
    expect(barAfter!.textContent).toContain('六方抽稀')

    unmount()
  })
})

describe('工作台 · 空态双 CTA（R3）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('studio')
  })

  it('空态提供「回实验室（主）」与「直接上传（次）」两个入口', async () => {
    const { unmount } = await mountStudio()

    const empty = document.querySelector('[data-testid="canvas-empty"]')
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toContain('还没有数字油画')

    const gotoLab = document.querySelector('[data-testid="empty-goto-lab"]')
    expect(gotoLab).not.toBeNull()
    gotoLab!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getView()).toBe('lab')

    expect(document.querySelector('[data-testid="painting-upload"]')).not.toBeNull()

    unmount()
    setView('lab')
  })
})
