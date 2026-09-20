/*
 * [2026-09-20 studio-layers 2.8] 项目生命周期 + dirty 全集（projectPersistence.svelte.ts）：
 * - save→load round-trip：层集/配置/色板/分块参数整态等价（canonical 序列化断言）+ 观察态缺席
 *   （文件无 visible/背景观察键 + physicalCanvas 缺席）+ 打开 = 干净历史 base + 逐层重放结果在场；
 * - dirty 全集：一切 StudioOp 置 dirty / undo 不清 / 保存清 / 导出不清（守卫三分法依赖读取器）；
 * - 写路径：首存 ingest（sys-projects）→ 再存 CAS 换绑（updateProjectAsset 路径）→ 另存为 fork +
 *   空态最近 ≤4（mtime 降序）；
 * - 打开失败形态（typed）：missing-node / parse / trashed / source-missing（失败先于一切会话变更——
 *   旧会话保持）+ 重绑 sourceOverride 换源重放（成功置 dirty）；
 * - engineVersion 漂移位（engineDrift 数据面）+ 悬空覆写清点（换图重放后 landBlocks 计数）。
 *
 * jsdom 无 2D 解码：open 链路经 resolvePainting 注入（gemprojReplay resolveCustom 同式先例）；
 * IDB 经 installFakeIndexedDB（宏任务泵 afterEach 排空——helpers 契约）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drainFakeIndexedDBChains, installFakeIndexedDB } from '../lab/helpers/fakeIndexedDB'
import { getProject, resetAssetStoreForTests, trashAsset } from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'
import { parseGemproj, serializeGemproj } from '$lib/persistence/projectFile'
import {
  addColor,
  applyPainting,
  dispatchLayerConfigOp,
  getBackgroundObservation,
  getBlocks,
  getLayerResult,
  getLayers,
  getPalette,
  getParamState,
  getSelectionOrder,
  getSourceImage,
  getUndoDepth,
  resetStudioForTests,
  setBlockDensity,
  setSegK,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { dispatchStudioOp, undoStudioOp } from '$lib/studio/history.svelte'
import { canonicalParamStateJson, getSegmentOpts } from '$lib/studio/layers.svelte'
import {
  buildGemprojExport,
  closeStudioProject,
  defaultGemprojName,
  getStudioProject,
  isStudioDirty,
  isStudioOpening,
  listRecentGemprojProjects,
  OpenGemprojError,
  openStudioProject,
  resetProjectPersistenceForTests,
  saveGemproj,
  saveGemprojAs,
  type StudioPaintingDecoder,
} from '$lib/studio/projectPersistence.svelte'
import { fixtureShapes, fixtureSolid } from '../engine/helpers'

// 真实定时器（分块防抖 300ms × 多轮沉降 + IDB 宏任务链）——单测超时上限放宽
vi.setConfig({ testTimeout: 20000 })

// PNG 魔数头样本（序列化面合法 dataUrl；解码经注入跳过——与 handoffImage.test 同源口径）
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]
const PNG_DATA_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`

/** 会话装载（jsdom 直灌像素 + 可序列化 dataUrl——save 路径的 embedded 来源）。 */
async function loadSession(name = '城市.png'): Promise<void> {
  applyPainting(fixtureShapes(), { dataUrl: PNG_DATA_URL, name, origin: 'upload', downscale: 1 })
  await waitForStudioIdle()
}

const decodeShapes: StudioPaintingDecoder = async () => ({ image: fixtureShapes(), downscale: 1 })
const decodeSolid: StudioPaintingDecoder = async () => ({ image: fixtureSolid(), downscale: 1 })

async function blobTextOf(assetId: string): Promise<string> {
  const node = await getProject(assetId)
  if (node === null || node.type !== 'project') throw new Error('节点不存在')
  const blob = await getImageBlob(node.blobKey)
  if (blob === null) throw new Error('blob 缺失')
  return new TextDecoder().decode(await blob.arrayBuffer())
}

