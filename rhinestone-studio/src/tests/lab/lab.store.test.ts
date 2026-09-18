import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addVariant,
  applyTaskParams,
  cancelAll,
  cancelTask,
  clearHistory,
  getForm,
  getReference,
  getRunningCount,
  getTask,
  getTaskGroups,
  getTasks,
  getVariants,
  hydrate,
  MAX_CONCURRENCY,
  removeVariant,
  resetLabForTests,
  retryTask,
  sendToStudio,
  setReference,
  startRun,
  updateForm,
  updateSettings,
  updateVariant,
} from '$lib/stores/lab.svelte'
import { getHandoff } from '$lib/stores/handoff.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

const B64 = 'aGVsbG8=' // "hello"

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let fake: FakeIndexedDB
let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  localStorage.clear()
  resetLabForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('默认变体模板', () => {
  it('默认 5 组，名称中文、提示词英文、候选数 2', () => {
    const variants = getVariants()
    expect(variants).toHaveLength(5)
    expect(variants.every((v) => v.candidates === 2)).toBe(true)
    expect(variants.every((v) => v.prompt.trim().length > 0)).toBe(true)
    // 名称含中文
    expect(variants[0].name).toMatch(/[\u4e00-\u9fff]/)
    // 提示词正文为英文生成指令
    expect(variants[0].prompt).toMatch(/rhinestone painting template/)
  })

  it('增删改', () => {
    addVariant()
    expect(getVariants()).toHaveLength(6)
    const added = getVariants()[5]
    updateVariant(added.id, { name: '自定义', prompt: 'custom prompt', candidates: 3 })
    expect(getVariants()[5]).toMatchObject({ name: '自定义', prompt: 'custom prompt', candidates: 3 })
    // 候选数 clamp 到 [1,8]
    updateVariant(added.id, { candidates: 99 })
    expect(getVariants()[5].candidates).toBe(8)
  })
})

describe('分组批量生成（变体 × 候选，恒 n:1，并发上限 4）', () => {
  it('5 变体 × 2 候选 = 10 个独立请求，画廊按变体分组', async () => {
    let active = 0
    let maxActive = 0
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
        bodies.push(JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>)
        return okResponse()
      }),
    )

    const result = startRun()
    expect(result.ok).toBe(true)
    expect(result.enqueued).toBe(10)

    // 并发上限：同步 pump 后恰好 4 个 running、6 个 pending
    expect(getRunningCount()).toBe(MAX_CONCURRENCY)
    await waitFor(() => getTasks().every((t) => t.status === 'success'))

    expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENCY)
    expect(maxActive).toBe(MAX_CONCURRENCY)
    expect(getTasks()).toHaveLength(10)
    // 每个请求体 n 恒 1
    expect(bodies).toHaveLength(10)
    expect(bodies.every((b) => b.n === 1)).toBe(true)

    // 分组画廊：5 组 × 2 候选
    const groups = getTaskGroups()
    expect(groups).toHaveLength(5)
    expect(groups.every((g) => g.tasks.length === 2)).toBe(true)
    // 全部 success 且带耗时与图片
    for (const task of getTasks()) {
      expect(task.status).toBe('success')
      expect(task.durationMs).toBeGreaterThan(0)
      expect(task.imageUrl?.startsWith('blob:mock-')).toBe(true)
      expect(task.imageStored).toBe(true)
    }
  })

  it('设置缺失时前端拦截（无 API Key）', async () => {
    updateSettings({ apiKey: ' ' })
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const result = startRun()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Advanced JSON 非法时整个 run 不发起', async () => {
    updateForm({ advancedJson: '{"background": ' })
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const result = startRun()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Advanced JSON')
    expect(getTasks()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Advanced JSON 合法时透传进每个请求体', async () => {
    updateForm({ advancedJson: '{"background":"transparent","output_format":"png"}' })
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>)
        return okResponse()
      }),
    )
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    expect(bodies.every((b) => b.background === 'transparent' && b.output_format === 'png')).toBe(true)
  })
})

