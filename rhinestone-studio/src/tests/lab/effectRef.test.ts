/*
 * 案例参照图（[Owner 2026-09-19 参照对退役 → 单张合成参照图模型]）：
 * - 组装器新形态：案例=一个条目「案例参照图」（图一），参考图随后；角色描述按布局（横/纵/单张）
 * - 绑定 API：上传两方案（pair 自动合成 / 单张直传）、粘贴链接提交即物化、解绑
 * - 物化管线：preset 幂等（meta.presetId 反查复用）；jsdom 无 2D → 降级 single（真机合成质量由走查验证）
 * - 请求链路：images = [案例合成图, 参考图]，prompt 含新角色声明；hydrate 迁移（preset/旧 url 对 → 物化改绑）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addVariant,
  getEffectRefCaseView,
  getTasks,
  getVariants,
  hydrate,
  materializePresetEffectRef,
  removeVariant,
  resetLabForTests,
  setReference,
  setVariantEffectRefPair,
  setVariantEffectRefSingle,
  setVariantEffectRefUrls,
  startRun,
  updateSettings,
  updateVariant,
} from '$lib/stores/lab.svelte'
import { getAssetBlob, listChildNodes, resetAssetStoreForTests, type AssetImage } from '$lib/persistence/assetStore'
import { ASSET_NODES_STORE, openDb } from '$lib/persistence/imageStore'
import { composeDrillPrompt, describeDrillImageOrder, EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

const B64 = 'aGVsbG8=' // "hello"

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function imageResponse(bytes: number[] = [1, 2, 3]): Response {
  return new Response(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
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
  // jsdom 的 Image 不解码：桩掉让 prepareReferenceImage 走「解码不可用回退原文件」路径；
  // 物化管线 loadDrawable 同用此桩（naturalWidth=64 → 有尺寸，compose 因无 2D 返 null 走降级）
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

/** preset 静态路径 / CDN 直链 → 图片字节；/images/edits → 成功回包。 */
function stubFetchWithImages(editsSeen?: FormData[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/images/edits')) {
      editsSeen?.push(init?.body as FormData)
      return okResponse()
    }
    return imageResponse()
  })
}

async function imagesUnder(parentId: string): Promise<AssetImage[]> {
  return (await listChildNodes(parentId)).filter((n): n is AssetImage => n.type === 'image')
}

