/*
 * 集合侧栏纯模型（add-stone-library S7.4——design §7.6/§7.1）。
 * 聚合（数量求和/未声明计数/缺失计数）、限定名展示投影（双标准同编号区分）、
 * cell→成员即时投影、buildUpdatePatch（字段级 diff/null 清除/无变更 null）、
 * revision 漂移判别。纯函数直测。
 */

import { describe, expect, it } from 'vitest'
import {
  aggregateMembers,
  buildUpdatePatch,
  isRevisionConflict,
  memberFromCell,
  memberFromResolution,
  memberQualifiedName,
  type WarehouseMember,
} from '$lib/warehouse/setModel'
import { makeCell } from '../stonesAdmin/fixtures'
import type { SetMemberResolution } from '$lib/warehouse/schemas'

function member(overrides: Partial<WarehouseMember> & { stoneRef: string }): WarehouseMember {
  return { state: 'resolved', ...overrides }
}

describe('aggregateMembers（侧栏汇总——数量求和/缺失警示）', () => {
  it('数量求和+成员数', () => {
    const aggregate = aggregateMembers([
      member({ stoneRef: 'a', quantity: 2 }),
      member({ stoneRef: 'b', quantity: 3 }),
      member({ stoneRef: 'c' }),
    ])
    expect(aggregate).toEqual({ memberCount: 3, totalQuantity: 5, undeclaredQuantityCount: 1, missingCount: 0 })
  })

  it('全部未声明（quantity 缺省=按设计用量另计）', () => {
    const aggregate = aggregateMembers([member({ stoneRef: 'a' }), member({ stoneRef: 'b' })])
    expect(aggregate.totalQuantity).toBe(0)
    expect(aggregate.undeclaredQuantityCount).toBe(2)
  })

  it('缺失成员计数（五态非 resolved——不剔除只计数）', () => {
    const aggregate = aggregateMembers([
      member({ stoneRef: 'a' }),
      member({ stoneRef: 'b', state: 'soft-deleted' }),
      member({ stoneRef: 'c', state: 'blob-missing' }),
      member({ stoneRef: 'd', state: 'not-found' }),
      member({ stoneRef: 'e', state: 'wrong-kind' }),
    ])
    expect(aggregate.missingCount).toBe(4)
    expect(aggregate.memberCount).toBe(5)
  })

  it('空集合', () => {
    expect(aggregateMembers([])).toEqual({ memberCount: 0, totalQuantity: 0, undeclaredQuantityCount: 0, missingCount: 0 })
  })
})

describe('memberQualifiedName（限定名——编号冲突区分的落点）', () => {
  it('服务端解析投影优先', () => {
    expect(memberQualifiedName(member({ stoneRef: 'r1', qualifiedSku: 'factoryB/J51' }))).toBe('factoryB/J51')
  })

  it('双标准同编号可区分（yuhang/J51 vs factoryB/J51）', () => {
    const yuhangCell = makeCell({ resourceId: 'r1', supplier: 'yuhang', sku: 'J51' })
    const factoryCell = makeCell({ resourceId: 'r2', supplier: 'factoryB', sku: 'J51', name: '亮白 · 2mm' })
    expect(memberQualifiedName(member({ stoneRef: 'r1' }), yuhangCell)).toBe('yuhang/J51')
    expect(memberQualifiedName(member({ stoneRef: 'r2' }), factoryCell)).toBe('factoryB/J51')
  })

  it('双缺（wrong-kind/not-found 行已删）→ 短 ref 兜底不伪造', () => {
    expect(memberQualifiedName(member({ stoneRef: 'res-1234567890', state: 'not-found' }))).toBe('未解析/res-1234')
  })
})

describe('memberFromCell / memberFromResolution（成员投影构造）', () => {
  it('cell → 成员（即时投影：限定名+贴图零二次请求）', () => {
    const cell = makeCell({ resourceId: 'r1', supplier: 'yuhang', sku: 'J51' })
    expect(memberFromCell(cell)).toEqual({
      stoneRef: 'r1',
      state: 'resolved',
      standardId: 'yuhang',
      qualifiedSku: 'yuhang/J51',
      textureUrl: '/api/stones/res-j51/texture.png',
    })
  })

  it('resolution → 成员（读时解析——quantity/note/限定名携带）', () => {
    const resolution: SetMemberResolution = {
      stoneRef: 'r1',
      state: 'soft-deleted',
      quantity: 4,
      note: '补货中',
      standardId: 'factoryB',
      qualifiedSku: 'factoryB/J51',
    }
    expect(memberFromResolution(resolution)).toEqual({
      stoneRef: 'r1',
      state: 'soft-deleted',
      quantity: 4,
      note: '补货中',
      standardId: 'factoryB',
      qualifiedSku: 'factoryB/J51',
    })
  })

  it('bare resolution（not-found 无投影字段）→ 最小成员', () => {
    expect(memberFromResolution({ stoneRef: 'r9', state: 'not-found' })).toEqual({ stoneRef: 'r9', state: 'not-found' })
  })
})

