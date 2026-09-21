/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-21 rework-designer-manual-rhinestone R2.1] 水钻贴图 sprite 烘焙管线（design §1.1）：
 *    specKey → sys-shapes .gemshape 资产纹理（assetStore 既有解析面 + parseGemshape，service
 *    签名冻结零改动）→ Image 解码 → 离屏烘焙三态帧（normal 柔投影 / hover 投影增强+亮度微升 /
 *    selected 主蓝外发光描边双 pass+投影）→ LRU 帧 cache（上限 256）。
 * 2. [裁断 1.2 = 方案 A multiply 着色（design §1.2 附录，2026-09-21 五 seed 取样判中性）]
 *    colorId → 色板 hex 经 multiply 铺色 + destination-in 回贴 alpha 烘进帧（保留贴图
 *    高光/阴影层次——渲染循环零逐钻 filter 计算）；colorId 空/查无色 → 原样银白（未映射色）。
 * 3. [Missing] 回退契约：specKey 解析失败负缓存（**TTL 可重试**——R5.2 走查 P2-1：
 *    「seed hydrate 晚于首渲染 → 永久 miss」防线：解析前等资产库迁移 + miss 分类
 *    transient/definitive + 过期自动放行重解析），requestGemSprite 返回 null——消费方
 *    （画布）回退几何符号 + 既有 brushError 通道。
 * 4. [Async/Sync] 帧就绪是异步的（资产解析 + Image 解码）；requestGemSprite 同步查、
 *    miss 时按 key 去重 kick 异步烘焙，完成后经订阅回调通知画布重绘（帧仅此一条失效通道）。
 * 5. [Test] 依赖注入面（Image 工厂/离屏画布工厂/纹理 resolver）+ resetGemSpritesForTests——
 *    jsdom 无真光栅，烘焙 op 序列断言用注入替身（生产 = new Image / document.createElement）。
 */

import { gemshapeNodeIdOfSpecKey, getProject, runAssetMigration } from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { parseGemshape } from '$lib/persistence/gemshapeFile'

/** 三态（design §1.1：normal 柔投影 / hover 反馈 / selected 选中反馈；选择优先级 selected>hover>normal）。 */
export type GemSpriteState = 'normal' | 'hover' | 'selected'

/** sprite LRU 帧上限（design §1.1：LRU 256）。 */
export const GEM_SPRITE_CACHE_LIMIT = 256

/** 烘焙常量（design §1.1 逐条：normal 投影 rgba(0,0,0,.35) blur≈r·0.4 offsetY≈r·0.15 等）。 */
export const GEM_SPRITE_STYLE = Object.freeze({
  /** normal 投影 */
  normalShadowColor: 'rgba(0,0,0,0.35)',
  normalShadowBlurFactor: 0.4,
  normalShadowOffsetYFactor: 0.15,
  /** hover：投影增强 + 亮度微升（叠 rgba(255,255,255,.10)，source-atop 裁进已绘像素） */
  hoverShadowColor: 'rgba(0,0,0,0.5)',
  hoverShadowBlurFactor: 0.55,
  hoverShadowOffsetYFactor: 0.2,
  hoverBrightnessOverlay: 'rgba(255,255,255,0.10)',
  /** selected：主蓝（画布选中环同色 #0284C7）外发光描边 blur≈r·0.6 双 pass + 投影 */
  selectedGlowColor: '#0284C7',
  selectedGlowBlurFactor: 0.6,
  selectedGlowPasses: 2,
})

/** 烘焙帧（消费方 drawImage 单次调用；pad 已含投影/发光余量）。 */
export interface GemSpriteFrame {
  /** 帧位图（dpr 栅格化——ctx 已按 dpr 缩放烘焙，绘制时用逻辑尺寸）。 */
  canvas: HTMLCanvasElement
  /** 帧逻辑总尺寸（图像 px = contentW + 2×pad）——drawImage 的 dw/dh。 */
  size: number
  /** 钻内容宽（图像 px，含物理纵横比——异形窄边 < 直径）。 */
  contentW: number
  /** 钻内容高（图像 px）。 */
  contentH: number
  /** 投影/发光 padding（图像 px；钻中心在帧中心）。 */
  pad: number
  /** 烘焙键（specKey|直径px|dpr|态|着色——诊断/测试断言用）。 */
  key: string
}

