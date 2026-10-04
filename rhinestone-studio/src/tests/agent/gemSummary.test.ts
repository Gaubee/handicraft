/*
 * [product-polish-w1 T1/T2/T3] 报价闭环回归（N1：总钻数一眼可见——不藏进导出件）。
 * 覆盖三层：
 *   [1] 纯函数面：taskLayoutRefsOfFrames（帧流 latest-by-name/多 imageId/非 layout 忽略）
 *       + summarizeTaskLayout（实排颗数/去重款数/排序/palette 缺席回退/同款跨规格合并）。
 *   [2] 读面：taskGemSummaries（task-layout 帧 → taskArtifact 字节 → 聚合就绪；
 *       损坏/抛错 → null 隐藏；内容寻址缓存同 ref 单飞）。
 *   [3] 组件面：T1 done 卡总钻数行（SessionStream）；T2 面板徽标+chips 折叠
 *       （top 5+「+K 款」）；T3 口径注释 title；running「排钻中…」占位；
 *       mock heart fixture 全链（jsonArtifact UTF-8 base64 解码）。
 * 测试注入本地 stub AgentApi（taskArtifact 字节面可控——mock 固定 fixture 无多态任务）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import { mount, tick, unmount, type Component } from 'svelte'
import { TaskLayoutSchema, type Frame, type TaskLayout } from '@handicraft/contracts'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import TaskDetailPanel from '$lib/components/agent/TaskDetailPanel.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import {
  bindAgentApi,
  getActiveSessionTaskFrames,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import {
  GEM_COUNT_CALIBER_TITLE,
  resetGemSummaryForTests,
  stoneTextureUrl,
  summarizeTaskLayout,
  taskGemSummaries,
  taskLayoutRefsOfFrames,
  taskLayoutRefsOfTaskGroups,
} from '$lib/agentApi/gemSummary.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { FIXTURE_TASK_LAYOUT } from '$lib/agentApi/fixtures'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/components/studio/taskWorkbench/store.svelte'

// jsdom 未实现 scrollIntoView（转录流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

// ---------------------------------------------------------------- 纯函数面

const LAYOUT_REF_A = 'a'.repeat(64)
const LAYOUT_REF_B = 'b'.repeat(64)

const artifactFrame = (seq: number, ts: number, name: string, blobRef: string): Frame => ({
  seq,
  ts,
  kind: 'artifact',
  payload: { name, blobRef },
})

describe('纯函数面：帧流引用解析 + 实排聚合', () => {
  it('taskLayoutRefsOfFrames：latest-by-name（同 imageId 取最后帧）+多图逐图+非 layout 工件忽略', () => {
    const frames: Frame[] = [
      artifactFrame(1, 1, 'strategy-plan.json', '0'.repeat(64)),
      artifactFrame(2, 2, 'task-layout.image-1.json', LAYOUT_REF_A),
      artifactFrame(3, 3, 'task-layout.image-2.json', LAYOUT_REF_B),
      { seq: 4, ts: 4, kind: 'transcript', payload: { role: 'assistant', text: '重排完成' } },
      artifactFrame(5, 5, 'task-layout.image-1.json', LAYOUT_REF_B), // image-1 重排——后见覆盖
      { seq: 6, ts: 6, kind: 'done', payload: {} },
    ]
    expect(taskLayoutRefsOfFrames(frames)).toEqual([
      { imageId: 'image-1', blobRef: LAYOUT_REF_B },
      { imageId: 'image-2', blobRef: LAYOUT_REF_B },
    ])
    // 无 layout 帧=空（组件隐藏数字）
    expect(taskLayoutRefsOfFrames([{ seq: 1, ts: 1, kind: 'done', payload: {} }])).toEqual([])
  })

  it('taskLayoutRefsOfTaskGroups（w20 major-2）：跨任务会话域 latest（后任务覆盖）+sourceTaskId 归档；全无 layout=空', () => {
    const groups: Array<{ taskId: string; frames: Frame[] }> = [
      {
        taskId: 'task-pave-1',
        frames: [
          artifactFrame(1, 1, 'strategy-plan.json', '0'.repeat(64)),
          artifactFrame(2, 2, 'task-layout.image-1.json', LAYOUT_REF_A),
        ],
      },
      {
        // 导出任务：无 layout 帧（走查 56f91a4b 同型——task-export.* 不匹配前缀）
        taskId: 'task-export',
        frames: [
          artifactFrame(1, 10, 'task-export.image-1.png', '1'.repeat(64)),
          { seq: 2, ts: 11, kind: 'done', payload: {} },
        ],
      },
      {
        // 后续重排任务：image-1 新 layout——后见覆盖前任务引用
        taskId: 'task-pave-2',
        frames: [artifactFrame(1, 20, 'task-layout.image-1.json', LAYOUT_REF_B)],
      },
    ]
    expect(taskLayoutRefsOfTaskGroups(groups)).toEqual([
      { imageId: 'image-1', blobRef: LAYOUT_REF_B, sourceTaskId: 'task-pave-2' },
    ])
    // 识图会话（全无 layout）=空——组件隐藏数字，空态不占位
    expect(
      taskLayoutRefsOfTaskGroups([
        { taskId: 'task-analysis', frames: [artifactFrame(1, 1, 'scene-analysis.json', '2'.repeat(64))] },
      ]),
    ).toEqual([])
  })

  it('summarizeTaskLayout：总颗数=实排 gems 数；款数=去重 stoneRef；颗数降序；同款跨规格合并计颗', () => {
    // stn-j51-red：8 颗 3mm + 3 颗 2mm（同款第二规格——款数不增、颗数合并=11）
    const j51SecondSpec = FIXTURE_TASK_LAYOUT.gems.slice(8, 11).map((gem, i) => ({
      ...gem,
      id: `g-j51-2mm-${String(i + 1).padStart(3, '0')}`,
      stoneRef: 'stn-j51-red',
      sku: 'J51',
      colorHex: '#C8102E',
      diameterMm: 2,
      blockId: 'blk-heart-body',
    }))
    const layout = TaskLayoutSchema.parse({
      ...FIXTURE_TASK_LAYOUT,
      gems: [
        ...FIXTURE_TASK_LAYOUT.gems.slice(0, 8), // stn-j51-red ×8（3mm）
        ...j51SecondSpec, // stn-j51-red ×3（2mm）
        ...FIXTURE_TASK_LAYOUT.gems.slice(8), // stn-r12-rose ×4
      ],
    })
    const summary = summarizeTaskLayout('image-1', layout)
    expect(summary.totalGems).toBe(15)
    expect(summary.stoneKindCount).toBe(2)
    expect(summary.stones[0]).toMatchObject({ stoneRef: 'stn-j51-red', count: 11, sku: 'J51', name: '正红' })
    expect(summary.stones[1]).toMatchObject({ stoneRef: 'stn-r12-rose', count: 4 })
  })

  it('summarizeTaskLayout：palette 缺席 → name 回退 supplier/sku（daemon buildTaskBom 同式）', () => {
    const layout = TaskLayoutSchema.parse({
      ...FIXTURE_TASK_LAYOUT,
      palette: {},
    })
    const summary = summarizeTaskLayout('image-1', layout)
    expect(summary.stones[0]?.name).toBe('yuhang/J51')
  })

  it('stoneTextureUrl：img 通道查询参数鉴权（token 在场）+stoneRef 路径编码', () => {
    const url = stoneTextureUrl('stn j51/red')
    expect(url).toContain('/api/stones/stn%20j51%2Fred/texture.png')
    expect(url).not.toContain('token=') // jsdom 测试环境无存储 token——无参原样（401 由组件兜底）
  })
})

// ---------------------------------------------------------------- stub AgentApi（字节面可控）

const TASK = 'gem-task-1'
const SESSION = 'gem-session'

const ts = Date.parse('2026-10-01T10:00:00.000Z')

/** 心形 fixture 的可控变体（stones 款数可扩——折叠态测试用 7 款各 1 颗）。 */
function layoutOf(stoneCount: number): TaskLayout {
  const gems = Array.from({ length: stoneCount }, (_, i) => ({
    id: `g-k${i}`,
    x: 10 + (i % 10) * 10,
    y: 10 + Math.floor(i / 10) * 10,
    blockId: 'blk-heart-body',
    shapeId: 'round',
    diameterMm: 3,
    stoneRef: `stn-k${i}`,
    sku: `K${i}`,
    supplier: 'yuhang',
    colorHex: '#C8102E',
  }))
  return TaskLayoutSchema.parse({
    ...FIXTURE_TASK_LAYOUT,
    palette: Object.fromEntries(gems.map((gem) => [gem.stoneRef, { name: `款${gem.sku}`, hex: '#C8102E' }])),
    gems,
  })
}

