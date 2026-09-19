/**
 * 轨 B 2.1：stage 状态机 reduce 纯函数 + 派生表 + schedulable 判定。
 * 覆盖：reduce 六事件 × 串行/并行两树矩阵、design §3.3 派生表逐行、
 * 依赖不满足不派发、并发预算（max-runningCount）、纯函数性（无突变/无 IO）。
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
  type StageStatus,
} from '$lib/lab/stages'

const BASE_TIME = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
})

afterEach(() => {
  vi.useRealTimers()
})

function mkStage(patch: Partial<LabStage> & { id: string; kind: StageKind }): LabStage {
  return { status: 'pending', dependsOn: [], imageStored: false, retryCount: 0, ...patch }
}

/** 状态覆盖助手（不改 id/kind/dependsOn 结构）。 */
function withStatus(stages: LabStage[], stageId: string, status: StageStatus, extra: Partial<LabStage> = {}): LabStage[] {
  return stages.map((s) => (s.id === stageId ? { ...s, status, ...extra } : s))
}

const MAIN = stageIdOf('t1', 'main')
const BP = stageIdOf('t1', 'blueprint')

describe('reduceStages 六事件 × 串行/并行两树', () => {
  it('dispatch：pending → running，落 requestId/startedAt，清残留 error', () => {
    for (const tree of [createTaskStages('t1', { strategy: 'serial' }), createTaskStages('t1', { strategy: 'parallel' })]) {
      const next = reduceStages(withStatus(tree, MAIN, 'pending', { error: '旧错误' }), {
        type: 'dispatch',
        stageId: MAIN,
        requestId: 'req-1',
      })
      const main = next.find((s) => s.id === MAIN)
      expect(main?.status).toBe('running')
      expect(main?.requestId).toBe('req-1')
      expect(main?.startedAt).toBe(BASE_TIME)
      expect(main?.error).toBeUndefined()
    }
  })

  it('dispatch 对非 pending（running/success/error）幂等 no-op（原引用返回）', () => {
    for (const status of ['running', 'success', 'error', 'cancelled', 'skipped'] as const) {
      const tree = withStatus(createTaskStages('t1'), MAIN, status, { requestId: 'old' })
      expect(reduceStages(tree, { type: 'dispatch', stageId: MAIN, requestId: 'new' })).toBe(tree)
    }
  })

  it('succeed：running → success，落 finishedAt/durationMs；对非 running no-op', () => {
    const tree = withStatus(createTaskStages('t1'), MAIN, 'running', { startedAt: BASE_TIME })
    const next = reduceStages(tree, { type: 'succeed', stageId: MAIN })
    const main = next.find((s) => s.id === MAIN)
    expect(main?.status).toBe('success')
    expect(main?.finishedAt).toBe(BASE_TIME)
    expect(main?.durationMs).toBe(0)

    vi.advanceTimersByTime(5_000)
    const pending = createTaskStages('t1')
    expect(reduceStages(pending, { type: 'succeed', stageId: MAIN })).toBe(pending)
    const success = withStatus(pending, MAIN, 'success')
    expect(reduceStages(success, { type: 'succeed', stageId: MAIN })).toBe(success)
  })

  it('succeed 缺 startedAt 时以完成时刻兜底（durationMs=0），不抛', () => {
    const next = reduceStages(withStatus(createTaskStages('t1'), MAIN, 'running'), { type: 'succeed', stageId: MAIN })
    expect(next.find((s) => s.id === MAIN)?.durationMs).toBe(0)
  })

  it('fail：running → error 落错误文案；串行树下游 pending → skipped，并行树无级联', () => {
    const serial = reduceStages(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'running', { startedAt: BASE_TIME }), {
      type: 'fail',
      stageId: MAIN,
      error: '上游 500',
    })
    expect(serial.find((s) => s.id === MAIN)?.status).toBe('error')
    expect(serial.find((s) => s.id === MAIN)?.error).toBe('上游 500')
    expect(serial.find((s) => s.id === MAIN)?.durationMs).toBe(0)
    expect(serial.find((s) => s.id === BP)?.status).toBe('skipped')

    const parallel = reduceStages(withStatus(createTaskStages('t1', { strategy: 'parallel' }), MAIN, 'running'), {
      type: 'fail',
      stageId: MAIN,
      error: '上游 500',
    })
    expect(parallel.find((s) => s.id === BP)?.status).toBe('pending')
  })

  it('cancel：running → cancelled（已取消 + durationMs）；pending → cancelled（无 durationMs）', () => {
    const fromRunning = reduceStages(withStatus(createTaskStages('t1'), MAIN, 'running', { startedAt: BASE_TIME }), {
      type: 'cancel',
      stageId: MAIN,
    })
    expect(fromRunning.find((s) => s.id === MAIN)?.status).toBe('cancelled')
    expect(fromRunning.find((s) => s.id === MAIN)?.error).toBe('已取消')
    expect(fromRunning.find((s) => s.id === MAIN)?.durationMs).toBe(0)

    const fromPending = reduceStages(createTaskStages('t1'), { type: 'cancel', stageId: MAIN })
    expect(fromPending.find((s) => s.id === MAIN)?.status).toBe('cancelled')
    expect(fromPending.find((s) => s.id === MAIN)?.durationMs).toBeUndefined()
  })

  it('cancel 对终态（success/error/cancelled/skipped）no-op', () => {
    for (const status of ['success', 'error', 'cancelled', 'skipped'] as const) {
      const tree = withStatus(createTaskStages('t1'), MAIN, status)
      expect(reduceStages(tree, { type: 'cancel', stageId: MAIN })).toBe(tree)
    }
  })

  it('retry：error|cancelled → pending，retryCount+1，旧 requestId/产物/时间戳清空', () => {
    for (const status of ['error', 'cancelled'] as const) {
      const tree = withStatus(createTaskStages('t1'), MAIN, status, {
        requestId: 'req-old',
        assetId: 'ast-x',
        imageUrl: 'blob:y',
        imageStored: true,
        error: '旧错误',
        retryCount: 1,
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME + 100,
        durationMs: 100,
      })
      const next = reduceStages(tree, { type: 'retry', stageId: MAIN })
      const main = next.find((s) => s.id === MAIN)
      expect(main?.status).toBe('pending')
      expect(main?.retryCount).toBe(2)
      expect(main?.requestId).toBeUndefined()
      expect(main?.assetId).toBeUndefined()
      expect(main?.imageUrl).toBeUndefined()
      expect(main?.imageStored).toBe(false)
      expect(main?.error).toBeUndefined()
      expect(main?.startedAt).toBeUndefined()
      expect(main?.finishedAt).toBeUndefined()
      expect(main?.durationMs).toBeUndefined()
    }
  })

  it('retry 对 success/pending/running/skipped no-op（skipped 须经上游 retry 级联复活）', () => {
    for (const status of ['success', 'pending', 'running', 'skipped'] as const) {
      const tree = withStatus(createTaskStages('t1'), MAIN, status)
      expect(reduceStages(tree, { type: 'retry', stageId: MAIN })).toBe(tree)
    }
  })

  it('invalidate：success → pending 清产物与瞬态，retryCount 不动；running 不被 invalidate（abort 归接线层）', () => {
    const tree = withStatus(createTaskStages('t1'), MAIN, 'success', {
      requestId: 'req-1',
      assetId: 'ast-1',
      imageUrl: 'blob:1',
      imageStored: true,
      retryCount: 2,
      startedAt: BASE_TIME,
      finishedAt: BASE_TIME + 10,
      durationMs: 10,
    })
    const next = reduceStages(tree, { type: 'invalidate', stageId: MAIN })
    const main = next.find((s) => s.id === MAIN)
    expect(main?.status).toBe('pending')
    expect(main?.retryCount).toBe(2)
    expect(main?.requestId).toBeUndefined()
    expect(main?.assetId).toBeUndefined()
    expect(main?.imageStored).toBe(false)
    expect(main?.durationMs).toBeUndefined()

    const running = withStatus(createTaskStages('t1'), MAIN, 'running')
    expect(reduceStages(running, { type: 'invalidate', stageId: MAIN })).toBe(running)
  })

  it('未知 stageId：原引用返回（不抛）', () => {
    const tree = createTaskStages('t1')
    expect(reduceStages(tree, { type: 'succeed', stageId: 'stage-nope-main' })).toBe(tree)
  })

  it('纯函数性：冻结输入不抛、不突变原数组', () => {
    const tree = createTaskStages('t1', { strategy: 'serial' })
    Object.freeze(tree)
    tree.forEach((s) => Object.freeze(s))
    const next = reduceStages(reduceStages(tree, { type: 'dispatch', stageId: MAIN, requestId: 'r' }), { type: 'succeed', stageId: MAIN })
    expect(next.find((s) => s.id === MAIN)?.status).toBe('success')
    expect(tree.find((s) => s.id === MAIN)?.status).toBe('pending')
  })
})

