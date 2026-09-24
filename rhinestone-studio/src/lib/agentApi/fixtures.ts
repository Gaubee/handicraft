/*
 * Mock fixture 真源（design §3.5 开发序——W3 前端按固定 fixture 帧序列开发）。
 * 原始需求 2026-09-23（W3.1）：mock 完成不构成 MVP（验收=W4.4 接线联调）。
 * fixture 面向五类渲染器全覆盖：transcript / progress / approval-request（+
 * resolved）/ artifact / done——外加 error（拒绝路径）与结果 bundle。
 */

import type { Frame } from '@handicraft/contracts'

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
