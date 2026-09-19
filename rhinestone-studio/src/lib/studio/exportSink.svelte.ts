/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 rename-and-expert-workbench A 2.2] 导出编排域（原 stores/studio.svelte.ts
 *    :928-959 SVG/BOM 装配 + :1008-1044 导出 PNG 入库 sys-exports）纯搬移。零行为变化：
 *    公共导出面经 store 根 re-export 兼容（design §2.3-1/2）。
 * 2. [依赖纪律] 子模块只读消费 store 核心 $state——全部经根公共读取器
 *    （getActiveResult/getPainting/getExportCheck/getGrid/getPalette/getEffectiveBlocks/
 *    getActiveStrategy/getSourceImage）+ engine/persistence 公共面；不写任何 store 状态。
 */

import { exportBom, exportSvg } from '$lib/engine'
import { ingestAsset } from '$lib/persistence/assetStore'
import {
  getActiveResult,
  getActiveStrategy,
  getEffectiveBlocks,
  getExportCheck,
  getGrid,
  getPainting,
  getPalette,
  getSourceImage,
} from '$lib/stores/studio.svelte'

// ---------------------------------------------------------------------------
// 导出（SVG / BOM CSV；PNG 光栅化在 ExportBar 组件层用 canvas 完成）
// ---------------------------------------------------------------------------

function baseName(): string {
  const name = getSourceImage()?.name ?? 'rhinestone'
  return name.replace(/\.[^.]+$/, '') || 'rhinestone'
}

export function buildActiveSvg(): Blob | null {
  const res = getActiveResult()
  const image = getPainting()
  if (!res || !image || !getExportCheck().exportable) return null
  return exportSvg({ gems: res.gems, warnings: res.warnings }, getGrid(), {
    width: image.width,
    height: image.height,
    palette: getPalette().map((c) => ({ ...c })),
    blocks: getEffectiveBlocks(),
    showBoundaries: true,
  })
}

export function buildActiveBom(): Blob | null {
  const res = getActiveResult()
  if (!res || !getExportCheck().exportable) return null
  return exportBom({ gems: res.gems, warnings: res.warnings }, getPalette().map((c) => ({ ...c })), getGrid())
}

export function exportFileName(ext: string): string {
  return `${baseName()}-${getActiveStrategy()}.${ext}`
}

// ---------------------------------------------------------------------------
// 导出 PNG 入库（add-asset-library 6.3：sys-exports，source='edit-export'）
// ---------------------------------------------------------------------------

/** 与 assetStore 迁移同格式的导出时间戳（MM-DD HH:mm）。 */
function stampOf(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 导出 PNG 入库 sys-exports（name `精修 · <来源摘要> · MM-DD HH:mm.png`）。
 * 下载与入库解耦：入库失败不阻断下载（返回 null，调用方跳过「在素材库中查看」toast）。
 */
export async function archiveExportedPng(
  blob: Blob,
  sourceSummary: string,
  width = 0,
  height = 0,
): Promise<string | null> {
  try {
    const ingested = await ingestAsset({
      blob,
      name: `精修 · ${sourceSummary} · ${stampOf(Date.now())}.png`,
      width,
      height,
      parentId: 'sys-exports',
      source: 'edit-export',
    })
    return ingested.node.id
  } catch (error) {
    console.warn('导出 PNG 入库失败', error)
    return null
  }
}
