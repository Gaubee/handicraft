/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-20 studio-layers 2.3] 计算队列域 store：脏层追踪（dirtyLayerIds + 300ms 窗口合并 +
 *    CommitOpts.immediate 双轨语义平移）+ 单 worker 逐层串行（LayerComputeSession——渐进落地/
 *    逐层错误隔离/run 号作废/取消，1.1 内核）+ 进度聚合 {done:1+完成层数, total:1+脏层数,
 *    label:'层「名」排布中…'}。退役面（Owner 授权）：五策略并行缓存与秒切废除——切策略 =
 *    该层重算（旧结果保持可见直到新结果落地）。
 * 2. [逐层派生 / improve 3.2 独立块合成单元] 每层输入面 = resolveLayerPlans（1.2 内核单源）：
 *    成员解析/effectiveBlocks/density 两级回落/按层 specKey grid；custom specKey 资产 missing
 *    四态 = SpecKeyResolveError → 该层 error entry（错误隔离，禁静默降级圆钻），其余层照常计算
 *    （逐次排除重试）。独立配置块（继承开关关）从父层批摘出为合成单元 `${layerId}#${blockId}`
 *    （自身 strategy/specKey + 父层 gap/松弛/密度覆写），同一 resolveLayerPlans 管线解析入批。
 * 3. [结果域] perLayerResults（未触碰层跨批保留——① 结果缓存/⑥ 重算期间旧结果保留）；
 *    结算时逐钻物化层规格（shapeId/diameterMm/assetId——engine makeGem 恒 round 戳的层序补全，
 *    1.5 replay 同式）+ 层内色映射（mapColors 最近邻 + 层颜色覆写）；joint 视图 = 各层 concat
 *    + 跨层 g##### 全局重编号（id 唯一性——jointGate 归属/export/BOM/handoff 消费面）。
 * 4. [接线] replay（undo/redo）事件经 onStudioStateApplied 注册：层配置差分标脏（refold 前后
 *    签名对照——只有配置变化的层进入重算，未触碰层缓存有效）；根只做聚合 re-export 与编排。
 */

