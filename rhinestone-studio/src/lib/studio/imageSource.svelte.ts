/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 rename-and-expert-workbench A 2.1] 图像载入域（原 stores/studio.svelte.ts :349-560
 *    纯搬移）：浏览器解码路径 + ≤1024px 降采样 + 素材库选择/上传（sys-uploads 入库 + 会话引用 pin）
 *    + handoff 消费（送排钻产物，getHandoffImageBlob 单点出口）+ 测试直灌。零行为变化：
 *    公共导出面经 store 根 re-export 兼容（design §2.3-1/2）。
 * 2. [依赖纪律] 子模块只依赖 store 核心 $state（经根公共读取器 + 内部协作面 applyPainting/
 *    setLoadError/setReferenceImageRecord——design §2.3-4 单向依赖）；载入落位桥 applyPainting
 *    留在根（编排 cancelPending/scheduleSegment/选择复位/结果清零等计算域副作用）。
 * 3. [落位不变量] applyPainting 经根落位 = 换图解除旧 pin、新资产挂 pin、复位选中块与结果、
 *    起分块防抖——与拆分前逐语句等价（同参快照护栏：studio 族既有测试零断言改动）。
 */

import type { EngineImage } from '$lib/engine'
import { blobToDataUrl } from '$lib/persistence/imageStore'
import { getAsset, getAssetBlob, ingestAsset, pinAsset, unpinAsset } from '$lib/persistence/assetStore'
import { getHandoffImageBlob, HandoffImageMissingError } from '$lib/persistence/handoffImage'
import { clearHandoff, getHandoff } from '$lib/stores/handoff.svelte'
import {
  MAX_IMAGE_DIM,
  applyPainting,
  getSourceImage,
  getReferenceImage,
  setLoadError,
  setReferenceImageRecord,
} from '$lib/stores/studio.svelte'
import { getBackgroundObservation, setBackgroundObservation } from '$lib/studio/layers.svelte'

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败（不支持的格式或损坏的文件）'))
    img.src = src
  })
}

