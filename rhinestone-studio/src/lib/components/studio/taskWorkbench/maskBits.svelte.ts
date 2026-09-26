/*
 * mask 位面解码缓存（add-workbench-pro 2.2——blob mask 全链 D-2② 裁定）。
 * 两态 Mask2DRef 统一解码为 {w,h,bits}：
 *   inline —— 树工件内嵌（task.detail 已含字节）→ 同步解码，键=`inline:${treeBlobRef}:${nodeId}`
 *             （树推进即失效重解——笔刷编辑落新 tree 工件天然换键）。
 *   blob   —— taskArtifact 附件通道异步拉取（不阻塞首帧——渐进呈现），
 *             键=`blob:${blobRef}`（内容寻址即 revision——ref 变即新条目）。
 * LRU：Map 插入序 + 读取刷新（cap=MASK_CACHE_MAX 条——设计 §3「mask 解码缓存
 * LRU by blobRef+revision」的条目数上界；100 层批量解码场景 <2s 渐进就绪）。
 * 坏数据态：单层 error 徽标（长度≠w*h/非 0|1 字节）不炸画布——其余层照常渲染。
 * Svelte 5 runes：entries 为模块级 $state（消费方 $derived 自动追踪重渲）。
 */

import { decodeInlineMask, type ObjectNode } from '@handicraft/contracts'

export interface MaskBits {
  w: number
  h: number
  bits: Uint8Array
}

export type MaskLoadPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface MaskEntry {
  phase: MaskLoadPhase
  bits: MaskBits | null
  error: string | null
  /** 当前条目对应的源引用（blob=blobRef/inline=树键）——异步竞态防护（ref 换即重拉）。 */
  ref: string | null
}

/** LRU 条目上界（100 层批量+选中层高频重读场景的有界内存面）。 */
export const MASK_CACHE_MAX = 96

const cache = new Map<string, MaskBits>()

let entries = $state<Map<string, MaskEntry>>(new Map())
let loadSeq = 0

function cacheGet(key: string): MaskBits | null {
  const hit = cache.get(key) ?? null
  if (hit !== null) {
    // 读取刷新 recency（LRU——Map 删除重插）
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

/**
 * 逐出条目降级（Codex 复评建议三——2d 补全）：LRU 逐出的 bytes 不得被 entries
 * 强持有（否则 96 项上界形同虚设）。被逐出位面仍有活跃条目的节点回落 idle
 * （bits 释放——该层骨架位渐进呈现，下次 nodes/tree 变化时 requestNodeMasks
 * 重拉；不自动即时重拉：>96 活跃层场景下「逐出→重拉→再逐出」会形成活锁，
 * 有界内存优先）。entries 随树有界后，正常 ≤96 层场景不触发降级。
 */
function demoteEvictedBits(evicted: MaskBits): void {
  const orphans = [...entries].filter(([, entry]) => entry.bits === evicted).map(([nodeId]) => nodeId)
  if (orphans.length === 0) return
  const next = new Map(entries)
  for (const nodeId of orphans) next.set(nodeId, { phase: 'idle', bits: null, error: null, ref: null })
  entries = next
}

function cachePut(key: string, bits: MaskBits): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, bits)
  while (cache.size > MASK_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const evicted = cache.get(oldest) ?? null
    cache.delete(oldest)
    if (evicted !== null) demoteEvictedBits(evicted)
  }
}

function setEntry(nodeId: string, entry: MaskEntry): void {
  const next = new Map(entries)
  next.set(nodeId, entry)
  entries = next
}

const IDLE_ENTRY: MaskEntry = { phase: 'idle', bits: null, error: null, ref: null }

export function getMaskEntryOf(nodeId: string): MaskEntry {
  return entries.get(nodeId) ?? IDLE_ENTRY
}

/**
 * entries 身份（消费方投影缓存键成分——2d 性能门 §3 投影缓存：entries 替换即位面
 * 状态变化；读取 $state Map 即建立 Svelte 依赖，不破坏 $derived 追踪）。
 */
export function getMaskEntriesIdentity(): object {
  return entries
}

