/*
 * 案例参照图（[Owner 2026-09-19 参照对退役 → 单张合成参照图模型]；
 * [add-project-files 4.3] 绑定写回目标 = gemtpl.caseBinding（templates store 写队列换绑））：
 * - 组装器形态：案例=一个条目「案例参照图」（图一），原图随后；角色描述按布局（横/纵/单张）
 * - 绑定 API：上传两方案（[Owner 2026-09-19] pair 原图必选两图缺一不可 / single 承担
 *   「仅一张图」语义）、粘贴链接提交即物化、解绑（B-2 不删旧资产）
 * - 物化管线：preset 幂等（meta.presetId 反查复用）；jsdom 无 2D → 降级 single（真机合成质量由走查验证）
 * - 请求链路：images = [案例合成图, 原图]，prompt 含角色声明；
 *   遗留任务快照的 preset 过渡态在重试时现场物化改绑（B.1.3 收窄后的唯一 preset 消费面）
 * - hydrate 迁移：旧载体（preset/url 对/upload）任务快照物化改绑为 asset kind
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEffectRefCaseView,
  getTasks,
  hydrate,
  materializePresetEffectRef,
  resetLabForTests,
  retryTask,
  setReference,
  setTemplateEffectRefPair,
  setTemplateEffectRefSingle,
  setTemplateEffectRefUrls,
  startRun,
  updateSettings,
} from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { getAssetBlob, listChildNodes, resetAssetStoreForTests, type AssetImage } from '$lib/persistence/assetStore'
import { ASSET_NODES_STORE, openDb } from '$lib/persistence/imageStore'
import { composeDrillPrompt, describeDrillImageOrder, EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import { drainFakeIndexedDBChains, installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

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
  // [4.3] 默认 fetch 桩：hydrate 的 seed 物化需要 /presets/ 图源（node fetch 拉不动相对路径）；
  // 生成端点给成功回包。测试自定 fetch 时 vi.stubGlobal 覆盖。
  vi.stubGlobal('fetch', seedFetchStub())
  resetAssetStoreForTests()
  localStorage.clear()
  resetLabForTests() // cancelAll 会持久化上一测试的内存任务——先复位再清，防 hydrate 捞回陈旧任务
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

/** [4.3] 默认桩：/presets/ 唯一字节图源 + 生成端点成功 + blob: URL 取回 PNG。 */
function seedFetchStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/presets/')) {
      const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return imageResponse([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239])
    }
    if (u.endsWith('/images/generations') || u.endsWith('/images/edits')) return okResponse()
    return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  })
}

