/**
 * handoff 图像消费单点（openspec add-project-files design §9.2 B2，切片 0.6，fake IDB）：
 *
 * - 图片节点直取（字节/mime 原样零处理）/ gemgen 解内嵌图（字节与 dataUrl 内嵌一致、
 *   零重编码 mime 保持）
 * - typed error 三态可辨：缺失（HandoffImageMissingError，含软删与物理记录丢失）/
 *   非 gemgen 节点（HandoffImageKindError，图片节点与非 gemgen 项目节点分别）/ 版本超前
 *   （手工构造 formatVersion+1 blob 入库 → LabFileVersionError）/ 损坏（LabFileFieldError）
 * - studio 消费点收口：loadFromHandoff 改经 getHandoffImageBlob——gemgen 档案可作
 *   handoff 载荷（origin handoff + pin）；HandoffPayload 形状零变化（引用/键集断言）。
 *
 * 契约类型/错误唯一来源：projectTypes / labFile / handoffImage（本文件只消费不重定义）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getGemgenImageBlob,
  getHandoffImageBlob,
  HandoffImageError,
  HandoffImageKindError,
  HandoffImageMissingError,
} from '$lib/persistence/handoffImage'
import {
  ingestAsset,
  ingestProjectAsset,
  isAssetPinned,
  resetAssetStoreForTests,
  trashAsset,
} from '$lib/persistence/assetStore'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import {
  LabFileFieldError,
  LabFileVersionError,
  serializeGemgen,
  type GemgenFileInput,
} from '$lib/persistence/labFile'
import { blobToDataUrl } from '$lib/persistence/imageStore'
import {
  getLoadError,
  getSourceImage,
  loadFromHandoff,
  resetStudioForTests,
} from '$lib/stores/studio.svelte'
import { getHandoff, setHandoff } from '$lib/stores/handoff.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let restoreCanvasCtx: (() => void) | null = null

// PNG 魔数头 + IHDR 前缀样本（字节等价断言用，非完整 PNG；与 labFile.test 同源口径）
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES))
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

const GEMGEN_INPUT: GemgenFileInput = {
  appVersion: '0.1.0-test',
  createdAt: 1758000000444,
  savedAt: 1758000000555,
  name: '城市分层·全要素·候选2',
  image: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 1024, height: 1024 },
  provenance: {
    runId: 'run-1',
    templateAssetId: 'ast-tpl-new-orleans',
    templateName: '城市分层·全要素',
    promptBody: '保持场景各层次的完整节日构图。',
    composedPrompt: '你是一位专业的钻石画……全文快照（审计真源）',
    candidateIndex: 1,
    mode: 'edit',
    model: 'gpt-image-2.5',
    size: '1024x1024',
  },
}

async function ingestGemgen(text: string, name = '档案.gemgen') {
  const result = await ingestProjectAsset({
    blob: new Blob([text], { type: PROJECT_MIME.gemgen }),
    name,
    projectKind: 'gemgen',
    summary: { templateName: '城市分层·全要素', candidateIndex: 1 },
  })
  return result.node
}

function gemgenText(payload: Record<string, unknown> = {}): string {
  const base = JSON.parse(serializeGemgen(GEMGEN_INPUT))
  return JSON.stringify({ ...base, ...payload })
}

async function ingestImage(bytes: number[], name = 'pic.png') {
  const { node } = await ingestAsset({
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    name,
    width: 64,
    height: 48,
    parentId: null,
    source: 'upload',
  })
  return node
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())]
}

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetStudioForTests()
  localStorage.clear()
})

afterEach(async () => {
  // 排空 fake IDB 在途异步链，防迟到副作用跨过 reset 边界（fakeIndexedDB 文件头契约）
  await Promise.resolve()
  restoreCanvasCtx?.()
  restoreCanvasCtx = null
  vi.unstubAllGlobals()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// getHandoffImageBlob / getGemgenImageBlob：单点分流与零重编码
// ---------------------------------------------------------------------------

describe('getHandoffImageBlob：单点分流', () => {
  it('图片节点直取：字节与 mime 原样（零处理），与 getAssetBlob 逐字节一致', async () => {
    const node = await ingestImage([9, 8, 7, 6], 'gen-1.png')
    const blob = await getHandoffImageBlob(node.id)
    expect(await bytesOf(blob)).toEqual([9, 8, 7, 6])
    expect(blob.type).toBe('image/png')
  })

  it('gemgen 档案：解内嵌图，字节与 dataUrl 内嵌一致、mime 保持（零重编码）', async () => {
    const node = await ingestGemgen(serializeGemgen(GEMGEN_INPUT))
    const blob = await getHandoffImageBlob(node.id)
    expect(await bytesOf(blob)).toEqual(PNG_BYTES)
    expect(blob.type).toBe('image/png')

    // 两个出口等价（getGemgenImageBlob 是档案专用口，getHandoffImageBlob 是统一入口）
    const direct = await getGemgenImageBlob(node.id)
    expect(await bytesOf(direct)).toEqual(await bytesOf(blob))
    expect(direct.type).toBe(blob.type)
  })

  it('缺失：不存在的 id → HandoffImageMissingError（携带 assetId）', async () => {
    const error = await getHandoffImageBlob('ast-nonexistent').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HandoffImageMissingError)
    expect(error).toBeInstanceOf(HandoffImageError)
    expect((error as HandoffImageMissingError).assetId).toBe('ast-nonexistent')
  })

  it('非 gemgen 节点分别可辨：图片节点与非 gemgen 项目节点均 HandoffImageKindError', async () => {
    const image = await ingestImage([1], 'i.png')
    const imageError = await getGemgenImageBlob(image.id).catch((e: unknown) => e)
    expect(imageError).toBeInstanceOf(HandoffImageKindError)
    expect((imageError as HandoffImageKindError).found).toBe('图片节点')
    expect((imageError as HandoffImageKindError).assetId).toBe(image.id)

    const proj = await ingestProjectAsset({
      blob: new Blob(['{"kind":"gemproj","formatVersion":1}'], { type: PROJECT_MIME.gemproj }),
      name: '工程.gemproj',
      projectKind: 'gemproj',
    })
    const projError = await getGemgenImageBlob(proj.node.id).catch((e: unknown) => e)
    expect(projError).toBeInstanceOf(HandoffImageKindError)
    expect((projError as HandoffImageKindError).found).toBe('gemproj 项目节点')
    // 统一入口同口径（非 gemgen 项目不可作为 handoff 图像消费）
    await expect(getHandoffImageBlob(proj.node.id)).rejects.toBeInstanceOf(HandoffImageKindError)
  })

  it('版本超前：手工构造 formatVersion+1 blob 入库 → LabFileVersionError（不猜测解析）', async () => {
    const node = await ingestGemgen(
      gemgenText({ formatVersion: 2, savedAt: 1758000000999 }),
      '未来.gemgen',
    )
    const error = await getGemgenImageBlob(node.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LabFileVersionError)
    expect((error as LabFileVersionError).kind).toBe('gemgen')
    expect((error as LabFileVersionError).foundVersion).toBe(2)
    expect((error as LabFileVersionError).supportedVersion).toBe(1)
  })

  it('损坏分别可辨：非 JSON 字节 → LabFileFieldError（文档根）；坏 dataUrl → 路径 image.dataUrl', async () => {
    const raw = await ingestGemgen('###not-json###', '坏档.gemgen')
    const rootError = await getGemgenImageBlob(raw.id).catch((e: unknown) => e)
    expect(rootError).toBeInstanceOf(LabFileFieldError)
    expect((rootError as LabFileFieldError).path).toBe('')

    const tampered = await ingestGemgen(gemgenText({ image: { mime: 'image/png', dataUrl: 'https://example.com/x.png', width: 4, height: 4 } }), '坏图.gemgen')
    const fieldError = await getGemgenImageBlob(tampered.id).catch((e: unknown) => e)
    expect(fieldError).toBeInstanceOf(LabFileFieldError)
    expect((fieldError as LabFileFieldError).path).toBe('image.dataUrl')
  })

  it('软删（回收站）与物理记录丢失均落缺失口径：HandoffImageMissingError', async () => {
    const node = await ingestGemgen(serializeGemgen(GEMGEN_INPUT))
    await trashAsset(node.id)
    await expect(getGemgenImageBlob(node.id)).rejects.toBeInstanceOf(HandoffImageMissingError)
    await expect(getHandoffImageBlob(node.id)).rejects.toBeInstanceOf(HandoffImageMissingError)

    const trashedImage = await ingestImage([2, 2], 't.png')
    await trashAsset(trashedImage.id)
    await expect(getHandoffImageBlob(trashedImage.id)).rejects.toBeInstanceOf(HandoffImageMissingError)
  })
})

// ---------------------------------------------------------------------------
// studio 消费点收口（loadFromHandoff 改经单点出口）
// ---------------------------------------------------------------------------

describe('studio.loadFromHandoff 收口（0.6）', () => {
  /** 最小解码桩（studioAssetIntegration 同款）：Image 立即 onload；canvas 2d 软桩 */
  function stubDecoding() {
    class OkImage {
      naturalWidth = 64
      naturalHeight = 48
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)
    const ctxStub = {
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
    }
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext
    restoreCanvasCtx = () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  }

  it('gemgen 档案可作 handoff 载荷：载入成功、origin handoff + pin、dataUrl 与内嵌字节往返等价', async () => {
    stubDecoding()
    const node = await ingestGemgen(serializeGemgen(GEMGEN_INPUT))
    setHandoff({ assetId: node.id, name: '城市分层·全要素·候选2' })

    const ok = await loadFromHandoff()
    expect(ok).toBe(true)
    const source = getSourceImage()
    expect(source?.origin).toBe('handoff')
    expect(source?.assetId).toBe(node.id)
    expect(source?.name).toBe('城市分层·全要素·候选2')
    // 零重编码可观察面：取出 blob 的 base64 与档案内嵌 dataUrl 完全一致
    expect(source?.dataUrl).toBe(PNG_DATA_URL)
    expect(isAssetPinned(node.id)).toBe(true)
    expect(getHandoff()).toBeNull()
  })

  it('HandoffPayload 形状零变化：键集恰为三键，消费全程字段不被改写/不加键', async () => {
    stubDecoding()
    const gemgen = await ingestGemgen(serializeGemgen(GEMGEN_INPUT))
    const reference = await ingestImage([7, 7], 'ref-original.png')
    const payload = { assetId: gemgen.id, name: 'x.png', referenceAssetId: reference.id }
    setHandoff(payload)

    // setHandoff 后形状保持（$state 深代理，断言以键集+字段值为准）：不克隆改写、不加键
    const peeked = getHandoff()
    expect(peeked).not.toBeNull()
    expect(Object.keys(peeked as object)).toEqual(['assetId', 'name', 'referenceAssetId'])
    expect((peeked as typeof payload).assetId).toBe(payload.assetId)
    expect((peeked as typeof payload).name).toBe(payload.name)
    expect((peeked as typeof payload).referenceAssetId).toBe(payload.referenceAssetId)

    const ok = await loadFromHandoff()
    expect(ok).toBe(true)
    expect(getHandoff()).toBeNull() // 消费后清空（payload 对象本身不被就地改写）
    expect(Object.keys(payload)).toEqual(['assetId', 'name', 'referenceAssetId'])
    expect(payload.name).toBe('x.png')
  })

  it('版本超前的 gemgen 载荷：missing 文案之外的 typed 详情透传（三态可辨的 studio 出口）', async () => {
    stubDecoding()
    const node = await ingestGemgen(gemgenText({ formatVersion: 2 }), '未来.gemgen')
    setHandoff({ assetId: node.id, name: '未来.gemgen' })
    const ok = await loadFromHandoff()
    expect(ok).toBe(false)
    expect(getSourceImage()).toBeNull()
    expect(getHandoff()).toBeNull()
    expect(getLoadError()).toContain('文件来自更新版本的应用')
  })
})

// blobToDataUrl 的直接消费（图片直取路径）：确认零处理链上无多余转换
describe('图片直取路径的 blob 可编码性', () => {
  it('getHandoffImageBlob 返回的 blob 可直接 blobToDataUrl（与 ingest 字节往返等价）', async () => {
    const node = await ingestImage([3, 1, 4, 1, 5], 'roundtrip.png')
    const blob = await getHandoffImageBlob(node.id)
    const dataUrl = await blobToDataUrl(blob)
    expect(dataUrl).toBe(`data:image/png;base64,${btoa(String.fromCharCode(3, 1, 4, 1, 5))}`)
  })
})
