/**
 * urlFlags 副作用模块测试（?api=rpc&workbenches=1 引导）。
 * jsdom 每文件独立环境——模块副作用在首次 import 时执行；vi.resetModules 后重放。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setUrl = (search: string): void => {
  window.history.replaceState(null, '', search === '' ? '/' : `/?${search}`)
}

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('URL 参数一次性引导', () => {
  it('?api=rpc&workbenches=1 → 双键写入+清参', async () => {
    setUrl('api=rpc&workbenches=1')
    await import('../../lib/stores/urlFlags.js')
    expect(localStorage.getItem('handicraft.agentApi')).toBe('rpc')
    expect(localStorage.getItem('handicraft.dev.workbenches')).toBe('1')
    expect(window.location.search).toBe('')
  })

  it('裸入口不写键不清参', async () => {
    setUrl('')
    await import('../../lib/stores/urlFlags.js')
    expect(localStorage.getItem('handicraft.agentApi')).toBeNull()
    expect(localStorage.getItem('handicraft.dev.workbenches')).toBeNull()
  })

  it('未知值不写入（api=mock 非 rpc）', async () => {
    setUrl('api=mock')
    await import('../../lib/stores/urlFlags.js')
    expect(localStorage.getItem('handicraft.agentApi')).toBeNull()
    // api 参数在场仍触发清参（避免残留引导参数）
    expect(window.location.search).toBe('')
  })
})
