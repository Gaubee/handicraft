/*
 * 抠图层合成管线（rework-layer-model design §2——v4 渲染语义层核心）。
 *
 * 图层=遮罩：offscreen canvas(bbox.w×bbox.h) ← drawImage(原图 bbox 区域) ←
 * destination-in mask 位面（alpha 通道）→ 带 alpha 的真图层位图；主画布按树序
 * 叠加（背景层=原图可隐藏）。
 *
 * 缓存：Map<(baseImageRef, maskRef, bbox), {canvas, thumb}> 内容寻址 LRU（上限与
 * maskBits 同档 96 条）；mask 编辑提交后树/mask 工件推进 → maskEntry.ref 自然换键
 * → 旧条目失效重合成（不显式失效）。
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

/** 缩略图高度上界（px）。 */
export const CUTOUT_THUMB_MAX_H = 48

const cache = new Map<string, { canvas: HTMLCanvasElement; thumb: HTMLCanvasElement | null }>()
const inFlight = new Set<string>()

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
    return ctx === null ? null : (ctx as unknown as Cutout2dContext)
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

// ---------------------------------------------------------------- LRU（maskBits 同式）

function cacheGet(key: string): { canvas: HTMLCanvasElement; thumb: HTMLCanvasElement | null } | null {
  const hit = cache.get(key) ?? null
  if (hit !== null) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

/** 逐出条目降级：被逐出位图不得被 entries 强持有（96 条上界有效性）。 */
function demoteEvicted(evicted: { canvas: HTMLCanvasElement }): void {
  const orphans = [...entries].filter(([, entry]) => entry.canvas === evicted.canvas).map(([nodeId]) => nodeId)
  if (orphans.length === 0) return
  const next = new Map(entries)
  for (const nodeId of orphans) next.set(nodeId, IDLE_ENTRY)
  entries = next
}

function cachePut(key: string, value: { canvas: HTMLCanvasElement; thumb: HTMLCanvasElement | null }): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > CUTOUT_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const evicted = cache.get(oldest) ?? null
    cache.delete(oldest)
    if (evicted !== null) demoteEvicted(evicted)
  }
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
 * 孤儿清理：entries 随传入节点集收缩。
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
    if (inFlight.has(key)) continue
    if (opts.baseImageUrl === null || opts.baseImageRef === null) continue // 无原图锚——不合成（位面就绪仅蒙版面可用）
    inFlight.add(key)
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
            cachePut(key, { canvas, thumb })
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
      // 竞态防护：返回时该节点期望键已换（mask/树推进）= 丢弃本结果（下次请求接管）
      if (entries.get(node.id)?.key === key) setEntry(node.id, outcome)
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
  thumbCtx.drawImage(canvas as unknown as CanvasImageSource, 0, 0, bbox.w, bbox.h, 0, 0, thumb.w, thumb.h)
  return { canvas, thumb: thumbCanvas }
}

// ---------------------------------------------------------------- 复位

/** 装载/换任务复位（缓存保留——跨任务内容寻址键不冲突；条目面清空）。 */
export function resetCutoutsForTask(): void {
  entries = new Map()
}

/** 测试复位（缓存/宿主注入一并还原浏览器真身）。 */
export function resetCutoutsForTests(host?: CutoutHost): void {
  resetCutoutsForTask()
  cache.clear()
  inFlight.clear()
  cutoutRuntime.host = host ?? browserHost
}
