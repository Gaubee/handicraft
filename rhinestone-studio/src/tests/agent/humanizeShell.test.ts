/*
 * [w17-critic T1 人话翻译壳] 回归：
 *   [1] 工具名映射（mcp__studio__* 前缀剥离+中文名；未知保原名）。
 *   [2] 工具帧文本解析（daemon sessions.ts 压扁的调用/结果文本 → 结构化工具行）。
 *   [3] 用户帧系统注记剥离（taskId 绑定/图片映射移出正文——气泡角落图标承载）。
 * 投影面（projectFrames）+ 组件面（AgentToolRow/UserBubble 挂载断言）双层。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Frame } from '@handicraft/contracts'
import { projectFrames } from '$lib/agentApi/transcript.svelte'
import {
  parseToolCallText,
  parseToolResultText,
  stripMcpPrefix,
  toolDisplayName,
} from '$lib/agentApi/toolNames'
import { extractUserAnnotations } from '$lib/agentApi/userAnnotations'
import AgentToolRow from '$lib/components/agent/AgentToolRow.svelte'
import UserBubble from '$lib/components/agent/UserBubble.svelte'
import { disableD2 } from 'markstream-svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

// markstream 可选依赖 D2 未安装——直挂 UserBubble（不经 TranscriptView 的模块级
// 关闭）时每条消息一次未捕获 rejection；装配即显式关闭（同 TranscriptView 语义）。
disableD2()

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const ts = Date.parse('2026-10-01T12:00:00.000Z')
const disposers: Array<() => void> = []

/** markstream 终稿渲染异步——轮询等待正文落定。 */
async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(() => {
  resetToastsForTests()
})

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
  document.body.innerHTML = ''
})

describe('[1] 工具名映射', () => {
  it('stripMcpPrefix：mcp__<server>__<tool> 剥前缀；裸名原样', () => {
    expect(stripMcpPrefix('mcp__studio__studio.scene.analyze')).toBe('studio.scene.analyze')
    expect(stripMcpPrefix('studio.bom')).toBe('studio.bom')
  })

  it('toolDisplayName：常用工具中文名；未映射保原名（不猜译）', () => {
    expect(toolDisplayName('mcp__studio__studio.scene.analyze')).toBe('识图分析')
    expect(toolDisplayName('mcp__studio__studio.strategy.design')).toBe('策略设计')
    expect(toolDisplayName('studio.task.exports.list')).toBe('查看导出清单')
    expect(toolDisplayName('mcp__studio__studio.fancy.new.tool')).toBe('studio.fancy.new.tool')
  })
})

describe('[2] 工具帧文本解析（daemon 压扁文本 → 结构化）', () => {
  it('parseToolCallText / parseToolResultText', () => {
    expect(parseToolCallText('调用工具 mcp__studio__studio.scene.analyze（参数 {"taskId":"t1"}）')).toEqual({
      name: 'mcp__studio__studio.scene.analyze',
      args: '{"taskId":"t1"}',
    })
    expect(parseToolResultText('工具结果（mcp__studio__stones.list）：共 3 款')).toEqual({
      name: 'mcp__studio__stones.list',
      text: '共 3 款',
    })
    expect(parseToolResultText('其他系统文本')).toBeNull()
  })

  it('projectFrames：调用帧→映射名+参数入展开卡；结果帧→映射名+结果', () => {
    const frames: Frame[] = [
      {
        seq: 1,
        ts,
        kind: 'transcript',
        payload: { role: 'tool', text: '调用工具 mcp__studio__studio.scene.analyze（参数 {"imageBlobRef":"aa"}）' },
      },
      {
        seq: 2,
        ts: ts + 1000,
        kind: 'transcript',
        payload: { role: 'tool', text: '工具结果（mcp__studio__studio.scene.analyze）：图块 18 个' },
      },
    ]
    const items = projectFrames([{ taskId: 't1', frames }])
    expect(items[0]).toMatchObject({
      kind: 'tool',
      toolName: '识图分析',
      rawToolName: 'mcp__studio__studio.scene.analyze',
      argsText: '{"imageBlobRef":"aa"}',
    })
    expect(items[1]).toMatchObject({ kind: 'tool', toolName: '识图分析', result: '图块 18 个' })
  })

  it('AgentToolRow：行面显中文名，data-raw-tool/title 承载原始名', () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const row = mount(AgentToolRow, {
      target,
      props: {
        toolName: '识图分析',
        rawToolName: 'mcp__studio__studio.scene.analyze',
        argsText: '',
        result: '完成',
      },
    })
    disposers.push(() => {
      unmount(row)
      target.remove()
    })
    const el = target.querySelector('[data-testid="agent-tool-row"]')!
    expect(el.getAttribute('data-raw-tool')).toBe('mcp__studio__studio.scene.analyze')
    expect(el.textContent).toContain('识图分析')
    expect(el.textContent).not.toContain('mcp__studio__')
  })
})

