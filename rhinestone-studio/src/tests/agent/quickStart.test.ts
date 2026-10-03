/*
 * [quick-start-panel studio] 新会话快速开始测试（Owner 2026-09-30「像 zhumo 一样
 * 开箱即用的提示词+便捷图片输入（支持拖拽放入）」）。
 * 覆盖：①新会话空态预设 chips 渲染+点选填充输入框（不自动发送、填充后仍可编辑）；
 * ②非空会话面板/拖放区退场（任务行在场=已过首条）；③mock 演示模式预设仍可用
 * （填充与通道无关）、拖放面不激活（无上传链不亮灯）；④空态整面拖放（dragover
 * 高亮「松开添加图片」→drop 收图走 uploadAssetImage 上传链（多文件）→chip 落位，
 * dragleave 复位）+超限文件被既有门拒（同门证明）；⑤composer-dropzone 输入卡
 * 拖放高亮+drop 收图（与点击上传并存）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import { mount, tick, unmount } from 'svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  bindAgentApi,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import type { AgentApi, AgentConnectionState } from '$lib/agentApi/types'
import type { Frame } from '@handicraft/contracts'

// jsdom 缺口桩（同 composerAttachments.test.ts——本文件挂 SessionStream/TranscriptView）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

// ---------------------------------------------------------------- 测试助手

interface FollowupCall {
  sessionId: string
  text: string
  mode?: 'followup' | 'steer'
  attachments?: string[]
}

interface StubOptions {
  /** getSession 返回的任务行（[] = 新会话空态——面板/拖放区可见性锚）。 */
  tasks?: Array<{ taskId: string; status: 'running' | 'done' }>
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function imageFile(name = 'heart.png'): File {
  return new File([PNG_BYTES], name, { type: 'image/png' })
}

/** fake rpc AgentApi（上传链注入面——mode 'rpc' 触发 SessionStream attachable）。 */
function makeRpcStub(options: StubOptions = {}): {
  api: AgentApi
  followupCalls: FollowupCall[]
  uploadedFiles: File[]
} {
  const iso = new Date().toISOString()
  const session = { id: 's-quick', title: '快速开始会话', status: 'active' as const, createdAt: iso, updatedAt: iso }
  const followupCalls: FollowupCall[] = []
  const uploadedFiles: File[] = []
  let followupSeq = 0
  const listeners = new Map<string, Set<(frame: Frame) => void>>()
  let connectionState: AgentConnectionState = 'open'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
  const api: AgentApi = {
  setAutoApprove: async () => ({ ok: true, autoApprove: false }),
    mode: 'rpc',
    connection: () => connectionState,
    onConnectionChange: (listener) => {
      connectionListeners.add(listener)
      listener(connectionState)
      return () => connectionListeners.delete(listener)
    },
    listSessions: async () => ({ sessions: [session] }),
    createSession: async () => ({ sessionId: 's-new', createdAt: iso }),
    getSession: async () => ({
      session,
      tasks: (options.tasks ?? [{ taskId: 't-hist', status: 'done' as const }]).map((task) => ({
        taskId: task.taskId,
        status: task.status,
        lastSeq: 0,
        frameCount: 0,
      })),
    }),
    followup: async (sessionId, text, mode, attachments) => {
      followupSeq += 1
      followupCalls.push({
        sessionId,
        text,
        ...(mode !== undefined ? { mode } : {}),
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      })
      return { taskId: `t-fu-${followupSeq}` }
    },
    uploadAssetImage: async (file) => {
      uploadedFiles.push(file)
      return { blobRef: `blob-${file.name}`, name: file.name, mime: file.type || 'image/png', width: 640, height: 480 }
    },
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
      throw new Error('工件不存在（快速开始桩）')
    },
    taskDetail: async () => {
      throw new Error('任务详情不可用（快速开始桩）')
    },
    layerSplit: async () => {
      throw new Error('拆层不可用（快速开始桩）')
    },
    layerRename: async () => {
      throw new Error('重命名不可用（快速开始桩）')
    },
    layerStrategySet: async () => {
      throw new Error('策略直改不可用（快速开始桩）')
    },
    treeHistory: async () => {
      throw new Error('版本史不可用（快速开始桩）')
    },
    layerMaskPatch: async () => {
      throw new Error('遮罩编辑不可用（快速开始桩）')
    },
    viewStateSet: async () => {
      throw new Error('视图态写入不可用（快速开始桩）')
    },
    taskExport: async () => {
      throw new Error('任务导出不可用（快速开始桩）')
    },
    layerReorder: async () => {
      throw new Error('图层重排不可用（快速开始桩）')
    },
    layerDelete: async () => {
      throw new Error('图层删除不可用（快速开始桩）')
    },
    treeRevert: async () => {
      throw new Error('整树回退不可用（快速开始桩）')
    },
    maskEditRetry: async () => {
      throw new Error('编辑重算不可用（快速开始桩）')
    },
    maskEditDiscard: async () => {
      throw new Error('编辑放弃不可用（快速开始桩）')
    },
    subscribeTask: (taskId, _afterSeq, onFrame) => {
      let set = listeners.get(taskId)
      if (!set) {
        set = new Set()
        listeners.set(taskId, set)
      }
      set.add(onFrame)
      return () => {
        set!.delete(onFrame)
      }
    },
  }
  return { api, followupCalls, uploadedFiles }
}