import {
  PIXELS_PER_MM,
  SS_TABLE,
  mapColors,
  type Block,
  type Gem,
  type Palette,
  type StrategyId,
  type Warning,
} from '$lib/engine'
import {
  resolveGemshapeRefState,
  getProject,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { parseGemshape } from '$lib/persistence/gemshapeFile'
import {
  resolveLayerPlans,
  SpecKeyResolveError,
  type LayerPlan,
} from '$lib/edit/replayLayers'
import { LayerComputeSession, type LayerBatchItem, type LayerResultEntry } from '$lib/studio/computeLayer'
import {
  getLayers,
  getPaletteState,
  getSegmentOpts,
  independentBlockConfigOf,
  owningLayerOf,
  toLayerRecord,
  type LayerState,
} from '$lib/studio/layers.svelte'
import { onStudioStateApplied } from '$lib/studio/history.svelte'
import { getBlocks, getPainting } from '$lib/stores/studio.svelte'
import type { LayerRecord } from '$lib/persistence/projectFile'

export const COMPUTE_DEBOUNCE_MS = 300
/** 布局种子（studio LAYOUT_SEED 纪律——gemproj 不存布局种子，恒 1）。 */
export const LAYOUT_SEED = 1
/** 分块类型推断钻径：SS10@2.5px/mm=7px（SS 切换只改 grid/pitch，不重分块）。 */
const SEGMENT_GEM_DIAMETER_PX = SS_TABLE.SS10 * PIXELS_PER_MM

/** 连通域最小面积：随图尺寸缩放（studio minAreaFor 同式——根同值单源）。 */
function minAreaFor(width: number, height: number): number {
  return Math.min(4000, Math.max(12, Math.round(width * height * 0.0005)))
}

// ---------------------------------------------------------------------------
// custom specKey 目录 adapter（素材库 .gemshape 真源——edit/gemprojReplay 同式；禁触 edit 域文件）
// ---------------------------------------------------------------------------

async function libraryCustomSpecResolver(assetId: string) {
  const state = await resolveGemshapeRefState(assetId)
  if (state !== 'resolved') return { state } as const
  const node = await getProject(assetId)
  if (node === null || node.projectKind !== 'gemshape') return { state: 'wrong-kind' } as const
  const blob = await getImageBlob(node.blobKey).catch(() => null)
  if (blob === null) return { state: 'blob-missing' } as const
  try {
    const file = parseGemshape(new TextDecoder().decode(await blob.arrayBuffer()), { mime: node.mime })
    return {
      state: 'resolved' as const,
      spec: {
        shapeId: 'custom' as const,
        sizeLabel: node.name.replace(/\.gemshape$/, ''),
        diameterMm: Math.max(file.physical.widthMm, file.physical.heightMm),
        widthMm: file.physical.widthMm,
        heightMm: file.physical.heightMm,
        assetId,
      },
    }
  } catch {
    return { state: 'wrong-kind' } as const
  }
}

// ---------------------------------------------------------------------------
// $state 宿主
// ---------------------------------------------------------------------------

let perLayerResults = $state<Record<string, LayerResultEntry | undefined>>({})
let dirtyLayerIds = $state<string[]>([])
let computing = $state(false)
let computeProgressState = $state<{ done: number; total: number; label: string } | null>(null)

let computeTimer: ReturnType<typeof setTimeout> | null = null
let computeInflight: Promise<void> | null = null
const session = new LayerComputeSession()

// ---------------------------------------------------------------------------
// 读取器
// ---------------------------------------------------------------------------

export function getLayerResult(layerId: string): LayerResultEntry | undefined {
  return perLayerResults[layerId]
}

export function getLayerResults(): Record<string, LayerResultEntry | undefined> {
  return perLayerResults
}

export function getComputing(): boolean {
  return computing
}

export function getComputeProgress(): { done: number; total: number; label: string } | null {
  return computeProgressState
}

export function getDirtyLayerIds(): string[] {
  return dirtyLayerIds
}

/** 层行状态点（B.2：◷计算中 / ～待重算 / ！失败 / 空）。[improve 3.2] 独立块合成单元 error 同样点亮层行 ！。 */
export function layerComputeStatus(layer: LayerState, memberCount: number): 'computing' | 'stale' | 'error' | 'empty' | 'ok' {
  if (dirtyLayerIds.includes(layer.id)) return 'stale'
  const entry = perLayerResults[layer.id]
  if (entry?.error !== undefined) return 'error'
  for (const [blockId, cfg] of Object.entries(layer.overrides.config)) {
    if (cfg.inherit) continue
    if (perLayerResults[`${layer.id}#${blockId}`]?.error !== undefined) return 'error'
  }
  if (memberCount === 0) return 'empty'
  if (entry === undefined) return computing ? 'computing' : 'ok'
  return 'ok'
}

// ---------------------------------------------------------------------------
// joint 视图（全层 concat + 跨层全局重编号——export/BOM/handoff/联合门的消费面）
// ---------------------------------------------------------------------------

export interface JointLayerGems {
  layerId: string
  layerName: string
  gapMm: number
  gems: Gem[]
}

export interface JointView {
  /** 各层（列表序）renumber 后的钻集（层序物化规格已随结算戳好）。 */
  layers: JointLayerGems[]
  gems: Gem[]
  warnings: Warning[]
  dropped: number
  /** 任一层计算失败（联合口径不可信——导出门关）。 */
  hasError: boolean
}

/**
 * 跨层 g##### 全局重编号（单层 = 恒等；1.5 replay 同式——id 唯一性是 jointGate 归属前提）。
 * [improve 1.1] 层序恒按层 id 字典序（稳定序）：拖动排序（layer.reorder）只改面板视觉序，
 * 联合编号/BOM/导出顺序不随漂移——「层排序不改变几何与 BOM 顺序」纪律；reorder op 落地前
 * 数组序与 id 序恒等，行为零变化。
 * [improve 3.2] 每层宝石集 = 父层批（继承块）+ 其独立块合成单元（`${layerId}#${blockId}`——
 * 独立态块的钻并入所属层 parts；warnings/dropped/hasError 聚合；已回继承的休眠单元条目不读）。
 */
export function jointViewOf(layers: readonly LayerState[]): JointView {
  const parts: JointLayerGems[] = []
  const warnings: Warning[] = []
  let dropped = 0
  let hasError = false
  let seq = 0
  const all: Gem[] = []
  for (const layer of [...layers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const entries: LayerResultEntry[] = []
    const parent = perLayerResults[layer.id]
    if (parent !== undefined) entries.push(parent)
    for (const [blockId, cfg] of Object.entries(layer.overrides.config)) {
      if (cfg.inherit) continue
      const child = perLayerResults[`${layer.id}#${blockId}`]
      if (child !== undefined) entries.push(child)
    }
    const gems: Gem[] = []
    for (const entry of entries) {
      if (entry.error !== undefined) hasError = true
      warnings.push(...entry.warnings)
      dropped += entry.dropped
      for (const g of entry.gems) gems.push({ ...g, id: `g${String(++seq).padStart(5, '0')}` })
    }
    parts.push({ layerId: layer.id, layerName: layer.name, gapMm: layer.physics.gapMm, gems })
    all.push(...gems)
  }
  return { layers: parts, gems: all, warnings, dropped, hasError }
}

// ---------------------------------------------------------------------------
// 派生输入（每层：成员/effective/density/grid——replayLayers 内核单源）
// ---------------------------------------------------------------------------

interface LayerInputPlan {
  layer: LayerState
  plan: LayerPlan
}

/**
 * 解析脏层的计算输入。custom specKey missing → 该层 error entry（错误隔离——逐次排除重试，
 * 其余层照常）；全部层解析失败时返回空批（错误均已入 entry）。
 */
async function resolveDirtyPlans(dirty: readonly string[]): Promise<{ batch: LayerBatchItem[]; plans: Map<string, LayerInputPlan> }> {
  const image = getPainting()
  const blocks = getBlocks()
  const allLayers = getLayers()
  const plans = new Map<string, LayerInputPlan>()
  const batch: LayerBatchItem[] = []
  if (image === null) return { batch, plans }

  const { k, seed } = getSegmentOpts()
  const segmentOpts = {
    k,
    seed,
    gemDiameterPx: SEGMENT_GEM_DIAMETER_PX,
    minAreaPx: minAreaFor(image.width, image.height),
  }

  const pending = allLayers
  let errored: Array<{ layer: LayerState; error: string }> = []
  for (;;) {
    try {
      // 全层解析（rest 展开 = 分块结果 − **全量**显式层并集——只传脏子集会破坏兜底语义）；
      // 批构造只取脏层，解析成本纯 CPU（成员/密度/grid 派生轻量）
      const resolution = await resolveLayerPlans(
        pending.filter((l) => !errored.some((e) => e.layer.id === l.id)).map(toLayerRecord),
        blocks,
        image.width,
        undefined,
        libraryCustomSpecResolver,
      )
      for (const plan of resolution.layers) {
        const layer = allLayers.find((l) => l.id === plan.record.id)
        if (layer === undefined) continue
        plans.set(layer.id, { layer, plan })
      }
      break
    } catch (error) {
      if (error instanceof SpecKeyResolveError) {
        // 该 specKey 的层全部隔离为 error entry（禁静默降级圆钻），其余层重试
        const failed = pending.filter((l) => !errored.some((e) => e.layer.id === l.id) && l.physics.specKey === error.specKey)
        if (failed.length === 0) break // 防御：异常 specKey 无归属层——空批收场
        errored = [...errored, ...failed.map((layer) => ({ layer, error: error.message }))]
        if (errored.length < pending.length) continue
        break // 全部层解析失败——空批收场（错误均已入 entry）
      }
      throw error
    }
  }
  for (const { layer, error } of errored) {
    // 非脏层的 error 不覆写既有 entry（其配置未变——旧 entry/缺席语义保持）
    if (!dirty.includes(layer.id)) continue
    perLayerResults[layer.id] = {
      layerId: layer.id,
      strategy: layer.strategy,
      gems: [],
      warnings: [],
      dropped: 0,
      durationMs: 0,
      error,
    }
  }

  /** 批项构造（父层与合成单元共用——progressLayerName 承载层/单元名）。 */
  const pushBatch = (
    layerId: string,
    layerName: string,
    strategy: LayerRecord['strategy'],
    relax: LayerState['physics']['relax'],
    resolved: LayerInputPlan,
    blocks: readonly Block[],
  ): void => {
    if (blocks.length === 0) {
      // 空批（无启用块）：即时清零 entry（无 worker 轮）
      perLayerResults[layerId] = {
        layerId,
        strategy,
        gems: [],
        warnings: [],
        dropped: 0,
        durationMs: 0,
      }
      return
    }
    batch.push({
      layerId,
      layerName,
      input: {
        image,
        segmentOpts,
        strategy,
        layoutOpts: {
          density: resolved.plan.density,
          seed: LAYOUT_SEED,
          relax: { ...relax },
        },
        grid: resolved.plan.grid,
        blocks: blocks.map((b) => ({ ...b })),
        progressLayerName: layerName,
      },
    })
  }

  // ---- [improve 3.2] 独立配置块分裂为合成计算单元（`${layerId}#${blockId}`）----
  // 脏层的独立块从父层批摘出（继承块留在父层批）；每个独立块按自身 strategy/specKey 二次
  // resolveLayerPlans（复用 per-layer 派生管线：成员/密度两级回落/按 specKey grid + custom
  // 资产解析）；gap/松弛/密度覆写仍取父层物理——独立范围 = 策略 + 基础规格（design §3）。
  const syntheticRecords: LayerRecord[] = []
  const syntheticParents = new Map<string, { parent: LayerState; blockId: string }>()
  for (const layer of pending) {
    if (!dirty.includes(layer.id)) continue
    const resolved = plans.get(layer.id)
    if (resolved === undefined) continue
    const independent = resolved.plan.effectiveBlocks.filter(
      (b) => independentBlockConfigOf(layer, b.id) !== null,
    )
    if (independent.length === 0) continue
    const inherited = resolved.plan.effectiveBlocks.filter(
      (b) => independentBlockConfigOf(layer, b.id) === null,
    )
    resolved.plan.effectiveBlocks = inherited
    for (const b of independent) {
      const cfg = independentBlockConfigOf(layer, b.id)!
      const id = `${layer.id}#${b.id}`
      syntheticRecords.push({
        id,
        name: `${layer.name} · ${b.label}`,
        blockIds: [b.id],
        strategy: cfg.strategy,
        physics: { ...layer.physics, specKey: cfg.specKey },
        overrides: {
          disabled: {},
          density: layer.overrides.density[b.id] !== undefined ? { [b.id]: layer.overrides.density[b.id] } : {},
          type: layer.overrides.type[b.id] !== undefined ? { [b.id]: layer.overrides.type[b.id] } : {},
          color: layer.overrides.color[b.id] !== undefined ? { [b.id]: layer.overrides.color[b.id] } : {},
        },
      })
      syntheticParents.set(id, { parent: layer, blockId: b.id })
    }
  }

  // 合成单元解析（SpecKeyResolveError 四态隔离——只污染该 specKey 的单元，其余重试）
  let pendingSynthetic = [...syntheticRecords]
  for (;;) {
    if (pendingSynthetic.length === 0) break
    try {
      const resolution = await resolveLayerPlans(
        pendingSynthetic,
        blocks,
        image.width,
        undefined,
        libraryCustomSpecResolver,
      )
      for (const plan of resolution.layers) {
        const owner = syntheticParents.get(plan.record.id)
        if (owner === undefined) continue
        const colorOverride =
          owner.parent.overrides.color[owner.blockId] !== undefined
            ? { [owner.blockId]: owner.parent.overrides.color[owner.blockId] }
            : {}
        const syntheticLayer: LayerState = {
          id: plan.record.id,
          name: plan.record.name,
          blockIds: [owner.blockId],
          strategy: plan.record.strategy,
          physics: { ...plan.record.physics },
          overrides: { disabled: {}, density: {}, type: {}, color: colorOverride, config: {} },
          visible: true,
        }
        plans.set(plan.record.id, { layer: syntheticLayer, plan })
      }
      break
    } catch (error) {
      if (error instanceof SpecKeyResolveError) {
        const failed = pendingSynthetic.filter((r) => r.physics.specKey === error.specKey)
        if (failed.length === 0) break // 防御：异常 specKey 无归属单元——空批收场
        for (const record of failed) {
          perLayerResults[record.id] = {
            layerId: record.id,
            strategy: record.strategy,
            gems: [],
            warnings: [],
            dropped: 0,
            durationMs: 0,
            error: error.message,
          }
        }
        const failedIds = new Set(failed.map((r) => r.id))
        pendingSynthetic = pendingSynthetic.filter((r) => !failedIds.has(r.id))
        continue
      }
      throw error
    }
  }

  for (const layer of pending) {
    if (!dirty.includes(layer.id)) continue
    const resolved = plans.get(layer.id)
    if (resolved === undefined) continue
    pushBatch(layer.id, layer.name, layer.strategy, layer.physics.relax, resolved, resolved.plan.effectiveBlocks)
  }
  for (const record of syntheticRecords) {
    const owner = syntheticParents.get(record.id)
    const resolved = plans.get(record.id)
    if (owner === undefined || resolved === undefined) continue // error entry 已写
    pushBatch(record.id, record.name, record.strategy, record.physics.relax, resolved, resolved.plan.effectiveBlocks)
  }
  return { batch, plans }
}

// ---------------------------------------------------------------------------
// 调度（300ms 窗口合并 / immediate 直起）
// ---------------------------------------------------------------------------

export interface QueueCommitOpts {
  immediate?: boolean
}

/** 标脏 + 调度（去重；immediate = 跳过防抖直起——CommitOpts 语义平移）。 */
export function markLayersDirty(layerIds: readonly string[], opts: QueueCommitOpts = {}): void {
  const live = new Set(getLayers().map((l) => l.id))
  for (const id of layerIds) {
    if (live.has(id) && !dirtyLayerIds.includes(id)) dirtyLayerIds.push(id)
  }
  if (dirtyLayerIds.length === 0) return
  if (opts.immediate) {
    if (computeTimer !== null) {
      clearTimeout(computeTimer)
      computeTimer = null
    }
    void runDirtyBatch()
    return
  }
  if (computeTimer !== null) clearTimeout(computeTimer)
  computeTimer = setTimeout(() => {
    computeTimer = null
    void runDirtyBatch()
  }, COMPUTE_DEBOUNCE_MS)
}

/** 全量标脏（分块落位/进页自动排布/旧 scheduleLayout 兼容面：有成员的层全入列）。 */
export function markAllLayersDirty(opts: QueueCommitOpts = {}): void {
  markLayersDirty(getLayers().map((l) => l.id), opts)
}

async function runDirtyBatch(): Promise<void> {
  const dirty = [...dirtyLayerIds]
  dirtyLayerIds = []
  if (dirty.length === 0) return
  // 同步占位（防 false-idle：resolve 间隙 computing 必须已置位——等待器据此判定在途）
  computing = true
  try {
    const { batch, plans } = await resolveDirtyPlans(dirty)
    if (batch.length === 0) {
      computing = false
      computeProgressState = null
      return
    }
    const paletteSnapshot: Palette = getPaletteState().map((c) => ({ ...c }))
    const promise = (async () => {
      await session.start(batch, {
        onProgress: (p) => {
          computeProgressState = { done: p.done, total: p.total, label: p.label }
        },
        onLayerSettled: (entry) => {
          const resolved = plans.get(entry.layerId)
          if (resolved !== undefined && entry.error === undefined && entry.gems.length > 0) {
            // 层序物化规格（engine makeGem 恒 round 戳——非圆钻层 shapeId/assetId 在此补全）
            const spec = resolved.plan.spec
            for (const gem of entry.gems) {
              gem.shapeId = spec.shapeId
              gem.diameterMm = spec.diameterMm
              if (spec.shapeId === 'custom' && spec.assetId !== undefined) gem.assetId = spec.assetId
              else delete gem.assetId
            }
            // 层内色映射（mapColors 最近邻 + 层颜色覆写——applyColors 层级化）
            const colorOverrides = resolved.layer.overrides.color
            if (paletteSnapshot.length > 0) {
              mapColors(entry.gems, resolved.plan.effectiveBlocks, paletteSnapshot)
            }
            for (const gem of entry.gems) {
              const override = colorOverrides[gem.blockId]
              if (override !== undefined) gem.colorId = override
            }
          }
          perLayerResults[entry.layerId] = entry
        },
      })
    })()
    computeInflight = promise
    try {
      await promise
    } finally {
      // 新批（re-schedule）接管时不清位——computing/进度由新批自管
      if (computeInflight === promise) {
        computing = false
        computeProgressState = null
        computeInflight = null
      }
    }
  } catch (error) {
    // 派生/调度意外失败：复位在途态不上抛（旧 runLayouts 容错同构），细节上浮 console
    computing = false
    computeProgressState = null
    computeInflight = null
    console.warn('逐层计算批失败', error)
  }
}

/** 用户显式取消（进度徽章「取消」）：作废在途层轮 + 清队列；之后的参数改动照常触发新轮。 */
export function cancelComputeQueue(): void {
  if (computeTimer !== null) {
    clearTimeout(computeTimer)
    computeTimer = null
  }
  session.cancel()
  dirtyLayerIds = []
  computing = false
  computeProgressState = null
  computeInflight = null
}

// ---------------------------------------------------------------------------
// 色映射原地重算（palette/颜色覆写变更——不动几何）
// ---------------------------------------------------------------------------

/** 对既有逐层结果原地重映射（旧 recolorResults 的层级化）。 */
export function recolorAllResults(): void {
  const blocks = getBlocks()
  const layers = getLayers()
  const paletteSnapshot: Palette = getPaletteState().map((c) => ({ ...c }))
  const blockById = new Map(blocks.map((b) => [b.id, b] as const))
  for (const layer of layers) {
    const entry = perLayerResults[layer.id]
    if (entry === undefined || entry.error !== undefined || entry.gems.length === 0) continue
    const effective: Block[] = []
    if (layer.blockIds === 'rest') {
      const explicit = new Set(layers.flatMap((l) => (l.blockIds === 'rest' ? [] : l.blockIds)))
      for (const b of blocks) if (!explicit.has(b.id) && layer.overrides.disabled[b.id] !== true) effective.push(b)
    } else {
      for (const id of layer.blockIds) {
        const b = blockById.get(id)
        if (b !== undefined && layer.overrides.disabled[id] !== true) effective.push(b)
      }
    }
    const ids = new Set(effective.map((b) => b.id))
    if (!entry.gems.every((g) => ids.has(g.blockId))) continue // 旧块集，等重算覆盖
    if (paletteSnapshot.length > 0) mapColors(entry.gems, effective, paletteSnapshot)
    for (const gem of entry.gems) {
      const override = layer.overrides.color[gem.blockId]
      if (override !== undefined) gem.colorId = override
    }
  }
}

// ---------------------------------------------------------------------------
// replay（undo/redo）差分标脏：refold 前后层配置签名对照——只有变化的层进入重算
// ---------------------------------------------------------------------------

function layerConfigSignature(layer: LayerState): string {
  return JSON.stringify({
    s: layer.strategy,
    p: layer.physics,
    o: layer.overrides,
    m: layer.blockIds === 'rest' ? 'rest' : [...layer.blockIds].sort(),
  })
}

function signaturesOf(layers: readonly LayerState[]): Map<string, string> {
  return new Map(layers.map((l) => [l.id, layerConfigSignature(l)] as const))
}

let lastSignatures: Map<string, string> | null = null

onStudioStateApplied((event) => {
  const before = lastSignatures
  const after = signaturesOf(getLayers())
  lastSignatures = after
  if (!event.replay || before === null) return
  const changed: string[] = []
  for (const [id, signature] of after) {
    if (before.get(id) !== signature) changed.push(id)
  }
  for (const id of before.keys()) if (!after.has(id)) changed.push(id) // 层已删/并
  if (changed.length > 0) markAllLayersDirtyIfMemberful(changed)
})

function markAllLayersDirtyIfMemberful(layerIds: readonly string[]): void {
  // 成员解析成本低的近似：有 overrides/成员的层直接标脏（差分收窄——未触碰层缓存有效）
  markLayersDirty(layerIds)
}

/** live 态签名基线刷新（dispatch/undo/redo 后由 history 事件统一驱动；测试复位用）。 */
export function refreshSignatureBaseline(): void {
  lastSignatures = signaturesOf(getLayers())
}

// ---------------------------------------------------------------------------
// 复位（根 resetStudioForTests / applyPainting 调用）
// ---------------------------------------------------------------------------

export function resetComputeQueue(): void {
  cancelComputeQueue()
  perLayerResults = {}
  dirtyLayerIds = []
  lastSignatures = null
}

/** 等待防抖与在途批落地（测试支持）。 */
export async function waitForComputeQueueIdle(): Promise<void> {
  for (let guard = 0; guard < 2000; guard++) {
    if (computeTimer === null && computeInflight === null && !computing) return
    if (computeInflight !== null) await computeInflight.catch(() => undefined)
    else await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitForComputeQueueIdle 超时')
}

export type { LayerResultEntry }
