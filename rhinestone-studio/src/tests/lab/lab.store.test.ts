import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTaskParams,
  cancelAll,
  cancelTask,
  clearHistory,
  copyTaskPrompt,
  getForm,
  getReference,
  getRunningCount,
  getTask,
  getTasks,
  hydrate,
  MAX_CONCURRENCY,
  resetLabForTests,
  retryTask,
  sendToStudio,
  setReference,
  startRun,
  updateForm,
  updateSettings,
  whenIdle,
} from '$lib/stores/lab.svelte'
import {
  createTemplate,
  getTemplateAssetIds,
  getTemplateList,
  getTemplateRecord,
  isEnabledTemplate,
  removeTemplate,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { getGalleryGroups, GALLERY_FILTER_ALL, resetGalleryForTests } from '$lib/stores/gallery.svelte'
import { getHandoff } from '$lib/stores/handoff.svelte'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import { runAssetMigration } from '$lib/persistence/assetStore'
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

/** preset 静态路径 → 图片字节（带 content-type：物化管线的 mime 校验需要）；edits → 成功回包。 */
function editsWithPresetImages(editsSeen?: FormData[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/images/edits')) {
      editsSeen?.push(init?.body as FormData)
      return okResponse()
    }
    if (u.startsWith('/presets/')) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    // blob: URL（会话 objectURL 重取，归档补偿链路）→ PNG 字节
    return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
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

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  // 物化管线 loadDrawable 需要「可解码」Image：jsdom 原生 Image 不加载 blob: URL
  // （onload 永不触发 → 默认模板的 preset 物化挂死）。各 describe 自带 Image 桩的会覆盖此桩。
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
  // [4.3] 默认 fetch 桩：hydrate 的内置模板 seed 需要 /presets/ 图源；生成端点给成功回包。
  // 各测试自定 fetch 时 vi.stubGlobal 覆盖（在 hydrate 之后覆盖即只影响生成请求）。
  vi.stubGlobal('fetch', seedFetchStub())
  localStorage.clear()
  resetLabForTests() // cancelAll 会持久化上一测试的内存任务——先复位再清，防 hydrate 捞回陈旧任务
  resetGalleryForTests()
  localStorage.clear()
  resetToastsForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
  // [4.3] 模板真源 = 库：测试前置 hydrate（seed 8 内置模板 + 迁移引擎 + 模板 store 刷新）
  // [4.3] sys-shapes/系统目录 seed 先排干（hydrate 内 void 迁移不 await——模板 seed 与
  // 迁移竞态会让 refreshTemplates 偶发空列表：gem-catalog 期既有的测试交互红根源）
  await runAssetMigration()
  await hydrate()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** [4.3] seed 图源 + 生成端点成功（测试自定 fetch 可覆盖）。 */
function seedFetchStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/presets/')) {
      const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (u.endsWith('/images/generations') || u.endsWith('/images/edits')) return okResponse()
    return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  })
}

/** 解绑全部模板案例绑定（聚焦纯 generations 路径的测试用）。 */
async function unbindAllTemplates(): Promise<void> {
  for (const id of getTemplateAssetIds()) submitTemplateField(id, { caseBinding: null })
  await whenTemplatesIdle()
}

/** 只留第一个模板（其余禁用），聚焦单模板路径。 */
async function keepFirstTemplateOnly(): Promise<string> {
  const keep = getTemplateAssetIds()[0]
  for (const id of getTemplateAssetIds()) {
    if (id !== keep) setEnabledTemplate(id, false)
  }
  return keep
}

