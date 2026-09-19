/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.4 rename-and-expert-workbench] 属性面板字段描述符框架：
 *    { key, label, 控件, 值读取器, 值写入器 } → 控件渲染（EditPropertiesPanel 消费）；
 *    写入统一产出 update patch（EditGemFields），N 选批量 = 单 undo 组（调用方组）。
 *    形状/尺寸/朝向控件位预留不注册（5.1 接 W0 后扩展——框架类型面已覆盖
 *    shapeId/diameterMm/rotationDeg，注册时零框架改动）。
 * 2. [2026-09-20 Pure] 纯 TS 零 runes/DOM——三态显示/混合值判定/patch 构造可直接 vitest。
 */

import type { EditGem } from '$lib/engine'
import type { EditGemFields, UpdateChange } from '$lib/stores/edit.svelte'

/** update patch 白名单键（EditGemFields——W0 后已含规格物化字段）。 */
export type PropertyFieldKey = keyof EditGemFields

/** 色板色字段（colorId——C 3.4 先行注册）。 */
export interface ColorPropertyField {
  key: 'colorId'
  control: 'color'
  label: string
  read(gem: EditGem): string
  write(value: string): EditGemFields
}

/** 数值字段（x/y 先行注册；diameterMm/rotationDeg 类型面已备，注册归 5.1）。 */
export interface NumberPropertyField {
  key: 'x' | 'y' | 'diameterMm' | 'rotationDeg'
  control: 'number'
  label: string
  /** 数值输入步进（px 或 mm/deg） */
  step: number
  unit: string
  read(gem: EditGem): number
  write(value: number): EditGemFields
}

/** 单选字段（shapeId——5.1 注册形目录时启用）。 */
export interface SelectPropertyField {
  key: 'shapeId'
  control: 'select'
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  read(gem: EditGem): string
  write(value: string): EditGemFields
}

/** 控件位预留（不注册控件——渲染为禁用占位行）。 */
export interface ReservedPropertyField {
  key: PropertyFieldKey
  control: 'reserved'
  label: string
  note: string
}

export type EditPropertyField =
  | ColorPropertyField
  | NumberPropertyField
  | SelectPropertyField
  | ReservedPropertyField

const xField: NumberPropertyField = {
  key: 'x',
  control: 'number',
  label: 'X',
  step: 1,
  unit: 'px',
  read: (gem) => gem.x,
  write: (value) => ({ x: value }),
}

const yField: NumberPropertyField = {
  key: 'y',
  control: 'number',
  label: 'Y',
  step: 1,
  unit: 'px',
  read: (gem) => gem.y,
  write: (value) => ({ y: value }),
}

const colorField: ColorPropertyField = {
  key: 'colorId',
  control: 'color',
  label: '颜色',
  read: (gem) => gem.colorId,
  write: (value) => ({ colorId: value }),
}

/** 规格字段位预留（5.1 注册——控件不注册，避免 W0 前的假值/假选项）。 */
const reservedShape: ReservedPropertyField = {
  key: 'shapeId',
  control: 'reserved',
  label: '形状',
  note: '规格控件待规格目录接线后注册',
}

const reservedDiameter: ReservedPropertyField = {
  key: 'diameterMm',
  control: 'reserved',
  label: '尺寸',
  note: '规格控件待规格目录接线后注册',
}

const reservedRotation: ReservedPropertyField = {
  key: 'rotationDeg',
  control: 'reserved',
  label: '朝向',
  note: '规格控件待规格目录接线后注册',
}

/** 默认注册表（改色先行 + x/y；规格三字段位预留）。 */
export const EDIT_PROPERTY_FIELDS: readonly EditPropertyField[] = [
  colorField,
  xField,
  yField,
  reservedShape,
  reservedDiameter,
  reservedRotation,
]

export type PropertyFieldViewState = 'uniform' | 'mixed' | 'reserved'

export interface PropertyFieldView {
  field: EditPropertyField
  state: PropertyFieldViewState
  /** uniform 态的显示值（mixed/reserved 为 null——面板渲染「—」/占位） */
  value: string | number | null
}

/** 三态字段视图（空选不产出字段——面板自渲染空态引导）。 */
export function computePropertyViews(
  selected: readonly EditGem[],
  fields: readonly EditPropertyField[] = EDIT_PROPERTY_FIELDS,
): PropertyFieldView[] {
  if (selected.length === 0) return []
  const out: PropertyFieldView[] = []
  for (const field of fields) {
    if (field.control === 'reserved') {
      out.push({ field, state: 'reserved', value: null })
      continue
    }
    const first = field.read(selected[0])
    let uniform = true
    for (let i = 1; i < selected.length; i++) {
      if (field.read(selected[i]) !== first) {
        uniform = false
        break
      }
    }
    out.push({ field, state: uniform ? 'uniform' : 'mixed', value: uniform ? first : null })
  }
  return out
}

export function isFieldViewUniform(view: PropertyFieldView): boolean {
  return view.state === 'uniform'
}

/**
 * 批量写入 patch：N 选 → 一条 update patch（调用方以 beginStroke/endStroke 包成单 undo 组）。
 * 值未变化的钻不入 changes（undo 只回退真实变更）；全未变（或空选/reserved）→ null。
 */
export function buildFieldUpdatePatch(
  selected: readonly EditGem[],
  field: EditPropertyField,
  value: string | number,
): { op: 'update'; changes: UpdateChange[] } | null {
  if (field.control === 'reserved' || selected.length === 0) return null
  const writeValue = (v: string | number): EditGemFields =>
    field.control === 'number' ? field.write(Number(v)) : field.write(String(v))
  const changes: UpdateChange[] = []
  for (const gem of selected) {
    const before = field.read(gem)
    if (before === value) continue
    changes.push({ id: gem.id, before: writeValue(before), after: writeValue(value) })
  }
  return changes.length > 0 ? { op: 'update', changes } : null
}
