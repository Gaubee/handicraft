/**
 * 模板共享 store（lib/stores/templates.svelte.ts）+ 4.3 迁移接线测试
 * （openspec add-project-files design §7.1/§9.3 E4 + 补充稿 B.1；fake IDB + 真实 labFile/assetStore）。
 *
 * 覆盖（切片 4.3 vitest 口径）：
 * - CRUD 写路径：seed 后列表/record 解析、新建即 ingest「模板 N」、rename 节点名+文件名同步、
 *   fork「原名 副本」、软删列表消失+选中回落、移出目录=收起（移回恢复）
 * - 写队列（E4）：并发字段提交合并单写；写入飞行中追加提交 → 追加轮次终态=最新（旧 revision
 *   不覆盖新写）；写失败 record 回显旧值 + toast 三段式 + 磁盘不动
 * - 32 条上限（saveVariants 旧防线新家）
 * - 双宿主地基：同一 assetId 两个 TemplateEditor 订阅者实时互见
 * - 迁移接线 e2e：legacy {v:2}（用户编辑 builtin + 自建）→ hydrate → 库模板 + session enabled +
 *   VARIANTS_KEY 删除 + journal done；**版本门 bump 后库模板零变化（主指标）**
 * - startRun：templateAssetId 快照 / 空 promptBody 模板跳过（校验口径不变）
 * - applyTaskParams 非破坏化（不写模板）+ copyTaskPrompt 剪贴板
 * - lab-session：损坏回默认全启用；跨 tab storage 事件非静默同步
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'

// updateProjectAsset 门控 mock：透传真实实现，可注入「飞行中保持」观察写队列语义。
const { updateGate } = vi.hoisted(() => ({
  updateGate: {
    deferred: null as Promise<void> | null,
    calls: 0,
    blobs: [] as string[],
  },
}))

vi.mock('$lib/persistence/assetStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/persistence/assetStore')>()
  const originalUpdate = actual.updateProjectAsset
  return {
    ...actual,
    updateProjectAsset: async (
      projectId: string,
      options: Parameters<typeof originalUpdate>[1],
    ): Promise<ReturnType<typeof originalUpdate>> => {
      updateGate.calls += 1
      updateGate.blobs.push(await options.bytes.text())
      const run = () => originalUpdate(projectId, options)
      return updateGate.deferred ? updateGate.deferred.then(run) : run()
    },
  }
})

import {
  createFolder,
  getProject,
  ingestProjectAsset,
  listChildNodes,
  moveAsset,
  resetAssetStoreForTests,
  trashAsset,
} from '$lib/persistence/assetStore'
import {
  LAB_SESSION_KEY,
  TEMPLATE_MIGRATION_BACKUP_KEY,
  TEMPLATE_MIGRATION_JOURNAL_KEY,
} from '$lib/lab/templateMigration'
import { parseGemtpl, serializeGemtpl, type GemtplFile } from '$lib/persistence/labFile'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { getImageBlob } from '$lib/persistence/imageStore'
import { VARIANTS_KEY } from '$lib/persistence/taskStore'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import {
  copyTaskPrompt,
  applyTaskParams,
  getForm,
  getTasks,
  hydrate,
  resetLabForTests,
  startRun,
  updateSettings,
} from '$lib/stores/lab.svelte'
import {
  MAX_TEMPLATES,
  createTemplate,
  forkTemplate,
  getSelectedTemplateAssetId,
  getTemplateAssetIds,
  getTemplateList,
  getTemplateRecord,
  isEnabledTemplate,
  refreshTemplates,
  removeTemplate,
  selectTemplate,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import TemplateEditor from '../../components/Lab/TemplateEditor.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains, type FakeIndexedDB } from './helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let objectUrlCounter = 0

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

const B64 = 'aGVsbG8='

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** hydrate 种子默认桩：/presets/ 静态图（每 URL 唯一字节防内容寻址并辙）+ 生成端点成功。 */
function stubSeedFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/presets/')) {
      const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (u.endsWith('/images/generations') || u.endsWith('/images/edits')) return okResponse()
    return new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function defer(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
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
  vi.stubGlobal('fetch', stubSeedFetch())
  updateGate.deferred = null
  updateGate.calls = 0
  updateGate.blobs = []
  localStorage.clear()
  resetLabForTests() // cancelAll 会把上一测试的内存任务持久化——先复位再清 localStorage，防 hydrate 捞回陈旧任务
  localStorage.clear()
  resetToastsForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(async () => {
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

async function readTemplateFile(assetId: string): Promise<GemtplFile> {
  const node = await getProject(assetId)
  expect(node, `节点 ${assetId} 应存在`).not.toBeNull()
  const blob = await getImageBlob((node as AssetProject).blobKey)
  expect(blob).not.toBeNull()
  return parseGemtpl(await (blob as Blob).text())
}

/** 模板目录直系 gemtpl 节点（未软删）。 */
async function templateNodesUnderSys(): Promise<AssetProject[]> {
  const children = await listChildNodes('sys-templates')
  return children.filter((n): n is AssetProject => n.type === 'project' && n.trashedAt === undefined)
}

/** 直接入库极小 gemtpl（构造 32 上限场景，不走 store 慢路径）。 */
async function ingestBareTemplate(name: string): Promise<string> {
  const stamp = Date.now()
  const result = await ingestProjectAsset({
    blob: new Blob(
      [
        serializeGemtpl({
          appVersion: 'vitest-4.3',
          createdAt: stamp,
          savedAt: stamp,
          name,
          promptBody: 'bulk',
          caseBinding: null,
          candidates: 1,
          provenance: { source: 'user-created' },
        }),
      ],
      { type: PROJECT_MIME.gemtpl },
    ),
    name,
    projectKind: 'gemtpl',
    parentId: 'sys-templates',
  })
  return result.node.id
}

/** 模板全库内容快照（id → 文件 JSON；主指标「零变化」比对用）。 */
async function librarySnapshot(): Promise<Map<string, GemtplFile>> {
  const map = new Map<string, GemtplFile>()
  for (const id of getTemplateAssetIds()) map.set(id, await readTemplateFile(id))
  return map
}

// ---------------------------------------------------------------------------
// CRUD 写路径 + 列表口径
// ---------------------------------------------------------------------------

describe('templates store：seed 后列表与 record 解析', () => {
  it('hydrate 后 8 内置模板入列表：record 四件套齐备、默认全启用+首项选中', async () => {
    await hydrate()

    const ids = getTemplateAssetIds()
    expect(ids).toEqual(EFFECT_REF_PRESETS.map((p) => `ast-tpl-${p.id}-v2`)) // [placeholders] v2 换代增量 seed
    for (const preset of EFFECT_REF_PRESETS) {
      const record = getTemplateRecord(`ast-tpl-${preset.id}-v2`)
      expect(record, `ast-tpl-${preset.id}-v2 record`).toBeDefined()
      if (!record) continue
      expect(record.name).toBe(preset.name)
      expect(record.promptBody).toBe(`${preset.prompt}\n【案例参照图提示词】`) // [placeholders] v2 新版文案
      expect(record.candidates).toBe(2)
      // seed 物化后恒为 asset 绑定（B.1.3：UI 不再呈现 preset kind）
      expect(record.caseBinding).not.toBeNull()
      expect(record.caseBinding?.assetId).toMatch(/^ast-/)
      expect(record.caseRef).toEqual({ enabled: true }) // 案例开关 seed 默认开
      expect(record.provenance).toEqual({ source: 'builtin-seed', presetId: `${preset.id}-v2`, sourceNote: preset.sourceNote })
      expect(record.lastError).toBeNull()
    }
    // 默认 session：全部启用 + 首项选中（E8：无 payload 回默认）
    expect(ids.every((id) => isEnabledTemplate(id))).toBe(true)
    expect(getSelectedTemplateAssetId()).toBe(ids[0])
  })

  it('新建即 ingest「模板 N」：入列表+默认启用+选中切换；提交字段 = 节点/文件/record 同步', async () => {
    await hydrate()
    const seeded = getTemplateAssetIds().length

    const created = await createTemplate()
    expect(created).not.toBeNull()
    expect(getTemplateAssetIds()).toHaveLength(seeded + 1)
    expect(getSelectedTemplateAssetId()).toBe(created)
    const record = getTemplateRecord(created as string)
    expect(record).toMatchObject({ name: `模板 ${seeded + 1}`, promptBody: '', candidates: 2, caseBinding: null })
    expect(record?.provenance.source).toBe('user-created')
    expect(isEnabledTemplate(created as string)).toBe(true)

    // rename 同步：submitField(name) → 节点名 + 文件名 + record 三方一致
    submitTemplateField(created as string, { name: '我的新模板' })
    await whenTemplatesIdle()
    const node = await getProject(created as string)
    expect(node?.name).toBe('我的新模板')
    const file = await readTemplateFile(created as string)
    expect(file.name).toBe('我的新模板')
    expect(getTemplateRecord(created as string)?.name).toBe('我的新模板')

    // 候选 clamp（1-8）与提示词体截断（8000）
    submitTemplateField(created as string, { candidates: 99, promptBody: 'x'.repeat(9000) })
    await whenTemplatesIdle()
    expect(getTemplateRecord(created as string)?.candidates).toBe(8)
    expect(getTemplateRecord(created as string)?.promptBody).toBe('x'.repeat(8000))
    expect((await readTemplateFile(created as string)).promptBody).toBe('x'.repeat(8000))
  })

  it('复制 fork：「原名 副本」新节点 + provenance forked + 案例绑定随带 + 选中切换', async () => {
    await hydrate()
    const source = getTemplateAssetIds()[0]
    const sourceRecord = getTemplateRecord(source)

    const forked = await forkTemplate(source)
    expect(forked).not.toBeNull()
    expect(forked).not.toBe(source)
    expect(getSelectedTemplateAssetId()).toBe(forked)
    const node = await getProject(forked as string)
    expect(node?.name).toBe(`${sourceRecord?.name} 副本`)
    const file = await readTemplateFile(forked as string)
    expect(file.provenance.source).toBe('forked')
    expect(file.promptBody).toBe(sourceRecord?.promptBody)
    expect(file.candidates).toBe(sourceRecord?.candidates)
    expect(file.caseBinding).toEqual(sourceRecord?.caseBinding ?? null)
  })

  it('删除 = 软删入回收站：列表消失 + 选中回落首项；移出目录 = 收起（移回恢复）', async () => {
    await hydrate()
    const ids = getTemplateAssetIds()
    const victim = ids[1]

    await removeTemplate(victim)
    expect(getTemplateAssetIds()).not.toContain(victim)
    const node = await getProject(victim)
    expect(node?.trashedAt).toBeDefined() // 软删（回收站可还原）
    expect(getSelectedTemplateAssetId()).toBe(ids[0]) // 选中回落

    // 还原（回收站语义）：refresh 后回到列表
    ;(node as AssetProject).trashedAt = undefined
    await refreshTemplates()
    expect(getTemplateAssetIds()).toContain(victim)

    // 移出目录 = 收起；移回 = 恢复（B.1.1：库仍真源）
    const folder = await createFolder(null, '用户目录')
    const moved = await moveAsset(victim, folder.id)
    expect(moved.parentId).toBe(folder.id)
    await refreshTemplates()
    expect(getTemplateAssetIds()).not.toContain(victim)
    await moveAsset(victim, 'sys-templates')
    await refreshTemplates()
    expect(getTemplateAssetIds()).toContain(victim)
  })
})

// ---------------------------------------------------------------------------
// 写队列（E4：串行 + 单调 revision，旧写不覆盖新写）
// ---------------------------------------------------------------------------

describe('templates store：写队列与失败回显', () => {
  it('并发字段提交合并为单写（执行时刻现算内容）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const callsBefore = updateGate.calls

    submitTemplateField(id, { name: '批量改名' })
    submitTemplateField(id, { promptBody: '批量提示词' })
    await whenTemplatesIdle()

    expect(updateGate.calls - callsBefore).toBe(1) // 合并：一轮写
    const file = await readTemplateFile(id)
    expect(file.name).toBe('批量改名')
    expect(file.promptBody).toBe('批量提示词')
  })

  it('写入飞行中追加提交：追加轮次承接，终态=最新（旧 revision 完成不覆盖新内容）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const originalPrompt = getTemplateRecord(id)?.promptBody ?? ''

    const gate = defer()
    updateGate.deferred = gate.promise
    submitTemplateField(id, { name: '第一笔' })
    await waitFor(() => updateGate.calls === 1)
    // 写 1 已在飞行中（其内容快照 = 仅第一笔）
    expect(updateGate.blobs[0]).toContain('第一笔')
    expect(updateGate.blobs[0]).not.toContain('第二笔')

    submitTemplateField(id, { promptBody: '第二笔' }) // 飞行中追加 → revision +1
    gate.release()
    await whenTemplatesIdle()

    expect(updateGate.calls).toBe(2) // 追加轮次
    const file = await readTemplateFile(id)
    expect(file.name).toBe('第一笔')
    expect(file.promptBody).toBe('第二笔') // 终态 = 最新内容（旧写不曾覆盖它）
    expect(file.promptBody).not.toBe(originalPrompt)
  })

  it('写失败：toast 三段式 + record 回显旧值 + 磁盘不动', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const before = await readTemplateFile(id)
    const nodeBefore = await getProject(id)

    fake.failNext({ store: 'assetNodes', op: 'put' }) // 换绑事务在 node put 处失败回滚
    submitTemplateField(id, { promptBody: '注定失败的提交' })
    await whenTemplatesIdle()

    const record = getTemplateRecord(id)
    expect(record?.promptBody).toBe(before.promptBody) // 回显旧值
    expect(record?.lastError).toBeTruthy()
    expect(record?.saving).toBe(false)
    expect(getToasts().some((t) => t.message.startsWith('保存失败：'))).toBe(true)

    const nodeAfter = await getProject(id)
    expect(nodeAfter?.blobKey).toBe(nodeBefore?.blobKey) // 磁盘零变化
    expect((await readTemplateFile(id)).promptBody).toBe(before.promptBody)

    // 恢复后再提交成功（无残留熔断）
    submitTemplateField(id, { promptBody: '恢复后的提交' })
    await whenTemplatesIdle()
    expect((await readTemplateFile(id)).promptBody).toBe('恢复后的提交')
    expect(getTemplateRecord(id)?.lastError).toBeNull()
  })

  it('32 条上限（saveVariants 旧防线新家）：到达后拒绝新建并提示', async () => {
    await hydrate() // 8 条内置
    for (let i = 0; i < MAX_TEMPLATES - 8 - 1; i += 1) {
      await ingestBareTemplate(`bulk-${i}`)
    }
    await refreshTemplates()
    expect(getTemplateList()).toHaveLength(MAX_TEMPLATES - 1)

    const ok = await createTemplate()
    expect(ok).not.toBeNull() // 第 32 条放行
    expect(getTemplateList()).toHaveLength(MAX_TEMPLATES)

    resetToastsForTests()
    const rejected = await createTemplate()
    expect(rejected).toBeNull()
    expect(getTemplateList()).toHaveLength(MAX_TEMPLATES)
    expect(getToasts().some((t) => t.message.includes('上限'))).toBe(true)

    const rejectedFork = await forkTemplate(getTemplateAssetIds()[0])
    expect(rejectedFork).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 双宿主地基：同一 assetId 两个订阅者实时互见（宿主不持副本）
// ---------------------------------------------------------------------------

describe('双宿主地基（共享 record）', () => {
  it('两个 TemplateEditor 挂同一模板：一处提交，另一处实时反映', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]

    const targetA = document.createElement('div')
    const targetB = document.createElement('div')
    document.body.append(targetA, targetB)
    const a = mount(TemplateEditor, { target: targetA, props: { templateAssetId: id } })
    const b = mount(TemplateEditor, { target: targetB, props: { templateAssetId: id } })
    await tick()

    const inputA = targetA.querySelector('[data-testid="template-name-input"]') as HTMLInputElement
    const inputB = targetB.querySelector('[data-testid="template-name-input"]') as HTMLInputElement
    expect(inputA.value).toBe(inputB.value)

    inputA.value = '宿主 A 改的名'
    inputA.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(inputB.value).toBe('宿主 A 改的名') // 内存 record 实时互见（不等写盘）

    await whenTemplatesIdle()
    expect((await readTemplateFile(id)).name).toBe('宿主 A 改的名') // 换绑落盘

    unmount(a)
    unmount(b)
    targetA.remove()
    targetB.remove()
  })
})

// ---------------------------------------------------------------------------
// 迁移接线 e2e（design §9.3 时序：seed → 引擎 → store 刷新 → session 恢复）
// ---------------------------------------------------------------------------

describe('variants {v:2} 迁移接线（hydrate 内）', () => {
  const LEGACY_RAW = JSON.stringify({
    v: 2,
    items: [
      {
        id: 'tpl-wreath-border',
        name: '花环边框·我的改编',
        prompt: 'my edited prompt',
        candidates: 3,
        effectRef: { kind: 'preset', presetId: 'wreath-border' },
      },
      { id: 'own-1', name: '我的自建', prompt: 'own prompt', candidates: 1, enabled: false },
    ],
  })

  it('legacy（用户编辑 builtin + 自建）→ hydrate → 库模板 + session enabled + VARIANTS_KEY 删除', async () => {
    localStorage.setItem(VARIANTS_KEY, LEGACY_RAW)
    await hydrate()

    // [placeholders v2] seed 只出 v2 节点 → 引擎为 legacy 信封建 v1 形态节点（用户改编内容）
    // ——retire 判定「promptBody ≠ 原 preset」= 有编辑痕迹 → 保留（v2 换代零触碰用户改编）
    const builtin = await readTemplateFile('ast-tpl-wreath-border')
    expect(builtin.promptBody).toBe('my edited prompt')
    expect(builtin.name).toBe('花环边框·我的改编')
    // v2 官方内容照位（增量 seed）
    const v2 = await readTemplateFile('ast-tpl-wreath-border-v2')
    const preset = EFFECT_REF_PRESETS.find((p) => p.id === 'wreath-border')
    expect(v2.promptBody).toBe(`${preset?.prompt}\n【案例参照图提示词】`)

    // 自建：确定性 id ast-tpl-legacy-own-1，内容保真
    const own = await readTemplateFile('ast-tpl-legacy-own-1')
    expect(own.promptBody).toBe('own prompt')
    expect(own.name).toBe('我的自建')
    expect(own.candidates).toBe(1)
    expect(own.provenance.source).toBe('user-created')

    // 列表 + session enabled：builtin（enabled 缺省=启用）在；自建（enabled:false）不在
    expect(getTemplateAssetIds()).toContain('ast-tpl-legacy-own-1')
    expect(isEnabledTemplate('ast-tpl-wreath-border')).toBe(true)
    expect(isEnabledTemplate('ast-tpl-legacy-own-1')).toBe(false)
    const session = JSON.parse(localStorage.getItem(LAB_SESSION_KEY) ?? '{}') as {
      enabledTemplateAssetIds: string[]
    }
    expect(session.enabledTemplateAssetIds).toContain('ast-tpl-wreath-border')
    expect(session.enabledTemplateAssetIds).not.toContain('ast-tpl-legacy-own-1')

    // 旧信封退役：VARIANTS_KEY 删除 + journal done + 备份原文在
    expect(localStorage.getItem(VARIANTS_KEY)).toBeNull()
    const journal = JSON.parse(localStorage.getItem(TEMPLATE_MIGRATION_JOURNAL_KEY) ?? '{}') as { state?: string }
    expect(journal.state).toBe('done')
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).toBe(LEGACY_RAW)
  })

  it('主指标：迁移收口后再造 {v:2} 信封（旧「版本门 bump 重置」路径）→ 库模板零变化', async () => {
    localStorage.setItem(VARIANTS_KEY, LEGACY_RAW)
    await hydrate()

    // 用户在库内继续编辑（换绑落盘）
    submitTemplateField('ast-tpl-wreath-border', { promptBody: '用户库内编辑后的正文' })
    await whenTemplatesIdle()
    const snapshot = await librarySnapshot()

    // 模拟旧世界「版本演进触发重置」的输入面：重新写入 {v:2} 信封 + 再次 hydrate
    localStorage.setItem(
      VARIANTS_KEY,
      JSON.stringify({ v: 2, items: [{ id: 'tpl-wreath-border', name: 'reset bait', prompt: 'reset', candidates: 9 }] }),
    )
    resetLabForTests()
    resetToastsForTests()
    await hydrate()

    // 库模板零变化（create-only + done 短路；用户编辑保真）
    const after = await librarySnapshot()
    expect([...after.keys()].sort()).toEqual([...snapshot.keys()].sort())
    for (const [id, file] of after) {
      const before = snapshot.get(id)
      expect(before, `快照缺 ${id}`).toBeDefined()
      expect(file.promptBody).toBe(before?.promptBody)
      expect(file.name).toBe(before?.name)
      expect(file.candidates).toBe(before?.candidates)
      expect(file.caseBinding).toEqual(before?.caseBinding ?? null)
    }
    // 引擎为一次性迁移（journal done 短路）：done 后再造的信封不被收走（旧写入面已退役，
    // 该形态在生产不可达）——主指标是「库模板零变化」，上面已断言。
  })

  it('非 {v:2} 信封（版本门不符形态）→ not-needed：不建 journal、不动库、旧 key 原样保留', async () => {
    const stale = JSON.stringify({ v: 99, items: [{ id: 'tpl-any', name: 'x', prompt: 'y', candidates: 1 }] })
    localStorage.setItem(VARIANTS_KEY, stale)
    await hydrate()

    expect(await templateNodesUnderSys()).toHaveLength(EFFECT_REF_PRESETS.length) // 只剩 seed
    expect(localStorage.getItem(TEMPLATE_MIGRATION_JOURNAL_KEY)).toBeNull()
    expect(localStorage.getItem(VARIANTS_KEY)).toBe(stale)
  })
})

// ---------------------------------------------------------------------------
// startRun 消费库模板（B.1.4：快照 templateAssetId + promptBody + caseBinding）
// ---------------------------------------------------------------------------

describe('startRun 消费库模板', () => {
  it('任务快照携带 templateAssetId/名称/提示词体/caseBinding；空 promptBody 模板跳过', async () => {
    await hydrate()
    const ids = getTemplateAssetIds()
    const keep = ids[0]
    const empty = await createTemplate() // 空 promptBody 模板

    submitTemplateField(keep, { candidates: 2, promptBody: 'stable prompt' })
    await whenTemplatesIdle()
    for (const id of ids) {
      if (id !== keep && id !== empty) setEnabledTemplate(id, false)
    }

    const result = startRun()
    expect(result.ok).toBe(true)
    expect(result.enqueued).toBe(2) // 只有 keep ×2；空模板跳过（口径不变）
    const tasks = getTasks()
    expect(tasks).toHaveLength(2)
    for (const task of tasks) {
      expect(task.templateAssetId).toBe(keep)
      expect(task.variantId).toBe(keep)
      expect(task.variantName).toBe(getTemplateRecord(keep)?.name)
      expect(task.prompt).toBe('stable prompt')
      expect(task.effectRef?.kind).toBe('asset')
      if (task.effectRef?.kind === 'asset') {
        expect(task.effectRef.assetId).toBe(getTemplateRecord(keep)?.caseBinding?.assetId)
      }
    }
  })

  it('全部禁用 / 全部空提示词：拒绝并给出可行动错误（口径不变）', async () => {
    await hydrate()
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, false)
    const disabled = startRun()
    expect(disabled.ok).toBe(false)
    expect(disabled.error).toContain('没有启用的模板')

    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, true)
    for (const id of getTemplateAssetIds()) submitTemplateField(id, { promptBody: '' })
    await whenTemplatesIdle()
    const empty = startRun()
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('至少需要一个启用且填写了提示词的模板')
  })
})

