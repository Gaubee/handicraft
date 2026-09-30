/*
 * 图片附件域共享面（split-admin-portal 2.6，2026-09-29——「用户无法上传图片」痛点）。
 * 正交意图：
 *   [1] 附件元数据 AttachmentMeta：上传返回值 / followup 队列携带 / 帧回放投影
 *       三处共用的一等形态（契约并行放宽中——session.followup 入参 attachments
 *       为 string[]（blobRef）；帧元数据按本形态本地宽容解析，契约合流后换精确类型）。
 *   [2] 上传前置件：File→base64、base64 魔数嗅探 MIME、Image 解码宽高
 *       （RpcAgentApi.uploadAssetImage 的组成件，独立成函数供测试注入）。
 *   [3] raw 预览 URL builder：/api/assets/{ref}/raw?w=&token=（daemon 并行实现；
 *       可选 w 缩放参数——daemon 现为预留位接受即忽略，CSS 尺寸控制仍是现状）。
 *   [4] 非 PNG 归一转换（W5 走查 P0-2，2026-09-28）：scene/segment/pave 管线全要
 *       PNG——jpeg/webp（及可解码的 gif/bmp/svg 等）经 canvas→toBlob('image/png')
 *       转 PNG 再上传（EXIF 方向经 img 解码方向自然归一）；超大画布（>4096px）不
 *       转换直接拒+提示；4MiB 门按转换后尺寸判（uploadAssetImage 组装面）。
 */

import { currentStoredToken, getStoredToken } from '../daemonToken.js'

/** 附件元数据（宽高供 chip/回放展示；mime 供回放还原）。 */
export interface AttachmentMeta {
  blobRef: string
  name: string
  mime: string
  width: number
  height: number
  /** 上传归一标记（W5 P0-2）：原文件非 PNG、经 canvas 转 PNG 后上传——chip 呈现「已转 PNG」。 */
  convertedToPng?: boolean
}

/** 单张上限（与 ComposerCard 既有门同值——zhumo 走查 R7 语义）。 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
/** 单条消息附件数上限（2.6.5 多文件门——载荷有界）。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4
/** 转换画布单边像素上限（W5 P0-2：>4096 的原图不进 canvas——内存与 PNG 膨胀面直接拒）。 */
export const MAX_CONVERT_CANVAS_PX = 4096

/** File → 纯 base64（无 data: 前缀——assets.upload 线格式）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

/** Blob → 纯 base64（无 data: 前缀——canvas toBlob 产物转 assets.upload 线格式）。 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('PNG 转换产物读取失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * base64 魔数嗅探 MIME（粘贴/拖入的截图常缺 file.type）：PNG/JPEG/GIF/WebP
 * 四类覆盖实际可上传面；未命中回退 application/octet-stream（解码失败即拒）。
 */
export function sniffImageMime(dataBase64: string): string {
  if (dataBase64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (dataBase64.startsWith('/9j/')) return 'image/jpeg'
  if (dataBase64.startsWith('R0lGOD')) return 'image/gif'
  if (dataBase64.startsWith('UklGR')) return 'image/webp'
  return 'application/octet-stream'
}

/** dataUrl → Image 元素（onload 决出解码宽高；jsdom 无解码——测试经全局 Image 桩注入）。 */
function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败（不支持的图片格式）'))
    image.src = dataUrl
  })
}

/** dataUrl → Image 解码宽高（jsdom 无解码——测试经全局 Image 桩注入）。 */
export async function decodeImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  const image = await loadImageElement(dataUrl)
  return { width: image.naturalWidth, height: image.naturalHeight }
}

/**
 * 非 PNG 图片归一转换（W5 走查 P0-2）：canvas 解码→toBlob('image/png')。EXIF 方向
 * 经 img 解码方向自然归一（drawImage 绘制即解码向）；超大画布（单边 >4096px）不
 * 转换直接拒（不缩放——保持原样拒+提示，4MiB 门由调用方按转换后尺寸判）。
 */
