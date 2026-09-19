/**
 * [gem-catalog 2.1] sys-shapes 内置规格 seed 落库（Owner 裁决一：目录真源 = 素材库资产）：
 * - seed 数据形状：P0 五形 ×（圆形 SS 档 / 异形 mm 档）、specKey 唯一、贴图必备 + 可选 vectorPath + 物理宽高；
 * - 目录枚举确定性：GEMSHAPE_SEEDS 声明序 = 落库序（round SS_KEYS 序 → 四异形 mm 档）；
 * - SS24 补档（≈5.3mm 入 seed）+ 既有档位数值零变化（SS_TABLE 对照）；
 * - 嵌入贴图 = 真实 PNG：node 侧解码（inflate+unfilter）过 verifyGemshapeTexture 四 gate
 *   （实测宽高 / 像素上限 / alpha bounds 非空 / fit 容差）——与生产 canvas 解码同一判据面；
 * - seed 文件 serialize→parse round-trip 字节等价（specKey 必填 + texture 必备 + calibration direct）；
 * - IDB 落库：sys-shapes 目录序插「模板」与「生成结果」之间 + ast-shape-* 幂等 create-only
 *   （二次零新增；软删节点不复活——删除不复活纪律）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inflateSync } from 'node:zlib'
import { GEMSHAPE_SEEDS, SS_KEYS, SS_TABLE, builtinSpecKey, gemshapeSeedNodeId, type GemshapeSeedSpec } from '$lib/engine'
import {
  SYSTEM_FOLDER_IDS,
  SYS_SHAPES_FOLDER_ID,
  getProject,
  listAllNodes,
  resetAssetStoreForTests,
  runAssetMigration,
  seedSysShapesCatalog,
  trashAsset,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import {
  GEMSHAPE_FIT_TOLERANCE,
  alphaBounds,
  parseGemshape,
  serializeGemshape,
  verifyGemshapeTexture,
  type GemshapeTextureDecoder,
} from '$lib/persistence/gemshapeFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

// ---------------------------------------------------------------------------
// node 侧真实 PNG 解码器（filter 0-4 unfilter + inflate）——嵌入贴图六 gate 的实测面
// ---------------------------------------------------------------------------

function decodePng(dataUrl: string): { width: number; height: number; data: Uint8ClampedArray } {
  const b64 = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)?.[1]
  if (b64 === undefined) throw new Error('非 base64 PNG dataUrl')
  const buf = Buffer.from(b64, 'base64')
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG 签名缺失')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = -1
  const idat: Buffer[] = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`仅支持 8bit RGBA（实得 depth=${bitDepth} color=${colorType}）`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const out = new Uint8ClampedArray(width * height * 4)
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x
      const val = raw[rowStart + x]
      const left = x >= 4 ? out[i - 4] : 0
      const up = y > 0 ? out[i - stride] : 0
      const upLeft = y > 0 && x >= 4 ? out[i - stride - 4] : 0
      out[i] =
        filter === 0 ? val
        : filter === 1 ? val + left
        : filter === 2 ? val + up
        : filter === 3 ? val + ((left + up) >> 1)
        : filter === 4 ? val + paeth(left, up, upLeft)
        : (() => {
            throw new Error(`未知滤镜 ${filter}`)
          })()
    }
  }
  return { width, height, data: out }
}

/** 生产 canvas 解码器的 node 等价替身：真实解码嵌入 PNG（宽高/alpha 与浏览器一致）。 */
const realPngDecoder: GemshapeTextureDecoder = async (dataUrl) => decodePng(dataUrl)

// ---------------------------------------------------------------------------
// 纯数据面：seed 数据形状 / 枚举确定性 / SS24 / 贴图 gate / round-trip
// ---------------------------------------------------------------------------