describe('deriveTaskStatus 派生表逐行（design §3.3）', () => {
  it('main pending/running（blueprint 任意态）→ pending/running', () => {
    for (const bp of ['pending', 'running', 'success', 'error'] as const) {
      expect(deriveTaskStatus(withStatus(createTaskStages('t1', { strategy: 'serial' }), BP, bp))).toBe('pending')
      expect(
        deriveTaskStatus(withStatus(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'running'), BP, bp)),
      ).toBe('running')
    }
  })

  it('main success，无 blueprint stage → success', () => {
    expect(deriveTaskStatus(withStatus(createTaskStages('t1'), MAIN, 'success'))).toBe('success')
  })

  it('main success + blueprint pending/running → running（蓝图进行中）', () => {
    for (const bp of ['pending', 'running'] as const) {
      expect(deriveTaskStatus(withStatus(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'success'), BP, bp))).toBe('running')
    }
  })

  it('main success + blueprint success → success', () => {
    expect(
      deriveTaskStatus(withStatus(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'success'), BP, 'success')),
    ).toBe('success')
  })

  it('main success + blueprint error/cancelled/skipped → success（徽标与单独重试走 stage 面）', () => {
    for (const bp of ['error', 'cancelled', 'skipped'] as const) {
      expect(deriveTaskStatus(withStatus(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'success'), BP, bp))).toBe('success')
    }
  })

  it('main error → error；main cancelled → cancelled；main skipped（畸形防御）→ cancelled', () => {
    expect(deriveTaskStatus(withStatus(createTaskStages('t1'), MAIN, 'error'))).toBe('error')
    expect(deriveTaskStatus(withStatus(createTaskStages('t1'), MAIN, 'cancelled'))).toBe('cancelled')
    expect(deriveTaskStatus(withStatus(createTaskStages('t1'), MAIN, 'skipped'))).toBe('cancelled')
  })
})

