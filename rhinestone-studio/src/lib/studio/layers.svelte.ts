/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-20 studio-layers 2.1] 图层域 store：LayerState（块集分区 + 独立排布配置——
 *    strategy/物理四件/覆写四表随层走）+ 'rest' 兜底哨兵（恰一层持 'rest'；新块自动落入）
 *    + 生命周期 op（create/delete[兜底层不可删]/merge[并集入锚点层]/rename/moveBlocks）
 *    + LayerState↔LayerRecord 纯投影（W0 类型消费不重定义）+ 运行时不变量守卫。
 * 2. [参数态宿主] StudioParamState（layers[] + palette + segment{k,seed} + layerSeq）= 历史 fold
 *    （2.2 history.svelte.ts）的作用面；本模块是唯一 $state 宿主，history 只经 setParamState
 *    整体替换。纯 reducer（applyLayerMutation 族）以可变工作副本为参——live 写入与 fold 共用
 *    同一份语义（同 base + 同 ops ⇒ 同 state 的实现根基）。
 * 3. [块级覆写归属（图层稿 §A.6）] 四覆写表随块住进所属层 overrides（键 = 引擎块 id）；
 *    getBlockDensity 回落目标 = 所属层 physics.density（全局密度语义退役——setGlobalDensity
 *    移为锚点层写入，写入面在 store 根保持兼容签名）。色板仍项目级（mapColors 输入全项目一份）。
 * 4. [重分块语义（R1·议题 3）] 新块 id 全新生成 → 全部落兜底层（'rest' 哨兵自然实现）；
 *    显式层成员 ∩ 新块 = ∅ → 空层保留（配置在、块没了）；syncBlocksLanded 按层清悬空
 *    blockIds/覆写键并计数（横幅「N 项块覆写失效已移除」数据面）。
 * 5. [观察态边界（工作默认一）] visible 纯会话态：不入 LayerRecord 投影、不入 paramStateHash、
 *    不入历史；打开 .gemproj 恢复默认观察态（restoreDefaultObservationState）。
 */

import {
  STARTER_PALETTE,
  roundSpecKeyOfSs,
  ssOfRoundSpecKey,
  upsertPaletteColor,
  removePaletteColor,
  type Block,
  type BlockType,
  type Palette,
  type PaletteColor,
  type StrategyId,
} from '$lib/engine'
import type { LayerRecord } from '$lib/persistence/projectFile'

// ---------------------------------------------------------------------------
// 类型（LayerRecord 序列化面已由 W0 冻结——本域类型是其内存态 + 观察态扩展）
// ---------------------------------------------------------------------------

/** 层物理四件：specKey（canonical 规格键）/ gap / 层密度（原 globalDensity 的层级化）/ 松弛双开关。 */
export interface LayerPhysics {
  specKey: string
  gapMm: number
  density: number
  relax: { boundary: boolean; repulsion: boolean }
}

/** 层内覆写四表（键 = 引擎块 id、仅本层块；分区不变量保证无跨层键）。 */
export interface LayerOverrides {
  disabled: Record<string, true>
  density: Record<string, number>
  type: Record<string, BlockType>
  color: Record<string, string>
}

/** 图层内存态（图层稿 §A.7）：blockIds 'rest' = 兜底哨兵（恰一层可持有）。 */
export interface LayerState {
  id: string
  name: string
  blockIds: string[] | 'rest'
  strategy: StrategyId
  physics: LayerPhysics
  overrides: LayerOverrides
  /** 观察态（不入档/不入历史/不入 paramStateHash） */
  visible: boolean
}

/** 层配置面（layer.config op 的 patch 值域——检查器层配置卡的五个字段）。 */
export interface LayerConfigPatch {
  strategy?: StrategyId
  specKey?: string
  gapMm?: number
  density?: number
  relax?: { boundary: boolean; repulsion: boolean }
}

/**
 * 历史折叠参数态（2.2 fold 的作用面；结果永不入态——「不记录结果，每次重新计算」）。
 * layerSeq 入态保证 fold 的 id 派生确定性（layer.create 在同 base + 同 op 流下恒得同 id）。
 */
export interface StudioParamState {
  layers: LayerState[]
  /** 下一层编号（L<seq> 已用至 seq-1） */
  layerSeq: number
  palette: Palette
  segment: { k: number; seed: number }
}

/** 进页默认配置 = 现状单层默认值（compatibility harness 的「默认全选 = 现状效果」基点）。 */
export const DEFAULT_LAYER_STRATEGY: StrategyId = 'hybrid'
export const DEFAULT_SPEC_KEY = roundSpecKeyOfSs('SS10')
export const DEFAULT_GAP_MM = 0.4
export const DEFAULT_DENSITY = 1

export function defaultLayerPhysics(): LayerPhysics {
  return {
    specKey: DEFAULT_SPEC_KEY,
    gapMm: DEFAULT_GAP_MM,
    density: DEFAULT_DENSITY,
    relax: { boundary: false, repulsion: false },
  }
}

