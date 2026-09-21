/**
 * [2026-09-21 redesign-designer-workbench 1.2] gemdoc v2→v3 迁移 + v3 序列化验收
 * （design §5.4/§5.5/§7.1-③；R1-P0-1 开窗验收四条原文）：
 *
 * ① v2 fixture 打开（loadFromGemdoc）→ 内存 v3 → 保存 formatVersion=3 → 重开等价；
 * ② v2 输入不被原样回写（打开不改库内字节；保存必 v3——单向版本门）；
 * ③ serialize→parse→serialize 字节等价（v3 规范形态）；
 * ④ projectFile 迁移断言（§5.5 六行逐字段映射）+ 未知/高 formatVersion 拒读 + v1→v3 链。
 * 另：四种旧层独立显隐/透明组合（painting 30% + reference 80% + blocks 隐藏 + gems 50%）迁移等价
 * （R1-P0-3）+ v3 round-trip 无未声明漂移 + layerId 生命周期「迁移/序列化」行（R1-P0-4）。
 *
 * 环境声明：fake IDB（assetStore 全链）+ helpers 编解码桩（painting PNG 像素级还原）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getImageBlob } from '$lib/persistence/imageStore'
import {
  ingestAsset,
  ingestProjectAsset,
  getProject,
  resetAssetStoreForTests,
  runAssetMigration,
} from '$lib/persistence/assetStore'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import {
  PROJECTFILE_FORMAT_VERSIONS,
  ProjectFileVersionError,
  maskBitsToBase64,
  parseGemdoc,
  parseGemdocDetailed,
  paintingToDataUrl,
  serializeGemdoc,
  fromSerializedBlock,
  type GemdocFile,
  type GemdocFileInput,
} from '$lib/persistence/projectFile'
import {
  addGemLayer,
  getEditDoc,
  loadFromGemdoc,
  loadFromHandoff,
  moveGemsToLayer,
  resetEditForTests,
  saveGemdoc,
} from '$lib/stores/edit.svelte'
import { createBlankDocument, createDocumentFromImage } from '$lib/designer/entry'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'
import { installCodecStubEnv, makeHandoff, solidImage } from './helpers'

let fake: FakeIndexedDB
let restoreEnv: (() => void) | null = null

beforeEach(async () => {
  localStorage.clear() // 迁移 flag 在 localStorage（editUnbound 同式；fake IDB 每测重建须连 flag 一起清）
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetEditForTests()
  resetToastsForTests()
  restoreEnv = installCodecStubEnv()
  await runAssetMigration()
})

afterEach(() => {
  restoreEnv?.()
  restoreEnv = null
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// v2 旧档 fixture（手写历史字节面——v2 形态在本 change 后不可由 serializeGemdoc 产出）
// ---------------------------------------------------------------------------

const LEGACY_PAINTING_DATA_URL = () => paintingToDataUrl(solidImage(64, 64))

const LEGACY_BLOCK = {
  id: 'blk-1',
  label: '花环主体',
  mask: { w: 2, h: 2, bits: maskBitsToBase64(Uint8Array.from([1, 0, 0, 1])) },
  colorRgb: [200, 16, 46],
  areaPx: 2,
  bbox: { x: 10, y: 20, w: 2, h: 2 },
  widthPx: { max: 2, mean: 1.5 },
  suggested: 'fill',
}

interface LegacyFourLayers {
  painting: { visible: boolean; opacity: number }
  reference: { visible: boolean; opacity: number }
  blocks: { visible: boolean; opacity: number }
  gems: { visible: boolean; opacity: number }
}

/** v2 字节构造（painting dataUrl 经编解码桩像素级可还原；缺省四层全显）。 */
function makeGemdocV2Text(overrides?: { layers?: LegacyFourLayers; reference?: { assetId: string; name: string } }): string {
  return JSON.stringify({
    kind: 'gemdoc',
    formatVersion: 2,
    appVersion: '0.1.0-test',
    engineVersion: 1,
    createdAt: 1758000000444,
    savedAt: 1758000000555,
    name: '旧档·精修文档',
    width: 64,
    height: 64,
    grid: { pitchMm: 3.2, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 },
    palette: [
      { id: 'red', name: '红', hex: '#C8102E' },
      { id: 'gold', name: '金', hex: '#D4A017' },
    ],
    gems: [
      { id: 'g00001', x: 12.5, y: 20.25, colorId: 'red', blockId: 'blk-1', origin: 'layout', moved: true, shapeId: 'round', diameterMm: 2.8 },
      { id: 'm-3', x: 40, y: 60, colorId: 'gold', blockId: null, origin: 'manual', moved: false, shapeId: 'drop', diameterMm: 4.3, rotationDeg: 45 },
    ],
    blocks: [LEGACY_BLOCK],
    layers: overrides?.layers ?? {
      painting: { visible: true, opacity: 1 },
      reference: { visible: true, opacity: 0.6 },
      blocks: { visible: true, opacity: 0.9 },
      gems: { visible: true, opacity: 1 },
    },
    painting: { mime: 'image/png', dataUrl: LEGACY_PAINTING_DATA_URL() },
    physicalCanvas: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
    ...(overrides?.reference !== undefined ? { reference: overrides.reference } : {}),
    provenance: { origin: 'studio-bake', sourceSummary: '六方抽稀 · 密度 100% · SS10 · 2 钻', sourceAssetId: 'ast-src-1' },
  })
}

