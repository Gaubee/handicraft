/*
 * [2026-09-21 redesign-designer-workbench 3.x Test → rework-designer-manual-rhinestone
 * R4.1 显式重写] P6/P7 单选专用变换柄已退役（design §3.1：交互统一 ⌘T——少一套手柄系统）：
 * 本文件从「单选旋转/直径柄形态矩阵」显式更新为「退役收据 + ⌘T 变换盒形态矩阵」。
 * 纯决策核/pointer 流/尺寸安全红线 invariant 见 transformMode.test.ts。
 * [显式更新清单] 旧断言（单选非圆=旋转柄+双直径柄、圆钻改径柄、多选无手柄、Esc 会话
 * 取消）随单选柄退役删除；新增 ⌘T 变换盒（四角柄缩放+外柄旋转）矩阵与键位进入面。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { setView } from '$lib/stores/view.svelte'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  applyPatch,
  loadFromHandoff,
  resetEditForTests,
  setSelection,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests, setTool } from '$lib/designer/workbench.svelte'
import {
  getTransformMode,
  isTransformModeActive,
  resetInteractionForTests,
} from '$lib/designer/interaction.svelte'
import { execDesignerCommand } from '$lib/designer/commands'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function key(k: string, mods: { meta?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
    metaKey: mods.meta ?? false,
  })
  window.dispatchEvent(event)
  return event
}

function mountView(): {
  target: HTMLElement
  q: (testid: string) => Element | null
  unmount: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    q: (testid: string) => target.querySelector(`[data-testid="${testid}"]`),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

beforeEach(() => {
  setView('edit') // [R2 A] DesignerView 键盘分派活动视图守卫（挂载即 edit 语义——App 内编辑 Tab 激活等价）
  resetEditForTests()
  resetWorkbenchForTests()
  resetInteractionForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n.x = 4 + (n-1)*8, y = 4；SS10 直径 2.8mm → 半径 3.5px
})

describe('单选专用柄退役收据（design §3.1——交互统一 ⌘T）', () => {
  it('单选非圆钻（未 ⌘T）：无任何手柄（旧 P6/P7 柄退役）', async () => {
    applyPatch({ op: 'update', changes: [{ id: 'g00001', before: { shapeId: 'round' }, after: { shapeId: 'square' } }] })
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    expect(view.q('designer-handles')).toBeNull() // 旧容器退役
    expect(view.q('designer-handle-rotate')).toBeNull()
    expect(view.q('designer-handle-size-e')).toBeNull()
    expect(view.q('designer-handle-size-s')).toBeNull()
    expect(view.q('designer-transform-box')).toBeNull() // ⌘T 未进：变换盒亦不显
    view.unmount()
  })

  it('单选圆钻/多选（未 ⌘T）：同样零手柄', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    expect(view.q('designer-transform-box')).toBeNull()
    setSelection(['g00001', 'g00002'])
    await tick()
    expect(view.q('designer-transform-box')).toBeNull()
    view.unmount()
  })
})

describe('⌘T 变换盒形态矩阵（单/多选同权——推翻「多选不显变换框」裁断）', () => {
  it('单选 ⌘T：盒 + 四角缩放柄 + 四外旋转柄 + Enter/Esc 提示语义', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    const e = key('t', { meta: true })
    await tick()
    expect(e.defaultPrevented).toBe(true)
    expect(isTransformModeActive()).toBe(true)
    expect(view.q('designer-transform-box')).not.toBeNull()
    for (const id of ['nw', 'ne', 'sw', 'se']) {
      expect(view.q(`designer-transform-handle-${id}`)).not.toBeNull()
    }
    for (const id of ['n', 'e', 's', 'w']) {
      expect(view.q(`designer-transform-rotate-${id}`)).not.toBeNull()
    }
    // 未拖拽：无读数气泡
    expect(view.q('designer-transform-readout')).toBeNull()
    view.unmount()
  })

  it('多选 ⌘T：同样出盒（单选直径读数语义退场，读数归拖拽气泡）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001', 'g00002', 'g00003'])
    execDesignerCommand({ kind: 'enter-transform' })
    await tick()
    expect(view.q('designer-transform-box')).not.toBeNull()
    expect(getTransformMode()!.gemIds).toHaveLength(3)
    // Enter 收束（无拖拽零 patch）
    key('Enter')
    await tick()
    expect(isTransformModeActive()).toBe(false)
    view.unmount()
  })

  it('非选择工具下 ⌘T 亦可进（变换盒覆盖层与工具无耦合）；变换态工具键让位', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    setTool('draw')
    await tick()
    key('t', { meta: true })
    await tick()
    expect(isTransformModeActive()).toBe(true)
    expect(view.q('designer-transform-box')).not.toBeNull()
    // 变换态单键工具切换让位（防 pending 基线漂移）——B 不切画笔
    key('v')
    await tick()
    const { getTool } = await import('$lib/designer/workbench.svelte')
    expect(getTool()).toBe('draw')
    key('Escape')
    await tick()
    expect(isTransformModeActive()).toBe(false)
    view.unmount()
  })
})
