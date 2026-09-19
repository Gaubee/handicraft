/**
 * projectFile 序列化层契约全量（openspec add-project-files design §1.1/§1.2 + §1.3 + §2 + tasks
 * 0.1/0.2/0.3）：
 * round-trip 字节等价（满/最小/仅 savedAt 变化零漂移/键序快照）/ ENGINE_VERSION 消费 /
 * formatVersion 向前拒读 / 迁移链骨架（空链 + 旧版本注入演练）/ 脏输入矩阵（typed error +
 * 点分字段路径）/ SerializedBlock base64 往返 / source 双形态（asset 无 dataUrl 键 · embedded
 * 内嵌烘焙）/ painting dataUrl 字节等价（stub 编解码器）/ MIME 与 PROJECT_MIME 对齐。
 * 纯函数测试：无 IndexedDB、无 localStorage 依赖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_VERSION } from '$lib/engine/version'
import {
  PROJECTFILE_FORMAT_VERSIONS,
  ProjectFileFieldError,
  ProjectFileKindError,
  ProjectFileVersionError,
  dataUrlToPainting,
  fromSerializedBlock,
  maskBitsFromBase64,
  maskBitsToBase64,
  parseGemdoc,
  parseGemproj,
  paintingToDataUrl,
  projectFileMime,
  registerProjectFileMigration,
  serializeGemdoc,
  serializeGemproj,
  toSerializedBlock,
  type GemdocFile,
  type GemdocFileInput,
  type GemprojFile,
  type GemprojFileInput,
} from '$lib/persistence/projectFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import type { Block, EditGem } from '$lib/engine'

// ---------------------------------------------------------------------------
// 样本（满字段 / 最小字段；时间戳取不易撞车的非整值）
// ---------------------------------------------------------------------------

const APP_VERSION = '0.1.0-test'

/** PNG 魔数头 + IHDR 前缀样本（字节断言用，非完整 PNG） */
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES))
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

const PALETTE_FULL = [
  { id: 'red', name: '红', hex: '#C8102E' },
  { id: 'gold', name: '金', hex: '#D4A017' },
  { id: 'ivory', name: '象牙白', hex: '#FFFFF0' },
]

/** 程序化引擎块（3×3 掩码，L 形属块）——SerializedBlock 往返断言的基准。 */
function makeBlock(id: string, label: string): Block {
  return {
    id,
    label,
    mask: { w: 3, h: 3, bits: Uint8Array.from([1, 1, 0, 1, 1, 0, 1, 1, 1]) },
    colorRgb: [200, 16, 46],
    areaPx: 7,
    bbox: { x: 10, y: 20, w: 3, h: 3 },
    widthPx: { max: 3, mean: 2.5 },
    suggested: 'fill',
  }
}

const gemprojFull: GemprojFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000111,
  savedAt: 1758000000222,
  name: '节日花环·排钻工程',
  source: {
    kind: 'asset',
    assetId: 'ast-img-src-1',
    name: '花环原图.png',
    width: 960,
    height: 720,
    downscale: 0.9375,
  },
  reference: { assetId: 'ast-img-ref-1', name: '参考原图.jpg' },
  segment: { k: 8, seed: 1 },
  overrides: {
    disabled: { 'blk-2': true },
    density: { 'blk-3': 0.5, 'blk-4': 1 },
    type: { 'blk-2': 'linear' },
    color: { 'blk-5': 'gold' },
  },
  physics: {
    ss: 'SS10',
    gapMm: 0.4,
    globalDensity: 1,
    relax: { boundary: true, repulsion: true },
  },
  palette: PALETTE_FULL,
  activeStrategy: 'hybrid',
}

const gemprojMinimal: GemprojFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000333,
  savedAt: 1758000000333,
  name: '工程 2',
  source: { kind: 'asset', assetId: 'ast-img-src-2', name: 'b.png', width: 64, height: 48, downscale: 1 },
  segment: { k: 6, seed: 0 },
  overrides: { disabled: {}, density: {}, type: {}, color: {} },
  physics: { ss: 'SS6', gapMm: 0.8, globalDensity: 0.5, relax: { boundary: false, repulsion: false } },
  palette: [{ id: 'black', name: '黑', hex: '#1A1A1A' }],
  activeStrategy: 'poisson',
}

/** source 双形态之 embedded：导出磁盘时烘焙的原始图字节（dataUrl 只存在文件字节）。 */
const gemprojEmbedded: GemprojFileInput = {
  ...gemprojFull,
  source: {
    kind: 'embedded',
    name: '花环原图.png',
    mime: 'image/png',
    dataUrl: PNG_DATA_URL,
    width: 960,
    height: 720,
    downscale: 0.9375,
  },
}

