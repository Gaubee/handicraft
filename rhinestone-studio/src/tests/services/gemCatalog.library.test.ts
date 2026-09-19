/**
 * [add-lab 4.2] gemCatalogService 素材库真源实现（sys-shapes .gemshape 资产 hydrate）：
 * - listSpecs：runAssetMigration 后 = GEMSHAPE_SEEDS 声明序（20 条）；字段派生
 *   （round SS 档 sizeLabel=SS 表反查 / 异形 mm token / diameterMm=max(physical)）；
 * - resolveSpec：seed 键命中 / 未知键 / 软删 / 自定义资产（custom-<assetId> 携带 assetId）；
 * - mock 退役夹具与真源接口等价（签名冻结——GemCatalogService 结构断言）。
 * fakeIndexedDB：seed 落库 + 自定义 ingest（贴图解码 stub——gate 判据不在本片验证面）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GEMSHAPE_SEEDS, SS_TABLE, gemshapeSeedNodeId } from '$lib/engine'
import {
  gemCatalog,
  createLibraryGemCatalogService,
  type GemCatalogService,
} from '$lib/services/gemCatalogService'
import {
  getProject,
  ingestGemshapeFile,
  resetAssetStoreForTests,
  runAssetMigration,
  trashAsset,
} from '$lib/persistence/assetStore'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { serializeGemshape, type GemshapeTextureDecoder } from '$lib/persistence/gemshapeFile'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 贴图解码 stub：seed 声明尺寸 + 全不透明像素面（alpha bounds = 全幅；gate 判据真实解码
 *  面归 sysShapesSeed.test——本片只走 ingest 管线拿自定义资产节点）。 */
const squareBoundsDecoder: GemshapeTextureDecoder = async (dataUrl) => {
  const seed = GEMSHAPE_SEEDS.find((s) => s.texture.dataUrl === dataUrl)
  if (seed === undefined) throw new Error('stub 解码器只认 seed 贴图')
  const { width, height } = seed.texture
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  return { width, height, data }
}

describe('listSpecs：seed 声明序 hydrate（runAssetMigration 后）', () => {
  it('全量 = GEMSHAPE_SEEDS 声明序；字段派生（sizeLabel/shapeId/diameterMm/width·height）', async () => {
    await runAssetMigration()
    const specs = await gemCatalog.listSpecs()
    expect(specs.map((s) => s.specKey)).toEqual(GEMSHAPE_SEEDS.map((s) => s.specKey))

    const ss10 = specs.find((s) => s.specKey === 'round-ss10')!
    expect(ss10.shapeId).toBe('round')
    expect(ss10.sizeLabel).toBe('SS10')
    expect(ss10.diameterMm).toBe(SS_TABLE.SS10)
    expect(ss10.widthMm).toBe(SS_TABLE.SS10)
    expect(ss10.heightMm).toBe(SS_TABLE.SS10)
    expect(ss10.assetId).toBeUndefined() // assetId 仅 custom 携带（GemSpecSnapshot 同约束）

    // 异形 mm 档：specKey token → sizeLabel（'square-3' → '3mm'）；diameterMm = max(physical)
    const square3 = specs.find((s) => s.specKey === 'square-3')!
    expect(square3.shapeId).toBe('square')
    expect(square3.sizeLabel).toBe('3mm')
    const squareSeed = GEMSHAPE_SEEDS.find((s) => s.specKey === 'square-3')!
    expect(square3.diameterMm).toBe(Math.max(squareSeed.physical.widthMm, squareSeed.physical.heightMm))

    // 异形附宽（水滴 aspect ≠ 1 → widthMm ≠ heightMm）
    const drop = specs.find((s) => s.specKey.startsWith('drop-'))!
    expect(drop.shapeId).toBe('drop')
    expect(drop.widthMm).toBeDefined()
    expect(drop.heightMm).toBeDefined()
  })

  it('软删 seed 节点：listSpecs 排除 + resolveSpec → undefined（missing，不静默降级）', async () => {
    await runAssetMigration()
    await trashAsset(gemshapeSeedNodeId('round-ss10'))
    const specs = await gemCatalog.listSpecs()
    expect(specs.some((s) => s.specKey === 'round-ss10')).toBe(false)
    expect(await gemCatalog.resolveSpec('round-ss10')).toBeUndefined()
  })
})

describe('resolveSpec：specKey 反解（seed 键 / 自定义资产 / 未知键）', () => {
  it('seed 键命中（round-ss16）；未知键 / 空键 → undefined', async () => {
    await runAssetMigration()
    const hit = await gemCatalog.resolveSpec('round-ss16')
    expect(hit?.specKey).toBe('round-ss16')
    expect(hit?.sizeLabel).toBe('SS16')
    expect(await gemCatalog.resolveSpec('round-ss99')).toBeUndefined()
    expect(await gemCatalog.resolveSpec('')).toBeUndefined()
    expect(await gemCatalog.resolveSpec('nonexistent-key')).toBeUndefined()
  })

  it('自定义资产（ingest 无 specKey 文件 → custom-<assetId>）：携带 assetId + 资产名作 sizeLabel；listSpecs 续在 seed 之后', async () => {
    await runAssetMigration()
    const seedTexture = GEMSHAPE_SEEDS[0].texture
    const text = serializeGemshape({
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '星星钻',
      texture: seedTexture,
      physical: { widthMm: 5, heightMm: 5 },
      calibration: { mode: 'direct' },
    })
    const { node } = await ingestGemshapeFile(new Blob([text], { type: PROJECT_MIME.gemshape }), {
      name: '星星钻',
      decode: squareBoundsDecoder,
    })
    const specKey = `custom-${node.id}`
    const entry = await gemCatalog.resolveSpec(specKey)
    expect(entry).toBeDefined()
    expect(entry!.shapeId).toBe('custom')
    expect(entry!.assetId).toBe(node.id)
    expect(entry!.sizeLabel).toBe('星星钻') // custom = 资产名（人读标签，不参与身份）
    expect(entry!.diameterMm).toBe(5)

    const specs = await gemCatalog.listSpecs()
    expect(specs.length).toBe(GEMSHAPE_SEEDS.length + 1)
    expect(specs[specs.length - 1].specKey).toBe(specKey) // 自定义按入库序续在 seed 之后
    expect(await gemCatalog.resolveSpec(node.id)).toBeUndefined() // 节点 id ≠ specKey（custom- 前缀身份）
  })
})

describe('真源实现与接口契约', () => {
  it('createLibraryGemCatalogService 满足 GemCatalogService（签名冻结）；多实例等值（无内部可变态）', async () => {
    await runAssetMigration()
    const service: GemCatalogService = createLibraryGemCatalogService()
    const a = await service.listSpecs()
    const b = await gemCatalog.listSpecs()
    expect(a).toEqual(b)
    expect(a).not.toBe(b) // 每次调用新数组（持有安全）
  })
})
