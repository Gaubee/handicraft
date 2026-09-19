/**
 * 轨 B 2.2：级联失效与重试语义（design §3.4）。
 * 覆盖：main retry → blueprint invalidate→pending（成品图换代失配）；main error → blueprint
 * skipped；main cancel → blueprint cancelled；blueprint 单独 retry/cancel 不动 main；
 * 失效级联矩阵（含传递下游与脏树防御）；retryCount 递增与重试新 requestId（旧 id 清空不复用）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTaskStages,
  deriveTaskStatus,
  reduceStages,
  schedulableStages,
  stageIdOf,
  type LabStage,
  type StageKind,
} from '$lib/lab/stages'

const BASE_TIME = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
})

afterEach(() => {
  vi.useRealTimers()
})

const MAIN = stageIdOf('t1', 'main')
const BP = stageIdOf('t1', 'blueprint')

function mkStage(patch: Partial<LabStage> & { id: string; kind: StageKind }): LabStage {
  return { status: 'pending', dependsOn: [], imageStored: false, retryCount: 0, ...patch }
}

function serial(): LabStage[] {
  return createTaskStages('t1', { strategy: 'serial' })
}

function at(stages: LabStage[], stageId: string): LabStage {
  const found = stages.find((s) => s.id === stageId)
  if (found === undefined) throw new Error(`stage 不存在：${stageId}`)
  return found
}

/** 派发→成功（产物字段一并落，模拟接线层 patchStage）。 */
function dispatchAndSucceed(stages: LabStage[], stageId: string, requestId: string, product?: { assetId?: string; imageUrl?: string }): LabStage[] {
  let next = reduceStages(stages, { type: 'dispatch', stageId, requestId })
  if (product !== undefined) {
    next = next.map((s) => (s.id === stageId ? { ...s, ...product, imageStored: product.assetId !== undefined } : s))
  }
  return reduceStages(next, { type: 'succeed', stageId })
}

