/**
 * [add-lab 4.3] lab store 任务模型 stage 化——接线层端到端（jsdom 桩 client）。
 *
 * 覆盖（tasks 4.3 vitest 口径）：
 * - startRun 快照物化：stages 树（main/blueprint·dependsOn 策略）+ pendingDrill →
 *   drillParams 快照（specKey→GemSpecSnapshot ordinal 序 + physical + materialAssetIds）
 *   + 【尺寸与钻规格】段进主图请求 + custom 规格素材附图；
 * - missing fail-fast：未知 specKey → main stage 中文错误列缺失清单，零生图请求；
 * - 单 stage 等价回归：不开高级选项 = 现状管线（提示词逐字节一致 + 账本 stages 形状）；
 * - 操作粒度：策略 B 串行自动派发蓝图 / 蓝图单独重试（requestId 不复用）/ cancelTask 级联 /
 *   retryTask 级联重置（skipped → pending）；
 * - 刷新中断恢复（R3 P0）：main success + blueprint running 刷新 → 「蓝图已中断，可重试」
 *   合成态 + 重试从 main.assetId 归档字节取输入（零重新生成）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTasks,
  hydrate,
  resetLabForTests,
  retryStage,
  retryTask,
  cancelTask,
  startRun,
  updateSettings,
  whenIdle,
} from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { resetAssetStoreForTests, runAssetMigration, ingestGemshapeFile } from '$lib/persistence/assetStore'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { loadTaskMetas, TASKS_KEY } from '$lib/persistence/taskStore'
import { BLUEPRINT_INTERRUPTED_ERROR, deriveBlueprintBadge, stageIdOf } from '$lib/lab/stages'
import { GEMSHAPE_SEEDS } from '$lib/engine'
import { composeDrillPrompt } from '$lib/presets/effectRefs'
import { EFFECT_PROMPT_PLACEHOLDERS } from '$lib/lab/prompt'
import { resetGalleryForTests } from '$lib/stores/gallery.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let objectUrlCounter = 0
/** 生图端点调用记录（url/init 捕获——附图序与提示词断言源）。 */
let imageCalls: Array<{ url: string; prompt: string; imageCount: number; imageNames: string[] }>
/** 生图回包行为（各测试可覆盖：默认成功 b64）。 */
let imageResponder: (call: { url: string; index: number }) => Promise<Response>
/** 成功回包图片字节序列号（每请求唯一，防内容寻址并辙）。 */
let b64Seq = 0

function okB64(): string {
  b64Seq += 1
  // 4 字节递增载荷（内容寻址互异）
  return btoa(String.fromCharCode(0x10 + b64Seq, 0x20 + b64Seq, 0x30 + b64Seq, 0x40 + b64Seq))
}

function okResponse(b64 = okB64()): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 生图端点 fetch 桩：记录 multipart（edits）prompt/image 数；JSON（generations）prompt。 */
function imagesFetchStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (url.startsWith('/presets/')) {
    const seed = [...url].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
    return Promise.resolve(
      new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    )
  }
  if (url.endsWith('/images/generations') || url.endsWith('/images/edits')) {
    let prompt = ''
    let imageNames: string[] = []
    if (init?.body instanceof FormData) {
      prompt = String(init.body.get('prompt') ?? '')
      imageNames = init.body.getAll('image').map((f) => (f instanceof File ? f.name : String(f)))
    } else if (typeof init?.body === 'string') {
      prompt = String(JSON.parse(init.body).prompt ?? '')
    }
    const index = imageCalls.length
    imageCalls.push({ url, prompt, imageCount: imageNames.length, imageNames })
    // 桩尊重 abort（runStage catch → cancel 事件依赖 AbortError 上浮）
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined
      const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort)
      }
      void imageResponder({ url, index }).then(resolve, reject)
    })
  }
  return Promise.resolve(
    new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  )
}