/** 纹理源（sys-shapes .gemshape 解析产物——只取渲染所需两字段）。 */
export interface GemTextureSource {
  dataUrl: string
  /** 物理纵横比（widthMm/heightMm——异形帧内容宽高派生）。 */
  aspect: number
}

/** 解码位图（Image 工厂产物——绘制面 CanvasImageSource + 自然尺寸）。 */
export interface DecodedTexture {
  image: CanvasImageSource
  width: number
  height: number
}

/** 可注入依赖（生产缺省 = 浏览器实现；测试注入确定性替身）。 */
export interface GemSpriteDeps {
  /**
   * specKey → 纹理（null / TextureMiss = miss——注入替身返 null 即「解析完成且缺席」）。
   * [R5.2 走查 P2-1] miss 分类面：transient（资产库未就绪——短 TTL 重试）与
   * definitive（解析完成缺席——长 TTL 后仍可重试，回收站找回/晚播种可见）。
   */
  resolveTexture: (specKey: string) => Promise<GemTextureSource | null | TextureMiss>
  loadImage: (dataUrl: string) => Promise<DecodedTexture>
  createCanvas: () => { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null
}

/** 纹理解析 miss 分类（生产 resolver 产出；注入替身返 null = definitive 同旧语义）。 */
export type TextureMiss = { kind: 'transient' } | { kind: 'definitive' }

// ---------------------------------------------------------------------------
// 生产依赖（assetStore 既有解析面——service 接口签名冻结，零改动消费）
// ---------------------------------------------------------------------------

/**
 * [R5.2 走查 P2-1] 负缓存 TTL（Date.now 基）：definitive miss 长 TTL（30s——不再逐帧
 * 打资产面，回收站找回/补播种后下一次重绘可见）；transient miss 短 TTL（5s——资产库
 * 未就绪不应长时间视同缺席）。走查实证「seed hydrate 晚于首渲染 → 永久 miss」双根源：
 * ①纹理 null Promise 进 textureCache 永久缓存 ②负缓存无过期。
 */
export const GEM_SPRITE_MISSING_RETRY_MS = 30_000
export const GEM_SPRITE_TRANSIENT_RETRY_MS = 5_000

/**
 * specKey → .gemshape 纹理（design §1.1 取用链：seed `ast-shape-<specKey>` /
 * custom-<assetId> → 资产本体）。解析前先等资产库迁移完成（sys-shapes seed 在迁移内
 * create-only——首渲染早于 seed hydrate 的竞态防线：节点尚未建 ≠ 缺席）；迁移未完成/
 * IO 暂时失败 = transient miss；节点缺失/软删/blob 缺失/parse 失败/身份失配 =
 * definitive miss（gemCatalog 同口径）。
 */
async function resolveGemshapeTexture(specKey: string): Promise<GemTextureSource | null | TextureMiss> {
  const migrationOk = await runAssetMigration()
    .then((report) => report.completed)
    .catch(() => false)
  if (!migrationOk) return { kind: 'transient' }
  try {
    const node = await getProject(gemshapeNodeIdOfSpecKey(specKey))
    if (node === null || node.projectKind !== 'gemshape' || node.trashedAt !== undefined) {
      return { kind: 'definitive' }
    }
    const blob = await getImageBlob(node.blobKey)
    if (blob === null) return { kind: 'definitive' }
    const file = parseGemshape(await blob.text(), { mime: node.mime })
    if (file.specKey !== undefined && file.specKey !== specKey) return null // 身份失配（gemCatalog 同口径）
    return { dataUrl: file.texture.dataUrl, aspect: file.physical.widthMm / file.physical.heightMm }
  } catch {
    return { kind: 'transient' } // IDB 暂不可用按未就绪——短 TTL 重试
  }
}

/** dataUrl → Image 解码（onload/onerror Promise 化；生产 = 浏览器 Image）。 */
function loadTextureImage(dataUrl: string): Promise<DecodedTexture> {
  return new Promise<DecodedTexture>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) {
        reject(new Error('贴图解码尺寸无效'))
        return
      }
      resolve({ image: img, width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => reject(new Error('贴图解码失败'))
    img.src = dataUrl
  })
}

function createOffscreenCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  return ctx ? { canvas, ctx } : null
}