export function emptyLayerOverrides(): LayerOverrides {
  return { disabled: {}, density: {}, type: {}, color: {} }
}

/** 深拷贝（undo/redo refold 整体替换前的快照隔离；覆写 Record/relax 一并浅深）。 */
export function cloneLayer(layer: LayerState): LayerState {
  return {
    ...layer,
    blockIds: layer.blockIds === 'rest' ? 'rest' : [...layer.blockIds],
    physics: { ...layer.physics, relax: { ...layer.physics.relax } },
    overrides: {
      disabled: { ...layer.overrides.disabled },
      density: { ...layer.overrides.density },
      type: { ...layer.overrides.type },
      color: { ...layer.overrides.color },
    },
  }
}

export function cloneParamState(state: StudioParamState): StudioParamState {
  return {
    layers: state.layers.map(cloneLayer),
    layerSeq: state.layerSeq,
    palette: state.palette.map((c) => ({ ...c })),
    segment: { ...state.segment },
  }
}

// ---------------------------------------------------------------------------
// 不变量守卫（运行时——图层稿 §A.1 分区不变量 / §E.1 parser 拒绝面的 store 侧镜像）
// ---------------------------------------------------------------------------

export type LayerInvariantCode = 'rest-missing' | 'rest-multiple' | 'duplicate-block' | 'block-out-of-set'

export interface LayerInvariantViolation {
  code: LayerInvariantCode
  layerId?: string
  blockId?: string
}

/**
 * 分区不变量：恰一层持 'rest'；显式层 blockIds 层内去重、跨层互斥；并集 ⊆ 当前块集
 * （blockIds 集缺席时跳过该面——fold 态不含块集，块存在性由 syncBlocksLanded 派生清理）。
 */
export function checkLayerInvariants(
  layers: readonly LayerState[],
  blockIds?: ReadonlySet<string>,
): LayerInvariantViolation[] {
  const violations: LayerInvariantViolation[] = []
  let restCount = 0
  const seen = new Set<string>()
  for (const layer of layers) {
    if (layer.blockIds === 'rest') {
      restCount += 1
      if (restCount > 1) violations.push({ code: 'rest-multiple', layerId: layer.id })
      continue
    }
    const local = new Set<string>()
    for (const id of layer.blockIds) {
      if (local.has(id)) violations.push({ code: 'duplicate-block', layerId: layer.id, blockId: id })
      local.add(id)
      if (seen.has(id)) violations.push({ code: 'duplicate-block', layerId: layer.id, blockId: id })
      if (blockIds !== undefined && !blockIds.has(id)) {
        violations.push({ code: 'block-out-of-set', layerId: layer.id, blockId: id })
      }
      seen.add(id)
    }
  }
  if (restCount === 0 && layers.length > 0) violations.push({ code: 'rest-missing' })
  return violations
}

/** 运行时守卫（live 写入路径防呆——违反即内部 bug，fail-fast）。 */
export function assertLayerInvariants(layers: readonly LayerState[], blockIds?: ReadonlySet<string>): void {
  const violations = checkLayerInvariants(layers, blockIds)
  if (violations.length > 0) {
    throw new Error(`图层不变量违反：${JSON.stringify(violations)}`)
  }
}

// ---------------------------------------------------------------------------
// 纯 reducer（可变工作副本——live 写入与 2.2 fold 共用；返回诊断数组由调用方聚合）
// ---------------------------------------------------------------------------

export interface LayerMutationDiagnostic {
  code: 'layer-not-found' | 'layer-delete-rest' | 'block-not-in-set' | 'no-op'
  layerId?: string
  blockId?: string
}

function nextLayerId(state: StudioParamState): string {
  return `L${state.layerSeq + 1}`
}

function clampGapMm(gap: number): number {
  return Math.min(0.8, Math.max(0.4, Math.round(gap * 100) / 100))
}

function clampDensity(density: number): number {
  return Math.min(1, Math.max(0.01, density))
}

function applyPhysicsPatch(layer: LayerState, patch: LayerConfigPatch): void {
  if (patch.strategy !== undefined) layer.strategy = patch.strategy
  if (patch.specKey !== undefined) layer.physics.specKey = patch.specKey
  if (patch.gapMm !== undefined) layer.physics.gapMm = clampGapMm(patch.gapMm)
  if (patch.density !== undefined) layer.physics.density = clampDensity(patch.density)
  if (patch.relax !== undefined) layer.physics.relax = { ...patch.relax }
}

/** 从所有显式层的成员表中摘除指定块（块落回兜底层——'rest' 哨兵语义）。 */
function removeBlocksFromExplicit(layers: LayerState[], blockIds: readonly string[]): void {
  if (blockIds.length === 0) return
  const remove = new Set(blockIds)
  for (const layer of layers) {
    if (layer.blockIds === 'rest') continue
    if (layer.blockIds.some((id) => remove.has(id))) {
      layer.blockIds = layer.blockIds.filter((id) => !remove.has(id))
    }
  }
}

