/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-21 redesign-designer-workbench 7.2] 智能排布落点态：面板开合（顶栏「智能排布…」
 *    按钮 / 右键空态「智能排布…」/ 命令总线 open-smart-layout 三入口同源单真源）。
 * 2. [7.2 可用性单源] smartLayoutUnderlayReady：无参考底图禁用（design §5.3「工具输入=底图」
 *    ——underlay.sources 含 painting 或 reference 源即可用；空白起步两源皆无 = 禁用 + tooltip
 *    「需要参考底图」）。DocBar 按钮/右键菜单项/命令门槛统一消费，禁第二实现。
 * 3. [7.2 执行链] runSmartLayout + 冲突过滤 + 落当前层单 undo 组（随 7.2 切片扩展本文件）。
 * 4. [Test] resetSmartLayoutForTests 复位。
 */

import type { EditDocument } from '$lib/stores/edit.svelte'

// ---------------------------------------------------------------------------
// 面板开合（单真源）
// ---------------------------------------------------------------------------

let smartLayoutOpen = $state(false)

export function getSmartLayoutOpen(): boolean {
  return smartLayoutOpen
}

export function setSmartLayoutOpen(open: boolean): void {
  smartLayoutOpen = open
}

// ---------------------------------------------------------------------------
// 可用性判定（无参考底图禁用——design §5.3；单源消费）
// ---------------------------------------------------------------------------

/**
 * 智能排布可用性：underlay 具备可用底图源（painting = 送精修/迁移快照；reference = 空白
 * 起步选图）。注意判据是 **underlay.sources 现状**（非 paintingSnapshot 尺寸占位——空白起步
 * 的 1×1 透明内存占位不构成底图，且序列化不伪造该源，见 gemdocLifecycle serialize 对称修复）。
 */
export function smartLayoutUnderlayReady(doc: EditDocument | null): boolean {
  if (doc === null) return false
  return doc.underlay.sources.some((s) => s.key === 'painting' || s.key === 'reference')
}

// ---------------------------------------------------------------------------
// 测试复位
// ---------------------------------------------------------------------------

/** 测试专用：整体复位（开合态清零；执行链态随 7.2 扩展同函数收口）。 */
export function resetSmartLayoutForTests(): void {
  smartLayoutOpen = false
}