/** blob 字节 → MaskBits（坏数据 typed 拒——长度/取值校验不猜测）。 */
function maskBitsFromBytes(w: number, h: number, bytes: Uint8Array): MaskBits {
  if (bytes.byteLength !== w * h) {
    throw new RangeError(`mask blob 长度 ${bytes.byteLength} ≠ w*h=${w * h}`)
  }
  for (const b of bytes) {
    if (b !== 0 && b !== 1) throw new RangeError('mask blob 字节必须 ∈ {0,1}（引擎 Mask2D 同构）')
  }
  return { w, h, bits: bytes }
}

export interface RequestMasksContext {
  /** 电流树工件引用（inline 键成分——树推进自动失效）。 */
  treeBlobRef: string | null
  /** blob 态附件拉取通道（taskArtifact→字节；异常=该层错误态）。 */
  fetchMaskBlob: (blobRef: string) => Promise<Uint8Array>
}

/**
 * 按当前树请求各节点位面（幂等——ready/loading 条目不重做；组件 $effect 内调用）。
 * inline 同步就绪；blob 未缓存则异步拉取（loading 骨架位→ready/error 渐进）。
 * 孤儿清理（Codex 复评建议三——2d 补全）：entries 随传入节点集收缩——树刷新/
 * 删节点后不在树内的节点条目即行清除（不驻留 ready——内存随树有界）。
 */
export function requestNodeMasks(nodes: ObjectNode[], ctx: RequestMasksContext): void {
  const seq = loadSeq
  const liveIds = new Set(nodes.map((node) => node.id))
  const orphans = [...entries.keys()].filter((nodeId) => !liveIds.has(nodeId))
  if (orphans.length > 0) {
    const next = new Map(entries)
    for (const nodeId of orphans) next.delete(nodeId)
    entries = next
  }
  for (const node of nodes) {
    const current = entries.get(node.id)
    if (node.mask.kind === 'inline') {
      const key = `inline:${ctx.treeBlobRef ?? 'no-tree'}:${node.id}`
      const cached = cacheGet(key)
      if (cached !== null) {
        if (current?.phase !== 'ready' || current.bits !== cached) setEntry(node.id, { phase: 'ready', bits: cached, error: null, ref: key })
        continue
      }
      let bits: MaskBits
      try {
        bits = decodeInlineMask(node.mask)
      } catch (error) {
        setEntry(node.id, { phase: 'error', bits: null, error: error instanceof Error ? error.message : String(error), ref: key })
        continue
      }
      cachePut(key, bits)
      setEntry(node.id, { phase: 'ready', bits, error: null, ref: key })
      continue
    }
    // blob 态（异步拉取——不阻塞首帧；ref 换即重拉，竞态由 entry.ref 防护）
    const key = `blob:${node.mask.blobRef}`
    const cached = cacheGet(key)
    if (cached !== null) {
      if (current?.phase !== 'ready' || current.bits !== cached) setEntry(node.id, { phase: 'ready', bits: cached, error: null, ref: key })
      continue
    }
    if (current?.phase === 'loading' && current.ref === key) continue
    setEntry(node.id, { phase: 'loading', bits: null, error: null, ref: key })
    void ctx
      .fetchMaskBlob(node.mask.blobRef)
      .then((bytes) => {
        // 迟到响应防线（Codex 2b 复核 P1-1）：全局 loadSeq 之外还须核对当前条目
        // ref——refresh 装载（保留 loadSeq）后旧 blobRef 的在途响应不得覆盖已换新
        // ref/inline 的条目（否则错误缩略图/叠加）。
        if (seq !== loadSeq) return
        if (entries.get(node.id)?.ref !== key) return
        const bits = maskBitsFromBytes(node.mask.w, node.mask.h, bytes)
        cachePut(key, bits)
        setEntry(node.id, { phase: 'ready', bits, error: null, ref: key })
      })
      .catch((error: unknown) => {
        if (seq !== loadSeq) return
        if (entries.get(node.id)?.ref !== key) return
        setEntry(node.id, {
          phase: 'error',
          bits: null,
          error: error instanceof Error ? error.message : String(error),
          ref: key,
        })
      })
  }
}

/** 装载/换任务复位（LRU 缓存保留——跨任务内容寻址键不冲突；条目面清空）。 */
export function resetMaskEntriesForTask(): void {
  loadSeq += 1
  entries = new Map()
}

/** 测试复位（缓存一并清空）。 */
export function resetMaskBitsForTests(): void {
  resetMaskEntriesForTask()
  cache.clear()
}
