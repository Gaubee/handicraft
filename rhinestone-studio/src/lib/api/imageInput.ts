/**
 * 原图上传预处理（移植自 openai-image-webui src/lib/imageInput.ts）。
 *
 * - MIME 白名单 png / jpeg / webp
 * - 任一边 > 2048px 时 canvas 降采样：PNG 保 alpha 原格式重编码，JPEG/WebP 质量 0.92
 * - 解码失败（极端浏览器/测试环境）时回退原文件，不阻断上传
 */

export const ACCEPTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_INPUT_DIMENSION = 2048
const RESIZED_JPEG_QUALITY = 0.92

export class InputImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputImageError'
  }
}

export interface PreparedReferenceImage {
  /** 预处理后的文件（可能是降采样重编码后的新 File）。 */
  file: File
  /** 预览 objectURL，调用方负责在替换/移除时 revoke。 */
  previewUrl: string
  width: number
  height: number
  /** 是否发生了降采样。 */
  downscaled: boolean
}

/** 降采样目标尺寸（纯函数，供单测）。 */
export function computeScaledSize(width: number, height: number, maxDimension: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height)
  if (longest <= maxDimension || longest === 0) return { width, height, scale: 1 }
  const scale = maxDimension / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

function loadImageElement(blob: Blob): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new InputImageError('图片解码失败，请换一张 PNG / JPEG / WebP。'))
    }
    img.src = url
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new InputImageError('降采样重编码失败。'))),
      mime,
      quality,
    )
  })
}

function isAcceptedMime(mime: string): boolean {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mime)
}

/**
 * 校验 + 预处理原图。
 * 非 JPG/PNG/WebP 直接抛 InputImageError（中文提示）。
 */
export async function prepareReferenceImage(file: File): Promise<PreparedReferenceImage> {
  if (!isAcceptedMime(file.type)) {
    throw new InputImageError(
      `不支持的图片类型：${file.type || '未知'}。请使用 PNG、JPEG 或 WebP。`,
    )
  }

  let decoded: { img: HTMLImageElement; revoke: () => void }
  try {
    decoded = await loadImageElement(file)
  } catch {
    // 解码不可用（无头环境等）：回退原文件，让 upstream 兜底校验。
    return {
      file,
      previewUrl: URL.createObjectURL(file),
      width: 0,
      height: 0,
      downscaled: false,
    }
  }

  try {
    const naturalWidth = decoded.img.naturalWidth
    const naturalHeight = decoded.img.naturalHeight
    const target = computeScaledSize(naturalWidth, naturalHeight, MAX_INPUT_DIMENSION)

    if (target.scale >= 1) {
      return {
        file,
        previewUrl: URL.createObjectURL(file),
        width: naturalWidth,
        height: naturalHeight,
        downscaled: false,
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      // 无 canvas 2D（jsdom）：返回原文件。
      return {
        file,
        previewUrl: URL.createObjectURL(file),
        width: naturalWidth,
        height: naturalHeight,
        downscaled: false,
      }
    }
    ctx.drawImage(decoded.img, 0, 0, target.width, target.height)

    // PNG 保 alpha 原样重编码；JPEG/WebP 质量 0.92。
    const outMime = file.type
    const quality = outMime === 'image/png' ? undefined : RESIZED_JPEG_QUALITY
    const blob = await canvasToBlob(canvas, outMime, quality)
    const ext = outMime === 'image/png' ? 'png' : outMime === 'image/jpeg' ? 'jpg' : 'webp'
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'reference'
    const resized = new File([blob], `${baseName}.${ext}`, { type: outMime, lastModified: Date.now() })

    return {
      file: resized,
      previewUrl: URL.createObjectURL(resized),
      width: target.width,
      height: target.height,
      downscaled: true,
    }
  } finally {
    decoded.revoke()
  }
}