afterEach(async () => {
  // [add-project-files 0.4] runTx 等 oncomplete 真提交后，归档/物化链每步多一跳
  // 宏任务，可能越过断言点仍在途——先排空再 unstub，避免迟到写入污染下一测试。
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 只留第一个模板（其余禁用）、一个候选：聚焦单任务请求。 */
async function focusSingleTemplate(prompt = 'base rhinestone prompt'): Promise<string> {
  await hydrate()
  const keep = getTemplateAssetIds()[0]
  for (const id of getTemplateAssetIds()) {
    if (id !== keep) setEnabledTemplate(id, false)
  }
  submitTemplateField(keep, { candidates: 1, promptBody: prompt })
  await whenTemplatesIdle()
  return keep
}

/** preset 静态路径 / CDN 直链 → 图片字节；/images/edits → 成功回包。 */
function stubFetchWithImages(editsSeen?: FormData[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
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
    expect(prompt).toContain('1. 【图一 [image #1]：案例参照图】：案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。')
    expect(prompt).toContain('2. 【图二 [image #2]：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请参照【图一 [image #1]：案例参照图】所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为【图二 [image #2]：参考图】生成对应的 Partial Drill 效果图。')
    // 四条通用规则原文 + 原图占位替换（{ref} = 【图二 [image #2]：参考图】）
    expect(prompt).toContain('保留【图二 [image #2]：参考图】的大面积背景与次要细节为原始画风/印刷效果')
    expect(prompt).toContain('完全保持【图二 [image #2]：参考图】的原有风格、构图与配色')
    expect(prompt).toContain('【模板风格补充】：\n模板特化正文')
    expect(prompt).toContain('请输出【图二 [image #2]：参考图】应用局部贴钻后的最终渲染效果图。')
  })

  it('合成纵 + 参考：角色描述说明上下两半', () => {
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'vertical', hasReference: true })
    expect(prompt).toContain('案例参照合成图：上半为未贴钻的原图，下半为其 Partial Drill（局部贴钻）成品效果图。')
    expect(prompt).toContain('请参照【图一 [image #1]：案例参照图】所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为【图二 [image #2]：参考图】生成')
  })

  it('单张 + 参考：单图描述 + 贴钻风格措辞（无原图半，不引用「转换」）', () => {
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'single', hasReference: true })
    expect(prompt).toContain('1. 【图一 [image #1]：案例参照图】：案例参照图：一张已完成的 Partial Drill（局部贴钻）效果图。')
    expect(prompt).toContain('2. 【图二 [image #2]：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请参考【图一 [image #1]：案例参照图】所展示的贴钻风格与选区逻辑，为【图二 [image #2]：参考图】生成对应的 Partial Drill 效果图。')
    expect(prompt).not.toContain('「原图 → 贴钻效果」转换')
  })

  it('仅案例（无参考）：同风格完整设计效果图', () => {
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'horizontal', hasReference: false })
    expect(prompt).toContain('我上传了一张图片：')
    expect(prompt).toContain('1. 【图一 [image #1]：案例参照图】')
    expect(prompt).toContain('请参考【图一 [image #1]：案例参照图】所展示的贴钻风格与选区逻辑，生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图。')
    // 无原图：规则占位退化为「画面」
    expect(prompt).toContain('保留画面的大面积背景')
  })

  it('仅原图：无案例声明，任务行直连规则', () => {
    const prompt = composeDrillPrompt('', { hasCase: false, caseLayout: 'single', hasReference: true })
    expect(prompt).toContain('我上传了一张图片：')
    expect(prompt).toContain('1. 【图一 [image #1]：参考图】：需要你处理的目标图像。')
    expect(prompt).toContain('请为【图一 [image #1]：参考图】生成 Partial Drill（局部贴钻）效果图')
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
  it('案例+参考：图一=案例参照图、图二=原图；与组装器编号一致', () => {
    const order = describeDrillImageOrder({ hasCase: true, caseLayout: 'horizontal', hasReference: true })
    // 提示词角色字面冻结为「参考图」（byteEq 红线）；UI 语义 = 原图
    expect(order.map((e) => `${e.ordinal}:${e.figureLabel}`)).toEqual(['1:案例参照图', '2:参考图'])
    expect(order.map((e) => e.figure)).toEqual(['一', '二'])
    expect(order.map((e) => e.role)).toEqual(['case', 'reference'])
    // 组装器引用同一编号（防两套口径漂移）
    const prompt = composeDrillPrompt('正文', { hasCase: true, caseLayout: 'horizontal', hasReference: true })
    for (const e of order) expect(prompt).toContain(`【图${e.figure} [image #${e.ordinal}]：${e.figureLabel}】`)
  })

  it('仅参考：图一=原图（案例缺席时编号前移）', () => {
    const order = describeDrillImageOrder({ hasCase: false, caseLayout: 'single', hasReference: true })
    expect(order.map((e) => `${e.figure}:${e.figureLabel}`)).toEqual(['一:参考图'])
  })
})

