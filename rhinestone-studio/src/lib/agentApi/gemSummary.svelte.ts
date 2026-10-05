/*
 * 排钻结果摘要读面（product-polish-w1 T1/T2——N1 报价闭环：「总数一眼可见」）。
 *
 * 数据源（零新服务端面）：任务帧流的 task-layout.<imageId>.json artifact 帧
 * （策略执行同真值链产的渲染快照——与导出三件套/BOM **同一输入**，「实排」口径
 * 单源）→ tasks.artifact RPC（合法引用集=该任务 artifact 帧）字节读回 → 契约
 * TaskLayoutSchema 宽容解析 → 前端聚合：
 *   - 总颗数 N = layout.gems.length（实排颗数——隐藏层已在生成器侧投影，与
 *     task.detail gems.count / 导出 BOM 合计行同口径）；
 *   - 款数 M = 去重 stoneRef 数（用料款数）；
 *   - 逐款颗数 = 按 stoneRef 聚合（同款多规格合并计颗；逐规格行在 BOM 导出件）。
 *
 * 缓存：内容寻址（taskId::blobRef——blob 不可变，同 ref 永不重拉）；$state 驱动
 * 组件响应。缺席/损坏/拉取失败=null（组件隐藏数字或显「排钻中…」占位，不硬编）。
 *
 * 贴图缩略（T2 chips）：/api/stones/{stoneRef}/texture.png?token=（img 通道查询
 * 参数鉴权——与 stonesAdmin withAuthToken 同法；401 自愈复用 attachments 的
 * retryRawImageOnError：daemon 重启废 token 时换新 token 重试一次）。
 * [fixture 边界 2026-10-02] agentStoneTextureUrl：mock 模式一律 hex 色卡占位
 * dataUrl（虚拟 stoneRef 绝不拼 daemon URL——「stone 不存在」404 即越域打点）。
 */
import { TaskLayoutSchema, type Frame, type TaskLayout } from '@handicraft/contracts'
import { getAgentMode, getBoundAgentApi } from './store.svelte.js'
import { currentStoredToken } from '../daemonToken.js'
import { mockStoneSwatchUrl } from './assetBoundary.js'
import { retryRawImageOnError } from './attachments.js'

/** task-layout 工件帧名（contracts taskLayoutArtifactName 的前端镜像——帧名解析用）。 */
export const TASK_LAYOUT_ARTIFACT_PREFIX = 'task-layout.'
export const TASK_LAYOUT_ARTIFACT_SUFFIX = '.json'

/** 单款用量（chip 行——颗数按 stoneRef 跨规格合并）。 */
export interface GemStoneUsage {
  stoneRef: string
  sku: string
  supplier: string
  /** 色名（layout.palette 命中；缺席=supplier/sku 回退——daemon buildTaskBom 同式）。 */
  name: string
  hex: string
  count: number
  /** 首见规格 mm（title 注释用；逐规格明细在 BOM 导出件）。 */
  diameterMm: number
}

/** 单图摘要（一个 imageId 一条——多图任务逐图行）。 */
export interface TaskGemImageSummary {
  imageId: string
  /** 实排总颗数。 */
  totalGems: number
  /** 用料款数（去重 stoneRef）。 */
  stoneKindCount: number
  /** 逐款用量（颗数降序 → stoneRef 字典序 → 规格升序——daemon buildTaskBom 排序首键同式）。 */
  stones: GemStoneUsage[]
}

/** 帧流 → 每 imageId 最新 task-layout 引用（latest-by-name——顺序扫描后见覆盖）。 */
export function taskLayoutRefsOfFrames(frames: Frame[]): Array<{ imageId: string; blobRef: string }> {
  const byImage = collectLayoutRefs(frames)
  return [...byImage.entries()]
    .map(([imageId, ref]) => ({ imageId, blobRef: ref.blobRef }))
    .sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0))
}

