/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-21 redesign-designer-workbench 3.2] 规格选择器数据面（design §6.2）：目录
 *    数据源 = gemCatalogService（sys-shapes .gemshape 资产真源，零改动消费——listSpecs）；
 *    形×档×色 三元组（= BrushSpecState）写 brushSpec 真源经命令总线 apply-spec（禁第二实现）。
 * 2. [3.2] 批量改规格 changes 构造器（纯函数）：选中钻 → shapeId/diameterMm/colorId/assetId
 *    四键 before/after 对称 UpdateChange（custom⇄builtin 双向——assetId 随形同改，engine
 *    schema：custom 必带 / builtin 不得带）；单 undo 组由命令层 applyGemChanges 合组。
 * 3. [3.2] 最近使用规格（右键「改规格▸」子树数据源——design §2.2；会话态不上限持久化，
 *    去重首出，上限 6 条）。
 * 4. [3.2] 规格选择器开合态（右键「更多…」/ 命令总线 open-spec-selector 经 UI 钩子打开；
 *    组件与命令面共读共写单源）。
 * 5. [Test/Pure] 目录 service 注入面（setSpecCatalogForTests）+ resetSpecSelectorForTests
 *    复位；specCodeOf 规格码人读纯函数（R10/SQ35 形态——design §6.2 人读展示）。
 */

import { BUILTIN_SHAPES, customAssetIdMissing, isBuiltinShapeId, type ShapeId } from '$lib/engine'
import { gemCatalog, type CatalogSpec, type GemCatalogService } from '$lib/services/gemCatalogService'
import type { UpdateChange } from '$lib/stores/edit.svelte'
import type { BrushSpecState } from './workbench.svelte'

// ---------------------------------------------------------------------------
// 目录数据（gemCatalogService 零改动消费）
// ---------------------------------------------------------------------------

/** 目录 service（生产单例；测试注入替身）。 */
let catalogService: GemCatalogService = gemCatalog

/** 测试注入（null 复位生产单例；缓存目录一并清空）。 */
export function setSpecCatalogForTests(service: GemCatalogService | null): void {
  catalogService = service ?? gemCatalog
  catalogSpecs = []
  catalogStatus = 'idle'
}

export type SpecCatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

let catalogSpecs = $state<CatalogSpec[]>([])
let catalogStatus = $state<SpecCatalogStatus>('idle')

export function getSpecCatalog(): CatalogSpec[] {
  return catalogSpecs
}

export function getSpecCatalogStatus(): SpecCatalogStatus {
  return catalogStatus
}

/** 拉取目录（幂等触发；每次重读——校准入库新自定义形后重拉可见）。失败置 error 不抛（空目录态）。 */
export async function loadSpecCatalog(): Promise<void> {
  catalogStatus = catalogStatus === 'idle' ? 'loading' : catalogStatus
  try {
    catalogSpecs = await catalogService.listSpecs()
    catalogStatus = 'ready'
  } catch {
    catalogSpecs = []
    catalogStatus = 'error'
  }
}

/** 目录按形分组（UI 数据整形——内置形按声明序、档位按目录序；custom 条目各自成档）。 */
export interface ShapeGroup {
  /** 内置形 id 或 'custom'（custom 组成员各为独立档位）。 */
  shapeId: string
  /** 形显示名（内置形中文名；custom 组名「自定义」）。 */
  label: string
  /** 该形可选档位（custom 条目带 assetId/资产名）。 */
  sizes: CatalogSpec[]
}

export function groupSpecCatalog(specs: readonly CatalogSpec[]): ShapeGroup[] {
  const groups: ShapeGroup[] = []
  for (const meta of BUILTIN_SHAPES) {
    const sizes = specs.filter((s) => s.shapeId === meta.shapeId)
    if (sizes.length > 0) groups.push({ shapeId: meta.shapeId, label: meta.nameZh, sizes })
  }
  const customs = specs.filter((s) => s.shapeId === 'custom')
  if (customs.length > 0) groups.push({ shapeId: 'custom', label: '自定义', sizes: customs })
  return groups
}

// ---------------------------------------------------------------------------
// 规格码人读（R10 / SQ35 / 自定义资产名——design §6.2）
// ---------------------------------------------------------------------------

/** 规格码纯函数：内置形 = 短码 + 尺寸 token（SS10→10、3.5mm→35）；custom = sizeLabel（资产名）。 */
export function specCodeOf(entry: { shapeId: string; sizeLabel: string }): string {
  if (entry.shapeId === 'custom') return entry.sizeLabel
  const meta = BUILTIN_SHAPES.find((s) => s.shapeId === entry.shapeId)
  const token = entry.sizeLabel.replace(/[^\d.]/g, '').replace('.', '')
  if (meta === undefined || token === '') return entry.sizeLabel
  return `${meta.shortCode}${token}`
}