/**
 * layer.create：空层（继承锚点层配置为初始值）或「移入新图层」（blockIds 随层创建摘出原层）。
 * id 派生自 state.layerSeq（fold 确定性）；完整构造后再入列（$state 代理语义：入列后对
 * 原始对象的直接改写不进代理视图——返回值 = 列内代理，调用方后续改写保持响应式）。
 */
export function createLayer(
  state: StudioParamState,
  opts: { name?: string; blockIds?: readonly string[]; seedConfig?: LayerConfigPatch } = {},
): LayerState {
  const seed = state.layers.find((l) => l.blockIds === 'rest') ?? state.layers[0]
  const blockIds = [...(opts.blockIds ?? [])]
  const layer: LayerState = {
    id: nextLayerId(state),
    name: opts.name?.trim() || `图层 ${state.layerSeq + 1}`,
    blockIds,
    strategy: seed?.strategy ?? DEFAULT_LAYER_STRATEGY,
    physics: seed ? { ...seed.physics, relax: { ...seed.physics.relax } } : defaultLayerPhysics(),
    overrides: emptyLayerOverrides(),
    visible: true,
  }
  applyPhysicsPatch(layer, opts.seedConfig ?? {})
  removeBlocksFromExplicit(state.layers, blockIds)
  state.layers.push(layer)
  state.layerSeq += 1
  // 返回列内元素（live 态 = 代理；fold 态 = 同一对象）
  return state.layers[state.layers.length - 1]
}

/**
 * layer.delete：层内块随层移出设计（不再参与排布/统计/导出）；兜底层不可删
 * （诊断 'layer-delete-rest'——UI 已挡，fold 对越权 op 灰显不重写）。
 */
export function deleteLayer(state: StudioParamState, layerId: string): LayerMutationDiagnostic[] {
  const diagnostics: LayerMutationDiagnostic[] = []
  const index = state.layers.findIndex((l) => l.id === layerId)
  if (index === -1) {
    diagnostics.push({ code: 'layer-not-found', layerId })
    return diagnostics
  }
  if (state.layers[index].blockIds === 'rest') {
    diagnostics.push({ code: 'layer-delete-rest', layerId })
    return diagnostics
  }
  state.layers.splice(index, 1)
  return diagnostics
}

/** layer.merge：块集并集入锚点层（intoLayerId，配置取锚点层），其余层删除。 */
export function mergeLayers(
  state: StudioParamState,
  intoLayerId: string,
  fromLayerIds: readonly string[],
): LayerMutationDiagnostic[] {
  const diagnostics: LayerMutationDiagnostic[] = []
  const into = state.layers.find((l) => l.id === intoLayerId)
  if (into === undefined) {
    diagnostics.push({ code: 'layer-not-found', layerId: intoLayerId })
    return diagnostics
  }
  const froms: LayerState[] = []
  for (const id of fromLayerIds) {
    const layer = state.layers.find((l) => l.id === id)
    if (layer === undefined || layer.id === into.id) {
      diagnostics.push({ code: 'layer-not-found', layerId: id })
      continue
    }
    froms.push(layer)
  }
  if (froms.length === 0) return diagnostics
  const incoming = new Set<string>()
  if (into.blockIds !== 'rest') for (const id of into.blockIds) incoming.add(id)
  for (const from of froms) {
    if (from.blockIds !== 'rest') for (const id of from.blockIds) incoming.add(id)
    // 覆写四表随块并入锚点层（分区不变量保证无键冲突）
    into.overrides.disabled = { ...into.overrides.disabled, ...from.overrides.disabled }
    into.overrides.density = { ...into.overrides.density, ...from.overrides.density }
    into.overrides.type = { ...into.overrides.type, ...from.overrides.type }
    into.overrides.color = { ...into.overrides.color, ...from.overrides.color }
    state.layers.splice(state.layers.indexOf(from), 1)
  }
  if (into.blockIds === 'rest') {
    // 锚点为兜底层：并入块自然落入 rest（显式成员表保持空）；被并层若含 rest 哨兵则转移
    const restMoved = froms.some((f) => f.blockIds === 'rest')
    if (restMoved) {
      // 被并层持 'rest' 已删——哨兵随锚点层继续唯一持有（锚点本就是 rest，不变量保持）
    }
  } else {
    into.blockIds = [...incoming]
  }
  return diagnostics
}

