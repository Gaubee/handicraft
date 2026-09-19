/**
 * [add-lab 4.5] 端到端行为矩阵（mock fetch）：两开关四象限 × 蓝图两策略。
 *
 * 矩阵断言面（每格一次独立 run）：
 * - 请求形态：请求数 / 端点 / 串行序（蓝图在 main 完成后）vs 并行（两请求同挂起期齐发）；
 * - 提示词：【尺寸与钻规格】只在 drillParams on 的主图请求出现（主图纯净性——蓝图开启
 *   不改主图）；蓝图 prompt 的图例节（hasLegend = drillParams on）与无编号纯转换退化；
 * - stage 树：blueprint stage 仅 blueprint on 存在；策略决定 dependsOn；
 * - 归档：单图档恒 1（main success）；blueprint on 时 +1 双图档（两档并存）；gemSpecs/
 *   physicalCanvas 正交键随 drillParams on 落档。
 * 刷新中断恢复 / 双档并存字节级断言 / 重试新 requestId 已由 stagePipeline.test.ts 覆盖
 * （4.3/4.4 切片），本文件不重复。
 *
 * [Owner 试产回填位] BYOK 真实生图（策略 B 全链：模板启用双选项→发起→双图→归档→画廊
 * 展开位→送排钻 handoff）与浏览器走查（design §6 线框动线）归 Owner 手动 3-5 批
 * （design §8-3/§8-5 错误率回填）——本文件 mock fetch 不触网（执行纪律：API 全 mock）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTasks,
  hydrate,
  resetLabForTests,
  startRun,
  updateForm,
  updateSettings,
  whenIdle,
} from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { listChildNodes, resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { parseGemgen } from '$lib/persistence/labFile'
import { resetGalleryForTests } from '$lib/stores/gallery.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

interface MatrixCell {
  drill: boolean
  blueprint: boolean
  strategy: 'serial' | 'parallel'
}

let fake: FakeIndexedDB
let objectUrlCounter = 0
let imageCalls: Array<{ url: string; prompt: string; imageCount: number }>
let imageResponder: (call: { url: string; index: number }) => Promise<Response>
/** 挂起中的响应释放器（并行格：两请求齐发后统一放行）。 */
let pendingReleases: Array<(value: Response) => void>
let b64Seq = 0

