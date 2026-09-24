import { describe, expect, it, beforeEach } from 'vitest'
import { withAuthToken } from '../../lib/stonesAdmin/authUrl'

describe('withAuthToken（贴图 img 认证通道）', () => {
  beforeEach(() => { sessionStorage.clear() })
  it('无 token 原样返回', () => {
    expect(withAuthToken('/api/stones/x/texture.png')).toBe('/api/stones/x/texture.png')
  })
  it('有 token 拼查询参数', () => {
    sessionStorage.setItem('handicraft.daemon.token', 'tok en+')
    expect(withAuthToken('/api/stones/x/texture.png')).toBe('/api/stones/x/texture.png?token=tok%20en%2B')
  })
  it('已有查询串用 & 连接', () => {
    sessionStorage.setItem('handicraft.daemon.token', 't')
    expect(withAuthToken('/a?x=1')).toBe('/a?x=1&token=t')
  })
  it('空输入安全', () => {
    expect(withAuthToken(undefined)).toBe('')
    expect(withAuthToken(null)).toBe('')
  })
})
