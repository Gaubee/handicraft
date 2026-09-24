/**
 * LLM 真实网关冒烟（显式 opt-in——绝不进任何测试门）。
 * 用法：LLM_API_KEY=<key> pnpm -C daemon exec tsx scripts/llm-smoke.ts
 *   可选：LLM_BASE_URL（缺省 z.ai /api/paas/v4）、LLM_MODEL（缺省 glm-5.3-flash）。
 * 无 key 直接拒绝退出（零外呼）；协议固定 openai-completions（Owner 2026-09-23
 * 裁决——书法 shufa-server 实证 Z.ai 只讲 OpenAI 协议）。
 * 验证面：一次 chat/completions 流式往返（SSE 增量 + finish + [DONE]）。
 */
import { loadConfig } from '../src/config.js';
import { resolveSingleRoute } from '../src/kernel/model-route.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const route = resolveSingleRoute(config.llm);
  if (!route) {
    console.error('[llm-smoke] LLM_API_KEY 未配置——拒绝外呼（opt-in 冒烟：设 LLM_API_KEY 后重跑）');
    process.exit(1);
  }
  console.log(`[llm-smoke] 网关=${route.baseURL} 模型=${route.model} 协议=${route.api}`);
  const response = await fetch(`${route.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
    body: JSON.stringify({
      model: route.model,
      stream: true,
      messages: [{ role: 'user', content: '回复两个字：收到' }],
    }),
  });
  console.log(`[llm-smoke] HTTP ${response.status}`);
  if (!response.ok || response.body === null) {
    console.error(`[llm-smoke] 失败：${(await response.text().catch(() => '')).slice(0, 300)}`);
    process.exit(1);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finish: string | null = null;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break outer;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta !== '') {
          text += delta;
          process.stdout.write(delta);
        }
        const reason = parsed.choices?.[0]?.finish_reason;
        if (reason) finish = reason;
      } catch {
        // 保活行跳过
      }
    }
  }
  console.log(`\n[llm-smoke] 完成：finish=${finish ?? '(未见)'}，累计 ${text.length} 字`);
}

void main().catch((error: unknown) => {
  console.error('[llm-smoke] 异常：', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