let deps: GemSpriteDeps = {
  resolveTexture: resolveGemshapeTexture,
  loadImage: loadTextureImage,
  createCanvas: createOffscreenCanvas,
}

/** 测试注入依赖（null 复位生产实现；缓存/负缓存/在飞一并清空）。 */
export function setGemSpriteDepsForTests(next: Partial<GemSpriteDeps> | null): void {
  deps = next === null
    ? { resolveTexture: resolveGemshapeTexture, loadImage: loadTextureImage, createCanvas: createOffscreenCanvas }
    : { ...deps, ...next }
  resetGemSpritesForTests()
}

// ---------------------------------------------------------------------------
// 帧 cache（LRU 256）+ 负缓存 + 在飞去重 + 失效通知
// ---------------------------------------------------------------------------

const frameCache = new Map<string, GemSpriteFrame>()
/**
 * specKey 级 miss 负缓存（TTL——R5.2 走查 P2-1 可重试化：过期后下一次 requestGemSprite
 * 重新打资产面，不逐帧重试；值 = 过期时刻 Date.now()）。
 */
const missingUntil = new Map<string, number>()
/** specKey → 纹理解析 Promise（同 specKey 的多直径/态变体共享一次资产解析；**miss 不入
 *  长效缓存**——resolve 后即撤，TTL 闸控制重试节奏）。 */
const textureCache = new Map<string, Promise<GemTextureSource | null | TextureMiss>>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function isTextureMiss(value: GemTextureSource | null | TextureMiss): value is TextureMiss {
  return value !== null && typeof value === 'object' && 'kind' in value
}

/** miss 登记（TTL 过期前 requestGemSprite 直接回退；过期自动放行重解析）。 */
function markSpecKeyMissing(specKey: string, miss: TextureMiss): void {
  missingUntil.set(
    specKey,
    Date.now() + (miss.kind === 'transient' ? GEM_SPRITE_TRANSIENT_RETRY_MS : GEM_SPRITE_MISSING_RETRY_MS),
  )
}

/** miss 是否在 TTL 有效期内（过期条目即时清除——放行下一次重解析）。 */
function isSpecKeyMissing(specKey: string): boolean {
  const until = missingUntil.get(specKey)
  if (until === undefined) return false
  if (Date.now() < until) return true
  missingUntil.delete(specKey)
  return false
}

/** 帧就绪/失败通知订阅（画布重绘触发；返回退订函数）。 */
export function onGemSpritesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notifyChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 监听方异常隔离（emitBrushEvent 同纪律）
    }
  }
}

/** specKey 级纹理解析缓存（同 specKey 只打一次资产面——多直径/态/着色变体共享；
 *  miss 结果 resolve 后即撤出（负缓存 TTL 闸接管重试节奏——不永久缓存 null）。 */
function resolveTextureCached(specKey: string): Promise<GemTextureSource | null | TextureMiss> {
  let pending = textureCache.get(specKey)
  if (pending === undefined) {
    pending = deps.resolveTexture(specKey).catch((): TextureMiss => ({ kind: 'transient' })) // throw 视同未就绪（短 TTL）
    pending = pending.then((resolved) => {
      if (resolved === null || isTextureMiss(resolved)) textureCache.delete(specKey)
      return resolved
    })
    textureCache.set(specKey, pending)
  }
  return pending
}

/** 帧写入 + LRU 逐出（超上限逐最旧；Map 迭代序 = 插入序 = 热度序，命中时 delete+set 刷新）。 */
function storeFrame(key: string, frame: GemSpriteFrame): void {
  frameCache.delete(key)
  frameCache.set(key, frame)
  while (frameCache.size > GEM_SPRITE_CACHE_LIMIT) {
    const oldest = frameCache.keys().next().value
    if (oldest === undefined) break
    frameCache.delete(oldest)
  }
}

/** 诊断/测试读取面：当前 cache 键序（LRU 热度序）。 */
export function gemSpriteCacheKeys(): string[] {
  return [...frameCache.keys()]
}

// ---------------------------------------------------------------------------
// 烘焙（三态 op 序列——design §1.1；全部烘焙进帧，渲染循环零逐钻 filter）
// ---------------------------------------------------------------------------

export interface GemSpriteRequest {
  specKey: string
  /** 钻直径（图像 px = 直径 mm × pixelsPerMm）。 */
  diameterPx: number
  /** 设备像素比（帧 dpr 栅格化）。 */
  dpr: number
  state: GemSpriteState
  /** 方案 A 着色 hex（null = 原样银白——色板查无/未映射色）。 */
  tintHex: string | null
}