/** layer.rename：空名/重名诊断（重名仅提示不阻断——层名不参与身份）。 */
export function renameLayer(
  state: StudioParamState,
  layerId: string,
  name: string,
): LayerMutationDiagnostic[] {
  const diagnostics: LayerMutationDiagnostic[] = []
  const layer = state.layers.find((l) => l.id === layerId)
  if (layer === undefined) {
    diagnostics.push({ code: 'layer-not-found', layerId })
    return diagnostics
  }
  const trimmed = name.trim()
  if (trimmed === '') {
    diagnostics.push({ code: 'no-op', layerId })
    return diagnostics
  }
  layer.name = trimmed
  return diagnostics
}

/**
 * layer.moveBlocks：块移入目标层（toLayerId 显式层 = 摘出原层后入列；目标 = 兜底层 =
 * 仅摘出原层，块落回 rest）。未知块 id 诊断 'block-not-in-set'（fold 灰显；live 路径
 * UI 只提供现存块，防御性保留）。
 */
export function moveBlocks(
  state: StudioParamState,
  blockIds: readonly string[],
  toLayerId: string,
  blockIdsInSet?: ReadonlySet<string>,
): LayerMutationDiagnostic[] {
  const diagnostics: LayerMutationDiagnostic[] = []
  const target = state.layers.find((l) => l.id === toLayerId)
  if (target === undefined) {
    diagnostics.push({ code: 'layer-not-found', layerId: toLayerId })
    return diagnostics
  }
  const valid = blockIds.filter((id) => {
    if (blockIdsInSet !== undefined && !blockIdsInSet.has(id)) {
      diagnostics.push({ code: 'block-not-in-set', blockId: id })
      return false
    }
    return true
  })
  removeBlocksFromExplicit(state.layers, valid)
  if (target.blockIds !== 'rest') {
    const set = new Set(target.blockIds)
    for (const id of valid) set.add(id)
    target.blockIds = [...set]
  }
  return diagnostics
}

/** layer.config：patch 写入全部目标层（多选批量 = 单 op；prev 由 dispatch 侧采集供面板回显）。 */
export function applyLayerConfig(
  state: StudioParamState,
  layerIds: readonly string[],
  patch: LayerConfigPatch,
): LayerMutationDiagnostic[] {
  const diagnostics: LayerMutationDiagnostic[] = []
  const targets = layerIds
    .map((id) => state.layers.find((l) => l.id === id))
    .filter((l): l is LayerState => l !== undefined)
  for (const id of layerIds) {
    if (!targets.some((l) => l.id === id)) diagnostics.push({ code: 'layer-not-found', layerId: id })
  }
  for (const layer of targets) applyPhysicsPatch(layer, patch)
  return diagnostics
}

/**
 * 块级覆写写入（block.override 的 apply 面）：按成员表定位所属层（显式层命中即属之；
 * 否则属兜底层）；层缺失诊断上浮。value = null（density/type/color）= 清除覆写回落层缺省。
 */
export function setBlockOverride(
  state: StudioParamState,
  blockId: string,
  patch:
    | { kind: 'enabled'; value: boolean }
    | { kind: 'density'; value: number | null }
    | { kind: 'type'; value: BlockType | null }
    | { kind: 'color'; value: string | null },
): LayerMutationDiagnostic[] {
  const owner = state.layers.find((l) => l.blockIds !== 'rest' && l.blockIds.includes(blockId)) ??
    state.layers.find((l) => l.blockIds === 'rest')
  if (owner === undefined) return [{ code: 'layer-not-found' }]
  switch (patch.kind) {
    case 'enabled':
      if (patch.value) delete owner.overrides.disabled[blockId]
      else owner.overrides.disabled[blockId] = true
      break
    case 'density':
      if (patch.value === null) delete owner.overrides.density[blockId]
      // 显式覆写（含 1.0）：滑杆一经触碰即脱离层密度；densitySpec 出口再省略恰为 1 的键
      else owner.overrides.density[blockId] = clampDensity(patch.value)
      break
    case 'type':
      if (patch.value === null) delete owner.overrides.type[blockId]
      else owner.overrides.type[blockId] = patch.value
      break
    case 'color':
      if (patch.value === null) delete owner.overrides.color[blockId]
      else owner.overrides.color[blockId] = patch.value
      break
  }
  return []
}

/** 块所属层（显式层命中即属之；未显式分配 = 兜底层；无层 = null）。 */
export function owningLayerOf(layers: readonly LayerState[], blockId: string): LayerState | null {
  return (
    layers.find((l) => l.blockIds !== 'rest' && l.blockIds.includes(blockId)) ??
    layers.find((l) => l.blockIds === 'rest') ??
    null
  )
}

// ---------------------------------------------------------------------------
// 重分块落位（syncBlocksLanded：块集再生后的确定性清理——live 态派生函数）
// ---------------------------------------------------------------------------

export interface BlocksLandedReport {
  /** 悬空覆写键移除总数（四表合计——横幅「N 项块覆写失效已移除」）。 */
  droppedOverrideKeys: number
  /** 因成员全灭被清空的显式层数（空层保留——配置在、块没了）。 */
  emptiedLayers: number
}