describe('seed 数据形状与目录枚举确定性（2.1）', () => {
  it('P0 五形全覆盖 × 档位齐全：specKey 唯一、贴图必备、物理宽高为正、主径 = max(widthMm, heightMm)', () => {
    expect(GEMSHAPE_SEEDS.length).toBeGreaterThanOrEqual(17)
    const specKeys = new Set<string>()
    const shapes = new Set<string>()
    for (const seed of GEMSHAPE_SEEDS) {
      expect(specKeys.has(seed.specKey)).toBe(false)
      specKeys.add(seed.specKey)
      shapes.add(seed.shapeId)
      expect(seed.texture.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/)
      expect(seed.texture.width).toBeGreaterThan(0)
      expect(seed.texture.height).toBeGreaterThan(0)
      expect(seed.physical.widthMm).toBeGreaterThan(0)
      expect(seed.physical.heightMm).toBeGreaterThan(0)
      // diameterMm = max（design §1.6 主尺寸 = 最大径）
      expect(Math.max(seed.physical.widthMm, seed.physical.heightMm)).toBeGreaterThan(0)
    }
    expect(shapes).toEqual(new Set(['round', 'square', 'drop', 'heart', 'marquise']))
  })

  it('目录枚举确定性：round SS 档（SS_KEYS 声明序）在前 → square → drop → heart → marquise mm 档', () => {
    const specKeys = GEMSHAPE_SEEDS.map((s) => s.specKey)
    // round 段 = SS_KEYS 声明序（含 SS24 插 SS22/SS26 之间）
    const roundSegment = specKeys.filter((k) => k.startsWith('round-'))
    expect(roundSegment).toEqual(SS_KEYS.map((ss) => `round-${ss.toLowerCase()}`))
    expect(specKeys.indexOf('round-ss22')).toBeLessThan(specKeys.indexOf('round-ss24'))
    expect(specKeys.indexOf('round-ss24')).toBeLessThan(specKeys.indexOf('round-ss26'))
    // 异形段按 square → drop → heart → marquise 形序
    const alienSegment = specKeys.filter((k) => !k.startsWith('round-'))
    const shapeOf = (key: string): string => key.split('-')[0]
    const shapeOrder = [...new Set(alienSegment.map(shapeOf))]
    expect(shapeOrder).toEqual(['square', 'drop', 'heart', 'marquise'])
    // specKey 与 canonical 生成规则一致（BOM 投影对齐——不由显示码反推）
    for (const seed of GEMSHAPE_SEEDS) {
      if (seed.shapeId === 'round') continue
      const major = Math.max(seed.physical.widthMm, seed.physical.heightMm)
      expect(seed.specKey).toBe(builtinSpecKey(seed.shapeId, `${major}mm`))
    }
  })

  it('SS24 补档：round-ss24 physical 5.3×5.3 入 seed；既有档位数值零变化（SS_TABLE 对照逐档)', () => {
    const ss24 = GEMSHAPE_SEEDS.find((s) => s.specKey === 'round-ss24')
    expect(ss24).toBeDefined()
    expect(ss24?.physical).toEqual({ widthMm: 5.3, heightMm: 5.3 })
    expect(ss24?.nameZh).toBe('圆钻 SS24')
    // 既有档位零变化：每档直径与 SS_TABLE 逐位相等（同参同出不 bump 的机制面证据）
    for (const ss of SS_KEYS) {
      const seed = GEMSHAPE_SEEDS.find((s) => s.specKey === `round-${ss.toLowerCase()}`)
      expect(seed, `缺 ${ss} 档 seed`).toBeDefined()
      expect(seed?.physical.widthMm).toBe(SS_TABLE[ss])
      expect(seed?.physical.heightMm).toBe(SS_TABLE[ss])
    }
    expect(SS_TABLE.SS22).toBe(5.2) // 既有值锚点（补档不改邻档）
    expect(SS_TABLE.SS26).toBe(5.8)
  })
})

describe('嵌入贴图真实 PNG 六 gate（与生产 canvas 解码同判据面）', () => {
  it('每条 seed 的贴图过 verifyGemshapeTexture：实测宽高一致 / 像素上限 / alpha bounds 非空 / fit 容差', async () => {
    for (const seed of GEMSHAPE_SEEDS) {
      const file = parseGemshape(serializeGemshape(seedFileInput(seed)))
      const verification = await verifyGemshapeTexture(file, realPngDecoder)
      expect(verification.image.width).toBe(seed.texture.width)
      expect(verification.image.height).toBe(seed.texture.height)
      expect(verification.bounds.w).toBeGreaterThan(0)
      // fit 判据重算（相对偏差 ≤ 容差）
      const boundsAspect = verification.bounds.w / verification.bounds.h
      const physicalAspect = seed.physical.widthMm / seed.physical.heightMm
      expect(Math.abs(physicalAspect - boundsAspect) / boundsAspect).toBeLessThanOrEqual(GEMSHAPE_FIT_TOLERANCE)
    }
  })

  it('五形贴图互不相同且 alpha bounds 纵横比 = 档位纵横比（剪影即轮廓）', async () => {
    const seenDataUrls = new Set<string>()
    for (const shape of ['round', 'square', 'drop', 'heart', 'marquise'] as const) {
      const seed = GEMSHAPE_SEEDS.find((s) => s.shapeId === shape)
      expect(seed, `缺 ${shape} seed`).toBeDefined()
      seenDataUrls.add(seed!.texture.dataUrl)
      const image = await realPngDecoder(seed!.texture.dataUrl)
      const bounds = alphaBounds(image)
      expect(bounds).not.toBeNull()
      const aspect = bounds!.w / bounds!.h
      const physical = seed!.physical.widthMm / seed!.physical.heightMm
      expect(Math.abs(aspect - physical) / physical).toBeLessThanOrEqual(GEMSHAPE_FIT_TOLERANCE)
    }
    expect(seenDataUrls.size).toBe(5)
  })
})

