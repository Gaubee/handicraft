/*
 * [add-subject-sam-pipeline P3.2-channel] 策略工件真实通道测试（帧→拉取→装配→视图数据）。
 * 通道 stub 注入（mock rpc 层）：帧组+字节读面按用例构造——RpcStrategyArtifacts 装配链
 * （引用齐备判定/JSON parse+schema 守门/free-code 工件/预览与原图 dataUrl/两态降级）
 * 在 jsdom 全程走真实现；mock provider（MockStrategyArtifacts）保留为测试替身的
 * 行为面在 store.test.ts。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Frame, TaskArtifactInput, TaskArtifactOutput } from '@handicraft/contracts'
import StrategyDesignerView from '$lib/components/strategy/StrategyDesignerView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { bindAgentApi, initAgentStore, openSession, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import {
  MockStrategyArtifacts,
  STRATEGY_FIXTURE_BLOB_REFS,
  STRATEGY_FIXTURE_CODE_ARTIFACT,
  STRATEGY_FIXTURE_GEMS,
  STRATEGY_FIXTURE_PLAN,
  STRATEGY_FIXTURE_TREE,
} from '$lib/strategyDesigner/fixtures'
import {
  parseAttachmentAnnotation,
  RpcStrategyArtifacts,
  sourceImageRefOf,
  type StrategyArtifactChannel,
} from '$lib/strategyDesigner/artifacts-provider'
import {
  bindStrategyArtifactsProvider,
  getStrategyArtifacts,
  getStrategyLoadError,
  resetStrategyDesignerForTests,
  syncStrategyArtifacts,
} from '$lib/strategyDesigner/store.svelte'
import { resetComposerOutboxForTests } from '$lib/agentApi/composerOutbox.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

const flush = async (ms = 10): Promise<void> => {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉（view.mount.test 同式）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

/** UTF-8 安全 JSON 工件字节（stub 通道用）。 */
function jsonArtifact(name: string, value: unknown): TaskArtifactOutput {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { name, mime: 'application/json', dataBase64: btoa(binary) }
}

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function pngArtifact(name: string): TaskArtifactOutput {
  return { name, mime: 'image/png', dataBase64: PNG_1X1 }
}

/** 附件注记（kernel followup prompt 注入形态——rpc.test/内核 sessions.ts 同源）。 */
const ATTACHMENT_REF = 'f'.repeat(64)

function artifactFrame(seq: number, name: string, blobRef: string): Frame {
  return { seq, ts: Date.now(), kind: 'artifact', payload: { name, blobRef } }
}

function userFrame(seq: number, text: string): Frame {
  return { seq, ts: Date.now(), kind: 'transcript', payload: { role: 'user', text } }
}

