/*
[2026-09-19 Test] store → runCompute 接线语义（jsdom 走主线程同构 fallback，与 worker 路径同内核）：
1. 进度聚合模型：布局轮同步起手即报「首策略 1/6」，轮终清空（null），idle 后 computing=false。
2. cancelCompute：作废在途轮（迟到结果不落地）、复位 computing/progress/inflight，且不清空既有结果。
3. 逐策略子轮：五策略结果渐进落地且无 error（分块→布局两阶段均经 runCompute）。
*/

import { beforeEach, describe, expect, it } from 'vitest'
import { STRATEGY_IDS } from '$lib/engine'
import { isWorkerAvailable } from '$lib/workers/computeClient'
import {
  cancelCompute,
  getActiveResult,
  getBlocks,
  getComputeProgress,
  getComputing,
  getResults,
  getSegmenting,
  loadFromEngineImage,
  recompute,
  resetStudioForTests,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'

beforeEach(() => {
  resetStudioForTests()
})

async function loadFixture(): Promise<void> {
  loadFromEngineImage(fixtureShapes(), 'fixture.png', 'handoff')
  await waitForStudioIdle()
}

describe('studio store · worker 接线（主线程 fallback 同构）', () => {
  it('jsdom 环境走 fallback（无 Worker），与浏览器 worker 路径共用同一内核', () => {
    expect(isWorkerAvailable()).toBe(false)
  })

  it('载入后：分块与五策略结果全部落地、无 error，进度与计算态复位', async () => {
    await loadFixture()
    expect(getBlocks().length).toBeGreaterThanOrEqual(3)
    expect(getSegmenting()).toBe(false)
    expect(getComputing()).toBe(false)
    expect(getComputeProgress()).toBeNull()
    for (const sid of STRATEGY_IDS) {
      const res = getResults()[sid]
      expect(res, `${sid} 应有结果`).not.toBeNull()
      expect(res?.error, `${sid} 不应失败`).toBeUndefined()
      expect(res!.gems.length).toBeGreaterThan(0)
    }
  })

  it('布局轮起手同步报「首策略 1/6」聚合进度（computeCore 单元模型：segment 1 + 策略 N）', async () => {
    await loadFixture()
    recompute()
    // runLayouts 首迭代同步写进度（首个 await 之前）
    const p = getComputeProgress()
    expect(p).toEqual({ done: 1, total: STRATEGY_IDS.length + 1, label: '六方抽稀 排布中…' })
    expect(getComputing()).toBe(true)
    await waitForStudioIdle()
    expect(getComputeProgress()).toBeNull()
    expect(getComputing()).toBe(false)
  })

  it('cancelCompute 作废在途轮：迟到结果不落地、状态复位、既有结果保留', async () => {
    await loadFixture()
    const before = getActiveResult()
    expect(before?.gems.length).toBeGreaterThan(0)

    recompute()
    expect(getComputing()).toBe(true)
    cancelCompute()

    expect(getComputing()).toBe(false)
    expect(getComputeProgress()).toBeNull()
    // 取消后 idle 可达（inflight 已复位，无悬挂轮）
    await waitForStudioIdle()
    // 旧结果保留：取消只作废新轮，不清空产物
    const after = getActiveResult()
    expect(after?.gems.length).toBe(before!.gems.length)
    expect(after?.error).toBeUndefined()
  })

  it('取消后参数改动照常触发新轮（取消不是终态）', async () => {
    await loadFixture()
    recompute()
    cancelCompute()
    // 再次手动触发一轮，计算能力恢复正常
    recompute()
    await waitForStudioIdle()
    expect(getComputing()).toBe(false)
    expect(getActiveResult()?.gems.length).toBeGreaterThan(0)
  })
})