// ---------------------------------------------------------------------------
// applyTaskParams 非破坏化 + copyTaskPrompt（B.1.4）
// ---------------------------------------------------------------------------

describe('applyTaskParams 非破坏化 + 复制提示词', () => {
  it('复用参数只回填表单层（model/size/advancedJson），模板内容零变化', async () => {
    await hydrate()
    const keep = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) {
      if (id !== keep) setEnabledTemplate(id, false)
    }
    submitTemplateField(keep, { candidates: 1, promptBody: 'template keeps its own prompt' })
    await whenTemplatesIdle()

    updateSettings({ model: 'gpt-image-2.5' })
    getForm().advancedJson = ''
    const result = startRun()
    expect(result.ok).toBe(true)
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    await whenTemplatesIdle()

    const before = await readTemplateFile(keep)
    getForm().advancedJson = '{"seed":7}'
    applyTaskParams(getTasks()[0].id)
    expect(getForm().advancedJson).toBe('') // 任务当时的 advanced 写回表单
    expect(getForm().size).toBe(getTasks()[0].size)
    // 模板零变化：文件与 record 都未被任务提示词覆写
    const after = await readTemplateFile(keep)
    expect(after.promptBody).toBe(before.promptBody)
    expect(getTemplateRecord(keep)?.promptBody).toBe('template keeps its own prompt')
  })

  it('复制提示词：任务快照进剪贴板 + toast；失败给中文提示', async () => {
    await hydrate()
    const keep = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) {
      if (id !== keep) setEnabledTemplate(id, false)
    }
    submitTemplateField(keep, { candidates: 1, promptBody: 'copy me' })
    await whenTemplatesIdle()
    expect(startRun().ok).toBe(true)
    await waitFor(() => getTasks().every((t) => t.status === 'success'))

    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    resetToastsForTests()
    expect(await copyTaskPrompt(getTasks()[0].id)).toBe(true)
    expect(writeText).toHaveBeenCalledWith('copy me')
    expect(getToasts().some((t) => t.message.includes('已复制'))).toBe(true)

    const fail = vi.fn(async () => {
      throw new Error('denied')
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: fail }, configurable: true })
    resetToastsForTests()
    expect(await copyTaskPrompt(getTasks()[0].id)).toBe(false)
    expect(getToasts().some((t) => t.message.includes('剪贴板不可用'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// lab-session（E8：损坏回默认；storage 事件非静默）
// ---------------------------------------------------------------------------

describe('lab-session 会话态', () => {
  it('启用集持久化往返：toggle 后落 lab-session，reset+refresh 恢复；选中态同理', async () => {
    await hydrate()
    const ids = getTemplateAssetIds()
    setEnabledTemplate(ids[2], false)
    selectTemplate(ids[3])

    const payload = JSON.parse(localStorage.getItem(LAB_SESSION_KEY) ?? '{}') as {
      enabledTemplateAssetIds: string[]
      selectedTemplateAssetId: string | null
    }
    expect(payload.enabledTemplateAssetIds).not.toContain(ids[2])
    expect(payload.selectedTemplateAssetId).toBe(ids[3])

    // 模拟刷新：store 复位 + 重新刷新（IDB/localStorage 存活）
    const { resetTemplatesForTests } = await import('$lib/stores/templates.svelte')
    resetTemplatesForTests()
    await refreshTemplates()
    expect(isEnabledTemplate(ids[2])).toBe(false)
    expect(isEnabledTemplate(ids[0])).toBe(true)
    expect(getSelectedTemplateAssetId()).toBe(ids[3])
  })

  it('损坏 session 回默认：全部启用 + 首项选中（E8）', async () => {
    await hydrate()
    const ids = getTemplateAssetIds()
    setEnabledTemplate(ids[1], false)
    localStorage.setItem(LAB_SESSION_KEY, '{not json')

    const { resetTemplatesForTests } = await import('$lib/stores/templates.svelte')
    resetTemplatesForTests()
    await refreshTemplates()
    expect(ids.every((id) => isEnabledTemplate(id))).toBe(true)
    expect(getSelectedTemplateAssetId()).toBe(ids[0])
  })

  it('跨 tab storage 事件：enabled 集同步 + 非静默提示', async () => {
    await hydrate()
    const ids = getTemplateAssetIds()
    setEnabledTemplate(ids[0], false)
    expect(isEnabledTemplate(ids[0])).toBe(false)

    resetToastsForTests()
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: LAB_SESSION_KEY,
        newValue: JSON.stringify({ enabledTemplateAssetIds: [...ids], selectedTemplateAssetId: null }),
      }),
    )
    await tick()
    expect(isEnabledTemplate(ids[0])).toBe(true) // 已同步
    expect(getToasts().some((t) => t.message.includes('其他窗口'))).toBe(true) // 非静默
  })
})
