/*
 * [add-backend-platform W3.3 测试分类①②] Agent 优先界面形态（spec 验收 MUST）：
 * ①默认无旗标：进 Agent 主面 + 三工作台（及素材库）导航隐藏 + BYOK 芯片/设置面退场
 *   + API façade 状态（mock 模式/会话加载/连接态）。
 * ②显式开旗标：旧三工作台可访问性冒烟（各 ≥1 条）+ Agent 与旧视图并存导航。
 * UI-only 测试默认照跑（测试内显式开旗标 mount）——不因默认隐藏跳过。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from '../../App.svelte'
import { getView, resetViewForTests, setView } from '$lib/stores/view.svelte'
import { resetDevFlagForTests, setDevWorkbenches } from '$lib/stores/devFlag.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetOpenIntentForTests } from '$lib/stores/openIntent.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import type { AgentApi, AgentConnectionState } from '$lib/agentApi/types'
import {
  bindAgentApi,
  getAgentConnection,
  getAgentMode,
  getAgentSessions,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountApp(): () => void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  const dispose = () => {
    unmount(app)
    target.remove()
  }
  mountedDisposers.push(dispose)
  return dispose
}

function headerTabs(): string[] {
  return [...document.body.querySelectorAll('header [role="tab"]')].map((t) => t.textContent?.trim() ?? '')
}

function mobileNavLabels(): string[] {
  const nav = document.querySelector('nav[aria-label="模块切换"]')
  return nav === null ? [] : [...nav.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '')
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

beforeEach(() => {
  localStorage.clear()
  resetDevFlagForTests(false)
  resetViewForTests()
  resetAgentStoreForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  resetToastsForTests()
  resetOpenIntentForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// ① 默认无旗标
// ---------------------------------------------------------------------------

describe('① 默认无旗标：Agent 主面', () => {
  it('默认落地=Agent 主面；顶栏无旧工作台入口；底部导航=Agent+工作台（critic T3 常驻入口）', async () => {
    const dispose = mountApp()
    await flush()

    expect(getView()).toBe('agent')
    expect(document.querySelector('[data-testid="agent-view"]')).not.toBeNull()
    expect(headerTabs()).toEqual(['Agent', '排钻工作台'])
    // [w17-critic T3] 390px 工作区无入口修复：移动端导航=Agent+工作台（任务详情
    // 工作台路由，非旧开发者工作台）；旧三工作台+素材库仍随旗标。
    expect(mobileNavLabels()).toEqual(['Agent', '工作台'])
    // 旧三工作台+素材库视图不挂载。
    expect(document.querySelector('[data-testid="assets-view"]')).toBeNull()
    expect(document.body.textContent).not.toContain('还没有数字油画')
    dispose()
  })

  it('BYOK 芯片与设置面退场（Agent 主面零浏览器密钥依赖）', async () => {
    const dispose = mountApp()
    await flush()

    expect(document.querySelector('[data-testid="byok-chip"]')).toBeNull()
    expect(document.body.textContent).not.toContain('BYOK 连接设置')
    dispose()
  })

  it('API façade 状态：mock 模式+fixture 会话加载+连接态本地演示', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)

    expect(getAgentMode()).toBe('mock')
    expect(getAgentConnection()).toBe('mock')
    expect(getAgentSessions().length).toBeGreaterThanOrEqual(2)
    // 活跃会话流渲染（fixture 帧+结果卡片——[fixture 边界] mock 分享钮退场+演示标注，
    // 虚拟 publicId 不拼 /r/ daemon URL）。
    expect(document.querySelector('[data-testid="agent-stream"]')).not.toBeNull()
    await waitUntil(() => document.querySelector('[data-testid="result-card"]') !== null)
    expect(document.querySelector('[data-testid="result-share"]')).toBeNull()
    expect(document.querySelector('[data-testid="result-demo-badge"]')?.textContent).toContain('演示结果')
    // 连接态徽标。
    expect(document.querySelector('[data-testid="agent-connection"]')?.textContent).toContain('本地演示')
    expect(document.querySelector('[data-testid="agent-mode"]')?.textContent).toBe('MOCK')
    dispose()
  })

  it('会话交互冒烟：发送→审批卡（批准/拒绝按钮可见）→批准后结果', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)

    const composer = document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
    composer.value = '把红色区域改密一点'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    ;(document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="approval-card"]') !== null)

    const approve = document.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement
    expect(approve).not.toBeNull()
    expect(document.querySelector('[data-testid="approval-reject"]')).not.toBeNull()
    approve.click()
    await waitUntil(() => document.body.textContent?.includes('已批准该修改') ?? false)
    dispose()
  })

  it('rpc 断线可见（W3 评审 P2-2）：closed 态横幅+徽标呈现断线，恢复后消失', async () => {
    // 断线态 rpc 桩：固定一个会话供会话流渲染（断线横幅挂在会话流内）。
    const iso = new Date().toISOString()
    const session = { id: 'rpc-s1', title: '断线会话', status: 'active' as const, createdAt: iso, updatedAt: iso }
    let connectionState: AgentConnectionState = 'open'
    const listeners = new Set<(state: AgentConnectionState) => void>()
    const stub: AgentApi = {
      mode: 'rpc',
      connection: () => connectionState,
      onConnectionChange: (listener) => {
        listeners.add(listener)
        listener(connectionState)
        return () => listeners.delete(listener)
      },
      listSessions: async () => ({ sessions: [session] }),
      createSession: async () => ({ sessionId: 'rpc-s2', createdAt: iso }),
      getSession: async () => ({ session, tasks: [] }),
      followup: async () => ({ taskId: 'rpc-t1' }),
      stopTask: async () => {},
      answer: async () => ({ ok: true }),
      renameSession: async () => {
        throw new Error('本测试不触达')
      },
      cancel: async () => ({ ok: true }),
      clear: async () => ({ ok: true, status: 'cleared' as const }),
      replay: async () => ({ frames: [], nextSeq: 0 }),
      sessionResult: async () => {
        throw new Error('会话暂无已完成结果')
      },
      taskResult: async () => ({ found: false }),
      taskArtifact: async () => {
        throw new Error('工件不存在（断线桩）')
      },
      // [add-task-detail-layer-workbench 2.6] 工作台五面（断线桩不触达——抛错即可）
      taskDetail: async () => {
        throw new Error('任务详情不可用（断线桩）')
      },
      layerSplit: async () => {
        throw new Error('拆层不可用（断线桩）')
      },
      layerRename: async () => {
        throw new Error('重命名不可用（断线桩）')
      },
      layerStrategySet: async () => {
        throw new Error('策略直改不可用（断线桩）')
      },
      treeHistory: async () => {
        throw new Error('版本史不可用（断线桩）')
      },
      // [add-workbench-pro 2b] 工作台三新面（断线桩不触达——抛错即可）
      layerMaskPatch: async () => {
        throw new Error('遮罩编辑不可用（断线桩）')
      },
      viewStateSet: async () => {
        throw new Error('视图态写入不可用（断线桩）')
      },
      taskExport: async () => {
        throw new Error('任务导出不可用（断线桩）')
      },
      // [add-workbench-pro 2c] 图层管理三面（断线桩不触达——抛错即可）
      layerReorder: async () => {
        throw new Error('图层重排不可用（断线桩）')
      },
      layerDelete: async () => {
        throw new Error('图层删除不可用（断线桩）')
      },
      treeRevert: async () => {
        throw new Error('整树回退不可用（断线桩）')
      },
      // [add-workbench-pro 终评收尾轮] 恢复链双面（断线桩不触达——抛错即可）
      maskEditRetry: async () => {
        throw new Error('编辑重算不可用（断线桩）')
      },
      maskEditDiscard: async () => {
        throw new Error('编辑放弃不可用（断线桩）')
      },
      subscribeTask: () => () => {},
    }
    resetAgentStoreForTests()
    bindAgentApi(stub)
    const dispose = mountApp()
    try {
      await waitUntil(() => getAgentSessions().length > 0)
      await flush()

      // 连接正常：无断线横幅，徽标「已连接」。
      expect(getAgentConnection()).toBe('open')
      expect(document.querySelector('[data-testid="agent-disconnected"]')).toBeNull()
      expect(document.querySelector('[data-testid="agent-connection"]')?.textContent).toContain('已连接')

      // 断线（首连失败/掉线进入 closed）：横幅可见 + 徽标「已断开」。
      connectionState = 'closed'
      for (const listener of listeners) listener('closed')
      await tick()
      expect(document.querySelector('[data-testid="agent-disconnected"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="agent-connection"]')?.textContent).toContain('已断开')

      // 恢复：横幅消失。
      connectionState = 'open'
      for (const listener of listeners) listener('open')
      await tick()
      expect(document.querySelector('[data-testid="agent-disconnected"]')).toBeNull()
    } finally {
      resetAgentStoreForTests()
    }
  })
})

// ---------------------------------------------------------------------------
// ② 显式开旗标：旧三工作台可访问性冒烟（各 ≥1 条）
// ---------------------------------------------------------------------------

describe('② 开旗标：旧三工作台冒烟（Agent 并存）', () => {
  beforeEach(() => {
    resetDevFlagForTests(true)
  })

  it('顶栏=Agent+素材库+三工作台；BYOK 芯片回归', async () => {
    const dispose = mountApp()
    await flush()

    expect(headerTabs()).toEqual(['Agent', '排钻工作台', '开发·素材库', '开发·装饰钻库', '仓储管理', '提示词实验室', '策略设计', '设计师工作台'])
    // [w17-critic T3] 工作台常驻第二位（旧「排钻」条目并入——同一路由不再双开）。
    expect(mobileNavLabels()).toEqual(['Agent', '工作台', '素材库', '钻库', '仓储', '实验室', '策略', '设计'])
    expect(document.querySelector('[data-testid="byok-chip"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-view"]')).not.toBeNull()
    dispose()
  })

  it('提示词实验室冒烟：切页可见模板动线', async () => {
    const dispose = mountApp()
    await flush()
    setView('lab')
    await flush()

    expect(getView()).toBe('lab')
    expect(document.body.textContent).toContain('模板')
    dispose()
  })

  it('排钻工作台冒烟：四区骨架挂载', async () => {
    const dispose = mountApp()
    await flush()
    setView('studio')
    await flush()
    // [add-task-detail-layer-workbench 2.4] StudioView 重构为路由：旧面板冒烟经引擎实验入口进引擎面
    document.querySelector<HTMLButtonElement>('[data-testid="studio-mode-engine-enter"]')?.click()
    await flush()

    expect(getView()).toBe('studio')
    expect(document.body.textContent).toContain('还没有数字油画')
    expect(document.querySelector('[data-testid="studio-left-column"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="status-bar"]')).not.toBeNull()
    dispose()
  })

  it('设计师工作台冒烟：空态四入口挂载（bits-ui Tabs 面板常驻——以视图态+空态标记断言）', async () => {
    const dispose = mountApp()
    await flush()
    setView('edit')
    await flush(120)

    expect(getView()).toBe('edit')
    expect(document.body.textContent).toContain('去排钻工作台送精修')
    // 切回 Agent：主面回归。
    setView('agent')
    await flush()
    expect(getView()).toBe('agent')
    dispose()
  })
})
