/*
 * [Owner 细节批 2026-10-01] 消息级时间戳 + copy 工具条 + 应用内 Lightbox。
 * T1: projectFrames ts 透传（user/assistant 消息级；tool 行不带）+ formatMessageTime
 *     口径（当天 HH:mm / 距现在 >24h 判跨天 M-D HH:mm）。
 * T2: TranscriptView assistant 工具条 [时间戳][copy 钮]（无 ts 不显时间戳）。
 * T3: UserBubble 工具条（copy 打勾 1.5s 反馈 / 时间戳 props / 无内容不占位）+
 *     6 行折叠阈值（max-h-[114px]=6×19px）。
 * T4: Lightbox 渲染/切图（箭头+键盘）/缩放（±按钮/滚轮/双击复位/0.25–4x 夹取）/
 *     关闭（X/Esc/背景点击——图片点击不关）+ UserBubble chip 开图（纯图消息同效）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Component } from 'svelte'
import Lightbox from '$lib/components/agent/Lightbox.svelte'
import TranscriptView from '$lib/components/agent/TranscriptView.svelte'
import UserBubble from '$lib/components/agent/UserBubble.svelte'
import { formatMessageTime, pendingQueueItems, projectFrames, type TranscriptItem } from '$lib/agentApi/transcript.svelte'
import type { AttachmentMeta } from '$lib/agentApi/attachments'
import type { Frame } from '@handicraft/contracts'

// jsdom 未实现 scrollIntoView（TranscriptView 贴底跟随）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
// jsdom PointerEvent/setPointerCapture 缺口（Lightbox 拖拽平移挂载期使用）。
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = vi.fn()
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = vi.fn()
}

// ---------------------------------------------------------------- 助手

const mountedDisposers: Array<() => void> = []

function mountTracked<P extends Record<string, unknown>>(component: Component<P>, props: P): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(component, { target, props })
  mountedDisposers.push(() => {
    unmount(view)
    target.remove()
  })
}

function q(selector: string): HTMLElement | null {
  return document.querySelector(selector)
}

function textOf(selector: string): string {
  return q(selector)?.textContent?.trim() ?? ''
}

function attachmentMeta(ref: string, name = `${ref}.png`): AttachmentMeta {
  return { blobRef: ref, name, mime: 'image/png', width: 800, height: 600 }
}

const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime()

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()?.()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------- T1 投影透传

describe('T1 transcript ts 透传（projectFrames/formatMessageTime）', () => {
  it('user/assistant 帧时间戳随条目透传；tool 行不带 ts', () => {
    const frames: Frame[] = [
      { seq: 1, ts: 1000, kind: 'transcript', payload: { role: 'user', text: '排钻' } },
      { seq: 2, ts: 2000, kind: 'transcript', payload: { role: 'assistant', text: '开始' } },
      { seq: 3, ts: 3000, kind: 'transcript', payload: { role: 'tool', text: '工具输出' } },
    ]
    const items = projectFrames([{ taskId: 't1', frames }])
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ kind: 'user', ts: 1000 })
    expect(items[1]).toMatchObject({ kind: 'assistant', ts: 2000 })
    expect(items[2]).toMatchObject({ kind: 'tool' })
    // tool 行不携带 ts（Owner 只要消息级——reasoning/tool 不加）。
    expect('ts' in items[2]).toBe(false)
  })

  it('队列待发条目（pendingQueueItems）不带 ts——消费后由真实 user 帧接管补', () => {
    const queued = pendingQueueItems([{ id: 'q1', text: '排队消息', mode: 'queue' }], 10)
    expect(queued).toHaveLength(1)
    expect('ts' in queued[0]).toBe(false)
  })

  it('formatMessageTime：当天 HH:mm；距现在 >24h 判跨天 M-D HH:mm', () => {
    // 同日 3 小时前 → HH:mm。
    expect(formatMessageTime(new Date(2026, 9, 1, 9, 5, 0).getTime(), NOW)).toBe('09:05')
    // 恰 23 小时前（未过 24h 线）→ 仍当天口径。
    expect(formatMessageTime(NOW - 23 * 60 * 60 * 1000, NOW)).toBe('13:00')
    // 昨日（>24h）→ M-D HH:mm（月/日不补零）。
    expect(formatMessageTime(new Date(2026, 8, 29, 8, 30, 0).getTime(), NOW)).toBe('9-29 08:30')
    // 未来方向同理按距离判（>24h 即跨天口径）。
    expect(formatMessageTime(new Date(2026, 9, 3, 10, 0, 0).getTime(), NOW)).toBe('10-3 10:00')
  })
})

// ---------------------------------------------------------------- T2/T3 消息工具条

describe('T2 assistant 工具条时间戳（TranscriptView）', () => {
  it('assistant/user 消息工具条各显时间戳；无 ts 的 assistant 不显', async () => {
    const items: TranscriptItem[] = [
      { kind: 'user', seq: 1, text: '在吗', ts: new Date(2026, 9, 1, 9, 5, 0).getTime() },
      { kind: 'assistant', seq: 2, text: '在的', streaming: false, ts: new Date(2026, 8, 29, 8, 30, 0).getTime() },
      { kind: 'assistant', seq: 3, text: '无时间戳的历史条目', streaming: false },
    ]
    mountTracked(TranscriptView, { items })
    await tick()

    // user 侧：UserBubble 工具条时间戳（当天口径）。
    expect(textOf('[data-testid="user-msg-time"]')).toBe('09:05')
    // assistant 侧：时间戳在 copy 钮前（工具条首子节点）；跨天（>24h）口径。
    const times = [...document.querySelectorAll('[data-testid="assistant-msg-time"]')]
    expect(times).toHaveLength(1)
    expect(times[0]!.textContent?.trim()).toBe('9-29 08:30')
    const toolbar = times[0]!.closest('[role="toolbar"]')
    expect(toolbar?.firstElementChild?.getAttribute('data-testid')).toBe('assistant-msg-time')
    // 无 ts 条目：不渲染时间戳位（copy 钮仍在）；user 侧 copy 钮独立 testid。
    const copyButtons = [...document.querySelectorAll('[data-testid="assistant-msg-copy"]')]
    expect(copyButtons).toHaveLength(2)
  })
})

describe('T3 UserBubble 工具条与 6 行折叠阈值', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  it('copy 钮复制文本 + 打勾 1.5s 反馈复位', async () => {
    vi.useFakeTimers()
    try {
      mountTracked(UserBubble, { text: '复制我', ts: NOW })
      await tick()
      const copyBtn = q('[data-testid="user-msg-copy"]')
      expect(copyBtn).not.toBeNull()
      copyBtn!.click()
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('复制我'))
      await tick()
      // 打勾反馈：check 图标挂 text-primary（copy 图标无）。
      expect(copyBtn!.querySelector('svg.text-primary')).not.toBeNull()
      // 1.5s 后复位回 copy 图标。
      vi.advanceTimersByTime(1600)
      await tick()
      expect(copyBtn!.querySelector('svg.text-primary')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('时间戳右对齐工具条；无 ts 不显时间戳；纯图消息（空文本+ts）只显时间戳', async () => {
    mountTracked(UserBubble, { text: '带图', attachments: [attachmentMeta('a1')], ts: new Date(2026, 9, 1, 9, 5, 0).getTime() })
    await tick()
    const toolbar = q('[data-testid="user-msg-toolbar"]')
    expect(toolbar).not.toBeNull()
    expect(toolbar!.className).toContain('justify-end')
    expect(textOf('[data-testid="user-msg-time"]')).toBe('09:05')

    while (mountedDisposers.length > 0) mountedDisposers.pop()?.()
    document.body.innerHTML = ''
    // 无 ts：工具条在场（copy 可用）但无时间戳位。
    mountTracked(UserBubble, { text: '无时间戳' })
    await tick()
    expect(q('[data-testid="user-msg-copy"]')).not.toBeNull()
    expect(q('[data-testid="user-msg-time"]')).toBeNull()

    while (mountedDisposers.length > 0) mountedDisposers.pop()?.()
    document.body.innerHTML = ''
    // 纯图消息（空文本）+ts：只显时间戳、无 copy 钮。
    mountTracked(UserBubble, { text: '  ', attachments: [attachmentMeta('a2')], ts: NOW })
    await tick()
    expect(q('[data-testid="user-msg-copy"]')).toBeNull()
    expect(q('[data-testid="user-msg-time"]')).not.toBeNull()

    while (mountedDisposers.length > 0) mountedDisposers.pop()?.()
    document.body.innerHTML = ''
    // 纯图且无 ts：工具条整行不占位。
    mountTracked(UserBubble, { text: '', attachments: [attachmentMeta('a3')] })
    await tick()
    expect(q('[data-testid="user-msg-toolbar"]')).toBeNull()
  })

  it('折叠阈值 6 行（max-h-[114px]=6×19px 行高）；展开态解除上限', async () => {
    mountTracked(UserBubble, { text: '第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行' })
    await tick()
    const bubble = q('.bubble-user')
    expect(bubble).not.toBeNull()
    expect(bubble!.className).toContain('max-h-[114px]')
    expect(bubble!.className).not.toContain('max-h-[7rem]')
  })
})

// ---------------------------------------------------------------- T4 Lightbox

describe('T4 Lightbox（渲染/切图/缩放/关闭）', () => {
  const twoItems = [attachmentMeta('ref-a', '甲图.png'), attachmentMeta('ref-b', '乙图.png')]

  function openLightbox(items = twoItems, index = 0): { closeCalls: () => number } {
    const calls: number[] = []
    mountTracked(Lightbox, { items, index, onclose: () => calls.push(1) })
    return { closeCalls: () => calls.length }
  }

  it('渲染：信息条 名称·当前/总数 + 缩放 100%；双图箭头在场', async () => {
    openLightbox()
    await tick()
    expect(q('[data-testid="lightbox"]')).not.toBeNull()
    expect(textOf('[data-testid="lightbox-info"]')).toContain('甲图.png')
    expect(textOf('[data-testid="lightbox-info"]')).toContain('1/2')
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('100%')
    expect(q('[data-testid="lightbox-prev"]')).not.toBeNull()
    expect(q('[data-testid="lightbox-next"]')).not.toBeNull()
    // 外链保底：新窗口打开原图（assetRawUrl 带 raw 路径）。
    expect(q('[data-testid="lightbox-open-external"]')?.getAttribute('href')).toContain('/api/assets/ref-a/raw')
    expect(q('[data-testid="lightbox-open-external"]')?.getAttribute('target')).toBe('_blank')
  })

  it('切图：next/prev 按钮与键盘 ←/→ 循环；切图重置缩放', async () => {
    openLightbox()
    await tick()
    q('[data-testid="lightbox-next"]')!.click()
    await tick()
    expect(textOf('[data-testid="lightbox-info"]')).toContain('2/2')
    expect(textOf('[data-testid="lightbox-info"]')).toContain('乙图.png')

    // 缩放后切图：视图复位（缩放标签回 100%）。
    q('[data-testid="lightbox-zoom-in"]')!.click()
    await tick()
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('125%')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await tick()
    // 2→1（循环回第一张）。
    expect(textOf('[data-testid="lightbox-info"]')).toContain('1/2')
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('100%')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await tick()
    expect(textOf('[data-testid="lightbox-info"]')).toContain('2/2')
  })

  it('缩放：±按钮 1.25 档、滚轮 1.1 档、双击复位、0.25–4x 夹取', async () => {
    openLightbox()
    await tick()
    const image = q('[data-testid="lightbox-image"]')!

    q('[data-testid="lightbox-zoom-in"]')!.click()
    await tick()
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('125%')

    // 滚轮放大（deltaY<0）→ 125×1.1=137.5%（事件经 img 冒泡到 stage 按钮）。
    image.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    await tick()
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('138%')

    // 双击复位 1x。
    image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await tick()
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('100%')

    // 连续缩小夹取下限 25%（100/1.25^8 → 夹 25%）。
    for (let i = 0; i < 10; i += 1) q('[data-testid="lightbox-zoom-out"]')!.click()
    await tick()
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('25%')

    // 连续放大夹取上限 400%。
    for (let i = 0; i < 30; i += 1) q('[data-testid="lightbox-zoom-in"]')!.click()
    await tick()
    expect(textOf('[data-testid="lightbox-zoom-label"]')).toBe('400%')
  })

  it('平移：pointer 拖拽位移写进 transform（中心缩放简化——平移不改缩放）', async () => {
    openLightbox()
    await tick()
    const image = q('[data-testid="lightbox-image"]')!
    image.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }))
    image.dispatchEvent(new PointerEvent('pointermove', { clientX: 160, clientY: 130, bubbles: true }))
    await tick()
    expect(image.getAttribute('style')).toContain('translate(60px, 30px)')
    image.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await tick()
    expect(image.getAttribute('style')).toContain('translate(60px, 30px)')
  })

  it('关闭：X 钮/Esc/背景点击关；点击图片本体不关（拖拽冲突）；单图隐藏箭头', async () => {
    const { closeCalls } = openLightbox()
    await tick()

    // 点击图片本体：不关。
    q('[data-testid="lightbox-image"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(closeCalls()).toBe(0)

    // X 钮。
    q('[data-testid="lightbox-close"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(closeCalls()).toBe(1)

    // Esc。
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await tick()
    expect(closeCalls()).toBe(2)

    // 背景点击（根元素直接触发——舞台层 pointer-events 穿透语义的 jsdom 等价）。
    q('[data-testid="lightbox"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(closeCalls()).toBe(3)

    // 单图：箭头隐藏。
    while (mountedDisposers.length > 0) mountedDisposers.pop()?.()
    document.body.innerHTML = ''
    openLightbox([attachmentMeta('ref-only', '唯一.png')], 0)
    await tick()
    expect(q('[data-testid="lightbox-prev"]')).toBeNull()
    expect(q('[data-testid="lightbox-next"]')).toBeNull()
    expect(textOf('[data-testid="lightbox-info"]')).toContain('1/1')
  })
})

describe('T4 UserBubble chip → Lightbox 接线', () => {
  it('点击 chip 开 Lightbox（起始位=点击项）；纯图消息同样生效；关闭复位', async () => {
    mountTracked(UserBubble, {
      text: '帮这两张排钻',
      attachments: [attachmentMeta('ref-a', '甲图.png'), attachmentMeta('ref-b', '乙图.png')],
    })
    await tick()
    expect(q('[data-testid="lightbox"]')).toBeNull()

    // chip 不再是外链（无 href/target——应用内看图）。
    const chip = q('[data-testid="user-attachment-chip"]')!
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('href')).toBeNull()

    // 点第二枚 chip：起始位=index 1。
    ;([...document.querySelectorAll('[data-testid="user-attachment-chip"]')][1] as HTMLElement).click()
    await tick()
    expect(q('[data-testid="lightbox"]')).not.toBeNull()
    expect(textOf('[data-testid="lightbox-info"]')).toContain('2/2')
    expect(textOf('[data-testid="lightbox-info"]')).toContain('乙图.png')

    // 关闭复位。
    q('[data-testid="lightbox-close"]')!.click()
    await tick()
    expect(q('[data-testid="lightbox"]')).toBeNull()

    // 纯图消息（空文本）：chip 行独立在场，点击同样开 Lightbox。
    while (mountedDisposers.length > 0) mountedDisposers.pop()?.()
    document.body.innerHTML = ''
    mountTracked(UserBubble, { text: '   ', attachments: [attachmentMeta('ref-pure', '纯图.png')] })
    await tick()
    q('[data-testid="user-attachment-chip"]')!.click()
    await tick()
    expect(q('[data-testid="lightbox"]')).not.toBeNull()
    expect(textOf('[data-testid="lightbox-info"]')).toContain('纯图.png')
  })
})