/** 直接改写节点 meta（绕过 store API，测试专用——模拟历史版本产物等外部写入）。 */
function rewriteNodeMeta(
  db: IDBDatabase,
  nodeId: string,
  mutate: (meta: Record<string, unknown>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_NODES_STORE, 'readwrite')
    const store = tx.objectStore(ASSET_NODES_STORE)
    const req = store.get(nodeId)
    req.onsuccess = () => {
      const node = req.result as { meta?: Record<string, unknown> }
      if (!node) {
        reject(new Error(`节点不存在：${nodeId}`))
        return
      }
      node.meta = node.meta ?? {}
      mutate(node.meta)
      store.put(node)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

describe('composeDrillPrompt：案例参照图角色声明（[Owner] 参照对退役）', () => {
  it('合成横 + 参考：两图编号，角色描述说明左右两半，任务行引用「原图 → 贴钻效果」转换', () => {
    const prompt = composeDrillPrompt('模板特化正文', { hasCase: true, caseLayout: 'horizontal', hasReference: true })
    expect(prompt).toContain('我上传了2 张图片：')
    expect(prompt).toContain('1. 【图一：案例参照图】：案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。')
    expect(prompt).toContain('2. 【图二：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请参照【图一：案例参照图】所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为【图二：参考图】生成对应的 Partial Drill 效果图。')
    // 四条通用规则原文 + 参考图占位替换（{ref} = 【图二：参考图】）
    expect(prompt).toContain('保留【图二：参考图】的大面积背景与次要细节为原始画风/印刷效果')
    expect(prompt).toContain('完全保持【图二：参考图】的原有风格、构图与配色')
    expect(prompt).toContain('【模板风格补充】：\n模板特化正文')
    expect(prompt).toContain('请输出【图二：参考图】应用局部贴钻后的最终渲染效果图。')
  })

  it('合成纵 + 参考：角色描述说明上下两半', () => {
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'vertical', hasReference: true })
    expect(prompt).toContain('案例参照合成图：上半为未贴钻的原图，下半为其 Partial Drill（局部贴钻）成品效果图。')
    expect(prompt).toContain('请参照【图一：案例参照图】所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为【图二：参考图】生成')
  })

  it('单张 + 参考：单图描述 + 贴钻风格措辞（无原图半，不引用「转换」）', () => {
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'single', hasReference: true })
    expect(prompt).toContain('1. 【图一：案例参照图】：案例参照图：一张已完成的 Partial Drill（局部贴钻）效果图。')
    expect(prompt).toContain('2. 【图二：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请参考【图一：案例参照图】所展示的贴钻风格与选区逻辑，为【图二：参考图】生成对应的 Partial Drill 效果图。')
    expect(prompt).not.toContain('「原图 → 贴钻效果」转换')
  })

  it('仅案例（无参考）：同风格完整设计效果图', () => {
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'horizontal', hasReference: false })
    expect(prompt).toContain('我上传了一张图片：')
    expect(prompt).toContain('1. 【图一：案例参照图】')
    expect(prompt).toContain('请参考【图一：案例参照图】所展示的贴钻风格与选区逻辑，生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图。')
    // 无参考图：规则占位退化为「画面」
    expect(prompt).toContain('保留画面的大面积背景')
  })

  it('仅参考图：无案例声明，任务行直连规则', () => {
    const prompt = composeDrillPrompt('', { hasCase: false, caseLayout: 'single', hasReference: true })
    expect(prompt).toContain('我上传了一张图片：')
    expect(prompt).toContain('1. 【图一：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请为【图一：参考图】生成 Partial Drill（局部贴钻）效果图')
    expect(prompt).not.toContain('案例')
    expect(prompt).not.toContain('【模板风格补充】') // 模板体为空省略特化节
  })

  it('无任何附图（纯文生图）：省略角色声明，任务行无图指代', () => {
    const prompt = composeDrillPrompt('正文', { hasCase: false, caseLayout: 'single', hasReference: false })
    expect(prompt).not.toContain('我上传了')
    expect(prompt).not.toContain('【图')
    expect(prompt).toContain('请生成一张 Partial Drill（局部贴钻）风格的完整设计效果图')
    expect(prompt).toContain('请输出应用局部贴钻后的最终渲染效果图。')
  })
})

describe('describeDrillImageOrder：附图序号单一真源（UI 徽标与提示词共用）', () => {
  it('案例+参考：图一=案例参照图、图二=参考图；与组装器编号一致', () => {
    const order = describeDrillImageOrder({ hasCase: true, caseLayout: 'horizontal', hasReference: true })
    expect(order.map((e) => `${e.ordinal}:${e.figureLabel}`)).toEqual(['1:案例参照图', '2:参考图'])
    expect(order.map((e) => e.figure)).toEqual(['一', '二'])
    expect(order.map((e) => e.role)).toEqual(['case', 'reference'])
    // 组装器引用同一编号（防两套口径漂移）
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'horizontal', hasReference: true })
    for (const e of order) expect(prompt).toContain(`【图${e.figure}：${e.figureLabel}】`)
  })

  it('仅参考：图一=参考图（案例缺席时编号前移）', () => {
    const order = describeDrillImageOrder({ hasCase: false, caseLayout: 'single', hasReference: true })
    expect(order.map((e) => `${e.figure}:${e.figureLabel}`)).toEqual(['一:参考图'])
  })
})

