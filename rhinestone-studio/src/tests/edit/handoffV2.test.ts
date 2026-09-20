/*
 * [2026-09-20 studio-layers 1.4] handoff payload v2 + PhysicalCanvas 贯通：
 * - buildManualEditHandoff v2 真实现：gems = 各层 concat（当前单 rest 层 = activeResult）、
 *   blocks = effectiveBlocks 并集、physicalCanvas default 锚显式、sourceSummary 层语法；
 * - loadFromHandoff v2 消费：payload.physicalCanvas → EditDocument；v1 形态载荷（无键——
 *   quickLayout 既有装配）= 按参考网格 pixelsPerMm 合成 default 锚（向后兼容，同参同出不破坏）；
 * - gemdoc round-trip：EditDocument.physicalCanvas → serializeGemdoc（schema 位已冻结）→
 *   parseGemdoc 回读字段等价 + serialize→parse→serialize 字节等价（declared/default 两态）。
 *
 * 环境声明：jsdom canvas/Image 不可用 → quickLayout 兼容例自带最小解码桩
 * （quickLayout.test 同式：OkImage + 软 canvas 2d 返回固定 96×64 像素）；fake IDB 支撑
 * saveGemdoc 全链。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeEditDocument,
  getEditDoc,
  loadFromGemdoc,
  loadFromHandoff,
  resetEditForTests,
  saveGemdoc,
} from '$lib/stores/edit.svelte'
import {
  buildManualEditHandoff,
  getActiveResult,
  getEffectiveBlocks,
  loadFromEngineImage,
  resetStudioForTests,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { quickLayoutFromImage } from '$lib/edit/quickLayout'
import { fromSerializedBlock, parseGemdoc, serializeGemdoc, type GemdocFile, type GemdocFileInput } from '$lib/persistence/projectFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { getImageBlob } from '$lib/persistence/imageStore'
import { getProject, resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import { makeHandoff, installCodecStubEnv } from './helpers'
import { fixtureShapes } from '../engine/helpers'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let restoreEnv: (() => void) | null = null

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetEditForTests()
  resetStudioForTests()
  await runAssetMigration()
})

afterEach(() => {
  restoreEnv?.()
  restoreEnv = null
  vi.unstubAllGlobals()
  resetEditForTests()
  resetStudioForTests()
})

/** 编解码桩（gemdoc round-trip 的 painting 编解码 + quickLayout 解码链）。 */
function withCodecStub(): void {
  restoreEnv?.()
  restoreEnv = installCodecStubEnv()
}

/** GemdocFile（已 parse）→ GemdocFileInput（再序列化字节等价断言用；
 * [1.2 v3 演进] blocks/painting/reference 顶层键 → underlay 源载荷回灌）。 */
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

async function studioReady(): Promise<void> {
  resetStudioForTests()
  loadFromEngineImage(fixtureShapes(), 'handoff-v2.png', 'handoff')
  await waitForStudioIdle()
}

describe('1.4 buildManualEditHandoff v2（换真：层 concat 逐钻规格 + default 锚 + 层语法摘要）', () => {
  it('gems = 各层 concat（当前单 rest 层 = activeResult 逐钻物化规格）、blocks = effectiveBlocks 并集', async () => {
    await studioReady()
    const res = getActiveResult()!
    const handoff = buildManualEditHandoff()!
    expect(handoff).not.toBeNull()
    expect(handoff.gems.map((g) => ({ ...g }))).toEqual(res.gems.map((g) => ({ ...g })))
    for (const gem of handoff.gems) {
      expect(gem.shapeId).toBeDefined()
      expect(gem.diameterMm).toBeGreaterThan(0)
    }
    expect(handoff.blocks.map((b) => b.id)).toEqual(getEffectiveBlocks().map((b) => b.id))
  })

  it('physicalCanvas = default 锚显式（studio 会话无 declared 画幅锚——2.8 打开链路携带前恒 default）', async () => {
    await studioReady()
    const image = fixtureShapes()
    const handoff = buildManualEditHandoff()!
    expect(handoff.physicalCanvas).toEqual({
      widthMm: image.width / 2.5,
      heightMm: image.height / 2.5,
      anchorSource: 'default',
    })
  })

  it('sourceSummary 层语法：`1 层 · 共 X 钻 · 主规格 圆钻 SS10`（原单值语法退役）', async () => {
    await studioReady()
    const res = getActiveResult()!
    const handoff = buildManualEditHandoff()!
    expect(handoff.sourceSummary).toBe(`1 层 · 共 ${res.gems.length} 钻 · 主规格 圆钻 SS10`)
  })
})

