/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 rename-and-expert-workbench A 2.3] 送精修构造域（原 stores/studio.svelte.ts
 *    :960-1007）纯搬移 + store 根 re-export 薄 wrapper。零行为变化；公共导出面经根 re-export 兼容。
 * 2. [payload 红线（R3 P0 修复冻结，design §2.2 裁决二）] buildManualEditHandoff/ManualEditHandoff
 *    的唯一修改 owner = studio-layers replay/handoff gate；本 change 消费接线归 D 轨 5.9（硬前置 =
 *    gate 验收完成）。本文件在 gate 前只维护薄 wrapper：payload 字段/深拷贝语义/构造逻辑零改动，
 *    ManualEditHandoff 类型真源仍在 stores/edit.svelte.ts（type-only 导入，无运行时耦合）。
 */

import type { Block } from '$lib/engine'
import type { ManualEditHandoff } from '$lib/stores/edit.svelte'
import { STRATEGY_LABELS } from '$lib/workers/computeCore'
import {
  getActiveResult,
  getActiveStrategy,
  getEffectiveBlocks,
  getGlobalDensity,
  getPainting,
  getPalette,
  getReferenceImage,
  getGrid,
  getSs,
} from '$lib/stores/studio.svelte'

// ---------------------------------------------------------------------------
// 送精修（add-manual-edit-mode tasks 3.1）：排钻设计 → 专家工作台的显式交接构造
// ---------------------------------------------------------------------------

/** 来源摘要（送精修 sourceSummary / 导出 PNG 入库命名的共用口径）。 */
export function currentSourceSummary(): string {
  const res = getActiveResult()
  if (!res) return '未命名'
  return `${STRATEGY_LABELS[getActiveStrategy()]} · 密度 ${Math.round(getGlobalDensity() * 100)}% · ${getSs()} · ${res.gems.length} 钻`
}

/**
 * 从当前排钻设计状态构造 ManualEditHandoff（深拷贝快照；edit store 侧还会再深拷贝一次收下）。
 * 无可送内容（无 activeResult / 计算失败 / 无像素）返回 null。
 * [add-manual-edit-mode C-1 修订 / add-asset-library 6.1] 参考原图以 referenceAssetId 交接
 * （[Owner] 直接切换：referenceDataUrl 字段已删）。
 */
export function buildManualEditHandoff(): ManualEditHandoff | null {
  const res = getActiveResult()
  const image = getPainting()
  if (!res || res.error || !image) return null
  return {
    gems: res.gems.map((g) => ({ ...g })),
    blocks: getEffectiveBlocks().map(copyBlockForHandoff),
    palette: getPalette().map((c) => ({ ...c })),
    grid: { ...getGrid() },
    width: image.width,
    height: image.height,
    sourceSummary: currentSourceSummary(),
    paintingSnapshot: {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
    },
    referenceAssetId: getReferenceImage()?.assetId,
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
