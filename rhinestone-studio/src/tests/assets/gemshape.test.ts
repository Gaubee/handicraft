/**
 * `.gemshape` parser schema gate 六条 + fixture 矩阵（gem-catalog W0 0.4，design §1.4）：
 * - fixture 矩阵：texture-only / both（texture+vectorPath）两类合法输入 parse+verify+round-trip；
 *   vector-only（texture 缺席）坏输入 typed error 拒收（R3 P0-1 修复冻结）
 * - 六条 gate 各一坏输入用例（宽高不符 / MIME·字节·像素超限 / 全透明 / fit 比例漂移 /
 *   悬空校准 / missing 资产禁静默导出）
 * - 校准烘焙函数（direct / reference 两模式）+ alphaBounds + vectorPath 单位框校验
 * - ProjectKind/PROJECT_MIME 第五值
 * 纯函数测试：贴图解码器注入确定性替身（无 canvas 依赖）。
 */

import { describe, expect, it } from 'vitest'
import { SS_TABLE } from '$lib/engine'
import {
  GEMSHAPE_FIT_TOLERANCE,
  GEMSHAPE_FORMAT_VERSION,
  GEMSHAPE_TEXTURE_MAX_BYTES,
  GEMSHAPE_TEXTURE_MAX_PIXELS,
  GemshapeFieldError,
  GemshapeKindError,
  GemshapeRefError,
  alphaBounds,
  assertGemshapeRefs,
  bakeCalibrationPhysical,
  parseGemshape,
  serializeGemshape,
  verifyGemshapeTexture,
  type GemshapeFileInput,
  type GemshapeTextureDecoder,
} from '$lib/persistence/gemshapeFile'
import { PROJECT_MIME, projectKindOfMime } from '$lib/persistence/projectTypes'

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错但未抛出')
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('预期拒绝但已兑现')
}

// ---------------------------------------------------------------------------
// 样本：合法 .gemshape（texture-only / both）+ 确定性解码替身
// ---------------------------------------------------------------------------

const TEXTURE_PIXELS = 'iVBORw0KGgo' // 任意非空 base64 载荷（解码替身不消费内容）
const TEXTURE_DATA_URL = `data:image/png;base64,${TEXTURE_PIXELS}`

const textureOnlyInput: GemshapeFileInput = {
  appVersion: '0.1.0-test',
  createdAt: 1758000000111,
  savedAt: 1758000000222,
  name: '圆钻 SS10',
  texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 32, height: 32 },
  physical: { widthMm: 2.8, heightMm: 2.8 },
  specKey: 'round-ss10',
  calibration: { mode: 'direct' },
}

const bothInput: GemshapeFileInput = {
  ...textureOnlyInput,
  name: '水滴 4.3mm',
  vectorPath: 'M 0.5 0.05 L 0.9 0.6 L 0.5 0.95 L 0.1 0.6 Z',
  physical: { widthMm: 3.0, heightMm: 4.3 },
  specKey: 'drop-4.3',
}

/** 确定性解码替身：按参数合成像素面（alpha>0 的内容区 = bounds 判据源）。 */
function makeDecoder(width: number, height: number, alphaFill: (x: number, y: number) => number): GemshapeTextureDecoder {
  return async () => {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        data[i] = 200
        data[i + 1] = 16
        data[i + 2] = 46
        data[i + 3] = alphaFill(x, y)
      }
    }
    return { width, height, data }
  }
}

const fullOpaqueDecoder = makeDecoder(32, 32, () => 255)
/** 中央 20×10 不透明区（bounds 20×10 → 主径 20px；纵横比 2.0）。 */
const centerStripDecoder = makeDecoder(32, 32, (x, y) => (x >= 6 && x < 26 && y >= 11 && y < 21 ? 255 : 0))
const allTransparentDecoder = makeDecoder(32, 32, () => 0)

// ---------------------------------------------------------------------------
// fixture 矩阵（0.4 验收原文）：texture-only / both 合法 + vector-only 拒收
// ---------------------------------------------------------------------------