/** 手工文件形态入库通道（drift/source-missing 用——补丁后重新 ingest 新节点）。 */
async function ingestPatched(baseText: string, patch: Record<string, unknown>, name: string): Promise<string> {
  const json = JSON.parse(baseText) as Record<string, unknown>
  const { ingestProjectAsset } = await import('$lib/persistence/assetStore')
  const node = await ingestProjectAsset({
    blob: new Blob([JSON.stringify({ ...json, ...patch })], { type: PROJECT_MIME.gemproj }),
    name,
    projectKind: 'gemproj',
  })
  return node.node.id
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  installFakeIndexedDB().reset() // 单例库清数据 + 断开模块连接缓存（helpers 契约）
  resetAssetStoreForTests()
  resetStudioForTests()
  await resetProjectPersistenceForTests()
})

afterEach(async () => {
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
})

describe('2.8 save→load round-trip（层/配置/色板/分块 + 观察态缺席 + 干净 base + 重放在场）', () => {
  it('保存→再存（CAS 路径）→打开：canonical 整态等价；观察态/physicalCanvas 不入档；打开后历史 0 深、逐层结果在场', async () => {
    await loadSession()
    setSegK(6) // 分块参数入档（重放同 k/seed）——先定块集再建层（层成员锚定当轮块 id）
    await waitForStudioIdle()
    const blockId = getBlocks()[0]!.id
    dispatchStudioOp({ t: 'layer.create', name: '前景', blockIds: [blockId] })
    dispatchLayerConfigOp(['L2'], { gapMm: 0.6, strategy: 'cvt' })
    addColor('夜蓝', '#102030')
    setBlockDensity(blockId, 0.5)
    await waitForStudioIdle()
    const canonicalBefore = canonicalParamStateJson(getParamState())
    expect(isStudioDirty()).toBe(true)

    // 首存：ingest（sys-projects）→ 项目身份在场 + dirty 清
    const created = await saveGemproj()
    expect(created.status).toBe('created')
    expect(created.name).toBe('城市') // 默认名 = 来源图名去扩展名
    expect(defaultGemprojName()).toBe('城市')
    const status = getStudioProject()
    expect(status?.projectId).toBe(created.projectId)
    expect(status?.savedBlobKey).toBeTruthy()
    expect(isStudioDirty()).toBe(false)
    const node = await getProject(created.projectId)
    expect(node?.type === 'project' && node.name).toBe('城市.gemproj')

    // 再存（无改动）：CAS 换绑路径（同哈希零写入不报冲突）
    const updated = await saveGemproj()
    expect(updated.status).toBe('updated')
    expect(updated.projectId).toBe(created.projectId)
    expect(isStudioDirty()).toBe(false)

    // 文件面：观察态/physicalCanvas 缺席（工作默认一——序列化字节不含会话观察布局）
    const text = await blobTextOf(created.projectId)
    expect(text).not.toContain('visible')
    const json = JSON.parse(text) as Record<string, unknown>
    expect('physicalCanvas' in json).toBe(false)
    expect(json.engineVersion).toBe(2)

    // 打开：整态等价 + 观察态默认 + 干净 base + 逐层重放
    const result = await openStudioProject(created.projectId, { resolvePainting: decodeShapes })
    expect(result.engineDrift).toBe(false)
    expect(result.observationNotice).toBe(true)
    expect(result.droppedOverrides).toBe(0)
    expect(canonicalParamStateJson(getParamState())).toBe(canonicalBefore)
    expect(getSegmentOpts()).toEqual({ k: 6, seed: 1 })
    expect(getUndoDepth()).toBe(0) // 打开 = 新 base（历史清空）
    expect(isStudioDirty()).toBe(false)
    expect(getSelectionOrder()).toEqual(getLayers().map((l) => l.id)) // 打开默认全选
    expect(getBackgroundObservation()).toEqual({ source: 'painting', opacity: 0.5, visible: true })
    for (const layer of getLayers()) {
      expect(getLayerResult(layer.id)?.gems.length ?? 0).toBeGreaterThan(0) // 六步链同源重放
    }
    expect(getSourceImage()?.name).toBe('城市.png')

    // 单次提示消费 + 关闭项目（身份清空，会话内容保持）
    const openedId = getStudioProject()?.projectId
    expect(openedId).toBe(created.projectId)
    await closeStudioProject()
    expect(getStudioProject()).toBeNull()
    expect(getLayers().length).toBe(2) // 会话内容保持（守卫三分法归 add-project-files 2.6）
  })
})

