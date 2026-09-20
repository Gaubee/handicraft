/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 内部剪贴板（design §3.2：
 *    ⌘C/⌘X/⌘V 与右键菜单共用）：copy = 选中快照入栈（重复粘贴计数清零）；cut = copy +
 *    单 remove patch（一个 undo 组）；paste = 副本单 add patch——副本语义同 design §4.1
 *    复制行（buildGemCopies 单源：id 'm-' 自增/origin='manual'/blockId=null/moved 重置/
 *    归当前目标层），**原位偏移一格**（PS 惯例；重复粘贴累进偏移——每贴一次 +1 格，
 *    格 = 当前网格 pitch）。
 * 2. [Pure-ish] 只消费 store patch 面与 workbench 当前层真源——vitest 直驱；快照深拷贝
 *    防源钻后续变更渗入剪贴板。resetClipboardForTests 复位。
 */

import { pitchPx } from '$lib/engine'
import {
  applyPatch,
  getEditDoc,
  nextManualId,
  setSelection,
  type DesignerGem,
} from '$lib/stores/edit.svelte'
import { buildGemCopies } from './gestures'
import { currentLayerIdOf } from './workbench.svelte'

let stored: DesignerGem[] = []
let pasteCount = 0

/** 剪贴板容量（可粘贴性判据——菜单/键位禁用态消费）。 */
export function clipboardSize(): number {
  return stored.length
}

/** 复制（快照深拷贝；重复粘贴偏移计数清零）。空集返回 false。 */
export function copyGems(gems: readonly DesignerGem[]): boolean {
  if (gems.length === 0) return false
  stored = gems.map((g) => ({ ...g }))
  pasteCount = 0
  return true
}

/**
 * 粘贴：副本 = 快照 + 偏移（第 n 次粘贴偏移 n 格）+ §4.1 复制行语义，单 add patch
 * （一个 undo 组），选集切新副本。剪贴板空/文档缺席/无目标层返回 false。
 */
export function pasteClipboard(): boolean {
  const doc = getEditDoc()
  if (doc === null || stored.length === 0) return false
  const layer = currentLayerIdOf(doc)
  if (layer === null) return false
  pasteCount += 1
  const cell = pitchPx(doc.grid)
  const copies = buildGemCopies(stored, layer, { dx: pasteCount * cell, dy: pasteCount * cell }, nextManualId)
  const result = applyPatch({ op: 'add', gems: copies })
  if (result.ok) setSelection(copies.map((c) => c.id))
  return result.ok
}

/** 测试专用：复位（快照/计数清零）。 */
export function resetClipboardForTests(): void {
  stored = []
  pasteCount = 0
}
