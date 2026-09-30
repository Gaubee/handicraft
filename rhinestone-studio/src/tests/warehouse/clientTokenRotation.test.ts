/*
 * [restructure-materials-story w8-story P2-1] RpcWarehouseSetsClient token 轮换守卫。
 * 走查根因：登录升级后 TOKEN_KEY 变化而缓存 WS 连接仍是匿名身份——服务端按旧
 * owner 收窄，材料市场组合分区误显「暂无组合」。守卫=rpc() 复用前比对 storage
 * token 与建连 token，不一致弃缓存重建；storage 无值（注入 resolveToken 的测试
 * 形态）不触发重建。匿名 token 不落 TOKEN_KEY（防竞态错置登录 token）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcWarehouseSetsClient } from '$lib/warehouse/client'

const TOKEN_KEY = 'handicraft.daemon.token'

/** 最小 WebSocket 形态：构造后异步 open；RPCLink 仅要求 addEventListener/close 等。 */
function fakeSocketFactory(urls: string[]) {
  return (url: string): WebSocket => {
    urls.push(url)
    const listeners: Record<string, Array<() => void>> = {}
    const socket = {
      url,
      addEventListener: (type: string, cb: () => void) => {
        ;(listeners[type] ??= []).push(cb)
        if (type === 'open') queueMicrotask(cb)
      },
      removeEventListener: () => {},
      close: () => listeners.close?.forEach((cb) => cb()),
      send: () => {},
    }
    return socket as unknown as WebSocket
  }
}

describe('RpcWarehouseSetsClient token 轮换守卫（w8-story P2-1）', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('登录 token 轮换→弃匿名缓存重建连接（新 URL 带新 token）', async () => {
    const urls: string[] = []
    const client = new RpcWarehouseSetsClient({
      resolveToken: async () => sessionStorage.getItem(TOKEN_KEY) ?? 'tok-anonymous',
      socketFactory: fakeSocketFactory(urls),
    })
    // 首查：storage 空 → 匿名 token 建连（list 因 fake client 无 sets 抛错——无关断言）
    await client.list().catch(() => {})
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('tok-anonymous')

    // 登录升级：TOKEN_KEY 写入 admin token → 复用守卫应弃缓存重建
    sessionStorage.setItem(TOKEN_KEY, 'tok-admin')
    await client.list().catch(() => {})
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('tok-admin')
  })

  it('token 未变→复用缓存连接（不重建）', async () => {
    const urls: string[] = []
    const client = new RpcWarehouseSetsClient({
      resolveToken: async () => 'tok-admin',
      socketFactory: fakeSocketFactory(urls),
    })
    await client.list().catch(() => {})
    await client.list().catch(() => {})
    expect(urls).toHaveLength(1)
  })
})
