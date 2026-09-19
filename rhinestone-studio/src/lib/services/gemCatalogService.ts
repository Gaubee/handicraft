/**
 * 钻目录 service（rename-and-expert-workbench S-4.1；design §4.2）。
 *
 * 定位：service = 无 UI 依赖的用例编排层；规格选择器（add-lab 4.2）/ 校准向导（5.4）/
 * 笔刷当前 spec（5.5）一律只依赖本接口，不依赖实现。
 *
 * 真源分层（design §0.4 入库口径；[add-lab 4.2] 切换已执行）：
 * - 目录真源 = 素材库 sys-shapes `.gemshape` 资产（含内置形 seed + 用户自定义同域统一）——
 *   `createLibraryGemCatalogService`（生产实现，`gemCatalog` 单例）；
 * - 内存 mock（ROUND_SS_BOOTSTRAP 派生 round × SS 档）按议题 2 裁决**退役为 vitest 夹具**
 *   （src/tests/services/gemCatalog.test.ts），生产代码不再消费（不保留双实现并存）。
 *
 * specKey 确定性规则与 W0 一致：'round-ssXX'（engine spec.ts roundSpecKeyOfSs /
 * ROUND_SS_BOOTSTRAP 同源派生）；自定义 'custom-<assetId>'（ingest/fork 落库时物化进文件字节）。
 */

import { BUILTIN_SHAPES, ROUND_SS_BOOTSTRAP, customSpecKey, ssOfRoundSpecKey } from '$lib/engine'
import {
  gemshapeNodeIdOfSpecKey,
  getProject,
  listChildNodes,
  SYS_SHAPES_FOLDER_ID,
  type AssetNode,
} from '$lib/persistence/assetStore'
import type { AssetProject } from '$lib/persistence/projectTypes'
import { parseGemshape, type GemshapeFile } from '$lib/persistence/gemshapeFile'
import { getImageBlob } from '$lib/persistence/imageStore'

/** 目录条目结构（W0 后对齐 GemSpecSnapshot——赋值兼容超集；身份唯一持久字段 = specKey）。 */
export interface CatalogSpec {
  /** canonical 身份键（'round-ss10' / 'custom-<assetId>'——确定性生成规则与 W0 specKey 一致） */
  specKey: string
  /** 五内置形 id 或 'custom'（由 specKey 前缀正向派生——身份即前缀结构） */
  shapeId: string
  /** 人读尺寸标签（'SS10' / '3.5mm' / 自定义=资产名——不参与身份） */
  sizeLabel: string
  /** 名义直径 mm（= max(physical.widthMm, heightMm)——.gemshape 物理声明） */
  diameterMm: number
  /** [4.2 真源对齐] 物理宽高（mm——异形/自定义附宽；run 时物化进 GemSpecSnapshot）。 */
  widthMm?: number
  heightMm?: number
  /** [4.2 真源对齐] shapeId='custom' 时的 .gemshape 资产 id（GemSpecSnapshot.assetId 同约束：
   *  仅 custom 允许携带）。 */
  assetId?: string
}

/** 钻目录 service 接口（消费方只依赖本面；签名冻结——[add-lab 4.2 执行 5.6 真源切换点]
 *  真源切换（sys-shapes .gemshape 资产）接口签名不变。） */
export interface GemCatalogService {
  /** 全量规格清单（sys-shapes 目录序 = seed 声明序，自定义资产按入库序续后）。 */
  listSpecs(): Promise<CatalogSpec[]>
  /** 按 specKey 解析；未知/软删/字节缺失/parse 失败 → undefined（missing 语义，消费方 fail-fast）。 */
  resolveSpec(specKey: string): Promise<CatalogSpec | undefined>
}

// ---------------------------------------------------------------------------
// 内存 mock（W0 前默认实现——[add-lab 4.2] 退役为 vitest 夹具，生产不消费）
// ---------------------------------------------------------------------------

/**
 * 内存 mock（vitest 夹具）：round × SS_KEYS 档自 ROUND_SS_BOOTSTRAP 派生。
 * 确定性/幂等：每次调用返回等值新数组（无内部可变态，调用方持有安全）。
 */
export function createInMemoryGemCatalogService(): GemCatalogService {
  const specs: readonly CatalogSpec[] = Object.freeze(
    ROUND_SS_BOOTSTRAP.map((row) => ({
      specKey: row.specKey,
      shapeId: 'round',
      sizeLabel: row.ss,
      diameterMm: row.diameterMm,
    })),
  )
  const byKey = new Map(specs.map((s) => [s.specKey, s]))
  return {
    async listSpecs(): Promise<CatalogSpec[]> {
      return specs.map((s) => ({ ...s }))
    },
    async resolveSpec(specKey: string): Promise<CatalogSpec | undefined> {
      const found = byKey.get(specKey)
      return found === undefined ? undefined : { ...found }
    },
  }
}

