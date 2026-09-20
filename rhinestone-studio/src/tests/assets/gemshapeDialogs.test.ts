/**
 * [UX-B] 钻形复制/删除弹窗——GemshapeSheet 组件面（无 labFile 依赖链，可独立运行）：
 * - 另存副本 = 命名弹窗（预填「原名 副本」/ 编辑生效落库 / 取消零变更）；
 * - 删除 = 确认弹窗（弱引用后果文案说清 + 确认软删入回收站）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import GemshapeSheet from '../../components/Assets/GemshapeSheet.svelte'
import { getProject, ingestGemshapeFile, listChildNodes, resetAssetStoreForTests } from '$lib/persistence/assetStore'
import { serializeGemshape, type GemshapeFileInput, type GemshapeTextureDecoder } from '$lib/persistence/gemshapeFile'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function click(selector: string): void {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`click 目标不存在：${selector}`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function setInputValue(selector: string, value: string): void {
  const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
  if (!el) throw new Error(`input 目标不存在：${selector}`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  localStorage.clear()
  resetToastsForTests()
})

afterEach(async () => {
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 样本与确定性解码替身（沿 gemshapeAsset.test.ts 口径）
// ---------------------------------------------------------------------------

const TEXTURE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo'

function sampleShapeInput(): GemshapeFileInput {
  return {
    appVersion: '0.1.0-test',
    createdAt: 1758000000000,
    savedAt: 1758000000000,
    name: '自定义钻形',
    texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 50, height: 50 },
    physical: { widthMm: 3, heightMm: 3 },
    calibration: { mode: 'direct' },
  }
}

function rectDecoder(width: number, height: number): GemshapeTextureDecoder {
  return async () => {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = Math.floor(height * 0.1); y < Math.ceil(height * 0.9); y += 1) {
      for (let x = Math.floor(width * 0.1); x < Math.ceil(width * 0.9); x += 1) {
        const i = (y * width + x) * 4
        data[i] = 200
        data[i + 1] = 200
        data[i + 2] = 210
        data[i + 3] = 255
      }
    }
    return { width, height, data }
  }
}

async function shapesUnderSys(): Promise<AssetProject[]> {
  const children = await listChildNodes('sys-shapes')
  return children.filter((n): n is AssetProject => n.type === 'project' && n.trashedAt === undefined)
}

async function mountSheetWithShape(): Promise<{ target: HTMLElement; teardown: () => void; nodeId: string }> {
  const { node } = await ingestGemshapeFile(
    new Blob([serializeGemshape(sampleShapeInput())], { type: PROJECT_MIME.gemshape }),
    { decode: rectDecoder(50, 50) },
  )
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(GemshapeSheet, {
    target,
    props: { assetId: node.id, onclose: () => {}, onforked: () => {}, ondeleted: () => {} },
  })
  await waitFor(() => document.querySelector('[data-testid="gemshape-sheet-texture"]') !== null)
  return {
    target,
    nodeId: node.id,
    teardown: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('钻形另存副本/删除弹窗（UX-B）', () => {
  it('另存副本：点击后命名弹窗呈现并预填「原名 副本」；取消零变更', async () => {
    const { teardown, nodeId } = await mountSheetWithShape()
    const before = (await shapesUnderSys()).length

    click('[data-testid="gemshape-sheet-fork"]')
    await tick()
    expect(document.querySelector('[data-testid="gemshape-fork-dialog"]')).not.toBeNull()
    const nameInput = document.querySelector('[data-testid="gemshape-fork-name-input"]') as HTMLInputElement
    expect(nameInput.value).toBe('自定义钻形 副本')

    setInputValue('[data-testid="gemshape-fork-name-input"]', '不该创建的钻形')
    click('[data-testid="gemshape-fork-cancel"]')
    await waitFor(() => document.querySelector('[data-testid="gemshape-fork-dialog"]') === null)
    expect((await shapesUnderSys()).length).toBe(before)
    expect((await shapesUnderSys()).some((n) => n.name === '不该创建的钻形')).toBe(false)
    expect((await shapesUnderSys()).some((n) => n.id === nodeId)).toBe(true) // 原资产仍在
    teardown()
  })

  it('另存副本：编辑名称后确认 → 新节点落库（编辑生效）；原资产不动', async () => {
    const { teardown, nodeId } = await mountSheetWithShape()
    const before = (await shapesUnderSys()).length

    click('[data-testid="gemshape-sheet-fork"]')
    await tick()
    setInputValue('[data-testid="gemshape-fork-name-input"]', '我的新钻形')
    click('[data-testid="gemshape-fork-confirm"]')
    await waitFor(async () => (await shapesUnderSys()).length === before + 1)
    const created = (await shapesUnderSys()).find((n) => n.name === '我的新钻形')
    expect(created).toBeDefined()
    expect(created?.id).not.toBe(nodeId)
    const origin = await getProject(nodeId)
    expect(origin?.name).toBe('自定义钻形') // 原资产不动
    teardown()
  })

  it('删除：确认弹窗含弱引用后果文案 → 确认软删入回收站', async () => {
    const { teardown, nodeId } = await mountSheetWithShape()

    click('[data-testid="gemshape-sheet-delete"]')
    await tick()
    expect(document.body.textContent).toContain('删除钻形')
    expect(document.body.textContent).toContain('规格缺失') // 弱引用后果说清
    click('[data-testid="gemshape-delete-confirm"]')
    await waitFor(async () => {
      const n = await getProject(nodeId)
      return n?.trashedAt !== undefined
    })
    const node = await getProject(nodeId)
    expect(node?.trashedAt).toBeDefined()
    teardown()
  })
})
