/*
 * [add-project-files 2.6] 守卫三分法（design §3——spec「脏态口径」studio 侧收口）：
 * 一、切 Tab 不弹：dirty 会话跨视图存活（store 单例），setView 往返零 Dialog + ●徽标常驻
 *    （未命名会话 studio-dirty-badge / 已保存项目 project-dirty-dot）；
 * 二、beforeunload：dirty 阻止默认；保存（dirty 清零）后放行（editUnbound 同式事件断言）；
 * 三、页内破坏性动作三按钮矩阵：保存并继续（④段 saveGemproj 链路）/ 不保存 / 取消——
 *    openIntent 打开其它项目（取消 = 意图 ack failed）、送排钻 handoff 新建（取消 = 丢弃交接）、
 *    换来源图（取消 = 保持当前图）、保存失败就地报错分支；
 * 四、dirty 清零路径：保存后破坏性动作直行无 Dialog。
 *
 * jsdom 无 2D 解码：Image 立即 onload + canvas 2d 软桩（studioAssetIntegration 同式）；
 * IDB 经 installFakeIndexedDB（宏任务泵 afterEach 排空——helpers 契约）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import { drainFakeIndexedDBChains, installFakeIndexedDB } from '../lab/helpers/fakeIndexedDB'
import { ingestAsset, resetAssetStoreForTests } from '$lib/persistence/assetStore'
import {
  applyPainting,
  getLayers,
  getSourceImage,
  loadFromEngineImage,
  resetStudioForTests,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { dispatchStudioOp } from '$lib/studio/history.svelte'
import {
  getStudioProject,
  isStudioDirty,
  resetProjectPersistenceForTests,
  saveGemproj,
} from '$lib/studio/projectPersistence.svelte'
import {
  getStudioGuardError,
  isStudioGuardBusy,
  isStudioGuardOpen,
  resetStudioGuardForTests,
  runStudioGuarded,
  studioGuardCancel,
  studioGuardDiscard,
  studioGuardSaveAndContinue,
} from '$lib/studio/guard.svelte'
import { clearHandoff, getHandoff, setHandoff } from '$lib/stores/handoff.svelte'
import {
  claimOpenIntent,
  peekOpenIntent,
  resetOpenIntentForTests,
  setOpenIntent,
} from '$lib/stores/openIntent.svelte'
import { setView } from '$lib/stores/view.svelte'
import { fixtureShapes } from '../engine/helpers'

// 真实定时器（分块防抖 300ms × 多轮沉降 + IDB 宏任务链）——单测超时上限放宽
vi.setConfig({ testTimeout: 20000 })

// PNG 魔数头样本（序列化面合法 dataUrl；与 projectPersistence.test 同源口径）
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]
const PNG_DATA_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`

/** 会话装载（jsdom 直灌像素 + 可序列化 dataUrl——save 路径的 embedded 来源）。 */
async function loadSession(name = '城市.png'): Promise<void> {
  applyPainting(fixtureShapes(), { dataUrl: PNG_DATA_URL, name, origin: 'upload', downscale: 1 })
  await waitForStudioIdle()
}

/** dirty 化（任一 StudioOp 即置位——layer.create 最小样例）。 */
function makeDirty(): void {
  dispatchStudioOp({ t: 'layer.create', name: '临时层', blockIds: [] })
  expect(isStudioDirty()).toBe(true)
}

