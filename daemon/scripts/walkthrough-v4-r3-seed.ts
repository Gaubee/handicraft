/**
 * workbench v4 修复轮二 r3 走查种子（2026-09-28——独立实例/隔离 DATA_ROOT，不污染
 * Owner 的 8317 实例）：v3 走查种子（walkthrough-v3-seed.ts）基础上补 **策略真源工件**
 * ——strategy-plan（含 StonePick——layerStrategySet 无 stoneIdx 时的继承源）+
 * strategy-gems 文档与预览（task.detail.gems 读面）。目的：真浏览器窄容器（<32rem）
 * 经真实 daemon 完成「紧凑态策略直改」（G1/Codex 二轮 P1-1——mock 假绿闭合）。
 * 运行：nub daemon/scripts/walkthrough-v4-r3-seed.ts（env 见脚本内 ROOT）。
 */
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import { ensureAnonymousUser } from '../src/auth.js'
import { BlobStore } from '../src/db/blobs.js'
import { JobService } from '../src/jobs/service.js'
import { SessionService } from '../src/sessions/service.js'
import { createAgentTask } from '../src/db/jobs.js'
import { StoneService } from '../src/stones/service.js'
import { putTaskArtifact } from '../src/jobs/service.js'
import { encodePng } from '../src/png/codec.js'
import { SCENE_ANALYSIS_ARTIFACT_NAME } from '../src/kernel/vision/scene-analyze.js'
import { persistTreeWithPreview } from '../src/kernel/vision/tree-persist.js'
import { STRATEGY_GEMS_ARTIFACT_NAME, STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME, STRATEGY_PLAN_ARTIFACT_NAME } from '../src/kernel/strategies/design.js'
import {
  ObjectTreeSchema,
  SceneAnalysisSchema,
  StrategyPlanSchema,
  encodeInlineMask,
  type ObjectTree,
  type StrategyAssignment,
  type StrategyPlan,
  type SupplierSkuProfile,
} from '@handicraft/contracts'
import { StrategyGemsDocSchema } from '../src/kernel/strategies/design.js'

const ROOT = process.env.WALKTHROUGH_ROOT ?? '/tmp/workbench-v4-r3/app'
const config = loadConfig({ envFile: `${ROOT}/.env`, processEnv: { DATA_ROOT: `${ROOT}/data` } })
const db = openDatabase(config.dataRoot)
const user = ensureAnonymousUser(db)
const blobs = new BlobStore(config.dataRoot, db)
const jobs = new JobService({ config, db, blobs }, {})
const sessions = new SessionService({ config, db, blobs, jobs })