// ---------------------------------------------------------------------------
// 批量改规格 changes 构造器（纯函数——custom⇄builtin 四键对称）
// ---------------------------------------------------------------------------

/**
 * 规格字段四键对称比较（assetId 归一 undefined——键缺席与 undefined 同值）。
 * 全等 = 该钻无需改写（不入 changes——undo 只回退真实变更）。
 */
function specEquals(
  gem: { shapeId: string; diameterMm: number; colorId: string; assetId?: string },
  spec: BrushSpecState,
): boolean {
  return (
    gem.shapeId === spec.shapeId &&
    gem.diameterMm === spec.diameterMm &&
    gem.colorId === spec.colorId &&
    (gem.assetId ?? undefined) === (spec.assetId ?? undefined)
  )
}

/**
 * 批量改规格 changes（design §6.2「选中钻时 = 改选中钻规格」）：逐钻四键
 * {shapeId, diameterMm, colorId, assetId} before/after 对称记录（assetId 随形同改——
 * custom 写入引用 / builtin 写 undefined 清除键，序列化层缺席不落键）；全等钻不入。
 * 非法规格（custom 缺 assetId / builtin 带 assetId）抛 BrushSpecShapeError 同判据（调用方守卫）。
 */
export function buildSpecChanges(
  gems: ReadonlyArray<{ id: string; shapeId: ShapeId; diameterMm: number; colorId: string; assetId?: string }>,
  spec: BrushSpecState,
): UpdateChange[] {
  if (customAssetIdMissing(spec)) throw new Error('custom 规格必带 assetId（buildSpecChanges 守卫）')
  if (isBuiltinShapeId(spec.shapeId) && spec.assetId !== undefined) {
    throw new Error('builtin 规格不得携带 assetId（buildSpecChanges 守卫）')
  }
  const after = {
    shapeId: spec.shapeId,
    diameterMm: spec.diameterMm,
    colorId: spec.colorId,
    ...(spec.shapeId === 'custom' ? { assetId: spec.assetId } : { assetId: undefined }),
  }
  const changes: UpdateChange[] = []
  for (const gem of gems) {
    if (specEquals(gem, spec)) continue
    changes.push({
      id: gem.id,
      before: {
        shapeId: gem.shapeId,
        diameterMm: gem.diameterMm,
        colorId: gem.colorId,
        ...(gem.assetId !== undefined ? { assetId: gem.assetId } : { assetId: undefined }),
      },
      after,
    })
  }
  return changes
}

// ---------------------------------------------------------------------------
// 最近使用规格（右键「改规格▸」数据源——design §2.2）
// ---------------------------------------------------------------------------

export interface RecentSpec {
  spec: BrushSpecState
  /** 人读标签（规格码——菜单显示） */
  label: string
}

/** 最近使用上限（超出裁最旧）。 */
export const MAX_RECENT_SPECS = 6

let recentSpecs = $state<RecentSpec[]>([])

export function getRecentSpecs(): RecentSpec[] {
  return recentSpecs
}

/** 记录最近使用（身份键去重首出；上限裁最旧）。apply-spec 命令成功后调用（单写入口）。 */
export function pushRecentSpec(spec: BrushSpecState, label: string): void {
  const key = recentKeyOf(spec)
  const next = [{ spec: { ...spec }, label }, ...recentSpecs.filter((r) => recentKeyOf(r.spec) !== key)]
  recentSpecs = next.slice(0, MAX_RECENT_SPECS)
}

function recentKeyOf(spec: BrushSpecState): string {
  return `${spec.shapeId}|${spec.diameterMm}|${spec.colorId}|${spec.assetId ?? ''}`
}

// ---------------------------------------------------------------------------
// 规格选择器开合态（组件触发钮与命令总线 open-spec-selector 共用单源）
// ---------------------------------------------------------------------------

let selectorOpen = $state(false)

export function getSpecSelectorOpen(): boolean {
  return selectorOpen
}

export function setSpecSelectorOpen(open: boolean): void {
  selectorOpen = open
}

// ---------------------------------------------------------------------------
// 测试复位
// ---------------------------------------------------------------------------

/** 测试专用：整体复位（目录/状态/最近/开合态全清）。 */
export function resetSpecSelectorForTests(): void {
  catalogSpecs = []
  catalogStatus = 'idle'
  recentSpecs = []
  selectorOpen = false
}
