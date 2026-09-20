/*
 * Orthogonal intents (max 1):
 * 1. [2026-09-20 C-3.4/3.5 rename-and-expert-workbench；2026-09-21 迁移至 lib/designer]
 *    批量几何/字段命令的唯一应用入口：一批 UpdateChange = 一条 update patch = 一个 undo 组
 *    （design §3.3/§3.5——属性面板批量写、对齐分布、N 选命令共用）。
 *    语义不变迁移（design §7.4 退役清单「迁移」行）。
 */

import { applyPatch, beginStroke, endStroke, type UpdateChange } from '$lib/stores/edit.svelte'

/** 应用一批字段变更（单 undo 组）；空批 no-op 返回 false。 */
export function applyGemChanges(changes: readonly UpdateChange[]): boolean {
  if (changes.length === 0) return false
  beginStroke()
  const result = applyPatch({ op: 'update', changes: [...changes] })
  endStroke()
  return result.ok
}