// ---- 钻库存（12 款多彩色板——stoneCandidates 投影源+plan StonePick 真源）
const stones = new StoneService({ db, blobs })
const PROFILE: SupplierSkuProfile = {
  supplier: 'guochao',
  displayName: '国潮样卡（r3 走查）',
  bands: [{ rows: [51, 78], sizeMmByPrefix: { J: 2, A: 3 } }],
  styleKey: 'row',
}
const CATALOG: Array<{ sku: string; sizeMm: number | null; rgb: [number, number, number]; family: string }> = [
  { sku: 'J-201 朱红', sizeMm: 3, rgb: [214, 58, 47], family: '红色系' },
  { sku: 'J-106 桃粉', sizeMm: 2.5, rgb: [225, 111, 168], family: '粉色系' },
  { sku: 'J-001 银白', sizeMm: 2, rgb: [201, 206, 214], family: '银白系' },
  { sku: 'A-801 鎏金', sizeMm: 3, rgb: [217, 164, 65], family: '金色系' },
  { sku: 'B-207 墨黑', sizeMm: 3, rgb: [38, 38, 43], family: '黑色系' },
  { sku: 'G-330 翡翠绿', sizeMm: 2.5, rgb: [46, 158, 107], family: '绿色系' },
  { sku: 'B-410 宝石蓝', sizeMm: 3, rgb: [44, 91, 216], family: '蓝色系' },
  { sku: 'P-520 葡萄紫', sizeMm: 2.5, rgb: [124, 77, 190], family: '紫色系' },
  { sku: 'O-615 暖橙', sizeMm: 2, rgb: [224, 123, 57], family: '橙色系' },
  { sku: 'T-724 湖青', sizeMm: 2, rgb: [58, 166, 160], family: '青色系' },
  { sku: 'Y-832 柠黄', sizeMm: 2, rgb: [232, 197, 71], family: '黄色系' },
  { sku: 'N-940 云灰', sizeMm: null, rgb: [154, 160, 166], family: '灰色系' },
]
const rgba = new Uint8Array(128 * 128 * 4).fill(255)
const texture = new Uint8Array(encodePng(128, 128, rgba))
const resourceIds = new Map<string, string>()
for (const item of CATALOG) {
  const existing = db.prepare('SELECT resource_id FROM stone_index WHERE supplier=? AND sku=?').get('guochao', item.sku) as { resource_id: string } | undefined
  if (existing !== undefined) {
    resourceIds.set(item.sku, existing.resource_id)
    continue
  }
  const created = stones.createStone({
    ownerId: user.id,
    supplierProfile: PROFILE,
    draft: {
      name: `${item.sku} 钻`,
      sku: item.sku,
      sizeMm: item.sizeMm,
      color: { name: item.family, rgb: item.rgb, family: item.family, finish: 'glossy' },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: texture,
  })
  resourceIds.set(item.sku, created.resourceId)
}

// ---- 会话+任务（幂等：复用本走查会话）
let sessionId: string | undefined = (
  db.prepare("SELECT id FROM sessions WHERE title = ? AND status='active' LIMIT 1").get('小丑贴钻·v4 修复轮二走查') as { id: string } | undefined
)?.id
if (sessionId === undefined) {
  sessionId = sessions.create(user, { title: '小丑贴钻·v4 修复轮二走查' }).sessionId
}
const existingTask = db
  .prepare('SELECT id FROM tasks WHERE session_id = ? AND status = ? LIMIT 1')
  .get(sessionId, 'done') as { id: string } | undefined
const taskId = existingTask?.id ?? createAgentTask(db, { ownerId: user.id, sessionId, status: 'running' }).id

// ---- 底图（120×160 小丑剪影 PNG——v3 走查同款几何/配色，F7a 深底）
const W = 120
const H = 160
const image = new Uint8Array(W * H * 4)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const p = (y * W + x) * 4
    let [r, g, b] = [42, 46, 55]
    const inHat = y >= 28 && y < 58 && x >= 36 && x < 84
    const inFace = y >= 64 && y < 100 && x >= 38 && x < 82
    const inBow = y >= 106 && y < 120 && x >= 50 && x < 70
    if (inHat) [r, g, b] = [214, 58, 47]
    else if (inFace) [r, g, b] = [246, 217, 184]
    else if (inBow) [r, g, b] = [201, 206, 214]
    image[p] = r
    image[p + 1] = g
    image[p + 2] = b
    image[p + 3] = 255
  }
}
const imageBlobRef = blobs.put(new Uint8Array(encodePng(W, H, image))).hash

