/**
 * [gem-catalog 2.2] .gemshape 八面 vertical slice——persistence/资产面：
 * - ingest：六 gate 全量（parse 同步面 + verify 贴图解码实测面）→ 新资产落 sys-shapes；
 *   specKey 条件矩阵（custom ingest 派生 custom-<assetId>）；
 * - 内容不可变：updateProjectAsset 对 gemshape 无换绑入口（typed 拒绝）；元数据（改名）可改、内容不动；
 * - 另存副本（fork）：新 assetId + 新 specKey custom-<id>；校准向导数据面（direct / reference 烘焙）；
 * - 引用四态（resolved / soft-deleted / blob-missing / wrong-kind + 硬清 not-found）与转移；
 * - 导出阻断（gate 6 端到端）：exportGate.resolveShapeAsset 接线 + assertGemshapeRefs typed error；
 * - 编辑期 pin 校准参考（存在才 pin / 悬空不 pin / 对应解除）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SS_TABLE, exportGate, gridFromSs } from '$lib/engine'
import {
  SYS_SHAPES_FOLDER_ID,
  emptyTrash,
  forkGemshapeAsset,
  gemshapeNodeIdOfSpecKey,
  gemshapeRefResolver,
  getProject,
  ingestAsset,
  ingestGemshapeFile,
  isAssetPinned,
  listAllNodes,
  pinGemshapeCalibrationRef,
  renameAsset,
  resetAssetStoreForTests,
  resolveGemshapeRefState,
  seedSysShapesCatalog,
  trashAsset,
  unpinGemshapeCalibrationRef,
  updateProjectAsset,
} from '$lib/persistence/assetStore'
import { deleteImage, getImageBlob, putImage } from '$lib/persistence/imageStore'
import {
  GemshapeFieldError,
  GemshapeKindError,
  GemshapeRefError,
  assertGemshapeRefs,
  serializeGemshape,
  type GemshapeFileInput,
  type GemshapeTextureDecoder,
} from '$lib/persistence/gemshapeFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
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

// ---------------------------------------------------------------------------
// 样本与确定性解码替身
// ---------------------------------------------------------------------------

const TEXTURE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo' // 载荷形态合法；解码经注入替身

function sampleInput(overrides: Partial<GemshapeFileInput> = {}): GemshapeFileInput {
  return {
    appVersion: '0.1.0-test',
    createdAt: 1758000000000,
    savedAt: 1758000000000,
    name: '自定义钻形',
    texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 50, height: 50 },
    physical: { widthMm: 3, heightMm: 3 },
    calibration: { mode: 'direct' },
    ...overrides,
  }
}

function gemshapeBlob(input: GemshapeFileInput): Blob {
  return new Blob([serializeGemshape(input)], { type: PROJECT_MIME.gemshape })
}

/** 内嵌 80% 边距的实心矩形剪影（alpha bounds 纵横比 = 画布纵横比）。 */
function rectDecoder(width: number, height: number): GemshapeTextureDecoder {
  return async () => {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = Math.floor(height * 0.1); y < Math.ceil(height * 0.9); y += 1) {
      for (let x = Math.floor(width * 0.1); x < Math.ceil(width * 0.9); x += 1) {
        const i = (y * width + x) * 4
        data[i] = 200
        data[i + 1] = 200
        data[i + 2] = 210
        data[i + 3] = 255
      }
    }
    return { width, height, data }
  }
}

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错但未抛出')
}

// ---------------------------------------------------------------------------
// ingest（六 gate + specKey 条件矩阵）
// ---------------------------------------------------------------------------