const LAYOUT_GEM: EditGem = {
  id: 'g00001',
  x: 12.5,
  y: 20.25,
  colorId: 'red',
  blockId: 'blk-1',
  origin: 'layout',
  moved: false,
}
/** 手工钻 + 移动钻（origin/moved/'m-' 前缀语义原样入档） */
const MANUAL_GEM: EditGem = {
  id: 'm-3',
  x: 88,
  y: 64,
  colorId: 'gold',
  blockId: null,
  origin: 'manual',
  moved: false,
}
const MOVED_GEM: EditGem = {
  id: 'g00002',
  x: 40,
  y: 32,
  colorId: 'ivory',
  blockId: 'blk-1',
  origin: 'layout',
  moved: true,
}

const gemdocFull: GemdocFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000444,
  savedAt: 1758000000555,
  name: '节日花环·精修文档',
  width: 960,
  height: 720,
  grid: { ss: 'SS10', pitchMm: 3.2, rowAngleDeg: 0, pixelsPerMm: 2.5 },
  palette: PALETTE_FULL,
  gems: [LAYOUT_GEM, MOVED_GEM, MANUAL_GEM],
  blocks: [makeBlock('blk-1', '花环主体'), makeBlock('blk-2', '缎带')],
  layers: {
    painting: { visible: true, opacity: 1 },
    reference: { visible: true, opacity: 0.6 },
    blocks: { visible: false, opacity: 0.9 },
    gems: { visible: true, opacity: 1 },
  },
  painting: { mime: 'image/png', dataUrl: PNG_DATA_URL },
  reference: { assetId: 'ast-img-ref-1', name: '参考原图.jpg' },
  provenance: {
    origin: 'studio-bake',
    sourceSummary: '语义混合 · 密度 100% · SS10 · 358 钻',
    sourceAssetId: 'ast-img-src-1',
    gemprojAssetId: 'ast-prj-gemproj-1',
  },
}

const gemdocMinimal: GemdocFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000666,
  savedAt: 1758000000666,
  name: '快排 1',
  width: 64,
  height: 48,
  grid: { ss: 'SS6', pitchMm: 2.4, rowAngleDeg: 0, pixelsPerMm: 2.5 },
  palette: [{ id: 'black', name: '黑', hex: '#1A1A1A' }],
  gems: [LAYOUT_GEM],
  blocks: [makeBlock('blk-1', '主体')],
  layers: {
    painting: { visible: true, opacity: 1 },
    reference: { visible: true, opacity: 0.6 },
    blocks: { visible: true, opacity: 0.9 },
    gems: { visible: true, opacity: 1 },
  },
  painting: { mime: 'image/png', dataUrl: PNG_DATA_URL },
  provenance: { origin: 'quick-layout', sourceSummary: '语义混合 · 密度 100% · SS10 · 12 钻' },
}

/** 捕获式断言辅助：返回抛出的错误实例（避免断言链丢失字段访问）。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错但未抛出')
}

/** 异步版：捕获 Promise 拒绝的错误实例。 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('预期拒绝但已兑现')
}

/** 仅 savedAt 替换（键值对精确匹配，避免时间戳数字在别处出现造成的误替换）。 */
function withSavedAt(serialized: string, oldSavedAt: number, newSavedAt: number): string {
  return serialized.replace(`"savedAt":${oldSavedAt}`, `"savedAt":${newSavedAt}`)
}

// ---------------------------------------------------------------------------
// round-trip 字节等价（§1.3 纪律：每次 bump 附往返测试）
// ---------------------------------------------------------------------------