// ---- scene-analysis 工件+帧
const analysis = SceneAnalysisSchema.parse({
  kind: 'scene-analysis',
  formatVersion: 1,
  imageBlobRef,
  canvasCm: { w: 6, h: 8 },
  imagePx: { width: W, height: H },
  elements: [
    { name: '小丑', category: 'figure', boxPx: { x: 24, y: 28, w: 72, h: 104 }, hint: 'clown', suggestDrillWorthy: true },
    { name: '帽子', category: 'clothing', boxPx: { x: 36, y: 28, w: 48, h: 30 }, hint: 'hat', suggestDrillWorthy: true },
    { name: '脸蛋', category: 'face', boxPx: { x: 38, y: 64, w: 44, h: 36 }, hint: 'face', suggestDrillWorthy: true },
    { name: '蝴蝶结', category: 'fabric', boxPx: { x: 50, y: 106, w: 20, h: 14 }, hint: 'bow', suggestDrillWorthy: true },
  ],
  createdAt: new Date().toISOString(),
})
jobs.emitFor(taskId, 'artifact', { blobRef: imageBlobRef, name: 'source-image.png' })
const analysisRef = putTaskArtifact({ db, blobs }, taskId, Buffer.from(JSON.stringify(analysis), 'utf8')).hash
jobs.emitFor(taskId, 'artifact', { blobRef: analysisRef, name: SCENE_ANALYSIS_ARTIFACT_NAME })

// ---- journey 产树（segment-tool 同款写路径：persist+帧——不入 tree_versions）
function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1))
}
const tree: ObjectTree = ObjectTreeSchema.parse({
  kind: 'object-tree',
  formatVersion: 1,
  canvasCm: { w: 6, h: 8 },
  imagePx: { width: W, height: H },
  nodes: [
    { id: 'n-canvas', objectName: '画布', category: 'canvas', mask: solidMask(W, H), bbox: { x: 0, y: 0, w: W, h: H }, parent: null, children: ['n-clown'], effectiveMm: 77, labVariance: 40, drillWorthy: false, origin: 'vlm+sam3' },
    { id: 'n-clown', objectName: '小丑', category: 'figure', mask: solidMask(72, 104), bbox: { x: 24, y: 28, w: 72, h: 104 }, parent: 'n-canvas', children: ['n-hat', 'n-face', 'n-bow'], effectiveMm: 60, labVariance: 26, drillWorthy: true, origin: 'vlm+sam3' },
    { id: 'n-hat', objectName: '帽子', category: 'clothing', mask: solidMask(48, 30), bbox: { x: 36, y: 28, w: 48, h: 30 }, parent: 'n-clown', children: [], effectiveMm: 26, labVariance: 12, drillWorthy: true, origin: 'vlm+sam3' },
    { id: 'n-face', objectName: '脸蛋', category: 'face', mask: solidMask(44, 36), bbox: { x: 38, y: 64, w: 44, h: 36 }, parent: 'n-clown', children: [], effectiveMm: 22, labVariance: 10, drillWorthy: true, origin: 'vlm+sam3' },
    { id: 'n-bow', objectName: '蝴蝶结', category: 'fabric', mask: solidMask(20, 14), bbox: { x: 50, y: 106, w: 20, h: 14 }, parent: 'n-clown', children: [], effectiveMm: 9, labVariance: 8, drillWorthy: true, origin: 'vlm+sam3' },
  ],
  createdAt: new Date().toISOString(),
})
const bundle = persistTreeWithPreview({ db, blobs }, taskId, imageBlobRef, tree)
jobs.emitFor(taskId, 'artifact', { blobRef: bundle.treeBlobRef, name: 'object-tree.json' })
jobs.emitFor(taskId, 'artifact', { blobRef: bundle.previewBlobRef, name: 'object-tree-preview.png' })