const mountedDisposers: Array<() => void> = []

function mountStream(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SessionStream, { target })
  mountedDisposers.push(() => {
    unmount(component)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function composerInput(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
}

function quickDropzone(): HTMLElement | null {
  return document.querySelector('[data-testid="quick-start-dropzone"]')
}

function presetChips(): HTMLButtonElement[] {
  return [...document.querySelectorAll('[data-testid="quick-start-preset"]')] as HTMLButtonElement[]
}

function attachChips(): HTMLElement[] {
  return [...document.querySelectorAll('[data-testid="composer-attachments"] > span')] as HTMLElement[]
}

/** dragover（Files 面——高亮置位事件）。 */
function dragOver(el: HTMLElement): void {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] }, configurable: true })
  el.dispatchEvent(event)
}

/** dragleave（relatedTarget 缺省=离区——高亮复位）。 */
function dragLeave(el: HTMLElement): void {
  const event = new Event('dragleave', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] }, configurable: true })
  el.dispatchEvent(event)
}

/** drop（DataTransfer.files 收图入口）。 */
function dropFiles(el: HTMLElement, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] }, configurable: true })
  el.dispatchEvent(event)
}

beforeEach(() => {
  sessionStorage.clear()
  resetAgentStoreForTests()
  resetSessionRouteForTests('')
  resetToastsForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// ① 新会话空态：预设 chips + 点选填充
// ---------------------------------------------------------------------------

describe('快速开始：新会话空态预设', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    resetSessionRouteForTests('')
  })

  afterEach(() => {
    resetAgentStoreForTests()
  })

  it('空态渲染 4 档预设 chips（输入区上方）；点选=填充输入框（不自动发送、仍可编辑）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    // 面板与 chips 在场（labels 覆盖贴钻真实工具面）。
    expect(document.querySelector('[data-testid="quick-start-presets"]')).not.toBeNull()
    const labels = presetChips().map((chip) => chip.textContent?.trim())
    expect(labels).toEqual(['识图排钻（推荐）', '样卡复刻', '多图批量', '精细修钻'])

    // 点选「识图排钻（推荐）」→ 填充输入框，不自动发送。
    presetChips()[0]!.click()
    await flush()
    expect(composerInput().value).toBe(
      '请分析这张图片，识别主体轮廓并规划贴钻排布：给出对象树与策略计划，说明每块区域用的钻型、颜色与密度，然后生成可执行的排钻布局。',
    )
    expect(stub.followupCalls).toHaveLength(0)

    // 填充后仍可编辑（自由修改不锁死）。
    const input = composerInput()
    input.value = `${input.value}，边缘再加密一点`
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(composerInput().value).toContain('边缘再加密一点')

    // 新会话 placeholder 提示预设入口（zhumo 同款）。
    expect(composerInput().getAttribute('placeholder')).toContain('点上方预设可快速填充')
  })

  it('非空会话（任务行在场=已过首条）：面板与空态拖放区退场', async () => {
    const stub = makeRpcStub() // 缺省 t-hist done 任务行
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()
    expect(document.querySelector('[data-testid="quick-start-presets"]')).toBeNull()
    expect(quickDropzone()).toBeNull()
    expect(presetChips()).toHaveLength(0)
    // 常规 placeholder 回归（无预设入口提示）。
    expect(composerInput().getAttribute('placeholder')).not.toContain('点上方预设')
  })

  it('mock 演示模式：空会话预设面板仍渲染（填充与通道无关）；拖放面不激活（无上传链不亮灯）', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    resetAgentStoreForTests()
    await initAgentStore()
    // fixture 第二个会话 tasks=[]（首会话有历史任务——面板锚定空会话）。
    await openSession('fixt-session-starry')
    mountStream()
    await flush()

    expect(document.querySelector('[data-testid="quick-start-presets"]')).not.toBeNull()
    presetChips()[1]!.click() // 样卡复刻
    await flush()
    expect(composerInput().value).toBe(
      '请对照我上传的样卡图，复刻它的钻图组合：逐区匹配材料市场中最接近的钻（颜色/尺寸/形状），列出替换差异，并产出排钻布局。',
    )

    // 空态拖放区不激活（mock 无上传链）；composer 卡仍在但不亮灯。
    expect(quickDropzone()).toBeNull()
    const composerZone = document.querySelector('[data-testid="composer-dropzone"]') as HTMLElement | null
    expect(composerZone).not.toBeNull()
    dragOver(composerZone!)
    await flush()
    expect(document.querySelector('[data-testid="composer-drag-overlay"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ④⑤ 拖放收图（空态整面 + 输入卡）→ 同一上传链
// ---------------------------------------------------------------------------

describe('快速开始：拖放图片（上传链接链）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
  })

  afterEach(() => {
    resetAgentStoreForTests()
  })

  it('空态整面：dragover 高亮「松开添加图片」→ dragleave 复位 → drop 多文件走 uploadAssetImage 链+chip 落位', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    const zone = quickDropzone()
    expect(zone).not.toBeNull()

    // dragover 高亮 / dragleave 复位。
    dragOver(zone!)
    await flush()
    const overlay = document.querySelector('[data-testid="quick-start-drag-overlay"]')
    expect(overlay?.textContent).toContain('松开添加图片')
    dragLeave(zone!)
    await flush()
    expect(document.querySelector('[data-testid="quick-start-drag-overlay"]')).toBeNull()

    // drop 多文件 → 上传链逐张调用（uploadAssetImage）→ composer chip 落位。
    dragOver(zone!)
    dropFiles(zone!, [imageFile('a.png'), imageFile('b.png')])
    await flush()
    expect(stub.uploadedFiles.map((f) => f.name)).toEqual(['a.png', 'b.png'])
    expect(attachChips()).toHaveLength(2)
    expect(document.querySelector('[data-testid="quick-start-drag-overlay"]')).toBeNull()
  })

  it('空态拖放同门：超 4MiB 文件被既有门拒（toast+不进上传链）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    dropFiles(quickDropzone()!, [big])
    await flush()
    expect(stub.uploadedFiles).toHaveLength(0)
    expect(attachChips()).toHaveLength(0)
    expect(getToasts().map((t) => t.message).join('\n')).toContain('big.png」超过 4MiB 上限')
  })

  it('composer-dropzone：输入卡拖放高亮+drop 收图（与点击上传并存同门）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    const zone = document.querySelector('[data-testid="composer-dropzone"]') as HTMLElement
    dragOver(zone)
    await flush()
    expect(document.querySelector('[data-testid="composer-drag-overlay"]')?.textContent).toContain('松开添加图片')
    dropFiles(zone, [imageFile('drop.png')])
    await flush()
    expect(stub.uploadedFiles.map((f) => f.name)).toEqual(['drop.png'])
    expect(attachChips()).toHaveLength(1)
    // 填充+拖放可并存：预设文本与附件同场（三正交）。
    presetChips()[2]!.click() // 多图批量
    await flush()
    expect(composerInput().value).toContain('每张独立开一个任务')
    expect(attachChips()).toHaveLength(1)
  })
})