/** 首模板启用指定高级选项（其余模板禁用——聚焦单模板路径）。 */
async function configureFirstTemplate(options: {
  drill?: { specs: string[]; physical?: { widthMm: number; heightMm: number } }
  blueprint?: { refs?: string[] }
}): Promise<string> {
  const first = getTemplateAssetIds()[0]
  for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === first)
  submitTemplateField(first, { candidates: 1 }) // seed 模板默认 2 候选——聚焦单任务路径
  if (options.drill !== undefined) {
    submitTemplateField(first, {
      drillParams: {
        enabled: true,
        specs: options.drill.specs,
        ...(options.drill.physical !== undefined
          ? { physical: { ...options.drill.physical, anchorSource: 'declared' as const } }
          : {}),
      },
    })
    // [placeholders] 水钻正文经占位符注入（新语义唯一通道）——夹具补占位符进主提示词
    const body = getTemplateRecord(first)?.promptBody ?? ''
    if (!body.includes(EFFECT_PROMPT_PLACEHOLDERS.drillParams)) {
      submitTemplateField(first, {
        promptBody: body === '' ? EFFECT_PROMPT_PLACEHOLDERS.drillParams : `${body}\n${EFFECT_PROMPT_PLACEHOLDERS.drillParams}`,
      })
    }
  }
  if (options.blueprint !== undefined) {
    submitTemplateField(first, {
      blueprint: { enabled: true, ...(options.blueprint.refs !== undefined ? { refs: options.blueprint.refs } : {}) },
    })
    // 蓝图占位符不入主提示词（主图纯净性断言保持；占位符注入蓝图文案的行为归 prompt.placeholder.test）
  }
  await whenTemplatesIdle()
  return first
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  objectUrlCounter = 0
  imageCalls = []
  b64Seq = 0
  imageResponder = async () => okResponse()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  class OkImage {
    naturalWidth = 64
    naturalHeight = 64
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)
  vi.stubGlobal('fetch', imagesFetchStub)
  localStorage.clear()
  resetLabForTests()
  resetGalleryForTests()
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
  await runAssetMigration() // sys-shapes 目录 seed（gemCatalog 真源确定性前置）
  await hydrate()
})

