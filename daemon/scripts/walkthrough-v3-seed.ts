/**
 * workbench-pro v3 走查种子（Owner 整改验收走查——独立实例/隔离 HOME，不污染 Owner 会话）：
 * 匿名用户 + 会话/任务（done 帧收口——「打开任务详情」入口）+ journey 产树
 * （persistTreeWithPreview+帧发布——segment-tool 同款写路径，**不入 tree_versions**：
 * 复现 Owner「历史事务不工作」根因面）+ 钻库存 12 款（task.detail.stoneCandidates 投影源）。
 * 运行：nub daemon/scripts/walkthrough-v3-seed.sh.ts（env 见脚本头）。
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
import { ObjectTreeSchema, SceneAnalysisSchema, encodeInlineMask, type ObjectTree, type SupplierSkuProfile } from '@handicraft/contracts'

const ROOT = process.env.WALKTHROUGH_ROOT ?? '/tmp/workbench-v3-walkthrough/app'
const config = loadConfig({ envFile: `${ROOT}/.env`, processEnv: { DATA_ROOT: `${ROOT}/data` } })
const db = openDatabase(config.dataRoot)
const user = ensureAnonymousUser(db)
const blobs = new BlobStore(config.dataRoot, db)
const jobs = new JobService({ config, db, blobs }, {})
const sessions = new SessionService({ config, db, blobs, jobs })

// ---- 钻库存（12 款多彩色板——stoneCandidates 投影源；国潮样卡 profile）
const stones = new StoneService({ db, blobs })
// 显式 SupplierSkuProfile 注解（不可 as const——readonly bands 不能赋给 createStone 要的可变数组）
const PROFILE: SupplierSkuProfile = {
  supplier: 'guochao',
  displayName: '国潮样卡（走查）',
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
let seeded = 0
for (const item of CATALOG) {
  const existing = db.prepare('SELECT resource_id FROM stone_index WHERE supplier=? AND sku=?').get('guochao', item.sku)
  if (existing !== undefined) {
    seeded += 1
    continue
  }
  stones.createStone({
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
  seeded += 1
}

// ---- 会话+任务（幂等：复用本走查会话）
let sessionId: string | undefined = (
  db.prepare("SELECT id FROM sessions WHERE title = ? AND status='active' LIMIT 1").get('小丑贴钻·v3 走查') as { id: string } | undefined
)?.id
if (sessionId === undefined) {
  sessionId = sessions.create(user, { title: '小丑贴钻·v3 走查' }).sessionId
}
const existingTask = db
  .prepare('SELECT id FROM tasks WHERE session_id = ? AND status = ? LIMIT 1')
  .get(sessionId, 'done') as { id: string } | undefined
const taskId = existingTask?.id ?? createAgentTask(db, { ownerId: user.id, sessionId, status: 'running' }).id

// ---- 底图（120×160 小丑剪影 PNG；底色深灰 #2a2e37——v4 修复轮 F7a：近白底色下
// 「隐藏背景仅见图层抠图」不可辨（抠图内容与浅底近乎同色），深底让抠图层轮廓
// 在走查截图中可辨）
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
// 底图入帧流（task.artifact 合法集=帧∪会话附件——原图 blob 需挂帧才能被附件通道读回）
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

// ---- done 帧收口（「打开任务详情」入口）+任务行置 done
if (existingTask === undefined) {
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
  jobs.emitFor(taskId, 'done', {})
  jobs.emitFor(taskId, 'transcript', { role: 'assistant', text: '识图与图层树已就绪（v3 走查种子）——在工作台继续贴钻策略。' })
}

console.log(JSON.stringify({ taskId, sessionId, imageBlobRef, treeBlobRef: bundle.treeBlobRef, stones: seeded }))
db.close()
