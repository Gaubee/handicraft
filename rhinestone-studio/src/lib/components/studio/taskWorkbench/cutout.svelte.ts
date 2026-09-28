/*
 * 抠图层合成管线（rework-layer-model design §2——v4 渲染语义层核心）。
 *
 * 来源与时间戳：openspec/changes/rework-layer-model/design.md §2（v4 波 1 初始
 * 实现 2026-09-27）；v4 修复轮 F4（2026-09-28，Codex P1-4——/tmp/codex-layer-model-
 * v4-review.md）补「可见集接入+LRU 字节预算」（design §2 资源约束：不可见层不
 * 合成；多张 4K≈64MiB/张——条数上限不等于字节上限）；v4 修复轮二 G3（2026-09-28，
 * Codex 二轮 P1-4 在途竞态）补「按 key 合并 promise+可见订阅者集」——隐藏期完成
 * 的合成不占缓存、快速重显合并进在途单飞并登记 loading（修复轮一的跳过不登记
 * 形态会让重显层永久 idle）；预算口径定名 cache-owned estimate（二轮 P2）。
 *
 * 图层=遮罩：offscreen canvas(bbox.w×bbox.h) ← drawImage(原图 bbox 区域) ←
 * destination-in mask 位面（alpha 通道）→ 带 alpha 的真图层位图；主画布按树序
 * 叠加（背景层=原图可隐藏）。
 *
 * 缓存：Map<(baseImageRef, maskRef, bbox), {canvas, thumb}> 内容寻址 LRU（双上界：
 * 条数 96 与 maskBits 同档 + 字节 512MiB cache-owned estimate——超限逐出最旧）；
 * mask 编辑提交后树/mask 工件推进 → maskEntry.ref 自然换键 → 旧条目失效重合成
 * （不显式失效）。请求面由 store.requestCutoutsForTree 传入**可见节点集**（F4）
 * ——隐藏子树不进请求（不启动新合成）；条目随请求集收缩（隐藏即释放 entry 引用，
 * 重显示同键热命中；在途合成按订阅集判定回填/缓存——G3）。
 *
 * 降级（坏输入不炸画布——沿 2b 单层降级语义）：
 *   - mask 位面坏（长度≠w*h）→ entry error：该层不渲染+图层行警示；
 *   - 原图不可解码 → entry error：同上（背景层仍可单独显示原图）；
 *   - 环境无 2d canvas（jsdom）→ entry idle 静默缺位：DOM 结构照常，画布缺像素。
 *
 * 缩略图：合成时一并派生（≤48px 高等比缩采样）——treeView 图层行抠图缩略渲染。
 *
 * Svelte 5 runes：entries 为模块级 $state（消费方 $derived 自动追踪）。
 */

import type { ObjectNode } from '@handicraft/contracts'
import { getMaskEntryOf, type MaskBits, type MaskEntry } from './maskBits.svelte.js'

export interface CutoutEntry {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  canvas: HTMLCanvasElement | null
  /** 缩略图（≤48px 高——treeView 行内展示）。 */
  thumb: HTMLCanvasElement | null
  error: string | null
  /** 当前条目对应的缓存键（异步竞态防护——请求返回时键已换=丢弃）。 */
  key: string | null
}

/** LRU 条目上界（与 maskBits MASK_CACHE_MAX 同档——多层 4K bbox 位图的有界内存面）。 */
export const CUTOUT_CACHE_MAX = 96

