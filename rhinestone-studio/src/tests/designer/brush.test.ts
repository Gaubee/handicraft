/*
 * [2026-09-21 redesign-designer-workbench 3.1 Test] 笔刷引擎迁移+改造（tasks 3.1）：
 * - custom 形判据替换（design §6.2）：「内置五形白名单」→「custom 必带 assetId」——
 *   三件套断言：① asset resolver（assetId→sys-shapes 资产解析，gemCatalogService 零改动
 *   消费——ready/missing/身份失配）② 物化携带 assetId（custom 手工钻逐字段）③ missing-asset
 *   拒画/报错（整笔拒绝 + brushError + 起笔点闪红 + 零 undo 组；解析就绪后放行）。
 * - 橡皮跳过锁定层与隐藏层钻（design §6.1 新语义——锁定层保护擦除）。
 * - 判据守卫镜像：custom 缺 assetId / builtin 带 assetId = typed throw（engine schema 同口径）。
 * 冲突拒画/等弧长补钻内核回归 = tests/edit/workbench.brush*.test.ts 既有断言（引擎内核不动，
 * 零断言改动）——本文件不重复。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  getEditDoc,
  getGemCount,
  getUndoDepths,
  loadFromHandoff,
  resetEditForTests,
  setGemLayerLocked,
  setGemLayerVisible,
  undo,
} from '$lib/stores/edit.svelte'
import {
  BrushSpecShapeError,
  emitBrushEvent,
  getBrushError,
  getBrushRejections,
  getBrushSpec,
  resetWorkbenchForTests,
  setBrushSpec,
  type BrushSpecState,
} from '$lib/designer/workbench.svelte'
import {
  attachBrushEngine,
  brushAssetSpecOf,
  brushAssetStatusOf,
  makeBrushGem,
  resolveBrushAsset,
  setBrushCatalogForTests,
} from '$lib/designer/brushEngine'
import type { BrushPoint } from '$lib/designer/brushGesture'
import type { CatalogSpec, GemCatalogService } from '$lib/services/gemCatalogService'
import { customSpecKey } from '$lib/engine'
import { makeHandoff } from '../edit/helpers'

/** 干净落区：snap 格阵 row2（y≈13.856）——与 fixture 行（y=4, pitch 8）最近距 ≈10.6px ≥ 判距 7.99。 */
const ROW2_Y = (8 * Math.sqrt(3)) / 2 * 2
const CLEAN_A: BrushPoint = { x: 0, y: ROW2_Y }

function stroke(tool: 'draw' | 'erase', snap: 'grid' | 'free', points: BrushPoint[]): void {
  emitBrushEvent({ phase: 'begin', intent: { tool, snap, points: [points[0]] } })
  for (const p of points.slice(1)) {
    emitBrushEvent({ phase: 'move', intent: { tool, snap, points }, appended: [p] })
  }
  emitBrushEvent({ phase: 'end', intent: { tool, snap, points } })
}

function manualGems() {
  return getEditDoc()!.gems.filter((g) => g.origin === 'manual')
}

function customCatalogSpec(assetId: string, diameterMm = 5): CatalogSpec {
  return {
    specKey: customSpecKey(assetId),
    shapeId: 'custom',
    sizeLabel: `测试自定义 ${assetId}`,
    diameterMm,
    widthMm: diameterMm,
    heightMm: diameterMm * 0.6,
    assetId,
  }
}

/** 目录 service 替身（gemCatalogService 接口零改动消费——resolver 注入面）。 */
function fakeCatalog(entries: CatalogSpec[]): GemCatalogService {
  const byKey = new Map(entries.map((e) => [e.specKey, e]))
  return {
    async listSpecs() {
      return entries.map((e) => ({ ...e }))
    },
    async resolveSpec(specKey: string) {
      const found = byKey.get(specKey)
      return found === undefined ? undefined : { ...found }
    },
  }
}

const CUSTOM_ASSET = 'ast-shape-custom-test-1'
const CUSTOM_SPEC = customCatalogSpec(CUSTOM_ASSET, 5)

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  loadFromHandoff(makeHandoff(12)) // 行钻 (4,4)..(92,4)；SS10 基准径 2.8 / 色板首色 red
  setBrushCatalogForTests(null) // 复位生产单例后按用例注入替身
})

