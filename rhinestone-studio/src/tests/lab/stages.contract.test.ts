/**
 * 0.3 生命周期与蓝图契约登记测试（核对+补缺，不重写轨 B 实现）：
 * - LabStage / StageEvent / 状态机签名类型编译锁（design §3.1/§3.2 逐字段——expectTypeOf
 *   由 svelte-check/tsc 消费）；
 * - §3.3 父任务派生表逐行紧凑复断言（轨 B stages.reduce.test.ts 的契约面收口）；
 * - 归档契约补缺：deriveArchivePlan（自动双档/两档并存）+ blueprintProvenanceOf
 *   （skipped 投影压缩 cancelled+错误码）+ PROVENANCE_BLUEPRINT_PROMPT_KEY 落键登记。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BLUEPRINT_INTERRUPTED_ERROR,
  createTaskStages,
  deriveArchivePlan,
  deriveTaskStatus,
  PROVENANCE_BLUEPRINT_PROMPT_KEY,
  reduceStages,
  schedulableStages,
  SKIPPED_UPSTREAM_ERROR_CODE,
  stageIdOf,
  stagesToPersisted,
  type ArchiveUnit,
  type LabStage,
  type ProvenanceBlueprintSnapshot,
  type StageEvent,
  type StageKind,
  type StageStatus,
} from '$lib/lab/stages'
import type { ImageTaskDebug } from '$lib/api/client'

const MAIN = stageIdOf('t1', 'main')
const BP = stageIdOf('t1', 'blueprint')

function mkStages(mainStatus: StageStatus, blueprintStatus?: StageStatus): LabStage[] {
  const base = blueprintStatus === undefined ? createTaskStages('t1') : createTaskStages('t1', { strategy: 'serial' })
  let next = base.map((s) => (s.id === MAIN ? { ...s, status: mainStatus } : s))
  if (blueprintStatus !== undefined) {
    next = next.map((s) => (s.id === BP ? { ...s, status: blueprintStatus } : s))
  }
  return next
}

describe('0.3 类型契约编译锁（§3.1/§3.2 逐字段）', () => {
  it('LabStage ≡ design §3.1 结构（含时间戳三件套）', () => {
    expectTypeOf<LabStage>().toEqualTypeOf<{
      id: string
      kind: StageKind
      status: StageStatus
      dependsOn: string[]
      requestId?: string
      assetId?: string
      imageUrl?: string
      imageStored: boolean
      error?: string
      debug?: ImageTaskDebug
      retryCount: number
      startedAt?: number
      finishedAt?: number
      durationMs?: number
    }>()
  })

  it('StageEvent 六事件联合（§3.2 冻结）', () => {
    const events: StageEvent[] = [
      { type: 'dispatch', stageId: MAIN, requestId: 'r' },
      { type: 'succeed', stageId: MAIN },
      { type: 'fail', stageId: MAIN, error: 'e' },
      { type: 'cancel', stageId: MAIN },
      { type: 'retry', stageId: MAIN },
      { type: 'invalidate', stageId: MAIN },
    ]
    expect(events).toHaveLength(6)
  })

  it('ProvenanceBlueprintSnapshot ≡ design §1.3 快照形状', () => {
    expectTypeOf<ProvenanceBlueprintSnapshot>().toEqualTypeOf<{
      strategy: 'serial' | 'parallel'
      status: 'success' | 'failed' | 'cancelled'
      error?: string
    }>()
  })
})

describe('§3.3 父任务派生表逐行（紧凑复断言——轨 B 已覆盖实现面）', () => {
  it.each([
    ['main pending', mkStages('pending', 'running'), 'pending'],
    ['main running', mkStages('running', 'pending'), 'running'],
    ['main success 无 blueprint', mkStages('success'), 'success'],
    ['main success + bp pending', mkStages('success', 'pending'), 'running'],
    ['main success + bp running', mkStages('success', 'running'), 'running'],
    ['main success + bp success', mkStages('success', 'success'), 'success'],
    ['main success + bp error', mkStages('success', 'error'), 'success'],
    ['main success + bp cancelled', mkStages('success', 'cancelled'), 'success'],
    ['main success + bp skipped', mkStages('success', 'skipped'), 'success'],
    ['main error', mkStages('error', 'skipped'), 'error'],
    ['main cancelled', mkStages('cancelled', 'cancelled'), 'cancelled'],
  ] as const)('%s → %s', (_label, stages, expected) => {
    expect(deriveTaskStatus(stages)).toBe(expected)
  })

  it('状态机/调度/持久化签名在位（消费面编译通过即契约成立）', () => {
    expect(typeof reduceStages).toBe('function')
    expect(typeof schedulableStages).toBe('function')
    expect(typeof stagesToPersisted).toBe('function')
    expect(schedulableStages(mkStages('pending', 'pending'), 0, 4).map((s) => s.id)).toEqual([MAIN])
  })
})

describe('blueprintProvenanceOf（§1.3 + §3.3 策略 5 投影）', () => {
  it('error → failed 透传；cancelled → cancelled 透传；success 无 error 键', () => {
    const failed = deriveArchivePlan(mkStages('success', 'error')).find((u) => u.kind === 'full')
    expect(failed).toEqual({ kind: 'full', blueprint: { strategy: 'serial', status: 'failed' } })

    const cancelledStages = mkStages('success', 'cancelled').map((s) =>
      s.id === BP ? { ...s, error: BLUEPRINT_INTERRUPTED_ERROR } : s,
    )
    expect(deriveArchivePlan(cancelledStages).find((u) => u.kind === 'full')).toEqual({
      kind: 'full',
      blueprint: { strategy: 'serial', status: 'cancelled', error: BLUEPRINT_INTERRUPTED_ERROR },
    })
    expect(deriveArchivePlan(mkStages('success', 'success'))[1]).toEqual({
      kind: 'full',
      blueprint: { strategy: 'serial', status: 'success' },
    })
  })

  it('skipped → cancelled + SKIPPED_UPSTREAM（投影压缩——内部独立终态，档案有意映射）', () => {
    const plan = deriveArchivePlan(mkStages('success', 'skipped'))
    expect(plan[1]).toEqual({ kind: 'full', blueprint: { strategy: 'serial', status: 'cancelled', error: SKIPPED_UPSTREAM_ERROR_CODE } })
    expect(SKIPPED_UPSTREAM_ERROR_CODE).toBe('SKIPPED_UPSTREAM')
  })

  it('parallel 策略透传进快照', () => {
    const stages = mkStages('success', 'success')
    expect(deriveArchivePlan(stages, 'parallel')[1]).toEqual({
      kind: 'full',
      blueprint: { strategy: 'parallel', status: 'success' },
    })
  })
})

describe('deriveArchivePlan：归档时点（§3.3 派生表归档列 + §5.1 自动双档）', () => {
  it.each([
    ['main 活动态（不归档）', mkStages('pending', 'pending'), []],
    ['main running（不归档）', mkStages('running', 'running'), []],
    ['main error（不归档）', mkStages('error', 'skipped'), []],
    ['main cancelled（不归档）', mkStages('cancelled'), []],
    ['main success 无 blueprint → 单图档', mkStages('success'), [{ kind: 'single' }] satisfies ArchiveUnit[]],
    [
      'main success + bp running → 先行单图档',
      mkStages('success', 'running'),
      [{ kind: 'single' }] satisfies ArchiveUnit[],
    ],
  ] as const)('%s', (_label, stages, expected) => {
    expect(deriveArchivePlan(stages)).toEqual(expected)
  })

  it('main success + bp 终态 → 两档并存（声明序 [单图先行档, 双图完整档]，幂等判重归 4.4）', () => {
    const plan = deriveArchivePlan(mkStages('success', 'success'))
    expect(plan.map((u) => u.kind)).toEqual(['single', 'full'])
  })

  it('blueprintPrompt 全文快照落键登记（§5.2 冻结）', () => {
    expect(PROVENANCE_BLUEPRINT_PROMPT_KEY).toBe('blueprintPrompt')
  })
})
