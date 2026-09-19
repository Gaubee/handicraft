/*
 * 联合导出前置门（studio-layers 1.3——engine exportGate 的层序组织与消费接线）。
 *
 * 正交意图：
 * 1. [联合判据（R1·议题 9 推翻「分区互斥 ≠ 几何不重叠」）] 全层结果 **concat 后**统一过
 *    engine exportGate（engine/exportGate.ts——spatial hash cell = maxCellPx、判据
 *    requiredCenterDistancePx×0.999，单位恒 px；engine 签名零改动）。层内布局终局（含
 *    relax 位移）随 concat 一并受检——「检索不漏 ≠ 分区结果几何合规」（R2 §一 P0-2）。
 * 2. [判距 grid 的层序组织] px 换算单源 = 画幅像素锚（pixelsPerMm 层间 uniform——同画幅同
 *    px 空间）；gap 单一来源取**参与层最大 gapMm**（保守：跨层对判距不因任一层 gap 较小而
 *    放水——不漏报）。逐钻 diameterMm 已物化（engine gate 1.4），不依赖 grid 基准回落。
 * 3. [违规按层对分组] engine 输出平面 violations（确定性排序）；本模块按 gemId → 层归属
 *    聚合为「层内（intra）/层间（inter 层 A × 层 B）」分组（§2.7 状态条违规清单 ▾ 的数据面）。
 *    分组序确定（层 id 对字典序）；组内保持 engine 序。
 * 4. [隐藏 ≠ 排除（§2.5 名义化契约）] visible 为纯观察态——**门忽略**：隐藏层照常进入
 *    concat 集与判据；导出四路（SVG/BOM CSV/PNG/送精修）以 verdict.ok=false **硬阻断**
 *    （违规 = 不产出导出物）；保存允许 warning（保存路径不消费本门，语义归文档可存）。
 */

import {
  exportGate,
  type Block,
  type ExportGateVerdict,
  type ExportViolation,
  type GateGem,
  type GridSpec,
  type ShapeAssetRefState,
} from '$lib/engine'

/** 参与联合门的层（concat 次序 = layers 数组序；隐藏层照常入列）。 */
export interface JointGateLayer<G extends GateGem = GateGem> {
  layerId: string
  layerName: string
  /** 层 gapMm（判距 gap 保守取参与层最大）。 */
  gapMm: number
  /** 层钻产物（engine 判据的逐钻 diameterMm 已物化）。 */
  gems: readonly G[]
  /** 观察态（门忽略——隐藏层仍参与 concat/判据/分组）。 */
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
  /** 组内违规（engine 平面序——同输入同输出）。 */
  violations: ExportViolation[]
}

export interface JointGateResult {
  /** engine 门原样判决（平面违规、确定性排序；ok=false = 导出四路硬阻断信号）。 */
  verdict: ExportGateVerdict
  /** 违规按层对分组（层 id 对字典序——确定性）。 */
  groups: LayeredViolationGroup[]
  /** gemId → 归属层 id（concat 序后写覆盖——违规聚合映射）。 */
  gemLayer: ReadonlyMap<string, string>
}

/**
 * 联合导出前置门：全层 gems concat → engine exportGate（单 grid：pixelsPerMm 画幅锚 +
 * gap = 参与层最大）→ 违规按层对聚合。
 */
export function jointExportGate<G extends GateGem>(
  layers: readonly JointGateLayer<G>[],
  options: JointGateOptions,
): JointGateResult {
  const gemLayer = new Map<string, string>()
  const gems: G[] = []
  let jointGapMm = 0
  let maxDiameterMm = 0
  for (const layer of layers) {
    if (layer.gapMm > jointGapMm) jointGapMm = layer.gapMm
    for (const gem of layer.gems) {
      gems.push(gem)
      gemLayer.set(gem.id, layer.layerId)
      if ((gem.diameterMm ?? 0) > maxDiameterMm) maxDiameterMm = gem.diameterMm ?? 0
    }
  }
  const grid: GridSpec = {
    pitchMm: maxDiameterMm + jointGapMm > 0 ? maxDiameterMm + jointGapMm : 1,
    gapMm: jointGapMm,
    rowAngleDeg: 0,
    pixelsPerMm: options.pixelsPerMm,
  }
  const verdict = exportGate(gems, {
    grid,
    ...(options.blocks !== undefined ? { blocks: options.blocks } : {}),
    ...(options.resolveShapeAsset !== undefined ? { resolveShapeAsset: options.resolveShapeAsset } : {}),
  })

  // 违规 → 层对分组（gemIds → 层归属集合；单层 = intra，双属 = inter）
  const byId = new Map(layers.map((l) => [l.layerId, l] as const))
  const groups = new Map<string, LayeredViolationGroup>()
  for (const violation of verdict.violations) {
    const ownerIds = [...new Set(violation.gemIds.map((id) => gemLayer.get(id)).filter((v) => v !== undefined))]
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
  return { verdict, groups: [...groups.values()].sort((a, b) => (a.layerIds.join('×') < b.layerIds.join('×') ? -1 : 1)), gemLayer }
}
