/*
[2026-09-19 Test] busyStates：loading/progress 切片红点（Owner 裁决 2026-09-19）：
1. debounce util：trailing 合并（5 次仅 1 次末值落地）、窗口内再输入重置计时、cancel 丢弃、flush 立即落地、独立实例互不吞。
2. SliderField 乐观 UI + trailing 提交：keydown 后 thumb/数值 label 即时反映（提交前 store 零写入）、
   5 拖 1 提交、卸载自动取消、busy 态数值 label 转「计算中…」（title 保留数值）。
3. store immediate 提交：滑杆提交直起计算轮（不叠加 store 防抖）；默认路径（离散入口）行为不变。
4. 原语渲染：LabelProgress idle/busy/分数/title；ButtonBusy 经状态条导出键集成（aria-busy + disabled 往返 + 下载不回归）。
5. 集成：LayerConfigCard gap 滑杆（乐观期 store 不动 → 300ms 后提交 + computing——PhysicsPanel 随全局物理废除退役）；BlockDetail 密度提交
   以拖动时刻选中的块为准（300ms 内换选不错块）+ 卸载取消；Inspector 摘要 idle 态与 store 级 segmenting 可观测。
时序策略：交互窗口用 fake timers（精确 299/300ms 断言）；fixture 载入与计算沉降用 waitForStudioIdle（real timers）。
*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick, type Component } from 'svelte'
import BlockDetail from '../../components/Studio/BlockDetail.svelte'
import Inspector from '../../components/Studio/Inspector.svelte'
import LabelProgress from '../../components/Studio/LabelProgress.svelte'
import LayerConfigCard from '../../components/Studio/LayerConfigCard.svelte'
import SliderField from '../../components/Studio/SliderField.svelte'
import StudioStatusBar from '../../components/Studio/StudioStatusBar.svelte'
import { createDebounce, SLIDER_COMMIT_DEBOUNCE_MS } from '$lib/studio/debounce'
import {
  getBlockDensity,
  getBlocks,
  getComputing,
  getGapMm,
  getGlobalDensity,
  getSegK,
  getSegmenting,
  loadFromEngineImage,
  resetStudioForTests,
  selectBlock,
  setBlockDensity,
  setGapMm,
  setGlobalDensity,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { resetEditForTests } from '$lib/stores/edit.svelte'
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

beforeEach(() => {
  resetStudioForTests()
  resetEditForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

async function mountTo<P extends Record<string, unknown>>(
  component: Component<P>,
  props: P = {} as P,
): Promise<{ target: HTMLElement; unmount: () => void }> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(component, { target, props })
  await tick()
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

/** bits-ui Slider thumb 键盘驱动（jsdom 可达路径：Home/End/Arrow 系列经 thumb keydown 更新值并触发 onValueChange） */
function pressKey(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function thumbIn(root: ParentNode): Element {
  const thumb = root.querySelector('[data-slot="slider-thumb"]')
  expect(thumb).not.toBeNull()
  return thumb as Element
}

async function loadFixture(name: string): Promise<void> {
  loadFromEngineImage(fixtureShapes(), name, 'handoff')
  await waitForStudioIdle()
}

// ---------------------------------------------------------------------------
// debounce util
// ---------------------------------------------------------------------------

describe('debounce util · trailing/取消/flush/独立实例', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('trailing：连呼 5 次仅末值落地一次，恰在窗口终点触发', () => {
    const calls: number[] = []
    const debounced = createDebounce<[number]>((v) => calls.push(v), SLIDER_COMMIT_DEBOUNCE_MS)

    for (const v of [1, 2, 3, 4, 5]) debounced(v)
    expect(debounced.isPending()).toBe(true)
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual([5])
    expect(debounced.isPending()).toBe(false)
  })

  it('窗口内再输入重置计时（不排队旧值）', () => {
    const calls: string[] = []
    const debounced = createDebounce<[string]>((v) => calls.push(v), 300)

    debounced('a')
    vi.advanceTimersByTime(200)
    debounced('b') // 重置计时
    vi.advanceTimersByTime(299)
    expect(calls).toEqual([]) // 旧窗口名义终点已过，仍不触发
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['b'])
  })

  it('cancel：丢弃 pending 末值，之后不再触发', () => {
    const calls: number[] = []
    const debounced = createDebounce<[number]>((v) => calls.push(v), 300)

    debounced(1)
    debounced.cancel()
    expect(debounced.isPending()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(calls).toEqual([])
  })

  it('flush：立即落地 pending 末值并清定时器（不双发）；无 pending 时 no-op', () => {
    const calls: number[] = []
    const debounced = createDebounce<[number]>((v) => calls.push(v), 300)

    debounced.flush()
    expect(calls).toEqual([])
    debounced(7)
    debounced.flush()
    expect(calls).toEqual([7])
    expect(debounced.isPending()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(calls).toEqual([7]) // flush 后旧定时器不再触发
  })

  it('独立实例互不吞并（不同控件各自末值各自落地）', () => {
    const a: number[] = []
    const b: number[] = []
    const da = createDebounce<[number]>((v) => a.push(v), 300)
    const db = createDebounce<[number]>((v) => b.push(v), 300)

    da(1)
    vi.advanceTimersByTime(150)
    db(2)
    vi.advanceTimersByTime(150) // a 到期落地；b 仍在窗口内
    expect(a).toEqual([1])
    expect(b).toEqual([])
    vi.advanceTimersByTime(150)
    expect(a).toEqual([1])
    expect(b).toEqual([2])
  })
})

// ---------------------------------------------------------------------------
// SliderField：乐观 UI + trailing 提交 + 卸载取消 + busy 态
// ---------------------------------------------------------------------------

describe('SliderField · 乐观 UI 与 trailing 提交', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('keydown 即时反映 thumb/数值 label（乐观 UI），提交前 onvaluechange 不触发', async () => {
    const commits: number[] = []
    const { target, unmount } = await mountTo(SliderField, {
      label: '测试滑杆',
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      debounceMs: SLIDER_COMMIT_DEBOUNCE_MS,
      onvaluechange: (v: number) => {
        commits.push(v)
      },
    })

    const thumb = thumbIn(target)
    pressKey(thumb, 'End')
    await tick()
    expect(thumb.getAttribute('aria-valuenow')).toBe('100')
    expect(target.querySelector('[data-testid="slider-value"]')?.textContent?.trim()).toBe('100')
    expect(commits).toEqual([])

    unmount()
    target.remove()
  })

  it('5 次拖动仅 1 次提交（末值），停止 300ms 后触发', async () => {
    const commits: number[] = []
    const { target, unmount } = await mountTo(SliderField, {
      label: '测试滑杆',
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      debounceMs: SLIDER_COMMIT_DEBOUNCE_MS,
      onvaluechange: (v: number) => {
        commits.push(v)
      },
    })

    const thumb = thumbIn(target)
    for (const key of ['End', 'Home', 'End', 'Home', 'End']) pressKey(thumb, key)
    await tick()
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS - 1)
    expect(commits).toEqual([])
    vi.advanceTimersByTime(1)
    expect(commits).toEqual([100])

    unmount()
    target.remove()
  })

  it('窗口内再拖重置计时', async () => {
    const commits: number[] = []
    const { target, unmount } = await mountTo(SliderField, {
      label: '测试滑杆',
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      debounceMs: SLIDER_COMMIT_DEBOUNCE_MS,
      onvaluechange: (v: number) => {
        commits.push(v)
      },
    })

    const thumb = thumbIn(target)
    pressKey(thumb, 'End')
    vi.advanceTimersByTime(200)
    pressKey(thumb, 'Home')
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS - 1)
    expect(commits).toEqual([])
    vi.advanceTimersByTime(1)
    expect(commits).toEqual([0])

    unmount()
    target.remove()
  })

  it('卸载自动取消 pending 提交（迟到提交不落到新实例）', async () => {
    const commits: number[] = []
    const { target, unmount } = await mountTo(SliderField, {
      label: '测试滑杆',
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      debounceMs: SLIDER_COMMIT_DEBOUNCE_MS,
      onvaluechange: (v: number) => {
        commits.push(v)
      },
    })

    pressKey(thumbIn(target), 'End')
    unmount()
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
    target.remove()
  })

  it('busy 态数值 label 转「计算中…」，title 保留数值；非 busy 回到数值', async () => {
    const { target, unmount } = await mountTo(SliderField, {
      label: '密度',
      value: 72,
      min: 1,
      max: 100,
      step: 1,
      format: (v: number) => `${v}%`,
      busy: true,
    })
    const busyEl = target.querySelector('[data-testid="slider-value-busy"]')
    expect(busyEl?.textContent).toContain('计算中…')
    expect(busyEl?.getAttribute('title')).toBe('72%')
    expect(target.querySelector('[data-testid="slider-value"]')).toBeNull()
    unmount()

    const idle = await mountTo(SliderField, {
      label: '密度',
      value: 72,
      min: 1,
      max: 100,
      step: 1,
      format: (v: number) => `${v}%`,
      busy: false,
    })
    expect(idle.target.querySelector('[data-testid="slider-value"]')?.textContent?.trim()).toBe('72%')
    expect(idle.target.querySelector('[data-testid="slider-value-busy"]')).toBeNull()
    idle.unmount()
  })
})

