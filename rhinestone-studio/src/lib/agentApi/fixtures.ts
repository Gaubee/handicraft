/*
 * Mock fixture 真源（design §3.5 开发序——W3 前端按固定 fixture 帧序列开发）。
 * 原始需求 2026-09-23（W3.1）：mock 完成不构成 MVP（验收=W4.4 接线联调）。
 * fixture 面向五类渲染器全覆盖：transcript / progress / approval-request（+
 * resolved）/ artifact / done——外加 error（拒绝路径）与结果 bundle。
 */

import type { Frame } from '@handicraft/contracts'
import { STRATEGY_FIXTURE_BLOB_REFS } from '$lib/strategyDesigner/fixtures'

/** 64 位伪 sha256（BlobRef 形态合法即可——mock 无字节面）。 */
const ref = (seed: string): string => {
  let out = ''
  let h = 0
  for (let i = 0; i < 64; i += 1) {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i * 7) % 0xffffffff
    out += ((h >>> (i % 4)) & 0xf).toString(16)
  }
  return out
}

export const FIXTURE_BLOB_REFS = {
  beforeSvg: ref('before-svg'),
  afterSvg: ref('after-svg'),
  artifactSvg: ref('artifact-layout-svg'),
  artifactBom: ref('artifact-bom'),
  artifactPng: ref('artifact-png'),
} as const

/** mock 结果 bundle 的可下载载荷（下载即时性——Agent 主面零服务器依赖）。 */
export const FIXTURE_BUNDLE_BYTES: Record<'svg' | 'bom' | 'png', { name: string; mime: string; content: string }> = {
  svg: { name: 'layout.svg', mime: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24" fill="#c8102e"/></svg>' },
  bom: { name: 'bom.csv', mime: 'text/csv', content: 'shape,color,size_mm,count\nround,红,3.0,142\nround,黑,2.0,86\n' },
  png: { name: 'render.png', mime: 'image/png', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
}

export interface FixtureSessionSeed {
  id: string
  title: string
  status: 'active' | 'clearing' | 'cleared'
  createdAt: string
  updatedAt: string
  /** 预置任务（含已完成结果——结果页/分享链接演示）。 */
  tasks: {
    id: string
    status: 'done' | 'running' | 'queued' | 'failed' | 'cancelled'
    frames: Frame[]
  }[]
  result?: { resultId: string; publicId: string; taskId: string }
}

const iso = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const transcript = (seq: number, ts: number, role: 'user' | 'assistant' | 'tool', text: string): Frame => ({
  seq,
  ts,
  kind: 'transcript',
  payload: { role, text },
})

/** 会话 1：已完成全旅程（审批→产物→结果+分享）。 */
export const FIXTURE_SESSIONS: FixtureSessionSeed[] = [
  {
    id: 'fixt-session-heart',
    title: '爱心图案贴钻',
    status: 'active',
    createdAt: iso(95),
    updatedAt: iso(12),
    tasks: [
      {
        id: 'fixt-task-heart-1',
        status: 'done',
        frames: [
          transcript(1, Date.parse(iso(90)), 'user', '帮我把这张爱心线稿排满红色圆钻，密度高一点'),
          transcript(2, Date.parse(iso(90)) + 900, 'assistant', '好的，我先分析图块结构：主体红色区域约 68%，背景留白。建议 hex-thin 策略、密度 0.9。'),
          { seq: 3, ts: Date.parse(iso(90)) + 1600, kind: 'progress', payload: { text: '排钻计算中', ratio: 0.4 } },
          { seq: 4, ts: Date.parse(iso(90)) + 2100, kind: 'progress', payload: { text: '排钻计算中', ratio: 0.85 } },
          { seq: 5, ts: Date.parse(iso(90)) + 2600, kind: 'artifact', payload: { blobRef: FIXTURE_BLOB_REFS.artifactSvg, name: 'layout.svg' } },
          { seq: 6, ts: Date.parse(iso(90)) + 2900, kind: 'done', payload: {} },
        ],
      },
    ],
    result: { resultId: 'fixt-result-heart', publicId: 'FixtHeart01', taskId: 'fixt-task-heart-1' },
  },
  {
    id: 'fixt-session-starry',
    title: '星夜毛衣排钻',
    status: 'active',
    createdAt: iso(600),
    updatedAt: iso(300),
    tasks: [],
  },
  /** 会话 3：策略设计全旅程（add-subject-sam-pipeline P3.2——识图→树→strategy.design
   * 指派表审批→执行三工件；策略设计器视图的帧流真源，工件内容=MockStrategyArtifacts）。 */
  {
    id: 'fixt-session-willow',
    title: '柳树装饰画·策略设计',
    status: 'active',
    // createdAt 置最旧（listSessions 按 createdAt 倒序——不夺 heart 的 sessions[0]
    // 位置：既有 mock 测试以 heart 为「最近会话」锚定）。
    createdAt: iso(1200),
    updatedAt: iso(10),
    tasks: [
      {
        id: 'fixt-task-willow-1',
        status: 'done',
        frames: [
          transcript(1, Date.parse(iso(70)), 'user', '这是 5×5cm 的柳树装饰画：柳树按枝条贴，花朵用星形排法，缎带走褶皱，路灯灯头不要贴'),
          transcript(2, Date.parse(iso(70)) + 800, 'assistant', '收到。我先做全图语义分析（scene.analyze），再迭代抠图建图层树，然后给每个图层设计贴钻策略。'),
          { seq: 3, ts: Date.parse(iso(70)) + 1500, kind: 'progress', payload: { text: '全图语义分析 scene.analyze', ratio: 0.2 } },
          { seq: 4, ts: Date.parse(iso(70)) + 2200, kind: 'progress', payload: { text: '迭代抠图 subject.segment（柳树→枝条/花朵/缎带/路灯）', ratio: 0.55 } },
          { seq: 5, ts: Date.parse(iso(70)) + 3000, kind: 'artifact', payload: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.treeJson, name: 'object-tree.json' } },
          { seq: 6, ts: Date.parse(iso(70)) + 3200, kind: 'artifact', payload: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.treePreview, name: 'object-tree-preview.png' } },
          transcript(7, Date.parse(iso(70)) + 3800, 'tool', 'studio.strategy.design：基于 object-tree 生成 4 节点策略指派（柳树·枝条=texture-fill(flow)、花朵=geometry(star)、缎带=free-code、路灯·灯头=exclusion）'),
          {
            seq: 8,
            ts: Date.parse(iso(70)) + 4200,
            kind: 'approval-request',
            payload: {
              requestId: 'fixt-request-willow',
              tool: 'studio.strategy.design',
              proposalId: 'fixt-proposal-willow',
              preview: { before: STRATEGY_FIXTURE_BLOB_REFS.proposalPreviewBefore, after: STRATEGY_FIXTURE_BLOB_REFS.proposalPreviewAfter },
              summary:
                '策略设计：4 节点指派（texture-fill×1、geometry×1、free-code×1、exclusion×1）·候选钻 3 款——指派表=批准即执行（逐节点 applyStrategy+引擎校验门）',
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            },
          },
          { seq: 9, ts: Date.parse(iso(70)) + 8000, kind: 'approval-resolved', payload: { requestId: 'fixt-request-willow', approved: true, resolvedAt: iso(20) } },
          { seq: 10, ts: Date.parse(iso(70)) + 8600, kind: 'artifact', payload: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.planJson, name: 'strategy-plan.json' } },
          { seq: 11, ts: Date.parse(iso(70)) + 9200, kind: 'artifact', payload: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsJson, name: 'strategy-gems.json' } },
          { seq: 12, ts: Date.parse(iso(70)) + 9400, kind: 'artifact', payload: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsPreview, name: 'strategy-gems-preview.png' } },
          transcript(13, Date.parse(iso(70)) + 9800, 'assistant', '策略已执行：19 颗钻（枝条流线 6 + 星形 8 + 缎带 5），路灯灯头留白入 BOM 注记。可在右侧画布逐层查看，左侧图层树可调图层级参数。'),
          { seq: 14, ts: Date.parse(iso(70)) + 10000, kind: 'done', payload: {} },
        ],
      },
    ],
  },
]

