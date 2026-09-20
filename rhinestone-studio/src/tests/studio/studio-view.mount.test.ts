/*
[2026-09-19 Test] 骨架重写回归（redesign-studio-layout 1.1/2.2）：
1. F0 回归（承旧）：载入数字油画后 StudioView 不得陷入 effect 自反馈死循环
   （BlockCanvas 图层重建 effect 曾读写同一 layers 状态 → effect_update_depth_exceeded）。
   jsdom 挂载含 StudioView 的组件树 + loadFromEngineImage 直灌像素，flush 后断言：
   无未处理异常 + 胶片带 chip 钻数 > 0。
2. 五区结构存在性：上下文条/画布舞台/检查器/胶片带/状态条按序存在；min-h-0/min-w-0 链与
   主区 overflow-hidden 以类名断言（computed overflow 断言留给后续真浏览器测试，design §6）。
3. 移动端画布 60vh 定值废除：舞台区为 flex-1 填充，不再含 60vh 定值类。
*/

import { describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import {
  loadFromEngineImage,
  resetStudioForTests,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'
import { STRATEGY_IDS } from '$lib/engine'

// jsdom 未实现 ResizeObserver；bits-ui Slider（检查器面板）内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

describe('StudioView 挂载回归（F0：载图后无 effect 死循环）', () => {
  it('载入合成数字油画 → 无未处理异常，胶片带五 chip 钻数 > 0', async () => {
    const failures: unknown[] = []
    const onRejection = (reason: unknown): void => {
      failures.push(reason)
    }
    const onWindowError = (e: ErrorEvent): void => {
      failures.push(e.error)
    }
    process.on('unhandledRejection', onRejection)
    window.addEventListener('error', onWindowError)

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StudioView, { target })
    try {
      resetStudioForTests()
      loadFromEngineImage(fixtureShapes(), 'regression-f0.png', 'upload')
      await waitForStudioIdle()
      await tick()
      // 给微任务 flush 留出窗口（effect 死循环异常经 microtask 抛出）
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(failures).toEqual([])

      // [2.7] StrategyFilmStrip 整区废除（死 API grep 面）；左列图层面板层行携带钻数
      expect(document.querySelector('[data-testid="strategy-film-strip"]')).toBeNull()
      const row = document.querySelector('[data-testid="layer-row-L1"]')
      expect(row, '兜底层行应存在').not.toBeNull()
      expect((row?.textContent ?? '').match(/\d/), '层行应携带钻数').not.toBeNull()
    } finally {
      process.off('unhandledRejection', onRejection)
      window.removeEventListener('error', onWindowError)
      unmount(app)
      target.remove()
      resetStudioForTests()
    }
  })
})

describe('StudioView 四区固定视口骨架（studio-layers 2.7——胶片带整区废除）', () => {
  it('四区按序存在：上下文条 → [左列|画布舞台|检查器] → 状态条', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StudioView, { target })
    try {
      const zones = [
        '[data-testid="context-bar"]',
        '[data-testid="studio-mid"]',
        '[data-testid="status-bar"]',
      ]
      const els = zones.map((sel) => {
        const el = document.querySelector(sel)
        expect(el, `${sel} 应存在`).not.toBeNull()
        return el!
      })
      for (let i = 0; i < els.length - 1; i++) {
        expect(
          els[i]!.compareDocumentPosition(els[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
          `${zones[i]} 应在 ${zones[i + 1]} 之前`,
        ).toBeTruthy()
      }

      // 中段含画布舞台与检查器（桌面右列；移动端由抽屉承载，jsdom 无样式不影响存在性断言）
      const mid = document.querySelector('[data-testid="studio-mid"]')
      expect(mid!.querySelector('[data-testid="studio-stage"]')).not.toBeNull()
      expect(mid!.querySelector('[data-testid="block-canvas"]')).not.toBeNull()
      expect(mid!.querySelector('[data-testid="inspector"]')).not.toBeNull()
      // [2.7] 左列（图层|历史双 tab）桌面档在场；jsdom 恒桌面分支（matchMedia 无布局）
      const left = document.querySelector('[data-testid="studio-left-column"]')
      expect(left).not.toBeNull()
      expect(left!.querySelector('[data-testid="left-tab-layers"]')).not.toBeNull()
      expect(left!.querySelector('[data-testid="left-tab-history"]')).not.toBeNull()
      expect(left!.querySelector('[data-testid="layer-panel"]')).not.toBeNull()
    } finally {
      unmount(app)
      target.remove()
      resetStudioForTests()
    }
  })

  it('主区零纵向滚动与 min-h-0 链：根/中段/舞台类名断言（computed overflow 留真浏览器测试）', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StudioView, { target })
    try {
      const root = document.querySelector<HTMLElement>('[data-testid="studio-root"]')
      expect(root!.className).toContain('overflow-hidden')
      expect(root!.className).toContain('min-h-0')

      const mid = document.querySelector<HTMLElement>('[data-testid="studio-mid"]')
      expect(mid!.className).toContain('min-h-0')
      expect(mid!.className).toContain('flex-1')

      const stage = document.querySelector<HTMLElement>('[data-testid="studio-stage"]')
      expect(stage!.className).toContain('flex-1')
      expect(stage!.className).toContain('min-h-0')
      // 移动端 60vh 定值废除（redesign-studio-layout 4.1）：画布 flex 填充
      expect(stage!.className).not.toContain('60vh')

      const slot = document.querySelector<HTMLElement>('[data-testid="studio-inspector-slot"]')
      expect(slot!.className).toContain('w-80')
    } finally {
      unmount(app)
      target.remove()
      resetStudioForTests()
    }
  })
})