/**
 * 会话域 task-layout 引用（w20 走查 major-2，2026-10-02）：按任务组序（时间正序）
 * 扫描整个会话，每 imageId 取最后所见（后任务覆盖前任务）；每引用携带
 * sourceTaskId（taskArtifact 合法引用集=来源任务帧流——跨任务读必须按来源归档）。
 * 语义：任务详情=会话投影——面板落在无 layout 帧的任务（导出任务/识图任务）时
 * 回退会话内最新排钻布局（导出任务导出的正是该布局）；识图会话全无 layout=空
 * （组件隐藏数字，空态不占位）。
 */
export function taskLayoutRefsOfTaskGroups(
  groups: Array<{ taskId: string; frames: Frame[] }>,
): Array<{ imageId: string; blobRef: string; sourceTaskId: string }> {
  const byImage = new Map<string, { blobRef: string; sourceTaskId: string }>()
  for (const group of groups) {
    for (const [imageId, ref] of collectLayoutRefs(group.frames)) {
      byImage.set(imageId, { blobRef: ref.blobRef, sourceTaskId: group.taskId })
    }
  }
  return [...byImage.entries()]
    .map(([imageId, ref]) => ({ imageId, blobRef: ref.blobRef, sourceTaskId: ref.sourceTaskId }))
    .sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0))
}

/** 帧流 → imageId → blobRef（latest-by-name 共用内芯——两收集器单源）。 */
function collectLayoutRefs(frames: Frame[]): Map<string, { blobRef: string }> {
  const byImage = new Map<string, { blobRef: string }>()
  for (const frame of frames) {
    if (frame.kind !== 'artifact') continue
    const name = frame.payload.name
    if (typeof name !== 'string' || !name.startsWith(TASK_LAYOUT_ARTIFACT_PREFIX) || !name.endsWith(TASK_LAYOUT_ARTIFACT_SUFFIX)) {
      continue
    }
    const imageId = name.slice(TASK_LAYOUT_ARTIFACT_PREFIX.length, name.length - TASK_LAYOUT_ARTIFACT_SUFFIX.length)
    if (imageId === '') continue
    const blobRef = frame.payload.blobRef
    if (typeof blobRef !== 'string' || blobRef === '') continue
    byImage.set(imageId, { blobRef })
  }
  return byImage
}

/** layout → 报价摘要（纯函数——聚合/命名回退/排序全在本层，测试直打）。 */
export function summarizeTaskLayout(imageId: string, layout: TaskLayout): TaskGemImageSummary {
  const byRef = new Map<string, GemStoneUsage>()
  for (const gem of layout.gems) {
    const existing = byRef.get(gem.stoneRef)
    if (existing !== undefined) {
      existing.count += 1
      continue
    }
    const paletteEntry = layout.palette[gem.stoneRef]
    byRef.set(gem.stoneRef, {
      stoneRef: gem.stoneRef,
      sku: gem.sku,
      supplier: gem.supplier,
      name: paletteEntry?.name ?? `${gem.supplier}/${gem.sku}`,
      hex: gem.colorHex,
      count: 1,
      diameterMm: gem.diameterMm,
    })
  }
  const stones = [...byRef.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    if (a.stoneRef !== b.stoneRef) return a.stoneRef < b.stoneRef ? -1 : 1
    return a.diameterMm - b.diameterMm
  })
  return { imageId, totalGems: layout.gems.length, stoneKindCount: stones.length, stones }
}

// ---------------------------------------------------------------- 反应式缓存

/** key=taskId::blobRef（内容寻址——blob 不可变，落定永不再变）。null=缺席/失败。 */
const summaryCache = $state<Record<string, TaskGemImageSummary | null>>({})
/** 拉取单飞（同 key 并发只发一次）。 */
const inflight = new Map<string, Promise<void>>()

function cacheKey(taskId: string, blobRef: string): string {
  return `${taskId}::${blobRef}`
}

/** base64 → UTF-8 JSON（工作台 store decodeArtifactJson 同式——模块级解码器单例）。 */
const textDecoder = new TextDecoder()
function decodeArtifactJson(dataBase64: string): unknown {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return JSON.parse(textDecoder.decode(bytes))
}

