/*
 * 策略设计器 mock 工件 fixture（add-subject-sam-pipeline P3.2）。
 * 形态对齐 P3.1 真实三工件（strategy-plan.json / strategy-gems.json / object-tree.json
 * + free-code 工件）——柳树场景（P3.3 验收旅程「把这棵柳树按枝条贴」同题材）。
 * 全部经 contracts schema parse 构造（runtime-safe——漂移在 fixture 层即拒）。
 * 画布 100×100px / 5×5cm（ppm=2——derivePixelsPerMm 同源推导），掩膜为程序生成的
 * 小尺寸内联 mask（真实感与测试体积的折中——渲染面只消费 bbox）。
 */

import {
  CodeStrategyArtifactSchema,
  ObjectTreeSchema,
  StrategyPlanSchema,
  encodeInlineMask,
  type CodeStrategyArtifact,
  type ObjectTree,
  type StrategyPlan,
} from '@handicraft/contracts'
import { StrategyGemsViewSchema, type StrategyArtifactsBundle, type StrategyArtifactsProvider, type StrategyArtifactRefs, type StrategyGemsView } from './artifacts.js'

/** 64 位伪 sha256（agentApi fixtures.ts 同式——BlobRef 形态合法即可）。 */
const ref = (seed: string): string => {
  let out = ''
  let h = 0
  for (let i = 0; i < 64; i += 1) {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i * 7) % 0xffffffff
    out += ((h >>> (i % 4)) & 0xf).toString(16)
  }
  return out
}

/** 策略会话工件 blobRef 集（agentApi fixtures 帧载荷引用同一批——mock provider 按此映射）。 */
export const STRATEGY_FIXTURE_BLOB_REFS = {
  treeJson: ref('strategy-tree-json'),
  treePreview: ref('strategy-tree-preview'),
  planJson: ref('strategy-plan-json'),
  gemsJson: ref('strategy-gems-json'),
  gemsPreview: ref('strategy-gems-preview'),
  codeArtifact: ref('strategy-free-code-artifact'),
  proposalPreviewBefore: ref('strategy-proposal-before'),
  proposalPreviewAfter: ref('strategy-proposal-after'),
} as const

const CREATED_AT = '2026-09-25T10:00:00.000Z'

/** w×h 全 1 或稀疏样式 mask（fixture 体积最小化——非全 1 即可）。 */
function fixtureMask(w: number, h: number, fill: 'full' | 'stripes'): ReturnType<typeof encodeInlineMask> {
  const bits = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      bits[y * w + x] = fill === 'full' || (x + y) % 3 !== 0 ? 1 : 0
    }
  }
  return encodeInlineMask(w, h, bits)
}

export const STRATEGY_FIXTURE_TREE: ObjectTree = ObjectTreeSchema.parse({
  kind: 'object-tree',
  formatVersion: 1,
  canvasCm: { w: 5, h: 5 },
  imagePx: { width: 100, height: 100 },
  nodes: [
    {
      id: 'n-canvas',
      objectName: '画布',
      category: 'canvas',
      mask: fixtureMask(100, 100, 'stripes'),
      bbox: { x: 0, y: 0, w: 100, h: 100 },
      parent: null,
      children: ['n-willow', 'n-flower', 'n-ribbon', 'n-lamp'],
      effectiveMm: 50,
      labVariance: 30,
      drillWorthy: false,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-willow',
      objectName: '柳树',
      category: 'foliage',
      mask: fixtureMask(44, 64, 'stripes'),
      bbox: { x: 8, y: 12, w: 44, h: 64 },
      parent: 'n-canvas',
      children: ['n-branch'],
      effectiveMm: 42,
      labVariance: 18,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-branch',
      objectName: '柳树·枝条',
      category: 'foliage',
      mask: fixtureMask(36, 32, 'stripes'),
      bbox: { x: 12, y: 40, w: 36, h: 32 },
      parent: 'n-willow',
      children: [],
      effectiveMm: 11,
      labVariance: 9,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-flower',
      objectName: '花朵',
      category: 'flower',
      mask: fixtureMask(22, 22, 'stripes'),
      bbox: { x: 64, y: 16, w: 22, h: 22 },
      parent: 'n-canvas',
      children: [],
      effectiveMm: 8,
      labVariance: 22,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-ribbon',
      objectName: '缎带',
      category: 'fabric',
      mask: fixtureMask(50, 14, 'stripes'),
      bbox: { x: 10, y: 78, w: 50, h: 14 },
      parent: 'n-canvas',
      children: [],
      effectiveMm: 12,
      labVariance: 12,
      drillWorthy: true,
      origin: 'vlm+sam3',
    },
    {
      id: 'n-lamp',
      objectName: '路灯·灯头',
      category: 'light',
      mask: fixtureMask(18, 18, 'stripes'),
      bbox: { x: 70, y: 58, w: 18, h: 18 },
      parent: 'n-canvas',
      children: [],
      effectiveMm: 9,
      labVariance: 6,
      drillWorthy: false,
      origin: 'vlm+sam3',
    },
  ],
  createdAt: CREATED_AT,
})