/**
 * 块集落位（重分块/重放后调用；确定性 = f(fold 态, 块集)）：
 * 1. 显式层 blockIds ∩ 新块集（死键摘除——新块自动落兜底层）；
 * 2. 逐层覆写四表清悬空键并计数。
 */
export function syncBlocksLanded(state: StudioParamState, blocks: readonly Block[]): BlocksLandedReport {
  const ids = new Set(blocks.map((b) => b.id))
  let droppedOverrideKeys = 0
  let emptiedLayers = 0
  for (const layer of state.layers) {
    if (layer.blockIds !== 'rest') {
      const alive = layer.blockIds.filter((id) => ids.has(id))
      if (alive.length !== layer.blockIds.length) emptiedLayers += 1
      layer.blockIds = alive
    }
    for (const table of [
      layer.overrides.disabled,
      layer.overrides.density,
      layer.overrides.type,
      layer.overrides.color,
    ] as Array<Record<string, unknown>>) {
      for (const key of Object.keys(table)) {
        if (!ids.has(key)) {
          delete table[key]
          droppedOverrideKeys += 1
        }
      }
    }
  }
  return { droppedOverrideKeys, emptiedLayers }
}

// ---------------------------------------------------------------------------
// 投影（LayerState ↔ LayerRecord——纯函数，W0 类型消费不重定义）
// ---------------------------------------------------------------------------

/** 内存态 → 序列化记录（visible 观察态剥离；序列化前调用方负责 syncBlocksLanded 清悬空）。 */
export function toLayerRecord(layer: LayerState): LayerRecord {
  return {
    id: layer.id,
    name: layer.name,
    blockIds: layer.blockIds === 'rest' ? 'rest' : [...layer.blockIds],
    strategy: layer.strategy,
    physics: { ...layer.physics, relax: { ...layer.physics.relax } },
    overrides: {
      disabled: { ...layer.overrides.disabled },
      density: { ...layer.overrides.density },
      type: { ...layer.overrides.type },
      color: { ...layer.overrides.color },
    },
  }
}

/** 序列化记录 → 内存态（visible 恢复默认 true——观察态不入档）。 */
export function fromLayerRecord(record: LayerRecord): LayerState {
  return {
    id: record.id,
    name: record.name,
    blockIds: record.blockIds === 'rest' ? 'rest' : [...record.blockIds],
    strategy: record.strategy,
    physics: { ...record.physics, relax: { ...record.physics.relax } },
    overrides: {
      disabled: { ...record.overrides.disabled },
      density: { ...record.overrides.density },
      type: { ...record.overrides.type },
      color: { ...record.overrides.color },
    },
    visible: true,
  }
}

// ---------------------------------------------------------------------------
// 观察态（工作默认一：纯会话态——不入档/不入历史/不入 paramStateHash）
// ---------------------------------------------------------------------------

export const BACKGROUND_SOURCE_VALUES = ['none', 'painting', 'reference'] as const
export type BackgroundSource = (typeof BACKGROUND_SOURCE_VALUES)[number]

/** 背景层（特殊层：钉底/不可删不可重命名/不参与排布统计导出；源 + 透明度默认 0.5 可调）。 */
export interface BackgroundLayerObservation {
  source: BackgroundSource
  opacity: number
  visible: boolean
}

export const BACKGROUND_OPACITY_DEFAULT = 0.5

export function defaultBackgroundObservation(): BackgroundLayerObservation {
  // Owner 授权默认值变更（对现状 previewMode='gems' 显式登记，design §2.5）：
  // 默认源 = 数字油画、可见、50%
  return { source: 'painting', opacity: BACKGROUND_OPACITY_DEFAULT, visible: true }
}

/** 观察态族复位（打开 .gemproj 恢复默认观察态——全部层可见、背景默认源/50%）。 */
export function restoreDefaultObservationState(layers: readonly LayerState[]): BackgroundLayerObservation {
  for (const layer of layers) layer.visible = true
  return defaultBackgroundObservation()
}

// ---------------------------------------------------------------------------
// paramStateHash（压实 state hash / fold 属性测试「同 state」断言——观察态排除）
// ---------------------------------------------------------------------------