describe('gemshape fixture 矩阵（W0 0.4）', () => {
  it('texture-only 合法：parse + verify（解码三 gate）+ serialize→parse→serialize 字节等价', async () => {
    const text = serializeGemshape(textureOnlyInput)
    const file = parseGemshape(text, { mime: PROJECT_MIME.gemshape })
    expect(file.kind).toBe('gemshape')
    expect(file.formatVersion).toBe(1)
    expect(file.specKey).toBe('round-ss10')
    expect(file.vectorPath).toBeUndefined()
    const verification = await verifyGemshapeTexture(file, fullOpaqueDecoder)
    expect(verification.bounds).toEqual({ x: 0, y: 0, w: 32, h: 32 })
    expect(verification.majorAxisPx).toBe(32)
    expect(serializeGemshape({ ...file })).toBe(text)
    const roundTripped = parseGemshape(text)
    expect(serializeGemshape({ ...roundTripped })).toBe(text)
  })

  it('both（texture + vectorPath）合法：并存 round-trip；vectorPath 单位框校验通过', async () => {
    const text = serializeGemshape(bothInput)
    expect(text).toContain('"vectorPath"')
    const file = parseGemshape(text)
    expect(file.vectorPath).toBe(bothInput.vectorPath)
    // 水滴 physical 纵横比 3/4.3≈0.698 vs 方形 bounds 1.0 → fit gate 拒（兼证 gate 4）
    const drifted = await captureRejection(verifyGemshapeTexture(file, fullOpaqueDecoder))
    expect(drifted).toBeInstanceOf(GemshapeFieldError)
    expect((drifted as GemshapeFieldError).path).toBe('physical')
    // bounds 纵横比 ≈ physical（16×23 → 0.696 vs 0.698，容差内）→ 合法
    const ok = await verifyGemshapeTexture(
      parseGemshape(serializeGemshape(bothInput)),
      makeDecoder(32, 32, (x, y) => (x >= 8 && x < 24 && y >= 4 && y < 27 ? 255 : 0)),
    )
    expect(ok.majorAxisPx).toBe(23)
    expect(serializeGemshape({ ...parseGemshape(text) })).toBe(text)
  })

  it('vector-only（texture 缺席）→ typed error 拒收（R3 P0-1：vectorPath 仅为可选加速字段）', () => {
    const vectorOnly = {
      kind: 'gemshape',
      formatVersion: 1,
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '矢量-only 钻形',
      vectorPath: 'M 0.1 0.1 L 0.9 0.9 Z',
      physical: { widthMm: 3, heightMm: 3 },
      calibration: { mode: 'direct' },
    }
    const error = captureError(() => parseGemshape(JSON.stringify(vectorOnly)))
    expect(error).toBeInstanceOf(GemshapeFieldError)
    expect((error as GemshapeFieldError).path).toBe('texture')
    expect((error as GemshapeFieldError).found).toContain('vector-only')
    expect((error as GemshapeFieldError).expected).toContain('钻石素材图必备')
  })
})

// ---------------------------------------------------------------------------
// 六条 gate 各一坏输入用例
// ---------------------------------------------------------------------------