/** v1 旧档（v2 字节降级：剥规格物化字段 + grid gapMm→ss——历史形态）。 */
function makeGemdocV1Text(): string {
  const doc = JSON.parse(makeGemdocV2Text()) as Record<string, unknown>
  doc.formatVersion = 1
  for (const gem of doc.gems as Array<Record<string, unknown>>) {
    delete gem.shapeId
    delete gem.diameterMm
    delete gem.rotationDeg
  }
  const grid = doc.grid as Record<string, unknown>
  delete grid.gapMm
  grid.ss = 'SS10'
  delete doc.physicalCanvas
  return JSON.stringify(doc)
}

/** v3 parse 产物 → 再序列化输入（唯一差异 = blocks 源 SerializedBlock → 引擎 Block）。 */
function reinputOf(file: GemdocFile): GemdocFileInput {
  return {
    appVersion: file.appVersion,
    createdAt: file.createdAt,
    savedAt: file.savedAt,
    name: file.name,
    width: file.width,
    height: file.height,
    grid: file.grid,
    palette: file.palette,
    gems: file.gems,
    layers: file.layers,
    underlay: {
      sources: file.underlay.sources.map((source) =>
        source.key === 'blocks'
          ? { ...source, blocks: source.blocks.map(fromSerializedBlock) }
          : source,
      ),
    },
    physicalCanvas: file.physicalCanvas,
    provenance: file.provenance,
  }
}

function withVersion(text: string, version: number): string {
  const doc = JSON.parse(text) as Record<string, unknown>
  doc.formatVersion = version
  return JSON.stringify(doc)
}

async function blobTextOf(assetId: string): Promise<string> {
  const node = await getProject(assetId)
  if (node === null) throw new Error('missing project node')
  const blob = await getImageBlob(node.blobKey)
  if (blob === null) throw new Error('missing blob')
  return new TextDecoder().decode(await blob.arrayBuffer())
}