/** followup 脚本帧生成器：seq 从 1 起（task 域独立）。 */
export interface FixtureScriptFrame {
  kind: Frame['kind']
  payload: unknown
  /** 距上一帧的延迟（ms）。 */
  delayMs: number
  /** 审批门：该帧发出后脚本挂起，直到 answer()（approved 决定后续分支）。 */
  gate?: 'approval'
}

export const FIXTURE_FOLLOWUP_SCRIPT: FixtureScriptFrame[] = [
  { kind: 'transcript', payload: { role: 'user', text: '__USER_TEXT__' }, delayMs: 0 },
  { kind: 'transcript', payload: { role: 'assistant', text: '收到。我先读图分析图块，再给出排钻方案。' }, delayMs: 500 },
  { kind: 'progress', payload: { text: '图像分割与图块识别', ratio: 0.2 }, delayMs: 600 },
  { kind: 'progress', payload: { text: '结构化排布计算', ratio: 0.6 }, delayMs: 900 },
  {
    kind: 'approval-request',
    payload: {
      requestId: '__REQUEST_ID__',
      tool: 'studio.patch-apply',
      proposalId: 'fixt-proposal-1',
      preview: { before: FIXTURE_BLOB_REFS.beforeSvg, after: FIXTURE_BLOB_REFS.afterSvg },
      summary: '把主体区域密度从 0.6 提升到 0.9（预计 +142 颗圆钻，间距不小于 0.8mm）。是否应用该修改？',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    delayMs: 700,
    gate: 'approval',
  },
]

/** 批准后续脚本（resolved(approved) → artifact → done）。 */
export const FIXTURE_APPROVED_TAIL: FixtureScriptFrame[] = [
  { kind: 'transcript', payload: { role: 'assistant', text: '已应用修改：主体区域密度 0.9，重新排布完成。' }, delayMs: 500 },
  { kind: 'artifact', payload: { blobRef: FIXTURE_BLOB_REFS.artifactSvg, name: 'layout.svg' }, delayMs: 800 },
  { kind: 'done', payload: {}, delayMs: 200 },
]

/** 拒绝后续脚本（resolved(rejected) → assistant 说明 → done，真值零变化）。 */
export const FIXTURE_REJECTED_TAIL: FixtureScriptFrame[] = [
  { kind: 'transcript', payload: { role: 'assistant', text: '已按你的选择放弃该修改，未动原稿。可以告诉我换个方向。' }, delayMs: 500 },
  { kind: 'done', payload: {}, delayMs: 200 },
]

/** followup 完成（done）后的结果视图（mock 固定 publicId）。 */
export function fixtureResultFor(sessionId: string, taskId: string): { resultId: string; publicId: string; taskId: string } {
  return { resultId: `fixt-result-${sessionId}`, publicId: 'FixtNew01', taskId }
}