describe('projectFile round-trip 字节等价', () => {
  it('gemproj 满字段（asset 来源）：serialize→parse→serialize 字节等价', () => {
    const s1 = serializeGemproj(gemprojFull)
    const s2 = serializeGemproj(parseGemprojToInput(parseGemproj(s1)))
    expect(s2).toBe(s1)
  })

  it('gemproj 最小字段：字节等价（可选键缺席不落键、空覆写四表落空对象）', () => {
    const s1 = serializeGemproj(gemprojMinimal)
    expect(s1).not.toContain('"reference"')
    const s2 = serializeGemproj(parseGemprojToInput(parseGemproj(s1)))
    expect(s2).toBe(s1)
  })

  it('gemproj embedded 来源：字节等价（dataUrl 内嵌形态往返稳定）', () => {
    const s1 = serializeGemproj(gemprojEmbedded)
    const s2 = serializeGemproj(parseGemprojToInput(parseGemproj(s1)))
    expect(s2).toBe(s1)
  })

  it('gemdoc 满字段：serialize→parse→serialize 字节等价', () => {
    const s1 = serializeGemdoc(gemdocFull)
    const s2 = serializeGemdoc(gemdocToFileInput(parseGemdoc(s1)))
    expect(s2).toBe(s1)
  })

  it('gemdoc 最小字段：字节等价', () => {
    const s1 = serializeGemdoc(gemdocMinimal)
    const s2 = serializeGemdoc(gemdocToFileInput(parseGemdoc(s1)))
    expect(s2).toBe(s1)
  })

  it('仅 savedAt 变化的重序列化：其余字节零漂移（两格式）', () => {
    const p1 = serializeGemproj(gemprojFull)
    const p2 = withSavedAt(p1, gemprojFull.savedAt, gemprojFull.savedAt + 1000)
    expect(serializeGemproj({ ...parseGemprojToInput(parseGemproj(p1)), savedAt: gemprojFull.savedAt + 1000 })).toBe(p2)

    const d1 = serializeGemdoc(gemdocFull)
    const d2 = withSavedAt(d1, gemdocFull.savedAt, gemdocFull.savedAt + 1000)
    expect(
      serializeGemdoc({ ...gemdocToFileInput(parseGemdoc(d1)), savedAt: gemdocFull.savedAt + 1000 }),
    ).toBe(d2)
  })

  it('键序 = schema 声明序（确定性序列化的回归快照）', () => {
    expect(Object.keys(JSON.parse(serializeGemproj(gemprojFull)))).toEqual([
      'kind', 'formatVersion', 'appVersion', 'engineVersion', 'createdAt', 'savedAt', 'name',
      'source', 'reference', 'segment', 'overrides', 'physics', 'palette', 'activeStrategy',
    ])
    expect(Object.keys(JSON.parse(serializeGemproj(gemprojFull)).overrides)).toEqual([
      'disabled', 'density', 'type', 'color',
    ])
    expect(Object.keys(JSON.parse(serializeGemproj(gemprojFull)).physics)).toEqual([
      'ss', 'gapMm', 'globalDensity', 'relax',
    ])
    expect(Object.keys(JSON.parse(serializeGemproj(gemprojFull)).source)).toEqual([
      'kind', 'assetId', 'name', 'width', 'height', 'downscale',
    ])
    expect(Object.keys(JSON.parse(serializeGemproj(gemprojEmbedded)).source)).toEqual([
      'kind', 'name', 'mime', 'dataUrl', 'width', 'height', 'downscale',
    ])
    expect(Object.keys(JSON.parse(serializeGemdoc(gemdocFull)))).toEqual([
      'kind', 'formatVersion', 'appVersion', 'engineVersion', 'createdAt', 'savedAt', 'name',
      'width', 'height', 'grid', 'palette', 'gems', 'blocks', 'layers', 'painting', 'reference',
      'provenance',
    ])
    expect(Object.keys(JSON.parse(serializeGemdoc(gemdocFull)).layers)).toEqual([
      'painting', 'reference', 'blocks', 'gems',
    ])
    expect(Object.keys(JSON.parse(serializeGemdoc(gemdocFull)).provenance)).toEqual([
      'origin', 'sourceSummary', 'sourceAssetId', 'gemprojAssetId',
    ])
    expect(Object.keys(JSON.parse(serializeGemdoc(gemdocMinimal)).provenance)).toEqual([
      'origin', 'sourceSummary',
    ])
  })

  it('覆写四表按遭遇序往返（Record 键序稳定，不排序不丢键）', () => {
    const s1 = serializeGemproj(gemprojFull)
    const raw = JSON.parse(s1) as { overrides: { density: Record<string, number> } }
    expect(Object.keys(raw.overrides.density)).toEqual(['blk-3', 'blk-4'])
    const s2 = serializeGemproj(parseGemprojToInput(parseGemproj(s1)))
    expect(s2).toBe(s1)
  })
})

/** parse 产物 → 再次 serialize 的输入形态（gemproj：文件字段即输入字段）。 */
function parseGemprojToInput(file: GemprojFile): GemprojFileInput {
  const { kind, formatVersion, engineVersion, ...input } = file
  void kind
  void formatVersion
  void engineVersion
  return input
}

/** parse 产物 → 再次 serialize 的输入形态（gemdoc：SerializedBlock → 引擎 Block）。 */
function gemdocToFileInput(file: GemdocFile): GemdocFileInput {
  const { kind, formatVersion, engineVersion, blocks, ...rest } = file
  void kind
  void formatVersion
  void engineVersion
  return { ...rest, blocks: blocks.map(fromSerializedBlock) }
}

// ---------------------------------------------------------------------------
// 版本纪律（§1.3：向前拒读 / 非整数 / 空链）+ ENGINE_VERSION 消费（tasks 0.1）
// ---------------------------------------------------------------------------