/**
 * 读面主入口（组件 $derived 内调用——cache 为 $state，落定自动重渲）：
 * 入参=taskLayoutRefsOfFrames/taskLayoutRefsOfTaskGroups 的引用集；返回对齐数组
 * （null=该图摘要尚未就绪或不可得——无 layout 帧=空数组=组件隐藏数字）。缺失项
 * 异步补拉（单飞；失败落 null 不重试——内容寻址下重试同字节无意义）。
 * ref.sourceTaskId（w20 走查 major-2）：引用按来源任务归档读回（taskArtifact
 * 合法引用集=来源任务帧流——会话域回退时面板任务 ≠ layout 来源任务）；缺省=
 * 调用方 taskId（本任务帧内的引用，既有口径不变）。
 */
export function taskGemSummaries(
  taskId: string,
  refs: Array<{ imageId: string; blobRef: string; sourceTaskId?: string }>,
): Array<TaskGemImageSummary | null> {
  for (const ref of refs) {
    const refTaskId = ref.sourceTaskId ?? taskId
    const key = cacheKey(refTaskId, ref.blobRef)
    if (key in summaryCache) continue
    const api = getBoundAgentApi()
    if (api === null) continue // 未绑定（mock 演示外/测试桩未接）——保持缺席
    const fetch_ = inflight.get(key) ?? (async () => {
      try {
        const artifact = await api.taskArtifact({ taskId: refTaskId, blobRef: ref.blobRef })
        const parsed = TaskLayoutSchema.safeParse(decodeArtifactJson(artifact.dataBase64))
        summaryCache[key] = parsed.success ? summarizeTaskLayout(ref.imageId, parsed.data) : null
      } catch {
        summaryCache[key] = null // 拉取失败/字节缺席——隐藏数字（不占错误面）
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, fetch_)
    void fetch_
  }
  return refs.map((ref) => summaryCache[cacheKey(ref.sourceTaskId ?? taskId, ref.blobRef)] ?? null)
}

/** 测试复位（缓存/单飞全清——内容寻址键在跨测试 store 复位后作废）。 */
export function resetGemSummaryForTests(): void {
  for (const key of Object.keys(summaryCache)) delete summaryCache[key]
  inflight.clear()
}

// ---------------------------------------------------------------- 贴图缩略

/**
 * 钻贴图缩略 URL（/api/stones/{stoneRef}/texture.png——img src 不走 Authorization
 * 头，token 走查询参数；渲染时现读存储层——登录态代际跟随）。401 自愈由组件
 * onerror 挂 retryRawImageOnError（attachments 同款：重读新 token 换 src 重试一次）。
 */
export function stoneTextureUrl(stoneRef: string): string {
  const origin = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://127.0.0.1:8317'
  const token = currentStoredToken()
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${origin.replace(/\/$/, '')}/api/stones/${encodeURIComponent(stoneRef)}/texture.png${query}`
}

/**
 * agent 域贴图 URL 单源（fixture 边界 2026-10-02）：rpc=daemon texture 真字节；
 * mock=hex 色卡占位 dataUrl（零网络——虚拟 stoneRef 拼 daemon URL 必「stone
 * 不存在」404）。hex 优先取 layout palette/colorHex（GemStoneUsage.hex）。
 */
export function agentStoneTextureUrl(stoneRef: string, hex: string): string {
  if (getAgentMode() !== 'rpc') return mockStoneSwatchUrl(hex)
  return stoneTextureUrl(stoneRef)
}

/**
 * 贴图 chip 加载失败兜底（2026-10-05 Owner 实弹：pending 钻无贴图文件，texture.png
 * 404 → 裂图图标盖住 hex 色底）：先走 401 自愈（retryRawImageOnError 换新 token
 * 重试一次，src 带 __rt 标记）；无自愈空间/自愈后仍败=隐藏 img——chip 的 hex
 * 色底透出（色块兜底形态与 mock 占位一致）。
 */
export function chipTextureFallback(event: Event): void {
  retryRawImageOnError(event)
  const img = event.currentTarget
  if (img instanceof HTMLImageElement && !img.src.includes('__rt=')) img.style.display = 'none'
}

/** 口径注释（T3——徽标/摘要行/chips 的 title 单源）。 */
export const GEM_COUNT_CALIBER_TITLE =
  '颗数=排钻结果（实排），款数=用料款数——按当前布局统计，改动密度后更新（逐规格明细见导出 BOM）'
