/**
 * 效果提示词 Dialog 交互（openspec add-lab-effect-prompt-placeholders 切片 3.2 +
 * improve-lab-advanced-ux 点 1/点 2；Owner 2026-09-21：入口 TextQuote 按钮化 + 开关即注入/移除
 * 取代手动「插入到提示词」）。
 *
 * 覆盖：
 * - [lab-ux 1] 三入口为可辨识按钮（TextQuote/aria-label/tooltip）；
 * - 打开预填自动文案（案例 = CASE_DESC 单一真源；水钻 = 【尺寸与钻规格】预览）；
 * - 保存 = 覆盖落键（record + 磁盘 round-trip）；空文本保存 = 清除覆盖回 auto；
 * - 取消 = 丢弃编辑（record 零变化）；
 * - [lab-ux 2] 开关即注入/移除矩阵（案例/水钻 pendingOpen 点亮路径/蓝图；句中占位符只剥文本；
 *   Dialog 无插入动作）；落盘 round-trip；
 * - 案例开关门控选图面（关灯 EffectRefControl 收起、绑定保留）；
 * - 发起面板占位符缺失提示（RunBar placeholder-missing-hint 派生矩阵）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

import { parseGemtpl } from '$lib/persistence/labFile'
import { GEMSHAPE_SEEDS } from '$lib/engine'
import { getImageBlob } from '$lib/persistence/imageStore'
import { getProject, resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import { hydrate, resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  resetTemplatesForTests,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { autoCaseRefFragment } from '$lib/presets/effectRefs'
import TemplateEditor from '../../components/Lab/TemplateEditor.svelte'
import RunBar from '../../components/Lab/RunBar.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains, type FakeIndexedDB } from './helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let objectUrlCounter = 0

function stubSeedFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/presets/')) {
      const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

async function readTemplateFile(assetId: string) {
  const node = await getProject(assetId)
  if (!node) throw new Error('template node missing')
  const blob = await getImageBlob(node.blobKey)
  if (!blob) throw new Error('template blob missing')
  return parseGemtpl(await blob.text(), { mime: node.mime })
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  class OkImage {
    naturalWidth = 64
    naturalHeight = 64
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)
  vi.stubGlobal('fetch', stubSeedFetch())
  localStorage.clear()
  resetLabForTests()
  localStorage.clear()
  await runAssetMigration()
})

afterEach(async () => {
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function mountEditor(assetId: string): Promise<{ target: HTMLDivElement; teardown: () => void }> {
  const target = document.createElement('div')
  document.body.append(target)
  const app = mount(TemplateEditor, { target, props: { templateAssetId: assetId } })
  await tick()
  return { target, teardown: () => { unmount(app); target.remove() } }
}

function q(target: HTMLDivElement, selector: string): HTMLElement {
  const el = target.querySelector(selector)
  if (!el) throw new Error(`selector not found: ${selector}`)
  return el as HTMLElement
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 全局 document 查找（Dialog portal 挂 body）。 */
function docQ(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`document selector not found: ${selector}`)
  return el as HTMLElement
}

