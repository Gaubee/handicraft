/*
 * [add-backend-platform W3 评审 P2-2] RpcAgentApi 传输层测试。
 * 覆盖：①mutation 输出经 contracts schema 守门（漂移响应在 façade 拒绝——followup
 * 类型漂移 / clear 多余字段 strict 拒绝）；②首连失败不卡 connecting——进入重连状态机
 * （断线可见 + 有界指数退避），恢复后新调用可用；③重连退避有界（连续失败不超过上限）。
 * 传输桩：FakeWebSocket 以 oRPC standard-server-peer 线协议（{i,p:{u,b:{json}}} ↔
 * {i,p:{b:{json}}}）应答——不需要真实 daemon。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcAgentApi } from '$lib/agentApi/rpc'
import { clearStoredToken } from '$lib/daemonToken'
import type { AgentConnectionState } from '$lib/agentApi/types'

/** 每测试注入的服务端行为（url → 结果；缺省路径返回 {}）。 */
let serve: (url: string, input: unknown) => unknown
/** 连接脚本：第 n 次（1 起）连接的行为；缺省 'serve'。 */
let connectScript: (attempt: number) => 'fail' | 'serve'
let connectCount = 0

interface FakeEvent {
  type: string
  data?: string
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly url: string
  readyState = 0
  private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>()

  constructor(url: string) {
    this.url = url
    wsUrls.push(url)
    connectCount += 1
    queueMicrotask(() => {
      if (connectScript(connectCount) === 'fail') {
        this.readyState = 3
        this.dispatch('error')
        this.dispatch('close')
      } else {
        this.readyState = 1
        this.dispatch('open')
      }
    })
  }

  send(data: string): void {
    const message = JSON.parse(data) as { i: number; p: { u: string; b?: { json?: unknown } } }
    const url = message.p.u
    const input = message.p.b?.json
    const result = serve(url, input)
    queueMicrotask(() => {
      this.readyState = 1
      // 错误响应形态（{ __status, body? } → 线协议 {s, b}）——401 自愈等错误面测试
      if (result !== null && typeof result === 'object' && '__status' in result) {
        const rejection = result as { __status: number; body?: unknown }
        this.dispatch('message', JSON.stringify({ i: message.i, p: { s: rejection.__status, b: { json: rejection.body ?? {} } } }))
        return
      }
      this.dispatch('message', JSON.stringify({ i: message.i, p: { b: { json: result } } }))
    })
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close')
  }

