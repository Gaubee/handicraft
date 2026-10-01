/*
 * [真链复验 P1-C] ResultCard 下载接线测试（rpc 模式 /r/ 真链接）。
 * 覆盖：①rpc+publicId——三键下载各自击发 anchor href=/r/{publicId}/files/{key}
 * +download 文件名（真字节面 W4 契约端点）；②rpc 无 publicId——toast 如实提示、
 * 零 anchor 击发；③旧桩 toast（「W4 接线后开放」）不再出现；④mock 模式本地
 * fixture 行为不变（blob: href + fixture 文件名）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import ResultCard from '$lib/components/agent/ResultCard.svelte'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import type { AgentApi, AgentConnectionState, AgentResultView } from '$lib/agentApi/types'
import type { Frame, SessionSummary } from '@handicraft/contracts'
import { FIXTURE_BUNDLE_BYTES } from '$lib/agentApi/fixtures'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'

/** rpc 传输模式的最小假 API（ResultCard 只读 getAgentMode/connection——不触网）。 */
function rpcModeApi(): AgentApi {
  const iso = new Date().toISOString()
  const session: SessionSummary = { id: 's-dl', title: '下载接线', status: 'active', createdAt: iso, updatedAt: iso }
  return {
    mode: 'rpc',
    connection: () => 'open' as AgentConnectionState,
    onConnectionChange: (listener: (state: AgentConnectionState) => void) => {
      listener('open')
      return () => undefined
    },
    listSessions: async () => ({ sessions: [session] }),
  } as unknown as AgentApi
}

function mockModeApi(): AgentApi {
  return {
    mode: 'mock',
    connection: () => 'mock' as AgentConnectionState,
    onConnectionChange: () => () => undefined,
    listSessions: async () => ({ sessions: [] }),
  } as unknown as AgentApi
}

interface AnchorCapture {
  clicks: Array<{ href: string; download: string }>
}

/** 捕获未挂载 anchor 的击发（downloadBundle 动态建 anchor.click——spy 原型 click）。 */
function spyAnchorClicks(): AnchorCapture {
  const capture: AnchorCapture = { clicks: [] }
  const original = HTMLAnchorElement.prototype.click
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    capture.clicks.push({ href: this.getAttribute('href') ?? '', download: this.getAttribute('download') ?? '' })
  })
  return capture
}

function resultView(publicId?: string): AgentResultView {
  return {
    resultId: 'res-1',
    taskId: 't-1',
    ...(publicId !== undefined ? { publicId } : {}),
    bundle: { svg: 'sha-svg', bom: 'sha-bom', png: 'sha-png' },
  }
}

function testIds(root: HTMLElement): Record<string, HTMLElement | null> {
  return {
    svg: root.querySelector('[data-testid="result-download-svg"]'),
    bom: root.querySelector('[data-testid="result-download-bom"]'),
    png: root.querySelector('[data-testid="result-download-png"]'),
  }
}

describe('ResultCard 下载接线（真链复验 P1-C）', () => {
  let mounted: ReturnType<typeof mount> | null = null
  let capture: AnchorCapture | null = null

  beforeEach(() => {
    resetToastsForTests()
    resetAgentStoreForTests()
    capture = spyAnchorClicks()
    // vitest jsdom 的 createObjectURL 兼容层对字符串 Blob 抛错——测试内以稳定桩值替代
    // （mock 路径断言的是 href 前缀与文件名，不依赖真实 blob 存储）。
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mounted) {
      unmount(mounted)
      mounted = null
    }
  })

  it('rpc+publicId：三键各自击发 /r/{publicId}/files/{key} 真链接+download 文件名', () => {
    bindAgentApi(rpcModeApi())
    mounted = mount(ResultCard, { target: document.body, props: { result: resultView('pub-abc123') } })
    const buttons = testIds(document.body)
    for (const key of ['svg', 'bom', 'png'] as const) {
      expect(buttons[key], `按钮 ${key} 在场`).toBeTruthy()
      ;(buttons[key] as HTMLElement).click()
    }
    expect(capture!.clicks.map((c) => c.href)).toEqual([
      '/r/pub-abc123/files/svg',
      '/r/pub-abc123/files/bom',
      '/r/pub-abc123/files/png',
    ])
    expect(capture!.clicks.map((c) => c.download)).toEqual(['layout.svg', 'bom.csv', 'render.png'])
    // 旧桩 toast 不再出现（W4 接线后开放的占位文案已移除）。
    expect(getToasts().map((t) => t.message)).toEqual([])
  })

  it('rpc 无 publicId：toast 如实提示，零 anchor 击发', () => {
    bindAgentApi(rpcModeApi())
    mounted = mount(ResultCard, { target: document.body, props: { result: resultView() } })
    const buttons = testIds(document.body)
    ;(buttons.svg as HTMLElement).click()
    expect(capture!.clicks).toEqual([])
    expect(getToasts().map((t) => t.message).join()).toContain('无分享包')
  })

  it('mock 模式：本地 fixture 行为不变（blob: href + fixture 文件名）', () => {
    bindAgentApi(mockModeApi())
    mounted = mount(ResultCard, { target: document.body, props: { result: resultView() } })
    const buttons = testIds(document.body)
    ;(buttons.png as HTMLElement).click()
    expect(capture!.clicks).toHaveLength(1)
    expect(capture!.clicks[0]!.href.startsWith('blob:')).toBe(true)
    expect(capture!.clicks[0]!.download).toBe(FIXTURE_BUNDLE_BYTES.png.name)
  })

  it('rpc 卡面回显 /r/{publicId} 与分享链接按钮在场', () => {
    bindAgentApi(rpcModeApi())
    mounted = mount(ResultCard, { target: document.body, props: { result: resultView('pub-share') } })
    expect(document.body.querySelector('[data-testid="result-card"]')?.textContent).toContain('/r/pub-share')
    expect(document.body.querySelector('[data-testid="result-share"]')).toBeTruthy()
  })
})