/**
 * LRU 字节预算上界（F4/Codex P1-4；修复轮二 G3 口径定名）：4K RGBA canvas 单张
 * ≈64MiB——96 条数量上限理论峰值≈6GiB backing store，不等于字节上限。512MiB≈8 张
 * 4K 满幅，超限逐出最旧（条数/字节双上界，先到先逐）。
 *
 * **口径=cache-owned estimate**（Codex 二轮 P2 定名）：仅统计缓存主位图+缩略的
 * w×h×4 尺寸估算——**不含** WorkbenchLayerItem 每消费实例自建的 bbox canvas 副本、
 * 合成期间的临时面（mask canvas）与 GPU backing store 实耗；全页 canvas 内存上限
 * （纳入消费副本/并发合成面）=后续架构项，本预算不虚报覆盖。测试可经
 * setCutoutCacheOwnedBytesMaxForTests 调小预算（默认值不变——产品语义恒 512MiB）。
 */
export const CUTOUT_CACHE_OWNED_BYTES_MAX = 512 * 1024 * 1024

/** 缩略图高度上界（px）。 */
export const CUTOUT_THUMB_MAX_H = 48

/** 运行时字节预算（测试可调小——默认 CUTOUT_CACHE_OWNED_BYTES_MAX）。 */
let cacheOwnedBytesMax = CUTOUT_CACHE_OWNED_BYTES_MAX

/** 测试注入小预算（真实浏览器/生产恒默认 512MiB；resetCutoutsForTests 还原）。 */
export function setCutoutCacheOwnedBytesMaxForTests(bytes: number): void {
  cacheOwnedBytesMax = bytes
}

interface CacheEntry {
  canvas: HTMLCanvasElement
  thumb: HTMLCanvasElement | null
  /** 字节估算（cache-owned 口径：主位图+缩略 w*h*4——canvas 无字节读面，按画布尺寸估）。 */
  bytes: number
}

/** 条目字节估算（HTMLCanvasElement 按 width*height*4 RGBA 估——F4 字节预算面）。 */
function cutoutBytesOf(canvas: HTMLCanvasElement, thumb: HTMLCanvasElement | null): number {
  let bytes = canvas.width * canvas.height * 4
  if (thumb !== null) bytes += thumb.width * thumb.height * 4
  return bytes
}

const cache = new Map<string, CacheEntry>()

/**
 * 在途合成（修复轮二 G3——Codex 二轮 P1-4 在途竞态）：按缓存键合并的单飞 promise
 * 载体 + **当前可见订阅者集**（nodeId）。隐藏收缩（requestCutouts 请求集变小）把
 * 节点移出订阅集；完成时只向仍在订阅且期望键未漂移的节点回填 entry；订阅集空
 * （隐藏期完成）的结果不占缓存（位图无消费者=即弃，不占 LRU 字节）。
 */
interface InFlightCutout {
  subscribers: Set<string>
}

const inFlight = new Map<string, InFlightCutout>()
/** 当前缓存字节累计（cache-owned estimate 口径——getCutoutCacheOwnedBytes 测试/监控读面）。 */
let cacheBytes = 0

let entries = $state<Map<string, CutoutEntry>>(new Map())

// ---------------------------------------------------------------- 宿主注入面（jsdom/测试）

/** 画布 2d 上下文结构面（真实 CanvasRenderingContext2D 满足；测试桩实现同构）。 */
export interface Cutout2dContext {
  globalCompositeOperation: string
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
  createImageData(w: number, h: number): { data: Uint8ClampedArray }
  putImageData(image: { data: Uint8ClampedArray }, dx: number, dy: number): void
  clearRect(x: number, y: number, w: number, h: number): void
}

/** 宿主能力面（浏览器真身；jsdom/单测注入桩——createCanvas 返回 null=环境无 2d canvas 降级）。 */
export interface CutoutHost {
  createCanvas(): HTMLCanvasElement | null
  contextOf(canvas: HTMLCanvasElement): Cutout2dContext | null
  loadImage(url: string): Promise<({ width: number; height: number } & unknown) | null>
}

const browserHost: CutoutHost = {
  createCanvas(): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null
    return document.createElement('canvas')
  },
  contextOf(canvas: HTMLCanvasElement): Cutout2dContext | null {
    const ctx = canvas.getContext('2d')
    return ctx === null ? null : adaptBrowser2dContext(ctx)
  },
  loadImage(url: string): Promise<({ width: number; height: number } & unknown) | null> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
  },
}

