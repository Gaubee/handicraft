/*
 * [new-task-panel 2026-10-02 studio] 开始新任务面板测试（Owner 需求「参考朱墨
 * TaskComposer：明确填图片（可多）+尺寸+装饰钻集合；多图=并发创建多个会话，
 * 不是提示词实现」）。[融合形态 2026-10-02] 面板从 Sheet 抽屉改为 detail 面板
 * 形态（AgentView 的 TaskDetailPanel 挂载位——zhumo 同位）。覆盖：
 * ①纯函数层：尺寸校验界/首消息模板拼装（尺寸+用钻行人话）/会话标题推导
 *   （N 图带序号「贴钻 · 3 张之 2」/文件名）。
 * ②store 编排 submitNewTask：N 图=N 会话并发（每会话单图+同文本+同 sourceSetId/
 *   model+带序号标题+toast「已并发创建 N 个会话」）；单图=正常单会话（无汇总
 *   toast）；部分失败弱事务（保留+明细）；空图=false 零调用。
 * ③面板挂载：表单域渲染（预设 chips/尺寸缺省/集合下拉读面）+校验门（无图/
 *   尺寸越界=发送禁用）+预设填充+提交全链（多图→N 会话/市场组合先复制）+
 *   mock 演示模式横幅+本地图路径。
 * ④入口接线：SessionStream 注入 onstartnewtask（AgentView 实例）——空态
 *   「开始新任务」按钮+拖放收图改道开面板；旧径（未注入=策略 tab）保持。
 * ⑤融合形态（AgentView 集成）：侧栏「新会话」点击=零创建+detail 位切 composer
 *   页；取消=回原视图零创建；创建成功=收起+切新会话；composer 态点会话=直接
 *   切换（草稿丢弃）；无会话空态=detail 位自动呈 composer；旧「新任务」钮退场。
 * 全程 fake rpc AgentApi（store 编排面——daemon 零改动）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import AgentView from '$lib/components/agent/AgentView.svelte'
import NewTaskComposer from '$lib/components/agent/NewTaskComposer.svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  bindAgentApi,
  getActiveSessionId,
  initAgentStore,
  resetAgentStoreForTests,
  submitNewTask,
} from '$lib/agentApi/store.svelte'
import {
  buildNewTaskFirstMessage,
  isCanvasCmValid,
  newTaskSessionTitles,
  NEW_TASK_PRESETS,
} from '$lib/agentApi/newTaskComposer'
import type { AttachmentMeta } from '$lib/agentApi/attachments'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import type { AgentApi, AgentConnectionState, AgentSetSummary } from '$lib/agentApi/types'
import type { Frame } from '@handicraft/contracts'

// jsdom 缺口桩（同 quickStart.test.ts——挂 SessionStream/NewTaskComposer）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

// ---------------------------------------------------------------- 测试助手

function att(name: string): AttachmentMeta {
  return { blobRef: `blob-${name}`, name, mime: 'image/png', width: 640, height: 480 }
}

const STUB_SETS: AgentSetSummary[] = [
  { resourceId: 'res-a', setId: 'set-cartoon-a', name: '卡通人物套餐-A', memberCount: 12, updatedAt: '2026-09-20T08:30:00.000Z' },
  { resourceId: 'res-b', setId: 'set-red-basic', name: '红色系基础钻', memberCount: 8, updatedAt: '2026-09-25T12:00:00.000Z' },
]

const MARKET_STUB_SET: AgentSetSummary = {
  resourceId: 'res-mkt', setId: 'set-xmas', name: '圣诞系列', memberCount: 20, updatedAt: '2026-09-28T09:00:00.000Z', scope: 'market',
}

interface FollowupCall {
  sessionId: string
  text: string
  mode?: 'followup' | 'steer'
  attachments?: string[]
  sourceSetId?: string
  autoApprove?: boolean
  model?: { provider: string; model: string; effort?: string }
}

interface StubOptions {
  /** getSession 返回的任务行（[] = 新会话空态）。 */
  tasks?: Array<{ taskId: string; status: 'running' | 'done' }>
  /** 第 k 次 createSession 抛错（1 基）。 */
  failCreateOn?: number
  /** listSets 候选。 */
  sets?: AgentSetSummary[]
}