describe('失效级联矩阵', () => {
  it('main error（经 dispatch→fail）→ blueprint skipped；retry main → blueprint 复活 pending', () => {
    let stages = reduceStages(serial(), { type: 'dispatch', stageId: MAIN, requestId: 'r1' })
    stages = reduceStages(stages, { type: 'fail', stageId: MAIN, error: '上游 500' })
    expect(at(stages, BP).status).toBe('skipped')
    expect(deriveTaskStatus(stages)).toBe('error')

    stages = reduceStages(stages, { type: 'retry', stageId: MAIN })
    expect(at(stages, MAIN).status).toBe('pending')
    expect(at(stages, BP).status).toBe('pending')
    // main 重试复活后 blueprint 立即可随 main 终态重新排队（此刻依赖未满足不派发）
    expect(schedulableStages(stages, 0, 4).map((s) => s.id)).toEqual([MAIN])
  })

  it('main cancel → blueprint cancelled（取消级联）；retry main → 两 stage 均 pending', () => {
    let stages = reduceStages(serial(), { type: 'dispatch', stageId: MAIN, requestId: 'r1' })
    stages = reduceStages(stages, { type: 'cancel', stageId: MAIN })
    expect(at(stages, MAIN).status).toBe('cancelled')
    expect(at(stages, BP).status).toBe('cancelled')
    expect(at(stages, BP).error).toBe('已取消')

    stages = reduceStages(stages, { type: 'retry', stageId: MAIN })
    expect(at(stages, MAIN).status).toBe('pending')
    expect(at(stages, BP).status).toBe('pending')
    expect(at(stages, BP).error).toBeUndefined()
  })

  it('main success 后 blueprint 失败：blueprint 单独 retry 不动 main（main 仍 success、产物原样）', () => {
    let stages = dispatchAndSucceed(serial(), MAIN, 'r-main', { assetId: 'ast-main', imageUrl: 'blob:main' })
    stages = reduceStages(stages, { type: 'dispatch', stageId: BP, requestId: 'r-bp' })
    stages = reduceStages(stages, { type: 'fail', stageId: BP, error: '蓝图糊字' })
    expect(at(stages, MAIN).status).toBe('success')
    expect(at(stages, BP).status).toBe('error')
    expect(deriveTaskStatus(stages)).toBe('success')

    stages = reduceStages(stages, { type: 'retry', stageId: BP })
    expect(at(stages, BP).status).toBe('pending')
    expect(at(stages, BP).retryCount).toBe(1)
    // main 不动：状态/产物/重试计数原样
    expect(at(stages, MAIN).status).toBe('success')
    expect(at(stages, MAIN).assetId).toBe('ast-main')
    expect(at(stages, MAIN).imageUrl).toBe('blob:main')
    expect(at(stages, MAIN).retryCount).toBe(0)
    // blueprint 重试后立即可派发（依赖 main 仍 success）
    expect(schedulableStages(stages, 0, 4).map((s) => s.id)).toEqual([BP])
  })

  it('blueprint 单独 cancel：running → cancelled，main 不动（cancelStage 粒度）', () => {
    let stages = dispatchAndSucceed(serial(), MAIN, 'r-main')
    stages = reduceStages(stages, { type: 'dispatch', stageId: BP, requestId: 'r-bp' })
    stages = reduceStages(stages, { type: 'cancel', stageId: BP })
    expect(at(stages, BP).status).toBe('cancelled')
    expect(at(stages, MAIN).status).toBe('success')
  })

  it('invalidate：main 成功产物换代 → 本 stage 及下游（含已成功 blueprint）整体重置 pending', () => {
    let stages = dispatchAndSucceed(serial(), MAIN, 'r-main', { assetId: 'ast-main', imageUrl: 'blob:main' })
    stages = dispatchAndSucceed(stages, BP, 'r-bp', { assetId: 'ast-bp', imageUrl: 'blob:bp' })
    expect(at(stages, BP).status).toBe('success')

    stages = reduceStages(stages, { type: 'invalidate', stageId: MAIN })
    expect(at(stages, MAIN).status).toBe('pending')
    expect(at(stages, MAIN).assetId).toBeUndefined()
    expect(at(stages, BP).status).toBe('pending')
    expect(at(stages, BP).assetId).toBeUndefined()
    expect(at(stages, BP).imageStored).toBe(false)
    // retryCount 不动：invalidate 是依赖换代重置，不是用户重试
    expect(at(stages, MAIN).retryCount).toBe(0)
    expect(at(stages, BP).retryCount).toBe(0)
  })

  it('传递级联：三层树 fail 根 → 全下游 skipped；retry 根 → 全下游复活', () => {
    const tree: LabStage[] = [
      mkStage({ id: 's-main', kind: 'main' }),
      mkStage({ id: 's-mid', kind: 'blueprint', dependsOn: ['s-main'] }),
      mkStage({ id: 's-leaf', kind: 'blueprint', dependsOn: ['s-mid'] }),
    ]
    let stages = reduceStages(reduceStages(tree, { type: 'dispatch', stageId: 's-main', requestId: 'r' }), {
      type: 'fail',
      stageId: 's-main',
      error: 'x',
    })
    expect(at(stages, 's-mid').status).toBe('skipped')
    expect(at(stages, 's-leaf').status).toBe('skipped')

    stages = reduceStages(stages, { type: 'retry', stageId: 's-main' })
    expect(at(stages, 's-mid').status).toBe('pending')
    expect(at(stages, 's-leaf').status).toBe('pending')
  })

  it('脏树防御：running 的下游不被 fail/skip 级联（接线层 abort 归位）；success 下游被 retry 级联重置', () => {
    // 脏树：main running 失败时下游竟在 running（良构树不可达）——状态机不动它，交还接线层
    const dirtyRunning: LabStage[] = [
      mkStage({ id: 's-main', kind: 'main', status: 'running' }),
      mkStage({ id: 's-bp', kind: 'blueprint', dependsOn: ['s-main'], status: 'running' }),
    ]
    const afterFail = reduceStages(dirtyRunning, { type: 'fail', stageId: 's-main', error: 'x' })
    expect(at(afterFail, 's-bp').status).toBe('running')

    // 脏树：main error 而 blueprint 残留 success（旧产物）——retry main 时换代失效一并重置
    const dirtyStale: LabStage[] = [
      mkStage({ id: 's-main', kind: 'main', status: 'error' }),
      mkStage({ id: 's-bp', kind: 'blueprint', dependsOn: ['s-main'], status: 'success', assetId: 'ast-old', imageStored: true }),
    ]
    const afterRetry = reduceStages(dirtyStale, { type: 'retry', stageId: 's-main' })
    expect(at(afterRetry, 's-bp').status).toBe('pending')
    expect(at(afterRetry, 's-bp').assetId).toBeUndefined()
  })

  it('并行策略 A：main fail 不级联 blueprint（无依赖边，blueprint 照跑）；父状态按派生表取 main error', () => {
    const parallel = createTaskStages('t1', { strategy: 'parallel' })
    let stages = reduceStages(parallel, { type: 'dispatch', stageId: MAIN, requestId: 'r1' })
    stages = reduceStages(stages, { type: 'dispatch', stageId: BP, requestId: 'r2' })
    stages = reduceStages(stages, { type: 'fail', stageId: MAIN, error: 'x' })
    expect(at(stages, BP).status).toBe('running')
    // 派生表 main 行优先：main error → error（blueprint 进行中只在 stage 面可见）
    expect(deriveTaskStatus(stages)).toBe('error')
  })
})

