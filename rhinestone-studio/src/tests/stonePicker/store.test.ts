/**
 * 钻表选择器单元面（add-stone-library S5.1/S5.2——store+source 纯逻辑）：
 * - source.ts 纯函数：hexToRgb/sortCellsByNearColor（ΔE 升序+平局稳定序）/groupBy 键解析。
 * - rpcSource 协议判定：nearColor/activeSetId 不出线+客户端 ΔE 回退排序+readScope 守门。
 * - store：三级排板数据流/搜索 q 透传/activeSetId 接口位透传/StonePick 产出契约
 *   （schema parse 守门）/gemshapeRef 富集/引用四态标注/未声明桶客户端过滤/过期响应丢弃。
 */
import { describe, expect, it } from 'vitest'
import { StonePickSchema } from '@handicraft/contracts'
import {
  deltaEOfCell,
  hexToRgb,
  sizeMmFromGroupKey,
  sortCellsByNearColor,
  styleRowFromGroupKey,
} from '$lib/stonePicker/source.js'
import { createRpcStonePickerSource, type RpcTransport } from '$lib/stonePicker/rpcSource.js'
import { StonePickerStore } from '$lib/stonePicker/store.svelte.js'
import { MockStonePickerSource, fixtureCells, makeCell } from './helpers.js'

async function flush(ms = 10): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------- source 纯函数

describe('source 纯函数（S5.2 ΔE 协议位）', () => {
  it('hexToRgb：合法六位；非法输入 null（不猜测）', () => {
    expect(hexToRgb('#FFFFF0')).toEqual([255, 255, 240])
    expect(hexToRgb('#e02020')).toEqual([224, 32, 32])
    expect(hexToRgb('FFFFF0')).toBeNull()
    expect(hexToRgb('#FFF')).toBeNull()
    expect(hexToRgb('#FFFFFG')).toBeNull()
    expect(hexToRgb('')).toBeNull()
  })

  it('sortCellsByNearColor：ΔE 升序；平局 supplier×sku 稳定序；不改入参', () => {
    const cells = [
      makeCell({ resourceId: 'a', sku: 'A60', family: '红色系', colorHex: '#E02020', sizeMm: 3 }),
      makeCell({ resourceId: 'b', sku: 'B51', family: '白色系', colorHex: '#FFFFF0', sizeMm: 4 }),
      makeCell({ resourceId: 'c', sku: 'C51', family: '白色系', colorHex: '#FDFDF2', sizeMm: 5 }),
    ]
    const target = hexToRgb('#FFFFF0')!
    const sorted = sortCellsByNearColor(cells, target)
    // 目标白：最近的在前（同色 b=0），红最远
    expect(sorted.map((c) => c.resourceId)).toEqual(['b', 'c', 'a'])
    expect(deltaEOfCell(target, sorted[0]!)).toBe(0)
    // 入参不动（纯函数）
    expect(cells[0]!.resourceId).toBe('a')
  })

  it('groupBy 键解析：row-51→51；未编行/未声明→null；畸形键→null', () => {
    expect(styleRowFromGroupKey('row-51')).toBe(51)
    expect(styleRowFromGroupKey('未编行')).toBeNull()
    expect(styleRowFromGroupKey('row-x')).toBeNull()
    expect(sizeMmFromGroupKey('2')).toBe(2)
    expect(sizeMmFromGroupKey('未声明')).toBeNull()
    expect(sizeMmFromGroupKey('abc')).toBeNull()
  })
})

// ---------------------------------------------------------------- rpcSource 协议判定

function rpcListResult(cells: ReturnType<typeof fixtureCells>, groupKeys?: string[]): unknown {
  return {
    cells,
    total: cells.length,
    page: 1,
    pageSize: 200,
    readScope: 'shared-library',
    ...(groupKeys !== undefined ? { groupKeys } : {}),
  }
}