describe('buildUpdatePatch（成员增删/字段级 diff——update 调用形态的唯一构造点）', () => {
  const snapshotMembers = [
    { stoneRef: 'a', quantity: 2, note: '旧注' },
    { stoneRef: 'b', quantity: 1 },
    { stoneRef: 'c' },
  ]

  it('无变更 → null（保存按钮禁用依据）', () => {
    expect(buildUpdatePatch({ name: '套餐', members: snapshotMembers }, { name: '套餐', members: snapshotMembers })).toBeNull()
  })

  it('改名', () => {
    const patch = buildUpdatePatch({ name: '套餐A', members: snapshotMembers }, { name: '套餐B', members: snapshotMembers })
    expect(patch).toEqual({ name: '套餐B' })
  })

  it('用途：新增/改写/清除（空串→null=清除语义）', () => {
    expect(buildUpdatePatch({ name: 'x', members: snapshotMembers }, { name: 'x', purpose: '小件订单', members: snapshotMembers })?.purpose).toBe('小件订单')
    expect(buildUpdatePatch({ name: 'x', purpose: '旧用途', members: snapshotMembers }, { name: 'x', members: snapshotMembers })?.purpose).toBeNull()
    expect(buildUpdatePatch({ name: 'x', purpose: '旧用途', members: snapshotMembers }, { name: 'x', purpose: '新用途', members: snapshotMembers })?.purpose).toBe('新用途')
  })

  it('成员增删（addMembers/removeMembers）', () => {
    const draft = [{ stoneRef: 'a', quantity: 2, note: '旧注' }, { stoneRef: 'd' }, { stoneRef: 'e', quantity: 5 }]
    const patch = buildUpdatePatch({ name: 'x', members: snapshotMembers }, { name: 'x', members: draft })
    expect(patch?.removeMembers).toEqual(['b', 'c'])
    expect(patch?.addMembers).toEqual([{ stoneRef: 'd' }, { stoneRef: 'e', quantity: 5 }])
    expect(patch?.updateMembers).toBeUndefined()
  })

  it('字段级更新：数量声明/清除、备注改写/清除（undefined↔null 三态）', () => {
    const draft = [
      { stoneRef: 'a', quantity: 2, note: '新注' }, // note 变更
      { stoneRef: 'b', quantity: 7 }, // 数量变更
      { stoneRef: 'c', quantity: 3, note: '补一行' }, // 数量+备注双变更
    ]
    const patch = buildUpdatePatch({ name: 'x', members: snapshotMembers }, { name: 'x', members: draft })
    expect(patch?.updateMembers).toEqual([
      { stoneRef: 'a', note: '新注' },
      { stoneRef: 'b', quantity: 7 },
      { stoneRef: 'c', quantity: 3, note: '补一行' },
    ])
    // 反向：清除数量（→null）与清除备注（''→null）
    const back = [{ stoneRef: 'a', quantity: 2 }, { stoneRef: 'b', quantity: 1, note: '' }, { stoneRef: 'c' }]
    const patch2 = buildUpdatePatch({ name: 'x', members: snapshotMembers }, { name: 'x', members: back })
    expect(patch2?.updateMembers).toEqual([{ stoneRef: 'a', note: null }, { stoneRef: 'b', note: null }])
  })

  it('新增成员同时带数量/备注 → 走 addMembers 不走 updateMembers', () => {
    const draft = [...snapshotMembers, { stoneRef: 'z', quantity: 9, note: '新加' }]
    const patch = buildUpdatePatch({ name: 'x', members: snapshotMembers }, { name: 'x', members: draft })
    expect(patch?.addMembers).toEqual([{ stoneRef: 'z', quantity: 9, note: '新加' }])
    expect(patch?.updateMembers).toBeUndefined()
  })
})

describe('isRevisionConflict（CAS 漂移判别）', () => {
  it('typed code=revision-conflict 命中', () => {
    expect(isRevisionConflict({ code: 'revision-conflict' })).toBe(true)
    class Err extends Error {
      constructor(message: string, readonly code: string) {
        super(message)
      }
    }
    expect(isRevisionConflict(new Err('漂移', 'revision-conflict'))).toBe(true)
  })

  it('其他 typed 码/普通错误/非对象 → 不命中', () => {
    expect(isRevisionConflict({ code: 'empty-members' })).toBe(false)
    expect(isRevisionConflict(new Error('网络失败'))).toBe(false)
    expect(isRevisionConflict(null)).toBe(false)
    expect(isRevisionConflict('revision-conflict')).toBe(false)
    expect(isRevisionConflict({})).toBe(false)
  })
})