describe('内置模板（库化：hydrate seed 8 条）', () => {
  it('默认 8 条（= EFFECT_REF_PRESETS_V2），名称/特化正文中文、候选数 2、案例绑定为库资产引用', () => {
    const templates = getTemplateList()
    expect(EFFECT_REF_PRESETS).toHaveLength(8)
    expect(templates).toHaveLength(EFFECT_REF_PRESETS.length)
    templates.forEach((template, i) => {
      const preset = EFFECT_REF_PRESETS[i]
      expect(template.name).toBe(preset.name)
      expect(template.promptBody).toBe(`${preset.prompt}\n【案例参照图提示词】`) // [placeholders] v2 新版文案
      expect(template.caseRef).toEqual({ enabled: true }) // 案例开关 seed 默认开
      // seed 物化后恒为 asset 绑定（B.1.3：preset kind 已收窄出用户可见面）
      expect(template.caseBinding).not.toBeNull()
      expect(template.caseBinding?.assetId).toMatch(/^ast-/)
      expect(template.candidates).toBe(2)
    })
    // 默认全部启用（E8：无 session 载荷回默认）
    expect(getTemplateAssetIds().every((id) => isEnabledTemplate(id))).toBe(true)
    // 名称与特化正文均含中文（公共规则由组装器拼装，不进模板体）
    expect(templates[0].name).toMatch(/[\u4e00-\u9fff]/)
    expect(templates[0].promptBody).toMatch(/[\u4e00-\u9fff]/)
  })

  it('字段提交增改：名称/提示词体/候选数（clamp 1-8），写路径 = 换绑落库', async () => {
    const id = await createTemplate()
    expect(id).not.toBeNull()
    expect(getTemplateList()).toHaveLength(EFFECT_REF_PRESETS.length + 1)
    const created = getTemplateRecord(id as string)
    expect(created?.caseBinding).toBeNull()
    submitTemplateField(id as string, { name: '自定义', promptBody: 'custom prompt', candidates: 3 })
    await whenTemplatesIdle()
    expect(getTemplateRecord(id as string)).toMatchObject({ name: '自定义', promptBody: 'custom prompt', candidates: 3 })
    // 候选数 clamp 到 [1,8]
    submitTemplateField(id as string, { candidates: 99 })
    expect(getTemplateRecord(id as string)?.candidates).toBe(8)
  })
})

describe('分组批量生成（变体 × 候选，恒 n:1，并发上限 4）', () => {
  it('8 模板 × 2 候选 = 16 个独立请求，画廊按批次分组', async () => {
    // 本测试聚焦 generations 并发模型：解绑全部案例绑定（带绑定的 edits 路径见 effectRef.test.ts）
    await unbindAllTemplates()

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
    const groups = getGalleryGroups(GALLERY_FILTER_ALL)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.entries).toHaveLength(16)
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
    // generations JSON 路径：解绑全部案例绑定（edits multipart 路径见 effectRef.test.ts）
    await unbindAllTemplates()
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

    const editCalls: FormData[] = []
    vi.stubGlobal('fetch', editsWithPresetImages(editCalls))

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    expect(editCalls).toHaveLength(16)
    const form = editCalls[0]
    expect(form.get('n')).toBe('1')
    // [Owner] 附图顺序 = 角色声明顺序：[案例参照图(合成), 用户参考原图]
    const images = form.getAll('image') as File[]
    expect(images).toHaveLength(2)
    expect(images[1].name).toBe('wreath.png')
    const prompt = String(form.get('prompt'))
    expect(prompt).toContain('【图一：案例参照图】')
    expect(prompt).toContain('【图二：参考图】')
  })
})

describe('取消（AbortController）', () => {
  it('取消 running 任务 → cancelled；取消 pending 任务 → 直接 cancelled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            // 真实 fetch 语义：signal 已中止 → 立即拒绝（不依赖尚未触发的 abort 事件）。
            // 物化管线会把首次 fetch 推迟到 IDB meta 反查之后，取消可能先于 fetch 调用发生。
            if (init?.signal?.aborted) {
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
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

    // 只留一个模板一个候选，聚焦单任务；解绑案例绑定（本测试聚焦用户参考图的重试语义）
    const keep = await keepFirstTemplateOnly()
    submitTemplateField(keep, { candidates: 1, promptBody: 'my stable prompt', caseBinding: null })
    await whenTemplatesIdle()
    expect(getTemplateList().filter((t) => isEnabledTemplate(t.assetId))).toHaveLength(1)

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

    // 解绑案例绑定：本测试聚焦「参考原图经资产解析重发」的 B-4 语义
    const keep = await keepFirstTemplateOnly()
    submitTemplateField(keep, { candidates: 1, caseBinding: null })
    await whenTemplatesIdle()

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

    // 模拟刷新：模块内引用清空（cancelAll→persistTasks 落盘错误任务，快照带 referenceAssetId）
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
    vi.stubGlobal('fetch', editsWithPresetImages())
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
    expect(getGalleryGroups(GALLERY_FILTER_ALL)).toHaveLength(1)
    expect(getGalleryGroups(GALLERY_FILTER_ALL)[0]?.entries).toHaveLength(16)
  })
})

