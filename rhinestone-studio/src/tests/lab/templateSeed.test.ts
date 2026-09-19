/**
 * 内置模板条目 seed（openspec add-project-files 4.2，design §7.1 前两条 + 补充稿 A.4.1）：
 * preset → .gemtpl 落 sys-templates，节点 id `ast-tpl-${presetId}`。
 *
 * 覆盖（tasks.md 4.2 vitest 口径）：
 * - 全新库 seed 8 模板（id / provenance / promptBody / caseBinding / 落位 sys-templates / 目录插位）
 * - 幂等：直接二次 seed 零新增；经 lab hydrate 二次（reset+hydrate 模拟刷新）零新增且内容不变
 * - 软删不复活（删一个再 seed 不重建）；create-only 不覆盖用户编辑
 * - 物化失败单模板跳过其余照常（stub materialize 抛错）→ 下轮重试成功
 * - 与 0.8 迁移引擎共存：预置 ast-tpl-legacy-* 节点 + {v:2} 残留不触发引擎（journal key 缺席）
 * - AssetsView 系统目录清单含「模板」且位于「生成结果」之前（补充稿 C.1 插位）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import {
  APP_VERSION,
  builtinTemplateNodeId,
  seedBuiltinTemplates,
  type TemplateSeedDeps,
  type TemplateSeedReport,
} from '$lib/lab/templateSeed'
import { TEMPLATE_MIGRATION_JOURNAL_KEY } from '$lib/lab/templateMigration'
import {
  getProject,
  ingestProjectAsset,
  listChildNodes,
  resetAssetStoreForTests,
  trashAsset,
  updateProjectAsset,
} from '$lib/persistence/assetStore'
import { parseGemtpl, serializeGemtpl, type GemtplFile } from '$lib/persistence/labFile'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { getImageBlob } from '$lib/persistence/imageStore'
import { VARIANTS_KEY } from '$lib/persistence/taskStore'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import { hydrate, resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import * as library from '$lib/assets/library.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import AssetsView from '$lib/components/views/AssetsView.svelte'
import { drainFakeIndexedDBChains, installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let objectUrlCounter = 0

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  // jsdom 的 Image 不解码：物化管线 loadDrawable 走「可解码桩」（无 2D → 降级 single）
  class OkImage {
    naturalWidth = 64
    naturalHeight = 64
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)
  resetAssetStoreForTests()
  localStorage.clear()
  resetLabForTests()
  resetToastsForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(async () => {
  // runTx 等 oncomplete 真提交后，链上写入可能仍在途——先排空再 unstub（沿 effectRef.test.ts 先例）
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000

/** 桩物化：每 preset 给确定性合成资产（horizontal），不触网络——聚焦 seed 数据面。 */
function stubMaterialize(): (presetId: string) => Promise<{ assetId: string; caseLayout: 'horizontal' }> {
  return (presetId: string) => Promise.resolve({ assetId: `ast-case-${presetId}`, caseLayout: 'horizontal' })
}

function makeDeps(overrides: Partial<TemplateSeedDeps> = {}): TemplateSeedDeps {
  return {
    materializePreset: overrides.materializePreset ?? stubMaterialize(),
    now: overrides.now ?? (() => T0),
    appVersion: overrides.appVersion,
    getProject: overrides.getProject,
    ingestProjectAsset: overrides.ingestProjectAsset,
  }
}

async function readTemplateFile(node: AssetProject): Promise<GemtplFile> {
  const blob = await getImageBlob(node.blobKey)
  expect(blob).not.toBeNull()
  return parseGemtpl(await (blob as Blob).text(), { mime: node.mime })
}

/** 模板目录直系 gemtpl 节点（未软删——实验室列表/回收站可见性口径同 B.1.1）。 */
async function templatesUnderSysTemplates(): Promise<AssetProject[]> {
  const children = await listChildNodes('sys-templates')
  return children.filter((n): n is AssetProject => n.type === 'project' && n.trashedAt === undefined)
}

/** 图片字节（Uint8Array body 才能穿透 jsdom Response.blob() 的字节保真；Blob body 会字符串化）。 */
function imageResponse(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  })
}

// ---------------------------------------------------------------------------
// 数据面：全新库 seed + 幂等 + 软删 + create-only + 失败重试
// ---------------------------------------------------------------------------