export async function convertImageToPng(dataUrl: string): Promise<{ blob: Blob; width: number; height: number }> {
  const image = await loadImageElement(dataUrl)
  const { naturalWidth: width, naturalHeight: height } = image
  if (width <= 0 || height <= 0) throw new Error('图片解码失败（不支持的图片格式）')
  if (width > MAX_CONVERT_CANVAS_PX || height > MAX_CONVERT_CANVAS_PX) {
    throw new Error(`「图片尺寸 ${width}×${height} 超出 ${MAX_CONVERT_CANVAS_PX}px 上限——请压缩后上传`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('canvas 2D 上下文不可用，无法转换 PNG')
  ctx.drawImage(image, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('PNG 转换失败（canvas toBlob 空产物）')
  return { blob, width, height }
}

/** 文件名归一（W5 P0-2）：保留原名+后缀改 .png（无后缀补 .png——chip 提示转换事实）。 */
export function pngFilenameOf(name: string): string {
  return /\.[a-z0-9]+$/i.test(name) ? `${name.replace(/\.[a-z0-9]+$/i, '')}.png` : `${name}.png`
}

/**
 * raw 预览 URL：token 取 daemonToken 存储层（渲染时现读——代际跟随；登录键位
 * 优先，匿名键位兜底）；同源缺省（daemon 托管 SPA）。可选 w 宽度参数
 * （restructure-materials-story W1 预览修复：缩略格携 w=600，防 15MB 原图进
 * 网格）——daemon raw 面现为「接受即忽略」的预留位（assets-http.ts 注释），
 * 服务端实装缩放后即刻生效，无 token 时参数顺序 w 在前。
 */
export function assetRawUrl(blobRef: string, width?: number): string {
  const origin = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://127.0.0.1:8317'
  const token = currentStoredToken()
  const parts: string[] = []
  if (width !== undefined && Number.isFinite(width) && width > 0) parts.push(`w=${Math.round(width)}`)
  if (token) parts.push(`token=${encodeURIComponent(token)}`)
  const query = parts.length > 0 ? `?${parts.join('&')}` : ''
  return `${origin.replace(/\/$/, '')}/api/assets/${encodeURIComponent(blobRef)}/raw${query}`
}

/**
 * raw 回显 401 自愈（Owner 验收 2026-09-30「上传后预览图缺失」——daemon 重启
 * 使旧 token 失效，img 裂图）：img onerror 挂本函数——重读当前应生效 token，
 * 与该 img 现用 token 不同则换 src 重试一次（__rt 标记防循环；相同=非鉴权
 * 问题，交由既有缺图占位逻辑）。
 */
export function retryRawImageOnError(event: Event): void {
  const img = event.currentTarget
  if (!(img instanceof HTMLImageElement)) return
  let url: URL
  try {
    url = new URL(img.src)
  } catch {
    return
  }
  if (url.searchParams.has('__rt')) return // 已自愈重试过——不再循环
  const fresh = currentStoredToken()
  const used = url.searchParams.get('token')
  if (fresh === null || fresh === used) return
  url.searchParams.set('token', fresh)
  url.searchParams.set('__rt', '1')
  img.src = url.toString()
}

/**
 * 帧回放附件元数据宽容解析（契约 TranscriptPayloadSchema 放宽并行中）：
 * 形态不符整条丢弃（null）——回放渲染不因元数据漂移崩溃。
 */
export function coerceAttachmentMeta(value: unknown): AttachmentMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.blobRef !== 'string' || record.blobRef === '') return null
  return {
    blobRef: record.blobRef,
    name: typeof record.name === 'string' ? record.name : record.blobRef,
    mime: typeof record.mime === 'string' ? record.mime : '',
    width: typeof record.width === 'number' && Number.isFinite(record.width) ? record.width : 0,
    height: typeof record.height === 'number' && Number.isFinite(record.height) ? record.height : 0,
  }
}

/** 帧载荷 → 附件元数据组（非数组/全无效 → undefined——投影面省字段的同式）。 */
export function attachmentMetasOf(payload: { attachments?: unknown }): AttachmentMeta[] | undefined {
  if (!Array.isArray(payload.attachments)) return undefined
  const metas = payload.attachments.map(coerceAttachmentMeta).filter((meta): meta is AttachmentMeta => meta !== null)
  return metas.length > 0 ? metas : undefined
}