  private dispatch(type: string, data?: string): void {
    const event: FakeEvent = { type, data }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const stateLog: AgentConnectionState[] = []
/** 每次连接的 URL（token 代际测试断言用）。 */
const wsUrls: string[] = []

function makeApi(): RpcAgentApi {
  return new RpcAgentApi({
    baseUrl: 'http://127.0.0.1:9',
    resolveToken: async () => 'test-token',
  })
}

beforeEach(() => {
  connectCount = 0
  wsUrls.length = 0
  connectScript = () => 'serve'
  serve = () => ({})
  stateLog.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RpcAgentApi：mutation 输出 schema 守门（P2-2）', () => {
  it('followup 类型漂移（taskId 非字符串）被契约拒绝', async () => {
    serve = (url) => (url === '/session/followup' ? { taskId: 12345 } : {})
    const api = makeApi()
    try {
      await expect(api.followup('s1', '漂移')).rejects.toThrow('session.followup 响应不符合契约')
    } finally {
      api.dispose()
    }
  })

  it('clear 多余字段被 strict 契约拒绝（漂移不穿透 façade）', async () => {
    serve = (url) => (url === '/session/clear' ? { ok: true, status: 'cleared', evil: 'drift' } : {})
    const api = makeApi()
    try {
      await expect(api.clear('s1')).rejects.toThrow('session.clear 响应不符合契约')
      // answer/cancel 守门同路径（call() 单点）——冒烟各一条。
      serve = (url) =>
        url === '/session/answer'
          ? { ok: 'yes' }
          : url === '/session/cancel'
            ? { ok: 1 }
            : {}
      await expect(api.answer('s1', 'r1', true)).rejects.toThrow('session.answer 响应不符合契约')
      await expect(api.cancel({ sessionId: 's1' })).rejects.toThrow('session.cancel 响应不符合契约')
    } finally {
      api.dispose()
    }
  })

  it('契约内响应正常通过（clear 返回清理中状态）', async () => {
    serve = (url) => (url === '/session/clear' ? { ok: true, status: 'clearing' } : {})
    const api = makeApi()
    try {
      await expect(api.clear('s1')).resolves.toEqual({ ok: true, status: 'clearing' })
    } finally {
      api.dispose()
    }
  })

  // [add-workbench-pro 终评收尾轮 P0-1] maskEdit.retry/discard 恢复链：输入透传+
  // 输出契约守门（终评 P0-1 恢复链的传输面）。
  it('maskEditRetry/maskEditDiscard：契约内响应通过+漂移字段被 strict 拒', async () => {
    const seen: Record<string, unknown> = {}
    serve = (url, input) => {
      if (url === '/maskEdit/retry' || url === '/maskEdit/discard') {
        seen[url] = input
      }
      if (url === '/maskEdit/retry') {
        return { edit: { nodeId: 'n-hat', state: 'ready', runCount: 12, incomplete: false, baseVersion: 3, error: null, updatedAt: '2026-09-27T00:00:00.000Z' } }
      }
      if (url === '/maskEdit/discard') return { discarded: true }
      return {}
    }
    const api = makeApi()
    try {
      const retried = await api.maskEditRetry({ taskId: 't1', nodeId: 'n-hat', expectedBaseVersion: 3 })
      expect(retried.edit.state).toBe('ready')
      expect(seen['/maskEdit/retry']).toEqual({ taskId: 't1', nodeId: 'n-hat', expectedBaseVersion: 3 })
      const discarded = await api.maskEditDiscard({ taskId: 't1', nodeId: 'n-hat', expectedBaseVersion: 3 })
      expect(discarded.discarded).toBe(true)
      // 漂移响应（state 非法值）被契约拒——不穿透到 UI
      serve = (url) => (url === '/maskEdit/retry' ? { edit: { nodeId: 'n-hat', state: 'bogus', runCount: 1, incomplete: false, baseVersion: 3, error: null, updatedAt: '2026-09-27T00:00:00.000Z' } } : {})
      await expect(api.maskEditRetry({ taskId: 't1', nodeId: 'n-hat', expectedBaseVersion: 3 })).rejects.toThrow('maskEdit.retry 响应不符合契约')
    } finally {
      api.dispose()
    }
  })

  // [add-agent-three-channel 2.5] followup(mode) 透传：steer 显式携带，缺省不带
  // （线上形状与契约 mode optional 对齐——shufa b6cec8a 同式）。
  it('followup steer 模式透传（仅 steer 显式携带）', async () => {
    const seen: unknown[] = []
    serve = (url, input) => {
      if (url === '/session/followup') {
        seen.push(input)
        return { taskId: 't-steer' }
      }
      return {}
    }
    const api = makeApi()
    try {
      await expect(api.followup('s1', '往红偏', 'steer')).resolves.toEqual({ taskId: 't-steer' })
      await expect(api.followup('s1', '普通发送')).resolves.toEqual({ taskId: 't-steer' })
      expect(seen).toEqual([
        { sessionId: 's1', text: '往红偏', mode: 'steer' },
        { sessionId: 's1', text: '普通发送' },
      ])
    } finally {
      api.dispose()
    }
  })

  // [add-agent-three-channel 2.5] stopTask：tasks.stop 调用 + TaskView 输出守门
  // （漂移拒绝——打断≠终态取消，收口帧经帧流到达）。
  it('stopTask：合法 TaskView 通过；类型漂移被契约拒绝', async () => {
    const iso = new Date().toISOString()
    const view = { taskId: 't1', type: 'agent', status: 'done', createdAt: iso, updatedAt: iso }
    let stopCalled = 0
    serve = (url) => {
      if (url === '/tasks/stop') {
        stopCalled += 1
        return stopCalled === 1 ? view : { taskId: 12345 }
      }
      return {}
    }
    const api = makeApi()
    try {
      await expect(api.stopTask('t1')).resolves.toBeUndefined()
      expect(stopCalled).toBe(1)
      await expect(api.stopTask('t1')).rejects.toThrow('tasks.stop 响应不符合契约')
    } finally {
      api.dispose()
    }
  })
})

describe('RpcAgentApi：首连失败 → 重连状态机（P2-2）', () => {
  it('首连失败不卡 connecting：connecting→closed（断线可见）→有界退避→重试恢复 open', async () => {
    vi.useFakeTimers()
    // 前两次连接失败，第三次起可用。
    connectScript = (attempt) => (attempt <= 2 ? 'fail' : 'serve')
    serve = (url) =>
      url === '/session/list' ? { sessions: [] } : {}
    const api = makeApi()
    // onConnectionChange 订阅即快照当前态（初始 closed）——记录含首帧的完整序列。
    const states: AgentConnectionState[] = [api.connection()]
    api.onConnectionChange((state) => states.push(state))
    try {
      // 首次调用经历第一次失败：调用方收到错误，连接进入重连状态机。
      await expect(api.listSessions()).rejects.toThrow('WS 连接失败')
      expect(api.connection()).toBe('closed') // 断线可见（非 connecting 卡死）
      expect(states).toEqual(['closed', 'closed', 'connecting', 'closed']) // 首项=订阅快照

      // 退避 1（500ms）后第二次尝试仍失败 → 再退避（1000ms）。
      await vi.advanceTimersByTimeAsync(500)
      expect(api.connection()).toBe('closed')
      await vi.advanceTimersByTimeAsync(1000)
      // 第三次连接成功：状态收敛 open。
      await vi.advanceTimersByTimeAsync(1)
      expect(api.connection()).toBe('open')
      expect(states).toEqual([
        'closed',
        'closed',
        'connecting',
        'closed',
        'connecting',
        'closed',
        'connecting',
        'open',
      ])

      // 恢复后新调用可用（真实 RPC 往返）。
      await expect(api.listSessions()).resolves.toEqual({ sessions: [] })
    } finally {
      api.dispose()
    }
  })

  it('连续失败退避有界（封顶 15s）且成功后停止重连', async () => {
    vi.useFakeTimers()
    connectScript = () => 'fail'
    const api = makeApi()
    api.onConnectionChange((state) => stateLog.push(state))
    try {
      await expect(api.listSessions()).rejects.toThrow('WS 连接失败')
      // 快进 12 个 15s 窗口：退避 500→1000→…→15000 封顶，持续重试不断链。
      for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(15_000)
      expect(api.connection()).toBe('closed')
      const attemptsAfterStorm = connectCount
      expect(attemptsAfterStorm).toBeGreaterThan(5)

      // 服务恢复：下一次退避到期后连接成功，open 态不再重连。
      connectScript = () => 'serve'
      await vi.advanceTimersByTimeAsync(15_000)
      expect(api.connection()).toBe('open')
      const settled = connectCount
      await vi.advanceTimersByTimeAsync(30_000)
      expect(connectCount).toBe(settled) // open 态不再重连
    } finally {
      api.dispose()
    }
  })
})

// [add-workbench-pro 2.6 走查遗留] 401 自愈：调用返回 401（token 过期/失效）时
// 自动弃 token → 重新匿名登录一次 → 重连 → 原请求重放（会话中途 token 失效不卡死）。
describe('RpcAgentApi：401 自愈（匿名重登录一次+重放原请求）', () => {
  it('401 → resolveToken 二次调用（新 token）→ 重连重放成功——错误不穿透调用方', async () => {
    let tokenCalls = 0
    const tokens = ['stale-token', 'fresh-token']
    const seenUrls: string[] = []
    let listCalls = 0
    serve = (url) => {
      seenUrls.push(url)
      if (url !== '/session/list') return {}
      listCalls += 1
      return listCalls === 1 ? { __status: 401, body: { message: 'unauthorized' } } : { sessions: [] }
    }
    const api = new RpcAgentApi({
      baseUrl: 'http://127.0.0.1:9',
      resolveToken: async () => tokens[Math.min(tokenCalls++, tokens.length - 1)]!,
    })
    try {
      const out = await api.listSessions()
      expect(out).toEqual({ sessions: [] })
      expect(tokenCalls).toBe(2) // 自愈=重新匿名登录一次
      expect(listCalls).toBe(2) // 原请求重放
      expect(connectCount).toBe(2) // 重连（新 token 新连接）
    } finally {
      api.dispose()
    }
  })

  it('非 401 错误不自愈（500 直接穿透）；401 自愈后仍 401 →第二次错误穿透（只自愈一次）', async () => {
    serve = () => ({ __status: 500, body: {} })
    const api500 = new RpcAgentApi({ baseUrl: 'http://127.0.0.1:9', resolveToken: async () => 't' })
    try {
      await expect(api500.listSessions()).rejects.toThrow()
    } finally {
      api500.dispose()
    }

    let calls = 0
    serve = (url) => (url === '/session/list' ? { __status: 401, body: {} } : {})
    void calls
    let tokenCalls = 0
    const api401 = new RpcAgentApi({
      baseUrl: 'http://127.0.0.1:9',
      resolveToken: async () => `t-${tokenCalls++}`,
    })
    try {
      await expect(api401.listSessions()).rejects.toThrow()
      expect(tokenCalls).toBe(2) // 只重登录一次
    } finally {
      api401.dispose()
    }
  })
})

// [split-admin-portal 1.5] token 代际自检：存储层 token 被登录/登出改写后，
// 旧连接按旧身份运行——下一次调用弃连走重连取新 token（登录 token 优先+匿名兜底）。
describe('RpcAgentApi：token 代际漂移（登录/登出换连接）', () => {
  beforeEach(() => {
    sessionStorage.clear()
    serve = (url) => (url === '/session/list' ? { sessions: [] } : {})
    let anonymousTokenSeq = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.endsWith('/api/auth/anonymous') && (init?.method ?? 'GET') === 'POST') {
          anonymousTokenSeq += 1
          return new Response(JSON.stringify({ token: `anon-tok-${anonymousTokenSeq}` }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`代际测试未预期的 fetch：${url}`)
      }),
    )
  })

  it('匿名兜底取 token → 登录改写存储 → 下一调用弃连换登录 token → 登出清存储 → 再匿名', async () => {
    const api = new RpcAgentApi({ baseUrl: 'http://127.0.0.1:9' }) // 缺省 resolveToken（存储层）
    try {
      // ① 无登录态：匿名兜底取 token（缓存进存储层）
      await api.listSessions()
      expect(connectCount).toBe(1)
      expect(wsUrls[0]).toContain('token=anon-tok-1')

      // ② 登录改写存储 token（会话 store login 行为）→ 代际漂移 → 弃连重连
      sessionStorage.setItem('handicraft.daemon.token', 'admin-tok')
      await api.listSessions()
      expect(connectCount).toBe(2)
      expect(wsUrls[1]).toContain('token=admin-tok')

      // ③ 登出清存储（真实 logout 面=clearStoredToken，登录与匿名键一并清——
      // token 修复后匿名 token 落独立键位）→ 漂移 → 匿名兜底重新取
      clearStoredToken()
      await api.listSessions()
      expect(connectCount).toBe(3)
      expect(wsUrls[2]).toContain('token=anon-tok-2')
    } finally {
      api.dispose()
      sessionStorage.clear()
    }
  })

  it('存储 token 未变 → 同连接复用（不误判漂移重连）', async () => {
    const api = new RpcAgentApi({ baseUrl: 'http://127.0.0.1:9' })
    try {
      await api.listSessions()
      await api.listSessions()
      await api.listSessions()
      expect(connectCount).toBe(1) // 同 token 单连接复用
    } finally {
      api.dispose()
      sessionStorage.clear()
    }
  })
})

