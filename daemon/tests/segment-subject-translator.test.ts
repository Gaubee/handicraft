/**
 * 主体名英译器单测（SAM 英文优先提示——Owner 定调 2026-10-03；纯本地 mock 网关，
 * 零真实外呼）。形态沿 scene-analyze.test.ts 先例：LLM 网关=本地 openai-completions
 * mock（127.0.0.1 loopback、stream:false JSON 体）；resolveLlmRoute 真链消费
 * （settings 空→.env 迁移语义的 resolveSingleRoute——config.llm 直注 mock 网关地址）。
 * 覆盖：正常英译+线面（temperature 0/max_tokens/指令含字面保留规则与主体名）/
 * 实例级 Map 缓存（同名一呼/trim 归一/失败不缓存）/引号字面守卫（丢字面=非法
 * 译文）/路由未配置/HTTP 坏/非 JSON/超时/sanitize 与 quotedLiteralsOf 纯函数组。
 * 零常驻纪律：每用例 finally 显式 stop mock 网关+dispose 服务。
 */
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createSubjectTranslator,
  quotedLiteralsOf,
  SUBJECT_TRANSLATE_MAX_TOKENS,
  SUBJECT_TRANSLATE_OUTPUT_MAX_CHARS,
  sanitizeSubjectTranslation,
  subjectTranslateInstruction,
} from '../src/kernel/vision/subject-translator.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

/** mock 网关（scene-analyze.test.ts 同款线协议替身）：脚本按序弹出；记录请求体。 */
interface MockGateway {
  server: Server;
  port: number;
  requests: string[];
  stop(): Promise<void>;
}

function startMockGateway(
  script: () => { status?: number; body?: string; delayMs?: number; text?: string },
): Promise<MockGateway> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      requests.push(body);
      const step = script();
      const respond = (): void => {
        if (step.text !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.text } }] }));
          return;
        }
        response.writeHead(step.status ?? 500, { 'content-type': 'text/plain' });
        response.end(step.body ?? '');
      };
      if (step.delayMs !== undefined && step.delayMs > 0) setTimeout(respond, step.delayMs);
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        requests,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** 通道装配：mock 网关地址注入 config.llm（scene-analyze.test wireLlm 同款缝）。 */
function wireLlm(s: TestServices, port: number): void {
  s.config.llm.provider = 'zai';
  s.config.llm.baseUrl = `http://127.0.0.1:${port}/v1`;
  s.config.llm.apiKey = 'mock-gateway-key';
  s.config.llm.model = 'glm-5.3-flash';
  s.config.llm.api = '';
  s.config.llm.visionModel = '';
}

// ---------------------------------------------------------------- 纯函数组

describe('subjectTranslateInstruction（翻译指令——LLM 规则面）', () => {
  it('含主体名+英文为主口径+字面保留规则（引号字面原样进译文）+已英文原样返回', () => {
    const instruction = subjectTranslateInstruction('文字“你好”');
    expect(instruction).toContain('主体名：文字“你好”');
    expect(instruction).toContain('SAM 对中文支持不好');
    expect(instruction).toContain('the Chinese text');
    expect(instruction).toContain('原样保留引号内的字面内容');
    expect(instruction).toContain('已是英文，原样返回');
  });
  it('确定性（同输入同输出）', () => {
    expect(subjectTranslateInstruction('路灯')).toBe(subjectTranslateInstruction('路灯'));
  });
});

describe('quotedLiteralsOf（成对引号字面提取——文字内容语义的机器识别面）', () => {
  it('四种成对引号各提取；无引号空列', () => {
    expect(quotedLiteralsOf('文字“你好”')).toEqual(['你好']);
    expect(quotedLiteralsOf('「福」字')).toEqual(['福']);
    expect(quotedLiteralsOf('『囍』双字')).toEqual(['囍']);
    expect(quotedLiteralsOf('the "OK" sign')).toEqual(['OK']);
    expect(quotedLiteralsOf('路灯')).toEqual([]);
    expect(quotedLiteralsOf('文字“你好”与“福”')).toEqual(['你好', '福']);
  });
});

describe('sanitizeSubjectTranslation（译文整形——英文为主纪律）', () => {
  it('多行取首非空行；整句包裹引号剥除', () => {
    expect(sanitizeSubjectTranslation('streetlight lamp')).toBe('streetlight lamp');
    expect(sanitizeSubjectTranslation('\n\n  streetlight lamp  \n第二行')).toBe('streetlight lamp');
    expect(sanitizeSubjectTranslation('"streetlight lamp"')).toBe('streetlight lamp');
    expect(sanitizeSubjectTranslation('“streetlight”')).toBe('streetlight');
  });
  it('纯中文（无 ASCII 字母）/空白/超长=非法（null）——英文为主', () => {
    expect(sanitizeSubjectTranslation('你好')).toBeNull();
    expect(sanitizeSubjectTranslation('   \n  ')).toBeNull();
    expect(sanitizeSubjectTranslation('a'.repeat(SUBJECT_TRANSLATE_OUTPUT_MAX_CHARS + 1))).toBeNull();
    // 引号字面合法在场（含中文字面但有英文主体——通过）
    expect(sanitizeSubjectTranslation('the Chinese text “你好”')).toBe('the Chinese text “你好”');
  });
});

// ---------------------------------------------------------------- 英译器本体（mock 网关）