/** 入库一张参考图（lease pin 目标需真实资产——editUnbound 同式）。 */
async function ingestReferenceImage(name: string): Promise<string> {
  const { node } = await ingestAsset({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    name,
    width: 96,
    height: 64,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  return node.id
}

// ---------------------------------------------------------------------------
// ④ projectFile 迁移断言（§5.5 六行映射）+ 版本门（纯函数面，先于全链）
// ---------------------------------------------------------------------------

describe('④ projectFile v2→v3 迁移与版本门', () => {
  it('§5.5 六行逐字段映射：gems→L1（origin/blockId/moved 原值）+ 四层→三源与钻层原值 + 物理锚/身份直传', () => {
    const reference = { assetId: 'ast-ref-legacy', name: '原图.png' }
    const file = parseGemdoc(
      makeGemdocV2Text({
        reference,
        layers: {
          painting: { visible: false, opacity: 0.4 },
          reference: { visible: true, opacity: 0.7 },
          blocks: { visible: true, opacity: 0.9 },
          gems: { visible: true, opacity: 0.5 },
        },
      }),
    )
    expect(file.formatVersion).toBe(3)
    // 迁移行：全部钻 → 默认钻层「图层 1」，layerId='L1'；origin/blockId/moved 原值保留
    expect(file.gems.map((g) => g.layerId)).toEqual(['L1', 'L1'])
    expect(file.gems[0]).toMatchObject({ id: 'g00001', origin: 'layout', moved: true, blockId: 'blk-1' })
    expect(file.gems[1]).toMatchObject({ id: 'm-3', origin: 'manual', moved: false, blockId: null, rotationDeg: 45 })
    // gems 层 visible/opacity → 新钻层原值
    expect(file.layers).toEqual([{ id: 'L1', name: '图层 1', visible: true, locked: false, opacity: 0.5 }])
    // painting/reference/blocks 三源各 {visible,opacity} 原值（载荷入源）
    expect(file.underlay.sources.map(({ key, visible, opacity }) => ({ key, visible, opacity }))).toEqual([
      { key: 'painting', visible: false, opacity: 0.4 },
      { key: 'reference', visible: true, opacity: 0.7 },
      { key: 'blocks', visible: true, opacity: 0.9 },
    ])
    const blocksSource = file.underlay.sources.find((s) => s.key === 'blocks')!
    expect(blocksSource.blocks).toHaveLength(1)
    // 载荷原值：painting dataUrl 字节透传 / reference 弱引用 / physicalCanvas/身份直传
    const paintingSource = file.underlay.sources.find((s) => s.key === 'painting')!
    expect(paintingSource.painting.dataUrl).toBe(LEGACY_PAINTING_DATA_URL())
    const referenceSource = file.underlay.sources.find((s) => s.key === 'reference')!
    expect(referenceSource.reference).toEqual(reference)
    expect(file.physicalCanvas).toEqual({ widthMm: 210, heightMm: 148, anchorSource: 'declared' })
    expect(file.provenance).toEqual({
      origin: 'studio-bake',
      sourceSummary: '六方抽稀 · 密度 100% · SS10 · 2 钻',
      sourceAssetId: 'ast-src-1',
    })
    // v2 顶层键不复活（无第二顶层真源）
    const raw = JSON.parse(serializeGemdoc(reinputOf(file))) as Record<string, unknown>
    for (const legacyKey of ['blocks', 'painting', 'reference']) {
      expect(raw[legacyKey], legacyKey).toBeUndefined()
    }
    expect(raw.layers).toBeInstanceOf(Array)
  })

  it('无参考弱引用的 v2：underlay 仅 painting/blocks 两源（reference 源不呈现）', () => {
    const file = parseGemdoc(makeGemdocV2Text())
    expect(file.underlay.sources.map((s) => s.key)).toEqual(['painting', 'blocks'])
  })

  it('v1→v3 链：v1 旧档（无规格物化字段）经 v2→v3 全链迁移（round 补径 + L1 归属）', () => {
    const file = parseGemdoc(makeGemdocV1Text())
    expect(file.formatVersion).toBe(3)
    for (const gem of file.gems) {
      expect(gem.shapeId).toBe('round')
      expect(gem.layerId).toBe('L1')
    }
    expect(file.physicalCanvas).toBeUndefined()
  })

  it('未知/高 formatVersion 拒读（向前版本门；版本错误先于字段校验）', () => {
    expect(PROJECTFILE_FORMAT_VERSIONS).toEqual({ gemproj: 2, gemdoc: 3 })
    const future = withVersion(makeGemdocV2Text(), 4)
    let error: unknown
    try {
      parseGemdoc(future)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ProjectFileVersionError)
    expect((error as ProjectFileVersionError).foundVersion).toBe(4)
    expect((error as ProjectFileVersionError).supportedVersion).toBe(3)
  })

  it('脏迁移输入 typed reject：v2 四层缺 gems 键 → 路径 layers.gems', () => {
    const doc = JSON.parse(makeGemdocV2Text()) as Record<string, unknown>
    delete (doc.layers as Record<string, unknown>).gems
    let error: unknown
    try {
      parseGemdoc(JSON.stringify(doc))
    } catch (caught) {
      error = caught
    }
    expect((error as Error).message).toContain('layers.gems')
  })

  it('归属闭合拒绝面：gems.layerId 指向未声明层 → typed reject（路径 gems.0.layerId）', () => {
    const file = parseGemdoc(makeGemdocV2Text())
    const dirty = serializeGemdoc(reinputOf(file))
    const doc = JSON.parse(dirty) as { gems: Array<{ layerId: string }> }
    doc.gems[0].layerId = 'L9'
    let error: unknown
    try {
      parseGemdoc(JSON.stringify(doc))
    } catch (caught) {
      error = caught
    }
    expect((error as Error).message).toContain('gems.0.layerId')
  })
})

// ---------------------------------------------------------------------------
// ③ serialize→parse→serialize 字节等价 + 四组合无损 + round-trip 无未声明漂移
// ---------------------------------------------------------------------------

describe('③ v3 字节等价与四组合无损（R1-P0-3）', () => {
  it('serialize→parse→serialize 字节等价（v2 迁移产物经 reinput 回灌）', () => {
    const s1 = serializeGemdoc(reinputOf(parseGemdoc(makeGemdocV2Text({ reference: { assetId: 'ast-ref-legacy', name: '原图.png' } }))))
    const s2 = serializeGemdoc(reinputOf(parseGemdoc(s1)))
    expect(s2).toBe(s1)
  })

  it('四种旧层独立显隐/透明组合（painting 30% + reference 80% + blocks 隐藏 + gems 50%）迁移等价', () => {
    const combo: LegacyFourLayers = {
      painting: { visible: true, opacity: 0.3 },
      reference: { visible: true, opacity: 0.8 },
      blocks: { visible: false, opacity: 0.9 },
      gems: { visible: true, opacity: 0.5 },
    }
    const file = parseGemdoc(makeGemdocV2Text({ layers: combo, reference: { assetId: 'ast-ref-legacy', name: '原图.png' } }))
    expect(file.underlay.sources.map(({ key, visible, opacity }) => ({ key, visible, opacity }))).toEqual([
      { key: 'painting', visible: true, opacity: 0.3 },
      { key: 'reference', visible: true, opacity: 0.8 },
      { key: 'blocks', visible: false, opacity: 0.9 },
    ])
    expect(file.layers).toEqual([{ id: 'L1', name: '图层 1', visible: true, locked: false, opacity: 0.5 }])
  })

  it('v3 round-trip 无未声明漂移：parse→serialize→parse 深比较逐字段相等', () => {
    const text = serializeGemdoc(reinputOf(parseGemdoc(makeGemdocV2Text())))
    const once = JSON.parse(text)
    const twice = JSON.parse(serializeGemdoc(reinputOf(parseGemdoc(text))))
    expect(twice).toEqual(once)
  })
})

// ---------------------------------------------------------------------------
// ①② 全链（loadFromGemdoc/saveGemdoc：v2 打开→内存 v3→保存 v3→重开等价；v2 不回写）
// ---------------------------------------------------------------------------

describe('①② 全链：v2 打开 → 内存 v3 → 保存 v3 → 重开等价（v2 不回写）', () => {
  async function ingestLegacyV2Doc(referenceAssetId?: string): Promise<{ docId: string; text: string }> {
    const text = makeGemdocV2Text(referenceAssetId !== undefined ? { reference: { assetId: referenceAssetId, name: '参考原图.png' } } : undefined)
    const { node } = await ingestProjectAsset({
      blob: new Blob([text], { type: PROJECT_MIME.gemdoc }),
      name: '旧档.gemdoc',
      projectKind: 'gemdoc',
      summary: {},
    })
    return { docId: node.id, text }
  }

  it('v2 打开 → 内存 v3（§5.5 装载面）；打开不改库内字节（v2 不回写·读侧）；升档 toast 一次性', async () => {
    const refId = await ingestReferenceImage('参考原图.png')
    const { docId, text } = await ingestLegacyV2Doc(refId)

    await loadFromGemdoc(docId)
    // 内存 v3
    const doc = getEditDoc()!
    expect(doc.gems.map((g) => g.layerId)).toEqual(['L1', 'L1'])
    expect(doc.layers).toEqual([{ id: 'L1', name: '图层 1', visible: true, locked: false, opacity: 1 }])
    expect(doc.underlay.sources.map((s) => `${s.key}:${s.visible}:${s.opacity}`)).toEqual([
      'painting:true:1',
      'reference:true:0.6',
      'blocks:true:0.9',
    ])
    expect(doc.referenceAssetId).toBe(refId)
    expect(doc.blocks).toHaveLength(1)
    expect(doc.paintingSnapshot.width).toBe(64)
    // 读侧不回写：库内字节保持 v2
    expect(await blobTextOf(docId)).toBe(text)
    // 升档 toast 一次性提示（design §5.5）
    expect(getToasts().some((t) => t.message.includes('已从旧版格式升级'))).toBe(true)
  })

  it('保存 = formatVersion 3（保存必 v3）；重开等价（内存 v3 与首开一致；不再升档 toast）', async () => {
    const refId = await ingestReferenceImage('参考原图.png')
    const { docId } = await ingestLegacyV2Doc(refId)

    await loadFromGemdoc(docId)
    const firstOpen = getEditDoc()!
    const firstGems = JSON.parse(JSON.stringify(firstOpen.gems))

    await saveGemdoc({ name: '旧档' })
    const savedText = await blobTextOf(docId)
    expect(JSON.parse(savedText).formatVersion).toBe(3) // ② v2 不回写：落库恒 v3
    expect(savedText).not.toBe(makeGemdocV2Text({ reference: { assetId: refId, name: '参考原图.png' } }))

    // 重开等价（v3 → 内存 v3）
    resetToastsForTests()
    await loadFromGemdoc(docId)
    const reopened = getEditDoc()!
    expect(JSON.parse(JSON.stringify(reopened.gems))).toEqual(firstGems)
    expect(reopened.layers).toEqual(firstOpen.layers)
    expect(reopened.underlay).toEqual(firstOpen.underlay)
    expect(reopened.referenceAssetId).toBe(refId)
    expect(reopened.blocks.map((b) => b.id)).toEqual(firstOpen.blocks.map((b) => b.id))
    expect(reopened.physicalCanvas).toEqual(firstOpen.physicalCanvas)
    expect(getToasts().some((t) => t.message.includes('已从旧版格式升级'))).toBe(false) // v3 重开不再提示
  })

  it('layerId「序列化」行：多层多归属保存重开逐颗保留（L1/L2 混合归属）', async () => {
    // 起步新文档（v3 保存链）→ 建二层分属 → 保存 → parse 逐颗 layerId 对齐 → 重开一致
    loadFromHandoff(makeHandoff(4))
    const l2 = addGemLayer('描边')!
    await moveGemsToLayer(['g00001', 'g00002'], l2)
    await saveGemdoc({ name: '多层归属' })

    const savedText = await blobTextOf(getEditDoc()!.docId!)
    const file = parseGemdocDetailed(savedText)
    expect(file.file.formatVersion).toBe(3)
    expect(file.sourceVersion).toBe(3)
    expect(file.file.layers.map((l) => l.id)).toEqual(['L1', 'L2'])
    const byId = new Map(file.file.gems.map((g) => [g.id, g.layerId] as const))
    expect(byId.get('g00001')).toBe('L2')
    expect(byId.get('g00002')).toBe('L2')
    expect(byId.get('g00003')).toBe('L1')
    expect(byId.get('g00004')).toBe('L1')

    const beforeReopen = JSON.parse(JSON.stringify(getEditDoc()!.gems))
    await loadFromGemdoc(getEditDoc()!.docId!)
    expect(JSON.parse(JSON.stringify(getEditDoc()!.gems))).toEqual(beforeReopen)
    expect(getEditDoc()!.layers.map((l) => l.name)).toEqual(['图层 1', '描边'])
  })
})

// ---------------------------------------------------------------------------
// 空白起步 round-trip（serialize 不伪造缺席源——幻影 painting 行修复，design §4.2/§5.1）
// ---------------------------------------------------------------------------

describe('空白起步 round-trip（无幻影 painting 源）', () => {
  it('空白新建：保存 → 文件 underlay 零源（不伪造 painting）→ 重开图层面板无 painting 行 + paintingSnapshot 1×1 占位（parse 对称）→ 产物 serialize→parse→serialize 字节等价', async () => {
    createBlankDocument()
    await saveGemdoc({ name: '空白起步' })

    const savedText = await blobTextOf(getEditDoc()!.docId!)
    const file = parseGemdocDetailed(savedText).file
    expect(file.formatVersion).toBe(3)
    expect(file.underlay.sources).toEqual([]) // 不伪造缺席源（v2 迁移 fixture 自带 painting，两路径分叉点）

    await loadFromGemdoc(getEditDoc()!.docId!)
    const doc = getEditDoc()!
    // 图层面板 underlay 行 = doc.underlay.sources 派生——无 painting 行（幻影行修复验收）
    expect(doc.underlay.sources).toEqual([])
    expect(doc.referenceAssetId).toBeNull()
    expect(doc.paintingSnapshot.width).toBe(1) // parse 侧对称：缺席 painting 源 → 1×1 透明占位快照
    expect(doc.paintingSnapshot.height).toBe(1)

    // 空白起步产物（重开后的保存字节）保持 serialize→parse→serialize 字节等价性质
    const text2 = await blobTextOf(doc.docId!)
    const s1 = serializeGemdoc(reinputOf(parseGemdoc(text2)))
    const s2 = serializeGemdoc(reinputOf(parseGemdoc(s1)))
    expect(s2).toBe(s1)
  })

  it('选图新建：保存 → 文件 underlay 仅 reference 源（painting/blocks 不伪造）→ 重开源集一致', async () => {
    const refId = await ingestReferenceImage('选图起步原图.png')
    await createDocumentFromImage({ assetId: refId, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), name: '选图起步原图.png' })
    expect(getEditDoc()!.gems).toHaveLength(0) // 选图 ≠ 排稿（design §5.1 硬规则回归）

    await saveGemdoc({ name: '选图起步' })
    const savedText = await blobTextOf(getEditDoc()!.docId!)
    const file = parseGemdocDetailed(savedText).file
    expect(file.underlay.sources.map((s) => s.key)).toEqual(['reference']) // 仅 reference——无 painting 幻影
    expect(file.underlay.sources.find((s) => s.key === 'reference')!.reference.assetId).toBe(refId)

    await loadFromGemdoc(getEditDoc()!.docId!)
    const doc = getEditDoc()!
    expect(doc.underlay.sources.map((s) => `${s.key}:${s.visible}:${s.opacity}`)).toEqual(['reference:true:1'])
    expect(doc.referenceAssetId).toBe(refId)
    expect(doc.gems).toHaveLength(0)
  })
})