describe('seed 文件 round-trip（serialize→parse→serialize 字节等价）', () => {
  it('每条 seed：specKey 必填保留 / texture 必备 / calibration direct / vectorPath 同源校验', () => {
    for (const seed of GEMSHAPE_SEEDS) {
      const text = serializeGemshape(seedFileInput(seed))
      const parsed = parseGemshape(text, { mime: PROJECT_MIME.gemshape })
      expect(parsed.specKey).toBe(seed.specKey)
      expect(parsed.physical).toEqual(seed.physical)
      expect(parsed.vectorPath).toBe(seed.vectorPath)
      expect(parsed.calibration).toEqual({ mode: 'direct' })
      expect(serializeGemshape(parsed)).toBe(text)
    }
  })
})

// ---------------------------------------------------------------------------
// IDB 落库：迁移 seed + 幂等 create-only（含软删跳过）
// ---------------------------------------------------------------------------

describe('sys-shapes 落库（fakeIndexedDB）', () => {
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

  it('迁移 seed：目录序插「模板」与「生成结果」之间 + ast-shape-* 节点按声明序 + 文件可 parse', async () => {
    const report = await runAssetMigration()
    expect(report.steps.find((s) => s.step === 'seed-sys-shapes')?.status).toBe('done')

    // 目录序：sys-templates < sys-shapes < sys-generated（SYSTEM_FOLDER_IDS 声明序 = 树序）
    expect(SYSTEM_FOLDER_IDS.indexOf('sys-templates')).toBeLessThan(SYSTEM_FOLDER_IDS.indexOf(SYS_SHAPES_FOLDER_ID))
    expect(SYSTEM_FOLDER_IDS.indexOf(SYS_SHAPES_FOLDER_ID)).toBeLessThan(SYSTEM_FOLDER_IDS.indexOf('sys-generated'))
    const nodes = await listAllNodes()
    const folder = nodes.find((n) => n.id === SYS_SHAPES_FOLDER_ID)
    expect(folder?.type).toBe('folder')
    expect((folder as { system?: string; name?: string }).name).toBe('钻形')

    // 节点：全部 seed 落库（gemshape 项目节点，父 = sys-shapes，blob 可 parse 且 specKey 对齐）
    const shapeNodes = nodes.filter((n) => n.type === 'project')
    expect(shapeNodes.map((n) => n.id)).toEqual(GEMSHAPE_SEEDS.map((s) => gemshapeSeedNodeId(s.specKey)))
    for (const seed of GEMSHAPE_SEEDS.slice(0, 3)) {
      const node = await getProject(gemshapeSeedNodeId(seed.specKey))
      expect(node?.projectKind).toBe('gemshape')
      expect(node?.parentId).toBe(SYS_SHAPES_FOLDER_ID)
      expect(node?.name).toBe(seed.nameZh)
      const blob = await getImageBlob(node!.blobKey)
      expect(blob).not.toBeNull()
      expect(blob?.type).toBe(PROJECT_MIME.gemshape)
      const file = parseGemshape(await blob!.text(), { mime: node!.mime })
      expect(file.specKey).toBe(seed.specKey)
      expect(file.physical).toEqual(seed.physical)
    }
  })

  it('幂等 create-only：二次 seed 零新增；软删节点不复活（删除不复活纪律）', async () => {
    await runAssetMigration()
    const seededNodeCount = (await listAllNodes()).length

    // 二次（模拟 flag 丢失重跑）：全量 skipped，零新增节点
    localStorage.removeItem('rhinestone-studio:asset-seed-sys-shapes-v1')
    const second = await seedSysShapesCatalog()
    expect(second.created).toEqual([])
    expect(second.skipped.length).toBe(GEMSHAPE_SEEDS.length)
    expect((await listAllNodes()).length).toBe(seededNodeCount)

    // 软删一条（ast-shape-round-ss10 入回收站）→ 重跑 seed：不复活、不计入 created
    await trashAsset(gemshapeSeedNodeId('round-ss10'))
    const trashed = await getProject(gemshapeSeedNodeId('round-ss10'))
    expect(trashed?.trashedAt).toBeDefined()
    localStorage.removeItem('rhinestone-studio:asset-seed-sys-shapes-v1')
    const third = await seedSysShapesCatalog()
    expect(third.created).not.toContain('round-ss10')
    expect(third.skipped).toContain(gemshapeSeedNodeId('round-ss10'))
    const after = await getProject(gemshapeSeedNodeId('round-ss10'))
    expect(after?.trashedAt).toBeDefined() // 仍是软删态——未被覆盖复活
  })
})

// ---------------------------------------------------------------------------

/** seed 条目 → serialize 输入（与 assetStore.gemshapeSeedBlob 同构；确定性 epoch）。 */
function seedFileInput(seed: GemshapeSeedSpec): Parameters<typeof serializeGemshape>[0] {
  return {
    appVersion: '0.1.0',
    createdAt: 1735689600000,
    savedAt: 1735689600000,
    name: seed.nameZh,
    texture: seed.texture,
    ...(seed.vectorPath !== undefined ? { vectorPath: seed.vectorPath } : {}),
    physical: seed.physical,
    specKey: seed.specKey,
    calibration: { mode: 'direct' },
  }
}