describe('gemshape 六条 schema gate（W0 0.4）', () => {
  it('gate 1：解码实测宽高与声明不符 → 拒收（声明值不是信任源）', async () => {
    const file = parseGemshape(serializeGemshape(textureOnlyInput)) // 声明 32×32
    const wrongDims = makeDecoder(31, 32, () => 255)
    const error = await captureRejection(verifyGemshapeTexture(file, wrongDims))
    expect(error).toBeInstanceOf(GemshapeFieldError)
    expect((error as GemshapeFieldError).path).toBe('texture.width')
    expect((error as GemshapeFieldError).found).toContain('实测 31×32')
  })

  it('gate 2a：MIME 不在白名单 → parse 拒收（路径 texture.mime）', () => {
    const bad = serializeGemshape(textureOnlyInput).replace('image/png', 'image/avif')
    const error = captureError(() => parseGemshape(bad))
    expect((error as GemshapeFieldError).path).toBe('texture.mime')
  })

  it('gate 2b：贴图字节超上限 → parse 拒收（路径 texture.dataUrl）', () => {
    const hugePayload = 'A'.repeat(Math.ceil((GEMSHAPE_TEXTURE_MAX_BYTES + 1024) * (4 / 3)))
    const huge: GemshapeFileInput = {
      ...textureOnlyInput,
      texture: {
        mime: 'image/png',
        dataUrl: `data:image/png;base64,${hugePayload}`,
        width: 32,
        height: 32,
      },
    }
    const error = captureError(() => parseGemshape(serializeGemshape(huge)))
    expect((error as GemshapeFieldError).path).toBe('texture.dataUrl')
    expect((error as GemshapeFieldError).expected).toContain('字节')
  })

  it('gate 2c：声明像素超上限 → parse 拒收（实测面由 gate 1 宽高一致 + 本预检共同封死）', () => {
    const declared: GemshapeFileInput = {
      ...textureOnlyInput,
      texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 2000, height: 1100 },
    }
    const error = captureError(() => parseGemshape(serializeGemshape(declared)))
    expect((error as GemshapeFieldError).path).toBe('texture')
    expect((error as GemshapeFieldError).found).toContain('2000×1100')
  })

  it('gate 3：全透明（空 alpha bounds）→ 拒收（主径/换算取 alpha 内容 bounds）', async () => {
    const file = parseGemshape(serializeGemshape(textureOnlyInput))
    const error = await captureRejection(verifyGemshapeTexture(file, allTransparentDecoder))
    expect((error as GemshapeFieldError).path).toBe('texture.alphaBounds')
    expect((error as GemshapeFieldError).found).toContain('全透明')
  })

  it('gate 4：physical 与 alpha bounds 纵横比超容差 → 拒收（不做静默裁剪/contain）', async () => {
    // bounds 20×10（纵横比 2.0）；physical 2.8×2.8（1.0）→ 偏差 100% >> 2%
    const file = parseGemshape(serializeGemshape(textureOnlyInput))
    const error = await captureRejection(verifyGemshapeTexture(file, centerStripDecoder))
    expect((error as GemshapeFieldError).path).toBe('physical')
    expect((error as GemshapeFieldError).found).toContain('比例漂移')
    // 容差内（physical 2.0×1.0 vs bounds 2.0）→ 通过
    const within: GemshapeFileInput = { ...textureOnlyInput, physical: { widthMm: 2, heightMm: 1 } }
    const ok = await verifyGemshapeTexture(parseGemshape(serializeGemshape(within)), centerStripDecoder)
    expect(ok.majorAxisPx).toBe(20)
    void GEMSHAPE_FIT_TOLERANCE
  })

  it('gate 5：reference 校准悬空（无 refSpecId 且无 refSpecSnapshot）→ 拒收', () => {
    const dangling: GemshapeFileInput = {
      ...textureOnlyInput,
      calibration: { mode: 'reference' },
    }
    const error = captureError(() => parseGemshape(serializeGemshape(dangling)))
    expect((error as GemshapeFieldError).path).toBe('calibration.refSpecId')
    expect((error as GemshapeFieldError).found).toContain('悬空')
  })

  it('gate 5（合法面）：refSpecId 可解析 或 内嵌 refSpecSnapshot 二者其一即过', () => {
    const byId = parseGemshape(
      serializeGemshape({ ...textureOnlyInput, calibration: { mode: 'reference', refSpecId: 'round-ss10' } }),
    )
    expect(byId.calibration.refSpecId).toBe('round-ss10')
    const bySnapshot = parseGemshape(
      serializeGemshape({
        ...textureOnlyInput,
        calibration: {
          mode: 'reference',
          refSpecSnapshot: {
            specKey: 'round-ss10',
            ordinal: 1,
            shapeId: 'round',
            sizeLabel: 'SS10',
            diameterMm: SS_TABLE.SS10,
          },
        },
      }),
    )
    expect(bySnapshot.calibration.refSpecSnapshot?.diameterMm).toBe(2.8)
  })

  it('gate 6：missing 资产 typed 禁静默降级导出（四态 + 硬清 not-found）', () => {
    expect(() => assertGemshapeRefs(['ast-1'], () => 'resolved')).not.toThrow()
    for (const state of ['soft-deleted', 'blob-missing', 'wrong-kind'] as const) {
      const error = captureError(() => assertGemshapeRefs(['ast-1'], () => state))
      expect(error).toBeInstanceOf(GemshapeRefError)
      expect((error as GemshapeRefError).assetId).toBe('ast-1')
      expect((error as GemshapeRefError).state).toBe(state)
      expect((error as GemshapeRefError).message).toContain('不回退圆钻轮廓')
    }
    const notFound = captureError(() => assertGemshapeRefs(['ast-x'], () => null))
    expect(notFound).toBeInstanceOf(GemshapeRefError)
    expect((notFound as GemshapeRefError).state).toBe('not-found')
  })
})