describe('projectFile 版本纪律', () => {
  it('PROJECTFILE_FORMAT_VERSIONS：两格式当前均为 v1', () => {
    expect(PROJECTFILE_FORMAT_VERSIONS).toEqual({ gemproj: 1, gemdoc: 1 })
  })

  it('ENGINE_VERSION 常量被两格式序列化消费（写入当前引擎语义身份）', () => {
    const gemproj = parseGemproj(serializeGemproj(gemprojFull))
    expect(gemproj.engineVersion).toBe(ENGINE_VERSION)
    expect(serializeGemproj(gemprojFull)).toContain(`"engineVersion":${ENGINE_VERSION}`)
    const gemdoc = parseGemdoc(serializeGemdoc(gemdocFull))
    expect(gemdoc.engineVersion).toBe(ENGINE_VERSION)
    expect(serializeGemdoc(gemdocFull)).toContain(`"engineVersion":${ENGINE_VERSION}`)
  })

  it('gemproj formatVersion+1 → ProjectFileVersionError「文件来自更新版本的应用」且不解析', () => {
    const future = serializeGemproj(gemprojFull).replace('"formatVersion":1', '"formatVersion":2')
    const error = captureError(() => parseGemproj(future))
    expect(error).toBeInstanceOf(ProjectFileVersionError)
    expect((error as ProjectFileVersionError).foundVersion).toBe(2)
    expect((error as ProjectFileVersionError).message).toContain('文件来自更新版本的应用')
  })

  it('gemdoc formatVersion+1 → ProjectFileVersionError 且不解析', () => {
    const future = serializeGemdoc(gemdocFull).replace('"formatVersion":1', '"formatVersion":99')
    const error = captureError(() => parseGemdoc(future))
    expect(error).toBeInstanceOf(ProjectFileVersionError)
    expect((error as ProjectFileVersionError).foundVersion).toBe(99)
  })

  it('formatVersion 0（旧版本且迁移链为空，用 gemdoc 验证）→ 版本错误报迁移路径缺失', () => {
    const legacy = serializeGemdoc(gemdocFull).replace('"formatVersion":1', '"formatVersion":0')
    const error = captureError(() => parseGemdoc(legacy))
    expect(error).toBeInstanceOf(ProjectFileVersionError)
    expect((error as ProjectFileVersionError).message).toContain('缺少 v0→v1 的迁移路径')
  })

  it('formatVersion 非整数 → ProjectFileFieldError(formatVersion)', () => {
    const bad = serializeGemproj(gemprojFull).replace('"formatVersion":1', '"formatVersion":1.5')
    const error = captureError(() => parseGemproj(bad))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('formatVersion')
  })
})

// ---------------------------------------------------------------------------
// 迁移链骨架（tasks 0.3：注册表注入 + 旧版本演练；注册为模块态，只在本测试文件内生效）
// ---------------------------------------------------------------------------

describe('projectFile 迁移链注入演练', () => {
  it('注册 gemproj v0→v1 迁移后：v0 旧档（缺 engineVersion/gapMm）补全为 v1 可解析', () => {
    registerProjectFileMigration('gemproj', 0, 1, (data) => ({
      ...data,
      engineVersion: 0,
      physics: { ...(data.physics as Record<string, unknown>), gapMm: 0.4 },
    }))
    // v0 假想旧档：v1 产物剥掉 engineVersion、抹掉 gapMm（迁移器负责补全）
    const v0doc = JSON.parse(serializeGemproj(gemprojFull)) as Record<string, unknown>
    delete v0doc.engineVersion
    v0doc.formatVersion = 0
    const physics = v0doc.physics as Record<string, unknown>
    delete physics.gapMm
    const migrated = parseGemproj(JSON.stringify(v0doc))
    expect(migrated.formatVersion).toBe(1)
    expect(migrated.engineVersion).toBe(0) // 迁移记旧语义身份（≠ 当前 ENGINE_VERSION → 漂移横幅口径）
    expect(migrated.physics.gapMm).toBe(0.4)
    expect(migrated.name).toBe(gemprojFull.name)
  })

  it('迁移后文档 round-trip 字节等价（§1.3 纪律）', () => {
    const v0doc = JSON.parse(serializeGemproj(gemprojFull)) as Record<string, unknown>
    delete v0doc.engineVersion
    v0doc.formatVersion = 0
    const text = JSON.stringify(v0doc)
    const s1 = serializeGemproj(parseGemprojToInput(parseGemproj(text)))
    const s2 = serializeGemproj(parseGemprojToInput(parseGemproj(s1)))
    expect(s2).toBe(s1)
  })
})

// ---------------------------------------------------------------------------
// kind/MIME 交叉校验（design §2）
// ---------------------------------------------------------------------------