/** fake rpc AgentApi：载荷记账（createSession 标题/followup 全参/上传/集合/市场复制）。 */
function makeRpcStub(options: StubOptions = {}): {
  api: AgentApi
  followupCalls: FollowupCall[]
  createCalls: Array<{ title?: string }>
  uploadedFiles: File[]
  copyMarketCalls: string[]
  listCalls: () => number
} {
  const iso = new Date().toISOString()
  const baseSession = { id: 's-base', title: '空会话', status: 'active' as const, createdAt: iso, updatedAt: iso }
  const followupCalls: FollowupCall[] = []
  const createCalls: Array<{ title?: string }> = []
  const uploadedFiles: File[] = []
  const copyMarketCalls: string[] = []
  let listCount = 0
  let createSeq = 0
  let followupSeq = 0
  const listeners = new Map<string, Set<(frame: Frame) => void>>()
  let connectionState: AgentConnectionState = 'open'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
  const unimplemented = (what: string) => (): never => {
    throw new Error(`${what}不可用（新任务面板桩）`)
  }
  const api: AgentApi = {
    mode: 'rpc',
    connection: () => connectionState,
    onConnectionChange: (listener) => {
      connectionListeners.add(listener)
      listener(connectionState)
      return () => connectionListeners.delete(listener)
    },
    listSessions: async () => {
      listCount += 1
      return { sessions: [baseSession] }
    },
    createSession: async (input) => {
      createSeq += 1
      if (options.failCreateOn === createSeq) throw new Error('会话创建失败（模拟）')
      createCalls.push(input?.title !== undefined ? { title: input.title } : {})
      return { sessionId: `s-nt-${createSeq}`, createdAt: iso }
    },
    getSession: async (sessionId) => ({
      session: { ...baseSession, id: sessionId },
      tasks: (options.tasks ?? []).map((task) => ({
        taskId: task.taskId,
        status: task.status,
        lastSeq: 0,
        frameCount: 0,
      })),
    }),
    followup: async (sessionId, text, mode, attachments, sourceSetId, autoApprove, model) => {
      followupSeq += 1
      followupCalls.push({
        sessionId,
        text,
        ...(mode !== undefined ? { mode } : {}),
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
        ...(sourceSetId !== undefined ? { sourceSetId } : {}),
        ...(autoApprove !== undefined ? { autoApprove } : {}),
        ...(model !== undefined ? { model } : {}),
      })
      return { taskId: `t-nt-${followupSeq}` }
    },
    listSets: async () => structuredClone(options.sets ?? [...STUB_SETS, MARKET_STUB_SET]),
    copyMarketSet: async (resourceId: string) => {
      copyMarketCalls.push(resourceId)
      return { resourceId: `copy-of-${resourceId}`, memberCount: 20 }
    },
    uploadAssetImage: async (file) => {
      uploadedFiles.push(file)
      return { blobRef: `blob-${file.name}`, name: file.name, mime: file.type || 'image/png', width: 640, height: 480 }
    },
    stopTask: async () => {},
    answer: async () => ({ ok: true }),
    renameSession: unimplemented('会话改名'),
    cancel: async () => ({ ok: true }),
    clear: async () => ({ ok: true, status: 'cleared' as const }),
    replay: async () => ({ frames: [], nextSeq: 0 }),
    sessionResult: async () => {
      throw new Error('会话暂无已完成结果')
    },
    taskResult: async () => ({ found: false }),
    taskArtifact: unimplemented('工件读面'),
    taskDetail: unimplemented('任务详情'),
    layerSplit: unimplemented('拆层'),
    layerRename: unimplemented('图层改名'),
    layerStrategySet: unimplemented('策略直改'),
    treeHistory: unimplemented('版本史'),
    layerMaskPatch: unimplemented('遮罩编辑'),
    viewStateSet: unimplemented('视图态写入'),
    taskExport: unimplemented('任务导出'),
    layerReorder: unimplemented('图层重排'),
    layerDelete: unimplemented('图层删除'),
    treeRevert: unimplemented('整树回退'),
    maskEditRetry: unimplemented('编辑重算'),
    maskEditDiscard: unimplemented('编辑放弃'),
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
  return { api, followupCalls, createCalls, uploadedFiles, copyMarketCalls, listCalls: () => listCount }
}

const mountedDisposers: Array<() => void> = []

/** [融合形态] 面板=detail 位条件挂载的整页表单（无 open 开关——父层控挂载）。 */
function mountPanel(options?: { seedFiles?: File[] | null; oncreated?: () => void; oncancel?: () => void }): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(NewTaskComposer, {
    target,
    props: {
      ...(options?.seedFiles !== undefined ? { seedFiles: options.seedFiles } : {}),
      ...(options?.oncreated !== undefined ? { oncreated: options.oncreated } : {}),
      ...(options?.oncancel !== undefined ? { oncancel: options.oncancel } : {}),
    },
  })
  mountedDisposers.push(() => {
    unmount(component)
    target.remove()
  })
}

