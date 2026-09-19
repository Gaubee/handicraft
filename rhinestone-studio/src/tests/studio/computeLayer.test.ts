/*
 * [2026-09-20 studio-layers 1.1] computeLayer 兼容性 harness（R2 §一 P0-3 / 图层稿 §C.4）。
 *
 * **oracle fixture 采集方法**（现行五策略路径 stores/studio.svelte.ts runLayouts 退役前采集）：
 * 1. 驱动**现行 studio store 全管线**（resetStudioForTests → loadFromEngineImage → 参数面
 *    （默认 SS10/gap0.4/密度100%/relax 关 + 密度 0.6 / relax 开变体）→ waitForStudioIdle），
 *    读取旧路径的真实派生参数（getEffectiveBlocks/getDensitySpec/getGrid/getRelax）；
 * 2. 以与 runLayouts 子轮（stores/studio.svelte.ts :680-692）**逐字段同构**的 runCompute
 *    单策略调用（strategies:[sid] + blocks 复用路径）采集 raw 输出 {gems（colorId 恒空串——
 *    色映射是 store 侧后处理）/warnings/dropped} 落盘 fixture（ORACLE_REGEN=1 再生；
 *    再生只允许在语义变更有意发生时执行并随 commit 说明）；
 * 3. 同文件「活路径锁定」断言：store 全管线 results[sid] == fixture + mapColors 色化
 *    （applyColors 同式：STARTER_PALETTE 最近邻 + 无颜色覆写）——即 fixture 忠实于现行
 *    五策略循环的输出（runLayouts 退役（2.3）前恒成立；2.3 store 切换后本节随其复验更新）。
 *
 * harness 断言面：
 * - 主断言：单 rest 层（= 全部块）同参下 computeLayer 输出与 oracle fixture **逐位相等**
 *   （gems 全字段/warnings/dropped）——多图 × 五策略 × 密度/relax 变体；
 * - 六项矩阵：① 结果缓存（未触碰层跨批保留）② 进度 1+N（segment 1 单元 + N 层）
 *   ③ 取消 reject 身份（ComputeAbortedError）④ run 作废（迟到结果不落地）
 *   ⑤ 错误隔离（单层失败只污染该层 entry）⑥ 重算期间旧结果保留（渐进落地）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PIXELS_PER_MM,
  SS_TABLE,
  STARTER_PALETTE,
  STRATEGY_IDS,
  mapColors,
  type Block,
  type EngineImage,
  type ShapeId,
  type StrategyId,
  type Warning,
} from '$lib/engine'
import { ComputeAbortedError, type ComputeProgress } from '$lib/workers/computeCore'
import { runCompute } from '$lib/workers/computeClient'
import {
  computeLayer,
  LayerComputeSession,
  type LayerBatchItem,
  type LayerComputeInput,
  type LayerComputeOutput,
  type LayerResultEntry,
} from '$lib/studio/computeLayer'
import {
  getDensitySpec,
  getEffectiveBlocks,
  getGrid,
  getRelax,
  getResults,
  loadFromEngineImage,
  recompute,
  resetStudioForTests,
  setGlobalDensity,
  setRelax,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes, fixtureTwoRects } from '../engine/helpers'

// ---------------------------------------------------------------------------
// oracle fixture：固定输入 × 五策略（旧五策略循环的参数派生面 + raw 子轮输出）
// ---------------------------------------------------------------------------

const ORACLE_PATH = join(__dirname, 'fixtures', 'compute-layer-oracle.json')
const SEGMENT_OPTS = { k: 8, seed: 1, gemDiameterPx: SS_TABLE.SS10 * PIXELS_PER_MM } as const

/** 与 studio minAreaFor 同值同式（推导常量，归 engineVersion 语义——studio.svelte.ts :399-402）。 */
function minAreaFor(image: EngineImage): number {
  return Math.min(4000, Math.max(12, Math.round(image.width * image.height * 0.0005)))
}

interface OracleGem {
  id: string
  x: number
  y: number
  colorId: string
  blockId: string
  shapeId: ShapeId
  diameterMm: number
  rotationDeg?: number
  assetId?: string
}

interface OracleStrategy {
  gemCount: number
  dropped: number
  gems: OracleGem[]
  warnings: Warning[]
}

interface OracleCase {
  source: string
  density: number
  relax: { boundary: boolean; repulsion: boolean }
  strategies: Record<StrategyId, OracleStrategy>
}

interface OracleDoc {
  collectedFrom: string
  cases: Record<string, OracleCase>
}

