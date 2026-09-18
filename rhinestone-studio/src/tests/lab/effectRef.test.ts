import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addVariant,
  buildEffectRefPromptClause,
  getEffectRefUrls,
  getTasks,
  getVariants,
  hydrate,
  removeVariant,
  resetLabForTests,
  setReference,
  setVariantEffectRefUpload,
  startRun,
  updateSettings,
  updateVariant,
} from '$lib/stores/lab.svelte'
import { getImageBlob } from '$lib/persistence/imageStore'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

const B64 = 'aGVsbG8=' // "hello"

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function imageResponse(): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), { status: 200 })
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
  // jsdom 的 Image 不解码：桩掉让 prepareReferenceImage 走「解码不可用回退原文件」路径
  class OkImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)
  localStorage.clear()
  resetLabForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 只留一个变体、一个候选，聚焦单任务请求。 */
function focusSingleVariant(): string {
  const keep = getVariants()[0]
  for (const v of [...getVariants()]) {
    if (v.id !== keep.id) removeVariant(v.id)
  }
  updateVariant(keep.id, { candidates: 1, prompt: 'base rhinestone prompt' })
  return keep.id
}

describe('变体案例图：设置 / 清除 / 持久化', () => {
  it('updateVariant 挂 preset / url / 清除（null）', () => {
    const variantId = getVariants()[0].id
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'new-orleans' } })
    expect(getVariants()[0].effectRef).toEqual({ kind: 'preset', presetId: 'new-orleans' })

    updateVariant(variantId, { effectRef: { kind: 'url', srcUrl: 'https://cdn/s.jpg', resUrl: 'https://cdn/r.jpg' } })
    expect(getVariants()[0].effectRef).toEqual({
      kind: 'url',
      srcUrl: 'https://cdn/s.jpg',
      resUrl: 'https://cdn/r.jpg',
    })

    updateVariant(variantId, { effectRef: null })
    expect(getVariants()[0].effectRef).toBeNull()
  })

  it('preset 案例图随变体持久化，reset+hydrate 后恢复', async () => {
    const variantId = getVariants()[0].id
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'savannah' } })
    expect(localStorage.getItem('rhinestone-studio:variants')).toContain('savannah')

    resetLabForTests()
    await hydrate()
    const restored = getVariants().find((v) => v.effectRef?.kind === 'preset' && v.effectRef.presetId === 'savannah')
    expect(restored?.effectRef).toEqual({ kind: 'preset', presetId: 'savannah' })
  })

  it('upload kind：变体只存 IndexedDB key，不存图片数据；hydrate 后可取回 objectURL', async () => {
    const variantId = getVariants()[0].id
    await setVariantEffectRefUpload(
      variantId,
      new File([new Uint8Array([1])], 'src.png', { type: 'image/png' }),
      new File([new Uint8Array([2, 2])], 'res.png', { type: 'image/png' }),
    )

    const variant = getVariants().find((v) => v.id === variantId)
    expect(variant?.effectRef?.kind).toBe('upload')
    expect(variant?.effectRef?.uploadKeys?.src).toMatch(new RegExp(`^effectref-${variantId}-src-\\d+$`))
    expect(variant?.effectRef?.uploadKeys?.res).toMatch(new RegExp(`^effectref-${variantId}-res-\\d+$`))

    // localStorage 里只有 key，没有图片本体（无 data: / blob:）
    const raw = localStorage.getItem('rhinestone-studio:variants') ?? ''
    expect(raw).toContain(`effectref-${variantId}-res-`)
    expect(raw).not.toContain('data:image')
    expect(raw).not.toContain('blob:')

    // blob 确实进了 IndexedDB
    const srcBlob = await getImageBlob(variant?.effectRef?.uploadKeys?.src ?? '')
    expect(srcBlob).toBeInstanceOf(Blob)
    expect(srcBlob?.size).toBe(1)

    // 展示辅助：upload → IDB objectURL
    const urls = await getEffectRefUrls(variant?.effectRef)
    expect(urls?.srcUrl.startsWith('blob:mock-')).toBe(true)
    expect(urls?.resUrl.startsWith('blob:mock-')).toBe(true)

    // 模拟刷新：模块复位（不清 IDB）→ hydrate → key 与展示 URL 均恢复
    resetLabForTests()
    await hydrate()
    const restored = getVariants().find((v) => v.id === variantId)
    expect(restored?.effectRef?.kind).toBe('upload')
    const urlsAfter = await getEffectRefUrls(restored?.effectRef)
    expect(urlsAfter?.resUrl.startsWith('blob:mock-')).toBe(true)
  })

  it('旧持久化数据无 effectRef 字段 → hydrate 后归一为 null', async () => {
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify([{ id: 'legacy-v1', name: '旧变体', prompt: 'old prompt', candidates: 2, enabled: true }]),
    )
    resetLabForTests()
    await hydrate()
    expect(getVariants()).toHaveLength(1)
    expect(getVariants()[0].effectRef).toBeNull()
  })

  it('getEffectRefUrls：preset → 静态路径（无原图对的内置案例 srcUrl 空串）；无效引用 → null', async () => {
    expect(await getEffectRefUrls(null)).toBeNull()
    expect(await getEffectRefUrls({ kind: 'preset', presetId: 'nonexistent' })).toBeNull()

    const urls = await getEffectRefUrls({ kind: 'preset', presetId: 'boston' })
    expect(urls).toEqual({ srcUrl: '/presets/boston-src.jpg', resUrl: '/presets/boston-res.jpg' })

    // 内置案例允许无原图对（srcImage 空串）→ srcUrl 空串
    const noSrcPreset = EFFECT_REF_PRESETS.find((p) => p.srcImage === '')
    expect(noSrcPreset).toBeDefined()
    const noSrcUrls = await getEffectRefUrls({ kind: 'preset', presetId: noSrcPreset!.id })
    expect(noSrcUrls).toEqual({ srcUrl: '', resUrl: noSrcPreset!.resImage })

    // url kind：srcUrl 缺省 → 空串
    const urlOnly = await getEffectRefUrls({ kind: 'url', resUrl: 'https://cdn/r.jpg' })
    expect(urlOnly).toEqual({ srcUrl: '', resUrl: 'https://cdn/r.jpg' })
  })
})