function okB64(): string {
  b64Seq += 1
  return btoa(String.fromCharCode(0x10 + b64Seq, 0x20 + b64Seq, 0x30 + b64Seq, 0x40 + b64Seq))
}

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: okB64() }] }), {
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

async function gemgenCount(): Promise<number> {
  const folders = (await listChildNodes('sys-generated')).filter((n) => n.type === 'folder')
  let count = 0
  for (const folder of folders) {
    for (const node of await listChildNodes(folder.id)) {
      if (node.type === 'project' && node.projectKind === 'gemgen') {
        const blob = await getImageBlob((node as { blobKey: string }).blobKey)
        if (blob !== null) count += 1
      }
    }
  }
  return count
}

async function gemgenFiles(): Promise<ReturnType<typeof parseGemgen>[]> {
  const folders = (await listChildNodes('sys-generated')).filter((n) => n.type === 'folder')
  const out: ReturnType<typeof parseGemgen>[] = []
  for (const folder of folders) {
    for (const node of await listChildNodes(folder.id)) {
      if (node.type !== 'project' || node.projectKind !== 'gemgen') continue
      const blob = await getImageBlob((node as { blobKey: string }).blobKey)
      if (blob !== null) out.push(parseGemgen(await blob.text()))
    }
  }
  return out
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  objectUrlCounter = 0
  imageCalls = []
  pendingReleases = []
  b64Seq = 0
  imageResponder = async () => okResponse()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:matrix-${(objectUrlCounter += 1)}`),
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
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
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
      let imageCount = 0
      if (init?.body instanceof FormData) {
        prompt = String(init.body.get('prompt') ?? '')
        imageCount = init.body.getAll('image').length
      } else if (typeof init?.body === 'string') {
        prompt = String((JSON.parse(init.body) as { prompt?: string }).prompt ?? '')
      }
      const index = imageCalls.length
      imageCalls.push({ url, prompt, imageCount })
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
  })
  localStorage.clear()
  resetLabForTests()
  resetGalleryForTests()
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
  await runAssetMigration()
  await hydrate()
})

afterEach(async () => {
  for (const release of pendingReleases.splice(0)) release(okResponse())
  await whenTemplatesIdle().catch(() => undefined)
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 矩阵格执行：配置首模板（drill/blueprint/strategy）→ 单任务 run → 双 idle 排干。 */
async function runCell(cell: MatrixCell): Promise<void> {
  const first = getTemplateAssetIds()[0]
  for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === first)
  submitTemplateField(first, { candidates: 1 })
  if (cell.drill) {
    submitTemplateField(first, {
      drillParams: {
        enabled: true,
        specs: ['round-ss10'],
        physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
      },
    })
  }
  if (cell.blueprint) submitTemplateField(first, { blueprint: { enabled: true } })
  await whenTemplatesIdle()
  updateForm({ blueprintStrategy: cell.strategy })
  if (cell.strategy === 'parallel') {
    // 并行格：两请求挂起 → 齐发断言后统一放行
    imageResponder = () =>
      new Promise<Response>((resolve) => {
        pendingReleases.push(resolve)
      })
  }
  const run = startRun()
  expect(run.ok).toBe(true)
  if (cell.strategy === 'parallel' && cell.blueprint) {
    await waitFor(() => imageCalls.length === 2) // 齐发（串行下此刻蓝图必未派发）
    for (const release of pendingReleases.splice(0)) release(okResponse())
  }
  await whenIdle()
}

describe('4.5 四象限 × 两策略端到端矩阵（mock fetch）', () => {
  const cells: MatrixCell[] = [
    { drill: false, blueprint: false, strategy: 'serial' },
    { drill: true, blueprint: false, strategy: 'serial' },
    { drill: false, blueprint: true, strategy: 'serial' },
    { drill: false, blueprint: true, strategy: 'parallel' },
    { drill: true, blueprint: true, strategy: 'serial' },
    { drill: true, blueprint: true, strategy: 'parallel' },
  ]

  it.for(cells)('矩阵格 %o：请求形态/提示词/stage 树/归档档数一致', async (cell) => {
    await runCell(cell)

    const task = getTasks()[0]
    expect(task.status).toBe('success')
    const blueprintStage = task.stages!.find((s) => s.kind === 'blueprint')
    expect(blueprintStage !== undefined).toBe(cell.blueprint)
    if (cell.blueprint) {
      expect(blueprintStage!.dependsOn.length).toBe(cell.strategy === 'serial' ? 1 : 0)
      expect(blueprintStage!.status).toBe('success')
    }

    // 请求形态
    expect(imageCalls).toHaveLength(cell.blueprint ? 2 : 1)
    // 并行格调用序不定——主图请求 = 非蓝图任务行的那个（无蓝图格唯一请求即主图）
    const mainCall = imageCalls.find((c) => !c.prompt.includes('【任务：施工蓝图'))!
    // 主图提示词：【尺寸与钻规格】只随 drillParams on（主图纯净性——蓝图开启不影响主图）
    expect(mainCall.prompt.includes('【尺寸与钻规格】')).toBe(cell.drill)
    if (cell.drill) {
      expect(mainCall.prompt).toContain('画幅物理尺寸 210×148mm')
      expect(mainCall.prompt).toContain('1 = R10 圆形 SS10（直径 2.8mm）')
    }

    if (cell.blueprint) {
      // 并行格两请求齐发、调用序不定——按任务行标记识别蓝图请求
      const bpCall = cell.strategy === 'serial' ? imageCalls[1] : imageCalls.find((c) => c.prompt.includes('【任务：施工蓝图生成】'))!
      // 蓝图策略任务行（B 转换 / A 同生）；串行首附图=成品（edits），并行无成品输入
      if (cell.strategy === 'serial') {
        expect(bpCall.prompt).toContain('【任务：施工蓝图转换】')
        expect(bpCall.imageCount).toBeGreaterThanOrEqual(1)
        expect(bpCall.url).toContain('/images/edits')
      } else {
        expect(bpCall.prompt).toContain('【任务：施工蓝图生成】')
        expect(bpCall.imageCount).toBe(0) // 无参考/素材/蓝图参考 → generations
        expect(bpCall.url).toContain('/images/generations')
      }
      // 图例节：hasLegend = drillParams on；off = 无编号纯转换
      expect(bpCall.prompt.includes('右下角图例列出编号对应规格')).toBe(cell.drill)
      expect(bpCall.prompt.includes('无编号纯转换')).toBe(!cell.drill)
    }

    // 归档：单图档恒 1；blueprint on +1 双图档；gemSpecs/physicalCanvas 随 drill on 落档
    const files = await gemgenFiles()
    expect(files).toHaveLength(cell.blueprint ? 2 : 1)
    for (const file of files) {
      expect(file.gemSpecs !== undefined).toBe(cell.drill)
      expect(file.physicalCanvas !== undefined).toBe(cell.drill)
      expect(file.provenance.drillParams !== undefined).toBe(cell.drill)
      if (cell.drill) {
        expect(file.gemSpecs![0].specKey).toBe('round-ss10')
      }
      // blueprint 图键只属双图成功档（先行单图档与失败/取消档无图键——下方 full 断言）
      if (file.provenance.blueprint === undefined) {
        expect(file.blueprint).toBeUndefined()
      }
    }
    if (cell.blueprint) {
      const full = files.find((f) => f.provenance.blueprint !== undefined)!
      expect(full.provenance.blueprint).toEqual({ strategy: cell.strategy, status: 'success' })
      expect(full.blueprint?.role).toBe('human-review-reference')
      expect(full.provenance.blueprintPrompt).toBeDefined()
    }
  })

  it('归档计数口径（矩阵外旁证）：无蓝图任务恰一档', async () => {
    await runCell({ drill: false, blueprint: false, strategy: 'serial' })
    expect(await gemgenCount()).toBe(1)
  })
})