afterEach(async () => {
  await whenTemplatesIdle().catch(() => undefined)
  vi.unstubAllGlobals()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// startRun 快照物化
// ---------------------------------------------------------------------------

describe('4.3 startRun 快照物化（stages 树 + drillParams）', () => {
  it('双开模板：stages=[main, blueprint(serial)]；blueprint dependsOn [main]；pendingDrill 携带模板 specKeys + blueprint 快照', async () => {
    await configureFirstTemplate({
      drill: { specs: ['round-ss10', 'round-ss16'], physical: { widthMm: 210, heightMm: 148 } },
      blueprint: { refs: ['ast-bpref-1'] },
    })
    const run = startRun()
    expect(run.ok).toBe(true)

    const task = getTasks()[0]
    expect(task.stages).toHaveLength(2)
    const [main, blueprint] = task.stages!
    expect(main.kind).toBe('main')
    expect(main.status).toBe('running') // startRun 内 pump 同步派发（现状行为一致）
    expect(main.dependsOn).toEqual([])
    expect(blueprint.kind).toBe('blueprint')
    expect(blueprint.status).toBe('pending') // 串行依赖未满足——schedulable 不派发
    expect(blueprint.dependsOn).toEqual([main.id])
    expect(blueprint.id).toBe(stageIdOf(task.id, 'blueprint'))
    // 模板配置克隆（物化前的待物化形态）+ 蓝图任务级快照
    expect(task.pendingDrill).toEqual({
      specs: ['round-ss10', 'round-ss16'],
      physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
    })
    expect(task.blueprint).toEqual({ strategy: 'serial', refs: ['ast-bpref-1'] })
    await whenIdle()
  })

  it('内置规格物化：drillParams.specs = GemSpecSnapshot（ordinal 1..n 数组序）+ physical + materialAssetIds 空（内置形纯描述）；【尺寸与钻规格】段进主图请求', async () => {
    await configureFirstTemplate({
      drill: { specs: ['round-ss10', 'round-ss16'], physical: { widthMm: 210, heightMm: 148 } },
    })
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    expect(task.drillParams).toBeDefined()
    expect(task.drillParams!.specs.map((s) => s.specKey)).toEqual(['round-ss10', 'round-ss16'])
    expect(task.drillParams!.specs.map((s) => s.ordinal)).toEqual([1, 2])
    expect(task.drillParams!.specs[0]).toMatchObject({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 })
    expect(task.drillParams!.physical).toEqual({ widthMm: 210, heightMm: 148, anchorSource: 'declared' })
    expect(task.drillParams!.materialAssetIds).toEqual([]) // 内置形不附图（§2.3）

    const main = task.stages!.find((s) => s.kind === 'main')!
    expect(main.status).toBe('success')
    const request = imageCalls[0]
    expect(request.prompt).toContain('【尺寸与钻规格】')
    expect(request.prompt).toContain('画幅物理尺寸 210×148mm。图宽对应 1024px：1mm ≈ 4.9px')
    expect(request.prompt).toContain('1 = R10 圆形 SS10（直径 2.8mm）')
    expect(request.prompt).toContain('2 = R16 圆形 SS16（直径 4mm）')
  })

  it('custom 规格素材附图：materialAssetIds=[assetId]；请求附图 = [案例, 素材贴图]；清单行交叉引用图号', async () => {
    const seedTexture = GEMSHAPE_SEEDS[0].texture
    const text = JSON.stringify({
      kind: 'gemshape',
      formatVersion: 1,
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '星星钻',
      texture: seedTexture,
      physical: { widthMm: 5, heightMm: 5 },
      calibration: { mode: 'direct' },
    })
    const { node } = await ingestGemshapeFile(new Blob([text], { type: PROJECT_MIME.gemshape }), {
      name: '星星钻',
      decode: async (dataUrl) => {
        const seed = GEMSHAPE_SEEDS.find((s) => s.texture.dataUrl === dataUrl)!
        const data = new Uint8ClampedArray(seed.texture.width * seed.texture.height * 4)
        for (let i = 3; i < data.length; i += 4) data[i] = 255
        return { width: seed.texture.width, height: seed.texture.height, data }
      },
    })
    const specKey = `custom-${node.id}`
    await configureFirstTemplate({ drill: { specs: ['round-ss10', specKey], physical: { widthMm: 210, heightMm: 148 } } })
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    expect(task.drillParams!.materialAssetIds).toEqual([node.id])
    const customSpec = task.drillParams!.specs[1]
    expect(customSpec.shapeId).toBe('custom')
    expect(customSpec.assetId).toBe(node.id)
    // 请求：edits 端点（案例绑定 seed 模板恒 edit）；附图 [案例合成图, 钻石素材图]
    const request = imageCalls[0]
    expect(request.url).toContain('/images/edits')
    expect(request.imageCount).toBe(2)
    expect(request.imageNames[1]).toBe(`gemshape-${node.id}.png`)
    // 清单行交叉引用图号（案例=图一，素材=图二）
    expect(request.prompt).toContain('2 = custom-' + node.id + ' 自定义钻形')
    expect(request.prompt).toContain('素材见【图二 [image #2]：钻石素材图·custom-' + node.id + '】')
  })

  it('missing fail-fast：未知 specKey → main stage 中文错误列缺失清单 + 零生图请求（不静默降级）', async () => {
    await configureFirstTemplate({ drill: { specs: ['round-ss10', 'custom-missing-asset'], physical: { widthMm: 210, heightMm: 148 } } })
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    const main = task.stages!.find((s) => s.kind === 'main')!
    expect(main.status).toBe('error')
    expect(task.status).toBe('error')
    expect(task.error).toContain('custom-missing-asset')
    expect(task.error).toContain('不在钻形目录中')
    expect(task.error).toContain('请到模板高级选项修正后重试')
    expect(imageCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 单 stage 等价回归（不开高级选项 = 现状管线）
// ---------------------------------------------------------------------------

describe('4.3 单 stage 等价回归（零行为差红线）', () => {
  it('无高级选项：单 main stage；提示词与两参 composeDrillPrompt 逐字节一致；账本 stages=[main success] 无高级选项键', async () => {
    await configureFirstTemplate({})
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    expect(task.stages).toHaveLength(1)
    expect(task.stages![0].kind).toBe('main')
    expect(task.status).toBe('success')
    expect(task.assetId).toBeDefined()

    // 提示词逐字节等价（同参快照级——roles 由模板 caseBinding 派生）
    const binding = getTemplateRecord(task.templateAssetId!)!.caseBinding
    const expected = composeDrillPrompt(task.prompt, {
      hasCase: binding !== null,
      caseLayout: binding?.caseLayout ?? 'single',
      hasReference: false,
    })
    expect(imageCalls[0].prompt).toBe(expected)

    // 账本：stages=[main success]；drillParams/blueprint 键缺席
    const metas = loadTaskMetas()
    expect(metas).toHaveLength(1)
    expect(metas[0].stages).toHaveLength(1)
    expect(metas[0].stages![0]).toMatchObject({ kind: 'main', status: 'success' })
    expect(metas[0].stages![0].assetId).toBe(task.assetId)
    expect(metas[0].drillParams).toBeUndefined()
    expect(metas[0].blueprint).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 操作粒度端到端
// ---------------------------------------------------------------------------

describe('4.3 操作粒度端到端（cancel/retry stage 级）', () => {
  it('策略 B 串行：main success → 自动派发 blueprint（edits 附图 [成品]；转换任务行 + 不增不删不移）', async () => {
    await configureFirstTemplate({ blueprint: {} })
    startRun()
    await whenIdle()

    expect(imageCalls).toHaveLength(2)
    expect(imageCalls[0].url).toContain('/images/edits') // 案例绑定 → main 走 edits
    const bp = imageCalls[1]
    expect(bp.url).toContain('/images/edits')
    expect(bp.imageCount).toBe(1) // [成品效果图]（无原图/素材/蓝图参考）
    expect(bp.prompt).toContain('【任务：施工蓝图转换】')
    expect(bp.prompt).toContain('【图一 [image #1]：成品效果图】')
    expect(bp.prompt).toContain('不新增、不移动、不删除任何钻位。')

    const task = getTasks()[0]
    const blueprintStage = task.stages!.find((s) => s.kind === 'blueprint')!
    expect(blueprintStage.status).toBe('success')
    expect(blueprintStage.imageUrl).toBeTruthy()
    expect(task.status).toBe('success')
    // 蓝图请求全文快照落任务（4.4 provenance 消费）
    expect(task.blueprintPrompt).toBe(bp.prompt)
  })

  it('蓝图失败 → 任务仍 success（徽标 failed）；retryStage 单独重试（main 不动）+ requestId 不复用', async () => {
    await configureFirstTemplate({ blueprint: {} })
    let failBlueprint = true
    imageResponder = async ({ index }) => (index === 1 && failBlueprint ? new Response('boom', { status: 500 }) : okResponse())
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    const blueprintStage = task.stages!.find((s) => s.kind === 'blueprint')!
    expect(blueprintStage.status).toBe('error')
    expect(task.status).toBe('success') // 派生表：main success + blueprint error → success
    expect(blueprintStage.retryCount).toBe(0)
    const failedRequestId = blueprintStage.requestId
    expect(failedRequestId).toBeDefined()

    // 单独重试：main 不重派（imageCalls[0] 之后 main 端点不再出现）
    failBlueprint = false
    retryStage(stageIdOf(task.id, 'blueprint'))
    await whenIdle()
    expect(imageCalls).toHaveLength(3)
    expect(task.stages!.find((s) => s.kind === 'main')!.retryCount).toBe(0)
    const retried = task.stages!.find((st) => st.kind === 'blueprint')! // reduce 重建——重找引用
    expect(retried.status).toBe('success')
    expect(retried.retryCount).toBe(1)
    expect(retried.requestId).toBeDefined()
    expect(retried.requestId).not.toBe(failedRequestId) // 重试新 requestId（§3.3 策略 1）
  })

  it('cancelTask running main → main cancelled + 蓝图级联 cancelled；retryTask 双双重派发至成功', async () => {
    await configureFirstTemplate({ blueprint: {} })
    // main 请求挂起（可控 resolve）
    let releaseMain: ((value: Response) => void) | null = null
    imageResponder = ({ index }) =>
      index === 0
        ? new Promise<Response>((resolve) => {
            releaseMain = resolve
          })
        : Promise.resolve(okResponse())
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'running')

    cancelTask(getTasks()[0].id)
    await waitFor(() => getTasks()[0]?.status === 'cancelled')
    const task = getTasks()[0]
    expect(task.stages!.map((s) => s.status)).toEqual(['cancelled', 'cancelled']) // 级联（§3.4）
    expect(imageCalls).toHaveLength(1)

    // retryTask：main + blueprint 双重重置 pending → 依次派发
    releaseMain = null
    imageResponder = async () => okResponse()
    retryTask(task.id)
    await whenIdle()
    expect(task.stages!.map((s) => s.status)).toEqual(['success', 'success'])
    expect(imageCalls).toHaveLength(3) // 挂起的 main（1）+ 重试 main（2）+ blueprint（3）
    expect(task.status).toBe('success')
  })

  it('main error → blueprint skipped（依赖失败不下发）；retryTask 级联重置 skipped → 双成功', async () => {
    await configureFirstTemplate({ blueprint: {} })
    let failMain = true
    imageResponder = async ({ index }) => (index === 0 && failMain ? new Response('boom', { status: 500 }) : okResponse())
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    expect(task.stages!.map((s) => s.status)).toEqual(['error', 'skipped'])
    expect(task.status).toBe('error')
    expect(imageCalls).toHaveLength(1) // skipped 不下发

    failMain = false
    retryTask(task.id)
    await whenIdle()
    expect(task.stages!.map((s) => s.status)).toEqual(['success', 'success'])
    expect(imageCalls).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 刷新中断恢复（R3 P0）
// ---------------------------------------------------------------------------

describe('4.3 刷新中断恢复（R3 P0——terminal-only 账本 + 中断合成态）', () => {
  it('main success + blueprint running 刷新：恢复 success +「蓝图已中断，可重试」；重试从归档字节取输入零重生成', async () => {
    await configureFirstTemplate({ blueprint: {} })
    imageResponder = ({ index }) =>
      index === 0
        ? Promise.resolve(okResponse())
        : new Promise<Response>(() => {
            // blueprint 挂起（模拟刷新时在途——活动 stage 刷新即丢）
          })
    startRun()
    // 等 main 归档落定（assetId = 单图先行档已在库）
    await waitFor(() => getTasks()[0]?.assetId !== undefined)
    const archivedAssetId = getTasks()[0].assetId
    expect(archivedAssetId).toBeDefined()

    // 模拟刷新：模块复位（cancelAll 持久化 main 终态——blueprint running 不落账本）+ hydrate
    resetLabForTests()
    expect(loadTaskMetas()).toHaveLength(1)
    const persisted = loadTaskMetas()[0]
    expect(persisted.status).toBe('success')
    expect(persisted.stages!.map((s) => s.kind)).toEqual(['main']) // 活动 blueprint 丢弃
    await hydrate()

    const restored = getTasks().find((t) => t.assetId === archivedAssetId)!
    expect(restored).toBeDefined()
    expect(restored.status).toBe('success') // 恢复态派生：main success（蓝图中断不拖累）
    const blueprintStage = restored.stages!.find((s) => s.kind === 'blueprint')!
    expect(blueprintStage.status).toBe('cancelled')
    expect(blueprintStage.error).toBe(BLUEPRINT_INTERRUPTED_ERROR)
    expect(deriveBlueprintBadge(restored.stages!)).toBe('interrupted')
    expect(restored.imageUrl).toBeTruthy() // main 缩略经归档字节恢复

    // 中断重试：fetch 解除挂起 → 从 main.assetId 归档字节取输入（成品图零重新生成）
    imageResponder = async () => okResponse()
    const callsBefore = imageCalls.length
    retryStage(stageIdOf(restored.id, 'blueprint'))
    await whenIdle()
    expect(imageCalls.length - callsBefore).toBe(1) // 只补蓝图一跳
    const bpCall = imageCalls[imageCalls.length - 1]
    expect(bpCall.url).toContain('/images/edits')
    expect(bpCall.imageCount).toBe(1) // [成品]（归档字节解析）
    expect(restored.stages!.find((st) => st.kind === 'blueprint')!.status).toBe('success')
  })

  it('账本 legacy 合成：手造无 stages 载荷 → 读时合成单 main stage（只读兼容）', async () => {
    resetLabForTests() // 模块态复位（cancelAll 空任务持久化会覆写——先复位再注入）
    localStorage.setItem(
      TASKS_KEY,
      JSON.stringify([
        {
          id: 'task-legacy-1',
          runId: 'run-legacy',
          variantId: 'v1',
          variantName: '旧模板',
          candidateIndex: 0,
          prompt: 'p',
          mode: 'generate',
          model: 'gpt-image-2.5',
          size: '1024x1024',
          advancedJson: '',
          status: 'success',
          hasReference: false,
          imageStored: true,
          createdAt: 1_700_000_000_000,
        },
      ]),
    )
    await hydrate()
    const task = getTasks().find((t) => t.id === 'task-legacy-1')!
    expect(task.stages).toHaveLength(1)
    expect(task.stages![0]).toMatchObject({ kind: 'main', status: 'success', dependsOn: [] })
    expect(task.status).toBe('success')
    // 只读兼容：不回写 stages（下次读仍走合成）
    expect(loadTaskMetas()[0].stages).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// [4.4] 两策略归档双档（自动触发 / 两档并存 / 幂等 / provenance 四态）
// ---------------------------------------------------------------------------

/** 批次夹内 gemgen 节点（含字节 parse）。 */
async function gemgenNodesOf(folderId: string): Promise<Array<{ id: string; file: ReturnType<typeof parseGemgenFile> }>> {
  const children = await listChildNodes(folderId)
  const out: Array<{ id: string; file: ReturnType<typeof parseGemgenFile> }> = []
  for (const node of children) {
    if (node.type !== 'project' || node.projectKind !== 'gemgen') continue
    const blob = await getImageBlob((node as { blobKey: string }).blobKey)
    if (blob === null) continue
    out.push({ id: node.id, file: parseGemgenFile(await blob.text()) })
  }
  return out
}

import { getProject, ingestAsset, listChildNodes } from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { parseGemgen as parseGemgenFile } from '$lib/persistence/labFile'
import { deriveArchivePlan, blueprintProvenanceOf, reduceStages, SKIPPED_UPSTREAM_ERROR_CODE, createTaskStages, type StageEvent } from '$lib/lab/stages'

describe('4.4 归档双档（自动触发 + 两档并存 + 幂等）', () => {
  it('蓝图成功：单图先行档 + 双图完整档两节点并存；blueprint 键（requestId 溯源+人审参照标记）+ provenance.blueprint{success} + blueprintPrompt + 水钻正交快照', async () => {
    await configureFirstTemplate({
      drill: { specs: ['round-ss10'], physical: { widthMm: 210, heightMm: 148 } },
      blueprint: {},
    })
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    const main = task.stages!.find((s) => s.kind === 'main')!
    const blueprint = task.stages!.find((s) => s.kind === 'blueprint')!
    expect(main.assetId).toBeDefined()
    expect(blueprint.assetId).toBeDefined()
    expect(blueprint.assetId).not.toBe(main.assetId) // 两档两节点（并存）

    const nodes = await gemgenNodesOf(await batchFolderOfTask(task.id))
    expect(nodes).toHaveLength(2)
    const byId = new Map(nodes.map((n) => [n.id, n.file]))
    const single = byId.get(main.assetId!)!
    const full = byId.get(blueprint.assetId!)!
    expect(single.blueprint).toBeUndefined() // 先行档无蓝图键
    expect(single.provenance.blueprint).toBeUndefined()
    // 水钻参数正交快照（两档同摄）：gemSpecs 顶层 + provenance.drillParams 开关快照
    expect(single.gemSpecs?.[0].specKey).toBe('round-ss10')
    expect(single.physicalCanvas).toEqual({ widthMm: 210, heightMm: 148, anchorSource: 'declared' })
    expect(single.provenance.drillParams).toEqual({ enabled: true, specs: ['round-ss10'], physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' } })
    // 双图档：blueprint 键 + 溯源 id + 人审参照 typed 标记 + provenance 快照 + 全文快照
    expect(full.blueprint?.role).toBe('human-review-reference')
    expect(full.blueprint?.effectRequestId).toBe(main.requestId)
    expect(full.blueprint?.blueprintRequestId).toBe(blueprint.requestId)
    expect(full.provenance.blueprint).toEqual({ strategy: 'serial', status: 'success' })
    expect(full.provenance.blueprintPrompt).toBe(task.blueprintPrompt)
    expect(full.provenance.blueprintPrompt).toContain('【任务：施工蓝图转换】')
    // 两档并存时序：先行档不晚于双图档（createdAt 同、savedAt 递增）
    expect(full.savedAt).toBeGreaterThanOrEqual(single.savedAt)
  })

  it('策略 B 附图序端到端（全要素）：[成品效果图, 原图, 钻石素材图, 蓝图参考图]', async () => {
    const seedTexture = GEMSHAPE_SEEDS[0].texture
    const shapeText = JSON.stringify({
      kind: 'gemshape', formatVersion: 1, appVersion: '0.1.0-test', createdAt: 1, savedAt: 2,
      name: '星形', texture: seedTexture, physical: { widthMm: 5, heightMm: 5 }, calibration: { mode: 'direct' },
    })
    const { node: customShape } = await ingestGemshapeFile(new Blob([shapeText], { type: PROJECT_MIME.gemshape }), {
      name: '星形',
      decode: async (dataUrl) => {
        const seed = GEMSHAPE_SEEDS.find((sd) => sd.texture.dataUrl === dataUrl)!
        const data = new Uint8ClampedArray(seed.texture.width * seed.texture.height * 4)
        for (let i = 3; i < data.length; i += 4) data[i] = 255
        return { width: seed.texture.width, height: seed.texture.height, data }
      },
    })
    // 原图（上传即入库）+ 蓝图参考图（素材库资产）
    const { node: bpRef } = await ingestAsset({
      blob: new File([new Uint8Array([7, 7, 7])], 'bp-ref.png', { type: 'image/png' }),
      name: 'bp-ref.png', width: 4, height: 4, parentId: 'sys-uploads', source: 'upload',
    })
    await setReference(new File([new Uint8Array([1, 2, 3])], 'ref.png', { type: 'image/png' }))
    await configureFirstTemplate({
      drill: { specs: [`custom-${customShape.id}`], physical: { widthMm: 210, heightMm: 148 } },
      blueprint: { refs: [bpRef.id] },
    })
    startRun()
    await whenIdle()

    expect(imageCalls).toHaveLength(2)
    // 主图：[案例合成图, 原图, 钻石素材图]（主图不受蓝图影响——纯净性）
    expect(imageCalls[0].imageNames).toHaveLength(3)
    expect(imageCalls[0].imageNames[1]).toBe('ref.png')
    expect(imageCalls[0].imageNames[2]).toBe(`gemshape-${customShape.id}.png`)
    // 蓝图：[成品效果图, 原图, 钻石素材图, 蓝图参考图]（Owner 语序逐字）
    expect(imageCalls[1].imageNames).toHaveLength(4)
    expect(imageCalls[1].imageNames[0]).toBe('effect.png')
    expect(imageCalls[1].imageNames[1]).toBe('ref.png')
    expect(imageCalls[1].imageNames[2]).toBe(`gemshape-${customShape.id}.png`)
    expect(imageCalls[1].imageNames[3]).toBe(`blueprint-ref-${bpRef.id}.png`)
    // 蓝图骨架无逐图角色声明段（design §2.4——任务行/括注/图例引用图号）；附图序以 images 数组为准
    expect(imageCalls[1].prompt).toContain('【图一 [image #1]：成品效果图】')
    expect(imageCalls[1].prompt).toContain('【图三 [image #3]：钻石素材图·custom-' + customShape.id + '】')
  })

  it('策略 A 并行同生：main 与 blueprint 同时派发（互不等待）；蓝图无成品图输入（附图 [参考?, 素材, 蓝图参考]）', async () => {
    await configureFirstTemplate({ blueprint: {} })
    updateForm({ blueprintStrategy: 'parallel' })
    // 两请求都挂起：并行派发 = 挂起期 imageCalls 已达 2（串行则蓝图必等 main 完成）
    const release: Array<(value: Response) => void> = []
    imageResponder = () => new Promise<Response>((resolve) => release.push(resolve))
    startRun()
    await waitFor(() => imageCalls.length === 2)
    const task = getTasks()[0]
    expect(task.stages!.every((s) => s.status === 'running')).toBe(true) // 并行：两 stage 同 running
    const bpCall = imageCalls.find((c) => c.prompt.includes('【任务：施工蓝图生成】'))!
    expect(bpCall.imageCount).toBe(0) // 无成品图输入（策略 A：无参考/素材/蓝图参考 → generations）
    expect(bpCall.url).toContain('/images/generations')
    for (const r of release) r(okResponse())
    await whenIdle()
    expect(task.stages!.map((s) => s.status)).toEqual(['success', 'success'])
    // 双档照常（并行成功也是两档）
    expect(task.stages!.every((s) => s.assetId !== undefined)).toBe(true)
  })

  it('蓝图失败：双图档无 blueprint 图键，provenance.blueprint{failed,error}；先行单图档并存', async () => {
    await configureFirstTemplate({ blueprint: {} })
    imageResponder = async ({ index }) => (index === 1 ? new Response('upstream boom', { status: 500 }) : okResponse())
    startRun()
    await whenIdle()

    const task = getTasks()[0]
    const blueprint = task.stages!.find((s) => s.kind === 'blueprint')!
    expect(blueprint.status).toBe('error')
    expect(blueprint.assetId).toBeDefined() // 失败也归档（部分失败语义——§5.1）
    const nodes = await gemgenNodesOf(await batchFolderOfTask(task.id))
    expect(nodes).toHaveLength(2)
    const full = nodes.find((n) => n.id === blueprint.assetId)!.file
    expect(full.blueprint).toBeUndefined() // 失败无图
    expect(full.provenance.blueprint).toEqual({
      strategy: 'serial',
      status: 'failed',
      error: blueprint.error,
    })
    expect(full.provenance.blueprintPrompt).toContain('【任务：施工蓝图转换】') // 请求全文快照仍在
  })

  it('蓝图取消（running abort）：双图档 provenance.blueprint{cancelled,已取消}（runStage abort 终态路径自动归档）', async () => {
    await configureFirstTemplate({ blueprint: {} })
    imageResponder = ({ index }) =>
      index === 0
        ? Promise.resolve(okResponse())
        : new Promise<Response>(() => {
            // blueprint 挂起
          })
    startRun()
    await waitFor(() => imageCalls.length === 2)
    const task = getTasks()[0]
    cancelStage(stageIdOf(task.id, 'blueprint'))
    await waitFor(() => task.stages!.find((s) => s.kind === 'blueprint')?.status === 'cancelled')
    await whenIdle() // fire-and-forget 双图档落定（whenIdle 排干归档链）

    const blueprint = task.stages!.find((s) => s.kind === 'blueprint')!
    expect(blueprint.assetId).toBeDefined()
    const nodes = await gemgenNodesOf(await batchFolderOfTask(task.id))
    const full = nodes.find((n) => n.id === blueprint.assetId)!.file
    expect(full.blueprint).toBeUndefined()
    expect(full.provenance.blueprint).toEqual({ strategy: 'serial', status: 'cancelled', error: '已取消' })
  })

  it('reconcile 幂等：双档已齐后再次终态持久化不重复归档；missing specKey 任务零档案（阻断）', async () => {
    await configureFirstTemplate({ blueprint: {} })
    startRun()
    await whenIdle()
    const task = getTasks()[0]
    expect(await allGemgenCount()).toBe(2)

    // 再次触发终态持久化面（cancelAll 空转触发 persistTasks + scheduleArchiveReconcile 补偿链）
    cancelAll()
    await whenIdle()
    expect(await allGemgenCount()).toBe(2) // 幂等：不重复归档（两档判重）

    // missing specKey（custom 资产缺失）任务：main error → 派生表「不归档」
    await configureFirstTemplate({ drill: { specs: ['custom-gone'], physical: { widthMm: 210, heightMm: 148 } } })
    startRun()
    await whenIdle()
    const failed = getTasks().find((t) => t.status === 'error')!
    expect(failed.assetId).toBeUndefined()
    expect(await allGemgenCount()).toBe(2) // 零新档案（missing 阻断）
  })

  it('skipped 档案投影（单元）：main error + blueprint skipped → 无归档单元；blueprintProvenanceOf 压缩 cancelled+SKIPPED_UPSTREAM', () => {
    const stages = createTaskStages('t-x', { strategy: 'serial' })
    const events: StageEvent[] = [
      { type: 'dispatch', stageId: 'stage-t-x-main', requestId: 'r1' },
      { type: 'fail', stageId: 'stage-t-x-main', error: 'boom' },
    ]
    const failed = events.reduce<ReturnType<typeof createTaskStages>>((acc, event) => reduceStages(acc, event), stages)
    const blueprint = failed.find((s) => s.kind === 'blueprint')!
    expect(blueprint.status).toBe('skipped')
    expect(deriveArchivePlan(failed, 'serial')).toEqual([]) // main error → 不归档
    expect(blueprintProvenanceOf('serial', blueprint)).toEqual({
      strategy: 'serial',
      status: 'cancelled',
      error: SKIPPED_UPSTREAM_ERROR_CODE,
    })
  })
})

/** 批次夹 id 解析（经任务归档节点的 parentId——会话内批次夹为懒建随机 id）。 */
async function batchFolderOfTask(taskId: string): Promise<string> {
  const task = getTasks().find((t) => t.id === taskId)!
  const assetId = task.stages?.find((st) => st.kind === 'main')?.assetId
  if (assetId === undefined) throw new Error('main 未归档')
  const node = await getProject(assetId)
  if (node === null) throw new Error('归档节点缺失')
  return node.parentId as string
}

/** sys-generated 下全部 gemgen 档案计数（跨批次夹）。 */
async function allGemgenCount(): Promise<number> {
  const folders = (await listChildNodes('sys-generated')).filter((n) => n.type === 'folder')
  const lists = await Promise.all(folders.map((f) => gemgenNodesOf(f.id)))
  return lists.reduce((sum, list) => sum + list.length, 0)
}


import { setReference, updateForm, cancelStage, cancelAll } from '$lib/stores/lab.svelte'
