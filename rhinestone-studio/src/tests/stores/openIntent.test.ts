/**
 * openIntent claim/ack 状态机契约（openspec add-project-files design §9.2 B3，切片 0.7）：
 * 纯 store 层（不挂载组件；UI 动线时序归 4.6）——
 *
 * - 状态机主干：pending → claimed(token) → succeeded（清意图）/ failed（保留+reason）
 * - claim 原子性：两并发 claimer（同步连调 + 微任务模拟）一胜一败
 * - replace：pending/claimed/failed 任一阶段新意图整体替换，旧 token ack = 'stale' no-op
 * - ack 语义：ackSuccess 清意图 / ackFailed 不清且带 reason / 非claimer token 一切 no-op
 * - 幂等：连续 set→claim→ack 周期互不干扰、重复 ack = 'stale'、token 不复用
 * - 刷新等价物：resetOpenIntentForTests（内存 $state 重初始化）后意图为空
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  ackOpenIntentFailure,
  ackOpenIntentSuccess,
  claimOpenIntent,
  peekOpenIntent,
  resetOpenIntentForTests,
  setOpenIntent,
  type OpenIntentClaim,
} from '$lib/stores/openIntent.svelte'

beforeEach(() => {
  resetOpenIntentForTests()
})

describe('状态机主干：pending → claimed → succeeded|failed', () => {
  it('set → peek pending（token null）→ claim → peek claimed（同 token）→ ackSuccess 清意图', () => {
    setOpenIntent({ kind: 'gemgen', assetId: 'ast-1' })
    expect(peekOpenIntent()).toMatchObject({ phase: 'pending', kind: 'gemgen', assetId: 'ast-1', token: null })

    const claim = claimOpenIntent()
    expect(claim).not.toBeNull()
    expect(claim).toMatchObject({ kind: 'gemgen', assetId: 'ast-1' })
    expect(peekOpenIntent()).toMatchObject({ phase: 'claimed', token: (claim as OpenIntentClaim).token })

    expect(ackOpenIntentSuccess((claim as OpenIntentClaim).token)).toBe('consumed')
    expect(peekOpenIntent()).toBeNull()
  })

  it('ackFailed：不清意图、转 failed 带 reason，可诊断', () => {
    setOpenIntent({ kind: 'gemtpl', assetId: 'ast-tpl-2' })
    const claim = claimOpenIntent() as OpenIntentClaim
    expect(ackOpenIntentFailure(claim.token, 'DOM 定位失败：目标组不存在')).toBe('failed')
    const snapshot = peekOpenIntent()
    expect(snapshot).toMatchObject({
      phase: 'failed',
      kind: 'gemtpl',
      assetId: 'ast-tpl-2',
      token: claim.token,
      reason: 'DOM 定位失败：目标组不存在',
    })
    // 意图保留（peek 仍可见），不可再被 claim
    expect(peekOpenIntent()).not.toBeNull()
    expect(claimOpenIntent()).toBeNull()
    // failed 是该 claim 的终态：同 token 再 ackSuccess 亦 'stale'（重试请置新意图）
    expect(ackOpenIntentSuccess(claim.token)).toBe('stale')
  })
})

describe('claim 原子性（同步临界区：检查+置位无 await 间隙）', () => {
  it('同步连调两个 claimer：一胜一败（败者 null）', () => {
    setOpenIntent({ kind: 'gemproj', assetId: 'ast-3' })
    const winner = claimOpenIntent()
    const loser = claimOpenIntent()
    expect(winner).not.toBeNull()
    expect(loser).toBeNull()
    expect(peekOpenIntent()?.phase).toBe('claimed')
  })

  it('微任务并模拟并发（Promise.all 两 claimer）：仍恰一个成功', async () => {
    setOpenIntent({ kind: 'gemdoc', assetId: 'ast-4' })
    const results = await Promise.all([
      Promise.resolve().then(() => claimOpenIntent()),
      Promise.resolve().then(() => claimOpenIntent()),
    ])
    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(1)
    // 胜者的 token 可正常 ack；状态只有一个 claimed
    expect(ackOpenIntentSuccess((winners[0] as OpenIntentClaim).token)).toBe('consumed')
    expect(peekOpenIntent()).toBeNull()
  })
})

describe('replace：新意图作废旧意图（含旧 claim）', () => {
  it('pending 阶段替换：只余最新意图', () => {
    setOpenIntent({ kind: 'gemproj', assetId: 'ast-a' })
    setOpenIntent({ kind: 'gemgen', assetId: 'ast-b' })
    expect(peekOpenIntent()).toMatchObject({ phase: 'pending', assetId: 'ast-b', kind: 'gemgen' })
  })

  it('claimed 阶段替换：旧 token ack = stale no-op，新链路照常走通', () => {
    setOpenIntent({ kind: 'gemgen', assetId: 'ast-a' })
    const stale = claimOpenIntent() as OpenIntentClaim
    setOpenIntent({ kind: 'gemtpl', assetId: 'ast-b' })

    expect(ackOpenIntentSuccess(stale.token)).toBe('stale')
    expect(ackOpenIntentFailure(stale.token, '迟到失败')).toBe('stale')
    expect(peekOpenIntent()).toMatchObject({ phase: 'pending', assetId: 'ast-b' })

    const fresh = claimOpenIntent() as OpenIntentClaim
    expect(fresh.token).not.toBe(stale.token)
    expect(ackOpenIntentSuccess(fresh.token)).toBe('consumed')
  })

  it('failed 阶段替换：诊断态被新意图清除', () => {
    setOpenIntent({ kind: 'gemdoc', assetId: 'ast-a' })
    const first = claimOpenIntent() as OpenIntentClaim
    ackOpenIntentFailure(first.token, '模板回链失败')
    setOpenIntent({ kind: 'gemproj', assetId: 'ast-b' })
    const snapshot = peekOpenIntent()
    expect(snapshot).toMatchObject({ phase: 'pending', assetId: 'ast-b' })
    expect('reason' in (snapshot as object)).toBe(false) // 诊断态随替换清除
  })
})

describe('非 claimer token 一切 no-op', () => {
  it('伪造 token 的 ackSuccess/ackFailed 均 stale，状态原封不动', () => {
    setOpenIntent({ kind: 'gemgen', assetId: 'ast-5' })
    const claim = claimOpenIntent() as OpenIntentClaim
    expect(ackOpenIntentSuccess('intent-forged')).toBe('stale')
    expect(ackOpenIntentFailure('intent-forged', 'x')).toBe('stale')
    expect(peekOpenIntent()).toMatchObject({ phase: 'claimed', token: claim.token, assetId: 'ast-5' })
    // 真 token 仍有效（no-op 未污染状态机）
    expect(ackOpenIntentSuccess(claim.token)).toBe('consumed')
  })

  it('空意图上的 ack 与 claim：均安全 no-op/null', () => {
    expect(peekOpenIntent()).toBeNull()
    expect(claimOpenIntent()).toBeNull()
    expect(ackOpenIntentSuccess('intent-any')).toBe('stale')
    expect(ackOpenIntentFailure('intent-any', 'x')).toBe('stale')
  })
})

describe('幂等与周期隔离', () => {
  it('连续 set→claim→ack 两周期：互不干扰、token 不复用、重复 ack = stale', () => {
    setOpenIntent({ kind: 'gemproj', assetId: 'ast-6' })
    const first = claimOpenIntent() as OpenIntentClaim
    expect(ackOpenIntentSuccess(first.token)).toBe('consumed')
    expect(ackOpenIntentSuccess(first.token)).toBe('stale') // 重复 ack
    expect(peekOpenIntent()).toBeNull()

    setOpenIntent({ kind: 'gemgen', assetId: 'ast-7' })
    const second = claimOpenIntent() as OpenIntentClaim
    expect(second.token).not.toBe(first.token)
    expect(peekOpenIntent()).toMatchObject({ phase: 'claimed', assetId: 'ast-7' })
    expect(ackOpenIntentSuccess(first.token)).toBe('stale') // 旧周期 token 不越权
    expect(ackOpenIntentSuccess(second.token)).toBe('consumed')
  })

  it('ackFailed 后重复 ackFailed（同 token）= stale：failed 只落一次 reason', () => {
    setOpenIntent({ kind: 'gemtpl', assetId: 'ast-8' })
    const claim = claimOpenIntent() as OpenIntentClaim
    expect(ackOpenIntentFailure(claim.token, '首次失败')).toBe('failed')
    expect(ackOpenIntentFailure(claim.token, '重复失败')).toBe('stale')
    expect(peekOpenIntent()).toMatchObject({ phase: 'failed', reason: '首次失败' })
  })
})

describe('刷新语义（纯内存 $state，不持久化——设计裁决）', () => {
  it('重置（重新初始化等价物）后意图为空，claim 无主', () => {
    setOpenIntent({ kind: 'gemgen', assetId: 'ast-9' })
    const claim = claimOpenIntent() as OpenIntentClaim
    expect(peekOpenIntent()?.phase).toBe('claimed')
    resetOpenIntentForTests()
    expect(peekOpenIntent()).toBeNull()
    expect(claimOpenIntent()).toBeNull()
    expect(ackOpenIntentSuccess(claim.token)).toBe('stale') // 刷新丢弃后旧 token 失效
  })
})

describe('四 kind 单 store 统一 payload', () => {
  it('gemproj/gemdoc/gemtpl/gemgen 依次置意图：单 store 替换不串道', () => {
    const kinds = ['gemproj', 'gemdoc', 'gemtpl', 'gemgen'] as const
    let index = 0
    for (const kind of kinds) {
      index += 1
      setOpenIntent({ kind, assetId: `ast-${kind}-${index}` })
      expect(peekOpenIntent()).toMatchObject({ phase: 'pending', kind, assetId: `ast-${kind}-${index}` })
      const claim = claimOpenIntent() as OpenIntentClaim
      expect(claim.kind).toBe(kind)
      expect(ackOpenIntentSuccess(claim.token)).toBe('consumed')
    }
  })
})