describe('Advanced JSON 敏感键脱敏（N3：debug 与 localStorage 持久化）', () => {
  it('恶意塞 apiKey：任务 debug 与持久化任务列表中该键均已打码', async () => {
    updateForm({ advancedJson: '{"apiKey":"sk-leak-via-advanced","background":"transparent"}' })
    vi.stubGlobal('fetch', editsWithPresetImages())
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
    vi.stubGlobal('fetch', editsWithPresetImages())
    const keep = await keepFirstTemplateOnly()
    submitTemplateField(keep, { candidates: 1 })
    await whenTemplatesIdle()
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

describe('复用参数与送排钻', () => {
  it('applyTaskParams 只回填表单层（model/size/Advanced），模板内容零变化 + [复制提示词] 进剪贴板', async () => {
    vi.stubGlobal('fetch', editsWithPresetImages())
    const keep = await keepFirstTemplateOnly()
    submitTemplateField(keep, { candidates: 1, promptBody: 'reusable prompt' })
    await whenTemplatesIdle()
    updateForm({ advancedJson: '' })
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()

    updateForm({ advancedJson: '{"seed":7}' })
    applyTaskParams(getTasks()[0].id)
    expect(getForm().advancedJson).toBe('') // 任务当时的 advanced 被写回表单
    // [4.3 非破坏化] 提示词体不写任何模板：record 与文件都保持模板自身内容
    expect(getTemplateRecord(keep)?.promptBody).toBe('reusable prompt')

    // [复制提示词]：任务快照进剪贴板（不触碰模板）
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    resetToastsForTests()
    expect(await copyTaskPrompt(getTasks()[0].id)).toBe(true)
    expect(writeText).toHaveBeenCalledWith('reusable prompt')
    expect(getToasts().some((t) => t.message.includes('已复制'))).toBe(true)
    expect(getTemplateRecord(keep)?.promptBody).toBe('reusable prompt')
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

    vi.stubGlobal('fetch', editsWithPresetImages())
    const keep = await keepFirstTemplateOnly()
    submitTemplateField(keep, { candidates: 1 })
    await whenTemplatesIdle()
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenIdle()
    const task = getTasks()[0]
    // [4.3] 成功结果已归档为素材（批次夹 + meta.assetId）
    expect(task.assetId).toMatch(/^ast-/)

    // 无参考原图：referenceAssetId 缺省（排钻工作台走纯钻点/叠稿预览）
    let ok = await sendToStudio(task.id)
    expect(ok).toBe(true)
    let handoff = getHandoff()
    expect(handoff).not.toBeNull()
    expect(handoff!.assetId).toBe(task.assetId)
    expect(handoff!.name).toContain('候选1')
    expect(handoff!.referenceAssetId).toBeUndefined()

    // 有参考原图：referenceAssetId 随 handoff 带过去 → 排钻工作台「叠原图」按 id 解析（R3 延续）
    await setReference(new File([new Uint8Array([7, 7])], 'ref-original.png', { type: 'image/png' }))
    ok = await sendToStudio(task.id)
    expect(ok).toBe(true)
    handoff = getHandoff()
    expect(handoff!.referenceAssetId).toMatch(/^ast-/)
  })

  it('非成功任务送排钻返回 false', async () => {
    expect(await sendToStudio('nonexistent')).toBe(false)
  })
})
