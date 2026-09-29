/*
 * [rework-workbench-rail-drawers 1.1] railState 纯逻辑单测（design §2 冻结语义——
 * 断点输入=布尔 wide（jsdom 无布局，逻辑层以纯布尔输入可测））：
 * - auto 缺省两档（wide=true→图层/属性开、历史收起；wide=false→全收）
 * - 手动 toggle 进 manual 记忆（open↔closed）
 * - 跌破断点：全部强制收起+清记忆（回 auto）；升回：恢复缺省
 * - 右侧 inspector/history 互斥（同侧至多一开；图层开合不影响右缘）
 * - 同值 setWide 幂等（不误清 manual 记忆——ResizeObserver 高频回调安全）
 */

import { describe, expect, it } from 'vitest'
import { createRailState } from '$lib/components/studio/taskWorkbench/railState.svelte'

describe('railState 状态机（auto 缺省/手动记忆/断点强制/右侧互斥）', () => {
  it('初始（wide=false）：三面板全收起，mode 全 auto', () => {
    const rail = createRailState()
    expect(rail.isWide()).toBe(false)
    expect(rail.isOpen('layers')).toBe(false)
    expect(rail.isOpen('inspector')).toBe(false)
    expect(rail.isOpen('history')).toBe(false)
    expect(rail.mode('layers')).toBe('auto')
    expect(rail.mode('inspector')).toBe('auto')
    expect(rail.mode('history')).toBe('auto')
  })

  it('升回断点（wide=true）：双 Drawer 缺省展开（图层+属性），历史 auto 缺省收起', () => {
    const rail = createRailState()
    rail.setWide(true)
    expect(rail.isWide()).toBe(true)
    expect(rail.isOpen('layers')).toBe(true)
    expect(rail.isOpen('inspector')).toBe(true)
    // 右侧互斥——属性为右缘主面板，历史缺省收起（design §2「双 Drawer」+同侧至多一开）
    expect(rail.isOpen('history')).toBe(false)
  })

  it('手动 toggle 进 manual 记忆：关图层→再开→图层开', () => {
    const rail = createRailState()
    rail.setWide(true)
    rail.toggle('layers')
    expect(rail.isOpen('layers')).toBe(false)
    expect(rail.mode('layers')).toBe('closed')
    rail.toggle('layers')
    expect(rail.isOpen('layers')).toBe(true)
    expect(rail.mode('layers')).toBe('open')
  })

  it('跌破断点：全部强制收起+清记忆（manual→auto）；升回恢复缺省', () => {
    const rail = createRailState()
    rail.setWide(true)
    rail.toggle('layers') // 手动关（manual 记忆）
    rail.toggle('history') // 手动开历史（右侧互斥——属性被压收）
    expect(rail.isOpen('history')).toBe(true)

    rail.setWide(false) // 跌破：强制收起+清记忆
    expect(rail.isOpen('layers')).toBe(false)
    expect(rail.isOpen('inspector')).toBe(false)
    expect(rail.isOpen('history')).toBe(false)
    expect(rail.mode('layers')).toBe('auto')
    expect(rail.mode('inspector')).toBe('auto')
    expect(rail.mode('history')).toBe('auto')

    rail.setWide(true) // 升回：恢复缺省（双展开+历史收起）
    expect(rail.isOpen('layers')).toBe(true)
    expect(rail.isOpen('inspector')).toBe(true)
    expect(rail.isOpen('history')).toBe(false)
  })

  it('右侧互斥：开历史=属性收；再开属性=历史收（同侧至多一开）', () => {
    const rail = createRailState()
    rail.setWide(true)
    rail.toggle('history')
    expect(rail.isOpen('history')).toBe(true)
    expect(rail.isOpen('inspector')).toBe(false)
    // 互斥压收=显式 closed（不回 auto——auto 在 wide 档会解析回 open 造成双开）
    expect(rail.mode('inspector')).toBe('closed')

    rail.toggle('inspector')
    expect(rail.isOpen('inspector')).toBe(true)
    expect(rail.isOpen('history')).toBe(false)
    expect(rail.mode('history')).toBe('closed')
  })

  it('图层（左缘）开合不影响右缘面板——互斥仅在右侧组内', () => {
    const rail = createRailState()
    rail.setWide(true)
    rail.toggle('layers')
    expect(rail.isOpen('layers')).toBe(false)
    expect(rail.isOpen('inspector')).toBe(true) // 右缘不受左缘开合影响
    rail.toggle('layers')
    expect(rail.isOpen('layers')).toBe(true)
    expect(rail.isOpen('inspector')).toBe(true)
  })

  it('窄屏手动展开：wide=false 下 toggle 图层=开（用户可手动展开）', () => {
    const rail = createRailState()
    rail.toggle('layers')
    expect(rail.isOpen('layers')).toBe(true)
    expect(rail.mode('layers')).toBe('open')
    expect(rail.isWide()).toBe(false)
  })

  it('窄屏右侧互斥同样生效：开历史=属性保持收（两档一致语义）', () => {
    const rail = createRailState()
    rail.toggle('history')
    expect(rail.isOpen('history')).toBe(true)
    rail.toggle('inspector')
    expect(rail.isOpen('inspector')).toBe(true)
    expect(rail.isOpen('history')).toBe(false)
  })

  it('同值 setWide 幂等：不误清 manual 记忆（ResizeObserver 高频回调安全）', () => {
    const rail = createRailState()
    rail.setWide(true)
    rail.toggle('layers') // manual closed
    rail.setWide(true) // 同值重复喂入（观察回调抖动）
    expect(rail.isOpen('layers')).toBe(false)
    expect(rail.mode('layers')).toBe('closed')
    rail.setWide(false)
    rail.setWide(false) // 同值重复
    expect(rail.mode('layers')).toBe('auto')
  })

  it('双实例独立（embedded/完整双挂载不共享开合记忆）', () => {
    const a = createRailState()
    const b = createRailState()
    a.setWide(true)
    a.toggle('layers')
    expect(b.isOpen('layers')).toBe(false) // b 仍初始窄档
    expect(b.isWide()).toBe(false)
  })
})