/** stub 通道：完整 willow 工件字节 + 可选附件图字节；read 调用可观测。 */
function stubChannel(options: { withAttachment?: boolean } = {}): StrategyArtifactChannel & {
  reads: TaskArtifactInput[]
} {
  const reads: TaskArtifactInput[] = []
  return {
    reads,
    read: {
      async taskArtifact(input): Promise<TaskArtifactOutput> {
        reads.push(input)
        const map = new Map<string, TaskArtifactOutput>([
          [STRATEGY_FIXTURE_BLOB_REFS.treeJson, jsonArtifact('object-tree.json', STRATEGY_FIXTURE_TREE)],
          [STRATEGY_FIXTURE_BLOB_REFS.planJson, jsonArtifact('strategy-plan.json', STRATEGY_FIXTURE_PLAN)],
          [STRATEGY_FIXTURE_BLOB_REFS.gemsJson, jsonArtifact('strategy-gems.json', STRATEGY_FIXTURE_GEMS)],
          [STRATEGY_FIXTURE_BLOB_REFS.codeArtifact, jsonArtifact('free-code-artifact.json', STRATEGY_FIXTURE_CODE_ARTIFACT)],
          [STRATEGY_FIXTURE_BLOB_REFS.treePreview, pngArtifact('object-tree-preview.png')],
          [STRATEGY_FIXTURE_BLOB_REFS.gemsPreview, pngArtifact('strategy-gems-preview.png')],
          ...(options.withAttachment ? [[ATTACHMENT_REF, pngArtifact('attachment-ffffffffff.png')]] : []),
        ] as Array<[string, TaskArtifactOutput]>)
        const hit = map.get(input.blobRef ?? '')
        if (hit === undefined) throw new Error(`工件不存在（stub 引用集外）：${input.blobRef ?? input.name}`)
        return hit
      },
    },
    framesByTask: () => [
      {
        taskId: 'fixt-task-willow-1',
        frames: [
          userFrame(1, '这是 5×5cm 的柳树装饰画：柳树按枝条贴'),
          artifactFrame(2, 'object-tree.json', STRATEGY_FIXTURE_BLOB_REFS.treeJson),
          artifactFrame(3, 'object-tree-preview.png', STRATEGY_FIXTURE_BLOB_REFS.treePreview),
          artifactFrame(4, 'strategy-plan.json', STRATEGY_FIXTURE_BLOB_REFS.planJson),
          artifactFrame(5, 'strategy-gems.json', STRATEGY_FIXTURE_BLOB_REFS.gemsJson),
          artifactFrame(6, 'strategy-gems-preview.png', STRATEGY_FIXTURE_BLOB_REFS.gemsPreview),
          ...(options.withAttachment
            ? [
                userFrame(
                  7,
                  `重贴一次\n[附件 1 个：${ATTACHMENT_REF}（W4.1 文本面投影；物料桥归 W4.2）]`,
                ),
              ]
            : []),
        ],
      },
    ],
  }
}

/** 真通道 refs（与 stub 帧一致——agentApi mock willow 帧源同 refs）。 */
const REAL_REFS = {
  tree: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.treeJson, taskId: 'fixt-task-willow-1' },
  treePreview: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.treePreview, taskId: 'fixt-task-willow-1' },
  plan: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.planJson, taskId: 'fixt-task-willow-1' },
  gems: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsJson, taskId: 'fixt-task-willow-1' },
  gemsPreview: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsPreview, taskId: 'fixt-task-willow-1' },
} as const

beforeEach(async () => {
  resetAgentStoreForTests()
  resetStrategyDesignerForTests()
  resetComposerOutboxForTests()
  resetToastsForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  // 先完成 store 初始化（默认开 heart）——视图 onMount 的 initAgentStore 幂等直通，
  // 不把测试已切换的 willow 会话切回默认会话（view.mount.test 同式）。
  await initAgentStore()
})

afterEach(() => {
  resetAgentStoreForTests()
  resetStrategyDesignerForTests()
  resetComposerOutboxForTests()
  resetToastsForTests()
})

describe('附件注记解析（原图输入引用——kernel prompt 文本面投影）', () => {
  it('单/多附件注记 → blobRef 集按序；非注记文本零命中', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(parseAttachmentAnnotation(`文本\n[附件 2 个：${a}, ${b}（W4.1 文本面投影；物料桥归 W4.2）]`)).toEqual([a, b])
    expect(parseAttachmentAnnotation(`[附件 1 个：${a}（W4.1 文本面投影；物料桥归 W4.2）]`)).toEqual([a])
    expect(parseAttachmentAnnotation('无注记的用户文本')).toEqual([])
  })

  it('sourceImageRefOf：取最新一帧用户注记的首个附件（taskId 随帧）', () => {
    const a = 'a'.repeat(64)
    const c = 'c'.repeat(64)
    const channel = stubChannel()
    const ref = sourceImageRefOf({
      ...channel,
      framesByTask: () => [
        { taskId: 't1', frames: [userFrame(1, `[附件 1 个：${a}（W4.1 文本面投影；物料桥归 W4.2）]`)] },
        { taskId: 't2', frames: [userFrame(2, `[附件 1 个：${c}（W4.1 文本面投影；物料桥归 W4.2）]`)] },
      ],
    })
    expect(ref).toEqual({ taskId: 't2', blobRef: c })
    expect(sourceImageRefOf(stubChannel())).toBeNull() // 无注记 → null
  })
})

