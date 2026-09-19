/*
 * 联合导出前置门（studio-layers 1.3——engine exportGate 的层序组织与消费接线）。
 *
 * 正交意图：
 * 1. [联合判据（R1·议题 9 推翻「分区互斥 ≠ 几何不重叠」）] 全层结果统一受检：
 *    层内布局终局（含 relax 位移）与层间碰撞一并过 engine exportGate（cell = maxCellPx、
 *    判据 requiredCenterDistancePx×0.999，单位恒 px；engine 签名零改动）——
 *    「检索不漏 ≠ 分区结果几何合规」（R2 §一 P0-2）。
 * 2. [判距 gap 的层序组织（逐对 gap = max(两钻所属层 gapMm)）] engine 门单 grid 单 gap——
 *    混合 gap 层集的逐对语义按层序组织为两段：
 *    ① 各层**单独**过门（层自身 grid：gapMm = 层 gap）——层内对按本层契约判距
 *       （层自身合法布局不得因他层更大 gap 被误报）；
 *    ② 全层 concat 过 joint grid（px 锚 uniform + 参与层最大 gap）——**只保留层间对**
 *       （跨层碰撞保守判距不漏报；层内对已在 ① 以正确 gap 受检，joint 判距对其可能过严，
 *       重复面滤除）。px 换算单源 = 画幅像素锚（同画幅同 px 空间）；逐钻 diameterMm 已
 *       物化（engine gate 1.4），不依赖 grid 基准回落。
 * 3. [违规按层对分组] 平面违规确定性排序（engine 同契约：kind 秩 spacing < mask <
 *    missing-asset → gemIds 字典序——本侧按同规则合并 ①② 两段）；按 gemId → 层归属聚合为
 *    「层内（intra）/层间（inter 层 A × 层 B）」分组（§2.7 状态条违规清单 ▾ 的数据面）。
 * 4. [隐藏 ≠ 排除（§2.5 名义化契约）] visible 为纯观察态——**门忽略**：隐藏层照常进入
 *    判据；导出四路（SVG/BOM CSV/PNG/送精修）以 ok=false **硬阻断**（违规 = 不产出导出物）；
 *    保存允许 warning（保存路径不消费本门，语义归文档可存）。
 */

import {
  exportGate,
  type Block,
  type ExportGateVerdict,
  type ExportViolation,
  type ExportViolationKind,
  type GateGem,
  type GridSpec,
  type ShapeAssetRefState,
} from '$lib/engine'

/** 参与联合门的层（隐藏层照常入列）。 */
export interface JointGateLayer<G extends GateGem = GateGem> {
  layerId: string
  layerName: string
  /** 层 gapMm（层内对判距 gap = 本层；层间对 = 参与层最大——保守不漏报）。 */
  gapMm: number
  /** 层钻产物（engine 判据的逐钻 diameterMm 已物化）。 */
  gems: readonly G[]
  /** 观察态（门忽略——隐藏层仍参与判据/分组）。 */
  visible?: boolean
}

export interface JointGateOptions {
  /** 画幅像素锚（px↔mm 换算单源；层间 uniform）。 */
  pixelsPerMm: number
  /** 掩码检查面（全层 effectiveBlocks 并集；缺席跳过 mask 面）。 */
  blocks?: Block[]
  /** custom 资产解析面（缺席跳过 missing-asset 面）。 */
  resolveShapeAsset?: (assetId: string) => ShapeAssetRefState
}

/** 层对分组（intra = 单层内；inter = 层 A × 层 B——层 id 字典序对）。 */
export interface LayeredViolationGroup {
  scope: 'intra' | 'inter'
  /** 确定性排序层 id（intra 单元素；inter 二元素字典序）。 */
  layerIds: string[]
  /** 人读层名（与 layerIds 同序）。 */
  layerNames: string[]
  /** 组内违规（平面序——同输入同输出）。 */
  violations: ExportViolation[]
}

export interface JointGateResult {
  /** 合并判决（①层内 ∪ ②层间；ok=false = 导出四路硬阻断信号）。 */
  verdict: ExportGateVerdict
  /** 违规按层对分组（层 id 对字典序——确定性）。 */
  groups: LayeredViolationGroup[]
  /** gemId → 归属层 id 集（concat 序 append；重复 id 跨层入列 = 多归属——malformed 显式可判）。 */
  gemLayer: ReadonlyMap<string, readonly string[]>
}

