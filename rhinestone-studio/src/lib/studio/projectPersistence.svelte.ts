/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-20 studio-layers 2.8] 项目生命周期（承接 add-project-files 2.1-2.5 移交，其 design §3
 *    UX 契约为移交输入）：saveGemproj v2（fold 终态 → serializeGemproj（首写即 v2——engineVersion 由
 *    序列化层固定写当前）→ 首次 ingestProjectAsset（sys-projects）/再次 updateProjectAsset CAS 换绑
 *    ——复用 add-project-files 1.2/1.3 写路径）+ 另存为 fork + 导出磁盘（asset 来源 embedded 烘焙；
 *    导出不清 dirty）+ isStudioDirty()（一切 StudioOp 置 dirty/undo 不清/保存清/导出不清——dirty 全集
 *    归 history 域，本模块只持项目身份态）。
 * 2. [打开链路] openStudioProject：节点校验 → parseGemproj（v1 经 projectFile 迁移入口）→ 来源双形态
 *    解析（asset 经 getHandoffImageBlob B2 单点；missing = typed source-missing）→ openProject lease +
 *    pin source/reference → 会话落位（k/seed 先行 → applyPainting 会话重置 → setParamState 层集装载 →
 *    resetStudioHistory 干净 base）→ 分块重放沉降（runSegment 同一计算内核 + 块落地 landBlocks 清点
 *    悬空覆写）→ 恢复默认观察态 + 全选 + 单次提示 + engineVersion 漂移位。重绑 = sourceOverride
 *    （来源缺失守卫卡的修复动作——参数完好，换源重放，成功即置 dirty）。
 * 3. [上下文条项目身份数据面] 项目名 + ●未保存 + 保存/另存为/导出项目文件/关闭（UI 在
 *    StudioContextBar；本模块持状态机与动作）。关闭释放 lease/pin；守卫三分法归 add-project-files
 *    2.6（其依赖读取器 = isStudioDirty()）。
 * 4. [空态最近] listRecentGemprojProjects（≤4，mtime 降序——studio 空态最近工程数据面）。
 */

import { APP_VERSION } from '$lib/appVersion'
import type { EngineImage } from '$lib/engine'
import { ENGINE_VERSION } from '$lib/engine/version'
import { blobToDataUrl, getImageBlob } from '$lib/persistence/imageStore'
import {
  PROJECT_MIME,
  ProjectConflictError,
  type AssetProject,
  type ProjectLease,
} from '$lib/persistence/projectTypes'
import {
  closeProject,
  getProject,
  ingestProjectAsset,
  listAllNodes,
  openProject,
  rebindProjectPins,
  updateProjectAsset,
} from '$lib/persistence/assetStore'
import { getHandoffImageBlob } from '$lib/persistence/handoffImage'
import {
  parseGemproj,
  serializeGemproj,
  type GemprojFile,
  type GemprojFileInput,
  type GemprojSource,
} from '$lib/persistence/projectFile'
import {
  fromLayerRecord,
  getLayers,
  getParamState,
  getPaletteState,
  getSegmentOpts,
  getStaleOverrideNotice,
  restoreDefaultObservationState,
  selectAllLayers,
  setBackgroundObservation,
  setParamState,
  toLayerRecord,
} from '$lib/studio/layers.svelte'
import {
  clearStudioHistoryDirty,
  isStudioHistoryDirty,
  markStudioHistoryDirty,
  resetStudioHistory,
} from '$lib/studio/history.svelte'
import { getLayerResult, refreshSignatureBaseline } from '$lib/studio/computeQueue.svelte'
import {
  MAX_IMAGE_DIM,
  applyPainting,
  getBlocks,
  getReferenceImage,
  getSourceImage,
  setSegK,
  setSegSeed,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { applyHandoffReference, clearReferenceImage } from '$lib/studio/imageSource.svelte'

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** 项目身份态（上下文条项目名/●未保存/漂移横幅/单次提示的数据面）。 */
export interface StudioProjectStatus {
  /** 素材库 AssetProject 节点 id（null = 未保存新项目）。 */
  projectId: string | null
  /** 项目名（保存节点名 = `${name}.gemproj`；首次保存弹命名可改，之后沿 saveGemprojAs）。 */
  name: string
  createdAt: number
  savedAt: number | null
  /** CAS 乐观锁（上次保存/打开时的 blobKey）。 */
  savedBlobKey: string | null
  /** engineVersion 漂移（打开文件 ≠ 当前引擎——横幅数据面；不阻断）。 */
  engineDrift: boolean
  /** 打开单次提示（「不恢复上次观察布局」——UI 消费 clearObservationNotice 清）。 */
  observationNotice: boolean
  /** 打开清点：悬空覆写键合计（分块重放沉降后由 landBlocks 计数回填）。 */
  droppedOverrides: number
}

let projectStatus = $state<StudioProjectStatus | null>(null)
let projectLease: ProjectLease | null = null
let opening = $state(false)

// ---------------------------------------------------------------------------
// 读取器
// ---------------------------------------------------------------------------

export function getStudioProject(): StudioProjectStatus | null {
  return projectStatus
}

export function isStudioOpening(): boolean {
  return opening
}

/**
 * dirty 全集读取器（add-project-files 2.6 守卫三分法的唯一依赖）：一切 StudioOp 置 dirty、
 * undo 不清、保存清、导出不清（沿 edit.svelte.ts:15 先例；真源 = history 域 dirty 位）。
 */
export function isStudioDirty(): boolean {
  return isStudioHistoryDirty()
}

// ---------------------------------------------------------------------------
// 序列化面（fold 终态 → GemprojFileInput；观察态永不入文件）
// ---------------------------------------------------------------------------

function mimeOfDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return match?.[1] ?? 'image/png'
}

