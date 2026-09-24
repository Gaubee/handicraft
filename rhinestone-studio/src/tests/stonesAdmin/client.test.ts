/*
 * RpcStonesClient 传输层守门测试（add-stone-library S3.3——沿 agentApi.rpc.test.ts
 * W3 评审 P2-2 纪律）：三读端点输出经 schemas.ts schema parse——漂移响应在客户端
 * 层拒绝（不穿透 UI）；正常响应解构可用；tree/list/get 三端点线协议 URL 正确。
 * 传输桩：FakeWebSocket 以 oRPC standard-server-peer 线协议应答——不需真实 daemon。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcStonesClient } from '$lib/stonesAdmin/client'
import { makeFullDetail, makeTree } from './fixtures'

let serve: (url: string, input: unknown) => unknown

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly url: string
  readyState = 0
  private readonly listeners = new Map<string, Set<(event: { type: string; data?: string }) => void>>()

  constructor(url: string) {
    this.url = url
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatch('open')
    })
  }

  send(data: string): void {
    const message = JSON.parse(data) as { i: number; p: { u: string; b?: { json?: unknown } } }
    const result = serve(message.p.u, message.p.b?.json)
    queueMicrotask(() => {
      this.dispatch('message', JSON.stringify({ i: message.i, p: { b: { json: result } } }))
    })
  }

  addEventListener(type: string, listener: (event: { type: string; data?: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    this.listeners.set(type, set)
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: { type: string; data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close')
  }

  private dispatch(type: string, data?: string): void {
    const event = { type, data }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const seenUrls: string[] = []
const createdSockets: FakeWebSocket[] = []

function makeClient(): RpcStonesClient {
  return new RpcStonesClient({
    baseUrl: 'http://127.0.0.1:9',
    resolveToken: async () => 'test-token',
    socketFactory: (url) => {
      seenUrls.push(url)
      const socket = new FakeWebSocket(url)
      createdSockets.push(socket)
      return socket as unknown as WebSocket
    },
  })
}

beforeEach(() => {
  serve = () => ({})
  seenUrls.length = 0
  createdSockets.length = 0
})

afterEach(() => {
  sessionStorage.clear()
})

describe('RpcStonesClient 守门（schema parse）', () => {
  it('tree：契约响应解析可用；缺 readScope 的漂移响应拒绝', async () => {
    const client = makeClient()
    serve = (url) => {
      expect(url).toBe('/stones/tree')
      return makeTree({ includeTrashed: false })
    }
    const out = await client.tree()
    expect(out.node?.kind).toBe('dir')
    expect(out.readScope).toBe('shared-library')

    serve = () => ({ rootId: 'dir-standards', node: null })
    await expect(client.tree()).rejects.toThrow('stones.tree 响应不符合契约')
  })

  it('list：cells/分页解析；cell 字段类型漂移（sizeMm 串）拒绝', async () => {
    const client = makeClient()
    serve = (url, input) => {
      expect(url).toBe('/stones/list')
      expect(input).toMatchObject({ page: 1, pageSize: 50, includeTrashed: false })
      return {
        cells: [
          {
            resourceId: 'res-j51', sku: 'J51', supplier: 'yuhang', name: '象牙白 · 2mm', styleName: '象牙白',
            family: '白色系', sizeMm: 2, colorHex: '#FFFFF0', finish: 'glossy',
            textureUrl: '/api/stones/res-j51/texture.png', trashed: false, updatedAt: '2026-09-24T00:00:00.000Z',
          },
        ],
        total: 1, page: 1, pageSize: 50, readScope: 'shared-library',
      }
    }
    const out = await client.list({ page: 1, pageSize: 50, includeTrashed: false })
    expect(out.cells[0]?.sku).toBe('J51')
    expect(out.total).toBe(1)

    serve = () => ({
      cells: [{ resourceId: 'r', sku: 'J51', supplier: 'yuhang', name: 'x', styleName: '', family: '白色系', sizeMm: '2', colorHex: '#FFFFF0', finish: '', textureUrl: '/t', trashed: false, updatedAt: '2026-09-24T00:00:00.000Z' }],
      total: 1, page: 1, pageSize: 50, readScope: 'shared-library',
    })
    await expect(client.list({ page: 1, pageSize: 50, includeTrashed: false })).rejects.toThrow('stones.list 响应不符合契约')
  })

  it('get：全文态/裸态解析；stone.json 漂移（kind 错值）拒绝', async () => {
    const client = makeClient()
    serve = () => makeFullDetail()
    const full = await client.get('res-j51')
    expect(full.state).toBe('resolved')

    serve = () => ({ resourceId: 'res-x', state: 'blob-missing', readScope: 'shared-library' })
    const bare = await client.get('res-x')
    expect(bare.state).toBe('blob-missing')

    const drifted = makeFullDetail() as unknown as { stone: Record<string, unknown> }
    drifted.stone.kind = 'not-a-stone'
    serve = () => drifted
    await expect(client.get('res-j51')).rejects.toThrow('stones.get 响应不符合契约')
  })

  it('连接 URL：token 进查询串（同 /ws/rpc 通道形态）', async () => {
    const client = makeClient()
    serve = () => makeTree({ includeTrashed: false })
    await client.tree()
    expect(seenUrls[0]).toBe('ws://127.0.0.1:9/ws/rpc?token=test-token')
  })

  it('断线后下次调用重建连接（close 即弃客户端）；未断线复用单连接', async () => {
    const client = makeClient()
    serve = (url) => {
      if (url === '/stones/tree') return makeTree({ includeTrashed: false })
      return { cells: [], total: 0, page: 1, pageSize: 50, readScope: 'shared-library' }
    }
    await client.tree()
    await client.list({ page: 1, pageSize: 50, includeTrashed: false })
    expect(seenUrls).toHaveLength(1) // 未断线：两调用复用同一连接
    // 模拟 daemon 断线（现连接 close）→ 下次调用重连
    createdSockets[0]!.close()
    await client.tree()
    expect(seenUrls).toHaveLength(2)
  })
})
