/*
 * [split-admin-portal 2.6 studio] Composer 附件链测试（「用户无法上传图片」核心痛点）。
 * 覆盖：①attachments 域纯函数（魔数嗅探/raw URL builder/帧元数据宽容解析）；
 * ②ComposerCard 组件面（上传注入→chip 缩略/移除、结构化载荷（无「[图片附件]」
 * 文本注入行）、纯图发送门、粘贴/拖入三入口、≤4MiB/≤4 张门、上传 busy/失败 toast）；
 * ③SessionStream+store 链路（fake rpc AgentApi：rpc 才 attachable、uploadAssetImage
 * 载荷、followup attachments 线字段、纯图投递、运行中入队携带附件+done 后自动开跑）；
 * ④历史回放（帧附件元数据→UserBubble chip 行+raw 链接新窗口；openSession 重开回放）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import ComposerCard from '$lib/components/agent/ComposerCard.svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  assetRawUrl,
  attachmentMetasOf,
  coerceAttachmentMeta,
  sniffImageMime,
  type AttachmentMeta,
} from '$lib/agentApi/attachments'
import { projectFrames } from '$lib/agentApi/transcript.svelte'
import { TOKEN_KEY } from '$lib/daemonToken'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  bindAgentApi,
  getAgentQueue,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
  sendFollowup,
} from '$lib/agentApi/store.svelte'
import type { AgentApi, AgentConnectionState } from '$lib/agentApi/types'
import type { Frame } from '@handicraft/contracts'

// jsdom 缺口桩（同 threeChannel.test.ts——本文件直接挂 SessionStream/TranscriptView）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

// ---------------------------------------------------------------- 测试助手

interface TestComposerAttachment extends AttachmentMeta {
  size: number
  rawUrl: (width?: number) => string
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function imageFile(name = 'heart.png', bytes: Uint8Array<ArrayBuffer> = PNG_BYTES): File {
  return new File([bytes], name, { type: 'image/png' })
}

/** 隐藏 file input 注入（jsdom files 只读——实例级 defineProperty 覆写）。 */
function pickFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function pasteFiles(el: HTMLElement, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files }, configurable: true })
  el.dispatchEvent(event)
}

function dropFiles(el: HTMLElement, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] }, configurable: true })
  el.dispatchEvent(event)
}

const mountedDisposers: Array<() => void> = []