describe('projectFile kind/MIME 交叉校验', () => {
  it('serialize 产物 MIME 与 PROJECT_MIME 对齐（唯一真源消费，不重定义）', () => {
    expect(projectFileMime('gemproj')).toBe(PROJECT_MIME.gemproj)
    expect(projectFileMime('gemdoc')).toBe(PROJECT_MIME.gemdoc)
  })

  it('kind 错（gemdoc 文本喂 parseGemproj）→ ProjectFileKindError', () => {
    const error = captureError(() => parseGemproj(serializeGemdoc(gemdocFull)))
    expect(error).toBeInstanceOf(ProjectFileKindError)
    expect((error as ProjectFileKindError).field).toBe('kind')
  })

  it('MIME 不符 → ProjectFileKindError(mime)', () => {
    const error = captureError(() => parseGemproj(serializeGemproj(gemprojFull), { mime: PROJECT_MIME.gemdoc }))
    expect(error).toBeInstanceOf(ProjectFileKindError)
    expect((error as ProjectFileKindError).field).toBe('mime')
  })

  it('MIME 门先于 JSON 解析（坏文本 + 错 MIME → 报 MIME 不符）', () => {
    const error = captureError(() => parseGemdoc('not-json', { mime: 'application/octet-stream' }))
    expect(error).toBeInstanceOf(ProjectFileKindError)
  })
})

// ---------------------------------------------------------------------------
// 脏输入矩阵（typed error + 点分字段路径）
// ---------------------------------------------------------------------------

describe('projectFile 脏输入矩阵 · gemproj', () => {
  const base = serializeGemproj(gemprojFull)

  function mutated(mutate: (doc: Record<string, unknown>) => void): string {
    const doc = JSON.parse(base) as Record<string, unknown>
    mutate(doc)
    return JSON.stringify(doc)
  }

  it('非 JSON 文本 → ProjectFileFieldError(文档根)', () => {
    const error = captureError(() => parseGemproj('oops{'))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('')
  })

  it('数组根 → ProjectFileFieldError(文档根)', () => {
    const error = captureError(() => parseGemproj('[]'))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('')
  })

  it('缺 kind → 路径 kind', () => {
    const error = captureError(() => parseGemproj(mutated((d) => { delete d.kind })))
    expect((error as ProjectFileFieldError).path).toBe('kind')
  })

  it('source.kind 非法 → 路径 source.kind', () => {
    const error = captureError(() =>
      parseGemproj(mutated((d) => { (d.source as Record<string, unknown>).kind = 'inline' })),
    )
    expect((error as ProjectFileFieldError).path).toBe('source.kind')
  })

  it('source embedded dataUrl 非 data URL → 路径 source.dataUrl', () => {
    const doc = JSON.parse(serializeGemproj(gemprojEmbedded)) as Record<string, unknown>
    ;(doc.source as Record<string, unknown>).dataUrl = 'http://x/y.png'
    const error = captureError(() => parseGemproj(JSON.stringify(doc)))
    expect((error as ProjectFileFieldError).path).toBe('source.dataUrl')
  })

  it('source embedded 头部 mime 与 source.mime 不一致 → 路径 source.dataUrl', () => {
    const doc = JSON.parse(serializeGemproj(gemprojEmbedded)) as Record<string, unknown>
    ;(doc.source as Record<string, unknown>).mime = 'image/jpeg'
    const error = captureError(() => parseGemproj(JSON.stringify(doc)))
    expect((error as ProjectFileFieldError).path).toBe('source.dataUrl')
  })

  it('segment.k 越界（11）→ 路径 segment.k', () => {
    const error = captureError(() =>
      parseGemproj(mutated((d) => { (d.segment as Record<string, unknown>).k = 11 })),
    )
    expect((error as ProjectFileFieldError).path).toBe('segment.k')
  })

  it('physics.ss 非法 → 路径 physics.ss', () => {
    const error = captureError(() =>
      parseGemproj(mutated((d) => { (d.physics as Record<string, unknown>).ss = 'SS11' })),
    )
    expect((error as ProjectFileFieldError).path).toBe('physics.ss')
  })

  it('overrides.density 块值 1.5 → 路径 overrides.density.blk-3', () => {
    const error = captureError(() =>
      parseGemproj(
        mutated((d) => {
          ((d.overrides as Record<string, unknown>).density as Record<string, unknown>)['blk-3'] = 1.5
        }),
      ),
    )
    expect((error as ProjectFileFieldError).path).toBe('overrides.density.blk-3')
  })

  it('overrides.disabled 块值 false → 路径 overrides.disabled.blk-2', () => {
    const error = captureError(() =>
      parseGemproj(
        mutated((d) => {
          ((d.overrides as Record<string, unknown>).disabled as Record<string, unknown>)['blk-2'] = false
        }),
      ),
    )
    expect((error as ProjectFileFieldError).path).toBe('overrides.disabled.blk-2')
  })

  it('serialize 侧运行时脏值（颜色覆写空串）→ 拒绝产出非法字节', () => {
    const error = captureError(() =>
      serializeGemproj({
        ...gemprojFull,
        overrides: { ...gemprojFull.overrides, color: { 'blk-5': '' } },
      }),
    )
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('overrides.color.blk-5')
  })

  it('serialize 侧运行时脏值（掩码长度不符的块走 gemdoc 路径拒绝）', () => {
    const badBlock: Block = { ...makeBlock('blk-x', '坏块'), mask: { w: 3, h: 3, bits: Uint8Array.from([1, 1, 0]) } }
    const error = captureError(() => serializeGemdoc({ ...gemdocFull, blocks: [badBlock] }))
    expect((error as ProjectFileFieldError).path).toBe('blocks.0.mask')
  })
})