describe('RpcStrategyArtifacts 装配链（帧→拉取→schema 守门→bundle）', () => {
  it('引用齐备：三 JSON 工件 parse 守门+free-code 工件挂载+预览 dataUrl；read 带 taskId 溯源', async () => {
    const channel = stubChannel()
    const bundle = await new RpcStrategyArtifacts(channel).load({ ...REAL_REFS })
    expect(bundle).not.toBeNull()
    expect(bundle!.tree.nodes).toHaveLength(6)
    expect(bundle!.plan.assignments).toHaveLength(4)
    expect(bundle!.gems.gems).toHaveLength(19)
    expect(bundle!.codeArtifacts[STRATEGY_FIXTURE_BLOB_REFS.codeArtifact]?.entryPoint).toBe('layout')
    expect(bundle!.treePreviewUrl).toBe(`data:image/png;base64,${PNG_1X1}`)
    expect(bundle!.gemsPreviewUrl).toBe(`data:image/png;base64,${PNG_1X1}`)
    expect(bundle!.sourceImageUrl).toBeNull() // 无附件注记——原图两态之一
    // 全部拉取经 {taskId, blobRef} 成对入参（tasks.artifact RPC 形态）
    expect(channel.reads.length).toBeGreaterThanOrEqual(6)
    expect(channel.reads.every((input) => input.taskId === 'fixt-task-willow-1' && input.blobRef !== undefined)).toBe(true)
  })

  it('原图有图端态：最新附件注记 → 附件 blob 拉取 → dataUrl（附件通道同源）', async () => {
    const channel = stubChannel({ withAttachment: true })
    const bundle = await new RpcStrategyArtifacts(channel).load({ ...REAL_REFS })
    expect(bundle!.sourceImageUrl).toBe(`data:image/png;base64,${PNG_1X1}`)
    expect(channel.reads).toContainEqual({ taskId: 'fixt-task-willow-1', blobRef: ATTACHMENT_REF })
  })

  it('三工件引用任一缺席 → null（旅程未到位，零拉取）', async () => {
    const channel = stubChannel()
    const provider = new RpcStrategyArtifacts(channel)
    expect(await provider.load({ ...REAL_REFS, gems: null })).toBeNull()
    expect(await provider.load({ ...REAL_REFS, plan: null, tree: null, gems: null })).toBeNull()
    expect(channel.reads).toHaveLength(0)
  })

  it('装配失败显式降级：工件字节非 schema 形 → throw 带工件名（store 记 loadError）', async () => {
    const bad = stubChannel()
    bad.read.taskArtifact = async (input) =>
      input.blobRef === STRATEGY_FIXTURE_BLOB_REFS.gemsJson
        ? jsonArtifact('strategy-gems.json', { kind: 'strategy-gems', nope: true })
        : (await stubChannel().read.taskArtifact(input)) as TaskArtifactOutput
    await expect(new RpcStrategyArtifacts(bad).load({ ...REAL_REFS })).rejects.toThrow(/strategy-gems/)

    // store 面：loadError 显式注记（非静默空态）
    bindStrategyArtifactsProvider(new RpcStrategyArtifacts(bad))
    await openSession('fixt-session-willow')
    syncStrategyArtifacts()
    await flush(30)
    expect(getStrategyArtifacts()).toBeNull()
    expect(getStrategyLoadError()).toMatch(/strategy-gems/)
  })

  it('拉取失败（工件 404 形态）→ throw；预览/原图失败非致命（位 null 不拖垮装配）', async () => {
    const broken = stubChannel()
    broken.read.taskArtifact = async (input) => {
      if (input.blobRef === STRATEGY_FIXTURE_BLOB_REFS.planJson) throw new Error('NOT_FOUND: 工件不存在')
      return stubChannel().read.taskArtifact(input)
    }
    await expect(new RpcStrategyArtifacts(broken).load({ ...REAL_REFS })).rejects.toThrow(/plan/)

    // 预览+原图失败非致命：三结构化工件可拉、gems 预览/附件 404 → 装配成功且位 null
    const previewBroken = stubChannel({ withAttachment: true })
    previewBroken.read.taskArtifact = async (input) => {
      if (input.blobRef === STRATEGY_FIXTURE_BLOB_REFS.gemsPreview || input.blobRef === ATTACHMENT_REF) {
        throw new Error('NOT_FOUND')
      }
      return stubChannel({ withAttachment: true }).read.taskArtifact(input)
    }
    const bundle = await new RpcStrategyArtifacts(previewBroken).load({ ...REAL_REFS })
    expect(bundle).not.toBeNull()
    expect(bundle!.gemsPreviewUrl).toBeNull()
    expect(bundle!.sourceImageUrl).toBeNull()
    expect(bundle!.treePreviewUrl).toBe(`data:image/png;base64,${PNG_1X1}`) // 未失败的预览照常
  })
})

