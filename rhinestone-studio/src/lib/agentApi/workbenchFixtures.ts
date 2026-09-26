/*
 * 任务详情·排钻工作台 mock fixture（add-task-detail-layer-workbench 2.6）。
 * 小丑场景（design 验证策略 E2E 同题材：「装载小丑任务详情→人类拆帽子→改策略」）：
 * 一棵 5 节点树（画布/小丑/帽子/脸蛋/蝴蝶结）+ 3 条指派 + 21 颗点阵。
 * 全部经 contracts schema parse 构造（runtime-safe——漂移在 fixture 层即拒），
 * 造数方式同 strategyDesigner/fixtures.ts（柳树先例）。画布 120×160px / 6×8cm
 * （ppm=2——derivePixelsPerMm 同源推导）；掩膜为程序生成的内联 mask。
 */

import {
  ObjectTreeSchema,
  StrategyPlanSchema,
  decodeInlineMask,
  encodeInlineMask,
  type InlineMask,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts'
import { StrategyGemsViewSchema, type StrategyGemsView } from '$lib/strategyDesigner/artifacts.js'

/** 64 位伪 sha256（agentApi fixtures.ts 同式——BlobRef 形态合法即可）。 */
export const workbenchRef = (seed: string): string => {
  let out = ''
  let h = 0
  for (let i = 0; i < 64; i += 1) {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i * 7) % 0xffffffff
    out += ((h >>> (i % 4)) & 0xf).toString(16)
  }
  return out
}

/** 小丑任务工件 blobRef 集（会话帧引用与 mock taskArtifact 映射同一批）。 */
export const WORKBENCH_FIXTURE_BLOB_REFS = {
  baseImage: workbenchRef('workbench-clown-base-image'),
  treeJson: workbenchRef('workbench-clown-tree-json'),
  treePreview: workbenchRef('workbench-clown-tree-preview'),
  planJson: workbenchRef('workbench-clown-plan-json'),
  gemsJson: workbenchRef('workbench-clown-gems-json'),
  gemsPreview: workbenchRef('workbench-clown-gems-preview'),
  /** 画布层 blob 态掩码（w*h=19200>4096 持久化阈值——blob mask 全链 fixture，2b）。 */
  canvasMaskBlob: workbenchRef('workbench-clown-canvas-mask-blob'),
} as const

export const WORKBENCH_FIXTURE_SESSION_ID = 'fixt-session-clown'
export const WORKBENCH_FIXTURE_TASK_ID = 'fixt-task-clown-1'

const CREATED_AT = '2026-09-25T08:00:00.000Z'

/** w×h 条纹 mask（fixture 体积最小化——渲染面消费 bbox，蒙版可视化消费 runs）。 */
export function stripesMaskOf(w: number, h: number): InlineMask {
  return stripesMask(w, h)
}

function stripesMask(w: number, h: number): InlineMask {
  const bits = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      bits[y * w + x] = (x + y) % 3 !== 0 ? 1 : 0
    }
  }
  return encodeInlineMask(w, h, bits)
}

/** 从既有 mask 位面纵向对半切开（mock 拆层的子层 mask 派生——bits 独立拷贝）。 */
export function splitInlineMaskHalves(mask: InlineMask): { left: InlineMask; right: InlineMask } {
  const bits = decodeInlineMask(mask).bits
  const wLeft = Math.floor(mask.w / 2)
  const wRight = mask.w - wLeft
  const left = new Uint8Array(wLeft * mask.h)
  const right = new Uint8Array(wRight * mask.h)
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const target = x < wLeft ? left : right
      const lx = x < wLeft ? x : x - wLeft
      target[y * (x < wLeft ? wLeft : wRight) + lx] = bits[y * mask.w + x]
    }
  }
  return {
    left: encodeInlineMask(wLeft, mask.h, left),
    right: encodeInlineMask(wRight, mask.h, right),
  }
}

/** 画布层掩码位面（blob 态字节源——120×160=19200 字节 0/1，taskArtifact 附件通道）。 */
export const WORKBENCH_FIXTURE_CANVAS_MASK_BITS: Uint8Array = decodeInlineMask(stripesMask(120, 160)).bits