// [split-admin-portal 2.6.1/2.6.3] 附件面传输：followup attachments 线载荷
// （无附件不带键——纯文本消息线上形状零漂移）+ uploadAssetImage（4MiB 前置门→
// base64→Image 宽高解码→assets.upload 守门）。
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  private _src = ''
  set src(value: string) {
    this._src = value
    queueMicrotask(() => {
      // 可解码面=data:image/*（嗅探回退 application/octet-stream → 解码失败即拒）。
      if (value.startsWith('data:image/')) {
        this.naturalWidth = 800
        this.naturalHeight = 600
        this.onload?.()
      } else {
        this.onerror?.()
      }
    })
  }
  get src(): string {
    return this._src
  }
}

describe('RpcAgentApi：附件面（followup attachments + uploadAssetImage）', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage)
  })

  it('followup attachments 透传：非空携带 / 空/缺省不带键（线上形状零漂移）', async () => {
    const seen: unknown[] = []
    serve = (url, input) => {
      if (url === '/session/followup') {
        seen.push(input)
        return { taskId: 't-att' }
      }
      return {}
    }
    const api = makeApi()
    try {
      await api.followup('s1', '看这张图', 'followup', ['blob-a', 'blob-b'])
      await api.followup('s1', '纯图消息', undefined, ['blob-a'])
      await api.followup('s1', '普通发送')
      await api.followup('s1', '空数组不带键', undefined, [])
      expect(seen).toEqual([
        { sessionId: 's1', text: '看这张图', attachments: ['blob-a', 'blob-b'] },
        { sessionId: 's1', text: '纯图消息', attachments: ['blob-a'] },
        { sessionId: 's1', text: '普通发送' },
        { sessionId: 's1', text: '空数组不带键' },
      ])
    } finally {
      api.dispose()
    }
  })

  it('uploadAssetImage：file→base64→assets.upload→BlobRef+宽高（mime 缺省嗅探）', async () => {
    let uploadInput: unknown = null
    serve = (url, input) => {
      if (url === '/assets/upload') {
        uploadInput = input
        return { blobRef: 'a' + 'b'.repeat(63), filename: 'heart.png', size: 4 }
      }
      return {}
    }
    const api = makeApi()
    // file.type 缺省（粘贴截图常见）——魔数嗅探兜底 PNG（8 字节完整签名）。
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'heart.png')
    try {
      const meta = await api.uploadAssetImage!(file)
      expect(meta).toEqual({ blobRef: 'a' + 'b'.repeat(63), name: 'heart.png', mime: 'image/png', width: 800, height: 600 })
      const input = uploadInput as { filename: string; dataBase64: string }
      expect(input.filename).toBe('heart.png')
      expect(input.dataBase64).toBe('iVBORw0KGgo=') // PNG 魔数 base64（FileReader 真编码）
    } finally {
      api.dispose()
    }
  })

  it('uploadAssetImage：超 4MiB 前置门（中文错误+不进线传输）', async () => {
    let uploadCalls = 0
    serve = (url) => {
      if (url === '/assets/upload') uploadCalls += 1
      return {}
    }
    const api = makeApi()
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    try {
      await expect(api.uploadAssetImage!(big)).rejects.toThrow('「big.png」超过 4MiB 上限，未上传')
      expect(uploadCalls).toBe(0)
    } finally {
      api.dispose()
    }
  })

  it('uploadAssetImage：解码失败中文错误（不可解码面不进线传输）', async () => {
    let uploadCalls = 0
    serve = (url) => {
      if (url === '/assets/upload') uploadCalls += 1
      return {}
    }
    const api = makeApi()
    const text = new File([new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])], 'note.txt')
    try {
      await expect(api.uploadAssetImage!(text)).rejects.toThrow('图片解码失败')
      expect(uploadCalls).toBe(0)
    } finally {
      api.dispose()
    }
  })

  // [收官终评 P2] 原生 PNG 直传 4096 单边门：直传分支此前只查 4MiB 字节不查像素
  // ——压缩后 <4MiB、单边 >4096 的 PNG 绕过 convertImageToPng 的画布边界；现在
  // 解码宽高后与转换路径同门同文案拒。
  class SizedFakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth: number
    naturalHeight: number
    constructor(width: number, height: number) {
      this.naturalWidth = width
      this.naturalHeight = height
    }
    private _src = ''
    set src(value: string) {
      this._src = value
      queueMicrotask(() => this.onload?.())
    }
    get src(): string {
      return this._src
    }
  }

  const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it('原生 PNG 直传 >4096px（宽超标）：解码宽高后同款单边拒（不进线传输）', async () => {
    let uploadCalls = 0
    serve = (url) => {
      if (url === '/assets/upload') uploadCalls += 1
      return {}
    }
    vi.stubGlobal('Image', SizedFakeImage.bind(null, 5000, 4000))
    const api = makeApi()
    const file = new File([PNG_MAGIC], 'wide.png', { type: 'image/png' })
    try {
      await expect(api.uploadAssetImage!(file)).rejects.toThrow('「wide.png」尺寸 5000×4000 超出 4096px 上限')
      expect(uploadCalls).toBe(0)
    } finally {
      api.dispose()
    }
  })

  it('原生 PNG 直传 4097（单边超 1px）拒：不进线传输', async () => {
    let uploadCalls = 0
    serve = (url) => {
      if (url === '/assets/upload') uploadCalls += 1
      return {}
    }
    vi.stubGlobal('Image', SizedFakeImage.bind(null, 4097, 256))
    const api = makeApi()
    const file = new File([PNG_MAGIC], 'edge-over.png', { type: 'image/png' })
    try {
      await expect(api.uploadAssetImage!(file)).rejects.toThrow('4096px 上限')
      expect(uploadCalls).toBe(0)
    } finally {
      api.dispose()
    }
  })

  it('原生 PNG 直传 4096 边界值（两边恰 4096）过：正常上传+meta 宽高', async () => {
    let uploadCalls = 0
    serve = (url) => {
      if (url === '/assets/upload') {
        uploadCalls += 1
        return { blobRef: '9' + 'a'.repeat(63), filename: 'edge.png', size: 8 }
      }
      return {}
    }
    vi.stubGlobal('Image', SizedFakeImage.bind(null, 4096, 4096))
    const api = makeApi()
    const file = new File([PNG_MAGIC], 'edge.png', { type: 'image/png' })
    try {
      const meta = await api.uploadAssetImage!(file)
      expect(uploadCalls).toBe(1)
      expect(meta).toEqual({ blobRef: '9' + 'a'.repeat(63), name: 'edge.png', mime: 'image/png', width: 4096, height: 4096 })
    } finally {
      api.dispose()
    }
  })
})