type StudioSourceImage = NonNullable<ReturnType<typeof getSourceImage>>

/** 来源记录序列化形态（asset 优先；会话直灌路径 dataUrl 空且无 assetId = 不可序列化）。 */
function sourceRecordOf(source: StudioSourceImage): GemprojSource {
  if (source.assetId !== undefined) {
    return {
      kind: 'asset',
      assetId: source.assetId,
      name: source.name,
      width: source.width,
      height: source.height,
      downscale: source.downscale,
    }
  }
  if (source.dataUrl !== '') {
    return {
      kind: 'embedded',
      name: source.name,
      mime: mimeOfDataUrl(source.dataUrl),
      dataUrl: source.dataUrl,
      width: source.width,
      height: source.height,
      downscale: source.downscale,
    }
  }
  throw new Error('当前会话来源缺少可序列化引用（无 assetId 且无 dataUrl），无法保存。')
}

function requireSource(): StudioSourceImage {
  const source = getSourceImage()
  if (source === null) throw new Error('未载入数字油画，无法保存。')
  return source
}

function assembleInput(name: string, source: StudioSourceImage): GemprojFileInput {
  const reference = getReferenceImage()
  return {
    appVersion: APP_VERSION,
    createdAt: projectStatus?.createdAt ?? Date.now(),
    savedAt: Date.now(),
    name,
    source: sourceRecordOf(source),
    ...(reference?.assetId !== undefined
      ? { reference: { assetId: reference.assetId, name: reference.name } }
      : {}),
    segment: { ...getSegmentOpts() },
    // 序列化面投影：空显式层不入档（格式拒绝空数组——空层无成员/无覆写可保，域语义「配置在、
    // 块没了」仅限会话；重载后缺席）。兜底层恒在场。0 密度投影（improve 4.2）见 projectZeroDensity。
    layers: projectZeroDensity(
      getParamState()
        .layers.filter((l) => l.blockIds === 'rest' || l.blockIds.length > 0)
        .map(toLayerRecord),
    ),
    palette: getPaletteState().map((c) => ({ ...c })),
  }
}

/**
 * [improve 4.2] 密度 0 保存投影：engine/gemproj 值域 (0,1] 冻结——0 密度以「禁用标记」等价落档
 * （无钻意图精确往返，重开面板显「已禁用」；口径同禁用块）。层级 0：当前继承成员逐块投影为
 * disabled、physics.density 序列化 0.01（重分块后新块按 1% 继承 = 已知降级，v3 值域扩展登记）。
 */