describe('projectFile 脏输入矩阵 · gemdoc', () => {
  const base = serializeGemdoc(gemdocFull)

  function mutated(mutate: (doc: Record<string, unknown>) => void): string {
    const doc = JSON.parse(base) as Record<string, unknown>
    mutate(doc)
    return JSON.stringify(doc)
  }

  it('gems 缺键 → 路径 gems', () => {
    const error = captureError(() => parseGemdoc(mutated((d) => { delete d.gems })))
    expect((error as ProjectFileFieldError).path).toBe('gems')
  })

  it('gems.0.origin 非法 → 路径 gems.0.origin', () => {
    const error = captureError(() =>
      parseGemdoc(mutated((d) => { ((d.gems as Array<Record<string, unknown>>)[0] as Record<string, unknown>).origin = 'magic' })),
    )
    expect((error as ProjectFileFieldError).path).toBe('gems.0.origin')
  })

  it('gems.2.blockId 非字符串非 null → 路径 gems.2.blockId', () => {
    const error = captureError(() =>
      parseGemdoc(mutated((d) => { ((d.gems as Array<Record<string, unknown>>)[2] as Record<string, unknown>).blockId = 7 })),
    )
    expect((error as ProjectFileFieldError).path).toBe('gems.2.blockId')
  })

  it('blocks 非数组 → 路径 blocks', () => {
    const error = captureError(() => parseGemdoc(mutated((d) => { d.blocks = 'many' })))
    expect((error as ProjectFileFieldError).path).toBe('blocks')
  })

  it('blocks.1.mask.bits 坏 base64 → 路径 blocks.1.mask.bits', () => {
    const error = captureError(() =>
      parseGemdoc(
        mutated((d) => {
          (((d.blocks as Array<Record<string, unknown>>)[1] as Record<string, unknown>).mask as Record<string, unknown>).bits = 'a*b!'
        }),
      ),
    )
    expect((error as ProjectFileFieldError).path).toBe('blocks.1.mask.bits')
  })

  it('blocks.0.mask.bits 解码长度与 w×h 不符 → 路径 blocks.0.mask.bits', () => {
    const error = captureError(() =>
      parseGemdoc(
        mutated((d) => {
          (((d.blocks as Array<Record<string, unknown>>)[0] as Record<string, unknown>).mask as Record<string, unknown>).bits = btoa('ab')
        }),
      ),
    )
    expect((error as ProjectFileFieldError).path).toBe('blocks.0.mask.bits')
  })

  it('layers.blocks.opacity 1.5 → 路径 layers.blocks.opacity', () => {
    const error = captureError(() =>
      parseGemdoc(mutated((d) => { ((d.layers as Record<string, unknown>).blocks as Record<string, unknown>).opacity = 1.5 })),
    )
    expect((error as ProjectFileFieldError).path).toBe('layers.blocks.opacity')
  })

  it('painting.dataUrl 非 PNG → 路径 painting.dataUrl', () => {
    const error = captureError(() =>
      parseGemdoc(mutated((d) => { (d.painting as Record<string, unknown>).dataUrl = 'data:image/jpeg;base64,QUJD' })),
    )
    expect((error as ProjectFileFieldError).path).toBe('painting.dataUrl')
  })

  it('provenance.origin 非法 → 路径 provenance.origin', () => {
    const error = captureError(() =>
      parseGemdoc(mutated((d) => { (d.provenance as Record<string, unknown>).origin = 'import' })),
    )
    expect((error as ProjectFileFieldError).path).toBe('provenance.origin')
  })

  it('grid.rowAngleDeg 非 0 → 路径 grid.rowAngleDeg', () => {
    const error = captureError(() =>
      parseGemdoc(mutated((d) => { (d.grid as Record<string, unknown>).rowAngleDeg = 15 })),
    )
    expect((error as ProjectFileFieldError).path).toBe('grid.rowAngleDeg')
  })
})

// ---------------------------------------------------------------------------
// SerializedBlock base64 往返（mask.bits Uint8Array ↔ base64 助手）
// ---------------------------------------------------------------------------

