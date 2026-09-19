/*
 * [2026-09-20 S-4.2 / D-5.2 Test] documentService 编排壳（rename-and-expert-workbench tasks 4.2/5.2）：
 * 编排成功映射 / 守卫信号（dirty 未 force → guard-required，不弹窗）/ 失败注入
 * （CAS conflict / parse 失败 / lease 过期 / no-document）/ busy 回调时序 /
 * exportSvg·Bom（engine 纯函数编排）/ exportPng renderer 缺席 typed unavailable /
 * [D-5.2] exportGate 前接（spacing 违规 → blocked typed 信号 / PNG gate 先于 renderer /
 * 违规修复放行 / 保存放行·文档可存 / missing-asset 注入面） /
 * **无 payload 第二实现断言**（payload 构造与解析只经 store/replay gate owner 既有 API）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toEditGem, type EditGem } from '$lib/engine'
import { SvelteSet } from 'svelte/reactivity'
import {
  createDocumentService,
  type DocumentServiceDeps,
  type EditStoreSurface,
} from '$lib/services/documentService'
import type { EditDocument, SaveGemdocResult } from '$lib/stores/edit.svelte'
import { AssetStoreError } from '$lib/persistence/assetStore'
import { ProjectConflictError } from '$lib/persistence/projectTypes'
import { ProjectFileKindError } from '$lib/persistence/projectFile'
import { EditGemdocError } from '$lib/stores/edit.svelte'
import { makeHandoff, fullBlock } from '../edit/helpers'

// ---------------------------------------------------------------------------
// fake store 面（真 EditDocument 字面量 + 注入失败点）
// ---------------------------------------------------------------------------

function testDoc(): EditDocument {
  // [D-5.2] 画幅 96px：hexGems(12) 单行 12 列 x=4..92——须完全落入块掩码（exportGate mask 面）
  const handoff = makeHandoff(12, { blocks: [fullBlock(96, 64)], width: 96 })
  return {
    gems: handoff.gems.map(toEditGem),
    blocks: handoff.blocks,
    palette: handoff.palette,
    grid: handoff.grid,
    width: handoff.width,
    height: handoff.height,
    layers: {
      painting: { visible: true, opacity: 1 },
      reference: { visible: true, opacity: 0.6 },
      blocks: { visible: true, opacity: 0.9 },
      gems: { visible: true, opacity: 1 },
    },
    selection: new SvelteSet<string>(),
    paintingSnapshot: handoff.paintingSnapshot,
    referenceAssetId: null,
    sourceSummary: handoff.sourceSummary,
    docId: null,
    name: '测试文档',
    createdAt: 0,
    savedAt: null,
    provenance: { origin: 'studio-bake' },
  }
}

function fakeStore(overrides: {
  doc?: EditDocument | null
  dirty?: boolean
  load?: (assetId: string) => Promise<void>
  save?: (options?: { name?: string }) => Promise<SaveGemdocResult>
  saveAs?: (name: string) => Promise<SaveGemdocResult>
  exportGemdoc?: () => Promise<{ blob: Blob; filename: string }>
} = {}): EditStoreSurface & { loadMock: ReturnType<typeof vi.fn>; saveMock: ReturnType<typeof vi.fn> } {
  const loadMock = vi.fn(overrides.load ?? (async () => {}))
  const saveMock = vi.fn(
    overrides.save ??
      (async () => ({ status: 'created' as const, docId: 'ast-new', name: '测试文档' })),
  )
  const saveAsMock = vi.fn(
    overrides.saveAs ??
      (async () => ({ status: 'created' as const, docId: 'ast-fork', name: '分叉稿' })),
  )
  const exportMock = vi.fn(
    overrides.exportGemdoc ??
      (async () => ({ blob: new Blob(['gemdoc-bytes'], { type: 'application/x-gemdoc' }), filename: '测试文档.gemdoc' })),
  )
  return {
    getEditDoc: () => (overrides.doc === undefined ? testDoc() : overrides.doc),
    isEditDirty: () => overrides.dirty ?? false,
    loadFromGemdoc: loadMock,
    saveGemdoc: saveMock,
    saveGemdocAs: saveAsMock,
    buildGemdocExport: exportMock,
    loadMock,
    saveMock,
  }
}

function service(store: EditStoreSurface, extra: Partial<DocumentServiceDeps> = {}) {
  return createDocumentService({ store, ...extra })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('openFromLibrary 编排', () => {
  it('成功：clean 直开；busy 回调 true→false 时序', async () => {
    const store = fakeStore({ dirty: false })
    const busy: boolean[] = []
    const svc = service(store, { onBusy: (b) => busy.push(b) })

    const result = await svc.openFromLibrary('ast-1')
    expect(result).toEqual({ status: 'opened' })
    expect(store.loadMock).toHaveBeenCalledWith('ast-1')
    expect(busy).toEqual([true, false])
  })

  it('dirty 且未 force → guard-required 守卫信号（不弹窗、不触载入）', async () => {
    const store = fakeStore({ dirty: true })
    const svc = service(store)

    const result = await svc.openFromLibrary('ast-1')
    expect(result).toEqual({ status: 'guard-required' })
    expect(store.loadMock).not.toHaveBeenCalled()
  })

  it('dirty + force → 直达（UI 守卫已裁决）', async () => {
    const store = fakeStore({ dirty: true })
    const svc = service(store)
    expect(await svc.openFromLibrary('ast-1', { force: true })).toEqual({ status: 'opened' })
  })

  it('失败注入：store typed error reason 直映（missing）', async () => {
    const store = fakeStore({ dirty: false, load: () => Promise.reject(new EditGemdocError('精修项目不存在（可能已被删除）。', 'missing')) })
    const result = await service(store).openFromLibrary('ast-1')
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.reason).toBe('missing')
  })

  it('失败注入：parse 失败（ProjectFileKindError）→ parse', async () => {
    const store = fakeStore({
      dirty: false,
      load: () => Promise.reject(new ProjectFileKindError('kind', 'gemdoc', 'gemproj')),
    })
    const result = await service(store).openFromLibrary('ast-1')
    if (result.status === 'failed') expect(result.reason).toBe('parse')
    else throw new Error('expected failed')
  })

  it('失败注入：lease 过期（AssetStoreError 租约面）→ lease', async () => {
    const store = fakeStore({
      dirty: false,
      load: () => Promise.reject(new AssetStoreError('租约已关闭或失效，不能重绑 pin 集合。')),
    })
    const result = await service(store).openFromLibrary('ast-1')
    if (result.status === 'failed') expect(result.reason).toBe('lease')
    else throw new Error('expected failed')
  })
})

describe('save / saveAs 编排', () => {
  it('保存成功映射（created/docId/name）；options 透传', async () => {
    const store = fakeStore()
    const result = await service(store).save({ name: '改名稿' })
    expect(result).toEqual({ status: 'saved', kind: 'created', docId: 'ast-new', name: '测试文档' })
    expect(store.saveMock).toHaveBeenCalledWith({ name: '改名稿' })
  })

  it('失败注入：CAS conflict（ProjectConflictError）→ cas-conflict', async () => {
    const store = fakeStore({
      save: () => Promise.reject(new ProjectConflictError('ast-1', 'blob-a', 'blob-b')),
    })
    const result = await service(store).save()
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.reason).toBe('cas-conflict')
      expect(result.message).toContain('其他入口')
    }
  })

  it('无文档 → no-document（不触 store）', async () => {
    const store = fakeStore({ doc: null })
    const result = await service(store).save()
    if (result.status === 'failed') expect(result.reason).toBe('no-document')
    else throw new Error('expected failed')
    expect(store.saveMock).not.toHaveBeenCalled()
  })

  it('另存为：fork 结果映射 + name 透传', async () => {
    const store = fakeStore()
    const result = await service(store).saveAs('分叉稿')
    expect(result).toEqual({ status: 'saved', kind: 'created', docId: 'ast-fork', name: '分叉稿' })
  })
})

describe('导出编排', () => {
  it('exportGemdoc：store 装配产物透传（只序列化不落库语义归 store）', async () => {
    const result = await service(fakeStore()).exportGemdoc()
    expect(result.status).toBe('exported')
    if (result.status === 'exported') {
      expect(result.filename).toBe('测试文档.gemdoc')
      expect(await result.blob.text()).toBe('gemdoc-bytes')
    }
  })

  it('exportSvg：engine 纯函数编排（12 钻全量、文件名随文档名）', async () => {
    const result = await service(fakeStore()).exportSvg()
    expect(result.status).toBe('exported')
    if (result.status === 'exported') {
      expect(result.filename).toBe('测试文档.svg')
      const svg = await result.blob.text()
      expect(svg).toContain('<svg')
      expect(svg.match(/<circle /g)).toHaveLength(12) // round 快路径逐钻
    }
  })

  it('exportBom：CSV 聚合（表头 + 合计行）', async () => {
    const result = await service(fakeStore()).exportBom()
    expect(result.status).toBe('exported')
    if (result.status === 'exported') {
      expect(result.filename).toBe('测试文档.csv')
      const csv = await result.blob.text()
      expect(csv).toContain('规格,形状,尺寸,色名,hex,数量')
      expect(csv).toContain('合计')
    }
  })

  it('exportPng：renderer 缺席 → typed unavailable（不造假产物）；注入 renderer 则透传', async () => {
    const noRenderer = await service(fakeStore()).exportPng()
    if (noRenderer.status === 'failed') expect(noRenderer.reason).toBe('png-renderer-unavailable')
    else throw new Error('expected failed')

    const rendered = new Blob(['png-bytes'], { type: 'image/png' })
    const renderPng = vi.fn(async () => rendered)
    const result = await service(fakeStore(), { renderPng }).exportPng()
    expect(result).toEqual({ status: 'exported', blob: rendered, filename: '测试文档.png' })
    expect(renderPng).toHaveBeenCalledTimes(1)
  })

  it('导出前无文档 → no-document', async () => {
    const store = fakeStore({ doc: null })
    for (const got of [
      await service(store).exportSvg(),
      await service(store).exportBom(),
      await service(store).exportPng(),
    ]) {
      if (got.status === 'failed') expect(got.reason).toBe('no-document')
      else throw new Error('expected failed')
    }
  })
})

describe('[D-5.2] exportGate 前接（pairwise 保存/导出消费）', () => {
  /** 间距违规文档：g00001 (4,4) 与 g00002 改为 (6,4)——中心距 2px < 所需 8×0.999。 */
  function overlappingDoc(): EditDocument {
    const doc = testDoc()
    doc.gems[1].x = 6
    return doc
  }

  it('exportSvg：spacing 违规 → blocked typed 信号（violations 明细、无 blob）', async () => {
    const result = await service(fakeStore({ doc: overlappingDoc() })).exportSvg()
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') {
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations[0].kind).toBe('spacing')
      expect(result.violations[0].gemIds).toEqual(['g00001', 'g00002'])
      expect(result.violations[0].detail).toContain('中心距')
    }
  })

  it('exportBom / exportPng：同门阻断（PNG gate 先于 renderer——renderer 不被调用）', async () => {
    const renderPng = vi.fn(async () => new Blob(['png']))
    const svc = service(fakeStore({ doc: overlappingDoc() }), { renderPng })
    const bom = await svc.exportBom()
    expect(bom.status).toBe('blocked')
    const png = await svc.exportPng()
    expect(png.status).toBe('blocked')
    expect(renderPng).not.toHaveBeenCalled()
  })

  it('违规修复后放行（同 fixture 恢复间距 → exported）', async () => {
    const doc = overlappingDoc()
    const result1 = await service(fakeStore({ doc })).exportSvg()
    expect(result1.status).toBe('blocked')
    doc.gems[1].x = 12 // 恢复六方格位
    const result2 = await service(fakeStore({ doc })).exportSvg()
    expect(result2.status).toBe('exported')
  })

  it('保存放行（专家稿 §I.3-2：文档可存——save/saveAs 不设门）', async () => {
    const store = fakeStore({ doc: overlappingDoc() })
    const saved = await service(store).save()
    expect(saved.status).toBe('saved')
    expect(store.saveMock).toHaveBeenCalled()
    const forked = await service(store).saveAs('违规副本')
    expect(forked.status).toBe('saved')
  })

  it('missing-asset 面注入：custom 钻引用非 resolved → blocked；resolver 缺席 = 该面跳过', async () => {
    const doc = testDoc()
    doc.gems.push({
      id: 'm-1',
      x: 40,
      y: 40,
      colorId: doc.palette[0]?.id ?? '',
      blockId: null,
      origin: 'manual',
      moved: false,
      shapeId: 'custom',
      diameterMm: 2.8,
      assetId: 'ast-shape-x',
    })
    const blocked = await service(fakeStore({ doc }), {
      resolveShapeAsset: () => 'blob-missing',
    }).exportSvg()
    expect(blocked.status).toBe('blocked')
    if (blocked.status === 'blocked') {
      expect(blocked.violations.some((v) => v.kind === 'missing-asset')).toBe(true)
    }
    // resolver 缺席：missing-asset 面跳过（engine gate 语义——不视为合规以外的断言）
    const passed = await service(fakeStore({ doc })).exportSvg()
    expect(passed.status).toBe('exported')
  })
})

describe('无 payload 第二实现断言（R3 非阻塞建议 2）', () => {
  const raw = readFileSync(join(process.cwd(), 'src/lib/services/documentService.ts'), 'utf8')
  /** 剥注释后的代码面（payload 符号禁令只针对代码；文档注释允许提及契约名） */
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

  it('不 import/不构造 handoff/gemdoc payload 符号（真源恒在 store/replay gate owner）', () => {
    for (const banned of [
      'parseGemdoc',
      'serializeGemdoc',
      'buildManualEditHandoff',
      'ManualEditHandoff',
      'loadFromHandoff',
    ]) {
      expect(code, `documentService 代码面不得出现 payload 符号「${banned}」`).not.toContain(banned)
    }
  })

  it('依赖面只有 engine/persistence/edit store（无 UI、无第二真源）', () => {
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) {
      const allowed =
        spec.startsWith('$lib/engine') ||
        spec.startsWith('$lib/persistence/') ||
        spec === '$lib/stores/edit.svelte'
      expect(allowed, `依赖面越界：${spec}`).toBe(true)
    }
  })
})