describe('参考原图与 edits 端点自动切换', () => {
  beforeEach(() => {
    class OkImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)
  })

  it('有参考图自动走 /images/edits（multipart），参考图随请求重发', async () => {
    await setReference(new File([new Uint8Array([1, 2])], 'wreath.png', { type: 'image/png' }))
    expect(getReference()?.file.name).toBe('wreath.png')

    const calls: { url: string; body: FormData | string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: (init?.body ?? '') as FormData | string })
        return okResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    expect(calls.length).toBe(10)
    expect(calls.every((c) => c.url.endsWith('/images/edits'))).toBe(true)
    const form = calls[0].body as FormData
    expect(form.get('n')).toBe('1')
    expect((form.get('image') as File).name).toBe('wreath.png')
  })
})

describe('取消（AbortController）', () => {
  it('取消 running 任务 → cancelled；取消 pending 任务 → 直接 cancelled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )

    startRun() // 10 任务：4 running + 6 pending
    await waitFor(() => getRunningCount() === MAX_CONCURRENCY)

    const running = getTasks().filter((t) => t.status === 'running')
    expect(running).toHaveLength(4)
    cancelTask(running[0].id)

    cancelAll() // 其余全部取消
    await waitFor(() => getTasks().every((t) => t.status === 'cancelled'))

    expect(getTasks().every((t) => t.status === 'cancelled')).toBe(true)
    expect(getTask(running[0].id)?.error).toBe('已取消')
  })
})

describe('失败重试免重传（输入引用保留）', () => {
  it('edits 任务失败后重试：同一参考图文件重发，提示词不变', async () => {
    class OkImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)

    await setReference(new File([new Uint8Array([9, 9])], 'tree.png', { type: 'image/png' }))

    // 只留一个变体一个候选，聚焦单任务
    const keep = getVariants()[0]
    for (const v of [...getVariants()]) {
      if (v.id !== keep.id) removeVariant(v.id)
    }
    updateVariant(keep.id, { candidates: 1, prompt: 'my stable prompt' })
    expect(getVariants()).toHaveLength(1)

    const forms: FormData[] = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        call += 1
        forms.push(init?.body as FormData)
        if (call === 1) return errorResponse(500, 'relay exploded')
        return okResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')

    const failed = getTasks()[0]
    expect(failed.error).toContain('relay exploded')
    expect(failed.mode).toBe('edit')
    expect(call).toBe(1)

    // 重试：不改输入（提示词/参考图引用原样保留，无需重新上传）
    retryTask(failed.id)
    await waitFor(() => getTasks()[0]?.status === 'success')

    expect(call).toBe(2)
    expect(getTasks()[0].prompt).toBe('my stable prompt')
    expect((forms[1].get('image') as File).name).toBe('tree.png')
    expect(forms[1].get('prompt')).toBe('my stable prompt')
  })

  it('edit 任务在参考图丢失（模拟刷新）后重试直接失败并给出中文提示', async () => {
    class OkImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)
    await setReference(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))

    const keep = getVariants()[0]
    for (const v of [...getVariants()]) {
      if (v.id !== keep.id) removeVariant(v.id)
    }
    updateVariant(keep.id, { candidates: 1 })

    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500, 'boom')))
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')

    // 模拟刷新丢参考图：模块内引用清空（此处通过重新 reset + 保留任务元数据来近似）
    const meta = { prompt: getTasks()[0].prompt, id: getTasks()[0].id }
    resetLabForTests()
    expect(meta.id).toBeTruthy()

    // hydrate 从 localStorage 恢复错误任务（参考图必然丢失）
    await hydrate()
    const restored = getTasks().find((t) => t.id === meta.id)
    expect(restored).toBeDefined()
    retryTask(restored!.id)
    expect(restored!.status).toBe('error')
    expect(restored!.error).toContain('参考原图已丢失')
  })
})

