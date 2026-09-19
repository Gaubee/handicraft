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
  whenIdle,
} from '$lib/stores/lab.svelte'
import { getHandoff } from '$lib/stores/handoff.svelte'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
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

describe('默认变体（与内置案例一一绑定）', () => {
  it('默认 8 组（= EFFECT_REF_PRESETS），每组天生绑定自己的案例图，名称/特化正文中文、候选数 2', () => {
    const variants = getVariants()
    expect(EFFECT_REF_PRESETS).toHaveLength(8)
    expect(variants).toHaveLength(EFFECT_REF_PRESETS.length)
    variants.forEach((variant, i) => {
      const preset = EFFECT_REF_PRESETS[i]
      expect(variant.name).toBe(preset.name)
      expect(variant.prompt).toBe(preset.prompt)
      // 变体固定绑定自己的案例图（preset 静态路径直引，无库选择交互）
      expect(variant.effectRef).toEqual({ kind: 'preset', presetId: preset.id })
      expect(variant.candidates).toBe(2)
      expect(variant.enabled).toBe(true)
    })
    // 名称与特化正文均含中文（公共规则由组装器拼装，不进模板体）
    expect(variants[0].name).toMatch(/[\u4e00-\u9fff]/)
    expect(variants[0].prompt).toMatch(/[\u4e00-\u9fff]/)
  })

  it('增删改；新增变体无案例图绑定（空态，不阻断纯 prompt 生成）', () => {
    addVariant()
    expect(getVariants()).toHaveLength(EFFECT_REF_PRESETS.length + 1)
    const added = getVariants()[EFFECT_REF_PRESETS.length]
    expect(added.effectRef).toBeNull()
    updateVariant(added.id, { name: '自定义', prompt: 'custom prompt', candidates: 3 })
    expect(getVariants()[EFFECT_REF_PRESETS.length]).toMatchObject({ name: '自定义', prompt: 'custom prompt', candidates: 3 })
    // 候选数 clamp 到 [1,8]
    updateVariant(added.id, { candidates: 99 })
    expect(getVariants()[EFFECT_REF_PRESETS.length].candidates).toBe(8)
  })
})

describe('分组批量生成（变体 × 候选，恒 n:1，并发上限 4）', () => {
  it('8 变体 × 2 候选 = 16 个独立请求，画廊按变体分组', async () => {
    // 本测试聚焦 generations 并发模型：解绑默认案例图（带绑定的 edits 路径见 effectRef.test.ts）
    for (const v of getVariants()) updateVariant(v.id, { effectRef: null })

    let active = 0
    let maxActive = 0
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        // 归档补偿对会话 objectURL 的取回不带 init：浏览器返回原 blob，mock 侧给 PNG（带 content-type）
        if (init?.body === undefined) {
          return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          })
        }
        // 并发口径只计生成请求（带请求体）
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
    expect(result.enqueued).toBe(16)

    // 并发上限：同步 pump 后恰好 4 个 running、12 个 pending
    expect(getRunningCount()).toBe(MAX_CONCURRENCY)
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()

    expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENCY)
    expect(maxActive).toBe(MAX_CONCURRENCY)
    expect(getTasks()).toHaveLength(16)
    // 每个请求体 n 恒 1
    expect(bodies).toHaveLength(16)
    expect(bodies.every((b) => b.n === 1)).toBe(true)

    // 分组画廊：单次 run = 单批次组（8 变体 × 2 候选 = 16 张，组内按发起顺序）
    const groups = getTaskGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].tasks).toHaveLength(16)
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
    // generations JSON 路径：解绑默认案例图（edits multipart 路径见 effectRef.test.ts）
    for (const v of getVariants()) updateVariant(v.id, { effectRef: null })
    updateForm({ advancedJson: '{"background":"transparent","output_format":"png"}' })
    const bodies: Record<string, unknown>[] = []
    const fetchUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchUrls.push(init?.body ? String(_url) : `nobody:${String(_url)}`)
        bodies.push(JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>)
        return okResponse()
      }),
    )
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    // 16 个 generations 请求全部带合法 Advanced JSON 透传；无身份外的杂散请求体
    const generationBodies = bodies.filter((_, i) => !fetchUrls[i].startsWith('nobody:'))
    expect(generationBodies).toHaveLength(16)
    expect(generationBodies.every((b) => b.background === 'transparent' && b.output_format === 'png')).toBe(true)
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

  it('有参考图自动走 /images/edits（multipart）；默认案例图随请求一起作为追加参考图', async () => {
    await setReference(new File([new Uint8Array([1, 2])], 'wreath.png', { type: 'image/png' }))
    expect(getReference()?.file.name).toBe('wreath.png')

    const editCalls: { url: string; body: FormData }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.endsWith('/images/edits')) {
          editCalls.push({ url: u, body: (init?.body ?? '') as FormData })
          return okResponse()
        }
        // 默认案例图走 public/presets 静态路径
        expect(u.startsWith('/presets/')).toBe(true)
        return new Response(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), { status: 200 })
      }),
    )

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    expect(editCalls).toHaveLength(16)
    expect(editCalls.every((c) => c.url.endsWith('/images/edits'))).toBe(true)
    const form = editCalls[0].body
    expect(form.get('n')).toBe('1')
    // [Owner] 附图顺序 = 角色声明顺序：[案例原图, 案例效果图, 用户参考原图]
    const images = form.getAll('image') as File[]
    expect(images[2].name).toBe('wreath.png')
    expect(images).toHaveLength(3)
    const prompt = String(form.get('prompt'))
    expect(prompt).toContain('【图一：案例-原图】')
    expect(prompt).toContain('【图三：参考图】')
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

    // 只留一个变体一个候选，聚焦单任务；解绑默认案例图（本测试聚焦用户参考图的重试语义）
    const keep = getVariants()[0]
    for (const v of [...getVariants()]) {
      if (v.id !== keep.id) removeVariant(v.id)
    }
    updateVariant(keep.id, { candidates: 1, prompt: 'my stable prompt', effectRef: null })
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
    expect(getTasks()[0].prompt).toBe('my stable prompt') // 任务快照 = 模板体原文
    expect((forms[1].get('image') as File).name).toBe('tree.png')
    // 请求 prompt = 组装产物（含角色声明与通用规则）；重试组装结果与首次一致（确定性）
    expect(forms[1].get('prompt')).toBe(forms[0].get('prompt'))
    expect(String(forms[1].get('prompt'))).toContain('my stable prompt')
  })

  it('edit 任务刷新后重试经素材 id 解析参考原图（B-4：参考不再随刷新丢失）', async () => {
    class OkImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)
    await setReference(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))

    // 解绑默认案例图：本测试聚焦「参考原图经资产解析重发」的 B-4 语义
    const keep = getVariants()[0]
    for (const v of [...getVariants()]) {
      if (v.id !== keep.id) removeVariant(v.id)
    }
    updateVariant(keep.id, { candidates: 1, effectRef: null })

    const forms: FormData[] = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        call += 1
        if (init?.body instanceof FormData) forms.push(init.body)
        return call === 1 ? errorResponse(500, 'boom') : okResponse()
      }),
    )
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')

    // 模拟刷新：模块内引用清空（任务快照带 referenceAssetId 持久化）
    const meta = { id: getTasks()[0].id }
    resetLabForTests()
    expect(meta.id).toBeTruthy()

    // hydrate 从 localStorage 恢复错误任务 → 重试按素材 id 解析回 File（不再丢参考）
    await hydrate()
    const restored = getTasks().find((t) => t.id === meta.id)
    expect(restored).toBeDefined()
    retryTask(restored!.id)
    await waitFor(() => restored!.status === 'success')
    await whenIdle()
    // 两次 edits（首次失败 + 重试成功）；重试请求首图 = 素材节点名解析回的 a.png
    expect(forms).toHaveLength(2)
    expect((forms[1].get('image') as File).name).toBe('a.png')
    expect((forms[1].get('image') as File).size).toBe(1)
  })
})