describe('projectFile SerializedBlock base64 往返', () => {
  it('toSerializedBlock → fromSerializedBlock：掩码位逐字节相等，其余字段语义不变', () => {
    const block = makeBlock('blk-1', '花环主体')
    const serialized = toSerializedBlock(block, 'blocks.0')
    expect(typeof serialized.mask.bits).toBe('string')
    const restored = fromSerializedBlock(serialized)
    expect(restored.mask.w).toBe(block.mask.w)
    expect(restored.mask.h).toBe(block.mask.h)
    expect(Array.from(restored.mask.bits)).toEqual(Array.from(block.mask.bits))
    expect(restored.colorRgb).toEqual(block.colorRgb)
    expect(restored.bbox).toEqual(block.bbox)
    expect(restored.widthPx).toEqual(block.widthPx)
    expect(restored.suggested).toBe(block.suggested)
    expect(restored.id).toBe(block.id)
  })

  it('maskBitsToBase64 / maskBitsFromBase64：随机字节往返逐字节相等', () => {
    const bytes = Uint8Array.from(Array.from({ length: 257 }, (_, i) => (i * 7) % 256))
    const restored = maskBitsFromBase64(maskBitsToBase64(bytes), 'mask.bits')
    expect(Array.from(restored)).toEqual(Array.from(bytes))
  })

  it('maskBitsFromBase64 非法字符 → ProjectFileFieldError', () => {
    const error = captureError(() => maskBitsFromBase64('ab@cd', 'mask.bits'))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('mask.bits')
  })

  it('gemdoc 全档往返后掩码位逐字节还原（serialize → parse → fromSerializedBlock）', () => {
    const parsed = parseGemdoc(serializeGemdoc(gemdocFull))
    const restored = parsed.blocks.map(fromSerializedBlock)
    restored.forEach((block, i) => {
      expect(Array.from(block.mask.bits)).toEqual(Array.from(gemdocFull.blocks[i].mask.bits))
    })
  })
})

// ---------------------------------------------------------------------------
// source 双形态（design §1.1：库内 asset 引用 / 导出 embedded 烘焙；dataUrl 不驻留）
// ---------------------------------------------------------------------------

describe('projectFile source 双形态', () => {
  it('asset 形态：产物不含 dataUrl 键（库内保存无图字节）；parse 还原 asset 形态', () => {
    const text = serializeGemproj(gemprojFull)
    expect(text).not.toContain('"dataUrl"')
    const parsed = parseGemproj(text)
    expect(parsed.source.kind).toBe('asset')
    expect(parsed.source).toEqual(gemprojFull.source)
  })

  it('embedded 形态：产物含原始图字节 dataUrl；parse 还原 embedded；往返字节等价', () => {
    const text = serializeGemproj(gemprojEmbedded)
    expect(text).toContain(`"dataUrl":"${PNG_DATA_URL}"`)
    const parsed = parseGemproj(text)
    if (parsed.source.kind !== 'embedded') throw new Error('应还原为 embedded 形态')
    expect(parsed.source.dataUrl).toBe(PNG_DATA_URL)
    expect(serializeGemproj(parseGemprojToInput(parsed))).toBe(text)
  })

  it('同工程两形态仅 source 段不同（形态切换 = 烘焙边界唯一变量）', () => {
    const assetText = serializeGemproj(gemprojFull)
    const embeddedText = serializeGemproj(gemprojEmbedded)
    expect(assetText).not.toBe(embeddedText)
    const a = JSON.parse(assetText) as Record<string, unknown>
    const e = JSON.parse(embeddedText) as Record<string, unknown>
    delete a.source
    delete e.source
    expect(a).toEqual(e)
  })

  it('序列化无隐藏状态：同输入两次调用字节相同（dataUrl 序列化即弃，不驻留模块态）', () => {
    expect(serializeGemproj(gemprojEmbedded)).toBe(serializeGemproj(gemprojEmbedded))
    // 输入对象不被就地改写（烘焙不污染调用方持有的 source 形态）
    expect(gemprojEmbedded.source).toEqual({
      kind: 'embedded',
      name: '花环原图.png',
      mime: 'image/png',
      dataUrl: PNG_DATA_URL,
      width: 960,
      height: 720,
      downscale: 0.9375,
    })
  })
})

// ---------------------------------------------------------------------------
// painting ↔ PNG dataUrl 编解码（stub 编解码器：jsdom 无 canvas 实现的确定性替身）
// ---------------------------------------------------------------------------

/**
 * 确定性 stub 编解码器：putImageData/createImageData/drawImage/getImageData 维护位图，
 * toDataURL 编码「8 字节宽高头 + RGBA 原始字节」为 base64（mime 恒 image/png），
 * Image 按 src 解码还原 naturalWidth/Height + 像素——验证本层编解码助手的契约逻辑
 * （尺寸守卫、零重采样、拷贝语义）；真实 PNG 编码由浏览器 canvas 承担。
 */