/** cache 键：specKey + 直径px（= specKey×pixelsPerMm 派生量）+ dpr + 态 + 着色（design §1.1 键契约的量纲完备化）。 */
export function gemSpriteKeyOf(request: Pick<GemSpriteRequest, 'specKey' | 'diameterPx' | 'dpr' | 'state' | 'tintHex'>): string {
  const diameterQ = Math.round(request.diameterPx * 100) / 100 // 0.01px 量化（浮点噪声不入键）
  const dprQ = Math.round(request.dpr * 100) / 100
  return `${request.specKey}|${diameterQ}|${dprQ}|${request.state}${request.tintHex !== null ? `|${request.tintHex}` : ''}`
}

/** 投影/发光 padding（覆盖最大 blur×2 + offsetY + 边量；r = 半径 px）。 */
function padPx(radius: number): number {
  return Math.max(2, Math.ceil(radius * GEM_SPRITE_STYLE.selectedGlowBlurFactor * 2 + radius * GEM_SPRITE_STYLE.normalShadowOffsetYFactor + 2))
}

/** 帧内贴图内容盒（物理纵横比派生；aspect 异常值夹回 (0.1, 10)）。 */
function contentBoxOf(diameterPx: number, aspect: number): { w: number; h: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0.1 && aspect < 10 ? aspect : 1
  return safeAspect >= 1
    ? { w: diameterPx, h: diameterPx / safeAspect }
    : { w: diameterPx * safeAspect, h: diameterPx }
}

/**
 * 烘焙一帧（纯绘制序列，输入 = 已解码贴图 + 请求参数）。
 * op 序列（design §1.1 三态逐条）：
 * - 底：贴图缩放绘制到内容盒（方案 A：multiply 铺色 → destination-in 回贴 alpha 保层次）；
 * - normal：柔投影（rgba(0,0,0,.35) blur≈r·0.4 offsetY≈r·0.15）绘制底图；
 * - hover：投影增强（.5 / r·0.55 / r·0.2）绘制底图 → source-atop 叠 rgba(255,255,255,.10) 提亮；
 * - selected：主蓝 #0284C7 blur≈r·0.6 双 pass 外发光 → 再按 normal 投影绘制本体。
 */
