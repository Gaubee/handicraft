import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  editImage,
  generateImage,
  ImageApiError,
  maskAdvancedJsonForPersist,
  parseAdvancedJson,
  testConnection,
} from '$lib/api/client'
import type { LabSettings } from '$lib/api/settings'

const settings: LabSettings = {
  baseUrl: 'https://relay.example.com/v1/',
  apiKey: 'sk-test-key',
  model: 'gpt-image-2.5',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function lastCall(): { url: string; init: RequestInit } {
  const mock = vi.mocked(fetch)
  const calls = mock.mock.calls
  const [url, init] = calls[calls.length - 1] as [string, RequestInit]
  return { url, init: init ?? {} }
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('parseAdvancedJson', () => {
  it('空串合法（无附加参数）', () => {
    expect(parseAdvancedJson('')).toEqual({ ok: true, value: {} })
    expect(parseAdvancedJson('   ')).toEqual({ ok: true, value: {} })
  })

  it('合法对象解析', () => {
    expect(parseAdvancedJson('{"background":"transparent","seed":42}')).toEqual({
      ok: true,
      value: { background: 'transparent', seed: 42 },
    })
  })

  it('非法 JSON / 非对象前端拦截', () => {
    expect(parseAdvancedJson('{bad').ok).toBe(false)
    expect(parseAdvancedJson('[1,2]').ok).toBe(false)
    expect(parseAdvancedJson('null').ok).toBe(false)
    expect(parseAdvancedJson('"str"').ok).toBe(false)
  })
})

describe('generateImage', () => {
  it('POST {base}/images/generations，尾斜杠归一，Bearer 头，body n 恒 1', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ url: 'https://cdn.example.com/x.png' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage({ settings, prompt: 'a flat template', size: '1024x1024' })

    const { url, init } = lastCall()
    expect(url).toBe('https://relay.example.com/v1/images/generations')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.n).toBe(1)
    expect(body.model).toBe('gpt-image-2.5')
    expect(body.size).toBe('1024x1024')
    expect(result.imageUrl).toBe('https://cdn.example.com/x.png')
  })

  it('b64_json 响应转 data URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QUJDRA==' }] })),
    )
    const result = await generateImage({ settings, prompt: 'p' })
    expect(result.imageUrl).toBe('data:image/png;base64,QUJDRA==')
    expect(result.b64Json).toBe('QUJDRA==')
  })

  it('url 与 b64_json 同时存在时优先 b64（少一次跨域取图）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ url: 'https://cdn/x.png', b64_json: 'QUE=' }] })),
    )
    const result = await generateImage({ settings, prompt: 'p' })
    expect(result.imageUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('Advanced JSON 合并进请求体透传', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateImage({
      settings,
      prompt: 'p',
      advanced: { background: 'transparent', output_format: 'png', quality: 'high' },
    })

    const body = JSON.parse(lastCall().init.body as string) as Record<string, unknown>
    expect(body.background).toBe('transparent')
    expect(body.output_format).toBe('png')
    expect(body.quality).toBe('high')
  })

  it('Advanced JSON 里的 n 覆写被压制：请求体 n 恒 1', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] })))
    await generateImage({ settings, prompt: 'p', advanced: { n: 4 } })
    const body = JSON.parse(lastCall().init.body as string) as Record<string, unknown>
    expect(body.n).toBe(1)
  })

  it('size 为空时不发送 size 字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] })))
    await generateImage({ settings, prompt: 'p', size: '' })
    const body = JSON.parse(lastCall().init.body as string) as Record<string, unknown>
    expect('size' in body).toBe(false)
  })

  it('HTTP 401 归类鉴权错误，upstream message 原样展示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401)),
    )
    const error = await generateImage({ settings, prompt: 'p' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImageApiError)
    const apiError = error as ImageApiError
    expect(apiError.kind).toBe('auth')
    expect(apiError.status).toBe(401)
    expect(apiError.message).toContain('鉴权失败')
    expect(apiError.message).toContain('Incorrect API key provided')
  })

  it('HTTP 500 归类 http 错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'server boom' } }, 500)))
    const error = (await generateImage({ settings, prompt: 'p' }).catch((e: unknown) => e)) as ImageApiError
    expect(error.kind).toBe('http')
    expect(error.message).toContain('server boom')
  })

  it('网络失败归类 network 并提示 CORS 排查路径', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const error = (await generateImage({ settings, prompt: 'p' }).catch((e: unknown) => e)) as ImageApiError
    expect(error.kind).toBe('network')
    expect(error.message).toContain('Failed to fetch')
    expect(error.message).toContain('CORS')
  })

  it('响应结构不符合 Images API 归类 invalid-response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ foo: 'bar' })))
    const error = (await generateImage({ settings, prompt: 'p' }).catch((e: unknown) => e)) as ImageApiError
    expect(error.kind).toBe('invalid-response')
  })

  it('data[0] 既无 url 也无 b64_json 报 invalid-response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{}] })))
    const error = (await generateImage({ settings, prompt: 'p' }).catch((e: unknown) => e)) as ImageApiError
    expect(error.kind).toBe('invalid-response')
  })

  it('debug：b64 截断 1000 字符，apiKey 永不入 debug', async () => {
    const longB64 = 'A'.repeat(1500)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ b64_json: longB64 }] })))
    const result = await generateImage({ settings, prompt: 'p' })
    const debugJson = JSON.stringify(result.debug)
    expect(debugJson).not.toContain('sk-test-key')
    expect(result.debug.responseBodyText?.length ?? 0).toBeLessThan(1200)
    expect(result.debug.responseBodyText).toContain('已截断')
    const parsed = result.debug.parsedResponse as { data: { b64_json: string }[] }
    // 截断 = 1000 字符 + 「… [已截断 N 字符]」后缀
    expect(parsed.data[0].b64_json.length).toBeLessThanOrEqual(1020)
    expect(parsed.data[0].b64_json).toContain('已截断')
  })

  it('debug：敏感键名（key/token/authorization/api_key 子串、大小写不敏感）值打码 ***（含嵌套对象）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] })))
    const result = await generateImage({
      settings,
      prompt: 'p',
      advanced: {
        apiKey: 'sk-advanced-leak',
        Token: 'tok-leak',
        authorization: 'Bearer leak',
        my_api_key: 'snake-leak',
        nested: { user_token: 'deep-leak', keep: 'transparent' },
        background: 'transparent',
      },
    })
    const body = result.debug.requestBody
    expect(body.apiKey).toBe('***')
    expect(body.Token).toBe('***')
    expect(body.authorization).toBe('***')
    expect(body.my_api_key).toBe('***')
    expect((body.nested as Record<string, unknown>).user_token).toBe('***')
    // 非敏感键照常透传展示
    expect((body.nested as Record<string, unknown>).keep).toBe('transparent')
    expect(body.background).toBe('transparent')
    // 整棵 debug 树不泄漏任何一个明文值
    expect(JSON.stringify(result.debug)).not.toContain('leak')
  })

  it('debug：错误响应的解析树中敏感键打码（raw responseBodyText 为上游原文，仅截断）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { message: 'bad key', api_key: 'sk-error-leak' } }, 401),
      ),
    )
    const error = (await generateImage({ settings, prompt: 'p' }).catch((e: unknown) => e)) as ImageApiError
    expect(error.kind).toBe('auth')
    // 结构化字段（parsedResponse）按键名打码
    const parsed = error.debug.parsedResponse as { error: { api_key: string } }
    expect(parsed.error.api_key).toBe('***')
  })

  it('maskAdvancedJsonForPersist：Advanced JSON 文本持久化前打码敏感键（N3）', async () => {
    expect(maskAdvancedJsonForPersist('')).toBe('')
    expect(maskAdvancedJsonForPersist('{"apiKey":"sk-x","background":"transparent"}')).toBe(
      '{"apiKey":"***","background":"transparent"}',
    )
    expect(maskAdvancedJsonForPersist('{"nested":{"user_token":"t"},"Authorization":"a"}')).toBe(
      '{"nested":{"user_token":"***"},"Authorization":"***"}',
    )
    // 非法 JSON 兜底原样返回（运行时 parseAdvancedJson 已拦截）
    expect(maskAdvancedJsonForPersist('{bad')).toBe('{bad')
  })

  it('AbortError 原样传播（供状态机落 cancelled）', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = generateImage({ settings, prompt: 'p', signal: controller.signal })
    controller.abort()
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('AbortError')
  })
})