describe('1.4 loadFromHandoff v2 消费（physicalCanvas → EditDocument）', () => {
  it('v2 declared 载荷：doc.physicalCanvas 与 payload 逐字段相等', () => {
    const declared = { widthMm: 192, heightMm: 128, anchorSource: 'declared' as const }
    loadFromHandoff(makeHandoff(6, { physicalCanvas: declared }))
    expect(getEditDoc()!.physicalCanvas).toEqual(declared)
  })

  it('v1 形态载荷（无键——quickLayout 既有装配）：按参考网格 pixelsPerMm 合成 default 锚（不静默）', () => {
    loadFromHandoff(makeHandoff(6)) // helpers.makeHandoff 无 physicalCanvas 键
    expect(getEditDoc()!.physicalCanvas).toEqual({
      widthMm: 64 / 2.5,
      heightMm: 64 / 2.5,
      anchorSource: 'default',
    })
  })

  it('quickLayout 兼容：真产物（v1 形态）→ loadFromHandoff default 锚落位', async () => {
    withCodecStub()
    const { handoff } = await quickLayoutFromImage(new Blob([new Uint8Array([1])], { type: 'image/png' }))
    expect('physicalCanvas' in handoff).toBe(false) // v1 形态（同步补锚归 expert/gem-catalog 后续）
    loadFromHandoff(handoff)
    expect(getEditDoc()!.physicalCanvas).toEqual({
      widthMm: 96 / 2.5,
      heightMm: 64 / 2.5,
      anchorSource: 'default',
    })
  })
})

describe('1.4 gemdoc round-trip（physicalCanvas serialize 位已冻结 → 回读等价）', () => {
  it.each([
    { label: 'declared', canvas: { widthMm: 192, heightMm: 128, anchorSource: 'declared' as const } },
    { label: 'default', canvas: { widthMm: 25.6, heightMm: 25.6, anchorSource: 'default' as const } },
  ])('%s 态：saveGemdoc → parseGemdoc 字段等价 + serialize→parse→serialize 字节等价', async ({ canvas }) => {
    withCodecStub()
    loadFromHandoff(makeHandoff(4, { physicalCanvas: canvas }))
    const saved = await saveGemdoc({ name: `锚-${canvas.anchorSource}` })
    const node = await getProject(saved.docId)
    const blobKey = node !== null && node.projectKind === 'gemdoc' ? node.blobKey : null
    if (blobKey === null) throw new Error('gemdoc 节点应存在')
    const savedBlob = await getImageBlob(blobKey)
    if (savedBlob === null) throw new Error('gemdoc 字节应存在')
    const text1 = new TextDecoder().decode(await savedBlob.arrayBuffer())
    const parsed = parseGemdoc(text1, { mime: PROJECT_MIME.gemdoc })
    expect(parsed.physicalCanvas).toEqual(canvas) // 字段等价（精确 double round-trip）
    expect(serializeGemdoc(reinputOf(parsed))).toBe(text1) // 字节等价
    // 装载面：loadFromGemdoc → EditDocument.physicalCanvas（旧档无键 → default 合成已由 v1 例覆盖）
    await closeEditDocument()
    await loadFromGemdoc(saved.docId)
    expect(getEditDoc()!.physicalCanvas).toEqual(canvas)
  })
})