function imageToEngineImage(
  img: HTMLImageElement,
  maxDim: number,
): { image: EngineImage; downscale: number } {
  const downscale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * downscale))
  const h = Math.max(1, Math.round(img.naturalHeight * downscale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 不可用，无法解码图片')
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  return { image: { width: w, height: h, data: data.data }, downscale }
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 浏览器路径：dataURL → 解码 → ≤1024px 降采样 → 分块管线。
 *  [add-asset-library 5.1/5.2] 带 assetId 时该资产进入 studio 会话引用（pin），换图/复位时解除。 */
export async function loadFromDataUrl(
  dataUrl: string,
  name: string,
  origin: 'handoff' | 'upload' | 'library',
  assetId?: string,
): Promise<boolean> {
  setLoadError(null)
  try {
    const img = await loadImageElement(dataUrl)
    const { image, downscale } = imageToEngineImage(img, MAX_IMAGE_DIM)
    applyPainting(image, { dataUrl, name, origin, downscale, assetId })
    return true
  } catch (error) {
    setLoadError(error instanceof Error ? error.message : String(error))
    return false
  }
}

/** [5.1] 上传（次 CTA / 上下文条）：入库 sys-uploads + 选中（B-3 同语义；入库失败不阻断载入）。 */
export async function loadFromFile(file: File): Promise<boolean> {
  const dataUrl = await fileToDataUrl(file)
  const ok = await loadFromDataUrl(dataUrl, file.name, 'upload')
  if (!ok) return false
  try {
    const width = getSourceImage()?.width ?? 0
    const height = getSourceImage()?.height ?? 0
    const ingested = await ingestAsset({
      blob: file,
      name: file.name,
      width,
      height,
      parentId: 'sys-uploads',
      source: 'upload',
    })
    const current = getSourceImage()
    if (current && current.dataUrl === dataUrl) {
      // 载入期间未被换图：把资产挂到当前会话引用（pin）
      current.assetId = ingested.node.id
      pinAsset(ingested.node.id)
    }
  } catch (error) {
    console.warn('上传数字油画入库失败，降级为会话内引用', error)
  }
  return true
}

/** [5.1] 从素材库选择（主 CTA /「更换」）：经冻结出口解析 → 既有解码管线；missing 显式错误态。 */
export async function loadFromLibrary(asset: { id: string; name: string }): Promise<boolean> {
  setLoadError(null)
  const blob = await getAssetBlob(asset.id).catch(() => null)
  if (!blob) {
    setLoadError('素材图片已缺失（可能已被移入回收站或清理），请重新选择。')
    return false
  }
  let dataUrl: string
  try {
    dataUrl = await blobToDataUrl(blob)
  } catch (error) {
    setLoadError(`素材图片读取失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  return loadFromDataUrl(dataUrl, asset.name, 'library', asset.id)
}

/**
 * handoff 参考原图落位（[5.2] referenceAssetId 解析）：不覆盖已手动上传的参考图
 * （纯增量；解析/解码失败静默跳过——该层可选）。
 */
export async function applyHandoffReference(referenceAssetId?: string): Promise<void> {
  if (!referenceAssetId || getReferenceImage()) return
  const blob = await getAssetBlob(referenceAssetId).catch(() => null)
  if (!blob) return
  const dataUrl = await blobToDataUrl(blob).catch(() => null)
  if (!dataUrl) return
  const node = await getAsset(referenceAssetId).catch(() => null)
  setReferenceImageRecord({ assetId: referenceAssetId, dataUrl, name: node?.name ?? '参考原图' })
  pinAsset(referenceAssetId)
}

/**
 * 消费 handoff store（实验室「送排钻」产物，v2 assetId 载荷），成功后清空交接。
 * [add-project-files 0.6 · design §9.2 B2] 图像字节改经 getHandoffImageBlob 单点出口
 * （图片节点直取 / gemgen 档案解内嵌图零重编码；旧 getAssetBlob 直连收口）：
 * 缺失（含软删/物理记录丢失）→ 既有 missing 文案；版本超前/损坏等 labFile typed error
 * → 透传错误详情。HandoffPayload 形状零变化。
 * [4.5] missing 显式出口：资产不可解析 → loadError + 回退空态（不是空画布）。
 */
export async function loadFromHandoff(): Promise<boolean> {
  const payload = getHandoff()
  if (!payload) return false
  let blob: Blob
  try {
    blob = await getHandoffImageBlob(payload.assetId)
  } catch (error) {
    setLoadError(
      error instanceof HandoffImageMissingError
        ? '送来的生成图素材已缺失（可能已从素材库删除），请回实验室重新送排钻。'
        : `送来的生成图读取失败：${error instanceof Error ? error.message : String(error)}`,
    )
    clearHandoff()
    return false
  }
  let dataUrl: string
  try {
    dataUrl = await blobToDataUrl(blob)
  } catch (error) {
    setLoadError(`送来的生成图读取失败：${error instanceof Error ? error.message : String(error)}`)
    clearHandoff()
    return false
  }
  const ok = await loadFromDataUrl(dataUrl, payload.name, 'handoff', payload.assetId)
  if (ok) {
    await applyHandoffReference(payload.referenceAssetId)
    clearHandoff()
  }
  return ok
}

/** 测试/程序化路径：直接灌入 EngineImage（jsdom 无 canvas 解码时同构可用） */
export function loadFromEngineImage(
  image: EngineImage,
  name: string,
  origin: 'handoff' | 'upload' = 'upload',
): void {
  setLoadError(null)
  const w = image.width
  const h = image.height
  // 合成一个可渲染的等价 dataUrl 不可行（无编码器）；渲染层直接消费 painting 像素
  applyPainting({ width: w, height: h, data: image.data }, {
    dataUrl: '',
    name,
    origin,
    downscale: 1,
  })
}

export async function setReferenceFile(file: File): Promise<void> {
  const dataUrl = await fileToDataUrl(file)
  // [5.2] 参考原图 asset 化：入库 sys-uploads（失败降级为会话内引用，不阻断）
  let assetId: string | undefined
  try {
    const ingested = await ingestAsset({
      blob: file,
      name: file.name,
      width: 0,
      height: 0,
      parentId: 'sys-uploads',
      source: 'upload',
    })
    assetId = ingested.node.id
  } catch (error) {
    console.warn('参考原图入库失败，降级为会话内引用', error)
  }
  const previous = getReferenceImage()
  if (previous?.assetId) unpinAsset(previous.assetId)
  setReferenceImageRecord({ assetId, dataUrl, name: file.name })
  if (assetId) pinAsset(assetId)
}

export function clearReferenceImage(): void {
  const previous = getReferenceImage()
  if (previous?.assetId) unpinAsset(previous.assetId)
  setReferenceImageRecord(null)
  // [2.5] 背景源收编：参考原图清除 → 源回落数字油画（原 previewMode 收编语义）
  if (getBackgroundObservation().source === 'reference') setBackgroundObservation({ source: 'painting' })
}