describe('ingestGemshapeFile：六 gate 全量 + custom ingest specKey 派生', () => {
  it('合法输入（specKey 缺席）→ 新资产落 sys-shapes；specKey 物化 custom-<assetId>；文件可回读', async () => {
    const result = await ingestGemshapeFile(gemshapeBlob(sampleInput()), { decode: rectDecoder(50, 50) })
    expect(result.node.projectKind).toBe('gemshape')
    expect(result.node.parentId).toBe(SYS_SHAPES_FOLDER_ID)
    expect(result.file.specKey).toBe(`custom-${result.node.id}`)
    expect(result.node.summary.size).toBe('3mm')

    const blob = await getImageBlob(result.node.blobKey)
    expect(blob?.type).toBe(PROJECT_MIME.gemshape)
    const stored = JSON.parse(await blob!.text())
    expect(stored.specKey).toBe(`custom-${result.node.id}`)
    expect(stored.kind).toBe('gemshape')
  })

  it('gate：vector-only（texture 缺席）→ parse typed error 拒收，零节点', async () => {
    const bad = sampleInput()
    delete (bad as Partial<GemshapeFileInput>).texture
    const blob = new Blob([JSON.stringify({ ...bad, kind: 'gemshape', formatVersion: 1 })], {
      type: PROJECT_MIME.gemshape,
    })
    const error = await ingestGemshapeFile(blob, { decode: rectDecoder(50, 50) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GemshapeFieldError)
    expect((await projectNodes()).length).toBe(0)
  })

  it('gate：MIME 交叉校验（blob.type 与 gemshape MIME 不符）→ typed kind error', async () => {
    const blob = new Blob([serializeGemshape(sampleInput())], { type: 'image/png' })
    const error = await ingestGemshapeFile(blob).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GemshapeKindError)
  })

  it('gate：fit 纵横比漂移（贴图 1:1 vs physical 3:5）→ verify typed error 拒收，零节点', async () => {
    const input = sampleInput({ physical: { widthMm: 3, heightMm: 5 } })
    const error = await ingestGemshapeFile(gemshapeBlob(input), { decode: rectDecoder(50, 50) }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(GemshapeFieldError)
    expect((await projectNodes()).length).toBe(0)
  })
})

/** 项目节点（全部 kind）投影——零落库断言用。 */
async function projectNodes(): Promise<Array<{ id: string; projectKind: string }>> {
  return (await listAllNodes())
    .filter((n) => n.type === 'project')
    .map((n) => ({ id: n.id, projectKind: (n as { projectKind: string }).projectKind }))
}

// ---------------------------------------------------------------------------
// 内容不可变（无换绑入口）
// ---------------------------------------------------------------------------

describe('gemshape 内容不可变（R3 P0-2）', () => {
  it('updateProjectAsset 对 gemshape 节点 = typed 拒绝（无 blobKey 换绑入口）；gemproj 类不受影响的面在 projectAsset 测试', async () => {
    const { node } = await ingestGemshapeFile(gemshapeBlob(sampleInput()), { decode: rectDecoder(50, 50) })
    const error = await updateProjectAsset(node.id, {
      expectedBlobKey: node.blobKey,
      bytes: new Blob(['{"kind":"gemshape"}'], { type: PROJECT_MIME.gemshape }),
      summary: {},
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('不可变')
    // 拒绝后内容未被写入：blob 字节不变
    const blob = await getImageBlob(node.blobKey)
    expect(JSON.parse(await blob!.text()).name).toBe('自定义钻形')
  })

  it('元数据可改：节点改名不改内容（blobKey 不变 = 零换绑路径）', async () => {
    const { node } = await ingestGemshapeFile(gemshapeBlob(sampleInput()), { decode: rectDecoder(50, 50) })
    const renamed = await renameAsset(node.id, '我的水滴')
    expect(renamed.name).toBe('我的水滴')
    expect((renamed as { blobKey: string }).blobKey).toBe(node.blobKey)
  })
})

// ---------------------------------------------------------------------------
// 另存副本（fork）+ 校准向导数据面
// ---------------------------------------------------------------------------

describe('forkGemshapeAsset：另存为自定义副本', () => {
  beforeEach(async () => {
    await seedSysShapesCatalog()
  })

  it('seed 资产副本：新 assetId + 新 specKey custom-*；physical/vectorPath/calibration 原样；原资产不动', async () => {
    const original = await getProject('ast-shape-round-ss10')
    expect(original).not.toBeNull()
    const result = await forkGemshapeAsset('ast-shape-round-ss10')
    expect(result.node.id).not.toBe('ast-shape-round-ss10')
    expect(result.file.specKey).toBe(`custom-${result.node.id}`)
    expect(result.file.physical).toEqual({ widthMm: SS_TABLE.SS10, heightMm: SS_TABLE.SS10 })
    expect(result.file.calibration).toEqual({ mode: 'direct' })
    expect(result.file.vectorPath).toMatch(/^M 0\.5 0\.02/)
    expect(result.node.name).toContain('副本')
    // 原资产零改动（内容不可变）
    const after = await getProject('ast-shape-round-ss10')
    expect(after?.blobKey).toBe(original?.blobKey)
    const originalBlob = await getImageBlob(after!.blobKey)
    expect(JSON.parse(await originalBlob!.text()).specKey).toBe('round-ss10')
  })

  it('校准向导数据面——direct：声明的物理宽高物化 + calibration 记出处', async () => {
    const result = await forkGemshapeAsset('ast-shape-round-ss10', {
      calibration: { mode: 'direct', widthMm: 3.1, heightMm: 3.3 },
    })
    expect(result.file.physical).toEqual({ widthMm: 3.1, heightMm: 3.3 })
    expect(result.file.calibration).toEqual({ mode: 'direct' })
  })

  it('校准向导数据面——reference：以既有规格反推（bounds 主径 px ÷ 参考直径 → px/mm）', async () => {
    // seed 贴图声明 64×64——替身同尺寸过 gate 1；80% 边距矩形 → alpha bounds ≈ 52×52
    const result = await forkGemshapeAsset('ast-shape-round-ss10', {
      decode: rectDecoder(64, 64),
      calibration: { mode: 'reference', refSpec: { specKey: 'round-ss10', diameterMm: SS_TABLE.SS10 } },
    })
    const boundsSpan = Math.ceil(64 * 0.9) - Math.floor(64 * 0.1) // 解码替身的 alpha bounds 主径
    const pxPerMm = boundsSpan / SS_TABLE.SS10
    expect(result.file.physical.widthMm).toBeCloseTo(boundsSpan / pxPerMm, 10)
    expect(result.file.physical.heightMm).toBeCloseTo(boundsSpan / pxPerMm, 10)
    expect(result.file.calibration).toEqual({ mode: 'reference', refSpecId: 'round-ss10' })
  })
})

// ---------------------------------------------------------------------------
// 引用四态 + 转移矩阵 + 导出阻断（gate 6 端到端）
// ---------------------------------------------------------------------------

describe('引用四态（missing 定名与转移）', () => {
  beforeEach(async () => {
    await seedSysShapesCatalog()
  })

  it('specKey → 节点 id 解析（seed 档 / custom 反解）', () => {
    expect(gemshapeNodeIdOfSpecKey('round-ss10')).toBe('ast-shape-round-ss10')
    expect(gemshapeNodeIdOfSpecKey('custom-ast-abc')).toBe('ast-abc')
  })

  it('resolved → soft-deleted →（清空回收站硬清）→ not-found；blob-missing；wrong-kind（图片节点/parse 失败）', async () => {
    const { node } = await ingestGemshapeFile(gemshapeBlob(sampleInput()), { decode: rectDecoder(50, 50) })
    expect(await resolveGemshapeRefState(node.id)).toBe('resolved')

    // soft-deleted（回收站；恢复路径的 store 面未落——恢复 UI 归素材库后续切片，态转移判据在此冻结）
    await trashAsset(node.id)
    expect(await resolveGemshapeRefState(node.id)).toBe('soft-deleted')

    // 硬清（既有 GC）：节点与物理记录随清空回收站删除 → not-found（校准快照仍在文档侧可审计）
    await emptyTrash()
    expect(await resolveGemshapeRefState(node.id)).toBeNull()

    // blob-missing：节点在而物理字节丢失
    const second = await ingestGemshapeFile(gemshapeBlob(sampleInput({ name: '第二颗' })), { decode: rectDecoder(50, 50) })
    await deleteImage(second.node.blobKey)
    expect(await resolveGemshapeRefState(second.node.id)).toBe('blob-missing')

    // wrong-kind：非 gemshape 节点（图片）
    const image = await ingestAsset({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      name: 'pic.png',
      width: 1,
      height: 1,
      parentId: null,
      source: 'upload',
    })
    expect(await resolveGemshapeRefState(image.node.id)).toBe('wrong-kind')

    // wrong-kind（parse 失败档）：gemshape 节点但字节损坏
    const third = await ingestGemshapeFile(gemshapeBlob(sampleInput({ name: '第三颗' })), { decode: rectDecoder(50, 50) })
    await putImage(third.node.blobKey, new Blob(['{ not json'], { type: PROJECT_MIME.gemshape }))
    expect(await resolveGemshapeRefState(third.node.id)).toBe('wrong-kind')
  })

  it('导出阻断（gate 6 端到端）：custom 钻引用 soft-deleted 资产 → exportGate ok=false + assertGemshapeRefs typed error；resolved → 放行', async () => {
    const { node } = await ingestGemshapeFile(gemshapeBlob(sampleInput()), { decode: rectDecoder(50, 50) })
    const grid = gridFromSs('SS10', 2.5)
    const gems = [
      { id: 'g1', x: 100, y: 100, colorId: '', blockId: 'b', shapeId: 'round' as const, diameterMm: SS_TABLE.SS10 },
      { id: 'g2', x: 300, y: 300, colorId: '', blockId: 'b', shapeId: 'custom' as const, diameterMm: 3, assetId: node.id },
    ]

    const resolver = await gemshapeRefResolver([node.id])
    const ok = exportGate(gems, { grid, resolveShapeAsset: resolver })
    expect(ok.ok).toBe(true)

    await trashAsset(node.id)
    const blocked = exportGate(gems, { grid, resolveShapeAsset: await gemshapeRefResolver([node.id]) })
    expect(blocked.ok).toBe(false)
    expect(blocked.violations).toHaveLength(1)
    expect(blocked.violations[0].kind).toBe('missing-asset')
    expect(blocked.violations[0].gemIds).toEqual(['g2'])

    expect(
      captureError(() => assertGemshapeRefs([node.id], (id) => (id === node.id ? 'soft-deleted' : 'resolved'))),
    ).toBeInstanceOf(GemshapeRefError)

    // 硬清后：not-found 档（typed 状态区分——校准快照仍在文档侧）
    await emptyTrash()
    expect(
      captureError(() => assertGemshapeRefs([node.id], (id) => (id === node.id ? null : 'resolved'))),
    ).toBeInstanceOf(GemshapeRefError)
    const hardBlocked = exportGate(gems, { grid, resolveShapeAsset: await gemshapeRefResolver([node.id]) })
    expect(hardBlocked.violations[0].detail).toContain('not-found')
  })
})

// ---------------------------------------------------------------------------
// 编辑期 pin 校准参考
// ---------------------------------------------------------------------------

describe('校准参考 pin（编辑期保护——只 pin 校准参考，不升级文档弱引用）', () => {
  beforeEach(async () => {
    await seedSysShapesCatalog()
  })

  it('存在才 pin：seed 档解析 → pin 生效；解除后放行；悬空 specKey → null 不 pin', async () => {
    const pinned = await pinGemshapeCalibrationRef('round-ss10')
    expect(pinned).toBe('ast-shape-round-ss10')
    expect(isAssetPinned('ast-shape-round-ss10')).toBe(true)

    unpinGemshapeCalibrationRef('round-ss10')
    expect(isAssetPinned('ast-shape-round-ss10')).toBe(false)

    const dangling = await pinGemshapeCalibrationRef('round-ss99')
    expect(dangling).toBeNull()
    expect(isAssetPinned(gemshapeNodeIdOfSpecKey('round-ss99'))).toBe(false)
  })
})