// 最小解码桩：Image 立即 onload（带尺寸）；canvas 2d 软桩（drawImage no-op + getImageData 空白面）
class OkImage {
  naturalWidth = 64
  naturalHeight = 48
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

let restoreCanvasCtx: (() => void) | null = null

/** ImageData 桩（vitest jsdom 环境未暴露全局 ImageData——BlockCanvas 图层构建直构该类型）。 */
class ImageDataStub {
  width: number
  height: number
  data: Uint8ClampedArray
  constructor(data: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
    if (typeof data === 'number') {
      this.width = data
      this.height = widthOrHeight ?? data
      this.data = new Uint8ClampedArray(this.width * this.height * 4)
    } else {
      this.data = data
      this.width = widthOrHeight ?? 0
      this.height = height ?? 0
    }
  }
}

// jsdom 未实现 ResizeObserver（LayerPanel 等面板组件依赖）；bits-ui 挂载稳定性桩
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

async function ingestPng(bytes: number[], name: string) {
  const { node } = await ingestAsset({
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    name,
    width: 64,
    height: 48,
    parentId: null,
    source: 'upload',
  })
  return node
}

function qs(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`)
}

function click(testId: string): void {
  const el = qs(testId)
  if (el === null) throw new Error(`找不到 ${testId}`)
  el.click()
}

async function mountStudio(): Promise<() => void> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StudioView, { target })
  await tick()
  return () => {
    unmount(app)
    target.remove()
  }
}

/** beforeunload 事件断言助手（editUnbound.test 同式）。 */
function beforeunloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  installFakeIndexedDB().reset()
  resetAssetStoreForTests()
  resetStudioForTests()
  await resetProjectPersistenceForTests()
  resetStudioGuardForTests()
  resetOpenIntentForTests()
  clearHandoff()
  setView('studio')
  document.body.innerHTML = ''

  vi.stubGlobal('Image', OkImage)
  vi.stubGlobal('ImageData', ImageDataStub)
  // canvas 2d 软桩：像素读口给真实空白面（解码管线 getImageData / 图层构建 putImageData-
  // createImageData）；其余方法/属性一律 no-op 代理（BlockCanvas redraw 全量绘制路径不炸 jsdom）
  const pixelMethods = {
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  }
  const ctxStub = new Proxy(pixelMethods, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return () => undefined
    },
    set() {
      return true
    },
  })
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext
  restoreCanvasCtx = () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }
})

afterEach(async () => {
  restoreCanvasCtx?.()
  restoreCanvasCtx = null
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
});

// ---------------------------------------------------------------------------
// 三、页内破坏性动作三按钮（store 级直调 guard 状态机）
// ---------------------------------------------------------------------------

describe('2.6 三按钮状态机（guard 域 store 级）', () => {
  it('干净会话直行无 Dialog；dirty 挂起 + 取消 = 动作不执行、dirty 保持、Dialog 关', async () => {
    await loadSession()
    let ran = false
    runStudioGuarded(async () => {
      ran = true
    })
    expect(ran).toBe(true) // 干净：守卫零拦截（切 Tab 不弹的对称面）
    expect(isStudioGuardOpen()).toBe(false)

    makeDirty()
    let ran2 = false
    runStudioGuarded(async () => {
      ran2 = true
    })
    expect(isStudioGuardOpen()).toBe(true)
    expect(ran2).toBe(false) // 挂起：动作未执行

    studioGuardCancel()
    expect(isStudioGuardOpen()).toBe(false)
    expect(ran2).toBe(false) // 取消：动作永不执行
    expect(isStudioDirty()).toBe(true) // 会话原地保持
  })

  it('保存并继续：④段 saveGemproj 链路（首存默认名）清 dirty 后放行动作', async () => {
    await loadSession()
    makeDirty()
    let ran = false
    runStudioGuarded(async () => {
      ran = true
    })
    await studioGuardSaveAndContinue()
    expect(ran).toBe(true)
    expect(isStudioDirty()).toBe(false) // 保存清零
    expect(isStudioGuardOpen()).toBe(false)
    expect(getStudioGuardError()).toBeNull()
    expect(getStudioProject()?.projectId).toBeTruthy() // 首存 ingest（sys-projects）
    expect(getStudioProject()?.name).toBe('城市') // 默认名 = 来源图名去扩展名
  })

  it('保存失败就地报错（Dialog 保持、动作不放行）；改选「不保存」放行', async () => {
    // 不可序列化会话：直灌像素无 dataUrl/assetId → saveGemproj 显式失败
    loadFromEngineImage(fixtureShapes(), '不可序列化.png')
    await waitForStudioIdle()
    makeDirty()
    let ran = false
    runStudioGuarded(async () => {
      ran = true
    })
    await studioGuardSaveAndContinue()
    expect(isStudioGuardOpen()).toBe(true) // 失败：Dialog 保持可改选
    expect(getStudioGuardError()).toContain('无法保存')
    expect(ran).toBe(false)
    expect(isStudioGuardBusy()).toBe(false)

    studioGuardDiscard()
    expect(ran).toBe(true) // 不保存：直接放行
    expect(isStudioGuardOpen()).toBe(false)
    expect(isStudioDirty()).toBe(true) // dirty 位不清（会话被动作替换时自然失效）
  })

  it('取消带 openIntent claim：意图 ack failed（gemproj-open-guard-cancelled）', async () => {
    await loadSession()
    makeDirty()
    setOpenIntent({ kind: 'gemproj', assetId: 'ast-guard-target' })
    const claim = claimOpenIntent()
    expect(claim).not.toBeNull()
    let ran = false
    runStudioGuarded(async () => {
      ran = true
    }, { claim: claim! })
    expect(peekOpenIntent()?.phase).toBe('claimed')

    studioGuardCancel()
    expect(ran).toBe(false)
    const snapshot = peekOpenIntent()
    expect(snapshot?.phase).toBe('failed')
    expect(snapshot?.reason).toBe('gemproj-open-guard-cancelled')
    expect(isStudioGuardOpen()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 一/二/四：切 Tab 不弹 + beforeunload + UI 级破坏性动作（StudioView 挂载）
// ---------------------------------------------------------------------------

describe('2.6 守卫三分法（StudioView 挂载级）', () => {
  it('切 Tab 不弹守卫：dirty 会话跨视图存活 + ●未保存徽标常驻（未命名徽标 → 保存后项目身份点）', async () => {
    const dispose = await mountStudio()
    try {
      await loadSession()
      makeDirty()
      await tick()

      // 未命名会话：●未保存徽标常驻（store 单例跨视图存活的提醒面）
      expect(qs('studio-dirty-badge')).not.toBeNull()
      setView('assets')
      await tick()
      expect(isStudioGuardOpen()).toBe(false) // 切 Tab 零拦截
      expect(qs('studio-guard-dialog')).toBeNull()
      expect(isStudioDirty()).toBe(true) // 会话内容与 dirty 跨视图保持
      setView('studio')
      await tick()
      expect(qs('studio-dirty-badge')).not.toBeNull()

      // 保存后：项目身份组的 ● 点（未命名徽标退位）
      await saveGemproj()
      await tick()
      expect(qs('studio-dirty-badge')).toBeNull()
      makeDirty()
      await vi.waitFor(() => expect(qs('project-dirty-dot')).not.toBeNull())
      setView('lab')
      await tick()
      expect(qs('studio-guard-dialog')).toBeNull()
      expect(isStudioDirty()).toBe(true)
    } finally {
      dispose()
    }
  })

  it('beforeunload：dirty 时阻止默认；保存（dirty 清零）后放行', async () => {
    const dispose = await mountStudio()
    try {
      await loadSession()
      makeDirty()
      expect(beforeunloadPrevented()).toBe(true)

      await saveGemproj()
      expect(beforeunloadPrevented()).toBe(false) // dirty 清零路径：刷新无拦截
    } finally {
      dispose()
    }
  })

  it('打开其它项目（openIntent）：dirty 先守卫——取消 = 意图 failed + 会话保持；不保存 = 打开成功 ack 且干净 base', async () => {
    const dispose = await mountStudio()
    try {
      await loadSession()
      await saveGemproj() // 档内层集 = 单兜底层（干净）
      const projectId = getStudioProject()!.projectId!
      makeDirty() // 未保存的临时层（不写入档）
      expect(getLayers().length).toBe(2)

      // 守卫挂起：意图 claimed、会话原地保持
      setOpenIntent({ kind: 'gemproj', assetId: projectId })
      await vi.waitFor(() => expect(qs('studio-guard-dialog')).not.toBeNull())
      expect(peekOpenIntent()?.phase).toBe('claimed')
      expect(getLayers().length).toBe(2)

      // 取消：意图 ack failed、Dialog 关、dirty 会话保持
      click('studio-guard-cancel')
      await vi.waitFor(() => expect(qs('studio-guard-dialog')).toBeNull())
      expect(peekOpenIntent()?.phase).toBe('failed')
      expect(getLayers().length).toBe(2)
      expect(isStudioDirty()).toBe(true)

      // 不保存：动作放行 → 打开成功（intent replace 旧 failed）→ 干净 base（档内层集回放）
      setOpenIntent({ kind: 'gemproj', assetId: projectId })
      await vi.waitFor(() => expect(qs('studio-guard-dialog')).not.toBeNull())
      click('studio-guard-discard')
      await vi.waitFor(() => expect(peekOpenIntent()).toBeNull()) // ackSuccess 清意图
      await tick()
      expect(isStudioDirty()).toBe(false) // 打开 = 新 base（丢弃未保存临时层）
      expect(getLayers().length).toBe(1)
      expect(getStudioProject()?.projectId).toBe(projectId)
    } finally {
      dispose()
    }
  })

  it('送排钻 handoff 新建会话：dirty 先守卫——取消 = 丢弃交接种会话保持；保存后（dirty 清零）直行换图', async () => {
    const dispose = await mountStudio()
    try {
      await loadSession()
      makeDirty()
      const node = await ingestPng(PNG_BYTES, '生成图.png')

      setHandoff({ assetId: node.id, name: '生成图.png' })
      await vi.waitFor(() => expect(qs('studio-guard-dialog')).not.toBeNull())
      expect(getSourceImage()?.name).toBe('城市.png') // 会话保持

      click('studio-guard-cancel')
      await vi.waitFor(() => expect(qs('studio-guard-dialog')).toBeNull())
      expect(getHandoff()).toBeNull() // 取消 = 丢弃本次交接
      expect(getSourceImage()?.name).toBe('城市.png')
      expect(isStudioDirty()).toBe(true)

      // dirty 清零路径：保存后同交接直行（零 Dialog）
      await saveGemproj()
      setHandoff({ assetId: node.id, name: '生成图.png' })
      await vi.waitFor(() => expect(getHandoff()).toBeNull()) // 直行消费（成功清交接）
      await waitForStudioIdle()
      expect(qs('studio-guard-dialog')).toBeNull()
      expect(getSourceImage()?.name).toBe('生成图.png')
    } finally {
      dispose()
    }
  })

  it('换来源图：dirty 先守卫——取消 = 保持当前图；不保存 = 换图成功', async () => {
    const dispose = await mountStudio()
    try {
      await loadSession()
      makeDirty()
      const nodeB = await ingestPng([9, 8, 7], '新来源.png')
      const { assetPicker } = await import('$lib/assets/controller.svelte')

      click('change-source')
      await tick()
      expect(assetPicker.request).not.toBeNull()
      assetPicker.resolve([nodeB])
      await tick()
      await Promise.resolve() // open() promise 微任务链（守卫判定在 resolve 后）
      await vi.waitFor(() => expect(qs('studio-guard-dialog')).not.toBeNull())
      expect(getSourceImage()?.name).toBe('城市.png')

      click('studio-guard-cancel')
      await tick()
      expect(getSourceImage()?.name).toBe('城市.png') // 取消：当前图与修改保持
      expect(isStudioDirty()).toBe(true)

      // 不保存：换图放行
      click('change-source')
      await tick()
      assetPicker.resolve([nodeB])
      await tick()
      await Promise.resolve()
      await vi.waitFor(() => expect(qs('studio-guard-dialog')).not.toBeNull())
      click('studio-guard-discard')
      await vi.waitFor(() => expect(getSourceImage()?.name).toBe('新来源.png'))
      expect(qs('studio-guard-dialog')).toBeNull()
    } finally {
      dispose()
    }
  })
})