const willowStone = { resourceId: 'stone-j303', sku: 'J-303 深柳绿', supplier: '国潮样卡', sizeMm: 3, colorHex: '#3F7A3B' }
const flowerStone = { resourceId: 'stone-j106', sku: 'J-106 桃粉', supplier: '国潮样卡', sizeMm: 2.5, colorHex: '#E16FA8' }
const ribbonStone = { resourceId: 'stone-j001', sku: 'J-001 银白', supplier: '国潮样卡', sizeMm: 2, colorHex: '#C9CED6' }

export const STRATEGY_FIXTURE_PLAN: StrategyPlan = StrategyPlanSchema.parse({
  kind: 'strategy-plan',
  formatVersion: 1,
  objectTreeRef: STRATEGY_FIXTURE_BLOB_REFS.treeJson,
  assignments: [
    {
      nodeId: 'n-branch',
      strategyKind: 'texture-fill',
      params: { mode: 'flow', polarity: 'dark-dense', fallbackEngineStrategy: 'hex-pitch' },
      stones: [willowStone],
      densityPerCm2: 2.3,
      rationale: '柳枝为线主导节点——flow 模式顺枝条亮度梯度流线布钻（Owner：顺着枝条贴）',
    },
    {
      nodeId: 'n-flower',
      strategyKind: 'geometry',
      params: { shape: 'star', rays: 5, innerRadiusRatio: 0.4, rotationDeg: 270, fallbackEngineStrategy: 'hex-pitch' },
      stones: [flowerStone],
      densityPerCm2: 2.3,
      rationale: '花朵中心装饰星射线——五瓣呼应，初始角指上',
    },
    {
      nodeId: 'n-ribbon',
      strategyKind: 'free-code',
      params: { codeArtifactRef: STRATEGY_FIXTURE_BLOB_REFS.codeArtifact, entryPoint: 'layout', seed: 7 },
      stones: [ribbonStone],
      densityPerCm2: 2.3,
      codeArtifactRef: STRATEGY_FIXTURE_BLOB_REFS.codeArtifact,
      rationale: '缎带褶皱走向复杂——自由代码沿采样褶皱弧线排钻（同 seed 可回放）',
    },
    {
      nodeId: 'n-lamp',
      strategyKind: 'exclusion',
      params: { reason: '灯光不贴——破坏光源质感（显式指派）' },
      stones: [],
      densityPerCm2: 2.3,
      rationale: '灯头留白保光源质感；BOM 未贴区注记',
    },
  ],
  createdAt: CREATED_AT,
})