describe('绑定 API：上传两方案 / 链接物化 / 解绑（写回 caseBinding）', () => {
  it('方案① 上传原图+效果图（两图必传契约）：合成入 sys-uploads 一个资产（jsdom 无 2D → 降级 single + degraded），模板 caseBinding 挂资产引用', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    const result = await setTemplateEffectRefPair(
      templateId,
      new File([new Uint8Array([1])], 'src.png', { type: 'image/png' }),
      new File([new Uint8Array([2, 2])], 'res.png', { type: 'image/png' }),
    )
    // jsdom 环境合成降级：效果图单张作为案例参照图
    expect(result.caseLayout).toBe('single')
    expect(result.degraded).toBe(true)

    expect(getTemplateRecord(templateId)?.caseBinding).toEqual({ assetId: result.assetId, caseLayout: 'single' })

    // 一个绑定只产出一个合成图资产（不再入两张原图/效果图）
    const uploads = await imagesUnder('sys-uploads')
    expect(uploads).toHaveLength(1)
    const blob = await getAssetBlob(result.assetId)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.size).toBe(2) // 降级 = 效果图字节本身

    // 绑定随换绑落盘：gemtpl 文件内容含资产引用（无图片本体/dataURL）
    await whenTemplatesIdle()
    expect(JSON.stringify(getTemplateRecord(templateId))).not.toContain('data:image')
  })

  it('方案① 原图必选（[Owner 2026-09-19] 契约收窄）：「仅一张效果图」语义归 single 入口（非降级），pair 不再有 src 缺席降级路径', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    // 原「pair(src=undefined) = 单张（非降级）」用例的语义迁移：只有效果图 → setTemplateEffectRefSingle
    const result = await setTemplateEffectRefSingle(
      templateId,
      new File([new Uint8Array([3])], 'res.png', { type: 'image/png' }),
    )
    expect(result.caseLayout).toBe('single')
    expect(result.degraded).toBe(false)
    expect(getTemplateRecord(templateId)?.caseBinding).toEqual({
      assetId: result.assetId,
      caseLayout: 'single',
    })
  })

  it('方案② 上传单张案例图：直传绑定 single', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    const result = await setTemplateEffectRefSingle(
      templateId,
      new File([new Uint8Array([7, 7, 7])], 'case.png', { type: 'image/png' }),
    )
    expect(result.caseLayout).toBe('single')
    expect(getTemplateRecord(templateId)?.caseBinding).toEqual({ assetId: result.assetId, caseLayout: 'single' })
    expect(await getAssetBlob(result.assetId)).toBeInstanceOf(Blob)
  })

  it('粘贴链接提交即物化：两 URL → fetch → 合成 → 入库绑定（jsdom 降级 single）；仅 res URL → 单张', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    vi.stubGlobal('fetch', stubFetchWithImages())
    const pair = await setTemplateEffectRefUrls(templateId, 'https://cdn.example.com/src.jpg', 'https://cdn.example.com/res.jpg')
    expect(pair.caseLayout).toBe('single')
    expect(pair.degraded).toBe(true) // jsdom 无 2D
    expect(getTemplateRecord(templateId)?.caseBinding).toEqual({
      assetId: pair.assetId,
      caseLayout: 'single',
    })

    const single = await setTemplateEffectRefUrls(templateId, undefined, 'https://cdn.example.com/res-only.jpg')
    expect(single.caseLayout).toBe('single')
    expect(single.degraded).toBe(false)
  })

  it('链接跨域失败：抛中文错误且不动旧绑定', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    await setTemplateEffectRefSingle(templateId, new File([new Uint8Array([1])], 'c.png', { type: 'image/png' }))
    const before = getTemplateRecord(templateId)?.caseBinding

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(setTemplateEffectRefUrls(templateId, undefined, 'https://bad.example/res.jpg')).rejects.toThrow(
      '原图链接跨域不可取，请下载后上传',
    )
    expect(getTemplateRecord(templateId)?.caseBinding).toEqual(before)
  })

  it('解绑 → 回到空态；换绑落盘后 reset+hydrate 从库恢复（库是真源）', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    const result = await setTemplateEffectRefSingle(templateId, new File([new Uint8Array([5])], 'c.png', { type: 'image/png' }))
    const bound = { assetId: result.assetId, caseLayout: 'single' as const }
    await whenTemplatesIdle()

    resetLabForTests()
    await hydrate()
    expect(getTemplateRecord(templateId)?.caseBinding).toEqual(bound)
    // 展示辅助：caseBinding → assetStore 冻结出口 objectURL
    const view = await getEffectRefCaseView({ kind: 'asset', ...bound })
    expect(view?.caseLayout).toBe('single')
    expect(view?.url.startsWith('blob:mock-')).toBe(true)

    submitTemplateField(templateId, { caseBinding: null })
    expect(getTemplateRecord(templateId)?.caseBinding).toBeNull()
    await whenTemplatesIdle()
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

describe('生成请求链路：images = [案例合成图, 原图]', () => {
  it('模板案例绑定 + 用户原图：edits 端点，image 顺序 = [案例合成图, 用户原图]，prompt 新角色声明', async () => {
    await setReference(new File([new Uint8Array([9])], 'wreath.png', { type: 'image/png' }))
    const templateId = await focusSingleTemplate()

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith('/images/edits')) {
          editCalls.push(init?.body as FormData)
          return okResponse()
        }
        return imageResponse()
      }),
    )

    const result = startRun()
    expect(result.ok).toBe(true)
    await waitFor(() => getTasks()[0]?.status === 'success')

    expect(editCalls).toHaveLength(1)
    const images = editCalls[0].getAll('image') as File[]
    // [Owner] 附图顺序 = 角色声明顺序：[案例参照图(合成), 原图]
    expect(images.map((f) => f.name)).toEqual(['case-ref.jpg', 'wreath.png'])
    const prompt = String(editCalls[0].get('prompt'))
    expect(prompt).toContain('base rhinestone prompt')
    expect(prompt).toContain('我上传了2 张图片：')
    expect(prompt).toContain('1. 【图一 [image #1]：案例参照图】')
    expect(prompt).toContain('2. 【图二 [image #2]：参考图】')

    // [B.1.4] 任务快照 = 模板的 caseBinding（asset kind）+ templateAssetId
    const task = getTasks()[0]
    expect(task.mode).toBe('edit')
    expect(task.effectRef?.kind).toBe('asset')
    expect(task.templateAssetId).toBe(templateId)
    expect((task.debug?.requestBody as Record<string, unknown>).imageCount).toBe(2)
  })

  it('仅案例绑定无用户参考：仍走 edits，单图 = 案例参照图，任务行「同风格完整设计」', async () => {
    await focusSingleTemplate()

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
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
    expect(images.map((f) => f.name)).toEqual(['case-ref.jpg'])
    const prompt = String(editCalls[0].get('prompt'))
    expect(prompt).toContain('1. 【图一 [image #1]：案例参照图】')
    expect(prompt).toContain('生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图')
    expect(prompt).toContain('保留画面的大面积背景') // 无原图：{ref} 退化为「画面」
  })

  it('asset kind 合成图进请求：blob 经 getAssetBlob 取回转 File；任务快照 = caseBinding', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) {
      if (id !== templateId) setEnabledTemplate(id, false)
    }
    const bound = await setTemplateEffectRefSingle(templateId, new File([new Uint8Array([4])], 'c.png', { type: 'image/png' }))
    submitTemplateField(templateId, { candidates: 1, promptBody: 'single bound prompt' })
    await whenTemplatesIdle()

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
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
    expect(images.map((f) => f.name)).toEqual(['case-ref.png'])
    const prompt = String(editCalls[0].get('prompt'))
    expect(prompt).toContain('【图一 [image #1]：案例参照图】')
    expect(getTasks()[0].effectRef).toEqual({ kind: 'asset', assetId: bound.assetId, caseLayout: 'single' })
  })

  it('遗留任务 preset 快照重试：现场物化（幂等）后改绑 asset；物化失败给任务级中文错误', async () => {
    // [B.1.3 收窄] preset 过渡态只剩遗留持久化任务重试这一消费面
    localStorage.setItem(
      'rhinestone-studio:tasks',
      JSON.stringify([
        {
          id: 'legacy-preset-task',
          runId: 'run-legacy-preset',
          variantId: 'tpl-new-orleans',
          variantName: '旧模板',
          candidateIndex: 0,
          prompt: 'p',
          mode: 'edit',
          model: 'm',
          size: '1024x1024',
          advancedJson: '',
          status: 'error',
          hasReference: false,
          effectRef: { kind: 'preset', presetId: 'new-orleans' },
          imageStored: false,
          createdAt: 1700000000000,
        },
      ]),
    )
    vi.stubGlobal('fetch', stubFetchWithImages())
    await hydrate()
    const restored = getTasks().find((t) => t.id === 'legacy-preset-task')
    expect(restored).toBeDefined()

    retryTask(restored!.id)
    await waitFor(() => restored!.status === 'success')

    // 首次使用后物化改绑（重试免再物化）
    expect(restored!.effectRef?.kind).toBe('asset')
    const cases = await imagesUnder('sys-cases')
    expect(cases.some((n) => (n.meta as { presetId?: string } | undefined)?.presetId === 'new-orleans')).toBe(true)

    // 物化失败路径（离线）：任务级中文错误，不发 edits 请求
    // （用 boston：part 1 已把 new-orleans 物化进 sys-cases，幂等反查会绕过 fetch）
    const offlineTask = {
      id: 'legacy-preset-offline',
      runId: 'run-offline',
      variantId: 'tpl-boston',
      variantName: '旧模板2',
      candidateIndex: 0,
      prompt: 'p',
      mode: 'edit' as const,
      model: 'm',
      size: '1024x1024',
      advancedJson: '',
      status: 'error' as const,
      hasReference: false,
      effectRef: { kind: 'preset', presetId: 'boston' },
      imageStored: false,
      createdAt: 1700000001000,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    resetLabForTests()
    localStorage.setItem('rhinestone-studio:tasks', JSON.stringify([offlineTask]))
    await hydrate()
    const offline = getTasks().find((t) => t.id === 'legacy-preset-offline')
    expect(offline).toBeDefined()
    retryTask(offline!.id)
    await waitFor(() => offline!.status === 'error')
    expect(offline!.error).toContain('效果参考案例图加载失败，请重试')
  })

  it('任务元数据持久化 asset 形态快照，reset+hydrate 后原样恢复（新形态不再迁移）', async () => {
    await focusSingleTemplate()
    vi.stubGlobal('fetch', stubFetchWithImages())

    startRun()
    // 持久化在归档链（runTx 等 oncomplete 真提交）落定后的 finally 里发生——
    // waitFor 需同步等待落盘快照，而非只等内存态 success。
    await waitFor(
      () =>
        getTasks()[0]?.status === 'success' &&
        (localStorage.getItem('rhinestone-studio:tasks') ?? '').includes('"kind":"asset"'),
    )
    expect(getTasks()[0].effectRef?.kind).toBe('asset') // seed 物化后即 asset 绑定快照

    const persisted = localStorage.getItem('rhinestone-studio:tasks') ?? ''
    expect(persisted).toContain('"kind":"asset"')
    expect(persisted).toContain('"caseLayout"')
    expect(persisted).toContain('"templateAssetId"')

    resetLabForTests()
    await hydrate()
    expect(getTasks()[0].effectRef?.kind).toBe('asset')
    expect(getTasks()[0].templateAssetId).toMatch(/^ast-tpl-/)
  })
})