/** 规范序序列化（键序稳定；visible 观察态剥离——「同 state」以参数态为断言面）。 */
export function canonicalParamStateJson(state: StudioParamState): string {
  const layers = state.layers.map((l) => ({
    id: l.id,
    name: l.name,
    blockIds: l.blockIds === 'rest' ? 'rest' : [...l.blockIds].sort(),
    strategy: l.strategy,
    physics: {
      specKey: l.physics.specKey,
      gapMm: l.physics.gapMm,
      density: l.physics.density,
      relax: { boundary: l.physics.relax.boundary, repulsion: l.physics.relax.repulsion },
    },
    overrides: {
      disabled: Object.keys(l.overrides.disabled).sort(),
      density: Object.entries(l.overrides.density).sort(([a], [b]) => (a < b ? -1 : 1)),
      type: Object.entries(l.overrides.type).sort(([a], [b]) => (a < b ? -1 : 1)),
      color: Object.entries(l.overrides.color).sort(([a], [b]) => (a < b ? -1 : 1)),
    },
  }))
  layers.sort((a, b) => (a.id < b.id ? -1 : 1))
  const palette = state.palette.map((c) => ({ id: c.id, name: c.name, hex: c.hex }))
  return JSON.stringify({ layers, layerSeq: state.layerSeq, palette, segment: state.segment })
}