describe('custom 判据替换（design §6.2——custom 必带 assetId）', () => {
  it('setBrushSpec 放行带 assetId 的 custom；拒绝缺 assetId 的 custom（typed throw）', () => {
    expect(() =>
      setBrushSpec({ shapeId: 'custom', diameterMm: 3, colorId: 'red' }),
    ).toThrow(BrushSpecShapeError)
    expect(getBrushSpec()).toBeNull()

    const spec: BrushSpecState = { shapeId: 'custom', diameterMm: 5, colorId: 'gold', assetId: CUSTOM_ASSET }
    setBrushSpec(spec)
    expect(getBrushSpec()).toEqual(spec)

    setBrushSpec(null)
  })

  it('镜像守卫：builtin 形带 assetId = typed throw（assetId 仅 custom 携带）', () => {
    expect(() =>
      setBrushSpec({ shapeId: 'square', diameterMm: 3.5, colorId: 'red', assetId: CUSTOM_ASSET }),
    ).toThrow(BrushSpecShapeError)
    expect(getBrushSpec()).toBeNull()
    expect(() =>
      makeBrushGem({ shapeId: 'round', diameterMm: 2.8, colorId: 'red', assetId: 'x' }, 'm-1', 0, 0),
    ).toThrow(BrushSpecShapeError)
  })

  it('makeBrushGem 物化 custom：携带 assetId + 规格字段逐位（源头戳纪律）', () => {
    const gem = makeBrushGem(
      { shapeId: 'custom', diameterMm: 5, colorId: 'gold', assetId: CUSTOM_ASSET },
      'm-9',
      10,
      20,
    )
    expect(gem).toEqual({
      id: 'm-9',
      x: 10,
      y: 20,
      colorId: 'gold',
      blockId: null,
      origin: 'manual',
      moved: false,
      shapeId: 'custom',
      diameterMm: 5,
      assetId: CUSTOM_ASSET,
    })

    // 内置五形物化不携带 assetId（收窄面不误伤——键缺席）
    for (const shapeId of ['round', 'square', 'drop', 'heart', 'marquise'] as const) {
      const builtin = makeBrushGem({ shapeId, diameterMm: 3, colorId: 'red' }, 'm-x', 0, 0)
      expect(builtin.shapeId).toBe(shapeId)
      expect('assetId' in builtin).toBe(false)
    }

    // custom 缺 assetId 仍拒绝（新判据 = 必带，非全放行）
    expect(() =>
      makeBrushGem({ shapeId: 'custom', diameterMm: 3, colorId: 'red' }, 'm-1', 0, 0),
    ).toThrow(BrushSpecShapeError)
  })
})

describe('三件套①：asset resolver（assetId→sys-shapes 资产解析）', () => {
  it('解析就绪：resolveSpec(custom-<assetId>) 命中 → ready + 目录条目可读', async () => {
    setBrushCatalogForTests(fakeCatalog([CUSTOM_SPEC]))
    expect(brushAssetStatusOf(CUSTOM_ASSET)).toBe('pending') // 未解析
    const ok = await resolveBrushAsset(CUSTOM_ASSET)
    expect(ok).toBe(true)
    expect(brushAssetStatusOf(CUSTOM_ASSET)).toBe('ready')
    expect(brushAssetSpecOf(CUSTOM_ASSET)).toEqual(CUSTOM_SPEC)
  })

  it('missing 四态 → missing（目录无此键 = 解析完成且缺席，不静默降级）', async () => {
    setBrushCatalogForTests(fakeCatalog([]))
    expect(await resolveBrushAsset('ast-gone')).toBe(false)
    expect(brushAssetStatusOf('ast-gone')).toBe('missing')
    expect(brushAssetSpecOf('ast-gone')).toBeNull()
  })

  it('身份失配回等拒绝：条目 assetId ≠ 查询 assetId → missing（防错挂条目）', async () => {
    const mismatched = { ...customCatalogSpec('ast-other'), specKey: customSpecKey(CUSTOM_ASSET) }
    setBrushCatalogForTests(fakeCatalog([mismatched]))
    expect(await resolveBrushAsset(CUSTOM_ASSET)).toBe(false)
    expect(brushAssetStatusOf(CUSTOM_ASSET)).toBe('missing')
  })
})