/** 旧路径 case 表（图 × 参数变体——与现行 store 初始态/参数面同参）。 */
const CASES: Array<{
  name: string
  image: () => EngineImage
  source: string
  density: number
  relax: { boundary: boolean; repulsion: boolean }
}> = [
  { name: 'shapes-default', image: fixtureShapes, source: 'fixtureShapes 120²', density: 1, relax: { boundary: false, repulsion: false } },
  { name: 'two-rects-default', image: fixtureTwoRects, source: 'fixtureTwoRects 96×64', density: 1, relax: { boundary: false, repulsion: false } },
  { name: 'two-rects-density06', image: fixtureTwoRects, source: 'fixtureTwoRects 96×64', density: 0.6, relax: { boundary: false, repulsion: false } },
  { name: 'shapes-relax', image: fixtureShapes, source: 'fixtureShapes 120²', density: 1, relax: { boundary: true, repulsion: true } },
]

/** 驱动现行 store 全管线到指定 case 参数面（= 旧 runLayouts 的真实参数派生路径）。 */
async function driveStoreToCase(c: (typeof CASES)[number]): Promise<void> {
  resetStudioForTests()
  loadFromEngineImage(c.image(), `${c.name}.png`, 'handoff')
  await waitForStudioIdle()
  if (c.density !== 1 || c.relax.boundary || c.relax.repulsion) {
    if (c.density !== 1) setGlobalDensity(c.density, { immediate: true })
    if (c.relax.boundary || c.relax.repulsion) setRelax(c.relax)
    recompute()
    await waitForStudioIdle()
  }
}

/** 与 runLayouts 子轮（:680-692）逐字段同构的 raw 采集调用。 */
async function subroundOf(
  image: EngineImage,
  sid: StrategyId,
  blocksNow: Block[],
  densityNow: Record<string, number>,
  gridNow: ReturnType<typeof getGrid>,
  relaxNow: { boundary: boolean; repulsion: boolean },
): Promise<LayerComputeOutput> {
  const output = await runCompute({
    image,
    segmentOpts: { ...SEGMENT_OPTS, minAreaPx: minAreaFor(image) },
    strategies: [sid],
    layoutOpts: { density: densityNow, seed: 1, relax: relaxNow },
    grid: gridNow,
    blocks: blocksNow,
  }).promise
  const r = output.results[sid]
  return { gems: r.gems, warnings: r.warnings, dropped: r.dropped ?? 0 }
}

beforeAll(async () => {
  if (process.env.ORACLE_REGEN === '1') {
    const cases: Record<string, OracleCase> = {}
    for (const c of CASES) {
      // 1) 驱动现行 store 全管线取得旧路径真实派生参数
      await driveStoreToCase(c)
      const image = c.image()
      const blocksNow = getEffectiveBlocks().map((b) => ({ ...b }))
      const densityNow = { ...getDensitySpec() }
      const gridNow = { ...getGrid() }
      const relaxNow = { ...getRelax() }
      // 2) 逐策略 raw 子轮采集（与 runLayouts 子轮逐字段同构）
      const strategies = {} as Record<StrategyId, OracleStrategy>
      for (const sid of STRATEGY_IDS) {
        const raw = await subroundOf(image, sid, blocksNow, densityNow, gridNow, relaxNow)
        strategies[sid] = {
          gemCount: raw.gems.length,
          dropped: raw.dropped,
          gems: raw.gems.map((g) => ({ ...g })) as OracleGem[],
          warnings: raw.warnings.map((w) => ({ ...w })),
        }
      }
      cases[c.name] = { source: c.source, density: c.density, relax: relaxNow, strategies }
    }
    resetStudioForTests()
    const doc: OracleDoc = {
      collectedFrom: 'stores/studio.svelte.ts runLayouts 子轮（studio-layers 1.1 采集；ORACLE_REGEN=1 再生）',
      cases,
    }
    mkdirSync(join(__dirname, 'fixtures'), { recursive: true })
    writeFileSync(ORACLE_PATH, `${JSON.stringify(doc, null, 1)}\n`, 'utf8')
  }
  if (!existsSync(ORACLE_PATH)) {
    throw new Error('oracle fixture 缺失：先以 ORACLE_REGEN=1 pnpm exec vitest run src/tests/studio/computeLayer.test.ts 采集')
  }
})

afterAll(() => {
  resetStudioForTests()
})

function loadOracle(): OracleDoc {
  return JSON.parse(readFileSync(ORACLE_PATH, 'utf8')) as OracleDoc
}

let oracle: OracleDoc

beforeAll(() => {
  oracle = loadOracle()
})

// ---------------------------------------------------------------------------
// harness：主断言 + 活路径锁定 + 六项矩阵
// ---------------------------------------------------------------------------

