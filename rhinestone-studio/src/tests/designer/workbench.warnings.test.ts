/*
 * [2026-09-20 D-5.2 Test] pairwise warning 重算时机（rename-and-expert-workbench tasks 5.2）：
 * DesignerStatusBar 徽标 = validateEditable 派生消费（doc $state 深响应）——三态：
 * ① load 后（干净交接 → 无 spacing 违规）
 * ② 改径后立即（增大 diameterMm → 邻对中心距不足 → spacing 徽标出现）
 * ③ undo 后（回退初值 → 徽标消失）
 * 另含 mask-hint 归属提示位（来源钻越出块掩码 → 提示徽标、不阻断）。
 * 判据单源 = engine validateEditable（本文件只测重算接线时机，不重复测判据本身）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerStatusBar from '../../components/Designer/DesignerStatusBar.svelte'
import {
  applyPatch,
  getEditDoc,
  loadFromHandoff,
  resetEditForTests,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountBar(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerStatusBar, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function spacingBadge(target: HTMLElement): string | null {
  const el = target.querySelector('[data-testid="designer-status-spacing-warnings"]')
  return el?.textContent ?? null
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
})

describe('pairwise warning 徽标三态（load → 改径 → undo）', () => {
  it('① load 后：干净交接无 spacing 违规（徽标缺席）', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountBar()
    await tick()
    expect(spacingBadge(view.target)).toBeNull()
    view.unmount()
  })

  it('② 改径后立即重算：增径 → 邻对中心距不足 → 徽标出现并计数', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountBar()
    await tick()
    expect(spacingBadge(view.target)).toBeNull()

    // SS10 2.8mm → 6.4mm：邻对所需 (6.4+2.8)/2+0.4=5.0mm×2.5=12.5px > 格距 8px → 违规
    applyPatch({
      op: 'update',
      changes: [{ id: 'g00001', before: { diameterMm: 2.8 }, after: { diameterMm: 6.4 } }],
    })
    await tick()
    const badge = spacingBadge(view.target)
    expect(badge).not.toBeNull()
    expect(badge).toContain('间距冲突')
    expect(badge).toContain('导出将被拦截') // spacing = 导出阻断提示语义
    expect(badge).toContain('可保存') // 保存放行语义（专家稿 §I.3-2）

    view.unmount()
  })

  it('③ undo 后：回退初径 → 徽标消失（重算随撤销联动）', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountBar()
    await tick()
    applyPatch({
      op: 'update',
      changes: [{ id: 'g00001', before: { diameterMm: 2.8 }, after: { diameterMm: 6.4 } }],
    })
    await tick()
    expect(spacingBadge(view.target)).not.toBeNull()

    const { undo } = await import('$lib/stores/edit.svelte')
    undo()
    await tick()
    expect(spacingBadge(view.target)).toBeNull()
    expect(getEditDoc()!.gems[0].diameterMm).toBe(2.8)

    view.unmount()
  })
})

describe('mask-hint 归属提示位（不阻断语义）', () => {
  it('来源钻移出块掩码 → 提示徽标（无「导出拦截」措辞）', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountBar()
    await tick()
    // 64×64 满幅块外 (100,100)：origin='layout' 且未 moved 的来源钻越掩码
    applyPatch({
      op: 'update',
      changes: [{ id: 'g00001', before: { x: 4, y: 4 }, after: { x: 100, y: 100 } }],
    })
    await tick()

    const hint = view.target.querySelector('[data-testid="designer-status-mask-hints"]')
    expect(hint?.textContent).toContain('越出来源块掩码')
    expect(hint?.textContent).not.toContain('导出')
    expect(spacingBadge(view.target)).toBeNull() // 掩码越界不触发 spacing 面

    view.unmount()
  })
})
