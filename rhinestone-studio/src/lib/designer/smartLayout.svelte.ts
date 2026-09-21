/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-21 redesign-designer-workbench 7.2] 智能排布落点态：面板开合（顶栏「智能排布…」
 *    按钮 / 右键空态「智能排布…」/ 命令总线 open-smart-layout 三入口同源单真源）。
 * 2. [7.2 可用性单源] smartLayoutUnderlayReady：无参考底图禁用（design §5.3「工具输入=底图」
 *    ——underlay.sources 含 painting 或 reference 源即可用；空白起步两源皆无 = 禁用 + tooltip
 *    「需要参考底图」）。DocBar 按钮/右键菜单项/命令门槛统一消费，禁第二实现。
 * 3. [7.2 执行链] runSmartLayout：underlay 图解析（reference 资产优先 / painting PNG 兜底）→
 *    quickLayout 钻数组产物模式（smartLayoutGemsFromImage——计算内核/冻结参数/进度取消
 *    复用零改动）→ 与既有钻 pairwise 冲突过滤（requiredCenterDistancePx×0.999 同 brush 判据）
 *    → 落当前层单 undo 组（design §5.3：origin='manual'、m- 自增 id、layerId=当前层）；
 *    冲突钻丢弃计数上浮（显式报数不静默）。underlayImageBlobOf/pairwise 冲突判定为纯函数
 *    （可测决策核）。
 * 4. [Test] resetSmartLayoutForTests 复位。
 */

import {
  effectiveSpecOf,
  maxCellPx,
  requiredCenterDistancePx,
  type BaseSpec,
  type EditGem,
  type GridSpec,
  type Palette,
} from '$lib/engine'
import { smartLayoutGemsFromImage, type SmartLayoutSpecParams } from '$lib/edit/quickLayout'
import { getHandoffImageBlob } from '$lib/persistence/handoffImage'
import { paintingToDataUrl } from '$lib/persistence/projectFile'
import { SpatialIndex } from '$lib/edit/spatialIndex'
import {
  applyPatch,
  getEditDoc,
  nextManualId,
  type DesignerGem,
  type EditDocument,
} from '$lib/stores/edit.svelte'
import { currentLayerIdOf } from './workbench.svelte'

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
// [7.2 执行链] underlay 图解析 → 钻数组产物 → 冲突过滤 → 落当前层单 undo 组
// ---------------------------------------------------------------------------

/** runSmartLayout 的参数 = 参数小窗四参（strategy/spec/gap/density；px/mm 由执行链接目标文档）。 */
export type SmartLayoutRunParams = Omit<SmartLayoutSpecParams, 'pixelsPerMm'>

/** runSmartLayout 的进度/取消面（直通 quickLayout——AbortSignal 取消在途轮）。 */
export interface SmartLayoutRunOptions {
  onProgress?: (progress: { label: string }) => void
  signal?: AbortSignal
}

/** 执行结果（结果行报数数据源——design §5.3「并入 N 颗，跳过 M 颗冲突」显式不静默）。 */
export interface SmartLayoutRunResult {
  /** 并入当前层的钻数。 */
  added: number
  /** 与既有钻（含本批已并入）间距冲突被丢弃的钻数。 */
  dropped: number
  /** 结果钻来源摘要（策略·密度·规格·计数——quickLayout 单源）。 */
  sourceSummary: string
}

/**
 * underlay 底图 blob 解析（纯编排）：reference 源优先（原图资产字节——与选图起步/
 * quickLayout 解码链同源），缺席时 painting 源 PNG 编码兜底（paintingToDataUrl 唯一
 * 编码出口 → base64 → Blob）。两源皆无 = 显式失败（调用方门槛 smartLayoutUnderlayReady）。
 */
export async function underlayImageBlobOf(doc: EditDocument): Promise<Blob> {
  if (doc.referenceAssetId !== null) {
    return getHandoffImageBlob(doc.referenceAssetId)
  }
  const dataUrl = paintingToDataUrl(doc.paintingSnapshot)
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}

/** pairwise 冲突容差（×0.999——brushEngine/validateEditable 同口径相对容差）。 */
const PAIRWISE_TOLERANCE = 0.999