// ---------------------------------------------------------------------------
// [R6 P1-1] custom 身份链持久化边界闭合：calibration.refSpecSnapshot custom 规格快照
// 缺 assetId = parse 入口 typed reject（engine customAssetIdMissing 单一语义源）
// ---------------------------------------------------------------------------

describe('gemshape custom assetId typed reject（R6 P1-1）', () => {
  const withCustomSnapshot = serializeGemshape({
    ...textureOnlyInput,
    calibration: {
      mode: 'reference',
      refSpecSnapshot: {
        specKey: 'custom-ast-shape-1',
        ordinal: 1,
        shapeId: 'custom',
        sizeLabel: '自定义 3.2',
        diameterMm: 3.2,
        assetId: 'ast-shape-1',
      },
    },
  })

  it('calibration.refSpecSnapshot shapeId=custom 且 assetId 缺席 → 路径 calibration.refSpecSnapshot.assetId', () => {
    const dirty = withCustomSnapshot.replace(',"assetId":"ast-shape-1"', '')
    const error = captureError(() => parseGemshape(dirty))
    expect(error).toBeInstanceOf(GemshapeFieldError)
    expect((error as GemshapeFieldError).path).toBe('calibration.refSpecSnapshot.assetId')
    expect((error as GemshapeFieldError).message).toContain('custom')
  })

  it('calibration.refSpecSnapshot shapeId=custom 且 assetId 空串 → 同路径拒读（空串 = 缺）', () => {
    const dirty = withCustomSnapshot.replace('"assetId":"ast-shape-1"', '"assetId":""')
    const error = captureError(() => parseGemshape(dirty))
    expect((error as GemshapeFieldError).path).toBe('calibration.refSpecSnapshot.assetId')
  })

  it('serialize 侧运行时脏值（custom 快照无 assetId）同口径拒绝——无半载荷字节产出', () => {
    const error = captureError(() =>
      serializeGemshape({
        ...textureOnlyInput,
        calibration: {
          mode: 'reference',
          refSpecSnapshot: { specKey: 'custom-ast-shape-1', ordinal: 1, shapeId: 'custom', sizeLabel: '自定义 3.2', diameterMm: 3.2 },
        },
      }),
    )
    expect(error).toBeInstanceOf(GemshapeFieldError)
    expect((error as GemshapeFieldError).path).toBe('calibration.refSpecSnapshot.assetId')
  })

  it('合法面不受影响：custom 快照携 assetId round-trip；builtin refSpecSnapshot 零回归', () => {
    const file = parseGemshape(withCustomSnapshot)
    expect(file.calibration.refSpecSnapshot?.assetId).toBe('ast-shape-1')
    expect(serializeGemshape({ ...file })).toBe(withCustomSnapshot)
    // builtin 快照（round，无 assetId）照常（gate 5 合法面既有行为）
    const bySnapshot = parseGemshape(
      serializeGemshape({
        ...textureOnlyInput,
        calibration: {
          mode: 'reference',
          refSpecSnapshot: { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 },
        },
      }),
    )
    expect(bySnapshot.calibration.refSpecSnapshot?.diameterMm).toBe(2.8)
  })
})

// ---------------------------------------------------------------------------
// 校准烘焙（direct / reference 两模式）+ alphaBounds + vectorPath 单位框
// ---------------------------------------------------------------------------