describe('2.8 dirty 全集（守卫三分法依赖读取器 isStudioDirty）', () => {
  it('一切 StudioOp 置 dirty / undo 不清 / 保存清 / 导出不清；未保存会话直接保存 = 显式错误', async () => {
    expect(isStudioDirty()).toBe(false)
    await expect(saveGemproj()).rejects.toThrow('未载入数字油画') // 空会话保存显式失败

    await loadSession()
    dispatchStudioOp({ t: 'layer.create', name: 'L2', blockIds: [] })
    expect(isStudioDirty()).toBe(true)
    undoStudioOp()
    expect(isStudioDirty()).toBe(true) // undo 不清（内容仍异于保存点——edit.svelte.ts:15 先例）
    const saved = await saveGemproj()
    expect(isStudioDirty()).toBe(false)

    dispatchLayerConfigOp(['L1'], { density: 0.8 })
    expect(isStudioDirty()).toBe(true)
    const exported = await buildGemprojExport() // 导出项目文件（磁盘）
    expect(exported).not.toBeNull()
    expect(exported!.filename).toBe('城市.gemproj')
    expect(isStudioDirty()).toBe(true) // 导出不清 dirty
    await saveGemproj()
    expect(isStudioDirty()).toBe(false)
    expect(saved.status).toBe('created')
  })
})

describe('2.8 另存为 fork + 空态最近 ≤4', () => {
  it('另存为恒 ingest 新节点接管身份；最近列表 mtime 降序 ≤4 且软删排除', async () => {
    await loadSession()
    const first = await saveGemproj({ name: '原稿' })
    dispatchStudioOp({ t: 'layer.create', name: 'L2', blockIds: [] })
    const fork = await saveGemprojAs('副本')
    expect(fork.status).toBe('created')
    expect(fork.projectId).not.toBe(first.projectId)
    expect(getStudioProject()?.projectId).toBe(fork.projectId)
    expect(isStudioDirty()).toBe(false)
    expect((await getProject(first.projectId))?.type).toBe('project') // 旧节点不动（fork 语义）

    await trashAsset(first.projectId)
    await drainFakeIndexedDBChains(2) // 软删事务提交的宏任务落地（fake IDB 可见性跳）
    const recents = await listRecentGemprojProjects()
    expect(recents.map((r) => r.id)).toEqual([fork.projectId]) // 软删排除 + 降序
    expect(recents[0]?.name).toBe('副本')
  })
})