describe('hydrate 迁移：旧绑定一次性物化为合成图资产（任务快照）', () => {
  it('持久化 preset 过渡态（任务快照）：hydrate 物化改绑（sys-cases + meta.presetId）', async () => {
    localStorage.setItem(
      'rhinestone-studio:tasks',
      JSON.stringify([
        {
          id: 'preset-task',
          runId: 'run-preset',
          variantId: 'tpl-wreath',
          variantName: '花环',
          candidateIndex: 0,
          prompt: 'wreath prompt',
          mode: 'edit',
          model: 'm',
          size: '1024x1024',
          advancedJson: '',
          status: 'error',
          hasReference: false,
          effectRef: { kind: 'preset', presetId: 'wreath-border' },
          imageStored: false,
          createdAt: 1700000000000,
        },
      ]),
    )
    const fetchSpy = vi.fn(async (url: string) => {
      expect(String(url).startsWith('/presets/')).toBe(true)
      return imageResponse()
    })
    vi.stubGlobal('fetch', fetchSpy)

    await hydrate()
    const task = getTasks().find((t) => t.id === 'preset-task')
    expect(task?.effectRef?.kind).toBe('asset')
    // wreath-border 无原图对（srcImage 空串）→ 真单张
    if (task?.effectRef?.kind !== 'asset') return
    expect(task.effectRef.caseLayout).toBe('single')
    const cases = await imagesUnder('sys-cases')
    const composite = cases.find((n) => (n.meta as { presetId?: string } | undefined)?.presetId === 'wreath-border')
    expect(composite?.id).toBe(task.effectRef.assetId)
    // 持久化已改绑 asset kind（preset 过渡态消失）
    expect(localStorage.getItem('rhinestone-studio:tasks')).toContain('"kind":"asset"')
  })

  it('旧 url 对（任务快照）：hydrate 物化改绑为 asset kind', async () => {
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
    localStorage.setItem(
      'rhinestone-studio:tasks',
      JSON.stringify([
        {
          id: 'offline-preset-task',
          runId: 'run-offline-preset',
          variantId: 'tpl-off',
          variantName: '离线',
          candidateIndex: 0,
          prompt: 'p',
          mode: 'edit',
          model: 'm',
          size: '1024x1024',
          advancedJson: '',
          status: 'error',
          hasReference: false,
          effectRef: { kind: 'preset', presetId: 'boston' },
          imageStored: false,
          createdAt: 1700000000000,
        },
      ]),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await hydrate()
    // 物化失败：任务快照保持 preset 过渡态，持久化未被改写（下次重试）
    const task = getTasks().find((t) => t.id === 'offline-preset-task')
    expect(task?.effectRef).toEqual({ kind: 'preset', presetId: 'boston' })
    expect(localStorage.getItem('rhinestone-studio:tasks')).toContain('"kind":"preset"')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('案例参照图融合：模板绑定生命周期', () => {
  it('内置模板与合成案例一一对应（hydrate seed 8 条，全部为 asset 绑定入 sys-cases）', async () => {
    await hydrate()
    const ids = getTemplateAssetIds()
    expect(EFFECT_REF_PRESETS).toHaveLength(8)
    expect(ids).toHaveLength(8)
    ids.forEach((id, i) => {
      const record = getTemplateRecord(id)
      expect(record?.name).toBe(EFFECT_REF_PRESETS[i].name)
      expect(record?.promptBody).toBe(`${EFFECT_REF_PRESETS[i].prompt}\n【案例参照图提示词】`) // [placeholders] v2
      // seed 物化后恒为 asset 绑定（preset kind 收窄出模板面）
      expect(record?.caseBinding).not.toBeNull()
      expect(record?.caseBinding?.assetId).toMatch(/^ast-/)
    })
  })

  it('新建模板为空态（无绑定）：不阻断生成，纯 prompt 走 generations', async () => {
    const { createTemplate } = await import('$lib/stores/templates.svelte')
    await hydrate()
    const created = await createTemplate()
    expect(created).not.toBeNull()
    expect(getTemplateRecord(created as string)?.caseBinding).toBeNull()

    for (const id of getTemplateAssetIds()) {
      if (id !== created) setEnabledTemplate(id, false)
    }
    submitTemplateField(created as string, { candidates: 1, promptBody: 'pure prompt run' })
    await whenTemplatesIdle()

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

  it('空态 → 粘贴链接绑定 → 替换为上传绑定 → 解绑（store 级流程，B-2 旧资产保留）', async () => {
    const { createTemplate } = await import('$lib/stores/templates.svelte')
    await hydrate()
    const created = await createTemplate()
    expect(created).not.toBeNull()
    const templateId = created as string
    expect(getTemplateRecord(templateId)?.caseBinding).toBeNull()

    // 1. 粘贴链接提交即物化绑定
    vi.stubGlobal('fetch', stubFetchWithImages())
    const urlBound = await setTemplateEffectRefUrls(templateId, undefined, 'https://cdn.example.com/r.jpg')
    expect(getTemplateRecord(templateId)?.caseBinding?.assetId).toBe(urlBound.assetId)

    // 2. 上传替换绑定（B-2 语义入口：旧合成资产保留在库）
    const uploadBound = await setTemplateEffectRefSingle(templateId, new File([new Uint8Array([3])], 'case.png', { type: 'image/png' }))
    const afterUpload = getTemplateRecord(templateId)?.caseBinding
    expect(afterUpload?.assetId).not.toBe(urlBound.assetId)
    expect(await getAssetBlob(urlBound.assetId)).toBeInstanceOf(Blob) // 旧资产仍在库

    // 3. 解绑 → 回到空态
    submitTemplateField(templateId, { caseBinding: null })
    expect(getTemplateRecord(templateId)?.caseBinding).toBeNull()
    expect(uploadBound.assetId).toBeTruthy()
  })

  it('默认绑定的模板参与请求时带案例参照图（默认路径走 edits）', async () => {
    await hydrate()
    const templateId = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) {
      if (id !== templateId) setEnabledTemplate(id, false)
    }
    submitTemplateField(templateId, { candidates: 1 })
    await whenTemplatesIdle()

    const editCalls: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
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
    expect(images.map((f) => f.name)).toEqual(['case-ref.jpg'])
    expect(getTasks()[0].mode).toBe('edit')
    expect(getTasks()[0].effectRef?.kind).toBe('asset')
  })
})