function installStubCodec(): () => void {
  const bitmaps = new WeakMap<object, { width: number; height: number; data: Uint8ClampedArray }>()
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL

  class StubCtx {
    constructor(private readonly canvas: HTMLCanvasElement) {}
    createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    }
    putImageData(imageData: { width: number; height: number; data: Uint8ClampedArray }): void {
      bitmaps.set(this.canvas, {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data),
      })
    }
    drawImage(source: unknown, _dx: number, _dy: number, dw: number, dh: number): void {
      const pixels = (source as { __stubPixels?: { data: Uint8ClampedArray } }).__stubPixels
      if (pixels) {
        bitmaps.set(this.canvas, { width: dw, height: dh, data: new Uint8ClampedArray(pixels.data.subarray(0, dw * dh * 4)) })
      } else {
        bitmaps.delete(this.canvas)
      }
    }
    getImageData(_x: number, _y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      const bitmap = bitmaps.get(this.canvas)
      if (!bitmap || bitmap.width !== w || bitmap.height !== h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
      }
      return { width: w, height: h, data: new Uint8ClampedArray(bitmap.data) }
    }
  }

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return new StubCtx(this) as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, mime?: string) {
    const bitmap = bitmaps.get(this)
    if (!bitmap) throw new Error('stub codec: 空画布无法编码')
    if (mime !== 'image/png') throw new Error('stub codec: 仅支持 image/png')
    const bytes = new Uint8Array(8 + bitmap.data.length)
    new DataView(bytes.buffer).setUint32(0, bitmap.width)
    new DataView(bytes.buffer).setUint32(4, bitmap.height)
    bytes.set(bitmap.data, 8)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return `data:image/png;base64,${btoa(binary)}`
  } as unknown as typeof HTMLCanvasElement.prototype.toDataURL

  class StubImage {
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    __stubPixels: { data: Uint8ClampedArray } | null = null
    set src(value: string) {
      queueMicrotask(() => {
        try {
          const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
          if (!match) throw new Error('bad dataUrl')
          const binary = atob(match[1])
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
          const view = new DataView(bytes.buffer)
          const w = view.getUint32(0)
          const h = view.getUint32(4)
          if (bytes.length !== 8 + w * h * 4) throw new Error('bad dims')
          this.naturalWidth = w
          this.naturalHeight = h
          this.__stubPixels = { data: new Uint8ClampedArray(bytes.subarray(8)) }
          this.onload?.()
        } catch {
          this.onerror?.()
        }
      })
    }
  }
  vi.stubGlobal('Image', StubImage)

  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL
    vi.unstubAllGlobals()
  }
}

describe('projectFile painting dataUrl 字节等价（stub 编解码器）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('paintingToDataUrl → dataUrlToPainting：像素面逐字节还原（宽高 + RGBA）', async () => {
    const restore = installStubCodec()
    try {
      const width = 5
      const height = 3
      const data = new Uint8ClampedArray(width * height * 4)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (i * 3) % 256
        data[i + 1] = (i * 5) % 256
        data[i + 2] = (i * 7) % 256
        data[i + 3] = 255
      }
      const dataUrl = paintingToDataUrl({ width, height, data })
      expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)
      const restored = await dataUrlToPainting(dataUrl)
      expect(restored.width).toBe(width)
      expect(restored.height).toBe(height)
      expect(Array.from(restored.data)).toEqual(Array.from(data))
    } finally {
      restore()
    }
  })

  it('坏像素面（data 长度与宽高不符）→ ProjectFileFieldError(painting)', () => {
    const restore = installStubCodec()
    try {
      const error = captureError(() =>
        paintingToDataUrl({ width: 4, height: 4, data: new Uint8ClampedArray(10) }),
      )
      expect(error).toBeInstanceOf(ProjectFileFieldError)
      expect((error as ProjectFileFieldError).path).toBe('painting')
    } finally {
      restore()
    }
  })

  it('dataUrlToPainting 非 data URL / 非 PNG → ProjectFileFieldError(painting.dataUrl)', async () => {
    const restore = installStubCodec()
    try {
      const notUrl = await captureRejection(dataUrlToPainting('http://example.com/a.png'))
      expect(notUrl).toBeInstanceOf(ProjectFileFieldError)
      expect((notUrl as ProjectFileFieldError).path).toBe('painting.dataUrl')

      const wrongMime = await captureRejection(dataUrlToPainting('data:image/jpeg;base64,QUJD'))
      expect(wrongMime).toBeInstanceOf(ProjectFileFieldError)
      expect((wrongMime as ProjectFileFieldError).path).toBe('painting.dataUrl')
    } finally {
      restore()
    }
  })

  it('gemdoc painting 字符串透传：serialize→parse 后 dataUrl 严格相等（序列化层不重编码）', () => {
    const parsed = parseGemdoc(serializeGemdoc(gemdocFull))
    expect(parsed.painting).toEqual({ mime: 'image/png', dataUrl: PNG_DATA_URL })
  })
})
