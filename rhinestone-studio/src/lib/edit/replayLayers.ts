/*
 * gemproj replay 层模型内核（studio-layers 1.2，纯函数 jsdom 可测——图层稿 §E.5 六步链的
 * 第 2/3 步：层成员解析 + 每层派生；第 1/4/5/6 步编排归 edit/gemprojReplay.ts）。
 *
 * 正交意图：
 * 1. [specKey 解析] resolveSpecForKey：builtin 走 engine bootstrap 反解（ROUND_SS_BOOTSTRAP
 *    查表 / builtinSpecKey 规则逆推——纯函数零 IO）；custom（custom-<assetId>）经**注入**目录
 *    resolver（生产 = 素材库 .gemshape 真源，测试 = 内存 stub）；missing = typed 四态镜像
 *    ShapeAssetRefState（engine/exportGate.ts:47：'soft-deleted' | 'blob-missing' | 'wrong-kind'
 *    | null）——**禁静默降级圆钻**（unresolvable → SpecKeyResolveError，drift/损坏显式上浮）。
 *    lib 纯度：本文件不 import assetStore（生产 resolver 由编排层注入）。
 * 2. [层成员解析] 显式层成员 = blockIds ∩ 当前块集（未知键不拒收——parser 已定；空层保留：
 *    配置在、块没了）；唯一 rest 展开 = 分块结果 − 显式层并集；悬空覆写键**逐层**清点
 *    （现状 v1 全局清点 gemprojReplay.ts:179-186 的层级化，计数上浮由调用方单次提示）。
 * 3. [每层派生] effectiveBlocks（disabled 过滤 + type 覆写——studio.svelte.ts :160-165 逻辑平移）/
 *    density 两级回落（块覆写 ?? 层 density；恰为 1 的键省略——引擎 Record 缺省 1.0 语义）/
 *    grid = gridFromSpec(BaseSpec, layer.gapMm, pixelsPerMm) **按层 specKey**（gridFromSs 降位
 *    特例不再被 replay 消费）。
 * 4. [物理锚] pixelsPerMm = pixelsPerMmFromCanvas(imageWidth, physicalCanvas)——锚定实际降采样
 *    canvas 宽（缺席/非法 → default 2.5 显式，不静默）。
 */

import {
  BUILTIN_SHAPES,
  ROUND_SS_BOOTSTRAP,
  gridFromSpec,
  pixelsPerMmFromCanvas,
  ssOfRoundSpecKey,
  type BaseSpec,
  type Block,
  type GridSpec,
  type PhysicalCanvas,
} from '$lib/engine'
import type { LayerRecord } from '$lib/persistence/projectFile'

// ---------------------------------------------------------------------------
// specKey 解析（builtin bootstrap 反解 + custom 注入目录）
// ---------------------------------------------------------------------------

/** custom 解析态：镜像 engine ShapeAssetRefState 四态（null = 节点不存在/硬清后）。 */
export type CustomSpecRefState = 'soft-deleted' | 'blob-missing' | 'wrong-kind' | null

/** custom specKey 目录解析结果（生产 = 素材库 .gemshape 真源；测试 = 内存 stub）。 */
export type CustomSpecResolution =
  | { state: 'resolved'; spec: BaseSpec }
  | { state: CustomSpecRefState }

/** 注入 resolver：assetId（custom-<assetId> 尾段）→ 解析态。 */
export type CustomSpecResolver = (assetId: string) => Promise<CustomSpecResolution>

/** specKey 不可解析（builtin 非法形态 / custom 资产 missing 四态）——typed 上浮，禁静默降级圆钻。 */
export class SpecKeyResolveError extends Error {
  constructor(
    public readonly specKey: string,
    /** 'invalid-builtin'：builtin 键形态/档位非法；custom：四态（null = not-found） */
    public readonly reason: 'invalid-builtin' | 'custom-missing',
    public readonly state?: CustomSpecRefState,
  ) {
    super(
      reason === 'invalid-builtin'
        ? `规格键 ${specKey} 不是可解析的内置规格（round-ssXX 查表档位 / ${BUILTIN_SHAPES.map((s) => s.shapeId).join('/')}<mm> 规则）。`
        : `自定义规格 ${specKey} 引用的钻形资产不可用（${state ?? 'not-found'}）：请先还原或重新绑定资产——不回退圆钻。`,
    )
    this.name = 'SpecKeyResolveError'
  }
}