describe('效果提示词 Dialog：打开预填 + 保存/取消/插入（案例）', () => {
  it('[lab-ux 1] 三入口为可辨识按钮：TextQuote + aria-label + tooltip（弃铅笔）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const { target, teardown } = await mountEditor(id)

    for (const key of ['caseRef', 'drillParams', 'blueprint'] as const) {
      const btn = q(target, `[data-testid="effect-prompt-edit-${key}"]`) as HTMLButtonElement
      expect(btn.tagName).toBe('BUTTON') // 是按钮不是纯 icon
      expect(btn.getAttribute('aria-label')).toContain('编辑')
      expect(btn.getAttribute('aria-label')).toContain('提示词片段')
      expect(btn.getAttribute('title')).toContain('编辑提示词片段')
      expect(btn.querySelector('svg.lucide-text-quote')).not.toBeNull() // TextQuote 图标（弃 pencil）
      expect(btn.querySelector('svg.lucide-pencil')).toBeNull()
    }

    teardown()
  })

  it('铅笔入口打开：textarea 预填自动文案（autoCaseRefFragment 单一真源——按模板附图集形态）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const { target, teardown } = await mountEditor(id)

    q(target, '[data-testid="effect-prompt-edit-caseRef"]').click()
    await waitFor(() => document.querySelector('[data-testid="effect-prompt-textarea"]') !== null)
    const textarea = docQ('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement
    const layout = getTemplateRecord(id)?.caseBinding?.caseLayout ?? 'single'
    // 〔WYSIWYG〕预填 = autoCaseRefFragment（计数行 + 图序声明 + 参照任务句；无用户原图 → 单图形态）
    expect(textarea.value).toBe(autoCaseRefFragment({ hasCase: true, caseLayout: layout, hasReference: false }))
    expect(textarea.value).toContain('我上传了一张图片：')
    expect(docQ('[data-testid="effect-prompt-mode"]').textContent).toContain('自动生成')

    teardown()
  })

  it('编辑 + 保存：覆盖落键（record + 磁盘）；再开回显覆盖文本', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const { target, teardown } = await mountEditor(id)

    q(target, '[data-testid="effect-prompt-edit-caseRef"]').click()
    await waitFor(() => document.querySelector('[data-testid="effect-prompt-textarea"]') !== null)
    const textarea = docQ('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement
    textarea.value = '用户改写的案例指引'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    docQ('[data-testid="effect-prompt-save"]').click()
    await tick()
    await waitFor(() => document.querySelector('[data-testid="effect-prompt-textarea"]') === null) // 关窗（卸载异步）
    expect(getTemplateRecord(id)?.caseRef).toEqual({ enabled: true, promptFragment: '用户改写的案例指引' })
    await whenTemplatesIdle()
    expect((await readTemplateFile(id)).caseRef).toEqual({ enabled: true, promptFragment: '用户改写的案例指引' })

    // 再开：回显覆盖文本 + mode 标记
    q(target, '[data-testid="effect-prompt-edit-caseRef"]').click()
    await waitFor(() => document.querySelector('[data-testid="effect-prompt-textarea"]') !== null)
    expect((docQ('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement).value).toBe('用户改写的案例指引')
    expect(docQ('[data-testid="effect-prompt-mode"]').textContent).toContain('覆盖')

    teardown()
  })

  it('取消 = 丢弃编辑（record 零变化）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const { target, teardown } = await mountEditor(id)

    q(target, '[data-testid="effect-prompt-edit-caseRef"]').click()
    await waitFor(() => document.querySelector('[data-testid="effect-prompt-textarea"]') !== null)
    const textarea = docQ('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement
    textarea.value = '不应落键的草稿'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    docQ('[data-testid="effect-prompt-cancel"]').click()
    await tick()
    expect(getTemplateRecord(id)?.caseRef?.promptFragment).toBeUndefined()

    teardown()
  })

  it('空文本保存 = 清除覆盖回 auto（再开预填自动文案）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { caseRef: { enabled: true, promptFragment: '旧覆盖' } })
    const { target, teardown } = await mountEditor(id)

    q(target, '[data-testid="effect-prompt-edit-caseRef"]').click()
    await waitFor(() => document.querySelector('[data-testid="effect-prompt-textarea"]') !== null)
    const textarea = docQ('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement
    textarea.value = '   '
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    docQ('[data-testid="effect-prompt-save"]').click()
    await tick()
    expect(getTemplateRecord(id)?.caseRef).toEqual({ enabled: true }) // 覆盖剥键

    teardown()
  })
})

describe('[lab-ux 2] 开关即注入/移除：效果开关拨动 → 占位符自动进出主提示词', () => {
  it('案例开关：开 → \\n【占位符】\\n 追加末尾；关 → 整行移除（数据键与绑定保留）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    // v2 seed 正文自带案例占位符 + 绑定在（读面归一=开）——先归零：关灯 + 清占位符（聚焦注入动作）
    submitTemplateField(id, { caseRef: { enabled: false } })
    submitTemplateField(id, { promptBody: '注入测试正文' })
    const { target, teardown } = await mountEditor(id)

    // 开 → 默认式追加末尾（与效果键同一 patch）
    q(target, '[data-testid="case-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('注入测试正文\n【案例参照图提示词】\n')
    expect(getTemplateRecord(id)?.caseRef).toEqual({ enabled: true })

    // 再开（占位符已存在）→ 不重复（幂等；UI 归一读面已开，此处经 API 关后重开验证）
    submitTemplateField(id, { caseRef: { enabled: false } })
    await tick()
    q(target, '[data-testid="case-switch"]').click()
    await tick()
    const once = getTemplateRecord(id)?.promptBody ?? ''
    expect(once.match(/【案例参照图提示词】/g)).toHaveLength(1)

    // 关 → 移除（占位符行连同换行消失；绑定保留）
    const binding = getTemplateRecord(id)?.caseBinding
    q(target, '[data-testid="case-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('注入测试正文')
    expect(getTemplateRecord(id)?.caseRef).toEqual({ enabled: false })
    expect(getTemplateRecord(id)?.caseBinding).toEqual(binding)

    await whenTemplatesIdle()
    expect((await readTemplateFile(id)).promptBody).toBe('注入测试正文') // 落盘 round-trip

    teardown()
  })

  it('水钻开关：空清单拨开不注入；首规格入单点亮时注入；关灯移除', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { promptBody: '水钻开关测试' })
    const { target, teardown } = await mountEditor(id)

    // 1) 空清单拨开：pendingOpen 中间态——enabled 未落，不注入
    q(target, '[data-testid="drill-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('水钻开关测试')
    expect(getTemplateRecord(id)?.drillParams).toBeUndefined()

    // 2) 首规格入单 = enabled false→true 换档 → 注入
    const select = q(target, '[data-testid="drill-spec-add"]') as HTMLSelectElement
    await waitFor(() => select.options.length > 1)
    select.value = select.options[1].value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getTemplateRecord(id)?.drillParams?.enabled).toBe(true)
    expect(getTemplateRecord(id)?.promptBody).toBe('水钻开关测试\n【水钻参数提示词】\n')

    // 3) 关灯 → 移除 + 清单保留
    q(target, '[data-testid="drill-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('水钻开关测试')
    expect(getTemplateRecord(id)?.drillParams?.enabled).toBe(false)
    expect((getTemplateRecord(id)?.drillParams?.specs ?? []).length).toBe(1)

    teardown()
  })

  it('蓝图开关：开 → 注入；关 → 移除', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { promptBody: '蓝图开关测试' })
    const { target, teardown } = await mountEditor(id)

    q(target, '[data-testid="blueprint-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('蓝图开关测试\n【蓝图效果提示词】\n')
    q(target, '[data-testid="blueprint-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('蓝图开关测试')

    teardown()
  })

  it('占位符被手动移进句中：再开-关只剥占位符文本（句子保留）；Dialog 无「插入到提示词」动作', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { caseRef: { enabled: false } }) // 先归零开关态（绑定在 → 读面归一为开）
    submitTemplateField(id, { promptBody: '见【案例参照图提示词】这里' })
    const { target, teardown } = await mountEditor(id)

    // 占位符已在句中 → 开关开不重复注入（幂等）
    q(target, '[data-testid="case-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('见【案例参照图提示词】这里')

    // 关 → 只剥占位符文本，句子其余保留
    q(target, '[data-testid="case-switch"]').click()
    await tick()
    expect(getTemplateRecord(id)?.promptBody).toBe('见这里')

    // Dialog 动作面：保存/取消两件，「插入到提示词」退役
    submitTemplateField(id, { caseRef: { enabled: true } })
    await tick()
    q(target, '[data-testid="effect-prompt-edit-caseRef"]').click()
    await waitFor(() => document.querySelector('[data-testid="effect-prompt-textarea"]') !== null)
    expect(document.querySelector('[data-testid="effect-prompt-insert"]')).toBeNull()
    expect(docQ('[data-testid="effect-prompt-save"]')).toBeTruthy()
    expect(docQ('[data-testid="effect-prompt-cancel"]')).toBeTruthy()

    teardown()
  })
})

describe('水钻/蓝图 Dialog：自动文案预填（预览口径）', () => {
  it('水钻铅笔：预填【尺寸与钻规格】预览（目录解析 specs）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, {
      drillParams: { enabled: true, specs: [GEMSHAPE_SEEDS[0]?.specKey ?? 'round-ss10'] },
    })
    const { target, teardown } = await mountEditor(id)

    q(target, '[data-testid="effect-prompt-edit-drillParams"]').click()
    await waitFor(() => {
      const el = document.querySelector('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement | null
      return el !== null && el.value.includes('【尺寸与钻规格】')
    })
    const textarea = docQ('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement
    expect(textarea.value).toContain('只允许使用以下钻')

    teardown()
  })

  it('蓝图铅笔：预填 autoBlueprintPromptFragment 串行片段默认内容（图序声明并入——所见即所发）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { blueprint: { enabled: true } })
    const { target, teardown } = await mountEditor(id)

    q(target, '[data-testid="effect-prompt-edit-blueprint"]').click()
    await waitFor(() => {
      const el = document.querySelector('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement | null
      return el !== null && el.value.includes('【任务：施工蓝图转换】')
    })
    const textarea = docQ('[data-testid="effect-prompt-textarea"]') as HTMLTextAreaElement
    expect(textarea.value).toContain('。（无编号纯转换：图中钻位不标号、无图例。）')
    // 〔WYSIWYG〕图序声明并入片段默认内容（无用户原图 → 单图形态：成品效果图占图一）
    expect(textarea.value).toContain('我上传了一张图片：')
    expect(textarea.value).toContain('1. 【图一 [image #1]：成品效果图】：本设计的局部贴钻成品效果图。')

    teardown()
  })
})