describe('绑定 API：上传两方案 / 链接物化 / 解绑', () => {
  it('方案① 上传原图+效果图：合成入 sys-uploads 一个资产（jsdom 无 2D → 降级 single + degraded），变体挂 asset 引用', async () => {
    const variantId = getVariants()[0].id
    const result = await setVariantEffectRefPair(
      variantId,
      new File([new Uint8Array([1])], 'src.png', { type: 'image/png' }),
      new File([new Uint8Array([2, 2])], 'res.png', { type: 'image/png' }),
    )
    // jsdom 环境合成降级：效果图单张作为案例参照图
    expect(result.caseLayout).toBe('single')
    expect(result.degraded).toBe(true)

    const variant = getVariants().find((v) => v.id === variantId)
    expect(variant?.effectRef).toEqual({ kind: 'asset', assetId: result.assetId, caseLayout: 'single' })

    // 一个绑定只产出一个合成图资产（不再入两张原图/效果图）
    const uploads = await imagesUnder('sys-uploads')
    expect(uploads).toHaveLength(1)
    const blob = await getAssetBlob(result.assetId)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.size).toBe(2) // 降级 = 效果图字节本身

    // localStorage 里只有素材节点 id + 布局，没有图片本体
    const raw = localStorage.getItem('rhinestone-studio:variants') ?? ''
    expect(raw).toContain('"kind":"asset"')
    expect(raw).toContain('"caseLayout":"single"')
    expect(raw).not.toContain('data:image')
    expect(raw).not.toContain('blob:')
  })

  it('方案① 仅效果图（原图可选缺席）= 单张（非降级）', async () => {
    const variantId = getVariants()[0].id
    const result = await setVariantEffectRefPair(
      variantId,
      undefined,
      new File([new Uint8Array([3])], 'res.png', { type: 'image/png' }),
    )
    expect(result.caseLayout).toBe('single')
    expect(result.degraded).toBe(false)
    expect(getVariants().find((v) => v.id === variantId)?.effectRef).toEqual({
      kind: 'asset',
      assetId: result.assetId,
      caseLayout: 'single',
    })
  })

  it('方案② 上传单张案例图：直传绑定 single', async () => {
    const variantId = getVariants()[0].id
    const result = await setVariantEffectRefSingle(
      variantId,
      new File([new Uint8Array([7, 7, 7])], 'case.png', { type: 'image/png' }),
    )
    expect(result.caseLayout).toBe('single')
    const variant = getVariants().find((v) => v.id === variantId)
    expect(variant?.effectRef).toEqual({ kind: 'asset', assetId: result.assetId, caseLayout: 'single' })
    expect(await getAssetBlob(result.assetId)).toBeInstanceOf(Blob)
  })

  it('粘贴链接提交即物化：两 URL → fetch → 合成 → 入库绑定（jsdom 降级 single）；仅 res URL → 单张', async () => {
    const variantId = getVariants()[0].id
    vi.stubGlobal('fetch', stubFetchWithImages())
    const pair = await setVariantEffectRefUrls(variantId, 'https://cdn.example.com/src.jpg', 'https://cdn.example.com/res.jpg')
    expect(pair.caseLayout).toBe('single')
    expect(pair.degraded).toBe(true) // jsdom 无 2D
    expect(getVariants().find((v) => v.id === variantId)?.effectRef).toEqual({
      kind: 'asset',
      assetId: pair.assetId,
      caseLayout: 'single',
    })

    const single = await setVariantEffectRefUrls(variantId, undefined, 'https://cdn.example.com/res-only.jpg')
    expect(single.caseLayout).toBe('single')
    expect(single.degraded).toBe(false)
  })

  it('链接跨域失败：抛中文错误且不动旧绑定', async () => {
    const variantId = getVariants()[0].id
    await setVariantEffectRefSingle(variantId, new File([new Uint8Array([1])], 'c.png', { type: 'image/png' }))
    const before = getVariants().find((v) => v.id === variantId)?.effectRef

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(
      setVariantEffectRefUrls(variantId, undefined, 'https://bad.example/res.jpg'),
    ).rejects.toThrow('参考图链接跨域不可取，请下载后上传')
    expect(getVariants().find((v) => v.id === variantId)?.effectRef).toEqual(before)
  })

  it('解绑 → 回到空态；持久化新形态 roundtrip（reset+hydrate 后 asset 引用原样恢复）', async () => {
    const variantId = getVariants()[0].id
    const result = await setVariantEffectRefSingle(variantId, new File([new Uint8Array([5])], 'c.png', { type: 'image/png' }))
    const bound = { kind: 'asset', assetId: result.assetId, caseLayout: 'single' } as const

    resetLabForTests()
    await hydrate()
    const restored = getVariants().find((v) => v.id === variantId)
    expect(restored?.effectRef).toEqual(bound)
    // 展示辅助：asset → assetStore 冻结出口 objectURL
    const view = await getEffectRefCaseView(restored?.effectRef)
    expect(view?.caseLayout).toBe('single')
    expect(view?.url.startsWith('blob:mock-')).toBe(true)

    updateVariant(variantId, { effectRef: null })
    expect(getVariants().find((v) => v.id === variantId)?.effectRef).toBeNull()
  })
})

