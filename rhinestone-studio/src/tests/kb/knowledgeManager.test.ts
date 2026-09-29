/*
 * [split-admin-portal 3.4] KnowledgeManager jsdom 测试（fake adminApi 注入——
 * zhumo webui KnowledgeManager 复刻验收）。覆盖：分组切换（选中组条目+说明渲染）；
 * 新增分组/条目与编辑保存载荷（value 全量替换+草稿清空）；改名载荷（newKey 通道）；
 * 删除分组/条目确认 Dialog；轻量 includes 搜索（组名/条目/内容命中+清空回编辑态）；
 * 历史面板（log→详情→恢复调用链）与 available=false 降级文案；非 admin 守卫归
 * AdminPage（已有用例——此处不重复）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { FakeAdminApi } from '../admin/fakeAdminApi'
import { makeFakeAdminApi } from '../admin/fakeAdminApi'

const holder: { current: FakeAdminApi | null } = vi.hoisted(() => ({ current: null }))
vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.current!.api }))

import KnowledgeManager from '../../lib/components/kb/KnowledgeManager.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

async function flush(ms = 10): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function mountManager(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(KnowledgeManager, { target })
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

function clickButtonByText(scope: HTMLElement, text: string): void {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button, `按钮「${text}」应存在`).toBeDefined()
  button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  holder.current = makeFakeAdminApi()
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
})

describe('分组切换与条目编辑器', () => {
  it('挂载加载全量：首组选中渲染条目名+内容+说明；切换分组跟随', async () => {
    mountManager()
    await flush()

    const first = q('[data-testid="kb-group-钻径与规格"]')
    expect(first.getAttribute('aria-current')).toBe('true')
    // 条目名/内容是 input/textarea 的 value（textContent 不可见）——按控件值断言
    expect((q('input[aria-label="条目名"]') as HTMLInputElement).value).toBe('SS 尺码表（SS6–SS34）')
    expect((q('textarea[aria-label="条目内容"]') as HTMLTextAreaElement).value).toContain('SS6=2.0')
    expect(document.body.textContent).toContain('来源：整理初版，待领域负责人校订')

    q('[data-testid="kb-group-色系与编码"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(q('[data-testid="kb-group-色系与编码"]').getAttribute('aria-current')).toBe('true')
    expect((q('input[aria-label="条目名"]') as HTMLInputElement).value).toBe('ΔE76 色容差三档（3、10、25）')
    expect(holder.current!.state.calls.kbList).toBe(1)
  })

  it('编辑保存载荷：textarea 草稿 → 保存按钮 kbSaveEntry{group,key,value 全量替换}；未编辑禁用保存', async () => {
    mountManager()
    await flush()

    const textarea = q('textarea[aria-label="条目内容"]') as HTMLTextAreaElement
    expect(textarea.value).toContain('SS6=2.0')
    // 未编辑：保存按钮禁用
    const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '保存')!
    expect((saveButton as HTMLButtonElement).disabled).toBe(true)

    textarea.value = 'SS6=2.0（手工校订）'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    // 草稿脏后保存解禁（draftDirty 派生）
    expect((saveButton as HTMLButtonElement).disabled).toBe(false)
    saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(holder.current!.state.calls.kbSaveEntry).toEqual([
      { group: '钻径与规格', key: 'SS 尺码表（SS6–SS34）', value: 'SS6=2.0（手工校订）' },
    ])
    // 保存后回填：fake 库已更新（控件值跟随）
    expect((q('textarea[aria-label="条目内容"]') as HTMLTextAreaElement).value).toContain('SS6=2.0（手工校订）')
  })

  it('新增分组与新增条目：Enter/按钮 → kbSaveGroup{name}/kbSaveEntry{group,key,待填写}', async () => {
    mountManager()
    await flush()

    const groupName = q('[data-testid="kb-new-group-name"]') as HTMLInputElement
    groupName.value = '工艺规则'
    groupName.dispatchEvent(new Event('input', { bubbles: true }))
    groupName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush(20)
    expect(holder.current!.state.calls.kbSaveGroup).toEqual([{ name: '工艺规则' }])

    const entryKey = q('[data-testid="kb-new-entry-key"]') as HTMLInputElement
    entryKey.value = '贴钻最小间距'
    entryKey.dispatchEvent(new Event('input', { bubbles: true }))
    entryKey.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush(20)
    expect(holder.current!.state.calls.kbSaveEntry).toEqual([
      { group: '工艺规则', key: '贴钻最小间距', value: '（待填写）' },
    ])
  })

  it('条目改名（newKey 通道）：条目名 onchange → kbSaveEntry{key,newKey}', async () => {
    mountManager()
    await flush()

    const keyInput = q('input[aria-label="条目名"]') as HTMLInputElement
    keyInput.value = 'SS 尺码速查'
    keyInput.dispatchEvent(new Event('change', { bubbles: true }))
    await flush(20)

    expect(holder.current!.state.calls.kbSaveEntry).toEqual([
      { group: '钻径与规格', key: 'SS 尺码表（SS6–SS34）', value: 'SS6=2.0、SS8=2.4 … SS34=7.1（非线性，永远查表）', newKey: 'SS 尺码速查' },
    ])
  })

  it('删除分组/条目：确认 Dialog 警示条数 → kbDeleteGroup/kbDeleteEntry', async () => {
    mountManager()
    await flush()

    // 删条目（当前组第一条）
    clickButtonByText(document.body as HTMLElement, '删除')
    await flush()
    const entryDialog = q('[data-testid="kb-delete-entry-dialog"]')
    expect(entryDialog.textContent).toContain('删除条目 · SS 尺码表（SS6–SS34）')
    expect(entryDialog.textContent).toContain('钻径与规格')
    clickButtonByText(entryDialog, '确认删除')
    await flush(20)
    expect(holder.current!.state.calls.kbDeleteEntry).toEqual([
      { group: '钻径与规格', key: 'SS 尺码表（SS6–SS34）' },
    ])

    // 删分组（分组行的删除 icon）
    const deleteIcon = q('[data-testid="kb-group-钻径与规格"] [aria-label="删除分组"]')
    deleteIcon.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    const groupDialog = q('[data-testid="kb-delete-group-dialog"]')
    expect(groupDialog.textContent).toContain('删除分组 · 钻径与规格')
    // 上一步已删 1 条：剩 1 条条目（fake 库真实联动）
    expect(groupDialog.textContent).toContain('1 条条目')
    clickButtonByText(groupDialog, '确认删除')
    await flush(20)
    expect(holder.current!.state.calls.kbDeleteGroup).toEqual(['钻径与规格'])
  })
})

describe('轻量搜索（includes 全文）', () => {
  it('命中条目名/内容/组名；点击命中跳转分组并清空搜索', async () => {
    mountManager()
    await flush()

    const search = q('[data-testid="kb-search-input"]') as HTMLInputElement
    search.value = '色容差'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    const summary = q('[data-testid="kb-search-summary"]')
    expect(summary.textContent).toContain('命中 1 条')
    expect(document.body.textContent).toContain('ΔE76 色容差三档（3、10、25）')
    // 内容命中（不出现于列表 key 的词）
    search.value = '查表'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(q('[data-testid="kb-search-summary"]').textContent).toContain('命中 1 条')

    // 点击命中 → 跳转所在分组 + 清空搜索回编辑态
    const hit = [...document.querySelectorAll('button[aria-label="跳转到该条目所在分组"]')][0]!
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(q('[data-testid="kb-group-钻径与规格"]').getAttribute('aria-current')).toBe('true')
    expect((q('[data-testid="kb-search-input"]') as HTMLInputElement).value).toBe('')
  })

  it('无命中空态文案', async () => {
    mountManager()
    await flush()

    const search = q('[data-testid="kb-search-input"]') as HTMLInputElement
    search.value = '不存在的水词'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(document.body.textContent).toContain('无命中——换个词试试')
  })
})

describe('历史面板（log→详情→恢复）', () => {
  it('修订列表渲染（actor/summary）→ 点开详情（变更文件清单）→ 恢复确认调 kbRestore', async () => {
    mountManager()
    await flush()

    clickButtonByText(document.body as HTMLElement, '修订历史')
    await flush()
    const dialog = q('[data-testid="kb-history-dialog"]')
    expect(dialog.textContent).toContain('修订历史（git）')
    expect(dialog.textContent).toContain('初始化知识库种子（5 组）')
    expect(dialog.textContent).toContain('admin:boss')

    // 点开最新修订 → 详情
    const revisionRow = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.includes('色容差'))!
    revisionRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(dialog.textContent).toContain('返回列表')
    expect(dialog.textContent).toContain('SS 尺码表（SS6–SS34）.md')
    expect(dialog.textContent).toContain('新增')

    // 恢复 → 确认 Dialog → kbRestore(id)
    clickButtonByText(dialog, '恢复到此版本')
    await flush()
    const restoreDialog = q('[data-testid="kb-restore-dialog"]')
    expect(restoreDialog.textContent).toContain('恢复到修订 a1b2c3d')
    expect(restoreDialog.textContent).toContain('当前版本仍保留在历史中')
    clickButtonByText(restoreDialog, '确认恢复')
    await flush(30)
    expect(holder.current!.state.calls.kbRestore).toEqual(['a1b2c3d'])
    // 恢复后刷新历史面
    expect(holder.current!.state.calls.kbRevisions).toBeGreaterThanOrEqual(2)
  })

  it('available=false 降级：无历史可显示+安装提示（读写不受影响文案）', async () => {
    holder.current!.state.kbHistoryAvailable = false
    mountManager()
    await flush()

    clickButtonByText(document.body as HTMLElement, '修订历史')
    await flush()
    const dialog = q('[data-testid="kb-history-dialog"]')
    expect(dialog.textContent).toContain('未检测到 git')
    expect(dialog.textContent).toContain('知识库可正常读写')
    expect(dialog.textContent).toContain('无历史可显示')
  })
})
