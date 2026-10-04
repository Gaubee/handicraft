/*
 * [unify-studio-routing sweep ④] 顶栏 tab 焦点/选中视觉层级守卫（类断言——CSS 面
 * 不入 jsdom 渲染，走源码锚定，historyGuard 同式）：防回归两条——
 *   [1] 基类 tabs-trigger 保留「激活 tab 不叠焦点环」（2026-10-02 批：
 *       data-active:focus-visible ring/outline/border 三压——键盘导航聚焦选中 tab
 *       不产生焦点环+选中底双高亮）；
 *   [2] 顶栏锚（app.css .app-topbar-tabs）定义焦点弱化层级：非激活聚焦=box-shadow
 *       置空+细描边（ring-[3px] 三叠是次强高亮，与选中实底并存成双强高亮）；
 *       激活聚焦=outline none（实底唯一强高亮）。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(path.resolve(__dirname, '../../app.css'), 'utf8')
const TRIGGER = readFileSync(
  path.resolve(__dirname, '../../lib/components/ui/tabs/tabs-trigger.svelte'),
  'utf8',
)

describe('顶栏 tab 焦点/选中层级守卫（sweep ④）', () => {
  it('基类：激活 tab 聚焦不叠焦点环（data-active:focus-visible 压 ring/outline/border）', () => {
    expect(
      TRIGGER,
      'tabs-trigger 基类应保留激活态焦点压制（键盘导航聚焦选中 tab 零双高亮）',
    ).toContain('data-active:focus-visible:ring-0')
    expect(TRIGGER).toContain('data-active:focus-visible:outline-none')
  })

  it('顶栏锚：非激活聚焦=弱指示（ring 置空+细描边）；激活聚焦=零叠加', () => {
    const focusBlock = /\.app-topbar-tabs \[data-slot='tabs-trigger'\]:focus-visible \{[^}]*\}/.exec(CSS)?.[0]
    expect(focusBlock, 'app.css 应定义 .app-topbar-tabs tabs-trigger 焦点层级（box-shadow 置空压 ring）')
      .toContain('box-shadow: none')
    expect(focusBlock).toContain('outline: 1px solid')

    const activeFocusBlock = /\.app-topbar-tabs \[data-slot='tabs-trigger'\]\[data-state='active'\]:focus-visible \{[^}]*\}/.exec(
      CSS,
    )?.[0]
    expect(activeFocusBlock, '选中 tab 聚焦应零叠加（实底唯一强高亮）').toContain('outline: none')
  })

  it('顶栏锚：选中态保持实底（accent-soft——层级=选中强/焦点弱的前提）', () => {
    const activeBlock = /\.app-topbar-tabs \[data-slot='tabs-trigger'\]\[data-state='active'\] \{[^}]*\}/.exec(CSS)?.[0]
    expect(activeBlock).toContain('background: var(--accent-soft)')
  })
})