export const STRATEGY_FIXTURE_CODE_ARTIFACT: CodeStrategyArtifact = CodeStrategyArtifactSchema.parse({
  kind: 'free-code-artifact',
  formatVersion: 1,
  language: 'javascript',
  source: [
    'function layout(sandbox) {',
    '  // 缎带褶皱：沿中轴采样弧线，褶皱波峰加密',
    '  const axis = sandbox.geo.resampleOpen(sandbox.maskRidge(), sandbox.gem.diameterPx, 0);',
    '  return axis.map((p, i) => ({ x: p.x, y: p.y + Math.sin(i / 2) * 1.5 }));',
    '}',
  ].join('\n'),
  entryPoint: 'layout',
  seed: 7,
  declaredApiCalls: ['sandbox.geo.resampleOpen', 'sandbox.maskRidge'],
  description: '缎带褶皱弧线排布（沙箱注入面：mask/geo/rand）',
  createdAt: CREATED_AT,
})

function gem(id: string, blockId: string, x: number, y: number, diameterMm: number): StrategyGemsView['gems'][number] {
  return { id, x, y, colorId: '', blockId, shapeId: 'round', diameterMm }
}

const branchGems = [
  [16, 66], [21, 60], [26, 58], [31, 57], [36, 59], [41, 64],
].map(([x, y], i) => gem(`n-branch#${String(i + 1).padStart(4, '0')}`, 'n-branch', x, y, 3))

const flowerGems = Array.from({ length: 8 }, (_, i) => {
  const angle = (Math.PI / 4) * i
  const radius = i % 2 === 0 ? 8 : 3
  return gem(`n-flower#${String(i + 1).padStart(4, '0')}`, 'n-flower', 75 + radius * Math.cos(angle), 27 + radius * Math.sin(angle), 2.5)
})

const ribbonGems = [
  [12, 85], [22, 84], [32, 86], [42, 85], [52, 83],
].map(([x, y], i) => gem(`n-ribbon#${String(i + 1).padStart(4, '0')}`, 'n-ribbon', x, y, 2))

export const STRATEGY_FIXTURE_GEMS: StrategyGemsView = StrategyGemsViewSchema.parse({
  kind: 'strategy-gems',
  formatVersion: 1,
  planRef: STRATEGY_FIXTURE_BLOB_REFS.planJson,
  canvasCm: { w: 5, h: 5 },
  imagePx: { width: 100, height: 100 },
  gems: [...branchGems, ...flowerGems, ...ribbonGems],
  excludedRegions: [{ nodeId: 'n-lamp', label: '路灯·灯头', reason: '灯光不贴——破坏光源质感（显式指派）', areaCm2: 0.81 }],
  warnings: [],
  createdAt: CREATED_AT,
})

/**
 * Mock 工件 provider（测试替身——P3.2-channel 反转后非缺省）：帧流引用集命中
 * fixture 三件套 → bundle；否则 null（未知引用=该 provider 不持有——确定性降级）。
 * sourceImageUrl 可注入（原图两态测试）；缺省 null（真实通道的反例形态）。
 */
export class MockStrategyArtifacts implements StrategyArtifactsProvider {
  constructor(private readonly options: { sourceImageUrl?: string } = {}) {}

  async load(refs: StrategyArtifactRefs): Promise<StrategyArtifactsBundle | null> {
    if (refs.tree?.blobRef !== STRATEGY_FIXTURE_BLOB_REFS.treeJson) return null
    if (refs.plan?.blobRef !== STRATEGY_FIXTURE_BLOB_REFS.planJson) return null
    if (refs.gems?.blobRef !== STRATEGY_FIXTURE_BLOB_REFS.gemsJson) return null
    return {
      tree: STRATEGY_FIXTURE_TREE,
      plan: STRATEGY_FIXTURE_PLAN,
      gems: STRATEGY_FIXTURE_GEMS,
      codeArtifacts: { [STRATEGY_FIXTURE_BLOB_REFS.codeArtifact]: STRATEGY_FIXTURE_CODE_ARTIFACT },
      sourceImageUrl: this.options.sourceImageUrl ?? null,
      treePreviewUrl: null,
      gemsPreviewUrl: null,
    }
  }
}