describe('schedulableStages：依赖满足判定 + 并发预算', () => {
  it('串行树：初始只 main 可派发（blueprint 依赖不满足不派发）', () => {
    const out = schedulableStages(createTaskStages('t1', { strategy: 'serial' }), 0, 4)
    expect(out.map((s) => s.id)).toEqual([MAIN])
  })

  it('串行树：main success 后 blueprint 可派发；main error/running 均不可', () => {
    expect(schedulableStages(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'success'), 0, 4).map((s) => s.id)).toEqual([BP])
    expect(schedulableStages(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'error'), 0, 4)).toEqual([])
    expect(schedulableStages(withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'running'), 0, 4)).toEqual([])
  })

  it('并行树：初始两 stage 均可派发', () => {
    expect(schedulableStages(createTaskStages('t1', { strategy: 'parallel' }), 0, 4).map((s) => s.id)).toEqual([MAIN, BP])
  })

  it('并发预算：slots = max - runningCount，按数组序取前 N 个', () => {
    const parallel = createTaskStages('t1', { strategy: 'parallel' })
    expect(schedulableStages(parallel, 4, 4)).toEqual([])
    expect(schedulableStages(parallel, 3, 4).map((s) => s.id)).toEqual([MAIN])
    expect(schedulableStages(parallel, 0, 1).map((s) => s.id)).toEqual([MAIN])
    expect(schedulableStages(parallel, 0, 0)).toEqual([])
  })

  it('依赖 id 缺失（脏数据防御）：视为不满足，不派发', () => {
    const dirty: LabStage[] = [mkStage({ id: 's-a', kind: 'blueprint', dependsOn: ['stage-missing'] })]
    expect(schedulableStages(dirty, 0, 4)).toEqual([])
  })

  it('非 pending（running/success/终态）不在候选内', () => {
    const tree = withStatus(createTaskStages('t1', { strategy: 'serial' }), MAIN, 'success')
    // main 已 success 不重复派发；blueprint 满足依赖但设为 running 后不再派发
    expect(schedulableStages(withStatus(tree, BP, 'running'), 0, 4)).toEqual([])
  })
})
