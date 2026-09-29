/**
 * W5 走查 P1-4 超时墙收口回归（env 覆盖生效断言——轻量面）。
 * 原始需求 2026-09-28：dsh 默认 60s 工具超时（实测 GLM 视觉 122.4s）+ daemon 侧
 * 120s LLM/SAM 界双墙。修复=统一 env 可调+缺省放大：
 *   MCP_TOOL_CALL_TIMEOUT_MS 缺省 600_000（boot.ts——dsh-mcp-client 行 toolCallTimeoutMs）；
 *   SCENE_ANALYZE_LLM_TIMEOUT_MS / STRATEGY_DESIGN_LLM_TIMEOUT_MS / SAM_REQUEST_TIMEOUT_MS
 *   缺省 300_000（旧 120s 放大）。FOLLOWUP_TIMEOUT_MS 先例（≥1000ms 有限数才生效）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mcpToolCallTimeoutMs, MCP_TOOL_CALL_TIMEOUT_MS_DEFAULT } from '../src/kernel/boot.js';
import { sceneAnalyzeLlmTimeoutMs } from '../src/kernel/vision/scene-analyze.js';
import { strategyDesignLlmTimeoutMs } from '../src/kernel/strategies/design.js';
import { samRequestTimeoutMs } from '../src/kernel/vision/sam-bridge.js';

const KEYS = [
  'MCP_TOOL_CALL_TIMEOUT_MS',
  'SCENE_ANALYZE_LLM_TIMEOUT_MS',
  'STRATEGY_DESIGN_LLM_TIMEOUT_MS',
  'SAM_REQUEST_TIMEOUT_MS',
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('W5 P1-4：超时 env 化（缺省放大+覆盖生效+越界回缺省）', () => {
  it('四个超时键缺省值（600s 工具墙+300s 调用界）', () => {
    for (const key of KEYS) delete process.env[key];
    expect(MCP_TOOL_CALL_TIMEOUT_MS_DEFAULT).toBe(600_000);
    expect(mcpToolCallTimeoutMs()).toBe(600_000);
    expect(sceneAnalyzeLlmTimeoutMs()).toBe(300_000);
    expect(strategyDesignLlmTimeoutMs()).toBe(300_000);
    expect(samRequestTimeoutMs()).toBe(300_000);
  });

  it('env 覆盖生效（惰性读——import 后置 env 同样生效）；非数字/越界回缺省', () => {
    process.env.MCP_TOOL_CALL_TIMEOUT_MS = '900000';
    expect(mcpToolCallTimeoutMs()).toBe(900_000);
    process.env.SCENE_ANALYZE_LLM_TIMEOUT_MS = '45000';
    expect(sceneAnalyzeLlmTimeoutMs()).toBe(45_000);
    process.env.STRATEGY_DESIGN_LLM_TIMEOUT_MS = '12345';
    expect(strategyDesignLlmTimeoutMs()).toBe(12_345);
    process.env.SAM_REQUEST_TIMEOUT_MS = '250000';
    expect(samRequestTimeoutMs()).toBe(250_000);
    // 非数字/0/<1000：一律回缺省（无零/亚秒超时误配面）。
    process.env.MCP_TOOL_CALL_TIMEOUT_MS = 'not-a-number';
    expect(mcpToolCallTimeoutMs()).toBe(600_000);
    process.env.MCP_TOOL_CALL_TIMEOUT_MS = '0';
    expect(mcpToolCallTimeoutMs()).toBe(600_000);
    process.env.SCENE_ANALYZE_LLM_TIMEOUT_MS = '500';
    expect(sceneAnalyzeLlmTimeoutMs()).toBe(300_000);
  });
});