// [W5 走查 P0-2] 非 PNG 上传归一：jpeg/webp 经 canvas→toBlob('image/png') 转 PNG
// 再上传（scene/segment/pave 管线全要 PNG）；MIME 魔数嗅探优先（不信 file.type 标签
// ——误标 PNG 的 JPEG 字节同样归一）；>4096px 画布不转换直接拒；4MiB 门按转换后
// 尺寸判。canvas 面：jsdom 无实现——getContext/toBlob 桩注入（断言转换调用+载荷）。
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

class BigFakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 5000
  naturalHeight = 4000
  private _src = ''
  set src(value: string) {
    this._src = value
    queueMicrotask(() => this.onload?.())
  }
  get src(): string {
    return this._src
  }
}

describe('RpcAgentApi：uploadAssetImage 非 PNG 归一（W5 P0-2——canvas 转 PNG）', () => {
  let toBlobCalls: Array<string | undefined>
  let toBlobImpl: (callback: (blob: Blob | null) => void, type?: string) => void

  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage)
    toBlobCalls = []
    toBlobImpl = (callback, type) => {
      toBlobCalls.push(type)
      callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }))
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback: (blob: Blob | null) => void, type?: string) => toBlobImpl(callback, type),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('jpeg→canvas 转 PNG：toBlob 收 image/png、上传载荷 filename 后缀改 .png+转换后字节，meta 携 convertedToPng', async () => {
    let uploadInput: unknown = null
    serve = (url, input) => {
      if (url === '/assets/upload') {
        uploadInput = input
        return { blobRef: 'c' + 'd'.repeat(63), filename: 'photo.png', size: 8 }
      }
      return {}
    }
    const api = makeApi()
    const file = new File([JPEG_MAGIC], 'photo.jpg', { type: 'image/jpeg' })
    try {
      const meta = await api.uploadAssetImage!(file)
      // 转换调用：canvas toBlob('image/png')（EXIF 方向经 img 解码方向自然归一）。
      expect(toBlobCalls).toEqual(['image/png'])
      // 线载荷：文件名后缀改 .png + dataBase64=转换产物（PNG 魔数字节）。
      const input = uploadInput as { filename: string; dataBase64: string }
      expect(input.filename).toBe('photo.png')
      expect(input.dataBase64).toBe('iVBORw0KGgo=')
      // 返回面：PNG 元数据+转换标记（chip「已转 PNG」）+解码宽高。
      expect(meta).toEqual({
        blobRef: 'c' + 'd'.repeat(63),
        name: 'photo.png',
        mime: 'image/png',
        width: 800,
        height: 600,
        convertedToPng: true,
      })
    } finally {
      api.dispose()
    }
  })

  it('误标 PNG 的 JPEG 字节（file.type 标签不可信）：魔数嗅探优先，同样归一转换', async () => {
    let uploadInput: unknown = null
    serve = (url, input) => {
      if (url === '/assets/upload') {
        uploadInput = input
        return { blobRef: 'e' + 'f'.repeat(63), filename: 'shot.png', size: 8 }
      }
      return {}
    }
    const api = makeApi()
    const mislabeled = new File([JPEG_MAGIC], 'shot.png', { type: 'image/png' })
    try {
      const meta = await api.uploadAssetImage!(mislabeled)
      expect(toBlobCalls).toEqual(['image/png'])
      expect((uploadInput as { filename: string }).filename).toBe('shot.png')
      expect(meta.mime).toBe('image/png')
      expect(meta.convertedToPng).toBe(true)
    } finally {
      api.dispose()
    }
  })

  it('超大画布（>4096px）不转换直接拒+提示；不进 toBlob 与线传输', async () => {
    let uploadCalls = 0
    serve = (url) => {
      if (url === '/assets/upload') uploadCalls += 1
      return {}
    }
    vi.stubGlobal('Image', BigFakeImage)
    const api = makeApi()
    const file = new File([JPEG_MAGIC], 'huge.jpg', { type: 'image/jpeg' })
    try {
      await expect(api.uploadAssetImage!(file)).rejects.toThrow('4096px 上限')
      expect(toBlobCalls).toEqual([])
      expect(uploadCalls).toBe(0)
    } finally {
      api.dispose()
    }
  })

  it('转换后超 4MiB：按转换后尺寸拒（中文错误）；不进线传输', async () => {
    let uploadCalls = 0
    serve = (url) => {
      if (url === '/assets/upload') uploadCalls += 1
      return {}
    }
    toBlobImpl = (callback) => {
      toBlobCalls.push('image/png')
      callback(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'image/png' }))
    }
    const api = makeApi()
    const file = new File([JPEG_MAGIC], 'fat.jpg', { type: 'image/jpeg' })
    try {
      await expect(api.uploadAssetImage!(file)).rejects.toThrow('超过 4MiB 上限')
      expect(toBlobCalls).toEqual(['image/png'])
      expect(uploadCalls).toBe(0)
    } finally {
      api.dispose()
    }
  })
})