const NON_ROUND_TOKEN_RE = /^\d+(?:\.\d+)?$/

/** builtin specKey → BaseSpec（ROUND_SS_BOOTSTRAP 查表 + builtinSpecKey 规则逆推；不可解析 → null）。 */
function builtinSpecFromKey(specKey: string): BaseSpec | null {
  const ss = ssOfRoundSpecKey(specKey)
  if (ss !== null) {
    const row = ROUND_SS_BOOTSTRAP.find((r) => r.ss === ss)
    return row === undefined ? null : { shapeId: 'round', sizeLabel: ss, diameterMm: row.diameterMm }
  }
  for (const { shapeId } of BUILTIN_SHAPES) {
    if (shapeId === 'round' || !specKey.startsWith(`${shapeId}-`)) continue
    const token = specKey.slice(shapeId.length + 1)
    if (!NON_ROUND_TOKEN_RE.test(token)) return null
    const diameterMm = Number(token)
    if (!(diameterMm > 0)) return null
    return { shapeId, sizeLabel: `${token}mm`, diameterMm }
  }
  return null
}

/**
 * specKey → BaseSpec（v2 层物理的唯一解析入口）：
 * - 'round-ssXX'（SS_KEYS 档位）→ bootstrap 查表直径；
 * - '${非圆builtin形}-<mm 数值>' → builtinSpecKey 规则逆推（sizeLabel 还原 '<token>mm'）；
 * - 'custom-<assetId>' → 注入 resolver（缺席/missing → SpecKeyResolveError，四态随附）；
 * - 其余形态 → SpecKeyResolveError('invalid-builtin')。
 */
export async function resolveSpecForKey(
  specKey: string,
  resolveCustom?: CustomSpecResolver,
): Promise<BaseSpec> {
  if (specKey.startsWith('custom-')) {
    const assetId = specKey.slice('custom-'.length)
    if (assetId === '' || resolveCustom === undefined) {
      throw new SpecKeyResolveError(specKey, 'custom-missing', null)
    }
    const resolution = await resolveCustom(assetId)
    if (resolution.state !== 'resolved') {
      throw new SpecKeyResolveError(specKey, 'custom-missing', resolution.state)
    }
    return resolution.spec
  }
  const builtin = builtinSpecFromKey(specKey)
  if (builtin === null) throw new SpecKeyResolveError(specKey, 'invalid-builtin')
  return builtin
}

// ---------------------------------------------------------------------------
// 层成员解析 + 每层派生
// ---------------------------------------------------------------------------

/** 每层派生计划（computeLayer 的直接输入面：effectiveBlocks/density/grid 按层独立）。 */
export interface LayerPlan {
  record: LayerRecord
  spec: BaseSpec
  /** 层成员块（显式层 = blockIds ∩ 当前块集；rest 层 = 分块结果 − 显式层并集；不深拷贝）。 */
  memberBlocks: Block[]
  /** 送 layout 的最终块集（disabled 过滤 + type 覆写——studio effectiveBlocks 逻辑平移）。 */
  effectiveBlocks: Block[]
  /** DensitySpec Record 形态（块覆写 ?? 层 density；恰为 1 的键省略——引擎缺省 1.0）。 */
  density: Record<string, number>
  /** 按层 specKey 派生的网格（gridFromSpec(BaseSpec, gapMm, pixelsPerMm)）。 */
  grid: GridSpec
}

