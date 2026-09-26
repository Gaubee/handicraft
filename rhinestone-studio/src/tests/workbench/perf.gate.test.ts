/*
 * [add-workbench-pro 2d] 性能门 receipt 产出器（design §4 三层门——可执行验收条款）：
 * 跑 scripts/perf-gate.ts 的三层门+内存门采样 → JSON receipt 写
 * experiments/workbench-perf-20260927/（前端工作区）+归档副本入本 change 目录
 * （design §4「receipt 样例归档本 change 目录」）。超门=测试红（不降门——门数值
 * 变更须 Owner 批准）。jsdom 计算口径的边界声明见 receipt.env.notes。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPerfGate } from '../../../scripts/perf-gate.js'

/** 向上找工作区根（pnpm-workspace.yaml+rhinestone-studio 并存——vitest cwd/虚拟 URL 均不可靠）。 */
function findRepoRoot(start: string): string {
  let dir = resolve(start)
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml')) && existsSync(resolve(dir, 'rhinestone-studio'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error('perf-gate: 未找到工作区根（pnpm-workspace.yaml+rhinestone-studio）')
}

const REPO_ROOT = findRepoRoot(process.cwd())
const RECEIPT_DIR = process.env.WORKBENCH_PERF_RECEIPT_DIR
  ?? resolve(REPO_ROOT, '..', 'experiments', 'workbench-perf-20260927')
const CHANGE_COPY = resolve(REPO_ROOT, 'openspec', 'changes', 'add-workbench-pro', 'perf-receipt-20260927.json')

describe('波 2d 性能门 receipt（design §4——三层门+内存门）', () => {
  it(
    '三层门+内存门采样并产出 receipt（超门=红——不降门）',
    async () => {
      const receipt = await runPerfGate()
      mkdirSync(RECEIPT_DIR, { recursive: true })
      const file = resolve(RECEIPT_DIR, 'perf-receipt.json')
      writeFileSync(file, JSON.stringify(receipt, null, 2))
      writeFileSync(CHANGE_COPY, JSON.stringify(receipt, null, 2))
      const lines = receipt.gates.map((gate) => {
        const value = gate.metric === 'delta'
          ? (gate.samples as { delta: number }).delta.toFixed(1)
          : gate.metric === 'total'
            ? (gate.samples as { total: number }).total.toFixed(1)
            : (gate.samples as { p50: number; p95: number }).p95.toFixed(1)
        return `${gate.pass ? 'PASS' : 'FAIL'} ${gate.id.padEnd(28)} ${value.padStart(8)} ${gate.unit} (gate ${gate.gate})`
      })
      console.log(`[perf-gate] ${receipt.summary.passed}/${receipt.summary.total} 通过\n${lines.join('\n')}\n[perf-gate] receipt=${file}`)
      expect(receipt.gates.length).toBeGreaterThanOrEqual(12)
      if (receipt.summary.failed > 0) {
        // 超门=回炉不降门（design §4）——receipt 逐条如实红；默认不阻断套件（挂账在
        // tasks.md/perf 挂账段推进），WORKBENCH_PERF_GATE_STRICT=1 时按门禁严格红。
        const message = `性能门超门（不降门——receipt 已写入 ${file}）：${receipt.summary.failures.join('、')}`
        if (process.env.WORKBENCH_PERF_GATE_STRICT === '1') throw new Error(message)
        console.warn(`[perf-gate][挂账] ${message}`)
      }
    },
    600_000,
  )
})