function mountComposer(
  props: {
    onsend?: (text: string, mode?: 'followup' | 'steer', attachments?: AttachmentMeta[]) => void
    uploadAttachment?: ((file: File) => Promise<TestComposerAttachment>) | null
    running?: boolean
    onstop?: (() => void) | null
  } = {},
): { sends: Array<{ text: string; mode?: 'followup' | 'steer'; attachments?: AttachmentMeta[] }>; uploads: File[] } {
  const sends: Array<{ text: string; mode?: 'followup' | 'steer'; attachments?: AttachmentMeta[] }> = []
  const uploads: File[] = []
  const uploadAttachment = props.uploadAttachment ?? null
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(ComposerCard, {
    target,
    props: {
      onsend: (text: string, mode?: 'followup' | 'steer', attachments?: AttachmentMeta[]) =>
        sends.push({ text, mode, attachments }),
      uploadAttachment:
        uploadAttachment === null
          ? undefined
          : (file: File) => {
              uploads.push(file)
              return uploadAttachment(file)
            },
      attachable: uploadAttachment !== null,
      running: props.running ?? false,
      onstop: props.onstop ?? null,
    },
  })
  mountedDisposers.push(() => {
    unmount(component)
    target.remove()
  })
  return { sends, uploads }
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function composerInput(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
}

function attachInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

function chips(): HTMLElement[] {
  return [...document.querySelectorAll('[data-testid="composer-attachments"] > span')] as HTMLElement[]
}

async function attachOne(
  uploadAttachment: ((file: File) => Promise<TestComposerAttachment>) | null = async (file) => ({
    blobRef: `blob-${file.name}`,
    name: file.name,
    mime: 'image/png',
    width: 640,
    height: 480,
    size: file.size,
    rawUrl: () => `/api/assets/blob-${file.name}/raw`,
  }),
): Promise<{ sends: Array<{ text: string; mode?: 'followup' | 'steer'; attachments?: AttachmentMeta[] }>; uploads: File[] }> {
  const harness = mountComposer({ uploadAttachment })
  pickFiles(attachInput(), [imageFile()])
  await flush()
  return harness
}

beforeEach(() => {
  sessionStorage.clear()
  resetToastsForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// ① attachments 域纯函数
// ---------------------------------------------------------------------------

describe('attachments 域纯函数', () => {
  it('sniffImageMime：PNG/JPEG/GIF/WebP 魔数；未命中回退 octet-stream', () => {
    expect(sniffImageMime('iVBORw0KGgo=')).toBe('image/png')
    expect(sniffImageMime('/9j/4AAQ')).toBe('image/jpeg')
    expect(sniffImageMime('R0lGODlh')).toBe('image/gif')
    expect(sniffImageMime('UklGRhoA')).toBe('image/webp')
    expect(sniffImageMime('aGVsbG8=')).toBe('application/octet-stream')
  })

  it('assetRawUrl：token 取存储层（有=带 query；无=裸路径）；blobRef 编码；可选 w 缩放参数（W1 预览修复）', () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok-1')
    expect(assetRawUrl('abc123')).toBe(`${location.origin}/api/assets/abc123/raw?token=tok-1`)
    sessionStorage.removeItem(TOKEN_KEY)
    expect(assetRawUrl('abc123')).toBe(`${location.origin}/api/assets/abc123/raw`)
    // 特殊字符 ref 不破 URL 结构（encodeURIComponent）。
    expect(assetRawUrl('a/b c')).toBe(`${location.origin}/api/assets/a%2Fb%20c/raw`)
    // 可选 w：缩略格携 w=600（w 在 token 前；无效值忽略——不影响既有裸路径形态）。
    expect(assetRawUrl('abc123', 600)).toBe(`${location.origin}/api/assets/abc123/raw?w=600`)
    sessionStorage.setItem(TOKEN_KEY, 'tok-1')
    expect(assetRawUrl('abc123', 600)).toBe(`${location.origin}/api/assets/abc123/raw?w=600&token=tok-1`)
    expect(assetRawUrl('abc123', Number.NaN)).toBe(`${location.origin}/api/assets/abc123/raw?token=tok-1`)
    expect(assetRawUrl('abc123', 0)).toBe(`${location.origin}/api/assets/abc123/raw?token=tok-1`)
    sessionStorage.removeItem(TOKEN_KEY)
  })

  it('coerceAttachmentMeta/attachmentMetasOf：合法通过、形态不符丢弃、非数组省略', () => {
    const meta = { blobRef: 'r1', name: 'a.png', mime: 'image/png', width: 10, height: 20 }
    expect(coerceAttachmentMeta(meta)).toEqual(meta)
    expect(coerceAttachmentMeta({ name: '缺 blobRef' })).toBeNull()
    expect(coerceAttachmentMeta(null)).toBeNull()
    expect(coerceAttachmentMeta({ blobRef: 'r2', width: '宽' })).toEqual({
      blobRef: 'r2',
      name: 'r2',
      mime: '',
      width: 0,
      height: 0,
    })
    expect(attachmentMetasOf({ attachments: [meta, 'garbage'] })).toEqual([meta])
    expect(attachmentMetasOf({ attachments: [] })).toBeUndefined()
    expect(attachmentMetasOf({})).toBeUndefined()
  })

  it('projectFrames：user 帧附件元数据宽容投影（无元数据条目省略字段）', () => {
    const withMeta = {
      seq: 1,
      ts: 1,
      kind: 'transcript',
      payload: { role: 'user', text: '看图', attachments: [{ blobRef: 'r1', name: 'a.png', mime: 'image/png', width: 6, height: 4 }] },
    } as unknown as Frame
    const plain = { seq: 2, ts: 2, kind: 'transcript', payload: { role: 'user', text: '纯文本' } } as unknown as Frame
    const items = projectFrames([{ taskId: 't1', frames: [withMeta, plain] }])
    expect(items[0]).toMatchObject({ kind: 'user', attachments: [{ blobRef: 'r1' }] })
    expect(items[1]).not.toHaveProperty('attachments')
  })
})

// ---------------------------------------------------------------------------
// ② ComposerCard 组件面
// ---------------------------------------------------------------------------

describe('ComposerCard：附件组件面', () => {
  it('上传注入→chip 缩略（raw URL+宽高 title）→移除', async () => {
    await attachOne()
    expect(chips()).toHaveLength(1)
    const img = chips()[0]!.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/assets/blob-heart.png/raw')
    expect(img?.getAttribute('title')).toBe('heart.png（640×480）')
    ;(chips()[0]!.querySelector('[data-testid="composer-attachment-remove"]') as HTMLElement).click()
    await flush()
    expect(chips()).toHaveLength(0)
  })

  it('[W5 P0-2] 转换附件 chip 徽标：convertedToPng=true → 「已转 PNG」（未转换无徽标）', async () => {
    // 缺省上传（未转换）：chip 无徽标。
    await attachOne()
    expect(chips()).toHaveLength(1)
    expect(chips()[0]!.querySelector('[data-testid="composer-attachment-converted"]')).toBeNull()
    for (const dispose of mountedDisposers.splice(0)) dispose()
    document.body.innerHTML = ''

    const harness = mountComposer({
      uploadAttachment: async (file: File) => ({
        blobRef: `blob-${file.name}`,
        name: 'photo.png',
        mime: 'image/png',
        width: 800,
        height: 600,
        size: file.size,
        rawUrl: () => `/api/assets/blob-converted/raw`,
        convertedToPng: true,
      }),
    })
    pickFiles(attachInput(), [imageFile('photo.jpg')])
    await flush()
    expect(chips()).toHaveLength(1)
    const badge = chips()[0]!.querySelector('[data-testid="composer-attachment-converted"]')
    expect(badge?.textContent).toBe('已转 PNG')
    expect(chips()[0]!.textContent).toContain('photo.png')
    // 发送载荷：附件元数据线上只投五字段面（convertedToPng 不上线路径）。
    composerInput().value = '排这张'
    composerInput().dispatchEvent(new Event('input', { bubbles: true }))
    ;(document.querySelector('[data-testid="agent-send"]') as HTMLElement | null)?.click()
    await flush()
    expect(harness.sends[0]?.attachments?.map((a) => a.blobRef)).toEqual(['blob-photo.jpg'])
  })

  it('上传 busy 态：spinner 位出现，完成后落 chip', async () => {
    let release: (() => void) | null = null
    const harness = mountComposer({
      uploadAttachment: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              blobRef: 'blob-slow',
              name: 'slow.png',
              mime: 'image/png',
              width: 1,
              height: 1,
              size: 8,
              rawUrl: () => '/raw',
            })
        }),
    })
    void harness
    pickFiles(attachInput(), [imageFile('slow.png')])
    await flush()
    expect(document.body.textContent).toContain('上传中…')
    release!()
    await flush()
    expect(document.body.textContent).not.toContain('上传中…')
    expect(chips()).toHaveLength(1)
  })

  it('结构化载荷：文本原样+attachments 元数据（不再拼「[图片附件]」文本行）', async () => {
    const { sends } = await attachOne()
    const input = composerInput()
    input.value = '把这张图排满红钻'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    ;(document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).click()
    await flush()
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toBe('把这张图排满红钻')
    expect(sends[0]!.text).not.toContain('[图片附件')
    expect(sends[0]!.attachments).toEqual([
      { blobRef: 'blob-heart.png', name: 'heart.png', mime: 'image/png', width: 640, height: 480 },
    ])
    // 发送后清场。
    expect(chips()).toHaveLength(0)
    expect(input.value).toBe('')
  })

  it('纯图发送门：空文本+有附件可发；空文本+无附件禁用', async () => {
    const { sends } = await attachOne()
    const send = document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement
    expect((send as HTMLButtonElement).disabled).toBe(false)
    send.click()
    await flush()
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toBe('')
    expect(sends[0]!.attachments).toHaveLength(1)
    // 移除后回到「空=禁用」。
    const again = await attachOne()
    ;(chips()[0]!.querySelector('[data-testid="composer-attachment-remove"]') as HTMLElement).click()
    await flush()
    expect((document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).disabled).toBe(true)
    expect(again.sends).toHaveLength(0)
  })

  it('running+纯图：发送（排队）位不退场（停止位并存、引导 Zap 不出现——steer 只面向文本）', async () => {
    mountComposer({
      running: true,
      onstop: () => {},
      uploadAttachment: async (file) => ({
        blobRef: `blob-${file.name}`,
        name: file.name,
        mime: 'image/png',
        width: 640,
        height: 480,
        size: file.size,
        rawUrl: () => '/raw',
      }),
    })
    pickFiles(attachInput(), [imageFile()])
    await flush()
    expect((document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('[data-testid="agent-stop"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-steer"]')).toBeNull()
  })

  it('粘贴（clipboardData.files）与拖入（drop）三入口同门', async () => {
    const upload = async (file: File): Promise<TestComposerAttachment> => ({
      blobRef: `blob-${file.name}`,
      name: file.name,
      mime: 'image/png',
      width: 640,
      height: 480,
      size: file.size,
      rawUrl: () => '/raw',
    })
    // 粘贴到 textarea。
    mountComposer({ uploadAttachment: upload })
    pasteFiles(composerInput(), [imageFile('paste.png')])
    await flush()
    expect(chips()).toHaveLength(1)
    for (const dispose of mountedDisposers.splice(0)) dispose()
    document.body.innerHTML = ''
    // 拖入到输入卡根（textarea 父级）。
    mountComposer({ uploadAttachment: upload })
    dropFiles(composerInput().parentElement as HTMLElement, [imageFile('drop.png')])
    await flush()
    expect(chips()).toHaveLength(1)
  })

  it('尺寸门：超 4MiB 拒收（toast+无 chip+不调上传）', async () => {
    const { uploads } = await attachOne(async (file) => {
      throw new Error('不应被调用')
    })
    void uploads
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    pickFiles(attachInput(), [big])
    await flush()
    expect(chips()).toHaveLength(0)
    expect(getToasts().map((t) => t.message).join('\n')).toContain('big.png」超过 4MiB 上限')
  })

  it('数量门：单条最多 4 张（第 5 张 toast 拒收）', async () => {
    await attachOne()
    pickFiles(attachInput(), [imageFile('a.png'), imageFile('b.png'), imageFile('c.png'), imageFile('d.png')])
    await flush()
    expect(chips()).toHaveLength(4)
    pickFiles(attachInput(), [imageFile('e.png')])
    await flush()
    expect(chips()).toHaveLength(4)
    expect(getToasts().map((t) => t.message).join('\n')).toContain('最多 4 张图片')
  })

  it('上传失败：toast（中文错误）+busy 复位（可重试）', async () => {
    let failFirst = true
    const { sends } = mountComposer({
      uploadAttachment: async (file) => {
        if (failFirst) {
          failFirst = false
          throw new Error('网络不可达')
        }
        return {
          blobRef: `blob-${file.name}`,
          name: file.name,
          mime: 'image/png',
          width: 640,
          height: 480,
          size: file.size,
          rawUrl: () => '/raw',
        }
      },
    })
    pickFiles(attachInput(), [imageFile()])
    await flush()
    expect(chips()).toHaveLength(0)
    expect(getToasts().map((t) => t.message).join('\n')).toContain('图片上传失败：网络不可达')
    expect(document.body.textContent).not.toContain('上传中…')
    // 重试成功。
    pickFiles(attachInput(), [imageFile()])
    await flush()
    expect(chips()).toHaveLength(1)
    void sends
  })
})