function projectZeroDensity(records: ReturnType<typeof toLayerRecord>[]): ReturnType<typeof toLayerRecord>[] {
  const liveLayers = getLayers()
  const blocks = getBlocks()
  const blockById = new Map(blocks.map((b) => [b.id, b] as const))
  const explicitUnion = new Set<string>()
  for (const layer of liveLayers) {
    if (layer.blockIds !== 'rest') for (const id of layer.blockIds) explicitUnion.add(id)
  }
  for (const record of records) {
    // 块级覆写 0 → disabled 标记（密度键移除）
    for (const [id, value] of Object.entries(record.overrides.density)) {
      if (value === 0) {
        delete record.overrides.density[id]
        record.overrides.disabled[id] = true
      }
    }
    if (record.physics.density !== 0) continue
    // 层级 0 → 当前继承成员（无显式密度覆写且块在世）投影为 disabled；physics 落代表示值 0.01
    const memberIds =
      record.blockIds === 'rest'
        ? blocks.filter((b) => !explicitUnion.has(b.id)).map((b) => b.id)
        : record.blockIds
    for (const id of memberIds) {
      if (blockById.has(id) && record.overrides.density[id] === undefined) {
        record.overrides.disabled[id] = true
      }
    }
    record.physics.density = 0.01
  }
  return records
}

/** 首次保存默认名 = 来源图名去扩展名。 */
function defaultProjectName(): string {
  return (getSourceImage()?.name ?? '未命名排钻').replace(/\.[^.]+$/, '') || '未命名排钻'
}

export function defaultGemprojName(): string {
  return defaultProjectName()
}

function jointGemCount(): number {
  return getLayers().reduce((sum, layer) => sum + (getLayerResult(layer.id)?.gems.length ?? 0), 0)
}

// ---------------------------------------------------------------------------
// 保存 / 另存为 / 导出（导出不清 dirty）
// ---------------------------------------------------------------------------

export interface SaveGemprojResult {
  status: 'created' | 'updated'
  projectId: string
  name: string
}

/**
 * 保存：serializeGemproj → 首次 ingestProjectAsset（sys-projects）/再次 updateProjectAsset CAS
 * 换绑 → dirty 清。CAS 冲突（ProjectConflictError）原样上浮，dirty 保持。无来源图 = 显式错误。
 */
export async function saveGemproj(options: { name?: string } = {}): Promise<SaveGemprojResult> {
  const source = requireSource()
  const name = options.name?.trim() || projectStatus?.name || defaultProjectName()
  const input = assembleInput(name, source)
  const blob = new Blob([serializeGemproj(input)], { type: PROJECT_MIME.gemproj })
  const summary = { gemCount: jointGemCount(), sourceName: source.name }
  if (projectStatus === null || projectStatus.projectId === null || projectStatus.savedBlobKey === null) {
    const ingested = await ingestProjectAsset({ blob, name: `${name}.gemproj`, projectKind: 'gemproj', summary })
    projectStatus = {
      projectId: ingested.node.id,
      name,
      createdAt: input.createdAt,
      savedAt: Date.now(),
      savedBlobKey: ingested.node.blobKey,
      engineDrift: false,
      observationNotice: false,
      droppedOverrides: 0,
    }
    clearStudioHistoryDirty()
    return { status: 'created', projectId: ingested.node.id, name }
  }
  const updated: AssetProject = await updateProjectAsset(projectStatus.projectId, {
    expectedBlobKey: projectStatus.savedBlobKey,
    bytes: blob,
    summary,
  })
  projectStatus = {
    ...projectStatus,
    savedAt: Date.now(),
    savedBlobKey: updated.blobKey,
  }
  clearStudioHistoryDirty()
  return { status: 'updated', projectId: updated.id, name: projectStatus.name }
}

