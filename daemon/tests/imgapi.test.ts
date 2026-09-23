/**
 * imgapi 客户端测试（W2.2）：OpenAI 兼容 Images API——generations/edits 双面、
 * b64_json/url 双形态、HTTP/auth/network 错误 kind、debug 记录字段对齐 lab
 * ImageTaskDebug 契约（endpoint/requestBody/responseStatus/responseStatusText/
 * responseContentType/responseBodyText/parsedResponse/durationMs）+ 脱敏
 * （apiKey 永不入 debug；敏感键打码；b64 截断 1000）。
 */
import { describe, expect, it } from 'vitest';
import {
  callImagesApi,
  downloadImageData,
  ImageApiError,
  type ImageTaskDebug,
} from '../src/imgapi/client.js';

const SETTINGS = { baseUrl: 'https://img.example.com/v1', apiKey: 'sk-secret-key-1234', model: 'img-model-x' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    headers: { 'content-type': 'application/json' },
  });
}

/** fetch 替身工厂：记录请求 + 按序返回预设响应。 */
function fetchStub(responses: Response[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const stub = ((url: string | URL | globalThis.Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch: stub, calls };
}

describe('imgapi 客户端（lab debug 契约对齐）', () => {
  it('generations：b64_json 形态——endpoint/请求体/响应字段全记录', async () => {
    const png = Buffer.from('fake-png-bytes').toString('base64');
    const { fetch, calls } = fetchStub([
      jsonResponse({ data: [{ b64_json: png }] }),
    ]);
    const result = await callImagesApi(
      SETTINGS,
      { prompt: '一颗红心', size: '1024x1024', advanced: { temperature: 0.7 } },
      fetch,
    );
    expect(Array.from(result.image)).toEqual(Array.from(Buffer.from('fake-png-bytes')));
    expect(calls[0]!.url).toBe('https://img.example.com/v1/images/generations');
    // 请求体：恒 n:1 + advanced 合并；Authorization 携带 Bearer
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body['n']).toBe(1);
    expect(body['temperature']).toBe(0.7);
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${SETTINGS.apiKey}`);
    // debug 契约字段（lab ImageTaskDebug 逐字段）
    const debug: ImageTaskDebug = result.debug;
    expect(debug.endpoint).toBe('https://img.example.com/v1/images/generations');
    expect(debug.requestBody['model']).toBe('img-model-x');
    expect(debug.responseStatus).toBe(200);
    expect(debug.responseStatusText).toBe('OK');
    expect(debug.responseContentType).toBe('application/json');
    expect(typeof debug.durationMs).toBe('number');
    expect((debug.parsedResponse as { data: unknown[] }).data).toHaveLength(1);
    expect(JSON.stringify(debug)).not.toContain('sk-secret-key-1234'); // apiKey 永不入 debug
  });

  it('url 形态：二段取字节（SSRF 加固路径）；b64 截断（>1000 字符打截断标记）', async () => {
    const longB64 = 'A'.repeat(1500);
    const { fetch } = fetchStub([
      jsonResponse({ data: [{ url: 'https://cdn.example.com/x.png' }] }),
      new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
    ]);
    const lookup = async () => ['93.184.216.34']; // 公网地址替身（DNS 注入面）
    const result = await callImagesApi(SETTINGS, { prompt: 'p' }, fetch, undefined, { lookupImpl: lookup });
    expect(Array.from(result.image)).toEqual([9, 8, 7]);
    // b64_json/data 键在 parsedResponse 中截断（lab 同款 1000 截断）——此处构造超长 b64 的变体响应
    const { fetch: fetch2 } = fetchStub([jsonResponse({ data: [{ b64_json: longB64 }] })]);
    const r2 = await callImagesApi(SETTINGS, { prompt: 'p' }, fetch2);
    const parsed = JSON.stringify(r2.debug.parsedResponse);
    expect(parsed).toContain('已截断 500 字符');
    expect(parsed).not.toContain('A'.repeat(1100));
  });

  it('edits（带原图）：multipart endpoint；debug 记录不含 apiKey 与图字节', async () => {
    const { fetch, calls } = fetchStub([jsonResponse({ data: [{ b64_json: Buffer.from('x').toString('base64') }] })]);
    const result = await callImagesApi(
      SETTINGS,
      { prompt: 'p', image: { filename: 'in.png', bytes: new Uint8Array([1, 2]), mime: 'image/png' } },
      fetch,
    );
    expect(calls[0]!.url).toBe('https://img.example.com/v1/images/edits');
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    // debug 面：apiKey 永不入；图字节不入（imageCount/imageNames 描述化——lab 同款）
    const debug = JSON.stringify(result.debug);
    expect(debug).not.toContain('sk-secret-key-1234');
    expect(debug).not.toContain('AAAAAQI');
    expect((result.debug.requestBody as Record<string, unknown>)['imageCount']).toBe(1);
    expect((result.debug.requestBody as Record<string, unknown>)['imageNames']).toEqual([
      'in.png (image/png, 2B)',
    ]);
  });

  it('HTTP 401：kind=auth + debug 携带响应面字段', async () => {
    const { fetch } = fetchStub([
      jsonResponse({ error: { message: 'invalid api key' } }, 401),
    ]);
    const error = await callImagesApi(SETTINGS, { prompt: 'p' }, fetch).catch((e: unknown) => e as ImageApiError);
    expect(error).toBeInstanceOf(ImageApiError);
    expect((error as ImageApiError).kind).toBe('auth');
    expect((error as ImageApiError).status).toBe(401);
    expect((error as ImageApiError).message).toContain('invalid api key');
    expect((error as ImageApiError).debug.responseStatus).toBe(401);
  });

  it('网络异常：kind=network；空配置显式拒绝（invalid-request 语义前置校验）', async () => {
    const boom = (() => {
      throw new TypeError('fetch failed');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as unknown as typeof fetch;
    const error = await callImagesApi(SETTINGS, { prompt: 'p' }, boom).catch((e: unknown) => e as ImageApiError);
    expect((error as ImageApiError).kind).toBe('network');

    await expect(
      callImagesApi({ baseUrl: '', apiKey: '', model: '' }, { prompt: 'p' }, boom),
    ).rejects.toThrow('请先配置图像 API 的Base URL');
  });

  it('响应无 data[0]：kind=invalid-response', async () => {
    const { fetch } = fetchStub([jsonResponse({ data: [] })]);
    const error = await callImagesApi(SETTINGS, { prompt: 'p' }, fetch).catch((e: unknown) => e as ImageApiError);
    expect((error as ImageApiError).kind).toBe('invalid-response');
  });

  it('P1-5 嵌套 authorization/api_key 回显：debug（含 responseBodyText/parsedResponse）无密钥明文', async () => {
    // 上游错误响应把请求头/键回显进 JSON 正文（嵌套任意深度）
    const echo = {
      error: { message: 'invalid key', authorization: `Bearer ${SETTINGS.apiKey}` },
      data: [],
      debugEcho: { nested: { api_key: SETTINGS.apiKey, session_token: `tok-${SETTINGS.apiKey}` } },
    };
    const { fetch } = fetchStub([jsonResponse(echo, 401)]);
    const error = (await callImagesApi(SETTINGS, { prompt: 'p' }, fetch).catch((e: unknown) => e)) as ImageApiError;
    expect(error).toBeInstanceOf(ImageApiError);
    const debugJson = JSON.stringify(error.debug);
    expect(debugJson).not.toContain(SETTINGS.apiKey); // 明文密钥零出现
    expect(debugJson).not.toContain('Bearer sk-secret'); // 前缀形态也不出现
    // 敏感键值 → 尾 4 位打码（可核对不可还原）
    const echoObj = error.debug.parsedResponse as { debugEcho: { nested: Record<string, unknown> } };
    expect(echoObj.debugEcho.nested['api_key']).toBe('…1234');
    expect(error.debug.responseBodyText).not.toContain(SETTINGS.apiKey);
  });

  it('P1-5 非 JSON 纯文本回显（上游原样回显 Bearer 头）：摘要无敏感模式', async () => {
    const plainEcho = `Bad Gateway: upstream saw Authorization: Bearer ${SETTINGS.apiKey} and rejected it`;
    const { fetch } = fetchStub([
      new Response(plainEcho, { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/plain' } }),
    ]);
    const error = (await callImagesApi(SETTINGS, { prompt: 'p' }, fetch).catch((e: unknown) => e)) as ImageApiError;
    expect(error).toBeInstanceOf(ImageApiError);
    expect(error.kind).toBe('http');
    const debugJson = JSON.stringify(error.debug);
    expect(debugJson).not.toContain(SETTINGS.apiKey);
    expect(debugJson).not.toContain('Bearer sk-secret');
    // 摘要保留（可排查性）——但为打码形态
    expect(typeof error.debug.responseBodyText).toBe('string');
    expect(error.debug.responseBodyText!.length).toBeGreaterThan(0);
    expect(error.debug.responseBodyText).toContain('Bad Gateway');
  });
});

describe('P2-1 二段取图 SSRF 加固（downloadImageData）', () => {
  const okFetcher = (body: Uint8Array = new Uint8Array([1, 2, 3])) =>
    (() => Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

  it('仅 https：http/data 协议 URL 必拒', async () => {
    for (const url of ['http://cdn.example.com/x.png', 'data:image/png;base64,AAAA', 'ftp://x/y.png']) {
      await expect(downloadImageData(url, { fetchImpl: okFetcher(), lookupImpl: async () => ['93.184.216.34'] })).rejects.toThrow(
        /仅允许 https|URL 非法/,
      );
    }
  });

  it('私网/环回/link-local/保留/ULA 地址必拒（IP 字面量与 DNS 解析双路径）', async () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.9',
      '169.254.169.254',
      '0.0.0.0',
      '192.0.2.1',
      '203.0.113.9',
      '224.0.0.1',
      '[::1]',
      '[fe80::1]',
      '[fd00::5]',
      '[::ffff:127.0.0.1]',
    ]) {
      await expect(
        downloadImageData(`https://${host}/x.png`, { fetchImpl: okFetcher(), lookupImpl: async () => [host] }),
      ).rejects.toThrow(/非公网/);
    }
    // DNS 解析路径：域名解析到私网地址也拒
    await expect(
      downloadImageData('https://internal.corp/x.png', {
        fetchImpl: okFetcher(),
        lookupImpl: async () => ['10.1.2.3'],
      }),
    ).rejects.toThrow(/非公网/);
    // 公网地址放行
    await expect(
      downloadImageData('https://cdn.example.com/x.png', {
        fetchImpl: okFetcher(),
        lookupImpl: async () => ['93.184.216.34'],
      }),
    ).resolves.toBeTruthy();
  });

  it('跨域重定向必拒；同源重定向逐跳复验后放行', async () => {
    // 跨域：下载腿 302 → other.example.com
    const redirectCross: typeof fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://other.example.com/y.png' } }),
      )) as unknown as typeof fetch;
    await expect(
      downloadImageData('https://cdn.example.com/x.png', {
        fetchImpl: redirectCross,
        lookupImpl: async () => ['93.184.216.34'],
      }),
    ).rejects.toThrow(/跨域重定向/);

    // 同源：两跳后 200（fetch 依次返回 302 → 200）
    const responses = [
      new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/y.png' } }),
      new Response(new Uint8Array([5, 6]), { status: 200 }),
    ];
    let index = 0;
    const sameOrigin: typeof fetch = (() =>
      Promise.resolve(responses[Math.min(index++, responses.length - 1)]!)) as unknown as typeof fetch;
    const bytes = await downloadImageData('https://cdn.example.com/x.png', {
      fetchImpl: sameOrigin,
      lookupImpl: async () => ['93.184.216.34'],
    });
    expect(Array.from(bytes)).toEqual([5, 6]);
  });

  it('流式大小上限：超限即拒（无 content-length 也封顶）', async () => {
    const big = new Uint8Array(100).fill(7);
    await expect(
      downloadImageData('https://cdn.example.com/x.png', {
        fetchImpl: okFetcher(big),
        lookupImpl: async () => ['93.184.216.34'],
        maxBytes: 10,
      }),
    ).rejects.toThrow(/大小上限/);
  });

  it('AbortSignal 透传：二段 fetch 收到 signal（取消即中止）', async () => {
    const controller = new AbortController();
    let sawSignal = false;
    const recorder: typeof fetch = ((_url: unknown, init?: RequestInit) => {
      sawSignal = init?.signal !== undefined;
      return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
    }) as unknown as typeof fetch;
    await downloadImageData('https://cdn.example.com/x.png', {
      fetchImpl: recorder,
      signal: controller.signal,
      lookupImpl: async () => ['93.184.216.34'],
    });
    expect(sawSignal).toBe(true);
  });

  it('callImagesApi 全链：url 形态走加固下载（私网解析 → invalid-response）', async () => {
    const { fetch } = fetchStub([jsonResponse({ data: [{ url: 'https://internal.corp/x.png' }] })]);
    const error = (await callImagesApi(
      SETTINGS,
      { prompt: 'p' },
      fetch,
      undefined,
      { lookupImpl: async () => ['192.168.0.10'] },
    ).catch((e: unknown) => e)) as ImageApiError;
    expect(error).toBeInstanceOf(ImageApiError);
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toContain('非公网');
  });
});