describe('持久化与刷新恢复', () => {
  it('成功任务入 IndexedDB + localStorage；reset+hydrate 后画廊恢复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()

    const persisted = JSON.parse(localStorage.getItem('rhinestone-studio:tasks') ?? '[]') as { id: string; status: string }[]
    expect(persisted).toHaveLength(16)
    expect(persisted.every((t) => t.status === 'success')).toBe(true)

    // 模拟刷新：内存任务清空，localStorage / IndexedDB 保留
    resetLabForTests()
    expect(getTasks()).toHaveLength(0)

    await hydrate()
    expect(getTasks()).toHaveLength(16)
    expect(getTasks().every((t) => t.status === 'success' && t.imageUrl?.startsWith('blob:mock-'))).toBe(true)
    // 恢复后仍是单批次一组（runId 随持久化往返）
    expect(getTaskGroups()).toHaveLength(1)
    expect(getTaskGroups()[0].tasks).toHaveLength(16)
  })
})

describe('Advanced JSON 敏感键脱敏（N3：debug 与 localStorage 持久化）', () => {
  it('恶意塞 apiKey：任务 debug 与持久化任务列表中该键均已打码', async () => {
    updateForm({ advancedJson: '{"apiKey":"sk-leak-via-advanced","background":"transparent"}' })
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()

    const task = getTasks()[0]
    // generations 的 debug body 平铺 advanced；edits（默认变体带案例图）嵌在 advanced 键下。
    // 两条路径的敏感键都必须打码、非敏感键透传。
    const body = task.debug?.requestBody as Record<string, unknown>
    const advancedView = (body.advanced ?? body) as Record<string, unknown>
    expect(advancedView.apiKey).toBe('***')
    expect(advancedView.background).toBe('transparent')

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
    await whenIdle()
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
    await whenIdle()

    updateForm({ advancedJson: '{"seed":7}' })
    applyTaskParams(getTasks()[0].id)
    expect(getForm().advancedJson).toBe('') // 任务当时的 advanced 被写回
    expect(getVariants().find((v) => v.id === keep.id)?.prompt).toBe('reusable prompt')
  })

  it('sendToStudio 把选中候选的素材 id 写入 handoff store（v2），并随交接带上参考原图资产 id', async () => {
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
    await whenIdle()
    const task = getTasks()[0]
    // [4.3] 成功结果已归档为素材（批次夹 + meta.assetId）
    expect(task.assetId).toMatch(/^ast-/)

    // 无参考原图：referenceAssetId 缺省（工作台走纯钻点/叠稿预览）
    let ok = await sendToStudio(task.id)
    expect(ok).toBe(true)
    let handoff = getHandoff()
    expect(handoff).not.toBeNull()
    expect(handoff!.assetId).toBe(task.assetId)
    expect(handoff!.name).toContain('候选1')
    expect(handoff!.referenceAssetId).toBeUndefined()

    // 有参考原图：referenceAssetId 随 handoff 带过去 → 工作台「叠原图」按 id 解析（R3 延续）
    await setReference(new File([new Uint8Array([7, 7])], 'ref-original.png', { type: 'image/png' }))
    ok = await sendToStudio(task.id)
    expect(ok).toBe(true)
    handoff = getHandoff()
    expect(handoff!.referenceAssetId).toMatch(/^ast-/)
  })

  it('非成功任务送转化返回 false', async () => {
    expect(await sendToStudio('nonexistent')).toBe(false)
  })
})