/** 另存为（fork）：恒 ingest 新节点并接管项目身份（旧节点不动——库内项目不做同内容去重）。 */
export async function saveGemprojAs(name: string): Promise<SaveGemprojResult> {
  const source = requireSource()
  const trimmed = name.trim() || defaultProjectName()
  const input = assembleInput(trimmed, source)
  const blob = new Blob([serializeGemproj(input)], { type: PROJECT_MIME.gemproj })
  const ingested = await ingestProjectAsset({
    blob,
    name: `${trimmed}.gemproj`,
    projectKind: 'gemproj',
    summary: { gemCount: jointGemCount(), sourceName: source.name },
  })
  projectStatus = {
    projectId: ingested.node.id,
    name: trimmed,
    createdAt: input.createdAt,
    savedAt: Date.now(),
    savedBlobKey: ingested.node.blobKey,
    engineDrift: false,
    observationNotice: false,
    droppedOverrides: 0,
  }
  clearStudioHistoryDirty()
  return { status: 'created', projectId: ingested.node.id, name: trimmed }
}

/**
 * 导出项目文件（磁盘）：asset 来源烘焙为 embedded（自包含；读取失败保留 asset 引用——
 * 文件仍可打开并走来源缺失守卫）。导出不清 dirty（与三格式导出同口径）。
 */
export async function buildGemprojExport(): Promise<{ blob: Blob; filename: string } | null> {
  const source = getSourceImage()
  if (source === null) return null
  const name = projectStatus?.name ?? defaultProjectName()
  const input = assembleInput(name, source)
  if (input.source.kind === 'asset') {
    const baked = await bakeSourceToDataUrl(input.source.assetId)
    if (baked !== null) {
      input.source = {
        kind: 'embedded',
        name: input.source.name,
        mime: mimeOfDataUrl(baked),
        dataUrl: baked,
        width: input.source.width,
        height: input.source.height,
        downscale: input.source.downscale,
      }
    }
  }
  return {
    blob: new Blob([serializeGemproj(input)], { type: PROJECT_MIME.gemproj }),
    filename: `${name}.gemproj`,
  }
}

async function bakeSourceToDataUrl(assetId: string): Promise<string | null> {
  try {
    return await blobToDataUrl(await getHandoffImageBlob(assetId))
  } catch {
    return null // 烘焙失败保留 asset 引用（打开侧走来源缺失守卫——诚实降级）
  }
}

// ---------------------------------------------------------------------------
// 打开链路
// ---------------------------------------------------------------------------

/** 打开失败形态（typed——来源缺失守卫卡/重绑的数据面）。 */
export type OpenGemprojFailure =
  | { kind: 'missing-node' }
  | { kind: 'wrong-kind'; projectKind: string }
  | { kind: 'trashed' }
  | { kind: 'blob-missing' }
  | { kind: 'parse'; message: string }
  | { kind: 'source-missing'; assetId: string }

export class OpenGemprojError extends Error {
  constructor(public readonly failure: OpenGemprojFailure) {
    super(
      failure.kind === 'missing-node'
        ? '排钻项目不存在（可能已被删除）。'
        : failure.kind === 'wrong-kind'
          ? `目标不是排钻项目（.gemproj），而是 ${failure.projectKind}。`
          : failure.kind === 'trashed'
            ? '排钻项目已在回收站，可还原后再打开。'
            : failure.kind === 'blob-missing'
              ? '排钻项目的文件内容已缺失（物理记录丢失）。'
              : failure.kind === 'source-missing'
                ? '来源图已缺失——参数完好，重新绑定来源图即可重放。'
                : `排钻项目解析失败：${failure.message}`,
    )
    this.name = 'OpenGemprojError'
  }
}

const STUDIO_PROJECT_OWNER_ID = 'studio-page'

/** 来源图解码器（默认浏览器路径；测试注入 jsdom 可用替代——gemprojReplay resolveCustom 同式先例）。 */
export type StudioPaintingDecoder = (dataUrl: string) => Promise<{ image: EngineImage; downscale: number }>

export interface OpenGemprojOptions {
  resolvePainting?: StudioPaintingDecoder
  /** 来源缺失重绑：跳过文件 source 解析直接用给定来源（成功后置 dirty——下次保存写入新 source）。 */
  sourceOverride?: { dataUrl: string; name: string; assetId?: string }
}

export interface OpenGemprojResult {
  name: string
  projectId: string
  /** 引擎身份漂移（打开文件 engineVersion ≠ 当前——横幅数据面，不阻断）。 */
  engineDrift: boolean
  /** 悬空覆写键合计（分块重放沉降后清点——landBlocks 计数）。 */
  droppedOverrides: number
  /** 观察态单次提示位（UI 消费 clearObservationNotice）。 */
  observationNotice: boolean
}