/**
 * 宿主窄适配（F8d/Codex Standards P2）：CanvasRenderingContext2D → Cutout2dContext
 * 的显式逐成员包装（结构接口的 image 参数逆变不可直接赋值——接口 image=unknown
 * 供测试桩；宿主面 image 实为 CanvasImageSource，此适配是唯一收窄点，经验证：
 * 合成链只以 9 参 drawImage/putImageData(createImageData 产物)/clearRect 调用）。
 */
function adaptBrowser2dContext(ctx: CanvasRenderingContext2D): Cutout2dContext {
  return {
    get globalCompositeOperation(): string {
      return ctx.globalCompositeOperation
    },
    set globalCompositeOperation(value: string) {
      // 窄适配（F8d）：宿主 enum 型属性收窄——合成链只写标准操作名（source-over/
      // destination-in），非法值宿主按规范忽略不改状态
      ctx.globalCompositeOperation = value as GlobalCompositeOperation
    },
    drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
      ctx.drawImage(image as CanvasImageSource, sx, sy, sw, sh, dx, dy, dw, dh)
    },
    createImageData(w: number, h: number): { data: Uint8ClampedArray } {
      return ctx.createImageData(w, h)
    },
    putImageData(image: { data: Uint8ClampedArray }, dx: number, dy: number): void {
      ctx.putImageData(image as ImageData, dx, dy)
    },
    clearRect(x: number, y: number, w: number, h: number): void {
      ctx.clearRect(x, y, w, h)
    },
  }
}

/** 宿主注入点（测试替换后必须经 resetCutoutsForTests 还原）。 */
export const cutoutRuntime: { host: CutoutHost } = { host: browserHost }

// ---------------------------------------------------------------- 缓存键/纯合成（直测面）

export interface BboxLike {
  x: number
  y: number
  w: number
  h: number
}

/** 内容寻址缓存键：baseImageRef | maskRef | bbox（任一变化=新图层位图）。 */
export function cutoutKey(baseImageRef: string | null, maskRef: string, bbox: BboxLike): string {
  return `${baseImageRef ?? 'no-base'}|${maskRef}|${bbox.x},${bbox.y},${bbox.w},${bbox.h}`
}

/** mask 位面健康校验（坏数据 typed 拒——长度≠w*h 即坏，不猜测）。 */
export function assertMaskBitsHealthy(bits: MaskBits): void {
  if (bits.w <= 0 || bits.h <= 0) throw new RangeError(`mask 尺寸退化（${bits.w}×${bits.h}）`)
  if (bits.bits.length !== bits.w * bits.h) {
    throw new RangeError(`mask 位面长度 ${bits.bits.length} ≠ w*h=${bits.w * bits.h}`)
  }
}

/**
 * 合成一步（纯绘制面——真实 canvas 或测试桩同构）：
 * 主面 drawImage 原图 bbox 区域 → 蒙版面 alpha 位图（位面采样上/下采样到 bbox 尺寸）
 * → destination-in 合入。调用方保证 bits 已过 assertMaskBitsHealthy。
 */
export function composeCutoutSurfaces(
  ctx: Cutout2dContext,
  maskCtx: Cutout2dContext,
  maskCanvas: unknown,
  image: unknown,
  bits: MaskBits,
  bbox: BboxLike,
): void {
  const w = bbox.w
  const h = bbox.h
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(image, bbox.x, bbox.y, w, h, 0, 0, w, h)
  // 蒙版 alpha 位图（rgb=255 白——destination-in 只吃 alpha）
  const maskImage = maskCtx.createImageData(w, h)
  const { data } = maskImage
  for (let y = 0; y < h; y += 1) {
    const my = Math.min(bits.h - 1, Math.floor(((y + 0.5) / h) * bits.h))
    const rowBase = my * bits.w
    for (let x = 0; x < w; x += 1) {
      const mx = Math.min(bits.w - 1, Math.floor(((x + 0.5) / w) * bits.w))
      const p = (y * w + x) * 4
      data[p] = 255
      data[p + 1] = 255
      data[p + 2] = 255
      data[p + 3] = bits.bits[rowBase + mx] === 1 ? 255 : 0
    }
  }
  maskCtx.clearRect(0, 0, w, h)
  maskCtx.putImageData(maskImage, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, 0, 0, w, h, 0, 0, w, h)
  ctx.globalCompositeOperation = 'source-over'
}

