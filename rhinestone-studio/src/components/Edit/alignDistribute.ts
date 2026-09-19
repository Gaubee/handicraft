/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.5 rename-and-expert-workbench] 对齐六式（≥2）/ 等距分布（≥3）纯几何
 *    计算——只消费 x/y（零 v2 依赖，design §3.6 裁断归组件轨）；产出 UpdateChange[]
 *    由 applyGemChanges 包成单 undo 组。
 * 2. [2026-09-20 Pure] 纯 TS——vitest 直接断言几何。
 */

import type { EditGem } from '$lib/engine'
import type { UpdateChange } from '$lib/stores/edit.svelte'

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'

export const ALIGN_COMMANDS: ReadonlyArray<{ id: AlignMode; label: string }> = [
  { id: 'left', label: '左对齐' },
  { id: 'center-x', label: '水平居中' },
  { id: 'right', label: '右对齐' },
  { id: 'top', label: '顶对齐' },
  { id: 'center-y', label: '垂直居中' },
  { id: 'bottom', label: '底对齐' },
]

export type DistributeMode = 'horizontal' | 'vertical'

export const DISTRIBUTION_COMMANDS: ReadonlyArray<{ id: DistributeMode; label: string }> = [
  { id: 'horizontal', label: '水平等距' },
  { id: 'vertical', label: '垂直等距' },
]

/**
 * 对齐（design §3.5 六式）：全体成员移到极值/中线。命中者（已在目标位）不入 changes
 * （undo 只回退真实位移）；数量门槛（≥2）由调用方 UI 门控，本函数对 <2 亦安全
 * （单钻对齐 = no-op）。
 */
export function buildAlignChanges(gems: readonly EditGem[], mode: AlignMode): UpdateChange[] {
  if (gems.length < 2) return []
  let target: number
  switch (mode) {
    case 'left':
      target = Math.min(...gems.map((g) => g.x))
      return xChanges(gems, target)
    case 'right':
      target = Math.max(...gems.map((g) => g.x))
      return xChanges(gems, target)
    case 'center-x':
      target = (Math.min(...gems.map((g) => g.x)) + Math.max(...gems.map((g) => g.x))) / 2
      return xChanges(gems, target)
    case 'top':
      target = Math.min(...gems.map((g) => g.y))
      return yChanges(gems, target)
    case 'bottom':
      target = Math.max(...gems.map((g) => g.y))
      return yChanges(gems, target)
    case 'center-y':
      target = (Math.min(...gems.map((g) => g.y)) + Math.max(...gems.map((g) => g.y))) / 2
      return yChanges(gems, target)
  }
}

/** 等距分布（≥3）：首尾锚定，中间成员中心等距。退化（首尾同位/成员 <3）返回 null。 */
export function buildDistributeChanges(
  gems: readonly EditGem[],
  mode: DistributeMode,
): UpdateChange[] | null {
  if (gems.length < 3) return null
  const sorted =
    mode === 'horizontal' ? [...gems].sort((a, b) => a.x - b.x) : [...gems].sort((a, b) => a.y - b.y)
  const first = mode === 'horizontal' ? sorted[0].x : sorted[0].y
  const last = mode === 'horizontal' ? sorted[sorted.length - 1].x : sorted[sorted.length - 1].y
  if (last - first <= 0) return null
  const step = (last - first) / (sorted.length - 1)
  const changes: UpdateChange[] = []
  for (let i = 1; i < sorted.length - 1; i++) {
    const gem = sorted[i]
    const target = first + i * step
    if (mode === 'horizontal') {
      if (gem.x === target) continue
      changes.push({ id: gem.id, before: { x: gem.x }, after: { x: target } })
    } else {
      if (gem.y === target) continue
      changes.push({ id: gem.id, before: { y: gem.y }, after: { y: target } })
    }
  }
  return changes
}

function xChanges(gems: readonly EditGem[], target: number): UpdateChange[] {
  const changes: UpdateChange[] = []
  for (const gem of gems) {
    if (gem.x === target) continue
    changes.push({ id: gem.id, before: { x: gem.x }, after: { x: target } })
  }
  return changes
}

function yChanges(gems: readonly EditGem[], target: number): UpdateChange[] {
  const changes: UpdateChange[] = []
  for (const gem of gems) {
    if (gem.y === target) continue
    changes.push({ id: gem.id, before: { y: gem.y }, after: { y: target } })
  }
  return changes
}
