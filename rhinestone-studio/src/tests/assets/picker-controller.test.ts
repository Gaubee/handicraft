/**
 * AssetPickerController 协议全量（add-asset-library design §5 冻结 / tasks 3.1）：
 * open / resolve / cancel / Esc / 并发接管 / Host 销毁 / multi 半选清空 / 单选整替。
 * 纯协议层测试：不挂 UI、不触 IndexedDB。
 */

import { describe, expect, it } from 'vitest'
import { AssetPickerController } from '$lib/assets/controller.svelte'
import type { AssetImage } from '$lib/persistence/assetStore'

function image(id: string, name = `${id}.png`): AssetImage {
  return {
    id,
    type: 'image',
    refKind: 'blob',
    blobKey: `key-${id}`,
    name,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    mime: 'image/png',
    width: 10,
    height: 10,
    bytes: 3,
    source: 'upload',
  }
}

describe('AssetPickerController 协议（design §5）', () => {
  it('open → resolve(确定) → promise 以选择数组落定，会话关闭', async () => {
    const controller = new AssetPickerController()
    const pending = controller.open()
    expect(controller.request).not.toBeNull()
    expect(controller.request?.multi).toBe(false)

    controller.pick(image('a'))
    controller.resolve(controller.selection)
    await expect(pending).resolves.toHaveLength(1)
    await expect(pending).resolves.toMatchObject([{ id: 'a' }])

    // 会话已关闭：request 清空、后续 resolve no-op
    expect(controller.request).toBeNull()
    controller.resolve([image('b')])
  })

  it('open → cancel → resolve(null)', async () => {
    const controller = new AssetPickerController()
    const pending = controller.open()
    controller.cancel()
    await expect(pending).resolves.toBeNull()
    expect(controller.request).toBeNull()
  })

  it('Esc（document keydown）→ resolve(null)', async () => {
    const controller = new AssetPickerController()
    const pending = controller.open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(pending).resolves.toBeNull()
  })

  it('非 Esc 按键不打断会话；会话结束后 Esc 监听移除', async () => {
    const controller = new AssetPickerController()
    const pending = controller.open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(controller.request).not.toBeNull()

    controller.cancel()
    await expect(pending).resolves.toBeNull()

    // 监听已摘除：后续 Esc 不得抛错也不再产生副作用
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(controller.request).toBeNull()
  })

  it('并发 open：后到者接管，前者 resolve(null)，后者正常 resolve', async () => {
    const controller = new AssetPickerController()
    const first = controller.open()
    const second = controller.open({ multi: true })

    await expect(first).resolves.toBeNull()

    controller.pick(image('a'))
    controller.pick(image('b'))
    controller.resolve(controller.selection)
    await expect(second).resolves.toHaveLength(2)
  })

  it('Host 销毁（destroy）→ 等待方 resolve(null)，controller 可复用', async () => {
    const controller = new AssetPickerController()
    const first = controller.open({ initialFolderId: 'sys-uploads' })
    controller.destroy()
    await expect(first).resolves.toBeNull()

    const second = controller.open()
    controller.pick(image('c'))
    controller.resolve(controller.selection)
    await expect(second).resolves.toMatchObject([{ id: 'c' }])
  })

  it('multi 半选态：cancel 后清空；切换选摘；pick 快照节点', async () => {
    const controller = new AssetPickerController()
    const pending = controller.open({ multi: true })
    expect(controller.request?.multi).toBe(true)

    controller.pick(image('a'))
    controller.pick(image('b'))
    controller.pick(image('a')) // 再点摘除
    expect(controller.selection.map((s) => s.id)).toEqual(['b'])
    expect(controller.isSelected('b')).toBe(true)
    expect(controller.isSelected('a')).toBe(false)

    controller.cancel()
    await expect(pending).resolves.toBeNull()
    expect(controller.selection).toHaveLength(0)
  })

  it('单选模式：点选整替（不叠加）', async () => {
    const controller = new AssetPickerController()
    const pending = controller.open()

    controller.pick(image('a'))
    controller.pick(image('b'))
    expect(controller.selection.map((s) => s.id)).toEqual(['b'])

    controller.cancel()
    await expect(pending).resolves.toBeNull()
  })

  it('open 携带 initialFolderId 进入请求；resolve 后 promise 值为快照副本', async () => {
    const controller = new AssetPickerController()
    const pending = controller.open({ initialFolderId: 'sys-generated' })
    expect(controller.request?.initialFolderId).toBe('sys-generated')

    const picked = image('x')
    controller.pick(picked)
    const settled = controller.resolve(controller.selection) // 返回 void，仅触发落定
    expect(settled).toBeUndefined()

    const value = await pending
    expect(value).toHaveLength(1)
    expect(value?.[0]).not.toBe(picked) // pick 时已快照，resolve 再拷贝
  })

  it('无会话时 cancel / destroy 均 no-op，不抛错', () => {
    const controller = new AssetPickerController()
    expect(() => {
      controller.cancel()
      controller.destroy()
    }).not.toThrow()
  })
})