describe('[3] 用户帧系统注记剥离', () => {
  it('extractUserAnnotations：尾部注记块剥离+taskId 解析；用户正文保留', () => {
    const annotated =
      '帮我把爱心排满红钻\n\n[任务绑定 taskId=tsk-abc123——调用 studio.* 工具时 taskId 参数一律用这个值]\n[本消息附带 2 张图片（图像内容已随消息发送）；主图集 imageId→blobRef 映射按输入顺序：img-1=aaaa…、img-2=bbbb…——映射可随时经 studio.task.images.list 查询]'
    const parsed = extractUserAnnotations(annotated)
    expect(parsed.body).toBe('帮我把爱心排满红钻')
    expect(parsed.taskId).toBe('tsk-abc123')
    expect(parsed.notes).toHaveLength(2)
    // 无注记消息原样（trim 后）。
    expect(extractUserAnnotations('普通消息').body).toBe('普通消息')
    expect(extractUserAnnotations('普通消息').notes).toEqual([])
  })

  it('projectFrames：用户帧正文干净+note 元数据随条目（气泡角落图标承载）', () => {
    const frames: Frame[] = [
      {
        seq: 1,
        ts,
        kind: 'transcript',
        payload: {
          role: 'user',
          text: '帮我把爱心排满红钻\n\n[任务绑定 taskId=tsk-abc123——调用 studio.* 工具时 taskId 参数一律用这个值]',
        },
      },
    ]
    const items = projectFrames([{ taskId: 't1', frames }])
    expect(items[0]).toMatchObject({ kind: 'user', text: '帮我把爱心排满红钻' })
    if (items[0]!.kind === 'user') {
      expect(items[0]!.note?.taskId).toBe('tsk-abc123')
    }
  })

  it('UserBubble：note 在场→角落图标（title=注记原文）；无 note→零残元素', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const bubble = mount(UserBubble, {
      target,
      props: { text: '帮我把爱心排满红钻', note: { title: '[任务绑定 taskId=tsk-abc123…]', taskId: 'tsk-abc123' } },
    })
    disposers.push(() => {
      unmount(bubble)
      target.remove()
    })
    const note = target.querySelector('[data-testid="user-msg-note"]')
    expect(note).not.toBeNull()
    expect(note?.getAttribute('title')).toContain('tsk-abc123')
    // markstream 终稿渲染异步——等正文落定。
    await waitUntil(() => target.textContent?.includes('帮我把爱心排满红钻') ?? false)
    expect(target.textContent).toContain('帮我把爱心排满红钻')

    const bare = document.createElement('div')
    document.body.appendChild(bare)
    const plain = mount(UserBubble, { target: bare, props: { text: '纯文本' } })
    disposers.push(() => {
      unmount(plain)
      bare.remove()
    })
    expect(bare.querySelector('[data-testid="user-msg-note"]')).toBeNull()
  })
})