describe('buildEffectRefPromptClause：参考图指代措辞', () => {
  it('两图（原图 + 效果图）指代', () => {
    const clause = buildEffectRefPromptClause(true)
    expect(clause).toContain('the first reference shows the original printed artwork')
    expect(clause).toContain('the second shows its finished rhinestone effect')
    expect(clause).toContain('Reproduce that exact conversion style')
    expect(clause.startsWith(' ')).toBe(true)
  })

  it('仅一张效果图时调整措辞', () => {
    const clause = buildEffectRefPromptClause(false)
    expect(clause).toContain('A reference image is attached')
    expect(clause).toContain('finished rhinestone effect')
    expect(clause).not.toContain('the first reference')
    expect(clause.startsWith(' ')).toBe(true)
  })
})

describe('生成请求链路：案例图参与 edits 多参考图', () => {
  it('preset + 用户参考原图：edits 端点，image 字段顺序 = [用户原图, 效果src, 效果res]，prompt 含指代段', async () => {
    await setReference(new File([new Uint8Array([9])], 'wreath.png', { type: 'image/png' }))
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'new-orleans' } })

    const editCalls: { url: string; body: FormData }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.endsWith('/images/edits')) {
          editCalls.push({ url: u, body: init?.body as FormData })
          return okResponse()
        }
        // preset 静态路径（/presets/*.jpg）
        expect(u.startsWith('/presets/')).toBe(true)
        return imageResponse()
      }),
    )

    const result = startRun()
    expect(result.ok).toBe(true)
    await waitFor(() => getTasks()[0]?.status === 'success')

    expect(editCalls).toHaveLength(1)
    expect(editCalls[0].url).toBe('https://relay.example.com/v1/images/edits')
    const form = editCalls[0].body
    expect(form.get('n')).toBe('1')
    const images = form.getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['wreath.png', 'effect-src.jpg', 'effect-res.jpg'])
    const prompt = String(form.get('prompt'))
    expect(prompt).toContain('base rhinestone prompt')
    expect(prompt).toContain('the first reference shows the original printed artwork')
    expect(prompt).toContain('the second shows its finished rhinestone effect')

    // 任务快照 + debug 记录多参考图
    const task = getTasks()[0]
    expect(task.mode).toBe('edit')
    expect(task.effectRef).toEqual({ kind: 'preset', presetId: 'new-orleans' })
    expect((task.debug?.requestBody as Record<string, unknown>).imageCount).toBe(3)
  })

  it('url kind 无用户原图：仍走 edits，第一张即效果原图', async () => {
    const variantId = focusSingleVariant()
    updateVariant(variantId, {
      effectRef: { kind: 'url', srcUrl: 'https://cdn.example.com/src.jpg', resUrl: 'https://cdn.example.com/res.jpg' },
    })

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.endsWith('/images/edits')) {
          editCalls.push(init?.body as FormData)
          return okResponse()
        }
        expect(u.startsWith('https://cdn.example.com/')).toBe(true)
        return imageResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    expect(editCalls).toHaveLength(1)
    const images = editCalls[0].getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['effect-src.jpg', 'effect-res.jpg'])
    expect(String(editCalls[0].get('prompt'))).toContain('the first reference shows the original printed artwork')

    // 任务快照记录来源（画廊卡片徽章用）
    expect(getTasks()[0].effectRef).toEqual({
      kind: 'url',
      srcUrl: 'https://cdn.example.com/src.jpg',
      resUrl: 'https://cdn.example.com/res.jpg',
    })
  })

  it('仅一张效果参考（无原图对）：只有一张参考图，指代措辞调整', async () => {
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'url', resUrl: 'https://cdn.example.com/res-only.jpg' } })

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/images/edits')) {
          editCalls.push(init?.body as FormData)
          return okResponse()
        }
        return imageResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    const images = editCalls[0].getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['effect-res.jpg'])
    const prompt = String(editCalls[0].get('prompt'))
    expect(prompt).toContain('A reference image is attached')
    expect(prompt).not.toContain('the first reference')
  })

  it('url 直链跨域失败：任务报错提示下载后上传，不发 edits 请求', async () => {
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'url', resUrl: 'https://bad.example/res.jpg' } })

    const editSeen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.endsWith('/images/edits')) {
          editSeen.push(u)
          return okResponse()
        }
        throw new TypeError('Failed to fetch')
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')

    expect(editSeen).toHaveLength(0)
    expect(getTasks()[0].error).toContain('参考图链接跨域不可取，请下载后上传')
    expect(getTasks()[0].error).toContain('Failed to fetch')
  })

  it('任务元数据持久化 effectRef 快照，reset+hydrate 后徽章信息恢复', async () => {
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'boston' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.endsWith('/images/edits')) return okResponse()
        return imageResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    const persisted = localStorage.getItem('rhinestone-studio:tasks') ?? ''
    expect(persisted).toContain('"effectRef"')
    expect(persisted).toContain('boston')

    resetLabForTests()
    await hydrate()
    expect(getTasks()[0].effectRef).toEqual({ kind: 'preset', presetId: 'boston' })
  })

  it('upload kind 效果参考进请求：blob 从 IndexedDB 取回转 File', async () => {
    const variantId = focusSingleVariant()
    await setVariantEffectRefUpload(
      variantId,
      new File([new Uint8Array([7])], 's.png', { type: 'image/png' }),
      new File([new Uint8Array([8])], 'r.png', { type: 'image/png' }),
    )

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/images/edits')) {
          editCalls.push(init?.body as FormData)
          return okResponse()
        }
        return imageResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    const images = editCalls[0].getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['effect-src.png', 'effect-res.png'])
    expect(String(editCalls[0].get('prompt'))).toContain('the first reference shows the original printed artwork')
  })
})