export interface LayerSetResolution {
  /** 画幅像素锚（physicalCanvas 锚定实际 canvas 宽；缺席 = default 2.5 显式）。 */
  pixelsPerMm: number
  /** 文件层声明序的派生计划。 */
  layers: LayerPlan[]
  /** rest 层在 layers 中的下标（恰一——parser 不变量）。 */
  restLayerIndex: number
  /** 悬空覆写键逐层清点（层 id → 四表悬空键合计；合计数由调用方单次提示）。 */
  droppedOverridesByLayer: Record<string, number>
}

/** 层四表悬空键计数（块 id 已不存在于当前块集——引擎重分块漂移的显式清单）。 */
function countDanglingOverrideKeys(layer: LayerRecord, blockIds: ReadonlySet<string>): number {
  let count = 0
  for (const key of [
    ...Object.keys(layer.overrides.disabled),
    ...Object.keys(layer.overrides.density),
    ...Object.keys(layer.overrides.type),
    ...Object.keys(layer.overrides.color),
  ]) {
    if (!blockIds.has(key)) count += 1
  }
  return count
}

/**
 * 解析层集（六步链第 2/3 步）：
 * 1. 显式层并集 → rest 展开（分块结果 − 并集）；显式层成员 = blockIds ∩ 当前块集（未知键不拒收）；
 * 2. 逐层 effectiveBlocks（disabled 过滤 + type 覆写）+ density 两级回落 + grid（按层 specKey）；
 * 3. 逐层悬空覆写键清点。
 * specKey 不可解析（custom missing 四态/builtin 非法）→ SpecKeyResolveError 上浮（禁静默降级）。
 */
export async function resolveLayerPlans(
  layers: readonly LayerRecord[],
  blocks: readonly Block[],
  imageWidth: number,
  physicalCanvas: PhysicalCanvas | undefined,
  resolveCustom?: CustomSpecResolver,
): Promise<LayerSetResolution> {
  const pixelsPerMm = pixelsPerMmFromCanvas(imageWidth, physicalCanvas)
  const byId = new Map(blocks.map((b) => [b.id, b] as const))
  const blockIds = new Set(byId.keys())

  // 显式层并集（未知 blockIds 自然匹配零块——空层保留）
  const explicitIds = new Set<string>()
  let restLayerIndex = -1
  for (let i = 0; i < layers.length; i++) {
    const record = layers[i]
    if (record.blockIds === 'rest') {
      restLayerIndex = i
      continue
    }
    for (const id of record.blockIds) explicitIds.add(id)
  }

  const droppedOverridesByLayer: Record<string, number> = {}
  const plans: LayerPlan[] = []
  for (const record of layers) {
    droppedOverridesByLayer[record.id] = countDanglingOverrideKeys(record, blockIds)
    const memberBlocks =
      record.blockIds === 'rest'
        ? blocks.filter((b) => !explicitIds.has(b.id))
        : record.blockIds.reduce<Block[]>((acc, id) => {
            const block = byId.get(id)
            if (block !== undefined) acc.push(block)
            return acc
          }, [])
    // effectiveBlocks：disabled 过滤 + type 覆写（覆写值 === suggested 时零拷贝透传——studio 同式）
    const effectiveBlocks = memberBlocks
      .filter((b) => record.overrides.disabled[b.id] !== true)
      .map((b) => {
        const typeOverride = record.overrides.type[b.id]
        return typeOverride !== undefined && typeOverride !== b.suggested ? { ...b, suggested: typeOverride } : b
      })
    // density 两级回落：块覆写 ?? 层 density；恰为 1 的键省略（引擎 Record 缺省 1.0）
    const density: Record<string, number> = {}
    for (const b of effectiveBlocks) {
      const d = record.overrides.density[b.id] ?? record.physics.density
      if (d !== 1) density[b.id] = d
    }
    const spec = await resolveSpecForKey(record.physics.specKey, resolveCustom)
    const grid = gridFromSpec(spec, record.physics.gapMm, pixelsPerMm)
    plans.push({ record, spec, memberBlocks, effectiveBlocks, density, grid })
  }

  return { pixelsPerMm, layers: plans, restLayerIndex, droppedOverridesByLayer }
}
