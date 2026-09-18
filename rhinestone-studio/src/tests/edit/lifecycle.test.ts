/*
 * [2026-09-19 Test] tasks 3.x：第三 Tab + 送精修交接 + 生命周期。
 * App 级挂载冒烟（Tab/空态/送精修动线/覆盖确认）——jsdom 无 canvas 2d，
 * EditCanvas 全部 ctx 路径 null 守卫，断言只覆盖 DOM 结构与 store 状态。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import App from '../../App.svelte'
import EditView from '$lib/components/views/EditView.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { applyPatch, getEditDoc, getGemCount, getUndoDepths, loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
import {
  buildManualEditHandoff,
  getActiveResult,
  loadFromEngineImage,
  resetStudioForTests,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { fixtureShapes } from '../engine/helpers'
import { makeHandoff } from './helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountApp(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  return { target, unmount: () => { unmount(app); target.remove() } }
}

async function studioReady(): Promise<void> {
  resetStudioForTests()
  loadFromEngineImage(fixtureShapes(), 'lifecycle.png', 'handoff')
  await waitForStudioIdle()
  expect(getActiveResult()?.gems.length ?? 0).toBeGreaterThan(0)
}

beforeEach(() => {
  resetEditForTests()
  resetStudioForTests()
  resetToastsForTests()
  setView('lab')
})

describe('第三 Tab（tasks 3.1）', () => {
  it('view store 接受 edit；App 顶栏与底部导航均有「手动编辑」入口', async () => {
    const { unmount } = mountApp()
    const triggers = [...document.body.querySelectorAll('[role="tab"]')]
    // [Owner 2026-09-19] 素材库 Tab 居首（add-asset-library tasks 2.1）
    expect(triggers.map((t) => t.textContent?.trim())).toEqual(['素材库', '提示词实验室', '转化工作台', '手动编辑'])

    triggers.find((t) => t.textContent?.trim() === '手动编辑')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getView()).toBe('edit')
    expect(document.querySelector('[data-testid="edit-empty"]')).not.toBeNull()

    unmount()
    setView('lab')
  })

  it('EditView 空态：引导回工作台按钮可切视图', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(EditView, { target })
    await tick()

    expect(target.querySelector('[data-testid="edit-empty"]')).not.toBeNull()
    expect(target.textContent).toContain('还没有送入精修的图')
    target.querySelector<HTMLButtonElement>('[data-testid="edit-empty-goto-studio"]')?.click()
    await tick()
    expect(getView()).toBe('studio')

    unmount(app)
    target.remove()
    setView('lab')
  })
})

describe('送精修动线（tasks 3.1/3.2）', () => {
  it('工作台「送精修」→ 切 edit 视图 + 画布与顶栏摘要就位', async () => {
    await studioReady()
    const { unmount } = mountApp()
    setView('studio')
    await tick()

    const btn = document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)
    btn!.click()
    await tick()

    expect(getView()).toBe('edit')
    expect(getEditDoc()).not.toBeNull()
    expect(getGemCount()).toBe(getActiveResult()!.gems.length)
    expect(document.querySelector('[data-testid="edit-canvas"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="edit-summary"]')?.textContent).toContain('钻')

    unmount()
    setView('lab')
  })

  it('无结果时送精修按钮禁用', async () => {
    const { unmount } = mountApp()
    setView('studio')
    await tick()
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(true)
    unmount()
    setView('lab')
  })

  it('再次送精修且有未导出修改：覆盖确认弹窗，确认后重载', async () => {
    await studioReady()
    const { unmount } = mountApp()

    // 第一次送精修（直通）
    setView('studio')
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await tick()
    expect(getView()).toBe('edit')

    // 编辑器内产生修改（undo 栈非空）
    const g = getEditDoc()!.gems[0]
    applyPatch({ op: 'update', changes: [{ id: g.id, before: { colorId: g.colorId }, after: { colorId: 'black' } }] })
    expect(getUndoDepths().undo).toBe(1)

    // 回工作台再次送精修 → 覆盖确认
    setView('studio')
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await tick()
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('覆盖当前精修内容')

    // 取消：文档保持（undo 深度仍 1）
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit-cancel"]')!.click()
    await tick()
    expect(getUndoDepths().undo).toBe(1)

    // 再送 → 确认覆盖：历史清空、按工作台当前结果重建
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit-confirm"]')!.click()
    await tick()
    expect(getView()).toBe('edit')
    expect(getUndoDepths()).toEqual({ undo: 0, redo: 0 })
    expect(getGemCount()).toBe(getActiveResult()!.gems.length)

    unmount()
    setView('lab')
  })

  it('无修改时再次送精修：直通无确认弹窗', async () => {
    await studioReady()
    const { unmount } = mountApp()
    setView('studio')
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await tick()
    setView('studio')
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await tick()
    expect(document.body.textContent ?? '').not.toContain('覆盖当前精修内容')
    expect(getView()).toBe('edit')

    unmount()
    setView('lab')
  })
})

describe('刷新语义（tasks 3.2：无 handoff 进入 = 空态）', () => {
  it('模块状态不持久化：reset 后 EditView 显示空态，buildManualEditHandoff 无结果可送', () => {
    expect(getEditDoc()).toBeNull()
    expect(buildManualEditHandoff()).toBeNull()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(EditView, { target })
    expect(target.querySelector('[data-testid="edit-empty"]')).not.toBeNull()
    expect(target.querySelector('[data-testid="edit-canvas"]')).toBeNull()
    unmount(app)
    target.remove()
  })

  it('直接灌入 handoff（编程路径）后 EditView 呈现画布 + 摘要', async () => {
    loadFromHandoff(makeHandoff(12, { sourceSummary: '六方抽稀 · 密度 100% · SS10' }))
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(EditView, { target })
    await tick()

    expect(target.querySelector('[data-testid="edit-canvas"]')).not.toBeNull()
    const summary = target.querySelector('[data-testid="edit-summary"]')
    expect(summary?.textContent).toContain('六方抽稀')
    expect(target.querySelector('[data-testid="edit-gem-count"]')?.textContent).toContain('12')

    unmount(app)
    target.remove()
  })
})
