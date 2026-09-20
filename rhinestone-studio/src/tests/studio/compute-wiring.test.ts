/*
[2026-09-19 Test / 2026-09-20 studio-layers 2.3 层化口径] store → runCompute 接线语义
（jsdom 走主线程同构 fallback，与 worker 路径同内核）：
1. 载入 = 分块单轮 + 锚点层（兜底层）单策略排布（五策略并行缓存退役——Owner 授权差异）。
2. cancelCompute：作废在途批（迟到结果不落地）、复位 computing/progress，且不清空既有结果。
3. 进度模型 = segment 1 单元 + N 层（旧 1+i/6 的层级化）；recompute 同步置 computing。
*/

import { beforeEach, describe, expect, it } from 'vitest'
import { isWorkerAvailable } from '$lib/workers/computeClient'
import {
  cancelCompute,
  getActiveResult,
  getBlocks,
  getComputeProgress,
  getComputing,
  getLayerResult,
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

  it('载入后：分块 + 锚点层（兜底层）结果落地、无 error，进度与计算态复位', async () => {
    await loadFixture()
    expect(getBlocks().length).toBeGreaterThanOrEqual(3)
    expect(getSegmenting()).toBe(false)
    expect(getComputing()).toBe(false)
    expect(getComputeProgress()).toBeNull()
    // [2.3/2.7] 五策略并行缓存退役：锚点层单策略结果（联合兼容面 = 同一份）；切换即该层重算
    const entry = getLayerResult('L1')
    expect(entry, '兜底层结果应落地').toBeDefined()
    expect(entry?.error).toBeUndefined()
    expect(entry?.gems.length).toBeGreaterThan(0)
    const joint = getActiveResult()
    expect(joint?.strategy).toBe(entry!.strategy)
    expect(joint?.gems.length).toBe(entry!.gems.length)
  })

  it('recompute 同步置 computing；批终进度清空（segment 1 单元 + N 层的层级化进度）', async () => {
    await loadFixture()
    recompute()
    // [2.3] runDirtyBatch 同步占位（防 false-idle）——computeCore 单元模型：segment 1 + 层数 N
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