describe('案例开关门控选图面（关灯不丢绑定）', () => {
  it('关灯：EffectRefControl 收起、caseRef 落 {enabled:false}、绑定保留；再开恢复', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const binding = getTemplateRecord(id)?.caseBinding
    expect(binding).not.toBeNull()
    const { target, teardown } = await mountEditor(id)

    // 初始（键缺席 + 绑定在 → 读面归一为开）：选图面在
    await waitFor(() => target.querySelector('[data-testid="effect-ref-control"]') !== null)

    // 关灯
    q(target, '[data-testid="case-switch"]').click()
    await tick()
    expect(target.querySelector('[data-testid="effect-ref-control"]')).toBeNull()
    expect(getTemplateRecord(id)?.caseRef).toEqual({ enabled: false })
    expect(getTemplateRecord(id)?.caseBinding).toEqual(binding) // 绑定保留
    await whenTemplatesIdle()
    expect((await readTemplateFile(id)).caseBinding).toEqual(binding)

    // 再开：选图面恢复（数据保留）
    q(target, '[data-testid="case-switch"]').click()
    await tick()
    await waitFor(() => target.querySelector('[data-testid="effect-ref-control"]') !== null)
    expect(getTemplateRecord(id)?.caseRef).toEqual({ enabled: true })

    teardown()
  })
})