describe('物化管线：preset 幂等（meta.presetId 反查复用）', () => {
  it('materializePresetEffectRef：fetch 静态路径 → 入 sys-cases（meta.presetId）；重复调用复用同一资产', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(String(url).startsWith('/presets/')).toBe(true)
      return imageResponse()
    })
    vi.stubGlobal('fetch', fetchSpy)

    const first = await materializePresetEffectRef('new-orleans')
    expect(first.caseLayout).toBe('single') // jsdom 无 2D → 降级
    expect(first.degraded).toBe(true)
    const cases = await imagesUnder('sys-cases')
    const composite = cases.find((n) => (n.meta as { presetId?: string } | undefined)?.presetId === 'new-orleans')
    expect(composite).toBeDefined()
    expect(composite?.id).toBe(first.assetId)

    const second = await materializePresetEffectRef('new-orleans')
    expect(second.assetId).toBe(first.assetId)
    // 反查命中后不再发静态路径请求
    expect(fetchSpy.mock.calls.length).toBe(2) // src + res 各一次
  })

  it('preset 源版本变更（素材修正）后：旧版本合成资产不复用，重新物化新资产', async () => {
    // 素材修正 = 字节变化：旧版本物化用旧字节，改版本后的重物化拉到新字节
    let fetchSeq = 0
    // 注意：jsdom 下 new Response(Blob).blob() 会把 Blob 字符串化（字节恒定），
    // 变字节必须用 Uint8Array 作 body 才能穿透内容寻址去重
    const fetchSpy = vi.fn(async () => {
      const bytes = fetchSeq < 2 ? [1, 2, 3] : [9, 9, 9]
      fetchSeq += 1
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const first = await materializePresetEffectRef('new-orleans')
    expect(fetchSpy.mock.calls.length).toBe(2)

    // 模拟旧版本产物：把已物化资产的 meta.presetSrcVersion 改回 1
    const db = await openDb()
    await rewriteNodeMeta(db, first.assetId, (meta) => {
      meta.presetSrcVersion = 1
    })

    const second = await materializePresetEffectRef('new-orleans')
    expect(fetchSpy.mock.calls.length).toBe(4) // 反查未命中 → 重新拉取
    expect(second.assetId).not.toBe(first.assetId) // 旧版本不复用 → 新资产
    expect(second.degraded).toBe(true)
    const cases = await imagesUnder('sys-cases')
    const stamped = cases.filter((n) => (n.meta as { presetId?: string } | undefined)?.presetId === 'new-orleans')
    expect(stamped).toHaveLength(2) // 旧 + 新并存（旧资产生命周期归素材库/回收站）
  })

  it('getEffectRefCaseView：preset 过渡态 → 物化后给 objectURL；asset 软删 → null（显式失效）', async () => {
    vi.stubGlobal('fetch', stubFetchWithImages())
    const view = await getEffectRefCaseView({ kind: 'preset', presetId: 'boston' })
    expect(view?.caseLayout).toBe('single')
    expect(view?.url.startsWith('blob:mock-')).toBe(true)
    expect(await getEffectRefCaseView(null)).toBeNull()
  })
})