describe('2.8 打开失败形态（typed）与旧会话保持', () => {
  it('missing-node / parse：typed failure 上浮，isStudioOpening 复位', async () => {
    await expect(openStudioProject('ast-none')).rejects.toMatchObject({
      name: 'OpenGemprojError',
      failure: { kind: 'missing-node' },
    })
    expect(isStudioOpening()).toBe(false)

    const { ingestProjectAsset } = await import('$lib/persistence/assetStore')
    const bad = await ingestProjectAsset({
      blob: new Blob(['not-json'], { type: PROJECT_MIME.gemproj }),
      name: '坏档.gemproj',
      projectKind: 'gemproj',
    })
    await expect(openStudioProject(bad.node.id, { resolvePainting: decodeShapes })).rejects.toMatchObject({
      failure: { kind: 'parse' },
    })
  })

  it('trashed：回收站节点拒绝打开', async () => {
    await loadSession()
    const saved = await saveGemproj()
    await trashAsset(saved.projectId)
    await expect(openStudioProject(saved.projectId, { resolvePainting: decodeShapes })).rejects.toMatchObject({
      failure: { kind: 'trashed' },
    })
  })

  it('source-missing：旧会话完全保持；重绑（sourceOverride）换源重放成功并置 dirty', async () => {
    await loadSession()
    const saved = await saveGemproj()
    const before = canonicalParamStateJson(getParamState())
    const layersBefore = getLayers().map((l) => l.name)

    // 手工缺源档：source 指向不存在资产
    const orphanId = await ingestPatched(
      await blobTextOf(saved.projectId),
      { source: { kind: 'asset', assetId: 'ast-missing-src', name: 'x.png', width: 64, height: 48, downscale: 1 } },
      '缺源.gemproj',
    )

    // 失败先于一切会话变更（来源解析先于 lease/落位）
    const failure = await openStudioProject(orphanId, { resolvePainting: decodeShapes }).catch((e) => e)
    expect(failure).toBeInstanceOf(OpenGemprojError)
    expect((failure as OpenGemprojError).failure).toMatchObject({
      kind: 'source-missing',
      assetId: 'ast-missing-src',
    })
    expect(canonicalParamStateJson(getParamState())).toBe(before)
    expect(getLayers().map((l) => l.name)).toEqual(layersBefore)
    expect(getStudioProject()?.projectId).toBe(saved.projectId)

    // 重绑：换源重放成功（缺源档的层集/参数照常装载）+ 置 dirty（下次保存写入新来源）
    const rebound = await openStudioProject(orphanId, {
      sourceOverride: { dataUrl: PNG_DATA_URL, name: '重绑.png' },
      resolvePainting: decodeShapes,
    })
    expect(rebound.name).toBe('缺源')
    expect(getSourceImage()?.name).toBe('重绑.png')
    expect(isStudioDirty()).toBe(true)
    const reboundText = await blobTextOf(orphanId)
    expect((JSON.parse(reboundText) as { source: { kind: string } }).source.kind).toBe('asset') // 落库档未变
  })
})

describe('2.8 engineVersion 漂移 + 悬空覆写清点', () => {
  it('engineVersion 不等 → engineDrift 位（不阻断打开）', async () => {
    await loadSession()
    const saved = await saveGemproj()
    const driftedId = await ingestPatched(await blobTextOf(saved.projectId), { engineVersion: 1 }, '旧引擎.gemproj')
    const result = await openStudioProject(driftedId, { resolvePainting: decodeShapes })
    expect(result.engineDrift).toBe(true)
    expect(getStudioProject()?.engineDrift).toBe(true)
  })

  it('换图重放致覆写悬空 → droppedOverrides 清点（landBlocks 计数 + 层列表提示同源）', async () => {
    await loadSession()
    // 中位块（≠ solid 单区域的 'b0-0'）——重放换图后该块 id 消失，覆写悬空
    const blocks = getBlocks()
    const blockId = blocks[Math.floor(blocks.length / 2)]!.id
    setBlockDensity(blockId, 0.5)
    await waitForStudioIdle()
    const saved = await saveGemproj()

    // 重放解码返回不同图 → 分块 id 换新 → 保存时的覆写键悬空
    const result = await openStudioProject(saved.projectId, { resolvePainting: decodeSolid })
    expect(result.droppedOverrides).toBeGreaterThan(0)
    expect(getStudioProject()?.droppedOverrides).toBeGreaterThan(0)
  })
})

describe('2.8 serializer 首写即 v2（双侧同口径）', () => {
  it('parse(serialize(x)) round-trip：kind/formatVersion=2/engineVersion=2 固定面', async () => {
    await loadSession()
    const text = await (async () => {
      const saved = await saveGemproj()
      return blobTextOf(saved.projectId)
    })()
    const file = parseGemproj(text)
    expect(file.kind).toBe('gemproj')
    expect(file.formatVersion).toBe(2)
    expect(file.engineVersion).toBe(2)
    expect(file.layers.length).toBeGreaterThanOrEqual(1)
    expect(file.layers.filter((l) => l.blockIds === 'rest')).toHaveLength(1)
    expect(serializeGemproj(file)).toBe(text) // 双侧同口径（字节等价）
    expect(getPalette().length).toBeGreaterThan(0)
  })
})
