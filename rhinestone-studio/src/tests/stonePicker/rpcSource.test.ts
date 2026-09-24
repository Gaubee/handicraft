/*
 * rpcSource 组合投影翻译测试（add-stone-library S7.5）：activeSetId 协议位在
 * 出线前翻译为 sets.get（成员集解析）→ stones.list resourceIds 服务端过滤参——
 * RPC 面不认识 activeSetId（协议判定见 source.ts 头注）。传输注入假实现（沿
 * client.test.ts 手法——不依赖 WS/真实 daemon）；nearColor 剥离+客户端排序回退
 * 一并锚定（S5.2 既有语义零回归）。
 */

import { describe, expect, it } from 'vitest'
import { createRpcStonePickerSource, type RpcTransport } from '$lib/stonePicker/rpcSource'
import type { ActiveSetResolution, StoneListQuery } from '$lib/stonePicker/source'

function listResponse(cells: Array<{ resourceId: string; colorHex: string }>): unknown {
  return {
    cells: cells.map((cell) => ({
      resourceId: cell.resourceId,
      sku: `SKU-${cell.resourceId}`,
      supplier: 'yuhang',
      name: `名-${cell.resourceId}`,
      styleName: '',
      family: '白色系',
      sizeMm: 2,
      colorHex: cell.colorHex,
      finish: 'glossy',
      textureUrl: `/api/stones/${cell.resourceId}/texture.png`,
      trashed: false,
      updatedAt: '2026-09-24T00:00:00.000Z',
    })),
    total: cells.length,
    page: 1,
    pageSize: 50,
    readScope: 'shared-library',
  }
}

const SET_GET_RESPONSE = {
  resourceId: 'set-cartoon-a',
  setId: 'set-1',
  revision: 1,
  path: '/stones/production-sets/卡通人物套餐-A',
  trashed: false,
  set: { kind: 'stone-set', formatVersion: 1, id: 'set-1', name: '卡通人物套餐-A', stones: [], origin: { kind: 'manual-pick' }, metadata: {}, createdAt: 't', updatedAt: 't' },
  members: [
    { stoneRef: 'stn-j51', state: 'resolved' },
    { stoneRef: 'stn-a60', state: 'resolved' },
    { stoneRef: 'stn-gone', state: 'not-found' }, // 缺失成员显式态——照常进成员集
  ],
}

describe('rpcSource S7.5 组合投影翻译（activeSetId→resourceIds）', () => {
  it('list：activeSetId 在场→先 sets.get 后 stones.list 携带 resourceIds（成员全集含缺失）；线输入无 activeSetId', async () => {
    const calls: Array<{ proc: string; input: Record<string, unknown> }> = []
    const transport: RpcTransport = {
      async call(proc, input) {
        calls.push({ proc, input: input as Record<string, unknown> })
        if (proc === 'sets.get') return SET_GET_RESPONSE
        return listResponse([{ resourceId: 'stn-j51', colorHex: '#FFFFF0' }])
      },
    }
    const source = createRpcStonePickerSource({ transport })
    const result = await source.list({ page: 1, pageSize: 50, activeSetId: 'set-cartoon-a' })
    expect(calls.map((c) => c.proc)).toEqual(['sets.get', 'stones.list'])
    expect(calls[0]!.input).toEqual({ resourceId: 'set-cartoon-a' })
    expect(calls[1]!.input.resourceIds).toEqual(['stn-j51', 'stn-a60', 'stn-gone'])
    expect(calls[1]!.input.activeSetId).toBeUndefined() // 协议位不出线
    expect(result.cells[0]?.resourceId).toBe('stn-j51')

    // 解析按 setId 缓存：再查同组合零 sets.get。
    await source.list({ page: 1, pageSize: 50, activeSetId: 'set-cartoon-a' })
    expect(calls.filter((c) => c.proc === 'sets.get')).toHaveLength(1)
  })

  it('list：无 activeSetId 不触 sets.get；nearColor 剥离+当前页客户端 ΔE 排序回退', async () => {
    const calls: Array<{ proc: string; input: Record<string, unknown> }> = []
    const transport: RpcTransport = {
      async call(proc, input) {
        calls.push({ proc, input: input as Record<string, unknown> })
        return listResponse([
          { resourceId: 'far', colorHex: '#C8102E' },
          { resourceId: 'near', colorHex: '#FFFFF0' },
        ])
      },
    }
    const source = createRpcStonePickerSource({ transport })
    const query: StoneListQuery = { page: 1, pageSize: 50, nearColor: [255, 255, 240] }
    const result = await source.list(query)
    expect(calls.map((c) => c.proc)).toEqual(['stones.list'])
    expect(calls[0]!.input.nearColor).toBeUndefined()
    expect(result.cells.map((c) => c.resourceId)).toEqual(['near', 'far']) // ΔE 升序
  })

  it('resolveSet：名称+成员集投影；sets.get 漂移响应拒绝', async () => {
    let drift = false
    const transport: RpcTransport = {
      async call(_proc, input) {
        if (drift) return { set: { name: 123 }, members: [] } // name 非串
        expect((input as { resourceId: string }).resourceId).toBe('set-x')
        return SET_GET_RESPONSE
      },
    }
    const source = createRpcStonePickerSource({ transport })
    const resolved: ActiveSetResolution = await source.resolveSet!('set-x')
    expect(resolved).toMatchObject({ setId: 'set-x', name: '卡通人物套餐-A' })
    expect(resolved.memberResourceIds).toHaveLength(3)

    const fresh = createRpcStonePickerSource({ transport })
    drift = true
    await expect(fresh.resolveSet!('set-x')).rejects.toThrow('sets.get 响应不符合契约')
  })
})