function jsonArtifactOf(value: unknown): { name: string; mime: string; dataBase64: string } {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { name: 'task-layout.image-1.json', mime: 'application/json', dataBase64: btoa(binary) }
}

interface StubOptions {
  frames: Frame[]
  status?: 'done' | 'running' | 'queued'
  /** blobRef → 工件输出（缺省=layout fixture 字节）。 */
  artifactOf?: (blobRef: string) => { name: string; mime: string; dataBase64: string } | null
  /**
   * 会话任务组（w20 走查 major-2 多任务会话——缺省单任务 [TASK]；末位=activeTask
   * =面板任务）。帧缺省继承 options.frames，状态缺省继承 options.status。
   */
  tasks?: Array<{ taskId: string; status?: 'done' | 'running' | 'queued'; frames?: Frame[] }>
  /** taskArtifact 入参观察面（sourceTaskId 归档断言）。 */
  onArtifact?: (input: { taskId: string; blobRef?: string; name?: string }) => void
}

function stubApi(options: StubOptions): AgentApi {
  const unimplemented = (name: string): never => {
    throw new Error(`stub 未实现：${name}`)
  }
  const summary = {
    id: SESSION,
    title: '报价闭环会话',
    status: 'active' as const,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T10:05:00.000Z',
  }
  const status = options.status ?? 'done'
  const taskList =
    options.tasks !== undefined
      ? options.tasks
      : [{ taskId: TASK, status: status as 'done' | 'running' | 'queued', frames: options.frames }]
  const framesOf = (taskId: string): Frame[] =>
    taskList.find((task) => task.taskId === taskId)?.frames ?? options.frames
  return {
  setAutoApprove: async () => ({ ok: true, autoApprove: false }),
    mode: 'mock',
    connection: () => 'mock',
    onConnectionChange: (listener) => {
      listener('mock')
      return () => {}
    },
    listSessions: async () => ({ sessions: [summary] }),
    createSession: async () => unimplemented('createSession'),
    getSession: async () => ({
      session: summary,
      tasks: taskList.map((task) => ({
        taskId: task.taskId,
        status: task.status ?? status,
        lastSeq: (task.frames ?? options.frames).length,
        frameCount: (task.frames ?? options.frames).length,
      })),
    }),
    followup: async () => unimplemented('followup'),
    stopTask: async () => unimplemented('stopTask'),
    answer: async () => ({ ok: true }),
    renameSession: async () => {
      throw new Error('本测试不触达')
    },
    cancel: async () => ({ ok: true }),
    clear: async () => ({ ok: true, status: 'cleared' }),
    replay: async (_sessionId: string, taskId: string) => ({
      frames: taskList.some((task) => task.taskId === taskId) ? framesOf(taskId) : [],
      nextSeq: framesOf(taskId).length + 1,
    }),
    sessionResult: async () => unimplemented('sessionResult'),
    taskResult: async () => unimplemented('taskResult'),
    taskArtifact: async (input: { taskId: string; blobRef?: string; name?: string }) => {
      options.onArtifact?.(input)
      if (options.artifactOf !== undefined) {
        const out = options.artifactOf(input.blobRef ?? '')
        if (out === null) throw new Error('工件不存在（stub）')
        return out
      }
      return jsonArtifactOf(FIXTURE_TASK_LAYOUT)
    },
    subscribeTask: () => () => {},
    // 嵌入工作台的 taskDetail 通道 stub 不可用（loadWorkbench catch → 工作台错误态）——
    // 本测试组只消费帧流+taskArtifact 读面，错误态由 agentDetailLayout 独立覆盖。
    taskDetail: async () => unimplemented('taskDetail'),
    layerSplit: async () => unimplemented('layerSplit'),
    layerRename: async () => unimplemented('layerRename'),
    layerStrategySet: async () => unimplemented('layerStrategySet'),
    treeHistory: async () => unimplemented('treeHistory'),
    layerMaskPatch: async () => unimplemented('layerMaskPatch'),
    viewStateSet: async () => unimplemented('viewStateSet'),
    taskExport: async () => unimplemented('taskExport'),
    layerReorder: async () => unimplemented('layerReorder'),
    layerDelete: async () => unimplemented('layerDelete'),
    treeRevert: async () => unimplemented('treeRevert'),
    maskEditRetry: async () => unimplemented('maskEditRetry'),
    taskReferenceRegenerate: async () => unimplemented('taskReferenceRegenerate'),
    taskReferenceDisable: async () => unimplemented('taskReferenceDisable'),
    taskReferenceEnable: async () => unimplemented('taskReferenceEnable'),
    maskEditDiscard: async () => unimplemented('maskEditDiscard'),
  }
}

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

