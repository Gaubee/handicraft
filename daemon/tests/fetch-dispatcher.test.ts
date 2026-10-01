/**
 * [真链复验 P1-A，2026-10-01] 外呼 fetch 全局 dispatcher 测试。
 * 覆盖：
 *   [1] 常量一致性：LLM_FETCH_TIMEOUT_MS 缺省=MCP 工具界缺省（1200s 单源）。
 *   [2] env 生效面：合法覆盖采用；非法/越界回缺省（envTimeoutMs 严格解析）。
 *   [3] 同步调钳制：有效界恒 ≥ MCP 工具界（传输层永不低于工具层的不变式）。
 *   [4] 行为验证：装配后内建 fetch 走全局 dispatcher——headers 界被压到 env 值
 *       （本地延迟服务器实证 UND_ERR_HEADERS_TIMEOUT），缓发请求正常通过。
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_FETCH_DISPATCHER_SYMBOL,
  LLM_FETCH_TIMEOUT_MS_DEFAULT,
  currentGlobalFetchDispatcher,
  installGlobalFetchDispatcher,
  llmFetchTimeoutMs,
} from '../src/fetch-dispatcher.js';
import { MCP_TOOL_CALL_TIMEOUT_MS_DEFAULT } from '../src/kernel/boot.js';

const ENV_KEYS = ['LLM_FETCH_TIMEOUT_MS', 'MCP_TOOL_CALL_TIMEOUT_MS'] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

/** 装配前全局 dispatcher 快照（测试后还原——vitest worker 内进程级状态）。 */
function saveDispatcher(): unknown {
  return currentGlobalFetchDispatcher();
}

function restoreDispatcher(previous: unknown): void {
  (globalThis as { [key: symbol]: unknown })[GLOBAL_FETCH_DISPATCHER_SYMBOL] = previous;
}

const savedEnv = saveEnv();
const savedDispatcher = saveDispatcher();

afterEach(() => {
  restoreEnv(savedEnv);
  restoreDispatcher(savedDispatcher);
});

describe('fetch dispatcher 常量与 env 生效面（P1-A）', () => {
  it('缺省与 MCP 工具界缺省同源（1200s 单一常量源）', () => {
    expect(LLM_FETCH_TIMEOUT_MS_DEFAULT).toBe(MCP_TOOL_CALL_TIMEOUT_MS_DEFAULT);
    expect(LLM_FETCH_TIMEOUT_MS_DEFAULT).toBe(1_200_000);
    expect(llmFetchTimeoutMs()).toBe(1_200_000);
  });

  it('env 合法覆盖采用（缺省跟随工具界，仅可抬高到工具界之上）；非数字/越界回缺省', () => {
    // 低于 MCP 工具界缺省的值被钳制上抬（同步调不变式——传输层永不低于工具层）。
    process.env.LLM_FETCH_TIMEOUT_MS = '5000';
    expect(llmFetchTimeoutMs()).toBe(1_200_000);
    // 高于工具界的覆盖采用。
    process.env.LLM_FETCH_TIMEOUT_MS = '2400000';
    expect(llmFetchTimeoutMs()).toBe(2_400_000);
    process.env.LLM_FETCH_TIMEOUT_MS = 'not-a-number';
    expect(llmFetchTimeoutMs()).toBe(1_200_000);
    process.env.LLM_FETCH_TIMEOUT_MS = '0';
    expect(llmFetchTimeoutMs()).toBe(1_200_000);
    process.env.LLM_FETCH_TIMEOUT_MS = '-5000';
    expect(llmFetchTimeoutMs()).toBe(1_200_000);
    delete process.env.LLM_FETCH_TIMEOUT_MS;
    expect(llmFetchTimeoutMs()).toBe(1_200_000);
  });

  it('同步调钳制：有效界恒不低于 MCP 工具界', () => {
    // MCP 调高、fetch 未设 → 跟随工具界。
    process.env.MCP_TOOL_CALL_TIMEOUT_MS = '2400000';
    delete process.env.LLM_FETCH_TIMEOUT_MS;
    expect(llmFetchTimeoutMs()).toBe(2_400_000);
    // 两者同设且 fetch 低于工具界 → 钳制到工具界。
    process.env.LLM_FETCH_TIMEOUT_MS = '1500000';
    expect(llmFetchTimeoutMs()).toBe(2_400_000);
    // fetch 高于工具界 → 采用 fetch 值。
    process.env.LLM_FETCH_TIMEOUT_MS = '3600000';
    expect(llmFetchTimeoutMs()).toBe(3_600_000);
    // MCP 调低（测试场景）：fetch 未设 → 跟随（行为验证的 env 通道）。
    delete process.env.LLM_FETCH_TIMEOUT_MS;
    process.env.MCP_TOOL_CALL_TIMEOUT_MS = '1000';
    expect(llmFetchTimeoutMs()).toBe(1000);
  });

  it('装配：全局 dispatcher 挂注册符号，返回生效配置；重装替换旧实例', () => {
    process.env.LLM_FETCH_TIMEOUT_MS = '2400000';
    const first = installGlobalFetchDispatcher();
    expect(first.timeoutMs).toBe(2_400_000);
    const agent = currentGlobalFetchDispatcher();
    expect(agent).toBeDefined();
    process.env.LLM_FETCH_TIMEOUT_MS = '3600000';
    const second = installGlobalFetchDispatcher();
    expect(second.timeoutMs).toBe(3_600_000);
    expect(currentGlobalFetchDispatcher()).toBeDefined();
    expect(currentGlobalFetchDispatcher()).not.toBe(agent);
  });
});

describe('fetch dispatcher 行为验证（P1-A——本地延迟服务器实证）', () => {
  it('headers 界生效：延迟超界的请求被传输界截杀；界内正常通过', async () => {
    // env 下限 1000ms（envTimeoutMs）——经 MCP 工具界通道压到 1000ms（fetch env
    // 低于工具界会被钳制，故用 MCP_TOOL_CALL_TIMEOUT_MS=1000 抬降整体界）。
    delete process.env.LLM_FETCH_TIMEOUT_MS;
    process.env.MCP_TOOL_CALL_TIMEOUT_MS = '1000';
    const { timeoutMs } = installGlobalFetchDispatcher();
    expect(timeoutMs).toBe(1000);

    let handler: ((res: http.ServerResponse) => void) | null = null;
    const server = http.createServer((request, response) => {
      if (handler === null) return;
      handler(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // 延迟 headers 2500ms > 1000ms 界 → 截杀（cause code 为 undici 传输界错误）。
      handler = (response) => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('late');
        }, 2500);
      };
      const t0 = Date.now();
      await expect(fetch(`http://127.0.0.1:${port}/slow`)).rejects.toThrow();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2400); // 传输界截杀，非服务器响应驱动
      // 界内请求（headers 100ms）正常通过——非全局性禁用。
      handler = (response) => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('fast');
        }, 100);
      };
      const response = await fetch(`http://127.0.0.1:${port}/fast`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('fast');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
