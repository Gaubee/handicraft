/*
 * [2026-09-21 rework-designer-manual-rhinestone R5.2 复验-R2 A Test] 跨视图全局键位隔离
 * （⌘Z 键盘全局失效回归——复验实证：顶栏撤销按钮正常、⌘Z/⌘⇧Z 键盘四上下文全无效）。
 *
 * 根因（真浏览器实证，ego TaskSpace 25 空白文档 + 真实 Meta+Z 注入 + preventDefault 栈回溯）：
 * bits-ui Tabs 的四个 Tabs.Content **常驻挂载**（非激活不卸载）——StudioView 的
 * `<svelte:window onkeydown>`（⌘Z/⇧⌘Z → studio undo）在设计师 Tab 激活期同样在听，
 * 且其注册先于 DesignerView（App Tabs DOM 序）：⌘Z 先被它 preventDefault + 派发 studio
 * undo（设计师上下文 no-op），DesignerView 的分派链三函数均以 `event.defaultPrevented`
 * 早退 → 设计师 ⌘Z 全局失效。工具单键 B 等不受影响（StudioView 只滤 ⌘Z）——与复验
 * 「按钮正常、⌘Z 键盘死」完全吻合；变换态/焦点/popover 均非根因（复验头号嫌疑排除）。
 *
 * 修复面：四个视图级全局键盘处理器统一加「活动视图守卫」（StudioView ⌘Z /
 * StudioContextBar ⌘S / DesignerView 全键分派 / AssetsView Enter/Esc document 级）。
 *
 * 本文件 jsdom 复现真实挂载序（StudioView 先、DesignerView 后，同 App Tabs DOM 序），
 * 键位级断言（非按钮；编辑动作经命令总线/变换态制造，撤销走 window keydown 注入）：
 * 1. view='edit' 时 ⌘Z 撤销最近的旋转编辑（旧实现 = StudioView 吃键 → 此断言红）；
 * 2. view='edit' 时 ⌘⇧Z 重做；
 * 3. view='edit' 时 Enter 确认变换后 ⌘Z 撤销该变换（复验点名回归场景，键位级）；
 * 4. view='studio' 时 ⌘Z / 工具单键 B 不动设计师（DesignerView 反向守卫——键位归活动视图）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { getEditDoc, loadFromHandoff, resetEditForTests, setSelection } from '$lib/stores/edit.svelte'
import { getTool, resetWorkbenchForTests, setTool } from '$lib/designer/workbench.svelte'
import { resetInteractionForTests, updateTransformPending } from '$lib/designer/interaction.svelte'
import { execDesignerCommand } from '$lib/designer/commands'
import { resetStudioForTests } from '$lib/stores/studio.svelte'
import { makeHandoff } from '../edit/helpers'

// jsdom 未实现 ResizeObserver（StudioView/DesignerView 挂载链依赖——studio-view.mount 同式桩）
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

/** Image 替身（DesignerView 挂载链的 entry/参考底图解码只读 natural 尺寸）。 */
class StubImage {
  naturalWidth = 0
  naturalHeight = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    queueMicrotask(() => {
      this.naturalWidth = 64
      this.naturalHeight = 64
      this.onload?.()
    })
  }
}
vi.stubGlobal('Image', StubImage)

function pressCmdZ(shift = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: shift ? 'Z' : 'z',
    metaKey: true,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  })
  window.dispatchEvent(event)
  return event
}

function pressKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('跨视图全局键位隔离（R5.2 复验-R2 A：⌘Z 键盘全局失效）', () => {
  let studioTarget: HTMLElement
  let designerTarget: HTMLElement
  let studioApp: ReturnType<typeof mount>
  let designerApp: ReturnType<typeof mount>

  beforeEach(() => {
    resetEditForTests()
    resetWorkbenchForTests()
    resetInteractionForTests()
    resetStudioForTests()
    // 真实挂载序：App Tabs DOM 序 = assets → lab → studio → edit（studio 监听先注册）
    studioTarget = document.createElement('div')
    document.body.appendChild(studioTarget)
    studioApp = mount(StudioView, { target: studioTarget })
    designerTarget = document.createElement('div')
    document.body.appendChild(designerTarget)
    designerApp = mount(DesignerView, { target: designerTarget })
    loadFromHandoff(makeHandoff(2))
    const ids = (getEditDoc()?.gems ?? []).map((g) => g.id)
    setSelection(ids.slice(0, 1))
  })

  afterEach(() => {
    unmount(designerApp)
    unmount(studioApp)
    designerTarget.remove()
    studioTarget.remove()
    resetEditForTests()
    resetWorkbenchForTests()
    resetInteractionForTests()
    resetStudioForTests()
    setView('lab')
  })

  it('view=edit：⌘Z 撤销设计师编辑（StudioView 常驻监听不再吃键——旧实现此断言红）', () => {
    setView('edit')
    const rotationBefore = getEditDoc()!.gems[0]!.rotationDeg ?? 0 // 原值快照（proxy 活读防假阳）
    expect(execDesignerCommand({ kind: 'rotate', stepDeg: 15 })).toBe(true)
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0).toBe(15)
    const event = pressCmdZ()
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0, '⌘Z 应撤销旋转组').toBe(rotationBefore)
    expect(event.defaultPrevented).toBe(true) // DesignerView 分派链消费（undo 生效后的 preventDefault）
  })

  it('view=edit：⌘⇧Z 重做被撤销的组', () => {
    setView('edit')
    expect(execDesignerCommand({ kind: 'rotate', stepDeg: 15 })).toBe(true)
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0).toBe(15)
    pressCmdZ()
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0).toBe(0)
    pressCmdZ(true)
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0, '⌘⇧Z 应重做旋转组').toBe(15)
  })

  it('view=edit：Enter 确认变换后 ⌘Z 撤销该变换（复验点名场景，键位级断言）', () => {
    setView('edit')
    const before = getEditDoc()!.gems[0]!.diameterMm ?? 0
    expect(execDesignerCommand({ kind: 'enter-transform' })).toBe(true)
    const gemId = getEditDoc()!.gems[0]!.id
    updateTransformPending({ [gemId]: { diameterMm: before * 2 } })
    // Enter = confirm-transform（键位注入——handleCommandKeydown 变换态段）
    expect(pressKey('Enter').defaultPrevented).toBe(true)
    expect(getEditDoc()!.gems[0]!.diameterMm ?? 0).toBeCloseTo(before * 2, 5)
    // 复验死点：Enter 退态后 ⌘Z（键位）应撤销该变换
    pressCmdZ()
    expect(getEditDoc()!.gems[0]!.diameterMm ?? 0, 'Enter 确认后 ⌘Z 应撤销变换（直径回落）').toBeCloseTo(before, 5)
  })

  it('view=studio：⌘Z 不动设计师文档（DesignerView 反向守卫——键位归活动视图）', () => {
    setView('edit')
    expect(execDesignerCommand({ kind: 'rotate', stepDeg: 15 })).toBe(true)
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0).toBe(15)
    setView('studio')
    pressCmdZ()
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0, 'studio 视图激活期设计师 ⌘Z 不触发').toBe(15)
    // 对照：切回 edit 视图同一键生效
    setView('edit')
    pressCmdZ()
    expect(getEditDoc()!.gems[0]!.rotationDeg ?? 0).toBe(0)
  })

  it('view=studio：工具单键 B 不泄入设计师（工具态保持）', () => {
    setView('studio')
    setTool('select')
    pressKey('b')
    expect(getTool(), 'studio 视图裸键 B 不应切换设计师工具').toBe('select')
    // 对照：edit 视图下同一键生效（分派链健康性）
    setView('edit')
    pressKey('b')
    expect(getTool()).toBe('draw')
  })

  it('view 守卫读取面：getView 与 setView 语义不被本修复改变', () => {
    setView('edit')
    expect(getView()).toBe('edit')
    setView('studio')
    expect(getView()).toBe('studio')
  })
})