/** engine 平面序契约的本地镜像（engine/exportGate.ts 同规则：kind 秩 → gemIds 字典序）。 */
const KIND_RANK: Record<ExportViolationKind, number> = { spacing: 0, mask: 1, 'missing-asset': 2 }

function compareViolations(a: ExportViolation, b: ExportViolation): number {
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
  if (byKind !== 0) return byKind
  const len = Math.min(a.gemIds.length, b.gemIds.length)
  for (let i = 0; i < len; i += 1) {
    if (a.gemIds[i] !== b.gemIds[i]) return a.gemIds[i] < b.gemIds[i] ? -1 : 1
  }
  return a.gemIds.length - b.gemIds.length
}

/**
 * 联合导出前置门（判据/门 = engine exportGate 已证；本函数 = 层序组织）：
 * ① 各层单独过门（层自身 grid）→ 全部违规（层内对本层契约判距）；
 * ② concat 过 joint grid（px 锚 + 参与层最大 gap）→ 仅保留层间对违规；
 * 合并（engine 序）→ 违规按层对聚合。
 */
export function jointExportGate<G extends GateGem>(
  layers: readonly JointGateLayer<G>[],
  options: JointGateOptions,
): JointGateResult {
  const gemLayer = new Map<string, string[]>()
  const gems: G[] = []
  let jointGapMm = 0
  let maxDiameterMm = 0
  for (const layer of layers) {
    if (layer.gapMm > jointGapMm) jointGapMm = layer.gapMm
    for (const gem of layer.gems) {
      gems.push(gem)
      const owners = gemLayer.get(gem.id)
      if (owners === undefined) gemLayer.set(gem.id, [layer.layerId])
      else if (!owners.includes(layer.layerId)) owners.push(layer.layerId)
      if ((gem.diameterMm ?? 0) > maxDiameterMm) maxDiameterMm = gem.diameterMm ?? 0
    }
  }
  const layerGridOf = (gapMm: number, diameterMm: number): GridSpec => ({
    pitchMm: diameterMm + gapMm > 0 ? diameterMm + gapMm : 1,
    gapMm,
    rowAngleDeg: 0,
    pixelsPerMm: options.pixelsPerMm,
  })
  const gateOptions = {
    ...(options.blocks !== undefined ? { blocks: options.blocks } : {}),
    ...(options.resolveShapeAsset !== undefined ? { resolveShapeAsset: options.resolveShapeAsset } : {}),
  }

  const merged: ExportViolation[] = []
  const ownerOf = (violation: ExportViolation): Set<string> => {
    const owners = new Set<string>()
    for (const id of violation.gemIds) for (const layerId of gemLayer.get(id) ?? []) owners.add(layerId)
    return owners
  }

  // ① 各层单独过门（层自身 gap 判距；隐藏层照常）
  for (const layer of layers) {
    let layerMaxDiameterMm = 0
    for (const gem of layer.gems) if ((gem.diameterMm ?? 0) > layerMaxDiameterMm) layerMaxDiameterMm = gem.diameterMm ?? 0
    const verdict = exportGate(layer.gems, { grid: layerGridOf(layer.gapMm, layerMaxDiameterMm), ...gateOptions })
    merged.push(...verdict.violations) // 单层门内违规恒为层内对（含 mask/missing-asset 单钻面）
  }

  // ② concat 过 joint grid（参与层最大 gap）——只保留层间对（层内对已按本层 gap 受检）
  const jointVerdict = exportGate(gems, { grid: layerGridOf(jointGapMm, maxDiameterMm), ...gateOptions })
  for (const violation of jointVerdict.violations) {
    if (ownerOf(violation).size >= 2) merged.push(violation)
  }

  merged.sort(compareViolations)
  const verdict: ExportGateVerdict = { ok: merged.length === 0, violations: merged }

  // 违规 → 层对分组
  const byId = new Map(layers.map((l) => [l.layerId, l] as const))
  const groups = new Map<string, LayeredViolationGroup>()
  for (const violation of verdict.violations) {
    const ownerIds = [...ownerOf(violation)]
    const sorted = [...ownerIds].sort()
    const key = sorted.join('×')
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        scope: sorted.length >= 2 ? 'inter' : 'intra',
        layerIds: sorted,
        layerNames: sorted.map((id) => byId.get(id)?.layerName ?? id),
        violations: [],
      }
      groups.set(key, group)
    }
    group.violations.push(violation)
  }
  return {
    verdict,
    groups: [...groups.values()].sort((a, b) => (a.layerIds.join('×') < b.layerIds.join('×') ? -1 : 1)),
    gemLayer,
  }
}
