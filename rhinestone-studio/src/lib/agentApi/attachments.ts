/*
 * 图片附件域共享面（split-admin-portal 2.6，2026-09-29——「用户无法上传图片」痛点）。
 * 正交意图：
 *   [1] 附件元数据 AttachmentMeta：上传返回值 / followup 队列携带 / 帧回放投影
 *       三处共用的一等形态（契约并行放宽中——session.followup 入参 attachments
 *       为 string[]（blobRef）；帧元数据按本形态本地宽容解析，契约合流后换精确类型）。
 *   [2] 上传前置件：File→base64、base64 魔数嗅探 MIME、Image 解码宽高
 *       （RpcAgentApi.uploadAssetImage 的组成件，独立成函数供测试注入）。
 *   [3] raw 预览 URL builder：/api/assets/{ref}/raw?token=（daemon 并行实现；
 *       缩略由 CSS 尺寸控制，无服务端缩放——不携带 w 参数）。
 */

import { getStoredToken } from '../daemonToken.js'

/** 附件元数据（宽高供 chip/回放展示；mime 供回放还原）。 */
export interface AttachmentMeta {
  blobRef: string
  name: string
  mime: string
  width: number
  height: number
}

/** 单张上限（与 ComposerCard 既有门同值——zhumo 走查 R7 语义）。 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
/** 单条消息附件数上限（2.6.5 多文件门——载荷有界）。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4

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

/** dataUrl → Image 解码宽高（jsdom 无解码——测试经全局 Image 桩注入）。 */
export function decodeImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('图片解码失败（不支持的图片格式）'))
    image.src = dataUrl
  })
}

/**
 * raw 预览 URL：登录 token 取 daemonToken 存储层（渲染时现读——代际跟随）；
 * 同源缺省（daemon 托管 SPA）。缩略由 CSS 控制（无 w 参数——无服务端缩放）。
 */
export function assetRawUrl(blobRef: string): string {
  const origin = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://127.0.0.1:8317'
  const token = getStoredToken()
  return `${origin.replace(/\/$/, '')}/api/assets/${encodeURIComponent(blobRef)}/raw${token ? `?token=${encodeURIComponent(token)}` : ''}`
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