describe('seedBuiltinTemplates：全新库 8 模板数据面', () => {
  it('8 preset 全 seed：节点 id/落位/provenance/promptBody/caseBinding/candidates/appVersion 齐备；目录「模板」建位', async () => {
    const report = await seedBuiltinTemplates(makeDeps())

    expect(report.created).toHaveLength(EFFECT_REF_PRESETS.length)
    expect(report.skippedExisting).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.created).toEqual(EFFECT_REF_PRESETS.map((p) => `ast-tpl-${p.id}`))

    // 目录：sys-templates 根层建位，名「模板」（assetStore 目录 seed 面）
    const root = await listChildNodes(null)
    const folder = root.find((n) => n.id === 'sys-templates')
    expect(folder).toMatchObject({ type: 'folder', name: '模板', parentId: null, system: 'sys-templates' })

    const nodes = await templatesUnderSysTemplates()
    expect(nodes).toHaveLength(EFFECT_REF_PRESETS.length)
    for (const preset of EFFECT_REF_PRESETS) {
      const node = await getProject(builtinTemplateNodeId(preset.id))
      expect(node, `ast-tpl-${preset.id} 应存在`).not.toBeNull()
      if (!node) continue
      expect(node.parentId).toBe('sys-templates')
      expect(node.projectKind).toBe('gemtpl')
      expect(node.mime).toBe(PROJECT_MIME.gemtpl)
      expect(node.name).toBe(preset.name)
      expect(node.trashedAt).toBeUndefined()

      const file = await readTemplateFile(node)
      expect(file.kind).toBe('gemtpl')
      expect(file.formatVersion).toBe(1)
      expect(file.appVersion).toBe(APP_VERSION)
      expect(file.name).toBe(preset.name)
      expect(file.promptBody).toBe(preset.prompt)
      expect(file.candidates).toBe(2) // = lab DEFAULT_CANDIDATES（defaultVariants 现状）
      expect(file.caseBinding).toEqual({ assetId: `ast-case-${preset.id}`, caseLayout: 'horizontal' })
      expect(file.provenance).toEqual({ source: 'builtin-seed', presetId: preset.id, sourceNote: preset.sourceNote })
      expect(file.createdAt).toBe(T0)
      expect(file.savedAt).toBe(T0)
    }
  })

  it('幂等：二次 seed 零新增（全部 skipped-existing），既有节点 blobKey 不变', async () => {
    await seedBuiltinTemplates(makeDeps())
    const before = await templatesUnderSysTemplates()
    const keysBefore = before.map((n) => n.blobKey).sort()

    const second = await seedBuiltinTemplates(makeDeps())

    expect(second.created).toEqual([])
    expect(second.failed).toEqual([])
    expect(second.skippedExisting).toEqual(EFFECT_REF_PRESETS.map((p) => `ast-tpl-${p.id}`))
    const after = await templatesUnderSysTemplates()
    expect(after.map((n) => n.id).sort()).toEqual(before.map((n) => n.id).sort())
    expect(after.map((n) => n.blobKey).sort()).toEqual(keysBefore)
  })

  it('软删不复活：删一个内置模板后 seed 跳过（不重建、保持软删态）', async () => {
    await seedBuiltinTemplates(makeDeps())
    const victim = builtinTemplateNodeId('boston')
    await trashAsset(victim)
    expect((await getProject(victim))?.trashedAt).toBeDefined()

    const second = await seedBuiltinTemplates(makeDeps())

    expect(second.created).toEqual([])
    expect(second.failed).toEqual([])
    expect(second.skippedExisting).toContain(victim)
    const node = await getProject(victim)
    expect(node?.trashedAt).toBeDefined() // 未复活
    // 其余 7 个未受牵连
    expect(await templatesUnderSysTemplates()).toHaveLength(EFFECT_REF_PRESETS.length - 1)
  })

  it('create-only 不覆盖用户编辑：seed 后换绑改写 promptBody，再 seed 内容保持用户版', async () => {
    await seedBuiltinTemplates(makeDeps())
    const target = await getProject(builtinTemplateNodeId('new-orleans'))
    expect(target).not.toBeNull()
    if (!target) return

    const edited = serializeGemtpl({
      appVersion: APP_VERSION,
      createdAt: target.createdAt,
      savedAt: T0 + 1000,
      name: '我的城市分层',
      promptBody: '用户改写的特化正文',
      caseBinding: null,
      candidates: 5,
      provenance: { source: 'builtin-seed', presetId: 'new-orleans' },
    })
    await updateProjectAsset(target.id, {
      expectedBlobKey: target.blobKey,
      bytes: new Blob([edited], { type: PROJECT_MIME.gemtpl }),
      summary: {},
    })

    await seedBuiltinTemplates(makeDeps())

    const node = await getProject(target.id)
    expect(node?.blobKey).not.toBe(target.blobKey) // 用户换绑的物理键原样保留（未被覆盖回 seed 版）
    const file = await readTemplateFile(node as AssetProject)
    expect(file.promptBody).toBe('用户改写的特化正文')
    expect(file.name).toBe('我的城市分层')
    expect(file.candidates).toBe(5)
    expect(file.caseBinding).toBeNull()
  })

  it('物化失败单模板跳过其余照常（stub materialize 抛错）；下轮 seed 重试成功补齐', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = vi.fn(async (presetId: string) => {
      if (presetId === 'boston') throw new Error('离线：案例图加载失败')
      return { assetId: `ast-case-${presetId}`, caseLayout: 'horizontal' as const }
    })

    const first = await seedBuiltinTemplates(makeDeps({ materializePreset: failing }))

    expect(first.created).toHaveLength(EFFECT_REF_PRESETS.length - 1)
    expect(first.failed).toEqual([builtinTemplateNodeId('boston')])
    expect(await getProject(builtinTemplateNodeId('boston'))).toBeNull() // 不建半成品
    // 单模板失败不影响其余
    expect(await templatesUnderSysTemplates()).toHaveLength(EFFECT_REF_PRESETS.length - 1)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()

    // 下轮（物化恢复）：只补失败的那个
    const second = await seedBuiltinTemplates(makeDeps())
    expect(second.created).toEqual([builtinTemplateNodeId('boston')])
    expect(second.skippedExisting).toHaveLength(EFFECT_REF_PRESETS.length - 1)
    const nodes = await templatesUnderSysTemplates()
    expect(nodes).toHaveLength(EFFECT_REF_PRESETS.length)
  })
})

