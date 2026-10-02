/**
 * [rework-layer-model v4 修复轮三 H1] 七族 UI 缺省参数 × daemon 族 schema 合法性
 * （Codex 三轮 P1-1「全族检查发现 free-code 被错误当作可空参数族」）：
 * UI 侧 strategyDefaultsOf（rhinestone-studio paramsSchema——纯 TS 零 Svelte 依赖，
 * 跨包相对导入不拖 daemon 重依赖）的输出逐族送 daemon STRATEGY_REGISTRY 族
 * paramsSchema（workbench.ts setNodeStrategy 同一校验真源）：
 *   - 可静态默认六族：判别联合族（texture-fill/geometry）补必需判别值、普通族空对象
 *     即过——逐族 parse 必须成功；
 *   - free-code（需载荷族）：strategyDefaultsOf 必须返回 requires-payload 标记；
 *     `{}` 必被 FreeCodeParamsSchema superRefine 拒（source XOR codeArtifactRef 二选一）
 *     ——UI 不得以空对象假装缺省成功；同族重应用形态（原指派载荷 source 保留）过 schema。
 * 关联：design.ts persistFreeCodeArtifact 对 params.source 的要求（持久化面——本测试
 * 校验 schema 层；工件化面由 strategy-design.test.ts 覆盖）。
 */
import { describe, expect, it } from 'vitest'
import { KernelStrategyKindSchema, type KernelStrategyKind } from '@handicraft/contracts'
import { STRATEGY_REGISTRY } from '../src/kernel/strategies/registry.js'
import {
  STRATEGY_FORM_SPECS,
  STRATEGY_KIND_ORDER,
  strategyDefaultsOf,
} from '../../rhinestone-studio/src/lib/strategyDesigner/paramsSchema'

const EIGHT_KINDS = KernelStrategyKindSchema.options as readonly KernelStrategyKind[]

describe('v4 修复轮三 H1：UI 缺省参数 × daemon 族 schema（八族逐族——close-paving-backlog T3 增 along-path）', () => {
  it('两序一致：STRATEGY_KIND_ORDER=八 kind 无重复；STRATEGY_FORM_SPECS 键集=八 kind', () => {
    expect(new Set(STRATEGY_KIND_ORDER)).toEqual(new Set(EIGHT_KINDS))
    expect(STRATEGY_KIND_ORDER.length).toBe(EIGHT_KINDS.length)
    expect(new Set(Object.keys(STRATEGY_FORM_SPECS))).toEqual(new Set(EIGHT_KINDS))
  })

  it('可静态默认六族：strategyDefaultsOf 产物逐族过 daemon 族 paramsSchema（setNodeStrategy 同一真源）', () => {
    for (const kind of EIGHT_KINDS) {
      if (kind === 'free-code') continue
      const defaults = strategyDefaultsOf(kind)
      expect(defaults.status).toBe('static')
      const schema = STRATEGY_REGISTRY.get(kind)?.paramsSchema
      if (schema === undefined) throw new Error(`策略 ${kind} 不在注册表`)
      const parsed = schema.safeParse((defaults as { params: Record<string, unknown> }).params)
      if (!parsed.success) {
        throw new Error(`${kind} 缺省 ${JSON.stringify((defaults as { params: Record<string, unknown> }).params)} 被族 schema 拒：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`)
      }
    }
  })

  it('free-code：strategyDefaultsOf=requires-payload（不可静态默认）；`{}` 必被族 schema 拒（XOR 二选一）', () => {
    const defaults = strategyDefaultsOf('free-code')
    expect(defaults.status).toBe('requires-payload')
    const schema = STRATEGY_REGISTRY.get('free-code')?.paramsSchema
    if (schema === undefined) throw new Error('free-code 不在注册表')
    // 空对象=source 与 codeArtifactRef 双缺——superRefine 拒（紧凑态/Inspector 无载荷
    // 直改在真 daemon 的必败形态；mock 不校验曾造成假绿）
    const empty = schema.safeParse({})
    expect(empty.success).toBe(false)
    // 同时携带 source+codeArtifactRef 同样被 XOR 拒（超界防御）
    const both = schema.safeParse({ source: 'function layout(){return []}', codeArtifactRef: 'a'.repeat(64) })
    expect(both.success).toBe(false)
  })

  it('free-code 同族重应用形态（原指派载荷 source 保留）过族 schema——UI 保留载荷的直改合法', () => {
    const schema = STRATEGY_REGISTRY.get('free-code')?.paramsSchema
    if (schema === undefined) throw new Error('free-code 不在注册表')
    const reapply = schema.safeParse({
      source: 'function layout(sandbox){ const out=[]; for (const b of sandbox.blocks) { out.push(...b.region); } return out; }',
      entryPoint: 'layout',
      seed: 7,
    })
    expect(reapply.success).toBe(true)
  })
})
