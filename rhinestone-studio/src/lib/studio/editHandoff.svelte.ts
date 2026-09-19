/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 rename-and-expert-workbench A 2.3 拆移 / 2026-09-20 studio-layers 1.4 换真]
 *    送精修构造域：薄 wrapper → 真实现（payload v2——修改权自 studio-layers replay/handoff
 *    gate 接管，对照 expert design §2.2 交接表）。gems = 各层 concat 逐钻物化规格
 *    （③段现状 = 单 rest 层 activeResult——2.x layers store 接线后扩为逐层 concat）、
 *    blocks = 各层 effectiveBlocks 并集、+ physicalCanvas（studio 会话无 declared 画幅锚——
 *    gemproj 打开链路归 2.8——恒 default 锚显式合成）、sourceSummary 层语法
 *    `N 层 · 共 X 钻 · 主规格 …`（原单值语法「策略 · 密度 · SS · N 钻」退役）。
 * 2. [依赖纪律] ManualEditHandoff 类型真源在 stores/edit.svelte.ts（type-only 导入）；
 *    store 读取器单向消费（getActiveResult/getEffectiveBlocks/…），不反向持有。
 */

import { gemShapeDisplayName, gemSpecIdentityOf, type Block, type Gem, type GridSpec } from '$lib/engine'
import { defaultPhysicalCanvasOf, type ManualEditHandoff } from '$lib/stores/edit.svelte'
import {
  getActiveResult,
  getEffectiveBlocks,
  getGrid,
  getPainting,
  getPalette,
  getReferenceImage,
} from '$lib/stores/studio.svelte'

// ---------------------------------------------------------------------------
// 送精修（add-manual-edit-mode tasks 3.1 + studio-layers 1.4 payload v2）
// ---------------------------------------------------------------------------

/** 主规格标签：逐钻 canonical 身份投影（gemSpecIdentityOf）计数取众——并列取 specKey 字典序。 */
function dominantSpecLabel(gems: readonly Gem[], grid: GridSpec): string {
  const counts = new Map<string, { count: number; label: string }>()
  for (const g of gems) {
    const identity = gemSpecIdentityOf(g, grid)
    const entry = counts.get(identity.specKey)
    if (entry !== undefined) entry.count += 1
    else counts.set(identity.specKey, { count: 1, label: `${gemShapeDisplayName(identity.shapeId)} ${identity.sizeLabel}` })
  }
  let bestKey = ''
  let best: { count: number; label: string } | undefined
  for (const [key, entry] of counts) {
    if (best === undefined || entry.count > best.count || (entry.count === best.count && key < bestKey)) {
      best = entry
      bestKey = key
    }
  }
  return best?.label ?? ''
}

/** 层语法摘要单源（1.4）：`N 层 · 共 X 钻 · 主规格 …`——studio 送精修与 gemproj replay（1.5）共用。 */
export function layerSourceSummaryFor(layerCount: number, gems: readonly Gem[], grid: GridSpec): string {
  const label = dominantSpecLabel(gems, grid)
  const head = `${layerCount} 层 · 共 ${gems.length} 钻`
  return label === '' ? head : `${head} · 主规格 ${label}`
}

/** 来源摘要（送精修 sourceSummary / 导出 PNG 入库命名的共用口径——层语法 1.4 起）。 */
export function currentSourceSummary(): string {
  const res = getActiveResult()
  if (!res) return '未命名'
  return layerSourceSummaryFor(1, res.gems, getGrid())
}

/**
 * 从当前排钻设计状态构造 ManualEditHandoff v2（深拷贝快照；edit store 侧再深拷贝一次收下）。
 * 无可送内容（无 activeResult / 计算失败 / 无像素）返回 null。
 * [add-asset-library 6.1] 参考原图以 referenceAssetId 交接；[studio-layers 1.4]
 * gems = 各层 concat（当前单 rest 层 = activeResult）、blocks = effectiveBlocks 并集、
 * physicalCanvas = default 锚显式（studio 会话画幅锚归 2.8 gemproj 打开链路携带）。
 */
export function buildManualEditHandoff(): ManualEditHandoff | null {
  const res = getActiveResult()
  const image = getPainting()
  const grid = getGrid()
  if (!res || res.error || !image) return null
  return {
    gems: res.gems.map((g) => ({ ...g })),
    blocks: getEffectiveBlocks().map(copyBlockForHandoff),
    palette: getPalette().map((c) => ({ ...c })),
    grid: { ...grid },
    width: image.width,
    height: image.height,
    sourceSummary: layerSourceSummaryFor(1, res.gems, grid),
    paintingSnapshot: {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
    },
    referenceAssetId: getReferenceImage()?.assetId,
    physicalCanvas: defaultPhysicalCanvasOf(image.width, image.height, grid.pixelsPerMm),
  }
}

function copyBlockForHandoff(b: Block): Block {
  return {
    ...b,
    colorRgb: [...b.colorRgb] as [number, number, number],
    bbox: { ...b.bbox },
    widthPx: { ...b.widthPx },
    mask: { w: b.mask.w, h: b.mask.h, bits: new Uint8Array(b.mask.bits) },
  }
}