// ---------------------------------------------------------------------------
// 与 0.8 迁移引擎共存（不测引擎本身）
// ---------------------------------------------------------------------------

describe('seed 与 variants {v:2} 迁移残留共存', () => {
  it('预置 ast-tpl-legacy-* 节点 + {v:2} 残留：seed 只建内置 8 条，不触发引擎（journal key 缺席）、不动 legacy 节点与旧 key', async () => {
    // 自建模板的确定性迁移目标节点（journal 引擎 4.3 接线后的产物形态预置）
    const legacyId = 'ast-tpl-legacy-my-own'
    const legacyFile = serializeGemtpl({
      appVersion: APP_VERSION,
      createdAt: T0,
      savedAt: T0,
      name: '我的模板',
      promptBody: 'user prompt',
      caseBinding: null,
      candidates: 3,
      provenance: { source: 'user-created' },
    })
    const legacyNode = (
      await ingestProjectAsset({
        blob: new Blob([legacyFile], { type: PROJECT_MIME.gemtpl }),
        name: '我的模板',
        projectKind: 'gemtpl',
        id: legacyId,
        parentId: 'sys-templates',
      })
    ).node
    // {v:2} 信封残留（迁移引擎未接线的现状）
    const variantsRaw = JSON.stringify({ v: 2, items: [{ id: 'my-own', name: '我的模板', prompt: 'user prompt', candidates: 3 }] })
    localStorage.setItem(VARIANTS_KEY, variantsRaw)

    const report = await seedBuiltinTemplates(makeDeps())

    // seed 全部命中内置 preset 目标，不碰 legacy 节点（create-only 按 id 互不相交）
    expect(report.created).toHaveLength(EFFECT_REF_PRESETS.length)
    expect(report.skippedExisting).toEqual([])
    const node = await getProject(legacyId)
    expect(node?.blobKey).toBe(legacyNode.blobKey)
    expect((await readTemplateFile(node as AssetProject)).promptBody).toBe('user prompt')

    // 引擎未被触发：journal key 缺席、VARIANTS_KEY 原样保留（删 key 归 4.3 接线后的引擎）
    expect(localStorage.getItem(TEMPLATE_MIGRATION_JOURNAL_KEY)).toBeNull()
    expect(localStorage.getItem(VARIANTS_KEY)).toBe(variantsRaw)
  })
})