describe('editImage', () => {
  const imageFile = new File([new Uint8Array([1, 2, 3])], 'ref.png', { type: 'image/png' })

  it('POST {base}/images/edits multipart，绝不手动设 Content-Type', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await editImage({ settings, prompt: 'make it flat', image: imageFile, size: '1024x1024' })

    const { url, init } = lastCall()
    expect(url).toBe('https://relay.example.com/v1/images/edits')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test-key')
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')).toBe(false)
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('model')).toBe('gpt-image-2.5')
    expect(form.get('prompt')).toBe('make it flat')
    expect(form.get('n')).toBe('1')
    expect(form.get('size')).toBe('1024x1024')
    const imagePart = form.get('image')
    expect(imagePart).toBeInstanceOf(File)
    expect((imagePart as File).name).toBe('ref.png')
  })

  it('原图以重复 image 字段名追加（单图即一个 image part）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] })))
    await editImage({ settings, prompt: 'p', image: imageFile })
    const form = lastCall().init.body as FormData
    expect(form.getAll('image')).toHaveLength(1)
  })

  it('Advanced JSON 合并进 FormData（标量直传、对象 JSON 化）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] })))
    await editImage({
      settings,
      prompt: 'p',
      image: imageFile,
      advanced: { background: 'transparent', output_format: 'png', n: 9, nested: { a: 1 } },
    })
    const form = lastCall().init.body as FormData
    expect(form.get('background')).toBe('transparent')
    expect(form.get('output_format')).toBe('png')
    // n 恒 1：advanced 的 n 之后被覆写为 '1'
    expect(form.getAll('n')).toEqual(['1'])
    expect(form.get('nested')).toBe('{"a":1}')
  })

  it('size 省略时 FormData 无 size 字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ b64_json: 'QQ==' }] })))
    await editImage({ settings, prompt: 'p', image: imageFile, size: '' })
    const form = lastCall().init.body as FormData
    expect(form.get('size')).toBeNull()
  })
})

describe('testConnection', () => {
  it('GET {base}/models 成功并统计模型数', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 'gpt-image-2.5' }, { id: 'gpt-4o' }] })),
    )
    const result = await testConnection(settings)
    const { url, init } = lastCall()
    expect(url).toBe('https://relay.example.com/v1/models')
    expect(init.method).toBe('GET')
    expect(result.ok).toBe(true)
    expect(result.modelCount).toBe(2)
    expect(result.message).toContain('2')
  })

  it('401 区分为鉴权错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401)))
    const result = await testConnection(settings)
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('auth')
    expect(result.message).toContain('bad key')
  })

  it('网络失败区分 network（CORS 提示）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const result = await testConnection(settings)
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('network')
    expect(result.message).toContain('CORS')
  })

  it('Base URL 为空直接前端拦截', async () => {
    const result = await testConnection({ ...settings, baseUrl: ' ' })
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('invalid-request')
  })
})