/**
 * 冲突过滤（纯函数决策核——design §5.3「与既有钻间距冲突的结果钻丢弃」）：
 * 候选逐颗对（索引中的既有钻 + 本批已保留钻）判 pairwise 判距（requiredCenterDistancePx
 * ×0.999 同 brush 拒画判据）；未过者丢弃。返回保留/丢弃划分与物化好的新钻
 * （id 走 nextManualId 重写——产物 g##### 命名空间与既有来源钻同段，必须重写防碰撞；
 * 归属目标层 layerId）。
 */
export function filterSmartLayoutGems(
  existing: readonly DesignerGem[],
  candidates: readonly EditGem[],
  grid: GridSpec,
  targetLayerId: string,
): { kept: DesignerGem[]; dropped: number } {
  let maxDiameter = 0
  for (const gem of existing) maxDiameter = Math.max(maxDiameter, gem.diameterMm)
  for (const gem of candidates) maxDiameter = Math.max(maxDiameter, gem.diameterMm)
  const index = new SpatialIndex<DesignerGem>(maxCellPx([{ diameterMm: maxDiameter }], grid))
  for (const gem of existing) index.insert(gem)
  const queryRadius = ((maxDiameter + maxDiameter) / 2 + grid.gapMm) * grid.pixelsPerMm
  const kept: DesignerGem[] = []
  let dropped = 0
  for (const candidate of candidates) {
    const spec = { diameterMm: candidate.diameterMm }
    let conflict = false
    for (const other of index.queryCircle(candidate.x, candidate.y, queryRadius)) {
      const need = requiredCenterDistancePx(spec, effectiveSpecOf(other, grid), grid) * PAIRWISE_TOLERANCE
      const dx = other.x - candidate.x
      const dy = other.y - candidate.y
      if (dx * dx + dy * dy < need * need) {
        conflict = true
        break
      }
    }
    if (conflict) {
      dropped += 1
      continue
    }
    const gem: DesignerGem = { ...candidate, id: nextManualId(), layerId: targetLayerId }
    index.insert(gem) // 本批已保留钻入索引——批内冲突同判（不产自相矛盾的产物）
    kept.push(gem)
  }
  return { kept, dropped }
}

/**
 * 执行智能排布（design §5.3 执行链）：underlay 底图 → smartLayoutGemsFromImage（计算内核
 * 复用 + 目标文档 px/mm 锚 + 文档色板映射）→ 冲突过滤 → 落**当前图层**单 undo 组
 * （一个 add patch = 一次撤销整体恢复；MAX_STROKE_GEMS 巨型批防护由 store 既有门承载，
 * 超限错误原样上浮由面板显式呈现）。文档缺席/无底图 = 显式失败。
 */
export async function runSmartLayout(
  params: SmartLayoutRunParams,
  options: SmartLayoutRunOptions = {},
): Promise<SmartLayoutRunResult> {
  const doc = getEditDoc()
  if (doc === null) throw new Error('编辑文档未载入，无法智能排布。')
  if (!smartLayoutUnderlayReady(doc)) throw new Error('需要参考底图后才能智能排布。')
  const layerId = currentLayerIdOf(doc)
  if (layerId === null) throw new Error('当前文档无钻石层可承接智能排布结果。')

  const blob = await underlayImageBlobOf(doc)
  const palette: Palette = doc.palette.map((c) => ({ ...c }))
  const { gems, sourceSummary } = await smartLayoutGemsFromImage(
    blob,
    palette,
    { ...params, pixelsPerMm: doc.grid.pixelsPerMm },
    { signal: options.signal, onProgress: options.onProgress },
  )

  // 计算在途后重读文档（doc 可能已被关闭/替换——落点取活文档）
  const live = getEditDoc()
  if (live === null) throw new Error('文档已关闭，智能排布结果未并入。')
  const { kept, dropped } = filterSmartLayoutGems(live.gems, gems, live.grid, layerId)
  if (kept.length > 0) {
    const result = applyPatch({ op: 'add', gems: kept })
    if (!result.ok) throw new Error(result.error) // 巨型批等 store 门拒绝——面板显式报错
  }
  return { added: kept.length, dropped, sourceSummary }
}

/** 基础规格（参数小窗数据面——目录档 BaseSpec 视图）。 */
export type { BaseSpec }

// ---------------------------------------------------------------------------
// 测试复位
// ---------------------------------------------------------------------------

/** 测试专用：整体复位（开合态清零；执行链态随 7.2 扩展同函数收口）。 */
export function resetSmartLayoutForTests(): void {
  smartLayoutOpen = false
}