/** 浏览器解码（imageSource 域同构；jsdom 无 2D——测试经 resolvePainting 注入）。 */
async function decodeInBrowser(dataUrl: string): Promise<{ image: EngineImage; downscale: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('来源图解码失败（不支持的格式或损坏的文件）'))
    image.src = dataUrl
  })
  const downscale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * downscale))
  const h = Math.max(1, Math.round(img.naturalHeight * downscale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Canvas 2D 不可用，无法解码来源图')
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  return { image: { width: w, height: h, data: data.data }, downscale }
}

/** 来源双形态 → dataUrl 载荷（asset 经 getHandoffImageBlob 单点；missing = typed source-missing）。 */
async function resolveSourceContext(
  file: GemprojFile,
  options: OpenGemprojOptions,
): Promise<{ dataUrl: string; name: string; assetId?: string }> {
  if (options.sourceOverride !== undefined) return { ...options.sourceOverride }
  if (file.source.kind === 'embedded') return { dataUrl: file.source.dataUrl, name: file.source.name }
  try {
    return {
      dataUrl: await blobToDataUrl(await getHandoffImageBlob(file.source.assetId)),
      name: file.source.name,
      assetId: file.source.assetId,
    }
  } catch {
    throw new OpenGemprojError({ kind: 'source-missing', assetId: file.source.assetId })
  }
}

function pinsOf(file: GemprojFile): string[] {
  return [
    file.source.kind === 'asset' ? file.source.assetId : undefined,
    file.reference?.assetId,
  ].filter((id): id is string => id !== undefined)
}

/** 层序号复原（L# 数字序；非规范 id 回退层数）。 */
function layerSeqOf(file: GemprojFile): number {
  return file.layers.reduce((max, layer, index) => {
    const m = /^L(\d+)$/.exec(layer.id)
    return Math.max(max, m ? Number(m[1]) : 0, index + 1)
  }, 0)
}

/**
 * 打开排钻项目：节点校验 → parse → 来源解析（重绑口）→ lease（失败先于一切会话变更——旧会话保持）
 * → k/seed 先行 + applyPainting（会话重置）→ 层集装载（整体替换 + 干净历史 base + 签名基线重立）
 * → 默认观察态 + 全选 + 单次提示 → 参考原图恢复（旧参考清场；missing 容忍）→ 分块重放沉降
 * （runSegment + landBlocks 悬空清点——与 replay 六步链同一计算内核）。重绑成功置 dirty。
 */
export async function openStudioProject(assetId: string, options: OpenGemprojOptions = {}): Promise<OpenGemprojResult> {
  opening = true
  try {
    const node = await getProject(assetId)
    if (node === null || node.projectKind !== 'gemproj') {
      throw new OpenGemprojError(
        node === null ? { kind: 'missing-node' } : { kind: 'wrong-kind', projectKind: node.projectKind },
      )
    }
    if (node.trashedAt !== undefined) throw new OpenGemprojError({ kind: 'trashed' })
    const blob = await getImageBlob(node.blobKey).catch(() => null)
    if (blob === null) throw new OpenGemprojError({ kind: 'blob-missing' })
    let file: GemprojFile
    try {
      file = parseGemproj(new TextDecoder().decode(await blob.arrayBuffer()), { mime: node.mime })
    } catch (error) {
      throw new OpenGemprojError({ kind: 'parse', message: error instanceof Error ? error.message : String(error) })
    }
    const sourceCtx = await resolveSourceContext(file, options)
    let decoded: { image: EngineImage; downscale: number }
    try {
      decoded = await (options.resolvePainting ?? decodeInBrowser)(sourceCtx.dataUrl)
    } catch (error) {
      throw new OpenGemprojError({ kind: 'parse', message: error instanceof Error ? error.message : String(error) })
    }

    // 先开新租约再释放旧会话（失败路径旧会话完全保持）
    const lease = await openProject(assetId, 'gemproj', STUDIO_PROJECT_OWNER_ID, pinsOf(file))
    await releaseCurrentSession()
    projectLease = lease

    // 会话落位：k/seed 先行（applyPainting 保持分块参数现场）→ 换图重置 → 层集装载 + 干净 base
    setSegK(file.segment.k)
    setSegSeed(file.segment.seed)
    applyPainting(decoded.image, {
      dataUrl: sourceCtx.dataUrl,
      name: sourceCtx.name,
      origin: 'library',
      downscale: decoded.downscale,
      ...(sourceCtx.assetId !== undefined ? { assetId: sourceCtx.assetId } : {}),
    })
    setParamState({
      layers: file.layers.map(fromLayerRecord),
      layerSeq: layerSeqOf(file),
      palette: file.palette.map((c) => ({ ...c })),
      segment: { ...file.segment },
    })
    resetStudioHistory(getParamState())
    refreshSignatureBaseline()

    // 观察态恢复默认（工作默认一打开面：全层可见 + 背景默认源/50% + 全选）+ 单次提示
    setBackgroundObservation(restoreDefaultObservationState(getLayers()))
    selectAllLayers()

    // 参考原图：旧会话参考清场 → 文件引用恢复（missing 容忍——可选层静默跳过）
    if (file.reference !== undefined) await applyHandoffReference(file.reference.assetId)
    else clearReferenceImage()

    projectStatus = {
      projectId: assetId,
      name: node.name.replace(/\.gemproj$/, ''),
      createdAt: file.createdAt,
      savedAt: file.savedAt,
      savedBlobKey: node.blobKey,
      engineDrift: file.engineVersion !== ENGINE_VERSION,
      observationNotice: true,
      droppedOverrides: 0,
    }
    if (options.sourceOverride !== undefined) markStudioHistoryDirty() // 重绑换源：待保存入档

    // 分块重放沉降（块落地 → 全量标脏 → 逐层计算；landBlocks 清点悬空覆写）
    await waitForStudioIdle()
    const dropped = getStaleOverrideNotice() ?? 0
    projectStatus = { ...projectStatus, droppedOverrides: dropped }
    return {
      name: projectStatus.name,
      projectId: assetId,
      engineDrift: projectStatus.engineDrift,
      droppedOverrides: dropped,
      observationNotice: true,
    }
  } finally {
    opening = false
  }
}

/** 打开单次提示消费（「不恢复上次观察布局」——UI 消费后清）。 */
export function clearObservationNotice(): void {
  if (projectStatus !== null) projectStatus = { ...projectStatus, observationNotice: false }
}

// ---------------------------------------------------------------------------
// 关闭 / 换绑 pin / 最近项目
// ---------------------------------------------------------------------------

/** 关闭项目：释放 lease/pin + 项目身份清空（会话内容保持——守卫三分法归 add-project-files 2.6）。 */
export async function closeStudioProject(): Promise<void> {
  await releaseCurrentSession()
  projectStatus = null
}

async function releaseCurrentSession(): Promise<void> {
  if (projectLease !== null) {
    await closeProject(projectLease).catch(() => undefined)
    projectLease = null
  }
}

/** lease 换绑 pin 集（来源引用变化时——保存前/重绑后由编排调用）。 */
export function rebindSessionPins(nextPinnedAssetIds: readonly string[]): void {
  if (projectLease !== null) rebindProjectPins(projectLease, nextPinnedAssetIds)
}

/** 最近排钻工程（≤4，mtime 降序——空态最近数据面；软删排除）。 */
export async function listRecentGemprojProjects(
  limit = 4,
): Promise<Array<{ id: string; name: string; updatedAt: number }>> {
  const nodes = await listAllNodes()
  return nodes
    .filter((n) => n.type === 'project' && n.projectKind === 'gemproj' && n.trashedAt === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((n) => ({ id: n.id, name: n.name.replace(/\.gemproj$/, ''), updatedAt: n.updatedAt }))
}

// ---------------------------------------------------------------------------
// 复位（测试）
// ---------------------------------------------------------------------------

export async function resetProjectPersistenceForTests(): Promise<void> {
  await releaseCurrentSession()
  projectStatus = null
  opening = false
}

export { ProjectConflictError }