describe('生成请求链路：images = [案例合成图, 参考图]', () => {
  it('preset + 用户参考原图：edits 端点，image 顺序 = [案例合成图, 用户原图]，prompt 新角色声明；preset 首次使用物化并改绑', async () => {
    await setReference(new File([new Uint8Array([9])], 'wreath.png', { type: 'image/png' }))
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'new-orleans' } })

    const editCalls: FormData[] = []
    vi.stubGlobal('fetch', stubFetchWithImages(editCalls))

    const result = startRun()
    expect(result.ok).toBe(true)
    await waitFor(() => getTasks()[0]?.status === 'success')

    expect(editCalls).toHaveLength(1)
    const images = editCalls[0].getAll('image') as File[]
    // [Owner] 附图顺序 = 角色声明顺序：[案例参照图(合成), 参考图]
    expect(images.map((f) => f.name)).toEqual(['case-ref.jpg', 'wreath.png'])
    const prompt = String(editCalls[0].get('prompt'))
    expect(prompt).toContain('base rhinestone prompt')
    expect(prompt).toContain('我上传了2 张图片：')
    expect(prompt).toContain('1. 【图一：案例参照图】')
    expect(prompt).toContain('2. 【图二：参考图】')

    // 任务快照 + 变体在首次使用后物化改绑为 asset kind（重试免再物化）
    const task = getTasks()[0]
    expect(task.mode).toBe('edit')
    expect(task.effectRef?.kind).toBe('asset')
    expect(getVariants().find((v) => v.id === variantId)?.effectRef?.kind).toBe('asset')
    expect((task.debug?.requestBody as Record<string, unknown>).imageCount).toBe(2)
  })

  it('仅 preset 无用户参考：仍走 edits，单图 = 案例参照图，任务行「同风格完整设计」', async () => {
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'new-orleans' } })

    const editCalls: FormData[] = []
    vi.stubGlobal('fetch', stubFetchWithImages(editCalls))

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    const images = editCalls[0].getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['case-ref.jpg'])
    const prompt = String(editCalls[0].get('prompt'))
    expect(prompt).toContain('1. 【图一：案例参照图】')
    expect(prompt).toContain('生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图')
    expect(prompt).toContain('保留画面的大面积背景') // 无参考图：{ref} 退化为「画面」
  })

  it('asset kind 合成图进请求：blob 经 getAssetBlob 取回转 File', async () => {
    const variantId = focusSingleVariant()
    const bound = await setVariantEffectRefSingle(variantId, new File([new Uint8Array([4])], 'c.png', { type: 'image/png' }))

    const editCalls: FormData[] = []
    vi.stubGlobal('fetch', stubFetchWithImages(editCalls))

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    const images = editCalls[0].getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['case-ref.png'])
    const prompt = String(editCalls[0].get('prompt'))
    expect(prompt).toContain('【图一：案例参照图】')
    expect(getTasks()[0].effectRef).toEqual({ kind: 'asset', assetId: bound.assetId, caseLayout: 'single' })
  })

  it('preset 静态路径加载失败：任务级中文错误，不发 edits 请求', async () => {
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'new-orleans' } })

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
    expect(getTasks()[0].error).toContain('效果参考案例图加载失败，请重试')
    expect(getTasks()[0].error).toContain('Failed to fetch')
  })

  it('任务元数据持久化 asset 形态快照，reset+hydrate 后原样恢复（新形态不再迁移）', async () => {
    const variantId = focusSingleVariant()
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: 'boston' } })
    vi.stubGlobal('fetch', stubFetchWithImages())

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')
    expect(getTasks()[0].effectRef?.kind).toBe('asset') // 首次使用已物化改绑

    const persisted = localStorage.getItem('rhinestone-studio:tasks') ?? ''
    expect(persisted).toContain('"kind":"asset"')
    expect(persisted).toContain('"caseLayout"')

    resetLabForTests()
    await hydrate()
    expect(getTasks()[0].effectRef?.kind).toBe('asset')
  })
})