describe('createSubjectTranslator（实例级缓存+软失败——mock 网关真链 resolveLlmRoute）', () => {
  it('正常：英译返回；线面=openai-completions/temperature 0/max_tokens 常量/指令含主体名', async () => {
    const s = createServices();
    const gw = await startMockGateway(() => ({ text: 'streetlight lamp' }));
    try {
      wireLlm(s, gw.port);
      const translate = createSubjectTranslator({ db: s.db, llm: s.config.llm });
      await expect(translate('路灯')).resolves.toBe('streetlight lamp');
      expect(gw.requests).toHaveLength(1);
      const wire = JSON.parse(gw.requests[0]!) as {
        model: string;
        temperature: number;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
      expect(wire.model).toBe('glm-5.3-flash');
      expect(wire.temperature).toBe(0); // 确定性纪律的请求侧
      expect(wire.max_tokens).toBe(SUBJECT_TRANSLATE_MAX_TOKENS);
      expect(wire.messages[0]!.content).toContain('主体名：路灯');
    } finally {
      await gw.stop();
      s.dispose();
    }
  });

  it('② 缓存：同 objectName（trim 归一）二次调用零额外外呼且译文相同；不同名再呼；失败不缓存（自愈重试）', async () => {
    const s = createServices();
    let attempt = 0;
    const gw = await startMockGateway(() => {
      attempt++;
      return attempt === 1 ? { status: 500, body: 'boom' } : { text: attempt === 2 ? 'right-side hair' : 'streetlight' };
    });
    try {
      wireLlm(s, gw.port);
      const translate = createSubjectTranslator({ db: s.db, llm: s.config.llm });
      await expect(translate('右发')).resolves.toBeNull(); // 首呼失败（不缓存）
      await expect(translate('右发')).resolves.toBe('right-side hair'); // 自愈重试成功
      await expect(translate('  右发  ')).resolves.toBe('right-side hair'); // trim 归一同键——缓存命中
      await expect(translate('路灯')).resolves.toBe('streetlight'); // 不同名再呼
      expect(gw.requests).toHaveLength(3); // 失败 1+成功 1+新路名 1（缓存命中零外呼）
    } finally {
      await gw.stop();
      s.dispose();
    }
  });

  it('引号字面守卫：译文丢字面=null（降级面安全——中文 prompt 本身含原字面）；保字面通过', async () => {
    const s = createServices();
    let attempt = 0;
    const gw = await startMockGateway(() => {
      attempt++;
      return attempt === 1 ? { text: 'hello text' } : { text: 'the Chinese text “你好”' };
    });
    try {
      wireLlm(s, gw.port);
      const translate = createSubjectTranslator({ db: s.db, llm: s.config.llm });
      await expect(translate('文字“你好”')).resolves.toBeNull(); // 丢字面=非法译文
      await expect(translate('文字“你好”')).resolves.toBe('the Chinese text “你好”'); // 保字面通过
    } finally {
      await gw.stop();
      s.dispose();
    }
  });

  it('路由未配置（apiKey 空）：null 且零外呼', async () => {
    const s = createServices();
    const gw = await startMockGateway(() => ({ text: 'never' }));
    try {
      // 不 wireLlm——config.llm.apiKey 空 ⇒ resolveSingleRoute null ⇒ 软失败
      const translate = createSubjectTranslator({ db: s.db, llm: s.config.llm });
      await expect(translate('路灯')).resolves.toBeNull();
      expect(gw.requests).toHaveLength(0);
    } finally {
      await gw.stop();
      s.dispose();
    }
  });

  it('HTTP 坏/响应非 JSON/content 空：一律 null（软失败不抛）', async () => {
    const s = createServices();
    let attempt = 0;
    const gw = await startMockGateway(() => {
      attempt++;
      if (attempt === 1) return { status: 502, body: 'bad gateway' };
      if (attempt === 2) return { body: 'not-json' };
      return { text: '' };
    });
    try {
      wireLlm(s, gw.port);
      const translate = createSubjectTranslator({ db: s.db, llm: s.config.llm });
      await expect(translate('路灯')).resolves.toBeNull(); // HTTP 502
      await expect(translate('路灯')).resolves.toBeNull(); // 非 JSON 体
      await expect(translate('路灯')).resolves.toBeNull(); // 空 content→sanitize null
    } finally {
      await gw.stop();
      s.dispose();
    }
  });

  it('超时：timeoutMs 注入 50ms+网关延迟 300ms → null（AbortSignal.timeout 收口）', async () => {
    const s = createServices();
    const gw = await startMockGateway(() => ({ text: 'late streetlight', delayMs: 300 }));
    try {
      wireLlm(s, gw.port);
      const translate = createSubjectTranslator({ db: s.db, llm: s.config.llm, timeoutMs: 50 });
      await expect(translate('路灯')).resolves.toBeNull();
    } finally {
      await gw.stop();
      s.dispose();
    }
  });

  it('空白主体名：null 零外呼', async () => {
    const s = createServices();
    const gw = await startMockGateway(() => ({ text: 'never' }));
    try {
      wireLlm(s, gw.port);
      const translate = createSubjectTranslator({ db: s.db, llm: s.config.llm });
      await expect(translate('   ')).resolves.toBeNull();
      expect(gw.requests).toHaveLength(0);
    } finally {
      await gw.stop();
      s.dispose();
    }
  });
});