describe('重试语义：retryCount 递增 + 新 requestId', () => {
  it('连续失败重试：retryCount 逐次递增，旧 requestId 每次清空（新派发新 id 不复用）', () => {
    let stages = serial()
    const seenRequestIds: string[] = []
    for (let round = 1; round <= 3; round += 1) {
      const requestId = `req-${round}`
      seenRequestIds.push(requestId)
      stages = reduceStages(stages, { type: 'dispatch', stageId: MAIN, requestId })
      expect(at(stages, MAIN).requestId).toBe(requestId)
      stages = reduceStages(stages, { type: 'fail', stageId: MAIN, error: `第 ${round} 次失败` })
      stages = reduceStages(stages, { type: 'retry', stageId: MAIN })
      expect(at(stages, MAIN).retryCount).toBe(round)
      // 重试落 pending 的瞬间旧 requestId 已清空——后续派发只可能是新 id
      expect(at(stages, MAIN).requestId).toBeUndefined()
    }
    // 第 4 次派发用全新 id：与历史全部不同（不复用）
    const freshId = 'req-final'
    expect(seenRequestIds).not.toContain(freshId)
    stages = reduceStages(stages, { type: 'dispatch', stageId: MAIN, requestId: freshId })
    expect(at(stages, MAIN).requestId).toBe(freshId)
    expect(at(stages, MAIN).retryCount).toBe(3)
  })

  it('retry 级联复活的 blueprint 不递增 retryCount（换代重置非用户重试）', () => {
    let stages = reduceStages(serial(), { type: 'dispatch', stageId: MAIN, requestId: 'r1' })
    stages = reduceStages(stages, { type: 'fail', stageId: MAIN, error: 'x' })
    stages = reduceStages(stages, { type: 'retry', stageId: MAIN })
    expect(at(stages, MAIN).retryCount).toBe(1)
    expect(at(stages, BP).retryCount).toBe(0)
  })

  it('blueprint 自身重试才递增自身 retryCount（与 main 计数互不串扰）', () => {
    let stages = dispatchAndSucceed(serial(), MAIN, 'r-main')
    stages = reduceStages(stages, { type: 'dispatch', stageId: BP, requestId: 'r-bp-1' })
    stages = reduceStages(stages, { type: 'fail', stageId: BP, error: 'x' })
    stages = reduceStages(stages, { type: 'retry', stageId: BP })
    expect(at(stages, BP).retryCount).toBe(1)
    expect(at(stages, MAIN).retryCount).toBe(0)
  })

  it('完整串行 happy path：main success → blueprint 派发成功 → 父任务 success', () => {
    let stages = dispatchAndSucceed(serial(), MAIN, 'r-main', { assetId: 'ast-main' })
    expect(deriveTaskStatus(stages)).toBe('running') // 蓝图进行中
    stages = dispatchAndSucceed(stages, BP, 'r-bp', { assetId: 'ast-bp' })
    expect(deriveTaskStatus(stages)).toBe('success')
    expect(at(stages, BP).dependsOn).toEqual([MAIN])
  })
})
