/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 C-3.4 rename-and-expert-workbench；2026-09-21 迁移至 lib/designer] 属性面板
 *    字段描述符框架：{ key, label, 控件, 值读取器, 值写入器 } → 控件渲染（属性面板消费）；
 *    写入统一产出 update patch（EditGemFields），N 选批量 = 单 undo 组（调用方组）。
 * 2. [2026-09-21 redesign 2.x 扩展（design §7.4「properties.ts 字段注册表扩 layerId/规格字段」）]
 *    所属图层字段（layerId——只读展示：归属改写走 移入图层/合并 命令面归 4.x，
 *    buildFieldUpdatePatch 对 layer 控件恒 null——面板永不直写归属）。
 *    规格字段（shapeId/diameterMm/rotationDeg）沿用 D-5.1 注册。
 * 3. [2026-09-20 Pure] 纯 TS 零 runes/DOM——三态显示/混合值判定/patch 构造可直接 vitest。
 */

import { BUILTIN_SHAPES, type EditGem } from '$lib/engine'
import type { EditGemFields, UpdateChange } from '$lib/stores/edit.svelte'

/**
 * 字段读取面：engine EditGem + store 域 layerId（可选——纯函数对 engine 形钻安全，
 * DesignerGem 天然满足；layerId 缺席读空串）。
 */
export type PropertyGem = EditGem & { layerId?: string }

/** update patch 白名单键（EditGemFields——W0 后已含规格物化字段 + 1.x v3 layerId）。 */
export type PropertyFieldKey = keyof EditGemFields

/** 色板色字段（colorId——C 3.4 先行注册）。 */
export interface ColorPropertyField {
  key: 'colorId'
  control: 'color'
  label: string
  read(gem: PropertyGem): string
  write(value: string): EditGemFields
}

/** 数值字段（x/y + D-5.1 规格注册的 diameterMm/rotationDeg）。 */
export interface NumberPropertyField {
  key: 'x' | 'y' | 'diameterMm' | 'rotationDeg'
  control: 'number'
  label: string
  /** 数值输入步进（px 或 mm/deg） */
  step: number
  unit: string
  read(gem: PropertyGem): number
  write(value: number): EditGemFields
  /** 值域守卫（D-5.1：diameterMm>0 / rotationDeg∈[0,360)；缺省恒真）。非法值 → patch 构造返回 null。 */
  isValid?(value: number): boolean
}

/** 单选字段（shapeId——D-5.1 注册内置五形目录；custom 不在列，理由见头注 2）。 */
export interface SelectPropertyField {
  key: 'shapeId'
  control: 'select'
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  read(gem: PropertyGem): string
  write(value: string): EditGemFields
}

/** 所属图层字段（redesign 2.x——只读展示：归属批量改写走移入图层/合并命令面，4.x 落）。 */
export interface LayerPropertyField {
  key: 'layerId'
  control: 'layer'
  label: string
  read(gem: PropertyGem): string
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
  | LayerPropertyField
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

/** [D-5.1] 形状目录：内置五形（BUILTIN_SHAPES 中文名）；custom 不入列——assetId 不在
 *  EditGemFields 白名单，custom 钻形只经校准向导/资产路径产生（D-5.4 / 后续切片）。 */
const SHAPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = BUILTIN_SHAPES.map((s) => ({
  value: s.shapeId,
  label: s.nameZh,
}))

const shapeField: SelectPropertyField = {
  key: 'shapeId',
  control: 'select',
  label: '形状',
  options: SHAPE_OPTIONS,
  read: (gem) => gem.shapeId,
  write: (value) => ({ shapeId: value as EditGemFields['shapeId'] }),
}

const diameterField: NumberPropertyField = {
  key: 'diameterMm',
  control: 'number',
  label: '尺寸',
  step: 0.1,
  unit: 'mm',
  read: (gem) => gem.diameterMm,
  write: (value) => ({ diameterMm: value }),
  isValid: (value) => value > 0,
}

/** 朝向：圆钻缺省读 0（默认朝上）；写入 0 到「无 rotationDeg」的钻 = 无变更（保持圆钻恒缺省的
 *  序列化洁癖）；undo 对称性说明——「设 90 后撤销」回写 rotationDeg:0（非删除键），zod 域内合法。 */
const rotationField: NumberPropertyField = {
  key: 'rotationDeg',
  control: 'number',
  label: '朝向',
  step: 1,
  unit: '°',
  read: (gem) => gem.rotationDeg ?? 0,
  write: (value) => ({ rotationDeg: value }),
  isValid: (value) => value >= 0 && value < 360,
}

/** [redesign 2.x] 所属图层（只读——层名解析归面板消费 doc.layers；混合归属 → mixed 态）。 */
const layerField: LayerPropertyField = {
  key: 'layerId',
  control: 'layer',
  label: '所属图层',
  read: (gem) => gem.layerId ?? '',
}

/** 默认注册表（改色 + x/y + D-5.1 规格三字段 + redesign 2.x 所属图层——reserved 位退役）。 */
export const EDIT_PROPERTY_FIELDS: readonly EditPropertyField[] = [
  colorField,
  xField,
  yField,
  shapeField,
  diameterField,
  rotationField,
  layerField,
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
  selected: readonly PropertyGem[],
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
 * 值未变化的钻不入 changes（undo 只回退真实变更）；全未变（或空选/reserved/layer/值域外/
 * 选项外）→ null。
 */
export function buildFieldUpdatePatch(
  selected: readonly PropertyGem[],
  field: EditPropertyField,
  value: string | number,
): { op: 'update'; changes: UpdateChange[] } | null {
  if (field.control === 'reserved' || field.control === 'layer' || selected.length === 0) return null
  if (field.control === 'number') {
    const numeric = Number(value)
    // 值域守卫（D-5.1）：diameterMm>0 / rotationDeg∈[0,360)——非法输入不落 patch（不产脏文档）
    if (!Number.isFinite(numeric) || (field.isValid !== undefined && !field.isValid(numeric))) return null
    return buildChanges(selected, field, numeric, (v: number) => field.write(v))
  }
  const text = String(value)
  // 选项守卫：select 值必须 ∈ options（防任意 shapeId 注入）；color 控件沿用原直通语义
  if (field.control === 'select' && !field.options.some((opt) => opt.value === text)) return null
  return buildChanges(selected, field, text, (v: string) => field.write(v))
}

/** 可读写字段（reserved/layer 占位外的三控件——buildChanges 的参数面）。 */
export type WritablePropertyField = ColorPropertyField | NumberPropertyField | SelectPropertyField

function buildChanges<T extends string | number>(
  selected: readonly PropertyGem[],
  field: WritablePropertyField,
  value: T,
  writeValue: (v: T) => EditGemFields,
): { op: 'update'; changes: UpdateChange[] } | null {
  const changes: UpdateChange[] = []
  for (const gem of selected) {
    const before = field.read(gem)
    if (before === value) continue
    changes.push({ id: gem.id, before: writeValue(before as T), after: writeValue(value) })
  }
  return changes.length > 0 ? { op: 'update', changes } : null
}