describe('rpcSource（nearColor/activeSetId 协议判定——S5.2 最终判定落地）', () => {
  it('nearColor/activeSetId 不出线（RPC 面暂无两参）；nearColor 在场→客户端 ΔE 升序回退', async () => {
    const wire: Array<{ proc: string; input: unknown }> = []
    const transport: RpcTransport = {
      async call(proc, input) {
        wire.push({ proc, input: JSON.parse(JSON.stringify(input)) as unknown })
        // 故意返回未按 ΔE 排序的页（红在前白在后）——适配器须回退排序
        return rpcListResult([...fixtureCells().slice(4), ...fixtureCells().slice(0, 1)])
      },
    }
    const source = createRpcStonePickerSource({ transport })
    const result = await source.list({ page: 1, pageSize: 200, nearColor: [255, 255, 240], activeSetId: 'set-1' })
    // 出线输入剥离两协议位
    expect(wire[0]!.input).not.toHaveProperty('nearColor')
    expect(wire[0]!.input).not.toHaveProperty('activeSetId')
    // 回退排序：目标 #FFFFF0 → 象牙白（ΔE=0）首位，正红末位
    const ids = result.cells.map((c) => c.resourceId)
    expect(ids[0]).toBe('stn-j51')
    expect(ids[ids.length - 1]).toMatch(/stn-(j|a)60/)
  })

  it('readScope 守门：漂移响应拒绝', async () => {
    const transport: RpcTransport = {
      async call() {
        return { cells: [], total: 0, page: 1, pageSize: 200, readScope: 'owner-scoped' }
      },
    }
    const source = createRpcStonePickerSource({ transport })
    await expect(source.list({ page: 1, pageSize: 200 })).rejects.toThrow('stones.list 响应不符合契约')
  })

  it('get：引用态+gemshapeRef 窄投影；textureUrl 绝对化', async () => {
    const transport: RpcTransport = {
      async call(proc) {
        if (proc === 'stones.get') {
          return { resourceId: 'stn-j51', state: 'resolved', stone: { gemshapeRef: 'gem-round-2' } }
        }
        return rpcListResult([])
      },
    }
    const source = createRpcStonePickerSource({ transport, baseUrl: 'http://x.test' })
    await expect(source.get('stn-j51')).resolves.toEqual({ resourceId: 'stn-j51', state: 'resolved', gemshapeRef: 'gem-round-2' })
    expect(source.resolveTextureUrl('/api/stones/id/texture.png')).toBe('http://x.test/api/stones/id/texture.png')
    expect(source.resolveTextureUrl('https://cdn/x.png')).toBe('https://cdn/x.png')
  })
})

// ---------------------------------------------------------------- store 数据流

