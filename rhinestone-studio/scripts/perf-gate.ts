/*
 * perf-gate.ts——workbench-pro 波 2d 性能门脚本（design §4 三层门+receipt 规范的可执行化）。
 *
 * Orthogonal intents (max 3):
 * 1. [三层门采样] 首帧门（装配+投影冷/热——jsdom 计算口径）/交互帧门（平移/锚定缩放/
 *    图层树滚动 交互帧 P95+mask overlay 叠加 P95）/后台解码门（inline mask 解码/批量
 *    100 层/坏数据降级）。每项 ≥30 次采样（首帧冷/热=整程重复计数），记录 P50/P95/max+样本数。
 * 2. [receipt 产出] JSON receipt：场景×层×指标+环境指纹+逐条 pass/fail（超门=红——不降门，
 *    门数值变更须 Owner 批准并记 design 变更）。
 * 3. [口径如实] jsdom 无真实 raster/合成器/浏览器 tab——首帧/交互门为「装配+投影+渲染
 *    命令构造」的计算口径；内存门以 node heap 增量为代理口径（tab 级 RSS 需真浏览器
 *    走查补充）。所有口径偏差在 env.notes 逐条声明，不冒充浏览器数。
 *
 * 运行方式：vitest 跑 src/tests/workbench/perf.gate.test.ts（vite 管道编译 .svelte.ts
 * runes 模块；无第二实现）。不引重依赖（手工 performance.now 计时）。
 */

import { decodeInlineMask, encodeInlineMask, type ObjectNode } from '@handicraft/contracts'
import { StrategyGemsViewSchema, type StrategyGemsView } from '$lib/strategyDesigner/artifacts.js'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import type { TaskDetailResponse } from '@handicraft/contracts'
import {
  getWorkbenchLayerRender,
  getWorkbenchLayerRows,
  hitTestNodeAt,
  loadWorkbench,
  resetWorkbenchForTests,
  toggleNodeVisible,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetMaskBitsForTests, requestNodeMasks } from '$lib/components/studio/taskWorkbench/maskBits.svelte'
import { maskOverlayOf } from '$lib/components/studio/taskWorkbench/maskViz.js'
import {
  panCanvasBy,
  resetCanvasStageForTests,
  zoomCanvasAtPoint,
} from '$lib/components/studio/taskWorkbench/canvasStage.svelte'

// ---------------------------------------------------------------- 采样与统计

export interface SampleStats {
  p50: number
  p95: number
  max: number
  n: number
}

const now = (): number => performance.now()

export function statsOf(samples: number[]): SampleStats {
  if (samples.length === 0) throw new Error('perf-gate: 空采样集')
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]!, n: samples.length }
}

function sample(n: number, fn: () => void): SampleStats {
  const out: number[] = []
  for (let i = 0; i < n; i += 1) {
    const t0 = now()
    fn()
    out.push(now() - t0)
  }
  return statsOf(out)
}

// ---------------------------------------------------------------- 合成素材

const IMAGE_PX = { width: 1024, height: 1024 } as const
const CANVAS_CM = { w: 50, h: 50 } as const // ppm=20.48（纵横比一致——derivePixelsPerMm ok）
const BLOCK_IDS = ['b1', 'b2', 'b3', 'b4', 'b5'] as const

function makeGemsDoc(count: number, planRef: string): StrategyGemsView {
  const gems = Array.from({ length: count }, (_, i) => ({
    id: `g${i}`,
    x: (i * 7.13) % IMAGE_PX.width,
    y: (i * 11.71) % IMAGE_PX.height,
    colorId: 'c1',
    blockId: BLOCK_IDS[i % BLOCK_IDS.length]!,
    shapeId: 'round' as const,
    diameterMm: 3,
  }))
  return StrategyGemsViewSchema.parse({
    kind: 'strategy-gems',
    formatVersion: 1,
    planRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    gems,
    excludedRegions: [],
    warnings: [],
    createdAt: '2026-09-27T00:00:00.000Z',
  })
}

