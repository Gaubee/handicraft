/*
[2026-09-18 Test] F0 回归：载入数字油画后 StudioView 不得陷入 effect 自反馈死循环
（BlockCanvas 图层重建 effect 曾读写同一 layers 状态 → effect_update_depth_exceeded，
策略卡永远停留「待计算」）。jsdom 挂载含 StudioView 的组件树 + loadFromEngineImage
直灌像素，flush 后断言：无未处理异常 + 策略卡钻数文本 > 0。
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

// jsdom 未实现 ResizeObserver；bits-ui Slider（BlockPanel）内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

describe('StudioView 挂载回归（F0：载图后无 effect 死循环）', () => {
  it('载入合成数字油画 → 无未处理异常，五策略卡钻数 > 0', async () => {
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

      for (const sid of STRATEGY_IDS) {
        const card = document.querySelector(`[data-testid="strategy-card-${sid}"]`)
        expect(card, `${sid} 策略卡应存在`).not.toBeNull()
        const m = card?.textContent?.match(/(\d+)\s*钻/)
        expect(m, `${sid} 策略卡应显示钻数（而非「待计算」）`).not.toBeNull()
        expect(Number(m?.[1]), `${sid} 钻数应 > 0`).toBeGreaterThan(0)
      }
    } finally {
      process.off('unhandledRejection', onRejection)
      window.removeEventListener('error', onWindowError)
      unmount(app)
      target.remove()
      resetStudioForTests()
    }
  })
})
