/*
 * [restructure-materials-story W2b] MySetsSection（我的材料→我的贴砖组合）jsdom 测试。
 * fake sets client 注入（warehouse fixtures 复用——调用全记录）——覆盖：
 *   [1] owner 收窄载荷：admin 显式 owner=本人 username；普通用户不传（服务端恒收窄）。
 *   [2] 卡片网格渲染：名称/成员数/更新时间。
 *   [3] 删除链：确认 Dialog→sets.delete(resourceId)→清单刷新（卡片消失）。
 *   [4] 创建入口接线（MainAgent 统一接线后）：按钮可点开 CreateSetDialog（personal）。
 *   [5] 空态/错误态。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { makeWarehouseClient } from '../warehouse/fixtures'
import type { WarehouseSetsClient } from '$lib/warehouse/client'
import MySetsSection from '../../components/my-materials/MySetsSection.svelte'
import { resetMySetsForTests } from '$lib/myMaterials/sets.svelte'
import { resetSessionForTests } from '$lib/stores/session.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function mountSection(client: WarehouseSetsClient): void {
  resetMySetsForTests(client)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(MySetsSection, { target })
  mountedDisposers.push(() => {
    unmount(app)
    target.remove()
  })
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `选择器 ${selector} 应命中`).not.toBeNull()
  return el as HTMLElement
}

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  sessionStorage.clear()
  localStorage.clear()
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  resetMySetsForTests()
})

describe('我的贴砖组合（W2b）', () => {
  it('admin 身份：sets.list 显式 owner=本人 username；卡片渲染名称/成员数/更新时间', async () => {
    resetSessionForTests({ username: 'boss', role: 'admin' })
    const fixture = makeWarehouseClient({
      sets: [
        { label: 'snowman', name: '圣诞雪人款', members: [{ stoneRef: 'res-yh-j51', quantity: 2 }, { stoneRef: 'res-yh-a51' }] },
        { label: 'cartoon', name: '小件卡通订单', members: [{ stoneRef: 'res-fb-j51' }] },
      ],
    })
    mountSection(fixture.client.sets)
    await flush()

    // owner 收窄（daemon 语义：admin 缺省全量——我的材料恒本人域，前端显式收窄）
    expect(fixture.calls.list).toHaveLength(1)
    expect(fixture.calls.list[0]!.owner).toBe('boss')
    expect(fixture.calls.list[0]!.includeTrashed).toBe(false)
    // 卡片网格
    const card = q('[data-testid="my-sets-card-set-snowman"]')
    expect(card.textContent).toContain('圣诞雪人款')
    expect(card.textContent).toContain('2 款钻')
    expect(card.textContent).toContain('更新于')
    expect(q('[data-testid="my-sets-card-set-cartoon"]').textContent).toContain('1 款钻')
    expect(q('[data-testid="my-sets-count"]').textContent).toContain('2 个组合')
  })

  it('普通用户身份：不传 owner（daemon 恒收窄自己——前端不重复造过滤）', async () => {
    resetSessionForTests({ username: 'worker', role: 'user' })
    const fixture = makeWarehouseClient({ sets: [{ label: 'only', name: '唯一组合', members: [{ stoneRef: 'res-yh-j51' }] }] })
    mountSection(fixture.client.sets)
    await flush()

    expect(fixture.calls.list).toHaveLength(1)
    expect(fixture.calls.list[0]!.owner).toBeUndefined()
    expect(q('[data-testid="my-sets-card-set-only"]')).toBeDefined()
  })

  it('删除链：确认 Dialog→sets.delete(resourceId)→刷新后卡片消失', async () => {
    resetSessionForTests({ username: 'worker', role: 'user' })
    const fixture = makeWarehouseClient({
      sets: [
        { label: 'a', name: '组合A', members: [{ stoneRef: 'res-yh-j51' }] },
        { label: 'b', name: '组合B', members: [{ stoneRef: 'res-yh-j51' }] },
      ],
    })
    mountSection(fixture.client.sets)
    await flush()

    q('[data-testid="my-sets-delete-set-a"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    const dialog = q('[data-testid="my-sets-delete-dialog"]')
    expect(dialog.textContent).toContain('删除组合 · 组合A')
    expect(dialog.textContent).toContain('回收站')
    q('[data-testid="my-sets-delete-confirm"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(fixture.calls.delete).toEqual(['set-a'])
    expect(document.querySelector('[data-testid="my-sets-card-set-a"]')).toBeNull()
    expect(q('[data-testid="my-sets-card-set-b"]')).toBeDefined()
  })

  it('创建入口接线：按钮可点开 CreateSetDialog（ownerScope=personal）', async () => {
    resetSessionForTests({ username: 'boss', role: 'admin' })
    const fixture = makeWarehouseClient({ sets: [{ label: 'a', name: '组合A', members: [{ stoneRef: 'res-yh-j51' }] }] })
    mountSection(fixture.client.sets)
    await flush()

    const create = q('[data-testid="my-sets-create"]') as HTMLButtonElement
    expect(create.disabled).toBe(false)
    expect(create.title).toBe('新建本人贴砖组合')
    create.click()
    await flush()
    const dialog = q('[data-testid="create-set-dialog"]') as HTMLElement
    expect(dialog).toBeDefined()
    expect(dialog.dataset.ownerscope).toBe('personal')
  })

  it('空态：无组合——故事向文案（从材料市场挑钻组套）', async () => {
    resetSessionForTests({ username: 'worker', role: 'user' })
    const fixture = makeWarehouseClient()
    mountSection(fixture.client.sets)
    await flush()

    expect(q('[data-testid="my-sets-empty"]').textContent).toContain('还没有自己的贴砖组合')
    expect(q('[data-testid="my-sets-empty"]').textContent).toContain('材料市场')
  })

  it('错误态：daemon 不可达——错误横幅+重试在场', async () => {
    resetSessionForTests({ username: 'worker', role: 'user' })
    const fixture = makeWarehouseClient()
    const failing: WarehouseSetsClient = {
      ...fixture.client.sets,
      list: async () => {
        throw new Error('组合/套装库 RPC 连接失败（daemon 不可达）')
      },
    }
    mountSection(failing)
    await flush()

    expect(q('[data-testid="my-sets-error"]').textContent).toContain('daemon 不可达')
    expect(q('[data-testid="my-sets-empty"]')).toBeDefined() // 错误时空清单并存（不误导读档）
  })
})