describe('三件套②③：物化携带 assetId + missing-asset 拒画/报错', () => {
  it('解析就绪的 custom 落钻：物化携带 assetId + origin=manual + 归当前层', async () => {
    setBrushCatalogForTests(fakeCatalog([CUSTOM_SPEC]))
    setBrushSpec({ shapeId: 'custom', diameterMm: 5, colorId: 'gold', assetId: CUSTOM_ASSET })
    await resolveBrushAsset(CUSTOM_ASSET)

    const detach = attachBrushEngine()
    // 自由落点远离行钻（custom 5mm 判距 (5+2.8)/2+0.4=4.3mm×2.5=10.75px——row2 距行钻 10.6px 需再避开：
    // 取 y=24 的远落点，距 (4,4) 最近行钻 > 20px）
    const far = { x: 2, y: 24 }
    stroke('draw', 'free', [far])

    const added = manualGems()
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      shapeId: 'custom',
      diameterMm: 5,
      colorId: 'gold',
      assetId: CUSTOM_ASSET,
      origin: 'manual',
      blockId: null,
      layerId: 'L1', // 落钻归当前层（currentLayerIdOf 兜底首层）
    })
    expect(getBrushError()).toBeNull()

    detach()
  })

  it('missing-asset 拒画：整笔拒绝 + 报错读数 + 起笔点闪红 + 零 undo 组', async () => {
    setBrushCatalogForTests(fakeCatalog([])) // 目录空 = 资产缺失
    setBrushSpec({ shapeId: 'custom', diameterMm: 5, colorId: 'gold', assetId: CUSTOM_ASSET })
    await resolveBrushAsset(CUSTOM_ASSET) // 解析完成 → missing

    const detach = attachBrushEngine()
    stroke('draw', 'free', [CLEAN_A, { x: CLEAN_A.x + 40, y: CLEAN_A.y }])

    expect(getGemCount()).toBe(12) // 整笔拒绝：零新增
    expect(manualGems()).toHaveLength(0)
    expect(getUndoDepths().undo).toBe(0) // 不开组不落 patch
    expect(getBrushError()).toContain(CUSTOM_ASSET) // 报错读数（含资产定位）
    expect(getBrushRejections()).toEqual([CLEAN_A]) // 起笔点闪红（后续点因整笔拒绝不追记）

    detach()
  })

  it('pending（未解析）同样拒画；解析就绪后同规格放行', async () => {
    setBrushCatalogForTests(fakeCatalog([CUSTOM_SPEC]))
    setBrushSpec({ shapeId: 'custom', diameterMm: 5, colorId: 'gold', assetId: CUSTOM_ASSET })
    expect(brushAssetStatusOf(CUSTOM_ASSET)).toBe('pending')

    const detach = attachBrushEngine()
    stroke('draw', 'free', [{ x: 2, y: 24 }])
    expect(manualGems()).toHaveLength(0)
    expect(getBrushError()).not.toBeNull()

    // 解析就绪 → 新笔放行（报错/闪红起笔清零）
    await resolveBrushAsset(CUSTOM_ASSET)
    stroke('draw', 'free', [{ x: 2, y: 24 }])
    expect(manualGems()).toHaveLength(1)
    expect(manualGems()[0].assetId).toBe(CUSTOM_ASSET)
    expect(getBrushError()).toBeNull()
    expect(getBrushRejections()).toHaveLength(0)

    detach()
  })

  it('报错读数不产 undo 组且不影响后续内置形笔划（起笔清零）', async () => {
    setBrushCatalogForTests(fakeCatalog([]))
    setBrushSpec({ shapeId: 'custom', diameterMm: 5, colorId: 'red', assetId: CUSTOM_ASSET })
    await resolveBrushAsset(CUSTOM_ASSET)

    const detach = attachBrushEngine()
    stroke('draw', 'free', [CLEAN_A])
    expect(getBrushError()).not.toBeNull()

    setBrushSpec(null) // 回基准（round 2.8）
    stroke('draw', 'grid', [CLEAN_A])
    expect(manualGems()).toHaveLength(1)
    expect(manualGems()[0].shapeId).toBe('round')
    expect(getBrushError()).toBeNull()

    detach()
  })
})

describe('橡皮跳过锁定层与隐藏层钻（design §6.1）', () => {
  it('锁定层：命中不删（保护擦除）；解锁后同落点可删', () => {
    const detach = attachBrushEngine()
    setGemLayerLocked('L1', true)
    stroke('erase', 'free', [{ x: 4, y: 4 }])
    expect(getGemCount()).toBe(12)
    expect(getUndoDepths().undo).toBe(0)

    setGemLayerLocked('L1', false)
    stroke('erase', 'free', [{ x: 4, y: 4 }])
    expect(getGemCount()).toBe(11)
    expect(getEditDoc()!.gems.some((g) => g.id === 'g00001')).toBe(false)

    undo()
    expect(getGemCount()).toBe(12)

    detach()
  })

  it('隐藏层：命中不删；恢复可见后同落点可删', () => {
    const detach = attachBrushEngine()
    setGemLayerVisible('L1', false)
    stroke('erase', 'free', [
      { x: 4, y: 4 },
      { x: 12, y: 4 },
    ])
    expect(getGemCount()).toBe(12)

    setGemLayerVisible('L1', true)
    stroke('erase', 'free', [{ x: 4, y: 4 }])
    expect(getGemCount()).toBe(11)

    detach()
  })
})