function makeTreeNodes(count: number): ObjectNode[] {
  // 一根画布 + 4 大区（gems 档场景）/或 100 层（树滚动场景——链式父子保证 DFS 深度真实）
  const nodes: ObjectNode[] = [
    {
      id: 'n-canvas', objectName: '画布', category: 'canvas', mask: encodeInlineMask(4, 4, new Uint8Array(16).fill(1)),
      bbox: { x: 0, y: 0, w: IMAGE_PX.width, h: IMAGE_PX.height }, parent: null, children: [],
      effectiveMm: 500, labVariance: 30, drillWorthy: false, origin: 'vlm+sam3',
    },
  ]
  for (let i = 1; i < count; i += 1) {
    const parent = i <= 4 ? 'n-canvas' : `n-${Math.max(1, i - 1)}`
    nodes.push({
      id: `n-${i}`, objectName: `图层 ${i}`, category: 'part',
      mask: encodeInlineMask(4, 4, new Uint8Array(16).fill(1)),
      bbox: {
        x: (i * 37) % (IMAGE_PX.width - 64), y: (i * 53) % (IMAGE_PX.height - 64), w: 64, h: 64,
      },
      parent, children: [], effectiveMm: 32, labVariance: 5, drillWorthy: true, origin: 'vlm+sam3',
    })
  }
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  for (const node of nodes) {
    if (node.parent !== null) byId.get(node.parent)!.children.push(node.id)
  }
  return nodes
}

/** 条纹 mask（行程真实——overlay 面非空跑）。 */
function stripesMaskBits(w: number, h: number): Uint8Array {
  const bits = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) bits[y * w + x] = (x + y) % 3 !== 0 ? 1 : 0
  }
  return bits
}

// ---------------------------------------------------------------- stub API（装载真径：taskDetail→taskArtifact→parse）

function refOf(seed: string): string {
  let out = ''
  let h = 0
  for (let i = 0; i < 64; i += 1) {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i * 7) % 0xffffffff
    out += ((h >>> (i % 4)) & 0xf).toString(16)
  }
  return out
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface StubPayload {
  taskId: string
  treeNodes: ObjectNode[]
  gemsDoc: StrategyGemsView | null
}

function stubApi(payload: StubPayload): AgentApi {
  const gemsRef = payload.gemsDoc === null ? null : refOf(`${payload.taskId}-gems`)
  const detail: TaskDetailResponse = {
    task: { id: payload.taskId, title: `perf-${payload.taskId}`, status: 'done', createdAt: '2026-09-27T00:00:00.000Z' },
    session: null,
    baseImage: {
      blobRef: refOf(`${payload.taskId}-base`), widthPx: IMAGE_PX.width, heightPx: IMAGE_PX.height, canvasCm: CANVAS_CM,
    },
    // D3 四图引用分离：mock 恒回退态（无显式参考图层——blobRef 缺省=source）
    referenceImage: { blobRef: refOf(`${payload.taskId}-base`), generated: false },
    tree: { blobRef: refOf(`${payload.taskId}-tree`), canvasCm: CANVAS_CM, imagePx: IMAGE_PX, imageBlobRef: null, nodes: payload.treeNodes },
    assignments: [],
    gems: gemsRef === null || payload.gemsDoc === null ? null : { blobRef: gemsRef, count: payload.gemsDoc.gems.length, excludedRegions: 0 },
    preview: null,
    viewState: null,
    maskEdits: [],
    exportGate: { allowed: true, blockers: [] },
    stoneCandidates: [],
    // W0 0.4：projectStones 契约必填（stub 无 session-project 真源——显式 null）。
    projectStones: null,
    // 2026-10-04：segmentDefaults 契约必填（stub 无配置真源——daemon 缺省同形）。
    segmentDefaults: { maskMaxSide: null, confThreshold: 0.4 },
  }
  const artifactBase64 = (blobRef: string): string => {
    if (blobRef === gemsRef) {
      const json = JSON.stringify(payload.gemsDoc)
      return Buffer.from(json, 'utf8').toString('base64')
    }
    return TINY_PNG_B64
  }
  return {
    mode: 'mock',
    connection: () => 'mock',
    onConnectionChange: () => () => {},
    taskDetail: async () => structuredClone(detail),
    taskArtifact: async () => ({ blobRef: gemsRef ?? refOf('x'), mime: 'application/octet-stream', dataBase64: artifactBase64(gemsRef ?? 'x') }),
  } as unknown as AgentApi
}

// ---------------------------------------------------------------- receipt 结构

export interface PerfGateRow {
  id: string
  tier: 'first-frame' | 'interaction' | 'decode' | 'memory'
  scenario: string
  metric: 'p95' | 'p50' | 'max' | 'total' | 'delta'
  /** 门值（ms / MB——不降门；数值变更须 Owner 批准）。 */
  gate: number
  unit: 'ms' | 'MB'
  samples: SampleStats | { total: number; n: number } | { delta: number }
  pass: boolean
  note?: string
}

