/**
 * imgapi 客户端测试（W2.2）：OpenAI 兼容 Images API——generations/edits 双面、
 * b64_json/url 双形态、HTTP/auth/network 错误 kind、debug 记录字段对齐 lab
 * ImageTaskDebug 契约（endpoint/requestBody/responseStatus/responseStatusText/
 * responseContentType/responseBodyText/parsedResponse/durationMs）+ 脱敏
 * （apiKey 永不入 debug；敏感键打码；b64 截断 1000）。
 */
import { describe, expect, it } from 'vitest';
import { callImagesApi, ImageApiError, type ImageTaskDebug } from '../src/imgapi/client.js';

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

  it('url 形态：二段取字节；b64 截断（>1000 字符打截断标记）', async () => {
    const longB64 = 'A'.repeat(1500);
    const { fetch } = fetchStub([
      jsonResponse({ data: [{ url: 'https://cdn.example.com/x.png' }] }),
      new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
    ]);
    const result = await callImagesApi(SETTINGS, { prompt: 'p' }, fetch);
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
});