describe('默认 provider=真实通道（P3.2 反转）——mock agentApi 字节面全链', () => {
  it('reset 后缺省即 RpcStrategyArtifacts：willow 会话经 MockAgentApi.taskArtifact 拉真实 fixture 字节装配', async () => {
    await openSession('fixt-session-willow')
    syncStrategyArtifacts()
    await flush(30)
    const bundle = getStrategyArtifacts()
    expect(bundle).not.toBeNull()
    expect(bundle!.tree.nodes).toHaveLength(6)
    expect(bundle!.plan.assignments).toHaveLength(4)
    expect(bundle!.gems.gems).toHaveLength(19)
    expect(bundle!.codeArtifacts[STRATEGY_FIXTURE_BLOB_REFS.codeArtifact]?.declaredApiCalls).toContain('sandbox.geo.resampleOpen')
    expect(bundle!.treePreviewUrl).toMatch(/^data:image\/png;base64,/)
    expect(bundle!.gemsPreviewUrl).toMatch(/^data:image\/png;base64,/)
    expect(bundle!.sourceImageUrl).toBeNull() // mock willow 帧无附件注记
  })

  it('mock provider 保留测试替身：bind 后同链装载（sourceImageUrl 注入位）', async () => {
    bindStrategyArtifactsProvider(new MockStrategyArtifacts({ sourceImageUrl: 'data:image/png;base64,xx' }))
    await openSession('fixt-session-willow')
    syncStrategyArtifacts()
    await flush(30)
    expect(getStrategyArtifacts()?.sourceImageUrl).toBe('data:image/png;base64,xx')
  })
})

describe('视图两端态（原图叠加——jsdom 全链：帧→拉取→装配→视图数据）', () => {
  function mountView(): () => void {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const view = mount(StrategyDesignerView, { target, props: {} })
    return () => {
      unmount(view)
      target.remove()
    }
  }

  it('有图端态：附件注记帧+附件字节 → 原图 image 层渲染+透明度滑杆在', async () => {
    bindStrategyArtifactsProvider(new RpcStrategyArtifacts(stubChannel({ withAttachment: true })))
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await flush(60)

    const image = document.querySelector('[data-testid="strategy-base-image"]')
    expect(image).not.toBeNull()
    expect(image!.getAttribute('href')).toBe(`data:image/png;base64,${PNG_1X1}`)
    expect(document.querySelector('[data-testid="strategy-base-missing"]')).toBeNull()
    expect(document.querySelector('[data-testid="strategy-base-opacity"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-testid="strategy-gem"]')).toHaveLength(19)
    dispose()
  })

  it('无图端态：无附件注记 → 降级注记+开关禁用（既有形态保持）', async () => {
    bindStrategyArtifactsProvider(new RpcStrategyArtifacts(stubChannel()))
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await flush(60)

    expect(document.querySelector('[data-testid="strategy-base-missing"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="strategy-base-image"]')).toBeNull()
    const toggle = document.querySelector('[data-testid="strategy-base-toggle"]') as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    dispose()
  })
})