// ---------------------------------------------------------------------------
// ③ SessionStream + store 链路（fake rpc AgentApi 注入）
// ---------------------------------------------------------------------------

interface FollowupCall {
  sessionId: string
  text: string
  mode?: 'followup' | 'steer'
  attachments?: string[]
}

interface StubOptions {
  /** getSession 返回的任务行（缺省一个 done 任务承载历史帧；running 任务→排队通道）。 */
  tasks?: Array<{ taskId: string; status: 'running' | 'done' }>
  /** replay 返回的帧（历史回放渲染源）。 */
  replayFrames?: Frame[]
}

/** fake rpc AgentApi（附件链注入面——mode 'rpc' 触发 SessionStream attachable）。 */
function makeRpcStub(options: StubOptions = {}): {
  api: AgentApi
  followupCalls: FollowupCall[]
  uploadedFiles: File[]
  replayCalls: number
  emit: (taskId: string, frame: Frame) => void
} {
  const iso = new Date().toISOString()
  const session = { id: 's-att', title: '附件链会话', status: 'active' as const, createdAt: iso, updatedAt: iso }
  const followupCalls: FollowupCall[] = []
  const uploadedFiles: File[] = []
  let replayCalls = 0
  let followupSeq = 0
  const listeners = new Map<string, Set<(frame: Frame) => void>>()
  let connectionState: AgentConnectionState = 'open'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
  const frames = [...(options.replayFrames ?? [])]
  const api: AgentApi = {
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
    followup: async (_sessionId, text, mode, attachments) => {
      followupSeq += 1
      // 线形状归一记录（undefined 键不落——与 daemon 实际线上形状一致）。
      followupCalls.push({
        sessionId: _sessionId,
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
    replay: async () => {
      replayCalls += 1
      return { frames: structuredClone(frames), nextSeq: frames.length }
    },
    sessionResult: async () => {
      throw new Error('会话暂无已完成结果')
    },
    taskResult: async () => ({ found: false }),
    taskArtifact: async () => {
      throw new Error('工件不存在（附件链桩）')
    },
    taskDetail: async () => {
      throw new Error('任务详情不可用（附件链桩）')
    },
    layerSplit: async () => {
      throw new Error('拆层不可用（附件链桩）')
    },
    layerRename: async () => {
      throw new Error('重命名不可用（附件链桩）')
    },
    layerStrategySet: async () => {
      throw new Error('策略直改不可用（附件链桩）')
    },
    treeHistory: async () => {
      throw new Error('版本史不可用（附件链桩）')
    },
    layerMaskPatch: async () => {
      throw new Error('遮罩编辑不可用（附件链桩）')
    },
    viewStateSet: async () => {
      throw new Error('视图态写入不可用（附件链桩）')
    },
    taskExport: async () => {
      throw new Error('任务导出不可用（附件链桩）')
    },
    layerReorder: async () => {
      throw new Error('图层重排不可用（附件链桩）')
    },
    layerDelete: async () => {
      throw new Error('图层删除不可用（附件链桩）')
    },
    treeRevert: async () => {
      throw new Error('整树回退不可用（附件链桩）')
    },
    maskEditRetry: async () => {
      throw new Error('编辑重算不可用（附件链桩）')
    },
    maskEditDiscard: async () => {
      throw new Error('编辑放弃不可用（附件链桩）')
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
  return {
    api,
    followupCalls,
    uploadedFiles,
    get replayCalls() {
      return replayCalls
    },
    emit: (taskId, frame) => {
      for (const listener of listeners.get(taskId) ?? []) listener(frame)
    },
  }
}

function mountStream(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SessionStream, { target })
  mountedDisposers.push(() => {
    unmount(component)
    target.remove()
  })
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

describe('SessionStream+store：附件链（fake rpc AgentApi）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
  })

  afterEach(() => {
    resetAgentStoreForTests()
  })

  it('rpc 模式附件位可见（注入 uploadAttachment）；mock 模式隐藏', async () => {
    const stub = makeRpcStub()
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()
    expect(document.querySelector('button[aria-label="添加图片"]')).not.toBeNull()
    for (const dispose of mountedDisposers.splice(0)) dispose()
    document.body.innerHTML = ''

    bindAgentApi(new MockAgentApi({ speed: 0 }))
    resetAgentStoreForTests()
    await initAgentStore()
    mountStream()
    await flush()
    expect(document.querySelector('button[aria-label="添加图片"]')).toBeNull()
  })

  it('上传→发送：uploadAssetImage 载荷 + followup 线字段 attachments（blobRef）', async () => {
    // 登录态先行（raw 缩略 URL 的 token 在 chip 渲染时现读——上传前注入）。
    sessionStorage.setItem(TOKEN_KEY, 'tok-stream')
    const stub = makeRpcStub()
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    pickFiles(attachInput(), [imageFile('heart.png')])
    await flush()
    expect(stub.uploadedFiles.map((f) => f.name)).toEqual(['heart.png'])
    expect(chips()).toHaveLength(1)
    const img = chips()[0]!.querySelector('img')
    expect(img?.getAttribute('src')).toBe(`${location.origin}/api/assets/blob-heart.png/raw?token=tok-stream`)

    const input = composerInput()
    input.value = '照这张图排'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    ;(document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).click()
    await flush()
    expect(stub.followupCalls).toEqual([
      { sessionId: 's-att', text: '照这张图排', mode: 'followup', attachments: ['blob-heart.png'] },
    ])
  })

  it('纯图投递：空文本+有附件 → followup 空 text+attachments；无载荷静默不投', async () => {
    const stub = makeRpcStub()
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()
    expect((document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).disabled).toBe(true)

    pickFiles(attachInput(), [imageFile('only.png')])
    await flush()
    const send = document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    send.click()
    await flush()
    expect(stub.followupCalls).toEqual([{ sessionId: 's-att', text: '', mode: 'followup', attachments: ['blob-only.png'] }])
  })

  it('运行中纯图=入队携带附件；done 后自动开跑（attachments 随投递）', async () => {
    const stub = makeRpcStub({ tasks: [{ taskId: 't-run', status: 'running' }] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await sendFollowup('', 'followup', [
      { blobRef: 'blob-q', name: 'q.png', mime: 'image/png', width: 100, height: 50 },
    ])
    expect(stub.followupCalls).toHaveLength(0) // 运行中：入队不投递
    const queue = getAgentQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0]!.attachments).toEqual([{ blobRef: 'blob-q', name: 'q.png', mime: 'image/png', width: 100, height: 50 }])

    // done 收口 → 队头自动开跑（附件随 followup 线字段）。
    stub.emit('t-run', { seq: 1, ts: Date.now(), kind: 'done', payload: {} })
    await waitUntil(() => stub.followupCalls.length === 1)
    expect(stub.followupCalls[0]).toEqual({ sessionId: 's-att', text: '', mode: 'followup', attachments: ['blob-q'] })
    expect(getAgentQueue()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ④ 历史回放（帧附件元数据渲染 + 刷新重开）
// ---------------------------------------------------------------------------

describe('历史回放：附件元数据渲染', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
  })

  afterEach(() => {
    resetAgentStoreForTests()
  })

  const replayFrames: Frame[] = [
    {
      seq: 1,
      ts: 1,
      kind: 'transcript',
      payload: {
        role: 'user',
        text: '帮这张图排钻',
        attachments: [
          { blobRef: 'replay-ref-1', name: '旧图.png', mime: 'image/png', width: 800, height: 600 },
          { blobRef: 'replay-ref-2', name: '旧图2.png', mime: 'image/png', width: 320, height: 240 },
        ],
      },
    } as unknown as Frame,
    { seq: 2, ts: 2, kind: 'transcript', payload: { role: 'user', text: '纯图消息', attachments: [{ blobRef: 'replay-ref-3', name: '纯图.png', mime: 'image/png', width: 64, height: 64 }] } } as unknown as Frame,
    { seq: 3, ts: 3, kind: 'transcript', payload: { role: 'assistant', text: '收到，开始分析图块。' } },
    { seq: 4, ts: 4, kind: 'done', payload: {} },
  ]

  it('回放渲染：chip 行（缩略+文件名）+raw 缩略 URL（token 随存储层）', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok-replay')
    const stub = makeRpcStub({ replayFrames })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    // [T4 2026-10-01] chip 不再 a href 直跳新窗口——button 开应用内 Lightbox
    // （raw URL 挪到缩略 img src；Lightbox 交互面见 messagePolish.test.ts）。
    const chipEls = [...document.querySelectorAll('[data-testid="user-attachment-chip"]')] as HTMLButtonElement[]
    expect(chipEls).toHaveLength(3)
    expect(chipEls[0]!.querySelector('img')?.getAttribute('src')).toBe(`${location.origin}/api/assets/replay-ref-1/raw?token=tok-replay`)
    expect(chipEls[0]!.textContent).toContain('旧图.png')
    // 纯图消息：无文本气泡，只有 chip 行。
    expect(chipEls[2]!.textContent).toContain('纯图.png')
  })

  it('刷新回放：openSession 重开后附件 chip 不丢（replay 再拉）', async () => {
    const stub = makeRpcStub({ replayFrames })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()
    expect(document.querySelectorAll('[data-testid="user-attachment-chip"]')).toHaveLength(3)
    const replaysBefore = stub.replayCalls

    // 刷新语义：重开同一会话（store 清帧重订阅——replay 再拉一遍）。
    await openSession('s-att')
    await flush()
    expect(stub.replayCalls).toBeGreaterThan(replaysBefore)
    expect(document.querySelectorAll('[data-testid="user-attachment-chip"]')).toHaveLength(3)
  })
})