// ---------------------------------------------------------------------------
// lab hydrate 挂接（真 materializePresetEffectRef 管线：fetch 桩 + jsdom 降级 single）
// ---------------------------------------------------------------------------

describe('hydrate 挂接：官方默认就位（真物化管线）', () => {
  function stubPresetFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/presets/')) {
        // 每 URL 唯一字节：素材库内容寻址去重按字节判定——同字节会让 8 个 preset 的
        // 合成图在 sys-cases 去重成一个节点，案例绑定全指向同一资产
        const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
        return imageResponse([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239])
      }
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })
  }

  it('首次 hydrate：8 模板入 sys-templates（caseBinding 物化落 sys-cases 资产）；二次 hydrate 零新增且内容不变', async () => {
    vi.stubGlobal('fetch', stubPresetFetch())
    await hydrate()

    const first = await templatesUnderSysTemplates()
    expect(first.map((n) => n.id).sort()).toEqual(EFFECT_REF_PRESETS.map((p) => `ast-tpl-${p.id}`).sort())
    const snapshots = new Map(first.map((n) => [n.id, n.blobKey]))

    for (const preset of EFFECT_REF_PRESETS) {
      const node = await getProject(builtinTemplateNodeId(preset.id))
      const file = await readTemplateFile(node as AssetProject)
      expect(file.promptBody).toBe(preset.prompt)
      expect(file.provenance).toEqual({ source: 'builtin-seed', presetId: preset.id, sourceNote: preset.sourceNote })
      // jsdom 无 2D 上下文 → 物化降级 single；caseBinding 指向 sys-cases 下合成资产
      expect(file.caseBinding?.caseLayout).toBe('single')
      const composite = await listChildNodes('sys-cases').then((ns) =>
        ns.find((n) => n.id === file.caseBinding?.assetId),
      )
      expect(composite).toBeDefined()
      expect((composite as { meta?: { presetId?: string } }).meta?.presetId).toBe(preset.id)
    }

    // 模拟刷新（模块态复位、IDB 存活）：二次 hydrate 零新增、blobKey 不变
    resetLabForTests()
    await hydrate()
    const second = await templatesUnderSysTemplates()
    expect(second).toHaveLength(EFFECT_REF_PRESETS.length)
    for (const node of second) {
      expect(snapshots.get(node.id)).toBe(node.blobKey)
    }
  })

  it('离线首启（物化 fetch 失败）：hydrate 不抛、零半成品，warn 记账；网络恢复后下轮 hydrate 补齐', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(hydrate()).resolves.toBeUndefined()
    expect(await templatesUnderSysTemplates()).toHaveLength(0)

    resetLabForTests()
    warn.mockRestore()
    vi.stubGlobal('fetch', stubPresetFetch())
    await hydrate()
    expect(await templatesUnderSysTemplates()).toHaveLength(EFFECT_REF_PRESETS.length)
  })
})

// ---------------------------------------------------------------------------
// AssetsView 系统目录插位（补充稿 C.1）+ 哑卡片渲染
// ---------------------------------------------------------------------------

describe('AssetsView 系统目录清单（C.1 插位）', () => {
  async function flush(ms = 30): Promise<void> {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  it('「模板」位于「生成结果」之前；gemtpl 哑卡片在该目录渲染（图标 + 类型标注，不报错）', async () => {
    await seedBuiltinTemplates(makeDeps())
    library.resetLibraryForTests()
    await library.ensureLibraryReady()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(AssetsView, { target })
    await flush()

    const tplEntry = document.querySelector('[data-testid="tree-sys-sys-templates"]')
    expect(tplEntry).not.toBeNull()
    expect(tplEntry?.textContent).toContain('模板')
    const genEntry = document.querySelector('[data-testid="tree-sys-sys-generated"]')
    expect(genEntry).not.toBeNull()
    // 产线邻接：全部素材 → 模板 → 生成结果 → … → 回收站
    expect(tplEntry!.compareDocumentPosition(genEntry!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // 哑卡片：进入模板目录，seed 节点以图标 + 「模板」类型标注渲染（type-aware 完整化归 4.3+）
    tplEntry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    const first = EFFECT_REF_PRESETS[0]
    const card = document.querySelector(`[data-testid="asset-item-${builtinTemplateNodeId(first.id)}"]`)
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain(first.name)
    expect(card?.textContent).toContain('模板')

    unmount(app)
    target.remove()
  })
})