export function paramStateHash(state: StudioParamState): string {
  // 轻量 FNV-1a（测试/压实对账用，非密码学）
  let hash = 0x811c9dc5
  for (const ch of canonicalParamStateJson(state)) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// $state 宿主（本模块 = 唯一图层域宿主；history 经 setParamState 整体替换）
// ---------------------------------------------------------------------------

let paramState = $state<StudioParamState>({
  layers: [],
  layerSeq: 0,
  palette: STARTER_PALETTE.map((c) => ({ ...c })),
  segment: { k: 8, seed: 1 },
})

let backgroundObservation = $state<BackgroundLayerObservation>(defaultBackgroundObservation())

// ---------------------------------------------------------------------------
// 层选择（观察态——2.4 多选；selectionOrder = 有序选择集，锚点 = selectionOrder[0] = 最早选中）
// ---------------------------------------------------------------------------

let selectionOrder = $state<string[]>([])
/** 背景层选中态（独占观察位：选中背景行 = 检查器切源+透明度面板；批量物理写入对其只读）。 */
let backgroundSelected = $state(false)

/** 选择动作（单击=重置 [id]；Cmd/Ctrl=尾部追加；Shift=列表范围替换）。 */
export function selectLayer(layerId: string, mode: 'replace' | 'toggle' | 'range' = 'replace'): void {
  const live = paramState.layers
  if (!live.some((l) => l.id === layerId)) return
  backgroundSelected = false
  if (mode === 'replace') {
    selectionOrder = [layerId]
    return
  }
  if (mode === 'toggle') {
    if (selectionOrder.includes(layerId)) {
      const next = selectionOrder.filter((id) => id !== layerId)
      selectionOrder = next.length > 0 ? next : [layerId] // 清空守卫：至少保留点击层
    } else {
      selectionOrder = [...selectionOrder, layerId]
    }
    return
  }
  // range：锚点 → 点击层的列表序区间替换（无锚点退化单选）
  const anchor = selectionOrder[0]
  if (anchor === undefined) {
    selectionOrder = [layerId]
    return
  }
  const ids = live.map((l) => l.id)
  const from = ids.indexOf(anchor)
  const to = ids.indexOf(layerId)
  if (from === -1 || to === -1) {
    selectionOrder = [layerId]
    return
  }
  const [lo, hi] = from < to ? [from, to] : [to, from]
  selectionOrder = ids.slice(lo, hi + 1)
}

/** Cmd+A：全选普通层（背景层不入列——批量物理写入只读）。 */
export function selectAllLayers(): void {
  backgroundSelected = false
  selectionOrder = paramState.layers.map((l) => l.id)
}

/** 选中背景层（独占——层选择清空）。 */
export function selectBackground(): void {
  backgroundSelected = true
  selectionOrder = []
}

export function clearLayerSelection(): void {
  selectionOrder = []
  backgroundSelected = false
}

/** 有序选择集（死层 id 读时过滤——undo/redo 跨结构变更的稳健面）。 */
export function getSelectionOrder(): string[] {
  const live = new Set(paramState.layers.map((l) => l.id))
  return selectionOrder.filter((id) => live.has(id))
}

/** 锚点层 = 最早选中层（Owner：「不是排列在前面，是最早选中的」）。 */
export function getAnchorLayer(): LayerState | null {
  const id = getSelectionOrder()[0]
  return id === undefined ? null : (paramState.layers.find((l) => l.id === id) ?? null)
}

export function isLayerSelected(layerId: string): boolean {
  return getSelectionOrder().includes(layerId)
}

/** 选择序徽标（①②③…——多选 >1 时显示；单选返回 null）。 */
export function selectionBadgeOf(layerId: string): number | null {
  const order = getSelectionOrder()
  if (order.length <= 1) return null
  const index = order.indexOf(layerId)
  return index === -1 ? null : index + 1
}

export function isBackgroundSelected(): boolean {
  return backgroundSelected
}

// ---------------------------------------------------------------------------
// 混合配置检测器（字段级——2.4 工作默认二；非整层 blob 比较）
// ---------------------------------------------------------------------------

/** 配置卡五字段 + 覆写签名的逐字段一致/混合态。 */
export interface LayerConfigFieldStatus<T> {
  mixed: boolean
  /** 预填锚点值（不显示混合值——Owner「滞空」落地义） */
  value: T
}

export interface SelectedConfigView {
  /** 选中普通层数（背景层不在列）。 */
  count: number
  /** 锚点层名（横幅「以 ①层名 为基准」）。 */
  anchorName: string
  /** 全等 → 'same'（横幅「N 层 · 配置相同」）；任一不等 → 'mixed'（「N 层配置不同 · 以 ①层名 为基准」）。 */
  banner: 'same' | 'mixed'
  strategy: LayerConfigFieldStatus<StrategyId>
  specKey: LayerConfigFieldStatus<string>
  gapMm: LayerConfigFieldStatus<number>
  density: LayerConfigFieldStatus<number>
  relax: LayerConfigFieldStatus<{ boundary: boolean; repulsion: boolean }>
  /** 覆写存在性签名混合态（块级覆写面只作用单块选择——此位供测试冻结面）。 */
  overridesMixed: boolean
}

function overridesSignature(layer: LayerState): string {
  return JSON.stringify({
    d: Object.keys(layer.overrides.disabled).sort(),
    e: Object.entries(layer.overrides.density).sort(([a], [b]) => (a < b ? -1 : 1)),
    t: Object.entries(layer.overrides.type).sort(([a], [b]) => (a < b ? -1 : 1)),
    c: Object.entries(layer.overrides.color).sort(([a], [b]) => (a < b ? -1 : 1)),
  })
}

/** 字段级混合检测：全部选中普通层的该字段相等 → same；否则 mixed + 预填锚点值。 */
export function selectedConfigView(): SelectedConfigView | null {
  const selected = getSelectionOrder()
    .map((id) => paramState.layers.find((l) => l.id === id))
    .filter((l): l is LayerState => l !== null)
  if (selected.length === 0) return null
  const anchor = selected[0]
  // 值比较（非对象身份——cloneLayer 产物 relax/覆写表恒为新对象，身份比较会假阳性 mixed）
  const field = <T>(pick: (l: LayerState) => T): LayerConfigFieldStatus<T> => {
    const value = pick(anchor)
    const expected = JSON.stringify(value)
    return { mixed: selected.some((l) => JSON.stringify(pick(l)) !== expected), value }
  }
  const strategy = field((l) => l.strategy)
  const specKey = field((l) => l.physics.specKey)
  const gapMm = field((l) => l.physics.gapMm)
  const density = field((l) => l.physics.density)
  const relax = field((l) => l.physics.relax)
  const anchorOverrides = overridesSignature(anchor)
  const overridesMixed = selected.some((l) => overridesSignature(l) !== anchorOverrides)
  return {
    count: selected.length,
    anchorName: anchor.name,
    banner:
      strategy.mixed || specKey.mixed || gapMm.mixed || density.mixed || relax.mixed || overridesMixed
        ? 'mixed'
        : 'same',
    strategy,
    specKey,
    gapMm,
    density,
    relax: { mixed: relax.mixed, value: { ...relax.value } },
    overridesMixed,
  }
}

/** 悬空覆写清点横幅数据面（syncBlocksLanded 写入；UI 单次提示消费后清零）。 */
let staleOverrideNotice = $state<number | null>(null)

// —— 读取器（组件/根聚合消费；返回 $state 代理保证响应式追踪） ——

export function getLayers(): LayerState[] {
  return paramState.layers
}

export function getLayerById(id: string): LayerState | null {
  return paramState.layers.find((l) => l.id === id) ?? null
}

export function getRestLayer(): LayerState | null {
  return paramState.layers.find((l) => l.blockIds === 'rest') ?? null
}

export function getParamState(): StudioParamState {
  return paramState
}

export function getPaletteState(): Palette {
  return paramState.palette
}

export function getSegmentOpts(): { k: number; seed: number } {
  return paramState.segment
}

export function getBackgroundObservation(): BackgroundLayerObservation {
  return backgroundObservation
}

export function getStaleOverrideNotice(): number | null {
  return staleOverrideNotice
}

export function clearStaleOverrideNotice(): void {
  staleOverrideNotice = null
}

/** 观察态写入（背景源/透明度/可见性——纯会话态，不入历史不入档）。 */
export function setBackgroundObservation(patch: Partial<BackgroundLayerObservation>): void {
  backgroundObservation = {
    ...backgroundObservation,
    ...patch,
    opacity: patch.opacity !== undefined ? Math.min(1, Math.max(0, patch.opacity)) : backgroundObservation.opacity,
  }
}

export function setLayerVisible(layerId: string, visible: boolean): void {
  const layer = getLayerById(layerId)
  if (layer !== null) layer.visible = visible
}

// —— 写入面 ——

/** 整体替换（undo/redo refold / 打开工程装载；观察态保持现场或由调用方复位）。 */
export function setParamState(next: StudioParamState): void {
  paramState = next
  // 选择集稳健面：结构变更（undo 跨删除/合并）后过滤死层 id；清空守卫退化为首层
  const live = new Set(next.layers.map((l) => l.id))
  const filtered = selectionOrder.filter((id) => live.has(id))
  selectionOrder = filtered.length > 0 ? filtered : next.layers.length > 0 ? [next.layers[0].id] : []
  if (backgroundSelected && selectionOrder.length > 0) backgroundSelected = false
}

/** palette 直写（palette.edit op 的 apply 面；remove 附带颜色覆写级联清理——确定性入 op 语义）。 */
export function applyPaletteEdit(
  state: StudioParamState,
  edit:
    | { kind: 'add'; name: string; hex: string }
    | { kind: 'upsert'; color: PaletteColor }
    | { kind: 'remove'; id: string },
): LayerMutationDiagnostic[] {
  if (edit.kind === 'add') {
    let n = state.palette.length + 1
    while (state.palette.some((c) => c.id === `c${n}`)) n++
    upsertPaletteColor(state.palette, { id: `c${n}`, name: edit.name.trim() || '新颜色', hex: edit.hex })
    return []
  }
  if (edit.kind === 'upsert') {
    upsertPaletteColor(state.palette, { ...edit.color })
    return []
  }
  removePaletteColor(state.palette, edit.id)
  // 引用该色的覆写一并失效（全层级联——原 removeColor 行为的层级化）
  for (const layer of state.layers) {
    for (const key of Object.keys(layer.overrides.color)) {
      if (layer.overrides.color[key] === edit.id) delete layer.overrides.color[key]
    }
  }
  return []
}

/** 分块参数写入（segment.opts op 的 apply 面——clamp 与 setSegK/setSegSeed 同界）。 */
export function applySegmentOpts(state: StudioParamState, k: number, seed: number): void {
  state.segment = {
    k: Math.min(10, Math.max(6, Math.round(k))),
    seed: Math.max(0, Math.round(seed) || 0),
  }
}

/**
 * 换图默认层集：单一兜底层「图层 1」+ 默认配置 + 默认观察态（palette/segment 保持现场——
 * 与拆分前 applyPainting 语义一致；「默认全选 + 自动排布 = 现状效果」等价性由 1.1
 * compatibility harness 证明）。打开工程（2.8）装载走 setParamState 整体替换。
 */
export function initDefaultLayers(): void {
  paramState = {
    layers: [
      {
        id: 'L1',
        name: '图层 1',
        blockIds: 'rest',
        strategy: DEFAULT_LAYER_STRATEGY,
        physics: defaultLayerPhysics(),
        overrides: emptyLayerOverrides(),
        visible: true,
      },
    ],
    layerSeq: 1,
    palette: paramState.palette.map((c) => ({ ...c })),
    segment: { ...paramState.segment },
  }
  backgroundObservation = defaultBackgroundObservation()
  staleOverrideNotice = null
  // Owner：「页面一进来默认全选图层，然后进行排布计算」——单层即 [L1]
  selectionOrder = ['L1']
  backgroundSelected = false
}

/** live 块集落位（runSegment 完成/undo 跨重分块 refold 后由根调用；计数横幅数据面）。 */
export function landBlocks(blocks: readonly Block[]): BlocksLandedReport {
  const report = syncBlocksLanded(paramState, blocks)
  if (report.droppedOverrideKeys > 0) staleOverrideNotice = report.droppedOverrideKeys
  return report
}

// ---------------------------------------------------------------------------
// 派生助手（根/检查器消费；两级回落语义单源）
// ---------------------------------------------------------------------------

/** 每块生效密度（块覆写 ?? 所属层 density——原 getBlockDensity 回落目标层级化）。 */
export function blockDensityOf(layers: readonly LayerState[], blockId: string): number {
  const owner = owningLayerOf(layers, blockId)
  return owner?.overrides.density[blockId] ?? owner?.physics.density ?? DEFAULT_DENSITY
}

/** 当前 rest 层 specKey → SSKey（旧 UI SS Select 兼容读面；非 round 键回退 SS10）。 */
export function restSsOf(layers: readonly LayerState[]): string {
  const rest = layers.find((l) => l.blockIds === 'rest')
  return rest ? (ssOfRoundSpecKey(rest.physics.specKey) ?? 'SS10') : 'SS10'
}

/** 测试/复位专用：图层域整体复位（色板还原起步色板）。 */
export function resetLayersForTests(): void {
  paramState = {
    layers: [],
    layerSeq: 0,
    palette: STARTER_PALETTE.map((c) => ({ ...c })),
    segment: { k: 8, seed: 1 },
  }
  backgroundObservation = defaultBackgroundObservation()
  staleOverrideNotice = null
  selectionOrder = []
  backgroundSelected = false
}
