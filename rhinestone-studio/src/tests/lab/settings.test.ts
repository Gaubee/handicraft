import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  joinBaseUrl,
  loadSettings,
  normalizeBaseUrl,
  saveSettings,
} from '$lib/api/settings'

afterEach(() => {
  localStorage.clear()
})

describe('BYOK 设置 localStorage 持久化', () => {
  it('空存储返回默认值（model 默认 gpt-image-2.5）', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.model).toBe('gpt-image-2.5')
    expect(DEFAULT_MODEL).toBe('gpt-image-2.5')
  })

  it('保存/读取往返，apiKey 去首尾空格', () => {
    saveSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: ' sk-abc ', model: 'my-model' })
    const loaded = loadSettings()
    expect(loaded.baseUrl).toBe('https://relay.example.com/v1')
    expect(loaded.apiKey).toBe('sk-abc')
    expect(loaded.model).toBe('my-model')
  })

  it('损坏的 JSON 回落默认值而非抛错', () => {
    localStorage.setItem('rhinestone-studio:settings', '{not json')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('结构不符合 schema 回落默认值', () => {
    localStorage.setItem('rhinestone-studio:settings', JSON.stringify({ baseUrl: 123 }))
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('baseUrl 尾斜杠归一', () => {
  it('多尾斜杠归一', () => {
    expect(normalizeBaseUrl('https://x.com/v1///')).toBe('https://x.com/v1')
    expect(normalizeBaseUrl('  https://x.com/v1/ ')).toBe('https://x.com/v1')
  })

  it('joinBaseUrl 拼接端点路径', () => {
    expect(joinBaseUrl('https://x.com/v1/', '/images/generations')).toBe('https://x.com/v1/images/generations')
    expect(joinBaseUrl('https://x.com/v1', '/images/edits')).toBe('https://x.com/v1/images/edits')
    expect(joinBaseUrl('https://x.com/v1', '/models')).toBe('https://x.com/v1/models')
  })
})