const flush = async (ms = 20): Promise<void> => {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
  if (!condition()) throw new Error(`waitUntil 超时（${ms}ms）：条件未满足`)
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}
function qq(selector: string): Element[] {
  return [...document.querySelectorAll(selector)]
}

beforeEach(() => {
  resetAgentStoreForTests()
  resetSessionRouteForTests('')
  resetGemSummaryForTests()
  resetWorkbenchForTests()
  resetViewForTests()
  resetToastsForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  resetAgentStoreForTests()
  resetGemSummaryForTests()
  resetWorkbenchForTests()
  resetViewForTests()
  resetToastsForTests()
})

// ---------------------------------------------------------------- 读面（反应式缓存）

describe('读面：taskGemSummaries（task-layout 帧 → taskArtifact → 聚合）', () => {
  it('帧引用 → 字节拉回 → 摘要就绪；内容寻址缓存同 ref 单飞', async () => {
    let fetches = 0
    bindAgentApi(
      stubApi({
        frames: [],
        artifactOf: (blobRef) => {
          fetches += 1
          return jsonArtifactOf(FIXTURE_TASK_LAYOUT)
        },
      }),
    )
    await initAgentStore()
    const refs = [{ imageId: 'image-1', blobRef: LAYOUT_REF_A }]
    // 首读：拉取中=null；落定后=摘要（12 颗·2 款——heart fixture）
    expect(taskGemSummaries(TASK, refs)).toEqual([null])
    await waitUntil(() => taskGemSummaries(TASK, refs)[0] !== null)
    const summary = taskGemSummaries(TASK, refs)[0]!
    expect(summary.totalGems).toBe(12)
    expect(summary.stoneKindCount).toBe(2)
    expect(summary.imageId).toBe('image-1')
    // 再读同 ref：缓存命中不重拉（单飞+内容寻址）
    taskGemSummaries(TASK, refs)
    taskGemSummaries(TASK, refs)
    await flush()
    expect(fetches).toBe(1)
  })

  it('损坏 JSON / 拉取抛错 → null（隐藏数字，不占错误面；失败不重试）', async () => {
    let fetches = 0
    bindAgentApi(
      stubApi({
        frames: [],
        artifactOf: () => {
          fetches += 1
          return { name: 'x', mime: 'application/json', dataBase64: btoa('{"kind":"不是 layout"}') }
        },
      }),
    )
    await initAgentStore()
    // 契约不符（safeParse 拒）→ 落 null；fetch 完成后保持 null（非 loading 态的缺席）
    const bad = [{ imageId: 'image-1', blobRef: 'c'.repeat(64) }]
    taskGemSummaries(TASK, bad)
    await waitUntil(() => fetches === 1)
    await flush()
    expect(taskGemSummaries(TASK, bad)).toEqual([null])

    // 拉取抛错（工件缺席）→ 同样落 null；内容寻址下不重试同字节
    let thrownFetches = 0
    bindAgentApi(
      stubApi({
        frames: [],
        artifactOf: () => {
          thrownFetches += 1
          return null
        },
      }),
    )
    const thrown = [{ imageId: 'image-1', blobRef: 'd'.repeat(64) }]
    taskGemSummaries(TASK, thrown)
    await waitUntil(() => thrownFetches === 1)
    await flush()
    expect(taskGemSummaries(TASK, thrown)).toEqual([null])
    taskGemSummaries(TASK, thrown)
    await flush()
    expect(thrownFetches).toBe(1) // 失败落定不重拉
  })

  it('w20 major-2：sourceTaskId 归档——taskArtifact 按来源任务读回（面板任务 ≠ layout 来源任务）', async () => {
    const seenTaskIds: string[] = []
    bindAgentApi(
      stubApi({
        frames: [],
        onArtifact: (input) => {
          seenTaskIds.push(input.taskId)
        },
      }),
    )
    await initAgentStore()
    const refs = [{ imageId: 'image-1', blobRef: LAYOUT_REF_A, sourceTaskId: 'task-pave-1' }]
    expect(taskGemSummaries('task-export', refs)).toEqual([null])
    await waitUntil(() => taskGemSummaries('task-export', refs)[0] !== null)
    expect(seenTaskIds).toEqual(['task-pave-1']) // 合法引用集=来源任务帧流——不按面板任务请求
    // 缓存键按来源任务隔离：同 blobRef 换面板任务再读=缓存命中零新拉
    taskGemSummaries('task-export-2', refs)
    await flush()
    expect(seenTaskIds).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- 组件面

const baseFrames = (layoutBlobRef: string): Frame[] => [
  { seq: 1, ts, kind: 'transcript', payload: { role: 'user', text: '排满红色圆钻' } },
  artifactFrame(2, ts + 1000, 'task-layout.image-1.json', layoutBlobRef),
  { seq: 3, ts: ts + 2000, kind: 'done', payload: {} },
]

describe('T1：done 卡总钻数行（SessionStream）', () => {
  it('done 卡显示「共 N 颗 · M 款钻」+口径注释 title（N1：总数一眼可见）', async () => {
    bindAgentApi(stubApi({ frames: baseFrames(LAYOUT_REF_A) }))
    await initAgentStore()
    mountTracked(SessionStream, {})
    await waitUntil(() => q('[data-testid="frame-done-gems"]') !== null)
    const line = q('[data-testid="frame-done-gems"]')!
    expect(line.textContent).toContain('共 12 颗')
    expect(line.textContent).toContain('2 款钻')
    // T3：口径注释（颗数=实排/款数=用料——按当前布局统计）
    expect(line.getAttribute('title')).toBe(GEM_COUNT_CALIBER_TITLE)
    // done 卡入口仍在（归属语义不回归）
    expect(q('[data-testid="open-task-detail"]')).not.toBeNull()
  })

  it('无 task-layout 帧（策略未执行/生成器曾拒）→ done 卡不显数字（不硬编占位）', async () => {
    bindAgentApi(
      stubApi({
        frames: [
          { seq: 1, ts, kind: 'transcript', payload: { role: 'user', text: '只聊聊' } },
          { seq: 2, ts: ts + 500, kind: 'done', payload: {} },
        ],
      }),
    )
    await initAgentStore()
    mountTracked(SessionStream, {})
    await flush()
    expect(q('[data-testid="frame-done"]')).not.toBeNull()
    expect(q('[data-testid="frame-done-gems"]')).toBeNull()
  })
})

describe('T2/T3：TaskDetailPanel 头部徽标 + 款钻 chips', () => {
  it('徽标「N 颗 · M 款」+ chips（SKU+颗数+贴图 URL）——≤5 款无折叠', async () => {
    bindAgentApi(stubApi({ frames: baseFrames(LAYOUT_REF_A) }))
    await initAgentStore()
    mountTracked(TaskDetailPanel, { taskId: TASK })
    await waitUntil(() => q('[data-testid="task-detail-gem-badge"]') !== null)
    const badge = q('[data-testid="task-detail-gem-badge"]')!
    expect(badge.textContent).toContain('12 颗')
    expect(badge.textContent).toContain('2 款')
    expect(badge.getAttribute('title')).toBe(GEM_COUNT_CALIBER_TITLE)
    // chips：正红 J51 ×8（颗数降序首位）+玫红 R12 ×4；贴图缩略[fixture 边界]：
    // mock=hex 色卡 dataUrl（零 daemon 打点——修前 /api/stones/{虚拟ref} 越域 404）。
    const chips = qq('[data-testid="task-detail-gem-chip"]')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.textContent).toContain('J51')
    expect(chips[0]?.textContent).toContain('×8')
    const img = chips[0]?.querySelector('img')
    expect(img?.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true)
    expect(img?.getAttribute('src')).not.toContain('/api/stones/')
    expect(q('[data-testid="task-detail-gem-more"]')).toBeNull() // ≤5 款无折叠按钮
  })

  it('7 款 → top 5 chips +「+2 款」折叠展开（工件清单卡同款折叠形态）', async () => {
    // 7 款各 7..1 颗（stn-k0 ×7 … stn-k6 ×1）
    const layout = layoutOf(7)
    const ref7 = 'e'.repeat(64)
    bindAgentApi(stubApi({ frames: baseFrames(ref7), artifactOf: () => jsonArtifactOf(layout) }))
    await initAgentStore()
    mountTracked(TaskDetailPanel, { taskId: TASK })
    await waitUntil(() => qq('[data-testid="task-detail-gem-chip"]').length === 5)
    expect(q('[data-testid="task-detail-gem-badge"]')?.textContent).toContain('7 款')
    expect(qq('[data-testid="task-detail-gem-chip"]')).toHaveLength(5)
    const more = q('[data-testid="task-detail-gem-more"]') as HTMLButtonElement
    expect(more.textContent).toContain('+2 款')
    more.click()
    await waitUntil(() => qq('[data-testid="task-detail-gem-chip"]').length === 7)
    expect(q('[data-testid="task-detail-gem-more"]')?.textContent).toContain('收起')
  })

  it('running 任务（数字未定）→「排钻中…」占位，不硬编数字', async () => {
    bindAgentApi(
      stubApi({
        status: 'running',
        frames: [
          { seq: 1, ts, kind: 'transcript', payload: { role: 'user', text: '排钻中' } },
          { seq: 2, ts: ts + 1000, kind: 'progress', payload: { text: '排钻计算中', ratio: 0.4 } },
        ],
      }),
    )
    await initAgentStore()
    mountTracked(TaskDetailPanel, { taskId: TASK })
    await waitUntil(() => q('[data-testid="task-detail-gem-pending"]') !== null)
    expect(q('[data-testid="task-detail-gem-pending"]')?.textContent).toContain('排钻中…')
    expect(q('[data-testid="task-detail-gem-badge"]')).toBeNull()
    expect(q('[data-testid="task-detail-gem-chips"]')).toBeNull()
  })

  it('w20 major-2：会话域回退——面板落在无 layout 帧的导出任务，徽标/chips 取自早前排钻任务', async () => {
    const paveTask = 'task-pave-1'
    const exportTask = 'task-export'
    const artifactTaskIds: string[] = []
    bindAgentApi(
      stubApi({
        frames: [],
        onArtifact: (input) => {
          artifactTaskIds.push(input.taskId)
        },
        tasks: [
          { taskId: paveTask, status: 'done', frames: baseFrames(LAYOUT_REF_A) },
          {
            // 走查 55bc9e13 同型：导出任务=会话最新任务（activeTask），自身只有导出工件帧
            taskId: exportTask,
            status: 'done',
            frames: [
              artifactFrame(1, ts + 5000, 'task-export.image-1.png', '1'.repeat(64)),
              { seq: 2, ts: ts + 6000, kind: 'done', payload: {} },
            ],
          },
        ],
      }),
    )
    await initAgentStore()
    // 面板任务=会话最新（导出任务——AgentView activeTask 同口径）
    mountTracked(TaskDetailPanel, { taskId: exportTask })
    await waitUntil(() => q('[data-testid="task-detail-gem-badge"]') !== null)
    expect(q('[data-testid="task-detail-gem-badge"]')!.textContent).toContain('12 颗')
    expect(q('[data-testid="task-detail-gem-badge"]')!.textContent).toContain('2 款')
    expect(qq('[data-testid="task-detail-gem-chip"]')).toHaveLength(2)
    expect(q('[data-testid="task-detail-gem-pending"]')).toBeNull() // 终态无占位
    // 读回按来源任务归档（task-export 面板下 taskArtifact 全部打向 task-pave-1）
    expect(artifactTaskIds.length).toBeGreaterThan(0)
    expect(artifactTaskIds.every((taskId) => taskId === paveTask)).toBe(true)
  })

  it('w20 major-2：识图会话（全会话无 layout）→ 无徽标无 chips 无占位残留', async () => {
    bindAgentApi(
      stubApi({
        frames: [],
        tasks: [
          {
            taskId: 'task-analysis',
            status: 'done',
            frames: [
              artifactFrame(1, ts, 'intake-image.png', '2'.repeat(64)),
              artifactFrame(2, ts + 1000, 'scene-analysis.json', '3'.repeat(64)),
              { seq: 3, ts: ts + 2000, kind: 'done', payload: {} },
            ],
          },
        ],
      }),
    )
    await initAgentStore()
    mountTracked(TaskDetailPanel, { taskId: 'task-analysis' })
    await flush()
    expect(q('[data-testid="task-detail-gem-badge"]')).toBeNull()
    expect(q('[data-testid="task-detail-gem-chips"]')).toBeNull()
    expect(q('[data-testid="task-detail-gem-pending"]')).toBeNull()
  })

  it('w20 major-2：运行中重排钻任务不回退旧布局——「排钻中…」占位语义保留（stale 数字不显）', async () => {
    bindAgentApi(
      stubApi({
        frames: [],
        tasks: [
          { taskId: 'task-pave-1', status: 'done', frames: baseFrames(LAYOUT_REF_A) },
          {
            // 重排钻进行中：无自身 layout 帧——旧布局 12 颗不回显
            taskId: 'task-repave',
            status: 'running',
            frames: [
              { seq: 1, ts, kind: 'transcript', payload: { role: 'user', text: '改密一点' } },
              { seq: 2, ts: ts + 1000, kind: 'progress', payload: { text: '排钻计算中', ratio: 0.3 } },
            ],
          },
        ],
      }),
    )
    await initAgentStore()
    mountTracked(TaskDetailPanel, { taskId: 'task-repave' })
    await waitUntil(() => q('[data-testid="task-detail-gem-pending"]') !== null)
    expect(q('[data-testid="task-detail-gem-badge"]')).toBeNull()
    expect(q('[data-testid="task-detail-gem-chips"]')).toBeNull()
  })
})

// ---------------------------------------------------------------- mock 面全链

describe('mock heart fixture 全链（jsonArtifact UTF-8 base64 → done 卡数字）', () => {
  it('MockAgentApi heart 会话 → done 卡「共 12 颗 · 2 款钻」', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    // initAgentStore 打开最近会话=heart（createdAt 最新）
    expect(getActiveSessionTaskFrames().map((group) => group.taskId)).toContain('fixt-task-heart-1')
    mountTracked(SessionStream, {})
    await waitUntil(() => q('[data-testid="frame-done-gems"]') !== null)
    const line = q('[data-testid="frame-done-gems"]')!
    expect(line.textContent).toContain('共 12 颗')
    expect(line.textContent).toContain('2 款钻')
  })
})
