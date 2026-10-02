/*
 * [fixture 边界 2026-10-02] fixt-session-heart 越域漏洞测试（Owner 验收反馈：
 * 8317 rpc 环境访问 #/t/fixt-session-heart——任务详情看不到图；产物/资源直接
 * 访问报「stone 不存在」）。边界三面：
 * ①面 2（资源不越域）：mock 模式的贴图/产物图/分享链接一律本地占位 dataUrl
 *   或退场标注——绝不拼 daemon /api|/r/ URL（修前：stoneTextureUrl(assetRawUrl)
 *   同源拼 URL 真打到托管 daemon →「stone 不存在」404）；rpc 模式照旧真字节面。
 * ②面 1（rpc 不锚 fixture）：fixture 残留锚在 rpc 下不可锚定——清锚+列表态；
 *   会话列表零 fixture 混入（列表真源=listSessions）。
 * ③面 3（模式切换残留）：mock→rpc 切换（daemon 从无到有）后，指向 fixture 会话
 *   的 URL 锚立即失效（清锚回 #/）。
 * ResultCard mock 分享退场（虚拟 publicId 不拼 /r/）+下载仍走本地 fixture。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import type { SessionSummary } from '@handicraft/contracts'
import { MockAgentApi } from '$lib/agentApi/mock'
import ResultCard from '$lib/components/agent/ResultCard.svelte'
import {
  agentStoneTextureUrl,
  stoneTextureUrl,
} from '$lib/agentApi/gemSummary.svelte'
import { agentAssetUrl, mockStoneSwatchUrl } from '$lib/agentApi/assetBoundary'
import { assetRawUrl } from '$lib/agentApi/attachments'
import { FIXTURE_BLOB_REFS } from '$lib/agentApi/fixtures'
import {
  bindAgentApi,
  getActiveSessionId,
  getAgentSessions,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import type { AgentApi, AgentResultView, AgentTaskView } from '$lib/agentApi/types'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

function sessionOf(id: string, title: string): SessionSummary {
  const now = new Date().toISOString()
  return { id, title, status: 'active', createdAt: now, updatedAt: now }
}

/** rpc 真实面最小桩（daemon 同源部署形态——fixture 会话不在其列表）。 */
function rpcStub(sessions: SessionSummary[]): AgentApi {
  return {
    mode: 'rpc',
    connection: () => 'open',
    onConnectionChange: () => () => {},
    listSessions: async () => ({ sessions }),
    getSession: async (sessionId: string) => {
      const found = sessions.find((candidate) => candidate.id === sessionId)
      if (!found) throw new Error(`会话不存在：${sessionId}`)
      const tasks: AgentTaskView[] = []
      return { session: found, tasks }
    },
    replay: async () => ({ frames: [], nextSeq: 0 }),
    subscribeTask: () => () => {},
    sessionResult: async () => {
      throw new Error('无结果')
    },
  } as unknown as AgentApi
}

beforeEach(() => {
  resetAgentStoreForTests()
  resetSessionRouteForTests('')
  resetToastsForTests()
})

afterEach(() => {
  document.body.innerHTML = ''
  resetAgentStoreForTests()
  resetSessionRouteForTests('')
  resetToastsForTests()
})