describe('持久化与刷新恢复', () => {
  it('成功任务入 IndexedDB + localStorage；reset+hydrate 后画廊恢复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))

    const persisted = JSON.parse(localStorage.getItem('rhinestone-studio:tasks') ?? '[]') as { id: string; status: string }[]
    expect(persisted).toHaveLength(10)
    expect(persisted.every((t) => t.status === 'success')).toBe(true)

    // 模拟刷新：内存任务清空，localStorage / IndexedDB 保留
    resetLabForTests()
    expect(getTasks()).toHaveLength(0)

    await hydrate()
    expect(getTasks()).toHaveLength(10)
    expect(getTasks().every((t) => t.status === 'success' && t.imageUrl?.startsWith('blob:mock-'))).toBe(true)
    expect(getTaskGroups()).toHaveLength(5)
  })
})

describe('Advanced JSON 敏感键脱敏（N3：debug 与 localStorage 持久化）', () => {
  it('恶意塞 apiKey：任务 debug 与持久化任务列表中该键均已打码', async () => {
    updateForm({ advancedJson: '{"apiKey":"sk-leak-via-advanced","background":"transparent"}' })
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))

    const task = getTasks()[0]
    expect((task.debug?.requestBody as Record<string, unknown>).apiKey).toBe('***')
    expect((task.debug?.requestBody as Record<string, unknown>).background).toBe('transparent')

    const persisted = JSON.parse(localStorage.getItem('rhinestone-studio:tasks') ?? '[]') as unknown[]
    expect(persisted.length).toBeGreaterThan(0)
    expect(JSON.stringify(persisted)).not.toContain('sk-leak-via-advanced')
    expect(JSON.stringify(persisted)).toContain('"apiKey":"***"')
  })
})

describe('objectURL 生命周期（N4：回收纪律）', () => {
  it('clearHistory 回收全部 blob: URL 并清空任务', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const keep = getVariants()[0]
    updateVariant(keep.id, { candidates: 1 })
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    const urls = getTasks().map((t) => t.imageUrl)
    expect(urls.every((u) => u?.startsWith('blob:'))).toBe(true)

    await clearHistory()
    const revoke = vi.mocked(URL.revokeObjectURL)
    for (const u of urls) expect(revoke).toHaveBeenCalledWith(u)
    expect(getTasks()).toHaveLength(0)
  })
})

describe('复用参数与送转化', () => {
  it('applyTaskParams 把任务的提示词/Advanced 写回编辑区', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const keep = getVariants()[0]
    updateVariant(keep.id, { candidates: 1, prompt: 'reusable prompt' })
    updateForm({ advancedJson: '' })
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))

    updateForm({ advancedJson: '{"seed":7}' })
    applyTaskParams(getTasks()[0].id)
    expect(getForm().advancedJson).toBe('') // 任务当时的 advanced 被写回
    expect(getVariants().find((v) => v.id === keep.id)?.prompt).toBe('reusable prompt')
  })

  it('sendToStudio 把选中候选 dataURL 写入 handoff store，并随交接带上参考原图', async () => {
    // jsdom 的 Image 不解码：桩掉让 prepareReferenceImage 走「解码不可用回退原文件」路径
    class OkImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)

    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const keep = getVariants()[0]
    updateVariant(keep.id, { candidates: 1 })
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))

    // 无参考原图：reference 缺省（工作台走纯钻点/叠稿预览）
    let ok = await sendToStudio(getTasks()[0].id)
    expect(ok).toBe(true)
    let handoff = getHandoff()
    expect(handoff).not.toBeNull()
    expect(handoff!.image.startsWith('data:image/png;base64,')).toBe(true)
    expect(handoff!.name).toContain('候选1')
    expect(handoff!.reference).toBeUndefined()

    // 有参考原图：reference（dataUrl + 原文件名）随 handoff 带过去 → 工作台「叠原图」零二次上传（R3）
    await setReference(new File([new Uint8Array([7, 7])], 'ref-original.png', { type: 'image/png' }))
    ok = await sendToStudio(getTasks()[0].id)
    expect(ok).toBe(true)
    handoff = getHandoff()
    expect(handoff!.reference).toBeDefined()
    expect(handoff!.reference!.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(handoff!.reference!.name).toBe('ref-original.png')
  })

  it('非成功任务送转化返回 false', async () => {
    expect(await sendToStudio('nonexistent')).toBe(false)
  })
})