function bakeFrame(decoded: DecodedTexture, request: GemSpriteRequest, aspect: number): GemSpriteFrame | null {
  const made = deps.createCanvas()
  if (made === null) return null
  const { canvas, ctx } = made
  const radius = request.diameterPx / 2
  const { w: contentW, h: contentH } = contentBoxOf(request.diameterPx, aspect)
  const pad = padPx(radius)
  const size = Math.max(Math.ceil(contentW), Math.ceil(contentH)) + pad * 2
  canvas.width = Math.max(1, Math.round(size * request.dpr))
  canvas.height = Math.max(1, Math.round(size * request.dpr))
  ctx.setTransform(request.dpr, 0, 0, request.dpr, 0, 0)
  // 底图（着色帧：独立离屏 multiply + destination-in——着色也是烘焙面，不进渲染循环）
  let base: DecodedTexture = decoded
  if (request.tintHex !== null) {
    const tinted = deps.createCanvas()
    if (tinted === null) return null
    tinted.canvas.width = Math.max(1, Math.round(contentW * request.dpr))
    tinted.canvas.height = Math.max(1, Math.round(contentH * request.dpr))
    const tctx = tinted.ctx
    tctx.setTransform(request.dpr, 0, 0, request.dpr, 0, 0)
    tctx.drawImage(decoded.image, 0, 0, decoded.width, decoded.height, 0, 0, contentW, contentH)
    tctx.globalCompositeOperation = 'multiply'
    tctx.fillStyle = request.tintHex
    tctx.fillRect(0, 0, contentW, contentH)
    tctx.globalCompositeOperation = 'destination-in'
    tctx.drawImage(decoded.image, 0, 0, decoded.width, decoded.height, 0, 0, contentW, contentH)
    tctx.globalCompositeOperation = 'source-over'
    base = { image: tinted.canvas, width: Math.round(contentW * request.dpr), height: Math.round(contentH * request.dpr) }
  }

  // 钻中心 = 帧中心（异形内容盒居中放置；消费方 dx = x - size/2 对齐钻位）
  const cx = size / 2
  const cy = size / 2
  const drawBase = (): void => {
    ctx.drawImage(base.image, 0, 0, base.width, base.height, cx - contentW / 2, cy - contentH / 2, contentW, contentH)
  }

  if (request.state === 'normal') {
    ctx.shadowColor = GEM_SPRITE_STYLE.normalShadowColor
    ctx.shadowBlur = radius * GEM_SPRITE_STYLE.normalShadowBlurFactor
    ctx.shadowOffsetY = radius * GEM_SPRITE_STYLE.normalShadowOffsetYFactor
    drawBase()
  } else if (request.state === 'hover') {
    ctx.shadowColor = GEM_SPRITE_STYLE.hoverShadowColor
    ctx.shadowBlur = radius * GEM_SPRITE_STYLE.hoverShadowBlurFactor
    ctx.shadowOffsetY = radius * GEM_SPRITE_STYLE.hoverShadowOffsetYFactor
    drawBase()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = GEM_SPRITE_STYLE.hoverBrightnessOverlay
    ctx.fillRect(0, 0, size, size)
    ctx.globalCompositeOperation = 'source-over'
  } else {
    // selected：主蓝外发光双 pass（描边意象——glow 沿贴图 alpha 轮廓）+ 本体投影
    ctx.shadowColor = GEM_SPRITE_STYLE.selectedGlowColor
    ctx.shadowBlur = radius * GEM_SPRITE_STYLE.selectedGlowBlurFactor
    ctx.shadowOffsetY = 0
    for (let pass = 0; pass < GEM_SPRITE_STYLE.selectedGlowPasses; pass += 1) drawBase()
    ctx.shadowColor = GEM_SPRITE_STYLE.normalShadowColor
    ctx.shadowBlur = radius * GEM_SPRITE_STYLE.normalShadowBlurFactor
    ctx.shadowOffsetY = radius * GEM_SPRITE_STYLE.normalShadowOffsetYFactor
    drawBase()
  }
  return { canvas, size, contentW, contentH, pad, key: gemSpriteKeyOf(request) }
}

/**
 * 同步取帧：命中（含 LRU touch）即返；miss 时按 specKey 去重 kick 异步烘焙并返回 null
 * （本帧回退几何符号；烘焙完成经 onGemSpritesChanged 通知重绘）。miss 负缓存 TTL 命中
 * 间接返回 null（TTL 过期即自动放行重解析——回收站找回/晚播种在下一轮重绘可见）。
 */
export function requestGemSprite(request: GemSpriteRequest): GemSpriteFrame | null {
  if (!(request.diameterPx > 0) || !(request.dpr > 0)) return null
  const key = gemSpriteKeyOf(request)
  const cached = frameCache.get(key)
  if (cached !== undefined) {
    frameCache.delete(key)
    frameCache.set(key, cached) // LRU touch
    return cached
  }
  if (isSpecKeyMissing(request.specKey)) return null
  if (inFlight.has(key)) return null
  const bake = (async (): Promise<void> => {
    const texture = await resolveTextureCached(request.specKey)
    if (texture === null || isTextureMiss(texture)) {
      markSpecKeyMissing(request.specKey, isTextureMiss(texture) ? texture : { kind: 'definitive' })
      notifyChanged()
      return
    }
    try {
      const decoded = await deps.loadImage(texture.dataUrl)
      const frame = bakeFrame(decoded, request, texture.aspect)
      if (frame !== null) storeFrame(key, frame)
    } catch {
      // 解码/烘焙失败视同 definitive miss（specKey 粒度 TTL 负缓存，brushAssetCache 同纪律）
      markSpecKeyMissing(request.specKey, { kind: 'definitive' })
    }
    notifyChanged()
  })()
  inFlight.set(key, bake.then(
    () => {
      inFlight.delete(key)
    },
    () => {
      inFlight.delete(key)
    },
  ))
  return null
}

/** 测试复位（cache/负缓存 TTL/纹理解析缓存/在飞/订阅全清——依赖注入面独立复位）。 */
export function resetGemSpritesForTests(): void {
  frameCache.clear()
  missingUntil.clear()
  textureCache.clear()
  inFlight.clear()
  listeners.clear()
}
