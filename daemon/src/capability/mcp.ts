/**
 * capability → MCP 工具投影（照 shufa-server capability/mcp.ts 移植——其上游=
 * skill-creator-v2 mcp/skill-creator-mcp.ts 最小面；W4.1 贴钻适配）。
 * 原始需求 2026-09-23：内核 dsh-mcp-client 行经 streamable-http 连 daemon 独立
 * loopback MCP listener；capability 名投影为 MCP 工具名（名字字符集限制）。
 * 正交意图：
 *   [1] registry → McpServer：能力全注册（W4.1 面=readonly；proposal 面 W4.2），
 *       schema-faithful（Zod raw shape 直传）。
 *   [2] 闭合结果 → MCP content 投影（denied/failed = isError）。
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CapabilityRegistry } from './core.js';

/**
 * MCP 工具名：dsh-mcp-client 以 `mcp__<server>__<tool>` 投影；server 名=studio
 * 与能力命名空间重复时去重——`studio.projects` → `projects`（全名
 * mcp__studio__projects）；其余命名空间维持 `.` → `_`。
 */
export function mcpToolName(capabilityName: string): string {
  const dot = capabilityName.indexOf('.');
  if (dot > 0 && capabilityName.slice(0, dot) === 'studio') {
    return capabilityName.slice(dot + 1).replace(/\./g, '_');
  }
  return capabilityName.replace(/\./g, '_');
}

/** capability 调用主体：MCP 面的调用者是模型。 */
const MCP_PRINCIPAL = 'agent' as const;

function toToolResult(result: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const serialized = safeJson(result);
  const isError =
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    (result as { kind: string }).kind !== 'ok';
  return { content: [{ type: 'text', text: serialized }], ...(isError ? { isError: true } : {}) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 构造 studio MCP server（loopback listener 每请求新建；stateless）。 */
export function createStudioMcpServer(deps: { capabilities: CapabilityRegistry }): McpServer {
  const server = new McpServer({ name: 'studio', version: '0.1.0' }, { capabilities: { tools: {} } });
  for (const descriptor of deps.capabilities.describe()) {
    const definition = deps.capabilities.definitionOf(descriptor.name);
    const shape =
      definition && typeof (definition.input as { shape?: object }).shape === 'object'
        ? (definition.input as z.ZodObject).shape
        : null;
    const toolName = mcpToolName(descriptor.name);
    if (shape) {
      server.registerTool(
        toolName,
        { description: descriptor.description, inputSchema: z.object(shape) },
        async (args) => toToolResult(await deps.capabilities.call(descriptor.name, args, MCP_PRINCIPAL)),
      );
    } else {
      server.registerTool(toolName, { description: descriptor.description }, async () =>
        toToolResult(await deps.capabilities.call(descriptor.name, undefined, MCP_PRINCIPAL)),
      );
    }
  }
  return server;
}
