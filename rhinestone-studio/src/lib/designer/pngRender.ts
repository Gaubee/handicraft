/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-21 rework-designer-manual-rhinestone 走查3 P1-1] 设计师文档 PNG 离屏渲染器
 *    （4.x 期「typed unavailable」偏离收口——documentService.exportPng 真接线）：文档像素
 *    空间 W×H 单画布合成，**复用画布侧渲染资产**——gemSprites 烘焙帧（normal 态——导出无
 *    选中/悬停反馈）/ gemVisual 剪影回退 / underlay 三源（painting/reference/blocks）绘制
 *    顺序与 DesignerCanvas 同口径（源级 visible/opacity、painting 快照尺寸失配透明兜底、
 *    blocks labelMap 边界描线逐位同式）。
 * 2. [投影语义] 调用方（documentService.exportPng）已按可见层投影钻集（4.3 隐藏层不入
 *    图）——本渲染器**不二次过滤钻集**（第二投影面禁止）；层序透明度照文档渲染口径消费
 *    （层 visible 的防御跳过仅为与画布同构的渲染分组口径，非裁剪真源）。
 * 3. [Async] sprite 帧就绪是异步的（烘焙在 gemSprites 内）：请求波次 + onGemSpritesChanged
 *    事件驱动重试，限期（缺省 3s）内未就绪的 specKey 走几何符号回退——与画布帧 miss 期
 *    同一视觉语言（miss 回退不阻断导出，不无限等待）。
 * 4. [Test] 依赖注入面（离屏画布工厂/原图 resolver/toBlob/sprite 请求面）+ 复位——
 *    jsdom 无真光栅，op 序列断言用注入替身（生产 = document.createElement / assetStore
 *    共享 objectURL / canvas.toBlob / gemSprites 真源直连）。
 * 5. [Purity] 无 runes/UI；失败 = typed Error（画幅无效 / 2D 上下文不可用 / toBlob 空），
 *    不产半成品 blob。
 */

import { findPaletteColor, gemSpecIdentityOf } from '$lib/engine'
import type { DesignerGem, EditDocument, UnderlaySourceKey } from '$lib/stores/edit.svelte'
import { paintBlockOutlinePixels } from './blockOutline'
import { getAsset, objectUrlForAsset, releaseObjectUrl } from '$lib/persistence/assetStore'
import {
  GEM_SPRITE_STYLE,
  gemSpriteKeyOf,
  onGemSpritesChanged,
  requestGemSprite,
  type GemSpriteFrame,
  type GemSpriteRequest,
} from './gemSprites'
import {
  effectiveGemVisual,
  fallbackShapeBoxOf,
  fallbackShapeCommandsOf,
  traceShapeOn,
  type GemVisualSpec,
} from './gemVisual'

/** sprite 帧等待限期（ms）：超期 specKey 走几何回退（cache 命中路径零等待——只有冷规格付此代价）。 */
export const PNG_SPRITE_AWAIT_MS = 3_000
/** 无事件时的静默重试间隔（ms）——definitive miss 无失效事件，靠本档兜底推进到限期。 */
const SPRITE_QUIET_RETRY_MS = 250

/** 原图（共享 objectURL 持有——绘制完成即 release 还引用计数）。 */
export interface PngReferenceImage {
  image: CanvasImageSource
  width: number
  height: number
  release(): void
}

/** 可注入依赖（生产缺省 = 浏览器实现 + assetStore/gemSprites 真源；测试注入确定性替身）。 */
export interface PngRenderDeps {
  createCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null
  /** 原图解析（null = 该源缺席/解码失败——可选层不阻断导出，画布同口径）。 */
  resolveReference(assetId: string): Promise<PngReferenceImage | null>
  canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob>
  /** sprite 帧请求（默认 gemSprites.requestGemSprite——cache 命中同步返，miss 走烘焙）。 */
  requestSprite(request: GemSpriteRequest): GemSpriteFrame | null
  onSpritesChanged(listener: () => void): () => void
  /** sprite 帧等待限期覆写（测试注入 0 = 单波次即回退）。 */
  spriteAwaitDeadlineMs?: number
}

