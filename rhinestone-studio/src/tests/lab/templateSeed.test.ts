/**
 * 内置模板条目 seed（openspec add-project-files 4.2 + placeholders 切片 4 v2 换代）：
 * v2 预设 → .gemtpl 落 sys-templates，节点 id `ast-tpl-<baseId>-v2`（占位符新版文案 +
 * caseRef 默认开）；旧 v1 节点软删判定（未修改最小口径 + v2 存在安全门）。
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
  retireUnmodifiedBuiltinTemplates,
  seedBuiltinTemplates,
  type TemplateSeedDeps,
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
import { parseGemtpl, serializeGemtpl, type GemtplFile, type LabCaseBinding } from '$lib/persistence/labFile'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { getImageBlob } from '$lib/persistence/imageStore'
import { VARIANTS_KEY } from '$lib/persistence/taskStore'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import { EFFECT_REF_PRESETS_V2, EFFECT_REF_PRESETS_V3, legacyV2PromptBodyOf } from '$lib/presets/effectRefTemplatesV2'
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
    expect(report.created).toEqual(EFFECT_REF_PRESETS_V3.map((p) => `ast-tpl-${p.id}`))

    // 目录：sys-templates 根层建位，名「模板」（assetStore 目录 seed 面）
    const root = await listChildNodes(null)
    const folder = root.find((n) => n.id === 'sys-templates')
    expect(folder).toMatchObject({ type: 'folder', name: '模板', parentId: null, system: 'sys-templates' })

    const nodes = await templatesUnderSysTemplates()
    expect(nodes).toHaveLength(EFFECT_REF_PRESETS_V3.length)
    for (const preset of EFFECT_REF_PRESETS_V3) {
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
      expect(file.formatVersion).toBe(2)
      expect(file.appVersion).toBe(APP_VERSION)
      expect(file.name).toBe(preset.name)
      expect(file.promptBody).toBe(preset.promptBody) // v2 新版文案（域指导 + 占位符示例行）
      expect(file.promptBody).toContain('【案例参照图提示词】')
      expect(file.candidates).toBe(2) // = lab DEFAULT_CANDIDATES（seed 候选默认，4.3 沿用）
      expect(file.caseBinding).toEqual({ assetId: `ast-case-${preset.baseId}`, caseLayout: 'horizontal' }) // 物化沿用基 presetId
      expect(file.caseRef).toEqual({ enabled: true }) // [placeholders] 案例开关默认开
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
    expect(second.skippedExisting).toEqual(EFFECT_REF_PRESETS_V3.map((p) => `ast-tpl-${p.id}`))
    const after = await templatesUnderSysTemplates()
    expect(after.map((n) => n.id).sort()).toEqual(before.map((n) => n.id).sort())
    expect(after.map((n) => n.blobKey).sort()).toEqual(keysBefore)
  })

  it('软删不复活：删一个内置模板后 seed 跳过（不重建、保持软删态）', async () => {
    await seedBuiltinTemplates(makeDeps())
    const victim = builtinTemplateNodeId('boston-v3')
    await trashAsset(victim)
    expect((await getProject(victim))?.trashedAt).toBeDefined()

    const second = await seedBuiltinTemplates(makeDeps())

    expect(second.created).toEqual([])
    expect(second.failed).toEqual([])
    expect(second.skippedExisting).toContain(victim)
    const node = await getProject(victim)
    expect(node?.trashedAt).toBeDefined() // 未复活
    // 其余 7 个未受牵连
    expect(await templatesUnderSysTemplates()).toHaveLength(EFFECT_REF_PRESETS_V3.length - 1)
  })

  it('create-only 不覆盖用户编辑：seed 后换绑改写 promptBody，再 seed 内容保持用户版', async () => {
    await seedBuiltinTemplates(makeDeps())
    const target = await getProject(builtinTemplateNodeId('new-orleans-v3'))
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
      provenance: { source: 'builtin-seed', presetId: 'new-orleans-v3' },
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
      if (presetId === 'boston') throw new Error('离线：案例图加载失败') // 物化按基 presetId 调用
      return { assetId: `ast-case-${presetId}`, caseLayout: 'horizontal' as const }
    })

    const first = await seedBuiltinTemplates(makeDeps({ materializePreset: failing }))

    expect(first.created).toHaveLength(EFFECT_REF_PRESETS_V3.length - 1)
    expect(first.failed).toEqual([builtinTemplateNodeId('boston-v3')])
    expect(await getProject(builtinTemplateNodeId('boston-v3'))).toBeNull() // 不建半成品
    // 单模板失败不影响其余
    expect(await templatesUnderSysTemplates()).toHaveLength(EFFECT_REF_PRESETS_V3.length - 1)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()

    // 下轮（物化恢复）：只补失败的那个
    const second = await seedBuiltinTemplates(makeDeps())
    expect(second.created).toEqual([builtinTemplateNodeId('boston-v3')])
    expect(second.skippedExisting).toHaveLength(EFFECT_REF_PRESETS_V3.length - 1)
    const nodes = await templatesUnderSysTemplates()
    expect(nodes).toHaveLength(EFFECT_REF_PRESETS_V3.length)
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

    // seed 全部命中内置 v2 preset 目标，不碰 legacy 节点（create-only 按 id 互不相交）
    expect(report.created).toHaveLength(EFFECT_REF_PRESETS_V3.length)
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
    expect(first.map((n) => n.id).sort()).toEqual(EFFECT_REF_PRESETS_V3.map((p) => `ast-tpl-${p.id}`).sort())
    const snapshots = new Map(first.map((n) => [n.id, n.blobKey]))

    for (const preset of EFFECT_REF_PRESETS_V3) {
      const node = await getProject(builtinTemplateNodeId(preset.id))
      const file = await readTemplateFile(node as AssetProject)
      expect(file.promptBody).toBe(preset.promptBody)
      expect(file.caseRef).toEqual({ enabled: true })
      expect(file.provenance).toEqual({ source: 'builtin-seed', presetId: preset.id, sourceNote: preset.sourceNote })
      // jsdom 无 2D 上下文 → 物化降级 single；caseBinding 指向 sys-cases 下合成资产（基 presetId 物化）
      expect(file.caseBinding?.caseLayout).toBe('single')
      const composite = await listChildNodes('sys-cases').then((ns) =>
        ns.find((n) => n.id === file.caseBinding?.assetId),
      )
      expect(composite).toBeDefined()
      expect((composite as { meta?: { presetId?: string } }).meta?.presetId).toBe(preset.baseId)
    }

    // 模拟刷新（模块态复位、IDB 存活）：二次 hydrate 零新增、blobKey 不变
    resetLabForTests()
    await hydrate()
    const second = await templatesUnderSysTemplates()
    expect(second).toHaveLength(EFFECT_REF_PRESETS_V3.length)
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
    expect(await templatesUnderSysTemplates()).toHaveLength(EFFECT_REF_PRESETS_V3.length)
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
    const first = EFFECT_REF_PRESETS_V3[0]
    const card = document.querySelector(`[data-testid="asset-item-${builtinTemplateNodeId(first.id)}"]`)
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain(first.name)
    expect(card?.textContent).toContain('模板')

    unmount(app)
    target.remove()
  })
})

// ---------------------------------------------------------------------------
// [placeholders 切片 4] 旧内置软删矩阵（未修改删 / 修改留 / 用户零触碰 / v2 存在安全门）
// ---------------------------------------------------------------------------

describe('retireUnmodifiedBuiltinTemplates：换代软删矩阵（v1/v2 → v3）', () => {
  /** 预置一个 v1 形态内置节点（默认未修改；overrides 模拟用户编辑）。 */
  async function seedLegacyV1(
    presetId: string,
    overrides: Partial<{ promptBody: string | null; candidates: number | null; caseBinding: LabCaseBinding | null; caseRef: boolean; drillParams: boolean }> = {},
  ): Promise<AssetProject> {
    const preset = EFFECT_REF_PRESETS.find((p) => p.id === presetId)
    expect(preset).toBeDefined()
    const file = serializeGemtpl({
      appVersion: APP_VERSION,
      createdAt: T0,
      savedAt: T0,
      name: preset!.name,
      promptBody: overrides.promptBody ?? preset!.prompt,
      caseBinding:
        overrides.caseBinding === null ? null : { assetId: `ast-case-${presetId}`, caseLayout: 'horizontal' },
      candidates: overrides.candidates ?? 2,
      ...(overrides.drillParams ? { drillParams: { enabled: false, specs: ['round-ss10'] } } : {}),
      ...(overrides.caseRef ? { caseRef: { enabled: false } } : {}),
      provenance: { source: 'builtin-seed', presetId, sourceNote: preset!.sourceNote },
    })
    const result = await ingestProjectAsset({
      blob: new Blob([file], { type: PROJECT_MIME.gemtpl }),
      name: preset!.name,
      projectKind: 'gemtpl',
      id: builtinTemplateNodeId(presetId),
      parentId: 'sys-templates',
    })
    return result.node
  }

  it('未修改旧内置软删（v2 已 seed）：未修改 3 条删、promptBody 改写 1 条留、用户模板零触碰', async () => {
    // v2 seed（提供安全门）+ 预置 3 条未修改 v1 + 1 条改写 v1 + 1 条用户模板
    await seedBuiltinTemplates(makeDeps())
    await seedLegacyV1('new-orleans')
    await seedLegacyV1('savannah')
    await seedLegacyV1('boston')
    await seedLegacyV1('hummingbird-bloom', { promptBody: '用户改过的正文' })
    const userFile = serializeGemtpl({
      appVersion: APP_VERSION,
      createdAt: T0,
      savedAt: T0,
      name: '我的模板',
      promptBody: 'user',
      caseBinding: null,
      candidates: 1,
      provenance: { source: 'user-created' },
    })
    await ingestProjectAsset({
      blob: new Blob([userFile], { type: PROJECT_MIME.gemtpl }),
      name: '我的模板',
      projectKind: 'gemtpl',
      id: 'ast-tpl-user-1',
      parentId: 'sys-templates',
    })

    const report = await retireUnmodifiedBuiltinTemplates()

    expect(report.retired.sort()).toEqual(
      [builtinTemplateNodeId('new-orleans'), builtinTemplateNodeId('savannah'), builtinTemplateNodeId('boston')].sort(),
    )
    expect(report.keptModified).toEqual([builtinTemplateNodeId('hummingbird-bloom')])
    // 软删 = 回收站可找回；未修改三条 trashedAt 落位
    for (const id of report.retired) {
      expect((await getProject(id))?.trashedAt).toBeDefined()
    }
    // 修改过的与用户模板不受影响
    expect((await getProject(builtinTemplateNodeId('hummingbird-bloom')))?.trashedAt).toBeUndefined()
    expect((await getProject('ast-tpl-user-1'))?.trashedAt).toBeUndefined()
    // 列表口径：v2 8 条 + 修改 v1 1 条 + 用户 1 条 = 10（软删 3 条不计）
    expect(await templatesUnderSysTemplates()).toHaveLength(EFFECT_REF_PRESETS_V3.length + 2)
  })

  it('编辑痕迹判定：解绑案例 / 候选数改动 / v2 新键任一配置 = 保留', async () => {
    await seedBuiltinTemplates(makeDeps())
    await seedLegacyV1('new-orleans', { caseBinding: null })
    await seedLegacyV1('savannah', { candidates: 4 })
    await seedLegacyV1('boston', { caseRef: true })

    const report = await retireUnmodifiedBuiltinTemplates()

    expect(report.retired).toEqual([])
    expect(report.keptModified.sort()).toEqual(
      [builtinTemplateNodeId('new-orleans'), builtinTemplateNodeId('savannah'), builtinTemplateNodeId('boston')].sort(),
    )
  })

  it('v2 存在安全门：对应 v2 节点缺失（seed 失败）→ 旧节点不删（不掏空模板库）', async () => {
    // 只预置旧内置，不跑 v2 seed（模拟 v2 物化全线失败）
    await seedLegacyV1('new-orleans')
    await seedLegacyV1('savannah')

    const report = await retireUnmodifiedBuiltinTemplates()

    expect(report.retired).toEqual([])
    expect((await getProject(builtinTemplateNodeId('new-orleans')))?.trashedAt).toBeUndefined()
    expect((await getProject(builtinTemplateNodeId('savannah')))?.trashedAt).toBeUndefined()
  })

  it('幂等：已软删的旧内置不再处理；重复 retire 零新删', async () => {
    await seedBuiltinTemplates(makeDeps())
    await seedLegacyV1('new-orleans')

    const first = await retireUnmodifiedBuiltinTemplates()
    expect(first.retired).toEqual([builtinTemplateNodeId('new-orleans')])
    const second = await retireUnmodifiedBuiltinTemplates()
    expect(second.retired).toEqual([])
    expect(second.keptModified).toEqual([])
  })

  // -------------------------------------------------------------------------
  // [R5.2 走查 P2-4] v2 → v3 换代：存量 v2 节点（WYSIWYG 前无规则尾 / 后含规则尾两种
  // 已知 seed 正文）未修改即软删；用户改过的零触碰；v3 存在安全门同 v1。
  // -------------------------------------------------------------------------

  /** 预置一个 v2 形态内置节点（bodyVariant：'pre-rules' 无规则尾 / 'post-rules' 含规则尾）。 */
  async function seedLegacyV2(
    baseId: string,
    options: { bodyVariant?: 'pre-rules' | 'post-rules'; promptBody?: string } = {},
  ): Promise<AssetProject> {
    const v2 = EFFECT_REF_PRESETS_V2.find((p) => p.id === `${baseId}-v2`)
    expect(v2).toBeDefined()
    const file = serializeGemtpl({
      appVersion: APP_VERSION,
      createdAt: T0,
      savedAt: T0,
      name: v2!.name,
      promptBody:
        options.promptBody ??
        (options.bodyVariant === 'pre-rules'
          ? legacyV2PromptBodyOf(EFFECT_REF_PRESETS.find((p) => p.id === baseId)!.prompt)
          : v2!.promptBody),
      caseBinding: { assetId: `ast-case-${baseId}`, caseLayout: 'horizontal' },
      candidates: 2,
      caseRef: { enabled: true },
      provenance: { source: 'builtin-seed', presetId: v2!.id, sourceNote: v2!.sourceNote },
    })
    const result = await ingestProjectAsset({
      blob: new Blob([file], { type: PROJECT_MIME.gemtpl }),
      name: v2!.name,
      projectKind: 'gemtpl',
      id: builtinTemplateNodeId(v2!.id),
      parentId: 'sys-templates',
    })
    return result.node
  }

  it('[P2-4] 未修改 v2（两代已知正文）软删；用户改写 v2 保留；v3 缺失安全门不删', async () => {
    // v3 seed（安全门）+ 预置 v2 存量：pre-rules（WYSIWYG 前正文）1 条 + post-rules 1 条 + 改写 1 条
    await seedBuiltinTemplates(makeDeps())
    await seedLegacyV2('new-orleans', { bodyVariant: 'pre-rules' })
    await seedLegacyV2('savannah', { bodyVariant: 'post-rules' })
    await seedLegacyV2('boston', { promptBody: '用户改过的 v2 正文' })

    const report = await retireUnmodifiedBuiltinTemplates()

    expect(report.retired.sort()).toEqual(
      [builtinTemplateNodeId('new-orleans-v2'), builtinTemplateNodeId('savannah-v2')].sort(),
    )
    expect(report.keptModified).toEqual([builtinTemplateNodeId('boston-v2')])
    for (const id of report.retired) {
      expect((await getProject(id))?.trashedAt).toBeDefined() // 回收站可找回
    }
    expect((await getProject(builtinTemplateNodeId('boston-v2')))?.trashedAt).toBeUndefined()
  })

  it('[P2-4] v2 存在安全门：v3 节点缺失（seed 失败）→ v2 不删（不掏空模板库）', async () => {
    // 只预置未修改 v2（pre-rules），不跑 v3 seed（模拟 v3 物化全线失败）
    await seedLegacyV2('new-orleans', { bodyVariant: 'pre-rules' })

    const report = await retireUnmodifiedBuiltinTemplates()

    expect(report.retired).toEqual([])
    expect(report.keptModified).toEqual([])
    expect((await getProject(builtinTemplateNodeId('new-orleans-v2')))?.trashedAt).toBeUndefined()
  })

  it('[P2-4] v2 编辑痕迹判定：caseRef 关闭 / drillParams 配置 = 保留', async () => {
    const v2 = EFFECT_REF_PRESETS_V2.find((p) => p.id === 'new-orleans-v2')!
    const mk = async (id: string, extra: string) => {
      const preset = EFFECT_REF_PRESETS.find((p) => p.id === 'new-orleans')!
      const file = serializeGemtpl({
        appVersion: APP_VERSION,
        createdAt: T0,
        savedAt: T0,
        name: v2.name,
        promptBody: v2.promptBody,
        caseBinding: { assetId: `ast-case-new-orleans`, caseLayout: 'horizontal' },
        candidates: 2,
        ...(extra === 'caseRef-off' ? { caseRef: { enabled: false } } : { caseRef: { enabled: true } }),
        ...(extra === 'drill' ? { drillParams: { enabled: false, specs: ['round-ss10'] } } : {}),
        provenance: { source: 'builtin-seed', presetId: v2.id, sourceNote: preset.sourceNote },
      })
      await ingestProjectAsset({
        blob: new Blob([file], { type: PROJECT_MIME.gemtpl }),
        name: v2.name,
        projectKind: 'gemtpl',
        id: builtinTemplateNodeId(id),
        parentId: 'sys-templates',
      })
    }
    await seedBuiltinTemplates(makeDeps())
    await mk('new-orleans-v2', 'caseRef-off')
    await mk('new-orleans-v2', 'drill') // 同 id 二次 ingest = create-only 命中跳过——换 id 验证
    // （drill 变体换 savannah 位验证）
    const savannah = EFFECT_REF_PRESETS_V2.find((p) => p.id === 'savannah-v2')!
    const file = serializeGemtpl({
      appVersion: APP_VERSION,
      createdAt: T0,
      savedAt: T0,
      name: savannah.name,
      promptBody: savannah.promptBody,
      caseBinding: { assetId: `ast-case-savannah`, caseLayout: 'horizontal' },
      candidates: 2,
      caseRef: { enabled: true },
      drillParams: { enabled: false, specs: ['round-ss10'] },
      provenance: { source: 'builtin-seed', presetId: savannah.id, sourceNote: savannah.sourceNote },
    })
    await ingestProjectAsset({
      blob: new Blob([file], { type: PROJECT_MIME.gemtpl }),
      name: savannah.name,
      projectKind: 'gemtpl',
      id: builtinTemplateNodeId('savannah-v2'),
      parentId: 'sys-templates',
    })

    const report = await retireUnmodifiedBuiltinTemplates()
    expect(report.retired).toEqual([])
    expect(report.keptModified.sort()).toEqual(
      [builtinTemplateNodeId('new-orleans-v2'), builtinTemplateNodeId('savannah-v2')].sort(),
    )
  })
})
