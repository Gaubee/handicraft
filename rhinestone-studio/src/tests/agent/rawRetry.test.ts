/*
 * [Owner 验收 2026-09-30「上传后预览图缺失」] raw 回显 401 自愈。
 * 背景：daemon 重启（JWT_SECRET 随机）使旧 token 失效——img src 带 token 401
 * 裂图。自愈=onerror 时重读当前应生效 token，不同则换 src 重试一次（__rt 防循环）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetRawUrl, retryRawImageOnError } from '$lib/agentApi/attachments'
import { setStoredToken, ANONYMOUS_TOKEN_KEY } from '$lib/daemonToken'

describe('raw 回显 401 自愈（attachments.retryRawImageOnError）', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('token 轮换后 onerror 换新 token 重试一次（__rt 防循环）', () => {
    setStoredToken('tok-old')
    const img = document.createElement('img')
    img.src = assetRawUrl('ab'.repeat(32))
    expect(img.src).toContain('token=tok-old')

    setStoredToken('tok-new')
    retryRawImageOnError({ currentTarget: img } as unknown as Event)
    expect(img.src).toContain('token=tok-new')
    expect(img.src).toContain('__rt=1')

    // 已带 __rt：再次 onerror 不再改 src（防循环）
    const srcAfterFirst = img.src
    setStoredToken('tok-newer')
    retryRawImageOnError({ currentTarget: img } as unknown as Event)
    expect(img.src).toBe(srcAfterFirst)
  })

  it('token 未变化（非鉴权问题）不重试', () => {
    setStoredToken('tok-same')
    const img = document.createElement('img')
    img.src = assetRawUrl('cd'.repeat(32))
    const before = img.src
    retryRawImageOnError({ currentTarget: img } as unknown as Event)
    expect(img.src).toBe(before)
  })

  it('assetRawUrl 匿名键位兜底（登录键空+匿名缓存在场）', () => {
    sessionStorage.setItem(ANONYMOUS_TOKEN_KEY, 'tok-anon')
    expect(assetRawUrl('ef'.repeat(32))).toContain('token=tok-anon')
  })
})