describe('StonePickerStore（S5.1 排板/搜索/产出契约）', () => {
  it('按色排板三级：family 键→款式行键→尺寸变体子查询（懒加载）', async () => {
    const source = new MockStonePickerSource()
    const store = new StonePickerStore(source)
    await store.refresh()
    expect(store.families).toEqual(['白色系', '红色系'])
    expect(store.selectedFamily).toBe('白色系')
    // 二级：groupBy='style' 子查询（family 过滤）
    expect(store.styleRows.map((r) => r.key)).toEqual(['row-51', 'row-52', '未编行'])
    // 三级：懒展开——展开前无 cells 子查询
    const styleQueries = source.calls.filter((c) => c.styleRow !== undefined)
    expect(styleQueries).toHaveLength(0)
    await store.expandStyleRow(store.styleRows[0]!)
    expect(store.styleRows[0]!.cells.map((c) => c.sku)).toEqual(['A51', 'B51', 'J51'])
    expect(source.calls.at(-1)).toMatchObject({ family: '白色系', styleRow: 51 })
    // 未编行桶：无 styleRow 参数+客户端过滤 styleName===''（§8.1 显式态）
    await store.expandStyleRow(store.styleRows[2]!)
    expect(store.styleRows[2]!.cells.map((c) => c.resourceId)).toEqual(['stn-m01'])
    const last = source.calls.at(-1)!
    expect(last.styleRow).toBeUndefined()
    expect(last.family).toBe('白色系')
  })

  it('按尺寸排板：sizeMm 档键→同径色阵；未声明桶客户端过滤', async () => {
    const source = new MockStonePickerSource()
    const store = new StonePickerStore(source)
    store.setLayout('size')
    await store.refresh()
    expect(store.sizeTiers).toEqual(['2', '3', '4', '未声明'])
    expect(store.selectedTier).toBe('2')
    expect(store.tierCells.map((c) => c.sku).sort()).toEqual(['J51', 'J52', 'J60'])
    store.selectTier('未声明')
    await flush()
    expect(store.tierCells.map((c) => c.resourceId)).toEqual(['stn-m01'])
  })

  it('搜索：q 透传（SKU/色名/十六进制同参）；activeSetId 接口位透传', async () => {
    const source = new MockStonePickerSource()
    const store = new StonePickerStore(source, { searchDebounceMs: 0 })
    store.setQ('#E02020')
    await flush(20)
    const last = source.calls.at(-1)!
    expect(last.q).toBe('#E02020')
    expect(store.families).toEqual(['红色系'])
    store.setActiveSetId('set-cartoon-a')
    await flush(20)
    expect(source.calls.at(-1)!.activeSetId).toBe('set-cartoon-a')
    expect(store.activeSetId).toBe('set-cartoon-a')
  })

  it('选中产出=StonePick 契约（schema parse 守门）；gemshapeRef 异步富集+四态标注', async () => {
    const source = new MockStonePickerSource({
      gets: {
        'stn-j51': { resourceId: 'stn-j51', state: 'resolved', gemshapeRef: 'gem-round-2' },
        'stn-j60': { resourceId: 'stn-j60', state: 'blob-missing' },
      },
    })
    const store = new StonePickerStore(source)
    await store.refresh()
    const cell = fixtureCells()[0]!
    store.selectCell(cell)
    // 即时产出：五结构化引用字段（无贴图数据内嵌）
    expect(() => StonePickSchema.parse(store.selectedPick)).not.toThrow()
    expect(store.selectedPick).toEqual({
      resourceId: 'stn-j51',
      sku: 'J51',
      supplier: 'yuhang',
      sizeMm: 2,
      colorHex: '#FFFFF0',
    })
    await flush()
    // 富集后：gemshapeRef 回填（仍过 schema）
    expect(() => StonePickSchema.parse(store.selectedPick)).not.toThrow()
    expect(store.selectedPick?.gemshapeRef).toBe('gem-round-2')
    expect(store.selectedRefState).toBe('resolved')
    // 四态缺失标注：blob-missing 不阻断产出
    const red = fixtureCells()[4]!
    store.selectCell(red)
    await flush()
    expect(store.selectedRefState).toBe('blob-missing')
    expect(() => StonePickSchema.parse(store.selectedPick)).not.toThrow()
    expect(store.selectedPick?.resourceId).toBe('stn-j60')
  })

  it('ΔE 邻近推荐：nearColor 入查询协议位；非法 hex 显式错误不猜测', async () => {
    const source = new MockStonePickerSource()
    const store = new StonePickerStore(source)
    await store.setNearColorFromHex('#FFFFF0')
    const last = source.calls.at(-1)!
    expect(last.nearColor).toEqual([255, 255, 240])
    expect(store.recommendPhase).toBe('ready')
    // 协议语义：ΔE 升序——象牙白三变体（同 hex ΔE=0 平局→supplier×sku 稳定序）包揽前三，正红殿后
    expect(store.recommendedCells.slice(0, 3).map((c) => c.resourceId).sort()).toEqual(['stn-a51', 'stn-b51', 'stn-j51'])
    expect(['stn-j60', 'stn-a60']).toContain(store.recommendedCells.at(-1)!.resourceId)
    await store.setNearColorFromHex('not-a-hex')
    expect(store.nearColorError).toBe('十六进制色值须形如 #AABBCC')
    expect(source.calls.at(-1)!.nearColor).toEqual([255, 255, 240]) // 非法输入不发查询
  })

  it('空态/错误态：list 抛错→error+message；空库→families 空', async () => {
    const source = new MockStonePickerSource({ cells: [] })
    const store = new StonePickerStore(source)
    await store.refresh()
    expect(store.boardPhase).toBe('ready')
    expect(store.families).toEqual([])

    source.setCells(fixtureCells())
    source.failNextList('daemon 不可达')
    await store.refresh()
    expect(store.boardPhase).toBe('error')
    expect(store.boardError).toBe('daemon 不可达')
    await store.refresh()
    expect(store.boardPhase).toBe('ready')
  })

  it('过期响应丢弃：慢查询结果不覆盖新查询', async () => {
    const source = new MockStonePickerSource()
    const store = new StonePickerStore(source)
    // 预热成功一次
    await store.refresh()
    expect(store.families).toEqual(['白色系', '红色系'])
    // 换库后并发触发两次 refresh：第一次的迟到结果被第二次覆盖序号丢弃
    source.setCells([makeCell({ resourceId: 'stn-z', sku: 'Z9', family: '金色系', colorHex: '#D4AF37' })])
    void store.refresh()
    await store.refresh()
    expect(store.families).toEqual(['金色系'])
  })
})
