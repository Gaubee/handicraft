import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addVariant,
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
import { getAssetBlob, listChildNodes, resetAssetStoreForTests, type AssetImage } from '$lib/persistence/assetStore'
import { composeDrillPrompt, EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
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
  resetAssetStoreForTests()
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

  it('asset kind：上传即入库 sys-uploads，变体只挂素材节点 id；hydrate 后可取回 objectURL', async () => {
    const variantId = getVariants()[0].id
    await setVariantEffectRefUpload(
      variantId,
      new File([new Uint8Array([1])], 'src.png', { type: 'image/png' }),
      new File([new Uint8Array([2, 2])], 'res.png', { type: 'image/png' }),
    )

    const variant = getVariants().find((v) => v.id === variantId)
    expect(variant?.effectRef?.kind).toBe('asset')
    if (variant?.effectRef?.kind !== 'asset') return
    expect(variant.effectRef.assetIds.src).toMatch(/^ast-/)
    expect(variant.effectRef.assetIds.res).toMatch(/^ast-/)

    // localStorage 里只有素材节点 id，没有图片本体（无 data: / blob:）
    const raw = localStorage.getItem('rhinestone-studio:variants') ?? ''
    expect(raw).toContain('"kind":"asset"')
    expect(raw).not.toContain('data:image')
    expect(raw).not.toContain('blob:')

    // blob 确实入库（sys-uploads 下两个图片节点，内容哈希键）
    const uploads = (await listChildNodes('sys-uploads')).filter((n) => n.type === 'image') as AssetImage[]
    expect(uploads).toHaveLength(2)
    const srcBlob = await getAssetBlob(variant.effectRef.assetIds.src ?? '')
    expect(srcBlob).toBeInstanceOf(Blob)
    expect(srcBlob?.size).toBe(1)

    // 展示辅助：asset → assetStore 冻结出口 objectURL
    const urls = await getEffectRefUrls(variant.effectRef)
    expect(urls?.srcUrl.startsWith('blob:mock-')).toBe(true)
    expect(urls?.resUrl.startsWith('blob:mock-')).toBe(true)

    // 模拟刷新：模块复位（不清 IDB）→ hydrate → asset 引用与展示 URL 均恢复
    resetLabForTests()
    await hydrate()
    const restored = getVariants().find((v) => v.id === variantId)
    expect(restored?.effectRef).toEqual(variant.effectRef)
    const urlsAfter = await getEffectRefUrls(restored?.effectRef)
    expect(urlsAfter?.resUrl.startsWith('blob:mock-')).toBe(true)
  })

  it('持久化模板（v2 载荷）无 effectRef 字段 → hydrate 后归一为 null；旧数组载荷 → 版本门重置为默认模板', async () => {
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify({ v: 2, items: [{ id: 'legacy-v1', name: '旧模板', prompt: 'old prompt', candidates: 2, enabled: true }] }),
    )
    resetLabForTests()
    await hydrate()
    expect(getVariants()).toHaveLength(1)
    expect(getVariants()[0].effectRef).toBeNull()

    // [Owner] 版本门：旧数组载荷（无 v 字段，旧默认模板时代）→ 整体重置为当前默认模板
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify([{ id: 'var-old', name: '旧默认', prompt: 'Convert the input photo...', candidates: 2 }]),
    )
    resetLabForTests()
    await hydrate()
    expect(getVariants().length).toBeGreaterThan(1)
    expect(getVariants().every((v) => !v.prompt.includes('Convert the input photo'))).toBe(true)
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

describe('composeDrillPrompt：角色声明组装（[Owner] 模板重构）', () => {
  it('三图全配：图序 [案例原图, 案例效果图, 参考图]，任务行引用三者，规则占位用【图三】', () => {
    const prompt = composeDrillPrompt('模板特化正文', { hasCaseSrc: true, hasCaseRes: true, hasReference: true })
    expect(prompt).toContain('我上传了3 张图片：')
    expect(prompt).toContain('1. 【图一：案例-原图】：无贴钻的原始底图。')
    expect(prompt).toContain('2. 【图二：案例-效果图】：基于【图一】完成 Partial Drill（局部贴钻）后的成品效果图。')
    expect(prompt).toContain('3. 【图三：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请参考【图一：案例-原图】到【图二：案例-效果图】的转换风格与贴钻逻辑，为【图三：参考图】生成对应的 Partial Drill 效果图。')
    // 四条通用规则原文 + 参考图占位替换
    expect(prompt).toContain('保留【图三：参考图】的大面积背景与次要细节为原始画风/印刷效果')
    expect(prompt).toContain('完全保持【图三：参考图】的原有风格、构图与配色')
    expect(prompt).toContain('【模板风格补充】：\n模板特化正文')
    expect(prompt).toContain('请输出【图三：参考图】应用局部贴钻后的最终渲染效果图。')
  })

  it('仅效果图对（无案例原图）：编号前移，任务行降级为参考效果图', () => {
    const prompt = composeDrillPrompt('正文', { hasCaseSrc: false, hasCaseRes: true, hasReference: true })
    expect(prompt).toContain('1. 【图一：案例-效果图】')
    expect(prompt).toContain('2. 【图二：参考图】')
    expect(prompt).toContain('请参考【图一：案例-效果图】所展示的贴钻风格与选区逻辑，为【图二：参考图】生成')
    expect(prompt).not.toContain('案例-原图')
  })

  it('仅参考图：无案例声明，任务行直连规则', () => {
    const prompt = composeDrillPrompt('', { hasCaseSrc: false, hasCaseRes: false, hasReference: true })
    expect(prompt).toContain('我上传了一张图片：')
    expect(prompt).toContain('1. 【图一：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请为【图一：参考图】生成 Partial Drill（局部贴钻）效果图')
    expect(prompt).not.toContain('案例')
    expect(prompt).not.toContain('【模板风格补充】') // 模板体为空省略特化节
  })

  it('无任何附图（纯文生图）：省略角色声明，任务行无图指代', () => {
    const prompt = composeDrillPrompt('正文', { hasCaseSrc: false, hasCaseRes: false, hasReference: false })
    expect(prompt).not.toContain('我上传了')
    expect(prompt).not.toContain('【图')
    expect(prompt).toContain('请生成一张 Partial Drill（局部贴钻）风格的完整设计效果图')
    expect(prompt).toContain('请输出应用局部贴钻后的最终渲染效果图。')
  })
})

describe('生成请求链路：案例图参与 edits 多参考图', () => {
  it('preset + 用户参考原图：edits 端点，image 顺序 = [效果src, 效果res, 用户原图]，prompt 含角色声明', async () => {
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
    // [Owner] 附图顺序 = 角色声明顺序：[案例原图, 案例效果图, 参考图]
    expect(images.map((f) => f.name)).toEqual(['effect-src.jpg', 'effect-res.jpg', 'wreath.png'])
    const prompt = String(form.get('prompt'))
    expect(prompt).toContain('base rhinestone prompt')
    expect(prompt).toContain('【图一：案例-原图】')
    expect(prompt).toContain('【图二：案例-效果图】')
    expect(prompt).toContain('【图三：参考图】')

    // 任务快照 + debug 记录多参考图
    const task = getTasks()[0]
    expect(task.mode).toBe('edit')
    expect(task.effectRef).toEqual({ kind: 'preset', presetId: 'new-orleans' })
    expect((task.debug?.requestBody as Record<string, unknown>).imageCount).toBe(3)
  })

  it('url kind 无用户原图：仍走 edits，角色声明 [图一=效果原图, 图二=参考图]', async () => {
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
    expect(String(editCalls[0].get('prompt'))).toContain('1. 【图一：案例-原图】')
    expect(String(editCalls[0].get('prompt'))).toContain('2. 【图二：案例-效果图】')
    expect(String(editCalls[0].get('prompt'))).toContain('生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图')

    // 任务快照记录来源（画廊卡片徽章用）
    expect(getTasks()[0].effectRef).toEqual({
      kind: 'url',
      srcUrl: 'https://cdn.example.com/src.jpg',
      resUrl: 'https://cdn.example.com/res.jpg',
    })
  })

  it('仅一张效果参考（无原图对）：编号前移 [图一=效果图, 图二=参考图]', async () => {
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
    expect(prompt).toContain('1. 【图一：案例-效果图】')
    expect(prompt).toContain('所展示的贴钻风格与选区逻辑，生成一张同风格的')
    expect(prompt).not.toContain('案例-原图')
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

  it('asset kind 效果参考进请求：blob 经 getAssetBlob 取回转 File', async () => {
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
    expect(String(editCalls[0].get('prompt'))).toContain('【图一：案例-原图】')
    expect(String(editCalls[0].get('prompt'))).toContain('【图二：案例-效果图】')
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

    // 2. 上传替换绑定（无原图对 → assetIds.src 缺省；旧 url 资产保留在库 = B-2 语义入口）
    await setVariantEffectRefUpload(
      variantId,
      undefined,
      new File([new Uint8Array([3])], 'res.png', { type: 'image/png' }),
    )
    const afterUpload = getVariants().find((v) => v.id === variantId)?.effectRef
    expect(afterUpload?.kind).toBe('asset')
    if (afterUpload?.kind === 'asset') {
      expect(afterUpload.assetIds.src).toBeUndefined()
      expect(await getAssetBlob(afterUpload.assetIds.res)).toBeInstanceOf(Blob)
    }

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

describe('describeDrillImageOrder：附图序号单一真源（UI 徽标与提示词共用）', () => {
  it('三图全配：图一=案例原图、图二=案例效果图、图三=参考图；与组装器编号一致', async () => {
    const { describeDrillImageOrder } = await import('$lib/presets/effectRefs')
    const order = describeDrillImageOrder({ hasCaseSrc: true, hasCaseRes: true, hasReference: true })
    expect(order.map((e) => `${e.ordinal}:${e.figureLabel}`)).toEqual(['1:案例-原图', '2:案例-效果图', '3:参考图'])
    expect(order.map((e) => e.figure)).toEqual(['一', '二', '三'])
    // 组装器引用同一编号（防两套口径漂移）
    const prompt = composeDrillPrompt('正文', { hasCaseSrc: true, hasCaseRes: true, hasReference: true })
    for (const e of order) expect(prompt).toContain(`【图${e.figure}：${e.figureLabel}】`)
  })

  it('仅效果图：编号前移（图一=效果图、图二=参考图），描述不再自引用【图一】', async () => {
    const { describeDrillImageOrder } = await import('$lib/presets/effectRefs')
    const order = describeDrillImageOrder({ hasCaseSrc: false, hasCaseRes: true, hasReference: true })
    expect(order.map((e) => e.figureLabel)).toEqual(['案例-效果图', '参考图'])
    const prompt = composeDrillPrompt('', { hasCaseSrc: false, hasCaseRes: true, hasReference: true })
    expect(prompt).toContain('基于未随附的原图完成 Partial Drill')
    expect(prompt).not.toMatch(/【图一：案例-效果图】[^\n]*基于【图一】/)
  })
})
