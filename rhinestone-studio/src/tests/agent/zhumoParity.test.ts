/*
 * [zhumo 对照清单 2026-09-28] chat 面板抄齐回归（Owner「抄作业」指令）：
 * - T1 AgentToolRow：默认紧凑单行摘要卡（truncate，无展开卡）；点开才渲染
 *   「调用参数：」「结果：」两段（break-all 断长行）；running=禁点扫光「调用中…」。
 * - T2 工件 chip 墙收敛：projectFrames 连续 artifact 段相邻同名去重 + 超 3 枚余量
 *   并成单行「+N 个工件已入工作域」；TaskDetailPanel 头部「导出工件 N」折叠卡。
 * - T3 Composer textarea 自增下限 32px（空态不常驻 5 行高）。
 * - T5/T6 状态 pill 中文化+实心化（会话头「已完成」/列表行第二行最近任务状态）。
 * - T7 done 帧 → turn-end 药丸（时长按帧时间戳差推导）+ done 卡并存（taskId 归属不变）。
 * 组件面走 MockAgentApi 小丑 fixture（=走查「给小丑贴钻」会话）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Component } from 'svelte'
import type { Frame } from '@handicraft/contracts'
import { ARTIFACT_INLINE_MAX, projectFrames } from '$lib/agentApi/transcript.svelte'
import AgentToolRow from '$lib/components/agent/AgentToolRow.svelte'
import ComposerCard from '$lib/components/agent/ComposerCard.svelte'
import AgentView from '$lib/components/agent/AgentView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  bindAgentApi,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/components/studio/taskWorkbench/store.svelte'

// jsdom 未实现 scrollIntoView（转录流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const TS = Date.parse('2026-09-28T08:00:00.000Z')

function artifactFrame(seq: number, name: string, blobRef?: string): Frame {
  return {
    seq,
    ts: TS + seq * 1000,
    kind: 'artifact',
    payload: blobRef !== undefined ? { name, blobRef } : { name },
  }
}

const mountedDisposers: Array<() => void> = []

/** 挂载登记（卸载兜底——断言失败漏卸载的 $effect 不跨测试存活）。 */
function mountTracked<P extends Record<string, unknown>>(component: Component<P>, props: P): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(component, { target, props })
  mountedDisposers.push(() => {
    unmount(view)
    target.remove()
  })
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function qq(selector: string): Element[] {
  return [...document.querySelectorAll(selector)]
}

