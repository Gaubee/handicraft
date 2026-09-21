/*
 * [2026-09-21 redesign-designer-workbench 5.3 Test] 保存/另存/守卫装配（design §5.4 复用 +
 * §3 文档键位）：
 * - ⌘S/⌘⇧S 命令链接线：keymap → execDesignerCommand(open-save/save-as) → UI 钩子 →
 *   视图装配（requestSave/openSaveDialog）——三入口同源（键位/按钮/菜单同一终端）。
 * - 生命周期零改动回归面：保存/另存编排复用 gemdocLifecycle + documentService（本域零实现）
 *   ——lifecycle.test.ts 独立回归（零断言改动收据），本文件只断言装配增量。
 * - 未保存徽标 + 守卫三分法展示（保存并继续/不保存/取消）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setView } from '$lib/stores/view.svelte'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { execDesignerCommand, installDesignerUiHooks } from '$lib/designer/commands'
import { SHORTCUT_HELP_SECTIONS, handleCommandKeydown } from '$lib/designer/keymap'
import { getEditDoc, isEditDirty, loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { resetViewportForTests } from '$lib/designer/viewport.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

const ctx = { hasDocument: () => getEditDoc() !== null }

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init })
}

function mountView(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function settle(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  setView('edit') // [R2 A] DesignerView 键盘分派活动视图守卫（挂载即 edit 语义——App 内编辑 Tab 激活等价）
  resetEditForTests()
  resetWorkbenchForTests()
  resetViewportForTests()
  resetToastsForTests()
})

afterEach(() => {
  installDesignerUiHooks(null)
})

// ---------------------------------------------------------------------------

describe('⌘S/⌘⇧S 命令链（keymap → 命令总线 → UI 钩子）', () => {
  it('⌘S → open-save → requestSave 钩子；⌘⇧S（含大写 S 布局）→ save-as → requestSaveAs 钩子', () => {
    loadFromHandoff(makeHandoff(3))
    const hooks = {
      requestDeleteConfirm: vi.fn(),
      requestOpenSpecSelector: vi.fn(),
      requestSave: vi.fn(),
      requestSaveAs: vi.fn(),
    }
    installDesignerUiHooks(hooks)

    const save = keydown('s', { metaKey: true })
    expect(handleCommandKeydown(save, ctx)).toBe(true)
    expect(save.defaultPrevented).toBe(true)
    expect(hooks.requestSave).toHaveBeenCalledTimes(1)
    expect(hooks.requestSaveAs).not.toHaveBeenCalled()

    const saveAs = keydown('s', { metaKey: true, shiftKey: true })
    expect(handleCommandKeydown(saveAs, ctx)).toBe(true)
    expect(saveAs.defaultPrevented).toBe(true)
    expect(hooks.requestSaveAs).toHaveBeenCalledTimes(1)

    // Shift 布局产大写 'S'：同键收录（⌘⇧Z 家族同式）
    const upper = keydown('S', { metaKey: true, shiftKey: true })
    expect(handleCommandKeydown(upper, ctx)).toBe(true)
    expect(hooks.requestSaveAs).toHaveBeenCalledTimes(2)
  })

  it('无文档放行（false + 不 preventDefault）；无钩子（测试/无视图面）放行；Ctrl=⌘ 双写', () => {
    // 无文档
    const noDoc = keydown('s', { metaKey: true })
    expect(handleCommandKeydown(noDoc, ctx)).toBe(false)
    expect(noDoc.defaultPrevented).toBe(false)

    // 有文档无钩子
    loadFromHandoff(makeHandoff(3))
    expect(handleCommandKeydown(keydown('s', { metaKey: true }), ctx)).toBe(false)

    // Ctrl 双写
    const hooks = {
      requestDeleteConfirm: vi.fn(),
      requestOpenSpecSelector: vi.fn(),
      requestSave: vi.fn(),
      requestSaveAs: vi.fn(),
    }
    installDesignerUiHooks(hooks)
    expect(handleCommandKeydown(keydown('s', { ctrlKey: true }), ctx)).toBe(true)
    expect(hooks.requestSave).toHaveBeenCalledTimes(1)
  })

  it('命令总线直调同源：execDesignerCommand({open-save/save-as})；表单聚焦放行（isEditableTarget 语义）', () => {
    loadFromHandoff(makeHandoff(3))
    const hooks = {
      requestDeleteConfirm: vi.fn(),
      requestOpenSpecSelector: vi.fn(),
      requestSave: vi.fn(),
      requestSaveAs: vi.fn(),
    }
    installDesignerUiHooks(hooks)
    expect(execDesignerCommand({ kind: 'open-save' })).toBe(true)
    expect(execDesignerCommand({ kind: 'save-as' })).toBe(true)
    expect(hooks.requestSave).toHaveBeenCalledTimes(1)
    expect(hooks.requestSaveAs).toHaveBeenCalledTimes(1)

    // 表单聚焦：键归表单（input 内 ⌘S 不触发命令——命名弹窗内再按 ⌘S 不重复弹）
    const input = document.createElement('input')
    document.body.appendChild(input)
    const fromInput = keydown('s', { metaKey: true })
    Object.defineProperty(fromInput, 'target', { value: input })
    expect(handleCommandKeydown(fromInput, ctx)).toBe(false)
    input.remove()
  })

  it('键位速查面板数据含文档组（⌘S/⌘⇧S 行——SHORTCUT_HELP_SECTIONS 同源）', () => {
    const doc = SHORTCUT_HELP_SECTIONS.find((s) => s.title === '文档')
    expect(doc).toBeDefined()
    expect(doc!.rows.map((r) => r.keys)).toContain('⌘S')
    expect(doc!.rows.map((r) => r.keys)).toContain('⌘⇧S')
  })
})

describe('DesignerView 装配（视图级：键位 → 钩子 → 保存弹窗/直存分流）', () => {
  // Dialog 内容 portal 到 document.body——弹窗类断言走 document.querySelector（editUnbound 同式）
  it('未保存新文档（docId null）⌘S → 首存命名弹窗（预填文档名）', async () => {
    loadFromHandoff(makeHandoff(3, { sourceSummary: '装配' }))
    const view = mountView()
    await settle()
    expect(isEditDirty()).toBe(true)
    // 未保存徽标（design §1.2 ●未保存 + 徽标）
    expect(view.target.querySelector('[data-testid="designer-dirty-badge"]')?.textContent).toContain('未保存')

    window.dispatchEvent(keydown('s', { metaKey: true }))
    await settle()
    const dialog = document.querySelector('[data-testid="designer-save-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('保存精修项目')
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="designer-save-name"]')?.value,
    ).toContain('精修')

    view.unmount()
  })

  it('⌘⇧S → 另存为弹窗（fork：标题另存为）', async () => {
    loadFromHandoff(makeHandoff(3))
    const view = mountView()
    await settle()
    window.dispatchEvent(keydown('s', { metaKey: true, shiftKey: true }))
    await settle()
    const dialog = document.querySelector('[data-testid="designer-save-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('另存为精修项目')

    view.unmount()
  })

  it('DocBar 同源入口：保存按钮 + 文档菜单「另存为…」存在（同一终端 requestSave/openSaveDialog）', async () => {
    loadFromHandoff(makeHandoff(3))
    const view = mountView()
    await settle()
    expect(view.target.querySelector('[data-testid="designer-save-button"]')).not.toBeNull()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-doc-menu-toggle"]')!.click()
    await tick()
    expect(view.target.querySelector('[data-testid="designer-menu-save-as"]')).not.toBeNull()
    // 菜单「另存为…」与 ⌘⇧S 同一弹窗
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-menu-save-as"]')!.click()
    await settle()
    expect(document.querySelector('[data-testid="designer-save-dialog"]')?.textContent).toContain('另存为')

    view.unmount()
  })

  it('守卫三分法展示：dirty 关闭文档 → 三按钮弹窗；「取消」文档保持', async () => {
    loadFromHandoff(makeHandoff(3))
    const view = mountView()
    await settle()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-doc-menu-toggle"]')!.click()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-menu-close"]')!.click()
    await settle()

    expect(document.querySelector('[data-testid="designer-guard-dialog"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="designer-guard-save"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="designer-guard-discard"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="designer-guard-cancel"]')).not.toBeNull()

    document.querySelector<HTMLButtonElement>('[data-testid="designer-guard-cancel"]')!.click()
    await settle()
    expect(getEditDoc()).not.toBeNull() // 取消：文档保持
    expect(isEditDirty()).toBe(true)

    view.unmount()
  })
})