// ---------------------------------------------------------------------------
// store：immediate 提交直起计算轮；默认路径（离散入口）防抖行为不变
// ---------------------------------------------------------------------------

describe('studio store · 滑杆 immediate 提交与默认防抖', () => {
  it('默认路径：写入后 computing 不立即置位（防抖窗口内），idle 后参数与结果落地', async () => {
    await loadFixture('store-default.png')
    setGlobalDensity(0.5)
    expect(getComputing()).toBe(false)
    await waitForStudioIdle()
    expect(getGlobalDensity()).toBe(0.5)
    expect(getComputing()).toBe(false)
  })

  it('immediate：滑杆提交跳过防抖直起计算轮（同步 computing=true）', async () => {
    await loadFixture('store-immediate.png')
    setGlobalDensity(0.5, { immediate: true })
    expect(getComputing()).toBe(true)
    await waitForStudioIdle()
    expect(getComputing()).toBe(false)
    expect(getGlobalDensity()).toBe(0.5)
  })

  it('setGapMm / setBlockDensity 同支持 immediate；值未变时仍不空转起轮', async () => {
    await loadFixture('store-immediate2.png')
    setGapMm(0.8, { immediate: true })
    expect(getComputing()).toBe(true)
    await waitForStudioIdle()
    expect(getGapMm()).toBe(0.8)

    const block = getBlocks()[0]
    setBlockDensity(block.id, 0.3, { immediate: true })
    expect(getComputing()).toBe(true)
    await waitForStudioIdle()
    expect(getBlockDensity(block.id)).toBe(0.3)

    // 值未变（夹紧后同值早退）：不触发新轮
    setGapMm(0.8, { immediate: true })
    expect(getComputing()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 原语渲染：LabelProgress / ButtonBusy（经状态条导出键集成）
// ---------------------------------------------------------------------------

describe('LabelProgress · label 承载状态', () => {
  it('idle 显示原文案（aria-live 供读屏）', async () => {
    const { target, unmount } = await mountTo(LabelProgress, { text: 'k 8' })
    const el = target.firstElementChild as HTMLElement
    expect(el.textContent).toContain('k 8')
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.getAttribute('aria-busy')).toBeNull()
    unmount()
  })

  it('busy 替换 busyText + 分数计数 + title 携完整进度', async () => {
    const { target, unmount } = await mountTo(LabelProgress, {
      text: 'SS10 · gap 0.40mm',
      busy: true,
      progress: { done: 3, total: 6, label: 'CVT 分簇 排布中…' },
    })
    const el = target.firstElementChild as HTMLElement
    expect(el.textContent).toContain('计算中…')
    expect(el.textContent).toContain('3/6')
    expect(el.getAttribute('aria-busy')).toBe('true')
    expect(el.getAttribute('title')).toBe('CVT 分簇 排布中… 3/6')
    unmount()
  })

  it('total=1（分块单轮）不追加分数；自定义 busyText 生效', async () => {
    const { target, unmount } = await mountTo(LabelProgress, {
      text: 'k 8',
      busy: true,
      busyText: '分块中…',
      progress: { done: 0, total: 1, label: '正在分块…' },
    })
    const el = target.firstElementChild as HTMLElement
    expect(el.textContent).toContain('分块中…')
    expect(el.textContent).not.toContain('/')
    unmount()
  })
})

describe('ButtonBusy · 状态条导出键 busy 往返（集成）', () => {
  it('点击导出 SVG：busy 期 disabled + aria-busy + spinner，完成后恢复且下载发生', async () => {
    await loadFixture('export-busy.png')
    const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { target, unmount } = await mountTo(StudioStatusBar)

    const btn = target.querySelector<HTMLButtonElement>('[data-testid="export-svg"]')
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)
    expect(btn!.getAttribute('aria-busy')).toBeNull()

    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    // busy 窗口内（nextPaint 让帧之后才进入生成段）：disabled + aria-busy + spinner svg
    expect(btn!.disabled).toBe(true)
    expect(btn!.getAttribute('aria-busy')).toBe('true')
    expect(btn!.querySelector('svg')).not.toBeNull()

    // rAF/微任务沉降：busy 解除、下载链接已点击（busy 包装不破坏导出链路）
    await new Promise((r) => setTimeout(r, 60))
    expect(btn!.disabled).toBe(false)
    expect(btn!.getAttribute('aria-busy')).toBeNull()
    expect(urlSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalledTimes(1)

    urlSpy.mockRestore()
    clickSpy.mockRestore()
    unmount()
    target.remove()
  })

  it('违规阻断语义不变：blocked 时按钮禁用（busy 不越权）', async () => {
    // 未载入（无结果）→ check.ready=false → blocked → 三键禁用
    const { target, unmount } = await mountTo(StudioStatusBar)
    for (const id of ['export-svg', 'export-bom', 'export-png']) {
      const btn = target.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      expect(btn!.disabled, `${id} 无结果时应禁用`).toBe(true)
    }
    unmount()
    target.remove()
  })
})

// ---------------------------------------------------------------------------
// 集成：面板级滑杆接线（LayerConfigCard / BlockDetail / Inspector）
// ---------------------------------------------------------------------------

describe('LayerConfigCard · gap 滑杆乐观 UI + store 接线', () => {
  it('拖动期 store 不动（乐观），停止 300ms 后提交末值并直起计算轮', async () => {
    await loadFixture('physics-gap.png')
    vi.useFakeTimers()
    const { target, unmount } = await mountTo(LayerConfigCard)

    const fields = [...target.querySelectorAll('[data-slider-field]')]
    const gapField = fields.find((el) => el.getAttribute('data-slider-field')?.includes('gap'))
    expect(gapField).toBeDefined()
    const thumb = thumbIn(gapField!)

    for (const key of ['End', 'Home', 'End', 'Home', 'End']) pressKey(thumb, key)
    await tick()
    // 乐观：thumb 与数值 label 已到 0.80mm（层配置卡滑杆值域 40..80=百分毫米）；store 未提交
    expect(thumb.getAttribute('aria-valuenow')).toBe('80')
    expect(gapField!.querySelector('[data-testid="slider-value"]')?.textContent?.trim()).toBe('0.80mm')
    expect(getGapMm()).toBe(0.4)
    expect(getComputing()).toBe(false)

    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS - 1)
    expect(getGapMm()).toBe(0.4)
    vi.advanceTimersByTime(1)
    // 提交末值 + immediate 直起计算轮（同步置位）
    expect(getGapMm()).toBe(0.8)
    expect(getComputing()).toBe(true)

    // 沉降（fake timers 下推进到布局轮全部落地）
    await vi.advanceTimersByTimeAsync(2000)
    expect(getComputing()).toBe(false)

    unmount()
    target.remove()
  })
})

describe('BlockDetail · 块密度提交以拖动时刻选中块为准', () => {
  it('窗口内换选块：提交仍落拖动时刻的块，不错写新选中块', async () => {
    await loadFixture('block-density.png')
    const [first, second] = getBlocks()
    selectBlock(first.id)
    vi.useFakeTimers()
    const { target, unmount } = await mountTo(BlockDetail)

    pressKey(thumbIn(target), 'Home') // 密度 1% → 0.01（区别于缺省 1）
    await tick()
    // 300ms 内切换选中（滑杆镜像被新块覆写，但 pending 提交目标不变）
    selectBlock(second.id)
    await tick()
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS)

    expect(getBlockDensity(first.id)).toBe(0.01)
    expect(getBlockDensity(second.id)).toBe(1) // 未被错写

    await vi.advanceTimersByTimeAsync(2000)
    unmount()
    target.remove()
  })

  it('卸载自动取消 pending 提交（移动端抽屉关闭即卸载语义）', async () => {
    await loadFixture('block-density-unmount.png')
    const first = getBlocks()[0]
    selectBlock(first.id)
    vi.useFakeTimers()
    const { target, unmount } = await mountTo(BlockDetail)

    pressKey(thumbIn(target), 'Home')
    await tick()
    unmount()
    vi.advanceTimersByTime(1000)
    expect(getBlockDensity(first.id)).toBe(1)
    target.remove()
  })
})

describe('Inspector · 摘要 label 承载', () => {
  it('idle 摘要在场（k / 块数 / gap）；载入后 300ms 处 segmenting 可观测（store 级）', async () => {
    const { target, unmount } = await mountTo(Inspector)
    expect(target.textContent).toContain('k 8')
    expect(target.textContent).toContain('待载入')
    unmount()
    target.remove()

    vi.useFakeTimers()
    loadFromEngineImage(fixtureShapes(), 'seg-pulse.png', 'handoff')
    vi.advanceTimersByTime(299)
    expect(getSegmenting()).toBe(false)
    vi.advanceTimersByTime(1)
    // runSegment 同步置位 segmenting（首个 await 之前）；布局轮随后接管
    expect(getSegmenting()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getSegmenting()).toBe(false)
    expect(getBlocks().length).toBeGreaterThanOrEqual(3)
    expect(getSegK()).toBe(8)
  })
})
