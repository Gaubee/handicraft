/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 studio-layers 1.1 单一入口] computeLayer：层配置快照 → 单策略子轮。
 *    内部复用 runCompute 单请求形状（strategies:[strategy]——与旧 runLayouts 五策略循环的
 *    子轮调用逐字段同构，worker 协议零改动）；输出 {gems, warnings, dropped} 与旧子轮
 *    **逐位相等**（compatibility oracle fixture 守卫，src/tests/studio/computeLayer.test.ts
 *    ——oracle 于旧 runLayouts（stores/studio.svelte.ts）退役前采集，采集方法见测试头注）。
 * 2. [契约语义（图层稿 §C.1；R2 §一 P0-3 六项矩阵）] LayerComputeSession：单 worker 逐层
 *    串行调度内核——层配置快照隔离 / run 号作废迟到结果 / 取消（ComputeAbortedError 身份）/
 *    逐层渐进落地（重算期间旧结果保留，画布不闪空）/ 单层错误隔离（只污染该层 entry）/
 *    进度聚合 segment 1 单元 + N 层（旧 1+i/6 的层级化）。本文件零 $state（纯 lib，
 *    2.3 computeQueue store 的调度内核；replay gate 1.5 逐层直调 computeLayer 单入口）。
 * 3. [GPU 预留位（design §2.9）] 快照/run/cancel/onResult 协议是唯一契约——GPU/worker/主线程
 *    均为实现细节；不写 GPU 代码、不改 run/cancel/onResult 协议。
 *
 * 退役面差异（Owner 授权、显式登记非回归）：五策略并行缓存与秒切废除——切策略 = 该层重算
 * （旧结果保持可见直到新结果落地，渐进落地语义）。
 */

import type {
  Block,
  EngineImage,
  Gem,
  GridSpec,
  LayoutOptions,
  SegmentOptions,
  StrategyId,
  Warning,
} from '$lib/engine'
import { ComputeAbortedError, STRATEGY_LABELS, type ComputeProgress } from '$lib/workers/computeCore'
import { runCompute } from '$lib/workers/computeClient'

// ---------------------------------------------------------------------------
// 单一入口：computeLayer（层配置快照 → 单策略子轮）
// ---------------------------------------------------------------------------

/** 单层计算输入 = 层配置快照（image/segmentOpts/grid 为全局段一轮产物；blocks = 该层 effectiveBlocks）。 */
export interface LayerComputeInput {
  image: EngineImage
  /** 与全局 segment 轮同参（blocks 复用路径下 image 不参与计算，仅供协议形状）。 */
  segmentOpts: SegmentOptions & { minAreaPx: number }
  strategy: StrategyId
  /** density Record（两级回落派生后）+ seed（LAYOUT_SEED 纪律）+ relax（层物理）。 */
  layoutOpts: LayoutOptions
  grid: GridSpec
  /** 该层 effectiveBlocks（blocks 复用路径跳过 segment——与旧子轮一致）。 */
  blocks: Block[]
  /** 进度标签层名（缺席回退策略中文名——1.5 replay 传层名得到 `层「N」排布中…`）。 */
  progressLayerName?: string
}

/** 单层计算产物（旧 runLayouts 子轮的 {gems, warnings, dropped} 同构；色映射是消费侧后处理）。 */
export interface LayerComputeOutput {
  gems: Gem[]
  warnings: Warning[]
  dropped: number
}

export interface LayerComputeHandle {
  promise: Promise<LayerComputeOutput>
  /** 幂等取消：立即/尽早 reject(ComputeAbortedError)（与 runCompute 两侧实现同身份）。 */
  cancel(): void
}

/**
 * 一切层计算的单一入口：内部 = runCompute({ strategies: [strategy], blocks, … }) 单请求形状。
 * 进度事件直通（label 默认策略名；传入 progressLayerName 时改写为层名语法 `层「N」排布中…`）。
 */
export function computeLayer(
  input: LayerComputeInput,
  onProgress?: (progress: ComputeProgress) => void,
): LayerComputeHandle {
  const forward =
    onProgress === undefined
      ? undefined
      : (progress: ComputeProgress): void => {
          onProgress(
            progress.stage === 'done'
              ? progress
              : { ...progress, label: `层「${input.progressLayerName ?? STRATEGY_LABELS[input.strategy]}」排布中…` },
          )
        }
  const handle = runCompute(
    {
      image: input.image,
      segmentOpts: input.segmentOpts,
      strategies: [input.strategy],
      layoutOpts: input.layoutOpts,
      grid: input.grid,
      blocks: input.blocks,
    },
    forward,
  )
  return {
    promise: handle.promise.then((output) => {
      const result = output.results[input.strategy]
      return { gems: result.gems, warnings: result.warnings, dropped: result.dropped ?? 0 }
    }),
    cancel: () => handle.cancel(),
  }
}