// ---------------------------------------------------------------------------
// 生产依赖
// ---------------------------------------------------------------------------

function createOffscreenCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  return ctx ? { canvas, ctx } : null
}

/** assetStore 共享 objectURL → Image 解码（软删/缺失/解码失败 → null：源缺席不阻断）。 */
async function resolveReferenceImage(assetId: string): Promise<PngReferenceImage | null> {
  const node = await getAsset(assetId).catch(() => null)
  if (node === null || node.trashedAt !== undefined) return null
  const url = await objectUrlForAsset(assetId).catch(() => null)
  if (url === null) return null
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('原图解码失败'))
      img.src = url
    })
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => releaseObjectUrl(url),
    }
  } catch {
    releaseObjectUrl(url)
    return null
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob !== null ? resolve(blob) : reject(new Error('canvas.toBlob 返回空'))), 'image/png')
  })
}

let deps: PngRenderDeps = {
  createCanvas: createOffscreenCanvas,
  resolveReference: resolveReferenceImage,
  canvasToBlob: canvasToPngBlob,
  requestSprite: requestGemSprite,
  onSpritesChanged: onGemSpritesChanged,
}

/** 测试注入依赖（null 复位生产实现）。 */
export function setPngRenderDepsForTests(next: Partial<PngRenderDeps> | null): void {
  deps =
    next === null
      ? {
          createCanvas: createOffscreenCanvas,
          resolveReference: resolveReferenceImage,
          canvasToBlob: canvasToPngBlob,
          requestSprite: requestGemSprite,
          onSpritesChanged: onGemSpritesChanged,
        }
      : { ...deps, ...next }
}

// ---------------------------------------------------------------------------
// 渲染（documentService.exportPng 唯一消费面——doc.gems 已是可见层投影集）
// ---------------------------------------------------------------------------

/**
 * 设计师文档 → PNG blob：W×H 文档像素空间（studio PNG 先例「画布 = 像素尺寸」口径）。
 * 三源 underlay（DesignerCanvas 绘制顺序）→ 钻石层（层序/层透明度；normal 态 sprite 帧，
 * miss 回退几何符号——gemVisual 单源投影）→ toBlob('image/png')。
 */
export async function renderEditDocumentPng(doc: EditDocument): Promise<Blob> {
  if (!(doc.width > 0) || !(doc.height > 0)) {
    throw new Error('PNG 渲染失败：画幅尺寸无效。')
  }
  const made = deps.createCanvas()
  if (made === null) {
    throw new Error('PNG 渲染失败：当前环境不支持画布 2D 上下文。')
  }
  const { canvas, ctx } = made
  const W = Math.max(1, Math.round(doc.width))
  const H = Math.max(1, Math.round(doc.height))
  canvas.width = W
  canvas.height = H
  await drawUnderlay(ctx, doc, W, H)
  await drawGems(ctx, doc)
  return deps.canvasToBlob(canvas)
}

function underlaySourceOf(doc: EditDocument, key: UnderlaySourceKey) {
  return doc.underlay.sources.find((source) => source.key === key) ?? null
}

