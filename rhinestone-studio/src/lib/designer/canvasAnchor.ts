/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 5.2] 画幅锚定（裁决 6，design §5.2）：
 *    physicalCanvas 的 declared 写入口——状态栏画幅 popover「宽/高 mm 直输」唯一通道。
 *    改 declared = 用户声明物理尺寸（anchorSource 两态流转 default→declared 单向一次）；
 *    画布像素（doc.width/height px）不变，物理换算 px/mm 随之重定（px/mm := widthPx÷widthMm，
 *    与 engine pixelsPerMmFromCanvas 同式——锚定降采样后像素）。
 * 2. [Dirty 口径] 画幅 = 文档物理真值（序列化字段）→ 变更即 dirty（非撤销直改——层属性
 *    setter 同式；patch 三原子不承载画幅，design §5.2 未要求可撤销）。
 * 3. [Pure 读数] canvasPixelsPerMm 纯函数（px/mm 人读与 popover 显示共单源；非法画幅回退
 *    engine PIXELS_PER_MM 缺省——显式回退不静默）。
 */

import { PIXELS_PER_MM, type PhysicalCanvas } from '$lib/engine'
import { getEditDoc } from '$lib/stores/edit.svelte'
import { markEditDirty } from '$lib/edit/documentStatus.svelte'

/** 画幅 px/mm 读数（锚定语义：widthPx ÷ widthMm；非法（无文档/非正画幅）→ 缺省 2.5 回退）。 */
export function canvasPixelsPerMm(doc: { width: number; physicalCanvas: PhysicalCanvas } | null): number {
  if (doc === null || !(doc.physicalCanvas.widthMm > 0) || !(doc.width > 0)) return PIXELS_PER_MM
  return doc.width / doc.physicalCanvas.widthMm
}

/** 声明画幅上限（防误输巨值——5000mm 已远超成品画幅常识域；非规格值域，软上限）。 */
export const MAX_CANVAS_MM = 5000

export interface DeclareCanvasResult {
  ok: boolean
  /** 不 ok 时的原因（人读——popover 行内提示消费）。 */
  error?: string
}

/**
 * 改声明画幅（design §5.2：宽/高 mm 直输 → declared）。校验：有限数、(0, 5000] mm；
 * 值域外拒绝（返回 ok:false，文档不变——不产半执行）。成功 = physicalCanvas 整组替换
 * （anchorSource='declared'）+ dirty；px 尺寸不变。
 */
export function setDeclaredCanvas(widthMm: number, heightMm: number): DeclareCanvasResult {
  const doc = getEditDoc()
  if (doc === null) return { ok: false, error: '编辑文档未载入' }
  const valid = (value: number): boolean =>
    Number.isFinite(value) && value > 0 && value <= MAX_CANVAS_MM
  if (!valid(widthMm) || !valid(heightMm)) {
    return { ok: false, error: `宽/高须为 (0, ${MAX_CANVAS_MM}] mm 的数值` }
  }
  doc.physicalCanvas = { widthMm, heightMm, anchorSource: 'declared' }
  markEditDirty()
  return { ok: true }
}