/** 缩略尺寸派生（≤48px 高等比；退化输入=原尺寸）。 */
export function thumbSizeOf(w: number, h: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w, h }
  if (h <= CUTOUT_THUMB_MAX_H) return { w, h }
  const scale = CUTOUT_THUMB_MAX_H / h
  return { w: Math.max(1, Math.round(w * scale)), h: CUTOUT_THUMB_MAX_H }
}

// ---------------------------------------------------------------- LRU（maskBits 同式+字节预算 F4）

function cacheGet(key: string): CacheEntry | null {
  const hit = cache.get(key) ?? null
  if (hit !== null) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

/** 逐出条目降级：被逐出位图不得被 entries 强持有（数量/字节双上界有效性）。 */
function demoteEvicted(evicted: CacheEntry): void {
  const orphans = [...entries].filter(([, entry]) => entry.canvas === evicted.canvas).map(([nodeId]) => nodeId)
  if (orphans.length === 0) return
  const next = new Map(entries)
  for (const nodeId of orphans) next.set(nodeId, IDLE_ENTRY)
  entries = next
}

function cachePut(key: string, value: CacheEntry): void {
  if (cache.has(key)) {
    const previous = cache.get(key)!
    cacheBytes -= previous.bytes
    cache.delete(key)
  }
  cache.set(key, value)
  cacheBytes += value.bytes
  // 双上界逐出（F4）：条数>96 或 字节>预算（默认 512MiB——cache-owned 口径）→ 从最旧逐出至回到界内
  while (cache.size > CUTOUT_CACHE_MAX || cacheBytes > cacheOwnedBytesMax) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const evicted = cache.get(oldest) ?? null
    cache.delete(oldest)
    if (evicted !== null) {
      cacheBytes -= evicted.bytes
      demoteEvicted(evicted)
    }
  }
}

/** 缓存字节读数（cache-owned estimate 口径——测试/监控断言锚，见 CUTOUT_CACHE_OWNED_BYTES_MAX 注）。 */
export function getCutoutCacheOwnedBytes(): number {
  return cacheBytes
}

// ---------------------------------------------------------------- 读取器

const IDLE_ENTRY: CutoutEntry = { phase: 'idle', canvas: null, thumb: null, error: null, key: null }

export function getCutoutEntryOf(nodeId: string): CutoutEntry {
  return entries.get(nodeId) ?? IDLE_ENTRY
}

/** entries 身份（store 投影缓存键成分——替换即位面变化）。 */
export function getCutoutEntriesIdentity(): object {
  return entries
}

function setEntry(nodeId: string, entry: CutoutEntry): void {
  const next = new Map(entries)
  next.set(nodeId, entry)
  entries = next
}

// ---------------------------------------------------------------- 请求（组件 $effect 驱动）

export interface RequestCutoutsOptions {
  baseImageUrl: string | null
  /** 电流 baseImage 工件引用（缓存键成分——ref 变即全键失效）。 */
  baseImageRef: string | null
  getMaskEntry?: (nodeId: string) => MaskEntry
}