describe('1.1 computeLayer 兼容性 harness', () => {
  describe.each(CASES)('主断言：%s（单 rest 层同参 → 逐位相等）', (c) => {
    it('五策略 gems 全字段/warnings/dropped 与 oracle 逐位相等', async () => {
      await driveStoreToCase(c)
      const image = c.image()
      const base: Omit<LayerComputeInput, 'strategy'> = {
        image,
        segmentOpts: { ...SEGMENT_OPTS, minAreaPx: minAreaFor(image) },
        layoutOpts: { density: { ...getDensitySpec() }, seed: 1, relax: { ...getRelax() } },
        grid: { ...getGrid() },
        blocks: getEffectiveBlocks().map((b) => ({ ...b })),
      }
      for (const sid of STRATEGY_IDS) {
        const output = await computeLayer({ ...base, strategy: sid }).promise
        const fixed = oracle.cases[c.name].strategies[sid]
        expect(output.gems.map((g) => ({ ...g })), `${c.name}/${sid} gems`).toEqual(fixed.gems)
        expect(output.warnings, `${c.name}/${sid} warnings`).toEqual(fixed.warnings)
        expect(output.dropped, `${c.name}/${sid} dropped`).toBe(fixed.dropped)
        expect(output.gems.length).toBe(fixed.gemCount)
      }
    })
  })

  describe.each(CASES)('活路径锁定：%s（现行 runLayouts 全管线 == oracle + mapColors）', (c) => {
    it('五策略 store results 与 fixture 色化后逐位相等（warnings/dropped/spacingCount 同）', async () => {
      await driveStoreToCase(c)
      const results = getResults()
      const blocksNow = getEffectiveBlocks().map((b) => ({ ...b }))
      const palette = STARTER_PALETTE.map((p) => ({ ...p }))
      for (const sid of STRATEGY_IDS) {
        const res = results[sid]
        expect(res, `store ${sid} 结果应就绪`).not.toBeNull()
        if (!res) continue
        expect(res.error).toBeUndefined()
        const fixed = oracle.cases[c.name].strategies[sid]
        // fixture raw（colorId 空串）→ applyColors 同式色化（STARTER_PALETTE 最近邻 + 无覆写）
        const colored = fixed.gems.map((g) => ({ ...g }))
        if (colored.length > 0 && palette.length > 0) mapColors(colored, blocksNow, palette)
        expect(res.gems.map((g) => ({ ...g })), `${c.name}/${sid} 色化 gems`).toEqual(colored)
        expect(res.warnings).toEqual(fixed.warnings)
        expect(res.dropped).toBe(fixed.dropped)
        expect(res.spacingCount).toBe(fixed.warnings.filter((w) => w.kind === 'spacing').length)
      }
    })
  })

  // -------------------------------------------------------------------------
  // 六项矩阵（LayerComputeSession——2.3 computeQueue 的调度内核）
  // -------------------------------------------------------------------------

  /** 两层可计算输入：store 块集二分（各层独立 layout 的最小形态）。 */
  async function twoLayerInputs(): Promise<{ A: LayerBatchItem; B: LayerBatchItem; image: EngineImage }> {
    await driveStoreToCase(CASES[0])
    const image = CASES[0].image()
    const base = {
      image,
      segmentOpts: { ...SEGMENT_OPTS, minAreaPx: minAreaFor(image) },
      layoutOpts: { density: { ...getDensitySpec() }, seed: 1, relax: { ...getRelax() } },
      grid: { ...getGrid() },
    }
    const blocks = getEffectiveBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    return {
      image,
      A: { layerId: 'L1', layerName: '图层 1', input: { ...base, strategy: 'hybrid', blocks: blocks.slice(0, 1).map((b) => ({ ...b })) } },
      B: { layerId: 'L2', layerName: '图层 2', input: { ...base, strategy: 'hex-thin', blocks: blocks.slice(1).map((b) => ({ ...b })) } },
    }
  }

  it('①⑥ 结果缓存 + 重算期间旧结果保留：未触碰层跨批保留；重算层旧 entry 落地前保持可读', async () => {
    const { A, B } = await twoLayerInputs()
    // hybrid 首算真算、后续重算挂起（deferred）——隔离「重算期间」观察窗
    let hybridCalls = 0
    let resolveA: (value: LayerComputeOutput) => void = () => {}
    const deferred = new Promise<LayerComputeOutput>((resolve) => {
      resolveA = resolve
    })
    const session = new LayerComputeSession({
      compute: (input) => {
        if (input.strategy !== 'hybrid') return computeLayer(input)
        hybridCalls += 1
        return hybridCalls <= 1
          ? computeLayer(input)
          : { promise: deferred, cancel: () => {} }
      },
    })
    // 第一轮：A/B 均落地
    const first = await session.start([A, B])
    expect(first.map((e) => e.layerId)).toEqual(['L1', 'L2'])
    const oldA = session.results.get('L1')
    const oldB = session.results.get('L2')
    expect(oldA && oldA.gems.length).toBeGreaterThan(0)
    expect(oldB && oldB.gems.length).toBeGreaterThan(0)
    // 第二轮：仅重算 A（挂起）——期间旧 entry 保持可读（渐进落地，计算中画布不闪空）
    const inflight = session.start([A])
    await Promise.resolve()
    expect(session.results.get('L1')).toBe(oldA) // ⑥ 重算期间旧结果保留
    resolveA({ gems: [], warnings: [], dropped: 42 })
    const landed = await inflight
    expect(landed[0]?.dropped).toBe(42)
    expect(session.results.get('L1')).not.toBe(oldA) // 落地后才覆写
    expect(session.results.get('L2')).toBe(oldB) // ① 未触碰层 entry 身份跨批保留
  })

  it('② 进度单位：segment 1 单元 + N 层（1+i / 1+N，label 带层名）', async () => {
    const { A, B } = await twoLayerInputs()
    const session = new LayerComputeSession()
    const events: ComputeProgress[] = []
    await session.start([A, B], { onProgress: (p) => events.push({ ...p }) })
    expect(events).toEqual([
      { stage: 'layout:hybrid', done: 1, total: 3, label: '层「图层 1」排布中…' },
      { stage: 'layout:hex-thin', done: 2, total: 3, label: '层「图层 2」排布中…' },
    ])
  })

  it('③ 取消 reject 身份：computeLayer 单入口 cancel → ComputeAbortedError；session.cancel 批收束不上抛', async () => {
    const { A } = await twoLayerInputs()
    // 单入口：jsdom 主线程 fallback——cancel 在微任务执行前置位，阶段检查点抛出（worker 路径立即 reject，同身份）
    const handle = computeLayer(A.input)
    handle.cancel()
    await expect(handle.promise).rejects.toBeInstanceOf(ComputeAbortedError)
    // 会话：取消在途层轮 → 批等待收束（不上抛）、该层不落 entry
    let rejectInFlight: ((error: Error) => void) | null = null
    const session = new LayerComputeSession({
      compute: () => ({
        promise: new Promise<LayerComputeOutput>((_, reject) => {
          rejectInFlight = reject
        }),
        cancel: () => {
          rejectInFlight?.(new ComputeAbortedError())
        },
      }),
    })
    const batch = session.start([A]) // 同步挂到 deferred
    session.cancel()
    const settled = await batch
    expect(settled).toEqual([])
    expect(session.results.get('L1')).toBeUndefined()
  })

  it('④ run 作废：新批 start 作废旧批——旧批迟到结果不落地', async () => {
    const { A, B } = await twoLayerInputs()
    let resolveOld: (value: LayerComputeOutput) => void = () => {}
    const oldDeferred = new Promise<LayerComputeOutput>((resolve) => {
      resolveOld = resolve
    })
    const session = new LayerComputeSession({
      compute: (input) =>
        input.strategy === 'hybrid'
          ? { promise: oldDeferred, cancel: () => {} }
          : computeLayer(input),
    })
    const oldBatch = session.start([A]) // A 挂起（deferred）
    const newBatch = await session.start([B]) // 新批（B 真算）——作废旧批
    expect(newBatch.map((e) => e.layerId)).toEqual(['L2'])
    expect(session.results.has('L1')).toBe(false) // 旧批未落地
    resolveOld({ gems: [], warnings: [], dropped: 0 }) // 旧批迟到结果
    expect((await oldBatch).length).toBe(0) // 迟到结果丢弃（不写 entry）
    expect(session.results.has('L1')).toBe(false)
  })

  it('⑤ 错误隔离：单层失败只污染该层 entry（error 字段），后续层照常', async () => {
    const { A, B } = await twoLayerInputs()
    const session = new LayerComputeSession({
      compute: (input) =>
        input.strategy === 'hybrid'
          ? { promise: Promise.reject(new Error('单层布局失败')), cancel: () => {} }
          : computeLayer(input),
    })
    const settled: LayerResultEntry[] = []
    const batch = await session.start([A, B], { onLayerSettled: (e) => settled.push(e) })
    expect(batch.map((e) => e.layerId)).toEqual(['L1', 'L2'])
    expect(settled.length).toBe(2)
    expect(session.results.get('L1')?.error).toBe('单层布局失败')
    expect(session.results.get('L1')?.gems).toEqual([])
    expect(session.results.get('L2')?.error).toBeUndefined()
    expect(session.results.get('L2')?.gems.length).toBeGreaterThan(0)
  })

  it('单入口进度标签：progressLayerName → 层「N」排布中…（1.5 replay 消费面）', async () => {
    const { A } = await twoLayerInputs()
    const events: ComputeProgress[] = []
    await computeLayer({ ...A.input, progressLayerName: '图层 3' }, (p) => events.push({ ...p })).promise
    expect(events[0]?.label).toBe('层「图层 3」排布中…')
    expect(events[0]?.stage).toBe('layout:hybrid')
  })
})