describe('案例图融合：变体绑定生命周期', () => {
  it('默认变体与内置案例一一对应（8 组，每组带 preset 绑定）', () => {
    const variants = getVariants()
    expect(EFFECT_REF_PRESETS).toHaveLength(8)
    expect(variants).toHaveLength(8)
    variants.forEach((variant, i) => {
      expect(variant.name).toBe(EFFECT_REF_PRESETS[i].name)
      expect(variant.prompt).toBe(EFFECT_REF_PRESETS[i].prompt)
      expect(variant.effectRef).toEqual({ kind: 'preset', presetId: EFFECT_REF_PRESETS[i].id })
    })
  })

  it('新增变体为空态（无绑定）：不阻断生成，纯 prompt 走 generations', async () => {
    addVariant()
    const added = getVariants()[getVariants().length - 1]
    expect(added.effectRef).toBeNull()

    // 只留新变体（无绑定、无用户参考图）→ mode generate
    for (const v of [...getVariants()]) {
      if (v.id !== added.id) removeVariant(v.id)
    }
    updateVariant(added.id, { candidates: 1, prompt: 'pure prompt run' })

    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url))
        return okResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    expect(urls).toEqual(['https://relay.example.com/v1/images/generations'])
    expect(getTasks()[0].mode).toBe('generate')
    expect(getTasks()[0].effectRef).toBeNull()
  })

  it('空态 → 粘贴链接绑定 → 替换为上传绑定 → 解绑（store 级流程）', async () => {
    addVariant()
    const variantId = getVariants()[getVariants().length - 1].id
    expect(getVariants().find((v) => v.id === variantId)?.effectRef).toBeNull()

    // 1. 粘贴链接完成绑定
    updateVariant(variantId, { effectRef: { kind: 'url', resUrl: 'https://cdn.example.com/r.jpg' } })
    expect(getVariants().find((v) => v.id === variantId)?.effectRef?.kind).toBe('url')

    // 2. 上传替换绑定（无原图对 → src key 为空串）
    await setVariantEffectRefUpload(
      variantId,
      undefined,
      new File([new Uint8Array([3])], 'res.png', { type: 'image/png' }),
    )
    const afterUpload = getVariants().find((v) => v.id === variantId)?.effectRef
    expect(afterUpload?.kind).toBe('upload')
    expect(afterUpload?.uploadKeys?.src).toBe('')
    expect(await getImageBlob(afterUpload?.uploadKeys?.res ?? '')).toBeInstanceOf(Blob)

    // 3. 解绑 → 回到空态
    updateVariant(variantId, { effectRef: null })
    expect(getVariants().find((v) => v.id === variantId)?.effectRef).toBeNull()
  })

  it('默认绑定的变体参与请求时带案例图（融合后默认路径走 edits）', async () => {
    // 只留第一个默认变体（自带 preset 绑定），无用户参考图 → edits + 两张案例图
    const variantId = getVariants()[0].id
    for (const v of [...getVariants()]) {
      if (v.id !== variantId) removeVariant(v.id)
    }
    updateVariant(variantId, { candidates: 1 })

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.endsWith('/images/edits')) {
          editCalls.push(init?.body as FormData)
          return okResponse()
        }
        expect(u.startsWith('/presets/')).toBe(true)
        return imageResponse()
      }),
    )

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    const images = editCalls[0].getAll('image') as File[]
    // new-orleans 案例有原图对：[案例原图, 案例效果图]，无用户原图时第一张即案例原图
    expect(images.map((f) => f.name)).toEqual(['effect-src.jpg', 'effect-res.jpg'])
    expect(getTasks()[0].mode).toBe('edit')
    expect(getTasks()[0].effectRef).toEqual({ kind: 'preset', presetId: 'new-orleans' })
  })
})