/**
 * 按当前树请求各节点抠图层（幂等——ready/loading(同键) 不重做；组件 $effect 内调用）。
 * 根节点（parent=null）不合成——根=画布容器，背景层由原图直接承担（design §1）。
 * F4：调用方（store.requestCutoutsForTree）传**可见节点集**（含祖先显隐）——隐藏
 * 子树不进请求（不启动新合成/不分配 bbox canvas）；条目面随请求集收缩（隐藏层
 * entry 释放）。孤儿清理：entries 随传入节点集收缩。
 * G3（修复轮二——Codex 二轮 P1-4 在途竞态）：同键在途请求**合并进既有单飞**并
 * 登记新订阅者的 loading entry（修复轮一此处直接跳过且不登记——隐藏期完成+快速
 * 重显=层永久 idle）；在途订阅集随请求集收缩——隐藏期完成的合成无消费者：不占
 * 缓存、不复活 entry。
 */
export function requestCutouts(nodes: ObjectNode[], opts: RequestCutoutsOptions): void {
  const getMaskEntry = opts.getMaskEntry ?? getMaskEntryOf
  const liveIds = new Set(nodes.filter((node) => node.parent !== null).map((node) => node.id))
  const orphans = [...entries.keys()].filter((nodeId) => !liveIds.has(nodeId))
  if (orphans.length > 0) {
    const next = new Map(entries)
    for (const nodeId of orphans) next.delete(nodeId)
    entries = next
  }
  // 在途订阅集收缩（G3）：出请求集（隐藏/换任务/树收缩）的节点不再是消费者——
  // 其在途结果完成时不回填、不占缓存
  for (const flight of inFlight.values()) {
    for (const subscriber of flight.subscribers) {
      if (!liveIds.has(subscriber)) flight.subscribers.delete(subscriber)
    }
  }
  for (const node of nodes) {
    if (node.parent === null) continue
    if (node.bbox.w <= 0 || node.bbox.h <= 0) continue
    const maskEntry = getMaskEntry(node.id)
    if (maskEntry.phase === 'error') {
      const current = entries.get(node.id)
      if (current?.phase !== 'error' || current.error !== maskEntry.error) {
        setEntry(node.id, { phase: 'error', canvas: null, thumb: null, error: `mask 位面坏：${maskEntry.error ?? '未知'}`, key: null })
      }
      continue
    }
    if (maskEntry.phase !== 'ready' || maskEntry.bits === null) {
      const current = entries.get(node.id)
      if (current !== undefined && current.phase === 'loading') continue // 位面在途——就绪后本 effect 重跑
      if (current?.phase === 'ready') setEntry(node.id, IDLE_ENTRY)
      else if (current === undefined) setEntry(node.id, IDLE_ENTRY)
      continue
    }
    const key = cutoutKey(opts.baseImageRef, maskEntry.ref ?? `${maskEntry.phase}`, node.bbox)
    const cached = cacheGet(key)
    if (cached !== null) {
      const current = entries.get(node.id)
      if (current?.phase !== 'ready' || current.canvas !== cached.canvas) {
        setEntry(node.id, { phase: 'ready', canvas: cached.canvas, thumb: cached.thumb, error: null, key })
      }
      continue
    }
    if (opts.baseImageUrl === null || opts.baseImageRef === null) continue // 无原图锚——不合成（位面就绪仅蒙版面可用）
    const existingFlight = inFlight.get(key)
    if (existingFlight !== undefined) {
      // G3：同键在途——合并订阅（单飞 promise 不重合成）+ 登记 loading entry
      //（重显层立即进入 loading 态，完成时按订阅回填 ready）
      existingFlight.subscribers.add(node.id)
      const current = entries.get(node.id)
      if (current?.phase !== 'loading' || current.key !== key) {
        setEntry(node.id, { phase: 'loading', canvas: null, thumb: null, error: null, key })
      }
      continue
    }
    const flight: InFlightCutout = { subscribers: new Set([node.id]) }
    inFlight.set(key, flight)
    setEntry(node.id, { phase: 'loading', canvas: null, thumb: null, error: null, key })
    void (async (): Promise<void> => {
      let outcome: CutoutEntry
      try {
        const image = await cutoutRuntime.host.loadImage(opts.baseImageUrl!)
        if (image === null) {
          outcome = { phase: 'error', canvas: null, thumb: null, error: '原图不可解码——抠图层不可用（背景层不受影响）', key }
        } else {
          assertMaskBitsHealthy(maskEntry.bits!)
          const { canvas, thumb } = synthesize(image, maskEntry.bits!, node.bbox)
          if (canvas === null) {
            // 环境无 2d canvas（jsdom）——静默缺位（DOM 照常，画布缺像素）
            outcome = { phase: 'idle', canvas: null, thumb: null, error: null, key }
          } else {
            outcome = { phase: 'ready', canvas, thumb, error: null, key }
          }
        }
      } catch (error) {
        outcome = {
          phase: 'error',
          canvas: null,
          thumb: null,
          error: error instanceof Error ? error.message : String(error),
          key,
        }
      } finally {
        inFlight.delete(key)
      }
      // G3：完成时只向当前订阅集回填（隐藏收缩后无消费者=不占缓存不复活 entry）；
      // 逐节点竞态防护：期望键已换（mask/树推进）的订阅者不回填（下次请求接管）
      if (outcome.phase === 'ready' && flight.subscribers.size > 0) {
        cachePut(key, { canvas: outcome.canvas!, thumb: outcome.thumb, bytes: cutoutBytesOf(outcome.canvas!, outcome.thumb) })
      }
      for (const subscriber of flight.subscribers) {
        if (entries.get(subscriber)?.key === key) setEntry(subscriber, outcome)
      }
    })()
  }
}