// ---------------------------------------------------------------------------
// 逐层串行调度内核：LayerComputeSession（六项矩阵的 ①③④⑤⑥ 宿主）
// ---------------------------------------------------------------------------

/** 批内单层请求（layerId = 结果归属键；layerName = 进度标签）。 */
export interface LayerBatchItem {
  layerId: string
  layerName: string
  input: LayerComputeInput
}

/** 逐层落地结果（渐进落地数据面；error 态 = 单层失败隔离——只污染该层）。 */
export interface LayerResultEntry {
  layerId: string
  strategy: StrategyId
  gems: Gem[]
  warnings: Warning[]
  dropped: number
  durationMs: number
  error?: string
}

export interface LayerBatchCallbacks {
  /** 每层结算即落地（渐进）：错误层也回调（entry.error 携带摘要），不阻断后续层。 */
  onLayerSettled?: (entry: LayerResultEntry) => void
  /** 批级进度聚合：done = 1 + 已开始层数（旧 1+i/6 语义层级化）；label 带层名。 */
  onProgress?: (progress: ComputeProgress) => void
}

/** 注入面（测试 stub 单层失败/挂起；生产缺省 = computeLayer 单一入口）。 */
export type LayerComputeFn = (
  input: LayerComputeInput,
  onProgress?: (progress: ComputeProgress) => void,
) => LayerComputeHandle

export interface LayerSessionDeps {
  compute?: LayerComputeFn
}

/**
 * 逐层串行调度会话（单 worker 语义——P0 不并行层）：
 * - 结果注册表 `results`：未触碰层跨批保留（① 结果缓存 / ⑥ 重算期间旧结果保留——
 *   渐进落地 = 只在层结算时覆写该层 entry，重算启动不清空）；
 * - run 号作废：start() 递增 run；cancel()/新 start() 使旧批在途层轮的迟到结果丢弃（④）；
 * - 取消：cancel() 取消在途层轮（reject ComputeAbortedError——③），批等待不 reject
 *   （与旧 cancelCompute 对调用方的语义一致：作废 + 复位，不上抛）；
 * - 错误隔离：单层异常只写该层 error entry，后续层照常（⑤）。
 */
export class LayerComputeSession {
  private entries = new Map<string, LayerResultEntry>()
  private run = 0
  private inFlight: LayerComputeHandle | null = null
  private computeFn: LayerComputeFn

  constructor(deps: LayerSessionDeps = {}) {
    this.computeFn = deps.compute ?? computeLayer
  }

  /** 最近一次落地的逐层结果（未触碰层跨批保留；重算期间旧 entry 保持可读）。 */
  get results(): ReadonlyMap<string, LayerResultEntry> {
    return this.entries
  }

  /** 是否有批在途（含被作废但未结算的旧批）。 */
  get busy(): boolean {
    return this.inFlight !== null
  }

  /**
   * 启动一批逐层串行计算（同刻仅一批有效——新 start 作废旧批的迟到结果）。
   * 返回该批实际落地的 entry 清单（取消/作废时为已落地前缀，不上抛）。
   */
  async start(batch: readonly LayerBatchItem[], callbacks: LayerBatchCallbacks = {}): Promise<LayerResultEntry[]> {
    const run = ++this.run
    const settled: LayerResultEntry[] = []
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]
      if (run !== this.run) return settled
      callbacks.onProgress?.({
        stage: `layout:${item.input.strategy}`,
        done: 1 + i,
        total: 1 + batch.length,
        label: `层「${item.layerName}」排布中…`,
      })
      const t0 = performance.now()
      try {
        const handle = this.computeFn(item.input)
        this.inFlight = handle
        const output = await handle.promise
        if (run !== this.run) return settled // 迟到结果丢弃（run 作废）
        const entry: LayerResultEntry = {
          layerId: item.layerId,
          strategy: item.input.strategy,
          gems: output.gems,
          warnings: output.warnings,
          dropped: output.dropped,
          durationMs: performance.now() - t0,
        }
        this.entries.set(item.layerId, entry)
        settled.push(entry)
        callbacks.onLayerSettled?.(entry)
      } catch (error) {
        if (run !== this.run) return settled // 作废批的失败同样不落地
        if (error instanceof ComputeAbortedError) return settled // 取消：不写 entry，批就此收束
        const entry: LayerResultEntry = {
          layerId: item.layerId,
          strategy: item.input.strategy,
          gems: [],
          warnings: [],
          dropped: 0,
          durationMs: performance.now() - t0,
          error: error instanceof Error ? error.message : String(error),
        }
        this.entries.set(item.layerId, entry)
        settled.push(entry)
        callbacks.onLayerSettled?.(entry)
      } finally {
        if (this.inFlight !== null && run === this.run) this.inFlight = null
      }
    }
    return settled
  }

  /** 取消在途批：作废 run（迟到结果丢弃）+ 取消在途层轮（reject ComputeAbortedError）。 */
  cancel(): void {
    this.run++
    this.inFlight?.cancel()
    this.inFlight = null
  }
}