describe('hydrate 迁移：旧绑定一次性物化为合成图资产', () => {
  it('持久化 preset 过渡态：hydrate 物化改绑（sys-cases + meta.presetId）；二次 hydrate 复用同一资产零请求', async () => {
    resetLabForTests()
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify({ v: 2, items: [
        {
          id: 'tpl-wreath',
          name: '花环',
          prompt: 'wreath prompt',
          candidates: 1,
          enabled: true,
          effectRef: { kind: 'preset', presetId: 'wreath-border' },
        },
      ] }),
    )
    const fetchSpy = vi.fn(async (url: string) => {
      expect(String(url).startsWith('/presets/')).toBe(true)
      return imageResponse()
    })
    vi.stubGlobal('fetch', fetchSpy)

    await hydrate()
    let variant = getVariants()[0]
    expect(variant.effectRef?.kind).toBe('asset')
    // wreath-border 无原图对（srcImage 空串）→ 真单张（非降级）
    if (variant.effectRef?.kind !== 'asset') return
    expect(variant.effectRef.caseLayout).toBe('single')
    const cases = await imagesUnder('sys-cases')
    const composite = cases.find((n) => (n.meta as { presetId?: string } | undefined)?.presetId === 'wreath-border')
    expect(composite?.id).toBe(variant.effectRef.assetId)
    // localStorage 已改绑 asset kind（preset 过渡态消失）
    expect(localStorage.getItem('rhinestone-studio:variants')).toContain('"kind":"asset"')

    // 二次刷新：meta 反查命中 → 不再 fetch、同一资产
    resetLabForTests()
    await hydrate()
    variant = getVariants()[0]
    expect(variant.effectRef).toEqual({ kind: 'asset', assetId: composite?.id, caseLayout: 'single' })
    expect(fetchSpy.mock.calls.length).toBe(1) // 仅 res 一张（无原图对）
  })

  it('旧 url 对（任务快照）：hydrate 物化改绑为 asset kind', async () => {
    resetLabForTests()
    localStorage.setItem(
      'rhinestone-studio:tasks',
      JSON.stringify([
        {
          id: 'legacy-url-task',
          runId: 'run-legacy-url',
          variantId: 'v1',
          variantName: '旧变体',
          candidateIndex: 0,
          prompt: 'p',
          mode: 'edit',
          model: 'm',
          size: '1024x1024',
          advancedJson: '',
          status: 'error',
          hasReference: true,
          effectRef: { kind: 'url', srcUrl: 'https://cdn.example.com/src.jpg', resUrl: 'https://cdn.example.com/res.jpg' },
          imageStored: false,
          createdAt: 1700000000000,
        },
      ]),
    )
    vi.stubGlobal('fetch', stubFetchWithImages())

    await hydrate()
    const task = getTasks().find((t) => t.id === 'legacy-url-task')
    expect(task?.effectRef?.kind).toBe('asset')
    if (task?.effectRef?.kind !== 'asset') return
    expect(task.effectRef.caseLayout).toBe('single') // jsdom 降级
    expect(await getAssetBlob(task.effectRef.assetId)).toBeInstanceOf(Blob)
    // 旧载体已从持久化数据消失（改写为 asset 形态）
    expect(localStorage.getItem('rhinestone-studio:tasks')).not.toContain('"kind":"url"')
  })

  it('物化失败保留原持久化绑定（下次 hydrate 重试）：console.warn 且不改绑', async () => {
    resetLabForTests()
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify({ v: 2, items: [
        {
          id: 'tpl-off',
          name: '离线',
          prompt: 'p',
          candidates: 1,
          enabled: true,
          effectRef: { kind: 'preset', presetId: 'boston' },
        },
      ] }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await hydrate()
    // 物化失败：变体保持 preset 过渡态，localStorage 未被改写（下次重试）
    expect(getVariants()[0].effectRef).toEqual({ kind: 'preset', presetId: 'boston' })
    expect(localStorage.getItem('rhinestone-studio:variants')).toContain('"kind":"preset"')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('案例参照图融合：变体绑定生命周期', () => {
  it('默认变体与内置案例一一对应（8 组，每组带 preset 过渡态绑定）', () => {
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

    // 1. 粘贴链接提交即物化绑定
    vi.stubGlobal('fetch', stubFetchWithImages())
    const urlBound = await setVariantEffectRefUrls(variantId, undefined, 'https://cdn.example.com/r.jpg')
    expect(getVariants().find((v) => v.id === variantId)?.effectRef?.kind).toBe('asset')

    // 2. 上传替换绑定（B-2 语义入口：旧合成资产保留在库）
    const uploadBound = await setVariantEffectRefSingle(variantId, new File([new Uint8Array([3])], 'case.png', { type: 'image/png' }))
    const afterUpload = getVariants().find((v) => v.id === variantId)?.effectRef
    expect(afterUpload?.kind).toBe('asset')
    if (afterUpload?.kind !== 'asset') return
    expect(afterUpload.assetId).not.toBe(urlBound.assetId)
    expect(await getAssetBlob(urlBound.assetId)).toBeInstanceOf(Blob) // 旧资产仍在库

    // 3. 解绑 → 回到空态
    updateVariant(variantId, { effectRef: null })
    expect(getVariants().find((v) => v.id === variantId)?.effectRef).toBeNull()
    expect(uploadBound.assetId).toBeTruthy()
  })

  it('默认绑定的变体参与请求时带案例参照图（默认路径走 edits，首次使用物化）', async () => {
    const variantId = getVariants()[0].id
    for (const v of [...getVariants()]) {
      if (v.id !== variantId) removeVariant(v.id)
    }
    updateVariant(variantId, { candidates: 1 })

    const editCalls: FormData[] = []
    vi.stubGlobal('fetch', stubFetchWithImages(editCalls))

    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    const images = editCalls[0].getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['case-ref.jpg'])
    expect(getTasks()[0].mode).toBe('edit')
    expect(getTasks()[0].effectRef?.kind).toBe('asset')
  })
})