describe('面 2：mock 资源不越域（占位 dataUrl——零 daemon 打点）', () => {
  it('贴图：agentStoneTextureUrl（mock）=hex 色卡 dataUrl——不含 /api/stones（修前=越域「stone 不存在」来源）', () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    const url = agentStoneTextureUrl('stn-j51-red', '#C8102E')
    expect(url.startsWith('data:image/svg+xml')).toBe(true)
    expect(url).not.toContain('/api/')
    expect(url).not.toContain('127.0.0.1:8317')
    // 色卡圆点承载 palette 色值（视觉可辨钻色）；非法 hex 回退中性灰。
    expect(url).toContain(encodeURIComponent('#C8102E'))
    expect(mockStoneSwatchUrl('not-a-hex')).toContain(encodeURIComponent('#a1a1aa'))
  })

  it('产物图：agentAssetUrl（mock）=占位 dataUrl（Lightbox/时间线/气泡/面板 chips 同源）；rpc=daemon raw', () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    expect(agentAssetUrl(FIXTURE_BLOB_REFS.artifactSvg).startsWith('data:image/svg+xml')).toBe(true)
    expect(agentAssetUrl(FIXTURE_BLOB_REFS.artifactPng, 320)).not.toContain('/api/assets/')

    bindAgentApi(rpcStub([]))
    const rpcUrl = agentAssetUrl('deadbeef', 320)
    expect(rpcUrl).toContain('/api/assets/deadbeef/raw')
    expect(rpcUrl).toContain('w=320')
    // rpc 贴图真字节面不变（token 查询参数鉴权同源）。
    expect(agentStoneTextureUrl('stn-j51-red', '#C8102E')).toBe(stoneTextureUrl('stn-j51-red'))
    expect(agentStoneTextureUrl('stn-j51-red', '#C8102E')).toContain('/api/stones/stn-j51-red/texture.png')
  })

  it('纯拼装函数保持 rpc 语义不变（assetRawUrl 原样——回归锚）', () => {
    const url = assetRawUrl(FIXTURE_BLOB_REFS.artifactSvg)
    expect(url).toContain('/api/assets/')
  })

  it('ResultCard（mock）：分享钮退场+「演示结果」标注（虚拟 publicId 不拼 /r/）；rpc=分享在场', () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    const result: AgentResultView = {
      resultId: 'fixt-result-heart',
      taskId: 'fixt-task-heart-1',
      publicId: 'FixtHeart01',
      bundle: { svg: 's', bom: 'b', png: 'p' },
    }
    let mounted = mount(ResultCard, { target: document.body, props: { result } })
    expect(document.body.textContent).not.toContain('/r/FixtHeart01')
    expect(document.querySelector('[data-testid="result-share"]')).toBeNull()
    expect(document.querySelector('[data-testid="result-demo-badge"]')?.textContent).toContain('演示结果')
    unmount(mounted)

    bindAgentApi(rpcStub([]))
    mounted = mount(ResultCard, { target: document.body, props: { result } })
    expect(document.body.textContent).toContain('/r/FixtHeart01')
    expect(document.querySelector('[data-testid="result-share"]')).not.toBeNull()
    unmount(mounted)
  })
})

describe('面 1：rpc 下 fixture 会话不可见不可锚定', () => {
  it('rpc+非空真实列表：fixture 残留锚 → 清锚 #/ + 列表态（不回落渲染任何会话）', async () => {
    resetSessionRouteForTests('#/t/fixt-session-heart')
    bindAgentApi(rpcStub([sessionOf('rpc-s1', '真实会话')]))
    await initAgentStore()
    expect(getActiveSessionId()).toBeNull()
    expect(location.hash).toBe('#/')
    expect(getAgentSessions().some((row) => row.id.startsWith('fixt-'))).toBe(false)
  })

  it('rpc+空列表（daemon 新装）：fixture 锚 → 无会话态+清锚（零 fixture 渲染）', async () => {
    resetSessionRouteForTests('#/t/fixt-session-heart')
    bindAgentApi(rpcStub([]))
    await initAgentStore()
    expect(getActiveSessionId()).toBeNull()
    expect(location.hash).toBe('#/')
    expect(getAgentSessions()).toHaveLength(0)
  })

  it('mock 域自洽不回归：mock 模式下 fixture 会话照常可锚定（演示域合法语义）', async () => {
    resetSessionRouteForTests('#/t/fixt-session-heart')
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    expect(getActiveSessionId()).toBe('fixt-session-heart')
    expect(location.hash).toBe('#/t/fixt-session-heart')
  })
})

describe('面 3：mock→rpc 模式切换残留清锚', () => {
  it('mock 会话在场锚定 → 切 rpc（daemon 从无到有）重初始化：fixture 锚立即失效', async () => {
    // mock 期：heart 会话打开（锚 #/t/fixt-session-heart——用户浏览器真实残留形态）。
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    await openSession('fixt-session-heart')
    expect(location.hash).toBe('#/t/fixt-session-heart')

    // 模式切换=localStorage 键+整页重载（store 全新初始化——hash 保留来向）。
    resetAgentStoreForTests()
    bindAgentApi(rpcStub([sessionOf('rpc-s1', '真实会话')]))
    await initAgentStore()
    expect(getActiveSessionId()).toBeNull()
    expect(location.hash).toBe('#/')
    expect(getAgentSessions().map((row) => row.id)).toEqual(['rpc-s1'])
  })
})