/** matchMedia 桩（jsdom 未实现；agentDetailLayout 同式）。 */
function stubMatchMedia(initialDesktop: boolean): { restore: () => void } {
  const original = window.matchMedia
  let desktop = initialDesktop
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      get matches() {
        return desktop && query === '(min-width: 768px)'
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
  return {
    restore: () => {
      window.matchMedia = original
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetViewForTests('agent')
  resetToastsForTests()
  resetWorkbenchForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

// ---------------------------------------------------------------- 投影面（纯函数）

describe('T2：工件 chip 墙收敛（projectFrames artifact 连续段）', () => {
  const TASK = 'parity-task'

  it('相邻同名去重：[A,A,B,A] → 3 枚 chip、无汇总行', () => {
    const groups = [{ taskId: TASK, frames: [artifactFrame(1, 'a.svg'), artifactFrame(2, 'a.svg'), artifactFrame(3, 'b.svg'), artifactFrame(4, 'a.svg')] }]
    const items = projectFrames(groups)
    expect(items.filter((item) => item.kind === 'frame')).toHaveLength(3)
    expect(items.some((item) => item.kind === 'status')).toBe(false)
  })

  it('超阈值收敛：去重后 5 枚 → 前 3 枚 chip + 单行「+2 个工件已入工作域」', () => {
    expect(ARTIFACT_INLINE_MAX).toBe(3)
    const groups = [
      {
        taskId: TASK,
        frames: [
          artifactFrame(1, 'strategy-plan.json'),
          artifactFrame(2, 'strategy-plan.json'), // 相邻同名 → 去重
          artifactFrame(3, 'object-tree.json'),
          artifactFrame(4, 'layout.svg'),
          artifactFrame(5, 'bom.json'),
          artifactFrame(6, 'layout.png'),
        ],
      },
    ]
    const items = projectFrames(groups)
    expect(items.filter((item) => item.kind === 'frame')).toHaveLength(3)
    expect(items.find((item) => item.kind === 'status')).toMatchObject({
      kind: 'status',
      text: '+2 个工件已入工作域',
    })
  })

  it('大量同名重复（走查 53 枚 chip 墙形态）→ 单枚 chip', () => {
    const frames = Array.from({ length: 53 }, (_, i) => artifactFrame(i + 1, 'strategy-plan.json'))
    const items = projectFrames([{ taskId: TASK, frames }])
    expect(items.filter((item) => item.kind === 'frame')).toHaveLength(1)
    expect(items.some((item) => item.kind === 'status')).toBe(false)
  })

  it('工件段与其他帧交错：收敛只作用于连续段', () => {
    const userFrame: Frame = { seq: 1, ts: TS, kind: 'transcript', payload: { role: 'user', text: '排钻' } }
    const items = projectFrames([{ taskId: TASK, frames: [userFrame, artifactFrame(2, 'a.svg'), artifactFrame(3, 'a.svg')] }])
    expect(items.map((item) => item.kind)).toEqual(['user', 'frame'])
  })
})

describe('T7：done 帧 → turn-end 药丸 + done 卡并存', () => {
  it('时长按任务首帧与 done 帧时间戳差推导；frame 条目 taskId 归属不变', () => {
    const frames: Frame[] = [
      { seq: 1, ts: TS, kind: 'transcript', payload: { role: 'user', text: '第一轮' } },
      { seq: 2, ts: TS + 4500, kind: 'done', payload: {} },
    ]
    const items = projectFrames([{ taskId: 'task-a', frames }])
    expect(items.map((item) => item.kind)).toEqual(['user', 'turn-end', 'frame'])
    expect(items[1]).toMatchObject({ kind: 'turn-end', elapsedMs: 4500 })
    expect(items[2]).toMatchObject({ kind: 'frame', taskId: 'task-a' })
    // seq 唯一且单调（done 帧投影为两条）
    const seqs = items.map((item) => item.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})

// ---------------------------------------------------------------- 组件面

describe('T1：AgentToolRow 默认紧凑、点开两段', () => {
  it('默认单行摘要卡（truncate）不渲染展开卡；点击后「调用参数：」「结果：」两段 break-all', async () => {
    mountTracked(AgentToolRow, {
      toolName: 'stones.add',
      argsText: '{"sku":"R12-SS06-红","count":120}',
      result: '{"ok":true,"revision":3}',
    })
    const row = q('[data-testid="agent-tool-row"]') as HTMLButtonElement | null
    expect(row).not.toBeNull()
    expect(row!.getAttribute('aria-expanded')).toBe('false')
    expect(q('[data-testid="agent-tool-detail"]')).toBeNull()
    // 单行摘要卡：truncate（结果优先于参数）
    const card = row!.querySelector('.tool-card')
    expect(card?.className).toContain('truncate')
    expect(card?.textContent).toContain('"ok":true')

    row!.click()
    await tick()
    const detail = q('[data-testid="agent-tool-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('调用参数：')
    expect(detail!.textContent).toContain('结果：')
    expect(qq('[data-testid="agent-tool-detail"] span.break-all').length).toBeGreaterThanOrEqual(2)
  })

  it('running：摘要卡扫光「调用中…」、禁点（无展开交互）', async () => {
    mountTracked(AgentToolRow, { toolName: 'pave.run', argsText: '', result: null, running: true })
    const row = q('[data-testid="agent-tool-row"]') as HTMLButtonElement | null
    expect(row).not.toBeNull()
    expect(row!.disabled).toBe(true)
    expect(row!.querySelector('.tool-card')?.className).toContain('sweep')
    expect(row!.textContent).toContain('调用中…')
    // disabled 按钮点击不产生展开卡
    row!.click()
    await tick()
    expect(q('[data-testid="agent-tool-detail"]')).toBeNull()
  })
})

describe('T3：Composer textarea 自增下限', () => {
  it('空态最小高度 32px（jsdom scrollHeight=0 → 取下限；不再常驻 5 行高）', async () => {
    mountTracked(ComposerCard, { onsend: () => {} })
    await tick()
    const textarea = q('[data-testid="agent-composer"]') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    expect(textarea!.style.height).toBe('32px')
  })
})

describe('T2/T5/T6/T7 组件面（小丑 fixture=「给小丑贴钻」会话）', () => {
  let media: { restore: () => void }

  beforeEach(async () => {
    media = stubMatchMedia(true)
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    await openSession('fixt-session-clown')
    // AgentView 无 props——直接挂载（mountTracked 面向带 props 组件）。
    const target = document.createElement('div')
    document.body.appendChild(target)
    const view = mount(AgentView, { target })
    mountedDisposers.push(() => {
      unmount(view)
      target.remove()
    })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

  afterEach(() => {
    media.restore()
  })

  it('T5：会话头状态 pill 中文化——完成任务显「已完成」（无英文 active）', () => {
    const pill = q('[data-testid="agent-task-status"]')
    expect(pill?.textContent).toContain('已完成')
    expect(q('[data-testid="agent-stream"] header')?.textContent).not.toContain('active')
  })

  it('T2：transcript 工件墙收敛——5 枚去重后 3 chip + 「+2 个工件已入工作域」', () => {
    expect(qq('[data-testid="frame-artifact"]')).toHaveLength(3)
    expect(q('[data-testid="agent-stream"]')?.textContent).toContain('+2 个工件已入工作域')
  })

  it('T2：TaskDetailPanel 头部「导出工件」折叠卡——展开后行+[fixture 边界] mock 演示标注（外链退场不越域）', async () => {
    const card = q('[data-testid="task-artifacts-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('导出工件')
    expect(card?.textContent).toContain('5')
    // 默认折叠
    expect(qq('[data-testid="task-artifact-row"]')).toHaveLength(0)
    ;(q('[data-testid="task-artifacts-toggle"]') as HTMLButtonElement).click()
    await tick()
    const rows = qq('[data-testid="task-artifact-row"]')
    expect(rows).toHaveLength(5)
    // [fixture 边界 2026-10-02] mock 模式：虚拟 blobRef 不拼 daemon raw URL
    // （修前 <a href=/api/assets/…> 真打到托管 daemon——404）；行=禁点+演示标注。
    expect(rows[0]!.tagName).toBe('DIV')
    expect(rows[0]!.getAttribute('data-demo')).toBe('true')
    expect(rows[0]!.querySelector('a')).toBeNull()
    expect(rows[0]!.textContent).toContain('演示')
  })

  it('T7：done 帧映射 turn-pill（本轮完成 · 时长）', () => {
    const pills = qq('.turn-pill')
    expect(pills.length).toBeGreaterThanOrEqual(1)
    expect(pills[0]?.textContent).toContain('本轮完成')
    expect(pills[0]?.textContent).toMatch(/· \d+(\.\d+)?s/)
  })

  it('T6：会话列表行双行化——active 行 bg-accent-soft + 第二行最近任务状态；非活跃行「贴钻会话」', () => {
    const items = qq('[data-testid="agent-session-item"]')
    expect(items.length).toBeGreaterThan(1)
    const active = items.find((el) => el.getAttribute('aria-current') === 'true')
    const inactive = items.find((el) => el.getAttribute('aria-current') !== 'true')
    expect(active?.className).toContain('bg-accent-soft')
    expect(active?.textContent).toContain('最近任务 · 已完成')
    expect(inactive?.textContent).toContain('贴钻会话')
  })
})