function mountStream(props?: Record<string, unknown>): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SessionStream, { target, props: props ?? {} })
  mountedDisposers.push(() => {
    unmount(component)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function imageFile(name: string): File {
  return new File([PNG_BYTES], name, { type: 'image/png' })
}

function dropFiles(el: HTMLElement, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] }, configurable: true })
  el.dispatchEvent(event)
}

function dragOver(el: HTMLElement): void {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] }, configurable: true })
  el.dispatchEvent(event)
}

function composerInput(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="new-task-panel"] [data-testid="agent-composer"]') as HTMLTextAreaElement
}

function sendButton(): HTMLButtonElement {
  return document.querySelector('[data-testid="new-task-panel"] [data-testid="agent-send"]') as HTMLButtonElement
}

function createButton(): HTMLButtonElement {
  return document.querySelector('[data-testid="new-task-create"]') as HTMLButtonElement
}

function imageChips(): HTMLElement[] {
  return [...document.querySelectorAll('[data-testid="new-task-image-chips"] > span')] as HTMLElement[]
}

/** select 值设置（bind:value 走 change 事件）。 */
function setSelectValue(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function setNumberValue(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// ① 纯函数层（newTaskComposer.ts）
// ---------------------------------------------------------------------------

describe('纯函数层：校验/模板/标题', () => {
  it('尺寸校验界：5/100 含端点通过；4.9/100.1/NaN 拒', () => {
    expect(isCanvasCmValid(5)).toBe(true)
    expect(isCanvasCmValid(100)).toBe(true)
    expect(isCanvasCmValid(20)).toBe(true)
    expect(isCanvasCmValid(4.9)).toBe(false)
    expect(isCanvasCmValid(100.1)).toBe(false)
    expect(isCanvasCmValid(Number.NaN)).toBe(false)
  })

  it('首消息模板：指令+尺寸+选定集合（人话行——图片走附件面不进文本）', () => {
    const message = buildNewTaskFirstMessage({
      instruction: '排满红色圆钻',
      widthCm: 20,
      heightCm: 20,
      set: STUB_SETS[1]!,
    })
    expect(message).toBe('排满红色圆钻\n画布尺寸：20×20 cm\n用钻集合：红色系基础钻（8 成员）')
  })

  it('首消息模板：无指令纯表单参数也成立；智能选钻=自选措辞', () => {
    const message = buildNewTaskFirstMessage({ instruction: '  ', widthCm: 30, heightCm: 15, set: null })
    expect(message).toBe('画布尺寸：30×15 cm\n用钻：智能选钻——由你按画面自动挑选最合适的钻（颜色/尺寸/形状/密度）')
  })

  it('标题推导：多图带序号（贴钻 · 3 张之 2——Owner 需求原文）；单图=指令/文件名', () => {
    expect(newTaskSessionTitles('', [att('a.png'), att('b.png'), att('c.png')])).toEqual([
      '贴钻 · 3 张之 1',
      '贴钻 · 3 张之 2',
      '贴钻 · 3 张之 3',
    ])
    expect(newTaskSessionTitles('排满红钻', [att('a.png'), att('b.png')])).toEqual([
      '排满红钻 · 2 张之 1',
      '排满红钻 · 2 张之 2',
    ])
    expect(newTaskSessionTitles('排满红钻', [att('a.png')])).toEqual(['排满红钻'])
    expect(newTaskSessionTitles('', [att('heart.png')])).toEqual(['heart.png'])
  })

  it('预设开场：4 档贴钻管线措辞（点选填充用）', () => {
    expect(NEW_TASK_PRESETS).toHaveLength(4)
    expect(NEW_TASK_PRESETS.map((preset) => preset.label)).toEqual([
      '全自动（识图→排钻→导出）',
      '只识图出树，排钻我来',
      '按我选的组合用钻',
      '样卡复刻',
    ])
  })
})

// ---------------------------------------------------------------------------
// ② store 编排：submitNewTask（多图=N 会话并发）
// ---------------------------------------------------------------------------

describe('store 编排：submitNewTask（N 图=N 会话并发——不是提示词实现）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    resetSessionRouteForTests('')
    resetToastsForTests()
  })

  afterEach(() => {
    resetAgentStoreForTests()
    resetToastsForTests()
  })

  it('3 图=并发 3 会话：每会话单图+同模板文本+同 sourceSetId/model；标题带序号；toast+打开第 1 个+列表刷新', async () => {
    const stub = makeRpcStub()
    bindAgentApi(stub.api)
    await initAgentStore()

    const ok = await submitNewTask({
      images: [att('a.png'), att('b.png'), att('c.png')],
      firstMessage: '排满\n画布尺寸：20×20 cm\n用钻集合：红色系基础钻（8 成员）',
      instruction: '排满',
      sourceSetId: 'res-b',
      model: { provider: 'p1', model: 'm1', effort: 'high' },
    })

    expect(ok).toBe(true)
    expect(stub.createCalls).toHaveLength(3)
    // 标题=指令基名+序号（Owner 需求「贴钻 · 3 张之 2」形态）。
    expect(stub.createCalls.map((call) => call.title)).toEqual([
      '排满 · 3 张之 1',
      '排满 · 3 张之 2',
      '排满 · 3 张之 3',
    ])
    expect(stub.followupCalls).toHaveLength(3)
    for (let i = 0; i < 3; i += 1) {
      expect(stub.followupCalls[i]).toMatchObject({
        sessionId: `s-nt-${i + 1}`,
        text: '排满\n画布尺寸：20×20 cm\n用钻集合：红色系基础钻（8 成员）',
        mode: 'followup',
        sourceSetId: 'res-b',
        model: { provider: 'p1', model: 'm1', effort: 'high' },
      })
      // 每会话恰一张图（图 i 走附件面——非 base64 内联）。
      expect(stub.followupCalls[i]!.attachments).toEqual([`blob-${'abc'[i]}.png`])
    }
    const messages = getToasts().map((toast) => toast.message).join('\n')
    expect(messages).toContain('已并发创建 3 个会话')
    expect(stub.listCalls()).toBeGreaterThanOrEqual(2) // init + 提交后刷新
    expect(getActiveSessionId()).toBe('s-nt-1')
  })

  it('单图=正常单会话创建+发首消息（无汇总 toast——与既有单发同静默）', async () => {
    const stub = makeRpcStub()
    bindAgentApi(stub.api)
    await initAgentStore()

    const ok = await submitNewTask({
      images: [att('only.png')],
      firstMessage: '画布尺寸：20×20 cm',
      instruction: '',
    })

    expect(ok).toBe(true)
    expect(stub.createCalls).toEqual([{ title: 'only.png' }])
    expect(stub.followupCalls).toEqual([
      { sessionId: 's-nt-1', text: '画布尺寸：20×20 cm', mode: 'followup', attachments: ['blob-only.png'] },
    ])
    expect(getToasts()).toHaveLength(0)
    expect(getActiveSessionId()).toBe('s-nt-1')
  })

  it('部分失败弱事务：保留已建成+toast 成败明细；返回 true（面板关闭）', async () => {
    const stub = makeRpcStub({ failCreateOn: 2 })
    bindAgentApi(stub.api)
    await initAgentStore()

    const ok = await submitNewTask({
      images: [att('a.png'), att('b.png'), att('c.png')],
      firstMessage: '排满',
      instruction: '排满',
    })

    expect(ok).toBe(true)
    expect(stub.followupCalls.map((call) => call.sessionId)).toEqual(['s-nt-1', 's-nt-3'])
    const messages = getToasts().map((toast) => toast.message).join('\n')
    expect(messages).toContain('已创建 2 个会话、失败 1 个')
    expect(messages).toContain('第 2 张：会话创建失败（模拟）')
    expect(getActiveSessionId()).toBe('s-nt-1')
  })

  it('全部失败：返回 false（面板保持在场）+toast 如实报告+不打开新会话', async () => {
    const stub = makeRpcStub({ failCreateOn: 1 })
    bindAgentApi(stub.api)
    await initAgentStore()

    let ok = await submitNewTask({ images: [att('a.png')], firstMessage: '排满', instruction: '排满' })
    expect(ok).toBe(false)
    // 3 图全败（failCreateOn 只打第 1 个——改用逐张换桩再验全败形态）。
    const stubAll = makeRpcStub()
    // 动态替换 createSession 全败。
    ;(stubAll.api as unknown as { createSession: unknown }).createSession = async () => {
      throw new Error('会话创建失败（模拟）')
    }
    bindAgentApi(stubAll.api)
    ok = await submitNewTask({ images: [att('a.png'), att('b.png')], firstMessage: '排满', instruction: '排满' })
    expect(ok).toBe(false)
    const messages = getToasts().map((toast) => toast.message).join('\n')
    expect(messages).toContain('创建会话全部失败')
    expect(getActiveSessionId()).toBe('s-base')
  })

  it('空图守卫：false+零调用（表单校验的最底层兜底）', async () => {
    const stub = makeRpcStub()
    bindAgentApi(stub.api)
    await initAgentStore()

    const ok = await submitNewTask({ images: [], firstMessage: '', instruction: '' })
    expect(ok).toBe(false)
    expect(stub.createCalls).toHaveLength(0)
    expect(stub.followupCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ③ 面板挂载：表单域/校验/预设/提交全链
// ---------------------------------------------------------------------------

describe('面板挂载：NewTaskComposer（表单化+提交链）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    resetSessionRouteForTests('')
    resetToastsForTests()
  })

  afterEach(() => {
    for (const dispose of mountedDisposers.splice(0)) dispose()
    document.body.innerHTML = ''
    resetAgentStoreForTests()
    resetToastsForTests()
  })

  it('表单域渲染：图片区+尺寸缺省 20×20+集合下拉（智能选钻缺省+我的组合/市场组）+预设 4 chips+复用 ComposerCard', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountPanel()
    await flush()

    expect(document.querySelector('[data-testid="new-task-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="new-task-image-empty"]')).not.toBeNull()
    // 尺寸缺省 20×20。
    const width = document.querySelector('[data-testid="new-task-width"]') as HTMLInputElement
    const height = document.querySelector('[data-testid="new-task-height"]') as HTMLInputElement
    expect(width.value).toBe('20')
    expect(height.value).toBe('20')
    // 集合下拉：智能选钻缺省+listSets 读面（我的组合 2+市场组 1）。
    const select = document.querySelector('[data-testid="new-task-set-select"]') as HTMLSelectElement
    expect(select.value).toBe('')
    const options = [...select.querySelectorAll('option')].map((option) => option.textContent ?? '')
    expect(options[0]).toContain('智能选钻（自动）')
    expect(options.some((text) => text.includes('卡通人物套餐-A'))).toBe(true)
    expect(options.some((text) => text.includes('圣诞系列'))).toBe(true)
    // 预设 4 chips+指令输入面=复用 ComposerCard。
    const presets = [...document.querySelectorAll('[data-testid="new-task-preset"]')] as HTMLButtonElement[]
    expect(presets.map((chip) => chip.textContent?.trim())).toEqual(NEW_TASK_PRESETS.map((preset) => preset.label))
    expect(composerInput()).not.toBeNull()
    // rpc 真链无演示横幅。
    expect(document.querySelector('[data-testid="new-task-demo-banner"]')).toBeNull()
  })

  it('校验门：无图/尺寸越界=创建禁用；拖图入面板（上传链）+尺寸修正后放行（指令可空——表单门独立于文本）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountPanel()
    await flush()

    // 无图：创建禁用（≥1 张才可创建）。
    expect(createButton().hasAttribute('disabled')).toBe(true)

    // 拖 2 图入面板 dropzone → 上传链+chip 落位。
    const zone = document.querySelector('[data-testid="new-task-dropzone"]') as HTMLElement
    dropFiles(zone, [imageFile('heart.png'), imageFile('star.png')])
    await flush()
    expect(stub.uploadedFiles.map((file) => file.name)).toEqual(['heart.png', 'star.png'])
    expect(imageChips()).toHaveLength(2)
    expect(createButton().hasAttribute('disabled')).toBe(false)

    // 尺寸越界：错误行+创建禁用。
    setNumberValue(document.querySelector('[data-testid="new-task-width"]') as HTMLInputElement, '200')
    await tick()
    expect(document.querySelector('[data-testid="new-task-size-error"]')?.textContent).toContain('5–100')
    expect(createButton().hasAttribute('disabled')).toBe(true)

    // 修正回界：放行。
    setNumberValue(document.querySelector('[data-testid="new-task-width"]') as HTMLInputElement, '25')
    await tick()
    expect(document.querySelector('[data-testid="new-task-size-error"]')).toBeNull()
    expect(createButton().hasAttribute('disabled')).toBe(false)

    // chip 可删（≥1 张门回位）。
    ;([...document.querySelectorAll('[data-testid="new-task-image-remove"]')] as HTMLButtonElement[])[0]!.click()
    await tick()
    expect(imageChips()).toHaveLength(1)
    ;([...document.querySelectorAll('[data-testid="new-task-image-remove"]')] as HTMLButtonElement[])[0]!.click()
    await tick()
    expect(imageChips()).toHaveLength(0)
    expect(createButton().hasAttribute('disabled')).toBe(true)
  })

  it('预设点选=填充输入框（不自动发送、可编辑）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountPanel()
    await flush()

    const presets = [...document.querySelectorAll('[data-testid="new-task-preset"]')] as HTMLButtonElement[]
    presets[0]!.click()
    await flush()
    expect(composerInput().value).toBe(NEW_TASK_PRESETS[0]!.prompt)
    expect(stub.followupCalls).toHaveLength(0)
    composerInput().value = `${composerInput().value}，边缘再密一点`
    composerInput().dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(composerInput().value).toContain('边缘再密一点')
  })

  it('提交全链（多图+选组合+改尺寸）：2 图=2 会话并发——模板文本+单图附件+sourceSetId+序号标题+toast+oncreated 收起信号', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    const created = vi.fn()
    mountPanel({ oncreated: created })
    await flush()

    dropFiles(document.querySelector('[data-testid="new-task-dropzone"]') as HTMLElement, [
      imageFile('heart.png'),
      imageFile('star.png'),
    ])
    await flush()
    setNumberValue(document.querySelector('[data-testid="new-task-width"]') as HTMLInputElement, '30')
    await tick()
    setSelectValue(document.querySelector('[data-testid="new-task-set-select"]') as HTMLSelectElement, 'res-b')
    await tick()
    const input = composerInput()
    input.value = '排满红色圆钻'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    // 多图摘要行在场（并发语义显性）+主钮带并发计数。
    expect(document.querySelector('[data-testid="new-task-summary"]')?.textContent).toContain('并发')
    expect(createButton().textContent).toContain('并发创建 2 个会话')

    createButton().click()
    await flush(60)

    expect(stub.createCalls.map((call) => call.title)).toEqual(['排满红色圆钻 · 2 张之 1', '排满红色圆钻 · 2 张之 2'])
    expect(stub.followupCalls).toHaveLength(2)
    expect(stub.followupCalls[0]).toMatchObject({
      sessionId: 's-nt-1',
      text: '排满红色圆钻\n画布尺寸：30×20 cm\n用钻集合：红色系基础钻（8 成员）',
      attachments: ['blob-heart.png'],
      sourceSetId: 'res-b',
    })
    expect(stub.followupCalls[1]).toMatchObject({ sessionId: 's-nt-2', attachments: ['blob-star.png'], sourceSetId: 'res-b' })
    expect(getToasts().map((toast) => toast.message).join('\n')).toContain('已并发创建 2 个会话')
    // 成功=oncreated 收起信号（面板本体由 AgentView detail 位条件卸载——⑤覆盖）。
    expect(created).toHaveBeenCalledTimes(1)
  })

  it('市场组合：提交先复制副本（copyMarketSet）→sourceSetId=副本 id', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountPanel()
    await flush()

    dropFiles(document.querySelector('[data-testid="new-task-dropzone"]') as HTMLElement, [imageFile('xmas.png')])
    await flush()
    setSelectValue(document.querySelector('[data-testid="new-task-set-select"]') as HTMLSelectElement, 'res-mkt')
    await tick()
    expect(document.querySelector('[data-testid="new-task-set-market-hint"]')).not.toBeNull()
    const input = composerInput()
    input.value = '复刻这套'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    sendButton().click()
    await flush(60)

    expect(stub.copyMarketCalls).toEqual(['res-mkt'])
    expect(stub.followupCalls).toHaveLength(1)
    expect(stub.followupCalls[0]).toMatchObject({ sourceSetId: 'copy-of-res-mkt' })
    expect(stub.followupCalls[0]!.text).toContain('用钻集合：圣诞系列（20 成员）')
  })

  it('seedFiles 预填：打开即收图（chat 空态拖入→开面板路径）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountPanel({ seedFiles: [imageFile('seeded.png')] })
    await flush()

    expect(stub.uploadedFiles.map((file) => file.name)).toEqual(['seeded.png'])
    expect(imageChips()).toHaveLength(1)
  })

  it('mock 演示模式：横幅提示+本地图路径（无上传链）+提交走 mock 创建', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    const created = vi.fn()
    mountPanel({ oncreated: created })
    await flush()

    expect(document.querySelector('[data-testid="new-task-demo-banner"]')?.textContent).toContain('演示模式')
    // 集合读面在 mock 也可用（fixture 演示数据）。
    const select = document.querySelector('[data-testid="new-task-set-select"]') as HTMLSelectElement
    expect([...select.querySelectorAll('option')].length).toBeGreaterThan(1)

    dropFiles(document.querySelector('[data-testid="new-task-dropzone"]') as HTMLElement, [
      imageFile('demo-a.png'),
      imageFile('demo-b.png'),
    ])
    await flush()
    expect(imageChips()).toHaveLength(2)

    const presets = [...document.querySelectorAll('[data-testid="new-task-preset"]')] as HTMLButtonElement[]
    presets[0]!.click()
    await flush()
    sendButton().click()
    await flush(80)

    // mock 链路完整可体验：2 会话并发+oncreated 收起信号。
    expect(getToasts().map((toast) => toast.message).join('\n')).toContain('已并发创建 2 个会话')
    expect(created).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// ④ 入口接线：SessionStream（onstartnewtask 注入=AgentView 实例）
// ---------------------------------------------------------------------------

describe('入口接线：SessionStream 空态升级（开始新任务按钮+拖放改道）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    resetSessionRouteForTests('')
    resetToastsForTests()
  })

  afterEach(() => {
    for (const dispose of mountedDisposers.splice(0)) dispose()
    document.body.innerHTML = ''
    resetAgentStoreForTests()
    resetToastsForTests()
  })

  it('注入入口：空态显「开始新任务」按钮（旧预设 chips 退场）——点击回调入口', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    const openNewTask = vi.fn()
    mountStream({ onstartnewtask: openNewTask })
    await flush()

    expect(document.querySelector('[data-testid="new-task-entry"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="quick-start-presets"]')).toBeNull()
    ;(document.querySelector('[data-testid="new-task-open"]') as HTMLButtonElement).click()
    expect(openNewTask).toHaveBeenCalledTimes(1)
    // composer placeholder 指向表单入口。
    const input = document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
    expect(input.getAttribute('placeholder')).toContain('开始新任务')
  })

  it('空态拖放改道：drop 收图→开面板预填（不再进 Composer 附件）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    const openNewTask = vi.fn()
    mountStream({ onstartnewtask: openNewTask })
    await flush()

    const zone = document.querySelector('[data-testid="quick-start-dropzone"]') as HTMLElement
    expect(zone).not.toBeNull()
    dragOver(zone)
    await flush()
    expect(document.querySelector('[data-testid="quick-start-drag-overlay"]')).not.toBeNull()
    const files = [imageFile('dropped.png')]
    dropFiles(zone, files)
    await flush()

    expect(openNewTask).toHaveBeenCalledTimes(1)
    expect(openNewTask.mock.calls[0]![0]).toEqual(files)
    // 旧径不触发（Composer 附件零上传）。
    expect(stub.uploadedFiles).toHaveLength(0)
  })

  it('未注入入口（策略 tab 实例）：保持旧径（预设 chips+拖放进 Composer 附件）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    expect(document.querySelector('[data-testid="new-task-entry"]')).toBeNull()
    expect(document.querySelector('[data-testid="quick-start-presets"]')).not.toBeNull()
    dropFiles(document.querySelector('[data-testid="quick-start-dropzone"]') as HTMLElement, [imageFile('legacy.png')])
    await flush()
    expect(stub.uploadedFiles.map((file) => file.name)).toEqual(['legacy.png'])
    expect(document.querySelectorAll('[data-testid="composer-attachments"] > span')).toHaveLength(1)
  })

  it('非空会话（任务行在场）：入口退场（已过首条——面板只服务新任务开工）', async () => {
    const stub = makeRpcStub({ tasks: [{ taskId: 't-hist', status: 'done' }] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream({ onstartnewtask: vi.fn() })
    await flush()

    expect(document.querySelector('[data-testid="new-task-entry"]')).toBeNull()
    expect(document.querySelector('[data-testid="quick-start-dropzone"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ⑤ 融合形态（AgentView 集成）：新会话=detail 位 composer 页——点击零创建
// ---------------------------------------------------------------------------

describe('融合形态：AgentView detail 位 composer（zhumo 同位——非抽屉非弹窗）', () => {
  let media: { set: (desktop: boolean) => void; restore: () => void } | null = null

  /** matchMedia 桩（agentDetailLayout 同式——jsdom 缺省窄态，桩成桌面三栏）。 */
  function stubMatchMediaDesktop(): { set: (desktop: boolean) => void; restore: () => void } {
    const original = window.matchMedia
    let desktop = true
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        get matches() {
          return desktop && query === '(min-width: 768px)'
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener)
        },
        removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener)
        },
        dispatchEvent: () => false,
      }) as MediaQueryList
    return {
      set: (next: boolean) => {
        desktop = next
        for (const listener of listeners) listener({ matches: desktop } as MediaQueryListEvent)
      },
      restore: () => {
        window.matchMedia = original
      },
    }
  }

  function mountAgentView(): void {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const view = mount(AgentView, { target })
    mountedDisposers.push(() => {
      unmount(view)
      target.remove()
    })
  }

  function sessionRowByTitle(title: string): HTMLElement {
    const row = [...document.querySelectorAll('[data-testid="agent-session-item"]')].find((el) =>
      el.querySelector('[data-testid="agent-session-title"]')?.textContent === title,
    )
    if (row === undefined) throw new Error(`会话行不存在：${title}`)
    return row as HTMLElement
  }

  beforeEach(() => {
    resetAgentStoreForTests()
    resetSessionRouteForTests('')
    resetToastsForTests()
    media = stubMatchMediaDesktop()
  })

  afterEach(() => {
    for (const dispose of mountedDisposers.splice(0)) dispose()
    document.body.innerHTML = ''
    media?.restore()
    media = null
    resetAgentStoreForTests()
    resetToastsForTests()
  })

  it('「新会话」点击=零创建+detail 位切 composer 页（TaskDetailPanel 让位；旧「新任务」钮退场）', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const createSpy = vi.spyOn(api, 'createSession')
    bindAgentApi(api)
    await initAgentStore()
    mountAgentView()
    // heart 会话有已完成任务 → 第三栏=TaskDetailPanel。
    await flush()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="task-detail-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="new-task-panel"]')).toBeNull()

    // 旧「新任务」独立按钮已收敛（单一「新会话」入口）。
    expect(document.querySelector('[data-testid="agent-new-task"]')).toBeNull()
    ;(document.querySelector('[data-testid="agent-new-session"]') as HTMLButtonElement).click()
    await flush()

    expect(createSpy).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="new-task-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="task-detail-panel"]')).toBeNull()
  })

  it('取消=回原视图零创建（不创建任何会话——Owner 裁决「取消/关闭=回列表态」）', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const createSpy = vi.spyOn(api, 'createSession')
    bindAgentApi(api)
    await initAgentStore()
    mountAgentView()
    await flush()
    ;(document.querySelector('[data-testid="agent-new-session"]') as HTMLButtonElement).click()
    await flush()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="new-task-panel"]')).not.toBeNull()

    ;(document.querySelector('[data-testid="new-task-cancel"]') as HTMLButtonElement).click()
    await flush()

    expect(createSpy).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="new-task-panel"]')).toBeNull()
    // 回原视图：活跃 heart 会话的任务详情复位。
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="task-detail-panel"]')).not.toBeNull()
  })

  it('创建成功=收起 composer+切到新会话（mock 演示链全程可体验）', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const createSpy = vi.spyOn(api, 'createSession')
    bindAgentApi(api)
    await initAgentStore()
    mountAgentView()
    await flush()
    ;(document.querySelector('[data-testid="agent-new-session"]') as HTMLButtonElement).click()
    await flush()

    dropFiles(document.querySelector('[data-testid="new-task-dropzone"]') as HTMLElement, [imageFile('fusion.png')])
    await flush()
    ;(document.querySelector('[data-testid="new-task-create"]') as HTMLButtonElement).click()
    await flush(120)

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="new-task-panel"]')).toBeNull()
    // 新会话已打开（标题=单图文件名推导）。
    expect(document.querySelector('[data-testid="agent-stream-title"]')?.textContent).toContain('fusion.png')
  })

  it('composer 态点侧栏其他会话=直接切换（表单丢弃不保留草稿）', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const createSpy = vi.spyOn(api, 'createSession')
    bindAgentApi(api)
    await initAgentStore()
    mountAgentView()
    await flush()
    ;(document.querySelector('[data-testid="agent-new-session"]') as HTMLButtonElement).click()
    await flush()
    // 草稿：拖入一图（不提交）。
    dropFiles(document.querySelector('[data-testid="new-task-dropzone"]') as HTMLElement, [imageFile('draft.png')])
    await flush()
    expect(document.querySelectorAll('[data-testid="new-task-image-chips"] > span').length).toBe(1)

    sessionRowByTitle('星夜毛衣排钻').click()
    await flush()

    expect(createSpy).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="new-task-panel"]')).toBeNull()
    expect(document.querySelector('[data-testid="agent-stream-title"]')?.textContent).toContain('星夜毛衣排钻')
  })

  it('无会话空态：detail 位自动呈 composer+空列表引导+chat 列入口（zhumo「未选中=表单」）', async () => {
    // rpc 空列表桩（真实 daemon 新装形态——无会话）。
    const iso = new Date().toISOString()
    bindAgentApi({
      mode: 'rpc',
      connection: () => 'open',
      onConnectionChange: () => () => {},
      listSessions: async () => ({ sessions: [] }),
      getSession: async () => {
        throw new Error('不应打开会话')
      },
      replay: async () => ({ frames: [], nextSeq: 0 }),
      subscribeTask: () => () => {},
      sessionResult: async () => {
        throw new Error('无结果')
      },
    } as unknown as AgentApi)
    await initAgentStore()
    mountAgentView()
    await flush()

    expect(document.querySelector('[data-testid="agent-session-empty"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-pane-detail"] [data-testid="new-task-panel"]')).not.toBeNull()
    // chat 列空态入口在场（点击指向 detail 位 composer）。
    expect(document.querySelector('[data-testid="agent-no-session-new-task"]')).not.toBeNull()
  })
})