describe('发起面板占位符缺失提示（RunBar 派生矩阵）', () => {
  it('开关开 + 缺占位符 → 提示行；补占位符后消失；关灯后消失', async () => {
    await hydrate()
    updateSettings({ baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' })
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { drillParams: { enabled: true, specs: ['round-ss10'] } })
    submitTemplateField(id, { blueprint: { enabled: true } })
    // 其余模板关案例开关：聚焦本模板的 drill/blueprint 提示（seed 案例绑定会常驻 case 缺占位提示）
    for (const other of getTemplateAssetIds().slice(1)) {
      submitTemplateField(other, { caseRef: { enabled: false } })
    }
    await whenTemplatesIdle()

    const target = document.createElement('div')
    document.body.append(target)
    const app = mount(RunBar, { target })
    await tick()

    await waitFor(() => target.querySelector('[data-testid="placeholder-missing-hint"]') !== null)
    const hint = target.querySelector('[data-testid="placeholder-missing-hint"]')
    // v2 seed 正文自带案例占位符 → case 无提示（占位符在位）；drill/blueprint 两条在位
    expect(hint?.textContent).not.toContain('案例参照图已开启但主提示词缺少')
    expect(hint?.textContent).toContain('水钻参数配置已开启但主提示词缺少 【水钻参数提示词】')
    expect(hint?.textContent).toContain('蓝图效果已开启但主提示词缺少 【蓝图效果提示词】')

    // 补齐缺失占位符 → 提示消失（条件消除）
    const body = getTemplateRecord(id)?.promptBody ?? ''
    submitTemplateField(id, {
      promptBody: `${body}\n【水钻参数提示词】\n【蓝图效果提示词】`,
    })
    await tick()
    await waitFor(() => target.querySelector('[data-testid="placeholder-missing-hint"]') === null)

    // 关灯水钻 → 仍无提示（条件消除）
    submitTemplateField(id, { drillParams: { enabled: false, specs: ['round-ss10'] } })
    await tick()
    expect(target.querySelector('[data-testid="placeholder-missing-hint"]')).toBeNull()

    unmount(app)
    target.remove()
  })
})