// ---- 策略真源工件（r3 增量）：plan（StonePick 继承源）+gems 文档+预览
function pickOf(sku: string) {
  const item = CATALOG.find((candidate) => candidate.sku === sku)!
  return {
    resourceId: resourceIds.get(sku)!,
    sku,
    supplier: 'guochao',
    sizeMm: item.sizeMm,
    colorHex: `#${item.rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`,
  }
}
function assignmentOf(nodeId: string, strategyKind: StrategyAssignment['strategyKind'], params: Record<string, unknown>, skus: string[], densityPerCm2: number): StrategyAssignment {
  return {
    nodeId,
    strategyKind,
    params,
    stones: skus.map(pickOf),
    densityPerCm2,
    rationale: `r3 走查种子指派（${strategyKind}）`,
  }
}
const plan: StrategyPlan = StrategyPlanSchema.parse({
  kind: 'strategy-plan',
  formatVersion: 1,
  objectTreeRef: bundle.treeBlobRef,
  // 密度全部 ≤2.3（引擎域：委派密度乘数=密度/2.3 必须 ≤1——design.ts prompt 指南）
  assignments: [
    assignmentOf('n-hat', 'texture-fill', { mode: 'scatter' }, ['J-201 朱红', 'J-001 银白'], 2.3),
    assignmentOf('n-face', 'geometry', { shape: 'circle' }, ['B-410 宝石蓝'], 2.0),
    assignmentOf('n-bow', 'soft-curve', {}, ['A-801 鎏金'], 1.8),
  ],
  createdAt: new Date().toISOString(),
})
const planRef = putTaskArtifact({ db, blobs }, taskId, Buffer.from(JSON.stringify(plan), 'utf8')).hash
jobs.emitFor(taskId, 'artifact', { blobRef: planRef, name: STRATEGY_PLAN_ARTIFACT_NAME })

// gems 文档（初始代——网格布点；planRef 溯源）
const seedGems: Array<{ id: string; x: number; y: number; colorId: string; blockId: string; shapeId: 'round'; diameterMm: number }> = []
let gemSeq = 0
for (const assignment of plan.assignments) {
  const node = tree.nodes.find((candidate) => candidate.id === assignment.nodeId)!
  const diameter = assignment.stones[0]?.sizeMm ?? 3
  for (let y = node.bbox.y + 4; y < node.bbox.y + node.bbox.h - 2; y += 6) {
    for (let x = node.bbox.x + 4; x < node.bbox.x + node.bbox.w - 2; x += 6) {
      gemSeq += 1
      seedGems.push({ id: `seed-${gemSeq}`, x, y, colorId: '', blockId: node.id, shapeId: 'round', diameterMm: diameter })
    }
  }
}
const gemsDoc = StrategyGemsDocSchema.parse({
  kind: 'strategy-gems',
  formatVersion: 1,
  planRef,
  canvasCm: { w: 6, h: 8 },
  imagePx: { width: W, height: H },
  gems: seedGems,
  excludedRegions: [],
  warnings: [],
  createdAt: new Date().toISOString(),
})
const gemsRef = putTaskArtifact({ db, blobs }, taskId, Buffer.from(JSON.stringify(gemsDoc), 'utf8')).hash
jobs.emitFor(taskId, 'artifact', { blobRef: gemsRef, name: STRATEGY_GEMS_ARTIFACT_NAME })
const previewPx = new Uint8Array(W * H * 4)
for (let i = 0; i < previewPx.length; i += 4) {
  previewPx[i] = 42
  previewPx[i + 1] = 46
  previewPx[i + 2] = 55
  previewPx[i + 3] = 255
}
for (const gem of seedGems) {
  const p = (Math.round(gem.y) * W + Math.round(gem.x)) * 4
  previewPx[p] = 240
  previewPx[p + 1] = 240
  previewPx[p + 2] = 245
}
const gemsPreviewRef = blobs.put(new Uint8Array(encodePng(W, H, previewPx))).hash
jobs.emitFor(taskId, 'artifact', { blobRef: gemsPreviewRef, name: STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME })

// ---- done 帧收口（「打开任务详情」入口）+任务行置 done
if (existingTask === undefined) {
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
  jobs.emitFor(taskId, 'done', {})
  jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '识图与图层树已就绪（r3 走查种子）——在工作台继续贴钻策略。' })
}

console.log(JSON.stringify({ taskId, sessionId, imageBlobRef, treeBlobRef: bundle.treeBlobRef, planRef, gemsRef, stones: CATALOG.length }))
db.close()