/** 合成真身（宿主面 canvas/ctx 缺席=null 降级）。 */
function synthesize(
  image: { width: number; height: number } & unknown,
  bits: MaskBits,
  bbox: BboxLike,
): { canvas: HTMLCanvasElement | null; thumb: HTMLCanvasElement | null } {
  const { host } = cutoutRuntime
  const canvas = host.createCanvas()
  const maskCanvas = host.createCanvas()
  const thumbCanvas = host.createCanvas()
  if (canvas === null || maskCanvas === null || thumbCanvas === null) return { canvas: null, thumb: null }
  canvas.width = bbox.w
  canvas.height = bbox.h
  maskCanvas.width = bbox.w
  maskCanvas.height = bbox.h
  const ctx = host.contextOf(canvas)
  const maskCtx = host.contextOf(maskCanvas)
  const thumbCtx = host.contextOf(thumbCanvas)
  if (ctx === null || maskCtx === null || thumbCtx === null) return { canvas: null, thumb: null }
  composeCutoutSurfaces(ctx, maskCtx, maskCanvas, image, bits, bbox)
  const thumb = thumbSizeOf(bbox.w, bbox.h)
  thumbCanvas.width = thumb.w
  thumbCanvas.height = thumb.h
  thumbCtx.clearRect(0, 0, thumb.w, thumb.h)
  thumbCtx.drawImage(canvas, 0, 0, bbox.w, bbox.h, 0, 0, thumb.w, thumb.h)
  return { canvas, thumb: thumbCanvas }
}

// ---------------------------------------------------------------- 复位

/** 装载/换任务复位（缓存保留——跨任务内容寻址键不冲突；条目面清空）。 */
export function resetCutoutsForTask(): void {
  entries = new Map()
}

/** 测试复位（缓存/字节计数/预算还原默认/在途订阅集/宿主注入一并还原浏览器真身）。 */
export function resetCutoutsForTests(host?: CutoutHost): void {
  resetCutoutsForTask()
  cache.clear()
  cacheBytes = 0
  cacheOwnedBytesMax = CUTOUT_CACHE_OWNED_BYTES_MAX
  inFlight.clear()
  cutoutRuntime.host = host ?? browserHost
}
