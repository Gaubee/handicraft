/**
 * variants {v:2} → 库模板迁移 journal 引擎测试（openspec add-project-files design §9.3 E3/B6，
 * 切片 0.8）：fake IDB + 真实 labFile/assetStore + 真实 localStorage（jsdom）。
 *
 * 覆盖（design §9.3 明细 + Codex 指定必测）：
 * - 全新迁移：混合变体集的目标 id / provenance / caseBinding / session / 删 key / journal done
 * - [Codex 必测] 自建 variant「ingest 成功 + 完成集写失败（注入 journal 写入抛错）+ 重启重试」
 *   → 最终仅一个 gemtpl 且内容不变（确定性 id 幂等实证）
 * - 中途失败矩阵：materializePreset 失败 / lab-session 写失败 / 删 VARIANTS_KEY 失败
 * - 二次执行幂等：done 后重跑零变化；软删目标节点后重跑不复活不重建
 * - 既有（含软删）目标节点：create-only 不覆盖内容
 * - 备份 TTL：30 天内不清 / 过期且 done 才清（>30d）/ pending 不清
 * - 版本门旁路：raw-v2 reader 读 {v:2} 原文；v:1 / 脏数据 / 旧数组载荷 → null 不抛
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupExpiredBackup,
  executeTemplateMigration,
  LAB_SESSION_KEY,
  TEMPLATE_MIGRATION_BACKUP_KEY,
  TEMPLATE_MIGRATION_BACKUP_TTL_MS,
  TEMPLATE_MIGRATION_JOURNAL_KEY,
  type LabSessionPayload,
  type MaterializedPresetCase,
  type MigrationNodeOutcome,
  type TemplateMigrationDeps,
  type TemplateMigrationJournal,
} from '$lib/lab/templateMigration'
import {
  getProject,
  ingestProjectAsset,
  listAllNodes,
  resetAssetStoreForTests,
  trashAsset,
} from '$lib/persistence/assetStore'
import { parseGemtpl, serializeGemtpl, type GemtplFile } from '$lib/persistence/labFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { getImageBlob } from '$lib/persistence/imageStore'
import { readRawVariantsV2, VARIANTS_KEY } from '$lib/persistence/taskStore'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

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

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

interface LegacyVariant {
  id: string
  name: string
  prompt: string
  candidates: number
  enabled?: boolean
  effectRef?: unknown
}

function writeVariants(items: unknown[], version = 2): string {
  const raw = JSON.stringify({ v: version, items })
  localStorage.setItem(VARIANTS_KEY, raw)
  return raw
}

function makeDeps(overrides: Partial<TemplateMigrationDeps> = {}): TemplateMigrationDeps {
  return {
    appVersion: overrides.appVersion ?? 'vitest-0.8',
    now: overrides.now ?? (() => T0),
    materializePreset:
      overrides.materializePreset ??
      (async (presetId: string): Promise<MaterializedPresetCase> => ({
        assetId: `ast-case-${presetId}`,
        caseLayout: 'horizontal',
      })),
    storage: overrides.storage,
    readRawVariants: overrides.readRawVariants,
    getProject: overrides.getProject,
    ingestProjectAsset: overrides.ingestProjectAsset,
  }
}

/** 注入式失败存储：谓词命中则抛错（模拟隐私模式/配额/journal 写入崩溃）。 */
function failingStorage(fail: (key: string, op: 'set' | 'remove', value: string | null) => boolean): Storage {
  const backing = localStorage
  return {
    get length() {
      return backing.length
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.getItem(key),
    key: (index: number) => backing.key(index),
    setItem: (key: string, value: string) => {
      if (fail(key, 'set', value)) throw new Error(`注入 setItem 失败：${key}`)
      backing.setItem(key, value)
    },
    removeItem: (key: string) => {
      if (fail(key, 'remove', null)) throw new Error(`注入 removeItem 失败：${key}`)
      backing.removeItem(key)
    },
  }
}

function readJournal(): TemplateMigrationJournal | null {
  const raw = localStorage.getItem(TEMPLATE_MIGRATION_JOURNAL_KEY)
  return raw === null ? null : (JSON.parse(raw) as TemplateMigrationJournal)
}

function readSession(): LabSessionPayload | null {
  const raw = localStorage.getItem(LAB_SESSION_KEY)
  return raw === null ? null : (JSON.parse(raw) as LabSessionPayload)
}

async function readGemtpl(id: string): Promise<GemtplFile | null> {
  const node = await getProject(id)
  if (!node) return null
  const blob = await getImageBlob(node.blobKey)
  if (!blob) return null
  return parseGemtpl(await blob.text())
}

async function gemtplNodes() {
  const all = await listAllNodes()
  return all.filter((n) => n.type === 'project' && n.projectKind === 'gemtpl')
}

function outcomeByLegacyId(outcomes: MigrationNodeOutcome[], legacyId: string): MigrationNodeOutcome {
  const found = outcomes.find((o) => o.legacyId === legacyId)
  if (!found) throw new Error(`未找到节点结果：${legacyId}`)
  return found
}

/** 混合变体集：2 个 tpl-preset id + 2 个自建 + 1 个 preset 过渡态 effectRef + 1 个空 prompt。 */
function mixedVariants(): LegacyVariant[] {
  return [
    // builtin + preset 过渡态（enabled）
    { id: 'tpl-wreath', name: '花环', prompt: 'a wreath', candidates: 2, effectRef: { kind: 'preset', presetId: 'wreath' } },
    // builtin + asset 绑定（disabled → 不进 enabled 集）
    {
      id: 'tpl-new-orleans',
      name: '新奥尔良',
      prompt: 'new orleans',
      candidates: 4,
      enabled: false,
      effectRef: { kind: 'asset', assetId: 'ast-case-1', caseLayout: 'vertical' },
    },
    // 自建（enabled，无 effectRef）
    { id: '3f1c-user-alpha', name: '自建 A', prompt: 'custom a', candidates: 3 },
    // 自建 + asset 绑定（enabled）
    {
      id: '3f1c-user-beta',
      name: '自建 B',
      prompt: 'custom b',
      candidates: 1,
      enabled: true,
      effectRef: { kind: 'asset', assetId: 'ast-case-9', caseLayout: 'single' },
    },
    // 自建 + 空 prompt（enabled）
    { id: '3f1c-user-gamma', name: '自建 C（空提示词）', prompt: '', candidates: 2 },
    // builtin + preset 过渡态（disabled）
    { id: 'tpl-bourbon', name: '波本', prompt: 'bourbon st', candidates: 2, enabled: false, effectRef: { kind: 'preset', presetId: 'bourbon' } },
  ]
}

// ---------------------------------------------------------------------------
// 全新迁移（混合变体集）
// ---------------------------------------------------------------------------

describe('executeTemplateMigration：全新迁移', () => {
  it('混合变体集 → 正确的目标 id / provenance / caseBinding / session / 删 key / journal done', async () => {
    const raw = writeVariants(mixedVariants())

    const result = await executeTemplateMigration(makeDeps())

    expect(result.state).toBe('done')
    expect(result.sessionWritten).toBe(true)
    expect(result.oldKeyDeleted).toBe(true)
    expect(result.backupKey).toBe(TEMPLATE_MIGRATION_BACKUP_KEY)

    // ① 备份 = 原文（逐字节）
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).toBe(raw)

    // ② 目标 id 与建/跳过状态（全部首轮新建）
    expect(result.nodes.map((o) => [o.legacyId, o.targetId, o.status])).toEqual([
      ['tpl-wreath', 'ast-tpl-wreath', 'created'],
      ['tpl-new-orleans', 'ast-tpl-new-orleans', 'created'],
      ['3f1c-user-alpha', 'ast-tpl-legacy-3f1c-user-alpha', 'created'],
      ['3f1c-user-beta', 'ast-tpl-legacy-3f1c-user-beta', 'created'],
      ['3f1c-user-gamma', 'ast-tpl-legacy-3f1c-user-gamma', 'created'],
      ['tpl-bourbon', 'ast-tpl-bourbon', 'created'],
    ])
    expect((await gemtplNodes()).map((n) => n.id).sort()).toEqual(
      [
        'ast-tpl-wreath',
        'ast-tpl-new-orleans',
        'ast-tpl-legacy-3f1c-user-alpha',
        'ast-tpl-legacy-3f1c-user-beta',
        'ast-tpl-legacy-3f1c-user-gamma',
        'ast-tpl-bourbon',
      ].sort(),
    )

    // 文件内容：prompt→promptBody / name / candidates clamp / caseBinding / provenance
    const wreath = await readGemtpl('ast-tpl-wreath')
    expect(wreath?.promptBody).toBe('a wreath')
    expect(wreath?.name).toBe('花环')
    expect(wreath?.candidates).toBe(2)
    expect(wreath?.caseBinding).toEqual({ assetId: 'ast-case-wreath', caseLayout: 'horizontal' })
    expect(wreath?.provenance).toEqual({ source: 'builtin-seed', presetId: 'wreath' })

    const orleans = await readGemtpl('ast-tpl-new-orleans')
    expect(orleans?.caseBinding).toEqual({ assetId: 'ast-case-1', caseLayout: 'vertical' })
    expect(orleans?.provenance).toEqual({ source: 'builtin-seed', presetId: 'new-orleans' })

    const alpha = await readGemtpl('ast-tpl-legacy-3f1c-user-alpha')
    expect(alpha?.caseBinding).toBeNull()
    expect(alpha?.provenance).toEqual({ source: 'user-created' })

    const beta = await readGemtpl('ast-tpl-legacy-3f1c-user-beta')
    expect(beta?.caseBinding).toEqual({ assetId: 'ast-case-9', caseLayout: 'single' })
    expect(beta?.provenance).toEqual({ source: 'user-created' })

    const gamma = await readGemtpl('ast-tpl-legacy-3f1c-user-gamma')
    expect(gamma?.promptBody).toBe('')

    const bourbon = await readGemtpl('ast-tpl-bourbon')
    expect(bourbon?.provenance).toEqual({ source: 'builtin-seed', presetId: 'bourbon' })

    // ④ session：enabled 集合 = legacy enabled 变体的目标节点 id（items 序）；无选中态伪造
    expect(readSession()).toEqual({
      enabledTemplateAssetIds: [
        'ast-tpl-wreath',
        'ast-tpl-legacy-3f1c-user-alpha',
        'ast-tpl-legacy-3f1c-user-beta',
        'ast-tpl-legacy-3f1c-user-gamma',
      ],
      selectedTemplateAssetId: null,
    })

    // ⑤ 旧 key 删除 + journal done
    expect(localStorage.getItem(VARIANTS_KEY)).toBeNull()
    const journal = readJournal()
    expect(journal).toMatchObject({
      version: 1,
      state: 'done',
      sessionWritten: true,
      oldKeyDeleted: true,
      backupKey: TEMPLATE_MIGRATION_BACKUP_KEY,
      startedAt: T0,
    })
    expect(journal?.completedNodeIds.sort()).toEqual(
      [
        'ast-tpl-wreath',
        'ast-tpl-new-orleans',
        'ast-tpl-legacy-3f1c-user-alpha',
        'ast-tpl-legacy-3f1c-user-beta',
        'ast-tpl-legacy-3f1c-user-gamma',
        'ast-tpl-bourbon',
      ].sort(),
    )
  })

  it('candidates 越界 clamp 到 1-8（serializeGemtpl 双侧防线）', async () => {
    writeVariants([{ id: 'u-1', name: 'n', prompt: 'p', candidates: 99 }])
    await executeTemplateMigration(makeDeps())
    expect((await readGemtpl('ast-tpl-legacy-u-1'))?.candidates).toBe(8)
  })

  it('无 {v:2} 原文（key 缺失）→ not-needed，零写入', async () => {
    const result = await executeTemplateMigration(makeDeps())
    expect(result.state).toBe('not-needed')
    expect(localStorage.getItem(TEMPLATE_MIGRATION_JOURNAL_KEY)).toBeNull()
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).toBeNull()
    expect(await gemtplNodes()).toEqual([])
  })

  it('v:1 载荷 → not-needed（版本门已 retire 的代数不迁移）', async () => {
    writeVariants([{ id: 'tpl-wreath', name: 'n', prompt: 'p', candidates: 2 }], 1)
    const result = await executeTemplateMigration(makeDeps())
    expect(result.state).toBe('not-needed')
    expect(await gemtplNodes()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// [Codex 指定必测] 确定性 id 幂等：ingest 成功 + 完成集写失败 + 重启重试
// ---------------------------------------------------------------------------

describe('executeTemplateMigration：确定性 id 幂等（Codex 必测）', () => {
  it('自建 variant「ingest 成功 + 完成集写失败 + 重启重试」→ 最终仅一个 gemtpl 且内容不变', async () => {
    writeVariants([{ id: '3f1c-self', name: '自建', prompt: 'keep me intact', candidates: 3 }])

    // 第一轮：journal 写入对含完成集的载荷抛错（ingest 已成功、记账落盘失败）
    const storage = failingStorage(
      (key, op, value) =>
        op === 'set' && key === TEMPLATE_MIGRATION_JOURNAL_KEY && value !== null && value.includes('ast-tpl-legacy-'),
    )
    const run1 = await executeTemplateMigration(makeDeps({ storage }))

    expect(run1.state).toBe('pending')
    expect(run1.nodes).toEqual([
      { legacyId: '3f1c-self', targetId: 'ast-tpl-legacy-3f1c-self', status: 'created' },
    ])
    // 节点已建（ingest 成功），但磁盘 journal 是首写（完成集为空）
    expect(readJournal()?.completedNodeIds).toEqual([])
    const nodesAfterRun1 = await gemtplNodes()
    expect(nodesAfterRun1.map((n) => n.id)).toEqual(['ast-tpl-legacy-3f1c-self'])
    const fileAfterRun1 = await readGemtpl('ast-tpl-legacy-3f1c-self')
    expect(fileAfterRun1?.promptBody).toBe('keep me intact')
    // 旧 key 未删（迁移未收口）
    expect(localStorage.getItem(VARIANTS_KEY)).not.toBeNull()

    // 重启重试（存储恢复；IDB 状态保留）
    const run2 = await executeTemplateMigration(makeDeps())

    expect(run2.state).toBe('done')
    expect(run2.nodes).toEqual([
      { legacyId: '3f1c-self', targetId: 'ast-tpl-legacy-3f1c-self', status: 'skipped-existing' },
    ])
    // 最终仅一个 gemtpl，且内容不变
    const nodesAfterRun2 = await gemtplNodes()
    expect(nodesAfterRun2.map((n) => n.id)).toEqual(['ast-tpl-legacy-3f1c-self'])
    const fileAfterRun2 = await readGemtpl('ast-tpl-legacy-3f1c-self')
    expect(fileAfterRun2).toEqual(fileAfterRun1)
    expect(localStorage.getItem(VARIANTS_KEY)).toBeNull()
    expect(readJournal()?.state).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// 中途失败矩阵
// ---------------------------------------------------------------------------

describe('executeTemplateMigration：中途失败矩阵', () => {
  it('materializePreset 失败：该节点本轮跳过下轮重试，其余照常', async () => {
    writeVariants([
      { id: 'u-plain', name: '自建', prompt: 'plain', candidates: 2 },
      { id: 'tpl-wreath', name: '花环', prompt: 'a wreath', candidates: 2, effectRef: { kind: 'preset', presetId: 'wreath' } },
    ])
    const materializePreset = vi.fn(async (): Promise<MaterializedPresetCase | null> => null)

    const run1 = await executeTemplateMigration(makeDeps({ materializePreset }))
    expect(run1.state).toBe('pending')
    expect(outcomeByLegacyId(run1.nodes, 'u-plain').status).toBe('created')
    expect(outcomeByLegacyId(run1.nodes, 'tpl-wreath')).toMatchObject({ status: 'pending-retry' })
    expect(materializePreset).toHaveBeenCalledWith('wreath')
    // 其余照常完成；旧 key 保留
    expect(readJournal()?.completedNodeIds).toEqual(['ast-tpl-legacy-u-plain'])
    expect(localStorage.getItem(VARIANTS_KEY)).not.toBeNull()
    expect(readSession()).toBeNull()

    // 下轮重试（materialize 恢复）：preset 节点建出 → done
    const run2 = await executeTemplateMigration(makeDeps())
    expect(run2.state).toBe('done')
    expect(outcomeByLegacyId(run2.nodes, 'u-plain').status).toBe('already-completed')
    expect(outcomeByLegacyId(run2.nodes, 'tpl-wreath').status).toBe('created')
    const wreath = await readGemtpl('ast-tpl-wreath')
    expect(wreath?.caseBinding).toEqual({ assetId: 'ast-case-wreath', caseLayout: 'horizontal' })
    expect(localStorage.getItem(VARIANTS_KEY)).toBeNull()
  })

  it('lab-session 写失败：state 停 pending，重跑续写', async () => {
    writeVariants([{ id: 'u-1', name: '自建', prompt: 'p', candidates: 2 }])
    const storage = failingStorage((key, op) => op === 'set' && key === LAB_SESSION_KEY)

    const run1 = await executeTemplateMigration(makeDeps({ storage }))
    expect(run1.state).toBe('pending')
    expect(run1.sessionWritten).toBe(false)
    // 节点已完成、done 未置、旧 key 保留
    expect(readJournal()).toMatchObject({ state: 'pending', sessionWritten: false, completedNodeIds: ['ast-tpl-legacy-u-1'] })
    expect(localStorage.getItem(VARIANTS_KEY)).not.toBeNull()

    const run2 = await executeTemplateMigration(makeDeps())
    expect(run2.state).toBe('done')
    expect(run2.sessionWritten).toBe(true)
    expect(readSession()).toEqual({
      enabledTemplateAssetIds: ['ast-tpl-legacy-u-1'],
      selectedTemplateAssetId: null,
    })
    expect(localStorage.getItem(VARIANTS_KEY)).toBeNull()
  })

  it('删 VARIANTS_KEY 失败：done 但 oldKeyDeleted=false，重入补删', async () => {
    writeVariants([{ id: 'u-1', name: '自建', prompt: 'p', candidates: 2 }])
    const storage = failingStorage((key, op) => op === 'remove' && key === VARIANTS_KEY)

    const run1 = await executeTemplateMigration(makeDeps({ storage }))
    expect(run1.state).toBe('done')
    expect(run1.oldKeyDeleted).toBe(false)
    expect(readJournal()).toMatchObject({ state: 'done', oldKeyDeleted: false })
    // key 未删成但保留（可重入补删），session/节点已就绪
    expect(localStorage.getItem(VARIANTS_KEY)).not.toBeNull()
    expect(readSession()).not.toBeNull()

    // 重入（存储恢复）：done 分支补删，其余零变化
    const nodesBefore = await gemtplNodes()
    const run2 = await executeTemplateMigration(makeDeps())
    expect(run2.state).toBe('done')
    expect(run2.oldKeyDeleted).toBe(true)
    expect(run2.nodes).toEqual([]) // 零节点动作
    expect(localStorage.getItem(VARIANTS_KEY)).toBeNull()
    expect(readJournal()?.oldKeyDeleted).toBe(true)
    expect(await gemtplNodes()).toEqual(nodesBefore)
  })
})

// ---------------------------------------------------------------------------
// 二次执行幂等 + 软删
// ---------------------------------------------------------------------------

describe('executeTemplateMigration：幂等与软删', () => {
  it('done 后重跑零变化（journal/session/IDB 全不变）', async () => {
    writeVariants(mixedVariants())
    await executeTemplateMigration(makeDeps())

    const journalBefore = localStorage.getItem(TEMPLATE_MIGRATION_JOURNAL_KEY)
    const sessionBefore = localStorage.getItem(LAB_SESSION_KEY)
    const backupBefore = localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)
    const nodesBefore = JSON.stringify(await listAllNodes())

    const again = await executeTemplateMigration(makeDeps())

    expect(again.state).toBe('done')
    expect(again.nodes).toEqual([])
    expect(localStorage.getItem(TEMPLATE_MIGRATION_JOURNAL_KEY)).toBe(journalBefore)
    expect(localStorage.getItem(LAB_SESSION_KEY)).toBe(sessionBefore)
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).toBe(backupBefore)
    expect(localStorage.getItem(VARIANTS_KEY)).toBeNull()
    expect(JSON.stringify(await listAllNodes())).toBe(nodesBefore)
  })

  it('软删目标节点后重跑：不复活不重建，节点仍带 trashedAt', async () => {
    writeVariants([{ id: 'u-1', name: '自建', prompt: 'p', candidates: 2 }])
    await executeTemplateMigration(makeDeps())
    await trashAsset('ast-tpl-legacy-u-1')
    const trashed = await getProject('ast-tpl-legacy-u-1')
    expect(trashed?.trashedAt).toBeDefined()

    const again = await executeTemplateMigration(makeDeps())
    expect(again.state).toBe('done')

    const after = await getProject('ast-tpl-legacy-u-1')
    expect(after?.trashedAt).toBe(trashed?.trashedAt) // 仍软删
    expect((await gemtplNodes()).length).toBe(1) // 不重建
  })

  it('迁移前已存在（含软删）的同 id 目标节点：跳过且不覆盖既有内容', async () => {
    // 预置一个不同内容的 gemtpl 节点占住确定性 id，再软删
    const preexisting = serializeGemtpl({
      appVersion: 'older-app',
      createdAt: 1,
      savedAt: 1,
      name: '用户已改名的模板',
      promptBody: 'user edited content',
      caseBinding: null,
      candidates: 5,
      provenance: { source: 'builtin-seed', presetId: 'wreath' },
    })
    await ingestProjectAsset({
      blob: new Blob([preexisting], { type: PROJECT_MIME.gemtpl }),
      name: '用户已改名的模板',
      projectKind: 'gemtpl',
      id: 'ast-tpl-wreath',
    })
    await trashAsset('ast-tpl-wreath')

    writeVariants([
      { id: 'tpl-wreath', name: '花环', prompt: 'a wreath', candidates: 2, effectRef: { kind: 'preset', presetId: 'wreath' } },
      { id: 'u-1', name: '自建', prompt: 'p', candidates: 2 },
    ])
    const result = await executeTemplateMigration(makeDeps())

    expect(result.state).toBe('done')
    expect(outcomeByLegacyId(result.nodes, 'tpl-wreath').status).toBe('skipped-existing')
    // create-only：内容仍是预置版本，trashedAt 保留（软删不复活）
    const node = await getProject('ast-tpl-wreath')
    expect(node?.trashedAt).toBeDefined()
    const file = await readGemtpl('ast-tpl-wreath')
    expect(file?.promptBody).toBe('user edited content')
    expect(file?.candidates).toBe(5)
    expect(file?.name).toBe('用户已改名的模板')
  })
})

// ---------------------------------------------------------------------------
// 备份 TTL
// ---------------------------------------------------------------------------

describe('cleanupExpiredBackup', () => {
  it('30 天内不清 / 过期且 done 才清（>30d）/ 重复调用幂等', async () => {
    writeVariants([{ id: 'u-1', name: '自建', prompt: 'p', candidates: 2 }])
    await executeTemplateMigration(makeDeps())

    expect(cleanupExpiredBackup(T0 + 29 * DAY)).toBe(false)
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).not.toBeNull()
    expect(cleanupExpiredBackup(T0 + TEMPLATE_MIGRATION_BACKUP_TTL_MS)).toBe(false) // 恰好 30 天不含
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).not.toBeNull()

    expect(cleanupExpiredBackup(T0 + 30 * DAY + 1)).toBe(true)
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).toBeNull()
    // 幂等：重复调用无额外效果（journal/session 均不受影响）
    expect(cleanupExpiredBackup(T0 + 40 * DAY)).toBe(true)
    expect(readJournal()?.state).toBe('done')
  })

  it('pending 不清（迁移未收口，备份是无损重试的真源）', async () => {
    writeVariants([
      { id: 'tpl-wreath', name: '花环', prompt: 'a wreath', candidates: 2, effectRef: { kind: 'preset', presetId: 'wreath' } },
    ])
    const materializePreset = async (): Promise<MaterializedPresetCase | null> => null
    await executeTemplateMigration(makeDeps({ materializePreset }))
    expect(readJournal()?.state).toBe('pending')

    expect(cleanupExpiredBackup(T0 + 60 * DAY)).toBe(false)
    expect(localStorage.getItem(TEMPLATE_MIGRATION_BACKUP_KEY)).not.toBeNull()
  })

  it('无 journal → no-op', () => {
    expect(cleanupExpiredBackup(T0 + 60 * DAY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 版本门旁路：raw-v2 reader
// ---------------------------------------------------------------------------

describe('readRawVariantsV2（版本门旁路）', () => {
  it('读 {v:2} 原文：raw 为逐字节原文、items 为原始数组（未 normalize）', () => {
    const items = [
      { id: 'u-1', name: 'n', prompt: 'p', candidates: 99, enabled: false, effectRef: { kind: 'url', resUrl: 'https://x/y.png' } },
    ]
    const raw = JSON.stringify({ v: 2, items })
    localStorage.setItem(VARIANTS_KEY, raw)

    const out = readRawVariantsV2()
    expect(out).not.toBeNull()
    expect(out?.raw).toBe(raw)
    expect(out?.items).toEqual(items)
  })

  it('v:1 / v:3 / 旧数组载荷 / 脏 JSON / key 缺失 → null 不抛', () => {
    expect(readRawVariantsV2()).toBeNull()

    localStorage.setItem(VARIANTS_KEY, JSON.stringify({ v: 1, items: [] }))
    expect(readRawVariantsV2()).toBeNull()

    localStorage.setItem(VARIANTS_KEY, JSON.stringify({ v: 3, items: [] }))
    expect(readRawVariantsV2()).toBeNull()

    localStorage.setItem(VARIANTS_KEY, JSON.stringify([{ id: 'a' }]))
    expect(readRawVariantsV2()).toBeNull()

    localStorage.setItem(VARIANTS_KEY, '{not json')
    expect(readRawVariantsV2()).toBeNull()

    localStorage.setItem(VARIANTS_KEY, JSON.stringify({ v: 2, items: 'nope' }))
    expect(readRawVariantsV2()).toBeNull()
  })
})