export const WORKBENCH_FIXTURE_TREE: ObjectTree = ObjectTreeSchema.parse({
  kind: 'object-tree',
  formatVersion: 1,
  canvasCm: { w: 6, h: 8 },
  imagePx: { width: 120, height: 160 },
  nodes: [
    {
      id: 'n-canvas',
      objectName: '画布',
      category: 'canvas',
      // blob 态掩码（真桥持久化形态——w*h>4096 转 blob；blob mask 全链 fixture：
      // 前端 taskArtifact 拉取→LRU 缓存→渐进渲染，mock 桥走同一条链）
      mask: { kind: 'blob', w: 120, h: 160, blobRef: WORKBENCH_FIXTURE_BLOB_REFS.canvasMaskBlob },
      bbox: { x: 0, y: 0, w: 120, h: 160 },
      parent: null,
      children: ['n-clown'],
      effectiveMm: 77,
      labVariance: 40,
      drillWorthy: false,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-clown',
      objectName: '小丑',
      category: 'figure',
      mask: stripesMask(72, 104),
      bbox: { x: 24, y: 28, w: 72, h: 104 },
      parent: 'n-canvas',
      children: ['n-hat', 'n-face', 'n-bow'],
      effectiveMm: 60,
      labVariance: 26,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-hat',
      objectName: '帽子',
      category: 'clothing',
      mask: stripesMask(48, 30),
      bbox: { x: 36, y: 28, w: 48, h: 30 },
      parent: 'n-clown',
      children: [],
      effectiveMm: 26,
      labVariance: 12,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-face',
      objectName: '脸蛋',
      category: 'face',
      mask: stripesMask(44, 36),
      bbox: { x: 38, y: 64, w: 44, h: 36 },
      parent: 'n-clown',
      children: [],
      effectiveMm: 22,
      labVariance: 10,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-bow',
      objectName: '蝴蝶结',
      category: 'fabric',
      mask: stripesMask(20, 14),
      bbox: { x: 50, y: 106, w: 20, h: 14 },
      parent: 'n-clown',
      children: [],
      effectiveMm: 9,
      labVariance: 8,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
  ],
  createdAt: CREATED_AT,
})

const hatStone = { resourceId: 'stone-j201', sku: 'J-201 朱红', supplier: '国潮样卡', sizeMm: 3, colorHex: '#D63A2F' }
const faceStone = { resourceId: 'stone-j106', sku: 'J-106 桃粉', supplier: '国潮样卡', sizeMm: 2.5, colorHex: '#E16FA8' }
const bowStone = { resourceId: 'stone-j001', sku: 'J-001 银白', supplier: '国潮样卡', sizeMm: 2, colorHex: '#C9CED6' }

export const WORKBENCH_FIXTURE_PLAN: StrategyPlan = StrategyPlanSchema.parse({
  kind: 'strategy-plan',
  formatVersion: 1,
  objectTreeRef: WORKBENCH_FIXTURE_BLOB_REFS.treeJson,
  assignments: [
    {
      nodeId: 'n-hat',
      strategyKind: 'texture-fill',
      params: { mode: 'flow', polarity: 'dark-dense', fallbackEngineStrategy: 'hex-pitch' },
      stones: [hatStone],
      densityPerCm2: 2.3,
      rationale: '帽体面状渐变——flow 顺帽纹流线布钻',
    },
    {
      nodeId: 'n-face',
      strategyKind: 'geometry',
      params: { shape: 'circle', fallbackEngineStrategy: 'hex-pitch' },
      stones: [faceStone],
      densityPerCm2: 2.3,
      rationale: '脸蛋圆形区域——圆形参数化几何满铺',
    },
    {
      nodeId: 'n-bow',
      strategyKind: 'soft-curve',
      params: { minBranchLengthMm: 2, fallbackEngineStrategy: 'hex-pitch' },
      stones: [bowStone],
      densityPerCm2: 2.3,
      rationale: '蝴蝶结缎带骨架线——沿线布钻',
    },
  ],
  createdAt: CREATED_AT,
})

function gem(id: string, blockId: string, x: number, y: number, diameterMm: number): StrategyGemsView['gems'][number] {
  return { id, x, y, colorId: '', blockId, shapeId: 'round', diameterMm }
}

const hatGems = [
  [40, 54], [46, 50], [52, 47], [58, 46], [64, 47], [70, 50], [76, 54],
].map(([x, y], i) => gem(`n-hat#${String(i + 1).padStart(4, '0')}`, 'n-hat', x, y, 3))

const faceGems = Array.from({ length: 9 }, (_, i) => {
  const angle = (Math.PI / 4) * i
  const radius = i % 2 === 0 ? 14 : 6
  return gem(`n-face#${String(i + 1).padStart(4, '0')}`, 'n-face', 60 + radius * Math.cos(angle), 82 + radius * Math.sin(angle), 2.5)
})

const bowGems = [
  [53, 113], [57, 111], [61, 112], [65, 113],
].map(([x, y], i) => gem(`n-bow#${String(i + 1).padStart(4, '0')}`, 'n-bow', x, y, 2))

export const WORKBENCH_FIXTURE_GEMS: StrategyGemsView = StrategyGemsViewSchema.parse({
  kind: 'strategy-gems',
  formatVersion: 1,
  planRef: WORKBENCH_FIXTURE_BLOB_REFS.planJson,
  canvasCm: { w: 6, h: 8 },
  imagePx: { width: 120, height: 160 },
  gems: [...hatGems, ...faceGems, ...bowGems],
  excludedRegions: [],
  warnings: [],
  createdAt: CREATED_AT,
})

/**
 * 原图 mock 字节（SVG dataUrl——taskArtifact 附件通道形态；jsdom 不解码像素，
 * <image href> 直接可渲染）。6×8cm 画布底 + 小丑剪影三色分区。
 */
export const WORKBENCH_FIXTURE_BASE_IMAGE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160">',
  '<rect width="120" height="160" fill="#F5EFE6"/>',
  '<ellipse cx="60" cy="96" rx="34" ry="46" fill="#F2C9A0"/>',
  '<path d="M36 44 Q60 24 84 44 L78 62 L42 62 Z" fill="#D63A2F"/>',
  '<circle cx="60" cy="82" r="21" fill="#F6D9B8"/>',
  '<rect x="49" y="104" width="22" height="15" rx="4" fill="#C9CED6"/>',
  '</svg>',
].join('')
