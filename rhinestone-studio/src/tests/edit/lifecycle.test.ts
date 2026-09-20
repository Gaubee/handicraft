/*
 * [2026-09-19 Test] tasks 3.x：第三 Tab + 送精修交接 + 生命周期。
 * App 级挂载冒烟（Tab/空态/送精修动线/覆盖确认）——jsdom 无 canvas 2d，
 * EditCanvas 全部 ctx 路径 null 守卫，断言只覆盖 DOM 结构与 store 状态。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import App from '../../App.svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { applyPatch, getEditDoc, getGemCount, getUndoDepths, isEditDirty, loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
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

/** [add-project-files 3.x busy 迁移] 送精修为异步（nextPaint 让帧）——点击后按忙等待沉降。 */
async function settleBusy(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  resetEditForTests()
  resetStudioForTests()
  resetToastsForTests()
  setView('lab')
})

describe('第三 Tab（tasks 3.1）', () => {
  it('view store 接受 edit；App 顶栏「设计师工作台」/底部导航「设计」入口', async () => {
    const { unmount } = mountApp()
    const triggers = [...document.body.querySelectorAll('[role="tab"]')]
    // [Owner 2026-09-19] 素材库 Tab 居首（add-asset-library tasks 2.1）
    expect(triggers.map((t) => t.textContent?.trim())).toEqual(['素材库', '提示词实验室', '排钻工作台', '设计师工作台'])

    triggers.find((t) => t.textContent?.trim() === '设计师工作台')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getView()).toBe('edit')
    // [redesign 2.x] App 路由已接 DesignerView（空态 testid 随新域）
    expect(document.querySelector('[data-testid="designer-empty"]')).not.toBeNull()

    unmount()
    setView('lab')
  })

  it('DesignerView 空态（3.3 重设计）：四入口按钮齐备，引导行可切排钻工作台页', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(DesignerView, { target })
    await tick()

    expect(target.querySelector('[data-testid="designer-empty"]')).not.toBeNull()
    expect(target.textContent).toContain('从一张图开始钻级精修')
    expect(target.querySelector('[data-testid="designer-empty-pick-image"]')).not.toBeNull()
    expect(target.querySelector('[data-testid="designer-empty-open-project"]')).not.toBeNull()
    expect(target.querySelector('[data-testid="designer-empty-upload"]')).not.toBeNull()
    target.querySelector<HTMLButtonElement>('[data-testid="designer-empty-goto-studio"]')?.click()
    await tick()
    expect(getView()).toBe('studio')

    unmount(app)
    target.remove()
    setView('lab')
  })
})

describe('送精修动线（tasks 3.1/3.2）', () => {
  it('排钻工作台「送精修」→ 切 edit 视图 + 画布与顶栏摘要就位（未保存徽标可见）', async () => {
    await studioReady()
    const { unmount } = mountApp()
    setView('studio')
    await tick()

    const btn = document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)
    btn!.click()
    await settleBusy()

    expect(getView()).toBe('edit')
    expect(getEditDoc()).not.toBeNull()
    expect(isEditDirty()).toBe(true) // [3.2] 送精修产物 = 未保存新文档
    expect(getGemCount()).toBe(getActiveResult()!.gems.length)
    // [redesign 2.x] App 路由已接 DesignerView：画布/状态栏/未保存徽标随新 testid
    expect(document.querySelector('[data-testid="designer-canvas"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="designer-status-bar"]')?.textContent).toContain('钻')
    expect(document.querySelector('[data-testid="designer-dirty-badge"]')?.textContent).toContain('未保存')

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

  it('再次送精修且文档未保存：覆盖确认弹窗（dirty 口径），确认后重载', async () => {
    await studioReady()
    const { unmount } = mountApp()

    // 第一次送精修（直通；产物即 dirty——未保存新文档）
    setView('studio')
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await settleBusy()
    expect(getView()).toBe('edit')

    // 编辑器内产生修改（undo 栈非空；dirty 早已为 true）
    const g = getEditDoc()!.gems[0]
    applyPatch({ op: 'update', changes: [{ id: g.id, before: { colorId: g.colorId }, after: { colorId: 'black' } }] })
    expect(getUndoDepths().undo).toBe(1)

    // 回排钻工作台再次送精修 → 覆盖确认
    setView('studio')
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await settleBusy()
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('覆盖当前精修内容')

    // 取消：文档保持（undo 深度仍 1）
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit-cancel"]')!.click()
    await tick()
    expect(getUndoDepths().undo).toBe(1)

    // 再送 → 确认覆盖：历史清空、按排钻工作台当前结果重建
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await settleBusy()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit-confirm"]')!.click()
    await settleBusy()
    expect(getView()).toBe('edit')
    expect(getUndoDepths()).toEqual({ undo: 0, redo: 0 })
    expect(getGemCount()).toBe(getActiveResult()!.gems.length)

    unmount()
    setView('lab')
  })

  it('未保存文档（即便无手工修改）再次送精修：同样走覆盖确认（dirty 口径替换 hasEdits）', async () => {
    await studioReady()
    const { unmount } = mountApp()
    setView('studio')
    await tick()
    // 第一次送入：未保存（dirty=true、undo 深度 0——旧 hasEdits 口径会直通）
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await settleBusy()
    expect(getView()).toBe('edit')
    expect(getUndoDepths().undo).toBe(0)
    expect(isEditDirty()).toBe(true)

    // 再次送精修 → 覆盖确认（dirty 口径）
    setView('studio')
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await settleBusy()
    expect(document.body.textContent ?? '').toContain('覆盖当前精修内容')
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit-cancel"]')!.click()
    await tick()

    unmount()
    setView('lab')
  })
})

describe('刷新语义（tasks 3.2：无 handoff 进入 = 空态）', () => {
  it('模块状态不持久化：reset 后 DesignerView 显示空态，buildManualEditHandoff 无结果可送', () => {
    expect(getEditDoc()).toBeNull()
    expect(buildManualEditHandoff()).toBeNull()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(DesignerView, { target })
    expect(target.querySelector('[data-testid="designer-empty"]')).not.toBeNull()
    expect(target.querySelector('[data-testid="designer-canvas"]')).toBeNull()
    unmount(app)
    target.remove()
  })

  it('直接灌入 handoff（编程路径）后 DesignerView 呈现画布 + 摘要', async () => {
    loadFromHandoff(makeHandoff(12, { sourceSummary: '六方抽稀 · 密度 100% · SS10' }))
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(DesignerView, { target })
    await tick()

    expect(target.querySelector('[data-testid="designer-canvas"]')).not.toBeNull()
    const summary = target.querySelector('[data-testid="designer-doc-bar"]')
    expect(summary?.textContent).toContain('六方抽稀')
    expect(target.querySelector('[data-testid="designer-status-total"]')?.textContent).toContain('12')

    unmount(app)
    target.remove()
  })
})