/** 三源合成（DesignerCanvas redraw 同序：painting → reference → blocks；每源独立透明度）。 */
async function drawUnderlay(ctx: CanvasRenderingContext2D, doc: EditDocument, W: number, H: number): Promise<void> {
  const lp = underlaySourceOf(doc, 'painting')
  const lr = underlaySourceOf(doc, 'reference')
  const lb = underlaySourceOf(doc, 'blocks')

  // 源 1 painting 底图快照（快照尺寸 ≠ 画幅 → 透明兜底——空白起步文档规范形态，画布同式）
  if (lp !== null && lp.visible) {
    const paint = underlayLayerCanvas(W, H, (c) => {
      const snap = doc.paintingSnapshot
      const data = snap.width === W && snap.height === H ? snap.data : new Uint8ClampedArray(W * H * 4)
      c.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0)
    })
    if (paint !== null) {
      ctx.globalAlpha = lp.opacity
      ctx.drawImage(paint, 0, 0)
      ctx.globalAlpha = 1
    }
  }

  // 源 2 reference 原图（可选，拉伸到文档尺寸；缺席/解码失败跳过不阻断）
  if (lr !== null && lr.visible && doc.referenceAssetId !== null) {
    const reference = await deps.resolveReference(doc.referenceAssetId)
    if (reference !== null) {
      try {
        ctx.globalAlpha = lr.opacity
        ctx.drawImage(reference.image, 0, 0, W, H)
        ctx.globalAlpha = 1
      } finally {
        reference.release()
      }
    }
  }

  // 源 3 blocks 只读描线（labelMap 边界判定 + 代表色 alpha 210——画布逐位同式）
  if (lb !== null && lb.visible && doc.blocks.length > 0) {
    const lines = underlayLayerCanvas(W, H, (c) => drawBlockLines(c, doc, W, H))
    if (lines !== null) {
      ctx.globalAlpha = lb.opacity
      ctx.drawImage(lines, 0, 0)
      ctx.globalAlpha = 1
    }
  }
}

/** underlay 离屏层画布（putImageData 不受 globalAlpha——离屏落盘后 drawImage 带源透明度）。 */
function underlayLayerCanvas(
  W: number,
  H: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement | null {
  const made = deps.createCanvas()
  if (made === null) return null
  const { canvas, ctx } = made
  canvas.width = W
  canvas.height = H
  paint(ctx)
  return canvas
}

/** blocks 边界描线（blockOutline 单源——labelMap 四邻判定含网格边界守卫，画布缓存层同式）。 */
function drawBlockLines(ctx: CanvasRenderingContext2D, doc: EditDocument, W: number, H: number): void {
  const img = ctx.createImageData(W, H)
  paintBlockOutlinePixels(img.data, doc.blocks, W, H)
  ctx.putImageData(img, 0, 0)
}

// ---------------------------------------------------------------------------
// 钻石层（normal 态 sprite 帧 + 几何回退——gemVisual 单源投影）
// ---------------------------------------------------------------------------

/** 逐钻 sprite 请求（文档值规格——导出无 ⌘T pending 覆盖态；dpr=1 文档像素空间）。 */
function spriteRequestOf(doc: EditDocument, gem: DesignerGem, visual: GemVisualSpec): GemSpriteRequest {
  return {
    specKey: gemSpecIdentityOf(gem, doc.grid).specKey,
    diameterPx: visual.diameterMm * doc.grid.pixelsPerMm,
    dpr: 1,
    state: 'normal',
    tintHex: findPaletteColor(doc.palette, gem.colorId)?.hex ?? null,
  }
}

async function drawGems(ctx: CanvasRenderingContext2D, doc: EditDocument): Promise<void> {
  const visibleLayers = doc.layers.filter((layer) => layer.visible)
  if (visibleLayers.length === 0 || doc.gems.length === 0) return
  // 请求收集（specKey×直径×着色去重——同规格钻共享一帧）
  const requests = new Map<string, GemSpriteRequest>()
  for (const layer of visibleLayers) {
    for (const gem of doc.gems) {
      if (gem.layerId !== layer.id) continue
      const visual = effectiveGemVisual(gem)
      if (!(visual.diameterMm > 0)) continue
      const request = spriteRequestOf(doc, gem, visual)
      requests.set(gemSpriteKeyOf(request), request)
    }
  }
  const frames = await collectSpriteFrames([...requests.values()])
  for (const layer of visibleLayers) {
    ctx.globalAlpha = layer.opacity ?? 1
    for (const gem of doc.gems) {
      if (gem.layerId !== layer.id) continue
      const visual = effectiveGemVisual(gem)
      if (!(visual.diameterMm > 0)) continue
      const frame = frames.get(gemSpriteKeyOf(spriteRequestOf(doc, gem, visual)))
      if (frame !== undefined) {
        drawGemSpriteFrame(ctx, frame, gem.x, gem.y, visual.rotationDeg)
        continue
      }
      drawGemFallbackSymbol(ctx, gem, visual, doc)
    }
    ctx.globalAlpha = 1
  }
}

/**
 * 帧就绪收集：波次请求（cache 命中同步返）→ 未齐则等失效事件/静默档重试，限期（缺省
 * 3s）内未就绪即返回已集——缺席 key 由消费方走几何回退（不阻断导出）。
 */
async function collectSpriteFrames(requests: GemSpriteRequest[]): Promise<Map<string, GemSpriteFrame>> {
  const frames = new Map<string, GemSpriteFrame>()
  if (requests.length === 0) return frames
  const deadline = Date.now() + (deps.spriteAwaitDeadlineMs ?? PNG_SPRITE_AWAIT_MS)
  for (;;) {
    let pending = 0
    for (const request of requests) {
      const key = gemSpriteKeyOf(request)
      if (frames.has(key)) continue
      const frame = deps.requestSprite(request)
      if (frame !== null) frames.set(key, frame)
      else pending += 1
    }
    if (pending === 0 || Date.now() >= deadline) return frames
    await nextSpriteSignal()
  }
}

/** 下一波触发：失效事件（帧就绪/miss 登记）或静默档（definitive miss 无事件兜底）。 */
function nextSpriteSignal(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const unsubscribe = deps.onSpritesChanged(finish)
    const timer = setTimeout(finish, SPRITE_QUIET_RETRY_MS)
  })
}

