/**
 * 钻表选择器数据源端口（add-stone-library design §5——S5.1/S5.2）。
 * 原始需求 2026-09-24（tasks.md S5）：前台选择器=纯组件库，数据面经本端口注入
 * （测试 mock / P3.2 接线 rpcSource）；选中产出=StonePick 契约（不内嵌贴图数据）。
 *
 * 协议判定（S5.2 nearColor 最终判定，2026-09-24 实查）：
 * - daemon RPC 面 `stones.list`（rpc.ts StonesListInputSchema，8bc042c）**无 nearColor**；
 *   nearColor 仅在 MCP capability 面（capability/stones.ts stones.list/search）。
 * - 故本端口把 nearColor 声明为协议位（语义沿 capability：结果按 ΔE(CIE76) 升序），
 *   默认 rpcSource 现阶段以**客户端 ΔE 排序回退**实现（contracts deltaE76 同源），
 *   组件层标注「P3.2 接线时启用服务端排序」——mock 协议先行。
 * - `stones.substitutes` 的完整 readonly capability 语义（colorRgb+sizeMm 容差过滤+
 *   加权排序，SubstituteQuery 契约）属缺钻替代场景，daemon 现仅 MCP 面提供——
 *   组件层同标注「P3.2 接线时启用」，不在本端口伪造。
 *
 * 组合投影接口位（design §7.5）：`activeSetId` 进查询协议——活跃组合选定后数据源
 * 切换为组合成员解析投影（set RPC 端点由修复代理并行补齐）；rpcSource 现阶段忽略
 * 该参（不实现组合解析），UI 显式标注投影模式。
 *
 * 正交意图：
 *   [1] 查询/结果协议形状（对齐 RPC 面 stones.tree/list/get 的 list/get 两端点）。
 *   [2] nearColor 协议位 + ΔE 纯函数（hex↔rgb、ΔE 排序——客户端回退与测试共用）。
 *   [3] groupBy 键解析（'row-51'/'未编行'——RPC groupKeys 格式的唯一解析点）。
 */
import { deltaE76, labFromRgb, type RgbTuple, type StoneGridCell } from '@handicraft/contracts'

// ---------------------------------------------------------------- [1] 协议形状

/** list 查询（对齐 rpc.ts StonesListInputSchema + 两个协议位扩展）。 */
export interface StoneListQuery {
  supplier?: string
  family?: string
  sizeMm?: number
  styleRow?: number
  sku?: string
  /** 关键字（SKU/供应商/色系/款式名/十六进制子串——小写包含匹配，服务端口径）。 */
  q?: string
  groupBy?: 'family' | 'sizeMm' | 'style'
  page: number
  pageSize: number
  includeTrashed?: boolean
  /**
   * ΔE 邻近推荐协议位（S5.2）：目标色 RGB——在场时结果 cells 须按 ΔE(CIE76) 升序。
   * RPC 面暂无此参：rpcSource 以客户端排序回退（当前页内），P3.2 接线时换服务端。
   */
  nearColor?: RgbTuple
  /**
   * 活跃组合过滤投影位（design §7.5）：非空时数据源切换为组合成员解析投影。
   * set RPC 端点补齐前 rpcSource 忽略该参（UI 标注投影模式）——不实现组合解析。
   */
  activeSetId?: string
}

/** list 结果（对齐 daemon stones/query.ts StoneListResult + readScope 守门）。 */
export interface StoneListResult {
  cells: StoneGridCell[]
  total: number
  page: number
  pageSize: number
  /** groupBy 在场时的全过滤集键投影（非当前页）。 */
  groupKeys?: string[]
}

/** 引用解析四态（对齐 StoneService.resolveStoneRef——S1.4 引用保护语义）。 */
export type StoneRefState = 'resolved' | 'soft-deleted' | 'blob-missing' | 'wrong-kind' | 'not-found'

/** get 结果的选择器窄投影（选择器只消费引用态+gemshapeRef 富集；全文归管理视图）。 */
export interface StoneGetOutcome {
  resourceId: string
  state: StoneRefState
  /** stone.json 携带 gemshapeRef 时回填（StonePick 可选字段富集源）。 */
  gemshapeRef?: string
}

/**
 * 钻表选择器数据源端口：list（排板/搜索/推荐）+ get（选中富集/四态标注）+
 * resolveTextureUrl（贴图相对路径→可请求 URL——/api/stones/{id}/texture.png 协议对偶）。
 */
export interface StonePickerSource {
  list(query: StoneListQuery): Promise<StoneListResult>
  get(resourceId: string): Promise<StoneGetOutcome>
  resolveTextureUrl(textureUrl: string): string
}

// ---------------------------------------------------------------- [2] ΔE 纯函数

const HEX_RE = /^#([0-9a-fA-F]{6})$/

/** '#FFFFF0' → [255,255,240]（契约 StoneGridCell.colorHex 大写六位同族输入；非法输入 null）。 */
export function hexToRgb(hex: string): RgbTuple | null {
  const match = HEX_RE.exec(hex.trim())
  if (match === null) return null
  const n = Number.parseInt(match[1] as string, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** ΔE(CIE76)（目标色 vs 单元格 colorHex）——contracts 镜像纯函数，双端同源。 */
export function deltaEOfCell(target: RgbTuple, cell: StoneGridCell): number {
  const lab = labFromRgb(target[0], target[1], target[2])
  const rgb = hexToRgb(cell.colorHex)
  if (rgb === null) return Number.POSITIVE_INFINITY
  return deltaE76(lab, labFromRgb(rgb[0], rgb[1], rgb[2]))
}

/**
 * nearColor 客户端回退排序：cells 按 ΔE 升序（平局用 supplier×sku 稳定序——
 * 与 capability/stones.ts stones.search 的 tie 规则同式）。不修改入参数组。
 */
export function sortCellsByNearColor(cells: readonly StoneGridCell[], nearColor: RgbTuple): StoneGridCell[] {
  return [...cells].sort((a, b) => {
    const da = deltaEOfCell(nearColor, a)
    const db = deltaEOfCell(nearColor, b)
    if (da !== db) return da - db
    return a.supplier === b.supplier ? a.sku.localeCompare(b.sku) : a.supplier.localeCompare(b.supplier)
  })
}

// ---------------------------------------------------------------- [3] groupBy 键解析

/**
 * groupBy='style' 键 → 款式行号（'row-51'→51；'未编行'→null）。
 * 键格式冻结自 daemon stones/query.ts groupKeysOf（`row-${row}` / '未编行'）——
 * 本函数是前端唯一解析点，格式漂移在此收敛。
 */
export function styleRowFromGroupKey(key: string): number | null {
  if (key === '未编行') return null
  const match = /^row-(\d+)$/.exec(key)
  return match === null ? null : Number.parseInt(match[1] as string, 10)
}

/** groupBy='sizeMm' 键 → 毫米档（'2'→2；'未声明'→null——§8.1 规则 7 显式态）。 */
export function sizeMmFromGroupKey(key: string): number | null {
  if (key === '未声明') return null
  const n = Number(key)
  return Number.isFinite(n) && n > 0 ? n : null
}