// ---------------------------------------------------------------------------
// 素材库真源实现（[add-lab 4.2] sys-shapes .gemshape 资产 hydrate）
// ---------------------------------------------------------------------------

/** specKey → shapeId（正向派生：内置形 specKey 恒 `${shapeId}-` 前缀；其余 = custom）。 */
function shapeIdOfSpecKey(specKey: string): string {
  for (const { shapeId } of BUILTIN_SHAPES) {
    if (specKey.startsWith(`${shapeId}-`)) return shapeId
  }
  return 'custom'
}

/** specKey → 人读尺寸标签：round SS 档反查 SS 表；其余内置形取尺寸 token（'3.5' → '3.5mm'）；custom = 资产名。 */
function sizeLabelOfSpecKey(specKey: string, shapeId: string, fallbackName: string): string {
  if (shapeId === 'round') {
    const ss = ssOfRoundSpecKey(specKey)
    if (ss !== null) return ss
  }
  if (shapeId !== 'custom') {
    const token = specKey.slice(shapeId.length + 1)
    return token !== '' ? `${token}mm` : fallbackName
  }
  return fallbackName
}

/** .gemshape 节点 → 目录条目（parse 失败/软删/字节缺失 → null = missing，不静默降级）。 */
async function catalogEntryOfNode(nodeId: string): Promise<CatalogSpec | null> {
  let node: AssetProject | null
  try {
    node = await getProject(nodeId)
  } catch {
    return null
  }
  if (node === null || node.type !== 'project' || node.projectKind !== 'gemshape') return null
  if (node.trashedAt !== undefined) return null
  let file: GemshapeFile
  try {
    const blob = await getImageBlob(node.blobKey)
    if (blob === null) return null
    file = parseGemshape(await blob.text(), { mime: node.mime })
  } catch {
    return null
  }
  const specKey = file.specKey ?? customSpecKey(nodeId)
  const shapeId = shapeIdOfSpecKey(specKey)
  return {
    specKey,
    shapeId,
    sizeLabel: sizeLabelOfSpecKey(specKey, shapeId, file.name),
    diameterMm: Math.max(file.physical.widthMm, file.physical.heightMm),
    widthMm: file.physical.widthMm,
    heightMm: file.physical.heightMm,
    ...(shapeId === 'custom' ? { assetId: nodeId } : {}),
  }
}

/**
 * 素材库真源实现（sys-shapes hydrate；签名与 mock 等价——每次调用重读重解析，无内部缓存态）：
 * - listSpecs = sys-shapes 未软删 gemshape 节点按目录序逐个 hydrate（坏节点跳过不阻断清单）；
 * - resolveSpec = gemshapeNodeIdOfSpecKey 反解节点（seed `ast-shape-<specKey>` /
 *   custom-<assetId> → 资产本体），任何四态缺失（wrong-kind/软删/blob 缺失/parse 失败）→
 *   undefined——missing fail-fast 判据归消费方（发起阻断/编辑器警告角标）。
 */
export function createLibraryGemCatalogService(): GemCatalogService {
  return {
    async listSpecs(): Promise<CatalogSpec[]> {
      let nodes: AssetNode[]
      try {
        nodes = await listChildNodes(SYS_SHAPES_FOLDER_ID)
      } catch {
        return [] // IDB 不可用：空目录（选择器空态；不抛——目录消费是展示面）
      }
      const out: CatalogSpec[] = []
      for (const node of nodes) {
        if ((node as { trashedAt?: number }).trashedAt !== undefined) continue
        if (node.type !== 'project' || node.projectKind !== 'gemshape') continue
        const entry = await catalogEntryOfNode(node.id)
        if (entry !== null) out.push(entry)
      }
      return out
    },
    async resolveSpec(specKey: string): Promise<CatalogSpec | undefined> {
      if (!specKey.trim()) return undefined
      const entry = await catalogEntryOfNode(gemshapeNodeIdOfSpecKey(specKey))
      // 节点在库但文件 specKey 与查询键不符（旧档/手改字节）= 身份失配 → missing（不挂错条目）
      return entry !== null && entry.specKey === specKey ? entry : undefined
    },
  }
}

/** 生产单例（目录真源 = sys-shapes；无内部可变态，模块级共享实例零漂移）。 */
export const gemCatalog: GemCatalogService = createLibraryGemCatalogService()
