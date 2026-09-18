import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeScaledSize,
  InputImageError,
  MAX_INPUT_DIMENSION,
  prepareReferenceImage,
} from '$lib/api/imageInput'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('computeScaledSize（>2048px canvas 降采样目标）', () => {
  it('边界内不缩放', () => {
    expect(computeScaledSize(1024, 1024, MAX_INPUT_DIMENSION)).toEqual({ width: 1024, height: 1024, scale: 1 })
    expect(computeScaledSize(2048, 100, MAX_INPUT_DIMENSION).scale).toBe(1)
  })

  it('宽图按长边缩到 2048', () => {
    const result = computeScaledSize(3000, 2000, MAX_INPUT_DIMENSION)
    expect(result.width).toBe(2048)
    expect(result.height).toBe(1365) // round(2000 * 2048/3000)
    expect(result.scale).toBeLessThan(1)
  })

  it('高图同理', () => {
    const result = computeScaledSize(1000, 3000, MAX_INPUT_DIMENSION)
    expect(result.height).toBe(2048)
    expect(result.width).toBe(683) // round(1000 * 2048/3000)
  })

  it('零尺寸不除零', () => {
    expect(computeScaledSize(0, 0, MAX_INPUT_DIMENSION).scale).toBe(1)
  })
})

describe('prepareReferenceImage（MIME 白名单 + 解码回退）', () => {
  it('非 PNG/JPEG/WebP 直接拒绝（中文提示，不发请求）', async () => {
    const gif = new File([new Uint8Array([1])], 'x.gif', { type: 'image/gif' })
    const error = await prepareReferenceImage(gif).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InputImageError)
    expect((error as Error).message).toContain('PNG')
    expect((error as Error).message).toContain('image/gif')
  })

  it('未知 MIME 同样拒绝', async () => {
    const weird = new File([new Uint8Array([1])], 'x.tiff', { type: 'image/tiff' })
    await expect(prepareReferenceImage(weird)).rejects.toBeInstanceOf(InputImageError)
  })

  it('解码失败时回退原文件不阻断（objectURL 生成）', async () => {
    const urlSpy = vi.fn(() => 'blob:mock-preview')
    vi.stubGlobal('URL', { ...URL, createObjectURL: urlSpy, revokeObjectURL: vi.fn() })
    class FailingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('Image', FailingImage)

    const png = new File([new Uint8Array([1])], 'ref.png', { type: 'image/png' })
    const prepared = await prepareReferenceImage(png)
    expect(prepared.file).toBe(png)
    expect(prepared.previewUrl).toBe('blob:mock-preview')
    expect(prepared.downscaled).toBe(false)
    expect(prepared.width).toBe(0)
  })

  it('解码成功且 ≤2048px：原文件直通', async () => {
    const urlSpy = vi.fn(() => 'blob:mock-preview')
    vi.stubGlobal('URL', { ...URL, createObjectURL: urlSpy, revokeObjectURL: vi.fn() })
    class OkImage {
      naturalWidth = 1024
      naturalHeight = 768
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)

    const png = new File([new Uint8Array([1])], 'ref.png', { type: 'image/png' })
    const prepared = await prepareReferenceImage(png)
    expect(prepared.file).toBe(png)
    expect(prepared.width).toBe(1024)
    expect(prepared.height).toBe(768)
    expect(prepared.downscaled).toBe(false)
  })

  it('超过 2048px 但 canvas 2D 不可用（无头环境）时回退原文件', async () => {
    const urlSpy = vi.fn(() => 'blob:mock-preview')
    vi.stubGlobal('URL', { ...URL, createObjectURL: urlSpy, revokeObjectURL: vi.fn() })
    class BigOkImage {
      naturalWidth = 4000
      naturalHeight = 3000
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', BigOkImage)

    const png = new File([new Uint8Array([1])], 'ref.png', { type: 'image/png' })
    const prepared = await prepareReferenceImage(png)
    // jsdom 无 canvas 2D：守卫路径返回原文件而非崩溃
    expect(prepared.file).toBe(png)
    expect(prepared.downscaled).toBe(false)
  })
})
