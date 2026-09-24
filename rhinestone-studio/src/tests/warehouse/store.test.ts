/*
 * 仓储管理工作台 store（add-stone-library S7.4——design §7.6）。
 * 选择集（框选 commit 并集累加+点选 toggle 混合）、添加/删除成员流、数量/备注
 * 行内编辑、组合切换器装载、新建/编辑全链（mock client 调用形态）、CAS 漂移→
 * 提示态+刷新重载（不盲写）、软删组合+回收站只读装载。fixture 注入见 fixtures.ts。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { makeWarehouseClient, type SetsFixtureCalls } from './fixtures'
import {
  addSelectedToSet,
  addWarehouseSelection,
  bindWarehouseClient,
  clearWarehouseSelection,
  filterSectionCells,
  getWarehouseActiveSetId,
  getWarehouseCatalogCell,
  getWarehouseDraftMembers,
  getWarehouseDraftName,
  getWarehouseError,
  getWarehouseSelection,
  getWarehouseSetsList,
  initWarehouse,
  isWarehouseActiveSetTrashed,
  isWarehouseDraftDirty,
  isWarehouseMember,
  isWarehouseStaleDrift,
  reloadAfterDrift,
  removeSelectedFromSet,
  removeWarehouseMember,
  resetWarehouseForTests,
  saveNewWarehouseSet,
  saveWarehouseChanges,
  setWarehouseDraftName,
  setWarehouseMemberNote,
  setWarehouseMemberQuantity,
  softDeleteActiveWarehouseSet,
  switchWarehouseSet,
  toggleWarehouseCell,
  type WarehouseClient,
} from '$lib/warehouse/store.svelte'

let calls: SetsFixtureCalls
let client: WarehouseClient

beforeEach(() => {
  const fixture = makeWarehouseClient({
    sets: [
      {
        label: 'alpha',
        name: '卡通套餐-A',
        members: [
          { stoneRef: 'res-yh-j51', quantity: 2 },
          { stoneRef: 'res-fb-j51' },
        ],
      },
    ],
  })
  calls = fixture.calls
  client = fixture.client
  resetWarehouseForTests()
  bindWarehouseClient(client)
})

describe('初始化与平铺区装载', () => {
  it('tree 双供应商 → 段 cells 装载（catalog 全量键可达）；sets.list 同步拉取', async () => {
    await initWarehouse()
    expect(getWarehouseCatalogCell('res-yh-j51')?.supplier).toBe('yuhang')
    expect(getWarehouseCatalogCell('res-fb-j51')?.supplier).toBe('factoryB')
    expect(getWarehouseCatalogCell('res-nope')).toBeUndefined()
    expect(calls.list.length).toBeGreaterThanOrEqual(1) // sets.list（includeTrashed）
    expect(getWarehouseSetsList().map((s) => s.resourceId)).toEqual(['set-alpha'])
  })

  it('翻页聚合：pageSize 上限内的供应商全量装载', async () => {
    // fixture stones.list 真分页（pageSize 200）——5 格单页即全量
    await initWarehouse()
    const yuhangCells = ['res-yh-j51', 'res-yh-a51', 'res-yh-j52'].filter((id) => getWarehouseCatalogCell(id) !== undefined)
    expect(yuhangCells).toHaveLength(3)
  })
})

describe('段内过滤（平铺区段级 filter 数学）', () => {
  it('色系/尺寸/搜索子串', async () => {
    await initWarehouse()
    const cells = [
      getWarehouseCatalogCell('res-yh-j51')!,
      getWarehouseCatalogCell('res-yh-a51')!,
      getWarehouseCatalogCell('res-yh-j52')!,
      getWarehouseCatalogCell('res-fb-j51')!,
      getWarehouseCatalogCell('res-fb-b52')!,
    ]
    expect(filterSectionCells(cells, { family: '白色系' })).toHaveLength(4)
    expect(filterSectionCells(cells, { family: '金色系' }).map((c) => c.sku)).toEqual(['B52'])
    expect(filterSectionCells(cells, { sizeMm: 3 }).map((c) => c.sku)).toEqual(['A51'])
    expect(filterSectionCells(cells, { q: '香槟' }).map((c) => c.sku)).toEqual(['B52'])
    expect(filterSectionCells(cells, { q: '  ' })).toHaveLength(5) // 空白=不清过滤
  })
})

describe('选择集（框选+点选混合累加）', () => {
  it('点选 toggle 进出；框选 commit 并集累加（不清既有选择）；跨标准持续在场', () => {
    toggleWarehouseCell('res-yh-j51')
    expect(getWarehouseSelection()).toEqual(['res-yh-j51'])
    // marquee 命中 commit（跨标准：yuhang A51 + factoryB J51）
    addWarehouseSelection(['res-yh-a51', 'res-fb-j51'])
    expect(getWarehouseSelection()).toEqual(['res-yh-j51', 'res-yh-a51', 'res-fb-j51'])
    // Ctrl 点选取消其中一个
    toggleWarehouseCell('res-yh-j51')
    expect(getWarehouseSelection()).toEqual(['res-yh-a51', 'res-fb-j51'])
    // 框选重复命中幂等（Set 并集）
    addWarehouseSelection(['res-fb-j51'])
    expect(getWarehouseSelection()).toEqual(['res-yh-a51', 'res-fb-j51'])
  })

  it('清除选择', () => {
    addWarehouseSelection(['res-yh-j51', 'res-yh-a51'])
    clearWarehouseSelection()
    expect(getWarehouseSelection()).toEqual([])
  })
})

describe('添加/删除成员流', () => {
  beforeEach(async () => {
    await initWarehouse()
  })

  it('加入集合：catalog cell 即时投影（限定名+贴图）；重复所选幂等', () => {
    addWarehouseSelection(['res-yh-j51', 'res-fb-j51', 'res-fb-j51'])
    const added = addSelectedToSet()
    expect(added).toBe(2)
    const members = getWarehouseDraftMembers()
    expect(members.map((m) => m.qualifiedSku)).toEqual(['yuhang/J51', 'factoryB/J51'])
    expect(members.every((m) => m.textureUrl !== undefined && m.state === 'resolved')).toBe(true)
    expect(isWarehouseMember('res-yh-j51')).toBe(true)
  })

  it('移除所选成员（仅作用已是成员的所选）+单个移除', () => {
    addWarehouseSelection(['res-yh-j51', 'res-yh-a51'])
    addSelectedToSet()
    toggleWarehouseCell('res-fb-b52') // 所选含非成员
    const removed = removeSelectedFromSet()
    expect(removed).toBe(2)
    expect(getWarehouseDraftMembers()).toHaveLength(0)
    // 移除动作不清选择集（选择=staged，与成员集分离）——再选再加入
    clearWarehouseSelection()
    addWarehouseSelection(['res-yh-j51'])
    addSelectedToSet()
    removeWarehouseMember('res-yh-j51')
    expect(getWarehouseDraftMembers()).toHaveLength(0)
  })

  it('数量/备注行内编辑（声明/清除；非法值拒收）', () => {
    addWarehouseSelection(['res-yh-j51'])
    addSelectedToSet()
    setWarehouseMemberQuantity('res-yh-j51', 4)
    setWarehouseMemberNote('res-yh-j51', '主石')
    expect(getWarehouseDraftMembers()[0]).toMatchObject({ quantity: 4, note: '主石' })
    setWarehouseMemberQuantity('res-yh-j51', null)
    expect(getWarehouseDraftMembers()[0]?.quantity).toBeUndefined()
    setWarehouseMemberQuantity('res-yh-j51', -2) // 非正拒收
    setWarehouseMemberQuantity('res-yh-j51', 2.5) // 非整数拒收
    expect(getWarehouseDraftMembers()[0]?.quantity).toBeUndefined()
    setWarehouseMemberNote('res-yh-j51', '') // 空串=清除
    expect(getWarehouseDraftMembers()[0]?.note).toBeUndefined()
  })
})

describe('新建组合全链（manual-pick 直发）', () => {
  beforeEach(async () => {
    await initWarehouse()
  })

  it('存为组合：create 调用形态（origin=manual-pick/成员带数量备注）→ 切到新组合+快照冻结', async () => {
    addWarehouseSelection(['res-yh-j51', 'res-fb-j51'])
    addSelectedToSet()
    setWarehouseMemberQuantity('res-yh-j51', 2)
    setWarehouseMemberNote('res-fb-j51', '辅石')
    setWarehouseDraftName('卡通套餐-B')
    expect(isWarehouseDraftDirty()).toBe(true)

    await saveNewWarehouseSet()
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0]).toEqual({
      name: '卡通套餐-B',
      members: [
        { stoneRef: 'res-yh-j51', quantity: 2 },
        { stoneRef: 'res-fb-j51', note: '辅石' },
      ],
      origin: { kind: 'manual-pick' },
    })
    expect(getWarehouseActiveSetId()).toBe('set-created-1')
    expect(getWarehouseDraftName()).toBe('卡通套餐-B')
    expect(getWarehouseSetsList().map((s) => s.resourceId)).toContain('set-created-1')
    expect(isWarehouseDraftDirty()).toBe(false)
  })

  it('空名/空成员守卫（不发请求）', async () => {
    await saveNewWarehouseSet()
    expect(calls.create).toHaveLength(0)
    expect(getWarehouseError()).toContain('组合名不能为空')
    setWarehouseDraftName('名字有了但没成员')
    await saveNewWarehouseSet()
    expect(calls.create).toHaveLength(0)
    expect(getWarehouseError()).toContain('至少一个成员')
  })
})

describe('改既有组合（成员增删/数量/改名——CAS）', () => {
  beforeEach(async () => {
    await initWarehouse()
    await switchWarehouseSet('set-alpha')
  })

  it('切换器装载：sets.get 读时解析（成员/限定名/revision 基线）', () => {
    expect(getWarehouseActiveSetId()).toBe('set-alpha')
    expect(calls.get).toEqual(['set-alpha'])
    const members = getWarehouseDraftMembers()
    expect(members.map((m) => m.stoneRef)).toEqual(['res-yh-j51', 'res-fb-j51'])
    expect(members[0]?.qualifiedSku).toBe('yuhang/J51')
    expect(members[1]?.qualifiedSku).toBe('factoryB/J51')
    expect(isWarehouseDraftDirty()).toBe(false)
  })

  it('保存修改：update 调用形态（baseRevision+字段级 patch）→ 成功后 canonical 重装载', async () => {
    setWarehouseMemberQuantity('res-yh-j51', 6)
    setWarehouseDraftName('套餐-B')
    addWarehouseSelection(['res-fb-b52'])
    addSelectedToSet()
    removeWarehouseMember('res-fb-j51')

    await saveWarehouseChanges()
    expect(calls.update).toHaveLength(1)
    expect(calls.update[0]?.resourceId).toBe('set-alpha')
    expect(calls.update[0]?.baseRevision).toBe(3)
    expect(calls.update[0]?.patch).toEqual({
      name: '套餐-B',
      addMembers: [{ stoneRef: 'res-fb-b52' }],
      removeMembers: ['res-fb-j51'],
      updateMembers: [{ stoneRef: 'res-yh-j51', quantity: 6 }],
    })
    expect(isWarehouseDraftDirty()).toBe(false)
    expect(getWarehouseError()).toBeNull()
  })

  it('无变更不发 update', async () => {
    await saveWarehouseChanges()
    expect(calls.update).toHaveLength(0)
  })

  it('CAS 漂移→提示态（本地草稿保留）；漂移后盲写防线；刷新重载恢复服务端真值', async () => {
    // 模拟他人先保存：同一 fixture store 经 update 面把 revision 3→4。
    await client.sets.update({ resourceId: 'set-alpha', baseRevision: 3, patch: { name: '外部改名' } })
    setWarehouseMemberQuantity('res-yh-j51', 9)

    await saveWarehouseChanges()
    // update 记录=外部 1 次+UI 撞漂移 1 次（fixture 共享调用记录）
    expect(calls.update).toHaveLength(2)
    expect(isWarehouseStaleDrift()).toBe(true)
    // 漂移态：本地编辑保留（用户对照）+盲写防线（再保存不发请求）
    setWarehouseMemberQuantity('res-yh-j51', 10)
    await saveWarehouseChanges()
    expect(calls.update).toHaveLength(2)
    // 刷新重载：sets.get 再拉，草稿复位到服务端真值，漂移态清
    await reloadAfterDrift()
    expect(calls.get).toEqual(['set-alpha', 'set-alpha'])
    expect(isWarehouseStaleDrift()).toBe(false)
    expect(getWarehouseDraftName()).toBe('外部改名')
    expect(getWarehouseDraftMembers()[0]?.quantity).toBe(2)
    expect(isWarehouseDraftDirty()).toBe(false)
  })
})

describe('软删组合+回收站占位', () => {
  beforeEach(async () => {
    await initWarehouse()
    await switchWarehouseSet('set-alpha')
  })

  it('软删 → sets.delete 调用+列表刷新+回落新建草稿；软删组合只读装载', async () => {
    await softDeleteActiveWarehouseSet()
    expect(calls.delete).toEqual(['set-alpha'])
    expect(getWarehouseActiveSetId()).toBeNull()
    expect(getWarehouseSetsList().find((s) => s.resourceId === 'set-alpha')?.trashed).toBe(true)
    await switchWarehouseSet('set-alpha')
    expect(isWarehouseActiveSetTrashed()).toBe(true)
    expect(getWarehouseDraftMembers()).toHaveLength(2)
  })
})