describe('校准烘焙与纯助手（W0 0.4）', () => {
  it('bakeCalibrationPhysical direct：直接物化声明 mm', () => {
    expect(bakeCalibrationPhysical({ w: 56, h: 28 }, { mode: 'direct', widthMm: 3, heightMm: 1.5 })).toEqual({
      widthMm: 3,
      heightMm: 1.5,
    })
  })

  it('bakeCalibrationPhysical reference：alpha bounds 主径 px ÷ 参考规格 mm 反推 physical', () => {
    // bounds 56×28：主径 56px ÷ round-ss10 2.8mm → 20 px/mm → 2.8×1.4mm
    const baked = bakeCalibrationPhysical({ w: 56, h: 28 }, { mode: 'reference', refSpec: { specKey: 'round-ss10', diameterMm: 2.8 } })
    expect(baked.widthMm).toBeCloseTo(2.8, 10)
    expect(baked.heightMm).toBeCloseTo(1.4, 10)
  })

  it('alphaBounds：内容 bounds（非贴图外框）+ 全透明 null + 坏像素面 typed error', () => {
    const image = {
      width: 4,
      height: 3,
      data: new Uint8ClampedArray([
        0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 255, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 7, 7, 5,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
    }
    expect(alphaBounds(image)).toEqual({ x: 2, y: 0, w: 2, h: 2 }) // (2,0) alpha255 与 (3,1) alpha5 → bounds 2×2
    expect(alphaBounds({ width: 2, height: 1, data: new Uint8ClampedArray(8) })).toBeNull()
    const error = captureError(() => alphaBounds({ width: 2, height: 1, data: new Uint8ClampedArray(4) }))
    expect(error).toBeInstanceOf(GemshapeFieldError)
  })

  it('vectorPath 校验：单位框越界 / 弧命令 / 垃圾记号 / 空串 分别拒收；相对命令终点换算', () => {
    const outOfBox = captureError(() =>
      parseGemshape(serializeGemshape({ ...bothInput, vectorPath: 'M 0.1 0.1 L 1.9 0.9 Z' })),
    )
    expect((outOfBox as GemshapeFieldError).path).toBe('vectorPath')
    expect((outOfBox as GemshapeFieldError).found).toContain('越界')

    const arc = captureError(() => parseGemshape(`{"kind":"gemshape","formatVersion":1,"appVersion":"a","createdAt":1,"savedAt":1,"name":"n","texture":{"mime":"image/png","dataUrl":"${TEXTURE_DATA_URL}","width":4,"height":4},"vectorPath":"M 0 0 A 0.5 0.5 0 0 1 1 1 Z","physical":{"widthMm":1,"heightMm":1},"calibration":{"mode":"direct"}}`))
    expect((arc as GemshapeFieldError).path).toBe('vectorPath')

    const garbage = captureError(() => parseGemshape(serializeGemshape({ ...bothInput, vectorPath: 'M 0.1 0.1 X 9' })))
    expect(garbage).toBeInstanceOf(GemshapeFieldError)

    const empty = captureError(() => parseGemshape(serializeGemshape({ ...bothInput, vectorPath: '  ' })))
    expect(empty).toBeInstanceOf(GemshapeFieldError)

    // 相对命令：m 0.1 0.1 l 0.2 0 → 终点 (0.3, 0.1) 在框内 ✓
    expect(() =>
      parseGemshape(serializeGemshape({ ...bothInput, vectorPath: 'm 0.1 0.1 l 0.2 0 l 0.4 0.4 z' })),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 信封门（kind/MIME/formatVersion）+ ProjectKind 第五值
// ---------------------------------------------------------------------------

describe('gemshape 信封门与第五格式登记（W0 0.4）', () => {
  it('kind 错 / MIME 错 / formatVersion 超前 → 可辨 typed error', () => {
    const kindError = captureError(() => parseGemprojAsGemshape())
    expect(kindError).toBeInstanceOf(GemshapeKindError)
    expect((kindError as GemshapeKindError).field).toBe('kind')

    const mimeError = captureError(() =>
      parseGemshape(serializeGemshape(textureOnlyInput), { mime: 'application/octet-stream' }),
    )
    expect((mimeError as GemshapeKindError).field).toBe('mime')

    const future = serializeGemshape(textureOnlyInput).replace('"formatVersion":1', '"formatVersion":2')
    const versionError = captureError(() => parseGemshape(future))
    expect((versionError as GemshapeFieldError).path).toBe('formatVersion')
    expect((versionError as GemshapeFieldError).found).toContain('更新版本')
  })

  it('ProjectKind/PROJECT_MIME 第五值 + projectKindOfMime 反查', () => {
    expect(PROJECT_MIME.gemshape).toBe('application/vnd.rhinestone-studio.gemshape+json')
    expect(projectKindOfMime(PROJECT_MIME.gemshape)).toBe('gemshape')
    expect(GEMSHAPE_FORMAT_VERSION).toBe(1)
  })

  it('serialize 侧运行时脏值（direct 携 refSpecId）→ 拒绝产出非法字节', () => {
    const error = captureError(() =>
      serializeGemshape({
        ...textureOnlyInput,
        calibration: { mode: 'direct', refSpecId: 'round-ss10' },
      }),
    )
    expect((error as GemshapeFieldError).path).toBe('calibration.refSpecId')
  })
})

function parseGemprojAsGemshape(): unknown {
  return parseGemshape(JSON.stringify({ kind: 'gemproj', formatVersion: 1 }))
}