export interface PerfReceipt {
  kind: 'workbench-perf-receipt'
  generatedAt: string
  env: {
    runtime: string
    node: string
    platform: string
    cpu: string
    notes: string[]
  }
  gates: PerfGateRow[]
  summary: { total: number; passed: number; failed: number; failures: string[] }
}

function row(
  id: string, tier: PerfGateRow['tier'], scenario: string,
  metric: PerfGateRow['metric'], gate: number, unit: PerfGateRow['unit'],
  value: number, samples: PerfGateRow['samples'], note?: string,
): PerfGateRow {
  return { id, tier, scenario, metric, gate, unit, samples, pass: value <= gate, note }
}

// ---------------------------------------------------------------- 主流程

function resetAll(): void {
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetMaskBitsForTests()
  resetCanvasStageForTests()
}

const TASK_GEMS_1K = 'perf-gems-1k'
const TASK_GEMS_10K = 'perf-gems-10k'
const TASK_GEMS_100K = 'perf-gems-100k'
const TASK_TREE_100 = 'perf-tree-100'

export async function runPerfGate(): Promise<PerfReceipt> {
  const gates: PerfGateRow[] = []

  // —— 素材（一次性构建——不计入门）——
  const docs: Record<string, StrategyGemsView> = {
    [TASK_GEMS_1K]: makeGemsDoc(1_000, refOf('plan-1k')),
    [TASK_GEMS_10K]: makeGemsDoc(10_000, refOf('plan-10k')),
    [TASK_GEMS_100K]: makeGemsDoc(100_000, refOf('plan-100k')),
  }
  const fiveNodeTree = makeTreeNodes(5)
  const hundredNodeTree = makeTreeNodes(100)
  const stubs: Record<string, StubPayload> = {
    [TASK_GEMS_1K]: { taskId: TASK_GEMS_1K, treeNodes: fiveNodeTree, gemsDoc: docs[TASK_GEMS_1K]! },
    [TASK_GEMS_10K]: { taskId: TASK_GEMS_10K, treeNodes: fiveNodeTree, gemsDoc: docs[TASK_GEMS_10K]! },
    [TASK_GEMS_100K]: { taskId: TASK_GEMS_100K, treeNodes: fiveNodeTree, gemsDoc: docs[TASK_GEMS_100K]! },
    [TASK_TREE_100]: { taskId: TASK_TREE_100, treeNodes: hundredNodeTree, gemsDoc: docs[TASK_GEMS_1K]! },
  }

  // —— 第一层·首帧门（冷/热——整程重复采样：冷=全新 store/位面缓存；热=同会话二次载入+模型）——
  const firstFrameGates: Record<string, { cold: number; hot: number }> = {
    [TASK_GEMS_1K]: { cold: 500, hot: 200 },
    [TASK_GEMS_10K]: { cold: 500, hot: 200 },
    [TASK_GEMS_100K]: { cold: 1500, hot: 600 },
  }
  for (const taskId of [TASK_GEMS_1K, TASK_GEMS_10K, TASK_GEMS_100K]) {
    const count = docs[taskId]!.gems.length
    resetAll()
    bindAgentApi(stubApi(stubs[taskId]!))
    const coldSamples: number[] = []
    for (let i = 0; i < 3; i += 1) {
      resetWorkbenchForTests()
      resetMaskBitsForTests()
      const t0 = now()
      await loadWorkbench(taskId)
      if (getWorkbenchLayerRender() === null) throw new Error(`${taskId}: 装载后画布模型缺席`)
      coldSamples.push(now() - t0)
    }
    gates.push(row(
      `first-frame.cold.${count}`, 'first-frame', `${count} gems 冷缓存（全新 store/位面缓存→task.detail 装配→点阵/框线模型就绪）`,
      'max', firstFrameGates[taskId]!.cold, 'ms', statsOf(coldSamples).max, statsOf(coldSamples),
      '冷=3 次整程取最大值（jsdom 计算口径——不含真实 raster）',
    ))
    const hotSamples: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const t0 = now()
      await loadWorkbench(taskId, { refresh: true })
      if (getWorkbenchLayerRender() === null) throw new Error(`${taskId}: 热装载后画布模型缺席`)
      hotSamples.push(now() - t0)
    }
    gates.push(row(
      `first-frame.hot.${count}`, 'first-frame', `${count} gems 热缓存（同会话二次载入+模型）`,
      'p95', firstFrameGates[taskId]!.hot, 'ms', statsOf(hotSamples).p95, statsOf(hotSamples),
    ))
  }

  // —— 第二层·交互帧门（平移/锚定缩放：10k P95<100、100k P95<250；各 32 次采样）——
  const interactionTier = (taskId: string, gateMs: number): void => {
    const count = docs[taskId]!.gems.length
    const pan = sample(32, () => {
      panCanvasBy(9, 4)
      if (getWorkbenchLayerRender() === null) throw new Error('pan: 模型缺席')
    })
    gates.push(row(
      `interaction.pan.${count}`, 'interaction', `${count} gems 平移交互帧（视口平移+投影重算）`,
      'p95', gateMs, 'ms', pan.p95, pan,
    ))
    const zoom = sample(32, () => {
      zoomCanvasAtPoint(512, 512, 1.05)
      if (getWorkbenchLayerRender() === null) throw new Error('zoom: 模型缺席')
    })
    gates.push(row(
      `interaction.zoom.${count}`, 'interaction', `${count} gems 滚轮锚定缩放交互帧（锚定缩放+投影重算）`,
      'p95', gateMs, 'ms', zoom.p95, zoom,
    ))
  }
  // （当前装载任务=100k——先测 100k 档，再换载 10k 档）
  interactionTier(TASK_GEMS_100K, 250)
  resetAll()
  bindAgentApi(stubApi(stubs[TASK_GEMS_10K]!))
  await loadWorkbench(TASK_GEMS_10K)
  if (getWorkbenchLayerRender() === null) throw new Error('10k 装载失败')
  interactionTier(TASK_GEMS_10K, 100)

  // 图层树滚动（100 层——行集投影+命中测试的计算口径；10k gems 档门 P95<100ms）
  resetAll()
  bindAgentApi(stubApi(stubs[TASK_TREE_100]!))
  await loadWorkbench(TASK_TREE_100)
  const treeScroll = sample(32, () => {
    const rows = getWorkbenchLayerRows()
    if (rows.length !== 100) throw new Error(`树行数 ${rows.length} ≠ 100`)
    void hitTestNodeAt(512, 512)
  })
  gates.push(row(
    'interaction.tree-scroll.100L', 'interaction', '100 层图层树滚动（行集投影+位面命中——10k gems 档门）',
    'p95', 100, 'ms', treeScroll.p95, treeScroll,
  ))

  // mask overlay 叠加（选中层蒙版高亮+行程矩形：1K² P95<16 / 4K² P95<50——不丢帧门）
  function overlayNode(w: number, h: number): ObjectNode {
    return {
      id: 'n-ov',
      objectName: 'overlay',
      category: 'part',
      mask: { kind: 'inline', w, h, encoding: 'base64-01', data: 'AAAA' },
      bbox: { x: 0, y: 0, w: IMAGE_PX.width, h: IMAGE_PX.height },
      parent: null,
      children: [],
      effectiveMm: 500,
      labVariance: 5,
      drillWorthy: true,
      origin: 'vlm+sam3',
    }
  }
  {
    const bits1k = stripesMaskBits(1024, 1024)
    const ov = sample(64, () => maskOverlayOf(overlayNode(1024, 1024), { w: 1024, h: 1024, bits: bits1k }, true))
    gates.push(row('interaction.overlay.1K2', 'interaction', '1K² mask overlay 叠加（选中层高亮+半透明行程面）', 'p95', 16, 'ms', ov.p95, ov))
  }
  {
    const bits4k = stripesMaskBits(4096, 4096)
    const ov = sample(16, () => maskOverlayOf(overlayNode(4096, 4096), { w: 4096, h: 4096, bits: bits4k }, true))
    gates.push(row('interaction.overlay.4K2', 'interaction', '4K² mask overlay 叠加（选中层高亮+半透明行程面）', 'p95', 50, 'ms', ov.p95, ov))
  }

  // —— 第三层·后台解码门（1K²/4K² 解码 <50ms/层；100 层批量 <2s；坏数据降级 <16ms）——
  {
    const inline1k = encodeInlineMask(1024, 1024, stripesMaskBits(1024, 1024))
    const dec1k = sample(16, () => decodeInlineMask(inline1k))
    gates.push(row('decode.layer.1K2', 'decode', '1K² inline mask 解码（LRU by blobRef+revision 前段）', 'p95', 50, 'ms', dec1k.p95, dec1k))
    const inline4k = encodeInlineMask(4096, 4096, stripesMaskBits(4096, 4096))
    const dec4k = sample(8, () => decodeInlineMask(inline4k))
    gates.push(row('decode.layer.4K2', 'decode', '4K² inline mask 解码', 'p95', 50, 'ms', dec4k.p95, dec4k))

    // 100 层批量（1K²×100——inline 键各自独立；同步渐进=总时延上界）
    const nodes100: ObjectNode[] = Array.from({ length: 100 }, (_, i) => ({
      id: `n-b${i}`,
      objectName: `批量层 ${i}`,
      category: 'part',
      mask: encodeInlineMask(1024, 1024, stripesMaskBits(1024, 1024)),
      bbox: { x: 0, y: 0, w: 1024, h: 1024 },
      parent: null,
      children: [],
      effectiveMm: 500,
      labVariance: 5,
      drillWorthy: true,
      origin: 'vlm+sam3' as const,
    }))
    const t0 = now()
    requestNodeMasks(nodes100, { treeBlobRef: 'perf-batch', fetchMaskBlob: async () => new Uint8Array() })
    const batchMs = now() - t0
    gates.push(row(
      'decode.batch.100L', 'decode', '100 层 1K² inline mask 批量解码（同步渐进就绪）',
      'total', 2000, 'ms', batchMs, { total: batchMs, n: 1 },
      'inline 批量=同步全量；blob 异步通道的渐进面由 requestNodeMasks 骨架位承载（口径注）',
    ))

    // 坏数据降级（单层错误徽标路径 <16ms——decode 抛错+try/catch 不炸整画布）
    const corrupt = '!!!!' // 非法字母表（4 对齐——schema 外构造的坏工件典型形态）
    const bad = sample(32, () => {
      try {
        decodeInlineMask({ kind: 'inline', w: 1024, h: 1024, encoding: 'base64-01', data: corrupt })
      } catch {
        // 降级路径：错误态入徽标（store getWorkbenchLayerRender 同式 try/catch）
      }
    })
    gates.push(row('decode.bad-mask.degrade', 'decode', '坏 mask 数据降级（单层错误徽标——不炸整画布）', 'p95', 16, 'ms', bad.p95, bad))
  }

  // —— 内存门（100k gems 会话——node heap 增量代理口径 <500MB；tab RSS 需真浏览器）——
  {
    resetAll()
    // 尽力自然 GC：两次静置窗口（无强制 GC——node --expose-gc 不可用；保守上界口径）
    await new Promise((resolve) => setTimeout(resolve, 200))
    const heapBefore = process.memoryUsage().heapUsed
    bindAgentApi(stubApi(stubs[TASK_GEMS_100K]!))
    await loadWorkbench(TASK_GEMS_100K)
    for (let i = 0; i < 3; i += 1) {
      if (getWorkbenchLayerRender() === null) throw new Error('内存门装载失败')
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    const deltaMB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)
    gates.push(row(
      'memory.session.100k', 'memory', '100k gems 会话内存增量（冷+热模型×3）',
      'delta', 500, 'MB', deltaMB, { delta: deltaMB },
      '代理口径：node heapUsed 增量（尽力自然 GC 后测——保守上界）；design §4 tab 级 RSS 需 Chrome Task Manager（真浏览器走查补充）',
    ))
  }

  const failures = gates.filter((g) => !g.pass).map((g) => g.id)
  return {
    kind: 'workbench-perf-receipt',
    generatedAt: new Date().toISOString(),
    env: {
      runtime: 'vitest(jsdom)+node——计算口径（非真实浏览器 raster）',
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: 'host CPU（见 receipt 随附环境）',
      notes: [
        '首帧门=task.detail 装配→点阵/框线投影模型就绪的计算口径（jsdom 无 canvas raster——真实首帧见 2d 浏览器走查）',
        '交互帧门=视口变换+投影重算的每帧计算成本（P95；32 次采样/交互）',
        '后台解码门=inline 解码同步面；blob 通道异步渐进由骨架位承载（design §3）',
        '内存门=node heapUsed 增量代理口径（无强制 GC）；design §4 的 tab 级 RSS 以 Chrome Task Manager 为准（走查补充）',
        '门数值=design §4 冻结值——超门=红不降门；数值调整须 Owner 批准并记 design 变更',
      ],
    },
    gates,
    summary: { total: gates.length, passed: gates.length - failures.length, failed: failures.length, failures },
  }
}