/** 帧单次绘制（钻中心对齐帧中心；非 0° 围钻心旋转——DesignerCanvas drawGemSprite 同式）。 */
function drawGemSpriteFrame(
  ctx: CanvasRenderingContext2D,
  frame: GemSpriteFrame,
  x: number,
  y: number,
  rotationDeg = 0,
): void {
  if (rotationDeg !== 0) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((rotationDeg * Math.PI) / 180)
    ctx.drawImage(frame.canvas, -frame.size / 2, -frame.size / 2, frame.size, frame.size)
    ctx.restore()
    return
  }
  ctx.drawImage(frame.canvas, x - frame.size / 2, y - frame.size / 2, frame.size, frame.size)
}

/**
 * 几何符号回退（sprite 帧 miss/超期——DesignerCanvas drawGemFallback 的导出口径：
 * 恒 detailed（无 LOD——导出即文档 1:1），柔投影对齐 GEM_SPRITE_STYLE normal 常量，
 * 剪影按形纵横比落盒，色板查无色 #9CA3AF）。
 */
function drawGemFallbackSymbol(
  ctx: CanvasRenderingContext2D,
  gem: DesignerGem,
  visual: GemVisualSpec,
  doc: EditDocument,
): void {
  const majorRadius = (visual.diameterMm / 2) * doc.grid.pixelsPerMm
  if (!(majorRadius > 0)) return
  const rotate = visual.rotationDeg !== 0
  if (rotate) {
    ctx.save()
    ctx.translate(gem.x, gem.y)
    ctx.rotate((visual.rotationDeg * Math.PI) / 180)
    ctx.translate(-gem.x, -gem.y)
  }
  const commands = fallbackShapeCommandsOf(visual.shapeId)
  if (commands !== null) {
    const box = fallbackShapeBoxOf(visual.shapeId, majorRadius * 2)
    traceShapeOn(ctx, commands, gem.x, gem.y, box.w, box.h)
  } else {
    ctx.beginPath()
    ctx.arc(gem.x, gem.y, majorRadius, 0, Math.PI * 2)
  }
  ctx.fillStyle = findPaletteColor(doc.palette, gem.colorId)?.hex ?? '#9CA3AF'
  ctx.shadowColor = GEM_SPRITE_STYLE.normalShadowColor
  ctx.shadowBlur = majorRadius * GEM_SPRITE_STYLE.normalShadowBlurFactor
  ctx.shadowOffsetY = majorRadius * GEM_SPRITE_STYLE.normalShadowOffsetYFactor
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
  ctx.strokeStyle = 'rgba(0,0,0,0.28)'
  ctx.lineWidth = Math.max(majorRadius * 0.1, 0.5) // 导出 scale=1（画布 0.5/view.scale 的文档空间口径）
  ctx.stroke()
  if (rotate) ctx.restore()
}
